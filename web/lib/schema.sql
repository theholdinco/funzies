CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT,
  encrypted_api_key BYTEA,
  api_key_iv BYTEA,
  api_key_prefix TEXT,
  api_key_valid BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assemblies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  topic_input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'error', 'cancelled')),
  current_phase TEXT,
  raw_files JSONB DEFAULT '{}',
  parsed_data JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS github_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  github_username TEXT NOT NULL,
  github_avatar_url TEXT,
  encrypted_token BYTEA NOT NULL,
  token_iv BYTEA NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE assemblies
  ADD COLUMN IF NOT EXISTS github_repo_owner TEXT,
  ADD COLUMN IF NOT EXISTS github_repo_name TEXT,
  ADD COLUMN IF NOT EXISTS github_repo_branch TEXT DEFAULT 'main';

ALTER TABLE assemblies
  ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]';

ALTER TABLE assemblies
  DROP CONSTRAINT IF EXISTS assemblies_status_check;

ALTER TABLE assemblies
  ADD CONSTRAINT assemblies_status_check
  CHECK (status IN ('queued', 'running', 'complete', 'error', 'cancelled', 'uploading'));

ALTER TABLE assemblies
  ADD COLUMN IF NOT EXISTS share_code TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS share_role TEXT CHECK (share_role IN ('read', 'write'));

CREATE TABLE IF NOT EXISTS assembly_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assembly_id UUID NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('read', 'write')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assembly_id, user_id)
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assembly_id UUID NOT NULL REFERENCES assemblies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ask-assembly', 'ask-character', 'ask-library', 'debate')),
  is_challenge BOOLEAN DEFAULT FALSE,
  context_page TEXT,
  context_section TEXT,
  highlighted_text TEXT,
  attachments JSONB DEFAULT '[]',
  response_md TEXT,
  responses JSONB DEFAULT '[]',
  insight JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Investment Committee (IC) tables
-- ============================================================

CREATE TABLE IF NOT EXISTS investor_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  investment_philosophy TEXT,
  risk_tolerance TEXT CHECK (risk_tolerance IN ('conservative', 'moderate', 'aggressive')),
  asset_classes JSONB DEFAULT '[]',
  current_portfolio TEXT,
  geographic_preferences TEXT,
  esg_preferences TEXT,
  decision_style TEXT,
  aum_range TEXT,
  time_horizons JSONB DEFAULT '{}',
  beliefs_and_biases TEXT,
  raw_questionnaire JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ic_committees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL UNIQUE REFERENCES investor_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'generating', 'active', 'error')),
  members JSONB DEFAULT '[]',
  avatar_mappings JSONB DEFAULT '{}',
  raw_files JSONB DEFAULT '{}',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ic_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id UUID NOT NULL REFERENCES ic_committees(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  opportunity_type TEXT,
  company_name TEXT,
  thesis TEXT,
  terms TEXT,
  details JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'error', 'uploading')),
  current_phase TEXT,
  raw_files JSONB DEFAULT '{}',
  parsed_data JSONB DEFAULT '{}',
  dynamic_specialists JSONB DEFAULT '[]',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ic_follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id UUID NOT NULL REFERENCES ic_evaluations(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ask-committee'
    CHECK (mode IN ('ask-committee', 'ask-member', 'debate')),
  target_member TEXT,
  response_md TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ic_ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  committee_id UUID NOT NULL REFERENCES ic_committees(id) ON DELETE CASCADE,
  focus_area TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'error')),
  current_phase TEXT,
  raw_files JSONB DEFAULT '{}',
  parsed_data JSONB DEFAULT '{}',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- ============================================================
-- CLO Credit Analysis tables
-- ============================================================

CREATE TABLE IF NOT EXISTS clo_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  fund_strategy TEXT,
  target_sectors TEXT,
  risk_appetite TEXT CHECK (risk_appetite IN ('conservative', 'moderate', 'aggressive')),
  portfolio_size TEXT,
  reinvestment_period TEXT,
  concentration_limits TEXT,
  covenant_preferences TEXT,
  rating_thresholds TEXT,
  spread_targets TEXT,
  regulatory_constraints TEXT,
  portfolio_description TEXT,
  beliefs_and_biases TEXT,
  raw_questionnaire JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clo_panels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL UNIQUE REFERENCES clo_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'generating', 'active', 'error')),
  members JSONB DEFAULT '[]',
  avatar_mappings JSONB DEFAULT '{}',
  raw_files JSONB DEFAULT '{}',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clo_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id UUID NOT NULL REFERENCES clo_panels(id) ON DELETE CASCADE,
  analysis_type TEXT NOT NULL DEFAULT 'buy' CHECK (analysis_type IN ('buy', 'switch')),
  title TEXT NOT NULL,
  borrower_name TEXT,
  sector TEXT,
  loan_type TEXT,
  spread_coupon TEXT,
  rating TEXT,
  maturity TEXT,
  facility_size TEXT,
  leverage TEXT,
  interest_coverage TEXT,
  covenants_summary TEXT,
  ebitda TEXT,
  revenue TEXT,
  company_description TEXT,
  notes TEXT,
  switch_borrower_name TEXT,
  switch_sector TEXT,
  switch_loan_type TEXT,
  switch_spread_coupon TEXT,
  switch_rating TEXT,
  switch_maturity TEXT,
  switch_facility_size TEXT,
  switch_leverage TEXT,
  switch_interest_coverage TEXT,
  switch_covenants_summary TEXT,
  switch_ebitda TEXT,
  switch_revenue TEXT,
  switch_company_description TEXT,
  switch_notes TEXT,
  documents JSONB DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'error', 'uploading')),
  current_phase TEXT,
  raw_files JSONB DEFAULT '{}',
  parsed_data JSONB DEFAULT '{}',
  dynamic_specialists JSONB DEFAULT '[]',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clo_follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id UUID NOT NULL REFERENCES clo_analyses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ask-panel'
    CHECK (mode IN ('ask-panel', 'ask-member', 'debate')),
  target_member TEXT,
  response_md TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_api_tokens_hash ON user_api_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_user_api_tokens_user ON user_api_tokens (user_id);

