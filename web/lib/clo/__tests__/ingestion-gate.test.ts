import { describe, it, expect } from "vitest";
import { parseSpreadToBps, normalizeWacSpread, normalizeComplianceTestType, deepFixStringNulls } from "../ingestion-gate";

describe("parseSpreadToBps", () => {
  it("returns spreadBps directly when provided and > 0", () => {
    expect(parseSpreadToBps(150, null)).toBe(150);
    expect(parseSpreadToBps(200, "1.47%")).toBe(200);
  });

  it("parses percentage string (e.g. '1.47%' → 147)", () => {
    expect(parseSpreadToBps(null, "1.47%")).toBe(147);
    expect(parseSpreadToBps(null, "2.00%")).toBe(200);
    expect(parseSpreadToBps(0, "1.47%")).toBe(147);
  });

  it("parses bps string (e.g. '150bps' → 150)", () => {
    expect(parseSpreadToBps(null, "150bps")).toBe(150);
    expect(parseSpreadToBps(null, "175 BPS")).toBe(175);
  });

  it("parses plain number >= 10 as bps", () => {
    expect(parseSpreadToBps(null, "150")).toBe(150);
    expect(parseSpreadToBps(null, "10")).toBe(10);
  });

  it("parses plain number < 10 as percentage", () => {
    expect(parseSpreadToBps(null, "1.47")).toBe(147);
    expect(parseSpreadToBps(null, "2.5")).toBe(250);
  });

  it("returns null for unparseable strings", () => {
    expect(parseSpreadToBps(null, "E+150")).toBeNull();
    expect(parseSpreadToBps(null, "EURIBOR + 1.50%")).toBe(150);
    expect(parseSpreadToBps(null, "n/a")).toBeNull();
    expect(parseSpreadToBps(null, "TBD")).toBeNull();
  });

  it("returns null for null/undefined inputs", () => {
    expect(parseSpreadToBps(null, null)).toBeNull();
    expect(parseSpreadToBps(undefined, undefined)).toBeNull();
    expect(parseSpreadToBps(null, undefined)).toBeNull();
  });
});

describe("normalizeWacSpread", () => {
  it("converts value < 20 from percentage to bps", () => {
    expect(normalizeWacSpread(3.76)).toEqual({
      bps: 376,
      fix: expect.objectContaining({ before: 3.76, after: 376 }),
    });
  });

  it("keeps value >= 10 as bps with no fix", () => {
    expect(normalizeWacSpread(376)).toEqual({ bps: 376, fix: null });
    expect(normalizeWacSpread(20)).toEqual({ bps: 20, fix: null });
    expect(normalizeWacSpread(15)).toEqual({ bps: 15, fix: null });
  });

  it("treats values 10–19 as bps (not percentages)", () => {
    const result = normalizeWacSpread(15);
    expect(result.bps).toBe(15);
    expect(result.fix).toBeNull();
  });

  it("converts values < 10 from percentage to bps", () => {
    const result = normalizeWacSpread(3.76);
    expect(result.bps).toBe(376);
    expect(result.fix).not.toBeNull();
  });

  it("returns 0 bps with no fix for null", () => {
    expect(normalizeWacSpread(null)).toEqual({ bps: 0, fix: null });
  });
});

