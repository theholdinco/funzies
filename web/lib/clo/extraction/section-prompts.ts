type Prompt = { system: string; user: string };

const COMMON_RULES = `Rules:
- Extract ONLY explicitly stated values. Use null for missing fields. Never fabricate data.
- Percentages as numbers (e.g., 5.2 not "5.2%"). PPMs often write "per cent." or "per cent" instead of "%".
- Monetary amounts as raw numbers without currency symbols.
- Dates in YYYY-MM-DD format. Compliance reports use DD-MMM-YYYY (e.g., "26-Apr-2024"). PPMs use "DD Month YYYY" (e.g., "15 April 2038").
- PPM defined terms use smart/curly quotes (\u201c\u201d) not straight quotes. Both "Term" and \u201cTerm\u201d refer to the same defined term.`;

// ---------------------------------------------------------------------------
// Compliance Report Section Prompts
// ---------------------------------------------------------------------------

export function complianceSummaryPrompt(): Prompt {
  return {
    system: `You are extracting the compliance summary section of a CLO trustee report from markdown text that was transcribed from a PDF.

Extract:
- Report date, deal name, trustee, collateral manager
- Key deal dates: closing date, stated maturity, next payment date, collection period end, reinvestment period end, non-call period end
- Tranche table: class name, principal amount, spread, all-in rate, current balance, rating, coupon rate
- Pool summary metrics: total par, number of assets, number of obligors, WAC spread, WARF, diversity score, WAL, WA recovery rate
- Percentage breakdowns: fixed rate, floating rate, cov-lite, second lien, defaulted, CCC and below

REPORT DATE — CRITICAL:
- Look for "Report Date:", "Determination Date:", "As of:", "Payment Date:".
- Compliance reports use DD-MMM-YYYY format (e.g., "26-Apr-2024"). Convert to YYYY-MM-DD.
- NEVER return "UNKNOWN" or a placeholder — use null only as a last resort.

KEY DATES:
- The compliance summary page typically contains Deal Summary mini-tables with key-value pairs like:
  "Closing Date: 30-Nov-2022", "Stated Maturity: 15-Jul-2035", "Next Payment Date: 15-Oct-2024",
  "Next Collection Period End Date: 02-Oct-2024", "Reinvestment Period End: 14-Jul-2027".
- Extract ALL of these into the dedicated date fields. These are critical for deal modeling.

TRANCHE TABLE:
- BNY Mellon compliance reports have a 14-column tranche table:
  Tranche Name | Original Balance | Current Balance | All-in Rate | Spread | Interest Amount | CCY | Fitch Original | Fitch Current | Fitch CW | S&P Original | S&P Current | S&P CW | Maturity Date
- Tranche naming follows: "Class [LETTER] Senior Secured Floating Rate [Loan|Notes] due [YEAR]"
- Class A may be split into "Loan" and "Notes" sub-tranches.
- Class B may be split into "B-1" (floating) and "B-2" (fixed).
- Subordinated Notes are always last, with "N/A" for ratings and "Residual" for trigger levels.
- "All in Rate" = EURIBOR fixing + Spread. Spreads are shown as percentages (e.g., 2.20000%), not basis points.
- Extract ALL tranches from Class A through subordinated notes.

${COMMON_RULES}`,
    user: `Extract the compliance summary section from the following markdown text.`,
  };
}

export function parValueTestsPrompt(): Prompt {
  return {
    system: `You are extracting par value / overcollateralization tests from a CLO trustee report's markdown text.

For EACH test extract: testName, testClass, numerator, denominator, actualValue, triggerLevel, cushionPct, isPassing, consequenceIfFail.

CRITICAL: Every test has BOTH actualValue AND triggerLevel. Look for "Trigger", "Limit", "Threshold", "Required", "Min", "Max" columns. If "Actual: 129.03, Required: 120.0", then actualValue=129.03 and triggerLevel=120.0.

BNY MELLON TABLE FORMAT:
- The compliance test table uses a 9-column format:
  Test Name | Numerator | Denominator | Prior Outcome | Outcome | Requirement | [empty] | Result | [empty]
- Columns 6 and 8 are ALWAYS empty — they are BNY Mellon template artifacts. Skip them.
- The "Result" column (index 7) contains "Passed" or "Failed".
- The "Requirement" column uses operators: ">= X%", "<= X%", "<= X.XX" (for WARF, no %).
- "N/A" in the requirement column means informational metric, not a binding test.
- Percentages have 5 decimal places in compliance reports (e.g., "117.85%").

Par value adjustments: Extract haircuts for CCC excess, defaulted, discount obligations, etc. Each with testName, adjustmentType, description, grossAmount, adjustmentAmount, netAmount.

Normalize class names: "Class A/B", "Classes A and B" -> use "A/B".

DEDUPLICATION: Same test may appear in multiple places. Extract each unique test ONLY ONCE with the most complete data (has actualValue, triggerLevel, and isPassing).

${COMMON_RULES}`,
    user: `Extract all par value / overcollateralization tests from the following markdown text.`,
  };
}

