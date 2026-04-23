/**
 * N1 Waterfall Replay Harness.
 *
 * Runs the projection engine for one period and compares each engine-emitted
 * bucket against the trustee's realized waterfall step amounts. Produces a
 * delta table sorted by absolute delta (descending) so the top rows are the
 * engine's worst drift points — the next debugging targets.
 *
 * Fail-loud semantics: tolerances are set to TARGET (post-B3 day-count fix)
 * levels from day one. The Vitest CI gate therefore FAILS on the current
 * pre-Sprint-1 engine, exposing every drift in the output delta table.
 * Sprint 1 closes drifts progressively to green; Sprint 2 handles the
 * compositional-EoD and post-accel drifts.
 *
 * See /Users/solal/.claude/plans/clo-modeling-correctness-plan.md §N1.
 */

import { runProjection, type ProjectionInputs, type PeriodResult } from "./projection";
import type { BacktestInputs } from "./backtest-types";
import {
  normalizePpmStepCode,
  ENGINE_BUCKET_TO_PPM,
  type EngineBucket,
  type PpmInterestStep,
} from "./ppm-step-map";

// ============================================================================
// Per-step tolerance bands — FAIL-LOUD
//
// These are the institutional TARGET tolerances (post-B3 day-count precision).
// On the current pre-Sprint-1 engine, several steps (Class A/B/C/D/E/F interest,
// sub distribution) drift beyond these. That's intentional: the harness FAILS
// and the delta table shows exactly which steps need fixing.
//
// Derivation: steps driven by a single arithmetic path (Issuer Profit €250,
// Trustee fee) have near-deterministic precision. Tranche interest depends
// on Actual/360 day-count; ~€1 precision expected post-B3. Sub distribution
// compounds all upstream errors; widest tolerance.
// ============================================================================

export const STEP_TOLERANCES_TARGET: Record<EngineBucket, number> = {
  // --- Engine-does-not-model steps (Infinity — delta shown but doesn't fail CI) ---
  // These are documented gaps in the known-issues ledger. The engine emits 0
  // deliberately; trustee actuals can be any amount. Surfacing the delta is
  // valuable for audit visibility but failing the test on them is noise.
  taxes: Infinity,                   // step a.i      — KI-01 (Issuer taxes not modeled)
  issuerProfit: Infinity,            // step a.ii     — KI-01 (€250/period immaterial)
  expenseReserve: Infinity,          // step d        — KI-02 (CM discretionary, usually 0)
  effectiveDateRating: Infinity,     // step v        — KI-03 (inactive post-ramp)
  defaultedHedgeTermination: Infinity, // step aa     — KI-06 (hedge-default-only)
  supplementalReserve: Infinity,     // step bb       — KI-05 (CM discretionary)
  trusteeOverflow: Infinity,         // step y        — pre-C3 always 0 by design
  adminOverflow: Infinity,           // step z        — pre-C3 always 0 by design

  // --- Steps the engine DOES model; tight TARGET tolerances (fail-loud) ---
  trusteeFeesPaid: 10,               // steps b + c   — pre-fill gap; fails until Sprint 3 / C3
  seniorMgmtFeePaid: 100,            // step e        — day-count sensitive; fails until Sprint 1 / B3
  hedgePaymentPaid: 50,              // step f
  classA_interest: 1,                // step g        — tightest post-B3
  classB_interest: 1,                // step h
  ocCure_AB: 1000,                   // step i        — compounds OC numerator drift
  classC_current: 1,                 // step j
  classC_deferred: 50,               // step k        — usually zero
  ocCure_C: 1000,                    // step l
  classD_current: 1,                 // step m
  classD_deferred: 50,               // step n
  ocCure_D: 1000,                    // step o
  classE_current: 1,                 // step p
  classE_deferred: 50,               // step q
  pvCure_E: 1000,                    // step r
  classF_current: 1,                 // step s
  classF_deferred: 50,               // step t
  pvCure_F: 1000,                    // step u
  reinvOcDiversion: 1000,            // step w
  subMgmtFeePaid: 500,               // step x        — fails until B3 day-count; base may also need Sprint 3 / C3 verification
  incentiveFeePaid: 500,             // step cc
  subDistribution: 1000,             // step dd       — accumulates upstream errors
};

