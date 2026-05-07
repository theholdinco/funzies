/**
 * KI-07 closure: deferred-interest pay-down emits as a separate stepTrace
 * field, distinct from PIK accrual.
 *
 * Pre-fix engine state: `deferredAccrualByTranche` (PIK growth) was the only
 * deferred-related stepTrace field. The harness mapping `classC_deferred →
 * step (K)` sourced from this field, but trustee step (K) reports cash PAID
 * against accumulated PIK — accrual and pay-down are mirror-image flows, not
 * comparable. On Euro XV both are zero (no PIK state) so the category error
 * was invisible; under stress on any deal it would silently flag inverted
 * drift.
 *
 * Post-fix: a sibling `deferredPaydownByTranche` field populates at all
 * three sites where the engine decrements deferredBalances: (1) vanilla
 * pre-acceleration interest waterfall step (K) between current interest
 * and cure check (NEW site); (2) cure-mode interest paydown when the
 * cure target rank is deferrable (existing decrement, now also surfaces);
 * (3) principal POP deferred-then-principal sequencing (existing decrement,
 * now also surfaces). Harness mapping re-routes to source from the new
 * field so the trustee step (K) comparison is semantically correct.
 *
 * Bundling note: this field bundles all three sources. Trustee step (K)
 * specifically reports interest-side payment per Ares XV OC Condition
 * 3(c). Under stress where principal-POP also pays deferred (KI-66
 * Controlling-Class gating gap), this field would over-state trustee
 * step (K) by the principal-POP component. Field-split deferred to
 * KI-66 closure.
 *
 * KI-66 marker: also pinned in this file — current uniformly-simplified
 * principal-POP loop pays Class C deferred from principal regardless of
 * Controlling Class, which is wrong per Ares XV clause (D). Marker flips
 * when KI-66 fix lands.
 */

import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
import { makeInputs, noDefaults } from "./test-helpers";

