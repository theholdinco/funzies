/**
 * Asset-side additive PIK accretion.
 *
 * Invariants pinned here (synthetic — does NOT exercise the live Euro XV
 * fixture; the cash-flow magnitude on Euro XV's single PIK-active position
 * (Financiere Labeyrie at 1% PIK on €5M par ≈ €12.7K/quarter) is too small
 * to surface as a distinct n1 line, hence the load-bearing assertions live
 * here on synthetic loans):
 *
 *   1. **Additive**: cash interest path uses `all_in_rate` / `fixedCouponPct`
 *      unchanged. PIK accretion adds par × pikSpreadBps/10000 × dayFrac to
 *      `survivingPar` without subtracting from `interestCollected`.
 *   2. **Maturity skip**: at q === loan.maturityQuarter the loan is being
 *      redeemed (step 2 zeros survivingPar, totalMaturities += par). PIK
 *      accretion is SKIPPED that period — no zombie PIK on a zeroed loan.
 *   3. **Default ordering**: PIK accretes on PRE-default par
 *      (`loanBeginningPar`, captured before step 2's mutation). The
 *      accretion lands on POST-default surviving par. Convention matches
 *      the existing cash-interest path which also uses `loanBeginningPar`.
 *   4. **Toggle off** (Tele Columbus shape): pikSpreadBps=0 produces zero
 *      accretion regardless of pikAmount. Engine never reads pikAmount;
 *      pikSpreadBps drives dispatch.
 */
import { describe, it, expect } from "vitest";
import { runProjection, addQuarters, dayCountFraction, LoanInput } from "../projection";
import { makeInputs, uniformRates, noDefaults } from "./test-helpers";

const PERIOD_START = "2026-03-09";
const PERIOD_END = "2026-06-09";
const FRAC_360 = dayCountFraction("actual_360", PERIOD_START, PERIOD_END);
const MONTHLY_TICKS_Q1 = ["2026-04-09", "2026-05-09", "2026-06-09"] as const;

function monthlyPikAccrual(par: number, cashRate: number, pikRate: number): { cash: number; pik: number } {
  let balance = par;
  let cash = 0;
  let pik = 0;
  let start = PERIOD_START;
  for (const end of MONTHLY_TICKS_Q1) {
    const frac = dayCountFraction("actual_360", start, end);
    cash += balance * cashRate * frac;
    const accretion = balance * pikRate * frac;
    balance += accretion;
    pik += accretion;
    start = end;
  }
  return { cash, pik };
}

function monthlyPikWithDefaults(
  par: number,
  cashRate: number,
  pikRate: number,
  monthlyHazard: number,
): { cash: number; defaults: number; endingPar: number; pik: number } {
  let balance = par;
  let cash = 0;
  let defaults = 0;
  let pik = 0;
  let start = PERIOD_START;
  for (const end of MONTHLY_TICKS_Q1) {
    const frac = dayCountFraction("actual_360", start, end);
    const beginningPar = balance;
    const tickDefaults = balance * monthlyHazard;
    balance -= tickDefaults;
    defaults += tickDefaults;
    cash += beginningPar * cashRate * frac;
    const accretion = beginningPar * pikRate * frac;
    balance += accretion;
    pik += accretion;
    start = end;
  }
  return { cash, defaults, endingPar: balance, pik };
}