-- ============================================================
-- Monitoring / Analytics
-- ============================================================

CREATE TABLE IF NOT EXISTS ic_monitoring_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'evaluation_started', 'evaluation_phase_complete', 'evaluation_complete',
    'evaluation_error', 'parser_error', 'api_error',
    'committee_started', 'committee_complete', 'committee_error',
    'idea_started', 'idea_complete', 'idea_error'
  )),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('committee', 'evaluation', 'idea')),
  entity_id UUID NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  phase TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_monitoring_events_type ON ic_monitoring_events (event_type);
CREATE INDEX IF NOT EXISTS idx_monitoring_events_created ON ic_monitoring_events (created_at);
CREATE INDEX IF NOT EXISTS idx_monitoring_events_entity ON ic_monitoring_events (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS clo_screenings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id UUID NOT NULL REFERENCES clo_panels(id) ON DELETE CASCADE,
  focus_area TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'error')),
  current_phase TEXT,
  raw_files JSONB DEFAULT '{}',
  parsed_data JSONB DEFAULT '{}',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- ============================================================
-- Pulse Movement Detection tables
-- ============================================================

CREATE TABLE IF NOT EXISTS pulse_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  geography TEXT,
  stage TEXT NOT NULL DEFAULT 'detected'
    CHECK (stage IN ('detected', 'verified', 'growing', 'trending', 'peaked', 'declining', 'dormant')),
  key_slogans JSONB DEFAULT '[]',
  key_phrases JSONB DEFAULT '[]',
  categories JSONB DEFAULT '[]',
  estimated_size TEXT,
  momentum_score FLOAT NOT NULL DEFAULT 0
    CHECK (momentum_score >= 0 AND momentum_score <= 100),
  sentiment TEXT,
  merch_potential_score FLOAT NOT NULL DEFAULT 0
    CHECK (merch_potential_score >= 0 AND merch_potential_score <= 100),
  analysis_summary TEXT,
  raw_analysis JSONB DEFAULT '{}',
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_signal_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  peak_momentum_score FLOAT DEFAULT 0,
  peak_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pulse_movements_stage ON pulse_movements (stage);
CREATE INDEX IF NOT EXISTS idx_pulse_movements_momentum ON pulse_movements (momentum_score DESC);

CREATE TABLE IF NOT EXISTS pulse_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (trigger_type IN ('manual', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'complete', 'error')),
  current_phase TEXT,
  raw_files JSONB DEFAULT '{}',
  signals_found INTEGER DEFAULT 0,
  movements_created INTEGER DEFAULT 0,
  movements_updated INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pulse_scans_status ON pulse_scans (status);

CREATE TABLE IF NOT EXISTS pulse_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id UUID REFERENCES pulse_movements(id) ON DELETE SET NULL,
  scan_id UUID REFERENCES pulse_scans(id) ON DELETE SET NULL,
  source TEXT NOT NULL
    CHECK (source IN ('reddit', 'gdelt', 'bluesky', 'wikipedia', 'news', 'mastodon')),
  source_id TEXT,
  title TEXT,
  content TEXT,
  url TEXT,
  metadata JSONB DEFAULT '{}',
  relevance_score FLOAT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_signals_dedup ON pulse_signals (source, source_id, movement_id);
CREATE INDEX IF NOT EXISTS idx_pulse_signals_source ON pulse_signals (source);
CREATE INDEX IF NOT EXISTS idx_pulse_signals_movement ON pulse_signals (movement_id);
CREATE INDEX IF NOT EXISTS idx_pulse_signals_scan ON pulse_signals (scan_id);

-- ============================================================
-- CLO Document-First Transformation
-- ============================================================

-- Add CLO-level documents (PPM, compliance reports) to profile
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS documents JSONB DEFAULT '[]';

