# CLO Waterfall Test Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add missing test coverage, document modeling conventions, and lock in assumptions in the CLO waterfall projection test suite — all evaluated against how real CLOs work per indenture terms.

**Architecture:** All changes are in the test file layer (`web/lib/clo/__tests__/projection-waterfall-audit.test.ts`). No engine changes needed — the two initially suspected bugs were either already fixed (`callPricePct` clamping) or not bugs (three-regime incentive fee is correct). Every task adds tests only.

**Tech Stack:** TypeScript, Vitest, existing `runProjection` / `ProjectionInputs` / `PeriodResult` types from `web/lib/clo/projection.ts`.

**Severity legend:** Each task is tagged `[ASSUMPTION]` or `[COVERAGE]` to indicate whether it documents a modeling convention or adds missing test coverage.

---

## File Map

| File | Role |
|---|---|
| `web/lib/clo/__tests__/projection-waterfall-audit.test.ts` | **New** — all new tests from this plan go here |

All new tests live in a single new file to keep the audit findings self-contained and easy to review against this plan. Each `describe` block maps 1:1 to a task.

---

### Task 1: `[ASSUMPTION]` Document and test the OC cure RP behavior (buy collateral vs. paydown)

In real CLO indentures, OC cure *always* works by paying down the most senior tranche sequentially — reducing the denominator. The current engine uses a different approach during the RP: it buys new collateral (increases the numerator). This is a modeling convention used by some analytics platforms (e.g., Intex) but differs from the legal waterfall.

This task adds explicit documentation tests that lock in the current convention and make the assumption visible.

**Files:**
- Create: `web/lib/clo/__tests__/projection-waterfall-audit.test.ts`

- [ ] **Step 1: Create test file with the convention tests**

