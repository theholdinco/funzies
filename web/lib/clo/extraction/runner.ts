import { query } from "../../db";
import type { CloDocument } from "../types";
import { normalizeClassName } from "../api";
import { validateCapStructure, validateSectionExtraction, buildRepairQueries } from "./validator";
import { mapDocument } from "./document-mapper";
import { extractAllSectionTexts, extractSectionText, type SectionText } from "./text-extractor";
import { extractAllSections, extractSection } from "./section-extractor";
import { normalizeSectionResults } from "./normalizer";
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

  // Extract reportDate from compliance_summary
  const summary = sections.compliance_summary as Record<string, unknown> | null;
  const reportDate = (summary?.reportDate as string) ?? new Date().toISOString().slice(0, 10);

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

  // Insert pool summary
  if (normalized.poolSummary) {
    await replaceIfPresent("clo_pool_summary", [normalized.poolSummary]);
  }

  // Insert compliance tests
  await replaceIfPresent("clo_compliance_tests", normalized.complianceTests);

  // Insert account balances
  await replaceIfPresent("clo_account_balances", normalized.accountBalances);

  // Insert par value adjustments
  await replaceIfPresent("clo_par_value_adjustments", normalized.parValueAdjustments);

  // Insert holdings
  await replaceIfPresent("clo_holdings", normalized.holdings);

  // Insert concentrations
  await replaceIfPresent("clo_concentrations", normalized.concentrations);

  // Insert waterfall steps
  await replaceIfPresent("clo_waterfall_steps", normalized.waterfallSteps);

  // Insert proceeds
  await replaceIfPresent("clo_proceeds", normalized.proceeds);

  // Insert trades
  await replaceIfPresent("clo_trades", normalized.trades);

  // Insert trading summary
  if (normalized.tradingSummary) {
    await query("DELETE FROM clo_trading_summary WHERE report_period_id = $1", [reportPeriodId]);
    await batchInsert("clo_trading_summary", [normalized.tradingSummary]);
  }

  // Insert events
  if (normalized.events.length > 0) {
    await query("DELETE FROM clo_events WHERE report_period_id = $1", [reportPeriodId]);
    await batchInsert("clo_events", normalized.events);
  }

  // Tranche snapshots: lookup/create tranches, insert snapshots, enrich tranche records
  if (normalized.trancheSnapshots.length > 0) {
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

      await batchInsert("clo_tranche_snapshots", [{ tranche_id: existing[0].id, ...snapshot.data }]);

      // Enrich the tranche record with financial data from the snapshot
      const bal = snapshot.data.current_balance ?? snapshot.data.beginning_balance;
      const rate = snapshot.data.coupon_rate;
      if (bal != null || rate != null) {
        const setClauses: string[] = [];
        const setValues: unknown[] = [];
        let pi = 1;
        if (bal != null) { setClauses.push(`original_balance = $${pi++}`); setValues.push(bal); }
        if (rate != null) { setClauses.push(`spread_bps = $${pi++}`); setValues.push(Number(rate) * 100); }
        if (setClauses.length > 0) {
          setValues.push(existing[0].id);
          await query(
            `UPDATE clo_tranches SET ${setClauses.join(", ")} WHERE id = $${pi}`,
            setValues,
          );
        }
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
  const failedSections = Object.values(sections).filter((s) => s === null);
  const truncatedSections = sectionResults.filter((r) => r.truncated);
  const status = failedSections.length > 0 ? "partial"
    : truncatedSections.length > 0 ? "partial"
    : "complete";

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
