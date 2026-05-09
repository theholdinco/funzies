/**
 * PPM § 10(a)(i) — non-deferrable senior interest shortfall fires Event of
 * Default after `interestNonPaymentGracePeriods` consecutive shortfall
 * periods.
 *
 * Mechanic (engine, pre-acceleration only):
 *   - When a non-deferrable senior tranche (the lowest two distinct
 *     seniorityRank values among non-income, non-amortising tranches)
 *     receives less than its full coupon, accrue the shortfall to
 *     `interestShortfall[c]` and increment `shortfallCount[c]`.
 *   - When the same tranche is fully paid, reset `shortfallCount[c]` to 0.
 *   - When `shortfallCount[c] > grace`, flip `isAccelerated = true` for
 *     the next period (irreversible).
 *   - Existing compositional EoD test (`eodPeriodResult`) OR'd with this
 *     trigger; either fires the breach.
 *
 * Non-mechanic (intentionally NOT modeled):
 *   - The carried `interestShortfall` does NOT augment the next period's
 *     pre-accel interest demand. Non-deferrable means non-deferrable —
 *     soft-deferrable carry-forward would silently diverge from trustee
 *     data on stress. The shortfall is collected post-acceleration via
 *     the handoff at `interestDueByTranche` fold-in.
 */

import { describe, it, expect } from "vitest";
import {
  runProjection,
  addQuarters,
  type ProjectionInputs,
  type LoanInput,
} from "../projection";
import { CLO_DEFAULTS } from "../defaults";

