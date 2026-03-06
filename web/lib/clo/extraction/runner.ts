import { query } from "../../db";
import type { CloDocument } from "../types";
import { callAnthropicWithTool, callAnthropicChunkedWithTool, normalizeClassName } from "../api";
import { pass1Schema, pass2Schema, pass3Schema, pass4Schema, pass5Schema } from "./schemas";
import { pass1Prompt, pass2Prompt, pass3Prompt, pass4Prompt, pass5Prompt, pass2RepairPrompt, passContinuationPrompt } from "./prompts";
import { normalizePass1, normalizePass2, normalizePass3, normalizePass4, normalizePass5 } from "./normalizer";
import { validateExtraction, validateCapStructure, validateSectionExtraction, buildRepairQueries } from "./validator";
import { zodToToolSchema } from "./schema-utils";
import { mapDocument } from "./document-mapper";
import { extractAllSectionTexts, extractSectionText, type SectionText } from "./text-extractor";
import { extractAllSections, extractSection, enhanceWithTableData } from "./section-extractor";
import { normalizeSectionResults } from "./normalizer";
import { extractPdfText } from "./pdf-text-extractor";
import { extractPdfTables } from "./table-extractor";
import { parseComplianceSummaryTables } from "./table-parser";
import { reconcileDates } from "./date-reconciler";
import { mergeAllPasses, EXTRACTION_PASSES } from "./multi-pass-merger";
import type { DocumentMap, SectionEntry } from "./document-mapper";

// ---------------------------------------------------------------------------
// BNY Mellon compliance report template — known section layout.
// Page ranges are approximate (±2-3 pages depending on portfolio size).
// Used as fallback to fill gaps when the mapper misses sections.
// ---------------------------------------------------------------------------
const BNY_COMPLIANCE_TEMPLATE: Array<{ sectionType: string; pageStart: number; pageEnd: number }> = [
  { sectionType: "compliance_summary", pageStart: 1, pageEnd: 3 },
  { sectionType: "par_value_tests", pageStart: 3, pageEnd: 7 },
  { sectionType: "interest_coverage_tests", pageStart: 7, pageEnd: 8 },
  { sectionType: "account_balances", pageStart: 8, pageEnd: 10 },
  { sectionType: "asset_schedule", pageStart: 10, pageEnd: 28 },
  { sectionType: "trading_activity", pageStart: 28, pageEnd: 30 },
  { sectionType: "supplementary", pageStart: 30, pageEnd: 72 },
  // concentration_tables and waterfall are less consistently positioned,
  // so we don't add them as fallback — they'll be extracted from the test data if present.
];

/**
 * Ensure critical compliance sections exist in the document map.
 * If the mapper missed a section, add it with estimated BNY template page ranges.
 * This prevents entire sections from being silently dropped.
 */
function ensureComplianceSections(documentMap: DocumentMap): void {
  const existing = new Set(documentMap.sections.map((s) => s.sectionType));
  const totalPages = Math.max(...documentMap.sections.map((s) => s.pageEnd), 0);

  for (const template of BNY_COMPLIANCE_TEMPLATE) {
    if (existing.has(template.sectionType)) continue;

    // Adjust page ranges if document is shorter/longer than the 72-page template
    const adjustedEnd = Math.min(template.pageEnd, totalPages);
    if (adjustedEnd < template.pageStart) continue;

    const entry: SectionEntry = {
      sectionType: template.sectionType,
      pageStart: template.pageStart,
      pageEnd: adjustedEnd,
      confidence: "low" as const,
      notes: "Added from BNY template fallback — mapper did not detect this section",
    };

    documentMap.sections.push(entry);
    console.log(`[extraction] added missing section from BNY template: ${template.sectionType} (pp${template.pageStart}-${adjustedEnd})`);
  }
}

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
  // First pass: set canonical (non-aliased) keys — these take priority
  for (const [k, v] of Object.entries(row)) {
    const mapped = aliases[k] ?? k;
    if (mapped === k) result[k] = v;
  }
  // Second pass: fill gaps from aliased keys
  for (const [k, v] of Object.entries(row)) {
    const mapped = aliases[k] ?? k;
    if (mapped !== k && result[mapped] == null) {
      result[mapped] = v;
    }
  }
  return result;
}

// Cache of known columns per table (populated on first insert)
const tableColumnsCache = new Map<string, Set<string>>();

async function getTableColumns(table: string): Promise<Set<string>> {
  const cached = tableColumnsCache.get(table);
  if (cached) return cached;
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  const cols = new Set(rows.map((r) => r.column_name));
  tableColumnsCache.set(table, cols);
  return cols;
}

