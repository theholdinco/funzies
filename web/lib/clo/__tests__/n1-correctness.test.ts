/**
 * N1 — Engine correctness (per PPM waterfall step) against trustee reality.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PARTNER-FACING TEST.                                                    ║
 * ║  This is the file where the engine's fidelity to trustee-reported         ║
 * ║  waterfall is asserted, step-by-step. Every PPM interest-waterfall       ║
 * ║  step (b through DD) has one correctness check.                          ║
 * ║                                                                          ║
 * ║  Currently-known broken steps are wrapped in `failsWithMagnitude`,        ║
 * ║  which asserts the drift is exactly the documented magnitude (±ε).       ║
 * ║  This pattern catches three cases:                                       ║
 * ║    1. Drift closes (fix lands)          → test fails: "remove marker"    ║
 * ║    2. Drift changes (regression)        → test fails: "investigate"      ║
 * ║    3. Drift stays at documented value   → test passes                    ║
 * ║                                                                          ║
 * ║  When a fix lands, the appropriate failsWithMagnitude marker must be     ║
 * ║  removed AND the KI ledger entry closed. Docs + tests are a bijection.   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Pinning policy (non-circular inputs only):
 *
 *   LEGITIMATE PINS (read externally-authoritative values from the fixture):
 *     - baseRatePct ← raw.trancheSnapshots[*].currentIndexRate (observed EURIBOR;
 *                    equivalent to reading from a rates feed like Bloomberg)
 *     - seniorFeePct, subFeePct, incentiveFeePct, incentiveFeeHurdleIrr
 *       ← resolved.fees (contractual PPM values)
 *
 *   NOT PINNED (would be circular — trustee's payment IS the rate):
 *     - trusteeFeeBps ← "per agreement" per PPM → production default 0.
 *       This leaves the per-agreement fee pre-fill gap exposed (KI-08).
 *
 * See web/docs/clo-model-known-issues.md for the ledger. Each `failsWithMagnitude`
 * marker names its KI entry so ledger ↔ test is a two-way lookup.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runBacktestHarness, formatHarnessTable } from "@/lib/clo/backtest-harness";
import { buildBacktestInputs } from "@/lib/clo/backtest-types";
import { buildFromResolved, DEFAULT_ASSUMPTIONS } from "@/lib/clo/build-projection-inputs";
import { runProjection } from "@/lib/clo/projection";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";
import { failsWithMagnitude } from "./fails-with-magnitude";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof buildBacktestInputs>[0];
};

/** Pin externally-authoritative inputs only. Does NOT pin trusteeFeeBps (would
 *  be circular with Q1 trustee output). */
function legitPinnedAssumptions() {
  const observedBaseRate =
    fixture.raw.trancheSnapshots?.find((s) => s && s.currentIndexRate != null)?.currentIndexRate ?? 2.1;
  return {
    ...DEFAULT_ASSUMPTIONS,
    seniorFeePct: fixture.resolved.fees.seniorFeePct,
    subFeePct: fixture.resolved.fees.subFeePct,
    incentiveFeePct: fixture.resolved.fees.incentiveFeePct,
    incentiveFeeHurdleIrr: fixture.resolved.fees.incentiveFeeHurdleIrr * 100,
    baseRatePct: observedBaseRate,
    // Intentionally NOT pinning trusteeFeeBps — leaves KI-08 gap visible.
  };
}

// ----------------------------------------------------------------------------
// Run the harness once; each per-bucket test reads from the result.
// ----------------------------------------------------------------------------

const projectionInputs = buildFromResolved(fixture.resolved, legitPinnedAssumptions());
const backtest = buildBacktestInputs(fixture.raw);
const harnessResult = runBacktestHarness(projectionInputs, backtest);
const driftsByBucket = new Map(harnessResult.steps.map((s) => [s.engineBucket, s]));

function drift(bucket: string): number {
  const row = driftsByBucket.get(bucket as typeof harnessResult.steps[number]["engineBucket"]);
  if (!row) throw new Error(`Harness did not emit bucket "${bucket}" — check ENGINE_BUCKET_TO_PPM coverage.`);
  return row.delta;
}

