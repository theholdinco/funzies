/**
 * KI-61 closure pin — partial-default Caa/CCC concentration exclusion.
 *
 * Closure context: PPM Condition 1 / definitions ("Caa Obligations" PDF p.
 * 138, "CCC Obligations" PDF p. 127) categorically exclude Defaulted
 * Obligations from the per-agency Caa and Fitch CCC sets. Conservative
 * interpretation: any obligor with non-zero `defaultedParPending` is a
 * Defaulted Obligation in its entirety — its surviving piece does NOT count
 * toward Caa/CCC numerator OR denominator. The closure adds
 * `defaultedParPending > 0 → continue` filters at BOTH per-period
 * `computeQualityMetrics` (projection.ts ~1421) and the pre-buy
 * `maxCompliantReinvestment` gate (projection.ts ~1273) — the parallel-
 * implementation invariant requires identical exclusions on both sides so
 * the gate's pre-buy state and the per-period output are bit-identical.
 *
 * Without the filter: a partially-defaulted CCC loan with `survivingPar > 0`
 * would inflate `pctMoodysCaa` (numerator and denominator both grow, but the
 * Caa flag biases the ratio upward). On Euro XV today the magnitude is zero
 * (the fixture has no partial defaults), but it emerges on any deal whose
 * default-draw model produces fractional defaults — the engine's default
 * helper `(par, hz) => par * hz` is fractional by construction, so any
 * non-zero hazard on a CCC loan with `recoveryLagMonths > 3` produces the
 * partial-default state for at least one period.
 *
 * What this test pins:
 *   1. Construct a 2-loan pool: 1 CCC (Caa-flagged via bucket fallback) +
 *      1 B. Force CDR only on CCC (`defaultRatesByRating: { CCC: 20, ... }`)
 *      with a long recovery lag so partial-default state persists.
 *   2. Find a period where the CCC loan must be partially defaulted (every
 *      period after the first default fires, before the recovery clears).
 *   3. Assert `qualityMetrics.pctMoodysCaa === 0` — the CCC loan is excluded
 *      entirely. Without the closure, the same period would report
 *      `pctMoodysCaa > 0`.
 *
 * Regression contract: a future PR that drops the filter from EITHER
 * `computeQualityMetrics` OR `maxCompliantReinvestment` would re-introduce
 * the same wrong-direction concentration math the closure was filed to
 * prevent. This test fails on the per-period output side; companion
 * coverage on the gate side is asserted via boundary tests in
 * `c1-reinvestment-compliance.test.ts` (the gate's pre-buy denominator
 * derivation reads the same `loanStates`).
 */

import { describe, it, expect } from "vitest";
import { runProjection, addQuarters } from "@/lib/clo/projection";
import type { LoanInput, ProjectionInputs } from "@/lib/clo/projection";
import { CLO_DEFAULTS } from "@/lib/clo/defaults";

