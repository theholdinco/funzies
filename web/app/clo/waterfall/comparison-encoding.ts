/**
 * Conservative-side encoding for hero-card IRR / fair-value comparisons.
 *
 * Two cards display side-by-side numerics (no-call vs called-at-X):
 *  - Forward IRR card: 3-column grid (label | no-call | called)
 *  - Since-inception card: Mark-to-model row inline labels
 *
 * The `compareConservative` helper produces consistent bold/dim flags so
 * the partner can spot the worse-case (more conservative) side at a
 * glance. Pure logic; the React rendering lives in ProjectionModel.tsx.
 *
 * Supersedes the prior `SideBySideIrr` React component, which baked the
 * encoding into a single inline-flex layout that didn't fit the new
 * grid. The helpers here are layout-agnostic.
 */

/** Cell value for an IRR-style display: number (formatted as %), status
 *  string (e.g., "wiped out"), or null (renders as em-dash). */
export type IrrCellValue = number | string | null;

export interface CompareEncoding {
  /** Bold this side: it is strictly LESS than the other (more conservative). */
  aBold: boolean;
  bBold: boolean;
  /** Dim this side: it is strictly GREATER than the other (less conservative). */
  aDim: boolean;
  bDim: boolean;
}

/**
 * Compare two numerics for conservative encoding. Equal values, status
 * strings, null, and undefined all collapse to "incomparable" — every
 * flag is false. Strict inequality on both sides ensures equal values
 * never get dimmed (the bug the prior fair-value branch carried).
 */
export function compareConservative(
  a: number | null | undefined | string,
  b: number | null | undefined | string,
): CompareEncoding {
  const both = typeof a === "number" && typeof b === "number";
  if (!both) {
    return { aBold: false, bBold: false, aDim: false, bDim: false };
  }
  const aNum = a as number;
  const bNum = b as number;
  return {
    aBold: aNum < bNum,
    bBold: bNum < aNum,
    aDim: aNum > bNum,
    bDim: bNum > aNum,
  };
}

/**
 * Format a YYYY-MM-DD ISO date as `Mmm 'YY` without timezone
 * interpretation. `new Date("2027-01-01")` parses as UTC midnight; in
 * negative-UTC zones the local-formatted result rolls back to
 * "Dec 2026", silently mis-labeling the column header. Slicing the
 * string directly avoids the timezone path entirely.
 */
export function formatCallDate(iso: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = parseInt(iso.slice(5, 7), 10);
  const yy = iso.slice(2, 4);
  return `${months[m - 1]} '${yy}`;
}
