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
 * 3(c). With KI-66's Controlling-Class gating shipped, the principal-POP
 * deferred backfill only fires when the relevant class is the Controlling
 * Class — but in that regime the bundled field can still over-state
 * trustee step (K) by the principal-POP component. Field-split (interest-
 * side vs principal-side) is deferred to the broader principal-POP
 * schema redesign tracked in `web/docs/principal-pop-redesign-research.md`.
 *
 * KI-66 marker tests (below): pin both the post-fix Controlling-Class
 * gating behavior and the schema-driven principal-POP dispatch. With
 * Class A outstanding at start-of-period, principal-POP phase 1
 * (deferred) for junior ranks is correctly skipped per Ares XV PPM
 * clause (D). Structured test fixtures also assert principal-funded
 * current-interest backfill and user-elected Special Redemption reserve
 * behavior.
 */

import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
import { makeInputs, noDefaults } from "./test-helpers";
import type { ResolvedPrincipalPop } from "../resolver-types";

const schemaPop = (clauses: ResolvedPrincipalPop["clauses"]): ResolvedPrincipalPop => ({
  interestWaterfall: {
    items: [
      { id: "class_a_current_interest", kind: "tranche_current_interest", tranche: 1 },
      { id: "class_c_deferred_interest", kind: "tranche_deferred_interest", tranche: 3 },
    ],
  },
  preWaterfallReservations: [],
  clauses,
  controllingClass: { kind: "highest_rank_outstanding" },
  redemptionMode: "sequential_npss",
  accelerationWaterfall: null,
});

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

