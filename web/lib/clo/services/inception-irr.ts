/**
 * Inception-IRR service.
 *
 * Composes engine output (forward projection terminal value) + non-engine
 * data (historical trustee distributions) + user-provided inputs (purchase
 * date, entry price). Pure function so downstream surfaces (PDF export,
 * partner deck, chat assistant) can consume identical numbers.
 *
 * Default semantics: anchor at the deal's closing date with cost basis at
 * par (100c × subNotePar), use historical trustee distributions filtered to
 * the anchor window, and place the terminal book value at the current
 * determination date.
 *
 * Override semantics: when the user explicitly enters a purchase date AND
 * price (via the inception form), anchor there instead of the closing
 * date. Distributions before the override anchor are filtered out (a
 * secondary buyer didn't earn them).
 *
 * Counterfactual: when the user override differs from default (closing+100c),
 * also surface "what the IRR would be at the original-investor anchor" so
 * partners can read secondary-buyer return vs original-investor return at
 * a glance.
 *
 * Wiped-out semantics: when input.equityWipedOut is true, the deal is
 * balance-sheet insolvent at t=0; equityBookValue is 0. The computed IRR
 * is null and the result carries `wipedOut: true` so the UI can label the
 * state explicitly rather than show "N/A".
 *
 * See CLAUDE.md § Engine ↔ UI separation.
 */

import { calculateIrrFromDatedCashflows } from "../projection";

export interface InceptionIrrInput {
  /** Sub-note original par (face). Must be > 0; returns null otherwise. */
  subNotePar: number;
  /** Forward-looking equity book value at the terminal date.
   *  Sourced from `result.initialState.equityBookValue` — single canonical
   *  source. UI must NOT recompute this. */
  equityBookValue: number;
  /** Mirrors `result.initialState.equityWipedOut`. When true, the IRR is
   *  null regardless of inputs and the result's `wipedOut` flag is set. */
  equityWipedOut: boolean;
  /** Deal closing date — used as the default anchor when user override
   *  is absent. Null/empty disables the default-anchor path. */
  closingDate: string | null;
  /** Determination date — terminal date for the cashflow series. */
  currentDate: string;
  /** User-provided purchase date + price (cents on the dollar of subNotePar).
   *  Null when the user hasn't entered an override. */
  userAnchor: { date: string; priceCents: number } | null;
  /** Historical trustee distributions, in date order. The function filters
   *  to those strictly between the anchor and current date. */
  historicalDistributions: ReadonlyArray<{ date: string; distribution: number }>;
}

export interface InceptionIrrAnchor {
  irr: number | null;
  anchorDate: string;
  anchorPriceCents: number;
  distributionCount: number;
}

export interface InceptionIrrResult {
  primary: InceptionIrrAnchor & { isUserOverride: boolean };
  /** Set when the user override differs from default (closing+100c).
   *  Null when there's no user override OR default == override. */
  counterfactual: InceptionIrrAnchor | null;
  terminalValue: number;
  terminalDate: string;
  /** Mirrors input.equityWipedOut. UI uses this to decide whether to
   *  render the IRR card or a "deal is balance-sheet insolvent" label. */
  wipedOut: boolean;
}

export function computeInceptionIrr(input: InceptionIrrInput): InceptionIrrResult | null {
  if (input.subNotePar <= 0) return null;

  const terminalDate = input.currentDate;
  const terminalValue = input.equityBookValue;

  const userAnchorDate = input.userAnchor?.date ?? null;
  const userAnchorCents = input.userAnchor?.priceCents ?? null;
  const hasUserOverride = userAnchorDate != null && userAnchorCents != null;
  const primaryAnchor = userAnchorDate ?? input.closingDate;
  const primaryCents = userAnchorCents ?? 100;
  if (!primaryAnchor) return null;

  const computeAt = (anchorDate: string, anchorPriceCents: number): InceptionIrrAnchor | null => {
    const purchasePrice = input.subNotePar * (anchorPriceCents / 100);
    if (purchasePrice <= 0) return null;
    const dists = input.historicalDistributions
      .filter((d) => d.date > anchorDate && d.date < terminalDate && Number.isFinite(d.distribution))
      .map((d) => ({ date: d.date, amount: d.distribution }));
    const flows: Array<{ date: string; amount: number }> = [
      { date: anchorDate, amount: -purchasePrice },
      ...dists,
      { date: terminalDate, amount: terminalValue },
    ];
    return {
      irr: input.equityWipedOut ? null : calculateIrrFromDatedCashflows(flows),
      anchorDate,
      anchorPriceCents,
      distributionCount: dists.length,
    };
  };

  const primary = computeAt(primaryAnchor, primaryCents);
  if (!primary) return null;

  // Counterfactual: only render when (a) user override is set AND (b)
  // we have a closingDate to anchor the default. Skip when both anchors
  // would be identical (override == closing date at par).
  let counterfactual: InceptionIrrAnchor | null = null;
  if (
    hasUserOverride &&
    input.closingDate &&
    (input.closingDate !== primaryAnchor || primaryCents !== 100)
  ) {
    counterfactual = computeAt(input.closingDate, 100);
  }

  return {
    primary: { ...primary, isUserOverride: hasUserOverride },
    counterfactual,
    terminalValue,
    terminalDate,
    wipedOut: input.equityWipedOut,
  };
}
