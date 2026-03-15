# Loan-Level Projection Engine Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pool-level pro-rata default model with per-loan tracking so maturities correctly subtract only surviving par, and defaults use rating-specific CDRs.

**Architecture:** Each holding becomes a `LoanState` tracked individually through the quarterly loop. Defaults, maturities, prepayments, and interest are computed per-loan then aggregated for the existing waterfall. Rating-based CDR sliders replace the single CDR slider.

**Tech Stack:** TypeScript, React (client-side only), Vitest

**Spec:** `web/docs/superpowers/specs/2026-03-15-loan-level-projection-design.md`

---

## Chunk 1: Rating Mapping Utility + Engine Core

### Task 1: Rating mapping utility

**Files:**
- Create: `web/lib/clo/rating-mapping.ts`
- Create: `web/lib/clo/__tests__/rating-mapping.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// web/lib/clo/__tests__/rating-mapping.test.ts
import { describe, it, expect } from "vitest";
import { mapToRatingBucket, DEFAULT_RATES_BY_RATING, RATING_BUCKETS } from "../rating-mapping";

describe("mapToRatingBucket", () => {
  it("maps Moody's ratings to buckets", () => {
    expect(mapToRatingBucket("Aaa", null, null, null)).toBe("AAA");
    expect(mapToRatingBucket("Aa1", null, null, null)).toBe("AA");
    expect(mapToRatingBucket("Aa2", null, null, null)).toBe("AA");
    expect(mapToRatingBucket("Aa3", null, null, null)).toBe("AA");
    expect(mapToRatingBucket("A1", null, null, null)).toBe("A");
    expect(mapToRatingBucket("A2", null, null, null)).toBe("A");
    expect(mapToRatingBucket("A3", null, null, null)).toBe("A");
    expect(mapToRatingBucket("Baa1", null, null, null)).toBe("BBB");
    expect(mapToRatingBucket("Baa2", null, null, null)).toBe("BBB");
    expect(mapToRatingBucket("Baa3", null, null, null)).toBe("BBB");
    expect(mapToRatingBucket("Ba1", null, null, null)).toBe("BB");
    expect(mapToRatingBucket("Ba2", null, null, null)).toBe("BB");
    expect(mapToRatingBucket("Ba3", null, null, null)).toBe("BB");
    expect(mapToRatingBucket("B1", null, null, null)).toBe("B");
    expect(mapToRatingBucket("B2", null, null, null)).toBe("B");
    expect(mapToRatingBucket("B3", null, null, null)).toBe("B");
    expect(mapToRatingBucket("Caa1", null, null, null)).toBe("CCC");
    expect(mapToRatingBucket("Caa2", null, null, null)).toBe("CCC");
    expect(mapToRatingBucket("Caa3", null, null, null)).toBe("CCC");
    expect(mapToRatingBucket("Ca", null, null, null)).toBe("CCC");
    expect(mapToRatingBucket("C", null, null, null)).toBe("CCC");
  });

  it("maps S&P ratings to buckets", () => {
    expect(mapToRatingBucket(null, "AAA", null, null)).toBe("AAA");
    expect(mapToRatingBucket(null, "AA+", null, null)).toBe("AA");
    expect(mapToRatingBucket(null, "AA", null, null)).toBe("AA");
    expect(mapToRatingBucket(null, "AA-", null, null)).toBe("AA");
    expect(mapToRatingBucket(null, "A+", null, null)).toBe("A");
    expect(mapToRatingBucket(null, "BBB-", null, null)).toBe("BBB");
    expect(mapToRatingBucket(null, "BB+", null, null)).toBe("BB");
    expect(mapToRatingBucket(null, "B-", null, null)).toBe("B");
    expect(mapToRatingBucket(null, "CCC+", null, null)).toBe("CCC");
    expect(mapToRatingBucket(null, "CCC", null, null)).toBe("CCC");
    expect(mapToRatingBucket(null, "CC", null, null)).toBe("CCC");
    expect(mapToRatingBucket(null, "D", null, null)).toBe("CCC");
  });

  it("uses Moody's first, then S&P, then Fitch, then composite", () => {
    expect(mapToRatingBucket("B1", "BB+", "A+", "BBB")).toBe("B");
    expect(mapToRatingBucket(null, "BB+", "A+", "BBB")).toBe("BB");
    expect(mapToRatingBucket(null, null, "A+", "BBB")).toBe("A");
    expect(mapToRatingBucket(null, null, null, "BBB")).toBe("BBB");
  });

  it("maps unrecognizable strings to NR", () => {
    expect(mapToRatingBucket("WR", null, null, null)).toBe("NR");
    expect(mapToRatingBucket("NR", null, null, null)).toBe("NR");
    expect(mapToRatingBucket(null, "NR", null, null)).toBe("NR");
    expect(mapToRatingBucket(null, null, null, null)).toBe("NR");
    expect(mapToRatingBucket("", "", "", "")).toBe("NR");
  });

  it("handles case-insensitive matching", () => {
    expect(mapToRatingBucket("baa1", null, null, null)).toBe("BBB");
    expect(mapToRatingBucket(null, "bbb+", null, null)).toBe("BBB");
  });
});

describe("DEFAULT_RATES_BY_RATING", () => {
  it("has an entry for every bucket", () => {
    for (const bucket of RATING_BUCKETS) {
      expect(DEFAULT_RATES_BY_RATING[bucket]).toBeDefined();
      expect(typeof DEFAULT_RATES_BY_RATING[bucket]).toBe("number");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/clo/__tests__/rating-mapping.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// web/lib/clo/rating-mapping.ts

export const RATING_BUCKETS = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "NR"] as const;
export type RatingBucket = typeof RATING_BUCKETS[number];

// Moody's historical 1Y average default rates
export const DEFAULT_RATES_BY_RATING: Record<RatingBucket, number> = {
  AAA: 0.00,
  AA: 0.02,
  A: 0.06,
  BBB: 0.18,
  BB: 1.06,
  B: 3.41,
  CCC: 10.28,
  NR: 2.00,
};

const MOODYS_MAP: Record<string, RatingBucket> = {
  aaa: "AAA",
  aa1: "AA", aa2: "AA", aa3: "AA",
  a1: "A", a2: "A", a3: "A",
  baa1: "BBB", baa2: "BBB", baa3: "BBB",
  ba1: "BB", ba2: "BB", ba3: "BB",
  b1: "B", b2: "B", b3: "B",
  caa1: "CCC", caa2: "CCC", caa3: "CCC",
  ca: "CCC", c: "CCC",
};

const SP_FITCH_MAP: Record<string, RatingBucket> = {
  aaa: "AAA",
  "aa+": "AA", aa: "AA", "aa-": "AA",
  "a+": "A", a: "A", "a-": "A",
  "bbb+": "BBB", bbb: "BBB", "bbb-": "BBB",
  "bb+": "BB", bb: "BB", "bb-": "BB",
  "b+": "B", b: "B", "b-": "B",
  "ccc+": "CCC", ccc: "CCC", "ccc-": "CCC",
  "cc+": "CCC", cc: "CCC", "cc-": "CCC",
  c: "CCC", d: "CCC",
};

function tryMap(rating: string | null, map: Record<string, RatingBucket>): RatingBucket | null {
  if (!rating || !rating.trim()) return null;
  return map[rating.trim().toLowerCase()] ?? null;
}

export function mapToRatingBucket(
  moodys: string | null,
  sp: string | null,
  fitch: string | null,
  composite: string | null
): RatingBucket {
  return (
    tryMap(moodys, MOODYS_MAP) ??
    tryMap(sp, SP_FITCH_MAP) ??
    tryMap(fitch, SP_FITCH_MAP) ??
    tryMap(composite, { ...MOODYS_MAP, ...SP_FITCH_MAP }) ??
    "NR"
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run lib/clo/__tests__/rating-mapping.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/lib/clo/rating-mapping.ts web/lib/clo/__tests__/rating-mapping.test.ts
git commit -m "feat(clo): add rating-to-bucket mapping utility for projection engine"
```

