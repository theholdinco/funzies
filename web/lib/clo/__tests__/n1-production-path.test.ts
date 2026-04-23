/**
 * N1 — Engine correctness on the PRODUCTION path (no input pinning).
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  This file exercises what a user actually sees when they load the deal   ║
 * ║  and click "Run projection" with no manual slider overrides. It's the    ║
 * ║  integration test for the pre-fill family (A1 + D3 + baseRate + fees).  ║
 * ║                                                                          ║
 * ║  Correctness is measured against trustee reality with legitimate         ║
 * ║  tolerance. No pinning of any field — the `DEFAULT_ASSUMPTIONS` path is  ║
 * ║  what a user actually sees.                                              ║
 * ║                                                                          ║
 * ║  This file is RED BY DESIGN until the pre-fill family ships. When each   ║
 * ║  pre-fill gap closes, a failsWithMagnitude marker removes and the        ║
 * ║  corresponding bucket goes green.                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Compare with `n1-correctness.test.ts`:
 *   - n1-correctness: legitimate pins for EURIBOR rate + PPM fees. Tests
 *     engine arithmetic. Red on KI-08 (trusteeFeeBps not pinned) + day-count.
 *   - n1-production-path (this file): no pins. Exposes the full user-visible
 *     picture. Red on every pre-fill gap in addition to engine bugs.
 *
 * When `defaultsFromResolved(resolved, raw)` ships per the plan's D3
 * consolidation, the baseRate / fee / recovery-rate pre-fills auto-populate
 * from resolver and raw data. The `DEFAULT_ASSUMPTIONS` path will then converge
 * with `n1-correctness.test.ts`, and most markers here will close.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runBacktestHarness, formatHarnessTable } from "@/lib/clo/backtest-harness";
import { buildBacktestInputs } from "@/lib/clo/backtest-types";
import { buildFromResolved, DEFAULT_ASSUMPTIONS } from "@/lib/clo/build-projection-inputs";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";
import { failsWithMagnitude } from "./fails-with-magnitude";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof buildBacktestInputs>[0];
};

// No pinning — use DEFAULT_ASSUMPTIONS straight. This is what a user sees.
const projectionInputs = buildFromResolved(fixture.resolved, DEFAULT_ASSUMPTIONS);
const backtest = buildBacktestInputs(fixture.raw);
const harnessResult = runBacktestHarness(projectionInputs, backtest);
const driftsByBucket = new Map(harnessResult.steps.map((s) => [s.engineBucket, s]));

function drift(bucket: string): number {
  const row = driftsByBucket.get(bucket as typeof harnessResult.steps[number]["engineBucket"]);
  if (!row) throw new Error(`Harness did not emit bucket "${bucket}"`);
  return row.delta;
}

describe("N1 production path — diagnostic table (not an assertion)", () => {
  it("prints the full delta table for partner-facing diagnostics", () => {
    console.log("\n" + formatHarnessTable(harnessResult));
  });
});

// ----------------------------------------------------------------------------
// Pre-fill-gap drifts. Each represents a real user-visible bug that closes
// when the plan's A1/D3/baseRate/C3 pre-fill family lands.
// ----------------------------------------------------------------------------

describe("N1 production path — pre-fill gap drifts (red by design)", () => {
  // DEFAULT_ASSUMPTIONS.baseRatePct = 2.1% (static). Fixture EURIBOR = 2.016%.
  // Error: ~8.4 bps applied to €310M Class A × 1/4 = ~€65K per period on A alone.
  failsWithMagnitude(
    {
      ki: "KI-10",
      closesIn: "Sprint 1 / baseRate pre-fill (D3 family)",
      expectedDrift: 65100,
      tolerance: 500,
    },
    "Class A interest uses stale default baseRate (2.1%) vs observed EURIBOR (2.016%)",
    () => drift("classA_interest"),
  );

  failsWithMagnitude(
    {
      ki: "KI-10",
      closesIn: "Sprint 1 / baseRate pre-fill (D3 family)",
      expectedDrift: 7087.5,
      tolerance: 200,
    },
    "Class B interest uses stale default baseRate",
    () => drift("classB_interest"),
  );

  failsWithMagnitude(
    {
      ki: "KI-10",
      closesIn: "Sprint 1 / baseRate pre-fill (D3 family)",
      expectedDrift: 6825,
      tolerance: 200,
    },
    "Class C interest uses stale default baseRate",
    () => drift("classC_current"),
  );

  failsWithMagnitude(
    {
      ki: "KI-10",
      closesIn: "Sprint 1 / baseRate pre-fill (D3 family)",
      expectedDrift: 7218.75,
      tolerance: 200,
    },
    "Class D interest uses stale default baseRate",
    () => drift("classD_current"),
  );

  failsWithMagnitude(
    {
      ki: "KI-10",
      closesIn: "Sprint 1 / baseRate pre-fill (D3 family)",
      expectedDrift: 5381.24,
      tolerance: 200,
    },
    "Class E interest uses stale default baseRate",
    () => drift("classE_current"),
  );

  failsWithMagnitude(
    {
      ki: "KI-10",
      closesIn: "Sprint 1 / baseRate pre-fill (D3 family)",
      expectedDrift: 3150,
      tolerance: 200,
    },
    "Class F interest uses stale default baseRate",
    () => drift("classF_current"),
  );

  // DEFAULT_ASSUMPTIONS.seniorFeePct = 0 (not pre-filled from resolved.fees.seniorFeePct = 0.15%)
  failsWithMagnitude(
    {
      ki: "KI-11",
      closesIn: "Sprint 3 / C3 (fee pre-fill family)",
      expectedDrift: -176587.19,
      tolerance: 200,
    },
    "seniorMgmtFee emits 0 (default) vs trustee €176,587",
    () => drift("seniorMgmtFeePaid"),
  );

  // DEFAULT_ASSUMPTIONS.subFeePct = 0 (not pre-filled from resolved.fees.subFeePct = 0.35%)
  failsWithMagnitude(
    {
      ki: "KI-11",
      closesIn: "Sprint 3 / C3 (fee pre-fill family)",
      expectedDrift: -412036.78,
      tolerance: 500,
    },
    "subMgmtFee emits 0 (default) vs trustee €412,037",
    () => drift("subMgmtFeePaid"),
  );

  // KI-08: trusteeFeeBps = 0 default (per-agreement not derived from Q1 actuals).
  failsWithMagnitude(
    {
      ki: "KI-08",
      closesIn: "Sprint 3 / C3 (trustee/admin fee pre-fill from Q1 actuals)",
      expectedDrift: -64660.20,
      tolerance: 100,
    },
    "trusteeFeesPaid matches trustee within €10",
    () => drift("trusteeFeesPaid"),
  );
});

describe("N1 production path — sub distribution cascade", () => {
  // Residual cascading from all upstream drifts. Under no pinning, engine
  // keeps all the missing fee amounts — sub distribution is massively
  // higher than trustee because engine underpays all fees.
  failsWithMagnitude(
    {
      ki: "KI-13b-productionPath",
      closesIn: "Progressively as KI-10 / KI-11 / KI-12a close (re-baseline on each — see KI-13 ledger entry)",
      expectedDrift: 617122.40,
      tolerance: 1000,
    },
    "subDistribution massively over-pays engine-side (pre-fill gaps compound)",
    () => drift("subDistribution"),
  );
});

// Informational — these are not pre-fill gaps but engine-does-not-model entries.
describe("N1 production path — KI-01 / KI-09 engine-does-not-model steps", () => {
  it("taxes drift is present (KI-09): engine emits 0; trustee collected €6,133", () => {
    const row = driftsByBucket.get("taxes");
    expect(row?.actual).toBeCloseTo(6133, -1);
  });
  it("issuerProfit drift is present (KI-01): engine emits 0; trustee collected €250", () => {
    const row = driftsByBucket.get("issuerProfit");
    expect(row?.actual).toBeCloseTo(250, 0);
  });
});
