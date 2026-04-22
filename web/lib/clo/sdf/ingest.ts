import { query, getClient } from "../../db";
import { parseTestResults, type SdfTestResultRow } from "./parse-test-results";
import { parseCollateralFile, type SdfCollateralRow } from "./parse-collateral";
import { parseAssetLevel, type SdfAssetLevelRow } from "./parse-asset-level";
import { parseNotes, type SdfNoteRow } from "./parse-notes";
import { parseAccounts, type SdfAccountRow } from "./parse-accounts";
import { parseTransactions, type SdfTransactionRow } from "./parse-transactions";
import { parseAccruals, type SdfAccrualRow } from "./parse-accruals";
import type { SdfFileType, SdfIngestionResult, SdfParseResult } from "./types";

type ParsedFile =
  | { fileType: "test_results"; parsed: SdfParseResult<SdfTestResultRow> }
  | { fileType: "collateral_file"; parsed: SdfParseResult<SdfCollateralRow> }
  | { fileType: "asset_level"; parsed: SdfParseResult<SdfAssetLevelRow> }
  | { fileType: "notes"; parsed: SdfParseResult<SdfNoteRow> }
  | { fileType: "accounts"; parsed: SdfParseResult<SdfAccountRow> }
  | { fileType: "transactions"; parsed: SdfParseResult<SdfTransactionRow> }
  | { fileType: "accruals"; parsed: SdfParseResult<SdfAccrualRow> };

const PROCESSING_ORDER: SdfFileType[] = [
  "notes",
  "collateral_file",
  "asset_level",
  "test_results",
  "accounts",
  "transactions",
  "accruals",
];

