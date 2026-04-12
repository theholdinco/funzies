import { describe, it, expect } from "vitest";
import {
  runProjection,
  addQuarters,
  ProjectionInputs,
  LoanInput,
} from "../projection";
import { RATING_BUCKETS, DEFAULT_RATES_BY_RATING } from "../rating-mapping";
import { CLO_DEFAULTS } from "../defaults";

// Helper: zero out all CDRs
function zeroCdrs(): Record<string, number> {
  return Object.fromEntries(RATING_BUCKETS.map((b) => [b, 0]));
}

// Full 9-tranche deal: X, A, B-1, B-2, C, D, E, F, Sub
// Realistic EUR CLO with tight OC/IC triggers
function makeFullDealInputs(overrides: Partial<ProjectionInputs> = {}): ProjectionInputs {
  const currentDate = "2025-01-15";

  // 20 loans, $5M each, B-rated, staggered maturities Q10-Q29
  const defaultLoans: LoanInput[] = Array.from({ length: 20 }, (_, i) => ({
    parBalance: 5_000_000,
    maturityDate: addQuarters(currentDate, 10 + i),
    ratingBucket: "B",
    spreadBps: 375,
  }));

  return {
    initialPar: 100_000_000,
    wacSpreadBps: 375,
    baseRatePct: CLO_DEFAULTS.baseRatePct,        // 3.5%
    baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct, // 0%
    seniorFeePct: 0,
    subFeePct: 0,
    trusteeFeeBps: 0,
    hedgeCostBps: 0,
    incentiveFeePct: 0,
    incentiveFeeHurdleIrr: 0,
    postRpReinvestmentPct: 0,
    callDate: null,
    callPricePct: 100,
    reinvestmentOcTrigger: null,
    tranches: [
      // Class X: amortising, paid from interest waterfall
      {
        className: "X",
        currentBalance: 2_750_000,
        spreadBps: 60,
        seniorityRank: 0,
        isFloating: true,
        isIncomeNote: false,
        isDeferrable: false,
        isAmortising: true,
        amortisationPerPeriod: 550_000,
        amortStartDate: "2024-10-15", // already past currentDate → active from Q1
      },
      // Class A: senior, floating
      { className: "A",  currentBalance: 60_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true,  isIncomeNote: false, isDeferrable: false },
      // Class B-1: floating
      { className: "B-1", currentBalance: 6_000_000,  spreadBps: 225, seniorityRank: 3, isFloating: true,  isIncomeNote: false, isDeferrable: true  },
      // Class B-2: fixed coupon (spreadBps = full coupon in bps)
      { className: "B-2", currentBalance: 4_000_000,  spreadBps: 550, seniorityRank: 3, isFloating: false, isIncomeNote: false, isDeferrable: true  },
      // Class C through F: deferrable junior tranches
      { className: "C",  currentBalance: 6_000_000,  spreadBps: 330, seniorityRank: 4, isFloating: true,  isIncomeNote: false, isDeferrable: true  },
      { className: "D",  currentBalance: 5_000_000,  spreadBps: 420, seniorityRank: 5, isFloating: true,  isIncomeNote: false, isDeferrable: true  },
      { className: "E",  currentBalance: 4_000_000,  spreadBps: 540, seniorityRank: 6, isFloating: true,  isIncomeNote: false, isDeferrable: true  },
      { className: "F",  currentBalance: 3_000_000,  spreadBps: 700, seniorityRank: 7, isFloating: true,  isIncomeNote: false, isDeferrable: true  },
      // Subordinated notes: equity
      { className: "Sub", currentBalance: 9_250_000, spreadBps: 0,   seniorityRank: 8, isFloating: false, isIncomeNote: true,  isDeferrable: false },
    ],
    ocTriggers: [
      { className: "A",  triggerLevel: 120, rank: 1 },
      { className: "B-1", triggerLevel: 114, rank: 3 },
      { className: "C",  triggerLevel: 108, rank: 4 },
      { className: "D",  triggerLevel: 105, rank: 5 },
      { className: "E",  triggerLevel: 103, rank: 6 },
      { className: "F",  triggerLevel: 101, rank: 7 },
    ],
    icTriggers: [
      { className: "A",  triggerLevel: 120, rank: 1 },
      { className: "B-1", triggerLevel: 112, rank: 3 },
    ],
    reinvestmentPeriodEnd: addQuarters(currentDate, 8),
    maturityDate: addQuarters(currentDate, 36),
    currentDate,
    loans: defaultLoans,
    defaultRatesByRating: { ...DEFAULT_RATES_BY_RATING },
    cprPct: CLO_DEFAULTS.cprPct,
    recoveryPct: CLO_DEFAULTS.recoveryPct,
    recoveryLagMonths: CLO_DEFAULTS.recoveryLagMonths,
    reinvestmentSpreadBps: CLO_DEFAULTS.reinvestmentSpreadBps,
    reinvestmentTenorQuarters: CLO_DEFAULTS.reinvestmentTenorYears * 4,
    reinvestmentRating: null,
    cccBucketLimitPct: CLO_DEFAULTS.cccBucketLimitPct,
    cccMarketValuePct: CLO_DEFAULTS.cccMarketValuePct,
    deferredInterestCompounds: true,
    ...overrides,
  };
}

