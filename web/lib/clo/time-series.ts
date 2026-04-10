import { query } from "../db";
import type { CloConcentration, ConcentrationType } from "./types";

const ALLOWED_POOL_METRICS = new Set([
  "total_par",
  "total_principal_balance",
  "total_market_value",
  "number_of_obligors",
  "number_of_assets",
  "number_of_industries",
  "number_of_countries",
  "target_par",
  "par_surplus_deficit",
  "wac_spread",
  "wac_total",
  "wal_years",
  "warf",
  "diversity_score",
  "wa_recovery_rate",
  "wa_moodys_recovery",
  "wa_sp_recovery",
  "pct_fixed_rate",
  "pct_floating_rate",
  "pct_cov_lite",
  "pct_second_lien",
  "pct_senior_secured",
  "pct_bonds",
  "pct_current_pay",
  "pct_defaulted",
  "pct_ccc_and_below",
  "pct_single_b",
  "pct_discount_obligations",
  "pct_long_dated",
  "pct_semi_annual_pay",
  "pct_quarterly_pay",
  "pct_eur_denominated",
  "pct_gbp_denominated",
  "pct_usd_denominated",
  "pct_non_base_currency",
]);

export async function getMetricTrend(
  dealId: string,
  metric: string,
  periods: number = 10
): Promise<{ date: string; value: number }[]> {
  if (!ALLOWED_POOL_METRICS.has(metric)) {
    throw new Error(`Invalid metric: ${metric}`);
  }
  const rows = await query<{ report_date: string; value: number }>(
    `SELECT rp.report_date, ps.${metric} AS value
     FROM clo_pool_summary ps
     JOIN clo_report_periods rp ON ps.report_period_id = rp.id
     WHERE rp.deal_id = $1 AND ps.${metric} IS NOT NULL
     ORDER BY rp.report_date DESC
     LIMIT $2`,
    [dealId, periods]
  );
  return rows.map((r) => ({ date: r.report_date, value: Number(r.value) }));
}

export async function getTestCushionTrend(
  dealId: string,
  testName: string,
  periods: number = 10
): Promise<{ date: string; cushionPct: number; isPassing: boolean }[]> {
  const rows = await query<{
    report_date: string;
    cushion_pct: number;
    is_passing: boolean;
  }>(
    `SELECT rp.report_date, ct.cushion_pct, ct.is_passing
     FROM clo_compliance_tests ct
     JOIN clo_report_periods rp ON ct.report_period_id = rp.id
     WHERE rp.deal_id = $1 AND ct.test_name = $2
     ORDER BY rp.report_date DESC
     LIMIT $3`,
    [dealId, testName, periods]
  );
  return rows.map((r) => ({
    date: r.report_date,
    cushionPct: Number(r.cushion_pct),
    isPassing: r.is_passing,
  }));
}

function rowToConcentration(row: Record<string, unknown>): CloConcentration {
  return {
    id: row.id as string,
    reportPeriodId: row.report_period_id as string,
    concentrationType: row.concentration_type as ConcentrationType,
    bucketName: row.bucket_name as string,
    actualValue: (row.actual_value as number) ?? null,
    actualPct: (row.actual_pct as number) ?? null,
    limitValue: (row.limit_value as number) ?? null,
    limitPct: (row.limit_pct as number) ?? null,
    excessAmount: (row.excess_amount as number) ?? null,
    isPassing: (row.is_passing as boolean) ?? null,
    isHaircutApplied: (row.is_haircut_applied as boolean) ?? null,
    haircutAmount: (row.haircut_amount as number) ?? null,
    obligorCount: (row.obligor_count as number) ?? null,
    assetCount: (row.asset_count as number) ?? null,
    ratingFactorAvg: (row.rating_factor_avg as number) ?? null,
  };
}

