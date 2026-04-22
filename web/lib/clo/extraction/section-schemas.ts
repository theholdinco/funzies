import { z } from "zod";

// ---------------------------------------------------------------------------
// Compliance Report Section Schemas
// ---------------------------------------------------------------------------

export const complianceSummarySchema = z.object({
  reportDate: z.string(),
  paymentDate: z.string().nullable().optional(),
  reportType: z.enum(["quarterly", "semi-annual", "annual", "ad-hoc"]).nullable().optional(),
  dealName: z.string().nullable().optional(),
  trusteeName: z.string().nullable().optional(),
  collateralManager: z.string().nullable().optional(),
  closingDate: z.string().nullable().optional(),
  statedMaturity: z.string().nullable().optional(),
  nextPaymentDate: z.string().nullable().optional(),
  collectionPeriodEnd: z.string().nullable().optional(),
  reinvestmentPeriodEnd: z.string().nullable().optional(),
  nonCallPeriodEnd: z.string().nullable().optional(),
  tranches: z.array(z.object({
    className: z.string(),
    principalAmount: z.number().nullable().optional(),
    spread: z.number().nullable().optional(),
    allInRate: z.number().nullable().optional(),
    currentBalance: z.number().nullable().optional(),
    rating: z.string().nullable().optional(),
    couponRate: z.number().nullable().optional(),
  })).optional().default([]),
  aggregatePrincipalBalance: z.number().nullable().optional(),
  adjustedCollateralPrincipalAmount: z.number().nullable().optional(),
  numberOfAssets: z.number().nullable().optional(),
  numberOfObligors: z.number().nullable().optional(),
  totalPar: z.number().nullable().optional(),
  wacSpread: z.number().nullable().optional(),
  diversityScore: z.number().nullable().optional(),
  warf: z.number().nullable().optional(),
  walYears: z.number().nullable().optional(),
  waRecoveryRate: z.number().nullable().optional(),
  pctFixedRate: z.number().nullable().optional(),
  pctFloatingRate: z.number().nullable().optional(),
  pctCovLite: z.number().nullable().optional(),
  pctSecondLien: z.number().nullable().optional(),
  pctDefaulted: z.number().nullable().optional(),
  pctCccAndBelow: z.number().nullable().optional(),
});

export type ComplianceSummary = z.infer<typeof complianceSummarySchema>;

export const parValueTestsSchema = z.object({
  tests: z.array(z.object({
    testName: z.string(),
    testType: z.string().nullable().optional(),
    testClass: z.string().nullable().optional(),
    numerator: z.number().nullable().optional(),
    denominator: z.number().nullable().optional(),
    actualValue: z.number().nullable().optional(),
    triggerLevel: z.number().nullable().optional(),
    cushionPct: z.number().nullable().optional(),
    cushionAmount: z.number().nullable().optional(),
    isPassing: z.boolean().nullable().optional(),
    consequenceIfFail: z.string().nullable().optional(),
  })),
  parValueAdjustments: z.array(z.object({
    testName: z.string().nullable().optional(),
    adjustmentType: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    grossAmount: z.number().nullable().optional(),
    adjustmentAmount: z.number().nullable().optional(),
    netAmount: z.number().nullable().optional(),
  })).optional().default([]),
});

export type ParValueTests = z.infer<typeof parValueTestsSchema>;

export const defaultDetailSchema = z.object({
  defaults: z.array(z.object({
    obligorName: z.string(),
    securityId: z.string().nullable().optional(), // ISIN or CUSIP
    parAmount: z.number().nullable().optional(),
    marketPrice: z.number().nullable().optional(), // as percentage (e.g. 31.29)
    recoveryRateFitch: z.number().nullable().optional(), // Fitch recovery rate as percentage
    recoveryRateSp: z.number().nullable().optional(), // S&P recovery rate as percentage
    recoveryRateMoodys: z.number().nullable().optional(),
    isDefaulted: z.boolean().nullable().optional(),
    isDeferring: z.boolean().nullable().optional(),
  })).default([]),
});

