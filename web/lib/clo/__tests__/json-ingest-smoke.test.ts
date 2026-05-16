/**
 * A8 — JSON-ingest smoke tests.
 *
 * End-to-end mapper + normalizer pass against the real Euro XV compliance.json
 * and ppm.json. Catches the silent-drop class of bugs where a mapper produces
 * a section that the normalizer doesn't read (F11, F12, F13) — by asserting
 * row counts and key field population on what actually lands.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mapCompliance } from "../extraction/json-ingest/compliance-mapper";
import { mapPpm } from "../extraction/json-ingest/ppm-mapper";
import {
  normalizeSectionResults,
  normalizePpmSectionResults,
} from "../extraction/normalizer";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const COMPLIANCE_PATH = join(REPO_ROOT, "compliance.json");
const PPM_PATH = join(REPO_ROOT, "ppm.json");

function pickRow(row: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, row[key] ?? null]));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("A8 — JSON-ingest smoke (Euro XV compliance + ppm)", () => {
  const compliance = JSON.parse(readFileSync(COMPLIANCE_PATH, "utf8"));
  const ppm = JSON.parse(readFileSync(PPM_PATH, "utf8"));
  const compSections = mapCompliance(compliance);
  const ppmSections = mapPpm(ppm);
  const normalized = normalizeSectionResults(compSections as never, "rp", "deal");
  const constraints = normalizePpmSectionResults(ppmSections);

  it("F11 — paymentHistory lands per-tranche × per-period rows", () => {
    expect(normalized.paymentHistory).toHaveLength(136);
    const classes = [...new Set(normalized.paymentHistory.map((r) => r.className))];
    expect(classes).toEqual(["a", "b-1", "b-2", "c", "d", "e", "f", "sub"]);
    expect([...new Set(normalized.paymentHistory.map((r) => r.paymentDate))]).toHaveLength(17);
    expect(Object.fromEntries(classes.map((className) => [
      className,
      normalized.paymentHistory.filter((r) => r.className === className).length,
    ]))).toEqual({ a: 17, "b-1": 17, "b-2": 17, c: 17, d: 17, e: 17, f: 17, sub: 17 });
    // Every row has an ISO date (no "Mon DD, YYYY" leakage)
    for (const r of normalized.paymentHistory) {
      expect(r.paymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("holdings count + market value sum matches Euro XV source inventory", () => {
    expect(normalized.holdings).toHaveLength(236);
    const mvSum = normalized.holdings.reduce(
      (s, h) => s + (Number((h as Record<string, unknown>).market_value) || 0),
      0,
    );
    expect(mvSum).toBeCloseTo(467_906_516.41, 2);
  });

  it("threads JSON interest-accrual payment periods into holdings", () => {
    const withPaymentPeriod = normalized.holdings.filter(
      (h) => typeof (h as Record<string, unknown>).payment_period === "string" &&
        ((h as Record<string, unknown>).payment_period as string).trim().length > 0,
    );

    expect(withPaymentPeriod).toHaveLength(235);
  });

  it("F15 — DDTL holdings are flagged when loan_type == 'Delayed Draw Loan'", () => {
    const ddtl = normalized.holdings.filter(
      (h) => (h as Record<string, unknown>).is_delayed_draw === true,
    );
    // Euro XV has 1 DDTL position (Eleda)
    expect(ddtl).toHaveLength(1);
  });

  it("pins mapped compliance source section counts", () => {
    expect(normalized.complianceTests).toHaveLength(17);
    expect(normalized.concentrations).toHaveLength(63);
    expect(normalized.waterfallSteps).toHaveLength(36);
    expect(normalized.trancheSnapshots).toHaveLength(8);
    expect(normalized.accountBalances).toHaveLength(2);
  });

  it("F1 — waterfallSteps include both INTEREST and PRINCIPAL types", () => {
    const types = new Set(
      normalized.waterfallSteps.map((s) => (s as Record<string, unknown>).waterfall_type),
    );
    expect(types.has("INTEREST")).toBe(true);
    expect(types.has("PRINCIPAL")).toBe(true);
  });

  it("F8 — accountBalances mapper output stamps asOfDate", () => {
    const ab = compSections.account_balances as { asOfDate?: string | null };
    expect(ab.asOfDate).toBeTruthy();
    expect(ab.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("F10 — capitalStructure deferrable is populated for rated classes", () => {
    const cs = constraints.capitalStructure as Array<{ class: string; deferrable?: boolean }>;
    expect(cs).toHaveLength(8);
    expect((constraints as Record<string, unknown>).coverageTestEntries).toHaveLength(5);
    expect((constraints as Record<string, unknown>).fees).toHaveLength(5);
    expect((constraints as Record<string, unknown>).keyParties).toHaveLength(9);
    const ratedTranches = cs.filter((t) => !/sub|equity|residual/i.test(t.class));
    for (const t of ratedTranches) {
      expect(typeof t.deferrable).toBe("boolean");
    }
  });

  it("maps PPM fields that gate projection build", () => {
    expect((constraints as Record<string, unknown>).excessCccAdjustment).toEqual({
      thresholdPct: "7.5",
      marketValuePct: "70",
    });
    const interestMechanics = (constraints as Record<string, unknown>).interestMechanics as Record<string, unknown>;
    expect(interestMechanics.referenceWeightedAverageFixedCoupon).toBe(4);
    expect(interestMechanics.deferredInterestCompounds).toBe(true);
    expect((constraints as Record<string, unknown>).issuerProfitAmount).toMatchObject({
      amountPerPeriod: 250,
      postFrequencySwitchAmountPerPeriod: 500,
      currency: "EUR",
    });
  });

  it("pins named mapped rows that drive waterfall and asset economics", () => {
    const paymentKeys = [
      "className",
      "period",
      "paymentDate",
      "interestPaid",
      "principalPaid",
      "cashflow",
      "endingBalance",
      "interestShortfall",
      "accumInterestShortfall",
    ] as const;
    const holdingKeys = [
      "obligor_name",
      "facility_name",
      "lxid",
      "asset_type",
      "maturity_date",
      "par_balance",
      "principal_balance",
      "market_value",
      "current_price",
      "is_delayed_draw",
      "spread_bps",
      "all_in_rate",
      "index_rate",
      "reference_rate",
      "floor_rate",
      "payment_period",
      "is_fixed_rate",
    ] as const;
    const capitalStructureKeys = [
      "class",
      "principalAmount",
      "rateType",
      "referenceRate",
      "spreadBps",
      "rating",
      "isSubordinated",
      "deferrable",
      "maturityDate",
    ] as const;
    const payment = (className: string, paymentDate: string) =>
      normalized.paymentHistory.find((row) => row.className === className && row.paymentDate === paymentDate);
    const holding = (obligorName: string, facilityName: string) =>
      normalized.holdings.find((row) =>
        row.obligor_name === obligorName &&
        row.facility_name === facilityName
      ) as Record<string, unknown> | undefined;
    const tranche = (className: string) =>
      (constraints.capitalStructure as Array<Record<string, unknown>>).find((row) => row.class === className);

    expect(fingerprint(pickRow(payment("a", "2026-04-15") as unknown as Record<string, unknown>, paymentKeys))).toBe("2b083507ecdd5036e85496f019711084443515082c38c8e7078ff64b06606677");
    expect(fingerprint(pickRow(payment("sub", "2026-04-15") as unknown as Record<string, unknown>, paymentKeys))).toBe("9052ae3c81dd96230cfe44494872ccf6f6b4ab31dd49c9f3984c3efcc25fd394");
    expect(fingerprint(pickRow(payment("b-2", "2021-12-15") as unknown as Record<string, unknown>, paymentKeys))).toBe("b44a049253ea03eae55a958dd77adb1c5ec5e37e06619d0902be3667018a9f93");
    expect(fingerprint(pickRow(holding("Admiral Bidco GmbH", "Facility B2")!, holdingKeys))).toBe("7751d4840e77695a07eb8222e97ac3d7bb69224ec0e22af76dbc91cfd9c9c301");
    expect(fingerprint(pickRow(holding("Eleda Management AB", "Delayed Draw Term Loan")!, holdingKeys))).toBe("f0b4d68a18ae330fe1bcc8aca32007b8f0e951feca9d5376409c2237a3797ade");
    expect(fingerprint(pickRow(holding("Altice Financing SA", "Altice Financing SA 3.0 15Jan28")!, holdingKeys))).toBe("a555376c024068f3fd96ad8ff189644795217660f6b926bb67324adcf48bbf10");
    expect(fingerprint(pickRow(tranche("Class A")!, capitalStructureKeys))).toBe("793244898685fcfc5500a84e5ff67f8bc6fa1d3cefa7ff33f442951287a63ca5");
    expect(fingerprint(pickRow(tranche("Class F")!, capitalStructureKeys))).toBe("3c3e5020380e31c53f450e166b7ebf6889214ef4fcbfca3ce11c7ccbf95b2558");
    expect(fingerprint(pickRow(tranche("Subordinated Notes")!, capitalStructureKeys))).toBe("47ba647539ba9950a0b0e0e14f73bca2c0bf9cd8010235fbd2ddc12c3ec37db0");
  });

  it("maps camelCase deal-level paymentFrequency from JSON key dates", () => {
    const mapped = mapPpm({
      ...ppm,
      section_2_key_dates: {
        ...ppm.section_2_key_dates,
        payment_frequency: undefined,
        paymentFrequency: "Semi-annually",
      },
    });

    expect((mapped.key_dates as Record<string, unknown>).paymentFrequency).toBe("Semi-annually");
  });

  it("maps snake_case structured principal POP interest_waterfall into resolver shape", () => {
    const principalPop = (constraints as Record<string, unknown>)
      .principalPriorityOfPayments as Record<string, unknown>;

    expect(principalPop).toBeTruthy();
    expect(principalPop.clauses).toHaveLength(22);
    expect(principalPop.interestWaterfall).toBeTruthy();
    expect(principalPop).not.toHaveProperty("interest_waterfall");
  });

  it("falls back to camelCase paymentFrequency when snake_case JSON fields are blank", () => {
    const mapped = mapPpm({
      ...ppm,
      section_2_key_dates: {
        ...ppm.section_2_key_dates,
        payment_frequency: " ",
        paymentFrequency: "Semi-annually",
      },
      section_3_capital_structure: {
        ...ppm.section_3_capital_structure,
        tranches: [
          {
            ...ppm.section_3_capital_structure.tranches[0],
            payment_frequency: "",
            paymentFrequency: "Quarterly",
          },
        ],
      },
    });

    expect((mapped.key_dates as Record<string, unknown>).paymentFrequency).toBe("Semi-annually");
    expect(((mapped.capital_structure as Record<string, unknown>).capitalStructure as Array<Record<string, unknown>>)[0].paymentFrequency).toBe("Quarterly");
  });

  it("compliance mapper does not emit dead orphan sections (F12, F13)", () => {
    // F12 — interest_accrual section was an orphan production; should be gone.
    expect(compSections).not.toHaveProperty("interest_accrual");
    // F13 — interestAmountsPerTranche field was an orphan within IC tests.
    const ict = compSections.interest_coverage_tests as Record<string, unknown>;
    expect(ict).not.toHaveProperty("interestAmountsPerTranche");
  });
});
