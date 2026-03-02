-- Ensure all CLO tables and columns exist
-- Safe to run multiple times (IF NOT EXISTS / IF NOT EXISTS throughout)

-- Tables that may not exist if schema.sql was run before they were added
CREATE TABLE IF NOT EXISTS clo_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL UNIQUE REFERENCES clo_profiles(id) ON DELETE CASCADE,
  deal_name TEXT,
  deal_short_name TEXT,
  issuer_legal_entity TEXT,
  jurisdiction TEXT,
  deal_currency TEXT,
  closing_date TEXT,
  effective_date TEXT,
  reinvestment_period_end TEXT,
  non_call_period_end TEXT,
  stated_maturity_date TEXT,
  wal_test_date TEXT,
  deal_type TEXT,
  deal_version TEXT,
  trustee_name TEXT,
  collateral_manager TEXT,
  collateral_administrator TEXT,
  governing_document TEXT,
  governing_law TEXT,
  ppm_constraints JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clo_report_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES clo_deals(id) ON DELETE CASCADE,
  report_date TEXT NOT NULL,
  payment_date TEXT,
  previous_payment_date TEXT,
  report_type TEXT CHECK (report_type IN ('quarterly', 'semi-annual', 'annual', 'ad-hoc')),
  report_source TEXT,
  reporting_period_start TEXT,
  reporting_period_end TEXT,
  is_final BOOLEAN DEFAULT false,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'extracting', 'complete', 'partial', 'error')),
  extracted_at TIMESTAMPTZ,
  raw_extraction JSONB,
  supplementary_data JSONB,
  data_quality JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(deal_id, report_date)
);
CREATE INDEX IF NOT EXISTS idx_clo_report_periods_deal_date ON clo_report_periods(deal_id, report_date);

CREATE TABLE IF NOT EXISTS clo_tranches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES clo_deals(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  isin TEXT,
  cusip TEXT,
  common_code TEXT,
  currency TEXT,
  original_balance NUMERIC,
  seniority_rank INTEGER,
  is_floating BOOLEAN,
  reference_rate TEXT,
  reference_rate_tenor TEXT,
  spread_bps NUMERIC,
  coupon_floor NUMERIC,
  coupon_cap NUMERIC,
  day_count_convention TEXT,
  payment_frequency TEXT,
  is_deferrable BOOLEAN,
  is_pik BOOLEAN,
  rating_moodys TEXT,
  rating_sp TEXT,
  rating_fitch TEXT,
  rating_dbrs TEXT,
  is_subordinate BOOLEAN,
  is_income_note BOOLEAN
);

CREATE TABLE IF NOT EXISTS clo_tranche_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tranche_id UUID NOT NULL REFERENCES clo_tranches(id) ON DELETE CASCADE,
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  current_balance NUMERIC,
  factor NUMERIC,
  current_index_rate NUMERIC,
  coupon_rate NUMERIC,
  deferred_interest_balance NUMERIC,
  enhancement_pct NUMERIC,
  beginning_balance NUMERIC,
  ending_balance NUMERIC,
  interest_accrued NUMERIC,
  interest_paid NUMERIC,
  interest_shortfall NUMERIC,
  cumulative_shortfall NUMERIC,
  principal_paid NUMERIC,
  days_accrued INTEGER
);

