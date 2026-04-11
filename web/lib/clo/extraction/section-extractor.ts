import type { SectionText } from "./text-extractor";
import { callAnthropicWithTool } from "../api";
import { zodToToolSchema } from "./schema-utils";
import * as schemas from "./section-schemas";
import * as prompts from "./section-prompts";

export interface SectionExtractionResult {
  sectionType: string;
  data: Record<string, unknown> | null;
  truncated: boolean;
  error?: string;
}

interface SectionConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  prompt: () => { system: string; user: string };
}

function getSectionConfig(
  sectionType: string,
  documentType: "compliance_report" | "ppm",
): SectionConfig | null {
  if (documentType === "compliance_report") {
    const map: Record<string, SectionConfig> = {
      compliance_summary: { schema: schemas.complianceSummarySchema, prompt: prompts.complianceSummaryPrompt },
      par_value_tests: { schema: schemas.parValueTestsSchema, prompt: prompts.parValueTestsPrompt },
      interest_coverage_tests: { schema: schemas.interestCoverageTestsSchema, prompt: prompts.interestCoverageTestsPrompt },
      asset_schedule: { schema: schemas.assetScheduleSchema, prompt: prompts.assetSchedulePrompt },
      concentration_tables: { schema: schemas.concentrationSchema, prompt: prompts.concentrationPrompt },
      waterfall: { schema: schemas.waterfallSchema, prompt: prompts.waterfallPrompt },
      trading_activity: { schema: schemas.tradingActivitySchema, prompt: prompts.tradingActivityPrompt },
      interest_accrual: { schema: schemas.interestAccrualSchema, prompt: prompts.interestAccrualPrompt },
      account_balances: { schema: schemas.accountBalancesSchema, prompt: prompts.accountBalancesPrompt },
      supplementary: { schema: schemas.supplementarySchema, prompt: prompts.supplementaryPrompt },
    };
    return map[sectionType] ?? null;
  }

  if (documentType === "ppm") {
    const map: Record<string, SectionConfig> = {
      transaction_overview: { schema: schemas.transactionOverviewSchema, prompt: prompts.ppmTransactionOverviewPrompt },
      capital_structure: { schema: schemas.ppmCapitalStructureSchema, prompt: prompts.ppmCapitalStructurePrompt },
      coverage_tests: { schema: schemas.ppmCoverageTestsSchema, prompt: prompts.ppmCoverageTestsPrompt },
      eligibility_criteria: { schema: schemas.ppmEligibilityCriteriaSchema, prompt: prompts.ppmEligibilityCriteriaPrompt },
      portfolio_constraints: { schema: schemas.ppmPortfolioConstraintsSchema, prompt: prompts.ppmPortfolioConstraintsPrompt },
      waterfall_rules: { schema: schemas.ppmWaterfallRulesSchema, prompt: prompts.ppmWaterfallRulesPrompt },
      fees_and_expenses: { schema: schemas.ppmFeesSchema, prompt: prompts.ppmFeesPrompt },
      key_dates: { schema: schemas.ppmKeyDatesSchema, prompt: prompts.ppmKeyDatesPrompt },
      key_parties: { schema: schemas.ppmKeyPartiesSchema, prompt: prompts.ppmKeyPartiesPrompt },
      interest_mechanics: { schema: schemas.ppmInterestMechanicsSchema, prompt: prompts.ppmInterestMechanicsPrompt },
    };
    return map[sectionType] ?? null;
  }

  return null;
}

function needsRepair(sectionType: string, data: Record<string, unknown> | null): boolean {
  if (!data) return false;

  if (sectionType === "capital_structure") {
    const cap = data.capitalStructure;
    if (!Array.isArray(cap) || cap.length === 0) return false;
    // Check if any tranche is missing the required "class" field
    const broken = cap.filter((t: Record<string, unknown>) => !t.class || !t.designation);
    if (broken.length > 0) {
      console.log(`[section-extractor] capital_structure has ${broken.length}/${cap.length} tranches with missing class/designation — scheduling repair`);
      return true;
    }
  }

  return false;
}

