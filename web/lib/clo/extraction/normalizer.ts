import type { Pass1Output, Pass2Output, Pass3Output, Pass4Output, Pass5Output } from "./schemas";

function toSnakeCase(str: string): string {
  // Handle consecutive uppercase (acronyms): "ISINCode" → "isin_code", "WAL" → "wal"
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function toDbRow(obj: Record<string, unknown>, extraFields?: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = { ...extraFields };
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      row[toSnakeCase(key)] = value;
    }
  }
  return row;
}

type TrancheSnapshot = { className: string; data: Record<string, unknown> };

/** Merge tranche snapshots from compliance_summary and waterfall by className.
 *  Compliance has current_balance/coupon_rate; waterfall has beginning/ending/interest/principal.
 *  Waterfall ending_balance overrides compliance current_balance (post-payment is more precise). */
function mergeTrancheSnapshots(
  compliance: TrancheSnapshot[],
  waterfall: TrancheSnapshot[],
): TrancheSnapshot[] {
  if (waterfall.length === 0) return compliance;
  if (compliance.length === 0) return waterfall;

  const norm = (n: string) => n.replace(/^class(es)?\s+/i, "").replace(/[\s\-]+/g, "").toLowerCase();
  const byName = new Map<string, TrancheSnapshot>();

  for (const ts of compliance) {
    byName.set(norm(ts.className), { className: ts.className, data: { ...ts.data } });
  }
  for (const ts of waterfall) {
    const key = norm(ts.className);
    const existing = byName.get(key);
    if (existing) {
      // Merge waterfall fields into existing — waterfall fills gaps, doesn't overwrite
      for (const [k, v] of Object.entries(ts.data)) {
        if (v != null && existing.data[k] == null) {
          existing.data[k] = v;
        }
      }
      // Waterfall ending_balance is the post-payment balance — override current_balance
      if (ts.data.ending_balance != null) {
        existing.data.current_balance = ts.data.ending_balance;
      }
    } else {
      byName.set(key, { className: ts.className, data: { ...ts.data } });
    }
  }

  return Array.from(byName.values());
}

