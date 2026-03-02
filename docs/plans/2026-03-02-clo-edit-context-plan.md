# CLO Edit Context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/clo/context` page where users can view and inline-edit all extracted data (PPM constraints, fund profile, compliance data) that feeds into AI prompts.

**Architecture:** A dedicated page with a server component fetching all data, a client component rendering 3 groups of collapsible sections ordered by importance, and reusable inline-edit field components. Three API endpoints handle saves for constraints, profile fields, and compliance data respectively. A subtle floating button and sidebar link provide access.

**Tech Stack:** Next.js App Router, React (useState for edit state), Anthropic-style inline CSS (matching existing codebase), PostgreSQL

---

### Task 1: Layout Changes — Sidebar Link + Floating Button

**Files:**
- Modify: `web/app/clo/layout.tsx`

**Step 1: Add sidebar link and floating button**

In `web/app/clo/layout.tsx`, add a "Context" link inside the `{profile && (<>...</>)}` block, after the Screenings link (line 46):

```typescript
              <Link href="/clo/context" className="ic-nav-link">
                <span className="ic-nav-icon">&#9670;</span>
                Context
              </Link>
```

Then add a floating button inside `<main>`, after `{children}` (line 58). This requires wrapping children in a fragment:

Replace:
```typescript
      <main className="ic-main">{children}</main>
```

With:
```typescript
      <main className="ic-main">
        {children}
        {profile && (
          <Link
            href="/clo/context"
            style={{
              position: "fixed",
              bottom: "1.5rem",
              left: "1.5rem",
              padding: "0.4rem 0.8rem",
              fontSize: "0.75rem",
              color: "var(--color-text-muted)",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              opacity: 0.6,
              textDecoration: "none",
              zIndex: 50,
              transition: "opacity 0.15s",
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = "1"; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = "0.6"; }}
          >
            Edit Context
          </Link>
        )}
      </main>
```

**Note:** The `onMouseEnter`/`onMouseLeave` won't work in a server component. Since the layout is already a server component and `Link` is a client component, the inline hover won't work as-is. Instead, add a CSS class. Add this to the layout or use an existing hover utility. The simplest approach: just set `opacity: 0.7` statically and rely on CSS `:hover` via a class. We'll use a tiny client wrapper.

Actually, the simplest approach: create a tiny `EditContextButton` client component inline in the layout file, or just use CSS. Let's keep it simple — add a `clo-edit-context-btn` class and add CSS for it. But since this project uses inline styles extensively, just make the button a simple static-opacity link without hover effects. Users will understand it's clickable.

Replace the hover version with:
```typescript
      <main className="ic-main">
        {children}
        {profile && (
          <Link
            href="/clo/context"
            style={{
              position: "fixed",
              bottom: "1.5rem",
              left: "1.5rem",
              padding: "0.4rem 0.8rem",
              fontSize: "0.75rem",
              color: "var(--color-text-muted)",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              opacity: 0.7,
              textDecoration: "none",
              zIndex: 50,
            }}
          >
            Edit Context
          </Link>
        )}
      </main>
```

**Step 2: Commit**

```bash
git add web/app/clo/layout.tsx
git commit -m "feat(clo): add Context sidebar link and floating Edit Context button"
```

---

### Task 2: PATCH Profile API Endpoint

**Files:**
- Modify: `web/app/api/clo/profile/route.ts`

**Step 1: Add PATCH handler**

Add after the existing POST handler in `web/app/api/clo/profile/route.ts`:

