import { query } from "../db";
import type {
  CloProfile,
  CloDeal,
  CloReportPeriod,
  CloHolding,
  CloPoolSummary,
  CloComplianceTest,
  CloConcentration,
  CloWaterfallStep,
  CloAccountBalance,
  CloTrade,
  CloTradingSummary,
  CloEvent,
  CloExtractionOverflow,
  CloSupplementaryData,
  DataQuality,
  CloTranche,
  CloTrancheSnapshot,
} from "./types";

export function rowToProfile(row: Record<string, unknown>): CloProfile {
  return {
    id: row.id as string,
    userId: (row.user_id as string) || "",
    fundStrategy: (row.fund_strategy as string) || "",
    targetSectors: (row.target_sectors as string) || "",
    riskAppetite: (row.risk_appetite as CloProfile["riskAppetite"]) || "moderate",
    portfolioSize: (row.portfolio_size as string) || "",
    reinvestmentPeriod: (row.reinvestment_period as string) || "",
    concentrationLimits: (row.concentration_limits as string) || "",
    covenantPreferences: (row.covenant_preferences as string) || "",
    ratingThresholds: (row.rating_thresholds as string) || "",
    spreadTargets: (row.spread_targets as string) || "",
    regulatoryConstraints: (row.regulatory_constraints as string) || "",
    portfolioDescription: (row.portfolio_description as string) || "",
    beliefsAndBiases: (row.beliefs_and_biases as string) || "",
    rawQuestionnaire: (row.raw_questionnaire as Record<string, unknown>) || {},
    documents: (row.documents as CloProfile["documents"]) || [],
    extractedConstraints: (row.extracted_constraints as CloProfile["extractedConstraints"]) || {},
    extractedPortfolio: (row.extracted_portfolio as CloProfile["extractedPortfolio"]) || null,
    createdAt: (row.created_at as string) || "",
    updatedAt: (row.updated_at as string) || "",
  };
}

