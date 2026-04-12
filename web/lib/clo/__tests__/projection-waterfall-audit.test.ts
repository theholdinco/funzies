import { describe, it, expect } from "vitest";
import {
  runProjection,
  addQuarters,
  ProjectionInputs,
  LoanInput,
} from "../projection";
import { RATING_BUCKETS } from "../rating-mapping";
import { CLO_DEFAULTS } from "../defaults";

function uniformRates(cdr: number): Record<string, number> {
  return Object.fromEntries(RATING_BUCKETS.map((b) => [b, cdr]));
}

function makeInputs(overrides: Partial<ProjectionInputs> = {}): ProjectionInputs {
  const currentDate = "2026-01-15";
  const loans: LoanInput[] = Array.from({ length: 10 }, (_, i) => ({
    parBalance: 10_000_000,
    maturityDate: addQuarters(currentDate, 12 + i),
    ratingBucket: "B",
    spreadBps: 400,
  }));

  return {
    initialPar: 100_000_000,
    wacSpreadBps: 400,
    baseRatePct: 3.5,
    baseRateFloorPct: 0,
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
      { className: "A", currentBalance: 70_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
      { className: "B", currentBalance: 20_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
      { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
    ],
    ocTriggers: [],
    icTriggers: [],
    reinvestmentPeriodEnd: addQuarters(currentDate, 8),
    maturityDate: addQuarters(currentDate, 32),
    currentDate,
    loans,
    defaultRatesByRating: uniformRates(2),
    cprPct: 0,
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

// ─── Task 1: OC cure RP behavior — document modeling convention ─────────────

describe("OC cure RP convention: buy collateral (not paydown)", () => {
  it("MODELING CONVENTION: OC-only cure during RP increases par (buys collateral), does not pay down notes", () => {
    const inputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(8),
      cprPct: 0,
      recoveryPct: 0,
      ocTriggers: [{ className: "B", triggerLevel: 130, rank: 2 }],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const failPeriod = result.periods.find((p) =>
      p.ocTests.some((t) => t.className === "B" && !t.passing)
    );

    expect(failPeriod).toBeDefined();
    if (failPeriod) {
      const parWithoutCure = failPeriod.beginningPar - failPeriod.defaults - failPeriod.prepayments + failPeriod.reinvestment;
      expect(failPeriod.endingPar).toBeGreaterThanOrEqual(parWithoutCure - 1);
    }
  });

  it("MODELING CONVENTION: OC+IC cure during RP uses paydown (not buy collateral)", () => {
    const inputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(8),
      cprPct: 0,
      recoveryPct: 0,
      baseRatePct: 0.5,
      ocTriggers: [{ className: "B", triggerLevel: 130, rank: 2 }],
      icTriggers: [{ className: "B", triggerLevel: 999, rank: 2 }],
    });

    const ocOnlyInputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(8),
      cprPct: 0,
      recoveryPct: 0,
      baseRatePct: 0.5,
      ocTriggers: [{ className: "B", triggerLevel: 130, rank: 2 }],
      icTriggers: [],
    });

    const bothResult = runProjection(inputs);
    const ocOnlyResult = runProjection(ocOnlyInputs);

    const bothP1 = bothResult.periods[0];
    const ocP1 = ocOnlyResult.periods[0];

    expect(bothP1.endingPar).toBeLessThanOrEqual(ocP1.endingPar + 1);
    expect(bothP1.endingLiabilities).toBeLessThanOrEqual(ocP1.endingLiabilities + 1);
  });
});

// ─── Task 2: Three-regime incentive fee ─────────────────────────────────────

