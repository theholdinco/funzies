import { describe, it, expect } from "vitest";
import {
  parseCsvLines,
  parseNumeric,
  parseBoolean,
  parseDate,
  parsePercentage,
  parseDecoratedAmount,
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

describe("parseNumeric (KI-50: locale-aware)", () => {
  describe("plain / no separator", () => {
    it("parses integer", () => expect(parseNumeric("1500")).toBe(1500));
    it("parses zero", () => expect(parseNumeric("0")).toBe(0));
    it("parses American decimal", () => expect(parseNumeric("123.45")).toBe(123.45));
    it("parses negative", () => expect(parseNumeric("-1500.5")).toBe(-1500.5));
    it("parses leading +", () => expect(parseNumeric("+1500")).toBe(1500));
  });

  describe("American format (',' = thousands, '.' = decimal)", () => {
    it("strips thousands", () => expect(parseNumeric("6,909,347.37")).toBe(6909347.37));
    it("thousands without decimal", () => expect(parseNumeric("1,000,000")).toBe(1000000));
    it("single thousands group", () => expect(parseNumeric("1,500")).toBe(1500));
    it("thousands + decimal", () => expect(parseNumeric("1,500.50")).toBe(1500.5));
  });

  describe("European format ('.' = thousands, ',' = decimal)", () => {
    it("multi-thousands + decimal", () => expect(parseNumeric("1.500.000,00")).toBe(1500000));
    it("multi-thousands no decimal", () => expect(parseNumeric("1.500.000")).toBe(1500000));
    it("simple thousands", () => expect(parseNumeric("1.500")).toBe(1500));
    it("decimal 1 digit", () => expect(parseNumeric("1,5")).toBe(1.5));
    it("decimal 2 digits", () => expect(parseNumeric("15,00")).toBe(15));
    it("thousands + decimal", () => expect(parseNumeric("1.500,50")).toBe(1500.5));
  });

  describe("ambiguous single-separator cases", () => {
    it("'0,500' → 0.5 (leading zero ⇒ decimal)", () => expect(parseNumeric("0,500")).toBe(0.5));
    it("'0.500' → 0.5 (leading zero ⇒ decimal)", () => expect(parseNumeric("0.500")).toBe(0.5));
    it("'1500,500' → 1500.5 (4-digit prefix ⇒ decimal)", () => expect(parseNumeric("1500,500")).toBe(1500.5));
    it("'1500.500' → 1500.5 (4-digit prefix ⇒ decimal)", () => expect(parseNumeric("1500.500")).toBe(1500.5));
    it("'15,500' → 15500 (canonical thousands shape)", () => expect(parseNumeric("15,500")).toBe(15500));
    it("'150.500' → 150500 (canonical thousands shape)", () => expect(parseNumeric("150.500")).toBe(150500));
  });

  describe("currency-prefixed", () => {
    it("euro", () => expect(parseNumeric("€1,234.56")).toBe(1234.56));
    it("dollar", () => expect(parseNumeric("$1,234.56")).toBe(1234.56));
    it("pound", () => expect(parseNumeric("£1,234.56")).toBe(1234.56));
    it("yen", () => expect(parseNumeric("¥1,234")).toBe(1234));
    it("euro + European format", () => expect(parseNumeric("€1.234,56")).toBe(1234.56));
  });

  describe("sign + currency in any leading order", () => {
    it("sign before currency", () => expect(parseNumeric("-€1,234.56")).toBe(-1234.56));
    it("currency before sign", () => expect(parseNumeric("€-1,234.56")).toBe(-1234.56));
    it("double-negative is positive", () => expect(parseNumeric("--1,234")).toBe(1234));
  });

  describe("French/SI internal whitespace", () => {
    it("regular space as thousands", () => expect(parseNumeric("1 234,56")).toBe(1234.56));
    it("multi-group space-separated", () => expect(parseNumeric("1 500 000,00")).toBe(1500000));
    it("degenerate single-digit groups (regression)", () => expect(parseNumeric("1 2 3")).toBe(123));
    it("nine single-digit groups (regression)", () => expect(parseNumeric("1 2 3 4 5 6 7 8 9")).toBe(123456789));
    it("non-breaking space", () => expect(parseNumeric("1 234,56")).toBe(1234.56));
  });

  describe("parens-as-negative", () => {
    it("American", () => expect(parseNumeric("(1,817,412.94)")).toBe(-1817412.94));
    it("European", () => expect(parseNumeric("(1.000,00)")).toBe(-1000));
    it("simple", () => expect(parseNumeric("(500)")).toBe(-500));
    it("currency inside parens", () => expect(parseNumeric("(€1,234.56)")).toBe(-1234.56));
  });

  describe("parens-wrapped sign-prefixed → null (malformed)", () => {
    it("(-X)", () => expect(parseNumeric("(-1,234.56)")).toBeNull());
    it("(+X)", () => expect(parseNumeric("(+1,234.56)")).toBeNull());
    it("(€-X)", () => expect(parseNumeric("(€-1,234.56)")).toBeNull());
    it("(-€X)", () => expect(parseNumeric("(-€1,234.56)")).toBeNull());
    it("(+€X)", () => expect(parseNumeric("(+€1,234.56)")).toBeNull());
  });

  describe("null / invalid", () => {
    it("empty string", () => expect(parseNumeric("")).toBeNull());
    it("whitespace only", () => expect(parseNumeric("   ")).toBeNull());
    it("undefined", () => expect(parseNumeric(undefined)).toBeNull());
    it("null", () => expect(parseNumeric(null)).toBeNull());
    it("non-numeric", () => expect(parseNumeric("abc")).toBeNull());
    it("currency-only", () => expect(parseNumeric("€")).toBeNull());
    it("sign-only", () => expect(parseNumeric("-")).toBeNull());
  });

  describe("scientific notation", () => {
    it("'1.5e5' → 150000 (American mantissa)", () => expect(parseNumeric("1.5e5")).toBe(150000));
    it("'1.5E-3' → 0.0015", () => expect(parseNumeric("1.5E-3")).toBe(0.0015));
    it("'2e10' → 2e10", () => expect(parseNumeric("2e10")).toBe(2e10));
    it("'1,5e5' → 150000 (European mantissa)", () => expect(parseNumeric("1,5e5")).toBe(150000));
    it("'1.500,5e2' → 150050 (European thousands+decimal mantissa)", () => expect(parseNumeric("1.500,5e2")).toBe(150050));
    it("negative European scientific", () => expect(parseNumeric("-1,5e5")).toBe(-150000));
    it("preserves precision on small-mantissa scientific (no toString round-trip)", () => {
      // mantissa 1e-7 stringifies to "1e-7"; naive reconstruction would yield
      // "1e-7e5" which parseFloat truncates at the first 'e'. Direct Math.pow
      // gives the correct answer.
      expect(parseNumeric("0.0000001e5")).toBeCloseTo(0.01, 10);
    });
  });

  describe("currency + sign only edges", () => {
    it("'+€' → null (both eaten, empty body)", () => expect(parseNumeric("+€")).toBeNull());
    it("'€-' → null", () => expect(parseNumeric("€-")).toBeNull());
    it("'-€' → null", () => expect(parseNumeric("-€")).toBeNull());
    it("'+$' → null", () => expect(parseNumeric("+$")).toBeNull());
  });

  describe("trailing / leading separators", () => {
    it("trailing dot", () => expect(parseNumeric("1.")).toBe(1));
    it("trailing comma", () => expect(parseNumeric("1,")).toBe(1));
    it("leading dot", () => expect(parseNumeric(".5")).toBe(0.5));
    it("leading comma → European decimal", () => expect(parseNumeric(",5")).toBe(0.5));
    it("negative European decimal <1", () => expect(parseNumeric("-,5")).toBe(-0.5));
  });

  describe("billions / large magnitudes", () => {
    it("American billions", () => expect(parseNumeric("1,000,000,000")).toBe(1000000000));
    it("European billions", () => expect(parseNumeric("1.000.000.000")).toBe(1000000000));
    it("American billions + decimal", () => expect(parseNumeric("1,000,000,000.50")).toBe(1000000000.5));
    it("European billions + decimal", () => expect(parseNumeric("1.000.000.000,50")).toBe(1000000000.5));
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

describe("parsePercentage (KI-50: locale-aware)", () => {
  it("strips % and returns number", () => {
    expect(parsePercentage("136.98000%")).toBe(136.98);
  });

  it("handles no % sign", () => {
    expect(parsePercentage("136.98")).toBe(136.98);
  });

  it("treats single-separator three-decimal percent values as decimals", () => {
    expect(parsePercentage("99.542")).toBe(99.542);
    expect(parsePercentage("100.094%")).toBe(100.094);
    expect(parsePercentage("3.250")).toBe(3.25);
    expect(parsePercentage("3,250")).toBe(3.25);
  });

  it("returns null for empty", () => {
    expect(parsePercentage("")).toBeNull();
  });

  it("parses European decimal", () => {
    expect(parsePercentage("5,25%")).toBe(5.25);
  });

  it("parses European decimal without %", () => {
    expect(parsePercentage("5,25")).toBe(5.25);
  });

  it("parses European thousands + decimal", () => {
    expect(parsePercentage("1.234,56%")).toBe(1234.56);
  });

  it("parses American thousands + decimal", () => {
    expect(parsePercentage("1,234.56%")).toBe(1234.56);
  });
});

describe("parseDecoratedAmount (PPM extraction shape)", () => {
  it("strips leading currency code", () => {
    expect(parseDecoratedAmount("EUR 100,000,000")).toBe(100000000);
  });

  it("strips trailing currency code (regression: was 100× under parseNumeric)", () => {
    // "100,000 EUR" → parseNumeric stops at first non-numeric and would return
    // 100. parseDecoratedAmount pre-strips so the full magnitude survives.
    expect(parseDecoratedAmount("100,000 EUR")).toBe(100000);
  });

  it("strips USD trailing code", () => {
    expect(parseDecoratedAmount("150,000,000 USD")).toBe(150000000);
  });

  it("preserves currency symbol", () => {
    expect(parseDecoratedAmount("€100,000,000")).toBe(100000000);
  });

  it("preserves European decimal+thousands shape after decoration strip", () => {
    expect(parseDecoratedAmount("EUR 1.234.567,89")).toBe(1234567.89);
  });

  it("preserves parens-as-negative", () => {
    expect(parseDecoratedAmount("EUR (1,000,000)")).toBe(-1000000);
  });

  it("preserves sign prefix", () => {
    expect(parseDecoratedAmount("-EUR 100,000")).toBe(-100000);
  });

  it("returns null on null", () => {
    expect(parseDecoratedAmount(null)).toBeNull();
  });

  it("returns null on undefined", () => {
    expect(parseDecoratedAmount(undefined)).toBeNull();
  });

  it("returns null on empty", () => {
    expect(parseDecoratedAmount("")).toBeNull();
  });

  it("returns null when no digits remain after strip", () => {
    expect(parseDecoratedAmount("EUR")).toBeNull();
  });

  it("handles plain integer (no decoration)", () => {
    expect(parseDecoratedAmount("150000000")).toBe(150000000);
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
