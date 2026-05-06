/**
 * industry-cap closure — buy-list industry classification service.
 *
 * Service-layer (not UI-layer) per the architectural constraint that
 * semantic computation crosses out of the UI. Free-text → canonical
 * industry mapping under a chosen taxonomy, with three-rung resolution:
 *
 *   1. Per-user alias override (clo_industry_alias_overrides table).
 *      Persisted from prior partner uploads where the partner picked
 *      a canonical industry from the dropdown for an unmatched text;
 *      subsequent uploads of the same text match automatically.
 *   2. Canonical-name + alias match against the taxonomy seed
 *      (services/taxonomies/{moodys-33,sp}.ts).
 *   3. Unmatched — caller surfaces an override prompt to the partner.
 *      No silent guess.
 *
 *  This module is consumed by:
 *   - BuyListUpload UI (free-text → code at upload time)
 *   - D5 filter pre-fill (`buyListFiltersFromResolved` extension —
 *     selecting buckets at-or-near pool caps)
 */

import { query } from "../../db";
import {
  lookupByCode as lookupByCodeRaw,
  lookupByText as lookupByTextRaw,
  type IndustryClassification,
  type IndustryTaxonomy,
} from "./taxonomies";

export type { IndustryClassification, IndustryTaxonomy } from "./taxonomies";

export interface ClassificationResult {
  industryCode: string;
  industryName: string;
  source: "override" | "canonical_name" | "alias";
}

/** Free-text → canonical industry under a given taxonomy.
 *
 *  Returns null when the text doesn't match any canonical name, alias,
 *  or per-user override. Caller routes null to the override-prompt UI
 *  ("partner picks from dropdown").
 *
 *  `userId` is optional — when omitted, only the taxonomy seed lookup
 *  fires (no DB roundtrip). UI calls with userId when authenticated;
 *  pure unit tests pass null. */
export async function classifyIndustry(
  freeText: string,
  taxonomy: IndustryTaxonomy,
  userId?: string | null,
): Promise<ClassificationResult | null> {
  const normalized = freeText.toLowerCase().trim();
  if (normalized.length === 0) return null;

  // Rung 1: per-user override — checked first because partners may
  // explicitly map a text to a non-default canonical (e.g., a partner
  // who treats "Tech" as "High Tech Industries" rather than the broader
  // "Information Technology" alias bucket some other deal might use).
  if (userId) {
    const rows = await query<{ industry_code: string }>(
      `SELECT industry_code
         FROM clo_industry_alias_overrides
        WHERE user_id = $1 AND taxonomy = $2 AND lower(free_text) = $3
        LIMIT 1`,
      [userId, taxonomy, normalized],
    );
    if (rows.length > 0) {
      const entry = lookupByCodeRaw(rows[0].industry_code, taxonomy);
      if (entry) {
        return { industryCode: entry.code, industryName: entry.canonicalName, source: "override" };
      }
    }
  }

  // Rung 2: canonical-name match.
  const canonicalEntry = lookupByTextRaw(freeText, taxonomy);
  if (canonicalEntry) {
    // Distinguish exact-name vs alias for telemetry (UI may want to
    // show "matched via alias 'Tech'" hint on lower-confidence hits).
    const isExactName = canonicalEntry.canonicalName.toLowerCase() === normalized;
    return {
      industryCode: canonicalEntry.code,
      industryName: canonicalEntry.canonicalName,
      source: isExactName ? "canonical_name" : "alias",
    };
  }

  // Rung 3: unmatched — fail closed.
  return null;
}

/** Persist a partner's free-text → canonical mapping as an override.
 *  Called by the UI's "I picked X for Y" flow after the override prompt.
 *  ON CONFLICT preserves the latest mapping (partner can re-classify a
 *  past text by re-uploading). */
export async function recordOverride(
  userId: string,
  taxonomy: IndustryTaxonomy,
  freeText: string,
  industryCode: string,
): Promise<void> {
  const normalized = freeText.trim();
  if (normalized.length === 0) return;
  // Validate the chosen code exists under the taxonomy — fail closed on
  // a fabricated code rather than persisting garbage that future lookups
  // would silently return.
  if (lookupByCodeRaw(industryCode, taxonomy) == null) {
    throw new Error(
      `recordOverride: industryCode ${JSON.stringify(industryCode)} is not a member of taxonomy ${taxonomy}`,
    );
  }
  await query(
    `INSERT INTO clo_industry_alias_overrides (user_id, taxonomy, free_text, industry_code)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, taxonomy, free_text)
       DO UPDATE SET industry_code = EXCLUDED.industry_code,
                     created_at = now()`,
    [userId, taxonomy, normalized, industryCode],
  );
}

/** Bulk classify a partner's CSV uploaded buy-list. Returns the
 *  classified items split into "matched" (with `industryCode` and
 *  `industryTaxonomy` populated) and "unmatched" (caller routes to the
 *  override-prompt UI). The matched items can be persisted directly via
 *  `replaceBuyList`; the unmatched items wait for the partner's
 *  per-row classification. */
export async function classifyBuyListFreeTexts(
  rows: ReadonlyArray<{ sector: string | null }>,
  taxonomy: IndustryTaxonomy,
  userId?: string | null,
): Promise<Array<{ row: { sector: string | null }; classification: ClassificationResult | null }>> {
  return Promise.all(
    rows.map(async (row) => ({
      row,
      classification:
        row.sector != null && row.sector.length > 0
          ? await classifyIndustry(row.sector, taxonomy, userId)
          : null,
    })),
  );
}

/** Re-export the offline (no-DB) helpers from the taxonomy seed for
 *  callers that don't need override resolution. UI testing typically
 *  uses these directly to avoid spinning up a DB. */
export { lookupByCode, lookupByText, selectTaxonomy } from "./taxonomies";