const PHASE2_STUBS = new Set<SdfFileType>([]);

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
    } else if (file.fileType === "asset_level") {
      parsed.set("asset_level", {
        fileType: "asset_level",
        parsed: parseAssetLevel(file.csvText),
      });
    } else if (file.fileType === "notes") {
      parsed.set("notes", {
        fileType: "notes",
        parsed: parseNotes(file.csvText),
      });
    } else if (file.fileType === "accounts") {
      parsed.set("accounts", {
        fileType: "accounts",
        parsed: parseAccounts(file.csvText),
      });
    } else if (file.fileType === "transactions") {
      parsed.set("transactions", {
        fileType: "transactions",
        parsed: parseTransactions(file.csvText),
      });
    } else if (file.fileType === "accruals") {
      parsed.set("accruals", {
        fileType: "accruals",
        parsed: parseAccruals(file.csvText),
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

  // If no file provided asOfDate, fall back to most recent existing period or error
  let reportPeriodId: string;
  if (!asOfDate) {
    const latest = await query<{ id: string; report_date: string }>(
      `SELECT id, report_date FROM clo_report_periods WHERE deal_id = $1 ORDER BY report_date DESC LIMIT 1`,
      [dealId]
    );
    if (latest.length > 0) {
      console.warn(`No SDF file provided As_Of_Date — using most recent period: ${latest[0].report_date}`);
      reportPeriodId = latest[0].id;
      asOfDate = latest[0].report_date;
    } else {
      return {
        reportPeriodId: "",
        asOfDate: "",
        results: files.map((f) => ({
          fileType: f.fileType,
          rowCount: 0,
          status: "error" as const,
          error: "No file provided a report date and no existing period found. Include Test Results or upload a compliance PDF first.",
        })),
        skipped: [],
      };
    }
  } else {
    // Resolve report period normally
    reportPeriodId = await resolveReportPeriod(
      dealId,
      asOfDate,
      periodBeginDate
    );
  }

  // Process files in defined order
  const results: SdfIngestionResult["results"] = [];
  const skipped: SdfIngestionResult["skipped"] = [];
  const uploadedTypes = new Set(files.map((f) => f.fileType));
  const handledAssetLevel = uploadedTypes.has("collateral_file") && uploadedTypes.has("asset_level");

  for (const fileType of PROCESSING_ORDER) {
    if (!uploadedTypes.has(fileType)) continue;

    // Skip asset_level if it was handled jointly with collateral_file
    if (fileType === "asset_level" && handledAssetLevel) continue;

    if (PHASE2_STUBS.has(fileType)) {
      results.push({ fileType, rowCount: 0, status: "skipped" });
      continue;
    }

    const entry = parsed.get(fileType);
    if (!entry) continue;

    // When both collateral_file and asset_level are in the batch, run them in a single transaction
    if (fileType === "collateral_file" && handledAssetLevel) {
      const assetEntry = parsed.get("asset_level");
      const client = await getClient();
      try {
        await client.query("BEGIN");
        const collateralCount = await processCollateral(reportPeriodId, entry.parsed as SdfParseResult<SdfCollateralRow>, client, true);
        results.push({
          fileType: "collateral_file",
          rowCount: collateralCount,
          status: collateralCount > 0 ? "success" : "empty",
        });
        if (assetEntry) {
          // Pass uploadedTypes so processAssetLevel skips its pre-check, which
          // otherwise runs on a separate pool connection and can't see the
          // uncommitted Collateral File INSERTs we just made on `client`.
          const assetCount = await processAssetLevel(reportPeriodId, assetEntry.parsed as SdfParseResult<SdfAssetLevelRow>, client, uploadedTypes);
          results.push({
            fileType: "asset_level",
            rowCount: assetCount,
            status: assetCount > 0 ? "success" : "empty",
          });
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error("SDF ingest error for collateral_file+asset_level:", message);
        results.push({ fileType: "collateral_file", rowCount: 0, status: "error", error: message });
        results.push({ fileType: "asset_level", rowCount: 0, status: "error", error: message });
      } finally {
        client.release();
      }
      continue;
    }

    try {
      const rowCount = await processFile(
        dealId,
        reportPeriodId,
        entry,
        uploadedTypes
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
    // Caller should handle null asOfDate before calling this function
    throw new Error("resolveReportPeriod called without asOfDate");
  }

  // Exact match
  const exact = await query<{ id: string }>(
    `SELECT id FROM clo_report_periods WHERE deal_id = $1 AND report_date = $2`,
    [dealId, asOfDate]
  );
  if (exact.length > 0) return exact[0].id;

  // Window fallback: ±7 days
  const window = await query<{ id: string; report_date: string }>(
    `SELECT id, report_date FROM clo_report_periods
     WHERE deal_id = $1
       AND report_date::date BETWEEN ($2::date - INTERVAL '7 days') AND ($2::date + INTERVAL '7 days')
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
  entry: ParsedFile,
  uploadedTypes?: Set<SdfFileType>
): Promise<number> {
  switch (entry.fileType) {
    case "notes":
      return processNotes(dealId, reportPeriodId, entry.parsed);
    case "collateral_file":
      return processCollateral(reportPeriodId, entry.parsed, undefined, uploadedTypes?.has("asset_level") ?? false);
    case "asset_level":
      return processAssetLevel(reportPeriodId, entry.parsed, undefined, uploadedTypes);
    case "test_results":
      return processTestResults(reportPeriodId, entry.parsed);
    case "accounts":
      return processAccounts(reportPeriodId, entry.parsed);
    case "transactions":
      return processTransactions(reportPeriodId, entry.parsed);
    case "accruals":
      return processAccruals(reportPeriodId, entry.parsed);
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
  parsed: SdfParseResult<SdfCollateralRow>,
  externalClient?: import("pg").PoolClient,
  assetLevelInBatch = false
): Promise<number> {
  if (parsed.rows.length === 0) return 0;

  // Check for enrichment data loss — only warn when Asset Level is NOT in the batch
  if (!assetLevelInBatch) {
    const enriched = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM clo_holdings WHERE report_period_id = $1 AND moodys_rating_final IS NOT NULL`,
      [reportPeriodId]
    );
    if (parseInt(enriched[0]?.count ?? "0", 10) > 0) {
      console.warn(
        "SDF ingest: Collateral File re-uploaded without Asset Level — enrichment columns will be reset."
      );
    }
  }

  if (externalClient) {
    await externalClient.query(
      `DELETE FROM clo_holdings WHERE report_period_id = $1`,
      [reportPeriodId]
    );
    const rows = parsed.rows.map((r) => ({
      report_period_id: reportPeriodId,
      ...r,
    }));
    await sdfBatchInsert("clo_holdings", rows, externalClient);
    return parsed.rows.length;
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
// Asset Level — enrich existing clo_holdings rows
// ---------------------------------------------------------------------------

// Columns from Asset Level that enrich holdings (excludes matching keys)
const ENRICHMENT_COLUMNS = [
  "moodys_issuer_rating",
  "moodys_issuer_sr_unsec_rating",
  "moodys_rating_final",
  "sp_issuer_rating",
  "sp_rating_final",
  "fitch_issuer_rating",
  "fitch_rating_final",
  "moodys_security_rating",
  "sp_security_rating",
  "fitch_security_rating",
  "moodys_dp_rating",
  "moodys_rating_unadjusted",
  "moodys_issuer_watch",
  "moodys_security_watch",
  "sp_issuer_watch",
  "sp_security_watch",
  "security_level_moodys",
  "security_level_sp",
  "security_level",
  "lien_type",
  "sp_priority_category",
  "sp_industry_code",
  "moodys_industry_code",
  "fitch_industry_code",
  "kbra_industry",
  "kbra_rating",
  "kbra_recovery_rate",
  "pik_amount",
  "credit_spread_adj",
  "is_current_pay",
  "is_defaulted",
  "is_sovereign",
  "is_enhanced_bond",
  "is_interest_only",
  "is_principal_only",
  "accretion_factor",
  "aggregate_amortized_cost",
  "capitalization_pct",
  "average_life",
  "guarantor",
  "current_price",
  "facility_id",
  "figi",
  "native_currency",
  "next_payment_date",
  "call_date",
  "put_date",
  "deal_defaulted_begin",
  "servicer",
  "servicer_moodys_rating",
  "servicer_sp_rating",
] as const;

async function processAssetLevel(
  reportPeriodId: string,
  parsed: SdfParseResult<SdfAssetLevelRow>,
  externalClient?: import("pg").PoolClient,
  uploadedTypes?: Set<SdfFileType>
): Promise<number> {
  if (parsed.rows.length === 0) return 0;

  if (!uploadedTypes?.has("collateral_file")) {
    const existing = await query(
      `SELECT 1 FROM clo_holdings WHERE report_period_id = $1 AND data_source = 'sdf' LIMIT 1`,
      [reportPeriodId]
    );
    if (existing.length === 0) {
      console.warn("Skipping Asset Level — no SDF holdings exist. Upload Collateral File first.");
      return 0;
    }
  }

  const client = externalClient ?? await getClient();
  try {
    if (!externalClient) await client.query("BEGIN");

    // Build the COALESCE-based UPDATE SET clause.
    // Note: COALESCE treats false as non-null (present), which is correct — boolean columns
    // such as is_current_pay and is_defaulted can legitimately be false, and Asset Level
    // data takes precedence over Collateral File per ingestion precedence rules.
    const setClauses = ENRICHMENT_COLUMNS.map(
      (col, i) => `${col} = COALESCE($${i + 2}, ${col})`
    );
    const setSQL = setClauses.join(", ");

    // WHERE-clause match key lands at the same position in both queries:
    // $1 is reportPeriodId, $2..$(N+1) are enrichmentValues, and the match key is $(N+2).
    // Each query is executed independently with its own param array [reportPeriodId, ...enrichmentValues, matchKey],
    // so both lxid and obligor fall at the same index.
    const matchKeyParamIdx = ENRICHMENT_COLUMNS.length + 2;

    const updateByLxidSQL = `UPDATE clo_holdings SET ${setSQL} WHERE report_period_id = $1 AND lxid = $${matchKeyParamIdx}`;
    const updateByObligorSQL = `UPDATE clo_holdings SET ${setSQL} WHERE report_period_id = $1 AND obligor_name = $${matchKeyParamIdx}`;

    let enrichedCount = 0;

    for (const row of parsed.rows) {
      const enrichmentValues = ENRICHMENT_COLUMNS.map((col) => {
        const val = row[col as keyof SdfAssetLevelRow];
        return val === null || val === undefined ? null : val;
      });

      const baseParams = [reportPeriodId, ...enrichmentValues];

      // Try matching by lxid first
      let matched = 0;
      if (row.lxid) {
        const result = await client.query(updateByLxidSQL, [
          ...baseParams,
          row.lxid,
        ]);
        matched = result.rowCount ?? 0;
      }

      // Fall back to obligor_name matching
      if (matched === 0 && row.issuer_name) {
        const result = await client.query(updateByObligorSQL, [
          ...baseParams,
          row.issuer_name,
        ]);
        matched = result.rowCount ?? 0;
        if (matched > 1) {
          console.warn(
            `SDF Asset Level: broadcast enrichment to ${matched} holdings for obligor "${row.issuer_name}"`
          );
        }
      }

      if (matched === 0) {
        console.warn(
          `SDF Asset Level: no matching holding for lxid=${row.lxid}, issuer="${row.issuer_name}"`
        );
      }

      enrichedCount += matched;
    }

    if (!externalClient) await client.query("COMMIT");
    return enrichedCount;
  } catch (err) {
    if (!externalClient) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (!externalClient) client.release();
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
             ending_balance = COALESCE($1, ending_balance),
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
             current_balance, ending_balance, coupon_rate,
             rating_moodys_issuance, rating_sp_issuance, rating_fitch_issuance,
             interest_accrued, ic_interest, base_rate,
             accrual_start_date, accrual_end_date,
             unscheduled_principal_paydown, data_source
           ) VALUES (
             gen_random_uuid(), $1, $2,
             $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
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
// Accounts — DELETE + INSERT
// ---------------------------------------------------------------------------

async function processAccounts(
  reportPeriodId: string,
  parsed: SdfParseResult<SdfAccountRow>
): Promise<number> {
  if (parsed.rows.length === 0) return 0;

  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM clo_account_balances WHERE report_period_id = $1`,
      [reportPeriodId]
    );

    const rows = parsed.rows.map((r) => ({
      report_period_id: reportPeriodId,
      ...r,
    }));
    await sdfBatchInsert("clo_account_balances", rows, client);

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
// Transactions — DELETE + INSERT
// ---------------------------------------------------------------------------

async function processTransactions(
  reportPeriodId: string,
  parsed: SdfParseResult<SdfTransactionRow>
): Promise<number> {
  if (parsed.rows.length === 0) return 0;

  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM clo_trades WHERE report_period_id = $1`,
      [reportPeriodId]
    );

    const rows = parsed.rows.map((r) => ({
      report_period_id: reportPeriodId,
      ...r,
    }));
    await sdfBatchInsert("clo_trades", rows, client);

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
// Accruals — DELETE + INSERT
// ---------------------------------------------------------------------------

async function processAccruals(
  reportPeriodId: string,
  parsed: SdfParseResult<SdfAccrualRow>
): Promise<number> {
  if (parsed.rows.length === 0) return 0;

  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM clo_accruals WHERE report_period_id = $1`,
      [reportPeriodId]
    );

    const rows = parsed.rows.map((r) => ({
      report_period_id: reportPeriodId,
      ...r,
    }));
    await sdfBatchInsert("clo_accruals", rows, client);

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

const VALID_SQL_NAME = /^[a-z_][a-z0-9_]*$/;

function validateSqlName(name: string): string {
  if (!VALID_SQL_NAME.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return name;
}

const BATCH_SIZE = 50;

async function sdfBatchInsert(
  table: string,
  rows: Record<string, unknown>[],
  client?: import("pg").PoolClient
): Promise<void> {
  if (rows.length === 0) return;

  const safeTable = validateSqlName(table);

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

  const safeColumns = columns.map(validateSqlName);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values: unknown[] = [];
    const rowPlaceholders: string[] = [];

    for (const row of batch) {
      const rowVals = columns.map((c) => {
        const v = row[c];
        if (v === "") return null;
        if (typeof v === "object" && v !== null) return JSON.stringify(v);
        return v ?? null;
      });
      const offset = values.length;
      rowPlaceholders.push(`(${columns.map((_, j) => `$${offset + j + 1}`).join(", ")})`);
      values.push(...rowVals);
    }

    await exec(
      `INSERT INTO ${safeTable} (${safeColumns.join(", ")}) VALUES ${rowPlaceholders.join(", ")}`,
      values
    );
  }
}
