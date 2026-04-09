# CLO Data Layer Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate fragility in the CLO extraction → storage → model pipeline by validating at ingestion, resolving once, and showing what the model sees.

**Architecture:** Four layers — (1) ingestion validation gate normalizes LLM output at write time, (2) canonical resolver produces `ResolvedDealData` from all raw sources, (3) Context Editor shows resolved values with source indicators, (4) ProjectionModel becomes a thin mapping from resolved data to projection inputs.

**Tech Stack:** TypeScript, React, Next.js (existing codebase patterns)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `web/lib/clo/resolver-types.ts` | Create | All resolved data types (`ResolvedDealData`, `ResolvedTranche`, etc.) |
| `web/lib/clo/ingestion-gate.ts` | Create | Validate + normalize extraction output at write time |
| `web/lib/clo/resolver.ts` | Create | Canonical resolver: raw data → `ResolvedDealData` |
| `web/lib/clo/types.ts` | Modify | Drop `spread` string from `CapitalStructureEntry` |
| `web/lib/clo/extraction/runner.ts` | Modify | Call ingestion gate before DB writes |
| `web/app/clo/waterfall/page.tsx` | Modify | Call resolver, pass `ResolvedDealData` to components |
| `web/app/clo/waterfall/ProjectionModel.tsx` | Modify | Delete data assembly, consume `ResolvedDealData` |
| `web/app/clo/context/ContextEditor.tsx` | Modify | Show resolved values, warnings panel, source badges |

---

### Task 1: Create Resolved Types

**Files:**
- Create: `web/lib/clo/resolver-types.ts`

- [ ] **Step 1: Create the resolved types file**

```typescript
// web/lib/clo/resolver-types.ts

export interface ResolvedDealData {
  tranches: ResolvedTranche[];
  poolSummary: ResolvedPool;
  ocTriggers: ResolvedTrigger[];
  icTriggers: ResolvedTrigger[];
  dates: ResolvedDates;
  fees: ResolvedFees;
  loans: ResolvedLoan[];
}

export type ResolvedSource = "db_tranche" | "ppm" | "snapshot" | "manual";

export interface ResolvedTranche {
  className: string;
  currentBalance: number;
  originalBalance: number;
  spreadBps: number;
  seniorityRank: number;
  isFloating: boolean;
  isIncomeNote: boolean;
  isDeferrable: boolean;
  isAmortising: boolean;
  amortisationPerPeriod: number | null;
  source: ResolvedSource;
}

export interface ResolvedPool {
  totalPar: number;
  wacSpreadBps: number;
  warf: number;
  walYears: number;
  diversityScore: number;
  numberOfObligors: number;
}

export interface ResolvedTrigger {
  className: string;
  triggerLevel: number;
  rank: number;
  testType: "OC" | "IC";
  source: "compliance" | "ppm";
}

export interface ResolvedDates {
  maturity: string;
  reinvestmentPeriodEnd: string | null;
  nonCallPeriodEnd: string | null;
  firstPaymentDate: string | null;
  currentDate: string;
}

export interface ResolvedFees {
  seniorFeePct: number;
  subFeePct: number;
}

export interface ResolvedLoan {
  parBalance: number;
  maturityDate: string;
  ratingBucket: string;
  spreadBps: number;
}

export type WarningSeverity = "info" | "warn" | "error";

export interface ResolutionWarning {
  field: string;
  message: string;
  severity: WarningSeverity;
  resolvedFrom?: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface Fix {
  field: string;
  message: string;
  before: unknown;
  after: unknown;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: Clean output, no errors

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/resolver-types.ts
git commit -m "feat: add resolved deal data types for canonical resolver"
```

---

### Task 2: Create Ingestion Gate

**Files:**
- Create: `web/lib/clo/ingestion-gate.ts`

- [ ] **Step 1: Create the ingestion gate with spread parsing and normalization**

