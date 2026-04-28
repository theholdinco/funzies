// web/lib/clo/extraction/json-ingest/compliance-mapper.ts

import type {
  ComplianceJson,
  ComplianceJsonTranche,
  ComplianceJsonHolding,
  ComplianceJsonAccrualPosition,
} from "./types";
import {
  decimalToPct,
  parseFlexibleDate,
  extractLxid,
  extractIsin,
} from "./utils";

export type ComplianceSections = Record<string, Record<string, unknown>>;

function mapComplianceSummary(c: ComplianceJson): Record<string, unknown> {
  const qualityByName = new Map(c.collateral_quality_tests.map((t) => [t.test.toLowerCase(), t.actual]));

  return {
    reportDate: c.meta.determination_date,
    paymentDate: c.key_dates.current_payment_date ?? null,
    reportType: "quarterly",
    dealName: c.meta.issuer ?? null,
    trusteeName: c.meta.trustee ?? null,
    collateralManager: c.meta.collateral_manager ?? null,
    closingDate: c.key_dates.closing_date ?? null,
    statedMaturity: c.key_dates.stated_maturity ?? null,
    nextPaymentDate: c.key_dates.next_payment_date ?? null,
    collectionPeriodEnd: c.key_dates.collection_period_end ?? null,
    reinvestmentPeriodEnd: c.key_dates.reinvestment_period_end ?? null,
    nonCallPeriodEnd: null,
    tranches: c.capital_structure.map((t: ComplianceJsonTranche) => ({
      className: t.tranche,
      principalAmount: t.original,
      spread: t.spread != null ? decimalToPct(t.spread) : null,
      allInRate: t.rate != null ? decimalToPct(t.rate) : null,
      currentBalance: t.current,
      rating: t.fitch ?? null,
      couponRate: t.rate != null ? decimalToPct(t.rate) : null,
    })),
    aggregatePrincipalBalance: c.pool_summary.aggregate_principal_balance ?? null,
    adjustedCollateralPrincipalAmount: c.pool_summary.adjusted_collateral_principal_amount ?? null,
    totalPar: c.pool_summary.adjusted_collateral_principal_amount ?? c.pool_summary.aggregate_principal_balance ?? null,
    // totalPrincipalBalance is the interest-generating principal base (pre-haircut).
    // totalPar is the OC-numerator value (post-haircut). The resolver uses totalPrincipalBalance
    // for cashflow/interest projection and totalPar for trigger tests — they're distinct columns.
    totalPrincipalBalance: c.pool_summary.aggregate_principal_balance ?? null,
    wacSpread: (() => {
      const was = qualityByName.get("minimum wa floating spread") ?? qualityByName.get("minimum weighted average floating spread");
      return was != null ? decimalToPct(was) : null;   // 0.0368 → 3.68%
    })(),
    diversityScore: qualityByName.get("moody's minimum diversity") ?? null,
    warf: qualityByName.get("moody's maximum warf") ?? null,
    walYears: qualityByName.get("weighted average life") ?? null,
    waRecoveryRate: qualityByName.get("moody's minimum wa recovery") != null
      ? decimalToPct(qualityByName.get("moody's minimum wa recovery")!)
      : null,
    numberOfAssets: c.schedule_of_investments?.length ?? null,
  };
}

// "Admiral Bidco GmbH - Facility B2" → ["Admiral Bidco GmbH", "Facility B2"]
//
// Source-data contamination patterns we strip before splitting:
//   "Loan Subtotal:   440,805,583.95   ...  Allwyn Fin - ..."  → subtotal prefix bleed
//   "FACILITY B4 (EUR) Dedalus Finance GmbH - ..."             → facility-code prefix bleed
//   "LLC) - 2025 Euro Term Loans Gold Rush Bidco Ltd - ..."    → trailing-fragment + category bleed
//   "Rate                  Adj Allwyn Fin - ..."               → column-header bleed
//
// Exported for use by mapAssetSchedule, mapTradingActivity, mapInterestAccrualDetail.
export function splitDescription(desc: string): [string, string] {
  let s = desc;
  // Strip "Loan Subtotal: <numbers>   " style subtotal prefix that bled into a real obligor row
  s = s.replace(/^\s*(Loan\s+Subtotal|Total|Subtotal):\s*[\d,.\s-]+/i, "");
  // Strip trailing fragment of previous entity: "LLC) - ", "Inc) - ", "Ltd) - "
  s = s.replace(/^[A-Za-z]{0,5}\)\s*-\s*/, "");
  // Strip "Rate   Adj " prefix bleed from interest-accrual column headers
  s = s.replace(/^Rate\s+Adj\s+/i, "");
  // Strip leading facility-code prefix: "FACILITY B4 (EUR) "
  s = s.replace(/^FACILITY\s+[A-Z0-9]+\s*\([^)]*\)\s+/i, "");
  // Strip loan-category prefix: "2025 Euro Term Loans ", "EUR Term Loans "
  s = s.replace(/^(\d{4}\s+)?(Euro|EUR|USD)\s+Term\s+Loans?\s+/i, "");
  s = s.trim();
  const idx = s.indexOf(" - ");
  if (idx === -1) return [s, ""];
  return [s.slice(0, idx).trim(), s.slice(idx + 3).trim()];
}

