/**
 * Default-rate-source regression tests.
 *
 * The engine at projection.ts:3815-3826 has two genuinely different
 * default-rate paths — per-loan WARF (default) and bucket CDR (when
 * overriddenBuckets names the bucket). Both are legitimate. The bug
 * surface is: scenario overlays (e.g. Intex) and UI actions (e.g.
 * "Set all to X% / Apply") used to set `defaultRates` without setting
 * `overriddenBuckets`, so the displayed CDR was silently inert and
 * the engine ran WARF. These tests pin each source path so the
 * specific failure mode can't come back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProjection } from "../projection";
import {
  buildFromResolved,
  defaultsFromResolved,
  defaultsFromIntex,
  type UserAssumptions,
} from "../build-projection-inputs";
import { buildBacktestInputs } from "../backtest-types";
import { RATING_BUCKETS } from "../rating-mapping";
import type { IntexAssumptions } from "../intex/parse-past-cashflows";
import type { ResolvedDealData } from "../resolver-types";

const fixturePath = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof buildBacktestInputs>[0];
};

describe("Default-rate sources — engine consumes what the UI displays", () => {
  it("Intex CDR overlay sets BOTH defaultRates AND overriddenBuckets (engine actually runs the displayed CDR)", () => {
    // Pre-fix: defaultsFromIntex set defaultRates only. UI displayed
    // "2.00% (Intex MV+ Apr 2026)" while overriddenBuckets stayed empty
    // → engine ran per-loan WARF (~3.84% annual on Euro XV). Partner
    // saw 2% but the model ran 1.9× hidden. Closed by atomic two-field
    // set inside defaultsFromIntex.
    const base: UserAssumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
    const intex: IntexAssumptions = {
      scenario: "MV+",
      ratesAsOf: "2026-04-15",
      cprPct: 20,
      cdrPct: 2,
      recoveryPct: 75,
      recoveryLagMonths: 0,
      optionalRedemption: null,
      reinvestSpreadPct: 3.63,
      reinvestMaturityMonths: 60,
      reinvestPricePct: null,
      reinvestRecoveryRatePct: null,
      collateralLiquidationPricePct: null,
      euribor1m: null,
      euribor2m: null,
      euribor3m: null,
      euribor6m: null,
    };
    const overlaid = defaultsFromIntex(base, intex);

    // CDR broadcast to every bucket key already present (existing behavior).
    for (const [bucket, rate] of Object.entries(overlaid.defaultRates)) {
      expect(
        rate,
        `Intex CDR not broadcast to bucket ${bucket}`,
      ).toBe(2);
    }

    // NEW: overriddenBuckets populated atomically so the engine actually
    // consumes the rates. Without this set, defaultRates is decorative.
    expect(
      new Set(overlaid.overriddenBuckets),
      "Intex CDR must populate overriddenBuckets so the engine honors the displayed rate (not silently fall through to WARF)",
    ).toEqual(new Set(RATING_BUCKETS));

    // Engine round-trip: when we hand the helper's output straight to
    // the engine (no further mutation), the projection MUST run at the
    // Intex CDR, not silently fall back to WARF. Pre-fix this test
    // would have failed at ~3.84% (engine runs WARF when
    // overriddenBuckets is empty). Bridges from helper-output-shape
    // (above) to engine-actual-behavior — a future consumer that
    // forgets to thread overriddenBuckets through to ProjectionInputs
    // is caught here.
    const result = runProjection(
      buildFromResolved(fixture.resolved, overlaid, [], fixture.raw),
    );
    const p0 = result.periods[0];
    const annualizedRate = (p0.defaults / p0.beginningPar) * 4 * 100;
    expect(annualizedRate, "engine MUST run at the Intex CDR (~2%), not WARF (~3.84%)").toBeGreaterThan(1.7);
    expect(annualizedRate, "engine MUST run at the Intex CDR (~2%), not WARF (~3.84%)").toBeLessThan(2.1);
  });

  it("explicit Apply-style override (overriddenBuckets = all) → engine honors user CDR", () => {
    // This is the engine-side contract that the UI "Set all to 2% /
    // Apply" handler relies on. The handler sets defaultRates AND
    // overriddenBuckets unconditionally; this test verifies that the
    // engine actually consumes the bucket CDR when overriddenBuckets
    // is populated (i.e. the unconditional Apply isn't pointless).
    const base = defaultsFromResolved(fixture.resolved, fixture.raw);
    const overridden: UserAssumptions = {
      ...base,
      defaultRates: Object.fromEntries(RATING_BUCKETS.map((b) => [b, 2])),
      overriddenBuckets: [...RATING_BUCKETS],
    };
    const result = runProjection(buildFromResolved(fixture.resolved, overridden, [], fixture.raw));
    const p0 = result.periods[0];
    const annualizedRate = (p0.defaults / p0.beginningPar) * 4 * 100;
    // Expected: ~2% annualized (the user's CDR). Tolerance accommodates
    // monthly-tick compounding + day-count residuals.
    expect(annualizedRate, "engine should run user CDR ~2% when overriddenBuckets is populated").toBeGreaterThan(1.7);
    expect(annualizedRate, "engine should run user CDR ~2% when overriddenBuckets is populated").toBeLessThan(2.1);
  });

  it("no-Intex, no overrides → engine preserves per-loan WARF (regression guard against blunt fix)", () => {
    // CRITICAL: this test prevents a regression to the previously
    // rejected "auto-extend overriddenBuckets from every defaultRates
    // key in buildFromResolved" fix. That blunt approach would:
    //   (a) lose per-loan WARF granularity (B1 vs B2 vs B3 differ in
    //       hazard but get collapsed to a bucket aggregate)
    //   (b) silently disable cdrPathMultiplier paths (Monte Carlo
    //       time-varying CDR) because overridden buckets bypass the
    //       multiplier branch at projection.ts:3820-3826
    // The correct semantics: when nobody opts in (no Intex overlay,
    // no slider touched, no Apply clicked), the engine runs per-loan
    // WARF — which on Euro XV produces a higher default rate than the
    // pool-level CDR averages because individual loans carry
    // bucket-specific Moody's factors.
    const base = defaultsFromResolved(fixture.resolved, fixture.raw);
    const withoutOverrides: UserAssumptions = {
      ...base,
      overriddenBuckets: [],
    };
    const result = runProjection(buildFromResolved(fixture.resolved, withoutOverrides, [], fixture.raw));
    const p0 = result.periods[0];
    const annualizedRate = (p0.defaults / p0.beginningPar) * 4 * 100;
    // Expected: WARF-derived rate, materially HIGHER than 2% on this
    // B-heavy pool (~3.8% per probe). The exact number drifts with
    // resolver/WARF data refreshes; bound the test to "clearly WARF,
    // not collapsed-to-CDR-default".
    expect(annualizedRate, "engine MUST use per-loan WARF when overriddenBuckets is empty (regression guard against the blunt auto-override fix)").toBeGreaterThan(3.0);
  });
});
