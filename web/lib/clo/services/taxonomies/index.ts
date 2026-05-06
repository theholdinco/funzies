/**
 * Taxonomy module barrel — industry-cap closure.
 *
 * Re-exports the canonical industry classification lists + the
 * `selectTaxonomy` helper that resolves a `IndustryTaxonomy` enum value to
 * the corresponding canonical list. `deal_specific` resolves to null —
 * caller must consume `ResolvedDealData.dealSpecificIndustryList` instead.
 */

import type { IndustryClassification, IndustryTaxonomy } from "./types";
import { MOODYS_33 } from "./moodys-33";
import { SP_INDUSTRIES } from "./sp";

export type { IndustryClassification, IndustryTaxonomy } from "./types";
export { MOODYS_33 } from "./moodys-33";
export { SP_INDUSTRIES } from "./sp";

export function selectTaxonomy(taxonomy: IndustryTaxonomy): IndustryClassification[] | null {
  switch (taxonomy) {
    case "moodys_33":
      return MOODYS_33;
    case "sp":
      return SP_INDUSTRIES;
    case "deal_specific":
      return null;
  }
}

/** Resolve an industry code under a given taxonomy to its canonical entry.
 *  Returns null when the code is not in the taxonomy. */
export function lookupByCode(
  code: string,
  taxonomy: IndustryTaxonomy,
): IndustryClassification | null {
  const list = selectTaxonomy(taxonomy);
  if (!list) return null;
  return list.find((entry) => entry.code === code) ?? null;
}

/** Resolve a free-text industry name under a given taxonomy via canonical-name
 *  match or alias match. Lowercase-normalized comparison. Returns null when
 *  no match — caller surfaces an override flow. */
export function lookupByText(
  freeText: string,
  taxonomy: IndustryTaxonomy,
): IndustryClassification | null {
  const list = selectTaxonomy(taxonomy);
  if (!list) return null;
  const normalized = freeText.toLowerCase().trim();
  if (normalized.length === 0) return null;
  for (const entry of list) {
    if (entry.canonicalName.toLowerCase() === normalized) return entry;
    if (entry.aliases.some((a) => a.toLowerCase() === normalized)) return entry;
  }
  return null;
}
