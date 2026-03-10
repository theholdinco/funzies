# Waterfall O/C Test Fix & Projection Methodology — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the O/C test name mismatch bug so diversion actually gates cash flows, and add a methodology section to the waterfall page.

**Architecture:** The fix has two layers: (1) a mapping function in `ProjectionModel.tsx` that resolves OC/IC trigger class names to tranche seniority ranks before passing them to the engine, and (2) a change in `projection.ts` to gate on ranks instead of class names. The methodology is a new collapsible React component rendered on the waterfall page.

**Tech Stack:** TypeScript, React, Vitest, Next.js

---

### Task 1: Write failing tests for rank-based O/C gating

**Files:**
- Modify: `web/lib/clo/__tests__/projection.test.ts`

**Step 1: Write failing tests**

Add a new describe block to the test file. These tests use mismatched class names (trigger says `"A"` / `"B"`, tranches say `"Class A-1"` / `"Class A-2"` / `"Class B"`) with the new `rank` field on triggers — which the engine doesn't support yet.

```typescript
// ─── O/C test gating (rank-based) ─────────────────────────────────────────────

describe("runProjection — OC gating with rank-based triggers", () => {
  // Simulate production scenario: trigger classNames don't match tranche classNames
  // but ranks DO match, so gating should still work.
  const mismatchedInputs = (): ProjectionInputs =>
    makeInputs({
      tranches: [
        { className: "Class A-1", currentBalance: 40_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false },
        { className: "Class A-2", currentBalance: 25_000_000, spreadBps: 150, seniorityRank: 2, isFloating: true, isIncomeNote: false },
        { className: "Class B", currentBalance: 15_000_000, spreadBps: 250, seniorityRank: 3, isFloating: true, isIncomeNote: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 4, isFloating: false, isIncomeNote: true },
      ],
      ocTriggers: [
        { className: "A", triggerLevel: 120, rank: 2 },   // covers A-1 + A-2 (ranks ≤ 2)
        { className: "B", triggerLevel: 110, rank: 3 },   // covers A-1 + A-2 + B (ranks ≤ 3)
      ],
      icTriggers: [
        { className: "A", triggerLevel: 120, rank: 2 },
        { className: "B", triggerLevel: 110, rank: 3 },
      ],
    });

  it("OC test failure diverts interest away from equity", () => {
    // High defaults, no recovery → OC should fail → equity gets less
    const stressed = mismatchedInputs();
    stressed.cdrPct = 8;
    stressed.cprPct = 0;
    stressed.recoveryPct = 0;
    stressed.reinvestmentPeriodEnd = null;

    const noDefault = mismatchedInputs();
    noDefault.cdrPct = 0;
    noDefault.cprPct = 0;
    noDefault.recoveryPct = 0;
    noDefault.reinvestmentPeriodEnd = null;

    const stressedResult = runProjection(stressed);
    const baseResult = runProjection(noDefault);

    // With 8% CDR and no recovery, OC tests should fail at some point
    // and divert interest → equity gets significantly less
    expect(stressedResult.totalEquityDistributions).toBeLessThan(
      baseResult.totalEquityDistributions * 0.5
    );
  });

  it("OC failure shows as failing in period results", () => {
    const stressed = mismatchedInputs();
    stressed.cdrPct = 10;
    stressed.cprPct = 0;
    stressed.recoveryPct = 0;
    stressed.reinvestmentPeriodEnd = null;

    const result = runProjection(stressed);

    // At some point, OC tests should fail
    const anyOcFailing = result.periods.some((p) =>
      p.ocTests.some((t) => !t.passing)
    );
    expect(anyOcFailing).toBe(true);
  });

  it("diversion accelerates senior tranche payoff", () => {
    const stressed = mismatchedInputs();
    stressed.cdrPct = 8;
    stressed.cprPct = 0;
    stressed.recoveryPct = 0;
    stressed.reinvestmentPeriodEnd = null;

    const result = runProjection(stressed);

    // When OC fails, diverted interest pays down senior tranches faster
    // so Class A-1 should pay off before deal maturity even with no prepayments
    expect(result.tranchePayoffQuarter["Class A-1"]).not.toBeNull();
  });

  it("equity distributions are zero in periods after OC failure", () => {
    const stressed = mismatchedInputs();
    stressed.cdrPct = 10;
    stressed.cprPct = 0;
    stressed.recoveryPct = 0;
    stressed.reinvestmentPeriodEnd = null;

    const result = runProjection(stressed);

    // Find the first period where OC fails
    const firstFailIdx = result.periods.findIndex((p) =>
      p.ocTests.some((t) => !t.passing)
    );
    expect(firstFailIdx).toBeGreaterThan(-1);

    // From that period onward, equity distributions should be 0
    // (all interest diverted to principal)
    for (let i = firstFailIdx; i < result.periods.length; i++) {
      const p = result.periods[i];
      if (p.ocTests.some((t) => !t.passing)) {
        expect(p.equityDistribution).toBeCloseTo(0, 0);
      }
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run lib/clo/__tests__/projection.test.ts`
Expected: FAIL — `ProjectionInputs` type doesn't accept `rank` on triggers yet.

