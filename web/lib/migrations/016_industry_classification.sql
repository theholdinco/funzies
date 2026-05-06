-- Industry-cap closure: canonical industry classification on the buy list.
--
-- Existing `clo_industry_classifications` table (schema.sql:808) carries the
-- canonical reference list (industry_code, industry_name, classification_system).
-- That table stays as-is; this migration adds the (taxonomy, code) columns
-- to `clo_buy_list_items` so partner-uploaded items can be tagged against
-- the deal's active taxonomy and the D5 industry filter
-- (`buy-list-filter.ts:excludeIndustryCodes`) can match against canonical
-- codes rather than free-text.
--
-- Boundary invariant: industry classification crosses the boundary as
-- (taxonomy, code) — never as a free-text industry name. CHECK constraint
-- pins the taxonomy enum to the same values resolver / engine consume.

ALTER TABLE clo_buy_list_items
  ADD COLUMN IF NOT EXISTS industry_taxonomy TEXT
    CHECK (industry_taxonomy IS NULL OR industry_taxonomy IN ('moodys_33', 'sp', 'deal_specific')),
  ADD COLUMN IF NOT EXISTS industry_code TEXT;
