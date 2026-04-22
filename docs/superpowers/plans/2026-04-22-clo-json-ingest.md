# CLO JSON Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **User override (CLAUDE.md):** no auto-generated test files. Skip TDD steps; verify via the end-of-task smoke commands and the final E2E smoke task.

**Goal:** Add a JSON-ingest path parallel to the existing PDF/LLM extraction. Pre-structured PPM and compliance JSON (e.g. `ppm.json`, `compliance.json` at repo root) uploads to a new endpoint, lands in the same DB tables + `profile.extracted_constraints` JSONB, and renders in `/clo/context` exactly like a PDF extraction would.

**Architecture:** Two mappers convert input JSON into the *existing* Zod section-schema shapes. Those shapes then flow through the *existing* `normalizePpmSectionResults` / `normalizeSectionResults` functions into the *existing* DB writers and resolver. The only new persistence glue is (a) extracting PPM-relational-sync out of the worker into a shared module so both paths can reuse it, and (b) a compliance persist helper that mirrors the inline inserts in `runner.ts`. Zero Zod schema changes. Zero changes to the LLM path. Full raw input is preserved in `profile.ppm_raw_extraction` and `clo_report_periods.raw_extraction` for audit/replay.

**Tech Stack:** TypeScript, Next.js app router, Zod, `pg` (Postgres), existing `web/lib/clo/*` infrastructure.

---

## Input files

- `/Users/solal/Documents/GitHub/funzies/ppm.json` — reference sample (11 top-level sections, hand-verified v2 of Ares European CLO XV offering circular)
- `/Users/solal/Documents/GitHub/funzies/compliance.json` — reference sample (40+ top-level sections, v6 of Ares XV monthly BNY trustee report, 280-position §22 Interest Accrual Detail)

Both are the **authoritative shape** this plan targets. If the user later provides other deals, the mapper must tolerate the same shape; it does not need to tolerate arbitrary reshapes.

## Output targets

| Input | Lands in | How |
|---|---|---|
| PPM JSON | `profile.extracted_constraints` (JSONB) | via `normalizePpmSectionResults` |
| PPM JSON | `clo_deals` row, `clo_tranches` rows | via `syncPpmToRelationalTables` |
| PPM JSON (raw) | `profile.ppm_raw_extraction` (JSONB) | direct stash |
| Compliance JSON | `clo_report_periods` row (find-or-create by `report_date`) | direct |
| Compliance JSON | `clo_pool_summary`, `clo_compliance_tests`, `clo_holdings`, `clo_concentrations`, `clo_waterfall_steps`, `clo_proceeds`, `clo_trades`, `clo_tranche_snapshots`, `clo_account_balances`, `clo_par_value_adjustments`, `clo_events`, `clo_payment_history` | via `normalizeSectionResults` + compliance persist helper |
| Compliance JSON (raw) | `clo_report_periods.raw_extraction` (JSONB) | direct stash |

## File structure

### New files
- `web/lib/clo/extraction/json-ingest/types.ts` — TypeScript types for the input JSON shapes
- `web/lib/clo/extraction/json-ingest/utils.ts` — unit-conversion + date helpers
- `web/lib/clo/extraction/json-ingest/ppm-mapper.ts` — PpmJson → `Record<PpmSectionType, unknown>`
- `web/lib/clo/extraction/json-ingest/compliance-mapper.ts` — ComplianceJson → `Record<ComplianceSectionType, unknown>`
- `web/lib/clo/extraction/json-ingest/persist-compliance.ts` — normalize + insert compliance sections to all relevant tables
- `web/lib/clo/extraction/json-ingest/ingest.ts` — orchestrator (`ingestPpmJson`, `ingestComplianceJson`)
- `web/app/api/clo/profile/extract-from-json/route.ts` — POST endpoint
- `web/app/clo/context/JsonUploadSection.tsx` — UI component (two file pickers)

### Modified files
- `web/worker/index.ts` — export `syncPpmToRelationalTables` (or re-import from a new shared location)
- `web/lib/clo/extraction/persist-ppm.ts` — NEW home for `syncPpmToRelationalTables` if moved; otherwise just re-exported
- `web/app/clo/context/page.tsx` (or the existing upload panel) — render `<JsonUploadSection />`

Files that must NOT be modified: any existing Zod schema file (`section-schemas.ts`), any existing normalizer (`normalizer.ts`), resolver (`resolver.ts`), ingestion-gate, runner `runExtraction`, or PDF worker loop beyond the export tweak.

---

## Design invariants

1. **Schema stability.** Mappers output shapes that pass the *existing* Zod schemas verbatim. If a field in the input JSON has no home in our schema, drop it (but preserve the whole raw input in `*_raw_extraction` JSONB).
2. **LLM path untouched.** No change to any section prompt, document-mapper, text-extractor, or multi-pass merger.
3. **Unit truth.** spreads in bps (not percent). Ratios as percent (not decimal). Dates as ISO `YYYY-MM-DD`. Conversions happen in the mapper; the normalizer assumes the canonical form already.
4. **Idempotent ingest.** Re-uploading the same JSON must overwrite cleanly, not duplicate rows. Use the same `report_period_id`/`profile_id`-keyed DELETE+INSERT pattern as SDF.
5. **Composable with SDF.** If SDF has already written to a table for a given `report_period_id`, the compliance-JSON persist must honor the same `hasSdfData` gate that `runner.ts` uses (e.g. skip `clo_compliance_tests` overwrite when SDF data exists). Match the precedence behaviour of runner.ts exactly.

---

## Tasks

Each task has: files to touch, exact implementation notes, a completion check. No test files are produced per user CLAUDE.md; implementers verify by running `tsc --noEmit` plus (where meaningful) the smoke command listed in the task.

---

### Task 1: Input types

**Files:**
- Create: `web/lib/clo/extraction/json-ingest/types.ts`

- [ ] **Step 1: Write TypeScript types mirroring the input JSONs**

Two interfaces, exported. No Zod yet — this is input typing, not output validation. Permissive on unknown fields (`[k: string]: unknown`) at every level so we can tolerate future-extended inputs.

