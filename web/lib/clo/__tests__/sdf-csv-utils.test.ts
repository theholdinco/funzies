import { describe, it, expect } from "vitest";
import {
  parseCsvLines,
  parseNumeric,
  parseBoolean,
  parseDate,
  parsePercentage,
  trimRating,
  spreadToBps,
} from "../sdf/csv-utils";

describe("parseCsvLines", () => {
  it("parses simple CSV into header + rows", () => {
    const csv = "Name,Age,City\nAlice,30,NYC\nBob,25,LA";
    const result = parseCsvLines(csv);
    expect(result.headers).toEqual(["Name", "Age", "City"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ Name: "Alice", Age: "30", City: "NYC" });
  });

  it("handles quoted fields with commas", () => {
    const csv = 'Name,Desc\n"Smith, John",Hello';
    const result = parseCsvLines(csv);
    expect(result.rows[0].Name).toBe("Smith, John");
  });

  it("handles empty lines", () => {
    const csv = "A,B\n1,2\n\n3,4\n";
    const result = parseCsvLines(csv);
    expect(result.rows).toHaveLength(2);
  });

  it("strips BOM from start of file", () => {
    const csv = "\uFEFFName,Age\nAlice,30";
    const result = parseCsvLines(csv);
    expect(result.headers[0]).toBe("Name");
  });
});

describe("parseNumeric", () => {
  it("parses plain numbers", () => {
    expect(parseNumeric("123.45")).toBe(123.45);
  });

  it("strips commas from thousands", () => {
    expect(parseNumeric("6,909,347.37")).toBe(6909347.37);
  });

  it("handles parenthesized negatives", () => {
    expect(parseNumeric("(1,817,412.94)")).toBe(-1817412.94);
  });

  it("returns null for empty string", () => {
    expect(parseNumeric("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseNumeric(undefined)).toBeNull();
  });
});

describe("parseBoolean", () => {
  it("parses TRUE/FALSE", () => {
    expect(parseBoolean("TRUE")).toBe(true);
    expect(parseBoolean("FALSE")).toBe(false);
  });

  it("parses Yes/No", () => {
    expect(parseBoolean("Yes")).toBe(true);
    expect(parseBoolean("No")).toBe(false);
  });

  it("returns null for empty", () => {
    expect(parseBoolean("")).toBeNull();
  });
});

describe("parseDate", () => {
  it("parses DD.MM.YYYY", () => {
    expect(parseDate("01.04.2026", "DD.MM.YYYY")).toBe("2026-04-01");
  });

  it("parses DD-Mon-YYYY", () => {
    expect(parseDate("06-Jan-2026", "DD-Mon-YYYY")).toBe("2026-01-06");
  });

  it("parses DD Mon YYYY", () => {
    expect(parseDate("06 Jan 2026", "DD Mon YYYY")).toBe("2026-01-06");
  });

  it("returns null for empty string", () => {
    expect(parseDate("", "DD.MM.YYYY")).toBeNull();
  });

  it("tries fallback formats on failure", () => {
    expect(parseDate("06-Jan-2026", "DD.MM.YYYY")).toBe("2026-01-06");
  });
});

describe("parsePercentage", () => {
  it("strips % and returns number", () => {
    expect(parsePercentage("136.98000%")).toBe(136.98);
  });

  it("handles no % sign", () => {
    expect(parsePercentage("136.98")).toBe(136.98);
  });

  it("returns null for empty", () => {
    expect(parsePercentage("")).toBeNull();
  });
});

describe("trimRating", () => {
  it("trims whitespace from ratings", () => {
    expect(trimRating("AAA ")).toBe("AAA");
    expect(trimRating("B2  ")).toBe("B2");
  });

  it("returns null for empty/whitespace-only", () => {
    expect(trimRating("   ")).toBeNull();
    expect(trimRating("")).toBeNull();
  });
});

describe("spreadToBps", () => {
  it("converts percentage points to bps", () => {
    expect(spreadToBps(3.25)).toBe(325);
    expect(spreadToBps(0.95)).toBe(95);
  });

  it("returns null for null/undefined input", () => {
    expect(spreadToBps(null)).toBeNull();
  });

  it("handles zero", () => {
    expect(spreadToBps(0)).toBe(0);
  });
});
