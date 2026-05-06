/**
 * Per-position agency recovery rates apply at the forward-default site,
 * not just at the resolver's T=0 reduction. Regression guard: a future
 * change that drops `recoveryRateAgency` from `LoanState`, makes the
 * helper fall back to global on every loan, or rewrites either call
 * site (resolver T=0 reduction OR engine LoanState construction) to
 * pass a different agency subset must fail here.
 *
 * Two synthetic loans default in the same period under identical hazard.
 * One carries `recoveryRateMoodys = 70` (70%), the other carries 30 (30%).
 * The global `recoveryPct` is set to 50 so the per-loan vs global outcomes
 * differ visibly:
 *
 *   - Pre-fix engine: each loan recovers at 50% → 0.5M each, 1.0M total.
 *   - Post-fix engine: 0.7M and 0.3M respectively, 1.0M total (sum
 *     coincides; per-event amounts differ).
 *
 * The assertion targets per-event `recoveryAmount` directly so the test is
 * meaningful even when the totals collide. A regression that drops the
 * agency rate (e.g., LoanState dropping the field, or the helper falling
 * back to global) shows up as both events recovering at 50% — visible at
 * the per-event grain regardless of total.
 *
 * The third test ("call site passes all three agencies") closes a
 * coverage gap raised during review: the helper's own unit test pins
 * the helper's output behavior, but does not exercise the call-site
 * agency-selection. A future PR that drops Moody's at the call site
 * (e.g., to address per-deal-PPM language about "Lesser of Fitch and
 * S&P") would fix the agency subset without touching the helper —
 * unit-helper tests would still pass while the actual semantic
 * flipped. Asserting end-to-end that a Moody's-lowest scenario picks
 * the Moody's value through the engine binds the call site directly.
 */

import { describe, it, expect } from "vitest";
import { runProjection } from "@/lib/clo/projection";
import type { LoanInput, ProjectionInputs } from "@/lib/clo/projection";
import { CLO_DEFAULTS } from "@/lib/clo/defaults";

