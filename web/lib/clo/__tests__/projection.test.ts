import { describe, it, expect } from "vitest";
import {
  validateInputs,
  runProjection,
  calculateIrr,
  addQuarters,
  ProjectionInputs,
  LoanInput,
} from "../projection";
import { RATING_BUCKETS, DEFAULT_RATES_BY_RATING } from "../rating-mapping";

// Helper: set all rating buckets to the same CDR (equivalent to old single cdrPct)
function uniformRates(cdr: number): Record<string, number> {
  return Object.fromEntries(RATING_BUCKETS.map((b) => [b, cdr]));
}

function makeInputs(overrides: Partial<ProjectionInputs> = {}): ProjectionInputs {
  // Default: 10 loans, all B-rated, $10M each, staggered maturities Q8-Q17
  const defaultLoans: LoanInput[] = Array.from({ length: 10 }, (_, i) => ({
    parBalance: 10_000_000,
    maturityDate: addQuarters("2026-03-09", 8 + i),
    ratingBucket: "B",
    spreadBps: 375,
  }));

  return {
    initialPar: 100_000_000,
    wacSpreadBps: 375,
    baseRatePct: 4.5,
    seniorFeePct: 0.45,
    subFeePct: 0.50,
    tranches: [
      { className: "A", currentBalance: 65_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
      { className: "B", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
      { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
    ],
    ocTriggers: [
      { className: "A", triggerLevel: 120, rank: 1 },
      { className: "B", triggerLevel: 110, rank: 2 },
    ],
    icTriggers: [
      { className: "A", triggerLevel: 120, rank: 1 },
      { className: "B", triggerLevel: 110, rank: 2 },
    ],
    reinvestmentPeriodEnd: "2028-06-15",
    maturityDate: "2034-06-15",
    currentDate: "2026-03-09",
    loans: defaultLoans,
    defaultRatesByRating: { ...DEFAULT_RATES_BY_RATING },
    cprPct: 15,
    recoveryPct: 60,
    recoveryLagMonths: 12,
    reinvestmentSpreadBps: 350,
    reinvestmentTenorQuarters: 20,
    reinvestmentRating: null,
    cccBucketLimitPct: 7.5,
    cccMarketValuePct: 70,
    ...overrides,
  };
}

// ─── validateInputs ──────────────────────────────────────────────────────────

describe("validateInputs", () => {
  it("accepts valid inputs", () => {
    const errors = validateInputs(makeInputs());
    expect(errors).toHaveLength(0);
  });

  it("rejects missing tranches", () => {
    const errors = validateInputs(makeInputs({ tranches: [] }));
    expect(errors.some((e) => e.field === "tranches")).toBe(true);
  });

  it("rejects zero initial par", () => {
    const errors = validateInputs(makeInputs({ initialPar: 0 }));
    expect(errors.some((e) => e.field === "initialPar")).toBe(true);
  });

  it("rejects missing maturity date", () => {
    const errors = validateInputs(makeInputs({ maturityDate: null }));
    expect(errors.some((e) => e.field === "maturityDate")).toBe(true);
  });
});

// ─── runProjection baseline ──────────────────────────────────────────────────

describe("runProjection baseline", () => {
  it("runs without error and returns periods", () => {
    const result = runProjection(makeInputs());
    expect(result.periods.length).toBeGreaterThan(0);
    expect(result.periods[0].periodNum).toBe(1);
  });

  it("par declines over time due to defaults and prepayments", () => {
    const result = runProjection(makeInputs());
    const first = result.periods[0];
    const last = result.periods[result.periods.length - 1];
    expect(last.endingPar).toBeLessThan(first.beginningPar);
  });

  it("generates equity distributions", () => {
    const result = runProjection(makeInputs());
    expect(result.totalEquityDistributions).toBeGreaterThan(0);
  });

  it("zero defaults and CPR keeps par stable during RP", () => {
    const result = runProjection(makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      // Override loans to mature well after RP so no maturities during RP
      loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 }],
    }));
    const rpPeriods = result.periods.filter(
      (p) => new Date(p.date) <= new Date("2028-06-15")
    );
    for (const p of rpPeriods) {
      expect(p.beginningPar).toBeCloseTo(100_000_000, -2);
    }
  });

  it("reinvests prepayments during RP", () => {
    const result = runProjection(makeInputs());
    const rpPeriod = result.periods[0]; // Q1 is within RP
    expect(rpPeriod.reinvestment).toBeGreaterThan(0);
  });

  it("does not reinvest post-RP", () => {
    const result = runProjection(makeInputs());
    const postRpPeriods = result.periods.filter(
      (p) => new Date(p.date) > new Date("2028-06-15")
    );
    expect(postRpPeriods.length).toBeGreaterThan(0);
    for (const p of postRpPeriods) {
      expect(p.reinvestment).toBe(0);
    }
  });

  it("tracks tranche payoff quarters", () => {
    const result = runProjection(makeInputs());
    expect(result.tranchePayoffQuarter).toHaveProperty("A");
    expect(result.tranchePayoffQuarter).toHaveProperty("B");
    expect(result.tranchePayoffQuarter).toHaveProperty("Sub");
  });
});