describe("normalizeComplianceTestType", () => {
  it("normalizes 'overcollateralization' test name to OC_PAR", () => {
    const input = [{ testType: null, testName: "Overcollateralization Test A", isPassing: null, actualValue: null, triggerLevel: null }];
    const { tests } = normalizeComplianceTestType(input);
    expect(tests[0].testType).toBe("OC_PAR");
  });

  it("normalizes 'interest coverage' test name to IC", () => {
    const input = [{ testType: null, testName: "Interest Coverage Test", isPassing: null, actualValue: null, triggerLevel: null }];
    const { tests } = normalizeComplianceTestType(input);
    expect(tests[0].testType).toBe("IC");
  });

  it("leaves already-normalized types unchanged without producing a fix", () => {
    const input = [
      { testType: "OC_PAR", testName: "OC Test", isPassing: true, actualValue: null, triggerLevel: null },
      { testType: "IC", testName: "IC Test", isPassing: false, actualValue: null, triggerLevel: null },
      { testType: "OC_MV", testName: "MV Test", isPassing: null, actualValue: null, triggerLevel: null },
    ];
    const { tests, fixes } = normalizeComplianceTestType(input);
    expect(tests[0].testType).toBe("OC_PAR");
    expect(tests[1].testType).toBe("IC");
    expect(tests[2].testType).toBe("OC_MV");
    expect(fixes.filter(f => f.field.includes("testType"))).toHaveLength(0);
  });

  it("computes isPassing from actualValue vs triggerLevel when null", () => {
    const passing = [{ testType: "OC_PAR", testName: "OC A", isPassing: null, actualValue: 110, triggerLevel: 105 }];
    const failing = [{ testType: "IC", testName: "IC A", isPassing: null, actualValue: 90, triggerLevel: 105 }];

    const { tests: passingTests } = normalizeComplianceTestType(passing);
    expect(passingTests[0].isPassing).toBe(true);

    const { tests: failingTests } = normalizeComplianceTestType(failing);
    expect(failingTests[0].isPassing).toBe(false);
  });

  it("does not overwrite an existing isPassing value", () => {
    const input = [{ testType: "OC_PAR", testName: "OC A", isPassing: false, actualValue: 110, triggerLevel: 105 }];
    const { tests } = normalizeComplianceTestType(input);
    expect(tests[0].isPassing).toBe(false);
  });

  it("records fixes for normalized types and computed isPassing", () => {
    const input = [{ testType: null, testName: "Interest Coverage Test", isPassing: null, actualValue: 120, triggerLevel: 105 }];
    const { fixes } = normalizeComplianceTestType(input);
    expect(fixes.some(f => f.field.includes("testType"))).toBe(true);
    expect(fixes.some(f => f.field.includes("isPassing"))).toBe(true);
  });
});

describe("deepFixStringNulls", () => {
  it("coerces 'null' at depth 1", () => {
    expect(deepFixStringNulls({ a: "null", b: 42 })).toEqual({ a: null, b: 42 });
  });

  it("coerces 'null' at depth 3", () => {
    expect(deepFixStringNulls({ outer: { middle: { inner: "null" } } }))
      .toEqual({ outer: { middle: { inner: null } } });
  });

  it("coerces 'NULL' and 'Null' case-insensitively", () => {
    expect(deepFixStringNulls({ a: "NULL", b: "Null", c: "nULL" }))
      .toEqual({ a: null, b: null, c: null });
  });

  it("coerces 'undefined' string to null", () => {
    expect(deepFixStringNulls({ a: "undefined" })).toEqual({ a: null });
  });

  it("walks arrays", () => {
    expect(deepFixStringNulls([{ a: "null" }, { a: "value" }]))
      .toEqual([{ a: null }, { a: "value" }]);
  });

  it("leaves legitimate values untouched", () => {
    const input = { a: "hello", b: 0, c: false, d: null, e: "nullable-field-name" };
    expect(deepFixStringNulls(input)).toEqual(input);
  });

  it("does not coerce substring 'null' (exact match only)", () => {
    expect(deepFixStringNulls({ a: "not null", b: "nullable" }))
      .toEqual({ a: "not null", b: "nullable" });
  });

  it("processes 236-row holdings schedule in under 50ms (perf guard)", () => {
    const holdings = Array.from({ length: 236 }, (_, i) => ({
      obligorName: `Obligor ${i}`, isin: `XS${String(i).padStart(10, "0")}`,
      spreadBps: i % 5 === 0 ? "null" : 350, rating: "B",
      moodysRating: i % 7 === 0 ? "NULL" : "B2",
      nested: { deeper: { value: i % 11 === 0 ? "undefined" : 100 } },
    }));
    const start = performance.now();
    deepFixStringNulls({ holdings });
    expect(performance.now() - start).toBeLessThan(50);
  });
});