CREATE TABLE IF NOT EXISTS clo_holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  obligor_name TEXT,
  facility_name TEXT,
  isin TEXT,
  lxid TEXT,
  asset_type TEXT,
  currency TEXT,
  country TEXT,
  industry_code TEXT,
  industry_description TEXT,
  moodys_industry TEXT,
  sp_industry TEXT,
  is_cov_lite BOOLEAN,
  is_revolving BOOLEAN,
  is_delayed_draw BOOLEAN,
  is_defaulted BOOLEAN,
  is_pik BOOLEAN,
  is_fixed_rate BOOLEAN,
  is_discount_obligation BOOLEAN,
  is_long_dated BOOLEAN,
  settlement_status TEXT,
  acquisition_date TEXT,
  maturity_date TEXT,
  par_balance NUMERIC,
  principal_balance NUMERIC,
  market_value NUMERIC,
  purchase_price NUMERIC,
  current_price NUMERIC,
  accrued_interest NUMERIC,
  reference_rate TEXT,
  index_rate NUMERIC,
  spread_bps NUMERIC,
  all_in_rate NUMERIC,
  floor_rate NUMERIC,
  moodys_rating TEXT,
  moodys_rating_source TEXT,
  sp_rating TEXT,
  sp_rating_source TEXT,
  fitch_rating TEXT,
  composite_rating TEXT,
  rating_factor NUMERIC,
  recovery_rate_moodys NUMERIC,
  recovery_rate_sp NUMERIC,
  remaining_life_years NUMERIC,
  warf_contribution NUMERIC,
  diversity_score_group TEXT
);
CREATE INDEX IF NOT EXISTS idx_clo_holdings_period ON clo_holdings(report_period_id);

CREATE TABLE IF NOT EXISTS clo_pool_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL UNIQUE REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  total_par NUMERIC,
  total_principal_balance NUMERIC,
  total_market_value NUMERIC,
  number_of_obligors INTEGER,
  number_of_assets INTEGER,
  number_of_industries INTEGER,
  number_of_countries INTEGER,
  target_par NUMERIC,
  par_surplus_deficit NUMERIC,
  wac_spread NUMERIC,
  wac_total NUMERIC,
  wal_years NUMERIC,
  warf NUMERIC,
  diversity_score NUMERIC,
  wa_recovery_rate NUMERIC,
  wa_moodys_recovery NUMERIC,
  wa_sp_recovery NUMERIC,
  pct_fixed_rate NUMERIC,
  pct_floating_rate NUMERIC,
  pct_cov_lite NUMERIC,
  pct_second_lien NUMERIC,
  pct_senior_secured NUMERIC,
  pct_bonds NUMERIC,
  pct_current_pay NUMERIC,
  pct_defaulted NUMERIC,
  pct_ccc_and_below NUMERIC,
  pct_single_b NUMERIC,
  pct_discount_obligations NUMERIC,
  pct_long_dated NUMERIC,
  pct_semi_annual_pay NUMERIC,
  pct_quarterly_pay NUMERIC,
  pct_eur_denominated NUMERIC,
  pct_gbp_denominated NUMERIC,
  pct_usd_denominated NUMERIC,
  pct_non_base_currency NUMERIC
);

CREATE TABLE IF NOT EXISTS clo_compliance_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  test_name TEXT NOT NULL,
  test_type TEXT,
  test_class TEXT,
  numerator NUMERIC,
  denominator NUMERIC,
  actual_value NUMERIC,
  trigger_level NUMERIC,
  threshold_level NUMERIC,
  cushion_pct NUMERIC,
  cushion_amount NUMERIC,
  is_passing BOOLEAN,
  cure_amount NUMERIC,
  consequence_if_fail TEXT,
  matrix_row TEXT,
  matrix_column TEXT,
  test_methodology TEXT,
  adjustment_description TEXT,
  is_active BOOLEAN DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_clo_compliance_tests_period_type ON clo_compliance_tests(report_period_id, test_type);

CREATE TABLE IF NOT EXISTS clo_concentrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  concentration_type TEXT NOT NULL,
  bucket_name TEXT NOT NULL,
  actual_value NUMERIC,
  actual_pct NUMERIC,
  limit_value NUMERIC,
  limit_pct NUMERIC,
  excess_amount NUMERIC,
  is_passing BOOLEAN,
  is_haircut_applied BOOLEAN,
  haircut_amount NUMERIC,
  obligor_count INTEGER,
  asset_count INTEGER,
  rating_factor_avg NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_clo_concentrations_period_type ON clo_concentrations(report_period_id, concentration_type);

CREATE TABLE IF NOT EXISTS clo_waterfall_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  waterfall_type TEXT,
  priority_order INTEGER,
  description TEXT,
  payee TEXT,
  amount_due NUMERIC,
  amount_paid NUMERIC,
  shortfall NUMERIC,
  funds_available_before NUMERIC,
  funds_available_after NUMERIC,
  is_oc_test_diversion BOOLEAN,
  is_ic_test_diversion BOOLEAN
);

