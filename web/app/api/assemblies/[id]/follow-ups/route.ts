import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { getApiKeyForUser, claimTrialInteraction } from "@/lib/trial";
import { buildPrompt, FollowUpRequest, TopicFiles } from "@/lib/follow-up-prompts";
import { extractInsight } from "@/lib/insight-extraction";
import { getAssemblyAccess } from "@/lib/assembly-access";
import { WEB_SEARCH_TOOL, processAnthropicStream } from "@/lib/claude-stream";

function buildMessages(
  history: { role: string; content: string }[] | undefined,
  question: string
): { role: "user" | "assistant"; content: string }[] {
  if (!history || history.length === 0) {
    return [{ role: "user", content: question }];
  }

  // Client sends prior history without the current question
  const capped = history.slice(-20);

  const startIdx = capped.findIndex((m) => m.role === "user");
  const trimmed = startIdx >= 0 ? capped.slice(startIdx) : capped;

  const messages: { role: "user" | "assistant"; content: string }[] = trimmed.map((m) => ({
    role: m.role === "assistant" ? "assistant" as const : "user" as const,
    content: m.content,
  }));

  messages.push({ role: "user", content: question });
  return messages;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: assemblyId } = await params;

  const access = await getAssemblyAccess(assemblyId, user.id);
  if (!access || access === "read") {
    return NextResponse.json({ error: access ? "Read-only access" : "Not found" }, { status: access ? 403 : 404 });
  }

  const body = await request.json();
  const { question, mode, characters, context, challenge, highlightedText, files, history } = body;

  if (!question || !mode || !context) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const assemblies = await query<{ raw_files: Record<string, string>; parsed_data: unknown }>(
    "SELECT raw_files, parsed_data FROM assemblies WHERE id = $1",
    [assemblyId]
  );

  if (!assemblies.length) {
    return NextResponse.json({ error: "Assembly not found" }, { status: 404 });
  }

  const rawFiles = assemblies[0].raw_files as Record<string, string>;
  const topicFiles: TopicFiles = {
    charactersContent: rawFiles["characters.md"] || "",
    synthesisContent: rawFiles["synthesis.md"] || "",
    referenceLibraryContent: rawFiles["reference-library.md"] || "",
    iterationSyntheses: Object.entries(rawFiles)
      .filter(([k]) => k.includes("iteration") && k.includes("synthesis"))
      .map(([k, v]) => `\n--- ${k} ---\n${v}`)
      .join("\n"),
  };

  const followUpRequest: FollowUpRequest = {
    question,
    mode,
    characters: characters || [],
    context,
    challenge,
    highlightedText,
    files: files || undefined,
  };

  const prompt = buildPrompt(followUpRequest, topicFiles);
  if (!prompt) {
    return NextResponse.json({ error: "Could not build prompt" }, { status: 400 });
  }

  let apiKey: string;
  try {
    const resolved = await getApiKeyForUser(user.id);
    apiKey = resolved.apiKey;
  } catch {
    return NextResponse.json(
      { error: "Please add your API key to continue." },
      { status: 403 }
    );
  }

  // Check trial interaction limits (after key resolution so we don't consume an interaction on failure)
  const assemblyMeta = await query<{ is_free_trial: boolean }>(
    "SELECT is_free_trial FROM assemblies WHERE id = $1",
    [assemblyId]
  );
  if (assemblyMeta.length && assemblyMeta[0].is_free_trial) {
    const result = await claimTrialInteraction(assemblyId);
    if (!result) {
      return NextResponse.json(
        { error: "Free trial interaction limit reached. Add your API key to continue." },
        { status: 403 }
      );
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
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }],
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
        { error: "Rate limited by Anthropic. Please wait a moment and try again." },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: "Anthropic API error", details: errorText },
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

      const insertedRows = await query<{ id: string }>(
        `INSERT INTO follow_ups (id, assembly_id, user_id, question, mode, is_challenge, context_page, context_section, highlighted_text, response_md)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          assemblyId,
          user.id,
          question,
          mode,
          challenge || false,
          context.page,
          context.section || null,
          highlightedText || null,
          fullText,
        ]
      );

      if (insertedRows.length > 0) {
        extractInsight(insertedRows[0].id, assemblyId, apiKey).catch(console.error);
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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: assemblyId } = await params;

  const access = await getAssemblyAccess(assemblyId, user.id);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const followUps = await query(
    "SELECT * FROM follow_ups WHERE assembly_id = $1 ORDER BY created_at DESC",
    [assemblyId]
  );

  return NextResponse.json(followUps);
}
