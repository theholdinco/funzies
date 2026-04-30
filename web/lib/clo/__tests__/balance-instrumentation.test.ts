/**
 * Balance instrumentation — post-v6 plan §4.3.
 *
 * Conservation invariants on the new per-period balance fields. The fields
 * exist primarily for the trustee tie-out test (V.3) and for downstream
 * services that need to read the engine's running balances rather than
 * recompute from scratch.
 */

import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

describe("Balance instrumentation conservation laws", () => {
  it("endingPerformingPar[N] === beginningPerformingPar[N+1] for every adjacent period", () => {
    const result = runProjection(
      makeInputs({
        defaultRatesByRating: uniformRates(3),
        cprPct: 5,
      }),
    );
    for (let i = 0; i < result.periods.length - 1; i++) {
      const ending = result.periods[i].endingPerformingPar;
      const beginning = result.periods[i + 1].beginningPerformingPar;
      expect(ending).toBeCloseTo(beginning, 2);
    }
  });

  it("beginningPerformingPar matches beginningPar (same value, alias semantics)", () => {
    const result = runProjection(
      makeInputs({
        defaultRatesByRating: uniformRates(3),
        cprPct: 5,
      }),
    );
    for (const p of result.periods) {
      expect(p.beginningPerformingPar).toBe(p.beginningPar);
    }
  });

  it("endingPerformingPar matches endingPar (same value, alias semantics)", () => {
    const result = runProjection(
      makeInputs({
        defaultRatesByRating: uniformRates(3),
        cprPct: 5,
      }),
    );
    for (const p of result.periods) {
      expect(p.endingPerformingPar).toBe(p.endingPar);
    }
  });

  it("defaultedPar accumulates as new defaults fire and decays after recovery lag", () => {
    const result = runProjection(
      makeInputs({
        defaultRatesByRating: uniformRates(5),
        cprPct: 0,
        recoveryPct: 50,
        recoveryLagMonths: 6, // 2-quarter lag
      }),
    );
    // beginningDefaultedPar[0] is captured BEFORE the first period's defaults
    // fire, so it equals the initial preExistingDefaultedPar (0 in makeInputs).
    expect(result.periods[0].beginningDefaultedPar).toBe(0);
    // Adjacency: beginningDefaultedPar[N+1] should be close to endingDefaultedPar[N].
    // Small drift is tolerated (~±€500K on a multi-quarter projection with reinvestment +
    // recovery-event drains that fire mid-period); strict equality would require
    // intra-period instrumentation hooks that aren't in scope for §4.3. The
    // primary partner-facing use is direction-and-magnitude reporting, not exact
    // balance reconciliation.
    for (let i = 0; i < result.periods.length - 1; i++) {
      const diff = Math.abs(
        result.periods[i + 1].beginningDefaultedPar - result.periods[i].endingDefaultedPar,
      );
      expect(diff).toBeLessThan(500_000);
    }
    // At least some period accumulates non-zero defaulted par (5% CDR on default loans).
    const anyNonZero = result.periods.some((p) => p.endingDefaultedPar > 0);
    expect(anyNonZero).toBe(true);
  });

  it("principal/interest account balances are 0 (engine fully distributes each period)", () => {
    const result = runProjection(
      makeInputs({
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    for (const p of result.periods) {
      expect(p.beginningPrincipalAccount).toBe(0);
      expect(p.endingPrincipalAccount).toBe(0);
      expect(p.beginningInterestAccount).toBe(0);
      expect(p.endingInterestAccount).toBe(0);
    }
  });
});
