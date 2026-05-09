import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("SDF notes ingest payment frequency semantics", () => {
  it("clears payment_frequency when the latest SDF note row omits Payment_Frequency", () => {
    const source = readFileSync(resolve(__dirname, "../sdf/ingest.ts"), "utf8");
    expect(source).toMatch(/payment_frequency = \$7/);
    expect(source).not.toMatch(/payment_frequency = COALESCE\(\$7, payment_frequency\)/);
  });

  it("clears stale PPM payment_frequency when the latest PPM extraction omits it", () => {
    const persistSource = readFileSync(resolve(__dirname, "../extraction/persist-ppm.ts"), "utf8");
    const runnerSource = readFileSync(resolve(__dirname, "../extraction/runner.ts"), "utf8");

    expect(persistSource).toMatch(/payment_frequency = \$\$\{pi\+\+\}/);
    expect(persistSource).toMatch(/entry\.paymentFrequency\?\.trim\(\) \|\| null/);
    expect(runnerSource).toMatch(/payment_frequency = \$\$\{pi\+\+\}/);
    expect(runnerSource).toMatch(/String\(entry\.paymentFrequency \?\? ""\)\.trim\(\) \|\| null/);
    expect(runnerSource).not.toMatch(/payment_frequency = COALESCE\(payment_frequency/);
  });

  it("manual context saves resync relational tranche frequency state", () => {
    const source = readFileSync(resolve(__dirname, "../../../app/api/clo/profile/constraints/route.ts"), "utf8");
    expect(source).toMatch(/syncPpmToRelationalTables/);
  });

  it("new PPM extraction queues clear stale extracted PPM JSON while replacement is pending", () => {
    const source = readFileSync(resolve(__dirname, "../../../app/api/clo/profile/extract/route.ts"), "utf8");
    expect(source).toMatch(/extracted_constraints = NULL/);
    expect(source).toMatch(/ppm_constraints = NULL/);
  });
});
