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
 *   PREFILLED FROM TRUSTEE HISTORY:
 *     - trusteeFeeBps/adminFeeBps are back-derived by defaultsFromResolved
 *       from the trustee waterfall. The harness is a forward projection
 *       from the Q1 snapshot, so this is a historical-state prefill, not
 *       the circular "match this exact payment" pin that earlier versions
 *       avoided.
 *
 * See web/docs/clo-model-known-issues.md for the ledger. Each `failsWithMagnitude`
 * marker names its KI entry so ledger ↔ test is a two-way lookup.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runBacktestHarness, formatHarnessTable } from "@/lib/clo/backtest-harness";
import { buildBacktestInputs } from "@/lib/clo/backtest-types";
import { buildFromResolved, defaultsFromResolved } from "@/lib/clo/build-projection-inputs";
import { runProjection } from "@/lib/clo/projection";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";
import { failsWithMagnitude } from "./fails-with-magnitude";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof buildBacktestInputs>[0];
};

// ----------------------------------------------------------------------------
// Run the harness once; each per-bucket test reads from the result.
//
// Post-D3: uses `defaultsFromResolved(resolved, raw)` for the full pre-fill
// family. This was previously `legitPinnedAssumptions()` which pinned base
// rate + PPM fee rates but intentionally left `trusteeFeeBps` unpinned to
// surface KI-08. D3 closes KI-08's pre-fill portion by back-deriving
// `trusteeFeeBps` from the Q1 waterfall (B + C) — no longer a "circular pin"
// under interpretation B (engine runs Q2, harness compares to Q1, so Q1 data
// as forward estimate is legitimate). Remaining drift = KI-12a period
// mismatch + KI-12b day-count.
// ----------------------------------------------------------------------------

