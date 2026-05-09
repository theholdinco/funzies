import Anthropic from "@anthropic-ai/sdk";
import { Pool } from "pg";
import { parsePanelMembers } from "../lib/clo/parsers/panel-members.js";
import {
  parseCreditMemo,
  parseCreditRiskAssessment,
  parseCreditRecommendation,
  parseDebate,
  parseIndividualAssessments,
} from "../lib/clo/parsers/analysis.js";
import { getRecentAnalysisSummaries } from "../lib/clo/history.js";
import { rowToProfile } from "../lib/clo/access.js";
import { getBuyListForProfile } from "../lib/clo/buy-list.js";
import type { PanelMember } from "../lib/clo/types/index.js";
import { chunkPipelineDocuments, type PipelineDocument } from "../lib/clo/pdf-chunking.js";
import {
  profileAnalysisPrompt,
  panelGenerationPrompt,
  avatarMappingPrompt,
  creditAnalysisPrompt,
  dynamicSpecialistPrompt,
  individualAssessmentsPrompt,
  analysisDebatePrompt,
  premortemPrompt,
  creditMemoPrompt,
  riskAssessmentPrompt,
  recommendationPrompt,
  portfolioGapAnalysisPrompt,
  screeningDebatePrompt,
  screeningSynthesisPrompt,
  formatReportPeriodState,
} from "./clo-prompts.js";
import type { CloPoolSummary, CloComplianceTest, CloConcentration, CloEvent, CloExtractionOverflow } from "../lib/clo/types/index.js";
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };

async function getLatestBriefing(pool: Pool, briefType = "general"): Promise<string | null> {
  const result = await pool.query<{ content: string }>(
    "SELECT content FROM daily_briefings WHERE brief_type = $1 ORDER BY fetched_at DESC LIMIT 1",
    [briefType]
  );
  return result.rows[0]?.content ?? null;
}

async function getReportPeriodContext(pool: Pool, profileId: string): Promise<string> {
  const dealRows = await pool.query<{ id: string }>(
    "SELECT id FROM clo_deals WHERE profile_id = $1 LIMIT 1",
    [profileId]
  );
  if (dealRows.rows.length === 0) return "";
  const dealId = dealRows.rows[0].id;

  const periodRows = await pool.query<{ id: string }>(
    "SELECT id FROM clo_report_periods WHERE deal_id = $1 ORDER BY report_date DESC LIMIT 1",
    [dealId]
  );
  if (periodRows.rows.length === 0) return "";
  const periodId = periodRows.rows[0].id;

  const [poolRows, testRows, concRows, eventRows, overflowRows] = await Promise.all([
    pool.query("SELECT * FROM clo_pool_summary WHERE report_period_id = $1 LIMIT 1", [periodId]),
    pool.query("SELECT * FROM clo_compliance_tests WHERE report_period_id = $1", [periodId]),
    pool.query("SELECT * FROM clo_concentrations WHERE report_period_id = $1", [periodId]),
    pool.query("SELECT * FROM clo_events WHERE deal_id = $1 ORDER BY event_date DESC NULLS LAST LIMIT 20", [dealId]),
    pool.query("SELECT * FROM clo_extraction_overflow WHERE report_period_id = $1 LIMIT 10", [periodId]),
  ]);

  const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const convertRow = (row: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v;
    return out;
  };

  const poolSummary = poolRows.rows.length > 0 ? convertRow(poolRows.rows[0]) as unknown as CloPoolSummary : null;
  const complianceTests = testRows.rows.map((r: Record<string, unknown>) => convertRow(r)) as unknown as CloComplianceTest[];
  const concentrations = concRows.rows.map((r: Record<string, unknown>) => convertRow(r)) as unknown as CloConcentration[];
  const events = eventRows.rows.map((r: Record<string, unknown>) => convertRow(r)) as unknown as CloEvent[];
  const overflow = overflowRows.rows.map((r: Record<string, unknown>) => convertRow(r)) as unknown as CloExtractionOverflow[];

  return formatReportPeriodState(poolSummary, complianceTests, concentrations, events, overflow);
}

