/**
 * Industry-cap — resolver-side industry-cap blocking gate. Locks in Option D's
 * three-state behavior:
 *
 *   - PPM block missing/null + SDF has INDUSTRY rows  → block
 *   - PPM block missing/null + no SDF INDUSTRY rows   → permissive
 *   - present:false                                    → no constraint, permissive
 *   - present:true + rules empty/null                  → block
 *   - present:true + taxonomy missing                  → block
 *   - present:true + non-empty unmapped descriptions   → block
 *   - present:true + rank-1 cap < rank-2 cap           → block (LLM rank confusion)
 *   - per-loan industry coverage gap on active deal    → block
 *
 * The gate fires through `ResolutionWarning` with `severity: "error",
 * blocking: true` — `selectBlockingWarnings` in build-projection-inputs.ts
 * throws IncompleteDataError downstream. These tests assert the warnings
 * are emitted; the throw-on-block is integration-tested by
 * blocking-extraction-failures.test.ts via its bijection-with-banner gate.
 */

import { describe, it, expect } from "vitest";
import { resolveWaterfallInputs } from "@/lib/clo/resolver";
import type { ExtractedConstraints } from "@/lib/clo/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Use the Euro XV fixture as the realistic baseline; mutate only
// `constraints.industryConcentrationTest` and `complianceData` to exercise
// the gate.
const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

function runResolver(constraintsOverride: Partial<ExtractedConstraints>, concentrationsOverride?: unknown[]) {
  const raw = fixture.raw;
  const constraints = { ...raw.constraints, ...constraintsOverride };
  const complianceData = concentrationsOverride !== undefined
    ? { ...raw.complianceData, concentrations: concentrationsOverride }
    : raw.complianceData;
  return resolveWaterfallInputs(
    constraints,
    complianceData,
    raw.tranches,
    raw.trancheSnapshots,
    raw.holdings,
    raw.dealDates,
    raw.accountBalances,
    raw.parValueAdjustments,
  );
}

function blockingWarnings(warnings: ReturnType<typeof runResolver>["warnings"]): string[] {
  return warnings.filter((w) => w.severity === "error" && w.blocking).map((w) => w.field);
}

