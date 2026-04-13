-- Add Fitch recovery rate column to clo_holdings.
-- The OC test uses the lesser of available agency recovery rates (e.g. "Lesser of Fitch CV and S&P CV").
-- Previously only Moody's and S&P rates were captured.
ALTER TABLE clo_holdings ADD COLUMN IF NOT EXISTS recovery_rate_fitch NUMERIC;
