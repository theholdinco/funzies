# Inception IRR

## Problem

The waterfall model currently shows a **forward-projected IRR** (what will the equity return from today onward given assumptions). There is no way to see **how the position has actually performed since purchase** — the inception IRR based on real cash flows.

## Design

### Data Model

Add a JSONB column `equity_inception_data` to `clo_profiles`:

```sql
ALTER TABLE clo_profiles
  ADD COLUMN IF NOT EXISTS equity_inception_data JSONB DEFAULT NULL;
```

Shape:

```ts
interface EquityInceptionData {
  purchaseDate: string | null;       // YYYY-MM-DD
  purchasePriceCents: number | null;  // cents on dollar (e.g. 75 = 75%)
  payments: EquityPastPayment[];
}

interface EquityPastPayment {
  date: string;                // payment date YYYY-MM-DD
  distribution: number | null; // absolute amount, null = not yet entered
}
```

### Type Changes

Add `equityInceptionData` to `CloProfile` interface in `types/entities.ts`:

```ts
equityInceptionData: EquityInceptionData | null;
```

Add to `rowToProfile()` in `access.ts`.

### Migration

File: `web/lib/migrations/007_add_equity_inception_data.sql`

### Context Tab UI

New `CollapsibleSection` titled **"Equity Inception"** in the ContextEditor, placed under Group 3 (Fund Profile & Portfolio).

Contains:
- **Purchase date** — date input
- **Purchase price** — number input in cents (same unit as waterfall's equityEntryPriceCents)
- **Past payments table** — auto-generated quarterly rows from purchase date to today. Each row has:
  - Date (read-only, auto-generated)
  - Distribution amount (editable number input, defaults to `null` / empty)
- **Save button** — persists to `clo_profiles.equity_inception_data` via API

Auto-generation logic: starting from purchase date, generate payment dates every 3 months (quarterly) up to today. When purchase date changes, regenerate rows but preserve any existing distribution values where dates match.

### API Endpoint

`PATCH /api/clo/profile/inception` — saves the `equity_inception_data` JSONB to the profile.

### Waterfall Display

In `ProjectionModel.tsx`, next to the existing "Projected Forward IRR" card, add an **"Inception IRR"** metric.

Data flow: the waterfall page already loads the profile via `getProfileForUser()` and calls `rowToProfile()`. Pass `equityInceptionData` through to `ProjectionModel` as a new prop.

Computation (client-side in a `useMemo`):
1. Find the income note tranche's `originalBalance` (subPar) — already computed as `equityMetrics.subPar`
2. Convert purchase price: `purchasePrice = subPar * purchasePriceCents / 100`
3. Build cash flow array: `[-purchasePrice, ...payments.filter(p => p.distribution != null).map(p => p.distribution)]`
4. Call `calculateIrr(cashFlows, 4)` (quarterly periods)
5. Display result; show "N/A" or greyed out when data is incomplete (no purchase price, or zero filled payments)

### Display Details

- Label: **"Inception IRR"** with subtitle "(actual cash flows)"
- Same card style as the existing forward IRR card
- When incomplete: show a muted "-- %" with tooltip "Enter past payments in Context tab"
- When all payments are filled: show the computed IRR with the same formatting as forward IRR

## Files to Create/Modify

| File | Action |
|------|--------|
| `web/lib/migrations/007_add_equity_inception_data.sql` | Create — migration |
| `web/lib/clo/types/entities.ts` | Modify — add `EquityInceptionData` interface and field to `CloProfile` |
| `web/lib/clo/access.ts` | Modify — map new column in `rowToProfile()` |
| `web/app/api/clo/profile/inception/route.ts` | Create — PATCH endpoint |
| `web/app/clo/context/ContextEditor.tsx` | Modify — add Equity Inception section |
| `web/app/clo/context/page.tsx` | Modify — pass inception data to ContextEditor |
| `web/app/clo/waterfall/page.tsx` | Modify — pass inception data to ProjectionModel |
| `web/app/clo/waterfall/ProjectionModel.tsx` | Modify — accept prop, compute & display inception IRR |

## Edge Cases

- **No income note tranche found**: cannot compute inception IRR (need subPar for price conversion). Show "N/A".
- **Purchase date in the future**: no payment rows generated. Show "N/A".
- **Partial data**: some payments filled, some null. Require all payments to be filled before computing IRR — avoids misleading partial results. Show "X of Y payments entered" when incomplete.
- **Payment frequency mismatch**: CLOs are quarterly. If deal has a different frequency, the auto-generated dates may not align with actual payment dates. User can edit dates if needed (or we keep them read-only and quarterly — simpler, good enough for most cases).
