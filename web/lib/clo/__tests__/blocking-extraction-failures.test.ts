/**
 * Per-site marker tests for the silent-extraction-failure sites in the
 * resolver. Each test mutates the Euro XV fixture's `raw` to remove or
 * break the field, runs the real `resolveWaterfallInputs`, and asserts:
 *
 *   1. The expected warning fires with `severity: "error"` AND
 *      `blocking: true` (the gate's predicate).
 *   2. `buildFromResolved(resolved, DEFAULT_ASSUMPTIONS, warnings)`
 *      throws `IncompleteDataError` carrying that warning.
 *
 * If a future PR drops `blocking: true` from a site, its marker test
 * fails immediately rather than waiting for a portability incident
 * to surface the regression. This file IS the canonical inventory of
 * blocking-warning sites — adding a new site means adding an `it()`
 * block here in the same change.
 *
 * Each test deep-clones the fixture before mutation so tests can run
 * in any order without state leakage.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWaterfallInputs } from "@/lib/clo/resolver";
import {
  buildFromResolved,
  DEFAULT_ASSUMPTIONS,
  IncompleteDataError,
} from "@/lib/clo/build-projection-inputs";
import type { ResolutionWarning } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");

interface RawFixture {
  raw: {
    constraints: any;
    complianceData: any;
    tranches: any[];
    trancheSnapshots: any[];
    holdings: any[];
    dealDates: any;
    accountBalances: any[];
    parValueAdjustments: any[];
  };
}

function loadRaw(): RawFixture["raw"] {
  return JSON.parse(JSON.stringify(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")).raw));
}

function runResolver(
  raw: RawFixture["raw"],
  intexPositions?: Map<string, import("../resolve-rating").IntexPositionRow>,
) {
  return resolveWaterfallInputs(
    raw.constraints,
    raw.complianceData,
    raw.tranches,
    raw.trancheSnapshots,
    raw.holdings,
    raw.dealDates,
    raw.accountBalances,
    raw.parValueAdjustments,
    intexPositions,
  );
}

function expectBlockingError(w: ResolutionWarning | undefined, fieldHint: string) {
  expect(w, `Expected blocking warning matching ${fieldHint}; got none.`).toBeDefined();
  expect(w!.severity).toBe("error");
  expect(w!.blocking).toBe(true);
}

function expectGateThrows(
  resolved: ReturnType<typeof runResolver>["resolved"],
  warnings: ResolutionWarning[],
) {
  expect(() =>
    buildFromResolved(resolved, DEFAULT_ASSUMPTIONS, warnings),
  ).toThrow(IncompleteDataError);
}

describe("Pattern A (silent fallback to common default)", () => {
  it("diversionPct (resolver.ts:861) — diversionAmount unparseable → blocking", () => {
    const raw = loadRaw();
    raw.constraints.reinvestmentOcTest.diversionAmount = "no percent here";
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) =>
      w.field === "reinvestmentOcTrigger.diversionPct",
    );
    expectBlockingError(w, "reinvestmentOcTrigger.diversionPct");
    expectGateThrows(resolved, warnings);
  });

  it("diversionPct (resolver.ts:870) — trigger present but no diversionAmount → blocking", () => {
    const raw = loadRaw();
    raw.constraints.reinvestmentOcTest = { trigger: "103.74%" };
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) =>
      w.field === "reinvestmentOcTrigger.diversionPct",
    );
    expectBlockingError(w, "reinvestmentOcTrigger.diversionPct (no-diversionAmount path)");
    expectGateThrows(resolved, warnings);
  });

  it("incentiveFeeHurdleIrr (resolver.ts:536) — incentive fee present but no hurdleRate → blocking", () => {
    const raw = loadRaw();
    const incFee = (raw.constraints.fees as any[]).find((f: any) =>
      (f.name ?? "").toLowerCase().includes("incentive"),
    );
    expect(incFee).toBeDefined();
    delete incFee.hurdleRate;
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "fees.incentiveFeeHurdleIrr");
    expectBlockingError(w, "fees.incentiveFeeHurdleIrr");
    expectGateThrows(resolved, warnings);
  });

  it("maturityDate fallback (resolver.ts:814) — no maturity in keyDates or dealDates → blocking", () => {
    const raw = loadRaw();
    if (raw.constraints.keyDates) raw.constraints.keyDates.maturityDate = null;
    if (raw.dealDates) raw.dealDates.maturity = null;
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "dates.maturity");
    expectBlockingError(w, "dates.maturity");
    expectGateThrows(resolved, warnings);
  });

  it("cccBucketLimitPct — excessCccAdjustment missing → blocking", () => {
    const raw = loadRaw();
    delete (raw.constraints as any).excessCccAdjustment;
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "cccBucketLimitPct");
    expectBlockingError(w, "cccBucketLimitPct");
    expectGateThrows(resolved, warnings);
  });

  it("cccMarketValuePct — excessCccAdjustment missing → blocking", () => {
    const raw = loadRaw();
    delete (raw.constraints as any).excessCccAdjustment;
    const { resolved, warnings } = runResolver(raw);
    // Same missing-object root cause emits BOTH field warnings; this marker
    // pins the second emission so a future change that drops one of the two
    // pushes fails immediately.
    const w = warnings.find((w) => w.field === "cccMarketValuePct");
    expectBlockingError(w, "cccMarketValuePct");
    expectGateThrows(resolved, warnings);
  });

  it("cccMarketValuePct — unparseable inner field → blocking + atomic null return", () => {
    const raw = loadRaw();
    (raw.constraints as any).excessCccAdjustment = { thresholdPct: "7.5", marketValuePct: "per agreement" };
    const { resolved, warnings } = runResolver(raw);
    // Distinct code path: object present, inner string parses to NaN.
    const w = warnings.find((w) => w.field === "cccMarketValuePct");
    expectBlockingError(w, "cccMarketValuePct (unparseable)");
    // Atomic-return invariant: thresholdPct parses to 7.5 cleanly, but
    // marketValuePct is invalid → both fields collapse to null. Prevents a
    // hybrid (per-deal threshold × global market-value floor) leaking through
    // if the gate were ever bypassed or refactored.
    expect(resolved.cccBucketLimitPct).toBeNull();
    expect(resolved.cccMarketValuePct).toBeNull();
    expectGateThrows(resolved, warnings);
  });

  it("cccBucketLimitPct — fraction-shape mis-extraction (0.075) → blocking + atomic null return", () => {
    const raw = loadRaw();
    (raw.constraints as any).excessCccAdjustment = { thresholdPct: "0.075", marketValuePct: "70" };
    const { resolved, warnings } = runResolver(raw);
    // Distinct code path: parseable but outside plausible range. Without this
    // guard, parseFloat("0.075") would pass 0.075 through, applying a 100×
    // too-tight haircut cap silently.
    const w = warnings.find((w) => w.field === "cccBucketLimitPct");
    expectBlockingError(w, "cccBucketLimitPct (fraction-shape)");
    // Atomic-return invariant from the opposite side: thresholdPct fails the
    // range check, marketValuePct = 70 is valid → both fields still collapse
    // to null. Half-good output (thresholdPct=null, marketValuePct=70) would
    // pass every other test in this file but is the exact shape the atomic
    // return is designed to prevent.
    expect(resolved.cccBucketLimitPct).toBeNull();
    expect(resolved.cccMarketValuePct).toBeNull();
    expectGateThrows(resolved, warnings);
  });

  it("accountBalances — missing/empty section on an ingested-trustee deal → blocking", () => {
    // Every CLO trustee report carries an Accounts section (Principal Account,
    // Interest Account, Expense Reserve, Supplemental Reserve, Smoothing). When
    // the trustee bundle is otherwise present (compliance data + tranche
    // snapshots) but `accountBalances` is empty, the SDF Accounts CSV was not
    // parsed for this period — partial extraction. Silent fallback to all-zero
    // balances would understate equity-side cash claims and (for the Principal
    // Account specifically) misstate the OC numerator's signed-overdraft term.
    // Synthetic resolver tests with empty `complianceData` or empty
    // `trancheSnapshots` are not real deals and bypass this gate by construction.
    const raw = loadRaw();
    raw.accountBalances = [];
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "accountBalances");
    expectBlockingError(w, "accountBalances");
    // Resolver still returns the (zeroed) data shape; the warning is the
    // partner-facing signal and IncompleteDataError is the gate.
    expect(resolved.principalAccountCash).toBe(0);
    expect(resolved.interestAccountCash).toBe(0);
    expect(resolved.interestSmoothingBalance).toBe(0);
    expect(resolved.supplementalReserveBalance).toBe(0);
    expect(resolved.expenseReserveBalance).toBe(0);
    expectGateThrows(resolved, warnings);
  });

  it("nonCallPeriodEnd (resolver.ts:1064) — missing in keyDates → blocking", () => {
    // Every CLO has a PPM-defined Non-Call Period (Condition 7.2); a
    // null-return is an extraction gap, not a deal without one. The
    // engine's runtime guard on pre-NCP callDates is gated on this field —
    // a silent null here would let a user modelling a call produce an IRR
    // for an economically impossible scenario, bypassing the engine gate.
    const raw = loadRaw();
    if (raw.constraints.keyDates) raw.constraints.keyDates.nonCallPeriodEnd = null;
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "dates.nonCallPeriodEnd");
    expectBlockingError(w, "dates.nonCallPeriodEnd");
    expect(resolved.dates.nonCallPeriodEnd).toBeNull();
    expectGateThrows(resolved, warnings);
  });

  it("referenceWeightedAverageFixedCoupon — fixed-rate deal + missing refWAFC → blocking", () => {
    // Euro XV holds fixed-rate obligations (84 holdings carry isFixedRate=true).
    // With those positions present, the Excess WAC term in the Floating WAS
    // formula `(wafc − refWAFC) × 100 × (fixedPar/floatingPar)` is non-zero
    // and depends on the per-deal anchor refWAFC. Stripping the extracted
    // anchor on a fixed-rate deal must block — the prior implementation
    // hardcoded 4.0% as a deal-family default which silently mis-anchored
    // any non-Ares deal.
    const raw = loadRaw();
    if (raw.constraints.interestMechanics) {
      delete raw.constraints.interestMechanics.referenceWeightedAverageFixedCoupon;
      delete raw.constraints.interestMechanics.reference_weighted_average_fixed_coupon;
    }
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "referenceWeightedAverageFixedCoupon");
    expectBlockingError(w, "referenceWeightedAverageFixedCoupon (fixed-rate deal)");
    expect(resolved.referenceWeightedAverageFixedCoupon).toBeNull();
    expectGateThrows(resolved, warnings);
  });

  it("seniorExpensesCap (resolver.ts:677) — block missing on a non-greenfield deal → blocking", () => {
    // PPM Condition 1 Senior Expenses Cap is the cap on steps (B) trustee +
    // (C) admin. Bps, absolute floor, allocation rules, day-count, base
    // (CPA vs APB), carryforward periods, and VAT mechanics are all deal-
    // specific. Falling back to UI/test defaults silently mis-caps fees on
    // every period of every non-Ares deal. Carve-out: greenfield fixtures
    // (no `fees` rows extracted) skip the gate so legacy DEFAULT_ASSUMPTIONS
    // values flow through synthetic test inputs.
    const raw = loadRaw();
    raw.constraints.seniorExpensesCap = null;
    expect((raw.constraints.fees ?? []).length).toBeGreaterThan(0);
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "seniorExpensesCap");
    expectBlockingError(w, "seniorExpensesCap (non-greenfield deal missing block)");
    expectGateThrows(resolved, warnings);
  });

  it("hedgeCostBps (resolver.ts:728) — hedge fee row present but rate unparseable → blocking", () => {
    // KI-31 closure (Signal 2). When a /hedge|swap/i fee row is extracted
    // but the rate is unparseable ("per agreement", null, etc.), silent
    // fallback to 0 would emit zero step (F) every period on a hedged
    // deal — partner-facing under-statement of senior expenses, residual
    // cascading silently into subDistribution. Refuse to run.
    const raw = loadRaw();
    raw.constraints.fees = [
      ...(raw.constraints.fees ?? []),
      { name: "Hedge Cost", rate: "per agreement", rateUnit: null },
    ];
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "hedgeCostBps");
    expectBlockingError(w, "hedgeCostBps (unparseable rate)");
    expectGateThrows(resolved, warnings);
  });

  it("hedgeCostBps (resolver.ts:728) — hedge fee row with no-unit rate (any magnitude) → blocking", () => {
    // KI-31 closure (Signal 2), distinct branch from above. When a
    // periodic /hedge|swap/i fee row has no rateUnit, we BLOCK
    // regardless of rate magnitude. Hedge cost conventions vary by
    // instrument (IR swaps typically bps_pa; currency hedges quoted
    // both ways) — the management-fee "small values are pct_pa"
    // heuristic that `toPctPa` uses cannot disambiguate hedge cost
    // safely. Wrong-direction interpretation produces a 100× error;
    // forcing explicit rateUnit is principle 3 strict for this
    // domain. Test asserts that even a small (≤ 5) value blocks —
    // the prior heuristic permitted that case as silent pct_pa
    // conversion, which a closure of this stripe must not preserve.
    const raw = loadRaw();
    raw.constraints.fees = [
      ...(raw.constraints.fees ?? []),
      { name: "Hedge Cost", rate: "5", rateUnit: null },
    ];
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "hedgeCostBps");
    expectBlockingError(w, "hedgeCostBps (no-unit, any rate)");
    expectGateThrows(resolved, warnings);
  });

  it("discountObligationRule — block missing on a non-greenfield deal → blocking", () => {
    // PPM Condition 1 Discount Obligation classification + cure rule. The
    // classification threshold (e.g. floating < 80%, fixed < 75% of par
    // for the Ares family) drives the per-position OC numerator haircut at
    // every period plus the price-aware reinvestment cure math.
    // Falling back to a hardcoded threshold silently neutralizes the
    // discount-obligation mechanic on the next deal whose threshold
    // differs. Carve-out: greenfield fixtures (no holdings rows) skip the
    // gate — there's nothing to classify and the rule's absence is
    // harmless.
    const raw = loadRaw();
    raw.constraints.discountObligation = null;
    expect(raw.holdings.length).toBeGreaterThan(0);
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "discountObligationRule");
    expectBlockingError(w, "discountObligationRule (non-greenfield deal missing block)");
    expectGateThrows(resolved, warnings);
  });

  it("longDatedValuationRule — block missing on a non-greenfield deal → blocking", () => {
    // PPM Condition 1 "Long-Dated Collateral Obligation" + Aggregate
    // Principal Balance "deemed zero" valuation rule. The cap percentage
    // (Ares XV: 5% APB) and capBase drive the per-position long-dated
    // haircut Σ at every period; without the rule the engine emits zero
    // long-dated haircut which silently understates the OC numerator
    // deduction on any deal with positions whose stated maturity exceeds
    // deal life. Carve-out: greenfield fixtures (no active holdings) skip
    // the gate — nothing to classify.
    const raw = loadRaw();
    raw.constraints.longDatedObligation = null;
    expect(raw.holdings.length).toBeGreaterThan(0);
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "longDatedValuationRule");
    expectBlockingError(w, "longDatedValuationRule (non-greenfield deal missing block)");
    expectGateThrows(resolved, warnings);
  });

  it("longDatedValuationRule.postCap.agency_cv_min — selected without per-position S&P/Fitch CV ingestion → blocking", () => {
    // postCap.agency_cv_min requires per-position S&P + Fitch CV to value
    // above-cap par as min(spCV, fitchCV). ResolvedLoan carries no
    // CV fields today, so a deal selecting this variant cannot be valued
    // by the engine. Resolver refuses to construct the rule and emits a
    // blocking warning naming the missing per-position fields, gating the
    // projection rather than running with a silent fallback.
    const raw = loadRaw();
    raw.constraints.longDatedObligation = {
      capPctOfBase: 2.5,
      capBase: "CPA",
      withinCap: { type: "tiered_mv_or_capped", cliffYearsPastStatedMaturity: 2, cappedPricePct: 70 },
      postCap: { type: "agency_cv_min" },
      sourcePages: null,
      sourceCondition: null,
    };
    expect(raw.holdings.length).toBeGreaterThan(0);
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "longDatedValuationRule.postCap");
    expectBlockingError(w, "longDatedValuationRule.postCap.agency_cv_min (missing per-position CV)");
    expectGateThrows(resolved, warnings);
  });
});

describe("Pattern B (silent acceptance of sentinel value)", () => {
  // Helper: a non-subordinated tranche / capital-structure entry. Uses the
  // structural flags the resolver itself uses (`isIncomeNote`, `isSubordinate`,
  // class-name "sub"/"equity"/"income" substring) — never literal class names.
  // Per CLAUDE.md principle 1, tests should not overfit to a single deal's
  // tranche naming. Zeroing every non-sub spread / PPM entry ensures the
  // zero-spread guard fires regardless of which tranche the fixture happens
  // to put first.
  function isNonSub(className: string | undefined | null, flags: { isIncomeNote?: boolean; isSubordinate?: boolean; isSubordinated?: boolean } = {}): boolean {
    if (flags.isIncomeNote || flags.isSubordinate || flags.isSubordinated) return false;
    const n = ((className ?? "") as string).toLowerCase();
    return !n.includes("sub") && !n.includes("equity") && !n.includes("income");
  }

  it("spreadBps = 0 PPM path (resolver.ts:281) — no DB tranches, all PPM non-sub spreads zero → blocking", () => {
    const raw = loadRaw();
    // Force the PPM-fallback branch by passing dbTranches: [] (the resolver
    // takes the PPM-only path when no DB tranches are supplied).
    raw.tranches = [];
    raw.trancheSnapshots = [];
    let zeroed = 0;
    for (const c of (raw.constraints.capitalStructure as any[]) ?? []) {
      if (!isNonSub(c.class, c)) continue;
      c.spreadBps = 0;
      c.spread = null;
      zeroed++;
    }
    expect(zeroed, "no non-sub PPM capital-structure entries to zero").toBeGreaterThan(0);
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field.endsWith(".spreadBps"));
    expectBlockingError(w, "<non-sub>.spreadBps (PPM path)");
    expectGateThrows(resolved, warnings);
  });

  it("spreadBps = 0 DB path (resolver.ts:211) — all non-sub DB + PPM spreads zero → blocking", () => {
    const raw = loadRaw();
    let zeroedTranches = 0;
    for (const t of raw.tranches as any[]) {
      if (!isNonSub(t.className, t)) continue;
      t.spreadBps = 0;
      t.referenceRate = null;
      zeroedTranches++;
    }
    expect(zeroedTranches, "no non-sub DB tranches to zero").toBeGreaterThan(0);
    // Also zero PPM capital-structure entries to defeat the PPM-spread-fallback
    // path that would otherwise restore a spread for any tranche with `spreadBps == null`.
    for (const c of (raw.constraints.capitalStructure as any[]) ?? []) {
      if (!isNonSub(c.class, c)) continue;
      c.spreadBps = 0;
      c.spread = null;
    }
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field.endsWith(".spreadBps"));
    expectBlockingError(w, "<non-sub>.spreadBps (DB path)");
    expectGateThrows(resolved, warnings);
  });

  it("OC trigger 10-90% band (resolver.ts:416) — implausible trigger → blocking", () => {
    const raw = loadRaw();
    // Set the first OC test's triggerLevel into the no-man's-land (50%).
    const ocTest = (raw.complianceData.complianceTests as any[]).find(
      (t: any) => t.testType === "OC_PAR",
    );
    expect(ocTest).toBeDefined();
    ocTest.triggerLevel = 50;
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find(
      (w) => w.field.startsWith("ocTrigger.") && w.message.includes("implausible"),
    );
    expectBlockingError(w, "ocTrigger.* (10-90% band)");
    expectGateThrows(resolved, warnings);
  });

  it("seniorFeePct = 0 (resolver.ts:566) — no Senior CMF in fees[] → blocking", () => {
    const raw = loadRaw();
    raw.constraints.fees = (raw.constraints.fees as any[]).filter((f: any) => {
      const n = (f.name ?? "").toLowerCase();
      return !(n.includes("senior") && (n.includes("mgmt") || n.includes("management")));
    });
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "fees.seniorFeePct");
    expectBlockingError(w, "fees.seniorFeePct");
    expectGateThrows(resolved, warnings);
  });

  it("subFeePct = 0 (resolver.ts:577) — no Sub CMF in fees[] → blocking", () => {
    const raw = loadRaw();
    raw.constraints.fees = (raw.constraints.fees as any[]).filter((f: any) => {
      const n = (f.name ?? "").toLowerCase();
      return !(n.includes("sub") && (n.includes("mgmt") || n.includes("management")));
    });
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "fees.subFeePct");
    expectBlockingError(w, "fees.subFeePct");
    expectGateThrows(resolved, warnings);
  });

  it("totalPar = 0 (resolver.ts:746) — empty pool summary → blocking", () => {
    const raw = loadRaw();
    if (raw.complianceData?.poolSummary) {
      raw.complianceData.poolSummary.totalPar = 0;
      raw.complianceData.poolSummary.totalPrincipalBalance = 0;
    }
    raw.holdings = [];
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "poolSummary.totalPar");
    expectBlockingError(w, "poolSummary.totalPar");
    expectGateThrows(resolved, warnings);
  });

  it("reinvestment OC fall-through (resolver.ts:post-L1013) — PPM mentions reinvOC but no usable trigger → blocking", () => {
    const raw = loadRaw();
    // The fall-through gate fires when ALL three sources miss:
    //   (1) compliance reinvestment-OC test missing or triggerLevel null,
    //   (2) PPM raw reinvestmentOcTest exists but trigger < 103 (filtered),
    //   (3) no class OC trigger ≥ 103 (most-junior fallback empty).
    // The fixture below trips all three. Note: dropping class OC tests
    // also trips the L374 ocTriggers-empty blocking gate (Step 2.1) — the
    // test asserts our specific reinvestmentOcTrigger warning fires, not
    // that it's the only blocking warning emitted on the mutated fixture.

    // (1) and (3) — drop reinvestment-OC compliance tests AND class OC tests
    raw.complianceData.complianceTests = (raw.complianceData.complianceTests as any[]).filter((t: any) => {
      const name = (t.testName ?? "").toLowerCase();
      if (name.includes("reinvestment") && (t.testType === "INTEREST_DIVERSION" || name.includes("oc") || name.includes("overcollateral"))) return false;
      const tt = (t.testType ?? "").toLowerCase();
      if (tt === "oc_par" || tt === "oc_mv" || tt === "overcollateralization" || tt.startsWith("oc")) return false;
      if (name.includes("overcollateral") || name.includes("par value")) return false;
      if (name.includes("oc") && name.includes("ratio")) return false;
      return true;
    });
    raw.constraints.coverageTestEntries = [];

    // (2) — set reinvOcRaw with trigger < 103 so L951-970 path filters it out
    //       AND satisfies our gate's `reinvOcRaw != null` half.
    raw.constraints.reinvestmentOcTest = { ...(raw.constraints.reinvestmentOcTest ?? {}), trigger: "100" };

    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) =>
      w.field === "reinvestmentOcTrigger" && w.message.includes("no fall-through path produced a usable trigger"),
    );
    expectBlockingError(w, "reinvestmentOcTrigger (fall-through)");
    expectGateThrows(resolved, warnings);
  });

  it("IC trigger 10-90% band (resolver.ts:420) — implausible IC trigger → blocking", () => {
    const raw = loadRaw();
    // Sibling shape to the OC band marker. Take an IC test, set triggerLevel
    // to 50 (no man's land — IC triggers are typically 100-200%, never
    // 10-90%). The new IC band gate refuses rather than projecting against
    // an always-passing test.
    const icTest = (raw.complianceData.complianceTests as any[]).find(
      (t: any) => t.testType === "IC",
    );
    expect(icTest, "fixture should have an IC test").toBeDefined();
    icTest.triggerLevel = 50;
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find(
      (w) => w.field.startsWith("icTrigger.") && w.message.includes("implausible"),
    );
    expectBlockingError(w, "icTrigger.* (10-90% band)");
    expectGateThrows(resolved, warnings);
  });

  it("deferredInterestCompounds (resolver.ts:1282) — deferrable tranches with non-boolean PIK info → blocking", () => {
    const raw = loadRaw();
    // Euro XV's tranches have isDeferrable:null today even though the PPM
    // semantically marks class C-F as deferrable (`interest_deferral`
    // sub-object) — the fixture didn't propagate to per-tranche flags.
    // Inject isDeferrable:true on Class C to satisfy the `.some()` predicate;
    // ALSO inject a non-boolean deferredInterestCompounds so the typeof
    // guard at L1279 fails and the warn branch fires.
    const classC = (raw.tranches as any[]).find(
      (t: any) => (t.className ?? "").toLowerCase().includes("class c"),
    );
    expect(classC, "fixture should have a Class C tranche").toBeDefined();
    classC.isDeferrable = true;
    raw.constraints.interestMechanics = {
      ...(raw.constraints.interestMechanics ?? {}),
      deferredInterestCompounds: "unknown",
    };
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "deferredInterestCompounds");
    expectBlockingError(w, "deferredInterestCompounds");
    expectGateThrows(resolved, warnings);
  });

  it("DDTL no parent (resolver.ts:1073) — DDTL holding with no matching parent facility → blocking", () => {
    const raw = loadRaw();
    // Euro XV has zero DDTL holdings (verified by grep). Convert an active
    // non-DDTL holding to DDTL and give it a unique obligor name (no other
    // holding shares it), so the resolver's parent-match (filter by
    // obligorName equality on funded holdings) returns empty and falls
    // through to the WAC-spread substitution.
    const holding = (raw.holdings as any[]).find(
      (h: any) =>
        !h.isDelayedDraw &&
        !h.isDefaulted &&
        (h.parBalance ?? 0) > 0,
    );
    expect(holding, "fixture should have an active non-DDTL holding").toBeDefined();
    holding.isDelayedDraw = true;
    holding.obligorName = "KI59_TEST_OBLIGOR_NO_PARENT_MATCH";
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) =>
      w.field === "ddtlSpreadBps" && w.message.includes("no matching parent"),
    );
    expectBlockingError(w, "ddtlSpreadBps (no parent)");
    expectGateThrows(resolved, warnings);
  });

  it("fixedCouponPct from WAC (resolver.ts:1046) — fixed-rate loan with no allInRate or spreadBps → blocking", () => {
    const raw = loadRaw();
    // Same fixture shape as the spreadBps-proxy marker but ALSO null
    // spreadBps so the resolver falls through to the WAC fallback. Magnitude
    // is unbounded vs the proxy fallback (any fixed-coupon-vs-WAC divergence
    // becomes silent error per period × loan life).
    const holding = (raw.holdings as any[]).find(
      (h: any) =>
        h.isFixedRate === true &&
        !h.isDefaulted &&
        !h.isDelayedDraw &&
        (h.parBalance ?? 0) > 0,
    );
    expect(holding, "fixture should have an active fixed-rate holding").toBeDefined();
    holding.allInRate = null;
    holding.spreadBps = null;
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) =>
      w.field === "fixedCouponPct" && w.message.includes("fall back to pool WAC"),
    );
    expectBlockingError(w, "fixedCouponPct (WAC fallback)");
    expectGateThrows(resolved, warnings);
  });

  it("fixedCouponPct from spreadBps (resolver.ts:1038) — fixed-rate loan with no allInRate → blocking", () => {
    const raw = loadRaw();
    // Find an active fixed-rate holding (Euro XV has 42, all with allInRate
    // set and spreadBps null today — no production impact). Null its
    // allInRate AND inject a spreadBps so the resolver's spreadBps-proxy
    // branch fires; without an injected spreadBps the resolver would take
    // the WAC fallback (Step 2.5's site) instead.
    const holding = (raw.holdings as any[]).find(
      (h: any) =>
        h.isFixedRate === true &&
        !h.isDefaulted &&
        !h.isDelayedDraw &&
        (h.parBalance ?? 0) > 0,
    );
    expect(holding, "fixture should have an active fixed-rate holding").toBeDefined();
    holding.allInRate = null;
    holding.spreadBps = 400;
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) =>
      w.field === "fixedCouponPct" && w.message.includes("would proxy via spreadBps"),
    );
    expectBlockingError(w, "fixedCouponPct (spreadBps proxy)");
    expectGateThrows(resolved, warnings);
  });

  it("trustee per-agreement (resolver.ts:542) — trustee fee with unparseable rate → blocking", () => {
    const raw = loadRaw();
    // Make every trustee/admin fee's rate unparseable. The resolver's loop
    // skips at `if (isNaN(rate)) continue;`, so trusteeFeeBps stays at
    // CLO_DEFAULTS=0. The post-loop check then fires because the .some()
    // still finds a trustee/admin-named entry. Mutate ALL such entries —
    // a single non-NaN entry would set trusteeFeeBps and bypass the gate.
    let mutated = 0;
    for (const fee of (raw.constraints.fees as any[])) {
      const n = (fee.name ?? "").toLowerCase();
      if (n.includes("trustee") || n.includes("admin")) {
        fee.rate = "per agreement";
        mutated++;
      }
    }
    expect(mutated, "fixture should contain at least one trustee/admin fee").toBeGreaterThan(0);
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) =>
      w.field === "fees.trusteeFeeBps" && w.message.includes("'per agreement'"),
    );
    expectBlockingError(w, "fees.trusteeFeeBps (per-agreement)");
    expectGateThrows(resolved, warnings);
  });

  it("fee bps heuristic (resolver.ts:482) — rate > 5 with null rateUnit guesses bps → blocking", () => {
    const raw = loadRaw();
    // Trip the heuristic: senior mgmt fee with rate > 5 and rateUnit null.
    // Without rateUnit the resolver guesses bps; the wrong-direction guess
    // produces a 100× silent error. New behavior refuses rather than guess.
    const seniorFee = (raw.constraints.fees as any[]).find((f: any) => {
      const n = (f.name ?? "").toLowerCase();
      return n.includes("senior") && (n.includes("mgmt") || n.includes("management"));
    });
    expect(seniorFee).toBeDefined();
    seniorFee.rate = "10";
    seniorFee.rateUnit = null;
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) =>
      w.field === "fees.seniorFeePct" && w.message.includes("no rateUnit"),
    );
    expectBlockingError(w, "fees.seniorFeePct (bps heuristic)");
    expectGateThrows(resolved, warnings);
  });

  it("ocTriggers empty (resolver.ts:374) — no OC triggers in compliance OR PPM → blocking", () => {
    const raw = loadRaw();
    // Drop every OC test the resolver's `isOcTest` predicate would match
    // (testType oc_*/overcollateralization OR testName matches "overcollateral"
    // / "par value" / both "oc"+"ratio"). Mirroring the predicate here keeps
    // the test honest if the resolver's matcher widens — the fixture filter
    // tracks the production code.
    raw.complianceData.complianceTests = (raw.complianceData.complianceTests as any[]).filter(
      (t: any) => {
        const tt = (t.testType ?? "").toLowerCase();
        if (tt === "oc_par" || tt === "oc_mv" || tt === "overcollateralization" || tt.startsWith("oc")) return false;
        const name = (t.testName ?? "").toLowerCase();
        if (name.includes("overcollateral") || name.includes("par value")) return false;
        if (name.includes("oc") && name.includes("ratio")) return false;
        return true;
      },
    );
    raw.constraints.coverageTestEntries = [];
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "ocTriggers");
    expectBlockingError(w, "ocTriggers (empty)");
    expectGateThrows(resolved, warnings);
  });
});