// Lightweight profile fetch — excludes the `documents` column (which can be 20MB+ of base64).
// Use `getProfileWithDocuments` when you need the raw document data.
export async function getProfileForUser(userId: string) {
  const rows = await query<{
    id: string;
    user_id: string;
    fund_strategy: string;
    target_sectors: string;
    risk_appetite: string;
    portfolio_size: string;
    reinvestment_period: string;
    concentration_limits: string;
    covenant_preferences: string;
    rating_thresholds: string;
    spread_targets: string;
    regulatory_constraints: string;
    portfolio_description: string;
    beliefs_and_biases: string;
    raw_questionnaire: Record<string, unknown>;
    extracted_constraints: Record<string, unknown>;
    extracted_portfolio: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, user_id, fund_strategy, target_sectors, risk_appetite, portfolio_size,
            reinvestment_period, concentration_limits, covenant_preferences, rating_thresholds,
            spread_targets, regulatory_constraints, portfolio_description, beliefs_and_biases,
            raw_questionnaire, extracted_constraints, extracted_portfolio, created_at, updated_at
     FROM clo_profiles WHERE user_id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

// Full profile fetch including raw documents — use only when sending docs to Claude.
export async function getProfileWithDocuments(userId: string) {
  const rows = await query<{
    id: string;
    user_id: string;
    fund_strategy: string;
    target_sectors: string;
    risk_appetite: string;
    portfolio_size: string;
    reinvestment_period: string;
    concentration_limits: string;
    covenant_preferences: string;
    rating_thresholds: string;
    spread_targets: string;
    regulatory_constraints: string;
    portfolio_description: string;
    beliefs_and_biases: string;
    raw_questionnaire: Record<string, unknown>;
    documents: Array<{ name: string; type: string; size: number; base64: string }>;
    extracted_constraints: Record<string, unknown>;
    extracted_portfolio: unknown;
    created_at: string;
    updated_at: string;
  }>(
    "SELECT * FROM clo_profiles WHERE user_id = $1",
    [userId]
  );
  return rows[0] ?? null;
}

// Fetch just document metadata (name, type, size) without the heavy base64 data.
export async function getProfileDocumentMeta(userId: string): Promise<Array<{ name: string; type: string; size: number }>> {
  const rows = await query<{ documents: Array<{ name: string; type: string; size: number }> }>(
    `SELECT jsonb_agg(jsonb_build_object('name', d->>'name', 'type', d->>'type', 'size', (d->>'size')::int))
       AS documents
     FROM clo_profiles, jsonb_array_elements(documents) AS d
     WHERE user_id = $1`,
    [userId]
  );
  return rows[0]?.documents || [];
}

export async function getPanelForUser(userId: string) {
  const rows = await query<{
    id: string;
    profile_id: string;
    status: string;
    members: unknown[];
    avatar_mappings: Record<string, string>;
    raw_files: Record<string, string>;
    error_message: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT p.* FROM clo_panels p
     JOIN clo_profiles pr ON p.profile_id = pr.id
     WHERE pr.user_id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function verifyAnalysisAccess(analysisId: string, userId: string) {
  const rows = await query<{ id: string }>(
    `SELECT a.id FROM clo_analyses a
     JOIN clo_panels p ON a.panel_id = p.id
     JOIN clo_profiles pr ON p.profile_id = pr.id
     WHERE a.id = $1 AND pr.user_id = $2`,
    [analysisId, userId]
  );
  return rows.length > 0;
}

export async function verifyScreeningAccess(screeningId: string, userId: string) {
  const rows = await query<{ id: string }>(
    `SELECT s.id FROM clo_screenings s
     JOIN clo_panels p ON s.panel_id = p.id
     JOIN clo_profiles pr ON p.profile_id = pr.id
     WHERE s.id = $1 AND pr.user_id = $2`,
    [screeningId, userId]
  );
  return rows.length > 0;
}

export async function verifyPanelAccess(panelId: string, userId: string) {
  const rows = await query<{ id: string }>(
    `SELECT p.id FROM clo_panels p
     JOIN clo_profiles pr ON p.profile_id = pr.id
     WHERE p.id = $1 AND pr.user_id = $2`,
    [panelId, userId]
  );
  return rows.length > 0;
}

// ─── Row Converters ─────────────────────────────────────────────────

function rowToDeal(row: Record<string, unknown>): CloDeal {
  return {
    id: row.id as string,
    profileId: row.profile_id as string,
    dealName: (row.deal_name as string) ?? null,
    dealShortName: (row.deal_short_name as string) ?? null,
    issuerLegalEntity: (row.issuer_legal_entity as string) ?? null,
    jurisdiction: (row.jurisdiction as string) ?? null,
    dealCurrency: (row.deal_currency as string) ?? null,
    closingDate: (row.closing_date as string) ?? null,
    effectiveDate: (row.effective_date as string) ?? null,
    reinvestmentPeriodEnd: (row.reinvestment_period_end as string) ?? null,
    nonCallPeriodEnd: (row.non_call_period_end as string) ?? null,
    statedMaturityDate: (row.stated_maturity_date as string) ?? null,
    walTestDate: (row.wal_test_date as string) ?? null,
    dealType: (row.deal_type as string) ?? null,
    dealVersion: (row.deal_version as string) ?? null,
    trusteeName: (row.trustee_name as string) ?? null,
    collateralManager: (row.collateral_manager as string) ?? null,
    collateralAdministrator: (row.collateral_administrator as string) ?? null,
    governingDocument: (row.governing_document as string) ?? null,
    governingLaw: (row.governing_law as string) ?? null,
    ppmConstraints: (row.ppm_constraints as Record<string, unknown>) ?? {},
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToReportPeriod(row: Record<string, unknown>): CloReportPeriod {
  return {
    id: row.id as string,
    dealId: row.deal_id as string,
    reportDate: row.report_date as string,
    paymentDate: (row.payment_date as string) ?? null,
    previousPaymentDate: (row.previous_payment_date as string) ?? null,
    reportType: (row.report_type as CloReportPeriod["reportType"]) ?? null,
    reportSource: (row.report_source as string) ?? null,
    reportingPeriodStart: (row.reporting_period_start as string) ?? null,
    reportingPeriodEnd: (row.reporting_period_end as string) ?? null,
    isFinal: (row.is_final as boolean) ?? false,
    extractionStatus: (row.extraction_status as CloReportPeriod["extractionStatus"]) ?? "pending",
    extractedAt: (row.extracted_at as string) ?? null,
    rawExtraction: (row.raw_extraction as Record<string, unknown>) ?? null,
    supplementaryData: (row.supplementary_data as CloSupplementaryData) ?? null,
    dataQuality: (row.data_quality as DataQuality) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToHolding(row: Record<string, unknown>): CloHolding {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    obligorName: (row.obligor_name as string) ?? null,
    facilityName: (row.facility_name as string) ?? null,
    isin: (row.isin as string) ?? null,
    lxid: (row.lxid as string) ?? null,
    assetType: (row.asset_type as string) ?? null,
    currency: (row.currency as string) ?? null,
    country: (row.country as string) ?? null,
    industryCode: (row.industry_code as string) ?? null,
    industryDescription: (row.industry_description as string) ?? null,
    moodysIndustry: (row.moodys_industry as string) ?? null,
    spIndustry: (row.sp_industry as string) ?? null,
    isCovLite: (row.is_cov_lite as boolean) ?? null,
    isRevolving: (row.is_revolving as boolean) ?? null,
    isDelayedDraw: (row.is_delayed_draw as boolean) ?? null,
    isDefaulted: (row.is_defaulted as boolean) ?? null,
    isPik: (row.is_pik as boolean) ?? null,
    isFixedRate: (row.is_fixed_rate as boolean) ?? null,
    isDiscountObligation: (row.is_discount_obligation as boolean) ?? null,
    isLongDated: (row.is_long_dated as boolean) ?? null,
    settlementStatus: (row.settlement_status as string) ?? null,
    acquisitionDate: (row.acquisition_date as string) ?? null,
    maturityDate: (row.maturity_date as string) ?? null,
    parBalance: (row.par_balance as number) ?? null,
    principalBalance: (row.principal_balance as number) ?? null,
    marketValue: (row.market_value as number) ?? null,
    purchasePrice: (row.purchase_price as number) ?? null,
    currentPrice: (row.current_price as number) ?? null,
    accruedInterest: (row.accrued_interest as number) ?? null,
    referenceRate: (row.reference_rate as string) ?? null,
    indexRate: (row.index_rate as number) ?? null,
    spreadBps: (row.spread_bps as number) ?? null,
    allInRate: (row.all_in_rate as number) ?? null,
    floorRate: (row.floor_rate as number) ?? null,
    moodysRating: (row.moodys_rating as string) ?? null,
    moodysRatingSource: (row.moodys_rating_source as string) ?? null,
    spRating: (row.sp_rating as string) ?? null,
    spRatingSource: (row.sp_rating_source as string) ?? null,
    fitchRating: (row.fitch_rating as string) ?? null,
    compositeRating: (row.composite_rating as string) ?? null,
    ratingFactor: (row.rating_factor as number) ?? null,
    recoveryRateMoodys: (row.recovery_rate_moodys as number) ?? null,
    recoveryRateSp: (row.recovery_rate_sp as number) ?? null,
    remainingLifeYears: (row.remaining_life_years as number) ?? null,
    warfContribution: (row.warf_contribution as number) ?? null,
    diversityScoreGroup: (row.diversity_score_group as string) ?? null,
  };
}

function rowToPoolSummary(row: Record<string, unknown>): CloPoolSummary {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    totalPar: (row.total_par as number) ?? null,
    totalPrincipalBalance: (row.total_principal_balance as number) ?? null,
    totalMarketValue: (row.total_market_value as number) ?? null,
    numberOfObligors: (row.number_of_obligors as number) ?? null,
    numberOfAssets: (row.number_of_assets as number) ?? null,
    numberOfIndustries: (row.number_of_industries as number) ?? null,
    numberOfCountries: (row.number_of_countries as number) ?? null,
    targetPar: (row.target_par as number) ?? null,
    parSurplusDeficit: (row.par_surplus_deficit as number) ?? null,
    wacSpread: (row.wac_spread as number) ?? null,
    wacTotal: (row.wac_total as number) ?? null,
    walYears: (row.wal_years as number) ?? null,
    warf: (row.warf as number) ?? null,
    diversityScore: (row.diversity_score as number) ?? null,
    waRecoveryRate: (row.wa_recovery_rate as number) ?? null,
    waMoodysRecovery: (row.wa_moodys_recovery as number) ?? null,
    waSpRecovery: (row.wa_sp_recovery as number) ?? null,
    pctFixedRate: (row.pct_fixed_rate as number) ?? null,
    pctFloatingRate: (row.pct_floating_rate as number) ?? null,
    pctCovLite: (row.pct_cov_lite as number) ?? null,
    pctSecondLien: (row.pct_second_lien as number) ?? null,
    pctSeniorSecured: (row.pct_senior_secured as number) ?? null,
    pctBonds: (row.pct_bonds as number) ?? null,
    pctCurrentPay: (row.pct_current_pay as number) ?? null,
    pctDefaulted: (row.pct_defaulted as number) ?? null,
    pctCccAndBelow: (row.pct_ccc_and_below as number) ?? null,
    pctSingleB: (row.pct_single_b as number) ?? null,
    pctDiscountObligations: (row.pct_discount_obligations as number) ?? null,
    pctLongDated: (row.pct_long_dated as number) ?? null,
    pctSemiAnnualPay: (row.pct_semi_annual_pay as number) ?? null,
    pctQuarterlyPay: (row.pct_quarterly_pay as number) ?? null,
    pctEurDenominated: (row.pct_eur_denominated as number) ?? null,
    pctGbpDenominated: (row.pct_gbp_denominated as number) ?? null,
    pctUsdDenominated: (row.pct_usd_denominated as number) ?? null,
    pctNonBaseCurrency: (row.pct_non_base_currency as number) ?? null,
  };
}

function rowToComplianceTest(row: Record<string, unknown>): CloComplianceTest {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    testName: row.test_name as string,
    testType: (row.test_type as CloComplianceTest["testType"]) ?? null,
    testClass: (row.test_class as string) ?? null,
    numerator: (row.numerator as number) ?? null,
    denominator: (row.denominator as number) ?? null,
    actualValue: (row.actual_value as number) ?? null,
    triggerLevel: (row.trigger_level as number) ?? null,
    thresholdLevel: (row.threshold_level as number) ?? null,
    cushionPct: (row.cushion_pct as number) ?? null,
    cushionAmount: (row.cushion_amount as number) ?? null,
    isPassing: (row.is_passing as boolean) ?? null,
    cureAmount: (row.cure_amount as number) ?? null,
    consequenceIfFail: (row.consequence_if_fail as string) ?? null,
    matrixRow: (row.matrix_row as string) ?? null,
    matrixColumn: (row.matrix_column as string) ?? null,
    testMethodology: (row.test_methodology as string) ?? null,
    adjustmentDescription: (row.adjustment_description as string) ?? null,
    isActive: (row.is_active as boolean) ?? true,
  };
}

function rowToConcentration(row: Record<string, unknown>): CloConcentration {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    concentrationType: row.concentration_type as CloConcentration["concentrationType"],
    bucketName: row.bucket_name as string,
    actualValue: (row.actual_value as number) ?? null,
    actualPct: (row.actual_pct as number) ?? null,
    limitValue: (row.limit_value as number) ?? null,
    limitPct: (row.limit_pct as number) ?? null,
    excessAmount: (row.excess_amount as number) ?? null,
    isPassing: (row.is_passing as boolean) ?? null,
    isHaircutApplied: (row.is_haircut_applied as boolean) ?? null,
    haircutAmount: (row.haircut_amount as number) ?? null,
    obligorCount: (row.obligor_count as number) ?? null,
    assetCount: (row.asset_count as number) ?? null,
    ratingFactorAvg: (row.rating_factor_avg as number) ?? null,
  };
}

function rowToWaterfallStep(row: Record<string, unknown>): CloWaterfallStep {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    waterfallType: (row.waterfall_type as CloWaterfallStep["waterfallType"]) ?? null,
    priorityOrder: (row.priority_order as number) ?? null,
    description: (row.description as string) ?? null,
    payee: (row.payee as string) ?? null,
    amountDue: (row.amount_due as number) ?? null,
    amountPaid: (row.amount_paid as number) ?? null,
    shortfall: (row.shortfall as number) ?? null,
    fundsAvailableBefore: (row.funds_available_before as number) ?? null,
    fundsAvailableAfter: (row.funds_available_after as number) ?? null,
    isOcTestDiversion: (row.is_oc_test_diversion as boolean) ?? null,
    isIcTestDiversion: (row.is_ic_test_diversion as boolean) ?? null,
  };
}

function rowToTranche(row: Record<string, unknown>): CloTranche {
  return {
    id: row.id as string,
    dealId: row.deal_id as string,
    className: row.class_name as string,
    isin: (row.isin as string) ?? null,
    cusip: (row.cusip as string) ?? null,
    commonCode: (row.common_code as string) ?? null,
    currency: (row.currency as string) ?? null,
    originalBalance: (row.original_balance as number) ?? null,
    seniorityRank: (row.seniority_rank as number) ?? null,
    isFloating: (row.is_floating as boolean) ?? null,
    referenceRate: (row.reference_rate as string) ?? null,
    referenceRateTenor: (row.reference_rate_tenor as string) ?? null,
    spreadBps: (row.spread_bps as number) ?? null,
    couponFloor: (row.coupon_floor as number) ?? null,
    couponCap: (row.coupon_cap as number) ?? null,
    dayCountConvention: (row.day_count_convention as string) ?? null,
    paymentFrequency: (row.payment_frequency as string) ?? null,
    isDeferrable: (row.is_deferrable as boolean) ?? null,
    isPik: (row.is_pik as boolean) ?? null,
    ratingMoodys: (row.rating_moodys as string) ?? null,
    ratingSp: (row.rating_sp as string) ?? null,
    ratingFitch: (row.rating_fitch as string) ?? null,
    ratingDbrs: (row.rating_dbrs as string) ?? null,
    isSubordinate: (row.is_subordinate as boolean) ?? null,
    isIncomeNote: (row.is_income_note as boolean) ?? null,
  };
}

function rowToTrancheSnapshot(row: Record<string, unknown>): CloTrancheSnapshot {
  return {
    id: row.id as string,
    trancheId: row.tranche_id as string,
    reportPeriodId: row.report_period_id as string,
    currentBalance: (row.current_balance as number) ?? null,
    factor: (row.factor as number) ?? null,
    currentIndexRate: (row.current_index_rate as number) ?? null,
    couponRate: (row.coupon_rate as number) ?? null,
    deferredInterestBalance: (row.deferred_interest_balance as number) ?? null,
    enhancementPct: (row.enhancement_pct as number) ?? null,
    beginningBalance: (row.beginning_balance as number) ?? null,
    endingBalance: (row.ending_balance as number) ?? null,
    interestAccrued: (row.interest_accrued as number) ?? null,
    interestPaid: (row.interest_paid as number) ?? null,
    interestShortfall: (row.interest_shortfall as number) ?? null,
    cumulativeShortfall: (row.cumulative_shortfall as number) ?? null,
    principalPaid: (row.principal_paid as number) ?? null,
    daysAccrued: (row.days_accrued as number) ?? null,
  };
}

function rowToAccountBalance(row: Record<string, unknown>): CloAccountBalance {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    accountName: row.account_name as string,
    accountType: (row.account_type as CloAccountBalance["accountType"]) ?? null,
    currency: (row.currency as string) ?? null,
    balanceAmount: (row.balance_amount as number) ?? null,
    requiredBalance: (row.required_balance as number) ?? null,
    excessDeficit: (row.excess_deficit as number) ?? null,
  };
}

function rowToTrade(row: Record<string, unknown>): CloTrade {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    tradeType: (row.trade_type as CloTrade["tradeType"]) ?? null,
    obligorName: (row.obligor_name as string) ?? null,
    facilityName: (row.facility_name as string) ?? null,
    tradeDate: (row.trade_date as string) ?? null,
    settlementDate: (row.settlement_date as string) ?? null,
    parAmount: (row.par_amount as number) ?? null,
    settlementPrice: (row.settlement_price as number) ?? null,
    settlementAmount: (row.settlement_amount as number) ?? null,
    realizedGainLoss: (row.realized_gain_loss as number) ?? null,
    accruedInterestTraded: (row.accrued_interest_traded as number) ?? null,
    currency: (row.currency as string) ?? null,
    counterparty: (row.counterparty as string) ?? null,
    isCreditRiskSale: (row.is_credit_risk_sale as boolean) ?? null,
    isCreditImproved: (row.is_credit_improved as boolean) ?? null,
    isDiscretionary: (row.is_discretionary as boolean) ?? null,
  };
}

function rowToTradingSummary(row: Record<string, unknown>): CloTradingSummary {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    totalPurchasesPar: (row.total_purchases_par as number) ?? null,
    totalPurchasesCost: (row.total_purchases_cost as number) ?? null,
    totalSalesPar: (row.total_sales_par as number) ?? null,
    totalSalesProceeds: (row.total_sales_proceeds as number) ?? null,
    netGainLoss: (row.net_gain_loss as number) ?? null,
    totalPaydowns: (row.total_paydowns as number) ?? null,
    totalPrepayments: (row.total_prepayments as number) ?? null,
    totalDefaultsPar: (row.total_defaults_par as number) ?? null,
    totalRecoveries: (row.total_recoveries as number) ?? null,
    turnoverRate: (row.turnover_rate as number) ?? null,
    creditRiskSalesPar: (row.credit_risk_sales_par as number) ?? null,
    discretionarySalesPar: (row.discretionary_sales_par as number) ?? null,
    remainingDiscretionaryAllowance: (row.remaining_discretionary_allowance as number) ?? null,
  };
}

