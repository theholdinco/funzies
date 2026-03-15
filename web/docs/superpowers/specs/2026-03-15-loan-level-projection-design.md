# Loan-Level Projection Engine

## Problem

The current waterfall projection engine models the collateral pool as a single homogeneous lump. Defaults are applied as a percentage of the aggregate pool (pro-rata), and scheduled maturities reference the original par amounts from holdings. This creates a bookkeeping mismatch: defaults erode `currentPar`, but maturities still try to subtract full original amounts. After all loans mature, orphan par remains — par that belongs to no loan and never exits the pool. CLO analysts correctly flag this as a bug.

Additionally, a single CDR applied uniformly ignores that loans with different credit ratings have materially different default probabilities. Since loans also have different maturity dates, the interaction between rating and maturity affects the timing and shape of cash flows.

## Solution

Replace the pool-level model with per-loan tracking. Each loan is modeled individually with:
- A rating-based annual default rate (hazard rate)
- Its own surviving par that declines each quarter via defaults
- A maturity date at which its surviving par exits the pool

This is the standard deterministic expected-value approach for CLO cashflow projections.

## Design

### New: Per-loan state tracking

Each loan from the holdings array becomes a tracked entity:

```typescript
interface LoanState {
  parBalance: number;       // original par
  survivingPar: number;     // current expected surviving par
  maturityQuarter: number;  // quarter in which this loan matures
  ratingBucket: string;     // e.g. "B", "BB", "CCC" — drives default rate
  spreadBps: number;        // for per-loan interest calculation
}
```

### New: Rating-based default rates

Replace the single `cdrPct` slider with a set of per-rating-bucket annual default rates. Moody's historical 1Y averages as defaults:

| Bucket | Label | Default CDR |
|--------|-------|-------------|
| AAA | Aaa/AAA | 0.00% |
| AA | Aa/AA | 0.02% |
| A | A | 0.06% |
| BBB | Baa/BBB | 0.18% |
| BB | Ba/BB | 1.06% |
| B | B | 3.41% |
| CCC | Caa-C/CCC | 10.28% |
| NR | Unrated | 2.00% |

User can adjust each bucket independently via sliders. A "Set all to..." input at the top applies a uniform rate to all buckets (visually updating each slider), restoring the current single-CDR UX for users who want simplicity.

### Rating mapping

Map holdings' `moodysRating` (primary), `spRating` (fallback), `fitchRating` (tertiary fallback), or `compositeRating` (last resort) to buckets:

- Aaa → AAA, Aa1/Aa2/Aa3 → AA, A1/A2/A3 → A, Baa1/Baa2/Baa3 → BBB
- Ba1/Ba2/Ba3 → BB, B1/B2/B3 → B, Caa1/Caa2/Caa3/Ca/C → CCC
- S&P equivalents: AAA, AA+/AA/AA-, A+/A/A-, BBB+/BBB/BBB-, etc.
- Fitch uses S&P-style notation (AAA, AA+, etc.) — same mapping as S&P
- null/empty/unrecognizable strings (e.g. "WR", "NR", "D") → NR bucket

### Edge cases

- **Already-defaulted holdings** (`isDefaulted === true`): Exclude from the loans array. Their par is already lost; including them would double-count losses.
- **Holdings with null `spreadBps`**: Use the pool-level `wacSpreadBps` as fallback.
- **Holdings with null `maturityDate`**: Assign the CLO's legal final maturity date. If the CLO itself has no maturity date, use 40 quarters (10 years) from current date — consistent with the current engine's fallback.
- **Holdings with null `parBalance`**: Exclude from loans array.

### Per-quarter loop (replaces current pool logic)

**Order of operations change:** The current engine applies defaults → prepayments → maturities. The new engine applies defaults → maturities → prepayments. Rationale: a loan maturing this quarter should have its surviving par exit the pool before prepayment logic runs — you can't prepay a loan that just matured. This changes output values slightly even with identical aggregate CDR.

For each quarter `q`:

