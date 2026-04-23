/**
 * Engine feature flags for CLO projection correctness sprints.
 *
 * Every flag documented below corresponds to a material behavior change introduced
 * in Sprints 1–5 of the modeling correctness plan. Each change is kill-switchable
 * so a production regression can be disabled without redeploy.
 *
 * Sprint 0 ships this as a static object. Sprint 2 will add env-var override
 * (`CLO_ENGINE_FLAGS_JSON`) alongside B2 (post-acceleration waterfall), when the
 * first flag actually gates a material behavior change in production.
 *
 * Naming convention: `useX` = the new/correct behavior. `useLegacyX` = the
 * pre-sprint fallback for side-by-side comparison.
 */
export const ENGINE_FLAGS = {
  // Sprint 2 / B1: compositional EoD test (APB + MV×PB + cash, Class-A-only denominator).
  useCompositionalEod: true,

  // Sprint 2 / B2: post-acceleration waterfall executor (combined P+I accel sequence).
  usePostAccelerationMode: true,

  // Sprint 1 / B3: per-tranche day-count precision (Actual/360 for floating, 30/360 for fixed).
  useDayCountPrecision: true,

  // Sprint 3 / C1: reinvestment compliance enforcement (concentration caps, WAS floor, WARF ceiling).
  useReinvestmentComplianceEnforcement: true,

  // Sprint 3 / C3: Senior Expenses Cap + uncapped (Y)/(Z) overflow + trustee/admin split.
  useSeniorExpensesCap: true,

  // Sprint 4 / C4: Frequency Switch trigger evaluation (Phase 2); static `freqSwitchActive` flip (Phase 1).
  useFrequencySwitchTrigger: true,

  // Sprint 5 / D2: per-position WARF Monte Carlo hazard (primary; ratingBucket map is fallback).
  usePerPositionWarfHazard: true,

  // ---- Legacy fallback flags (opposite of the new behavior) -------------
  // Used for side-by-side regression comparison. Deprecated and removed after
  // 2 successful production periods without rollback need, per plan's deprecation path.
  useLegacyBucketHazard: false,
  useLegacyFixedQuarterDayCount: false,
  useLegacyUncappedFees: false,
  useLegacyCollapsedEod: false,
} as const;

export type EngineFlags = typeof ENGINE_FLAGS;
export type EngineFlagKey = keyof EngineFlags;