**Step 3: Commit**

```bash
git add web/lib/clo/__tests__/projection.test.ts
git commit -m "test: add failing tests for rank-based OC gating with mismatched class names"
```

---

### Task 2: Update projection engine to support rank-based O/C gating

**Files:**
- Modify: `web/lib/clo/projection.ts:4-18` (interfaces)
- Modify: `web/lib/clo/projection.ts:120-130` (trigger indexing)
- Modify: `web/lib/clo/projection.ts:246-284` (gating logic)

**Step 1: Update the OC/IC trigger interface**

In `ProjectionInputs`, change the trigger types to include an optional `rank` field:

```typescript
ocTriggers: { className: string; triggerLevel: number; rank?: number }[];
icTriggers: { className: string; triggerLevel: number; rank?: number }[];
```

The `rank` is optional for backward compatibility — existing tests that use matching class names still work. When `rank` is provided, the engine uses it for both the OC ratio calculation and the gating check. When not provided, it falls back to looking up the rank from `trancheRankMap` by class name (current behavior).

**Step 2: Update the trigger indexing (around line 121-130)**

Replace the current trigger indexing:

```typescript
// Before
const ocTriggersByClass = ocTriggers.map((oc) => ({
  ...oc,
  rank: trancheRankMap.get(oc.className) ?? 0,
}));
const icTriggersByClass = icTriggers.map((ic) => ({
  ...ic,
  rank: trancheRankMap.get(ic.className) ?? 0,
}));
```

With rank-aware indexing:

```typescript
const ocTriggersByClass = ocTriggers.map((oc) => ({
  ...oc,
  rank: oc.rank ?? trancheRankMap.get(oc.className) ?? 0,
}));
const icTriggersByClass = icTriggers.map((ic) => ({
  ...ic,
  rank: ic.rank ?? trancheRankMap.get(ic.className) ?? 0,
}));
```

**Step 3: Change the gating check from name-based to rank-based (around line 246-284)**

Replace:

```typescript
const failingOcClasses = new Set(ocResults.filter((r) => !r.passing).map((r) => r.className));
const failingIcClasses = new Set(icResults.filter((r) => !r.passing).map((r) => r.className));
```

With:

```typescript
// Build rank-based lookup: for each failing OC test, store the rank at which it failed.
// The gating check uses rank so it works regardless of class name matching.
const failingOcRanks = new Set(
  ocTriggersByClass
    .filter((oc) => ocResults.some((r) => r.className === oc.className && !r.passing))
    .map((oc) => oc.rank)
);
const failingIcRanks = new Set(
  icTriggersByClass
    .filter((ic) => icResults.some((r) => r.className === ic.className && !r.passing))
    .map((ic) => ic.rank)
);
```

And in the interest waterfall loop, replace:

```typescript
if (failingOcClasses.has(t.className) || failingIcClasses.has(t.className)) {
```

With:

```typescript
if (failingOcRanks.has(t.seniorityRank) || failingIcRanks.has(t.seniorityRank)) {
```

**Step 4: Run all tests**

