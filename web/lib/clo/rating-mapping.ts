export const RATING_BUCKETS = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "NR"] as const;
export type RatingBucket = typeof RATING_BUCKETS[number];

// Moody's historical 1Y average default rates (values are percentages, e.g. 3.41 means 3.41%)
export const DEFAULT_RATES_BY_RATING: Record<RatingBucket, number> = {
  AAA: 0.00,
  AA: 0.02,
  A: 0.06,
  BBB: 0.18,
  BB: 1.06,
  B: 3.41,
  CCC: 10.28,
  NR: 2.00,
};

/** Moody's Rating Factor table. Each obligor's WARF contribution is
 *  parBalance × factor, summed and divided by total par.
 *  Source: Moody's Idealized Default Rates (10-year cumulative, ×10000).
 *  WR (withdrawn) / NR rows fall back to a non-investment-grade proxy. */
export const MOODYS_WARF_FACTORS: Record<string, number> = {
  aaa: 1,
  aa1: 10, aa2: 20, aa3: 40,
  a1: 70, a2: 120, a3: 180,
  baa1: 260, baa2: 360, baa3: 610,
  ba1: 940, ba2: 1350, ba3: 1766,
  b1: 2220, b2: 2720, b3: 3490,
  caa1: 4770, caa2: 6500, caa3: 8070,
  ca: 10000, c: 10000,
};

/** Canonical rating-string normalizer. Strips trailing parentheticals
 *  ("(sf)", "(p)") and rating-watch flags ("*-", "*+"). Lowercases.
 *  Single source of truth for textual cleanup so per-agency predicates
 *  (`isMoodysCaaOrBelow`, `isFitchCccOrBelow`) and WARF-factor lookup
 *  cannot drift. Anti-pattern #5 boundary: any consumer that operates on
 *  raw rating strings (validator, buy-list filter, mapping helpers) must
 *  go through this. */