const projectionInputs = buildFromResolved(
  fixture.resolved,
  defaultsFromResolved(fixture.resolved, fixture.raw),
);
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
  // Class A/B/C/D/E/F interest USED to tie out to €1 under /4 because Q1 2026
  // is a 90-day quarter and 90/360 = 1/4 exactly. After B3 ships, /4 is
  // replaced by dayCountFraction, and engine period 1 (Q2 2026 under the
  // harness period mismatch KI-12a = 91 days) diverges from trustee Q1 by
  // one day's accrual per tranche. Markers below are KI-12b — will close
  // when the harness period-mismatch (KI-12a) is fixed.

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
  // Discipline: every per-bucket drift assertion in this block must register
  // through `failsWithMagnitude` with a `ki:` field. Plain `toBeCloseTo` /
  // `toBe` on a pinned drift breaks the ledger ↔ test bijection — a future
  // PR closing the upstream KI cannot find this site by marker grep, and
  // re-baselining becomes a manual hunt. The "green buckets" block above and
  // the "engine-does-not-model" block below legitimately use plain
  // assertions (drift = 0 or pinned to a closed-KI tie-out); this block
  // does not.
  //
  // KI-08 pre-fill closed by D3 + Sprint 3 C3 split separates PPM step (B)
  // trustee from step (C) admin. Total day-count residual is ~€722 (engine
  // 91/360 vs trustee 90/360); split allocates ~€13 to trustee (0.097 bps
  // of combined 5.24) and ~€709 to admin (5.147 bps of combined 5.24).
  // Both close together when KI-12a harness period mismatch lands — same
  // 91/360-vs-90/360 mechanism as the six KI-12b class-interest markers.
  failsWithMagnitude(
    { ki: "KI-08-dayCountResidual-trustee", closesIn: "KI-12a harness fix", expectedDrift: 13, tolerance: 5 },
    "trusteeFeesPaid (PPM step B) KI-08 day-count residual",
    () => drift("trusteeFeesPaid"),
  );
  failsWithMagnitude(
    { ki: "KI-08-dayCountResidual-admin", closesIn: "KI-12a harness fix", expectedDrift: 709, tolerance: 50 },
    "adminFeesPaid (PPM step C) KI-08 day-count residual",
    () => drift("adminFeesPaid"),
  );

  // KI-12b: class-interest day-count drift under harness period mismatch. Each
  // tranche accrues one extra day of interest (91/360 vs 90/360) because
  // engine period 1 is Q2 2026 (91 days) while trustee Q1 2026 is 90 days.
  // These six markers all close together when KI-12a (harness period
  // mismatch) is resolved — NOT when B3 ships, since B3 is already shipped
  // and these drifts are its correct-per-B3 output under a mismatched harness.
  failsWithMagnitude(
    { ki: "KI-12b-classA", closesIn: "KI-12a harness fix", expectedDrift: 25540.56, tolerance: 50 },
    "stepG_interest (Class A interest; Class X amort = 0 on Euro XV) KI-12b day-count drift",
    () => drift("stepG_interest"),
  );
  failsWithMagnitude(
    { ki: "KI-12b-classB", closesIn: "KI-12a harness fix", expectedDrift: 3483.75, tolerance: 50 },
    "classB_interest (B-1 + B-2) KI-12b day-count drift",
    () => drift("classB_interest"),
  );
  failsWithMagnitude(
    { ki: "KI-12b-classC", closesIn: "KI-12a harness fix", expectedDrift: 3715.83, tolerance: 50 },
    "classC_current KI-12b day-count drift",
    () => drift("classC_current"),
  );
  failsWithMagnitude(
    { ki: "KI-12b-classD", closesIn: "KI-12a harness fix", expectedDrift: 4932.81, tolerance: 50 },
    "classD_current KI-12b day-count drift",
    () => drift("classD_current"),
  );
  failsWithMagnitude(
    { ki: "KI-12b-classE", closesIn: "KI-12a harness fix", expectedDrift: 5784.13, tolerance: 50 },
    "classE_current KI-12b day-count drift",
    () => drift("classE_current"),
  );
  failsWithMagnitude(
    { ki: "KI-12b-classF", closesIn: "KI-12a harness fix", expectedDrift: 4527.50, tolerance: 50 },
    "classF_current KI-12b day-count drift",
    () => drift("classF_current"),
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
      // Pre-B3: +€19,559.02 under /4. Post-B3: +€24,354.53 under Actual/360 on
      // engine period 1 (91 days vs trustee 90 days). The €4,795 increase is
      // the one-day extra accrual on Q2 vs Q1 (sub mgmt fee = €493M × 0.35% × 1/360).
      expectedDrift: 24354.53,
      tolerance: 100,
    },
    "subMgmtFeePaid matches trustee within €500",
    () => drift("subMgmtFeePaid"),
  );

  failsWithMagnitude(
    {
      ki: "KI-12a-seniorMgmt",
      closesIn: "Harness period-mismatch fix (rebuild fixture at prior Determination Date — NOT B3)",
      // Pre-B3: +€8,382.44 under /4. Post-B3: +€10,437.66 under Actual/360.
      // Same one-day accrual increase on a smaller rate: €493M × 0.15% × 1/360.
      expectedDrift: 10437.66,
      tolerance: 100,
    },
    "seniorMgmtFeePaid matches trustee within €100",
    () => drift("seniorMgmtFeePaid"),
  );

  // Sub distribution is the residual — cascades from every upstream drift.
  // Net direction: engine sub is slightly LOWER than trustee because the
  // senior/sub mgmt fee-base residuals, class-interest day-count drift,
  // scheduled asset cash timing, and smaller trustee/admin/tax/issuer-profit
  // residual components. Counter-intuitive signs are a hint this is a
  // residual, not an independent effect.
  //
  // MAINTENANCE WARNING: this expectedDrift MUST be re-baselined whenever any
  // upstream KI (01 / 08 / 09 / 10 / 11 / 12a / 12b) closes or its own expected
  // magnitude changes. Also re-baseline on the next live ingest after KI-62
  // sub-fix B: bond par_balance now follows live Commitment, lifting Tele
  // Columbus pool-par contribution by ~€581K (€2.5M → €3.08M). The €581K
  // cascades through fee base + OC denominator + reinvestment composition;
  // the n1 sub-distribution drift will shift outside the €100 tolerance and
  // this marker will fail loud. A stale expected value here either masks a
  // regression (false green) or fabricates one (false red). PR template
  // reminder lives in docs/clo-model-known-issues.md §KI-13.
  failsWithMagnitude(
    {
      ki: "KI-13a-engineMath",
      closesIn: "Progressively as KI-08 / KI-12a / KI-12b close (re-baseline on each)",
      // Sign history: pre-B3 −€607, post-B3 +€20,842, **post-D3 −€44,541**.
      //
      // Why the pre-D3 → post-D3 shift is a clean one-KI delta:
      //   Pre-D3 n1-correctness used legitPinnedAssumptions which ALREADY pinned
      //   baseRate + senior/sub/incentive fees from
      //   resolved.fees + observed EURIBOR. The ONLY field defaultsFromResolved
      //   adds on top is trusteeFeeBps back-derived from Q1 waterfall (KI-08).
      //   So the cascade shift between pre-D3 and post-D3 measurements is purely
      //   KI-08 closure — not a multi-KI compound. Every other drift line
      //   (class interest KI-12b, mgmt fee KI-12a day-count, taxes/issuerProfit
      //   engine deductions) are unchanged between pre-D3 and post-D3.
      //
      // Arithmetic check:
      //   Pre-D3 trusteeFeesPaid drift: −€64,660 (engine 0, trustee 64,660)
      //   Post-D3 trusteeFeesPaid drift: +€722 (engine ~64,660 via back-derive,
      //     trustee 64,660, residual = 91/360 × 5.24bps − 90/360 × 5.24bps
      //     on €493M = ~€721)
      //   Shift on trusteeFeesPaid: +€65,382
      //   Engine now deducts that €65,382 upstream → LESS flows to sub residual
      //   → sub drift shifts by −€65,382
      //   Pre-D3 sub drift +€20,842 − €65,382 = −€44,540 ✓ (measured −€44,540.74)
      //
      // Full post-D3 breakdown vs trustee (all drifts engine − trustee):
      //   interest_collected drift (91/360 vs 90/360 on €493M pool): +€32,577
      //   Σ(class interest KI-12b drifts): +€48,019 (outflow)
      //   Σ(mgmt fee KI-12a day-count drifts): +€34,792 (outflow)
      //   trusteeFee drift: +€722 (KI-08 residual, ~zero)
      //   taxes + issuerProfit drifts: −€6,383 (taxes + issuerProfit, pre-engine-emission)
      //   Σ of non-sub drifts: +€77,150
      //   Sub residual = 32,577 − 77,150 = −€44,573 ✓ (matches measured to €30)
      // Engine now deducts €250 issuer profit per
      // period (PPM step A.ii). Subs receive €250 less → drift more negative
      // by €250. Pre-emission: -€50,742.24. Post-emission: -€50,992.24. Matches
      // engine emission of €250 to the cent (fixed absolute amount, no
      // day-count residual like taxes).
      //
      // **Per-loan day-count exposure cascade re-baseline (−€6,247.38 shift):**
      //   The engine's per-loan day-count dispatch (`loan.dayCountConvention`)
      //   was previously masked on this fixture by `resolved.loans` rows that
      //   omitted the field — every loan silently fell back to actual_360. A
      //   subsequent fixture refresh propagates the actual conventions from
      //   `raw.holdings`, including loans on 30_360 / 30e_360 / actual_365.
      //   On the 92-day period (Mar 9 → Jun 9), 30_360 / 30e_360 give 90/360
      //   (vs 92/360 for actual_360), reducing per-loan interest accrual on
      //   those positions. Less interestCollected → less mgmt fees / class
      //   interest paid → smaller residual to subs → drift shifts more
      //   negative. Pre-regen: -€50,992.24. Post-regen: -€57,239.62.
      //   Δ: -€6,247.38.
      // KI-36 monthly internal ticks reduce residual sub cash relative to the
      // old quarterly engine baseline while leaving upstream bucket markers
      // unchanged. This is a deliberate cascade re-baseline, but the monthly
      // timing delta is not independently decomposed here:
      //   post per-loan DCC: -€57,239.62
      //   post KI-36 monthly clock: -€172,489.98
      //   post asset interest receipt scheduling: -€353,676.36
      //   post schedule consistency/T0 multi-receipt review: -€263,542.20
      //   post duplicate-accrual suppression review: -€260,482.67
      //   post holding accrualEndDate anchor review: -€233,269.05
      //   post inferred opening asset-interest receivable review: -€232,932.00
      //   post same-tick defaulted-share asset-interest writeoff: -€254,223.24
      expectedDrift: -254223.24,
      tolerance: 100,
      closeThreshold: 100,
    },
    "subDistribution total residual matches trustee within €1000",
    () => drift("subDistribution"),
  );

  failsWithMagnitude(
    {
      ki: "KI-13a-engineMath",
      closesIn: "Progressively as KI-08 / KI-12a / KI-12b close (re-baseline on each)",
      expectedDrift: -170_655.81,
      tolerance: 100,
      closeThreshold: 100,
    },
    "subDistribution upstream bridge residual after modeled waterfall drifts",
    () => {
      const upstreamInterestOutflowBuckets = [
        "taxes",
        "issuerProfit",
        "trusteeFeesPaid",
        "adminFeesPaid",
        "seniorMgmtFeePaid",
        "stepG_interest",
        "classB_interest",
        "classC_current",
        "classD_current",
        "classE_current",
        "classF_current",
        "subMgmtFeePaid",
      ];
      const upstreamOutflowDrift = upstreamInterestOutflowBuckets.reduce((sum, bucket) => sum + drift(bucket), 0);

      // Sub distribution is the residual after every modeled interest outflow.
      // This pins the aggregate residual funding drift while deriving the sub
      // bridge from the emitted waterfall rows, so upstream re-baselines fail
      // here unless the residual is reviewed as a cascade.
      return drift("subDistribution") + upstreamOutflowDrift;
    },
  );
});

