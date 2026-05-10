import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { decryptApiKey } from "@/lib/crypto";
import { verifyPanelAccess } from "@/lib/clo/access";
import { processAnthropicStream } from "@/lib/claude-stream";

function prioritizeScheduleSummary(dealContext: unknown): unknown {
  if (
    !dealContext ||
    typeof dealContext !== "object" ||
    Array.isArray(dealContext) ||
    !("assetInterestScheduleSummary" in dealContext)
  ) {
    return dealContext;
  }

  const { assetInterestScheduleSummary, ...rest } = dealContext as Record<string, unknown>;
  return { assetInterestScheduleSummary, ...rest };
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { panelId, dealContext } = body;

  if (!panelId) {
    return NextResponse.json({ error: "Missing panelId" }, { status: 400 });
  }

  const hasAccess = await verifyPanelAccess(panelId, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const userRows = await query<{ encrypted_api_key: Buffer; api_key_iv: Buffer }>(
    "SELECT encrypted_api_key, api_key_iv FROM users WHERE id = $1",
    [user.id]
  );

  if (!userRows.length || !userRows[0].encrypted_api_key) {
    return NextResponse.json({ error: "No API key configured" }, { status: 400 });
  }

  const apiKey = decryptApiKey(userRows[0].encrypted_api_key, userRows[0].api_key_iv);

  const systemPrompt = `You are a CLO analyst. Given a deal's data, suggest 2-3 projection scenarios for waterfall modeling.

Scenarios should include:
1. Base Case — moderate assumptions reflecting current market conditions
2. Stress Case — elevated defaults and reduced recoveries
3. Upside Case (optional) — favorable conditions

For each scenario, provide specific values for:
- cdrPct: annual constant default rate (0-10%)
- cprPct: annual conditional prepayment rate (0-30%)
- recoveryPct: recovery rate on defaults (0-80%)
- recoveryLagMonths: months until recoveries are received (0-24)
- reinvestmentSpreadBps: spread on new reinvestments (0-500 bps)

Output a JSON array of scenarios. Each must have:
- "name": scenario name
- "cdrPct": number
- "cprPct": number
- "recoveryPct": number
- "recoveryLagMonths": number
- "reinvestmentSpreadBps": number
- "reasoning": 1-2 sentence explanation of why these assumptions are appropriate

Only output the JSON array, nothing else.`;

  const contextSummary = JSON.stringify(prioritizeScheduleSummary(dealContext), null, 2).slice(0, 6000);

  const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Suggest projection scenarios for this CLO deal:\n\n${contextSummary}` }],
      stream: true,
    }),
  });

  if (!anthropicResponse.ok) {
    const errorText = await anthropicResponse.text();
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
      await processAnthropicStream(reader, controller, encoder);
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