export function defaultDetailPrompt(): Prompt {
  return {
    system: `You are extracting the Default and Deferring Detail section from a CLO trustee report.

This section lists individual defaulted and/or deferring obligations with per-obligor details.

For each defaulted or deferring obligation extract:
- obligorName: the borrower/issuer name
- securityId: ISIN, CUSIP, or LX identifier if available
- parAmount: the par/face amount of the defaulted position
- marketPrice: current market price as a percentage of par (e.g. 31.29 for 31.29%)
- recoveryRateFitch: Fitch recovery rate as percentage (e.g. 60.0)
- recoveryRateSp: S&P recovery rate as percentage (e.g. 28.5)
- recoveryRateMoodys: Moody's recovery rate as percentage if available
- isDefaulted: true if the obligation is defaulted, false if only deferring
- isDeferring: true if the obligation is deferring interest

${COMMON_RULES}`,
    user: `Extract all defaulted and deferring obligation details from the following markdown text.`,
  };
}

export function interestCoverageTestsPrompt(): Prompt {
  return {
    system: `You are extracting interest coverage (IC) tests from a CLO trustee report's markdown text.

For EACH test extract: testName, testClass, numerator, denominator, actualValue, triggerLevel, cushionPct, isPassing, consequenceIfFail.

Also extract interest amounts per tranche from the IC test denominator breakdown: className, interestAmount, currency.

CRITICAL: Every test has BOTH actualValue AND triggerLevel. Look for "Trigger", "Limit", "Threshold", "Required", "Min", "Max" columns.

BNY MELLON TABLE FORMAT:
- Same 9-column format as par value tests:
  Test Name | Numerator | Denominator | Prior Outcome | Outcome | Requirement | [empty] | Result | [empty]
- Columns 6 and 8 are ALWAYS empty — BNY Mellon template artifacts. Skip them.
- IC test detail pages also show "Amounts Payable Priority of Payments" breakdowns with actual fee amounts.

Normalize class names: "Class A/B", "Classes A and B" -> use "A/B".

DEDUPLICATION: Same test may appear in multiple places. Extract each unique test ONLY ONCE with the most complete data.

${COMMON_RULES}`,
    user: `Extract all interest coverage tests from the following markdown text.`,
  };
}

export function assetSchedulePrompt(): Prompt {
  return {
    system: `You are extracting the complete holdings schedule from a CLO trustee report's markdown text.

COMPLETENESS — CRITICAL:
- CLO portfolios have 100-250+ positions. You MUST extract EVERY SINGLE ONE.
- Do NOT stop partway through. Extract from A through Z.

BNY MELLON TABLE STRUCTURE:
- The holdings are split across three "Asset Information" sections with different column counts:
  Asset Info I (loans): 9 cols — Name, SecID, Type, MarketPrice, Principal, Par, Accrued, Seniority, Maturity
  Asset Info II (bonds): 10 cols — adds Currency, LGD%, Country, Lien
  Asset Info III (equity/other): 15 cols — adds Internal ID, Bloomberg ID, Ratings
- Security IDs follow patterns: LX###### for loans, XS########## for bonds (ISIN).
- All amounts in EUR with comma thousands separator, dot decimal: "3,462,041.94".
- Dates in DD-MMM-YYYY format: "16-Feb-2028".
- Deduplicate rows using composite key (obligorName, securityId) — multi-page tables may repeat headers.

For each holding extract: obligorName, facilityName, isin, lxid, assetType, currency, country, industryCode, industryDescription, moodysIndustry, spIndustry, ratings (moodysRating, spRating, fitchRating, compositeRating, ratingFactor), parBalance, principalBalance, marketValue, purchasePrice, currentPrice, accruedInterest, referenceRate, indexRate, spreadBps, allInRate, floorRate, recoveryRateMoodys, recoveryRateSp, recoveryRateFitch, remainingLifeYears, warfContribution, diversityScoreGroup, acquisitionDate, maturityDate, settlementStatus, boolean flags (isCovLite, isRevolving, isDelayedDraw, isDefaulted, isPik, isFixedRate, isDiscountObligation, isLongDated).

- Spreads in basis points as numbers (375 not "L+375")
- Prices as numbers (99.5)
- Rates as percentages (7.25 for 7.25%)
- Boolean flags as true/false/null
- Use null for missing fields, never fabricate data

${COMMON_RULES}`,
    user: `Extract the complete holdings schedule from the following markdown text.`,
  };
}

