/**
 * Canonical industry taxonomy reference data — industry-cap closure.
 *
 * The CLO indenture's clause (t) (industry concentration cap) is anchored on
 * a per-deal canonical taxonomy named in the PPM — typically Moody's 33-industry
 * classification or S&P's industry classification. Per-loan industry codes
 * extracted from SDF data (`clo_holdings.moodys_industry`, `.sp_industry`) match
 * one of these canonical lists; the active taxonomy is selected per-deal.
 *
 * Anti-pattern #5 ("boundaries assert sign and scale") generalized: industry
 * classification crosses the boundary as `(taxonomy, code)` — never as a
 * free-text industry name. Two industries with the same `industryCode` under
 * the same `taxonomy` are the same industry; otherwise they aren't.
 *
 * This is canonical reference data — public from each agency's CLO methodology
 * documentation. Treated as a static seed file, not DB-resident, so tests run
 * without DB and TypeScript imports are typed.
 */

export interface IndustryClassification {
  /** Stable code under the taxonomy. Format is taxonomy-specific
   *  (Moody's: 4-digit numeric like "1010"; S&P: alphanumeric). */
  code: string;
  /** Canonical industry name as published by the agency. Display-only —
   *  matching is on `code`, not on `name`. */
  canonicalName: string;
  /** Common free-text aliases the partner might write in a CSV. Lowercase
   *  comparison only. Aliases NEVER overlap across industries within the
   *  same taxonomy — enforced at module load by the test suite. Empty
   *  array means no aliases known; partner falls back to dropdown. */
  aliases: string[];
}

/** Active taxonomy for a deal. Mirrors the schema's
 *  `industry_taxonomy` enum (web/lib/schema.sql:856 + migration 016). */
export type IndustryTaxonomy = "moodys_33" | "sp" | "deal_specific";
