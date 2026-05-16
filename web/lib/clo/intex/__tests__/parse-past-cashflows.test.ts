/**
 * Intex parser discovery + validation tests.
 *
 * The parser discovers per-tranche column blocks from the CSV's own group-
 * label row and validates the discovered structure against the deal's
 * tranche list (passed in as `dealTranches`). Any deal whose Intex CSV
 * structure differs from `clo_tranches` must FAIL LOUD with a typed
 * `IntexSchemaMismatchError`, never silently mis-align columns onto
 * a wrong-shape per-tranche block.
 */

import { describe, it, expect } from "vitest";
import {
  parseIntexPastCashflows,
  IntexSchemaMismatchError,
  type DealTrancheInfo,
} from "@/lib/clo/intex/parse-past-cashflows";

// ---------------------------------------------------------------------------
// Synthetic CSV builder — generates an Intex DealCF-MV+ shaped CSV given a
// tranche list. The deal-invariant prefix (collateral / expenses / smoothing)
// is fixed at columns 0..38; per-tranche blocks follow at column 39 with
// widths derived from each tranche's isFloating flag (11 vs 10). This is
// the very layout the discovery is expected to recover from the header.
// ---------------------------------------------------------------------------

interface SyntheticPeriod {
  periodIndex: number;
  date: string; // "Apr 15, 2026"
  // Per-tranche values keyed by canonical className supplied to the builder.
  perTranche: Record<string, {
    principalPaid?: number;
    interestPaid?: number;
    endingBalance?: number;
  }>;
}

