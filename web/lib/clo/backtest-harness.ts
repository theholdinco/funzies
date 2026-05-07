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
  taxes: 100,                        // step a.i      — drift should be day-count residual only
  issuerProfit: 1,                   // step a.ii     — fixed €250/period, engine ties to the cent
  expenseReserve: Infinity,          // step d        — KI-02 (CM discretionary, usually 0)
  effectiveDateRating: Infinity,     // step v        — KI-03 (inactive post-ramp)
  defaultedHedgeTermination: Infinity, // step aa     — KI-06 (hedge-default-only)
  supplementalReserve: Infinity,     // step bb       — KI-05 (CM discretionary)
  trusteeOverflow: Infinity,         // step y        — only fires when observed > cap
  adminOverflow: Infinity,           // step z        — only fires when observed > cap
  reinvestmentBlockedCompliance: Infinity, // C1 — no trustee analogue; audit-only visibility

  // --- Steps the engine DOES model; tight TARGET tolerances (fail-loud) ---
  // These are POST-CLOSURE targets (what we'd expect once day-count and
  // harness-period-mismatch close). Current residual drift is tracked by
  // `failsWithMagnitude` markers in n1-correctness with explicit expected
  // magnitudes — those are the regression gates; these are the target
  // magnitudes the UI delta table renders red against until closure lands.
  // Calibrating a tolerance to mask current-observed drift would be
  // test-theater (the Sprint 0 anti-pattern: "tolerance copied from actual
  // output is not a tolerance").
  trusteeFeesPaid: 50,               // step b        — will go green post-B3 day-count fix
  adminFeesPaid: 50,                 // step c        — red until B3 closes day-count (observed ~€709; tracked in n1 admin marker)
  seniorMgmtFeePaid: 100,            // step e        — day-count sensitive; fails until Sprint 1 / B3
  hedgePaymentPaid: 50,              // step f
  stepG_interest: 1,                 // step g        — Class A interest + Class X amort merged (pari-passu pro-rata per PPM); tightest post-B3
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
  /** Engine-side bucket identifier (e.g., "stepG_interest"). */
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
  const engineByBucket = extractEngineBuckets(p1, projectionInputs);

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
// Tranche identity is rank-based, NOT className-based — per CLAUDE.md
// "Don't overfit to a single deal". Non-amortising debt tranches are
// grouped by unique `seniorityRank` (sorted ascending); pari-passu tranches
// at the same rank populate the same tier. Each tier maps to a row in
// `CLASS_TIER_LAYOUT` below, which spells out the tier→bucket mapping in
// one place.
// ============================================================================

/**
 * Per-tier harness bucket layout. Each tier in the deal's debt-tranche
 * structure (sorted by ascending `seniorityRank`) maps to one row here:
 *
 *   - `interestBucket`: sum of trancheInterest paid for tranches at this tier
 *   - `deferredBucket`: sum of deferred-accrual amounts (null when the tier
 *     is non-deferrable per PPM — i.e., Class A and Class B)
 *   - `cureBucket`: failing-OC-trigger diversion routed here when the trigger
 *     covers this tier's rank. Set to "ocCure_AB" on tiers 0 and 1 because
 *     PPM step (I) pools cures at the A/B boundary; tiers 2+ get their own
 *     dedicated cure step (L)/(O)/(R)/(U).
 *
 * 6-tier cap is structural: PPM step letters G–U enumerate exactly six
 * letter classes' worth of interest/deferred/cure steps; (V) onward are
 * non-class steps (Effective Date Rating Event, Reinvestment OC, Sub Mgmt
 * Fee, …). A deal with 7+ debt tiers would not fit any standard CLO PPM
 * waterfall vocabulary, so the harness fails loud rather than silently
 * dropping surplus tiers — see `MAX_SUPPORTED_TIERS` check below.
 */
const CLASS_TIER_LAYOUT: ReadonlyArray<{
  interestBucket: EngineBucket;
  deferredBucket: EngineBucket | null;
  cureBucket: EngineBucket;
}> = [
  { interestBucket: "stepG_interest",  deferredBucket: null,              cureBucket: "ocCure_AB" }, // tier 0 (Class A)
  { interestBucket: "classB_interest", deferredBucket: null,              cureBucket: "ocCure_AB" }, // tier 1 (Class B)
  { interestBucket: "classC_current",  deferredBucket: "classC_deferred", cureBucket: "ocCure_C"  }, // tier 2 (Class C)
  { interestBucket: "classD_current",  deferredBucket: "classD_deferred", cureBucket: "ocCure_D"  }, // tier 3 (Class D)
  { interestBucket: "classE_current",  deferredBucket: "classE_deferred", cureBucket: "pvCure_E"  }, // tier 4 (Class E)
  { interestBucket: "classF_current",  deferredBucket: "classF_deferred", cureBucket: "pvCure_F"  }, // tier 5 (Class F)
];
const MAX_SUPPORTED_TIERS = CLASS_TIER_LAYOUT.length;

