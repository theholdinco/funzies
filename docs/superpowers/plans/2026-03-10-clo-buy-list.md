# CLO Buy List Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CSV-uploadable buy list of candidate loans that serves as primary context across screening, analysis, briefs, and chat.

**Architecture:** New `clo_buy_list_items` table stores parsed CSV rows linked to `clo_profiles`. A new `BuyListUpload` client component handles CSV upload with replace-on-upload semantics. A `formatBuyList()` function formats items for prompt injection. All major prompt functions and pipelines get buy list context. The AnalysisForm gets a loan selector that pre-fills from the buy list.

**Tech Stack:** Next.js 16 App Router, PostgreSQL, TypeScript, Anthropic Claude API, Papa Parse (CSV parsing)

---

## File Structure

**New files:**
- `web/lib/clo/buy-list.ts` — DB access functions for buy list (CRUD, format for prompts)
- `web/app/clo/BuyListUpload.tsx` — Client component: CSV upload + buy list table viewer
- `web/app/api/clo/buy-list/route.ts` — API route: GET (list items), POST (upload CSV), DELETE (clear list)
- `web/components/clo/BuyListLoanSelector.tsx` — Client component: dropdown/search to select a buy list loan for analysis, pre-fills form fields

**Modified files:**
- `web/lib/schema.sql` — Add `clo_buy_list_items` table
- `web/lib/clo/types.ts` — Add `BuyListItem` interface
- `web/worker/clo-prompts.ts` — Add `formatBuyList()`, inject buy list into `portfolioGapAnalysisPrompt`, `screeningDebatePrompt`, `screeningSynthesisPrompt`, `creditAnalysisPrompt`, `seniorAnalystSystemPrompt`, and all other prompt functions that take profile context
- `web/worker/clo-pipeline.ts` — Fetch buy list items and pass to prompt functions in analysis/screening pipelines
- `web/app/clo/page.tsx` — Add `BuyListUpload` component to dashboard
- `web/components/clo/AnalysisForm.tsx` — Add buy list loan selector that pre-fills fields
- `web/app/api/clo/briefing/route.ts` — Include buy list context in briefing profile context
- `web/app/api/clo/chat/route.ts` — Include buy list context in analyst chat system prompt
- `web/app/api/clo/analyses/[id]/follow-ups/route.ts` — Include buy list context in follow-up prompts
- `web/app/api/clo/screenings/[id]/follow-ups/route.ts` — Include buy list context in screening follow-up prompts
- `web/app/api/clo/panels/[id]/follow-ups/route.ts` — Include buy list context in panel follow-up prompts

---

## Chunk 1: Database, Types, and Data Access Layer

### Task 1: Add DB table for buy list items

**Files:**
- Modify: `web/lib/schema.sql` (append at end, after line 844)

- [ ] **Step 1: Add the `clo_buy_list_items` table to schema.sql**

Append to the end of `web/lib/schema.sql`:

```sql
-- ============================================================
-- CLO Buy List — candidate loans for purchase consideration
-- ============================================================

CREATE TABLE IF NOT EXISTS clo_buy_list_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES clo_profiles(id) ON DELETE CASCADE,
  obligor_name TEXT NOT NULL,
  facility_name TEXT,
  sector TEXT,
  moodys_rating TEXT,
  sp_rating TEXT,
  spread_bps NUMERIC,
  reference_rate TEXT,
  price NUMERIC,
  maturity_date TEXT,
  facility_size NUMERIC,
  leverage NUMERIC,
  interest_coverage NUMERIC,
  is_cov_lite BOOLEAN,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clo_buy_list_items_profile ON clo_buy_list_items(profile_id);
```

- [ ] **Step 2: Run the migration against the database**

Run: `psql $DATABASE_URL -f web/lib/schema.sql` (or however migrations are applied — schema.sql is idempotent with `IF NOT EXISTS`)

- [ ] **Step 3: Commit**

```bash
git add web/lib/schema.sql
git commit -m "feat(clo): add clo_buy_list_items table for candidate loan tracking"
```

---

### Task 2: Add TypeScript types

**Files:**
- Modify: `web/lib/clo/types.ts` (append after `ParsedScreening` interface, around line 963)

- [ ] **Step 1: Add `BuyListItem` interface**

Add after the `ParsedScreening` interface (around line 963):

```typescript
export interface BuyListItem {
  id: string;
  profileId: string;
  obligorName: string;
  facilityName: string | null;
  sector: string | null;
  moodysRating: string | null;
  spRating: string | null;
  spreadBps: number | null;
  referenceRate: string | null;
  price: number | null;
  maturityDate: string | null;
  facilitySize: number | null;
  leverage: number | null;
  interestCoverage: number | null;
  isCovLite: boolean | null;
  notes: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/clo/types.ts
git commit -m "feat(clo): add BuyListItem type definition"
```

---

### Task 3: Add data access layer for buy list