function mapAssetSchedule(c: ComplianceJson): Record<string, unknown> {
  return {
    holdings: c.schedule_of_investments.map((h: ComplianceJsonHolding) => {
      const lxid = extractLxid(h.security_id);
      const isin = extractIsin(h.security_id);
      const [obligorName, facilityName] = splitDescription(h.description);
      // Derive isDelayedDraw from loan_type — projection.ts treats DDTLs
      // specially (don't count toward par until drawn). Without this derivation
      // the field stays null and the engine treats every loan as funded.
      const lt = String(h.loan_type ?? "").toLowerCase();
      const isDelayedDraw = lt.includes("delayed draw") ? true : null;
      return {
        obligorName,
        facilityName,
        isin,
        lxid,
        assetType: h.loan_type ?? null,
        maturityDate: parseFlexibleDate(h.maturity_date),
        parBalance: h.par_quantity ?? null,
        principalBalance: h.principal_balance ?? null,
        marketValue: h.principal_balance != null && h.market_price != null
          ? h.principal_balance * (h.market_price / 100)
          : null,
        currentPrice: h.market_price ?? null,
        isDelayedDraw,
      };
    }),
  };
}

function mapInterestAccrualDetail(c: ComplianceJson): Record<string, unknown> {
  const positions = c.interest_accrual_detail?.positions ?? [];
  return {
    rows: positions.map((p: ComplianceJsonAccrualPosition) => {
      const lxid = extractLxid(p.security_id);
      const isin = extractIsin(p.security_id);
      return {
        description: p.description,
        securityId: p.security_id ?? null,
        lxid,
        isin,
        rateType: p.rate_type ?? null,
        paymentPeriod: p.payment_period ?? null,
        principalBalance: p.principal_balance ?? null,
        baseIndex: p.base_index ?? null,
        indexRatePct: p.index_rate_pct ?? null,
        indexFloorPct: p.index_floor_pct ?? null,
        spreadPct: p.spread_pct ?? null,
        creditSpreadAdjPct: p.credit_spread_adj_pct ?? null,
        effectiveSpreadPct: p.effective_spread_pct ?? null,
        allInRatePct: p.all_in_rate_pct ?? null,
        spreadBps: p.spread_bps ?? null,
      };
    }),
  };
}

function mapParValueTests(c: ComplianceJson): Record<string, unknown> {
  return {
    tests: c.par_value_tests.map((t) => {
      const className = t.test;
      const isEod = /event of default/i.test(t.test) || t.subtype === "EventOfDefault";
      const testType = /reinvestment/i.test(t.test) ? "INTEREST_DIVERSION" : "OC_PAR";
      // Append "Par Value Test" to names that don't already contain an OC keyword,
      // so normalizer.ts:deduplicateComplianceTests doesn't drop them by its name filter.
      const hasKeyword = /par value|par ratio|\boc\b|overcollateral|reinvestment/i.test(t.test);
      const testName = hasKeyword ? t.test : `${t.test} Par Value Test`;
      return {
        testName,
        testType,
        testClass: isEod ? "EOD" : className.replace(/^Class\s*/i, "").trim(),
        numerator: t.numerator,
        denominator: t.denominator,
        actualValue: t.actual * 100,            // 1.3698 → 136.98
        triggerLevel: t.trigger * 100,
        cushionPct: t.cushion != null ? t.cushion * 100 : null,
        isPassing: t.result === "Passed" ? true : t.result === "Failed" ? false : null,
      };
    }),
    parValueAdjustments: [],  // synthesised later if adjusted_cpa_reconciliation has non-zero fields
  };
}