1. **Per-loan defaults, maturities, and prepayments:**
   - For each loan `i` with rating bucket `r`:
     - `quarterlyHazard_r = 1 - (1 - annualCDR_r / 100) ^ 0.25`
     - `defaults_i = loan.survivingPar × quarterlyHazard_r`
     - `loan.survivingPar -= defaults_i`
     - If `q === loan.maturityQuarter`: `maturity_i = loan.survivingPar`, `loan.survivingPar = 0`
     - Otherwise: `prepay_i = loan.survivingPar × qPrepayRate` (CPR uniform across all loans — prepayment isn't rating-dependent; this is a known simplification)
     - `loan.survivingPar -= prepay_i`
   - Aggregate: `totalDefaults = Σ defaults_i`, `totalMaturities = Σ maturity_i`, `totalPrepayments = Σ prepay_i`
   - `currentPar = Σ loan.survivingPar`

2. **Recovery pipeline** — unchanged. `totalDefaults × recoveryPct` queued at `q + recoveryLagQ`.

3. **Interest collection** — Per-loan: `Σ (loan.survivingPar_beginning × (baseRatePct + loan.spreadBps / 100) / 100 / 4)`. This replaces the aggregate WAC approach — since we're iterating loans anyway, using each loan's actual spread is trivial and more accurate (the aggregate WAC becomes stale as loans with different spreads default/mature at different rates due to rating-differentiated hazard rates).

4. **Reinvestment (during RP):**
   - Reinvest maturity + prepayment + recovery proceeds into a single new synthetic loan per quarter
   - New loan uses the reinvestment spread, the portfolio's par-weighted modal rating bucket, and a 5-year maturity from purchase date (clamped to CLO maturity)
   - Merging into one synthetic loan per quarter keeps the loan array manageable (avoids growing by N loans per RP quarter)

5. **Waterfall** — OC/IC tests, interest waterfall, principal waterfall, equity distribution — all unchanged, operating on aggregated figures.

### What changes

| Component | Before | After |
|-----------|--------|-------|
| Default application | `currentPar × qDefaultRate` (pool) | Per-loan: `loan.survivingPar × qHazardRate_r` |
| Maturity handling | Bucketed by quarter from original par, capped at remaining pool par | Per-loan: surviving par exits at loan's maturity quarter |
| Interest collection | `beginningPar × allInRate / 4` (aggregate WAC) | Per-loan: `Σ loan.survivingPar × loan.allInRate / 4` |
| CDR input | Single slider (0-10%) | Per-rating-bucket sliders + "Set all to..." override |
| Par tracking | Single `currentPar` number | Array of `LoanState` objects, aggregated for waterfall |
| Order of operations | Defaults → prepayments → maturities | Defaults → maturities → prepayments |

### What stays the same

- Waterfall mechanics (OC/IC gating, tranche paydown, interest priority)
- Recovery pipeline (defaults → recovery after lag)
- CPR (applied uniformly)
- IRR calculation (Newton-Raphson)
- All UI output formats (cash flow table, par chart, tranche payoff timeline, summary cards)

### ProjectionInputs changes

```typescript
// Replace:
//   cdrPct: number;
//   maturitySchedule: { parBalance: number; maturityDate: string }[];

// With:
loans: {
  parBalance: number;
  maturityDate: string;      // always set — fallback to CLO maturity or 10yr
  ratingBucket: string;      // mapped from holdings rating fields
  spreadBps: number;         // per-loan spread for interest calculation
}[];
defaultRatesByRating: Record<string, number>; // annual CDR per bucket

// Keep unchanged:
// cprPct, recoveryPct, recoveryLagMonths, reinvestmentSpreadBps
// initialPar, wacSpreadBps, baseRatePct, seniorFeePct
// tranches, ocTriggers, icTriggers
// reinvestmentPeriodEnd, maturityDate, currentDate
```

Note: `initialPar` and `wacSpreadBps` are kept for cases where the loans array is empty (no holdings data) — the engine falls back to pool-level behavior.

### PeriodResult additions

```typescript
// Add to PeriodResult:
defaultsByRating: Record<string, number>;  // defaults broken out by rating bucket
```

This enables the UI to show which rating buckets are driving losses.

### UI changes (ProjectionModel.tsx)

1. **Replace CDR slider** with a collapsible "Default Rates by Rating" panel
   - One slider per rating bucket (AAA through CCC + NR)
   - Seeded with Moody's historical defaults
   - A "Set all to..." quick-override input at the top that visually updates all bucket sliders
   - Show the portfolio-weighted average CDR as a summary stat

2. **Rating distribution summary** — small bar or table showing how many loans / how much par is in each bucket, so the user understands the portfolio composition driving the model

3. **SuggestAssumptions component** — update to either suggest per-rating defaults or suggest a uniform CDR that gets applied via "Set all to..." to all buckets

4. **Model assumptions disclosure** — update text to describe per-loan model with rating-based defaults

5. Keep all existing output sections unchanged

### Performance

With N loans (typically 100-300) and Q quarters (typically 20-40):
- Per-quarter work: O(N) — iterate loans, apply defaults/maturities
- Reinvestment adds ~1 synthetic loan per RP quarter (merged), so N grows by ~8-10 over the projection
- Total: O(N × Q) = 4,000-12,000 iterations
- Client-side, instant recalculation on slider change

### Files to modify

1. **`web/lib/clo/projection.ts`** — Core engine rewrite: per-loan tracking, rating-based hazard rates, loan-level defaults/maturities/interest, `defaultsByRating` output
2. **`web/app/clo/waterfall/ProjectionModel.tsx`** — UI: replace CDR slider with per-rating panel, build `loans` array from holdings (with rating mapping, edge case handling), rating distribution summary, update SuggestAssumptions integration
3. **`web/lib/clo/__tests__/projection.test.ts`** — Rewrite tests for new input shape (new `makeInputs` helper with `loans` and `defaultRatesByRating`). Preserve all existing scenario coverage (maturity correctness, OC/IC gating, WAC blending, recovery pipeline, etc.). Add new tests for: zero residual par after all maturities, rating-differentiated defaults, already-defaulted exclusion, per-loan interest calculation, `defaultsByRating` output
