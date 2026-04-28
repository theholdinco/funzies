import type { Pass1Output, Pass2Output, Pass3Output, Pass4Output, Pass5Output } from "./schemas";
import { normalizeClassName } from "../api";

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

// Moody's ratings — CASE-SENSITIVE. Deliberate: the Caa→aa / Baa→aa corruption
// class shows up as lowercase output ("aa2") that would false-match "Aa2" under
// case-insensitive validation. Case-sensitive regex flags the corruption loudly.
const MOODYS_RATING_RE = /^(Aaa|Aa[1-3]|A[1-3]|Baa[1-3]|Ba[1-3]|B[1-3]|Caa[1-3]|Ca|C|WR|NR)$/;
// S&P / Fitch ratings — CASE-SENSITIVE for the same reason. CCC→CC corruption
// produces "cc" lowercase; case-sensitive validation catches it. "CC" alone
// (proper case) is a legitimate rating and passes.
const SP_FITCH_RATING_RE = /^(AAA|AA\+|AA|AA-|A\+|A|A-|BBB\+|BBB|BBB-|BB\+|BB|BB-|B\+|B|B-|CCC\+|CCC|CCC-|CC\+|CC|CC-|C|D|WR|NR)$/;

/**
 * Check holding rating strings against expected patterns. Logs a loud warning
 * when the value doesn't match. Case-sensitive regexes mean lowercase variants
 * like "aa2" or "ccc+" fail validation — catching the leading-letter-strip
 * corruption class where source "Caa2" or "Baa2" gets truncated to lowercase
 * "aa2". Note: this cannot distinguish legitimate "Aa2" from corrupted "Caa2"
 * (both proper case) — that's what the prompt-level directive guards.
 * Does NOT mutate the row; goal is telemetry, not correction.
 */
function validateHoldingRatings(row: Record<string, unknown>): void {
  const obligor = (row.obligor_name ?? "unknown") as string;
  const checks: Array<{ field: string; value: unknown; re: RegExp }> = [
    { field: "moodys_rating", value: row.moodys_rating, re: MOODYS_RATING_RE },
    { field: "moodys_rating_final", value: row.moodys_rating_final, re: MOODYS_RATING_RE },
    { field: "moodys_rating_unadjusted", value: row.moodys_rating_unadjusted, re: MOODYS_RATING_RE },
    { field: "sp_rating", value: row.sp_rating, re: SP_FITCH_RATING_RE },
    { field: "sp_rating_final", value: row.sp_rating_final, re: SP_FITCH_RATING_RE },
    { field: "fitch_rating", value: row.fitch_rating, re: SP_FITCH_RATING_RE },
    { field: "fitch_rating_final", value: row.fitch_rating_final, re: SP_FITCH_RATING_RE },
  ];
  for (const { field, value, re } of checks) {
    if (value == null || value === "") continue;
    const str = String(value).trim();
    if (!re.test(str)) {
      console.warn(
        `[normalizer] rating validation failed: obligor="${obligor}" field="${field}" value="${str}" — ` +
        `suspect corruption (e.g. Caa2→aa2, Baa2→aa2, CCC→cc, leading character stripped or lowercased). ` +
        `Check asset_schedule extraction for this position.`
      );
    }
  }
}

export interface PaymentHistoryRow {
  className: string;
  period: number | null;
  paymentDate: string;
  parCommitment: number | null;
  factor: number | null;
  interestPaid: number | null;
  principalPaid: number | null;
  cashflow: number | null;
  endingBalance: number | null;
  interestShortfall: number | null;
  accumInterestShortfall: number | null;
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

  // Use the same normalizeClassName the runner uses to match snapshots to
  // clo_tranches rows. Previously the local `norm` collapsed only whitespace
  // and "class" prefix, so "Subordinated Notes" and "Subordinated Notes due
  // 2032" were treated as distinct — but downstream the runner's
  // normalizeClassName collapses both to "SUBORDINATED", producing TWO
  // snapshot inserts pointing to the SAME tranche_id. Use the authoritative
  // normalizer here so merging matches downstream lookup.
  const byName = new Map<string, TrancheSnapshot>();

