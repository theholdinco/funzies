const MONTH_MAP: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

export function parseCsvLines(csvText: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const cleaned = csvText.replace(/^\uFEFF/, "");
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvRow(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return { headers, rows };
}

export function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

// Locale-aware numeric parser. Shared by parseNumeric and parsePercentage.
//
// Per-value detection (this function) vs file-level detection (scan a sample
// of the column, decide locale once, apply uniformly): SDF files are
// internally consistent, so file-level is more robust against ambiguous
// single-value cases. Per-value is what we ship today because the parser
// surface is field-agnostic (called from many sites against single cells).
// Revisit when the next non-American trustee surfaces.
//
// Ambiguity policy on a single-separator value with 3 digits after:
// "1,500" could be American thousands (1500) or European decimal (1.5).
// Standard SDF magnitudes (par balances, MVs) make thousands the safer pick;
// decimal interpretation here would silently miss factor-of-1000. Refined
// guard: only treat as thousands when digits-before-separator is 1-3 chars
// with a non-zero leading digit — this keeps "0,500" → 0.5 and rejects
// 4+-digit prefixes like "1500,500" → 1500.5 where the thousands-grouping
// shape doesn't fit anyway.
function parseLocaleNumber(
  input: string,
  options: { singleSeparatorThreeDecimalsAsDecimal?: boolean } = {},
): number | null {
  let s = input;
  let sign = 1;
  // Eat leading whitespace, sign, and currency chars in any order.
  while (s.length > 0) {
    const ch = s[0];
    if (ch === " " || ch === "\t" || ch === "\u00A0") s = s.slice(1);
    else if (ch === "-") { sign = -sign; s = s.slice(1); }
    else if (ch === "+") s = s.slice(1);
    else if (ch === "€" || ch === "$" || ch === "\u00A3" || ch === "\u00A5") s = s.slice(1);
    else break;
  }
  s = s.trim();
  if (s === "") return null;

  // Scientific notation: split the mantissa from the exponent, locale-process
  // the mantissa, then multiply directly by 10^exp. Naive parseFloat on "1,5e5"
  // → 1 (not 150000). Naive reconstruction via `${mantissa}${exp}` also loses
  // precision when the mantissa's toString() switches to its own scientific
  // notation (mantissa=1e-7 stringifies to "1e-7" → "1e-7e5" → parseFloat
  // truncates at the first 'e'). Direct Math.pow avoids both. The mantissa is
  // recursively locale-processed; the exponent is digit-only by definition.
  const sciMatch = s.match(/^([\d.,\u00A0 ]+)([eE][+-]?\d+)$/);
  if (sciMatch) {
    const mantissa = parseLocaleNumber(sciMatch[1], options);
    if (mantissa === null) return null;
    const exp = parseInt(sciMatch[2].slice(1), 10);
    if (isNaN(exp)) return null;
    return sign * mantissa * Math.pow(10, exp);
  }

  // Strip all interior whitespace (French/SI thousands convention). Leading
  // whitespace was eaten by the loop above; trailing by `s.trim()`. So any
  // whitespace remaining is interior and should not affect the numeric value.
  // A digit-bracketed regex would only strip ONE pair per pass and miss
  // degenerate single-digit groups ("1 2 3" \u2192 "12 3" \u2192 12, not 123).
  s = s.replace(/[ \u00A0]+/g, "");

  const cc = (s.match(/,/g) || []).length;
  const dc = (s.match(/\./g) || []).length;

  let cleaned: string;
  if (cc === 0 && dc === 0) {
    cleaned = s;
  } else if (cc >= 1 && dc >= 1) {
    // Both separators present: rightmost is decimal, the other is thousands.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      cleaned = s.replace(/\./g, "").replace(",", ".");
    } else {
      cleaned = s.replace(/,/g, "");
    }
  } else {
    // Only one separator type.
    const sep = cc >= 1 ? "," : ".";
    const count = cc >= 1 ? cc : dc;
    if (count >= 2) {
      // Repeated separator → thousands.
      cleaned = s.split(sep).join("");
    } else {
      const idx = s.lastIndexOf(sep);
      const before = s.slice(0, idx);
      const after = s.slice(idx + 1);
      const isCanonicalThousands =
        after.length === 3 &&
        before.length >= 1 && before.length <= 3 &&
        /[1-9]/.test(before);
      if (isCanonicalThousands && !options.singleSeparatorThreeDecimalsAsDecimal) {
        cleaned = before + after;
      } else {
        cleaned = sep === "," ? before + "." + after : s;
      }
    }
  }

  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return sign * num;
}

