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
const FAIR_VALUE_TIMEOUT_MS = 120_000;

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
  // between 20c (~78% IRR) and 50c (~−22% IRR), and crosses 0% between
  // those same anchors. MAX_CENTS=200 caps IRR at ~−65%, so any target
  // below that returns above_max_bracket.

  it("10% hurdle → converged price within (20c, 50c)", () => {
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, 0.10);
    expect(r.status).toBe("converged");
    expect(r.priceCents).not.toBeNull();
    expect(r.priceCents!).toBeGreaterThan(20);
    expect(r.priceCents!).toBeLessThan(50);
  }, FAIR_VALUE_TIMEOUT_MS);

  it("converged price reproduces the target IRR within tight tolerance", () => {
    const target = 0.10;
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, target);
    expect(r.status).toBe("converged");
    const reproducedIrr = runProjection({
      ...INPUTS,
      equityEntryPrice: SUB_PAR * (r.priceCents! / 100),
    }).equityIrr!;
    expect(reproducedIrr).toBeCloseTo(target, 2);
  }, FAIR_VALUE_TIMEOUT_MS);

  it("higher hurdle → lower fair-value price (monotonic decreasing)", () => {
    const lowHurdle = computeFairValueAtHurdle(INPUTS, SUB_PAR, 0.05);
    const highHurdle = computeFairValueAtHurdle(INPUTS, SUB_PAR, 0.20);
    expect(lowHurdle.status).toBe("converged");
    expect(highHurdle.status).toBe("converged");
    expect(lowHurdle.priceCents!).toBeGreaterThan(highHurdle.priceCents!);
  }, FAIR_VALUE_TIMEOUT_MS);

  it("unreachably high hurdle above the near-free entry IRR → below_hurdle", () => {
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, 10_000_000);
    expect(r.status).toBe("below_hurdle");
    expect(r.priceCents).toBeNull();
  });

  it("trivially-met hurdle (−75%) → above_max_bracket", () => {
    // At 200c entry IRR ≈ −65%, still above −75% target.
    const r = computeFairValueAtHurdle(INPUTS, SUB_PAR, -0.75);
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
  }, FAIR_VALUE_TIMEOUT_MS);

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
  }, FAIR_VALUE_TIMEOUT_MS);
});

describe("computeFairValuesAtHurdles (multi-hurdle)", () => {
  it("returns one result per requested hurdle, in order", () => {
    const results = computeFairValuesAtHurdles(INPUTS, SUB_PAR, [0.05, 0.10, 0.15]);
    expect(results).toHaveLength(3);
    expect(results[0].hurdle).toBe(0.05);
    expect(results[1].hurdle).toBe(0.10);
    expect(results[2].hurdle).toBe(0.15);
  }, FAIR_VALUE_TIMEOUT_MS);

  it("multiple hurdles preserve monotonic price ordering (lower hurdle ↔ higher price)", () => {
    const results = computeFairValuesAtHurdles(INPUTS, SUB_PAR, [0.05, 0.10, 0.15]);
    const prices = results
      .filter((r) => r.status === "converged")
      .map((r) => r.priceCents!);
    expect(prices).toHaveLength(3);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeLessThan(prices[i - 1]);
    }
  }, FAIR_VALUE_TIMEOUT_MS);
});