Run: `cd web && npx vitest run lib/clo/__tests__/projection.test.ts`
Expected: ALL PASS (both old tests and new rank-based gating tests)

**Step 5: Commit**

```bash
git add web/lib/clo/projection.ts
git commit -m "fix: use rank-based OC/IC gating so trigger names don't need to match tranche names"
```

---

### Task 3: Add trigger mapping + warnings in ProjectionModel.tsx

**Files:**
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx:131-151` (trigger building)
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx:230-286` (add warning banner)

**Step 1: Add the mapping function**

Add this function near the top of the file (after the existing helper functions, before the component):

```typescript
interface TriggerMapping {
  triggerClassName: string;
  matchedTranches: string[];
  rank: number | null;
}

function mapTriggersToRanks(
  triggers: { className: string; triggerLevel: number }[],
  trancheInputs: { className: string; seniorityRank: number; isIncomeNote: boolean }[]
): { mapped: { className: string; triggerLevel: number; rank: number }[]; mappings: TriggerMapping[] } {
  const debtTranches = trancheInputs.filter((t) => !t.isIncomeNote);
  const mapped: { className: string; triggerLevel: number; rank: number }[] = [];
  const mappings: TriggerMapping[] = [];

  for (const trigger of triggers) {
    // 1. Exact match
    const exact = debtTranches.find((t) => t.className === trigger.className);
    if (exact) {
      mapped.push({ ...trigger, rank: exact.seniorityRank });
      mappings.push({ triggerClassName: trigger.className, matchedTranches: [exact.className], rank: exact.seniorityRank });
      continue;
    }

    // 2. Prefix match — trigger "B" matches "Class B", "Class B-1", "B-2", etc.
    const prefixMatches = debtTranches.filter((t) => {
      const normalized = t.className.replace(/^Class\s+/i, "");
      return normalized === trigger.className || normalized.startsWith(trigger.className + "-") || normalized.startsWith(trigger.className + " ");
    });

    if (prefixMatches.length > 0) {
      const bestRank = Math.min(...prefixMatches.map((t) => t.seniorityRank));
      mapped.push({ ...trigger, rank: bestRank });
      mappings.push({
        triggerClassName: trigger.className,
        matchedTranches: prefixMatches.map((t) => t.className),
        rank: bestRank,
      });
      continue;
    }

    // 3. No match — flag it
    mappings.push({ triggerClassName: trigger.className, matchedTranches: [], rank: null });
  }

  return { mapped, mappings };
}
```

**Step 2: Use the mapping in the component**

Replace the current `ocTriggers`/`icTriggers` building (lines ~141-151) with:

```typescript
const { mapped: ocTriggersMapped, mappings: ocMappings } = mapTriggersToRanks(
  ocTriggersFromTests.length > 0
    ? ocTriggersFromTests
    : (constraints.coverageTestEntries ?? [])
        .filter((e) => e.parValueRatio && parseFloat(e.parValueRatio))
        .map((e) => ({ className: e.class, triggerLevel: parseFloat(e.parValueRatio!) })),
  trancheInputs
);

const { mapped: icTriggersMapped, mappings: icMappings } = mapTriggersToRanks(
  icTriggersFromTests.length > 0
    ? icTriggersFromTests
    : (constraints.coverageTestEntries ?? [])
        .filter((e) => e.interestCoverageRatio && parseFloat(e.interestCoverageRatio))
        .map((e) => ({ className: e.class, triggerLevel: parseFloat(e.interestCoverageRatio!) })),
  trancheInputs
);
```

Then update `inputs` to use `ocTriggersMapped` / `icTriggersMapped` instead of `ocTriggers` / `icTriggers`.

**Step 3: Add the warning banner**

Inside the results section (after the validation gate, before the summary cards), render warnings for any unmapped triggers:

```typescript
const unmappedOc = ocMappings.filter((m) => m.rank === null);
const unmappedIc = icMappings.filter((m) => m.rank === null);
const hasUnmapped = unmappedOc.length > 0 || unmappedIc.length > 0;
const hasMappings = ocMappings.length > 0 || icMappings.length > 0;
```

Render a collapsible mapping summary above results:

