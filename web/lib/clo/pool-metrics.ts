/**
 * Shared pure helpers for portfolio-level quality + concentration metrics.
 *
 * Used by:
 *   - `projection.ts` — per-period forward-projected metrics on `PeriodResult.qualityMetrics`.
 *   - `switch-simulator.ts` — pre/post switch pool metrics so the UI can show
 *     compliance impact of a proposed trade.
 *
 * Extracting shared math here avoids the parallel-implementation trap:
 * per-period and per-switch metrics must match the engine's definitions
 * exactly.
 *
 * Methodology (PPM Euro XV Condition 1, PDF pp. 302-305, 127, 138):
 *   - `floatingWasBps` = Σ(par × spreadBps) / Σ(par) over Floating Par.
 *     Floating Par excludes Defaulted Obligations, Loss Mitigation Loans,
 *     Deferring Securities, Fixed Rate Obligations, and Non-Euro Obligations.
 *     Caller is responsible for pre-filtering DDTL / unfunded portions.
 *   - `excessWacBps` = (WeightedAvgFixedCoupon − ReferenceWAFC) × 100 ×
 *     (Fixed Par / Floating Par). Reference WAFC defaults to 4.0%
 *     (PPM PDF p. 305 — Euro XV reference rate). Negative when fixed
 *     coupons fall below the reference (a penalty, per PPM intent).
 *   - `wacSpreadBps` = `floatingWasBps + excessWacBps` — the combined
 *     metric the Min Weighted Average Floating Spread Test compares
 *     against `minWasBps` per PPM Section 8.
 *   - `pctMoodysCaa` = par share rated Moody's Caa1 or below per PPM
 *     "Moody's Caa Obligations" definition (PDF p. 138). Denominator
 *     excludes LML (defaulted obligations are already excluded by the
 *     caller's `survivingPar` filter, so they don't appear in `loans`).
 *   - `pctFitchCcc` = par share rated Fitch CCC+ or below per PPM "Fitch
 *     CCC Obligations" definition (PDF p. 127). Same denominator.
 *   - `pctCccAndBelow` = `max(pctMoodysCaa, pctFitchCcc)` — coarse summary
 *     for UI display. Per-agency tests use the per-agency fields.
 *   - `warf` / `walYears` are par-weighted across all loans passed in
 *     (no PPM exclusion list). NR positions proxy to Caa2 (WARF=6500) per
 *     Moody's CLO methodology convention.
 *
 * When per-agency ratings (`moodysRatingFinal`, `fitchRatingFinal`) are
 * absent on a loan (typical for engine-generated reinvestment positions
 * that only carry a coarse `ratingBucket`), the helper falls back to
 * `ratingBucket === "CCC"` as a proxy for both per-agency counters. This
 * preserves the legacy bucket-based behaviour for callers that don't
 * thread per-agency ratings, and the per-agency methodology activates
 * automatically once the caller plumbs the resolver fields through.
 */

import { isMoodysCaaOrBelow, isFitchCccOrBelow } from "./rating-mapping";

/** Portfolio-level quality metrics. Same shape used for forward-projected
 *  periods (`PeriodQualityMetrics`) and for pre/post-switch pool summaries. */