```typescript
// web/lib/clo/ingestion-gate.ts

import type { ExtractedConstraints, CapitalStructureEntry } from "./types";
import type { ValidationError, Fix } from "./resolver-types";

// Parse spread from various string formats → bps number
export function parseSpreadToBps(spreadBps: number | undefined | null, spreadStr: string | undefined | null): number | null {
  if (spreadBps != null && spreadBps > 0) return spreadBps;
  if (!spreadStr) return null;

  // "EURIBOR + 1.47%", "5.50% fixed", "0.50%"
  const pctMatch = spreadStr.match(/([\d.]+)\s*%/);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    if (pct > 0) return Math.round(pct * 100);
  }

  // "150bps", "150 bps"
  const bpsMatch = spreadStr.match(/([\d.]+)\s*bps/i);
  if (bpsMatch) return Math.round(parseFloat(bpsMatch[1]));

  // Plain number: treat as bps if >= 1
  const plain = parseFloat(spreadStr);
  if (!isNaN(plain) && plain > 0) {
    return plain >= 1 ? Math.round(plain) : Math.round(plain * 10000);
  }

  return null;
}

// Normalize a single compliance test testType to canonical enum
function normalizeTestType(testType: string | null, testName: string | null): string | null {
  if (testType === "OC_PAR" || testType === "OC_MV" || testType === "IC") return testType;
  const name = (testName ?? "").toLowerCase();
  if (name.includes("par value") || name.includes("overcollateral") || (name.includes("oc") && name.includes("ratio"))) return "OC_PAR";
  if (name.includes("interest coverage") || (name.includes("ic") && name.includes("ratio"))) return "IC";
  if (testType && testType.toLowerCase().includes("oc")) return "OC_PAR";
  if (testType && testType.toLowerCase().includes("ic")) return "IC";
  return testType;
}

// Fix string "null" → actual null for any string field
function fixStringNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result = { ...obj };
  for (const [key, value] of Object.entries(result)) {
    if (value === "null" || value === "NULL" || value === "undefined") {
      result[key] = null;
    }
  }
  return result;
}

export function validateAndNormalizeConstraints(
  raw: ExtractedConstraints
): { ok: true; data: ExtractedConstraints; fixes: Fix[] } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const fixes: Fix[] = [];
  const data = structuredClone(raw);

  // --- Fix string nulls in keyDates ---
  if (data.keyDates) {
    const fixed = fixStringNulls(data.keyDates as unknown as Record<string, unknown>);
    data.keyDates = fixed as typeof data.keyDates;
  }

  // --- Normalize capital structure spreads ---
  const capStruct = data.capitalStructure ?? [];
  if (capStruct.length === 0) {
    errors.push({ field: "capitalStructure", message: "Capital structure has zero tranches" });
  }

  for (const entry of capStruct) {
    const isSubordinated = entry.isSubordinated ?? entry.class.toLowerCase().includes("sub");
    if (isSubordinated) continue;

    const resolved = parseSpreadToBps(entry.spreadBps, entry.spread);
    if (resolved == null) {
      errors.push({
        field: `${entry.class}.spreadBps`,
        message: `No spread found for ${entry.class} — neither spreadBps (${entry.spreadBps}) nor spread string ("${entry.spread}") could be parsed`,
      });
    } else if (resolved !== entry.spreadBps) {
      fixes.push({
        field: `${entry.class}.spreadBps`,
        message: `Resolved spreadBps from spread string "${entry.spread}"`,
        before: entry.spreadBps,
        after: resolved,
      });
      entry.spreadBps = resolved;
    }
  }

  // --- Check maturity date ---
  const maturity = data.keyDates?.maturityDate;
  if (!maturity) {
    // Check if any tranche has a maturityDate
    const trancheMaturity = capStruct.find(e => e.maturityDate)?.maturityDate;
    if (!trancheMaturity) {
      errors.push({ field: "keyDates.maturityDate", message: "No maturity date found in key dates or tranche entries" });
    }
  }

  // --- Normalize coverage test triggers ---
  for (const entry of data.coverageTestEntries ?? []) {
    if (entry.parValueRatio == null && entry.interestCoverageRatio == null) {
      errors.push({
        field: `coverageTest.${entry.class}`,
        message: `Coverage test for ${entry.class} has no trigger level`,
      });
    }
  }

  // --- Normalize wacSpread to bps if present in any pool-adjacent data ---
  // (This applies when constraints carry pool data, rare but possible)

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data, fixes };
}

export function normalizeComplianceTestType(
  tests: Array<{ testType: string | null; testName: string; isPassing: boolean | null; actualValue: number | null; triggerLevel: number | null }>
): { tests: typeof tests; fixes: Fix[] } {
  const fixes: Fix[] = [];
  for (const test of tests) {
    const normalized = normalizeTestType(test.testType, test.testName);
    if (normalized !== test.testType) {
      fixes.push({
        field: `complianceTest.${test.testName}.testType`,
        message: `Normalized testType from "${test.testType}" to "${normalized}"`,
        before: test.testType,
        after: normalized,
      });
      test.testType = normalized;
    }

    // Compute isPassing if missing
    if (test.isPassing == null && test.actualValue != null && test.triggerLevel != null) {
      const passing = test.actualValue >= test.triggerLevel;
      fixes.push({
        field: `complianceTest.${test.testName}.isPassing`,
        message: `Computed isPassing=${passing} from actual ${test.actualValue} vs trigger ${test.triggerLevel}`,
        before: null,
        after: passing,
      });
      test.isPassing = passing;
    }
  }
  return { tests, fixes };
}

// Normalize wacSpread: values < 20 are likely percentages, convert to bps
export function normalizeWacSpread(value: number | null): { bps: number; fix: Fix | null } {
  if (value == null) return { bps: 0, fix: null };
  if (value < 20) {
    return {
      bps: Math.round(value * 100),
      fix: {
        field: "poolSummary.wacSpread",
        message: `Converted wacSpread from percentage (${value}) to bps (${Math.round(value * 100)})`,
        before: value,
        after: Math.round(value * 100),
      },
    };
  }
  return { bps: Math.round(value), fix: null };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: Clean output, no errors

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/ingestion-gate.ts
git commit -m "feat: add ingestion validation gate for CLO extraction normalization"
```

