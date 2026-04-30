import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeFairValueAtHurdle,
  computeFairValuesAtHurdles,
} from "../services/fair-value";
import { buildFromResolved, DEFAULT_ASSUMPTIONS } from "../build-projection-inputs";
import { runProjection } from "../projection";
import type { ResolvedDealData } from "../resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
};

const SUB_NOTE = fixture.resolved.tranches.find((t) => t.isIncomeNote);
if (!SUB_NOTE) throw new Error("fixture missing sub note tranche");
const SUB_PAR = SUB_NOTE.originalBalance;

const INPUTS = buildFromResolved(fixture.resolved, DEFAULT_ASSUMPTIONS);

describe("fair-value: monotonicity (engine IRR is decreasing in entry price)", () => {
  it("IRR at 50c > IRR at 95c > IRR at 150c", () => {
    const irr50 = runProjection({ ...INPUTS, equityEntryPrice: SUB_PAR * 0.50 }).equityIrr!;
    const irr95 = runProjection({ ...INPUTS, equityEntryPrice: SUB_PAR * 0.95 }).equityIrr!;
    const irr150 = runProjection({ ...INPUTS, equityEntryPrice: SUB_PAR * 1.50 }).equityIrr!;
    expect(irr50).toBeGreaterThan(irr95);
    expect(irr95).toBeGreaterThan(irr150);
  });
});

describe("computeFairValueAtHurdle on Euro XV", () => {
  // Anchor: Euro XV's IRR-vs-entry-price curve crosses 10% IRR somewhere
  // between 20c (102% IRR) and 50c (3.5% IRR), and crosses 0% somewhere
  // between 50c (3.5%) and 95c (−17%). MAX_CENTS=200 caps IRR at ~−30%
  // so any target below ~−30% returns above_max_bracket.

  it("10% hurdle → converged price within (20c, 50c)", () => {
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, 0.10);
    expect(r.status).toBe("converged");
    expect(r.priceCents).not.toBeNull();
    expect(r.priceCents!).toBeGreaterThan(20);
    expect(r.priceCents!).toBeLessThan(50);
  });

  it("converged price reproduces the target IRR within tight tolerance", () => {
    const target = 0.10;
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, target);
    expect(r.status).toBe("converged");
    const reproducedIrr = runProjection({
      ...INPUTS,
      equityEntryPrice: SUB_PAR * (r.priceCents! / 100),
    }).equityIrr!;
    expect(reproducedIrr).toBeCloseTo(target, 2);
  });

  it("higher hurdle → lower fair-value price (monotonic decreasing)", () => {
    const lowHurdle = computeFairValueAtHurdle(INPUTS, SUB_PAR, 0.05);
    const highHurdle = computeFairValueAtHurdle(INPUTS, SUB_PAR, 0.20);
    expect(lowHurdle.status).toBe("converged");
    expect(highHurdle.status).toBe("converged");
    expect(lowHurdle.priceCents!).toBeGreaterThan(highHurdle.priceCents!);
  });

  it("unreachably high hurdle (>200,000% IRR) → below_hurdle", () => {
    // Probe ladder's lowest finite-IRR anchor on Euro XV is 1c with IRR ≈ 1841
    // (i.e., 184,100%). Targets above that exceed any computable IRR in the
    // probe ladder → below_hurdle.
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, 2000);
    expect(r.status).toBe("below_hurdle");
    expect(r.priceCents).toBeNull();
  });

  it("trivially-met hurdle (−50%) → above_max_bracket", () => {
    // At 200c entry IRR ≈ −30%, still above −50% target.
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, -0.50);
    expect(r.status).toBe("above_max_bracket");
    expect(r.priceCents).toBeNull();
  });

  it("subNotePar <= 0 → wiped_out", () => {
    const r = computeFairValueAtHurdle(INPUTS, 0, 0.10);
    expect(r.status).toBe("wiped_out");
    expect(r.priceCents).toBeNull();
  });

  it("converges in <= MAX_ITERATIONS bisection steps", () => {
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, 0.10);
    expect(r.status).toBe("converged");
    expect(r.iterations).toBeLessThanOrEqual(30);
  });

  it("0.05c precision: convergence tolerance is at most 0.1c bracket width", () => {
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, 0.10);
    expect(r.status).toBe("converged");
    // The midpoint is reported; bracket width ≤ 2 × TOLERANCE_CENTS = 0.1c.
    // Reproduced IRR should be very close to target.
    const reproducedIrr = runProjection({
      ...INPUTS,
      equityEntryPrice: SUB_PAR * (r.priceCents! / 100),
    }).equityIrr!;
    expect(Math.abs(reproducedIrr - 0.10)).toBeLessThan(0.005);
  });
});

describe("computeFairValuesAtHurdles (multi-hurdle)", () => {
  it("returns one result per requested hurdle, in order", () => {
    const results = computeFairValuesAtHurdles(INPUTS, SUB_PAR, [0.05, 0.10, 0.15]);
    expect(results).toHaveLength(3);
    expect(results[0].hurdle).toBe(0.05);
    expect(results[1].hurdle).toBe(0.10);
    expect(results[2].hurdle).toBe(0.15);
  });

  it("multiple hurdles preserve monotonic price ordering (lower hurdle ↔ higher price)", () => {
    const results = computeFairValuesAtHurdles(INPUTS, SUB_PAR, [0.05, 0.10, 0.15]);
    const prices = results
      .filter((r) => r.status === "converged")
      .map((r) => r.priceCents!);
    expect(prices).toHaveLength(3);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeLessThan(prices[i - 1]);
    }
  });
});
