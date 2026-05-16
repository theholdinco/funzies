/**
 * Equity-distribution concentration profile (service layer).
 *
 * The headline `result.totalEquityDistributions` metric obscures a real
 * partner-facing risk: under OC stress (esp. junior OC cure cascades) the
 * engine correctly diverts interest proceeds to senior paydown, starving
 * equity in later periods. A €12.17M total can mean "€2M/quarter for 6
 * years" or "€10M in first 2 years then near-zero for 8 years" — those
 * have very different IRR profiles.
 *
 * This service computes a concentration summary so the UI can surface
 * a warning when distributions are front-loaded. Pure function over
 * engine output — no user inputs, no external data.
 */

import type { ProjectionResult } from "../projection";

export interface EquityDistributionProfile {
  /** Total equity over all periods (mirrors `result.totalEquityDistributions`). */
  total: number;
  /** Number of projection periods (mirrors `result.periods.length`). */
  periodCount: number;
  /** First-half cutoff: floor(periodCount / 2). */
  halfPeriodCount: number;
  /** Σ equity distribution over the first `halfPeriodCount` periods. */
  firstHalfTotal: number;
  /** firstHalfTotal / total, in [0, 1]. NaN when total === 0. */
  firstHalfPct: number;
  /** Index of the last period with `equityDistribution > threshold`. -1 when no
   *  period meets the threshold (equity zero throughout). */
  lastPositivePeriodIndex: number;
  /** ISO date of the last positive period; null when lastPositivePeriodIndex < 0. */
  lastPositivePeriodDate: string | null;
  /** True when the concentration metric exceeds the partner-warning threshold
   *  (default: >70% of distributions land in the first half of the projection).
   *  Used by the UI to decide whether to show the sub-label warning. */
  isFrontLoaded: boolean;
}

/** Equity per period below this absolute € threshold counts as "not positive"
 *  for the last-positive-period calculation. Set at €1,000 to filter rounding
 *  / day-count residuals while catching any economically meaningful
 *  distribution. Not a partner-facing knob. */
const POSITIVE_EQUITY_THRESHOLD_EUR = 1_000;

/** Front-loaded threshold: when more than this fraction of total equity lands
 *  in the first half of the projection, the UI raises a warning sub-label.
 *  Picked at 0.70 as a reasonable line for "back half is materially starved";
 *  a healthy CLO without OC stress typically has the first half at 40–60%
 *  (declining pool means later periods naturally generate less equity, but
 *  not a step-function). Not a partner-facing knob. */
const FRONT_LOADED_THRESHOLD = 0.70;

export function computeEquityDistributionProfile(
  result: ProjectionResult,
): EquityDistributionProfile {
  const total = result.totalEquityDistributions;
  const periodCount = result.periods.length;
  const halfPeriodCount = Math.floor(periodCount / 2);

  let firstHalfTotal = 0;
  for (let i = 0; i < halfPeriodCount; i++) {
    firstHalfTotal += result.periods[i].equityDistribution;
  }

  const firstHalfPct = total > 0 ? firstHalfTotal / total : NaN;

  let lastPositivePeriodIndex = -1;
  for (let i = periodCount - 1; i >= 0; i--) {
    if (result.periods[i].equityDistribution > POSITIVE_EQUITY_THRESHOLD_EUR) {
      lastPositivePeriodIndex = i;
      break;
    }
  }
  const lastPositivePeriodDate =
    lastPositivePeriodIndex >= 0
      ? result.periods[lastPositivePeriodIndex].date
      : null;

  const isFrontLoaded =
    total > 0 &&
    firstHalfPct > FRONT_LOADED_THRESHOLD;

  return {
    total,
    periodCount,
    halfPeriodCount,
    firstHalfTotal,
    firstHalfPct,
    lastPositivePeriodIndex,
    lastPositivePeriodDate,
    isFrontLoaded,
  };
}
