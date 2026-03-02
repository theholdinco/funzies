-- Relax CHECK constraints on CLO extraction tables.
-- The extraction prompts guide Claude to use standard values, but strict
-- constraints crash the entire extraction if a single value is unexpected.

-- Drop CHECK constraints on enum-like columns (constraint names follow pg convention: table_column_check)
-- We use DO blocks because ALTER TABLE ... DROP CONSTRAINT IF EXISTS isn't supported in all pg versions.

DO $$ BEGIN
  ALTER TABLE clo_compliance_tests DROP CONSTRAINT IF EXISTS clo_compliance_tests_test_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE clo_concentrations DROP CONSTRAINT IF EXISTS clo_concentrations_concentration_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE clo_waterfall_steps DROP CONSTRAINT IF EXISTS clo_waterfall_steps_waterfall_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE clo_account_balances DROP CONSTRAINT IF EXISTS clo_account_balances_account_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE clo_proceeds DROP CONSTRAINT IF EXISTS clo_proceeds_proceeds_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE clo_trades DROP CONSTRAINT IF EXISTS clo_trades_trade_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE clo_events DROP CONSTRAINT IF EXISTS clo_events_event_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE clo_par_value_adjustments DROP CONSTRAINT IF EXISTS clo_par_value_adjustments_adjustment_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
