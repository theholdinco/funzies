/**
 * Engine invariant: pari-passu tranches (sharing `seniorityRank`) absorb
 * interest and principal pro-rata under shortfall — they don't pay
 * sequentially. The pre-acceleration interest waterfall and principal
 * first-pass key off rank-grouped iteration; without it, B-1 paid in full
 * and B-2 zero is the failure shape on a Class B-1+B-2 split.
 *
 * Three scenarios:
 *   1. Interest absorption — B-1 and B-2 split available interest pro-rata
 *      by `gInterestDue / totalGroupDue` (engine's rule), discriminating
 *      against the sequential alternative on different spreads.
 *   2. Principal absorption — at maturity, B-1 and B-2 split available
 *      principal pro-rata by balance.
 *   3. Diversion-gate shift — when Class B OC fails, both pari-passu
 *      members are paid before the cure fires (rank-boundary check fires
 *      at the END of the group, not between members).
 */

import { describe, it, expect } from "vitest";
import { runProjection, addQuarters, type ProjectionInputs, type LoanInput } from "../projection";
import { CLO_DEFAULTS } from "../defaults";
import { DEFAULT_RATES_BY_RATING } from "../rating-mapping";
import { uniformRates } from "./test-helpers";

function makeSplitBInputs(overrides: Partial<ProjectionInputs> = {}): ProjectionInputs {
  const loans: LoanInput[] = Array.from({ length: 20 }, (_, i) => ({
    parBalance: 24_500_000,
    maturityDate: addQuarters("2026-03-09", 24 + (i % 8)),
    ratingBucket: i < 14 ? "B" : "B-",
    spreadBps: 410,
  }));
  return {
    initialPar: 490_000_000,
    wacSpreadBps: 410,
    baseRatePct: CLO_DEFAULTS.baseRatePct,
    baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
    seniorFeePct: CLO_DEFAULTS.seniorFeePct,
    subFeePct: CLO_DEFAULTS.subFeePct,
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
    tranches: [
      { className: "A",   currentBalance: 245_000_000, spreadBps: 110, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
      // B-1, B-2 share rank 2 — pari-passu pair. Different spreads so
      // pro-rata-by-due differs from pro-rata-by-balance. Class B is
      // non-deferrable per PPM (D1 rank-based predicate).
      { className: "J-1", currentBalance: 50_000_000,  spreadBps: 165, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
      { className: "J-2", currentBalance: 30_000_000,  spreadBps: 280, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
      { className: "C",   currentBalance: 40_000_000,  spreadBps: 350, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true  },
      { className: "Sub", currentBalance: 30_000_000,  spreadBps: 0,   seniorityRank: 4, isFloating: false, isIncomeNote: true,  isDeferrable: false },
    ],
    ocTriggers: [
      { className: "A",   triggerLevel: 129.0, rank: 1 },
      { className: "J-1", triggerLevel: 120.0, rank: 2 },
      { className: "C",   triggerLevel: 114.0, rank: 3 },
    ],
    icTriggers: [],
    reinvestmentPeriodEnd: "2030-06-15",
    maturityDate: "2036-06-15",
    currentDate: "2026-03-09",
    loans,
    defaultRatesByRating: { ...DEFAULT_RATES_BY_RATING },
    cprPct: CLO_DEFAULTS.cprPct,
    recoveryPct: CLO_DEFAULTS.recoveryPct,

    ratingAgencies: ["moodys", "sp", "fitch"],    recoveryLagMonths: CLO_DEFAULTS.recoveryLagMonths,
    reinvestmentSpreadBps: CLO_DEFAULTS.reinvestmentSpreadBps,
    reinvestmentTenorQuarters: CLO_DEFAULTS.reinvestmentTenorYears * 4,
    reinvestmentRating: null,
    cccBucketLimitPct: CLO_DEFAULTS.cccBucketLimitPct,
    cccMarketValuePct: CLO_DEFAULTS.cccMarketValuePct,
    deferredInterestCompounds: true,
    ...overrides,
  };
}

describe("engine pari-passu absorption — interest waterfall", () => {
  it("B-1 + B-2 split available interest pro-rata by interest-due under shortfall", () => {
    // Senior mgmt fee tuned so available interest reaches the J-group with
    // strictly less than total J-group due — the discriminating shortfall
    // scenario. Under KI-36 monthly asset timing, 4.2% senior mgmt fee leaves
    // J-1 with ~€204K of €479K due and J-2 with ~€160K of €376K due. Both partial; pro-rata
    // by interest-due holds (paid_J1/paid_J2 == due_J1/due_J2 to ~1e-4).
    const inputs = makeSplitBInputs({
      seniorFeePct: 4.2,
      icTriggers: [],
      ocTriggers: [],
    });

    const result = runProjection(inputs);
    const p1 = result.periods[0];

    const b1 = p1.trancheInterest.find((t) => t.className === "J-1")!;
    const b2 = p1.trancheInterest.find((t) => t.className === "J-2")!;
    expect(b1).toBeDefined();
    expect(b2).toBeDefined();
    expect(b1.due).toBeGreaterThan(0);
    expect(b2.due).toBeGreaterThan(0);

    // Discriminating assertion against the pre-fix sequential failure shape.
    // Pre-fix would have produced b1.paid ≈ available and b2.paid = 0
    // because J-1 (was at rank 2) iterated first and consumed remaining
    // before J-2 (was at rank 3) saw a cent. Post-fix: both partial.
    const totalPaid = b1.paid + b2.paid;
    const totalDue = b1.due + b2.due;
    expect(totalPaid).toBeLessThan(totalDue); // confirm shortfall scenario
    expect(b2.paid).toBeGreaterThan(0); // discriminates against sequential
    expect(b1.paid).toBeLessThan(b1.due); // discriminates against "J-1 paid in full"

    // Pro-rata split: paid_i / paid_j ≈ due_i / due_j
    const paidRatio = b1.paid / b2.paid;
    const dueRatio = b1.due / b2.due;
    expect(paidRatio).toBeCloseTo(dueRatio, 4);
  });

  it("PIK on shortfall fires per member (deferrable C-1 and C-2 both PIK their per-member shortfall)", () => {
    // Structurally: pari-passu split at the most-junior PIK-deferrable rank.
    // Class A (rank 1) and Class B (rank 2) are non-deferrable per PPM (D1
    // rank-based predicate); the deferrable split lives at rank 3.
    //
    // Senior mgmt fee 3.8% tunes residual at the rank-3 boundary into the
    // strict shortfall window — between J-1's demand (~376K) and total
    // J-group demand (~626K). At this residual the pre-KI-57 sequential
    // failure shape and the post-fix pari-passu form produce DIFFERENT paid
    // amounts:
    //   pre-fix sequential: J-1 paid full (~376K, PIK=0), J-2 paid the
    //                       remainder (~147K, PIK=~104K).
    //   post-fix pari-passu: both partial — J-1 ~314K (PIK=~62K), J-2 ~209K
    //                        (PIK=~41K), paid ratio == due ratio == 1.5.
    // Asserting J-1 partial (paid < due, PIK > 0) AND ratio ≈ due ratio
    // strictly excludes the sequential shape.
    const inputs = makeSplitBInputs({
      seniorFeePct: 3.8,
      icTriggers: [],
      ocTriggers: [],
      tranches: [
        { className: "A",   currentBalance: 245_000_000, spreadBps: 110, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B",   currentBalance:  50_000_000, spreadBps: 165, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        // Pari-passu PIK pair at rank 3
        { className: "J-1", currentBalance:  30_000_000, spreadBps: 280, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true  },
        { className: "J-2", currentBalance:  20_000_000, spreadBps: 280, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true  },
        { className: "Sub", currentBalance:  30_000_000, spreadBps:   0, seniorityRank: 4, isFloating: false, isIncomeNote: true,  isDeferrable: false },
      ],
    });
    const result = runProjection(inputs);
    const p1 = result.periods[0];
    const j1 = p1.trancheInterest.find((t) => t.className === "J-1")!;
    const j2 = p1.trancheInterest.find((t) => t.className === "J-2")!;
    const j1PIK = p1.stepTrace?.deferredAccrualByTranche?.["J-1"] ?? 0;
    const j2PIK = p1.stepTrace?.deferredAccrualByTranche?.["J-2"] ?? 0;

    // Confirm we ARE in the discriminating shortfall window: residual reaches
    // J-group, both members partial. Pre-KI-57 sequential at this same
    // residual would pay J-1 fully (paid == due, PIK == 0) and J-2 the
    // remainder; the assertions below would fail.
    expect(j1.paid).toBeGreaterThan(0);
    expect(j1.paid).toBeLessThan(j1.due); // discriminates against "J-1 paid in full"
    expect(j2.paid).toBeGreaterThan(0);
    expect(j2.paid).toBeLessThan(j2.due);

    // Pari-passu pro-rata invariant — same shape as test 1.
    expect(j1.paid / j2.paid).toBeCloseTo(j1.due / j2.due, 4);

    // PIK trace must appear for BOTH members (per-member, not aggregated).
    expect(j1PIK).toBeGreaterThan(0);
    expect(j2PIK).toBeGreaterThan(0);
    expect(j1PIK).toBeLessThan(j1.due); // J-1 partial PIK, not full demand
    expect(j2PIK).toBeLessThan(j2.due);
    expect(j1PIK / j2PIK).toBeCloseTo(j1.due / j2.due, 4);
  });
});

describe("engine pari-passu absorption — principal waterfall", () => {
  it("at maturity, J-1 and J-2 split available principal pro-rata by balance under shortfall", () => {
    // Tuned so prelim at maturity is strictly between A's balance and
    // (A + J-group) — both J members partial, neither wiped.
    //
    // Single 300M loan maturing at deal maturity. CDR=20% over 4 quarters
    // depletes pool to ~166M. After paying A (200M needs)... actually pool
    // can't fully cover A. Let me use a tighter setup:
    //   A=200M, J-1=50M, J-2=30M, total senior debt 280M.
    //   With CDR=20% on 300M pool, ~166M survives at maturity.
    //   Wait — that doesn't cover A either.
    //
    // Calibrated empirically (debug script in commit history): at
    // CDR=20% on a 300M single-loan pool with A=200M / J-1=50M / J-2=30M
    // and no senior fees, the maturity period delivers ~54M to the
    // J-group after Class A is paid. Pre-fix sequential: J-1 paid ~50M
    // (full), J-2 paid ~4M (partial). Post-fix pari-passu: J-1 paid
    // ~33.6M (~67%), J-2 paid ~20.2M (~67%) — same retention fraction.
    // The discriminator: post-fix end-balance ratio is exactly 50/30.
    const loans: LoanInput[] = [
      { parBalance: 300_000_000, maturityDate: "2027-03-09", ratingBucket: "B", spreadBps: 410 },
    ];
    const inputs: ProjectionInputs = {
      initialPar: 300_000_000, wacSpreadBps: 410,
      baseRatePct: CLO_DEFAULTS.baseRatePct, baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
      seniorFeePct: 0, subFeePct: 0,
      trusteeFeeBps: 0, hedgeCostBps: 0, incentiveFeePct: 0, incentiveFeeHurdleIrr: 0,
      postRpReinvestmentPct: 0, callMode: "none", callDate: null, callPricePct: 100, callPriceMode: "par",
      reinvestmentOcTrigger: null,
      tranches: [
        { className: "A",   currentBalance: 200_000_000, spreadBps: 110, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        // Class B-1 / B-2 pari-passu (non-deferrable per PPM)
        { className: "J-1", currentBalance: 50_000_000,  spreadBps: 165, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "J-2", currentBalance: 30_000_000,  spreadBps: 165, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000,  spreadBps: 0,   seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [], icTriggers: [],
      reinvestmentPeriodEnd: "2026-04-01",
      maturityDate: "2027-03-09",
      currentDate: "2026-03-09",
      loans,
      defaultRatesByRating: uniformRates(20),
      // Per-position branch otherwise produces ~0.79%/q B-bucket warfHazard
      // (~3.1%/y) regardless of the rates map. Path multiplier 140/20 = 7
      // scales warfHazard to ~5.5%/q matching the legacy uniformRates(20)
      // ≈ 5.4%/q intent → ~30M defaults over 4 quarters → pool 270M < 280M
      // total junior debt → both J-1/J-2 partially paid pari-passu.
      cdrMultiplierPathFn: () => uniformRates(140),
      cprPct: 0, recoveryPct: 0, recoveryLagMonths: 6,
      ratingAgencies: ["moodys", "sp", "fitch"],
      reinvestmentSpreadBps: 0, reinvestmentTenorQuarters: 8,
      reinvestmentRating: null, cccBucketLimitPct: 100, cccMarketValuePct: 100,
      deferredInterestCompounds: true,
    };

    const result = runProjection(inputs);
    const last = result.periods[result.periods.length - 1];
    const j1 = last.tranchePrincipal.find((t) => t.className === "J-1")!;
    const j2 = last.tranchePrincipal.find((t) => t.className === "J-2")!;

    // Both partial — neither wiped, neither fully paid. Discriminates the
    // sequential pre-fix layout (J-1 fully paid, J-2 ~partial) from the
    // post-fix pari-passu layout (both partial, same retention fraction).
    expect(j1.endBalance).toBeGreaterThan(0.01);
    expect(j2.endBalance).toBeGreaterThan(0.01);
    expect(j1.endBalance).toBeLessThan(50_000_000 - 0.01); // not unchanged
    expect(j2.endBalance).toBeLessThan(30_000_000 - 0.01); // not unchanged

    // Pro-rata-by-balance: both reduced by same fraction → end-balance
    // ratio equals original-balance ratio.
    const endRatio = j1.endBalance / j2.endBalance;
    expect(endRatio).toBeCloseTo(50 / 30, 4);
  });
});

describe("engine cure paydown — Class X exclusion", () => {
  it("cure paydown does not consume Class X balance (X excluded from OC denominator)", () => {
    // PPM cure semantics: divert interest to pay down notes whose paydown
    // reduces the OC denominator. Class X is excluded from `ocEligibleTranches`
    // (the OC denominator), so paying it down via cure is wasted cash — the
    // failing test stays failed. The diversion must skip Class X.
    //
    // Setup: Class X amortising (2M balance, 400K/period schedule) + A + B-1
    // + B-2 + C. Tight Class B OC trigger fails outside RP → cure paydown
    // mode. Pre-fix: cure paydown loop iterates `sortedTranches`, would pay
    // X first sequentially (consuming up to its full balance from the
    // diversion). Post-fix: the loop's `if (dt.isAmortising) continue` skips
    // X entirely.
    //
    // Discriminator: the period's Class X balance change equals exactly the
    // Step G amort schedule (paid via interest waterfall), NOT amort +
    // cure-paydown share.
    const loans: LoanInput[] = Array.from({ length: 8 }, (_, i) => ({
      parBalance: 30_000_000,
      maturityDate: addQuarters("2026-03-09", 24 + (i % 4)),
      ratingBucket: "B",
      spreadBps: 410,
    }));
    const inputs: ProjectionInputs = {
      initialPar: 240_000_000, wacSpreadBps: 410,
      baseRatePct: CLO_DEFAULTS.baseRatePct, baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
      seniorFeePct: 0, subFeePct: 0,
      trusteeFeeBps: 0, hedgeCostBps: 0, incentiveFeePct: 0, incentiveFeeHurdleIrr: 0,
      postRpReinvestmentPct: 0, callMode: "none", callDate: null, callPricePct: 100, callPriceMode: "par",
      reinvestmentOcTrigger: null,
      tranches: [
        { className: "X",   currentBalance: 2_000_000,   spreadBps: 0,   seniorityRank: 1, isFloating: false, isIncomeNote: false, isDeferrable: false, isAmortising: true, amortisationPerPeriod: 400_000, amortStartDate: addQuarters("2026-03-09", 2) },
        { className: "A",   currentBalance: 130_000_000, spreadBps: 110, seniorityRank: 2, isFloating: true,  isIncomeNote: false, isDeferrable: false },
        // Class B-1, B-2 pari-passu (non-deferrable per PPM)
        { className: "J-1", currentBalance: 30_000_000,  spreadBps: 165, seniorityRank: 3, isFloating: true,  isIncomeNote: false, isDeferrable: false },
        { className: "J-2", currentBalance: 18_000_000,  spreadBps: 165, seniorityRank: 3, isFloating: true,  isIncomeNote: false, isDeferrable: false },
        { className: "C",   currentBalance: 20_000_000,  spreadBps: 350, seniorityRank: 4, isFloating: true,  isIncomeNote: false, isDeferrable: true  },
        { className: "Sub", currentBalance: 40_000_000,  spreadBps: 0,   seniorityRank: 5, isFloating: false, isIncomeNote: true,  isDeferrable: false },
      ],
      // Failing Class B OC trigger — engineered to fail with the CDR below
      ocTriggers: [{ className: "J-1", triggerLevel: 130.0, rank: 3 }],
      icTriggers: [],
      reinvestmentPeriodEnd: "2026-04-01", // outside RP from Q1 → diversion mode = paydown
      maturityDate: "2034-06-15",
      currentDate: "2026-03-09",
      loans,
      defaultRatesByRating: uniformRates(15),
      cprPct: 0, recoveryPct: 0, recoveryLagMonths: 6,
      ratingAgencies: ["moodys", "sp", "fitch"],
      reinvestmentSpreadBps: 0, reinvestmentTenorQuarters: 8,
      reinvestmentRating: null, cccBucketLimitPct: 100, cccMarketValuePct: 100,
      deferredInterestCompounds: true,
    };

    const result = runProjection(inputs);
    const failPeriod = result.periods.find((p) =>
      p.ocTests.some((t) => t.className === "J-1" && !t.passing)
    );
    expect(failPeriod).toBeDefined();
    if (!failPeriod) return;

    // Class X received its scheduled amort via Step G (interest waterfall)
    // but NOT additional principal via cure paydown. Pre-fix: cure paydown
    // would have additionally consumed X balance up to its remainder, so
    // `paid` would have exceeded `paidFromInterest`. Post-fix: equal —
    // cure-paydown loop skips amortising tranches.
    const xPrincipal = failPeriod.tranchePrincipal.find((t) => t.className === "X")!;
    expect(xPrincipal.paid).toBeCloseTo(xPrincipal.paidFromInterest, 2);

    // Confirm we ARE in the failing-OC + cure-firing scenario, otherwise
    // the test isn't discriminating.
    const cureDiversions = failPeriod.stepTrace?.ocCureDiversions ?? [];
    expect(cureDiversions.length).toBeGreaterThan(0);
    expect(cureDiversions.some((d) => d.amount > 0 && d.mode === "paydown")).toBe(true);
  });
});

describe("engine Step G — X amort fold-in atomicity on split senior", () => {
  it("Class X amort applied exactly once per period even with split A-1 + A-2 senior", () => {
    // Step G (PPM): Class X amort + senior-non-amort interest paid pro rata
    // pari passu. Pre-fix: the sequential loop ran the Step G fold once per
    // tranche at the senior-non-amort rank — so on a deal with split Class A
    // (A-1 + A-2 sharing rank), X amort was paid twice (once when iterator
    // hit A-1, once when it hit A-2), draining 2× the schedule from X
    // balance. Post-fix: rank-grouped iteration runs Step G exactly once for
    // the senior-non-amort group regardless of cardinality.
    //
    // Discriminator: with X scheduled at 400K/period, the period's
    // _stepTrace_classXAmortFromInterest equals 400K (post-fix), not 800K
    // (pre-fix on a 2-member A group).
    const loans: LoanInput[] = Array.from({ length: 5 }, (_, i) => ({
      parBalance: 60_000_000,
      maturityDate: addQuarters("2026-03-09", 24 + i),
      ratingBucket: "B",
      spreadBps: 410,
    }));
    const inputs: ProjectionInputs = {
      initialPar: 300_000_000, wacSpreadBps: 410,
      baseRatePct: CLO_DEFAULTS.baseRatePct, baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
      seniorFeePct: 0, subFeePct: 0,
      trusteeFeeBps: 0, hedgeCostBps: 0, incentiveFeePct: 0, incentiveFeeHurdleIrr: 0,
      postRpReinvestmentPct: 0, callMode: "none", callDate: null, callPricePct: 100, callPriceMode: "par",
      reinvestmentOcTrigger: null,
      tranches: [
        // Class X amortising 400K/period starting Q2.
        { className: "X",   currentBalance: 4_000_000,   spreadBps: 0,   seniorityRank: 1, isFloating: false, isIncomeNote: false, isDeferrable: false, isAmortising: true, amortisationPerPeriod: 400_000, amortStartDate: addQuarters("2026-03-09", 2) },
        // Split senior — A-1 and A-2 share rank 2, the pari-passu shape
        // that exposed the Step G double-pay pre-fix.
        { className: "A-1", currentBalance: 130_000_000, spreadBps: 110, seniorityRank: 2, isFloating: true,  isIncomeNote: false, isDeferrable: false },
        { className: "A-2", currentBalance: 50_000_000,  spreadBps: 110, seniorityRank: 2, isFloating: true,  isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 40_000_000,  spreadBps: 0,   seniorityRank: 3, isFloating: false, isIncomeNote: true,  isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      reinvestmentPeriodEnd: "2030-06-15",
      maturityDate: "2034-06-15",
      currentDate: "2026-03-09",
      loans,
      defaultRatesByRating: uniformRates(0), // no defaults so plenty of interest
      cprPct: 0, recoveryPct: 0, recoveryLagMonths: 6,
      ratingAgencies: ["moodys", "sp", "fitch"],
      reinvestmentSpreadBps: 0, reinvestmentTenorQuarters: 8,
      reinvestmentRating: null, cccBucketLimitPct: 100, cccMarketValuePct: 100,
      deferredInterestCompounds: true,
    };

    const result = runProjection(inputs);
    // Find a period where Step G X amort fires (Q2 onward per amortStartDate)
    const xAmortPeriod = result.periods.find((p) =>
      (p.stepTrace?.classXAmortFromInterest ?? 0) > 0
    );
    expect(xAmortPeriod).toBeDefined();
    if (!xAmortPeriod) return;

    // Exactly one schedule of Step G X amort, not two. The pre-fix double-
    // pay shape on a 2-member A group would have surfaced as 800K (the
    // Step G fold ran inside the per-tranche loop, so each A-rank iteration
    // would have re-applied the X-amort decrement).
    const xAmort = xAmortPeriod.stepTrace?.classXAmortFromInterest ?? 0;
    expect(xAmort).toBeCloseTo(400_000, 2);
  });
});

describe("engine pari-passu absorption — diversion-gate behavior", () => {
  it("when Class B OC fails, B-2 is paid before the cure diverts (rank-boundary fires AFTER the group)", () => {
    // Pre-fix layout: B-1 ranked 2, B-2 ranked 3. atRankBoundary fired
    // after B-1 (rank 2 < B-2's rank 3), so the cure diverted available
    // interest BEFORE B-2 saw any. Post-fix: B-1 and B-2 both rank 2;
    // boundary fires only after both are paid.
    //
    // Test setup: failing Class B OC, plenty of interest to pay both B-1
    // and B-2 in full plus partial cure. Discriminator: B-2 paid > 0.
    const inputs = makeSplitBInputs({
      defaultRatesByRating: uniformRates(15),
      cprPct: 0,
      recoveryPct: 0,

    ratingAgencies: ["moodys", "sp", "fitch"],      ocTriggers: [
        // Tight Class B trigger — 130% should fail with 15% CDR
        { className: "J-1", triggerLevel: 130.0, rank: 2 },
      ],
      icTriggers: [],
      reinvestmentPeriodEnd: "2026-04-01", // outside RP → diversion = paydown
    });

    const result = runProjection(inputs);
    const failPeriod = result.periods.find((p) =>
      p.ocTests.some((t) => t.className === "J-1" && !t.passing)
    );
    expect(failPeriod).toBeDefined();
    if (!failPeriod) return;

    const b1 = failPeriod.trancheInterest.find((t) => t.className === "J-1")!;
    const b2 = failPeriod.trancheInterest.find((t) => t.className === "J-2")!;
    expect(b1.due).toBeGreaterThan(0);
    expect(b2.due).toBeGreaterThan(0);

    // Both members paid before diversion. Pre-fix this assertion would
    // fail because B-2 starved post-diversion-before-it.
    expect(b2.paid).toBeGreaterThan(0);
    expect(b1.paid).toBeGreaterThan(0);

    // The cure divert (paydown) is recorded once at rank 2, not split
    // across an inter-group fire.
    const diversions = failPeriod.stepTrace?.ocCureDiversions ?? [];
    const rank2Diversions = diversions.filter((d) => d.rank === 2);
    expect(rank2Diversions.length).toBe(1);
  });
});
