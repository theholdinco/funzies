/**
 * D3 — `defaultsFromResolved` pre-fill family.
 *
 * Single helper that pulls observable assumptions from resolver output + raw
 * trustee data, replacing DEFAULT_ASSUMPTIONS for every consumer that needs
 * pre-filled inputs (production-path harness, ProjectionModel UI, N1 harness
 * engine-math mode). Covers:
 *   - baseRate pre-fill (full)
 *   - senior/sub mgmt fee pre-fill — partial (rate plumbing; fee-base
 *     discrepancy is KI-12a's territory, not fixed here)
 *   - trusteeFeeBps + adminFeeBps split-pre-fill (back-derived from Q1
 *     waterfall steps B + C respectively)
 *   - Senior Expenses Cap propagation: bpsPerYear, absoluteFloorEurPerYear,
 *     allocationWithinCap, overflowAllocation flow from
 *     `resolved.seniorExpensesCap` (PPM Condition 1, OC pp. 150-151).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ASSUMPTIONS,
  composeBuildWarnings,
  defaultsFromResolved,
  selectBlockingWarnings,
} from "@/lib/clo/build-projection-inputs";
import type { ResolvedDealData, ResolutionWarning } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof defaultsFromResolved>[1];
};

describe("D3 — defaultsFromResolved (Euro XV fixture)", () => {
  it("pre-fills baseRatePct from observed EURIBOR", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    // Fixture trancheSnapshots carry currentIndexRate = 2.016%
    expect(d.baseRatePct).toBeCloseTo(2.016, 3);
    // Sanity: this is the observed EURIBOR, not the static default (2.1%).
    expect(d.baseRatePct).not.toBe(DEFAULT_ASSUMPTIONS.baseRatePct);
  });

  it("pre-fills senior + sub mgmt fees from resolver PPM extraction", () => {
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

  it("does not block the projection on per-agreement trustee fee once waterfall pre-fill supplied bps", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    const warning: ResolutionWarning = {
      field: "fees.trusteeFeeBps",
      message:
        "Trustee/admin fee found in PPM but rate is 'per agreement' (or otherwise unparseable) — `trusteeFeeBps` stayed at the CLO_DEFAULTS zero.",
      severity: "error",
      blocking: true,
    };

    expect(d.trusteeFeeBps).toBeGreaterThan(0);
    expect(selectBlockingWarnings(composeBuildWarnings(fixture.resolved, d, [warning]))).toEqual([]);
    expect(selectBlockingWarnings(composeBuildWarnings(fixture.resolved, DEFAULT_ASSUMPTIONS, [warning]))).toHaveLength(1);
  });

  it("propagates seniorExpensesCap from resolved (PPM Condition 1, OC pp. 150-151)", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    // Ares CLO XV: bps_per_annum = 2.5, absolute_floor = €300K/yr,
    // sequential B-first within cap, sequential Y-first overflow. Replaces
    // the pre-closure `max(2× observed, 20 bps)` heuristic with the actual
    // PPM-extracted values from `resolved.seniorExpensesCap`.
    expect(d.seniorExpensesCapBps).toBe(2.5);
    expect(d.seniorExpensesCapAbsoluteFloorPerYear).toBe(300000);
    expect(d.seniorExpensesCapAllocationWithinCap).toBe("sequential_b_first");
    expect(d.seniorExpensesCapOverflowAllocation).toBe("sequential_y_first");
    // Cap mechanics: 30/360 day-count for component (a) post-first-PD,
    // CPA base, 3-period rolling carryforward, VAT excluded (Ares XV fees
    // are quoted gross-of-VAT). Each of these is consumed in the engine's
    // cap construction; a regression dropping any of them at the
    // resolver-defaults boundary silently flips the engine to legacy
    // (Actual/360 / APB / no-carryforward / no-VAT) without test signal.
    expect(d.seniorExpensesCapComponentADayCount).toBe("30_360_after_first");
    expect(d.seniorExpensesCapBaseMode).toBe("CPA");
    expect(d.seniorExpensesCapCarryforwardPeriods).toBe(3);
    // Ares XV fees ARE quoted gross-of-VAT in the PPM (the cap is on the
    // VAT-inclusive amount). `vatRatePct` stays null because the gross-up
    // is already baked into the trustee/admin requested values; the
    // explicit gross-up path activates only when fees are quoted net.
    expect(d.seniorExpensesCapVatIncluded).toBe(true);
    expect(d.seniorExpensesCapVatRatePct).toBeNull();
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
    expect(d.expenseReserveDepositAmount).toBe(DEFAULT_ASSUMPTIONS.expenseReserveDepositAmount);
    expect(d.supplementalReserveDepositAmount).toBe(DEFAULT_ASSUMPTIONS.supplementalReserveDepositAmount);
    expect(d.seniorExpensesCapCarryforwardSeedAmount).toBe(
      DEFAULT_ASSUMPTIONS.seniorExpensesCapCarryforwardSeedAmount,
    );
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

  // Helper: replace any existing step (F) entry in the fixture with a
  // synthetic one carrying the given description, sized so the back-derive
  // arithmetic (amount × 4 × 10_000 / beginPar) produces `targetBps`. Used
  // by both the back-derive marker and the description-filter guard so
  // the only structural difference between the two tests is the description.
  function makeRawWithStepF(description: string, targetBps: number) {
    const beginPar = fixture.resolved.poolSummary.totalPrincipalBalance;
    const amount = (targetBps * beginPar) / (4 * 10_000);
    const stepsWithoutF = (fixture.raw!.waterfallSteps ?? []).filter(
      (s) => !(s && s.description != null && /^\(?F\)?\b/i.test(s.description)),
    );
    return {
      ...fixture.raw!,
      waterfallSteps: [
        { description, amountPaid: amount, waterfallType: "INTEREST" },
        ...stepsWithoutF,
      ],
    };
  }

  it("KI-31 Signal 1 — back-derives hedgeCostBps from observed step (F) hedge entry", () => {
    const targetBps = 20;
    const d = defaultsFromResolved(
      fixture.resolved,
      makeRawWithStepF("(F) Hedge Periodic Payment", targetBps),
    );
    expect(d.hedgeCostBps).toBeCloseTo(targetBps, 1);
    // Sanity: not the DEFAULT_ASSUMPTIONS value (0).
    expect(d.hedgeCostBps).not.toBe(DEFAULT_ASSUMPTIONS.hedgeCostBps);
  });

  it("KI-31 Signal 1 — non-hedge step (F) description does NOT back-derive (description filter required)", () => {
    // Defensive: a rogue step F entry without a hedge/swap description
    // (e.g., upstream extraction bug, deal where step F carries something
    // else) must NOT silently classify as hedge cost. Code-only matching
    // would mis-classify; description filter prevents the silent error.
    const d = defaultsFromResolved(
      fixture.resolved,
      makeRawWithStepF("(F) Misclassified Other Payment", 20),
    );
    // Falls through to resolved.hedgeCostBps (0 for Euro XV) and DEFAULT (0).
    expect(d.hedgeCostBps).toBe(0);
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