export interface PoolQualityMetrics {
  /** Weighted Average Rating Factor (Moody's, 1=Aaa, 10000=Ca/C). */
  warf: number;
  /** Weighted Average Life of the remaining pool in years. Bullet-maturity
   *  approximation (see projection.ts docstring). */
  walYears: number;
  /** Floating WAS + Excess WAC per PPM Condition 1 (PDF pp. 302-305). bps. */
  wacSpreadBps: number;
  /** Floating WAS in isolation: par-weighted spread over Floating Par. bps. */
  floatingWasBps: number;
  /** Excess WAC adjustment: (WeightedAvgFixedCoupon − ReferenceWAFC) × 100 ×
   *  (Fixed Par / Floating Par). bps. Zero when there are no fixed-rate
   *  positions or no floating denominator. */
  excessWacBps: number;
  /** Per-agency Moody's Caa-or-below par share (%). Denominator excludes LML. */
  pctMoodysCaa: number;
  /** Per-agency Fitch CCC-or-below par share (%). Denominator excludes LML. */
  pctFitchCcc: number;
  /** `max(pctMoodysCaa, pctFitchCcc)` — coarse summary for UI display. */
  pctCccAndBelow: number;
  /** Par share (%) of positions whose Moody's rating was derived from S&P
   *  via the rating ladder's cross-agency rung (rather than coming directly
   *  from a Moody's SDF or Intex channel). Mirrors the BNY trustee-report
   *  page-3 disclosure shape: when high, the partner sees that the Moody's
   *  concentration tests are sensitive to the per-deal S&P→Moody's mapping
   *  table extracted from the PPM. Denominator: same as the WARF totalPar. */
  pctMoodysRatingDerivedFromSp: number;
  /** Par share (%) of positions whose Moody's OR Fitch rating is tagged by
   *  Intex as a Credit Estimate or Private Letter rating (regulatory
   *  confidentiality redacts the rating itself in the BNY trustee PDF as
   *  `***`; only Intex carries the value). Denominator: WARF totalPar. */
  pctOnCreditEstimateOrPrivateRating: number;
  /** industry-cap: par share (%) held by the largest industry under the deal's
   *  active taxonomy, or null when no loans carry an industry tag.
   *  Computed as `max(industryPar) / totalPar × 100`. Denominator excludes
   *  loans with no `industryCode` (silent — coverage is enforced by the
   *  resolver-side blocking gate, so reaching here with partial coverage
   *  means the projection was permitted to run anyway). */
  largestIndustryPct: number | null;
  /** industry-cap: full descending-par-share industry distribution under the
   *  active taxonomy. Null when no loans carry industryCode. Array (NOT
   *  Map) for clean RSC boundary serialization. */
  industryDistributionPct: Array<{ industryCode: string; parPct: number }> | null;
}

/** Minimum per-loan shape required for quality-metric computation. Both
 *  `projection.ts` (`LoanState`) and `switch-simulator.ts` (`ResolvedLoan`)
 *  map their internal shapes to this for the helper call. */
export interface QualityMetricLoan {
  parBalance: number;
  warfFactor: number;
  yearsToMaturity: number;
  spreadBps: number;
  ratingBucket: string;
  /** Whether the loan carries a flat coupon (excluded from Floating Par,
   *  contributes to Excess WAC numerator). */
  isFixedRate?: boolean;
  /** Fixed coupon as percent (e.g. 8.0 for 8%). Required to compute Excess
   *  WAC when `isFixedRate` is true. */
  fixedCouponPct?: number | null;
  /** Per PPM "Deferring Security" — excluded from Floating Par. */
  isDeferring?: boolean | null;
  /** Per PPM "Loss Mitigation Loan" — excluded from Floating Par AND from
   *  Caa/CCC concentration test denominators (PDF pp. 127, 138). */
  isLossMitigationLoan?: boolean | null;
  /** ISO 4217 currency code. When `dealCurrency` is provided in opts and
   *  this differs, the loan is excluded from Floating Par as a Non-Euro
   *  Obligation per PPM Condition 1. */
  currency?: string | null;
  /** Per-agency Moody's rating (sub-bucket, e.g. "Caa2"). When absent on
   *  ALL loans the helper falls back to `ratingBucket === "CCC"`. */
  moodysRatingFinal?: string | null;
  /** Per-agency Fitch rating (sub-bucket, e.g. "CCC+"). Same fallback. */
  fitchRatingFinal?: string | null;
  /** Tag identifying which rung of the rating ladder produced
   *  `moodysRatingFinal`. `"derive_from_sp"` drives the
   *  `pctMoodysRatingDerivedFromSp` aggregate. */
  moodysRatingSource?: import("./resolve-rating").MoodysRatingSource;
  /** True when Intex tags this position as a credit estimate or private
   *  letter rating. Drives `pctOnCreditEstimateOrPrivateRating`. */
  isCreditEstimateOrPrivateRating?: boolean;
  /** industry-cap: per-position canonical industry code under the deal's active
   *  taxonomy. Drives `largestIndustryPct` + `industryDistributionPct`.
   *  Undefined when the deal has no clause (t) or when the position is
   *  a synthetic reinvestment that hasn't been tagged by the allocator
   *  yet. */
  industryCode?: string;
}

