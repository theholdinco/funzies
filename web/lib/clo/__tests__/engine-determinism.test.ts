/**
 * Engine determinism property test — post-v6 plan §7.2.
 *
 * Repeatedly invokes `runProjection` with identical inputs and asserts
 * byte-identical outputs. Catches accidental introductions of
 * `Date.now()`, `Math.random()`, `process.env` reads, or other
 * non-deterministic state — even if the engine-purity test misses the
 * source-level marker (e.g., via an indirect import).
 *
 * 100 iterations is the size the plan calls for. Each run takes <10ms,
 * so the whole suite stays well under 1s.
 */

import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

const ITERATIONS = 100;

describe("Engine determinism (post-v6 plan §7.2)", () => {
  it("100 runs of identical inputs produce byte-identical outputs (deep equality)", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const baseline = runProjection(inputs);
    for (let i = 0; i < ITERATIONS; i++) {
      const next = runProjection(inputs);
      // Vitest deep equality on the entire ProjectionResult object —
      // matches every nested field across periods, stepTrace, initialState.
      expect(next).toEqual(baseline);
    }
  });

  it("identical inputs across stub-period mode produce identical outputs", () => {
    const inputs = makeInputs({
      currentDate: "2026-04-01",
      stubPeriod: true,
      firstPeriodEndDate: "2026-04-15",
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const a = runProjection(inputs);
    const b = runProjection(inputs);
    expect(b).toEqual(a);
  });

  it("identical inputs across optional-redemption call mode produce identical outputs", () => {
    const inputs = makeInputs({
      callMode: "optionalRedemption",
      callDate: "2028-01-15",
      callPriceMode: "par",
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const a = runProjection(inputs);
    const b = runProjection(inputs);
    expect(b).toEqual(a);
  });
});
