/**
 * B2 — Post-acceleration waterfall.
 *
 * Verifies the engine flips from the normal bi-waterfall to the single
 * Priority-of-Payments-upon-Acceleration model when an Event of Default
 * (EoD) breaches. Under acceleration (PPM Condition 10):
 *   - Senior expenses uncapped (no Senior Expenses Cap overflow mechanic).
 *   - Rated tranches get P+I sequentially: Class A absorbs cash until retired,
 *     then Class B pari passu pro-rata, then C → D → E → F each sequential.
 *   - Sub mgmt, incentive, residual flow only if cash remains after rated notes.
 *   - Irreversible: once accelerated, stays accelerated.
 *   - Deferred interest does NOT PIK; unpaid interest is a shortfall (not
 *     capitalized onto the tranche balance).
 *
 * These tests use a synthetic stress scenario because Euro XV's Q1 2026 EoD
 * cushion is massive (158.52% vs 102.5% trigger) — no real-data scenario
 * exercises acceleration.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runProjection,
  runPostAccelerationWaterfall,
  type DefaultDrawFn,
} from "@/lib/clo/projection";
import { buildFromResolved, defaultsFromResolved } from "@/lib/clo/build-projection-inputs";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof defaultsFromResolved>[1];
};

/** Build a stressed fixture: all loans re-priced to `mvCents`, so defaulted
 *  positions contribute only `mvCents/100 × par` to the EoD numerator. */
function stressedResolved(mvCents: number): ResolvedDealData {
  return {
    ...fixture.resolved,
    loans: fixture.resolved.loans.map((l) => ({ ...l, currentPrice: mvCents })),
  };
}

/** Force a constant per-period default fraction regardless of rating bucket.
 *  Returns a `DefaultDrawFn` that ignores the rating-based hazard and just
 *  defaults `frac` of each loan's surviving par. */
function forceDefaultFraction(frac: number): DefaultDrawFn {
  return (survivingPar: number, _hazardRate: number): number => survivingPar * frac;
}

