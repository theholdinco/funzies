/**
 * Reinvestment-period extension — post-v6 plan §4.5.
 *
 * Engine reads max(reinvestmentPeriodEnd, reinvestmentPeriodExtension) as the
 * effective RP end so a user's extension can lengthen but cannot inadvertently
 * shorten an already-late extracted RP end.
 */

import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

describe("RP extension max() semantics (post-v6 plan §4.5)", () => {
  it("extension > extracted: effective RP end advances → reinvestment window longer", () => {
    const baseline = runProjection(
      makeInputs({
        currentDate: "2026-01-15",
        reinvestmentPeriodEnd: "2027-01-15",
        defaultRatesByRating: uniformRates(0),
        cprPct: 30, // strong prepayments → reinvestment fires only inside RP
      }),
    );
    const extended = runProjection(
      makeInputs({
        currentDate: "2026-01-15",
        reinvestmentPeriodEnd: "2027-01-15",
        reinvestmentPeriodExtension: "2029-01-15", // 2 years longer
        defaultRatesByRating: uniformRates(0),
        cprPct: 30,
      }),
    );
    // Sum of reinvestment across the projection should be larger when RP is
    // extended (more periods of prepayments stay in-pool rather than amortizing).
    const baselineReinv = baseline.periods.reduce((s, p) => s + p.reinvestment, 0);
    const extendedReinv = extended.periods.reduce((s, p) => s + p.reinvestment, 0);
    expect(extendedReinv).toBeGreaterThan(baselineReinv);
  });

  it("extension < extracted: effective RP end is the extracted (later) date — no shortening", () => {
    const fullRp = runProjection(
      makeInputs({
        currentDate: "2026-01-15",
        reinvestmentPeriodEnd: "2029-01-15",
        defaultRatesByRating: uniformRates(0),
        cprPct: 20,
      }),
    );
    const tryToShorten = runProjection(
      makeInputs({
        currentDate: "2026-01-15",
        reinvestmentPeriodEnd: "2029-01-15",
        reinvestmentPeriodExtension: "2027-01-15", // earlier — should be ignored
        defaultRatesByRating: uniformRates(0),
        cprPct: 20,
      }),
    );
    // Reinvestment patterns should be identical because max() preserves the later
    // (extracted) end date.
    for (let i = 0; i < fullRp.periods.length; i++) {
      expect(tryToShorten.periods[i].reinvestment).toBeCloseTo(
        fullRp.periods[i].reinvestment,
        2,
      );
    }
  });

  it("null extension is a no-op (extracted RP end used as-is)", () => {
    const baseline = runProjection(
      makeInputs({
        currentDate: "2026-01-15",
        reinvestmentPeriodEnd: "2027-01-15",
        defaultRatesByRating: uniformRates(0),
        cprPct: 20,
      }),
    );
    const explicitNull = runProjection(
      makeInputs({
        currentDate: "2026-01-15",
        reinvestmentPeriodEnd: "2027-01-15",
        reinvestmentPeriodExtension: null,
        defaultRatesByRating: uniformRates(0),
        cprPct: 20,
      }),
    );
    expect(explicitNull.equityIrr).toBe(baseline.equityIrr);
  });

  it("extension is honored when extracted RP end is null", () => {
    // No extracted RP — extension provides the only RP end.
    const noRp = runProjection(
      makeInputs({
        currentDate: "2026-01-15",
        reinvestmentPeriodEnd: null,
        defaultRatesByRating: uniformRates(0),
        cprPct: 30,
      }),
    );
    const withExt = runProjection(
      makeInputs({
        currentDate: "2026-01-15",
        reinvestmentPeriodEnd: null,
        reinvestmentPeriodExtension: "2028-01-15",
        defaultRatesByRating: uniformRates(0),
        cprPct: 30,
      }),
    );
    const noRpReinv = noRp.periods.reduce((s, p) => s + p.reinvestment, 0);
    const withExtReinv = withExt.periods.reduce((s, p) => s + p.reinvestment, 0);
    expect(withExtReinv).toBeGreaterThan(noRpReinv);
  });
});
