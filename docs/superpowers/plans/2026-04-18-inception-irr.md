# Inception IRR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backward-looking inception IRR based on user-entered historical equity distributions, displayed alongside the existing forward-projected IRR.

**Architecture:** New JSONB column on `clo_profiles` stores purchase date, purchase price (cents), and an array of past payment entries. The Context Editor gets a new collapsible section for editing these. The waterfall page passes the data to ProjectionModel, which computes inception IRR client-side using the existing `calculateIrr()` function.

**Tech Stack:** Next.js (App Router), React, PostgreSQL (JSONB), TypeScript

---

### Task 1: Migration — add `equity_inception_data` column

**Files:**
- Create: `web/lib/migrations/007_add_equity_inception_data.sql`

- [ ] **Step 1: Create the migration file**

```sql
ALTER TABLE clo_profiles
  ADD COLUMN IF NOT EXISTS equity_inception_data JSONB DEFAULT NULL;
```

- [ ] **Step 2: Run the migration**

Run: `psql $DATABASE_URL -f web/lib/migrations/007_add_equity_inception_data.sql`
Expected: `ALTER TABLE` with no errors.

- [ ] **Step 3: Commit**

```bash
git add web/lib/migrations/007_add_equity_inception_data.sql
git commit -m "migration: add equity_inception_data column to clo_profiles"
```

---

### Task 2: Type definitions and data access

**Files:**
- Modify: `web/lib/clo/types/entities.ts:482-503` (CloProfile interface)
- Modify: `web/lib/clo/access.ts:30-53` (rowToProfile)
- Modify: `web/lib/clo/access.ts:57-85` (getProfileForUser query)

- [ ] **Step 1: Add the EquityInceptionData types to entities.ts**

In `web/lib/clo/types/entities.ts`, add before the `CloProfile` interface (around line 481):

```ts
export interface EquityPastPayment {
  date: string;
  distribution: number | null;
}

export interface EquityInceptionData {
  purchaseDate: string | null;
  purchasePriceCents: number | null;
  payments: EquityPastPayment[];
}
```

Then add to the `CloProfile` interface (after `extractedPortfolio`):

```ts
  equityInceptionData: EquityInceptionData | null;
```

- [ ] **Step 2: Update rowToProfile in access.ts**

In `web/lib/clo/access.ts`, in the `rowToProfile` function, add after the `extractedPortfolio` line:

```ts
    equityInceptionData: (row.equity_inception_data as CloProfile["equityInceptionData"]) || null,
```