export type DefaultDetail = z.infer<typeof defaultDetailSchema>;

export const interestCoverageTestsSchema = z.object({
  tests: z.array(z.object({
    testName: z.string(),
    testType: z.string().nullable().optional(),
    testClass: z.string().nullable().optional(),
    numerator: z.number().nullable().optional(),
    denominator: z.number().nullable().optional(),
    actualValue: z.number().nullable().optional(),
    triggerLevel: z.number().nullable().optional(),
    cushionPct: z.number().nullable().optional(),
    isPassing: z.boolean().nullable().optional(),
    consequenceIfFail: z.string().nullable().optional(),
  })),
  interestAmountsPerTranche: z.array(z.object({
    className: z.string(),
    interestAmount: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
  })).optional().default([]),
});

export type InterestCoverageTests = z.infer<typeof interestCoverageTestsSchema>;

export const assetScheduleSchema = z.object({
  holdings: z.array(z.object({
    obligorName: z.string().nullable().optional(),
    facilityName: z.string().nullable().optional(),
    isin: z.string().nullable().optional(),
    lxid: z.string().nullable().optional(),
    assetType: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    industryCode: z.string().nullable().optional(),
    industryDescription: z.string().nullable().optional(),
    moodysIndustry: z.string().nullable().optional(),
    spIndustry: z.string().nullable().optional(),
    isCovLite: z.boolean().nullable().optional(),
    isRevolving: z.boolean().nullable().optional(),
    isDelayedDraw: z.boolean().nullable().optional(),
    isDefaulted: z.boolean().nullable().optional(),
    isPik: z.boolean().nullable().optional(),
    isFixedRate: z.boolean().nullable().optional(),
    isDiscountObligation: z.boolean().nullable().optional(),
    isLongDated: z.boolean().nullable().optional(),
    settlementStatus: z.string().nullable().optional(),
    acquisitionDate: z.string().nullable().optional(),
    maturityDate: z.string().nullable().optional(),
    parBalance: z.number().nullable().optional(),
    principalBalance: z.number().nullable().optional(),
    marketValue: z.number().nullable().optional(),
    purchasePrice: z.number().nullable().optional(),
    currentPrice: z.number().nullable().optional(),
    accruedInterest: z.number().nullable().optional(),
    referenceRate: z.string().nullable().optional(),
    indexRate: z.number().nullable().optional(),
    spreadBps: z.number().nullable().optional(),
    allInRate: z.number().nullable().optional(),
    floorRate: z.number().nullable().optional(),
    moodysRating: z.string().nullable().optional(),
    moodysRatingSource: z.string().nullable().optional(),
    spRating: z.string().nullable().optional(),
    spRatingSource: z.string().nullable().optional(),
    fitchRating: z.string().nullable().optional(),
    compositeRating: z.string().nullable().optional(),
    ratingFactor: z.number().nullable().optional(),
    recoveryRateMoodys: z.number().nullable().optional(),
    recoveryRateSp: z.number().nullable().optional(),
    recoveryRateFitch: z.number().nullable().optional(),
    remainingLifeYears: z.number().nullable().optional(),
    warfContribution: z.number().nullable().optional(),
    diversityScoreGroup: z.string().nullable().optional(),
  })),
});

export type AssetSchedule = z.infer<typeof assetScheduleSchema>;

export const concentrationSchema = z.object({
  concentrations: z.array(z.object({
    concentrationType: z.string(),
    bucketName: z.string(),
    actualValue: z.number().nullable().optional(),
    actualPct: z.number().nullable().optional(),
    limitValue: z.number().nullable().optional(),
    limitPct: z.number().nullable().optional(),
    excessAmount: z.number().nullable().optional(),
    isPassing: z.boolean().nullable().optional(),
    isHaircutApplied: z.boolean().nullable().optional(),
    haircutAmount: z.number().nullable().optional(),
    obligorCount: z.number().nullable().optional(),
    assetCount: z.number().nullable().optional(),
  })),
});

export type Concentration = z.infer<typeof concentrationSchema>;

