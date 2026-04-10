// Single source of truth for CLO model defaults.
//
// PHILOSOPHY: All fee/expense defaults are ZERO so they don't silently
// throw off the model. When extraction finds real values, those pre-fill
// the UI. The user can always see and override everything.
//
// Non-fee assumptions (CPR, recovery, etc.) have reasonable non-zero
// defaults since they're always visible on sliders.

export const CLO_DEFAULTS = {
  // Fees — all zero by default. Resolved from PPM extraction when available.
  seniorFeePct: 0,
  subFeePct: 0,
  trusteeFeeBps: 0,
  incentiveFeePct: 0,
  incentiveFeeHurdleIrr: 0,
  hedgeCostBps: 0,

  // Base rate assumption
  baseRatePct: 3.5,     // ~current 3M EURIBOR

  // Default assumptions for projection (visible on sliders)
  cprPct: 15,
  recoveryPct: 60,
  recoveryLagMonths: 12,
  reinvestmentSpreadBps: 350,
  reinvestmentTenorYears: 5,
  postRpReinvestmentPct: 0,

  // OC test parameters
  cccBucketLimitPct: 7.5,
  cccMarketValuePct: 70,
} as const;
