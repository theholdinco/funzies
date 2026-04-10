import type { SectionExtractionResult } from "./section-extractor";
import { callAnthropicWithTool } from "../api";
import { zodToToolSchema } from "./schema-utils";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Multi-pass merger: run extraction N times, merge with AI reconciliation.
//
// Phase 1 (deterministic): union arrays by dedup key, collect scalar conflicts
// Phase 2 (AI): send all N pass results per section to Claude for smart merge
//   — resolves conflicts, picks best values, fills gaps
// ---------------------------------------------------------------------------

const EXTRACTION_PASSES = 3;
export { EXTRACTION_PASSES };

// Section-specific dedup key functions
const DEDUP_KEYS: Record<string, (item: Record<string, unknown>) => string> = {
  holdings: (h) => `${norm(h.obligorName)}|${norm(h.lxid ?? h.isin ?? h.securityId)}`,
  tests: (t) => norm(t.testName),
  parValueAdjustments: (a) => `${norm(a.testName)}|${norm(a.adjustmentType)}`,
  concentrations: (c) => `${norm(c.concentrationType)}|${norm(c.bucketName)}`,
  trades: (t) => `${norm(t.obligorName)}|${norm(t.tradeDate)}|${norm(t.tradeType)}`,
  waterfallSteps: (w) => `${w.priorityOrder ?? ""}|${norm(w.description)}`,
  proceeds: (p) => `${norm(p.proceedsType)}|${norm(p.sourceDescription)}`,
  trancheSnapshots: (t) => norm(t.className),
  accounts: (a) => norm(a.accountName),
  assetRateDetails: (a) => `${norm(a.obligorName)}|${norm(a.facilityName)}`,
  interestAmountsPerTranche: (i) => norm(i.className),
  fees: (f) => norm(f.feeType ?? f.name),
  hedgePositions: (h) => `${norm(h.hedgeType)}|${norm(h.counterparty)}`,
  fxRates: (f) => `${norm(f.baseCurrency)}|${norm(f.quoteCurrency)}`,
  ratingActions: (r) => `${norm(r.agency)}|${norm(r.tranche)}|${norm(r.actionType)}`,
  events: (e) => `${norm(e.eventType)}|${norm(e.eventDate)}`,
  spCdoMonitor: (s) => norm(s.tranche),
  capitalStructure: (c) => norm(c.class ?? c.designation),
  coverageTestEntries: (c) => norm(c.class),
  eligibilityCriteria: (e) => typeof e === "string" ? norm(e) : JSON.stringify(e),
  collateralQualityTests: (c) => `${norm(c.name)}|${norm(c.agency)}`,
  keyParties: (k) => norm(k.role),
  redemptionProvisions: (r) => norm(r.type),
  eventsOfDefault: (e) => norm(e.event),
};

function norm(v: unknown): string {
  if (v == null) return "";
  return String(v).toLowerCase().trim().replace(/\s+/g, " ");
}

function countNonNull(obj: Record<string, unknown>): number {
  return Object.values(obj).filter((v) => v != null && v !== "" && v !== "null").length;
}

// ---------------------------------------------------------------------------
// Phase 1: Deterministic pre-merge (arrays only — scalars left for AI)
// ---------------------------------------------------------------------------

function preMergeArrayField(
  fieldName: string,
  values: (unknown[] | null | undefined)[],
): unknown[] {
  const arrays = values.filter((v): v is unknown[] => Array.isArray(v) && v.length > 0);
  if (arrays.length === 0) return [];
  if (arrays.length === 1) return [...arrays[0]];

  if (arrays[0].length > 0 && typeof arrays[0][0] === "string") {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const arr of arrays as string[][]) {
      for (const s of arr) {
        const key = norm(s);
        if (!seen.has(key)) { seen.add(key); result.push(s); }
      }
    }
    return result;
  }

  const getKey = DEDUP_KEYS[fieldName] ?? ((item: Record<string, unknown>) => JSON.stringify(item));
  const recordMap = new Map<string, { record: Record<string, unknown>; count: number; nonNull: number }>();

  for (const arr of arrays) {
    for (const item of arr) {
      if (item == null || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const key = getKey(rec);
      const existing = recordMap.get(key);
      const nn = countNonNull(rec);

      if (!existing) {
        recordMap.set(key, { record: rec, count: 1, nonNull: nn });
      } else {
        existing.count++;
        if (nn > existing.nonNull) {
          existing.record = rec;
          existing.nonNull = nn;
        }
      }
    }
  }

  return Array.from(recordMap.values()).map((v) => v.record);
}

// ---------------------------------------------------------------------------
// Phase 2: AI merge — send all N results for a section to Claude
// ---------------------------------------------------------------------------