function rowToEvent(row: Record<string, unknown>): CloEvent {
  return {
    id: row.id as string,
    dealId: row.deal_id as string,
    reportPeriodId: (row.report_period_id as string) ?? null,
    eventType: (row.event_type as CloEvent["eventType"]) ?? null,
    eventDate: (row.event_date as string) ?? null,
    description: (row.description as string) ?? null,
    isEventOfDefault: (row.is_event_of_default as boolean) ?? null,
    isCured: (row.is_cured as boolean) ?? null,
    cureDate: (row.cure_date as string) ?? null,
    impactDescription: (row.impact_description as string) ?? null,
  };
}

function rowToOverflow(row: Record<string, unknown>): CloExtractionOverflow {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    extractionPass: (row.extraction_pass as number) ?? null,
    sourceSection: (row.source_section as string) ?? null,
    label: (row.label as string) ?? null,
    content: row.content,
    createdAt: row.created_at as string,
  };
}

// ─── Deal Management ────────────────────────────────────────────────

export async function getOrCreateDeal(profileId: string): Promise<{ id: string }> {
  const existing = await query<{ id: string }>(
    "SELECT id FROM clo_deals WHERE profile_id = $1",
    [profileId]
  );
  if (existing[0]) return { id: existing[0].id };

  const profile = await query<{
    extracted_constraints: Record<string, unknown>;
  }>(
    "SELECT extracted_constraints FROM clo_profiles WHERE id = $1",
    [profileId]
  );
  const ec = profile[0]?.extracted_constraints ?? {};
  const di = (ec.dealIdentity ?? {}) as Record<string, unknown>;
  const kd = (ec.keyDates ?? {}) as Record<string, unknown>;
  const cm = (ec.cmDetails ?? {}) as Record<string, unknown>;

  const rows = await query<{ id: string }>(
    `INSERT INTO clo_deals (
      profile_id, deal_name, issuer_legal_entity, jurisdiction, deal_currency,
      closing_date, effective_date, reinvestment_period_end, non_call_period_end,
      stated_maturity_date, collateral_manager, governing_law, ppm_constraints
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id`,
    [
      profileId,
      (di.dealName as string) ?? null,
      (di.issuerLegalName as string) ?? null,
      (di.jurisdiction as string) ?? null,
      (di.currency as string) ?? null,
      (kd.originalIssueDate as string) ?? null,
      (kd.currentIssueDate as string) ?? null,
      (kd.reinvestmentPeriodEnd as string) ?? null,
      (kd.nonCallPeriodEnd as string) ?? null,
      (kd.maturityDate as string) ?? null,
      (cm.name as string) ?? (ec.collateralManager as string) ?? null,
      (di.governingLaw as string) ?? null,
      JSON.stringify(ec),
    ]
  );
  return { id: rows[0].id };
}