```typescript
const ALLOWED_FIELDS = new Set([
  "fund_strategy", "target_sectors", "risk_appetite", "portfolio_size",
  "reinvestment_period", "concentration_limits", "covenant_preferences",
  "rating_thresholds", "spread_targets", "regulatory_constraints",
  "portfolio_description", "beliefs_and_biases",
]);

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    updates.push(`${key} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  updates.push(`updated_at = now()`);
  values.push(user.id);

  const rows = await query<{ id: string }>(
    `UPDATE clo_profiles SET ${updates.join(", ")} WHERE user_id = $${paramIndex} RETURNING id`,
    values
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ profileId: rows[0].id });
}
```

**Step 2: Commit**

```bash
git add web/app/api/clo/profile/route.ts
git commit -m "feat(clo): add PATCH handler for updating individual profile fields"
```

---

### Task 3: Update Constraints Endpoint to Sync clo_deals

**Files:**
- Modify: `web/app/api/clo/profile/constraints/route.ts`

**Step 1: Add deal sync after constraint update**

Update the POST handler to also sync `clo_deals.ppm_constraints`. After the existing UPDATE query that returns `profileId`, add:

```typescript
  // Sync to clo_deals.ppm_constraints
  try {
    await query(
      `UPDATE clo_deals SET ppm_constraints = $1::jsonb, updated_at = now()
       WHERE profile_id = $2`,
      [JSON.stringify(extractedConstraints), rows[0].id]
    );
  } catch {
    // Non-fatal — deal may not exist yet
  }
```

The full file should look like:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { extractedConstraints } = body;

  if (!extractedConstraints) {
    return NextResponse.json({ error: "Missing extractedConstraints" }, { status: 400 });
  }

  const rows = await query<{ id: string }>(
    `UPDATE clo_profiles
     SET extracted_constraints = $1::jsonb, updated_at = now()
     WHERE user_id = $2
     RETURNING id`,
    [JSON.stringify(extractedConstraints), user.id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  // Sync to clo_deals.ppm_constraints
  try {
    await query(
      `UPDATE clo_deals SET ppm_constraints = $1::jsonb, updated_at = now()
       WHERE profile_id = $2`,
      [JSON.stringify(extractedConstraints), rows[0].id]
    );
  } catch {
    // Non-fatal — deal may not exist yet
  }

  return NextResponse.json({ profileId: rows[0].id });
}
```

**Step 2: Commit**

```bash
git add web/app/api/clo/profile/constraints/route.ts
git commit -m "feat(clo): sync extracted constraints to clo_deals.ppm_constraints on save"
```

---

### Task 4: Compliance Data PATCH Endpoint

**Files:**
- Create: `web/app/api/clo/compliance/route.ts`

**Step 1: Create the endpoint**

This endpoint accepts partial updates to compliance data rows. It verifies ownership through the deal → profile → user chain.

**Before writing, read:**
- `web/lib/clo/access.ts` — for `getDealForProfile`, `getProfileForUser`
- `web/lib/auth-helpers.ts` — for `getCurrentUser`

Create `web/app/api/clo/compliance/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";

// Map of allowed tables and their allowed columns for updates
const ALLOWED_UPDATES: Record<string, Set<string>> = {
  clo_pool_summary: new Set([
    "total_par", "total_principal_balance", "total_market_value",
    "number_of_obligors", "number_of_assets", "number_of_industries",
    "number_of_countries", "target_par", "wac_spread", "wac_total",
    "wal_years", "warf", "diversity_score", "wa_recovery_rate",
    "pct_fixed_rate", "pct_floating_rate", "pct_cov_lite",
    "pct_second_lien", "pct_senior_secured", "pct_bonds",
    "pct_defaulted", "pct_ccc_and_below", "pct_single_b",
  ]),
  clo_compliance_tests: new Set([
    "test_name", "test_type", "test_class", "actual_value",
    "trigger_level", "threshold_level", "cushion_pct", "cushion_amount",
    "is_passing", "consequence_if_fail",
  ]),
  clo_concentrations: new Set([
    "concentration_type", "bucket_name", "actual_value", "actual_pct",
    "limit_value", "limit_pct", "is_passing", "obligor_count", "asset_count",
  ]),
};

async function verifyReportPeriodAccess(reportPeriodId: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT rp.id FROM clo_report_periods rp
     JOIN clo_deals d ON rp.deal_id = d.id
     JOIN clo_profiles p ON d.profile_id = p.id
     WHERE rp.id = $1 AND p.user_id = $2`,
    [reportPeriodId, userId]
  );
  return rows.length > 0;
}

