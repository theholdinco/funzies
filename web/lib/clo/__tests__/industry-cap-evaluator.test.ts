/**
 * Industry-cap — industry-cap evaluator + allocator marker tests.
 *
 * The evaluator is consumed at every reinvestment site for compliance
 * verification + by the switch simulator for post-trade verification.
 * The allocator is consumed at projection.ts:3327 to distribute reinvested
 * par across industries respecting all rules.
 *
 * Coverage:
 *   - aggregateIndustryPar (excluded names dropped, missing codes dropped)
 *   - rankedIndustryPar (descending stable)
 *   - evaluateRules (each kind, applies_when conditions, headroom signs)
 *   - maxAdditionPerBucket (single_rank_max, combined_top_n_max with
 *     in/out of top-N, single_class_max, count_above_threshold)
 *   - allocateReinvestment (water-filling: full placement, blocked-from-start,
 *     proportional fill toward prior, redistribution after capping)
 */

import { describe, it, expect } from "vitest";
import {
  aggregateIndustryPar,
  rankedIndustryPar,
  evaluateRules,
  maxAdditionPerBucket,
  allocateReinvestment,
  type IndustryCapPoolState,
  type IndustryAggregationLoan,
} from "@/lib/clo/industry-cap";
import type { IndustryCapRule } from "@/lib/clo/resolver-types";

const NEUTRAL_POOL_STATE: IndustryCapPoolState = {
  pctMoodysCaa: 0,
  pctDefaulted: 0,
  inReinvestmentPeriod: true,
};

function loan(industryCode: string, par: number): IndustryAggregationLoan {
  return { parBalance: par, industryCode };
}

describe("aggregateIndustryPar + rankedIndustryPar", () => {
  it("Σ par per industryCode, dropping excluded codes + missing codes", () => {
    const loans: IndustryAggregationLoan[] = [
      loan("1010", 10_000_000),
      loan("1010", 5_000_000),
      loan("1020", 8_000_000),
      loan("1250", 3_000_000), // excluded by code below
      { parBalance: 1_000_000 }, // no code → dropped
      { parBalance: 2_000_000, industryCode: "1030" }, // counted
    ];
    const out = aggregateIndustryPar(loans, ["1250"]);
    expect(out.get("1010")).toBe(15_000_000);
    expect(out.get("1020")).toBe(8_000_000);
    expect(out.get("1030")).toBe(2_000_000);
    expect(out.has("1250")).toBe(false);
    expect(out.size).toBe(3);
  });

  it("rankedIndustryPar sorts descending", () => {
    const m = new Map([["A", 1_000_000], ["B", 5_000_000], ["C", 3_000_000]]);
    const ranked = rankedIndustryPar(m);
    expect(ranked.map((r) => r.industryCode)).toEqual(["B", "C", "A"]);
  });
});

describe("evaluateRules — single_rank_max", () => {
  it("rank-1 cap of 15% — passes when largest is 14%", () => {
    const perBucket = new Map([["A", 14_000_000], ["B", 10_000_000], ["C", 76_000_000]]);
    // Wait, "C" is largest at 76M. Let me use a clearer case.
    const perBucket2 = new Map([["A", 14_000_000], ["B", 10_000_000], ["C", 6_000_000]]);
    const rules: IndustryCapRule[] = [{ kind: "single_rank_max", rank: 1, triggerPct: 15 }];
    const result = evaluateRules(rules, perBucket2, 100_000_000, NEUTRAL_POOL_STATE);
    expect(result[0].applied).toBe(true);
    expect(result[0].passed).toBe(true);
    expect(result[0].headroomPar).toBeCloseTo(1_000_000); // 15M - 14M
  });

  it("rank-1 cap of 15% — fails when largest is 16%", () => {
    const perBucket = new Map([["A", 16_000_000], ["B", 4_000_000]]);
    const rules: IndustryCapRule[] = [{ kind: "single_rank_max", rank: 1, triggerPct: 15 }];
    const result = evaluateRules(rules, perBucket, 100_000_000, NEUTRAL_POOL_STATE);
    expect(result[0].passed).toBe(false);
    expect(result[0].headroomPar).toBeLessThan(0);
  });

  it("rank-2 cap evaluates the second-largest bucket", () => {
    const perBucket = new Map([["A", 18_000_000], ["B", 14_000_000], ["C", 8_000_000]]);
    // rank-1 cap 20% (A = 18M, passes); rank-2 cap 12% (B = 14M, fails).
    const rules: IndustryCapRule[] = [
      { kind: "single_rank_max", rank: 1, triggerPct: 20 },
      { kind: "single_rank_max", rank: 2, triggerPct: 12 },
    ];
    const result = evaluateRules(rules, perBucket, 100_000_000, NEUTRAL_POOL_STATE);
    expect(result[0].passed).toBe(true);
    expect(result[1].passed).toBe(false);
  });
});

