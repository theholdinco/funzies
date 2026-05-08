/**
 * C3 — Senior Expenses Cap + uncapped overflow (PPM Condition 10).
 *
 * PPM steps (B) trustee + (C) admin are jointly bounded by the Senior
 * Expenses Cap per Condition 10. Expenses above the cap defer to steps
 * (Y) trustee-overflow and (Z) admin-overflow, which pay from residual
 * interest AFTER tranche interest + sub mgmt fee.
 *
 * Closes KI-08 cap+overflow remainder. Pre-fill portion (trusteeFeeBps +
 * adminFeeBps back-derive from Q1 waterfall) landed in D3 and is verified
 * by `d3-defaults-from-resolved.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProjection } from "@/lib/clo/projection";
import { buildFromResolved, defaultsFromResolved, diagnoseCarryforwardSeed } from "@/lib/clo/build-projection-inputs";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof defaultsFromResolved>[1];
};

describe("C3 — Senior Expenses Cap: base case (no overflow on Euro XV)", () => {
  it("Euro XV default: observed fees ~5.24 bps < 20 bps cap → no overflow", () => {
    const inputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const result = runProjection(inputs);
    for (const p of result.periods) {
      // Capped portion paid in full; overflow zero. trusteeFeesPaid is PPM
      // step (B) only post-C3 split; adminFeesPaid is (C); trusteeOverflowPaid
      // is (Y); adminOverflowPaid is (Z). Each maps 1:1 to a trustee step.
      expect(p.stepTrace.trusteeOverflowPaid).toBe(0);
      expect(p.stepTrace.adminOverflowPaid).toBe(0);
      expect(p.stepTrace.trusteeFeesPaid).toBeGreaterThanOrEqual(0);
      expect(p.stepTrace.adminFeesPaid).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("C3 — Senior Expenses Cap: stress scenarios with overflow", () => {
  it("high trustee + admin above cap → overflow fires at steps (Y)/(Z)", () => {
    // Set trustee + admin to 50 bps combined (well above default 20 bps cap).
    // Cap = 20 bps on ~€493M × 91/360 quarter ≈ €249K.
    // Requested = 50 bps × ~€493M × 91/360 ≈ €623K.
    // Overflow = ~€374K per period, pays from residual interest.
    const inputs = buildFromResolved(fixture.resolved, {
      ...defaultsFromResolved(fixture.resolved, fixture.raw),
      trusteeFeeBps: 10,
      adminFeeBps: 40,
      seniorExpensesCapBps: 20,
      // Isolate the bps-cap mechanic from the absolute floor (Ares XV's
      // €300K/yr floor lifts the effective cap by ~€75K/quarter, which
      // would mask the exact 20 bps cap behavior this test asserts).
      seniorExpensesCapAbsoluteFloorPerYear: 0,
    });
    const result = runProjection(inputs);
    const p1 = result.periods[0];

    // KI-16 closure — sequential B-first within cap (PPM Cond 3(c)(C) reads
    // "less any amounts paid pursuant to paragraph (B) above"):
    //   trusteeFeeAmount = min(10 bps, 20 bps cap) = 10 bps (full request paid)
    //   adminFeeAmount   = min(40 bps, 20 - 10 = 10 bps remainder) = 10 bps
    // Total cappedPaid = 20 bps; Overflow per bucket:
    //   trustee overflow = 10 - 10 = 0 bps
    //   admin overflow   = 40 - 10 = 30 bps
    // Total overflow = 30 bps (invariant under both pro-rata and sequential
    // in-cap rules — only the per-bucket split changes).
    const expectedOverflowBps = 30;
    const overflowTotalExpected =
      fixture.resolved.poolSummary.totalPrincipalBalance * (expectedOverflowBps / 10000) * (91 / 360);
    const actualOverflowTotal = (p1.stepTrace.trusteeOverflowPaid) + (p1.stepTrace.adminOverflowPaid);
    // Total assertion is invariant under the in-cap allocation rule change.
    // 0.1% tolerance for the ~€28k beginningPar vs totalPrincipalBalance gap
    // (Labeyrie PIK — see B1 test notes).
    expect(actualOverflowTotal).toBeLessThanOrEqual(overflowTotalExpected * 1.001);
    expect(actualOverflowTotal).toBeGreaterThan(overflowTotalExpected * 0.95);

    // Per-bucket split under sequential B-first: trustee fully consumed by
    // cap headroom (paid at step B), zero overflow; all 30 bps overflow flows
    // through step Z to admin. Pre-KI-16 the engine pro-rated, producing
    // trustee 6 bps + admin 24 bps overflow (4:1 ratio); post-KI-16 the ratio
    // is undefined (admin / 0).
    expect(p1.stepTrace.trusteeOverflowPaid).toBeCloseTo(0, 0);
    const adminOverflowExpected =
      fixture.resolved.poolSummary.totalPrincipalBalance * (30 / 10000) * (91 / 360);
    expect(p1.stepTrace.adminOverflowPaid).toBeGreaterThan(adminOverflowExpected * 0.95);
    expect(p1.stepTrace.adminOverflowPaid).toBeLessThanOrEqual(adminOverflowExpected * 1.001);
  });

  it("extreme cap (1 bps) with low fees → capped portion < requested, large overflow", () => {
    // Cap at 1 bps on Euro XV default observed ~5.24 bps.
    const inputs = buildFromResolved(fixture.resolved, {
      ...defaultsFromResolved(fixture.resolved, fixture.raw),
      seniorExpensesCapBps: 1,
      // Isolate the bps-cap mechanic from the absolute floor (see prior
      // test). At 1 bps with €300K/yr floor in play, observed combined
      // fees would all fit in the floor and produce zero overflow.
      seniorExpensesCapAbsoluteFloorPerYear: 0,
    });
    const result = runProjection(inputs);
    const p1 = result.periods[0];

    // Combined observed ≈ 5.244 bps. Cap at 1 bps. Ratio ≈ 1/5.244 ≈ 0.19.
    // trusteeFeeBps ≈ 0.097, adminFeeBps ≈ 5.147. Combined requested ≈ 5.244 bps.
    // Capped paid total = 1 bps × beginPar × dayFrac.
    // Overflow total = (5.244 − 1) bps × beginPar × dayFrac.
    const capAmount = fixture.resolved.poolSummary.totalPrincipalBalance * (1 / 10000) * (91 / 360);
    const requestedAmount = fixture.resolved.poolSummary.totalPrincipalBalance * (5.244 / 10000) * (91 / 360);
    const expectedOverflow = requestedAmount - capAmount;
    const actualOverflow = (p1.stepTrace.trusteeOverflowPaid) + (p1.stepTrace.adminOverflowPaid);
    expect(actualOverflow).toBeCloseTo(expectedOverflow, -2); // ±€50
  });

  it("overflow flow: no overflow when interestAfterFees is thin — shortfall absorbed by sub", () => {
    // Force an extreme scenario where step Y/Z overflow can't be paid from
    // residual interest (because tranche interest and sub mgmt fee exhaust it).
    // Engineered: tiny cap (1 bps) + very high trustee fees (300 bps).
    const inputs = buildFromResolved(fixture.resolved, {
      ...defaultsFromResolved(fixture.resolved, fixture.raw),
      trusteeFeeBps: 150,
      adminFeeBps: 150,
      seniorExpensesCapBps: 1,
    });
    const result = runProjection(inputs);
    const p1 = result.periods[0];
    // Overflow paid <= available residual interest after tranche interest +
    // sub mgmt fee. If residual ran out, overflow is capped by residual.
    expect((p1.stepTrace.trusteeOverflowPaid)).toBeGreaterThanOrEqual(0);
    expect((p1.stepTrace.adminOverflowPaid)).toBeGreaterThanOrEqual(0);
    // Sanity: overflow can't exceed the requested amount.
    const requestedOverflowTotal =
      fixture.resolved.poolSummary.totalPrincipalBalance * ((300 - 1) / 10000) * (91 / 360);
    expect(
      (p1.stepTrace.trusteeOverflowPaid) + (p1.stepTrace.adminOverflowPaid),
    ).toBeLessThanOrEqual(requestedOverflowTotal + 1);
  });
});

describe("Senior Expenses Cap — component (a) mixed day-count: Actual/360 first PD, 30/360 ongoing", () => {
  it("first PD of deal accrues floor at Actual/360 (PPM proviso (a)(x))", () => {
    // Greenfield branch: projection starts before/at the deal's first PD.
    // Override `firstPaymentDate` to a future date so q=1 IS the deal's
    // first PD; assert the floor accrues at Actual/360, not 30/360.
    const baseInputs = buildFromResolved(
      fixture.resolved,
      defaultsFromResolved(fixture.resolved, fixture.raw),
    );
    const inputs = {
      ...baseInputs,
      seniorExpensesCapBps: 0.0001,
      seniorExpensesCapAbsoluteFloorPerYear: 300_000,
      trusteeFeeBps: 1000,
      adminFeeBps: 0,
      seniorExpensesCapComponentADayCount: "30_360_after_first" as const,
      firstPaymentDate: "2099-01-15", // far-future → q=1 is the deal's first PD
    };
    const firstPdRun = runProjection(inputs);
    // Ongoing branch: pin firstPaymentDate strictly before currentDate so
    // the engine reaches the 30/360 path. Use 2020-01-15 (well before the
    // fixture's 2026 currentDate).
    const ongoingRun = runProjection({ ...inputs, firstPaymentDate: "2020-01-15" });
    // First-PD branch: floor accrues at Actual/360 = 91/360 = 0.2528.
    // Ongoing branch: floor accrues at 30/360 = 0.25.
    // capAmount differs by €300K × (91/360 - 90/360) ≈ €833.
    const drift =
      firstPdRun.periods[0].stepTrace.seniorExpensesCapAmount -
      ongoingRun.periods[0].stepTrace.seniorExpensesCapAmount;
    expect(drift).toBeGreaterThan(800);
    expect(drift).toBeLessThan(900);
  });

  it("ongoing PD accrues floor at 30/360, not Actual/360 (€833/quarter drift on €300K p.a.)", () => {
    // Ares XV mid-life: currentDate (2026-...) > firstPaymentDate (2022-...)
    // → q=1 is NOT the deal's first PD → component (a) accrues at 30/360.
    // PPM-correct floor = €300K × 30/360 = €75,000 on a 91-day quarter
    // (vs €75,833 at uniform Actual/360 = €300K × 91/360). Drift = ~€833.
    const baseInputs = buildFromResolved(
      fixture.resolved,
      defaultsFromResolved(fixture.resolved, fixture.raw),
    );
    // Force cap to bind at the floor: tiny bps (0.0001 → €5/quarter on €493M)
    // so the floor dominates the cap; high fees so cappedPaid = capAmount.
    const stress = {
      ...baseInputs,
      seniorExpensesCapBps: 0.0001,
      seniorExpensesCapAbsoluteFloorPerYear: 300_000,
      trusteeFeeBps: 1000,
      adminFeeBps: 0,
    };
    const ppmCorrect = runProjection({
      ...stress,
      seniorExpensesCapComponentADayCount: "30_360_after_first",
    });
    const legacy = runProjection({
      ...stress,
      seniorExpensesCapComponentADayCount: "actual_360",
    });
    const ppmCappedPaid =
      ppmCorrect.periods[0].stepTrace.trusteeFeesPaid +
      ppmCorrect.periods[0].stepTrace.adminFeesPaid;
    const legacyCappedPaid =
      legacy.periods[0].stepTrace.trusteeFeesPaid +
      legacy.periods[0].stepTrace.adminFeesPaid;
    const drift = legacyCappedPaid - ppmCappedPaid;
    // 91-day quarter Actual/360 - 30/360 = (91/360 - 90/360) = 1/360
    // Drift = €300K / 360 ≈ €833.33.
    expect(drift).toBeGreaterThan(800);
    expect(drift).toBeLessThan(900);
  });

  it("firstPaymentDate=null → mid-life (30/360), not first PD (Actual/360)", () => {
    // Engine convention: a null firstPaymentDate means the engine has no
    // anchor to distinguish the deal's first PD from any other PD, so it
    // defaults to mid-life (30/360 under "30_360_after_first"). A regression
    // that flips the null branch to Actual/360 would silently over-accrue
    // the floor on every fixture that omits firstPaymentDate.
    const baseInputs = buildFromResolved(
      fixture.resolved,
      defaultsFromResolved(fixture.resolved, fixture.raw),
    );
    const stress = {
      ...baseInputs,
      seniorExpensesCapBps: 0.0001,
      seniorExpensesCapAbsoluteFloorPerYear: 300_000,
      trusteeFeeBps: 1000,
      adminFeeBps: 0,
      seniorExpensesCapComponentADayCount: "30_360_after_first" as const,
    };
    const nullRun = runProjection({ ...stress, firstPaymentDate: null });
    const midLifeRun = runProjection({ ...stress, firstPaymentDate: "2020-01-15" });
    // null and an explicit past firstPaymentDate must produce the same q=1
    // cap amount (both → 30/360).
    expect(nullRun.periods[0].stepTrace.seniorExpensesCapAmount).toBeCloseTo(
      midLifeRun.periods[0].stepTrace.seniorExpensesCapAmount,
      6,
    );
  });

  it("currentDate === firstPaymentDate → mid-life (30/360); strict less-than is the boundary", () => {
    // q=1 runs from currentDate to currentDate + 1Q. When currentDate
    // equals firstPaymentDate, q=1's payment date is firstPaymentDate + 1Q
    // — the deal's SECOND PD, not the first. So 30/360 applies. Pre-fix
    // code used `<=` and silently used Actual/360 on this boundary.
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    const currentDate = fixture.resolved.dates.currentDate;
    const stress = {
      ...baseInputs,
      seniorExpensesCapBps: 0.0001,
      seniorExpensesCapAbsoluteFloorPerYear: 300_000,
      trusteeFeeBps: 1000,
      adminFeeBps: 0,
      seniorExpensesCapComponentADayCount: "30_360_after_first" as const,
    };
    // Boundary case: firstPaymentDate exactly matches currentDate.
    const boundaryRun = runProjection({ ...stress, firstPaymentDate: currentDate });
    // Strictly-before case: q=1 IS the deal's first PD → Actual/360.
    const futureFpdRun = runProjection({ ...stress, firstPaymentDate: "2099-01-15" });
    // Boundary should use 30/360, not Actual/360. So boundaryRun should
    // match a known-mid-life run (e.g., past firstPaymentDate), not the
    // future-fpd run. Drift between boundary and future-fpd should be the
    // ~€833 first-PD adjustment.
    const boundaryCap = boundaryRun.periods[0].stepTrace.seniorExpensesCapAmount;
    const futureFpdCap = futureFpdRun.periods[0].stepTrace.seniorExpensesCapAmount;
    const drift = futureFpdCap - boundaryCap;
    expect(drift).toBeGreaterThan(800);
    expect(drift).toBeLessThan(900);
  });
});

describe("Senior Expenses Cap — CPA cap base augments by Principal Account + Unused Proceeds", () => {
  it("capBaseMode='CPA' grows cap base by initialPrincipalCash; 'APB' uses pool only", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    // Force cap to bind on the bps component so the CPA-vs-APB delta is
    // observable. Synthetic principal cash: €10M.
    const principalCash = 10_000_000;
    const stress = {
      ...baseInputs,
      initialPrincipalCash: principalCash,
      seniorExpensesCapBps: 1, // bind the cap on bps component
      seniorExpensesCapAbsoluteFloorPerYear: 0,
      trusteeFeeBps: 100,
      adminFeeBps: 0,
    };
    const cpa = runProjection({
      ...stress,
      seniorExpensesCapBaseMode: "CPA",
    });
    const apb = runProjection({
      ...stress,
      seniorExpensesCapBaseMode: "APB",
    });
    const cpaCapped =
      cpa.periods[0].stepTrace.trusteeFeesPaid + cpa.periods[0].stepTrace.adminFeesPaid;
    const apbCapped =
      apb.periods[0].stepTrace.trusteeFeesPaid + apb.periods[0].stepTrace.adminFeesPaid;
    // Delta = principalCash × 1 bps × dayFracActual ≈ €10M × 0.0001 × 91/360 ≈ €252.78.
    const expectedDelta = principalCash * (1 / 10000) * (91 / 360);
    expect(cpaCapped - apbCapped).toBeGreaterThan(expectedDelta * 0.95);
    expect(cpaCapped - apbCapped).toBeLessThan(expectedDelta * 1.05);
  });

  it("q=1 in-period: capBaseMode='CPA' adds initialPrincipalCash + initialUnusedProceedsCash to cap base", () => {
    // Mirrors the T=0 dispatch test (initialState.seniorExpensesCapAmountT0)
    // but exercises the in-period cap-construction site at
    // projection.ts:3007-3011, which is a SEPARATE code path from the T=0
    // IIFE at projection.ts:2276-2283. A regression dropping the
    // `(q === 1 ? Math.max(0, initialUnusedProceedsCash) : 0)` clause from
    // the in-period site would not be caught by either the T=0 marker (which
    // exercises only the IIFE) or the existing in-period principal-cash
    // marker (which leaves UPA at zero). This pins both addenda on the
    // in-period path simultaneously.
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    const principalCash = 5_000_000;
    const upaCash = 3_000_000;
    const stress = {
      ...baseInputs,
      initialPrincipalCash: principalCash,
      initialUnusedProceedsCash: upaCash,
      seniorExpensesCapBps: 1,
      seniorExpensesCapAbsoluteFloorPerYear: 0,
    };
    const cpa = runProjection({ ...stress, seniorExpensesCapBaseMode: "CPA" as const });
    const apb = runProjection({ ...stress, seniorExpensesCapBaseMode: "APB" as const });
    // Delta = (5M + 3M) × 1 bps × 91/360 ≈ €202.22.
    const expectedDelta = (principalCash + upaCash) * (1 / 10000) * (91 / 360);
    const cpaCapAmount = cpa.periods[0].stepTrace.seniorExpensesCapAmount;
    const apbCapAmount = apb.periods[0].stepTrace.seniorExpensesCapAmount;
    expect(cpaCapAmount - apbCapAmount).toBeGreaterThan(expectedDelta * 0.95);
    expect(cpaCapAmount - apbCapAmount).toBeLessThan(expectedDelta * 1.05);
  });
});

describe("Senior Expenses Cap — 3-period rolling carryforward of unused headroom (PPM proviso (ii))", () => {
  it("buffer accumulates Σ unused headroom over preceding N periods (PPM proviso (ii))", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    // Constant fees < cap → each period contributes the same unused
    // headroom. With carryforwardPeriods=3, the buffer accumulates over
    // periods 1, 2, 3 and saturates at q=4 onward (FIFO trim).
    const stress = {
      ...baseInputs,
      seniorExpensesCapBps: 5,
      seniorExpensesCapAbsoluteFloorPerYear: 0,
      trusteeFeeBps: 1,
      adminFeeBps: 0,
    };
    const withCarryforward = runProjection({
      ...stress,
      seniorExpensesCapCarryforwardPeriods: 3,
    });
    const withoutCarryforward = runProjection({
      ...stress,
      seniorExpensesCapCarryforwardPeriods: null,
    });
    // Period 1: buffer empty in both → carryforwardSum = 0.
    expect(withCarryforward.periods[0].stepTrace.seniorExpensesCapCarryforwardSum).toBe(0);
    expect(withoutCarryforward.periods[0].stepTrace.seniorExpensesCapCarryforwardSum).toBe(0);
    // Period 2: buffer holds period-1 unused headroom.
    expect(withCarryforward.periods[1].stepTrace.seniorExpensesCapCarryforwardSum).toBeGreaterThan(0);
    expect(withoutCarryforward.periods[1].stepTrace.seniorExpensesCapCarryforwardSum).toBe(0);
    // The cap amount differs by exactly the carryforward sum.
    const w2 = withCarryforward.periods[1];
    const wo2 = withoutCarryforward.periods[1];
    expect(w2.stepTrace.seniorExpensesCapAmount - wo2.stepTrace.seniorExpensesCapAmount).toBeCloseTo(
      w2.stepTrace.seniorExpensesCapCarryforwardSum,
      2,
    );
    // Period 4+: buffer holds exactly 3 entries (FIFO trim). The sum drifts
    // mildly as `beginningPar` evolves (defaults/recoveries), but the cap
    // amount stays strictly augmented vs the no-carryforward run by exactly
    // the carryforward sum.
    for (let q = 3; q < 7; q++) {
      const wq = withCarryforward.periods[q];
      const woq = withoutCarryforward.periods[q];
      expect(wq.stepTrace.seniorExpensesCapCarryforwardSum).toBeGreaterThan(0);
      expect(
        wq.stepTrace.seniorExpensesCapAmount - woq.stepTrace.seniorExpensesCapAmount,
      ).toBeCloseTo(wq.stepTrace.seniorExpensesCapCarryforwardSum, 2);
    }
    // Pin FIFO trim explicitly: with carryforwardPeriods=3, once the buffer
    // is full (q≥4), the carryforward sum equals Σ of the trailing 3
    // per-period headroom contributions. periods[1] (q=2) holds exactly
    // one entry (q=1's headroom). At periods[5] (q=6) under FIFO, the
    // buffer holds entries from q=3,q=4,q=5 — three entries, each slightly
    // smaller than q=1's because `beginningPar` drifts down via defaults/
    // recoveries (observed ~10% drift across 5 periods on Euro XV).
    //
    //   FIFO with 3-slot trim:  ratio ≈ 3 × (drift factor) ≈ 2.7
    //   Off-by-one (4 entries): ratio ≈ 4 × drift ≈ 3.7
    //   Off-by-one (2 entries): ratio ≈ 2 × drift ≈ 1.8
    //   No trim (5 entries):    ratio ≈ 5 × drift ≈ 4.5
    //
    // The bounds 2.0–3.5 accept the FIFO=3 case and reject every other
    // trim depth.
    const oneEntry = withCarryforward.periods[1].stepTrace.seniorExpensesCapCarryforwardSum;
    const fullBuffer = withCarryforward.periods[5].stepTrace.seniorExpensesCapCarryforwardSum;
    const ratio = fullBuffer / oneEntry;
    expect(ratio).toBeGreaterThan(2.0);
    expect(ratio).toBeLessThan(3.5);
  });

  it("seed input augments the q=1 cap by Σ seed entries (mid-life projection)", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    const stress = {
      ...baseInputs,
      seniorExpensesCapBps: 5,
      seniorExpensesCapAbsoluteFloorPerYear: 0,
      seniorExpensesCapCarryforwardPeriods: 3,
      trusteeFeeBps: 1,
      adminFeeBps: 0,
    };
    const seed = [10_000, 15_000, 20_000];
    const withSeed = runProjection({ ...stress, seniorExpensesCapCarryforwardSeed: seed });
    const withoutSeed = runProjection({ ...stress, seniorExpensesCapCarryforwardSeed: undefined });
    // q=1 cap with seed augments by Σ seed = 45_000.
    const seedSum = seed.reduce((s, h) => s + h, 0);
    expect(withSeed.periods[0].stepTrace.seniorExpensesCapCarryforwardSum).toBeCloseTo(seedSum, 2);
    expect(withoutSeed.periods[0].stepTrace.seniorExpensesCapCarryforwardSum).toBe(0);
    expect(
      withSeed.periods[0].stepTrace.seniorExpensesCapAmount -
        withoutSeed.periods[0].stepTrace.seniorExpensesCapAmount,
    ).toBeCloseTo(seedSum, 2);
  });

  it("over-cap fees every period: no headroom accumulates, carryforward inert", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    const stress = {
      ...baseInputs,
      seniorExpensesCapBps: 5,
      seniorExpensesCapAbsoluteFloorPerYear: 0,
      trusteeFeeBps: 7, // 7 bps requested vs 5 bps cap → 2 bps overflow each period
      adminFeeBps: 0,
    };
    const w = runProjection({ ...stress, seniorExpensesCapCarryforwardPeriods: 3 });
    const wo = runProjection({ ...stress, seniorExpensesCapCarryforwardPeriods: null });
    for (let q = 0; q < 4; q++) {
      expect(w.periods[q].stepTrace.seniorExpensesCapCarryforwardSum).toBe(0);
      expect(w.periods[q].stepTrace.trusteeOverflowPaid).toBeCloseTo(
        wo.periods[q].stepTrace.trusteeOverflowPaid,
        0,
      );
    }
  });
});

describe("Senior Expenses Cap — VAT inclusion gross-up (PPM proviso (i))", () => {
  it("vatIncluded + vatRatePct=20 grosses up cappedRequested by 20%", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    // Tight cap so the difference between gross-vs-net requested matters.
    const stress = {
      ...baseInputs,
      seniorExpensesCapBps: 3,
      seniorExpensesCapAbsoluteFloorPerYear: 0,
      trusteeFeeBps: 5, // 5 bps net requested
      adminFeeBps: 0,
    };
    const noVat = runProjection({
      ...stress,
      seniorExpensesCapVatIncluded: false,
      seniorExpensesCapVatRatePct: null,
    });
    const withVat = runProjection({
      ...stress,
      seniorExpensesCapVatIncluded: true,
      seniorExpensesCapVatRatePct: 20,
    });
    // Without VAT: requested ≈ 5 bps × beginPar × 91/360, cap = 3 bps × beginPar × 91/360.
    // Overflow ≈ 2 bps × beginPar × 91/360.
    // With VAT (20%): requested grosses up to 5 × 1.2 = 6 bps; cap unchanged.
    // Overflow ≈ 3 bps × beginPar × 91/360. Delta = 1 bps × beginPar × 91/360.
    const beginPar = fixture.resolved.poolSummary.totalPrincipalBalance;
    const expectedDelta = beginPar * (1 / 10000) * (91 / 360);
    const noVatOverflow = noVat.periods[0].stepTrace.trusteeOverflowPaid;
    const withVatOverflow = withVat.periods[0].stepTrace.trusteeOverflowPaid;
    expect(withVatOverflow - noVatOverflow).toBeGreaterThan(expectedDelta * 0.95);
    expect(withVatOverflow - noVatOverflow).toBeLessThan(expectedDelta * 1.05);
  });

  it("admin-only: VAT gross-up applies to admin bucket independently of trustee", () => {
    // Mirrors the trustee-only VAT test with the buckets swapped
    // (trusteeFeeBps: 0, adminFeeBps: 5). Engine code at projection.ts:2982-
    // 2985 multiplies both `trusteeFeeRequested` and `adminFeeRequested` by
    // the same `vatGrossUp` factor — symmetric by construction. A regression
    // that dropped VAT from the admin bucket alone (e.g., conditional gross-
    // up only on trustee) wouldn't be caught by the trustee-only test;
    // bijection-rule coverage requires both bucket paths to be exercised.
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    const stress = {
      ...baseInputs,
      seniorExpensesCapBps: 3,
      seniorExpensesCapAbsoluteFloorPerYear: 0,
      trusteeFeeBps: 0,
      adminFeeBps: 5,
    };
    const noVat = runProjection({
      ...stress,
      seniorExpensesCapVatIncluded: false,
      seniorExpensesCapVatRatePct: null,
    });
    const withVat = runProjection({
      ...stress,
      seniorExpensesCapVatIncluded: true,
      seniorExpensesCapVatRatePct: 20,
    });
    const beginPar = fixture.resolved.poolSummary.totalPrincipalBalance;
    const expectedDelta = beginPar * (1 / 10000) * (91 / 360);
    const noVatOverflow = noVat.periods[0].stepTrace.adminOverflowPaid;
    const withVatOverflow = withVat.periods[0].stepTrace.adminOverflowPaid;
    expect(withVatOverflow - noVatOverflow).toBeGreaterThan(expectedDelta * 0.95);
    expect(withVatOverflow - noVatOverflow).toBeLessThan(expectedDelta * 1.05);
  });
});

describe("Senior Expenses Cap — T=0 dispatch parity with in-period site", () => {
  it("T=0 capBaseMode='CPA' adds initialPrincipalCash + initialUnusedProceedsCash to base", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    const stress = {
      ...baseInputs,
      initialPrincipalCash: 5_000_000,
      initialUnusedProceedsCash: 3_000_000,
      seniorExpensesCapBps: 1,
      seniorExpensesCapAbsoluteFloorPerYear: 0,
    };
    const cpa = runProjection({ ...stress, seniorExpensesCapBaseMode: "CPA" as const });
    const apb = runProjection({ ...stress, seniorExpensesCapBaseMode: "APB" as const });
    // Delta = (5M + 3M) × 1 bps × 0.25 = €200.
    const expectedDelta = 8_000_000 * (1 / 10000) * 0.25;
    expect(
      cpa.initialState.seniorExpensesCapAmountT0 -
        apb.initialState.seniorExpensesCapAmountT0,
    ).toBeCloseTo(expectedDelta, 1);
  });

  it("T=0 vatIncluded + vatRatePct=20 grosses up cappedRequested by 20%", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    const stress = {
      ...baseInputs,
      seniorExpensesCapBps: 3,
      seniorExpensesCapAbsoluteFloorPerYear: 0,
      trusteeFeeBps: 5,
      adminFeeBps: 0,
    };
    const noVat = runProjection({
      ...stress,
      seniorExpensesCapVatIncluded: false,
      seniorExpensesCapVatRatePct: null,
    });
    const withVat = runProjection({
      ...stress,
      seniorExpensesCapVatIncluded: true,
      seniorExpensesCapVatRatePct: 20,
    });
    expect(
      withVat.initialState.seniorExpensesCapRequestedT0 /
        noVat.initialState.seniorExpensesCapRequestedT0,
    ).toBeCloseTo(1.2, 3);
  });
});

describe("C3 — backward compatibility: undefined cap → uncapped behavior", () => {
  it("legacy inputs without seniorExpensesCapBps behave as before (no cap applied)", () => {
    // Simulate a legacy ProjectionInputs that predates C3 by manually constructing
    // inputs without seniorExpensesCapBps (rely on optional field default).
    const legitInputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    // Remove the field to exercise the Infinity-cap path.
    const legacyInputs = { ...legitInputs, seniorExpensesCapBps: undefined };
    const result = runProjection(legacyInputs);
    // No cap = all fees pay uncapped, no overflow generated.
    for (const p of result.periods.slice(0, 4)) {
      expect(p.stepTrace.trusteeOverflowPaid).toBe(0);
      expect(p.stepTrace.adminOverflowPaid).toBe(0);
    }
  });
});

describe("KI-45 marker — carryforward seed is unknown unless supplied", () => {
  it("surfaces unknown historical state and defaults the q=1 seed to zero", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    expect(baseAssumptions.seniorExpensesCapCarryforwardSeedAmount).toBeNull();
    expect(diagnoseCarryforwardSeed(fixture.resolved, baseAssumptions)).toHaveLength(1);

    const baseInputs = buildFromResolved(fixture.resolved, baseAssumptions);
    expect(baseInputs.seniorExpensesCapCarryforwardSeed).toBeUndefined();
    const result = runProjection({
      ...baseInputs,
      seniorExpensesCapCarryforwardPeriods: 3,
    });
    expect(result.periods[0].stepTrace.seniorExpensesCapCarryforwardSum).toBe(0);
  });

  it("diagnoses the carryforward seed against the assumptions actually sent to the engine", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const noCarryforwardAssumptions = {
      ...baseAssumptions,
      seniorExpensesCapCarryforwardPeriods: null,
      seniorExpensesCapCarryforwardSeedAmount: null,
    };

    expect(diagnoseCarryforwardSeed(fixture.resolved, noCarryforwardAssumptions)).toHaveLength(0);
    expect(buildFromResolved(fixture.resolved, noCarryforwardAssumptions).seniorExpensesCapCarryforwardPeriods)
      .toBeNull();
  });

  it("threads a user-supplied aggregate carryforward seed into q=1 cap headroom", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const seededAssumptions = {
      ...baseAssumptions,
      seniorExpensesCapCarryforwardSeedAmount: 360_000,
    };

    expect(diagnoseCarryforwardSeed(fixture.resolved, seededAssumptions)).toHaveLength(0);
    const seededInputs = buildFromResolved(fixture.resolved, seededAssumptions);
    const unseededInputs = buildFromResolved(fixture.resolved, {
      ...baseAssumptions,
      seniorExpensesCapCarryforwardSeedAmount: 0,
    });

    expect(seededInputs.seniorExpensesCapCarryforwardSeed).toEqual([120_000, 120_000, 120_000]);
    expect(unseededInputs.seniorExpensesCapCarryforwardSeed).toBeUndefined();

    const seeded = runProjection(seededInputs);
    const unseeded = runProjection(unseededInputs);
    expect(seeded.periods[0].stepTrace.seniorExpensesCapCarryforwardSum).toBeCloseTo(360_000, 2);
    expect(unseeded.periods[0].stepTrace.seniorExpensesCapCarryforwardSum).toBe(0);
    expect(
      seeded.periods[0].stepTrace.seniorExpensesCapAmount -
        unseeded.periods[0].stepTrace.seniorExpensesCapAmount,
    ).toBeCloseTo(360_000, 2);
    expect(
      seeded.periods[1].stepTrace.seniorExpensesCapCarryforwardSum -
        unseeded.periods[1].stepTrace.seniorExpensesCapCarryforwardSum,
    ).toBeCloseTo(240_000, 2);
  });

  it("uses the supplied seed to move stressed senior expenses from overflow into capped B/C capacity", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const stressedAssumptions = {
      ...baseAssumptions,
      seniorExpensesCapCarryforwardSeedAmount: 100_000,
      seniorExpensesCapBps: 1,
      seniorExpensesCapAbsoluteFloorPerYear: 0,
      trusteeFeeBps: 100,
      adminFeeBps: 0,
      seniorFeePct: 0,
      subFeePct: 0,
      hedgeCostBps: 0,
    };
    const seeded = runProjection(buildFromResolved(fixture.resolved, stressedAssumptions));
    const unseeded = runProjection(buildFromResolved(fixture.resolved, {
      ...stressedAssumptions,
      seniorExpensesCapCarryforwardSeedAmount: 0,
    }));

    expect(
      seeded.periods[0].stepTrace.trusteeFeesPaid -
        unseeded.periods[0].stepTrace.trusteeFeesPaid,
    ).toBeCloseTo(100_000, 2);
    expect(
      unseeded.periods[0].stepTrace.trusteeOverflowPaid -
        seeded.periods[0].stepTrace.trusteeOverflowPaid,
    ).toBeCloseTo(100_000, 2);
  });

  it("blocks invalid carryforward seed amounts before they reach the engine FIFO", () => {
    const baseAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    expect(() => buildFromResolved(fixture.resolved, {
      ...baseAssumptions,
      seniorExpensesCapCarryforwardPeriods: Number.POSITIVE_INFINITY,
    })).toThrow(/seniorExpensesCapCarryforwardPeriods/);
    expect(() => buildFromResolved(fixture.resolved, {
      ...baseAssumptions,
      seniorExpensesCapCarryforwardPeriods: 1.5,
    })).toThrow(/seniorExpensesCapCarryforwardPeriods/);
    expect(() => buildFromResolved(fixture.resolved, {
      ...baseAssumptions,
      seniorExpensesCapCarryforwardSeedAmount: Number.POSITIVE_INFINITY,
    })).toThrow(/seniorExpensesCapCarryforwardSeedAmount/);
    expect(() => buildFromResolved(fixture.resolved, {
      ...baseAssumptions,
      seniorExpensesCapCarryforwardSeedAmount: -1,
    })).toThrow(/seniorExpensesCapCarryforwardSeedAmount/);
    expect(() => buildFromResolved(fixture.resolved, {
      ...baseAssumptions,
      seniorExpensesCapCarryforwardPeriods: null,
      seniorExpensesCapCarryforwardSeedAmount: 1,
    })).toThrow(/seniorExpensesCapCarryforwardSeedAmount/);
  });
});