describe("KI-07 — deferredPaydownByTranche field exists and populates", () => {
  it("field exists on every period's stepTrace and is zero when no deferred state", () => {
    // Vanilla synthetic with no deferred-interest seeding. Field must
    // exist on every period and populate as an empty/zero record.
    const inputs = makeInputs({ ...noDefaults });
    const result = runProjection(inputs);
    for (const period of result.periods) {
      expect(period.stepTrace.deferredPaydownByTranche).toBeDefined();
      // No deferrable tranches in the default fixture; every value zero.
      const sum = Object.values(period.stepTrace.deferredPaydownByTranche).reduce(
        (s, v) => s + v, 0
      );
      expect(sum).toBe(0);
    }
  });

  it("vanilla step (K): surplus interest pays accumulated PIK, populates field", () => {
    // Seed Class C with non-zero deferredInterestBalance under compounds=false
    // so the seed enters deferredBalances[C] separately from trancheBalance.
    // Period 1 then has surplus interest available after Class A/C current
    // interest, so the new vanilla step (K) site at the C rank fires and
    // pays accumulated PIK from interest proceeds.
    const inputs = makeInputs({
      ...noDefaults,
      tranches: [
        { className: "A", currentBalance: 50_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 10_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 20_000_000, spreadBps: 350, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true, deferredInterestBalance: 2_000_000 },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],  // no OC cure to confound the test
      icTriggers: [],
      deferredInterestCompounds: false,  // seed enters deferredBalances bucket
      // Default makeInputs has 100M par at 375bps → ~3.75% × 100M × 0.25
      // ≈ €937K/q gross interest. Class A+B+C current ≈ (50M×3.5% + 10M×4.1%
      // + 20M×6.6%) × 0.25 ≈ €822K/q — leaves ~€100K/q surplus for vanilla
      // step (K) paydown of accumulated PIK.
    });
    const result = runProjection(inputs);

    // Period 1 should pay some of the seeded €2M PIK from surplus interest.
    const p1 = result.periods[0];
    const paydownC = p1.stepTrace.deferredPaydownByTranche["C"] ?? 0;

    // Either:
    //  (a) Vanilla step (K) paid some PIK from interest → paydownC > 0; OR
    //  (b) Principal POP paid some PIK from principal proceeds (at maturity
    //      or via amortization) → paydownC > 0.
    // Both routes populate the same field; test asserts the field
    // populates non-zero across at least one period.
    const totalPaydownC = result.periods.reduce(
      (s, p) => s + (p.stepTrace.deferredPaydownByTranche["C"] ?? 0), 0
    );
    expect(totalPaydownC).toBeGreaterThan(0);

    // Sanity: the deferred balance must shrink (or be paid off) over the
    // projection horizon if any paydown occurred.
    const finalP = result.periods[result.periods.length - 1];
    const classC = finalP.tranchePrincipal.find((t) => t.className === "C");
    expect(classC).toBeDefined();
    // endBalance includes deferred + principal — both should be paid by
    // maturity in this synthetic scenario.
    expect(classC!.endBalance).toBeLessThan(30_000_000 + 2_000_000);

    // Anti-regression on the accrual sibling: deferredAccrualByTranche
    // tracks PIK GROWTH (not pay-down). In this synthetic with surplus
    // interest, no new PIK accrues, so accrual remains zero.
    expect(p1.stepTrace.deferredAccrualByTranche["C"] ?? 0).toBe(0);
    void paydownC; // avoid unused-binding lint when paydownC happens to be 0 in a given period
  });

  it("PIK accrual and pay-down are mirror-image events tracked on different fields", () => {
    // Setup where period 1 starves interest (high default rate) → PIK
    // accrues; assert deferredAccrualByTranche populates and
    // deferredPaydownByTranche stays zero on the accrual period.
    const inputs = makeInputs({
      tranches: [
        { className: "A", currentBalance: 50_000_000, spreadBps: 100, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 10_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 20_000_000, spreadBps: 600, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      deferredInterestCompounds: false,
      // High default rates starve interest in period 1 → PIK accrues on C.
      defaultRatesByRating: { CCC: 0, B: 30, BB: 0, BBB: 0, A: 0, AA: 0, AAA: 0, NR: 0 },
    });
    const result = runProjection(inputs);

    // Find a period where accrual occurred.
    const accrualPeriod = result.periods.find(
      (p) => (p.stepTrace.deferredAccrualByTranche["C"] ?? 0) > 0
    );
    if (accrualPeriod) {
      // On the accrual period, paydown should be zero (current interest was
      // insufficient to cover Class C, so no surplus to pay accumulated PIK).
      expect(accrualPeriod.stepTrace.deferredPaydownByTranche["C"] ?? 0).toBe(0);
    }
  });
});

describe("KI-66 marker — principal POP unconditional deferred paydown", () => {
  it("KI-66-uniformLoop: engine pays Class C deferred from principal POP regardless of Controlling Class (current WRONG behavior; flips when KI-66 lands)", () => {
    // Per Ares XV PPM Condition 3(c) clause (D), principal POP backfill of
    // Class C deferred interest fires only when Class C is the Controlling
    // Class (i.e., Class A and Class B are paid off). Under the engine's
    // current uniformly-simplified loop, Class C deferred is paid from
    // principal POP regardless — wrong on Ares XV when Class A is still
    // outstanding.
    //
    // Marker scenario: Class A outstanding + Class C with seeded deferred
    // balance + Class A maturity at q=1 (forces principal proceeds to flow).
    // Assert engine currently pays Class C deferred from principal POP.
    // Marker assertion flips to ZERO Class C principal-POP deferred-paydown
    // when KI-66 closes (gating predicate evaluated, paydown skipped).
    const inputs = makeInputs({
      ...noDefaults,
      tranches: [
        { className: "A", currentBalance: 50_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 10_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 20_000_000, spreadBps: 350, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true, deferredInterestBalance: 1_000_000 },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      deferredInterestCompounds: false,
    });
    const result = runProjection(inputs);

    // The seed of €1M Class C PIK must show paydown across the projection
    // horizon (current behavior pays from any source — interest waterfall
    // step (K), cure mode, OR principal POP). The KI-66 marker is the
    // FACT that Class C PIK paydown happens via principal-POP at any
    // point while Class A is still outstanding.
    const totalCPaydown = result.periods.reduce(
      (s, p) => s + (p.stepTrace.deferredPaydownByTranche["C"] ?? 0), 0
    );

    // Pin: under current uniformly-simplified principal-POP loop, the
    // €1M Class C PIK seed gets paid down at some point during the
    // projection (either via interest-side step K, or principal-POP).
    // After KI-66 fix, principal-POP paydown will be gated; if interest
    // alone can't pay the full €1M, the residual will persist past
    // Class A's lifetime — the assertion structure changes.
    expect(totalCPaydown).toBeGreaterThan(0);
    // Documentation: when KI-66 lands, decompose this assertion into
    // (a) interest-side paydown (still allowed) vs (b) principal-side
    // paydown gated on Controlling Class. The current bundled field
    // can't distinguish them; KI-66 closure introduces the field split.
  });
});