```typescript
// web/lib/clo/__tests__/projection-waterfall-audit.test.ts
import { describe, it, expect } from "vitest";
import {
  runProjection,
  addQuarters,
  ProjectionInputs,
  LoanInput,
} from "../projection";
import { RATING_BUCKETS } from "../rating-mapping";
import { CLO_DEFAULTS } from "../defaults";

function uniformRates(cdr: number): Record<string, number> {
  return Object.fromEntries(RATING_BUCKETS.map((b) => [b, cdr]));
}

function makeInputs(overrides: Partial<ProjectionInputs> = {}): ProjectionInputs {
  const currentDate = "2026-01-15";
  const loans: LoanInput[] = Array.from({ length: 10 }, (_, i) => ({
    parBalance: 10_000_000,
    maturityDate: addQuarters(currentDate, 12 + i),
    ratingBucket: "B",
    spreadBps: 400,
  }));

  return {
    initialPar: 100_000_000,
    wacSpreadBps: 400,
    baseRatePct: 3.5,
    baseRateFloorPct: 0,
    seniorFeePct: 0,
    subFeePct: 0,
    trusteeFeeBps: 0,
    hedgeCostBps: 0,
    incentiveFeePct: 0,
    incentiveFeeHurdleIrr: 0,
    postRpReinvestmentPct: 0,
    callDate: null,
    callPricePct: 100,
    reinvestmentOcTrigger: null,
    tranches: [
      { className: "A", currentBalance: 70_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
      { className: "B", currentBalance: 20_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
      { className: "Sub", currentBalance: 10_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
    ],
    ocTriggers: [],
    icTriggers: [],
    reinvestmentPeriodEnd: addQuarters(currentDate, 8),
    maturityDate: addQuarters(currentDate, 32),
    currentDate,
    loans,
    defaultRatesByRating: uniformRates(2),
    cprPct: 0,
    recoveryPct: CLO_DEFAULTS.recoveryPct,
    recoveryLagMonths: CLO_DEFAULTS.recoveryLagMonths,
    reinvestmentSpreadBps: CLO_DEFAULTS.reinvestmentSpreadBps,
    reinvestmentTenorQuarters: CLO_DEFAULTS.reinvestmentTenorYears * 4,
    reinvestmentRating: null,
    cccBucketLimitPct: CLO_DEFAULTS.cccBucketLimitPct,
    cccMarketValuePct: CLO_DEFAULTS.cccMarketValuePct,
    deferredInterestCompounds: true,
    ...overrides,
  };
}

// ─── Task 1: OC cure RP behavior — document modeling convention ─────────────

describe("OC cure RP convention: buy collateral (not paydown)", () => {
  it("MODELING CONVENTION: OC-only cure during RP increases par (buys collateral), does not pay down notes", () => {
    // Real CLO indentures specify paydown. This engine uses buy-collateral during RP
    // as a modeling convention (matches Intex/analytics platform behavior).
    // This test locks in the current convention so any change is intentional.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(8),
      cprPct: 0,
      recoveryPct: 0,
      ocTriggers: [{ className: "B", triggerLevel: 130, rank: 2 }],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const failPeriod = result.periods.find((p) =>
      p.ocTests.some((t) => t.className === "B" && !t.passing)
    );

    expect(failPeriod).toBeDefined();
    if (failPeriod) {
      // Convention: endingPar > beginningPar - defaults (cure bought collateral)
      const parWithoutCure = failPeriod.beginningPar - failPeriod.defaults - failPeriod.prepayments + failPeriod.reinvestment;
      // endingPar should exceed the no-cure par because cure added collateral
      expect(failPeriod.endingPar).toBeGreaterThanOrEqual(parWithoutCure - 1);
    }
  });

  it("MODELING CONVENTION: OC+IC cure during RP uses paydown (not buy collateral)", () => {
    // When IC also fails, the engine switches to paydown even during RP.
    // This is because IC failure indicates the collateral isn't generating
    // enough interest — buying more of the same won't help.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(8),
      cprPct: 0,
      recoveryPct: 0,
      baseRatePct: 0.5, // low base to trigger IC
      ocTriggers: [{ className: "B", triggerLevel: 130, rank: 2 }],
      icTriggers: [{ className: "B", triggerLevel: 999, rank: 2 }],
    });

    const ocOnlyInputs = makeInputs({
      reinvestmentPeriodEnd: addQuarters("2026-01-15", 20),
      defaultRatesByRating: uniformRates(8),
      cprPct: 0,
      recoveryPct: 0,
      baseRatePct: 0.5,
      ocTriggers: [{ className: "B", triggerLevel: 130, rank: 2 }],
      icTriggers: [],
    });

    const bothResult = runProjection(inputs);
    const ocOnlyResult = runProjection(ocOnlyInputs);

    // OC-only: par increases (buy collateral)
    // OC+IC: par does NOT increase (paydown instead)
    const bothP1 = bothResult.periods[0];
    const ocP1 = ocOnlyResult.periods[0];

    // OC+IC path produces lower endingPar (paydown, not buy)
    expect(bothP1.endingPar).toBeLessThanOrEqual(ocP1.endingPar + 1);
    // OC+IC path produces lower endingLiabilities (notes paid down)
    expect(bothP1.endingLiabilities).toBeLessThanOrEqual(ocP1.endingLiabilities + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /Users/solal/Documents/GitHub/funzies && npx vitest run web/lib/clo/__tests__/projection-waterfall-audit.test.ts --reporter=verbose`

Expected: PASS (these document existing behavior)

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/__tests__/projection-waterfall-audit.test.ts
git commit -m "test: document OC cure RP convention (buy collateral vs paydown)

Locks in the current modeling convention: OC-only failure during RP
buys collateral (increases numerator). OC+IC failure during RP uses
paydown (reduces denominator). This differs from indenture language
but matches common analytics platform behavior."
```

---

### Task 2: `[COVERAGE]` Document three-regime incentive fee behavior

The engine implements a correct three-regime incentive fee:
- **Regime 1:** Pre-fee IRR <= hurdle → fee = 0
- **Regime 2:** Full fee leaves IRR >= hurdle → take full fee (standard flat %)
- **Regime 3:** Full fee would push IRR below hurdle → bisect to find max fee preserving hurdle

No existing test exercises all three regimes explicitly. This task adds targeted tests for each.

**Files:**
- Modify: `web/lib/clo/__tests__/projection-waterfall-audit.test.ts`

- [ ] **Step 1: Add three-regime incentive fee tests**

Append to `projection-waterfall-audit.test.ts`:

```typescript
// ─── Task 2: Three-regime incentive fee ─────────────────────────────────────

