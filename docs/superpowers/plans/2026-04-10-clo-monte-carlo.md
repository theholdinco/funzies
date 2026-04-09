# CLO Monte Carlo Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 10,000-run Monte Carlo simulation to the CLO waterfall, producing an IRR distribution histogram and OC failure probability timeline, auto-rerunning with 500ms debounce on assumption changes.

**Architecture:** One-line change to `projection.ts` (inject default draw function), pure Monte Carlo aggregation logic in `monte-carlo.ts`, Web Worker for off-main-thread execution, `useMonteCarlo` React hook with debounce, recharts visualizations in `MonteCarloChart.tsx`.

**Tech Stack:** TypeScript, React, Web Workers, recharts (already installed v3.8.0)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `web/lib/clo/projection.ts` | Modify (2 lines) | Add optional `defaultDrawFn` parameter |
| `web/lib/clo/monte-carlo.ts` | Create | Pure MC logic: types, Bernoulli draw, loop, aggregate |
| `web/lib/clo/monte-carlo.worker.ts` | Create | Web Worker: receives inputs, runs MC, posts progress+result |
| `web/lib/clo/useMonteCarlo.ts` | Create | React hook: debounce, worker lifecycle, state management |
| `web/app/clo/waterfall/MonteCarloChart.tsx` | Create | IRR histogram + OC failure timeline (recharts) |
| `web/app/clo/waterfall/ProjectionModel.tsx` | Modify | Wire hook + render MC section in transparency area |

---

### Task 1: Add defaultDrawFn to projection engine

**Files:**
- Modify: `web/lib/clo/projection.ts`

- [ ] **Step 1: Add the DefaultDrawFn type export and modify the function signature**

At the top of `web/lib/clo/projection.ts`, after the existing type exports (around line 10), add:

```typescript
export type DefaultDrawFn = (survivingPar: number, hazardRate: number) => number;
```

Change line 127 from:
```typescript
export function runProjection(inputs: ProjectionInputs): ProjectionResult {
```
to:
```typescript
export function runProjection(inputs: ProjectionInputs, defaultDrawFn?: DefaultDrawFn): ProjectionResult {
```

- [ ] **Step 2: Use the draw function in the default loop**

At line 250 (inside the `if (hasLoans)` block), change:
```typescript
        const loanDefaults = loan.survivingPar * hazard;
```
to:
```typescript
        const draw = defaultDrawFn ?? ((par: number, hz: number) => par * hz);
        const loanDefaults = draw(loan.survivingPar, hazard);
```

**Important:** The `draw` variable should be hoisted OUTSIDE the loan loop for performance (avoid recreating the fallback function 209×44 times). Move it before the `for (let q = 1; ...)` loop, around line 227:

```typescript
  const draw: DefaultDrawFn = defaultDrawFn ?? ((par, hz) => par * hz);
```

Then line 250 becomes simply:
```typescript
        const loanDefaults = draw(loan.survivingPar, hazard);
```

- [ ] **Step 3: Verify TypeScript compiles and existing behavior unchanged**

Run: `cd /Users/solal/Documents/GitHub/funzies/web && npx tsc --noEmit`
Expected: Clean output, no errors

- [ ] **Step 4: Commit**

```bash
git add web/lib/clo/projection.ts
git commit -m "feat: add defaultDrawFn parameter to runProjection for Monte Carlo injection"
```

---

### Task 2: Create Monte Carlo core logic

**Files:**
- Create: `web/lib/clo/monte-carlo.ts`

- [ ] **Step 1: Create the Monte Carlo types and core function**

