import type { CloDocument } from "./types";
import { chunkDocuments, MAX_PDF_PAGES } from "./pdf-chunking";

interface AnthropicBlock { type: string; text?: string }

const ANTHROPIC_API_VERSION = "2023-06-01";
const RETRY_DELAYS = [5000, 15000, 30000]; // 3 retries with backoff
const FETCH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — large PDFs need time

// Node's default headersTimeout is 300s which is too short for large PDF processing.
// undici is Node's built-in HTTP client behind fetch.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Agent } = require("undici");
const dispatcher = new Agent({
  headersTimeout: FETCH_TIMEOUT_MS,
  bodyTimeout: FETCH_TIMEOUT_MS,
  connectTimeout: 30_000,
});

async function fetchWithRetry(url: string, init: RequestInit, label?: string): Promise<Response> {
  const bodySize = typeof init.body === "string" ? init.body.length : 0;
  const tag = label ? `[anthropic:${label}]` : "[anthropic]";
  const sizeMB = (bodySize / 1_000_000).toFixed(1);

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const t0 = Date.now();
    try {
      if (attempt === 0) {
        console.log(`${tag} request starting (${sizeMB}MB body)`);
      } else {
        console.log(`${tag} retry attempt ${attempt + 1}/${RETRY_DELAYS.length + 1}`);
      }
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // @ts-expect-error -- undici dispatcher accepted by Node fetch
        dispatcher,
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      // Retry on transient server errors
      if ((response.status >= 500 || response.status === 529) && attempt < RETRY_DELAYS.length) {
        console.log(`${tag} HTTP ${response.status} after ${elapsed}s, retrying in ${RETRY_DELAYS[attempt]}ms`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      console.log(`${tag} HTTP ${response.status} after ${elapsed}s`);
      return response;
    } catch (err) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const e = err as Error & { cause?: unknown; code?: string };
      const cause = e.cause ? ` cause=${e.cause instanceof Error ? e.cause.message : JSON.stringify(e.cause)}` : "";
      const code = e.code ? ` code=${e.code}` : "";
      const msg = `${e.message}${code}${cause}`;
      if (attempt < RETRY_DELAYS.length) {
        console.log(`${tag} FAILED after ${elapsed}s (${sizeMB}MB): ${msg}, retrying in ${RETRY_DELAYS[attempt]}ms`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }
      console.error(`${tag} FAILED after ${elapsed}s (${sizeMB}MB), all retries exhausted: ${msg}`);
      throw err;
    }
  }
  throw new Error("unreachable");
}

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
  label?: string,
): Promise<{ text: string; truncated: boolean; error?: string; status?: number }> {
  const response = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: "user", content }],
    }),
  }, label);

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[anthropic:${label ?? "text"}] API error ${response.status}: ${errText.slice(0, 200)}`);
    return { text: "", truncated: false, error: errText, status: response.status };
  }

  const result = await response.json();
  const text = result.content
    ?.filter((block: AnthropicBlock) => block.type === "text")
    ?.map((block: AnthropicBlock) => block.text)
    ?.join("\n") || "";
  const truncated = result.stop_reason !== "end_turn";
  const inputTokens = result.usage?.input_tokens ?? "?";
  const outputTokens = result.usage?.output_tokens ?? "?";
  console.log(`[anthropic:${label ?? "text"}] OK — ${inputTokens} in / ${outputTokens} out, stop=${result.stop_reason}`);

  return { text, truncated };
}

export async function callAnthropicForText(
  apiKey: string,
  system: string,
  documents: CloDocument[],
  userText: string,
  maxTokens: number,
  label?: string,
): Promise<{ text: string; truncated: boolean; error?: string; status?: number }> {
  const content = buildDocumentContent(documents, userText);
  return callAnthropic(apiKey, system, content, maxTokens, label);
}

export async function callAnthropicWithTool(
  apiKey: string,
  system: string,
  content: Array<Record<string, unknown>>,
  maxTokens: number,
  tool: { name: string; description: string; inputSchema: Record<string, unknown> },
  label?: string,
  temperature?: number,
): Promise<{ data: Record<string, unknown> | null; truncated: boolean; error?: string; status?: number }> {
  const callLabel = label ?? tool.name;
  const response = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      temperature: temperature ?? 0,
      system,
      messages: [{ role: "user", content }],
      tools: [{
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }],
      tool_choice: { type: "tool", name: tool.name },
    }),
  }, callLabel);

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[anthropic:${callLabel}] API error ${response.status}: ${errText.slice(0, 200)}`);
    return { data: null, truncated: false, error: errText, status: response.status };
  }

  const result = await response.json();
  const inputTokens = result.usage?.input_tokens ?? "?";
  const outputTokens = result.usage?.output_tokens ?? "?";
  const toolUseBlock = result.content?.find(
    (block: { type: string }) => block.type === "tool_use"
  );

  if (!toolUseBlock) {
    console.log(`[anthropic:${callLabel}] OK (no tool_use) — ${inputTokens} in / ${outputTokens} out, stop=${result.stop_reason}`);
    const text = result.content
      ?.filter((block: AnthropicBlock) => block.type === "text")
      ?.map((block: AnthropicBlock) => block.text)
      ?.join("\n") || "";
    return { data: text ? parseJsonResponse(text) : null, truncated: result.stop_reason !== "end_turn" };
  }

  console.log(`[anthropic:${callLabel}] OK — ${inputTokens} in / ${outputTokens} out, stop=${result.stop_reason}`);
  return {
    data: toolUseBlock.input as Record<string, unknown>,
    truncated: result.stop_reason !== "end_turn" && result.stop_reason !== "tool_use",
  };
}