**Files:**
- Create: `web/lib/clo/buy-list.ts`

- [ ] **Step 1: Create buy-list.ts with CRUD functions and prompt formatter**

```typescript
import { query } from "../db";
import type { BuyListItem } from "./types";

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function rowToBuyListItem(row: Record<string, unknown>): BuyListItem {
  return {
    id: row.id as string,
    profileId: row.profile_id as string,
    obligorName: (row.obligor_name as string) || "",
    facilityName: (row.facility_name as string) ?? null,
    sector: (row.sector as string) ?? null,
    moodysRating: (row.moodys_rating as string) ?? null,
    spRating: (row.sp_rating as string) ?? null,
    spreadBps: num(row.spread_bps),
    referenceRate: (row.reference_rate as string) ?? null,
    price: num(row.price),
    maturityDate: (row.maturity_date as string) ?? null,
    facilitySize: num(row.facility_size),
    leverage: num(row.leverage),
    interestCoverage: num(row.interest_coverage),
    isCovLite: (row.is_cov_lite as boolean) ?? null,
    notes: (row.notes as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function getBuyListForProfile(profileId: string): Promise<BuyListItem[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_buy_list_items WHERE profile_id = $1 ORDER BY obligor_name ASC",
    [profileId]
  );
  return rows.map(rowToBuyListItem);
}

export async function getBuyListForUser(userId: string): Promise<BuyListItem[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT b.* FROM clo_buy_list_items b
     JOIN clo_profiles p ON b.profile_id = p.id
     WHERE p.user_id = $1
     ORDER BY b.obligor_name ASC`,
    [userId]
  );
  return rows.map(rowToBuyListItem);
}

export async function replaceBuyList(
  profileId: string,
  items: Omit<BuyListItem, "id" | "profileId" | "createdAt">[]
): Promise<number> {
  await query("DELETE FROM clo_buy_list_items WHERE profile_id = $1", [profileId]);

  if (items.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;

  for (const item of items) {
    const start = paramIndex;
    placeholders.push(
      `($${start}, $${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8}, $${start + 9}, $${start + 10}, $${start + 11}, $${start + 12}, $${start + 13}, $${start + 14})`
    );
    values.push(
      profileId,
      item.obligorName,
      item.facilityName || null,
      item.sector || null,
      item.moodysRating || null,
      item.spRating || null,
      item.spreadBps ?? null,
      item.referenceRate || null,
      item.price ?? null,
      item.maturityDate || null,
      item.facilitySize ?? null,
      item.leverage ?? null,
      item.interestCoverage ?? null,
      item.isCovLite ?? null,
      item.notes || null
    );
    paramIndex += 15;
  }

  await query(
    `INSERT INTO clo_buy_list_items (
      profile_id, obligor_name, facility_name, sector, moodys_rating, sp_rating,
      spread_bps, reference_rate, price, maturity_date, facility_size,
      leverage, interest_coverage, is_cov_lite, notes
    ) VALUES ${placeholders.join(", ")}`,
    values
  );

  return items.length;
}

export async function clearBuyList(profileId: string): Promise<void> {
  await query("DELETE FROM clo_buy_list_items WHERE profile_id = $1", [profileId]);
}

/**
 * Format buy list items as context for AI prompts.
 * Returns empty string if no items.
 */
export function formatBuyList(items: BuyListItem[]): string {
  if (!items || items.length === 0) return "";

  const header = `BUY LIST — ${items.length} candidate loans under consideration:`;
  const rows = items.map((item, i) => {
    const parts: string[] = [`${i + 1}. ${item.obligorName}`];
    if (item.facilityName) parts[0] += ` — ${item.facilityName}`;
    const details: string[] = [];
    if (item.sector) details.push(`Sector: ${item.sector}`);
    if (item.moodysRating || item.spRating) {
      details.push(`Rating: ${[item.moodysRating, item.spRating].filter(Boolean).join("/")}`);
    }
    if (item.spreadBps != null) {
      details.push(`Spread: ${item.spreadBps}bps${item.referenceRate ? ` over ${item.referenceRate}` : ""}`);
    }
    if (item.price != null) details.push(`Price: ${item.price}`);
    if (item.maturityDate) details.push(`Maturity: ${item.maturityDate}`);
    if (item.facilitySize != null) details.push(`Size: ${item.facilitySize.toLocaleString()}`);
    if (item.leverage != null) details.push(`Leverage: ${item.leverage}x`);
    if (item.interestCoverage != null) details.push(`IC: ${item.interestCoverage}x`);
    if (item.isCovLite === true) details.push(`Cov-Lite: Yes`);
    if (item.notes) details.push(`Notes: ${item.notes}`);
    if (details.length > 0) parts.push(`   ${details.join(" | ")}`);
    return parts.join("\n");
  });

  return `${header}\n${rows.join("\n")}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/clo/buy-list.ts
git commit -m "feat(clo): add buy list data access layer with CRUD and prompt formatter"
```

---

## Chunk 2: API Route and CSV Upload UI

### Task 4: Add buy list API route

**Files:**
- Create: `web/app/api/clo/buy-list/route.ts`

- [ ] **Step 1: Create the API route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { getProfileForUser } from "@/lib/clo/access";
import { getBuyListForProfile, replaceBuyList, clearBuyList } from "@/lib/clo/buy-list";

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ error: "No CLO profile found" }, { status: 404 });
  }

  const items = await getBuyListForProfile(profile.id);
  return NextResponse.json({ items });
}

