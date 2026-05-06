export interface CloDocument {
  name: string;
  type: string;
  size: number;
  base64: string;
  docType?: "ppm" | "compliance";
}

// --- Section sub-interfaces ---

export interface DealIdentity {
  dealName?: string;
  issuerLegalName?: string;
  jurisdiction?: string;
  entityType?: string;
  registrationNumber?: string;
  registeredAddress?: string;
  governingLaw?: string;
  currency?: string;
  listingExchange?: string;
  volckerRuleStatus?: string;
}

export interface KeyDates {
  originalIssueDate?: string;
  currentIssueDate?: string;
  maturityDate?: string;
  nonCallPeriodEnd?: string;
  reinvestmentPeriodEnd?: string;
  firstPaymentDate?: string;
  paymentFrequency?: string;
  frequencySwitchEvent?: string;
}

export interface CapitalStructureEntry {
  class: string;
  designation?: string;
  principalAmount: string;
  rateType?: string;
  referenceRate?: string;
  spreadBps?: number;
  spread: string;
  rating: { fitch?: string; moodys?: string; sp?: string };
  ratingAddressesTimelyInterest?: boolean;
  deferrable?: boolean;
  issuePrice: string;
  maturityDate: string;
  minDenominationRegS?: string;
  minDenomination144a?: string;
  isSubordinated?: boolean;
  clearing?: string;
  amortisationPerPeriod?: string;
  amortStartDate?: string;
}

export interface DealSizing {
  targetParAmount?: string;
  totalRatedNotes?: string;
  totalSubordinatedNotes?: string;
  totalDealSize?: string;
  equityPctOfDeal?: string;
  cleanUpCallThresholdPct?: string;
}

export interface CoverageTestEntry {
  class: string;
  parValueRatio?: string;
  interestCoverageRatio?: string;
}

export interface CollateralQualityTest {
  name: string;
  agency?: string;
  value?: string | number | null;
  appliesDuring?: string;
}

export interface FeeEntry {
  name: string;
  rate?: string;
  rateUnit?: "pct_pa" | "bps_pa" | "pct_of_residual" | "fixed_amount" | "per_agreement" | null;
  basis?: string;
  description?: string;
  hurdleRate?: string;
}

export interface KeyParty {
  role: string;
  entity: string;
}

export interface HedgingProvisions {
  currencyHedgeRequired?: boolean;
  hedgeTypes?: string;
  counterpartyRatingReq?: string;
  replacementTimeline?: string;
  maxCurrencyHedgePct?: string;
  terminationWaterfallPosition?: string;
}

export interface RedemptionProvision {
  type: string;
  description: string;
}

export interface EventOfDefault {
  event: string;
  description: string;
}

export interface VotingAndControl {
  controllingClass?: string;
  ordinaryResolution?: string;
  extraordinaryResolution?: string;
  cmNotesVotingRestrictions?: string;
}

export interface InterestMechanics {
  dayCount?: string;
  referenceRate?: string;
  referenceRateFloorPct?: number | null; // floor on reference rate (e.g. 0 for "floored at zero", null if no floor)
  /** PPM Reference Weighted Average Fixed Coupon (%). Used by the Excess WAC
   *  term: `(WeightedAvgFixedCoupon − referenceWAFC) × (fixedPar / floatingPar)`
   *  per PPM Condition 1, PDF p. 305. Per-deal extracted; resolver blocks if
   *  missing on a deal that has fixed-rate positions in its pool. */
  referenceWeightedAverageFixedCoupon?: number | null;
  interpolation?: string;
  deferralClasses?: string[];
  deferredInterestCompounds?: boolean;
  subNoteInterest?: string;
  withholdingTaxGrossUp?: boolean;
}

export interface RiskRetention {
  euUk?: { holder?: string; type?: string; amount?: string; reporting?: string };
  us?: { type?: string; amount?: string; hedgingRestriction?: string };
}

export interface CMDetails {
  name?: string;
  parent?: string;
  jurisdiction?: string;
  replacementMechanism?: string;
  resignationTerms?: string;
}

export interface RatingAgencyParameters {
  spCdoMonitor?: string;
  spIndustryClassifications?: string;
  spRecoveryRates?: string;
  spDiversityMeasure?: string;
  fitchTestMatrix?: string;
  fitchWARF?: string;
  fitchWARR?: string;
  fitchIndustryClassifications?: string;
}

// --- Main extraction interface (30 sections) ---

