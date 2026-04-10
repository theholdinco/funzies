# Switch Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Switch Simulator tab to the waterfall page that shares assumption state with the Projection tab, allowing instant loan swap analysis without generating a full AI analysis.

**Architecture:** New `SwitchSimulator.tsx` component rendered conditionally via tab state in `ProjectionModel.tsx`. Shares all assumption state via props. Uses existing `applySwitch()` from `switch-simulator.ts` with user assumptions instead of hardcoded defaults. Server page passes holdings + buy list data.

**Tech Stack:** React client components, TypeScript, inline styles (existing pattern).

**Spec:** `docs/superpowers/specs/2026-04-10-switch-simulator-design.md`

---

### Task 1: Pass holdings and buy list data from server page

**Files:**
- Modify: `web/app/clo/waterfall/page.tsx`
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx` (Props interface only)

- [ ] **Step 1: Update page.tsx to fetch buy list and pass both to ProjectionModel**

In `web/app/clo/waterfall/page.tsx`, add the buy list import and fetch:

Add to imports:
```typescript
import { getBuyListForUser } from "@/lib/clo/buy-list";
```

After the `const panel = ...` line (around line 50), add:
```typescript
const buyList = await getBuyListForUser(session.user.id);
```

Add `buyList` prop to the ProjectionModel component:
```tsx
<ProjectionModel
  ... existing props ...
  buyList={buyList}
/>
```

- [ ] **Step 2: Update ProjectionModel Props interface**

In `web/app/clo/waterfall/ProjectionModel.tsx`, add to the Props interface:

```typescript
import type { BuyListItem } from "@/lib/clo/types";
```

Add to Props:
```typescript
  buyList?: BuyListItem[];
```

Add to the destructured props in the component function:
```typescript
export default function ProjectionModel({
  ... existing props ...,
  buyList,
}: Props) {
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — must be clean (buyList is optional, so nothing breaks)

- [ ] **Step 4: Commit**

```bash
git add web/app/clo/waterfall/page.tsx web/app/clo/waterfall/ProjectionModel.tsx
git commit -m "feat: pass holdings and buy list data to ProjectionModel"
```

---

### Task 2: Add tab state and tab bar to ProjectionModel

**Files:**
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx`

- [ ] **Step 1: Add tab state**

Add near the other useState declarations:
```typescript
const [activeTab, setActiveTab] = useState<"projection" | "switch">("projection");
```

- [ ] **Step 2: Add tab bar rendering**

Right at the start of the component's return JSX (before the assumptions section), add a tab bar. Find the opening `<div className="wf-section"` and add the tab bar right after the opening div:

```tsx
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 0, marginBottom: "1.5rem", borderBottom: "2px solid var(--color-border-light)" }}>
        {(["projection", "switch"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "0.6rem 1.25rem",
              fontSize: "0.8rem",
              fontWeight: activeTab === tab ? 600 : 400,
              fontFamily: "var(--font-body)",
              color: activeTab === tab ? "var(--color-text)" : "var(--color-text-muted)",
              background: "none",
              border: "none",
              borderBottom: activeTab === tab ? "2px solid var(--color-accent)" : "2px solid transparent",
              marginBottom: "-2px",
              cursor: "pointer",
              transition: "color 0.15s",
            }}
          >
            {tab === "projection" ? "Projection" : "Switch Simulator"}
          </button>
        ))}
      </div>
```

- [ ] **Step 3: Wrap existing projection content in conditional**

Wrap ALL the existing content after the tab bar (assumptions, validation, results, everything) in:

```tsx
{activeTab === "projection" && (
  <>
    {/* ... all existing projection content ... */}
  </>
)}

{activeTab === "switch" && (
  <div style={{ color: "var(--color-text-muted)", padding: "2rem", textAlign: "center", fontSize: "0.85rem" }}>
    Switch Simulator — coming in Task 3
  </div>
)}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` — must be clean
Visually: tabs should render, clicking "Switch Simulator" shows placeholder, "Projection" shows existing content.

- [ ] **Step 5: Commit**

```bash
git add web/app/clo/waterfall/ProjectionModel.tsx
git commit -m "feat: add tab bar to waterfall page (Projection / Switch Simulator)"
```

---

### Task 3: Create SwitchSimulator component

**Files:**
- Create: `web/app/clo/waterfall/SwitchSimulator.tsx`

- [ ] **Step 1: Create the full SwitchSimulator component**

Create `web/app/clo/waterfall/SwitchSimulator.tsx`:

```tsx
"use client";