---

### Task 3: Create Canonical Resolver

**Files:**
- Create: `web/lib/clo/resolver.ts`

- [ ] **Step 1: Create the resolver with all precedence logic**

```typescript
// web/lib/clo/resolver.ts

import type { ExtractedConstraints, CloPoolSummary, CloComplianceTest, CloTranche, CloTrancheSnapshot, CloHolding } from "./types";
import type { ResolvedDealData, ResolvedTranche, ResolvedPool, ResolvedTrigger, ResolvedDates, ResolvedFees, ResolvedLoan, ResolutionWarning } from "./resolver-types";
import { parseSpreadToBps, normalizeWacSpread } from "./ingestion-gate";
import { mapToRatingBucket } from "./rating-mapping";

function normClass(s: string): string {
  return s.replace(/^class\s+/i, "").replace(/\s+notes?$/i, "").trim().toLowerCase();
}

function parseAmount(s: string | undefined | null): number {
  if (!s) return 0;
  return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
}

function isOcTest(t: { testType?: string | null; testName?: string | null }): boolean {
  if (t.testType === "OC_PAR" || t.testType === "OC_MV") return true;
  const name = (t.testName ?? "").toLowerCase();
  return name.includes("overcollateral") || name.includes("par value") || (name.includes("oc") && name.includes("ratio"));
}

function isIcTest(t: { testType?: string | null; testName?: string | null }): boolean {
  if (t.testType === "IC") return true;
  const name = (t.testName ?? "").toLowerCase();
  return name.includes("interest coverage") || (name.includes("ic") && name.includes("ratio"));
}

function dedupTriggers(triggers: { className: string; triggerLevel: number }[]): { className: string; triggerLevel: number }[] {
  const byClass = new Map<string, { className: string; triggerLevel: number }>();
  for (const t of triggers) {
    const existing = byClass.get(t.className);
    if (!existing || t.triggerLevel > existing.triggerLevel) {
      byClass.set(t.className, t);
    }
  }
  return Array.from(byClass.values());
}

function resolveTranches(
  constraints: ExtractedConstraints,
  dbTranches: CloTranche[],
  snapshots: CloTrancheSnapshot[],
  warnings: ResolutionWarning[],
): ResolvedTranche[] {
  const snapshotByTrancheId = new Map(snapshots.map(s => [s.trancheId, s]));
  const classXAmort = constraints.dealSizing?.classXAmortisation;
  const classXAmortPerPeriod = classXAmort ? parseAmount(classXAmort) : null;

  // Build PPM spread lookup
  const ppmSpreadByClass = new Map<string, number>();
  const ppmBalanceByClass = new Map<string, number>();
  const ppmDeferrableByClass = new Map<string, boolean>();
  const ppmSubByClass = new Map<string, boolean>();

  for (const e of constraints.capitalStructure ?? []) {
    const key = normClass(e.class);
    const bps = parseSpreadToBps(e.spreadBps, e.spread);
    if (bps != null && bps > 0) ppmSpreadByClass.set(key, bps);
    ppmBalanceByClass.set(key, parseAmount(e.principalAmount));
    if (e.deferrable != null) ppmDeferrableByClass.set(key, e.deferrable);
    ppmSubByClass.set(key, e.isSubordinated ?? e.class.toLowerCase().includes("sub"));
  }

  // If DB tranches exist, use them as the primary source
  if (dbTranches.length > 0) {
    return dbTranches
      .sort((a, b) => (a.seniorityRank ?? 99) - (b.seniorityRank ?? 99))
      .map(t => {
        const snap = snapshotByTrancheId.get(t.id);
        const key = normClass(t.className);
        const isClassX = /^(class\s+)?x$/i.test(t.className.trim());
        const isSub = t.isIncomeNote ?? t.isSubordinate ?? ppmSubByClass.get(key) ?? t.className.toLowerCase().includes("sub");

        let spreadBps = t.spreadBps ?? ppmSpreadByClass.get(key) ?? 0;
        if (spreadBps === 0 && !isSub) {
          warnings.push({
            field: `${t.className}.spreadBps`,
            message: `No spread found for ${t.className} in DB or PPM constraints`,
            severity: "error",
          });
        }
        if (t.spreadBps == null && ppmSpreadByClass.has(key)) {
          warnings.push({
            field: `${t.className}.spreadBps`,
            message: `Using PPM spread (${ppmSpreadByClass.get(key)} bps) — DB tranche has null`,
            severity: "info",
            resolvedFrom: "ppm_constraints",
          });
        }

        return {
          className: t.className,
          currentBalance: snap?.currentBalance ?? t.originalBalance ?? ppmBalanceByClass.get(key) ?? 0,
          originalBalance: t.originalBalance ?? ppmBalanceByClass.get(key) ?? 0,
          spreadBps,
          seniorityRank: t.seniorityRank ?? 99,
          isFloating: t.isFloating ?? true,
          isIncomeNote: isSub,
          isDeferrable: t.isDeferrable ?? ppmDeferrableByClass.get(key) ?? false,
          isAmortising: isClassX,
          amortisationPerPeriod: isClassX ? (classXAmortPerPeriod ?? null) : null,
          source: snap ? "snapshot" as const : "db_tranche" as const,
        };
      });
  }

  // Fallback: build from PPM capital structure
  const entries = constraints.capitalStructure ?? [];
  const byClass = new Map<string, typeof entries[number]>();
  for (const e of entries) {
    const existing = byClass.get(e.class);
    if (!existing || (parseAmount(e.principalAmount) > 0 && (!existing.principalAmount || parseAmount(existing.principalAmount) === 0))) {
      byClass.set(e.class, e);
    }
  }

  return Array.from(byClass.values()).map((e, idx) => {
    const isSub = e.isSubordinated ?? e.class.toLowerCase().includes("sub");
    const isFloating = e.rateType?.toLowerCase().includes("float") ??
      (e.spread?.toLowerCase().includes("euribor") || e.spread?.toLowerCase().includes("sofr") || false);
    const isClassX = /^(class\s+)?x$/i.test(e.class.trim());
    const spreadBps = parseSpreadToBps(e.spreadBps, e.spread) ?? 0;

    if (spreadBps === 0 && !isSub) {
      warnings.push({
        field: `${e.class}.spreadBps`,
        message: `No spread found for ${e.class} in PPM constraints`,
        severity: "error",
      });
    }

    return {
      className: e.class,
      currentBalance: parseAmount(e.principalAmount),
      originalBalance: parseAmount(e.principalAmount),
      spreadBps,
      seniorityRank: idx + 1,
      isFloating,
      isIncomeNote: isSub,
      isDeferrable: e.deferrable ?? false,
      isAmortising: isClassX,
      amortisationPerPeriod: isClassX ? (classXAmortPerPeriod ?? null) : null,
      source: "ppm" as const,
    };
  });
}

function resolveTriggers(
  complianceTests: CloComplianceTest[],
  constraints: ExtractedConstraints,
  resolvedTranches: ResolvedTranche[],
  warnings: ResolutionWarning[],
): { oc: ResolvedTrigger[]; ic: ResolvedTrigger[] } {
  // Resolve a class name (possibly compound like "A/B") to its most junior seniority rank
  function resolveRank(cls: string): number {
    const parts = cls.split("/").map(s => s.trim());
    let maxRank = 0;
    for (const part of parts) {
      const base = part.replace(/-RR$/i, "").trim();
      const exact = resolvedTranches.find(t => normClass(t.className) === normClass(base));
      if (exact) { maxRank = Math.max(maxRank, exact.seniorityRank); continue; }
      const prefix = resolvedTranches.filter(t =>
        normClass(t.className).startsWith(normClass(base)) || normClass(t.className).startsWith(base.toLowerCase())
      );
      if (prefix.length > 0) { maxRank = Math.max(maxRank, ...prefix.map(t => t.seniorityRank)); continue; }
    }
    return maxRank || 99;
  }

  // From compliance tests
  const ocFromTests = complianceTests
    .filter(t => isOcTest(t) && t.triggerLevel != null && t.testClass)
    .map(t => ({ className: t.testClass!, triggerLevel: t.triggerLevel! }));
  const icFromTests = complianceTests
    .filter(t => isIcTest(t) && t.triggerLevel != null && t.testClass)
    .map(t => ({ className: t.testClass!, triggerLevel: t.triggerLevel! }));

  // From PPM constraints (fallback)
  const ocFromPpm = (constraints.coverageTestEntries ?? [])
    .filter(e => e.class && e.parValueRatio && parseFloat(e.parValueRatio))
    .map(e => ({ className: e.class!, triggerLevel: parseFloat(e.parValueRatio!) }));
  const icFromPpm = (constraints.coverageTestEntries ?? [])
    .filter(e => e.class && e.interestCoverageRatio && parseFloat(e.interestCoverageRatio))
    .map(e => ({ className: e.class!, triggerLevel: parseFloat(e.interestCoverageRatio!) }));

  const ocRaw = ocFromTests.length > 0 ? ocFromTests : ocFromPpm;
  const icRaw = icFromTests.length > 0 ? icFromTests : icFromPpm;
  const ocSource = ocFromTests.length > 0 ? "compliance" as const : "ppm" as const;
  const icSource = icFromTests.length > 0 ? "compliance" as const : "ppm" as const;

  if (ocRaw.length === 0) {
    warnings.push({ field: "ocTriggers", message: "No OC triggers found in compliance tests or PPM", severity: "warn" });
  }

  const oc: ResolvedTrigger[] = dedupTriggers(ocRaw).map(t => ({
    className: t.className,
    triggerLevel: t.triggerLevel,
    rank: resolveRank(t.className),
    testType: "OC" as const,
    source: ocSource,
  }));

  const ic: ResolvedTrigger[] = dedupTriggers(icRaw).map(t => ({
    className: t.className,
    triggerLevel: t.triggerLevel,
    rank: resolveRank(t.className),
    testType: "IC" as const,
    source: icSource,
  }));

  return { oc, ic };
}

function resolveFees(constraints: ExtractedConstraints, warnings: ResolutionWarning[]): ResolvedFees {
  let seniorFeePct = 0.15;
  let subFeePct = 0.25;

  for (const fee of constraints.fees ?? []) {
    const name = fee.name?.toLowerCase() ?? "";
    const rate = parseFloat(fee.rate ?? "");
    if (isNaN(rate)) continue;

    if (name.includes("senior") && name.includes("mgmt" || "management")) {
      seniorFeePct = rate;
    } else if (name.includes("sub") && name.includes("mgmt" || "management")) {
      subFeePct = rate;
    }
  }

  return { seniorFeePct, subFeePct };
}

export function resolveWaterfallInputs(
  constraints: ExtractedConstraints,
  complianceData: {
    poolSummary: CloPoolSummary | null;
    complianceTests: CloComplianceTest[];
    concentrations: unknown[];
  } | null,
  dbTranches: CloTranche[],
  trancheSnapshots: CloTrancheSnapshot[],
  holdings: CloHolding[],
  dealDates?: { maturity?: string | null; reinvestmentPeriodEnd?: string | null },
): { resolved: ResolvedDealData; warnings: ResolutionWarning[] } {
  const warnings: ResolutionWarning[] = [];

  // --- Tranches ---
  const tranches = resolveTranches(constraints, dbTranches, trancheSnapshots, warnings);

  // --- Pool Summary ---
  const pool = complianceData?.poolSummary;
  const { bps: wacSpreadBps, fix: wacFix } = normalizeWacSpread(pool?.wacSpread ?? null);
  if (wacFix) warnings.push({ field: wacFix.field, message: wacFix.message, severity: "info", resolvedFrom: `${wacFix.before} → ${wacFix.after}` });

  const poolSummary: ResolvedPool = {
    totalPar: pool?.totalPar ?? 0,
    wacSpreadBps,
    warf: pool?.warf ?? 0,
    walYears: pool?.walYears ?? 0,
    diversityScore: pool?.diversityScore ?? 0,
    numberOfObligors: pool?.numberOfObligors ?? 0,
  };

  if (poolSummary.totalPar === 0) {
    warnings.push({ field: "poolSummary.totalPar", message: "Total par is 0 — no pool summary data", severity: "error" });
  }

  // --- Triggers ---
  const { oc: ocTriggers, ic: icTriggers } = resolveTriggers(
    complianceData?.complianceTests ?? [],
    constraints,
    tranches,
    warnings,
  );

  // --- Dates ---
  const maturity = dealDates?.maturity ?? constraints.keyDates?.maturityDate ?? null;
  if (!maturity) {
    warnings.push({ field: "dates.maturity", message: "No maturity date found", severity: "error" });
  }

  const dates: ResolvedDates = {
    maturity: maturity ?? "2037-01-01",
    reinvestmentPeriodEnd: dealDates?.reinvestmentPeriodEnd ?? constraints.keyDates?.reinvestmentPeriodEnd ?? null,
    nonCallPeriodEnd: constraints.keyDates?.nonCallPeriodEnd ?? null,
    firstPaymentDate: constraints.keyDates?.firstPaymentDate ?? null,
    currentDate: new Date().toISOString().slice(0, 10),
  };

  // --- Fees ---
  const fees = resolveFees(constraints, warnings);

  // --- Loans ---
  const fallbackMaturity = maturity ?? "2037-01-01";
  const loans: ResolvedLoan[] = holdings
    .filter(h => h.parBalance != null && h.parBalance > 0 && !h.isDefaulted)
    .map(h => ({
      parBalance: h.parBalance!,
      maturityDate: h.maturityDate ?? fallbackMaturity,
      ratingBucket: mapToRatingBucket(h.moodysRating ?? null, h.spRating ?? null, h.fitchRating ?? null, h.compositeRating ?? null),
      spreadBps: h.spreadBps ?? wacSpreadBps,
    }));

  return {
    resolved: { tranches, poolSummary, ocTriggers, icTriggers, dates, fees, loans },
    warnings,
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: Clean output, no errors

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/resolver.ts
git commit -m "feat: add canonical resolver for CLO waterfall inputs"
```