### Task 2: Rewrite projection engine interfaces

**Files:**
- Modify: `web/lib/clo/projection.ts` (interfaces at lines 4-55)

- [ ] **Step 1: Update `ProjectionInputs` — replace `cdrPct` and `maturitySchedule` with `loans` and `defaultRatesByRating`**

```typescript
// Replace lines 4-28 of projection.ts with:

export interface LoanInput {
  parBalance: number;
  maturityDate: string;
  ratingBucket: string;
  spreadBps: number;
}

export interface ProjectionInputs {
  initialPar: number;
  wacSpreadBps: number;
  baseRatePct: number;
  seniorFeePct: number;
  tranches: {
    className: string;
    currentBalance: number;
    spreadBps: number;
    seniorityRank: number;
    isFloating: boolean;
    isIncomeNote: boolean;
  }[];
  ocTriggers: { className: string; triggerLevel: number; rank: number }[];
  icTriggers: { className: string; triggerLevel: number; rank: number }[];
  reinvestmentPeriodEnd: string | null;
  maturityDate: string | null;
  currentDate: string;
  loans: LoanInput[];
  defaultRatesByRating: Record<string, number>;
  cprPct: number;
  recoveryPct: number;
  recoveryLagMonths: number;
  reinvestmentSpreadBps: number;
}
```

