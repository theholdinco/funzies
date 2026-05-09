/**
 * Asset-side per-loan EURIBOR-floor accrual.
 *
 * Invariant: each floating loan accrues at `max(loan.floorRate ??
 * baseRateFloorPct, baseRatePct) + spread/100`. The engine reads the
 * per-position floor at origination and binds it independently on each
 * loan. Pre-fix engine ignored per-loan floors and applied the deal-level
 * `baseRateFloorPct` uniformly — wrong on every position whose
 * origination floor exceeded the deal default.
 *
 * **Marker convention.** These tests are synthetic low-rate fixtures —
 * the magnitude is conditional on a market state Euro XV doesn't
 * currently express (3M-EURIBOR ≈ 3.5% as of 2026; no floor binds today).
 * Absence of a Euro XV diff is correct, not a coverage gap. The
 * `failsWithMagnitude` invariant lives in the per-loan accrual: the
 * post-fix value diverges from the pre-fix value by `(loan.floorRate -
 * baseRateFloorPct) × parBalance × dayFrac` on every floating loan whose
 * origination floor exceeds the deal floor when EURIBOR sits below it.
 *
 * Expected values are computed from first principles (par × rate ×
 * dayFrac) — never by re-running the engine on a fixture.
 */
import { describe, it, expect } from "vitest";
import { runProjection, addQuarters, dayCountFraction, LoanInput } from "../projection";
import { makeInputs, noDefaults } from "./test-helpers";

// makeInputs default currentDate = 2026-03-09. Period 1 ends 2026-06-09 = 92 days.
const PERIOD_START = "2026-03-09";
const PERIOD_END = "2026-06-09";
const FRAC_360 = dayCountFraction("actual_360", PERIOD_START, PERIOD_END);

describe("asset-side per-loan EURIBOR floor", () => {
  it("per-loan floor binds when EURIBOR sits below it", () => {
    // Loan with 0.5% origination floor; EURIBOR at 0.3% sits below.
    // Expected: accrues at max(0.5, 0.3) + 3.5 = 4.0% (NOT 0.3 + 3.5 = 3.8%).
    const loan: LoanInput = {
      parBalance: 10_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 350,
      floorRate: 0.5, // PERCENT (0.5 = 50bp)
    };

    const result = runProjection(
      makeInputs({
        loans: [loan],
        initialPar: 10_000_000,
        baseRatePct: 0.3,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    // First-principles: par × (max(0.5, 0.3) + 3.5)% × dayFrac
    //                 = par × 4.0% × dayFrac
    const expected = 10_000_000 * 0.04 * FRAC_360;
    expect(result.periods[0].interestCollected).toBeCloseTo(expected, 0);

    // Pre-fix engine would apply baseRateFloorPct=0 uniformly → accrue at
    //   par × (max(0, 0.3) + 3.5)% × dayFrac = par × 3.8% × dayFrac
    // Magnitude of the bug = par × 0.2% × dayFrac per period on this loan.
    const preFixWrong = 10_000_000 * 0.038 * FRAC_360;
    expect(expected).not.toBeCloseTo(preFixWrong, 0);
  });

  it("EURIBOR binds when it exceeds the per-loan floor", () => {
    // Same loan with 0.5% floor; EURIBOR at 2.0% dominates.
    // Expected: accrues at max(0.5, 2.0) + 3.5 = 5.5%.
    const loan: LoanInput = {
      parBalance: 10_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 350,
      floorRate: 0.5,
    };

    const result = runProjection(
      makeInputs({
        loans: [loan],
        initialPar: 10_000_000,
        baseRatePct: 2.0,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    const expected = 10_000_000 * 0.055 * FRAC_360;
    expect(result.periods[0].interestCollected).toBeCloseTo(expected, 0);
  });

  it("mixed-floor portfolio accrues each loan at its own floor independently", () => {
    // Three positions, three different origination floors. EURIBOR at
    // 0.4% binds floors below 0.4 and is dominated by floors above 0.4.
    const lowFloor: LoanInput = {
      parBalance: 50_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 300,
      floorRate: 0.0, // EURIBOR binds (max(0, 0.4) = 0.4)
    };
    const midFloor: LoanInput = {
      parBalance: 30_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 425,
      floorRate: 0.5, // floor binds (max(0.5, 0.4) = 0.5)
    };
    const highFloor: LoanInput = {
      parBalance: 20_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 525,
      floorRate: 1.0, // floor binds (max(1.0, 0.4) = 1.0)
    };

    const result = runProjection(
      makeInputs({
        loans: [lowFloor, midFloor, highFloor],
        initialPar: 100_000_000,
        baseRatePct: 0.4,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    const expected =
      50_000_000 * (0.4 + 3.0) / 100 * FRAC_360 +  // low: EURIBOR binds
      30_000_000 * (0.5 + 4.25) / 100 * FRAC_360 + // mid: floor binds
      20_000_000 * (1.0 + 5.25) / 100 * FRAC_360;  // high: floor binds

    expect(result.periods[0].interestCollected).toBeCloseTo(expected, 0);
  });

  it("loan without floorRate falls back to deal-level baseRateFloorPct (back-compat)", () => {
    // Legacy fixture: loan does NOT set floorRate. Engine falls back to
    // baseRateFloorPct=0.5; EURIBOR=0.3 sits below → deal floor binds.
    const legacy: LoanInput = {
      parBalance: 10_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 375,
      // floorRate deliberately omitted
    };

    const result = runProjection(
      makeInputs({
        loans: [legacy],
        initialPar: 10_000_000,
        baseRatePct: 0.3,
        baseRateFloorPct: 0.5,
        ...noDefaults,
        cprPct: 0,
      })
    );

    // Expected: par × (max(0.5, 0.3) + 3.75)% × dayFrac = par × 4.25% × dayFrac
    const expected = 10_000_000 * 0.0425 * FRAC_360;
    expect(result.periods[0].interestCollected).toBeCloseTo(expected, 0);
  });
});
