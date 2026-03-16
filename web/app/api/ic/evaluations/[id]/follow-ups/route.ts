import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { decryptApiKey } from "@/lib/crypto";
import { verifyEvaluationAccess } from "@/lib/ic/access";
import type { CommitteeMember } from "@/lib/ic/types";
import { WEB_SEARCH_TOOL, processAnthropicStream } from "@/lib/claude-stream";
import { getLatestBriefing } from "@/lib/briefing";

function buildFollowUpPrompt(
  question: string,
  mode: string,
  targetMember: string | undefined,
  evaluation: {
    title: string;
    thesis: string;
    raw_files: Record<string, string>;
    parsed_data: Record<string, unknown>;
  },
  members: CommitteeMember[],
  profile: { investment_philosophy: string; risk_tolerance: string }
): string {
  const memoContent = evaluation.raw_files?.["memo.md"] || "";
  const riskContent = evaluation.raw_files?.["risk-assessment.md"] || "";
  const debateContent = evaluation.raw_files?.["debate.md"] || "";
  const recommendationContent = evaluation.raw_files?.["recommendation.md"] || "";

  const memberProfiles = members
    .map(
      (m) =>
        `**${m.name}** (${m.role}): ${m.background}\nSpecializations: ${m.specializations.join(", ")}\nRisk personality: ${m.riskPersonality}`
    )
    .join("\n\n");

  let modeInstruction = "";
  if (mode === "ask-member" && targetMember) {
    const member = members.find((m) => m.name === targetMember);
    modeInstruction = `Respond ONLY as ${targetMember}. ${member ? `Role: ${member.role}. Specializations: ${member.specializations.join(", ")}. Investment philosophy: ${member.investmentPhilosophy}.` : ""}`;
  } else if (mode === "debate") {
    modeInstruction = `Run a structured debate among 3-4 committee members most relevant to the question. Each member should take a clear position, then challenge each other directly. End with a synthesis of convergence and divergence.`;
  } else {
    modeInstruction = `Respond as the full committee. Choose 2-4 members most relevant to the question. Each should give their perspective, with specific reasoning. Members may agree or disagree.`;
  }

  return `You are an AI investment committee conducting follow-up analysis.

INVESTOR PROFILE:
Philosophy: ${profile.investment_philosophy}
Risk tolerance: ${profile.risk_tolerance}

COMMITTEE MEMBERS:
${memberProfiles}

EVALUATION: ${evaluation.title}
Thesis: ${evaluation.thesis}

CONTEXT (prior analysis):
${memoContent ? `MEMO:\n${memoContent}\n` : ""}
${riskContent ? `RISK ASSESSMENT:\n${riskContent}\n` : ""}
${debateContent ? `DEBATE:\n${debateContent}\n` : ""}
${recommendationContent ? `RECOMMENDATION:\n${recommendationContent}\n` : ""}

MODE: ${modeInstruction}

FORMAT:
Start each member's response with their full name in bold: **Name:** followed by their response.
Be substantive and specific. Reference the prior analysis where relevant.
Answer the question directly -- no throat-clearing or framework restatement.

QUALITY RULES:
- SOURCE HONESTY: Never fabricate data, studies, statistics, or citations. If you don't have hard data, say "based on professional judgment" or "in my experience."
- STAY ON THE QUESTION: >80% of your response must directly address what was asked. No preamble, no framework restatement unless it changes the answer.
- PRACTICAL OUTPUT: This is for real investment decisions. Be specific, actionable, and concrete.
- PLAINTEXT TEST: If you strip all jargon from a sentence and it says nothing, delete it.
- Each committee member must stay in character with their established philosophy and risk personality.
- WEB SEARCH: You have web search available. Use it to verify claims, check recent news about companies or sectors, and find current market data. Cite sources.`;
}

function buildMessages(
  history: { role: string; content: string }[] | undefined,
  question: string
): { role: "user" | "assistant"; content: string }[] {
  if (!history || history.length === 0) {
    return [{ role: "user", content: question }];
  }

  // Client sends prior history without the current question
  const capped = history.slice(-10);
  const startIdx = capped.findIndex((m) => m.role === "user");
  const trimmed = startIdx >= 0 ? capped.slice(startIdx) : capped;

  const messages: { role: "user" | "assistant"; content: string }[] = trimmed.map((m) => ({
    role: m.role === "assistant" ? "assistant" as const : "user" as const,
    content: m.content,
  }));

  // Always append the current question as the terminal user message
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

  const hasAccess = await verifyEvaluationAccess(id, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const followUps = await query(
    "SELECT * FROM ic_follow_ups WHERE evaluation_id = $1 ORDER BY created_at ASC",
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

  const hasAccess = await verifyEvaluationAccess(id, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { question, mode, targetMember, history } = body;

  if (!question || !mode) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const evaluations = await query<{
    title: string;
    thesis: string;
    committee_id: string;
    raw_files: Record<string, string>;
    parsed_data: Record<string, unknown>;
    dynamic_specialists: CommitteeMember[];
  }>(
    "SELECT title, thesis, committee_id, raw_files, parsed_data, dynamic_specialists FROM ic_evaluations WHERE id = $1",
    [id]
  );

  if (evaluations.length === 0) {
    return NextResponse.json({ error: "Evaluation not found" }, { status: 404 });
  }

  const evaluation = evaluations[0];

  const committees = await query<{
    members: CommitteeMember[];
    profile_id: string;
  }>(
    "SELECT members, profile_id FROM ic_committees WHERE id = $1",
    [evaluation.committee_id]
  );

  if (committees.length === 0) {
    return NextResponse.json({ error: "Committee not found" }, { status: 404 });
  }

  const profiles = await query<{
    investment_philosophy: string;
    risk_tolerance: string;
  }>(
    "SELECT investment_philosophy, risk_tolerance FROM investor_profiles WHERE id = $1",
    [committees[0].profile_id]
  );

  // Merge standing committee with any dynamic specialists from this evaluation
  const standingMembers = (committees[0].members || []) as CommitteeMember[];
  const dynamicSpecialists = (evaluation.dynamic_specialists || []) as CommitteeMember[];
  const members = [...standingMembers, ...dynamicSpecialists];
  const profile = profiles[0] || { investment_philosophy: "", risk_tolerance: "" };

  const briefing = await getLatestBriefing();
  const briefingSection = briefing
    ? `\n\nMARKET INTELLIGENCE (today's briefing — reference when relevant, do not repeat verbatim):\n${briefing}`
    : "";
  const systemPrompt =
    buildFollowUpPrompt(question, mode, targetMember, evaluation, members, profile) +
    briefingSection;

  const userRows = await query<{ encrypted_api_key: Buffer; api_key_iv: Buffer }>(
    "SELECT encrypted_api_key, api_key_iv FROM users WHERE id = $1",
    [user.id]
  );

  if (!userRows.length || !userRows[0].encrypted_api_key) {
    return NextResponse.json({ error: "No API key configured" }, { status: 400 });
  }

  const apiKey = decryptApiKey(userRows[0].encrypted_api_key, userRows[0].api_key_iv);

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
      messages: buildMessages(history, question),
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
          `INSERT INTO ic_follow_ups (evaluation_id, question, mode, target_member, response_md)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, question, mode, targetMember || null, fullText]
        );
      } catch (err) {
        console.error("[ic/follow-ups] Failed to persist follow-up:", err);
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
