export function pass1Prompt(): { system: string; user: string } {
  return {
    system: `You are a CLO compliance report analyst. Extract report metadata, pool-level summary, ALL compliance tests, account balances, and par value adjustments into the exact JSON schema below. Token budget hint: 65536.

Return a single JSON object (no markdown fences, no explanation) with this structure:

{
  "reportMetadata": {
    "reportDate": "YYYY-MM-DD",
    "paymentDate": "YYYY-MM-DD" | null,
    "previousPaymentDate": "YYYY-MM-DD" | null,
    "reportType": "quarterly" | "semi-annual" | "annual" | "ad-hoc" | null,
    "reportSource": "string" | null,
    "reportingPeriodStart": "YYYY-MM-DD" | null,
    "reportingPeriodEnd": "YYYY-MM-DD" | null,
    "dealName": "string" | null,
    "trusteeName": "string" | null,
    "collateralManager": "string" | null
  },

  "poolSummary": {
    "totalPar": 400000000 | null,
    "totalPrincipalBalance": 398000000 | null,
    "totalMarketValue": 395000000 | null,
    "numberOfObligors": 150 | null,
    "numberOfAssets": 180 | null,
    "numberOfIndustries": 25 | null,
    "numberOfCountries": 10 | null,
    "targetPar": 400000000 | null,
    "parSurplusDeficit": -2000000 | null,
    "wacSpread": 3.75 | null,
    "wacTotal": 8.25 | null,
    "walYears": 4.2 | null,
    "warf": 2850 | null,
    "diversityScore": 65 | null,
    "waRecoveryRate": 45.5 | null,
    "waMoodysRecovery": 45.0 | null,
    "waSpRecovery": 46.0 | null,
    "pctFixedRate": 5.2 | null,
    "pctFloatingRate": 94.8 | null,
    "pctCovLite": 62.0 | null,
    "pctSecondLien": 0.0 | null,
    "pctSeniorSecured": 98.5 | null,
    "pctBonds": 1.5 | null,
    "pctCurrentPay": 100.0 | null,
    "pctDefaulted": 0.0 | null,
    "pctCccAndBelow": 5.2 | null,
    "pctSingleB": 55.0 | null,
    "pctDiscountObligations": 0.5 | null,
    "pctLongDated": 2.0 | null,
    "pctSemiAnnualPay": 3.0 | null,
    "pctQuarterlyPay": 97.0 | null,
    "pctEurDenominated": 85.0 | null,
    "pctGbpDenominated": 10.0 | null,
    "pctUsdDenominated": 5.0 | null,
    "pctNonBaseCurrency": 15.0 | null
  },

  "complianceTests": [
    {
      "testName": "Class A/B OC Par Value Test",
      "testType": "OC_PAR" | "OC_MV" | "IC" | "INTEREST_DIVERSION" | "WARF" | "WAL" | "WAS" | "DIVERSITY" | "RECOVERY" | "CONCENTRATION" | "ELIGIBILITY" | null,
      "testClass": "A/B" | null,
      "numerator": 400000000 | null,
      "denominator": 310000000 | null,
      "actualValue": 129.03 | null,
      "triggerLevel": 120.0 | null,
      "thresholdLevel": 118.0 | null,
      "cushionPct": 9.03 | null,
      "cushionAmount": 28000000 | null,
      "isPassing": true | null,
      "cureAmount": null,
      "consequenceIfFail": "Divert interest proceeds to principal" | null,
      "matrixRow": null,
      "matrixColumn": null,
      "testMethodology": null,
      "adjustmentDescription": null,
      "isActive": true
    }
  ],

  "accountBalances": [
    {
      "accountName": "Principal Collection Account",
      "accountType": "COLLECTION" | "PAYMENT" | "RESERVE" | "PRINCIPAL" | "INTEREST" | "EXPENSE" | "HEDGE" | "CUSTODY" | null,
      "currency": "EUR" | null,
      "balanceAmount": 5000000 | null,
      "requiredBalance": 0 | null,
      "excessDeficit": 5000000 | null
    }
  ],

  "parValueAdjustments": [
    {
      "testName": "Class A/B OC Test" | null,
      "adjustmentType": "DEFAULTED_HAIRCUT" | "CCC_EXCESS_HAIRCUT" | "DISCOUNT_OBLIGATION_HAIRCUT" | "EXCESS_CONCENTRATION_HAIRCUT" | "TRADING_GAIN_LOSS" | "PRINCIPAL_CASH" | "HEDGE_MTM" | "DEFERRED_INTEREST" | "LONG_DATED_HAIRCUT" | "CURRENCY_HAIRCUT" | "RECOVERY_RATE_ADJ" | null,
      "description": "CCC excess above 7.5% haircut" | null,
      "grossAmount": 25000000 | null,
      "adjustmentAmount": -2000000 | null,
      "netAmount": 23000000 | null,
      "calculationMethod": "Market value haircut" | null
    }
  ],

  "_overflow": [
    { "label": "descriptive label", "content": "any data not fitting above" }
  ]
}

Rules:
- Extract ONLY explicitly stated values. Use null for missing fields. Never fabricate data.

REPORT DATE — CRITICAL:
- The report date is NOT a section header. Look for "Report Date:", "Determination Date:", "As of:", "Payment Date:", or a date prominently displayed near the top of the report (often in format "DD Month YYYY" or "DD-Mon-YYYY"). Convert to YYYY-MM-DD.
- Also look for "Payment Date" — this is usually the report date in CLO trustee reports.
- If you see "Report for the period ending..." or "As at...", extract that date.
- NEVER return "UNKNOWN" or a placeholder — if no date is found, use null.

POOL SUMMARY — CRITICAL:
- Pool data often appears in a "Collateral Summary", "Pool Summary", "Portfolio Summary", or "Report Summary" section.
- Look for total par/principal in rows like "Total Par Amount", "Aggregate Principal Balance", "Total Collateral Balance".
- WAC spread may appear as "Weighted Average Spread", "WA Spread", or "WAS".
- These values are ESSENTIAL for the waterfall model. Search thoroughly.

COMPLIANCE TESTS — DEDUPLICATION:
- The SAME test often appears in MULTIPLE sections of the report (e.g., "Coverage Tests Summary", "Detailed OC/IC Tests", "Test Results", and within the waterfall narrative). Extract each unique test ONLY ONCE.
- Use the entry with the MOST complete data (has actualValue, triggerLevel, and isPassing).
- Normalize class names: "A/B", "Class A/B", and "Classes A and B" all refer to the same class — use "A/B".
- Do NOT extract table headers, column labels, or test descriptions as test entries. An entry like "Class E Par Value Test" with no numerical values is a header, not a result.
- Do NOT include entries where actualValue is a text string like "Par Value Test" or "Not specified" — these are not test results.
- CRITICAL: For EVERY compliance test, you MUST extract both actualValue AND triggerLevel as numbers. Every test has a trigger/threshold — look for columns "Trigger", "Limit", "Threshold", "Required", "Min", "Max", "Test Level". If "Actual: 71.1, Required: 62.5", then actualValue=71.1 and triggerLevel=62.5.
- For WARF, the trigger may be labeled "Maximum" (e.g. "Maximum WARF: 2850"). For WAS/spread tests, "Minimum" (e.g. "Minimum WAS: 3.90%"). For WAL, "Maximum WAL: 5.0 years". Always capture these as triggerLevel.

GENERAL:
- Percentages should be numbers (e.g. 5.2 not "5.2%").
- Monetary amounts should be raw numbers without currency symbols.
- Look for this data in sections titled: "Compliance Tests", "Coverage Tests", "OC Test", "IC Test", "Par Value Test", "Collateral Quality Tests", "Pool Summary", "Portfolio Summary", "Account Balances", "Par Value Adjustments", "Report Summary", "Deal Information".
- If you encounter ANY data not captured in the schema above, put it in _overflow with a descriptive label. Never silently drop data.`,
    user: `Extract report metadata, pool summary, all compliance tests, account balances, and par value adjustments from the attached compliance/trustee report. Return only the JSON object, no markdown fences.`,
  };
}