```typescript
// web/lib/clo/monte-carlo.ts

import { runProjection, type ProjectionInputs, type DefaultDrawFn } from "./projection";

export interface MonteCarloPercentiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface MonteCarloResult {
  runCount: number;
  irrs: Float64Array;
  percentiles: MonteCarloPercentiles;
  meanIrr: number;
  ocFailureByQuarter: { quarter: number; failurePct: number }[];
  medianEquityDistributions: number;
}

function bernoulliDraw(survivingPar: number, hazardRate: number): number {
  return Math.random() < hazardRate ? survivingPar : 0;
}

function percentile(sorted: Float64Array, p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export function runMonteCarlo(
  inputs: ProjectionInputs,
  runCount: number,
  onProgress?: (completed: number) => void,
): MonteCarloResult {
  const irrs = new Float64Array(runCount);
  const equityDists = new Float64Array(runCount);

  // Determine total quarters for OC tracking
  // Use a quick deterministic run to get the period count
  const calibration = runProjection(inputs);
  const totalQuarters = calibration.periods.length;
  const ocFailureCounts = new Uint32Array(totalQuarters);

  for (let i = 0; i < runCount; i++) {
    const result = runProjection(inputs, bernoulliDraw);

    irrs[i] = result.equityIrr ?? -1;
    equityDists[i] = result.totalEquityDistributions;

    // Track OC failures per quarter
    for (let q = 0; q < result.periods.length; q++) {
      const anyOcFail = result.periods[q].ocTests.some(t => !t.passing);
      if (anyOcFail) ocFailureCounts[q]++;
    }

    if (onProgress && (i + 1) % 500 === 0) {
      onProgress(i + 1);
    }
  }

  // Sort IRRs for percentile computation
  const sortedIrrs = new Float64Array(irrs);
  sortedIrrs.sort();

  // Sort equity distributions for median
  const sortedDists = new Float64Array(equityDists);
  sortedDists.sort();

  // Compute mean IRR (excluding nulls represented as -1)
  let irrSum = 0;
  let irrCount = 0;
  for (let i = 0; i < irrs.length; i++) {
    if (irrs[i] > -0.9999) {
      irrSum += irrs[i];
      irrCount++;
    }
  }

  const ocFailureByQuarter = Array.from(ocFailureCounts).map((count, q) => ({
    quarter: q + 1,
    failurePct: (count / runCount) * 100,
  }));

  return {
    runCount,
    irrs: sortedIrrs,
    percentiles: {
      p5: percentile(sortedIrrs, 0.05),
      p25: percentile(sortedIrrs, 0.25),
      p50: percentile(sortedIrrs, 0.50),
      p75: percentile(sortedIrrs, 0.75),
      p95: percentile(sortedIrrs, 0.95),
    },
    meanIrr: irrCount > 0 ? irrSum / irrCount : 0,
    ocFailureByQuarter,
    medianEquityDistributions: percentile(sortedDists, 0.50),
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/solal/Documents/GitHub/funzies/web && npx tsc --noEmit`
Expected: Clean output

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/monte-carlo.ts
git commit -m "feat: add Monte Carlo core logic with Bernoulli default draws"
```

---

### Task 3: Create Web Worker

**Files:**
- Create: `web/lib/clo/monte-carlo.worker.ts`

- [ ] **Step 1: Create the Web Worker file**

```typescript
// web/lib/clo/monte-carlo.worker.ts

import { runMonteCarlo, type MonteCarloResult } from "./monte-carlo";
import type { ProjectionInputs } from "./projection";

export interface MCWorkerInbound {
  type: "run";
  inputs: ProjectionInputs;
  runCount: number;
}

export interface MCWorkerProgress {
  type: "progress";
  completed: number;
  total: number;
}

export interface MCWorkerResult {
  type: "result";
  data: Omit<MonteCarloResult, "irrs"> & { irrs: number[] };
}

export type MCWorkerOutbound = MCWorkerProgress | MCWorkerResult;

const ctx = self as unknown as Worker;