  for (const ts of compliance) {
    byName.set(normalizeClassName(ts.className), { className: ts.className, data: { ...ts.data } });
  }
  for (const ts of waterfall) {
    const key = normalizeClassName(ts.className);
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

  // Additional sanity: if the same normalized key appears twice with wildly
  // different current_balance values, that's a numerical misread (e.g. "44M"
  // read as "40M" on one pass). Not currently hit since merging is by key
  // above, but guard the dedup flow at the runner insert layer too.
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
        !name.includes("interest") && !name.includes("reinvestment") &&
        // Collateral quality test names — these are coverage tests semantically and
        // the resolver pulls them back out by testType ∈ {WARF, WAL, WAS, DIVERSITY, RECOVERY}.
        !name.includes("warf") && !name.includes("wal") && !name.includes("was") &&
        !name.includes("weighted average") && !name.includes("diversity") &&
        !name.includes("recovery") && !name.includes("floating spread")) return false;
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
  "totalPar", "totalPrincipalBalance", "wacSpread", "warf", "diversityScore",
  "numberOfAssets", "numberOfObligors", "walYears", "waRecoveryRate",
  "aggregatePrincipalBalance", "adjustedCollateralPrincipalAmount",
  "pctFixedRate", "pctFloatingRate", "pctCovLite", "pctSecondLien",
  "pctDefaulted", "pctCccAndBelow",
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
  paymentHistory: PaymentHistoryRow[];
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

