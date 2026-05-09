import { describe, expect, it } from "vitest";
import { runProjection } from "../projection";
import { makeInputs, noDefaults } from "./test-helpers";

const baseInputs = () =>
  makeInputs({
    ...noDefaults,
    cprPct: 0,
    incentiveFeePct: 0,
    incentiveFeeHurdleIrr: 0,
  });

describe("Expense Reserve step (D) discretionary deposit", () => {
  it("is a no-op when the user amount is zero", () => {
    const baseline = runProjection(baseInputs());
    const explicitZero = runProjection({
      ...baseInputs(),
      expenseReserveDepositAmount: 0,
      supplementalReserveDepositAmount: 0,
    });

    expect(explicitZero).toEqual(baseline);
  });

  it("deposits available interest into the Expense Reserve and increases future B/C headroom", () => {
    const baseline = runProjection(baseInputs());
    const withDeposit = runProjection({
      ...baseInputs(),
      seniorExpensesCapBps: 20,
      expenseReserveDepositAmount: 20_000,
    });
    const finiteBaseline = runProjection({
      ...baseInputs(),
      seniorExpensesCapBps: 20,
    });

    expect(withDeposit.periods[0].stepTrace.expenseReserveDeposit).toBeCloseTo(20_000, 6);
    expect(
      baseline.periods[0].stepTrace.equityFromInterest -
        withDeposit.periods[0].stepTrace.equityFromInterest,
    ).toBeCloseTo(20_000, 6);
    expect(
      withDeposit.periods[1].stepTrace.seniorExpensesCapAmount -
        finiteBaseline.periods[1].stepTrace.seniorExpensesCapAmount,
    ).toBeCloseTo(20_000, 6);
    expect(withDeposit.periods[1].interestCollected).toBeGreaterThan(
      baseline.periods[1].interestCollected,
    );
  });

  it("caps the deposit by finite Expense Reserve headroom", () => {
    const result = runProjection({
      ...baseInputs(),
      seniorExpensesCapBps: 4,
      expenseReserveDepositAmount: 1_000_000,
    });
    const p0 = result.periods[0];

    expect(p0.stepTrace.expenseReserveDeposit).toBeCloseTo(
      p0.stepTrace.seniorExpensesCapAmount,
      6,
    );
    expect(p0.stepTrace.expenseReserveDeposit).toBeLessThan(1_000_000);
  });

  it("caps the deposit by available interest after steps A-C", () => {
    const result = runProjection({
      ...baseInputs(),
      expenseReserveDepositAmount: 100_000_000,
    });
    const p0 = result.periods[0];

    expect(p0.stepTrace.expenseReserveDeposit).toBeCloseTo(
      p0.interestCollected -
        p0.stepTrace.taxes -
        p0.stepTrace.issuerProfit -
        p0.stepTrace.trusteeFeesPaid -
        p0.stepTrace.adminFeesPaid,
      6,
    );
    expect(p0.stepTrace.availableForTranches).toBeCloseTo(0, 6);
  });

  it("can deposit remaining interest proceeds after reserve-funded B/C overflow", () => {
    const result = runProjection({
      ...baseInputs(),
      initialExpenseReserveBalance: 3_000_000,
      seniorExpensesCapBps: 100,
      trusteeFeeBps: 10_000,
      adminFeeBps: 0,
      taxesBps: 0,
      issuerProfitAmount: 0,
      seniorFeePct: 0,
      hedgeCostBps: 0,
      expenseReserveDepositAmount: 1_000_000,
    });
    const p0 = result.periods[0];

    expect(p0.stepTrace.expenseReserveDraw).toBeGreaterThan(0);
    expect(p0.stepTrace.trusteeFeesPaid).toBeGreaterThan(p0.interestCollected);
    expect(p0.stepTrace.expenseReserveDeposit).toBeGreaterThan(0);
    expect(p0.stepTrace.expenseReserveDeposit).toBeLessThan(1_000_000);
    expect(p0.stepTrace.expenseReserveDeposit).toBeCloseTo(
      p0.stepTrace.seniorExpensesCapAmount - 3_000_000,
      6,
    );
  });

  it("does not deposit outside the Reinvestment Period", () => {
    const result = runProjection({
      ...baseInputs(),
      reinvestmentPeriodEnd: "2026-03-01",
      expenseReserveDepositAmount: 50_000,
    });

    expect(result.periods[0].stepTrace.expenseReserveDeposit).toBe(0);
  });
});

