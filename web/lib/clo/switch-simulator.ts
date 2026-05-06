import type { ResolvedDealData, ResolvedLoan, ResolutionWarning } from "./resolver-types";
import type { ProjectionInputs } from "./projection";
import { buildFromResolved, type UserAssumptions } from "./build-projection-inputs";
import {
  BUCKET_WARF_FALLBACK,
  computePoolQualityMetrics,
  computeTopNObligorsPct,
} from "./pool-metrics";

export interface SwitchParams {
  sellLoanIndex: number;
  sellParAmount: number; // how much par to sell (can be less than the full position for partial sales)
  buyLoan: ResolvedLoan; // the buy loan with its own par amount
  sellPrice: number; // percent of par, e.g. 98
  buyPrice: number; // percent of par, e.g. 101
}

export interface SwitchResult {
  baseInputs: ProjectionInputs;
  switchedInputs: ProjectionInputs;
  /** D4 — switched pool's `ResolvedDealData` with recomputed poolSummary
   *  quality metrics (warf, walYears, wacSpreadBps, pctCccAndBelow),
   *  top10ObligorsPct, and obligor count. Partner UI reads poolSummary
   *  from here to render base-vs-switched compliance impact. */
  switchedResolved: ResolvedDealData;
  parDelta: number;
  spreadDelta: number;
  ratingChange: { from: string; to: string };
}

/** D4 — Years between two ISO dates. Used to derive per-position
 *  yearsToMaturity for the quality-metrics helper. Assumes 365.25 days/year
 *  (leap-year averaged); negligible vs WAL's natural precision. */
function yearsBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  return Math.max(0, (to - from) / (1000 * 86400 * 365.25));
}

/** D4 — Map a ResolvedLoan to the QualityMetricLoan shape the shared helper
 *  expects. `warfFactor` falls back to BUCKET_WARF_FALLBACK when the resolver
 *  didn't populate (NR loans without a rating; see KI-19). Per-agency ratings
 *  and exclusion flags propagate so the helper can apply the PPM Condition 1
 *  Floating WAS / Excess WAC / per-agency Caa-CCC methodology. */
function toQualityMetricLoan(l: ResolvedLoan, currentDate: string) {
  return {
    parBalance: l.parBalance,
    warfFactor: l.warfFactor ?? BUCKET_WARF_FALLBACK[l.ratingBucket] ?? BUCKET_WARF_FALLBACK.NR,
    yearsToMaturity: yearsBetween(currentDate, l.maturityDate),
    spreadBps: l.spreadBps,
    ratingBucket: l.ratingBucket,
    isFixedRate: l.isFixedRate,
    fixedCouponPct: l.fixedCouponPct,
    isDeferring: l.isDeferring,
    isLossMitigationLoan: l.isLossMitigationLoan,
    currency: l.currency,
    moodysRatingFinal: l.moodysRatingFinal,
    fitchRatingFinal: l.fitchRatingFinal,
    moodysRatingSource: l.moodysRatingSource,
    isCreditEstimateOrPrivateRating: l.isCreditEstimateOrPrivateRating,
  };
}

