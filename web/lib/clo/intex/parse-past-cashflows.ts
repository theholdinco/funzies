import { parseCsvRow, parseNumeric } from "../sdf/csv-utils";
import { normalizeClassName } from "../normalize-class-name";

export { normalizeClassName };

/**
 * Parser for the Intex "Past Cashflows" xlsx, exported as CSV.
 *
 * The sheet "DealCF-MV+" has a rigid column layout with three header rows
 * (group / subgroup / column label) and multi-line metadata at the top, then
 * per-period rows starting after a row with "Period" / "Date" in the first
 * two cells. We key off that marker and read data rows positionally — the
 * column layout is fixed across deals using this Intex report template
 * EXCEPT for per-tranche block widths and tranche-name placement, which are
 * deal-specific. Tranche blocks are discovered from the CSV's own group-
 * label row at parse time and validated against the deal's tranche list.
 *
 * Column layout (0-indexed, deal-invariant section):
 *   0: Period index ("0", "1", ..., or blank for summary rows)
 *   1: Date (e.g. "Dec 15, 2021" or "07/15/2022")
 *   2-21: Collateral block (aggregate principal/interest/balance/etc.)
 *   22-23: Deal balance / factor
 *   24-35: Expenses (senior, sr-mgmt, sub-mgmt, incentive — each Due/Paid/Unpaid)
 *   36-38: Interest smoothing
 *   39-...: Per-tranche blocks (deal-specific; see discoverTrancheBlocks)
 *   ...: OC/IC tests, EoD triggers, EURIBOR series after the last tranche block
 */

export interface IntexTrancheSnapshot {
  className: string;
  principalPaid: number | null;
  interestPaid: number | null;
  endingBalance: number | null;
  interestShortfall: number | null;
  cumulativeShortfall: number | null;
  principalWritedown: number | null;
  accumPrincipalWritedown: number | null;
  rateResetIndex: number | null;
}

export interface IntexPeriodRow {
  periodIndex: number;
  date: string; // ISO YYYY-MM-DD
  collateralPrincipal: number | null;
  collateralInterest: number | null;
  collateralBalance: number | null;
  netLoss: number | null;
  senior_mgmt_fee_paid: number | null;
  sub_mgmt_fee_paid: number | null;
  incentive_fee_paid: number | null;
  tranches: IntexTrancheSnapshot[];
}

/**
 * Scenario inputs Intex carries in the "Assumptions" preamble block (rows
 * 32-72 of the DealCF-MV+ sheet). These drive the past-cashflow projection
 * and are the only audit-trail of "what scenario produced these numbers."
 *
 * We pre-fill the engine's user-facing sliders from these so engine output
 * can be compared apples-to-apples against the Intex distributions.
 */
export interface IntexAssumptions {
  scenario: string | null;            // e.g. "MV +"
  ratesAsOf: string | null;           // e.g. "Apr 20, 2026 04:12:47"
  cprPct: number | null;              // e.g. 20 (from "20 CPR")
  cdrPct: number | null;              // e.g. 2  (from "2 CDR")
  recoveryPct: number | null;         // e.g. 75 (from "75 Percent")
  recoveryLagMonths: number | null;   // e.g. 0  (from "0 Months")
  optionalRedemption: string | null;  // e.g. "ReinvEnd+24"
  reinvestSpreadPct: number | null;   // e.g. 3.625
  reinvestMaturityMonths: number | null; // e.g. 60
  reinvestPricePct: number | null;    // e.g. 99.75
  reinvestRecoveryRatePct: number | null; // e.g. 30
  collateralLiquidationPricePct: number | null; // e.g. 95.304
  // Forward EURIBOR curves — comma-separated monthly points
  euribor1m: number[] | null;
  euribor2m: number[] | null;
  euribor3m: number[] | null;
  euribor6m: number[] | null;
}

export interface DiscoveredTrancheBlock {
  className: string;     // canonical, sourced from dealTranches
  start: number;         // 0-indexed CSV column of the block's first cell
  width: number;         // 11 (floating) or 10 (fixed)
  floating: boolean;
}