export function parseNumeric(value: string | undefined | null): number | null {
  if (value == null || value.trim() === "") return null;
  let cleaned = value.trim();
  const isParensNegative = cleaned.startsWith("(") && cleaned.endsWith(")");
  if (isParensNegative) {
    cleaned = cleaned.slice(1, -1).trim();
    // Parens-wrapped sign-prefixed values (e.g. "(-1,234)", "(€-1,234)") are
    // malformed financial data — parens already mean "negate", an inner sign
    // is a data-shape error, not a double-negation. Reject as null.
    const probe = cleaned.replace(/^[€$£¥]+/, "").trimStart();
    if (probe.startsWith("-") || probe.startsWith("+")) return null;
  }
  const num = parseLocaleNumber(cleaned);
  if (num === null) return null;
  return isParensNegative ? -num : num;
}

export function parseBoolean(value: string | undefined | null): boolean | null {
  if (value == null || value.trim() === "") return null;
  const v = value.trim().toUpperCase();
  if (v === "TRUE" || v === "YES") return true;
  if (v === "FALSE" || v === "NO") return false;
  return null;
}

export function parseDate(
  value: string | undefined | null,
  expectedFormat: "DD.MM.YYYY" | "DD-Mon-YYYY" | "DD Mon YYYY"
): string | null {
  if (value == null || value.trim() === "") return null;
  const v = value.trim();

  const tryParse = (fmt: string, s: string): string | null => {
    if (fmt === "DD.MM.YYYY") {
      const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    }
    if (fmt === "DD-Mon-YYYY") {
      const m = s.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
      if (m && MONTH_MAP[m[2]]) return `${m[3]}-${MONTH_MAP[m[2]]}-${m[1]}`;
    }
    if (fmt === "DD Mon YYYY") {
      const m = s.match(/^(\d{2})\s+([A-Za-z]{3})\s+(\d{4})$/);
      if (m && MONTH_MAP[m[2]]) return `${m[3]}-${MONTH_MAP[m[2]]}-${m[1]}`;
    }
    return null;
  };

  const result = tryParse(expectedFormat, v);
  if (result) return result;

  for (const fmt of ["DD.MM.YYYY", "DD-Mon-YYYY", "DD Mon YYYY"] as const) {
    if (fmt === expectedFormat) continue;
    const fallback = tryParse(fmt, v);
    if (fallback) {
      console.warn(`SDF date "${v}" parsed with fallback format ${fmt} instead of ${expectedFormat}`);
      return fallback;
    }
  }

  console.warn(`SDF date "${v}" could not be parsed with any format`);
  return null;
}

export function parsePercentage(value: string | undefined | null): number | null {
  if (value == null || value.trim() === "") return null;
  const stripped = value.trim().replace(/%$/, "");
  return parseLocaleNumber(stripped, { singleSeparatorThreeDecimalsAsDecimal: true });
}

/** parseNumeric variant for PPM-extraction-style decorated strings.
 *
 * AI-extracted amounts may carry text decoration: currency codes ("EUR
 * 100,000,000"), trailing labels ("100,000 EUR"), embedded notes. Those are
 * not in parseNumeric's vocabulary (it handles symbol-prefix currency, signs,
 * parens — but not arbitrary text). Pre-strip everything that isn't a digit,
 * separator, sign, currency symbol, or paren; then parseNumeric the residue.
 * Use at extraction boundaries (`resolver.ts` parseAmount, `persist-ppm.ts`
 * parseAmount, `validator.ts` parsePrincipalAmount). Pure-numeric callers
 * should prefer parseNumeric directly. */
export function parseDecoratedAmount(value: string | undefined | null): number | null {
  if (value == null || value.trim() === "") return null;
  // Strip everything that isn't digit/separator/sign/currency/paren. The `-`
  // is intentionally placed at the END of the character class — escaping it
  // mid-class (e.g. `\-+`) is technically safe today but a future reorder
  // would silently turn `+\-€` into the range `+-€` (Unicode 43–8364) and
  // admit thousands of unintended characters. End-position prevents this.
  const stripped = String(value).replace(/[^\d.,+€$£¥()-]/g, "");
  return parseNumeric(stripped);
}

/** Agency "no rating" sentinels that appear verbatim in SDF CSVs. */
const RATING_SENTINELS = new Set(["***", "nr", "n/r", "n/a", "na", "--", "-", "n/m", "nm", "wr"]);

export function isRatingSentinel(value: string | null | undefined): boolean {
  if (value == null) return false;
  const t = value.trim().toLowerCase();
  return t === "" || RATING_SENTINELS.has(t);
}

export function trimRating(value: string | undefined | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (RATING_SENTINELS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

export function spreadToBps(value: number | undefined | null): number | null {
  if (value == null) return null;
  return Math.round(value * 100);
}