const mergeResultSchema = z.object({
  merged: z.record(z.string(), z.unknown()),
  conflicts: z.array(z.object({
    field: z.string(),
    chosen: z.string(),
    reason: z.string(),
  })).optional().default([]),
});

const AI_MERGE_SYSTEM = `You are a data reconciliation specialist for CLO (Collateralized Loan Obligation) financial documents.

You receive N independent extraction results for the SAME section of the SAME document. Each extraction attempted to pull the same structured data but may have produced different values due to LLM non-determinism.

Your job: produce the single BEST merged result by combining all passes intelligently.

RULES:
1. For scalar fields (strings, numbers, booleans):
   - If all passes agree → use that value
   - If majority agrees → use the majority value
   - If all differ → pick the most plausible value for financial data (e.g., precise numbers over rounded ones, complete strings over truncated ones, valid dates over malformed ones)

2. For array fields (holdings, tests, etc.):
   - These have ALREADY been pre-merged for you via union-dedup. The pre-merged arrays are provided.
   - Keep them as-is unless you see obvious duplicates or errors.

3. For numeric financial values:
   - Prefer values with more decimal precision (117.85% over 118%)
   - Prefer values that are internally consistent (e.g., numerator/denominator that actually produce the ratio)
   - Negative numbers are valid (shortfalls, losses)

4. For dates:
   - Prefer ISO format (YYYY-MM-DD) or DD-MMM-YYYY
   - Verify plausibility (CLO dates are typically 2000-2040)

5. For text fields:
   - Prefer the more complete version
   - Prefer proper casing over ALL CAPS

6. Return the COMPLETE merged object — every field from every pass, not just conflicting ones.

7. Log which conflicts you resolved and why in the "conflicts" array.`;

async function aiMergeSection(
  apiKey: string,
  sectionType: string,
  passes: (Record<string, unknown> | null)[],
  preMergedArrays: Record<string, unknown[]>,
): Promise<Record<string, unknown> | null> {
  const validPasses = passes.filter((p): p is Record<string, unknown> => p != null);
  if (validPasses.length === 0) return null;
  if (validPasses.length === 1) return validPasses[0];

  // Check if all passes are identical — skip AI if so
  const serialized = validPasses.map((p) => JSON.stringify(p, Object.keys(p).sort()));
  if (new Set(serialized).size === 1) {
    console.log(`[multi-pass] ${sectionType}: all passes identical, skipping AI merge`);
    return validPasses[0];
  }

  // Build the merge input: show all passes + pre-merged arrays
  const passDescriptions = validPasses.map((p, i) =>
    `### Pass ${i + 1}\n\`\`\`json\n${JSON.stringify(p, null, 2)}\n\`\`\``
  ).join("\n\n");

  const preMergedDesc = Object.keys(preMergedArrays).length > 0
    ? `\n\n### Pre-merged arrays (already union-deduped)\n\`\`\`json\n${JSON.stringify(preMergedArrays, null, 2)}\n\`\`\``
    : "";

  const userPrompt = `Merge these ${validPasses.length} extraction results for the "${sectionType}" section of a CLO document.

${passDescriptions}${preMergedDesc}

Return the best merged result using the provided tool. For pre-merged arrays, use them as-is unless you see issues.`;

  const tool = {
    name: "merge_section_results",
    description: `Return the merged ${sectionType} data and any conflict resolutions`,
    inputSchema: zodToToolSchema(mergeResultSchema),
  };

  const content = [{ type: "text", text: userPrompt }];
  const label = `merge:${sectionType}`;

  const result = await callAnthropicWithTool(apiKey, AI_MERGE_SYSTEM, content, 64000, tool, label);

  if (result.error || !result.data) {
    console.warn(`[multi-pass] AI merge failed for ${sectionType}: ${result.error?.slice(0, 200) ?? "no data"}, falling back to deterministic merge`);
    return null; // caller will use deterministic fallback
  }

  const mergeResult = result.data as { merged: Record<string, unknown>; conflicts?: Array<{ field: string; chosen: string; reason: string }> };

  if (mergeResult.conflicts && mergeResult.conflicts.length > 0) {
    console.log(`[multi-pass] ${sectionType}: AI resolved ${mergeResult.conflicts.length} conflict(s):`);
    for (const c of mergeResult.conflicts) {
      console.log(`[multi-pass]   ${c.field}: chose "${c.chosen}" — ${c.reason}`);
    }
  }

  return mergeResult.merged;
}

// ---------------------------------------------------------------------------
// Deterministic fallback merge (used when AI merge fails or is skipped)
// ---------------------------------------------------------------------------

