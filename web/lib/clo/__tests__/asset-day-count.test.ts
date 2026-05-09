/**
 * Asset-side per-loan day-count accrual.
 *
 * Invariant: each loan accrues interest at its documented day-count
 * convention. The engine reads `loan.dayCountConvention` and consults
 * `dayCountFraction` per loan; loans without an explicit convention
 * (legacy fixtures, reinvestment-synthesized loans) fall back to
 * Actual/360 (Euro market default for floating).
 *
 * Expected values below are computed from first principles
 * (Σ par × rate × per-loan-dayFrac) — never by re-running the engine
 * on a fixture, which would be circular.
 */
import { describe, it, expect } from "vitest";
import { runProjection, addQuarters, dayCountFraction, LoanInput } from "../projection";
import { makeInputs, noDefaults } from "./test-helpers";

// makeInputs default currentDate = 2026-03-09. Period 1 ends 2026-06-09 = 92 days.
const PERIOD_START = "2026-03-09";
const PERIOD_END = "2026-06-09";
const FRAC_360 = dayCountFraction("actual_360", PERIOD_START, PERIOD_END);
const FRAC_30E = dayCountFraction("30e_360", PERIOD_START, PERIOD_END);
const FRAC_365 = dayCountFraction("actual_365", PERIOD_START, PERIOD_END);

describe("asset-side per-loan day-count convention", () => {
  it("fixed-rate loan with 30E/360 accrues at 30E/360 (NOT Actual/360)", () => {
    const fixed30E: LoanInput = {
      parBalance: 10_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 0,
      isFixedRate: true,
      fixedCouponPct: 8.0,
      dayCountConvention: "30e_360",
    };

    const result = runProjection(
      makeInputs({
        loans: [fixed30E],
        initialPar: 10_000_000,
        baseRatePct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    // First-principles: par × coupon × 30E/360 fraction.
    const expected = 10_000_000 * 0.08 * FRAC_30E;
    // Sanity: 30E/360 should be 90/360 = 0.25 on this 92-day window
    // (Mar 9 → Jun 9: under 30E/360, all months capped at 30, so
    // 0×360 + 3×30 + 0 = 90 days). Diverges from FRAC_360 = 92/360.
    expect(FRAC_30E).toBeCloseTo(90 / 360, 10);
    expect(FRAC_360).toBeCloseTo(92 / 360, 10);
    expect(result.periods[0].interestCollected).toBeCloseTo(expected, 0);
  });

  it("floating loan with Actual/365 accrues at Actual/365 (NOT Actual/360)", () => {
    const floating365: LoanInput = {
      parBalance: 10_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 375,
      dayCountConvention: "actual_365",
    };

    const result = runProjection(
      makeInputs({
        loans: [floating365],
        initialPar: 10_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    const allInRate = (2.5 + 3.75) / 100;
    const expected = 10_000_000 * allInRate * FRAC_365;
    expect(result.periods[0].interestCollected).toBeCloseTo(expected, 0);
  });

  it("mixed-convention portfolio sums per-loan contributions independently", () => {
    // Synthetic Euro-XV-shape sketch: large floating Actual/360 slice +
    // smaller fixed 30E/360 slice + a handful of floating Actual/365.
    const a360: LoanInput = {
      parBalance: 100_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 350,
      dayCountConvention: "actual_360",
    };
    const fixed30E: LoanInput = {
      parBalance: 8_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 0,
      isFixedRate: true,
      fixedCouponPct: 7.0,
      dayCountConvention: "30e_360",
    };
    const float365: LoanInput = {
      parBalance: 2_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 425,
      dayCountConvention: "actual_365",
    };

    const result = runProjection(
      makeInputs({
        loans: [a360, fixed30E, float365],
        initialPar: 110_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    const expected =
      100_000_000 * (2.5 + 3.5) / 100 * FRAC_360 +
      8_000_000 * 0.07 * FRAC_30E +
      2_000_000 * (2.5 + 4.25) / 100 * FRAC_365;

    expect(result.periods[0].interestCollected).toBeCloseTo(expected, 0);
  });

  it("legacy fixture without dayCountConvention uses Actual/360 (back-compat)", () => {
    // Synthetic loan that does NOT set dayCountConvention. The engine
    // falls back to Actual/360 for back-compat with fixtures predating
    // the per-loan convention plumbing.
    const legacyFloat: LoanInput = {
      parBalance: 10_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 375,
      // dayCountConvention deliberately omitted
    };

    const result = runProjection(
      makeInputs({
        loans: [legacyFloat],
        initialPar: 10_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    const expected = 10_000_000 * (2.5 + 3.75) / 100 * FRAC_360;
    expect(result.periods[0].interestCollected).toBeCloseTo(expected, 0);
  });
});