async function repairExtraction(
  apiKey: string,
  sectionText: SectionText,
  brokenData: Record<string, unknown>,
  config: SectionConfig,
): Promise<Record<string, unknown> | null> {
  const brokenJson = JSON.stringify(brokenData, null, 2);
  const tool = {
    name: `repair_${sectionText.sectionType}`,
    description: `Return the repaired structured data for the ${sectionText.sectionType.replace(/_/g, " ")} section`,
    inputSchema: zodToToolSchema(config.schema),
  };

  const system = `You are a JSON repair specialist. You receive garbled/malformed extracted data from a CLO document along with the original source text. Your job is to produce clean, correct structured data.

Common issues:
- Array entries with interleaved fields from different objects (e.g., tranche A's fields mixed into tranche B)
- Missing required fields (class, designation)
- Duplicated entries that should be merged

Rules:
- Use the ORIGINAL SOURCE TEXT as ground truth — re-extract from it if the JSON is too garbled
- Every array entry must be a complete, self-contained object
- Do not fabricate data — use null for fields not in the source text
- Percentages as numbers, monetary amounts as raw numbers, dates as YYYY-MM-DD`;

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: `The following extracted JSON is garbled. Please repair it using the original source text.\n\n## Garbled JSON:\n\`\`\`json\n${brokenJson}\n\`\`\`\n\n## Original source text:\n${sectionText.markdown}` },
  ];

  const label = `repair:${sectionText.sectionType}`;
  console.log(`[section-extractor] running repair for ${sectionText.sectionType}`);
  const result = await callAnthropicWithTool(apiKey, system, content, 16000, tool, label);

  if (result.error) {
    console.error(`[section-extractor] repair failed for ${sectionText.sectionType}: ${result.error.slice(0, 200)}`);
    return null;
  }

  console.log(`[section-extractor] repair succeeded for ${sectionText.sectionType}`);
  return result.data;
}

export async function extractSection(
  apiKey: string,
  sectionText: SectionText,
  documentType: "compliance_report" | "ppm",
  temperature?: number,
): Promise<SectionExtractionResult> {
  const config = getSectionConfig(sectionText.sectionType, documentType);
  if (!config) {
    return { sectionType: sectionText.sectionType, data: null, truncated: false, error: `Unknown section type: ${sectionText.sectionType}` };
  }

  // Skip extraction if markdown is empty — guaranteed to return null
  if (!sectionText.markdown || sectionText.markdown.trim().length < 50) {
    console.warn(`[section-extractor] ${sectionText.sectionType}: skipping — markdown too short (${sectionText.markdown?.length ?? 0} chars)`);
    return { sectionType: sectionText.sectionType, data: null, truncated: false, error: "Empty or insufficient markdown" };
  }

  const prompt = config.prompt();
  const tool = {
    name: `extract_${sectionText.sectionType}`,
    description: `Extract structured data from the ${sectionText.sectionType.replace(/_/g, " ")} section`,
    inputSchema: zodToToolSchema(config.schema),
  };

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: `${prompt.user}\n\n---\n\n${sectionText.markdown}` },
  ];
  const maxTokens = sectionText.sectionType === "asset_schedule" ? 64000 : 16000;

  const label = `extract:${sectionText.sectionType}`;
  const result = await callAnthropicWithTool(apiKey, prompt.system, content, maxTokens, tool, label, temperature);

  if (result.error) {
    console.error(`[section-extractor] ${sectionText.sectionType}: ${result.error.slice(0, 200)}`);
    return { sectionType: sectionText.sectionType, data: null, truncated: false, error: result.error };
  }

  let data = result.data;

  // Auto-repair garbled structured output
  if (needsRepair(sectionText.sectionType, data)) {
    const repaired = await repairExtraction(apiKey, sectionText, data!, config);
    if (repaired) data = repaired;
  }

  return {
    sectionType: sectionText.sectionType,
    data,
    truncated: result.truncated,
  };
}

