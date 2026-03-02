import { z } from "zod";

const overflowItem = z.object({
  label: z.string(),
  content: z.unknown(),
});

// ─── Pass 1: Report Metadata + Pool Summary + All Compliance Tests ───

export const pass1Schema = z.object({
  reportMetadata: z.object({
    reportDate: z.string(),
    paymentDate: z.string().nullable().optional(),
    previousPaymentDate: z.string().nullable().optional(),
    reportType: z.enum(["quarterly", "semi-annual", "annual", "ad-hoc"]).nullable().optional(),
    reportSource: z.string().nullable().optional(),
    reportingPeriodStart: z.string().nullable().optional(),
    reportingPeriodEnd: z.string().nullable().optional(),
    dealName: z.string().nullable().optional(),
    trusteeName: z.string().nullable().optional(),
    collateralManager: z.string().nullable().optional(),
  }),

  poolSummary: z.object({
    totalPar: z.number().nullable().optional(),
    totalPrincipalBalance: z.number().nullable().optional(),
    totalMarketValue: z.number().nullable().optional(),
    numberOfObligors: z.number().nullable().optional(),
    numberOfAssets: z.number().nullable().optional(),
    numberOfIndustries: z.number().nullable().optional(),
    numberOfCountries: z.number().nullable().optional(),
    targetPar: z.number().nullable().optional(),
    parSurplusDeficit: z.number().nullable().optional(),
    wacSpread: z.number().nullable().optional(),
    wacTotal: z.number().nullable().optional(),
    walYears: z.number().nullable().optional(),
    warf: z.number().nullable().optional(),
    diversityScore: z.number().nullable().optional(),
    waRecoveryRate: z.number().nullable().optional(),
    waMoodysRecovery: z.number().nullable().optional(),
    waSpRecovery: z.number().nullable().optional(),
    pctFixedRate: z.number().nullable().optional(),
    pctFloatingRate: z.number().nullable().optional(),
    pctCovLite: z.number().nullable().optional(),
    pctSecondLien: z.number().nullable().optional(),
    pctSeniorSecured: z.number().nullable().optional(),
    pctBonds: z.number().nullable().optional(),
    pctCurrentPay: z.number().nullable().optional(),
    pctDefaulted: z.number().nullable().optional(),
    pctCccAndBelow: z.number().nullable().optional(),
    pctSingleB: z.number().nullable().optional(),
    pctDiscountObligations: z.number().nullable().optional(),
    pctLongDated: z.number().nullable().optional(),
    pctSemiAnnualPay: z.number().nullable().optional(),
    pctQuarterlyPay: z.number().nullable().optional(),
    pctEurDenominated: z.number().nullable().optional(),
    pctGbpDenominated: z.number().nullable().optional(),
    pctUsdDenominated: z.number().nullable().optional(),
    pctNonBaseCurrency: z.number().nullable().optional(),
  }),

  complianceTests: z.array(z.object({
    testName: z.string(),
    testType: z.string().nullable().optional(),
    testClass: z.string().nullable().optional(),
    numerator: z.number().nullable().optional(),
    denominator: z.number().nullable().optional(),
    actualValue: z.number().nullable().optional(),
    triggerLevel: z.number().nullable().optional(),
    thresholdLevel: z.number().nullable().optional(),
    cushionPct: z.number().nullable().optional(),
    cushionAmount: z.number().nullable().optional(),
    isPassing: z.boolean().nullable().optional(),
    cureAmount: z.number().nullable().optional(),
    consequenceIfFail: z.string().nullable().optional(),
    matrixRow: z.string().nullable().optional(),
    matrixColumn: z.string().nullable().optional(),
    testMethodology: z.string().nullable().optional(),
    adjustmentDescription: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  })),

  accountBalances: z.array(z.object({
    accountName: z.string(),
    accountType: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    balanceAmount: z.number().nullable().optional(),
    requiredBalance: z.number().nullable().optional(),
    excessDeficit: z.number().nullable().optional(),
  })).optional().default([]),

  parValueAdjustments: z.array(z.object({
    testName: z.string().nullable().optional(),
    adjustmentType: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    grossAmount: z.number().nullable().optional(),
    adjustmentAmount: z.number().nullable().optional(),
    netAmount: z.number().nullable().optional(),
    calculationMethod: z.string().nullable().optional(),
  })).optional().default([]),

  _overflow: z.array(overflowItem).optional().default([]),
});

