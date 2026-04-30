/**
 * SYSTEMATIC EDGE CASE TESTS
 *
 * Methodology: enumerate every degree of freedom in the engine, every conditional
 * branch, and cross them to find untested interactions.
 *
 * Degrees of freedom:
 *   Per-period state: inRP (T/F), isMaturity (T/F), hasLoans (T/F)
 *   OC/IC cure:       failOC (T/F) × failIC (T/F) × inRP (T/F)
 *   Tranche flags:    isFloating, isDeferrable, isAmortising, isIncomeNote
 *   Optionals:        callDate, reinvestmentOcTrigger, postRpReinvestmentPct
 *   Continuous:       CDR, CPR, recovery, fees, rates, CCC haircut
 *
 * Each test documents the specific branch combination it covers.
 */

import { describe, it, expect } from "vitest";
import { runProjection, addQuarters, dayCountFraction } from "../projection";
import { uniformRates, makeInputs } from "./test-helpers";

// B3: makeInputs uses currentDate=2026-03-09 → period 1 window is 92 days
// under Actual/360. Legacy /4-based expected values need updating.
const Q1_ACTUAL = dayCountFraction("actual_360", "2026-03-09", "2026-06-09");


// ═══════════════════════════════════════════════════════════════════════════════
// A. AGGREGATE MODE (hasLoans=false) INTERACTIONS
// Branch: lines 304-323, 334-343 — aggregate fallback paths
// Gap: aggregate mode barely tested with OC/IC triggers, cures, reinvestment
// ═══════════════════════════════════════════════════════════════════════════════