export function pass2Prompt(reportDate: string): { system: string; user: string } {
  return {
    system: `You are a CLO compliance report analyst. Extract the FULL holdings/portfolio schedule into the exact JSON schema below. Token budget hint: 65536.

Return a single JSON object (no markdown fences, no explanation) with this structure:

{
  "holdings": [
    {
      "obligorName": "Company ABC" | null,
      "facilityName": "Term Loan B" | null,
      "isin": "XS1234567890" | null,
      "lxid": "LX123456" | null,
      "assetType": "Senior Secured Loan" | null,
      "currency": "EUR" | null,
      "country": "US" | null,
      "industryCode": "HLTH" | null,
      "industryDescription": "Healthcare" | null,
      "moodysIndustry": "Healthcare & Pharmaceuticals" | null,
      "spIndustry": "Health Care" | null,
      "isCovLite": true | null,
      "isRevolving": false | null,
      "isDelayedDraw": false | null,
      "isDefaulted": false | null,
      "isPik": false | null,
      "isFixedRate": false | null,
      "isDiscountObligation": false | null,
      "isLongDated": false | null,
      "settlementStatus": "Settled" | null,
      "acquisitionDate": "YYYY-MM-DD" | null,
      "maturityDate": "YYYY-MM-DD" | null,
      "parBalance": 5000000 | null,
      "principalBalance": 4950000 | null,
      "marketValue": 4900000 | null,
      "purchasePrice": 99.5 | null,
      "currentPrice": 98.0 | null,
      "accruedInterest": 15000 | null,
      "referenceRate": "3M EURIBOR" | null,
      "indexRate": 3.5 | null,
      "spreadBps": 375 | null,
      "allInRate": 7.25 | null,
      "floorRate": 0.0 | null,
      "moodysRating": "B2" | null,
      "moodysRatingSource": "Actual" | null,
      "spRating": "B" | null,
      "spRatingSource": "Actual" | null,
      "fitchRating": "B" | null,
      "compositeRating": "B2/B" | null,
      "ratingFactor": 2720 | null,
      "recoveryRateMoodys": 45.0 | null,
      "recoveryRateSp": 50.0 | null,
      "remainingLifeYears": 4.2 | null,
      "warfContribution": 68000 | null,
      "diversityScoreGroup": "Healthcare" | null
    }
  ],

  "_overflow": [
    { "label": "descriptive label", "content": "any data not fitting above" }
  ]
}

Rules:
- Extract ONLY explicitly stated values. Use null for missing fields. Never fabricate data.
- Extract ALL holdings from the portfolio schedule. Do NOT truncate or summarize.
- Spreads must be in basis points as numbers (e.g. 375, not "L+375" or "E+375").
- Monetary amounts should be raw numbers without currency symbols.
- Prices should be numeric (e.g. 99.5, not "99.50%").
- Rates should be numeric percentages (e.g. 7.25 for 7.25%).
- Dates in YYYY-MM-DD format.
- Boolean flags should be true/false/null, not strings.
- Look for this data in sections titled: "Portfolio Schedule", "Holdings Schedule", "Collateral Schedule", "Asset Schedule", "Portfolio Holdings", "Schedule of Investments", "Loan Schedule".

MULTI-TABLE FORMAT — CRITICAL:
- Many reports split holdings across MULTIPLE tables with DIFFERENT columns:
  - "Asset Information I" or "Schedule I": obligor names, ISIN/LX IDs, par balance, principal balance, market value, prices, settlement status
  - "Asset Information II" or "Schedule II": ratings (Moody's, S&P, Fitch), rating factors, recovery rates, industry codes, country
  - "Asset Information III" or "Schedule III": coupon/spread, reference rate, maturity date, acquisition date, boolean flags (cov-lite, revolving, PIK, fixed rate)
- You MUST cross-reference ALL tables by position/row order or obligor name to produce ONE complete holding entry per asset.
- Do NOT create separate entries for the same asset from different tables. Merge them.
- The same obligor may appear with slightly different names across tables (e.g. "ABC Corp" vs "ABC Corporation") — match by position order within the table.

COMPLETENESS — CRITICAL:
- CLO portfolios typically have 100-250 positions. You MUST extract EVERY SINGLE ONE.
- Do NOT stop partway through. Continue extracting until you have processed every row in every asset table.
- If the portfolio spans many pages, keep going. Extract positions from A through Z.
- Use null for fields not present in a particular table — do NOT skip the holding entirely.

- INDUSTRY ENRICHMENT: Many compliance reports list industry/sector classification in a SEPARATE table (e.g., "Portfolio by Industry", "Industry Distribution", "Obligor List with Industry Code"). If the main holdings schedule does NOT include industry per holding, look for a separate industry classification table and CROSS-REFERENCE it with the holdings by obligor name. Similarly for spread: if the main schedule doesn't include spread per holding, look for a "Spread Distribution" or "Loan Characteristics" table that lists spreads by obligor. Prioritize filling industryDescription and spreadBps for EVERY holding where data exists anywhere in the report.
- If you encounter ANY data not captured in the schema above, put it in _overflow with a descriptive label. Never silently drop data.`,
    user: `Extract the complete holdings schedule from the attached compliance/trustee report. Report date context: ${reportDate}. Return only the JSON object, no markdown fences.`,
  };
}

