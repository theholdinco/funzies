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
 *   - trusteeFeeBps + adminFeeBps direct read from `resolved.fees.*`
 *     (the historical observed-Step-B/C back-derive was removed —
 *     paid amounts are no longer silently promoted to forward rates;
 *     `diagnoseFeePrefill` surfaces them as one-click suggestions)
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
  diagnoseFeePrefill,
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

  it("does NOT back-derive trusteeFeeBps / adminFeeBps from observed Q1 waterfall steps", () => {
    // Pre-fix this site silently set trusteeFeeBps + adminFeeBps from
    // step B/C amountPaid × 4 / beginPar — turning a single quarter's
    // cap-bound paid amount into the live forward-period rate. The
    // back-derive was removed; paid amounts are surfaced as suggestion
    // warnings via `diagnoseFeePrefill` instead. With the Euro XV fixture
    // the resolver fees stay at 0 (PPM rate is "per agreement"), so
    // defaultsFromResolved leaves the assumption at DEFAULT_ASSUMPTIONS
    // and the resolver-time blocking gate will refuse the projection
    // until the user enters an explicit value.
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    expect(d.trusteeFeeBps).toBe(DEFAULT_ASSUMPTIONS.trusteeFeeBps);
    expect(d.adminFeeBps).toBe(0);
  });

  it("does NOT back-derive taxesBps / issuerProfitAmount from observed step A(i)/A(ii)", () => {
    // Same shape as the trustee/admin removal — observed-paid is not
    // contractual-forward. Issuer corporate tax (Section 110 / 12.5% on
    // taxable income) does not scale with par; Issuer Profit Amount is a
    // fixed € per period defined in the deal docs, not a single-quarter
    // paid amount extrapolated forward.
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    expect(d.taxesBps).toBe(DEFAULT_ASSUMPTIONS.taxesBps);
    expect(d.issuerProfitAmount).toBe(DEFAULT_ASSUMPTIONS.issuerProfitAmount);
  });

  it("diagnoseFeePrefill emits one INFO suggestion per observed waterfall step (taxes/profit/trustee/admin)", () => {
    const d = defaultsFromResolved(fixture.resolved, fixture.raw);
    const suggestions = diagnoseFeePrefill(fixture.resolved, fixture.raw, d);
    const byField = new Map(suggestions.map((w) => [w.field, w]));
    // All four fields surface a suggestion — the user can one-click these
    // via the Context Editor "Use suggested value" affordance.
    expect(byField.get("assumptions.taxesBps")?.severity).toBe("info");
    expect(byField.get("assumptions.taxesBps")?.suggestedValue).toBeGreaterThan(0);
    expect(byField.get("assumptions.issuerProfitAmount")?.severity).toBe("info");
    expect(byField.get("assumptions.issuerProfitAmount")?.suggestedValue).toBeCloseTo(250, 0);
    expect(byField.get("assumptions.trusteeFeeBps")?.severity).toBe("info");
    expect(byField.get("assumptions.trusteeFeeBps")?.suggestedValue).toBeCloseTo(0.0969, 3);
    expect(byField.get("assumptions.adminFeeBps")?.severity).toBe("info");
    expect(byField.get("assumptions.adminFeeBps")?.suggestedValue).toBeCloseTo(5.147, 2);
    // Suggestions are non-blocking by construction — they never appear in
    // the IncompleteData banner.
    for (const s of suggestions) expect(s.blocking).toBe(false);
  });

  it("clears the resolver-time per-agreement blocking gate once the user enters a positive trustee fee", () => {
    const warning: ResolutionWarning = {
      field: "fees.trusteeFeeBps",
      message:
        "Trustee fee found in PPM but rate is 'per agreement' (or otherwise unparseable) — `trusteeFeeBps` stayed at the CLO_DEFAULTS zero.",
      severity: "error",
      blocking: true,
    };
    const userSet = { ...DEFAULT_ASSUMPTIONS, trusteeFeeBps: 0.1 };
    expect(selectBlockingWarnings(composeBuildWarnings(fixture.resolved, userSet, [warning]))).toEqual([]);
    expect(selectBlockingWarnings(composeBuildWarnings(fixture.resolved, DEFAULT_ASSUMPTIONS, [warning]))).toHaveLength(1);
  });

  it("clears the admin / taxes / issuer-profit gates symmetrically once each assumption is set positive", () => {
    // Message text mirrors the resolver's actual warnings so the
    // composeBuildWarnings discriminator regexes match. A future change
    // to the gate text without updating these regexes would break the
    // un-block path silently — this test pins the bijection.
    const warnings: ResolutionWarning[] = [
      {
        field: "fees.adminFeeBps",
        message: "Administrative expenses fee found in PPM but rate is 'per agreement' (or otherwise unparseable).",
        severity: "error",
        blocking: true,
      },
      {
        field: "assumptions.taxesBps",
        message: "PPM waterfall mentions Issuer taxes (step A(i)) but no per-deal rate is extracted.",
        severity: "error",
        blocking: true,
      },
      {
        field: "assumptions.issuerProfitAmount",
        message: "PPM waterfall mentions Issuer Profit Amount (step A(ii)) but no per-deal value is extracted.",
        severity: "error",
        blocking: true,
      },
    ];
    const userSet = {
      ...DEFAULT_ASSUMPTIONS,
      adminFeeBps: 5,
      taxesBps: 0.01,
      issuerProfitAmount: 250,
    };
    expect(selectBlockingWarnings(composeBuildWarnings(fixture.resolved, userSet, warnings))).toEqual([]);
    expect(
      selectBlockingWarnings(composeBuildWarnings(fixture.resolved, DEFAULT_ASSUMPTIONS, warnings)),
    ).toHaveLength(3);
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
  it("null raw → falls back to resolver-only pre-fills (no baseRate)", () => {
    const d = defaultsFromResolved(fixture.resolved, null);
    expect(d.baseRatePct).toBe(DEFAULT_ASSUMPTIONS.baseRatePct); // no trancheSnapshots → default
    expect(d.seniorFeePct).toBe(0.15); // resolver still works
    expect(d.trusteeFeeBps).toBe(DEFAULT_ASSUMPTIONS.trusteeFeeBps); // no waterfall → default (0)
  });

  it("resolved.fees all zero (no PPM extraction) → everything falls through to DEFAULT_ASSUMPTIONS", () => {
    const emptyFees: ResolvedDealData = {
      ...fixture.resolved,
      fees: { seniorFeePct: 0, subFeePct: 0, trusteeFeeBps: 0, adminFeeBps: 0, incentiveFeePct: 0, incentiveFeeHurdleIrr: 0 },
    };
    const d = defaultsFromResolved(emptyFees, { trancheSnapshots: null, waterfallSteps: null });
    expect(d.seniorFeePct).toBe(DEFAULT_ASSUMPTIONS.seniorFeePct);
    expect(d.subFeePct).toBe(DEFAULT_ASSUMPTIONS.subFeePct);
    expect(d.incentiveFeePct).toBe(DEFAULT_ASSUMPTIONS.incentiveFeePct);
    expect(d.trusteeFeeBps).toBe(DEFAULT_ASSUMPTIONS.trusteeFeeBps);
    expect(d.adminFeeBps).toBe(0);
  });

  it("trusteeFeeBps from PPM extraction is consumed directly (parallel to senior/sub mgmt)", () => {
    // If the resolver successfully extracted a numeric trustee rate (e.g.,
    // PPM quoted "0.5 bps p.a." with rateUnit bps_pa), defaultsFromResolved
    // reads it through. The waterfall-step-B back-derive that used to fire
    // here was removed — paid amounts are surfaced as suggestions only.
    const withPpmFee: ResolvedDealData = {
      ...fixture.resolved,
      fees: { ...fixture.resolved.fees, trusteeFeeBps: 3.5 },
    };
    const d = defaultsFromResolved(withPpmFee, fixture.raw);
    expect(d.trusteeFeeBps).toBe(3.5);
  });

  it("adminFeeBps from PPM extraction is consumed directly (C3 split symmetric to trustee)", () => {
    const withPpmAdmin: ResolvedDealData = {
      ...fixture.resolved,
      fees: { ...fixture.resolved.fees, adminFeeBps: 4.2 },
    };
    const d = defaultsFromResolved(withPpmAdmin, fixture.raw);
    expect(d.adminFeeBps).toBe(4.2);
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

  it("KI-31 Signal 1 — does NOT back-derive hedgeCostBps from observed step F (silent-fallback removal, 2026-05-16)", () => {
    // Pre-fix this site silently set hedgeCostBps from step F amountPaid × 4 / par
    // when description matched /hedge|swap/i. The back-derive was removed for
    // the same reason as trustee/admin/taxes/profit — paid amount is not the
    // contractual forward rate. defaultsFromResolved now leaves hedgeCostBps
    // at DEFAULT_ASSUMPTIONS unless resolved.hedgeCostBps carries a positive
    // PPM-extracted value.
    const d = defaultsFromResolved(
      fixture.resolved,
      makeRawWithStepF("(F) Hedge Periodic Payment", 20),
    );
    expect(d.hedgeCostBps).toBe(DEFAULT_ASSUMPTIONS.hedgeCostBps);
  });

  it("diagnoseFeePrefill — emits a hedge suggestion (info, with suggestedValue) when step F has hedge description and positive paid amount", () => {
    const targetBps = 20;
    const raw = makeRawWithStepF("(F) Hedge Periodic Payment", targetBps);
    const d = defaultsFromResolved(fixture.resolved, raw);
    const suggestions = diagnoseFeePrefill(fixture.resolved, raw, d);
    const hedgeSuggestion = suggestions.find((w) => w.field === "assumptions.hedgeCostBps");
    expect(hedgeSuggestion).toBeDefined();
    expect(hedgeSuggestion!.severity).toBe("info");
    expect(hedgeSuggestion!.blocking).toBe(false);
    expect(hedgeSuggestion!.suggestedValue).toBeCloseTo(targetBps, 1);
  });

  it("diagnoseFeePrefill — non-hedge step F description produces NO hedge suggestion (description filter still load-bearing)", () => {
    // Defensive: a rogue step F entry without a hedge/swap description
    // (e.g., upstream extraction bug, deal where step F carries something
    // else) must NOT generate a hedge suggestion. Description filter
    // prevents silent mis-classification at both the suggestion site and
    // the composeBuildWarnings hedge gate.
    const raw = makeRawWithStepF("(F) Misclassified Other Payment", 20);
    const d = defaultsFromResolved(fixture.resolved, raw);
    const suggestions = diagnoseFeePrefill(fixture.resolved, raw, d);
    const hedgeSuggestion = suggestions.find((w) => w.field === "assumptions.hedgeCostBps");
    expect(hedgeSuggestion).toBeUndefined();
    expect(d.hedgeCostBps).toBe(0);
  });

  it("trustee/admin suggestion bps sanity bound: implausible (≥ 50 bps) values produce no suggestion", () => {
    // If raw.waterfallSteps shows a one-off expense spike that annualizes
    // beyond 50 bps (e.g. €10M step B), the diagnoseFeePrefill bound
    // suppresses the suggestion rather than offering a wildly off value
    // for one-click acceptance.
    const inflatedWaterfall = {
      ...fixture.raw,
      waterfallSteps: fixture.raw!.waterfallSteps?.map((s) =>
        s && s.description && /^\(B\)/i.test(s.description)
          ? { ...s, amountPaid: 10_000_000 } // €10M step B is absurd
          : s,
      ),
    };
    const d = defaultsFromResolved(fixture.resolved, inflatedWaterfall);
    const suggestions = diagnoseFeePrefill(fixture.resolved, inflatedWaterfall, d);
    const trusteeSuggestion = suggestions.find((w) => w.field === "assumptions.trusteeFeeBps");
    expect(trusteeSuggestion).toBeUndefined();
  });
});