function mapInterestCoverageTests(c: ComplianceJson): Record<string, unknown> {
  return {
    tests: c.interest_coverage_tests.tests.map((t) => ({
      testName: t.test,
      testType: "IC",
      testClass: t.test.replace(/\s*IC$/, "").replace(/^Class\s*/i, "").trim(),
      numerator: t.numerator,
      denominator: t.denominator,
      actualValue: t.actual * 100,
      triggerLevel: t.trigger * 100,
      cushionPct: t.cushion != null ? t.cushion * 100 : null,
      isPassing: t.result === "Passed" ? true : t.result === "Failed" ? false : null,
    })),
  };
}

function mapCollateralQualityTests(c: ComplianceJson): Record<string, unknown> {
  return {
    tests: c.collateral_quality_tests.map((t) => {
      const agency = /moody/i.test(t.test) ? "Moody's" : /fitch/i.test(t.test) ? "Fitch" : null;
      const triggerType: "MIN" | "MAX" = /min/i.test(t.test) ? "MIN" : /max/i.test(t.test) ? "MAX" : (t.actual < t.trigger ? "MIN" : "MAX");
      return {
        testName: t.test,
        agency,
        actualValue: t.actual,
        triggerLevel: t.trigger,
        triggerType,
        isPassing: t.result === "Passed" ? true : t.result === "Failed" ? false : null,
        cushion: triggerType === "MIN" ? t.actual - t.trigger : t.trigger - t.actual,
      };
    }),
  };
}

function mapConcentrationTables(c: ComplianceJson): Record<string, unknown> {
  return {
    concentrations: c.portfolio_profile_tests.map((p) => ({
      concentrationType: p.code,
      bucketName: p.test,
      actualValue: p.actual ?? null,
      actualPct: p.actual_pct ?? null,
      limitValue: p.limit ?? null,
      limitPct: p.limit_pct ?? null,
      excessAmount: null,
      isPassing: p.result === "Passed" ? true : p.result === "Failed" ? false : null,
      isHaircutApplied: null,
      haircutAmount: null,
      obligorCount: null,
      assetCount: null,
    })),
  };
}

function mapWaterfall(c: ComplianceJson): Record<string, unknown> {
  const exec = c.current_period_execution;
  if (!exec) return { waterfallSteps: [], proceeds: [], trancheSnapshots: [] };

  const interestSteps = (exec.interest_waterfall_execution ?? []).map((step: any, idx: number) => ({
    waterfallType: "INTEREST",
    priorityOrder: idx + 1,
    description: step.clause ?? step.description ?? null,
    payee: step.payee ?? step.recipient ?? null,
    amountDue: step.amount_due ?? null,
    amountPaid: step.amount_paid ?? step.amount ?? null,
    shortfall: step.shortfall ?? null,
    fundsAvailableBefore: step.funds_available_before ?? null,
    fundsAvailableAfter: step.funds_available_after ?? null,
    isOcTestDiversion: Boolean(step.is_oc_cure ?? /coverage test/i.test(String(step.description ?? step.clause ?? ""))),
    isIcTestDiversion: false,
  }));

  // Compliance principal_waterfall is an aggregate summary, not a per-clause
  // array — emit a single synthetic PRINCIPAL row so the harness can surface
  // the state ("opened with X, paid Y, residual demand Z") rather than
  // showing zero principal activity. opening/paid/outstanding fields are
  // standard across IPDs; map them onto the same shape as INTEREST steps.
  const pwf = (exec as { principal_waterfall?: Record<string, unknown> }).principal_waterfall;
  const principalSteps: Array<Record<string, unknown>> = [];
  if (pwf && typeof pwf === "object") {
    const opening = (pwf.opening_balance as number | null | undefined) ?? null;
    const paid = (pwf.all_clauses_paid as number | null | undefined) ?? null;
    const outstanding = (pwf.outstanding_demand_on_clause_V_to_sub_notes as number | null | undefined) ?? null;
    principalSteps.push({
      waterfallType: "PRINCIPAL",
      priorityOrder: 1,
      description: (pwf.note as string | null | undefined) ?? "Principal waterfall (aggregate)",
      payee: null,
      amountDue: null,
      amountPaid: paid,
      shortfall: outstanding,
      fundsAvailableBefore: opening,
      fundsAvailableAfter: opening != null && paid != null ? opening - paid : null,
      isOcTestDiversion: false,
      isIcTestDiversion: false,
    });
  }
  const waterfallSteps = [...interestSteps, ...principalSteps];

  const trancheSnapshots = (exec.tranche_distributions ?? []).map((t) => ({
    className: t.class,
    currentBalance: t.ending,
    couponRate: t.all_in_rate != null ? t.all_in_rate * 100 : null,
    interestAccrued: t.interest_due ?? null,
    interestPaid: t.interest_paid ?? null,
    principalPaid: t.principal_paid ?? null,
    beginningBalance: t.beginning,
    endingBalance: t.ending,
  }));

  const proceeds = [
    exec.account_flow_on_payment_date?.interest_account && {
      proceedsType: "INTEREST",
      sourceDescription: "Interest Funding Account",
      amount: (exec.account_flow_on_payment_date as any).interest_account.beginning ?? null,
      periodStart: c.key_dates.collection_period_start ?? null,
      periodEnd: c.key_dates.collection_period_end ?? null,
    },
    exec.account_flow_on_payment_date?.principal_account && {
      proceedsType: "PRINCIPAL",
      sourceDescription: "Principal Funding Account",
      amount: (exec.account_flow_on_payment_date as any).principal_account.beginning ?? null,
      periodStart: c.key_dates.collection_period_start ?? null,
      periodEnd: c.key_dates.collection_period_end ?? null,
    },
  ].filter(Boolean);

  return { waterfallSteps, proceeds, trancheSnapshots };
}