export async function callAnthropicChunkedWithTool(
  apiKey: string,
  system: string,
  documents: CloDocument[],
  userText: string,
  maxTokens: number,
  tool: { name: string; description: string; inputSchema: Record<string, unknown> },
): Promise<{ results: { data: Record<string, unknown> | null; truncated: boolean; chunkLabel: string }[]; error?: string; status?: number }> {
  const chunkSets = await chunkDocuments(documents);

  if (chunkSets.length === 1) {
    const content = buildDocumentContent(chunkSets[0].documents, userText);
    const result = await callAnthropicWithTool(apiKey, system, content, maxTokens, tool);
    if (result.error && result.error.includes("prompt is too long")) {
      return callAnthropicChunkedWithToolLimit(apiKey, system, documents, userText, maxTokens, tool, Math.floor(MAX_PDF_PAGES / 2));
    }
    if (result.error) return { results: [], error: result.error, status: result.status };
    return { results: [{ data: result.data, truncated: result.truncated, chunkLabel: chunkSets[0].chunkLabel }] };
  }

  const chunkResults = await Promise.all(
    chunkSets.map(async (chunkSet) => {
      const chunkUserText = `[NOTE: This document has been split due to size. You are viewing ${chunkSet.chunkLabel}. Extract all information from these pages.]\n\n${userText}`;
      const content = buildDocumentContent(chunkSet.documents, chunkUserText);
      const result = await callAnthropicWithTool(apiKey, system, content, maxTokens, tool);
      return { ...result, chunkLabel: chunkSet.chunkLabel };
    }),
  );

  const promptTooLong = chunkResults.some((r) => r.error?.includes("prompt is too long"));
  if (promptTooLong) {
    return callAnthropicChunkedWithToolLimit(apiKey, system, documents, userText, maxTokens, tool, Math.floor(MAX_PDF_PAGES / 2));
  }

  const firstError = chunkResults.find((r) => r.error);
  if (firstError && chunkResults.every((r) => r.error)) {
    return { results: [], error: firstError.error, status: firstError.status };
  }

  return {
    results: chunkResults
      .filter((r) => !r.error)
      .map((r) => ({ data: r.data, truncated: r.truncated, chunkLabel: r.chunkLabel })),
  };
}

async function callAnthropicChunkedWithToolLimit(
  apiKey: string,
  system: string,
  documents: CloDocument[],
  userText: string,
  maxTokens: number,
  tool: { name: string; description: string; inputSchema: Record<string, unknown> },
  pageLimit: number,
): Promise<{ results: { data: Record<string, unknown> | null; truncated: boolean; chunkLabel: string }[]; error?: string; status?: number }> {
  console.log(`[callAnthropicChunkedWithTool] Retrying with reduced page limit: ${pageLimit}`);
  const chunkSets = await chunkDocuments(documents, pageLimit);

  const chunkResults = await Promise.all(
    chunkSets.map(async (chunkSet) => {
      const chunkUserText = chunkSets.length > 1
        ? `[NOTE: This document has been split due to size. You are viewing ${chunkSet.chunkLabel}. Extract all information from these pages.]\n\n${userText}`
        : userText;
      const content = buildDocumentContent(chunkSet.documents, chunkUserText);
      const result = await callAnthropicWithTool(apiKey, system, content, maxTokens, tool);
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
      .map((r) => ({ data: r.data, truncated: r.truncated, chunkLabel: r.chunkLabel })),
  };
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

const CLASS_NAME_ALIASES: Record<string, string> = {
  SUB: "SUBORDINATED",
  SUBORD: "SUBORDINATED",
  "SUB-NOTES": "SUBORDINATED",
  EQ: "EQUITY",
  "EQUITY-NOTES": "EQUITY",
  MEZZ: "MEZZANINE",
  "INCOME-NOTES": "INCOME-NOTE",
  INCOME: "INCOME-NOTE",
  RESIDUAL: "INCOME-NOTE",
};

export function normalizeClassName(name: string): string {
  const stripped = name
    .replace(/^class(es)?\s+/i, "")
    .replace(/[\s-]+/g, "-")
    .toUpperCase();
  return CLASS_NAME_ALIASES[stripped] ?? stripped;
}