function extractEngineBuckets(
  p: PeriodResult,
  inputs: ProjectionInputs,
): Partial<Record<EngineBucket, number>> {
  const trancheInterestByClass = new Map<string, number>();
  for (const ti of p.trancheInterest) trancheInterestByClass.set(ti.className, ti.paid);

  // KI-07 closure: source from deferredPaydownByTranche (cash-paid, mirrors
  // trustee step (K) semantics) rather than deferredAccrualByTranche (PIK
  // accrual = new debt added, NOT a cash event and NOT comparable to step
  // (K)). Both fields are zero on Euro XV today (no deferred state) so the
  // re-route is bit-identical on the current N1 harness; under stress it's
  // load-bearing.
  const deferredByClass = p.stepTrace.deferredPaydownByTranche;

  // Build tier groups: non-amortising debt tranches, grouped by unique
  // seniorityRank, sorted ascending. Pari-passu pairs share a tier.
  const debtTranches = inputs.tranches
    .filter((t) => !t.isIncomeNote && !t.isAmortising)
    .slice()
    .sort((a, b) => a.seniorityRank - b.seniorityRank);
  const tierByRank = new Map<number, typeof debtTranches>();
  for (const t of debtTranches) {
    const existing = tierByRank.get(t.seniorityRank);
    if (existing) existing.push(t);
    else tierByRank.set(t.seniorityRank, [t]);
  }
  const tiers = Array.from(tierByRank.values());

  if (tiers.length > MAX_SUPPORTED_TIERS) {
    throw new Error(
      `[backtest-harness] deal has ${tiers.length} non-amortising debt tiers; ` +
        `harness supports up to ${MAX_SUPPORTED_TIERS} (PPM step letters G–U exhaust at tier ${MAX_SUPPORTED_TIERS - 1}). ` +
        `Extending requires adding new EngineBucket entries, new PpmInterestStep letters, and a new CLASS_TIER_LAYOUT row — ` +
        `but the PPM waterfall vocabulary itself caps at 6 letter classes (A–F), so this is unlikely to be the right fix. ` +
        `Investigate whether the deal's tranche structure is being modeled correctly.`,
    );
  }

  // OC cure diversions keyed by failing trigger rank. The engine sets
  // ocCureDiversions[].rank = ocTriggers[].rank for the failing trigger.
  const diversionsByRank = new Map<number, number>();
  for (const d of p.stepTrace.ocCureDiversions) {
    diversionsByRank.set(d.rank, (diversionsByRank.get(d.rank) ?? 0) + d.amount);
  }

  // Build class-tier buckets from the layout. Iterating once over all tiers
  // populates interest/deferred/cure entries; tier 0's interest entry also
  // accumulates Class X amort (PPM step G is pari-passu Class A interest +
  // Class X amort).
  const classBuckets: Partial<Record<EngineBucket, number>> = {};
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const layout = CLASS_TIER_LAYOUT[i];
    const interestPaid = tier.reduce((s, t) => s + (trancheInterestByClass.get(t.className) ?? 0), 0);
    const interestExtra = i === 0 ? p.stepTrace.classXAmortFromInterest : 0;
    classBuckets[layout.interestBucket] = interestPaid + interestExtra;
    if (layout.deferredBucket !== null) {
      classBuckets[layout.deferredBucket] = tier.reduce((s, t) => s + (deferredByClass[t.className] ?? 0), 0);
    }
    const cureAtThisTier = tier.reduce((s, t) => s + (diversionsByRank.get(t.seniorityRank) ?? 0), 0);
    classBuckets[layout.cureBucket] = (classBuckets[layout.cureBucket] ?? 0) + cureAtThisTier;
  }
  // Ensure every layout slot is at least 0 (so the harness emits a row for
  // each, even when the deal has fewer tiers than the layout supports).
  for (const layout of CLASS_TIER_LAYOUT) {
    classBuckets[layout.interestBucket] = classBuckets[layout.interestBucket] ?? 0;
    if (layout.deferredBucket !== null) {
      classBuckets[layout.deferredBucket] = classBuckets[layout.deferredBucket] ?? 0;
    }
    classBuckets[layout.cureBucket] = classBuckets[layout.cureBucket] ?? 0;
  }

  return {
    // Taxes: now emitted by the engine when taxesBps is set.
    taxes: p.stepTrace.taxes ?? 0,
    // Issuer profit: now emitted when issuerProfitAmount is set.
    issuerProfit: p.stepTrace.issuerProfit ?? 0,
    // Steps the engine still doesn't model — KI-02/03/05/06.
    expenseReserve: 0,
    effectiveDateRating: 0,
    defaultedHedgeTermination: 0,
    supplementalReserve: 0,

    // Fees (from stepTrace) — C3 split surfaces (B)/(C)/(Y)/(Z) as four buckets
    trusteeFeesPaid: p.stepTrace.trusteeFeesPaid,     // PPM (B)
    adminFeesPaid: p.stepTrace.adminFeesPaid,         // PPM (C)
    trusteeOverflow: p.stepTrace.trusteeOverflowPaid, // PPM (Y)
    adminOverflow: p.stepTrace.adminOverflowPaid,     // PPM (Z)
    seniorMgmtFeePaid: p.stepTrace.seniorMgmtFeePaid,
    hedgePaymentPaid: p.stepTrace.hedgePaymentPaid,
    subMgmtFeePaid: p.stepTrace.subMgmtFeePaid,
    incentiveFeePaid: p.stepTrace.incentiveFeeFromInterest,

    // Class-tier buckets (interest/deferred/cure) — driven by CLASS_TIER_LAYOUT.
    ...classBuckets,

    // Reinvestment OC diversion (step W)
    reinvOcDiversion: p.stepTrace.reinvOcDiversion,

    // Subordinated note distribution (step DD — interest residual to sub)
    subDistribution: p.stepTrace.equityFromInterest,

    // C1 — reinvestment blocked by compliance enforcement. No trustee step;
    // actual will be 0 (no PPM codes), engine projects the block amount.
    reinvestmentBlockedCompliance: p.stepTrace.reinvestmentBlockedCompliance,
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