export interface IntexParseResult {
  dealName: string | null;
  dealCode: string | null;
  settlementDate: string | null;
  reportCreated: string | null;
  assumptions: IntexAssumptions | null;
  periods: IntexPeriodRow[];
  discoveredTranches: DiscoveredTrancheBlock[];
}

/** Minimal deal-tranche shape required by the parser to discover & validate
 *  per-tranche column blocks. Sourced by the ingest path from
 *  `clo_tranches` (class_name + is_floating) before the parser is called. */
export interface DealTrancheInfo {
  className: string;
  isFloating: boolean;
}

/** Thrown when the Intex CSV's discovered tranche structure does not match
 *  the deal's tranche list (missing tranches, extra tranches, or per-block
 *  width inconsistent with the deal's isFloating flag). The ingest path
 *  catches this before BEGIN so no DB write occurs; the API route maps it
 *  to a 422 response. */
export class IntexSchemaMismatchError extends Error {
  readonly diff: Record<string, unknown>;
  constructor(diff: Record<string, unknown> & { message: string }) {
    super(diff.message);
    this.name = "IntexSchemaMismatchError";
    this.diff = diff;
  }
}

// ---------------------------------------------------------------------------
// Within a tranche block, these are the offsets from the block start. These
// ARE part of the Intex DealCF-MV+ template (deal-invariant) and stay as
// constants. Block START positions and widths are discovered from the
// header row at parse time; only the within-block layout is fixed.
// ---------------------------------------------------------------------------
const OFF_PRINCIPAL              = 0;
const OFF_INTEREST               = 1;
// OFF_CASHFLOW is 2 — derived, skipped
const OFF_BALANCE                = 3;
const OFF_INTEREST_SHORTFALL     = 4;
const OFF_ACCUM_INT_SHORTFALL    = 5;
const OFF_PRINC_WRITEDOWN        = 6;
// OFF_PREPAY_PENALTY is 7 — skipped
// OFF_IMPLIED_WRITEDOWN is 8 — skipped
const OFF_ACCUM_PRINC_WRITEDOWN  = 9;
const OFF_RATE_RESET             = 10;

// Aggregate "Collateral" block offsets (at the front of the row).
const COL_COLLAT_PRINCIPAL = 2;
const COL_COLLAT_INTEREST  = 3;
const COL_COLLAT_BALANCE   = 7;
const COL_NET_LOSS         = 8;
// Senior mgmt fee paid lives in the Sen_Mgmt_Fee subgroup → column 27 (Current Paid)
const COL_SEN_MGMT_PAID    = 27;
const COL_SUB_MGMT_PAID    = 30;
const COL_INCENTIVE_PAID   = 33;

/** First column at which per-tranche blocks begin in the Intex DealCF-MV+
 *  template. Anything before this column belongs to the deal-invariant
 *  prefix (collateral/expenses/smoothing). Used as the lower bound for
 *  tranche-name discovery in the group row. */
const FIRST_TRANCHE_COL = 22;

// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Parse dates Intex uses: "Dec 15, 2021", "Jul 15, 2022", "07/15/2022", "2022-07-15". */
function parseIntexDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // ISO pass-through
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // "Dec 15, 2021" or "Jul 15 2022"
  const named = s.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/);
  if (named) {
    const mon = MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (mon) return `${named[3]}-${mon}-${named[2].padStart(2, "0")}`;
  }
  // "7/15/2022" US format
  const us = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return null;
}

/** Read a per-tranche slice starting at `start`. `floating` governs whether
 *  we pull a Rate Reset Index value from offset 10. */
function readTrancheBlock(
  cells: string[],
  className: string,
  start: number,
  floating: boolean,
): IntexTrancheSnapshot {
  return {
    className,
    principalPaid:           parseNumeric(cells[start + OFF_PRINCIPAL]),
    interestPaid:            parseNumeric(cells[start + OFF_INTEREST]),
    endingBalance:           parseNumeric(cells[start + OFF_BALANCE]),
    interestShortfall:       parseNumeric(cells[start + OFF_INTEREST_SHORTFALL]),
    cumulativeShortfall:     parseNumeric(cells[start + OFF_ACCUM_INT_SHORTFALL]),
    principalWritedown:      parseNumeric(cells[start + OFF_PRINC_WRITEDOWN]),
    accumPrincipalWritedown: parseNumeric(cells[start + OFF_ACCUM_PRINC_WRITEDOWN]),
    rateResetIndex:          floating ? parseNumeric(cells[start + OFF_RATE_RESET]) : null,
  };
}

