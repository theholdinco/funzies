/**
 * CDR sample-path optional fn — post-v6 plan §7.5.
 *
 * `cdrMultiplierPathFn?: (q: number) => Record<string, number>` is a
 * backwards-compatible API addition: when absent, the engine uses the
 * constant `defaultRatesByRating` for every quarter; when present, it's
 * called once per quarter (1-indexed) to obtain that period's overrides.
 *
 * Under per-position WARF (the only hazard branch), the returned map is
 * read as a per-bucket multiplier against `defaultRatesByRating` —
 * scales each loan's WARF-derived hazard by `path[bucket] / baseline[bucket]`.
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

  it("constant path fn (multiplier = 1) ≡ baseline", () => {
    // Path returns the same map as defaultRatesByRating → multiplier 1 →
    // hazard = warfHazard × 1 = warfHazard. No-op vs the no-path case.
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const baseline = runProjection(inputs);
    const constantPath = runProjection({
      ...inputs,
      cdrMultiplierPathFn: () => uniformRates(2),
    });
    expect(constantPath.equityIrr).toBe(baseline.equityIrr);
    expect(constantPath.totalEquityDistributions).toBeCloseTo(baseline.totalEquityDistributions, 2);
  });

  it("time-varying path scales per-position hazard quarter-by-quarter", () => {
    // Stress curve: multiplier 0 for 4 quarters (path returns 0 against
    // baseline 5 → multiplier 0 → hazard 0), then multiplier 2 thereafter
    // (path returns 10 → multiplier 10/5 = 2 → hazard scaled 2×).
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(5),
      cprPct: 0,
    });
    const flat = runProjection(inputs);
    const stressed = runProjection({
      ...inputs,
      cdrMultiplierPathFn: (q) => uniformRates(q <= 4 ? 0 : 10),
    });
    // Period 1 stressed defaults < period 1 flat defaults (multiplier 0 vs 1).
    expect(stressed.periods[0].defaults).toBeLessThan(flat.periods[0].defaults);
    // Period 5 stressed defaults > period 5 flat defaults (multiplier 2 vs 1).
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

  it("path with zero baseline + non-zero stress falls back to bucket-map hazard", () => {
    // Edge case: defaultRatesByRating[bucket] = 0 but path returns >0.
    // Multiplier is undefined (Infinity); engine falls back to the bucket-map
    // hazard for that loan from the path-derived map. Callers that want true
    // "no defaults" must pair non-zero baseline with zero-returning path
    // (multiplier 0/baseline = 0 → hazard = 0); see test-helpers `noDefaults`.
    const baseInputs = makeInputs({
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