export const waterfallSchema = z.object({
  waterfallSteps: z.array(z.object({
    waterfallType: z.string().nullable().optional(),
    priorityOrder: z.number().nullable().optional(),
    description: z.string().nullable().optional(),
    payee: z.string().nullable().optional(),
    amountDue: z.number().nullable().optional(),
    amountPaid: z.number().nullable().optional(),
    shortfall: z.number().nullable().optional(),
    fundsAvailableBefore: z.number().nullable().optional(),
    fundsAvailableAfter: z.number().nullable().optional(),
    isOcTestDiversion: z.boolean().nullable().optional(),
    isIcTestDiversion: z.boolean().nullable().optional(),
  })).optional().default([]),
  proceeds: z.array(z.object({
    proceedsType: z.string().nullable().optional(),
    sourceDescription: z.string().nullable().optional(),
    amount: z.number().nullable().optional(),
    periodStart: z.string().nullable().optional(),
    periodEnd: z.string().nullable().optional(),
  })).optional().default([]),
  trancheSnapshots: z.array(z.object({
    className: z.string(),
    currentBalance: z.number().nullable().optional(),
    factor: z.number().nullable().optional(),
    couponRate: z.number().nullable().optional(),
    interestAccrued: z.number().nullable().optional(),
    interestPaid: z.number().nullable().optional(),
    interestShortfall: z.number().nullable().optional(),
    principalPaid: z.number().nullable().optional(),
    beginningBalance: z.number().nullable().optional(),
    endingBalance: z.number().nullable().optional(),
  })).optional().default([]),
});

export type Waterfall = z.infer<typeof waterfallSchema>;

export const tradingActivitySchema = z.object({
  trades: z.array(z.object({
    tradeType: z.string().nullable().optional(),
    obligorName: z.string().nullable().optional(),
    facilityName: z.string().nullable().optional(),
    tradeDate: z.string().nullable().optional(),
    settlementDate: z.string().nullable().optional(),
    parAmount: z.number().nullable().optional(),
    settlementPrice: z.number().nullable().optional(),
    settlementAmount: z.number().nullable().optional(),
    realizedGainLoss: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    isCreditRiskSale: z.boolean().nullable().optional(),
    isCreditImproved: z.boolean().nullable().optional(),
    isDiscretionary: z.boolean().nullable().optional(),
  })).optional().default([]),
  tradingSummary: z.object({
    totalPurchasesPar: z.number().nullable().optional(),
    totalSalesPar: z.number().nullable().optional(),
    totalSalesProceeds: z.number().nullable().optional(),
    netGainLoss: z.number().nullable().optional(),
    totalPaydowns: z.number().nullable().optional(),
    totalRecoveries: z.number().nullable().optional(),
    creditRiskSalesPar: z.number().nullable().optional(),
    discretionarySalesPar: z.number().nullable().optional(),
    remainingDiscretionaryAllowance: z.number().nullable().optional(),
  }).optional(),
});

export type TradingActivity = z.infer<typeof tradingActivitySchema>;

export const interestAccrualSchema = z.object({
  assetRateDetails: z.array(z.object({
    obligorName: z.string().nullable().optional(),
    facilityName: z.string().nullable().optional(),
    referenceRate: z.string().nullable().optional(),
    baseRate: z.number().nullable().optional(),
    indexFloor: z.number().nullable().optional(),
    spread: z.number().nullable().optional(),
    creditSpreadAdj: z.number().nullable().optional(),
    effectiveSpread: z.number().nullable().optional(),
    allInRate: z.number().nullable().optional(),
  })),
});

export type InterestAccrual = z.infer<typeof interestAccrualSchema>;

export const accountBalancesSchema = z.object({
  accounts: z.array(z.object({
    accountName: z.string(),
    accountType: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    balanceAmount: z.number().nullable().optional(),
    requiredBalance: z.number().nullable().optional(),
    excessDeficit: z.number().nullable().optional(),
  })),
});

export type AccountBalances = z.infer<typeof accountBalancesSchema>;