function buildSyntheticCsv(opts: {
  dealName: string;
  tranches: DealTrancheInfo[];
  periods: SyntheticPeriod[];
  // Optional override: place a tranche-name cell at a custom column to
  // simulate width-mismatch / extra-tranche scenarios.
  overrideTrancheStarts?: Record<string, number>;
  // Optional extra unrecognised tranche label injected at a column.
  injectExtraTranche?: { name: string; column: number };
  // Optional override of the canonical tranche name placed in the group
  // row (so we can simulate the CSV using "Sub Notes" while the deal
  // calls the same tranche "Subordinated Notes").
  overrideGroupRowName?: Record<string, string>;
  // Truncate every row to this many columns, simulating a CSV where the
  // trailing tranche block extends past the end of the row.
  truncateRowsToCols?: number;
}): string {
  const FIRST_TRANCHE_COL = 39;
  // Pre-tranche row width (collateral + deal balance + expenses + smoothing).
  // Use a generous 0..38 (39 cells) which matches the documented layout.
  const PREFIX_WIDTH = FIRST_TRANCHE_COL;

  // Determine per-tranche start positions. By default, place tranches at
  // FIRST_TRANCHE_COL with widths 10/11 packed contiguously.
  const starts: Record<string, number> = {};
  let nextCol = FIRST_TRANCHE_COL;
  for (const t of opts.tranches) {
    const start = opts.overrideTrancheStarts?.[t.className] ?? nextCol;
    starts[t.className] = start;
    const width = t.isFloating ? 11 : 10;
    nextCol = start + width;
  }
  const totalCols = nextCol + 5; // a few trailing OC/IC/EoD columns

  // Helper: build a row of empty cells.
  const empty = (): string[] => Array.from({ length: totalCols }, () => "");

  // Build the rows.
  const rows: string[][] = [];

  // Preamble (3 metadata rows).
  const preamble1 = empty();
  preamble1[0] = opts.dealName;
  rows.push(preamble1);
  const preamble2 = empty();
  preamble2[0] = "Deal Name:";
  preamble2[1] = "TEST-CODE";
  rows.push(preamble2);
  const preamble3 = empty();
  preamble3[0] = "Settlement";
  preamble3[1] = "Dec 14, 2021";
  rows.push(preamble3);

  // Group row — tranche names placed at their start columns.
  const groupRow = empty();
  for (const t of opts.tranches) {
    const labelInCsv = opts.overrideGroupRowName?.[t.className] ?? t.className;
    groupRow[starts[t.className]] = labelInCsv;
  }
  if (opts.injectExtraTranche) {
    groupRow[opts.injectExtraTranche.column] = opts.injectExtraTranche.name;
  }
  rows.push(groupRow);

  // Subgroup row (don't bother filling — discovery doesn't read it).
  rows.push(empty());

  // First "Period|Date" header marker.
  const header1 = empty();
  header1[0] = "Period";
  header1[1] = "Date";
  rows.push(header1);

  // "Hist Total" summary row.
  const histTotal = empty();
  histTotal[0] = "Hist Total";
  histTotal[1] = "Apr 15, 2026";
  rows.push(histTotal);

  // Second "Period|Date" header marker.
  const header2 = empty();
  header2[0] = "Period";
  header2[1] = "Date";
  rows.push(header2);

  // Period data rows.
  for (const p of opts.periods) {
    const r = empty();
    r[0] = String(p.periodIndex);
    r[1] = p.date;
    for (const t of opts.tranches) {
      const start = starts[t.className];
      const v = p.perTranche[t.className];
      if (!v) continue;
      if (v.principalPaid != null) r[start + 0] = String(v.principalPaid);
      if (v.interestPaid != null) r[start + 1] = String(v.interestPaid);
      if (v.endingBalance != null) r[start + 3] = String(v.endingBalance);
    }
    rows.push(r);
  }

  // Serialize CSV — quote any field that contains a comma or double-quote
  // (date strings like "Apr 15, 2026" must round-trip intact through
  // parseCsvRow's RFC-4180 handling).
  const escape = (c: string) =>
    /[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
  const finalRows = opts.truncateRowsToCols != null
    ? rows.map(r => r.slice(0, opts.truncateRowsToCols))
    : rows;
  return finalRows.map(r => r.map(escape).join(",")).join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const EURO_XV_TRANCHES: DealTrancheInfo[] = [
  { className: "Class A",            isFloating: true  },
  { className: "Class B-1",          isFloating: true  },
  { className: "Class B-2",          isFloating: false }, // 10-col fixed
  { className: "Class C",            isFloating: true  },
  { className: "Class D",            isFloating: true  },
  { className: "Class E",            isFloating: true  },
  { className: "Class F",            isFloating: true  },
  { className: "Subordinated Notes", isFloating: false }, // 10-col fixed
];

describe("parseIntexPastCashflows — schema-driven discovery", () => {
  it("Euro XV-shape CSV: discovers 8 tranches at expected columns + widths", () => {
    const csv = buildSyntheticCsv({
      dealName: "Ares European CLO XV (synthetic)",
      tranches: EURO_XV_TRANCHES,
      periods: [{
        periodIndex: 1,
        date: "Apr 15, 2026",
        perTranche: {
          "Class A":            { principalPaid: 0, interestPaid: 2298650, endingBalance: 310000000 },
          "Class B-1":          { principalPaid: 0, interestPaid: 200000,  endingBalance: 30000000 },
          "Class B-2":          { principalPaid: 0, interestPaid: 186662,  endingBalance: 15000000 },
          "Class C":            { principalPaid: 0, interestPaid: 334425,  endingBalance: 32500000 },
          "Class D":            { principalPaid: 0, interestPaid: 443953,  endingBalance: 34375000 },
          "Class E":            { principalPaid: 0, interestPaid: 520571,  endingBalance: 25625000 },
          "Class F":            { principalPaid: 0, interestPaid: 407475,  endingBalance: 15000000 },
          "Subordinated Notes": { principalPaid: 0, interestPaid: 0,       endingBalance: 42000000 },
        },
      }],
    });

    const result = parseIntexPastCashflows(csv, EURO_XV_TRANCHES);

    // Discovered tranches: 8, in order, with widths matching Euro XV's
    // documented layout (A=11, B-1=11, B-2=10, C=11, D=11, E=11, F=11, Sub=10).
    expect(result.discoveredTranches.map(b => ({ className: b.className, start: b.start, width: b.width, floating: b.floating }))).toEqual([
      { className: "Class A",            start: 39,  width: 11, floating: true  },
      { className: "Class B-1",          start: 50,  width: 11, floating: true  },
      { className: "Class B-2",          start: 61,  width: 10, floating: false },
      { className: "Class C",            start: 71,  width: 11, floating: true  },
      { className: "Class D",            start: 82,  width: 11, floating: true  },
      { className: "Class E",            start: 93,  width: 11, floating: true  },
      { className: "Class F",            start: 104, width: 11, floating: true  },
      { className: "Subordinated Notes", start: 115, width: 10, floating: false },
    ]);

    // One period parsed; class A interest read from the right column.
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].tranches.find(t => t.className === "Class A")?.interestPaid).toBe(2298650);
    expect(result.periods[0].tranches.find(t => t.className === "Class B-2")?.interestPaid).toBe(186662);
  });

  it("A-1 + A-2 split: discovers pari-passu seniors with their own widths", () => {
    // Sibling shape to Euro XV with a split senior. The resolver emits
    // A-1 and A-2 as two distinct rows; their normalized names differ, so
    // the validator's name set-diff pairs them 1:1 — no false-fire on
    // legitimate pari-passu structures.
    const tranches: DealTrancheInfo[] = [
      { className: "Class A-1",          isFloating: true  },
      { className: "Class A-2",          isFloating: true  },
      { className: "Class B",            isFloating: true  },
      { className: "Class C",            isFloating: true  },
      { className: "Subordinated Notes", isFloating: false },
    ];
    const csv = buildSyntheticCsv({
      dealName: "Synthetic A-1/A-2 split deal",
      tranches,
      periods: [{
        periodIndex: 1,
        date: "Apr 15, 2026",
        perTranche: {
          "Class A-1":          { interestPaid: 1500000, endingBalance: 200000000 },
          "Class A-2":          { interestPaid: 750000,  endingBalance: 100000000 },
          "Class B":            { interestPaid: 250000,  endingBalance: 30000000 },
          "Class C":            { interestPaid: 200000,  endingBalance: 25000000 },
          "Subordinated Notes": {},
        },
      }],
    });

    const result = parseIntexPastCashflows(csv, tranches);

    expect(result.discoveredTranches.map(b => b.className)).toEqual([
      "Class A-1", "Class A-2", "Class B", "Class C", "Subordinated Notes",
    ]);
    expect(result.periods[0].tranches.find(t => t.className === "Class A-1")?.interestPaid).toBe(1500000);
    expect(result.periods[0].tranches.find(t => t.className === "Class A-2")?.interestPaid).toBe(750000);
  });

  it("missing tranche: throws IntexSchemaMismatchError listing the gaps", () => {
    // Deal expects 8 tranches, CSV has 7 (no Class F).
    const seven = EURO_XV_TRANCHES.filter(t => t.className !== "Class F");
    const csv = buildSyntheticCsv({
      dealName: "Synthetic missing-Class-F deal",
      tranches: seven,
      periods: [],
    });

    expect(() => parseIntexPastCashflows(csv, EURO_XV_TRANCHES))
      .toThrowError(IntexSchemaMismatchError);

    try {
      parseIntexPastCashflows(csv, EURO_XV_TRANCHES);
    } catch (e) {
      expect(e).toBeInstanceOf(IntexSchemaMismatchError);
      const err = e as IntexSchemaMismatchError;
      expect(err.diff.kind).toBe("missing_tranches");
      expect(err.diff.missing).toEqual(["Class F"]);
    }
  });

  it("extra tranche in CSV: throws IntexSchemaMismatchError naming the unknown cell", () => {
    // CSV contains a Class G the deal doesn't know about.
    const csv = buildSyntheticCsv({
      dealName: "Synthetic extra-tranche deal",
      tranches: EURO_XV_TRANCHES,
      periods: [],
      // Inject an "extra" Class G label at the column right after Sub Notes.
      injectExtraTranche: { name: "Class G", column: 125 },
    });

    expect(() => parseIntexPastCashflows(csv, EURO_XV_TRANCHES))
      .toThrowError(IntexSchemaMismatchError);

    try {
      parseIntexPastCashflows(csv, EURO_XV_TRANCHES);
    } catch (e) {
      const err = e as IntexSchemaMismatchError;
      expect(err.diff.kind).toBe("unknown_tranche");
      expect(err.diff.cell).toBe("Class G");
    }
  });

  it("positional independence: discovers tranches when first block starts at col 41 (not 39)", () => {
    // The legacy parser hardcoded col 39 as Class A's start. This test shifts
    // ALL tranche starts by +2 (so first block is at col 41), proving
    // discovery is genuinely content-driven and the col-39 sentinel is gone.
    // Inner block widths (10/11) and trailing block remain unchanged because
    // they're sourced from deal isFloating, not from positions.
    const csv = buildSyntheticCsv({
      dealName: "Synthetic shifted-layout deal",
      tranches: EURO_XV_TRANCHES,
      periods: [{
        periodIndex: 1,
        date: "Apr 15, 2026",
        perTranche: {
          "Class A":            { interestPaid: 999999 },
          "Class B-1":          { interestPaid: 111 },
          "Class B-2":          { interestPaid: 222 },
          "Class C":            { interestPaid: 333 },
          "Class D":            { interestPaid: 444 },
          "Class E":            { interestPaid: 555 },
          "Class F":            { interestPaid: 666 },
          "Subordinated Notes": { interestPaid: 0 },
        },
      }],
      overrideTrancheStarts: {
        "Class A":            41, // legacy was 39 — shift +2
        "Class B-1":          52, // legacy was 50
        "Class B-2":          63, // legacy was 61
        "Class C":            73, // legacy was 71
        "Class D":            84,
        "Class E":            95,
        "Class F":            106,
        "Subordinated Notes": 117,
      },
    });

    const result = parseIntexPastCashflows(csv, EURO_XV_TRANCHES);

    expect(result.discoveredTranches.map(b => ({ className: b.className, start: b.start, width: b.width }))).toEqual([
      { className: "Class A",            start: 41,  width: 11 },
      { className: "Class B-1",          start: 52,  width: 11 },
      { className: "Class B-2",          start: 63,  width: 10 },
      { className: "Class C",            start: 73,  width: 11 },
      { className: "Class D",            start: 84,  width: 11 },
      { className: "Class E",            start: 95,  width: 11 },
      { className: "Class F",            start: 106, width: 11 },
      { className: "Subordinated Notes", start: 117, width: 10 },
    ]);

    // Sanity: Class A's interest pulled from the new column (41 + OFF_INTEREST=1 = 42), not the legacy 40.
    expect(result.periods[0].tranches.find(t => t.className === "Class A")?.interestPaid).toBe(999999);
  });

  it("naming variant: CSV says 'Sub Notes', deal says 'Subordinated Notes' — both normalize to 'sub' and match", () => {
    // Real Intex exports vary on sub-tranche naming. The parser must accept
    // any of {Subordinated Notes, Sub Notes, Sub Loan Notes, Equity, ...}
    // when the deal carries the canonical "Subordinated Notes" entry.
    const csv = buildSyntheticCsv({
      dealName: "Synthetic Sub-naming-variant deal",
      tranches: EURO_XV_TRANCHES,
      periods: [{
        periodIndex: 1,
        date: "Apr 15, 2026",
        perTranche: {
          "Class A":            { interestPaid: 1 },
          "Class B-1":          { interestPaid: 1 },
          "Class B-2":          { interestPaid: 1 },
          "Class C":            { interestPaid: 1 },
          "Class D":            { interestPaid: 1 },
          "Class E":            { interestPaid: 1 },
          "Class F":            { interestPaid: 1 },
          "Subordinated Notes": { interestPaid: 0, endingBalance: 42_000_000 },
        },
      }],
      overrideGroupRowName: {
        "Subordinated Notes": "Sub Notes", // CSV variant; deal canonical
      },
    });

    const result = parseIntexPastCashflows(csv, EURO_XV_TRANCHES);
    expect(result.discoveredTranches.map(b => b.className)).toContain("Subordinated Notes");
    // Snapshot uses the CANONICAL deal className (not the CSV variant), so
    // downstream ingest matches `clo_tranches.class_name` regardless of
    // which naming variant the trustee used.
    const sub = result.periods[0].tranches.find(t => t.className === "Subordinated Notes");
    expect(sub?.endingBalance).toBe(42_000_000);
  });

  it("trailing block truncated: throws when CSV row is shorter than expected trailing-block end", () => {
    // Deal expects Sub Notes (10-col fixed) at col 115 → block ends at 124.
    // Truncate the CSV to 122 columns: trailing block can't fit. Must throw,
    // not silently read OC/IC test cells into Sub Notes' fields.
    const csv = buildSyntheticCsv({
      dealName: "Synthetic truncated-trailing deal",
      tranches: EURO_XV_TRANCHES,
      periods: [],
      truncateRowsToCols: 122,
    });

    expect(() => parseIntexPastCashflows(csv, EURO_XV_TRANCHES))
      .toThrowError(IntexSchemaMismatchError);

    try {
      parseIntexPastCashflows(csv, EURO_XV_TRANCHES);
    } catch (e) {
      const err = e as IntexSchemaMismatchError;
      expect(err.diff.kind).toBe("trailing_block_truncated");
      expect(err.diff.className).toBe("Subordinated Notes");
      expect(err.diff.expected).toBe(10);
    }
  });

  it("width mismatch: throws when CSV block width disagrees with deal isFloating", () => {
    // Place Class A at col 39 and Class B-1 at col 49 (delta=10), but the
    // deal says A is floating → expected width 11. Validator must throw.
    const csv = buildSyntheticCsv({
      dealName: "Synthetic width-mismatch deal",
      tranches: EURO_XV_TRANCHES,
      periods: [],
      overrideTrancheStarts: {
        "Class A":            39,
        "Class B-1":          49, // delta = 10, expected 11
        "Class B-2":          60,
        "Class C":            70,
        "Class D":            81,
        "Class E":            92,
        "Class F":            103,
        "Subordinated Notes": 114,
      },
    });

    expect(() => parseIntexPastCashflows(csv, EURO_XV_TRANCHES))
      .toThrowError(IntexSchemaMismatchError);

    try {
      parseIntexPastCashflows(csv, EURO_XV_TRANCHES);
    } catch (e) {
      const err = e as IntexSchemaMismatchError;
      expect(err.diff.kind).toBe("width_mismatch");
      expect(err.diff.className).toBe("Class A");
      expect(err.diff.expected).toBe(11);
      expect(err.diff.actual).toBe(10);
    }
  });

  it("real Intex layout: rejects compliance-test row above bare-tranche group row", () => {
    // Mirrors the actual Ares XV Intex Past Cashflows CSV (rows 8-11):
    //   Row 8: section-header row with compliance-test labels like
    //          "Class A/B Par Value Test", "Class A/B Interest Coverage
    //          Test", "Class C Par Value Test", etc.
    //   Row 9: subgroup row with bare-letter tranche labels: "A", "B1",
    //          "B2", "C", "D", "E", "F", "SUBORD".
    //   Row 10: column-name row ("Principal", "Interest", ...).
    //   Row 11: "Period|Date" pivot marker.
    //
    // Two invariants:
    //   1. The parser must pick Row 9 as the group row (real tranches),
    //      NOT Row 8 (compliance tests). Pre-fix, the loose
    //      `looksLikeTrancheName` predicate accepted "Class A/B Interest
    //      Coverage Test" and `normalizeClassName` collapsed it to "a",
    //      colliding with the deal's Class A and surfacing as a
    //      `duplicate_match` error at column 140-ish.
    //   2. The parser must match bare-letter labels ("B1") to the deal's
    //      hyphenated form ("Class B-1") via the same normalization key.
    //      Without this, fixing (1) alone surfaces as a
    //      `missing_tranches` error for Class B-1 / Class B-2.
    //
    // Asserts both: success and exactly 8 tranches discovered in the
    // expected order from Row 9.

    const FIRST_TRANCHE_COL = 39;
    const totalCols = 200; // leaves room for compliance-test labels in cols 140+
    const empty = (): string[] => Array.from({ length: totalCols }, () => "");

    const rows: string[][] = [];
    // Preamble (3 metadata rows).
    const p1 = empty(); p1[0] = "Ares European CLO XV (synthetic real-shape)"; rows.push(p1);
    const p2 = empty(); p2[0] = "Deal Name:"; p2[1] = "ARESEU15"; rows.push(p2);
    const p3 = empty(); p3[0] = "Settlement"; p3[1] = "Dec 14, 2021"; rows.push(p3);

    // Row index 3 (file line 4): section-header row mirroring real Row 8
    // — compliance-test labels at columns 140+. These would have been
    // matched as tranches under the loose pre-fix predicate.
    const sectionHeader = empty();
    sectionHeader[39] = "Bonds";
    sectionHeader[135] = "Classes";
    sectionHeader[140] = "Class A/B Par Value Test";
    sectionHeader[145] = "Class A/B Interest Coverage Test";
    sectionHeader[150] = "Class C Par Value Test";
    sectionHeader[155] = "Class C Interest Coverage Test";
    sectionHeader[160] = "Class D Par Value Test";
    sectionHeader[165] = "Class D Interest Coverage Test";
    sectionHeader[170] = "Class E Par Value Test";
    sectionHeader[175] = "Class F Par Value Test";
    sectionHeader[180] = "Interest Diversion Test";
    sectionHeader[185] = "Event of Default Trigger";
    rows.push(sectionHeader);

    // Row index 4: subgroup row mirroring real Row 9 — bare-letter tranche
    // labels at the per-tranche cashflow block starts.
    const subgroup = empty();
    subgroup[39]  = "A";       // floating, width 11
    subgroup[50]  = "B1";      // floating, width 11
    subgroup[61]  = "B2";      // fixed, width 10
    subgroup[71]  = "C";       // floating, width 11
    subgroup[82]  = "D";       // floating, width 11
    subgroup[93]  = "E";       // floating, width 11
    subgroup[104] = "F";       // floating, width 11
    subgroup[115] = "SUBORD";  // fixed, width 10
    rows.push(subgroup);

    // Row index 5: column-name row (Principal/Interest/etc.). Discovery
    // doesn't read this — it just needs to NOT contain tranche-shaped
    // labels.
    const colNames = empty();
    colNames[39] = "Principal";
    colNames[40] = "Interest";
    colNames[43] = "Balance";
    rows.push(colNames);

    // Row index 6: first "Period|Date" marker (discovery anchor).
    const header1 = empty();
    header1[0] = "Period"; header1[1] = "Date";
    rows.push(header1);

    // Row index 7: Hist Total summary row.
    const histTotal = empty();
    histTotal[0] = "Hist Total"; histTotal[1] = "Apr 15, 2026";
    rows.push(histTotal);

    // Row index 8: second "Period|Date" header marker (data anchor).
    const header2 = empty();
    header2[0] = "Period"; header2[1] = "Date";
    rows.push(header2);

    // Row index 9: one period of data so the parser exits the discovery
    // path cleanly and produces a parseable result.
    const periodData = empty();
    periodData[0] = "1";
    periodData[1] = "Apr 15, 2026";
    periodData[40] = "2298650"; // Class A interest paid (start=39, OFF_INTEREST=1)
    rows.push(periodData);

    const escape = (c: string) =>
      /[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
    const csv = rows.map(r => r.map(escape).join(",")).join("\n");

    const result = parseIntexPastCashflows(csv, EURO_XV_TRANCHES);

    // Invariant 1: tranches discovered from Row 9 (subgroup), not Row 8
    // (section header). Order matches the real CSV layout.
    expect(result.discoveredTranches.map(b => b.className)).toEqual([
      "Class A",
      "Class B-1",
      "Class B-2",
      "Class C",
      "Class D",
      "Class E",
      "Class F",
      "Subordinated Notes",
    ]);

    // Invariant 2: per-tranche block starts match the subgroup row's
    // bare-letter column positions, NOT the section-header row's
    // compliance-test positions (which would put Class A at column 140+).
    expect(result.discoveredTranches.find(b => b.className === "Class A")?.start).toBe(39);
    expect(result.discoveredTranches.find(b => b.className === "Class B-1")?.start).toBe(50);
    expect(result.discoveredTranches.find(b => b.className === "Subordinated Notes")?.start).toBe(115);

    // Period data round-trips: Class A interest pulled from start+1=40.
    expect(result.periods[0].tranches.find(t => t.className === "Class A")?.interestPaid).toBe(2298650);
  });
});