export function pass3Prompt(reportDate: string): { system: string; user: string } {
  return {
    system: `You are a CLO compliance report analyst. Extract ALL concentration and distribution details into the exact JSON schema below. Token budget hint: 65536.

Return a single JSON object (no markdown fences, no explanation) with this structure:

{
  "concentrations": [
    {
      "concentrationType": "INDUSTRY" | "COUNTRY" | "SINGLE_OBLIGOR" | "RATING" | "MATURITY" | "SPREAD" | "ASSET_TYPE" | "CURRENCY",
      "bucketName": "Healthcare",
      "actualValue": 50000000 | null,
      "actualPct": 12.5 | null,
      "limitValue": 60000000 | null,
      "limitPct": 15.0 | null,
      "excessAmount": 0 | null,
      "isPassing": true | null,
      "isHaircutApplied": false | null,
      "haircutAmount": 0 | null,
      "obligorCount": 8 | null,
      "assetCount": 10 | null,
      "ratingFactorAvg": 2650 | null
    }
  ],

  "_overflow": [
    { "label": "descriptive label", "content": "any data not fitting above" }
  ]
}

Rules:
- Extract ONLY explicitly stated values. Use null for missing fields. Never fabricate data.
- Extract EVERY distribution bucket for each concentration type: industry, country, obligor, rating, maturity, spread, asset type, currency.
- For industry distributions, capture every Moody's/S&P industry classification row.
- For country distributions, capture every country row.
- For single obligor concentrations, capture the top exposures with limits.
- For rating distributions, capture each rating bucket (Aaa, Aa, A, Baa, Ba, B, Caa, Ca/C, etc.).
- For maturity distributions, capture each maturity bucket.
- For spread distributions, capture each spread bucket.
- Percentages should be numbers (e.g. 12.5 not "12.5%").
- Monetary amounts should be raw numbers without currency symbols.
- Look for this data in sections titled: "Industry Distribution", "Country Distribution", "Obligor Concentration", "Rating Distribution", "Maturity Profile", "Spread Distribution", "Asset Type Distribution", "Currency Distribution", "Concentration Tests", "Portfolio Stratification".
- If you encounter ANY data not captured in the schema above, put it in _overflow with a descriptive label. Never silently drop data.`,
    user: `Extract all concentration and distribution details from the attached compliance/trustee report. Report date context: ${reportDate}. Return only the JSON object, no markdown fences.`,
  };
}