ctx.addEventListener("message", (event: MessageEvent<MCWorkerInbound>) => {
  const { inputs, runCount } = event.data;

  const result = runMonteCarlo(inputs, runCount, (completed) => {
    ctx.postMessage({
      type: "progress",
      completed,
      total: runCount,
    } satisfies MCWorkerProgress);
  });

  // Convert Float64Array to regular array for structured clone transfer
  ctx.postMessage({
    type: "result",
    data: {
      ...result,
      irrs: Array.from(result.irrs),
    },
  } satisfies MCWorkerResult);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/solal/Documents/GitHub/funzies/web && npx tsc --noEmit`
Expected: Clean output (the Worker type usage may need `lib: ["webworker"]` in tsconfig — check and add if needed)

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/monte-carlo.worker.ts
git commit -m "feat: add Monte Carlo Web Worker with progress reporting"
```

---

### Task 4: Create useMonteCarlo hook

**Files:**
- Create: `web/lib/clo/useMonteCarlo.ts`

- [ ] **Step 1: Create the React hook**

```typescript
// web/lib/clo/useMonteCarlo.ts
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ProjectionInputs } from "./projection";
import type { MonteCarloResult } from "./monte-carlo";
import type { MCWorkerOutbound } from "./monte-carlo.worker";

const MC_RUN_COUNT = 10_000;
const DEBOUNCE_MS = 500;

export function useMonteCarlo(inputs: ProjectionInputs | null) {
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const createWorker = useCallback(() => {
    const worker = new Worker(
      new URL("./monte-carlo.worker.ts", import.meta.url)
    );

    worker.addEventListener("message", (event: MessageEvent<MCWorkerOutbound>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        setProgress(msg.completed / msg.total);
      } else if (msg.type === "result") {
        setResult({
          ...msg.data,
          irrs: new Float64Array(msg.data.irrs),
        });
        setRunning(false);
        setProgress(1);
      }
    });

    worker.addEventListener("error", () => {
      setRunning(false);
    });

    return worker;
  }, []);

  // Terminate and recreate worker to cancel in-flight runs
  const cancelAndRestart = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
    }
    workerRef.current = createWorker();
  }, [createWorker]);

  useEffect(() => {
    workerRef.current = createWorker();
    return () => {
      workerRef.current?.terminate();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [createWorker]);

  // Debounced auto-run when inputs change
  useEffect(() => {
    if (!inputs) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      cancelAndRestart();
      setRunning(true);
      setProgress(0);
      workerRef.current?.postMessage({
        type: "run",
        inputs,
        runCount: MC_RUN_COUNT,
      });
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [inputs, cancelAndRestart]);

  return { result, running, progress };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/solal/Documents/GitHub/funzies/web && npx tsc --noEmit`
Expected: Clean output

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/useMonteCarlo.ts
git commit -m "feat: add useMonteCarlo hook with debounce and worker lifecycle"
```

---

### Task 5: Create Monte Carlo visualizations

**Files:**
- Create: `web/app/clo/waterfall/MonteCarloChart.tsx`

- [ ] **Step 1: Create the chart component with IRR histogram and OC timeline**

```typescript
// web/app/clo/waterfall/MonteCarloChart.tsx
"use client";

import { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer,
  AreaChart, Area,
} from "recharts";
import type { MonteCarloResult } from "@/lib/clo/monte-carlo";

interface Props {
  result: MonteCarloResult | null;
  running: boolean;
  progress: number;
}

function buildHistogramData(irrs: Float64Array): { bucket: string; mid: number; count: number; pct: number }[] {
  const MIN = -0.5;
  const MAX = 0.4;
  const STEP = 0.02;
  const buckets: { bucket: string; mid: number; count: number; pct: number }[] = [];

  for (let lo = MIN; lo < MAX; lo += STEP) {
    const hi = lo + STEP;
    const mid = lo + STEP / 2;
    let count = 0;
    for (let i = 0; i < irrs.length; i++) {
      if (irrs[i] >= lo && irrs[i] < hi) count++;
    }
    buckets.push({
      bucket: `${(lo * 100).toFixed(0)}%`,
      mid,
      count,
      pct: (count / irrs.length) * 100,
    });
  }
  return buckets;
}

function formatPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export default function MonteCarloChart({ result, running, progress }: Props) {
  const histogramData = useMemo(
    () => (result ? buildHistogramData(result.irrs) : []),
    [result]
  );

  const labelStyle: React.CSSProperties = {
    fontSize: "0.68rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
    marginBottom: "0.5rem",
    marginTop: "0.5rem",
  };

  return (
    <div>
      {/* Progress bar */}
      {running && (
        <div style={{ marginBottom: "0.75rem" }}>
          <div style={{
            height: 3,
            background: "var(--color-border)",
            borderRadius: 2,
            overflow: "hidden",
          }}>
            <div style={{
              height: "100%",
              width: `${progress * 100}%`,
              background: "var(--color-accent)",
              transition: "width 0.2s",
            }} />
          </div>
          <div style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", marginTop: "0.2rem" }}>
            Running {Math.round(progress * 10000).toLocaleString()} / 10,000 simulations...
          </div>
        </div>
      )}

      {!result && !running && (
        <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", padding: "1rem 0" }}>
          Monte Carlo simulation will run automatically when assumptions are set.
        </div>
      )}

      {result && (
        <>
          {/* Percentile summary */}
          <div style={{
            display: "flex",
            gap: "1.5rem",
            marginBottom: "0.75rem",
            fontSize: "0.8rem",
          }}>
            <span>P5: <strong>{formatPct(result.percentiles.p5)}</strong></span>
            <span>P25: <strong>{formatPct(result.percentiles.p25)}</strong></span>
            <span>Median: <strong style={{ color: "var(--color-accent)" }}>{formatPct(result.percentiles.p50)}</strong></span>
            <span>P75: <strong>{formatPct(result.percentiles.p75)}</strong></span>
            <span>P95: <strong>{formatPct(result.percentiles.p95)}</strong></span>
            <span style={{ marginLeft: "auto", color: "var(--color-text-muted)" }}>
              {result.runCount.toLocaleString()} runs
            </span>
          </div>

          {/* IRR Histogram */}
          <div style={labelStyle}>IRR Distribution</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={histogramData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 9 }}
                interval={4}
              />
              <YAxis
                tick={{ fontSize: 9 }}
                tickFormatter={(v) => `${v.toFixed(0)}%`}
                width={35}
              />
              <Tooltip
                formatter={(value: number) => [`${value.toFixed(1)}%`, "Frequency"]}
                labelFormatter={(label) => `IRR ${label}`}
              />
              <Bar
                dataKey="pct"
                fill="var(--color-accent)"
                radius={[1, 1, 0, 0]}
                isAnimationActive={false}
              />
              <ReferenceLine
                x={histogramData.find(d => d.mid >= (result.percentiles.p5 ?? 0) && d.mid < (result.percentiles.p5 ?? 0) + 0.02)?.bucket}
                stroke="#c00"
                strokeDasharray="3 3"
                label={{ value: "P5", position: "top", fontSize: 9, fill: "#c00" }}
              />
              <ReferenceLine
                x={histogramData.find(d => d.mid >= (result.percentiles.p50 ?? 0) && d.mid < (result.percentiles.p50 ?? 0) + 0.02)?.bucket}
                stroke="var(--color-accent)"
                strokeDasharray="3 3"
                label={{ value: "P50", position: "top", fontSize: 9 }}
              />
              <ReferenceLine
                x={histogramData.find(d => d.mid >= (result.percentiles.p95 ?? 0) && d.mid < (result.percentiles.p95 ?? 0) + 0.02)?.bucket}
                stroke="#0a0"
                strokeDasharray="3 3"
                label={{ value: "P95", position: "top", fontSize: 9, fill: "#0a0" }}
              />
            </BarChart>
          </ResponsiveContainer>

          {/* OC Failure Timeline */}
          {result.ocFailureByQuarter.some(q => q.failurePct > 0) && (
            <>
              <div style={labelStyle}>OC Test Failure Probability by Quarter</div>
              <ResponsiveContainer width="100%" height={120}>
                <AreaChart data={result.ocFailureByQuarter} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <XAxis
                    dataKey="quarter"
                    tick={{ fontSize: 9 }}
                    tickFormatter={(q) => `Q${q}`}
                    interval={3}
                  />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    tickFormatter={(v) => `${v.toFixed(0)}%`}
                    width={35}
                    domain={[0, "auto"]}
                  />
                  <Tooltip
                    formatter={(value: number) => [`${value.toFixed(1)}%`, "Failure probability"]}
                    labelFormatter={(q) => `Quarter ${q}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="failurePct"
                    stroke="#c60"
                    fill="#c60"
                    fillOpacity={0.3}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/solal/Documents/GitHub/funzies/web && npx tsc --noEmit`
Expected: Clean output

- [ ] **Step 3: Commit**

```bash
git add web/app/clo/waterfall/MonteCarloChart.tsx
git commit -m "feat: add Monte Carlo IRR histogram and OC failure timeline charts"
```

---

### Task 6: Wire Monte Carlo into ProjectionModel

**Files:**
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx`

- [ ] **Step 1: Add imports**

Add at the top of the file with other imports:

```typescript
import { useMonteCarlo } from "@/lib/clo/useMonteCarlo";
import MonteCarloChart from "./MonteCarloChart";
```

- [ ] **Step 2: Add the hook call**

Inside the component function, after the `sensitivity` useMemo (around line 323), add:

```typescript
  const mc = useMonteCarlo(validationErrors.length === 0 ? inputs : null);
```

This passes `null` when inputs are invalid (so the MC doesn't run), and auto-runs with debounce whenever valid inputs change.

- [ ] **Step 3: Add the Monte Carlo section to the transparency area**

Find the transparency section (inside `{showTransparency && (` block, around line 591). After the `<SensitivityTable>` line (line 593) and before the Model Inputs panel, add:

```typescript
                {/* Monte Carlo Analysis */}
                <div style={{
                  fontSize: "0.68rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--color-text-muted)",
                  marginBottom: "0.5rem",
                  marginTop: "1rem",
                }}>
                  Monte Carlo Analysis (10,000 runs)
                </div>
                <MonteCarloChart
                  result={mc.result}
                  running={mc.running}
                  progress={mc.progress}
                />
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/solal/Documents/GitHub/funzies/web && npx tsc --noEmit`
Expected: Clean output

- [ ] **Step 5: Commit**

```bash
git add web/app/clo/waterfall/ProjectionModel.tsx
git commit -m "feat: wire Monte Carlo hook and charts into waterfall projection model"
```

---

### Task 7: Final verification

- [ ] **Step 1: TypeScript full compile**

Run: `cd /Users/solal/Documents/GitHub/funzies/web && npx tsc --noEmit`
Expected: Clean, no errors

- [ ] **Step 2: Manual test**

1. Open the waterfall page in the browser
2. Verify the deterministic projection still renders correctly (IRR card, payoff timeline, cash flows)
3. Open the Transparency section
4. Verify "Monte Carlo Analysis (10,000 runs)" section appears
5. Verify progress bar shows during computation (~2-5s)
6. Verify IRR histogram renders with P5/P50/P95 reference lines
7. Verify OC failure timeline renders (if any runs had OC failures)
8. Change a slider (e.g., CDR) and verify Monte Carlo auto-reruns after ~500ms
9. Verify the UI stays responsive during computation (no freezing)

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "feat: complete Monte Carlo simulation for CLO waterfall projection"
```