describe("Pattern C (silent-skip on agency-elective compliance trigger)", () => {
  // Per PPM Section 8 (PDF p. 287) the Moody's/Fitch WARF, Min WAS, and
  // Caa/CCC concentration tests apply only "while [Agency]-rated Notes are
  // outstanding". The resolver's `isMoodysRated` / `isFitchRated` predicates
  // gate enforcement: missing trigger on a rated deal = extraction failure
  // = block. Missing trigger on a not-rated deal = legitimate absent =
  // silent-skip. These markers pin the blocking branch.

  it("moodysWarfTriggerLevel — Moody's-rated but no WARF row in qualityTests → blocking", () => {
    const raw = loadRaw();
    raw.complianceData.complianceTests = (raw.complianceData.complianceTests as any[]).filter(
      (t: any) => !/moody.*maximum.*weighted average rating factor|moody.*warf|moody.*max.*warf/i.test(t.testName ?? ""),
    );
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "moodysWarfTriggerLevel");
    expectBlockingError(w, "moodysWarfTriggerLevel (Moody's-rated, missing)");
    expectGateThrows(resolved, warnings);
  });

  it("minWasBps — Moody's-rated but no Min WAS row → blocking", () => {
    const raw = loadRaw();
    raw.complianceData.complianceTests = (raw.complianceData.complianceTests as any[]).filter(
      (t: any) => !/min.*weighted average.*(floating )?spread/i.test(t.testName ?? ""),
    );
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "minWasBps");
    expectBlockingError(w, "minWasBps (Moody's-rated, missing)");
    expectGateThrows(resolved, warnings);
  });

  it("moodysCaaLimitPct — Moody's-rated but no Moody's Caa concentration row → blocking", () => {
    const raw = loadRaw();
    raw.complianceData.complianceTests = (raw.complianceData.complianceTests as any[]).filter(
      (t: any) => !/moody.*caa.*obligation/i.test(t.testName ?? ""),
    );
    raw.complianceData.concentrations = ((raw.complianceData.concentrations ?? []) as any[]).filter(
      (c: any) => !/moody.*caa/i.test(c.bucketName ?? ""),
    );
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "moodysCaaLimitPct");
    expectBlockingError(w, "moodysCaaLimitPct (Moody's-rated, missing)");
    expectGateThrows(resolved, warnings);
  });

  it("fitchCccLimitPct — Fitch-rated but no Fitch CCC concentration row → blocking", () => {
    const raw = loadRaw();
    raw.complianceData.complianceTests = (raw.complianceData.complianceTests as any[]).filter(
      (t: any) => !/fitch.*ccc.*obligation/i.test(t.testName ?? ""),
    );
    raw.complianceData.concentrations = ((raw.complianceData.concentrations ?? []) as any[]).filter(
      (c: any) => !/fitch.*ccc/i.test(c.bucketName ?? ""),
    );
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "fitchCccLimitPct");
    expectBlockingError(w, "fitchCccLimitPct (Fitch-rated, missing)");
    expectGateThrows(resolved, warnings);
  });
});