---

### Task 4: Wire Resolver Into Waterfall Page

**Files:**
- Modify: `web/app/clo/waterfall/page.tsx`

- [ ] **Step 1: Import resolver and call it after data loading**

Add to the imports at top of `web/app/clo/waterfall/page.tsx`:
```typescript
import { resolveWaterfallInputs } from "@/lib/clo/resolver";
```

After the existing data loading (the `Promise.all` block that fetches tranches, snapshots, etc.), add the resolver call and pass `resolved` + `warnings` to the components. The exact location is after the `dealContext` object is assembled.

Add after `dealContext`:
```typescript
  const { resolved, warnings: resolutionWarnings } = resolveWaterfallInputs(
    constraints,
    periodData ? { poolSummary: periodData.poolSummary, complianceTests: periodData.complianceTests, concentrations: periodData.concentrations } : null,
    tranches,
    trancheSnapshots,
    holdings,
    { maturity: maturityDate, reinvestmentPeriodEnd },
  );
```

Update the ProjectionModel component props to pass `resolved` and `resolutionWarnings`. Keep the old props temporarily for backward compatibility — Task 5 will remove them.

Add these props to `<ProjectionModel>`:
```typescript
  resolved={resolved}
  resolutionWarnings={resolutionWarnings}
```

Similarly, pass them to ContextEditor if it's rendered on this page (it may be on a separate page — check and update accordingly).

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: Clean output, no errors (may have unused prop warnings which is fine)