describe("Incentive fee three-regime behavior", () => {
  it("Regime 1: pre-fee IRR below hurdle → no fee taken", () => {
    const withFee = runProjection(makeInputs({
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: 0.99,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    const noFee = runProjection(makeInputs({
      incentiveFeePct: 0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    expect(withFee.totalEquityDistributions).toBeCloseTo(noFee.totalEquityDistributions, 0);
  });

  it("Regime 2: full fee leaves IRR well above hurdle → take full feePct of residual", () => {
    const withFee = runProjection(makeInputs({
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: 0.001,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    const noFee = runProjection(makeInputs({
      incentiveFeePct: 0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    const ratio = withFee.totalEquityDistributions / noFee.totalEquityDistributions;
    expect(ratio).toBeGreaterThan(0.70);
    expect(ratio).toBeLessThan(0.90);

    expect(withFee.equityIrr).not.toBeNull();
    expect(withFee.equityIrr!).toBeGreaterThan(0.05);
  });

  it("Regime 3: full fee would breach hurdle → bisect to preserve hurdle IRR", () => {
    const noFee = runProjection(makeInputs({
      incentiveFeePct: 0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 10,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    const preFeeIrr = noFee.equityIrr;
    expect(preFeeIrr).not.toBeNull();

    const hurdle = preFeeIrr! * 0.90;

    const withFee = runProjection(makeInputs({
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: hurdle,
      defaultRatesByRating: uniformRates(0),
      cprPct: 10,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    expect(withFee.equityIrr).not.toBeNull();
    expect(withFee.equityIrr!).toBeGreaterThanOrEqual(hurdle - 0.005);

    expect(withFee.totalEquityDistributions).toBeLessThan(noFee.totalEquityDistributions);

    const fullFeeResult = runProjection(makeInputs({
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: 0.001,
      defaultRatesByRating: uniformRates(0),
      cprPct: 10,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    expect(withFee.totalEquityDistributions).toBeGreaterThan(fullFeeResult.totalEquityDistributions);
  });
});

// ─── Task 3: Sequential principal paydown order ─────────────────────────────

describe("Principal paydown is sequential (senior-first), not pro-rata", () => {
  it("Class A fully paid before any principal goes to Class B", () => {
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      loans: [
        { parBalance: 40_000_000, maturityDate: addQuarters("2026-01-15", 2), ratingBucket: "B", spreadBps: 400 },
        { parBalance: 60_000_000, maturityDate: addQuarters("2026-01-15", 4), ratingBucket: "B", spreadBps: 400 },
      ],
      tranches: [
        { className: "A", currentBalance: 50_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 30_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    const q2 = result.periods.find((p) => p.periodNum === 2)!;
    const aPrinQ2 = q2.tranchePrincipal.find((t) => t.className === "A")!;
    const bPrinQ2 = q2.tranchePrincipal.find((t) => t.className === "B")!;
    expect(aPrinQ2.paid).toBeCloseTo(40_000_000, -3);
    expect(bPrinQ2.paid).toBeCloseTo(0, -1);
    expect(aPrinQ2.endBalance).toBeCloseTo(10_000_000, -3);

    const q4 = result.periods.find((p) => p.periodNum === 4)!;
    const aPrinQ4 = q4.tranchePrincipal.find((t) => t.className === "A")!;
    const bPrinQ4 = q4.tranchePrincipal.find((t) => t.className === "B")!;
    expect(aPrinQ4.endBalance).toBeCloseTo(0, -1);
    expect(bPrinQ4.endBalance).toBeCloseTo(0, -1);
    expect(q4.equityDistribution).toBeGreaterThan(15_000_000);
  });

  it("Class B receives zero principal until Class A is fully retired", () => {
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      loans: Array.from({ length: 8 }, (_, i) => ({
        parBalance: 12_500_000,
        maturityDate: addQuarters("2026-01-15", i + 1),
        ratingBucket: "B",
        spreadBps: 400,
      })),
      tranches: [
        { className: "A", currentBalance: 35_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 20_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 45_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    for (const p of result.periods) {
      const aEnd = p.tranchePrincipal.find((t) => t.className === "A")!.endBalance;
      const bPaid = p.tranchePrincipal.find((t) => t.className === "B")!.paid;
      if (aEnd > 1_000) {
        expect(bPaid).toBeCloseTo(0, -1);
      }
    }
  });
});

// ─── Task 4: Fee waterfall priority ─────────────────────────────────────────

describe("Fee waterfall priority order", () => {
  it("trustee fee is senior to tranche interest (paid even when interest barely covers fees)", () => {
    const highTrustee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      trusteeFeeBps: 400,
      seniorFeePct: 0,
      hedgeCostBps: 0,
      subFeePct: 0,
      ocTriggers: [],
      icTriggers: [],
    }));

    const noTrustee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      trusteeFeeBps: 0,
      seniorFeePct: 0,
      hedgeCostBps: 0,
      subFeePct: 0,
      ocTriggers: [],
      icTriggers: [],
    }));

    const q1High = highTrustee.periods[0];
    const q1None = noTrustee.periods[0];

    const totalToDebtHigh = q1High.trancheInterest.reduce((s, t) => s + t.paid, 0) + q1High.equityDistribution;
    const totalToDebtNone = q1None.trancheInterest.reduce((s, t) => s + t.paid, 0) + q1None.equityDistribution;

    expect(totalToDebtNone - totalToDebtHigh).toBeCloseTo(1_000_000, -3);
  });

  it("senior fee is deducted before tranche interest calculation (reduces IC numerator)", () => {
    const withFee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      seniorFeePct: 1.0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      icTriggers: [{ className: "A", triggerLevel: 100, rank: 1 }],
      ocTriggers: [],
    }));

    const noFee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      seniorFeePct: 0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      icTriggers: [{ className: "A", triggerLevel: 100, rank: 1 }],
      ocTriggers: [],
    }));

    const icWithFee = withFee.periods[0].icTests[0].actual;
    const icNoFee = noFee.periods[0].icTests[0].actual;

    expect(icWithFee).toBeLessThan(icNoFee);
  });

  it("sub fee is junior to tranche interest (tranches paid first)", () => {
    const result = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      seniorFeePct: 0,
      subFeePct: 5.0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      ocTriggers: [],
      icTriggers: [],
    }));

    const noSubFee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      seniorFeePct: 0,
      subFeePct: 0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      ocTriggers: [],
      icTriggers: [],
    }));

    const aInterest = result.periods[0].trancheInterest.find((t) => t.className === "A")!;
    const aInterestNoFee = noSubFee.periods[0].trancheInterest.find((t) => t.className === "A")!;
    expect(aInterest.paid).toBeCloseTo(aInterestNoFee.paid, 0);

    expect(result.periods[0].equityDistribution).toBeLessThan(
      noSubFee.periods[0].equityDistribution
    );
  });
});
