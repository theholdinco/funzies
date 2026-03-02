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
  rating: { fitch?: string; sp?: string };
  ratingAddressesTimelyInterest?: boolean;
  deferrable?: boolean;
  issuePrice: string;
  maturityDate: string;
  minDenominationRegS?: string;
  minDenomination144a?: string;
  isSubordinated?: boolean;
  clearing?: string;
}

export interface DealSizing {
  targetParAmount?: string;
  totalRatedNotes?: string;
  totalSubordinatedNotes?: string;
  totalDealSize?: string;
  equityPctOfDeal?: string;
  cleanUpCallThresholdPct?: string;
  classXAmortisation?: string;
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
  basis?: string;
  description?: string;
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

// ─── New Exhaustive Extraction Types ─────────────────────────────────

export interface CloDeal {
  id: string;
  profileId: string;
  dealName: string | null;
  dealShortName: string | null;
  issuerLegalEntity: string | null;
  jurisdiction: string | null;
  dealCurrency: string | null;
  closingDate: string | null;
  effectiveDate: string | null;
  reinvestmentPeriodEnd: string | null;
  nonCallPeriodEnd: string | null;
  statedMaturityDate: string | null;
  walTestDate: string | null;
  dealType: string | null;
  dealVersion: string | null;
  trusteeName: string | null;
  collateralManager: string | null;
  collateralAdministrator: string | null;
  governingDocument: string | null;
  governingLaw: string | null;
  ppmConstraints: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ExtractionStatus = "pending" | "extracting" | "complete" | "partial" | "error";
export type ReportType = "quarterly" | "semi-annual" | "annual" | "ad-hoc";

export interface DataQualityCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  expected: number | null;
  actual: number | null;
  discrepancy: number | null;
  message: string;
}

export interface DataQuality {
  checks: DataQualityCheck[];
  score: number;
  totalChecks: number;
  checksRun: number;
  checksSkipped: number;
}

export interface CloReportPeriod {
  id: string;
  dealId: string;
  reportDate: string;
  paymentDate: string | null;
  previousPaymentDate: string | null;
  reportType: ReportType | null;
  reportSource: string | null;
  reportingPeriodStart: string | null;
  reportingPeriodEnd: string | null;
  isFinal: boolean;
  extractionStatus: ExtractionStatus;
  extractedAt: string | null;
  rawExtraction: Record<string, unknown> | null;
  supplementaryData: CloSupplementaryData | null;
  dataQuality: DataQuality | null;
  createdAt: string;
  updatedAt: string;
}

export interface CloTranche {
  id: string;
  dealId: string;
  className: string;
  isin: string | null;
  cusip: string | null;
  commonCode: string | null;
  currency: string | null;
  originalBalance: number | null;
  seniorityRank: number | null;
  isFloating: boolean | null;
  referenceRate: string | null;
  referenceRateTenor: string | null;
  spreadBps: number | null;
  couponFloor: number | null;
  couponCap: number | null;
  dayCountConvention: string | null;
  paymentFrequency: string | null;
  isDeferrable: boolean | null;
  isPik: boolean | null;
  ratingMoodys: string | null;
  ratingSp: string | null;
  ratingFitch: string | null;
  ratingDbrs: string | null;
  isSubordinate: boolean | null;
  isIncomeNote: boolean | null;
}

export interface CloTrancheSnapshot {
  id: string;
  trancheId: string;
  reportPeriodId: string;
  currentBalance: number | null;
  factor: number | null;
  currentIndexRate: number | null;
  couponRate: number | null;
  deferredInterestBalance: number | null;
  enhancementPct: number | null;
  beginningBalance: number | null;
  endingBalance: number | null;
  interestAccrued: number | null;
  interestPaid: number | null;
  interestShortfall: number | null;
  cumulativeShortfall: number | null;
  principalPaid: number | null;
  daysAccrued: number | null;
}

export interface CloHolding {
  id: string;
  reportPeriodId: string;
  obligorName: string | null;
  facilityName: string | null;
  isin: string | null;
  lxid: string | null;
  assetType: string | null;
  currency: string | null;
  country: string | null;
  industryCode: string | null;
  industryDescription: string | null;
  moodysIndustry: string | null;
  spIndustry: string | null;
  isCovLite: boolean | null;
  isRevolving: boolean | null;
  isDelayedDraw: boolean | null;
  isDefaulted: boolean | null;
  isPik: boolean | null;
  isFixedRate: boolean | null;
  isDiscountObligation: boolean | null;
  isLongDated: boolean | null;
  settlementStatus: string | null;
  acquisitionDate: string | null;
  maturityDate: string | null;
  parBalance: number | null;
  principalBalance: number | null;
  marketValue: number | null;
  purchasePrice: number | null;
  currentPrice: number | null;
  accruedInterest: number | null;
  referenceRate: string | null;
  indexRate: number | null;
  spreadBps: number | null;
  allInRate: number | null;
  floorRate: number | null;
  moodysRating: string | null;
  moodysRatingSource: string | null;
  spRating: string | null;
  spRatingSource: string | null;
  fitchRating: string | null;
  compositeRating: string | null;
  ratingFactor: number | null;
  recoveryRateMoodys: number | null;
  recoveryRateSp: number | null;
  remainingLifeYears: number | null;
  warfContribution: number | null;
  diversityScoreGroup: string | null;
}

export interface CloPoolSummary {
  id: string;
  reportPeriodId: string;
  totalPar: number | null;
  totalPrincipalBalance: number | null;
  totalMarketValue: number | null;
  numberOfObligors: number | null;
  numberOfAssets: number | null;
  numberOfIndustries: number | null;
  numberOfCountries: number | null;
  targetPar: number | null;
  parSurplusDeficit: number | null;
  wacSpread: number | null;
  wacTotal: number | null;
  walYears: number | null;
  warf: number | null;
  diversityScore: number | null;
  waRecoveryRate: number | null;
  waMoodysRecovery: number | null;
  waSpRecovery: number | null;
  pctFixedRate: number | null;
  pctFloatingRate: number | null;
  pctCovLite: number | null;
  pctSecondLien: number | null;
  pctSeniorSecured: number | null;
  pctBonds: number | null;
  pctCurrentPay: number | null;
  pctDefaulted: number | null;
  pctCccAndBelow: number | null;
  pctSingleB: number | null;
  pctDiscountObligations: number | null;
  pctLongDated: number | null;
  pctSemiAnnualPay: number | null;
  pctQuarterlyPay: number | null;
  pctEurDenominated: number | null;
  pctGbpDenominated: number | null;
  pctUsdDenominated: number | null;
  pctNonBaseCurrency: number | null;
}

export type ComplianceTestType =
  | "OC_PAR" | "OC_MV" | "IC" | "INTEREST_DIVERSION" | "WARF" | "WAL" | "WAS"
  | "DIVERSITY" | "RECOVERY" | "CONCENTRATION" | "ELIGIBILITY";

export interface CloComplianceTest {
  id: string;
  reportPeriodId: string;
  testName: string;
  testType: ComplianceTestType | null;
  testClass: string | null;
  numerator: number | null;
  denominator: number | null;
  actualValue: number | null;
  triggerLevel: number | null;
  thresholdLevel: number | null;
  cushionPct: number | null;
  cushionAmount: number | null;
  isPassing: boolean | null;
  cureAmount: number | null;
  consequenceIfFail: string | null;
  matrixRow: string | null;
  matrixColumn: string | null;
  testMethodology: string | null;
  adjustmentDescription: string | null;
  isActive: boolean;
}

export type ConcentrationType =
  | "INDUSTRY" | "COUNTRY" | "SINGLE_OBLIGOR" | "RATING" | "MATURITY" | "SPREAD" | "ASSET_TYPE" | "CURRENCY";

export interface CloConcentration {
  id: string;
  reportPeriodId: string;
  concentrationType: ConcentrationType;
  bucketName: string;
  actualValue: number | null;
  actualPct: number | null;
  limitValue: number | null;
  limitPct: number | null;
  excessAmount: number | null;
  isPassing: boolean | null;
  isHaircutApplied: boolean | null;
  haircutAmount: number | null;
  obligorCount: number | null;
  assetCount: number | null;
  ratingFactorAvg: number | null;
}

export type WaterfallType = "INTEREST" | "PRINCIPAL" | "COMBINED";

export interface CloWaterfallStep {
  id: string;
  reportPeriodId: string;
  waterfallType: WaterfallType | null;
  priorityOrder: number | null;
  description: string | null;
  payee: string | null;
  amountDue: number | null;
  amountPaid: number | null;
  shortfall: number | null;
  fundsAvailableBefore: number | null;
  fundsAvailableAfter: number | null;
  isOcTestDiversion: boolean | null;
  isIcTestDiversion: boolean | null;
}

export type AccountType = "COLLECTION" | "PAYMENT" | "RESERVE" | "PRINCIPAL" | "INTEREST" | "EXPENSE" | "HEDGE" | "CUSTODY";

export interface CloAccountBalance {
  id: string;
  reportPeriodId: string;
  accountName: string;
  accountType: AccountType | null;
  currency: string | null;
  balanceAmount: number | null;
  requiredBalance: number | null;
  excessDeficit: number | null;
}

export type ProceedsType = "INTEREST" | "PRINCIPAL" | "SALE" | "RECOVERY" | "FEE_REBATE" | "HEDGE" | "OTHER";

export interface CloProceeds {
  id: string;
  reportPeriodId: string;
  proceedsType: ProceedsType | null;
  sourceDescription: string | null;
  amount: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export type TradeType =
  | "PURCHASE" | "SALE" | "PAYDOWN" | "PREPAYMENT" | "DEFAULT_RECOVERY" | "CREDIT_RISK_SALE"
  | "DISCRETIONARY_SALE" | "SUBSTITUTION" | "AMENDED" | "RESTRUCTURED";

export interface CloTrade {
  id: string;
  reportPeriodId: string;
  tradeType: TradeType | null;
  obligorName: string | null;
  facilityName: string | null;
  tradeDate: string | null;
  settlementDate: string | null;
  parAmount: number | null;
  settlementPrice: number | null;
  settlementAmount: number | null;
  realizedGainLoss: number | null;
  accruedInterestTraded: number | null;
  currency: string | null;
  counterparty: string | null;
  isCreditRiskSale: boolean | null;
  isCreditImproved: boolean | null;
  isDiscretionary: boolean | null;
}

export interface CloTradingSummary {
  id: string;
  reportPeriodId: string;
  totalPurchasesPar: number | null;
  totalPurchasesCost: number | null;
  totalSalesPar: number | null;
  totalSalesProceeds: number | null;
  netGainLoss: number | null;
  totalPaydowns: number | null;
  totalPrepayments: number | null;
  totalDefaultsPar: number | null;
  totalRecoveries: number | null;
  turnoverRate: number | null;
  creditRiskSalesPar: number | null;
  discretionarySalesPar: number | null;
  remainingDiscretionaryAllowance: number | null;
}

export type EventType =
  | "EOD_TRIGGER" | "OC_FAIL" | "IC_FAIL" | "COVERAGE_CURE" | "RATING_DOWNGRADE" | "RATING_UPGRADE"
  | "PAYMENT_DEFAULT" | "REINVESTMENT_PERIOD_END" | "ACCELERATION" | "REDEMPTION" | "AMENDMENT" | "OTHER";

export interface CloEvent {
  id: string;
  dealId: string;
  reportPeriodId: string | null;
  eventType: EventType | null;
  eventDate: string | null;
  description: string | null;
  isEventOfDefault: boolean | null;
  isCured: boolean | null;
  cureDate: string | null;
  impactDescription: string | null;
}

export type AdjustmentType =
  | "DEFAULTED_HAIRCUT" | "CCC_EXCESS_HAIRCUT" | "DISCOUNT_OBLIGATION_HAIRCUT"
  | "EXCESS_CONCENTRATION_HAIRCUT" | "TRADING_GAIN_LOSS" | "PRINCIPAL_CASH" | "HEDGE_MTM"
  | "DEFERRED_INTEREST" | "LONG_DATED_HAIRCUT" | "CURRENCY_HAIRCUT" | "RECOVERY_RATE_ADJ";

export interface CloParValueAdjustment {
  id: string;
  reportPeriodId: string;
  testName: string | null;
  adjustmentType: AdjustmentType | null;
  description: string | null;
  grossAmount: number | null;
  adjustmentAmount: number | null;
  netAmount: number | null;
  calculationMethod: string | null;
}

export interface CloExtractionOverflow {
  id: string;
  reportPeriodId: string;
  extractionPass: number | null;
  sourceSection: string | null;
  label: string | null;
  content: unknown;
  createdAt: string;
}

// Supplementary data JSONB structure (stored on clo_report_periods)
export interface CloSupplementaryData {
  fees?: Array<{
    feeType: string;
    payee?: string;
    rate?: string;
    accrued?: number;
    paid?: number;
    unpaid?: number;
    waterfallPriority?: number;
    isSenior?: boolean;
    isSubordinate?: boolean;
    isIncentive?: boolean;
  }>;
  hedgePositions?: Array<{
    hedgeType: string;
    counterparty?: string;
    counterpartyRating?: string;
    notional?: number;
    payLeg?: string;
    receiveLeg?: string;
    fxRate?: number;
    mtm?: number;
    maturityDate?: string;
    hedgeCost?: number;
  }>;
  fxRates?: Array<{
    baseCurrency: string;
    quoteCurrency: string;
    spotRate?: number;
    hedgeRate?: number;
    source?: string;
  }>;
  spCdoMonitor?: Array<{
    tranche: string;
    targetRating?: string;
    sdr?: number;
    bdr?: number;
    cushion?: number;
    recoveryAssumptions?: string;
  }>;
  moodysAnalytics?: {
    warf?: number;
    diversityScore?: number;
    matrixValues?: Record<string, unknown>;
    waSpread?: number;
    waCoupon?: number;
    waRecovery?: number;
    waLife?: number;
  };
  ratingActions?: Array<{
    agency: string;
    tranche?: string;
    priorRating?: string;
    newRating?: string;
    actionType?: string;
    date?: string;
    outlook?: string;
  }>;
  taxInformation?: {
    jurisdiction?: string;
    withholdingRate?: number;
    grossUp?: boolean;
    taxEvents?: string[];
  };
  regulatoryFlags?: Array<{
    regulationName: string;
    requirement?: string;
    complianceStatus?: string;
    riskRetentionDetails?: string;
  }>;
  eligibilityTestResults?: Array<{
    criterionName: string;
    isPassing?: boolean;
    failureImpact?: string;
  }>;
  reinvestmentConstraints?: Array<{
    constraintName: string;
    constraintType?: string;
    isActive?: boolean;
    startDate?: string;
    endDate?: string;
  }>;
  saleLimitations?: Array<{
    category: string;
    allowedAmount?: number;
    usedAmount?: number;
    remainingAmount?: number;
  }>;
  testMatrices?: Array<{
    matrixName: string;
    rows?: string[];
    columns?: string[];
    cellValues?: Record<string, unknown>;
  }>;
}

export interface CloProfile {
  id: string;
  userId: string;
  fundStrategy: string;
  targetSectors: string;
  riskAppetite: "conservative" | "moderate" | "aggressive";
  portfolioSize: string;
  reinvestmentPeriod: string;
  concentrationLimits: string;
  covenantPreferences: string;
  ratingThresholds: string;
  spreadTargets: string;
  regulatoryConstraints: string;
  portfolioDescription: string;
  beliefsAndBiases: string;
  rawQuestionnaire: Record<string, unknown>;
  documents: CloDocument[];
  extractedConstraints: ExtractedConstraints;
  extractedPortfolio: ExtractedPortfolio | null;
  createdAt: string;
  updatedAt: string;
}

export interface PanelMember {
  number: number;
  name: string;
  role: string;
  background: string;
  investmentPhilosophy: string;
  specializations: string[];
  decisionStyle: string;
  riskPersonality: string;
  notablePositions: string[];
  blindSpots: string[];
  fullProfile: string;
  avatarUrl: string;
}

export interface Panel {
  id: string;
  profileId: string;
  status: "queued" | "generating" | "active" | "error";
  members: PanelMember[];
  avatarMappings: Record<string, string>;
  rawFiles: Record<string, string>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoanAnalysis {
  id: string;
  panelId: string;
  analysisType: "buy" | "switch";
  title: string;
  borrowerName: string;
  sector: string;
  loanType: string;
  spreadCoupon: string;
  rating: string;
  maturity: string;
  facilitySize: string;
  leverage: string;
  interestCoverage: string;
  covenantsSummary: string;
  ebitda: string;
  revenue: string;
  companyDescription: string;
  notes: string;
  switchBorrowerName?: string;
  switchSector?: string;
  switchLoanType?: string;
  switchSpreadCoupon?: string;
  switchRating?: string;
  switchMaturity?: string;
  switchFacilitySize?: string;
  switchLeverage?: string;
  switchInterestCoverage?: string;
  switchCovenantsSummary?: string;
  switchEbitda?: string;
  switchRevenue?: string;
  switchCompanyDescription?: string;
  switchNotes?: string;
  status: "queued" | "running" | "complete" | "error";
  currentPhase: string;
  rawFiles: Record<string, string>;
  parsedData: ParsedAnalysis;
  dynamicSpecialists: PanelMember[];
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ParsedAnalysis {
  memo?: CreditMemo;
  riskAssessment?: CreditRiskAssessment;
  recommendation?: CreditRecommendation;
  debate?: CloDebateRound[];
  individualAssessments?: IndividualCreditAssessment[];
  premortem?: string;
}

export interface CreditMemo {
  title: string;
  sections: { heading: string; content: string }[];
  raw: string;
}

export interface CreditRiskAssessment {
  overallRisk: "low" | "moderate" | "high" | "very-high";
  categories: { name: string; level: string; analysis: string }[];
  mitigants: string[];
  raw: string;
}

export type CreditVerdict = "strong_buy" | "buy" | "hold" | "pass" | "strong_pass";

export interface CreditVoteRecord {
  memberName: string;
  vote: CreditVerdict;
  conviction: string;
  rationale: string;
}

export interface CreditRecommendation {
  verdict: CreditVerdict;
  votes: CreditVoteRecord[];
  dissents: string[];
  conditions: string[];
  raw: string;
}

export interface CloDebateRound {
  round: number;
  exchanges: { speaker: string; content: string }[];
}

export interface IndividualCreditAssessment {
  memberName: string;
  position: string;
  keyPoints: string[];
  concerns: string[];
  raw: string;
}

export interface CloFollowUp {
  id: string;
  analysisId: string;
  question: string;
  mode: "ask-panel" | "ask-member" | "debate" | "analyst";
  targetMember?: string;
  responseMd: string;
  createdAt: string;
}

export interface CloConversation {
  id: string;
  profileId: string;
  messages: { role: "user" | "assistant"; content: string; timestamp: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface ScreeningSession {
  id: string;
  panelId: string;
  focusArea: string;
  status: "queued" | "running" | "complete" | "error";
  currentPhase?: string;
  rawFiles: Record<string, string>;
  parsedData: ParsedScreening;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

export interface LoanIdea {
  title: string;
  thesis: string;
  sector: string;
  loanType: string;
  riskLevel: string;
  expectedSpread: string;
  rationale: string;
  keyRisks: string[];
  implementationSteps: string[];
}

export interface ParsedScreening {
  ideas: LoanIdea[];
  gapAnalysis?: string;
  raw: string;
}

export interface QuestionnaireStep {
  id: string;
  title: string;
  description: string;
  fields: QuestionnaireField[];
}

export interface QuestionnaireField {
  name: string;
  label: string;
  type: "text" | "textarea" | "select" | "multiselect" | "radio";
  options?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
}
