/**
 * CDR sample-path optional fn — post-v6 plan §7.5.
 *
 * `cdrMultiplierPathFn?: (q: number) => Record<string, number>` is a
 * backwards-compatible API addition: when absent, the engine uses the
 * constant `defaultRatesByRating` for every quarter (existing behavior);
 * when present, it's called once per quarter (1-indexed) to obtain that
 * period's overrides.
 *
 * Naming: the legacy bucket-hazard branch reads the returned map as an
 * absolute-CDR override; the production per-position WARF branch reads
 * it as a per-bucket multiplier against `defaultRatesByRating`. The
 * `Multiplier` infix surfaces the dominant production-branch semantics
 * — see `ProjectionInputs.cdrMultiplierPathFn` JSDoc for both branches.
 *
 * The path fn is the breakage-free alternative to the original
 * `Record<bucket, pct[]>` proposal — same modeling power, no fixture
 * migration cost. MC callers supply a path that draws from a calibrated
 * distribution; deterministic callers can hard-code a stress curve.
 */

import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

describe("CDR sample-path fn (post-v6 plan §7.5)", () => {
  it("absent cdrMultiplierPathFn → byte-identical output to baseline (no behavior change)", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const baseline = runProjection(inputs);
    const explicit = runProjection({ ...inputs, cdrMultiplierPathFn: undefined });
    expect(explicit.equityIrr).toBe(baseline.equityIrr);
    expect(explicit.totalEquityDistributions).toBeCloseTo(baseline.totalEquityDistributions, 2);
    expect(explicit.periods.length).toBe(baseline.periods.length);
  });

  it("constant path fn (returns same map every quarter) ≡ baseline", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const baseline = runProjection(inputs);
    const constantPath = runProjection({
      ...inputs,
      cdrMultiplierPathFn: () => uniformRates(2),
    });
    // Same equity IRR; the constant path is the trivial case of the time-
    // varying API and must collapse to the constant-CDR projection.
    expect(constantPath.equityIrr).toBe(baseline.equityIrr);
  });

  it("time-varying path produces different defaults than constant path", () => {
    // Stress curve: 0% defaults for 4 quarters, then 10% for the rest.
    // Should produce fewer cumulative defaults early and more later than a
    // flat 5% path.
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(5),
      cprPct: 0,
    });
    const flat = runProjection(inputs);
    const stressed = runProjection({
      ...inputs,
      cdrMultiplierPathFn: (q) => uniformRates(q <= 4 ? 0 : 10),
    });
    // Period 1 stressed defaults < period 1 flat defaults (0% vs 5%).
    expect(stressed.periods[0].defaults).toBeLessThan(flat.periods[0].defaults);
    // Period 5 stressed defaults > period 5 flat defaults (10% vs 5%).
    if (stressed.periods.length >= 5 && flat.periods.length >= 5) {
      expect(stressed.periods[4].defaults).toBeGreaterThan(flat.periods[4].defaults);
    }
  });

  it("path fn is called with quarter index q (1-indexed)", () => {
    const observed: number[] = [];
    runProjection({
      ...makeInputs({
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
      cdrMultiplierPathFn: (q) => {
        observed.push(q);
        return uniformRates(2);
      },
    });
    expect(observed[0]).toBe(1);
    expect(observed.every((q, i) => q === i + 1)).toBe(true);
  });

  // §7.5 + decision R: production-config regression. The original
  // cdrMultiplierPathFn ship was decorative for production runs because
  // tests inherited `useLegacyBucketHazard: true` from `makeInputs`,
  // while production uses the per-position WARF branch. These tests run
  // with `useLegacyBucketHazard: false` to verify cdrMultiplierPathFn
  // affects defaults produced via `warfFactorToQuarterlyHazard`.
  describe("production-config (useLegacyBucketHazard: false + warfFactor)", () => {
    it("cdrMultiplierPathFn changes total defaults under WARF path (not just legacy bucket-map)", () => {
      const baseInputs = makeInputs({
        useLegacyBucketHazard: false,
        defaultRatesByRating: uniformRates(2),
        cprPct: 0, // isolate defaults from prepayments
      });
      const constant = runProjection(baseInputs);
      const stressed = runProjection({
        ...baseInputs,
        cdrMultiplierPathFn: (q) => uniformRates(q <= 4 ? 0 : 10), // 0% Y1, 10% thereafter
      });
      const constantTotal = constant.periods.reduce((s, p) => s + p.defaults, 0);
      const stressedTotal = stressed.periods.reduce((s, p) => s + p.defaults, 0);
      // Stressed scenario hits 5x the bucket-map baseline after Y1 → total
      // defaults must exceed the constant-2% baseline meaningfully.
      expect(stressedTotal).toBeGreaterThan(constantTotal * 1.5);
    });

    it("constant cdrMultiplierPathFn under WARF path ≡ baseline (multiplier = 1)", () => {
      // Sanity: a constant path that returns the same defaultRatesByRating
      // every quarter should be a no-op (multiplier = 1.0).
      const baseInputs = makeInputs({
        useLegacyBucketHazard: false,
        defaultRatesByRating: uniformRates(2),
        cprPct: 0,
      });
      const baseline = runProjection(baseInputs);
      const noOpPath = runProjection({
        ...baseInputs,
        cdrMultiplierPathFn: () => uniformRates(2),
      });
      expect(noOpPath.equityIrr).toBe(baseline.equityIrr);
      expect(noOpPath.totalEquityDistributions).toBeCloseTo(baseline.totalEquityDistributions, 2);
    });

    it("path with zero baseline + non-zero stress falls back to bucket-map hazard", () => {
      // Edge case: defaultRatesByRating[bucket] = 0 but path returns >0.
      // Multiplier is undefined; engine falls back to bucket-map hazard
      // for that loan (matches the bucket-map branch's path semantic).
      const baseInputs = makeInputs({
        useLegacyBucketHazard: false,
        defaultRatesByRating: uniformRates(0), // zero baseline
        cprPct: 0,
      });
      const stressed = runProjection({
        ...baseInputs,
        cdrMultiplierPathFn: () => uniformRates(5), // 5% override
      });
      // With zero baseline + 5% path, every period should have non-zero defaults.
      const total = stressed.periods.reduce((s, p) => s + p.defaults, 0);
      expect(total).toBeGreaterThan(0);
    });
  });
});