import React, { useState, useMemo } from "react";
import type { ResolvedDealData, ResolvedLoan } from "@/lib/clo/resolver-types";
import type { CloHolding, BuyListItem } from "@/lib/clo/types";
import type { UserAssumptions } from "@/lib/clo/build-projection-inputs";
import { applySwitch } from "@/lib/clo/switch-simulator";
import { runProjection } from "@/lib/clo/projection";
import { RATING_BUCKETS } from "@/lib/clo/rating-mapping";
import { mapToRatingBucket } from "@/lib/clo/rating-mapping";
import { formatAmount, formatPct } from "./helpers";

interface Props {
  resolved: ResolvedDealData;
  holdings: CloHolding[];
  buyList: BuyListItem[];
  userAssumptions: UserAssumptions;
}

function formatDelta(before: number | null, after: number | null): { text: string; color: string } {
  if (before == null || after == null) return { text: "—", color: "inherit" };
  const delta = after - before;
  const sign = delta >= 0 ? "+" : "";
  return {
    text: `${sign}${(delta * 100).toFixed(2)}%`,
    color: delta > 0 ? "var(--color-high)" : delta < 0 ? "var(--color-low)" : "inherit",
  };
}

function formatAmountDelta(before: number, after: number): { text: string; color: string } {
  const delta = after - before;
  return {
    text: formatAmount(delta),
    color: delta > 0 ? "var(--color-high)" : delta < 0 ? "var(--color-low)" : "inherit",
  };
}

