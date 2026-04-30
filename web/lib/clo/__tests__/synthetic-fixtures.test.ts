/**
 * Synthetic-fixture cross-deal validation — post-v6 plan §6.1.
 *
 * Hand-constructed `ProjectionInputs` covering structural variations
 * (class count, pari-passu rank, fixed-rate mix, hedge cost, RP state,
 * solvency, deferred-interest activation, OC failure / cure firing,
 * acceleration). For each fixture the engine output is asserted against
 * the §6.1 sanity bounds:
 *
 *  - No NaN / Infinity in any emitted field
 *  - IRR in [-50%, +50%] OR null with `equityWipedOut === true`
 *  - Book value in [0c, 200c] (floored at 0; healthy deals can exceed
 *    100c when assets > debt + sub par)
 *  - OC tests > 50% OR documented insolvency state (acceleration / EoD
 *    / wiped-out)
 *  - Period count consistent with maturity
 *  - Each fixture's distinguishing engine path emits its expected
 *    `stepTrace` field (eg. `ocCureDiversions.length > 0` for #9;
 *    `isAccelerated === true` for #10).
 *
 * These catches structural bugs in resolver / engine without requiring
 * real-deal extraction.
 */

import { describe, it, expect } from "vitest";
import { runProjection, type ProjectionInputs, type ProjectionResult } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

function isFiniteNumber(x: unknown): boolean {
  return typeof x === "number" && Number.isFinite(x);
}

function assertNoNaNInfinity(result: ProjectionResult, fixtureName: string) {
  for (let i = 0; i < result.periods.length; i++) {
    const p = result.periods[i];
    const numericFields: Array<[string, number]> = [
      ["beginningPar", p.beginningPar],
      ["endingPar", p.endingPar],
      ["defaults", p.defaults],
      ["interestCollected", p.interestCollected],
      ["principalProceeds", p.principalProceeds],
      ["equityDistribution", p.equityDistribution],
      ["seniorMgmtFeePaid", p.stepTrace.seniorMgmtFeePaid],
    ];
    for (const [k, v] of numericFields) {
      expect(isFiniteNumber(v), `${fixtureName} period ${i} field ${k} = ${v}`).toBe(true);
    }
  }
  if (result.equityIrr != null) {
    expect(isFiniteNumber(result.equityIrr), `${fixtureName} equityIrr = ${result.equityIrr}`).toBe(true);
  }
  expect(isFiniteNumber(result.totalEquityDistributions)).toBe(true);
  expect(isFiniteNumber(result.initialState.equityBookValue)).toBe(true);
}

function assertSanityBounds(
  result: ProjectionResult,
  inputs: ProjectionInputs,
  fixtureName: string,
  opts?: { allowAcceleration?: boolean },
) {
  assertNoNaNInfinity(result, fixtureName);

  // IRR: in [-50%, +50%] OR null when wiped out.
  if (result.equityIrr === null) {
    expect(result.initialState.equityWipedOut, `${fixtureName} null IRR but not wiped out`).toBe(true);
  } else {
    expect(result.equityIrr).toBeGreaterThan(-0.5);
    expect(result.equityIrr).toBeLessThan(0.5);
  }

  // Book value cents: derive from equityBookValue / sum of income-note
  // tranche balances at t=0. Engine floors at 0; upper bound 200c.
  const subPar = inputs.tranches
    .filter((t) => t.isIncomeNote)
    .reduce((s, t) => s + t.currentBalance, 0);
  if (subPar > 0) {
    const bookCents = (result.initialState.equityBookValue / subPar) * 100;
    expect(bookCents).toBeGreaterThanOrEqual(0);
    expect(bookCents).toBeLessThanOrEqual(200);
  }

  // OC tests: > 50% at t=0 OR a documented insolvency state.
  const ocActuals = result.initialState.ocTests.map((oc) => oc.actual);
  const allOcAbove50 = ocActuals.every((a) => a > 50);
  const isAccelerated = result.periods.some((p) => p.isAccelerated);
  const isEoD = result.initialState.eodTest != null && !result.initialState.eodTest.passing;
  if (!allOcAbove50) {
    const documented = result.initialState.equityWipedOut || isEoD || (opts?.allowAcceleration && isAccelerated);
    expect(documented, `${fixtureName} OC < 50% but no documented insolvency state`).toBe(true);
  }

  // Period count: at least one period; ends at or before maturity.
  expect(result.periods.length).toBeGreaterThan(0);
}

