/**
 * Entry-price-vs-IRR sweep service — post-v6 plan §5.1.
 *
 * For each entry price (in cents of subNotePar) sets `equityEntryPrice` and
 * runs the engine; returns the resulting forward equity IRR. Pure function;
 * one engine run per price.
 *
 * Forward IRR is monotonically decreasing in entry price (higher purchase
 * price → larger initial outflow → lower IRR for fixed projected cashflows),
 * which the test suite asserts to catch regressions.
 *
 * Wiped-out deals (totalDebt > totalAssets at t=0) return null IRRs across
 * the whole sweep; callers should already gate on `equityWipedOut` before
 * presenting the curve, but the service does not throw — it lets the engine
 * decide per-price.
 */

import { runProjection, type ProjectionInputs } from "../projection";

export interface EntryPriceSweepPoint {
  priceCents: number;
  irr: number | null;
}

export function sweepEntryPrice(
  inputs: ProjectionInputs,
  prices: number[],
  subNotePar: number,
): EntryPriceSweepPoint[] {
  if (subNotePar <= 0) {
    return prices.map((p) => ({ priceCents: p, irr: null }));
  }
  return prices.map((priceCents) => {
    const equityEntryPrice = subNotePar * (priceCents / 100);
    const result = runProjection({ ...inputs, equityEntryPrice });
    return { priceCents, irr: result.equityIrr };
  });
}
