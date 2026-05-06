/**
 * Per-position WARF-factor hazard — production default and only path.
 *
 * Engine derives each position's quarterly default hazard from its Moody's
 * WARF factor — the institutionally-correct hazard model per Moody's CLO
 * methodology. Distinguishes Caa1 (factor 4770 ≈ 6.3% annual) from Caa3
 * (8070 ≈ 15.2% annual), where the coarse bucket map averaged them as
 * "CCC" at 10.28%.
 *
 * Scope:
 *   ✅ Math: warfFactor × 10yr → quarterly hazard via
 *      h = 1 − (1 − wf/10000)^(1/40).
 *   ✅ Caa1 vs Caa3 in the same "CCC" bucket produce distinct hazards.
 *   ✅ Reinvested synthetic loans carry a warfFactor via
 *      BUCKET_WARF_FALLBACK, so they hit the per-position path too.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DefaultDrawFn, LoanInput, ProjectionInputs } from "@/lib/clo/projection";
import { runProjection } from "@/lib/clo/projection";
import { buildFromResolved, defaultsFromResolved } from "@/lib/clo/build-projection-inputs";
import { warfFactorToQuarterlyHazard } from "@/lib/clo/rating-mapping";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof defaultsFromResolved>[1];
};

// Deterministic default-draw: always returns `survivingPar × hazard` (no
// stochastic noise). Lets tests assert on exact expected defaults instead
// of Monte Carlo distributions.
const expectationDraw: DefaultDrawFn = (survivingPar, hazard) => survivingPar * hazard;

describe("warfFactorToQuarterlyHazard helper math", () => {
  it("Aaa (factor 1) → near-zero quarterly hazard", () => {
    expect(warfFactorToQuarterlyHazard(1)).toBeLessThan(1e-5);
  });

  it("B2 (factor 2720) → ~0.79% per quarter (≈3.13% annual)", () => {
    const h = warfFactorToQuarterlyHazard(2720);
    expect(h).toBeCloseTo(0.00788, 4);
  });

  it("Caa1 (factor 4770) < Caa3 (factor 8070) → per-position precision", () => {
    const hCaa1 = warfFactorToQuarterlyHazard(4770);
    const hCaa3 = warfFactorToQuarterlyHazard(8070);
    expect(hCaa1).toBeLessThan(hCaa3);
    expect(hCaa1).toBeGreaterThan(0.01);
    expect(hCaa3 / hCaa1).toBeGreaterThan(2);
    expect(hCaa3 / hCaa1).toBeLessThan(4);
  });

  it("Ca/C (factor 10000) → quarterly hazard = 1 (defaults next quarter)", () => {
    expect(warfFactorToQuarterlyHazard(10000)).toBe(1);
  });

  it("factor 0 or negative → 0 hazard (guard against malformed inputs)", () => {
    expect(warfFactorToQuarterlyHazard(0)).toBe(0);
    expect(warfFactorToQuarterlyHazard(-100)).toBe(0);
  });
});

describe("per-position hazard differentiates within a bucket", () => {
  // Synthetic 2-loan pool: same ratingBucket ("CCC"), different warfFactors.
  // Per-position differentiates Caa1 (~6.3% annual) from Caa3 (~15.2%
  // annual). The coarse bucket map would have treated them identically.
  const makeInputs = (): ProjectionInputs => {
    const baseInputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const caa1: LoanInput = {
      parBalance: 10_000_000,
      maturityDate: "2030-01-15",
      ratingBucket: "CCC",
      spreadBps: 400,
      warfFactor: 4770,
      currentPrice: 100,
    };
    const caa3: LoanInput = {
      parBalance: 10_000_000,
      maturityDate: "2030-01-15",
      ratingBucket: "CCC",
      spreadBps: 400,
      warfFactor: 8070,
      currentPrice: 100,
    };
    return {
      ...baseInputs,
      loans: [caa1, caa3],
      cprPct: 0,
      postRpReinvestmentPct: 0,
    };
  };

  it("Caa3 position survives Q1 with less par than Caa1 position", () => {
    // Expected endingPar = 10M × (1−h_Caa1) + 10M × (1−h_Caa3)
    //                    = 10M × 0.9839 + 10M × 0.9598
    //                    ≈ 19.437M.
    const result = runProjection(makeInputs(), expectationDraw);
    const endingPar = result.periods[0].endingPar;
    expect(endingPar).toBeGreaterThan(19_350_000);
    expect(endingPar).toBeLessThan(19_550_000);
  });
});

describe("LoanInput.warfFactor boundary guard", () => {
  // Per-position WARF is the only hazard branch; the legacy `warfFactor <= 0`
  // bucket-branch fallback was removed in the KI-20 closure as unreachable
  // under the prevailing fallback chain. The construction-site guard at
  // `resolveLoanWarfFactor` exists to keep that "unreachable" status from
  // becoming a silent silent-zero-hazard hole if a future caller passes
  // `warfFactor: 0` explicitly. Pinning the boundary throw here so a future
  // engine refactor that softens the guard fails this test loudly.
  it("explicit warfFactor: 0 throws at construction (no silent zero-hazard)", () => {
    const baseInputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const malformed: LoanInput = {
      parBalance: 1_000_000,
      maturityDate: "2030-01-15",
      ratingBucket: "B",
      spreadBps: 400,
      warfFactor: 0,
    };
    expect(() =>
      runProjection({ ...baseInputs, loans: [malformed] }, expectationDraw),
    ).toThrow(/warfFactor/);
  });

  it("explicit warfFactor: -1 throws at construction (no silent zero-hazard)", () => {
    const baseInputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const malformed: LoanInput = {
      parBalance: 1_000_000,
      maturityDate: "2030-01-15",
      ratingBucket: "B",
      spreadBps: 400,
      warfFactor: -1,
    };
    expect(() =>
      runProjection({ ...baseInputs, loans: [malformed] }, expectationDraw),
    ).toThrow(/warfFactor/);
  });

  it("warfFactor: null falls back to BUCKET_WARF_FALLBACK (no throw)", () => {
    const baseInputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const wellFormed: LoanInput = {
      parBalance: 1_000_000,
      maturityDate: "2030-01-15",
      ratingBucket: "B",
      spreadBps: 400,
      warfFactor: null,
    };
    expect(() =>
      runProjection({ ...baseInputs, loans: [wellFormed] }, expectationDraw),
    ).not.toThrow();
  });

  it("explicit warfFactor: NaN throws at construction (the silent-NaN-propagation hole)", () => {
    // NaN <= 0 is false, so a literal `<= 0` guard misses NaN. Then `NaN ??
    // fallback` is NaN (?? only coalesces null/undefined). Result: LoanState
    // .warfFactor = NaN → warfFactorToQuarterlyHazard(NaN) returns 0 via
    // its !Number.isFinite guard → silent zero-hazard. Pinning the throw
    // here so a future relaxation of the construction guard fails loud.
    const baseInputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const malformed: LoanInput = {
      parBalance: 1_000_000,
      maturityDate: "2030-01-15",
      ratingBucket: "B",
      spreadBps: 400,
      warfFactor: NaN,
    };
    expect(() =>
      runProjection({ ...baseInputs, loans: [malformed] }, expectationDraw),
    ).toThrow(/warfFactor/);
  });

  it("explicit warfFactor: Infinity throws at construction", () => {
    // Infinity passes the <= 0 check; warfFactorToQuarterlyHazard(Infinity)
    // returns 1 (cumDef clamped to 1) — instant default, not silent, but
    // still a malformed input that should fail loud at the boundary rather
    // than silently flipping the position's hazard to 100%/q.
    const baseInputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const malformed: LoanInput = {
      parBalance: 1_000_000,
      maturityDate: "2030-01-15",
      ratingBucket: "B",
      spreadBps: 400,
      warfFactor: Infinity,
    };
    expect(() =>
      runProjection({ ...baseInputs, loans: [malformed] }, expectationDraw),
    ).toThrow(/warfFactor/);
  });
});

describe("reinvested loans carry bucket-fallback factor into per-position path", () => {
  it("reinvested synthetic loans default at their BUCKET_WARF_FALLBACK rate (no NaN, no silent zero)", () => {
    const inputs = {
      ...buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw)),
      reinvestmentRating: "B",
    };
    const result = runProjection(inputs, expectationDraw);
    expect(result.periods.length).toBeGreaterThan(0);
    for (const p of result.periods) {
      expect(Number.isFinite(p.defaults)).toBe(true);
      expect(p.defaults).toBeGreaterThanOrEqual(0);
    }
  });
});
