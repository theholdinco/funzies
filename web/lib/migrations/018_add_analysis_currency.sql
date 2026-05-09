-- KI-38 currency boundary for credit/switch analyses.
--
-- These text fields preserve user/buy-list currency evidence through the AI
-- analysis workflow and into the waterfall switch prefill. Projection still
-- blocks when the currency is missing or non-deal-currency.

ALTER TABLE clo_analyses
  ADD COLUMN IF NOT EXISTS currency TEXT,
  ADD COLUMN IF NOT EXISTS switch_currency TEXT;
