# CLO Data Layer Hardening — Design Spec

**Date:** 2026-04-09
**Status:** Draft
**Goal:** Eliminate fragility in the extraction → storage → model pipeline by validating at ingestion, resolving once, and showing what the model sees.

---

## Problem

The CLO waterfall model breaks silently because:

1. **Duplicate fields** — `spread` (string like "EURIBOR + 1.47%") and `spreadBps` (number like 147) coexist. The UI shows one, the model reads the other. When extraction populates one but not both, the model gets 0.
2. **Read-time heuristics** — Unit conversion (`wacSpread < 20 ? * 100 : use as-is`), field resolution (`t.spreadBps ?? ppmLookup ?? 0`), and type detection (`t.isIncomeNote ?? t.isSubordinate ?? className.includes("sub")`) happen at every read site, scattered across 4+ files.
3. **No write-time validation** — Bad data enters the DB (null spreads, string "null", wrong testType enums) and sits there until the waterfall blows up.
4. **Two data sources, unclear precedence** — DB tranches vs PPM constraints vs compliance snapshots, with ad-hoc fallback chains that differ by consumer.

## Architecture

Four layers, each with one job:

```
PDF → LLM Extraction → [Ingestion Gate] → DB
                                            ↓
                              [Canonical Resolver] → ResolvedDealData
                                                      ↓            ↓
                                              Context Editor    Projection Model
```

### Layer 1: Ingestion Validation Gate

**Location:** `web/lib/clo/extraction/ingestion-gate.ts`

**When it runs:** After LLM extraction completes, before DB write. Also runs on Context Editor JSON import.

**Function signature:**
```typescript
function validateAndNormalize(
  raw: ExtractedConstraints
): { ok: true; data: ExtractedConstraints; fixes: Fix[] }
 | { ok: false; errors: ValidationError[] }
```

**Hard errors** — extraction rejected, user sees message:
- Non-sub tranche with no spread (neither `spreadBps` nor parseable `spread` string)
- No maturity date found
- Coverage test entry with no trigger level
- Capital structure with zero tranches

**Soft fixes** — applied automatically, returned as `fixes[]`:
- `spreadBps` null but `spread` parseable → resolve and set `spreadBps`
- `wacSpread` < 20 → multiply by 100, store as bps
- `testType` is "OC Ratio" → normalize to `"OC_PAR"`; name contains "IC" → `"IC"`
- `isPassing` null but `actualValue` and `triggerLevel` present → compute
- String `"null"` → actual `null`
- `currentIssueDate` string "null" → `null`

**Normalization rules for spreads:**
```
Input                         → spreadBps
"EURIBOR + 1.47%"           → 147
"5.50% fixed"               → 550
"150bps"                     → 150
"50"                         → 50
spreadBps: 147 (already set) → 147 (no change)
```

The function also drops the `spread` string field after resolving `spreadBps`. Going forward, only `spreadBps` exists in stored data.

**For compliance report data**, a parallel function validates:
```typescript
function validateComplianceExtraction(
  raw: Pass1Output & Pass2Output & ...
): { ok: true; data: NormalizedCompliance; fixes: Fix[] }
 | { ok: false; errors: ValidationError[] }
```

This normalizes `testType` enums, computes missing `isPassing`, and ensures tranche snapshots have `spreadBps` when the source report contains coupon data.

### Layer 2: Canonical Resolver

**Location:** `web/lib/clo/resolver.ts`

**Purpose:** Takes raw data from all sources, applies precedence rules, produces a single clean object with no nulls for required fields.

**Function signature:**
```typescript
function resolveWaterfallInputs(
  constraints: ExtractedConstraints,
  complianceData: {
    poolSummary: CloPoolSummary | null;
    complianceTests: CloComplianceTest[];
    concentrations: CloConcentration[];
  } | null,
  tranches: CloTranche[],
  trancheSnapshots: CloTrancheSnapshot[],
  holdings: CloHolding[]
): { resolved: ResolvedDealData; warnings: ResolutionWarning[] }
```

