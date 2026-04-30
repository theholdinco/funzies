/**
 * Stub-period anchoring at an arbitrary date — framework for A.8 trustee
 * replay (post-v6 plan §6.2).
 *
 * RENAMED from `trustee-replay.test.ts` per decision-log entry W. The
 * earlier filename over-promised: this file pins the stub-period engine
 * machinery anchored at an arbitrary anchor date. It does NOT compare
 * engine output against actual trustee values; that work belongs to
 * A.8 (deferred — requires loading distributions from `new_context.json`
 * with per-step tolerance).
 *
 * What this file pins:
 *  - 1-day stub lands period 1 on the requested anchor date
 *  - 1-day stub produces hazard rates ~0 (pro-rata over a single day)
 *  - Post-stub period cadence matches a non-stub run starting at the
 *    same anchor (the stub doesn't perturb downstream cadence)
 *
 * What this file does NOT pin:
 *  - Engine period N vs trustee period N+1 distribution comparison.
 *    That's the real trustee replay (A.8) and the slot
 *    `trustee-replay.test.ts` is reserved for it.
 *
 * Compare to:
 *  - `backtest-harness.test.ts` (full-quarter T=0 N1 parity)
 *  - `stub-period.test.ts` (stub-period engine in isolation)
 * The anchoring framework sits between them: stub-period applied to a
 * realistic non-determination-date scenario.
 */

import { describe, it, expect } from "vitest";
import { runProjection, addQuarters } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

describe("Stub-period anchoring at an arbitrary date (framework for A.8 trustee replay)", () => {
  it("engine with currentDate = trusteeDate - 1 day, stub to trusteeDate, lands period 1 on trusteeDate", () => {
    // Synthetic baseline: trustee payment date 2026-04-15. Engine runs
    // from 2026-04-14 with a 1-day stub.
    const trusteeDate = "2026-04-15";
    const dayBefore = "2026-04-14";
    const result = runProjection(
      makeInputs({
        currentDate: dayBefore,
        stubPeriod: true,
        firstPeriodEndDate: trusteeDate,
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    expect(result.periods.length).toBeGreaterThan(0);
    expect(result.periods[0].date).toBe(trusteeDate);
    // Period 2 starts at trusteeDate, runs a full quarter forward.
    if (result.periods.length >= 2) {
      expect(result.periods[1].date).toBe(addQuarters(trusteeDate, 1));
    }
  });

  it("1-day stub produces hazard rates ~0 (pro-rata over a single day)", () => {
    // Sanity: a 1-day stub should produce essentially zero defaults / prepays
    // since a 90-day quarter at 2% CDR → 1-day stub at ~0.022% expected
    // defaults. With initialPar 100M, that's ~€22K — orders of magnitude
    // smaller than a full quarter's ~€500K.
    const trusteeDate = "2026-04-15";
    const dayBefore = "2026-04-14";
    const stub = runProjection(
      makeInputs({
        currentDate: dayBefore,
        stubPeriod: true,
        firstPeriodEndDate: trusteeDate,
        defaultRatesByRating: uniformRates(2),
        cprPct: 0,
      }),
    );
    const fullQuarter = runProjection(
      makeInputs({
        currentDate: trusteeDate,
        defaultRatesByRating: uniformRates(2),
        cprPct: 0,
      }),
    );
    // Stub period 1 defaults << full quarter period 1 defaults.
    expect(stub.periods[0].defaults).toBeLessThan(fullQuarter.periods[0].defaults * 0.1);
  });

  it("trustee replay does not regress the post-stub period cadence", () => {
    // After the 1-day stub, periods 2+ should run as full quarters from
    // trusteeDate — same cadence as a non-stub run starting at trusteeDate.
    // This mirrors stub-period.test.ts but anchors the assertion on a
    // realistic trustee-replay date so partner tests use this pattern as
    // a reference.
    const trusteeDate = "2026-04-15";
    const dayBefore = "2026-04-14";
    const replayed = runProjection(
      makeInputs({
        currentDate: dayBefore,
        stubPeriod: true,
        firstPeriodEndDate: trusteeDate,
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    const baseline = runProjection(
      makeInputs({
        currentDate: trusteeDate,
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    // Period 2 of replay ↔ Period 1 of baseline (same date, same starting state
    // modulo the 1-day stub's tiny mutations). Pool par should be within 1bp.
    if (replayed.periods.length >= 2 && baseline.periods.length >= 1) {
      expect(replayed.periods[1].date).toBe(baseline.periods[0].date);
      const ratio = replayed.periods[1].beginningPar / baseline.periods[0].beginningPar;
      expect(ratio).toBeGreaterThan(0.999);
      expect(ratio).toBeLessThan(1.001);
    }
  });
});