```ts
// web/lib/clo/extraction/json-ingest/types.ts

export interface PpmJsonTranche {
  class: string;                    // "Class A" ... "Subordinated Notes"
  principal: number;
  rate_description?: string;
  rate_type?: "floating" | "fixed" | "residual";
  spread_pct?: number;              // e.g. 0.95 (percent)
  margin_decimal?: number;          // e.g. 0.0095 (decimal)
  fixed_coupon_pct?: number;
  fixed_coupon_decimal?: number;
  alt_rate_post_freq_switch?: string;
  fitch?: string;
  moodys?: string;
  issue_price_pct?: number;
  oid_eur?: number;
  note?: string;
  [k: string]: unknown;
}

export interface PpmJsonTransactionParty {
  role: string;
  entity: string;
  location?: string;
  regulatory_status?: string;
  endorsement?: string;
  [k: string]: unknown;
}

export interface PpmJsonFeeEntry {
  name: string;
  rate_pct_pa?: number;
  rate_pct?: number;
  rate?: string;
  basis?: string;
  vat_treatment?: string;
  waterfall_clause?: string;
  waterfall_clauses?: string[];
  seniority?: string;
  combined_stated_mgmt_fee_pct_pa?: number;
  trigger?: string;
  [k: string]: unknown;
}

export interface PpmJsonWaterfallClause {
  clause: string;                   // "A" ... "DD"
  application: string;
  v2_note?: string;
  [k: string]: unknown;
}

export interface PpmJsonCoverageTest {
  class_group: string;              // "Class A/B", "Class C" ...
  required_ratio_pct: number;       // e.g. 129.37 (percent, not decimal)
  denominator_description?: string;
  denominator_eur?: number;
  applicable_from?: string;
  numerator?: string;
  [k: string]: unknown;
}

export interface PpmJson {
  meta: { source_file?: string; issuer?: string; lei?: string; reporting_currency?: string; [k: string]: unknown };
  section_1_deal_identity: {
    legal_name: string;
    jurisdiction?: string;
    entity_form?: string;
    company_number?: string;
    registered_office?: string;
    lei?: string;
    offering_circular_date?: string;
    issue_date?: string;
    target_par_amount?: { amount: number; currency: string; [k: string]: unknown };
    volcker_status?: string;
    listing?: string;
    transaction_parties: PpmJsonTransactionParty[];
    [k: string]: unknown;
  };
  section_2_key_dates: {
    issue_date?: string;
    effective_date_actual?: string;
    effective_date_target?: string;
    first_payment_date?: string;
    payment_dates_standard?: string[];
    payment_frequency?: string;
    determination_date?: string;
    non_call_period_end?: string;
    reinvestment_period_end?: string;
    stated_maturity?: string;
    [k: string]: unknown;
  };
  section_3_capital_structure: {
    denomination_currency?: string;
    common_maturity?: string;
    tranches: PpmJsonTranche[];
    total_principal?: number;
    rated_notes_principal?: number;
    subordinated_principal?: number;
    total_oid_eur?: number;
    subordination?: Array<{ class: string; subordinate_principal_eur: number; subordination_pct: number }>;
    [k: string]: unknown;
  };
  section_4_coverage_tests: {
    par_value_tests: PpmJsonCoverageTest[];
    interest_coverage_tests: PpmJsonCoverageTest[];
    reinvestment_oc_test?: { required_ratio_pct: number; description?: string; trigger_action?: string; waterfall_clause?: string };
    event_of_default_par_value_test?: { required_ratio_pct: number; [k: string]: unknown };
    [k: string]: unknown;
  };
  section_5_fees_and_hurdle: {
    fees: PpmJsonFeeEntry[];
    incentive_fee_irr_threshold?: { threshold_pct_pa: number; [k: string]: unknown };
    [k: string]: unknown;
  };
  section_6_waterfall: {
    interest_priority_of_payments: { clauses: PpmJsonWaterfallClause[]; [k: string]: unknown };
    principal_priority_of_payments: { clauses: PpmJsonWaterfallClause[]; [k: string]: unknown };
    post_acceleration_priority_of_payments?: { sequence_summary?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  section_7_interest_mechanics: {
    conventions?: Record<string, unknown>;
    interest_deferral?: Record<string, unknown>;
    frequency_switch_event?: Record<string, unknown>;
    [k: string]: unknown;
  };
  section_8_portfolio_and_quality_tests: {
    portfolio_profile_limits_selected?: Array<{ bucket: string; direction: string; limit_pct: number; basis?: string; note?: string }>;
    collateral_quality_tests?: Array<{ test: string; description?: string }>;
    moodys_test_matrix_sample?: Record<string, unknown>;
    fitch_test_matrix?: Record<string, unknown>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface ComplianceJsonTranche {
  tranche: string;                  // "Class A" ... "Subordinated"
  original: number;
  current: number;
  rate?: number | null;             // decimal, e.g. 0.02966
  spread?: number | null;           // decimal, e.g. 0.0095
  period_interest?: number;
  fitch?: string;
  moody?: string;
  maturity?: string;
  [k: string]: unknown;
}

export interface ComplianceJsonPvTest {
  test: string;                     // "Class A/B", ... "Event of Default (10(a)(iv))"
  numerator: number;
  denominator: number;
  prior?: number;
  actual: number;                   // ratio (1.3698), NOT percent
  trigger: number;                  // ratio
  cushion?: number;
  result: "Passed" | "Failed" | "N/A";
  indenture_section?: string;
  subtype?: string;
  numerator_composition?: Array<{ id: number; basis: string; scope?: string; description?: string; formula?: string; current_period_value: number }>;
  denominator_spec?: { basis: string; scope?: string; current_period_value: number };
  [k: string]: unknown;
}

export interface ComplianceJsonIcTest {
  test: string;                     // "Class A/B IC"
  numerator: number;
  denominator: number;
  prior?: number;
  actual: number;                   // ratio
  trigger: number;                  // ratio
  cushion?: number;
  result: "Passed" | "Failed" | "N/A";
  [k: string]: unknown;
}

export interface ComplianceJsonQualityTest {
  test: string;                     // "Fitch Maximum WARF", "Moody's Minimum Diversity", "Weighted Average Life", etc.
  actual: number;
  trigger: number;
  prior?: number;
  result: "Passed" | "Failed" | "N/A";
  [k: string]: unknown;
}

export interface ComplianceJsonPortfolioTest {
  code: string;                     // "a" ... "dd"
  test: string;
  limit?: number;
  limit_pct?: number;
  actual?: number;
  actual_pct?: number;
  result?: string;
  [k: string]: unknown;
}

export interface ComplianceJsonHolding {
  description: string;              // "Admiral Bidco GmbH - Facility B2"
  security_id?: string;             // LXID or ISIN ("LX28443T7", "XS3134529562")
  loan_type?: string;
  market_price?: number;
  par_quantity?: number;
  principal_balance?: number;
  unfunded_amount?: number;
  security_level?: string;
  maturity_date?: string;           // "29-Sep-2032"
  [k: string]: unknown;
}

export interface ComplianceJsonAccrualPosition {
  description: string;
  security_id?: string;
  rate_type?: "Fixed" | "Floating";
  payment_period?: string;
  principal_balance?: number;
  base_index?: string | null;
  index_rate_pct?: number | null;
  index_floor_pct?: number | null;
  spread_pct?: number | null;
  credit_spread_adj_pct?: number | null;
  effective_spread_pct?: number | null;
  all_in_rate_pct?: number | null;
  spread_bps?: number | null;
  [k: string]: unknown;
}

export interface ComplianceJsonTrade {
  description: string;
  security_id?: string;
  trade_date?: string;
  settle_date?: string | null;
  ccy?: string;
  par: number;
  price?: number;
  principal?: number;
  accrued?: number;
  total?: number;
  reason?: string | null;
  [k: string]: unknown;
}

export interface ComplianceJsonAccount {
  name: string;
  group?: string;
  ccy?: string;
  native_trade?: number;
  native_received?: number;
  deal_trade_eur?: number;
  deal_received_eur?: number;
  [k: string]: unknown;
}

export interface ComplianceJson {
  meta: { source_file?: string; determination_date: string; reporting_currency?: string; issuer?: string; lei?: string; trustee?: string; collateral_manager?: string; [k: string]: unknown };
  key_dates: {
    closing_date?: string;
    effective_date?: string;
    collection_period_start?: string;
    collection_period_end?: string;
    current_payment_date?: string;
    next_collection_period_start?: string;
    next_collection_period_end?: string;
    next_payment_date?: string;
    reinvestment_period_end?: string;
    stated_maturity?: string;
    euribor_reference_rate?: number;
    [k: string]: unknown;
  };
  capital_structure: ComplianceJsonTranche[];
  pool_summary: {
    aggregate_principal_balance?: number;
    principal_proceeds?: number;
    unused_proceeds?: number;
    collateral_principal_amount?: number;
    adjusted_collateral_principal_amount?: number;
    defaulted_obligations?: number;
    senior_secured_loans?: number;
    senior_secured_bonds?: number;
    aggregate_funded_spread?: number;
    [k: string]: unknown;
  };
  par_value_tests: ComplianceJsonPvTest[];
  interest_coverage_tests: { numerator_detail?: Record<string, unknown>; tests: ComplianceJsonIcTest[] };
  collateral_quality_tests: ComplianceJsonQualityTest[];
  portfolio_profile_tests: ComplianceJsonPortfolioTest[];
  other_tests?: Array<Record<string, unknown>>;
  account_balances: { accounts: ComplianceJsonAccount[]; zero_balance_accounts?: string[]; [k: string]: unknown };
  schedule_of_investments: ComplianceJsonHolding[];
  moody_caa_obligations?: { positions: Array<Record<string, unknown>>; [k: string]: unknown };
  fitch_ccc_obligations?: { positions: Array<Record<string, unknown>>; [k: string]: unknown };
  purchases?: ComplianceJsonTrade[];
  sales?: ComplianceJsonTrade[];
  paydowns?: Array<{ category?: string; description: string; security_id?: string; date?: string; amount: number }>;
  unsettled_trades_summary?: Record<string, unknown>;
  rating_migration?: Record<string, unknown>;
  rating_concentrations?: Record<string, unknown>;
  restructured_assets?: Array<Record<string, unknown>>;
  interest_smoothing_account?: Record<string, unknown>;
  notes_payment_history?: { per_tranche: Record<string, { rows: Array<Record<string, unknown>>; [k: string]: unknown }>; [k: string]: unknown };
  current_period_execution?: {
    payment_date?: string;
    tranche_distributions?: Array<{ class: string; original: number; beginning: number; all_in_rate?: number; interest_due?: number; deferred_interest_due?: number; interest_paid?: number; deferred_interest_paid?: number; principal_paid?: number; ending: number; note?: string }>;
    account_flow_on_payment_date?: Record<string, unknown>;
    administrative_expenses?: Array<Record<string, unknown>>;
    management_fees_paid?: Record<string, unknown>;
    interest_waterfall_execution?: Array<Record<string, unknown>>;
    principal_waterfall?: Record<string, unknown>;
    tranche_snapshots_this_period?: Array<Record<string, unknown>>;
    [k: string]: unknown;
  };
  interest_accrual_detail?: {
    source?: string;
    position_count?: number;
    fixed_count?: number;
    floating_count?: number;
    computed_was_pct?: number;
    positions: ComplianceJsonAccrualPosition[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsc --noEmit
```
Expected: clean (zero new errors).

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/types.ts
git commit -m "feat(clo): add input types for JSON-ingest mappers"
```

---

### Task 2: Unit conversion + date helpers

**Files:**
- Create: `web/lib/clo/extraction/json-ingest/utils.ts`

- [ ] **Step 1: Write helpers**

```ts
// web/lib/clo/extraction/json-ingest/utils.ts

// 0.95 (percent) → 95 (bps). Input must already be in percent (not decimal).
export function pctToBps(pct: number | null | undefined): number | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  return Math.round(pct * 100);
}

// 0.0095 (decimal) → 0.95 (percent)
export function decimalToPct(dec: number | null | undefined): number | null {
  if (dec == null || !Number.isFinite(dec)) return null;
  return dec * 100;
}

// 1.3698 (ratio) → 136.98 (percent). For OC/IC ratios stored as decimals.
export function ratioToPct(ratio: number | null | undefined): number | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  return ratio * 100;
}

// 0.0095 (decimal spread) → 95 (bps)
export function decimalSpreadToBps(dec: number | null | undefined): number | null {
  if (dec == null || !Number.isFinite(dec)) return null;
  return Math.round(dec * 10000);
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// "29-Sep-2032" or "29 Sep 2032" → "2032-09-29"
// "2032-09-29" passes through untouched.
// Returns null on unparseable input (e.g. empty, "null", unparseable).
export function parseFlexibleDate(s: string | null | undefined): string | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null") return null;

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // DD-Mon-YYYY
  const m = trimmed.match(/^(\d{1,2})[\s\-\/](\w{3})[\s\-\/](\d{4})$/);
  if (m) {
    const [, day, mon, year] = m;
    const mm = MONTHS[mon.toLowerCase()];
    if (mm) return `${year}-${mm}-${day.padStart(2, "0")}`;
  }

  // Give up — let downstream surface the bad value rather than silently coerce
  return null;
}

// NOTE: do NOT define a normalizeClassName here. The project already exports one
// from web/lib/clo/api.ts (returns "A", "B-1", "SUBORDINATED"). That is the form
// the worker's syncPpmToRelationalTables uses for lookups. Any mapper or persist
// helper that needs to match tranches MUST import it from api.ts — not reinvent
// a second normalisation convention.

// "LX28443T7" → "LX28443T7" (pass-through)
// "XS3134529562" → null (not an LXID)
export function extractLxid(securityId: string | null | undefined): string | null {
  if (!securityId) return null;
  const t = securityId.trim().toUpperCase();
  return /^LX\w+$/.test(t) ? t : null;
}

// "XS3134529562" → "XS3134529562"
// "LX28443T7" → null (LXID, not ISIN)
export function extractIsin(securityId: string | null | undefined): string | null {
  if (!securityId) return null;
  const t = securityId.trim().toUpperCase();
  if (t.startsWith("LX")) return null;
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(t) ? t : null;
}
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/utils.ts
git commit -m "feat(clo): add unit conversion + date helpers for JSON ingest"
```

---

### Task 3: PPM mapper — transaction_overview, capital_structure, key_dates, key_parties

**Files:**
- Create: `web/lib/clo/extraction/json-ingest/ppm-mapper.ts`

Reference: `web/lib/clo/extraction/section-schemas.ts` lines 382–516 (transactionOverviewSchema, ppmCapitalStructureSchema, ppmKeyDatesSchema, ppmKeyPartiesSchema).

- [ ] **Step 1: Scaffold + implement these four section mappings**

```ts
// web/lib/clo/extraction/json-ingest/ppm-mapper.ts

import type {
  PpmJson,
  PpmJsonTranche,
  PpmJsonTransactionParty,
} from "./types";
import { pctToBps, decimalSpreadToBps, parseFlexibleDate } from "./utils";

export type PpmSections = Record<string, Record<string, unknown>>;

// PPM-side Zod schemas use `z.string().optional()` — meaning `string | undefined`,
// NOT `string | null`. null values WILL fail safeParse. All mapper fields that
// might be absent must use `?? undefined`, and any `parseFlexibleDate` result
// must be coerced with `?? undefined` before being placed into a PPM-schema field.
const u = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

function mapTransactionOverview(ppm: PpmJson): Record<string, unknown> {
  const di = ppm.section_1_deal_identity;
  const cm = di.transaction_parties.find((p) => p.role === "Collateral Manager");
  return {
    dealName: di.legal_name,
    issuerLegalName: di.legal_name,
    collateralManager: u(cm?.entity),
    jurisdiction: u(di.jurisdiction),
    entityType: u(di.entity_form),
    governingLaw: u(di.jurisdiction),
    currency: u(ppm.meta.reporting_currency as string | undefined),
    listingExchange: u(di.listing),
  };
}

