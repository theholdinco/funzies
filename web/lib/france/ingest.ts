import { Pool, PoolClient } from "pg";
import { createHash } from "crypto";
import { createWriteStream, unlinkSync, statSync, readFileSync, createReadStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { tmpdir } from "os";
import { join } from "path";
import type { DecpContract, DecpTitulaire, DecpModification } from "./types";

const { chain } = require("stream-chain");

const DATA_URLS: Record<string, string> = {
  "2019": "https://static.data.gouv.fr/resources/donnees-essentielles-de-la-commande-publique-fichiers-consolides/20260315-031537/decp-2019.json",
  "2022": "https://static.data.gouv.fr/resources/donnees-essentielles-de-la-commande-publique-fichiers-consolides/20241114-000009/decp-2022.json",
  "2024": "https://static.data.gouv.fr/resources/donnees-essentielles-de-la-commande-publique-fichiers-consolides/20260306-170918/decp-2024.json",
  "2025": "https://static.data.gouv.fr/resources/donnees-essentielles-de-la-commande-publique-fichiers-consolides/20260220-091642/decp-2025.json",
  "2026": "https://static.data.gouv.fr/resources/donnees-essentielles-de-la-commande-publique-fichiers-consolides/20260306-152434/decp-2026.json",
};

const BATCH_SIZE = 500;

export interface IngestStats {
  rowsProcessed: number;
  contractsInserted: number;
  modificationsInserted: number;
  vendorsUpserted: number;
  buyersUpserted: number;
}

interface UpdateCheck {
  shouldDownload: boolean;
  lastModified: string | null;
  contentLength: number | null;
}

function sourceHash(contractUid: string, mod: DecpModification): string {
  const input = [
    contractUid,
    mod.objetModification,
    mod.montant,
    mod.dureeMois,
    mod.datePublicationDonneesModification,
  ].join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function extractBuyerId(c: DecpContract): string | null {
  const id = c.acheteur?.id || c["acheteur.id"] || null;
  return id ? String(id) : null;
}

function extractBuyerName(c: DecpContract): string | null {
  return str(c.acheteur?.nom);
}

function extractTitulaires(c: DecpContract): DecpTitulaire[] {
  if (!Array.isArray(c.titulaires)) return [];
  return c.titulaires.map((t) => {
    if (t && typeof t === "object" && "titulaire" in t && t.titulaire) return t.titulaire as DecpTitulaire;
    return t as DecpTitulaire;
  });
}

function extractModifications(c: DecpContract): DecpModification[] {
  if (!Array.isArray(c.modifications)) return [];
  return c.modifications.map((m) => {
    if (m && typeof m === "object" && "modification" in m && m.modification) return m.modification as DecpModification;
    return m as DecpModification;
  });
}

function str(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeInt(v: unknown, max: number): number | null {
  const n = num(v);
  if (n == null || n > max || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

// Validate date-like strings — reject garbage that would crash PostgreSQL's ::date cast
function safeDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  // Must look like YYYY-MM-DD (possibly with time after)
  if (!/^\d{4}-\d{2}/.test(s)) return null;
  const year = parseInt(s.slice(0, 4), 10);
  if (year < 1990 || year > 2099) return null;
  return s;
}

function contractUid(c: DecpContract): string {
  if (c.uid) return String(c.uid);
  const buyerId = extractBuyerId(c);
  return buyerId ? `${buyerId}${c.id}` : String(c.id);
}

// Bulk upsert contracts using UNNEST
async function bulkUpsertContracts(
  client: PoolClient,
  contracts: DecpContract[]
): Promise<number> {
  const uids: string[] = [];
  const marketIds: string[] = [];
  const buyerSirets: (string | null)[] = [];
  const buyerNames: (string | null)[] = [];
  const natures: (string | null)[] = [];
  const objects: (string | null)[] = [];
  const cpvCodes: (string | null)[] = [];
  const cpvDivisions: (string | null)[] = [];
  const procedures: (string | null)[] = [];
  const amounts: (number | null)[] = [];
  const durations: (number | null)[] = [];
  const notifDates: (string | null)[] = [];
  const pubDates: (string | null)[] = [];
  const locCodes: (string | null)[] = [];
  const locNames: (string | null)[] = [];
  const bids: (number | null)[] = [];
  const formPrices: (string | null)[] = [];

  for (const c of contracts) {
    if (!c.id) continue;
    uids.push(contractUid(c));
    marketIds.push(String(c.id));
    buyerSirets.push(extractBuyerId(c));
    buyerNames.push(extractBuyerName(c));
    natures.push(str(c.nature));
    objects.push(str(c.objet));
    const cpv = str(c.codeCPV);
    cpvCodes.push(cpv);
    cpvDivisions.push(cpv ? cpv.slice(0, 2) : null);
    procedures.push(str(c.procedure));
    amounts.push(num(c.montant));
    durations.push(safeInt(c.dureeMois, 1200));
    notifDates.push(safeDate(c.dateNotification));
    pubDates.push(safeDate(c.datePublicationDonnees));
    locCodes.push(str(c.lieuExecution?.code || c.lieuExecution_code));
    locNames.push(str(c.lieuExecution?.nom || c.lieuExecution_nom));
    bids.push(safeInt(c.offresRecues, 10000));
    formPrices.push(str(c.formePrix));
  }

  if (uids.length === 0) return 0;

  // Deduplicate by uid within the batch (last occurrence wins)
  const seen = new Set<string>();
  const dedup: number[] = [];
  for (let i = uids.length - 1; i >= 0; i--) {
    if (!seen.has(uids[i])) {
      seen.add(uids[i]);
      dedup.unshift(i);
    }
  }
  if (dedup.length < uids.length) {
    const pick = <T>(arr: T[]) => dedup.map((i) => arr[i]);
    const dedupUids = pick(uids);
    const dedupMarketIds = pick(marketIds);
    const dedupBuyerSirets = pick(buyerSirets);
    const dedupBuyerNames = pick(buyerNames);
    const dedupNatures = pick(natures);
    const dedupObjects = pick(objects);
    const dedupCpvCodes = pick(cpvCodes);
    const dedupCpvDivisions = pick(cpvDivisions);
    const dedupProcedures = pick(procedures);
    const dedupAmounts = pick(amounts);
    const dedupDurations = pick(durations);
    const dedupNotifDates = pick(notifDates);
    const dedupPubDates = pick(pubDates);
    const dedupLocCodes = pick(locCodes);
    const dedupLocNames = pick(locNames);
    const dedupBids = pick(bids);
    const dedupFormPrices = pick(formPrices);
    uids.length = 0; uids.push(...dedupUids);
    marketIds.length = 0; marketIds.push(...dedupMarketIds);
    buyerSirets.length = 0; buyerSirets.push(...dedupBuyerSirets);
    buyerNames.length = 0; buyerNames.push(...dedupBuyerNames);
    natures.length = 0; natures.push(...dedupNatures);
    objects.length = 0; objects.push(...dedupObjects);
    cpvCodes.length = 0; cpvCodes.push(...dedupCpvCodes);
    cpvDivisions.length = 0; cpvDivisions.push(...dedupCpvDivisions);
    procedures.length = 0; procedures.push(...dedupProcedures);
    amounts.length = 0; amounts.push(...dedupAmounts);
    durations.length = 0; durations.push(...dedupDurations);
    notifDates.length = 0; notifDates.push(...dedupNotifDates);
    pubDates.length = 0; pubDates.push(...dedupPubDates);
    locCodes.length = 0; locCodes.push(...dedupLocCodes);
    locNames.length = 0; locNames.push(...dedupLocNames);
    bids.length = 0; bids.push(...dedupBids);
    formPrices.length = 0; formPrices.push(...dedupFormPrices);
  }

  await client.query(
    `INSERT INTO france_contracts (
      uid, market_id, buyer_siret, buyer_name, nature, object,
      cpv_code, cpv_division, procedure, amount_ht, duration_months,
      notification_date, publication_date, location_code, location_name,
      bids_received, form_of_price
    )
    SELECT * FROM UNNEST(
      $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
      $7::text[], $8::text[], $9::text[], $10::numeric[], $11::integer[],
      $12::date[], $13::date[], $14::text[], $15::text[],
      $16::integer[], $17::text[]
    )
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
      synced_at = now()`,
    [
      uids, marketIds, buyerSirets, buyerNames, natures, objects,
      cpvCodes, cpvDivisions, procedures, amounts, durations,
      notifDates, pubDates, locCodes, locNames, bids, formPrices,
    ]
  );

  return uids.length;
}

// Bulk upsert contract-vendor links
async function bulkUpsertContractVendors(
  client: PoolClient,
  links: Array<{ uid: string; vendorId: string; vendorName: string | null }>
): Promise<number> {
  if (links.length === 0) return 0;

  // Deduplicate by (uid, vendorId)
  const seen = new Set<string>();
  links = links.filter((l) => {
    const key = `${l.uid}|${l.vendorId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await client.query(
    `INSERT INTO france_contract_vendors (contract_uid, vendor_id, vendor_name)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
     ON CONFLICT (contract_uid, vendor_id) DO UPDATE SET vendor_name = EXCLUDED.vendor_name`,
    [
      links.map((l) => l.uid),
      links.map((l) => l.vendorId),
      links.map((l) => l.vendorName),
    ]
  );
  return links.length;
}

// Bulk upsert vendors
async function bulkUpsertVendors(
  client: PoolClient,
  vendors: Map<string, { idType: string | null; name: string | null; siret: string | null; siren: string | null; pubDate: string | null }>
): Promise<number> {
  if (vendors.size === 0) return 0;

  const ids: string[] = [];
  const idTypes: (string | null)[] = [];
  const names: (string | null)[] = [];
  const sirets: (string | null)[] = [];
  const sirens: (string | null)[] = [];
  const pubDates: (string | null)[] = [];

  for (const [id, v] of vendors) {
    ids.push(id);
    idTypes.push(v.idType);
    names.push(v.name);
    sirets.push(v.siret);
    sirens.push(v.siren);
    pubDates.push(v.pubDate);
  }

  await client.query(
    `INSERT INTO france_vendors (id, id_type, name, siret, siren, first_seen, last_seen)
     SELECT id, id_type, name, siret, siren, pub_date, pub_date
     FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::date[])
       AS t(id, id_type, name, siret, siren, pub_date)
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, france_vendors.name),
       id_type = COALESCE(EXCLUDED.id_type, france_vendors.id_type),
       siret = COALESCE(EXCLUDED.siret, france_vendors.siret),
       siren = COALESCE(EXCLUDED.siren, france_vendors.siren),
       first_seen = LEAST(france_vendors.first_seen, EXCLUDED.first_seen),
       last_seen = GREATEST(france_vendors.last_seen, EXCLUDED.last_seen),
       synced_at = now()`,
    [ids, idTypes, names, sirets, sirens, pubDates]
  );

  return vendors.size;
}

// Bulk upsert buyers
async function bulkUpsertBuyers(
  client: PoolClient,
  buyers: Map<string, { name: string | null; pubDate: string | null }>
): Promise<number> {
  if (buyers.size === 0) return 0;

  const sirets: string[] = [];
  const names: (string | null)[] = [];
  const pubDates: (string | null)[] = [];

  for (const [siret, b] of buyers) {
    sirets.push(siret);
    names.push(b.name);
    pubDates.push(b.pubDate);
  }

  await client.query(
    `INSERT INTO france_buyers (siret, name, first_seen, last_seen)
     SELECT siret, name, pub_date, pub_date
     FROM UNNEST($1::text[], $2::text[], $3::date[])
       AS t(siret, name, pub_date)
     ON CONFLICT (siret) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, france_buyers.name),
       first_seen = LEAST(france_buyers.first_seen, EXCLUDED.first_seen),
       last_seen = GREATEST(france_buyers.last_seen, EXCLUDED.last_seen),
       synced_at = now()`,
    [sirets, names, pubDates]
  );

  return buyers.size;
}

// Bulk upsert modifications
async function bulkUpsertModifications(
  client: PoolClient,
  mods: Array<{
    contractUid: string;
    object: string | null;
    amount: number | null;
    duration: number | null;
    vendorId: string | null;
    vendorName: string | null;
    pubDate: string | null;
    hash: string;
  }>
): Promise<number> {
  if (mods.length === 0) return 0;

  const result = await client.query(
    `INSERT INTO france_modifications (
      contract_uid, modification_object, new_amount_ht, new_duration_months,
      new_vendor_id, new_vendor_name, publication_date, source_hash
    )
    SELECT * FROM UNNEST(
      $1::text[], $2::text[], $3::numeric[], $4::integer[],
      $5::text[], $6::text[], $7::date[], $8::text[]
    )
    ON CONFLICT (contract_uid, source_hash) DO NOTHING`,
    [
      mods.map((m) => m.contractUid),
      mods.map((m) => m.object),
      mods.map((m) => m.amount),
      mods.map((m) => m.duration),
      mods.map((m) => m.vendorId),
      mods.map((m) => m.vendorName),
      mods.map((m) => m.pubDate),
      mods.map((m) => m.hash),
    ]
  );

  return result.rowCount || 0;
}

async function processBatch(
  client: PoolClient,
  contracts: DecpContract[],
  stats: IngestStats
): Promise<void> {
  // Collect data for bulk inserts
  const vendorLinks: Array<{ uid: string; vendorId: string; vendorName: string | null }> = [];
  const vendorMap = new Map<string, { idType: string | null; name: string | null; siret: string | null; siren: string | null; pubDate: string | null }>();
  const buyerMap = new Map<string, { name: string | null; pubDate: string | null }>();
  const modRows: Array<{
    contractUid: string;
    object: string | null;
    amount: number | null;
    duration: number | null;
    vendorId: string | null;
    vendorName: string | null;
    pubDate: string | null;
    hash: string;
  }> = [];

  for (const c of contracts) {
    if (!c.id) continue;
    stats.rowsProcessed++;

    const uid = contractUid(c);
    const buyerId = extractBuyerId(c);

    // Collect vendor links and vendor data
    for (const tit of extractTitulaires(c)) {
      if (!tit.id) continue;
      const vendorId = String(tit.id);
      vendorLinks.push({ uid, vendorId, vendorName: str(tit.denominationSociale) });

      const idType = str(tit.typeIdentifiant);
      const siret = idType === "SIRET" ? vendorId : null;
      const siren = siret ? siret.slice(0, 9) : null;
      vendorMap.set(vendorId, { idType, name: str(tit.denominationSociale), siret, siren, pubDate: safeDate(c.datePublicationDonnees) });
    }

    // Collect buyer data
    if (buyerId) {
      buyerMap.set(buyerId, { name: extractBuyerName(c), pubDate: safeDate(c.datePublicationDonnees) });
    }

    // Collect modifications
    for (const mod of extractModifications(c)) {
      const modTitulaires = Array.isArray(mod.titulaires)
        ? mod.titulaires.map((t) => {
            if ("titulaire" in t && t.titulaire) return t.titulaire as DecpTitulaire;
            return t as DecpTitulaire;
          })
        : [];
      const firstTit = modTitulaires[0];

      modRows.push({
        contractUid: uid,
        object: str(mod.objetModification),
        amount: num(mod.montant),
        duration: safeInt(mod.dureeMois, 1200),
        vendorId: firstTit?.id ? String(firstTit.id) : null,
        vendorName: str(firstTit?.denominationSociale),
        pubDate: safeDate(mod.datePublicationDonneesModification),
        hash: sourceHash(uid, mod),
      });
    }
  }

  // Execute bulk inserts within a transaction
  stats.contractsInserted += await bulkUpsertContracts(client, contracts);
  stats.vendorsUpserted += await bulkUpsertVendors(client, vendorMap);
  stats.buyersUpserted += await bulkUpsertBuyers(client, buyerMap);
  await bulkUpsertContractVendors(client, vendorLinks);
  stats.modificationsInserted += await bulkUpsertModifications(client, modRows);
}

export async function checkForUpdates(pool: Pool): Promise<UpdateCheck> {
  const url = DATA_URLS["2026"];
  const res = await fetch(url, { method: "HEAD" });
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

export async function downloadJson(url: string, year: string): Promise<string> {
  const dest = join(tmpdir(), `decp-${year}-${Date.now()}.json`);
  console.log(`Downloading ${year} data to ${dest}...`);

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const nodeStream = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
  await pipeline(nodeStream, createWriteStream(dest));

  const size = statSync(dest).size;
  console.log(`Downloaded ${(size / 1024 / 1024).toFixed(1)} MB`);
  return dest;
}

const MAX_READFILE_SIZE = 400 * 1024 * 1024; // 400MB — safe for readFileSync

async function parseContractsSmall(filePath: string): Promise<DecpContract[]> {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.marches)) return parsed.marches;
  if (parsed.marches?.marche) {
    return [
      ...(parsed.marches.marche || []),
      ...(parsed.marches["contrat-concession"] || []),
    ];
  }
  return [];
}

async function streamParseContracts(
  filePath: string,
  onBatch: (batch: DecpContract[]) => Promise<void>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const { parser } = require("stream-json");
    const { pick } = require("stream-json/filters/Pick");
    const { streamValues } = require("stream-json/streamers/StreamValues");

    let total = 0;
    let batch: DecpContract[] = [];

    // Match contract arrays in both JSON formats:
    // { marches: [...] } and { marches: { marche: [...], "contrat-concession": [...] } }
    const fileStream = createReadStream(filePath);
    const jsonPipeline = chain([
      fileStream,
      parser(),
      pick({ filter: /^marches\.marche\.\d+$|^marches\.\d+$|^marches\.contrat-concession\.\d+$/ }),
      streamValues(),
    ]);

    jsonPipeline.on("data", ({ value }: { value: DecpContract }) => {
      batch.push(value);
      total++;
      if (batch.length >= BATCH_SIZE) {
        const current = batch;
        batch = [];
        jsonPipeline.pause();
        onBatch(current)
          .then(() => jsonPipeline.resume())
          .catch(reject);
      }
    });

    jsonPipeline.on("end", async () => {
      if (batch.length > 0) {
        await onBatch(batch);
      }
      resolve(total);
    });

    jsonPipeline.on("error", reject);
  });
}

export async function ingestJsonFile(
  pool: Pool,
  filePath: string,
  stats: IngestStats
): Promise<void> {
  const fileSize = statSync(filePath).size;
  const client = await pool.connect();

  try {
    if (fileSize < MAX_READFILE_SIZE) {
      // Small file: read all at once
      const contracts = await parseContractsSmall(filePath);
      console.log(`  Found ${contracts.length} contracts`);

      for (let i = 0; i < contracts.length; i += BATCH_SIZE) {
        const batch = contracts.slice(i, i + BATCH_SIZE);
        await client.query("BEGIN");
        await processBatch(client, batch, stats);
        await client.query("COMMIT");

        const processed = Math.min(i + BATCH_SIZE, contracts.length);
        console.log(`  Processed ${processed}/${contracts.length} contracts...`);
      }
    } else {
      // Large file: stream parse
      console.log(`  Large file (${(fileSize / 1024 / 1024).toFixed(0)} MB), streaming...`);
      let processed = 0;

      await streamParseContracts(filePath, async (batch) => {
        await client.query("BEGIN");
        await processBatch(client, batch, stats);
        await client.query("COMMIT");
        processed += batch.length;
        console.log(`  Processed ${processed} contracts...`);
      });
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function ingestAllYears(
  pool: Pool,
  years?: string[]
): Promise<IngestStats> {
  const stats: IngestStats = {
    rowsProcessed: 0,
    contractsInserted: 0,
    modificationsInserted: 0,
    vendorsUpserted: 0,
    buyersUpserted: 0,
  };

  const yearsToProcess = years || Object.keys(DATA_URLS).sort();

  for (const year of yearsToProcess) {
    const url = DATA_URLS[year];
    if (!url) {
      console.warn(`No URL configured for year ${year}, skipping`);
      continue;
    }

    console.log(`\n=== Processing year ${year} ===`);
    let filePath: string | null = null;
    try {
      filePath = await downloadJson(url, year);
      await ingestJsonFile(pool, filePath, stats);
    } finally {
      if (filePath) cleanupTempFile(filePath);
    }
  }

  // Post-ingest: update denormalized counts (exclude sentinel amounts > 10B€)
  console.log("\nUpdating denormalized counts...");
  await pool.query(`
    UPDATE france_vendors v SET
      contract_count = sub.cnt,
      total_amount_ht = sub.total
    FROM (
      SELECT cv.vendor_id,
             COUNT(DISTINCT cv.contract_uid) AS cnt,
             COALESCE(SUM(CASE WHEN c.amount_ht < 10000000000 THEN c.amount_ht END), 0) AS total
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
             COALESCE(SUM(CASE WHEN amount_ht < 10000000000 THEN amount_ht END), 0) AS total
      FROM france_contracts
      GROUP BY buyer_siret
    ) sub
    WHERE b.siret = sub.buyer_siret
  `);

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
     VALUES (1, $1, $2, $3, $4, 0, now())
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