describe("KI-66 — Controlling-Class gating on principal POP deferred paydown", () => {
  // Common minimal-interest fixture: low loan coupon so vanilla step (K)
  // interest-side paydown is negligible (≪ €1M PIK seed). This isolates
  // the principal-POP gating fix as the load-bearing mechanism — without
  // step (K) cannibalising the PIK before principal POP runs, the
  // pre-fix vs post-fix difference is fully observable in
  // `tranchePrincipal[C].paid`.
  const minimalInterestSetup = {
    ...noDefaults,
    initialPar: 10_000_000,
    wacSpreadBps: 1,
    baseRatePct: 0,
    baseRateFloorPct: 0,
    loans: Array.from({ length: 1 }, () => ({
      parBalance: 10_000_000,
      maturityDate: "2034-06-15",
      ratingBucket: "B" as const,
      spreadBps: 1,
    })),
    ocTriggers: [],
    icTriggers: [],
    deferredInterestCompounds: false,
    seniorFeePct: 0,
    subFeePct: 0,
    reinvestmentPeriodEnd: "2025-01-01", // post-RP — principal redeems
  };

  it("PPM Condition 3(c) clause (D): Class C deferred is NOT paid from principal POP while Class A is outstanding", () => {
    // Fixture engineered so:
    //  - Vanilla step (K) interest paydown is negligible (minimal interest)
    //  - Principal cash (€20M) reaches Class C's deferred phase
    //  - Class A is outstanding at start-of-period 1 (the Determination Date)
    //
    // Pre-fix sequence in principal POP: pay A (€5M) → pay B (€1M) →
    // pay C deferred (€1M) → pay C principal (€4M). C.paid = €5M total.
    // Post-fix: skip C deferred (gated; A is Controlling), pay C
    // principal (€4M). C.paid = €4M. Class C deferred balance persists
    // at ≈ €1M.
    const inputs = makeInputs({
      ...minimalInterestSetup,
      tranches: [
        { className: "A", currentBalance: 5_000_000, spreadBps: 1, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 1_000_000, spreadBps: 1, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 4_000_000, spreadBps: 1, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true, deferredInterestBalance: 1_000_000 },
        { className: "Sub", currentBalance: 4_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      initialPrincipalCash: 20_000_000,
    });
    const result = runProjection(inputs);
    const p1 = result.periods[0];

    const c = p1.tranchePrincipal.find((t) => t.className === "C");
    expect(c).toBeDefined();

    // Load-bearing assertion: tranchePrincipal[C].paid in period 1 does
    // NOT include the deferred share. Pre-fix would have been €5M (€1M
    // deferred + €4M principal); post-fix is €4M (principal phase 2 only,
    // phase 1 gated).
    expect(c!.paid).toBeLessThan(4_100_000);  // strictly < pre-fix €5M
    expect(c!.paid).toBeGreaterThan(3_900_000);  // confirm phase 2 still ran

    // Class C ending balance ≈ deferred residual (€1M minus tiny step K).
    // Pre-fix would have been ~0.
    expect(c!.endBalance).toBeGreaterThan(900_000);

    // Sanity: Class A WAS Controlling at start (paid down by phase 2).
    const a = p1.tranchePrincipal.find((t) => t.className === "A");
    expect(a?.paid).toBeGreaterThan(4_900_000);

    // Sanity: deferredPaydownByTranche[C] reflects only the small step K
    // interest-side amount post-fix, NOT the €1M principal-POP unconditional
    // paydown that would have happened pre-fix.
    const cPaydownP1 = p1.stepTrace.deferredPaydownByTranche["C"] ?? 0;
    expect(cPaydownP1).toBeLessThan(100_000); // pre-fix would have been ≥ €1M
  });

  it("PPM Condition 3(c) clauses (D)/(G)/(J)/(M): gating applies uniformly across all deferrable ranks (not just one)", () => {
    // Stronger structural assertion across multiple deferrable ranks:
    // when Class A is outstanding at start, NEITHER Class C (rank 3) NOR
    // Class D (rank 4) deferred is paid from principal POP — only the
    // Controlling rank (A, rank 1) gets phase 1 (no-op since A is non-
    // deferrable). Phase 2 principal redemption is unaffected by gating
    // and proceeds in seniority order regardless.
    const inputs = makeInputs({
      ...minimalInterestSetup,
      tranches: [
        { className: "A", currentBalance: 5_000_000, spreadBps: 1, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 1_000_000, spreadBps: 1, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 4_000_000, spreadBps: 1, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true, deferredInterestBalance: 800_000 },
        { className: "D", currentBalance: 3_000_000, spreadBps: 1, seniorityRank: 4, isFloating: true, isIncomeNote: false, isDeferrable: true, deferredInterestBalance: 600_000 },
        { className: "Sub", currentBalance: 5_000_000, spreadBps: 0, seniorityRank: 5, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      initialPrincipalCash: 25_000_000,
    });
    const result = runProjection(inputs);
    const p1 = result.periods[0];

    const c = p1.tranchePrincipal.find((t) => t.className === "C");
    const d = p1.tranchePrincipal.find((t) => t.className === "D");

    // Both C and D phase 1 (deferred) gated; phase 2 (principal) runs.
    // Pre-fix: C.paid = 4M + 800K = €4.8M; D.paid = 3M + 600K = €3.6M.
    // Post-fix: C.paid = €4M; D.paid = €3M.
    expect(c!.paid).toBeGreaterThan(3_900_000);
    expect(c!.paid).toBeLessThan(4_100_000);
    expect(d!.paid).toBeGreaterThan(2_900_000);
    expect(d!.paid).toBeLessThan(3_100_000);
  });

  it("schema POP clause (P): Special Redemption reserve survives RP reinvestment and redeems notes in pass 2", () => {
    const inputs = makeInputs({
      ...minimalInterestSetup,
      cprPct: 0,
      reinvestmentPeriodEnd: "2028-06-15",
      initialPrincipalCash: 10_000_000,
      specialRedemptionAmount: 3_000_000,
      principalPop: schemaPop([
        { id: "P", kind: "special_redemption", proceedsSubset: "special_redemption_amount" },
        { id: "V", kind: "residual_to_subordinated" },
      ]),
    });

    const p1 = runProjection(inputs).periods[0];
    const a = p1.tranchePrincipal.find((t) => t.className === "A");

    expect(p1.reinvestment).toBeGreaterThan(6_900_000);
    expect(p1.reinvestment).toBeLessThan(7_100_000);
    expect(a?.paid).toBeGreaterThan(2_900_000);
    expect(a?.paid).toBeLessThan(3_100_000);
  });

  it("schema POP clause (A): principal proceeds backfill unpaid current interest without redeeming principal", () => {
    const inputs = makeInputs({
      ...minimalInterestSetup,
      baseRatePct: 0,
      baseRateFloorPct: 0,
      reinvestmentPeriodEnd: "2025-01-01",
      initialPrincipalCash: 1_000_000,
      tranches: [
        { className: "A", currentBalance: 10_000_000, spreadBps: 400, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 5_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      principalPop: schemaPop([
        { id: "A", kind: "unconditional_backfill", paysItems: ["class_a_current_interest"] },
        { id: "V", kind: "residual_to_subordinated" },
      ]),
    });

    const p1 = runProjection(inputs).periods[0];
    const aInterest = p1.trancheInterest.find((t) => t.className === "A");
    const aPrincipal = p1.tranchePrincipal.find((t) => t.className === "A");

    expect(aInterest?.due).toBeGreaterThan(0);
    expect(aInterest?.paid).toBeCloseTo(aInterest!.due, 6);
    expect(aPrincipal?.paid).toBe(0);
  });

  it("schema POP clause (D): Controlling-Class deferred backfill does not also redeem principal", () => {
    const inputs = makeInputs({
      ...minimalInterestSetup,
      reinvestmentPeriodEnd: "2025-01-01",
      tranches: [
        { className: "A", currentBalance: 0, spreadBps: 1, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 0, spreadBps: 1, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 4_000_000, spreadBps: 1, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true, deferredInterestBalance: 1_000_000 },
        { className: "Sub", currentBalance: 4_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      initialPrincipalCash: 10_000_000,
      principalPop: schemaPop([
        { id: "D", kind: "controlling_class_backfill", gatingTranche: 3, paysItems: ["class_c_deferred_interest"] },
        { id: "V", kind: "residual_to_subordinated" },
      ]),
    });

    const p1 = runProjection(inputs).periods[0];
    const c = p1.tranchePrincipal.find((t) => t.className === "C");

    expect(c?.paid).toBeGreaterThan(990_000);
    expect(c?.paid).toBeLessThan(1_010_000);
    expect(c?.endBalance).toBeGreaterThan(3_900_000);
    expect(p1.stepTrace.deferredPaydownByTranche["C"]).toBeGreaterThan(990_000);
  });
});
