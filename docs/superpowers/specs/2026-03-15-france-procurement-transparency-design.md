# France Procurement Transparency — Design Spec

## Overview

A new product vertical at `/france` within the existing Next.js app that visualizes French public procurement data (DECP) with the goal of creating transparency and accountability over government spending. The first version ingests the consolidated DECP Parquet file from data.gouv.fr into PostgreSQL and provides dashboards for spend analysis, vendor/buyer profiles, and procurement pattern detection.

## Data Source

**Primary:** `decp.parquet` (~188 MB) from [data.gouv.fr tabular dataset](https://www.data.gouv.fr/datasets/donnees-essentielles-de-la-commande-publique-consolidees-format-tabulaire). Updated daily. Contains ~1M contract records from 2018-present with 35 fields per row. Already cleaned and deduplicated upstream by DECP-RAMA.

**Schema (source Parquet fields used):**

| Field | Type | Description |
|---|---|---|
| `uid` | string | National unique contract ID (21-30 chars) |
| `id` | string | Buyer-local market ID |
| `acheteur_id` | string | Buyer SIRET (14 chars) |
| `acheteur_nom` | string | Buyer name |
| `titulaire_id` | string | Vendor identifier |
| `titulaire_typeIdentifiant` | string | Vendor ID type (SIRET, TVA, etc.) |
| `titulaire_denominationSociale` | string | Vendor legal name |
| `nature` | string | Marche, Accord-cadre, etc. |
| `objet` | string | Contract description (max 256 chars) |
| `codeCPV` | string | CPV classification code |
| `procedure` | string | Procurement procedure type |
| `montant` | number | Amount EUR ex-tax |
| `dureeMois` | integer | Duration in months |
| `dateNotification` | date | Notification date |
| `datePublicationDonnees` | date | Publication date |
| `lieuExecution_code` | string | Execution location code |
| `lieuExecution_nom` | string | Execution location name |
| `offresRecues` | integer | Number of bids received |
| `formePrix` | string | Ferme, Revisable, etc. |
| `idAccordCadre` | string | Framework agreement ID |
| `donneesActuelles` | boolean | Whether data is current |
| `anomalies` | string | Upstream anomaly flags |
| `objetModification` | string | Modification description (present = amendment) |

**Multi-row contracts:** A single contract can span multiple Parquet rows when there are multiple vendors (consortium) or modifications. Rows with `objetModification` present are amendments; others are original awards.

## Database Schema

Migration: `004_france_tables.sql`

### france_contracts

One row per unique contract (identified by `market_id` + `buyer_siret`). A contract may have multiple vendors via `france_contract_vendors`.

```sql
CREATE TABLE france_contracts (
  uid TEXT PRIMARY KEY,
  market_id TEXT,
  buyer_siret CHAR(14),
  buyer_name TEXT,
  nature TEXT,
  object TEXT,
  cpv_code TEXT,
  cpv_division CHAR(2),
  procedure TEXT,
  amount_ht NUMERIC(18,2),
  duration_months INTEGER,
  notification_date DATE,
  publication_date DATE,
  location_code TEXT,
  location_name TEXT,
  bids_received INTEGER,
  form_of_price TEXT,
  framework_id TEXT,
  anomalies TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_france_contracts_buyer ON france_contracts(buyer_siret);
CREATE INDEX idx_france_contracts_cpv ON france_contracts(cpv_code);
CREATE INDEX idx_france_contracts_cpv_div ON france_contracts(cpv_division);
CREATE INDEX idx_france_contracts_date ON france_contracts(notification_date);
CREATE INDEX idx_france_contracts_amount ON france_contracts(amount_ht);
CREATE INDEX idx_france_contracts_procedure ON france_contracts(procedure);
```

### france_contract_vendors

Join table for contracts with multiple vendors (consortiums). One row per contract-vendor pair.

```sql
CREATE TABLE france_contract_vendors (
  contract_uid TEXT NOT NULL REFERENCES france_contracts(uid),
  vendor_id TEXT NOT NULL,
  vendor_name TEXT,
  PRIMARY KEY (contract_uid, vendor_id)
);

CREATE INDEX idx_france_cv_vendor ON france_contract_vendors(vendor_id);
```

### france_vendors

One row per unique vendor identifier.

```sql
CREATE TABLE france_vendors (
  id TEXT PRIMARY KEY,
  id_type TEXT,
  name TEXT,
  siret CHAR(14),
  siren CHAR(9),
  contract_count INTEGER DEFAULT 0,
  total_amount_ht NUMERIC(18,2) DEFAULT 0,
  first_seen DATE,
  last_seen DATE,
  sirene_enriched BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### france_buyers

One row per buyer SIRET.

```sql
CREATE TABLE france_buyers (
  siret CHAR(14) PRIMARY KEY,
  name TEXT,
  contract_count INTEGER DEFAULT 0,
  total_amount_ht NUMERIC(18,2) DEFAULT 0,
  first_seen DATE,
  last_seen DATE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### france_modifications

One row per contract modification. Uses a source row hash for deduplication since amount and date alone may collide.

```sql
CREATE TABLE france_modifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_uid TEXT NOT NULL,
  modification_object TEXT,
  new_amount_ht NUMERIC(18,2),
  new_duration_months INTEGER,
  new_vendor_id TEXT,
  new_vendor_name TEXT,
  publication_date DATE,
  source_hash TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(contract_uid, source_hash)
);

CREATE INDEX idx_france_modifications_contract ON france_modifications(contract_uid);
```

Note: `contract_uid` is NOT a foreign key. Modifications are inserted in a second pass after contracts, and orphaned modifications (where the parent contract has `donneesActuelles = false`) are logged and skipped rather than causing FK violations.

### france_sync_meta

Tracks ingestion state to enable incremental updates.

```sql
CREATE TABLE france_sync_meta (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_modified TEXT,
  content_length BIGINT,
  rows_processed INTEGER,
  rows_inserted INTEGER,
  rows_updated INTEGER,
  last_sync_at TIMESTAMPTZ
);
```

## Ingestion Pipeline

### Entry point

`web/scripts/france-ingest.ts` — runnable via `npm run france:ingest`.

### Flow

1. **Check for updates.** HEAD request to the Parquet file URL on data.gouv.fr. Compare `Last-Modified` and `Content-Length` against `france_sync_meta`. Skip if unchanged (unless `--force` flag).

2. **Download.** Stream the Parquet file to a temp file on disk.

3. **Parse.** Read the Parquet file in row batches (~10,000 rows) using a Parquet reader library (`parquet-wasm` or `@duckdb/duckdb-wasm`).

4. **Two-pass processing.** The ingestion processes rows in two passes to avoid FK-like issues:

   **Pass 1 — Contracts, vendors, buyers:**
   - If `donneesActuelles = false` → skip (superseded)
   - If `objetModification` is present → buffer for pass 2
   - Otherwise → upsert into `france_contracts`, insert into `france_contract_vendors`, extract vendor/buyer
   - Extract vendor → upsert into `france_vendors`
   - Extract buyer → upsert into `france_buyers`

   **Pass 2 — Modifications:**
   - For each buffered modification row, check if `contract_uid` exists in `france_contracts`
   - If yes → upsert into `france_modifications` (keyed on `contract_uid` + `source_hash`)
   - If no → log as orphaned modification, skip

5. **Upsert logic:**
   - Contracts: `INSERT ... ON CONFLICT (uid) DO UPDATE SET ...` (unconditional update — a single batch timestamp is set at the start of the run)
   - Contract-vendors: `INSERT ... ON CONFLICT (contract_uid, vendor_id) DO UPDATE SET vendor_name = EXCLUDED.vendor_name`
   - Vendors: `INSERT ... ON CONFLICT (id) DO UPDATE` — update name, id_type, `last_seen = GREATEST(france_vendors.last_seen, EXCLUDED.last_seen)`, `first_seen = LEAST(france_vendors.first_seen, EXCLUDED.first_seen)`
   - Buyers: `INSERT ... ON CONFLICT (siret) DO UPDATE` — same LEAST/GREATEST pattern for first_seen/last_seen
   - Modifications: `INSERT ... ON CONFLICT (contract_uid, source_hash) DO NOTHING`

6. **Post-ingest aggregation.** Update denormalized counts on `france_vendors` and `france_buyers`. Uses `france_contract_vendors` join table for vendor counts:
   ```sql
   UPDATE france_vendors SET
     contract_count = sub.cnt,
     total_amount_ht = sub.total
   FROM (
     SELECT cv.vendor_id, COUNT(*) cnt, COALESCE(SUM(c.amount_ht), 0) total
     FROM france_contract_vendors cv
     JOIN france_contracts c ON c.uid = cv.contract_uid
     GROUP BY cv.vendor_id
   ) sub WHERE france_vendors.id = sub.vendor_id;
   ```
   (Same pattern for buyers, grouping by `buyer_siret` directly on `france_contracts`.)

7. **Update sync metadata.** Write stats to `france_sync_meta`.

### CLI interface

```
npm run france:ingest            # incremental (skip if unchanged)
npm run france:ingest -- --force  # re-download and re-process
```

## Frontend

### Page structure

| Route | Purpose |
|---|---|
| `/france` | Main dashboard — summary cards + charts |
| `/france/contracts` | Filterable, paginated contract explorer |
| `/france/contracts/[uid]` | Contract detail + modification history |
| `/france/vendors/[id]` | Vendor profile — contracts, spend over time, top buyers |
| `/france/buyers/[siret]` | Buyer profile — contracts, top vendors, procedure breakdown |
| `/france/analytics` | Cross-cutting analysis views |

### Dashboard (`/france`)

**Summary cards (top):**
- Total contracts + total spend
- Unique vendors
- Unique buyers
- Average bids per contract

**Charts:**
- Spend by year — bar chart (total EUR HT) with contract count line overlay
- Top 10 buyers by spend — horizontal bar, clickable to buyer profile
- Top 10 vendors by spend — horizontal bar, clickable to vendor profile
- Procedure type breakdown — donut chart showing % of spend by procedure type

### Contract explorer (`/france/contracts`)

Server-side paginated table. Filters: year range, buyer, vendor, CPV category, procedure type, amount range. Columns: notification date, buyer, vendor, object, CPV, procedure, amount, bids received. Each row links to contract detail.

### Contract detail (`/france/contracts/[uid]`)

Full contract info. Modification history from `france_modifications` showing amount/duration changes over time. Links to vendor profile and buyer profile. Related contracts from same buyer or vendor.

### Vendor profile (`/france/vendors/[id]`)

All contracts won. Spend over time chart. Top buyers this vendor works with. CPV category breakdown. Amendment rate (% of contracts with modifications).

### Buyer profile (`/france/buyers/[siret]`)

All contracts issued. Top vendors. Procedure type distribution (key transparency metric). Spend by CPV category. Amendment rate.

### Analytics (`/france/analytics`)

Three initial views:
- **Vendor concentration** — market share by vendor within CPV categories, flag dominant vendors
- **Amendment inflation** — contracts where modifications increased amount by 50%+
- **Competition analysis** — procedure type trends over time, average bids by category

Future addition: **Price benchmarking / overpayment detection** — per-CPV-category median spend analysis, statistical outlier flagging, sliceable by buyer/vendor/region/procedure to identify patterns in overpayment.

## File Structure

```
web/
├── app/france/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── contracts/
│   │   ├── page.tsx
│   │   └── [uid]/page.tsx
│   ├── vendors/
│   │   └── [id]/page.tsx
│   ├── buyers/
│   │   └── [siret]/page.tsx
│   └── analytics/
│       └── page.tsx
├── lib/france/
│   ├── types.ts
│   ├── queries.ts
│   ├── ingest.ts
│   └── parquet.ts
├── components/france/
│   ├── SpendByYearChart.tsx
│   ├── TopBuyersChart.tsx
│   ├── TopVendorsChart.tsx
│   ├── ProcedureBreakdownChart.tsx
│   ├── ContractTable.tsx
│   └── FiltersBar.tsx
├── scripts/
│   └── france-ingest.ts
└── lib/migrations/
    └── 004_france_tables.sql
```

## Technical Decisions

- **Parquet reading:** Use `duckdb-node-bindings` (`@duckdb/node-api`) for reading the Parquet file. This is the native Node.js binding (not the WASM browser variant) and supports streaming row batches efficiently.
- **Charts:** `recharts` — React-native, lightweight, handles bar/line/donut well.
- **Pagination:** Server components with URL search params for filtering/pagination. No separate API routes unless client-side interactivity demands it.
- **Styling:** Follow existing app patterns — Playfair Display + Source Sans 3 fonts, existing color system from `globals.css`. Dense, information-rich layouts.
- **Auth:** `/france` routes are public (no authentication required). This is public transparency data.
- **New dependencies:** `recharts`, `@duckdb/node-api`.

## Future Extensions (not in scope for v1)

- SIRENE API enrichment on `france_vendors` (company details, NAF code, employee count, address)
- AI-powered insights layer (natural language queries, anomaly narratives)
- Price benchmarking and overpayment detection per CPV category
- Buyer hierarchy mapping (which SIRETs belong to the same ministry)
- BOAMP tender notice matching (tender-to-award lag analysis)
- Regional/geographic analysis with PostGIS