// CSV column mapping — maps common CSV header variations to our field names
const COLUMN_MAP: Record<string, string> = {
  obligor: "obligorName",
  obligor_name: "obligorName",
  borrower: "obligorName",
  borrower_name: "obligorName",
  name: "obligorName",
  facility: "facilityName",
  facility_name: "facilityName",
  sector: "sector",
  industry: "sector",
  moodys: "moodysRating",
  moodys_rating: "moodysRating",
  "moody's": "moodysRating",
  sp: "spRating",
  sp_rating: "spRating",
  "s&p": "spRating",
  spread: "spreadBps",
  spread_bps: "spreadBps",
  reference_rate: "referenceRate",
  ref_rate: "referenceRate",
  price: "price",
  offer_price: "price",
  current_price: "price",
  maturity: "maturityDate",
  maturity_date: "maturityDate",
  facility_size: "facilitySize",
  size: "facilitySize",
  leverage: "leverage",
  interest_coverage: "interestCoverage",
  ic: "interestCoverage",
  cov_lite: "isCovLite",
  covenant_lite: "isCovLite",
  notes: "notes",
  commentary: "notes",
};

function normalizeHeader(header: string): string | null {
  const cleaned = header.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/['"]/g, "");
  return COLUMN_MAP[cleaned] || null;
}

function parseNumber(val: string | undefined): number | null {
  if (!val || val.trim() === "") return null;
  const cleaned = val.replace(/[,$%]/g, "").trim();
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function parseBoolean(val: string | undefined): boolean | null {
  if (!val || val.trim() === "") return null;
  const lower = val.trim().toLowerCase();
  if (["yes", "true", "1", "y"].includes(lower)) return true;
  if (["no", "false", "0", "n"].includes(lower)) return false;
  return null;
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ error: "No CLO profile found" }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  if (!file.name.endsWith(".csv")) {
    return NextResponse.json({ error: "Only CSV files are supported" }, { status: 400 });
  }

  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 5MB)" }, { status: 400 });
  }

  const text = await file.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  if (lines.length < 2) {
    return NextResponse.json({ error: "CSV must have a header row and at least one data row" }, { status: 400 });
  }

  // Parse header
  const headerLine = lines[0];
  const headers = headerLine.split(",").map((h) => h.trim());
  const fieldMap: (string | null)[] = headers.map(normalizeHeader);

  // Check that we have at least the obligor name column
  if (!fieldMap.includes("obligorName")) {
    return NextResponse.json(
      { error: `Could not find an obligor/borrower name column. Found headers: ${headers.join(", ")}. Expected one of: obligor, obligor_name, borrower, borrower_name, name` },
      { status: 400 }
    );
  }

  // Parse rows — simple CSV split (handles most cases; does not handle quoted commas)
  const items: Array<Record<string, unknown>> = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",");
    const row: Record<string, unknown> = {};

    for (let j = 0; j < fieldMap.length; j++) {
      const field = fieldMap[j];
      if (!field) continue;
      const val = values[j]?.trim();
      if (!val) continue;

      if (["spreadBps", "price", "facilitySize", "leverage", "interestCoverage"].includes(field)) {
        row[field] = parseNumber(val);
      } else if (field === "isCovLite") {
        row[field] = parseBoolean(val);
      } else {
        row[field] = val;
      }
    }

    if (!row.obligorName) continue; // Skip rows without an obligor name
    items.push(row);
  }

  if (items.length === 0) {
    return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
  }

  if (items.length > 500) {
    return NextResponse.json({ error: "Buy list too large (max 500 loans)" }, { status: 400 });
  }

  const count = await replaceBuyList(
    profile.id,
    items.map((row) => ({
      obligorName: row.obligorName as string,
      facilityName: (row.facilityName as string) || null,
      sector: (row.sector as string) || null,
      moodysRating: (row.moodysRating as string) || null,
      spRating: (row.spRating as string) || null,
      spreadBps: (row.spreadBps as number) ?? null,
      referenceRate: (row.referenceRate as string) || null,
      price: (row.price as number) ?? null,
      maturityDate: (row.maturityDate as string) || null,
      facilitySize: (row.facilitySize as number) ?? null,
      leverage: (row.leverage as number) ?? null,
      interestCoverage: (row.interestCoverage as number) ?? null,
      isCovLite: (row.isCovLite as boolean) ?? null,
      notes: (row.notes as string) || null,
    }))
  );

  return NextResponse.json({ count, message: `Uploaded ${count} loans to buy list` });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ error: "No CLO profile found" }, { status: 404 });
  }

  await clearBuyList(profile.id);
  return NextResponse.json({ message: "Buy list cleared" });
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/api/clo/buy-list/route.ts
git commit -m "feat(clo): add buy list API route with CSV parsing and replace-on-upload"
```

---

### Task 5: Add BuyListUpload client component

**Files:**
- Create: `web/app/clo/BuyListUpload.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import type { BuyListItem } from "@/lib/clo/types";

