# CLO Extraction — Four-Patch Fix Design

**Date:** 2026-04-22 (revised after code verification)
**Scope:** Four localized patches to the compliance-report extraction pipeline. No new strategy, no pipeline rewrite.
**Non-goals:** Trustee-format logic (condensing layer's job), PPM pipeline, touching the unused 5-pass flow (`runExtraction`).

---

## Context

The extraction pipeline reads **condensed compliance-report PDFs** — a canonical format produced by the condensing layer upstream. Trustee-specific variation (BNY, Virtus, US Bank, etc.) is handled by the condenser; the extractor never sees raw trustee output.

**Production entry point:** `runSectionExtraction` in `web/lib/clo/extraction/runner.ts:863`, invoked from `web/worker/index.ts:929`. It runs a **section-based** flow: the document mapper identifies sections in the PDF, then `extractAllSections` dispatches each section to its registered `(schema, prompt)` pair in `section-extractor.ts` (`getSectionConfig` at line 20). Multiple independent passes are merged via `mergeAllPasses`.

**Note:** There is a second entry point `runExtraction` at line 325 (5-pass flow) — it is **not called** from the compliance-report worker path and is out of scope for this design.

Four gaps identified:

1. **No historical payment series.** §20 "Notes Payment History (inception-to-date)" in the condensed format is not extracted. Blocks inception XIRR.
2. **Section detection has hardcoded page-range template with known drift.** `BNY_COMPLIANCE_TEMPLATE` in `runner.ts:48-59` + `ensureComplianceSections` at line 81 fills missing sections with page ranges derived from one BNY deal — ranges drift across deals within the same trustee (e.g., default_detail on p.42 in Ares XV, template says 10-12).
3. **Defaulted-par derivation fails when holdings-join misses.** `resolver.ts:676-706` derives `preExistingDefaultedPar` etc. from `holdings.filter(h => h.isDefaulted)`. Holdings get flagged in `normalizer.ts:396-456` by **fuzzy obligor-name matching** against `default_detail.defaults`. If the match fails (e.g., asset_schedule and default_detail use different legal name suffixes), no holding is flagged → defaulted par reads zero even though `default_detail` has rows.
4. **String-null coercion is shallow and single-section.** `fixStringNulls` in `ingestion-gate.ts:36-44` walks one level and is called only on `data.keyDates` (line 53). Strings like `"null"` in `interestMechanics.deferredInterestCompounds` flow through untouched.

---

## §1 — Notes Payment History extraction (new section type)

`notes_information` becomes a first-class section in the compliance flow, registered alongside `default_detail`, `asset_schedule`, etc. It is **not** a new pass. The existing `extractAllSections` machinery dispatches to it automatically.

**Trigger heading:** `"Notes Payment History (inception-to-date)"` (§20 in condensed format).

### Files touched

| File | Change |
|---|---|
| `web/lib/clo/extraction/section-schemas.ts` | Add `notesInformationSchema` |
| `web/lib/clo/extraction/section-prompts.ts` | Add `notesInformationPrompt` |
| `web/lib/clo/extraction/section-extractor.ts` | Register in `getSectionConfig` compliance_report map |
| `web/lib/clo/extraction/document-mapper.ts` | Append `"notes_information"` to `COMPLIANCE_SECTION_TYPES` |
| `web/lib/clo/extraction/normalizer.ts` | Extend `normalizeSectionResults` with `paymentHistory` field |
| `web/lib/clo/extraction/runner.ts` | Add upsert-per-row block to `runSectionExtraction` |
| `web/lib/migrations/010_add_payment_history.sql` | New migration (new table) |

### `notesInformationSchema`

```ts
export const notesInformationSchema = z.object({
  perTranche: z.record(z.string(), z.array(z.object({
    period:                 z.number().nullable(),
    paymentDate:            z.string(),              // YYYY-MM-DD
    parCommitment:          z.number().nullable(),
    factor:                 z.number().nullable(),
    interestPaid:           z.number().nullable(),
    principalPaid:          z.number().nullable(),
    cashflow:               z.number().nullable(),
    endingBalance:          z.number().nullable(),
    interestShortfall:      z.number().nullable(),
    accumInterestShortfall: z.number().nullable(),
  }))),
});

export type NotesInformation = z.infer<typeof notesInformationSchema>;
```

**No `transactionType` in the schema.** Classification is a DB generated column derived from the four numeric fields.

### `notesInformationPrompt`

Key instructions:
- Extract every row for every tranche — zero-amount rows (ramp-up stub periods, deferred-interest suppression) must be preserved.
- Normalize DD-MMM-YYYY → YYYY-MM-DD.
- Per-tranche subsection layout is canonical in the condensed format.
- First row per tranche is the investor's day-zero purchase; keep it with `period=0` and negative `principalPaid`/`cashflow`.
- Do not emit `transactionType`. Return numeric fields only.

Companion `notesInformationRepairPrompt` for resume-from-period-N when truncated.

### `normalizeSectionResults` extension

Return type adds `paymentHistory: PaymentHistoryRow[]` where each row has `{ className, period, paymentDate, parCommitment, factor, interestPaid, principalPaid, cashflow, endingBalance, interestShortfall, accumInterestShortfall }`. The normalizer flattens `sections.notes_information?.perTranche` and dedupes by `(className, paymentDate)`.

### Migration `010_add_payment_history.sql`

```sql
CREATE TABLE IF NOT EXISTS clo_payment_history (
  id                       BIGSERIAL PRIMARY KEY,
  profile_id               UUID NOT NULL REFERENCES clo_profiles(id) ON DELETE CASCADE,
  class_name               TEXT NOT NULL,
  payment_date             DATE NOT NULL,
  period                   INTEGER,
  par_commitment           NUMERIC,
  factor                   NUMERIC,
  interest_paid            NUMERIC,
  principal_paid           NUMERIC,
  cashflow                 NUMERIC,
  ending_balance           NUMERIC,
  interest_shortfall       NUMERIC,
  accum_interest_shortfall NUMERIC,

  transaction_type TEXT GENERATED ALWAYS AS (
    CASE
      WHEN period IS NULL OR period = 0 THEN 'SALE'
      WHEN COALESCE(interest_paid, 0) = 0 AND COALESCE(principal_paid, 0) = 0 THEN 'NO_PAYMENT'
      WHEN ending_balance = 0 AND COALESCE(principal_paid, 0) > 0 THEN 'REDEMPTION'
      WHEN COALESCE(interest_paid, 0) > 0 AND COALESCE(principal_paid, 0) > 0 THEN 'INTEREST_AND_PRINCIPAL_PAYMENT'
      WHEN COALESCE(principal_paid, 0) > 0 THEN 'PRINCIPAL_PAYMENT'
      WHEN COALESCE(interest_paid, 0) > 0 THEN 'INTEREST_PAYMENT'
      ELSE 'NO_PAYMENT'
    END
  ) STORED,

  extracted_value          JSONB NOT NULL,
  override_value           JSONB,
  override_reason          TEXT,
  overridden_by            TEXT,
  overridden_at            TIMESTAMPTZ,

  source_period_id         UUID REFERENCES clo_report_periods(id),
  last_seen_period_id      UUID REFERENCES clo_report_periods(id),

  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (profile_id, class_name, payment_date)
);

CREATE INDEX IF NOT EXISTS idx_payment_history_profile_date
  ON clo_payment_history (profile_id, payment_date);
```

**Note on partition key.** Most CLO extraction tables key on `report_period_id` and use the `replaceIfPresent` helper (`runner.ts:951`) that deletes by `report_period_id` before inserting. `clo_payment_history` diverges: it keys on `profile_id` because history is inception-to-date (spans reports). **Do not use `replaceIfPresent` for this table** — use upsert-per-row instead.

### Persistence in `runSectionExtraction`

After `normalizeSectionResults` produces `normalized.paymentHistory`, upsert each row individually (not `replaceIfPresent`). Per-row upsert preserves user overrides across re-extractions.

```ts
for (const row of normalized.paymentHistory) {
  // Restatement diff-log (pre-upsert)
  const { rows: existingRows } = await query<{ extracted_value: unknown }>(
    `SELECT extracted_value FROM clo_payment_history
     WHERE profile_id = $1 AND class_name = $2 AND payment_date = $3`,
    [profileId, row.className, row.paymentDate]
  );
  if (existingRows.length > 0) {
    const prior = existingRows[0].extracted_value as Record<string, unknown>;
    const diffs: string[] = [];
    for (const key of ["interestPaid", "principalPaid", "cashflow", "endingBalance"]) {
      const rowVal = (row as Record<string, unknown>)[key];
      if (prior[key] !== rowVal) {
        diffs.push(`${key}: ${prior[key]} → ${rowVal}`);
      }
    }
    if (diffs.length > 0) {
      console.warn(
        `[extraction] payment-history restatement detected: profile=${profileId} ` +
        `class=${row.className} date=${row.paymentDate} changes=[${diffs.join(", ")}]`
      );
    }
  }

  // Upsert
  await query(
    `INSERT INTO clo_payment_history (
       profile_id, class_name, payment_date, period, par_commitment, factor,
       interest_paid, principal_paid, cashflow, ending_balance,
       interest_shortfall, accum_interest_shortfall,
       extracted_value, source_period_id, last_seen_period_id
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
     ON CONFLICT (profile_id, class_name, payment_date) DO UPDATE SET
       period = EXCLUDED.period,
       par_commitment = EXCLUDED.par_commitment,
       factor = EXCLUDED.factor,
       interest_paid = EXCLUDED.interest_paid,
       principal_paid = EXCLUDED.principal_paid,
       cashflow = EXCLUDED.cashflow,
       ending_balance = EXCLUDED.ending_balance,
       interest_shortfall = EXCLUDED.interest_shortfall,
       accum_interest_shortfall = EXCLUDED.accum_interest_shortfall,
       extracted_value = EXCLUDED.extracted_value,
       source_period_id = EXCLUDED.source_period_id,
       last_seen_period_id = EXCLUDED.last_seen_period_id,
       updated_at = NOW()`,
    [
      profileId, row.className, row.paymentDate, row.period, row.parCommitment, row.factor,
      row.interestPaid, row.principalPaid, row.cashflow, row.endingBalance,
      row.interestShortfall, row.accumInterestShortfall,
      JSON.stringify(row),
      reportPeriodId,
    ]
  );

  // Override auto-resolve (post-upsert)
  await query(
    `UPDATE clo_payment_history
     SET override_value = NULL, override_reason = NULL, overridden_by = NULL, overridden_at = NULL
     WHERE profile_id = $1 AND class_name = $2 AND payment_date = $3
       AND override_value IS NOT NULL
       AND override_value = extracted_value`,
    [profileId, row.className, row.paymentDate]
  );
}
```

**Stale-row preservation:** rows absent from a new report are NOT deleted; their `last_seen_period_id` simply stops updating. Hard-delete is an explicit admin action.

### Read path (consumer-side)

```sql
SELECT
  class_name,
  payment_date::text AS payment_date,
  transaction_type,
  COALESCE((override_value->>'interestPaid')::numeric,  (extracted_value->>'interestPaid')::numeric)  AS interest_paid,
  COALESCE((override_value->>'principalPaid')::numeric, (extracted_value->>'principalPaid')::numeric) AS principal_paid,
  COALESCE((override_value->>'cashflow')::numeric,      (extracted_value->>'cashflow')::numeric)      AS cashflow,
  (override_value IS NOT NULL) AS has_override
FROM clo_payment_history
WHERE profile_id = $1 AND class_name = $2
ORDER BY payment_date;
```

---

## §2 — Heading-based section detection

**Remove** `BNY_COMPLIANCE_TEMPLATE` (`runner.ts:48-59`) and the body of `ensureComplianceSections` (`runner.ts:81-113` approx). Keep the function name, replace its body with heading-scan logic. Both call sites at `runner.ts:805` and `runner.ts:822` continue to work; their signatures change to accept a `pages` array.

### Heading catalog

In `document-mapper.ts`:

```ts
export type SectionType =
  | "compliance_summary" | "par_value_tests" | "interest_coverage_tests"
  | "default_detail" | "asset_schedule" | "concentration_tables"
  | "waterfall" | "trading_activity" | "interest_accrual"
  | "account_balances" | "supplementary" | "notes_information";

export const CANONICAL_HEADINGS: Record<SectionType, string> = {
  compliance_summary:      "Deal Identity",
  par_value_tests:         "Par Value (Over-collateralisation) Tests",
  interest_coverage_tests: "Interest Coverage Tests",
  default_detail:          "Default / Deferring / Current Pay / Discount / Exchanged Securities / Haircut",
  asset_schedule:          "Schedule of Investments — Trustee View",
  concentration_tables:    "Portfolio Profile Tests",
  waterfall:               "Interest Waterfall execution",
  trading_activity:        "Trading Activity (current period)",
  interest_accrual:        "Interest Smoothing Account",
  account_balances:        "Account Balances (full inventory)",
  supplementary:           "Rating Migration",
  notes_information:       "Notes Payment History (inception-to-date)",
};
```

Also append `"notes_information"` to the existing `COMPLIANCE_SECTION_TYPES` array in `document-mapper.ts:10`.

### `scanHeadings` function

```ts
export interface ScannedSection {
  sectionType: SectionType;
  pageStart: number;
  pageEnd: number;
  confidence: "high";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scanHeadings(pages: Array<{ page: number; text: string }>): ScannedSection[] {
  const found: Array<{ sectionType: SectionType; pageStart: number }> = [];

  for (const [sectionType, heading] of Object.entries(CANONICAL_HEADINGS) as Array<[SectionType, string]>) {
    const re = new RegExp(`(?:^|\\n)\\s*(?:§?\\s*\\d+(?:\\.\\d+)?\\.?\\s*)?${escapeRegex(heading)}`, "im");
    for (const p of pages) {
      if (re.test(p.text)) {
        found.push({ sectionType, pageStart: p.page });
        break;
      }
    }
  }

  if (found.length === 0) return [];

  found.sort((a, b) => a.pageStart - b.pageStart);
  const maxPage = Math.max(...pages.map(p => p.page));

  return found.map((curr, i) => {
    const next = found[i + 1];
    return {
      sectionType: curr.sectionType,
      pageStart: curr.pageStart,
      pageEnd: next ? next.pageStart - 1 : maxPage,
      confidence: "high" as const,
    };
  });
}
```

### New `ensureComplianceSections` body

```ts
function ensureComplianceSections(
  documentMap: DocumentMap,
  pages: Array<{ page: number; text: string }>,
): void {
  const existing = new Set(documentMap.sections.map(s => s.sectionType));
  const scanned = scanHeadings(pages);
  for (const section of scanned) {
    if (existing.has(section.sectionType)) continue;
    documentMap.sections.push({
      sectionType: section.sectionType,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      confidence: section.confidence,
      notes: "filled by heading scan",
    });
  }

  const located = new Set(documentMap.sections.map(s => s.sectionType));
  for (const sectionType of Object.keys(CANONICAL_HEADINGS) as SectionType[]) {
    if (!located.has(sectionType)) {
      console.warn(
        `[extraction] canonical heading not found for section "${sectionType}" — section absent from map`
      );
    }
  }
}
```

### Call-site updates in `runSingleExtractionPass`

Two sites need updating:

- **Line 805** (pdfplumber-success path): currently passes `firstPageText`. Change to pass full `pdfText.pages` array (already available in scope).
- **Line 822** (pdfplumber-fallback path): currently called with no text argument. Change to pass `[]` (empty pages array) — heading scan short-circuits, no harm done. Log that heading scan is skipped in fallback mode.

---

## §3 — Default detail → phantom holdings (normalizer, not resolver)

**Where the fix actually goes:** `normalizer.ts:396-456`, not `resolver.ts`.

Reason: `resolver.ts:438 resolveWaterfallInputs` does not receive `default_detail` as a parameter. It only sees `holdings: CloHolding[]` — already processed by the normalizer. The right layer to fix the data gap is the normalizer, which **does** have `default_detail` in scope.

### Current normalizer behavior (`normalizer.ts:396-456`)

1. Reads `sections.default_detail.defaults` into `defaultedObligors: Set<string>`.
2. Loops `holdings`, sets `h.is_defaulted = true` if obligor name matches (fuzzy substring or whole-string).
3. Enriches matched holdings with per-obligor recovery rates from default_detail.

**Bug:** when fuzzy matching fails, `defaultedObligors` has entries that are never reflected in any holding.

### Fix: synthesize phantom holdings for unmatched defaults

After the existing match loop, track which `default_detail.defaults` rows *actually* flagged a holding. For each unmatched row, append a synthetic holding to `holdings` so the resolver's existing `holdings.filter(h => h.isDefaulted)` math works untouched.

```ts
// After the existing enrichment loop (around line 456), add:

const matchedObligors = new Set<string>();
for (const h of holdings) {
  if (h.is_defaulted) {
    const obligor = ((h.obligor_name ?? "") as string).toLowerCase().trim();
    if (obligor.length >= 4) matchedObligors.add(obligor);
  }
}

if (defaultDetail?.defaults) {
  let synthesized = 0;
  for (const d of defaultDetail.defaults) {
    const name = ((d.obligorName ?? d.obligor_name ?? "") as string).toLowerCase().trim();
    const isDefaulted = d.isDefaulted ?? d.is_defaulted ?? d.isDeferring ?? d.is_deferring;
    if (!isDefaulted || name.length < 4) continue;
    if (matchedObligors.has(name)) continue;

    const parAmount = (d.parAmount ?? d.par_amount) as number | null | undefined;
    if (parAmount == null || parAmount <= 0) continue;

    holdings.push(toDbRow({
      obligorName:        d.obligorName ?? d.obligor_name,
      parBalance:         parAmount,
      isDefaulted:        true,
      currentPrice:       d.marketPrice ?? d.market_price,
      recoveryRateMoodys: d.recoveryRateMoodys ?? d.recovery_rate_moodys,
      recoveryRateSp:     d.recoveryRateSp ?? d.recovery_rate_sp,
      recoveryRateFitch:  d.recoveryRateFitch ?? d.recovery_rate_fitch,
      dataOrigin:         "synthesized_from_default_detail",
    }, base));
    synthesized++;
  }
  if (synthesized > 0) {
    console.warn(
      `[normalizer] default_detail synthesis: created ${synthesized} phantom holdings ` +
      `from unmatched defaulted obligations. Canary: asset_schedule + default_detail ` +
      `obligor names disagree — condensing-layer lint may need attention.`
    );
  }
}
```

Phantom holdings are tagged with `data_origin: "synthesized_from_default_detail"` so consumers (UI, reconciliation) can filter them if needed. The resolver at `resolver.ts:676-706` treats them identically to real defaulted holdings, which is the point.

---

## §4 — Recursive string-null coercion

Unchanged from the earlier version. Replace `fixStringNulls` (shallow, keyDates-only) with `deepFixStringNulls` applied to the whole `ExtractedConstraints` tree at the top of `validateAndNormalizeConstraints`.

```ts
const firstOccurrenceLogged = new Map<string, boolean>();

export function deepFixStringNulls(value: unknown, path: string = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((v, i) => deepFixStringNulls(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepFixStringNulls(v, path ? `${path}.${k}` : k);
    }
    return out;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "null" || lower === "undefined") {
      if (!firstOccurrenceLogged.get(path)) {
        console.warn(`[ingestion-gate] string "${value}" coerced to null at ${path}`);
        firstOccurrenceLogged.set(path, true);
      }
      return null;
    }
  }
  return value;
}
```

**Performance guard:** one test asserts completion under 50ms on a 236-holding fixture.

---

## §5 — Testing plan

### Heading detection (§2)

- **Synthetic fixture test:** a mock `pages` array with embedded canonical headings at known page numbers → each entry in `CANONICAL_HEADINGS` resolves correctly; `pageEnd` = next.pageStart − 1; case-insensitive matching works; absent headings skip silently with a warn log.
- **Condensed v4 integration test:** deferred until Ares XV condensed v4 PDF is available in fixtures. Ground-truth check: `default_detail` resolves to its actual page in the condensed PDF.

### Notes Payment History extraction (§1)

- **Normalizer unit tests:** flatten perTranche into rows with `className`; dedupe by `(className, paymentDate)`; preserve zero-amount rows; empty input → empty output.
- **Integration (DB) test, skipped without `TEST_DATABASE_URL`:**
  - Upsert preserves override: insert row, set override, re-upsert, verify override intact.
  - Multi-period regression: seed periods 1–16, upsert period 17, verify 1–16 byte-for-byte unchanged.
  - Override auto-resolve: insert with override matching new extraction → override nulled after upsert.
  - Generated-column classification: insert six rows exercising SALE / NO_PAYMENT / INTEREST / PRINCIPAL / COMBINED / REDEMPTION → transaction_type matches.
- **Sub Note XIRR smoke test** (skip-guarded): ingest Ares XV condensed v4 (when available), compute IRR, assert within 3dp of ground-truth value. Ground truth TBD — either user provides or test snapshots first computed value.

### Default detail synthesis (§3)

- Unit test: empty holdings + populated `default_detail.defaults` (isDefaulted=true) → phantom holdings appear in normalizer output with `is_defaulted=true`, par_balance from `parAmount`, recovery rates from agency fields. Canary log emitted.
- Unit test: populated holdings matching all defaults → no synthesis, no log.
- Unit test: `default_detail` rows with `parAmount=null` or `parAmount<=0` → skipped, no synthesis.

### Recursive string-null (§4)

- Unit tests: depth 1/2/3 coercion; case-insensitive match (NULL, Null, nULL); array walking; legitimate values untouched; substring "null" left alone.
- Performance guard: 236-holding fixture < 50ms.

---

## §6 — Files touched

**New:**
- `web/lib/migrations/010_add_payment_history.sql`

**Modified:**
- `web/lib/clo/extraction/section-schemas.ts` — add `notesInformationSchema`.
- `web/lib/clo/extraction/section-prompts.ts` — add `notesInformationPrompt`, `notesInformationRepairPrompt`.
- `web/lib/clo/extraction/section-extractor.ts` — register `notes_information` in `getSectionConfig` compliance_report map.
- `web/lib/clo/extraction/document-mapper.ts` — add `COMPLIANCE_SECTION_TYPES` entry; add `CANONICAL_HEADINGS`, `SectionType`, `ScannedSection`, `scanHeadings`.
- `web/lib/clo/extraction/runner.ts` — remove `BNY_COMPLIANCE_TEMPLATE`; rewrite `ensureComplianceSections`; update two call sites (805, 822); add payment-history upsert block in `runSectionExtraction` after `normalizeSectionResults`.
- `web/lib/clo/extraction/normalizer.ts` — extend `normalizeSectionResults` return type with `paymentHistory`; add flatten+dedup logic for `sections.notes_information`; add phantom-holding synthesis after existing default_detail enrichment loop.
- `web/lib/clo/ingestion-gate.ts` — replace `fixStringNulls` with `deepFixStringNulls`; apply at top of `validateAndNormalizeConstraints`.
- Consumer-side inception-IRR read path — switch to `COALESCE(override_value->>'...', extracted_value->>'...')` query over `clo_payment_history`. Exact file located at execution time via grep.

**Untouched:**
- PPM pipeline (`ppm-extraction.ts` and friends).
- `runExtraction` (the 5-pass flow) — not on the compliance-report worker path.
- `resolver.ts` — default_detail fix happens upstream in the normalizer; resolver's derivation at `resolver.ts:676-706` works unchanged.
- `clo_tranche_snapshots` — separate concept from payment history.

---

## Appendix: the four gaps recap

| # | Gap | Fix location | Surface area |
|---|---|---|---|
| 1 | No §20 historical payment extraction | New `notes_information` section (schema + prompt + dispatcher entry + normalizer extension + upsert); new `clo_payment_history` table | ~7 files |
| 2 | Hardcoded page-range template drifts | Heading-based detection in `ensureComplianceSections` with closed canonical catalog | 2 files (`document-mapper.ts`, `runner.ts`) |
| 3 | Defaulted-par derivation fails on name mismatch | Phantom-holding synthesis in normalizer for unmatched `default_detail` rows | 1 file (`normalizer.ts`) |
| 4 | String "null" coercion shallow + single-section | Recursive walk at ingestion gate with first-occurrence logging | 1 file (`ingestion-gate.ts`) |