describe("asset-side additive PIK accretion", () => {
  it("split-margin baseline: cash leg unchanged + par grows by PIK rate × par × dayFrac", () => {
    // Synthetic Financiere shape: floating loan with 7.127% all-in cash + 1%
    // additive PIK accretion. Verify the engine accretes the PIK additively.
    const splitPik: LoanInput = {
      parBalance: 100_000_000,
      maturityDate: addQuarters(PERIOD_START, 40),
      ratingBucket: "B",
      spreadBps: 500,        // cash leg: 2.5% base + 5% spread = 7.5% cash
      pikSpreadBps: 100,     // additive PIK leg at 1% per annum
    };
    const result = runProjection(
      makeInputs({
        loans: [splitPik],
        initialPar: 100_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );

    // Cash interest accrues monthly on beginning-tick balance. Additive PIK
    // does not subtract from the cash leg, but once PIK accretes it becomes
    // part of the next monthly tick's cash accrual base.
    const expected = monthlyPikAccrual(100_000_000, (2.5 + 5.0) / 100, 0.01);
    const expectedCash = expected.cash;
    expect(result.periods[0].interestCollected).toBeCloseTo(expectedCash, 0);

    // PIK accretion is also monthly and compounds inside the quarter.
    const expectedAccretion = expected.pik;
    const parDelta = (result.periods[0].endingPar ?? 0) - 100_000_000;
    // No defaults / prepayments — par delta should equal PIK accretion to
    // within rounding.
    expect(parDelta).toBeCloseTo(expectedAccretion, -2);
  });

  it("toggle off (Tele Columbus shape): pikSpreadBps=0 produces zero accretion", () => {
    // Tele Columbus pattern: structurally PIK (historical pikAmount > 0,
    // would be in raw row), but pikSpreadBps=0 — toggle currently off.
    // pikAmount is not on LoanInput by design (engine only reads
    // pikSpreadBps); the absence on LoanInput is the engine's expression
    // of "pikAmount is observability, not engine input."
    const togglePik: LoanInput = {
      parBalance: 50_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 350,
      pikSpreadBps: 0,       // toggle off
    };
    const result = runProjection(
      makeInputs({
        loans: [togglePik],
        initialPar: 50_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );
    // Cash interest accrues normally; par grows by zero.
    const expectedCash = 50_000_000 * (2.5 + 3.5) / 100 * FRAC_360;
    expect(result.periods[0].interestCollected).toBeCloseTo(expectedCash, 0);
    const parDelta = (result.periods[0].endingPar ?? 0) - 50_000_000;
    expect(parDelta).toBeCloseTo(0, -2);
  });

  it("cash-only loan (no pikSpreadBps): par does not grow", () => {
    // Regression guard: a loan without any pikSpreadBps field should
    // not exercise the PIK accretion path; par doesn't grow.
    const cashOnly: LoanInput = {
      parBalance: 50_000_000,
      maturityDate: addQuarters(PERIOD_START, 20),
      ratingBucket: "B",
      spreadBps: 350,
      // pikSpreadBps undefined
    };
    const result = runProjection(
      makeInputs({
        loans: [cashOnly],
        initialPar: 50_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
      })
    );
    const expectedCash = 50_000_000 * (2.5 + 3.5) / 100 * FRAC_360;
    expect(result.periods[0].interestCollected).toBeCloseTo(expectedCash, 0);
    const parDelta = (result.periods[0].endingPar ?? 0) - 50_000_000;
    expect(parDelta).toBeCloseTo(0, -2);
  });

  it("maturity skip: PIK loan maturing at Q3 — final period accretion is NOT applied (no zombie par)", () => {
    // PIK loan matures at q=3. Reinvestment is disabled (RP ends Q1, post-RP
    // reinvestment 0%) so the matured proceeds don't get re-deployed into
    // a new loan; pool par truly drops to 0 after q=3 if the maturity-skip
    // convention holds.
    //
    // Without the skip, survivingPar at end of Q3 = 0 + (pikAccretion on
    // pre-maturity par) ≈ €514K of zombie PIK. With the skip, survivingPar
    // stays at 0 → pool par at Q3 = 0.
    const maturingPik: LoanInput = {
      parBalance: 100_000_000,
      maturityDate: addQuarters(PERIOD_START, 3),  // matures at q=3
      ratingBucket: "B",
      spreadBps: 500,
      pikSpreadBps: 200,  // 2% PIK per annum (large enough to be obvious)
    };
    const result = runProjection(
      makeInputs({
        loans: [maturingPik],
        initialPar: 100_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
        // Kill reinvestment so the matured par actually drops out of the pool.
        reinvestmentPeriodEnd: addQuarters(PERIOD_START, 1),
        postRpReinvestmentPct: 0,
      })
    );

    // Q3 ending par: zero (loan redeemed, no zombie PIK, no reinvestment).
    const q3 = result.periods[2];
    expect(q3.endingPar ?? 0).toBeCloseTo(0, -1);
  });

  it("intra-month maturity earns partial PIK through the actual maturity date", () => {
    const activeFrac = dayCountFraction("actual_360", "2026-03-09", "2026-04-01");
    const result = runProjection(
      makeInputs({
        loans: [
          {
            parBalance: 1_000_000,
            maturityDate: "2026-04-01",
            ratingBucket: "B",
            spreadBps: 360,
            pikSpreadBps: 200,
          },
        ],
        initialPar: 1_000_000,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        ...noDefaults,
        cprPct: 0,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    const expectedCash = 1_000_000 * 0.036 * activeFrac;
    const expectedPik = 1_000_000 * 0.02 * activeFrac;
    expect(result.periods[0].interestCollected).toBeCloseTo(expectedCash, 0);
    expect(result.periods[0].scheduledMaturities).toBeCloseTo(1_000_000 + expectedPik, 0);
    expect(result.periods[0].endingPar).toBeCloseTo(0, 0);
  });

  it("default ordering: PIK loan partial-default — PIK accretes on pre-default par, lands on surviving par", () => {
    // Engine convention pin: cash interest and PIK accretion both use
    // `loanBeginningPar` (captured pre-step-2). PIK
    // additively lands on the post-default surviving par. A 50%-defaulting
    // loan accrues full-period PIK on the pre-default 100M, with the
    // accretion adding to the surviving 50M. Result: ending surviving par
    // ≈ 50M + (100M × pikRate × dayFrac).
    const partialDefaultingPik: LoanInput = {
      parBalance: 100_000_000,
      maturityDate: addQuarters(PERIOD_START, 40),
      ratingBucket: "B",
      spreadBps: 500,
      pikSpreadBps: 200,  // 2% per annum
    };
    const annualCdr = 60;
    const quarterlyHazard = 1 - Math.pow(1 - annualCdr / 100, 0.25);
    const monthlyHazard = 1 - Math.pow(1 - quarterlyHazard, 1 / 3);
    const expected = monthlyPikWithDefaults(100_000_000, (2.5 + 5.0) / 100, 0.02, monthlyHazard);
    const result = runProjection(
      makeInputs({
        loans: [partialDefaultingPik],
        initialPar: 100_000_000,
        baseRatePct: 2.5,
        baseRateFloorPct: 0,
        defaultRatesByRating: uniformRates(annualCdr),
        overriddenBuckets: ["B"],
        cprPct: 0,
        // Long recovery lag so defaulted par stays "pending" (not recovered
        // back into pool) — keeps the surviving-par observable cleanly.
        recoveryLagMonths: 24,
        // Kill reinvestment so reinvested loans don't pollute the par count.
        reinvestmentPeriodEnd: PERIOD_START,
        postRpReinvestmentPct: 0,
      }),
      (survivingPar, hazardRate) => survivingPar * hazardRate,
    );

    expect(result.periods[0].defaults).toBeCloseTo(expected.defaults, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(expected.cash, 0);
    expect(result.periods[0].endingPar ?? 0).toBeCloseTo(expected.endingPar, 0);
    expect((result.periods[0].endingPar ?? 0) - (100_000_000 - result.periods[0].defaults)).toBeCloseTo(expected.pik, 0);
  });
});