export function concentrationPrompt(): Prompt {
  return {
    system: `You are extracting concentration and distribution data from a CLO trustee report's markdown text.

Extract EVERY concentration/distribution bucket. Types: INDUSTRY, COUNTRY, SINGLE_OBLIGOR, RATING, MATURITY, SPREAD, ASSET_TYPE, CURRENCY.

For each bucket: concentrationType, bucketName, actualValue, actualPct, limitValue, limitPct, isPassing, excessAmount, isHaircutApplied, haircutAmount, obligorCount, assetCount.

BNY MELLON COMPLIANCE TEST FORMAT:
- Concentration limits are embedded within the compliance tests (typically pages 3-5), not in separate tables.
- They appear as Portfolio Profile Tests with alphabetical lettering:
  (a) through (s): asset type, rating, maturity, country limits, obligor limits
  (t)(i) through (t)(v): Fitch Industry concentration
  (u)(i) through (u)(v): S&P Industry concentration
  (aa) through (dd): Counterparty credit exposure
- Same 9-column format: Test Name | Numerator | Denominator | Prior Outcome | Outcome | Requirement | [empty] | Result | [empty]
- The "Requirement" column contains the limit (e.g., "<= 10.00%", ">= 27.00").
- Extract the test letter prefix as part of the bucketName for traceability.

Also include ALL rows from any standalone distribution tables:
- Industry distribution tables
- Country distribution tables
- Rating distribution tables
- Maturity/spread/asset type tables

${COMMON_RULES}`,
    user: `Extract all concentration and distribution data from the following markdown text.`,
  };
}

export function waterfallPrompt(): Prompt {
  return {
    system: `You are extracting waterfall payment data from a CLO trustee report's markdown text.

Extract ALL waterfall steps in priority order for both interest and principal waterfalls.
For each step: waterfallType (INTEREST/PRINCIPAL), priorityOrder, description, payee, amountDue, amountPaid, shortfall, fundsAvailableBefore, fundsAvailableAfter, isOcTestDiversion, isIcTestDiversion.

Extract proceeds: proceedsType, sourceDescription, amount, periodStart, periodEnd.

TRANCHE SNAPSHOTS — CRITICAL:
- Extract one for EVERY note class. These are essential for the waterfall model.
- For each: className, currentBalance, factor, couponRate, interestAccrued, interestPaid, interestShortfall, principalPaid, beginningBalance, endingBalance.
- Look for "Note Balances", "Tranche Payment Summary", "Payment Summary", "Note Payment" tables.
- beginningBalance and endingBalance are the opening/closing balances for the period.
- If BOTH aggregated ("Class A Notes") and detailed ("Class A Loan" + "Class A Notes") entries exist, use ONLY the detailed ones.

${COMMON_RULES}`,
    user: `Extract all waterfall steps, proceeds, and tranche snapshots from the following markdown text.`,
  };
}