export type Pass1Output = z.infer<typeof pass1Schema>;

// ─── Pass 2: Full Holdings Schedule ──────────────────────────────────

export const pass2Schema = z.object({
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
    remainingLifeYears: z.number().nullable().optional(),
    warfContribution: z.number().nullable().optional(),
    diversityScoreGroup: z.string().nullable().optional(),
  })),

  _overflow: z.array(overflowItem).optional().default([]),
});

export type Pass2Output = z.infer<typeof pass2Schema>;

// ─── Pass 3: Concentration & Distribution Details ────────────────────

export const pass3Schema = z.object({
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
    ratingFactorAvg: z.number().nullable().optional(),
  })),

  _overflow: z.array(overflowItem).optional().default([]),
});

export type Pass3Output = z.infer<typeof pass3Schema>;

// ─── Pass 4: Waterfall + Cash Flow + Trading Activity ────────────────

export const pass4Schema = z.object({
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
    accruedInterestTraded: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    counterparty: z.string().nullable().optional(),
    isCreditRiskSale: z.boolean().nullable().optional(),
    isCreditImproved: z.boolean().nullable().optional(),
    isDiscretionary: z.boolean().nullable().optional(),
  })).optional().default([]),

  tradingSummary: z.object({
    totalPurchasesPar: z.number().nullable().optional(),
    totalPurchasesCost: z.number().nullable().optional(),
    totalSalesPar: z.number().nullable().optional(),
    totalSalesProceeds: z.number().nullable().optional(),
    netGainLoss: z.number().nullable().optional(),
    totalPaydowns: z.number().nullable().optional(),
    totalPrepayments: z.number().nullable().optional(),
    totalDefaultsPar: z.number().nullable().optional(),
    totalRecoveries: z.number().nullable().optional(),
    turnoverRate: z.number().nullable().optional(),
    creditRiskSalesPar: z.number().nullable().optional(),
    discretionarySalesPar: z.number().nullable().optional(),
    remainingDiscretionaryAllowance: z.number().nullable().optional(),
  }).optional(),

  trancheSnapshots: z.array(z.object({
    className: z.string(),
    currentBalance: z.number().nullable().optional(),
    factor: z.number().nullable().optional(),
    currentIndexRate: z.number().nullable().optional(),
    couponRate: z.number().nullable().optional(),
    deferredInterestBalance: z.number().nullable().optional(),
    enhancementPct: z.number().nullable().optional(),
    beginningBalance: z.number().nullable().optional(),
    endingBalance: z.number().nullable().optional(),
    interestAccrued: z.number().nullable().optional(),
    interestPaid: z.number().nullable().optional(),
    interestShortfall: z.number().nullable().optional(),
    cumulativeShortfall: z.number().nullable().optional(),
    principalPaid: z.number().nullable().optional(),
    daysAccrued: z.number().nullable().optional(),
  })).optional().default([]),

  _overflow: z.array(overflowItem).optional().default([]),
});

export type Pass4Output = z.infer<typeof pass4Schema>;

// ─── Pass 5: Supplementary / Everything Else ─────────────────────────