```tsx
{hasMappings && (
  <div
    style={{
      padding: "0.75rem 1rem",
      border: `1px solid ${hasUnmapped ? "var(--color-low-border)" : "var(--color-border-light)"}`,
      borderRadius: "var(--radius-sm)",
      background: hasUnmapped ? "var(--color-low-bg)" : "var(--color-surface)",
      marginBottom: "1rem",
      fontSize: "0.78rem",
    }}
  >
    <div style={{ fontWeight: 600, marginBottom: "0.35rem", color: hasUnmapped ? "var(--color-low)" : "var(--color-text-muted)", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
      {hasUnmapped ? "Trigger Mapping Warning" : "Trigger Mapping"}
    </div>
    {ocMappings.map((m) => (
      <div key={`oc-${m.triggerClassName}`} style={{ color: m.rank === null ? "var(--color-low)" : "var(--color-text-muted)", marginBottom: "0.15rem" }}>
        OC trigger {m.triggerClassName} →{" "}
        {m.rank !== null
          ? `${m.matchedTranches.join(", ")} (rank ${m.rank})`
          : "no matching tranche — test disabled"}
      </div>
    ))}
    {icMappings.map((m) => (
      <div key={`ic-${m.triggerClassName}`} style={{ color: m.rank === null ? "var(--color-low)" : "var(--color-text-muted)", marginBottom: "0.15rem" }}>
        IC trigger {m.triggerClassName} →{" "}
        {m.rank !== null
          ? `${m.matchedTranches.join(", ")} (rank ${m.rank})`
          : "no matching tranche — test disabled"}
      </div>
    ))}
  </div>
)}
```

**Step 4: Verify locally**

Run: `cd web && npx next build`
Expected: No type errors, no build errors.

**Step 5: Commit**

```bash
git add web/app/clo/waterfall/ProjectionModel.tsx
git commit -m "feat: add trigger-to-tranche mapping with warnings for unmapped OC/IC tests"
```

---

### Task 4: Create ProjectionMethodology component

**Files:**
- Create: `web/app/clo/waterfall/ProjectionMethodology.tsx`

**Step 1: Create the component**

```tsx
"use client";

import { useState } from "react";

const SECTIONS = [
  {
    title: "Default Modeling",
    content: `Defaults are modeled using a Constant Default Rate (CDR), specified as an annual percentage. The rate is applied to total performing pool par — not on a per-loan basis. Individual loan risk characteristics are not modeled.

The annual rate is deannualized to a quarterly rate using compound decay:

  qRate = 1 − (1 − CDR)^0.25

Each quarter, defaults = performing par × qRate. Defaulted par is permanently removed from the performing pool and does not recover to par. For example, at 5% CDR, approximately 1.27% of par defaults each quarter.`,
  },
  {
    title: "Recovery Modeling",
    content: `Recovery on defaulted assets is modeled as cash proceeds, not as restoration of par. When a default occurs, the recovery amount (defaults × recovery rate) is queued into a pipeline and arrives after a configurable lag period, rounded to whole quarters.

Recovery cash flows through the principal waterfall as available proceeds, alongside prepayments and scheduled maturities. At deal maturity, all pending pipeline recoveries are accelerated and collected immediately.`,
  },
  {
    title: "Prepayment & Maturities",
    content: `Voluntary prepayments use a Constant Prepayment Rate (CPR), deannualized identically to CDR:

  qRate = 1 − (1 − CPR)^0.25

Scheduled loan maturities are sourced from the current portfolio holdings. When a loan reaches its contractual maturity date, its par amount is returned as principal cash. Maturity amounts are capped at remaining par after defaults and prepayments in that period to prevent double-counting.`,
  },
  {
    title: "Reinvestment Period",
    content: `During the reinvestment period (RP), all principal cash sources — prepayments, scheduled maturities, and recovery proceeds — are reinvested into new collateral assets. Par is restored by the reinvestment amount, and the portfolio's weighted average coupon (WAC) is blended toward the reinvestment spread for the newly purchased portion.

Post-RP, reinvestment ceases. All principal proceeds flow directly to the principal waterfall for tranche paydown.`,
  },
  {
    title: "Interest Waterfall & O/C / IC Gating",
    content: `Interest is collected on beginning-of-period performing par at the all-in rate (base rate + WAC spread), divided by 4 for quarterly accrual.