- [ ] **Step 3: Commit**

```bash
git add web/app/clo/waterfall/page.tsx
git commit -m "feat: wire canonical resolver into waterfall page"
```

---

### Task 5: Simplify ProjectionModel to Consume Resolved Data

**Files:**
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx`

- [ ] **Step 1: Add `ResolvedDealData` to Props and create `buildProjectionInputs`**

Add to the Props interface:
```typescript
  resolved?: ResolvedDealData;
  resolutionWarnings?: ResolutionWarning[];
```

Add import:
```typescript
import type { ResolvedDealData, ResolutionWarning } from "@/lib/clo/resolver-types";
```

Add the clean mapping function inside the component (or above it):
```typescript
function buildFromResolved(
  resolved: ResolvedDealData,
  userAssumptions: {
    baseRatePct: number;
    defaultRates: Record<string, number>;
    cprPct: number;
    recoveryPct: number;
    recoveryLagMonths: number;
    reinvestmentSpreadBps: number;
    reinvestmentTenorYears: number;
    reinvestmentRating: string | null;
    cccBucketLimitPct: number;
    cccMarketValuePct: number;
    deferredInterestCompounds: boolean;
  },
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

- [ ] **Step 2: Replace the `inputs` useMemo to use `buildFromResolved` when `resolved` is available**

Replace the existing `inputs` useMemo (the one that builds `ProjectionInputs`) with:
```typescript
  const inputs: ProjectionInputs = useMemo(() => {
    if (resolved) {
      return buildFromResolved(resolved, {
        baseRatePct,
        defaultRates: defaultRates,
        cprPct,
        recoveryPct,
        recoveryLagMonths,
        reinvestmentSpreadBps,
        reinvestmentTenorYears,
        reinvestmentRating: reinvestmentRating === "auto" ? null : reinvestmentRating,
        cccBucketLimitPct,
        cccMarketValuePct,
        deferredInterestCompounds: constraints.interestMechanics?.deferredInterestCompounds ?? true,
      });
    }
    // Legacy fallback — keep old logic for backward compatibility until fully migrated
    return buildLegacyInputs();
  }, [resolved, baseRatePct, defaultRates, cprPct, recoveryPct, recoveryLagMonths,
      reinvestmentSpreadBps, reinvestmentTenorYears, reinvestmentRating,
      cccBucketLimitPct, cccMarketValuePct, constraints]);
```

Move the old inputs assembly into a `buildLegacyInputs()` function so it's preserved but isolated. This keeps the component working during the transition.

- [ ] **Step 3: Delete the old helper functions that are now in the resolver**

Remove these functions from ProjectionModel.tsx (they now live in resolver.ts or ingestion-gate.ts):
- `parseSpreadBps`
- `buildTranchesFromConstraints`
- `normClass` (if defined locally)

Keep `parseAmount` only if it's still used for non-resolver purposes (e.g., user input parsing).

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: Clean output, no errors

- [ ] **Step 5: Commit**

```bash
git add web/app/clo/waterfall/ProjectionModel.tsx
git commit -m "feat: simplify ProjectionModel to consume ResolvedDealData"
```

---

### Task 6: Update Context Editor to Show Resolved Data

**Files:**
- Modify: `web/app/clo/context/ContextEditor.tsx`

- [ ] **Step 1: Add resolver imports and resolved state**

Add imports:
```typescript
import { resolveWaterfallInputs } from "@/lib/clo/resolver";
import type { ResolvedDealData, ResolutionWarning } from "@/lib/clo/resolver-types";
```

Add new props to `ContextEditorProps`:
```typescript
  tranches?: CloTranche[];
  trancheSnapshots?: CloTrancheSnapshot[];
  holdings?: CloHolding[];
  dealDates?: { maturity?: string | null; reinvestmentPeriodEnd?: string | null };
```

Add resolved state inside the component:
```typescript
  const [resolved, setResolved] = useState<ResolvedDealData | null>(null);
  const [resolutionWarnings, setResolutionWarnings] = useState<ResolutionWarning[]>([]);

  // Re-resolve whenever raw data changes
  useEffect(() => {
    const { resolved: r, warnings: w } = resolveWaterfallInputs(
      constraints,
      complianceData ? { poolSummary: complianceData.poolSummary, complianceTests: complianceData.complianceTests, concentrations: complianceData.concentrations } : null,
      tranches ?? [],
      trancheSnapshots ?? [],
      holdings ?? [],
      dealDates,
    );
    setResolved(r);
    setResolutionWarnings(w);
  }, [constraints, complianceData, tranches, trancheSnapshots, holdings, dealDates]);
```

- [ ] **Step 2: Add warnings panel at the top of the return**

Insert right after the export/import buttons div:
```typescript
      {resolutionWarnings.length > 0 && (
        <div style={{
          marginBottom: "1rem",
          padding: "0.75rem 1rem",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)",
        }}>
          <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", fontWeight: 600 }}>
            Resolution Warnings ({resolutionWarnings.length})
          </h3>
          {resolutionWarnings.map((w, i) => (
            <div key={i} style={{
              fontSize: "0.8rem",
              padding: "0.25rem 0",
              color: w.severity === "error" ? "var(--color-error, #c00)"
                   : w.severity === "warn" ? "var(--color-warning, #a60)"
                   : "var(--color-text-muted)",
            }}>
              <strong>{w.field}:</strong> {w.message}
              {w.resolvedFrom && <span style={{ opacity: 0.7 }}> ({w.resolvedFrom})</span>}
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 3: Update capital structure table to show resolved spreadBps**

In the capital structure table, replace the spread column to show the resolved numeric value with a source badge. Find the `<td>` that renders `row.spread` and replace it with:

```typescript
                  <td style={tdStyle}>
                    {(() => {
                      const resolvedTranche = resolved?.tranches.find(t => normClass(t.className) === normClass(row.class));
                      if (resolvedTranche && !resolvedTranche.isIncomeNote) {
                        return (
                          <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            <InlineNumber
                              value={resolvedTranche.spreadBps}
                              onChange={(v) => {
                                updateCapStructRow(i, "spreadBps", v ?? 0);
                                updateCapStructRow(i, "spread", v != null ? `${v}bps` : "");
                              }}
                            />
                            <span style={{
                              fontSize: "0.65rem",
                              padding: "0.1rem 0.3rem",
                              borderRadius: "3px",
                              background: resolvedTranche.source === "ppm" ? "#e8f0fe" : resolvedTranche.source === "snapshot" ? "#e6f4ea" : "#fef7e0",
                              color: "#555",
                            }}>
                              {resolvedTranche.source}
                            </span>
                          </span>
                        );
                      }
                      return <span style={{ color: "var(--color-text-muted)" }}>—</span>;
                    })()}
                  </td>
```

Add `normClass` as a local helper (or import from resolver):
```typescript
function normClass(s: string): string {
  return s.replace(/^class\s+/i, "").replace(/\s+notes?$/i, "").trim().toLowerCase();
}
```

- [ ] **Step 4: Update JSON export to use resolved data**

Replace the `exportContext` function:
```typescript
  function exportContext() {
    const data = resolved
      ? { resolved, warnings: resolutionWarnings, raw: { constraints, fundProfile, complianceData } }
      : { constraints, fundProfile, complianceData };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "clo-context.json";
    a.click();
    URL.revokeObjectURL(url);
  }
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: Clean output, no errors

- [ ] **Step 6: Commit**

```bash
git add web/app/clo/context/ContextEditor.tsx
git commit -m "feat: context editor shows resolved values with source badges and warnings"
```

---

### Task 7: Wire Ingestion Gate Into Extraction Runner

**Files:**
- Modify: `web/lib/clo/extraction/runner.ts`

- [ ] **Step 1: Import and call the ingestion gate after PPM extraction**

Add import at top of runner.ts:
```typescript
import { validateAndNormalizeConstraints, normalizeComplianceTestType } from "../ingestion-gate";
```

Find where the extracted constraints are saved to the database (the line that does something like `UPDATE clo_profiles SET extracted_constraints = ...`). Before that write, add:

```typescript
    // Validate and normalize before saving
    const gateResult = validateAndNormalizeConstraints(extractedConstraints);
    if (!gateResult.ok) {
      console.error("[extraction] Ingestion validation failed:", gateResult.errors);
      // Still save but log the errors — don't block extraction entirely
      // The errors will surface in the Context Editor warnings panel
    } else {
      if (gateResult.fixes.length > 0) {
        console.log(`[extraction] Applied ${gateResult.fixes.length} normalizations:`,
          gateResult.fixes.map(f => f.message));
      }
      extractedConstraints = gateResult.data;
    }
```

- [ ] **Step 2: Add compliance test normalization after compliance extraction**

Find where compliance tests are normalized/written to DB. After the tests are extracted but before insert, add:

```typescript
    // Normalize test types
    const { fixes: testFixes } = normalizeComplianceTestType(complianceTests);
    if (testFixes.length > 0) {
      console.log(`[extraction] Normalized ${testFixes.length} compliance test fields:`,
        testFixes.map(f => f.message));
    }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd web && npx tsc --noEmit`
Expected: Clean output, no errors

- [ ] **Step 4: Commit**

```bash
git add web/lib/clo/extraction/runner.ts
git commit -m "feat: wire ingestion validation gate into extraction runner"
```

---

### Task 8: Clean Up Legacy Code

**Files:**
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx`
- Modify: `web/lib/clo/types.ts`

- [ ] **Step 1: Remove the legacy fallback from ProjectionModel**

Once the resolver path is confirmed working, remove the `buildLegacyInputs()` function and the conditional in the `inputs` useMemo. The `inputs` useMemo should now unconditionally use `buildFromResolved`. Also remove:
- `parseSpreadBps` function (now in ingestion-gate.ts)
- `buildTranchesFromConstraints` function (now in resolver.ts)
- The `normClass` local definition (now in resolver.ts)
- The old `trancheInputs` useMemo (replaced by `resolved.tranches`)
- The old `ocTriggersRaw` / `icTriggersRaw` useMemos (replaced by `resolved.ocTriggers/icTriggers`)
- The old `loanInputs` useMemo (replaced by `resolved.loans`)

- [ ] **Step 2: Verify TypeScript compiles and the waterfall still runs**

Run: `cd web && npx tsc --noEmit`
Expected: Clean output, no errors

Test manually: load the waterfall page, verify the projection runs and produces reasonable output.

- [ ] **Step 3: Commit**

```bash
git add web/app/clo/waterfall/ProjectionModel.tsx web/lib/clo/types.ts
git commit -m "refactor: remove legacy data assembly from ProjectionModel"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Full TypeScript compile check**

Run: `cd web && npx tsc --noEmit`
Expected: Clean output, no errors

- [ ] **Step 2: Manual end-to-end verification**

1. Load the Context Editor tab — verify warnings panel shows any resolution issues
2. Verify capital structure table shows numeric spreadBps with source badges
3. Export JSON — verify it contains `resolved` object with clean data
4. Load the waterfall tab — verify projection runs without "missing spread" error
5. Check that Class X is handled correctly (amortising from interest, excluded from OC denominators)

- [ ] **Step 3: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: complete CLO data layer hardening — canonical resolver pattern"
```
