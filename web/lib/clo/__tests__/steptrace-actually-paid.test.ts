/**
 * `stepTrace` emits actually-paid amounts (not requested) under stress.
 *
 * Invariant pinned: every fee/expense field on `PeriodStepTrace` is sourced
 * from the truncated paid value (helper return like
 * `applySeniorExpensesToAvailable.paid`, or a captured
 * `Math.min(requested, available)` local), never from the pre-truncation
 * requested object. When this is violated, `Σ stepTrace.*(interest waterfall
 * buckets)` exceeds `interestCollected` and any partner-visible aggregator
 * overstates fees / understates the equity residual — same failure shape as
 * the April 2026 UI back-derivation incident, displaced one layer deeper.
 *
 * Sibling note: the IC numerator at projection.ts:~1751 reads from the
 * requested `seniorExpenseBreakdown` on purpose — see the consumer-
 * asymmetry comment at that site (IC test is forward-looking; numerator
 * needs dimensional symmetry with contractual denominator). This test pins
 * the trace consumer only.
 */

import { describe, it, expect } from "vitest";
import { runProjection, type PeriodResult } from "../projection";
import { makeInputs } from "./test-helpers";

/**
 * The canonical correctness invariant from CLAUDE.md principle 4:
 * `Σ stepTrace.*(interest waterfall buckets) ≤ interestCollected +
 * expenseReserveDraw` per period.
 *
 * Every interest-side consumer of `availableInterest` is included: senior
 * expenses (A.i, A.ii, B, C, E, F), tranche interest (G onward), Class X
 * (or other amortising-tranche) scheduled amort paid from the interest pool
 * pari-passu with Class A interest (G), OC cure diversions (I/L/O/R/U),
 * reinvestment OC diversion (W), sub mgmt fee (X), trustee/admin overflow
 * (Y, Z), incentive fee from interest (CC), and the equity-from-interest
 * residual (DD). Excludes principal-side flows (equityFromPrincipal,
 * incentiveFeeFromPrincipal) which consume from a different pool, and
 * `availableForTranches` which is an intermediate marker, not a consumer.
 *
 * The bound is `interestCollected + expenseReserveDraw` rather than
 * `interestCollected` alone because PPM Condition 3(j)(x)(4) physically
 * transfers Expense Reserve cash to the Interest Account on the second
 * BD prior to each Payment Date — so under stress the Σ may legitimately
 * exceed `interestCollected` by the reserve transfer amount, with that
 * transfer captured in `stepTrace.expenseReserveDraw`. Pre-fix shape:
 * senior-expense + sub-fee fields emitted REQUESTED amounts; under stress
 * these exceeded actually-deducted, so Σ broke this inequality. Post-fix:
 * every consumer reads from a truncated paid value.
 */
function sumInterestSideConsumers(p: PeriodResult): number {
  const t = p.stepTrace;
  const ocCureSum = t.ocCureDiversions.reduce((s, d) => s + d.amount, 0);
  const trancheInterestPaidSum = p.trancheInterest.reduce((s, ti) => s + ti.paid, 0);
  return (
    t.taxes +
    t.issuerProfit +
    t.trusteeFeesPaid +
    t.adminFeesPaid +
    t.expenseReserveDeposit +
    t.seniorMgmtFeePaid +
    t.hedgePaymentPaid +
    trancheInterestPaidSum +
    t.classXAmortFromInterest +
    ocCureSum +
    t.reinvOcDiversion +
    t.subMgmtFeePaid +
    t.trusteeOverflowPaid +
    t.adminOverflowPaid +
    t.supplementalReserveDeposit +
    t.incentiveFeeFromInterest +
    t.equityFromInterest
  );
}