describe("B2 — runPostAccelerationWaterfall (pure helper)", () => {
  const baseTranches = [
    { className: "Class A", currentBalance: 100_000_000, spreadBps: 100, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, isAmortising: false, amortisationPerPeriod: null, amortStartDate: null },
    { className: "Class B-1", currentBalance: 20_000_000, spreadBps: 200, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: false, isAmortising: false, amortisationPerPeriod: null, amortStartDate: null },
    { className: "Class B-2", currentBalance: 10_000_000, spreadBps: 250, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: false, isAmortising: false, amortisationPerPeriod: null, amortStartDate: null },
    { className: "Class C", currentBalance: 15_000_000, spreadBps: 400, seniorityRank: 4, isFloating: true, isIncomeNote: false, isDeferrable: true, isAmortising: false, amortisationPerPeriod: null, amortStartDate: null },
    { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 8, isFloating: false, isIncomeNote: true, isDeferrable: false, isAmortising: false, amortisationPerPeriod: null, amortStartDate: null },
  ];
  const trancheBalances = {
    "Class A": 100_000_000, "Class B-1": 20_000_000, "Class B-2": 10_000_000, "Class C": 15_000_000, "Sub": 20_000_000,
  };
  const deferredBalances = {
    "Class A": 0, "Class B-1": 0, "Class B-2": 0, "Class C": 0, "Sub": 0,
  };
  const interestDue = {
    "Class A": 1_000_000, "Class B-1": 200_000, "Class B-2": 100_000, "Class C": 150_000, "Sub": 0,
  };
  const seniorExpenses = {
    taxes: 10_000, trusteeFees: 50_000, adminExpenses: 0, seniorMgmtFee: 150_000, hedgePayments: 0,
  };

  it("Class A absorbs cash first until retired; Class B sees nothing until A is paid", () => {
    // Total cash = 3M (covers A interest + partial A principal) — not enough
    // to pay Class A principal in full (100M), so Class B should receive zero.
    const result = runPostAccelerationWaterfall({
      totalCash: 3_000_000,
      tranches: baseTranches,
      trancheBalances: { ...trancheBalances },
      deferredBalances,
      seniorExpenses,
      interestDueByTranche: interestDue,
      subMgmtFee: 0,
      incentiveFeeActive: false,
      incentiveFeePct: 0,
    });
    const a = result.trancheDistributions.find((d) => d.className === "Class A")!;
    // A gets its interest + partial principal (total cash 3M − 210K senior expenses = 2.79M;
    // A interest = 1M, A principal absorbs remainder = 1.79M).
    expect(a.interestPaid).toBeCloseTo(1_000_000, -2);
    expect(a.principalPaid).toBeGreaterThan(0);
    expect(a.principalPaid).toBeLessThan(100_000_000); // not yet retired
    // Subordinate tranches not reached — executor breaks once remaining = 0
    // so they have no trancheDistributions entry.
    expect(result.trancheDistributions.find((d) => d.className === "Class B-1")).toBeUndefined();
    expect(result.trancheDistributions.find((d) => d.className === "Class B-2")).toBeUndefined();
    expect(result.trancheDistributions.find((d) => d.className === "Class C")).toBeUndefined();
    // Sub receives zero.
    expect(result.residualToSub).toBe(0);
  });

  it("Class B pari passu: B-1 and B-2 absorb pro-rata by balance", () => {
    // Total cash big enough to retire A and partially cover B. B pari passu
    // should split interest + principal pro-rata by balance (B-1 20M, B-2
    // 10M → 2:1 ratio).
    const result = runPostAccelerationWaterfall({
      totalCash: 120_000_000, // covers senior expenses + A P+I (101M) + ~18.79M for B
      tranches: baseTranches,
      trancheBalances: { ...trancheBalances },
      deferredBalances,
      seniorExpenses,
      interestDueByTranche: interestDue,
      subMgmtFee: 0,
      incentiveFeeActive: false,
      incentiveFeePct: 0,
    });
    const a = result.trancheDistributions.find((d) => d.className === "Class A")!;
    const b1 = result.trancheDistributions.find((d) => d.className === "Class B-1")!;
    const b2 = result.trancheDistributions.find((d) => d.className === "Class B-2")!;
    // A fully retired.
    expect(a.endBalance).toBe(0);
    // B-1 and B-2 both received interest pro-rata (B-1 should be 2x B-2).
    expect(b1.interestPaid).toBeGreaterThan(0);
    expect(b2.interestPaid).toBeGreaterThan(0);
    expect(b1.interestPaid / b2.interestPaid).toBeCloseTo(2, 1);
    // B-1 principal should also be ~2x B-2 principal.
    expect(b1.principalPaid / b2.principalPaid).toBeCloseTo(2, 1);
  });

  it("Residual to Sub Noteholders only after rated notes retired", () => {
    // Total cash = 300M (massively over-covers rated capital structure).
    const result = runPostAccelerationWaterfall({
      totalCash: 300_000_000,
      tranches: baseTranches,
      trancheBalances: { ...trancheBalances },
      deferredBalances,
      seniorExpenses,
      interestDueByTranche: interestDue,
      subMgmtFee: 500_000,
      incentiveFeeActive: false,
      incentiveFeePct: 0,
    });
    // All rated retired.
    for (const d of result.trancheDistributions) {
      expect(d.endBalance).toBe(0);
    }
    // Sub mgmt paid.
    expect(result.subMgmtFeePaid).toBe(500_000);
    // Residual to sub > 0.
    expect(result.residualToSub).toBeGreaterThan(0);
    // Residual ≈ 300M − 210K expenses − (A+B+C capital + interest) − sub mgmt.
    // Capital structure total = 145M; interest total = 1.45M; expenses 210K + 500K = 710K.
    // Residual ≈ 300 − 145 − 1.45 − 0.71 ≈ 152.84M.
    expect(result.residualToSub).toBeCloseTo(152_840_000, -5);
  });

  it("Unpaid tranche interest becomes shortfall (not PIKed)", () => {
    // Not enough cash to cover Class A interest fully.
    const result = runPostAccelerationWaterfall({
      totalCash: 500_000, // after 210K senior expenses, 290K left vs 1M A interest
      tranches: baseTranches,
      trancheBalances: { ...trancheBalances },
      deferredBalances,
      seniorExpenses,
      interestDueByTranche: interestDue,
      subMgmtFee: 0,
      incentiveFeeActive: false,
      incentiveFeePct: 0,
    });
    const a = result.trancheDistributions.find((d) => d.className === "Class A")!;
    // A interest paid < due → shortfall recorded.
    expect(a.interestPaid).toBeLessThan(a.interestDue);
    expect(result.interestShortfall["Class A"]).toBeGreaterThan(0);
    expect(result.interestShortfall["Class A"]).toBeCloseTo(a.interestDue - a.interestPaid, 2);
    // Deferred balance unchanged (no PIK under acceleration).
    expect(deferredBalances["Class A"]).toBe(0);
  });
});

