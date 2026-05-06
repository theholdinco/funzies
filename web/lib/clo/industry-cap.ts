/**
 * Industry-cap — engine-side industry-cap evaluator + water-filling allocator.
 *
 * Pure helpers consumed by:
 *   - `pool-metrics.ts` — `largestIndustryPct` aggregate on PoolQualityMetrics
 *   - `projection.ts` — C1 reinvestment compliance gate at the synthesis site
 *   - `switch-simulator.ts` — pre/post-trade industry concentration delta
 *
 * Architectural shape:
 *   - `aggregateIndustryPar`: Σ par per `industryCode` over a loan list.
 *     Excluded industries are dropped before aggregation.
 *   - `rankedIndustryPar`: per-bucket → descending sorted array.
 *   - `evaluateRules`: given a per-bucket distribution + total par, do all
 *     rules pass? Used for switch-simulator post-trade verification.
 *   - `maxAdditionPerBucket`: per-bucket headroom under all rules. Drives
 *     the allocator's "which buckets are blocked at this iteration".
 *   - `allocateReinvestment`: water-filling allocator. Iterates a feasible
 *     proportional fill toward a prior, capping over-target buckets and
 *     redistributing residual. Continuous, exact, no magic quantum.
 *
 * Anti-pattern #5 (boundaries assert shape): every boundary carries
 * `industryCode` + `parPct` (not Map at the boundary; Map only internal).
 */

import type { IndustryCapRule, IndustryCapAppliesWhen } from "./resolver-types";

// ─────────────────────────────────────────────────────────────────────
// Per-loan input shape — minimal fields for industry aggregation.
// ─────────────────────────────────────────────────────────────────────

export interface IndustryAggregationLoan {
  parBalance: number;
  industryCode?: string;
}

/** State of the pool that conditional rules (`appliesWhen`) evaluate
 *  against. Threaded explicitly so the evaluator is pure. */