- [ ] **Step 2: Add `defaultsByRating` to `PeriodResult`**

Add to the `PeriodResult` interface (after the `equityDistribution` field):

```typescript
  defaultsByRating: Record<string, number>;
```

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/projection.ts
git commit -m "feat(clo): update projection interfaces for per-loan model"
```

### Task 3: Rewrite projection engine core loop

**Files:**
- Modify: `web/lib/clo/projection.ts` (the `runProjection` function, lines 98-363)

This is the core change. Replace the pool-level loop with per-loan tracking.

- [ ] **Step 1: Rewrite `runProjection`**

Replace the entire `runProjection` function body. Keep `validateInputs`, `quartersBetween`, `addQuarters`, `trancheCouponRate`, and `calculateIrr` unchanged.

Key changes in the new implementation:
1. Initialize `LoanState[]` from `inputs.loans` — each loan gets `survivingPar = parBalance` and `maturityQuarter = quartersBetween(currentDate, maturityDate)`
2. Pre-compute quarterly hazard rates per rating bucket from `defaultRatesByRating`
3. Pre-compute quarterly prepay rate from `cprPct` (unchanged formula)
4. Per-quarter loop:
   - Iterate loans: apply defaults (per-rating hazard), then maturities (if q === maturityQuarter), then prepayments on surviving non-matured loans
   - Aggregate totals for waterfall
   - Compute per-loan interest: `Σ loan.beginningPar × (baseRatePct + loan.spreadBps / 100) / 100 / 4`
   - Recovery pipeline unchanged
   - Reinvestment: create single synthetic loan with reinvestment spread, NR bucket, maturing at RP end quarter
   - OC/IC tests, interest waterfall, principal waterfall, equity distribution — all use aggregated figures, unchanged logic
5. Final quarter: remaining surviving par across all loans is liquidated (set all `survivingPar = 0`)
6. Track `defaultsByRating` per period

The waterfall section (OC/IC computation, interest waterfall with diversion, principal waterfall with tranche paydown) should be copied verbatim from the existing code — it operates on the same aggregated variables (`endingPar`, `interestCollected`, `prepayments`, `scheduledMaturities`, `recoveries`, `reinvestment`, etc.).

- [ ] **Step 2: Update `validateInputs`**

Remove the check for `cdrPct` (no longer exists). The engine should work with an empty `loans` array (falls back to `initialPar` with no defaults/maturities — just interest and waterfall).

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/projection.ts
git commit -m "feat(clo): rewrite projection engine with per-loan tracking and rating-based defaults"
```

### Task 4: Rewrite projection tests

**Files:**
- Modify: `web/lib/clo/__tests__/projection.test.ts`

- [ ] **Step 1: Rewrite `makeInputs` helper**

Replace the existing helper. The new version uses `loans` and `defaultRatesByRating` instead of `cdrPct` and `maturitySchedule`:

