-- Asset-interest schedule fields for candidate buy-list loans.
--
-- Switch simulation can only preserve borrower-interest timing on buy legs if
-- uploaded candidates keep their payment period, payment-date anchor, and
-- opening receivable evidence through persistence.

ALTER TABLE clo_buy_list_items
  ADD COLUMN IF NOT EXISTS asset_payment_period_raw TEXT,
  ADD COLUMN IF NOT EXISTS asset_payment_interval_months NUMERIC,
  ADD COLUMN IF NOT EXISTS next_payment_date TEXT,
  ADD COLUMN IF NOT EXISTS accrual_begin_date TEXT,
  ADD COLUMN IF NOT EXISTS accrual_end_date TEXT,
  ADD COLUMN IF NOT EXISTS opening_accrued_interest NUMERIC;