export const supplementarySchema = z.object({
  fees: z.array(z.object({
    feeType: z.string(),
    payee: z.string().nullable().optional(),
    rate: z.string().nullable().optional(),
    accrued: z.number().nullable().optional(),
    paid: z.number().nullable().optional(),
    unpaid: z.number().nullable().optional(),
  })).optional().default([]),
  hedgePositions: z.array(z.object({
    hedgeType: z.string(),
    counterparty: z.string().nullable().optional(),
    counterpartyRating: z.string().nullable().optional(),
    notional: z.number().nullable().optional(),
    mtm: z.number().nullable().optional(),
    maturityDate: z.string().nullable().optional(),
  })).optional().default([]),
  fxRates: z.array(z.object({
    baseCurrency: z.string(),
    quoteCurrency: z.string(),
    spotRate: z.number().nullable().optional(),
    hedgeRate: z.number().nullable().optional(),
  })).optional().default([]),
  ratingActions: z.array(z.object({
    agency: z.string(),
    tranche: z.string().nullable().optional(),
    priorRating: z.string().nullable().optional(),
    newRating: z.string().nullable().optional(),
    actionType: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
  })).optional().default([]),
  events: z.array(z.object({
    eventType: z.string().nullable().optional(),
    eventDate: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    isEventOfDefault: z.boolean().nullable().optional(),
    isCured: z.boolean().nullable().optional(),
  })).optional().default([]),
  spCdoMonitor: z.array(z.object({
    tranche: z.string(),
    sdr: z.number().nullable().optional(),
    bdr: z.number().nullable().optional(),
    cushion: z.number().nullable().optional(),
  })).optional().default([]),
});

export type Supplementary = z.infer<typeof supplementarySchema>;

// ---------------------------------------------------------------------------
// PPM Section Schemas
// ---------------------------------------------------------------------------

export const transactionOverviewSchema = z.object({
  dealName: z.string().optional(),
  issuerLegalName: z.string().optional(),
  collateralManager: z.string().optional(),
  jurisdiction: z.string().optional(),
  entityType: z.string().optional(),
  governingLaw: z.string().optional(),
  currency: z.string().optional(),
  listingExchange: z.string().optional(),
}).passthrough();

export type TransactionOverview = z.infer<typeof transactionOverviewSchema>;