export async function getDealForProfile(profileId: string): Promise<CloDeal | null> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_deals WHERE profile_id = $1",
    [profileId]
  );
  return rows[0] ? rowToDeal(rows[0]) : null;
}

// ─── Report Periods ─────────────────────────────────────────────────

export async function getReportPeriods(dealId: string): Promise<CloReportPeriod[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_report_periods WHERE deal_id = $1 ORDER BY report_date DESC",
    [dealId]
  );
  return rows.map(rowToReportPeriod);
}

export async function getLatestReportPeriod(dealId: string): Promise<CloReportPeriod | null> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_report_periods WHERE deal_id = $1 ORDER BY report_date DESC LIMIT 1",
    [dealId]
  );
  return rows[0] ? rowToReportPeriod(rows[0]) : null;
}

// ─── Per-Period Data ────────────────────────────────────────────────

export async function getReportPeriodData(reportPeriodId: string): Promise<{
  poolSummary: CloPoolSummary | null;
  complianceTests: CloComplianceTest[];
  concentrations: CloConcentration[];
}> {
  const [poolRows, testRows, concRows] = await Promise.all([
    query<Record<string, unknown>>(
      "SELECT * FROM clo_pool_summary WHERE report_period_id = $1",
      [reportPeriodId]
    ),
    query<Record<string, unknown>>(
      "SELECT * FROM clo_compliance_tests WHERE report_period_id = $1",
      [reportPeriodId]
    ),
    query<Record<string, unknown>>(
      "SELECT * FROM clo_concentrations WHERE report_period_id = $1",
      [reportPeriodId]
    ),
  ]);
  return {
    poolSummary: poolRows[0] ? rowToPoolSummary(poolRows[0]) : null,
    complianceTests: testRows.map(rowToComplianceTest),
    concentrations: concRows.map(rowToConcentration),
  };
}

