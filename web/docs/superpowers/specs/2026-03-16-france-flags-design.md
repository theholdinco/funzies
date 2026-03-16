# France Procurement Flags & Transparency Upgrade

## Goal

Reorient the France procurement tool from a neutral data explorer into an anomaly-first transparency tool. Surface red flags (low competition, no-competition awards, amendment inflation, vendor concentration) as the primary experience, with the current exploratory views moved to a secondary "Explore" tab.

## Context & Data Findings

Investigation of the live DECP database revealed:

- **Single-bid rate is 27-28% and rising** — from 23% (2019) to 28% (2023-2025). 87B+ EUR in spend with only one bidder.
- **Software/IT (CPV 48) has 68% single-bid rate** — worst of any sector. Classic vendor lock-in.
- **Some buyers NEVER get competition** — e.g. Petit-Bourg (76 contracts, 100% single-bid), CCAS d'Ifs (33 contracts, 100%).
- **No-competition procedure heavily used** — RESAH did 1,613 no-competition contracts for 2.7B EUR. Nice Metropole did 327 for 833M EUR.
- **Amendment inflation is massive** — thousands of contracts doubled post-award.
- **Framework ceilings inflate totals** — 440B EUR of the 1,254B EUR total is framework agreement ceilings, not actual spend.
- **Vendor totals are 3.3x inflated** — 4.2T EUR vendor total vs 1.25T EUR contract total due to multi-vendor framework attribution.
- **2024-2025 data lost framework distinction** — everything labeled "Marche" regardless of nature.

## Architecture

No schema changes. No new tables. No new dependencies. All changes are:

1. New SQL query functions in `lib/france/queries.ts`
2. New TypeScript interfaces in `lib/france/types.ts`
3. UI reorganization: new page, reshaped pages, enhanced pages
4. CSS additions to `app/france/france.css`
5. Layout changes to `app/france/layout.tsx`

## Navigation

Sidebar changes from:

```
Dashboard | Contracts | Analytics
```

to:

```
Flags | Explore | Contracts | Analytics
```

- **Flags** (`/france`) — anomaly-first homepage (NEW content)
- **Explore** (`/france/explore`) — current neutral dashboard moved here (NEW route, no existing file at this path)
- **Contracts** (`/france/contracts`) — existing, enhanced with new filters
- **Analytics** (`/france/analytics`) — existing, unchanged

## Components

### 1. Flags Homepage (`/france`)

**Headline stats** (top row, 4 stat cards):

| Stat | Source query | Display |
|------|-------------|---------|
| Single-bid rate | COUNT(bids=1) / COUNT(bids>0) by year | "27.0%" with trend from 2019 baseline |
| No-competition spend | SUM(amount) WHERE procedure ILIKE '%sans%concurrence%' | "X B EUR" total |
| Doubled contracts | COUNT WHERE max(mod.amount) > 2x original | "X contracts" |
| Missing bid data | COUNT WHERE bids_received IS NULL or 0 / total | "X% of contracts" |

**Ranked lists** (3 sections below stats, each top 10 with "View all" link):

1. **Lowest competition buyers** — Buyers ranked by single-bid percentage.
   - Filter: min 10 contracts with bid data.
   - Columns: buyer name (linked), contracts with bids, single-bid %, total spend.
   - Query: group by buyer_siret, filter bids_received > 0, compute single_bid_count/total ratio.

2. **Top no-competition spenders** — Buyers ranked by spend via no-competition procedures.
   - Columns: buyer name (linked), no-comp contracts, total no-comp spend.
   - Query: WHERE procedure ILIKE '%sans%concurrence%' OR procedure ILIKE '%sans publicite%' OR procedure ILIKE '%negocie sans%', group by buyer.

3. **Worst amendment inflations** — Contracts where the last modification (by publication_date) increased amount >100%.
   - Columns: contract object (linked), buyer, original amount, final amount, % increase.
   - Query: JOIN modifications, take the last modification by publication_date (not MAX amount — we want the final state, not the peak), filter >100% increase. Exclude data bugs where pct_increase > 100,000% (defined as constant `MAX_PLAUSIBLE_INFLATION_PCT`).

### 2. Explore Page (`/france/explore`)

Exact content of the current `/france` page moved here unchanged:

- Summary stat cards (contracts, total spend, vendors, buyers, avg bids)
- Spend by year chart
- Top 10 buyers bar chart
- Top 10 vendors bar chart
- Procedure breakdown pie chart

One addition: the total spend stat card gets an inline disclaimer: "Includes framework ceilings".

### 3. Contract Explorer Enhancements (`/france/contracts`)

New filters added below the existing search/year row:

| Filter | Type | Query mapping |
|--------|------|--------------|
| Single bid only | Checkbox | `bids_received = 1` |
| No competition | Checkbox | `procedure ILIKE '%sans%concurrence%' OR procedure ILIKE '%sans publicite%' OR procedure ILIKE '%negocie sans%'` |
| Nature | Dropdown: All / Marches / Accords-cadres | `LOWER(nature) IN (...)` |
| Has amendments | Checkbox | `uid IN (SELECT contract_uid FROM france_modifications)` |
| Amount min | Number input | `amount_ht >= X` |
| Amount max | Number input | `amount_ht <= X` |

All filters compose with each other and with existing filters. All passed as URL search params for shareability.

Changes to `ContractFilters` interface:

```typescript
export interface ContractFilters {
  // existing
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
  // new
  singleBidOnly?: boolean;
  noCompetition?: boolean;
  nature?: 'marche' | 'accord-cadre';
  hasAmendments?: boolean;
}
```

### 4. Buyer Profile Flags (`/france/buyers/[siret]`)