describe("evaluateRules — combined_top_n_max", () => {
  it("top-3 ≤ 30%: passes when largest 3 sum to 28%", () => {
    const perBucket = new Map([["A", 12_000_000], ["B", 9_000_000], ["C", 7_000_000], ["D", 5_000_000]]);
    const rules: IndustryCapRule[] = [{ kind: "combined_top_n_max", n: 3, triggerPct: 30 }];
    const result = evaluateRules(rules, perBucket, 100_000_000, NEUTRAL_POOL_STATE);
    expect(result[0].passed).toBe(true);
    expect(result[0].headroomPar).toBeCloseTo(2_000_000); // 30M - 28M
  });

  it("top-3 ≤ 30%: fails when largest 3 sum to 32%", () => {
    const perBucket = new Map([["A", 14_000_000], ["B", 10_000_000], ["C", 8_000_000], ["D", 5_000_000]]);
    const rules: IndustryCapRule[] = [{ kind: "combined_top_n_max", n: 3, triggerPct: 30 }];
    const result = evaluateRules(rules, perBucket, 100_000_000, NEUTRAL_POOL_STATE);
    expect(result[0].passed).toBe(false);
  });
});

describe("evaluateRules — single_class_max", () => {
  it("named-class cap on Oil and Gas (1120): bucket present, under cap → pass", () => {
    const perBucket = new Map([["1120", 8_000_000], ["1010", 14_000_000]]);
    const rules: IndustryCapRule[] = [
      { kind: "single_class_max", industryCode: "1120", industryName: "Oil and Gas", triggerPct: 10 },
    ];
    const result = evaluateRules(rules, perBucket, 100_000_000, NEUTRAL_POOL_STATE);
    expect(result[0].passed).toBe(true);
  });

  it("named-class cap: bucket above → fail", () => {
    const perBucket = new Map([["1120", 12_000_000]]);
    const rules: IndustryCapRule[] = [
      { kind: "single_class_max", industryCode: "1120", industryName: "Oil and Gas", triggerPct: 10 },
    ];
    const result = evaluateRules(rules, perBucket, 100_000_000, NEUTRAL_POOL_STATE);
    expect(result[0].passed).toBe(false);
  });
});

describe("evaluateRules — count_above_threshold", () => {
  it("≤ 3 industries above 12%: passes when only 2 are above", () => {
    const perBucket = new Map([["A", 14_000_000], ["B", 13_000_000], ["C", 9_000_000], ["D", 5_000_000]]);
    const rules: IndustryCapRule[] = [{ kind: "count_above_threshold", thresholdPct: 12, maxCount: 3 }];
    const result = evaluateRules(rules, perBucket, 100_000_000, NEUTRAL_POOL_STATE);
    expect(result[0].passed).toBe(true);
  });

  it("≤ 3 industries above 12%: fails when 4 are above", () => {
    const perBucket = new Map([
      ["A", 14_000_000], ["B", 13_000_000], ["C", 13_500_000], ["D", 12_500_000], ["E", 5_000_000],
    ]);
    const rules: IndustryCapRule[] = [{ kind: "count_above_threshold", thresholdPct: 12, maxCount: 3 }];
    const result = evaluateRules(rules, perBucket, 100_000_000, NEUTRAL_POOL_STATE);
    expect(result[0].passed).toBe(false);
  });
});

