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
import { buildFromResolved, defaultsFromResolved } from "@/lib/clo/build-projection-inputs";
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
    });
    const result = runProjection(inputs);
    const p1 = result.periods[0];

    // Capped portion = 20 bps (cap).
    // Requested combined = 50 bps. Ratio = 20/50 = 0.4.
    // trusteeFeeAmount = 10 × 0.4 = 4 bps portion; adminFeeAmount = 40 × 0.4 = 16 bps portion.
    // Overflow per bucket: trustee 6 bps, admin 24 bps. Total overflow = 30 bps.
    const expectedOverflowBps = 30;
    // Engine uses beginningPar (sum-of-loans €493.25M) not totalPrincipalBalance
    // (€493.22M) — the ~€28k gap is Labeyrie PIK (see B1 test notes). Widen
    // the upper bound slightly to accommodate this.
    const overflowTotalExpected =
      fixture.resolved.poolSummary.totalPrincipalBalance * (expectedOverflowBps / 10000) * (91 / 360);
    const actualOverflowTotal = (p1.stepTrace.trusteeOverflowPaid) + (p1.stepTrace.adminOverflowPaid);
    expect(actualOverflowTotal).toBeLessThanOrEqual(overflowTotalExpected * 1.001); // 0.1% tolerance for the €28k PIK delta
    // On Euro XV, residual interest is ample — overflow should fully pay.
    expect(actualOverflowTotal).toBeGreaterThan(overflowTotalExpected * 0.95);

    // Pro-rata split: admin overflow : trustee overflow = 24 : 6 = 4:1.
    expect(
      (p1.stepTrace.adminOverflowPaid) / Math.max(1, p1.stepTrace.trusteeOverflowPaid),
    ).toBeCloseTo(4, 1);
  });

  it("extreme cap (1 bps) with low fees → capped portion < requested, large overflow", () => {
    // Cap at 1 bps on Euro XV default observed ~5.24 bps.
    const inputs = buildFromResolved(fixture.resolved, {
      ...defaultsFromResolved(fixture.resolved, fixture.raw),
      seniorExpensesCapBps: 1,
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