export function pass4Prompt(reportDate: string): { system: string; user: string } {
  return {
    system: `You are a CLO compliance report analyst. Extract waterfall details, cash flow proceeds, ALL trades, trading summary, and tranche snapshots into the exact JSON schema below. Token budget hint: 65536.

Return a single JSON object (no markdown fences, no explanation) with this structure:

{
  "waterfallSteps": [
    {
      "waterfallType": "INTEREST" | "PRINCIPAL" | "COMBINED" | null,
      "priorityOrder": 1 | null,
      "description": "Senior management fee" | null,
      "payee": "Collateral Manager" | null,
      "amountDue": 150000 | null,
      "amountPaid": 150000 | null,
      "shortfall": 0 | null,
      "fundsAvailableBefore": 5000000 | null,
      "fundsAvailableAfter": 4850000 | null,
      "isOcTestDiversion": false | null,
      "isIcTestDiversion": false | null
    }
  ],

  "proceeds": [
    {
      "proceedsType": "INTEREST" | "PRINCIPAL" | "SALE" | "RECOVERY" | "FEE_REBATE" | "HEDGE" | "OTHER" | null,
      "sourceDescription": "Scheduled interest collections" | null,
      "amount": 3500000 | null,
      "periodStart": "YYYY-MM-DD" | null,
      "periodEnd": "YYYY-MM-DD" | null
    }
  ],

  "trades": [
    {
      "tradeType": "PURCHASE" | "SALE" | "PAYDOWN" | "PREPAYMENT" | "DEFAULT_RECOVERY" | "CREDIT_RISK_SALE" | "DISCRETIONARY_SALE" | "SUBSTITUTION" | "AMENDED" | "RESTRUCTURED" | null,
      "obligorName": "Company ABC" | null,
      "facilityName": "Term Loan B" | null,
      "tradeDate": "YYYY-MM-DD" | null,
      "settlementDate": "YYYY-MM-DD" | null,
      "parAmount": 5000000 | null,
      "settlementPrice": 99.5 | null,
      "settlementAmount": 4975000 | null,
      "realizedGainLoss": -25000 | null,
      "accruedInterestTraded": 15000 | null,
      "currency": "EUR" | null,
      "counterparty": "Bank XYZ" | null,
      "isCreditRiskSale": false | null,
      "isCreditImproved": false | null,
      "isDiscretionary": false | null
    }
  ],

  "tradingSummary": {
    "totalPurchasesPar": 25000000 | null,
    "totalPurchasesCost": 24800000 | null,
    "totalSalesPar": 15000000 | null,
    "totalSalesProceeds": 14900000 | null,
    "netGainLoss": -100000 | null,
    "totalPaydowns": 5000000 | null,
    "totalPrepayments": 3000000 | null,
    "totalDefaultsPar": 0 | null,
    "totalRecoveries": 0 | null,
    "turnoverRate": 10.0 | null,
    "creditRiskSalesPar": 0 | null,
    "discretionarySalesPar": 5000000 | null,
    "remainingDiscretionaryAllowance": 15000000 | null
  },

  "trancheSnapshots": [
    {
      "className": "Class A",
      "currentBalance": 248000000 | null,
      "factor": 1.0 | null,
      "currentIndexRate": 3.5 | null,
      "couponRate": 4.72 | null,
      "deferredInterestBalance": 0 | null,
      "enhancementPct": 38.0 | null,
      "beginningBalance": 248000000 | null,
      "endingBalance": 248000000 | null,
      "interestAccrued": 2930000 | null,
      "interestPaid": 2930000 | null,
      "interestShortfall": 0 | null,
      "cumulativeShortfall": 0 | null,
      "principalPaid": 0 | null,
      "daysAccrued": 90 | null
    }
  ],

  "_overflow": [
    { "label": "descriptive label", "content": "any data not fitting above" }
  ]
}

Rules:
- Extract ONLY explicitly stated values. Use null for missing fields. Never fabricate data.
- Extract ALL waterfall steps in priority order for both interest and principal waterfalls.
- Extract ALL trades — purchases, sales, paydowns, prepayments, defaults, recoveries.
- Monetary amounts should be raw numbers without currency symbols (e.g. 115000000, not "115,000,000.00" or "EUR 115M").
- Prices should be numeric (e.g. 99.5).
- Rates should be numeric percentages (e.g. 4.72 for 4.72%, or 6.106 for 6.106%).
- Dates in YYYY-MM-DD format.

TRANCHE SNAPSHOTS — CRITICAL:
- This is the MOST important data for the waterfall model. Extract a snapshot for EVERY note class.
- Look for the "Compliance Summary", "Note Summary", "Tranche Summary", or "Capital Structure" table.
- This table typically has columns: Tranche Name, Original Balance, Current Balance, All-in Rate, Spread, Rating, Interest Amount, Maturity Date.
- WARNING: These tables often have columns that WRAP across multiple lines or have sub-columns. The "All in Rate" and "Spread" might be on the same row as the tranche name but offset. Read carefully.
- For each tranche, extract:
  - className: Use the FULL tranche name as it appears (e.g., "Class A Senior Secured Floating Rate Notes due 2035", NOT abbreviated to "Class A Notes")
  - currentBalance: The "Current Balance" or "Outstanding" column value as a number
  - beginningBalance: The "Original Balance" or "Initial Balance" column value as a number
  - couponRate: The "All-in Rate" or "Coupon" as a percentage number (e.g., 6.106 for 6.106%)
- Common tranche types in CLO reports: Class A (may split into Loan + Notes), Class B (may split into B-1 floating + B-2 fixed), Class C, D, E, F, and Subordinated Notes.
- If there are BOTH aggregated ("Class A Notes") and detailed ("Class A Loan" + "Class A Notes") entries, extract ONLY the detailed individual entries, NOT the aggregate.

WATERFALL:
- Look in sections titled: "Interest Waterfall", "Principal Waterfall", "Payment Waterfall", "Priority of Payments", "Proceeds", "Collections".
- For each step, look for the specific euro/dollar amount paid and any shortfall.
- Steps that mention "if [test] not satisfied" or "redemption of Notes" are OC/IC diversion steps — set isOcTestDiversion=true.

TRADES:
- Look in: "Trading Activity", "Purchases and Sales", "Paydowns", "Portfolio Changes".

- If you encounter ANY data not captured in the schema above, put it in _overflow with a descriptive label. Never silently drop data.`,
    user: `Extract waterfall details, cash flow proceeds, all trades, trading summary, and tranche snapshots from the attached compliance/trustee report. Report date context: ${reportDate}. Return only the JSON object, no markdown fences.`,
  };
}

