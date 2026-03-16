import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { decryptApiKey } from "@/lib/crypto";
import { verifyPanelAccess } from "@/lib/clo/access";
import { getBuyListForProfile, formatBuyList } from "@/lib/clo/buy-list";
import type { PanelMember } from "@/lib/clo/types";
import { WEB_SEARCH_TOOL, processAnthropicStream } from "@/lib/claude-stream";
import { getLatestBriefing } from "@/lib/briefing";
import { fitDocumentsToPageLimit } from "@/lib/clo/pdf-chunking";

interface FullProfile {
  fund_strategy: string;
  risk_appetite: string;
  target_sectors: string;
  concentration_limits: string;
  rating_thresholds: string;
  spread_targets: string;
  reinvestment_period: string;
  portfolio_description: string;
  beliefs_and_biases: string;
  extracted_constraints: Record<string, unknown>;
  documents: Array<{ name: string; type: string; base64: string }>;
}

function buildPanelFollowUpPrompt(
  question: string,
  mode: string,
  targetMember: string | undefined,
  members: PanelMember[],
  profile: FullProfile,
  analysis?: {
    title: string;
    borrower_name: string;
    raw_files: Record<string, string>;
  },
  buyListContext?: string
): string {
  const memberProfiles = members
    .map(
      (m) =>
        `**${m.name}** (${m.role}): ${m.background}\nSpecializations: ${m.specializations.join(", ")}\nRisk personality: ${m.riskPersonality}\nInvestment philosophy: ${m.investmentPhilosophy}`
    )
    .join("\n\n");

  const constraints = profile.extracted_constraints || {};
  const constraintsSection = Object.keys(constraints).length > 0
    ? `\nEXTRACTED VEHICLE CONSTRAINTS:\n${JSON.stringify(constraints, null, 2)}\n`
    : "";

  let modeInstruction = "";
  if (mode === "ask-member" && targetMember) {
    const member = members.find((m) => m.name === targetMember);
    modeInstruction = `Respond ONLY as ${targetMember}. ${member ? `Role: ${member.role}. Background: ${member.background}. Specializations: ${member.specializations.join(", ")}. Risk personality: ${member.riskPersonality}. Investment philosophy: ${member.investmentPhilosophy}.` : ""}`;
  } else if (mode === "debate") {
    modeInstruction = `Run a structured debate among 3-4 panel members most relevant to the question. Each member should take a clear position, then challenge each other directly. End with a synthesis of convergence and divergence.`;
  } else {
    modeInstruction = `Respond as the full panel. Choose 2-4 members most relevant to the question. Each should give their perspective, with specific reasoning. Members may agree or disagree.`;
  }

  let analysisSection = "";
  if (analysis) {
    const memoContent = analysis.raw_files?.["memo.md"] || "";
    const riskContent = analysis.raw_files?.["risk-assessment.md"] || "";
    const debateContent = analysis.raw_files?.["debate.md"] || "";
    const recommendationContent = analysis.raw_files?.["recommendation.md"] || "";

    analysisSection = `\nCREDIT ANALYSIS: ${analysis.title}
Borrower: ${analysis.borrower_name}

CONTEXT (prior analysis):
${memoContent ? `CREDIT MEMO:\n${memoContent}\n` : ""}
${riskContent ? `RISK ASSESSMENT:\n${riskContent}\n` : ""}
${debateContent ? `DEBATE:\n${debateContent}\n` : ""}
${recommendationContent ? `RECOMMENDATION:\n${recommendationContent}\n` : ""}`;
  }

  return `You are an AI credit analysis panel conducting follow-up discussion.

CLO PORTFOLIO PROFILE:
Fund strategy: ${profile.fund_strategy}
Risk appetite: ${profile.risk_appetite}
Target sectors: ${profile.target_sectors || "Not specified"}
Concentration limits: ${profile.concentration_limits || "Not specified"}
Rating thresholds: ${profile.rating_thresholds || "Not specified"}
Spread targets: ${profile.spread_targets || "Not specified"}
Reinvestment period: ${profile.reinvestment_period || "Not specified"}
Portfolio description: ${profile.portfolio_description || "Not specified"}
Beliefs & biases: ${profile.beliefs_and_biases || "Not specified"}
${constraintsSection}${buyListContext ? `\nBUY LIST CONTEXT:\n${buyListContext}\n` : ""}
PANEL MEMBERS:
${memberProfiles}
${analysisSection}
MODE: ${modeInstruction}

FORMAT:
Start each member's response with their full name in bold: **Name:** followed by their response.
Be substantive and specific.${analysis ? " Reference the prior analysis where relevant." : ""}
Answer the question directly -- no throat-clearing or framework restatement.

QUALITY RULES:
- SOURCE HONESTY: Never fabricate data, studies, statistics, or citations. If you don't have hard data, say "based on professional judgment" or "in my experience."
- STAY ON THE QUESTION: >80% of your response must directly address what was asked. No preamble, no framework restatement unless it changes the answer.
- PRACTICAL OUTPUT: This is for real credit decisions. Be specific, actionable, and concrete.
- PLAINTEXT TEST: If you strip all jargon from a sentence and it says nothing, delete it.
- WEB SEARCH: You have web search available. Use it to verify claims, check recent news about borrowers or sectors, and find current market data. Cite sources.
- Each panel member must stay in character with their established philosophy and risk personality.`;
}

