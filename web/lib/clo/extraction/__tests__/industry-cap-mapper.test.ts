/**
 * Industry-cap — `mapIndustryConcentrationTest` unit tests. Locks in the
 * failure-closed discipline:
 *
 *   - present:false → no constraint
 *   - present:true with all-known kinds → rules populated
 *   - present:true with one unknown kind → rules:null (taints whole extraction)
 *   - present:true with non-empty unmapped_rule_descriptions → rules:null
 *   - present:true with no taxonomy → rules:null
 *   - whole block missing → null
 *
 * The mapper's failure-closed shape is what the resolver's blocking gate
 * (PR3) keys on. Without these invariants the gate cannot distinguish
 * "extraction succeeded with empty rules" from "extraction failed".
 */

import { describe, it, expect } from "vitest";
import { mapIndustryConcentrationTest } from "../json-ingest/ppm-mapper";
import type { PpmJson } from "../json-ingest/types";

/** Minimal PpmJson stub. Only `section_8_portfolio_and_quality_tests
 *  .industry_concentration_test` is consumed by `mapIndustryConcentrationTest`;
 *  every other field is irrelevant. The cast is safe because we test
 *  the sub-mapper in isolation. */
function makePpm(block: PpmJson["section_8_portfolio_and_quality_tests"]["industry_concentration_test"]): PpmJson {
  return {
    section_8_portfolio_and_quality_tests: {
      industry_concentration_test: block,
    },
  } as unknown as PpmJson;
}

function getIndustryBlock(
  block: PpmJson["section_8_portfolio_and_quality_tests"]["industry_concentration_test"],
): Record<string, unknown> | null {
  return mapIndustryConcentrationTest(makePpm(block)) as Record<string, unknown> | null;
}

describe("mapIndustryConcentrationTest — industry-cap", () => {
  it("whole block missing → null (legacy extraction)", () => {
    const result = getIndustryBlock(undefined);
    expect(result).toBeNull();
  });

  it("present:false → no constraint, rules null", () => {
    const result = getIndustryBlock({ present: false });
    expect(result).toMatchObject({ present: false, rules: null, taxonomy: null });
  });

  it("present:true + all four rule kinds → rules populated", () => {
    const result = getIndustryBlock({
      present: true,
      taxonomy: "moodys_33",
      rules: [
        { kind: "single_rank_max", rank: 1, trigger_pct: 15 },
        { kind: "combined_top_n_max", n: 3, trigger_pct: 30 },
        { kind: "single_class_max", industry_name: "Oil and Gas", trigger_pct: 10 },
        { kind: "count_above_threshold", threshold_pct: 12, max_count: 3 },
      ],
    });
    expect(result).toMatchObject({ present: true, taxonomy: "moodys_33" });
    const rules = result?.rules as Array<{ kind: string; triggerPct?: number; thresholdPct?: number }>;
    expect(rules).toHaveLength(4);
    expect(rules[0]).toMatchObject({ kind: "single_rank_max", rank: 1, triggerPct: 15 });
    expect(rules[1]).toMatchObject({ kind: "combined_top_n_max", n: 3, triggerPct: 30 });
    expect(rules[2]).toMatchObject({ kind: "single_class_max", industryName: "Oil and Gas", triggerPct: 10 });
    expect(rules[3]).toMatchObject({ kind: "count_above_threshold", thresholdPct: 12, maxCount: 3 });
  });

  it("present:true + appliesWhen on rules → translated", () => {
    const result = getIndustryBlock({
      present: true,
      taxonomy: "sp",
      rules: [
        { kind: "single_rank_max", rank: 1, trigger_pct: 15, applies_when: { kind: "during_reinvestment_period" } },
        { kind: "single_rank_max", rank: 1, trigger_pct: 12, applies_when: { kind: "post_reinvestment_period" } },
        { kind: "combined_top_n_max", n: 3, trigger_pct: 28, applies_when: { kind: "ccc_pct_above", threshold_pct: 5 } },
      ],
    });
    const rules = result?.rules as Array<{ appliesWhen?: { kind: string; thresholdPct?: number } }>;
    expect(rules[0].appliesWhen).toEqual({ kind: "during_reinvestment_period" });
    expect(rules[1].appliesWhen).toEqual({ kind: "post_reinvestment_period" });
    expect(rules[2].appliesWhen).toEqual({ kind: "ccc_pct_above", thresholdPct: 5 });
  });

  it("present:true + ONE unknown kind → rules null (taints whole extraction)", () => {
    const result = getIndustryBlock({
      present: true,
      taxonomy: "moodys_33",
      rules: [
        { kind: "single_rank_max", rank: 1, trigger_pct: 15 },
        // @ts-expect-error - intentional malformed kind to test fail-closed
        { kind: "unknown_weird_rule", trigger_pct: 99 },
      ],
    });
    expect(result).toMatchObject({ present: true });
    expect(result?.rules).toBeNull();
  });

  it("present:true + non-empty unmapped_rule_descriptions → rules null", () => {
    const result = getIndustryBlock({
      present: true,
      taxonomy: "moodys_33",
      rules: [{ kind: "single_rank_max", rank: 1, trigger_pct: 15 }],
      unmapped_rule_descriptions: ["if X then Y - novel conditional shape"],
    });
    expect(result?.rules).toBeNull();
    expect(result?.unmappedRuleDescriptions).toEqual(["if X then Y - novel conditional shape"]);
  });

  it("present:true + missing taxonomy → rules null (resolver blocks)", () => {
    const result = getIndustryBlock({
      present: true,
      rules: [{ kind: "single_rank_max", rank: 1, trigger_pct: 15 }],
    });
    expect(result?.taxonomy).toBeNull();
    expect(result?.rules).toBeNull();
  });

  it("present:true + excluded_industry_names → translated to camelCase", () => {
    const result = getIndustryBlock({
      present: true,
      taxonomy: "moodys_33",
      rules: [{ kind: "single_rank_max", rank: 1, trigger_pct: 15 }],
      excluded_industry_names: ["Sovereign and Public Finance"],
    });
    expect(result?.excludedIndustryNames).toEqual(["Sovereign and Public Finance"]);
  });

  it("malformed numeric in known kind → taints (rules null)", () => {
    const result = getIndustryBlock({
      present: true,
      taxonomy: "moodys_33",
      rules: [
        { kind: "single_rank_max", rank: 1, trigger_pct: 15 },
        // @ts-expect-error - missing required numeric
        { kind: "combined_top_n_max", n: "three", trigger_pct: 30 },
      ],
    });
    expect(result?.rules).toBeNull();
  });

  it("source provenance preserved", () => {
    const result = getIndustryBlock({
      present: true,
      taxonomy: "moodys_33",
      rules: [{ kind: "single_rank_max", rank: 1, trigger_pct: 15 }],
      source_pages: [302, 303],
      source_condition: "Condition 1, paragraph (t)",
      verbatim_quote: "no industry shall exceed 15 per cent.",
    });
    expect(result?.sourcePages).toEqual([302, 303]);
    expect(result?.sourceCondition).toBe("Condition 1, paragraph (t)");
    expect(result?.verbatimQuote).toBe("no industry shall exceed 15 per cent.");
  });
});
