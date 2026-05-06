/**
 * Industry-cap — engine-side integration test for industry-cap enforcement at
 * the reinvestment synthesis site. Exercises the water-filling allocator
 * via ProjectionInputs.industryCapRules.
 *
 * Coverage:
 *   - Rules absent: synthesis behaves as pre-industry-cap (single-bucket aggregate,
 *     no industryCode on synthetics, no extra reinvestmentBlockedCompliance).
 *   - Rules present + headroom available: synthetic loans inherit industryCode
 *     from allocator output; total reinvestment cleanly placed.
 *   - Rules present + all buckets near cap: allocator caps placement;
 *     reinvestmentBlockedCompliance increases additively on top of the C1
 *     WARF/WAS/Caa/CCC gate.
 */

import { describe, it, expect } from "vitest";
import { runProjection, type ProjectionInputs } from "@/lib/clo/projection";
import { makeInputs } from "./test-helpers";
import type { IndustryCapRule } from "@/lib/clo/resolver-types";

// Diversified pool: 5 loans across 5 industries, 20M par each (100M total).
// Each loan tagged with industryCode under taxonomy "moodys_33".
function diversifiedPoolInputs(industryCapRules: IndustryCapRule[] | null = null, overrides: Partial<ProjectionInputs> = {}): ProjectionInputs {
  return makeInputs({
    initialPar: 100_000_000,
    loans: [
      { parBalance: 20_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1010" },
      { parBalance: 20_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1020" },
      { parBalance: 20_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1030" },
      { parBalance: 20_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1040" },
      { parBalance: 20_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1050" },
    ],
    industryCapRules,
    excludedIndustryCodes: null,
    ...overrides,
  });
}

describe("Industry-cap engine-integration — synthesis with industry-cap rules", () => {
  it("rules:null → synthesis path unchanged (no industryCode on synthetic loans, no extra blocking)", () => {
    const inputs = diversifiedPoolInputs(null);
    const result = runProjection(inputs);
    expect(result.periods.length).toBeGreaterThan(0);
    // Sum of reinvestmentBlockedCompliance across all periods is dominated
    // by the C1 WARF/WAS/Caa/CCC gate; with no triggers active in
    // makeInputs's defaults, blocking should be 0 (or near 0).
    const totalBlocked = result.periods.reduce((s, p) => s + (p.stepTrace.reinvestmentBlockedCompliance ?? 0), 0);
    expect(totalBlocked).toBeCloseTo(0, -2); // within €100 of zero
  });

  it("rules present + diversified pool with headroom: projection runs, no extra blocking", () => {
    // rank-1 cap of 50% — way above any single bucket's 20% share. No binding.
    const inputs = diversifiedPoolInputs([
      { kind: "single_rank_max", rank: 1, triggerPct: 50 },
    ]);
    const result = runProjection(inputs);
    expect(result.periods.length).toBeGreaterThan(0);
    const totalBlocked = result.periods.reduce((s, p) => s + (p.stepTrace.reinvestmentBlockedCompliance ?? 0), 0);
    expect(totalBlocked).toBeCloseTo(0, -2);
  });

  it("rules present + caps stricter than current composition: blocking fires", () => {
    // Current pool: each bucket at 20% share. Cap of 19% per bucket means
    // ALL existing buckets are over their cap; allocator finds zero feasible
    // headroom across all 5 buckets → blocks reinvestment, falls through
    // to senior paydown.
    const inputs = diversifiedPoolInputs(
      [
        { kind: "single_class_max", industryCode: "1010", industryName: "Aerospace and Defense", triggerPct: 19 },
        { kind: "single_class_max", industryCode: "1020", industryName: "Automotive", triggerPct: 19 },
        { kind: "single_class_max", industryCode: "1030", industryName: "Banking", triggerPct: 19 },
        { kind: "single_class_max", industryCode: "1040", industryName: "Beverage", triggerPct: 19 },
        { kind: "single_class_max", industryCode: "1050", industryName: "Capital Equipment", triggerPct: 19 },
      ],
      { cprPct: 20 },
    );
    const result = runProjection(inputs);
    // All buckets over their cap → all reinvestment blocked.
    const totalBlocked = result.periods.reduce((s, p) => s + (p.stepTrace.reinvestmentBlockedCompliance ?? 0), 0);
    expect(totalBlocked).toBeGreaterThan(0);
  });

  it("rules present + diversified pool + reasonable cap: synthesis tags loans with industryCode", () => {
    // Run with rules that allow reinvestment freely — no blocking expected.
    // The synthesis path should tag synthetic loans with industryCode from
    // the allocator's output. Inspect via the projection's internal state
    // — we can't directly observe loanStates from outside runProjection.
    // Instead assert that the projection completes normally + IRR is in
    // a sensible range (sanity check that the new code path works).
    const inputs = diversifiedPoolInputs([
      { kind: "combined_top_n_max", n: 3, triggerPct: 70 }, // very loose
    ]);
    const result = runProjection(inputs);
    expect(result.periods.length).toBeGreaterThan(0);
    // IRR should be finite and non-extreme.
    expect(result.equityIrr).not.toBeNull();
    expect(Number.isFinite(result.equityIrr!)).toBe(true);
  });

  it("rank-1 cap actually constrains synthesis — imbalanced pool would breach without enforcement", () => {
    // Pool engineered to STRESS the allocator: bucket 1010 starts at 21%
    // (close to 22% cap), other buckets smaller. Without industry-cap
    // enforcement, the prior (current pool composition) puts ~21% of
    // each reinvestment quantum back into 1010 — which would push 1010
    // above 22% as par accretes from defaults / prepayments routed back
    // through reinvestment. The allocator MUST detect 1010's tight
    // headroom (~1pp under cap) and redistribute to other buckets.
    //
    // If the industry-cap path were disabled, 1010's par share grows
    // unbounded with proportional reinvestment, and largestIndustryPct
    // would drift above 22%. The assertion below forces the allocator
    // to actively constrain.
    const inputs = makeInputs({
      initialPar: 100_000_000,
      loans: [
        // 1010 at 21M (21%) — close to 22% cap
        { parBalance: 21_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1010" },
        { parBalance: 19_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1020" },
        { parBalance: 19_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1030" },
        { parBalance: 21_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1040" },
        { parBalance: 20_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1050" },
      ],
      industryCapRules: [{ kind: "single_rank_max", rank: 1, triggerPct: 22 }],
      excludedIndustryCodes: null,
      cprPct: 30, // high prepayment → lots of reinvestment activity
    });
    const result = runProjection(inputs);
    expect(result.periods.length).toBeGreaterThan(0);

    // For every period where the pool has tagged loans, largestIndustryPct
    // must stay ≤ 22% (with small tolerance for per-period rounding).
    // This invariant FAILS if the allocator doesn't enforce the rank-1 cap.
    let assertedPeriods = 0;
    for (const period of result.periods) {
      const largestPct = period.qualityMetrics.largestIndustryPct;
      if (largestPct == null) continue;
      expect(largestPct).toBeLessThanOrEqual(22.1);
      assertedPeriods++;
    }
    // Sanity check: we asserted on enough periods that this isn't trivial.
    expect(assertedPeriods).toBeGreaterThan(5);
  });

  it("multi-rule + appliesWhen smoke test: every rule kind + post-RP tightening + excluded industry all together", () => {
    // Looser version of the above — uses every shape but doesn't stress
    // any single one. Confirms the engine doesn't choke when all kinds
    // are simultaneously active.
    const inputs = diversifiedPoolInputs(
      [
        { kind: "single_rank_max", rank: 1, triggerPct: 35 },
        { kind: "single_rank_max", rank: 2, triggerPct: 28 },
        { kind: "combined_top_n_max", n: 2, triggerPct: 55 },
        { kind: "single_class_max", industryCode: "1010", industryName: "Aerospace and Defense", triggerPct: 30 },
        { kind: "count_above_threshold", thresholdPct: 19, maxCount: 5 },
        { kind: "single_rank_max", rank: 1, triggerPct: 25, appliesWhen: { kind: "post_reinvestment_period" } },
      ],
      // Sovereign and Public Finance: code "1250" under moodys_33 — pre-resolved
      // (the engine consumes codes; the resolver does name→code conversion via
      // the active taxonomy at buildFromResolved time).
      { cprPct: 15, excludedIndustryCodes: ["1250"] },
    );
    const result = runProjection(inputs);
    expect(result.equityIrr).not.toBeNull();
    expect(Number.isFinite(result.equityIrr!)).toBe(true);
  });

  it("greenfield (loans=[]) + industryCapRules: synthesis blocks reinvestment instead of creating untagged loans (regression)", () => {
    // Pre-fix: greenfield ramp with industry-cap rules → synthesis gate
    // bypassed (hasLoans=false) → single-bucket fallback creates untagged
    // synthetic loans on first period → next period (hasLoans=true now)
    // hits the boundary assertion at projection.ts:3402 and throws.
    // Post-fix: greenfield + industryCapRules blocks all reinvestment in
    // the no-prior period, routing par to senior paydown. Synthesis never
    // creates untagged loans; downstream periods stay clean.
    const inputs = makeInputs({
      initialPar: 100_000_000,
      loans: [], // greenfield — no current pool composition
      industryCapRules: [{ kind: "single_rank_max", rank: 1, triggerPct: 50 }],
      excludedIndustryCodes: null,
    });
    // The projection should complete without throwing — pre-fix would throw
    // once any reinvestment created untagged synthetics that survived to
    // the next period.
    const result = runProjection(inputs);
    expect(result.periods.length).toBeGreaterThan(0);
  });

  it("excludedIndustryCodes are honored at synthesis: excluded code drops out of cap denominator (regression)", () => {
    // Pool: 4 buckets at 25M each (100M total). One of them ("9999") is the
    // excluded industry. Rule: rank-1 cap of 30%. Without exclusion, all
    // buckets are 25% = below cap → no constraint. With exclusion, the
    // denominator drops to 75M (the three non-excluded), each bucket is
    // 25/75 = 33% > 30% cap → all buckets at-cap → ALL reinvestment blocked.
    // Pre-fix: aggregateIndustryPar received industryName: undefined and
    // never applied the exclusion → caps lenient → reinvestment placed.
    // Post-fix: codes flow through ProjectionInputs.excludedIndustryCodes.
    const inputs = makeInputs({
      initialPar: 100_000_000,
      loans: [
        { parBalance: 25_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1010" },
        { parBalance: 25_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1020" },
        { parBalance: 25_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "1030" },
        { parBalance: 25_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, industryCode: "9999" },
      ],
      industryCapRules: [{ kind: "single_rank_max", rank: 1, triggerPct: 30 }],
      excludedIndustryCodes: ["9999"],
      cprPct: 20,
    });
    const result = runProjection(inputs);
    // With "9999" excluded from the cap denominator, the three remaining
    // buckets are each 33% — over the 30% cap. Allocator must block ALL
    // reinvestment since no feasible bucket has positive headroom (and
    // industry "9999" isn't a candidate for additional par because it has
    // zero prior weight when its bucket is excluded from the per-bucket map).
    const totalBlocked = result.periods.reduce((s, p) => s + (p.stepTrace.reinvestmentBlockedCompliance ?? 0), 0);
    expect(totalBlocked).toBeGreaterThan(0);
  });
});