async function batchInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;

  // Filter to only columns that exist in the target table
  const validColumns = await getTableColumns(table);
  const allColumns = Object.keys(rows[0]);
  const columns = allColumns.filter((c) => validColumns.has(c));
  const dropped = allColumns.filter((c) => !validColumns.has(c));
  if (dropped.length > 0) {
    console.log(`[extraction] ${table}: dropped unknown columns: ${dropped.join(", ")}`);
  }

  if (columns.length === 0) return;

  const valuePlaceholders: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const row of rows) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      rowPlaceholders.push(`$${paramIdx++}`);
      const v = row[col];
      values.push(v === "null" || v === "NULL" || v === "" ? null : v ?? null);
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

const TEXT_CHUNK_PAGES = 50; // pages per chunk when splitting extracted text
const TEXT_CHUNK_OVERLAP = 5; // overlap pages between chunks for context continuity

function splitTextIntoPageChunks(
  extractedText: string,
  pagesPerChunk: number = TEXT_CHUNK_PAGES,
  overlap: number = TEXT_CHUNK_OVERLAP,
): string[] {
  // Split on page markers: "--- Page N ---"
  const pagePattern = /--- Page \d+ ---/g;
  const markers: { index: number; marker: string }[] = [];
  let match;
  while ((match = pagePattern.exec(extractedText)) !== null) {
    markers.push({ index: match.index, marker: match[0] });
  }

  if (markers.length <= pagesPerChunk) return [extractedText];

  const chunks: string[] = [];
  for (let i = 0; i < markers.length; i += pagesPerChunk - overlap) {
    const startIdx = markers[i].index;
    const endMarkerIdx = Math.min(i + pagesPerChunk, markers.length);
    const endIdx = endMarkerIdx < markers.length ? markers[endMarkerIdx].index : extractedText.length;
    chunks.push(extractedText.slice(startIdx, endIdx).trim());
    if (endMarkerIdx >= markers.length) break;
  }

  return chunks;
}

async function callClaudeStructured(
  apiKey: string,
  system: string,
  documents: CloDocument[],
  userText: string,
  maxTokens: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any,
  toolName: string,
  extractedText?: string,
): Promise<{ data: Record<string, unknown> | null; truncated: boolean; error?: string; status?: number }> {
  const inputSchema = zodToToolSchema(schema);

  const tool = {
    name: toolName,
    description: "Extract structured data from the document. Return all fields matching the schema.",
    inputSchema,
  };

  if (extractedText) {
    // Always use text-based extraction when pdfplumber text is available.
    // Split into page chunks if needed to avoid token limits.
    const chunks = splitTextIntoPageChunks(extractedText);

    if (chunks.length === 1) {
      const fullUserText = `${userText}\n\n--- DOCUMENT TEXT ---\n${extractedText}`;
      const content = [{ type: "text", text: fullUserText }];
      const result = await callAnthropicWithTool(apiKey, system, content, maxTokens, tool, toolName);
      if (result.error?.includes("prompt is too long")) {
        // Text too large for single chunk — re-split with smaller chunks
        return callClaudeStructuredTextChunked(apiKey, system, userText, maxTokens, tool, extractedText, Math.floor(TEXT_CHUNK_PAGES / 2));
      }
      if (result.error) return { data: null, truncated: false, error: result.error, status: result.status };
      return { data: result.data, truncated: result.truncated };
    }

    return callClaudeStructuredTextChunked(apiKey, system, userText, maxTokens, tool, extractedText, TEXT_CHUNK_PAGES);
  }

  // Fallback: no extracted text available, use PDF document chunking
  const chunked = await callAnthropicChunkedWithTool(apiKey, system, documents, userText, maxTokens, tool);

  if (chunked.error) {
    return { data: null, truncated: false, error: chunked.error, status: chunked.status };
  }

  if (chunked.results.length === 1) {
    return { data: chunked.results[0].data, truncated: chunked.results[0].truncated };
  }

  return mergeChunkResults(chunked.results);
}

async function callClaudeStructuredTextChunked(
  apiKey: string,
  system: string,
  userText: string,
  maxTokens: number,
  tool: { name: string; description: string; inputSchema: Record<string, unknown> },
  extractedText: string,
  pagesPerChunk: number,
): Promise<{ data: Record<string, unknown> | null; truncated: boolean; error?: string; status?: number }> {
  const chunks = splitTextIntoPageChunks(extractedText, pagesPerChunk);
  console.log(`[callClaudeStructured] Splitting text into ${chunks.length} chunks (${pagesPerChunk} pages each, ${TEXT_CHUNK_OVERLAP} overlap)`);

  const chunkResults = await Promise.all(
    chunks.map(async (chunk, i) => {
      const chunkLabel = `pages chunk ${i + 1}/${chunks.length}`;
      const chunkUserText = chunks.length > 1
        ? `[NOTE: This document has been split due to size. You are viewing ${chunkLabel}. Extract all information from these pages.]\n\n${userText}\n\n--- DOCUMENT TEXT ---\n${chunk}`
        : `${userText}\n\n--- DOCUMENT TEXT ---\n${chunk}`;
      const content = [{ type: "text", text: chunkUserText }];
      const result = await callAnthropicWithTool(apiKey, system, content, maxTokens, tool, `${tool.name}_chunk${i + 1}`);
      return { ...result, chunkLabel };
    }),
  );

  const promptTooLong = chunkResults.some((r) => r.error?.includes("prompt is too long"));
  if (promptTooLong && pagesPerChunk > 10) {
    return callClaudeStructuredTextChunked(apiKey, system, userText, maxTokens, tool, extractedText, Math.floor(pagesPerChunk / 2));
  }

  const firstError = chunkResults.find((r) => r.error);
  if (firstError && chunkResults.every((r) => r.error)) {
    return { data: null, truncated: false, error: firstError.error, status: firstError.status };
  }

  const validResults = chunkResults.filter((r) => !r.error && r.data);
  if (validResults.length === 0) {
    return { data: null, truncated: false, error: firstError?.error };
  }
  if (validResults.length === 1) {
    return { data: validResults[0].data, truncated: validResults[0].truncated };
  }

  return mergeChunkResults(validResults);
}

