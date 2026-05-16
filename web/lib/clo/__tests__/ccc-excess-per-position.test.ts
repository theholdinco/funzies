/**
 * Per-agency, per-position CCC/Caa Excess haircut.
 *
 * Ares XV PPM rule (from "CCC/Caa Excess" / "Excess CCC Adjustment Amount"
 * definitions in the Final Offering Circular dated 14 December 2021):
 *
 *   1. Compute Fitch CCC   excess = max(0, Σ Fitch_CCC_par   − 7.5% × CPA)
 *   2. Compute Moody's Caa excess = max(0, Σ Moody's_Caa_par − 7.5% × CPA)
 *   3. Take the greater of (1) and (2). The winning branch's lowest-
 *      Market-Value obligations constitute the bucket.
 *   4. Adjustment = Σ par × (1 − Market Value / 100) over the selected
 *      slice (partial slice on the marginal obligation).
 *
 * Exclusions (both branches): Defaulted Obligations AND Loss Mitigation
 * Loans. The Ares XV PPM applies LML carve-out symmetrically to both
 * Fitch CCC Obligations and Moody's Caa Obligations definitions.
 *
 * Engine dispatch: when ANY loan in the pool carries a per-agency
 * rating (`fitchRatingFinal` or `moodysRatingFinal`), the new per-
 * position path fires. Production data through the resolver always
 * populates both fields, so this is the partner-visible code path.
 * Hand-constructed fixtures with only coarse `ratingBucket` fall back
 * to the legacy scalar haircut for bit-identical pre-refactor behavior.
 */

import { describe, it, expect } from "vitest";
import { runProjection, addQuarters } from "../projection";
import type { LoanInput } from "../projection";
import { makeInputs, noDefaults } from "./test-helpers";

const CURRENT_DATE = "2026-03-09";

const STANDARD_TRANCHES = [
  { className: "A",   currentBalance: 130_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true,  isIncomeNote: false, isDeferrable: false },
  { className: "J",   currentBalance:  30_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true,  isIncomeNote: false, isDeferrable: false },
  { className: "Sub", currentBalance:  40_000_000, spreadBps:   0, seniorityRank: 3, isFloating: false, isIncomeNote: true,  isDeferrable: false },
] as const;

// Read ocNumerator off Class J's OC test — J's denominator is the
// cumulative debt of A + J (= 160M), so `actual × 160M` recovers
// ocNumerator regardless of which haircut was applied. Cleaner than
// Class A's (denominator = A only = 130M) for assertion purposes.
function ocNumeratorFromJ(periods: ReadonlyArray<{ ocTests: ReadonlyArray<{ className: string; actual: number }> }>): number {
  const ocJ = periods[0].ocTests.find((t) => t.className === "J");
  if (!ocJ) throw new Error("test setup: Class J OC test missing");
  const aPlusJDebt = 160_000_000;
  return (ocJ.actual / 100) * aPlusJDebt;
}