export interface PipelineCallbacks {
  updatePhase: (phase: string) => Promise<void>;
  updateRawFiles: (files: Record<string, string>) => Promise<void>;
  updateParsedData: (data: unknown) => Promise<void>;
}

function buildContentBlocks(
  documents: PipelineDocument[],
  userMessage: string,
): Anthropic.MessageCreateParams["messages"][0]["content"] {
  return [
    ...documents.map((doc) => {
      if (doc.type === "application/pdf") {
        return {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: doc.base64,
          },
        };
      }
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: doc.type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: doc.base64,
        },
      };
    }),
    { type: "text" as const, text: userMessage },
  ];
}

async function callClaudeSingle(
  client: Anthropic,
  systemPrompt: string,
  content: Anthropic.MessageCreateParams["messages"][0]["content"],
  maxTokens: number,
  model: string,
  tools?: Array<Record<string, unknown>>,
): Promise<string> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      ...(tools && tools.length > 0 ? { tools } : {}),
    } as Anthropic.MessageCreateParams) as Anthropic.Message;

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      const apiErr = err as { status: number; message?: string };
      if (apiErr.status === 401) {
        throw new Error("Invalid API key. Please update your key in Settings.");
      }
      if (apiErr.status === 429) {
        throw new Error("Rate limited by Anthropic. Please wait and try again, or check your API plan limits.");
      }
      if (apiErr.status === 529) {
        throw new Error("Anthropic API is temporarily overloaded. Your analysis will be retried.");
      }
    }
    throw err;
  }
}

async function callClaude(
  client: Anthropic,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  model: string = "claude-sonnet-4-20250514",
  documents?: PipelineDocument[],
  tools?: Array<Record<string, unknown>>
): Promise<string> {
  if (!documents || documents.length === 0) {
    return callClaudeSingle(client, systemPrompt, userMessage, maxTokens, model, tools);
  }

  const chunkSets = await chunkPipelineDocuments(documents);

  if (chunkSets.length === 1) {
    const content = buildContentBlocks(chunkSets[0].documents, userMessage);
    return callClaudeSingle(client, systemPrompt, content, maxTokens, model, tools);
  }

  // Multiple chunks: call each in parallel and concatenate
  const results = await Promise.all(
    chunkSets.map(async (chunkSet) => {
      const chunkMessage = `[NOTE: The attached documents have been split due to size limits. You are viewing ${chunkSet.chunkLabel}. Analyze these pages and provide your assessment.]\n\n${userMessage}`;
      const content = buildContentBlocks(chunkSet.documents, chunkMessage);
      return callClaudeSingle(client, systemPrompt, content, maxTokens, model, tools);
    }),
  );

  return results.join("\n\n");
}

function attachAvatars(members: PanelMember[], rawAvatarJson: string) {
  try {
    const avatarMapping = JSON.parse(rawAvatarJson) as Array<{
      name: string;
      skinColor: string;
      hair: string;
      hairColor: string;
      eyes: string;
      eyebrows: string;
      mouth: string;
      glasses: string;
      features: string;
    }>;
    for (const member of members) {
      const mapping = avatarMapping.find(
        (m) => m.name.toLowerCase() === member.name.toLowerCase()
      );
      if (mapping) {
        const params = new URLSearchParams({
          seed: mapping.name,
          skinColor: mapping.skinColor,
          hair: mapping.hair,
          hairColor: mapping.hairColor,
          eyes: mapping.eyes,
          eyebrows: mapping.eyebrows,
          mouth: mapping.mouth,
        });
        if (mapping.glasses !== "none") {
          params.set("glasses", mapping.glasses);
          params.set("glassesProbability", "100");
        } else {
          params.set("glassesProbability", "0");
        }
        if (mapping.features !== "none") {
          params.set("features", mapping.features);
          params.set("featuresProbability", "100");
        } else {
          params.set("featuresProbability", "0");
        }
        member.avatarUrl = `https://api.dicebear.com/9.x/adventurer/svg?${params.toString()}`;
      }
    }
  } catch {
    console.warn("[clo-pipeline] Failed to parse avatar-mapping.json, skipping avatars");
  }
}