function buildPartialDefaultInputs(): ProjectionInputs {
  // Two-loan pool: one CCC, one B. Equal par so the without-fix pctMoodysCaa
  // would be ~50% (modulo the CCC default), well above zero — the assertion
  // boundary is unambiguous.
  const loans: LoanInput[] = [
    {
      parBalance: 50_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "CCC",
      spreadBps: 500,
    currency: "EUR",
    },
    {
      parBalance: 50_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 375,
    currency: "EUR",
    },
  ];

  // Hazard only on CCC. Other buckets at 0 so the B loan stays clean
  // (defaultedParPending = 0 → included in the metrics).
  const defaultRatesByRating: Record<string, number> = {
    AAA: 0, AA: 0, A: 0, BBB: 0, BB: 0, B: 0, CCC: 20, NR: 0,
  };

  return {
    initialPar: 100_000_000,
    dealCurrency: "EUR",
    wacSpreadBps: 437,
    baseRatePct: CLO_DEFAULTS.baseRatePct,
    baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
    seniorFeePct: CLO_DEFAULTS.seniorFeePct,
    subFeePct: CLO_DEFAULTS.subFeePct,
    tranches: [
      { className: "A", currentBalance: 65_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
      { className: "J", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
      { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
    ],
    ocTriggers: [
      { className: "A", triggerLevel: 120, rank: 1 },
      { className: "J", triggerLevel: 110, rank: 2 },
    ],
    icTriggers: [
      { className: "A", triggerLevel: 120, rank: 1 },
      { className: "J", triggerLevel: 110, rank: 2 },
    ],
    reinvestmentPeriodEnd: "2028-06-15",
    maturityDate: "2034-06-15",
    currentDate: "2026-03-09",
    loans,
    defaultRatesByRating,
    cprPct: 0, // no prepayments — keep state clean
    recoveryPct: 50,

    ratingAgencies: ["moodys", "sp", "fitch"],    // Long recovery lag — defaulted par sits in `defaultedParPending` for
    // ~8 quarters before the recovery event arrives. Plenty of periods with
    // the partial-default state for the assertion to target.
    recoveryLagMonths: 24,
    reinvestmentSpreadBps: CLO_DEFAULTS.reinvestmentSpreadBps,
    reinvestmentTenorQuarters: CLO_DEFAULTS.reinvestmentTenorYears * 4,
    reinvestmentRating: null,
    cccBucketLimitPct: CLO_DEFAULTS.cccBucketLimitPct,
    cccMarketValuePct: CLO_DEFAULTS.cccMarketValuePct,
    deferredInterestCompounds: true,
    trusteeFeeBps: 0,
    hedgeCostBps: 0,
    incentiveFeePct: 0,
    incentiveFeeHurdleIrr: 0,
    postRpReinvestmentPct: 0,
    callMode: "none",
    callDate: null,
    callPricePct: 100,
    callPriceMode: "par",
    reinvestmentOcTrigger: null,
    initialPrincipalCash: 0,
    preExistingDefaultedPar: 0,
    preExistingDefaultRecovery: 0,
    unpricedDefaultedPar: 0,
    preExistingDefaultOcValue: 0,
    longDatedObligationHaircut: 0,
    impliedOcAdjustment: 0,
    quartersSinceReport: 0,
    ddtlDrawPercent: 100,
  };
}

describe("KI-61 closure — partial-default Caa/CCC concentration exclusion", () => {
  it("partially-defaulted CCC loan is excluded from pctMoodysCaa entirely", () => {
    const inputs = buildPartialDefaultInputs();
    const result = runProjection(inputs);

    // Periods 2-7: the CCC loan has defaulted (in some amount) by period 1
    // and the recovery hasn't arrived yet (24-month lag = 8 quarters).
    // In every such period, `defaultedParPending > 0` for the CCC loan, so
    // the closure filter excludes it from the numerator and denominator.
    // Only the B loan remains in the denominator → pctMoodysCaa = 0.
    const partialDefaultPeriods = result.periods.slice(1, 7);
    expect(partialDefaultPeriods.length).toBeGreaterThan(0);

    for (const p of partialDefaultPeriods) {
      // Sanity: B loan still alive, so totalPar > 0 (qualityMetrics is well-
      // defined, not the empty-pool case).
      expect(p.qualityMetrics.warf).toBeGreaterThan(0);
      // Closure assertion: CCC loan is excluded → pctMoodysCaa = 0 exactly.
      expect(p.qualityMetrics.pctMoodysCaa).toBe(0);
      // pctCccAndBelow = max(pctMoodysCaa, pctFitchCcc) — since the bucket-
      // fallback path uses ratingBucket === "CCC" for both per-agency
      // counters, pctFitchCcc must also be 0, so the published aggregate
      // collapses to 0 too.
      expect(p.qualityMetrics.pctCccAndBelow).toBe(0);
    }
  });

  it("control: clean (non-defaulted) CCC loan IS counted in pctMoodysCaa", () => {
    // Same shape but defaults genuinely disabled (per-position requires the
    // multiplier-pair pattern: non-zero baseline + zero-returning path-fn,
    // because a zero rates map alone leaves warfHazard active under per-
    // position WARF). With no defaults, no partial-default state — the CCC
    // loan must appear in the concentration. Confirms the closure filter is
    // gated on `defaultedParPending > 0`, not blanket-excluding all CCC.
    const inputs = buildPartialDefaultInputs();
    inputs.defaultRatesByRating = {
      AAA: 1, AA: 1, A: 1, BBB: 1, BB: 1, B: 1, CCC: 1, NR: 1,
    };
    inputs.cdrMultiplierPathFn = () => ({
      AAA: 0, AA: 0, A: 0, BBB: 0, BB: 0, B: 0, CCC: 0, NR: 0,
    });
    const result = runProjection(inputs);

    // Period 1: both loans clean, equal par. pctMoodysCaa ≈ 50% (CCC half
    // of denominator). Use a loose lower bound to absorb any rounding /
    // amortisation drift in the first quarter.
    const p1 = result.periods[0];
    expect(p1.qualityMetrics.pctMoodysCaa).toBeGreaterThan(40);
    expect(p1.qualityMetrics.pctMoodysCaa).toBeLessThan(60);
  });
});
