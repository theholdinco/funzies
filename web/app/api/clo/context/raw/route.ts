import { NextRequest, NextResponse } from "next/server";
import type { PoolClient, QueryResultRow } from "pg";
import { getCurrentUser } from "@/lib/auth-helpers";
import { getProfileForUser } from "@/lib/clo/access";
import { getClient } from "@/lib/db";

const RESTORABLE_REPORT_TABLES = new Set([
  "clo_tranches",
  "clo_tranche_snapshots",
  "clo_pool_summary",
  "clo_compliance_tests",
  "clo_concentrations",
  "clo_holdings",
  "clo_accruals",
  "clo_trades",
  "clo_waterfall_steps",
  "clo_account_balances",
  "clo_par_value_adjustments",
  "clo_proceeds",
  "clo_extraction_overflow",
  "clo_trading_summary",
  "clo_events",
]);
const REPORT_TYPES = new Set(["quarterly", "semi-annual", "annual", "ad-hoc"]);

type RestorableReportTable =
  | "clo_tranches"
  | "clo_tranche_snapshots"
  | "clo_pool_summary"
  | "clo_compliance_tests"
  | "clo_concentrations"
  | "clo_holdings"
  | "clo_accruals"
  | "clo_trades"
  | "clo_waterfall_steps"
  | "clo_account_balances"
  | "clo_par_value_adjustments"
  | "clo_proceeds"
  | "clo_extraction_overflow"
  | "clo_trading_summary"
  | "clo_events";

const REPORT_ROW_IMPORTS: Array<{ rawKey: string; table: RestorableReportTable; countKey: string }> = [
  { rawKey: "holdings", table: "clo_holdings", countKey: "holdings" },
  { rawKey: "accruals", table: "clo_accruals", countKey: "accruals" },
  { rawKey: "trades", table: "clo_trades", countKey: "trades" },
  { rawKey: "waterfallSteps", table: "clo_waterfall_steps", countKey: "waterfallSteps" },
  { rawKey: "accountBalances", table: "clo_account_balances", countKey: "accountBalances" },
  { rawKey: "parValueAdjustments", table: "clo_par_value_adjustments", countKey: "parValueAdjustments" },
  { rawKey: "proceeds", table: "clo_proceeds", countKey: "proceeds" },
  { rawKey: "overflow", table: "clo_extraction_overflow", countKey: "overflow" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function rowToDbColumns(
  row: Record<string, unknown>,
  columns: Set<string>,
  fixedColumns: Record<string, unknown>,
  skippedKeys: Set<string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...fixedColumns };
  for (const [key, value] of Object.entries(row)) {
    if (skippedKeys.has(key)) continue;
    const column = camelToSnake(key);
    if (columns.has(column)) next[column] = value;
  }
  if (columns.has("data_source") && next.data_source == null) {
    next.data_source = "context_import";
  }
  return next;
}

async function queryRows<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await client.query<T>(text, params);
  return result.rows;
}

