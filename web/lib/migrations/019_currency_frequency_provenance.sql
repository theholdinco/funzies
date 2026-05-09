-- KI-38/KI-36 provenance hardening.
-- Preserve raw uploaded/extracted strings, canonical model-gating values, and
-- source labels so a fresh reingest can deterministically rebuild currency and
-- liability-frequency evidence without relying on stale generic columns.

ALTER TABLE clo_deals
  ADD COLUMN IF NOT EXISTS deal_currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS deal_currency_canonical TEXT,
  ADD COLUMN IF NOT EXISTS deal_currency_source TEXT;

ALTER TABLE clo_tranches
  ADD COLUMN IF NOT EXISTS currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS currency_canonical TEXT,
  ADD COLUMN IF NOT EXISTS currency_source TEXT,
  ADD COLUMN IF NOT EXISTS payment_frequency_raw TEXT,
  ADD COLUMN IF NOT EXISTS payment_frequency_canonical TEXT,
  ADD COLUMN IF NOT EXISTS payment_frequency_source TEXT;

ALTER TABLE clo_holdings
  ADD COLUMN IF NOT EXISTS currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS currency_canonical TEXT,
  ADD COLUMN IF NOT EXISTS currency_source TEXT,
  ADD COLUMN IF NOT EXISTS native_currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS native_currency_canonical TEXT;

ALTER TABLE clo_account_balances
  ADD COLUMN IF NOT EXISTS currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS currency_canonical TEXT,
  ADD COLUMN IF NOT EXISTS currency_source TEXT;

ALTER TABLE clo_trades
  ADD COLUMN IF NOT EXISTS currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS currency_canonical TEXT,
  ADD COLUMN IF NOT EXISTS currency_source TEXT,
  ADD COLUMN IF NOT EXISTS native_currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS native_currency_canonical TEXT;

ALTER TABLE clo_buy_list_items
  ADD COLUMN IF NOT EXISTS currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS currency_canonical TEXT,
  ADD COLUMN IF NOT EXISTS currency_source TEXT;

ALTER TABLE clo_analyses
  ADD COLUMN IF NOT EXISTS currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS currency_canonical TEXT,
  ADD COLUMN IF NOT EXISTS currency_source TEXT,
  ADD COLUMN IF NOT EXISTS switch_currency_raw TEXT,
  ADD COLUMN IF NOT EXISTS switch_currency_canonical TEXT,
  ADD COLUMN IF NOT EXISTS switch_currency_source TEXT;