export function tradingActivityPrompt(): Prompt {
  return {
    system: `You are extracting trading activity from a CLO trustee report's markdown text.

BNY MELLON FORMAT:
- Purchases and Sales are on a dedicated page (typically around page 29).
- "Purchase" and "Sale" are section headers; trades are listed under each.
- Following pages may contain Principal Paydowns/Borrowings and Hedge Transactions.
- Trade lines contain: Description, Security ID, Trade Date (DD-MMM-YYYY), Settlement Date, Currency, Par Amount, Settlement Price.

Extract ALL trades: purchases, sales, paydowns, prepayments, defaults, recoveries.
For each: tradeType (PURCHASE/SALE/PAYDOWN/PREPAYMENT/DEFAULT_RECOVERY/CREDIT_RISK_SALE/DISCRETIONARY_SALE/SUBSTITUTION/AMENDED/RESTRUCTURED), obligorName, facilityName, tradeDate, settlementDate, parAmount, settlementPrice, settlementAmount, realizedGainLoss, currency, isCreditRiskSale, isCreditImproved, isDiscretionary.

Extract trading summary: totalPurchasesPar, totalSalesPar, totalSalesProceeds, netGainLoss, totalPaydowns, totalRecoveries, creditRiskSalesPar, discretionarySalesPar, remainingDiscretionaryAllowance.

- Prices as numbers
- Amounts as raw numbers

${COMMON_RULES}`,
    user: `Extract all trading activity from the following markdown text.`,
  };
}

export function interestAccrualPrompt(): Prompt {
  return {
    system: `You are extracting per-asset interest rate details from a CLO trustee report's markdown text.

For each asset: obligorName, facilityName, referenceRate, baseRate, indexFloor, spread, creditSpreadAdj, effectiveSpread, allInRate.

- Rates as numbers (e.g., 3.5 for 3.5%, 375 for 375 bps spread)

${COMMON_RULES}`,
    user: `Extract per-asset interest rate details from the following markdown text.`,
  };
}

export function accountBalancesPrompt(): Prompt {
  return {
    system: `You are extracting account balances from a CLO trustee report's markdown text.

BNY MELLON FORMAT:
- Account names are prefixed with the deal name (e.g., "ARES EUROPEAN CLO XVI").
- Account type suffixes are standard BNY Mellon naming: "CUSTODY", "PAYMENT CSH", "SH CPTL CSH", "UNFUNDED CSH".
- Typically on pages 8-9 of the compliance report.

Extract ALL account balances.
For each: accountName, accountType (COLLECTION/PAYMENT/RESERVE/PRINCIPAL/INTEREST/EXPENSE/HEDGE/CUSTODY), currency, balanceAmount, requiredBalance, excessDeficit.

Look for: Payment Account, Interest Collection Account, Principal Collection Account, Reserve Account, Expense Account, Custody Account, and any other named accounts.

${COMMON_RULES}`,
    user: `Extract all account balances from the following markdown text.`,
  };
}

export function supplementaryPrompt(): Prompt {
  return {
    system: `You are extracting supplementary data from a CLO trustee report's markdown text.

Extract:
- Fees: feeType, payee, rate, accrued, paid, unpaid
- Hedge positions: hedgeType, counterparty, counterpartyRating, notional, mtm, maturityDate
- FX rates: baseCurrency, quoteCurrency, spotRate, hedgeRate
- Rating actions: agency, tranche, priorRating, newRating, actionType, date
- Events: eventType, eventDate, description, isEventOfDefault, isCured
- S&P CDO Monitor: tranche, sdr, bdr, cushion

${COMMON_RULES}`,
    user: `Extract all supplementary data (fees, hedging, FX rates, rating actions, events, S&P CDO Monitor) from the following markdown text.`,
  };
}

// ---------------------------------------------------------------------------
// PPM Section Prompts
// ---------------------------------------------------------------------------

export function ppmTransactionOverviewPrompt(): Prompt {
  return {
    system: `You are extracting the transaction overview from a CLO private placement memorandum's markdown text.

Extract deal identity: dealName, issuerLegalName, collateralManager, jurisdiction, entityType, governingLaw, currency, listingExchange.

CLO PPM STRUCTURE:
- The transaction overview is typically in the first few pages after front matter/TOC.
- Key parties are often listed in a dots-leader format: "Role........ Entity." (variable number of dots).
  e.g., "Collateral Manager..................................... Ares Management Limited."
  "Trustee........................................................ BNY Mellon Corporate Trustee Services Limited."
- The issuer legal name includes the entity type suffix (e.g., "DAC" = Designated Activity Company for Irish entities).
- European CLOs are typically Irish DACs governed by Irish law, listed on Euronext Dublin.
- The Collateral Manager is the entity managing the CLO's loan portfolio. Look for "The Collateral Manager is [name]", "[name] (as Collateral Manager)", or a dots-leader row.

${COMMON_RULES}`,
    user: `Extract the transaction overview from the following markdown text.`,
  };
}