export interface ExtractedConstraints {
  // Section 1: Deal Identity
  dealIdentity?: DealIdentity;
  // Section 2: Key Dates
  keyDates?: KeyDates;
  // Section 3: Capital Structure
  capitalStructure?: CapitalStructureEntry[];
  // Section 4: Deal Sizing
  dealSizing?: DealSizing;
  // Section 5: Coverage Tests
  coverageTestEntries?: CoverageTestEntry[];
  reinvestmentOcTest?: { trigger?: string; appliesDuring?: string; diversionAmount?: string; diversionOptions?: string };
  // Condition 1 / 10(a)(iv) Excess CCC Adjustment Amount parameters used by
  // the OC numerator haircut. Outer-nullable, inner-required: null signals
  // extraction missed and the resolver emits a blocking warning; both fields
  // are required when the object is present.
  excessCccAdjustment?: { thresholdPct: string; marketValuePct: string } | null;
  // Section 6: Collateral Quality Tests
  collateralQualityTests?: CollateralQualityTest[];
  // Section 7: Portfolio Profile Tests
  portfolioProfileTests?: Record<string, { min?: string | null; max?: string | null; notes?: string }>;
  // Section 8: Eligibility Criteria
  eligibilityCriteria?: string[];
  // Section 9: Reinvestment Criteria
  reinvestmentCriteria?: { duringReinvestment?: string; postReinvestment?: string; substituteRequirements?: string; targetParBalance?: string };
  // Section 10: Waterfall
  waterfall?: { interestPriority?: string; principalPriority?: string; postAcceleration?: string };
  // Section 11: Fees
  fees?: FeeEntry[];
  /** PPM Condition 1 "Senior Expenses Cap" structured definition.
   *  Sourced from `ppm.json:section_5_fees_and_hurdle.senior_expenses_cap`
   *  via `mapFeesAndExpenses`. Resolver consumes via `resolveSeniorExpensesCap`
   *  and emits `severity: "error", blocking: true` when the deal has fee
   *  rows (extraction not in greenfield state) and this field is null. */
  seniorExpensesCap?: {
    bpsPerYear: number;
    absoluteFloorEurPerYear: number | null;
    componentADayCount: "30_360_after_first" | "actual_360";
    base: "CPA" | "APB";
    period: "per_payment_date" | "per_annum";
    allocationWithinCap: "pro_rata" | "sequential_b_first";
    overflowAllocation: "pro_rata" | "sequential_y_first";
    carryforwardPeriods: number | null;
    vatIncluded: boolean;
    vatRatePct: number | null;
    sourcePages: number[] | null;
    sourceCondition: string | null;
  } | null;
  /** PPM Condition 1 "Discount Obligation" structured definition.
   *  Sourced from `ppm.json:section_5_fees_and_hurdle.discount_obligation`
   *  via `mapFeesAndExpenses`. Resolver consumes via `resolveDiscountObligation`
   *  and emits `severity: "error", blocking: true` when the deal has loan
   *  rows (extraction not in greenfield state) and this field is null. The
   *  shape mirrors `ResolvedDiscountObligationRule` (resolver-types.ts) for
   *  direct passthrough. */
  discountObligation?: {
    classificationThresholdPct:
      | { type: "single"; pct: number }
      | { type: "split_by_rate_type"; floatingPct: number; fixedPct: number };
    cureMechanic:
      | {
          type: "continuous_threshold";
          cureThresholdPct:
            | { type: "single"; pct: number }
            | { type: "split_by_rate_type"; floatingPct: number; fixedPct: number };
          cureWindow:
            | { type: "days"; n: number }
            | { type: "payment_dates"; n: number };
        }
      | { type: "permanent_until_paid" };
    sourcePages: number[] | null;
    sourceCondition: string | null;
  } | null;
  /** PPM Condition 1 "Long-Dated Collateral Obligation" + APB "deemed
   *  zero" valuation rule. Sourced from
   *  `ppm.json:section_5_fees_and_hurdle.long_dated_obligation` via
   *  `mapFeesAndExpenses`. Resolver consumes via
   *  `resolveLongDatedObligation` and emits `severity: "error",
   *  blocking: true` when missing on a deal with loan rows. The shape
   *  mirrors `ResolvedLongDatedValuationRule` (resolver-types.ts) for
   *  direct passthrough. */
  longDatedObligation?: {
    capPctOfBase: number;
    capBase: "APB" | "CPA";
    withinCap:
      | { type: "par" }
      | {
          type: "tiered_mv_or_capped";
          cliffYearsPastStatedMaturity: number;
          cappedPricePct: number;
        };
    postCap:
      | { type: "zero" }
      | { type: "agency_cv_min" };
    sourcePages: number[] | null;
    sourceCondition: string | null;
  } | null;
  /** PPM Condition 1 clause (t) "Industry Classification" — industry-cap closure.
   *  Sourced from `ppm.json:section_8_portfolio_and_quality_tests
   *  .industry_concentration_test` via `mapIndustryConcentrationTest`.
   *  Resolver consumes and emits blocking warnings per the three-state
   *  presence gate (Option D). The shape mirrors the resolver's
   *  `industryCapRules` + `industryTaxonomy` + `industryCapPresentInPpm`
   *  fields directly so resolver consumption is mechanical. */
  industryConcentrationTest?: {
    present: boolean;
    taxonomy: "moodys_33" | "sp" | "deal_specific" | null;
    rules:
      | Array<
          | { kind: "single_rank_max"; rank: number; triggerPct: number; appliesWhen?: unknown }
          | { kind: "combined_top_n_max"; n: number; triggerPct: number; appliesWhen?: unknown }
          | { kind: "single_class_max"; industryName: string; industryCode: string; triggerPct: number; appliesWhen?: unknown }
          | { kind: "count_above_threshold"; thresholdPct: number; maxCount: number; appliesWhen?: unknown }
        >
      | null;
    excludedIndustryNames: string[] | null;
    unmappedRuleDescriptions?: string[];
    sourcePages: number[] | null;
    sourceCondition: string | null;
    verbatimQuote: string | null;
  } | null;
  // Section 12: Accounts
  accounts?: { name: string; purpose: string }[];
  // Section 13: Key Parties
  keyParties?: KeyParty[];
  // Section 14: Hedging
  hedging?: HedgingProvisions;
  // Section 15: Redemption Provisions
  redemptionProvisions?: RedemptionProvision[];
  // Section 16: Events of Default
  eventsOfDefault?: EventOfDefault[];
  // Section 17: Voting & Control
  votingAndControl?: VotingAndControl;
  // Section 18: Interest Mechanics
  interestMechanics?: InterestMechanics;
  // Section 19: Risk Retention
  riskRetention?: RiskRetention;
  // Section 20: Tax
  tax?: { jurisdiction?: string; section110?: string; withholding?: string; usTreatment?: string; fatcaCrs?: string };
  // Section 21: Transfer Restrictions
  transferRestrictions?: { investorType: string; requirements: string }[];
  // Section 22: Reports
  reports?: { type: string; frequency?: string; preparedBy?: string }[];
  // Section 23: CM Details
  cmDetails?: CMDetails;
  // Section 24: CM Trading Constraints
  cmTradingConstraints?: { discretionarySales?: string; requiredSaleTypes?: string[]; postReinvestmentTrading?: string };
  // Section 24b: Management of Portfolio
  managementOfPortfolio?: string;
  // Section 24c: Terms and Conditions of Sales
  termsAndConditionsOfSales?: string;
  // Section 24d: Trading Restrictions by Test Breach
  tradingRestrictionsByTestBreach?: { testName: string; consequence: string }[];
  // Section 25: Refinancing History
  refinancingHistory?: { date: string; details: string }[];
  // Section 26: Additional Issuance
  additionalIssuance?: { permitted?: boolean; conditions?: string };
  // Section 27: Risk Factors
  riskFactors?: Record<string, string>;
  // Section 28: Conflicts of Interest
  conflictsOfInterest?: string[];
  // Section 29: Rating Agency Parameters
  ratingAgencyParameters?: RatingAgencyParameters;
  // Section 30: Legal Protections
  legalProtections?: { feature: string; description: string }[];