function deterministicMerge(
  passes: (Record<string, unknown> | null)[],
): Record<string, unknown> {
  const validPasses = passes.filter((p): p is Record<string, unknown> => p != null);
  const merged: Record<string, unknown> = {};

  const allKeys = new Set<string>();
  for (const pass of validPasses) {
    for (const key of Object.keys(pass)) allKeys.add(key);
  }

  for (const key of allKeys) {
    const values = validPasses.map((p) => p[key]);

    if (values.some((v) => Array.isArray(v))) {
      merged[key] = preMergeArrayField(key, values as (unknown[] | null | undefined)[]);
    } else if (values.some((v) => v != null && typeof v === "object")) {
      const objects = values.filter((v): v is Record<string, unknown> => v != null && typeof v === "object");
      if (objects.length === 0) { merged[key] = null; continue; }
      const allSubKeys = new Set<string>();
      for (const obj of objects) { for (const k of Object.keys(obj)) allSubKeys.add(k); }
      const sub: Record<string, unknown> = {};
      for (const subKey of allSubKeys) {
        const subValues = objects.map((o) => o[subKey]).filter((v) => v != null && v !== "" && v !== "null");
        sub[subKey] = majorityVote(subValues);
      }
      merged[key] = sub;
    } else {
      const nonNull = values.filter((v) => v != null && v !== "" && v !== "null");
      merged[key] = majorityVote(nonNull);
    }
  }

  return merged;
}

function majorityVote(values: unknown[]): unknown {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const v of values) {
    const key = JSON.stringify(v);
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { value: v, count: 1 });
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count)[0].value;
}

// ---------------------------------------------------------------------------
// Main merge: Phase 1 (deterministic arrays) → Phase 2 (AI reconciliation)
// ---------------------------------------------------------------------------

export async function mergeSectionPasses(
  apiKey: string,
  sectionType: string,
  passes: SectionExtractionResult[],
): Promise<SectionExtractionResult> {
  const validPasses = passes.filter((p) => p.data != null);

  if (validPasses.length === 0) {
    return { sectionType, data: null, truncated: false, error: "All passes failed" };
  }

  if (validPasses.length === 1) {
    return validPasses[0];
  }

  // Phase 1: Pre-merge arrays deterministically
  const allKeys = new Set<string>();
  for (const pass of validPasses) {
    for (const key of Object.keys(pass.data!)) allKeys.add(key);
  }

  const preMergedArrays: Record<string, unknown[]> = {};
  for (const key of allKeys) {
    const values = validPasses.map((p) => p.data![key]);
    if (values.some((v) => Array.isArray(v))) {
      preMergedArrays[key] = preMergeArrayField(key, values as (unknown[] | null | undefined)[]);
    }
  }

  // Phase 2: AI merge
  const passData = validPasses.map((p) => p.data);
  const aiResult = await aiMergeSection(apiKey, sectionType, passData, preMergedArrays);

  let merged: Record<string, unknown>;
  if (aiResult) {
    // Overlay pre-merged arrays onto AI result (AI might have truncated large arrays)
    merged = { ...aiResult };
    for (const [key, arr] of Object.entries(preMergedArrays)) {
      const aiArr = merged[key];
      if (Array.isArray(aiArr) && aiArr.length < arr.length) {
        merged[key] = arr;
      } else if (!Array.isArray(aiArr) && arr.length > 0) {
        merged[key] = arr;
      }
    }
  } else {
    // Fallback to deterministic merge
    console.log(`[multi-pass] ${sectionType}: using deterministic fallback`);
    merged = deterministicMerge(passData);
  }

  return {
    sectionType,
    data: merged,
    truncated: validPasses.some((p) => p.truncated),
  };
}

/**
 * Merge all sections across N passes with AI reconciliation.
 */
export async function mergeAllPasses(
  apiKey: string,
  allPasses: SectionExtractionResult[][],
): Promise<SectionExtractionResult[]> {
  // Group by section type
  const bySectionType = new Map<string, SectionExtractionResult[]>();

  for (const passResults of allPasses) {
    for (const result of passResults) {
      const existing = bySectionType.get(result.sectionType) ?? [];
      existing.push(result);
      bySectionType.set(result.sectionType, existing);
    }
  }

  // Merge each section type in parallel
  const mergePromises: Promise<SectionExtractionResult>[] = [];
  for (const [sectionType, passes] of bySectionType) {
    mergePromises.push(
      mergeSectionPasses(apiKey, sectionType, passes).then((result) => {
        console.log(`[multi-pass] ${sectionType}: merged ${passes.length} passes → ${result.data ? "OK" : "FAILED"}`);
        return result;
      }),
    );
  }

  return Promise.all(mergePromises);
}