export function ppmCapitalStructurePrompt(): Prompt {
  return {
    system: `You are extracting the capital structure from a CLO private placement memorandum's markdown text.

CRITICAL: Extract ALL tranches from Class A through subordinated/equity notes.
For each tranche: class, designation, principalAmount, rateType, referenceRate, spreadBps, spread, rating (fitch, sp), deferrable, maturityDate, isSubordinated.

spreadBps MUST be a NUMBER in basis points. Convert from percentage: "EURIBOR + 1.50%" = spreadBps: 150. Convert from string: "E + 150bps" = spreadBps: 150.
principalAmount should include the full string with currency, e.g., "EUR 248,000,000".

IMPORTANT — each tranche MUST be a COMPLETE object with ALL its fields. Do NOT interleave fields from different tranches. Process one tranche at a time, from Class A to Subordinated.

CLO TRANCHE PATTERNS:
- Typical order: Class X (tiny, amortises first), Class A, Class B-1 (floating), Class B-2 (fixed), Class C, Class D, Class E, Class F (sometimes), Subordinated Notes.
- Class A is always the most senior (lowest spread, highest rating, AAA). It may be split into "Loan" and "Notes" sub-tranches with same economics.
- Class B may be split into "B-1" (floating rate) and "B-2" (fixed rate).
- Subordinated Notes are always last (no rating, no spread, no coupon — returns are residual).
- Designation follows: "Class [LETTER] Senior Secured Floating Rate [Loan|Notes] due [YEAR]"
- "class" = the short name (e.g., "Class A"), "designation" = the full name
- All amounts in EUR with comma thousands separator.
- For European CLOs, reference rate is "3-month EURIBOR".

PPM CAPITAL STRUCTURE FORMAT:
- IMPORTANT: In PPMs, the capital structure on the overview pages is often rendered as FORMATTED TEXT, not a PDF table. extract_tables() may return nothing.
- Each tranche typically spans 2-3 lines of text with: class name, principal amount, rate type, spread, rating.
- Parse the multi-line text blocks carefully — do not expect a clean tabular structure.
- Spreads in PPMs are written as "per cent." not "%" (e.g., "1.50 per cent." = 150 bps).

Also extract deal sizing: targetParAmount, totalRatedNotes, totalSubordinatedNotes, totalDealSize, equityPctOfDeal.

PER-TRANCHE AMORTISATION:
For any tranche with a scheduled principal amortisation (most commonly Class X, but possible for others), extract two per-tranche fields:
- amortisationPerPeriod: the fixed per-payment-date principal amortisation amount as a string (e.g., "550000" for €550,000). Found in definitions as "[Class] Principal Amortisation Amount." Extract the fixed amount, NOT the formula.
- amortStartDate: when amortisation begins (e.g., "second payment date", an ISO date, or omit if it starts immediately).

${COMMON_RULES}`,
    user: `Extract the capital structure from the following markdown text.`,
  };
}

export function ppmCoverageTestsPrompt(): Prompt {
  return {
    system: `You are extracting coverage test definitions from a CLO private placement memorandum's markdown text.

Extract coverage test entries for EACH tranche class: class, parValueRatio (the OC test trigger level), interestCoverageRatio (the IC test trigger level).

CRITICAL — Trigger level format:
- Extract as PERCENTAGE, e.g. "129.10" for 129.10%. Do NOT extract as a ratio (1.2910).
- "129.10 per cent" → parValueRatio: "129.10"
- "120.00%" → interestCoverageRatio: "120.00"

PPM COVERAGE TEST FORMAT:
- Tests may be in the Definitions section as defined terms (with smart quotes \u201c\u201d):
  \u201cClass A/B Par Value Test\u201d means... "shall not be less than 129.31 per cent."
- Percentages in PPMs are written as "per cent." or "per cent" NOT "%".
- Look for: "Par Value Ratio", "Overcollateralisation Ratio", "Interest Coverage Ratio".
- Tests may be described in paragraph form: "the Class A/B Par Value Ratio shall not be less than 129.31 per cent"
- Also look for tables with columns like: Class | OC Trigger | IC Trigger
- NOTE: PPM trigger levels may differ from compliance report values if the deal was refinanced. Extract the PPM values as stated.

Extract reinvestment OC test: trigger level (as percentage, e.g. "102.95"), appliesDuring (e.g., "Reinvestment Period only"), diversionAmount (the exact percentage of remaining interest proceeds diverted, e.g. "50%" or "Up to 50%"). The diversion percentage is critical — look for phrases like "up to 50 per cent" or "100 per cent" of remaining available interest proceeds.

${COMMON_RULES}`,
    user: `Extract the coverage test definitions from the following markdown text.`,
  };
}

