import { query, getClient } from "../../db";
import { parseTestResults, type SdfTestResultRow } from "./parse-test-results";
import { parseCollateralFile, type SdfCollateralRow } from "./parse-collateral";
import { parseNotes, type SdfNoteRow } from "./parse-notes";
import type { SdfFileType, SdfIngestionResult, SdfParseResult } from "./types";

type ParsedFile =
  | { fileType: "test_results"; parsed: SdfParseResult<SdfTestResultRow> }
  | { fileType: "collateral_file"; parsed: SdfParseResult<SdfCollateralRow> }
  | { fileType: "notes"; parsed: SdfParseResult<SdfNoteRow> };

const PROCESSING_ORDER: SdfFileType[] = [
  "notes",
  "collateral_file",
  "test_results",
  "accounts",
  "transactions",
  "accruals",
];

const PHASE2_STUBS = new Set<SdfFileType>([
  "asset_level",
  "accounts",
  "transactions",
  "accruals",
]);

export async function ingestSdfFiles(
  dealId: string,
  files: Array<{ fileType: SdfFileType; csvText: string; fileName: string }>
): Promise<SdfIngestionResult> {
  // Parse all files upfront
  const parsed = new Map<SdfFileType, ParsedFile>();
  for (const file of files) {
    if (PHASE2_STUBS.has(file.fileType)) continue;

    if (file.fileType === "test_results") {
      parsed.set("test_results", {
        fileType: "test_results",
        parsed: parseTestResults(file.csvText),
      });
    } else if (file.fileType === "collateral_file") {
      parsed.set("collateral_file", {
        fileType: "collateral_file",
        parsed: parseCollateralFile(file.csvText),
      });
    } else if (file.fileType === "notes") {
      parsed.set("notes", {
        fileType: "notes",
        parsed: parseNotes(file.csvText),
      });
    }
  }

  // Resolve asOfDate and periodBeginDate from the first parsed file that has them
  let asOfDate: string | null = null;
  let periodBeginDate: string | null = null;
  const parsedEntries = Array.from(parsed.values());
  for (const entry of parsedEntries) {
    if (entry.parsed.asOfDate) {
      asOfDate = entry.parsed.asOfDate;
      periodBeginDate = entry.parsed.periodBeginDate;
      break;
    }
  }
  // Fallback: try all parsed files for any date
  if (!asOfDate) {
    for (const entry of parsedEntries) {
      if (entry.parsed.periodBeginDate) {
        periodBeginDate = entry.parsed.periodBeginDate;
        break;
      }
    }
  }

  // Resolve report period
  const reportPeriodId = await resolveReportPeriod(
    dealId,
    asOfDate,
    periodBeginDate
  );

  // Process files in defined order
  const results: SdfIngestionResult["results"] = [];
  const skipped: SdfIngestionResult["skipped"] = [];
  const uploadedTypes = new Set(files.map((f) => f.fileType));

  for (const fileType of PROCESSING_ORDER) {
    if (!uploadedTypes.has(fileType)) continue;

    if (PHASE2_STUBS.has(fileType)) {
      results.push({ fileType, rowCount: 0, status: "skipped" });
      continue;
    }

    const entry = parsed.get(fileType);
    if (!entry) continue;

    try {
      const rowCount = await processFile(
        dealId,
        reportPeriodId,
        entry
      );
      results.push({
        fileType,
        rowCount,
        status: rowCount > 0 ? "success" : "empty",
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      console.error(`SDF ingest error for ${fileType}:`, message);
      results.push({ fileType, rowCount: 0, status: "error", error: message });
    }
  }

  // Report skipped Phase 2 files
  for (const file of files) {
    if (PHASE2_STUBS.has(file.fileType) && !PROCESSING_ORDER.includes(file.fileType)) {
      skipped.push({ fileName: file.fileName, reason: "Phase 2 — not yet implemented" });
    }
  }

  return {
    reportPeriodId,
    asOfDate: asOfDate ?? "",
    results,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Report period resolution
// ---------------------------------------------------------------------------

async function resolveReportPeriod(
  dealId: string,
  asOfDate: string | null,
  periodBeginDate: string | null
): Promise<string> {
  if (!asOfDate) {
    // No date available — create a new period with today's date as fallback
    const today = new Date().toISOString().slice(0, 10);
    console.warn("SDF ingest: no asOfDate found in files, using today:", today);
    return createReportPeriod(dealId, today, periodBeginDate);
  }

  // Exact match
  const exact = await query<{ id: string }>(
    `SELECT id FROM clo_report_periods WHERE deal_id = $1 AND report_date = $2`,
    [dealId, asOfDate]
  );
  if (exact.length > 0) return exact[0].id;

  // Window fallback: ±15 days
  const window = await query<{ id: string; report_date: string }>(
    `SELECT id, report_date FROM clo_report_periods
     WHERE deal_id = $1
       AND report_date::date BETWEEN ($2::date - INTERVAL '15 days') AND ($2::date + INTERVAL '15 days')
     ORDER BY ABS(report_date::date - $2::date)
     LIMIT 5`,
    [dealId, asOfDate]
  );

  if (window.length > 0) {
    console.warn(
      `SDF ingest: no exact report_date match for ${asOfDate}, using window match: ${window[0].report_date}`
    );
    return window[0].id;
  }

  // No match — create new
  return createReportPeriod(dealId, asOfDate, periodBeginDate);
}

async function createReportPeriod(
  dealId: string,
  reportDate: string,
  periodBeginDate: string | null
): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO clo_report_periods (id, deal_id, report_date, reporting_period_start, extraction_status, report_source)
     VALUES (gen_random_uuid(), $1, $2, $3, 'complete', 'sdf')
     RETURNING id`,
    [dealId, reportDate, periodBeginDate]
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// File processing dispatch
// ---------------------------------------------------------------------------

async function processFile(
  dealId: string,
  reportPeriodId: string,
  entry: ParsedFile
): Promise<number> {
  switch (entry.fileType) {
    case "notes":
      return processNotes(dealId, reportPeriodId, entry.parsed);
    case "collateral_file":
      return processCollateral(reportPeriodId, entry.parsed);
    case "test_results":
      return processTestResults(reportPeriodId, entry.parsed);
  }
}

// ---------------------------------------------------------------------------
// Test Results — DELETE + INSERT
// ---------------------------------------------------------------------------

async function processTestResults(
  reportPeriodId: string,
  parsed: SdfParseResult<SdfTestResultRow>
): Promise<number> {
  if (parsed.rows.length === 0) return 0;

  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM clo_compliance_tests WHERE report_period_id = $1`,
      [reportPeriodId]
    );

    const rows = parsed.rows.map((r) => ({
      report_period_id: reportPeriodId,
      ...r,
    }));
    await sdfBatchInsert("clo_compliance_tests", rows, client);

    await client.query("COMMIT");
    return parsed.rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Collateral File — DELETE + INSERT with enrichment warning
// ---------------------------------------------------------------------------

async function processCollateral(
  reportPeriodId: string,
  parsed: SdfParseResult<SdfCollateralRow>
): Promise<number> {
  if (parsed.rows.length === 0) return 0;

  // Check for enrichment data loss
  const enriched = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM clo_holdings WHERE report_period_id = $1 AND moodys_rating_final IS NOT NULL`,
    [reportPeriodId]
  );
  if (parseInt(enriched[0]?.count ?? "0", 10) > 0) {
    console.warn(
      "SDF ingest: Collateral File re-uploaded without Asset Level — enrichment columns will be reset."
    );
  }

  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM clo_holdings WHERE report_period_id = $1`,
      [reportPeriodId]
    );

    const rows = parsed.rows.map((r) => ({
      report_period_id: reportPeriodId,
      ...r,
    }));
    await sdfBatchInsert("clo_holdings", rows, client);

    await client.query("COMMIT");
    return parsed.rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Notes — find/create tranche, upsert snapshot
// ---------------------------------------------------------------------------

async function processNotes(
  dealId: string,
  reportPeriodId: string,
  parsed: SdfParseResult<SdfNoteRow>
): Promise<number> {
  if (parsed.rows.length === 0) return 0;

  const client = await getClient();
  try {
    await client.query("BEGIN");

    for (const note of parsed.rows) {
      // Find or create tranche
      const existing = await client.query<{
        id: string;
      }>(
        `SELECT id FROM clo_tranches WHERE deal_id = $1 AND class_name = $2`,
        [dealId, note.class_name]
      );

      let trancheId: string;
      if (existing.rows.length > 0) {
        trancheId = existing.rows[0].id;
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO clo_tranches (id, deal_id, class_name)
           VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
          [dealId, note.class_name]
        );
        trancheId = inserted.rows[0].id;
      }

      // Update tranche master data
      await client.query(
        `UPDATE clo_tranches SET
           rating_moodys = COALESCE($1, rating_moodys),
           rating_sp = COALESCE($2, rating_sp),
           rating_fitch = COALESCE($3, rating_fitch),
           spread_bps = COALESCE($4, spread_bps),
           reference_rate = COALESCE($5, reference_rate),
           original_balance = COALESCE($6, original_balance),
           payment_frequency = COALESCE($7, payment_frequency),
           day_count_convention = COALESCE($8, day_count_convention),
           cusip = COALESCE($9, cusip),
           isin = COALESCE($10, isin),
           currency = COALESCE($11, currency),
           tranche_type = COALESCE($12, tranche_type),
           liab_prin = COALESCE($13, liab_prin),
           legal_maturity_date = COALESCE($14, legal_maturity_date),
           amount_native = COALESCE($15, amount_native),
           vendor_custom_fields = COALESCE($16, vendor_custom_fields)
         WHERE id = $17`,
        [
          note.rating_moodys,
          note.rating_sp,
          note.rating_fitch,
          note.spread_bps,
          note.reference_rate,
          note.original_balance,
          note.payment_frequency,
          note.day_count_convention,
          note.cusip,
          note.isin,
          note.currency,
          note.tranche_type,
          note.liab_prin,
          note.legal_maturity_date,
          note.amount_native,
          note.vendor_custom_fields
            ? JSON.stringify(note.vendor_custom_fields)
            : null,
          trancheId,
        ]
      );

      // Upsert tranche snapshot
      const snapshotExists = await client.query(
        `SELECT id FROM clo_tranche_snapshots WHERE tranche_id = $1 AND report_period_id = $2`,
        [trancheId, reportPeriodId]
      );

      if (snapshotExists.rows.length > 0) {
        await client.query(
          `UPDATE clo_tranche_snapshots SET
             current_balance = $1,
             coupon_rate = $2,
             rating_moodys_issuance = $3,
             rating_sp_issuance = $4,
             rating_fitch_issuance = $5,
             interest_accrued = $6,
             ic_interest = $7,
             base_rate = $8,
             accrual_start_date = $9,
             accrual_end_date = $10,
             unscheduled_principal_paydown = $11,
             data_source = $12
           WHERE tranche_id = $13 AND report_period_id = $14`,
          [
            note.current_balance,
            note.coupon_rate,
            note.rating_moodys_issuance,
            note.rating_sp_issuance,
            note.rating_fitch_issuance,
            note.interest_accrued,
            note.ic_interest,
            note.base_rate,
            note.accrual_start_date,
            note.accrual_end_date,
            note.unscheduled_principal_paydown,
            note.data_source,
            trancheId,
            reportPeriodId,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO clo_tranche_snapshots (
             id, tranche_id, report_period_id,
             current_balance, coupon_rate,
             rating_moodys_issuance, rating_sp_issuance, rating_fitch_issuance,
             interest_accrued, ic_interest, base_rate,
             accrual_start_date, accrual_end_date,
             unscheduled_principal_paydown, data_source
           ) VALUES (
             gen_random_uuid(), $1, $2,
             $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
           )`,
          [
            trancheId,
            reportPeriodId,
            note.current_balance,
            note.coupon_rate,
            note.rating_moodys_issuance,
            note.rating_sp_issuance,
            note.rating_fitch_issuance,
            note.interest_accrued,
            note.ic_interest,
            note.base_rate,
            note.accrual_start_date,
            note.accrual_end_date,
            note.unscheduled_principal_paydown,
            note.data_source,
          ]
        );
      }
    }

    await client.query("COMMIT");
    return parsed.rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Batch INSERT helper
// ---------------------------------------------------------------------------

async function sdfBatchInsert(
  table: string,
  rows: Record<string, unknown>[],
  client?: import("pg").PoolClient
): Promise<void> {
  if (rows.length === 0) return;

  // Get actual table columns to filter out unknown keys
  const exec = client
    ? (sql: string, params?: unknown[]) =>
        client.query(sql, params).then((r) => r.rows)
    : query;

  const colResult = await exec(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  const validColumns = new Set(
    (colResult as Array<{ column_name: string }>).map((r) => r.column_name)
  );

  // Use first row to determine columns (filter to valid ones, exclude 'id')
  const allKeys = Object.keys(rows[0]);
  const columns = allKeys.filter((k) => validColumns.has(k) && k !== "id");

  if (columns.length === 0) return;

  const colNames = columns.join(", ");

  for (const row of rows) {
    const values = columns.map((c) => {
      const v = row[c];
      if (v === "" || v === "null" || v === "NULL" || v === "undefined")
        return null;
      if (typeof v === "object" && v !== null) return JSON.stringify(v);
      return v;
    });
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    await exec(`INSERT INTO ${table} (${colNames}) VALUES (${placeholders})`, values);
  }
}
