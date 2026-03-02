import { query } from "../../db";
import type { CloDocument } from "../types";
import { buildDocumentContent, callAnthropic, callAnthropicChunked, parseJsonResponse, normalizeClassName } from "../api";
import { pass1Schema, pass2Schema, pass3Schema, pass4Schema, pass5Schema } from "./schemas";
import { pass1Prompt, pass2Prompt, pass3Prompt, pass4Prompt, pass5Prompt } from "./prompts";
import { normalizePass1, normalizePass2, normalizePass3, normalizePass4, normalizePass5 } from "./normalizer";
import { validateExtraction } from "./validator";

async function callClaude(
  apiKey: string,
  system: string,
  documents: CloDocument[],
  userText: string,
  maxTokens: number,
): Promise<{ text: string; truncated: boolean; error?: string; status?: number }> {
  const chunked = await callAnthropicChunked(apiKey, system, documents, userText, maxTokens);

  if (chunked.error) {
    return { text: "", truncated: false, error: chunked.error, status: chunked.status };
  }

  if (chunked.results.length === 1) {
    return { text: chunked.results[0].text, truncated: chunked.results[0].truncated };
  }

  // For multi-chunk results, merge JSON outputs
  let merged: Record<string, unknown> = {};
  for (const result of chunked.results) {
    try {
      const parsed = parseJsonResponse(result.text);
      if (Object.keys(merged).length === 0) {
        merged = parsed;
      } else {
        for (const [key, val] of Object.entries(parsed)) {
          if (val == null) continue;
          const baseVal = merged[key];
          if (Array.isArray(val) && Array.isArray(baseVal)) {
            merged[key] = [...baseVal, ...val];
          } else if (merged[key] == null) {
            merged[key] = val;
          }
        }
      }
    } catch {
      // Individual chunk parse failure — continue with others
    }
  }

  const anyTruncated = chunked.results.some((r) => r.truncated);
  return { text: JSON.stringify(merged), truncated: anyTruncated };
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

interface PassResult {
  pass: number;
  data: Record<string, unknown> | null;
  truncated: boolean;
  error?: string;
  raw: string;
}

export async function runExtraction(
  profileId: string,
  apiKey: string,
  documents: CloDocument[],
): Promise<{ reportPeriodId: string; status: "complete" | "partial" | "error" }> {
  const dealId = await getOrCreateDeal(profileId);

  // Pass 1: blocking — we need reportDate before anything else
  const p1Prompt = pass1Prompt();
  const p1Result = await callClaude(apiKey, p1Prompt.system, documents, p1Prompt.user, 8192);

  if (p1Result.error) {
    throw new Error(`Pass 1 API error: ${p1Result.error}`);
  }

  let pass1Data;
  try {
    const raw = parseJsonResponse(p1Result.text);
    pass1Data = pass1Schema.parse(raw);
  } catch (e) {
    throw new Error(`Pass 1 parse/validate error: ${(e as Error).message}`);
  }

  const reportDate = pass1Data.reportMetadata.reportDate;
  const rawOutputs: Record<string, unknown> = { pass1: p1Result.text };

  // Create report period
  const rpRows = await query<{ id: string }>(
    `INSERT INTO clo_report_periods (deal_id, report_date, payment_date, previous_payment_date, report_type, report_source, reporting_period_start, reporting_period_end, extraction_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'extracting')
     ON CONFLICT (deal_id, report_date) DO UPDATE SET extraction_status = 'extracting', updated_at = now()
     RETURNING id`,
    [
      dealId,
      reportDate,
      pass1Data.reportMetadata.paymentDate ?? null,
      pass1Data.reportMetadata.previousPaymentDate ?? null,
      pass1Data.reportMetadata.reportType ?? null,
      pass1Data.reportMetadata.reportSource ?? null,
      pass1Data.reportMetadata.reportingPeriodStart ?? null,
      pass1Data.reportMetadata.reportingPeriodEnd ?? null,
    ],
  );
  const reportPeriodId = rpRows[0].id;

  // Insert Pass 1 data
  const p1Normalized = normalizePass1(pass1Data, reportPeriodId);
  await batchInsert("clo_pool_summary", [p1Normalized.poolSummary]);
  if (p1Normalized.complianceTests.length > 0) {
    await batchInsert("clo_compliance_tests", p1Normalized.complianceTests);
  }
  if (p1Normalized.accountBalances.length > 0) {
    await batchInsert("clo_account_balances", p1Normalized.accountBalances);
  }
  if (p1Normalized.parValueAdjustments.length > 0) {
    await batchInsert("clo_par_value_adjustments", p1Normalized.parValueAdjustments);
  }

  // Passes 2-5 in parallel
  const passResults: PassResult[] = [];
  const overflowRows: Record<string, unknown>[] = [];

  // Collect Pass 1 overflow
  if (pass1Data._overflow && pass1Data._overflow.length > 0) {
    for (const item of pass1Data._overflow) {
      overflowRows.push({
        report_period_id: reportPeriodId,
        extraction_pass: 1,
        source_section: "pass1",
        label: item.label,
        content: JSON.stringify(item.content),
      });
    }
  }

  const [p2Result, p3Result, p4Result, p5Result] = await Promise.all([
    callClaude(apiKey, pass2Prompt(reportDate).system, documents, pass2Prompt(reportDate).user, 32768),
    callClaude(apiKey, pass3Prompt(reportDate).system, documents, pass3Prompt(reportDate).user, 8192),
    callClaude(apiKey, pass4Prompt(reportDate).system, documents, pass4Prompt(reportDate).user, 8192),
    callClaude(apiKey, pass5Prompt(reportDate).system, documents, pass5Prompt(reportDate).user, 8192),
  ]);

  const passInputs = [
    { num: 2, result: p2Result, schema: pass2Schema },
    { num: 3, result: p3Result, schema: pass3Schema },
    { num: 4, result: p4Result, schema: pass4Schema },
    { num: 5, result: p5Result, schema: pass5Schema },
  ];

  for (const { num, result, schema } of passInputs) {
    rawOutputs[`pass${num}`] = result.text;
    if (result.error) {
      passResults.push({ pass: num, data: null, truncated: false, error: result.error, raw: result.text });
      continue;
    }
    try {
      const raw = parseJsonResponse(result.text);
      const validated = schema.parse(raw);
      passResults.push({ pass: num, data: validated as Record<string, unknown>, truncated: result.truncated, raw: result.text });

      // Collect overflow
      const overflow = (validated as Record<string, unknown[]>)._overflow;
      if (Array.isArray(overflow) && overflow.length > 0) {
        for (const item of overflow as Array<{ label: string; content: unknown }>) {
          overflowRows.push({
            report_period_id: reportPeriodId,
            extraction_pass: num,
            source_section: `pass${num}`,
            label: item.label,
            content: JSON.stringify(item.content),
          });
        }
      }
    } catch (e) {
      passResults.push({ pass: num, data: null, truncated: result.truncated, error: (e as Error).message, raw: result.text });
    }
  }

  // Insert Pass 2 data (holdings)
  const p2 = passResults.find((p) => p.pass === 2);
  if (p2?.data) {
    const normalized = normalizePass2(p2.data as unknown as import("./schemas").Pass2Output, reportPeriodId);
    if (normalized.holdings.length > 0) {
      await batchInsert("clo_holdings", normalized.holdings);
    }
  }

  // Insert Pass 3 data (concentrations)
  const p3 = passResults.find((p) => p.pass === 3);
  if (p3?.data) {
    const normalized = normalizePass3(p3.data as unknown as import("./schemas").Pass3Output, reportPeriodId);
    if (normalized.concentrations.length > 0) {
      await batchInsert("clo_concentrations", normalized.concentrations);
    }
  }

  // Insert Pass 4 data (waterfall, proceeds, trades, trading_summary, tranche_snapshots)
  const p4 = passResults.find((p) => p.pass === 4);
  if (p4?.data) {
    const normalized = normalizePass4(p4.data as unknown as import("./schemas").Pass4Output, reportPeriodId);

    if (normalized.waterfallSteps.length > 0) {
      await batchInsert("clo_waterfall_steps", normalized.waterfallSteps);
    }
    if (normalized.proceeds.length > 0) {
      await batchInsert("clo_proceeds", normalized.proceeds);
    }
    if (normalized.trades.length > 0) {
      await batchInsert("clo_trades", normalized.trades);
    }
    if (normalized.tradingSummary) {
      await batchInsert("clo_trading_summary", [normalized.tradingSummary]);
    }

    // Tranche snapshots need tranche_id lookup (normalized match)
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
    }
  }

  // Insert Pass 5 data (supplementary + events)
  const p5 = passResults.find((p) => p.pass === 5);
  let supplementaryData: Record<string, unknown> | null = null;
  if (p5?.data) {
    const normalized = normalizePass5(p5.data as unknown as import("./schemas").Pass5Output, reportPeriodId, dealId);
    supplementaryData = normalized.supplementaryData;

    if (normalized.events.length > 0) {
      await batchInsert("clo_events", normalized.events);
    }
  }

  // Insert overflow
  if (overflowRows.length > 0) {
    await batchInsert("clo_extraction_overflow", overflowRows);
  }

  // Determine final status
  const failedPasses = passResults.filter((p) => !p.data);
  const truncatedPasses = passResults.filter((p) => p.truncated);
  const status = failedPasses.length > 0 ? "partial"
    : (p1Result.truncated || truncatedPasses.length > 0) ? "partial"
    : "complete";

  // Run cross-validation
  const pass2Data = p2?.data as unknown as import("./schemas").Pass2Output | null;
  const pass3Data = p3?.data as unknown as import("./schemas").Pass3Output | null;
  const validationResult = validateExtraction(pass1Data, pass2Data ?? null, pass3Data ?? null);

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
      supplementaryData ? JSON.stringify(supplementaryData) : null,
      JSON.stringify(validationResult),
      reportPeriodId,
    ],
  );

  return { reportPeriodId, status };
}