// ─── Panel Pipeline ──────────────────────────────────────────────────

export async function runPanelPipeline(
  pool: Pool,
  profileId: string,
  apiKey: string,
  initialRawFiles: Record<string, string>,
  callbacks: PipelineCallbacks
): Promise<{ members: PanelMember[] }> {
  const client = new Anthropic({ apiKey });
  const rawFiles: Record<string, string> = { ...initialRawFiles };

  // Fetch profile
  const profileRows = await pool.query(
    "SELECT * FROM clo_profiles WHERE id = $1",
    [profileId]
  );
  if (profileRows.rows.length === 0) {
    throw new Error(`Profile ${profileId} not found`);
  }
  const profile = rowToProfile(profileRows.rows[0]);

  // Phase 1: Profile Analysis
  if (!rawFiles["profile-analysis.md"]) {
    await callbacks.updatePhase("profile-analysis");
    const prompt = profileAnalysisPrompt(profile);
    const result = await callClaude(client, prompt.system, prompt.user, 8192);
    rawFiles["profile-analysis.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
  }

  // Phase 2: Panel Generation
  if (!rawFiles["panel-generation.md"]) {
    await callbacks.updatePhase("panel-generation");
    const prompt = panelGenerationPrompt(rawFiles["profile-analysis.md"], profile);
    const result = await callClaude(client, prompt.system, prompt.user, 16384);
    rawFiles["panel-generation.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
  }

  // Parse members
  const members = parsePanelMembers(rawFiles["panel-generation.md"]);
  if (members.length === 0) {
    throw new Error("Panel generation produced no members — output may be malformed");
  }

  // Phase 3: Avatar Mapping
  if (!rawFiles["avatar-mapping.json"]) {
    await callbacks.updatePhase("avatar-mapping");
    const result = await callClaude(
      client,
      "You are a visual character designer. Return only a valid JSON array mapping each person to DiceBear Adventurer avatar parameters.",
      avatarMappingPrompt(rawFiles["panel-generation.md"]),
      4096,
      "claude-haiku-4-5-20251001"
    );
    const cleaned = result.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    rawFiles["avatar-mapping.json"] = cleaned;
    await callbacks.updateRawFiles(rawFiles);
  }

  attachAvatars(members, rawFiles["avatar-mapping.json"]);
  await callbacks.updateParsedData({ members });

  return { members };
}

// ─── Analysis Pipeline ───────────────────────────────────────────────

export async function runAnalysisPipeline(
  pool: Pool,
  analysisId: string,
  apiKey: string,
  initialRawFiles: Record<string, string>,
  callbacks: PipelineCallbacks
): Promise<void> {
  const client = new Anthropic({ apiKey });
  const rawFiles: Record<string, string> = { ...initialRawFiles };

  // Fetch analysis, panel, and profile
  const analysisRows = await pool.query(
    `SELECT a.*, p.members, p.profile_id, p.id as panel_id
     FROM clo_analyses a
     JOIN clo_panels p ON a.panel_id = p.id
     WHERE a.id = $1`,
    [analysisId]
  );
  if (analysisRows.rows.length === 0) {
    throw new Error(`Analysis ${analysisId} not found`);
  }
  const analysisRow = analysisRows.rows[0];
  const members: PanelMember[] = analysisRow.members || [];
  const dynamicSpecialists: PanelMember[] = analysisRow.dynamic_specialists || [];

  const profileRows = await pool.query(
    "SELECT * FROM clo_profiles WHERE id = $1",
    [analysisRow.profile_id]
  );
  if (profileRows.rows.length === 0) {
    throw new Error(`Profile ${analysisRow.profile_id} not found`);
  }
  const profile = rowToProfile(profileRows.rows[0]);

  const analysisDocuments: Array<{ name: string; type: string; base64: string }> =
    analysisRow.documents || [];
  const profileDocuments: Array<{ name: string; type: string; base64: string }> =
    profile.documents || [];
  const allDocuments = [...profileDocuments, ...analysisDocuments];

  const analysis = {
    title: analysisRow.title,
    analysisType: analysisRow.analysis_type,
    borrowerName: analysisRow.borrower_name,
    sector: analysisRow.sector,
    loanType: analysisRow.loan_type,
    spreadCoupon: analysisRow.spread_coupon,
    rating: analysisRow.rating,
    maturity: analysisRow.maturity,
    currency: analysisRow.currency,
    facilitySize: analysisRow.facility_size,
    leverage: analysisRow.leverage,
    interestCoverage: analysisRow.interest_coverage,
    covenantsSummary: analysisRow.covenants_summary,
    ebitda: analysisRow.ebitda,
    revenue: analysisRow.revenue,
    companyDescription: analysisRow.company_description,
    notes: analysisRow.notes,
    switchBorrowerName: analysisRow.switch_borrower_name,
    switchSector: analysisRow.switch_sector,
    switchLoanType: analysisRow.switch_loan_type,
    switchSpreadCoupon: analysisRow.switch_spread_coupon,
    switchRating: analysisRow.switch_rating,
    switchMaturity: analysisRow.switch_maturity,
    switchCurrency: analysisRow.switch_currency,
    switchFacilitySize: analysisRow.switch_facility_size,
    switchLeverage: analysisRow.switch_leverage,
    switchInterestCoverage: analysisRow.switch_interest_coverage,
    switchCovenantsSummary: analysisRow.switch_covenants_summary,
    switchEbitda: analysisRow.switch_ebitda,
    switchRevenue: analysisRow.switch_revenue,
    switchCompanyDescription: analysisRow.switch_company_description,
    switchNotes: analysisRow.switch_notes,
  };

  const parsedData: Record<string, unknown> = analysisRow.parsed_data || {};

  // Re-derive parsed data from existing raw files if missing (handles partial failure resume)
  if (rawFiles["individual-assessments.md"] && !parsedData.individualAssessments) {
    parsedData.individualAssessments = parseIndividualAssessments(rawFiles["individual-assessments.md"]);
  }
  if (rawFiles["debate.md"] && !parsedData.debate) {
    parsedData.debate = parseDebate(rawFiles["debate.md"]);
  }
  if (rawFiles["memo.md"] && !parsedData.memo) {
    parsedData.memo = parseCreditMemo(rawFiles["memo.md"]);
  }
  if (rawFiles["risk-assessment.md"] && !parsedData.riskAssessment) {
    parsedData.riskAssessment = parseCreditRiskAssessment(rawFiles["risk-assessment.md"]);
  }
  if (rawFiles["premortem.md"] && !parsedData.premortem) {
    parsedData.premortem = rawFiles["premortem.md"];
  }
  if (rawFiles["recommendation.md"] && !parsedData.recommendation) {
    parsedData.recommendation = parseCreditRecommendation(rawFiles["recommendation.md"]);
  }

  // Fetch compliance report data for richer context in all pipeline phases
  const reportPeriodContext = await getReportPeriodContext(pool, analysisRow.profile_id);

  // Fetch buy list for this profile
  const buyListItems = await getBuyListForProfile(analysisRow.profile_id);

  // Inject daily briefings into the first phase so the AI has current market context
  const [generalBriefing, cloBriefing] = await Promise.all([
    getLatestBriefing(pool),
    getLatestBriefing(pool, "clo"),
  ]);
  const briefingParts: string[] = [];
  if (generalBriefing) briefingParts.push(generalBriefing);
  if (cloBriefing) briefingParts.push(cloBriefing);
  const briefingSection = briefingParts.length > 0
    ? `\n\nMARKET INTELLIGENCE (today's briefing — reference when relevant, do not repeat verbatim):\n${briefingParts.join("\n\n")}`
    : "";

  // Phase 1: Credit Analysis
  if (!rawFiles["credit-analysis.md"]) {
    await callbacks.updatePhase("credit-analysis");
    const prompt = creditAnalysisPrompt(analysis, profile, reportPeriodContext || undefined, buyListItems);
    const result = await callClaude(client, prompt.system + briefingSection, prompt.user, 8192, undefined, allDocuments, [WEB_SEARCH_TOOL]);
    rawFiles["credit-analysis.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
  }

  // Phase 2: Dynamic Specialists
  if (!rawFiles["dynamic-specialists.md"]) {
    await callbacks.updatePhase("dynamic-specialists");

    // Re-fetch from DB in case of retry after partial phase-2 completion
    const freshRow = await pool.query(
      "SELECT dynamic_specialists FROM clo_analyses WHERE id = $1",
      [analysisId]
    );
    const currentSpecialists: PanelMember[] = freshRow.rows[0]?.dynamic_specialists || [];
    dynamicSpecialists.length = 0;
    dynamicSpecialists.push(...currentSpecialists);

    const prompt = dynamicSpecialistPrompt(
      rawFiles["credit-analysis.md"],
      members,
      profile
    );
    const result = await callClaude(client, prompt.system, prompt.user, 8192);
    rawFiles["dynamic-specialists.md"] = result;
    await callbacks.updateRawFiles(rawFiles);

    if (!result.includes("NO_ADDITIONAL_SPECIALISTS_NEEDED")) {
      const specialists = parsePanelMembers(result);
      if (specialists.length > 0) {
        const existingNames = new Set(dynamicSpecialists.map((s) => s.name.toLowerCase()));
        const newSpecialists = specialists.filter((s) => !existingNames.has(s.name.toLowerCase()));
        if (newSpecialists.length > 0) {
          dynamicSpecialists.push(...newSpecialists);
          await pool.query(
            "UPDATE clo_analyses SET dynamic_specialists = $1::jsonb WHERE id = $2",
            [JSON.stringify(dynamicSpecialists), analysisId]
          );
        }
      }
    }
  }

  const allMembers = [...members, ...dynamicSpecialists];

  // Phase 3: Individual Assessments
  if (!rawFiles["individual-assessments.md"]) {
    await callbacks.updatePhase("individual-assessments");
    const history = await getRecentAnalysisSummaries(pool, analysisRow.panel_id);
    const prompt = individualAssessmentsPrompt(
      allMembers,
      rawFiles["credit-analysis.md"],
      profile,
      history,
      reportPeriodContext || undefined,
      buyListItems
    );
    const result = await callClaude(client, prompt.system, prompt.user, 8192, undefined, allDocuments, [WEB_SEARCH_TOOL]);
    rawFiles["individual-assessments.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
    parsedData.individualAssessments = parseIndividualAssessments(result);
    await callbacks.updateParsedData(parsedData);
  }

  // Phase 4: Debate
  if (!rawFiles["debate.md"]) {
    await callbacks.updatePhase("debate");
    const prompt = analysisDebatePrompt(
      allMembers,
      rawFiles["individual-assessments.md"],
      rawFiles["credit-analysis.md"],
      profile,
      reportPeriodContext || undefined,
      buyListItems
    );
    const result = await callClaude(client, prompt.system, prompt.user, 16384, undefined, allDocuments, [WEB_SEARCH_TOOL]);
    rawFiles["debate.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
    parsedData.debate = parseDebate(result);
    await callbacks.updateParsedData(parsedData);
  }

  // Phase 5: Pre-Mortem
  if (!rawFiles["premortem.md"]) {
    await callbacks.updatePhase("premortem");
    const prompt = premortemPrompt(
      allMembers,
      rawFiles["debate.md"],
      rawFiles["credit-analysis.md"],
      profile,
      reportPeriodContext || undefined,
      buyListItems
    );
    const result = await callClaude(client, prompt.system, prompt.user, 8192, undefined, allDocuments, [WEB_SEARCH_TOOL]);
    rawFiles["premortem.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
    parsedData.premortem = result;
    await callbacks.updateParsedData(parsedData);
  }

  // Phase 6: Credit Memo
  if (!rawFiles["memo.md"]) {
    await callbacks.updatePhase("memo");
    const prompt = creditMemoPrompt(
      rawFiles["debate.md"],
      rawFiles["individual-assessments.md"],
      rawFiles["credit-analysis.md"],
      profile,
      analysis.title,
      rawFiles["premortem.md"],
      reportPeriodContext || undefined,
      buyListItems
    );
    const result = await callClaude(client, prompt.system, prompt.user, 8192, undefined, allDocuments);
    rawFiles["memo.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
    parsedData.memo = parseCreditMemo(result);
    await callbacks.updateParsedData(parsedData);
  }

  // Phase 7: Risk Assessment
  if (!rawFiles["risk-assessment.md"]) {
    await callbacks.updatePhase("risk-assessment");
    const prompt = riskAssessmentPrompt(
      rawFiles["debate.md"],
      rawFiles["credit-analysis.md"],
      profile,
      rawFiles["premortem.md"],
      reportPeriodContext || undefined,
      buyListItems
    );
    const result = await callClaude(client, prompt.system, prompt.user, 8192, undefined, allDocuments);
    rawFiles["risk-assessment.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
    parsedData.riskAssessment = parseCreditRiskAssessment(result);
    await callbacks.updateParsedData(parsedData);
  }

  // Phase 8: Recommendation
  if (!rawFiles["recommendation.md"]) {
    await callbacks.updatePhase("recommendation");
    const prompt = recommendationPrompt(
      rawFiles["memo.md"],
      rawFiles["risk-assessment.md"],
      rawFiles["debate.md"],
      allMembers,
      profile,
      rawFiles["premortem.md"],
      reportPeriodContext || undefined,
      buyListItems
    );
    const result = await callClaude(client, prompt.system, prompt.user, 8192, undefined, allDocuments);
    rawFiles["recommendation.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
    parsedData.recommendation = parseCreditRecommendation(result);
    await callbacks.updateParsedData(parsedData);
  }
}

// ─── Screening Pipeline ─────────────────────────────────────────────

export async function runScreeningPipeline(
  pool: Pool,
  screeningId: string,
  apiKey: string,
  initialRawFiles: Record<string, string>,
  callbacks: PipelineCallbacks
): Promise<void> {
  const client = new Anthropic({ apiKey });
  const rawFiles: Record<string, string> = { ...initialRawFiles };

  // Fetch screening, panel, and profile
  const screeningRows = await pool.query(
    `SELECT s.*, p.members, p.profile_id, p.id as panel_id
     FROM clo_screenings s
     JOIN clo_panels p ON s.panel_id = p.id
     WHERE s.id = $1`,
    [screeningId]
  );
  if (screeningRows.rows.length === 0) {
    throw new Error(`Screening ${screeningId} not found`);
  }
  const screeningRow = screeningRows.rows[0];
  const members: PanelMember[] = screeningRow.members || [];

  const profileRows = await pool.query(
    "SELECT * FROM clo_profiles WHERE id = $1",
    [screeningRow.profile_id]
  );
  if (profileRows.rows.length === 0) {
    throw new Error(`Profile ${screeningRow.profile_id} not found`);
  }
  const profile = rowToProfile(profileRows.rows[0]);

  const profileDocuments: Array<{ name: string; type: string; base64: string }> =
    profile.documents || [];

  const focusArea = screeningRow.focus_area || "";
  const parsedData: Record<string, unknown> = screeningRow.parsed_data || {};

  // Fetch compliance report data for richer context
  const reportPeriodContext = await getReportPeriodContext(pool, screeningRow.profile_id);

  // Fetch buy list for this profile
  const buyListItems = await getBuyListForProfile(screeningRow.profile_id);

  // Re-derive parsed data from existing raw files if missing (handles partial failure resume)
  if (rawFiles["gap-analysis.md"] && !parsedData.gapAnalysis) {
    parsedData.gapAnalysis = rawFiles["gap-analysis.md"];
  }
  if (rawFiles["screening-synthesis.md"] && !parsedData.ideas) {
    parsedData.ideas = parseIdeas(rawFiles["screening-synthesis.md"]);
    parsedData.raw = rawFiles["screening-synthesis.md"];
  }

  // Phase 1: Gap Analysis
  if (!rawFiles["gap-analysis.md"]) {
    await callbacks.updatePhase("gap-analysis");
    const recentAnalyses = await getRecentAnalysisSummaries(pool, screeningRow.panel_id);
    const prompt = portfolioGapAnalysisPrompt(profile, recentAnalyses, reportPeriodContext || undefined, buyListItems);
    const result = await callClaude(client, prompt.system, prompt.user, 8192, undefined, profileDocuments, [WEB_SEARCH_TOOL]);
    rawFiles["gap-analysis.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
    parsedData.gapAnalysis = result;
    await callbacks.updateParsedData(parsedData);
  }

  // Phase 2: Screening Debate
  if (!rawFiles["screening-debate.md"]) {
    await callbacks.updatePhase("screening-debate");
    const prompt = screeningDebatePrompt(
      members,
      rawFiles["gap-analysis.md"],
      focusArea,
      profile,
      reportPeriodContext || undefined,
      buyListItems
    );
    const result = await callClaude(client, prompt.system, prompt.user, 16384, undefined, profileDocuments, [WEB_SEARCH_TOOL]);
    rawFiles["screening-debate.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
  }

  // Phase 3: Screening Synthesis
  if (!rawFiles["screening-synthesis.md"]) {
    await callbacks.updatePhase("screening-synthesis");
    const prompt = screeningSynthesisPrompt(
      rawFiles["screening-debate.md"],
      rawFiles["gap-analysis.md"],
      profile,
      reportPeriodContext || undefined,
      buyListItems
    );
    const result = await callClaude(client, prompt.system, prompt.user, 8192, undefined, profileDocuments, [WEB_SEARCH_TOOL]);
    rawFiles["screening-synthesis.md"] = result;
    await callbacks.updateRawFiles(rawFiles);
    parsedData.ideas = parseIdeas(result);
    parsedData.raw = result;
    await callbacks.updateParsedData(parsedData);
  }
}

function parseIdeas(raw: string): Array<Record<string, unknown>> {
  const ideas: Array<Record<string, unknown>> = [];
  const ideaBlocks = raw.split(/(?=^## Idea\s+\d+)/mi);

  for (const block of ideaBlocks) {
    const titleMatch = block.match(/^## Idea\s+\d+:\s*(.+)$/mi);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    const getSection = (name: string): string => {
      const pattern = new RegExp(`### ${name}\\s*\\n([\\s\\S]*?)(?=### |$)`, "i");
      const match = block.match(pattern);
      return match ? match[1].trim() : "";
    };
    const getBulletList = (name: string): string[] => {
      const text = getSection(name);
      return text
        .split("\n")
        .filter((l) => /^[-*]\s/.test(l.trim()))
        .map((l) => l.trim().replace(/^[-*]\s*/, ""));
    };
    const getNumberedList = (name: string): string[] => {
      const text = getSection(name);
      return text
        .split("\n")
        .filter((l) => /^\d+\.\s/.test(l.trim()))
        .map((l) => l.trim().replace(/^\d+\.\s*/, ""));
    };

    ideas.push({
      title,
      thesis: getSection("Thesis"),
      sector: getSection("Sector"),
      loanType: getSection("Loan Type"),
      riskLevel: getSection("Risk Level"),
      expectedSpread: getSection("Expected Spread"),
      rationale: getSection("Rationale"),
      keyRisks: getBulletList("Key Risks"),
      implementationSteps: getNumberedList("Implementation Steps"),
    });
  }

  return ideas;
}