/** Optional knobs for `computePoolQualityMetrics`. */
export interface PoolQualityMetricsOpts {
  /** PPM Reference Weighted Average Fixed Coupon (%); PDF p. 305. Defaults
   *  to 4.0 when omitted (Euro XV value; resolver threads this from
   *  `resolved.referenceWeightedAverageFixedCoupon`). */
  referenceWAFC?: number;
  /** Deal currency (ISO 4217). Loans whose `currency` differs are excluded
   *  from the Floating Par denominator per "Non-Euro Obligation" definition.
   *  When omitted, no currency filter applies (all loans assumed in deal
   *  currency). */
  dealCurrency?: string | null;
  /** Industry codes excluded from the industry-cap denominator + bucket
   *  ordering. PPM clause-(t) names a list of industries that don't count
   *  toward the test ("Sovereign and Public Finance" being the canonical
   *  case). Resolver converts names to codes via the active taxonomy. The
   *  engine's allocator filters by this list at the synthesis site, and
   *  this helper's `largestIndustryPct` / `industryDistributionPct`
   *  outputs MUST share the same denominator — otherwise the UI's
   *  largest-industry % would diverge from what the rule actually tests
   *  against. */
  excludedIndustryCodes?: ReadonlyArray<string> | null;
}

/** Partial sums extracted from one pass over the loan list. Sole source of
 *  truth for both `computePoolQualityMetrics` (post-period output) and
 *  `projection.ts`'s reinvestment-compliance gate (boundary math). Co-locating
 *  the aggregation prevents parallel-implementation drift — the gate's pre-buy
 *  state and the helper's post-period state are guaranteed to use identical
 *  exclusion rules. */
export interface QualityMetricsAggregates {
  /** Σ par over all loans with par > 0. WARF / WAL denominator. */
  totalPar: number;
  /** Σ par × warfFactor. WARF numerator. */
  warfSum: number;
  /** Σ par × yearsToMaturity. WAL numerator. */
  walSum: number;
  /** Σ par over Floating Par (excludes LML, deferring, fixed-rate,
   *  non-deal-currency). Floating WAS denominator + Excess WAC denominator. */
  floatingPar: number;
  /** Σ par × spreadBps over Floating Par. Floating WAS numerator. */
  floatingSpreadSum: number;
  /** Σ par over Fixed Par (same exclusions as Floating Par minus the
   *  fixed-rate one). Excess WAC denominator (numerator side). */
  fixedPar: number;
  /** Σ par × fixedCouponPct over Fixed Par. Used to compute weighted-average
   *  fixed coupon = `fixedCouponSum / fixedPar`. */
  fixedCouponSum: number;
  /** Σ par over non-LML loans. Caa/CCC concentration denominator. */
  concDenom: number;
  /** Σ par over non-LML loans where `isMoodysCaaOrBelow(moodysRatingFinal)`
   *  (or `ratingBucket === "CCC"` when both per-agency ratings are absent). */
  moodysCaaPar: number;
  /** Σ par over non-LML loans where `isFitchCccOrBelow(fitchRatingFinal)`
   *  (same bucket fallback as `moodysCaaPar`). */
  fitchCccPar: number;
  /** Σ par over loans whose `moodysRatingSource === "derive_from_sp"`. */
  moodysDerivedFromSpPar: number;
  /** Σ par over loans whose `isCreditEstimateOrPrivateRating === true`. */
  creditEstimateOrPrivatePar: number;
}

/** Single-pass aggregation over a loan list, producing the partial sums
 *  needed by every downstream metric and gate. Pure; no allocations beyond
 *  the returned record. */