-- Add extracted constraints from PPM
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS extracted_constraints JSONB DEFAULT '{}';

-- CLO-level conversations (analyst chat)
CREATE TABLE IF NOT EXISTS clo_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES clo_profiles(id) ON DELETE CASCADE,
  messages JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clo_conversations_profile ON clo_conversations(profile_id);

-- Add extracted portfolio data from compliance reports
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS extracted_portfolio JSONB DEFAULT NULL;

-- Add analyst mode to follow-ups
ALTER TABLE clo_follow_ups DROP CONSTRAINT IF EXISTS clo_follow_ups_mode_check;
ALTER TABLE clo_follow_ups ADD CONSTRAINT clo_follow_ups_mode_check
  CHECK (mode IN ('ask-panel', 'ask-member', 'debate', 'analyst'));

-- ============================================================
-- Daily Briefings
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_type TEXT NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_briefing_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  briefing_id UUID NOT NULL REFERENCES daily_briefings(id) ON DELETE CASCADE,
  product TEXT NOT NULL CHECK (product IN ('ic', 'clo')),
  relevant BOOLEAN NOT NULL DEFAULT false,
  digest_md TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, briefing_id, product)
);

-- ============================================================
-- CLO Exhaustive Extraction — New Tables
-- ============================================================

-- Deal master data (one per profile, extracted from PPM)
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

-- One row per compliance report upload (time-series anchor)
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

-- Capital structure (stable per deal)
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

-- Per-period tranche state
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

-- Full portfolio schedule per period
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

-- Aggregate pool metrics per period (1:1 with report_period)
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

-- All coverage + quality tests per period
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

-- All concentration breakdowns per period
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

-- Priority of payments execution per period
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

-- Cash account balances per period
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

-- Sources & uses of cash per period
CREATE TABLE IF NOT EXISTS clo_proceeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  proceeds_type TEXT,
  source_description TEXT,
  amount NUMERIC,
  period_start TEXT,
  period_end TEXT
);

-- All trading activity per period
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

-- Aggregate trading metrics per period (1:1)
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

-- Material events tracked in compliance reports
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

-- OC test haircuts/adjustments per period
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

-- Catch-all for unclassifiable data
CREATE TABLE IF NOT EXISTS clo_extraction_overflow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_period_id UUID NOT NULL REFERENCES clo_report_periods(id) ON DELETE CASCADE,
  extraction_pass INTEGER,
  source_section TEXT,
  label TEXT,
  content JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reference: Moody's rating-to-number
CREATE TABLE IF NOT EXISTS clo_rating_factor_map (
  rating TEXT PRIMARY KEY,
  rating_factor NUMERIC,
  sp_equivalent TEXT,
  default_probability_1y NUMERIC,
  default_probability_5y NUMERIC
);

-- Reference: Standard industry codes
CREATE TABLE IF NOT EXISTS clo_industry_classifications (
  industry_code TEXT PRIMARY KEY,
  industry_name TEXT NOT NULL,
  classification_system TEXT CHECK (classification_system IN ('Moodys_33', 'SP', 'GICS', 'ICB')),
  parent_sector TEXT
);

-- PPM extraction metadata
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS ppm_extracted_at TIMESTAMPTZ;
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS ppm_raw_extraction JSONB;

-- PPM extraction queue status
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS ppm_extraction_status TEXT DEFAULT NULL
  CHECK (ppm_extraction_status IS NULL OR ppm_extraction_status IN ('queued', 'extracting', 'complete', 'error'));
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS ppm_extraction_error TEXT DEFAULT NULL;

-- Portfolio extraction queue status
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS portfolio_extraction_status TEXT DEFAULT NULL
  CHECK (portfolio_extraction_status IS NULL OR portfolio_extraction_status IN ('queued', 'extracting', 'complete', 'error'));
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS portfolio_extraction_error TEXT DEFAULT NULL;

-- Compliance report extraction queue status
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS report_extraction_status TEXT DEFAULT NULL
  CHECK (report_extraction_status IS NULL OR report_extraction_status IN ('queued', 'extracting', 'complete', 'error'));
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS report_extraction_error TEXT DEFAULT NULL;
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS report_extraction_progress JSONB DEFAULT NULL;

-- PPM extraction progress
ALTER TABLE clo_profiles ADD COLUMN IF NOT EXISTS ppm_extraction_progress JSONB DEFAULT NULL;

-- CLO panel-level follow-ups (no analysis required)
ALTER TABLE clo_follow_ups ALTER COLUMN analysis_id DROP NOT NULL;
ALTER TABLE clo_follow_ups ADD COLUMN IF NOT EXISTS panel_id UUID REFERENCES clo_panels(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_clo_follow_ups_panel ON clo_follow_ups(panel_id);

-- CLO screening-level follow-ups
ALTER TABLE clo_follow_ups ADD COLUMN IF NOT EXISTS screening_id UUID REFERENCES clo_screenings(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_clo_follow_ups_screening ON clo_follow_ups(screening_id);
