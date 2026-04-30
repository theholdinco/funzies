/**
 * Entry-price-vs-IRR sweep — post-v6 plan §5.1.
 *
 * Service contract: per-price `runProjection` invocation; result.equityIrr
 * captured as the IRR for that price. Forward IRR is monotonically
 * decreasing in entry price (higher purchase price → lower IRR for fixed
 * projected cashflows). The monotonicity assertion is the load-bearing
 * regression test — if it ever flips, either the service is wrong or the
 * engine has lost monotonicity (which would itself be a P0 bug).
 */

import { describe, it, expect } from "vitest";
import { sweepEntryPrice } from "../services/entry-price-sweep";
import { runProjection } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

describe("Entry-price-vs-IRR sweep (post-v6 plan §5.1)", () => {
  it("returns one row per requested price, in order", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const prices = [25, 50, 75, 100];
    const result = sweepEntryPrice(inputs, prices, 20_000_000);
    expect(result).toHaveLength(prices.length);
    result.forEach((row, i) => {
      expect(row.priceCents).toBe(prices[i]);
    });
  });

  it("forward IRR is monotonically decreasing in entry price", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const prices = [25, 35, 45, 55, 65, 75, 85, 95];
    const result = sweepEntryPrice(inputs, prices, 20_000_000);

    for (let i = 0; i < result.length - 1; i++) {
      const a = result[i].irr;
      const b = result[i + 1].irr;
      // Both IRRs must be finite for the comparison to be meaningful; if a
      // healthy deal returns null somewhere mid-sweep we want to fail loudly.
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!).toBeGreaterThan(b!);
    }
  });

  it("returns all-null IRRs when subNotePar is zero (degenerate deal)", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = sweepEntryPrice(inputs, [50, 100], 0);
    expect(result.every((r) => r.irr === null)).toBe(true);
  });

  it("empty price list produces empty result (no-op)", () => {
    const inputs = makeInputs({ defaultRatesByRating: uniformRates(2) });
    expect(sweepEntryPrice(inputs, [], 20_000_000)).toEqual([]);
  });

  it("matches direct runProjection at each sample price", () => {
    // Sanity check: service should return the same IRR as a direct engine
    // run with equivalent equityEntryPrice. Catches surprising defaults.
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const subNotePar = 20_000_000;
    const prices = [50, 100];
    const swept = sweepEntryPrice(inputs, prices, subNotePar);
    for (const row of swept) {
      const direct = runProjection({
        ...inputs,
        equityEntryPrice: subNotePar * (row.priceCents / 100),
      });
      expect(row.irr).toBe(direct.equityIrr);
    }
  });
});