Add `EquityInceptionData` to the import from `./types` if needed (it's re-exported via the barrel). Actually the import uses `CloProfile` which references it — just need the row mapping.

- [ ] **Step 3: Update getProfileForUser query in access.ts**

In `web/lib/clo/access.ts`, the `getProfileForUser` function's SELECT query (line 79-82) needs `equity_inception_data` added. Add it to both the SELECT column list and the TypeScript generic type parameter.

Add to the type parameter (after `extracted_portfolio: unknown;`):

```ts
    equity_inception_data: unknown;
```

Add to the SELECT string (after `extracted_portfolio`):

```sql
            extracted_constraints, extracted_portfolio, equity_inception_data, created_at, updated_at
```

- [ ] **Step 4: Add EquityInceptionData to the types barrel export**

Check `web/lib/clo/types/index.ts` — if it re-exports from `entities.ts`, the new types will be available automatically. If not, add the export.

- [ ] **Step 5: Commit**

```bash
git add web/lib/clo/types/entities.ts web/lib/clo/access.ts
git commit -m "feat: add EquityInceptionData type and data access"
```

---

### Task 3: API endpoint for saving inception data

**Files:**
- Create: `web/app/api/clo/profile/inception/route.ts`

- [ ] **Step 1: Create the PATCH endpoint**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  const rows = await query<{ id: string }>(
    `UPDATE clo_profiles
     SET equity_inception_data = $1, updated_at = now()
     WHERE user_id = $2
     RETURNING id`,
    [JSON.stringify(body.equityInceptionData), user.id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ profileId: rows[0].id });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/api/clo/profile/inception/route.ts
git commit -m "feat: add API endpoint for equity inception data"
```

---

### Task 4: Context Editor — Equity Inception section

**Files:**
- Modify: `web/app/clo/context/page.tsx:25-31` (pass inception data prop)
- Modify: `web/app/clo/context/ContextEditor.tsx:42-71` (props), `~244-276` (state), `~730+` (render)

- [ ] **Step 1: Pass inception data from page to ContextEditor**

In `web/app/clo/context/page.tsx`, the profile is already loaded via `getProfileForUser` and `rowToProfile`. Add `equityInceptionData` to the ContextEditor props:

```tsx
      <ContextEditor
        constraints={constraints}
        fundProfile={fundProfile}
        complianceData={complianceData}
        tranches={tranches}
        trancheSnapshots={trancheSnapshots}
        holdings={holdings}
        accountBalances={accountBalances}
        parValueAdjustments={parValueAdjustments}
        dealDates={{ maturity: maturityDate, reinvestmentPeriodEnd, reportDate: reportPeriod?.reportDate ?? null }}
        equityInceptionData={profile.equityInceptionData}
      />
```

- [ ] **Step 2: Add the prop to ContextEditor and wire up state**

In `web/app/clo/context/ContextEditor.tsx`, add to the `ContextEditorProps` interface:

```ts
  equityInceptionData?: EquityInceptionData | null;
```

Add import of `EquityInceptionData` from `@/lib/clo/types`.

In the component function signature, destructure the new prop:

```ts
  equityInceptionData: initialInceptionData,
```

Add state:

```ts
  const [inceptionData, setInceptionData] = useState<EquityInceptionData>(
    initialInceptionData ?? { purchaseDate: null, purchasePriceCents: null, payments: [] }
  );
  const [inceptionDirty, setInceptionDirty] = useState(false);
  const [savingInception, setSavingInception] = useState(false);
```

Add the save handler:

```ts
  async function saveInception() {
    setSavingInception(true);
    const res = await fetch("/api/clo/profile/inception", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ equityInceptionData: inceptionData }),
    });
    setSavingInception(false);
    if (res.ok) setInceptionDirty(false);
  }
```

- [ ] **Step 3: Add payment date auto-generation logic**

Add a helper function inside the component (or above it) that generates quarterly payment dates from a purchase date to today:

```ts
  function generateQuarterlyDates(fromDate: string): string[] {
    const dates: string[] = [];
    const start = new Date(fromDate);
    const now = new Date();
    const cursor = new Date(start);
    // Advance to first payment (3 months after purchase)
    cursor.setMonth(cursor.getMonth() + 3);
    while (cursor <= now) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setMonth(cursor.getMonth() + 3);
    }
    return dates;
  }
```

Add an effect that regenerates payments when purchase date changes, preserving existing distribution values:

```ts
  useEffect(() => {
    if (!inceptionData.purchaseDate) return;
    const dates = generateQuarterlyDates(inceptionData.purchaseDate);
    const existingByDate = new Map(inceptionData.payments.map(p => [p.date, p.distribution]));
    const newPayments = dates.map(date => ({
      date,
      distribution: existingByDate.get(date) ?? null,
    }));
    setInceptionData(prev => ({ ...prev, payments: newPayments }));
    setInceptionDirty(true);
  }, [inceptionData.purchaseDate]);