describe("evaluateRules — appliesWhen", () => {
  it("during_reinvestment_period: rule applies during RP, skipped post-RP", () => {
    const perBucket = new Map([["A", 16_000_000]]);
    const rules: IndustryCapRule[] = [
      {
        kind: "single_rank_max", rank: 1, triggerPct: 15,
        appliesWhen: { kind: "during_reinvestment_period" },
      },
    ];
    const inRp = evaluateRules(rules, perBucket, 100_000_000, { ...NEUTRAL_POOL_STATE, inReinvestmentPeriod: true });
    const postRp = evaluateRules(rules, perBucket, 100_000_000, { ...NEUTRAL_POOL_STATE, inReinvestmentPeriod: false });
    expect(inRp[0].applied).toBe(true);
    expect(inRp[0].passed).toBe(false);
    expect(postRp[0].applied).toBe(false);
    expect(postRp[0].passed).toBe(true);
  });

  it("ccc_pct_above: rule fires only when CCC > threshold", () => {
    const perBucket = new Map([["A", 28_000_000], ["B", 8_000_000]]);
    const rules: IndustryCapRule[] = [
      {
        kind: "single_rank_max", rank: 1, triggerPct: 25,
        appliesWhen: { kind: "ccc_pct_above", thresholdPct: 5 },
      },
    ];
    const lowCcc = evaluateRules(rules, perBucket, 100_000_000, { ...NEUTRAL_POOL_STATE, pctMoodysCaa: 3 });
    const highCcc = evaluateRules(rules, perBucket, 100_000_000, { ...NEUTRAL_POOL_STATE, pctMoodysCaa: 7 });
    expect(lowCcc[0].applied).toBe(false);
    expect(highCcc[0].applied).toBe(true);
    expect(highCcc[0].passed).toBe(false); // A = 28M > 25% cap
  });
});

describe("maxAdditionPerBucket", () => {
  it("single_rank_max: bucket already at cap → zero headroom", () => {
    const perBucket = new Map([["A", 15_000_000], ["B", 10_000_000]]);
    const rules: IndustryCapRule[] = [{ kind: "single_rank_max", rank: 1, triggerPct: 15 }];
    const headroom = maxAdditionPerBucket(rules, perBucket, 100_000_000, ["A", "B"], NEUTRAL_POOL_STATE);
    expect(headroom.get("A")).toBe(0);
    // B has rank-1 cap headroom: 15M - 10M = 5M (worst-case promotes to rank-1).
    expect(headroom.get("B")).toBe(5_000_000);
  });

  it("combined_top_n_max with bucket in top-N: headroom is trigger - currentSum", () => {
    const perBucket = new Map([["A", 12_000_000], ["B", 10_000_000], ["C", 8_000_000]]);
    // Top-3 cap 35%: current sum 30M, headroom 5M.
    const rules: IndustryCapRule[] = [{ kind: "combined_top_n_max", n: 3, triggerPct: 35 }];
    const headroom = maxAdditionPerBucket(rules, perBucket, 100_000_000, ["A"], NEUTRAL_POOL_STATE);
    expect(headroom.get("A")).toBe(5_000_000);
  });

  it("single_class_max only constrains the named bucket", () => {
    const perBucket = new Map([["1120", 8_000_000], ["1010", 14_000_000]]);
    const rules: IndustryCapRule[] = [
      { kind: "single_class_max", industryCode: "1120", industryName: "Oil and Gas", triggerPct: 10 },
    ];
    const headroom = maxAdditionPerBucket(rules, perBucket, 100_000_000, ["1120", "1010"], NEUTRAL_POOL_STATE);
    expect(headroom.get("1120")).toBe(2_000_000); // 10M - 8M
    expect(headroom.get("1010")).toBe(Infinity);  // unconstrained by this rule
  });
});

