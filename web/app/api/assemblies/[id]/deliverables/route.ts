import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { getApiKeyForUser, claimTrialInteraction } from "@/lib/trial";
import { deliverableEvolutionPrompt } from "@/worker/prompts";
import type { Topic, Deliverable, FollowUpInsight } from "@/lib/types";
import { getAssemblyAccess } from "@/lib/assembly-access";

export async function POST(
  _request: NextRequest,
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

  const assemblies = await query<{
    raw_files: Record<string, string>;
    parsed_data: Topic;
    topic_input: string;
  }>(
    "SELECT raw_files, parsed_data, topic_input FROM assemblies WHERE id = $1",
    [assemblyId]
  );

  if (!assemblies.length) {
    return NextResponse.json({ error: "Assembly not found" }, { status: 404 });
  }

  const { raw_files, parsed_data, topic_input } = assemblies[0];

  const insightRows = await query<{ id: string; insight: FollowUpInsight }>(
    `SELECT id, insight FROM follow_ups
     WHERE assembly_id = $1 AND insight->>'hasInsight' = 'true'
     ORDER BY created_at ASC`,
    [assemblyId]
  );

  if (insightRows.length === 0) {
    return NextResponse.json(
      { error: "No insights available to evolve from" },
      { status: 400 }
    );
  }

  const currentDeliverables = parsed_data.deliverables || [];
  const latestVersion = currentDeliverables.length;
  const latestDeliverable = currentDeliverables[latestVersion - 1];

  if (!latestDeliverable) {
    return NextResponse.json({ error: "No existing deliverable to evolve" }, { status: 400 });
  }

  const synthesis = raw_files["synthesis.md"] || "";
  const insightSummaries = insightRows.map((r) => r.insight.summary);
  const insightIds = insightRows.map((r) => r.id);

  const prompt = deliverableEvolutionPrompt(
    topic_input,
    latestDeliverable.content,
    insightSummaries,
    synthesis
  );

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

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return NextResponse.json(
      { error: "Anthropic API error", details: errorText },
      { status: response.status }
    );
  }

  const data = await response.json();
  const evolvedContent = data.content?.[0]?.text;
  if (!evolvedContent) {
    return NextResponse.json({ error: "Empty response from API" }, { status: 500 });
  }

  const newVersion = latestVersion + 1;
  const newDeliverable: Deliverable = {
    slug: `deliverable-v${newVersion}`,
    title: `${latestDeliverable.title} (v${newVersion})`,
    content: evolvedContent,
    version: newVersion,
    createdAt: new Date().toISOString(),
    basedOnInsights: insightIds,
  };

  const fileKey = `deliverable-v${newVersion}.md`;
  const updatedRawFiles = { ...raw_files, [fileKey]: evolvedContent };
  const updatedDeliverables = [...currentDeliverables, newDeliverable];

  // Tag v1 if not already versioned
  if (updatedDeliverables[0] && !updatedDeliverables[0].version) {
    updatedDeliverables[0] = {
      ...updatedDeliverables[0],
      version: 1,
    };
  }

  const updatedParsedData = {
    ...parsed_data,
    deliverables: updatedDeliverables,
  };

  await query(
    "UPDATE assemblies SET raw_files = $1, parsed_data = $2 WHERE id = $3",
    [JSON.stringify(updatedRawFiles), JSON.stringify(updatedParsedData), assemblyId]
  );

  return NextResponse.json({ deliverable: newDeliverable, version: newVersion });
}