export async function extractAllSections(
  apiKey: string,
  sectionTexts: SectionText[],
  documentType: "compliance_report" | "ppm",
  concurrency = 3,
  temperature?: number,
): Promise<SectionExtractionResult[]> {
  const results: SectionExtractionResult[] = [];
  const items = [...sectionTexts];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(items.length / concurrency);
    console.log(`[section-extractor] batch ${batchNum}/${totalBatches}: ${batch.map((s) => `${s.sectionType}(${s.markdown.length} chars)`).join(", ")}`);
    const batchResults = await Promise.all(
      batch.map(async (st) => {
        const result = await extractSection(apiKey, st, documentType, temperature);
        const status = result.data ? "OK" : `FAILED${result.error ? `: ${result.error.slice(0, 100)}` : ""}`;
        console.log(`[section-extractor] ${st.sectionType}: ${status}`);
        return result;
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Table enhancement (post-processing) — overlays pdfplumber table data onto
// Claude's extraction results. The existing extraction pipeline is untouched;
// this only IMPROVES results after the fact.
// ---------------------------------------------------------------------------

import type { PageTableData } from "./table-extractor";
import {
  parseComplianceSummaryTables,
  parseComplianceTestTables,
  parseHoldingsTables,
  parseConcentrationFromTests,
  type ParsedComplianceTest,
} from "./table-parser";
import { createAuditLog, addAuditEntry, logAuditSummary, type ExtractionAuditLog } from "./audit-logger";

/**
 * Overlay table-extracted values onto Claude's result.
 * Table = ground truth for numbers/dates. Claude = better for structure/text.
 */
/** Count non-null numeric values in an array of objects */
function arrayDataScore(arr: unknown[]): number {
  let score = 0;
  for (const item of arr) {
    if (item && typeof item === "object") {
      for (const v of Object.values(item as Record<string, unknown>)) {
        if (typeof v === "number") score++;
      }
    }
  }
  return score;
}

function mergeTableOntoClaudeResult(
  tableData: Record<string, unknown>,
  claudeData: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...claudeData };

  for (const [key, tableValue] of Object.entries(tableData)) {
    if (tableValue == null || tableValue === "") continue;
    if (key === "dealDates") continue; // sidecar, not in schema

    const claudeValue = merged[key];

    if (Array.isArray(tableValue)) {
      // Compare data quality: prefer the array with more non-null numeric values
      // Table parser has hardcoded column positions which may be wrong for some PDFs,
      // so only replace Claude's data if the table data is clearly more complete
      if (!Array.isArray(claudeValue) || claudeValue.length === 0) {
        merged[key] = tableValue;
      } else if (tableValue.length > claudeValue.length * 1.5) {
        // Table found significantly more items — likely more complete
        merged[key] = tableValue;
      } else {
        // Similar count — keep whichever has more populated numeric fields
        const tableScore = arrayDataScore(tableValue);
        const claudeScore = arrayDataScore(claudeValue);
        if (tableScore > claudeScore * 1.2) {
          merged[key] = tableValue;
        }
        // Otherwise keep Claude's data (it has correct field-to-value mapping)
      }
    } else if (typeof tableValue === "number") {
      // Table numbers are precise (pdfplumber, no hallucination)
      merged[key] = tableValue;
    } else if (typeof tableValue === "string") {
      // Fill gaps: prefer table if Claude returned nothing
      if (claudeValue == null || claudeValue === "" || claudeValue === "null") {
        merged[key] = tableValue;
      }
    }
  }

  return merged;
}

/**
 * Post-process Claude extraction results by overlaying pdfplumber table data.
 * Call this AFTER extractAllSections() with the same section results.
 * Returns enhanced results + audit log. Original results are not mutated.
 */
export function enhanceWithTableData(
  sectionResults: SectionExtractionResult[],
  tablePages: PageTableData[],
  documentMap: { sections: Array<{ sectionType: string; pageStart: number; pageEnd: number }> },
): { enhanced: SectionExtractionResult[]; auditLog: ExtractionAuditLog } {
  const auditLog = createAuditLog("compliance_report", tablePages.length);
  const enhanced: SectionExtractionResult[] = [];

  // Build page range lookup from document map
  const pageRanges = new Map<string, { pageStart: number; pageEnd: number }>();
  for (const s of documentMap.sections) {
    pageRanges.set(s.sectionType, { pageStart: s.pageStart, pageEnd: s.pageEnd });
  }

  // Parse tests first (needed for concentration derivation)
  let parsedTests: ParsedComplianceTest[] | null = null;
  const testRange = pageRanges.get("par_value_tests") ?? pageRanges.get("interest_coverage_tests");
  if (testRange) {
    const testResult = parseComplianceTestTables(tablePages, testRange.pageStart, testRange.pageEnd);
    if (testResult.data && testResult.data.length > 0) {
      parsedTests = testResult.data;
    }
  }

  for (const result of sectionResults) {
    const range = pageRanges.get(result.sectionType);
    if (!range || !result.data) {
      enhanced.push(result);
      continue;
    }

    const startTime = Date.now();
    let tableData: Record<string, unknown> | null = null;
    let recordCount = 0;
    let quality = 0;

    switch (result.sectionType) {
      case "compliance_summary": {
        const parsed = parseComplianceSummaryTables(tablePages, range.pageStart, range.pageEnd);
        if (parsed.data) {
          tableData = parsed.data as unknown as Record<string, unknown>;
          recordCount = parsed.recordCount;
          quality = parsed.quality;
        }
        break;
      }
      case "par_value_tests":
      case "interest_coverage_tests": {
        if (parsedTests && parsedTests.length > 0) {
          tableData = {
            tests: parsedTests.map((t) => ({
              ...t,
              cushionPct: null,
              cushionAmount: null,
              consequenceIfFail: null,
            })),
          };
          recordCount = parsedTests.length;
          quality = 0.8;
        }
        break;
      }
      case "asset_schedule": {
        const parsed = parseHoldingsTables(tablePages, range.pageStart, range.pageEnd);
        if (parsed.data && parsed.data.length > 0) {
          tableData = { holdings: parsed.data };
          recordCount = parsed.recordCount;
          quality = parsed.quality;
        }
        break;
      }
      case "concentration_tables": {
        if (parsedTests && parsedTests.length > 0) {
          const parsed = parseConcentrationFromTests(parsedTests);
          if (parsed.data && parsed.data.length > 0) {
            tableData = { concentrations: parsed.data };
            recordCount = parsed.recordCount;
            quality = parsed.quality;
          }
        }
        break;
      }
    }

    if (tableData) {
      const before = JSON.stringify(result.data);
      const merged = mergeTableOntoClaudeResult(tableData, result.data);
      const changed = JSON.stringify(merged) !== before;

      addAuditEntry(auditLog, {
        sectionType: result.sectionType,
        method: "table+claude_merged",
        pagesScanned: `${range.pageStart}-${range.pageEnd}`,
        recordsExtracted: recordCount,
        fieldsPerRecord: 0,
        qualityScore: quality,
        nullFieldRatio: 0,
        typeErrors: [],
        rawSamples: [],
        dataQualityNotes: changed ? ["table data improved Claude result"] : ["no changes from table overlay"],
        durationMs: Date.now() - startTime,
      });

      enhanced.push({ ...result, data: merged });
    } else {
      addAuditEntry(auditLog, {
        sectionType: result.sectionType,
        method: "claude",
        pagesScanned: `${range.pageStart}-${range.pageEnd}`,
        recordsExtracted: 0,
        fieldsPerRecord: 0,
        qualityScore: result.data ? 1 : 0,
        nullFieldRatio: 0,
        typeErrors: [],
        rawSamples: [],
        dataQualityNotes: [],
        durationMs: Date.now() - startTime,
      });
      enhanced.push(result);
    }
  }

  logAuditSummary(auditLog);
  return { enhanced, auditLog };
}