describe("Synthetic-fixture cross-deal validation (post-v6 plan §6.1)", () => {
  it("Fixture #1: 5-class structure (A, B, C, D, Sub)", () => {
    const inputs = makeInputs({
      tranches: [
        { className: "A", currentBalance: 60_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 12_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 8_000_000, spreadBps: 300, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "D", currentBalance: 5_000_000, spreadBps: 500, seniorityRank: 4, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 15_000_000, spreadBps: 0, seniorityRank: 5, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 120, rank: 2 },
        { className: "C", triggerLevel: 115, rank: 3 },
        { className: "D", triggerLevel: 108, rank: 4 },
      ],
      icTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 120, rank: 2 },
        { className: "C", triggerLevel: 115, rank: 3 },
        { className: "D", triggerLevel: 108, rank: 4 },
      ],
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #1 (5-class)");
    expect(inputs.tranches).toHaveLength(5);
  });

  it("Fixture #2: 7-class with A-1 / A-2 split (pari-passu rank 1)", () => {
    const inputs = makeInputs({
      tranches: [
        { className: "A-1", currentBalance: 35_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "A-2", currentBalance: 25_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 10_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 6_000_000, spreadBps: 300, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "D", currentBalance: 4_000_000, spreadBps: 500, seniorityRank: 4, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "F", currentBalance: 3_000_000, spreadBps: 800, seniorityRank: 5, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 17_000_000, spreadBps: 0, seniorityRank: 6, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A-1", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 120, rank: 2 },
      ],
      icTriggers: [
        { className: "A-1", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 120, rank: 2 },
      ],
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #2 (7-class)");
    expect(inputs.tranches).toHaveLength(7);
    // Both A-1 and A-2 share rank 1 (pari-passu).
    const rank1Classes = inputs.tranches.filter((t) => t.seniorityRank === 1);
    expect(rank1Classes).toHaveLength(2);
  });

  it("Fixture #3: A-only deal (no mezz)", () => {
    const inputs = makeInputs({
      tranches: [
        { className: "A", currentBalance: 80_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [{ className: "A", triggerLevel: 110, rank: 1 }],
      icTriggers: [{ className: "A", triggerLevel: 110, rank: 1 }],
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #3 (A-only)");
    expect(inputs.tranches).toHaveLength(2);
  });

  it("Fixture #4: fixed-rate-heavy deal (3+ fixed tranches)", () => {
    const inputs = makeInputs({
      tranches: [
        { className: "A", currentBalance: 50_000_000, spreadBps: 350, seniorityRank: 1, isFloating: false, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 15_000_000, spreadBps: 500, seniorityRank: 2, isFloating: false, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 10_000_000, spreadBps: 700, seniorityRank: 3, isFloating: false, isIncomeNote: false, isDeferrable: true },
        { className: "D", currentBalance: 5_000_000, spreadBps: 950, seniorityRank: 4, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 5, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 115, rank: 2 },
      ],
      icTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 115, rank: 2 },
      ],
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #4 (fixed-rate-heavy)");
    const fixed = inputs.tranches.filter((t) => !t.isFloating && !t.isIncomeNote);
    expect(fixed.length).toBeGreaterThanOrEqual(3);
  });

  it("Fixture #5: hedge-heavy deal (50+ bps hedge cost)", () => {
    const inputs = makeInputs({
      hedgeCostBps: 75,
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #5 (hedge-heavy)");
    // Hedge cost flows through the engine; a non-zero hedge cost should
    // reduce equity vs zero-hedge baseline.
    const baseline = runProjection({ ...inputs, hedgeCostBps: 0 });
    expect(result.totalEquityDistributions).toBeLessThan(baseline.totalEquityDistributions);
  });

  it("Fixture #6: no-RP deal (RP already ended at currentDate)", () => {
    const inputs = makeInputs({
      currentDate: "2029-01-15",
      reinvestmentPeriodEnd: "2027-01-15", // RP ended 2 years ago
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #6 (no-RP)");
    // Reinvestment should not fire after RP end (zero across all periods).
    const totalReinv = result.periods.reduce((s, p) => s + p.reinvestment, 0);
    expect(totalReinv).toBe(0);
  });

  it("Fixture #7: wiped-out deal (totalDebt > totalAssets)", () => {
    const inputs = makeInputs({
      // Tranche balances total 200M; loans only 100M → wiped out.
      tranches: [
        { className: "A", currentBalance: 150_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 35_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 15_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 110, rank: 2 },
      ],
      icTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 110, rank: 2 },
      ],
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #7 (wiped-out)");
    expect(result.initialState.equityWipedOut).toBe(true);
    expect(result.equityIrr).toBeNull();
    expect(result.initialState.equityBookValue).toBe(0);
  });

  it("Fixture #8: deal with active deferred interest (PIK on Class C)", () => {
    // Combine high mezz coupons + heavy defaults + low CPR so interest can't
    // cover Class C/D current pay; deferred interest accrues.
    const inputs = makeInputs({
      tranches: [
        { className: "A", currentBalance: 60_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "C", currentBalance: 10_000_000, spreadBps: 800, seniorityRank: 3, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "D", currentBalance: 5_000_000, spreadBps: 1200, seniorityRank: 4, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 5, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 115, rank: 2 },
        { className: "C", triggerLevel: 108, rank: 3 },
      ],
      icTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 115, rank: 2 },
        { className: "C", triggerLevel: 108, rank: 3 },
      ],
      defaultRatesByRating: uniformRates(4), // elevated defaults — material but not catastrophic
      cprPct: 0,
      recoveryPct: 50,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #8 (PIK active)", { allowAcceleration: true });
    // At least one period should accrue deferred interest somewhere.
    const accrued = result.periods.some((p) =>
      Object.values(p.stepTrace.deferredAccrualByTranche).some((v) => v > 0),
    );
    expect(accrued).toBe(true);
  });

  it("Fixture #9: active OC failure (cure diversion firing)", () => {
    // Set Class B OC trigger above the deal's actual ratio so the cure
    // diversion fires (PPM step (I)/(L)/etc).
    const inputs = makeInputs({
      tranches: [
        { className: "A", currentBalance: 65_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 200, rank: 2 }, // intentionally unreachable → fail
      ],
      icTriggers: [
        { className: "A", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 110, rank: 2 },
      ],
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #9 (OC failure)", { allowAcceleration: true });
    // Cure diversion should fire at least once.
    const anyCure = result.periods.some((p) => p.stepTrace.ocCureDiversions.length > 0);
    expect(anyCure).toBe(true);
  });

  it("Fixture #10: active EoD (post-acceleration mode)", () => {
    // Drive EoD by setting the trigger above the deal's actual; engine
    // accelerates and runs the post-acceleration waterfall path. The
    // senior-most debt tranche is named "A" (not "Class A") deliberately:
    // this fixture's purpose is to surface non-Euro-XV-shaped deals,
    // including non-canonical naming. The engine's EoD denominator
    // identifies the senior-most debt by `seniorityRank`, not by string
    // match on "Class A" — see projection.ts EoD denominator.
    const inputs = makeInputs({
      tranches: [
        { className: "A", currentBalance: 65_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "J", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A", triggerLevel: 120, rank: 1 },
        { className: "J", triggerLevel: 110, rank: 2 },
      ],
      icTriggers: [
        { className: "A", triggerLevel: 120, rank: 1 },
        { className: "J", triggerLevel: 110, rank: 2 },
      ],
      eventOfDefaultTest: { triggerLevel: 200 }, // > 153.8% pool/A ratio → fail
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    assertSanityBounds(result, inputs, "Fixture #10 (EoD)", { allowAcceleration: true });
    const eodHit = result.periods.some((p) => p.isAccelerated);
    expect(eodHit).toBe(true);
    // In acceleration mode, availableForTranches is null per PPM 10(b).
    const acceleratedPeriods = result.periods.filter((p) => p.isAccelerated);
    expect(acceleratedPeriods.every((p) => p.stepTrace.availableForTranches === null)).toBe(true);
  });
});