describe("Supplemental Reserve step (BB) discretionary deposit", () => {
  it("deposits late-waterfall interest and releases under the interest disposition", () => {
    const baseline = runProjection({
      ...baseInputs(),
      supplementalReserveDisposition: "interest",
    });
    const withDeposit = runProjection({
      ...baseInputs(),
      supplementalReserveDisposition: "interest",
      supplementalReserveDepositAmount: 25_000,
    });

    expect(withDeposit.periods[0].stepTrace.supplementalReserveDeposit).toBeCloseTo(25_000, 6);
    expect(
      baseline.periods[0].stepTrace.equityFromInterest -
        withDeposit.periods[0].stepTrace.equityFromInterest,
    ).toBeCloseTo(25_000, 6);
    expect(
      withDeposit.periods[1].interestCollected -
        baseline.periods[1].interestCollected,
    ).toBeGreaterThan(25_000);
  });

  it("caps the deposit by available late-waterfall interest", () => {
    const baseline = runProjection(baseInputs());
    const withLargeDeposit = runProjection({
      ...baseInputs(),
      supplementalReserveDepositAmount: 100_000_000,
    });

    expect(withLargeDeposit.periods[0].stepTrace.supplementalReserveDeposit).toBeCloseTo(
      baseline.periods[0].stepTrace.equityFromInterest,
      6,
    );
    expect(withLargeDeposit.periods[0].stepTrace.equityFromInterest).toBeCloseTo(0, 6);
  });

  it("does not deposit outside the Reinvestment Period", () => {
    const result = runProjection({
      ...baseInputs(),
      reinvestmentPeriodEnd: "2026-03-01",
      supplementalReserveDepositAmount: 50_000,
    });

    expect(result.periods[0].stepTrace.supplementalReserveDeposit).toBe(0);
  });

  it("releases deposits to principal/reinvestment in the next period under principalCash disposition", () => {
    const baseline = runProjection({
      ...baseInputs(),
      supplementalReserveDisposition: "principalCash",
    });
    const withDeposit = runProjection({
      ...baseInputs(),
      supplementalReserveDisposition: "principalCash",
      supplementalReserveDepositAmount: 25_000,
    });

    expect(withDeposit.periods[0].stepTrace.supplementalReserveDeposit).toBeCloseTo(25_000, 6);
    expect(withDeposit.periods[1].reinvestment - baseline.periods[1].reinvestment).toBeCloseTo(
      25_000,
      6,
    );
    expect(withDeposit.periods[1].interestCollected).toBeGreaterThan(
      baseline.periods[1].interestCollected,
    );
  });

  it("does not create deposits in a call period", () => {
    const windupInputs = {
      ...baseInputs(),
      initialPar: 1_000_000,
    dealCurrency: "EUR",
      loans: [
        {
          parBalance: 1_000_000,
          maturityDate: "2026-06-09",
          ratingBucket: "B",
          spreadBps: 375,
    currency: "EUR",
        },
      ],
      tranches: [
        { className: "A", currentBalance: 100_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, paymentFrequency: "quarterly" as const, isDeferrable: false },
        { className: "Sub", currentBalance: 0, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
      callMode: "optionalRedemption" as const,
      callDate: "2026-06-09",
      supplementalReserveDisposition: "principalCash" as const,
    };
    const baseline = runProjection(windupInputs);
    const withDeposit = runProjection({
      ...windupInputs,
      expenseReserveDepositAmount: 5_000,
      supplementalReserveDepositAmount: 5_000,
    });

    expect(withDeposit.periods).toHaveLength(1);
    expect(withDeposit.periods[0].stepTrace.expenseReserveDeposit).toBe(0);
    expect(withDeposit.periods[0].stepTrace.supplementalReserveDeposit).toBe(0);
    expect(withDeposit.periods[0].equityDistribution).toBeCloseTo(
      baseline.periods[0].equityDistribution,
      6,
    );
  });

  it("does not create deposits in a legal maturity period", () => {
    const maturityInputs = {
      ...baseInputs(),
      maturityDate: "2026-06-09",
      expenseReserveDepositAmount: 5_000,
      supplementalReserveDepositAmount: 5_000,
    };
    const result = runProjection(maturityInputs);

    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].stepTrace.expenseReserveDeposit).toBe(0);
    expect(result.periods[0].stepTrace.supplementalReserveDeposit).toBe(0);
  });

  it("holds new deposits until terminal release under hold disposition", () => {
    const baseline = runProjection({
      ...baseInputs(),
      maturityDate: "2026-12-09",
      supplementalReserveDisposition: "hold",
    });
    const withDeposit = runProjection({
      ...baseInputs(),
      maturityDate: "2026-12-09",
      supplementalReserveDisposition: "hold",
      supplementalReserveDepositAmount: 25_000,
    });
    const lastIndex = withDeposit.periods.length - 1;
    const totalHeldDeposits = withDeposit.periods.reduce(
      (sum, period) => sum + period.stepTrace.supplementalReserveDeposit,
      0,
    );

    expect(withDeposit.periods[0].stepTrace.supplementalReserveDeposit).toBeCloseTo(25_000, 6);
    expect(withDeposit.periods[1].interestCollected).toBeGreaterThan(
      baseline.periods[1].interestCollected,
    );
    expect(withDeposit.periods[lastIndex].stepTrace.supplementalReserveDeposit).toBe(0);
    expect(
      withDeposit.periods[lastIndex].stepTrace.equityFromPrincipal -
        baseline.periods[lastIndex].stepTrace.equityFromPrincipal,
    ).toBeCloseTo(totalHeldDeposits, 6);
  });
});
