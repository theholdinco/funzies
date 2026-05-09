/**
 * Harness step-(G) merge correctness on Class X-bearing deals.
 *
 * On a deal with an amortising Class X tranche, PPM step (G) pays Class A
 * interest AND Class X scheduled amortisation pari-passu pro-rata from the
 * interest pool. Trustee waterfall reports step (g) as a single line summing
 * both flows. The harness's `stepG_interest` bucket merges the engine's
 * Class A interest payment with `stepTrace.classXAmortFromInterest` so the
 * comparison against trustee[g] ties out 1:1.
 *
 * Splitting these into two buckets would diverge from trustee[g] by exactly
 * the Class X amort amount on any Class X-bearing deal — silent on Euro XV
 * (no Class X) but a loud false "engine bug" signal on the next deal whose
 * capital structure includes an amortising tranche.
 */

import { describe, it, expect } from "vitest";
import { runProjection, addQuarters, type ProjectionInputs, type LoanInput } from "../projection";
import { CLO_DEFAULTS } from "../defaults";
import { runBacktestHarness } from "../backtest-harness";
import type { BacktestInputs } from "../backtest-types";
import { uniformRates } from "./test-helpers";

describe("harness step-(G) merge", () => {
  it("stepG_interest bucket equals Class A interest + Class X amort and ties to trustee[g]", () => {
    // Build a synthetic deal with an amortising Class X tranche (rank 1) and
    // a non-amortising Class A (rank 2). Class X amort fires on period 0
    // because no amortStartDate is set.
    const loans: LoanInput[] = Array.from({ length: 5 }, (_, i) => ({
      parBalance: 30_000_000,
      maturityDate: addQuarters("2026-03-09", 24 + i),
      ratingBucket: "B",
      spreadBps: 410,
    currency: "EUR",
    }));

    const inputs: ProjectionInputs = {
      initialPar: 150_000_000,
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
        {
          className: "Class X",
          currentBalance: 4_000_000,
          spreadBps: 0,
          seniorityRank: 1,
          isFloating: false,
          isIncomeNote: false,
          paymentFrequency: "quarterly" as const,
        isDeferrable: false,
          isAmortising: true,
          amortisationPerPeriod: 400_000,
        },
        {
          className: "Class A",
          currentBalance: 100_000_000,
          spreadBps: 110,
          seniorityRank: 2,
          isFloating: true,
          isIncomeNote: false,
          paymentFrequency: "quarterly" as const,
        isDeferrable: false,
        },
        {
          className: "Subordinated Notes",
          currentBalance: 30_000_000,
          spreadBps: 0,
          seniorityRank: 3,
          isFloating: false,
          isIncomeNote: true,
          isDeferrable: false,
        },
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

    // 1. Run the engine and read the period-0 Class A interest paid + Class X
    //    amort paid from interest. Both must be > 0 for the test to be
    //    discriminating.
    const result = runProjection(inputs);
    const p0 = result.periods[0];
    expect(p0).toBeDefined();
    const classAPaid = p0.trancheInterest.find((t) => t.className === "Class A")?.paid ?? 0;
    const classXAmort = p0.stepTrace.classXAmortFromInterest;
    expect(classAPaid, "Class A interest paid must be > 0 — test isn't discriminating otherwise").toBeGreaterThan(0);
    expect(classXAmort, "Class X amort paid from interest must be > 0 — test isn't discriminating otherwise").toBeGreaterThan(0);

    // 2. Build a synthetic trustee BacktestInputs whose only INTEREST step is
    //    a single (G) line carrying classAPaid + classXAmort — the realistic
    //    shape of a trustee report on a Class X-bearing deal.
    const trusteeStepG = classAPaid + classXAmort;
    const backtest: BacktestInputs = {
      reportDate: "2026-04-01",
      paymentDate: "2026-04-15",
      beginningPar: 150_000_000,
      waterfallSteps: [
        {
          waterfallType: "INTEREST",
          priorityOrder: 7,
          description: "(G)",
          amountDue: trusteeStepG,
          amountPaid: trusteeStepG,
          fundsAvailableBefore: null,
          fundsAvailableAfter: null,
          isOcTestDiversion: false,
          isIcTestDiversion: false,
        },
      ],
      trancheSnapshots: [],
      complianceTests: [],
      accountBalances: [],
    };

    // 3. Run the harness; the stepG_interest bucket must tie to trustee[g]
    //    within €1 (pure arithmetic — no day-count / period-mismatch noise
    //    on a synthetic single-period deal).
    //
    // The `as string` cast on the find lets this test type-check cleanly
    // BOTH pre-rename (when "stepG_interest" is not yet in the EngineBucket
    // union — TS2367 otherwise) and post-rename. Same shape used for the
    // two retired-bucket finds below.
    const harness = runBacktestHarness(inputs, backtest);
    const stepG = harness.steps.find((s) => (s.engineBucket as string) === "stepG_interest");
    expect(stepG, "harness must emit a stepG_interest bucket").toBeDefined();
    expect(stepG!.actual).toBeCloseTo(trusteeStepG, 2);
    expect(stepG!.projected).toBeCloseTo(classAPaid + classXAmort, 2);
    expect(Math.abs(stepG!.delta)).toBeLessThan(1);

    // 4. The old separate `classXAmortFromInterest` bucket must no longer be
    //    emitted (it was merged into stepG_interest).
    const orphanBucket = harness.steps.find((s) => (s.engineBucket as string) === "classXAmortFromInterest");
    expect(orphanBucket, "classXAmortFromInterest bucket must be retired post-merge").toBeUndefined();

    // 5. The old bucket name `classA_interest` must also be gone.
    const oldClassA = harness.steps.find((s) => (s.engineBucket as string) === "classA_interest");
    expect(oldClassA, "classA_interest bucket must be renamed to stepG_interest post-merge").toBeUndefined();
  });
});
