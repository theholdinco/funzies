// web/lib/clo/extraction/json-ingest/ingest.ts
import { query, getPool, getClient } from "../../../db";
import {
  ppmCapitalStructureSchema,
  ppmCoverageTestsSchema,
  ppmFeesSchema,
  ppmKeyDatesSchema,
  ppmKeyPartiesSchema,
  ppmPortfolioConstraintsSchema,
  ppmWaterfallRulesSchema,
  ppmInterestMechanicsSchema,
  transactionOverviewSchema,
  complianceSummarySchema,
  parValueTestsSchema,
  interestCoverageTestsSchema,
  collateralQualityTestsSchema,
  concentrationSchema,
  waterfallSchema,
  tradingActivitySchema,
  accountBalancesSchema,
  interestAccrualDetailSchema,
  defaultDetailSchema,
  supplementarySchema,
  assetScheduleSchema,
} from "../section-schemas";
import { normalizePpmSectionResults } from "../normalizer";
import { validateAndNormalizeConstraints } from "../../ingestion-gate";
import { syncPpmToRelationalTables } from "../persist-ppm";
import { persistComplianceSections } from "./persist-compliance";
import { mapPpm } from "./ppm-mapper";
import { mapCompliance } from "./compliance-mapper";
import type { PpmJson, ComplianceJson } from "./types";
import type { ExtractedConstraints } from "../../types/extraction";

type SchemaLike = { safeParse: (v: unknown) => { success: boolean; error?: unknown } };

const PPM_SCHEMAS: Record<string, SchemaLike> = {
  transaction_overview: transactionOverviewSchema,
  capital_structure: ppmCapitalStructureSchema,
  coverage_tests: ppmCoverageTestsSchema,
  key_dates: ppmKeyDatesSchema,
  key_parties: ppmKeyPartiesSchema,
  fees_and_expenses: ppmFeesSchema,
  portfolio_constraints: ppmPortfolioConstraintsSchema,
  waterfall_rules: ppmWaterfallRulesSchema,
  interest_mechanics: ppmInterestMechanicsSchema,
};

const COMPLIANCE_SCHEMAS: Record<string, SchemaLike> = {
  compliance_summary: complianceSummarySchema,
  par_value_tests: parValueTestsSchema,
  interest_coverage_tests: interestCoverageTestsSchema,
  collateral_quality_tests: collateralQualityTestsSchema,
  interest_accrual_detail: interestAccrualDetailSchema,
  asset_schedule: assetScheduleSchema,
  concentration_tables: concentrationSchema,
  waterfall: waterfallSchema,
  trading_activity: tradingActivitySchema,
  account_balances: accountBalancesSchema,
  default_detail: defaultDetailSchema,
  supplementary: supplementarySchema,
};