// ─── calculateIrr ────────────────────────────────────────────────────────────

describe("calculateIrr", () => {
  it("returns null for all-positive cash flows", () => {
    expect(calculateIrr([100, 200, 300])).toBeNull();
  });

  it("returns null for fewer than 2 cash flows", () => {
    expect(calculateIrr([100])).toBeNull();
    expect(calculateIrr([])).toBeNull();
  });

  it("computes a reasonable IRR for typical CLO equity flows", () => {
    const flows = [-20_000_000];
    for (let i = 0; i < 32; i++) flows.push(2_000_000);
    const irr = calculateIrr(flows, 4);
    expect(irr).not.toBeNull();
    expect(irr!).toBeGreaterThan(0.05);
    expect(irr!).toBeLessThan(1.0);
  });
});

// ─── per-loan model — maturity correctness ──────────────────────────────────

describe("per-loan model — maturity correctness", () => {
  it("zero residual par after all loans mature (no defaults, no prepay)", () => {
    const loans = [
      { parBalance: 50_000_000, maturityDate: addQuarters("2026-03-09", 4), ratingBucket: "B", spreadBps: 375 },
      { parBalance: 50_000_000, maturityDate: addQuarters("2026-03-09", 4), ratingBucket: "B", spreadBps: 375 },
    ];
    const result = runProjection(makeInputs({
      loans,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    const q4 = result.periods.find((p) => p.periodNum === 4)!;
    expect(q4.scheduledMaturities).toBeCloseTo(100_000_000, -2);
    expect(q4.endingPar).toBeCloseTo(0, -2);
    // No orphan par in subsequent periods
    for (const p of result.periods.filter((p) => p.periodNum > 4)) {
      expect(p.beginningPar).toBeCloseTo(0, -2);
    }
  });

  it("surviving par at maturity reflects defaults (not original par)", () => {
    const loans = [{ parBalance: 100_000_000, maturityDate: addQuarters("2026-03-09", 8), ratingBucket: "CCC", spreadBps: 375 }];
    const rates = { ...uniformRates(0), CCC: 10.28 };
    const result = runProjection(makeInputs({
      loans,
      defaultRatesByRating: rates,
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    const q8 = result.periods.find((p) => p.periodNum === 8)!;
    expect(q8.scheduledMaturities).toBeLessThan(100_000_000);
    expect(q8.scheduledMaturities).toBeGreaterThan(0);
    expect(q8.endingPar).toBeCloseTo(0, -2);
  });

  it("different ratings produce different default amounts", () => {
    const loansB = [{ parBalance: 100_000_000, maturityDate: addQuarters("2026-03-09", 20), ratingBucket: "B", spreadBps: 375 }];
    const loansBB = [{ parBalance: 100_000_000, maturityDate: addQuarters("2026-03-09", 20), ratingBucket: "BB", spreadBps: 375 }];
    const resultB = runProjection(makeInputs({ loans: loansB, cprPct: 0, reinvestmentPeriodEnd: null }));
    const resultBB = runProjection(makeInputs({ loans: loansBB, cprPct: 0, reinvestmentPeriodEnd: null }));
    const totalDefaultsB = resultB.periods.reduce((s, p) => s + p.defaults, 0);
    const totalDefaultsBB = resultBB.periods.reduce((s, p) => s + p.defaults, 0);
    expect(totalDefaultsB).toBeGreaterThan(totalDefaultsBB);
  });

  it("defaultsByRating is populated in PeriodResult", () => {
    const result = runProjection(makeInputs());
    const q1 = result.periods[0];
    expect(q1.defaultsByRating).toBeDefined();
    expect(q1.defaultsByRating["B"]).toBeGreaterThan(0);
  });
});

// ─── per-loan model — loan maturities ───────────────────────────────────────

describe("per-loan model — loan maturities", () => {
  it("loan maturing in Q4 reduces par in that period", () => {
    const matDate = addQuarters("2026-03-09", 4);
    const loans = [
      { parBalance: 5_000_000, maturityDate: matDate, ratingBucket: "B", spreadBps: 375 },
      { parBalance: 95_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 },
    ];
    const result = runProjection(makeInputs({
      loans,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    const q4 = result.periods.find((p) => p.periodNum === 4)!;
    expect(q4.scheduledMaturities).toBeGreaterThan(0);
    expect(q4.endingPar).toBeLessThan(100_000_000);
  });

  it("matured par stops earning interest", () => {
    const matDate = addQuarters("2026-03-09", 2);
    const withMat = runProjection(makeInputs({
      loans: [
        { parBalance: 30_000_000, maturityDate: matDate, ratingBucket: "B", spreadBps: 375 },
        { parBalance: 70_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 },
      ],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    const withoutMat = runProjection(makeInputs({
      loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 }],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    const q3With = withMat.periods.find((p) => p.periodNum === 3)!;
    const q3Without = withoutMat.periods.find((p) => p.periodNum === 3)!;
    expect(q3With.interestCollected).toBeLessThan(q3Without.interestCollected);
  });

  it("maturities during RP are reinvested", () => {
    const matDate = addQuarters("2026-03-09", 2);
    const result = runProjection(makeInputs({
      loans: [
        { parBalance: 10_000_000, maturityDate: matDate, ratingBucket: "B", spreadBps: 375 },
        { parBalance: 90_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 },
      ],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
    }));
    const q2 = result.periods.find((p) => p.periodNum === 2)!;
    expect(q2.reinvestment).toBeGreaterThanOrEqual(q2.scheduledMaturities);
  });

  it("maturities post-RP flow to principal paydown", () => {
    const matDate = addQuarters("2026-03-09", 12);
    const withMat = runProjection(makeInputs({
      loans: [
        { parBalance: 10_000_000, maturityDate: matDate, ratingBucket: "B", spreadBps: 375 },
        { parBalance: 90_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 },
      ],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
    }));
    const withoutMat = runProjection(makeInputs({
      loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 }],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
    }));
    const q12With = withMat.periods.find((p) => p.periodNum === 12)!;
    const q12Without = withoutMat.periods.find((p) => p.periodNum === 12)!;
    const totalPrinWith = q12With.tranchePrincipal.reduce((s, t) => s + t.paid, 0);
    const totalPrinWithout = q12Without.tranchePrincipal.reduce((s, t) => s + t.paid, 0);
    expect(totalPrinWith).toBeGreaterThan(totalPrinWithout);
  });

  it("multiple loans maturing in same quarter are aggregated", () => {
    const matDate = addQuarters("2026-03-09", 3);
    const result = runProjection(makeInputs({
      loans: [
        { parBalance: 5_000_000, maturityDate: matDate, ratingBucket: "B", spreadBps: 375 },
        { parBalance: 3_000_000, maturityDate: matDate, ratingBucket: "BB", spreadBps: 375 },
        { parBalance: 92_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 },
      ],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    const q3 = result.periods.find((p) => p.periodNum === 3)!;
    expect(q3.scheduledMaturities).toBeCloseTo(8_000_000, -2);
  });
});

// ─── OC/IC gating ───────────────────────────────────────────────────────────

describe("OC gating diverts cash from equity", () => {
  it("high defaults trigger OC failure and cut equity distributions", () => {
    const withHighDefaults = runProjection(makeInputs({
      loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "CCC", spreadBps: 375 }],
      defaultRatesByRating: { ...uniformRates(0), CCC: 10 },
      cprPct: 0,
      recoveryPct: 0,
      reinvestmentPeriodEnd: null,
      ocTriggers: [
        { className: "A", triggerLevel: 120, rank: 1 },
        { className: "B", triggerLevel: 110, rank: 2 },
      ],
      icTriggers: [],
    }));
    const withNoDefaults = runProjection(makeInputs({
      loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 }],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      reinvestmentPeriodEnd: null,
      ocTriggers: [
        { className: "A", triggerLevel: 120, rank: 1 },
        { className: "B", triggerLevel: 110, rank: 2 },
      ],
      icTriggers: [],
    }));
    expect(withHighDefaults.totalEquityDistributions).toBeLessThan(
      withNoDefaults.totalEquityDistributions
    );
    const anyOcFailing = withHighDefaults.periods.some((p) =>
      p.ocTests.some((oc) => !oc.passing)
    );
    expect(anyOcFailing).toBe(true);
  });

  it("OC failure diverts interest to principal paydown, reducing equity", () => {
    const result = runProjection(makeInputs({
      loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 }],
      defaultRatesByRating: uniformRates(5),
      cprPct: 0,
      recoveryPct: 0,
      reinvestmentPeriodEnd: null,
      ocTriggers: [
        { className: "B", triggerLevel: 200, rank: 2 },
      ],
      icTriggers: [],
    }));
    const q1 = result.periods[0];
    const ocB = q1.ocTests.find((t) => t.className === "B")!;
    expect(ocB.passing).toBe(false);
    expect(q1.equityDistribution).toBeCloseTo(0, -1);
  });

  it("beginningLiabilities and endingLiabilities are reported", () => {
    const result = runProjection(makeInputs());
    const q1 = result.periods[0];
    expect(q1.beginningLiabilities).toBeCloseTo(80_000_000, -2);
    expect(q1.endingLiabilities).toBeLessThanOrEqual(q1.beginningLiabilities);
  });
});

// ─── Interest calculation ────────────────────────────────────────────────────

describe("per-loan interest calculation", () => {
  it("Q1 interest uses loan spreads, not WAC", () => {
    // Two scenarios with same total par but different per-loan spreads
    const highSpread = runProjection(makeInputs({
      loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 500 }],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    const lowSpread = runProjection(makeInputs({
      loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 200 }],
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    expect(highSpread.periods[0].interestCollected).toBeGreaterThan(
      lowSpread.periods[0].interestCollected
    );
  });
});

// ─── IC ratio uses post-fee interest ────────────────────────────────────────

describe("IC ratio uses post-fee interest", () => {
  it("IC ratio is lower with higher senior fees", () => {
    const lowFee = runProjection(makeInputs({
      seniorFeePct: 0.1,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      icTriggers: [{ className: "A", triggerLevel: 100, rank: 1 }],
      ocTriggers: [],
    }));
    const highFee = runProjection(makeInputs({
      seniorFeePct: 2.0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      icTriggers: [{ className: "A", triggerLevel: 100, rank: 1 }],
      ocTriggers: [],
    }));
    const icLow = lowFee.periods[0].icTests[0].actual;
    const icHigh = highFee.periods[0].icTests[0].actual;
    expect(icHigh).toBeLessThan(icLow);
  });
});

// ─── endingPar at maturity ──────────────────────────────────────────────────

describe("endingPar at maturity", () => {
  it("endingPar is zero in the final period after liquidation", () => {
    const result = runProjection(makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 15,
      maturityDate: "2028-03-09",
    }));
    const lastPeriod = result.periods[result.periods.length - 1];
    expect(lastPeriod.endingPar).toBe(0);
  });
});

// ─── CDR/CPR >= 100% guard ──────────────────────────────────────────────────

describe("CDR/CPR >= 100% guard", () => {
  it("does not produce NaN with extreme CDR", () => {
    const result = runProjection(makeInputs({ defaultRatesByRating: uniformRates(100) }));
    expect(result.periods.length).toBeGreaterThan(0);
    for (const p of result.periods) {
      expect(p.beginningPar).not.toBeNaN();
      expect(p.endingPar).not.toBeNaN();
      expect(p.defaults).not.toBeNaN();
      expect(p.interestCollected).not.toBeNaN();
    }
  });
});

// ─── OC failure causes junior tranche interest shortfall ────────────────────

describe("OC failure causes junior tranche interest shortfall", () => {
  it("junior tranche gets paid: 0 when OC diverts", () => {
    const result = runProjection(makeInputs({
      loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 }],
      defaultRatesByRating: uniformRates(5),
      cprPct: 0,
      recoveryPct: 0,
      reinvestmentPeriodEnd: null,
      ocTriggers: [{ className: "A", triggerLevel: 200, rank: 1 }],
      icTriggers: [],
    }));
    const q1 = result.periods[0];
    const bInterest = q1.trancheInterest.find((t) => t.className === "B")!;
    expect(bInterest.paid).toBe(0);
    expect(bInterest.due).toBeGreaterThan(0);
  });
});

// ─── Recovery pipeline at maturity ──────────────────────────────────────────

describe("recovery pipeline at maturity", () => {
  it("accelerates pending recoveries in the final period", () => {
    const result = runProjection(makeInputs({
      loans: [{ parBalance: 100_000_000, maturityDate: "2030-03-09", ratingBucket: "B", spreadBps: 375 }],
      defaultRatesByRating: uniformRates(5),
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 24,
      reinvestmentPeriodEnd: null,
      maturityDate: "2030-03-09",
    }));
    const lastPeriod = result.periods[result.periods.length - 1];
    expect(lastPeriod.recoveries).toBeGreaterThan(0);
  });
});
