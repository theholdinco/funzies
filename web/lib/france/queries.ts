import { query } from "@/lib/db";
import {
  DashboardSummary,
  FranceBuyer,
  FranceContract,
  FranceModification,
  FranceVendor,
  ProcedureBreakdown,
  SpendByYear,
  TopEntity,
} from "./types";

// --- Dashboard ---

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const rows = await query<{
    total_contracts: string;
    total_spend: string;
    unique_buyers: string;
    unique_vendors: string;
    avg_bids: string;
  }>(`
    SELECT
      COUNT(*)::text                                          AS total_contracts,
      COALESCE(SUM(amount_ht), 0)::text                      AS total_spend,
      COUNT(DISTINCT buyer_siret)::text                      AS unique_buyers,
      (SELECT COUNT(*)::text FROM france_vendors)            AS unique_vendors,
      COALESCE(AVG(NULLIF(bids_received, 0)), 0)::text       AS avg_bids
    FROM france_contracts
  `);
  const r = rows[0];
  return {
    total_contracts: Number(r.total_contracts),
    total_spend: Number(r.total_spend),
    unique_buyers: Number(r.unique_buyers),
    unique_vendors: Number(r.unique_vendors),
    avg_bids: Number(r.avg_bids),
  };
}

export async function getSpendByYear(): Promise<SpendByYear[]> {
  const rows = await query<{
    year: string;
    total_amount: string;
    contract_count: string;
  }>(`
    SELECT
      EXTRACT(YEAR FROM notification_date)::text  AS year,
      COALESCE(SUM(amount_ht), 0)::text           AS total_amount,
      COUNT(*)::text                              AS contract_count
    FROM france_contracts
    WHERE notification_date IS NOT NULL
    GROUP BY EXTRACT(YEAR FROM notification_date)
    ORDER BY year
  `);
  return rows.map((r) => ({
    year: Number(r.year),
    total_amount: Number(r.total_amount),
    contract_count: Number(r.contract_count),
  }));
}

export async function getTopBuyers(limit = 10): Promise<TopEntity[]> {
  const rows = await query<{
    siret: string;
    name: string;
    total_amount_ht: string;
    contract_count: string;
  }>(
    `
    SELECT siret, name, total_amount_ht::text, contract_count::text
    FROM france_buyers
    ORDER BY total_amount_ht DESC
    LIMIT $1
  `,
    [limit]
  );
  return rows.map((r) => ({
    id: r.siret,
    name: r.name,
    total_amount: Number(r.total_amount_ht),
    contract_count: Number(r.contract_count),
  }));
}

export async function getTopVendors(limit = 10): Promise<TopEntity[]> {
  const rows = await query<{
    id: string;
    name: string;
    total_amount_ht: string;
    contract_count: string;
  }>(
    `
    SELECT id, name, total_amount_ht::text, contract_count::text
    FROM france_vendors
    ORDER BY total_amount_ht DESC
    LIMIT $1
  `,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    total_amount: Number(r.total_amount_ht),
    contract_count: Number(r.contract_count),
  }));
}

export async function getProcedureBreakdown(): Promise<ProcedureBreakdown[]> {
  const rows = await query<{
    procedure: string;
    total_amount: string;
    contract_count: string;
    pct: string;
  }>(`
    WITH totals AS (
      SELECT SUM(amount_ht) AS grand_total FROM france_contracts
    )
    SELECT
      COALESCE(procedure, 'Non renseigné')                         AS procedure,
      COALESCE(SUM(amount_ht), 0)::text                            AS total_amount,
      COUNT(*)::text                                               AS contract_count,
      ROUND(
        COALESCE(SUM(amount_ht), 0) / NULLIF((SELECT grand_total FROM totals), 0) * 100,
        2
      )::text                                                      AS pct
    FROM france_contracts
    GROUP BY procedure
    ORDER BY SUM(amount_ht) DESC NULLS LAST
  `);
  return rows.map((r) => ({
    procedure: r.procedure,
    total_amount: Number(r.total_amount),
    contract_count: Number(r.contract_count),
    pct: Number(r.pct),
  }));
}