/** Normalize class name for dedup: "Class A/B" → "a/b", "A/B" → "a/b" */
function normalizeTestClass(name: string): string {
  return name
    .replace(/^class(es)?\s+/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** Build a dedup key from test name + class.
 *  When testClass is null, include testType to prevent collapsing OC/IC tests
 *  that share the same name but apply to different test categories. */
function testDedupKey(t: { testName: string; testClass?: string | null; testType?: string | null }): string {
  const name = t.testName.toLowerCase().replace(/\s+/g, " ").trim();
  const cls = t.testClass ? normalizeTestClass(t.testClass) : "";
  const type = t.testType ?? "";
  return `${name}|${cls}|${type}`;
}

/** Score a test entry by data completeness (higher = more complete) */
function testDataScore(t: Record<string, unknown>): number {
  let score = 0;
  if (t.actualValue != null && typeof t.actualValue === "number") score += 10;
  if (t.triggerLevel != null && typeof t.triggerLevel === "number") score += 5;
  if (t.isPassing != null) score += 3;
  if (t.cushionPct != null) score += 2;
  if (t.numerator != null) score += 1;
  if (t.denominator != null) score += 1;
  return score;
}

/** Deduplicate compliance tests — keep the entry with most data for each unique test */
function deduplicateComplianceTests(
  tests: Pass1Output["complianceTests"],
): Pass1Output["complianceTests"] {
  // Filter out junk entries (text in numeric fields, no useful data)
  const valid = tests.filter((t) => {
    if (!t.testName) return false;
    // Skip Default/Deferring Detail rows — these are per-asset default information,
    // not coverage tests. They get misclassified when the extraction parses the
    // Default and Deferring Detail section as compliance test entries.
    const name = (t.testName ?? "").toLowerCase();
    if (!name.includes("oc") && !name.includes("ic") && !name.includes("coverage") &&
        !name.includes("overcollateral") && !name.includes("par value") && !name.includes("par ratio") &&
        !name.includes("interest") && !name.includes("reinvestment")) return false;
    // Skip entries where actualValue is actually a string description
    if (t.actualValue != null && typeof t.actualValue !== "number") return false;
    if (t.triggerLevel != null && typeof t.triggerLevel !== "number") return false;
    // Skip entries with no numerical data at all
    const hasData = t.actualValue != null || t.triggerLevel != null || t.numerator != null || t.isPassing != null;
    return hasData;
  });

  const groups = new Map<string, typeof valid>();
  for (const t of valid) {
    const key = testDedupKey(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  return Array.from(groups.values()).map((group) => {
    // Pick the entry with the most complete data
    group.sort((a, b) => testDataScore(b) - testDataScore(a));
    return group[0];
  });
}

/** Dedup key for a holding: prefer ISIN > LXID > obligor+facility+maturity */
function holdingDedupKey(h: { obligorName?: string | null; facilityName?: string | null; isin?: string | null; lxid?: string | null; maturityDate?: string | null }): string {
  if (h.isin) return `isin:${h.isin.trim().toUpperCase()}`;
  if (h.lxid) return `lxid:${h.lxid.trim().toUpperCase()}`;
  const obligor = (h.obligorName ?? "").toLowerCase().trim();
  const facility = (h.facilityName ?? "").toLowerCase().trim();
  const maturity = (h.maturityDate ?? "").trim();
  return `name:${obligor}|${facility}|${maturity}`;
}

/** Score a holding by data completeness (higher = more complete) */
function holdingDataScore(h: Record<string, unknown>): number {
  let score = 0;
  if (h.parBalance != null) score += 10;
  if (h.spreadBps != null) score += 5;
  if (h.moodysRating != null) score += 3;
  if (h.spRating != null) score += 3;
  if (h.maturityDate != null) score += 2;
  if (h.industryDescription != null) score += 2;
  if (h.currentPrice != null) score += 1;
  if (h.allInRate != null) score += 1;
  return score;
}

/** Deduplicate holdings — keep the entry with most data for each unique asset */
function deduplicateHoldings(
  holdings: Pass2Output["holdings"],
): Pass2Output["holdings"] {
  if (holdings.length === 0) return holdings;

  const groups = new Map<string, typeof holdings>();
  for (const h of holdings) {
    const key = holdingDedupKey(h);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(h);
  }

  return Array.from(groups.values()).map((group) => {
    if (group.length === 1) return group[0];
    // Merge: start with most complete entry, fill nulls from others
    group.sort((a, b) => holdingDataScore(b) - holdingDataScore(a));
    const best = { ...group[0] };
    for (const other of group.slice(1)) {
      for (const [key, val] of Object.entries(other)) {
        if (val != null && (best as Record<string, unknown>)[key] == null) {
          (best as Record<string, unknown>)[key] = val;
        }
      }
    }
    return best;
  });
}

export function normalizePass1(data: Pass1Output, reportPeriodId: string): {
  poolSummary: Record<string, unknown>;
  complianceTests: Record<string, unknown>[];
  accountBalances: Record<string, unknown>[];
  parValueAdjustments: Record<string, unknown>[];
} {
  const base = { report_period_id: reportPeriodId };
  const dedupedTests = deduplicateComplianceTests(data.complianceTests);

  return {
    poolSummary: toDbRow(data.poolSummary, base),
    complianceTests: dedupedTests.map((t) => toDbRow(t, base)),
    accountBalances: data.accountBalances.map((a) => toDbRow(a, base)),
    parValueAdjustments: data.parValueAdjustments.map((p) => toDbRow(p, base)),
  };
}

export function normalizePass2(data: Pass2Output, reportPeriodId: string): {
  holdings: Record<string, unknown>[];
} {
  const base = { report_period_id: reportPeriodId };
  const deduped = deduplicateHoldings(data.holdings);
  return {
    holdings: deduped.map((h) => toDbRow(h, base)),
  };
}

export function normalizePass3(data: Pass3Output, reportPeriodId: string): {
  concentrations: Record<string, unknown>[];
} {
  const base = { report_period_id: reportPeriodId };
  return {
    concentrations: data.concentrations.map((c) => toDbRow(c, base)),
  };
}

export function normalizePass4(data: Pass4Output, reportPeriodId: string): {
  waterfallSteps: Record<string, unknown>[];
  proceeds: Record<string, unknown>[];
  trades: Record<string, unknown>[];
  tradingSummary: Record<string, unknown> | null;
  trancheSnapshots: Array<{ className: string; data: Record<string, unknown> }>;
} {
  const base = { report_period_id: reportPeriodId };

  return {
    waterfallSteps: data.waterfallSteps.map((w) => toDbRow(w, base)),
    proceeds: data.proceeds.map((p) => toDbRow(p, base)),
    trades: data.trades.map((t) => toDbRow(t, base)),
    tradingSummary: data.tradingSummary ? toDbRow(data.tradingSummary, base) : null,
    trancheSnapshots: data.trancheSnapshots.map((ts) => {
      const { className, ...rest } = ts;
      return { className, data: toDbRow(rest, base) };
    }),
  };
}

export function normalizePass5(data: Pass5Output, reportPeriodId: string, dealId: string): {
  supplementaryData: Record<string, unknown>;
  events: Record<string, unknown>[];
} {
  const { events, _overflow, ...supplementaryFields } = data;

  return {
    supplementaryData: supplementaryFields as Record<string, unknown>,
    events: events.map((e) => toDbRow(e, { deal_id: dealId, report_period_id: reportPeriodId })),
  };
}

// ---------------------------------------------------------------------------
// Section-based normalizers
// ---------------------------------------------------------------------------

const POOL_METRIC_KEYS = new Set([
  "totalPar", "wacSpread", "warf", "diversityScore", "numberOfAssets",
  "numberOfObligors", "walYears", "waRecoveryRate", "aggregatePrincipalBalance",
  "adjustedCollateralPrincipalAmount", "pctFixedRate", "pctFloatingRate",
  "pctCovLite", "pctSecondLien", "pctDefaulted", "pctCccAndBelow",
]);

export function normalizeSectionResults(
  sections: Record<string, Record<string, unknown> | null>,
  reportPeriodId: string,
  dealId: string,
): {
  poolSummary: Record<string, unknown> | null;
  complianceTests: Record<string, unknown>[];
  holdings: Record<string, unknown>[];
  concentrations: Record<string, unknown>[];
  waterfallSteps: Record<string, unknown>[];
  proceeds: Record<string, unknown>[];
  trades: Record<string, unknown>[];
  tradingSummary: Record<string, unknown> | null;
  trancheSnapshots: Array<{ className: string; data: Record<string, unknown> }>;
  accountBalances: Record<string, unknown>[];
  parValueAdjustments: Record<string, unknown>[];
  events: Record<string, unknown>[];
  supplementaryData: Record<string, unknown> | null;
} {
  const base = { report_period_id: reportPeriodId };

  // 1. compliance_summary → poolSummary + trancheSnapshots (from compliance_summary tranches)
  let poolSummary: Record<string, unknown> | null = null;
  let complianceTranches: Array<{ className: string; data: Record<string, unknown> }> = [];

  const cs = sections.compliance_summary;
  if (cs) {
    const poolMetrics: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cs)) {
      if (POOL_METRIC_KEYS.has(key)) {
        // Strip commas from numeric strings (e.g. "2,939" → 2939)
        if (typeof value === "string") {
          const cleaned = value.replace(/,/g, "");
          const num = parseFloat(cleaned);
          poolMetrics[key] = isNaN(num) ? value : num;
        } else {
          poolMetrics[key] = value;
        }
      }
    }
    // Derive totalPar: prefer Adjusted Collateral Principal Amount (the true
    // collateral value after haircuts, used as OC test numerator) over the raw
    // Aggregate Principal Balance.
    if (poolMetrics.adjustedCollateralPrincipalAmount != null) {
      poolMetrics.totalPar = poolMetrics.adjustedCollateralPrincipalAmount;
    } else if (poolMetrics.totalPar == null && poolMetrics.aggregatePrincipalBalance != null) {
      poolMetrics.totalPar = poolMetrics.aggregatePrincipalBalance;
    }

    poolSummary = toDbRow(poolMetrics, base);

    const tranches = cs.tranches as Array<Record<string, unknown>> | undefined;
    if (tranches) {
      complianceTranches = tranches.map((t) => {
        const { className, ...rest } = t;
        const data = toDbRow(rest, base);
        // Ensure current_balance is populated from principal_amount if missing
        // (compliance summary often has principalAmount but not currentBalance)
        if (data.current_balance == null && data.principal_amount != null) {
          data.current_balance = data.principal_amount;
        }
        // Map all_in_rate or spread to coupon_rate if coupon_rate is missing
        if (data.coupon_rate == null && data.all_in_rate != null) {
          data.coupon_rate = data.all_in_rate;
        } else if (data.coupon_rate == null && data.spread != null) {
          data.coupon_rate = data.spread;
        }
        return { className: className as string, data };
      });
    }
  }

  // 2. par_value_tests + interest_coverage_tests → complianceTests
  let complianceTests: Record<string, unknown>[] = [];
  const allTests: Array<Record<string, unknown>> = [];

  const pvt = sections.par_value_tests;
  if (pvt) {
    const tests = pvt.tests as Array<Record<string, unknown>> | undefined;
    if (tests) allTests.push(...tests);
  }

  const ict = sections.interest_coverage_tests;
  if (ict) {
    const tests = ict.tests as Array<Record<string, unknown>> | undefined;
    // Tag tests from the interest_coverage_tests section as IC only if their name
    // actually indicates an IC test. The section may contain OC test duplicates
    // (when the document mapper assigns OC pages to the IC section).
    if (tests) allTests.push(...tests.map(t => {
      const name = ((t.testName ?? "") as string).toLowerCase();
      const isIc = name.includes("interest coverage") || name.includes("ic ratio") || (name.includes("ic") && !name.includes("oc"));
      return { ...t, testType: isIc ? "IC" : (t.testType ?? "IC") };
    }));
  }

  if (allTests.length > 0) {
    const deduped = deduplicateComplianceTests(allTests as any);
    complianceTests = deduped.map((t) => toDbRow(t as Record<string, unknown>, base));
  }

  // 3. par_value_tests → parValueAdjustments
  let parValueAdjustments: Record<string, unknown>[] = [];
  if (pvt) {
    const adjustments = pvt.parValueAdjustments as Array<Record<string, unknown>> | undefined;
    if (adjustments) {
      parValueAdjustments = adjustments.map((a) => toDbRow(a, base));
    }
  }

  // 4. asset_schedule → holdings
  let holdings: Record<string, unknown>[] = [];
  const as_ = sections.asset_schedule;
  if (as_) {
    const rawHoldings = as_.holdings as Array<Record<string, unknown>> | undefined;
    if (rawHoldings && rawHoldings.length > 0) {
      const deduped = deduplicateHoldings(rawHoldings as any);
      holdings = deduped.map((h) => {
        const row = toDbRow(h as Record<string, unknown>, base);
        // Fallback: principal_balance → par_balance if par_balance missing
        if (row.par_balance == null && row.principal_balance != null) {
          row.par_balance = row.principal_balance;
        }
        // Fallback: market_value → par_balance as last resort (MV ≠ par for distressed loans)
        if (row.par_balance == null && row.market_value != null) {
          row.par_balance = row.market_value;
          console.warn(`[normalizer] Using market_value as par_balance for holding "${row.obligor_name ?? "unknown"}" — may understate par for distressed loans`);
        }
        return row;
      });
    }
  }

  // 4b. Cross-reference: mark holdings as defaulted using the Default and Deferring Detail
  // section (dedicated per-obligor default data) and par value adjustments (fallback).
  // The LLM may miss the isDefaulted flag on the asset schedule but these sections
  // explicitly list defaulted obligations by name.
  const defaultDetail = sections.default_detail as { defaults?: Array<Record<string, unknown>> } | undefined;
  const defaultedObligors = new Set<string>();

  // Primary source: Default and Deferring Detail section (per-obligor, most reliable)
  if (defaultDetail?.defaults) {
    for (const d of defaultDetail.defaults) {
      const name = ((d.obligorName ?? d.obligor_name ?? "") as string).toLowerCase().trim();
      if (name.length >= 4 && (d.isDefaulted ?? d.is_defaulted ?? d.isDeferring ?? d.is_deferring)) {
        defaultedObligors.add(name);
      }
    }
  }

  // Fallback: par value adjustment descriptions (summary-level, less reliable)
  if (defaultedObligors.size === 0 && parValueAdjustments.length > 0) {
    for (const a of parValueAdjustments) {
      const adjType = ((a.adjustment_type ?? a.adjustmentType) as string ?? "").toUpperCase();
      if (adjType.includes("DEFAULT")) {
        const desc = ((a.description ?? a.obligor_name ?? "") as string).toLowerCase();
        if (desc.length > 5) defaultedObligors.add(desc);
      }
    }
  }

  // Apply to holdings
  if (defaultedObligors.size > 0 && holdings.length > 0) {
    for (const h of holdings) {
      if (h.is_defaulted) continue;
      const obligor = ((h.obligor_name ?? "") as string).toLowerCase().trim();
      if (obligor.length >= 4 && defaultedObligors.has(obligor)) {
        h.is_defaulted = true;
      }
      // Fuzzy: check if any defaulted name is a substring of the holding's obligor (or vice versa)
      if (!h.is_defaulted && obligor.length >= 6) {
        for (const defName of defaultedObligors) {
          if (defName.length >= 6 && (obligor.includes(defName) || defName.includes(obligor))) {
            h.is_defaulted = true;
            break;
          }
        }
      }
    }
  }

  // Also enrich holdings with recovery rates from default detail (per-obligor agency rates)
  if (defaultDetail?.defaults && holdings.length > 0) {
    for (const d of defaultDetail.defaults) {
      const defName = ((d.obligorName ?? d.obligor_name ?? "") as string).toLowerCase().trim();
      if (!defName) continue;
      for (const h of holdings) {
        const obligor = ((h.obligor_name ?? "") as string).toLowerCase().trim();
        if (obligor && (obligor === defName || obligor.includes(defName) || defName.includes(obligor))) {
          // Set recovery rates from default detail if not already present
          if (d.recoveryRateFitch ?? d.recovery_rate_fitch) h.recovery_rate_fitch = h.recovery_rate_fitch ?? (d.recoveryRateFitch ?? d.recovery_rate_fitch);
          if (d.recoveryRateSp ?? d.recovery_rate_sp) h.recovery_rate_sp = h.recovery_rate_sp ?? (d.recoveryRateSp ?? d.recovery_rate_sp);
          if (d.recoveryRateMoodys ?? d.recovery_rate_moodys) h.recovery_rate_moodys = h.recovery_rate_moodys ?? (d.recoveryRateMoodys ?? d.recovery_rate_moodys);
          if (d.marketPrice ?? d.market_price) h.current_price = h.current_price ?? (d.marketPrice ?? d.market_price);
        }
      }
    }
  }

  // --- Phantom-holding synthesis from unmatched default_detail rows ---
  // If default_detail names an obligor but no holding was flagged (e.g., name
  // disagreement between asset_schedule and default_detail), synthesize a
  // phantom holding so the resolver's `holdings.filter(h => h.isDefaulted)`
  // math captures it. Tagged with data_origin so consumers can filter.
  const matchedObligors = new Set<string>();
  for (const h of holdings) {
    if (h.is_defaulted) {
      const obligor = ((h.obligor_name ?? "") as string).toLowerCase().trim();
      if (obligor.length >= 4) matchedObligors.add(obligor);
    }
  }

  if (defaultDetail?.defaults) {
    let synthesized = 0;
    for (const d of defaultDetail.defaults) {
      const name = ((d.obligorName ?? d.obligor_name ?? "") as string).toLowerCase().trim();
      const isDefaulted = d.isDefaulted ?? d.is_defaulted ?? d.isDeferring ?? d.is_deferring;
      if (!isDefaulted || name.length < 4) continue;
      if (matchedObligors.has(name)) continue;

      const parAmount = (d.parAmount ?? d.par_amount) as number | null | undefined;
      if (parAmount == null || parAmount <= 0) continue;

      holdings.push(toDbRow({
        obligorName:        d.obligorName ?? d.obligor_name,
        parBalance:         parAmount,
        isDefaulted:        true,
        currentPrice:       d.marketPrice ?? d.market_price,
        recoveryRateMoodys: d.recoveryRateMoodys ?? d.recovery_rate_moodys,
        recoveryRateSp:     d.recoveryRateSp ?? d.recovery_rate_sp,
        recoveryRateFitch:  d.recoveryRateFitch ?? d.recovery_rate_fitch,
        dataOrigin:         "synthesized_from_default_detail",
      }, base));
      synthesized++;
    }
    if (synthesized > 0) {
      console.warn(
        `[normalizer] default_detail synthesis: created ${synthesized} phantom holdings ` +
        `from unmatched defaulted obligations. Canary: asset_schedule + default_detail ` +
        `obligor names disagree — condensing-layer lint may need attention.`
      );
    }
  }

  // 5. concentration_tables → concentrations
  let concentrations: Record<string, unknown>[] = [];
  const ct = sections.concentration_tables;
  if (ct) {
    const rawConc = ct.concentrations as Array<Record<string, unknown>> | undefined;
    if (rawConc) {
      concentrations = rawConc.map((c) => toDbRow(c, base));
    }
  }

  // 6. waterfall → waterfallSteps + proceeds + trancheSnapshots
  let waterfallSteps: Record<string, unknown>[] = [];
  let proceeds: Record<string, unknown>[] = [];
  let waterfallTranches: Array<{ className: string; data: Record<string, unknown> }> = [];

  const wf = sections.waterfall;
  if (wf) {
    const rawSteps = wf.waterfallSteps as Array<Record<string, unknown>> | undefined;
    if (rawSteps) waterfallSteps = rawSteps.map((w) => toDbRow(w, base));

    const rawProceeds = wf.proceeds as Array<Record<string, unknown>> | undefined;
    if (rawProceeds) proceeds = rawProceeds.map((p) => toDbRow(p, base));

    const rawTranches = wf.trancheSnapshots as Array<Record<string, unknown>> | undefined;
    if (rawTranches) {
      waterfallTranches = rawTranches.map((ts) => {
        const { className, ...rest } = ts;
        return { className: className as string, data: toDbRow(rest, base) };
      });
    }
  }

  // Merge trancheSnapshots from compliance_summary and waterfall by className
  // (compliance_summary has current_balance/coupon_rate, waterfall has beginning/ending/interest/principal)
  const trancheSnapshots = mergeTrancheSnapshots(complianceTranches, waterfallTranches);

  // 7. trading_activity → trades + tradingSummary
  let trades: Record<string, unknown>[] = [];
  let tradingSummary: Record<string, unknown> | null = null;

  const ta = sections.trading_activity;
  if (ta) {
    const rawTrades = ta.trades as Array<Record<string, unknown>> | undefined;
    if (rawTrades) trades = rawTrades.map((t) => toDbRow(t, base));

    const rawSummary = ta.tradingSummary as Record<string, unknown> | undefined;
    if (rawSummary) tradingSummary = toDbRow(rawSummary, base);
  }

  // 8. account_balances → accountBalances
  let accountBalances: Record<string, unknown>[] = [];
  const ab = sections.account_balances;
  if (ab) {
    const rawAccounts = ab.accounts as Array<Record<string, unknown>> | undefined;
    if (rawAccounts) accountBalances = rawAccounts.map((a) => toDbRow(a, base));
  }

  // 9. supplementary → events + supplementaryData
  let events: Record<string, unknown>[] = [];
  let supplementaryData: Record<string, unknown> | null = null;

  const supp = sections.supplementary;
  if (supp) {
    const rawEvents = supp.events as Array<Record<string, unknown>> | undefined;
    if (rawEvents) {
      events = rawEvents.map((e) => toDbRow(e, { deal_id: dealId, report_period_id: reportPeriodId }));
    }

    const { events: _, ...rest } = supp;
    if (Object.keys(rest).length > 0) {
      supplementaryData = rest as Record<string, unknown>;
    }
  }

  return {
    poolSummary,
    complianceTests,
    holdings,
    concentrations,
    waterfallSteps,
    proceeds,
    trades,
    tradingSummary,
    trancheSnapshots,
    accountBalances,
    parValueAdjustments,
    events,
    supplementaryData,
  };
}

export function normalizePpmSectionResults(
  sections: Record<string, Record<string, unknown> | null>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const txOverview = sections.transaction_overview;
  if (txOverview) {
    result.dealIdentity = txOverview;
    if (txOverview.collateralManager) result.collateralManager = txOverview.collateralManager;
  }

  const capStructure = sections.capital_structure;
  if (capStructure) {
    const { capitalStructure, dealSizing, ...rest } = capStructure;
    if (capitalStructure) result.capitalStructure = capitalStructure;
    if (dealSizing) result.dealSizing = dealSizing;
    // Spread any extra fields
    for (const [key, value] of Object.entries(rest)) {
      if (value != null) result[key] = value;
    }
  }

  const coverageTests = sections.coverage_tests;
  if (coverageTests) {
    const { coverageTestEntries, reinvestmentOcTest, ...rest } = coverageTests;
    if (coverageTestEntries) result.coverageTestEntries = coverageTestEntries;
    if (reinvestmentOcTest) result.reinvestmentOcTest = reinvestmentOcTest;
    for (const [key, value] of Object.entries(rest)) {
      if (value != null) result[key] = value;
    }
  }

  const eligibility = sections.eligibility_criteria;
  if (eligibility) {
    const { eligibilityCriteria, reinvestmentCriteria, ...rest } = eligibility;
    if (eligibilityCriteria) result.eligibilityCriteria = eligibilityCriteria;
    if (reinvestmentCriteria) result.reinvestmentCriteria = reinvestmentCriteria;
    for (const [key, value] of Object.entries(rest)) {
      if (value != null) result[key] = value;
    }
  }

  const portfolio = sections.portfolio_constraints;
  if (portfolio) {
    const { collateralQualityTests, portfolioProfileTests, ...rest } = portfolio;
    if (collateralQualityTests) result.collateralQualityTests = collateralQualityTests;
    if (portfolioProfileTests) result.portfolioProfileTests = portfolioProfileTests;
    for (const [key, value] of Object.entries(rest)) {
      if (value != null) result[key] = value;
    }
  }

  const waterfallRules = sections.waterfall_rules;
  if (waterfallRules) result.waterfall = waterfallRules;

  const fees = sections.fees_and_expenses;
  if (fees) {
    const { fees: feeList, accounts, ...rest } = fees;
    if (feeList) result.fees = feeList;
    if (accounts) result.accounts = accounts;
    for (const [key, value] of Object.entries(rest)) {
      if (value != null) result[key] = value;
    }
  }

  const keyDates = sections.key_dates;
  if (keyDates) result.keyDates = keyDates;

  const keyParties = sections.key_parties;
  if (keyParties) {
    const { keyParties: parties, cmDetails, ...rest } = keyParties;
    if (parties) result.keyParties = parties;
    if (cmDetails) result.cmDetails = cmDetails;
    for (const [key, value] of Object.entries(rest)) {
      if (value != null) result[key] = value;
    }
  }

  const redemption = sections.redemption;
  if (redemption) {
    const { redemptionProvisions, eventsOfDefault, ...rest } = redemption;
    if (redemptionProvisions) result.redemptionProvisions = redemptionProvisions;
    if (eventsOfDefault) result.eventsOfDefault = eventsOfDefault;
    for (const [key, value] of Object.entries(rest)) {
      if (value != null) result[key] = value;
    }
  }

  const hedging = sections.hedging;
  if (hedging) result.hedging = hedging;

  const interestMechanics = sections.interest_mechanics;
  if (interestMechanics) result.interestMechanics = interestMechanics;

  return result;
}
