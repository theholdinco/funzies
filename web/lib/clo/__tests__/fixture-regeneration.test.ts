/**
 * Fixture regeneration probe — verifies that running the current resolver on
 * `fixture.raw` produces exactly the fields in `fixture.resolved` that have
 * been hand-patched during Sprint 1 / B1 (principalAccountCash,
 * impliedOcAdjustment, ocTriggers without EOD, eventOfDefaultTest).
 *
 * If the probe passes, the fixture is canonical — reproducible from the
 * current resolver + raw data, and the patches can be retired in favour of
 * actual regeneration. If it fails, it surfaces latent resolver bugs that
 * the hand-patches papered over.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildFromResolved, defaultsFromResolved } from "@/lib/clo/build-projection-inputs";
import { runProjection } from "@/lib/clo/projection";
import { resolveWaterfallInputs } from "@/lib/clo/resolver";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

function isValidIsoDateString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function activeAssetScheduleShape(loans: Array<Record<string, unknown>>) {
  return loans.flatMap((loan, index) => {
    const interval = loan.assetPaymentIntervalMonths;
    const exposure =
      Math.max(0, Number(loan.parBalance ?? 0)) +
      Math.max(0, Number(loan.undrawnCommitment ?? 0));
    if (
      exposure <= 0 ||
      typeof interval !== "number" ||
      ![1, 2, 3, 6].includes(interval) ||
      !isValidIsoDateString(loan.nextPaymentDate)
    ) {
      return [];
    }
    return [{
      index,
      obligorName: loan.obligorName ?? null,
      maturityDate: loan.maturityDate ?? null,
      assetPaymentIntervalMonths: interval,
      nextPaymentDate: loan.nextPaymentDate,
      accrualEndDate: loan.accrualEndDate ?? null,
    }];
  });
}

function loanEconomicsFingerprint(loans: Array<Record<string, unknown>>) {
  const keys = [
    "obligorName",
    "parBalance",
    "maturityDate",
    "ratingBucket",
    "spreadBps",
    "isFixedRate",
    "fixedCouponPct",
    "currency",
    "currentPrice",
    "purchasePricePct",
    "recoveryRateMoodys",
    "recoveryRateSp",
    "recoveryRateFitch",
    "dayCountConvention",
    "floorRate",
    "warfFactor",
    "isCovLite",
    "isPik",
    "pikSpreadBps",
    "industryCode",
    "industryName",
    "isDelayedDraw",
    "isRevolving",
    "undrawnCommitment",
    "ddtlSpreadBps",
    "assetPaymentPeriodRaw",
    "assetPaymentIntervalMonths",
    "assetPaymentScheduleSource",
    "nextPaymentDate",
    "accrualBeginDate",
    "accrualEndDate",
    "openingAccruedInterest",
  ] as const;

  return loans.map((loan, index) => {
    const row: Record<string, unknown> = { index };
    for (const key of keys) row[key] = loan[key] ?? null;
    return row;
  });
}

function fingerprintDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pickRow(row: Record<string, unknown> | undefined, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, row?.[key] ?? null]));
}

describe("fixture regeneration probe", () => {
  const raw = fixture.raw;
  const { resolved, warnings } = resolveWaterfallInputs(
    raw.constraints,
    raw.complianceData,
    raw.tranches,
    raw.trancheSnapshots,
    raw.holdings,
    raw.dealDates,
    raw.accountBalances,
    raw.parValueAdjustments,
    undefined,
    raw.accruals,
  );

  it("raw fixture pins source inventory counts", () => {
    expect(raw.holdings).toHaveLength(413);
    expect(raw.accruals).toHaveLength(280);
    expect(raw.trades).toHaveLength(169);
    expect(raw.tranches).toHaveLength(8);
    expect(raw.trancheSnapshots).toHaveLength(8);
    expect(raw.accountBalances).toHaveLength(47);
    expect(raw.waterfallSteps).toHaveLength(35);
    expect(raw.proceeds).toHaveLength(2);
    expect(raw.extractedDistributions).toHaveLength(17);
    expect(raw.complianceData.complianceTests).toHaveLength(95);
    expect(raw.complianceData.concentrations).toHaveLength(63);
    expect(raw.constraints.capitalStructure).toHaveLength(8);
    expect(raw.constraints.coverageTestEntries).toHaveLength(5);
    expect(raw.constraints.collateralQualityTests).toHaveLength(7);
    expect(raw.constraints.keyParties).toHaveLength(9);
    expect(raw.constraints.fees).toHaveLength(5);
  });

  it("raw fixture pins named source rows that drive import quality", () => {
    const holdingKeys = [
      "obligorName",
      "facilityName",
      "lxid",
      "assetType",
      "maturityDate",
      "parBalance",
      "principalBalance",
      "marketValue",
      "currentPrice",
      "isDelayedDraw",
      "spreadBps",
      "allInRate",
      "indexRate",
      "referenceRate",
      "floorRate",
      "paymentPeriod",
      "isFixedRate",
    ] as const;
    const accrualKeys = [
      "issuerName",
      "securityName",
      "loanxId",
      "securityId",
      "paymentFrequency",
      "accrualBeginDate",
      "accrualEndDate",
      "rateIndex",
      "floorRate",
      "allInRate",
      "spread",
      "annualInterest",
    ] as const;
    const tradeKeys = [
      "obligorName",
      "facilityName",
      "description",
      "tradeType",
      "tradeDate",
      "cashFlowType",
      "nativeAmount",
      "nativeCurrency",
      "settlementPrice",
      "settlementAmount",
      "saleReason",
    ] as const;
    const accountKeys = ["accountName", "accountType", "currency", "balanceAmount", "requiredBalance", "accountInterest", "dataSource"] as const;
    const waterfallKeys = ["waterfallType", "priorityOrder", "description", "amountDue", "amountPaid", "shortfall", "isOcTestDiversion", "isIcTestDiversion"] as const;
    const complianceKeys = ["testName", "testType", "testClass", "actualValue", "triggerLevel", "cushionPct", "isPassing", "testDate", "vendorId"] as const;
    const holding = (obligorName: string, facilityName: string) =>
      raw.holdings.find((row: Record<string, unknown>) =>
        row.obligorName === obligorName &&
        row.facilityName === facilityName
      );
    const accrual = (obligorName: string, facilityName: string) =>
      raw.accruals.find((row: Record<string, unknown>) =>
        row.issuerName === obligorName &&
        row.securityName === facilityName
      );
    const trade = (obligorName: string) =>
      raw.trades.find((row: Record<string, unknown>) => row.obligorName === obligorName);
    const waterfall = (type: string, stepCode: string) =>
      raw.waterfallSteps.find((row: Record<string, unknown>) =>
        row.waterfallType === type &&
        row.description === stepCode
      );
    const complianceTest = (testName: string) =>
      raw.complianceData.complianceTests.find((row: Record<string, unknown>) => row.testName === testName);

    expect(fingerprintDigest(pickRow(holding("Ion Platform Finance Us, Inc.", "(EUR) TL"), holdingKeys))).toBe("6d2775a3abbafcea1b8748e90aca413cc2a5071a00519b16a542ee87151880ba");
    expect(fingerprintDigest(pickRow(holding("Eleda Management AB", "Delayed Draw Term Loan"), holdingKeys))).toBe("7ba28454a636bad008a6fa9814abf924786f0377d3e655e5ea2cc7316ff74578");
    expect(fingerprintDigest(pickRow(holding("Altice Financing SA", "4.25 15Aug29"), holdingKeys))).toBe("7b7333addbbfbba333adb68c11adc827e2c30a05c3b1f1bf8010ce4eb4735523");
    expect(fingerprintDigest(pickRow(accrual("Admiral Bidco GmbH", "Facility B2"), accrualKeys))).toBe("891d51d1f03adc70762809f8eaa19c1acc0663e7030d792318c5c97c31a4e680");
    expect(fingerprintDigest(pickRow(accrual("Cloud Software Group Inc", "Euro Term B Facility"), accrualKeys))).toBe("821fb545c03ca3445308717cee8b4f4ab4ff57ac5bbaa6d21b4d5ca274218ab8");
    expect(fingerprintDigest(pickRow(trade("Dione Bidco Limited"), tradeKeys))).toBe("6d3b19dc7e85c6688cc5a280a13063b6a87fc3272a5ae984b18f396fd6525694");
    expect(fingerprintDigest(pickRow(raw.accountBalances.find((row: Record<string, unknown>) => row.accountName === "Ares European CLO XV DAC Principle EUR"), accountKeys))).toBe("cfdcaac48abfd512ddfc17d1acfdb82d9b50e4e6a49b4e5a92b088f1b8d57777");
    expect(fingerprintDigest(pickRow(waterfall("INTEREST", "(A)(i)"), waterfallKeys))).toBe("4b296b9be0a478e3d3edca31950cb80273d9362ab9f2da4e6930c56beb4f61df");
    expect(fingerprintDigest(pickRow(waterfall("INTEREST", "(DD)"), waterfallKeys))).toBe("d8cd4894fbd69235ed971a443ac56a0707c86b986fa7ade431d5438c755ac4f7");
    expect(fingerprintDigest(pickRow(complianceTest("Class A/B Interest Coverage Test"), complianceKeys))).toBe("849995807e0871255e23f670f2c427453c1108a27df2c78d83e4b5d230823962");
    expect(fingerprintDigest(pickRow(complianceTest("Moody's Maximum Weighted Average Rating Factor Test"), complianceKeys))).toBe("c43ead7ece8be1f309ef6153247ffa3d6af8a57d2cde09b2cbed162288a0fdc7");
  });

  it("fresh Euro XV resolver output has no KI-36/KI-38 blocking warnings", () => {
    const relevantBlockingWarnings = warnings.filter((w) => {
      if (!w.blocking) return false;
      return (
        w.field === "currency" ||
        w.field === "loans.currency" ||
        w.field === "accountBalances.currency" ||
        w.field.includes("paymentFrequency")
      );
    });

    expect(relevantBlockingWarnings).toEqual([]);
  });

  it("fresh Euro XV resolver output has no blocking asset-schedule warnings", () => {
    expect(warnings.filter((w) => w.field === "loans.assetPaymentSchedule" && w.blocking)).toEqual([]);
  });

  it("fresh Euro XV resolver output pins non-blocking asset-schedule warning inventory", () => {
    const assetScheduleWarnings = warnings.filter((w) => w.field === "loans.assetPaymentSchedule");
    const inventory = new Map<string, number>();

    for (const warning of assetScheduleWarnings) {
      const missingAnchor = warning.message.match(
        /^Holding "([^"]+)" has asset payment period "([^"]+)" but no valid nextPaymentDate anchor\./,
      );
      const contradictory = warning.message.match(
        /^Holding "([^"]+)" has contradictory asset schedule evidence \(paymentPeriod ([^,]+), nextPaymentDate ([^,]+), accrualEndDate ([^)]+)\)\./,
      );
      const duplicateAccrual = warning.message.match(
        /^Holding "([^"]+)" has duplicate or conflicting accrual rows/,
      );
      const key = missingAnchor
        ? `missing-anchor|${missingAnchor[1]}|${missingAnchor[2]}`
        : contradictory
          ? `contradictory|${contradictory[1]}|${contradictory[2]}|${contradictory[3]}|${contradictory[4]}`
          : duplicateAccrual
            ? `duplicate-accrual|${duplicateAccrual[1]}`
            : `unparsed|${warning.message}`;
      inventory.set(key, (inventory.get(key) ?? 0) + 1);
    }

    expect(assetScheduleWarnings).toHaveLength(38);
    expect(assetScheduleWarnings.filter((w) => /no valid nextPaymentDate anchor/.test(w.message))).toHaveLength(7);
    expect(assetScheduleWarnings.filter((w) => /contradictory asset schedule evidence/.test(w.message))).toHaveLength(15);
    expect(assetScheduleWarnings.filter((w) => /duplicate or conflicting accrual rows/.test(w.message))).toHaveLength(16);
    expect([...inventory.entries()].sort().map(([key, count]) => `${count}x ${key}`)).toEqual([
      "4x contradictory|Altice Financing SA|6 Months|2026-07-15|2026-08-15",
      "3x contradictory|Cloud Software Group Inc|3 Months|2026-06-30|2026-05-29",
      "2x contradictory|Infinity Bidco 1 Limited|1 Month|2026-09-30|2026-04-30",
      "2x contradictory|Infinity Bidco 1 Limited|3 Months|2026-09-30|2026-06-30",
      "4x contradictory|United Group BV|6 Months|2026-08-01|2026-08-06",
      "6x duplicate-accrual|Cloud Software Group Inc",
      "6x duplicate-accrual|Infinity Bidco 1 Limited",
      "2x duplicate-accrual|Ki Knight France Bidco",
      "2x duplicate-accrual|Median B.V.",
      "1x missing-anchor|Althea Acquisition Bidco S.a r.l.|3 Months",
      "1x missing-anchor|Betclic Everest Group|1 Month",
      "1x missing-anchor|Cube Safety Bidco AB|1 Month",
      "4x missing-anchor|Tele Columbus AG|6 Months",
    ]);
  });

  it("regenerated principalAccountCash matches fixture-patched value", () => {
    expect(resolved.principalAccountCash).toBeCloseTo(fixture.resolved.principalAccountCash, 2);
    // And is negative (the Euro XV overdraft).
    expect(resolved.principalAccountCash).toBeLessThan(0);
  });

  it("regenerated impliedOcAdjustment matches fixture-patched value (≈ 0)", () => {
    expect(resolved.impliedOcAdjustment).toBeCloseTo(fixture.resolved.impliedOcAdjustment, -1);
    expect(Math.abs(resolved.impliedOcAdjustment)).toBeLessThan(10);
  });

  it("regenerated ocTriggers does NOT contain EOD", () => {
    const hasEod = resolved.ocTriggers.some(
      (t) => t.className.toLowerCase() === "eod" || t.className.toLowerCase().includes("event of default"),
    );
    expect(hasEod).toBe(false);
    expect(resolved.ocTriggers.length).toBe(fixture.resolved.ocTriggers.length);
  });

  it("regenerated eventOfDefaultTest matches fixture", () => {
    expect(resolved.eventOfDefaultTest).not.toBeNull();
    expect(resolved.eventOfDefaultTest!.triggerLevel).toBeCloseTo(102.5, 2);
  });

  it("numeric pool/fee fields match fixture", () => {
    expect(resolved.poolSummary.totalPrincipalBalance).toBeCloseTo(
      fixture.resolved.poolSummary.totalPrincipalBalance,
      2,
    );
    expect(resolved.fees.seniorFeePct).toBeCloseTo(fixture.resolved.fees.seniorFeePct, 4);
    expect(resolved.fees.subFeePct).toBeCloseTo(fixture.resolved.fees.subFeePct, 4);
  });

  it("regenerated loan asset-schedule fields match fixture loan shape", () => {
    const keys = [
      "assetPaymentPeriodRaw",
      "assetPaymentIntervalMonths",
      "assetPaymentScheduleSource",
      "nextPaymentDate",
      "accrualBeginDate",
      "accrualEndDate",
      "openingAccruedInterest",
    ] as const;

    expect(resolved.loans).toHaveLength(fixture.resolved.loans.length);
    for (let i = 0; i < resolved.loans.length; i++) {
      for (const key of keys) {
        expect(fixture.resolved.loans[i][key] ?? null, `loan[${i}].${key}`).toEqual(
          resolved.loans[i][key] ?? null,
        );
      }
    }
  });

  it("Euro XV fixture pins loan economics that drive projection cashflows", () => {
    const freshFingerprint = loanEconomicsFingerprint(resolved.loans as unknown as Array<Record<string, unknown>>);
    const storedFingerprint = loanEconomicsFingerprint(fixture.resolved.loans as Array<Record<string, unknown>>);

    expect(freshFingerprint).toEqual(storedFingerprint);
    expect(fingerprintDigest(freshFingerprint)).toBe(
      "95e467b3d1ab1f19d9f7af358588cca015b8d46136437206ae7ec2eff7a1ab00",
    );
  });

  it("Euro XV fixture pins active asset-schedule population and interval mix", () => {
    const freshActive = activeAssetScheduleShape(resolved.loans as unknown as Array<Record<string, unknown>>);
    const storedActive = activeAssetScheduleShape(fixture.resolved.loans as Array<Record<string, unknown>>);
    const intervalMix = (active: ReturnType<typeof activeAssetScheduleShape>) =>
      active.reduce<Record<number, number>>((acc, loan) => {
        acc[loan.assetPaymentIntervalMonths] = (acc[loan.assetPaymentIntervalMonths] ?? 0) + 1;
        return acc;
      }, {});

    expect(storedActive).toHaveLength(391);
    expect(intervalMix(storedActive)).toEqual({ 1: 73, 2: 11, 3: 215, 6: 92 });
    expect(freshActive).toEqual(storedActive);
  });

  it("fixture has no active asset schedule with contradictory accrual end date", () => {
    for (let i = 0; i < fixture.resolved.loans.length; i++) {
      const loan = fixture.resolved.loans[i];
      if (
        loan.assetPaymentIntervalMonths != null &&
        loan.nextPaymentDate != null &&
        loan.accrualEndDate != null
      ) {
        expect(loan.nextPaymentDate, `loan[${i}].nextPaymentDate`).toBe(loan.accrualEndDate);
      }
    }
  });

  it("Euro XV fixture pins scheduled asset cash and receivable roll", () => {
    const inputs = buildFromResolved(
      fixture.resolved,
      defaultsFromResolved(fixture.resolved, fixture.raw),
    );
    const projection = runProjection(inputs);
    const expected = [
      { date: "2026-07-01", interestCollected: 6_738_691.56, endingAssetInterestReceivable: 2_831_089.15 },
      { date: "2026-10-01", interestCollected: 6_935_939.12, endingAssetInterestReceivable: 2_655_309.11 },
      { date: "2027-01-01", interestCollected: 6_528_704.79, endingAssetInterestReceivable: 2_552_974.96 },
      { date: "2027-04-01", interestCollected: 6_173_173.58, endingAssetInterestReceivable: 2_364_911.68 },
    ];

    expect(projection.periods.slice(0, expected.length).map((p) => p.date)).toEqual(
      expected.map((p) => p.date),
    );
    for (let i = 0; i < expected.length; i++) {
      expect(projection.periods[i].interestCollected).toBeCloseTo(expected[i].interestCollected, 2);
      expect(projection.periods[i].endingAssetInterestReceivable).toBeCloseTo(
        expected[i].endingAssetInterestReceivable,
        2,
      );
    }
  });

  // Recursive full-equality guard on every top-level `resolved.*`
  // field. The original spot-check tests above cover individual patched
  // fields but missed silent drift for ~20 days (caught at D4 ship:
  // top10ObligorsPct never populated in fixture, pctSecondLien: 0 → null
  // drift undetected since Sprint 0). This iterator walks fresh vs stored
  // resolved output recursively and fails with named mismatches.
  //
  // Fields skipped (non-deterministic / volatile): `metadata` (carries
  // timestamps + sdfFilesIngested which change per ingest); `loans` (large
  // array — per-field field-drift on 400+ loans produces massive test output
  // for a single resolver-level change; delegate loan-shape coverage to
  // dedicated resolver tests if needed).
  it("every top-level resolved.* field matches fresh resolver output (recursive full-equality)", () => {
    const SKIP_TOP_KEYS = new Set(["metadata", "loans"]);
    const mismatches: string[] = [];
    const walk = (path: string, fresh: unknown, stored: unknown) => {
      // Null/undefined equivalence.
      if (fresh == null && stored == null) return;
      if (fresh == null || stored == null) {
        mismatches.push(`${path}: fresh=${String(fresh)} vs stored=${String(stored)}`);
        return;
      }
      // Arrays: compare length + element-wise.
      if (Array.isArray(fresh) || Array.isArray(stored)) {
        if (!Array.isArray(fresh) || !Array.isArray(stored)) {
          mismatches.push(`${path}: array shape mismatch`);
          return;
        }
        if (fresh.length !== stored.length) {
          mismatches.push(`${path}: length fresh=${fresh.length} vs stored=${stored.length}`);
          return;
        }
        for (let i = 0; i < fresh.length; i++) {
          walk(`${path}[${i}]`, fresh[i], stored[i]);
        }
        return;
      }
      // Objects: walk every key on both sides.
      if (typeof fresh === "object" && typeof stored === "object") {
        const keys = new Set([...Object.keys(fresh), ...Object.keys(stored)]);
        for (const k of keys) {
          walk(`${path}.${k}`, (fresh as Record<string, unknown>)[k], (stored as Record<string, unknown>)[k]);
        }
        return;
      }
      // Numbers: allow 1e-4 relative tolerance for float artifacts.
      if (typeof fresh === "number" && typeof stored === "number") {
        const tol = Math.max(1e-6, Math.abs(stored) * 1e-4);
        if (Math.abs(fresh - stored) > tol) {
          mismatches.push(`${path}: fresh=${fresh} vs stored=${stored} (Δ=${fresh - stored})`);
        }
        return;
      }
      // Primitives: strict equality.
      if (fresh !== stored) {
        mismatches.push(`${path}: fresh=${JSON.stringify(fresh)} vs stored=${JSON.stringify(stored)}`);
      }
    };

    const freshResolved = resolved as unknown as Record<string, unknown>;
    const storedResolved = fixture.resolved as Record<string, unknown>;
    const topKeys = new Set([...Object.keys(freshResolved), ...Object.keys(storedResolved)]);
    for (const k of topKeys) {
      if (SKIP_TOP_KEYS.has(k)) continue;
      walk(k, freshResolved[k], storedResolved[k]);
    }
    expect(mismatches.slice(0, 20), mismatches.join("\n")).toEqual([]);
  });
});
