/**
 * D5 — Buy-list compliance filter (Sprint 4).
 *
 * Tests the four enforceable filters (WARF, min spread, excludeCaa,
 * excludeCovLite), the pre-fill from resolved quality tests, and the
 * passed-vs-dropped accounting. Industry cap is explicitly out of scope
 * (see ledger).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  filterBuyList,
  buyListFiltersFromResolved,
  type BuyListFilterParams,
} from "@/lib/clo/buy-list-filter";
import type { BuyListItem } from "@/lib/clo/types";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { resolved: ResolvedDealData };

/** Minimal BuyListItem factory. `id` / `profileId` / `createdAt` set to
 *  stable strings so tests don't depend on DB-originated values. */
function makeItem(overrides: Partial<BuyListItem>): BuyListItem {
  return {
    id: "test-id",
    profileId: "test-profile",
    obligorName: "Test Obligor",
    facilityName: null,
    sector: null,
    industryTaxonomy: null,
    industryCode: null,
    moodysRating: null,
    spRating: null,
    spreadBps: null,
    referenceRate: null,
    price: null,
    maturityDate: null,
    facilitySize: null,
    leverage: null,
    interestCoverage: null,
    isCovLite: null,
    averageLifeYears: null,
    recoveryRate: null,
    notes: null,
    createdAt: "",
    ...overrides,
  };
}

describe("D5 — maxWarfFactor filter", () => {
  it("drops items whose Moody's rating maps above the WARF cap", () => {
    const items = [
      makeItem({ obligorName: "A", moodysRating: "Ba2" }), // factor 1350
      makeItem({ obligorName: "B", moodysRating: "B2" }), // factor 2720
      makeItem({ obligorName: "C", moodysRating: "Caa2" }), // factor 6500
    ];
    const result = filterBuyList(items, { maxWarfFactor: 3000 });
    expect(result.passed.map((i) => i.obligorName)).toEqual(["A", "B"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].item.obligorName).toBe("C");
    expect(result.dropped[0].reasons[0]).toMatch(/WARF 6500 > cap 3000/);
  });

  it("unrated items treated as Caa2 (WARF 6500) per Moody's convention — KI-19 consistency", () => {
    // Changed from the earlier "unrated passes" permissive semantic after
    // review: engine-side WARF uses Caa2 fallback for NR loans (KI-19);
    // filter must match to avoid silently passing candidates that the
    // engine would treat as high-risk.
    const items = [makeItem({ obligorName: "Unrated", moodysRating: null })];
    // cap 3000 < 6500 fallback → dropped
    const resultTight = filterBuyList(items, { maxWarfFactor: 3000 });
    expect(resultTight.passed).toHaveLength(0);
    expect(resultTight.dropped).toHaveLength(1);
    expect(resultTight.dropped[0].reasons[0]).toMatch(/WARF 6500 > cap 3000.*Caa2/);
    // cap 7000 > 6500 fallback → passes
    const resultLoose = filterBuyList(items, { maxWarfFactor: 7000 });
    expect(resultLoose.passed).toHaveLength(1);
  });

  it("null maxWarfFactor disables the filter", () => {
    const items = [makeItem({ moodysRating: "Caa3" })];
    const result = filterBuyList(items, { maxWarfFactor: null });
    expect(result.passed).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });
});

describe("D5 — minSpreadBps filter", () => {
  it("drops items with spread below floor", () => {
    const items = [
      makeItem({ obligorName: "low", spreadBps: 300 }),
      makeItem({ obligorName: "mid", spreadBps: 400 }),
      makeItem({ obligorName: "high", spreadBps: 500 }),
    ];
    const result = filterBuyList(items, { minSpreadBps: 365 });
    expect(result.passed.map((i) => i.obligorName)).toEqual(["mid", "high"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reasons[0]).toMatch(/spread 300 bps < floor 365 bps/);
  });

  it("passes items with null spreadBps (unknown, don't drop)", () => {
    const items = [makeItem({ spreadBps: null })];
    const result = filterBuyList(items, { minSpreadBps: 365 });
    expect(result.passed).toHaveLength(1);
  });
});

describe("D5 — excludeCaa filter", () => {
  it("drops Caa1/Caa2/Caa3/Ca/C when enabled", () => {
    const items = [
      makeItem({ obligorName: "Ba2", moodysRating: "Ba2" }),
      makeItem({ obligorName: "B3", moodysRating: "B3" }),
      makeItem({ obligorName: "Caa1", moodysRating: "Caa1" }),
      makeItem({ obligorName: "Caa3", moodysRating: "Caa3 (sf)" }), // suffix-tolerant
      makeItem({ obligorName: "Ca", moodysRating: "Ca" }),
      makeItem({ obligorName: "C", moodysRating: "C" }),
    ];
    const result = filterBuyList(items, { excludeCaa: true });
    expect(result.passed.map((i) => i.obligorName)).toEqual(["Ba2", "B3"]);
    expect(result.dropped.map((d) => d.item.obligorName).sort()).toEqual(
      ["C", "Ca", "Caa1", "Caa3"].sort(),
    );
  });

  it("default (undefined) does not drop Caa", () => {
    const items = [makeItem({ moodysRating: "Caa2" })];
    const result = filterBuyList(items, {});
    expect(result.passed).toHaveLength(1);
  });
});

describe("D5 — excludeCovLite filter", () => {
  it("drops items with isCovLite === true; passes null (unknown) and false", () => {
    const items = [
      makeItem({ obligorName: "covLite", isCovLite: true }),
      makeItem({ obligorName: "nonCovLite", isCovLite: false }),
      makeItem({ obligorName: "unknown", isCovLite: null }),
    ];
    const result = filterBuyList(items, { excludeCovLite: true });
    expect(result.passed.map((i) => i.obligorName).sort()).toEqual(["nonCovLite", "unknown"].sort());
    expect(result.dropped.map((d) => d.item.obligorName)).toEqual(["covLite"]);
  });
});

describe("D5 — multiple filters compose with reason accumulation", () => {
  it("item failing multiple filters lists all reasons", () => {
    const items = [
      makeItem({
        obligorName: "fail-all",
        moodysRating: "Caa3",
        spreadBps: 100,
        isCovLite: true,
      }),
    ];
    const filters: BuyListFilterParams = {
      maxWarfFactor: 3000,
      minSpreadBps: 365,
      excludeCaa: true,
      excludeCovLite: true,
    };
    const result = filterBuyList(items, filters);
    expect(result.passed).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reasons).toHaveLength(4);
  });
});