export function ppmEligibilityCriteriaPrompt(): Prompt {
  return {
    system: `You are extracting eligibility criteria from a CLO private placement memorandum's markdown text.

PPM ELIGIBILITY FORMAT:
- Eligibility criteria are typically defined under \u201cEligibility Criteria\u201d or \u201cCollateral Obligation\u201d in the Definitions section.
- They are usually lettered (a) through (z) or numbered.
- Criteria use defined terms (in smart quotes \u201c\u201d) extensively — extract the criterion text as-is.
- Some criteria are in the main body, others in annexes/schedules appended to the document.

Extract EVERY eligibility criterion (typically 30-45 items). Be exhaustive — check annexes and schedules in the text.

Also extract reinvestment criteria: duringReinvestment, postReinvestment, substituteRequirements.

${COMMON_RULES}`,
    user: `Extract all eligibility criteria from the following markdown text.`,
  };
}

export function ppmPortfolioConstraintsPrompt(): Prompt {
  return {
    system: `You are extracting portfolio constraints from a CLO private placement memorandum's markdown text.

PPM CONSTRAINT FORMAT:
- Portfolio Profile Tests and Collateral Quality Tests are defined terms in the Definitions section.
- Tests use alphabetical lettering matching compliance report format: (a) through (s), (t)(i)-(t)(v), (u)(i)-(u)(v), (aa)-(dd).
- Values are written as "per cent." not "%" — convert accordingly.
- WARF limits are absolute numbers (e.g., "<= 27.00"), not percentages.
- Some constraints are conditional/tiered (different limits during vs after reinvestment period).

Extract ALL collateral quality tests: WARF, WAS, WAL, diversity score, WA recovery rate, etc. Each with name, agency, value.

Extract ALL portfolio profile tests (typically 25-35 tests with min/max limits). Include conditional/tiered limits. Each test is a record with min, max, and optional notes.

${COMMON_RULES}`,
    user: `Extract all portfolio constraints from the following markdown text.`,
  };
}

export function ppmWaterfallRulesPrompt(): Prompt {
  return {
    system: `You are extracting waterfall rules from a CLO private placement memorandum's markdown text.

CLO WATERFALL FORMAT:
- The waterfall is structured as lettered paragraphs: (A) through (CC) or similar, typically 25-30 items.
- It appears in the Conditions of the Notes section (often titled "Priority of Payments" or "Application of Interest/Principal Proceeds").
- There are separate interest and principal waterfalls.
- Each step describes: who gets paid, the calculation basis, and any conditions.
- Clean-Up Call threshold may be 10% OR 15% of original balance — extract the exact value, do not assume.
- Governing law may be English law even for Irish-domiciled issuers.

Extract as structured prose:
- interestPriority: The full interest waterfall priority of payments
- principalPriority: The full principal waterfall priority of payments
- postAcceleration: The post-acceleration waterfall if described

${COMMON_RULES}`,
    user: `Extract the waterfall rules from the following markdown text.`,
  };
}

