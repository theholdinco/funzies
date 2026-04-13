import { ProjectionInputs, LoanInput, addQuarters } from "../projection";
import { RATING_BUCKETS, DEFAULT_RATES_BY_RATING } from "../rating-mapping";
import { CLO_DEFAULTS } from "../defaults";

export function uniformRates(cdr: number): Record<string, number> {
  return Object.fromEntries(RATING_BUCKETS.map((b) => [b, cdr]));
}

export function makeInputs(overrides: Partial<ProjectionInputs> = {}): ProjectionInputs {
  const defaultLoans: LoanInput[] = Array.from({ length: 10 }, (_, i) => ({
    parBalance: 10_000_000,
    maturityDate: addQuarters("2026-03-09", 8 + i),
    ratingBucket: "B",
    spreadBps: 375,
  }));

  return {
    initialPar: 100_000_000,
    wacSpreadBps: 375,
    baseRatePct: CLO_DEFAULTS.baseRatePct,
    baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
    seniorFeePct: CLO_DEFAULTS.seniorFeePct,
    subFeePct: CLO_DEFAULTS.subFeePct,
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
    cprPct: CLO_DEFAULTS.cprPct,
    recoveryPct: CLO_DEFAULTS.recoveryPct,
    recoveryLagMonths: CLO_DEFAULTS.recoveryLagMonths,
    reinvestmentSpreadBps: CLO_DEFAULTS.reinvestmentSpreadBps,
    reinvestmentTenorQuarters: CLO_DEFAULTS.reinvestmentTenorYears * 4,
    reinvestmentRating: null,
    cccBucketLimitPct: CLO_DEFAULTS.cccBucketLimitPct,
    cccMarketValuePct: CLO_DEFAULTS.cccMarketValuePct,
    deferredInterestCompounds: true,
    trusteeFeeBps: 0,
    hedgeCostBps: 0,
    incentiveFeePct: 0,
    incentiveFeeHurdleIrr: 0,
    postRpReinvestmentPct: 0,
    callDate: null,
    callPricePct: 100,
    reinvestmentOcTrigger: null,
    initialPrincipalCash: 0,
    preExistingDefaultedPar: 0,
    preExistingDefaultRecovery: 0,
    unpricedDefaultedPar: 0,
    preExistingDefaultOcValue: 0,
    discountObligationHaircut: 0,
    longDatedObligationHaircut: 0,
    impliedOcAdjustment: 0,
    quartersSinceReport: 0,
    ddtlDrawPercent: 100,
    ...overrides,
  };
}
