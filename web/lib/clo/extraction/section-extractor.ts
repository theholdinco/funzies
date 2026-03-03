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
      redemption: { schema: schemas.ppmRedemptionSchema, prompt: prompts.ppmRedemptionPrompt },
      hedging: { schema: schemas.ppmHedgingSchema, prompt: prompts.ppmHedgingPrompt },
    };
    return map[sectionType] ?? null;
  }

  return null;
}

export async function extractSection(
  apiKey: string,
  sectionText: SectionText,
  documentType: "compliance_report" | "ppm",
): Promise<SectionExtractionResult> {
  const config = getSectionConfig(sectionText.sectionType, documentType);
  if (!config) {
    return { sectionType: sectionText.sectionType, data: null, truncated: false, error: `Unknown section type: ${sectionText.sectionType}` };
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

  const result = await callAnthropicWithTool(apiKey, prompt.system, content, maxTokens, tool);

  if (result.error) {
    return { sectionType: sectionText.sectionType, data: null, truncated: false, error: result.error };
  }

  return {
    sectionType: sectionText.sectionType,
    data: result.data,
    truncated: result.truncated,
  };
}

export async function extractAllSections(
  apiKey: string,
  sectionTexts: SectionText[],
  documentType: "compliance_report" | "ppm",
  concurrency = 3,
): Promise<SectionExtractionResult[]> {
  const results: SectionExtractionResult[] = [];
  const items = [...sectionTexts];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((st) => extractSection(apiKey, st, documentType)),
    );
    results.push(...batchResults);
  }

  return results;
}