export function ppmFeesPrompt(): Prompt {
  return {
    system: `You are extracting fees and account definitions from a CLO private placement memorandum's markdown text.

CLO FEE STRUCTURE:
- CLO management fees are typically split into two components:
  "Senior Collateral Management Fee" — paid before note interest (higher in the waterfall, safer)
  "Subordinated Collateral Management Fee" — paid from residual after all note interest (lower in waterfall)
- Fee definitions follow the pattern: "Term" means [definition] in the Definitions section.
- Look for "per annum" and "calculated on each Payment Date" as fee-defining phrases.
- "Senior Expenses Cap" is a hard cap on total annual non-CM expenses (typically €350,000–€500,000).
- The Trustee fee is paid under "Agency and Account Bank Agreement".

Extract ALL fees: name, rate, rateUnit, basis, description, hurdleRate.

CRITICAL — Rate format rules:
- For management fees (senior/subordinated): extract as PERCENTAGE per annum, e.g. "0.15" for 0.15% p.a. Set rateUnit: "pct_pa".
- For trustee/admin fees: extract as BASIS POINTS per annum, e.g. "2" for 2 bps. Set rateUnit: "bps_pa".
- For incentive fees: extract as PERCENTAGE of residual, e.g. "20" for 20%. Set rateUnit: "pct_of_residual".
- For fixed amount fees: extract as the amount. Set rateUnit: "fixed_amount".
- If the fee rate is "per agreement" or not quantified: set rate: null, rateUnit: "per_agreement".
- Always strip units from rate — just the number. "0.15% per annum" → rate: "0.15", rateUnit: "pct_pa"

Additional CLO fees to look for:
- Incentive Management Fee / Performance Fee — CRITICAL: also extract hurdleRate (the IRR threshold above which the fee applies, as a percentage e.g. "12" for 12%). Look for phrases like "internal rate of return", "exceeds X per cent", "IRR hurdle". The hurdle rate is essential — if you find an incentive fee percentage but no hurdle rate, set hurdleRate to null (do NOT omit the field).
- Administrative Expenses / Administrative Expense Cap
- Arrangement Fee
- Placement Fee
- Rating Agency Fees
- Legal/Audit Expenses

Fees may be expressed as:
- Percentage per annum on collateral principal (e.g., "0.15% per annum" → rate: "0.15")
- Basis points per annum (e.g., "15 basis points" → for mgmt fees: rate: "0.15"; for trustee: rate: "15")
- Fixed amounts per payment period
- Percentage of interest/principal proceeds
- For incentive fees: "X% of residual above Y% IRR threshold" — extract X as rate, Y as hurdleRate

Extract account definitions: name, purpose.
Common accounts: Payment Account, Collection Account, Principal Account, Interest Account, Reserve Account, Expense Account, Custody Account, Hedge Counterparty Collateral Account.

${COMMON_RULES}`,
    user: `Extract all fees and account definitions from the following markdown text.`,
  };
}

export function ppmKeyDatesPrompt(): Prompt {
  return {
    system: `You are extracting key dates from a CLO private placement memorandum's markdown text.

CRITICAL: Extract ACTUAL DATE VALUES, not field labels.
- maturityDate should be "2035-07-15" not "Maturity Date".
- Look in the summary/term sheet sections for actual dates.
- If only month/year is given, use the 15th (e.g., "July 2035" -> "2035-07-15").
- These dates are often in a STRUCTURED TABLE in the Transaction Overview or Term Sheet section. Look for rows/columns labeled with date names.
- The reinvestment period and non-call period are KEY dates for CLO waterfall modeling — search thoroughly.
- NEVER return "<UNKNOWN>" or "UNKNOWN" — use null if a date is not found.

Extract: originalIssueDate, currentIssueDate, maturityDate, nonCallPeriodEnd, reinvestmentPeriodEnd, firstPaymentDate, paymentFrequency.

IMPORTANT — common aliases for these dates:
- originalIssueDate: "Closing Date", "Original Closing Date", "Issue Date", "Date of Issuance"
- currentIssueDate: "Refinancing Date", "Reset Date", "Reissue Date" (only if the deal was refinanced/reset)
- maturityDate: "Stated Maturity", "Legal Final Maturity", "Scheduled Maturity Date", or found in "the Notes mature on [date]", "due [year]"
- nonCallPeriodEnd: "Non-Call Period End Date", "Optional Redemption Date", "First Optional Redemption Date", "callable on or after [date]"
- reinvestmentPeriodEnd: "Reinvestment Period End Date", "End of Reinvestment Period", "Reinvestment Termination Date"
- firstPaymentDate: "First Payment Date", "First Distribution Date", "First Interest Payment Date"
- paymentFrequency: "quarterly", "semi-annually" — look for "Payment Dates: each [frequency]"

PPM DATE FORMAT:
- PPMs use "DD Month YYYY" format (e.g., "15 April 2038") — convert to YYYY-MM-DD.
- Dates are often in the Definitions section as defined terms with smart quotes:
  \u201cIssue Date\u201d means [date], \u201cMaturity Date\u201d means [date], etc.
- Key defined terms to look for: "Issue Date", "Effective Date", "Closing Date", "Maturity Date",
  "Non-Call Period", "Reinvestment Period", "Payment Date", "Determination Date", "Due Period", "Record Date".
- Payment dates for European CLOs are typically quarterly on the 15th (Jan/Apr/Jul/Oct).

If a date appears in the tranche/notes table (e.g., maturity column), that counts as an explicit mention.

${COMMON_RULES}`,
    user: `Extract all key dates from the following markdown text.`,
  };
}