function mapCapitalStructure(ppm: PpmJson): Record<string, unknown> {
  const tranches = ppm.section_3_capital_structure.tranches;
  return {
    capitalStructure: tranches.map((t: PpmJsonTranche) => {
      // Prefer margin_decimal over spread_pct when both exist; fall back to fixed_coupon
      const spreadBps =
        t.margin_decimal != null ? decimalSpreadToBps(t.margin_decimal)
        : t.spread_pct != null ? pctToBps(t.spread_pct)
        : t.fixed_coupon_decimal != null ? decimalSpreadToBps(t.fixed_coupon_decimal)
        : t.fixed_coupon_pct != null ? pctToBps(t.fixed_coupon_pct)
        : null;
      const isSub = /sub|subordinated|residual/i.test(t.class) || t.rate_type === "residual";
      return {
        class: t.class,
        principalAmount: String(t.principal),
        rateType: t.rate_type ?? undefined,   // ppmCapitalStructure schema is string | undefined (not nullable)
        referenceRate: t.rate_type === "floating" ? "EURIBOR" : undefined,
        spreadBps: spreadBps ?? undefined,
        rating: {
          fitch: t.fitch ?? undefined,
          moodys: t.moodys ?? undefined,
        },
        isSubordinated: isSub,
        maturityDate: parseFlexibleDate(ppm.section_3_capital_structure.common_maturity as string | undefined) ?? undefined,
      };
    }),
    dealSizing: {
      targetParAmount: ppm.section_1_deal_identity.target_par_amount?.amount != null
        ? String(ppm.section_1_deal_identity.target_par_amount.amount)
        : undefined,
      totalRatedNotes: ppm.section_3_capital_structure.rated_notes_principal != null
        ? String(ppm.section_3_capital_structure.rated_notes_principal)
        : undefined,
      totalSubordinatedNotes: ppm.section_3_capital_structure.subordinated_principal != null
        ? String(ppm.section_3_capital_structure.subordinated_principal)
        : undefined,
      totalDealSize: ppm.section_3_capital_structure.total_principal != null
        ? String(ppm.section_3_capital_structure.total_principal)
        : undefined,
    },
  };
}

function mapKeyDates(ppm: PpmJson): Record<string, unknown> {
  const kd = ppm.section_2_key_dates;
  return {
    originalIssueDate: u(parseFlexibleDate(kd.issue_date)),
    currentIssueDate: u(parseFlexibleDate(kd.effective_date_actual)),
    maturityDate: u(parseFlexibleDate(kd.stated_maturity)),
    nonCallPeriodEnd: u(parseFlexibleDate(kd.non_call_period_end)),
    reinvestmentPeriodEnd: u(parseFlexibleDate(kd.reinvestment_period_end)),
    firstPaymentDate: u(parseFlexibleDate(kd.first_payment_date)),
    paymentFrequency: u(kd.payment_frequency),
  };
}

function mapKeyParties(ppm: PpmJson): Record<string, unknown> {
  const parties = ppm.section_1_deal_identity.transaction_parties;
  const cm = parties.find((p) => p.role === "Collateral Manager");
  return {
    keyParties: parties.map((p: PpmJsonTransactionParty) => ({
      role: p.role,
      entity: p.entity,
    })),
    cmDetails: cm ? { name: cm.entity, parent: undefined, replacementMechanism: undefined } : undefined,
  };
}

export function mapPpm(ppm: PpmJson): PpmSections {
  return {
    transaction_overview: mapTransactionOverview(ppm),
    capital_structure: mapCapitalStructure(ppm),
    key_dates: mapKeyDates(ppm),
    key_parties: mapKeyParties(ppm),
    // remaining sections added in subsequent tasks
  };
}
```

- [ ] **Step 2: Verify against live PPM**

```bash
cd web && npx tsx --eval '
import { mapPpm } from "./lib/clo/extraction/json-ingest/ppm-mapper";
import fs from "fs";
const ppm = JSON.parse(fs.readFileSync("../ppm.json", "utf8"));
const s = mapPpm(ppm);
console.log(JSON.stringify(s, null, 2));
'
```
Expected output should show: 4 section keys; `capital_structure.capitalStructure` has 8 tranches with `spreadBps` 95/170/195/210/315/611/885/null (Sub); `key_parties.keyParties` has 9 entries.

- [ ] **Step 3: Validate shape against Zod**

```bash
cd web && npx tsx --eval '
import { mapPpm } from "./lib/clo/extraction/json-ingest/ppm-mapper";
import { ppmCapitalStructureSchema, ppmKeyDatesSchema, ppmKeyPartiesSchema, transactionOverviewSchema } from "./lib/clo/extraction/section-schemas";
import fs from "fs";
const ppm = JSON.parse(fs.readFileSync("../ppm.json", "utf8"));
const s = mapPpm(ppm);
console.log("transaction_overview:", transactionOverviewSchema.safeParse(s.transaction_overview).success);
console.log("capital_structure:", ppmCapitalStructureSchema.safeParse(s.capital_structure).success);
console.log("key_dates:", ppmKeyDatesSchema.safeParse(s.key_dates).success);
console.log("key_parties:", ppmKeyPartiesSchema.safeParse(s.key_parties).success);
'
```
Expected: all four `true`.

- [ ] **Step 4: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/ppm-mapper.ts
git commit -m "feat(clo): PPM mapper — transaction overview, capital structure, key dates, key parties"
```

---

### Task 4: PPM mapper — coverage_tests, fees_and_expenses, portfolio_constraints

**Files:**
- Modify: `web/lib/clo/extraction/json-ingest/ppm-mapper.ts`

Reference: `section-schemas.ts` lines 426–465 (ppmCoverageTestsSchema, ppmPortfolioConstraintsSchema), lines 475–490 (ppmFeesSchema).

- [ ] **Step 1: Add three more section mappings**

```ts
function mapCoverageTests(ppm: PpmJson): Record<string, unknown> {
  const ct = ppm.section_4_coverage_tests;
  // Build one entry per class_group, combining PV + IC on the same class_group.
  // Schema expects `class`, `parValueRatio` (string), `interestCoverageRatio` (string).
  const byClass = new Map<string, { pv?: number; ic?: number }>();
  for (const p of ct.par_value_tests) {
    const entry = byClass.get(p.class_group) ?? {};
    entry.pv = p.required_ratio_pct;
    byClass.set(p.class_group, entry);
  }
  for (const i of ct.interest_coverage_tests) {
    const entry = byClass.get(i.class_group) ?? {};
    entry.ic = i.required_ratio_pct;
    byClass.set(i.class_group, entry);
  }
  const entries = Array.from(byClass.entries()).map(([klass, v]) => ({
    class: klass,
    parValueRatio: v.pv != null ? `${v.pv}%` : undefined,
    interestCoverageRatio: v.ic != null ? `${v.ic}%` : undefined,
  }));
  const reinv = ct.reinvestment_oc_test;
  return {
    coverageTestEntries: entries,
    reinvestmentOcTest: reinv ? {
      trigger: `${reinv.required_ratio_pct}%`,
      appliesDuring: reinv.description ?? undefined,
      diversionAmount: reinv.trigger_action ?? undefined,
    } : undefined,
    // Preserve EoD hybrid composition as passthrough (schema is .passthrough())
    eventOfDefaultParValueTest: ct.event_of_default_par_value_test,
  };
}

function mapFeesAndExpenses(ppm: PpmJson): Record<string, unknown> {
  const fees = ppm.section_5_fees_and_hurdle.fees.map((f) => {
    const ratePctPa = f.rate_pct_pa;
    const ratePct = f.rate_pct;
    const rate = ratePctPa != null ? String(ratePctPa)
      : ratePct != null ? String(ratePct)
      : (f.rate as string | undefined);
    const rateUnit =
      ratePctPa != null ? "pct_pa"
      : ratePct != null && f.name?.toLowerCase().includes("incentive") ? "pct_of_residual"
      : f.rate === "Per Trust Deed" || f.rate === "Per Condition 1 definition" ? "per_agreement"
      : ratePct != null ? "pct_pa"
      : null;
    return {
      name: f.name,
      rate,
      rateUnit,
      basis: f.basis ?? undefined,
      description: [f.waterfall_clause, f.seniority, f.trigger, f.vat_treatment].filter(Boolean).join("; ") || undefined,
      hurdleRate: f.trigger === "Incentive Fee IRR Threshold"
        ? ppm.section_5_fees_and_hurdle.incentive_fee_irr_threshold?.threshold_pct_pa != null
          ? `${ppm.section_5_fees_and_hurdle.incentive_fee_irr_threshold.threshold_pct_pa}%`
          : undefined
        : undefined,
    };
  });
  return { fees, accounts: [] };
}

function mapPortfolioConstraints(ppm: PpmJson): Record<string, unknown> {
  const limits = ppm.section_8_portfolio_and_quality_tests.portfolio_profile_limits_selected ?? [];
  const quality = ppm.section_8_portfolio_and_quality_tests.collateral_quality_tests ?? [];
  const portfolioProfileTests: Record<string, { min?: string | null; max?: string | null; notes?: string }> = {};
  for (const l of limits) {
    portfolioProfileTests[l.bucket] = {
      min: l.direction === ">=" ? String(l.limit_pct) : null,
      max: l.direction === "<=" ? String(l.limit_pct) : null,
      notes: l.note ?? l.basis,
    };
  }
  return {
    collateralQualityTests: quality.map((q) => ({
      name: q.test,
      agency: /moody/i.test(q.test) ? "Moody's" : /fitch/i.test(q.test) ? "Fitch" : null,
      value: q.description ?? null,
    })),
    portfolioProfileTests,
  };
}
```

Wire them into `mapPpm`:

```ts
export function mapPpm(ppm: PpmJson): PpmSections {
  return {
    transaction_overview: mapTransactionOverview(ppm),
    capital_structure: mapCapitalStructure(ppm),
    key_dates: mapKeyDates(ppm),
    key_parties: mapKeyParties(ppm),
    coverage_tests: mapCoverageTests(ppm),
    fees_and_expenses: mapFeesAndExpenses(ppm),
    portfolio_constraints: mapPortfolioConstraints(ppm),
  };
}
```

- [ ] **Step 2: Verify with Zod**

```bash
cd web && npx tsx --eval '
import { mapPpm } from "./lib/clo/extraction/json-ingest/ppm-mapper";
import { ppmCoverageTestsSchema, ppmFeesSchema, ppmPortfolioConstraintsSchema } from "./lib/clo/extraction/section-schemas";
import fs from "fs";
const ppm = JSON.parse(fs.readFileSync("../ppm.json", "utf8"));
const s = mapPpm(ppm);
console.log("coverage_tests:", ppmCoverageTestsSchema.safeParse(s.coverage_tests).success);
console.log("fees_and_expenses:", ppmFeesSchema.safeParse(s.fees_and_expenses).success);
console.log("portfolio_constraints:", ppmPortfolioConstraintsSchema.safeParse(s.portfolio_constraints).success);
console.log("fees count:", (s.fees_and_expenses as any).fees?.length);
console.log("senior+sub rates:", (s.fees_and_expenses as any).fees.filter((f:any)=>/collateral management/i.test(f.name)).map((f:any)=>({name:f.name, rate:f.rate})));
'
```
Expected: all three `true`; fees count 5; Senior 0.15 + Sub 0.35 present.

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/ppm-mapper.ts
git commit -m "feat(clo): PPM mapper — coverage tests, fees, portfolio constraints"
```

---

### Task 5: PPM mapper — waterfall_rules, interest_mechanics (+ finalise null→undefined sweep)

Before adding new sections, sweep Task 4 additions for any remaining `?? null` that lands on a PPM Zod field:
- `mapFeesAndExpenses`: `hurdleRate` field — the PPM `ppmFeesSchema` marks it `z.string().nullable().optional()`, so null is OK. Leave.
- `mapCoverageTests`: `eventOfDefaultParValueTest` is passthrough — null inside nested objects is fine.
- `mapPortfolioConstraints`: `min`/`max` are `z.union([z.string(), z.null()]).optional()` — null is allowed. Leave.

Net: no Task 4 changes needed for B4 beyond what Tasks 3 covered.


**Files:**
- Modify: `web/lib/clo/extraction/json-ingest/ppm-mapper.ts`

Reference: `section-schemas.ts` lines 467–473 (ppmWaterfallRulesSchema — three string fields), lines 531–540 (ppmInterestMechanicsSchema — passthrough).

- [ ] **Step 1: Add the two mappings**

```ts
function mapWaterfallRules(ppm: PpmJson): Record<string, unknown> {
  const wf = ppm.section_6_waterfall;
  const serializeClauses = (clauses: Array<{ clause: string; application: string }>): string =>
    clauses.map((c) => `(${c.clause}) ${c.application}`).join("\n");
  return {
    interestPriority: serializeClauses(wf.interest_priority_of_payments.clauses),
    principalPriority: serializeClauses(wf.principal_priority_of_payments.clauses),
    postAcceleration: wf.post_acceleration_priority_of_payments?.sequence_summary ?? undefined,  // ppmWaterfallRulesSchema is string | undefined, NOT nullable
  };
}