// Print the full delta table once so every test run shows the current picture.
// Vitest captures stdout and shows it alongside failure output.
describe("N1 correctness — diagnostic table (not an assertion)", () => {
  it("prints the full delta table for partner-facing diagnostics", () => {
    console.log("\n" + formatHarnessTable(harnessResult));
  });
});

// ----------------------------------------------------------------------------
// Per-bucket correctness assertions.
//
// Each green bucket asserts |drift| < tolerance. Each red bucket is registered
// via failsWithMagnitude with its KI reference.
// ----------------------------------------------------------------------------

describe("N1 correctness — green buckets (engine ties out to trustee)", () => {
  // Interest lines that tie out exactly today under legitimate pinning.
  it("Class A interest matches trustee within €1", () => {
    expect(Math.abs(drift("classA_interest"))).toBeLessThanOrEqual(1);
  });
  it("Class B (B-1 + B-2) interest matches trustee within €1", () => {
    expect(Math.abs(drift("classB_interest"))).toBeLessThanOrEqual(1);
  });
  it("Class C current interest matches trustee within €1", () => {
    expect(Math.abs(drift("classC_current"))).toBeLessThanOrEqual(1);
  });
  it("Class D current interest matches trustee within €1", () => {
    expect(Math.abs(drift("classD_current"))).toBeLessThanOrEqual(1);
  });
  it("Class E current interest matches trustee within €1", () => {
    expect(Math.abs(drift("classE_current"))).toBeLessThanOrEqual(1);
  });
  it("Class F current interest matches trustee within €1", () => {
    expect(Math.abs(drift("classF_current"))).toBeLessThanOrEqual(1);
  });

  // Euro XV Q1 has no deferred interest on any class.
  it("Class C/D/E/F deferred interest is zero (no stress)", () => {
    expect(drift("classC_deferred")).toBe(0);
    expect(drift("classD_deferred")).toBe(0);
    expect(drift("classE_deferred")).toBe(0);
    expect(drift("classF_deferred")).toBe(0);
  });

  // OC/IC cures: zero when passing. Euro XV is passing everything.
  it("OC cure diversions are zero (all tests passing)", () => {
    expect(drift("ocCure_AB")).toBe(0);
    expect(drift("ocCure_C")).toBe(0);
    expect(drift("ocCure_D")).toBe(0);
    expect(drift("pvCure_E")).toBe(0);
    expect(drift("pvCure_F")).toBe(0);
  });

  it("Reinvestment OC diversion is zero (passing test)", () => {
    expect(drift("reinvOcDiversion")).toBe(0);
  });

  it("Hedge payments are zero (no hedge on Euro XV)", () => {
    expect(drift("hedgePaymentPaid")).toBe(0);
  });

  it("Incentive fee is zero (IRR hurdle not yet met)", () => {
    expect(drift("incentiveFeePaid")).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Known-broken buckets. Each is registered via failsWithMagnitude with its KI
// reference, closing sprint, and expected pre-fix magnitude.
//
// When a Sprint 1/3 fix closes a drift, the corresponding failsWithMagnitude
// call MUST be removed and the KI ledger entry closed. The test will alert if
// drift changes (either direction) by more than tolerance.
// ----------------------------------------------------------------------------

describe("N1 correctness — currently broken buckets (documented in KI ledger)", () => {
  // trusteeFeeBps=0 production default; trustee paid €64,660 in Q1.
  failsWithMagnitude(
    {
      ki: "KI-08",
      closesIn: "Sprint 3 / C3 (fee pre-fill from Q1 actuals + cap + trustee/admin split)",
      expectedDrift: -64660.20,
      tolerance: 100,
    },
    "trusteeFeesPaid matches trustee within €10",
    () => drift("trusteeFeesPaid"),
  );

  // N1 harness period mismatch (KI-12a). The harness compares engine's Q2
  // 2026 forward projection (periods[0], since addQuarters(2026-04-01, 1) =
  // 2026-07-01) against trustee's Q1 2026 actuals. Fee drifts are the most
  // visible symptom of this structural mismatch: Q2 fee base is €493.3M
  // (current fixture snapshot) but trustee Q1 fee was computed on €470.9M
  // (cross-verified: sub and senior fees both imply the same base to within
  // €4). The €22.35M delta is NOT Q1 reinvestment growth — Q1 trade activity
  // totals only €0.23M net. Root cause narrowed but not nailed in the
  // fixture; requires reading the Ares XV PPM Aggregate Collateral Balance
  // clause directly. Correct fix is harness-level, not engine-level: rebuild
  // fixture at the prior Determination Date so periods[0] = Q1 replay.
  // See KI-12a ledger entry for full evidence table.
  failsWithMagnitude(
    {
      ki: "KI-12a-subMgmt",
      closesIn: "Harness period-mismatch fix (rebuild fixture at prior Determination Date — NOT B3)",
      expectedDrift: 19559.02,
      tolerance: 100,
    },
    "subMgmtFeePaid matches trustee within €500",
    () => drift("subMgmtFeePaid"),
  );

  failsWithMagnitude(
    {
      ki: "KI-12a-seniorMgmt",
      closesIn: "Harness period-mismatch fix (rebuild fixture at prior Determination Date — NOT B3)",
      expectedDrift: 8382.44,
      tolerance: 100,
    },
    "seniorMgmtFeePaid matches trustee within €100",
    () => drift("seniorMgmtFeePaid"),
  );

  // Sub distribution is the residual — cascades from every upstream drift.
  // Net direction: engine sub is slightly LOWER than trustee because the
  // fee-base over-payment on senior/sub mgmt fees (€27,941 combined, KI-12a) +
  // the incentive-fee circular solver's rounding more than offset the engine's
  // missing trustee fee (€64,660, KI-08). Counter-intuitive signs are a hint
  // this is a residual, not an independent effect.
  //
  // MAINTENANCE WARNING: this expectedDrift MUST be re-baselined whenever any
  // upstream KI (01 / 08 / 09 / 10 / 11 / 12a / 12b) closes or its own expected
  // magnitude changes. A stale expected value here either masks a regression
  // (false green) or fabricates one (false red). PR template reminder lives
  // in docs/clo-model-known-issues.md §KI-13.
  failsWithMagnitude(
    {
      ki: "KI-13a-engineMath",
      closesIn: "Progressively as KI-01 / KI-08 / KI-09 / KI-12a close (re-baseline on each)",
      expectedDrift: -607.93,
      tolerance: 50,
      // |expectedDrift| = 607; tolerance 50. Without an explicit close threshold
      // a partial upstream fix dropping observed to ~40 would fire "CLOSED"
      // falsely. Tighter threshold ensures the close signal only fires when
      // drift genuinely collapses.
      closeThreshold: 5,
    },
    "subDistribution matches trustee within €1000",
    () => drift("subDistribution"),
  );
});

// ----------------------------------------------------------------------------
// Infinity-tolerance buckets (engine does not model these steps by design).
// These are listed in the KI ledger; their drift values are informational only.
// The correctness test does NOT assert on them — the ledger entry is the
// commitment, not the test.
// ----------------------------------------------------------------------------

describe("N1 correctness — engine-does-not-model steps (KI ledger commitments)", () => {
  it("taxes drift is present (KI-09): engine emits 0; trustee collected €6,133", () => {
    // Not a correctness claim — just a sanity check that the trustee value is
    // still the expected magnitude. If this shifts materially, the KI-09 entry
    // needs updating.
    const row = driftsByBucket.get("taxes");
    expect(row?.actual).toBeCloseTo(6133, -1);
  });
  it("issuerProfit drift is present (KI-01): engine emits 0; trustee collected €250", () => {
    const row = driftsByBucket.get("issuerProfit");
    expect(row?.actual).toBeCloseTo(250, 0);
  });
});