CREATE TABLE IF NOT EXISTS clo_account_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  account_name TEXT NOT NULL,
  account_type TEXT,
  currency TEXT,
  balance_amount NUMERIC,
  required_balance NUMERIC,
  excess_deficit NUMERIC
);

CREATE TABLE IF NOT EXISTS clo_proceeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  proceeds_type TEXT,
  source_description TEXT,
  amount NUMERIC,
  period_start TEXT,
  period_end TEXT
);

CREATE TABLE IF NOT EXISTS clo_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  trade_type TEXT,
  obligor_name TEXT,
  facility_name TEXT,
  trade_date TEXT,
  settlement_date TEXT,
  par_amount NUMERIC,
  settlement_price NUMERIC,
  settlement_amount NUMERIC,
  realized_gain_loss NUMERIC,
  accrued_interest_traded NUMERIC,
  currency TEXT,
  counterparty TEXT,
  is_credit_risk_sale BOOLEAN,
  is_credit_improved BOOLEAN,
  is_discretionary BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_clo_trades_period ON clo_trades(report_period_id);

CREATE TABLE IF NOT EXISTS clo_trading_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL UNIQUE REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  total_purchases_par NUMERIC,
  total_purchases_cost NUMERIC,
  total_sales_par NUMERIC,
  total_sales_proceeds NUMERIC,
  net_gain_loss NUMERIC,
  total_paydowns NUMERIC,
  total_prepayments NUMERIC,
  total_defaults_par NUMERIC,
  total_recoveries NUMERIC,
  turnover_rate NUMERIC,
  credit_risk_sales_par NUMERIC,
  discretionary_sales_par NUMERIC,
  remaining_discretionary_allowance NUMERIC
);

CREATE TABLE IF NOT EXISTS clo_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES clo_deals(id) ON DELETE CASCADE,
  report_period_id UUID REFERENCES clo_report_periods(id) ON DELETE SET NULL,
  event_type TEXT,
  event_date TEXT,
  description TEXT,
  is_event_of_default BOOLEAN,
  is_cured BOOLEAN,
  cure_date TEXT,
  impact_description TEXT
);
CREATE INDEX IF NOT EXISTS idx_clo_events_deal_type ON clo_events(deal_id, event_type);

CREATE TABLE IF NOT EXISTS clo_par_value_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  test_name TEXT,
  adjustment_type TEXT,
  description TEXT,
  gross_amount NUMERIC,
  adjustment_amount NUMERIC,
  net_amount NUMERIC,
  calculation_method TEXT
);

CREATE TABLE IF NOT EXISTS clo_extraction_overflow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  extraction_pass INTEGER,
  source_section TEXT,
  label TEXT,
  content JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clo_rating_factor_map (
  rating TEXT PRIMARY KEY,
  rating_factor NUMERIC,
  sp_equivalent TEXT,
  default_probability_1y NUMERIC,
  default_probability_5y NUMERIC
);

CREATE TABLE IF NOT EXISTS clo_industry_classifications (
  industry_code TEXT PRIMARY KEY,
  industry_name TEXT NOT NULL,
  classification_system TEXT CHECK (classification_system IN ('Moodys_33', 'SP', 'GICS', 'ICB')),
  parent_sector TEXT
);

-- Columns that may be missing on existing tables
ALTER TABLE clo_report_periods ADD COLUMN IF NOT EXISTS data_quality JSONB;
ALTER TABLE clo_report_periods ADD COLUMN IF NOT EXISTS supplementary_data JSONB;
ALTER TABLE clo_report_periods ADD COLUMN IF NOT EXISTS raw_extraction JSONB;
ALTER TABLE clo_report_periods ADD COLUMN IF NOT EXISTS is_final BOOLEAN DEFAULT false;
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS ppm_extracted_at TIMESTAMPTZ;
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS ppm_raw_extraction JSONB;
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS ppm_extraction_status TEXT DEFAULT NULL;