export const pass5Schema = z.object({
  fees: z.array(z.object({
    feeType: z.string(),
    payee: z.string().nullable().optional(),
    rate: z.string().nullable().optional(),
    accrued: z.number().nullable().optional(),
    paid: z.number().nullable().optional(),
    unpaid: z.number().nullable().optional(),
    waterfallPriority: z.number().nullable().optional(),
    isSenior: z.boolean().nullable().optional(),
    isSubordinate: z.boolean().nullable().optional(),
    isIncentive: z.boolean().nullable().optional(),
  })).optional().default([]),

  hedgePositions: z.array(z.object({
    hedgeType: z.string(),
    counterparty: z.string().nullable().optional(),
    counterpartyRating: z.string().nullable().optional(),
    notional: z.number().nullable().optional(),
    payLeg: z.string().nullable().optional(),
    receiveLeg: z.string().nullable().optional(),
    fxRate: z.number().nullable().optional(),
    mtm: z.number().nullable().optional(),
    maturityDate: z.string().nullable().optional(),
    hedgeCost: z.number().nullable().optional(),
  })).optional().default([]),

  fxRates: z.array(z.object({
    baseCurrency: z.string(),
    quoteCurrency: z.string(),
    spotRate: z.number().nullable().optional(),
    hedgeRate: z.number().nullable().optional(),
    source: z.string().nullable().optional(),
  })).optional().default([]),

  spCdoMonitor: z.array(z.object({
    tranche: z.string(),
    targetRating: z.string().nullable().optional(),
    sdr: z.number().nullable().optional(),
    bdr: z.number().nullable().optional(),
    cushion: z.number().nullable().optional(),
    recoveryAssumptions: z.string().nullable().optional(),
  })).optional().default([]),

  moodysAnalytics: z.object({
    warf: z.number().nullable().optional(),
    diversityScore: z.number().nullable().optional(),
    matrixValues: z.record(z.string(), z.unknown()).nullable().optional(),
    waSpread: z.number().nullable().optional(),
    waCoupon: z.number().nullable().optional(),
    waRecovery: z.number().nullable().optional(),
    waLife: z.number().nullable().optional(),
  }).optional(),

  ratingActions: z.array(z.object({
    agency: z.string(),
    tranche: z.string().nullable().optional(),
    priorRating: z.string().nullable().optional(),
    newRating: z.string().nullable().optional(),
    actionType: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    outlook: z.string().nullable().optional(),
  })).optional().default([]),

  events: z.array(z.object({
    eventType: z.string().nullable().optional(),
    eventDate: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    isEventOfDefault: z.boolean().nullable().optional(),
    isCured: z.boolean().nullable().optional(),
    cureDate: z.string().nullable().optional(),
    impactDescription: z.string().nullable().optional(),
  })).optional().default([]),

  taxInformation: z.object({
    jurisdiction: z.string().nullable().optional(),
    withholdingRate: z.number().nullable().optional(),
    grossUp: z.boolean().nullable().optional(),
    taxEvents: z.array(z.string()).nullable().optional(),
  }).optional(),

  regulatoryFlags: z.array(z.object({
    regulationName: z.string(),
    requirement: z.string().nullable().optional(),
    complianceStatus: z.string().nullable().optional(),
    riskRetentionDetails: z.string().nullable().optional(),
  })).optional().default([]),

  eligibilityTestResults: z.array(z.object({
    criterionName: z.string(),
    isPassing: z.boolean().nullable().optional(),
    failureImpact: z.string().nullable().optional(),
  })).optional().default([]),

  reinvestmentConstraints: z.array(z.object({
    constraintName: z.string(),
    constraintType: z.string().nullable().optional(),
    isActive: z.boolean().nullable().optional(),
    startDate: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
  })).optional().default([]),

  saleLimitations: z.array(z.object({
    category: z.string(),
    allowedAmount: z.number().nullable().optional(),
    usedAmount: z.number().nullable().optional(),
    remainingAmount: z.number().nullable().optional(),
  })).optional().default([]),

  testMatrices: z.array(z.object({
    matrixName: z.string(),
    rows: z.array(z.string()).nullable().optional(),
    columns: z.array(z.string()).nullable().optional(),
    cellValues: z.record(z.string(), z.unknown()).nullable().optional(),
  })).optional().default([]),

  _overflow: z.array(overflowItem).optional().default([]),
});

export type Pass5Output = z.infer<typeof pass5Schema>;