export function aggregateQualityMetrics(
  loans: QualityMetricLoan[],
  opts: PoolQualityMetricsOpts = {},
): QualityMetricsAggregates {
  const dealCurrency = opts.dealCurrency ?? null;

  // Caller-side invariant — defaulted positions are EXCLUDED from `loans`
  // by `projection.ts` and `switch-simulator.ts` before this helper is
  // called. The exclusion uses two filters at the call sites:
  //   1. `survivingPar > 0` — drops fully-defaulted loans (par migrates
  //      from `survivingPar` to `defaultedParPending` on default).
  //   2. `defaultedParPending > 0 → continue` — drops partially-defaulted
  //      loans entirely (the surviving piece does NOT count toward Caa/CCC
  //      numerator or denominator). Conservative interpretation of PPM
  //      Condition 1 "Defaulted Obligations" (PDF p. 138): once any
  //      portion of an obligor is defaulted, the whole obligor is excluded
  //      from the Caa Obligations and Fitch CCC Obligations sets. The
  //      alternative interpretation (count surviving piece) would silently
  //      inflate concentration if the partially-defaulted loan is rated
  //      Caa/CCC — partner-facing wrong number under stress.
  // There is NO `isDefaulted: boolean` on `LoanState`; the invariant lives
  // at the call sites via the two filters above (see
  // `projection.ts:1383-1407` for `computeQualityMetrics` and
  // `:1242-1268` for `maxCompliantReinvestment`).

  let totalPar = 0;
  let warfSum = 0;
  let walSum = 0;
  let floatingPar = 0;
  let floatingSpreadSum = 0;
  let fixedPar = 0;
  let fixedCouponSum = 0;
  let concDenom = 0;
  let moodysCaaPar = 0;
  let fitchCccPar = 0;
  let moodysDerivedFromSpPar = 0;
  let creditEstimateOrPrivatePar = 0;

  for (const l of loans) {
    const par = l.parBalance;
    if (par <= 0) continue;
    totalPar += par;
    warfSum += par * l.warfFactor;
    walSum += par * l.yearsToMaturity;

    // Provenance aggregates — denominator is the same totalPar used for WARF.
    if (l.moodysRatingSource === "derive_from_sp") moodysDerivedFromSpPar += par;
    if (l.isCreditEstimateOrPrivateRating === true) creditEstimateOrPrivatePar += par;

    const isLML = l.isLossMitigationLoan === true;
    const isDeferring = l.isDeferring === true;
    const isFixed = l.isFixedRate === true;
    const isNonDealCurrency =
      dealCurrency != null && l.currency != null && l.currency !== dealCurrency;

    // Per-agency concentration: exclude LML only. Defaulted positions are
    // already absent because the caller filters by survivingPar / funded
    // status before calling.
    if (!isLML) {
      concDenom += par;
      const moodysFinal = l.moodysRatingFinal ?? null;
      const fitchFinal = l.fitchRatingFinal ?? null;
      const useBucketFallback = moodysFinal === null && fitchFinal === null;
      const moodysCaa = useBucketFallback
        ? l.ratingBucket === "CCC"
        : isMoodysCaaOrBelow(moodysFinal);
      const fitchCcc = useBucketFallback
        ? l.ratingBucket === "CCC"
        : isFitchCccOrBelow(fitchFinal);
      if (moodysCaa) moodysCaaPar += par;
      if (fitchCcc) fitchCccPar += par;
    }

    // Floating WAS / Excess WAC buckets: exclude LML, deferring, non-deal-currency
    if (!isLML && !isDeferring && !isNonDealCurrency) {
      if (isFixed) {
        fixedPar += par;
        fixedCouponSum += par * (l.fixedCouponPct ?? 0);
      } else {
        floatingPar += par;
        floatingSpreadSum += par * l.spreadBps;
      }
    }
  }

  return {
    totalPar,
    warfSum,
    walSum,
    floatingPar,
    floatingSpreadSum,
    fixedPar,
    fixedCouponSum,
    concDenom,
    moodysCaaPar,
    fitchCccPar,
    moodysDerivedFromSpPar,
    creditEstimateOrPrivatePar,
  };
}

/** Project `QualityMetricsAggregates` onto the eight published metrics.
 *  Pure derivation; no I/O. Exported so the projection-engine gate can
 *  preview post-buy metrics from the same code path that produces
 *  per-period output. */