export interface IndustryCapPoolState {
  /** Pool's Caa-or-below par share as a fraction of total par (0–100, percent). */
  pctMoodysCaa: number;
  /** Pool's defaulted par share as a fraction of total par (0–100, percent). */
  pctDefaulted: number;
  /** True iff the deal is currently in the reinvestment period at this period. */
  inReinvestmentPeriod: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

/** Σ par per `industryCode` over a loan list, dropping loans whose
 *  `industryCode` matches any entry in `excludedIndustryCodes`. Loans
 *  with no `industryCode` are silently dropped — coverage is enforced
 *  upstream by the resolver's blocking gate (PR3). Filtering by code
 *  (not name) so the engine works against `LoanState.industryCode`
 *  directly without carrying redundant industryName through the
 *  projection. The resolver converts PPM-extracted excludedIndustryNames
 *  to canonical codes at resolution time via the active taxonomy. */
export function aggregateIndustryPar(
  loans: ReadonlyArray<IndustryAggregationLoan>,
  excludedIndustryCodes?: ReadonlyArray<string> | null,
): Map<string, number> {
  const excluded = new Set(excludedIndustryCodes ?? []);
  const out = new Map<string, number>();
  for (const l of loans) {
    if (l.parBalance <= 0) continue;
    if (!l.industryCode) continue;
    if (excluded.has(l.industryCode)) continue;
    out.set(l.industryCode, (out.get(l.industryCode) ?? 0) + l.parBalance);
  }
  return out;
}

/** Convert per-bucket par → descending sorted ranking. Stable on tie
 *  (Array.prototype.sort is stable in JS engines we target). */
export function rankedIndustryPar(
  perBucket: Map<string, number>,
): Array<{ industryCode: string; par: number }> {
  return Array.from(perBucket, ([industryCode, par]) => ({ industryCode, par }))
    .sort((a, b) => b.par - a.par);
}

// ─────────────────────────────────────────────────────────────────────
// Rule evaluation
// ─────────────────────────────────────────────────────────────────────

/** Evaluate `appliesWhen` against current pool state. Rules without an
 *  `appliesWhen` always apply. */
function ruleApplies(
  appliesWhen: IndustryCapAppliesWhen | undefined,
  poolState: IndustryCapPoolState,
): boolean {
  if (!appliesWhen) return true;
  switch (appliesWhen.kind) {
    case "during_reinvestment_period":
      return poolState.inReinvestmentPeriod;
    case "post_reinvestment_period":
      return !poolState.inReinvestmentPeriod;
    case "ccc_pct_above":
      return poolState.pctMoodysCaa > appliesWhen.thresholdPct;
    case "defaulted_pct_above":
      return poolState.pctDefaulted > appliesWhen.thresholdPct;
  }
}

export interface RuleEvaluation {
  rule: IndustryCapRule;
  /** Did this rule apply (passed the appliesWhen predicate)? */
  applied: boolean;
  /** Did the pool satisfy the rule? True when `applied === false`. */
  passed: boolean;
  /** Headroom in absolute par. Negative when the rule is breached.
   *  Undefined when the rule kind doesn't have a single scalar headroom
   *  notion (e.g. `count_above_threshold`). */
  headroomPar?: number;
  /** Description of the breach when `applied && !passed`. */
  breachDescription?: string;
}

/** Evaluate every rule against a per-bucket distribution + total par.
 *  `total` is the rank-base par for percentage computations (i.e. Σ par
 *  over loans contributing to the cap denominator — typically all
 *  funded non-defaulted non-excluded loans). */
export function evaluateRules(
  rules: ReadonlyArray<IndustryCapRule>,
  perBucket: Map<string, number>,
  totalPar: number,
  poolState: IndustryCapPoolState,
): RuleEvaluation[] {
  if (totalPar <= 0) {
    return rules.map((rule) => ({
      rule,
      applied: false,
      passed: true,
    }));
  }
  const ranked = rankedIndustryPar(perBucket);

  return rules.map((rule): RuleEvaluation => {
    if (!ruleApplies(rule.appliesWhen, poolState)) {
      return { rule, applied: false, passed: true };
    }

    switch (rule.kind) {
      case "single_rank_max": {
        const triggerPar = (rule.triggerPct / 100) * totalPar;
        const target = ranked[rule.rank - 1]?.par ?? 0;
        const headroomPar = triggerPar - target;
        const passed = target <= triggerPar + 1e-6;
        return {
          rule,
          applied: true,
          passed,
          headroomPar,
          breachDescription: passed
            ? undefined
            : `rank-${rule.rank} industry par ${target.toFixed(0)} > cap ${triggerPar.toFixed(0)} (${rule.triggerPct}% × ${totalPar.toFixed(0)})`,
        };
      }
      case "combined_top_n_max": {
        const triggerPar = (rule.triggerPct / 100) * totalPar;
        const target = ranked.slice(0, rule.n).reduce((s, b) => s + b.par, 0);
        const headroomPar = triggerPar - target;
        const passed = target <= triggerPar + 1e-6;
        return {
          rule,
          applied: true,
          passed,
          headroomPar,
          breachDescription: passed
            ? undefined
            : `top-${rule.n} combined par ${target.toFixed(0)} > cap ${triggerPar.toFixed(0)} (${rule.triggerPct}% × ${totalPar.toFixed(0)})`,
        };
      }
      case "single_class_max": {
        const triggerPar = (rule.triggerPct / 100) * totalPar;
        const target = perBucket.get(rule.industryCode) ?? 0;
        const headroomPar = triggerPar - target;
        const passed = target <= triggerPar + 1e-6;
        return {
          rule,
          applied: true,
          passed,
          headroomPar,
          breachDescription: passed
            ? undefined
            : `${rule.industryName} par ${target.toFixed(0)} > cap ${triggerPar.toFixed(0)}`,
        };
      }
      case "count_above_threshold": {
        const thresholdPar = (rule.thresholdPct / 100) * totalPar;
        const count = ranked.filter((b) => b.par > thresholdPar + 1e-6).length;
        const passed = count <= rule.maxCount;
        return {
          rule,
          applied: true,
          passed,
          breachDescription: passed
            ? undefined
            : `${count} industries above ${rule.thresholdPct}%; cap is ${rule.maxCount}`,
        };
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
// Per-bucket headroom (synthesis support)
// ─────────────────────────────────────────────────────────────────────

/** For each `candidateBucket`, compute the maximum additional par that
 *  can be allocated without violating any active rule, given the current
 *  per-bucket state and the post-allocation total par. This is the
 *  load-bearing helper for the water-filling allocator: a bucket is
 *  "feasible" iff `maxAddition > 0`.
 *
 *  Subtle case (combined_top_n_max): adding par to a non-top-N bucket
 *  has zero effect on the rule UNTIL the bucket grows past the rank-N
 *  bucket — at which point the bucket joins top-N and the combined sum
 *  changes. The water-filling allocator handles this by re-evaluating
 *  per iteration; this helper computes the headroom under the CURRENT
 *  ranking and is conservative when the bucket would shift rank.
 *
 *  Edge case (count_above_threshold): a bucket's headroom under this
 *  rule is `thresholdPar - currentBucket` if currently below threshold
 *  (any further addition under that delta keeps it below). If currently
 *  above, the constraint is "no more than maxCount industries above
 *  threshold" — the bucket is unbounded under THIS rule (it's already
 *  contributing to the count) but other buckets may be blocked. This
 *  asymmetry is handled by including the rule in `evaluateRules` only,
 *  not in this per-bucket headroom helper. */
export function maxAdditionPerBucket(
  rules: ReadonlyArray<IndustryCapRule>,
  perBucket: Map<string, number>,
  totalParAfter: number,
  candidateBuckets: ReadonlyArray<string>,
  poolState: IndustryCapPoolState,
): Map<string, number> {
  const ranked = rankedIndustryPar(perBucket);
  const headroom = new Map<string, number>();

  for (const bucket of candidateBuckets) {
    let minHeadroom = Infinity;
    const currentPar = perBucket.get(bucket) ?? 0;

    for (const rule of rules) {
      if (!ruleApplies(rule.appliesWhen, poolState)) continue;

      switch (rule.kind) {
        case "single_rank_max": {
          // For rank=N, a bucket constrains the rule only if it could BE
          // rank-N after fill. A bucket strictly above rank-N par stays
          // above rank-N (allocation only adds par; rank can only rise),
          // so its growth doesn't affect rank-N par at all — rank-N is
          // determined by OTHER buckets. Cap is unconstrained under this
          // rule for "above rank-N" buckets. Without this carve-out, a
          // dominant rank-1 bucket whose currentPar exceeds the rank-N
          // trigger reports per-bucket headroom = 0 (clamped from
          // `trigger - currentPar < 0`) and the allocator blocks any
          // growth into it — distorting the prior even when no rule is
          // actually breached. The constraint on rank-N is captured by
          // the rank-N bucket's own cap (and any below-rank-N candidate
          // that could promote into rank-N).
          const triggerPar = (rule.triggerPct / 100) * totalParAfter;
          const rankNPar = ranked[rule.rank - 1]?.par ?? 0;
          if (currentPar > rankNPar + 1e-6) break;
          const ruleHeadroom = triggerPar - currentPar;
          if (ruleHeadroom < minHeadroom) minHeadroom = ruleHeadroom;
          break;
        }
        case "combined_top_n_max": {
          const triggerPar = (rule.triggerPct / 100) * totalParAfter;
          // If bucket is currently in top-N: addition flows directly into
          // the combined sum — headroom = trigger − currentSum.
          const isInTopN = ranked.findIndex((b) => b.industryCode === bucket) < rule.n;
          const currentSum = ranked.slice(0, rule.n).reduce((s, b) => s + b.par, 0);
          if (isInTopN) {
            const ruleHeadroom = triggerPar - currentSum;
            if (ruleHeadroom < minHeadroom) minHeadroom = ruleHeadroom;
          } else {
            // Bucket is below rank-N. Adding par could (a) keep it below
            // rank-N (no effect on rule) or (b) push it into top-N
            // (replaces the rank-N bucket and grows the combined sum by
            // the delta from rank-N's par to the new bucket's par).
            // Conservative: if rank-N bucket exists, the addition that
            // brings this bucket to rank-N's par is "free" (no rule
            // change); beyond that, every additional unit grows the
            // combined sum 1:1. So:
            //   freeAddition = rankN.par - currentPar
            //   thenHeadroom = trigger - currentSum (post-rank-N replace)
            const rankNPar = ranked[rule.n - 1]?.par ?? 0;
            const freeAddition = Math.max(0, rankNPar - currentPar);
            const postReplaceHeadroom = triggerPar - currentSum;
            const ruleHeadroom = freeAddition + Math.max(0, postReplaceHeadroom);
            if (ruleHeadroom < minHeadroom) minHeadroom = ruleHeadroom;
          }
          break;
        }
        case "single_class_max": {
          if (rule.industryCode !== bucket) continue;
          const triggerPar = (rule.triggerPct / 100) * totalParAfter;
          const ruleHeadroom = triggerPar - currentPar;
          if (ruleHeadroom < minHeadroom) minHeadroom = ruleHeadroom;
          break;
        }
        case "count_above_threshold": {
          // Bucket already above threshold → unbounded under this rule
          // (already counted). Bucket below threshold → bounded only if
          // count is at maxCount; in which case headroom is
          // `thresholdPar − currentPar` (don't push it over).
          const thresholdPar = (rule.thresholdPct / 100) * totalParAfter;
          const aboveCount = ranked.filter((b) => b.par > thresholdPar + 1e-6).length;
          if (currentPar > thresholdPar + 1e-6) {
            // Already counted; this rule doesn't constrain THIS bucket further.
            continue;
          }
          if (aboveCount >= rule.maxCount) {
            const ruleHeadroom = thresholdPar - currentPar;
            if (ruleHeadroom < minHeadroom) minHeadroom = ruleHeadroom;
          }
          break;
        }
      }
    }

    headroom.set(bucket, Number.isFinite(minHeadroom) ? Math.max(0, minHeadroom) : Infinity);
  }

  return headroom;
}

// ─────────────────────────────────────────────────────────────────────
// Water-filling allocator
// ─────────────────────────────────────────────────────────────────────

export interface AllocationInputs {
  parToReinvest: number;
  rules: ReadonlyArray<IndustryCapRule>;
  /** Per-bucket par BEFORE this reinvestment. */
  initialPerBucket: Map<string, number>;
  /** Total par BEFORE this reinvestment (denominator base for rules). */
  initialTotalPar: number;
  /** Bucket weights expressing the prior. Sum can be any positive number;
   *  the allocator normalizes per iteration. */
  priorWeights: Map<string, number>;
  poolState: IndustryCapPoolState;
}

export interface AllocationResult {
  /** Per-bucket additional par allocated this round. Sum equals
   *  `parAllocated`. */
  allocation: Map<string, number>;
  /** Total par successfully allocated. ≤ `parToReinvest`. */
  parAllocated: number;
  /** Par that couldn't be placed feasibly. The caller routes this to
   *  senior paydown (matching the existing
   *  `reinvestmentBlockedCompliance` convention at projection.ts:3323). */
  parBlocked: number;
  /** Rules that were binding when allocation terminated. Empty when
   *  termination was "all par placed". */
  blockingRules: IndustryCapRule[];
}

/** Water-filling allocator for cap-aware reinvestment.
 *
 *  Iteration:
 *    1. Normalize prior over feasible buckets (those with positive headroom).
 *    2. Allocate proportionally toward the prior.
 *    3. For each bucket, cap allocation at its current headroom.
 *    4. Sum what was actually placed; subtract from remaining par.
 *    5. If any bucket was capped (placed < want), at least one rule is
 *       binding for that bucket — re-iterate with the now-reduced
 *       feasible set, redistributing the residual proportionally over
 *       the remaining feasible buckets.
 *    6. Terminate when (a) all par placed, OR (b) no feasible bucket has
 *       positive headroom, OR (c) iteration count exceeds |buckets|+2
 *       (defensive — convergence is mathematically guaranteed in
 *       ≤ |buckets| iterations).
 *
 *  Linear in (buckets × rules × iterations); ~30 × 5 × 30 = 4.5K ops
 *  per allocation. Performance-safe for 100 sensitivity scenarios × 40
 *  quarters per scenario. */
export function allocateReinvestment(inputs: AllocationInputs): AllocationResult {
  const { parToReinvest, rules, initialPerBucket, initialTotalPar, priorWeights, poolState } = inputs;
  const allocation = new Map<string, number>();
  if (parToReinvest <= 0) {
    return { allocation, parAllocated: 0, parBlocked: 0, blockingRules: [] };
  }

  // Working copy of per-bucket par (mutated as par is added).
  const workingPerBucket = new Map(initialPerBucket);
  const candidateBuckets = Array.from(priorWeights.keys()).filter((k) => (priorWeights.get(k) ?? 0) > 0);

  let remaining = parToReinvest;
  let totalParAfter = initialTotalPar + parToReinvest;
  const TOL = 1e-3;
  const MAX_ITERATIONS = candidateBuckets.length + 2;

  for (let iter = 0; iter < MAX_ITERATIONS && remaining > TOL; iter++) {
    const headroom = maxAdditionPerBucket(rules, workingPerBucket, totalParAfter, candidateBuckets, poolState);

    // Feasible = bucket with positive remaining headroom AND positive prior
    // weight AND positive remaining capacity (priorWeights[k] - allocation[k]).
    const feasible = candidateBuckets.filter((k) => {
      const h = headroom.get(k) ?? 0;
      return h > TOL;
    });

    if (feasible.length === 0) break;

    // Normalize prior over feasible buckets.
    const feasibleWeightSum = feasible.reduce((s, k) => s + (priorWeights.get(k) ?? 0), 0);
    if (feasibleWeightSum <= 0) break;

    // Step 1: per-bucket proportional want.
    const wants = new Map<string, number>();
    for (const bucket of feasible) {
      const w = priorWeights.get(bucket) ?? 0;
      wants.set(bucket, (w / feasibleWeightSum) * remaining);
    }

    // Step 2: collective constraints. `combined_top_n_max` binds Σ par over
    // its top-N buckets, not each bucket individually. Round-3 added scaling
    // for in-top-N collective; round-8 generalizes to handle non-top-N
    // promotion: a bucket below rank-N (or tied with rank-N) can receive
    // "non-top-N" allocation under the per-bucket headroom formula
    // `freeAddition + postReplace`, but if its want pushes it INTO post-
    // allocation top-N, it now contributes to the top-N sum. Multiple such
    // buckets promoting simultaneously can blow past the trigger even when
    // the in-top-N collective scaling held. The general fix: simulate
    // post-want state, find post-want top-N, scale down wants of buckets
    // that contribute to post-want top-N proportionally if their summed
    // contribution would exceed the trigger.
    let collectivelyConstrained = false;
    for (const rule of rules) {
      if (rule.kind !== "combined_top_n_max") continue;
      if (!ruleApplies(rule.appliesWhen, poolState)) continue;
      const triggerPar = (rule.triggerPct / 100) * totalParAfter;
      // Inner fixed-point loop: scaling can shift rank composition (a bucket
      // not in pre-scale top-N may overtake a scaled-down top-N bucket and
      // join post-scale top-N). Re-evaluate after each scale and re-scale
      // until the post-want top-N sum is within trigger or no further
      // scaling helps. Bounded iterations so a degenerate input cannot
      // hang the allocator.
      for (let inner = 0; inner < rule.n + 2; inner++) {
        const postWantPar = new Map<string, number>();
        for (const [k, v] of workingPerBucket) postWantPar.set(k, v);
        for (const bucket of feasible) {
          postWantPar.set(bucket, (postWantPar.get(bucket) ?? 0) + (wants.get(bucket) ?? 0));
        }
        const ranked2 = Array.from(postWantPar, ([code, par]) => ({ code, par }))
          .sort((a, b) => b.par - a.par);
        const topNCodesAfter = new Set(ranked2.slice(0, rule.n).map((b) => b.code));
        const topNSumAfter = ranked2.slice(0, rule.n).reduce((s, b) => s + b.par, 0);
        if (topNSumAfter <= triggerPar + TOL) break;
        // Scale = 1 − (overshoot / sumWantsScalable). Reductions apply to
        // wants of feasible buckets whose post-want par lands in top-N.
        const scalableBuckets = feasible.filter((b) => topNCodesAfter.has(b));
        let sumWantsScalable = 0;
        for (const b of scalableBuckets) sumWantsScalable += wants.get(b) ?? 0;
        if (sumWantsScalable <= TOL) break;
        const reductionNeeded = topNSumAfter - triggerPar;
        const scale = Math.max(0, 1 - reductionNeeded / sumWantsScalable);
        for (const b of scalableBuckets) {
          wants.set(b, (wants.get(b) ?? 0) * scale);
        }
        collectivelyConstrained = true;
      }
    }

    // Step 2b: `count_above_threshold` is also a collective constraint. The
    // per-bucket headroom in `maxAdditionPerBucket` only fires when the
    // aboveCount is already at maxCount; if aboveCount < maxCount, each
    // below-threshold bucket reports unconstrained headroom — but ALL of
    // them crossing simultaneously can drive the count past maxCount.
    // Concrete: 5 buckets at 5M (currently below an 18%-of-pool threshold);
    // rule maxCount=2; uniform want of 1M each → all five cross threshold
    // → count=5 > maxCount=2 → BREACH. Fix: identify below-threshold
    // crossers ranked by prior, allow at most `maxCount - currentlyAbove`
    // to cross; cap the rest at threshold (post = thresholdPar so they
    // stay below the strict-> predicate).
    for (const rule of rules) {
      if (rule.kind !== "count_above_threshold") continue;
      if (!ruleApplies(rule.appliesWhen, poolState)) continue;
      const thresholdPar = (rule.thresholdPct / 100) * totalParAfter;
      let currentlyAbove = 0;
      for (const par of workingPerBucket.values()) if (par > thresholdPar + TOL) currentlyAbove++;
      const slots = Math.max(0, rule.maxCount - currentlyAbove);
      const crossers: { bucket: string; weight: number }[] = [];
      for (const bucket of feasible) {
        const currentPar = workingPerBucket.get(bucket) ?? 0;
        if (currentPar > thresholdPar + TOL) continue; // already counted
        const want = wants.get(bucket) ?? 0;
        if (currentPar + want > thresholdPar + TOL) {
          crossers.push({ bucket, weight: priorWeights.get(bucket) ?? 0 });
        }
      }
      if (crossers.length > slots) {
        // Sort by prior weight descending; first `slots` cross fully,
        // rest capped at `thresholdPar - currentPar` (stay just at/below
        // threshold so the strict-> count predicate doesn't include them).
        crossers.sort((a, b) => b.weight - a.weight);
        for (let i = slots; i < crossers.length; i++) {
          const bucket = crossers[i].bucket;
          const currentPar = workingPerBucket.get(bucket) ?? 0;
          const cap = Math.max(0, thresholdPar - currentPar);
          wants.set(bucket, Math.min(wants.get(bucket) ?? 0, cap));
        }
        collectivelyConstrained = true;
      }
    }

    let placedThisRound = 0;
    let anyCapped = false;

    for (const bucket of feasible) {
      const w = priorWeights.get(bucket) ?? 0;
      const proportionalShare = (w / feasibleWeightSum) * remaining;
      const want = wants.get(bucket) ?? 0;
      const cap = headroom.get(bucket) ?? 0;
      const place = Math.min(want, cap);
      if (place < proportionalShare - TOL) anyCapped = true;
      if (place <= 0) continue;

      allocation.set(bucket, (allocation.get(bucket) ?? 0) + place);
      workingPerBucket.set(bucket, (workingPerBucket.get(bucket) ?? 0) + place);
      placedThisRound += place;
    }

    remaining -= placedThisRound;
    if (placedThisRound < TOL) break;
    if (!anyCapped && !collectivelyConstrained) break;
  }

  // Identify binding rules: those for which the post-allocation state has
  // headroom near zero.
  const evaluations = evaluateRules(rules, workingPerBucket, totalParAfter, poolState);
  const blockingRules: IndustryCapRule[] = [];
  for (const ev of evaluations) {
    if (!ev.applied) continue;
    if (ev.headroomPar != null && ev.headroomPar < TOL * totalParAfter) {
      blockingRules.push(ev.rule);
    }
  }

  const parAllocated = parToReinvest - remaining;
  return {
    allocation,
    parAllocated,
    parBlocked: Math.max(0, remaining),
    blockingRules,
  };
}

/** Ergonomic helper: convert allocator output to engine-consumable
 *  per-synthetic-loan industry tags. Returns `[{ industryCode, par }]`
 *  in descending par order — caller iterates and creates one synthetic
 *  loan per entry, threading `industryCode` into `LoanState.industryCode`. */
export function allocationToSyntheticBuckets(
  allocation: Map<string, number>,
): Array<{ industryCode: string; par: number }> {
  return Array.from(allocation, ([industryCode, par]) => ({ industryCode, par }))
    .filter((entry) => entry.par > 0)
    .sort((a, b) => b.par - a.par);
}