// ----------------------------------------------------------------------------
// Infinity-tolerance buckets (engine does not model these steps by design).
// These are listed in the KI ledger; their drift values are informational only.
// The correctness test does NOT assert on them — the ledger entry is the
// commitment, not the test.
// ----------------------------------------------------------------------------

describe("N1 correctness — engine-does-not-model steps (KI ledger commitments)", () => {
  it("engine emits taxes (~€6,202), ties to trustee €6,133 within €100", () => {
    // Post-fix: defaultsFromResolved back-derives taxesBps from Q1 step (A)(i)
    // actual (€6,133 / €493M / 4 × 10000 ≈ 0.497 bps). Engine emits
    // ~€6,202 at 91/360 vs trustee €6,133 at 90/360 — ~€69 day-count residual.
    const row = driftsByBucket.get("taxes");
    expect(row?.actual).toBeCloseTo(6133, -1);
    expect(row?.projected).toBeCloseTo(6202, -2);
    expect(Math.abs(row?.delta ?? 0)).toBeLessThan(100);
  });
  it("engine emits €250 issuer profit, ties to trustee to the cent", () => {
    // Post-fix: defaultsFromResolved back-derives issuerProfitAmount from
    // Q1 waterfall step (A)(ii) (€250 regular period). Fixed absolute
    // deduction — no day-count residual (unlike taxes), so drift
    // should tie within €1.
    const row = driftsByBucket.get("issuerProfit");
    expect(row?.actual).toBeCloseTo(250, 0);
    expect(row?.projected).toBeCloseTo(250, 0);
    expect(Math.abs(row?.delta ?? 0)).toBeLessThan(1);
  });
});
