/**
 * Call-sensitivity grid service — post-v6 plan §5.3.
 *
 * Returns a flat list of `{ callDate, callPriceMode, irr }` cells covering
 * the cartesian product of the requested call dates and call-price modes.
 * Each cell is a separate `runProjection` invocation under
 * `callMode: "optionalRedemption"` with the cell's date and price mode.
 *
 * Default callDates derive from the deal's `optionalRedemptionDate` plus
 * annual offsets `[ord, ord+1y, ord+2y, ord+3y]`. The Euro-XV-specific
 * hardcoded dates would be wrong for any deal with a different non-call
 * period; deal-aware default selection generalizes. If
 * `optionalRedemptionDate` is null and the caller did not supply explicit
 * `callDates`, the service throws — there is no defensible default to
 * fall back to without the deal-level non-call date.
 *
 * Default callPriceModes: `["par", "market"]`. Market-mode falls back to
 * the engine's `MarketPriceMissingError` (per-cell error: `irr: null`,
 * `error: "market_price_missing"`) rather than aborting the whole grid —
 * partners need the par column to render even when extraction is partial.
 * Manual mode is intentionally omitted from defaults; supply it explicitly
 * if needed (along with a `callPricePct`).
 */

import { runProjection, addQuarters, MarketPriceMissingError, type ProjectionInputs } from "../projection";

export type CallSensitivityPriceMode = "par" | "market" | "manual";
export type CallSensitivityErrorKind = "market_price_missing";

export interface CallSensitivityCell {
  callDate: string;
  callPriceMode: CallSensitivityPriceMode;
  irr: number | null;
  error: CallSensitivityErrorKind | null;
}

export interface CallSensitivityOptions {
  callDates?: string[];
  callPriceModes?: CallSensitivityPriceMode[];
  callPricePct?: number;
  optionalRedemptionDate?: string | null;
}

function defaultCallDates(ord: string): string[] {
  // Annual offsets via addQuarters(_, 4) — same calendar arithmetic the
  // engine uses for period stepping, so leap-year edge cases line up.
  return [ord, addQuarters(ord, 4), addQuarters(ord, 8), addQuarters(ord, 12)];
}

export function callSensitivityGrid(
  inputs: ProjectionInputs,
  options?: CallSensitivityOptions,
): CallSensitivityCell[] {
  const callDates = options?.callDates
    ?? (() => {
      const ord = options?.optionalRedemptionDate ?? null;
      if (!ord) {
        throw new Error(
          "Cannot derive default callDates without optionalRedemptionDate; supply explicit callDates option.",
        );
      }
      return defaultCallDates(ord);
    })();
  const callPriceModes = options?.callPriceModes ?? ["par" as const, "market" as const];
  const callPricePct = options?.callPricePct ?? 100;

  const cells: CallSensitivityCell[] = [];
  for (const callDate of callDates) {
    for (const mode of callPriceModes) {
      try {
        const result = runProjection({
          ...inputs,
          callMode: "optionalRedemption",
          callDate,
          callPriceMode: mode,
          callPricePct,
        });
        cells.push({ callDate, callPriceMode: mode, irr: result.equityIrr, error: null });
      } catch (e) {
        if (e instanceof MarketPriceMissingError) {
          cells.push({ callDate, callPriceMode: mode, irr: null, error: "market_price_missing" });
        } else {
          throw e;
        }
      }
    }
  }
  return cells;
}