export const ppmCapitalStructureSchema = z.object({
  capitalStructure: z.array(z.object({
    class: z.string().optional(),
    designation: z.string().optional(),
    principalAmount: z.string().optional(),
    rateType: z.string().optional(),
    referenceRate: z.string().optional(),
    spreadBps: z.number().optional(),
    spread: z.string().optional(),
    rating: z.object({
      fitch: z.string().optional(),
      sp: z.string().optional(),
    }).passthrough().optional(),
    deferrable: z.boolean().optional(),
    maturityDate: z.string().optional(),
    isSubordinated: z.boolean().optional(),
    amortisationPerPeriod: z.string().optional(),
    amortStartDate: z.string().optional(),
  }).passthrough()).optional(),
  dealSizing: z.object({
    targetParAmount: z.string().optional(),
    totalRatedNotes: z.string().optional(),
    totalSubordinatedNotes: z.string().optional(),
    totalDealSize: z.string().optional(),
    equityPctOfDeal: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export type PpmCapitalStructure = z.infer<typeof ppmCapitalStructureSchema>;

export const ppmCoverageTestsSchema = z.object({
  coverageTestEntries: z.array(z.object({
    class: z.string().optional(),
    parValueRatio: z.string().optional(),
    interestCoverageRatio: z.string().optional(),
  }).passthrough()).optional(),
  reinvestmentOcTest: z.object({
    trigger: z.string().optional(),
    appliesDuring: z.string().optional(),
    diversionAmount: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export type PpmCoverageTests = z.infer<typeof ppmCoverageTestsSchema>;

export const ppmEligibilityCriteriaSchema = z.object({
  eligibilityCriteria: z.array(z.string()).optional(),
  reinvestmentCriteria: z.object({
    duringReinvestment: z.string().optional(),
    postReinvestment: z.string().optional(),
    substituteRequirements: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export type PpmEligibilityCriteria = z.infer<typeof ppmEligibilityCriteriaSchema>;

export const ppmPortfolioConstraintsSchema = z.object({
  collateralQualityTests: z.array(z.object({
    name: z.string().optional(),
    agency: z.string().optional(),
    value: z.union([z.string(), z.number(), z.null()]).optional(),
  }).passthrough()).optional(),
  portfolioProfileTests: z.record(z.string(), z.object({
    min: z.union([z.string(), z.null()]).optional(),
    max: z.union([z.string(), z.null()]).optional(),
    notes: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export type PpmPortfolioConstraints = z.infer<typeof ppmPortfolioConstraintsSchema>;

export const ppmWaterfallRulesSchema = z.object({
  interestPriority: z.string().optional(),
  principalPriority: z.string().optional(),
  postAcceleration: z.string().optional(),
}).passthrough();

export type PpmWaterfallRules = z.infer<typeof ppmWaterfallRulesSchema>;

export const ppmFeesSchema = z.object({
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
}).passthrough();

export type PpmFees = z.infer<typeof ppmFeesSchema>;

export const ppmKeyDatesSchema = z.object({
  originalIssueDate: z.string().optional(),
  currentIssueDate: z.string().optional(),
  maturityDate: z.string().optional(),
  nonCallPeriodEnd: z.string().optional(),
  reinvestmentPeriodEnd: z.string().optional(),
  firstPaymentDate: z.string().optional(),
  paymentFrequency: z.string().optional(),
}).passthrough();

export type PpmKeyDates = z.infer<typeof ppmKeyDatesSchema>;

export const ppmKeyPartiesSchema = z.object({
  keyParties: z.array(z.object({
    role: z.string().optional(),
    entity: z.string().optional(),
  }).passthrough()).optional(),
  cmDetails: z.object({
    name: z.string().optional(),
    parent: z.string().optional(),
    replacementMechanism: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export type PpmKeyParties = z.infer<typeof ppmKeyPartiesSchema>;

export const ppmRedemptionSchema = z.object({
  redemptionProvisions: z.array(z.object({
    type: z.string().optional(),
    description: z.string().optional(),
  }).passthrough()).optional(),
  eventsOfDefault: z.array(z.object({
    event: z.string().optional(),
    description: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

export type PpmRedemption = z.infer<typeof ppmRedemptionSchema>;

export const ppmInterestMechanicsSchema = z.object({
  dayCount: z.string().optional(),
  referenceRate: z.string().optional(),
  referenceRateFloorPct: z.number().nullable().optional(),
  deferredInterestCompounds: z.boolean().nullable().optional(),
  deferralClasses: z.array(z.string()).optional(),
  subNoteInterest: z.string().optional(),
}).passthrough();

export type PpmInterestMechanics = z.infer<typeof ppmInterestMechanicsSchema>;

export const ppmHedgingSchema = z.object({
  currencyHedgeRequired: z.boolean().optional(),
  hedgeTypes: z.string().optional(),
  counterpartyRatingReq: z.string().optional(),
  replacementTimeline: z.string().optional(),
  maxCurrencyHedgePct: z.string().optional(),
}).passthrough();

export type PpmHedging = z.infer<typeof ppmHedgingSchema>;

// ─── §20 Notes Payment History (inception-to-date) ────────────────────

export const notesInformationSchema = z.object({
  perTranche: z.record(z.string(), z.array(z.object({
    period:                 z.number().nullable(),
    paymentDate:            z.string(),              // YYYY-MM-DD
    parCommitment:          z.number().nullable(),
    factor:                 z.number().nullable(),
    interestPaid:           z.number().nullable(),
    principalPaid:          z.number().nullable(),
    cashflow:               z.number().nullable(),
    endingBalance:          z.number().nullable(),
    interestShortfall:      z.number().nullable(),
    accumInterestShortfall: z.number().nullable(),
  }))),
});

export type NotesInformation = z.infer<typeof notesInformationSchema>;
