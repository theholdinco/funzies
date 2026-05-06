/**
 * Industry-cap — taxonomy seed-data integrity. Locks in the load-bearing
 * invariants the rest of the closure relies on:
 *
 *   1. Codes are unique within a taxonomy.
 *   2. Aliases (lowercase) are unique within a taxonomy. An alias collision
 *      would silently bucket two industries together — exactly the
 *      free-text-conflation failure shape industry-cap exists to prevent.
 *   3. Aliases never collide with another industry's canonicalName.
 *   4. lookupByCode + lookupByText round-trip canonical names.
 *   5. selectTaxonomy("deal_specific") returns null (caller routes to
 *      `dealSpecificIndustryList` instead).
 */

import { describe, it, expect } from "vitest";
import { MOODYS_33, SP_INDUSTRIES, selectTaxonomy, lookupByCode, lookupByText } from "..";
import type { IndustryClassification, IndustryTaxonomy } from "..";

function assertNoCollisions(name: string, list: IndustryClassification[]) {
  // Two-pass: build the full canonical-name + alias sets first, then check
  // each alias against every canonical (including LATER entries). The
  // single-pass approach only checked aliases against PRIOR-listed
  // canonicals, missing the alias-of-X-vs-canonical-of-Y (X<Y) shape that
  // would also silently merge two industries via lookupByText.
  const codes = new Set<string>();
  const allCanonicals = new Set<string>();
  const allAliases = new Set<string>();

  for (const entry of list) {
    if (codes.has(entry.code)) {
      throw new Error(`${name}: duplicate code "${entry.code}"`);
    }
    codes.add(entry.code);

    const canonical = entry.canonicalName.toLowerCase();
    if (allCanonicals.has(canonical)) {
      throw new Error(`${name}: duplicate canonicalName "${entry.canonicalName}"`);
    }
    allCanonicals.add(canonical);
  }

  for (const entry of list) {
    const ownCanonical = entry.canonicalName.toLowerCase();
    for (const alias of entry.aliases) {
      const normalized = alias.toLowerCase();
      if (allAliases.has(normalized)) {
        throw new Error(`${name}: duplicate alias "${alias}" (would silently merge industries)`);
      }
      if (allCanonicals.has(normalized) && normalized !== ownCanonical) {
        throw new Error(`${name}: alias "${alias}" of "${entry.canonicalName}" collides with another industry's canonicalName`);
      }
      allAliases.add(normalized);
    }
  }
}

describe("taxonomy seed data integrity", () => {
  it("MOODYS_33 — codes, names, aliases are uniquely keyed", () => {
    assertNoCollisions("MOODYS_33", MOODYS_33);
  });

  it("SP_INDUSTRIES — codes, names, aliases are uniquely keyed", () => {
    assertNoCollisions("SP_INDUSTRIES", SP_INDUSTRIES);
  });

  it("MOODYS_33 has exactly 33 industries", () => {
    expect(MOODYS_33).toHaveLength(33);
  });

  it("SP_INDUSTRIES has exactly 35 industries", () => {
    expect(SP_INDUSTRIES).toHaveLength(35);
  });
});

describe("selectTaxonomy dispatch", () => {
  it.each<[IndustryTaxonomy, IndustryClassification[] | null]>([
    ["moodys_33", MOODYS_33],
    ["sp", SP_INDUSTRIES],
    ["deal_specific", null],
  ])("selectTaxonomy(%s)", (taxonomy, expected) => {
    expect(selectTaxonomy(taxonomy)).toBe(expected);
  });
});

describe("lookupByCode + lookupByText round-trip", () => {
  it("Moody's: code → canonicalName, canonicalName → code", () => {
    const entry = lookupByCode("1010", "moodys_33");
    expect(entry?.canonicalName).toBe("Aerospace and Defense");
    const back = lookupByText("Aerospace and Defense", "moodys_33");
    expect(back?.code).toBe("1010");
  });

  it("S&P: alias → canonical (case-insensitive)", () => {
    const entry = lookupByText("OIL & GAS", "sp");
    expect(entry?.code).toBe("MM31");
    expect(entry?.canonicalName).toBe("Oil and Gas");
  });

  it("unknown text returns null (no silent guess)", () => {
    expect(lookupByText("Underwater Basket Weaving", "moodys_33")).toBeNull();
  });

  it("unknown code returns null", () => {
    expect(lookupByCode("9999", "moodys_33")).toBeNull();
  });

  it("deal_specific taxonomy returns null for any lookup", () => {
    expect(lookupByCode("anything", "deal_specific")).toBeNull();
    expect(lookupByText("anything", "deal_specific")).toBeNull();
  });

  it("empty / whitespace-only text returns null", () => {
    expect(lookupByText("", "moodys_33")).toBeNull();
    expect(lookupByText("   ", "moodys_33")).toBeNull();
  });
});
