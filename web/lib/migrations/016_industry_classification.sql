-- Industry-cap closure (PR1): canonical industry classification on the buy list +
-- per-user alias overrides for free-text → canonical mapping.
--
-- Existing `clo_industry_classifications` table (schema.sql:808) carries the
-- canonical reference list (industry_code, industry_name, classification_system).
-- That table stays as-is; this migration adds the consumer columns + override
-- table without modifying it.
--
-- Anti-pattern #5: industry classification crosses the boundary as
-- (taxonomy, code) — never as a free-text industry name. CHECK constraints
-- pin the taxonomy enum to the same values used by `clo_industry_classifications`.

ALTER TABLE clo_buy_list_items
  ADD COLUMN IF NOT EXISTS industry_taxonomy TEXT
    CHECK (industry_taxonomy IS NULL OR industry_taxonomy IN ('moodys_33', 'sp', 'deal_specific')),
  ADD COLUMN IF NOT EXISTS industry_code TEXT;

-- Per-user alias overrides. When the partner uploads a CSV with a free-text
-- sector that doesn't match any canonical industry under the active taxonomy,
-- they pick from a dropdown; the (free_text, code) pair persists here so the
-- next upload of identical text matches automatically.
--
-- Per-user (not per-team) because the schema's natural scope unit is
-- `clo_profiles.user_id UNIQUE` — there is no team primitive.
CREATE TABLE IF NOT EXISTS clo_industry_alias_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taxonomy TEXT NOT NULL
    CHECK (taxonomy IN ('moodys_33', 'sp', 'deal_specific')),
  free_text TEXT NOT NULL,
  industry_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, taxonomy, free_text)
);
CREATE INDEX IF NOT EXISTS idx_clo_industry_alias_user_taxonomy
  ON clo_industry_alias_overrides(user_id, taxonomy);
