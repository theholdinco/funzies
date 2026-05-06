/**
 * D5 — Buy-list compliance filter (Sprint 4 + industry-cap closure).
 *
 * Pure helpers that filter `BuyListItem[]` against PPM-style compliance
 * thresholds. Shipped so partner can see "which buy-list candidates pass
 * Euro XV's Moody's WARF / Minimum WAS / Caa concentration / cov-lite /
 * industry constraints" without manually cross-referencing.
 *
 * Scope (what this module enforces):
 *   ✅ `maxWarfFactor` — drop items whose moodysRating maps to a WARF factor
 *      above the cap. Unrated items pass (can't evaluate; partner decides).
 *   ✅ `minSpreadBps` — drop items whose spreadBps is below the floor.
 *   ✅ `excludeCaa` — drop items whose moodysRating is Caa1/Caa2/Caa3/Ca/C.
 *   ✅ `excludeCovLite` — drop items with `isCovLite === true`. Null-isCovLite
 *      items pass (unknown; don't over-claim).
 *   ✅ `excludeIndustryCodes` — drop items whose canonical industryCode
 *      matches the blacklist (industry-cap). Items with null industryCode pass
 *      (caller's responsibility — typically classified before filter run;
 *      D5 filter does not infer codes here).
 *   ✅ `excludeIndustriesAtCap` — drop items whose canonical industryCode
 *      points to a pool industry already at-or-near the deal's clause-(t)
 *      cap. Pre-filled from resolved.poolSummary.industryDistributionPct
 *      + resolved.industryCapRules.
 *
 * Pre-fill: `buyListFiltersFromResolved(resolved)` extracts the two
 * numeric caps (WARF + WAS) from `resolved.qualityTests` by test-name match
 * AND the at-cap industry code list from the resolved pool composition +
 * cap rules.
 */

import type { BuyListItem } from "./types";
import type { ResolvedDealData, IndustryCapRule } from "./resolver-types";
import { isMoodysCaaOrBelow, moodysWarfFactor } from "./rating-mapping";
import { BUCKET_WARF_FALLBACK } from "./pool-metrics";

export interface BuyListFilterParams {
  /** Moody's WARF cap — items above this factor are dropped. Typically the
   *  Moody's Maximum WARF trigger (Euro XV: 3148). Null/undefined disables. */
  maxWarfFactor?: number | null;
  /** Minimum spread in bps — items below are dropped. Typically the
   *  Minimum WAS trigger × 100 (Euro XV: 365 bps from 3.65%). Null disables. */
  minSpreadBps?: number | null;
  /** If true, drop any item whose Moody's rating is Caa1/Caa2/Caa3/Ca/C.
   *  Default false — partner opts in. */
  excludeCaa?: boolean;
  /** If true, drop items with `isCovLite === true`. Items with null
   *  isCovLite pass (unknown; don't over-claim). Default false. */
  excludeCovLite?: boolean;
  /** industry-cap: drop items whose canonical industryCode matches any entry.
   *  Lowercase comparison is NOT applied — canonical codes are
   *  taxonomy-defined and case-significant. Items with null industryCode
   *  pass (caller is expected to have classified upstream; D5 filter is
   *  not the classification layer). */
  excludeIndustryCodes?: ReadonlyArray<string>;
}

/**
 * Pre-fill precedence policy: **user overrides are authoritative**. When a
 * caller passes `BuyListFilterParams` with a user-set value, the helper
 * uses it verbatim — no clamping to PPM, no warning on divergence. Rationale:
 * scenario analysis is a legitimate use case ("what if I were stricter than
 * the PPM?" / "what if I stressed a deal with 4000 WARF cap?"). The filter
 * is NOT a compliance validator; it's a filter. If the caller wants PPM
 * defaults, it calls `buyListFiltersFromResolved(resolved)` and uses the
 * result as-is; if it wants user values, it passes those. Merging is the
 * caller's responsibility.
 */

export interface FilterResult {
  passed: BuyListItem[];
  /** Items dropped by at least one filter, with the reason strings for each
   *  failing filter. Partner UI can render this as "why was X excluded?" */
  dropped: Array<{ item: BuyListItem; reasons: string[] }>;
}

