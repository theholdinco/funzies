import { describe, it, expect } from "vitest";
import { runProjection, addQuarters, dayCountFraction } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

// B3: makeInputs uses currentDate=2026-03-09 → period 1 ends 2026-06-09.
// That window is 92 days under Actual/360. Interest/fee formulas that used to
// be hand-coded as `par × rate / 4` now need `par × rate × dayFrac` where
// dayFrac = dayCountFraction("actual_360", "2026-03-09", "2026-06-09").
const Q1_ACTUAL = dayCountFraction("actual_360", "2026-03-09", "2026-06-09");
// Q2 (same helper's next period): 2026-06-09 → 2026-09-09 = 92 days.
const Q2_ACTUAL = dayCountFraction("actual_360", "2026-06-09", "2026-09-09");

describe("Fixed-rate loan projection", () => {
  it("earns flat coupon regardless of base rate", () => {
    const loan = {
      parBalance: 10_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isFixedRate: true,
      fixedCouponPct: 8.0,
    };

    const low = runProjection(
      makeInputs({
        loans: [loan],
        initialPar: 10_000_000,
        baseRatePct: 2.5,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );

    const high = runProjection(
      makeInputs({
        loans: [loan],
        initialPar: 10_000_000,
        baseRatePct: 5.0,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );

    const expected = 10_000_000 * 8 / 100 * Q1_ACTUAL; // 92 days @ Actual/360
    expect(low.periods[0].interestCollected).toBeCloseTo(expected, 0);
    expect(high.periods[0].interestCollected).toBeCloseTo(expected, 0);
  });

  it("fixed-rate loan with explicit dayCountConvention='30e_360' accrues at 30E/360", () => {
    // Per-loan accrual reads loan.dayCountConvention. On the 92-day
    // Mar 9 → Jun 9 window, 30E/360 collapses to 90/360 (months capped
    // at 30) while Actual/360 reads 92/360 — visible delta of (92-90)/360
    // = ~0.56% of one period's interest. Existing tests in this file
    // rely on the undefined → Actual/360 fallback; if that path is ever
    // tightened (e.g. requiring every loan to declare a convention),
    // those tests need updating.
    const FRAC_30E = dayCountFraction("30e_360", "2026-03-09", "2026-06-09");
    expect(FRAC_30E).toBeCloseTo(90 / 360, 10);

    const loan = {
      parBalance: 10_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isFixedRate: true,
      fixedCouponPct: 8.0,
      dayCountConvention: "30e_360" as const,
    };

    const result = runProjection(
      makeInputs({
        loans: [loan],
        initialPar: 10_000_000,
        baseRatePct: 2.5,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );

    const expected = 10_000_000 * 8 / 100 * FRAC_30E;
    expect(result.periods[0].interestCollected).toBeCloseTo(expected, 0);
  });

  it("mixed portfolio: floating + fixed", () => {
    const floating = {
      parBalance: 9_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 375,
    };
    const fixed = {
      parBalance: 1_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isFixedRate: true,
      fixedCouponPct: 8.0,
    };

    const result = runProjection(
      makeInputs({
        loans: [floating, fixed],
        initialPar: 10_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );

    // 92-day Q1 window (Actual/360) — see Q1_ACTUAL above
    const floatingInt = 9_000_000 * (2.5 + 3.75) / 100 * Q1_ACTUAL;
    const fixedInt = 1_000_000 * 8.0 / 100 * Q1_ACTUAL;
    expect(result.periods[0].interestCollected).toBeCloseTo(floatingInt + fixedInt, 0);
  });
});

describe("DDTL projection", () => {
  it("earns no interest before draw quarter", () => {
    const ddtl = {
      parBalance: 500_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isDelayedDraw: true,
      ddtlSpreadBps: 350,
      drawQuarter: 4,
    };

    const result = runProjection(
      makeInputs({
        loans: [ddtl],
        initialPar: 500_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );

    expect(result.periods[0].interestCollected).toBeCloseTo(0, 2);
    expect(result.periods[1].interestCollected).toBeCloseTo(0, 2);
    expect(result.periods[2].interestCollected).toBeCloseTo(0, 2);
  });

  it("earns parent spread after draw", () => {
    const ddtl = {
      parBalance: 500_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isDelayedDraw: true,
      ddtlSpreadBps: 350,
      drawQuarter: 2,
    };

    const result = runProjection(
      makeInputs({
        loans: [ddtl],
        initialPar: 500_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );

    // Q1: not drawn yet → 0
    expect(result.periods[0].interestCollected).toBeCloseTo(0, 2);
    // Q2: drawn at beginning of Q2 → 500K × (2.5 + 3.5)% × 92/360
    expect(result.periods[1].interestCollected).toBeCloseTo(500_000 * (2.5 + 3.5) / 100 * Q2_ACTUAL, 0);
  });

  it("never_draw (drawQuarter <= 0) removes par at Q1", () => {
    const normal = {
      parBalance: 10_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 375,
    };
    const neverDraw = {
      parBalance: 500_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isDelayedDraw: true,
      ddtlSpreadBps: 350,
      drawQuarter: 0,
    };

    const result = runProjection(
      makeInputs({
        loans: [normal, neverDraw],
        initialPar: 10_500_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );

    // Only the 10M loan's interest should appear
    expect(result.periods[0].beginningPar).toBeCloseTo(10_000_000, 0);
    const expectedInterest = 10_000_000 * (2.5 + 3.75) / 100 * Q1_ACTUAL;
    expect(result.periods[0].interestCollected).toBeCloseTo(expectedInterest, 0);
  });

  it("partial draw funds only ddtlDrawPercent of par", () => {
    const ddtl = {
      parBalance: 500_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isDelayedDraw: true,
      ddtlSpreadBps: 350,
      drawQuarter: 2,
    };

    const result = runProjection(
      makeInputs({
        loans: [ddtl],
        initialPar: 500_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
        ddtlDrawPercent: 60,
      })
    );

    // Q2: 60% of 500K = 300K funded. Interest = 300K × (2.5 + 3.5)% × 92/360
    expect(result.periods[1].interestCollected).toBeCloseTo(300_000 * (2.5 + 3.5) / 100 * Q2_ACTUAL, 0);
  });

  it("DDTL not subject to defaults/prepay before draw", () => {
    const ddtl = {
      parBalance: 500_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "CCC",
      spreadBps: 0,
      isDelayedDraw: true,
      ddtlSpreadBps: 350,
      drawQuarter: 4,
    };

    const result = runProjection(
      makeInputs({
        loans: [ddtl],
        initialPar: 500_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(10), // 10% CDR — aggressive
        cprPct: 20,
      })
    );

    // Q1-Q3: no defaults and no prepayments (DDTL is unfunded)
    for (let i = 0; i < 3; i++) {
      expect(result.periods[i].defaults).toBeCloseTo(0, 2);
      expect(result.periods[i].prepayments).toBeCloseTo(0, 2);
    }
  });

  it("OC deduction excludes DDTL unfunded par", () => {
    const normal = {
      parBalance: 10_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 375,
    };
    const ddtl = {
      parBalance: 500_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isDelayedDraw: true,
      ddtlSpreadBps: 350,
      drawQuarter: 8,
    };

    const withDdtl = runProjection(
      makeInputs({
        loans: [normal, ddtl],
        initialPar: 10_500_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );

    const withoutDdtl = runProjection(
      makeInputs({
        loans: [normal],
        initialPar: 10_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );

    // OC tests should be similar — the DDTL unfunded par should not inflate the numerator
    const ocWithDdtl = withDdtl.periods[0].ocTests[0]?.actual;
    const ocWithout = withoutDdtl.periods[0].ocTests[0]?.actual;
    expect(Math.abs(ocWithDdtl - ocWithout)).toBeLessThan(2);
  });

  it("ki: KI-46-ddtlPostDrawOcInflation — DDTL draw mid-projection inflates forward OC numerator (frozen impliedOcAdjustment + bucket-move drift)", () => {
    // Marker test pinning the current (wrong) behavior: when a DDTL
    // draws mid-projection AND `impliedOcAdjustment > 0` (calibrated at
    // T=0 with the unfunded DDTL strip), the engine's forward OC
    // numerator over-states because (a) endingPar grows by drawn par,
    // (b) currentDdtlUnfundedPar shrinks by drawn par (so the explicit
    // OC-numerator subtraction shrinks by the same amount), and (c)
    // impliedOcAdjustment is frozen at T=0 calibration so doesn't
    // re-absorb the bucket move. Net inflation: ~2× drawn par per
    // period from the draw quarter forward (the upper-bound case where
    // AdjCPA is invariant under DDTL bucket moves; lower-bound is 1×
    // drawn par if AdjCPA grows with funded par per the engine's "OC
    // excludes unfunded" convention). Closure of KI-46 flips the
    // assertion to the corrected post-draw OC.
    // Pool scaled above the default tranches' aggregate debt (€80M) so
    // OC tests stay live forward (a 13% OC ratio trips an early
    // Event-of-Default state where ocTests are no longer emitted).
    const drawnPar = 10_000_000;
    const normalLoan = {
      parBalance: 200_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 375,
    };
    const ddtl = {
      parBalance: drawnPar,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isDelayedDraw: true,
      ddtlSpreadBps: 350,
      drawQuarter: 4,
    };
    const result = runProjection(
      makeInputs({
        loans: [normalLoan, ddtl],
        initialPar: 210_000_000,
        impliedOcAdjustment: 1_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
      })
    );
    // Pre-draw (q=3, index 2): DDTL still unfunded (drawQuarter is 4).
    // Post-draw (q=5, index 4): DDTL is funded, currentDdtlUnfundedPar = 0.
    const ocPreDraw = result.periods[2].ocTests[0]?.actual;
    const ocPostDraw = result.periods[4].ocTests[0]?.actual;
    expect(ocPreDraw).toBeDefined();
    expect(ocPostDraw).toBeDefined();
    // The bucket-move drift inflates the forward OC numerator by ~2× drawn par
    // when AdjCPA is invariant under DDTL bucket moves (PPM convention)
    // or by ~1× drawn par if the engine's "OC excludes unfunded" convention
    // is the intended invariant. Either way the jump at the draw quarter is
    // material and pins the bug magnitude until KI-46 closes. With Class A
    // debt = €65M, a 10M numerator over-statement = ~15 OC points; a 20M
    // = ~30 points. Asserting > 10 captures the lower bound.
    const ocJump = ocPostDraw! - ocPreDraw!;
    expect(ocJump).toBeGreaterThan(10);
  });
});