  // --- Legacy fields (backward compat with existing extractions) ---
  targetParAmount?: string;
  collateralManager?: string;
  issuer?: string;
  eligibleCollateral?: string;
  concentrationLimits?: Record<string, string>;
  coverageTests?: Record<string, string>;
  collateralManagerFees?: Record<string, string>;
  lossMitigationLimits?: Record<string, string>;
  esgExclusions?: string[];
  warfLimit?: number;
  wasMinimum?: number;
  walMaximum?: number;
  diversityScoreMinimum?: number;
  reinvestmentPeriod?: { start?: string; end?: string };
  nonCallPeriod?: { end?: string };
  maturityDate?: string;
  paymentDates?: string;
  frequencySwitchEvent?: string;
  waterfallSummary?: string;
  ratingThresholds?: string;
  otherConstraints?: string[];
  additionalProvisions?: string;
}

export interface PortfolioHolding {
  issuer: string;
  notional: number;
  rating: string;
  spread: number;
  sector: string;
  maturity: string;
  loanType: string;
}

export interface ComplianceTest {
  name: string;
  actual: number;
  trigger: number;
  passing: boolean;
  cushion: number;
}

export interface PortfolioMetric {
  name: string;
  current: number;
  limit: number;
  direction: "max" | "min";
  passing: boolean;
}

export interface ConcentrationBreakdown {
  category: string;
  percentage: number;
  limit?: number;
}

/** @deprecated Use new relational tables (clo_pool_summary, clo_compliance_tests, etc.) instead */
export interface ExtractedPortfolio {
  holdings: PortfolioHolding[];
  testResults: ComplianceTest[];
  metrics: PortfolioMetric[];
  cccBucket: { current: number; limit: number; holdings: string[] };
  concentrations: {
    bySector: ConcentrationBreakdown[];
    byRating: ConcentrationBreakdown[];
    topExposures: ConcentrationBreakdown[];
  };
  reportDate?: string;
}