describe("stepTrace emits actually-paid amounts under stress", () => {
  it("sub-mgmt-fee stress: subMgmtFeePaid trace ≤ interestCollected per period", () => {
    // Spike subFeePct so the requested sub fee is large enough to potentially
    // exceed `availableInterest` at step X. Requested sub fee per quarter on
    // 100M par = 100M × 5% × 0.25 = ~1.25M. Pool interest collected is
    // ~1.46M/quarter at default spread; tranche interest consumes most of it,
    // leaving residual << 1.25M for the sub fee step. Under the bug, trace
    // emitted the full 1.25M; post-fix it emits the truncated paid amount.
    const inputs = makeInputs({ subFeePct: 5 });
    const result = runProjection(inputs);

    // Σ-tie invariant (canonical from CLAUDE.md §4): the sum of every
    // interest-side stepTrace consumer must not exceed interestCollected.
    // Pre-fix this would have failed in stressed periods because
    // subMgmtFeePaid emitted requested (1.25M) when only the small residual
    // after tranche interest was actually paid; the difference inflated
    // the sum past interestCollected. Post-fix, each consumer reads from
    // the truncated paid value, so the sum ties to the cent.
    for (let i = 0; i < result.periods.length; i++) {
      const p = result.periods[i];
      const sumPaid = sumInterestSideConsumers(p);
      const bound = p.interestCollected + p.stepTrace.expenseReserveDraw + 0.01;
      expect(
        sumPaid,
        `period ${i}: Σ stepTrace interest consumers (${sumPaid.toFixed(2)}) > interestCollected + expenseReserveDraw (${bound.toFixed(2)})`,
      ).toBeLessThanOrEqual(bound);
    }

    // Discriminating-power sanity: under this stressed fixture, at least
    // one period MUST exhibit truncation (paid < requested). If no period
    // truncates, the test isn't actually exercising the bug — likely a
    // CLO_DEFAULTS shift made the spike non-stressful, in which case the
    // test needs reparameterization.
    const requestedThisPeriod = (p: (typeof result.periods)[number]) =>
      p.beginningPar * 0.05 * 0.25; // approximate; subFeePct=5, dayFrac~0.25
    const truncated = result.periods.filter(
      (p) => p.stepTrace.subMgmtFeePaid < requestedThisPeriod(p) * 0.95,
    );
    expect(
      truncated.length,
      "no period exhibited sub-fee truncation; fixture not stressful enough to exercise the bug",
    ).toBeGreaterThan(0);
  });

  it("admin-fee stress: adminFeesPaid trace ≤ interestCollected per period (pre-accel)", () => {
    // Spike adminFeeBps to 2000 (20%/yr on par) with no senior-expense cap,
    // so requested admin fee (~5M/quarter on 100M) far exceeds interest
    // collected (~1.46M/quarter). Pre-fix: trace emitted ~5M as
    // adminFeesPaid. Post-fix: trace emits the truncated paid amount.
    //
    // Scope: pre-acceleration periods only. Under PPM 10(b) post-
    // acceleration, the Senior Expenses Cap is removed and admin pays
    // directly from the pooled interest+principal cash — adminFeesPaid
    // can legitimately exceed interestCollected because principal cash
    // is also drawn on. The truncation invariant tested here is a pre-
    // accel property; once the EoD-on-shortfall trigger fires (admin fee
    // this stressful shorts both protected senior tranches), subsequent
    // periods run under acceleration and a different invariant applies.
    const inputs = makeInputs({
      adminFeeBps: 2000,
      seniorExpensesCapBps: undefined, // no cap
    });
    const result = runProjection(inputs);

    const preAccelPeriods = result.periods.filter((p) => !p.isAccelerated);
    expect(
      preAccelPeriods.length,
      "fixture flipped to acceleration in period 1; no pre-accel period to validate",
    ).toBeGreaterThan(0);

    for (let i = 0; i < preAccelPeriods.length; i++) {
      const p = preAccelPeriods[i];
      const adminBound = p.interestCollected + p.stepTrace.expenseReserveDraw + 0.01;
      expect(
        p.stepTrace.adminFeesPaid,
        `pre-accel period ${i}: adminFeesPaid (${p.stepTrace.adminFeesPaid.toFixed(2)}) > interestCollected + expenseReserveDraw (${adminBound.toFixed(2)})`,
      ).toBeLessThanOrEqual(adminBound);
      const sumPaid = sumInterestSideConsumers(p);
      expect(
        sumPaid,
        `pre-accel period ${i}: Σ stepTrace interest consumers (${sumPaid.toFixed(2)}) > interestCollected + expenseReserveDraw (${adminBound.toFixed(2)})`,
      ).toBeLessThanOrEqual(adminBound);
    }

    // At least one pre-accel period must show truncation under this fixture.
    const requestedAdmin = (p: (typeof preAccelPeriods)[number]) =>
      p.beginningPar * 0.2 * 0.25;
    const truncated = preAccelPeriods.filter(
      (p) => p.stepTrace.adminFeesPaid < requestedAdmin(p) * 0.95,
    );
    expect(
      truncated.length,
      "no pre-accel period exhibited admin-fee truncation; fixture not stressful enough",
    ).toBeGreaterThan(0);
  });

  it("amortising tranche: classXAmortFromInterest captures interest-pool consumption (Σ-tie holds)", () => {
    // Class X amortising tranche pays scheduled amort from the interest
    // pool at PPM step G, pari-passu with Class A interest. Without the
    // dedicated stepTrace field, this consumption was invisible to
    // partner-visible aggregators and the Σ-tie invariant was unsound on
    // any deal with active amort. This fixture verifies (a) the field is
    // populated when amort runs, (b) the Σ-tie inequality holds inclusive
    // of the new field, (c) Class X amort + Class A interest pari-passu
    // mechanic doesn't break the inequality under stress.
    const inputs = makeInputs({
      tranches: [
        { className: "X", currentBalance: 5_000_000, spreadBps: 50, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, isAmortising: true, amortisationPerPeriod: 500_000 },
        { className: "A", currentBalance: 60_000_000, spreadBps: 140, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "J", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A", triggerLevel: 120, rank: 2 },
        { className: "J", triggerLevel: 110, rank: 3 },
      ],
      icTriggers: [
        { className: "A", triggerLevel: 120, rank: 2 },
        { className: "J", triggerLevel: 110, rank: 3 },
      ],
    });
    const result = runProjection(inputs);

    // At least one period must report classXAmortFromInterest > 0 (the new
    // field is populated when amort runs). Discriminating-power assertion:
    // pre-fix the field didn't exist; post-fix it accumulates ≥ 0 per
    // period and > 0 in periods where amort actually fires.
    const periodsWithAmort = result.periods.filter((p) => p.stepTrace.classXAmortFromInterest > 0);
    expect(
      periodsWithAmort.length,
      "no period reported classXAmortFromInterest > 0 — fixture not exercising the amort-from-interest path",
    ).toBeGreaterThan(0);

    // Σ-tie EQUALITY on amort-bearing periods. The inequality alone is
    // insensitive to under-counting: pre-fix, the sum was missing the amort
    // amount, and `equityFromInterest` (the residual) was correspondingly
    // larger by exactly that amount, so the inequality `sum ≤ collected`
    // held vacuously. Equality `sum ≈ collected` is the discriminating
    // assertion — it fails pre-fix (sum < collected by amort amount) and
    // passes post-fix (every interest dollar accounted for).
    for (let i = 0; i < periodsWithAmort.length; i++) {
      const p = periodsWithAmort[i];
      const sumPaid = sumInterestSideConsumers(p);
      const expected = p.interestCollected + p.stepTrace.expenseReserveDraw;
      expect(
        Math.abs(sumPaid - expected),
        `amort period ${i}: |Σ stepTrace interest consumers (${sumPaid.toFixed(2)}) − (interestCollected + expenseReserveDraw) (${expected.toFixed(2)})| > 0.01 — Σ-tie equality broken`,
      ).toBeLessThanOrEqual(0.01);
    }
    // Inequality across ALL periods (including non-amort) catches any
    // future regression that introduces over-counting on the trace.
    for (let i = 0; i < result.periods.length; i++) {
      const p = result.periods[i];
      const sumPaid = sumInterestSideConsumers(p);
      const bound = p.interestCollected + p.stepTrace.expenseReserveDraw + 0.01;
      expect(
        sumPaid,
        `period ${i}: Σ stepTrace interest consumers (${sumPaid.toFixed(2)}) > interestCollected + expenseReserveDraw (${bound.toFixed(2)})`,
      ).toBeLessThanOrEqual(bound);
    }
  });

  it("normal mode (no stress): non-zero fee params produce non-zero paid trace", () => {
    // Guard against an over-correction that would zero-truncate even when
    // the helper has cash. Under low-but-non-zero fee params and ample
    // interest, every fee field should emit a positive amount that's
    // bounded by interestCollected (no truncation needed).
    const inputs = makeInputs({
      subFeePct: 0.5, // small but non-zero
      adminFeeBps: 25,
    });
    const result = runProjection(inputs);
    // Skip period 0 (stub from currentDate to first determination date can
    // be near-zero days; a dayFrac approximation breaks). Use a mid-life
    // period where dayFrac is a normal quarter and stress is absent.
    const p = result.periods[2];
    expect(p.stepTrace.subMgmtFeePaid, "non-zero subFeePct should produce positive paid").toBeGreaterThan(0);
    expect(p.stepTrace.adminFeesPaid, "non-zero adminFeeBps should produce positive paid").toBeGreaterThan(0);
    // Step (A)(i) Issuer taxes is now mechanically emitted by the engine
    // under Section 110 (~0 on flow-balanced projections per KI-69); no
    // user-set rate to assert against.
    // No truncation expected — each field bounded by its requested upper
    // bound (par × rate × 1, generous).
    expect(p.stepTrace.subMgmtFeePaid).toBeLessThanOrEqual(p.beginningPar * 0.005);
    expect(p.stepTrace.adminFeesPaid).toBeLessThanOrEqual(p.beginningPar * 0.0025);
  });
});