export function applySwitch(
  resolved: ResolvedDealData,
  params: SwitchParams,
  assumptions: UserAssumptions,
  // When threaded, resolver warnings flow into the buildFromResolved
  // gate calls below; a blocking warning then throws IncompleteDataError
  // out of applySwitch. Optional (mirrors buildFromResolved's contract);
  // any new caller must thread warnings or accept that the gate is
  // bypassed for that call path.
  warnings?: ResolutionWarning[],
): SwitchResult {
  const { sellLoanIndex, sellParAmount, buyLoan, sellPrice: _sellPrice, buyPrice: _buyPrice } = params;
  const sellLoan = resolved.loans[sellLoanIndex];

  const baseInputs = buildFromResolved(resolved, assumptions, warnings);

  // Build switched loan pool
  const switchedLoans = [...resolved.loans];
  const actualSellPar = Math.min(sellParAmount, sellLoan.parBalance);

  if (actualSellPar >= sellLoan.parBalance - 0.01) {
    // Full sale — remove the loan entirely
    switchedLoans.splice(sellLoanIndex, 1);
  } else {
    // Partial sale — reduce the loan's par
    switchedLoans[sellLoanIndex] = { ...sellLoan, parBalance: sellLoan.parBalance - actualSellPar };
  }

  // Add buy loan with its specified par amount
  switchedLoans.push(buyLoan);

  // Par delta = buy par - sell par (straightforward, prices don't change par)
  const parDelta = buyLoan.parBalance - actualSellPar;

  // D4 — Recompute portfolio quality + concentration metrics so partner sees
  // compliance impact of the proposed trade. Uses the same `computePoolQualityMetrics`
  // helper as the projection engine's per-period metrics — single source of
  // truth, no parallel-implementation drift.
  // Funded-only filter: currently-unfunded DDTL/revolver positions
  // (parBalance === 0) don't count toward current pool composition.
  // A fully-drawn DDTL (parBalance > 0) IS in the funded set — its
  // facility-type tag is informational, not a funded-state predicate.
  const fundedSwitched = switchedLoans.filter((l) => l.parBalance > 0);
  const qloans = fundedSwitched.map((l) => toQualityMetricLoan(l, resolved.dates.currentDate));
  const switchedQuality = computePoolQualityMetrics(qloans, {
    referenceWAFC: resolved.referenceWeightedAverageFixedCoupon ?? undefined,
    dealCurrency: resolved.currency,
  });
  const switchedTop10 = computeTopNObligorsPct(fundedSwitched, 10);
  const switchedTotalPar = switchedLoans.reduce((s, l) => s + l.parBalance, 0);

  // Unique obligor count (funded + unfunded) — partner may care about obligor
  // count changes even when the switch is within the same obligor.
  const switchedObligors = new Set(
    switchedLoans.map((l) => (l.obligorName ?? "").toLowerCase().trim()).filter((s) => s.length > 0),
  ).size;

  // pctCovLite / pctPik delta-recompute. The deal-level values from
  // poolSummary already carry their own coverage (sourced from the
  // concentrations table or pool-summary directly). We adjust them for the
  // swap ONLY when both swap legs carry the relevant flag — otherwise
  // the post-swap share is ambiguous and we inherit the base value with
  // an explicit coverage warning. This avoids both the silent-inflation
  // failure mode (mapping null → false would deflate the share when
  // per-loan coverage is incomplete) and the silent-deflation failure
  // mode (an unconditional recompute from per-loan flags overwrites the
  // resolver's deal-level signal with a possibly-incomplete pool view).
  //
  // For pctPik the driver is `pikSpreadBps > 0` ("actively accreting PIK"),
  // not `isPik` ("structurally PIK"). Tele Columbus shape (toggle currently
  // off — pikAmount > 0 historical, pikSpreadBps = 0) does NOT count toward
  // pctPik because the metric describes current-period income dynamics,
  // not structural exposure to a re-enabled PIK toggle.
  function deltaRecompute(
    field: "pctCovLite" | "pctPik",
    flagFor: (loan: ResolvedLoan) => boolean | undefined,
  ): number | null {
    const baseValue = resolved.poolSummary[field];
    const sellFlag = flagFor(sellLoan);
    const buyFlag = flagFor(buyLoan);
    if (baseValue == null || sellFlag == null || buyFlag == null) {
      if (warnings != null) {
        warnings.push({
          field: `switched_${field}`,
          message:
            `applySwitch: cannot delta-recompute ${field} — at least one swap leg has unknown ${field} flag ` +
            `(sell="${sellLoan.obligorName ?? "?"}"=${sellFlag}, ` +
            `buy="${buyLoan.obligorName ?? "?"}"=${buyFlag}). ` +
            `Inheriting the base-pool ${field} (${baseValue}); the partner-visible ` +
            `share does not reflect the swap.`,
          severity: "warn",
          blocking: false,
        });
      }
      return baseValue;
    }
    const basePar = (baseValue / 100) * resolved.poolSummary.totalPar;
    const removed = sellFlag === true ? actualSellPar : 0;
    const added = buyFlag === true ? buyLoan.parBalance : 0;
    const newPar = basePar - removed + added;
    return switchedTotalPar > 0 ? (newPar / switchedTotalPar) * 100 : 0;
  }
  const switchedPctCovLite = deltaRecompute("pctCovLite", (l) => l.isCovLite);
  const switchedPctPik = deltaRecompute(
    "pctPik",
    (l) => (l.pikSpreadBps == null ? undefined : l.pikSpreadBps > 0),
  );

  const switchedResolved: ResolvedDealData = {
    ...resolved,
    loans: switchedLoans,
    poolSummary: {
      ...resolved.poolSummary,
      totalPar: resolved.poolSummary.totalPar + parDelta,
      totalPrincipalBalance: switchedTotalPar, // funded+unfunded sum — matches resolver convention
      wacSpreadBps: switchedQuality.wacSpreadBps,
      warf: switchedQuality.warf,
      walYears: switchedQuality.walYears,
      pctCccAndBelow: switchedQuality.pctCccAndBelow,
      pctCovLite: switchedPctCovLite,
      pctPik: switchedPctPik,
      numberOfObligors: switchedObligors,
      top10ObligorsPct: switchedTop10,
      // Other composition fields (pctFixedRate, pctBonds, pctSeniorSecured,
      // pctSecondLien, pctCurrentPay, diversityScore, waRecoveryRate,
      // totalMarketValue, numberOfAssets) are inherited from the base pool
      // via the spread above. They require additional per-loan flags whose
      // extraction-side coverage isn't yet reliable enough for a
      // delta-recompute (see CLAUDE.md anti-pattern #3 — "silent fallbacks
      // on extraction failures are bugs, not defaults").
    },
  };

  const switchedInputs = buildFromResolved(switchedResolved, assumptions, warnings);

  return {
    baseInputs,
    switchedInputs,
    switchedResolved,
    parDelta,
    spreadDelta: buyLoan.spreadBps - sellLoan.spreadBps,
    ratingChange: { from: sellLoan.ratingBucket, to: buyLoan.ratingBucket },
  };
}