function buildUpdateQuery(
  table: string,
  id: string,
  updates: Record<string, unknown>
): { sql: string; values: unknown[] } | null {
  const allowed = ALLOWED_UPDATES[table];
  if (!allowed) return null;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.has(key)) continue;
    setClauses.push(`${key} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  if (setClauses.length === 0) return null;

  values.push(id);
  return {
    sql: `UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = $${paramIndex}`,
    values,
  };
}

export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { reportPeriodId, poolSummary, complianceTests, concentrations } = body;

  if (!reportPeriodId) {
    return NextResponse.json({ error: "Missing reportPeriodId" }, { status: 400 });
  }

  const hasAccess = await verifyReportPeriodAccess(reportPeriodId, user.id);
  if (!hasAccess) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const results: string[] = [];

  // Update pool summary (1:1 with report period)
  if (poolSummary && typeof poolSummary === "object") {
    const poolRows = await query<{ id: string }>(
      "SELECT id FROM clo_pool_summary WHERE report_period_id = $1",
      [reportPeriodId]
    );
    if (poolRows.length > 0) {
      const q = buildUpdateQuery("clo_pool_summary", poolRows[0].id, poolSummary);
      if (q) {
        await query(q.sql, q.values);
        results.push("poolSummary");
      }
    }
  }

  // Update compliance tests (by ID)
  if (Array.isArray(complianceTests)) {
    for (const { id, updates } of complianceTests) {
      if (!id || !updates) continue;
      const q = buildUpdateQuery("clo_compliance_tests", id, updates);
      if (q) {
        await query(q.sql, q.values);
        results.push(`complianceTest:${id}`);
      }
    }
  }

  // Update concentrations (by ID)
  if (Array.isArray(concentrations)) {
    for (const { id, updates } of concentrations) {
      if (!id || !updates) continue;
      const q = buildUpdateQuery("clo_concentrations", id, updates);
      if (q) {
        await query(q.sql, q.values);
        results.push(`concentration:${id}`);
      }
    }
  }

  return NextResponse.json({ updated: results });
}
```

**Step 2: Commit**

```bash
git add web/app/api/clo/compliance/route.ts
git commit -m "feat(clo): add PATCH endpoint for compliance data edits"
```

---

### Task 5: Reusable InlineEdit Components

**Files:**
- Create: `web/components/clo/InlineEdit.tsx`

**Step 1: Create reusable inline edit primitives**

These are small components used throughout the context editor. Each renders a display value that becomes an input on click.

Create `web/components/clo/InlineEdit.tsx`:

```typescript
"use client";

import { useState, useRef, useEffect } from "react";

const editHighlight = "rgba(234, 179, 8, 0.1)";
const editBorder = "1px solid rgba(234, 179, 8, 0.3)";

interface InlineTextProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  dirty?: boolean;
}

export function InlineText({ value, onChange, placeholder, multiline, dirty }: InlineTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        style={{
          cursor: "pointer",
          padding: "0.1rem 0.3rem",
          borderRadius: "var(--radius-sm)",
          background: dirty ? editHighlight : "transparent",
          border: dirty ? editBorder : "1px solid transparent",
          minWidth: "2rem",
          display: "inline-block",
        }}
        title="Click to edit"
      >
        {value || <span style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>{placeholder || "—"}</span>}
      </span>
    );
  }

  function commit() {
    setEditing(false);
    if (draft !== value) onChange(draft);
  }

  if (multiline) {
    return (
      <textarea
        ref={ref as React.RefObject<HTMLTextAreaElement>}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        className="ic-textarea"
        rows={4}
        style={{ fontSize: "inherit", width: "100%" }}
      />
    );
  }

  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(value); setEditing(false); }
      }}
      style={{
        fontSize: "inherit",
        padding: "0.1rem 0.3rem",
        border: "1px solid var(--color-accent)",
        borderRadius: "var(--radius-sm)",
        outline: "none",
        width: "100%",
      }}
    />
  );
}

interface InlineNumberProps {
  value: number | null;
  onChange: (value: number | null) => void;
  dirty?: boolean;
}

export function InlineNumber({ value, onChange, dirty }: InlineNumberProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value != null ? String(value) : "");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value != null ? String(value) : ""); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  if (!editing) {
    return (
      <span
        onClick={() => setEditing(true)}
        style={{
          cursor: "pointer",
          padding: "0.1rem 0.3rem",
          borderRadius: "var(--radius-sm)",
          background: dirty ? editHighlight : "transparent",
          border: dirty ? editBorder : "1px solid transparent",
          minWidth: "2rem",
          display: "inline-block",
        }}
        title="Click to edit"
      >
        {value != null ? String(value) : <span style={{ color: "var(--color-text-muted)" }}>—</span>}
      </span>
    );
  }

  function commit() {
    setEditing(false);
    const num = draft.trim() === "" ? null : Number(draft);
    if (num !== value && (num === null || !isNaN(num))) onChange(num);
  }

  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(value != null ? String(value) : ""); setEditing(false); }
      }}
      style={{
        fontSize: "inherit",
        padding: "0.1rem 0.3rem",
        border: "1px solid var(--color-accent)",
        borderRadius: "var(--radius-sm)",
        outline: "none",
        width: "5rem",
        textAlign: "right",
      }}
    />
  );
}

interface InlineSelectProps {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  dirty?: boolean;
}

export function InlineSelect({ value, options, onChange, dirty }: InlineSelectProps) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    const label = options.find((o) => o.value === value)?.label || value;
    return (
      <span
        onClick={() => setEditing(true)}
        style={{
          cursor: "pointer",
          padding: "0.1rem 0.3rem",
          borderRadius: "var(--radius-sm)",
          background: dirty ? editHighlight : "transparent",
          border: dirty ? editBorder : "1px solid transparent",
        }}
        title="Click to edit"
      >
        {label || <span style={{ color: "var(--color-text-muted)" }}>—</span>}
      </span>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => { onChange(e.target.value); setEditing(false); }}
      onBlur={() => setEditing(false)}
      autoFocus
      style={{ fontSize: "inherit", padding: "0.1rem 0.3rem" }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

interface InlineStringListProps {
  items: string[];
  onChange: (items: string[]) => void;
  dirty?: boolean;
}

export function InlineStringList({ items, onChange, dirty }: InlineStringListProps) {
  function updateItem(index: number, value: string) {
    const next = [...items];
    next[index] = value;
    onChange(next);
  }
  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }
  function addItem() {
    onChange([...items, ""]);
  }

  return (
    <div>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", gap: "0.3rem", alignItems: "center", marginBottom: "0.3rem" }}>
          <span style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", minWidth: "1.5rem" }}>{i + 1}.</span>
          <InlineText value={item} onChange={(v) => updateItem(i, v)} dirty={dirty} />
          <button
            type="button"
            onClick={() => removeItem(i)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)", fontSize: "0.8rem", padding: "0 0.2rem" }}
            title="Remove"
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-accent)", fontSize: "0.8rem", padding: "0.2rem 0" }}
      >
        + Add item
      </button>
    </div>
  );
}

interface InlineKeyValueProps {
  data: Record<string, string>;
  onChange: (data: Record<string, string>) => void;
  dirty?: boolean;
}

export function InlineKeyValue({ data, onChange, dirty }: InlineKeyValueProps) {
  const entries = Object.entries(data);

  function updateKey(oldKey: string, newKey: string) {
    const next: Record<string, string> = {};
    for (const [k, v] of entries) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  }

  function updateValue(key: string, value: string) {
    onChange({ ...data, [key]: value });
  }

  function removeEntry(key: string) {
    const next = { ...data };
    delete next[key];
    onChange(next);
  }

  function addEntry() {
    onChange({ ...data, "": "" });
  }

  return (
    <div>
      {entries.map(([key, value], i) => (
        <div key={i} style={{ display: "flex", gap: "0.3rem", alignItems: "center", marginBottom: "0.3rem" }}>
          <InlineText value={key} onChange={(v) => updateKey(key, v)} dirty={dirty} placeholder="key" />
          <span style={{ color: "var(--color-text-muted)" }}>:</span>
          <InlineText value={value} onChange={(v) => updateValue(key, v)} dirty={dirty} placeholder="value" />
          <button
            type="button"
            onClick={() => removeEntry(key)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)", fontSize: "0.8rem", padding: "0 0.2rem" }}
            title="Remove"
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addEntry}
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-accent)", fontSize: "0.8rem", padding: "0.2rem 0" }}
      >
        + Add entry
      </button>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add web/components/clo/InlineEdit.tsx
git commit -m "feat(clo): add reusable InlineEdit components for text, number, select, list, key-value"
```

---

### Task 6: Context Page — Server Component

**Files:**
- Create: `web/app/clo/context/page.tsx`

**Step 1: Create the server component**

This fetches all data and passes it to the client component. Read these files first for patterns:
- `web/app/clo/page.tsx` — Dashboard data fetching pattern
- `web/lib/clo/access.ts` — `getProfileForUser`, `getDealForProfile`, `getLatestReportPeriod`, `getReportPeriodData`

Create `web/app/clo/context/page.tsx`:

```typescript
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  getProfileForUser,
  getDealForProfile,
  getLatestReportPeriod,
  getReportPeriodData,
  rowToProfile,
} from "@/lib/clo/access";
import { query } from "@/lib/db";
import type { ExtractedConstraints } from "@/lib/clo/types";
import ContextEditor from "./ContextEditor";

export default async function ContextPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const profileRow = await getProfileForUser(session.user.id);
  if (!profileRow) {
    redirect("/clo/onboarding");
  }

  const profile = rowToProfile(profileRow);
  const constraints = (profile.extractedConstraints || {}) as ExtractedConstraints;

  // Fund profile fields
  const fundProfile = {
    fundStrategy: profile.fundStrategy,
    targetSectors: profile.targetSectors,
    riskAppetite: profile.riskAppetite,
    portfolioSize: profile.portfolioSize,
    reinvestmentPeriod: profile.reinvestmentPeriod,
    concentrationLimits: profile.concentrationLimits,
    covenantPreferences: profile.covenantPreferences,
    ratingThresholds: profile.ratingThresholds,
    spreadTargets: profile.spreadTargets,
    regulatoryConstraints: profile.regulatoryConstraints,
    portfolioDescription: profile.portfolioDescription,
    beliefsAndBiases: profile.beliefsAndBiases,
  };

  // Compliance data from latest report period
  let complianceData = null;
  const deal = await getDealForProfile(profile.id);
  if (deal) {
    const latestPeriod = await getLatestReportPeriod(deal.id);
    if (latestPeriod) {
      const periodData = await getReportPeriodData(latestPeriod.id);
      complianceData = {
        reportPeriodId: latestPeriod.id,
        reportDate: latestPeriod.reportDate,
        poolSummary: periodData.poolSummary,
        complianceTests: periodData.complianceTests,
        concentrations: periodData.concentrations,
      };
    }
  }

  return (
    <div className="ic-content">
      <div className="standalone-header">
        <h1>Context Editor</h1>
        <p style={{ color: "var(--color-text-secondary)", fontSize: "0.85rem" }}>
          View and edit the extracted data that feeds into every analysis and chat interaction.
        </p>
      </div>
      <ContextEditor
        constraints={constraints}
        fundProfile={fundProfile}
        complianceData={complianceData}
      />
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add web/app/clo/context/page.tsx
git commit -m "feat(clo): add context page server component"
```

---

### Task 7: Context Editor — Client Component (Group 1: Compliance & Tests)

**Files:**
- Create: `web/app/clo/context/ContextEditor.tsx`

**Context:** This is the largest file. It renders all 3 groups of collapsible sections with inline editing. We'll build it incrementally — this task covers the component shell + Group 1 (Compliance & Tests). Tasks 8 and 9 add Groups 2 and 3.

**Before writing, read:**
- `web/components/clo/QuestionnaireForm.tsx` lines 34-85 — `CollapsibleSection` pattern
- `web/components/clo/InlineEdit.tsx` — The inline edit components from Task 5
- `web/lib/clo/types.ts` — `ExtractedConstraints`, `CloComplianceTest`, `CloPoolSummary`, `CloConcentration`

**Step 1: Create ContextEditor with shell + Group 1**

Create `web/app/clo/context/ContextEditor.tsx`. This is a large file. The component:
- Holds state for `constraints`, `fundProfile`, and compliance data
- Tracks dirty state per group
- Has save handlers for each group
- Renders CollapsibleSections with InlineEdit components

The implementer should:
1. Read the `CollapsibleSection` component from QuestionnaireForm.tsx (lines 34-85) and replicate it locally in this file
2. Import `InlineText`, `InlineNumber`, `InlineStringList`, `InlineKeyValue`, `InlineSelect` from `@/components/clo/InlineEdit`
3. Import types: `ExtractedConstraints`, `CloComplianceTest`, `CloPoolSummary`, `CloConcentration`, `CollateralQualityTest`, `CoverageTestEntry` from `@/lib/clo/types`

**Group 1 sections to render:**

**1. Coverage Tests** (badge: "PPM") — if `constraints.coverageTestEntries` exists, render as table with columns: Class, Par Value Ratio, Interest Coverage Ratio. Each cell is `InlineText`. If compliance data has matching tests, show actuals alongside.

**2. Collateral Quality Tests** (badge: "PPM") — if `constraints.collateralQualityTests` exists, render as table with columns: Name, Agency, Value, Applies During. Each cell is `InlineText`/`InlineNumber`.

**3. Portfolio Profile Tests** (badge: "PPM") — if `constraints.portfolioProfileTests` exists, render as key-value table with Test Name, Min, Max, Notes columns. Use `InlineText`/`InlineNumber` for each cell.

**4. Eligibility Criteria** (badge: "PPM") — if `constraints.eligibilityCriteria` exists, render as `InlineStringList`.

**5. Trading Restrictions by Test Breach** (badge: "PPM") — if `constraints.tradingRestrictionsByTestBreach` exists, render as table with Test Name, Consequence columns. Each cell `InlineText`.

**Save handler for Group 1:**
```typescript
async function saveConstraints() {
  setSavingConstraints(true);
  await fetch("/api/clo/profile/constraints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extractedConstraints: constraints }),
  });
  setSavingConstraints(false);
  setConstraintsDirty(false);
}
```

Show a "Save Changes" button at the bottom of Group 1 when `constraintsDirty` is true.

**Step 2: Commit**

```bash
git add web/app/clo/context/ContextEditor.tsx
git commit -m "feat(clo): add ContextEditor with Group 1 (Compliance & Tests)"
```

---

### Task 8: Context Editor — Group 2 (Deal Structure)

**Files:**
- Modify: `web/app/clo/context/ContextEditor.tsx`

**Step 1: Add Group 2 sections**

Add after Group 1 in ContextEditor. These all edit fields on `constraints` and share the same save handler.

**Sections to add:**

**6. Deal Identity** (badge: "PPM") — `constraints.dealIdentity` fields as `KeyValueGrid`-style layout but with `InlineText` for each value. Fields: dealName, issuerLegalName, jurisdiction, entityType, governingLaw, currency, listingExchange.

**7. Key Dates** (badge: "PPM") — `constraints.keyDates` fields: originalIssueDate, maturityDate, nonCallPeriodEnd, reinvestmentPeriodEnd, paymentFrequency, frequencySwitchEvent. Each as `InlineText`.

**8. Capital Structure** (badge: "PPM") — `constraints.capitalStructure` as a table with columns: Class, Principal, Rate Type, Spread, Rating (Fitch/S&P), Maturity. Each cell editable. Add/remove row buttons.

**9. Deal Sizing** (badge: "PPM") — `constraints.dealSizing` fields: targetParAmount, totalDealSize, equityPctOfDeal, cleanUpCallThresholdPct. Each as `InlineText`.

**10. Waterfall** (badge: "PPM") — `constraints.waterfall` fields: interestPriority, principalPriority, postAcceleration. Each as `InlineText` with `multiline: true`.

**11. Reinvestment Criteria** (badge: "PPM") — `constraints.reinvestmentCriteria` fields: duringReinvestment, postReinvestment, substituteRequirements, targetParBalance. Each as `InlineText` multiline.

**12. CM Details & Trading** (badge: "PPM") — `constraints.cmDetails` + `constraints.cmTradingConstraints`. Render as two sub-groups of InlineText fields.

**13. Fees, Accounts, Key Parties** (badge: "PPM") — `constraints.fees` as table (name, rate, basis, description), `constraints.accounts` as table (name, purpose), `constraints.keyParties` as table (role, entity). Each with add/remove.

**Step 2: Commit**

```bash
git add web/app/clo/context/ContextEditor.tsx
git commit -m "feat(clo): add Group 2 (Deal Structure) sections to ContextEditor"
```

---

### Task 9: Context Editor — Group 3 (Fund Profile & Portfolio)

**Files:**
- Modify: `web/app/clo/context/ContextEditor.tsx`

**Step 1: Add Group 3 sections**

These edit `fundProfile` fields and compliance data, with separate save handlers.

**Fund profile sections:**

**14. Fund Strategy & Preferences** (badge: "Profile") — fundStrategy (`InlineText` multiline), riskAppetite (`InlineSelect` with conservative/moderate/aggressive), targetSectors (`InlineText` multiline), portfolioSize (`InlineText`).

**15. Beliefs & Thresholds** (badge: "Profile") — beliefsAndBiases (`InlineText` multiline), ratingThresholds (`InlineText`), spreadTargets (`InlineText`), concentrationLimits (`InlineText` multiline), regulatoryConstraints (`InlineText` multiline).

**Fund profile save handler:**
```typescript
async function saveProfile() {
  setSavingProfile(true);
  await fetch("/api/clo/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fund_strategy: fundProfile.fundStrategy,
      target_sectors: fundProfile.targetSectors,
      risk_appetite: fundProfile.riskAppetite,
      portfolio_size: fundProfile.portfolioSize,
      reinvestment_period: fundProfile.reinvestmentPeriod,
      concentration_limits: fundProfile.concentrationLimits,
      covenant_preferences: fundProfile.covenantPreferences,
      rating_thresholds: fundProfile.ratingThresholds,
      spread_targets: fundProfile.spreadTargets,
      regulatory_constraints: fundProfile.regulatoryConstraints,
      portfolio_description: fundProfile.portfolioDescription,
      beliefs_and_biases: fundProfile.beliefsAndBiases,
    }),
  });
  setSavingProfile(false);
  setProfileDirty(false);
}
```

**Compliance sections (only if complianceData is not null):**

**16. Pool Summary** (badge: "Compliance Report") — Show key metrics from `complianceData.poolSummary`: total_par, warf, wal_years, diversity_score, wac_spread, pct_ccc_and_below, pct_fixed_rate, etc. Each as `InlineNumber`. Show report date.

**17. Concentrations** (badge: "Compliance Report") — Show `complianceData.concentrations` as table: Type, Bucket, Actual %, Limit %, Passing. Each editable.

**Compliance save handler:**
```typescript
async function saveCompliance() {
  setSavingCompliance(true);
  await fetch("/api/clo/compliance", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reportPeriodId: complianceData.reportPeriodId,
      poolSummary: complianceData.poolSummary,
      complianceTests: complianceData.complianceTests?.map((t) => ({ id: t.id, updates: t })),
      concentrations: complianceData.concentrations?.map((c) => ({ id: c.id, updates: c })),
    }),
  });
  setSavingCompliance(false);
  setComplianceDirty(false);
}
```

**18. Remaining Structural** (badge: "PPM") — Collapsible sections for: hedging, interestMechanics, riskRetention, votingAndControl, redemptionProvisions, eventsOfDefault, transferRestrictions, reports, ratingAgencyParameters, legalProtections, managementOfPortfolio, termsAndConditionsOfSales, riskFactors, conflictsOfInterest. Each renders its data type appropriately (key-value grids, tables, string lists, multiline text).

**Step 2: Commit**

```bash
git add web/app/clo/context/ContextEditor.tsx
git commit -m "feat(clo): add Group 3 (Fund Profile & Portfolio) and remaining structural sections"
```

---

### Task 10: Build Verification

**Step 1: Build check**

Run: `cd /Users/solal/Documents/GitHub/funzies/web && npx next build 2>&1 | tail -30`
Expected: Build succeeds, `/clo/context` route appears in output

**Step 2: Manual verification**

- Navigate to `/clo` — floating "Edit Context" button visible in bottom-left
- Sidebar shows "Context" link
- Navigate to `/clo/context` — page loads with all 3 groups
- Click any value — turns into editable input
- Edit a value — yellow highlight appears
- "Save Changes" button appears for that group
- Click save — data persists (verify via page reload)
- Check all 3 save paths work: constraints, profile, compliance

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(clo): complete edit context page with inline editing for all extracted data"
```