**Output type:**
```typescript
interface ResolvedDealData {
  tranches: ResolvedTranche[];
  poolSummary: ResolvedPool;
  ocTriggers: ResolvedTrigger[];
  icTriggers: ResolvedTrigger[];
  dates: ResolvedDates;
  fees: ResolvedFees;
  loans: ResolvedLoan[];
}

interface ResolvedTranche {
  className: string;
  currentBalance: number;       // from snapshot > db tranche > ppm
  originalBalance: number;      // from db tranche > ppm
  spreadBps: number;            // guaranteed non-null, non-zero for debt
  seniorityRank: number;
  isFloating: boolean;
  isIncomeNote: boolean;
  isDeferrable: boolean;
  isAmortising: boolean;
  amortisationPerPeriod: number | null;
  source: "db_tranche" | "ppm" | "snapshot";
}

interface ResolvedPool {
  totalPar: number;             // Adjusted Collateral Principal Amount
  wacSpreadBps: number;         // always in bps
  warf: number;
  walYears: number;
  diversityScore: number;
  numberOfObligors: number;
}

interface ResolvedTrigger {
  className: string;
  triggerLevel: number;
  rank: number;
  testType: "OC" | "IC";
  source: "compliance" | "ppm";
}

interface ResolvedDates {
  maturity: string;             // ISO date, never null
  reinvestmentPeriodEnd: string | null;
  nonCallPeriodEnd: string | null;
  firstPaymentDate: string | null;
  currentDate: string;          // today
}

interface ResolvedFees {
  seniorFeePct: number;         // annual %, e.g. 0.15
  subFeePct: number;            // annual %, e.g. 0.25
}

interface ResolvedLoan {
  parBalance: number;
  maturityDate: string;
  ratingBucket: string;
  spreadBps: number;
}

interface ResolutionWarning {
  field: string;                // e.g. "Class B-2.spreadBps"
  message: string;
  severity: "info" | "warn" | "error";
  resolvedFrom?: string;        // e.g. "Parsed from spread string '550bps'"
}
```

**Precedence rules (explicit, not ad-hoc):**

| Field | Priority 1 | Priority 2 | Priority 3 | If all null |
|---|---|---|---|---|
| Tranche balance | Compliance snapshot | DB tranche | PPM principal | Error |
| Tranche spreadBps | DB tranche | PPM constraints | — | Error (non-sub) |
| OC triggers | Compliance tests | PPM coverage entries | — | Warn (no OC tests) |
| IC triggers | Compliance tests | PPM coverage entries | — | OK (not all classes have IC) |
| Maturity date | DB deal | PPM keyDates | — | Error |
| RP end date | DB deal | PPM keyDates | — | null (treated as expired) |
| WAC spread | Pool summary (normalized to bps) | — | — | Warn |
| Senior fee | PPM fees (name match "Senior") | — | — | Default 0.15 |
| Sub fee | PPM fees (name match "Sub") | — | — | Default 0.25 |
| isIncomeNote | DB tranche | PPM isSubordinated | className contains "sub" | false |
| isAmortising | className matches /class\s*x/i | — | — | false |
| amortPerPeriod | PPM classXAmortisation | currentBalance / 5 | — | null |

**Class name normalization** — used for all lookups between sources:
```typescript
function normClass(s: string): string {
  return s.replace(/^class\s+/i, "")
          .replace(/\s+notes?$/i, "")
          .trim()
          .toLowerCase();
}
// "Class A" → "a", "Class B-1 Notes" → "b-1", "Subordinated Notes" → "subordinated"
```

### Layer 3: Context Editor Changes

**Location:** `web/app/clo/context/ContextEditor.tsx`

**What changes:**

1. **On load**, call `resolveWaterfallInputs()` and store the resolved output + warnings in state.

2. **Capital structure table** shows resolved values:
   - Balance column: `resolvedTranche.currentBalance` (not PPM original)
   - Spread column: `resolvedTranche.spreadBps` (number, editable)
   - Source badge per row: small tag showing "snapshot", "ppm", "manual"

3. **Pool summary** shows resolved pool values with same source badges.

4. **Warnings panel** at the top of the tab:
   - Lists all `ResolutionWarning[]` from the resolver
   - Color-coded: info (grey), warn (amber), error (red)
   - Each warning links to the field it's about

5. **Editing** writes to the appropriate raw source, then re-resolves:
   ```typescript
   function handleEdit(field, value) {
     updateRawSource(field, value);  // writes to constraints or compliance
     const { resolved, warnings } = resolveWaterfallInputs(...);
     setResolved(resolved);
     setWarnings(warnings);
   }
   ```

6. **JSON export** exports `ResolvedDealData` (what the model sees), not the raw extraction.

7. **JSON import** runs through the ingestion gate, then resolves.

### Layer 4: Simplified Projection Model

**Location:** `web/app/clo/waterfall/ProjectionModel.tsx`

**What changes:**

The component receives `ResolvedDealData` instead of raw constraints + tranches + snapshots + compliance data. The ~150 lines of data assembly (fallback chains, parseSpreadBps, normClass, dedupTriggers, unit conversion) are deleted and replaced with a direct mapping:

```typescript
function buildProjectionInputs(
  resolved: ResolvedDealData,
  userAssumptions: UserAssumptions  // base rate, CDR, CPR, recovery, etc.
): ProjectionInputs {
  return {
    initialPar: resolved.poolSummary.totalPar,
    wacSpreadBps: resolved.poolSummary.wacSpreadBps,
    baseRatePct: userAssumptions.baseRatePct,
    seniorFeePct: resolved.fees.seniorFeePct,
    subFeePct: resolved.fees.subFeePct,
    tranches: resolved.tranches.map(t => ({
      className: t.className,
      currentBalance: t.currentBalance,
      spreadBps: t.spreadBps,
      seniorityRank: t.seniorityRank,
      isFloating: t.isFloating,
      isIncomeNote: t.isIncomeNote,
      isDeferrable: t.isDeferrable,
      isAmortising: t.isAmortising,
      amortisationPerPeriod: t.amortisationPerPeriod,
    })),
    ocTriggers: resolved.ocTriggers.map(t => ({
      className: t.className,
      triggerLevel: t.triggerLevel,
      rank: t.rank,
    })),
    icTriggers: resolved.icTriggers.map(t => ({
      className: t.className,
      triggerLevel: t.triggerLevel,
      rank: t.rank,
    })),
    maturityDate: resolved.dates.maturity,
    reinvestmentPeriodEnd: resolved.dates.reinvestmentPeriodEnd,
    currentDate: resolved.dates.currentDate,
    loans: resolved.loans,
    defaultRatesByRating: userAssumptions.defaultRates,
    cprPct: userAssumptions.cprPct,
    recoveryPct: userAssumptions.recoveryPct,
    recoveryLagMonths: userAssumptions.recoveryLagMonths,
    reinvestmentSpreadBps: userAssumptions.reinvestmentSpreadBps,
    reinvestmentTenorQuarters: userAssumptions.reinvestmentTenorYears * 4,
    reinvestmentRating: userAssumptions.reinvestmentRating,
    cccBucketLimitPct: userAssumptions.cccBucketLimitPct,
    cccMarketValuePct: userAssumptions.cccMarketValuePct,
    deferredInterestCompounds: userAssumptions.deferredInterestCompounds,
  };
}
```

**`projection.ts` (the engine) does not change.** It already consumes clean `ProjectionInputs`.

## Schema Consolidation (opportunistic)

While implementing the ingestion gate, consolidate these fields:

| Before | After | Migration |
|---|---|---|
| `capitalStructure[].spread` (string) + `spreadBps` (number) | `spreadBps` only (number) | Ingestion gate resolves string → number; drop `spread` from type |
| `complianceTests[].testType` free string | `testType` enum: `"OC_PAR"`, `"IC"`, `"OC_MV"` | Ingestion gate normalizes on write |
| `wacSpread` ambiguous unit | `wacSpreadBps` always in bps | Ingestion gate normalizes `< 20 → * 100` on write |
| `currentIssueDate: "null"` | `currentIssueDate: null` | Ingestion gate fixes string "null" |

These are safe because the ingestion gate handles the conversion, and downstream code only reads the canonical form.

## Files Changed

| File | Change |
|---|---|
| `web/lib/clo/extraction/ingestion-gate.ts` | **New** — validation + normalization at write time |
| `web/lib/clo/resolver.ts` | **New** — canonical resolver producing `ResolvedDealData` |
| `web/lib/clo/resolver-types.ts` | **New** — `ResolvedDealData` and related types |
| `web/lib/clo/extraction/runner.ts` | Call ingestion gate before DB writes |
| `web/lib/clo/extraction/normalizer.ts` | Move remaining normalization logic into ingestion gate; simplify |
| `web/app/clo/waterfall/ProjectionModel.tsx` | Delete data assembly logic (~150 lines); consume `ResolvedDealData` |
| `web/app/clo/waterfall/page.tsx` | Call resolver, pass `ResolvedDealData` to both editor and model |
| `web/app/clo/context/ContextEditor.tsx` | Show resolved values, source badges, warnings panel |
| `web/lib/clo/types.ts` | Drop `spread` string from `CapitalStructureEntry`; add enum for `testType` |

## What Doesn't Change

- `projection.ts` — the waterfall engine itself
- DB schema (tables, columns) — no migrations needed
- Extraction prompts — LLM can still output messy data
- API routes for saving constraints/compliance — same endpoints, data just arrives cleaner

## Success Criteria

1. The waterfall model never sees a null `spreadBps` for a debt tranche
2. The Context Editor shows the same values the waterfall model consumes
3. Unit ambiguity (bps vs percentage) is resolved exactly once, at ingestion
4. When data is wrong, warnings tell you which field, what was expected, and what was found
5. `ProjectionModel.tsx` has zero `parseSpreadBps`, `normClass`, or `?? 0` fallback chains