describe("Carve-out at :1434 (display-only, severity:error + blocking:false)", () => {
  // Behavioral fixture-based test: trip the carve-out by stripping the
  // "(a)..(dd)" letter prefix from every CONCENTRATION test name. The
  // resolver's letter-prefix regex then matches none of them →
  // `matchedLetters = 0 < 20` while `concCount = 36 >= 10` → the
  // vocabulary-drift guard fires. The test asserts the warning is
  // (a) emitted, (b) `severity: "error"`, and (c) `blocking: false`
  // — and crucially that `buildFromResolved` does NOT throw, because
  // a non-blocking error must not gate the projection. This locks the
  // behavior, not the source-text shape: a future refactor that
  // preserves the carve-out semantics keeps this test green; one that
  // accidentally drops `blocking: false` (or flips to `blocking: true`)
  // fails immediately.
  it("vocabulary mismatch fires the carve-out warning without blocking the projection", () => {
    const raw = loadRaw();
    let stripped = 0;
    for (const t of (raw.complianceData?.complianceTests ?? []) as any[]) {
      if (t.testType !== "CONCENTRATION") continue;
      // Drop the leading "(letter)" / "(letter)(roman)" prefix so the
      // resolver's join regex matches nothing.
      t.testName = (t.testName ?? "").replace(/^\s*\([a-z]+\)(?:\([iv]+\))?\s*/i, "");
      stripped++;
    }
    expect(stripped, "fixture should contain CONCENTRATION tests to strip").toBeGreaterThanOrEqual(10);
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "concentrationJoin.vocabulary");
    expect(w, "carve-out warning did not fire — verify trigger thresholds").toBeDefined();
    expect(w!.severity).toBe("error");
    expect(w!.blocking).toBe(false);
    // Behavioral half of the carve-out: pass ONLY the carve-out warning to
    // the gate and assert it doesn't throw. This isolates the test to the
    // carve-out's blocking behavior — robust to other blocking warnings the
    // unmutated Euro XV fixture may emit (e.g., trustee fee per-agreement
    // post-Step-2.3). If a future change flips the carve-out to
    // blocking:true, this expectation flips and signals the regression.
    expect(() =>
      buildFromResolved(resolved, DEFAULT_ASSUMPTIONS, [w!]),
    ).not.toThrow();
  });

  it("referenceWeightedAverageFixedCoupon — all-floating deal + missing refWAFC → non-blocking warn", () => {
    // Excess WAC contribution is `(wafc − refWAFC) × 100 × (fixedPar/floatingPar)`.
    // When fixedPar = 0, the entire term is 0 regardless of refWAFC; the
    // engine never adds fixed-rate loans during reinvestment (every reinvest
    // row sets isFixedRate:false), so a deal that starts all-floating stays
    // all-floating. Blocking on the absent anchor in that case would refuse a
    // valid projection; the resolver downgrades to a non-blocking warn so the
    // partner sees the gap but the projection runs.
    const raw = loadRaw();
    if (raw.constraints.interestMechanics) {
      delete raw.constraints.interestMechanics.referenceWeightedAverageFixedCoupon;
      delete raw.constraints.interestMechanics.reference_weighted_average_fixed_coupon;
    }
    // Force all holdings to floating-rate so the conditional fixedPar=0
    // carve-out fires.
    for (const h of raw.holdings as any[]) {
      h.isFixedRate = false;
      h.fixedCouponPct = null;
    }
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "referenceWeightedAverageFixedCoupon");
    expect(w, "expected non-blocking warn for all-floating deal").toBeDefined();
    expect(w!.severity).toBe("warn");
    expect(w!.blocking).toBe(false);
    expect(resolved.referenceWeightedAverageFixedCoupon).toBeNull();
    // Behavioral half: pass ONLY the carve-out warning to the gate. The gate
    // must not throw when the only warning is non-blocking. (Other unmutated
    // fixture warnings may still block on their own — isolating the assertion
    // to this warning keeps the test focused.)
    expect(() =>
      buildFromResolved(resolved, DEFAULT_ASSUMPTIONS, [w!]),
    ).not.toThrow();
  });
});