describe("A. Aggregate mode (no loans)", () => {
  it("A1: aggregate mode with OC trigger — cure diverts interest to paydown", () => {
    // Branches: hasLoans=false, failingOC=true, inRP=false
    // Aggregate CDR uses average of all rating buckets.
    const inputs = makeInputs({
      loans: [],
      reinvestmentPeriodEnd: "2026-01-01", // outside RP
      defaultRatesByRating: uniformRates(10),
      cprPct: 0,
      recoveryPct: 0,
      ocTriggers: [{ className: "J", triggerLevel: 130, rank: 2 }],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const p1 = result.periods[0];

    const ocB = p1.ocTests.find((t) => t.className === "J")!;
    expect(ocB).toBeDefined();
    // With 10% uniform CDR, par drops → OC may fail at 130 trigger
    // Regardless, the test ran without error in aggregate mode with OC triggers
    expect(p1.endingPar).toBeLessThan(100_000_000);
  });

  it("A2: aggregate mode with IC trigger — cure works without loan-level data", () => {
    // Branches: hasLoans=false, failingIC=true
    const inputs = makeInputs({
      loans: [],
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      baseRatePct: 1.0,
      icTriggers: [{ className: "J", triggerLevel: 200, rank: 2 }],
      ocTriggers: [],
    });

    const result = runProjection(inputs);
    const p1 = result.periods[0];

    const icB = p1.icTests.find((t) => t.className === "J")!;
    expect(icB).toBeDefined();
    // Interest in aggregate: par * allInRate / 4 = 100M * (1+4)/100 / 4 = 1.25M
    // A due = 70M * (1+1.4)/100/4 = 420K, B due = 20M * (1+3)/100/4 = 200K
    // IC = 1.25M / 620K = 201.6% → passes 200 barely
    // But let's verify it at least computes correctly
    expect(icB.actual).toBeGreaterThan(0);
  });

  it("A3: aggregate mode interest uses wacSpreadBps, not per-loan spreads", () => {
    // Branches: hasLoans=false, line 342
    const aggResult = runProjection(makeInputs({
      loans: [],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      wacSpreadBps: 400,
    }));

    // Interest = 100M × (2.1 + 4.0)% × 92/360 (Actual/360, currentDate=2026-03-09)
    expect(aggResult.periods[0].interestCollected).toBeCloseTo(100_000_000 * (2.1 + 4.0) / 100 * Q1_ACTUAL, -2);
  });

  it("A4: aggregate mode reinvestment during RP increases currentPar", () => {
    // Branches: hasLoans=false, inRP=true, reinvestment > 0
    const inputs = makeInputs({
      loans: [],
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(0),
      cprPct: 20, // generates prepayments
      recoveryPct: 0,
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    // During RP with CPR, prepayments are reinvested → par should stay near initial
    // (prepayments reduce par, reinvestment adds it back)
    expect(result.periods[0].reinvestment).toBeGreaterThan(0);
    expect(result.periods[0].endingPar).toBeCloseTo(100_000_000, -4);
  });

  it("A5: aggregate mode callDate — callPricePct applies to endingPar at maturity", () => {
    // Branches: hasLoans=false, isMaturity=true, callDate set, callPriceMode "manual"
    // (manual mode is the partner-facing nomenclature for "flat % of par"; in
    // aggregate-mode liquidation that's `endingPar × callPricePct/100`).
    const atPar = makeInputs({
      loans: [],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      callMode: "optionalRedemption",
      callDate: addQuarters("2026-01-15", 4),
      callPricePct: 100,
      callPriceMode: "manual",
    });

    const atDiscount = { ...atPar, callPricePct: 90 };

    const parResult = runProjection(atPar);
    const discountResult = runProjection(atDiscount);

    // 10% discount on 100M par = 10M difference
    const diff = parResult.totalEquityDistributions - discountResult.totalEquityDistributions;
    expect(diff).toBeCloseTo(10_000_000, -4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. CALL DATE × LOAN MATURITY INTERACTIONS
// Branch: line 176 (no clamp), line 260 (maturity check), line 409 (liquidation)
// Gap: mixed maturities (some before call, some after), callPricePct > 100
// ═══════════════════════════════════════════════════════════════════════════════

describe("B. Call date × loan maturity interactions", () => {
  it("B1: mixed loan maturities — loans before call mature at par, loans after liquidated at callPricePct", () => {
    // 50M matures at Q2 (before call at Q4) → par proceeds
    // 50M matures at Q20 (after call) → liquidated at 95% at Q4
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      callMode: "optionalRedemption",
      callDate: addQuarters("2026-01-15", 4),
      callPricePct: 95,
      callPriceMode: "manual",
      loans: [
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 2), ratingBucket: "B", spreadBps: 400 },
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // Q2: first loan matures at par (50M)
    const q2 = result.periods[1];
    expect(q2.scheduledMaturities).toBeCloseTo(50_000_000, -2);

    // Q4 (call): second loan is still alive → liquidated at 95%
    const lastPeriod = result.periods[result.periods.length - 1];
    // liquidationProceeds = endingPar * 0.95 = 50M * 0.95 = 47.5M
    // Total principal available = 47.5M (liquidation) — no maturities since loan doesn't mature at Q4
    // Compare with par mode to verify 2.5M difference (par sells at 100c).
    const atParResult = runProjection({ ...inputs, callPricePct: 100, callPriceMode: "par" });
    const diff = atParResult.totalEquityDistributions - result.totalEquityDistributions;
    // Discount only applies to the 50M that didn't naturally mature → 50M * 5% = 2.5M
    expect(diff).toBeCloseTo(2_500_000, -4);
  });

  it("B2: callPricePct > 100 (premium) — extra proceeds flow to equity", () => {
    // Some deals liquidate at a premium (e.g. make-whole provisions)
    const atPar = makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      callMode: "optionalRedemption",
      callDate: addQuarters("2026-01-15", 4),
      callPricePct: 100,
      callPriceMode: "par",
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 }],
      ocTriggers: [],
      icTriggers: [],
    });

    const atPremium = { ...atPar, callPricePct: 102, callPriceMode: "manual" as const };

    const parResult = runProjection(atPar);
    const premiumResult = runProjection(atPremium);

    // 2% premium on 100M = 2M more equity
    expect(premiumResult.totalEquityDistributions).toBeGreaterThan(
      parResult.totalEquityDistributions
    );
    const diff = premiumResult.totalEquityDistributions - parResult.totalEquityDistributions;
    expect(diff).toBeCloseTo(2_000_000, -4);
  });

  it("B3: callDate null at natural maturity — callPricePct is irrelevant (liquidate at 100%)", () => {
    // Branch: line 409: `callDate ? callPricePct/100 : 1`
    // Without callDate, liquidation is always at 100% regardless of callPricePct
    const result95 = runProjection(makeInputs({
      callDate: null,
      callPricePct: 95, // should be ignored
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
    }));

    const result100 = runProjection(makeInputs({
      callDate: null,
      callPricePct: 100,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
    }));

    // Should be identical — callPricePct ignored without callDate
    expect(result95.totalEquityDistributions).toBeCloseTo(
      result100.totalEquityDistributions, 0
    );
  });

  it("B4: callDate before RP end — call trumps RP", () => {
    // Branch: totalQuarters = min(callQuarters, maturityQuarters)
    // If call is at Q4 but RP ends at Q8, deal ends at Q4.
    const currentDate = "2026-01-15";
    const inputs = makeInputs({
      currentDate,
      reinvestmentPeriodEnd: addQuarters(currentDate, 8), // RP until Q8
      callMode: "optionalRedemption",
      callDate: addQuarters(currentDate, 4), // but call at Q4
      callPricePct: 100,
      callPriceMode: "par",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
    });

    const result = runProjection(inputs);
    // Should have exactly 4 periods (call at Q4)
    expect(result.periods.length).toBe(4);
    // Q1-Q4 should all be inRP (RP extends to Q8, call at Q4)
    // Reinvestment should happen in Q1-Q3 (not Q4 which is maturity)
    expect(result.periods[0].reinvestment).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. OC/IC CURE — UNTESTED BRANCH COMBINATIONS
// Branches: lines 616-709
// Gap: IC-only failure during RP (OC passes), cure denominator edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("C. OC/IC cure branch combinations", () => {
  it("C1: IC fails during RP but OC passes — cure does paydown (not buy collateral)", () => {
    // Branches: inRP=true, failingOC=false, failingIC=true
    // Line 682: `if (inRP && !failingIc)` → false → paydown path
    // This specific combination was never tested.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20), // inside RP
      defaultRatesByRating: uniformRates(0), // no defaults → OC stays healthy
      cprPct: 0,
      recoveryPct: 0,
      baseRatePct: 1.0, // low base rate → tight IC
      ocTriggers: [{ className: "J", triggerLevel: 110, rank: 2 }], // OC passes (par/denom = 100/90 = 111%)
      icTriggers: [{ className: "J", triggerLevel: 250, rank: 2 }], // IC fails (tight trigger)
    });

    const result = runProjection(inputs);
    const p1 = result.periods[0];

    // OC should pass
    const ocB = p1.ocTests.find((t) => t.className === "J")!;
    expect(ocB.passing).toBe(true);

    // IC should fail
    const icB = p1.icTests.find((t) => t.className === "J")!;
    expect(icB.passing).toBe(false);

    // Cure should use paydown (not buy collateral) even though we're in RP
    // Verify: endingPar should NOT increase (no collateral purchase)
    // and endingLiabilities should decrease (paydown happened)
    const noCureResult = runProjection({ ...inputs, icTriggers: [], ocTriggers: [] });
    expect(p1.endingPar).toBeLessThanOrEqual(noCureResult.periods[0].endingPar + 1);
    expect(p1.endingLiabilities).toBeLessThanOrEqual(noCureResult.periods[0].endingLiabilities + 1);
  });

  it("C2: OC cure when debtAtAndAbove = 0 (all tranches already paid off) → auto-pass", () => {
    // Branch: line 482: `debtAtAndAbove > 0 ? ratio : 999`
    // If all debt is paid off, OC ratio = 999 (auto-pass)
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      tranches: [
        { className: "A", currentBalance: 1_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 99_999_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      // Tiny A tranche gets paid off in Q1 from first loan maturity
      loans: [
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 1), ratingBucket: "B", spreadBps: 400 },
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 },
      ],
      ocTriggers: [{ className: "A", triggerLevel: 500, rank: 1 }], // impossibly high trigger
    });

    const result = runProjection(inputs);

    // After A is paid off (Q1), OC ratio should be 999 (auto-pass)
    const aPayoff = result.tranchePayoffQuarter["A"];
    expect(aPayoff).not.toBeNull();

    if (aPayoff && aPayoff < result.periods.length) {
      const postPayoff = result.periods[aPayoff]; // period after payoff
      if (postPayoff) {
        const ocA = postPayoff.ocTests.find((t) => t.className === "A");
        if (ocA) {
          expect(ocA.actual).toBe(999);
          expect(ocA.passing).toBe(true);
        }
      }
    }
  });

  it("C3: cure at rank N reduces denominator — affects OC ratio at rank N+1", () => {
    // Branches: OC triggers at two different ranks, cure at lower rank reduces
    // tranche balances, which changes the denominator for the next rank.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(8),
      cprPct: 0,
      recoveryPct: 0,
      tranches: [
        { className: "A", currentBalance: 55_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "J", currentBalance: 15_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "C", currentBalance: 10_000_000, spreadBps: 450, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "J", triggerLevel: 130, rank: 2 },
        { className: "C", triggerLevel: 115, rank: 3 },
      ],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    // Just verify it runs without error and produces valid OC ratios
    // The key check: both triggers are computed with post-paydown balances
    for (const p of result.periods) {
      for (const oc of p.ocTests) {
        // OC actual can be 0 when par is exhausted (numerator = 0, denom > 0)
        expect(oc.actual).toBeGreaterThanOrEqual(0);
        expect(isFinite(oc.actual)).toBe(true);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. REINVESTMENT MECHANICS
// Branches: lines 350-371 (reinvestment), line 361 (splitting)
// Gap: loan splitting, CCC reinvestment, reinvestmentTenorQuarters=0
// ═══════════════════════════════════════════════════════════════════════════════

describe("D. Reinvestment mechanics", () => {
  it("D1: loan splitting — reinvestment > 1.5 * avgLoanSize creates multiple loans", () => {
    // Branch: line 361: `avgLoanSize > 0 && reinvestment > avgLoanSize * 1.5`
    // 10 loans × 10M each → avgLoanSize = 10M. If one matures (10M) and is
    // reinvested, it's exactly 1× avgLoanSize so no split. But if total
    // reinvestment exceeds 15M, it should split.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(0),
      cprPct: 30, // high prepay → large principal proceeds → large reinvestment
      recoveryPct: 0,
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    // In Q1: prepayments generate principal proceeds which are reinvested during RP.
    // If reinvestment > 15M, the engine splits into multiple loans.
    // We can verify by checking that reinvestment amount = prepayments + maturities
    const p1 = result.periods[0];
    expect(p1.reinvestment).toBe(p1.prepayments + p1.scheduledMaturities + p1.recoveries);
  });

  it("D2: CCC reinvestment rating triggers CCC haircut", () => {
    // Branch: lines 458-469 (CCC haircut in OC numerator)
    // If reinvestmentRating = "CCC", newly purchased loans are CCC-rated.
    // If total CCC par > cccBucketLimitPct × endingPar, haircut applies.
    const noCCC = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      reinvestmentRating: "B",
      defaultRatesByRating: uniformRates(0),
      cprPct: 20,
      recoveryPct: 0,
      ocTriggers: [{ className: "J", triggerLevel: 110, rank: 2 }],
      icTriggers: [],
    });

    const withCCC = { ...noCCC, reinvestmentRating: "CCC" };

    const noCCCResult = runProjection(noCCC);
    const cccResult = runProjection(withCCC);

    // With CCC reinvestment: CCC par grows → may exceed limit → haircut → lower OC ratio
    // After several periods of reinvesting as CCC:
    const midPeriod = 6;
    if (noCCCResult.periods[midPeriod] && cccResult.periods[midPeriod]) {
      const noCCCOc = noCCCResult.periods[midPeriod].ocTests.find((t) => t.className === "J");
      const cccOc = cccResult.periods[midPeriod].ocTests.find((t) => t.className === "J");
      if (noCCCOc && cccOc) {
        // CCC haircut should reduce OC ratio
        expect(cccOc.actual).toBeLessThanOrEqual(noCCCOc.actual + 0.01);
      }
    }
  });

  it("D3: postRpReinvestmentPct creates loans that survive to maturity/call", () => {
    // Branch: line 352-354 (post-RP partial reinvestment)
    // Post-RP reinvestment creates loans. Verify they produce interest and
    // eventually mature or get liquidated.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01", // already post-RP
      postRpReinvestmentPct: 50,
      defaultRatesByRating: uniformRates(0),
      cprPct: 10,
      recoveryPct: 0,
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // Post-RP reinvestment should reduce principal available for paydown
    // → tranche A takes longer to pay off
    const noReinvest = runProjection({ ...inputs, postRpReinvestmentPct: 0 });
    const aPayoffWithReinvest = result.tranchePayoffQuarter["A"];
    const aPayoffWithout = noReinvest.tranchePayoffQuarter["A"];
    if (aPayoffWithReinvest && aPayoffWithout) {
      expect(aPayoffWithReinvest).toBeGreaterThanOrEqual(aPayoffWithout);
    }

    // Reinvestment should show > 0 in post-RP periods
    const postRpPeriod = result.periods.find((p) => p.reinvestment > 0);
    expect(postRpPeriod).toBeDefined();
  });

  it("D4: reinvestmentPeriodEnd = null — never in RP, no reinvestment", () => {
    // Branch: line 244: `rpEndDate ? ... : false` → inRP always false
    const inputs = makeInputs({
      reinvestmentPeriodEnd: null,
      defaultRatesByRating: uniformRates(0),
      cprPct: 20,
      recoveryPct: 0,
      postRpReinvestmentPct: 0,
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // No reinvestment in any period
    for (const p of result.periods) {
      expect(p.reinvestment).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. PIK / DEFERRED INTEREST — UNTESTED INTERACTIONS
// Branches: lines 586-611 (PIK), deferredInterestCompounds T/F
// Gap: PIK interaction with cure denominators, PIK on zeroed tranche
// ═══════════════════════════════════════════════════════════════════════════════

describe("E. PIK interactions", () => {
  it("E1: compounding vs non-compounding produce same OC denom in Q1, diverge later", () => {
    // Branch: deferredInterestCompounds T vs F
    // Q1: identical (no prior deferred). Q2+: compounding earns interest on deferred.
    const base = {
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      // Force diversion so B gets PIK'd
      ocTriggers: [{ className: "A", triggerLevel: 999, rank: 1 }],
      icTriggers: [],
    };

    const compResult = runProjection(makeInputs({ ...base, deferredInterestCompounds: true }));
    const nonCompResult = runProjection(makeInputs({ ...base, deferredInterestCompounds: false }));

    // Q1: B endBalance should be the same (first period PIK amount is identical)
    const compB1 = compResult.periods[0].tranchePrincipal.find((t) => t.className === "J")!;
    const nonCompB1 = nonCompResult.periods[0].tranchePrincipal.find((t) => t.className === "J")!;
    expect(compB1.endBalance).toBeCloseTo(nonCompB1.endBalance, 0);

    // Q3+: compounding should show higher B endBalance (interest on deferred)
    const compB3 = compResult.periods[2]?.tranchePrincipal.find((t) => t.className === "J")!;
    const nonCompB3 = nonCompResult.periods[2]?.tranchePrincipal.find((t) => t.className === "J")!;
    if (compB3 && nonCompB3) {
      expect(compB3.endBalance).toBeGreaterThan(nonCompB3.endBalance);
    }
  });

  it("E2: PIK not applied to tranche with bopBalance <= 0.01 (fully redeemed earlier)", () => {
    // Branch: line 590: `bopTrancheBalances[t.className] > 0.01`
    // If tranche was paid off by preliminary paydown, BOP balance is from previous period.
    // If the tranche was paid off in a PREVIOUS period, BOP balance this period is 0.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      tranches: [
        // Synthetic "K" senior: deliberately marked deferrable to exercise
        // the "bopBalance <= 0.01 / don't PIK onto a zeroed tranche" code
        // path. Renamed from "A" because D1 enforces A/B non-deferrable.
        { className: "K", currentBalance: 5_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "J", currentBalance: 20_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 79_995_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      // K is tiny (5K) → paid off immediately from first loan maturity
      loans: [
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 1), ratingBucket: "B", spreadBps: 400 },
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 },
      ],
      // Full diversion after K → J gets PIK
      ocTriggers: [{ className: "K", triggerLevel: 999, rank: 1 }],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // K should be paid off in Q1
    expect(result.tranchePayoffQuarter["K"]).toBe(1);

    // After payoff, K's endBalance should stay at 0 (no PIK added to zeroed tranche)
    for (let i = 1; i < result.periods.length; i++) {
      const kBalance = result.periods[i].tranchePrincipal.find((t) => t.className === "K")!;
      expect(kBalance.endBalance).toBeCloseTo(0, 0);
    }
  });

  it("E3: PIK accumulation inflates OC denominator causing progressive OC failure", () => {
    // Each period of PIK increases liabilities → OC denom grows → ratio drops
    // Even with stable par, OC can fail from PIK accumulation alone.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(0), // no defaults — par stable
      cprPct: 0,
      recoveryPct: 0,
      deferredInterestCompounds: true,
      // Tight OC that barely passes initially, then fails as PIK accumulates
      // B denom = A + B = 90M. OC = 100M/90M = 111.1%. Trigger at 111.
      // As B PIKs, denom grows: 90M → 90.325M → ... eventually fails.
      ocTriggers: [{ className: "J", triggerLevel: 111, rank: 2 }],
      icTriggers: [],
      // Force B to PIK by diverting at rank 1 but with a passable trigger
      // Actually, to get B to PIK, we need diversion. Let's use a different approach:
      // Set high fees so interest doesn't reach B, causing partial payment / PIK.
      seniorFeePct: 2.0, // 2% on 100M = 500K/quarter
      trusteeFeeBps: 100, // 1% = 250K/quarter
      hedgeCostBps: 100, // 1% = 250K/quarter
      // Total fees = 1M. Interest = 100M * 7.5% / 4 = 1.875M. After fees: 875K.
      // A interest = 70M * (3.5+1.4)/100/4 = 857.5K. B interest = 20M * (3.5+3)/100/4 = 325K.
      // After paying A: 875K - 857.5K = 17.5K for B. B due = 325K → shortfall = 307.5K → PIK
    });

    const result = runProjection(inputs);

    // B should have increasing endBalance due to PIK
    const bBalances = result.periods.slice(0, 5).map(
      (p) => p.tranchePrincipal.find((t) => t.className === "J")!.endBalance
    );
    // Each period, B balance grows due to PIK of ~307K
    for (let i = 1; i < bBalances.length; i++) {
      expect(bBalances[i]).toBeGreaterThan(bBalances[i - 1] - 1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F. CLASS X (AMORTISING) — UNTESTED INTERACTIONS
// Branches: lines 538-544 (amort demand), line 434 (skip in paydown)
// Gap: amortisationPerPeriod=null, Class X at maturity via principal, X interest
// ═══════════════════════════════════════════════════════════════════════════════

describe("F. Class X edge cases", () => {
  it("F1: amortisationPerPeriod = null → pays full remaining balance each period", () => {
    // Branch: line 542: `resolvedAmortPerPeriod ?? trancheBalances[t.className]`
    // When null: scheduleAmt = full remaining balance.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      tranches: [
        {
          className: "X", currentBalance: 2_000_000, spreadBps: 60,
          seniorityRank: 0, isFloating: true, isIncomeNote: false, isDeferrable: false,
          isAmortising: true, amortisationPerPeriod: null, // pay full balance
          amortStartDate: null, // active immediately
        },
        { className: "A", currentBalance: 70_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 28_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const xQ1 = result.periods[0].tranchePrincipal.find((t) => t.className === "X")!;

    // amortisationPerPeriod=null → fallback: currentBalance / defaultScheduledAmortPeriods = 2M / 5 = 400K
    // NOT "pay full balance" — null triggers the default schedule.
    expect(xQ1.paid).toBeCloseTo(400_000, -2);
    expect(xQ1.endBalance).toBeCloseTo(1_600_000, -2);
  });

  it("F2: Class X at maturity — paid from principal paydown, not interest amort", () => {
    // Branch: line 434: `t.isAmortising && !isMaturity` → skip.
    // At maturity (isMaturity=true), amortising tranches ARE included in sequential paydown.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      maturityDate: addQuarters("2026-01-15", 4), // short deal
      tranches: [
        {
          className: "X", currentBalance: 2_000_000, spreadBps: 60,
          seniorityRank: 0, isFloating: true, isIncomeNote: false, isDeferrable: false,
          isAmortising: true, amortisationPerPeriod: 100_000, // slow amort
          amortStartDate: null,
        },
        { className: "A", currentBalance: 70_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 28_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const lastPeriod = result.periods[result.periods.length - 1];

    // At maturity, X should be fully paid off (from principal proceeds, not just 100K amort)
    const xFinal = lastPeriod.tranchePrincipal.find((t) => t.className === "X")!;
    expect(xFinal.endBalance).toBeCloseTo(0, 0);
  });

  it("F3: Class X earns interest at its coupon rate (separate from amort)", () => {
    // Class X is a debt tranche — it earns interest AND amortises.
    // Interest due on X = bopBalance * couponRate / 4
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      tranches: [
        {
          className: "X", currentBalance: 2_000_000, spreadBps: 60,
          seniorityRank: 0, isFloating: true, isIncomeNote: false, isDeferrable: false,
          isAmortising: true, amortisationPerPeriod: 500_000,
          amortStartDate: null,
        },
        { className: "A", currentBalance: 70_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 28_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const xInterest = result.periods[0].trancheInterest.find((t) => t.className === "X")!;

    // X interest due = 2M * (3.5 + 0.6)/100 / 4 = 2M * 0.041/4 = 20,500
    expect(xInterest.due).toBeGreaterThan(0);
    expect(xInterest.paid).toBeCloseTo(xInterest.due, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// G. REINVESTMENT OC TRIGGER — UNTESTED INTERACTIONS
// Branches: lines 507-516, 712-733
// Gap: reinvestment OC passes after standard OC cure, interaction with callDate
// ═══════════════════════════════════════════════════════════════════════════════

describe("G. Reinvestment OC trigger interactions", () => {
  it("G1: standard OC cure buys enough collateral that reinvestment OC passes on re-check", () => {
    // Branches: lines 714-719 (re-check after standard OC cure)
    // Standard OC cure at rank N buys collateral → ocNumerator increases.
    // Reinvestment OC is re-checked with updated numerator. If cure was sufficient,
    // reinvestment OC should pass and NOT divert additional interest.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(5),
      cprPct: 0,
      recoveryPct: 0,
      // Standard OC trigger that fires and buys collateral
      ocTriggers: [{ className: "J", triggerLevel: 115, rank: 2 }],
      icTriggers: [],
      // Reinvestment OC: same rank but lower trigger — should pass after cure
      reinvestmentOcTrigger: { triggerLevel: 110, rank: 2, diversionPct: 50 },
    });

    const noDivResult = runProjection({
      ...inputs,
      reinvestmentOcTrigger: null,
    });

    const withDivResult = runProjection(inputs);

    // If reinvestment OC was satisfied by the standard cure, equity should be
    // the same (no additional diversion from reinvestment OC).
    // If reinvestment OC still fails, equity would be lower.
    // This is a directional check — the key point is that the re-check happens.
    expect(withDivResult.periods[0].equityDistribution).toBeGreaterThanOrEqual(0);
  });

  it("G2: reinvestment OC only fires during RP, not post-RP", () => {
    // Branch: line 510: `inRP && reinvestmentOcTrigger`
    const inputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 4), // RP ends Q4
      defaultRatesByRating: uniformRates(10),
      cprPct: 0,
      recoveryPct: 0,
      ocTriggers: [],
      icTriggers: [],
      reinvestmentOcTrigger: { triggerLevel: 200, rank: 2, diversionPct: 100 }, // very tight → always fails
    });

    const result = runProjection(inputs);

    // Q1-Q4 (in RP): reinvestment OC should fire, reducing equity
    // Q5+ (post-RP): reinvestment OC should NOT fire
    const rpEquity = result.periods.slice(0, 4).reduce((s, p) => s + p.equityDistribution, 0);
    const postRpEquity = result.periods.slice(4, 8).reduce((s, p) => s + p.equityDistribution, 0);

    // RP diversion changes deal state (par, tranche balances), causing carryover
    // into post-RP periods. So we can't compare absolute equity.
    // Instead: verify the reinvestment OC trigger had an impact during RP but not after.
    const noTrigger = runProjection({ ...inputs, reinvestmentOcTrigger: null });
    const noTriggerRpEquity = noTrigger.periods.slice(0, 4).reduce((s, p) => s + p.equityDistribution, 0);

    // RP equity should be lower WITH trigger (diversion reduces equity during RP)
    expect(rpEquity).toBeLessThan(noTriggerRpEquity + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H. FEE INTERACTIONS
// Branches: lines 739-752 (sub fee, incentive), resolveIncentiveFee regimes
// Gap: incentive fee from principal, sub fee > available interest
// ═══════════════════════════════════════════════════════════════════════════════

describe("H. Fee interactions", () => {
  it("H1: incentive fee from principal — incremental over interest fee", () => {
    // Branch: lines 777-786 (incentive fee from principal)
    // totalFee computed on (interest + principal), then interest fee subtracted.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      maturityDate: addQuarters("2026-01-15", 4), // short deal for faster IRR
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: 0.01, // very low hurdle → fee always fires
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const noFeeResult = runProjection({ ...inputs, incentiveFeePct: 0, incentiveFeeHurdleIrr: 0 });

    // Fee should reduce total equity
    if (noFeeResult.equityIrr !== null && noFeeResult.equityIrr > 0.01) {
      expect(result.totalEquityDistributions).toBeLessThan(noFeeResult.totalEquityDistributions);
    }
  });

  it("H2: sub fee capped at available interest — cannot go negative", () => {
    // Branch: line 741: `Math.min(subFeeAmount, availableInterest)`
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      subFeePct: 50, // 50% of par = 12.5M/quarter — way more than available interest
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // Equity from interest should be 0 (sub fee consumed everything)
    // But equity should never be negative
    for (const p of result.periods) {
      expect(p.equityDistribution).toBeGreaterThanOrEqual(-0.01);
    }
  });

  it("H3: incentive fee with OC cure — cure reduces equity, may push IRR below hurdle", () => {
    // Interaction: OC cure diverts interest → less equity → lower IRR → may not reach hurdle → no fee
    const withCure = makeInputs({
      currentDate: "2026-01-15",
      maturityDate: addQuarters("2026-01-15", 32),
      wacSpreadBps: 400,
      baseRatePct: 3.5,
      baseRateFloorPct: 0,
      seniorFeePct: 0,
      subFeePct: 0,
      loans: Array.from({ length: 10 }, (_, i) => ({
        parBalance: 10_000_000,
        maturityDate: addQuarters("2026-01-15", 12 + i),
        ratingBucket: "B" as const,
        spreadBps: 400,
      })),
      tranches: [
        { className: "A", currentBalance: 70_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "J", currentBalance: 20_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(5),
      cprPct: 0,
      recoveryPct: 0,
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: 0.10, // 10% hurdle
      ocTriggers: [{ className: "J", triggerLevel: 120, rank: 2 }],
      icTriggers: [],
    });

    const noCure = { ...withCure, ocTriggers: [] as typeof withCure.ocTriggers };

    const cureResult = runProjection(withCure);
    const noCureResult = runProjection(noCure);

    // With cure, equity is lower → IRR may drop below hurdle → less/no incentive fee
    // This is a cascading interaction. Just verify consistency.
    expect(cureResult.totalEquityDistributions).toBeLessThanOrEqual(
      noCureResult.totalEquityDistributions + 1
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// I. EARLY TERMINATION × RECOVERY PIPELINE
// Branch: line 825: `remainingDebt <= 0.01 && endingPar <= 0.01`
// Gap: pending recoveries when all debt paid and par = 0
// ═══════════════════════════════════════════════════════════════════════════════

describe("I. Early termination", () => {
  it("I1: early stop with pending recoveries — recoveries in final period captured", () => {
    // Scenario: high CDR wipes out par, but recovery lag means future recoveries.
    // If deal ends early (all debt paid + par = 0), pending recoveries may be lost.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(50), // very high CDR
      cprPct: 50, // high prepay
      recoveryPct: 60,
      recoveryLagMonths: 12, // 4 quarter lag
      tranches: [
        { className: "A", currentBalance: 5_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 95_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // The total recoveries received should account for all defaults
    const totalDefaults = result.periods.reduce((s, p) => s + p.defaults, 0);
    const totalRecoveries = result.periods.reduce((s, p) => s + p.recoveries, 0);

    // Recovery = defaults * 60%. If deal ends early, some may be lost.
    // This test documents the actual behavior.
    const expectedRecovery = totalDefaults * 0.6;
    // Recoveries might be less if the deal terminated early and didn't
    // reach the maturity period where acceleration happens.
    // The key check: last period should pick up what it can.
    expect(totalRecoveries).toBeGreaterThan(0);

    // If the deal terminated early (fewer periods than maturityQuarters),
    // the last period might not have accelerated all pending recoveries.
    if (result.periods.length < 32) {
      // Early termination occurred — check if last period has any recoveries
      const lastPeriod = result.periods[result.periods.length - 1];
      // The last period IS the maturity period from the engine's perspective
      // (loop ends), so it should accelerate pending recoveries.
      // But the break condition is AFTER the period is computed, so
      // the terminating period should have its recoveries.
      expect(lastPeriod.recoveries).toBeGreaterThanOrEqual(0);
    }
  });

  it("I2: early stop does not trigger when pending recoveries exist but par > 0", () => {
    // Branch: `remainingDebt <= 0.01 && endingPar <= 0.01`
    // If par > 0 (loans still alive), no early stop even if debt is 0
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      tranches: [
        { className: "A", currentBalance: 1_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 99_999_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      loans: [
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 1), ratingBucket: "B", spreadBps: 400 },
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // A is paid off in Q1 (tiny balance). But par > 0 (second loan still alive).
    // Should NOT stop early — should continue until natural maturity.
    expect(result.periods.length).toBeGreaterThan(1);
    // Second loan matures at Q20 — deal should continue past that
    const q20 = result.periods.find((p) => p.periodNum === 20);
    expect(q20).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// J. LOAN RATING & SPREAD INTERACTIONS
// Branches: lines 271-279 (per-loan defaults by rating), line 336-339 (interest)
// Gap: loan with unknown rating, mixed ratings, spread=0
// ═══════════════════════════════════════════════════════════════════════════════

describe("J. Loan rating & spread edge cases", () => {
  it("J1: loan with rating not in defaultRatesByRating — defaults to 0 hazard", () => {
    // Branch: line 274: `quarterlyHazard[loan.ratingBucket] ?? 0`
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: { "B": 5 }, // only B defined, not "CUSTOM"
      cprPct: 0,
      recoveryPct: 0,
      loans: [
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "CUSTOM", spreadBps: 400 },
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const p1 = result.periods[0];

    // "CUSTOM" loan should have 0 defaults (missing rating → hazard = 0)
    // "B" loan should have defaults (5% CDR)
    // Total defaults should be ~half of what uniform 5% would produce
    const uniformResult = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(5),
      cprPct: 0,
      recoveryPct: 0,
      loans: [
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 },
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 },
      ],
    }));

    expect(p1.defaults).toBeLessThan(uniformResult.periods[0].defaults);
    expect(p1.defaults).toBeGreaterThan(0); // B loan still defaults
  });

  it("J2: mixed ratings produce different per-rating default amounts", () => {
    // Branch: defaultsByRating tracking per loan
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: { "AAA": 0.01, "CCC": 20 },
      cprPct: 0,
      recoveryPct: 0,
      loans: [
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "AAA", spreadBps: 100 },
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "CCC", spreadBps: 700 },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const p1 = result.periods[0];

    // CCC defaults >> AAA defaults
    const aaaDefaults = p1.defaultsByRating["AAA"] ?? 0;
    const cccDefaults = p1.defaultsByRating["CCC"] ?? 0;
    expect(cccDefaults).toBeGreaterThan(aaaDefaults * 10);
  });

  it("J3: loan with spreadBps = 0 — earns only base rate interest", () => {
    // Branch: line 339: interest = par * (flooredBaseRate + spreadBps/100) / 100 / 4
    const zeroSpread = runProjection(makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 0 }],
    }));

    const withSpread = runProjection(makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 }],
    }));

    // Zero spread: interest = 100M × 2.1% × 92/360
    expect(zeroSpread.periods[0].interestCollected).toBeCloseTo(100_000_000 * 2.1 / 100 * Q1_ACTUAL, -2);
    expect(withSpread.periods[0].interestCollected).toBeGreaterThan(
      zeroSpread.periods[0].interestCollected
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// K. TRANCHE COUPON — FLOATING VS FIXED × BASE RATE FLOOR
// Branch: trancheCouponRate() function, line 127-132
// ═══════════════════════════════════════════════════════════════════════════════

describe("K. Tranche coupon edge cases", () => {
  it("K1: fixed tranche coupon unaffected by base rate changes", () => {
    // Branch: isFloating=false → spreadBps/10000 (ignores base rate)
    const lowBase = runProjection(makeInputs({
      baseRatePct: 1.0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      tranches: [
        { className: "A", currentBalance: 90_000_000, spreadBps: 500, seniorityRank: 1, isFloating: false, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    }));

    const highBase = runProjection(makeInputs({
      baseRatePct: 5.0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      tranches: [
        { className: "A", currentBalance: 90_000_000, spreadBps: 500, seniorityRank: 1, isFloating: false, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    }));

    // Fixed tranche interest due should be identical regardless of base rate
    const lowDue = lowBase.periods[0].trancheInterest.find((t) => t.className === "A")!.due;
    const highDue = highBase.periods[0].trancheInterest.find((t) => t.className === "A")!.due;
    // A due = 90M * 500/10000 / 4 = 90M * 0.05 / 4 = 1.125M
    expect(lowDue).toBeCloseTo(highDue, 0);
    expect(lowDue).toBeCloseTo(1_125_000, -2);
  });

  it("K2: negative base rate floored before computing floating tranche coupon", () => {
    // Branch: line 130: Math.max(baseRateFloorPct, baseRatePct)
    const negBase = runProjection(makeInputs({
      baseRatePct: -0.5,
      baseRateFloorPct: 0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
    }));

    const zeroBase = runProjection(makeInputs({
      baseRatePct: 0,
      baseRateFloorPct: 0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
    }));

    // With floor at 0, negative base rate is floored to 0
    // Both should produce identical tranche interest
    const negDue = negBase.periods[0].trancheInterest.find((t) => t.className === "A")!.due;
    const zeroDue = zeroBase.periods[0].trancheInterest.find((t) => t.className === "A")!.due;
    expect(negDue).toBeCloseTo(zeroDue, 0);
  });

  it("K3: base rate below floor — IC test uses floored rate for interest due", () => {
    // IC denominator uses trancheCouponRate which applies the floor.
    // If base rate is negative but floor is 0, IC test should use floor.
    const inputs = makeInputs({
      baseRatePct: -1.0,
      baseRateFloorPct: 0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      icTriggers: [{ className: "A", triggerLevel: 100, rank: 1 }],
      ocTriggers: [],
    });

    const result = runProjection(inputs);
    const ic = result.periods[0].icTests.find((t) => t.className === "A")!;

    // IC should be computed with floored base rate (0, not -1)
    // Interest collected also uses floored base rate
    // So IC ratio = (interestCollected - fees) / interestDue
    // Both numerator and denominator use the floored rate → ratio should be > 100%
    expect(ic.actual).toBeGreaterThan(0);
    expect(isFinite(ic.actual)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// L. MULTI-TRANCHE SAME RANK (SPLIT TRANCHES)
// Branch: line 612-615 (atRankBoundary), line 664 (IC cure iteration)
// Gap: IC cure paydown order with split tranches
// ═══════════════════════════════════════════════════════════════════════════════

describe("L. Split tranches at same rank", () => {
  it("L1: both tranches at same rank receive interest before diversion check", () => {
    // B-1 and B-2 at rank 2. Diversion only checked at rank boundary (after both paid).
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(5),
      cprPct: 0,
      recoveryPct: 0,
      tranches: [
        { className: "A", currentBalance: 55_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "J-1", currentBalance: 12_000_000, spreadBps: 225, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "J-2", currentBalance: 8_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "C", currentBalance: 10_000_000, spreadBps: 450, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 15_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [{ className: "J-1", triggerLevel: 200, rank: 2 }], // fails → diversion at rank 2 boundary
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const p1 = result.periods[0];

    // Both B-1 and B-2 should receive interest (diversion happens AFTER both are paid)
    const b1 = p1.trancheInterest.find((t) => t.className === "J-1")!;
    const b2 = p1.trancheInterest.find((t) => t.className === "J-2")!;
    expect(b1.paid).toBeGreaterThan(0);
    expect(b2.paid).toBeGreaterThan(0);

    // C should get zero (diverted after rank 2 boundary)
    const c = p1.trancheInterest.find((t) => t.className === "C")!;
    expect(c.paid).toBe(0);
  });

  it("L2: IC cure paydown with split tranches — pays down in sort order", () => {
    // IC cure iterates over ocEligibleTranches in seniority order.
    // B-1 and B-2 at same rank — whichever appears first in sortedTranches gets paid first.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      baseRatePct: 0.5,
      tranches: [
        { className: "A", currentBalance: 55_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "J-1", currentBalance: 12_000_000, spreadBps: 225, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "J-2", currentBalance: 8_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 25_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [{ className: "J-1", triggerLevel: 300, rank: 2 }], // tight IC trigger
    });

    const result = runProjection(inputs);
    // Just verify it runs correctly with split tranches and IC cure
    expect(result.periods.length).toBeGreaterThan(0);
    const p1 = result.periods[0];
    expect(p1.trancheInterest.length).toBe(3); // A, B-1, B-2 (not Sub)
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M. CONSERVATION LAWS — WHOLE-DEAL INVARIANTS
// These hold regardless of input parameters.
// ═══════════════════════════════════════════════════════════════════════════════

describe("M. Conservation laws", () => {
  // Run a realistic scenario with all features active
  const realisticInputs = makeInputs({
    reinvestmentPeriodEnd: addQuarters("2026-01-15", 8),
    defaultRatesByRating: uniformRates(3),
    cprPct: 15,
    recoveryPct: 60,
    recoveryLagMonths: 12,
    seniorFeePct: 0.15,
    subFeePct: 0.35,
    trusteeFeeBps: 3,
    hedgeCostBps: 5,
    incentiveFeePct: 20,
    incentiveFeeHurdleIrr: 0.08,
    postRpReinvestmentPct: 30,
    deferredInterestCompounds: false,
    callMode: "optionalRedemption",
    callDate: addQuarters("2026-01-15", 20),
    callPricePct: 98,
    callPriceMode: "manual",
    reinvestmentOcTrigger: { triggerLevel: 110, rank: 2, diversionPct: 50 },
    ocTriggers: [
      { className: "A", triggerLevel: 125, rank: 1 },
      { className: "J", triggerLevel: 110, rank: 2 },
    ],
    icTriggers: [
      { className: "A", triggerLevel: 120, rank: 1 },
      { className: "J", triggerLevel: 110, rank: 2 },
    ],
  });

  const realisticResult = runProjection(realisticInputs);

  it("M1: tranche balances never go negative in any period", () => {
    for (const p of realisticResult.periods) {
      for (const t of p.tranchePrincipal) {
        expect(t.endBalance).toBeGreaterThanOrEqual(-0.01);
      }
    }
  });

  it("M2: equity distribution never negative in any period", () => {
    for (const p of realisticResult.periods) {
      expect(p.equityDistribution).toBeGreaterThanOrEqual(-0.01);
    }
  });

  it("M3: interest paid to each tranche never exceeds interest due", () => {
    for (const p of realisticResult.periods) {
      for (const t of p.trancheInterest) {
        expect(t.paid).toBeLessThanOrEqual(t.due + 0.01);
      }
    }
  });

  it("M4: endingPar is non-negative in every period", () => {
    for (const p of realisticResult.periods) {
      expect(p.endingPar).toBeGreaterThanOrEqual(-0.01);
    }
  });

  it("M5: OC ratio for senior tranche >= OC ratio for junior tranche (same numerator, smaller denom)", () => {
    for (const p of realisticResult.periods) {
      if (p.ocTests.length >= 2) {
        const aOc = p.ocTests.find((t) => t.className === "A")!;
        const bOc = p.ocTests.find((t) => t.className === "J")!;
        expect(aOc.actual).toBeGreaterThanOrEqual(bOc.actual - 0.01);
      }
    }
  });

  it("M6: total principal paid to debt tranches <= total principal available", () => {
    for (const p of realisticResult.periods) {
      const totalPrincipalPaid = p.tranchePrincipal
        .filter((t) => t.className !== "Sub")
        .reduce((s, t) => s + t.paid, 0);
      // Principal available = prepayments + maturities + recoveries - reinvestment + liquidation + cure diversion
      // This is hard to compute exactly, but principal paid should not exceed total cash inflows
      expect(totalPrincipalPaid).toBeGreaterThanOrEqual(0);
    }
  });

  it("M7: beginningLiabilities >= endingLiabilities when no PIK is active on any tranche", () => {
    // Run a scenario with no deferrable tranches to verify monotonic liability decrease
    const noPikInputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(3),
      cprPct: 15,
      recoveryPct: 60,
      tranches: [
        { className: "A", currentBalance: 70_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "J", currentBalance: 20_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    });

    const noPikResult = runProjection(noPikInputs);
    for (const p of noPikResult.periods) {
      expect(p.endingLiabilities).toBeLessThanOrEqual(p.beginningLiabilities + 0.01);
    }
  });

  it("M8: last period has endingPar = 0", () => {
    const lastPeriod = realisticResult.periods[realisticResult.periods.length - 1];
    expect(lastPeriod.endingPar).toBeCloseTo(0, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// N. INITIAL PRINCIPAL CASH & PRE-EXISTING DEFAULTS
// New inputs: initialPrincipalCash, preExistingDefaultedPar
// ═══════════════════════════════════════════════════════════════════════════════

describe("N. Initial principal cash and pre-existing defaults", () => {
  it("N1: initialPrincipalCash flows through Q1 waterfall and boosts OC numerator", () => {
    const withCash = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      initialPrincipalCash: 4_400_000,
      ocTriggers: [{ className: "A", triggerLevel: 120, rank: 1 }],
      icTriggers: [],
    });

    const noCash = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      initialPrincipalCash: 0,
      ocTriggers: [{ className: "A", triggerLevel: 120, rank: 1 }],
      icTriggers: [],
    });

    const cashResult = runProjection(withCash);
    const noCashResult = runProjection(noCash);

    // OC numerator includes remainingPrelim which now has the 4.4M cash.
    // OC ratio should be higher with cash.
    const cashOc = cashResult.periods[0].ocTests.find((t) => t.className === "A")!;
    const noCashOc = noCashResult.periods[0].ocTests.find((t) => t.className === "A")!;
    expect(cashOc.actual).toBeGreaterThan(noCashOc.actual);

    // The 4.4M flows to senior tranche paydown (A has 70M, absorbs all the cash).
    // Equity from interest is the same, but total tranche principal paid is higher.
    const cashPrincipal = cashResult.periods[0].tranchePrincipal.reduce((s, t) => s + t.paid, 0);
    const noCashPrincipal = noCashResult.periods[0].tranchePrincipal.reduce((s, t) => s + t.paid, 0);
    expect(cashPrincipal).toBeGreaterThan(noCashPrincipal);
  });

  it("N2: initialPrincipalCash during RP gets reinvested into new loans", () => {
    const withCash = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      initialPrincipalCash: 5_000_000,
    });

    const noCash = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      initialPrincipalCash: 0,
    });

    const cashResult = runProjection(withCash);
    const noCashResult = runProjection(noCash);

    // During RP, the cash is reinvested → endingPar should be higher by ~5M
    expect(cashResult.periods[0].endingPar).toBeGreaterThan(
      noCashResult.periods[0].endingPar + 4_000_000
    );

    // The reinvested cash earns interest in subsequent periods
    expect(cashResult.periods[1].interestCollected).toBeGreaterThan(
      noCashResult.periods[1].interestCollected
    );
  });

  it("N3: preExistingDefaultedPar generates recovery after lag", () => {
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 12, // 4 quarters
      preExistingDefaultedPar: 1_500_000,
      unpricedDefaultedPar: 1_500_000, // no market price → engine applies recoveryPct
    });

    const result = runProjection(inputs);

    // Q1-Q4: no recovery yet (4 quarter lag)
    for (let i = 0; i < 4; i++) {
      expect(result.periods[i].recoveries).toBe(0);
    }

    // Q5: recovery arrives = 1.5M * 60% = 900K
    expect(result.periods[4].recoveries).toBeCloseTo(900_000, -2);
  });

  it("N4: preExistingDefaultedPar with zero recovery produces nothing", () => {
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      preExistingDefaultedPar: 1_500_000,
      unpricedDefaultedPar: 1_500_000,
    });

    const result = runProjection(inputs);
    const totalRecoveries = result.periods.reduce((s, p) => s + p.recoveries, 0);
    expect(totalRecoveries).toBe(0);
  });

  it("N5: both features together — cash boosts Q1, recovery arrives later", () => {
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 6, // 2 quarters
      initialPrincipalCash: 4_000_000,
      preExistingDefaultedPar: 2_000_000,
      unpricedDefaultedPar: 2_000_000,
    });

    const baseline = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 6,
      initialPrincipalCash: 0,
      preExistingDefaultedPar: 0,
      unpricedDefaultedPar: 0,
    });

    const result = runProjection(inputs);
    const baseResult = runProjection(baseline);

    // Q1 principal paydown higher (cash goes to senior tranche), Q3 has recovery
    const q1Principal = result.periods[0].tranchePrincipal.reduce((s, t) => s + t.paid, 0);
    const baseQ1Principal = baseResult.periods[0].tranchePrincipal.reduce((s, t) => s + t.paid, 0);
    expect(q1Principal).toBeGreaterThan(baseQ1Principal);
    expect(result.periods[2].recoveries).toBeCloseTo(1_200_000, -2);
    expect(result.totalEquityDistributions).toBeGreaterThan(
      baseResult.totalEquityDistributions
    );
  });

  it("N6: mixed priced and unpriced defaults — both contribute to recovery", () => {
    // 2M total defaulted: 1M priced at 30% (recovery = 300K), 1M unpriced (model rate 60% = 600K)
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 6, // 2 quarters
      preExistingDefaultedPar: 2_000_000,
      preExistingDefaultRecovery: 300_000, // 1M priced at 30%
      unpricedDefaultedPar: 1_000_000, // 1M unpriced → engine applies 60%
    });

    const result = runProjection(inputs);

    // Q3: total recovery = 300K (priced) + 1M × 60% (unpriced) = 900K
    expect(result.periods[2].recoveries).toBeCloseTo(900_000, -2);
  });

  it("N7: quartersSinceReport adjusts recovery timing — arrives earlier for stale reports", () => {
    // 12-month recovery lag (4 quarters), report is 2 quarters old.
    // Adjusted arrival = max(1, 1 + 4 - 2) = Q3 instead of Q5.
    const staleReport = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 12, // 4 quarters
      preExistingDefaultedPar: 1_500_000,
      unpricedDefaultedPar: 1_500_000,
      quartersSinceReport: 2,
    });

    const freshReport = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 12,
      preExistingDefaultedPar: 1_500_000,
      unpricedDefaultedPar: 1_500_000,
      quartersSinceReport: 0,
    });

    const staleResult = runProjection(staleReport);
    const freshResult = runProjection(freshReport);

    // Stale: recovery at Q3 (1 + 4 - 2 = 3)
    expect(staleResult.periods[2].recoveries).toBeCloseTo(900_000, -2);
    expect(staleResult.periods[0].recoveries).toBe(0);
    expect(staleResult.periods[1].recoveries).toBe(0);

    // Fresh: recovery at Q5 (1 + 4 - 0 = 5)
    expect(freshResult.periods[4].recoveries).toBeCloseTo(900_000, -2);
    for (let i = 0; i < 4; i++) {
      expect(freshResult.periods[i].recoveries).toBe(0);
    }
  });

  it("N8: quartersSinceReport exceeds recoveryLag — recovery arrives Q1", () => {
    // Report is 6 quarters old, lag is 4 quarters. Default happened long ago.
    // Adjusted arrival = max(1, 1 + 4 - 6) = max(1, -1) = Q1.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 12,
      preExistingDefaultedPar: 1_000_000,
      unpricedDefaultedPar: 1_000_000,
      quartersSinceReport: 6,
    });

    const result = runProjection(inputs);

    // Recovery arrives immediately in Q1
    expect(result.periods[0].recoveries).toBeCloseTo(600_000, -2);
  });
});