// ============================================================================
// Types
// ============================================================================

export interface StepDelta {
  /** Engine-side bucket identifier (e.g., "classA_interest"). */
  engineBucket: EngineBucket;
  /** PPM step codes covered by this bucket (e.g., ["b", "c"] for trusteeFeesPaid). */
  ppmSteps: readonly PpmInterestStep[];
  /** Human description joining trustee descriptions, e.g., "(B); (C)". */
  description: string;
  /** Trustee's realized amount (sum of amountPaid across covered PPM steps). */
  actual: number;
  /** Engine's emitted amount. */
  projected: number;
  /** projected − actual. Positive = engine over-pays vs trustee. */
  delta: number;
  absDelta: number;
  tolerance: number;
  withinTolerance: boolean;
}

export interface HarnessResult {
  /** Trustee report/payment date the harness replayed (for display). */
  periodDate: string | null;
  /** All 30 engine buckets, sorted by absDelta descending. Top rows are worst drifts. */
  steps: StepDelta[];
  /** True iff every step is within its tolerance band. */
  allWithinTolerance: boolean;
  /** Worst drift in absolute euros. */
  maxAbsDelta: number;
  /** Engine bucket for the worst drift. */
  maxAbsDeltaBucket: EngineBucket | null;
  /** Trustee waterfall descriptions that did not match any canonical PPM step
   *  code. Present only when ≥1 description was dropped from the replay —
   *  a signal that ppm-step-map.ts needs extending for a new trustee format. */
  unmappedTrusteeDescriptions: string[];
  /** Summary stats for report headers / logging. */
  summary: {
    stepsWithinTolerance: number;
    stepsOutOfTolerance: number;
    stepsCount: number;
    sumAbsDelta: number;
  };
}

// ============================================================================
// Harness runner
// ============================================================================

/**
 * Compare engine output for period 1 against trustee realized waterfall data.
 *
 * The engine is run via `runProjection(projectionInputs).periods[0]` — we run
 * the full forward projection and extract the first period. This avoids
 * surgery on the engine's period loop; the wasted forward computation is
 * ~milliseconds per call.
 *
 * @param projectionInputs - pre-built engine inputs (from `buildFromResolved`).
 * @param backtest - trustee realized data for the same period.
 * @param tolerances - per-step tolerance bands (defaults to STEP_TOLERANCES_TARGET).
 */
