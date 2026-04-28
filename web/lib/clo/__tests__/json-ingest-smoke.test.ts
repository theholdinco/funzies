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
import { mapCompliance } from "../extraction/json-ingest/compliance-mapper";
import { mapPpm } from "../extraction/json-ingest/ppm-mapper";
import {
  normalizeSectionResults,
  normalizePpmSectionResults,
} from "../extraction/normalizer";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const COMPLIANCE_PATH = join(REPO_ROOT, "compliance.json");
const PPM_PATH = join(REPO_ROOT, "ppm.json");

describe("A8 — JSON-ingest smoke (Euro XV compliance + ppm)", () => {
  const compliance = JSON.parse(readFileSync(COMPLIANCE_PATH, "utf8"));
  const ppm = JSON.parse(readFileSync(PPM_PATH, "utf8"));
  const compSections = mapCompliance(compliance);
  const ppmSections = mapPpm(ppm);
  const normalized = normalizeSectionResults(compSections as never, "rp", "deal");
  const constraints = normalizePpmSectionResults(ppmSections);

  it("F11 — paymentHistory lands per-tranche × per-period rows", () => {
    // Euro XV has 8 tranches × 17 periods = 136 rows
    expect(normalized.paymentHistory.length).toBeGreaterThanOrEqual(120);
    const classes = new Set(normalized.paymentHistory.map((r) => r.className));
    expect(classes.size).toBeGreaterThanOrEqual(7);
    // Every row has an ISO date (no "Mon DD, YYYY" leakage)
    for (const r of normalized.paymentHistory) {
      expect(r.paymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("holdings count + market value sum is reasonable (non-zero)", () => {
    expect(normalized.holdings.length).toBeGreaterThan(100);
    const mvSum = normalized.holdings.reduce(
      (s, h) => s + (Number((h as Record<string, unknown>).market_value) || 0),
      0,
    );
    expect(mvSum).toBeGreaterThan(100_000_000);
  });

  it("F15 — DDTL holdings are flagged when loan_type == 'Delayed Draw Loan'", () => {
    const ddtl = normalized.holdings.filter(
      (h) => (h as Record<string, unknown>).is_delayed_draw === true,
    );
    // Euro XV has 1 DDTL position (Eleda)
    expect(ddtl.length).toBeGreaterThanOrEqual(1);
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
    expect(cs.length).toBeGreaterThan(0);
    const ratedTranches = cs.filter((t) => !/sub|equity|residual/i.test(t.class));
    for (const t of ratedTranches) {
      expect(typeof t.deferrable).toBe("boolean");
    }
  });

  it("compliance mapper does not emit dead orphan sections (F12, F13)", () => {
    // F12 — interest_accrual section was an orphan production; should be gone.
    expect(compSections).not.toHaveProperty("interest_accrual");
    // F13 — interestAmountsPerTranche field was an orphan within IC tests.
    const ict = compSections.interest_coverage_tests as Record<string, unknown>;
    expect(ict).not.toHaveProperty("interestAmountsPerTranche");
  });
});