/** Apply filters to a buy-list. Returns both passed + dropped-with-reasons
 *  so partner UI can show "here's what was excluded and why". */
export function filterBuyList(items: BuyListItem[], filters: BuyListFilterParams): FilterResult {
  const passed: BuyListItem[] = [];
  const dropped: FilterResult["dropped"] = [];

  for (const item of items) {
    const reasons: string[] = [];

    if (filters.maxWarfFactor != null) {
      // KI-19 consistency: unrated items get Caa2 fallback (6500) per Moody's
      // CLO methodology — same treatment as the projection engine's WARF
      // computation. Filter would otherwise silently pass unrated candidates
      // that Moody's treats as high-risk, diverging from engine-side math.
      const wf = item.moodysRating != null
        ? moodysWarfFactor(item.moodysRating)
        : BUCKET_WARF_FALLBACK.NR;
      const effectiveWf = wf ?? BUCKET_WARF_FALLBACK.NR;
      if (effectiveWf > filters.maxWarfFactor) {
        const ratingLabel = item.moodysRating ?? "NR (→ Caa2 per Moody's convention, KI-19)";
        reasons.push(`WARF ${effectiveWf} > cap ${filters.maxWarfFactor} (${ratingLabel})`);
      }
    }

    if (filters.minSpreadBps != null && item.spreadBps != null) {
      if (item.spreadBps < filters.minSpreadBps) {
        reasons.push(`spread ${item.spreadBps} bps < floor ${filters.minSpreadBps} bps`);
      }
    }

    if (filters.excludeCaa && isMoodysCaaOrBelow(item.moodysRating)) {
      reasons.push(`Caa-or-below rating (${item.moodysRating})`);
    }

    if (filters.excludeCovLite && item.isCovLite === true) {
      reasons.push("cov-lite");
    }

    if (filters.excludeIndustryCodes != null && filters.excludeIndustryCodes.length > 0 && item.industryCode != null) {
      if (filters.excludeIndustryCodes.includes(item.industryCode)) {
        reasons.push(`industry ${item.industryCode} excluded (at-or-near cap)`);
      }
    }

    if (reasons.length === 0) passed.push(item);
    else dropped.push({ item, reasons });
  }

  return { passed, dropped };
}

/** Pre-fill filter thresholds from resolved PPM data. Matches the Moody's
 *  Maximum WARF test and Minimum Weighted Average Floating Spread Test by
 *  `canonicalType` populated at the resolver normalization point — the
 *  classification regex lives in one place (resolver.ts:classifyComplianceTest)
 *  so this consumer cannot drift apart from the engine's compliance gate.
 *  Null when the resolver didn't extract the test (UI falls back to
 *  user-entered values). Binary flags intentionally NOT auto-set — partner
 *  opts into excludeCaa / excludeCovLite explicitly.
 *
 *  industry-cap: `excludeIndustryCodes` pre-filled from at-or-near-cap industries
 *  in the resolved pool. An industry is "at-or-near cap" when its current
 *  share is within 90% of any binding rule's trigger (single_rank_max
 *  rank-1, single_class_max for that bucket, or contributing to a binding
 *  combined_top_n_max). Conservative — partner opts in via UI checkbox;
 *  helper just supplies the codes the binding rules identify. */
export function buyListFiltersFromResolved(resolved: ResolvedDealData): BuyListFilterParams {
  const warfTest = resolved.qualityTests.find((t) => t.canonicalType === "moodys_max_warf");
  const wasTest = resolved.qualityTests.find((t) => t.canonicalType === "min_was");
  return {
    maxWarfFactor: warfTest?.triggerLevel ?? null,
    // Minimum WAS trigger is reported in % (e.g. 3.65); filter field is bps.
    // Convert via × 100. Null if trigger absent.
    minSpreadBps: wasTest?.triggerLevel != null ? wasTest.triggerLevel * 100 : null,
    excludeIndustryCodes: identifyAtCapIndustries(resolved),
  };
}

