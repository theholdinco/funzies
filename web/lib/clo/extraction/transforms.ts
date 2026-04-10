/**
 * Pure functions extracted from runner.ts for testability.
 * No side effects, no I/O — only data transformations.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PassResult {
  pass: number;
  data: Record<string, unknown> | null;
  truncated: boolean;
  error?: string;
  raw: string;
}

export interface RepairAction {
  pass: number;
  reason: string;
  type: "validation_mismatch" | "truncation";
}

// Minimal shape of Pass1Output.poolSummary needed by detectRepairNeeds
interface PoolSummary {
  numberOfAssets?: number | null;
}

interface Pass1Shape {
  poolSummary: PoolSummary;
}

interface Pass2Shape {
  holdings: unknown[];
}

// ---------------------------------------------------------------------------
// remapColumnAliases
// ---------------------------------------------------------------------------

export function remapColumnAliases(
  row: Record<string, unknown>,
  aliases: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // First pass: set canonical (non-aliased) keys — these take priority
  for (const [k, v] of Object.entries(row)) {
    const mapped = aliases[k] ?? k;
    if (mapped === k) result[k] = v;
  }
  // Second pass: fill gaps from aliased keys
  for (const [k, v] of Object.entries(row)) {
    const mapped = aliases[k] ?? k;
    if (mapped !== k && result[mapped] == null) {
      result[mapped] = v;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// splitTextIntoPageChunks
// ---------------------------------------------------------------------------

const TEXT_CHUNK_PAGES = 50;
const TEXT_CHUNK_OVERLAP = 5;

export function splitTextIntoPageChunks(
  extractedText: string,
  pagesPerChunk: number = TEXT_CHUNK_PAGES,
  overlap: number = TEXT_CHUNK_OVERLAP,
): string[] {
  // Split on page markers: "--- Page N ---"
  const pagePattern = /--- Page \d+ ---/g;
  const markers: { index: number; marker: string }[] = [];
  let match;
  while ((match = pagePattern.exec(extractedText)) !== null) {
    markers.push({ index: match.index, marker: match[0] });
  }

  if (markers.length <= pagesPerChunk) return [extractedText];

  const chunks: string[] = [];
  for (let i = 0; i < markers.length; i += pagesPerChunk - overlap) {
    const startIdx = markers[i].index;
    const endMarkerIdx = Math.min(i + pagesPerChunk, markers.length);
    const endIdx = endMarkerIdx < markers.length ? markers[endMarkerIdx].index : extractedText.length;
    chunks.push(extractedText.slice(startIdx, endIdx).trim());
    if (endMarkerIdx >= markers.length) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// mergeChunkResults
// ---------------------------------------------------------------------------

export function mergeChunkResults(
  results: Array<{ data: Record<string, unknown> | null; truncated: boolean }>,
): { data: Record<string, unknown> | null; truncated: boolean } {
  let merged: Record<string, unknown> = {};
  for (const result of results) {
    if (!result.data) continue;
    if (Object.keys(merged).length === 0) {
      merged = result.data;
    } else {
      for (const [key, val] of Object.entries(result.data)) {
        if (val == null) continue;
        const baseVal = merged[key];
        if (Array.isArray(val) && Array.isArray(baseVal)) {
          merged[key] = [...baseVal, ...val];
        } else if (merged[key] == null) {
          merged[key] = val;
        }
      }
    }
  }

  const anyTruncated = results.some((r) => r.truncated);
  return { data: Object.keys(merged).length > 0 ? merged : null, truncated: anyTruncated };
}

// ---------------------------------------------------------------------------
// detectRepairNeeds
// ---------------------------------------------------------------------------

export function detectRepairNeeds(
  pass1Data: Pass1Shape,
  passResults: PassResult[],
): RepairAction[] {
  const repairs: RepairAction[] = [];

  for (const pr of passResults) {
    if (pr.truncated && pr.data) {
      repairs.push({
        pass: pr.pass,
        reason: `Pass ${pr.pass} output was truncated`,
        type: "truncation",
      });
    }
  }

  const p2 = passResults.find((p) => p.pass === 2);
  if (p2?.data) {
    const holdings = (p2.data as unknown as Pass2Shape).holdings;
    const expectedAssets = pass1Data.poolSummary.numberOfAssets;
    if (expectedAssets != null && holdings.length < expectedAssets * 0.85) {
      repairs.push({
        pass: 2,
        reason: `Extracted ${holdings.length} holdings but pool summary says ${expectedAssets} assets`,
        type: "validation_mismatch",
      });
    }
  }

  const seen = new Set<number>();
  return repairs.filter((r) => {
    if (seen.has(r.pass)) return false;
    seen.add(r.pass);
    return true;
  });
}

// ---------------------------------------------------------------------------
// getLastItems
// ---------------------------------------------------------------------------

export function getLastItems(data: Record<string, unknown>, n: number): { field: string; items: string[] } {
  let largestField = "";
  let largestArray: unknown[] = [];

  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val) && val.length > largestArray.length) {
      largestField = key;
      largestArray = val;
    }
  }

  if (largestArray.length === 0) return { field: "", items: [] };

  const last = largestArray.slice(-n);
  const items = last.map((item) => {
    if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      const name = obj.obligorName ?? obj.testName ?? obj.description ?? obj.className ?? obj.bucketName ?? obj.feeType ?? "";
      return String(name);
    }
    return String(item);
  });

  return { field: largestField, items };
}
