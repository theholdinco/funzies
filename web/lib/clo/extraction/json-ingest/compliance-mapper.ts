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
// Exported for use by mapAssetSchedule, mapTradingActivity, mapInterestAccrual (Tasks 7/8).
export function splitDescription(desc: string): [string, string] {
  const idx = desc.indexOf(" - ");
  if (idx === -1) return [desc.trim(), ""];
  return [desc.slice(0, idx).trim(), desc.slice(idx + 3).trim()];
}

function mapAssetSchedule(c: ComplianceJson): Record<string, unknown> {
  return {
    holdings: c.schedule_of_investments.map((h: ComplianceJsonHolding) => {
      const lxid = extractLxid(h.security_id);
      const isin = extractIsin(h.security_id);
      const [obligorName, facilityName] = splitDescription(h.description);
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

export function mapCompliance(c: ComplianceJson): ComplianceSections {
  return {
    compliance_summary: mapComplianceSummary(c),
    asset_schedule: mapAssetSchedule(c),
    interest_accrual_detail: mapInterestAccrualDetail(c),
    // remaining sections added in subsequent tasks
  };
}
