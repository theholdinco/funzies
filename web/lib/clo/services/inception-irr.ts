/**
 * Inception-IRR service.
 *
 * Composes engine output (forward projection terminal value, forward equity
 * distributions) + non-engine data (historical trustee distributions) +
 * user-provided inputs (purchase date, entry price). Pure function so
 * downstream surfaces (PDF export, partner deck, chat assistant) can consume
 * identical numbers.
 *
 * Three IRR modes per anchor (post-v6 plan §3.2):
 *
 *  - **Realized** — historical cashflows received only, no terminal mark.
 *    Backward-looking. Answers: "what return have I actually earned so far?"
 *
 *  - **Mark-to-book** — historical cashflows + terminal at equityBookValue.
 *    Hypothetical "called at book today" exit. Answers: "what return would
 *    I lock in if the deal liquidated at book value right now?"
 *
 *  - **Mark-to-model** — historical cashflows + forward-projected equity
 *    distributions through maturity. Forward-looking with engine assumptions.
 *    Answers: "what return does the model project if I hold to maturity?"
 *    Date alignment per §3.2: realized series ends at last historical
 *    distribution; forward series starts at first scheduled payment date
 *    strictly after currentDate; gap contributes implicit zero.
 *
 * Default semantics: anchor at the deal's closing date with cost basis at
 * par (100c × subNotePar), use historical trustee distributions filtered to
 * the anchor window.
 *
 * Override semantics: when the user explicitly enters a purchase date AND
 * price, anchor there instead. Distributions before the override anchor are
 * filtered out (a secondary buyer didn't earn them).
 *
 * Counterfactual: when the user override differs from default (closing+100c),
 * surface a second anchor's IRRs so partners can read secondary-buyer return
 * vs original-investor return at a glance.
 *
 * Wiped-out semantics: when input.equityWipedOut is true, the deal is
 * balance-sheet insolvent at t=0; equityBookValue is 0. Mark-to-book is null;
 * mark-to-model status is "wiped_out". Realized is unaffected (already-
 * received distributions remain valid).
 *
 * Inverse-case (input data future-dated past currentDate): throws explicit
 * error rather than silently mixing stale/future series.
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
  /** Mirrors `result.initialState.equityWipedOut`. When true, mark-to-book
   *  is null and mark-to-model status is "wiped_out". Realized is unaffected. */
  equityWipedOut: boolean;
  /** Deal closing date — used as the default anchor when user override
   *  is absent. Null/empty disables the default-anchor path. */
  closingDate: string | null;
  /** Determination date — terminal date for mark-to-book; boundary between
   *  realized and forward streams for mark-to-model. */
  currentDate: string;
  /** User-provided purchase date + price (cents on the dollar of subNotePar).
   *  Null when the user hasn't entered an override. */
  userAnchor: { date: string; priceCents: number } | null;
  /** Historical trustee distributions, in date order. Filtered per anchor. */
  historicalDistributions: ReadonlyArray<{ date: string; distribution: number }>;
  /** Forward equity distributions from engine projection. Each entry's date
   *  must be strictly after currentDate. Pass null to skip mark-to-model
   *  computation (e.g., when the engine result isn't available). When the
   *  array is empty (deal at maturity, no future flows), mark-to-model
   *  computes from realized + zero forward. */
  forwardDistributions: ReadonlyArray<{ date: string; amount: number }> | null;
}

export type MarkToModelStatus =
  | "computed"
  | "no_forward_data"
  | "no_realized_data"
  | "wiped_out";

export interface InceptionIrrAnchor {
  /** Mark-to-book IRR (formerly the only mode; kept for backwards-compat
   *  callers until the UI swaps in the explicit field names). */
  irr: number | null;
  /** Realized IRR — historical cashflows only, no terminal mark. Null when
   *  there are no realized distributions in the anchor window. */
  realizedIrr: number | null;
  /** Mark-to-book IRR — historical cashflows + terminal at equityBookValue. */
  markToBookIrr: number | null;
  /** Mark-to-model IRR — historical + forward-projected distributions. */
  markToModelIrr: number | null;
  /** Why mark-to-model was/wasn't computed. UI labels accordingly. */
  markToModelStatus: MarkToModelStatus;
  anchorDate: string;
  anchorPriceCents: number;
  /** Count of realized distributions in (anchor, currentDate). */
  distributionCount: number;
  /** Count of forward distributions used in mark-to-model. Zero when
   *  forwardDistributions is null/empty or status != "computed". */
  forwardDistributionCount: number;
}