describe("D5 — pre-fill from resolved.qualityTests", () => {
  it("extracts Moody's WARF cap (3148) + Minimum WAS × 100 (365) from Euro XV fixture", () => {
    const filters = buyListFiltersFromResolved(fixture.resolved);
    expect(filters.maxWarfFactor).toBe(3148);
    // Minimum WAS trigger = 3.65% → 365 bps after × 100 conversion.
    expect(filters.minSpreadBps).toBe(365);
    // Binary flags NOT auto-enabled — partner opts in.
    expect(filters.excludeCaa).toBeUndefined();
    expect(filters.excludeCovLite).toBeUndefined();
  });
});

describe("D5 — Euro XV integration: pre-fill × filter pipeline", () => {
  it("end-to-end: pre-filled filters applied to a synthetic buy list drop the expected candidates", () => {
    const filters = buyListFiltersFromResolved(fixture.resolved);
    const items = [
      makeItem({ obligorName: "pass", moodysRating: "Ba3", spreadBps: 400 }),
      makeItem({ obligorName: "warf-fail", moodysRating: "Caa2", spreadBps: 400 }), // WARF 6500 > 3148
      makeItem({ obligorName: "spread-fail", moodysRating: "B2", spreadBps: 300 }), // 300 < 365
      makeItem({ obligorName: "both-fail", moodysRating: "Caa3", spreadBps: 200 }),
    ];
    const result = filterBuyList(items, filters);
    expect(result.passed.map((i) => i.obligorName)).toEqual(["pass"]);
    expect(result.dropped).toHaveLength(3);
  });
});

describe("Industry-cap — industry filter (excludeIndustryCodes)", () => {
  it("drops items whose industryCode matches the blacklist", () => {
    const items = [
      makeItem({ obligorName: "tech-a", industryCode: "1160", industryTaxonomy: "moodys_33" }),
      makeItem({ obligorName: "auto-a", industryCode: "1020", industryTaxonomy: "moodys_33" }),
      makeItem({ obligorName: "untagged", industryCode: null, industryTaxonomy: null }),
    ];
    const result = filterBuyList(items, { excludeIndustryCodes: ["1160"] });
    expect(result.passed.map((i) => i.obligorName)).toEqual(["auto-a", "untagged"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].item.obligorName).toBe("tech-a");
  });

  it("untagged items pass even when excludeIndustryCodes is non-empty (D5 doesn't classify)", () => {
    const items = [
      makeItem({ obligorName: "untagged", industryCode: null, industryTaxonomy: null }),
    ];
    const result = filterBuyList(items, { excludeIndustryCodes: ["anything", "even-this"] });
    expect(result.passed).toHaveLength(1);
  });

  it("buyListFiltersFromResolved pre-fills excludeIndustryCodes from at-or-over-cap industries", () => {
    const taggedResolved: typeof fixture.resolved = {
      ...fixture.resolved,
      industryCapRules: [{ kind: "single_rank_max", rank: 1, triggerPct: 15 }],
      industryCapPresentInPpm: true,
      industryTaxonomy: "moodys_33",
      poolSummary: {
        ...fixture.resolved.poolSummary,
        industryDistributionPct: [
          { industryCode: "1160", industryName: "High Tech", parPct: 15.2 }, // at-or-over cap
          { industryCode: "1020", industryName: "Automotive", parPct: 8 },
        ],
        largestIndustryPct: 15.2,
      },
    };
    const filters = buyListFiltersFromResolved(taggedResolved);
    expect(filters.excludeIndustryCodes).toEqual(["1160"]);
  });

  it("buyListFiltersFromResolved does NOT flag buckets under cap (no fabricated cushion)", () => {
    const taggedResolved: typeof fixture.resolved = {
      ...fixture.resolved,
      industryCapRules: [{ kind: "single_rank_max", rank: 1, triggerPct: 15 }],
      industryCapPresentInPpm: true,
      industryTaxonomy: "moodys_33",
      poolSummary: {
        ...fixture.resolved.poolSummary,
        industryDistributionPct: [
          { industryCode: "1160", industryName: "High Tech", parPct: 14.5 }, // close but under
          { industryCode: "1020", industryName: "Automotive", parPct: 8 },
        ],
        largestIndustryPct: 14.5,
      },
    };
    const filters = buyListFiltersFromResolved(taggedResolved);
    expect(filters.excludeIndustryCodes).toEqual([]);
  });

  it("buyListFiltersFromResolved returns empty excludeIndustryCodes when no rules / no distribution", () => {
    const filters = buyListFiltersFromResolved(fixture.resolved);
    expect(filters.excludeIndustryCodes).toEqual([]);
  });
});