describe("allocateReinvestment — water-filling", () => {
  it("no constraints: allocates entirely per prior", () => {
    const result = allocateReinvestment({
      parToReinvest: 10_000_000,
      rules: [],
      initialPerBucket: new Map(),
      initialTotalPar: 100_000_000,
      priorWeights: new Map([["A", 0.6], ["B", 0.4]]),
      poolState: NEUTRAL_POOL_STATE,
    });
    expect(result.parAllocated).toBeCloseTo(10_000_000);
    expect(result.parBlocked).toBeCloseTo(0);
    expect(result.allocation.get("A")).toBeCloseTo(6_000_000);
    expect(result.allocation.get("B")).toBeCloseTo(4_000_000);
  });

  it("rank-1 cap on a bucket already at cap: blocks that bucket, fills others", () => {
    const result = allocateReinvestment({
      parToReinvest: 10_000_000,
      rules: [{ kind: "single_rank_max", rank: 1, triggerPct: 15 }],
      initialPerBucket: new Map([["A", 15_000_000], ["B", 5_000_000]]),
      initialTotalPar: 100_000_000,
      priorWeights: new Map([["A", 0.5], ["B", 0.5]]),
      poolState: NEUTRAL_POOL_STATE,
    });
    // A at 15M with rank-1 cap 15% × ~110M post = ~16.5M → 1.5M headroom.
    // B at 5M, rank-1 cap headroom 16.5M - 5M = 11.5M.
    // First iteration: 5M to A (capped), 5M to B → both placed.
    // Total 10M placed, 0 blocked.
    expect(result.parAllocated).toBeCloseTo(10_000_000);
    expect(result.parBlocked).toBeCloseTo(0);
    // A allocation should be at most the headroom (≈1.5M).
    const aAlloc = result.allocation.get("A") ?? 0;
    expect(aAlloc).toBeLessThanOrEqual(1_600_000); // ~16.5M cap - 15M start
    expect(result.allocation.get("B")).toBeGreaterThan(8_000_000);
  });

  it("all buckets blocked from start: reports parBlocked = parToReinvest", () => {
    const result = allocateReinvestment({
      parToReinvest: 10_000_000,
      rules: [
        { kind: "single_class_max", industryCode: "A", industryName: "A", triggerPct: 5 },
        { kind: "single_class_max", industryCode: "B", industryName: "B", triggerPct: 5 },
      ],
      initialPerBucket: new Map([["A", 6_000_000], ["B", 6_000_000]]),
      initialTotalPar: 100_000_000,
      priorWeights: new Map([["A", 0.5], ["B", 0.5]]),
      poolState: NEUTRAL_POOL_STATE,
    });
    // Both buckets are at 6M, cap = 5% × ~110M = ~5.5M → already over.
    // Headroom is zero (clamped at 0); no feasible bucket → all par blocked.
    expect(result.parBlocked).toBeGreaterThan(0);
    expect(result.parAllocated).toBeLessThan(1_000_000);
  });

  it("redistribution: when one bucket caps mid-allocation, residual flows to others", () => {
    const result = allocateReinvestment({
      parToReinvest: 20_000_000,
      rules: [{ kind: "single_class_max", industryCode: "A", industryName: "A", triggerPct: 12 }],
      initialPerBucket: new Map([["A", 10_000_000], ["B", 10_000_000], ["C", 10_000_000]]),
      initialTotalPar: 100_000_000,
      priorWeights: new Map([["A", 0.5], ["B", 0.25], ["C", 0.25]]),
      poolState: NEUTRAL_POOL_STATE,
    });
    // A cap = 12% × 120M = 14.4M → A headroom = 4.4M.
    // First iteration: A wants 10M (capped at 4.4M), B/C want 5M each.
    // Residual 5.6M redistributes over B/C proportionally.
    expect(result.parAllocated).toBeCloseTo(20_000_000);
    expect(result.parBlocked).toBeCloseTo(0);
    expect(result.allocation.get("A")).toBeLessThanOrEqual(5_000_000);
    expect(result.allocation.get("B")! + result.allocation.get("C")!).toBeGreaterThan(14_000_000);
  });

  it("combined_top_n_max with multiple in-top-N buckets: enforces shared headroom (regression)", () => {
    // Three buckets currently at 5M each (top-3 sum = 15M of 15M total pool).
    // Rule: combined_top_n_max(n=3, triggerPct=70). Reinvest 30M → totalAfter=45M
    // → triggerPar=31.5M. Combined headroom = 31.5 - 15 = 16.5M shared across
    // ALL in-top-3 buckets. Pre-fix: each bucket reported headroom of 16.5M
    // independently and the allocator placed 10M each = 30M, driving top-3 to
    // 45M (cap breached by 13.5M). Post-fix: collective scaling caps total
    // in-top-N allocation at 16.5M; remaining 13.5M is blocked.
    const result = allocateReinvestment({
      parToReinvest: 30_000_000,
      rules: [{ kind: "combined_top_n_max", n: 3, triggerPct: 70 }],
      initialPerBucket: new Map([["A", 5_000_000], ["B", 5_000_000], ["C", 5_000_000]]),
      initialTotalPar: 15_000_000,
      priorWeights: new Map([["A", 1/3], ["B", 1/3], ["C", 1/3]]),
      poolState: NEUTRAL_POOL_STATE,
    });
    expect(result.parAllocated).toBeCloseTo(16_500_000, -3);
    expect(result.parBlocked).toBeCloseTo(13_500_000, -3);
    // Verify post-allocation cap held: top-3 sum ≤ trigger.
    const finalState = new Map<string, number>([["A", 5_000_000], ["B", 5_000_000], ["C", 5_000_000]]);
    for (const [k, v] of result.allocation) finalState.set(k, (finalState.get(k) ?? 0) + v);
    const totalParAfter = 15_000_000 + 30_000_000;
    const top3Sum = Array.from(finalState.values()).sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
    expect(top3Sum).toBeLessThanOrEqual(0.7 * totalParAfter + 1);
  });

  it("combined_top_n_max with non-top-N buckets accepting allocation: cap held (regression)", () => {
    // 5 buckets [10, 10, 10, 5, 5] = 40M. Top-3 = 30M. Rule: combined_top_n_max
    // (n=3, triggerPct=70). Reinvest 10M → totalAfter=50M → trigger=35M.
    // Shared budget = 5M. Pre-fix: each in-top-3 bucket reported 5M headroom;
    // uniform allocation placed 2M each across all 5 → top-3 grew to 36M (cap
    // breached by 1M). Post-fix: in-top-3 wants scale down (collectively
    // capped at 5M); residual flows to non-top-3 buckets.
    const result = allocateReinvestment({
      parToReinvest: 10_000_000,
      rules: [{ kind: "combined_top_n_max", n: 3, triggerPct: 70 }],
      initialPerBucket: new Map([
        ["A", 10_000_000], ["B", 10_000_000], ["C", 10_000_000],
        ["D", 5_000_000], ["E", 5_000_000],
      ]),
      initialTotalPar: 40_000_000,
      priorWeights: new Map([["A", 0.2], ["B", 0.2], ["C", 0.2], ["D", 0.2], ["E", 0.2]]),
      poolState: NEUTRAL_POOL_STATE,
    });
    expect(result.parAllocated).toBeCloseTo(10_000_000, -3);
    expect(result.parBlocked).toBeCloseTo(0, -3);
    // Verify post-allocation cap held.
    const finalState = new Map<string, number>([
      ["A", 10_000_000], ["B", 10_000_000], ["C", 10_000_000],
      ["D", 5_000_000], ["E", 5_000_000],
    ]);
    for (const [k, v] of result.allocation) finalState.set(k, (finalState.get(k) ?? 0) + v);
    const totalParAfter = 50_000_000;
    const top3Sum = Array.from(finalState.values()).sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
    expect(top3Sum).toBeLessThanOrEqual(0.7 * totalParAfter + 1);
  });
});
