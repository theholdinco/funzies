export {
  computeInceptionIrr,
  type InceptionIrrInput,
  type InceptionIrrAnchor,
  type InceptionIrrResult,
} from "./inception-irr";

export {
  computeFairValueAtHurdle,
  computeFairValuesAtHurdles,
  type FairValueResult,
  type FairValueStatus,
} from "./fair-value";

export {
  sweepEntryPrice,
  type EntryPriceSweepPoint,
} from "./entry-price-sweep";

export {
  callSensitivityGrid,
  type CallSensitivityCell,
  type CallSensitivityOptions,
  type CallSensitivityPriceMode,
  type CallSensitivityErrorKind,
} from "./call-sensitivity";

export {
  deriveNoCallBaseInputs,
  applyOptionalRedemptionCall,
} from "./no-call-baseline";

export {
  computeSwitchDeltas,
  type SwitchDeltas,
  type SwitchOcCushionDelta,
  type SwitchPeriodEquityDelta,
} from "./switch-deltas";

export {
  computeEquityDistributionProfile,
  type EquityDistributionProfile,
} from "./equity-distribution-profile";