```typescript
import { RATING_BUCKETS, DEFAULT_RATES_BY_RATING } from "../rating-mapping";

function makeInputs(overrides: Partial<ProjectionInputs> = {}): ProjectionInputs {
  // Default: 10 loans, all B-rated, $10M each, staggered maturities Q8-Q17
  const defaultLoans: LoanInput[] = Array.from({ length: 10 }, (_, i) => ({
    parBalance: 10_000_000,
    maturityDate: addQuartersHelper("2026-03-09", 8 + i),
    ratingBucket: "B",
    spreadBps: 375,
  }));

  return {
    initialPar: 100_000_000,
    wacSpreadBps: 375,
    baseRatePct: 4.5,
    seniorFeePct: 0.45,
    tranches: [
      { className: "A", currentBalance: 65_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false },
      { className: "B", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false },
      { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true },
    ],
    ocTriggers: [
      { className: "A", triggerLevel: 120, rank: 1 },
      { className: "B", triggerLevel: 110, rank: 2 },
    ],
    icTriggers: [
      { className: "A", triggerLevel: 120, rank: 1 },
      { className: "B", triggerLevel: 110, rank: 2 },
    ],
    reinvestmentPeriodEnd: "2028-06-15",
    maturityDate: "2034-06-15",
    currentDate: "2026-03-09",
    loans: defaultLoans,
    defaultRatesByRating: { ...DEFAULT_RATES_BY_RATING },
    cprPct: 15,
    recoveryPct: 60,
    recoveryLagMonths: 12,
    reinvestmentSpreadBps: 350,
    ...overrides,
  };
}
```

- [ ] **Step 2: Write core per-loan behavior tests**

```typescript
describe("per-loan model — maturity correctness", () => {
  it("zero residual par after all loans mature (no defaults, no prepay)", () => {
    // All loans mature at Q4, no defaults, no prepay
    const loans = [
      { parBalance: 50_000_000, maturityDate: addQuartersHelper("2026-03-09", 4), ratingBucket: "B", spreadBps: 375 },
      { parBalance: 50_000_000, maturityDate: addQuartersHelper("2026-03-09", 4), ratingBucket: "B", spreadBps: 375 },
    ];
    const allZero = Object.fromEntries(RATING_BUCKETS.map(b => [b, 0]));
    const result = runProjection(makeInputs({
      loans,
      defaultRatesByRating: allZero,
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    const q4 = result.periods.find(p => p.periodNum === 4)!;
    expect(q4.scheduledMaturities).toBeCloseTo(100_000_000, -2);
    expect(q4.endingPar).toBeCloseTo(0, -2);
    // No orphan par in subsequent periods
    for (const p of result.periods.filter(p => p.periodNum > 4)) {
      expect(p.beginningPar).toBeCloseTo(0, -2);
    }
  });

  it("surviving par at maturity reflects defaults (not original par)", () => {
    // Single loan, high CDR, matures Q8
    const loans = [{ parBalance: 100_000_000, maturityDate: addQuartersHelper("2026-03-09", 8), ratingBucket: "CCC", spreadBps: 375 }];
    const rates = { ...Object.fromEntries(RATING_BUCKETS.map(b => [b, 0])), CCC: 10.28 };
    const result = runProjection(makeInputs({
      loans,
      defaultRatesByRating: rates,
      cprPct: 0,
      reinvestmentPeriodEnd: null,
    }));
    const q8 = result.periods.find(p => p.periodNum === 8)!;
    // Maturity should be less than 100M (defaults eroded it)
    expect(q8.scheduledMaturities).toBeLessThan(100_000_000);
    expect(q8.scheduledMaturities).toBeGreaterThan(0);
    // After maturity, zero par
    expect(q8.endingPar).toBeCloseTo(0, -2);
  });

  it("different ratings produce different default amounts", () => {
    const loansB = [{ parBalance: 100_000_000, maturityDate: addQuartersHelper("2026-03-09", 20), ratingBucket: "B", spreadBps: 375 }];
    const loansBB = [{ parBalance: 100_000_000, maturityDate: addQuartersHelper("2026-03-09", 20), ratingBucket: "BB", spreadBps: 375 }];
    const resultB = runProjection(makeInputs({ loans: loansB, cprPct: 0, reinvestmentPeriodEnd: null }));
    const resultBB = runProjection(makeInputs({ loans: loansBB, cprPct: 0, reinvestmentPeriodEnd: null }));
    // B-rated should have more defaults than BB-rated
    const totalDefaultsB = resultB.periods.reduce((s, p) => s + p.defaults, 0);
    const totalDefaultsBB = resultBB.periods.reduce((s, p) => s + p.defaults, 0);
    expect(totalDefaultsB).toBeGreaterThan(totalDefaultsBB);
  });

  it("defaultsByRating is populated in PeriodResult", () => {
    const result = runProjection(makeInputs());
    const q1 = result.periods[0];
    expect(q1.defaultsByRating).toBeDefined();
    expect(q1.defaultsByRating["B"]).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Preserve existing test scenarios (adapted to new input shape)**

Rewrite existing test blocks to use the new `makeInputs` shape. Key scenarios to preserve:
- Par declines over time due to defaults and prepayments
- Generates equity distributions
- Zero defaults and zero CPR keeps par stable during RP
- Reinvests during RP, does not reinvest post-RP
- Tracks tranche payoff quarters
- High defaults trigger OC failure and cut equity distributions
- OC failure diverts interest to principal paydown
- IC ratio uses post-fee interest
- endingPar is zero in the final period after liquidation
- CDR/CPR >= 100% guard (no NaN)
- OC failure causes junior tranche interest shortfall
- Recovery pipeline accelerates pending recoveries in final period

For each: replace `cdrPct` with appropriate `defaultRatesByRating` (use "Set all to X%" pattern by setting every bucket to the same rate), replace `maturitySchedule` with `loans` array.

- [ ] **Step 4: Run all tests**

Run: `cd web && npx vitest run lib/clo/__tests__/projection.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add web/lib/clo/__tests__/projection.test.ts
git commit -m "test(clo): rewrite projection tests for per-loan model"
```

---

## Chunk 2: UI Changes

### Task 5: Update ProjectionModel.tsx — build loans array from holdings

**Files:**
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx`