export function deriveQualityMetrics(
  aggregates: QualityMetricsAggregates,
  opts: PoolQualityMetricsOpts = {},
): PoolQualityMetrics {
  // `?? 4.0` is the Excess WAC reference fallback. Production-unreachable
  // by construction: the resolver at resolver.ts:3155-3163 blocks when
  // referenceWeightedAverageFixedCoupon is missing AND the deal has any
  // fixed-rate loan; the all-floating-only case has fixedPar = 0 so the
  // Excess WAC term `(wafc - referenceWAFC) × fixedPar` is zero regardless
  // of the fallback value. Keep the fallback only for hand-constructed
  // test fixtures that bypass the resolver gate.
  const referenceWAFC = opts.referenceWAFC ?? 4.0;
  const {
    totalPar,
    warfSum,
    walSum,
    floatingPar,
    floatingSpreadSum,
    fixedPar,
    fixedCouponSum,
    concDenom,
    moodysCaaPar,
    fitchCccPar,
    moodysDerivedFromSpPar,
    creditEstimateOrPrivatePar,
  } = aggregates;

  if (totalPar === 0) {
    return {
      warf: 0,
      walYears: 0,
      wacSpreadBps: 0,
      floatingWasBps: 0,
      excessWacBps: 0,
      pctMoodysCaa: 0,
      pctFitchCcc: 0,
      pctCccAndBelow: 0,
      pctMoodysRatingDerivedFromSp: 0,
      pctOnCreditEstimateOrPrivateRating: 0,
      largestIndustryPct: null,
      industryDistributionPct: null,
    };
  }

  const floatingWasBps = floatingPar > 0 ? floatingSpreadSum / floatingPar : 0;
  const weightedAvgFixedCoupon = fixedPar > 0 ? fixedCouponSum / fixedPar : 0;
  // Excess WAC: (WAFC% − ref%) × 100 (pct→bps) × (fixedPar / floatingPar).
  // Zero when no floating denominator (degenerate all-fixed pool — the test
  // doesn't apply, and the resolver should have flagged the all-fixed shape
  // upstream).
  const excessWacBps =
    floatingPar > 0 ? (weightedAvgFixedCoupon - referenceWAFC) * 100 * (fixedPar / floatingPar) : 0;
  const wacSpreadBps = floatingWasBps + excessWacBps;

  const pctMoodysCaa = concDenom > 0 ? (moodysCaaPar / concDenom) * 100 : 0;
  const pctFitchCcc = concDenom > 0 ? (fitchCccPar / concDenom) * 100 : 0;
  const pctCccAndBelow = Math.max(pctMoodysCaa, pctFitchCcc);
  const pctMoodysRatingDerivedFromSp = (moodysDerivedFromSpPar / totalPar) * 100;
  const pctOnCreditEstimateOrPrivateRating = (creditEstimateOrPrivatePar / totalPar) * 100;

  return {
    warf: warfSum / totalPar,
    walYears: walSum / totalPar,
    wacSpreadBps,
    floatingWasBps,
    excessWacBps,
    pctMoodysCaa,
    pctFitchCcc,
    pctCccAndBelow,
    pctMoodysRatingDerivedFromSp,
    pctOnCreditEstimateOrPrivateRating,
    // Industry-cap — populated by `computePoolQualityMetrics` after deriveQualityMetrics
    // returns. The aggregate alone can't compute this (needs the per-loan
    // industryCode list), so we patch into the result rather than carrying
    // a Map through `QualityMetricsAggregates` (clean serialization at the
    // engine→service→UI boundary).
    largestIndustryPct: null,
    industryDistributionPct: null,
  };
}

/** Compute portfolio quality metrics from a flat list of loans. Pure function
 *  — no side effects, no access to closures.
 *
 *  Caller filters un-drawn DDTL/revolver portions and defaulted positions
 *  before calling (engine consumers naturally exclude these via `survivingPar`;
 *  switch simulator filters via `parBalance > 0`). The helper applies the
 *  remaining PPM exclusions internally based on per-loan flags.
 *
 *  Composition: `aggregateQualityMetrics` does the loop, `deriveQualityMetrics`
 *  projects to the published shape. The reinvestment-compliance gate in
 *  `projection.ts` reuses `aggregateQualityMetrics` so its pre-buy sums are
 *  guaranteed to match the helper's per-period output. */
export function computePoolQualityMetrics(
  loans: QualityMetricLoan[],
  opts: PoolQualityMetricsOpts = {},
): PoolQualityMetrics {
  const base = deriveQualityMetrics(aggregateQualityMetrics(loans, opts), opts);
  // industry-cap: industry distribution + largestIndustryPct. Patched onto `base`
  // here because the aggregation map can't round-trip through the partial
  // sums shape (which is JSON-serializable primitives only). Excluded codes
  // are dropped from BOTH numerator (per-bucket par) and denominator
  // (totalParWithIndustry) so the displayed largestIndustryPct matches the
  // denominator the engine's allocator uses internally — otherwise the UI's
  // top-industry % would diverge from what the rule actually tests against.
  const excluded = new Set(opts.excludedIndustryCodes ?? []);
  const industryParByCode = new Map<string, number>();
  let totalParWithIndustry = 0;
  for (const l of loans) {
    if (l.parBalance <= 0) continue;
    if (!l.industryCode) continue;
    if (excluded.has(l.industryCode)) continue;
    industryParByCode.set(l.industryCode, (industryParByCode.get(l.industryCode) ?? 0) + l.parBalance);
    totalParWithIndustry += l.parBalance;
  }
  if (totalParWithIndustry > 0) {
    const distribution = Array.from(industryParByCode, ([industryCode, par]) => ({
      industryCode,
      parPct: (par / totalParWithIndustry) * 100,
    })).sort((a, b) => b.parPct - a.parPct);
    base.industryDistributionPct = distribution;
    base.largestIndustryPct = distribution[0]?.parPct ?? null;
  }
  return base;
}