export function runBacktestHarness(
  projectionInputs: ProjectionInputs,
  backtest: BacktestInputs,
  tolerances: Record<EngineBucket, number> = STEP_TOLERANCES_TARGET,
): HarnessResult {
  const result = runProjection(projectionInputs);
  if (result.periods.length === 0) {
    throw new Error(
      "Backtest harness: runProjection returned zero periods. " +
      "Check ProjectionInputs.maturityDate vs currentDate — the engine needs at least one forward quarter."
    );
  }
  const p1: PeriodResult = result.periods[0];

  // Sum trustee amountPaid grouped by canonical PPM step code.
  // Track unmapped descriptions (non-summary, non-empty) — silent drop masks
  // data-quality issues when a new trustee's format doesn't match the map.
  const trusteeByStep: Partial<Record<PpmInterestStep, number>> = {};
  const descByStep: Partial<Record<PpmInterestStep, string>> = {};
  const unmappedDescriptions: string[] = [];
  for (const step of backtest.waterfallSteps) {
    if (step.waterfallType !== "INTEREST") continue; // N1 scope: interest waterfall
    if (!step.description) continue;
    if (step.description.trim().toLowerCase() === "opening") continue; // trustee summary row
    const canonical = normalizePpmStepCode(step.description);
    if (!canonical) {
      unmappedDescriptions.push(step.description);
      continue;
    }
    trusteeByStep[canonical] = (trusteeByStep[canonical] ?? 0) + (step.amountPaid ?? 0);
    if (!descByStep[canonical]) descByStep[canonical] = step.description;
  }
  if (unmappedDescriptions.length > 0) {
    // Loud console.warn — surfaces in test runs and the UI console. A harness
    // caller that wants programmatic access can read it off HarnessResult.
    console.warn(
      `[backtest-harness] ${unmappedDescriptions.length} trustee waterfall step description(s) did not match any known PPM step code and were dropped from the replay. ` +
        `If this is a new trustee format, extend ppm-step-map.ts normalizePpmStepCode() to handle it. Unmapped: ${unmappedDescriptions.join(", ")}`,
    );
  }

  // Map engine emissions to buckets.
  const engineByBucket = extractEngineBuckets(p1);

  const steps: StepDelta[] = [];
  for (const [bucket, ppmSteps] of Object.entries(ENGINE_BUCKET_TO_PPM) as Array<
    [EngineBucket, readonly PpmInterestStep[]]
  >) {
    const actual = ppmSteps.reduce((sum, s) => sum + (trusteeByStep[s] ?? 0), 0);
    const projected = engineByBucket[bucket] ?? 0;
    const delta = projected - actual;
    const absDelta = Math.abs(delta);
    const tolerance = tolerances[bucket];
    const withinTolerance = absDelta <= tolerance;
    const description = ppmSteps
      .map((s) => descByStep[s] ?? `(${s})`)
      .join("; ");
    steps.push({
      engineBucket: bucket,
      ppmSteps,
      description,
      actual,
      projected,
      delta,
      absDelta,
      tolerance,
      withinTolerance,
    });
  }

  // Sort by absDelta descending — worst drifts at the top.
  steps.sort((a, b) => b.absDelta - a.absDelta);

  const stepsOutOfTolerance = steps.filter((s) => !s.withinTolerance).length;
  const sumAbsDelta = steps.reduce((s, x) => s + x.absDelta, 0);
  const maxAbsDelta = steps[0]?.absDelta ?? 0;
  const maxAbsDeltaBucket = steps[0]?.engineBucket ?? null;

  return {
    periodDate: backtest.paymentDate ?? backtest.reportDate,
    steps,
    allWithinTolerance: stepsOutOfTolerance === 0,
    maxAbsDelta,
    maxAbsDeltaBucket,
    unmappedTrusteeDescriptions: unmappedDescriptions,
    summary: {
      stepsWithinTolerance: steps.length - stepsOutOfTolerance,
      stepsOutOfTolerance,
      stepsCount: steps.length,
      sumAbsDelta,
    },
  };
}

// ============================================================================
// Engine emission extraction
//
// Maps `PeriodResult` (trancheInterest[], tranchePrincipal[], stepTrace.*) to
// the flat `EngineBucket → number` map the harness compares against.
//
// Class-name conventions: resolver emits "Class A", "Class B-1", "Class B-2",
// "Class C", "Class D", "Class E", "Class F", "Subordinated Notes". Class B
// (step H) aggregates B-1 + B-2 pari passu.
// ============================================================================