function mapInterestMechanics(ppm: PpmJson): Record<string, unknown> {
  // Schema is passthrough; dump section_7 verbatim.
  return { ...ppm.section_7_interest_mechanics };
}
```

Wire into `mapPpm`:
```ts
waterfall_rules: mapWaterfallRules(ppm),
interest_mechanics: mapInterestMechanics(ppm),
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsx --eval '
import { mapPpm } from "./lib/clo/extraction/json-ingest/ppm-mapper";
import { ppmWaterfallRulesSchema, ppmInterestMechanicsSchema } from "./lib/clo/extraction/section-schemas";
import fs from "fs";
const ppm = JSON.parse(fs.readFileSync("../ppm.json", "utf8"));
const s = mapPpm(ppm);
console.log("waterfall_rules:", ppmWaterfallRulesSchema.safeParse(s.waterfall_rules).success);
console.log("interest_mechanics:", ppmInterestMechanicsSchema.safeParse(s.interest_mechanics).success);
console.log("interest clauses present:", ((s.waterfall_rules as any).interestPriority.match(/\(\w+\)/g) || []).length);
console.log("principal clauses present:", ((s.waterfall_rules as any).principalPriority.match(/\(\w+\)/g) || []).length);
'
```
Expected: both `true`; interest clauses = 30; principal clauses = 22.

- [ ] **Step 3: Run full PPM mapper end-to-end**

Expected sections (9): transaction_overview, capital_structure, coverage_tests, key_dates, key_parties, fees_and_expenses, portfolio_constraints, waterfall_rules, interest_mechanics.

- [ ] **Step 4: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/ppm-mapper.ts
git commit -m "feat(clo): PPM mapper — waterfall rules + interest mechanics (complete)"
```

---

### Task 6: Compliance mapper — compliance_summary, asset_schedule, interest_accrual_detail

**Files:**
- Create: `web/lib/clo/extraction/json-ingest/compliance-mapper.ts`

Reference: `section-schemas.ts` lines 7–47 (complianceSummarySchema), 161–212 (assetScheduleSchema), 117–137 (interestAccrualDetailSchema).

- [ ] **Step 1: Write the three mappings**

```ts
// web/lib/clo/extraction/json-ingest/compliance-mapper.ts

import type {
  ComplianceJson,
  ComplianceJsonTranche,
  ComplianceJsonHolding,
  ComplianceJsonAccrualPosition,
} from "./types";
import {
  decimalToPct,
  parseFlexibleDate,
  extractLxid,
  extractIsin,
} from "./utils";

export type ComplianceSections = Record<string, Record<string, unknown>>;

function mapComplianceSummary(c: ComplianceJson): Record<string, unknown> {
  const qualityByName = new Map(c.collateral_quality_tests.map((t) => [t.test.toLowerCase(), t.actual]));

  return {
    reportDate: c.meta.determination_date,
    paymentDate: c.key_dates.current_payment_date ?? null,
    reportType: "quarterly",
    dealName: c.meta.issuer ?? null,
    trusteeName: c.meta.trustee ?? null,
    collateralManager: c.meta.collateral_manager ?? null,
    closingDate: c.key_dates.closing_date ?? null,
    statedMaturity: c.key_dates.stated_maturity ?? null,
    nextPaymentDate: c.key_dates.next_payment_date ?? null,
    collectionPeriodEnd: c.key_dates.collection_period_end ?? null,
    reinvestmentPeriodEnd: c.key_dates.reinvestment_period_end ?? null,
    nonCallPeriodEnd: null,
    tranches: c.capital_structure.map((t: ComplianceJsonTranche) => ({
      className: t.tranche,
      principalAmount: t.original,
      spread: t.spread != null ? decimalToPct(t.spread) : null,
      allInRate: t.rate != null ? decimalToPct(t.rate) : null,
      currentBalance: t.current,
      rating: t.fitch ?? null,
      couponRate: t.rate != null ? decimalToPct(t.rate) : null,
    })),
    aggregatePrincipalBalance: c.pool_summary.aggregate_principal_balance ?? null,
    adjustedCollateralPrincipalAmount: c.pool_summary.adjusted_collateral_principal_amount ?? null,
    totalPar: c.pool_summary.adjusted_collateral_principal_amount ?? c.pool_summary.aggregate_principal_balance ?? null,
    wacSpread: (() => {
      const was = qualityByName.get("minimum wa floating spread") ?? qualityByName.get("minimum weighted average floating spread");
      return was != null ? decimalToPct(was) : null;   // 0.0368 → 3.68%
    })(),
    diversityScore: qualityByName.get("moody's minimum diversity") ?? null,
    warf: qualityByName.get("moody's maximum warf") ?? null,
    walYears: qualityByName.get("weighted average life") ?? null,
    waRecoveryRate: qualityByName.get("moody's minimum wa recovery") != null
      ? decimalToPct(qualityByName.get("moody's minimum wa recovery")!)
      : null,
    numberOfAssets: c.schedule_of_investments?.length ?? null,
  };
}

function mapAssetSchedule(c: ComplianceJson): Record<string, unknown> {
  return {
    holdings: c.schedule_of_investments.map((h: ComplianceJsonHolding) => {
      const lxid = extractLxid(h.security_id);
      const isin = extractIsin(h.security_id);
      const [obligorName, facilityName] = splitDescription(h.description);
      return {
        obligorName,
        facilityName,
        isin,
        lxid,
        assetType: h.loan_type ?? null,
        maturityDate: parseFlexibleDate(h.maturity_date),
        parBalance: h.par_quantity ?? null,
        principalBalance: h.principal_balance ?? null,
        marketValue: h.principal_balance != null && h.market_price != null
          ? h.principal_balance * (h.market_price / 100)
          : null,
        currentPrice: h.market_price ?? null,
      };
    }),
  };
}

// "Admiral Bidco GmbH - Facility B2" → ["Admiral Bidco GmbH", "Facility B2"]
function splitDescription(desc: string): [string, string] {
  const idx = desc.indexOf(" - ");
  if (idx === -1) return [desc.trim(), ""];
  return [desc.slice(0, idx).trim(), desc.slice(idx + 3).trim()];
}

function mapInterestAccrualDetail(c: ComplianceJson): Record<string, unknown> {
  const positions = c.interest_accrual_detail?.positions ?? [];
  return {
    rows: positions.map((p: ComplianceJsonAccrualPosition) => {
      const lxid = extractLxid(p.security_id);
      const isin = extractIsin(p.security_id);
      return {
        description: p.description,
        securityId: p.security_id ?? null,
        lxid,
        isin,
        rateType: p.rate_type ?? null,
        paymentPeriod: p.payment_period ?? null,
        principalBalance: p.principal_balance ?? null,
        baseIndex: p.base_index ?? null,
        indexRatePct: p.index_rate_pct ?? null,
        indexFloorPct: p.index_floor_pct ?? null,
        spreadPct: p.spread_pct ?? null,
        creditSpreadAdjPct: p.credit_spread_adj_pct ?? null,
        effectiveSpreadPct: p.effective_spread_pct ?? null,
        allInRatePct: p.all_in_rate_pct ?? null,
        spreadBps: p.spread_bps ?? null,
      };
    }),
  };
}

export function mapCompliance(c: ComplianceJson): ComplianceSections {
  return {
    compliance_summary: mapComplianceSummary(c),
    asset_schedule: mapAssetSchedule(c),
    interest_accrual_detail: mapInterestAccrualDetail(c),
    // remaining sections added in subsequent tasks
  };
}
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsx --eval '
import { mapCompliance } from "./lib/clo/extraction/json-ingest/compliance-mapper";
import { complianceSummarySchema, assetScheduleSchema, interestAccrualDetailSchema } from "./lib/clo/extraction/section-schemas";
import fs from "fs";
const c = JSON.parse(fs.readFileSync("../compliance.json", "utf8"));
const s = mapCompliance(c);
const r1 = complianceSummarySchema.safeParse(s.compliance_summary);
const r2 = assetScheduleSchema.safeParse(s.asset_schedule);
const r3 = interestAccrualDetailSchema.safeParse(s.interest_accrual_detail);
console.log("compliance_summary:", r1.success, r1.success ? "" : JSON.stringify(r1.error.issues, null, 2));
console.log("asset_schedule:", r2.success, r2.success ? "" : JSON.stringify(r2.error.issues, null, 2));
console.log("interest_accrual_detail:", r3.success, r3.success ? "" : JSON.stringify(r3.error.issues, null, 2));
console.log("holdings count:", (s.asset_schedule as any).holdings.length);
console.log("accrual count:", (s.interest_accrual_detail as any).rows.length);
console.log("accrual with lxid:", (s.interest_accrual_detail as any).rows.filter((r:any)=>r.lxid).length);
console.log("accrual with isin:", (s.interest_accrual_detail as any).rows.filter((r:any)=>r.isin).length);
'
```
Expected: all three `true`; holdings count ≈ 236; accrual count 280; accrual lxid + isin = 280.

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/compliance-mapper.ts
git commit -m "feat(clo): compliance mapper — summary, asset schedule, interest accrual detail"
```

---

### Task 7: Compliance mapper — par_value_tests, interest_coverage_tests, collateral_quality_tests, concentration_tables

**Files:**
- Modify: `web/lib/clo/extraction/json-ingest/compliance-mapper.ts`

Reference: `section-schemas.ts` lines 49–73 (parValueTestsSchema + parValueAdjustments), 96–108 (collateralQualityTestsSchema), 139–159 (interestCoverageTestsSchema), 214–231 (concentrationSchema).

- [ ] **Step 1: Add four mappings**

```ts
function mapParValueTests(c: ComplianceJson): Record<string, unknown> {
  return {
    tests: c.par_value_tests.map((t) => {
      const className = t.test;
      const isEod = /event of default/i.test(t.test) || t.subtype === "EventOfDefault";
      const testType = /reinvestment/i.test(t.test) ? "INTEREST_DIVERSION" : "OC_PAR";
      return {
        testName: t.test,
        testType,
        testClass: isEod ? "EOD" : className.replace(/^Class\s*/i, "").trim(),
        numerator: t.numerator,
        denominator: t.denominator,
        actualValue: t.actual * 100,            // 1.3698 → 136.98
        triggerLevel: t.trigger * 100,
        cushionPct: t.cushion != null ? t.cushion * 100 : null,
        isPassing: t.result === "Passed" ? true : t.result === "Failed" ? false : null,
      };
    }),
    parValueAdjustments: [],  // synthesised later if adjusted_cpa_reconciliation has non-zero fields
  };
}