New section between stats grid and charts. Only shown if any flags apply.

Flags computed per-buyer via a single query:

- **"X% single-bid rate"** — shown if >50% of contracts with bid data had bids_received=1. Badge variant: danger if >80%, warning if >50%.
- **"X contracts via no-competition"** — shown if any contracts used no-competition procedure. Badge variant: warning.
- **"X contracts with >100% amendment inflation"** — shown if any contract's final modification amount exceeded double the original. Badge variant: danger. Uses same threshold as flags homepage (>100% increase).

Each flag renders as a `fr-badge` with icon, stat value, and one-line explanation.

### 5. Vendor Profile Flags (`/france/vendors/[id]`)

Same section pattern as buyer profiles.

Flags computed per-vendor:

- **"On X multi-vendor contracts"** — count of distinct contract_uids where this vendor appears AND the contract has 3+ vendors total (requires self-join on france_contract_vendors: count vendors per contract_uid, filter >=3, then count contracts for this vendor). Badge variant: info.
- **"X% spend from single buyer"** — shown if >60% of their total comes from one buyer_siret. Computed via: join france_contract_vendors -> france_contracts, group by buyer_siret, take max(sum(amount_ht)) / total. buyer_name is denormalized on france_contracts. Badge variant: warning.
- **"X no-competition awards"** — shown if they won contracts via no-competition procedure. Badge variant: warning.

### 6. Data Quality Banner

Added to `app/france/layout.tsx`, inside `fr-main`, above `{children}`.

Subtle amber/cream bar with text:

> "DECP data reflects award notices only. Framework agreement amounts are maximum ceilings, not actual spend. Vendor totals may be overstated on multi-vendor contracts."

Dismissable per session (client-side state, no persistence needed).

### 7. Inline Disclaimers

Two specific locations:

1. **Explore page** total spend stat card — small muted text: "Includes framework ceilings"
2. **Vendor profile** total spend stat card — small muted text: "May include shared framework ceilings"

## Constants

Defined in `lib/france/queries.ts` alongside existing `SANE_AMOUNT`, `SANE_DATE`, `SANE_BIDS`:

```typescript
const NO_COMP_FILTER = "procedure ILIKE '%sans%concurrence%' OR procedure ILIKE '%sans publicite%' OR procedure ILIKE '%negocie sans%'";
const MAX_PLAUSIBLE_INFLATION_PCT = 100_000; // exclude data bugs above this %
```

## New Query Functions

Added to `lib/france/queries.ts`:

| Function | Purpose | Used by |
|----------|---------|---------|
| `getFlagStats()` | Headline stats for flags page | Flags homepage |
| `getLowestCompetitionBuyers(limit)` | Buyers ranked by single-bid % | Flags homepage |
| `getTopNoCompetitionSpenders(limit)` | Buyers ranked by no-comp spend | Flags homepage |
| `getWorstAmendmentInflations(limit)` | Contracts with biggest % increase | Flags homepage |
| `getBuyerFlags(siret)` | Flag data for a specific buyer | Buyer profile |
| `getVendorFlags(vendorId)` | Flag data for a specific vendor | Vendor profile |

## New Types

Added to `lib/france/types.ts`:

```typescript
export interface FlagStats {
  singleBidRate: number;         // current overall percentage
  singleBidRate2019: number;     // 2019 percentage for trend comparison
  noCompetitionSpend: number;    // EUR
  noCompetitionContracts: number;
  doubledContracts: number;      // count where last mod > 2x original
  missingBidDataPct: number;     // percentage
}
// getFlagStats() computes singleBidRate as overall and singleBidRate2019
// via two separate aggregations filtered by year range.

export interface BuyerFlag {
  singleBidPct: number | null;   // null if insufficient data
  noCompetitionCount: number;
  noCompetitionSpend: number;
  inflatedContractCount: number;
}

export interface VendorFlag {
  multiVendorFrameworks: number;
  topBuyerConcentrationPct: number;
  topBuyerName: string;
  noCompetitionAwards: number;
}

export interface FlaggedBuyer {
  siret: string;
  name: string;
  contractsWithBids: number;
  singleBidCount: number;
  singleBidPct: number;
  totalSpend: number;
}

export interface NoCompBuyer {
  siret: string;
  name: string;
  noCompContracts: number;
  noCompSpend: number;
}

export interface InflatedContract {
  uid: string;
  object: string;
  buyerName: string;
  originalAmount: number;
  finalAmount: number;   // last modification by publication_date, not MAX
  pctIncrease: number;
}
// Query uses DISTINCT ON (contract_uid) ORDER BY publication_date DESC
// to get the final modification state, not the peak amount.
```

## File Changes Summary

| File | Change |
|------|--------|
| `app/france/layout.tsx` | Update sidebar nav (4 items), add data quality banner |
| `app/france/page.tsx` | Replace dashboard with flags homepage |
| `app/france/explore/page.tsx` | NEW — current dashboard content moved here |
| `app/france/contracts/page.tsx` | Add filter toggles row |
| `app/france/buyers/[siret]/page.tsx` | Add flags section |
| `app/france/vendors/[id]/page.tsx` | Add flags section |
| `app/france/france.css` | Add flag badge styles, banner styles, filter toggle styles |
| `lib/france/queries.ts` | Add 6 new query functions, extend ContractFilters |
| `lib/france/types.ts` | Add flag-related interfaces |
| `components/france/Charts.tsx` | No changes |

## Out of Scope

- Composite risk scores (individual flags only — more honest)
- Schema changes or new database tables
- BOAMP cross-referencing
- Historical trend tracking beyond what's in current data
- User accounts / saved searches / alerts