export function ppmKeyPartiesPrompt(): Prompt {
  return {
    system: `You are extracting key parties from a CLO private placement memorandum's markdown text.

CLO PPM KEY PARTIES FORMAT:
- Key parties are typically on the transaction overview page in a dots-leader format:
  "Role..................................... Entity Name."
  The number of dots varies. Extract both the role and entity from each line.
- Common CLO roles: Issuer, Collateral Manager, Trustee, Account Bank, Paying Agent, Calculation Agent,
  Registrar, Transfer Agent, Collateral Administrator, Arranger, Placement Agent.
- BNY Mellon often appears in multiple roles: Trustee (Corporate Trustee Services Limited),
  Account Bank (London Branch), Paying Agent (London Branch).
- The Collateral Administrator may be a separate entity from the Trustee.

Extract key parties: role, entity (e.g., Trustee, Collateral Manager, Issuer, Arranger, Placement Agent, etc.)

Extract collateral manager details: name, parent, replacementMechanism.

cmDetails.name is the MOST IMPORTANT field. The Collateral Manager is the entity that manages the CLO's loan portfolio. Look for "The Collateral Manager is [name]", "[name] (as Collateral Manager)", or the dots-leader line.

${COMMON_RULES}`,
    user: `Extract all key parties from the following markdown text.`,
  };
}

export function ppmRedemptionPrompt(): Prompt {
  return {
    system: `You are extracting redemption provisions and events of default from a CLO private placement memorandum's markdown text.

Extract redemption provisions: type (optional, mandatory, special, tax, clean-up call), description.

Extract events of default (typically 8-12 events): event, description.

${COMMON_RULES}`,
    user: `Extract all redemption provisions and events of default from the following markdown text.`,
  };
}

export function ppmInterestMechanicsPrompt(): Prompt {
  return {
    system: `You are extracting interest mechanics from a CLO private placement memorandum's markdown text.

Extract:
- dayCount: day count convention (e.g. "ACT/360", "30/360")
- referenceRate: the floating rate benchmark (e.g. "3-month EURIBOR", "3-month Term SOFR")
- referenceRateFloorPct: the floor on the reference rate, as a number (e.g. 0 for "floored at zero"). Use null if no floor is mentioned.
- deferredInterestCompounds: whether deferred (PIK'd) interest on deferrable tranches compounds — i.e. whether unpaid interest is added to the principal balance and itself accrues interest. Look for language like "Deferred Interest shall bear interest" (true) or "Deferred Interest shall not bear interest" (false). This is CRITICAL for projection accuracy.
- deferralClasses: list of tranche class names that can defer interest (e.g. ["Class C", "Class D", "Class E", "Class F"])
- subNoteInterest: how subordinated note interest is determined (e.g. "residual", "fixed rate", etc.)

IMPORTANT:
- For deferredInterestCompounds, look in the definitions of "Deferred Interest" and in the interest waterfall steps for deferrable tranches. PPMs typically state whether deferred interest "shall accrue interest at the applicable rate" or similar.
- For referenceRateFloorPct, look for "floored at zero", "deemed to be zero", "shall not be less than zero", "subject to a zero floor" — all mean 0. Some deals have no floor at all (use null).

${COMMON_RULES}`,
    user: `Extract interest mechanics from the following markdown text.`,
  };
}

export function ppmHedgingPrompt(): Prompt {
  return {
    system: `You are extracting hedging requirements from a CLO private placement memorandum's markdown text.

Extract: currencyHedgeRequired, hedgeTypes, counterpartyRatingReq, replacementTimeline, maxCurrencyHedgePct.

${COMMON_RULES}`,
    user: `Extract hedging requirements from the following markdown text.`,
  };
}