export async function getPoolComposition(
  reportPeriodId: string
): Promise<{ rating: CloConcentration[]; sector: CloConcentration[]; country: CloConcentration[] }> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM clo_concentrations
     WHERE report_period_id = $1
       AND concentration_type IN ('RATING', 'INDUSTRY', 'COUNTRY')`,
    [reportPeriodId]
  );
  const result: { rating: CloConcentration[]; sector: CloConcentration[]; country: CloConcentration[] } = {
    rating: [],
    sector: [],
    country: [],
  };
  for (const row of rows) {
    const conc = rowToConcentration(row);
    if (conc.concentrationType === "RATING") result.rating.push(conc);
    else if (conc.concentrationType === "INDUSTRY") result.sector.push(conc);
    else if (conc.concentrationType === "COUNTRY") result.country.push(conc);
  }
  return result;
}

export async function compareReportPeriods(
  periodId1: string,
  periodId2: string
): Promise<{
  poolDelta: Record<string, { old: number | null; new: number | null; delta: number | null }>;
  testDelta: Array<{ testName: string; oldCushion: number | null; newCushion: number | null }>;
  holdingsAdded: string[];
  holdingsRemoved: string[];
}> {
  const [poolRows, testRows, holdingsRows] = await Promise.all([
    // Pool summary comparison
    query<{
      metric: string;
      old_val: number | null;
      new_val: number | null;
    }>(
      `SELECT
         u.metric,
         p1.val AS old_val,
         p2.val AS new_val
       FROM (
         SELECT unnest(ARRAY[
           'total_par','total_principal_balance','total_market_value',
           'wac_spread','wal_years','warf','diversity_score',
           'wa_recovery_rate','pct_ccc_and_below','pct_defaulted',
           'number_of_obligors','number_of_assets'
         ]) AS metric
       ) u
       LEFT JOIN LATERAL (
         SELECT CASE u.metric
           WHEN 'total_par' THEN total_par
           WHEN 'total_principal_balance' THEN total_principal_balance
           WHEN 'total_market_value' THEN total_market_value
           WHEN 'wac_spread' THEN wac_spread
           WHEN 'wal_years' THEN wal_years
           WHEN 'warf' THEN warf
           WHEN 'diversity_score' THEN diversity_score
           WHEN 'wa_recovery_rate' THEN wa_recovery_rate
           WHEN 'pct_ccc_and_below' THEN pct_ccc_and_below
           WHEN 'pct_defaulted' THEN pct_defaulted
           WHEN 'number_of_obligors' THEN number_of_obligors
           WHEN 'number_of_assets' THEN number_of_assets
         END AS val
         FROM clo_pool_summary WHERE report_period_id = $1
       ) p1 ON true
       LEFT JOIN LATERAL (
         SELECT CASE u.metric
           WHEN 'total_par' THEN total_par
           WHEN 'total_principal_balance' THEN total_principal_balance
           WHEN 'total_market_value' THEN total_market_value
           WHEN 'wac_spread' THEN wac_spread
           WHEN 'wal_years' THEN wal_years
           WHEN 'warf' THEN warf
           WHEN 'diversity_score' THEN diversity_score
           WHEN 'wa_recovery_rate' THEN wa_recovery_rate
           WHEN 'pct_ccc_and_below' THEN pct_ccc_and_below
           WHEN 'pct_defaulted' THEN pct_defaulted
           WHEN 'number_of_obligors' THEN number_of_obligors
           WHEN 'number_of_assets' THEN number_of_assets
         END AS val
         FROM clo_pool_summary WHERE report_period_id = $2
       ) p2 ON true`,
      [periodId1, periodId2]
    ),
    // Compliance test comparison
    query<{
      test_name: string;
      old_cushion: number | null;
      new_cushion: number | null;
    }>(
      `SELECT
         COALESCE(t1.test_name, t2.test_name) AS test_name,
         t1.cushion_pct AS old_cushion,
         t2.cushion_pct AS new_cushion
       FROM (SELECT test_name, cushion_pct FROM clo_compliance_tests WHERE report_period_id = $1) t1
       FULL OUTER JOIN (SELECT test_name, cushion_pct FROM clo_compliance_tests WHERE report_period_id = $2) t2
         ON t1.test_name = t2.test_name`,
      [periodId1, periodId2]
    ),
    // Holdings diff (by obligor_name)
    query<{ obligor_name: string; status: string }>(
      `SELECT obligor_name, 'added' AS status FROM clo_holdings
       WHERE report_period_id = $2 AND obligor_name IS NOT NULL
         AND obligor_name NOT IN (
           SELECT obligor_name FROM clo_holdings
           WHERE report_period_id = $1 AND obligor_name IS NOT NULL
         )
       UNION ALL
       SELECT obligor_name, 'removed' AS status FROM clo_holdings
       WHERE report_period_id = $1 AND obligor_name IS NOT NULL
         AND obligor_name NOT IN (
           SELECT obligor_name FROM clo_holdings
           WHERE report_period_id = $2 AND obligor_name IS NOT NULL
         )`,
      [periodId1, periodId2]
    ),
  ]);

  const poolDelta: Record<string, { old: number | null; new: number | null; delta: number | null }> = {};
  for (const r of poolRows) {
    const oldVal = r.old_val != null ? Number(r.old_val) : null;
    const newVal = r.new_val != null ? Number(r.new_val) : null;
    poolDelta[r.metric] = {
      old: oldVal,
      new: newVal,
      delta: oldVal != null && newVal != null ? newVal - oldVal : null,
    };
  }

  const testDelta = testRows.map((r) => ({
    testName: r.test_name,
    oldCushion: r.old_cushion != null ? Number(r.old_cushion) : null,
    newCushion: r.new_cushion != null ? Number(r.new_cushion) : null,
  }));

  const holdingsAdded: string[] = [];
  const holdingsRemoved: string[] = [];
  for (const r of holdingsRows) {
    if (r.status === "added") holdingsAdded.push(r.obligor_name);
    else holdingsRemoved.push(r.obligor_name);
  }

  return { poolDelta, testDelta, holdingsAdded, holdingsRemoved };
}