```

Note: this effect intentionally depends only on `purchaseDate` — it regenerates the date grid when the purchase date changes. The `existingByDate` lookup preserves user-entered values for dates that still match.

- [ ] **Step 4: Add the Equity Inception UI section**

In the render section, add after the "Beliefs & Thresholds" section (around line 1220, before the `profileDirty` save button). Place this within Group 3:

```tsx
      {/* Section: Equity Inception */}
      <CollapsibleSection title="Equity Inception">
        <div style={kvRowStyle}>
          <span style={kvLabelStyle}>Purchase Date</span>
          <input
            type="date"
            value={inceptionData.purchaseDate ?? ""}
            onChange={(e) => {
              setInceptionData(prev => ({ ...prev, purchaseDate: e.target.value || null }));
              setInceptionDirty(true);
            }}
            style={{ fontSize: "0.82rem", fontFamily: "var(--font-mono)", padding: "0.2rem 0.4rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)" }}
          />
        </div>
        <div style={kvRowStyle}>
          <span style={kvLabelStyle}>Purchase Price (cents)</span>
          <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
            <input
              type="number"
              step="0.5"
              min="1"
              max="150"
              value={inceptionData.purchasePriceCents ?? ""}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setInceptionData(prev => ({ ...prev, purchasePriceCents: isNaN(v) ? null : v }));
                setInceptionDirty(true);
              }}
              style={{ width: "70px", fontSize: "0.82rem", fontFamily: "var(--font-mono)", padding: "0.2rem 0.4rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)", textAlign: "right" }}
            />
            <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>cents on dollar</span>
          </div>
        </div>

        {inceptionData.payments.length > 0 && (
          <>
            <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 600, margin: "0.8rem 0 0.4rem" }}>
              Past Payments ({inceptionData.payments.filter(p => p.distribution != null).length}/{inceptionData.payments.length} entered)
            </div>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Payment Date</th>
                  <th style={thStyle}>Distribution</th>
                </tr>
              </thead>
              <tbody>
                {inceptionData.payments.map((payment, i) => (
                  <tr key={payment.date}>
                    <td style={tdStyle}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>{payment.date}</span>
                    </td>
                    <td style={tdStyle}>
                      <input
                        type="number"
                        step="1000"
                        min="0"
                        value={payment.distribution ?? ""}
                        placeholder="--"
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          const updated = [...inceptionData.payments];
                          updated[i] = { ...updated[i], distribution: isNaN(v) ? null : v };
                          setInceptionData(prev => ({ ...prev, payments: updated }));
                          setInceptionDirty(true);
                        }}
                        style={{ width: "120px", fontSize: "0.82rem", fontFamily: "var(--font-mono)", padding: "0.2rem 0.4rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)", textAlign: "right" }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {!inceptionData.purchaseDate && (
          <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontStyle: "italic", marginTop: "0.5rem" }}>
            Set a purchase date to generate quarterly payment rows.
          </div>
        )}
      </CollapsibleSection>

      {inceptionDirty && (
        <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={saveInception} disabled={savingInception} style={saveBtnStyle}>
            {savingInception ? "Saving..." : "Save Inception Data"}
          </button>
        </div>
      )}
```

- [ ] **Step 5: Commit**

```bash
git add web/app/clo/context/page.tsx web/app/clo/context/ContextEditor.tsx
git commit -m "feat: add Equity Inception section to Context Editor"
```

---

### Task 5: Pipe inception data to waterfall and display IRR

**Files:**
- Modify: `web/app/clo/waterfall/page.tsx:126-140` (pass prop)
- Modify: `web/app/clo/waterfall/ProjectionModel.tsx:40-54` (Props), `~119` (state), `~554-591` (IRR display)

- [ ] **Step 1: Pass inception data from waterfall page to ProjectionModel**

In `web/app/clo/waterfall/page.tsx`, the profile is already loaded. Add `equityInceptionData` prop to the `<ProjectionModel>` component (around line 126):

```tsx
      <ProjectionModel
        maturityDate={maturityDate}
        reinvestmentPeriodEnd={reinvestmentPeriodEnd}
        tranches={tranches}
        trancheSnapshots={trancheSnapshots}
        poolSummary={periodData?.poolSummary ?? null}
        complianceTests={periodData?.complianceTests ?? []}
        constraints={constraints}
        holdings={holdings}
        panelId={panel?.id ?? null}
        dealContext={dealContext}
        resolved={resolved}
        resolutionWarnings={resolutionWarnings}
        buyList={buyList}
        equityInceptionData={profile.equityInceptionData}
      />
```

- [ ] **Step 2: Accept the prop in ProjectionModel**

In `web/app/clo/waterfall/ProjectionModel.tsx`, add to the `Props` interface:

```ts
  equityInceptionData?: EquityInceptionData | null;
```

Add the import:

```ts
import type { EquityInceptionData } from "@/lib/clo/types";
```

Destructure from props in the component function (alongside the other destructured props).

- [ ] **Step 3: Compute inception IRR**

Add a `useMemo` after the existing `equityEntryPrice` memo (around line 196):

```ts
  const inceptionIrr = useMemo(() => {
    const data = equityInceptionData;
    if (!data?.purchaseDate || data.purchasePriceCents == null || !equityMetrics) return null;
    const { payments } = data;
    if (payments.length === 0) return null;
    if (payments.some(p => p.distribution == null)) return null;

    const purchasePrice = equityMetrics.subPar * data.purchasePriceCents / 100;
    if (purchasePrice <= 0) return null;

    const cashFlows = [-purchasePrice, ...payments.map(p => p.distribution!)];
    const { calculateIrr } = require("@/lib/clo/projection");
    return calculateIrr(cashFlows, 4);
  }, [equityInceptionData, equityMetrics]);