export async function getHoldings(reportPeriodId: string): Promise<CloHolding[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_holdings WHERE report_period_id = $1 ORDER BY par_balance DESC NULLS LAST",
    [reportPeriodId]
  );
  return rows.map(rowToHolding);
}

export async function getPoolSummary(reportPeriodId: string): Promise<CloPoolSummary | null> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_pool_summary WHERE report_period_id = $1",
    [reportPeriodId]
  );
  return rows[0] ? rowToPoolSummary(rows[0]) : null;
}

export async function getComplianceTests(reportPeriodId: string): Promise<CloComplianceTest[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_compliance_tests WHERE report_period_id = $1",
    [reportPeriodId]
  );
  return rows.map(rowToComplianceTest);
}

export async function getTrades(reportPeriodId: string): Promise<CloTrade[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_trades WHERE report_period_id = $1",
    [reportPeriodId]
  );
  return rows.map(rowToTrade);
}

export async function getWaterfallSteps(reportPeriodId: string): Promise<CloWaterfallStep[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_waterfall_steps WHERE report_period_id = $1 ORDER BY waterfall_type, priority_order",
    [reportPeriodId]
  );
  return rows.map(rowToWaterfallStep);
}

export async function getAccountBalances(reportPeriodId: string): Promise<CloAccountBalance[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_account_balances WHERE report_period_id = $1",
    [reportPeriodId]
  );
  return rows.map(rowToAccountBalance);
}

