/**
 * D3 — `defaultsFromResolved` pre-fill family.
 *
 * Single helper that pulls observable assumptions from resolver output + raw
 * trustee data, replacing DEFAULT_ASSUMPTIONS for every consumer that needs
 * pre-filled inputs (production-path harness, ProjectionModel UI). Closes:
 *   - KI-10 (baseRate pre-fill) — full
 *   - KI-11 (senior/sub mgmt fee pre-fill) — partial (rate plumbing; fee-base
 *     discrepancy is KI-12a's territory, not fixed here)
 *   - KI-08 (trusteeFeeBps pre-fill) — partial (Senior Expenses Cap + overflow
 *     at steps Y/Z remains Sprint 3 / C3)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ASSUMPTIONS,
  defaultsFromResolved,
} from "@/lib/clo/build-projection-inputs";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof defaultsFromResolved>[1];
};

describe("D3 — defaultsFromResolved (Euro XV fixture)", () => {
  it("pre-fills baseRatePct from observed EURIBOR (closes KI-10)", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    // Fixture trancheSnapshots carry currentIndexRate = 2.016%
    expect(d.baseRatePct).toBeCloseTo(2.016, 3);
    // Sanity: this is the observed EURIBOR, not the static default (2.1%).
    expect(d.baseRatePct).not.toBe(DEFAULT_ASSUMPTIONS.baseRatePct);
  });

  it("pre-fills senior + sub mgmt fees from resolver PPM extraction (closes KI-11 pre-fill)", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    expect(d.seniorFeePct).toBe(0.15);
    expect(d.subFeePct).toBe(0.35);
  });

  it("pre-fills incentive fee rate and hurdle from resolver", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    expect(d.incentiveFeePct).toBe(20);
    // Resolver stores hurdle as decimal (0.12); UserAssumptions uses percentage (12).
    expect(d.incentiveFeeHurdleIrr).toBeCloseTo(12, 6);
  });

  it("back-derives trusteeFeeBps + adminFeeBps separately from Q1 waterfall B + C (C3 split)", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    // Q1 2026 Euro XV per raw.waterfallSteps:
    //   step B (trustee) = €1,194.44 → 0.0969 bps on €493.2M × 4
    //   step C (admin)   = €63,465.76 → 5.147 bps on €493.2M × 4
    //   combined         ≈ 5.24 bps (matches the pre-C3 bundled extraction)
    expect(d.trusteeFeeBps).toBeCloseTo(0.0969, 3);
    expect(d.adminFeeBps).toBeCloseTo(5.147, 2);
    // Sum still matches pre-C3 combined extraction (regression guard for
    // downstream consumers that expected the old single-field bundle).
    expect(d.trusteeFeeBps + d.adminFeeBps).toBeCloseTo(5.24, 1);
    // Sanity: not the static default (0).
    expect(d.trusteeFeeBps).not.toBe(DEFAULT_ASSUMPTIONS.trusteeFeeBps);
    expect(d.adminFeeBps).not.toBe(0);
  });

  it("derives seniorExpensesCapBps from Q1 actuals (max(2× observed, 20) bps)", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    // Euro XV: observed combined ≈ 5.24 bps. 2× = 10.48. max(10.48, 20) = 20.
    expect(d.seniorExpensesCapBps).toBeCloseTo(20, 5);
  });

  it("preserves every non-pre-fill field from DEFAULT_ASSUMPTIONS", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    // Fields NOT in the pre-fill family should match the static default.
    expect(d.cprPct).toBe(DEFAULT_ASSUMPTIONS.cprPct);
    expect(d.recoveryPct).toBe(DEFAULT_ASSUMPTIONS.recoveryPct);
    expect(d.defaultRates).toEqual(DEFAULT_ASSUMPTIONS.defaultRates);
    expect(d.reinvestmentSpreadBps).toBe(DEFAULT_ASSUMPTIONS.reinvestmentSpreadBps);
    expect(d.callDate).toBe(DEFAULT_ASSUMPTIONS.callDate);
    expect(d.callPriceMode).toBe(DEFAULT_ASSUMPTIONS.callPriceMode);
  });
});

describe("D3 — defaultsFromResolved (degenerate inputs)", () => {
  it("null raw → falls back to resolver-only pre-fills (no baseRate, no trusteeFeeBps back-derive)", () => {
    const d = defaultsFromResolved(fixture.resolved, null);
    expect(d.baseRatePct).toBe(DEFAULT_ASSUMPTIONS.baseRatePct); // no trancheSnapshots → default
    expect(d.seniorFeePct).toBe(0.15); // resolver still works
    expect(d.trusteeFeeBps).toBe(DEFAULT_ASSUMPTIONS.trusteeFeeBps); // no waterfall → default (0)
  });

  it("resolved.fees all zero (no PPM extraction) → everything falls through to DEFAULT_ASSUMPTIONS", () => {
    const emptyFees: ResolvedDealData = {
      ...fixture.resolved,
      fees: { seniorFeePct: 0, subFeePct: 0, trusteeFeeBps: 0, incentiveFeePct: 0, incentiveFeeHurdleIrr: 0 },
    };
    const d = defaultsFromResolved(emptyFees, { trancheSnapshots: null, waterfallSteps: null });
    expect(d.seniorFeePct).toBe(DEFAULT_ASSUMPTIONS.seniorFeePct);
    expect(d.subFeePct).toBe(DEFAULT_ASSUMPTIONS.subFeePct);
    expect(d.incentiveFeePct).toBe(DEFAULT_ASSUMPTIONS.incentiveFeePct);
    expect(d.trusteeFeeBps).toBe(DEFAULT_ASSUMPTIONS.trusteeFeeBps);
  });

  it("trusteeFeeBps from PPM takes precedence over waterfall back-derivation", () => {
    // If the resolver successfully extracted a trustee fee, use it — don't
    // re-derive from waterfall (which would duplicate the signal).
    const withPpmFee: ResolvedDealData = {
      ...fixture.resolved,
      fees: { ...fixture.resolved.fees, trusteeFeeBps: 3.5 },
    };
    const d = defaultsFromResolved(withPpmFee, fixture.raw);
    expect(d.trusteeFeeBps).toBe(3.5);
  });

  it("bps sanity bound: ignores implausible back-derived values (≥ 50 bps)", () => {
    // If fixture shows e.g. a one-off expense spike that annualizes to 200 bps,
    // the bound prevents polluting the forward projection. Falls back to default.
    const inflatedWaterfall = {
      ...fixture.raw,
      waterfallSteps: fixture.raw!.waterfallSteps?.map((s) =>
        s && s.description && /^\(B\)/i.test(s.description)
          ? { ...s, amountPaid: 10_000_000 } // €10M step B is absurd
          : s,
      ),
    };
    const emptyFees: ResolvedDealData = {
      ...fixture.resolved,
      fees: { ...fixture.resolved.fees, trusteeFeeBps: 0 },
    };
    const d = defaultsFromResolved(emptyFees, inflatedWaterfall);
    expect(d.trusteeFeeBps).toBe(DEFAULT_ASSUMPTIONS.trusteeFeeBps);
  });
});
