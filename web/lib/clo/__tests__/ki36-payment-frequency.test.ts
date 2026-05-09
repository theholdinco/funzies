import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFromResolved, DEFAULT_ASSUMPTIONS, IncompleteDataError } from "../build-projection-inputs";
import { dayCountFraction, runProjection } from "../projection";
import { normalizePaymentFrequency } from "../payment-frequency";
import { makeInputs, noDefaults, uniformRates } from "./test-helpers";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");

function euroFixture(): any {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

describe("KI-36 tranche payment frequency", () => {
  it("normalizes common raw payment frequency values", () => {
    expect(normalizePaymentFrequency("1 Month")).toBe("monthly");
    expect(normalizePaymentFrequency("Monthly")).toBe("monthly");
    expect(normalizePaymentFrequency("3 Months")).toBe("quarterly");
    expect(normalizePaymentFrequency("Quarterly")).toBe("quarterly");
    expect(normalizePaymentFrequency("Quarterly in arrear")).toBe("quarterly");
    expect(normalizePaymentFrequency("Quarterly in arrears")).toBe("quarterly");
    expect(normalizePaymentFrequency("payable quarterly")).toBe("quarterly");
    expect(normalizePaymentFrequency("3-month")).toBe("quarterly");
    expect(normalizePaymentFrequency("6 Months")).toBe("semi_annual");
    expect(normalizePaymentFrequency("Semi-Annual")).toBe("semi_annual");
    expect(normalizePaymentFrequency("Semi-annually in arrear")).toBe("semi_annual");
    expect(normalizePaymentFrequency("Semi-annually in arrears")).toBe("semi_annual");
    expect(normalizePaymentFrequency("semi-annual in arrears")).toBe("semi_annual");
    expect(normalizePaymentFrequency("6-month")).toBe("semi_annual");
    expect(normalizePaymentFrequency("every three months")).toBe("quarterly");
    expect(normalizePaymentFrequency("every 3 months")).toBe("quarterly");
    expect(normalizePaymentFrequency("each quarter")).toBe("quarterly");
    expect(normalizePaymentFrequency("3M")).toBe("quarterly");
    expect(normalizePaymentFrequency("N/A")).toBeNull();
    expect(normalizePaymentFrequency("None")).toBeNull();
    expect(normalizePaymentFrequency("weekly")).toBeNull();
    expect(normalizePaymentFrequency("not monthly")).toBeNull();
    expect(normalizePaymentFrequency("Quarterly prior to the Frequency Switch Event and semi-annually thereafter")).toBe("quarterly");
    expect(normalizePaymentFrequency("Prior to the Frequency Switch Event, quarterly; thereafter semi-annually")).toBe("quarterly");
    expect(normalizePaymentFrequency("Quarterly until the Frequency Switch Event and semi-annually thereafter")).toBe("quarterly");
    expect(normalizePaymentFrequency("Quarterly prior to conversion to semi-annual payments")).toBe("quarterly");
    expect(normalizePaymentFrequency("No Frequency Switch Event has occurred. Deal continues on quarterly payments.")).toBe("quarterly");
    expect(normalizePaymentFrequency("Semi-annually prior to the Frequency Switch Event and quarterly thereafter")).toBe("semi_annual");
    expect(normalizePaymentFrequency("Quarterly prior to the Frequency Switch Event and monthly thereafter")).toBeNull();
    expect(normalizePaymentFrequency("prior to the Frequency Switch Event and quarterly thereafter")).toBeNull();
  });

  it("blocks monthly tranche frequency while deal waterfall dates are quarterly", () => {
    expect(() =>
      runProjection(
        makeInputs({
          tranches: [
            {
              className: "A",
              currentBalance: 65_000_000,
              spreadBps: 140,
              seniorityRank: 1,
              isFloating: true,
              isIncomeNote: false,
              isDeferrable: false,
              paymentFrequency: "monthly",
            },
            { className: "Sub", currentBalance: 35_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
          ],
        }),
      ),
    ).toThrow(/monthly paymentFrequency/);
  });

  it("blocks unsupported hand-constructed tranche frequency values", () => {
    expect(() =>
      runProjection(
        makeInputs({
          tranches: [
            {
              className: "A",
              currentBalance: 65_000_000,
              spreadBps: 140,
              seniorityRank: 1,
              isFloating: true,
              isIncomeNote: false,
              isDeferrable: false,
              paymentFrequency: "weekly" as any,
            },
            { className: "Sub", currentBalance: 35_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
          ],
        }),
      ),
    ).toThrow(/unsupported paymentFrequency/);
  });

  it("blocks missing hand-constructed interest-bearing tranche frequency values", () => {
    const inputs = makeInputs();
    delete inputs.tranches[0].paymentFrequency;

    expect(() => runProjection(inputs)).toThrow(/missing payment frequency/);
  });

  it("buildFromResolved blocks monthly tranche frequency with IncompleteDataError", () => {
    const fixture = euroFixture();
    const resolved = structuredClone(fixture.resolved);
    resolved.tranches[0].paymentFrequency = "monthly";

    expect(() => buildFromResolved(resolved, DEFAULT_ASSUMPTIONS)).toThrow(IncompleteDataError);
  });

  it("buildFromResolved blocks semi-annual tranche frequency without a phase anchor", () => {
    const fixture = euroFixture();
    const resolved = structuredClone(fixture.resolved);
    resolved.dates.firstPaymentDate = null;
    resolved.tranches[0].paymentFrequency = "semi_annual";

    expect(() => buildFromResolved(resolved, DEFAULT_ASSUMPTIONS)).toThrow(IncompleteDataError);
  });

  it("buildFromResolved blocks unsupported persisted tranche frequency values", () => {
    const fixture = euroFixture();
    const resolved = structuredClone(fixture.resolved);
    resolved.tranches[0].paymentFrequency = "weekly";

    expect(() => buildFromResolved(resolved, DEFAULT_ASSUMPTIONS)).toThrow(IncompleteDataError);
  });

  it("buildFromResolved blocks missing interest-bearing tranche frequency even without resolver sentinel", () => {
    const fixture = euroFixture();
    const resolved = structuredClone(fixture.resolved);
    delete resolved.tranches[0].paymentFrequency;

    expect(() => buildFromResolved(resolved, DEFAULT_ASSUMPTIONS)).toThrow(IncompleteDataError);
  });

  it("buildFromResolved treats floating zero-spread debt as interest-bearing for missing frequency", () => {
    const fixture = euroFixture();
    const resolved = structuredClone(fixture.resolved);
    resolved.tranches[0].isFloating = true;
    resolved.tranches[0].spreadBps = 0;
    delete resolved.tranches[0].paymentFrequency;

    expect(() => buildFromResolved(resolved, DEFAULT_ASSUMPTIONS)).toThrow(IncompleteDataError);
  });

  it("buildFromResolved keeps all-quarterly deals on the compatibility grid", () => {
    const fixture = euroFixture();
    const inputs = buildFromResolved(fixture.resolved, DEFAULT_ASSUMPTIONS);

    expect(inputs.currentDate).toBe("2026-04-01");
    expect(inputs.firstPaymentDate).toBe("2022-07-15");
    expect(inputs.stubPeriod).toBeUndefined();
    expect(inputs.firstPeriodEndDate).toBeUndefined();
    expect(runProjection(inputs).periods[0].date).toBe("2026-07-01");
  });

  it("buildFromResolved emits actual deal payment rows when semi-annual tranches require a phase", () => {
    const fixture = euroFixture();
    const resolved = structuredClone(fixture.resolved);
    resolved.tranches[0].paymentFrequency = "semi_annual";
    const inputs = buildFromResolved(resolved, DEFAULT_ASSUMPTIONS);

    expect(inputs.stubPeriod).toBe(true);
    expect(inputs.firstPeriodEndDate).toBe("2026-04-15");
    expect(runProjection(inputs).periods[0].date).toBe("2026-04-15");
  });

  it("semi-annual tranche accrues through skipped quarterly date and pays on the next payment date", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        firstPaymentDate: "2026-03-09",
        cprPct: 0,
        wacSpreadBps: 800,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 800 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    const q1A = result.periods[0].trancheInterest.find((r) => r.className === "A");
    const q2A = result.periods[1].trancheInterest.find((r) => r.className === "A");
    expect(q1A?.due).toBe(0);
    expect(q1A?.paid).toBe(0);
    expect(q2A?.due ?? 0).toBeGreaterThan(900_000);
    expect(q2A?.paid).toBeCloseTo(q2A?.due ?? 0, 2);
  });

  it("semi-annual tranche pays accrued interest on an off-cycle final maturity payment date", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        firstPaymentDate: "2026-03-09",
        maturityDate: "2026-06-09",
        cprPct: 0,
        wacSpreadBps: 800,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 800 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    expect(result.periods).toHaveLength(1);
    const a = result.periods[0].trancheInterest.find((r) => r.className === "A");
    expect(a?.due ?? 0).toBeGreaterThan(0);
    expect(a?.paid).toBeCloseTo(a?.due ?? 0, 2);
  });

  it("mixed quarterly and semi-annual tranche schedules pay independently", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        firstPaymentDate: "2026-03-09",
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        seniorFeePct: 0,
        subFeePct: 0,
        trusteeFeeBps: 0,
        taxesBps: 0,
        loans: [{ parBalance: 150_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 800 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 300,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "quarterly",
          },
          {
            className: "B",
            currentBalance: 40_000_000,
            spreadBps: 600,
            seniorityRank: 2,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 60_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    const q1A = result.periods[0].trancheInterest.find((r) => r.className === "A");
    const q2A = result.periods[1].trancheInterest.find((r) => r.className === "A");
    const q1B = result.periods[0].trancheInterest.find((r) => r.className === "B");
    const q2B = result.periods[1].trancheInterest.find((r) => r.className === "B");
    expect(q1A?.due ?? 0).toBeCloseTo(50_000_000 * 0.03 * dayCountFraction("actual_360", "2026-03-09", "2026-06-09"), 0);
    expect(q2A?.due ?? 0).toBeCloseTo(50_000_000 * 0.03 * dayCountFraction("actual_360", "2026-06-09", "2026-09-09"), 0);
    expect(q1B?.due).toBe(0);
    expect(q1B?.paid).toBe(0);
    expect(q2B?.due ?? 0).toBeCloseTo(40_000_000 * 0.06 * dayCountFraction("actual_360", "2026-03-09", "2026-09-09"), 0);
    expect(q2B?.paid).toBeCloseTo(q2B?.due ?? 0, 2);
  });

  it("mixed quarterly and semi-annual IC denominator includes only scheduled due interest", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        firstPaymentDate: "2026-03-09",
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        seniorFeePct: 0,
        subFeePct: 0,
        trusteeFeeBps: 0,
        taxesBps: 0,
        loans: [{ parBalance: 150_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 800 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 300,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "quarterly",
          },
          {
            className: "B",
            currentBalance: 40_000_000,
            spreadBps: 600,
            seniorityRank: 2,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 60_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [{ className: "B", triggerLevel: 120, rank: 2 }],
      }),
    );

    const q1A = result.periods[0].trancheInterest.find((r) => r.className === "A");
    const q1B = result.periods[0].trancheInterest.find((r) => r.className === "B");
    const q2A = result.periods[1].trancheInterest.find((r) => r.className === "A");
    const q2B = result.periods[1].trancheInterest.find((r) => r.className === "B");
    const q1Denominator = q1A?.due ?? 0;
    const q2Denominator = (q2A?.due ?? 0) + (q2B?.due ?? 0);
    expect(q1B?.due).toBe(0);
    expect(result.periods[0].icTests[0].actual).toBeCloseTo(
      (result.periods[0].interestCollected / q1Denominator) * 100,
      6,
    );
    expect(result.periods[1].icTests[0].actual).toBeCloseTo(
      (result.periods[1].interestCollected / q2Denominator) * 100,
      6,
    );
  });

  it("skipped semi-annual date does not create shortfall or EoD", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        firstPaymentDate: "2026-03-09",
        cprPct: 0,
        interestNonPaymentGracePeriods: 2,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 0 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    expect(result.periods[0].interestShortfall.A).toBeUndefined();
    expect(result.periods[0].interestShortfallCount.A).toBeUndefined();
    expect(result.periods[1].interestShortfall.A).toBeGreaterThan(0);
    expect(result.periods[1].interestShortfallCount.A).toBe(1);
    expect(result.periods[2].interestShortfallCount.A).toBe(1);
  });

  it("semi-annual deferrable tranche does not PIK on skipped dates and accrues on scheduled miss when compounding", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        firstPaymentDate: "2026-03-09",
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 0 }],
        tranches: [
          {
            className: "A",
            currentBalance: 20_000_000,
            spreadBps: 0,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "quarterly",
          },
          {
            className: "B",
            currentBalance: 20_000_000,
            spreadBps: 0,
            seniorityRank: 2,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "quarterly",
          },
          {
            className: "C",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 3,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: true,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [],
        deferredInterestCompounds: true,
      }),
    );

    const q1C = result.periods[0].trancheInterest.find((r) => r.className === "C");
    const q2C = result.periods[1].trancheInterest.find((r) => r.className === "C");
    const q1Principal = result.periods[0].tranchePrincipal.find((r) => r.className === "C");
    const q2Principal = result.periods[1].tranchePrincipal.find((r) => r.className === "C");
    const expectedDue = 50_000_000 * 0.04 * dayCountFraction("actual_360", "2026-03-09", "2026-09-09");
    expect(q1C?.due).toBe(0);
    expect(result.periods[0].stepTrace.deferredAccrualByTranche.C).toBe(0);
    expect(q1Principal?.endBalance).toBeCloseTo(50_000_000, 0);
    expect(q2C?.due ?? 0).toBeCloseTo(expectedDue, 0);
    expect(q2C?.paid).toBe(0);
    expect(result.periods[1].stepTrace.deferredAccrualByTranche.C).toBeCloseTo(expectedDue, 0);
    expect(q2Principal?.endBalance).toBeCloseTo(50_000_000 + expectedDue, 0);
  });

  it("semi-annual deferrable tranche tracks scheduled missed interest separately when non-compounding", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        firstPaymentDate: "2026-03-09",
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 0 }],
        tranches: [
          {
            className: "A",
            currentBalance: 20_000_000,
            spreadBps: 0,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "quarterly",
          },
          {
            className: "B",
            currentBalance: 20_000_000,
            spreadBps: 0,
            seniorityRank: 2,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "quarterly",
          },
          {
            className: "C",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 3,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: true,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [],
        deferredInterestCompounds: false,
      }),
    );

    const expectedDue = 50_000_000 * 0.04 * dayCountFraction("actual_360", "2026-03-09", "2026-09-09");
    const q1Principal = result.periods[0].tranchePrincipal.find((r) => r.className === "C");
    const q2Principal = result.periods[1].tranchePrincipal.find((r) => r.className === "C");
    expect(result.periods[0].stepTrace.deferredAccrualByTranche.C).toBe(0);
    expect(q1Principal?.endBalance).toBeCloseTo(50_000_000, 0);
    expect(result.periods[1].stepTrace.deferredAccrualByTranche.C).toBeCloseTo(expectedDue, 0);
    expect(q2Principal?.endBalance).toBeCloseTo(50_000_000 + expectedDue, 0);
  });

  it("monthly CDR compounds to the intended quarterly default amount", () => {
    const annualCdr = 12;
    const monthlyHazard = 1 - Math.pow(1 - annualCdr / 100, 1 / 12);
    const expectedQuarterDefaults = 100_000_000 * (1 - Math.pow(1 - monthlyHazard, 3));

    const result = runProjection(
      makeInputs({
        loans: [],
        initialPar: 100_000_000,
        defaultRatesByRating: uniformRates(annualCdr),
        cprPct: 0,
        reinvestmentPeriodEnd: null,
      }),
    );

    expect(result.periods[0].defaults).toBeCloseTo(expectedQuarterDefaults, 0);
  });

  it("per-loan monthly CDR compounds to the intended quarterly default amount", () => {
    const annualCdr = 12;
    const quarterlyHazard = 1 - Math.pow(1 - annualCdr / 100, 0.25);
    const monthlyHazard = 1 - Math.pow(1 - quarterlyHazard, 1 / 3);
    const expectedQuarterDefaults = 100_000_000 * (1 - Math.pow(1 - monthlyHazard, 3));

    const result = runProjection(
      makeInputs({
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 0 }],
        initialPar: 100_000_000,
        defaultRatesByRating: uniformRates(annualCdr),
        overriddenBuckets: ["B"],
        cprPct: 0,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
      (survivingPar, hazardRate) => survivingPar * hazardRate,
    );

    expect(result.periods[0].defaults).toBeCloseTo(expectedQuarterDefaults, 0);
  });

  it("monthly CPR compounds to the intended quarterly prepayment amount", () => {
    const annualCpr = 12;
    const quarterlyPrepayRate = 1 - Math.pow(1 - annualCpr / 100, 0.25);
    const expectedQuarterPrepay = 100_000_000 * quarterlyPrepayRate;

    const result = runProjection(
      makeInputs({
        ...noDefaults,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 0 }],
        initialPar: 100_000_000,
        cprPct: annualCpr,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    expect(result.periods[0].prepayments).toBeCloseTo(expectedQuarterPrepay, 0);
    expect(result.periods[0].endingPar).toBeCloseTo(100_000_000 - expectedQuarterPrepay, 0);
  });

  it("per-loan monthly CDR and CPR compound together on surviving par", () => {
    const annualCdr = 12;
    const annualCpr = 8;
    const monthlyDefault = 1 - Math.pow(1 - annualCdr / 100, 1 / 12);
    const quarterlyPrepay = 1 - Math.pow(1 - annualCpr / 100, 0.25);
    const monthlyPrepay = 1 - Math.pow(1 - quarterlyPrepay, 1 / 3);
    let expectedEndingPar = 100_000_000;
    let expectedDefaults = 0;
    let expectedPrepayments = 0;
    for (let i = 0; i < 3; i += 1) {
      const tickDefaults = expectedEndingPar * monthlyDefault;
      expectedEndingPar -= tickDefaults;
      const tickPrepayments = expectedEndingPar * monthlyPrepay;
      expectedEndingPar -= tickPrepayments;
      expectedDefaults += tickDefaults;
      expectedPrepayments += tickPrepayments;
    }

    const result = runProjection(
      makeInputs({
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 0 }],
        initialPar: 100_000_000,
        defaultRatesByRating: uniformRates(annualCdr),
        overriddenBuckets: ["B"],
        cprPct: annualCpr,
        recoveryPct: 0,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
      (survivingPar, hazardRate) => survivingPar * hazardRate,
    );

    expect(result.periods[0].defaults).toBeCloseTo(expectedDefaults, 0);
    expect(result.periods[0].prepayments).toBeCloseTo(expectedPrepayments, 0);
    expect(result.periods[0].endingPar).toBeCloseTo(expectedEndingPar, 0);
  });

  it("monthly recovery lag routes cash to the correct payment-date row", () => {
    const result = runProjection(
      makeInputs({
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 0 }],
        initialPar: 100_000_000,
        defaultRatesByRating: uniformRates(1),
        cdrMultiplierPathFn: () => ({ B: 100 }),
        overriddenBuckets: ["B"],
        cprPct: 0,
        recoveryPct: 50,
        recoveryLagMonths: 3,
        reinvestmentPeriodEnd: null,
      }),
      (survivingPar, hazardRate) => survivingPar * hazardRate,
    );

    expect(result.periods[0].defaults).toBeGreaterThan(0);
    expect(result.periods[0].recoveries).toBe(0);
    expect(result.periods[1].recoveries).toBeGreaterThan(0);
  });

  it("stub-period recovery event scheduledRecoveryQuarter matches the cash recovery row", () => {
    const result = runProjection(
      makeInputs({
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 0 }],
        initialPar: 100_000_000,
        defaultRatesByRating: uniformRates(12),
        overriddenBuckets: ["B"],
        cprPct: 0,
        recoveryPct: 50,
        recoveryLagMonths: 3,
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-09",
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
      (survivingPar, hazardRate) => survivingPar * hazardRate,
    );

    const eventRecovery = result.periods[0].loanDefaultEvents.reduce((s, e) => {
      expect(e.scheduledRecoveryQuarter).toBe(2);
      return s + e.recoveryAmount;
    }, 0);
    expect(eventRecovery).toBeGreaterThan(0);
    expect(result.periods[0].recoveries).toBe(0);
    expect(result.periods[1].recoveries).toBeCloseTo(eventRecovery, 0);
  });

  it("one-day stub recovery event still lands on the later payment-date row", () => {
    let hasDrawnDefault = false;
    const result = runProjection(
      makeInputs({
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 0 }],
        initialPar: 100_000_000,
        currentDate: "2026-04-14",
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-15",
        defaultRatesByRating: uniformRates(12),
        overriddenBuckets: ["B"],
        cprPct: 0,
        recoveryPct: 50,
        recoveryLagMonths: 3,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
      () => {
        if (hasDrawnDefault) return 0;
        hasDrawnDefault = true;
        return 1_000_000;
      },
    );

    expect(result.periods[0].date).toBe("2026-04-15");
    expect(result.periods[0].defaults).toBeCloseTo(1_000_000, 0);
    expect(result.periods[0].loanDefaultEvents[0].scheduledRecoveryQuarter).toBe(2);
    expect(result.periods[0].recoveries).toBe(0);
    expect(result.periods[1].recoveries).toBeCloseTo(500_000, 0);
  });

  it("T=0 IC uses the first payment-window accrual fraction on a short stub", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        currentDate: "2026-04-14",
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-15",
        cprPct: 0,
        wacSpreadBps: 800,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        seniorFeePct: 0,
        subFeePct: 0,
        trusteeFeeBps: 0,
        taxesBps: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 800 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "quarterly",
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [{ className: "A", triggerLevel: 120, rank: 1 }],
      }),
    );

    const stubFrac = dayCountFraction("actual_360", "2026-04-14", "2026-04-15");
    const expectedInterest = 100_000_000 * 0.08 * stubFrac;
    const expectedDue = 50_000_000 * 0.04 * stubFrac;
    expect(result.initialState.icTests[0].actual).toBeCloseTo((expectedInterest / expectedDue) * 100, 6);
  });

  it("end-of-month monthly grid accrues exactly one quarter without date drift", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        currentDate: "2026-01-31",
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-30",
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-04-30", ratingBucket: "B", spreadBps: 360 }],
        initialPar: 100_000_000,
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    expect(result.periods[0].date).toBe("2026-04-30");
    expect(result.periods[0].interestCollected).toBeCloseTo(
      100_000_000 * 0.036 * dayCountFraction("actual_360", "2026-01-31", "2026-04-30"),
      0,
    );
  });

  it("end-of-month monthly grid compounds three default ticks without date drift", () => {
    const annualCdr = 12;
    const expectedDefaults = 100_000_000 * (1 - Math.pow(1 - annualCdr / 100, 0.25));
    const result = runProjection(
      makeInputs({
        currentDate: "2026-01-31",
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-04-30", ratingBucket: "B", spreadBps: 0 }],
        initialPar: 100_000_000,
        defaultRatesByRating: uniformRates(annualCdr),
        overriddenBuckets: ["B"],
        cprPct: 0,
        recoveryPct: 0,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
      (survivingPar, hazardRate) => survivingPar * hazardRate,
    );

    expect(result.periods[0].date).toBe("2026-04-30");
    expect(result.periods[0].defaults).toBeCloseTo(expectedDefaults, 0);
    expect(result.periods[0].endingPar).toBeCloseTo(100_000_000 - expectedDefaults, 0);
    expect(result.periods[1].date).toBe("2026-07-31");
    expect(result.periods[1].defaults).toBeCloseTo((100_000_000 - expectedDefaults) * (1 - Math.pow(1 - annualCdr / 100, 0.25)), 0);
  });

  it("end-of-month payment rows stay anchored after the first clamped quarter", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        currentDate: "2026-01-31",
        firstPaymentDate: "2026-01-31",
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-04-30", ratingBucket: "B", spreadBps: 0 }],
        initialPar: 100_000_000,
        cprPct: 0,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    expect(result.periods.slice(0, 4).map((p) => p.date)).toEqual([
      "2026-04-30",
      "2026-07-31",
      "2026-10-31",
      "2027-01-31",
    ]);
  });

  it("stub end-of-month rows stay on the deal phase for semi-annual tranche payments", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        currentDate: "2026-01-31",
        firstPaymentDate: "2026-01-31",
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-30",
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-04-30", ratingBucket: "B", spreadBps: 800 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    expect(result.periods.slice(0, 4).map((p) => p.date)).toEqual([
      "2026-04-30",
      "2026-07-31",
      "2026-10-31",
      "2027-01-31",
    ]);
    const q2A = result.periods[1].trancheInterest.find((r) => r.className === "A");
    expect(q2A?.due ?? 0).toBeCloseTo(
      50_000_000 * 0.04 * dayCountFraction("actual_360", "2026-01-31", "2026-07-31"),
      0,
    );
  });

  it("quality WAL uses actual dates instead of quarter counters on EOM schedules", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        currentDate: "2026-01-31",
        loans: [{ parBalance: 100_000_000, maturityDate: "2027-01-31", ratingBucket: "B", spreadBps: 0 }],
        initialPar: 100_000_000,
        cprPct: 0,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    const expectedWal =
      (Date.parse("2027-01-31") - Date.parse("2026-04-30")) / (1000 * 60 * 60 * 24 * 365);
    expect(result.periods[0].qualityMetrics.walYears).toBeCloseTo(expectedWal, 6);
  });

  it("pre-existing default recovery lag uses months without an extra quarter delay", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        cprPct: 0,
        recoveryPct: 60,
        recoveryLagMonths: 3,
        preExistingDefaultedPar: 1_000_000,
        unpricedDefaultedPar: 1_000_000,
      }),
    );

    expect(result.periods[0].recoveries).toBeCloseTo(600_000, -2);
  });

  it("T=0 OC includes pending pre-existing recovery value even with a one-month lag", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        loans: [],
        initialPar: 100_000_000,
        cprPct: 0,
        recoveryPct: 60,
        recoveryLagMonths: 1,
        preExistingDefaultedPar: 1_000_000,
        unpricedDefaultedPar: 1_000_000,
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 0,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [{ className: "A", triggerLevel: 120, rank: 1 }],
        icTriggers: [],
      }),
    );

    expect(result.initialState.ocTests[0].actual).toBeCloseTo(
      ((100_000_000 + 600_000) / 50_000_000) * 100,
      6,
    );
  });

  it("intra-month loan maturity stops accrual at the actual maturity date", () => {
    const annualCdr = 12;
    const annualCpr = 8;
    const activeFrac = dayCountFraction("actual_360", "2026-03-09", "2026-04-01");
    const monthlyDefault = 1 - Math.pow(1 - (1 - Math.pow(1 - annualCdr / 100, 0.25)), 1 / 3);
    const quarterlyPrepay = 1 - Math.pow(1 - annualCpr / 100, 0.25);
    const monthlyPrepay = 1 - Math.pow(1 - quarterlyPrepay, 1 / 3);
    const activeDefaultRate = 1 - Math.pow(1 - monthlyDefault, activeFrac / (1 / 12));
    const activePrepayRate = 1 - Math.pow(1 - monthlyPrepay, activeFrac / (1 / 12));
    const expectedDefaults = 1_000_000 * activeDefaultRate;
    const expectedPrepayments = (1_000_000 - expectedDefaults) * activePrepayRate;
    const expectedMaturity = 1_000_000 - expectedDefaults - expectedPrepayments;
    const result = runProjection(
      makeInputs({
        loans: [{ parBalance: 1_000_000, maturityDate: "2026-04-01", ratingBucket: "B", spreadBps: 360 }],
        initialPar: 1_000_000,
        defaultRatesByRating: uniformRates(annualCdr),
        overriddenBuckets: ["B"],
        cprPct: annualCpr,
        recoveryPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        reinvestmentPeriodEnd: null,
        postRpReinvestmentPct: 0,
        ocTriggers: [],
        icTriggers: [],
      }),
      (survivingPar, hazardRate) => survivingPar * hazardRate,
    );

    expect(result.periods[0].defaults).toBeCloseTo(expectedDefaults, 0);
    expect(result.periods[0].prepayments).toBeCloseTo(expectedPrepayments, 0);
    expect(result.periods[0].scheduledMaturities).toBeCloseTo(expectedMaturity, 0);
    expect(result.periods[0].endingPar).toBeCloseTo(0, 0);
    expect(result.periods[0].interestCollected).toBeCloseTo(
      1_000_000 * 0.036 * dayCountFraction("actual_360", "2026-03-09", "2026-04-01"),
      0,
    );
  });

  it("semi-annual tranche frequency controls IC denominator on skipped and payment dates", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        firstPaymentDate: "2026-03-09",
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        seniorFeePct: 0,
        subFeePct: 0,
        trusteeFeeBps: 0,
        taxesBps: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 800 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [{ className: "A", triggerLevel: 120, rank: 1 }],
      }),
    );

    const q2A = result.periods[1].trancheInterest.find((r) => r.className === "A");
    const expectedDue = 50_000_000 * 0.04 * dayCountFraction("actual_360", "2026-03-09", "2026-09-09");
    expect(result.periods[0].icTests[0].actual).toBe(999);
    expect(q2A?.due ?? 0).toBeCloseTo(expectedDue, 0);
    expect(result.periods[1].icTests[0].actual).toBeLessThan(999);
    expect(result.periods[1].icTests[0].actual).toBeCloseTo(
      (result.periods[1].interestCollected / expectedDue) * 100,
      6,
    );
  });

  it("IC cure uses scheduled interest due captured before current-interest settlement", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        currentDate: "2026-03-09",
        firstPaymentDate: "2026-03-09",
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        seniorFeePct: 0,
        subFeePct: 0,
        trusteeFeeBps: 0,
        taxesBps: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 400 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "quarterly",
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [{ className: "A", triggerLevel: 300, rank: 1 }],
      }),
    );

    const p1 = result.periods[0];
    const aPrincipal = p1.tranchePrincipal.find((r) => r.className === "A");
    const expectedDue = 50_000_000 * 0.04 * dayCountFraction("actual_360", "2026-03-09", "2026-06-09");
    expect(p1.icTests[0].passing).toBe(false);
    expect(p1.stepTrace.equityFromInterest).toBeCloseTo(0, 2);
    expect(p1.stepTrace.ocCureDiversions[0]).toMatchObject({ rank: 1, mode: "paydown" });
    expect(p1.stepTrace.ocCureDiversions[0].amount).toBeCloseTo(expectedDue, 0);
    expect(aPrincipal?.paid ?? 0).toBeCloseTo(expectedDue, 0);
    expect(aPrincipal?.endBalance ?? 0).toBeCloseTo(50_000_000 - expectedDue, 0);
  });

  it("semi-annual tranche phase follows firstPaymentDate instead of projection row parity", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        firstPaymentDate: "2025-12-09",
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 800 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    const q1A = result.periods[0].trancheInterest.find((r) => r.className === "A");
    const q2A = result.periods[1].trancheInterest.find((r) => r.className === "A");
    const expectedDue = 50_000_000 * 0.04 * dayCountFraction("actual_360", "2025-12-09", "2026-06-09");
    expect(q1A?.due ?? 0).toBeCloseTo(expectedDue, 0);
    expect(q2A?.due).toBe(0);
    expect(q2A?.paid).toBe(0);
  });

  it("semi-annual first payment before any prior scheduled date accrues only from projection start", () => {
    const result = runProjection(
      makeInputs({
        ...noDefaults,
        currentDate: "2026-01-15",
        firstPaymentDate: "2026-04-15",
        stubPeriod: true,
        firstPeriodEndDate: "2026-04-15",
        cprPct: 0,
        baseRatePct: 0,
        baseRateFloorPct: 0,
        loans: [{ parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 800 }],
        tranches: [
          {
            className: "A",
            currentBalance: 50_000_000,
            spreadBps: 400,
            seniorityRank: 1,
            isFloating: true,
            isIncomeNote: false,
            isDeferrable: false,
            paymentFrequency: "semi_annual",
          },
          { className: "Sub", currentBalance: 50_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [],
        icTriggers: [],
      }),
    );

    const q1A = result.periods[0].trancheInterest.find((r) => r.className === "A");
    const expectedDue = 50_000_000 * 0.04 * dayCountFraction("actual_360", "2026-01-15", "2026-04-15");
    expect(q1A?.due ?? 0).toBeCloseTo(expectedDue, 0);
  });

  it("blocks semi-annual tranche frequency when emitted rows are not deal payment dates", () => {
    expect(() =>
      runProjection(
        makeInputs({
          firstPaymentDate: "2026-04-15",
          tranches: [
            {
              className: "A",
              currentBalance: 65_000_000,
              spreadBps: 140,
              seniorityRank: 1,
              isFloating: true,
              isIncomeNote: false,
              isDeferrable: false,
              paymentFrequency: "semi_annual",
            },
            { className: "Sub", currentBalance: 35_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
          ],
        }),
      ),
    ).toThrow(/payment-date grid/);
  });

  it("blocks semi-annual tranche frequency when no payment-date phase anchor is available", () => {
    expect(() =>
      runProjection(
        makeInputs({
          firstPaymentDate: null,
          tranches: [
            {
              className: "A",
              currentBalance: 65_000_000,
              spreadBps: 140,
              seniorityRank: 1,
              isFloating: true,
              isIncomeNote: false,
              isDeferrable: false,
              paymentFrequency: "semi_annual",
            },
            { className: "Sub", currentBalance: 35_000_000, spreadBps: 0, seniorityRank: 2, isFloating: false, isIncomeNote: true, isDeferrable: false },
          ],
        }),
      ),
    ).toThrow(/firstPaymentDate is required/);
  });
});