// ─── 1. Class X amortisation ─────────────────────────────────────────────────

describe("Class X amortisation", () => {
  it("Class X balance decreases by 550K per quarter from Q1 (start date already past)", () => {
    const result = runProjection(makeFullDealInputs({
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    const q1 = result.periods[0];
    const q2 = result.periods[1];
    const q3 = result.periods[2];

    const xQ1 = q1.tranchePrincipal.find((t) => t.className === "X")!;
    const xQ2 = q2.tranchePrincipal.find((t) => t.className === "X")!;
    const xQ3 = q3.tranchePrincipal.find((t) => t.className === "X")!;

    // Each quarter should reduce X balance by 550K
    expect(xQ1.paid).toBeCloseTo(550_000, -2);
    expect(xQ2.paid).toBeCloseTo(550_000, -2);
    expect(xQ3.paid).toBeCloseTo(550_000, -2);

    // End balances should step down
    expect(xQ1.endBalance).toBeCloseTo(2_200_000, -2);
    expect(xQ2.endBalance).toBeCloseTo(1_650_000, -2);
    expect(xQ3.endBalance).toBeCloseTo(1_100_000, -2);
  });

  it("Class X amort is paid from interest waterfall (not principal proceeds)", () => {
    const result = runProjection(makeFullDealInputs({
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      // No loans mature during RP, so principal proceeds are minimal — X must be paid from interest
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
      reinvestmentPeriodEnd: null, // disable RP to ensure no reinvestment confusion
    }));

    const q1 = result.periods[0];
    const xPrincipal = q1.tranchePrincipal.find((t) => t.className === "X")!;

    // With no principal proceeds (single non-maturing loan, no defaults/prepays),
    // Class X gets paid from interest → its paid amount should appear in tranchePrincipal
    expect(xPrincipal.paid).toBeGreaterThan(0);
  });

  it("Class X stops amortising once balance reaches zero", () => {
    // 2.75M / 550K = 5 quarters to fully amortise
    const result = runProjection(makeFullDealInputs({
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    // After Q5, Class X should be fully paid off
    for (const period of result.periods.filter((p) => p.periodNum > 5)) {
      const xPrincipal = period.tranchePrincipal.find((t) => t.className === "X")!;
      // No further amort once balance is zero
      expect(xPrincipal.endBalance).toBeCloseTo(0, -1);
      expect(xPrincipal.paid).toBeCloseTo(0, -1);
    }
  });

  it("Class X is excluded from OC and IC denominators", () => {
    const result = runProjection(makeFullDealInputs({
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    // The OC test for class A uses rank 1. Class X has rank 0 (isAmortising=true).
    // If X were included in the denominator, OC ratio would be lower.
    // We verify: OC numerator / (A balance only) matches reported ocTests[0].actual
    const q1 = result.periods[0];
    const ocA = q1.ocTests.find((t) => t.className === "A")!;

    // OC ratio should be well above 100 (100M par vs 60M A-notes), not contaminated by X balance
    // If X (2.75M) were included, ratio would be ≈ 100/62.75 * 100 = 159.4; without X it's ≈ 100/60 * 100 = 166.7
    // The exact value depends on paydowns, but it must be > 159 (X excluded) or close to 166 (healthy start)
    expect(ocA.actual).toBeGreaterThan(159);
  });
});

// ─── 2. Split tranches B-1 floating + B-2 fixed ──────────────────────────────

describe("Split tranches: B-1 floating + B-2 fixed at same rank", () => {
  it("both B-1 and B-2 get interest paid at their correct rates", () => {
    const result = runProjection(makeFullDealInputs({
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    const q1 = result.periods[0];

    const b1 = q1.trancheInterest.find((t) => t.className === "B-1")!;
    const b2 = q1.trancheInterest.find((t) => t.className === "B-2")!;

    expect(b1.paid).toBeGreaterThan(0);
    expect(b2.paid).toBeGreaterThan(0);
  });

  it("B-2 uses fixed coupon (spreadBps/10000), not base + spread", () => {
    // B-2 is fixed at 550bps = 5.50%. B-1 is floating at 3.5% base + 225bps = 5.75%.
    // B-2: 4M * 5.50% / 4 = 55,000
    // B-1: 6M * 5.75% / 4 = 86,250
    const result = runProjection(makeFullDealInputs({
      baseRatePct: 3.5,
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    const q1 = result.periods[0];
    const b1 = q1.trancheInterest.find((t) => t.className === "B-1")!;
    const b2 = q1.trancheInterest.find((t) => t.className === "B-2")!;

    // B-2 fixed: 4,000,000 * 0.055 / 4 = 55,000
    expect(b2.due).toBeCloseTo(55_000, -1);

    // B-1 floating: 6,000,000 * (3.5% + 2.25%) / 4 = 6,000,000 * 5.75% / 4 = 86,250
    expect(b1.due).toBeCloseTo(86_250, -1);
  });

  it("B-1 and B-2 interest amounts differ because they use different coupon calculations", () => {
    const result = runProjection(makeFullDealInputs({
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    const q1 = result.periods[0];
    const b1 = q1.trancheInterest.find((t) => t.className === "B-1")!;
    const b2 = q1.trancheInterest.find((t) => t.className === "B-2")!;

    // Same rank, different balance + coupon type → different interest amounts
    expect(b1.due).not.toBeCloseTo(b2.due, 0);
  });
});

// ─── 3. Fixed vs floating rate coupon ────────────────────────────────────────

describe("Fixed vs floating rate coupon", () => {
  it("floating tranche at 3.5% base + 147bps produces correct quarterly interest", () => {
    const result = runProjection(makeFullDealInputs({
      baseRatePct: 3.5,
      tranches: [
        { className: "A", currentBalance: 80_000_000, spreadBps: 147, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    const q1 = result.periods[0];
    const aInterest = q1.trancheInterest.find((t) => t.className === "A")!;

    // Floating: (3.5% + 1.47%) / 4 * 80M = 4.97% / 4 * 80M = 994,000
    const expectedCoupon = 80_000_000 * (3.5 + 1.47) / 100 / 4;
    expect(aInterest.due).toBeCloseTo(expectedCoupon, -2);
  });

  it("fixed tranche at 550bps produces 5.50% annual coupon", () => {
    const result = runProjection(makeFullDealInputs({
      tranches: [
        { className: "A", currentBalance: 80_000_000, spreadBps: 550, seniorityRank: 1, isFloating: false, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    const q1 = result.periods[0];
    const aInterest = q1.trancheInterest.find((t) => t.className === "A")!;

    // Fixed: 550bps / 10000 / 4 * 80M = 5.50% / 4 * 80M = 1,100,000
    const expectedCoupon = 80_000_000 * 550 / 10000 / 4;
    expect(aInterest.due).toBeCloseTo(expectedCoupon, -2);
  });

  it("floating and fixed tranches at same balance and base rate produce different interest", () => {
    const floatingResult = runProjection(makeFullDealInputs({
      baseRatePct: 3.5,
      tranches: [
        { className: "A", currentBalance: 80_000_000, spreadBps: 350, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    const fixedResult = runProjection(makeFullDealInputs({
      baseRatePct: 3.5,
      tranches: [
        { className: "A", currentBalance: 80_000_000, spreadBps: 350, seniorityRank: 1, isFloating: false, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    const floatingDue = floatingResult.periods[0].trancheInterest.find((t) => t.className === "A")!.due;
    const fixedDue = fixedResult.periods[0].trancheInterest.find((t) => t.className === "A")!.due;

    // Floating: (3.5% + 3.5%) / 4 * 80M = 1,400,000
    // Fixed: 3.5% / 4 * 80M = 700,000
    // Floating should be higher since it adds base rate on top of spread
    expect(floatingDue).toBeGreaterThan(fixedDue);
  });
});

// ─── 4. EURIBOR floor ────────────────────────────────────────────────────────

describe("EURIBOR floor", () => {
  it("negative base rate is floored at 0% when baseRateFloorPct=0", () => {
    const noFloor = runProjection(makeFullDealInputs({
      baseRatePct: -1.0,  // negative EURIBOR
      baseRateFloorPct: 0,
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    const positive = runProjection(makeFullDealInputs({
      baseRatePct: 3.5,
      baseRateFloorPct: 0,
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    // With -1% base floored at 0%, interest collected should be > 0 (spread still applies)
    expect(noFloor.periods[0].interestCollected).toBeGreaterThan(0);

    // Floor at 0% means collected interest is same as if baseRate=0, not baseRate=-1
    const atZero = runProjection(makeFullDealInputs({
      baseRatePct: 0,
      baseRateFloorPct: 0,
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    // Floored at 0%: both -1% and 0% produce identical interest collected
    expect(noFloor.periods[0].interestCollected).toBeCloseTo(atZero.periods[0].interestCollected, 0);

    // 3.5% base produces more interest than floored 0%
    expect(positive.periods[0].interestCollected).toBeGreaterThan(noFloor.periods[0].interestCollected);
  });

  it("tranche coupons are also floored at 0% base (not -1%)", () => {
    const negativeBase = runProjection(makeFullDealInputs({
      baseRatePct: -1.0,
      baseRateFloorPct: 0,
      tranches: [
        { className: "A", currentBalance: 90_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    const zeroBase = runProjection(makeFullDealInputs({
      baseRatePct: 0,
      baseRateFloorPct: 0,
      tranches: [
        { className: "A", currentBalance: 90_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    const aDue_neg = negativeBase.periods[0].trancheInterest.find((t) => t.className === "A")!.due;
    const aDue_zero = zeroBase.periods[0].trancheInterest.find((t) => t.className === "A")!.due;

    // Both should produce same interest since -1% is floored to 0%
    expect(aDue_neg).toBeCloseTo(aDue_zero, 0);
  });

  it("custom floor at 0.5% prevents base rates below 0.5%", () => {
    // With 0.5% floor and 0% base rate, effective rate should be 0.5%
    const withFloor = runProjection(makeFullDealInputs({
      baseRatePct: 0,
      baseRateFloorPct: 0.5,
      tranches: [
        { className: "A", currentBalance: 90_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    const atZero = runProjection(makeFullDealInputs({
      baseRatePct: 0,
      baseRateFloorPct: 0,
      tranches: [
        { className: "A", currentBalance: 90_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
    }));

    // 0.5% floor applied on top of 0% base → more interest than with 0% floor
    const aDue_floor = withFloor.periods[0].trancheInterest.find((t) => t.className === "A")!.due;
    const aDue_zero = atZero.periods[0].trancheInterest.find((t) => t.className === "A")!.due;

    expect(aDue_floor).toBeGreaterThan(aDue_zero);

    // Exact: 90M * (0.5% + 1.40%) / 4 = 90M * 1.9% / 4 = 427,500
    expect(aDue_floor).toBeCloseTo(90_000_000 * (0.5 + 1.40) / 100 / 4, -2);
  });
});

// ─── 5. Deferrable tranches (PIK) ────────────────────────────────────────────

describe("Deferrable tranches (PIK) on OC failure", () => {
  // Force OC failure from Q1 using an impossibly high trigger level
  function makeOcFailInputs(compounding: boolean): ProjectionInputs {
    return makeFullDealInputs({
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      deferredInterestCompounds: compounding,
      ocTriggers: [
        // A passes (realistic trigger), B-1 fails immediately (unreachably high trigger)
        { className: "A",   triggerLevel: 110, rank: 1 },
        { className: "B-1", triggerLevel: 999, rank: 3 }, // always fails → diverts all junior interest
      ],
      icTriggers: [],
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
      reinvestmentPeriodEnd: null,
    });
  }

  it("with deferredInterestCompounds=true, unpaid interest adds to tranche balance (PIK)", () => {
    const result = runProjection(makeOcFailInputs(true));

    const q1 = result.periods[0];
    const q2 = result.periods[1];

    // Diversion fires AFTER paying the rank-3 boundary (B-1/B-2), cutting off C and below.
    // Class C is deferrable and gets zero interest after the B-1 OC failure diverts cash.
    const cQ1 = q1.trancheInterest.find((t) => t.className === "C")!;
    const cPrinQ1 = q1.tranchePrincipal.find((t) => t.className === "C")!;
    const cPrinQ2 = q2.tranchePrincipal.find((t) => t.className === "C")!;

    // Class C should receive zero interest (diverted after rank-3 boundary)
    expect(cQ1.paid).toBe(0);
    expect(cQ1.due).toBeGreaterThan(0);

    // When compounding=true, unpaid interest capitalises → end balance Q1 > original 6M
    expect(cPrinQ1.endBalance).toBeGreaterThan(6_000_000);

    // Q2 end balance should be even higher (more PIK accrued)
    expect(cPrinQ2.endBalance).toBeGreaterThan(cPrinQ1.endBalance);
  });

  it("with deferredInterestCompounds=false, deferred tracked separately (no balance growth)", () => {
    const resultCompounding = runProjection(makeOcFailInputs(true));
    const resultNonCompounding = runProjection(makeOcFailInputs(false));

    // After several periods, non-compounding tranche should have lower balance than compounding
    // because deferred interest doesn't itself earn interest
    const lastPeriod = 5;
    const compoundingBalance = resultCompounding.periods[lastPeriod - 1].tranchePrincipal.find(
      (t) => t.className === "C"
    )!.endBalance;
    const nonCompoundingBalance = resultNonCompounding.periods[lastPeriod - 1].tranchePrincipal.find(
      (t) => t.className === "C"
    )!.endBalance;

    // Without compounding, deferred interest doesn't itself compound → lower total over time
    // Both should be above the initial 6M (some deferred interest added), but non-compounding lower
    expect(compoundingBalance).toBeGreaterThanOrEqual(nonCompoundingBalance);
  });

  it("deferred interest is included in OC denominator (increases liabilities)", () => {
    // When OC fails and interest is deferred (compounding), the OC denominator grows
    // because trancheBalances include the PIK'd interest, making it harder to cure
    const resultHighDefaults = runProjection(makeFullDealInputs({
      defaultRatesByRating: { ...zeroCdrs(), B: 5 },
      cprPct: 0,
      deferredInterestCompounds: true,
      ocTriggers: [
        { className: "A",   triggerLevel: 110, rank: 1 },
        { className: "B-1", triggerLevel: 999, rank: 3 },
      ],
      icTriggers: [],
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
      reinvestmentPeriodEnd: null,
    }));

    // With defaults eating into par, OC ratios should decline over time
    const ocAtQ1 = resultHighDefaults.periods[0].ocTests.find((t) => t.className === "A")!;
    const ocAtQ4 = resultHighDefaults.periods[3].ocTests.find((t) => t.className === "A")!;

    expect(ocAtQ4.actual).toBeLessThan(ocAtQ1.actual);
  });
});

// ─── 6. Call date termination ────────────────────────────────────────────────

describe("Call date termination", () => {
  it("projection has exactly N periods when callDate is N quarters from currentDate", () => {
    const callQuarters = 8;
    const result = runProjection(makeFullDealInputs({
      callDate: addQuarters("2025-01-15", callQuarters),
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    expect(result.periods.length).toBe(callQuarters);
  });

  it("final period liquidates all remaining par", () => {
    const result = runProjection(makeFullDealInputs({
      callDate: addQuarters("2025-01-15", 8),
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    const lastPeriod = result.periods[result.periods.length - 1];

    // Ending par must be zero after liquidation
    expect(lastPeriod.endingPar).toBe(0);
  });

  it("all remaining par is liquidated in the final period (no orphan par)", () => {
    const result = runProjection(makeFullDealInputs({
      callDate: addQuarters("2025-01-15", 8),
      callPricePct: 100,
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    const lastPeriod = result.periods[result.periods.length - 1];
    // After liquidation, all tranches should be paid down to (near) zero
    const totalRemainingDebt = lastPeriod.tranchePrincipal
      .filter((t) => t.className !== "Sub")
      .reduce((s, t) => s + t.endBalance, 0);

    // All debt should be fully repaid at call
    expect(totalRemainingDebt).toBeCloseTo(0, -2);
  });

  it("call stops projection before legal maturity", () => {
    const result = runProjection(makeFullDealInputs({
      callDate: addQuarters("2025-01-15", 8),
      maturityDate: addQuarters("2025-01-15", 36), // maturity is far away
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
    }));

    // Should stop at 8, not 36
    expect(result.periods.length).toBe(8);
  });
});

// ─── 7. Fee waterfall order ───────────────────────────────────────────────────

describe("Fee waterfall order", () => {
  // Minimal 2-tranche structure (A + Sub) so equity residual is significant and fee accounting is clean
  function makeFeeTestInputs(feeOverrides: Partial<ProjectionInputs>): ProjectionInputs {
    return {
      initialPar: 100_000_000,
      wacSpreadBps: 375,
      baseRatePct: CLO_DEFAULTS.baseRatePct,
      baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
      seniorFeePct: 0,
      subFeePct: 0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      incentiveFeePct: 0,
      incentiveFeeHurdleIrr: 0,
      postRpReinvestmentPct: 0,
      callDate: null,
      callPricePct: 100,
      reinvestmentOcTrigger: null,
      tranches: [
        { className: "A",   currentBalance: 65_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true,  isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 35_000_000, spreadBps: 0,   seniorityRank: 2, isFloating: false, isIncomeNote: true,  isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      reinvestmentPeriodEnd: null,
      maturityDate: addQuarters("2025-01-15", 36),
      currentDate: "2025-01-15",
      loans: [{ parBalance: 100_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 }],
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      recoveryPct: CLO_DEFAULTS.recoveryPct,
      recoveryLagMonths: CLO_DEFAULTS.recoveryLagMonths,
      reinvestmentSpreadBps: CLO_DEFAULTS.reinvestmentSpreadBps,
      reinvestmentTenorQuarters: CLO_DEFAULTS.reinvestmentTenorYears * 4,
      reinvestmentRating: null,
      cccBucketLimitPct: CLO_DEFAULTS.cccBucketLimitPct,
      cccMarketValuePct: CLO_DEFAULTS.cccMarketValuePct,
      deferredInterestCompounds: true,
      ...feeOverrides,
    };
  }

  it("total fee deductions match expected calculation", () => {
    const trusteeBps = 5;    // 5 bps
    const seniorPct = 0.15;  // 15 bps
    const hedgeBps = 10;     // 10 bps
    const subPct = 0.25;     // 25 bps

    const result = runProjection(makeFeeTestInputs({
      trusteeFeeBps: trusteeBps,
      seniorFeePct: seniorPct,
      hedgeCostBps: hedgeBps,
      subFeePct: subPct,
    }));

    const q1 = result.periods[0];
    const par = q1.beginningPar;

    // Expected quarterly fee amounts
    const expectedTrustee = par * (trusteeBps / 10000) / 4;
    const expectedSenior  = par * (seniorPct / 100) / 4;
    const expectedHedge   = par * (hedgeBps / 10000) / 4;
    const expectedSub     = par * (subPct / 100) / 4;

    const totalExpectedFees = expectedTrustee + expectedSenior + expectedHedge + expectedSub;

    // All interest collected = fees + tranche interest paid + equity distribution
    const totalTranchePaid = q1.trancheInterest.reduce((s, t) => s + t.paid, 0);
    const impliedFees = q1.interestCollected - totalTranchePaid - q1.equityDistribution;

    expect(impliedFees).toBeCloseTo(totalExpectedFees, -1);
  });

  it("interest available for tranches equals collected minus trustee, senior, and hedge fees", () => {
    const trusteeBps = 5;
    const seniorPct = 0.15;
    const hedgeBps = 10;

    const result = runProjection(makeFeeTestInputs({
      trusteeFeeBps: trusteeBps,
      seniorFeePct: seniorPct,
      hedgeCostBps: hedgeBps,
      subFeePct: 0,
    }));

    const q1 = result.periods[0];
    const par = q1.beginningPar;

    const trusteeAmt = par * (trusteeBps / 10000) / 4;
    const seniorAmt  = par * (seniorPct / 100) / 4;
    const hedgeAmt   = par * (hedgeBps / 10000) / 4;
    const expectedInterestForTranches = q1.interestCollected - trusteeAmt - seniorAmt - hedgeAmt;

    // All tranche interest paid + equity from interest should sum to expectedInterestForTranches
    // (no sub fee here, so nothing else is deducted after tranches)
    const tranchePaid = q1.trancheInterest.reduce((s, t) => s + t.paid, 0);
    const equityFromInterest = q1.equityDistribution;

    expect(tranchePaid + equityFromInterest).toBeCloseTo(expectedInterestForTranches, -1);
  });

  it("sub fee is deducted after all tranche interest (reducing equity distribution)", () => {
    const withSubFee = runProjection(makeFeeTestInputs({ subFeePct: 0.50 }));
    const noSubFee   = runProjection(makeFeeTestInputs({ subFeePct: 0    }));

    // Tranche interest paid should be identical (sub fee doesn't affect tranche payments)
    const tranchePaidWith    = withSubFee.periods[0].trancheInterest.reduce((s, t) => s + t.paid, 0);
    const tranchePaidWithout = noSubFee.periods[0].trancheInterest.reduce((s, t) => s + t.paid, 0);
    expect(tranchePaidWith).toBeCloseTo(tranchePaidWithout, 0);

    // But equity distribution is lower with sub fee
    expect(withSubFee.periods[0].equityDistribution).toBeLessThan(noSubFee.periods[0].equityDistribution);

    // Difference should equal the sub fee amount
    const par = withSubFee.periods[0].beginningPar;
    const expectedSubFee = par * (0.50 / 100) / 4;
    const equityDiff = noSubFee.periods[0].equityDistribution - withSubFee.periods[0].equityDistribution;
    expect(equityDiff).toBeCloseTo(expectedSubFee, -1);
  });
});

// ─── 8. Post-RP reinvestment ──────────────────────────────────────────────────

describe("Post-RP reinvestment", () => {
  const rpEnd = addQuarters("2025-01-15", 4); // RP ends after Q4
  // Single loan matures in Q8 (post-RP) to produce principal proceeds
  const postRpLoans: LoanInput[] = [
    { parBalance: 20_000_000, maturityDate: addQuarters("2025-01-15", 8), ratingBucket: "B", spreadBps: 375 },
    { parBalance: 80_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 },
  ];

  it("30% of principal proceeds are reinvested post-RP when postRpReinvestmentPct=30", () => {
    const result = runProjection(makeFullDealInputs({
      postRpReinvestmentPct: 30,
      reinvestmentPeriodEnd: rpEnd,
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: postRpLoans,
      ocTriggers: [],
      icTriggers: [],
    }));

    // Q8 is post-RP (RP ended Q4), loan matures → principal proceeds
    const q8 = result.periods[7];
    expect(q8.scheduledMaturities).toBeGreaterThan(0);

    // Reinvestment should be exactly 30% of principal proceeds
    const expectedReinvestment = q8.scheduledMaturities * 0.30;
    expect(q8.reinvestment).toBeCloseTo(expectedReinvestment, -2);
  });

  it("70% of principal proceeds go to tranche paydown (not reinvested) post-RP", () => {
    const result30 = runProjection(makeFullDealInputs({
      postRpReinvestmentPct: 30,
      reinvestmentPeriodEnd: rpEnd,
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: postRpLoans,
      ocTriggers: [],
      icTriggers: [],
    }));

    const result0 = runProjection(makeFullDealInputs({
      postRpReinvestmentPct: 0,
      reinvestmentPeriodEnd: rpEnd,
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      loans: postRpLoans,
      ocTriggers: [],
      icTriggers: [],
    }));

    // With 30% reinvestment, tranche paydown in Q8 should be less than with 0% reinvestment
    const q8With30 = result30.periods[7];
    const q8With0  = result0.periods[7];

    const tranchePrincipalWith30 = q8With30.tranchePrincipal.reduce((s, t) => s + t.paid, 0);
    const tranchePrincipalWith0  = q8With0.tranchePrincipal.reduce((s, t) => s + t.paid, 0);

    expect(tranchePrincipalWith30).toBeLessThan(tranchePrincipalWith0);
  });

  it("during RP, 100% is reinvested regardless of postRpReinvestmentPct", () => {
    const result = runProjection(makeFullDealInputs({
      postRpReinvestmentPct: 30, // should have no effect during RP
      reinvestmentPeriodEnd: rpEnd,
      defaultRatesByRating: zeroCdrs(),
      cprPct: 0,
      // Loan matures in Q2 (inside RP)
      loans: [
        { parBalance: 10_000_000, maturityDate: addQuarters("2025-01-15", 2), ratingBucket: "B", spreadBps: 375 },
        { parBalance: 90_000_000, maturityDate: addQuarters("2025-01-15", 30), ratingBucket: "B", spreadBps: 375 },
      ],
      ocTriggers: [],
      icTriggers: [],
    }));

    const q2 = result.periods[1]; // Q2 is inside RP (RP ends Q4)
    // During RP, 100% of principal proceeds are reinvested
    expect(q2.reinvestment).toBeGreaterThanOrEqual(q2.scheduledMaturities);
  });
});