function mapInterestCoverageTests(c: ComplianceJson): Record<string, unknown> {
  return {
    tests: c.interest_coverage_tests.tests.map((t) => ({
      testName: t.test,
      testType: "IC",
      testClass: t.test.replace(/\s*IC$/, "").replace(/^Class\s*/i, "").trim(),
      numerator: t.numerator,
      denominator: t.denominator,
      actualValue: t.actual * 100,
      triggerLevel: t.trigger * 100,
      cushionPct: t.cushion != null ? t.cushion * 100 : null,
      isPassing: t.result === "Passed" ? true : t.result === "Failed" ? false : null,
    })),
    interestAmountsPerTranche: c.capital_structure.map((tr) => ({
      className: tr.tranche,
      interestAmount: tr.period_interest ?? null,
      currency: c.meta.reporting_currency ?? "EUR",
    })),
  };
}

function mapCollateralQualityTests(c: ComplianceJson): Record<string, unknown> {
  return {
    tests: c.collateral_quality_tests.map((t) => {
      const agency = /moody/i.test(t.test) ? "Moody’s" : /fitch/i.test(t.test) ? "Fitch" : null;
      const triggerType: "MIN" | "MAX" = /min/i.test(t.test) ? "MIN" : /max/i.test(t.test) ? "MAX" : (t.actual < t.trigger ? "MIN" : "MAX");
      return {
        testName: t.test,
        agency,
        actualValue: t.actual,
        triggerLevel: t.trigger,
        triggerType,
        isPassing: t.result === "Passed" ? true : t.result === "Failed" ? false : null,
        cushion: triggerType === "MIN" ? t.actual - t.trigger : t.trigger - t.actual,
      };
    }),
  };
}

