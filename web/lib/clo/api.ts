import type { CloDocument } from "./types";
import { chunkDocuments, MAX_PDF_PAGES } from "./pdf-chunking";

interface AnthropicBlock { type: string; text?: string }

export function buildDocumentContent(
  documents: CloDocument[],
  userText: string,
): Array<Record<string, unknown>> {
  return [
    ...documents.map((doc) => {
      if (doc.type === "application/pdf") {
        return {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: doc.base64 },
        };
      }
      return {
        type: "image",
        source: { type: "base64", media_type: doc.type, data: doc.base64 },
      };
    }),
    { type: "text", text: userText },
  ];
}

export async function callAnthropic(
  apiKey: string,
  system: string,
  content: Array<Record<string, unknown>>,
  maxTokens: number,
): Promise<{ text: string; truncated: boolean; error?: string; status?: number }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    return { text: "", truncated: false, error: await response.text(), status: response.status };
  }

  const result = await response.json();
  const text = result.content
    ?.filter((block: AnthropicBlock) => block.type === "text")
    ?.map((block: AnthropicBlock) => block.text)
    ?.join("\n") || "";
  const truncated = result.stop_reason !== "end_turn";

  return { text, truncated };
}

export function parseJsonResponse(text: string): Record<string, unknown> {
  // Find the outermost JSON object, handling nested braces correctly
  const start = text.indexOf("{");
  if (start === -1) return {};

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  return {};
}

export async function callAnthropicChunked(
  apiKey: string,
  system: string,
  documents: CloDocument[],
  userText: string,
  maxTokens: number,
): Promise<{ results: { text: string; truncated: boolean; chunkLabel: string }[]; error?: string; status?: number }> {
  const chunkSets = await chunkDocuments(documents);

  if (chunkSets.length === 1) {
    const content = buildDocumentContent(chunkSets[0].documents, userText);
    const result = await callAnthropic(apiKey, system, content, maxTokens);
    if (result.error && result.error.includes("prompt is too long")) {
      // Single chunk too large — re-chunk with halved page limit
      return callAnthropicChunkedWithLimit(apiKey, system, documents, userText, maxTokens, Math.floor(MAX_PDF_PAGES / 2));
    }
    if (result.error) return { results: [], error: result.error, status: result.status };
    return { results: [{ text: result.text, truncated: result.truncated, chunkLabel: chunkSets[0].chunkLabel }] };
  }

  const chunkResults = await Promise.all(
    chunkSets.map(async (chunkSet) => {
      const chunkUserText = `[NOTE: This document has been split due to size. You are viewing ${chunkSet.chunkLabel}. Extract all information from these pages.]\n\n${userText}`;
      const content = buildDocumentContent(chunkSet.documents, chunkUserText);
      const result = await callAnthropic(apiKey, system, content, maxTokens);
      return { ...result, chunkLabel: chunkSet.chunkLabel };
    }),
  );

  const promptTooLong = chunkResults.some((r) => r.error?.includes("prompt is too long"));
  if (promptTooLong) {
    // At least one chunk was too large — retry everything with halved page limit
    return callAnthropicChunkedWithLimit(apiKey, system, documents, userText, maxTokens, Math.floor(MAX_PDF_PAGES / 2));
  }

  const firstError = chunkResults.find((r) => r.error);
  if (firstError && chunkResults.every((r) => r.error)) {
    return { results: [], error: firstError.error, status: firstError.status };
  }

  return {
    results: chunkResults
      .filter((r) => !r.error)
      .map((r) => ({ text: r.text, truncated: r.truncated, chunkLabel: r.chunkLabel })),
  };
}

async function callAnthropicChunkedWithLimit(
  apiKey: string,
  system: string,
  documents: CloDocument[],
  userText: string,
  maxTokens: number,
  pageLimit: number,
): Promise<{ results: { text: string; truncated: boolean; chunkLabel: string }[]; error?: string; status?: number }> {
  console.log(`[callAnthropicChunked] Retrying with reduced page limit: ${pageLimit}`);
  const chunkSets = await chunkDocuments(documents, pageLimit);

  const chunkResults = await Promise.all(
    chunkSets.map(async (chunkSet) => {
      const chunkUserText = chunkSets.length > 1
        ? `[NOTE: This document has been split due to size. You are viewing ${chunkSet.chunkLabel}. Extract all information from these pages.]\n\n${userText}`
        : userText;
      const content = buildDocumentContent(chunkSet.documents, chunkUserText);
      const result = await callAnthropic(apiKey, system, content, maxTokens);
      return { ...result, chunkLabel: chunkSet.chunkLabel };
    }),
  );

  const firstError = chunkResults.find((r) => r.error);
  if (firstError && chunkResults.every((r) => r.error)) {
    return { results: [], error: firstError.error, status: firstError.status };
  }

  return {
    results: chunkResults
      .filter((r) => !r.error)
      .map((r) => ({ text: r.text, truncated: r.truncated, chunkLabel: r.chunkLabel })),
  };
}

export function normalizeClassName(name: string): string {
  return name
    .replace(/^class\s+/i, "")
    .replace(/[\s-]+/g, "-")
    .toUpperCase();
}