export default function BuyListUpload({ initialItems }: { initialItems: BuyListItem[] }) {
  const [items, setItems] = useState<BuyListItem[]>(initialItems);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [expanded, setExpanded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError("");
    setSuccess("");
    setUploading(true);

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch("/api/clo/buy-list", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      setError(data.error || "Upload failed");
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }

    setSuccess(data.message);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";

    // Refresh to get new items
    const listRes = await fetch("/api/clo/buy-list");
    if (listRes.ok) {
      const listData = await listRes.json();
      setItems(listData.items || []);
    }
    router.refresh();
  }

  async function handleClear() {
    if (!confirm("Clear the entire buy list?")) return;
    setError("");
    setSuccess("");

    const res = await fetch("/api/clo/buy-list", { method: "DELETE" });
    if (res.ok) {
      setItems([]);
      setSuccess("Buy list cleared");
      router.refresh();
    } else {
      setError("Failed to clear buy list");
    }
  }

  return (
    <section className="ic-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>
          Buy List
          {items.length > 0 && (
            <span style={{ fontSize: "0.75rem", fontWeight: 400, color: "var(--color-text-muted)", marginLeft: "0.5rem" }}>
              {items.length} loan{items.length !== 1 ? "s" : ""}
            </span>
          )}
        </h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={handleUpload}
            style={{ display: "none" }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="btn-secondary"
            style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem" }}
          >
            {uploading ? "Uploading..." : items.length > 0 ? "Update CSV" : "Upload CSV"}
          </button>
          {items.length > 0 && (
            <>
              <button
                onClick={() => setExpanded(!expanded)}
                className="btn-secondary"
                style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem" }}
              >
                {expanded ? "Collapse" : "View"}
              </button>
              <button
                onClick={handleClear}
                className="btn-secondary"
                style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem", color: "var(--color-error, #ef4444)" }}
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      {items.length === 0 && (
        <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", marginTop: "0.5rem" }}>
          Upload a CSV of candidate loans to provide concrete context for screening, analysis, and briefings.
          The buy list is used as primary context across the entire platform.
        </p>
      )}

      {error && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-error, #ef4444)" }}>
          {error}
        </div>
      )}
      {success && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-success, #22c55e)" }}>
          {success}
        </div>
      )}

      {expanded && items.length > 0 && (
        <div style={{ marginTop: "0.75rem", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)", textAlign: "left" }}>
                <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Obligor</th>
                <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Sector</th>
                <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Rating</th>
                <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, color: "var(--color-text-muted)", textAlign: "right" }}>Spread</th>
                <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, color: "var(--color-text-muted)", textAlign: "right" }}>Price</th>
                <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Maturity</th>
                <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, color: "var(--color-text-muted)", textAlign: "right" }}>Size</th>
                <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, color: "var(--color-text-muted)", textAlign: "right" }}>Leverage</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td style={{ padding: "0.3rem 0.5rem", fontWeight: 500 }}>
                    {item.obligorName}
                    {item.facilityName && <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}> — {item.facilityName}</span>}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem" }}>{item.sector || "—"}</td>
                  <td style={{ padding: "0.3rem 0.5rem" }}>{[item.moodysRating, item.spRating].filter(Boolean).join("/") || "—"}</td>
                  <td style={{ padding: "0.3rem 0.5rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {item.spreadBps != null ? `${item.spreadBps}` : "—"}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {item.price != null ? item.price.toFixed(2) : "—"}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem" }}>{item.maturityDate || "—"}</td>
                  <td style={{ padding: "0.3rem 0.5rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {item.facilitySize != null ? item.facilitySize.toLocaleString() : "—"}
                  </td>
                  <td style={{ padding: "0.3rem 0.5rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {item.leverage != null ? `${item.leverage}x` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/clo/BuyListUpload.tsx
git commit -m "feat(clo): add BuyListUpload component with CSV upload and table view"
```

---

### Task 6: Add BuyListUpload to dashboard

**Files:**
- Modify: `web/app/clo/page.tsx`

- [ ] **Step 1: Import BuyListUpload and getBuyListForProfile**

Add imports at the top of `web/app/clo/page.tsx`:

```typescript
import BuyListUpload from "./BuyListUpload";
import { getBuyListForProfile } from "@/lib/clo/buy-list";
```

- [ ] **Step 2: Fetch buy list items in the server component**

Inside `CLODashboard()`, after `const cloProfile = rowToProfile(...)` (around line 698), add:

```typescript
const buyListItems = await getBuyListForProfile(cloProfile.id);
```

- [ ] **Step 3: Render BuyListUpload in the dashboard**

In the JSX, add `<BuyListUpload initialItems={buyListItems} />` right after `<DocumentUploadBanner hasDocuments={hasDocuments} />` (around line 799):

```tsx
<BuyListUpload initialItems={buyListItems} />
```

- [ ] **Step 4: Commit**

```bash
git add web/app/clo/page.tsx
git commit -m "feat(clo): add buy list section to CLO dashboard"
```

---

## Chunk 3: Prompt Integration — Screening, Analysis, Chat, and Briefs

### Task 7: Inject buy list into all prompt functions

**Files:**
- Modify: `web/worker/clo-prompts.ts`

This is the largest and most critical task. Every prompt function that builds context for the AI needs to receive and include the buy list.

- [ ] **Step 1: Import `formatBuyList` and `BuyListItem` at the top of clo-prompts.ts**

Add to the existing imports at line 1:

```typescript
import type { BuyListItem } from "../lib/clo/types.js";
import { formatBuyList } from "../lib/clo/buy-list.js";
```

- [ ] **Step 2: Add `buyList` parameter to `portfolioGapAnalysisPrompt`**

Change the function signature (line 1463) to accept `buyList?: BuyListItem[]` as a new parameter:

```typescript
export function portfolioGapAnalysisPrompt(
  profile: CloProfile,
  recentAnalyses: string,
  reportPeriodContext?: string,
  buyList?: BuyListItem[]
): { system: string; user: string } {
```

Update the system prompt to reference the buy list. After the `## Opportunity Areas` section in the system prompt, add:

```
## Buy List Assessment
If a buy list is provided, evaluate EACH candidate loan against the portfolio gaps. For each loan:
- Does it address an identified gap? Which one(s)?
- What is its compliance impact? (WARF, WAS, WAL, concentration, eligibility)
- What is its relative value vs other candidates on the list?
- Rank the buy list loans by portfolio fit and gap-filling potential.
- Use web search to research the companies and sectors on the buy list for recent credit events, news, and market context.
```

Add the buy list to the user prompt string, after the `recentAnalyses` section:

```typescript
${buyList && buyList.length > 0 ? `\n${formatBuyList(buyList)}\n\nEvaluate each buy list loan against the gaps. Use web search to research these companies.` : ""}
```

- [ ] **Step 3: Add `buyList` parameter to `screeningDebatePrompt`**

Change the function signature (line 1503) to add `buyList?: BuyListItem[]`:

```typescript
export function screeningDebatePrompt(
  members: PanelMember[],
  gapAnalysis: string,
  focusArea: string,
  profile: CloProfile,
  reportPeriodContext?: string,
  buyList?: BuyListItem[]
): { system: string; user: string } {
```

Update the system prompt to instruct the panel to ground discussion in the buy list. Add to the numbered list:

```
7. The BUY LIST is primary context — panel members should discuss SPECIFIC loans from the buy list when proposing opportunities. Reference actual names, spreads, ratings, and prices. The buy list represents what the manager is actively considering.
8. Panel members CAN suggest opportunities OUTSIDE the buy list if they identify gaps the list doesn't cover — but they should explain why the buy list doesn't address that gap.
9. Use web search to research the specific companies, sectors, and recent news about the loans on the buy list.
```

Add buy list to the user prompt string:

```typescript
${buyList && buyList.length > 0 ? `\n${formatBuyList(buyList)}\n\nGround your discussion in these specific loans. Research them with web search.` : ""}
```

- [ ] **Step 4: Add `buyList` parameter to `screeningSynthesisPrompt`**

Change the function signature (line 1546) to add `buyList?: BuyListItem[]`:

```typescript
export function screeningSynthesisPrompt(
  debate: string,
  gapAnalysis: string,
  profile: CloProfile,
  reportPeriodContext?: string,
  buyList?: BuyListItem[]
): { system: string; user: string } {
```

Update the system prompt — after the current instructions, add:

```
If a buy list was provided, the synthesized ideas should primarily come FROM the buy list. Each idea should reference specific buy list loans by name with their actual metrics (spread, rating, price, etc.). Ideas from outside the buy list are acceptable but should be clearly flagged as "not currently on buy list."
```

Add buy list to the user prompt string:

```typescript
${buyList && buyList.length > 0 ? `\n${formatBuyList(buyList)}` : ""}
```

- [ ] **Step 5: Add `buyList` parameter to `creditAnalysisPrompt`**

Change the function signature (line 918) to add `buyList?: BuyListItem[]`:

```typescript
export function creditAnalysisPrompt(
  analysis: Pick<LoanAnalysis, ...>,
  profile: CloProfile,
  reportPeriodContext?: string,
  buyList?: BuyListItem[]
): { system: string; user: string } {
```

Add to the system prompt, after section 11 (Kill Criteria):

```
12. **Buy List Context** — If a buy list is provided, compare this specific loan against other candidates on the list. Is this the best use of capital vs alternatives? What does the manager give up by choosing this loan over other buy list options?
```

Add buy list to the user prompt string:

```typescript
${buyList && buyList.length > 0 ? `\nBUY LIST CONTEXT (other loans under consideration — compare this loan against alternatives):\n${formatBuyList(buyList)}` : ""}
```

- [ ] **Step 6: Add `buyList` parameter to `seniorAnalystSystemPrompt`**

Change the function signature (line 731) to add `buyList?: BuyListItem[]`:

```typescript
export function seniorAnalystSystemPrompt(
  profile: CloProfile,
  portfolioSnapshot: string,
  reportPeriodContext?: string,
  buyList?: BuyListItem[]
): string {
```

Add buy list section to the returned system prompt string, after the `PORTFOLIO HISTORY` section:

```typescript
const buyListSection = buyList && buyList.length > 0
  ? `\nBUY LIST (candidate loans under active consideration — reference when discussing trade ideas, portfolio optimization, or credit opportunities):\n${formatBuyList(buyList)}`
  : "";
```

Include `${buyListSection}` in the return string after `${portfolioSnapshot ? ...}`.

- [ ] **Step 7: Add `buyList` parameter to remaining prompt functions that take profile context**

For `individualAssessmentsPrompt`, `analysisDebatePrompt`, `premortemPrompt`, `creditMemoPrompt`, `riskAssessmentPrompt`, `recommendationPrompt` — add `buyList?: BuyListItem[]` parameter and include buy list context in their user prompts:

```typescript
${buyList && buyList.length > 0 ? `\nBUY LIST CONTEXT:\n${formatBuyList(buyList)}` : ""}
```

- [ ] **Step 8: Commit**

```bash
git add web/worker/clo-prompts.ts
git commit -m "feat(clo): inject buy list context into all AI prompts"
```

---

### Task 8: Wire buy list into analysis and screening pipelines

**Files:**
- Modify: `web/worker/clo-pipeline.ts`

- [ ] **Step 1: Import buy list functions**

Add at the top of `clo-pipeline.ts`:

```typescript
import { getBuyListForProfile } from "../lib/clo/buy-list.js";
```

- [ ] **Step 2: Fetch buy list in `runAnalysisPipeline`**

After fetching the profile (around line 335), add:

```typescript
const buyListItems = await getBuyListForProfile(analysisRow.profile_id);
```

Then pass `buyListItems` to every prompt function call that now accepts it:
- `creditAnalysisPrompt(analysis, profile, reportPeriodContext || undefined, buyListItems)` (line ~416)
- `individualAssessmentsPrompt(..., buyListItems)` (line ~466)
- `analysisDebatePrompt(..., buyListItems)` (line ~483)
- `premortemPrompt(..., buyListItems)` (line ~500)
- `creditMemoPrompt(..., buyListItems)` (line ~517)
- `riskAssessmentPrompt(..., buyListItems)` (line ~535)
- `recommendationPrompt(..., buyListItems)` (line ~553)

- [ ] **Step 3: Fetch buy list in `runScreeningPipeline`**

After fetching the profile (around line 603), add:

```typescript
const buyListItems = await getBuyListForProfile(screeningRow.profile_id);
```

Then pass `buyListItems` to every prompt function call:
- `portfolioGapAnalysisPrompt(profile, recentAnalyses, reportPeriodContext || undefined, buyListItems)` (line ~627)
- `screeningDebatePrompt(members, rawFiles["gap-analysis.md"], focusArea, profile, reportPeriodContext || undefined, buyListItems)` (line ~638)
- `screeningSynthesisPrompt(rawFiles["screening-debate.md"], rawFiles["gap-analysis.md"], profile, reportPeriodContext || undefined, buyListItems)` (line ~653)

- [ ] **Step 4: Commit**

```bash
git add web/worker/clo-pipeline.ts
git commit -m "feat(clo): pass buy list to all pipeline prompt calls"
```

---

### Task 9: Wire buy list into chat and follow-up routes

**Files:**
- Modify: `web/app/api/clo/chat/route.ts`
- Modify: `web/app/api/clo/analyses/[id]/follow-ups/route.ts`
- Modify: `web/app/api/clo/screenings/[id]/follow-ups/route.ts`
- Modify: `web/app/api/clo/panels/[id]/follow-ups/route.ts`
- Modify: `web/app/api/clo/briefing/route.ts`

- [ ] **Step 1: Add buy list to analyst chat route**

In `web/app/api/clo/chat/route.ts`:

Import: `import { getBuyListForProfile } from "@/lib/clo/buy-list";`

After `const cloProfile = rowToProfile(...)` (line 90), add:
```typescript
const buyListItems = await getBuyListForProfile(cloProfile.id);
```

Update the `seniorAnalystSystemPrompt` call (line 114) to pass buy list:
```typescript
seniorAnalystSystemPrompt(cloProfile, portfolioSnapshot, reportPeriodContext || undefined, buyListItems)
```

- [ ] **Step 2: Add buy list to briefing route**

In `web/app/api/clo/briefing/route.ts`:

Import: `import { getBuyListForUser, formatBuyList } from "@/lib/clo/buy-list";`

After building `profileContext` (line 44), fetch buy list and append:
```typescript
const buyListItems = await getBuyListForUser(user.id);
const buyListContext = formatBuyList(buyListItems);
const fullProfileContext = buyListContext
  ? `${profileContext}\n\n${buyListContext}\n\nHighlight any briefing items relevant to the buy list companies, sectors, or credit themes.`
  : profileContext;
```

Pass `fullProfileContext` instead of `profileContext` to `getUserBriefingDigest`.

- [ ] **Step 3: Add buy list context to follow-up routes**

For each follow-up route (`analyses/[id]/follow-ups`, `screenings/[id]/follow-ups`, `panels/[id]/follow-ups`):

Import `getBuyListForProfile` and `formatBuyList` from `@/lib/clo/buy-list`.

Fetch buy list items using the profile ID available in each route's context. Append `formatBuyList(items)` to the system prompt or context string that gets passed to the AI, with the label:

```
BUY LIST (candidate loans under consideration):
{formatted buy list}
```

The exact injection point varies by route — look for where `profile` or `constraints` context is built and append there.

- [ ] **Step 4: Commit**

```bash
git add web/app/api/clo/chat/route.ts web/app/api/clo/briefing/route.ts web/app/api/clo/analyses/\[id\]/follow-ups/route.ts web/app/api/clo/screenings/\[id\]/follow-ups/route.ts web/app/api/clo/panels/\[id\]/follow-ups/route.ts
git commit -m "feat(clo): inject buy list context into chat, briefing, and follow-up routes"
```

---

## Chunk 4: Analysis Form Buy List Selector

### Task 10: Create BuyListLoanSelector component

**Files:**
- Create: `web/components/clo/BuyListLoanSelector.tsx`

- [ ] **Step 1: Create the selector component**

```tsx
"use client";

import { useState, useEffect } from "react";
import type { BuyListItem } from "@/lib/clo/types";

interface Props {
  onSelect: (item: BuyListItem) => void;
}

export default function BuyListLoanSelector({ onSelect }: Props) {
  const [items, setItems] = useState<BuyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/clo/buy-list")
      .then((res) => res.json())
      .then((data) => {
        setItems(data.items || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (items.length === 0) return null;

  const filtered = search
    ? items.filter((item) =>
        item.obligorName.toLowerCase().includes(search.toLowerCase()) ||
        (item.sector?.toLowerCase().includes(search.toLowerCase()))
      )
    : items;

  return (
    <div style={{
      padding: "0.75rem",
      background: "var(--color-accent-subtle)",
      border: "1px solid var(--color-accent)",
      borderRadius: "var(--radius-sm)",
      marginBottom: "1rem",
    }}>
      <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.4rem" }}>
        Select from Buy List
      </div>
      <input
        type="text"
        className="ic-input"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or sector..."
        style={{ marginBottom: "0.5rem", fontSize: "0.85rem" }}
      />
      <div style={{ maxHeight: "200px", overflowY: "auto" }}>
        {filtered.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "0.4rem 0.5rem",
              background: "none",
              border: "none",
              borderBottom: "1px solid var(--color-border)",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            <span style={{ fontWeight: 600 }}>{item.obligorName}</span>
            {item.sector && <span style={{ color: "var(--color-text-muted)", marginLeft: "0.5rem" }}>{item.sector}</span>}
            <span style={{ float: "right", color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
              {[
                item.moodysRating || item.spRating ? `${[item.moodysRating, item.spRating].filter(Boolean).join("/")}` : null,
                item.spreadBps != null ? `${item.spreadBps}bps` : null,
                item.price != null ? `@${item.price}` : null,
              ].filter(Boolean).join(" | ")}
            </span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: "0.5rem", fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
            No matching loans
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/clo/BuyListLoanSelector.tsx
git commit -m "feat(clo): add BuyListLoanSelector component for analysis form"
```

---

### Task 11: Integrate BuyListLoanSelector into AnalysisForm

**Files:**
- Modify: `web/components/clo/AnalysisForm.tsx`

- [ ] **Step 1: Import the selector and BuyListItem type**

Add imports at top:
```typescript
import BuyListLoanSelector from "./BuyListLoanSelector";
import type { BuyListItem } from "@/lib/clo/types";
```

- [ ] **Step 2: Add a `handleBuyListSelect` function**

Inside the `AnalysisForm` component, add after the state declarations:

```typescript
function handleBuyListSelect(item: BuyListItem) {
  setBorrowerName(item.obligorName);
  setSector(item.sector || "");
  setSpreadCoupon(
    item.spreadBps != null
      ? `${item.referenceRate || "SOFR"} + ${item.spreadBps}bps`
      : ""
  );
  setRating([item.moodysRating, item.spRating].filter(Boolean).join("/"));
  setMaturity(item.maturityDate || "");
  setFacilitySize(item.facilitySize != null ? `$${item.facilitySize.toLocaleString()}` : "");
  setLeverage(item.leverage != null ? `${item.leverage}x` : "");
  setInterestCoverage(item.interestCoverage != null ? `${item.interestCoverage}x` : "");
  setCovenantsSummary(item.isCovLite ? "Covenant-lite" : "");
  setNotes(item.notes || "");
  if (!title.trim()) {
    setTitle(`Buy Analysis: ${item.obligorName}${item.facilityName ? ` ${item.facilityName}` : ""}`);
  }
}

function handleSwitchBuyListSelect(item: BuyListItem) {
  setSwitchBorrowerName(item.obligorName);
  setSwitchSector(item.sector || "");
  setSwitchSpreadCoupon(
    item.spreadBps != null
      ? `${item.referenceRate || "SOFR"} + ${item.spreadBps}bps`
      : ""
  );
  setSwitchRating([item.moodysRating, item.spRating].filter(Boolean).join("/"));
  setSwitchMaturity(item.maturityDate || "");
  setSwitchFacilitySize(item.facilitySize != null ? `$${item.facilitySize.toLocaleString()}` : "");
  setSwitchLeverage(item.leverage != null ? `${item.leverage}x` : "");
  setSwitchInterestCoverage(item.interestCoverage != null ? `${item.interestCoverage}x` : "");
  setSwitchCovenantsSummary(item.isCovLite ? "Covenant-lite" : "");
  setSwitchNotes(item.notes || "");
}
```

- [ ] **Step 3: Render the selector in the form**

In the JSX, add the selector before the primary loan fields section. Right before `{analysisType === "switch" && (` around line 377, add:

```tsx
<BuyListLoanSelector onSelect={handleBuyListSelect} />
```

For switch analysis, add another selector before the switch loan fields. Right before `{renderLoanFields("switch", ...)}` around line 394, add:

```tsx
<BuyListLoanSelector onSelect={handleSwitchBuyListSelect} />
```

- [ ] **Step 4: Commit**

```bash
git add web/components/clo/AnalysisForm.tsx
git commit -m "feat(clo): integrate buy list loan selector into analysis form"
```

---

## Chunk 5: Final Wiring and Integration Test

### Task 12: Verify all prompt functions have matching parameter updates

**Files:**
- Modify: `web/worker/clo-prompts.ts` (if any were missed)

- [ ] **Step 1: Verify each prompt function signature matches the pipeline call**

Check that every prompt function that was updated with `buyList?: BuyListItem[]` is called with the correct argument in `clo-pipeline.ts`. The key functions to verify:

| Prompt Function | Called In |
|---|---|
| `creditAnalysisPrompt` | `runAnalysisPipeline` Phase 1 |
| `individualAssessmentsPrompt` | `runAnalysisPipeline` Phase 3 |
| `analysisDebatePrompt` | `runAnalysisPipeline` Phase 4 |
| `premortemPrompt` | `runAnalysisPipeline` Phase 5 |
| `creditMemoPrompt` | `runAnalysisPipeline` Phase 6 |
| `riskAssessmentPrompt` | `runAnalysisPipeline` Phase 7 |
| `recommendationPrompt` | `runAnalysisPipeline` Phase 8 |
| `portfolioGapAnalysisPrompt` | `runScreeningPipeline` Phase 1 |
| `screeningDebatePrompt` | `runScreeningPipeline` Phase 2 |
| `screeningSynthesisPrompt` | `runScreeningPipeline` Phase 3 |
| `seniorAnalystSystemPrompt` | `chat/route.ts` |

- [ ] **Step 2: Commit any fixes**

```bash
git add -A
git commit -m "fix(clo): ensure all prompt function signatures match pipeline calls"
```

---

### Task 13: Final commit and merge

- [ ] **Step 1: Run the build to check for TypeScript errors**

Run: `cd /Users/solal/Documents/GitHub/funzies/web && npm run build`

Fix any type errors.

- [ ] **Step 2: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(clo): resolve build errors from buy list integration"
```

- [ ] **Step 3: Merge to main**

```bash
git checkout main && git merge <branch-name>
```