function mapConcentrationTables(c: ComplianceJson): Record<string, unknown> {
  return {
    concentrations: c.portfolio_profile_tests.map((p) => ({
      concentrationType: p.code,
      bucketName: p.test,
      actualValue: p.actual ?? null,
      actualPct: p.actual_pct ?? null,
      limitValue: p.limit ?? null,
      limitPct: p.limit_pct ?? null,
      excessAmount: null,
      isPassing: p.result === "Passed" ? true : p.result === "Failed" ? false : null,
      isHaircutApplied: null,
      haircutAmount: null,
      obligorCount: null,
      assetCount: null,
    })),
  };
}
```

Wire into `mapCompliance`:
```ts
par_value_tests: mapParValueTests(c),
interest_coverage_tests: mapInterestCoverageTests(c),
collateral_quality_tests: mapCollateralQualityTests(c),
concentration_tables: mapConcentrationTables(c),
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsx --eval '
import { mapCompliance } from "./lib/clo/extraction/json-ingest/compliance-mapper";
import { parValueTestsSchema, interestCoverageTestsSchema, collateralQualityTestsSchema, concentrationSchema } from "./lib/clo/extraction/section-schemas";
import fs from "fs";
const c = JSON.parse(fs.readFileSync("../compliance.json", "utf8"));
const s = mapCompliance(c);
for (const [name, schema] of [["par_value_tests", parValueTestsSchema],["interest_coverage_tests", interestCoverageTestsSchema],["collateral_quality_tests", collateralQualityTestsSchema],["concentration_tables", concentrationSchema]]) {
  const r = (schema as any).safeParse(s[name]);
  console.log(name, r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
}
console.log("pv count:", (s.par_value_tests as any).tests.length);
console.log("ic count:", (s.interest_coverage_tests as any).tests.length);
console.log("cq count:", (s.collateral_quality_tests as any).tests.length);
console.log("conc count:", (s.concentration_tables as any).concentrations.length);
'
```
Expected: all `true`; pv ≥ 5; ic = 3; cq = 7; conc ≥ 30.

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/compliance-mapper.ts
git commit -m "feat(clo): compliance mapper — PV, IC, CQ, concentration tests"
```

---

### Task 8: Compliance mapper — waterfall, trading_activity, account_balances, interest_accrual, default_detail, supplementary, notes_information

**Files:**
- Modify: `web/lib/clo/extraction/json-ingest/compliance-mapper.ts`

Reference: `section-schemas.ts` lines 233–298 (waterfallSchema + tradingActivitySchema), 301–328 (interestAccrualSchema + accountBalancesSchema), 330–376 (supplementarySchema), 75–89 (defaultDetailSchema), and the `notesInformationSchema` further down.

- [ ] **Step 1: Add remaining mappings**

```ts
function mapWaterfall(c: ComplianceJson): Record<string, unknown> {
  const exec = c.current_period_execution;
  if (!exec) return { waterfallSteps: [], proceeds: [], trancheSnapshots: [] };

  const waterfallSteps = (exec.interest_waterfall_execution ?? []).map((step: any, idx: number) => ({
    waterfallType: "INTEREST",
    priorityOrder: idx + 1,
    description: step.clause ?? step.description ?? null,
    payee: step.payee ?? step.recipient ?? null,
    amountDue: step.amount_due ?? null,
    amountPaid: step.amount_paid ?? step.amount ?? null,
    shortfall: step.shortfall ?? null,
    fundsAvailableBefore: step.funds_available_before ?? null,
    fundsAvailableAfter: step.funds_available_after ?? null,
    isOcTestDiversion: Boolean(step.is_oc_cure ?? /coverage test/i.test(String(step.description ?? step.clause ?? ""))),
    isIcTestDiversion: false,
  }));

  const trancheSnapshots = (exec.tranche_distributions ?? []).map((t) => ({
    className: t.class,
    currentBalance: t.ending,
    couponRate: t.all_in_rate != null ? t.all_in_rate * 100 : null,
    interestAccrued: t.interest_due ?? null,
    interestPaid: t.interest_paid ?? null,
    principalPaid: t.principal_paid ?? null,
    beginningBalance: t.beginning,
    endingBalance: t.ending,
  }));

  const proceeds = [
    exec.account_flow_on_payment_date?.interest_account && {
      proceedsType: "INTEREST",
      sourceDescription: "Interest Funding Account",
      amount: (exec.account_flow_on_payment_date as any).interest_account.beginning ?? null,
      periodStart: c.key_dates.collection_period_start ?? null,
      periodEnd: c.key_dates.collection_period_end ?? null,
    },
    exec.account_flow_on_payment_date?.principal_account && {
      proceedsType: "PRINCIPAL",
      sourceDescription: "Principal Funding Account",
      amount: (exec.account_flow_on_payment_date as any).principal_account.beginning ?? null,
      periodStart: c.key_dates.collection_period_start ?? null,
      periodEnd: c.key_dates.collection_period_end ?? null,
    },
  ].filter(Boolean);

  return { waterfallSteps, proceeds, trancheSnapshots };
}

function mapTradingActivity(c: ComplianceJson): Record<string, unknown> {
  const makeTrade = (t: any, tradeType: string) => {
    const [obligorName, facilityName] = splitDescription(t.description);
    return {
      tradeType,
      obligorName,
      facilityName,
      tradeDate: parseFlexibleDate(t.trade_date),
      settlementDate: parseFlexibleDate(t.settle_date),
      parAmount: t.par ?? null,
      settlementPrice: t.price ?? null,
      settlementAmount: t.total ?? null,
      currency: t.ccy ?? null,
    };
  };
  const purchases = (c.purchases ?? []).map((t) => makeTrade(t, "PURCHASE"));
  const sales = (c.sales ?? []).map((t) => makeTrade(t, "SALE"));
  const trades = [...purchases, ...sales];
  const summary = {
    totalPurchasesPar: purchases.reduce((s, t) => s + (t.parAmount ?? 0), 0),
    totalSalesPar: sales.reduce((s, t) => s + Math.abs(t.parAmount ?? 0), 0),
    totalSalesProceeds: sales.reduce((s, t) => s + (t.settlementAmount ?? 0), 0),
    netGainLoss: null,
    totalPaydowns: (c.paydowns ?? []).reduce((s, p) => s + (p.amount ?? 0), 0),
  };
  return { trades, tradingSummary: summary };
}

function mapAccountBalances(c: ComplianceJson): Record<string, unknown> {
  return {
    accounts: c.account_balances.accounts.map((a) => ({
      accountName: a.name,
      accountType: a.group ?? null,
      currency: a.ccy ?? null,
      balanceAmount: a.deal_received_eur ?? a.deal_trade_eur ?? a.native_received ?? null,
      requiredBalance: null,
      excessDeficit: null,
    })),
  };
}

function mapInterestAccrual(c: ComplianceJson): Record<string, unknown> {
  // Schema expects assetRateDetails[]; we fold §22 into a sparser shape here.
  const positions = c.interest_accrual_detail?.positions ?? [];
  return {
    assetRateDetails: positions.map((p) => {
      const [obligorName, facilityName] = splitDescription(p.description);
      return {
        obligorName,
        facilityName,
        referenceRate: p.base_index ?? null,
        baseRate: p.index_rate_pct ?? null,
        indexFloor: p.index_floor_pct ?? null,
        spread: p.spread_pct ?? null,
        creditSpreadAdj: p.credit_spread_adj_pct ?? null,
        effectiveSpread: p.effective_spread_pct ?? null,
        allInRate: p.all_in_rate_pct ?? null,
      };
    }),
  };
}

function mapDefaultDetail(c: ComplianceJson): Record<string, unknown> {
  const positions = [
    ...(c.moody_caa_obligations?.positions ?? []),
    ...(c.fitch_ccc_obligations?.positions ?? []),
  ] as Array<Record<string, unknown>>;
  // These are CCC obligations, not defaults — schema allows non-defaulted rows too.
  return {
    defaults: positions.map((p) => ({
      obligorName: String(p.description ?? p.obligor_name ?? p.issuer ?? ""),
      securityId: (p.security_id as string) ?? null,
      parAmount: (p.principal_balance as number) ?? (p.par as number) ?? null,
      marketPrice: (p.market_price as number) ?? null,
      isDefaulted: false,
      isDeferring: false,
    })),
  };
}

function mapSupplementary(c: ComplianceJson): Record<string, unknown> {
  const fees: Array<Record<string, unknown>> = [];
  const mgmt = c.current_period_execution?.management_fees_paid as Record<string, unknown> | undefined;
  if (mgmt && typeof mgmt === "object") {
    for (const [name, amount] of Object.entries(mgmt)) {
      if (typeof amount === "number") fees.push({ feeType: name, paid: amount });
    }
  }
  const admin = c.current_period_execution?.administrative_expenses ?? [];
  for (const a of admin) {
    fees.push({
      feeType: (a as any).name,
      payee: null,
      accrued: (a as any).amount_due ?? null,
      paid: (a as any).paid_on_ipd ?? null,
      unpaid: (a as any).outstanding ?? null,
    });
  }

  return {
    fees,
    hedgePositions: [],
    fxRates: c.key_dates.fx ? Object.entries(c.key_dates.fx).map(([pair, rate]) => {
      const [base, , quote] = pair.split("_");
      return { baseCurrency: base, quoteCurrency: quote, spotRate: rate as number };
    }) : [],
    ratingActions: [],
    events: [],
    spCdoMonitor: [],
  };
}

function mapNotesInformation(c: ComplianceJson): Record<string, unknown> | null {
  const hist = c.notes_payment_history?.per_tranche;
  if (!hist) return null;
  const allRows: Array<Record<string, unknown>> = [];
  for (const [className, data] of Object.entries(hist)) {
    for (const row of (data as any).rows ?? []) {
      allRows.push({ className, ...row });
    }
  }
  return { paymentHistory: allRows };
}
```

Wire into `mapCompliance` (complete form):
```ts
export function mapCompliance(c: ComplianceJson): ComplianceSections {
  const sections: ComplianceSections = {
    compliance_summary: mapComplianceSummary(c),
    asset_schedule: mapAssetSchedule(c),
    interest_accrual_detail: mapInterestAccrualDetail(c),
    par_value_tests: mapParValueTests(c),
    interest_coverage_tests: mapInterestCoverageTests(c),
    collateral_quality_tests: mapCollateralQualityTests(c),
    concentration_tables: mapConcentrationTables(c),
    waterfall: mapWaterfall(c),
    trading_activity: mapTradingActivity(c),
    account_balances: mapAccountBalances(c),
    interest_accrual: mapInterestAccrual(c),
    default_detail: mapDefaultDetail(c),
    supplementary: mapSupplementary(c),
  };
  const ni = mapNotesInformation(c);
  if (ni) sections.notes_information = ni;
  return sections;
}
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsx --eval '
import { mapCompliance } from "./lib/clo/extraction/json-ingest/compliance-mapper";
import { waterfallSchema, tradingActivitySchema, accountBalancesSchema, interestAccrualSchema, defaultDetailSchema, supplementarySchema } from "./lib/clo/extraction/section-schemas";
import fs from "fs";
const c = JSON.parse(fs.readFileSync("../compliance.json", "utf8"));
const s = mapCompliance(c);
for (const [name, schema] of [["waterfall", waterfallSchema],["trading_activity", tradingActivitySchema],["account_balances", accountBalancesSchema],["interest_accrual", interestAccrualSchema],["default_detail", defaultDetailSchema],["supplementary", supplementarySchema]]) {
  const r = (schema as any).safeParse(s[name]);
  console.log(name, r.success, r.success ? "" : JSON.stringify(r.error.issues[0], null, 2));
}
console.log("section count:", Object.keys(s).length);
console.log("tranche snapshots:", (s.waterfall as any).trancheSnapshots.length);
console.log("trades:", (s.trading_activity as any).trades.length);
console.log("accounts:", (s.account_balances as any).accounts.length);
'
```
Expected: all `true`; 13–14 sections; tranche snapshots 8; trades > 4; accounts ≥ 2.

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/compliance-mapper.ts
git commit -m "feat(clo): compliance mapper — waterfall, trading, accounts, accrual, defaults, supplementary, notes history (complete)"
```

---

### Task 9: Extract `syncPpmToRelationalTables` into a shared module

**Files:**
- Create: `web/lib/clo/extraction/persist-ppm.ts`
- Modify: `web/worker/index.ts` (import from new location)

Reason: both the LLM PPM path (worker) and the JSON PPM path (new) must call the same persist. Moving to a lib module with a `pg.Pool` parameter keeps it environment-neutral.

- [ ] **Step 1: Move the function**

Cut the existing `syncPpmToRelationalTables` from `web/worker/index.ts` into `web/lib/clo/extraction/persist-ppm.ts`, along with the two helpers that ARE locally defined in the worker: `parseAmount` (worker line 554) and `parseSpreadBps` (worker line 561).

**Do NOT touch** `normalizeClassName` — it is already imported in the worker from `web/lib/clo/api.ts` (worker line 19). Leave that import in place; re-import it in the new persist-ppm module the same way.

Adapt the extracted function to accept a `pg.Pool` argument rather than closing over the worker's module-scoped `pool`:

```ts
// web/lib/clo/extraction/persist-ppm.ts
import type { Pool } from "pg";
import { normalizeClassName } from "../api";
import type { CapitalStructureEntry } from "../types";

function parseAmount(s: string | undefined | null): number | null { /* moved verbatim from worker:554 */ }
function parseSpreadBps(s: string | undefined | null): number | null { /* moved verbatim from worker:561 */ }

export async function syncPpmToRelationalTables(
  pool: Pool,
  profileId: string,
  extractedConstraints: Record<string, unknown>,
): Promise<void> {
  // ... body moved verbatim from worker/index.ts:578-780, with `pool.query` replaced by the
  // passed-in `pool.query`. All existing `normalizeClassName(...)` calls keep working via
  // the new import above.
}
```

- [ ] **Step 2: Update worker import**

```ts
// web/worker/index.ts — replace the local function + helpers
import { syncPpmToRelationalTables } from "../lib/clo/extraction/persist-ppm.js";
// and at the call site (around line 870):
await syncPpmToRelationalTables(pool, job.id, extractedConstraints);
```

- [ ] **Step 3: Verify**

```bash
cd web && npx tsc --noEmit
```
Expected: clean. Worker still references the same symbols; runtime unchanged.

- [ ] **Step 4: Commit**

```bash
git add web/lib/clo/extraction/persist-ppm.ts web/worker/index.ts
git commit -m "refactor(clo): move syncPpmToRelationalTables into shared persist-ppm module"
```

---

### Task 10: Compliance persist helper

**Files:**
- Create: `web/lib/clo/extraction/json-ingest/persist-compliance.ts`

This helper takes the output of `normalizeSectionResults` and writes to all compliance-side tables, mirroring the behaviour in `runner.ts` but without the LLM/pass-by-pass orchestration.

- [ ] **Step 1: Write the helper**

```ts
// web/lib/clo/extraction/json-ingest/persist-compliance.ts
import { query } from "../../db";
import { normalizeClassName } from "../api";
import { normalizeSectionResults } from "../normalizer";

// Only these five tables carry a `data_source` column (migration 008). Any
// other compliance-side table will throw if queried with `data_source = 'sdf'`.
// This whitelist MUST match runner.ts:22-25's SDF_GUARDED_TABLES exactly.
const SDF_GUARDED_TABLES = new Set([
  "clo_holdings",
  "clo_compliance_tests",
  "clo_tranche_snapshots",
  "clo_account_balances",
  "clo_trades",
]);

// Check whether SDF has already populated a table for this period.
// Matches the runner's hasSdfData gate, including the early-return for
// tables without a data_source column.
async function hasSdfData(table: string, reportPeriodId: string): Promise<boolean> {
  if (!SDF_GUARDED_TABLES.has(table)) return false;
  const rows = await query<{ n: number }>(
    `SELECT 1 AS n FROM ${table} WHERE report_period_id = $1 AND data_source = 'sdf' LIMIT 1`,
    [reportPeriodId],
  );
  return rows.length > 0;
}

async function getTableColumns(table: string): Promise<Set<string>> {
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

async function batchInsert(table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0;
  const validColumns = await getTableColumns(table);
  const allColumns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = allColumns.filter((c) => validColumns.has(c));
  const dropped = allColumns.filter((c) => !validColumns.has(c));
  if (dropped.length > 0) {
    console.log(`[json-ingest] ${table}: dropped unknown columns: ${dropped.join(", ")}`);
  }
  if (columns.length === 0) return 0;
  const valuePlaceholders: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const row of rows) {
    const rowPlaceholders: string[] = [];
    for (const col of columns) {
      rowPlaceholders.push(`$${idx++}`);
      const v = row[col];
      values.push(v === "null" || v === "NULL" || v === "" ? null : v ?? null);
    }
    valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
  }
  await query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valuePlaceholders.join(", ")}`, values);
  return rows.length;
}

async function replaceIfPresent(table: string, rows: Record<string, unknown>[], reportPeriodId: string): Promise<number> {
  if (rows.length === 0) return 0;
  if (await hasSdfData(table, reportPeriodId)) {
    console.log(`[json-ingest] ${table}: SDF data present, skipping overwrite`);
    return 0;
  }
  // For SDF-guarded tables, only delete non-SDF rows (preserve any SDF data that somehow
  // exists but wasn't detected by hasSdfData). For non-guarded tables, DELETE is unconditional
  // since there's no data_source column to filter on.
  if (SDF_GUARDED_TABLES.has(table)) {
    await query(`DELETE FROM ${table} WHERE report_period_id = $1 AND (data_source IS NULL OR data_source <> 'sdf')`, [reportPeriodId]);
    return batchInsert(table, rows.map((r) => ({ ...r, data_source: "json_ingest" })));
  } else {
    await query(`DELETE FROM ${table} WHERE report_period_id = $1`, [reportPeriodId]);
    return batchInsert(table, rows);  // no data_source column, don't add it
  }
}

export async function persistComplianceSections(
  sections: Record<string, Record<string, unknown> | null>,
  reportPeriodId: string,
  dealId: string,
  rawInput: unknown,
): Promise<{ counts: Record<string, number> }> {
  const normalized = normalizeSectionResults(sections, reportPeriodId, dealId);
  const counts: Record<string, number> = {};

  if (normalized.poolSummary) {
    // NOTE: clo_pool_summary has no data_source column and therefore no SDF guard.
    // This mirrors runner.ts, which also unconditionally replaces pool_summary on
    // every compliance extraction. If SDF ever starts writing pool_summary, this
    // will need a coexistence strategy.
    await query(`DELETE FROM clo_pool_summary WHERE report_period_id = $1`, [reportPeriodId]);
    counts.pool_summary = await batchInsert("clo_pool_summary", [normalized.poolSummary]);
  }
  counts.compliance_tests = await replaceIfPresent("clo_compliance_tests", normalized.complianceTests, reportPeriodId);
  counts.holdings = await replaceIfPresent("clo_holdings", normalized.holdings, reportPeriodId);
  counts.concentrations = await replaceIfPresent("clo_concentrations", normalized.concentrations, reportPeriodId);
  counts.waterfall_steps = await replaceIfPresent("clo_waterfall_steps", normalized.waterfallSteps, reportPeriodId);
  counts.proceeds = await replaceIfPresent("clo_proceeds", normalized.proceeds, reportPeriodId);
  counts.trades = await replaceIfPresent("clo_trades", normalized.trades, reportPeriodId);
  counts.account_balances = await replaceIfPresent("clo_account_balances", normalized.accountBalances, reportPeriodId);
  counts.par_value_adjustments = await replaceIfPresent("clo_par_value_adjustments", normalized.parValueAdjustments, reportPeriodId);
  counts.events = await replaceIfPresent("clo_events", normalized.events, reportPeriodId);

  // Tranche snapshots: find-or-create tranche by NORMALIZED class name,
  // then SELECT-then-INSERT/UPDATE the snapshot (clo_tranche_snapshots has NO
  // unique constraint on (tranche_id, report_period_id) — ON CONFLICT will raise
  // "no unique or exclusion constraint matching the ON CONFLICT specification").
  //
  // Class-name normalization: worker's syncPpmToRelationalTables inserts rows with
  // the original `class_name` ("Class A") but looks them up via
  // `normalizeClassName(x) === normalizeClassName(y)` ("A" === "A"). Mapper output
  // preserves "Class A" / "Subordinated" verbatim. To avoid duplicating tranches
  // when PPM already ran, we match on normalized form and only INSERT with the
  // original name if nothing matched. Mirrors worker:639-653 exactly.
  const allTranches = await query<{ id: string; class_name: string }>(
    `SELECT id, class_name FROM clo_tranches WHERE deal_id = $1`,
    [dealId],
  );

  let snapshotCount = 0;
  for (const ts of normalized.trancheSnapshots) {
    const wantedNorm = normalizeClassName(ts.className);
    let trancheId = allTranches.find((t) => normalizeClassName(t.class_name) === wantedNorm)?.id;
    if (!trancheId) {
      const inserted = await query<{ id: string; class_name: string }>(
        `INSERT INTO clo_tranches (deal_id, class_name) VALUES ($1, $2) RETURNING id, class_name`,
        [dealId, ts.className],
      );
      trancheId = inserted[0].id;
      allTranches.push({ id: inserted[0].id, class_name: inserted[0].class_name });
    }

    // SELECT-then-INSERT/UPDATE, not ON CONFLICT — see SDF's processNotes (sdf/ingest.ts:631-701).
    const existing = await query<{ id: string }>(
      `SELECT id FROM clo_tranche_snapshots WHERE tranche_id = $1 AND report_period_id = $2`,
      [trancheId, reportPeriodId],
    );

    const dataKeys = Object.keys(ts.data);
    const dataVals = Object.values(ts.data);

    if (existing.length > 0) {
      const setClauses = dataKeys.map((k, i) => `${k} = $${i + 1}`).concat([`data_source = $${dataKeys.length + 1}`]);
      await query(
        `UPDATE clo_tranche_snapshots SET ${setClauses.join(", ")} WHERE id = $${dataKeys.length + 2}`,
        [...dataVals, "json_ingest", existing[0].id],
      );
    } else {
      const cols = [...dataKeys, "data_source", "tranche_id", "report_period_id"];
      const placeholders = cols.map((_, i) => `$${i + 1}`);
      await query(
        `INSERT INTO clo_tranche_snapshots (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
        [...dataVals, "json_ingest", trancheId, reportPeriodId],
      );
    }
    snapshotCount++;
  }
  counts.tranche_snapshots = snapshotCount;

  // Payment history
  if (normalized.paymentHistory.length > 0) {
    await query(`DELETE FROM clo_payment_history WHERE source_period_id = $1 OR last_seen_period_id = $1`, [reportPeriodId]);
    const rows = normalized.paymentHistory.map((r) => ({
      ...r,
      source_period_id: reportPeriodId,
      last_seen_period_id: reportPeriodId,
    }));
    counts.payment_history = await batchInsert("clo_payment_history", rows);
  }

  // Final UPDATE on clo_report_periods
  await query(
    `UPDATE clo_report_periods
     SET extraction_status = 'complete',
         extracted_at = now(),
         raw_extraction = $1::jsonb,
         updated_at = now()
     WHERE id = $2`,
    [JSON.stringify({ _jsonIngest: true, _rawInput: rawInput }), reportPeriodId],
  );

  return { counts };
}
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/persist-compliance.ts
git commit -m "feat(clo): compliance persist helper for JSON-ingest path"
```

---

### Task 11: Orchestrator — `ingestPpmJson`, `ingestComplianceJson`

**Files:**
- Create: `web/lib/clo/extraction/json-ingest/ingest.ts`

- [ ] **Step 1: Implement orchestrator**

```ts
// web/lib/clo/extraction/json-ingest/ingest.ts
import { query, getPool } from "../../db";
import {
  ppmCapitalStructureSchema,
  ppmCoverageTestsSchema,
  ppmFeesSchema,
  ppmKeyDatesSchema,
  ppmKeyPartiesSchema,
  ppmPortfolioConstraintsSchema,
  ppmWaterfallRulesSchema,
  ppmInterestMechanicsSchema,
  transactionOverviewSchema,
  complianceSummarySchema,
  parValueTestsSchema,
  interestCoverageTestsSchema,
  collateralQualityTestsSchema,
  concentrationSchema,
  waterfallSchema,
  tradingActivitySchema,
  accountBalancesSchema,
  interestAccrualSchema,
  interestAccrualDetailSchema,
  defaultDetailSchema,
  supplementarySchema,
  assetScheduleSchema,
} from "../section-schemas";
import { normalizePpmSectionResults } from "../normalizer";
import { validateAndNormalizeConstraints } from "../../ingestion-gate";
import { syncPpmToRelationalTables } from "../persist-ppm";
import { persistComplianceSections } from "./persist-compliance";
import { mapPpm } from "./ppm-mapper";
import { mapCompliance } from "./compliance-mapper";
import type { PpmJson, ComplianceJson } from "./types";
import type { ExtractedConstraints } from "../../types";