export function stripRatingSuffixes(rating: string): string {
  // Order matters: watch flags appear AFTER parentheticals on inputs like
  // "Caa1 (sf) *-", so strip the watch flag first to peel back the layers
  // outside-in.
  return rating.trim().toLowerCase()
    .replace(/\s*\*.*$/, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
}

export function moodysWarfFactor(rating: string | null | undefined): number | null {
  if (!rating) return null;
  return MOODYS_WARF_FACTORS[stripRatingSuffixes(rating)] ?? null;
}

/** D2 — Convert a Moody's WARF factor to a per-quarter default hazard rate.
 *
 *  Math: WARF factor is Moody's idealized 10-year cumulative default
 *  probability × 10000. Assuming a constant quarterly hazard rate `h`
 *  across the 40-quarter horizon, 10-year survival = (1 - h)^40, so
 *    cumDef = warfFactor / 10000 = 1 - (1 - h)^40
 *    h = 1 - (1 - cumDef)^(1/40)
 *
 *  Spot checks:
 *    - Aaa (factor 1):      cumDef 0.01% → h ≈ 2.5e-6/quarter (effectively 0)
 *    - B2  (factor 2720):   cumDef 27.2% → h ≈ 0.79%/quarter  (≈ 3.13% annualized)
 *    - Caa1 (factor 4770):  cumDef 47.7% → h ≈ 1.61%/quarter  (≈ 6.30% annualized)
 *    - Caa2 (factor 6500):  cumDef 65.0% → h ≈ 2.59%/quarter  (≈ 10.01% annualized)
 *    - Caa3 (factor 8070):  cumDef 80.7% → h ≈ 4.02%/quarter  (≈ 15.19% annualized)
 *    - Ca/C (factor 10000): cumDef 100%  → h = 1.0 (default next quarter)
 *
 *  Used by the D2 per-position hazard path. When `loan.warfFactor` is set,
 *  the engine uses this helper instead of `defaultRatesByRating[bucket]`
 *  — gives Caa1 vs Caa3 distinct hazards where the bucket path averaged
 *  them together as "CCC". */
export function warfFactorToQuarterlyHazard(warfFactor: number): number {
  if (!Number.isFinite(warfFactor) || warfFactor <= 0) return 0;
  const cumDef = Math.min(warfFactor / 10000, 1);
  if (cumDef >= 1) return 1;
  return 1 - Math.pow(1 - cumDef, 1 / 40);
}

/** Annualised CDR (%) equivalent to a Moody's WARF factor. Used to seed the
 *  per-bucket UI sliders with the same effective rate the engine applies via
 *  the per-position hazard path — so the slider's displayed value matches
 *  what the engine is really using until the user drags it. */
export function warfFactorToAnnualCDRPct(warfFactor: number): number {
  const h = warfFactorToQuarterlyHazard(warfFactor);
  if (h <= 0) return 0;
  if (h >= 1) return 100;
  return (1 - Math.pow(1 - h, 4)) * 100;
}

const MOODYS_MAP: Record<string, RatingBucket> = {
  aaa: "AAA",
  aa1: "AA", aa2: "AA", aa3: "AA",
  a1: "A", a2: "A", a3: "A",
  baa1: "BBB", baa2: "BBB", baa3: "BBB",
  ba1: "BB", ba2: "BB", ba3: "BB",
  b1: "B", b2: "B", b3: "B",
  caa1: "CCC", caa2: "CCC", caa3: "CCC",
  ca: "CCC", c: "CCC",
};

const SP_FITCH_MAP: Record<string, RatingBucket> = {
  aaa: "AAA",
  "aa+": "AA", aa: "AA", "aa-": "AA",
  "a+": "A", a: "A", "a-": "A",
  "bbb+": "BBB", bbb: "BBB", "bbb-": "BBB",
  "bb+": "BB", bb: "BB", "bb-": "BB",
  "b+": "B", b: "B", "b-": "B",
  "ccc+": "CCC", ccc: "CCC", "ccc-": "CCC",
  "cc+": "CCC", cc: "CCC", "cc-": "CCC",
  c: "CCC",
};

function tryMap(rating: string | null, map: Record<string, RatingBucket>): RatingBucket | null {
  if (!rating || !rating.trim()) return null;
  return map[stripRatingSuffixes(rating)] ?? null;
}

export function mapToRatingBucket(
  moodys: string | null,
  sp: string | null,
  fitch: string | null,
  composite: string | null
): RatingBucket {
  return (
    tryMap(moodys, MOODYS_MAP) ??
    tryMap(sp, SP_FITCH_MAP) ??
    tryMap(fitch, SP_FITCH_MAP) ??
    tryMap(composite, { ...MOODYS_MAP, ...SP_FITCH_MAP }) ??
    "NR"
  );
}

/** Per-agency Caa-or-below predicate for the Moody's Caa Obligations
 *  concentration test. Per PPM Condition 1 (PDF p. 138): "Moody's Caa
 *  Obligations" means any Collateral Obligation (excluding Defaulted
 *  Obligations and Loss Mitigation Loans) with a Moody's Rating of "Caa1" or
 *  lower. Sub-buckets that map: Caa1, Caa2, Caa3, Ca, C — exactly the Moody's
 *  strings that the `MOODYS_MAP` collapses to the coarse "CCC" bucket. Returns
 *  false on unparseable / non-Caa ratings. */
export function isMoodysCaaOrBelow(rating: string | null | undefined): boolean {
  if (!rating) return false;
  return tryMap(rating, MOODYS_MAP) === "CCC";
}

/** Per-agency CCC-or-below predicate for the Fitch CCC Obligations
 *  concentration test. Per PPM Condition 1 (PDF p. 127): "Fitch CCC
 *  Obligations" means all Collateral Obligations (excluding Defaulted
 *  Obligations and Loss Mitigation Loans) with a Fitch Rating of "CCC+" or
 *  lower. Sub-buckets that map: CCC+, CCC, CCC-, CC+, CC, CC-, C — exactly the
 *  strings the shared `SP_FITCH_MAP` collapses to the coarse "CCC" bucket.
 *  Returns false on unparseable / non-CCC ratings. */
export function isFitchCccOrBelow(rating: string | null | undefined): boolean {
  if (!rating) return false;
  return tryMap(rating, SP_FITCH_MAP) === "CCC";
}

/** Representative per-agency sub-bucket strings for synthetic reinvestment
 *  loans. Engine reinvestment synthesis works with a coarse `RatingBucket`
 *  ("B", "CCC", etc.) but the per-agency CCC/Caa Excess haircut needs
 *  agency-specific rating strings on each loan. This helper picks the
 *  mid-of-bucket sub-rating per agency for each coarse bucket so synthetic
 *  loans participate in the per-agency predicates exactly like ingested
 *  loans. Consumed only at synthesis-time. */
export function representativeSubRatings(
  bucket: string,
): { moodysRatingFinal?: string; fitchRatingFinal?: string } {
  switch (bucket) {
    case "AAA": return { moodysRatingFinal: "Aaa",  fitchRatingFinal: "AAA" };
    case "AA":  return { moodysRatingFinal: "Aa2",  fitchRatingFinal: "AA"  };
    case "A":   return { moodysRatingFinal: "A2",   fitchRatingFinal: "A"   };
    case "BBB": return { moodysRatingFinal: "Baa2", fitchRatingFinal: "BBB" };
    case "BB":  return { moodysRatingFinal: "Ba2",  fitchRatingFinal: "BB"  };
    case "B":   return { moodysRatingFinal: "B2",   fitchRatingFinal: "B"   };
    case "CCC": return { moodysRatingFinal: "Caa2", fitchRatingFinal: "CCC" };
    default:    return {};
  }
}
