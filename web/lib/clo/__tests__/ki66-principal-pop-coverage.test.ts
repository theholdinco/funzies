import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("KI-66 — Ares XV structured principal POP coverage", () => {
  const ppm = JSON.parse(readFileSync(join(process.cwd(), "..", "ppm.json"), "utf8"));
  const structured = ppm.section_6_waterfall.principal_priority_of_payments.structured;
  const clauses = structured.clauses as Array<{ id: string; kind: string; paysItems?: string[] }>;

  it("keeps the Ares XV A-V principal POP as a 22-clause structured input", () => {
    expect(ppm.section_6_waterfall.principal_priority_of_payments.clause_count).toBe(22);
    expect(clauses.map((c) => c.id)).toEqual(
      "ABCDEFGHIJKLMNOPQRSTUV".split("").map((letter) => `ppm.${letter}`),
    );
  });

  it("has an explicit engine treatment category for every structured clause", () => {
    const engineTreatmentByClause = {
      "ppm.A": "active-dispatch",
      "ppm.B": "active-dispatch",
      "ppm.C": "active-dispatch",
      "ppm.D": "active-dispatch",
      "ppm.E": "active-dispatch",
      "ppm.F": "active-dispatch",
      "ppm.G": "active-dispatch",
      "ppm.H": "active-dispatch",
      "ppm.I": "active-dispatch",
      "ppm.J": "active-dispatch",
      "ppm.K": "active-dispatch",
      "ppm.L": "active-dispatch",
      "ppm.M": "active-dispatch",
      "ppm.N": "active-dispatch",
      "ppm.O": "event-state-no-op",
      "ppm.P": "user-input-dispatch",
      "ppm.Q": "upstream-reinvestment-path",
      "ppm.R": "active-dispatch",
      "ppm.S": "active-dispatch",
      "ppm.T": "user-input-dispatch",
      "ppm.U": "existing-incentive-fee-path",
      "ppm.V": "existing-residual-path",
    } satisfies Record<string, string>;

    expect(Object.keys(engineTreatmentByClause)).toEqual(clauses.map((c) => c.id));
  });

  it("pins clause S as the late post-RP overflow backfill, not an early current-interest backfill", () => {
    const clauseS = clauses.find((c) => c.id === "ppm.S");
    expect(clauseS).toEqual({
      id: "ppm.S",
      kind: "post_rp_interest_overflow",
      paysItems: ["i.reinv_oc_diversion", "i.sub_mgmt_fee", "i.trustee_overflow", "i.admin_overflow"],
    });
  });
});