function extractEngineBuckets(p: PeriodResult): Partial<Record<EngineBucket, number>> {
  const trancheInterestByClass = new Map<string, number>();
  for (const ti of p.trancheInterest) trancheInterestByClass.set(ti.className, ti.paid);

  // OC cure diversions keyed by tranche rank; aggregate per PPM step.
  // Rank mapping per Euro XV capital structure (ranks from resolver):
  //   A=1, B-1=2, B-2=3 → A/B OC cure fires at boundary rank 3 → step (I)
  //   C=4 → step (L); D=5 → (O); E=6 → (R); F=7 → (U)
  // The engine's `ocCureDiversions[].rank` is the tranche seniorityRank at the
  // boundary — the diversion that happened when THAT class's OC test tripped.
  const diversionsByRank = new Map<number, number>();
  for (const d of p.stepTrace.ocCureDiversions) {
    diversionsByRank.set(d.rank, (diversionsByRank.get(d.rank) ?? 0) + d.amount);
  }
  const ocCure_AB = (diversionsByRank.get(1) ?? 0) + (diversionsByRank.get(2) ?? 0) + (diversionsByRank.get(3) ?? 0);
  const ocCure_C = diversionsByRank.get(4) ?? 0;
  const ocCure_D = diversionsByRank.get(5) ?? 0;
  const pvCure_E = diversionsByRank.get(6) ?? 0;
  const pvCure_F = diversionsByRank.get(7) ?? 0;

  const deferredByClass = p.stepTrace.deferredAccrualByTranche;

  return {
    // Steps the engine doesn't model — always 0 (KI-01/02/03/05/06, and y/z pre-C3).
    taxes: 0,
    issuerProfit: 0,
    expenseReserve: 0,
    effectiveDateRating: 0,
    defaultedHedgeTermination: 0,
    supplementalReserve: 0,
    trusteeOverflow: 0,
    adminOverflow: 0,

    // Fees (from stepTrace)
    trusteeFeesPaid: p.stepTrace.trusteeFeesPaid,
    seniorMgmtFeePaid: p.stepTrace.seniorMgmtFeePaid,
    hedgePaymentPaid: p.stepTrace.hedgePaymentPaid,
    subMgmtFeePaid: p.stepTrace.subMgmtFeePaid,
    incentiveFeePaid: p.stepTrace.incentiveFeeFromInterest,

    // Tranche current interest (from trancheInterest[])
    classA_interest: trancheInterestByClass.get("Class A") ?? 0,
    classB_interest: (trancheInterestByClass.get("Class B-1") ?? 0) + (trancheInterestByClass.get("Class B-2") ?? 0),
    classC_current: trancheInterestByClass.get("Class C") ?? 0,
    classD_current: trancheInterestByClass.get("Class D") ?? 0,
    classE_current: trancheInterestByClass.get("Class E") ?? 0,
    classF_current: trancheInterestByClass.get("Class F") ?? 0,

    // Tranche deferred interest capitalized this period
    classC_deferred: deferredByClass["Class C"] ?? 0,
    classD_deferred: deferredByClass["Class D"] ?? 0,
    classE_deferred: deferredByClass["Class E"] ?? 0,
    classF_deferred: deferredByClass["Class F"] ?? 0,

    // OC/PV cure diversions by class
    ocCure_AB,
    ocCure_C,
    ocCure_D,
    pvCure_E,
    pvCure_F,

    // Reinvestment OC diversion (step W)
    reinvOcDiversion: p.stepTrace.reinvOcDiversion,

    // Subordinated note distribution (step DD — interest residual to sub)
    subDistribution: p.stepTrace.equityFromInterest,
  };
}

// ============================================================================
// Pretty-print delta table (for test failures and CLI)
// ============================================================================

/** Render a harness result as a markdown-compatible table string. Useful for
 *  Vitest console.log on failure. */
export function formatHarnessTable(result: HarnessResult, topN?: number): string {
  const rows = topN != null ? result.steps.slice(0, topN) : result.steps;
  const lines: string[] = [];
  lines.push(`Waterfall replay — ${result.periodDate ?? "(no date)"}`);
  lines.push(
    `  ${result.summary.stepsWithinTolerance}/${result.summary.stepsCount} steps within tolerance, ` +
      `max drift €${result.maxAbsDelta.toFixed(2)} at ${result.maxAbsDeltaBucket ?? "(none)"}, ` +
      `sum |δ| €${result.summary.sumAbsDelta.toFixed(2)}`
  );
  lines.push("");
  lines.push(
    ["Bucket", "PPM steps", "Actual (€)", "Projected (€)", "Delta (€)", "Tol (€)", "OK"].join(" | ")
  );
  lines.push("---|---|---|---|---|---|---");
  for (const s of rows) {
    lines.push(
      [
        s.engineBucket,
        s.ppmSteps.join("+"),
        s.actual.toFixed(2),
        s.projected.toFixed(2),
        s.delta.toFixed(2),
        s.tolerance.toFixed(2),
        s.withinTolerance ? "✓" : "✗",
      ].join(" | ")
    );
  }
  return lines.join("\n");
}