The interest waterfall pays in strict seniority order:

  1. Senior fees (trustee, admin) — on beginning par at the senior fee rate
  2. Tranche interest — each debt tranche in seniority order at its coupon rate

After paying each tranche's interest, the overcollateralization (OC) and interest coverage (IC) tests are evaluated at that seniority level:

  OC = performing par / debt outstanding at-and-above tested class
  IC = interest collected / interest due on debt at-and-above tested class

If either test fails (actual ratio < trigger level), all remaining interest is diverted to the principal waterfall for accelerated debt paydown. This is a full diversion — no partial cure. Junior tranches receive zero interest for that period. Interest shortfalls do not accrue or compound into future periods (no deferred interest).`,
  },
  {
    title: "Principal Waterfall",
    content: `Principal available for distribution in each period equals:

  prepayments + scheduled maturities + recoveries − reinvestment + diverted interest + liquidation proceeds

During the RP, reinvestment offsets prepayments/maturities/recoveries, so net principal = diverted interest only. Post-RP, the full amount flows to tranche paydown.

Principal is distributed by seniority: the most senior tranche is paid down first, then the next, and so on. At deal maturity, remaining collateral is liquidated at par and distributed through the same waterfall. Any residual principal after all debt tranches are satisfied goes to equity.`,
  },
  {
    title: "Equity & IRR",
    content: `Equity distributions are the residual after all debt obligations:

  equity = residual interest + residual principal

The equity internal rate of return (IRR) is calculated using Newton-Raphson iteration on the quarterly cash flow series, with the initial equity investment (pool par minus total debt outstanding) as a negative cash flow at time zero. The quarterly rate is then annualized:

  annual IRR = (1 + quarterly rate)^4 − 1`,
  },
];

export default function ProjectionMethodology() {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        marginTop: "2rem",
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
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.75rem 1rem",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "0.82rem",
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          textAlign: "left",
          fontFamily: "var(--font-body)",
        }}
      >
        <span style={{ fontSize: "0.7rem" }}>{open ? "▾" : "▸"}</span>
        Projection Methodology
      </button>
      {open && (
        <div style={{ padding: "0 1rem 1rem" }}>
          {SECTIONS.map((section) => (
            <div
              key={section.title}
              style={{
                borderTop: "1px solid var(--color-border-light)",
                padding: "0.75rem 0",
              }}
            >
              <h4
                style={{
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  fontFamily: "var(--font-display)",
                  marginBottom: "0.4rem",
                  color: "var(--color-text)",
                }}
              >
                {section.title}
              </h4>
              <div
                style={{
                  fontSize: "0.75rem",
                  lineHeight: 1.55,
                  color: "var(--color-text-muted)",
                  whiteSpace: "pre-line",
                }}
              >
                {section.content}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add web/app/clo/waterfall/ProjectionMethodology.tsx
git commit -m "feat: add ProjectionMethodology collapsible component"
```

---

### Task 5: Add ProjectionMethodology to the waterfall page

**Files:**
- Modify: `web/app/clo/waterfall/page.tsx`

**Step 1: Import and render the component**

Add the import at the top:

```typescript
import ProjectionMethodology from "./ProjectionMethodology";
```

Add the component after `<ProjectionModel ... />` and before the closing `</div>`:

```tsx
<ProjectionMethodology />
```

**Step 2: Verify build**

Run: `cd web && npx next build`
Expected: Build succeeds with no errors.

**Step 3: Commit**

```bash
git add web/app/clo/waterfall/page.tsx
git commit -m "feat: render projection methodology on waterfall page"
```

---

### Task 6: Run full test suite and final verification

**Step 1: Run all projection tests**

Run: `cd web && npx vitest run lib/clo/__tests__/projection.test.ts`
Expected: ALL PASS

**Step 2: Run full build**

Run: `cd web && npx next build`
Expected: Build succeeds

**Step 3: Final commit (if any remaining changes)**

```bash
git add -A
git commit -m "chore: final verification — all tests pass, build succeeds"
```