function validateAll(
  sections: Record<string, Record<string, unknown>>,
  schemas: Record<string, SchemaLike>,
): { ok: true } | { ok: false; errors: Array<{ section: string; issues: unknown }> } {
  const errors: Array<{ section: string; issues: unknown }> = [];
  for (const [name, data] of Object.entries(sections)) {
    const schema = schemas[name];
    if (!schema) continue;
    const r = schema.safeParse(data);
    if (!r.success) errors.push({ section: name, issues: r.error });
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export async function ingestPpmJson(
  profileId: string,
  ppm: PpmJson,
): Promise<{ ok: true; counts: Record<string, number> } | { ok: false; errors: Array<{ section: string; issues: unknown }> }> {
  const sections = mapPpm(ppm);
  const validation = validateAll(sections, PPM_SCHEMAS);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const extractedConstraints: Record<string, unknown> = normalizePpmSectionResults(sections);
  console.log(`[json-ingest:ppm] normalized keys=${Object.keys(extractedConstraints).join(",")} capStruct=${(extractedConstraints.capitalStructure as unknown[] | undefined)?.length ?? 0} fees=${(extractedConstraints.fees as unknown[] | undefined)?.length ?? 0} keyParties=${(extractedConstraints.keyParties as unknown[] | undefined)?.length ?? 0}`);

  const gate = validateAndNormalizeConstraints(extractedConstraints as ExtractedConstraints);
  if (gate.ok) {
    Object.assign(extractedConstraints, gate.data);
    console.log(`[json-ingest:ppm] gate ok, ${gate.fixes.length} fixes applied`);
  } else {
    console.warn("[json-ingest:ppm] gate validation failed:", gate.errors);
  }
  extractedConstraints._sectionBasedExtraction = true;
  extractedConstraints._jsonIngest = true;

  const stringified = JSON.stringify(extractedConstraints);
  console.log(`[json-ingest:ppm] about to UPDATE clo_profiles id=${profileId} jsonb length=${stringified.length}`);

  const client = await getClient();
  let rowCount = 0;
  try {
    const res = await client.query(
      `UPDATE clo_profiles
       SET extracted_constraints = $1::jsonb,
           ppm_raw_extraction = $2::jsonb,
           ppm_extracted_at = now(),
           ppm_extraction_status = 'complete',
           ppm_extraction_error = NULL,
           ppm_extraction_progress = $3::jsonb,
           updated_at = now()
       WHERE id = $4`,
      [
        stringified,
        JSON.stringify({ _jsonIngest: true, _rawInput: ppm }),
        JSON.stringify({ step: "complete", detail: "JSON ingest complete", updatedAt: new Date().toISOString() }),
        profileId,
      ],
    );
    rowCount = res.rowCount ?? 0;
    console.log(`[json-ingest:ppm] UPDATE rowCount=${rowCount}`);

    if (rowCount !== 1) {
      throw new Error(`PPM UPDATE matched ${rowCount} rows (expected 1) for profileId=${profileId}`);
    }

    // Read-after-write to prove the JSONB actually persisted.
    const check = await client.query<{ key_count: number; sample_keys: string[] }>(
      `SELECT
         (SELECT COUNT(*) FROM jsonb_object_keys(extracted_constraints))::int AS key_count,
         ARRAY(SELECT jsonb_object_keys(extracted_constraints) LIMIT 5) AS sample_keys
       FROM clo_profiles WHERE id = $1`,
      [profileId],
    );
    console.log(`[json-ingest:ppm] read-after-write: key_count=${check.rows[0]?.key_count} sample=[${check.rows[0]?.sample_keys?.join(",")}]`);
    if ((check.rows[0]?.key_count ?? 0) === 0) {
      throw new Error(`PPM UPDATE appears to have written empty JSONB for profileId=${profileId} — data loss`);
    }
  } finally {
    client.release();
  }

  const pool = getPool();
  await syncPpmToRelationalTables(pool, profileId, extractedConstraints);
  console.log(`[json-ingest:ppm] syncPpmToRelationalTables done for profileId=${profileId}`);

  return {
    ok: true,
    counts: {
      sections_mapped: Object.keys(sections).length,
      tranches: Array.isArray(extractedConstraints.capitalStructure) ? (extractedConstraints.capitalStructure as unknown[]).length : 0,
      fees: Array.isArray(extractedConstraints.fees) ? (extractedConstraints.fees as unknown[]).length : 0,
      key_parties: Array.isArray(extractedConstraints.keyParties) ? (extractedConstraints.keyParties as unknown[]).length : 0,
    },
  };
}

export async function ingestComplianceJson(
  profileId: string,
  compliance: ComplianceJson,
): Promise<{ ok: true; reportPeriodId: string; counts: Record<string, number> } | { ok: false; errors: Array<{ section: string; issues: unknown }> }> {
  const sections = mapCompliance(compliance);
  const validation = validateAll(sections, COMPLIANCE_SCHEMAS);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  // Resolve deal — auto-create if missing, mirroring runner.ts getOrCreateDeal
  // (runner.ts:179-203) so the JSON compliance path is not stricter than the
  // LLM path. If PPM hasn't been ingested yet, we create a bare-bones deal from
  // whatever the compliance report gives us (issuer + collateral_manager from meta).
  const deals = await query<{ id: string }>(
    `SELECT id FROM clo_deals WHERE profile_id = $1`,
    [profileId],
  );
  let dealId: string;
  if (deals.length > 0) {
    dealId = deals[0].id;
  } else {
    const profileRows = await query<{ extracted_constraints: Record<string, unknown> | null }>(
      `SELECT extracted_constraints FROM clo_profiles WHERE id = $1`,
      [profileId],
    );
    const constraints = (profileRows[0]?.extracted_constraints ?? {}) as Record<string, unknown>;
    const dealIdentity = (constraints.dealIdentity ?? {}) as Record<string, string>;
    const cmDetails = (constraints.cmDetails ?? {}) as Record<string, string>;

    const dealName = dealIdentity.dealName ?? compliance.meta.issuer ?? null;
    const collateralManager = (constraints.collateralManager as string | undefined)
      ?? cmDetails.name
      ?? compliance.meta.collateral_manager
      ?? null;

    const inserted = await query<{ id: string }>(
      `INSERT INTO clo_deals (profile_id, deal_name, collateral_manager)
       VALUES ($1, $2, $3) RETURNING id`,
      [profileId, dealName, collateralManager],
    );
    dealId = inserted[0].id;
    console.log(`[json-ingest] created clo_deals row ${dealId} for profile ${profileId} (no prior PPM)`);
  }

  const reportDate = compliance.meta.determination_date;
  const periods = await query<{ id: string }>(
    `INSERT INTO clo_report_periods (deal_id, report_date, payment_date, reporting_period_start, reporting_period_end, extraction_status, report_source)
     VALUES ($1, $2, $3, $4, $5, 'extracting', 'json_ingest')
     ON CONFLICT (deal_id, report_date) DO UPDATE SET extraction_status = 'extracting', updated_at = now()
     RETURNING id`,
    [
      dealId,
      reportDate,
      compliance.key_dates.current_payment_date ?? null,
      compliance.key_dates.collection_period_start ?? null,
      compliance.key_dates.collection_period_end ?? null,
    ],
  );
  const reportPeriodId = periods[0].id;

  console.log(`[json-ingest:compliance] starting persist for reportPeriodId=${reportPeriodId} dealId=${dealId}`);
  const result = await persistComplianceSections(sections, reportPeriodId, dealId, profileId, compliance);
  console.log(`[json-ingest:compliance] persist done, counts=${JSON.stringify(result.counts)}`);

  // Read-after-write to prove pool_summary + compliance_tests actually landed.
  const verify = await query<{ pool_rows: number; test_rows: number; conc_rows: number; status: string }>(
    `SELECT
       (SELECT COUNT(*)::int FROM clo_pool_summary WHERE report_period_id = $1) AS pool_rows,
       (SELECT COUNT(*)::int FROM clo_compliance_tests WHERE report_period_id = $1) AS test_rows,
       (SELECT COUNT(*)::int FROM clo_concentrations WHERE report_period_id = $1) AS conc_rows,
       (SELECT extraction_status FROM clo_report_periods WHERE id = $1) AS status`,
    [reportPeriodId],
  );
  const v = verify[0];
  console.log(`[json-ingest:compliance] read-after-write: pool=${v?.pool_rows} tests=${v?.test_rows} conc=${v?.conc_rows} status=${v?.status}`);
  if ((v?.pool_rows ?? 0) === 0) {
    throw new Error(`compliance ingest completed but clo_pool_summary has no row for reportPeriodId=${reportPeriodId}`);
  }

  return { ok: true, reportPeriodId, counts: result.counts };
}
