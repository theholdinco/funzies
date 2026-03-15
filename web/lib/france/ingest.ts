import { Pool } from "pg";
import { createHash } from "crypto";
import { createWriteStream, unlinkSync, statSync } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { tmpdir } from "os";
import { join } from "path";
import duckdb from "duckdb";
import type { DecpParquetRow } from "./types";

const PARQUET_URL =
  "https://www.data.gouv.fr/fr/datasets/r/16962018-5c31-4296-9454-5998585496d2";
const BATCH_SIZE = 5000;

export interface IngestStats {
  rowsProcessed: number;
  contractsInserted: number;
  contractsUpdated: number;
  modificationsInserted: number;
  vendorsUpserted: number;
  buyersUpserted: number;
  orphanedModifications: number;
}

interface UpdateCheck {
  shouldDownload: boolean;
  lastModified: string | null;
  contentLength: number | null;
}

function duckdbAll(
  conn: duckdb.Connection,
  sql: string
): Promise<duckdb.TableData> {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err: Error | null, rows: duckdb.TableData) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function sourceHash(row: DecpParquetRow): string {
  const input = [
    row.uid,
    row.objetModification,
    row.montant,
    row.dureeMois,
    row.titulaire_id,
    row.datePublicationDonnees,
  ].join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export async function checkForUpdates(pool: Pool): Promise<UpdateCheck> {
  const res = await fetch(PARQUET_URL, { method: "HEAD" });
  const lastModified = res.headers.get("last-modified");
  const contentLength = res.headers.get("content-length");
  const contentLengthNum = contentLength ? parseInt(contentLength, 10) : null;

  const { rows } = await pool.query(
    "SELECT last_modified, content_length FROM france_sync_meta WHERE id = 1"
  );

  if (rows.length === 0) {
    return { shouldDownload: true, lastModified, contentLength: contentLengthNum };
  }

  const meta = rows[0];
  const changed =
    meta.last_modified !== lastModified ||
    Number(meta.content_length) !== contentLengthNum;

  return { shouldDownload: changed, lastModified, contentLength: contentLengthNum };
}

export async function downloadParquet(): Promise<string> {
  const dest = join(tmpdir(), `decp-${Date.now()}.parquet`);
  console.log(`Downloading DECP parquet to ${dest}...`);

  const res = await fetch(PARQUET_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const nodeStream = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
  await pipeline(nodeStream, createWriteStream(dest));

  const size = statSync(dest).size;
  console.log(`Downloaded ${(size / 1024 / 1024).toFixed(1)} MB`);
  return dest;
}

export async function ingestParquet(
  pool: Pool,
  parquetPath: string
): Promise<IngestStats> {
  const stats: IngestStats = {
    rowsProcessed: 0,
    contractsInserted: 0,
    contractsUpdated: 0,
    modificationsInserted: 0,
    vendorsUpserted: 0,
    buyersUpserted: 0,
    orphanedModifications: 0,
  };

  const db = new duckdb.Database(":memory:");
  const conn = db.connect();

  // Get total row count
  const countResult = await duckdbAll(
    conn,
    `SELECT COUNT(*) as cnt FROM read_parquet('${parquetPath}')`
  );
  const totalRows = Number((countResult[0] as Record<string, unknown>).cnt);
  console.log(`Total rows in parquet: ${totalRows}`);

  // Buffer modifications for pass 2
  const modifications: DecpParquetRow[] = [];

  // Pass 1: contracts, vendors, buyers
  console.log("Pass 1: processing contracts, vendors, buyers...");
  for (let offset = 0; offset < totalRows; offset += BATCH_SIZE) {
    const rows = (await duckdbAll(
      conn,
      `SELECT * FROM read_parquet('${parquetPath}') LIMIT ${BATCH_SIZE} OFFSET ${offset}`
    )) as unknown as DecpParquetRow[];

    for (const row of rows) {
      stats.rowsProcessed++;

      if (!row.uid || row.donneesActuelles === false) continue;

      // Buffer modifications for pass 2
      if (row.objetModification) {
        modifications.push(row);
        continue;
      }

      // Upsert contract
      const cpvDivision = row.codeCPV ? row.codeCPV.slice(0, 2) : null;
      const contractResult = await pool.query(
        `INSERT INTO france_contracts (
          uid, market_id, buyer_siret, buyer_name, nature, object,
          cpv_code, cpv_division, procedure, amount_ht, duration_months,
          notification_date, publication_date, location_code, location_name,
          bids_received, form_of_price, framework_id, anomalies
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (uid) DO UPDATE SET
          market_id = EXCLUDED.market_id,
          buyer_siret = EXCLUDED.buyer_siret,
          buyer_name = EXCLUDED.buyer_name,
          nature = EXCLUDED.nature,
          object = EXCLUDED.object,
          cpv_code = EXCLUDED.cpv_code,
          cpv_division = EXCLUDED.cpv_division,
          procedure = EXCLUDED.procedure,
          amount_ht = EXCLUDED.amount_ht,
          duration_months = EXCLUDED.duration_months,
          notification_date = EXCLUDED.notification_date,
          publication_date = EXCLUDED.publication_date,
          location_code = EXCLUDED.location_code,
          location_name = EXCLUDED.location_name,
          bids_received = EXCLUDED.bids_received,
          form_of_price = EXCLUDED.form_of_price,
          framework_id = EXCLUDED.framework_id,
          anomalies = EXCLUDED.anomalies,
          synced_at = now()`,
        [
          row.uid,
          row.id,
          row.acheteur_id,
          row.acheteur_nom,
          row.nature,
          row.objet,
          row.codeCPV,
          cpvDivision,
          row.procedure,
          row.montant,
          row.dureeMois,
          row.dateNotification || null,
          row.datePublicationDonnees || null,
          row.lieuExecution_code,
          row.lieuExecution_nom,
          row.offresRecues,
          row.formePrix,
          row.idAccordCadre,
          row.anomalies,
        ]
      );

      if (contractResult.command === "INSERT") {
        // xmax = 0 means a fresh insert, otherwise it was an update
        stats.contractsInserted++;
      }

      // Upsert vendor
      if (row.titulaire_id) {
        const idType = row.titulaire_typeIdentifiant || null;
        const siret =
          idType === "SIRET" ? row.titulaire_id : null;
        const siren = siret ? siret.slice(0, 9) : null;
        const pubDate = row.datePublicationDonnees || null;

        await pool.query(
          `INSERT INTO france_contract_vendors (contract_uid, vendor_id, vendor_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (contract_uid, vendor_id) DO UPDATE SET vendor_name = EXCLUDED.vendor_name`,
          [row.uid, row.titulaire_id, row.titulaire_denominationSociale]
        );

        await pool.query(
          `INSERT INTO france_vendors (id, id_type, name, siret, siren, first_seen, last_seen)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             id_type = COALESCE(EXCLUDED.id_type, france_vendors.id_type),
             siret = COALESCE(EXCLUDED.siret, france_vendors.siret),
             siren = COALESCE(EXCLUDED.siren, france_vendors.siren),
             first_seen = LEAST(france_vendors.first_seen, EXCLUDED.first_seen),
             last_seen = GREATEST(france_vendors.last_seen, EXCLUDED.last_seen),
             synced_at = now()`,
          [row.titulaire_id, idType, row.titulaire_denominationSociale, siret, siren, pubDate]
        );
        stats.vendorsUpserted++;
      }

      // Upsert buyer
      if (row.acheteur_id) {
        const pubDate = row.datePublicationDonnees || null;
        await pool.query(
          `INSERT INTO france_buyers (siret, name, first_seen, last_seen)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (siret) DO UPDATE SET
             name = EXCLUDED.name,
             first_seen = LEAST(france_buyers.first_seen, EXCLUDED.first_seen),
             last_seen = GREATEST(france_buyers.last_seen, EXCLUDED.last_seen),
             synced_at = now()`,
          [row.acheteur_id, row.acheteur_nom, pubDate]
        );
        stats.buyersUpserted++;
      }
    }

    if (offset % (BATCH_SIZE * 10) === 0) {
      console.log(
        `  Processed ${Math.min(offset + BATCH_SIZE, totalRows)}/${totalRows} rows...`
      );
    }
  }

  // Pass 2: modifications
  console.log(`Pass 2: processing ${modifications.length} modifications...`);
  for (const row of modifications) {
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM france_contracts WHERE uid = $1",
      [row.uid]
    );

    if (existing.length === 0) {
      stats.orphanedModifications++;
      continue;
    }

    const hash = sourceHash(row);
    const result = await pool.query(
      `INSERT INTO france_modifications (
        contract_uid, modification_object, new_amount_ht, new_duration_months,
        new_vendor_id, new_vendor_name, publication_date, source_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (contract_uid, source_hash) DO NOTHING`,
      [
        row.uid,
        row.objetModification,
        row.montant || null,
        row.dureeMois || null,
        row.titulaire_id || null,
        row.titulaire_denominationSociale || null,
        row.datePublicationDonnees || null,
        hash,
      ]
    );

    if (result.rowCount && result.rowCount > 0) {
      stats.modificationsInserted++;
    }
  }

  // Post-ingest: update denormalized counts
  console.log("Updating denormalized counts...");
  await pool.query(`
    UPDATE france_vendors v SET
      contract_count = sub.cnt,
      total_amount_ht = sub.total
    FROM (
      SELECT cv.vendor_id,
             COUNT(DISTINCT cv.contract_uid) AS cnt,
             COALESCE(SUM(c.amount_ht), 0) AS total
      FROM france_contract_vendors cv
      JOIN france_contracts c ON c.uid = cv.contract_uid
      GROUP BY cv.vendor_id
    ) sub
    WHERE v.id = sub.vendor_id
  `);

  await pool.query(`
    UPDATE france_buyers b SET
      contract_count = sub.cnt,
      total_amount_ht = sub.total
    FROM (
      SELECT buyer_siret,
             COUNT(*) AS cnt,
             COALESCE(SUM(amount_ht), 0) AS total
      FROM france_contracts
      GROUP BY buyer_siret
    ) sub
    WHERE b.siret = sub.buyer_siret
  `);

  db.close();
  console.log("Ingestion complete.");
  return stats;
}

export async function updateSyncMeta(
  pool: Pool,
  lastModified: string | null,
  contentLength: number | null,
  stats: IngestStats
): Promise<void> {
  await pool.query(
    `INSERT INTO france_sync_meta (id, last_modified, content_length, rows_processed, rows_inserted, rows_updated, last_sync_at)
     VALUES (1, $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       last_modified = EXCLUDED.last_modified,
       content_length = EXCLUDED.content_length,
       rows_processed = EXCLUDED.rows_processed,
       rows_inserted = EXCLUDED.rows_inserted,
       rows_updated = EXCLUDED.rows_updated,
       last_sync_at = now()`,
    [
      lastModified,
      contentLength,
      stats.rowsProcessed,
      stats.contractsInserted,
      stats.contractsUpdated,
    ]
  );
}

export function cleanupTempFile(path: string): void {
  try {
    unlinkSync(path);
    console.log(`Cleaned up temp file: ${path}`);
  } catch {
    // Ignore cleanup errors
  }
}