describe("Pattern E (per-position rating ladder absence — aggregated post-loop)", () => {
  it("moodysRating — active position resolves absent on Moody's-rated deal → aggregated blocking", () => {
    const raw = loadRaw();
    // Wipe every Moody's rating channel on every active holding. With no
    // Intex positions threaded in, the rating ladder has no SDF rung 1-3
    // hit and no Intex rung 4-6 hit; absent fires for every active loan.
    for (const h of raw.holdings as any[]) {
      if (h.isDefaulted) continue;
      h.moodysRating = null;
      h.moodysRatingFinal = null;
      h.moodysDpRating = null;
      h.moodysIssuerRating = null;
    }
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "moodysRating");
    expectBlockingError(w, "moodysRating (aggregated absent)");
    // Aggregated shape: ONE warning per agency, listing all affected obligors
    // (sample of up to 8 + "+N more"). Confirm the message lists obligor names
    // so the partner-facing DATA INCOMPLETE banner identifies which positions
    // need Intex coverage.
    expect(w!.message).toMatch(/active position\(s\) have no Moody's rating/);
    expectGateThrows(resolved, warnings);
  });

  it("fitchRating — active position resolves absent on Fitch-rated deal → aggregated blocking", () => {
    const raw = loadRaw();
    for (const h of raw.holdings as any[]) {
      if (h.isDefaulted) continue;
      h.fitchRating = null;
      h.fitchRatingFinal = null;
      h.fitchSecurityRating = null;
      h.fitchIssuerRating = null;
    }
    const { resolved, warnings } = runResolver(raw);
    const w = warnings.find((w) => w.field === "fitchRating");
    expectBlockingError(w, "fitchRating (aggregated absent)");
    expect(w!.message).toMatch(/active position\(s\) have no Fitch rating/);
    expectGateThrows(resolved, warnings);
  });
});
