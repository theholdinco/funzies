import { describe, it, expect } from "vitest";
import {
  remapColumnAliases,
  splitTextIntoPageChunks,
  mergeChunkResults,
  detectRepairNeeds,
  getLastItems,
} from "../extraction/transforms";
import type { PassResult } from "../extraction/transforms";

// ---------------------------------------------------------------------------
// remapColumnAliases
// ---------------------------------------------------------------------------

describe("remapColumnAliases", () => {
  const aliases: Record<string, string> = {
    aggregate_principal_balance: "total_principal_balance",
    weighted_average_spread: "wac_spread",
    num_obligors: "number_of_obligors",
  };

  it("maps canonical keys correctly", () => {
    const row = { total_principal_balance: 100, wac_spread: 0.05 };
    const result = remapColumnAliases(row, aliases);
    expect(result).toEqual({ total_principal_balance: 100, wac_spread: 0.05 });
  });

  it("fills gaps with alias values", () => {
    const row = { aggregate_principal_balance: 200, num_obligors: 50 };
    const result = remapColumnAliases(row, aliases);
    expect(result.total_principal_balance).toBe(200);
    expect(result.number_of_obligors).toBe(50);
  });

  it("does not overwrite existing canonical keys with alias values", () => {
    const row = {
      total_principal_balance: 100,
      aggregate_principal_balance: 999,
    };
    const result = remapColumnAliases(row, aliases);
    expect(result.total_principal_balance).toBe(100);
  });

  it("handles empty row", () => {
    expect(remapColumnAliases({}, aliases)).toEqual({});
  });

  it("handles empty aliases", () => {
    const row = { foo: 1, bar: 2 };
    expect(remapColumnAliases(row, {})).toEqual({ foo: 1, bar: 2 });
  });
});

// ---------------------------------------------------------------------------
// splitTextIntoPageChunks
// ---------------------------------------------------------------------------

function buildPages(n: number): string {
  return Array.from({ length: n }, (_, i) => `--- Page ${i + 1} ---\nContent of page ${i + 1}`).join("\n\n");
}

describe("splitTextIntoPageChunks", () => {
  it("splits by page markers", () => {
    const text = buildPages(10);
    const chunks = splitTextIntoPageChunks(text, 5, 0);
    expect(chunks.length).toBe(2);
  });

  it("respects pagesPerChunk parameter", () => {
    const text = buildPages(20);
    const chunks = splitTextIntoPageChunks(text, 5, 0);
    expect(chunks.length).toBe(4);
  });

  it("respects overlap parameter", () => {
    const text = buildPages(10);
    // pagesPerChunk=5, overlap=2 => step=3, so we get more chunks
    const chunks = splitTextIntoPageChunks(text, 5, 2);
    expect(chunks.length).toBeGreaterThan(2);
    // Check that overlapping pages appear in consecutive chunks
    expect(chunks[0]).toContain("Page 1");
    expect(chunks[1]).toContain("Page 4"); // starts at index 3 (step=3)
  });

  it("returns single chunk when fewer pages than pagesPerChunk", () => {
    const text = buildPages(3);
    const chunks = splitTextIntoPageChunks(text, 50, 5);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(text);
  });

  it("handles text without page markers (returns as single chunk)", () => {
    const text = "Just some plain text without any page markers.";
    const chunks = splitTextIntoPageChunks(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// mergeChunkResults
// ---------------------------------------------------------------------------

describe("mergeChunkResults", () => {
  it("concatenates arrays from multiple chunks", () => {
    const results = [
      { data: { holdings: [1, 2] }, truncated: false },
      { data: { holdings: [3, 4] }, truncated: false },
    ];
    const merged = mergeChunkResults(results);
    expect(merged.data?.holdings).toEqual([1, 2, 3, 4]);
  });

  it("prefers first non-null scalar value", () => {
    const results = [
      { data: { name: "first", count: null }, truncated: false },
      { data: { name: "second", count: 42 }, truncated: false },
    ];
    const merged = mergeChunkResults(results);
    expect(merged.data?.name).toBe("first");
    expect(merged.data?.count).toBe(42);
  });

  it("handles null data in some chunks", () => {
    const results = [
      { data: null, truncated: false },
      { data: { items: [1] }, truncated: false },
    ];
    const merged = mergeChunkResults(results);
    expect(merged.data).toEqual({ items: [1] });
  });

  it("propagates truncated flag if any chunk is truncated", () => {
    const results = [
      { data: { a: 1 }, truncated: false },
      { data: { b: 2 }, truncated: true },
    ];
    expect(mergeChunkResults(results).truncated).toBe(true);
  });

  it("handles empty results array", () => {
    const merged = mergeChunkResults([]);
    expect(merged.data).toBeNull();
    expect(merged.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectRepairNeeds
// ---------------------------------------------------------------------------

function makePassResult(overrides: Partial<PassResult> & { pass: number }): PassResult {
  return { data: null, truncated: false, raw: "", ...overrides };
}

describe("detectRepairNeeds", () => {
  const pass1Data = { poolSummary: { numberOfAssets: 100 } };

  it("detects truncation when a pass reports truncated=true", () => {
    const results = [makePassResult({ pass: 2, truncated: true, data: { holdings: [] } })];
    const repairs = detectRepairNeeds(pass1Data, results);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].type).toBe("truncation");
    expect(repairs[0].pass).toBe(2);
  });

  it("detects holdings count mismatch", () => {
    const holdings = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const results = [makePassResult({ pass: 2, data: { holdings } })];
    const repairs = detectRepairNeeds(pass1Data, results);
    expect(repairs.some((r) => r.type === "validation_mismatch")).toBe(true);
  });

  it("returns empty array when no repair needed", () => {
    const holdings = Array.from({ length: 95 }, (_, i) => ({ id: i }));
    const results = [makePassResult({ pass: 2, data: { holdings } })];
    const repairs = detectRepairNeeds(pass1Data, results);
    expect(repairs).toHaveLength(0);
  });

  it("does not produce duplicate repair actions for the same pass", () => {
    // Pass 2 is both truncated AND has a count mismatch
    const holdings = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const results = [makePassResult({ pass: 2, truncated: true, data: { holdings } })];
    const repairs = detectRepairNeeds(pass1Data, results);
    const pass2Repairs = repairs.filter((r) => r.pass === 2);
    expect(pass2Repairs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getLastItems
// ---------------------------------------------------------------------------

describe("getLastItems", () => {
  it("finds the largest array field", () => {
    const data = { small: [1, 2], big: [1, 2, 3, 4, 5] };
    const result = getLastItems(data, 2);
    expect(result.field).toBe("big");
  });

  it("extracts last N items as strings", () => {
    const data = { items: [10, 20, 30, 40, 50] };
    const result = getLastItems(data, 3);
    expect(result.items).toEqual(["30", "40", "50"]);
  });

  it("handles objects in array (extracts obligorName, testName, etc.)", () => {
    const data = {
      holdings: [
        { obligorName: "Acme Corp" },
        { obligorName: "Beta Inc" },
        { obligorName: "Gamma LLC" },
      ],
    };
    const result = getLastItems(data, 2);
    expect(result.items).toEqual(["Beta Inc", "Gamma LLC"]);
  });

  it("returns empty for object with no arrays", () => {
    const data = { name: "test", count: 5 };
    const result = getLastItems(data, 3);
    expect(result.field).toBe("");
    expect(result.items).toEqual([]);
  });

  it("handles N larger than array length", () => {
    const data = { items: [1, 2] };
    const result = getLastItems(data, 10);
    expect(result.items).toEqual(["1", "2"]);
  });
});