describe("CCC/Caa Excess per-position haircut (Fitch vs Moody's)", () => {
  it("Fitch-only stress: lowest-MV-first selection beats the legacy flat scalar", () => {
    // Four-loan pool, 200M par total. Three Fitch-CCC loans (90M = 45%
    // of pool, well above 7.5%), one BB filler. No Moody's ratings on
    // the CCC loans → only the Fitch branch is populated.
    //
    // Lowest-MV-first selection over 90M Fitch CCC pool to fill the
    // excess of 90M − 0.075 × 200M = 75M:
    //   loan2 (30M @ 60c)  → 30M into bucket   (cumulative 30M of 75M)
    //   loan3 (10M @ 70c)  → 10M into bucket   (cumulative 40M of 75M)
    //   loan1 (50M @ 95c)  → 35M partial slice (cumulative 75M of 75M)
    //
    // Expected per-position haircut:
    //   30M × (1 − 0.60) = 12.00M
    // + 10M × (1 − 0.70) =  3.00M
    // + 35M × (1 − 0.95) =  1.75M
    // = 16.75M  →  ocNumerator = 200M − 16.75M = 183.25M
    //
    // Legacy scalar haircut at cccMarketValuePct=70 would be
    //   75M × (1 − 0.70) = 22.50M, a €5.75M over-haircut — driven by
    // the flat scalar's blindness to actual marginal prices.
    const maturity = addQuarters(CURRENT_DATE, 20);
    const loans: LoanInput[] = [
      { parBalance:  50_000_000, maturityDate: maturity, ratingBucket: "CCC", fitchRatingFinal: "CCC",  spreadBps: 500, currentPrice: 95,  currency: "EUR" },
      { parBalance:  30_000_000, maturityDate: maturity, ratingBucket: "CCC", fitchRatingFinal: "CCC-", spreadBps: 600, currentPrice: 60,  currency: "EUR" },
      { parBalance:  10_000_000, maturityDate: maturity, ratingBucket: "CCC", fitchRatingFinal: "CC",   spreadBps: 700, currentPrice: 70,  currency: "EUR" },
      { parBalance: 110_000_000, maturityDate: maturity, ratingBucket: "BB",  fitchRatingFinal: "BB",   spreadBps: 350, currentPrice: 100, currency: "EUR" },
    ];
    const inputs = makeInputs({
      initialPar: 200_000_000,
      loans,
      currentDate: CURRENT_DATE,
      tranches: [...STANDARD_TRANCHES],
      ...noDefaults,
      cprPct: 0,
      cccMarketValuePct: 70,
    });
    const result = runProjection(inputs);
    expect(ocNumeratorFromJ(result.periods)).toBeCloseTo(183_250_000, -4);
  });

  it("greater-of dispatch: Moody's Caa excess > Fitch CCC excess → Moody's branch wins", () => {
    // Two Fitch-CCC + three Moody's-Caa loans, plus a filler. Each
    // agency's bucket has a different par total, so the greater-of
    // branch is mechanically determined.
    //   Fitch CCC  par = 30M  → excess = max(0, 30 − 15) = 15M
    //   Moody's Caa par = 70M → excess = max(0, 70 − 15) = 55M
    //   → Moody's branch wins. Selection over Moody's Caa pool:
    //     loan_m_low  (20M @ 50c) → full 20M    (20 of 55)
    //     loan_m_mid  (30M @ 80c) → full 30M    (50 of 55)
    //     loan_m_high (20M @ 90c) → 5M slice    (55 of 55)
    //   Haircut = 20×0.50 + 30×0.20 + 5×0.10 = 10 + 6 + 0.5 = 16.5M.
    //   ocNumerator = 200M − 16.5M = 183.5M.
    const maturity = addQuarters(CURRENT_DATE, 20);
    const loans: LoanInput[] = [
      // Fitch-only CCC (would alone produce a 15M excess).
      { parBalance:  20_000_000, maturityDate: maturity, ratingBucket: "CCC", fitchRatingFinal:  "CCC",  spreadBps: 500, currentPrice: 85,  currency: "EUR" },
      { parBalance:  10_000_000, maturityDate: maturity, ratingBucket: "CCC", fitchRatingFinal:  "CCC-", spreadBps: 600, currentPrice: 75,  currency: "EUR" },
      // Moody's-only Caa (binding branch).
      { parBalance:  20_000_000, maturityDate: maturity, ratingBucket: "CCC", moodysRatingFinal: "Caa3", spreadBps: 700, currentPrice: 50,  currency: "EUR" },
      { parBalance:  30_000_000, maturityDate: maturity, ratingBucket: "CCC", moodysRatingFinal: "Caa2", spreadBps: 600, currentPrice: 80,  currency: "EUR" },
      { parBalance:  20_000_000, maturityDate: maturity, ratingBucket: "CCC", moodysRatingFinal: "Caa1", spreadBps: 500, currentPrice: 90,  currency: "EUR" },
      // BB filler.
      { parBalance: 100_000_000, maturityDate: maturity, ratingBucket: "BB",  fitchRatingFinal:  "BB",   spreadBps: 350, currentPrice: 100, currency: "EUR" },
    ];
    const inputs = makeInputs({
      initialPar: 200_000_000,
      loans,
      currentDate: CURRENT_DATE,
      tranches: [...STANDARD_TRANCHES],
      ...noDefaults,
      cprPct: 0,
    });
    const result = runProjection(inputs);
    expect(ocNumeratorFromJ(result.periods)).toBeCloseTo(183_500_000, -4);
  });

  it("LML exclusion: applies symmetrically to BOTH Fitch CCC and Moody's Caa branches", () => {
    // Two pairs of CCC loans, each with a LML clone. Without the
    // symmetric LML carve-out, both branches would include 40M and
    // produce a 25M excess; with it, both shrink to 20M and excess
    // shrinks to 5M.
    //
    //   Fitch CCC  pool (post-LML): 20M @ 80c → excess 5M, haircut 1.00M
    //   Moody's Caa pool (post-LML): 20M @ 85c → excess 5M, haircut 0.75M
    //   Fitch is binding (larger absolute excess after MV haircut not
    //   relevant for the par-based "greater of" — both are 5M par; the
    //   tie-break uses Fitch via the `>=` in the dispatch).
    //   ocNumerator = 200M − 1.00M = 199.00M.
    const maturity = addQuarters(CURRENT_DATE, 20);
    const loans: LoanInput[] = [
      { parBalance:  20_000_000, maturityDate: maturity, ratingBucket: "CCC", fitchRatingFinal:  "CCC",  spreadBps: 500, currentPrice: 80,  currency: "EUR" },
      { parBalance:  20_000_000, maturityDate: maturity, ratingBucket: "CCC", fitchRatingFinal:  "CCC",  spreadBps: 500, currentPrice: 60,  currency: "EUR", isLossMitigationLoan: true },
      { parBalance:  20_000_000, maturityDate: maturity, ratingBucket: "CCC", moodysRatingFinal: "Caa2", spreadBps: 500, currentPrice: 85,  currency: "EUR" },
      { parBalance:  20_000_000, maturityDate: maturity, ratingBucket: "CCC", moodysRatingFinal: "Caa2", spreadBps: 500, currentPrice: 50,  currency: "EUR", isLossMitigationLoan: true },
      { parBalance: 120_000_000, maturityDate: maturity, ratingBucket: "BB",  fitchRatingFinal:  "BB",   spreadBps: 350, currentPrice: 100, currency: "EUR" },
    ];
    const inputs = makeInputs({
      initialPar: 200_000_000,
      loans,
      currentDate: CURRENT_DATE,
      tranches: [...STANDARD_TRANCHES],
      ...noDefaults,
      cprPct: 0,
    });
    const result = runProjection(inputs);
    expect(ocNumeratorFromJ(result.periods)).toBeCloseTo(199_000_000, -4);
  });

  it("synthetic reinvestment loans receive per-agency ratings when the deal pool already uses them", () => {
    // Pool has per-agency ratings on every loan → engine startup snapshot
    // `dealUsesPerAgencyRatings = true`. One loan matures Q1 and the
    // proceeds reinvest into synthetic loans tagged with
    // `reinvestmentRating: "CCC"`. The synthesis sites must populate
    // `fitchRatingFinal` and `moodysRatingFinal` on those synthetic loans
    // (via `representativeSubRatings("CCC")` → "CCC" / "Caa2") so they
    // participate in the per-agency Fitch CCC and Moody's Caa
    // populations. If those assignments regress, the synthetic CCC
    // loans would silently drop out of both per-agency buckets and
    // qualityMetrics.pctFitchCcc / pctMoodysCaa would stay at zero
    // even with the CCC override active.
    const shortMaturity = addQuarters(CURRENT_DATE, 1);
    const longMaturity = addQuarters(CURRENT_DATE, 20);
    const loans: LoanInput[] = [
      // Maturing chunk — proceeds reinvest at Q1.
      { parBalance:  40_000_000, maturityDate: shortMaturity, ratingBucket: "BB", fitchRatingFinal: "BB", moodysRatingFinal: "Ba2", spreadBps: 350, currentPrice: 100, currency: "EUR" },
      // Long-dated chunk — keeps the projection running past Q1.
      { parBalance: 160_000_000, maturityDate: longMaturity,  ratingBucket: "BB", fitchRatingFinal: "BB", moodysRatingFinal: "Ba2", spreadBps: 350, currentPrice: 100, currency: "EUR" },
    ];
    const inputs = makeInputs({
      initialPar: 200_000_000,
      loans,
      currentDate: CURRENT_DATE,
      tranches: [...STANDARD_TRANCHES],
      reinvestmentRating: "CCC",
      reinvestmentPricePct: 70,
      ...noDefaults,
      cprPct: 0,
    });
    const result = runProjection(inputs);
    // Post-reinvestment (Q2 onward — Q1 carries the maturity event
    // itself), the synthetic CCC slice must register on both per-agency
    // concentration metrics. Both being > 0 confirms BOTH
    // `fitchRatingFinal` and `moodysRatingFinal` were populated on
    // synthetic loans.
    const postReinv = result.periods[1];
    expect(postReinv.qualityMetrics.pctFitchCcc).toBeGreaterThan(0);
    expect(postReinv.qualityMetrics.pctMoodysCaa).toBeGreaterThan(0);

    // Control: same shape but reinvestmentRating="BB" → synthetic loans
    // shouldn't enter CCC/Caa buckets. Without the gate this test would
    // pass trivially with any rating override; with reinvestmentRating
    // set to BB, both per-agency CCC metrics should stay at zero. This
    // proves the prior assertion isn't picking up some unrelated
    // CCC-flagged loan elsewhere in the pool.
    const controlInputs = makeInputs({
      ...inputs,
      reinvestmentRating: "BB",
    });
    const controlResult = runProjection(controlInputs);
    const controlPost = controlResult.periods[1];
    expect(controlPost.qualityMetrics.pctFitchCcc).toBe(0);
    expect(controlPost.qualityMetrics.pctMoodysCaa).toBe(0);
  });

  it("missing currentPrice in the winning branch fails loud BEFORE selection", () => {
    // 60M Fitch CCC → excess 45M. Two CCC loans, one priced one not.
    // The unpriced loan might be the lowest-MV → selection cannot run
    // reliably without its price, so the engine throws BEFORE the sort
    // rather than silently sorting it last and missing it.
    const maturity = addQuarters(CURRENT_DATE, 20);
    const loans: LoanInput[] = [
      { parBalance:  30_000_000, maturityDate: maturity, ratingBucket: "CCC", fitchRatingFinal: "CCC",  spreadBps: 500, currentPrice: 50, currency: "EUR" },
      // No currentPrice — engine cannot assume any price for this loan.
      { parBalance:  30_000_000, maturityDate: maturity, ratingBucket: "CCC", fitchRatingFinal: "CCC-", spreadBps: 600,                  currency: "EUR" },
      { parBalance: 140_000_000, maturityDate: maturity, ratingBucket: "BB",  fitchRatingFinal: "BB",   spreadBps: 350, currentPrice: 100, currency: "EUR" },
    ];
    const inputs = makeInputs({
      initialPar: 200_000_000,
      loans,
      currentDate: CURRENT_DATE,
      tranches: [...STANDARD_TRANCHES],
      ...noDefaults,
      cprPct: 0,
    });
    expect(() => runProjection(inputs)).toThrowError(/CCC\/Caa Excess haircut.*Fitch CCC.*lack currentPrice/);
  });
});