function mergeChunkResults(
  results: Array<{ data: Record<string, unknown> | null; truncated: boolean }>,
): { data: Record<string, unknown> | null; truncated: boolean } {
  let merged: Record<string, unknown> = {};
  for (const result of results) {
    if (!result.data) continue;
    if (Object.keys(merged).length === 0) {
      merged = result.data;
    } else {
      for (const [key, val] of Object.entries(result.data)) {
        if (val == null) continue;
        const baseVal = merged[key];
        if (Array.isArray(val) && Array.isArray(baseVal)) {
          merged[key] = [...baseVal, ...val];
        } else if (merged[key] == null) {
          merged[key] = val;
        }
      }
    }
  }

  const anyTruncated = results.some((r) => r.truncated);
  return { data: Object.keys(merged).length > 0 ? merged : null, truncated: anyTruncated };
}

interface PassResult {
  pass: number;
  data: Record<string, unknown> | null;
  truncated: boolean;
  error?: string;
  raw: string;
}

interface RepairAction {
  pass: number;
  reason: string;
  type: "validation_mismatch" | "truncation";
}

function detectRepairNeeds(
  pass1Data: import("./schemas").Pass1Output,
  passResults: PassResult[],
): RepairAction[] {
  const repairs: RepairAction[] = [];

  for (const pr of passResults) {
    if (pr.truncated && pr.data) {
      repairs.push({
        pass: pr.pass,
        reason: `Pass ${pr.pass} output was truncated`,
        type: "truncation",
      });
    }
  }

  const p2 = passResults.find((p) => p.pass === 2);
  if (p2?.data) {
    const holdings = (p2.data as unknown as import("./schemas").Pass2Output).holdings;
    const expectedAssets = pass1Data.poolSummary.numberOfAssets;
    if (expectedAssets != null && holdings.length < expectedAssets * 0.85) {
      repairs.push({
        pass: 2,
        reason: `Extracted ${holdings.length} holdings but pool summary says ${expectedAssets} assets`,
        type: "validation_mismatch",
      });
    }
  }

  const seen = new Set<number>();
  return repairs.filter((r) => {
    if (seen.has(r.pass)) return false;
    seen.add(r.pass);
    return true;
  });
}

function getLastItems(data: Record<string, unknown>, n: number): { field: string; items: string[] } {
  let largestField = "";
  let largestArray: unknown[] = [];

  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val) && val.length > largestArray.length) {
      largestField = key;
      largestArray = val;
    }
  }

  if (largestArray.length === 0) return { field: "", items: [] };

  const last = largestArray.slice(-n);
  const items = last.map((item) => {
    if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      const name = obj.obligorName ?? obj.testName ?? obj.description ?? obj.className ?? obj.bucketName ?? obj.feeType ?? "";
      return String(name);
    }
    return String(item);
  });

  return { field: largestField, items };
}