export function SwitchSimulator({ resolved, holdings, buyList, userAssumptions }: Props) {
  const [sellLoanIndex, setSellLoanIndex] = useState<number | null>(null);
  const [buySpreadBps, setBuySpreadBps] = useState(350);
  const [buyRating, setBuyRating] = useState("B");
  const [buyMaturity, setBuyMaturity] = useState(resolved.dates.maturity);
  const [buyParAmount, setBuyParAmount] = useState(0);
  const [sellPrice, setSellPrice] = useState(100);
  const [buyPrice, setBuyPrice] = useState(100);

  // When sell loan changes, default buy par to match
  const sellLoan = sellLoanIndex !== null ? resolved.loans[sellLoanIndex] : null;
  React.useEffect(() => {
    if (sellLoan) setBuyParAmount(sellLoan.parBalance);
  }, [sellLoan]);

  // Build sell loan dropdown options from holdings + resolved loans
  const sellOptions = useMemo(() => {
    return resolved.loans.map((loan, idx) => {
      const holding = holdings.find(
        (h) => h.spreadBps === loan.spreadBps && Math.abs((h.parBalance ?? 0) - loan.parBalance) < 1
      );
      const name = holding?.obligorName ?? `Loan ${idx + 1}`;
      return { idx, name, loan };
    });
  }, [resolved.loans, holdings]);

  // Pre-fill manual fields from buy list selection
  const handleBuyListSelect = (item: BuyListItem) => {
    if (item.spreadBps) setBuySpreadBps(item.spreadBps);
    if (item.moodysRating || item.spRating) {
      setBuyRating(mapToRatingBucket(item.moodysRating ?? null, item.spRating ?? null, null, null));
    }
    if (item.maturityDate) setBuyMaturity(item.maturityDate);
    if (item.parBalance) setBuyParAmount(item.parBalance);
  };

  // Build buy loan from manual fields
  const buyLoan: ResolvedLoan = useMemo(() => ({
    parBalance: buyParAmount,
    maturityDate: buyMaturity,
    ratingBucket: buyRating,
    spreadBps: buySpreadBps,
  }), [buyParAmount, buyMaturity, buyRating, buySpreadBps]);

  // Run switch simulation
  const { switchResult, baseResult, switchedResult } = useMemo(() => {
    if (sellLoanIndex === null) return { switchResult: null, baseResult: null, switchedResult: null };
    const sr = applySwitch(
      resolved,
      { sellLoanIndex, buyLoan, sellPrice, buyPrice },
      userAssumptions,
    );
    const br = runProjection(sr.baseInputs);
    const swr = runProjection(sr.switchedInputs);
    return { switchResult: sr, baseResult: br, switchedResult: swr };
  }, [resolved, sellLoanIndex, buyLoan, sellPrice, buyPrice, userAssumptions]);

  const cellStyle: React.CSSProperties = {
    padding: "0.5rem 0.75rem",
    fontSize: "0.8rem",
    fontFamily: "var(--font-mono)",
    textAlign: "right",
  };
  const headerStyle: React.CSSProperties = {
    ...cellStyle,
    fontWeight: 600,
    fontSize: "0.7rem",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
    fontFamily: "var(--font-body)",
  };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "0.4rem 0.5rem",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--color-border-light)",
    fontSize: "0.8rem",
    fontFamily: "var(--font-mono)",
    background: "var(--color-surface)",
    color: "var(--color-text)",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: "0.72rem",
    color: "var(--color-text-muted)",
    fontWeight: 500,
    marginBottom: "0.3rem",
  };

  return (
    <div>
      {/* Sell loan selection */}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={labelStyle}>Sell Loan (from portfolio)</div>
        <select
          value={sellLoanIndex ?? ""}
          onChange={(e) => setSellLoanIndex(e.target.value ? parseInt(e.target.value) : null)}
          style={{ ...inputStyle, maxWidth: "32rem" }}
        >
          <option value="">Select a loan to sell...</option>
          {sellOptions.map((opt) => (
            <option key={opt.idx} value={opt.idx}>
              {opt.name} — {opt.loan.ratingBucket} / {opt.loan.spreadBps} bps — {formatAmount(opt.loan.parBalance)} par
            </option>
          ))}
        </select>
      </div>

      {/* Buy loan input */}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={labelStyle}>Buy Loan</div>
        {buyList.length > 0 && (
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.65rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>From buy list (pre-fills fields below)</div>
            <select
              onChange={(e) => {
                const item = buyList[parseInt(e.target.value)];
                if (item) handleBuyListSelect(item);
              }}
              style={{ ...inputStyle, maxWidth: "32rem" }}
              defaultValue=""
            >
              <option value="">Pick from buy list...</option>
              {buyList.map((item, i) => (
                <option key={item.id} value={i}>
                  {item.obligorName} — {item.spreadBps ?? "?"} bps — {item.moodysRating ?? item.spRating ?? "NR"}
                </option>
              ))}
            </select>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem", maxWidth: "32rem" }}>
          <div>
            <div style={labelStyle}>Spread (bps)</div>
            <input type="number" value={buySpreadBps} onChange={(e) => setBuySpreadBps(parseFloat(e.target.value) || 0)} style={inputStyle} />
          </div>
          <div>
            <div style={labelStyle}>Rating</div>
            <select value={buyRating} onChange={(e) => setBuyRating(e.target.value)} style={inputStyle}>
              {RATING_BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <div style={labelStyle}>Maturity</div>
            <input type="date" value={buyMaturity} onChange={(e) => setBuyMaturity(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <div style={labelStyle}>Par Amount</div>
            <input type="number" value={buyParAmount} onChange={(e) => setBuyParAmount(parseFloat(e.target.value) || 0)} style={inputStyle} />
          </div>
        </div>
      </div>

      {/* Transaction costs */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", fontSize: "0.8rem" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          Sell price:
          <input type="number" value={sellPrice} onChange={(e) => setSellPrice(parseFloat(e.target.value) || 100)} style={{ width: "4rem", padding: "0.3rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border-light)", fontSize: "0.8rem", fontFamily: "var(--font-mono)" }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          Buy price:
          <input type="number" value={buyPrice} onChange={(e) => setBuyPrice(parseFloat(e.target.value) || 100)} style={{ width: "4rem", padding: "0.3rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border-light)", fontSize: "0.8rem", fontFamily: "var(--font-mono)" }} />
        </label>
      </div>

      {/* Results */}
      {sellLoanIndex === null && (
        <div style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.85rem", border: "1px dashed var(--color-border-light)", borderRadius: "var(--radius-sm)" }}>
          Select a loan to sell to see the switch impact
        </div>
      )}

      {switchResult && baseResult && switchedResult && (
        <div>
          {/* Impact summary table */}
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1.25rem", maxWidth: "48rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--color-border)" }}>
                <th style={{ ...headerStyle, textAlign: "left" }}>Metric</th>
                <th style={headerStyle}>Before</th>
                <th style={headerStyle}>After</th>
                <th style={headerStyle}>Delta</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left", fontWeight: 600 }}>Equity IRR</td>
                <td style={cellStyle}>{baseResult.equityIrr !== null ? formatPct(baseResult.equityIrr * 100) : "—"}</td>
                <td style={cellStyle}>{switchedResult.equityIrr !== null ? formatPct(switchedResult.equityIrr * 100) : "—"}</td>
                <td style={{ ...cellStyle, color: formatDelta(baseResult.equityIrr, switchedResult.equityIrr).color, fontWeight: 600 }}>
                  {formatDelta(baseResult.equityIrr, switchedResult.equityIrr).text}
                </td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Total Equity Distributions</td>
                <td style={cellStyle}>{formatAmount(baseResult.totalEquityDistributions)}</td>
                <td style={cellStyle}>{formatAmount(switchedResult.totalEquityDistributions)}</td>
                <td style={{ ...cellStyle, ...(() => { const d = formatAmountDelta(baseResult.totalEquityDistributions, switchedResult.totalEquityDistributions); return { color: d.color }; })() }}>
                  {formatAmountDelta(baseResult.totalEquityDistributions, switchedResult.totalEquityDistributions).text}
                </td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Spread (swapped position)</td>
                <td style={cellStyle}>{sellLoan?.spreadBps ?? "—"} bps</td>
                <td style={cellStyle}>{buySpreadBps} bps</td>
                <td style={{ ...cellStyle, color: switchResult.spreadDelta >= 0 ? "var(--color-high)" : "var(--color-low)" }}>
                  {switchResult.spreadDelta >= 0 ? "+" : ""}{switchResult.spreadDelta} bps
                </td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Rating (swapped position)</td>
                <td style={cellStyle}>{switchResult.ratingChange.from}</td>
                <td style={cellStyle}>{switchResult.ratingChange.to}</td>
                <td style={cellStyle}>{switchResult.ratingChange.from} → {switchResult.ratingChange.to}</td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Par Impact</td>
                <td style={cellStyle}>—</td>
                <td style={cellStyle}>—</td>
                <td style={{ ...cellStyle, color: switchResult.parDelta >= 0 ? "var(--color-high)" : "var(--color-low)", fontWeight: 600 }}>
                  {formatAmount(switchResult.parDelta)}
                </td>
              </tr>
            </tbody>
          </table>

          {/* OC Cushion & Equity Distribution Detail (collapsible) */}
          <OcEquityDetail baseResult={baseResult} switchedResult={switchedResult} />
        </div>
      )}
    </div>
  );
}

function OcEquityDetail({ baseResult, switchedResult }: { baseResult: ReturnType<typeof runProjection>; switchedResult: ReturnType<typeof runProjection> }) {
  const [expanded, setExpanded] = useState(false);
  const baseOc = baseResult.periods[0]?.ocTests ?? [];
  const switchedOc = switchedResult.periods[0]?.ocTests ?? [];

  const cellStyle: React.CSSProperties = { padding: "0.5rem 0.75rem", fontSize: "0.8rem", fontFamily: "var(--font-mono)", textAlign: "right" };
  const headerStyle: React.CSSProperties = { ...cellStyle, fontWeight: 600, fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", fontFamily: "var(--font-body)" };

  return (
    <div style={{ border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)" }}>
      <button onClick={() => setExpanded(!expanded)} style={{ width: "100%", display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.6rem 0.8rem", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem", color: "var(--color-text-muted)", fontFamily: "var(--font-body)" }}>
        <span style={{ fontSize: "0.65rem" }}>{expanded ? "▾" : "▸"}</span>
        OC Cushion & Cash Flow Detail
      </button>
      {expanded && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          {/* OC Cushion */}
          <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>
            OC Cushion Changes (Period 1)
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--color-border)" }}>
                <th style={{ ...headerStyle, textAlign: "left" }}>Class</th>
                <th style={headerStyle}>Before</th>
                <th style={headerStyle}>After</th>
                <th style={headerStyle}>Delta</th>
              </tr>
            </thead>
            <tbody>
              {baseOc.map((oc, i) => {
                const sw = switchedOc[i];
                const delta = sw ? sw.actual - oc.actual : 0;
                return (
                  <tr key={oc.className} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                    <td style={{ ...cellStyle, textAlign: "left", fontWeight: 500 }}>{oc.className}</td>
                    <td style={cellStyle}>{oc.actual.toFixed(2)}%</td>
                    <td style={cellStyle}>{sw ? sw.actual.toFixed(2) : "—"}%</td>
                    <td style={{ ...cellStyle, color: delta >= 0 ? "var(--color-high)" : "var(--color-low)" }}>
                      {delta >= 0 ? "+" : ""}{delta.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Equity Distribution Delta */}
          <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>
            Equity Distribution Delta (First 12 Quarters)
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--color-border)" }}>
                <th style={{ ...headerStyle, textAlign: "left" }}>Quarter</th>
                <th style={headerStyle}>Before</th>
                <th style={headerStyle}>After</th>
                <th style={headerStyle}>Delta</th>
              </tr>
            </thead>
            <tbody>
              {baseResult.periods.slice(0, 12).map((p, i) => {
                const sw = switchedResult.periods[i];
                const delta = sw ? sw.equityDistribution - p.equityDistribution : 0;
                return (
                  <tr key={p.periodNum} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                    <td style={{ ...cellStyle, textAlign: "left", fontWeight: 500 }}>Q{p.periodNum}</td>
                    <td style={cellStyle}>{formatAmount(p.equityDistribution)}</td>
                    <td style={cellStyle}>{sw ? formatAmount(sw.equityDistribution) : "—"}</td>
                    <td style={{ ...cellStyle, color: delta >= 0 ? "var(--color-high)" : "var(--color-low)" }}>
                      {formatAmount(delta)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit` — should be clean (component is created but not yet imported)

- [ ] **Step 3: Commit**

```bash
git add web/app/clo/waterfall/SwitchSimulator.tsx
git commit -m "feat: create SwitchSimulator component"
```

---

### Task 4: Wire SwitchSimulator into ProjectionModel tab

**Files:**
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx`

- [ ] **Step 1: Import SwitchSimulator and build userAssumptions**

Add import:
```typescript
import { SwitchSimulator } from "./SwitchSimulator";
```

Inside the component, after the `inputs` useMemo, create a `userAssumptions` object that matches the `UserAssumptions` interface. This is the same data that feeds `buildFromResolved` — extract it so we can pass to both the projection and the switch:

```typescript
const userAssumptions: UserAssumptions = useMemo(() => ({
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
  postRpReinvestmentPct,
  hedgeCostBps,
  callDate,
  seniorFeePct,
  subFeePct,
  trusteeFeeBps,
  incentiveFeePct,
  incentiveFeeHurdleIrr,
}), [
  baseRatePct, defaultRates, cprPct, recoveryPct, recoveryLagMonths,
  reinvestmentSpreadBps, reinvestmentTenorYears, reinvestmentRating, cccBucketLimitPct, cccMarketValuePct,
  constraints.interestMechanics?.deferredInterestCompounds,
  postRpReinvestmentPct, hedgeCostBps, callDate, seniorFeePct, subFeePct, trusteeFeeBps, incentiveFeePct, incentiveFeeHurdleIrr,
]);
```

Also add the `UserAssumptions` type import:
```typescript
import { buildFromResolved, EMPTY_RESOLVED, type UserAssumptions } from "@/lib/clo/build-projection-inputs";
```

- [ ] **Step 2: Replace the placeholder switch tab content**

Find the placeholder:
```tsx
{activeTab === "switch" && (
  <div style={{ color: "var(--color-text-muted)", padding: "2rem", textAlign: "center", fontSize: "0.85rem" }}>
    Switch Simulator — coming in Task 3
  </div>
)}
```

Replace with the full switch simulator including collapsible assumptions:

```tsx
{activeTab === "switch" && resolved && (
  <div>
    <SwitchSimulator
      resolved={resolved}
      holdings={holdings}
      buyList={buyList ?? []}
      userAssumptions={userAssumptions}
    />

    {/* Assumptions — same sliders, collapsed by default */}
    <div style={{ marginTop: "1.5rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)" }}>
      <button
        onClick={() => setShowSwitchAssumptions(!showSwitchAssumptions)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.6rem 0.8rem", background: "none", border: "none", cursor: "pointer", fontSize: "0.8rem", fontWeight: 600, color: "var(--color-text-secondary)", textAlign: "left", fontFamily: "var(--font-body)" }}
      >
        <span style={{ fontSize: "0.65rem" }}>{showSwitchAssumptions ? "▾" : "▸"}</span>
        Assumptions
      </button>
      {showSwitchAssumptions && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1.25rem" }}>
            <SliderInput label="CPR (Annual Prepay Rate)" value={cprPct} onChange={setCprPct} min={0} max={30} step={0.5} suffix="%" hint="Constant annual prepayment rate." />
            <SliderInput label="Recovery Rate" value={recoveryPct} onChange={setRecoveryPct} min={0} max={80} step={1} suffix="%" hint="Percentage of defaulted par recovered." />
            <SliderInput label="Recovery Lag" value={recoveryLagMonths} onChange={setRecoveryLagMonths} min={0} max={24} step={1} suffix=" mo" hint="Months between default and recovery." />
            <SliderInput label="Base Rate (EURIBOR)" value={baseRatePct} onChange={setBaseRatePct} min={0} max={8} step={0.25} suffix="%" hint="Held flat. Floored at 0%." />
          </div>
          <FeeAssumptions
            seniorFeePct={seniorFeePct} onSeniorFeeChange={setSeniorFeePct}
            subFeePct={subFeePct} onSubFeeChange={setSubFeePct}
            trusteeFeeBps={trusteeFeeBps} onTrusteeFeeChange={setTrusteeFeeBps}
            hedgeCostBps={hedgeCostBps} onHedgeCostChange={setHedgeCostBps}
            incentiveFeePct={incentiveFeePct} onIncentiveFeeChange={setIncentiveFeePct}
            incentiveFeeHurdleIrr={incentiveFeeHurdleIrr} onHurdleChange={setIncentiveFeeHurdleIrr}
            hasResolvedFees={!!resolved && (resolved.fees.seniorFeePct > 0 || resolved.fees.subFeePct > 0)}
            callDate={callDate} onCallDateChange={setCallDate}
          />
          <div style={{ marginTop: "0.75rem" }}>
            <DefaultRatePanel
              defaultRates={defaultRates}
              onChange={setDefaultRates}
              ratingDistribution={ratingDistribution}
              weightedAvgCdr={weightedAvgCdr}
            />
          </div>
        </div>
      )}
    </div>
  </div>
)}
```

Add the state variable for the collapsible:
```typescript
const [showSwitchAssumptions, setShowSwitchAssumptions] = useState(false);
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — must be clean
Run: `npx vitest run lib/clo/__tests__/` — all tests pass

- [ ] **Step 4: Commit**

```bash
git add web/app/clo/waterfall/ProjectionModel.tsx
git commit -m "feat: wire SwitchSimulator into waterfall page tab"
```

---

### Task 5: Update existing SwitchWaterfallImpact to accept assumptions

**Files:**
- Modify: `web/components/clo/SwitchWaterfallImpact.tsx`

- [ ] **Step 1: Add optional assumptions prop**

Change the Props interface:
```typescript
import type { UserAssumptions } from "@/lib/clo/build-projection-inputs";

interface Props {
  resolved: ResolvedDealData;
  sellLoan: LoanDescription;
  buyLoan: LoanDescription;
  assumptions?: UserAssumptions;  // optional — defaults to DEFAULT_ASSUMPTIONS for backward compat
}
```

- [ ] **Step 2: Use the prop**

In the component, change:
```typescript
export default function SwitchWaterfallImpact({ resolved, sellLoan, buyLoan }: Props) {
```
To:
```typescript
export default function SwitchWaterfallImpact({ resolved, sellLoan, buyLoan, assumptions }: Props) {
```

And change the `applySwitch` call from:
```typescript
DEFAULT_ASSUMPTIONS,
```
To:
```typescript
assumptions ?? DEFAULT_ASSUMPTIONS,
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — must be clean (existing callers don't pass `assumptions`, so they get the default)

- [ ] **Step 4: Commit**

```bash
git add web/components/clo/SwitchWaterfallImpact.tsx
git commit -m "feat: SwitchWaterfallImpact accepts optional assumptions prop"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run lib/clo/__tests__/
```
Expected: All tests pass

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: complete switch simulator tab on waterfall page"
```
