import { ProjectionInputs, LoanInput, addQuarters } from "../projection";
import { RATING_BUCKETS, DEFAULT_RATES_BY_RATING } from "../rating-mapping";
import { CLO_DEFAULTS } from "../defaults";

export function uniformRates(cdr: number): Record<string, number> {
  return Object.fromEntries(RATING_BUCKETS.map((b) => [b, cdr]));
}

// Disable defaults under per-position WARF: the factory's baseline
// `defaultRatesByRating` is non-zero (DEFAULT_RATES_BY_RATING), so a zero-
// returning path-fn yields multiplier = 0/baseline = 0 → hazard = warfHazard
// × 0 = 0. Use as `cdrMultiplierPathFn: noDefaultsPath` in test overrides.
//
// CAUTION: do NOT also override `defaultRatesByRating` to zero — baseline=0
// + path=0 hits the Infinity-fallback edge case at projection.ts:2920
// (multiplier=1, defaults at warfHazard remain active).
export const noDefaultsPath = (): Record<string, number> =>
  Object.fromEntries(RATING_BUCKETS.map((b) => [b, 0]));

// Convenience pair for tests that previously overrode `defaultRatesByRating`
// to zero alongside other inputs. Spread via `...noDefaults`. Pairs a non-zero
// baseline with the zero-returning path-fn so the multiplier 0/1 = 0 path is
// taken (avoiding the Infinity-fallback edge case described above).
export const noDefaults = {
  defaultRatesByRating: uniformRates(1),
  cdrMultiplierPathFn: noDefaultsPath,
} as const;

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
      { className: "J", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
      { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
    ],
    ocTriggers: [
      { className: "A", triggerLevel: 120, rank: 1 },
      { className: "J", triggerLevel: 110, rank: 2 },
    ],
    icTriggers: [
      { className: "A", triggerLevel: 120, rank: 1 },
      { className: "J", triggerLevel: 110, rank: 2 },
    ],
    reinvestmentPeriodEnd: "2028-06-15",
    maturityDate: "2034-06-15",
    currentDate: "2026-03-09",
    loans: defaultLoans,
    defaultRatesByRating: { ...DEFAULT_RATES_BY_RATING },
    cprPct: CLO_DEFAULTS.cprPct,
    recoveryPct: CLO_DEFAULTS.recoveryPct,
    recoveryLagMonths: CLO_DEFAULTS.recoveryLagMonths,
    // Default to all three agencies for legacy synthetic fixtures. Production
    // path via `buildFromResolved` populates this from `resolved.ratingAgencies`
    // (strict: capital-structure-only). Tests that exercise per-deal subset
    // filtering pass an explicit narrower set via overrides.
    ratingAgencies: ["moodys", "sp", "fitch"],
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
    callMode: "none",
    callDate: null,
    callPricePct: 100,
    callPriceMode: "par",
    reinvestmentOcTrigger: null,
    initialPrincipalCash: 0,
    preExistingDefaultedPar: 0,
    preExistingDefaultRecovery: 0,
    unpricedDefaultedPar: 0,
    preExistingDefaultOcValue: 0,
    longDatedObligationHaircut: 0,
    impliedOcAdjustment: 0,
    quartersSinceReport: 0,
    ddtlDrawPercent: 100,
    ...overrides,
  };
}