  // §6 Collateral Quality Tests (WARF, WAL, WAS, diversity, recovery) — classify
  // by testName so they land under the right testType for the resolver. Also
  // backfill poolSummary fields from these values when compliance_summary didn't
  // populate them (so resolver's poolSummary.warf / walYears / diversityScore
  // / waMoodysRecovery / waRecoveryRate / wacSpread etc. aren't null).
  const cqt = sections.collateral_quality_tests;
  if (cqt) {
    const tests = cqt.tests as Array<Record<string, unknown>> | undefined;
    if (tests) {
      allTests.push(...tests.map(t => {
        const name = ((t.testName ?? "") as string).toLowerCase();
        // CQ tests are ALWAYS one of these five types. If the LLM returned a row
        // whose name doesn't match any, tag it "QUALITY_OTHER" so it doesn't
        // silently leak into concentrationTests (which filters on CONCENTRATION).
        let testType: string = "QUALITY_OTHER";
        if (name.includes("warf")) testType = "WARF";
        else if (name.includes("wal") || name.includes("weighted average life")) testType = "WAL";
        else if (name.includes("was") || name.includes("weighted average spread") || (name.includes("floating") && name.includes("spread"))) testType = "WAS";
        else if (name.includes("diversity")) testType = "DIVERSITY";
        else if (name.includes("recovery")) testType = "RECOVERY";
        return { ...t, testType };
      }));

      // Backfill poolSummary from CQ test actual values.
      // Agency matters for WARF (Moody's and Fitch use different scales:
      // Moody's rating-factor ~3000s, Fitch percentage ~25). poolSummary.warf
      // historically holds Moody's-scale WARF — only populate from Moody's.
      if (!poolSummary) poolSummary = { ...base };
      const ps = poolSummary as Record<string, unknown>;
      for (const t of tests) {
        const name = ((t.testName ?? "") as string).toLowerCase();
        const agency = ((t.agency ?? "") as string).toLowerCase();
        const val = t.actualValue as number | null | undefined;
        if (val == null) continue;
        const isMoodys = agency.includes("moody");
        const isSp = agency === "s&p" || agency === "sp" || agency.includes("standard");
        const isFitch = agency.includes("fitch");
        if (name.includes("warf") && isMoodys && ps.warf == null) ps.warf = val;
        if ((name.includes("wal") || name.includes("weighted average life")) && ps.wal_years == null) ps.wal_years = val;
        if ((name.includes("was") || name.includes("weighted average spread") || (name.includes("floating") && name.includes("spread"))) && ps.wac_spread == null) ps.wac_spread = val;
        if (name.includes("diversity") && ps.diversity_score == null) ps.diversity_score = val;
        if (name.includes("recovery")) {
          // F4 canary — recovery rates are stored as percent (30-80 typical).
          // A value in (0,1] smells like a decimal that wasn't ×100'd at
          // extraction; >100 is impossible. Warn but don't auto-correct since
          // the field has no engine consumer today.
          if (val > 0 && val <= 1) {
            console.warn(`[normalizer] recovery rate canary: agency="${agency || "n/a"}" name="${t.testName}" value=${val} smells like decimal — expected percent (30-80 typical). Check extraction unit.`);
          } else if (val > 100) {
            console.warn(`[normalizer] recovery rate canary: agency="${agency || "n/a"}" name="${t.testName}" value=${val} exceeds 100% — extraction may have multiplied a percent by 100.`);
          }
          if (isMoodys && ps.wa_moodys_recovery == null) ps.wa_moodys_recovery = val;
          else if (isSp && ps.wa_sp_recovery == null) ps.wa_sp_recovery = val;
          else if (isFitch && ps.wa_fitch_recovery == null) ps.wa_fitch_recovery = val;
          else if (!isMoodys && !isSp && !isFitch && ps.wa_recovery_rate == null) ps.wa_recovery_rate = val;
        }
      }
    }
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
        // Rating plausibility validation — catches the Caa→Aa / CCC→CC corruption class
        // (leading character stripped by LLM or pdfplumber). Does NOT mutate, just warns.
        validateHoldingRatings(row);
        return row;
      });

      // §22 Interest Accrual Detail join — per-position rate mechanics from
      // the authoritative rate table. The §9.2 holdings prompt typically
      // returns null spreadBps because §9.2 is a balance/price table, not a
      // rate table. §22 has the full per-position spread/index/all-in rate
      // detail. Join by LXID (preferred for loans) or ISIN (preferred for
      // bonds), with defensive normalization so trivial whitespace/case drift
      // can't break the join.
      const accrualDetail = (sections.interest_accrual_detail as { rows?: Array<Record<string, unknown>> } | undefined)?.rows;
      if (accrualDetail && accrualDetail.length > 0 && holdings.length > 0) {
        const normLxid = (v: unknown): string => String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
        const normIsin = (v: unknown): string => String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
        const byLxid = new Map<string, Record<string, unknown>>();
        const byIsin = new Map<string, Record<string, unknown>>();
        for (const r of accrualDetail) {
          const lxid = normLxid(r.lxid ?? r.securityId);
          if (lxid && lxid.startsWith("LX")) byLxid.set(lxid, r);
          const isin = normIsin(r.isin ?? r.securityId);
          if (isin && isin.startsWith("XS")) byIsin.set(isin, r);
        }

        let joined = 0;
        for (const h of holdings) {
          const hLxid = normLxid(h.lxid);
          const hIsin = normIsin(h.isin);
          const match = (hLxid && byLxid.get(hLxid)) || (hIsin && byIsin.get(hIsin)) || null;
          if (!match) continue;

          // Fill rate fields without overwriting any non-null value already
          // present from the asset_schedule extraction.
          const setIfMissing = (col: string, val: unknown) => {
            if (val != null && val !== "" && (h[col] == null || h[col] === "")) h[col] = val;
          };
          // spread_bps: prefer explicit; otherwise derive from spread_pct × 100
          const explicitBps = typeof match.spreadBps === "number" ? match.spreadBps : null;
          const fromPct = typeof match.spreadPct === "number" ? Math.round((match.spreadPct as number) * 100) : null;
          setIfMissing("spread_bps", explicitBps ?? fromPct);
          setIfMissing("all_in_rate", match.allInRatePct);
          setIfMissing("index_rate", match.indexRatePct);
          setIfMissing("reference_rate", match.baseIndex);
          setIfMissing("floor_rate", match.indexFloorPct);
          // is_fixed_rate: derive from rateType if asset_schedule didn't tag
          if (h.is_fixed_rate == null && match.rateType != null) {
            h.is_fixed_rate = String(match.rateType).toLowerCase() === "fixed";
          }
          joined++;
        }
        if (joined > 0) {
          console.log(`[normalizer] §22 interest accrual join: populated rate fields on ${joined}/${holdings.length} holdings`);
        }
        const unjoined = holdings.length - joined;
        if (unjoined > 5 && holdings.length > 0) {
          console.warn(
            `[normalizer] §22 interest accrual join: ${unjoined}/${holdings.length} holdings did NOT match any §22 row by LXID/ISIN. ` +
            `Check ID format consistency between §9.2 and §22.`
          );
        }
      }

      // Look-alike duplicate detection — flag pairs of holdings with identical
      // (obligorName, maturityDate, parBalance) but different ISINs. These are
      // either legitimate two-tranche positions OR ISIN-hallucination artifacts
      // where the extractor read the same security twice with a digit-swap on
      // the ID. Cross-check against the source positions list before trusting.
      const lookAlikeKey = (h: Record<string, unknown>): string =>
        `${String(h.obligor_name ?? "").toLowerCase().trim()}|${h.maturity_date ?? ""}|${h.par_balance ?? ""}`;
      const lookAlikeGroups = new Map<string, Array<{ isin: string; lxid: string }>>();
      for (const h of holdings) {
        const key = lookAlikeKey(h);
        if (!key.startsWith("|") && key.split("|")[0].length >= 4 && (h.par_balance != null)) {
          const ids = { isin: String(h.isin ?? ""), lxid: String(h.lxid ?? "") };
          const arr = lookAlikeGroups.get(key) ?? [];
          arr.push(ids);
          lookAlikeGroups.set(key, arr);
        }
      }
      for (const [key, ids] of lookAlikeGroups.entries()) {
        if (ids.length >= 2) {
          const isins = new Set(ids.map(i => i.isin).filter(s => s.length > 0));
          if (isins.size >= 2) {
            console.warn(
              `[normalizer] look-alike holdings: ${ids.length} positions match key "${key}" (obligor|maturity|par) but have ${isins.size} distinct ISINs ${Array.from(isins).join(" / ")}. ` +
              `Likely either two tranches of the same security OR an ISIN-hallucination duplicate. Cross-check against the source positions list.`
            );
          }
        }
      }
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
  const matchedDefaultNames = new Set<string>();
  if (defaultedObligors.size > 0 && holdings.length > 0) {
    for (const h of holdings) {
      const obligor = ((h.obligor_name ?? "") as string).toLowerCase().trim();
      if (obligor.length < 4) continue;

      // Exact match: flag holding (if not already) AND record the match.
      if (defaultedObligors.has(obligor)) {
        if (!h.is_defaulted) h.is_defaulted = true;
        matchedDefaultNames.add(obligor);
        continue;
      }

      // Fuzzy match: flag holding (if not already) AND record the matched defName.
      if (obligor.length >= 6) {
        for (const defName of defaultedObligors) {
          if (defName.length >= 6 && (obligor.includes(defName) || defName.includes(obligor))) {
            if (!h.is_defaulted) h.is_defaulted = true;
            matchedDefaultNames.add(defName);
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
  // math captures it. Tagged via data_source (migration 008) so consumers can
  // distinguish synthesized rows from real extractions.
  if (defaultDetail?.defaults) {
    let synthesized = 0;
    for (const d of defaultDetail.defaults) {
      const name = ((d.obligorName ?? d.obligor_name ?? "") as string).toLowerCase().trim();
      const isDefaulted = d.isDefaulted ?? d.is_defaulted ?? d.isDeferring ?? d.is_deferring;
      if (!isDefaulted || name.length < 4) continue;
      if (matchedDefaultNames.has(name)) continue;

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
        dataSource:         "pdf_extraction_synthesized",
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

  // 10. notes_information → paymentHistory (per-tranche flattened, deduped)
  // Normalize className so the upsert conflict key (profile_id, class_name,
  // payment_date) stays stable across extractions — e.g. "A" vs "Class A"
  // must dedupe instead of creating parallel series.
  const paymentHistory: PaymentHistoryRow[] = [];
  const notesInfo = sections.notes_information as { perTranche?: Record<string, Array<Record<string, unknown>>> } | undefined;
  if (notesInfo?.perTranche) {
    const seen = new Set<string>();
    for (const [rawClassName, rows] of Object.entries(notesInfo.perTranche)) {
      const className = normalizeClassName(rawClassName);
      for (const r of rows) {
        const paymentDate = r.paymentDate as string | undefined;
        if (!paymentDate) continue;
        const key = `${className}|${paymentDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        paymentHistory.push({
          className,
          period:                 (r.period as number | null) ?? null,
          paymentDate,
          parCommitment:          (r.parCommitment as number | null) ?? null,
          factor:                 (r.factor as number | null) ?? null,
          interestPaid:           (r.interestPaid as number | null) ?? null,
          principalPaid:          (r.principalPaid as number | null) ?? null,
          cashflow:               (r.cashflow as number | null) ?? null,
          endingBalance:          (r.endingBalance as number | null) ?? null,
          interestShortfall:      (r.interestShortfall as number | null) ?? null,
          accumInterestShortfall: (r.accumInterestShortfall as number | null) ?? null,
        });
      }
    }
  }

  // Backfill poolSummary counts/aggregates from holdings when compliance_summary
  // didn't populate them. Derives: numberOfAssets (= holdings.length),
  // numberOfObligors (unique obligor names), numberOfIndustries (unique Moody's
  // industry names), totalMarketValue (sum of per-position market values).
  if (holdings.length > 0) {
    if (!poolSummary) poolSummary = { ...base };
    const ps = poolSummary as Record<string, unknown>;
    if (ps.number_of_assets == null) ps.number_of_assets = holdings.length;
    if (ps.number_of_obligors == null) {
      const uniq = new Set(holdings.map(h => String(h.obligor_name ?? "").toLowerCase().trim()).filter(s => s.length > 0));
      ps.number_of_obligors = uniq.size;
    }
    if (ps.number_of_industries == null) {
      const uniq = new Set(
        holdings
          .map(h => String(h.moodys_industry ?? h.sp_industry ?? h.industry_description ?? "").toLowerCase().trim())
          .filter(s => s.length > 0)
      );
      if (uniq.size > 0) ps.number_of_industries = uniq.size;
    }
    if (ps.number_of_countries == null) {
      const uniq = new Set(
        holdings.map(h => String(h.country ?? "").toLowerCase().trim()).filter(s => s.length > 0)
      );
      if (uniq.size > 0) ps.number_of_countries = uniq.size;
    }
    if (ps.total_market_value == null) {
      const sum = holdings.reduce((s, h) => {
        const mv = h.market_value;
        return s + (typeof mv === "number" ? mv : (typeof mv === "string" ? parseFloat(mv) || 0 : 0));
      }, 0);
      if (sum > 0) ps.total_market_value = sum;
    }
    // Derive portfolio WAS from §22-joined floating positions when CQ tests
    // didn't supply it. Formula: sum(principal × spread_bps) / sum(principal)
    // over floating loans only (fixed-rate positions contribute their coupon
    // to WAC, not WAS).
    if (ps.wac_spread == null) {
      let wsumBps = 0;
      let psum = 0;
      for (const h of holdings) {
        if (h.is_fixed_rate === true) continue;
        const par = typeof h.par_balance === "number" ? h.par_balance
                  : typeof h.par_balance === "string" ? parseFloat(h.par_balance) || 0
                  : 0;
        const sb = typeof h.spread_bps === "number" ? h.spread_bps
                 : typeof h.spread_bps === "string" ? parseFloat(h.spread_bps) || 0
                 : 0;
        if (par > 0 && sb > 0) {
          wsumBps += par * sb;
          psum += par;
        }
      }
      if (psum > 0) {
        // Store as percentage to match compliance_summary convention.
        // wacSpread is later normalized to bps by the resolver.
        const wasPct = (wsumBps / psum) / 100;
        ps.wac_spread = Number(wasPct.toFixed(4));
      }
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
    paymentHistory,
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
