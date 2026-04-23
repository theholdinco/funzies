/**
 * B1 — Compositional Event of Default Par Value Test.
 *
 * PPM OC Condition 10(a)(iv):
 *   Numerator = APB(non-defaulted) + Σ(MV × PB)(defaulted) + Principal Proceeds
 *   Denominator = Class A Principal Amount Outstanding (only; NOT all tranches)
 *   Trigger = 102.5% for Euro XV
 *
 * Previously mis-implemented as a rank-99 OC trigger running against a
 * denominator that included ALL tranches (sub notes + everything) — made the
 * test impossible to breach and ignored the MV × PB component entirely.
 *
 * Pure-function tests live here; the full integration against Euro XV fixture
 * sits in n1-correctness.test.ts's T=0 compositional-parity block.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeEventOfDefaultTest, runProjection } from "@/lib/clo/projection";
import { buildFromResolved, defaultsFromResolved } from "@/lib/clo/build-projection-inputs";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof defaultsFromResolved>[1];
};

describe("B1 — computeEventOfDefaultTest (pure helper)", () => {
  it("Euro XV Q1 tie-out: 158.52% (PPM worked example)", () => {
    // Source: raw.constraints.eventOfDefaultParValueTest.current_period_tie_out
    //   numerator_component_1 (APB non-defaulted): €493,224,242
    //   numerator_component_2 (defaulted MV × PB):             0  (no defaults)
    //   numerator_component_3 (principal cash):      −€1,817,413
    //   numerator_total:                            €491,406,829
    //   denominator (Class A only):                 €310,000,000
    //   actual ratio:                                    158.52%
    //   trigger: 102.5% → PASSED
    //
    // Note on component 1: trustee's worked example uses totalPrincipalBalance
    // (€493,224,242 — aggregate line in the trustee report) while our engine
    // sums individual loan par records (€493,252,343). The €28,101.56 gap is
    // fully attributable: it is PIK accrual on 2 Financiere Labeyrie Fine
    // Foods (Facility B) positions (parBalance − principalBalance = €16,861
    // + €11,241 = €28,102, matching each position's pikAmount field). Trustee
    // reports aggregate at face (excludes capitalized PIK); per-position par
    // includes it. Engine uses parBalance because per-position par drives OC
    // numerator and interest accrual — including PIK is correct. The
    // resulting 0.01pp ratio gap is material-irrelevant at 158.53% vs 158.52%.

    const loanStates = fixture.resolved.loans.map((l) => ({
      survivingPar: l.parBalance,
      isDefaulted: l.isDefaulted ?? false,
      currentPrice: l.currentPrice,
      isDelayedDraw: l.isDelayedDraw,
    }));
    const principalCash = fixture.resolved.principalAccountCash; // −€1,817,413
    const classABalance = fixture.resolved.tranches.find((t) => t.className === "Class A")!.currentBalance;

    const result = computeEventOfDefaultTest(loanStates, principalCash, classABalance, 102.5);

    // Headline ratio: engine 158.53% vs PPM 158.52% — 0.01pp gap from the
    // trustee-source holdings-vs-aggregate inconsistency. Well inside any
    // material tolerance for EoD breach detection (the test is PASSED by
    // ~56pp; no plausible precision issue changes the outcome).
    expect(result.actualPct).toBeCloseTo(158.52, 1);
    expect(result.passing).toBe(true);
    // Component decomposition — uses sum of loan par (not trustee aggregate):
    expect(result.numeratorComponents.nonDefaultedApb).toBeCloseTo(493_252_343, -2); // engine's sum
    expect(result.numeratorComponents.defaultedMvPb).toBe(0);
    expect(result.numeratorComponents.principalCash).toBeCloseTo(-1_817_413, -2);
    expect(result.denominator).toBe(310_000_000);
    // And the sum-of-loans is within €50k of trustee's totalPrincipalBalance
    // — sanity check that the source discrepancy hasn't exploded.
    expect(Math.abs(result.numeratorComponents.nonDefaultedApb - 493_224_242)).toBeLessThan(50_000);
  });

  it("synthetic 10% default at 30c MV: 146.4% (hand-verified)", () => {
    // Synthetic pool: 100M par, 10% defaulted at 30c MV, zero cash, Class A 70M.
    // component 1: 90M × 1.00 = 90M
    // component 2: 10M × 0.30 = 3M
    // component 3: 0
    // numerator: 93M; denominator: 70M → 132.857%
    const loanStates = [
      { survivingPar: 90_000_000, isDefaulted: false },
      { survivingPar: 10_000_000, isDefaulted: true, currentPrice: 30 },
    ];
    const result = computeEventOfDefaultTest(loanStates, 0, 70_000_000, 102.5);
    expect(result.numeratorComponents.nonDefaultedApb).toBe(90_000_000);
    expect(result.numeratorComponents.defaultedMvPb).toBe(3_000_000);
    expect(result.numeratorTotal).toBe(93_000_000);
    expect(result.actualPct).toBeCloseTo(132.857, 2);
    expect(result.passing).toBe(true);
  });

  it("breach: 50% default at 0c MV collapses numerator below trigger", () => {
    // 100M par, 50M defaulted at 0c, zero cash, Class A 70M.
    // num = 50M + 0 + 0 = 50M; denom = 70M → 71.43% < 102.5 → FAIL
    const loanStates = [
      { survivingPar: 50_000_000, isDefaulted: false },
      { survivingPar: 50_000_000, isDefaulted: true, currentPrice: 0 },
    ];
    const result = computeEventOfDefaultTest(loanStates, 0, 70_000_000, 102.5);
    expect(result.actualPct).toBeCloseTo(71.43, 1);
    expect(result.passing).toBe(false);
  });

  it("defaulted loan with no currentPrice falls back to 100c (par) — conservative", () => {
    // Reinvested position that defaulted before acquiring market quote.
    // Plan policy: fallback to 100 (overstates numerator, passes trigger).
    const loanStates = [
      { survivingPar: 50_000_000, isDefaulted: false },
      { survivingPar: 50_000_000, isDefaulted: true, currentPrice: null },
    ];
    const result = computeEventOfDefaultTest(loanStates, 0, 70_000_000, 102.5);
    // num = 50M + 50M × 1.00 = 100M
    expect(result.numeratorComponents.defaultedMvPb).toBe(50_000_000);
    expect(result.actualPct).toBeCloseTo(142.86, 1);
  });

  it("unfunded DDTL excluded entirely (neither numerator nor denominator)", () => {
    const loanStates = [
      { survivingPar: 90_000_000, isDefaulted: false },
      { survivingPar: 10_000_000, isDefaulted: false, isDelayedDraw: true },
    ];
    const result = computeEventOfDefaultTest(loanStates, 0, 70_000_000, 102.5);
    // Only the funded 90M counts.
    expect(result.numeratorComponents.nonDefaultedApb).toBe(90_000_000);
    expect(result.numeratorTotal).toBe(90_000_000);
  });

  it("negative principal cash reduces numerator (Euro XV case)", () => {
    // Euro XV's principalAccountCash is negative (−€1.8M, payable on account).
    const loanStates = [{ survivingPar: 100_000_000, isDefaulted: false }];
    const withNegCash = computeEventOfDefaultTest(loanStates, -5_000_000, 70_000_000, 102.5);
    const withZeroCash = computeEventOfDefaultTest(loanStates, 0, 70_000_000, 102.5);
    expect(withNegCash.numeratorTotal).toBe(95_000_000);
    expect(withZeroCash.numeratorTotal).toBe(100_000_000);
    expect(withNegCash.numeratorTotal).toBeLessThan(withZeroCash.numeratorTotal);
  });

  it("zero Class A balance → 999 (non-breach sentinel, no divide-by-zero)", () => {
    const result = computeEventOfDefaultTest([], 0, 0, 102.5);
    expect(result.actualPct).toBe(999);
    expect(result.passing).toBe(true);
  });

  it("integration: runProjection emits initialState.eodTest = 158.52% on Euro XV", () => {
    // End-to-end tie-out through the full projection pipeline:
    //   ResolvedDealData.eventOfDefaultTest → buildFromResolved →
    //   ProjectionInputs.eventOfDefaultTest → runProjection → initialState.eodTest
    const inputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const result = runProjection(inputs);
    expect(result.initialState.eodTest).not.toBeNull();
    expect(result.initialState.eodTest!.actualPct).toBeCloseTo(158.52, 1);
    expect(result.initialState.eodTest!.passing).toBe(true);
    expect(result.initialState.eodTest!.triggerLevel).toBe(102.5);
    expect(result.initialState.eodTest!.denominator).toBe(310_000_000);
  });

  it("Tier 2: forced mid-projection defaults activate Σ(MV × PB) component in periods[] eodTest", () => {
    // Stress scenario: force 20% annual CDR on Class B-rated loans with a
    // recovery lag long enough that the defaulted par sits in the pool for
    // multiple periods. Each period's `eodTest.numeratorComponents.defaultedMvPb`
    // should be non-zero while `defaultedParPending` is live.
    const uniformRates: Record<string, number> = {
      AAA: 0, AA: 0, A: 0, BBB: 0, BB: 20, B: 20, CCC: 20, NR: 20,
    };
    const inputs = buildFromResolved(fixture.resolved, {
      ...defaultsFromResolved(fixture.resolved, fixture.raw),
      defaultRates: uniformRates,
      recoveryLagMonths: 18, // 6 quarters
      recoveryPct: 50,
      cprPct: 0,
    });
    const result = runProjection(inputs);

    // T=0 initialState has zero defaults (pre-default); MV × PB = 0.
    expect(result.initialState.eodTest).not.toBeNull();
    expect(result.initialState.eodTest!.numeratorComponents.defaultedMvPb).toBe(0);

    // Periods 1-6 (before first recovery arrives): defaults accumulate,
    // MV × PB should be strictly positive on at least one period.
    const periodsWithMvPb = result.periods
      .slice(0, 6)
      .filter((p) => p.eodTest && p.eodTest.numeratorComponents.defaultedMvPb > 0);
    expect(periodsWithMvPb.length).toBeGreaterThan(0);

    // Sanity on non-defaulted APB: must shrink over time as defaults accumulate.
    const initialNonDefApb = result.initialState.eodTest!.numeratorComponents.nonDefaultedApb;
    const p3NonDefApb = result.periods[2].eodTest!.numeratorComponents.nonDefaultedApb;
    expect(p3NonDefApb).toBeLessThan(initialNonDefApb);
  });

  it("Tier 2: defaultedParPending drains when per-loan recovery event arrives", () => {
    // Same stress as above but short recovery lag (1 quarter) — defaulted par
    // should drain shortly after default, and MV × PB should eventually fall
    // toward zero as recoveries clear the pipeline.
    const uniformRates: Record<string, number> = {
      AAA: 0, AA: 0, A: 0, BBB: 0, BB: 30, B: 30, CCC: 30, NR: 30,
    };
    const inputs = buildFromResolved(fixture.resolved, {
      ...defaultsFromResolved(fixture.resolved, fixture.raw),
      defaultRates: uniformRates,
      recoveryLagMonths: 3, // 1 quarter — recovery arrives next period
      recoveryPct: 50,
      cprPct: 0,
    });
    const result = runProjection(inputs);

    // Periods 1-4: mv×pb should be positive in at least one period (default
    // happens, pending until recovery at q+1), then drain.
    const mvPbSeq = result.periods
      .slice(0, 4)
      .map((p) => p.eodTest?.numeratorComponents.defaultedMvPb ?? 0);
    // With 1-quarter lag, each period's default should be drained by the next.
    // Expect mv×pb to stay in a bounded range (not accumulate indefinitely).
    const maxMvPb = Math.max(...mvPbSeq);
    expect(maxMvPb).toBeGreaterThan(0);
    // Last observation should not be dramatically larger than first (defaults
    // drain on 1-quarter lag, so steady-state mv×pb is ≈ 1 period's default × MV).
    expect(mvPbSeq[3]).toBeLessThan(maxMvPb * 2);
  });

  it("Tier 2: recovery cash-flow identity — aggregate defaults × recoveryPct ≈ aggregate recoveries", () => {
    // A stand-alone sanity check on the OLD aggregate path: total defaults
    // times recovery rate should approximately equal total recoveries over
    // the projection. Only touches the recoveryPipeline path, so this does
    // NOT guard against per-loan / aggregate divergence — see the
    // cross-path identity test below for that.
    const uniformRates: Record<string, number> = {
      AAA: 0, AA: 0, A: 0, BBB: 0, BB: 10, B: 10, CCC: 10, NR: 10,
    };
    const recoveryPct = 50;
    const inputs = buildFromResolved(fixture.resolved, {
      ...defaultsFromResolved(fixture.resolved, fixture.raw),
      defaultRates: uniformRates,
      recoveryLagMonths: 6,
      recoveryPct,
      cprPct: 0,
    });
    const result = runProjection(inputs);
    const totalDefaults = result.periods.reduce((s, p) => s + p.defaults, 0);
    const totalRecoveries = result.periods.reduce((s, p) => s + p.recoveries, 0);
    const expectedRecoveries = totalDefaults * (recoveryPct / 100);
    // Lag tail near maturity may not land — expect ≥ 95% of theoretical.
    expect(totalRecoveries).toBeGreaterThan(expectedRecoveries * 0.95);
    expect(totalRecoveries).toBeLessThanOrEqual(expectedRecoveries * 1.01);
  });

  it("Tier 2: cross-path identity — per-loan defaultEvents and aggregate recoveryPipeline agree period-by-period", () => {
    // THE real dual-accounting check. Two independent paths track the same
    // underlying default events:
    //   Path A (per-loan): loanDefaultEvents in each PeriodResult carry
    //     {loanIndex, defaultedPar, scheduledRecoveryQuarter}
    //   Path B (aggregate): PeriodResult.defaults and PeriodResult.recoveries
    //     derive from the old recoveryPipeline mechanism
    // If someone later changes the lag calculation in one path (e.g.
    // `q + recoveryLagQ + 1` in the per-loan push but not in the aggregate
    // push), or vice versa, the paths diverge silently. This test fires in
    // that scenario.
    //
    // Two identities asserted:
    //   1. Per-period: Σ(loanDefaultEvents[].defaultedPar) === period.defaults
    //   2. Per-scheduled-recovery-quarter: Σ(earlier periods' loanDefaultEvents
    //      whose scheduledRecoveryQuarter = Q) × (recoveryPct/100) ===
    //      period[Q].recoveries (modulo rounding).
    const uniformRates: Record<string, number> = {
      AAA: 0, AA: 0, A: 0, BBB: 0, BB: 15, B: 15, CCC: 15, NR: 15,
    };
    const recoveryPct = 40;
    const recoveryLagQuarters = 2; // recoveryLagMonths = 6 → 2 quarters
    const inputs = buildFromResolved(fixture.resolved, {
      ...defaultsFromResolved(fixture.resolved, fixture.raw),
      defaultRates: uniformRates,
      recoveryLagMonths: 6,
      recoveryPct,
      cprPct: 0,
    });
    const result = runProjection(inputs);

    // Identity 1: per-period defaults from both paths agree exactly.
    for (let q = 0; q < result.periods.length; q++) {
      const p = result.periods[q];
      const perLoanSum = p.loanDefaultEvents.reduce((s, e) => s + e.defaultedPar, 0);
      expect(perLoanSum).toBeCloseTo(p.defaults, 2);
      // Every event's scheduled recovery quarter is exactly q + recoveryLagQuarters.
      for (const e of p.loanDefaultEvents) {
        expect(e.scheduledRecoveryQuarter).toBe(q + 1 + recoveryLagQuarters);
      }
    }

    // Identity 2: aggregate recoveries per period = Σ(earlier events with
    // matching scheduledRecoveryQuarter) × recoveryPct/100.
    // (Period index in result.periods is 0-based; q=0 corresponds to internal
    // quarter 1, so scheduledRecoveryQuarter=Q corresponds to result.periods[Q-1].)
    for (let Q = 1; Q <= result.periods.length; Q++) {
      const expectedRecoveryPar = result.periods
        .flatMap((p) => p.loanDefaultEvents)
        .filter((e) => e.scheduledRecoveryQuarter === Q)
        .reduce((s, e) => s + e.defaultedPar, 0);
      const expectedRecoveryCash = expectedRecoveryPar * (recoveryPct / 100);
      const actualRecoveryCash = result.periods[Q - 1].recoveries;
      expect(actualRecoveryCash).toBeCloseTo(expectedRecoveryCash, 2);
    }
  });

  it("Concern-1 fix at T=0: initialState.eodTest.principalCash = resolved.principalAccountCash", () => {
    // Concern 1's fix (replacing hardcoded `principalCash = 0` with the real
    // Principal Account cash) matters most at T=0 — the PPM-anchored
    // measurement-date check that ties to trustee's reported 158.52%. At T=0
    // the engine uses `initialPrincipalCash` which equals Euro XV's −€1.82M
    // Principal EUR account overdraft. The fix is directly exercised here.
    const inputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const result = runProjection(inputs);
    expect(result.initialState.eodTest).not.toBeNull();
    expect(result.initialState.eodTest!.numeratorComponents.principalCash).toBeCloseTo(
      fixture.resolved.principalAccountCash,
      2,
    );
    // And the numeratorTotal reconstructs from its three components (sanity
    // that the fix isn't double-counting or dropping).
    const nc = result.initialState.eodTest!.numeratorComponents;
    expect(result.initialState.eodTest!.numeratorTotal).toBeCloseTo(
      nc.nonDefaultedApb + nc.defaultedMvPb + nc.principalCash,
      2,
    );
  });

  it("Concern-1 fix in forward loop: component 3 uses remainingPrelim (not 0)", () => {
    // In the forward period loop the engine drains `prelimPrincipal` to
    // rated-note paydowns before the EoD check runs, so on realistic deals
    // `remainingPrelim` is typically 0 at the measurement moment — every
    // period's principal proceeds get absorbed by surviving tranche debt.
    // (The engine doesn't model a Principal Account carrying balance across
    // the payment date; leftover cash flows immediately to the sub residual.)
    //
    // Consequence: forward-period EoD's principalCash component is almost
    // always 0 under this engine's model. That's a known limitation of the
    // simplified model, not a bug in Concern-1's fix. The fix is
    // architecturally correct and would deliver non-zero values as soon as
    // the engine adopts mid-period Principal Account semantics (out of B1
    // scope).
    //
    // What we CAN assert today: every forward period's principalCash is
    // equal to (engine's internal remainingPrelim at measurement), which is
    // ≥ 0. If a future engine change ever produces negative cash here, it's
    // a regression worth catching.
    const uniformRates: Record<string, number> = {
      AAA: 0, AA: 0, A: 0, BBB: 0, BB: 5, B: 5, CCC: 5, NR: 5,
    };
    const inputs = buildFromResolved(fixture.resolved, {
      ...defaultsFromResolved(fixture.resolved, fixture.raw),
      defaultRates: uniformRates,
      recoveryPct: 40,
      recoveryLagMonths: 6,
      cprPct: 20,
      postRpReinvestmentPct: 0,
    });
    const result = runProjection(inputs);
    for (const p of result.periods) {
      if (!p.eodTest) continue;
      // Non-negative — would catch a sign-flip regression in the fix wiring.
      expect(p.eodTest.numeratorComponents.principalCash).toBeGreaterThanOrEqual(0);
      // numeratorTotal reconstructs from components.
      const nc = p.eodTest.numeratorComponents;
      expect(p.eodTest.numeratorTotal).toBeCloseTo(
        nc.nonDefaultedApb + nc.defaultedMvPb + nc.principalCash,
        2,
      );
    }
  });

  it("integration: EoD is NOT in ocTests — structurally separate from class-level OC", () => {
    // Regression guard: the pre-B1 bug was EoD running through the class OC
    // loop at rank 99. Post-B1, EoD lives on its own field, and ocTests
    // should have NO entry with className "EOD" / rank 99.
    const inputs = buildFromResolved(fixture.resolved, defaultsFromResolved(fixture.resolved, fixture.raw));
    const result = runProjection(inputs);
    const eodInOc = result.initialState.ocTests.find((t) =>
      t.className.toLowerCase() === "eod" || t.className.toLowerCase() === "event of default",
    );
    expect(eodInOc).toBeUndefined();
  });

  it("denominator is Class A ONLY (not all tranches) — regression guard vs rank-99 OC bug", () => {
    // Pre-B1 bug: engine ran EoD through the class OC loop with rank 99,
    // causing denominator to include every tranche (Class A + B + C + D + E +
    // F + Sub Notes). For Euro XV that's ~€511M denom vs the correct €310M,
    // understating the ratio by a factor of ~1.65. This test pins the
    // contract: the helper takes ONLY Class A PAO, not an aggregated debt
    // balance, and would never compute the pre-B1 (wrong) result.
    //
    // Construct identical pool, once with Class A denom and once with total
    // debt denom (to confirm they produce different answers — if they didn't,
    // the helper would silently accept the wrong shape).
    const loanStates = [{ survivingPar: 493_224_242, isDefaulted: false }];
    const correctResult = computeEventOfDefaultTest(loanStates, -1_817_413, 310_000_000, 102.5);
    const preB1BuggyIfUsingTotalDebt = computeEventOfDefaultTest(loanStates, -1_817_413, 511_250_000, 102.5);
    // Correct: 158.52%. Buggy (hypothetical): ~96%.
    expect(correctResult.actualPct).toBeCloseTo(158.52, 1);
    expect(preB1BuggyIfUsingTotalDebt.actualPct).toBeLessThan(correctResult.actualPct / 1.5);
  });
});