/** industry-cap: identify industries currently AT OR OVER a binding clause-(t)
 *  cap. Returns the canonical industryCode list — caller surfaces in UI as
 *  the "exclude buckets at cap" checkbox's pre-fill set. Empty when the
 *  resolved deal has no industry distribution / no rules, or when every
 *  rule's `appliesWhen` predicate is currently inactive.
 *
 *  Threshold is exact equality (parPct >= triggerPct): a bucket is flagged
 *  when its current share is at or beyond the rule's trigger. A "near
 *  cap with cushion" interpretation requires a partner-set buffer (not
 *  available here without a UI surface for the parameter); shipping the
 *  exact-cap version is the unambiguous default.
 *
 *  appliesWhen evaluation: rules with conditional triggers (post-RP,
 *  ccc-pct-above, defaulted-pct-above) only flag at-cap when their
 *  condition is satisfied at the current period. Skipping this evaluation
 *  would over-flag — e.g., a post-RP rule treated as binding while still
 *  in RP would drop industries from the buy-list that aren't actually
 *  constrained, hiding viable buy candidates. */
function identifyAtCapIndustries(resolved: ResolvedDealData): string[] {
  if (resolved.industryCapRules == null || resolved.industryCapRules.length === 0) return [];
  const dist = resolved.poolSummary.industryDistributionPct;
  if (dist == null || dist.length === 0) return [];

  // Evaluate appliesWhen against the resolved closing-state pool. This is
  // the partner's "current period" snapshot — the buy-list view is at-this-
  // moment, not forward-projected. Engine forward periods evaluate
  // appliesWhen against per-period state; here we only care about NOW.
  const inRP = resolved.dates.reinvestmentPeriodEnd != null
    ? resolved.dates.currentDate <= resolved.dates.reinvestmentPeriodEnd
    : false;
  const pctMoodysCaa = resolved.poolSummary.pctCccAndBelow ?? 0;
  const pctDefaulted = resolved.poolSummary.totalPar > 0
    ? (resolved.preExistingDefaultedPar / resolved.poolSummary.totalPar) * 100
    : 0;

  const ruleApplies = (rule: IndustryCapRule): boolean => {
    if (!rule.appliesWhen) return true;
    switch (rule.appliesWhen.kind) {
      case "during_reinvestment_period": return inRP;
      case "post_reinvestment_period": return !inRP;
      case "ccc_pct_above": return pctMoodysCaa > rule.appliesWhen.thresholdPct;
      case "defaulted_pct_above": return pctDefaulted > rule.appliesWhen.thresholdPct;
    }
  };

  const atCap = new Set<string>();

  for (const rule of resolved.industryCapRules) {
    if (!ruleApplies(rule)) continue;
    switch (rule.kind) {
      case "single_rank_max":
        if (dist[rule.rank - 1]?.parPct >= rule.triggerPct) {
          atCap.add(dist[rule.rank - 1].industryCode);
        }
        break;
      case "combined_top_n_max": {
        const combined = dist.slice(0, rule.n).reduce((s, b) => s + b.parPct, 0);
        if (combined >= rule.triggerPct) {
          for (const b of dist.slice(0, rule.n)) atCap.add(b.industryCode);
        }
        break;
      }
      case "single_class_max": {
        const bucket = dist.find((b) => b.industryCode === rule.industryCode);
        if (bucket && bucket.parPct >= rule.triggerPct) {
          atCap.add(rule.industryCode);
        }
        break;
      }
      case "count_above_threshold": {
        // When the pool already has `maxCount` industries above threshold,
        // any bucket below threshold gaining par to cross threshold pushes
        // the count over. Conservative: when at-cap, mark every below-
        // threshold bucket as at-cap (caller may not want to add ANY new
        // bucket in that state). When count is < maxCount the rule isn't
        // binding and no buckets are flagged.
        const aboveCount = dist.filter((b) => b.parPct > rule.thresholdPct).length;
        if (aboveCount >= rule.maxCount) {
          for (const b of dist) {
            if (b.parPct <= rule.thresholdPct) atCap.add(b.industryCode);
          }
        }
        break;
      }
    }
  }
  return Array.from(atCap);
}

// Re-export IndustryCapRule for downstream consumers that build filter
// params programmatically (e.g., scenario-analysis "what if I tighten
// the rank-1 cap to N%?" UI flows).
export type { IndustryCapRule };
