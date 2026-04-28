// web/lib/clo/extraction/json-ingest/persist-compliance.ts
import { query } from "../../../db";
import { normalizeClassName } from "../../api";
import { normalizeSectionResults } from "../normalizer";

// Only these five tables carry a `data_source` column (migration 008). Any
// other compliance-side table will throw if queried with `data_source = 'sdf'`.
// This whitelist MUST match runner.ts:22-25's SDF_GUARDED_TABLES exactly.
const SDF_GUARDED_TABLES = new Set([
  "clo_holdings",
  "clo_compliance_tests",
  "clo_tranche_snapshots",
  "clo_account_balances",
  "clo_trades",
]);

// Check whether SDF has already populated a table for this period.
// Matches the runner's hasSdfData gate, including the early-return for
// tables without a data_source column.
async function hasSdfData(table: string, reportPeriodId: string): Promise<boolean> {
  if (!SDF_GUARDED_TABLES.has(table)) return false;
  const rows = await query<{ n: number }>(
    `SELECT 1 AS n FROM ${table} WHERE report_period_id = $1 AND data_source = 'sdf' LIMIT 1`,
    [reportPeriodId],
  );
  return rows.length > 0;
}

async function getTableColumns(table: string): Promise<Set<string>> {
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

async function batchInsert(table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0;
  const validColumns = await getTableColumns(table);
  const allColumns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = allColumns.filter((c) => validColumns.has(c));
  const dropped = allColumns.filter((c) => !validColumns.has(c));
  if (dropped.length > 0) {
    console.log(`[json-ingest] ${table}: dropped unknown columns: ${dropped.join(", ")}`);
  }
  if (columns.length === 0) return 0;
  const valuePlaceholders: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const row of rows) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      rowPlaceholders.push(`$${idx++}`);
      const v = row[col];
      values.push(v === "null" || v === "NULL" || v === "" ? null : v ?? null);
    }
    valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
  }
  await query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valuePlaceholders.join(", ")}`, values);
  return rows.length;
}

async function replaceIfPresent(table: string, rows: Record<string, unknown>[], reportPeriodId: string): Promise<number> {
  if (rows.length === 0) return 0;
  if (await hasSdfData(table, reportPeriodId)) {
    console.log(`[json-ingest] ${table}: SDF data present, skipping overwrite`);
    return 0;
  }
  // For SDF-guarded tables, only delete non-SDF rows (preserve any SDF data that somehow
  // exists but wasn't detected by hasSdfData). For non-guarded tables, DELETE is unconditional
  // since there's no data_source column to filter on.
  if (SDF_GUARDED_TABLES.has(table)) {
    await query(`DELETE FROM ${table} WHERE report_period_id = $1 AND (data_source IS NULL OR data_source <> 'sdf')`, [reportPeriodId]);
    return batchInsert(table, rows.map((r) => ({ ...r, data_source: "json_ingest" })));
  } else {
    await query(`DELETE FROM ${table} WHERE report_period_id = $1`, [reportPeriodId]);
    return batchInsert(table, rows);  // no data_source column, don't add it
  }
}

export async function persistComplianceSections(
  sections: Record<string, Record<string, unknown> | null>,
  reportPeriodId: string,
  dealId: string,
  profileId: string,
  rawInput: unknown,
): Promise<{ counts: Record<string, number> }> {
  const normalized = normalizeSectionResults(sections, reportPeriodId, dealId);
  const counts: Record<string, number> = {};

  if (normalized.poolSummary) {
    // NOTE: clo_pool_summary has no data_source column and therefore no SDF guard.
    // This mirrors runner.ts, which also unconditionally replaces pool_summary on
    // every compliance extraction. If SDF ever starts writing pool_summary, this
    // will need a coexistence strategy.
    await query(`DELETE FROM clo_pool_summary WHERE report_period_id = $1`, [reportPeriodId]);
    counts.pool_summary = await batchInsert("clo_pool_summary", [normalized.poolSummary]);
  }
  counts.compliance_tests = await replaceIfPresent("clo_compliance_tests", normalized.complianceTests, reportPeriodId);
  counts.holdings = await replaceIfPresent("clo_holdings", normalized.holdings, reportPeriodId);
  counts.concentrations = await replaceIfPresent("clo_concentrations", normalized.concentrations, reportPeriodId);
  counts.waterfall_steps = await replaceIfPresent("clo_waterfall_steps", normalized.waterfallSteps, reportPeriodId);
  counts.proceeds = await replaceIfPresent("clo_proceeds", normalized.proceeds, reportPeriodId);
  counts.trades = await replaceIfPresent("clo_trades", normalized.trades, reportPeriodId);
  counts.account_balances = await replaceIfPresent("clo_account_balances", normalized.accountBalances, reportPeriodId);
  counts.par_value_adjustments = await replaceIfPresent("clo_par_value_adjustments", normalized.parValueAdjustments, reportPeriodId);
  counts.events = await replaceIfPresent("clo_events", normalized.events, reportPeriodId);

  // Tranche snapshots: find-or-create tranche by NORMALIZED class name,
  // then SELECT-then-INSERT/UPDATE the snapshot (clo_tranche_snapshots has NO
  // unique constraint on (tranche_id, report_period_id) — ON CONFLICT will raise
  // "no unique or exclusion constraint matching the ON CONFLICT specification").
  //
  // Class-name normalization: worker's syncPpmToRelationalTables inserts rows with
  // the original `class_name` ("Class A") but looks them up via
  // `normalizeClassName(x) === normalizeClassName(y)` ("A" === "A"). Mapper output
  // preserves "Class A" / "Subordinated" verbatim. To avoid duplicating tranches
  // when PPM already ran, we match on normalized form and only INSERT with the
  // original name if nothing matched. Mirrors worker:639-653 exactly.
  const allTranches = await query<{ id: string; class_name: string }>(
    `SELECT id, class_name FROM clo_tranches WHERE deal_id = $1`,
    [dealId],
  );

  // Fetch actual snapshot columns once and filter ts.data against them. The
  // normalizer emits keys like `principal_amount`, `rating`, `spread` that
  // don't exist as columns on clo_tranche_snapshots — they come from the
  // compliance_summary tranche shape and are consumed by the poolSummary
  // backfill path, not by the snapshot insert.
  const snapshotColumns = await getTableColumns("clo_tranche_snapshots");

  let snapshotCount = 0;
  for (const ts of normalized.trancheSnapshots) {
    const wantedNorm = normalizeClassName(ts.className);
    let trancheId = allTranches.find((t) => normalizeClassName(t.class_name) === wantedNorm)?.id;
    if (!trancheId) {
      const inserted = await query<{ id: string; class_name: string }>(
        `INSERT INTO clo_tranches (deal_id, class_name) VALUES ($1, $2) RETURNING id, class_name`,
        [dealId, ts.className],
      );
      trancheId = inserted[0].id;
      allTranches.push({ id: inserted[0].id, class_name: inserted[0].class_name });
    }

    // SELECT-then-INSERT/UPDATE, not ON CONFLICT — see SDF's processNotes (sdf/ingest.ts:631-701).
    const existing = await query<{ id: string }>(
      `SELECT id FROM clo_tranche_snapshots WHERE tranche_id = $1 AND report_period_id = $2`,
      [trancheId, reportPeriodId],
    );

    // Strip fields we manage explicitly (report_period_id is pre-injected into
    // ts.data by the normalizer's toDbRow helper; tranche_id and id are
    // PK/FK columns we don't take from the mapper). Without this we'd
    // duplicate report_period_id in the INSERT column list.
    const managedKeys = new Set(["report_period_id", "tranche_id", "id", "data_source"]);
    const filteredEntries = Object.entries(ts.data).filter(
      ([k]) => snapshotColumns.has(k) && !managedKeys.has(k),
    );
    const dataKeys = filteredEntries.map(([k]) => k);
    const dataVals = filteredEntries.map(([, v]) => v);

    if (dataKeys.length === 0) {
      // No recognised columns — nothing to write. Skip the row rather than
      // inserting an empty snapshot.
      console.warn(`[json-ingest] tranche_snapshots: no recognised columns for "${ts.className}", skipping`);
      continue;
    }

    if (existing.length > 0) {
      const setClauses = dataKeys.map((k, i) => `${k} = $${i + 1}`).concat([`data_source = $${dataKeys.length + 1}`]);
      await query(
        `UPDATE clo_tranche_snapshots SET ${setClauses.join(", ")} WHERE id = $${dataKeys.length + 2}`,
        [...dataVals, "json_ingest", existing[0].id],
      );
    } else {
      const cols = [...dataKeys, "data_source", "tranche_id", "report_period_id"];
      const placeholders = cols.map((_, i) => `$${i + 1}`);
      await query(
        `INSERT INTO clo_tranche_snapshots (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
        [...dataVals, "json_ingest", trancheId, reportPeriodId],
      );
    }
    snapshotCount++;
  }
  counts.tranche_snapshots = snapshotCount;

  // Payment history — mirrors runner.ts:1141-1208 (upsert on (profile_id,
  // class_name, payment_date) with extracted_value snapshot). Cannot use
  // batchInsert here: clo_payment_history requires profile_id + extracted_value
  // (NOT NULL) and has snake_case columns, while normalized rows are camelCase
  // and lack profile_id/extracted_value. Earlier batchInsert path silently
  // dropped every row on column-name mismatch.
  let phCount = 0;
  for (const row of normalized.paymentHistory) {
    await query(
      `INSERT INTO clo_payment_history (
         profile_id, class_name, payment_date, period, par_commitment, factor,
         interest_paid, principal_paid, cashflow, ending_balance,
         interest_shortfall, accum_interest_shortfall,
         extracted_value, source_period_id, last_seen_period_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (profile_id, class_name, payment_date) DO UPDATE SET
         period = EXCLUDED.period,
         par_commitment = EXCLUDED.par_commitment,
         factor = EXCLUDED.factor,
         interest_paid = EXCLUDED.interest_paid,
         principal_paid = EXCLUDED.principal_paid,
         cashflow = EXCLUDED.cashflow,
         ending_balance = EXCLUDED.ending_balance,
         interest_shortfall = EXCLUDED.interest_shortfall,
         accum_interest_shortfall = EXCLUDED.accum_interest_shortfall,
         extracted_value = EXCLUDED.extracted_value,
         source_period_id = EXCLUDED.source_period_id,
         last_seen_period_id = EXCLUDED.last_seen_period_id,
         updated_at = NOW()`,
      [
        profileId, row.className, row.paymentDate, row.period, row.parCommitment, row.factor,
        row.interestPaid, row.principalPaid, row.cashflow, row.endingBalance,
        row.interestShortfall, row.accumInterestShortfall,
        JSON.stringify(row),
        reportPeriodId,
      ],
    );
    phCount++;
  }
  counts.payment_history = phCount;

  // Final UPDATE on clo_report_periods
  await query(
    `UPDATE clo_report_periods
     SET extraction_status = 'complete',
         extracted_at = now(),
         raw_extraction = $1::jsonb,
         updated_at = now()
     WHERE id = $2`,
    [JSON.stringify({ _jsonIngest: true, _rawInput: rawInput }), reportPeriodId],
  );

  return { counts };
}