```

Note: `calculateIrr` is already exported from `@/lib/clo/projection`. Use a static import at the top of the file instead of `require`:

```ts
import {
  runProjection,
  validateInputs,
  calculateIrr,
  type ProjectionInputs,
  type ProjectionResult,
  type LoanInput,
} from "@/lib/clo/projection";
```

Then the memo body uses `calculateIrr` directly (no require).

- [ ] **Step 4: Display inception IRR alongside forward IRR**

In the summary cards grid (around line 547), change the grid from `1fr 1fr 1fr` to `1fr 1fr 1fr 1fr` to accommodate a fourth card. Then add the inception IRR card right after the forward IRR card (after line 591, before the `<SummaryCard label="Total Equity Distributions"` line):

```tsx
            {/* Inception IRR card */}
            <div
              style={{
                padding: "1.25rem",
                background: equityInceptionData?.purchaseDate
                  ? "linear-gradient(135deg, #059669 0%, #047857 100%)"
                  : "var(--color-surface)",
                borderRadius: "var(--radius-sm)",
                textAlign: "center",
                position: "relative",
                overflow: "hidden",
                border: equityInceptionData?.purchaseDate ? "none" : "1px solid var(--color-border)",
              }}
            >
              <div style={{
                fontSize: "0.7rem",
                fontWeight: 500,
                color: equityInceptionData?.purchaseDate ? "rgba(255,255,255,0.7)" : "var(--color-text-muted)",
                marginBottom: "0.35rem",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}>
                Inception IRR <span style={{ fontSize: "0.55rem", fontWeight: 400, letterSpacing: "0.02em", opacity: 0.7 }}>(actual)</span>
              </div>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1.8rem",
                  fontWeight: 700,
                  color: equityInceptionData?.purchaseDate ? "#fff" : "var(--color-text-muted)",
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "-0.02em",
                }}
              >
                {inceptionIrr !== null
                  ? formatPct(inceptionIrr * 100)
                  : "-- %"}
              </div>
              {equityInceptionData?.purchaseDate && inceptionIrr === null && (
                <div style={{ fontSize: "0.6rem", color: "rgba(255,255,255,0.5)", marginTop: "0.2rem" }}>
                  {equityInceptionData.payments.filter(p => p.distribution != null).length}/{equityInceptionData.payments.length} payments entered
                </div>
              )}
              {!equityInceptionData?.purchaseDate && (
                <Link
                  href="/clo/context"
                  style={{ fontSize: "0.65rem", color: "var(--color-accent)", marginTop: "0.2rem", display: "block" }}
                >
                  Set up in Context
                </Link>
              )}
            </div>
```

- [ ] **Step 5: Commit**

```bash
git add web/app/clo/waterfall/page.tsx web/app/clo/waterfall/ProjectionModel.tsx
git commit -m "feat: display inception IRR on waterfall page"
```

---

### Task 6: Verify end-to-end

- [ ] **Step 1: Run the dev server**

Run: `cd web && npm run dev`
Expected: compiles without errors.

- [ ] **Step 2: Manual test — Context Editor**

1. Navigate to `/clo/context`
2. Scroll to Group 3, find "Equity Inception" collapsible section
3. Enter a purchase date (e.g., 2024-01-15)
4. Verify quarterly payment rows auto-generate from that date to today
5. Enter a purchase price (e.g., 75 cents)
6. Fill in distribution amounts for each row
7. Click "Save Inception Data"
8. Refresh page — verify data persists

- [ ] **Step 3: Manual test — Waterfall IRR display**

1. Navigate to `/clo/waterfall`
2. Verify the inception IRR card appears in the summary row
3. With all payments filled: verify it shows a computed IRR percentage
4. With partial payments: verify it shows "-- %" with "X of Y payments entered"
5. With no inception data: verify it shows "-- %" with "Set up in Context" link

- [ ] **Step 4: Commit any fixes**

```bash
git add -u
git commit -m "fix: inception IRR end-to-end adjustments"
```