export async function getEvents(dealId: string): Promise<CloEvent[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_events WHERE deal_id = $1 ORDER BY event_date DESC NULLS LAST",
    [dealId]
  );
  return rows.map(rowToEvent);
}

export async function getSupplementaryData(reportPeriodId: string): Promise<CloSupplementaryData | null> {
  const rows = await query<{ supplementary_data: CloSupplementaryData | null }>(
    "SELECT supplementary_data FROM clo_report_periods WHERE id = $1",
    [reportPeriodId]
  );
  return rows[0]?.supplementary_data ?? null;
}

export async function getOverflow(reportPeriodId: string): Promise<CloExtractionOverflow[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_extraction_overflow WHERE report_period_id = $1",
    [reportPeriodId]
  );
  return rows.map(rowToOverflow);
}

export async function getTradingSummary(reportPeriodId: string): Promise<CloTradingSummary | null> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_trading_summary WHERE report_period_id = $1",
    [reportPeriodId]
  );
  return rows[0] ? rowToTradingSummary(rows[0]) : null;
}

export async function getTranches(dealId: string): Promise<CloTranche[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_tranches WHERE deal_id = $1 ORDER BY seniority_rank NULLS LAST",
    [dealId]
  );
  return rows.map(rowToTranche);
}

export async function getTrancheSnapshots(reportPeriodId: string): Promise<CloTrancheSnapshot[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_tranche_snapshots WHERE report_period_id = $1",
    [reportPeriodId]
  );
  return rows.map(rowToTrancheSnapshot);
}