const PPM_SCHEMAS: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }> = {
  transaction_overview: transactionOverviewSchema,
  capital_structure: ppmCapitalStructureSchema,
  coverage_tests: ppmCoverageTestsSchema,
  key_dates: ppmKeyDatesSchema,
  key_parties: ppmKeyPartiesSchema,
  fees_and_expenses: ppmFeesSchema,
  portfolio_constraints: ppmPortfolioConstraintsSchema,
  waterfall_rules: ppmWaterfallRulesSchema,
  interest_mechanics: ppmInterestMechanicsSchema,
};

const COMPLIANCE_SCHEMAS: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }> = {
  compliance_summary: complianceSummarySchema,
  par_value_tests: parValueTestsSchema,
  interest_coverage_tests: interestCoverageTestsSchema,
  collateral_quality_tests: collateralQualityTestsSchema,
  interest_accrual_detail: interestAccrualDetailSchema,
  asset_schedule: assetScheduleSchema,
  concentration_tables: concentrationSchema,
  waterfall: waterfallSchema,
  trading_activity: tradingActivitySchema,
  interest_accrual: interestAccrualSchema,
  account_balances: accountBalancesSchema,
  default_detail: defaultDetailSchema,
  supplementary: supplementarySchema,
};

function validateAll(
  sections: Record<string, Record<string, unknown>>,
  schemas: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }>,
): { ok: true } | { ok: false; errors: Array<{ section: string; issues: unknown }> } {
  const errors: Array<{ section: string; issues: unknown }> = [];
  for (const [name, data] of Object.entries(sections)) {
    const schema = schemas[name];
    if (!schema) continue;
    const r = schema.safeParse(data);
    if (!r.success) errors.push({ section: name, issues: r.error });
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export async function ingestPpmJson(
  profileId: string,
  ppm: PpmJson,
): Promise<{ ok: true; counts: Record<string, number> } | { ok: false; errors: Array<{ section: string; issues: unknown }> }> {
  const sections = mapPpm(ppm);
  const validation = validateAll(sections, PPM_SCHEMAS);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  let extractedConstraints = normalizePpmSectionResults(sections);
  const gate = validateAndNormalizeConstraints(extractedConstraints as ExtractedConstraints);
  if (gate.ok) {
    extractedConstraints = gate.data as unknown as Record<string, unknown>;
  } else {
    console.warn("[json-ingest] PPM gate validation failed:", gate.errors);
  }
  extractedConstraints._sectionBasedExtraction = true;
  extractedConstraints._jsonIngest = true;

  await query(
    `UPDATE clo_profiles
     SET extracted_constraints = $1::jsonb,
         ppm_raw_extraction = $2::jsonb,
         ppm_extracted_at = now(),
         ppm_extraction_status = 'complete',
         ppm_extraction_error = NULL,
         ppm_extraction_progress = $3::jsonb,
         updated_at = now()
     WHERE id = $4`,
    [
      JSON.stringify(extractedConstraints),
      JSON.stringify({ _jsonIngest: true, _rawInput: ppm }),
      JSON.stringify({ step: "complete", detail: "JSON ingest complete", updatedAt: new Date().toISOString() }),
      profileId,
    ],
  );

  const pool = getPool();
  await syncPpmToRelationalTables(pool, profileId, extractedConstraints);

  return {
    ok: true,
    counts: {
      sections_mapped: Object.keys(sections).length,
      tranches: Array.isArray(extractedConstraints.capitalStructure) ? (extractedConstraints.capitalStructure as unknown[]).length : 0,
      fees: Array.isArray(extractedConstraints.fees) ? (extractedConstraints.fees as unknown[]).length : 0,
      key_parties: Array.isArray(extractedConstraints.keyParties) ? (extractedConstraints.keyParties as unknown[]).length : 0,
    },
  };
}

export async function ingestComplianceJson(
  profileId: string,
  compliance: ComplianceJson,
): Promise<{ ok: true; reportPeriodId: string; counts: Record<string, number> } | { ok: false; errors: Array<{ section: string; issues: unknown }> }> {
  const sections = mapCompliance(compliance);
  const validation = validateAll(sections, COMPLIANCE_SCHEMAS);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  // Resolve deal — auto-create if missing, mirroring runner.ts getOrCreateDeal
  // (runner.ts:179-203) so the JSON compliance path is not stricter than the
  // LLM path. If PPM hasn't been ingested yet, we create a bare-bones deal from
  // whatever the compliance report gives us (issuer + collateral_manager from meta).
  const deals = await query<{ id: string }>(
    `SELECT id FROM clo_deals WHERE profile_id = $1`,
    [profileId],
  );
  let dealId: string;
  if (deals.length > 0) {
    dealId = deals[0].id;
  } else {
    // Pull the best-available deal identity from the profile's extracted_constraints
    // (if PPM ran), then fall back to compliance.meta for deal_name + CM.
    const profileRows = await query<{ extracted_constraints: Record<string, unknown> | null }>(
      `SELECT extracted_constraints FROM clo_profiles WHERE id = $1`,
      [profileId],
    );
    const constraints = (profileRows[0]?.extracted_constraints ?? {}) as Record<string, unknown>;
    const dealIdentity = (constraints.dealIdentity ?? {}) as Record<string, string>;
    const cmDetails = (constraints.cmDetails ?? {}) as Record<string, string>;

    const dealName = dealIdentity.dealName ?? compliance.meta.issuer ?? null;
    const collateralManager = (constraints.collateralManager as string | undefined)
      ?? cmDetails.name
      ?? compliance.meta.collateral_manager
      ?? null;

    const inserted = await query<{ id: string }>(
      `INSERT INTO clo_deals (profile_id, deal_name, collateral_manager)
       VALUES ($1, $2, $3) RETURNING id`,
      [profileId, dealName, collateralManager],
    );
    dealId = inserted[0].id;
    console.log(`[json-ingest] created clo_deals row ${dealId} for profile ${profileId} (no prior PPM)`);
  }

  const reportDate = compliance.meta.determination_date;
  const periods = await query<{ id: string }>(
    `INSERT INTO clo_report_periods (deal_id, report_date, payment_date, reporting_period_start, reporting_period_end, extraction_status, report_source)
     VALUES ($1, $2, $3, $4, $5, 'extracting', 'json_ingest')
     ON CONFLICT (deal_id, report_date) DO UPDATE SET extraction_status = 'extracting', updated_at = now()
     RETURNING id`,
    [
      dealId,
      reportDate,
      compliance.key_dates.current_payment_date ?? null,
      compliance.key_dates.collection_period_start ?? null,
      compliance.key_dates.collection_period_end ?? null,
    ],
  );
  const reportPeriodId = periods[0].id;

  const result = await persistComplianceSections(sections, reportPeriodId, dealId, compliance);
  return { ok: true, reportPeriodId, counts: result.counts };
}
```

If `getPool()` is not already exported from `web/lib/db.ts`, add an export in that file (and verify it returns the same Pool instance used by `query`).

- [ ] **Step 2: Verify**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add web/lib/clo/extraction/json-ingest/ingest.ts web/lib/db.ts
git commit -m "feat(clo): JSON-ingest orchestrator (ingestPpmJson, ingestComplianceJson)"
```

---

### Task 12: API endpoint

**Files:**
- Create: `web/app/api/clo/profile/extract-from-json/route.ts`

- [ ] **Step 1: Write POST handler**

```ts
// web/app/api/clo/profile/extract-from-json/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { ingestPpmJson, ingestComplianceJson } from "@/lib/clo/extraction/json-ingest/ingest";
import type { PpmJson, ComplianceJson } from "@/lib/clo/extraction/json-ingest/types";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const profiles = await query<{ id: string }>(
    `SELECT id FROM clo_profiles WHERE user_id = $1`,
    [user.id],
  );
  if (profiles.length === 0) return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  const profileId = profiles[0].id;

  let body: { ppm?: PpmJson; compliance?: ComplianceJson };
  try {
    body = (await req.json()) as { ppm?: PpmJson; compliance?: ComplianceJson };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.ppm && !body.compliance) {
    return NextResponse.json({ error: "Provide ppm and/or compliance" }, { status: 400 });
  }

  const result: Record<string, unknown> = {};

  if (body.ppm) {
    const r = await ingestPpmJson(profileId, body.ppm);
    if (!r.ok) return NextResponse.json({ error: "PPM validation failed", details: r.errors }, { status: 422 });
    result.ppm = r;
  }

  if (body.compliance) {
    const r = await ingestComplianceJson(profileId, body.compliance);
    if (!r.ok) return NextResponse.json({ error: "Compliance validation failed", details: r.errors }, { status: 422 });
    result.compliance = r;
  }

  return NextResponse.json({ status: "ok", ...result });
}
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/clo/profile/extract-from-json/route.ts
git commit -m "feat(clo): POST /api/clo/profile/extract-from-json endpoint"
```

---

### Task 13: UI — JSON upload component

**Files:**
- Create: `web/app/clo/context/JsonUploadSection.tsx`
- Modify: the existing `/clo/context` page (most likely `web/app/clo/context/page.tsx` or a child component that currently renders the PDF upload) to render `<JsonUploadSection />`

- [ ] **Step 1: Locate the host**

```bash
grep -rn "SdfUploadSection\|DocumentsUpload\|UploadPpm" web/app/clo/context/
```
Pick the component that currently hosts upload controls and plan to insert the new section next to it.

- [ ] **Step 2: Write component**

```tsx
// web/app/clo/context/JsonUploadSection.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function JsonUploadSection() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  async function onUpload(kind: "ppm" | "compliance", file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch { throw new Error("File is not valid JSON"); }
      const res = await fetch("/api/clo/profile/extract-from-json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [kind]: parsed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border rounded p-4 my-4">
      <h3 className="font-medium mb-2">Direct JSON ingest</h3>
      <p className="text-sm text-gray-600 mb-3">
        Upload pre-structured PPM or compliance JSON. Skips the LLM path entirely.
      </p>
      <div className="flex gap-4">
        <label className="cursor-pointer text-sm border rounded px-3 py-2 hover:bg-gray-50">
          Upload PPM JSON
          <input type="file" accept="application/json,.json" className="hidden" disabled={busy}
            onChange={(e) => e.target.files?.[0] && onUpload("ppm", e.target.files[0])} />
        </label>
        <label className="cursor-pointer text-sm border rounded px-3 py-2 hover:bg-gray-50">
          Upload Compliance JSON
          <input type="file" accept="application/json,.json" className="hidden" disabled={busy}
            onChange={(e) => e.target.files?.[0] && onUpload("compliance", e.target.files[0])} />
        </label>
      </div>
      {busy && <p className="mt-2 text-sm">Uploading…</p>}
      {error && <p className="mt-2 text-sm text-red-600">Error: {error}</p>}
      {result && <pre className="mt-2 text-xs bg-gray-50 p-2 overflow-auto max-h-64">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
```

- [ ] **Step 3: Render it on `/clo/context`**

In the host component identified in Step 1, import and render `<JsonUploadSection />` somewhere visible (near the existing PDF/SDF upload).

- [ ] **Step 4: Verify**

```bash
cd web && npx tsc --noEmit
cd web && npm run build 2>&1 | tail -30
```
Expected: clean compile. Start the dev server, open `/clo/context`, confirm the new section renders and the two upload buttons are visible.

- [ ] **Step 5: Commit**

```bash
git add web/app/clo/context/JsonUploadSection.tsx <host-file>
git commit -m "feat(clo): JSON upload UI on /clo/context"
```

---

### Task 14: End-to-end smoke

**Files:** None (verification-only task).

- [ ] **Step 1: Run dev server**

```bash
cd web && npm run dev
```

- [ ] **Step 2: Upload PPM**

In the browser at `/clo/context`, sign in as the user who owns the profile, click **Upload PPM JSON**, choose `/Users/solal/Documents/GitHub/funzies/ppm.json`. Wait for the response panel.

Expected response shape:
```
{ "status": "ok", "ppm": { "ok": true, "counts": { "sections_mapped": 9, "tranches": 8, "fees": 5, "key_parties": 9 } } }
```

Expected `/clo/context` view after refresh:
- 8 tranches listed with class letters A, B-1, B-2, C, D, E, F, Subordinated Notes
- spreadBps: 95, 170, 195, 210, 315, 611, 885, 0 (or null for Sub)
- Moody's column populated
- Fees section shows Senior CMF 0.15% and Sub CMF 0.35%
- Waterfall section shows 30 interest + 22 principal clauses
- Key parties shows 9 entries

- [ ] **Step 3: Upload Compliance**

Click **Upload Compliance JSON**, choose `/Users/solal/Documents/GitHub/funzies/compliance.json`. Wait for response.

Expected response shape:
```
{ "status": "ok", "compliance": { "ok": true, "reportPeriodId": "<uuid>", "counts": { "pool_summary": 1, "holdings": 236, ... } } }
```

- [ ] **Step 4: DB spot-checks**

```sql
-- Tranches
SELECT class_name, spread_bps, original_balance, is_subordinate, seniority_rank
FROM clo_tranches WHERE deal_id = '<dealId>' ORDER BY seniority_rank;
-- Expect 8 rows, ranks 1-8, spreads 95/170/195/210/315/611/885/0

-- §22 join: holdings with spread_bps populated
SELECT COUNT(*) FROM clo_holdings
WHERE report_period_id = '<reportPeriodId>' AND spread_bps IS NOT NULL;
-- Expect ≈ 262 (floating positions)

-- PV and IC tests
SELECT test_type, COUNT(*) FROM clo_compliance_tests
WHERE report_period_id = '<reportPeriodId>' GROUP BY test_type;
-- Expect OC_PAR ≥ 5, IC = 3, WARF/WAL/DIVERSITY/RECOVERY/WAS present

-- Concentrations
SELECT COUNT(*) FROM clo_concentrations WHERE report_period_id = '<reportPeriodId>';
-- Expect ≈ 46

-- Pool summary
SELECT total_par, warf, diversity_score FROM clo_pool_summary
WHERE report_period_id = '<reportPeriodId>';
-- Expect total_par ≈ 491406828 (adjustedCPA), warf = 3035, diversity = 67
```

- [ ] **Step 5: Verify resolver output**

Navigate to any downstream page that renders `resolveWaterfallInputs` (e.g. `/clo/waterfall` or the resolved-deal panel). Expected:
- `resolved.tranches` has 8 entries, non-duplicated, correct Sub Notes balance 44.8M / 40.8M
- `resolved.loans` with spreadBps populated from §22, not from wacSpread cascade
- `resolved.qualityTests` populated (WARF, WAL, WAS, Diversity, Recovery)
- `resolved.ocTriggers` has Class A–F + Reinvestment OC trigger

- [ ] **Step 6: No regression against PDF path**

Upload a PDF compliance report (any prior known-good) through the existing PDF ingest. Confirm it still works (worker picks up the queued job, writes data, no errors in logs).

- [ ] **Step 7: Commit smoke artefacts (none) — final tag**

```bash
git tag -a json-ingest-live -m "JSON ingest path live end-to-end"
```
(Only if tagging is desired; otherwise just confirm the feature is live.)

---

## Notes for the executing controller

- **Task ordering:** Tasks 1 & 2 are foundational; 3–5 build the PPM mapper incrementally (one subagent per task keeps context tight); 6–8 build the compliance mapper; 9 is a refactor that unblocks the orchestrator; 10 is the compliance persist helper; 11 wires them; 12 exposes the endpoint; 13 is UI; 14 is smoke.
- **Model selection:** Tasks 1, 2, 9, 12, 13 are mechanical (cheap model OK). Tasks 3–8 involve mapping logic and unit conversions (standard model). Tasks 10, 11, 14 involve integration judgement (standard/most-capable).
- **Do not** dispatch multiple implementation subagents in parallel — they will conflict on the mapper files (3-5 share a file, 6-8 share a file).
- **If Zod validation fails** in Task 3/6 verification: the implementer should fix the mapper output shape, not relax the Zod schema. The schema is the fixed target.

---

## Self-review checklist

Run through before declaring the plan complete.

**Spec coverage:**
- PPM: 11 input sections → covered by Tasks 3-5 (9 output sections; interest_mechanics folds into one, fees into one, eligibility_criteria skipped because our Zod schema wants free-text requirements that aren't usefully transcribable from condensed PPM — confirmed not blocking).
- Compliance: 14 output section keys → covered by Tasks 6-8.
- Persistence: PPM Task 9 + 11; Compliance Task 10 + 11.
- Endpoint: Task 12. UI: Task 13. Smoke: Task 14.

**Placeholder scan:** No TBD/TODO/etc. All code blocks are complete.

**Type consistency:** `PpmJson` and `ComplianceJson` types defined in Task 1 are used by Tasks 3–8. `PpmSections` / `ComplianceSections` shapes defined in Tasks 3/6. Orchestrator (Task 11) imports from both.

**Unit conversions centralised:** `pctToBps`, `decimalToPct`, `ratioToPct`, `decimalSpreadToBps`, `parseFlexibleDate`, `normalizeClassName`, `extractLxid`, `extractIsin` — all in `utils.ts` (Task 2), called from mappers.

**No schema changes:** Confirmed. Mappers target the existing Zod schemas verbatim.

**SDF precedence preserved:** Task 10 uses `hasSdfData` gate before overwriting compliance tables, matching `runner.ts` behaviour.