// --- Contract explorer ---

export interface ContractFilters {
  yearFrom?: number;
  yearTo?: number;
  buyerSiret?: string;
  vendorId?: string;
  cpvDivision?: string;
  procedure?: string;
  amountMin?: number;
  amountMax?: number;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function getContracts(
  filters: ContractFilters = {}
): Promise<{ rows: FranceContract[]; total: number }> {
  const {
    yearFrom,
    yearTo,
    buyerSiret,
    vendorId,
    cpvDivision,
    procedure,
    amountMin,
    amountMax,
    search,
    page = 1,
    pageSize = 50,
  } = filters;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (yearFrom !== undefined) {
    params.push(yearFrom);
    conditions.push(`EXTRACT(YEAR FROM notification_date) >= $${params.length}`);
  }
  if (yearTo !== undefined) {
    params.push(yearTo);
    conditions.push(`EXTRACT(YEAR FROM notification_date) <= $${params.length}`);
  }
  if (buyerSiret) {
    params.push(buyerSiret);
    conditions.push(`buyer_siret = $${params.length}`);
  }
  if (vendorId) {
    params.push(vendorId);
    conditions.push(
      `uid IN (SELECT contract_uid FROM france_contract_vendors WHERE vendor_id = $${params.length})`
    );
  }
  if (cpvDivision) {
    params.push(cpvDivision);
    conditions.push(`cpv_division = $${params.length}`);
  }
  if (procedure) {
    params.push(procedure);
    conditions.push(`procedure = $${params.length}`);
  }
  if (amountMin !== undefined) {
    params.push(amountMin);
    conditions.push(`amount_ht >= $${params.length}`);
  }
  if (amountMax !== undefined) {
    params.push(amountMax);
    conditions.push(`amount_ht <= $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    conditions.push(
      `(object ILIKE $${idx} OR buyer_name ILIKE $${idx} OR uid ILIKE $${idx})`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRows = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM france_contracts ${where}`,
    params
  );
  const total = Number(countRows[0].total);

  const offset = (page - 1) * pageSize;
  params.push(pageSize);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const rows = await query<FranceContract>(
    `
    SELECT *
    FROM france_contracts
    ${where}
    ORDER BY amount_ht DESC NULLS LAST
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `,
    params
  );

  return { rows, total };
}

// --- Contract detail ---

export async function getContractByUid(uid: string): Promise<FranceContract | null> {
  const rows = await query<FranceContract>(
    `SELECT * FROM france_contracts WHERE uid = $1`,
    [uid]
  );
  return rows[0] ?? null;
}

export async function getContractVendors(
  uid: string
): Promise<{ vendor_id: string; vendor_name: string }[]> {
  return query<{ vendor_id: string; vendor_name: string }>(
    `SELECT vendor_id, vendor_name FROM france_contract_vendors WHERE contract_uid = $1`,
    [uid]
  );
}

export async function getContractModifications(uid: string): Promise<FranceModification[]> {
  return query<FranceModification>(
    `SELECT * FROM france_modifications WHERE contract_uid = $1 ORDER BY publication_date`,
    [uid]
  );
}

// --- Vendor detail ---

export async function getVendorById(id: string): Promise<FranceVendor | null> {
  const rows = await query<FranceVendor>(`SELECT * FROM france_vendors WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getVendorContracts(
  vendorId: string,
  limit = 50
): Promise<FranceContract[]> {
  return query<FranceContract>(
    `
    SELECT c.*
    FROM france_contracts c
    JOIN france_contract_vendors cv ON cv.contract_uid = c.uid
    WHERE cv.vendor_id = $1
    ORDER BY c.amount_ht DESC NULLS LAST
    LIMIT $2
    `,
    [vendorId, limit]
  );
}

export async function getVendorTopBuyers(
  vendorId: string,
  limit = 10
): Promise<TopEntity[]> {
  const rows = await query<{
    siret: string;
    name: string;
    total_amount: string;
    contract_count: string;
  }>(
    `
    SELECT
      c.buyer_siret                     AS siret,
      c.buyer_name                      AS name,
      COALESCE(SUM(c.amount_ht), 0)::text AS total_amount,
      COUNT(*)::text                    AS contract_count
    FROM france_contracts c
    JOIN france_contract_vendors cv ON cv.contract_uid = c.uid
    WHERE cv.vendor_id = $1
    GROUP BY c.buyer_siret, c.buyer_name
    ORDER BY SUM(c.amount_ht) DESC NULLS LAST
    LIMIT $2
    `,
    [vendorId, limit]
  );
  return rows.map((r) => ({
    id: r.siret,
    name: r.name,
    total_amount: Number(r.total_amount),
    contract_count: Number(r.contract_count),
  }));
}

// --- Buyer detail ---

export async function getBuyerBySiret(siret: string): Promise<FranceBuyer | null> {
  const rows = await query<FranceBuyer>(
    `SELECT * FROM france_buyers WHERE siret = $1`,
    [siret]
  );
  return rows[0] ?? null;
}

export async function getBuyerContracts(
  siret: string,
  limit = 50
): Promise<FranceContract[]> {
  return query<FranceContract>(
    `
    SELECT * FROM france_contracts
    WHERE buyer_siret = $1
    ORDER BY amount_ht DESC NULLS LAST
    LIMIT $2
    `,
    [siret, limit]
  );
}

export async function getBuyerTopVendors(
  siret: string,
  limit = 10
): Promise<TopEntity[]> {
  const rows = await query<{
    id: string;
    name: string;
    total_amount: string;
    contract_count: string;
  }>(
    `
    SELECT
      cv.vendor_id                        AS id,
      cv.vendor_name                      AS name,
      COALESCE(SUM(c.amount_ht), 0)::text AS total_amount,
      COUNT(*)::text                      AS contract_count
    FROM france_contracts c
    JOIN france_contract_vendors cv ON cv.contract_uid = c.uid
    WHERE c.buyer_siret = $1
    GROUP BY cv.vendor_id, cv.vendor_name
    ORDER BY SUM(c.amount_ht) DESC NULLS LAST
    LIMIT $2
    `,
    [siret, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    total_amount: Number(r.total_amount),
    contract_count: Number(r.contract_count),
  }));
}

export async function getBuyerProcedureBreakdown(
  siret: string
): Promise<ProcedureBreakdown[]> {
  const rows = await query<{
    procedure: string;
    total_amount: string;
    contract_count: string;
    pct: string;
  }>(
    `
    WITH totals AS (
      SELECT SUM(amount_ht) AS grand_total
      FROM france_contracts
      WHERE buyer_siret = $1
    )
    SELECT
      COALESCE(procedure, 'Non renseigné')                         AS procedure,
      COALESCE(SUM(amount_ht), 0)::text                            AS total_amount,
      COUNT(*)::text                                               AS contract_count,
      ROUND(
        COALESCE(SUM(amount_ht), 0) / NULLIF((SELECT grand_total FROM totals), 0) * 100,
        2
      )::text                                                      AS pct
    FROM france_contracts
    WHERE buyer_siret = $1
    GROUP BY procedure
    ORDER BY SUM(amount_ht) DESC NULLS LAST
    `,
    [siret]
  );
  return rows.map((r) => ({
    procedure: r.procedure,
    total_amount: Number(r.total_amount),
    contract_count: Number(r.contract_count),
    pct: Number(r.pct),
  }));
}

// --- Analytics ---

export async function getVendorConcentration(
  cpvDivision?: string,
  limit = 20
): Promise<(TopEntity & { market_share: number })[]> {
  const conditions = cpvDivision ? `WHERE c.cpv_division = $1` : "";
  const params: unknown[] = cpvDivision ? [cpvDivision, limit] : [limit];
  const limitParam = `$${params.length}`;

  const rows = await query<{
    id: string;
    name: string;
    total_amount: string;
    contract_count: string;
    market_share: string;
  }>(
    `
    WITH vendor_spend AS (
      SELECT
        cv.vendor_id,
        cv.vendor_name,
        SUM(c.amount_ht) AS spend
      FROM france_contracts c
      JOIN france_contract_vendors cv ON cv.contract_uid = c.uid
      ${conditions}
      GROUP BY cv.vendor_id, cv.vendor_name
    ),
    total AS (
      SELECT SUM(spend) AS grand_total FROM vendor_spend
    )
    SELECT
      vs.vendor_id                                                         AS id,
      vs.vendor_name                                                       AS name,
      COALESCE(vs.spend, 0)::text                                          AS total_amount,
      (
        SELECT COUNT(*)::text
        FROM france_contract_vendors cv2
        WHERE cv2.vendor_id = vs.vendor_id
      )                                                                    AS contract_count,
      ROUND(COALESCE(vs.spend, 0) / NULLIF((SELECT grand_total FROM total), 0) * 100, 2)::text
                                                                           AS market_share
    FROM vendor_spend vs
    ORDER BY vs.spend DESC NULLS LAST
    LIMIT ${limitParam}
    `,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    total_amount: Number(r.total_amount),
    contract_count: Number(r.contract_count),
    market_share: Number(r.market_share),
  }));
}

export async function getAmendmentInflation(minPctIncrease = 50): Promise<
  {
    contract_uid: string;
    object: string;
    buyer_name: string;
    original_amount: number;
    final_amount: number;
    pct_increase: number;
    modification_count: number;
  }[]
> {
  const rows = await query<{
    contract_uid: string;
    object: string;
    buyer_name: string;
    original_amount: string;
    final_amount: string;
    pct_increase: string;
    modification_count: string;
  }>(
    `
    SELECT
      c.uid                                                        AS contract_uid,
      c.object,
      c.buyer_name,
      c.amount_ht::text                                            AS original_amount,
      MAX(m.new_amount_ht)::text                                   AS final_amount,
      ROUND(
        (MAX(m.new_amount_ht) - c.amount_ht) / NULLIF(c.amount_ht, 0) * 100,
        2
      )::text                                                      AS pct_increase,
      COUNT(m.id)::text                                            AS modification_count
    FROM france_contracts c
    JOIN france_modifications m ON m.contract_uid = c.uid
    WHERE m.new_amount_ht IS NOT NULL
    GROUP BY c.uid, c.object, c.buyer_name, c.amount_ht
    HAVING
      (MAX(m.new_amount_ht) - c.amount_ht) / NULLIF(c.amount_ht, 0) * 100 >= $1
    ORDER BY pct_increase DESC
    LIMIT 100
    `,
    [minPctIncrease]
  );

  return rows.map((r) => ({
    contract_uid: r.contract_uid,
    object: r.object,
    buyer_name: r.buyer_name,
    original_amount: Number(r.original_amount),
    final_amount: Number(r.final_amount),
    pct_increase: Number(r.pct_increase),
    modification_count: Number(r.modification_count),
  }));
}

export async function getCompetitionByYear(): Promise<
  {
    year: number;
    procedure: string;
    total_amount: number;
    contract_count: number;
    avg_bids: number;
  }[]
> {
  const rows = await query<{
    year: string;
    procedure: string;
    total_amount: string;
    contract_count: string;
    avg_bids: string;
  }>(`
    SELECT
      EXTRACT(YEAR FROM notification_date)::text  AS year,
      COALESCE(procedure, 'Non renseigné')        AS procedure,
      COALESCE(SUM(amount_ht), 0)::text           AS total_amount,
      COUNT(*)::text                              AS contract_count,
      COALESCE(AVG(NULLIF(bids_received, 0)), 0)::text AS avg_bids
    FROM france_contracts
    WHERE notification_date IS NOT NULL
    GROUP BY EXTRACT(YEAR FROM notification_date), procedure
    ORDER BY year, procedure
  `);

  return rows.map((r) => ({
    year: Number(r.year),
    procedure: r.procedure,
    total_amount: Number(r.total_amount),
    contract_count: Number(r.contract_count),
    avg_bids: Number(r.avg_bids),
  }));
}
