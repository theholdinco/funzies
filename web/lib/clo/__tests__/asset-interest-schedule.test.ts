import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFromResolved, composeBuildWarnings, DEFAULT_ASSUMPTIONS, IncompleteDataError } from "../build-projection-inputs";
import {
  normalizeAssetPaymentIntervalMonths,
  runProjection,
  type LoanInput,
} from "../projection";
import { resolveWaterfallInputs } from "../resolver";
import type { CloAccrual, CloHolding, ExtractedConstraints } from "../types";
import { makeInputs, noDefaults } from "./test-helpers";

const baseLoan: LoanInput = {
  parBalance: 1_200_000,
  maturityDate: "2028-01-01",
  ratingBucket: "B",
  spreadBps: 1_200,
  currency: "EUR",
};

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");

function scheduleInputs(loan: LoanInput) {
  return makeInputs({
    currentDate: "2026-01-01",
    firstPeriodEndDate: null,
    maturityDate: "2027-01-01",
    reinvestmentPeriodEnd: "2025-12-31",
    baseRatePct: 0,
    baseRateFloorPct: 0,
    cprPct: 0,
    ...noDefaults,
    loans: [loan],
  });
}

describe("asset interest payment schedules", () => {
  it("normalizes supported asset payment periods", () => {
    expect(normalizeAssetPaymentIntervalMonths("1 Month")).toBe(1);
    expect(normalizeAssetPaymentIntervalMonths("2 Months")).toBe(2);
    expect(normalizeAssetPaymentIntervalMonths("3 Months")).toBe(3);
    expect(normalizeAssetPaymentIntervalMonths("6 Months")).toBe(6);
    expect(normalizeAssetPaymentIntervalMonths("Quarterly")).toBe(3);
    expect(normalizeAssetPaymentIntervalMonths("Semi-Annual")).toBe(6);
    expect(normalizeAssetPaymentIntervalMonths("7 Months")).toBeNull();
  });

  it("keeps compatibility mode when frequency lacks a payment-date anchor", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "3 Months",
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(36_000, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("collects explicit opening accrued interest even when schedule evidence is incomplete", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "3 Months",
      openingAccruedInterest: 10_000,
    }));
    const inputs = (openingAccruedInterest?: number) => makeInputs({
      currentDate: "2026-01-01",
      firstPeriodEndDate: null,
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "3 Months",
        openingAccruedInterest,
      }],
      tranches: [
        { className: "A", currentBalance: 1_000_000, spreadBps: 1_200, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, paymentFrequency: "quarterly" },
        { className: "Sub", currentBalance: 200_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    });
    const baseline = runProjection(inputs());
    const withOpeningReceivable = runProjection(inputs(10_000));

    expect(
      withOpeningReceivable.initialState.equityBookValue - baseline.initialState.equityBookValue,
    ).toBeCloseTo(10_000, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(46_000, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("defers scheduled interest until the anchored asset payment date", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "6 Months",
      nextPaymentDate: "2026-07-01",
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(0, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(36_000, 0);
    expect(result.periods[1].interestCollected).toBeCloseTo(72_400, 0);
    expect(result.periods[1].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("includes opening accrued-interest receivable in the first scheduled receipt", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "3 Months",
      nextPaymentDate: "2026-04-01",
      openingAccruedInterest: 5_000,
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(41_000, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("includes opening accrued-interest receivable in T0 equity book value", () => {
    const inputs = (openingAccruedInterest?: number) => makeInputs({
      currentDate: "2026-01-01",
      firstPeriodEndDate: null,
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "3 Months",
        nextPaymentDate: "2026-04-01",
        openingAccruedInterest,
      }],
      tranches: [
        { className: "A", currentBalance: 1_000_000, spreadBps: 1_200, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, paymentFrequency: "quarterly" },
        { className: "Sub", currentBalance: 200_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    });
    const baseline = runProjection(inputs());
    const withOpeningReceivable = runProjection(inputs(100_000));

    expect(
      withOpeningReceivable.initialState.equityBookValue - baseline.initialState.equityBookValue,
    ).toBeCloseTo(100_000, 0);
  });

  it("computes opening receivable from accrualBeginDate when extracted accrued interest is absent", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "3 Months",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: "2025-12-01",
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(48_400, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("infers opening receivable from the previous scheduled payment date when accrual basis is absent", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-02-01",
      firstPeriodEndDate: null,
      maturityDate: "2027-02-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "3 Months",
        nextPaymentDate: "2026-04-01",
      }],
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(36_000, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(12_000, 0);
  });

  it("does not carry pre-payment-period receivable across a stale asset payment anchor", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-05-15",
      firstPeriodEndDate: null,
      maturityDate: "2027-05-15",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "3 Months",
        nextPaymentDate: "2026-04-01",
        accrualBeginDate: "2026-01-01",
      }],
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(36_400, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(18_000, 0);
  });

  it("honors explicit zero opening accrued-interest instead of recomputing from accrualBeginDate", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "3 Months",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: "2025-12-01",
      openingAccruedInterest: 0,
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(36_000, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("splits accrual around off-cycle payment dates inside a monthly tick", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "3 Months",
      nextPaymentDate: "2026-01-15",
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(36_800, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(30_400, 0);
  });

  it("supports two-month scheduled asset interest receipts", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "2 Months",
      nextPaymentDate: "2026-02-15",
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(24_800, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(18_000, 0);
    expect(result.periods[1].interestCollected).toBeCloseTo(48_000, 0);
  });

  it("collects multiple borrower payment dates inside one monthly tick", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-30",
      stubPeriod: true,
      firstPeriodEndDate: "2026-02-28",
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "1 Month",
        nextPaymentDate: "2026-01-31",
      }],
      tranches: [
        { className: "A", currentBalance: 1_200_000, spreadBps: 1_200, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, paymentFrequency: "quarterly" },
        { className: "Sub", currentBalance: 1, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    }));

    expect(result.periods[0].date).toBe("2026-02-28");
    expect(result.periods[0].interestCollected).toBeCloseTo(23_600, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
    expect(result.initialState.icTests[0].actual).toBeCloseTo((23_600 / 11_600) * 100, 6);
  });

  it("keeps month-end asset schedules anchored after short months", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-31",
      firstPeriodEndDate: "2026-02-28",
      maturityDate: "2026-03-31",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "1 Month",
        nextPaymentDate: "2026-02-28",
      }],
    }));

    expect(result.periods[0].date).toBe("2026-03-31");
    expect(result.periods[0].interestCollected).toBeCloseTo(23_600, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("includes all scheduled borrower receipts in the T0 IC collateral numerator", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-01",
      firstPeriodEndDate: null,
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "1 Month",
        nextPaymentDate: "2026-01-15",
      }],
      tranches: [
        { className: "A", currentBalance: 1_200_000, spreadBps: 1_200, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, paymentFrequency: "quarterly" },
        { className: "Sub", currentBalance: 1, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(36_000, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(6_800, 0);
    expect(result.initialState.icTests[0].actual).toBeCloseTo(100, 6);
  });

  it("includes scheduled receivable released by loan maturity in the T0 IC collateral numerator", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-01",
      firstPeriodEndDate: null,
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        maturityDate: "2026-02-01",
        assetPaymentPeriodRaw: "6 Months",
        nextPaymentDate: "2026-07-01",
      }],
      tranches: [
        { className: "A", currentBalance: 1_200_000, spreadBps: 1_200, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, paymentFrequency: "quarterly" },
        { className: "Sub", currentBalance: 1, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(12_400, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
    expect(result.initialState.icTests[0].actual).toBeCloseTo((12_400 / 36_000) * 100, 6);
  });

  it("includes opening scheduled receivable released by payoff exactly on currentDate in T0 IC", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-01",
      firstPeriodEndDate: null,
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        maturityDate: "2026-01-01",
        assetPaymentPeriodRaw: "6 Months",
        nextPaymentDate: "2026-07-01",
        openingAccruedInterest: 10_000,
      }],
      tranches: [
        { className: "A", currentBalance: 1_200_000, spreadBps: 1_200, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, paymentFrequency: "quarterly" },
        { className: "Sub", currentBalance: 1, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(10_000, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
    expect(result.initialState.icTests[0].actual).toBeCloseTo((10_000 / 36_000) * 100, 6);
  });

  it("does not double-count T0 accrual when maturity follows multiple asset payment dates", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-01",
      firstPeriodEndDate: null,
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        maturityDate: "2026-03-15",
        assetPaymentPeriodRaw: "1 Month",
        nextPaymentDate: "2026-02-01",
      }],
      tranches: [
        { className: "A", currentBalance: 1_200_000, spreadBps: 1_200, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, paymentFrequency: "quarterly" },
        { className: "Sub", currentBalance: 1, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(29_200, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
    expect(result.initialState.icTests[0].actual).toBeCloseTo((29_200 / 36_000) * 100, 6);
  });

  it("caps mixed-pool T0 unscheduled accrual at loan maturity", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-01",
      firstPeriodEndDate: null,
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [
        {
          ...baseLoan,
          maturityDate: "2026-02-01",
        },
        {
          ...baseLoan,
          assetPaymentPeriodRaw: "6 Months",
          nextPaymentDate: "2026-07-01",
        },
      ],
      tranches: [
        { className: "A", currentBalance: 1_200_000, spreadBps: 1_200, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, paymentFrequency: "quarterly" },
        { className: "Sub", currentBalance: 1, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(12_400, 0);
    expect(result.initialState.icTests[0].actual).toBeCloseTo(10.76388888888889, 6);
  });


  it("keeps schedules active when an initially unfunded DDTL draws", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      parBalance: 0,
      undrawnCommitment: 1_200_000,
      isDelayedDraw: true,
      drawQuarter: 1,
      ddtlSpreadBps: 1_200,
      assetPaymentPeriodRaw: "6 Months",
      nextPaymentDate: "2026-07-01",
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(0, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(36_000, 0);
    expect(result.periods[1].interestCollected).toBeCloseTo(72_400, 0);
    expect(result.periods[1].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("rolls stale scheduled dates while an unfunded DDTL waits to draw", () => {
    const result = runProjection(scheduleInputs({
      ...baseLoan,
      parBalance: 0,
      undrawnCommitment: 1_200_000,
      isDelayedDraw: true,
      drawQuarter: 2,
      ddtlSpreadBps: 1_200,
      assetPaymentPeriodRaw: "1 Month",
      nextPaymentDate: "2026-01-15",
    }));

    expect(result.periods[0].interestCollected).toBeCloseTo(0, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
    expect(result.periods[1].interestCollected).toBeCloseTo(30_000, 0);
    expect(result.periods[1].endingAssetInterestReceivable).toBeCloseTo(6_400, 0);
  });


  it("releases prepaid-share receivable before the next scheduled asset payment date", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-01",
      firstPeriodEndDate: null,
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 100,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "6 Months",
        nextPaymentDate: "2026-07-01",
      }],
    }));

    expect(result.periods[0].prepayments).toBeCloseTo(1_080_000, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(16_670, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(3_600, 0);
  });

  it("writes off defaulted-share current receivable before scheduled collection", () => {
    let draws = 0;
    const result = runProjection(
      scheduleInputs({
        ...baseLoan,
        assetPaymentPeriodRaw: "3 Months",
        nextPaymentDate: "2026-04-01",
        openingAccruedInterest: 10_000,
      }),
      (par) => {
        draws += 1;
        return draws === 1 ? par * 0.5 : 0;
      },
    );

    expect(result.periods[0].defaults).toBeCloseTo(600_000, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(23_000, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("does not collect defaulted-par accrual on a same-tick asset payment date", () => {
    let draws = 0;
    const result = runProjection(
      makeInputs({
        currentDate: "2026-03-15",
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-15",
        maturityDate: "2026-06-15",
        reinvestmentPeriodEnd: "2025-12-31",
        baseRatePct: 0,
        baseRateFloorPct: 0,
        cprPct: 0,
        ...noDefaults,
        loans: [{
          ...baseLoan,
          assetPaymentPeriodRaw: "3 Months",
          nextPaymentDate: "2026-04-01",
          openingAccruedInterest: 0,
        }],
      }),
      (par) => {
        draws += 1;
        return draws === 1 ? par * 0.5 : 0;
      },
    );

    expect(result.periods[0].defaults).toBeCloseTo(600_000, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(3_400, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(2_800, 0);
  });

  it("releases outstanding receivable at terminal call payoff", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-01",
      callMode: "optionalRedemption",
      callDate: "2026-04-01",
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "6 Months",
        nextPaymentDate: "2026-07-01",
      }],
    }));

    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].interestCollected).toBeCloseTo(36_000, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("includes terminal call receivable release in the T0 IC collateral numerator", () => {
    const result = runProjection(makeInputs({
      currentDate: "2026-01-01",
      firstPeriodEndDate: null,
      callMode: "optionalRedemption",
      callDate: "2026-02-01",
      nonCallPeriodEnd: null,
      maturityDate: "2027-01-01",
      reinvestmentPeriodEnd: "2025-12-31",
      baseRatePct: 0,
      baseRateFloorPct: 0,
      cprPct: 0,
      ...noDefaults,
      loans: [{
        ...baseLoan,
        assetPaymentPeriodRaw: "6 Months",
        nextPaymentDate: "2026-07-01",
      }],
      tranches: [
        { className: "A", currentBalance: 1_200_000, spreadBps: 1_200, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false, paymentFrequency: "quarterly" },
        { className: "Sub", currentBalance: 1, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
    }));

    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].interestCollected).toBeCloseTo(12_400, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
    expect(result.initialState.icTests[0].actual).toBeCloseTo((12_400 / 12_400) * 100, 6);
  });

  it("blocks unsupported explicit anchored schedules", () => {
    expect(() => runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "7 Months",
      nextPaymentDate: "2026-08-01",
    }))).toThrow(/unsupported anchored asset payment period/i);
  });

  it("blocks unsupported raw anchored schedules even when a numeric interval is supplied", () => {
    expect(() => runProjection(scheduleInputs({
      ...baseLoan,
      assetPaymentPeriodRaw: "7 Months",
      assetPaymentIntervalMonths: 3,
      nextPaymentDate: "2026-08-01",
    }))).toThrow(/unsupported anchored asset payment period/i);
  });

  it("buildFromResolved blocks unsupported numeric anchored schedule intervals", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const resolved = structuredClone(fixture.resolved);
    resolved.loans[0] = {
      ...resolved.loans[0],
      assetPaymentIntervalMonths: 7,
      nextPaymentDate: "2026-08-01",
      assetPaymentPeriodRaw: null,
    };

    expect(() => buildFromResolved(resolved, DEFAULT_ASSUMPTIONS)).toThrow(IncompleteDataError);
  });

  it("composeBuildWarnings surfaces invalid anchored schedule dates without resolver warnings", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const resolved = structuredClone(fixture.resolved);
    resolved.loans[0] = {
      ...resolved.loans[0],
      assetPaymentPeriodRaw: "3 Months",
      nextPaymentDate: "2026-02-31",
    };

    const warnings = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, []);

    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toBe(true);
  });

  it("composeBuildWarnings surfaces missing schedule anchors without resolver warnings", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const resolved = structuredClone(fixture.resolved);
    resolved.loans[0] = {
      ...resolved.loans[0],
      assetPaymentPeriodRaw: "3 Months",
      nextPaymentDate: null,
    };

    const warnings = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, []);

    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toBe(true);
  });

  it("composeBuildWarnings surfaces numeric schedule intervals without anchors", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const resolved = structuredClone(fixture.resolved);
    resolved.loans = [{
      ...resolved.loans[0],
      obligorName: "Numeric Missing Anchor",
      assetPaymentPeriodRaw: null,
      assetPaymentIntervalMonths: 3,
      nextPaymentDate: null,
    }];

    const warnings = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, []);

    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toBe(true);
  });

  it("threads holding schedule fields through resolved loans", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Schedule Test",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      ratingBucket: "B",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "2 Months",
      nextPaymentDate: "2026-03-01",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-03-01",
      accruedInterest: 8_000,
    } as unknown as CloHolding;

    const { resolved } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "2 Months",
      assetPaymentIntervalMonths: 2,
      assetPaymentScheduleSource: "holding",
      nextPaymentDate: "2026-03-01",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-03-01",
      openingAccruedInterest: 8_000,
    });
  });

  it("warns and stays compatible when frequency has no valid payment-date anchor", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Missing Anchor",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      nextPaymentDate: "2026-02-31",
    } as CloHolding;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
    );

    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toBe(true);
    const composed = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, warnings);
    expect(composed.filter((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toHaveLength(1);
    expect(resolved.loans[0].assetPaymentIntervalMonths).toBe(3);
    expect(resolved.loans[0].nextPaymentDate).toBeUndefined();
    const result = runProjection(scheduleInputs(resolved.loans[0] as LoanInput));
    expect(result.periods[0].interestCollected).toBeCloseTo(12_500, 0);
    expect(result.periods[0].endingAssetInterestReceivable).toBeCloseTo(0, 0);
  });

  it("emits a blocking resolver warning for unsupported anchored periods", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Unsupported Anchor",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "7 Months",
      nextPaymentDate: "2026-08-01",
    } as CloHolding;

    const { warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
    );

    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      w.blocking &&
      /unsupported anchored asset payment period/.test(w.message)
    )).toBe(true);
  });

  it("uses accrual rows for missing frequency and accrual dates", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Accrual Join Test",
      lxid: "LX123",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: " ",
      nextPaymentDate: "2026-07-01",
    } as CloHolding;
    const accrual = {
      loanxId: "LX123",
      paymentFrequency: "6 Months",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-07-01",
    } as CloAccrual;

    const { resolved } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "6 Months",
      assetPaymentIntervalMonths: 6,
      assetPaymentScheduleSource: "accrual",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-07-01",
    });
  });

  it("uses accrualEndDate as the anchor when only accrual schedule evidence is present", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Accrual Anchor Test",
      lxid: "LX124",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
    } as CloHolding;
    const accrual = {
      loanxId: "LX124",
      paymentFrequency: "3 Months",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloAccrual;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      assetPaymentScheduleSource: "accrual",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toBe(false);
  });

  it("does not promote accrualEndDate to nextPaymentDate without frequency evidence", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Accrual Date Without Frequency",
      lxid: "LX128",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
    } as CloHolding;
    const accrual = {
      loanxId: "LX128",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloAccrual;

    const { resolved } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(resolved.loans[0].assetPaymentPeriodRaw).toBeUndefined();
    expect(resolved.loans[0].assetPaymentIntervalMonths).toBeUndefined();
    expect(resolved.loans[0].nextPaymentDate).toBeUndefined();
    expect(resolved.loans[0].accrualEndDate).toBe("2026-04-01");
  });

  it("uses a valid accrual-row anchor when the holding anchor is invalid", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Invalid Holding Anchor With Accrual",
      lxid: "LX129",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      nextPaymentDate: "2026-02-31",
    } as CloHolding;
    const accrual = {
      loanxId: "LX129",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloAccrual;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      nextPaymentDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /invalid nextPaymentDate/.test(w.message)
    )).toBe(true);
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toBe(false);
  });

  it("uses accrualEndDate as the anchor when the holding supplies only frequency", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Holding Frequency Accrual Anchor",
      lxid: "LX125",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
    } as CloHolding;
    const accrual = {
      loanxId: "LX125",
      paymentFrequency: null,
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloAccrual;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      assetPaymentScheduleSource: "holding",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toBe(false);
  });

  it("blocks unsupported holding frequency when an accrual row supplies the anchor", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Unsupported Holding Frequency Accrual Anchor",
      lxid: "LX126",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "7 Months",
    } as CloHolding;
    const accrual = {
      loanxId: "LX126",
      accrualEndDate: "2026-08-01",
    } as CloAccrual;

    const { warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      w.blocking &&
      /unsupported anchored asset payment period/.test(w.message)
    )).toBe(true);
  });

  it("uses CUSIP/securityId accrual matches for missing frequency and accrual dates", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Cusip Accrual Join",
      cusip: "123456AB7",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      nextPaymentDate: "2026-04-01",
    } as CloHolding;
    const accrual = {
      securityId: "123456AB7",
      paymentFrequency: "3 Months",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloAccrual;

    const { resolved } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      assetPaymentScheduleSource: "accrual",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    });
  });

  it("does not let a blank holding accrual begin date mask the accrual row date", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Blank Begin Date Accrual Join",
      lxid: "LX127",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: " ",
    } as CloHolding;
    const accrual = {
      loanxId: "LX127",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloAccrual;

    const { resolved } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(resolved.loans[0].accrualBeginDate).toBe("2026-01-01");
  });

  it("normalizes formatted CUSIP/securityId values for accrual matches", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Formatted Cusip Accrual Join",
      cusip: "123 456 AB7",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      nextPaymentDate: "2026-04-01",
    } as CloHolding;
    const accrual = {
      securityId: "123-456-ab7",
      paymentFrequency: "3 Months",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloAccrual;

    const { resolved } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      assetPaymentScheduleSource: "accrual",
    });
  });

  it("keeps contradictory nextPaymentDate and accrualEndDate evidence in compatibility mode", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Contradictory Schedule",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      nextPaymentDate: "2026-09-30",
      accrualBeginDate: "2026-03-31",
      accrualEndDate: "2026-06-30",
    } as CloHolding;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
    );

    expect(resolved.loans[0].assetPaymentIntervalMonths).toBeUndefined();
    expect(resolved.loans[0].nextPaymentDate).toBeUndefined();
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /accrualEndDate/.test(w.message)
    )).toBe(true);
    const composed = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, warnings);
    expect(composed.filter((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toHaveLength(0);
  });

  it("keeps conflicting holding and accrual schedule evidence in compatibility mode", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Holding Accrual Conflict",
      lxid: "LX777",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloHolding;
    const accrual = {
      loanxId: "LX777",
      paymentFrequency: "6 Months",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-07-01",
    } as CloAccrual;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      [accrual],
    );

    expect(resolved.loans[0].assetPaymentIntervalMonths).toBeUndefined();
    expect(resolved.loans[0].nextPaymentDate).toBeUndefined();
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /contradictory asset schedule evidence/.test(w.message)
    )).toBe(true);
  });

  it("does not duplicate unsupported-period blocking warnings between resolver and build", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Unsupported Duplicate Guard",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "7 Months",
      nextPaymentDate: "2026-08-01",
    } as CloHolding;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
    );
    const composed = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, warnings);

    expect(composed.filter((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      w.blocking &&
      /unsupported anchored asset payment period/.test(w.message)
    )).toHaveLength(1);
  });

  it("does not duplicate unsupported-period warnings for anonymous holdings", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "7 Months",
      nextPaymentDate: "2026-08-01",
    } as CloHolding;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
    );
    const composed = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, warnings);

    expect(composed.filter((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      w.blocking &&
      /unsupported anchored asset payment period/.test(w.message)
    )).toHaveLength(1);
  });

  it("does not suppress distinct build-side unsupported-period warnings for other loans", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const resolved = structuredClone(fixture.resolved);
    resolved.loans = [
      {
        ...resolved.loans[0],
        obligorName: "Unsupported One",
        assetPaymentPeriodRaw: "7 Months",
        assetPaymentIntervalMonths: undefined,
        nextPaymentDate: "2026-08-01",
      },
      {
        ...resolved.loans[1],
        obligorName: "Unsupported Two",
        assetPaymentPeriodRaw: "8 Months",
        assetPaymentIntervalMonths: undefined,
        nextPaymentDate: "2026-08-01",
      },
    ];
    const resolverWarning = {
      field: "loans.assetPaymentSchedule",
      message:
        `Holding "Unsupported One" has unsupported anchored asset payment period ` +
        `"7 Months" with nextPaymentDate 2026-08-01. Supported intervals are 1, 2, 3, and 6 months.`,
      severity: "error",
      blocking: true,
    } as const;

    const composed = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, [resolverWarning]);

    expect(composed.filter((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      w.blocking &&
      /unsupported anchored asset payment period/.test(w.message)
    )).toHaveLength(2);
  });

  it("blocks conflicting raw asset period and numeric interval evidence", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const resolved = structuredClone(fixture.resolved);
    resolved.loans = [{
      ...resolved.loans[0],
      obligorName: "Conflicting Interval",
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 6,
      nextPaymentDate: "2026-04-01",
    }];

    const composed = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, []);

    expect(composed.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      w.blocking &&
      /conflicting asset payment interval evidence/.test(w.message)
    )).toBe(true);
    expect(() => buildFromResolved(resolved, DEFAULT_ASSUMPTIONS)).toThrow(IncompleteDataError);
    expect(() =>
      runProjection(scheduleInputs({
        ...baseLoan,
        assetPaymentPeriodRaw: "3 Months",
        assetPaymentIntervalMonths: 6,
        nextPaymentDate: "2026-04-01",
      })),
    ).toThrow(/conflicting asset payment interval evidence/);
  });

  it("blocks negative opening accrued-interest receivables", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const resolved = structuredClone(fixture.resolved);
    resolved.loans = [{
      ...resolved.loans[0],
      obligorName: "Negative Opening Receivable",
      openingAccruedInterest: -100_000,
    }];

    const composed = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, []);

    expect(composed.some((w) =>
      w.field === "loans.openingAccruedInterest" &&
      w.blocking &&
      /invalid opening accrued interest/.test(w.message)
    )).toBe(true);
    resolved.loans = [{
      ...resolved.loans[0],
      parBalance: 0,
      undrawnCommitment: 0,
      openingAccruedInterest: -1,
    }];
    expect(composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, []).some((w) =>
      w.field === "loans.openingAccruedInterest" &&
      w.blocking
    )).toBe(true);
    expect(() => buildFromResolved(resolved, DEFAULT_ASSUMPTIONS)).toThrow(IncompleteDataError);
    expect(() =>
      runProjection(scheduleInputs({
        ...baseLoan,
        assetPaymentPeriodRaw: "3 Months",
        assetPaymentIntervalMonths: 3,
        nextPaymentDate: "2026-04-01",
        openingAccruedInterest: -1,
      })),
    ).toThrow(/invalid opening accrued interest/);
    expect(() =>
      runProjection(scheduleInputs({
        ...baseLoan,
        parBalance: 0,
        openingAccruedInterest: -1,
      })),
    ).toThrow(/invalid opening accrued interest/);
  });

  it("does not attach arbitrary accrual schedules when duplicate identifier matches are ambiguous", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Ambiguous Accrual",
      lxid: "LX999",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      nextPaymentDate: "2026-04-01",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX999", paymentFrequency: "3 Months" },
      { id: "a2", loanxId: "LX999", paymentFrequency: "6 Months" },
    ] as unknown as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0].assetPaymentPeriodRaw).toBeUndefined();
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /duplicate or conflicting accrual rows/.test(w.message)
    )).toBe(true);
  });

  it("keeps complete holding schedules active when supplemental accrual identifiers conflict", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Complete Holding Ambiguous Accrual",
      lxid: "LX995",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX995", paymentFrequency: "3 Months", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-04-01" },
      { id: "a2", loanxId: "LX995", paymentFrequency: "6 Months", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-07-01" },
    ] as unknown as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      assetPaymentScheduleSource: "holding",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /duplicate or conflicting accrual rows/.test(w.message)
    )).toBe(true);
  });

  it("uses holding accrualEndDate as the payment anchor when nextPaymentDate is blank", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Holding Accrual End Anchor",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloHolding;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      assetPaymentScheduleSource: "holding",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toBe(false);
  });

  it("keeps holding accrualEndDate schedules active when supplemental accrual identifiers conflict", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Holding Anchor Ambiguous Accrual",
      lxid: "LX994",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX994", paymentFrequency: "3 Months", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-04-01" },
      { id: "a2", loanxId: "LX994", paymentFrequency: "6 Months", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-07-01" },
    ] as unknown as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      assetPaymentScheduleSource: "holding",
      nextPaymentDate: "2026-04-01",
      accrualBeginDate: "2026-01-01",
      accrualEndDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /complete holding-level asset schedule evidence/.test(w.message)
    )).toBe(true);
  });

  it("keeps holding schedule timing active through ambiguous accruals without opening accrual fields", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Holding Anchor No Opening Basis",
      lxid: "LX993",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      nextPaymentDate: "2026-04-01",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX993", paymentFrequency: "3 Months", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-04-01" },
      { id: "a2", loanxId: "LX993", paymentFrequency: "6 Months", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-07-01" },
    ] as unknown as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      assetPaymentScheduleSource: "holding",
      nextPaymentDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /complete holding-level asset schedule evidence/.test(w.message)
    )).toBe(true);
  });

  it("warns on invalid holding nextPaymentDate while using a valid holding accrualEndDate anchor", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Invalid Next Anchor",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      nextPaymentDate: "2026-02-31",
      accrualEndDate: "2026-04-01",
    } as CloHolding;

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentIntervalMonths: 3,
      nextPaymentDate: "2026-04-01",
      accrualEndDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /invalid nextPaymentDate/.test(w.message)
    )).toBe(true);
  });

  it("ignores invalid holding accrualEndDate when a matched accrual row has a valid anchor", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Invalid Holding Accrual End",
      lxid: "LX992",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
      accrualEndDate: "not-a-date",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX992", paymentFrequency: "3 Months", accrualEndDate: "2026-04-01" },
    ] as unknown as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentIntervalMonths: 3,
      nextPaymentDate: "2026-04-01",
      accrualEndDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /invalid accrualEndDate/.test(w.message)
    )).toBe(true);
  });

  it("does not promote an invalid matched accrual row end date to nextPaymentDate", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Invalid Matched Accrual End",
      lxid: "LX991",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
      paymentPeriod: "3 Months",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX991", paymentFrequency: "3 Months", accrualEndDate: "not-a-date" },
    ] as unknown as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0].assetPaymentIntervalMonths).toBe(3);
    expect(resolved.loans[0].nextPaymentDate).toBeUndefined();
    expect(resolved.loans[0].accrualEndDate).toBeUndefined();
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /Matched accrual row/.test(w.message) &&
      /invalid accrualEndDate/.test(w.message)
    )).toBe(true);
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /no valid nextPaymentDate anchor/.test(w.message)
    )).toBe(true);
  });

  it("does not attach a unique accrual row when another holding identifier is ambiguous", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Partly Ambiguous Accrual",
      lxid: "LX996",
      cusip: "123456AB7",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX996", paymentFrequency: "3 Months", accrualEndDate: "2026-04-01" },
      { id: "a2", loanxId: "LX996", paymentFrequency: "6 Months", accrualEndDate: "2026-07-01" },
      { id: "a3", securityId: "123456AB7", paymentFrequency: "3 Months", accrualEndDate: "2026-04-01" },
    ] as unknown as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0].assetPaymentPeriodRaw).toBeUndefined();
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /duplicate or conflicting accrual rows/.test(w.message)
    )).toBe(true);
  });

  it("does not attach arbitrary accrual schedules when different identifiers match different rows", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Cross Identifier Ambiguous Accrual",
      lxid: "LX998",
      cusip: "123456AB7",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX998", paymentFrequency: "3 Months", accrualEndDate: "2026-04-01" },
      { id: "a2", securityId: "123456AB7", paymentFrequency: "6 Months", accrualEndDate: "2026-07-01" },
    ] as unknown as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0].assetPaymentPeriodRaw).toBeUndefined();
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      !w.blocking &&
      /duplicate or conflicting accrual rows/.test(w.message)
    )).toBe(true);
  });

  it("uses duplicate accrual rows when their schedule evidence is identical", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Identical Duplicate Accrual",
      lxid: "LX997",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX997", paymentFrequency: "3 Months", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-04-01" },
      { id: "a2", loanxId: "LX997", paymentFrequency: "3 Months", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-04-01" },
    ] as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "3 Months",
      assetPaymentIntervalMonths: 3,
      nextPaymentDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /duplicate or conflicting accrual rows/.test(w.message)
    )).toBe(false);
  });

  it("uses duplicate accrual rows when normalized frequency evidence is identical", () => {
    const constraints = {
      capitalStructure: [],
      feeSchedule: { fees: [] },
      ocTests: { tests: [] },
      icTests: { tests: [] },
      concentrations: { limits: [] },
      waterfall: { clauses: [] },
      ccc: { bucketLimitPct: null, valuationPct: null, valuationMode: null },
    } as unknown as ExtractedConstraints;
    const holding = {
      obligorName: "Normalized Duplicate Accrual",
      lxid: "LX994",
      parBalance: 1_000_000,
      maturityDate: "2028-01-01",
      moodysRating: "B2",
      spreadBps: 500,
      currency: "EUR",
    } as CloHolding;
    const accruals = [
      { id: "a1", loanxId: "LX994", paymentFrequency: "Quarterly", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-04-01" },
      { id: "a2", loanxId: "LX994", paymentFrequency: "3 Months", accrualBeginDate: "2026-01-01", accrualEndDate: "2026-04-01" },
    ] as CloAccrual[];

    const { resolved, warnings } = resolveWaterfallInputs(
      constraints,
      null,
      [],
      [],
      [holding],
      { maturity: "2029-01-01", reportDate: "2026-01-01", dealCurrency: "EUR" },
      [],
      [],
      undefined,
      accruals,
    );

    expect(resolved.loans[0]).toMatchObject({
      assetPaymentPeriodRaw: "Quarterly",
      assetPaymentIntervalMonths: 3,
      nextPaymentDate: "2026-04-01",
    });
    expect(warnings.some((w) =>
      w.field === "loans.assetPaymentSchedule" &&
      /duplicate or conflicting accrual rows/.test(w.message)
    )).toBe(false);
  });
});