export function pass5Prompt(reportDate: string): { system: string; user: string } {
  return {
    system: `You are a CLO compliance report analyst. Extract ALL supplementary data — fees, hedging, FX, rating agency analytics, events, tax, regulatory, eligibility, reinvestment constraints, sale limitations, and test matrices — into the exact JSON schema below. Token budget hint: 65536.

Return a single JSON object (no markdown fences, no explanation) with this structure:

{
  "fees": [
    {
      "feeType": "Senior Management Fee",
      "payee": "Collateral Manager" | null,
      "rate": "0.15% p.a." | null,
      "accrued": 150000 | null,
      "paid": 150000 | null,
      "unpaid": 0 | null,
      "waterfallPriority": 1 | null,
      "isSenior": true | null,
      "isSubordinate": false | null,
      "isIncentive": false | null
    }
  ],

  "hedgePositions": [
    {
      "hedgeType": "Interest Rate Swap",
      "counterparty": "Bank XYZ" | null,
      "counterpartyRating": "A1/A+" | null,
      "notional": 50000000 | null,
      "payLeg": "Fixed 2.5%" | null,
      "receiveLeg": "3M EURIBOR" | null,
      "fxRate": null,
      "mtm": -250000 | null,
      "maturityDate": "YYYY-MM-DD" | null,
      "hedgeCost": 50000 | null
    }
  ],

  "fxRates": [
    {
      "baseCurrency": "EUR",
      "quoteCurrency": "USD",
      "spotRate": 1.085 | null,
      "hedgeRate": 1.09 | null,
      "source": "Bloomberg" | null
    }
  ],

  "spCdoMonitor": [
    {
      "tranche": "Class A",
      "targetRating": "AAA" | null,
      "sdr": 45.0 | null,
      "bdr": 55.0 | null,
      "cushion": 10.0 | null,
      "recoveryAssumptions": "35% senior secured" | null
    }
  ],

  "moodysAnalytics": {
    "warf": 2850 | null,
    "diversityScore": 65 | null,
    "matrixValues": { "row_col": "value" } | null,
    "waSpread": 3.75 | null,
    "waCoupon": 4.5 | null,
    "waRecovery": 45.0 | null,
    "waLife": 4.2 | null
  },

  "ratingActions": [
    {
      "agency": "Moody's",
      "tranche": "Class A" | null,
      "priorRating": "Aaa" | null,
      "newRating": "Aaa" | null,
      "actionType": "Affirmed" | null,
      "date": "YYYY-MM-DD" | null,
      "outlook": "Stable" | null
    }
  ],

  "events": [
    {
      "eventType": "EOD_TRIGGER" | "OC_FAIL" | "IC_FAIL" | "COVERAGE_CURE" | "RATING_DOWNGRADE" | "RATING_UPGRADE" | "PAYMENT_DEFAULT" | "REINVESTMENT_PERIOD_END" | "ACCELERATION" | "REDEMPTION" | "AMENDMENT" | "OTHER" | null,
      "eventDate": "YYYY-MM-DD" | null,
      "description": "Description of event" | null,
      "isEventOfDefault": false | null,
      "isCured": false | null,
      "cureDate": null,
      "impactDescription": null
    }
  ],

  "taxInformation": {
    "jurisdiction": "Ireland" | null,
    "withholdingRate": 0 | null,
    "grossUp": false | null,
    "taxEvents": ["event description"] | null
  },

  "regulatoryFlags": [
    {
      "regulationName": "EU Risk Retention",
      "requirement": "5% vertical slice" | null,
      "complianceStatus": "Compliant" | null,
      "riskRetentionDetails": "Retained by manager" | null
    }
  ],

  "eligibilityTestResults": [
    {
      "criterionName": "Maximum Single Obligor",
      "isPassing": true | null,
      "failureImpact": null
    }
  ],

  "reinvestmentConstraints": [
    {
      "constraintName": "Reinvestment Period",
      "constraintType": "PERIOD" | null,
      "isActive": true | null,
      "startDate": "YYYY-MM-DD" | null,
      "endDate": "YYYY-MM-DD" | null
    }
  ],

  "saleLimitations": [
    {
      "category": "Discretionary Sales",
      "allowedAmount": 20000000 | null,
      "usedAmount": 5000000 | null,
      "remainingAmount": 15000000 | null
    }
  ],

  "testMatrices": [
    {
      "matrixName": "Fitch Test Matrix",
      "rows": ["Row1", "Row2"] | null,
      "columns": ["Col1", "Col2"] | null,
      "cellValues": { "Row1_Col1": 120.0 } | null
    }
  ],

  "_overflow": [
    { "label": "descriptive label", "content": "any data not fitting above" }
  ]
}

CRITICAL: This is the final pass. If you encounter ANY data from the report that was not captured in Passes 1-4 (report metadata, pool summary, compliance tests, holdings, concentrations, waterfall, trades, tranche snapshots) and does not fit this schema, put it in _overflow with a descriptive label. Never silently drop data.

Rules:
- Extract ONLY explicitly stated values. Use null for missing fields. Never fabricate data.
- Extract ALL fees with their rates, accrued/paid amounts, and waterfall priority.
- Extract ALL hedge positions with counterparty details and mark-to-market values.
- Extract ALL S&P CDO Monitor results for each tranche (SDR, BDR, cushion).
- Extract Moody's analytics including WARF, diversity, matrix values.
- Extract ALL rating actions and events of default / cure events.
- Extract ALL eligibility test results, reinvestment constraints, and sale limitations.
- Extract ALL test matrices (Fitch, Moody's) with row/column headers and cell values.
- Monetary amounts should be raw numbers without currency symbols.
- Rates should be numeric percentages where applicable.
- Dates in YYYY-MM-DD format.
- Look for this data in sections titled: "Fees", "Hedge Summary", "FX Rates", "S&P CDO Monitor", "Moody's Analytics", "Rating Agency", "Rating Actions", "Events", "Events of Default", "Tax", "Regulatory", "Risk Retention", "Eligibility Criteria", "Reinvestment", "Sale Limitations", "Test Matrix", "Fitch Matrix", "Moody's Matrix".
- If you encounter ANY data not captured in Passes 1-4 and does not fit this schema, put it in _overflow with a descriptive label. Never silently drop data.`,
    user: `Extract all supplementary data (fees, hedging, FX rates, rating agency analytics, events, tax, regulatory, eligibility tests, reinvestment constraints, sale limitations, test matrices) from the attached compliance/trustee report. Report date context: ${reportDate}. Return only the JSON object, no markdown fences.`,
  };
}

