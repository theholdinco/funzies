import { query } from "../../db";
import type { CloDocument } from "../types";
import { normalizeClassName } from "../api";
import { validateCapStructure, validateSectionExtraction, buildRepairQueries } from "./validator";
import { mapDocument } from "./document-mapper";
import { extractAllSectionTexts, extractSectionText, type SectionText } from "./text-extractor";
import { extractAllSections, extractSection } from "./section-extractor";
import { normalizeSectionResults } from "./normalizer";
// Common field name aliases the model returns → correct DB column names
const POOL_SUMMARY_ALIASES: Record<string, string> = {
  aggregate_principal_balance: "total_principal_balance",
  adjusted_collateral_principal_amount: "total_par",
  collateral_principal_amount: "total_par",
  total_collateral_balance: "total_par",
  weighted_average_spread: "wac_spread",
  weighted_average_coupon: "wac_total",
  weighted_average_life: "wal_years",
  weighted_average_rating_factor: "warf",
  wa_spread: "wac_spread",
  wa_coupon: "wac_total",
  num_obligors: "number_of_obligors",
  num_assets: "number_of_assets",
  num_industries: "number_of_industries",
  num_countries: "number_of_countries",
};

const SNAPSHOT_ALIASES: Record<string, string> = {
  current_rate: "coupon_rate",
  all_in_rate: "coupon_rate",
  spread: "coupon_rate",
  balance: "current_balance",
  outstanding_balance: "current_balance",
  principal_balance: "current_balance",
  deferred_interest: "deferred_interest_balance",
  shortfall: "interest_shortfall",
  cumulative_interest_shortfall: "cumulative_shortfall",
  principal_amount: "current_balance",
};

function remapColumnAliases(
  row: Record<string, unknown>,
  aliases: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const mapped = aliases[k] ?? k;
    // Don't overwrite if we already have a value for the target column
    if (mapped !== k && result[mapped] != null) continue;
    result[mapped] = v;
  }
  return result;
}

async function batchInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;

  const columns = Object.keys(rows[0]);
  const valuePlaceholders: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const row of rows) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      rowPlaceholders.push(`$${paramIdx++}`);
      values.push(row[col] ?? null);
    }
    valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
  }

  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valuePlaceholders.join(", ")}`;
  await query(sql, values);
}

async function getOrCreateDeal(profileId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM clo_deals WHERE profile_id = $1",
    [profileId],
  );
  if (existing.length > 0) return existing[0].id;

  const profiles = await query<{ extracted_constraints: Record<string, unknown> }>(
    "SELECT extracted_constraints FROM clo_profiles WHERE id = $1",
    [profileId],
  );
  const constraints = profiles[0]?.extracted_constraints || {};
  const dealIdentity = (constraints.dealIdentity || {}) as Record<string, unknown>;

  const dealName = (dealIdentity.dealName as string) || (constraints.dealIdentity as Record<string, unknown>)?.dealName as string || null;
  const collateralManager = (constraints.collateralManager as string) || (constraints.cmDetails as Record<string, unknown>)?.name as string || null;

  const rows = await query<{ id: string }>(
    `INSERT INTO clo_deals (profile_id, deal_name, collateral_manager)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [profileId, dealName, collateralManager],
  );
  return rows[0].id;
}

export type ProgressCallback = (step: string, detail?: string) => void | Promise<void>;