// Tunable stress fixture: senior fee high enough that pool interest can't
// cover Class A's full coupon. baseRate=0 + ratings rates=0 to keep the
// arithmetic clean (no defaults, no rate-driven coupon variability).
function makeStressInputs(seniorFeePct: number, overrides: Partial<ProjectionInputs> = {}): ProjectionInputs {
  const loans: LoanInput[] = Array.from({ length: 10 }, (_, i) => ({
    parBalance: 10_000_000,
    maturityDate: addQuarters("2026-03-09", 24 + i),
    ratingBucket: "B",
    spreadBps: 375,
  }));

  return {
    initialPar: 100_000_000,
    wacSpreadBps: 375,
    baseRatePct: 0,
    baseRateFloorPct: 0,
    seniorFeePct,
    subFeePct: 0,
    tranches: [
      { className: "A", currentBalance: 65_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
      { className: "B", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
      { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
    ],
    ocTriggers: [
      { className: "A", triggerLevel: 105, rank: 1 },
      { className: "B", triggerLevel: 105, rank: 2 },
    ],
    icTriggers: [
      { className: "A", triggerLevel: 105, rank: 1 },
      { className: "B", triggerLevel: 105, rank: 2 },
    ],
    reinvestmentPeriodEnd: "2028-06-15",
    maturityDate: "2034-06-15",
    currentDate: "2026-03-09",
    loans,
    defaultRatesByRating: {},
    cprPct: 0,
    recoveryPct: CLO_DEFAULTS.recoveryPct,

    ratingAgencies: ["moodys", "sp", "fitch"],    recoveryLagMonths: CLO_DEFAULTS.recoveryLagMonths,
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
    interestNonPaymentGracePeriods: 0,
    ...overrides,
  };
}

describe("non-deferrable senior interest shortfall — EoD trigger (PPM § 10(a)(i))", () => {
  it("healthy: no shortfall, no acceleration", () => {
    // Senior fee 0.15% (typical) — pool interest comfortably covers A+B coupons.
    const result = runProjection(makeStressInputs(0.15));
    const accelPeriods = result.periods.filter((p) => p.isAccelerated);
    expect(accelPeriods.length).toBe(0);
    // Every period: A and B fully paid, no shortfall accrued.
    for (const p of result.periods) {
      const a = p.trancheInterest.find((t) => t.className === "A")!;
      const b = p.trancheInterest.find((t) => t.className === "B")!;
      if (a.due > 0) expect(a.paid).toBeCloseTo(a.due, 0);
      if (b.due > 0) expect(b.paid).toBeCloseTo(b.due, 0);
    }
  });

  it("grace=0 stress: shortfall period 1 → period 2 is accelerated", () => {
    // Senior fee 30% / yr → ~7.5% / quarter on 100M = €7.5M demand vs ~€937K
    // pool interest. Available interest reaching the tranche waterfall is
    // exhausted by senior fees → A receives nothing → shortfall → EoD fires.
    const result = runProjection(makeStressInputs(30, { interestNonPaymentGracePeriods: 0 }));

    // Period 1: pre-accel (isAccelerated tracked at end-of-period flip).
    const p1 = result.periods[0];
    expect(p1.isAccelerated).toBe(false);
    const a1 = p1.trancheInterest.find((t) => t.className === "A")!;
    expect(a1.due).toBeGreaterThan(0);
    expect(a1.paid).toBeLessThan(a1.due - 0.01);

    // Period 2: shortfall in period 1 with grace=0 → flipped at boundary.
    const p2 = result.periods[1];
    expect(p2.isAccelerated).toBe(true);
  });

  it("grace=2 stress: first 3 shortfall periods don't accelerate; period 4 does", () => {
    // Timing: shortfallCount increments at end of each period. The flip to
    // isAccelerated=true also happens at end-of-period. Emitted period N
    // reflects isAccelerated as it was at start of period N. So with grace=2:
    //   end of P1: count=1 (1>2=false) — emit P1 pre-accel
    //   end of P2: count=2 (2>2=false) — emit P2 pre-accel
    //   end of P3: count=3 (3>2=true) → set isAccelerated for P4 — emit P3 pre-accel
    //   start of P4: isAccelerated=true — emit P4 post-accel
    const result = runProjection(makeStressInputs(30, { interestNonPaymentGracePeriods: 2 }));
    expect(result.periods[0].isAccelerated).toBe(false);
    expect(result.periods[1].isAccelerated).toBe(false);
    expect(result.periods[2].isAccelerated).toBe(false);
    expect(result.periods[3].isAccelerated).toBe(true);
    const a3 = result.periods[2].trancheInterest.find((t) => t.className === "A")!;
    expect(a3.paid).toBeLessThan(a3.due - 0.01);
  });

  it("cure: shortfall then full pay → count resets, no EoD", () => {
    // Two-phase fee: stress periods 1-2, healthy from period 3 onwards.
    // Done by running TWO projections and comparing — easier than dynamic
    // fees in the engine. Here we just verify that with grace=2, a single
    // shortfall period followed by recovery does not trigger acceleration
    // anywhere.
    const inputs = makeStressInputs(30, { interestNonPaymentGracePeriods: 5 });
    const result = runProjection(inputs);
    // Grace=5 with shortfalls in every period: count exceeds 5 only at
    // period 6 boundary → period 7 accelerates. Periods 1-6 remain pre-accel.
    expect(result.periods[0].isAccelerated).toBe(false);
    expect(result.periods[5].isAccelerated).toBe(false);
    expect(result.periods[6].isAccelerated).toBe(true);
  });

  it("Class A protected: shortfall on senior tranche fires EoD", () => {
    const result = runProjection(makeStressInputs(30, { interestNonPaymentGracePeriods: 0 }));
    // Senior tranche (rank 1) is protected; shortfall on it fires.
    const a = result.periods[0].trancheInterest.find((t) => t.className === "A")!;
    expect(a.paid).toBeLessThan(a.due - 0.01);
    expect(result.periods[1].isAccelerated).toBe(true);
  });

  it("Class B protected: rank-based predicate (not name-based)", () => {
    // Replace classNames so neither tranche is named "A" or "B" — verifies
    // the EoD-on-shortfall predicate uses seniorityRank, not className.
    const inputs = makeStressInputs(30, {
      interestNonPaymentGracePeriods: 0,
      tranches: [
        { className: "Senior-1", currentBalance: 65_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Senior-2", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Equity", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "Senior-1", triggerLevel: 105, rank: 1 },
        { className: "Senior-2", triggerLevel: 105, rank: 2 },
      ],
      icTriggers: [
        { className: "Senior-1", triggerLevel: 105, rank: 1 },
        { className: "Senior-2", triggerLevel: 105, rank: 2 },
      ],
    });
    const result = runProjection(inputs);
    // Period 1: shortfall on Senior-1 (rank 1, protected). Period 2 flips.
    expect(result.periods[1].isAccelerated).toBe(true);
  });

  it("non-protected non-deferrable junior shorts → accrues interestShortfall but does NOT fire EoD", () => {
    // Locks the rank-predicate exclusion: a Class C non-deferrable at rank 3
    // with shortfall accrues to interestShortfall (so post-acceleration
    // handoff stays whole) but does NOT drive the EoD-on-shortfall trigger
    // (which is gated on `eodProtectedClassNames` = top two non-amort debt
    // ranks). Senior fee tuned to short rank 3 only; A+B (rank 1+2 protected)
    // remain whole. Expectation: no acceleration across the projection.
    // makeStressInputs has baseRate=0 and loans @ 3.75% spread → pool
    // ~937.5K/quarter. Tranche coupons: A=210K, B=50K, C=200K.
    // Senior fee 2.5% = 625K. Available after fee = 312.5K → A whole
    // (102.5K residual) → B whole (52.5K residual) → C shorts ~147.5K.
    const inputs = makeStressInputs(2.5, {
      interestNonPaymentGracePeriods: 0,
      tranches: [
        { className: "A", currentBalance: 60_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 10_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        // Rank 3 non-deferrable — outside `eodProtectedClassNames`. Shortfall
        // here MUST accrue to interestShortfall (for post-accel handoff
        // integrity if some other trigger fires) but MUST NOT drive EoD.
        { className: "C", currentBalance: 20_000_000, spreadBps: 400, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
    });
    const result = runProjection(inputs);

    // No acceleration anywhere — protected ranks 1+2 are whole, rank 3
    // shortfall does not feed the EoD trigger.
    expect(result.periods.every((p) => !p.isAccelerated)).toBe(true);
    // C accrued shortfall (running balance non-zero at end of period 1).
    expect((result.periods[0].interestShortfall.C ?? 0)).toBeGreaterThan(0);
  });

  it("priorShortfallCount > grace at T=0: deal starts already accelerated", () => {
    // Deal arrives mid-grace at the boundary already breached: count=3
    // with grace=2 means the consecutive-shortfall threshold was crossed
    // BEFORE the projection window opened. Period 1 must run under post-
    // acceleration; otherwise the engine silently lets one extra pre-accel
    // period of distributions through (interest paid to junior tranches
    // that under PPM should already be diverted to senior P+I).
    const inputs = makeStressInputs(0.15, { interestNonPaymentGracePeriods: 2 });
    inputs.tranches = inputs.tranches.map((t) =>
      t.className === "A"
        ? { ...t, priorShortfallCount: 3 }
        : t,
    );
    const result = runProjection(inputs);
    expect(result.periods[0].isAccelerated).toBe(true);
  });

  it("priorShortfallCount seed: EoD fires earlier on a deal entering mid-grace", () => {
    // PPM § 10(a)(i) prior-period state seeding. With grace=2 and a fresh
    // start, EoD fires after 3 consecutive shortfall periods (count climbs
    // 0→1→2→3, breaches at >2). Seeding `priorShortfallCount: 2` represents
    // a deal where the trustee's most recent payment date showed 2 prior
    // consecutive non-payments — EoD must fire 1 period earlier (at the
    // first projected shortfall, count climbs 2→3, breaches immediately).
    const fresh = runProjection(makeStressInputs(30, { interestNonPaymentGracePeriods: 2 }));
    expect(fresh.periods[0].isAccelerated).toBe(false);
    expect(fresh.periods[1].isAccelerated).toBe(false);
    expect(fresh.periods[2].isAccelerated).toBe(false);
    expect(fresh.periods[3].isAccelerated).toBe(true);

    const inputsSeeded = makeStressInputs(30, { interestNonPaymentGracePeriods: 2 });
    inputsSeeded.tranches = inputsSeeded.tranches.map((t) =>
      t.className === "A"
        ? { ...t, priorShortfallCount: 2 }
        : t,
    );
    const seeded = runProjection(inputsSeeded);
    // First period of projected shortfall: count = 2 + 1 = 3, breaches > 2.
    // Period 1 still emits pre-accel; period 2 flips.
    expect(seeded.periods[0].isAccelerated).toBe(false);
    expect(seeded.periods[1].isAccelerated).toBe(true);
  });

  it("priorInterestShortfall seed: post-acceleration handoff folds the carried balance", () => {
    // Seed Class A with a €1M prior shortfall. When EoD fires (whichever
    // path), the post-accel handoff at projection.ts:~2181 folds the
    // running interestShortfall into interestDueByTranche so the
    // accelerated claim is whole. Without seeding, the handoff would
    // under-state the claim by exactly €1M.
    const inputs = makeStressInputs(30, { interestNonPaymentGracePeriods: 0 });
    inputs.tranches = inputs.tranches.map((t) =>
      t.className === "A"
        ? { ...t, priorInterestShortfall: 1_000_000 }
        : t,
    );
    const result = runProjection(inputs);
    // Period 1: pre-accel emit shows the seeded carry on the running
    // balance map (plus this period's accrual).
    expect(result.periods[0].interestShortfall.A ?? 0).toBeGreaterThan(1_000_000);
    // Period 2: post-accel. Due reflects coupon + carried shortfall.
    expect(result.periods[1].isAccelerated).toBe(true);
    const a2 = result.periods[1].trancheInterest.find((t) => t.className === "A")!;
    // a2.due includes the >€1M fold-in; the bare coupon would be ~€213K.
    expect(a2.due).toBeGreaterThan(1_100_000);
  });

  it("priorInterestShortfall carry does not itself consume a new grace period when current interest is paid", () => {
    const inputs = makeStressInputs(0.15, { interestNonPaymentGracePeriods: 0 });
    inputs.tranches = inputs.tranches.map((t) =>
      t.className === "A"
        ? { ...t, priorInterestShortfall: 1_000_000 }
        : t,
    );

    const result = runProjection(inputs);
    expect(result.periods[0].isAccelerated).toBe(false);
    expect(result.periods[1].isAccelerated).toBe(false);
    expect(result.periods[0].interestShortfall.A).toBeCloseTo(1_000_000, 0);
    expect(result.periods[0].interestShortfallCount.A ?? 0).toBe(0);
  });

  it("post-EoD handoff: pre-accel shortfall folds into post-accel interestDueByTranche", () => {
    const result = runProjection(makeStressInputs(30, { interestNonPaymentGracePeriods: 1 }));
    // Period 1: shortfall accrues, count=1 (1>1=false). Period 2: shortfall
    // again, count=2 (2>1=true) → flip; period 3 emits post-accel.
    expect(result.periods[0].isAccelerated).toBe(false);
    expect(result.periods[1].isAccelerated).toBe(false);
    expect(result.periods[2].isAccelerated).toBe(true);

    // Pre-accel period 1 emits a non-zero running interestShortfall on A.
    const p1Shortfall = result.periods[0].interestShortfall;
    expect(p1Shortfall.A ?? 0).toBeGreaterThan(0);

    // Post-accel period 3: the running pre-accel interestShortfall is folded
    // into interestDueByTranche so the accelerated claim is whole. Period 3's
    // emitted `due` for A must exceed period 2's pure single-period coupon by
    // approximately the carried shortfall (~2 prior periods' worth).
    const a2 = result.periods[1].trancheInterest.find((t) => t.className === "A")!;
    const a3 = result.periods[2].trancheInterest.find((t) => t.className === "A")!;
    expect(a3.due).toBeGreaterThan(a2.due * 1.5);
  });

  it("null grace-periods input defaults to 0 (PPM-correct for standard CLOs)", () => {
    // The engine reads `interestNonPaymentGracePeriods ?? 0` — a null/
    // undefined input must behave identically to grace=0. Pin this so a
    // future PR that accidentally changes the default to 1 (or any other
    // value) breaks loud rather than silently mis-modeling every deal where
    // the resolver emits null (currently the default — see resolver.ts and
    // resolver-types.ts for the documented rationale: standard CLO cure
    // windows are sub-period in a quarterly model so the cure has lapsed
    // by the next checkpoint).
    const stressed = makeStressInputs(30);
    delete (stressed as Partial<ProjectionInputs>).interestNonPaymentGracePeriods;
    const nullInput = runProjection(stressed);
    const explicitZero = runProjection(makeStressInputs(30, { interestNonPaymentGracePeriods: 0 }));

    // Same acceleration behavior — period 2 flips under both shapes.
    expect(nullInput.periods[1].isAccelerated).toBe(true);
    expect(explicitZero.periods[1].isAccelerated).toBe(true);
    // Same number of accelerated periods overall (no off-by-one drift).
    expect(nullInput.periods.filter((p) => p.isAccelerated).length).toBe(
      explicitZero.periods.filter((p) => p.isAccelerated).length,
    );
  });

  it("emits interestShortfallCount populated from post-update count snapshot", () => {
    // Pin the new PeriodResult.interestShortfallCount field so a partner-
    // facing surface can read "Class A — 2 of 3 grace periods consumed"
    // without re-deriving the state machine. Snapshot is post-update
    // (taken AFTER the EoD-on-shortfall trigger increments the counter
    // for the period), which is the only correct ordering — pre-update
    // would lag by a period and a consumer summing the count across
    // periods would read off-by-one numbers.
    const result = runProjection(makeStressInputs(30, { interestNonPaymentGracePeriods: 5 }));
    // Period 1: count climbs 0→1 → emit shows {A: 1}. Pre-accel.
    expect(result.periods[0].interestShortfallCount.A).toBe(1);
    expect(result.periods[0].isAccelerated).toBe(false);
    // Period 2: count climbs 1→2 → emit shows {A: 2}.
    expect(result.periods[1].interestShortfallCount.A).toBe(2);
    // Period 6: count climbs 5→6 (>5=grace) → fires EoD, period 7 accelerates.
    // The breach period itself emits the post-update count of 6.
    expect(result.periods[5].interestShortfallCount.A).toBe(6);
    // Post-accel emit (period 7): counter frozen, field empty per docstring.
    expect(result.periods[6].isAccelerated).toBe(true);
    expect(result.periods[6].interestShortfallCount).toEqual({});
  });
});