- [ ] **Step 1: Add import for rating mapping**

```typescript
import { mapToRatingBucket, DEFAULT_RATES_BY_RATING, RATING_BUCKETS, type RatingBucket } from "@/lib/clo/rating-mapping";
import type { LoanInput } from "@/lib/clo/projection";
```

- [ ] **Step 2: Replace CDR state with per-rating state**

Replace `const [cdrPct, setCdrPct] = useState(2);` with:

```typescript
const [defaultRates, setDefaultRates] = useState<Record<string, number>>({ ...DEFAULT_RATES_BY_RATING });
```

- [ ] **Step 3: Build loans array from holdings (with edge case handling)**

Add a `useMemo` that converts holdings to `LoanInput[]`:

```typescript
const loanInputs: LoanInput[] = useMemo(() => {
  const fallbackMaturity = maturityDate ?? addQuarters(new Date().toISOString().slice(0, 10), 40);
  return holdings
    .filter((h) => h.parBalance && h.parBalance > 0 && !h.isDefaulted)
    .map((h) => ({
      parBalance: h.parBalance!,
      maturityDate: h.maturityDate ?? fallbackMaturity,
      ratingBucket: mapToRatingBucket(h.moodysRating, h.spRating, h.fitchRating, h.compositeRating),
      spreadBps: h.spreadBps ?? (poolSummary?.wacSpread ? (poolSummary.wacSpread < 20 ? poolSummary.wacSpread * 100 : poolSummary.wacSpread) : 0),
    }));
}, [holdings, maturityDate, poolSummary]);
```

Note: the `addQuarters` function needs to be imported from projection.ts or duplicated. Since it's a private function in projection.ts, export it.

- [ ] **Step 4: Update the `inputs` useMemo**

Replace `cdrPct` and `maturitySchedule` references with the new fields:

```typescript
const inputs: ProjectionInputs = useMemo(
  () => ({
    // ... all existing fields except cdrPct and maturitySchedule ...
    loans: loanInputs,
    defaultRatesByRating: defaultRates,
    // ... cprPct, recoveryPct, etc. unchanged ...
  }),
  [/* update dependency array to include loanInputs, defaultRates instead of cdrPct */]
);
```