/** Strict standalone tranche-label predicate. Used to locate the group
 *  row above the first "Period|Date" marker AND to gate the discovery
 *  walk's unknown-tranche fail-loud.
 *
 *  CRITICAL: must NOT accept compliance/coverage test labels even when
 *  they begin with a tranche-like token ("Class A/B Interest Coverage
 *  Test", "Class C Par Value Test"). The original loose predicate
 *  `/^class\s+\w/` matched those, causing the Ares XV Intex Past
 *  Cashflows CSV to pick the compliance-test section header row instead
 *  of the bare-letter tranche subgroup row — `normalizeClassName` then
 *  collapsed every "Class X/Y Test" label to a single-letter key
 *  colliding with real deal tranches and surfacing as
 *  `duplicate_match`.
 *
 *  Strategy: lowercase + trim + strip optional "Class " or "Class-"
 *  prefix + strip optional trailing " Notes" suffix, then assert the
 *  remaining "core" is a tight tranche-identifier shape with no
 *  trailing words. Accepts the SDF-canonical forms (`Class A`,
 *  `Class B-1`, `Subordinated Notes`), the bare-letter Intex forms
 *  (`A`, `B1`, `B-1`), the hyphenated short form (`Class-B`), and the
 *  `SUBORD` / `SUBORD@12%` abbreviations seen in Ares XV's CSV.
 *  Rejects any "core" that still contains spaces, slashes, or
 *  compliance/test/coverage/trigger words. */
function looksLikeTrancheName(s: string): boolean {
  const t = (s ?? "").trim().toLowerCase();
  if (!t) return false;
  // Strip optional "Class " prefix (SPACE only — `Class-B` with hyphen is
  // a derived metric label in Intex exports, not a real tranche) and
  // optional trailing " Notes" suffix. Core must then be an exact-shape
  // tranche identifier — no trailing words, no `@hurdle` suffix, no
  // slashes. Rejects compliance-test labels ("Class A/B Interest Coverage
  // Test"), incentive-fee trackers ("SUBORD@12%"), and combined-class
  // derived metrics ("Class-B" alongside real "Class B-1" / "Class B-2"
  // in the same row).
  const core = t
    .replace(/^class\s+/, "")
    .replace(/[-\s]+notes?$/, "")
    .trim();
  return (
    /^subordinated$/.test(core) ||
    /^sub$/.test(core) ||
    /^equity$/.test(core) ||
    /^income$/.test(core) ||
    /^subord$/.test(core) ||
    /^[a-z](-?\d+)?$/.test(core)
  );
}

/**
 * Discover per-tranche column blocks from the CSV's own group-label row
 * and validate the discovered structure against the deal's tranche list.
 *
 * Throws `IntexSchemaMismatchError` on:
 * - No locatable group row above the first "Period|Date" marker.
 * - A tranche in the deal that has no matching block in the CSV.
 * - A tranche-named cell in the CSV that doesn't match any deal tranche.
 * - The same deal tranche matched in two different columns.
 * - An inner block whose actual width (next-start − this-start) disagrees
 *   with the width implied by the deal tranche's `isFloating` (10 fixed,
 *   11 floating). The trailing block's width is taken from deal authority
 *   directly.
 *
 * No `col 39` or `Rate Reset` label parsing — width comes from deal
 * isFloating, block starts come from content matching against deal names.
 */
