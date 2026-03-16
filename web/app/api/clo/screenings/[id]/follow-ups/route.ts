import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { decryptApiKey } from "@/lib/crypto";
import { verifyScreeningAccess } from "@/lib/clo/access";
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

function buildScreeningFollowUpPrompt(
  question: string,
  mode: string,
  targetMember: string | undefined,
  screening: {
    focus_area: string;
    parsed_data: Record<string, unknown>;
  },
  members: PanelMember[],
  profile: FullProfile,
  buyListContext?: string
): string {
  const gapAnalysis = (screening.parsed_data?.gapAnalysis as string) || "";
  const ideas = (screening.parsed_data?.ideas as Array<Record<string, unknown>>) || [];

  const ideasSummary = ideas.map((idea, i) =>
    `${i + 1}. **${idea.title}** (${idea.sector || "N/A"}, ${idea.riskLevel || "N/A"} risk)\n   ${idea.thesis}`
  ).join("\n");

  const memberProfiles = members
    .map(
      (m) =>
        `**${m.name}** (${m.role}): ${m.background}\nSpecializations: ${m.specializations.join(", ")}\nRisk personality: ${m.riskPersonality}`
    )
    .join("\n\n");

  const constraints = profile.extracted_constraints || {};
  const constraintsSection = Object.keys(constraints).length > 0
    ? `\nEXTRACTED VEHICLE CONSTRAINTS:\n${JSON.stringify(constraints, null, 2)}\n`
    : "";

  let modeInstruction = "";
  if (mode === "analyst") {
    modeInstruction = `Respond as a single senior CLO credit analyst. Speak in one authoritative voice — no panel member personas. Be direct, compliance-aware, and always ground your response in this CLO's specific constraints and portfolio context.`;
  } else if (mode === "ask-member" && targetMember) {
    const member = members.find((m) => m.name === targetMember);
    modeInstruction = `Respond ONLY as ${targetMember}. ${member ? `Role: ${member.role}. Specializations: ${member.specializations.join(", ")}. Investment philosophy: ${member.investmentPhilosophy}.` : ""}`;
  } else if (mode === "debate") {
    modeInstruction = `Run a structured debate among 3-4 panel members most relevant to the question. Each member should take a clear position, then challenge each other directly. End with a synthesis of convergence and divergence.`;
  } else {
    modeInstruction = `Respond as the full panel. Choose 2-4 members most relevant to the question. Each should give their perspective, with specific reasoning. Members may agree or disagree.`;
  }

  return `You are an AI credit analysis panel conducting follow-up discussion on a portfolio screening.

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

PORTFOLIO SCREENING${screening.focus_area ? ` — Focus: ${screening.focus_area}` : ""}

CONTEXT (prior screening results):
${gapAnalysis ? `PORTFOLIO GAP ANALYSIS:\n${gapAnalysis}\n` : ""}
${ideasSummary ? `LOAN OPPORTUNITIES IDENTIFIED:\n${ideasSummary}\n` : ""}

MODE: ${modeInstruction}

FORMAT:
${mode === "analyst" ? "Respond in a single authoritative voice. Lead with the conclusion, then supporting analysis. Show compliance impact math when relevant." : "Start each member's response with their full name in bold: **Name:** followed by their response."}
Be substantive and specific. Reference the screening results where relevant.
Answer the question directly -- no throat-clearing or framework restatement.

QUALITY RULES:
- SOURCE HONESTY: Never fabricate data, studies, statistics, or citations. If you don't have hard data, say "based on professional judgment" or "in my experience."
- STAY ON THE QUESTION: >80% of your response must directly address what was asked. No preamble, no framework restatement unless it changes the answer.
- PRACTICAL OUTPUT: This is for real credit decisions. Be specific, actionable, and concrete.
- PLAINTEXT TEST: If you strip all jargon from a sentence and it says nothing, delete it.
- WEB SEARCH: You have web search available. Use it to verify claims, check recent news about sectors, and find current market data. Cite sources.
${mode !== "analyst" ? "- Each panel member must stay in character with their established philosophy and risk personality." : ""}`;
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
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const hasAccess = await verifyScreeningAccess(id, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const followUps = await query(
    "SELECT * FROM clo_follow_ups WHERE screening_id = $1 ORDER BY created_at ASC",
    [id]
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

  const hasAccess = await verifyScreeningAccess(id, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { question, mode, targetMember, history } = body;

  if (!question || !mode) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const screenings = await query<{
    focus_area: string;
    panel_id: string;
    parsed_data: Record<string, unknown>;
  }>(
    "SELECT focus_area, panel_id, parsed_data FROM clo_screenings WHERE id = $1",
    [id]
  );

  if (screenings.length === 0) {
    return NextResponse.json({ error: "Screening not found" }, { status: 404 });
  }

  const screening = screenings[0];

  const panels = await query<{
    members: PanelMember[];
    profile_id: string;
  }>(
    "SELECT members, profile_id FROM clo_panels WHERE id = $1",
    [screening.panel_id]
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

  const members = (panels[0].members || []) as PanelMember[];
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
    buildScreeningFollowUpPrompt(question, mode, targetMember, screening, members, profile, buyListCtx || undefined) +
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
          `INSERT INTO clo_follow_ups (screening_id, panel_id, question, mode, target_member, response_md)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, screening.panel_id, question, mode, targetMember || null, fullText]
        );
      } catch (err) {
        console.error("[clo/screening-follow-ups] Failed to persist follow-up:", err);
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