function buildKi32Inputs(): ProjectionInputs {
  // Both loans carry warfFactor=10000 (Moody's Ca/C) → quarterly hazard = 1.0
  // → instant default in Q1. Both share the same hazard so the only varying
  // input is the per-loan recovery rate. Recovery rates differ to expose
  // the per-loan dispatch.
  const loans: LoanInput[] = [
    {
      parBalance: 1_000_000,
      maturityDate: "2030-01-01",
      ratingBucket: "CCC",
      spreadBps: 500,
      warfFactor: 10000,
      recoveryRateMoodys: 70, // → 0.70 fraction
    },
    {
      parBalance: 1_000_000,
      maturityDate: "2030-01-01",
      ratingBucket: "CCC",
      spreadBps: 500,
      warfFactor: 10000,
      recoveryRateMoodys: 30, // → 0.30 fraction
    },
  ];

  // Defaults rate map kept zero — per-position branch ignores it; warfFactor
  // governs hazard.
  const defaultRatesByRating: Record<string, number> = {
    AAA: 0, AA: 0, A: 0, BBB: 0, BB: 0, B: 0, CCC: 0, NR: 0,
  };

  return {
    initialPar: 2_000_000,
    wacSpreadBps: 500,
    baseRatePct: CLO_DEFAULTS.baseRatePct,
    baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
    seniorFeePct: 0,
    subFeePct: 0,
    tranches: [
      { className: "A", currentBalance: 1_500_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
      { className: "Sub", currentBalance: 500_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
    ],
    ocTriggers: [],
    icTriggers: [],
    reinvestmentPeriodEnd: null,
    maturityDate: "2030-01-01",
    currentDate: "2026-01-01",
    loans,
    defaultRatesByRating,
    cprPct: 0,
    recoveryPct: 50, // Global fallback. Differs from both per-loan rates so
    ratingAgencies: ["moodys", "sp", "fitch"],
                    // the per-loan dispatch is observable from the totals.
    recoveryLagMonths: 0, // Recover same period — easier to read events.
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
    eventOfDefaultTest: null,
    nonCallPeriodEnd: null,
  };
}

describe("per-position agency recovery rate at forward-default site", () => {
  it("two loans default same period; per-event recoveryAmount reflects each loan's agency rate, not the global", () => {
    const result = runProjection(buildKi32Inputs());
    const period1 = result.periods[0];

    // Both loans should have defaulted in period 1 under 99.99% CDR.
    // (Quarterly hazard from a 99.99% annual CDR is ~90% so each €1M loan
    // contributes ~€900k of defaults; the precise number is set by the
    // engine's annualized→quarterly conversion and is incidental — the
    // invariant lives in the per-event RATE, not the total.)
    expect(period1.loanDefaultEvents.length).toBe(2);
    expect(period1.defaults).toBeGreaterThan(1_500_000);

    // Sort events by recoveryAmount so the assertion is index-stable
    // regardless of internal loan ordering.
    const sorted = [...period1.loanDefaultEvents].sort((a, b) => a.recoveryAmount - b.recoveryAmount);
    const lowRecovery = sorted[0];
    const highRecovery = sorted[1];

    // Defaulted par per loan: significant fraction of €1M after quarterly
    // hazard proration of 99.99% annual CDR (≈ 90% per quarter).
    expect(lowRecovery.defaultedPar).toBeGreaterThan(700_000);
    expect(highRecovery.defaultedPar).toBeGreaterThan(700_000);

    // Per-loan recovery rates: low loan at 30%, high loan at 70%.
    // Pre-fix this would assert ~50% each (the global recoveryPct).
    expect(lowRecovery.recoveryAmount / lowRecovery.defaultedPar).toBeCloseTo(0.30, 2);
    expect(highRecovery.recoveryAmount / highRecovery.defaultedPar).toBeCloseTo(0.70, 2);

    // Aggregate recoveries this period = Σ event.recoveryAmount (Tier 2 identity).
    const eventSum = period1.loanDefaultEvents.reduce((s, e) => s + e.recoveryAmount, 0);
    expect(period1.recoveries).toBeCloseTo(eventSum, 2);
  });

  it("loan with no agency rates falls back to global recoveryPct", () => {
    const inputs = buildKi32Inputs();
    // Strip the recovery rates from one loan; it should fall back to global 50%.
    inputs.loans[0] = { ...inputs.loans[0], recoveryRateMoodys: undefined };
    const result = runProjection(inputs);
    const period1 = result.periods[0];

    const events = [...period1.loanDefaultEvents].sort((a, b) => a.recoveryAmount - b.recoveryAmount);
    // The 30%-rate loan now stands alone at the low end (the other loan
    // fell back to 50%, between 30 and 70).
    const lowest = events[0];
    const middle = events[1];
    expect(lowest.recoveryAmount / lowest.defaultedPar).toBeCloseTo(0.30, 2);
    expect(middle.recoveryAmount / middle.defaultedPar).toBeCloseTo(0.50, 2);
  });

  it("forward-default site honors ratingAgencies subset (S&P-lowest dropped when subset = [moodys, fitch])", () => {
    // Discriminating wiring test for the engine forward-default site.
    // The helper-level unit test in `recovery-rate.test.ts` pins that
    // `resolveAgencyRecovery` filters by subset; this asserts that the
    // engine passes `ratingAgencies` (not a hardcoded literal) into the
    // helper. If the call site in projection.ts is rewritten to omit
    // the subset arg or to pass `["moodys", "sp", "fitch"]` literal,
    // the helper-level unit tests still pass — the bug is silent.
    // This test pins the wiring.
    //
    // Setup: loan 0 with Moody's=40, S&P=10, Fitch=60. Subset =
    // ["moodys", "fitch"] (Euro-shape). Helper should drop S&P → min(40,
    // 60)=40 → recoveryAmount/defaultedPar = 0.40. With S&P included
    // (the broken-wiring shape), the answer would be 0.10.
    const inputs = buildKi32Inputs();
    inputs.ratingAgencies = ["moodys", "fitch"];
    inputs.loans[0] = {
      ...inputs.loans[0],
      recoveryRateMoodys: 40,
      recoveryRateSp: 10,
      recoveryRateFitch: 60,
    };
    inputs.loans[1] = {
      ...inputs.loans[1],
      recoveryRateMoodys: 90, // park well above so sort is index-stable
      recoveryRateSp: undefined,
      recoveryRateFitch: undefined,
    };
    const result = runProjection(inputs);
    const events = [...result.periods[0].loanDefaultEvents].sort(
      (a, b) => a.recoveryAmount - b.recoveryAmount,
    );
    const subsetFiltered = events[0];
    expect(subsetFiltered.recoveryAmount / subsetFiltered.defaultedPar).toBeCloseTo(0.40, 2);
  });

  it("call site passes all three agency rates — Moody's-lowest scenario picks Moody's value end-to-end", () => {
    // Closes a coverage gap between the helper's unit test (which pins
    // `Math.min` over whatever's passed) and the call-site behavior. A
    // loan with three distinct rates whose lowest is Moody's tells us
    // that the call site (LoanState construction in projection.ts)
    // passes Moody's into the helper. If a future PR were to drop
    // Moody's at the call site, this assertion would fail — the
    // recoveryAmount would land at min(50, 60) = 50%, not 20%. The
    // Adjusted CPA paragraph (e) per-deal Rating Agencies subset filter
    // sits ON TOP of this; the engine input here defaults `ratingAgencies`
    // to all three so this test continues to pin the call-site arity.
    const inputs = buildKi32Inputs();
    inputs.loans[0] = {
      ...inputs.loans[0],
      recoveryRateMoodys: 20,
      recoveryRateSp: 50,
      recoveryRateFitch: 60,
    };
    inputs.loans[1] = {
      ...inputs.loans[1],
      recoveryRateMoodys: 80,  // park other loan well above so sort is index-stable
      recoveryRateSp: undefined,
      recoveryRateFitch: undefined,
    };
    const result = runProjection(inputs);
    const events = [...result.periods[0].loanDefaultEvents].sort(
      (a, b) => a.recoveryAmount - b.recoveryAmount,
    );
    const lowestEvent = events[0];
    expect(lowestEvent.recoveryAmount / lowestEvent.defaultedPar).toBeCloseTo(0.20, 2);
  });
});