async function tableColumns(client: PoolClient, table: string): Promise<Set<string>> {
  if (!RESTORABLE_REPORT_TABLES.has(table)) {
    throw new Error(`Unsupported context restore table: ${table}`);
  }
  const rows = await queryRows<{ column_name: string }>(
    client,
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(rows.map((row) => row.column_name));
}

async function replaceReportRows(
  client: PoolClient,
  table: RestorableReportTable,
  rows: Record<string, unknown>[],
  fixedColumns: Record<string, unknown>,
): Promise<number> {
  if (table === "clo_events") {
    await client.query(`DELETE FROM ${table} WHERE deal_id = $1 AND report_period_id = $2`, [
      fixedColumns.deal_id,
      fixedColumns.report_period_id,
    ]);
  } else {
    await client.query(`DELETE FROM ${table} WHERE report_period_id = $1`, [fixedColumns.report_period_id]);
  }

  if (rows.length === 0) return 0;

  return insertReportRows(client, table, rows, fixedColumns);
}

async function insertReportRows(
  client: PoolClient,
  table: RestorableReportTable,
  rows: Record<string, unknown>[],
  fixedColumns: Record<string, unknown>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = await tableColumns(client, table);
  const skippedKeys = new Set([
    "id",
    "reportPeriodId",
    "report_period_id",
    "dealId",
    "deal_id",
  ]);
  const insertRows = rows.map((row) => {
    return rowToDbColumns(row, columns, fixedColumns, skippedKeys);
  });

  const insertColumns = Array.from(
    new Set(insertRows.flatMap((row) => Object.keys(row))),
  ).filter((column) => columns.has(column) && column !== "id" && column !== "created_at" && column !== "updated_at");
  const fixedColumnNames = new Set(Object.keys(fixedColumns));
  const sourceColumns = insertColumns.filter((column) => !fixedColumnNames.has(column) && column !== "data_source");
  if (sourceColumns.length === 0) {
    throw new Error(`No insertable columns found while restoring ${table}`);
  }

  const values: unknown[] = [];
  const tuples = insertRows.map((row) => {
    const placeholders = insertColumns.map((column) => {
      values.push(row[column] ?? null);
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  await client.query(
    `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES ${tuples.join(", ")}`,
    values,
  );
  return insertRows.length;
}

async function restoreEvents(
  client: PoolClient,
  dealId: string,
  reportPeriodId: string,
  rows: Record<string, unknown>[],
  sourceReportPeriodId: string | null,
): Promise<number> {
  await client.query(
    `DELETE FROM clo_events
     WHERE deal_id = $1 AND (report_period_id = $2 OR report_period_id IS NULL)`,
    [dealId, reportPeriodId],
  );
  if (rows.length === 0) return 0;

  const currentPeriodEvents: Record<string, unknown>[] = [];
  const dealLevelEvents: Record<string, unknown>[] = [];
  for (const event of rows) {
    const hasEventPeriodKey = hasOwn(event, "reportPeriodId") || hasOwn(event, "report_period_id");
    const eventReportPeriodId = firstText(event.reportPeriodId, event.report_period_id);
    if (eventReportPeriodId != null && sourceReportPeriodId != null && eventReportPeriodId !== sourceReportPeriodId) {
      continue;
    }
    if (hasEventPeriodKey && eventReportPeriodId == null) {
      dealLevelEvents.push(event);
    } else {
      currentPeriodEvents.push(event);
    }
  }

  const currentCount = await insertReportRows(
    client,
    "clo_events",
    currentPeriodEvents,
    { report_period_id: reportPeriodId, deal_id: dealId },
  );
  const dealLevelCount = await insertReportRows(
    client,
    "clo_events",
    dealLevelEvents,
    { report_period_id: null, deal_id: dealId },
  );
  return currentCount + dealLevelCount;
}

async function restoreTranches(
  client: PoolClient,
  dealId: string,
  rows: Record<string, unknown>[],
): Promise<{ count: number; idMap: Map<string, string> }> {
  const idMap = new Map<string, string>();
  if (rows.length === 0) {
    await client.query("DELETE FROM clo_tranches WHERE deal_id = $1", [dealId]);
    return { count: 0, idMap };
  }

  const table = "clo_tranches";
  const columns = await tableColumns(client, table);
  const skippedKeys = new Set(["id", "dealId", "deal_id"]);
  const existingRows = await queryRows<{
    id: string;
    class_name: string | null;
    isin: string | null;
    cusip: string | null;
    common_code: string | null;
  }>(
    client,
    `SELECT id, class_name, isin, cusip, common_code FROM clo_tranches WHERE deal_id = $1`,
    [dealId],
  );
  const existingByKey = new Map<string, string>();
  const addExistingKey = (kind: string, value: unknown, id: string) => {
    const text = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (text) existingByKey.set(`${kind}:${text}`, id);
  };
  for (const row of existingRows) {
    addExistingKey("class", row.class_name, row.id);
    addExistingKey("isin", row.isin, row.id);
    addExistingKey("cusip", row.cusip, row.id);
    addExistingKey("common", row.common_code, row.id);
  }

  let count = 0;
  const restoredIds: string[] = [];
  for (const sourceRow of rows) {
    const oldId = firstText(sourceRow.id);
    const className = firstText(sourceRow.className, sourceRow.class_name);
    if (!className) throw new Error("Cannot restore tranche without className");

    const lookupKeys = [
      ["class", className],
      ["isin", sourceRow.isin],
      ["cusip", sourceRow.cusip],
      ["common", sourceRow.commonCode ?? sourceRow.common_code],
    ] as const;
    let existingId: string | undefined;
    for (const [kind, value] of lookupKeys) {
      const text = typeof value === "string" ? value.trim().toUpperCase() : "";
      if (!text) continue;
      existingId = existingByKey.get(`${kind}:${text}`);
      if (existingId) break;
    }

    const dbRow = rowToDbColumns(sourceRow, columns, { deal_id: dealId }, skippedKeys);
    const insertColumns = Object.keys(dbRow).filter((column) =>
      columns.has(column) && column !== "id" && column !== "created_at" && column !== "updated_at"
    );
    const fixedColumnNames = new Set(["deal_id"]);
    const sourceColumns = insertColumns.filter((column) => !fixedColumnNames.has(column));
    if (sourceColumns.length === 0) throw new Error(`No insertable columns found while restoring ${table}`);

    let restoredId: string;
    if (existingId) {
      const updateColumns = insertColumns.filter((column) => column !== "deal_id");
      const values = updateColumns.map((column) => dbRow[column] ?? null);
      values.push(existingId, dealId);
      await client.query(
        `UPDATE ${table} SET ${updateColumns.map((column, idx) => `${column} = $${idx + 1}`).join(", ")}
         WHERE id = $${updateColumns.length + 1} AND deal_id = $${updateColumns.length + 2}`,
        values,
      );
      restoredId = existingId;
    } else {
      const values = insertColumns.map((column) => dbRow[column] ?? null);
      const placeholders = insertColumns.map((_, idx) => `$${idx + 1}`);
      const inserted = await queryRows<{ id: string }>(
        client,
        `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id`,
        values,
      );
      restoredId = inserted[0].id;
    }

    if (oldId) idMap.set(oldId, restoredId);
    restoredIds.push(restoredId);
    addExistingKey("class", className, restoredId);
    addExistingKey("isin", sourceRow.isin, restoredId);
    addExistingKey("cusip", sourceRow.cusip, restoredId);
    addExistingKey("common", sourceRow.commonCode ?? sourceRow.common_code, restoredId);
    count++;
  }
  await client.query(
    "DELETE FROM clo_tranches WHERE deal_id = $1 AND NOT (id = ANY($2::uuid[]))",
    [dealId, restoredIds],
  );
  return { count, idMap };
}

async function restoreTrancheSnapshots(
  client: PoolClient,
  dealId: string,
  reportPeriodId: string,
  rows: Record<string, unknown>[],
  trancheIdMap: Map<string, string>,
): Promise<number> {
  const table = "clo_tranche_snapshots";
  await client.query(`DELETE FROM ${table} WHERE report_period_id = $1`, [reportPeriodId]);
  if (rows.length === 0) return 0;

  const columns = await tableColumns(client, table);
  const skippedKeys = new Set(["id", "reportPeriodId", "report_period_id", "trancheId", "tranche_id"]);
  const existingTrancheIds = new Set(
    (await queryRows<{ id: string }>(client, "SELECT id FROM clo_tranches WHERE deal_id = $1", [dealId]))
      .map((row) => row.id),
  );

  const insertRows = rows.map((sourceRow) => {
    const sourceTrancheId = firstText(sourceRow.trancheId, sourceRow.tranche_id);
    const restoredTrancheId =
      (sourceTrancheId ? trancheIdMap.get(sourceTrancheId) : undefined) ??
      (sourceTrancheId && existingTrancheIds.has(sourceTrancheId) ? sourceTrancheId : undefined);
    if (!restoredTrancheId) {
      throw new Error(`Cannot restore tranche snapshot without a matching tranche (${sourceTrancheId ?? "missing id"})`);
    }
    return rowToDbColumns(
      sourceRow,
      columns,
      { report_period_id: reportPeriodId, tranche_id: restoredTrancheId },
      skippedKeys,
    );
  });

  const insertColumns = Array.from(
    new Set(insertRows.flatMap((row) => Object.keys(row))),
  ).filter((column) => columns.has(column) && column !== "id" && column !== "created_at" && column !== "updated_at");
  const sourceColumns = insertColumns.filter((column) => column !== "report_period_id" && column !== "tranche_id" && column !== "data_source");
  if (sourceColumns.length === 0) throw new Error(`No insertable columns found while restoring ${table}`);

  const values: unknown[] = [];
  const tuples = insertRows.map((row) => {
    const placeholders = insertColumns.map((column) => {
      values.push(row[column] ?? null);
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  await client.query(
    `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES ${tuples.join(", ")}`,
    values,
  );
  return insertRows.length;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function reportType(value: unknown): string | null {
  const text = firstText(value);
  const normalized = text?.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "semiannual") return "semi-annual";
  return normalized && REPORT_TYPES.has(normalized) ? normalized : null;
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const body = await request.json();
  const raw = asRecord(body.raw);
  const rawDeal = asRecord(raw.deal);
  const rawDealDates = asRecord(raw.dealDates);
  const rawComplianceData = asRecord(raw.complianceData);
  const rawConstraints = asRecord(raw.constraints);
  const rawFundProfile = asRecord(raw.fundProfile);
  const dealIdentity = asRecord(rawConstraints.dealIdentity);
  const keyDates = asRecord(rawConstraints.keyDates);

  const reportDate = firstText(rawDealDates.reportDate, rawDeal.reportDate, rawComplianceData.reportDate);
  if (!reportDate) {
    return NextResponse.json(
      { error: "Imported raw context needs dealDates.reportDate or complianceData.reportDate to restore report-level rows" },
      { status: 400 },
    );
  }
  const constraintsJson = raw.constraints == null ? null : JSON.stringify(raw.constraints);
  const supplementaryDataJson = raw.supplementaryData == null ? null : JSON.stringify(raw.supplementaryData);
  const intexAssumptionsJson = rawDeal.intexAssumptions == null ? null : JSON.stringify(rawDeal.intexAssumptions);
  const dataQualityJson = rawDealDates.dataQuality == null ? null : JSON.stringify(rawDealDates.dataQuality);
  const isFinal = typeof rawDealDates.isFinal === "boolean" ? rawDealDates.isFinal : null;

  const client = await getClient();
  try {
    await client.query("BEGIN");

    const profileUpdates: string[] = [];
    const profileValues: unknown[] = [];
    const addProfileUpdate = (column: string, value: unknown, cast = "") => {
      profileValues.push(value);
      profileUpdates.push(`${column} = $${profileValues.length}${cast}`);
    };
    if (hasOwn(raw, "constraints")) {
      addProfileUpdate("extracted_constraints", constraintsJson, "::jsonb");
    }
    if (hasOwn(raw, "equityInceptionData")) {
      addProfileUpdate(
        "equity_inception_data",
        raw.equityInceptionData == null ? null : JSON.stringify(raw.equityInceptionData),
        "::jsonb",
      );
    }
    const fundProfileColumns: Array<[string, string]> = [
      ["fundStrategy", "fund_strategy"],
      ["targetSectors", "target_sectors"],
      ["riskAppetite", "risk_appetite"],
      ["portfolioSize", "portfolio_size"],
      ["reinvestmentPeriod", "reinvestment_period"],
      ["concentrationLimits", "concentration_limits"],
      ["covenantPreferences", "covenant_preferences"],
      ["ratingThresholds", "rating_thresholds"],
      ["spreadTargets", "spread_targets"],
      ["regulatoryConstraints", "regulatory_constraints"],
      ["portfolioDescription", "portfolio_description"],
      ["beliefsAndBiases", "beliefs_and_biases"],
    ];
    for (const [key, column] of fundProfileColumns) {
      if (hasOwn(rawFundProfile, key)) {
        addProfileUpdate(column, rawFundProfile[key] ?? null);
      }
    }
    if (profileUpdates.length > 0) {
      profileValues.push(profile.id);
      await client.query(
        `UPDATE clo_profiles SET ${profileUpdates.join(", ")}, updated_at = now() WHERE id = $${profileValues.length}`,
        profileValues,
      );
    }

    const dealRows = await queryRows<{ id: string }>(
      client,
      `INSERT INTO clo_deals (
         profile_id, deal_name, deal_currency, deal_currency_raw, deal_currency_canonical,
         deal_currency_source, closing_date, effective_date, reinvestment_period_end,
         non_call_period_end, stated_maturity_date, deal_short_name, issuer_legal_entity,
         jurisdiction, wal_test_date, deal_type, deal_version, trustee_name,
         collateral_manager, collateral_administrator, governing_document, governing_law,
         intex_assumptions, ppm_constraints, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,now())
       ON CONFLICT (profile_id) DO UPDATE SET
         deal_name = COALESCE(EXCLUDED.deal_name, clo_deals.deal_name),
         deal_currency = COALESCE(EXCLUDED.deal_currency, clo_deals.deal_currency),
         deal_currency_raw = COALESCE(EXCLUDED.deal_currency_raw, clo_deals.deal_currency_raw),
         deal_currency_canonical = COALESCE(EXCLUDED.deal_currency_canonical, clo_deals.deal_currency_canonical),
         deal_currency_source = COALESCE(EXCLUDED.deal_currency_source, clo_deals.deal_currency_source),
         closing_date = COALESCE(EXCLUDED.closing_date, clo_deals.closing_date),
         effective_date = COALESCE(EXCLUDED.effective_date, clo_deals.effective_date),
         reinvestment_period_end = COALESCE(EXCLUDED.reinvestment_period_end, clo_deals.reinvestment_period_end),
         non_call_period_end = COALESCE(EXCLUDED.non_call_period_end, clo_deals.non_call_period_end),
         stated_maturity_date = COALESCE(EXCLUDED.stated_maturity_date, clo_deals.stated_maturity_date),
         deal_short_name = COALESCE(EXCLUDED.deal_short_name, clo_deals.deal_short_name),
         issuer_legal_entity = COALESCE(EXCLUDED.issuer_legal_entity, clo_deals.issuer_legal_entity),
         jurisdiction = COALESCE(EXCLUDED.jurisdiction, clo_deals.jurisdiction),
         wal_test_date = COALESCE(EXCLUDED.wal_test_date, clo_deals.wal_test_date),
         deal_type = COALESCE(EXCLUDED.deal_type, clo_deals.deal_type),
         deal_version = COALESCE(EXCLUDED.deal_version, clo_deals.deal_version),
         trustee_name = COALESCE(EXCLUDED.trustee_name, clo_deals.trustee_name),
         collateral_manager = COALESCE(EXCLUDED.collateral_manager, clo_deals.collateral_manager),
         collateral_administrator = COALESCE(EXCLUDED.collateral_administrator, clo_deals.collateral_administrator),
         governing_document = COALESCE(EXCLUDED.governing_document, clo_deals.governing_document),
         governing_law = COALESCE(EXCLUDED.governing_law, clo_deals.governing_law),
         intex_assumptions = COALESCE(EXCLUDED.intex_assumptions, clo_deals.intex_assumptions),
         ppm_constraints = COALESCE(EXCLUDED.ppm_constraints, clo_deals.ppm_constraints),
         updated_at = now()
       RETURNING id`,
      [
        profile.id,
        firstText(rawDeal.dealName, dealIdentity.dealName),
        firstText(rawDeal.dealCurrency, rawDealDates.dealCurrency, dealIdentity.currency),
        firstText(rawDeal.dealCurrencyRaw, rawDeal.dealCurrency, rawDealDates.dealCurrency, dealIdentity.currency),
        firstText(rawDeal.dealCurrencyCanonical, rawDeal.dealCurrency, rawDealDates.dealCurrency, dealIdentity.currency),
        firstText(rawDeal.dealCurrencySource) ?? "context_import",
        firstText(rawDeal.closingDate, rawDealDates.closingDate, keyDates.closingDate, keyDates.originalIssueDate),
        firstText(rawDeal.effectiveDate, rawDealDates.effectiveDate, keyDates.effectiveDate, keyDates.currentIssueDate),
        firstText(rawDeal.reinvestmentPeriodEnd, rawDealDates.reinvestmentPeriodEnd, keyDates.reinvestmentPeriodEnd),
        firstText(rawDeal.nonCallPeriodEnd, rawDealDates.nonCallPeriodEnd, keyDates.nonCallPeriodEnd),
        firstText(rawDeal.statedMaturityDate, rawDealDates.maturity, keyDates.maturityDate),
        firstText(rawDeal.dealShortName),
        firstText(rawDeal.issuerLegalEntity),
        firstText(rawDeal.jurisdiction),
        firstText(rawDeal.walTestDate),
        firstText(rawDeal.dealType),
        firstText(rawDeal.dealVersion),
        firstText(rawDeal.trusteeName),
        firstText(rawDeal.collateralManager),
        firstText(rawDeal.collateralAdministrator),
        firstText(rawDeal.governingDocument),
        firstText(rawDeal.governingLaw),
        intexAssumptionsJson,
        constraintsJson,
      ],
    );

    const dealId = dealRows[0].id;
    const dealUpdates: string[] = [];
    const dealValues: unknown[] = [];
    const addDealUpdate = (key: string, column: string, value: unknown, cast = "") => {
      if (!hasOwn(rawDeal, key)) return;
      dealValues.push(value);
      dealUpdates.push(`${column} = $${dealValues.length}${cast}`);
    };
    addDealUpdate("dealName", "deal_name", firstText(rawDeal.dealName));
    addDealUpdate("dealCurrency", "deal_currency", firstText(rawDeal.dealCurrency));
    addDealUpdate("dealCurrencyRaw", "deal_currency_raw", firstText(rawDeal.dealCurrencyRaw));
    addDealUpdate("dealCurrencyCanonical", "deal_currency_canonical", firstText(rawDeal.dealCurrencyCanonical));
    addDealUpdate("dealCurrencySource", "deal_currency_source", firstText(rawDeal.dealCurrencySource));
    addDealUpdate("closingDate", "closing_date", firstText(rawDeal.closingDate));
    addDealUpdate("effectiveDate", "effective_date", firstText(rawDeal.effectiveDate));
    addDealUpdate("reinvestmentPeriodEnd", "reinvestment_period_end", firstText(rawDeal.reinvestmentPeriodEnd));
    addDealUpdate("nonCallPeriodEnd", "non_call_period_end", firstText(rawDeal.nonCallPeriodEnd));
    addDealUpdate("statedMaturityDate", "stated_maturity_date", firstText(rawDeal.statedMaturityDate));
    addDealUpdate("dealShortName", "deal_short_name", firstText(rawDeal.dealShortName));
    addDealUpdate("issuerLegalEntity", "issuer_legal_entity", firstText(rawDeal.issuerLegalEntity));
    addDealUpdate("jurisdiction", "jurisdiction", firstText(rawDeal.jurisdiction));
    addDealUpdate("walTestDate", "wal_test_date", firstText(rawDeal.walTestDate));
    addDealUpdate("dealType", "deal_type", firstText(rawDeal.dealType));
    addDealUpdate("dealVersion", "deal_version", firstText(rawDeal.dealVersion));
    addDealUpdate("trusteeName", "trustee_name", firstText(rawDeal.trusteeName));
    addDealUpdate("collateralManager", "collateral_manager", firstText(rawDeal.collateralManager));
    addDealUpdate("collateralAdministrator", "collateral_administrator", firstText(rawDeal.collateralAdministrator));
    addDealUpdate("governingDocument", "governing_document", firstText(rawDeal.governingDocument));
    addDealUpdate("governingLaw", "governing_law", firstText(rawDeal.governingLaw));
    addDealUpdate(
      "intexAssumptions",
      "intex_assumptions",
      rawDeal.intexAssumptions == null ? null : JSON.stringify(rawDeal.intexAssumptions),
      "::jsonb",
    );
    if (hasOwn(raw, "constraints")) {
      dealValues.push(constraintsJson);
      dealUpdates.push(`ppm_constraints = $${dealValues.length}::jsonb`);
    }
    if (dealUpdates.length > 0) {
      dealValues.push(dealId);
      await client.query(
        `UPDATE clo_deals SET ${dealUpdates.join(", ")}, updated_at = now() WHERE id = $${dealValues.length}`,
        dealValues,
      );
    }

    const periodRows = await queryRows<{ id: string }>(
      client,
      `INSERT INTO clo_report_periods (
         deal_id, report_date, payment_date, previous_payment_date, report_type,
         reporting_period_start, reporting_period_end, is_final, report_source,
         extraction_status, raw_extraction, supplementary_data, data_quality, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'context_import', 'complete', $9::jsonb, $10::jsonb, $11::jsonb, now())
       ON CONFLICT (deal_id, report_date) DO UPDATE SET
         payment_date = COALESCE(EXCLUDED.payment_date, clo_report_periods.payment_date),
         previous_payment_date = COALESCE(EXCLUDED.previous_payment_date, clo_report_periods.previous_payment_date),
         report_type = COALESCE(EXCLUDED.report_type, clo_report_periods.report_type),
         reporting_period_start = COALESCE(EXCLUDED.reporting_period_start, clo_report_periods.reporting_period_start),
         reporting_period_end = COALESCE(EXCLUDED.reporting_period_end, clo_report_periods.reporting_period_end),
         is_final = COALESCE(EXCLUDED.is_final, clo_report_periods.is_final),
         supplementary_data = COALESCE(EXCLUDED.supplementary_data, clo_report_periods.supplementary_data),
         data_quality = COALESCE(EXCLUDED.data_quality, clo_report_periods.data_quality),
         report_source = 'context_import',
         extraction_status = 'complete',
         raw_extraction = EXCLUDED.raw_extraction,
         updated_at = now()
       RETURNING id`,
      [
        dealId,
        reportDate,
        firstText(rawDealDates.paymentDate, rawDeal.paymentDate),
        firstText(rawDealDates.previousPaymentDate, rawDeal.previousPaymentDate),
        reportType(rawDealDates.reportType ?? rawDeal.reportType),
        firstText(rawDealDates.reportingPeriodStart, rawDeal.reportingPeriodStart),
        firstText(rawDealDates.reportingPeriodEnd, rawDeal.reportingPeriodEnd),
        isFinal,
        JSON.stringify(raw),
        supplementaryDataJson,
        dataQualityJson,
      ],
    );
    const reportPeriodId = periodRows[0].id;
    const periodUpdates: string[] = [];
    const periodValues: unknown[] = [];
    const addPeriodUpdate = (key: string, column: string, value: unknown, cast = "") => {
      if (!hasOwn(rawDealDates, key)) return;
      periodValues.push(value);
      periodUpdates.push(`${column} = $${periodValues.length}${cast}`);
    };
    addPeriodUpdate("paymentDate", "payment_date", firstText(rawDealDates.paymentDate));
    addPeriodUpdate("previousPaymentDate", "previous_payment_date", firstText(rawDealDates.previousPaymentDate));
    addPeriodUpdate("reportType", "report_type", reportType(rawDealDates.reportType));
    addPeriodUpdate("reportingPeriodStart", "reporting_period_start", firstText(rawDealDates.reportingPeriodStart));
    addPeriodUpdate("reportingPeriodEnd", "reporting_period_end", firstText(rawDealDates.reportingPeriodEnd));
    addPeriodUpdate("isFinal", "is_final", typeof rawDealDates.isFinal === "boolean" ? rawDealDates.isFinal : null);
    addPeriodUpdate("dataQuality", "data_quality", dataQualityJson, "::jsonb");
    if (hasOwn(raw, "supplementaryData")) {
      periodValues.push(supplementaryDataJson);
      periodUpdates.push(`supplementary_data = $${periodValues.length}::jsonb`);
    }
    if (periodUpdates.length > 0) {
      periodValues.push(reportPeriodId);
      await client.query(
        `UPDATE clo_report_periods SET ${periodUpdates.join(", ")}, updated_at = now() WHERE id = $${periodValues.length}`,
        periodValues,
      );
    }

    const counts: Record<string, number> = {};
    const reportFixedColumns = { report_period_id: reportPeriodId };
    let trancheIdMap = new Map<string, string>();
    if (Array.isArray(raw.tranches)) {
      const restoredTranches = await restoreTranches(
        client,
        dealId,
        raw.tranches as Record<string, unknown>[],
      );
      trancheIdMap = restoredTranches.idMap;
      counts.tranches = restoredTranches.count;
    }
    if (Array.isArray(raw.trancheSnapshots)) {
      counts.trancheSnapshots = await restoreTrancheSnapshots(
        client,
        dealId,
        reportPeriodId,
        raw.trancheSnapshots as Record<string, unknown>[],
        trancheIdMap,
      );
    }
    const poolSummary = asRecord(rawComplianceData.poolSummary);
    if (hasOwn(rawComplianceData, "poolSummary")) {
      counts.poolSummary = await replaceReportRows(
        client,
        "clo_pool_summary",
        Object.keys(poolSummary).length > 0 ? [poolSummary] : [],
        reportFixedColumns,
      );
    }
    if (Array.isArray(rawComplianceData.complianceTests)) {
      counts.complianceTests = await replaceReportRows(
        client,
        "clo_compliance_tests",
        rawComplianceData.complianceTests as Record<string, unknown>[],
        reportFixedColumns,
      );
    }
    if (Array.isArray(rawComplianceData.concentrations)) {
      counts.concentrations = await replaceReportRows(
        client,
        "clo_concentrations",
        rawComplianceData.concentrations as Record<string, unknown>[],
        reportFixedColumns,
      );
    }
    for (const { rawKey, table, countKey } of REPORT_ROW_IMPORTS) {
      const rows = raw[rawKey];
      if (!Array.isArray(rows)) continue;
      counts[countKey] = await replaceReportRows(
        client,
        table,
        rows as Record<string, unknown>[],
        reportFixedColumns,
      );
    }
    if (hasOwn(raw, "tradingSummary")) {
      const tradingSummary = asRecord(raw.tradingSummary);
      counts.tradingSummary = await replaceReportRows(
        client,
        "clo_trading_summary",
        Object.keys(tradingSummary).length > 0 ? [tradingSummary] : [],
        reportFixedColumns,
      );
    }
    const sourceReportPeriodId = firstText(rawComplianceData.reportPeriodId, raw.reportPeriodId);
    if (Array.isArray(raw.events)) {
      counts.events = await restoreEvents(
        client,
        dealId,
        reportPeriodId,
        raw.events as Record<string, unknown>[],
        sourceReportPeriodId,
      );
    }
    if (hasOwn(raw, "supplementaryData")) {
      counts.supplementaryData = 1;
    }

    await client.query("COMMIT");
    return NextResponse.json({ dealId, reportPeriodId, counts });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[clo/context/raw] restore failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to restore raw context" },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
