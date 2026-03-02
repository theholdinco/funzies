import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { decryptApiKey } from "@/lib/crypto";
import { getProfileForUser, getProfileWithDocuments, getPanelForUser, rowToProfile, getDealForProfile, getLatestReportPeriod, getReportPeriodData, getEvents, getOverflow } from "@/lib/clo/access";
import { seniorAnalystSystemPrompt, formatReportPeriodState } from "@/worker/clo-prompts";
import { getPortfolioSnapshot, getRecentAnalysisBriefs } from "@/lib/clo/history";
import { WEB_SEARCH_TOOL, processAnthropicStream } from "@/lib/claude-stream";
import { getLatestBriefing } from "@/lib/briefing";
import { fitDocumentsToPageLimit } from "@/lib/clo/pdf-chunking";

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const conversations = await query<{
    id: string;
    messages: unknown[];
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, messages, created_at, updated_at
     FROM clo_conversations
     WHERE profile_id = $1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [profile.id]
  );

  return NextResponse.json(conversations[0] || null);
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const panel = await getPanelForUser(user.id);

  const body = await request.json();
  const { message, conversationId } = body;

  if (!message) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  const userRows = await query<{ encrypted_api_key: Buffer; api_key_iv: Buffer }>(
    "SELECT encrypted_api_key, api_key_iv FROM users WHERE id = $1",
    [user.id]
  );

  if (!userRows.length || !userRows[0].encrypted_api_key) {
    return NextResponse.json({ error: "No API key configured" }, { status: 400 });
  }

  const apiKey = decryptApiKey(userRows[0].encrypted_api_key, userRows[0].api_key_iv);

  // Load or create conversation
  let existingMessages: { role: string; content: string; timestamp: string }[] = [];
  let convId = conversationId;

  if (convId) {
    const convRows = await query<{ messages: typeof existingMessages }>(
      "SELECT messages FROM clo_conversations WHERE id = $1 AND profile_id = $2",
      [convId, profile.id]
    );
    if (convRows.length > 0) {
      existingMessages = convRows[0].messages || [];
    }
  }

  // Build portfolio snapshot and recent analysis briefs
  const portfolioSnapshot = panel ? await getPortfolioSnapshot(panel.id) : "";
  const analysisBriefs = panel ? await getRecentAnalysisBriefs(panel.id) : "";

  // Convert raw DB row to CloProfile type
  const cloProfile = rowToProfile(profile as unknown as Record<string, unknown>);

  // Fetch new extraction data for richer context
  const deal = await getDealForProfile(cloProfile.id);
  let reportPeriodContext = "";
  if (deal) {
    const latestPeriod = await getLatestReportPeriod(deal.id);
    if (latestPeriod) {
      const { poolSummary, complianceTests, concentrations } = await getReportPeriodData(latestPeriod.id);
      const periodEvents = await getEvents(deal.id);
      const overflow = await getOverflow(latestPeriod.id);
      reportPeriodContext = formatReportPeriodState(poolSummary, complianceTests, concentrations, periodEvents, overflow);
    }
  }

  // Build system prompt with market intelligence and analysis context
  const briefing = await getLatestBriefing();
  const briefingSection = briefing
    ? `\n\nMARKET INTELLIGENCE (today's briefing — reference when relevant, do not repeat verbatim):\n${briefing}`
    : "";
  const analysisSection = analysisBriefs
    ? `\n\nRECENT ANALYSIS CONCLUSIONS (reference when the user asks about specific credits):\n${analysisBriefs}`
    : "";
  const systemPrompt =
    seniorAnalystSystemPrompt(cloProfile, portfolioSnapshot, reportPeriodContext || undefined) + analysisSection + briefingSection;

  // Only fetch heavy document data on the first turn of a conversation
  // to avoid pulling 20MB+ from the DB on every subsequent message.
  let documents: Array<{ name: string; type: string; base64: string }> = [];
  if (existingMessages.length === 0) {
    const fullProfile = await getProfileWithDocuments(user.id);
    const rawDocs = (fullProfile?.documents as typeof documents) || [];
    // Use a lower page limit for chat — the system prompt, conversation
    // history, and tool definitions consume significant tokens alongside the PDFs.
    documents = await fitDocumentsToPageLimit(rawDocs, 50);
  }
  const claudeMessages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }> = [];

  // Add prior conversation history (capped to last 20 messages)
  const recentHistory = existingMessages.slice(-20);
  for (const msg of recentHistory) {
    claudeMessages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    });
  }

  // Add current user message
  claudeMessages.push({ role: "user", content: message });

  // Inject documents only on the first turn (no prior history) to avoid
  // resending 20MB+ of base64 on every subsequent turn. The system prompt
  // already contains the CLO's extracted constraints and portfolio snapshot,
  // so the AI retains full context even without re-reading the raw PDFs.
  if (documents.length > 0 && existingMessages.length === 0) {
    const firstUserIdx = claudeMessages.findIndex((m) => m.role === "user");
    if (firstUserIdx >= 0) {
      const docBlocks = documents.map((doc: { type: string; base64: string }) => {
        if (doc.type === "application/pdf") {
          return {
            type: "document" as const,
            source: { type: "base64" as const, media_type: "application/pdf" as const, data: doc.base64 },
          };
        }
        return {
          type: "image" as const,
          source: { type: "base64" as const, media_type: doc.type, data: doc.base64 },
        };
      });
      const originalContent = claudeMessages[firstUserIdx].content as string;
      claudeMessages[firstUserIdx].content = [
        ...docBlocks,
        { type: "text" as const, text: originalContent },
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
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: systemPrompt,
      messages: claudeMessages,
      stream: true,
      tools: [WEB_SEARCH_TOOL],
    }),
  });

  if (!anthropicResponse.ok) {
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
    const errorText = await anthropicResponse.text();
    if (errorText.includes("prompt is too long")) {
      return NextResponse.json(
        { error: "The uploaded documents are too large for a single request. Please try with fewer or smaller documents." },
        { status: 400 }
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

      // Persist conversation
      try {
        const now = new Date().toISOString();
        const updatedMessages = [
          ...existingMessages,
          { role: "user", content: message, timestamp: now },
          { role: "assistant", content: fullText, timestamp: now },
        ];

        if (convId) {
          await query(
            `UPDATE clo_conversations SET messages = $1::jsonb, updated_at = now() WHERE id = $2`,
            [JSON.stringify(updatedMessages), convId]
          );
        } else {
          const newConv = await query<{ id: string }>(
            `INSERT INTO clo_conversations (profile_id, messages) VALUES ($1, $2::jsonb) RETURNING id`,
            [profile.id, JSON.stringify(updatedMessages)]
          );
          convId = newConv[0]?.id;
        }
      } catch (err) {
        console.error("[clo/chat] Failed to persist conversation:", err);
      }

      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "done", conversationId: convId })}\n\n`)
      );
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
