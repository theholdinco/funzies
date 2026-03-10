# Waterfall O/C Test Fix & Projection Methodology

**Date:** 2026-03-10
**Status:** Approved

## Problem

1. **O/C tests never gate cash flows.** OC trigger class names (e.g. `"A"`, `"B"`) from compliance tests don't match tranche class names (e.g. `"Class A-1"`, `"Class B"`). The engine's exact-match check silently fails — diversion never triggers, equity receives distributions it shouldn't.

2. **No methodology documentation.** The projection model has a brief "Model Simplifications" panel but no detailed methodology explaining how defaults, recoveries, O/C gating, and equity distributions are actually computed.

## Deliverables

### 1. O/C Test Name Mapping Fix

**Where:** `ProjectionModel.tsx` (mapping layer) + `projection.ts` (gating logic)

**Mapping strategy (in ProjectionModel.tsx):**
- For each OC/IC trigger, resolve `className` to a seniority rank:
  1. Exact match against tranche `className`
  2. Prefix match — trigger `"B"` matches tranches starting with `"Class B"` or `"B-"`
  3. If multiple tranches match (A → A-1, A-2), use the most senior rank; debt sum naturally includes all via rank filter
  4. If no match, flag as unmapped

**Gating change (in projection.ts):**
- Replace `failingOcClasses` (Set of class names) with `failingOcRanks` (Set of seniority ranks)
- Gating check: `failingOcRanks.has(t.seniorityRank)` instead of `failingOcClasses.has(t.className)`
- Same for IC triggers

**OC trigger interface change:**
```typescript
// Before
ocTriggers: { className: string; triggerLevel: number }[]

// After
ocTriggers: { className: string; triggerLevel: number; rank: number }[]
```

The rank is resolved in ProjectionModel.tsx before passing to the engine. The engine uses rank for both the ratio calculation (already rank-based) and the gating check (currently name-based, will become rank-based).

**UI warnings (in ProjectionModel.tsx):**
- Yellow banner above projection results showing:
  - Successful mappings: `"OC trigger A → Class A-1, Class A-2 (rank 1)"`
  - Failed mappings: `"OC trigger X — no matching tranche, test disabled"`
- Only shown when there are triggers to map (not when triggers are empty)

### 2. Projection Methodology Component

**Where:** New `ProjectionMethodology.tsx` component, rendered on the waterfall page below the projection model.

**Style:** Collapsible panel (collapsed by default), consistent with existing "Model Simplifications & Assumptions" but distinct section. Header: "Projection Methodology".

**Content sections:**

1. **Default Modeling** — Annual CDR applied to total performing par, deannualized quarterly: `qRate = 1 - (1 - CDR)^0.25`. Defaults permanently reduce par. Not per-loan.

2. **Recovery Modeling** — Recovery is cash (not par restoration), arrives after configurable lag (rounded to quarters). At maturity, all pipeline recoveries accelerated.

3. **Prepayment & Maturities** — CPR deannualized identically. Loan maturities from portfolio holdings, capped at remaining par post-defaults.

4. **Reinvestment Period** — During RP: prepay + maturity + recovery cash reinvested, WAC blended. Post-RP: proceeds flow to principal waterfall.

5. **Interest Waterfall & O/C/IC Gating** — Interest on beginning-of-period par at WAC + base rate. Waterfall: senior fees → tranche interest by seniority. After each tranche, check OC/IC. Fail → full diversion to principal paydown. No partial cure, no deferred interest.

6. **Principal Waterfall** — Sources: prepays + maturities + recoveries − reinvestment + diverted interest + liquidation. Paid by seniority. Residual → equity.

7. **Equity & IRR** — Equity = residual interest + residual principal. IRR via Newton-Raphson on quarterly cash flows, annualized.

## Files Modified

- `web/lib/clo/projection.ts` — Change OC/IC gating from name-based to rank-based
- `web/app/clo/waterfall/ProjectionModel.tsx` — Add trigger→tranche mapping with warnings
- `web/app/clo/waterfall/ProjectionMethodology.tsx` — New component (methodology content)
- `web/app/clo/waterfall/page.tsx` — Render ProjectionMethodology on waterfall page

## Out of Scope

- Per-loan default modeling
- Deferred interest accrual
- Partial OC cure mechanisms
- Actual waterfall (trustee report) documentation
- Stress testing / sensitivity analysis