export async function runSectionExtraction(
  profileId: string,
  apiKey: string,
  documents: CloDocument[],
  onProgress?: ProgressCallback,
): Promise<{ reportPeriodId: string; status: "complete" | "partial" | "error" }> {
  const progress = onProgress ?? (() => {});

  // Find the primary PDF document
  const pdfDoc = documents.find((d) => d.type === "application/pdf");
  if (!pdfDoc) throw new Error("No PDF document found");

  // Phase 1: Map document structure
  await progress("mapping", "Identifying document sections...");
  const documentMap = await mapDocument(apiKey, documents);
  await progress("mapping_done", `Found ${documentMap.sections.length} sections`);

  // Phase 2: Transcribe sections to markdown (parallel)
  await progress("transcribing", `Transcribing ${documentMap.sections.length} sections to text...`);
  const sectionTexts = await extractAllSectionTexts(apiKey, pdfDoc, documentMap);
  const successfulTexts = sectionTexts.filter((t) => t.markdown.length > 0);
  await progress("transcribing_done", `Transcribed ${successfulTexts.length}/${documentMap.sections.length} sections`);

  // Phase 3: Extract structured data per section (parallel)
  await progress("extracting", `Extracting structured data from ${successfulTexts.length} sections...`);
  const sectionResults = await extractAllSections(apiKey, sectionTexts, documentMap.documentType);
  const successfulExtracts = sectionResults.filter((r) => r.data != null);
  await progress("extracting_done", `Extracted data from ${successfulExtracts.length}/${sectionTexts.length} sections`);

  // Build sections map
  const sections: Record<string, Record<string, unknown> | null> = {};
  for (const result of sectionResults) {
    sections[result.sectionType] = result.data;
  }

  // Log detailed extraction summary per section
  console.log(`[extraction] ═══ SECTION DATA SUMMARY ═══`);
  for (const [sectionType, data] of Object.entries(sections)) {
    if (!data) {
      console.log(`[extraction] ${sectionType}: NULL (extraction failed)`);
      continue;
    }
    const keys = Object.keys(data);
    const summary: string[] = [];
    for (const key of keys) {
      const val = data[key];
      if (Array.isArray(val)) {
        summary.push(`${key}=${val.length} items`);
      } else if (val === null || val === undefined) {
        summary.push(`${key}=null`);
      } else if (typeof val === "object") {
        summary.push(`${key}={${Object.keys(val as Record<string, unknown>).length} keys}`);
      } else {
        const s = String(val);
        summary.push(`${key}=${s.length > 50 ? s.slice(0, 50) + "..." : s}`);
      }
    }
    console.log(`[extraction] ${sectionType}: ${summary.join(", ")}`);
  }
  console.log(`[extraction] ═══════════════════════════`);

  // Extract reportDate from compliance_summary
  const summarySection = sections.compliance_summary as Record<string, unknown> | null;
  const reportDate = (summarySection?.reportDate as string) ?? new Date().toISOString().slice(0, 10);
  console.log(`[extraction] reportDate=${reportDate}`);

  // Get or create deal, create report period
  const dealId = await getOrCreateDeal(profileId);

  const rpRows = await query<{ id: string }>(
    `INSERT INTO clo_report_periods (deal_id, report_date, extraction_status)
     VALUES ($1, $2, 'extracting')
     ON CONFLICT (deal_id, report_date) DO UPDATE SET extraction_status = 'extracting', updated_at = now()
     RETURNING id`,
    [dealId, reportDate],
  );
  const reportPeriodId = rpRows[0].id;

  // Helper: delete old data only when we have new data to replace it
  async function replaceIfPresent(table: string, rows: Record<string, unknown>[]) {
    if (rows.length === 0) return;
    await query(`DELETE FROM ${table} WHERE report_period_id = $1`, [reportPeriodId]);
    await batchInsert(table, rows);
  }

  // Normalize and insert data
  await progress("saving", "Saving extracted data to database...");
  const normalized = normalizeSectionResults(sections, reportPeriodId, dealId);

  // Log normalized data counts
  console.log(`[extraction] ═══ NORMALIZED DATA COUNTS ═══`);
  console.log(`[extraction] poolSummary: ${normalized.poolSummary ? Object.keys(normalized.poolSummary).length + " fields" : "null"}`);
  console.log(`[extraction] complianceTests: ${normalized.complianceTests.length}`);
  console.log(`[extraction] holdings: ${normalized.holdings.length}`);
  console.log(`[extraction] concentrations: ${normalized.concentrations.length}`);
  console.log(`[extraction] waterfallSteps: ${normalized.waterfallSteps.length}`);
  console.log(`[extraction] proceeds: ${normalized.proceeds.length}`);
  console.log(`[extraction] trades: ${normalized.trades.length}`);
  console.log(`[extraction] tradingSummary: ${normalized.tradingSummary ? "yes" : "null"}`);
  console.log(`[extraction] trancheSnapshots: ${normalized.trancheSnapshots.length}`);
  console.log(`[extraction] accountBalances: ${normalized.accountBalances.length}`);
  console.log(`[extraction] parValueAdjustments: ${normalized.parValueAdjustments.length}`);
  console.log(`[extraction] events: ${normalized.events.length}`);
  console.log(`[extraction] ═══════════════════════════════`);

  // Insert pool summary (remap aliases + filter to known columns)
  if (normalized.poolSummary) {
    const POOL_SUMMARY_COLUMNS = new Set([
      "report_period_id", "total_par", "total_principal_balance", "total_market_value",
      "number_of_obligors", "number_of_assets", "number_of_industries", "number_of_countries",
      "target_par", "par_surplus_deficit", "wac_spread", "wac_total", "wal_years", "warf",
      "diversity_score", "wa_recovery_rate", "wa_moodys_recovery", "wa_sp_recovery",
      "pct_fixed_rate", "pct_floating_rate", "pct_cov_lite", "pct_second_lien",
      "pct_senior_secured", "pct_bonds", "pct_current_pay", "pct_defaulted",
      "pct_ccc_and_below", "pct_single_b", "pct_discount_obligations", "pct_long_dated",
      "pct_semi_annual_pay", "pct_quarterly_pay", "pct_eur_denominated", "pct_gbp_denominated",
      "pct_usd_denominated", "pct_non_base_currency",
    ]);
    const remapped = remapColumnAliases(normalized.poolSummary, POOL_SUMMARY_ALIASES);
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(remapped)) {
      if (POOL_SUMMARY_COLUMNS.has(k)) filtered[k] = v;
      else console.log(`[extraction] pool_summary: dropped unknown field "${k}"`);
    }
    await replaceIfPresent("clo_pool_summary", [filtered]);
    console.log(`[extraction] → clo_pool_summary: inserted`);
  }

  // Insert compliance tests
  await replaceIfPresent("clo_compliance_tests", normalized.complianceTests);
  if (normalized.complianceTests.length > 0) console.log(`[extraction] → clo_compliance_tests: ${normalized.complianceTests.length} rows`);

  // Insert account balances
  await replaceIfPresent("clo_account_balances", normalized.accountBalances);
  if (normalized.accountBalances.length > 0) console.log(`[extraction] → clo_account_balances: ${normalized.accountBalances.length} rows`);

  // Insert par value adjustments
  await replaceIfPresent("clo_par_value_adjustments", normalized.parValueAdjustments);
  if (normalized.parValueAdjustments.length > 0) console.log(`[extraction] → clo_par_value_adjustments: ${normalized.parValueAdjustments.length} rows`);

  // Insert holdings
  await replaceIfPresent("clo_holdings", normalized.holdings);
  if (normalized.holdings.length > 0) console.log(`[extraction] → clo_holdings: ${normalized.holdings.length} rows`);

  // Insert concentrations
  await replaceIfPresent("clo_concentrations", normalized.concentrations);
  if (normalized.concentrations.length > 0) console.log(`[extraction] → clo_concentrations: ${normalized.concentrations.length} rows`);

  // Insert waterfall steps
  await replaceIfPresent("clo_waterfall_steps", normalized.waterfallSteps);
  if (normalized.waterfallSteps.length > 0) console.log(`[extraction] → clo_waterfall_steps: ${normalized.waterfallSteps.length} rows`);

  // Insert proceeds
  await replaceIfPresent("clo_proceeds", normalized.proceeds);
  if (normalized.proceeds.length > 0) console.log(`[extraction] → clo_proceeds: ${normalized.proceeds.length} rows`);

  // Insert trades
  await replaceIfPresent("clo_trades", normalized.trades);
  if (normalized.trades.length > 0) console.log(`[extraction] → clo_trades: ${normalized.trades.length} rows`);

  // Insert trading summary
  if (normalized.tradingSummary) {
    await query("DELETE FROM clo_trading_summary WHERE report_period_id = $1", [reportPeriodId]);
    await batchInsert("clo_trading_summary", [normalized.tradingSummary]);
    console.log(`[extraction] → clo_trading_summary: inserted`);
  }

  // Insert events
  if (normalized.events.length > 0) {
    await query("DELETE FROM clo_events WHERE report_period_id = $1", [reportPeriodId]);
    await batchInsert("clo_events", normalized.events);
    console.log(`[extraction] → clo_events: ${normalized.events.length} rows`);
  }

  // Tranche snapshots: lookup/create tranches, insert snapshots, enrich tranche records
  if (normalized.trancheSnapshots.length > 0) {
    console.log(`[extraction] ═══ TRANCHE SNAPSHOTS ═══`);
    for (const ts of normalized.trancheSnapshots) {
      const dataKeys = Object.entries(ts.data).filter(([, v]) => v != null && v !== undefined).map(([k, v]) => `${k}=${v}`);
      console.log(`[extraction] tranche "${ts.className}": ${dataKeys.join(", ")}`);
    }
    console.log(`[extraction] ════════════════════════`);
    await query("DELETE FROM clo_tranche_snapshots WHERE report_period_id = $1", [reportPeriodId]);
    for (const snapshot of normalized.trancheSnapshots) {
      const normalizedName = normalizeClassName(snapshot.className);
      const allTranches = await query<{ id: string; class_name: string }>(
        "SELECT id, class_name FROM clo_tranches WHERE deal_id = $1",
        [dealId],
      );
      let existing = allTranches.filter((t) => normalizeClassName(t.class_name) === normalizedName);

      if (existing.length === 0) {
        existing = await query<{ id: string; class_name: string }>(
          `INSERT INTO clo_tranches (deal_id, class_name) VALUES ($1, $2) RETURNING id, class_name`,
          [dealId, snapshot.className],
        );
      }

      // Remap aliases + filter to known columns
      const SNAPSHOT_COLUMNS = new Set([
        "report_period_id", "current_balance", "factor", "current_index_rate",
        "coupon_rate", "deferred_interest_balance", "enhancement_pct",
        "beginning_balance", "ending_balance", "interest_accrued", "interest_paid",
        "interest_shortfall", "cumulative_shortfall", "principal_paid", "days_accrued",
      ]);
      const remappedData = remapColumnAliases(snapshot.data, SNAPSHOT_ALIASES);
      const filteredData: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(remappedData)) {
        if (SNAPSHOT_COLUMNS.has(k)) filteredData[k] = v;
      }
      await batchInsert("clo_tranche_snapshots", [{ tranche_id: existing[0].id, ...filteredData }]);

      // Enrich the tranche record with balance from the snapshot
      // Note: spread_bps should only come from PPM extraction, not coupon_rate
      const bal = snapshot.data.current_balance ?? snapshot.data.beginning_balance;
      if (bal != null) {
        await query(
          `UPDATE clo_tranches SET original_balance = $1 WHERE id = $2`,
          [bal, existing[0].id],
        );
      }
    }

    // Infer maturity date from tranche names
    const maturityDates: string[] = [];
    for (const s of normalized.trancheSnapshots) {
      const m = s.className.match(/due\s+(\d{4})/i);
      if (m) maturityDates.push(m[1]);
    }
    if (maturityDates.length > 0) {
      const maxYear = Math.max(...maturityDates.map(Number));
      await query(
        `UPDATE clo_deals SET stated_maturity_date = COALESCE(
          CASE WHEN stated_maturity_date IS NOT NULL AND stated_maturity_date ~ '\\d{4}-\\d{2}-\\d{2}' THEN stated_maturity_date ELSE NULL END,
          $1
        ) WHERE id = $2`,
        [`${maxYear}-07-15`, dealId],
      );
    }
  }

  // Phase 4: Validate
  await progress("validating", "Cross-validating extracted data...");
  let validationResult = validateSectionExtraction(sections);
  console.log(`[extraction] ═══ VALIDATION ═══`);
  console.log(`[extraction] score: ${validationResult.score}/${validationResult.totalChecks} (${validationResult.checksRun} run)`);
  for (const check of validationResult.checks) {
    if (check.status !== "pass") {
      console.log(`[extraction] ${check.status}: ${check.name} — ${check.message ?? ""}`);
    }
  }
  console.log(`[extraction] ═════════════════`);

  // Cap structure cross-validation: PPM vs compliance report tranches
  const ppmConstraints = await query<{ extracted_constraints: Record<string, unknown> }>(
    "SELECT extracted_constraints FROM clo_profiles WHERE id = $1",
    [profileId],
  );
  const ppmCapStructure = (ppmConstraints[0]?.extracted_constraints?.capitalStructure ?? []) as import("../types").CapitalStructureEntry[];

  const waterfallSection = sections.waterfall as Record<string, unknown> | null;
  const waterfallSnapshots = waterfallSection?.trancheSnapshots as import("./schemas").Pass4Output["trancheSnapshots"] | undefined;
  const capStructureChecks = validateCapStructure(ppmCapStructure, waterfallSnapshots);
  if (capStructureChecks.length > 0) {
    validationResult.checks.push(...capStructureChecks);
    validationResult.totalChecks += capStructureChecks.length;
    validationResult.checksRun += capStructureChecks.length;
    validationResult.score = validationResult.checks.filter((c) => c.status === "pass").length;
  }

  // Phase 4: Targeted repair (if needed)
  const repairs = buildRepairQueries(validationResult, sections);

  if (repairs.length > 0) {
    await progress("repairing", `Repairing ${repairs.length} section(s)...`);
    console.log(`[section-extraction] Repair needed for ${repairs.length} section(s): ${repairs.map((r) => `${r.sectionType} (${r.reason})`).join(", ")}`);

    for (const repair of repairs) {
      // Find the original section entry in the document map
      const sectionEntry = documentMap.sections.find((s) => s.sectionType === repair.sectionType);
      if (!sectionEntry) continue;

      // Re-run Phase 2 (transcribe) for this section
      let repairedText: SectionText;
      try {
        repairedText = await extractSectionText(apiKey, pdfDoc, sectionEntry);
      } catch {
        console.log(`[section-extraction] Repair transcription failed for ${repair.sectionType}`);
        continue;
      }

      // Re-run Phase 3 (extract structured data) for this section
      const repairedResult = await extractSection(apiKey, repairedText, documentMap.documentType);

      if (!repairedResult.data || repairedResult.error) {
        console.log(`[section-extraction] Repair extraction failed for ${repair.sectionType}: ${repairedResult.error}`);
        continue;
      }

      // Check if repair produced better data
      const originalData = sections[repair.sectionType];
      let improved = false;

      if (!originalData && repairedResult.data) {
        improved = true;
      } else if (originalData && repairedResult.data) {
        // Compare array lengths for sections with list data
        for (const key of Object.keys(repairedResult.data)) {
          const newVal = repairedResult.data[key];
          const oldVal = originalData[key];
          if (Array.isArray(newVal) && Array.isArray(oldVal) && newVal.length > oldVal.length) {
            improved = true;
            break;
          }
        }
      }

      if (improved) {
        console.log(`[section-extraction] Repair improved ${repair.sectionType}`);
        sections[repair.sectionType] = repairedResult.data;

        // Re-normalize and re-insert the improved section data
        const reNormalized = normalizeSectionResults(sections, reportPeriodId, dealId);

        switch (repair.sectionType) {
          case "asset_schedule":
            await replaceIfPresent("clo_holdings", reNormalized.holdings);
            break;
          case "par_value_tests":
            await replaceIfPresent("clo_compliance_tests", reNormalized.complianceTests);
            await replaceIfPresent("clo_par_value_adjustments", reNormalized.parValueAdjustments);
            break;
          case "interest_coverage_tests":
            await replaceIfPresent("clo_compliance_tests", reNormalized.complianceTests);
            break;
          case "concentration_tables":
            await replaceIfPresent("clo_concentrations", reNormalized.concentrations);
            break;
          case "compliance_summary":
            if (reNormalized.poolSummary) {
              await replaceIfPresent("clo_pool_summary", [reNormalized.poolSummary]);
            }
            break;
        }
      } else {
        console.log(`[section-extraction] Repair did not improve ${repair.sectionType}, keeping original`);
      }
    }

    // Re-run validation after repairs
    validationResult = validateSectionExtraction(sections);
    const repairedCapChecks = validateCapStructure(ppmCapStructure, waterfallSnapshots);
    if (repairedCapChecks.length > 0) {
      validationResult.checks.push(...repairedCapChecks);
      validationResult.totalChecks += repairedCapChecks.length;
      validationResult.checksRun += repairedCapChecks.length;
      validationResult.score = validationResult.checks.filter((c) => c.status === "pass").length;
    }
  }

  // Determine final status
  const failedSections = Object.entries(sections).filter(([, s]) => s === null);
  const truncatedSections = sectionResults.filter((r) => r.truncated);
  const status = failedSections.length > 0 ? "partial"
    : truncatedSections.length > 0 ? "partial"
    : "complete";

  console.log(`[extraction] ═══ FINAL STATUS: ${status} ═══`);
  if (failedSections.length > 0) console.log(`[extraction] failed sections: ${failedSections.map(([k]) => k).join(", ")}`);
  if (truncatedSections.length > 0) console.log(`[extraction] truncated sections: ${truncatedSections.map((r) => r.sectionType).join(", ")}`);

  // Build raw extraction output
  const rawOutputs: Record<string, unknown> = {};
  for (const [sectionType, data] of Object.entries(sections)) {
    rawOutputs[sectionType] = data;
  }

  // Update report period with final data
  await query(
    `UPDATE clo_report_periods
     SET extraction_status = $1,
         extracted_at = now(),
         raw_extraction = $2::jsonb,
         supplementary_data = $3::jsonb,
         data_quality = $4::jsonb,
         updated_at = now()
     WHERE id = $5`,
    [
      status,
      JSON.stringify(rawOutputs),
      normalized.supplementaryData ? JSON.stringify(normalized.supplementaryData) : null,
      JSON.stringify(validationResult),
      reportPeriodId,
    ],
  );

  return { reportPeriodId, status };
}