function discoverTrancheBlocks(
  rows: string[][],
  firstHeaderIdx: number,
  dealTranches: DealTrancheInfo[],
): DiscoveredTrancheBlock[] {
  // Locate the group row: scan up to 4 rows above the first "Period|Date"
  // marker for one containing at least 2 tranche-name cells.
  let groupRowIdx = -1;
  for (let offset = 1; offset <= 4; offset++) {
    const candidate = rows[firstHeaderIdx - offset];
    if (!candidate) continue;
    let count = 0;
    for (const c of candidate) if (looksLikeTrancheName(c)) count++;
    if (count >= 2) { groupRowIdx = firstHeaderIdx - offset; break; }
  }
  if (groupRowIdx < 0) {
    throw new IntexSchemaMismatchError({
      kind: "no_group_row",
      firstHeaderIdx,
      message: `Could not locate the tranche group-label row within 4 rows above the first "Period|Date" marker (row ${firstHeaderIdx}). The CSV is not a recognizable Intex DealCF-MV+ export.`,
    });
  }

  const groupRow = rows[groupRowIdx];

  // Build deal-side normalization map.
  const dealByNorm = new Map<string, DealTrancheInfo>();
  for (const t of dealTranches) {
    const norm = normalizeClassName(t.className);
    if (dealByNorm.has(norm)) {
      throw new IntexSchemaMismatchError({
        kind: "duplicate_deal_tranche",
        className: t.className,
        message: `Deal tranche list has two entries normalizing to "${norm}" (e.g. "${t.className}" + a sibling). Cannot disambiguate.`,
      });
    }
    dealByNorm.set(norm, t);
  }

  // Walk the group row from the first-tranche-column boundary; collect
  // candidate block starts. Tranche-named cells that don't match any deal
  // tranche are reported as unknown-tranche errors (extras).
  type Candidate = { rawName: string; start: number; deal: DealTrancheInfo };
  const candidates: Candidate[] = [];
  const seenDealNorms = new Set<string>();
  for (let col = FIRST_TRANCHE_COL; col < groupRow.length; col++) {
    const cell = (groupRow[col] ?? "").trim();
    if (!cell || !looksLikeTrancheName(cell)) continue;
    const norm = normalizeClassName(cell);
    const deal = dealByNorm.get(norm);
    if (!deal) {
      throw new IntexSchemaMismatchError({
        kind: "unknown_tranche",
        cell,
        normalizedAs: norm,
        column: col,
        message: `Intex CSV column ${col} contains tranche name "${cell}" (normalized "${norm}") but the deal has no matching tranche.`,
      });
    }
    if (seenDealNorms.has(norm)) {
      throw new IntexSchemaMismatchError({
        kind: "duplicate_match",
        cell,
        normalizedAs: norm,
        column: col,
        message: `Tranche "${deal.className}" matched in multiple columns of the Intex CSV (latest at column ${col}, "${cell}").`,
      });
    }
    seenDealNorms.add(norm);
    candidates.push({ rawName: cell, start: col, deal });
  }

  // Every deal tranche must have a candidate.
  const missing: string[] = [];
  for (const t of dealTranches) {
    if (!seenDealNorms.has(normalizeClassName(t.className))) missing.push(t.className);
  }
  if (missing.length > 0) {
    throw new IntexSchemaMismatchError({
      kind: "missing_tranches",
      missing,
      groupRowIdx,
      message: `Intex CSV's tranche group row does not contain matching cells for deal tranche${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
    });
  }

  // Sort by start position (defensive — should already be ordered) and
  // build the final block list, validating widths along the way.
  candidates.sort((a, b) => a.start - b.start);

  const blocks: DiscoveredTrancheBlock[] = [];
  // Trailing-block boundary check: derive the longest row length so we can
  // detect a CSV where the trailing tranche's expected end exceeds the
  // CSV's true column count (would otherwise silently read OC/IC test
  // cells into the trailing tranche's per-block fields).
  //
  // Plain loop avoids `Math.max(...[])` returning `-Infinity` on an empty
  // input AND avoids a `Math.max(...veryLargeArray)` stack-smash on
  // future stress fixtures with 65k+ rows.
  let dataRowLength = 0;
  for (const r of rows) {
    const len = r?.length ?? 0;
    if (len > dataRowLength) dataRowLength = len;
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const expectedWidth = c.deal.isFloating ? 11 : 10;
    const next = candidates[i + 1];
    if (next) {
      const actualWidth = next.start - c.start;
      if (actualWidth !== expectedWidth) {
        throw new IntexSchemaMismatchError({
          kind: "width_mismatch",
          className: c.deal.className,
          isFloating: c.deal.isFloating,
          expected: expectedWidth,
          actual: actualWidth,
          start: c.start,
          nextStart: next.start,
          message: `Tranche "${c.deal.className}" expected width ${expectedWidth} (isFloating=${c.deal.isFloating}) but the CSV block spans ${actualWidth} columns (start ${c.start} → next ${next.start}).`,
        });
      }
    }
    // Trailing block: width comes from deal authority. Guard the CSV
    // actually has enough columns — a too-short trailing block would
    // read OC/IC test cells into per-tranche fields silently.
    if (!next && dataRowLength < c.start + expectedWidth) {
      throw new IntexSchemaMismatchError({
        kind: "trailing_block_truncated",
        className: c.deal.className,
        isFloating: c.deal.isFloating,
        expected: expectedWidth,
        availableCols: dataRowLength - c.start,
        start: c.start,
        message: `Trailing tranche "${c.deal.className}" needs ${expectedWidth} columns from start ${c.start} (isFloating=${c.deal.isFloating}) but the CSV's longest row has only ${dataRowLength - c.start} columns available there. The CSV is truncated relative to the deal's tranche structure.`,
      });
    }
    blocks.push({
      className: c.deal.className,
      start: c.start,
      width: expectedWidth,
      floating: c.deal.isFloating,
    });
  }

  return blocks;
}

/** Metadata rows in the sheet preamble: "Key:,,,Value". */
function scrapeMetaValue(rows: string[][], key: string): string | null {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const first = rows[i][0]?.trim() ?? "";
    if (first.toLowerCase().startsWith(key.toLowerCase())) {
      // Value is the first non-empty cell after the label
      for (let j = 1; j < rows[i].length; j++) {
        const v = rows[i][j]?.trim();
        if (v) return v;
      }
    }
  }
  return null;
}

/** Find the first row whose first cell matches `label` (case-insensitive,
 *  whitespace-trimmed) and return the first non-empty cell after column 1.
 *  Returns null when not found. The Intex sheet has the assumptions block
 *  AFTER the period data (rows 32-72 in the export), so we scan the whole
 *  file rather than constraining to the preamble. */
function findAssumptionValue(rows: string[][], label: string): string | null {
  const want = label.toLowerCase().trim();
  for (let i = 0; i < rows.length; i++) {
    const first = (rows[i][0] ?? "").trim().toLowerCase();
    if (first === want) {
      for (let j = 2; j < rows[i].length; j++) {
        const v = (rows[i][j] ?? "").trim();
        if (v) return v;
      }
    }
  }
  return null;
}

/** Parse "20 CPR" / "2 CDR" / "75 Percent" / "0 Months" — return numeric
 * portion. Locale-permissive digit capture so European "75,5 Percent" parses
 * as 75.5 (the original `^(-?\d+(?:\.\d+)?)` truncated at the comma → 75).
 */
// Underscore-prefixed export = "private to this module's logic, exposed only
// for unit testing." Production callers stay inside this file.
//
// Strict-decimal shape: captures `digits, optional [.,] decimal, digits`. The
// Intex preamble emits simple numbers ("20", "3.625", "75,5") — never
// thousands-formatted multi-group values like "1,234,567". So we don't route
// through parseNumeric (which would mis-classify "3.625" as canonical
// thousands → 3625). Locale-aware just on the decimal separator: replace any
// comma with dot and parseFloat.
export function _parseLeadingNumber(s: string | null): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(-?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(",", "."));
  return isNaN(num) ? null : num;
}
const parseLeadingNumber = _parseLeadingNumber;

/** Parse a space- or comma-separated EURIBOR series ("1.996 2.035 ...") into
 *  number[]. Pragmatic locale assumption: Intex is an English-language tool;
 *  exports observed in production use American format (`.` as decimal). A
 *  European-locale Intex export ("1,996 2,035") would mis-parse here because
 *  splitting on commas destroys the decimal. Magnitude check below catches
 *  the obvious wrong-shape outcome (Euribor outside [-2, 10]) so a silent
 *  mis-parse surfaces at ingest rather than as wrong forward rates downstream.
 */
export function _parseEuriborSeries(s: string | null): number[] | null {
  if (!s) return null;
  // Locale guard: split on `[\s,]+` assumes commas are token separators (American
  // form). For European-locale Intex exports, commas are the DECIMAL separator,
  // so splitting destroys precision. Detect by counting separators: if there
  // are more commas than dots, the input is European-shaped and we cannot
  // safely split. The magnitude tripwire below catches large-value mis-parses
  // ("1,996" → tokens 1, 996), but cannot catch small-value mis-parses
  // ("0,5 1,2" → tokens 0, 5, 1, 2 — all within the [-2, 10] safety range yet
  // entirely wrong). Comma-vs-dot count covers both.
  const commaCount = (s.match(/,/g) || []).length;
  const dotCount = (s.match(/\./g) || []).length;
  if (commaCount > dotCount) {
    console.warn(
      `[parseEuriborSeries] more commas (${commaCount}) than dots (${dotCount}) — ` +
        `likely European-locale Intex export. Cannot safely split on commas when ` +
        `commas are the decimal separator. Series rejected (null).`,
    );
    return null;
  }
  const tokens = s.split(/[\s,]+/).filter((t) => t.length > 0);
  const nums: number[] = [];
  for (const t of tokens) {
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  if (nums.length === 0) return null;
  // Magnitude tripwire: realistic Euribor history is roughly [-1, 5]; with a
  // safety margin we reject anything outside [-2, 10]. Belt-and-braces with
  // the comma-vs-dot guard above — catches any locale-confusion that slips
  // past the count check (e.g. mixed-format inputs where comma count alone
  // is ambiguous).
  const outOfRange = nums.find((n) => n < -2 || n > 10);
  if (outOfRange !== undefined) {
    console.warn(
      `[parseEuriborSeries] value ${outOfRange} outside realistic range [-2, 10]. ` +
        `Likely parser failure or stress-scenario beyond Euribor history. ` +
        `Series rejected (null) — investigate the source preamble.`,
    );
    return null;
  }
  return nums;
}
const parseEuriborSeries = _parseEuriborSeries;

function extractAssumptions(rows: string[][]): IntexAssumptions | null {
  const scenario = findAssumptionValue(rows, "Scenario");
  const ratesAsOf = findAssumptionValue(rows, "Rates as of");
  const cprPct = parseLeadingNumber(findAssumptionValue(rows, "Prepay"));
  const cdrPct = parseLeadingNumber(findAssumptionValue(rows, "Default"));
  const recoveryPct = parseLeadingNumber(findAssumptionValue(rows, "Recovery"));
  const recoveryLagMonths = parseLeadingNumber(findAssumptionValue(rows, "Recovery Lag"));
  const optionalRedemption = findAssumptionValue(rows, "Optional Redemption");
  // Reinvest fields — labels are indented with leading spaces in the sheet, so
  // findAssumptionValue trims them away via .trim() in the comparison.
  const reinvestSpreadPct = parseLeadingNumber(findAssumptionValue(rows, "Spread (%) (1)"));
  const reinvestMaturityMonths = parseLeadingNumber(findAssumptionValue(rows, "Maturity / Mat. Date (1)"));
  const reinvestPricePct = parseLeadingNumber(findAssumptionValue(rows, "Price (1)"));
  const reinvestRecoveryRatePct = parseLeadingNumber(findAssumptionValue(rows, "Rating Agency Recovery Rate (1)"));
  const collateralLiquidationPricePct = parseLeadingNumber(findAssumptionValue(rows, "Collateral Liquidation Price"));
  const euribor1m = parseEuriborSeries(findAssumptionValue(rows, "EURIBOR (1mo)"));
  const euribor2m = parseEuriborSeries(findAssumptionValue(rows, "EURIBOR (2mo)"));
  const euribor3m = parseEuriborSeries(findAssumptionValue(rows, "EURIBOR (3mo)"));
  const euribor6m = parseEuriborSeries(findAssumptionValue(rows, "EURIBOR (6mo)"));

  // If literally none of the assumption-block fields parsed, return null so
  // downstream consumers can distinguish "no assumption block" from "block
  // present but partially extracted".
  const present = [scenario, ratesAsOf, cprPct, cdrPct, recoveryPct, recoveryLagMonths,
                   optionalRedemption, reinvestSpreadPct, reinvestMaturityMonths,
                   reinvestPricePct, reinvestRecoveryRatePct, collateralLiquidationPricePct,
                   euribor1m, euribor2m, euribor3m, euribor6m].some((v) => v != null);
  if (!present) return null;

  return {
    scenario,
    ratesAsOf,
    cprPct,
    cdrPct,
    recoveryPct,
    recoveryLagMonths,
    optionalRedemption,
    reinvestSpreadPct,
    reinvestMaturityMonths,
    reinvestPricePct,
    reinvestRecoveryRatePct,
    collateralLiquidationPricePct,
    euribor1m,
    euribor2m,
    euribor3m,
    euribor6m,
  };
}

export function parseIntexPastCashflows(
  csvText: string,
  dealTranches: DealTrancheInfo[],
): IntexParseResult {
  const cleaned = csvText.replace(/^﻿/, "");
  const lines = cleaned.split(/\r?\n/);
  const rows = lines.map(l => parseCsvRow(l));

  // Preamble metadata (best-effort — absent values shouldn't fail the parse)
  const dealName = rows[0]?.[0]?.trim() || null;
  const dealCode = scrapeMetaValue(rows, "Deal Name:");
  const settlementDate = scrapeMetaValue(rows, "Settlement");
  const reportCreated = scrapeMetaValue(rows, "CF report created");

  // Find the first "Period|Date" marker (group-row anchor) and the second
  // (data-start anchor). Intex writes one "Period / Date" row, then a
  // "Hist Total" summary row, then another "Period / Date" header row,
  // then data.
  let firstHeaderIdx = -1;
  let dataStart = -1;
  for (let i = 0; i < rows.length; i++) {
    const c0 = (rows[i][0] ?? "").trim().toLowerCase();
    const c1 = (rows[i][1] ?? "").trim().toLowerCase();
    if (c0 === "period" && c1 === "date") {
      if (firstHeaderIdx < 0) { firstHeaderIdx = i; }
      else { dataStart = i + 1; break; }
    }
  }
  if (dataStart < 0) {
    // Fallback: first row whose col 0 parses as an integer and col 1 as a date
    for (let i = 0; i < rows.length; i++) {
      const n = parseNumeric(rows[i][0]);
      const d = parseIntexDate(rows[i][1] ?? "");
      if (n != null && Number.isInteger(n) && d) { dataStart = i; break; }
    }
    // For the discovery anchor, fall back to "first data-shaped row" too —
    // discovery walks UP from there, which still finds the group row.
    if (firstHeaderIdx < 0 && dataStart >= 0) firstHeaderIdx = dataStart;
  }
  if (dataStart < 0) {
    return {
      dealName, dealCode, settlementDate, reportCreated,
      assumptions: null, periods: [], discoveredTranches: [],
    };
  }

  const discoveredTranches = discoverTrancheBlocks(rows, firstHeaderIdx, dealTranches);

  const assumptions = extractAssumptions(rows);

  const periods: IntexPeriodRow[] = [];
  for (let i = dataStart; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 2) continue;
    const pIdx = parseNumeric(r[0]);
    const date = parseIntexDate(r[1] ?? "");
    // Stop at the first row that isn't a period data row (blank or non-numeric period)
    if (pIdx == null || !Number.isInteger(pIdx) || !date) continue;

    const tranches = discoveredTranches.map(b =>
      readTrancheBlock(r, b.className, b.start, b.floating)
    );

    periods.push({
      periodIndex: pIdx,
      date,
      collateralPrincipal: parseNumeric(r[COL_COLLAT_PRINCIPAL]),
      collateralInterest:  parseNumeric(r[COL_COLLAT_INTEREST]),
      collateralBalance:   parseNumeric(r[COL_COLLAT_BALANCE]),
      netLoss:             parseNumeric(r[COL_NET_LOSS]),
      senior_mgmt_fee_paid: parseNumeric(r[COL_SEN_MGMT_PAID]),
      sub_mgmt_fee_paid:    parseNumeric(r[COL_SUB_MGMT_PAID]),
      incentive_fee_paid:   parseNumeric(r[COL_INCENTIVE_PAID]),
      tranches,
    });
  }

  return {
    dealName, dealCode, settlementDate, reportCreated,
    assumptions, periods, discoveredTranches,
  };
}