- [ ] **Step 5: Update `handleApplyAssumptions`**

The callback currently sets `cdrPct`. Change it to set a uniform rate across all buckets:

```typescript
const handleApplyAssumptions = (assumptions: {
  cdrPct: number;
  cprPct: number;
  recoveryPct: number;
  recoveryLagMonths: number;
  reinvestmentSpreadBps: number;
}) => {
  // Apply uniform CDR from AI suggestion to all rating buckets
  const uniform: Record<string, number> = {};
  for (const bucket of RATING_BUCKETS) {
    uniform[bucket] = assumptions.cdrPct;
  }
  setDefaultRates(uniform);
  setCprPct(assumptions.cprPct);
  setRecoveryPct(assumptions.recoveryPct);
  setRecoveryLagMonths(assumptions.recoveryLagMonths);
  setReinvestmentSpreadBps(assumptions.reinvestmentSpreadBps);
};
```

- [ ] **Step 6: Commit**

```bash
git add web/lib/clo/projection.ts web/app/clo/waterfall/ProjectionModel.tsx
git commit -m "feat(clo): wire up per-loan inputs from holdings in ProjectionModel"
```

### Task 6: Replace CDR slider with per-rating default panel

**Files:**
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx`

- [ ] **Step 1: Add rating distribution summary**

Compute and display the par breakdown by rating bucket:

```typescript
const ratingDistribution = useMemo(() => {
  const dist: Record<string, { count: number; par: number }> = {};
  for (const bucket of RATING_BUCKETS) {
    dist[bucket] = { count: 0, par: 0 };
  }
  for (const loan of loanInputs) {
    const b = loan.ratingBucket as RatingBucket;
    if (dist[b]) {
      dist[b].count++;
      dist[b].par += loan.parBalance;
    }
  }
  return dist;
}, [loanInputs]);

const weightedAvgCdr = useMemo(() => {
  const totalPar = loanInputs.reduce((s, l) => s + l.parBalance, 0);
  if (totalPar === 0) return 0;
  return loanInputs.reduce((s, l) => s + l.parBalance * (defaultRates[l.ratingBucket] ?? 0), 0) / totalPar;
}, [loanInputs, defaultRates]);
```

- [ ] **Step 2: Replace the CDR SliderInput with a collapsible per-rating panel**

Remove the CDR slider line. Add in its place a collapsible section:

```tsx
{/* Default Rates by Rating — replaces single CDR slider */}
<div style={{ gridColumn: "1 / -1" }}>
  <DefaultRatePanel
    defaultRates={defaultRates}
    onChange={setDefaultRates}
    ratingDistribution={ratingDistribution}
    weightedAvgCdr={weightedAvgCdr}
  />
