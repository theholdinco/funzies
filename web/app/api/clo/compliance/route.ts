import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";

const ALLOWED_UPDATES: Record<string, Set<string>> = {
  clo_pool_summary: new Set([
    "total_par", "total_principal_balance", "total_market_value",
    "number_of_obligors", "number_of_assets", "number_of_industries",
    "number_of_countries", "target_par", "wac_spread", "wac_total",
    "wal_years", "warf", "diversity_score", "wa_recovery_rate",
    "pct_fixed_rate", "pct_floating_rate", "pct_cov_lite",
    "pct_second_lien", "pct_senior_secured", "pct_bonds",
    "pct_defaulted", "pct_ccc_and_below", "pct_single_b",
  ]),
  clo_compliance_tests: new Set([
    "test_name", "test_type", "test_class", "actual_value",
    "trigger_level", "threshold_level", "cushion_pct", "cushion_amount",
    "is_passing", "consequence_if_fail",
  ]),
  clo_concentrations: new Set([
    "concentration_type", "bucket_name", "actual_value", "actual_pct",
    "limit_value", "limit_pct", "is_passing", "obligor_count", "asset_count",
  ]),
};

async function verifyReportPeriodAccess(reportPeriodId: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT rp.id FROM clo_report_periods rp
     JOIN clo_deals d ON rp.deal_id = d.id
     JOIN clo_profiles p ON d.profile_id = p.id
     WHERE rp.id = $1 AND p.user_id = $2`,
    [reportPeriodId, userId]
  );
  return rows.length > 0;
}

function buildUpdateQuery(
  table: string,
  id: string,
  reportPeriodId: string,
  updates: Record<string, unknown>
): { sql: string; values: unknown[] } | null {
  const allowed = ALLOWED_UPDATES[table];
  if (!allowed) return null;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.has(key)) continue;
    setClauses.push(`${key} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  if (setClauses.length === 0) return null;

  values.push(id, reportPeriodId);
  return {
    sql: `UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = $${paramIndex - 1} AND report_period_id = $${paramIndex}`,
    values,
  };
}

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { reportPeriodId, poolSummary, complianceTests, concentrations } = body;

  if (!reportPeriodId) {
    return NextResponse.json({ error: "Missing reportPeriodId" }, { status: 400 });
  }

  const hasAccess = await verifyReportPeriodAccess(reportPeriodId, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const results: string[] = [];

  if (poolSummary && typeof poolSummary === "object") {
    const poolRows = await query<{ id: string }>(
      "SELECT id FROM clo_pool_summary WHERE report_period_id = $1",
      [reportPeriodId]
    );
    if (poolRows.length > 0) {
      const q = buildUpdateQuery("clo_pool_summary", poolRows[0].id, reportPeriodId, poolSummary);
      if (q) {
        await query(q.sql, q.values);
        results.push("poolSummary");
      }
    }
  }

  if (Array.isArray(complianceTests)) {
    for (const { id, updates } of complianceTests) {
      if (!id || !updates) continue;
      const q = buildUpdateQuery("clo_compliance_tests", id, reportPeriodId, updates);
      if (q) {
        await query(q.sql, q.values);
        results.push(`complianceTest:${id}`);
      }
    }
  }

  if (Array.isArray(concentrations)) {
    for (const { id, updates } of concentrations) {
      if (!id || !updates) continue;
      const q = buildUpdateQuery("clo_concentrations", id, reportPeriodId, updates);
      if (q) {
        await query(q.sql, q.values);
        results.push(`concentration:${id}`);
      }
    }
  }

  return NextResponse.json({ updated: results });
}