function buildMessages(
  history: { role: string; content: string }[] | undefined,
  question: string
): { role: "user" | "assistant"; content: string }[] {
  if (!history || history.length === 0) {
    return [{ role: "user", content: question }];
  }

  const capped = history.slice(-10);
  const startIdx = capped.findIndex((m) => m.role === "user");
  const trimmed = startIdx >= 0 ? capped.slice(startIdx) : capped;

  const messages: { role: "user" | "assistant"; content: string }[] = trimmed.map((m) => ({
    role: m.role === "assistant" ? "assistant" as const : "user" as const,
    content: m.content,
  }));

  messages.push({ role: "user", content: question });
  return messages;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const hasAccess = await verifyPanelAccess(id, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const targetMember = request.nextUrl.searchParams.get("member");
  const conditions = ["panel_id = $1"];
  const values: (string | null)[] = [id];

  if (targetMember) {
    conditions.push("target_member = $2");
    values.push(targetMember);
  }

  const followUps = await query(
    `SELECT * FROM clo_follow_ups WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`,
    values
  );

  return NextResponse.json(followUps);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const hasAccess = await verifyPanelAccess(id, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { question, mode, targetMember, analysisId, history } = body;

  if (!question || !mode) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const panels = await query<{
    members: PanelMember[];
    profile_id: string;
  }>(
    "SELECT members, profile_id FROM clo_panels WHERE id = $1",
    [id]
  );

  if (panels.length === 0) {
    return NextResponse.json({ error: "Panel not found" }, { status: 404 });
  }

  const profiles = await query<FullProfile>(
    `SELECT fund_strategy, risk_appetite, target_sectors, concentration_limits,
            rating_thresholds, spread_targets, reinvestment_period,
            portfolio_description, beliefs_and_biases,
            extracted_constraints, documents
     FROM clo_profiles WHERE id = $1`,
    [panels[0].profile_id]
  );

  const standingMembers = (panels[0].members || []) as PanelMember[];
  let members = [...standingMembers];

  let analysis: { title: string; borrower_name: string; raw_files: Record<string, string> } | undefined;

  if (analysisId) {
    const analyses = await query<{
      title: string;
      borrower_name: string;
      raw_files: Record<string, string>;
      dynamic_specialists: PanelMember[];
    }>(
      "SELECT title, borrower_name, raw_files, dynamic_specialists FROM clo_analyses WHERE id = $1 AND panel_id = $2",
      [analysisId, id]
    );

    if (analyses.length > 0) {
      analysis = {
        title: analyses[0].title,
        borrower_name: analyses[0].borrower_name,
        raw_files: analyses[0].raw_files,
      };
      const dynamicSpecialists = (analyses[0].dynamic_specialists || []) as PanelMember[];
      members = [...standingMembers, ...dynamicSpecialists];
    }
  }

  const profile: FullProfile = profiles[0] || {
    fund_strategy: "", risk_appetite: "", target_sectors: "",
    concentration_limits: "", rating_thresholds: "", spread_targets: "",
    reinvestment_period: "", portfolio_description: "", beliefs_and_biases: "",
    extracted_constraints: {}, documents: [],
  };

  const buyListItems = await getBuyListForProfile(panels[0].profile_id);
  const buyListCtx = formatBuyList(buyListItems);

  const briefing = await getLatestBriefing();
  const briefingSection = briefing
    ? `\n\nMARKET INTELLIGENCE (today's briefing — reference when relevant, do not repeat verbatim):\n${briefing}`
    : "";
  const systemPrompt =
    buildPanelFollowUpPrompt(question, mode, targetMember, members, profile, analysis, buyListCtx || undefined) +
    briefingSection;

  const userRows = await query<{ encrypted_api_key: Buffer; api_key_iv: Buffer }>(
    "SELECT encrypted_api_key, api_key_iv FROM users WHERE id = $1",
    [user.id]
  );

  if (!userRows.length || !userRows[0].encrypted_api_key) {
    return NextResponse.json({ error: "No API key configured" }, { status: 400 });
  }

  const apiKey = decryptApiKey(userRows[0].encrypted_api_key, userRows[0].api_key_iv);

  const builtMessages = buildMessages(history, question);
  const cloDocuments = await fitDocumentsToPageLimit(profile.documents || []);
  if (cloDocuments.length > 0 && builtMessages.length > 0) {
    const firstUserIdx = builtMessages.findIndex((m) => m.role === "user");
    if (firstUserIdx >= 0) {
      const docBlocks = cloDocuments.map((doc: { type: string; base64: string }) => {
        if (doc.type === "application/pdf") {
          return {
            type: "document" as const,
            source: { type: "base64" as const, media_type: "application/pdf" as const, data: doc.base64 },
          };
        }
        return {
          type: "image" as const,
          source: { type: "base64" as const, media_type: doc.type as "image/jpeg", data: doc.base64 },
        };
      });
      (builtMessages[0] as { role: string; content: unknown }).content = [
        ...docBlocks,
        { type: "text" as const, text: builtMessages[firstUserIdx].content as string },
      ];
    }
  }

  const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: builtMessages,
      stream: true,
      tools: [WEB_SEARCH_TOOL],
    }),
  });

  if (!anthropicResponse.ok) {
    const errorText = await anthropicResponse.text();
    if (anthropicResponse.status === 401) {
      return NextResponse.json(
        { error: "Your API key is invalid or expired. Please update it in Settings." },
        { status: 401 }
      );
    }
    if (anthropicResponse.status === 429) {
      return NextResponse.json(
        { error: "Rate limited. Please wait a moment and try again." },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: "API error", details: errorText },
      { status: anthropicResponse.status }
    );
  }

  const reader = anthropicResponse.body?.getReader();
  if (!reader) {
    return NextResponse.json({ error: "No response stream" }, { status: 500 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const fullText = await processAnthropicStream(reader, controller, encoder);

      try {
        await query(
          `INSERT INTO clo_follow_ups (panel_id, analysis_id, question, mode, target_member, response_md)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, analysisId || null, question, mode, targetMember || null, fullText]
        );
      } catch (err) {
        console.error("[clo/panel-follow-ups] Failed to persist follow-up:", err);
      }

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