/** Concentration-test metric: par share held by the top N obligors.
 *  Groups `parBalance` by `obligorName` (case-sensitive, no normalization),
 *  sorts descending, sums the top N, divides by total par. Returns 0 when
 *  there are fewer than N distinct obligors or total par is zero.
 *
 *  N defaults to 10 (the PPM-standard "top 10 obligors" concentration limit). */
export function computeTopNObligorsPct(
  loans: Array<{ parBalance: number; obligorName?: string | null }>,
  n: number = 10,
): number {
  const parByObligor = new Map<string, number>();
  let totalPar = 0;
  for (const l of loans) {
    const par = l.parBalance;
    if (par <= 0) continue;
    totalPar += par;
    const name = l.obligorName ?? "";
    if (!name) continue; // unnamed positions can't be grouped; contribute to total but not to any bucket
    parByObligor.set(name, (parByObligor.get(name) ?? 0) + par);
  }
  if (totalPar === 0) return 0;
  const sorted = Array.from(parByObligor.values()).sort((a, b) => b - a);
  const topSum = sorted.slice(0, n).reduce((s, v) => s + v, 0);
  return (topSum / totalPar) * 100;
}

/** Coarse RatingBucket → Moody's WARF factor fallback. Used when per-position
 *  `warfFactor` is absent (NR loans with no resolver-populated factor,
 *  reinvested synthetic loans). NR→Caa2 (6500) per Moody's CLO methodology
 *  convention; see KI-19. */
export const BUCKET_WARF_FALLBACK: Record<string, number> = {
  AAA: 1,
  AA: 20,
  A: 120,
  BBB: 360,
  BB: 1350,
  B: 2720,
  CCC: 6500,
  NR: 6500,
};

/** Resolve a per-position warfFactor at any LoanInput | ResolvedLoan →
 *  downstream-consumer boundary. Throws on explicit zero, negative, NaN, or
 *  Infinity — all four produce silent zero-hazard or non-finite propagation
 *  under per-position WARF. `warfFactorToQuarterlyHazard` returns 0 on
 *  `!Number.isFinite(warfFactor)` AND on `<= 0`, so any malformed value
 *  silently disables defaults for the position; NaN additionally
 *  propagates through `??` (which only coalesces null/undefined) and
 *  poisons downstream WARF aggregations.
 *
 *  The valid representations of "no per-position factor available" are
 *  `null` and `undefined`, both of which trigger the
 *  BUCKET_WARF_FALLBACK[ratingBucket] → BUCKET_WARF_FALLBACK.NR fallback
 *  chain (every entry ≥ 1, never silent).
 *
 *  Anti-pattern guard per CLAUDE.md anti-pattern #5: the failure mode this
 *  prevents is the "boundary type carries no invariant" shape — the TS
 *  type permits any `number`, so the runtime guard is the only thing
 *  standing between a malformed input and a silent missing-defaults bug.
 *  Throw loud, never re-interpret. Single source of truth so any future
 *  ResolvedLoan → engine boundary that consumes warfFactor is guarded
 *  identically (matches the "boundaries assert sign and scale" rule). */
export function resolveWarfFactor(
  rawWarfFactor: number | null | undefined,
  ratingBucket: string,
): number {
  if (rawWarfFactor != null && (!Number.isFinite(rawWarfFactor) || rawWarfFactor <= 0)) {
    throw new Error(
      `Invalid warfFactor: ${rawWarfFactor} (must be a finite number > 0). ` +
      `Use null or undefined to fall back to BUCKET_WARF_FALLBACK[ratingBucket]; ` +
      `passing 0, negative, NaN, or Infinity silently disables defaults for ` +
      `this position via warfFactorToQuarterlyHazard's <=0 / !isFinite guard ` +
      `returning 0. NaN additionally poisons downstream WARF aggregation ` +
      `(warfSum += par × NaN propagates through \`??\` which coalesces only ` +
      `null/undefined, surfacing as NaN in partner-facing WARF display rather ` +
      `than just suppressed defaults).`,
    );
  }
  return rawWarfFactor ?? BUCKET_WARF_FALLBACK[ratingBucket] ?? BUCKET_WARF_FALLBACK.NR;
}
