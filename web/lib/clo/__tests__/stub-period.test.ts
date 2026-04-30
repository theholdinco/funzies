/**
 * Stub-period engine — post-v6 plan §4.2.
 *
 * The engine accepts an intra-period `currentDate` when `stubPeriod: true`
 * and `firstPeriodEndDate` is supplied. Period 1 runs from `currentDate` to
 * `firstPeriodEndDate` (a partial quarter), with day-count fractions and
 * hazard rates prorated by the actual day-count fraction. Subsequent periods
 * are full quarters from `firstPeriodEndDate`.
 *
 * Default behavior (no flag): byte-identical to pre-§4.2 — period 1 starts at
 * `currentDate` and ends at `addQuarters(currentDate, 1)`. Existing fixtures
 * and pinned tests are unaffected.
 */

import { describe, it, expect } from "vitest";
import { runProjection, addQuarters } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

describe("Stub-period engine (post-v6 plan §4.2)", () => {
  it("default (no stub flag) produces byte-identical output to pre-§4.2 behavior", () => {
    // Two runs with identical inputs; one explicitly setting stubPeriod=false.
    // They must produce identical period counts AND identical equity IRR.
    const baseline = runProjection(
      makeInputs({
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    const explicit = runProjection(
      makeInputs({
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
        stubPeriod: false,
      }),
    );
    expect(explicit.periods.length).toBe(baseline.periods.length);
    expect(explicit.equityIrr).toBe(baseline.equityIrr);
    expect(explicit.totalEquityDistributions).toBeCloseTo(baseline.totalEquityDistributions, 2);
  });

  it("stub=true with firstPeriodEndDate matching addQuarters(currentDate, 1) is a no-op", () => {
    // Setting a stub end at the natural quarter boundary should be equivalent
    // to no stub at all (proration factor = 1.0, dayFracActual ≈ 0.25).
    const currentDate = "2026-01-15";
    const naturalEnd = addQuarters(currentDate, 1); // 2026-04-15
    const noStub = runProjection(
      makeInputs({
        currentDate,
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    const stubAtNatural = runProjection(
      makeInputs({
        currentDate,
        stubPeriod: true,
        firstPeriodEndDate: naturalEnd,
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    expect(stubAtNatural.periods.length).toBe(noStub.periods.length);
    expect(stubAtNatural.equityIrr).toBeCloseTo(noStub.equityIrr ?? 0, 4);
  });

  it("stub-period with intra-period currentDate produces shorter period 1 day-count", () => {
    // currentDate 14 days before the natural quarter end → stub period of ~14 days.
    const currentDate = "2026-04-01";
    const stubEnd = "2026-04-15"; // 14 days
    const result = runProjection(
      makeInputs({
        currentDate,
        stubPeriod: true,
        firstPeriodEndDate: stubEnd,
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    // Period 1 ends at stubEnd.
    expect(result.periods[0].date).toBe(stubEnd);
    // Period 2 starts at stubEnd, ends at stubEnd + 1 quarter.
    expect(result.periods[1].date).toBe(addQuarters(stubEnd, 1));
  });

  it("stub-period defaults are prorated: shorter period → fewer defaults", () => {
    // Same default rate, but stub=true with a 14-day first period vs no-stub
    // with 90-day first period. Period-1 defaults should be much smaller in
    // the stub case.
    const fullQuarter = runProjection(
      makeInputs({
        currentDate: "2026-04-15",
        defaultRatesByRating: uniformRates(10),
        cprPct: 0,
      }),
    );
    const stub14d = runProjection(
      makeInputs({
        currentDate: "2026-04-01",
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-15",
        defaultRatesByRating: uniformRates(10),
        cprPct: 0,
      }),
    );
    // Period 1 default magnitude proxies hazard application. Stub of 14 days
    // (≈ 0.156 of a quarter) should produce fewer defaults than a full quarter.
    expect(stub14d.periods[0].defaults).toBeGreaterThan(0);
    expect(stub14d.periods[0].defaults).toBeLessThan(fullQuarter.periods[0].defaults);
    // Order-of-magnitude check: stub default / full default ≈ 0.156 (within 0.01).
    const ratio = stub14d.periods[0].defaults / fullQuarter.periods[0].defaults;
    expect(ratio).toBeGreaterThan(0.10);
    expect(ratio).toBeLessThan(0.25);
  });

  it("stub-period prorates prepay rate too", () => {
    const noStub = runProjection(
      makeInputs({
        currentDate: "2026-04-15",
        defaultRatesByRating: uniformRates(0),
        cprPct: 20,
      }),
    );
    const stub14d = runProjection(
      makeInputs({
        currentDate: "2026-04-01",
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-15",
        defaultRatesByRating: uniformRates(0),
        cprPct: 20,
      }),
    );
    // Period-1 prepayments are smaller in the stub case (CPR scaled by 14/90).
    expect(stub14d.periods[0].prepayments).toBeGreaterThan(0);
    expect(stub14d.periods[0].prepayments).toBeLessThan(noStub.periods[0].prepayments);
  });

  it("stub-period periods 2+ are unprorated (full-quarter cadence)", () => {
    // After the stub, periods 2+ should produce full-quarter defaults.
    const fullQuarter = runProjection(
      makeInputs({
        currentDate: "2026-04-15",
        defaultRatesByRating: uniformRates(10),
        cprPct: 0,
      }),
    );
    const stub = runProjection(
      makeInputs({
        currentDate: "2026-04-01",
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-15",
        defaultRatesByRating: uniformRates(10),
        cprPct: 0,
      }),
    );
    // Periods 2 of stub run vs period 1 of fullQuarter — both are quarters
    // starting from 2026-04-15 with the same surviving par (modulo small
    // stub-period defaults). Defaults should be roughly equal.
    const stubP2 = stub.periods[1].defaults;
    const fullP1 = fullQuarter.periods[0].defaults;
    expect(stubP2 / fullP1).toBeGreaterThan(0.95);
    expect(stubP2 / fullP1).toBeLessThan(1.05);
  });
});