export interface InceptionIrrResult {
  primary: InceptionIrrAnchor & { isUserOverride: boolean };
  /** Set when the user override differs from default (closing+100c).
   *  Null when there's no user override OR default == override. */
  counterfactual: InceptionIrrAnchor | null;
  terminalValue: number;
  terminalDate: string;
  /** Mirrors input.equityWipedOut. UI uses this to decide whether to
   *  render the mark-to-book IRR or the insolvent-deal label. */
  wipedOut: boolean;
}

export function computeInceptionIrr(input: InceptionIrrInput): InceptionIrrResult | null {
  if (input.subNotePar <= 0) return null;

  const terminalDate = input.currentDate;
  const terminalValue = input.equityBookValue;

  // Inverse-case guard: any historical distribution dated after currentDate
  // would silently corrupt the mark-to-model series (realized stream past
  // the boundary that forward distributions are supposed to start from).
  // Throw rather than coerce — the data is wrong upstream.
  for (const d of input.historicalDistributions) {
    if (d.date > terminalDate) {
      throw new Error(
        `Mark-to-model: historical distribution dated ${d.date} is after currentDate ${terminalDate}. ` +
          `Refusing to build a mixed realized/forward series with future-dated realized data.`,
      );
    }
  }
  // Forward distributions must all be strictly after currentDate.
  if (input.forwardDistributions) {
    for (const d of input.forwardDistributions) {
      if (d.date <= terminalDate) {
        throw new Error(
          `Mark-to-model: forward distribution dated ${d.date} is not after currentDate ${terminalDate}. ` +
            `Forward stream must start strictly after the realized boundary.`,
        );
      }
    }
  }

  const userAnchorDate = input.userAnchor?.date ?? null;
  const userAnchorCents = input.userAnchor?.priceCents ?? null;
  const hasUserOverride = userAnchorDate != null && userAnchorCents != null;
  const primaryAnchor = userAnchorDate ?? input.closingDate;
  const primaryCents = userAnchorCents ?? 100;
  if (!primaryAnchor) return null;

  const computeAt = (anchorDate: string, anchorPriceCents: number): InceptionIrrAnchor | null => {
    const purchasePrice = input.subNotePar * (anchorPriceCents / 100);
    if (purchasePrice <= 0) return null;

    const realizedDists = input.historicalDistributions
      .filter((d) => d.date > anchorDate && d.date < terminalDate && Number.isFinite(d.distribution))
      .map((d) => ({ date: d.date, amount: d.distribution }));

    // Realized: cost basis + realized distributions, no terminal.
    // calculateIrrFromDatedCashflows requires at least one positive and one
    // negative flow; with zero realized distributions the series is just
    // [-purchase], which has no defined IRR → null.
    const realizedIrr =
      realizedDists.length > 0
        ? calculateIrrFromDatedCashflows([
            { date: anchorDate, amount: -purchasePrice },
            ...realizedDists,
          ])
        : null;

    // Mark-to-book: cost basis + realized + terminal at equityBookValue.
    const markToBookIrr = input.equityWipedOut
      ? null
      : calculateIrrFromDatedCashflows([
          { date: anchorDate, amount: -purchasePrice },
          ...realizedDists,
          { date: terminalDate, amount: terminalValue },
        ]);

    // Mark-to-model: cost basis + realized + forward-projected distributions
    // (no terminal — forward stream extends through maturity, terminal value
    // embedded in the final period's distribution).
    const forwardDists = input.forwardDistributions
      ? input.forwardDistributions
          .filter((d) => Number.isFinite(d.amount))
          .map((d) => ({ date: d.date, amount: d.amount }))
      : [];

    let markToModelIrr: number | null;
    let markToModelStatus: MarkToModelStatus;

    if (input.equityWipedOut) {
      markToModelIrr = null;
      markToModelStatus = "wiped_out";
    } else if (input.forwardDistributions === null) {
      markToModelIrr = null;
      markToModelStatus = "no_forward_data";
    } else if (realizedDists.length === 0) {
      // Forward-only series: cost basis + forward distributions. Status
      // distinguishes this from the with-realized path so the UI can label.
      markToModelIrr =
        forwardDists.length > 0
          ? calculateIrrFromDatedCashflows([
              { date: anchorDate, amount: -purchasePrice },
              ...forwardDists,
            ])
          : null;
      markToModelStatus = "no_realized_data";
    } else {
      markToModelIrr = calculateIrrFromDatedCashflows([
        { date: anchorDate, amount: -purchasePrice },
        ...realizedDists,
        ...forwardDists,
      ]);
      markToModelStatus = "computed";
    }

    return {
      irr: markToBookIrr,
      realizedIrr,
      markToBookIrr,
      markToModelIrr,
      markToModelStatus,
      anchorDate,
      anchorPriceCents,
      distributionCount: realizedDists.length,
      forwardDistributionCount: markToModelStatus === "computed" || markToModelStatus === "no_realized_data"
        ? forwardDists.length
        : 0,
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