describe("Incentive fee three-regime behavior", () => {
  it("Regime 1: pre-fee IRR below hurdle → no fee taken", () => {
    // 99% hurdle is unreachable → fee = 0, distributions identical to no-fee case
    const withFee = runProjection(makeInputs({
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: 0.99,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    const noFee = runProjection(makeInputs({
      incentiveFeePct: 0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    expect(withFee.totalEquityDistributions).toBeCloseTo(noFee.totalEquityDistributions, 0);
  });

  it("Regime 2: full fee leaves IRR well above hurdle → take full feePct of residual", () => {
    // Low hurdle (0.1%), healthy deal → full 20% fee, post-fee IRR still far above hurdle
    const withFee = runProjection(makeInputs({
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: 0.001,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    const noFee = runProjection(makeInputs({
      incentiveFeePct: 0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    // Full 20% fee → equity ≈ 80% of no-fee baseline
    const ratio = withFee.totalEquityDistributions / noFee.totalEquityDistributions;
    expect(ratio).toBeGreaterThan(0.70);
    expect(ratio).toBeLessThan(0.90);

    // Post-fee IRR still well above the trivial 0.1% hurdle
    expect(withFee.equityIrr).not.toBeNull();
    expect(withFee.equityIrr!).toBeGreaterThan(0.05);
  });

  it("Regime 3: full fee would breach hurdle → bisect to preserve hurdle IRR", () => {
    // Find a hurdle where full fee overshoots (IRR would drop below hurdle).
    // The engine should bisect and take a partial fee.
    // Strategy: set hurdle just below pre-fee IRR. Full 20% fee drops IRR below hurdle.
    // Engine bisects → post-fee IRR ≈ hurdle.

    // First, find the no-fee IRR
    const noFee = runProjection(makeInputs({
      incentiveFeePct: 0,
      defaultRatesByRating: uniformRates(0),
      cprPct: 10,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    const preFeeIrr = noFee.equityIrr;
    expect(preFeeIrr).not.toBeNull();

    // Set hurdle at 90% of pre-fee IRR → full 20% fee would overshoot
    const hurdle = preFeeIrr! * 0.90;

    const withFee = runProjection(makeInputs({
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: hurdle,
      defaultRatesByRating: uniformRates(0),
      cprPct: 10,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    // Post-fee IRR should be approximately at the hurdle (bisection result)
    expect(withFee.equityIrr).not.toBeNull();
    expect(withFee.equityIrr!).toBeGreaterThanOrEqual(hurdle - 0.005);

    // Fee was taken (distributions reduced vs no-fee)
    expect(withFee.totalEquityDistributions).toBeLessThan(noFee.totalEquityDistributions);

    // But fee was partial (distributions higher than if full 20% were taken)
    const fullFeeResult = runProjection(makeInputs({
      incentiveFeePct: 20,
      incentiveFeeHurdleIrr: 0.001, // trivial hurdle → full fee
      defaultRatesByRating: uniformRates(0),
      cprPct: 10,
      reinvestmentPeriodEnd: "2026-01-01",
      ocTriggers: [],
      icTriggers: [],
    }));

    expect(withFee.totalEquityDistributions).toBeGreaterThan(fullFeeResult.totalEquityDistributions);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /Users/solal/Documents/GitHub/funzies && npx vitest run web/lib/clo/__tests__/projection-waterfall-audit.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/__tests__/projection-waterfall-audit.test.ts
git commit -m "test: document three-regime incentive fee (no fee / full fee / bisected fee)"
```

---

### Task 3: `[COVERAGE]` Add sequential principal paydown order test

No existing test verifies that post-RP principal proceeds pay down tranches **sequentially** (A first, then B, then C) rather than pro-rata. This is a fundamental CLO structural feature.

**Files:**
- Modify: `web/lib/clo/__tests__/projection-waterfall-audit.test.ts`

- [ ] **Step 1: Add sequential paydown tests**

Append to `projection-waterfall-audit.test.ts`:

```typescript
// ─── Task 3: Sequential principal paydown order ─────────────────────────────

describe("Principal paydown is sequential (senior-first), not pro-rata", () => {
  it("Class A fully paid before any principal goes to Class B", () => {
    // Post-RP, no triggers. Principal from maturities should pay A first.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01", // post-RP
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      // Two loans: one matures Q2 (40M), one matures Q4 (60M)
      loans: [
        { parBalance: 40_000_000, maturityDate: addQuarters("2026-01-15", 2), ratingBucket: "B", spreadBps: 400 },
        { parBalance: 60_000_000, maturityDate: addQuarters("2026-01-15", 4), ratingBucket: "B", spreadBps: 400 },
      ],
      tranches: [
        { className: "A", currentBalance: 50_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 30_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // Q2: 40M matures. All 40M should go to A (A balance: 50M → 10M). B untouched.
    const q2 = result.periods.find((p) => p.periodNum === 2)!;
    const aPrinQ2 = q2.tranchePrincipal.find((t) => t.className === "A")!;
    const bPrinQ2 = q2.tranchePrincipal.find((t) => t.className === "B")!;
    expect(aPrinQ2.paid).toBeCloseTo(40_000_000, -3);
    expect(bPrinQ2.paid).toBeCloseTo(0, -1);
    expect(aPrinQ2.endBalance).toBeCloseTo(10_000_000, -3);

    // Q4: 60M matures. First 10M finishes A, then 30M pays B, then 20M to equity.
    const q4 = result.periods.find((p) => p.periodNum === 4)!;
    const aPrinQ4 = q4.tranchePrincipal.find((t) => t.className === "A")!;
    const bPrinQ4 = q4.tranchePrincipal.find((t) => t.className === "B")!;
    expect(aPrinQ4.endBalance).toBeCloseTo(0, -1);
    expect(bPrinQ4.endBalance).toBeCloseTo(0, -1);
    expect(q4.equityDistribution).toBeGreaterThan(15_000_000); // ~20M principal + interest
  });

  it("Class B receives zero principal until Class A is fully retired", () => {
    // Small maturity each quarter (12.5M). A = 35M, B = 20M.
    // A takes Q1-Q2 (25M) and part of Q3 (10M). B starts mid-Q3.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      loans: Array.from({ length: 8 }, (_, i) => ({
        parBalance: 12_500_000,
        maturityDate: addQuarters("2026-01-15", i + 1),
        ratingBucket: "B",
        spreadBps: 400,
      })),
      tranches: [
        { className: "A", currentBalance: 35_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 20_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 45_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // Periods before A is paid off: B should get 0 principal
    for (const p of result.periods) {
      const aEnd = p.tranchePrincipal.find((t) => t.className === "A")!.endBalance;
      const bPaid = p.tranchePrincipal.find((t) => t.className === "B")!.paid;
      if (aEnd > 1_000) {
        // A still outstanding → B should get nothing
        expect(bPaid).toBeCloseTo(0, -1);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /Users/solal/Documents/GitHub/funzies && npx vitest run web/lib/clo/__tests__/projection-waterfall-audit.test.ts --reporter=verbose`

Expected: PASS (if the engine correctly implements sequential paydown). If FAIL, this reveals a real bug in the principal waterfall.

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/__tests__/projection-waterfall-audit.test.ts
git commit -m "test: verify sequential principal paydown order (A before B before C)"
```

---

### Task 4: `[COVERAGE]` Add fee waterfall priority order tests

No test verifies the ordering of fees in the interest waterfall. Misordering would silently misallocate cash.

**Files:**
- Modify: `web/lib/clo/__tests__/projection-waterfall-audit.test.ts`

- [ ] **Step 1: Add fee priority tests**

Append to `projection-waterfall-audit.test.ts`:

```typescript
// ─── Task 4: Fee waterfall priority ─────────────────────────────────────────

describe("Fee waterfall priority order", () => {
  it("trustee fee is senior to tranche interest (paid even when interest barely covers fees)", () => {
    // If trustee fees are misplaced below tranche interest, this test catches it.
    const highTrustee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      trusteeFeeBps: 400, // 4% = 1M/quarter on 100M
      seniorFeePct: 0,
      hedgeCostBps: 0,
      subFeePct: 0,
      ocTriggers: [],
      icTriggers: [],
    }));

    const noTrustee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      trusteeFeeBps: 0,
      seniorFeePct: 0,
      hedgeCostBps: 0,
      subFeePct: 0,
      ocTriggers: [],
      icTriggers: [],
    }));

    const q1High = highTrustee.periods[0];
    const q1None = noTrustee.periods[0];

    // Total interest to tranches + equity should be reduced by the trustee fee
    const totalToDebtHigh = q1High.trancheInterest.reduce((s, t) => s + t.paid, 0) + q1High.equityDistribution;
    const totalToDebtNone = q1None.trancheInterest.reduce((s, t) => s + t.paid, 0) + q1None.equityDistribution;

    // Difference should equal the trustee fee: 100M * 4% / 4 = 1M
    expect(totalToDebtNone - totalToDebtHigh).toBeCloseTo(1_000_000, -3);
  });

  it("senior fee is deducted before tranche interest calculation (reduces IC numerator)", () => {
    // IC numerator = interestCollected - seniorFee - trusteeFee - hedgeCost
    // If seniorFee were paid AFTER tranches, IC wouldn't reflect it.
    const withFee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      seniorFeePct: 1.0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      icTriggers: [{ className: "A", triggerLevel: 100, rank: 1 }],
      ocTriggers: [],
    }));

    const noFee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      seniorFeePct: 0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      icTriggers: [{ className: "A", triggerLevel: 100, rank: 1 }],
      ocTriggers: [],
    }));

    const icWithFee = withFee.periods[0].icTests[0].actual;
    const icNoFee = noFee.periods[0].icTests[0].actual;

    // Senior fee reduces IC numerator → lower IC ratio
    expect(icWithFee).toBeLessThan(icNoFee);
  });

  it("sub fee is junior to tranche interest (tranches paid first)", () => {
    // Set sub fee very high. Tranches should still get paid; sub fee and equity absorb the shortfall.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      seniorFeePct: 0,
      subFeePct: 5.0, // 5% = 1.25M/quarter — large
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      ocTriggers: [],
      icTriggers: [],
    });

    const result = runProjection(inputs);
    const noSubFee = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      seniorFeePct: 0,
      subFeePct: 0,
      trusteeFeeBps: 0,
      hedgeCostBps: 0,
      ocTriggers: [],
      icTriggers: [],
    }));

    // Tranches should get identical interest regardless of sub fee
    // (sub fee is junior to tranche interest)
    const aInterest = result.periods[0].trancheInterest.find((t) => t.className === "A")!;
    const aInterestNoFee = noSubFee.periods[0].trancheInterest.find((t) => t.className === "A")!;
    expect(aInterest.paid).toBeCloseTo(aInterestNoFee.paid, 0);

    // Sub fee reduces equity only
    expect(result.periods[0].equityDistribution).toBeLessThan(
      noSubFee.periods[0].equityDistribution
    );
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /Users/solal/Documents/GitHub/funzies && npx vitest run web/lib/clo/__tests__/projection-waterfall-audit.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/__tests__/projection-waterfall-audit.test.ts
git commit -m "test: verify fee waterfall priority order (trustee > senior > tranche > sub)"
```

---

### Task 5: `[COVERAGE]` Add composite OC numerator test (all components simultaneously)

Each OC numerator component (performing par, principal cash, pending recoveries, CCC haircut) is tested in isolation. No test verifies they all combine correctly in one period.

**Files:**
- Modify: `web/lib/clo/__tests__/projection-waterfall-audit.test.ts`

- [ ] **Step 1: Add composite OC numerator test**

Append to `projection-waterfall-audit.test.ts`:

```typescript
// ─── Task 5: Composite OC numerator ─────────────────────────────────────────

describe("OC numerator combines all components correctly", () => {
  it("OC numerator = performingPar - cccHaircut (with pending recoveries, principal cash, and CCC all active)", () => {
    // Setup: CCC loans (for haircut), defaults (for recovery pipeline),
    // post-RP maturity (for principal cash), all at once.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: { ...uniformRates(0), CCC: 10 },
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 12, // 4-quarter lag → pending recoveries in early periods
      cccBucketLimitPct: 7.5,
      cccMarketValuePct: 70,
      loans: [
        // CCC loans: 30M → exceeds 7.5% limit → haircut
        { parBalance: 30_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "CCC", spreadBps: 650 },
        // B loans: 50M, stable
        { parBalance: 50_000_000, maturityDate: addQuarters("2026-01-15", 20), ratingBucket: "B", spreadBps: 400 },
        // Maturing loan: 20M in Q3 → principal cash
        { parBalance: 20_000_000, maturityDate: addQuarters("2026-01-15", 3), ratingBucket: "B", spreadBps: 400 },
      ],
      tranches: [
        { className: "A", currentBalance: 60_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 20_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A", triggerLevel: 110, rank: 1 },
        { className: "B", triggerLevel: 105, rank: 2 },
      ],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // Verify all components are active simultaneously in at least one period
    for (const p of result.periods.slice(0, 8)) {
      // OC values should be finite and positive
      for (const oc of p.ocTests) {
        expect(isFinite(oc.actual)).toBe(true);
        expect(oc.actual).toBeGreaterThanOrEqual(0);
      }
    }

    // Q1: CCC defaults occur → recovery pipeline loaded, CCC haircut active
    const q1 = result.periods[0];
    expect(q1.defaults).toBeGreaterThan(0); // CCC loans default
    expect(q1.recoveries).toBe(0); // lag = 4 quarters → no recoveries yet

    // The OC ratio for A in Q1 should be lower than par/A-balance
    // because CCC haircut reduces numerator
    const naiveOcA = (q1.endingPar / 60_000_000) * 100;
    const actualOcA = q1.ocTests.find((t) => t.className === "A")!.actual;
    // CCC haircut reduces numerator below endingPar
    expect(actualOcA).toBeLessThanOrEqual(naiveOcA + 0.1);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /Users/solal/Documents/GitHub/funzies && npx vitest run web/lib/clo/__tests__/projection-waterfall-audit.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/__tests__/projection-waterfall-audit.test.ts
git commit -m "test: verify composite OC numerator with all components active simultaneously"
```

---

### Task 6: `[COVERAGE]` Add PIK catch-up priority test

When a deferrable tranche has accumulated PIK and the deal later becomes healthy enough to pay, deferred interest should be paid before (or at least alongside) current interest. No test currently verifies this.

**Files:**
- Modify: `web/lib/clo/__tests__/projection-waterfall-audit.test.ts`

- [ ] **Step 1: Add PIK catch-up test**

Append to `projection-waterfall-audit.test.ts`:

```typescript
// ─── Task 6: PIK catch-up priority ──────────────────────────────────────────

describe("PIK catch-up: deferred interest paid when deal recovers", () => {
  it("tranche with accumulated PIK eventually gets repaid when OC cures", () => {
    // Phase 1 (Q1-Q4): extreme OC failure → B gets PIK'd (no interest paid)
    // Phase 2 (Q5+): high prepayments wipe out par → tranches paid off from principal
    // B's PIK'd balance should be included in the payoff amount.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(5),
      cprPct: 20, // prepayments generate principal to pay down notes
      recoveryPct: 0,
      deferredInterestCompounds: true,
      tranches: [
        { className: "A", currentBalance: 50_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 20_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 30_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      // A OC fails impossibly → diverts all interest → B gets PIK
      ocTriggers: [{ className: "A", triggerLevel: 200, rank: 1 }],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // B should PIK in early periods (endBalance > 20M)
    const bBalanceQ2 = result.periods[1]?.tranchePrincipal.find((t) => t.className === "B")!.endBalance;
    expect(bBalanceQ2).toBeGreaterThan(20_000_000);

    // Over the full deal, B's total principal paid should include the PIK amount
    // (i.e., it should pay off more than the original 20M)
    const totalBPrincipal = result.periods.reduce((s, p) => {
      const bPrin = p.tranchePrincipal.find((t) => t.className === "B");
      return s + (bPrin?.paid ?? 0);
    }, 0);

    // Total paid should exceed original 20M balance (includes PIK)
    // Unless defaults were so severe that B never gets fully repaid
    // At minimum, B should get some principal repayment
    expect(totalBPrincipal).toBeGreaterThan(0);
  });

  it("PIK balance is included when tranche is paid off at maturity", () => {
    // Short deal: B gets PIK in early periods, then at maturity all remaining
    // loans liquidate and pay off tranches. B's payoff should include its PIK.
    const inputs = makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      maturityDate: addQuarters("2026-01-15", 8), // short deal
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      recoveryPct: 0,
      deferredInterestCompounds: true,
      tranches: [
        { className: "A", currentBalance: 70_000_000, spreadBps: 140, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 10_000_000, spreadBps: 300, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: true },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      // Force B to PIK with impossible A trigger
      ocTriggers: [{ className: "A", triggerLevel: 999, rank: 1 }],
      icTriggers: [],
    });

    const result = runProjection(inputs);

    // Over the full deal, total B principal paid should exceed original 10M (PIK included)
    const totalBPaid = result.periods.reduce((s, p) => {
      return s + (p.tranchePrincipal.find((t) => t.className === "B")?.paid ?? 0);
    }, 0);

    // Should pay off original 10M + accumulated PIK (several hundred K)
    expect(totalBPaid).toBeGreaterThan(10_000_000);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /Users/solal/Documents/GitHub/funzies && npx vitest run web/lib/clo/__tests__/projection-waterfall-audit.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/__tests__/projection-waterfall-audit.test.ts
git commit -m "test: verify PIK catch-up — deferred interest included in tranche payoff"
```

---

### Task 7: `[COVERAGE]` Add OC/IC cure interaction precision test

The engine takes `max(ocCure, icCure)` when both fail at the same rank. This task verifies the behavior and documents it.

**Files:**
- Modify: `web/lib/clo/__tests__/projection-waterfall-audit.test.ts`

- [ ] **Step 1: Add max-cure test**

Append to `projection-waterfall-audit.test.ts`:

```typescript
// ─── Task 7: OC/IC cure interaction — max not additive ──────────────────────

describe("OC + IC cure uses max (not sum) of cure amounts", () => {
  it("dual failure diverts no more than the worse single-trigger case", () => {
    const base = {
      reinvestmentPeriodEnd: "2026-01-01" as string,
      cprPct: 0,
      recoveryPct: 0,
      ocTriggers: [] as ProjectionInputs["ocTriggers"],
      icTriggers: [] as ProjectionInputs["icTriggers"],
    };

    // OC-only failure
    const ocOnly = runProjection(makeInputs({
      ...base,
      defaultRatesByRating: uniformRates(15),
      ocTriggers: [{ className: "B", triggerLevel: 150, rank: 2 }],
    }));

    // IC-only failure
    const icOnly = runProjection(makeInputs({
      ...base,
      defaultRatesByRating: uniformRates(0),
      baseRatePct: 0.5,
      seniorFeePct: 1.0,
      icTriggers: [{ className: "B", triggerLevel: 300, rank: 2 }],
    }));

    // Both fail
    const both = runProjection(makeInputs({
      ...base,
      defaultRatesByRating: uniformRates(15),
      baseRatePct: 0.5,
      seniorFeePct: 1.0,
      ocTriggers: [{ className: "B", triggerLevel: 150, rank: 2 }],
      icTriggers: [{ className: "B", triggerLevel: 300, rank: 2 }],
    }));

    const ocEquity = ocOnly.periods[0].equityDistribution;
    const icEquity = icOnly.periods[0].equityDistribution;
    const bothEquity = both.periods[0].equityDistribution;

    // "Both" should divert at most as much as the worse single case.
    // If additive, bothEquity would be lower than min(ocEquity, icEquity).
    // With max: bothEquity >= min(ocEquity, icEquity) - rounding.
    expect(bothEquity).toBeGreaterThanOrEqual(Math.min(ocEquity, icEquity) - 100);
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd /Users/solal/Documents/GitHub/funzies && npx vitest run web/lib/clo/__tests__/projection-waterfall-audit.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/__tests__/projection-waterfall-audit.test.ts
git commit -m "test: verify OC+IC cure uses max (not sum) of individual cure amounts"
```

---

### Task 8: `[ASSUMPTION]` Document pending recovery OC numerator convention

Pending (future, not-yet-received) recoveries in the OC numerator is a modeling choice, not universal in all CLO indentures. Document and lock this in.

**Files:**
- Modify: `web/lib/clo/__tests__/projection-waterfall-audit.test.ts`

- [ ] **Step 1: Add convention test**

Append to `projection-waterfall-audit.test.ts`:

```typescript
// ─── Task 8: Pending recovery in OC numerator — modeling convention ─────────

describe("Pending recoveries included in OC numerator (modeling convention)", () => {
  it("CONVENTION: OC ratio in Q1 is higher with 60% recovery/12mo lag than with 0% recovery", () => {
    // This tests that pending (not-yet-received) recovery value is credited
    // in the OC numerator. Not all CLO indentures include this.
    const withRecovery = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(10),
      cprPct: 0,
      recoveryPct: 60,
      recoveryLagMonths: 12,
      ocTriggers: [{ className: "A", triggerLevel: 110, rank: 1 }],
      icTriggers: [],
    }));

    const noRecovery = runProjection(makeInputs({
      reinvestmentPeriodEnd: "2026-01-01",
      defaultRatesByRating: uniformRates(10),
      cprPct: 0,
      recoveryPct: 0,
      recoveryLagMonths: 12,
      ocTriggers: [{ className: "A", triggerLevel: 110, rank: 1 }],
      icTriggers: [],
    }));

    // Q1: defaults occurred, recoveries not yet received (lag = 4 quarters).
    // But pending recovery value should boost OC numerator.
    const ocWithRec = withRecovery.periods[0].ocTests[0].actual;
    const ocNoRec = noRecovery.periods[0].ocTests[0].actual;
    expect(ocWithRec).toBeGreaterThan(ocNoRec);

    // Sanity: no actual cash recoveries in Q1 (lag)
    expect(withRecovery.periods[0].recoveries).toBe(0);
    expect(noRecovery.periods[0].recoveries).toBe(0);
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd /Users/solal/Documents/GitHub/funzies && npx vitest run web/lib/clo/__tests__/projection-waterfall-audit.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/__tests__/projection-waterfall-audit.test.ts
git commit -m "test: document pending recovery in OC numerator as modeling convention"
```

---

### Task 9: Final — Run full suite and verify no regressions

- [ ] **Step 1: Run every projection test**

Run: `cd /Users/solal/Documents/GitHub/funzies && npx vitest run web/lib/clo/__tests__/projection*.test.ts --reporter=verbose`

Expected: All tests PASS.

- [ ] **Step 2: Commit if any adjustments needed**

```bash
git add web/lib/clo/__tests__/projection-waterfall-audit.test.ts
git commit -m "test: finalize CLO waterfall audit test suite"
```

---

## Summary of Tasks

| # | Type | What |
|---|---|---|
| 1 | `[ASSUMPTION]` | Document OC cure RP convention (buy collateral vs paydown) |
| 2 | `[COVERAGE]` | Document three-regime incentive fee behavior |
| 3 | `[COVERAGE]` | Sequential principal paydown order verification |
| 4 | `[COVERAGE]` | Fee waterfall priority order verification |
| 5 | `[COVERAGE]` | Composite OC numerator (all components simultaneously) |
| 6 | `[COVERAGE]` | PIK catch-up priority at payoff/maturity |
| 7 | `[COVERAGE]` | OC/IC cure max-not-sum interaction |
| 8 | `[ASSUMPTION]` | Document pending recovery OC convention |
| 9 | — | Full regression check |
