import { describe, it, expect } from "vitest";
import { runProjection, addQuarters, dayCountFraction } from "../projection";
import { makeInputs, uniformRates, noDefaults } from "./test-helpers";

// B3: makeInputs uses currentDate=2026-03-09 → period 1 ends 2026-06-09.
// That window is 92 days under Actual/360. Interest/fee formulas that used to
// be hand-coded as `par × rate / 4` now need `par × rate × dayFrac` where
// dayFrac = dayCountFraction("actual_360", "2026-03-09", "2026-06-09").
const Q1_ACTUAL = dayCountFraction("actual_360", "2026-03-09", "2026-06-09");
// Q2 (same helper's next period): 2026-06-09 → 2026-09-09 = 92 days.
const Q2_ACTUAL = dayCountFraction("actual_360", "2026-06-09", "2026-09-09");
// Q3: 2026-09-09 → 2026-12-09 = 91 days.
const Q3_ACTUAL = dayCountFraction("actual_360", "2026-09-09", "2026-12-09");
// KI-36: drawQuarter remains a user-facing quarter assumption, but the engine
// fires it on the monthly internal clock at the first month of that projected
// quarter.
const STUB_DRAW_Q2_START_ACTUAL = dayCountFraction("actual_360", "2026-06-09", "2026-07-09");

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
        ...noDefaults,
        cprPct: 0,
      })
    );

    const high = runProjection(
      makeInputs({
        loans: [loan],
        initialPar: 10_000_000,
        baseRatePct: 5.0,
        ...noDefaults,
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
        ...noDefaults,
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
        ...noDefaults,
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
  // Convention: an entirely-un-drawn DDTL has parBalance=0 and the future
  // commitment on `undrawnCommitment`. Funded leg accrues interest on
  // `parBalance` (drawn par); un-drawn notional is captured separately on
  // the OC subtractor (Σ undrawnCommitment) and decremented as the engine's
  // draw event fires — partial draws preserve the (1 − ddtlDrawPercent)
  // residual rather than discard it.

  it("earns no interest before draw quarter", () => {
    const ddtl = {
      parBalance: 0,
      undrawnCommitment: 500_000,
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
        ...noDefaults,
        cprPct: 0,
      })
    );

    expect(result.periods[0].interestCollected).toBeCloseTo(0, 2);
    expect(result.periods[1].interestCollected).toBeCloseTo(0, 2);
    expect(result.periods[2].interestCollected).toBeCloseTo(0, 2);
  });

  it("earns parent spread after draw", () => {
    const ddtl = {
      parBalance: 0,
      undrawnCommitment: 500_000,
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
        ...noDefaults,
        cprPct: 0,
      })
    );

    // Q1: not drawn yet → 0
    expect(result.periods[0].interestCollected).toBeCloseTo(0, 2);
    // drawQuarter=2 fires at the start of projected quarter 2, so period 2
    // earns the full Jun 9 → Sep 9 quarter.
    expect(result.periods[1].interestCollected).toBeCloseTo(
      500_000 * (2.5 + 3.5) / 100 * Q2_ACTUAL,
      0,
    );
  });

  it("drawQuarter converts to an internal draw month under a stub first period", () => {
    const ddtl = {
      parBalance: 0,
      undrawnCommitment: 500_000,
      maturityDate: "2031-04-09",
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
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-09",
        ...noDefaults,
        cprPct: 0,
      })
    );

    expect(result.periods[0].date).toBe("2026-04-09");
    expect(result.periods[0].interestCollected).toBeCloseTo(0, 2);
    expect(result.periods[1].date).toBe("2026-07-09");
    expect(result.periods[1].beginningPar).toBeCloseTo(0, 0);
    expect(result.periods[1].interestCollected).toBeCloseTo(
      500_000 * (2.5 + 3.5) / 100 * STUB_DRAW_Q2_START_ACTUAL,
      0,
    );
    expect(result.periods[2].date).toBe("2026-10-09");
    expect(result.periods[2].beginningPar).toBeCloseTo(500_000, 0);
    expect(result.periods[2].interestCollected).toBeCloseTo(
      500_000 * (2.5 + 3.5) / 100 * dayCountFraction("actual_360", "2026-07-09", "2026-10-09"),
      0,
    );
  });

  it("never_draw (drawQuarter <= 0) removes par at Q1", () => {
    const normal = {
      parBalance: 10_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 375,
    };
    const neverDraw = {
      parBalance: 0,
      undrawnCommitment: 500_000,
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
        ...noDefaults,
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
      parBalance: 0,
      undrawnCommitment: 500_000,
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
        ...noDefaults,
        cprPct: 0,
        ddtlDrawPercent: 60,
      })
    );

    // Q2: 60% of 500K = 300K funded at the start of projected quarter 2.
    expect(result.periods[1].interestCollected).toBeCloseTo(
      300_000 * (2.5 + 3.5) / 100 * Q2_ACTUAL,
      0,
    );
  });

  it("DDTL not subject to defaults/prepay before draw", () => {
    const ddtl = {
      parBalance: 0,
      undrawnCommitment: 500_000,
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
      parBalance: 0,
      undrawnCommitment: 500_000,
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
        ...noDefaults,
        cprPct: 0,
      })
    );

    const withoutDdtl = runProjection(
      makeInputs({
        loans: [normal],
        initialPar: 10_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
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
    // Convention: un-drawn notional lives on `undrawnCommitment`, not
    // on `parBalance`. `parBalance` is the currently-drawn balance;
    // `undrawnCommitment` is the un-drawn notional. The engine
    // excludes un-drawn portions from `beginningPar` (their
    // parBalance=0 → already excluded) but counts them via the
    // OC-numerator subtractor (Σ undrawnCommitment). The bug
    // magnitude pinned below (frozen `impliedOcAdjustment` +
    // bucket-move drift across the draw event) is convention-
    // independent — it depends only on the OC-numerator dynamics.
    const ddtl = {
      parBalance: 0,
      undrawnCommitment: drawnPar,
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
        ...noDefaults,
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

describe("DDTL convention: facility tag vs. unfunded state", () => {
  // The `isDelayedDraw` flag is a facility-type tag (DDTL), not a quantitative
  // state. The currently-unfunded amount lives on `undrawnCommitment`. A
  // fully-drawn DDTL has parBalance > 0 + undrawnCommitment === 0 and must
  // accrue interest like a regular loan; a partial draw must preserve the
  // (1 − ddtlDrawPercent) residual on `undrawnCommitment` rather than
  // silently overwrite it. Both shapes were latent failure modes pre-fix.

  it("fully-drawn DDTL accrues interest from Q1 (Eleda-shape)", () => {
    // Eleda Management AB on Ares Euro XV: a DDTL FACILITY (isDelayedDraw=true
    // tags it for the Revolving / DDTL concentration test) that is fully
    // drawn (parBalance = principalFundedBalance > 0, unfundedCommitment = 0).
    // Pre-fix, the engine conflated facility-type with currently-unfunded
    // state — a fully-drawn DDTL was excluded from beginningPar, the interest
    // accrual loop, defaults, prepayments, and EoD MV × PB. Magnitude on Euro
    // XV: ~€5,591/quarter of dropped interest revenue (€363,636 × 6%/yr ×
    // 92/360) plus knock-on understatement of management fee base — silent.
    const drawnDdtl = {
      parBalance: 500_000,        // currently funded balance
      undrawnCommitment: 0,       // nothing un-drawn — facility fully tapped
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 350,             // funded leg accrues at this spread
      isDelayedDraw: true,        // facility-type tag survives the draw
      drawQuarter: 4,             // distant; the no-op draw event preserves state
    };

    const result = runProjection(
      makeInputs({
        loans: [drawnDdtl],
        initialPar: 500_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    // Q1: fully drawn — interest accrues on the full €500K from period 1.
    expect(result.periods[0].beginningPar).toBeCloseTo(500_000, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(
      500_000 * (2.5 + 3.5) / 100 * Q1_ACTUAL,
      0,
    );
    // No un-drawn commitment exposed via the OC subtractor.
    expect(result.periods[0].endingUndrawnCommitment).toBeCloseTo(0, 0);
  });

  it("partial draw preserves the un-drawn portion", () => {
    // Pre-fix the draw event at projection.ts overwrote `loan.survivingPar =
    // drawn` and silently discarded the (1 − ddtlDrawPercent) residual. The
    // un-drawn residual must (a) remain on the OC subtractor (per PPM
    // Adjusted Collateral Principal Amount), (b) survive across periods until
    // a subsequent draw or commitment-end disposition.
    const ddtl = {
      parBalance: 0,                  // not yet drawn
      undrawnCommitment: 500_000,     // future commitment
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
        ...noDefaults,
        cprPct: 0,
        ddtlDrawPercent: 60,
      })
    );

    // Q1 — pre-draw: full €500K un-drawn, no interest.
    expect(result.periods[0].endingUndrawnCommitment).toBeCloseTo(500_000, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(0, 2);

    // Q2 — partial draw fires at the start of projected quarter 2:
    // 60% × 500K = 300K funded for the quarter; the 40% × 500K =
    // 200K residual is PRESERVED, not discarded.
    expect(result.periods[1].endingUndrawnCommitment).toBeCloseTo(200_000, 0);
    expect(result.periods[1].interestCollected).toBeCloseTo(
      300_000 * (2.5 + 3.5) / 100 * Q2_ACTUAL,
      0,
    );

    // Q3 — residual carried forward unchanged; funded portion continues to
    // accrue at the parent spread on the post-draw €300K balance. Pinning
    // the post-draw interest assertion catches a regression where the
    // engine forgets to accrue on the post-draw funded balance (e.g. a
    // future refactor that erroneously zeroes survivingPar between periods
    // or doesn't roll the per-loan beginning par forward).
    expect(result.periods[2].endingUndrawnCommitment).toBeCloseTo(200_000, 0);
    expect(result.periods[2].interestCollected).toBeCloseTo(
      300_000 * (2.5 + 3.5) / 100 * Q3_ACTUAL,
      0,
    );
  });

  it("never-draw with surviving funded leg preserves the funded portion", () => {
    // Splice path branch coverage at projection.ts:1909-1918: a partially-
    // drawn DDTL where the user opts to model the un-drawn residual as
    // never-drawing (drawQuarter <= 0). The funded leg (parBalance > 0)
    // is preserved; only the un-drawn residual zeroes out so the OC
    // subtractor doesn't carry phantom unfunded forever.
    const partiallyDrawnNeverDraw = {
      parBalance: 300_000,        // already drawn
      undrawnCommitment: 200_000, // un-drawn residual that never funds
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 350,             // funded leg accrues at this spread
      isDelayedDraw: true,
      drawQuarter: 0,             // never_draw signal
    };

    const result = runProjection(
      makeInputs({
        loans: [partiallyDrawnNeverDraw],
        initialPar: 300_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    // Funded €300K leg accrues normally from Q1 onward at base + spread.
    expect(result.periods[0].beginningPar).toBeCloseTo(300_000, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(
      300_000 * (2.5 + 3.5) / 100 * Q1_ACTUAL,
      0,
    );
    // Un-drawn residual zeroed by the splice — no longer in OC subtractor.
    // The pre-fix splice would have removed the loan entirely (loanStates
    // .splice), dropping the funded leg too. The splice now branches:
    // survivingPar > 0 → zero undrawnCommitment, keep loan.
    expect(result.periods[0].endingUndrawnCommitment).toBeCloseTo(0, 0);
  });

  it("multi-DDTL fixture: fully-drawn + un-drawn coexist correctly", () => {
    // Coverage gap closure: prior tests exercised single-DDTL shapes in
    // isolation. A real deal carries multiple DDTLs in different states.
    // This fixture pairs (a) Eleda-shape (fully drawn at T=0, accrues
    // immediately) with (b) a future-draw DDTL (un-drawn at T=0, funds
    // at q=2). Asserts (i) endingUndrawnCommitment correctly aggregates
    // across loans, (ii) Q1 interest reflects only the funded loan, (iii)
    // Q2 interest reflects both after draw, (iv) the un-drawn residual
    // tracking doesn't cross-contaminate.
    const fullyDrawn = {
      parBalance: 500_000,
      undrawnCommitment: 0,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 350,
      isDelayedDraw: true,
      drawQuarter: 4,             // distant; would-be no-op draw
    };
    const futureDraw = {
      parBalance: 0,
      undrawnCommitment: 1_000_000,
      maturityDate: addQuarters("2026-03-09", 20),
      ratingBucket: "B",
      spreadBps: 0,
      isDelayedDraw: true,
      ddtlSpreadBps: 400,
      drawQuarter: 2,
    };

    const result = runProjection(
      makeInputs({
        loans: [fullyDrawn, futureDraw],
        initialPar: 500_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
        ddtlDrawPercent: 100,
      })
    );

    // Q1: only the fully-drawn DDTL accrues. Un-drawn DDTL contributes
    // €1M to endingUndrawnCommitment (pre-draw, full notional).
    expect(result.periods[0].beginningPar).toBeCloseTo(500_000, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(
      500_000 * (2.5 + 3.5) / 100 * Q1_ACTUAL,
      0,
    );
    expect(result.periods[0].endingUndrawnCommitment).toBeCloseTo(1_000_000, 0);

    // Q2: future-draw DDTL fires at the start of projected quarter 2.
    // Beginning par is still the period-start funded balance; by period end
    // both DDTLs are funded.
    expect(result.periods[1].beginningPar).toBeCloseTo(500_000, 0);
    const q2Interest =
      500_000 * (2.5 + 3.5) / 100 * Q2_ACTUAL +
      1_000_000 * (2.5 + 4.0) / 100 * Q2_ACTUAL;
    expect(result.periods[1].interestCollected).toBeCloseTo(q2Interest, 0);
    // Both DDTLs now fully drawn → endingUndrawnCommitment = 0.
    expect(result.periods[1].endingUndrawnCommitment).toBeCloseTo(0, 0);
  });
});