function mapTradingActivity(c: ComplianceJson): Record<string, unknown> {
  const makeTrade = (t: any, tradeType: string) => {
    const [obligorName, facilityName] = splitDescription(t.description);
    return {
      tradeType,
      obligorName,
      facilityName,
      tradeDate: parseFlexibleDate(t.trade_date),
      settlementDate: parseFlexibleDate(t.settle_date),
      parAmount: t.par ?? null,
      settlementPrice: t.price ?? null,
      settlementAmount: t.total ?? null,
      currency: t.ccy ?? null,
    };
  };
  const purchases = (c.purchases ?? []).map((t) => makeTrade(t, "PURCHASE"));
  const sales = (c.sales ?? []).map((t) => makeTrade(t, "SALE"));
  const trades = [...purchases, ...sales];
  const summary = {
    totalPurchasesPar: purchases.reduce((s, t) => s + (t.parAmount ?? 0), 0),
    totalSalesPar: sales.reduce((s, t) => s + Math.abs(t.parAmount ?? 0), 0),
    totalSalesProceeds: sales.reduce((s, t) => s + (t.settlementAmount ?? 0), 0),
    netGainLoss: null,
    totalPaydowns: (c.paydowns ?? []).reduce((s, p) => s + (p.amount ?? 0), 0),
  };
  return { trades, tradingSummary: summary };
}

// Map BNY-style "group" strings to the AccountType enum used by the resolver.
// The resolver's principalAccountCash filter does strict === "PRINCIPAL", so the
// raw "Principal Funding" group (or a misspelled name like "Principle EUR") has
// to be normalized here. Unknown groups → "OTHER".
function normalizeAccountType(group: string | null | undefined, name: string): string {
  const g = (group ?? "").toLowerCase();
  const n = name.toLowerCase();
  if (g.includes("principal") || n.includes("principal") || n.includes("principle")) return "PRINCIPAL";
  if (g.includes("interest") || n.includes("interest")) return "INTEREST";
  if (g.includes("collection") || n.includes("collection")) return "COLLECTION";
  if (g.includes("payment") || n.includes("payment")) return "PAYMENT";
  if (g.includes("reserve") || n.includes("reserve")) return "RESERVE";
  if (g.includes("expense") || n.includes("expense")) return "EXPENSE";
  if (g.includes("hedge") || n.includes("hedge")) return "HEDGE";
  if (g.includes("custody") || n.includes("custody")) return "CUSTODY";
  if (g.includes("currency") || n.includes("currency")) return "CURRENCY";
  return "OTHER";
}

