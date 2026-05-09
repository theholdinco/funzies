import { z } from "zod";

const ratingPair = z.object({
  fitch: z.string().optional(),
  sp: z.string().optional(),
}).passthrough();

const capitalStructureEntry = z.object({
  class: z.string().optional(),
  designation: z.string().optional(),
  principalAmount: z.string().optional(),
  rateType: z.string().optional(),
  referenceRate: z.string().optional(),
  spreadBps: z.number().optional(),
  spread: z.string().optional(),
  rating: ratingPair.optional(),
  ratingAddressesTimelyInterest: z.boolean().optional(),
  deferrable: z.boolean().optional(),
  issuePrice: z.string().optional(),
  maturityDate: z.string().optional(),
  minDenominationRegS: z.string().optional(),
  minDenomination144a: z.string().optional(),
  isSubordinated: z.boolean().optional(),
  clearing: z.string().optional(),
  amortisationPerPeriod: z.string().optional(),
  amortStartDate: z.string().optional(),
  paymentFrequency: z.string().optional(),
}).passthrough();

export const extractedConstraintsSchema = z.object({
  dealIdentity: z.object({
    dealName: z.string().optional(),
    issuerLegalName: z.string().optional(),
    jurisdiction: z.string().optional(),
    entityType: z.string().optional(),
    registrationNumber: z.string().optional(),
    registeredAddress: z.string().optional(),
    governingLaw: z.string().optional(),
    currency: z.string().optional(),
    listingExchange: z.string().optional(),
    volckerRuleStatus: z.string().optional(),
  }).passthrough().optional(),

  keyDates: z.object({
    originalIssueDate: z.string().optional(),
    currentIssueDate: z.string().optional(),
    maturityDate: z.string().optional(),
    nonCallPeriodEnd: z.string().optional(),
    reinvestmentPeriodEnd: z.string().optional(),
    firstPaymentDate: z.string().optional(),
    paymentFrequency: z.string().optional(),
    frequencySwitchEvent: z.string().optional(),
  }).passthrough().optional(),

  capitalStructure: z.array(capitalStructureEntry).optional(),

  dealSizing: z.object({
    targetParAmount: z.string().optional(),
    totalRatedNotes: z.string().optional(),
    totalSubordinatedNotes: z.string().optional(),
    totalDealSize: z.string().optional(),
    equityPctOfDeal: z.string().optional(),
    cleanUpCallThresholdPct: z.string().optional(),
  }).passthrough().optional(),

  coverageTestEntries: z.array(z.object({
    class: z.string().optional(),
    parValueRatio: z.string().optional(),
    interestCoverageRatio: z.string().optional(),
  }).passthrough()).optional(),

  reinvestmentOcTest: z.object({
    trigger: z.string().optional(),
    appliesDuring: z.string().optional(),
    diversionAmount: z.string().optional(),
    diversionOptions: z.string().optional(),
  }).passthrough().optional(),

  collateralQualityTests: z.array(z.object({
    name: z.string().optional(),
    agency: z.string().optional(),
    value: z.union([z.string(), z.number(), z.null()]).optional(),
    appliesDuring: z.string().optional(),
  }).passthrough()).optional(),

  portfolioProfileTests: z.record(z.string(), z.object({
    min: z.union([z.string(), z.null()]).optional(),
    max: z.union([z.string(), z.null()]).optional(),
    notes: z.string().optional(),
  }).passthrough()).optional(),

  eligibilityCriteria: z.array(z.string()).optional(),

  reinvestmentCriteria: z.object({
    duringReinvestment: z.string().optional(),
    postReinvestment: z.string().optional(),
    substituteRequirements: z.string().optional(),
    targetParBalance: z.string().optional(),
  }).passthrough().optional(),

  waterfall: z.object({
    interestPriority: z.string().optional(),
    principalPriority: z.string().optional(),
    postAcceleration: z.string().optional(),
  }).passthrough().optional(),

  fees: z.array(z.object({
    name: z.string().optional(),
    rate: z.string().optional(),
    rateUnit: z.enum(["pct_pa", "bps_pa", "pct_of_residual", "fixed_amount", "per_agreement"]).nullable().optional(),
    basis: z.string().optional(),
    description: z.string().optional(),
    hurdleRate: z.string().nullable().optional(),
  }).passthrough()).optional(),

  accounts: z.array(z.object({
    name: z.string().optional(),
    purpose: z.string().optional(),
  }).passthrough()).optional(),

  keyParties: z.array(z.object({
    role: z.string().optional(),
    entity: z.string().optional(),
  }).passthrough()).optional(),

  hedging: z.object({
    currencyHedgeRequired: z.boolean().optional(),
    hedgeTypes: z.string().optional(),
    counterpartyRatingReq: z.string().optional(),
    replacementTimeline: z.string().optional(),
    maxCurrencyHedgePct: z.string().optional(),
    terminationWaterfallPosition: z.string().optional(),
  }).passthrough().optional(),

  redemptionProvisions: z.array(z.object({
    type: z.string().optional(),
    description: z.string().optional(),
  }).passthrough()).optional(),

  eventsOfDefault: z.array(z.object({
    event: z.string().optional(),
    description: z.string().optional(),
  }).passthrough()).optional(),

  votingAndControl: z.object({
    controllingClass: z.string().optional(),
    ordinaryResolution: z.string().optional(),
    extraordinaryResolution: z.string().optional(),
    cmNotesVotingRestrictions: z.string().optional(),
  }).passthrough().optional(),

  interestMechanics: z.object({
    dayCount: z.string().optional(),
    referenceRate: z.string().optional(),
    interpolation: z.string().optional(),
    deferralClasses: z.array(z.string()).optional(),
    deferredInterestCompounds: z.boolean().optional(),
    subNoteInterest: z.string().optional(),
    withholdingTaxGrossUp: z.boolean().optional(),
  }).passthrough().optional(),

  riskRetention: z.object({
    euUk: z.object({
      holder: z.string().optional(),
      type: z.string().optional(),
      amount: z.string().optional(),
      reporting: z.string().optional(),
    }).passthrough().optional(),
    us: z.object({
      type: z.string().optional(),
      amount: z.string().optional(),
      hedgingRestriction: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),

  tax: z.object({
    jurisdiction: z.string().optional(),
    section110: z.string().optional(),
    withholding: z.string().optional(),
    usTreatment: z.string().optional(),
    fatcaCrs: z.string().optional(),
  }).passthrough().optional(),

  transferRestrictions: z.array(z.object({
    investorType: z.string().optional(),
    requirements: z.string().optional(),
  }).passthrough()).optional(),

  reports: z.array(z.object({
    type: z.string().optional(),
    frequency: z.string().optional(),
    preparedBy: z.string().optional(),
  }).passthrough()).optional(),

  cmDetails: z.object({
    name: z.string().optional(),
    parent: z.string().optional(),
    jurisdiction: z.string().optional(),
    replacementMechanism: z.string().optional(),
    resignationTerms: z.string().optional(),
  }).passthrough().optional(),

  cmTradingConstraints: z.object({
    discretionarySales: z.string().optional(),
    requiredSaleTypes: z.array(z.string()).optional(),
    postReinvestmentTrading: z.string().optional(),
  }).passthrough().optional(),

  managementOfPortfolio: z.string().optional(),

  termsAndConditionsOfSales: z.string().optional(),

  tradingRestrictionsByTestBreach: z.array(z.object({
    testName: z.string(),
    consequence: z.string(),
  })).optional(),

  refinancingHistory: z.array(z.object({
    date: z.string().optional(),
    details: z.string().optional(),
  }).passthrough()).optional(),

  additionalIssuance: z.object({
    permitted: z.boolean().optional(),
    conditions: z.string().optional(),
  }).passthrough().optional(),

  riskFactors: z.record(z.string(), z.string()).optional(),

  conflictsOfInterest: z.array(z.string()).optional(),

  ratingAgencyParameters: z.object({
    spCdoMonitor: z.string().optional(),
    spIndustryClassifications: z.string().optional(),
    spRecoveryRates: z.string().optional(),
    spDiversityMeasure: z.string().optional(),
    fitchTestMatrix: z.string().optional(),
    fitchWARF: z.string().optional(),
    fitchWARR: z.string().optional(),
    fitchIndustryClassifications: z.string().optional(),
  }).passthrough().optional(),

  legalProtections: z.array(z.object({
    feature: z.string().optional(),
    description: z.string().optional(),
  }).passthrough()).optional(),

  additionalProvisions: z.string().optional(),
}).passthrough();