</div>
```

- [ ] **Step 3: Create the `DefaultRatePanel` component**

Add at the bottom of ProjectionModel.tsx (before the closing of the file):

```tsx
function DefaultRatePanel({
  defaultRates,
  onChange,
  ratingDistribution,
  weightedAvgCdr,
}: {
  defaultRates: Record<string, number>;
  onChange: (rates: Record<string, number>) => void;
  ratingDistribution: Record<string, { count: number; par: number }>;
  weightedAvgCdr: number;
}) {
  const [open, setOpen] = useState(true);
  const [uniformInput, setUniformInput] = useState("");

  const applyUniform = () => {
    const val = parseFloat(uniformInput);
    if (!isNaN(val) && val >= 0) {
      const rates: Record<string, number> = {};
      for (const bucket of RATING_BUCKETS) rates[bucket] = val;
      onChange(rates);
      setUniformInput("");
    }
  };

  const totalPar = Object.values(ratingDistribution).reduce((s, d) => s + d.par, 0);

  return (
    <div
      style={{
        border: "1px solid var(--color-border-light)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-surface)",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0.6rem 0.8rem",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "0.75rem",
          color: "var(--color-text-secondary)",
          textAlign: "left",
          fontFamily: "var(--font-body)",
        }}
      >
        <span>
          <span style={{ fontSize: "0.65rem", marginRight: "0.3rem" }}>{open ? "▾" : "▸"}</span>
          Default Rates by Rating
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
          Wtd Avg: {weightedAvgCdr.toFixed(2)}%
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          {/* Set all override */}
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem", paddingBottom: "0.5rem", borderBottom: "1px solid var(--color-border-light)" }}>
            <label style={{ fontSize: "0.7rem", color: "var(--color-text-muted)" }}>Set all to:</label>
            <input
              type="number"
              value={uniformInput}
              onChange={(e) => setUniformInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyUniform()}
              placeholder="%"
              style={{
                width: "4rem",
                padding: "0.25rem 0.4rem",
                fontSize: "0.75rem",
                fontFamily: "var(--font-mono)",
                border: "1px solid var(--color-border-light)",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-bg)",
              }}
            />
            <button
              onClick={applyUniform}
              style={{
                padding: "0.25rem 0.5rem",
                fontSize: "0.7rem",
                background: "var(--color-surface-alt)",
                border: "1px solid var(--color-border-light)",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}
            >
              Apply
            </button>
          </div>

          {/* Per-rating sliders */}
          {RATING_BUCKETS.filter(b => ratingDistribution[b]?.par > 0 || b === "NR").map((bucket) => {
            const dist = ratingDistribution[bucket];
            const parPct = totalPar > 0 ? (dist.par / totalPar) * 100 : 0;
            return (
              <div key={bucket} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.3rem 0" }}>
                <div style={{ width: "2.5rem", fontSize: "0.72rem", fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
                  {bucket}
                </div>
                <div style={{ width: "4rem", fontSize: "0.65rem", color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                  {dist.count > 0 ? `${dist.count} · ${parPct.toFixed(0)}%` : "—"}
                </div>
                <input
                  type="range"
                  className="wf-slider"
                  min={0}
                  max={20}
                  step={0.1}
                  value={defaultRates[bucket] ?? 0}
                  onChange={(e) => onChange({ ...defaultRates, [bucket]: parseFloat(e.target.value) })}
                  style={{ flex: 1 }}
                />
                <span style={{ width: "3rem", textAlign: "right", fontSize: "0.72rem", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                  {(defaultRates[bucket] ?? 0).toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Update `MODEL_ASSUMPTIONS` array**

Replace the existing "Quarterly periodicity" and other entries as needed. Update the "Loan maturities from portfolio" entry:

```typescript
{
  label: "Per-loan default model",
  detail: "Each loan is modeled individually with a rating-based annual default rate. Defaults reduce a loan's expected surviving par each quarter. At maturity, only the surviving portion exits the pool.",
},
```

- [ ] **Step 5: Type check and build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: Clean compile, successful build

- [ ] **Step 6: Commit**

```bash
git add web/app/clo/waterfall/ProjectionModel.tsx
git commit -m "feat(clo): add per-rating default rate panel and rating distribution UI"
```

### Task 7: Export `addQuarters` and final cleanup

**Files:**
- Modify: `web/lib/clo/projection.ts`

- [ ] **Step 1: Export `addQuarters` and `quartersBetween`**

These are currently private functions. The UI needs `addQuarters` for the fallback maturity calculation, and tests use `quartersBetween` implicitly. Add `export` to both:

```typescript
export function quartersBetween(startIso: string, endIso: string): number {
export function addQuarters(dateIso: string, quarters: number): string {
```

- [ ] **Step 2: Remove the `addQuartersHelper` from test file**

It duplicates `addQuarters`. Import from projection instead:

```typescript
import { ..., addQuarters } from "../projection";
// Remove the addQuartersHelper function at the bottom of the test file
// Replace all addQuartersHelper calls with addQuarters
```

- [ ] **Step 3: Run full test suite and build**

Run: `cd web && npx vitest run lib/clo/ && npx tsc --noEmit && npm run build`
Expected: ALL PASS, clean compile, successful build

- [ ] **Step 4: Commit**

```bash
git add web/lib/clo/projection.ts web/lib/clo/__tests__/projection.test.ts web/lib/clo/__tests__/rating-mapping.test.ts
git commit -m "chore(clo): export date helpers, remove test duplication"
```