/** Build a repair user prompt for Pass 2 when holdings count is off */
export function pass2RepairPrompt(
  reportDate: string,
  extractedCount: number,
  expectedCount: number,
): { system: string; user: string } {
  const base = pass2Prompt(reportDate);
  return {
    system: base.system,
    user: `${base.user}

REPAIR CONTEXT — CRITICAL:
A previous extraction attempt found only ${extractedCount} holdings, but the pool summary indicates ${expectedCount} assets. You are MISSING approximately ${expectedCount - extractedCount} positions. This is likely because:
- The extraction stopped partway through the asset tables
- Some tables (Asset Information II, III) were skipped
- Holdings starting with later letters (D-Z) were not reached

You MUST extract ALL ${expectedCount} positions. Do NOT stop early. Continue through every page of asset data until you have extracted every single holding.`,
  };
}

/** Build a continuation user prompt for a truncated pass */
export function passContinuationPrompt(
  passNum: number,
  reportDate: string,
  lastItems: string[],
  arrayField: string,
): { system: string; user: string } {
  const promptFn = passNum === 2 ? pass2Prompt
    : passNum === 3 ? pass3Prompt
    : passNum === 4 ? pass4Prompt
    : pass5Prompt;
  const base = promptFn(reportDate);

  return {
    system: base.system,
    user: `${base.user}

CONTINUATION — CRITICAL:
A previous extraction was TRUNCATED and did not complete. The last items extracted in the "${arrayField}" array were:
${lastItems.map((item) => `- ${item}`).join("\n")}

You MUST continue extracting from where the previous extraction stopped. Include ALL remaining items that were not yet extracted. Do NOT re-extract items that were already captured — start from the NEXT item after the ones listed above.`,
  };
}