function mapAccountBalances(c: ComplianceJson): Record<string, unknown> {
  return {
    // Trustee account snapshots are as-of the determination_date — distinct
    // from the payment_date used by waterfall executions. Stamp the date so
    // downstream consumers don't conflate the two.
    asOfDate: c.meta?.determination_date ?? null,
    accounts: c.account_balances.accounts.map((a) => ({
      accountName: a.name,
      accountType: normalizeAccountType(a.group, a.name),
      currency: a.ccy ?? null,
      // BNY reports deal_received_eur as the ending balance in EUR (confirmed
      // against account_balances.principal_funding_account_received_basis_eur
      // subtotal). deal_trade_eur is the trade-basis balance; native_received
      // is ending balance in native currency. Prefer received_eur to match the
      // reconciliation footing used by the Adjusted CPA.
      balanceAmount: a.deal_received_eur ?? a.deal_trade_eur ?? a.native_received ?? null,
      requiredBalance: null,
      excessDeficit: null,
    })),
  };
}

function mapDefaultDetail(c: ComplianceJson): Record<string, unknown> {
  const positions = [
    ...(c.moody_caa_obligations?.positions ?? []),
    ...(c.fitch_ccc_obligations?.positions ?? []),
  ] as Array<Record<string, unknown>>;
  // These are CCC obligations, not defaults — schema allows non-defaulted rows too.
  return {
    defaults: positions.map((p) => ({
      obligorName: String(p.description ?? p.obligor_name ?? p.issuer ?? ""),
      securityId: (p.security_id as string) ?? null,
      parAmount: (p.principal_balance as number) ?? (p.par as number) ?? null,
      marketPrice: (p.market_price as number) ?? null,
      isDefaulted: false,
      isDeferring: false,
    })),
  };
}

function mapSupplementary(c: ComplianceJson): Record<string, unknown> {
  const fees: Array<Record<string, unknown>> = [];
  const mgmt = c.current_period_execution?.management_fees_paid as Record<string, unknown> | undefined;
  if (mgmt && typeof mgmt === "object") {
    for (const [name, amount] of Object.entries(mgmt)) {
      if (typeof amount === "number") fees.push({ feeType: name, paid: amount });
    }
  }
  const admin = c.current_period_execution?.administrative_expenses ?? [];
  for (const a of admin) {
    fees.push({
      feeType: (a as any).name,
      payee: null,
      accrued: (a as any).amount_due ?? null,
      paid: (a as any).paid_on_ipd ?? null,
      unpaid: (a as any).outstanding ?? null,
    });
  }

  return {
    fees,
    hedgePositions: [],
    fxRates: c.key_dates.fx ? Object.entries(c.key_dates.fx).map(([pair, rate]) => {
      const [base, , quote] = pair.split("_");
      return { baseCurrency: base, quoteCurrency: quote, spotRate: rate as number };
    }) : [],
    ratingActions: [],
    events: [],
    spCdoMonitor: [],
  };
}

function mapNotesInformation(c: ComplianceJson): Record<string, unknown> | null {
  const hist = c.notes_payment_history?.per_tranche;
  if (!hist) return null;
  const perTranche: Record<string, Array<Record<string, unknown>>> = {};
  for (const [className, data] of Object.entries(hist)) {
    const rows = (data as any).rows ?? [];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    perTranche[className] = rows.map((r: any) => ({
      period:                 r.period ?? null,
      paymentDate:            parseFlexibleDate(r.payment_date),
      parCommitment:          r.par_commitment ?? null,
      factor:                 r.factor ?? null,
      interestPaid:           r.interest_paid ?? null,
      principalPaid:          r.principal_paid ?? null,
      cashflow:               r.cashflow ?? null,
      endingBalance:          r.ending_balance ?? null,
      interestShortfall:      r.interest_shortfall ?? null,
      accumInterestShortfall: r.accum_interest_shortfall ?? null,
    }));
  }
  if (Object.keys(perTranche).length === 0) return null;
  return { perTranche };
}

export function mapCompliance(c: ComplianceJson): ComplianceSections {
  const sections: ComplianceSections = {
    compliance_summary: mapComplianceSummary(c),
    asset_schedule: mapAssetSchedule(c),
    interest_accrual_detail: mapInterestAccrualDetail(c),
    par_value_tests: mapParValueTests(c),
    interest_coverage_tests: mapInterestCoverageTests(c),
    collateral_quality_tests: mapCollateralQualityTests(c),
    concentration_tables: mapConcentrationTables(c),
    waterfall: mapWaterfall(c),
    trading_activity: mapTradingActivity(c),
    account_balances: mapAccountBalances(c),
    default_detail: mapDefaultDetail(c),
    supplementary: mapSupplementary(c),
  };
  const ni = mapNotesInformation(c);
  if (ni) sections.notes_information = ni;
  return sections;
}
