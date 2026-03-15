import { Pool } from "pg";
import {
  checkForUpdates,
  downloadParquet,
  ingestParquet,
  updateSyncMeta,
  cleanupTempFile,
} from "../lib/france/ingest";

async function loadEnv() {
  if (!process.env.DATABASE_URL) {
    const { config } = await import("dotenv");
    config({ path: ".env.local" });
  }
}

async function main() {
  await loadEnv();

  const force = process.argv.includes("--force");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let parquetPath: string | null = null;

  try {
    console.log("Checking for updates...");
    const { shouldDownload, lastModified, contentLength } =
      await checkForUpdates(pool);

    if (!shouldDownload && !force) {
      console.log("No updates available. Use --force to re-ingest.");
      return;
    }

    if (force && !shouldDownload) {
      console.log("No updates detected but --force specified, proceeding...");
    }

    parquetPath = await downloadParquet();
    const stats = await ingestParquet(pool, parquetPath);
    await updateSyncMeta(pool, lastModified, contentLength, stats);

    console.log("\n--- Ingestion Stats ---");
    console.log(`  Rows processed:          ${stats.rowsProcessed}`);
    console.log(`  Contracts inserted:      ${stats.contractsInserted}`);
    console.log(`  Contracts updated:       ${stats.contractsUpdated}`);
    console.log(`  Modifications inserted:  ${stats.modificationsInserted}`);
    console.log(`  Vendors upserted:        ${stats.vendorsUpserted}`);
    console.log(`  Buyers upserted:         ${stats.buyersUpserted}`);
    console.log(`  Orphaned modifications:  ${stats.orphanedModifications}`);
  } finally {
    if (parquetPath) cleanupTempFile(parquetPath);
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