describe("B2 — integration: runProjection flips to accelerated mode on EoD breach", () => {
  it("flip timing: isAccelerated is a contiguous suffix — never flickers, never reverts", () => {
    // Stronger than "eventually true": asserts the acceleration flag forms a
    // contiguous boolean mask — false for all periods up to some index N,
    // true from N onwards. A flicker (true → false → true) or a revert
    // (true → false) would trip the check. Protects against future
    // engine changes that might accidentally un-set the flag.
    const inputs = buildFromResolved(stressedResolved(10), {
      ...defaultsFromResolved(stressedResolved(10), fixture.raw),
      recoveryPct: 0,
      recoveryLagMonths: 120,
      cprPct: 0,
    });
    const result = runProjection(inputs, forceDefaultFraction(0.2));
    const firstAccelIdx = result.periods.findIndex((p) => p.isAccelerated);
    // Load-bearing: if `findIndex` returns -1 (no period accelerates), the
    // loops below would iterate starting at i=-1, which reads the undefined
    // `result.periods[-1]` and produces a misleading assertion failure. This
    // `toBeGreaterThan(0)` sentinel check guarantees firstAccelIdx is a
    // valid index. DO NOT weaken to `toBeGreaterThanOrEqual(0)` without
    // also bounding the loop below — the two are coupled.
    expect(firstAccelIdx).toBeGreaterThan(0);

    // Every period BEFORE firstAccelIdx must be non-accelerated.
    for (let i = 0; i < firstAccelIdx; i++) {
      expect(result.periods[i].isAccelerated).toBe(false);
    }
    // Every period AT OR AFTER firstAccelIdx must be accelerated (irreversibility).
    for (let i = firstAccelIdx; i < result.periods.length; i++) {
      expect(result.periods[i].isAccelerated).toBe(true);
    }
  });

  it("flip timing: breach-detecting period runs normal-mode; next period runs accelerated", () => {
    // Specific timing claim the code makes — "Flip happens AT the end of
    // the breaching period, so the NEXT period runs under acceleration."
    // A regression that moves the flip one period earlier (so the breach
    // period is already accelerated and never runs the normal waterfall)
    // would silently pass a weaker "eventually accelerates" test.
    const inputs = buildFromResolved(stressedResolved(10), {
      ...defaultsFromResolved(stressedResolved(10), fixture.raw),
      recoveryPct: 0,
      recoveryLagMonths: 120,
      cprPct: 0,
    });
    const result = runProjection(inputs, forceDefaultFraction(0.2));

    // Find the FIRST period where eodTest.passing === false. Under the
    // code's stated timing, this period must still be `isAccelerated: false`
    // (normal-mode detects the breach), AND the next period must be
    // `isAccelerated: true`.
    const breachIdx = result.periods.findIndex(
      (p) => p.eodTest != null && !p.eodTest.passing,
    );
    expect(breachIdx).toBeGreaterThanOrEqual(0); // stress scenario must breach somewhere
    expect(result.periods[breachIdx].isAccelerated).toBe(false); // breach period normal-mode

    // Edge case: if the breach period was the LAST emitted period (because
    // normal-mode's early-break retired all tranches + depleted pool in the
    // same period), there's no next period to observe. The flag was still
    // set at end of `breachIdx` — just not observable. Guard prevents a
    // false failure on scenarios that wind down on breach.
    if (breachIdx < result.periods.length - 1) {
      expect(result.periods[breachIdx + 1].isAccelerated).toBe(true);
    } else {
      // Deal wound down on breach — no acceleration period emitted. Sanity:
      // remaining debt + pool par should be ~0 on the breach period to
      // justify the early-break.
      const last = result.periods[breachIdx];
      expect(last.endingLiabilities + last.endingPar).toBeLessThan(1);
    }
  });

  it("under acceleration: Class A absorbs before subs; sub distribution collapses", () => {
    // Compare accel vs no-accel runs on the same stressed fixture. Accel
    // should have MUCH lower totalEquityDistributions because sub notes are
    // last in line.
    const stressed = stressedResolved(10);
    const assumptions = {
      ...defaultsFromResolved(stressed, fixture.raw),
      recoveryPct: 0,
      recoveryLagMonths: 120,
      cprPct: 0,
    };
    const inputs = buildFromResolved(stressed, assumptions);

    // Run with forced defaults (triggers accel).
    const withAccel = runProjection(inputs, forceDefaultFraction(0.2));

    // Run without defaults (never accel).
    const noDefaultsFn: DefaultDrawFn = () => 0;
    const noAccel = runProjection(inputs, noDefaultsFn);

    // Sanity: stressed+defaults path DID accelerate, reference path did NOT.
    expect(withAccel.periods.some((p) => p.isAccelerated)).toBe(true);
    expect(noAccel.periods.every((p) => !p.isAccelerated)).toBe(true);

    // Equity under acceleration must be materially lower (rated notes absorb
    // everything before subs see a cent). Accept anything <20% of the
    // no-accel equity distribution.
    expect(withAccel.totalEquityDistributions).toBeLessThan(
      noAccel.totalEquityDistributions * 0.2,
    );
  });

  it("under acceleration: admin fee is paid (not silently dropped) — C3 integration guard", () => {
    // Regression guard for a subtle bug: C3 split trusteeFeeBps into
    // trustee + admin. B2's accel branch must pass BOTH to the executor
    // (before fix, adminExpenses was hardcoded 0 under acceleration,
    // silently dropping ~€63K/period of admin fee into sub residual).
    // Also: PPM 10(b) removes the Senior Expenses Cap under acceleration —
    // fees pay uncapped at step (B)/(C). This test pins both behaviors.
    const stressed = stressedResolved(10);
    const inputs = buildFromResolved(stressed, {
      ...defaultsFromResolved(stressed, fixture.raw),
      recoveryPct: 0,
      recoveryLagMonths: 120,
      cprPct: 0,
      // Non-trivial admin + trustee fees, with a cap that would bite in
      // normal mode. Under acceleration the cap is ignored.
      trusteeFeeBps: 3,
      adminFeeBps: 10,
      seniorExpensesCapBps: 5, // cap would bite if applied, but accel removes it
    });
    const result = runProjection(inputs, forceDefaultFraction(0.2));
    const firstAccelIdx = result.periods.findIndex((p) => p.isAccelerated);
    expect(firstAccelIdx).toBeGreaterThan(0);
    const accelPeriod = result.periods[firstAccelIdx];

    // TIGHT REGRESSION GUARD: post-C3 split, stepTrace.adminFeesPaid maps to
    // PPM step (C) only. The prior version asserted on the bundled
    // trusteeFeesPaid, which was regression-theater — a future revert of
    // adminExpenses: 0 with trustee bumped to absorb the sum would still
    // pass. Direct assertion on adminFeesPaid catches exactly that bug.
    expect(accelPeriod.stepTrace.adminFeesPaid).toBeGreaterThan(0);
    expect(accelPeriod.stepTrace.trusteeFeesPaid).toBeGreaterThan(0);

    // Math guard invariant to beginningPar and dayFrac: under acceleration
    // (cap removed per PPM 10(b)) trustee step (B) and admin step (C) pay
    // uncapped at their respective bps rates, so their ratio equals
    // adminFeeBps / trusteeFeeBps = 10/3. Catches "admin dropped to 0",
    // "admin halved", and "cap reintroduced under acceleration".
    const ratio = accelPeriod.stepTrace.adminFeesPaid / accelPeriod.stepTrace.trusteeFeesPaid;
    expect(ratio).toBeCloseTo(10 / 3, 3);

    // Overflow fields are always zero under acceleration (no Y/Z steps).
    expect(accelPeriod.stepTrace.trusteeOverflowPaid).toBe(0);
    expect(accelPeriod.stepTrace.adminOverflowPaid).toBe(0);
  });

  it("Euro XV base case: never accelerates (158.52% cushion vs 102.5% trigger)", () => {
    // Regression guard: default Euro XV fixture with default assumptions must
    // never flip to acceleration. The cushion is ~56pp; any scenario that
    // accidentally flips under normal operation is a bug.
    const inputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const result = runProjection(inputs);
    expect(result.periods.every((p) => !p.isAccelerated)).toBe(true);
  });
});