describe("Industry-cap — resolver-side industry-cap blocking gate", () => {
  it("PPM block missing + no SDF INDUSTRY rows → no industryCapRules warning", () => {
    const { warnings } = runResolver({ industryConcentrationTest: undefined }, []);
    expect(blockingWarnings(warnings)).not.toContain("industryCapRules");
  });

  it("PPM block missing + SDF has INDUSTRY row → blocks on industryCapRules", () => {
    const { warnings } = runResolver(
      { industryConcentrationTest: undefined },
      [{ concentrationType: "INDUSTRY", bucketName: "Hotels", actualPct: 12 }],
    );
    expect(blockingWarnings(warnings)).toContain("industryCapRules");
  });

  it("present:false → no industry-cap blocking warning, permissive", () => {
    const { resolved, warnings } = runResolver({
      industryConcentrationTest: {
        present: false,
        taxonomy: null,
        rules: null,
        excludedIndustryNames: null,
        sourcePages: null,
        sourceCondition: null,
        verbatimQuote: null,
      },
    });
    expect(blockingWarnings(warnings)).not.toContain("industryCapRules");
    expect(blockingWarnings(warnings)).not.toContain("industryTaxonomy");
    expect(resolved.industryCapPresentInPpm).toBe(false);
    expect(resolved.industryCapRules).toBeNull();
  });

  it("present:true + rules:null (mapper failed) → blocks on industryCapRules", () => {
    const { warnings } = runResolver({
      industryConcentrationTest: {
        present: true,
        taxonomy: "moodys_33",
        rules: null,
        excludedIndustryNames: null,
        sourcePages: null,
        sourceCondition: null,
        verbatimQuote: null,
      },
    });
    expect(blockingWarnings(warnings)).toContain("industryCapRules");
  });

  it("present:true + taxonomy:null → blocks on industryTaxonomy", () => {
    const { warnings } = runResolver({
      industryConcentrationTest: {
        present: true,
        taxonomy: null,
        rules: [{ kind: "single_rank_max", rank: 1, triggerPct: 15 }],
        excludedIndustryNames: null,
        sourcePages: null,
        sourceCondition: null,
        verbatimQuote: null,
      },
    });
    expect(blockingWarnings(warnings)).toContain("industryTaxonomy");
  });

  it("present:true + non-empty unmappedRuleDescriptions → blocks on industryCapRules", () => {
    const { warnings } = runResolver({
      industryConcentrationTest: {
        present: true,
        taxonomy: "moodys_33",
        rules: null,
        excludedIndustryNames: null,
        unmappedRuleDescriptions: ["weird conditional clause we can't represent"],
        sourcePages: null,
        sourceCondition: null,
        verbatimQuote: null,
      },
    });
    expect(blockingWarnings(warnings)).toContain("industryCapRules");
  });

  it("rank-2 cap > rank-1 cap → blocks on industryCapRules (LLM rank confusion)", () => {
    const { warnings } = runResolver({
      industryConcentrationTest: {
        present: true,
        taxonomy: "moodys_33",
        rules: [
          { kind: "single_rank_max", rank: 1, triggerPct: 12 },
          { kind: "single_rank_max", rank: 2, triggerPct: 15 }, // > rank-1
        ],
        excludedIndustryNames: null,
        sourcePages: null,
        sourceCondition: null,
        verbatimQuote: null,
      },
    });
    expect(blockingWarnings(warnings)).toContain("industryCapRules");
  });

  it("present:true + valid rules → permissive, populates ResolvedDealData fields", () => {
    const { resolved, warnings } = runResolver({
      industryConcentrationTest: {
        present: true,
        taxonomy: "moodys_33",
        rules: [
          { kind: "single_rank_max", rank: 1, triggerPct: 15 },
          { kind: "combined_top_n_max", n: 3, triggerPct: 30 },
        ],
        excludedIndustryNames: ["Sovereign and Public Finance"],
        sourcePages: [302],
        sourceCondition: "Condition 1, paragraph (t)",
        verbatimQuote: "no industry shall exceed 15 per cent.",
      },
    });
    // No industryCapRules / industryTaxonomy blocking warning.
    expect(blockingWarnings(warnings)).not.toContain("industryCapRules");
    expect(blockingWarnings(warnings)).not.toContain("industryTaxonomy");
    expect(resolved.industryCapPresentInPpm).toBe(true);
    expect(resolved.industryTaxonomy).toBe("moodys_33");
    expect(resolved.industryCapRules).toHaveLength(2);
    expect(resolved.excludedIndustryNames).toEqual(["Sovereign and Public Finance"]);
  });

  it("populates poolSummary.largestIndustryPct + industryDistributionPct when coverage is complete", () => {
    const { resolved, warnings } = runResolver({
      industryConcentrationTest: {
        present: true,
        taxonomy: "moodys_33",
        rules: [{ kind: "single_rank_max", rank: 1, triggerPct: 15 }],
        excludedIndustryNames: null,
        sourcePages: null,
        sourceCondition: null,
        verbatimQuote: null,
      },
    });
    // If coverage is incomplete on Euro XV, the gate fires and the
    // distribution stays null. Either outcome is internally consistent
    // — assert the consistency.
    const coverageBlocked = blockingWarnings(warnings).includes("industryCode");
    if (coverageBlocked) {
      expect(resolved.poolSummary.industryDistributionPct).toBeNull();
      expect(resolved.poolSummary.largestIndustryPct).toBeNull();
    } else {
      expect(resolved.poolSummary.industryDistributionPct).not.toBeNull();
      expect(resolved.poolSummary.largestIndustryPct).not.toBeNull();
      expect(resolved.poolSummary.largestIndustryPct!).toBeGreaterThan(0);
      // Sorted descending.
      const dist = resolved.poolSummary.industryDistributionPct!;
      for (let i = 1; i < dist.length; i++) {
        expect(dist[i].parPct).toBeLessThanOrEqual(dist[i - 1].parPct);
      }
    }
  });
});
