/**
 * Harness `extractEngineBuckets` rank-based selection.
 *
 * The harness maps engine `PeriodResult` → flat bucket map by tier-position
 * (sorted unique seniorityRank groups of non-amortising debt tranches),
 * NOT by hardcoded class-name string literals. This test exercises a deal
 * whose senior tranche is named "Class A-1" (not "Class A") and whose mezz
 * uses non-canonical "M-1"/"M-2" labels — under hardcoded-name lookups the
 * harness would silently emit 0 for `stepG_interest`, `classB_interest`,
 * etc., and report large false drifts against trustee data. Under tier-
 * based lookups the harness extracts the correct values regardless of
 * naming convention.
 *
 * Companion test for `ki56-class-x-step-g.test.ts` (which covers the
 * step-(G) merge on the canonical "Class A" naming).
 */

import { describe, it, expect } from "vitest";
import { runProjection, addQuarters, type ProjectionInputs, type LoanInput } from "../projection";
import { CLO_DEFAULTS } from "../defaults";
import { runBacktestHarness } from "../backtest-harness";
import type { BacktestInputs } from "../backtest-types";
import { uniformRates } from "./test-helpers";

describe("harness extractEngineBuckets — rank-based class identity", () => {
  it("emits non-zero stepG_interest / classB_interest on a deal with non-canonical class names", () => {
    // Synthetic 4-debt-tier deal with non-Euro-XV-style class naming:
    //   tier 0 (rank 1, senior non-amort): two pari-passu tranches "Class A-1" + "Class A-2"
    //   tier 1 (rank 2): "Class B"
    //   tier 2 (rank 3): "M-1" (mezz, non-canonical name)
    //   tier 3 (rank 4): "M-2"
    //   subordinated:    "Equity"
    //
    // Under the OLD hardcoded-className path, every harness bucket lookup
    // (Map.get("Class A"), Map.get("Class C"), …) would miss → 0. Under the
    // tier-based path, tier 0 sums A-1 + A-2 interest, tier 1 = B, tier 2
    // = M-1 (the "Class C" bucket on a canonical deal), tier 3 = M-2.
    const loans: LoanInput[] = Array.from({ length: 4 }, (_, i) => ({
      parBalance: 30_000_000,
      maturityDate: addQuarters("2026-03-09", 24 + i),
      ratingBucket: "B",
      spreadBps: 410,
    currency: "EUR",
    }));

    const inputs: ProjectionInputs = {
      initialPar: 120_000_000,
    dealCurrency: "EUR",
      wacSpreadBps: 410,
      baseRatePct: CLO_DEFAULTS.baseRatePct,
      baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
      seniorFeePct: 0,
      subFeePct: 0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      incentiveFeePct: 0,
      incentiveFeeHurdleIrr: 0,
      postRpReinvestmentPct: 0,
      callMode: "none",
      callDate: null,
      callPricePct: 100,
      callPriceMode: "par",
      reinvestmentOcTrigger: null,
      tranches: [
        { className: "Class A-1", currentBalance: 50_000_000, spreadBps: 110, seniorityRank: 1, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
        { className: "Class A-2", currentBalance: 30_000_000, spreadBps: 110, seniorityRank: 1, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
        { className: "Class B",   currentBalance: 15_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
        { className: "M-1",       currentBalance: 10_000_000, spreadBps: 350, seniorityRank: 3, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: true  },
        { className: "M-2",       currentBalance:  5_000_000, spreadBps: 500, seniorityRank: 4, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: true  },
        { className: "Equity",    currentBalance: 10_000_000, spreadBps:   0, seniorityRank: 5, isFloating: false, isIncomeNote: true,  isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      reinvestmentPeriodEnd: "2030-06-15",
      maturityDate: "2034-06-15",
      currentDate: "2026-03-09",
      loans,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      recoveryLagMonths: 6,
      ratingAgencies: ["moodys", "sp", "fitch"],
      reinvestmentSpreadBps: 0,
      reinvestmentTenorQuarters: 8,
      reinvestmentRating: null,
      cccBucketLimitPct: 100,
      cccMarketValuePct: 100,
      deferredInterestCompounds: true,
    };

    const result = runProjection(inputs);
    const p0 = result.periods[0];
    expect(p0).toBeDefined();

    const aPaid = (p0.trancheInterest.find((t) => t.className === "Class A-1")?.paid ?? 0)
      + (p0.trancheInterest.find((t) => t.className === "Class A-2")?.paid ?? 0);
    const bPaid = p0.trancheInterest.find((t) => t.className === "Class B")?.paid ?? 0;
    const m1Paid = p0.trancheInterest.find((t) => t.className === "M-1")?.paid ?? 0;
    const m2Paid = p0.trancheInterest.find((t) => t.className === "M-2")?.paid ?? 0;
    expect(aPaid, "tier 0 (A-1 + A-2) interest must be > 0").toBeGreaterThan(0);
    expect(bPaid, "tier 1 (Class B) interest must be > 0").toBeGreaterThan(0);
    expect(m1Paid, "tier 2 (M-1) interest must be > 0").toBeGreaterThan(0);
    expect(m2Paid, "tier 3 (M-2) interest must be > 0").toBeGreaterThan(0);

    // Build a synthetic trustee waterfall. Each PPM step row carries the
    // engine's emitted amount so the harness comparison is exercised
    // against a known-good actual.
    const backtest: BacktestInputs = {
      reportDate: "2026-04-01",
      paymentDate: "2026-04-15",
      beginningPar: 120_000_000,
      waterfallSteps: [
        { waterfallType: "INTEREST", priorityOrder: 7, description: "(G)", amountDue: aPaid, amountPaid: aPaid, fundsAvailableBefore: null, fundsAvailableAfter: null, isOcTestDiversion: false, isIcTestDiversion: false },
        { waterfallType: "INTEREST", priorityOrder: 8, description: "(H)", amountDue: bPaid, amountPaid: bPaid, fundsAvailableBefore: null, fundsAvailableAfter: null, isOcTestDiversion: false, isIcTestDiversion: false },
        { waterfallType: "INTEREST", priorityOrder: 10, description: "(J)", amountDue: m1Paid, amountPaid: m1Paid, fundsAvailableBefore: null, fundsAvailableAfter: null, isOcTestDiversion: false, isIcTestDiversion: false },
        { waterfallType: "INTEREST", priorityOrder: 13, description: "(M)", amountDue: m2Paid, amountPaid: m2Paid, fundsAvailableBefore: null, fundsAvailableAfter: null, isOcTestDiversion: false, isIcTestDiversion: false },
      ],
      trancheSnapshots: [],
      complianceTests: [],
      accountBalances: [],
    };

    const harness = runBacktestHarness(inputs, backtest);

    // Assert each tier-positional bucket projects the right value (which
    // requires the rank-based path to find the correctly-named tranches).
    const stepG = harness.steps.find((s) => s.engineBucket === "stepG_interest")!;
    const classB = harness.steps.find((s) => s.engineBucket === "classB_interest")!;
    const classC = harness.steps.find((s) => s.engineBucket === "classC_current")!;
    const classD = harness.steps.find((s) => s.engineBucket === "classD_current")!;
    const classE = harness.steps.find((s) => s.engineBucket === "classE_current")!;
    const classF = harness.steps.find((s) => s.engineBucket === "classF_current")!;

    expect(stepG.projected).toBeCloseTo(aPaid, 2);
    expect(Math.abs(stepG.delta)).toBeLessThan(1);
    expect(classB.projected).toBeCloseTo(bPaid, 2);
    expect(Math.abs(classB.delta)).toBeLessThan(1);
    expect(classC.projected).toBeCloseTo(m1Paid, 2);
    expect(Math.abs(classC.delta)).toBeLessThan(1);
    expect(classD.projected).toBeCloseTo(m2Paid, 2);
    expect(Math.abs(classD.delta)).toBeLessThan(1);

    // No tier 4 / 5 tranches → classE/classF buckets emit 0 and trustee
    // has no (P)/(S) rows → both sides 0, delta = 0.
    expect(classE.projected).toBe(0);
    expect(classE.actual).toBe(0);
    expect(classF.projected).toBe(0);
    expect(classF.actual).toBe(0);
  });

  it("ocCure cure step routing follows trigger rank, not hardcoded rank numbers", () => {
    // Synthetic 3-debt-tier deal where Class C OC test fails. Under the OLD
    // hardcoded path (ocCure_AB sums diversionsByRank.get(1)+(2)+(3)), a
    // failing C trigger at rank 3 would route the cure into ocCure_AB
    // (wrong — should be in ocCure_C, the next bucket). Under the tier-
    // based path, the trigger's rank is matched against tier 2 (Class C)
    // and routed correctly to ocCure_C.
    //
    // Setup: 3 debt tiers (A=1, B=2, C=3), passing A/B trigger, failing C
    // trigger. Failure forced by very high triggerLevel (200% OC ratio).
    const loans: LoanInput[] = Array.from({ length: 4 }, (_, i) => ({
      parBalance: 25_000_000,
      maturityDate: addQuarters("2026-03-09", 24 + i),
      ratingBucket: "B",
      spreadBps: 410,
    currency: "EUR",
    }));

    const inputs: ProjectionInputs = {
      initialPar: 100_000_000,
    dealCurrency: "EUR",
      wacSpreadBps: 410,
      baseRatePct: CLO_DEFAULTS.baseRatePct,
      baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
      seniorFeePct: 0,
      subFeePct: 0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      incentiveFeePct: 0,
      incentiveFeeHurdleIrr: 0,
      postRpReinvestmentPct: 0,
      callMode: "none",
      callDate: null,
      callPricePct: 100,
      callPriceMode: "par",
      reinvestmentOcTrigger: null,
      tranches: [
        { className: "Class A", currentBalance: 60_000_000, spreadBps: 110, seniorityRank: 1, isFloating: true, isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
        { className: "Class B", currentBalance: 15_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true, isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
        { className: "Class C", currentBalance: 10_000_000, spreadBps: 350, seniorityRank: 3, isFloating: true, isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: true  },
        { className: "Subordinated Notes", currentBalance: 15_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      // A/B trigger trivially passes; C trigger forced to fail.
      ocTriggers: [
        { className: "A/B", triggerLevel: 100, rank: 2 },
        { className: "C",   triggerLevel: 200, rank: 3 },
      ],
      icTriggers: [],
      reinvestmentPeriodEnd: "2030-06-15",
      maturityDate: "2034-06-15",
      currentDate: "2026-03-09",
      loans,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      recoveryLagMonths: 6,
      ratingAgencies: ["moodys", "sp", "fitch"],
      reinvestmentSpreadBps: 0,
      reinvestmentTenorQuarters: 8,
      reinvestmentRating: null,
      cccBucketLimitPct: 100,
      cccMarketValuePct: 100,
      deferredInterestCompounds: true,
    };

    const result = runProjection(inputs);
    const p0 = result.periods[0];
    expect(p0).toBeDefined();

    // Confirm the C OC test is failing and a cure diversion fired at rank 3.
    const cureDiversions = p0.stepTrace.ocCureDiversions;
    expect(cureDiversions.length, "test must produce a cure diversion to be discriminating").toBeGreaterThan(0);
    const rank3Cure = cureDiversions.filter((d) => d.rank === 3).reduce((s, d) => s + d.amount, 0);
    expect(rank3Cure, "C trigger at rank 3 must fire").toBeGreaterThan(0);

    // Build a trustee backtest carrying the cure in step (L) — the PPM step
    // for "OC cure for Class C failing" — and 0 in step (I) (A/B passing).
    const backtest: BacktestInputs = {
      reportDate: "2026-04-01",
      paymentDate: "2026-04-15",
      beginningPar: 100_000_000,
      waterfallSteps: [
        { waterfallType: "INTEREST", priorityOrder: 9, description: "(I)", amountDue: 0, amountPaid: 0, fundsAvailableBefore: null, fundsAvailableAfter: null, isOcTestDiversion: false, isIcTestDiversion: false },
        { waterfallType: "INTEREST", priorityOrder: 12, description: "(L)", amountDue: rank3Cure, amountPaid: rank3Cure, fundsAvailableBefore: null, fundsAvailableAfter: null, isOcTestDiversion: true, isIcTestDiversion: false },
      ],
      trancheSnapshots: [],
      complianceTests: [],
      accountBalances: [],
    };

    const harness = runBacktestHarness(inputs, backtest);
    const ocCureAB = harness.steps.find((s) => s.engineBucket === "ocCure_AB")!;
    const ocCureC = harness.steps.find((s) => s.engineBucket === "ocCure_C")!;

    // Pre-fix: ocCure_AB summed ranks 1+2+3, so the rank-3 C cure was
    // mis-attributed into ocCure_AB. Post-fix: rank 3 lives in tier 2,
    // routed to ocCure_C.
    expect(ocCureAB.projected, "rank-3 C cure must NOT bleed into ocCure_AB").toBe(0);
    expect(ocCureC.projected).toBeCloseTo(rank3Cure, 2);
    expect(Math.abs(ocCureC.delta)).toBeLessThan(1);
  });

  it("throws on a deal with more than 6 non-amortising debt tiers", () => {
    // Synthetic 7-debt-tier deal. The PPM waterfall step letters G–U cover
    // 6 letter classes (A–F); a 7th tier has no PPM step letter to compare
    // against, so the harness fails loud rather than silently dropping the
    // surplus tier from comparison. This guard is the difference between
    // "engine emits 0 because nothing matches" (silent) and "harness throws
    // a clear error" (loud) — the latter is required for correctness on a
    // never-Euro-XV-shaped deal.
    const loans: LoanInput[] = Array.from({ length: 4 }, (_, i) => ({
      parBalance: 25_000_000,
      maturityDate: addQuarters("2026-03-09", 24 + i),
      ratingBucket: "B",
      spreadBps: 410,
    currency: "EUR",
    }));

    const inputs: ProjectionInputs = {
      initialPar: 100_000_000,
    dealCurrency: "EUR",
      wacSpreadBps: 410,
      baseRatePct: CLO_DEFAULTS.baseRatePct,
      baseRateFloorPct: CLO_DEFAULTS.baseRateFloorPct,
      seniorFeePct: 0,
      subFeePct: 0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      incentiveFeePct: 0,
      incentiveFeeHurdleIrr: 0,
      postRpReinvestmentPct: 0,
      callMode: "none",
      callDate: null,
      callPricePct: 100,
      callPriceMode: "par",
      reinvestmentOcTrigger: null,
      // 7 non-amortising debt tiers (one too many).
      tranches: [
        { className: "A",      currentBalance: 40_000_000, spreadBps: 110, seniorityRank: 1, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
        { className: "B",      currentBalance: 15_000_000, spreadBps: 200, seniorityRank: 2, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
        { className: "C",      currentBalance: 12_000_000, spreadBps: 300, seniorityRank: 3, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: true  },
        { className: "D",      currentBalance: 10_000_000, spreadBps: 400, seniorityRank: 4, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: true  },
        { className: "E",      currentBalance:  8_000_000, spreadBps: 500, seniorityRank: 5, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: true  },
        { className: "F",      currentBalance:  5_000_000, spreadBps: 600, seniorityRank: 6, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: true  },
        { className: "G",      currentBalance:  3_000_000, spreadBps: 700, seniorityRank: 7, isFloating: true,  isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: true  },
        { className: "Equity", currentBalance:  7_000_000, spreadBps:   0, seniorityRank: 8, isFloating: false, isIncomeNote: true,  isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      reinvestmentPeriodEnd: "2030-06-15",
      maturityDate: "2034-06-15",
      currentDate: "2026-03-09",
      loans,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      recoveryLagMonths: 6,
      ratingAgencies: ["moodys", "sp", "fitch"],
      reinvestmentSpreadBps: 0,
      reinvestmentTenorQuarters: 8,
      reinvestmentRating: null,
      cccBucketLimitPct: 100,
      cccMarketValuePct: 100,
      deferredInterestCompounds: true,
    };

    const backtest: BacktestInputs = {
      reportDate: "2026-04-01",
      paymentDate: "2026-04-15",
      beginningPar: 100_000_000,
      waterfallSteps: [],
      trancheSnapshots: [],
      complianceTests: [],
      accountBalances: [],
    };

    expect(() => runBacktestHarness(inputs, backtest)).toThrow(
      /7 non-amortising debt tiers.*supports up to 6/,
    );
  });
});
