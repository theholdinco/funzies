/**
 * A3 — Call liquidation at per-position market value.
 *
 * Post-v6 plan §4.1: callPriceMode taxonomy is "par" | "market" | "manual".
 *   - 'par': every position at face value
 *   - 'market': every position at observed currentPrice; throws when missing
 *   - 'manual': every position at callPricePct (flat % of par)
 *
 * Earlier "multiplier"/"flat" enum was renamed; the prior multiplier-with-100c
 * is now `market`, prior flat-with-X is now `manual`. Multiplier-with-haircut
 * is no longer expressible — that's a deliberate scope reduction (see plan).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCallLiquidation, MarketPriceMissingError, runProjection } from "@/lib/clo/projection";
import { buildFromResolved, DEFAULT_ASSUMPTIONS } from "@/lib/clo/build-projection-inputs";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
};

describe("A3 — computeCallLiquidation (pure helper)", () => {
  it("market mode → sum of (par × currentPrice/100); callPricePct ignored", () => {
    const loans = [
      { survivingPar: 100, currentPrice: 95 },
      { survivingPar: 200, currentPrice: 98 },
      { survivingPar: 300, currentPrice: 100 },
    ];
    // 100×0.95 + 200×0.98 + 300×1.00 = 591
    expect(computeCallLiquidation(loans, 100, "market")).toBeCloseTo(591, 6);
    // callPricePct is ignored in market mode — same total at 50, 95, etc.
    expect(computeCallLiquidation(loans, 50, "market")).toBeCloseTo(591, 6);
    expect(computeCallLiquidation(loans, 999, "market")).toBeCloseTo(591, 6);
  });

  it("market mode throws when any non-DDTL position lacks currentPrice", () => {
    const loans = [
      { survivingPar: 100, currentPrice: 95 },
      { survivingPar: 50 }, // no currentPrice
    ];
    expect(() => computeCallLiquidation(loans, 100, "market")).toThrow(MarketPriceMissingError);
    try {
      computeCallLiquidation(loans, 100, "market");
    } catch (e) {
      expect((e as MarketPriceMissingError).kind).toBe("market_price_missing");
    }
  });

  it("manual mode → every position at callPricePct flat, regardless of market", () => {
    const loans = [
      { survivingPar: 100, currentPrice: 80 },
      { survivingPar: 200, currentPrice: 100 },
    ];
    // (100 + 200) × 0.98 = 294
    expect(computeCallLiquidation(loans, 98, "manual")).toBeCloseTo(294, 6);
  });

  it("par mode → every position at face value (callPricePct ignored)", () => {
    const loans = [
      { survivingPar: 100, currentPrice: 80 },
      { survivingPar: 200, currentPrice: 100 },
    ];
    // 100 + 200 = 300 (face)
    expect(computeCallLiquidation(loans, 0, "par")).toBeCloseTo(300, 6);
    expect(computeCallLiquidation(loans, 95, "par")).toBeCloseTo(300, 6);
  });

  it("par mode tolerates missing currentPrice (no need to observe)", () => {
    const loans = [
      { survivingPar: 100, currentPrice: 95 },
      { survivingPar: 50 }, // unpriced — par mode ignores anyway
      { survivingPar: 200, currentPrice: null },
    ];
    expect(computeCallLiquidation(loans, 100, "par")).toBeCloseTo(350, 6);
  });

  it("skips unfunded DDTL positions across all modes", () => {
    const loans = [
      { survivingPar: 100, currentPrice: 95 },
      { survivingPar: 50, currentPrice: 100, isDelayedDraw: true },
      { survivingPar: 200, currentPrice: 100 },
    ];
    expect(computeCallLiquidation(loans, 100, "market")).toBeCloseTo(295, 6); // 95 + 200
    expect(computeCallLiquidation(loans, 100, "par")).toBeCloseTo(300, 6); // 100 + 200
    expect(computeCallLiquidation(loans, 95, "manual")).toBeCloseTo(285, 6); // (100 + 200) × 0.95
  });

  it("zero/negative-par positions contribute nothing", () => {
    const loans = [
      { survivingPar: 100, currentPrice: 95 },
      { survivingPar: 0, currentPrice: 50 },
      { survivingPar: -1, currentPrice: 50 },
    ];
    expect(computeCallLiquidation(loans, 100, "market")).toBeCloseTo(95, 6);
  });

  it("empty pool → 0 (no crash, no throw even in market mode)", () => {
    expect(computeCallLiquidation([], 100, "market")).toBe(0);
    expect(computeCallLiquidation([], 98, "manual")).toBe(0);
    expect(computeCallLiquidation([], 0, "par")).toBe(0);
  });
});

describe("A3 — integration: Euro XV call at MtM vs at par", () => {
  // Euro XV sub note par = €44.8M; pool par €491.4M; pool MtM ≈ €467.9M.
  // Call at market uses per-position currentPrice → liquidation ≈ €467.9M.
  // Call at par treats every position at 100c → liquidation = €491.4M.
  // The ~€23.5M difference flows through the waterfall; equity (sub note) is
  // the residual bucket so most of the swing hits totalEquityDistributions.

  const callDate = "2026-07-15"; // one quarter out
  const assumptionsMarket = {
    ...DEFAULT_ASSUMPTIONS,
    callMode: "optionalRedemption" as const,
    callDate,
    callPricePct: 100,
    callPriceMode: "market" as const,
  };
  const assumptionsPar = {
    ...DEFAULT_ASSUMPTIONS,
    callMode: "optionalRedemption" as const,
    callDate,
    callPricePct: 100,
    callPriceMode: "par" as const,
  };

  it("call at MtM yields LESS equity than call at par (pool trades below par)", () => {
    const resultMarket = runProjection(buildFromResolved(fixture.resolved, assumptionsMarket));
    const resultPar = runProjection(buildFromResolved(fixture.resolved, assumptionsPar));
    expect(resultMarket.totalEquityDistributions).toBeLessThan(resultPar.totalEquityDistributions);
  });

  it("par − market equity delta ≈ €23.98M (empirical anchor)", () => {
    // Empirical measurement: Euro XV at callDate=2026-07-15, default other
    // assumptions. The raw pool par-vs-MtM gap is ~€23.5M (€491.4M − €467.9M),
    // and the engine's equity-side delta ends up slightly higher at €23.98M
    // — the difference flows partly through incentive-fee mechanics before
    // settling as residual equity. Anchoring to the measured value pins both
    // the direction AND the magnitude; ±€50k tolerance is tight enough to
    // catch material changes to either the liquidation math or the
    // downstream waterfall flow.
    const resultMarket = runProjection(buildFromResolved(fixture.resolved, assumptionsMarket));
    const resultPar = runProjection(buildFromResolved(fixture.resolved, assumptionsPar));
    const equityGap = resultPar.totalEquityDistributions - resultMarket.totalEquityDistributions;
    expect(equityGap).toBeCloseTo(23_979_615.50, -5);
  });
});

describe("A3 — callMode gate (post-v6 plan §4.1)", () => {
  // callMode === "none" should ignore callDate entirely.
  const baseAssumptions = {
    ...DEFAULT_ASSUMPTIONS,
    callDate: "2026-07-15",
  };

  it("callMode='none' produces same result as no callDate at all", () => {
    const callNone = runProjection(
      buildFromResolved(fixture.resolved, { ...baseAssumptions, callMode: "none", callPriceMode: "par" }),
    );
    const callNullDate = runProjection(
      buildFromResolved(fixture.resolved, {
        ...DEFAULT_ASSUMPTIONS,
        callMode: "none",
        callDate: null,
        callPriceMode: "par",
      }),
    );
    // Same projection horizon and same equity result.
    expect(callNone.periods.length).toBe(callNullDate.periods.length);
    expect(callNone.equityIrr).toBeCloseTo(callNullDate.equityIrr ?? -Infinity, 6);
  });

  it("callMode='optionalRedemption' with par mode produces shorter projection than no-call", () => {
    const noCall = runProjection(
      buildFromResolved(fixture.resolved, { ...DEFAULT_ASSUMPTIONS, callMode: "none", callPriceMode: "par" }),
    );
    const withCall = runProjection(
      buildFromResolved(fixture.resolved, {
        ...baseAssumptions,
        callMode: "optionalRedemption",
        callPriceMode: "par",
      }),
    );
    expect(withCall.periods.length).toBeLessThan(noCall.periods.length);
  });
});
