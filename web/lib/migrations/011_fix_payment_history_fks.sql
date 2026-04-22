-- Fix clo_payment_history FKs that were created without ON DELETE action,
-- which blocked any DELETE from clo_report_periods (and thus any clo_deals
-- cascade — breaking the profile-reset endpoint).
--
-- Payment history is profile-lifetime data that outlives any individual
-- report period, so SET NULL is the correct action: deleting a single
-- report doesn't invalidate the historical row, just orphans its source
-- pointer. The profile-level cascade already handles full wipes.

ALTER TABLE clo_payment_history
  DROP CONSTRAINT IF EXISTS clo_payment_history_source_period_id_fkey;
ALTER TABLE clo_payment_history
  ADD CONSTRAINT clo_payment_history_source_period_id_fkey
  FOREIGN KEY (source_period_id) REFERENCES clo_report_periods(id) ON DELETE SET NULL;

ALTER TABLE clo_payment_history
  DROP CONSTRAINT IF EXISTS clo_payment_history_last_seen_period_id_fkey;
ALTER TABLE clo_payment_history
  ADD CONSTRAINT clo_payment_history_last_seen_period_id_fkey
  FOREIGN KEY (last_seen_period_id) REFERENCES clo_report_periods(id) ON DELETE SET NULL;