export async function runExtraction(
  profileId: string,
  apiKey: string,
  documents: CloDocument[],
): Promise<{ reportPeriodId: string; status: "complete" | "partial" | "error" }> {
  const dealId = await getOrCreateDeal(profileId);

  // Extract text with pdfplumber once for all passes
  let extractedText: string | undefined;
  const pdfDoc = documents.find((d) => d.type === "application/pdf");
  if (pdfDoc) {
    try {
      const pdfText = await extractPdfText(pdfDoc.base64);
      extractedText = pdfText.pages.map((p) => `--- Page ${p.page} ---\n${p.text}`).join("\n\n");
      console.log(`[extraction] pdfplumber extracted ${pdfText.totalPages} pages, ${extractedText.length} chars`);
    } catch (err) {
      console.warn(`[extraction] pdfplumber failed, falling back to PDF documents: ${(err as Error).message}`);
    }
  }

  // Pass 1: blocking — we need reportDate before anything else
  const p1Prompt = pass1Prompt();
  const p1Result = await callClaudeStructured(apiKey, p1Prompt.system, documents, p1Prompt.user, 64000, pass1Schema, "extract_pass1", extractedText);

  if (p1Result.error) {
    throw new Error(`Pass 1 API error: ${p1Result.error}`);
  }

  let pass1Data;
  try {
    pass1Data = pass1Schema.parse(p1Result.data);
  } catch (e) {
    throw new Error(`Pass 1 validate error: ${(e as Error).message}`);
  }

  const reportDate = pass1Data.reportMetadata.reportDate;
  const rawOutputs: Record<string, unknown> = { pass1: p1Result.data };

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

  // Helper: delete old data only when we have new data to replace it
  async function replaceIfPresent(table: string, rows: Record<string, unknown>[]) {
    if (rows.length === 0) return;
    await query(`DELETE FROM ${table} WHERE report_period_id = $1`, [reportPeriodId]);
    await batchInsert(table, rows);
  }

  // Insert Pass 1 data
  const p1Normalized = normalizePass1(pass1Data, reportPeriodId);
  await replaceIfPresent("clo_pool_summary", [p1Normalized.poolSummary]);
  await replaceIfPresent("clo_compliance_tests", p1Normalized.complianceTests);
  await replaceIfPresent("clo_account_balances", p1Normalized.accountBalances);
  await replaceIfPresent("clo_par_value_adjustments", p1Normalized.parValueAdjustments);

  // Propagate CM name from compliance report if deal doesn't have one
  const cmFromReport = pass1Data.reportMetadata.collateralManager;
  if (cmFromReport) {
    await query(
      `UPDATE clo_deals SET collateral_manager = $1 WHERE id = $2 AND (collateral_manager IS NULL OR collateral_manager = '')`,
      [cmFromReport, dealId],
    );
  }

  // Passes 2-5 in parallel
  const passResults: PassResult[] = [];
  const overflowRows: Record<string, unknown>[] = [];

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
    callClaudeStructured(apiKey, pass2Prompt(reportDate).system, documents, pass2Prompt(reportDate).user, 64000, pass2Schema, "extract_pass2", extractedText),
    callClaudeStructured(apiKey, pass3Prompt(reportDate).system, documents, pass3Prompt(reportDate).user, 64000, pass3Schema, "extract_pass3", extractedText),
    callClaudeStructured(apiKey, pass4Prompt(reportDate).system, documents, pass4Prompt(reportDate).user, 64000, pass4Schema, "extract_pass4", extractedText),
    callClaudeStructured(apiKey, pass5Prompt(reportDate).system, documents, pass5Prompt(reportDate).user, 64000, pass5Schema, "extract_pass5", extractedText),
  ]);

  const passInputs = [
    { num: 2, result: p2Result, schema: pass2Schema },
    { num: 3, result: p3Result, schema: pass3Schema },
    { num: 4, result: p4Result, schema: pass4Schema },
    { num: 5, result: p5Result, schema: pass5Schema },
  ];

  for (const { num, result, schema } of passInputs) {
    rawOutputs[`pass${num}`] = result.data;
    if (result.error) {
      passResults.push({ pass: num, data: null, truncated: false, error: result.error, raw: JSON.stringify(result.data) });
      continue;
    }
    try {
      const validated = schema.parse(result.data);
      passResults.push({ pass: num, data: validated as Record<string, unknown>, truncated: result.truncated, raw: JSON.stringify(result.data) });

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
      passResults.push({ pass: num, data: null, truncated: result.truncated, error: (e as Error).message, raw: JSON.stringify(result.data) });
    }
  }

  // Insert Pass 2 data (holdings)
  const p2 = passResults.find((p) => p.pass === 2);
  if (p2?.data) {
    const normalized = normalizePass2(p2.data as unknown as import("./schemas").Pass2Output, reportPeriodId);
    await replaceIfPresent("clo_holdings", normalized.holdings);
  }

  // Insert Pass 3 data (concentrations)
  const p3 = passResults.find((p) => p.pass === 3);
  if (p3?.data) {
    const normalized = normalizePass3(p3.data as unknown as import("./schemas").Pass3Output, reportPeriodId);
    await replaceIfPresent("clo_concentrations", normalized.concentrations);
  }

  // Insert Pass 4 data (waterfall, proceeds, trades, trading_summary, tranche_snapshots)
  const p4 = passResults.find((p) => p.pass === 4);
  if (p4?.data) {
    const normalized = normalizePass4(p4.data as unknown as import("./schemas").Pass4Output, reportPeriodId);

    await replaceIfPresent("clo_waterfall_steps", normalized.waterfallSteps);
    await replaceIfPresent("clo_proceeds", normalized.proceeds);
    await replaceIfPresent("clo_trades", normalized.trades);
    if (normalized.tradingSummary) {
      await query("DELETE FROM clo_trading_summary WHERE report_period_id = $1", [reportPeriodId]);
      await batchInsert("clo_trading_summary", [normalized.tradingSummary]);
    }

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

        // Remap aliases + filter to known columns (same as section-based path)
        const SNAPSHOT_COLUMNS_LEGACY = new Set([
          "report_period_id", "current_balance", "factor", "current_index_rate",
          "coupon_rate", "deferred_interest_balance", "enhancement_pct",
          "beginning_balance", "ending_balance", "interest_accrued", "interest_paid",
          "interest_shortfall", "cumulative_shortfall", "principal_paid", "days_accrued",
        ]);
        const remappedLegacy = remapColumnAliases(snapshot.data, SNAPSHOT_ALIASES);
        const filteredLegacy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(remappedLegacy)) {
          if (SNAPSHOT_COLUMNS_LEGACY.has(k)) filteredLegacy[k] = v;
        }
        await batchInsert("clo_tranche_snapshots", [{ tranche_id: existing[0].id, ...filteredLegacy }]);

        // Enrich the tranche record with balance and spread from the snapshot
        const bal = snapshot.data.current_balance ?? snapshot.data.beginning_balance;
        const spreadLegacy = snapshot.data.spread;
        const legacyClauses: string[] = [];
        const legacyValues: unknown[] = [];
        let li = 1;
        if (bal != null) {
          legacyClauses.push(`original_balance = $${li++}`);
          legacyValues.push(bal);
        }
        if (spreadLegacy != null && typeof spreadLegacy === "number") {
          legacyClauses.push(`spread_bps = COALESCE(spread_bps, $${li++})`);
          legacyValues.push(spreadLegacy);
        }
        if (legacyClauses.length > 0) {
          legacyValues.push(existing[0].id);
          await query(
            `UPDATE clo_tranches SET ${legacyClauses.join(", ")} WHERE id = $${li}`,
            legacyValues,
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
  }

  // Insert Pass 5 data (supplementary + events)
  const p5 = passResults.find((p) => p.pass === 5);
  let supplementaryData: Record<string, unknown> | null = null;
  if (p5?.data) {
    const normalized = normalizePass5(p5.data as unknown as import("./schemas").Pass5Output, reportPeriodId, dealId);
    supplementaryData = normalized.supplementaryData;

    if (normalized.events.length > 0) {
      await query("DELETE FROM clo_events WHERE report_period_id = $1", [reportPeriodId]);
      await batchInsert("clo_events", normalized.events);
    }
  }

  // Insert overflow
  if (overflowRows.length > 0) {
    await query("DELETE FROM clo_extraction_overflow WHERE report_period_id = $1", [reportPeriodId]);
    await batchInsert("clo_extraction_overflow", overflowRows);
  }

  // Run cross-validation
  const pass2Data = p2?.data as unknown as import("./schemas").Pass2Output | null;
  const pass3Data = p3?.data as unknown as import("./schemas").Pass3Output | null;
  const pass4Data = p4?.data as unknown as import("./schemas").Pass4Output | null;
  let validationResult = validateExtraction(pass1Data, pass2Data ?? null, pass3Data ?? null);

  // Cross-validate cap structure: PPM vs compliance report tranches
  const ppmConstraints = await query<{ extracted_constraints: Record<string, unknown> }>(
    "SELECT extracted_constraints FROM clo_profiles WHERE id = $1",
    [profileId],
  );
  const ppmCapStructure = (ppmConstraints[0]?.extracted_constraints?.capitalStructure ?? []) as import("../types").CapitalStructureEntry[];
  const capStructureChecks = validateCapStructure(ppmCapStructure, pass4Data?.trancheSnapshots);
  if (capStructureChecks.length > 0) {
    validationResult.checks.push(...capStructureChecks);
    validationResult.totalChecks += capStructureChecks.length;
    validationResult.checksRun += capStructureChecks.length;
    validationResult.score = validationResult.checks.filter((c) => c.status === "pass").length;
  }

  // Repair loop: re-extract passes with validation failures or truncation
  const repairNeeds = detectRepairNeeds(pass1Data, passResults);

  if (repairNeeds.length > 0) {
    console.log(`[extraction] Repair needed for ${repairNeeds.length} pass(es): ${repairNeeds.map((r) => `Pass ${r.pass} (${r.reason})`).join(", ")}`);

    for (const repair of repairNeeds) {
      const pr = passResults.find((p) => p.pass === repair.pass);

      if (repair.type === "truncation" && pr?.data) {
        const { field, items } = getLastItems(pr.data as Record<string, unknown>, 3);
        if (field && items.length > 0) {
          const contPrompt = passContinuationPrompt(repair.pass, reportDate, items, field);
          const schema = repair.pass === 2 ? pass2Schema : repair.pass === 3 ? pass3Schema : repair.pass === 4 ? pass4Schema : pass5Schema;

          console.log(`[extraction] Running continuation for Pass ${repair.pass}, last items: ${items.join(", ")}`);
          const contResult = await callClaudeStructured(apiKey, contPrompt.system, documents, contPrompt.user, 64000, schema, `extract_pass${repair.pass}`, extractedText);

          if (contResult.data && !contResult.error) {
            const existing = pr.data as Record<string, unknown>;
            for (const [key, val] of Object.entries(contResult.data as Record<string, unknown>)) {
              if (val == null) continue;
              const baseVal = existing[key];
              if (Array.isArray(val) && Array.isArray(baseVal)) {
                existing[key] = [...baseVal, ...val];
              } else if (existing[key] == null) {
                existing[key] = val;
              }
            }
            pr.truncated = contResult.truncated;
            rawOutputs[`pass${repair.pass}_continuation`] = contResult.data;

            if (repair.pass === 2) {
              try {
                const validated = pass2Schema.parse(existing);
                const normalized = normalizePass2(validated, reportPeriodId);
                await replaceIfPresent("clo_holdings", normalized.holdings);
              } catch { /* keep original */ }
            } else if (repair.pass === 3) {
              try {
                const validated = pass3Schema.parse(existing);
                const normalized = normalizePass3(validated, reportPeriodId);
                await replaceIfPresent("clo_concentrations", normalized.concentrations);
              } catch { /* keep original */ }
            } else if (repair.pass === 4) {
              try {
                const validated = pass4Schema.parse(existing);
                const normalized = normalizePass4(validated, reportPeriodId);
                await replaceIfPresent("clo_waterfall_steps", normalized.waterfallSteps);
                await replaceIfPresent("clo_proceeds", normalized.proceeds);
                await replaceIfPresent("clo_trades", normalized.trades);
              } catch { /* keep original */ }
            }
          }
        }
      } else if (repair.type === "validation_mismatch" && repair.pass === 2) {
        const holdings = pr?.data ? (pr.data as unknown as import("./schemas").Pass2Output).holdings : [];
        const expectedAssets = pass1Data.poolSummary.numberOfAssets ?? 0;
        const repairPr = pass2RepairPrompt(reportDate, holdings.length, expectedAssets);

        console.log(`[extraction] Running repair extraction for Pass 2 (${holdings.length}/${expectedAssets} holdings)`);
        const repairResult = await callClaudeStructured(apiKey, repairPr.system, documents, repairPr.user, 64000, pass2Schema, "extract_pass2", extractedText);

        if (repairResult.data && !repairResult.error) {
          try {
            const validated = pass2Schema.parse(repairResult.data);
            if (validated.holdings.length > holdings.length) {
              console.log(`[extraction] Repair improved Pass 2: ${holdings.length} → ${validated.holdings.length} holdings`);
              const prIdx = passResults.findIndex((p) => p.pass === 2);
              passResults[prIdx] = {
                pass: 2,
                data: validated as unknown as Record<string, unknown>,
                truncated: repairResult.truncated,
                raw: JSON.stringify(repairResult.data),
              };
              rawOutputs.pass2_repair = repairResult.data;

              const normalized = normalizePass2(validated, reportPeriodId);
              await replaceIfPresent("clo_holdings", normalized.holdings);
            } else {
              console.log(`[extraction] Repair did not improve Pass 2 (${validated.holdings.length} ≤ ${holdings.length}), keeping original`);
            }
          } catch (e) {
            console.log(`[extraction] Repair Pass 2 validation failed: ${(e as Error).message}`);
          }
        }
      }
    }

    // Re-run validation after repairs
    const repairedP2 = passResults.find((p) => p.pass === 2);
    const repairedPass2Data = repairedP2?.data as unknown as import("./schemas").Pass2Output | null;
    const repairedPass3Data = (passResults.find((p) => p.pass === 3)?.data as unknown as import("./schemas").Pass3Output) ?? null;
    validationResult = validateExtraction(pass1Data, repairedPass2Data ?? null, repairedPass3Data);

    const repairedP4Data = (passResults.find((p) => p.pass === 4)?.data as unknown as import("./schemas").Pass4Output) ?? null;
    const repairedCapChecks = validateCapStructure(ppmCapStructure, repairedP4Data?.trancheSnapshots);
    if (repairedCapChecks.length > 0) {
      validationResult.checks.push(...repairedCapChecks);
      validationResult.totalChecks += repairedCapChecks.length;
      validationResult.checksRun += repairedCapChecks.length;
      validationResult.score = validationResult.checks.filter((c) => c.status === "pass").length;
    }
  }

  // Determine final status
  const finalFailedPasses = passResults.filter((p) => !p.data);
  const finalTruncatedPasses = passResults.filter((p) => p.truncated);
  const status = finalFailedPasses.length > 0 ? "partial"
    : (p1Result.truncated || finalTruncatedPasses.length > 0) ? "partial"
    : "complete";

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

export type ProgressCallback = (step: string, detail?: string) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Single extraction pass: mapping → text → structured extraction → table enhancement.
// Returns extracted sections without persisting anything to the DB.
// ---------------------------------------------------------------------------
interface SinglePassResult {
  sectionResults: import("./section-extractor").SectionExtractionResult[];
  documentMap: DocumentMap;
  tablePagesForDates?: import("./table-extractor").PageTableData[];
  extractionAuditLog?: import("./audit-logger").ExtractionAuditLog;
}

async function runSingleExtractionPass(
  passNum: number,
  apiKey: string,
  pdfDoc: CloDocument,
  documents: CloDocument[],
): Promise<SinglePassResult> {
  const label = `[pass-${passNum}]`;

  // Phase 1: Map document structure
  console.log(`${label} mapping document...`);
  const documentMap = await mapDocument(apiKey, documents);
  if (documentMap.documentType === "compliance_report") {
    ensureComplianceSections(documentMap);
  }
  console.log(`${label} found ${documentMap.sections.length} sections`);

  // Phase 2: Extract text with pdfplumber (deterministic)
  let sectionTexts: SectionText[];
  try {
    const pdfText = await extractPdfText(pdfDoc.base64);
    sectionTexts = documentMap.sections.map((section) => ({
      sectionType: section.sectionType,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      markdown: pdfText.pages
        .filter((p) => p.page >= section.pageStart && p.page <= section.pageEnd)
        .map((p) => p.text)
        .join("\n\n"),
      truncated: false,
    }));
  } catch (err) {
    console.warn(`${label} pdfplumber failed, falling back to Claude vision: ${(err as Error).message}`);
    sectionTexts = await extractAllSectionTexts(apiKey, pdfDoc, documentMap);
  }
  const nonEmpty = sectionTexts.filter((t) => t.markdown.trim().length >= 50);
  const skipped = sectionTexts.filter((t) => t.markdown.trim().length < 50);
  if (skipped.length > 0) {
    console.warn(`${label} skipping ${skipped.length} sections with insufficient text: ${skipped.map((s) => s.sectionType).join(", ")}`);
  }
  console.log(`${label} text extracted for ${nonEmpty.length}/${sectionTexts.length} sections`);

  // Phase 3: Extract structured data per section
  const MULTI_PASS_TEMPERATURE = 0;
  let sectionResults = await extractAllSections(apiKey, nonEmpty, documentMap.documentType, 3, MULTI_PASS_TEMPERATURE);
  const successCount = sectionResults.filter((r) => r.data != null).length;
  const failedSections = sectionResults.filter((r) => r.data == null).map((r) => r.sectionType);
  console.log(`${label} extracted ${successCount}/${sectionResults.length} sections`);
  if (failedSections.length > 0) {
    console.warn(`${label} FAILED sections: ${failedSections.join(", ")}`);
  }

  // Phase 3.5: Enhance with pdfplumber table data (compliance only)
  let extractionAuditLog: import("./audit-logger").ExtractionAuditLog | undefined;
  let tablePagesForDates: import("./table-extractor").PageTableData[] | undefined;

  if (documentMap.documentType === "compliance_report") {
    try {
      const tableResult = await extractPdfTables(pdfDoc.base64);
      tablePagesForDates = tableResult.pages;
      const { enhanced, auditLog } = enhanceWithTableData(sectionResults, tableResult.pages, documentMap);
      sectionResults = enhanced;
      extractionAuditLog = auditLog;
    } catch (err) {
      console.warn(`${label} table enhancement failed (non-fatal): ${(err as Error).message}`);
    }
  }

  return { sectionResults, documentMap, tablePagesForDates, extractionAuditLog };
}

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

  // Run N independent extraction passes in parallel, then merge
  await progress("extracting", `Running ${EXTRACTION_PASSES} independent extraction passes...`);
  console.log(`[extraction] starting ${EXTRACTION_PASSES} independent passes in parallel`);

  const passResults = await Promise.all(
    Array.from({ length: EXTRACTION_PASSES }, (_, i) =>
      runSingleExtractionPass(i + 1, apiKey, pdfDoc, documents),
    ),
  );

  // Merge section results across all passes with AI reconciliation
  await progress("merging", `Merging ${EXTRACTION_PASSES} passes with AI reconciliation...`);
  const allSectionResults = passResults.map((p) => p.sectionResults);
  let sectionResults = await mergeAllPasses(apiKey, allSectionResults);
  const successfulExtracts = sectionResults.filter((r) => r.data != null);
  await progress("extracting_done", `Merged ${EXTRACTION_PASSES} passes → ${successfulExtracts.length} sections`);

  // Use the first pass's metadata for document map, table data, audit log
  const documentMap = passResults[0].documentMap;
  const tablePagesForDates = passResults[0].tablePagesForDates;
  const extractionAuditLog = passResults[0].extractionAuditLog;

  // Build sections map
  const sections: Record<string, Record<string, unknown> | null> = {};
  for (const result of sectionResults) {
    sections[result.sectionType] = result.data;
  }

  // Log detailed extraction summary per section
  console.log(`[extraction] ═══ SECTION DATA SUMMARY (${EXTRACTION_PASSES} passes merged) ═══`);
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

      // Enrich the tranche record with balance and spread from the snapshot
      const bal = snapshot.data.current_balance ?? snapshot.data.beginning_balance;
      const spreadFromReport = snapshot.data.spread;
      const enrichClauses: string[] = [];
      const enrichValues: unknown[] = [];
      let ei = 1;
      if (bal != null) {
        enrichClauses.push(`original_balance = $${ei++}`);
        enrichValues.push(bal);
      }
      // Set spread_bps from compliance report if PPM didn't set it
      if (spreadFromReport != null && typeof spreadFromReport === "number") {
        enrichClauses.push(`spread_bps = COALESCE(spread_bps, $${ei++})`);
        enrichValues.push(spreadFromReport);
      }
      if (enrichClauses.length > 0) {
        enrichValues.push(existing[0].id);
        await query(
          `UPDATE clo_tranches SET ${enrichClauses.join(", ")} WHERE id = $${ei}`,
          enrichValues,
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

  // Phase 3.75: Date reconciliation (if PPM data + compliance dates available)
  if (tablePagesForDates) {
    try {
      const summaryMapSection = documentMap.sections.find((s) => s.sectionType === "compliance_summary");
      if (summaryMapSection) {
        const summaryParsed = parseComplianceSummaryTables(tablePagesForDates, summaryMapSection.pageStart, summaryMapSection.pageEnd);
        const dealDates = summaryParsed.data?.dealDates;

        if (dealDates) {
          const profileRows = await query<{ extracted_constraints: Record<string, unknown> }>(
            "SELECT extracted_constraints FROM clo_profiles WHERE id = $1",
            [profileId],
          );
          const ppmConstraints = profileRows[0]?.extracted_constraints ?? {};
          const ppmKeyDates = (ppmConstraints as Record<string, unknown>).keyDates as Record<string, string | null> | undefined ?? {};

          const complianceDates: Record<string, string | null> = {
            closing_date: dealDates.closingDate ?? null,
            effective_date: dealDates.effectiveDate ?? null,
            reinvestment_period_end: dealDates.reinvestmentPeriodEnd ?? null,
            stated_maturity_date: dealDates.statedMaturity ?? null,
            report_date: dealDates.reportDate ?? null,
            payment_date: dealDates.paymentDate ?? null,
          };

          const ppmDates: Record<string, string | null> = {
            closing_date: (ppmKeyDates as Record<string, string | null>).originalIssueDate ?? null,
            current_issue_date: (ppmKeyDates as Record<string, string | null>).currentIssueDate ?? null,
            reinvestment_period_end: (ppmKeyDates as Record<string, string | null>).reinvestmentPeriodEnd ?? null,
            non_call_period_end: (ppmKeyDates as Record<string, string | null>).nonCallPeriodEnd ?? null,
            stated_maturity_date: (ppmKeyDates as Record<string, string | null>).maturityDate ?? null,
            first_payment_date: (ppmKeyDates as Record<string, string | null>).firstPaymentDate ?? null,
            payment_frequency: (ppmKeyDates as Record<string, string | null>).paymentFrequency ?? null,
          };

          const reconciliation = reconcileDates({ ppmDates, complianceDates });
          const d = reconciliation.resolvedDates;

          const updateFields: string[] = [];
          const updateValues: unknown[] = [];
          let paramIdx = 1;
          for (const col of ["closing_date", "effective_date", "reinvestment_period_end", "non_call_period_end", "stated_maturity_date"]) {
            if (d[col]) {
              updateFields.push(`${col} = $${paramIdx++}`);
              updateValues.push(d[col]);
            }
          }
          if (updateFields.length > 0) {
            updateValues.push(dealId);
            await query(
              `UPDATE clo_deals SET ${updateFields.join(", ")}, updated_at = now() WHERE id = $${paramIdx}`,
              updateValues,
            );
            console.log(`[extraction] updated clo_deals with ${updateFields.length} reconciled dates`);
          }
          if (d.payment_date) {
            await query(
              `UPDATE clo_report_periods SET payment_date = $1, updated_at = now() WHERE id = $2`,
              [d.payment_date, reportPeriodId],
            );
          }
        }
      }
    } catch (err) {
      console.warn(`[extraction] date reconciliation failed (non-fatal): ${(err as Error).message}`);
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
      JSON.stringify({ ...rawOutputs, _auditLog: extractionAuditLog }),
      normalized.supplementaryData ? JSON.stringify(normalized.supplementaryData) : null,
      JSON.stringify(validationResult),
      reportPeriodId,
    ],
  );

  return { reportPeriodId, status };
}
