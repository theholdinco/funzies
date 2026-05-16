/**
 * Canonical tranche-class-name normalizer.
 *
 * Lifts a free-form tranche label ("Class A-1", "Subordinated Notes",
 * "Equity", "Income Note", "Sub", "A Senior Secured FRN due 2032", etc.)
 * to a stable comparison key.
 *
 * Output shape: lowercase, no "class " prefix, no trailing "-notes" /
 * "notes" suffix; equity-flavor variants ("Subordinated" / "Sub" /
 * "Equity" / "Income Note(s)") all collapse to "sub"; first class-letter
 * token only (so "A Senior Secured FRN due 2032" → "a").
 *
 * NOT a display formatter. The persisted clo_tranches.class_name shape
 * ("Class A-1", "Subordinated Notes") is produced by
 * sdf/parse-notes.ts's formatTrancheClassName and read by literal-string
 * SQL filters in sdf/ingest.ts. Use this normalizer only for in-memory
 * comparison keys.
 */
export function normalizeClassName(name: string): string {
  const lower = String(name ?? "").toLowerCase().trim();
  if (!lower) return "";
  if (
    lower.includes("subordinated") ||
    /^sub(\s|$)/.test(lower) ||
    /^subord(@|\s|$)/.test(lower) ||
    lower.includes("equity") ||
    lower.includes("income note") ||
    lower.includes("income-note")
  ) {
    return "sub";
  }
  const stripped = lower
    .replace(/^class(es)?[\s-]+/i, "")
    .replace(/[-\s]+notes?$/i, "")
    .trim();
  // Capture letter and optional digit-suffix separately, then re-join with
  // a hyphen. This canonicalizes the separator across input variants:
  // "Class B-1", "Class B 1", "Class B1", and bare "B1" all collapse to
  // "b-1". Mirrors the canonicalization SDF/parse-notes does in
  // `formatTrancheClassName` so the Intex parser's bare-letter labels
  // match the deal's hyphenated `clo_tranches.class_name`.
  const match = stripped.match(/^([a-z])(?:[-\s]?([0-9]+))?\b/);
  if (!match) return stripped;
  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}
