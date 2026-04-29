# Engine ↔ UI Separation — Architecture Cleanup Plan (v6)

**Date:** 2026-04-29
**Status:** Draft — supersedes v5
**Driver:** UI re-derivation in `PeriodTrace.tsx:13-14` masked an apparent
engine bug that turned out not to be a bug. Two-hour root-cause investigation
across two LLM agents and the user surfaced (a) a real four-line UI
back-derivation that drops €1.80M of equity-from-interest in the displayed
trace, and (b) a duplicate `bookValue` formula computed in both the engine
(`projection.ts:995`) and the UI (`ProjectionModel.tsx:374`) — same shape,
same floor, two independently-maintained copies. The principle this plan
implements: **the engine is the source of truth for every semantic value;
the UI projects that truth into pixels and nothing else.**

**v6 changes vs v5** (architectural correction after deep code search):
- **Phase 5 deleted entirely.** `Math.max(0, initialPrincipalCash)` at the
  q1Cash injection site was a heuristic-disguised-as-value — it manufactures
  fake alpha by ignoring the determination-date overdraft that legitimately
  nets against Q1 principal collections (verified by trustee Apr-15 Account
  Balances and Intex period 16 Reinv Princ = 0). The unfloored engine is
  correct; Forward IRR ≈ −11.95% on Euro XV is the truthful number.
  No partner-visible IRR shift; pre-flight Q4 deleted.
- **`principalAccountCashForward` deleted from the resolver.** Was itself a
  heuristic-disguised-as-value (`Math.max(0, signed)` happened to coincide
  with Euro XV's actual post-payment balance only because the trustee netted
  exactly to zero). No remaining consumer.
- **`bookValue` collapses to one source.** Engine emits `equityBookValue` on
  `ProjectionInitialState`; UI reads it. Deletes the parallel UI computation
  at `ProjectionModel.tsx:374`. Verified numerically silent for any deal
  (resolver pre-filters defaulted loans before both code paths). Pre-flight
  Q3 deleted.
- **`equityWipedOut: boolean` added to `ProjectionInitialState`.** When the
  line-995 floor fires (totalAssets ≤ totalDebtOutstanding), the deal is
  balance-sheet insolvent; `calculateIrr` returns null on the all-non-negative
  cashflow series. UI must label this explicitly rather than show "N/A."
- **`endingPrincipalAccount` / `beginningPrincipalAccount` added to `PeriodResult`.**
  Engine has the running balance internally; just expose. Required by the new
  trustee tie-out test.
- **New `engine-trustee-tieout.test.ts`** — for every deal with a published
  trustee report, assert engine's modeled period-1 ending Principal Account ≈
  trustee post-payment-date ending Principal Account, ±rounding. Euro XV: 0 ≈ 0.
  Trustee data graduates from "ingestion input" to "regression test anchor."
- **New Phase 8: heuristic-as-value sweep** with α/β/γ triage rubric (real
  value / accounting convention / hidden assumption). Concrete pattern list.
- **Disambiguating comment on `projection.ts:995`** — the floor there is
  category β (accounting convention for negative-equity-as-zero), kept with
  `equityWipedOut` plumbing to surface the state. Distinct from the deleted
  category-γ floors.
- **Pre-flight gate shrinks to 3 questions** (Q1 partner-facing consumers,
  Q2 ts-morph dep, Q3 PR-template creation). Q3-and-Q4 from v5 (bookValue
  shift, IRR shift) deleted because both shifts are now nil.

**v5 changes vs v4** (independent self-critique pass): retained for history
[v5 changelog preserved in git; trimmed here to keep the active doc focused].

**v4 changes vs v3** [retained in git history; trimmed here].

---

## −1 · Pre-flight stakeholder gate (MUST complete before any code)

Three questions whose answers shape the implementation. **Code does not
begin until every row has an explicit attestation.** "Accept default" is
a valid attestation; silence is not.

**Mechanism for answering**: the user replies in the conversation thread
where this plan was authored, quoting the question and providing one of
{"accept default", "<custom answer>"}. The implementer copies the
attestations into a v6.1 of this plan as a record before opening any PR.

| Question | Recommended default | Attestation |
|---|---|---|
| Q1: Are there any consumers of `/clo/waterfall` numbers in partner-facing contexts other than solal@klyra.com? If yes, list by name. | Solo: only solal@klyra.com. | __________ |
| Q2: Is `ts-morph` (pinned to exact version, no caret) acceptable for the Phase 6 enforcement test? Alternative: TypeScript compiler API directly (~3× verbose). | Yes — pinned, ~3MB transitive footprint. | __________ |
| Q3: Phase 6 may need to CREATE `.github/PULL_REQUEST_TEMPLATE.md` (project-wide change — every future PR inherits the template). Acceptable? | Yes — single checkbox + Summary/Test plan sections. | __________ |

If the user attests differently from the recommended default on any
question, the affected sections of this plan must be revised before
implementation.

**Note on numeric shifts**:

*Totals*: v6 has no shifts. The previous "+2pp Forward IRR" and "+€1.8M
bookValue" shifts disclosed in v5's PRs were both heuristic artifacts;
v6 retracts them. Forward IRR stays at the engine's truthful number
(~−11.95% on Euro XV); displayed bookValue stays at the same number the
engine internally uses for the IRR cost basis. Phase 4 is a numerically
silent **total** refactor — the UI displays the engine's number instead
of computing its own, but they're already the same number.

*Per-row PeriodTrace displays*: Phase 3 DOES change what partners see at
the row level. None of these change any total, but each is partner-visible:
- Equity from Interest (DD): displayed €0 → engine-emitted ~€1.80M
  (projected) on Jul-2026 row for Euro XV.
- Reinv OC diversion (W): currently invisible; surfaces with amount when fired.
- OC/IC cure diversions (I/L/O/R/U): currently invisible; surface per test.
- Trustee/admin overflow (Y/Z): currently invisible; surface when capped.
- Incentive fee from interest (CC): currently invisible; surfaces when fired.
- Available for tranches: new row showing the correctly-computed residual
  (the original UI back-derivation silently dropped clauses A.i, A.ii, C).

PR 3 description must enumerate these per-row changes explicitly. Total
Equity Distribution stays the same; equity-from-interest + equity-from-
principal sum to the same total; partners reading the disclosure as
"literally nothing changes on screen" will be surprised.

---

## 0 · Pre-work prerequisites (verified facts)

- **`@testing-library/react` is NOT installed.** Phase 3 sidesteps with a
  pure helper (testable with vitest, no RTL needed).
- **`ts-morph` to be added as devDep at exact pinned version** (subject to
  Q2). Falls back to TypeScript compiler API directly if rejected.
- **Acceleration branch (`projection.ts:1568-1601`) emits its own `stepTrace`.**
  Decision: emit `availableForTranches: null`; UI shows an explanatory header.
- **`ResolvedDealData` JSON serialization safety**: v6 only ADDS engine
  fields and DELETES one resolver field (`principalAccountCashForward`,
  which was added in v5 but never shipped). Pre-merge audit: grep for
  `JSON.stringify(resolved`, IndexedDB persistence, API response payloads.
  No rename, so deserialization is forward-compatible.
- **Engine vs UI bookValue identity verified** (resolver.ts:882-885 +
  projection.ts:841 + ProjectionModel.tsx:372-374): both compute
  `Σ(non-DDTL non-defaulted parBalance) + signed principalAccountCash −
  Σ(non-equity tranche currentBalance)`, floored at 0. Mathematically
  identical for any deal. Phase 4 is a pure refactor.
- **`PeriodResult` does NOT currently expose principal-account balance per
  period** (`projection.ts:247-290`). Adding `endingPrincipalAccount` /
  `beginningPrincipalAccount` is named work item I1 in Phase 1.
- **`ProjectionInitialState` does NOT currently expose `equityBookValue` or
  `equityWipedOut`** (lines 298-310). Adding them is work item I2 in Phase 1.

---

## 0.5 · Inventory of violations (verified, not estimated)

### Violation A — `PeriodTrace.tsx`, lines 7-14 (UI back-derivation)

```ts
// Lines 7-10: re-computes fees from rate × beginPar / 4
const trusteeFee = beginPar * (inputs.trusteeFeeBps / 10000) / 4;     // ignores Actual/360 + Senior Expenses Cap
const seniorFee  = beginPar * (inputs.seniorFeePct / 100) / 4;         // ignores day-count
const hedgeCost  = beginPar * (inputs.hedgeCostBps / 10000) / 4;
const subFee     = beginPar * (inputs.subFeePct / 100) / 4;

// Line 11: reconstructs "available for tranches"
const availableAfterSenior = period.interestCollected - trusteeFee - seniorFee - hedgeCost;
// — omits taxes (A.i), issuer profit (A.ii), admin fee (C). Silently wrong.

// Lines 13-14: back-derives equity from totals (THE HEADLINE INCIDENT)
const principalAvailable = Math.max(0, period.prepayments + period.scheduledMaturities + period.recoveries - period.reinvestment);
const equityFromInterest = Math.max(0, period.equityDistribution - principalAvailable);
// — ignores OC cures (I/L/O/R/U), reinv OC diversion (W), trustee/admin overflow (Y/Z),
//   incentive fee (CC), and the actual interest waterfall. Returns 0 when the engine
//   correctly emitted €1.80M from interest.
```

### Violation B — `ProjectionModel.tsx:368-377` (`equityMetrics` UI duplication)

```ts
const equityMetrics = useMemo(() => {
  if (!resolved) return null;
  const subTranche = resolved.tranches.find(t => t.isIncomeNote);
  const subPar = subTranche?.originalBalance ?? subTranche?.currentBalance ?? 0;
  const totalLoans = resolved.loans.filter(l => !l.isDelayedDraw).reduce((s, l) => s + l.parBalance, 0);
  const debt = resolved.tranches.filter(t => !t.isIncomeNote).reduce((s, t) => s + t.currentBalance, 0);
  const bookValue = Math.max(0, totalLoans + resolved.principalAccountCash - debt);
  const bookValueCents = subPar > 0 ? (bookValue / subPar) * 100 : 0;
  return { subPar, bookValue, bookValueCents };
}, [resolved]);
```

**Two stacked concerns**:
- **B1 — Duplicates the engine.** `projection.ts:992-995` computes an
  identical `bookValue` (same inputs, same floor) to use as the equity
  investment cost basis at line 998. Two independent code paths producing
  the same number that partners see (UI card + Forward IRR display). A
  silent desync is a future bug.
- **B2 — Reads `resolved.principalAccountCash` raw in arithmetic.** The
  AST rule (Phase 6) forbids this in UI files; the read should be a
  pass-through of engine output, not a re-computation.

### Violation C — `ProjectionModel.tsx:398-470` (`inceptionIrr` composition)

Composes engine output (forward projection terminal), non-engine data
(`extractedDistributions` from trustee), and user choices (anchor date,
entry price) into a dated cashflow stream. The math primitive
`calculateIrrFromDatedCashflows` is in `projection.ts`; the **composition**
lives in the UI. Service-layer case.

### Violation D — `web/app/clo/page.tsx:80-81, 107, 623`

```ts
// cushion-as-percentage-of-trigger
(Math.abs(cushion) / Math.abs(trigger)) * 100
// — engine should expose `cushionRatioPct` per OC/IC test.

// total par via reduce
const totalPar = holdings.reduce((sum, h) => sum + (h.parBalance ?? 0), 0);
// — should read `resolved.poolSummary.totalPar`.
```

### Audit pass (not violations)

- `ProjectionModel.tsx:1287-1308` — cash flow detail table, reads
  `p.beginningPar`, `p.defaults`, etc. directly. ✓
- `HarnessPanel.tsx`, `SwitchSimulator.tsx`, `MonteCarloChart.tsx`,
  `WaterfallVisualization.tsx`, `helpers.ts`, `HoldingsTable.tsx`, Context
  Editor, all the assumption panels — clean. ✓

### Surfaces deferred to Phase 7

`web/app/clo/{analyses,analyze,chat,panel,screenings,onboarding}` — not
audited in this plan.

---

## 0.75 · UI-to-engine mapping (PeriodTrace completeness contract)

Every helper output line corresponds to one row here; every row's
`engineField` is a real key on `PeriodStepTrace` (or, for top-level
fields, on `PeriodResult`).

| UI label                           | PPM step | `engineField`                                        | Source object        |
|------------------------------------|----------|------------------------------------------------------|----------------------|
| Beginning par                      | —        | `beginningPar`                                       | `PeriodResult`       |
| Interest collected                 | —        | `interestCollected`                                  | `PeriodResult`       |
| Taxes & filing                     | A.i      | `taxes`                                              | `PeriodStepTrace`    |
| Issuer profit                      | A.ii     | `issuerProfit`                                       | `PeriodStepTrace`    |
| Trustee fee paid (capped)          | B        | `trusteeFeesPaid`                                    | `PeriodStepTrace`    |
| Admin fee paid (capped)            | C        | `adminFeesPaid`                                      | `PeriodStepTrace`    |
| Senior management fee              | E        | `seniorMgmtFee`                                      | `PeriodStepTrace`    |
| Hedge payment                      | F        | `hedgeCost`                                          | `PeriodStepTrace`    |
| **Available for tranches**         | —        | `availableForTranches` (NEW; nullable under accel)   | `PeriodStepTrace`    |
| Tranche interest paid              | G/H/J/M/P/S | `trancheInterestPaid` (per-tranche array)         | `PeriodStepTrace`    |
| OC/IC cure diversions              | I/L/O/R/U | `ocCureDiversions[]`                                | `PeriodStepTrace`    |
| Reinvestment OC diversion          | W        | `reinvOcDiversion`                                   | `PeriodStepTrace`    |
| Trustee+admin overflow             | Y/Z      | `trusteeOverflow`, `adminOverflow`                   | `PeriodStepTrace`    |
| Subordinated mgmt fee              | BB       | `subMgmtFee`                                         | `PeriodStepTrace`    |
| Incentive fee from interest        | CC       | `incentiveFee`                                       | `PeriodStepTrace`    |
| **Equity from interest**           | DD       | `equityFromInterest`                                 | `PeriodStepTrace`    |
| Equity from principal              | (princ wf)| `equityFromPrincipal`                               | `PeriodStepTrace`    |
| Total equity distribution          | —        | `equityDistribution`                                 | `PeriodResult`       |
| Reinvestment                       | —        | `reinvestment`                                       | `PeriodResult`       |
| **Principal proceeds (aggregate)** | —        | `principalProceeds` (NEW)                            | `PeriodResult`       |

**Sanity invariants** (asserted by the integration test in §4.2):
1. `period.equityDistribution === stepTrace.equityFromInterest + stepTrace.equityFromPrincipal` (non-acceleration mode).
2. `period.principalProceeds === period.prepayments + period.scheduledMaturities + period.recoveries`.
3. Non-acceleration: `stepTrace.availableForTranches === interestCollected - taxes - issuerProfit - trusteeFeesPaid - adminFeesPaid - seniorMgmtFee - hedgeCost`.

---

## 1 · Engine API additions

Five additions to `projection.ts`. No resolver-side additions (v5's
`principalAccountCashForward` is dropped).

### 1.1 — `PeriodStepTrace.availableForTranches: number | null`

Add to `PeriodStepTrace`. Captured after `applySeniorExpensesToAvailable`
on line ~1793.

```ts
/** Interest residual after PPM steps (A.i)→(F): the amount entering the
 *  tranche-interest pari-passu loop (PPM step (G) onward).
 *  NULL under acceleration mode (PPM 10(b)). UI hides the row when null
 *  AND renders an explanatory header.
 *  See CLAUDE.md § Engine ↔ UI separation. */
availableForTranches: number | null;
```

Tests: `projection-waterfall-audit.test.ts` adds two assertions (normal-mode
equality per Sanity Invariant 3, accel-mode null).

### 1.2 — `PeriodResult.principalProceeds: number`

```ts
/** Aggregate principal proceeds: prepayments + scheduledMaturities + recoveries.
 *  Emitted from the engine so the UI never sums these three fields itself. */
principalProceeds: number;
```

Test: `projection-edge-cases.test.ts` asserts Sanity Invariant 2.

### 1.3 — ~~Work item I1~~ DEFERRED

Adding `beginning/endingPrincipalAccount` to `PeriodResult` was conceived
as instrumentation for the engine-trustee tie-out test. That test is
deferred (see §3 Phase 1 work item 9: engine period boundary doesn't
align with trustee report dates without intra-period instrumentation).
With no immediate consumer, I1 is speculative — defer until the tie-out
test becomes implementable (either via Jul-15 trustee report becoming
available OR engine adding intra-period payment-date snapshots).

### 1.4 — Work item I2: `ProjectionInitialState.{equityBookValue, equityWipedOut}`

```ts
// in ProjectionInitialState
/** Total non-DDTL non-defaulted loan par + signed principalAccountCash −
 *  non-equity tranche balance, floored at 0. THE canonical "what equity
 *  is worth right now" value — same number used internally as the equity
 *  cost basis for forward IRR (line 998) and externally as the partner-
 *  facing book-value card and the inception-IRR terminal. Single source
 *  of truth; UI must read this field, not recompute it.
 *
 *  See CLAUDE.md § Engine ↔ UI separation. */
equityBookValue: number;

/** True iff totalAssets ≤ totalDebtOutstanding at t=0 — i.e., the line-995
 *  floor fired and equityCashFlows[0] = -0. The deal is balance-sheet
 *  insolvent; calculateIrr() returns null on the all-non-negative series.
 *  UI must label this state ("Deal is balance-sheet insolvent; IRR not
 *  meaningful") rather than show "N/A". */
equityWipedOut: boolean;
```

Computed adjacent to the existing line-992-998 logic; lifted into the
`initialState` IIFE at `projection.ts:1012-1041`. Estimated 30 min.

**Disambiguating comment added on `projection.ts:995`** (the floor stays —
it's category β, accounting convention; the deleted floors were category γ):

```ts
// The Math.max(0, totalAssets - totalDebtOutstanding) here is an
// ACCOUNTING-CONVENTION floor (Phase 8 triage category β): negative
// balance-sheet equity is reported as zero by convention. NOT a heuristic-
// disguised-as-value (the line-1316 q1Cash floor proposed in v5 plans was
// that, and was deleted in v6 because it manufactured fake alpha by
// ignoring the determination-date overdraft).
//
// When this floor fires, equityCashFlows[0] = -0 and calculateIrr() returns
// null on the all-non-negative series. The UI surfaces this via the
// `equityWipedOut` flag (set in initialState IIFE below) so partners see
// "Deal is balance-sheet insolvent; IRR not meaningful" rather than "N/A".
//
// Note: the negative principalAccountCash IS retained inside totalAssets
// (line 994) — the determination-date overdraft is a real claim against
// equity at t=0. Q1's principal-collection netting at line 1316 uses the
// same signed value; both are correct; floored variants would be wrong.
```

### 1.5 — Optional: `cushionRatioPct` on OC/IC tests

Resolution of Violation D. Resolver exposes
`cushionRatioPct: number` per OC/IC trigger. **Decision**: ship in Phase 7
as part of `web/app/clo/page.tsx` audit. Not partner-visible; no gate.

---

## 2 · Service layer creation

### 2.1 — Tightened service-layer definition

A service module is a **pure function that combines engine output with
USER-PROVIDED inputs (purchase date, scenario choice) or EXTERNAL HISTORICAL
data (trustee distributions, peer-deal benchmarks)**.

| Module | Layer | Why |
|---|---|---|
| `pool-metrics.ts` | Engine | Resolver-derived state only; no external data |
| `sensitivity.ts` | Engine | Engine N times with perturbed inputs |
| `harness.ts` | Borderline → engine for now | Engine + trustee fixtures |
| `inception-irr.ts` (new) | Service | Engine terminal + historical distributions + user anchor |

### 2.2 — `web/lib/clo/services/inception-irr.ts`

Lift the body of `ProjectionModel.tsx:398-470` verbatim into a pure
function. Terminal value sources from `result.initialState.equityBookValue`
(NOT a separately-computed UI bookValue):

```ts
/** See CLAUDE.md § Engine ↔ UI separation. */
export interface InceptionIrrInput {
  subNotePar: number;
  /** From result.initialState.equityBookValue — single canonical source. */
  equityBookValue: number;
  /** From result.initialState.equityWipedOut — when true, the IRR is null
   *  and the UI must label the wiped-out state. */
  equityWipedOut: boolean;
  closingDate: string;
  currentDate: string;
  userAnchor: { date: string; priceCents: number } | null;
  historicalDistributions: ReadonlyArray<{ date: string; distribution: number }>;
}

export interface InceptionIrrAnchor {
  irr: number | null;
  anchorDate: string;
  anchorPriceCents: number;
  distributionCount: number;
}

export interface InceptionIrrResult {
  primary: InceptionIrrAnchor & { isUserOverride: boolean };
  counterfactual: InceptionIrrAnchor | null;
  terminalValue: number;
  terminalDate: string;
  /** Mirrors input.equityWipedOut — UI uses this for label copy. */
  wipedOut: boolean;
}

export function computeInceptionIrr(input: InceptionIrrInput): InceptionIrrResult | null;
```

When `equityWipedOut === true`, `computeInceptionIrr` returns
`{ primary: { irr: null, ... }, counterfactual: null, terminalValue: 0, ..., wipedOut: true }`
so the UI can render a single explanatory line instead of the IRR card.

**UI consumption**:

```ts
const inceptionIrr = useMemo(() => {
  if (!result || !resolved) return null;
  const subTranche = resolved.tranches.find(t => t.isIncomeNote);
  const subNotePar = subTranche?.originalBalance ?? subTranche?.currentBalance ?? 0;
  return computeInceptionIrr({
    subNotePar,
    equityBookValue: result.initialState.equityBookValue,
    equityWipedOut: result.initialState.equityWipedOut,
    closingDate: closingDate ?? resolved.dates.firstPaymentDate ?? "",
    currentDate: resolved.dates.currentDate,
    userAnchor: equityInceptionData?.purchaseDate && equityInceptionData?.purchasePriceCents != null
      ? { date: equityInceptionData.purchaseDate, priceCents: equityInceptionData.purchasePriceCents }
      : null,
    historicalDistributions: extractedDistributions ?? [],
  });
}, [result, resolved, closingDate, equityInceptionData, extractedDistributions]);
```

Tests cover 6 scenarios (default anchor, user override, counterfactual
visibility, terminal source, single-flow null, empty distributions) plus
a 7th: `equityWipedOut === true` returns `wipedOut: true` with null IRRs.

### 2.3 — Reserved future modules (do not create now)

- `services/harness-diff.ts`
- `services/partner-export.ts`
- `services/sensitivity-presets.ts`

---

## 3 · Migration phases

### Phase 1 — Engine field additions (preparation, no UI changes)

**Work:**
1. Add `availableForTranches: number | null` to `PeriodStepTrace` (1.1).
2. Add `principalProceeds: number` to `PeriodResult` (1.2).
3. **(I1)** Add `beginningPrincipalAccount`/`endingPrincipalAccount` to
   `PeriodResult` (1.3). Engine has the values internally.
4. **(I2)** Add `equityBookValue`/`equityWipedOut` to `ProjectionInitialState`
   (1.4). Lifted from line-992-998 into the existing `initialState` IIFE.
5. Add disambiguating comment on `projection.ts:995` per §1.4.
6. Pre-merge JSON-serialization audit: grep for `JSON.stringify(resolved`,
   IndexedDB persistence, API response payloads. v6 only adds engine fields
   (and deletes one resolver-only field that hadn't shipped); old payloads
   continue to deserialize.
7. **Spec the synthetic deal fixture** (§4.4 — used by integration test,
   edge-case test, smoke test, and engine-trustee tie-out test).
8. **Extend `web/scripts/debug-q1-waterfall.ts`** to also output
   inception-IRR (primary + counterfactual). Inlines the composition
   pre-Phase-2; one-line follow-up after Phase 2 swaps to
   `computeInceptionIrr`.
9. ~~**New `engine-trustee-tieout.test.ts`**~~ — **DEFERRED to Phase 8.** Verification step (running runProjection on Euro XV locally + reading projection.ts:1113-1118) confirmed engine period semantics: Q1 = currentDate → addQuarters(currentDate, 1) (e.g. Apr 1 → Jul 1 for Euro XV), waterfall fires at period END (Jul 1). The Apr-15 trustee event happens *inside* engine Q1 with no separate boundary. Therefore engine `periods[0].endingPrincipalAccount` (Jul 1 projected) cannot be compared directly to BNY Apr-15 ending (€0, intra-engine-Q1 state). BNY Jul-15 isn't published yet. Tie-out test requires either intra-period payment-date instrumentation OR a future trustee report; filing as Phase 8 finding rather than shipping a test we know would fail.

**Tests added/modified**:
- `projection-waterfall-audit.test.ts` — `availableForTranches` assertions.
- `projection-edge-cases.test.ts` — `principalProceeds` sanity.
- `projection-equity.test.ts` (or new `projection-initial-state.test.ts`) —
  `equityBookValue` matches the engine's internal cost basis;
  `equityWipedOut === true` iff `totalAssets <= totalDebtOutstanding`.
- `engine-trustee-tieout.test.ts` (new) — per §4.4.

**Targeted snapshot regeneration** (no blanket `vitest --update`):
| File | Action |
|---|---|
| `projection-waterfall-audit.test.ts` | Add assertions; no snapshot. |
| `projection-edge-cases.test.ts` | Add `principalProceeds` test. |
| `__snapshots__/projection.test.ts.snap` (if exists) | Re-record manually after confirming only new fields appear. |
| `__snapshots__/harness.test.ts.snap` (if exists) | Re-record manually. |
| `web/scripts/debug-q1-waterfall.ts` | Add print of new fields + inception-IRR. |

Run `find web/lib/clo/__tests__ -name "*.snap" -type f` first to enumerate
existing snapshots; update only those containing `PeriodResult`,
`PeriodStepTrace`, or `ProjectionInitialState` shapes.

**Verification:** `tsc --noEmit` clean; `vitest run` green; snapshot diffs
review-only.

**Mergeable independently?** Yes — pure additions. UI not yet using new
fields, no behavioral change, no partner-visible numeric shift.

**Reversibility:** trivially revertible — additive fields; no consumer
depends on them yet.

**Estimated active engineering time:** 4 hours
(2.5h additions + fixture construction + 1h I1/I2 instrumentation + tie-out
test wiring + 0.5h debug-script extension).

**Estimated diff:** ~380 lines including tests, fixture, script.

### Phase 2 — Service: `inception-irr` extraction

**Work:**
1. Create `web/lib/clo/services/index.ts` barrel.
2. Create `web/lib/clo/services/inception-irr.ts` with `computeInceptionIrr`
   (signature per §2.2; consumes `equityBookValue` from `initialState`).
3. Lift body from `ProjectionModel.tsx:398-470`.
4. Replace useMemo with thin wrapper.
5. One-line cleanup commit on `debug-q1-waterfall.ts` to swap the inlined
   inception-IRR composition for the service call.

**Tests**: 7 scenarios (the v5 six + the new `wipedOut` case).

**Verification:** `/clo/waterfall` IRR card renders identical numbers
before/after. Manual before/after screenshots in PR description.

**Mergeable independently?** Yes.

**Reversibility:** trivially revertible.

**Estimated active engineering time:** 2 hours. Calendar: 1 day.

**Estimated diff:** ~210 lines including tests.

### Phase 3 — `PeriodTrace.tsx` rewrite (the headline fix)

**Work:**
1. Define `PeriodTraceLine` type:
```ts
export interface PeriodTraceLine {
  label: string;
  ppmStep?: string;
  amount: number | null;
  /** Required for non-presentation rows; lets §4.2 integration test
   *  iterate the §0.75 mapping and assert helper-vs-engine equality. */
  engineField?: keyof PeriodStepTrace | "beginningPar" | "interestCollected"
              | "equityDistribution" | "reinvestment" | "principalProceeds";
  indent?: number;
  muted?: boolean;
  severity?: "info" | "warn";
}
```
2. Extract trace-line construction into pure helper
   `buildPeriodTraceLines(period: PeriodResult): PeriodTraceLine[]` —
   **no `inputs` parameter**. AST rule (Phase 6) forbids `inputs.X`
   arithmetic in this file. Display labels needing inputs metadata are
   constructed in JSX, never combined with `period` values.
3. Helper consumes engine fields per §0.75 mapping; sets `engineField`
   on every semantic line.
4. Rewrite `PeriodTrace.tsx` to call helper; JSX is pass-through.
5. Render zero-amount rows muted (opacity 0.55, italic).
6. Hide rows with `amount === null`.
7. **Acceleration explanatory header** when `lines.some(l => l.amount === null)`:
   "Accelerated distribution active: interest and principal pool
   together, with tranches paid sequentially by seniority. Senior-expenses
   cap is suspended (PPM § 10(b))." Static; no engine arithmetic.

**Test fixture**: shared synthetic deal from §4.4. Constructed to exercise
non-zero `equityFromInterest`, zero `reinvOcDiversion`, non-zero
`ocCureDiversions[0]`, an accel-mode period.

**Tests** in `web/app/clo/waterfall/__tests__/period-trace-lines.test.ts`:
- **Bug regression**: synthetic period with
  `stepTrace.equityFromInterest = 1_802_392.55` → helper output includes
  `(DD) Equity from Interest` line with `amount = 1_802_392.55`, NOT 0.
- **Completeness**: every helper row with `ppmStep` set has `engineField`
  defined and matching the §0.75 mapping (asserted via enum comparison).
- **Muted-zero**: zero-amount rows have `muted: true`.
- **Acceleration**: `availableForTranches: null` row is omitted.
- **Layout order**: helper output respects PPM order (A.i, A.ii, B, C, E,
  F, G/H/J/M/P/S, I/L/O/R/U, W, X, Y, Z, BB, CC, DD).

**Verification on real data:**
1. `/clo/waterfall` against Euro XV; expand Jul 2026 row.
2. Confirm `(DD) Equity from Interest = €1,802,392.55`, `Total Equity
   Distribution = €1,802,392.55`, `Equity from Principal = €0.00`.
3. Compare to trustee Apr 15 waterfall (DD = €1,857,942.69) — within 3%.
4. Manual before/after screenshots in PR description.

**Mergeable independently?** Requires Phase 1.

**Reversibility:** revertible.

**Estimated active engineering time:** 4 hours. Calendar: 2 days.

**Estimated diff:** ~450 lines.

### Phase 4 — `bookValue` migration (numerically silent refactor)

**Work:**
1. Delete `equityMetrics` useMemo in `ProjectionModel.tsx:368-377`.
2. Replace consumers:
   - `equityMetrics.bookValue` → `result.initialState.equityBookValue`
   - `equityMetrics.bookValueCents` → derived locally
     (`(result.initialState.equityBookValue / subNotePar) * 100`) —
     presentation-only formatting, single use site, no semantic content.
     Acceptable per the §0.75 carve-out for trivial JSX-level division.
   - `equityMetrics.subPar` → derived locally from
     `resolved.tranches.find(t => t.isIncomeNote)` (presentation lookup,
     not arithmetic on engine output).
3. **Wiped-out UI fallback**: when
   `result.initialState.equityWipedOut === true`, replace the Book Value
   card body with: "Deal is balance-sheet insolvent. Equity has no
   positive cost basis; IRR is not meaningful." Hide the
   entry-price form; hide the Forward IRR card or label it the same way.

**Partner-visible impact:** **None for any deal**. The displayed
`bookValue` already equals the engine's internal cost basis (verified
identity in §0). The wiped-out UX is dormant for solvent deals; activates
only when a future deal triggers it.

**Tests:** none new (covered by Phase 1's I2 test). Verification by
visual diff: numbers unchanged on Euro XV.

**Mergeable independently?** Requires Phase 1.

**Reversibility:** trivially revertible.

**Estimated active engineering time:** 1 hour (deletion + consumer
updates + wiped-out fallback UI). Calendar: 1 day.

**Estimated diff:** ~60 lines.

### Phase 5 — DELETED

The v5 plan proposed flooring `q1Cash = Math.max(0, initialPrincipalCash)`
to "fix" a "+2pp Forward IRR drag." Investigation in v6 (BNY Apr-15
Account Balances + Intex period 16 Reinv Princ = 0) confirmed the
unfloored engine is correct: the determination-date overdraft legitimately
nets against Q1 principal collections, matching the trustee's actual
period-16 zero-reinvestment outcome. The proposed floor manufactured fake
alpha. The unfloored Forward IRR (~−11.95% on Euro XV) is the truthful
number; partners see the truth.

No engine change. Phase 5 is gone, not deferred.

### Phase 6 — Documentation + AST enforcement

Lands AFTER Phases 3 and 4 (so the existing UI violations are gone before
the enforcement test asserts they're absent).

**Work:**
1. `CLAUDE.md` — already created. Update bookValue references to "engine
   emits `result.initialState.equityBookValue`; UI reads it directly."
2. Add `ts-morph` to devDeps at exact pinned version (subject to Q2):
   `"ts-morph": "21.0.1"`.
3. **Initial AST scope**: `web/app/clo/waterfall/**`. Phase 7 widens.
4. AST enforcement test at `web/lib/clo/__tests__/architecture-boundary.test.ts`:

```ts
import { Project, SyntaxKind, Node } from "ts-morph";
import { describe, expect, it } from "vitest";
import { resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const TSCONFIG_PATH = resolve(REPO_ROOT, "web/tsconfig.json");

const ARITHMETIC_TOKENS = new Set([
  SyntaxKind.AsteriskToken, SyntaxKind.SlashToken,
  SyntaxKind.PlusToken, SyntaxKind.MinusToken,
]);

function expressionContainsMember(node: Node, owner: string, member: string): boolean {
  let found = false;
  node.forEachDescendant((d) => {
    if (Node.isPropertyAccessExpression(d)) {
      const parent = d.getExpression();
      if (Node.isIdentifier(parent) && parent.getText() === owner && d.getName() === member) found = true;
    }
  });
  return found;
}

function expressionContainsAnyMember(node: Node, owner: string): boolean {
  let found = false;
  node.forEachDescendant((d) => {
    if (Node.isPropertyAccessExpression(d)) {
      const parent = d.getExpression();
      if (Node.isIdentifier(parent) && parent.getText() === owner) found = true;
    }
  });
  return found;
}

interface Rule {
  id: string;
  scope: RegExp;
  detect: (node: Node) => boolean;
  rationale: string;
}

const RULES: Rule[] = [
  {
    id: "ui-uses-inputs-in-arithmetic",
    scope: /web\/app\/clo\/waterfall\/(period-trace-lines\.ts|PeriodTrace\.tsx)$/,
    detect: (node) => {
      if (!Node.isBinaryExpression(node)) return false;
      if (!ARITHMETIC_TOKENS.has(node.getOperatorToken().getKind())) return false;
      return expressionContainsAnyMember(node, "inputs");
    },
    rationale:
      "Arithmetic involving inputs.<member> in a UI helper. The original PeriodTrace incident did `beginPar * (inputs.trusteeFeeBps / 10000) / 4` and silently dropped clauses A.i, A.ii, C. Read from period.stepTrace.* instead.",
  },
  {
    id: "ui-back-derives-equity",
    scope: /web\/app\/clo\/.*\.(ts|tsx)$/,
    detect: (node) => {
      if (!Node.isBinaryExpression(node)) return false;
      if (node.getOperatorToken().getKind() !== SyntaxKind.MinusToken) return false;
      return expressionContainsMember(node, "period", "equityDistribution");
    },
    rationale:
      "Back-derivation from period.equityDistribution. Read period.stepTrace.equityFromInterest / equityFromPrincipal directly.",
  },
  {
    id: "ui-reads-raw-principal-cash",
    scope: /web\/app\/clo\/.*\.(ts|tsx)$/,
    detect: (node) => {
      if (!Node.isBinaryExpression(node)) return false;
      if (!ARITHMETIC_TOKENS.has(node.getOperatorToken().getKind())) return false;
      return expressionContainsMember(node, "resolved", "principalAccountCash");
    },
    rationale:
      "Reading raw resolver field with sign-convention invariant in arithmetic. Use result.initialState.equityBookValue (engine output) instead.",
  },
  {
    id: "ui-recomputes-book-value",
    scope: /web\/app\/clo\/.*\.(ts|tsx)$/,
    detect: (node) => {
      // Match `Math.max(0, totalLoans + … - debt)` style patterns inside UI files.
      // Specifically: a CallExpression of Math.max with a BinaryExpression second arg
      // containing arithmetic over both `loans` (or `totalLoans`) and `debt`.
      if (!Node.isCallExpression(node)) return false;
      const expr = node.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return false;
      if (expr.getExpression().getText() !== "Math" || expr.getName() !== "max") return false;
      const args = node.getArguments();
      if (args.length !== 2) return false;
      const text = args[1].getText();
      return /loans?\b/i.test(text) && /\bdebt\b/i.test(text);
    },
    rationale:
      "UI re-deriving equity book value. Read from result.initialState.equityBookValue. The engine and UI both computing this independently is the bug Phase 4 fixes; this rule prevents regression.",
  },
];

function hasAllowComment(node: Node, ruleId: string): boolean {
  const sourceFile = node.getSourceFile();
  const lines = sourceFile.getFullText().split("\n");
  const nodeLine = node.getStartLineNumber() - 1;
  const marker = new RegExp(`arch-boundary-allow:\\s*${ruleId}\\b`);
  for (let i = nodeLine - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (line.startsWith("//")) {
      if (marker.test(line)) return true;
      continue;
    }
    return false;
  }
  return false;
}

describe("UI does not re-derive engine values", () => {
  it("no AST violations under scoped UI files", () => {
    const project = new Project({ tsConfigFilePath: TSCONFIG_PATH });
    const violations: string[] = [];
    for (const rule of RULES) {
      const files = project.getSourceFiles().filter((f) => rule.scope.test(f.getFilePath()));
      for (const file of files) {
        file.forEachDescendant((node) => {
          if (rule.detect(node) && !hasAllowComment(node, rule.id)) {
            violations.push(
              `${file.getFilePath()}:${node.getStartLineNumber()} [${rule.id}] ${rule.rationale}`,
            );
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });
});
```

5. **CI gate**: shallow-clone-safe path filter:
```bash
BASE="${BASE_REF:-origin/main}"
git fetch --no-tags --depth=1 origin "${BASE#origin/}" 2>/dev/null || true
if git diff --name-only "${BASE}...HEAD" | grep -qE "^web/(app|lib)/clo/"; then
  vitest run web/lib/clo/__tests__/architecture-boundary.test.ts
fi
```

6. `web/docs/clo-model-known-issues.md` — add a section cross-referencing
   the incident and pointing to `CLAUDE.md`.

7. **PR template** (gated on Q3): if Q3 = accept, add or create
   `.github/PULL_REQUEST_TEMPLATE.md` with the checkbox:
   `[ ] If this PR adds UI computation: I have justified why it can't live in the engine or service layer (see CLAUDE.md § Engine ↔ UI separation).`
   If Q3 ≠ accept, document the principle in `CONTRIBUTING.md` instead.

**Reversibility:** AST test reversible (delete file or per-occurrence
allow comments). PR template / CLAUDE.md are doc edits.

**Estimated active engineering time:** 3 hours (was 2.5h in v5; AST rule
added for `ui-recomputes-book-value`). Calendar: 2 days.

**Estimated diff:** ~210 lines.

### Phase 7 — Audit deferred surfaces

**Per-surface estimates** (revised in v5; unchanged in v6):

| Surface | Estimate | Notes |
|---|---|---|
| `web/app/clo/page.tsx` | 1h | Includes `cushionRatioPct` ship. |
| `web/app/clo/analyses/**` | 1.5h | |
| `web/app/clo/analyze/**` | 1.5h | |
| `web/app/clo/panel/**` | 1h | |
| `web/app/clo/screenings/**` | 1h | |
| `web/app/clo/chat/**` | 3-5h | Three-check audit. |
| `web/app/clo/onboarding/**` | 30m | |
| **Total** | **9.5–13h** | |

**Chat audit** (three concrete checks):

(a) **AST sweep**: widen the Phase 6 enforcement test scope to include
`web/app/clo/chat/**`. Run; remediate any matches.

(b) **Number-source audit**: every numeric value the chat surface emits to
the user must trace to a structured engine call. Search for `${...}`
template literals, `.toFixed`, `.toLocaleString`, `formatAmount` calls.
Confirm each is either (i) a direct read of an engine/service field, or
(ii) presentation-only transform.

(c) **Prompt audit**: scan chat system prompts and tool definitions for
"calculate", "compute", "derive", "figure out". Replace with "look up",
"report", "summarize the existing engine output value." LLMs given
calculation instructions hallucinate arithmetic.

**Stop condition:**

Phase 7 is complete when ALL hold:
1. AST scope widened to `web/app/clo/**` and passes.
2. Every chat-surface emission point's number provenance is documented or
   traces to an engine field via 1-2 hops.
3. No prompt under `web/app/clo/chat/**` contains calculation verbs.
4. `cushionRatioPct` ships, eliminating Violation D.

**Reversibility:** each micro-PR independently revertible.

### Phase 8 — Heuristic-as-value sweep (NEW)

**Goal:** apply the lesson from the v5→v6 Phase 5 retraction across the
whole engine + resolver. Hunt for places where a numeric placeholder
masks an unstated assumption.

**Pattern list** (search targets):

```
PATTERN                                                      WHERE TO LOOK
─────────────────────────────────────────────────────────────────────────────
Math.max(0, x) where x ∈ external/parsed data               web/lib/clo/**
?? 0 / || 0 on numeric fields read from extracted documents web/lib/clo/extraction/**
parseFloat/Number with implicit NaN→0 fallback              web/lib/clo/sdf/**, intex/**
Resolver returns 0 for missing upstream value (no warning)  web/lib/clo/resolver.ts
```

**Triage rubric** — each hit gets a written disposition:

- **(α) Real value** — zero is a legitimate semantic for the field
  (e.g., `recoveryPipeline` empty period). Keep, no comment needed.
- **(β) Accounting convention** — zero is a convention for an undefined
  state (e.g., negative balance-sheet equity reported as zero).
  KEEP with disambiguating comment AND ensure downstream consumers can
  detect the convention firing (e.g., `equityWipedOut` flag on
  ProjectionInitialState).
- **(γ) Hidden assumption** — zero papers over an unstated assumption
  about the data or model (e.g., the deleted `q1Cash` floor, the deleted
  `principalAccountCashForward`). DELETE; route through engine output or
  surface the assumption explicitly.

**Stop condition:** every match in `web/lib/clo/**` for the four search
patterns is annotated with α / β / γ. Category β has cross-referenced
downstream flags. Category γ is deleted or refactored.

**Estimated active engineering time:** 4-8 hours depending on hit count.
Calendar: 1 week.

**Reversibility:** each disposition is independently revertible.

---

## 4 · Test strategy

### 4.1 Coverage targets

| Layer | New tests |
|---|---|
| Engine | `availableForTranches` assertion (normal + accel); `principalProceeds` aggregate sanity; `equityBookValue` matches internal cost basis; `equityWipedOut` boolean correctness; `endingPrincipalAccount` per period |
| Resolver | (no new resolver tests in v6 — engine-side) |
| Service | `inception-irr.test.ts` (7 scenarios: previous 6 + wiped-out) |
| UI helper | `period-trace-lines.test.ts` (5 scenarios) |
| Architecture boundary | `architecture-boundary.test.ts` (4 AST rules) |
| **Engine ↔ trustee tie-out** | `engine-trustee-tieout.test.ts` (NEW; per §4.4) |
| Integration / principle regression | `engine-ui-invariants.test.ts` (per §4.2) |

### 4.2 Integration test for the principle itself

Iterates the §0.75 mapping; asserts helper output equals engine output for
every row.

```ts
import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
// Path: from web/lib/clo/__tests__/ → up three to web/, then into app/clo/waterfall/
import { buildPeriodTraceLines } from "../../../app/clo/waterfall/period-trace-lines";
import { syntheticDealFixture } from "./fixtures/synthetic-deal";

describe("UI helper output matches engine on every mapping row", () => {
  const result = runProjection(syntheticDealFixture);
  const interestPeriod = result.periods.find(
    (p) => p.stepTrace.equityFromInterest > 0 && p.stepTrace.availableForTranches !== null,
  );
  if (!interestPeriod) {
    throw new Error("synthetic fixture must produce a non-acceleration period with non-zero equityFromInterest");
  }

  const lines = buildPeriodTraceLines(interestPeriod);

  it("Sanity Invariant 1: equityDistribution = equityFromInterest + equityFromPrincipal", () => {
    expect(interestPeriod.equityDistribution).toBe(
      interestPeriod.stepTrace.equityFromInterest + interestPeriod.stepTrace.equityFromPrincipal,
    );
  });

  it("Sanity Invariant 2: principalProceeds = prepayments + scheduledMaturities + recoveries", () => {
    expect(interestPeriod.principalProceeds).toBe(
      interestPeriod.prepayments + interestPeriod.scheduledMaturities + interestPeriod.recoveries,
    );
  });

  it("Sanity Invariant 3: availableForTranches = interestCollected − senior expenses", () => {
    const t = interestPeriod.stepTrace;
    expect(t.availableForTranches).toBe(
      interestPeriod.interestCollected - t.taxes - t.issuerProfit -
        t.trusteeFeesPaid - t.adminFeesPaid - t.seniorMgmtFee - t.hedgeCost,
    );
  });

  it("every helper line with engineField matches engine output exactly", () => {
    for (const line of lines) {
      if (!line.engineField) continue;
      const engineValue =
        line.engineField in interestPeriod.stepTrace
          ? (interestPeriod.stepTrace as Record<string, unknown>)[line.engineField]
          : (interestPeriod as Record<string, unknown>)[line.engineField];
      // Per-tranche arrays (e.g., trancheInterestPaid, ocCureDiversions)
      // are expanded into multiple rows by the helper; the row's `amount` is
      // an element, not the array. Scalar-only equality covers simple-field
      // rows; array-row coverage is in period-trace-lines.test.ts.
      if (typeof engineValue === "number") {
        expect(line.amount, `mismatch on row "${line.label}" (engineField=${line.engineField})`).toBe(engineValue);
      }
    }
  });

  it("regression case: equityFromInterest > 0 surfaces as a non-zero (DD) row", () => {
    const ddLine = lines.find((l) => l.ppmStep === "DD");
    expect(ddLine).toBeDefined();
    expect(ddLine!.amount).toBe(interestPeriod.stepTrace.equityFromInterest);
    expect(ddLine!.amount).toBeGreaterThan(0);
  });
});
```

### 4.3 Live-data regression oracle

`web/scripts/debug-q1-waterfall.ts` outputs after each phase merge:

```
=== Phase 1 (engine fields added) ===
[unchanged numbers; new fields availableForTranches, principalProceeds, beginningPrincipalAccount, endingPrincipalAccount, equityBookValue, equityWipedOut populated]

=== Phase 2 (inception-irr extracted) ===
[unchanged; behavior-preserving]

=== Phase 3 (PeriodTrace rewrite) ===
[unchanged; UI-only]

=== Phase 4 (bookValue migration) ===
[unchanged; numerically silent — engine and UI bookValue were already identical]

=== Phase 6 (AST enforcement) ===
[unchanged]
```

No partner-visible numeric shifts in any phase.

### 4.4 Synthetic deal fixture + engine-trustee tie-out test

`web/lib/clo/__tests__/fixtures/synthetic-deal.ts`:

```ts
// Constructed to exercise every row in §0.75 mapping. Used by:
//   - projection-edge-cases.test.ts (negative-cash test for the existing
//     unfloored q1Cash netting; not the deleted Phase 5 floor)
//   - period-trace-lines.test.ts (Phase 3 helper test)
//   - engine-ui-invariants.test.ts (§4.2 integration)
//   - engine-trustee-tieout.test.ts (§4.4 — uses Euro XV resolved data
//     from new_context.json, not this synthetic fixture)
//   - projection-initial-state.test.ts (Phase 1 I2 test)

export const syntheticDealFixture: ResolvedDealData = {
  /** 20 loans @ €25M par each = €500M. */
  loans: Array.from({ length: 20 }, (_, i) => ({
    id: `loan-${i + 1}`,
    parBalance: 25_000_000,
    coupon: 0.06,
    isDelayedDraw: false,
    /* …other required Loan fields with reasonable defaults… */
  })),
  /** Tranches: A €300M, B €60M, C €40M, D €30M, E €30M, F €10M (income note). */
  tranches: [
    { id: "A", className: "A",  originalBalance: 300_000_000, currentBalance: 300_000_000, coupon: 0.015, isIncomeNote: false, /* … */ },
    { id: "B", className: "B",  originalBalance:  60_000_000, currentBalance:  60_000_000, coupon: 0.020, isIncomeNote: false, /* … */ },
    { id: "C", className: "C",  originalBalance:  40_000_000, currentBalance:  40_000_000, coupon: 0.030, isIncomeNote: false, /* … */ },
    { id: "D", className: "D",  originalBalance:  30_000_000, currentBalance:  30_000_000, coupon: 0.045, isIncomeNote: false, /* … */ },
    { id: "E", className: "E",  originalBalance:  30_000_000, currentBalance:  30_000_000, coupon: 0.070, isIncomeNote: false, /* … */ },
    { id: "F", className: "Sub",originalBalance:  10_000_000, currentBalance:  10_000_000, coupon: 0,     isIncomeNote: true,  /* … */ },
  ],
  principalAccountCash: 500_000,                // positive default; negative variant below
  /* …other required ResolvedDealData fields with reasonable defaults… */
};

/** Variant for the existing unfloored-q1Cash netting test. */
export const syntheticDealNegativeCashFixture: ResolvedDealData = {
  ...syntheticDealFixture,
  principalAccountCash: -1_000_000,
};

/** Variant exercising the equityWipedOut path (assets ≤ debt). */
export const syntheticDealWipedOutFixture: ResolvedDealData = {
  ...syntheticDealFixture,
  /** Tranches summing > €500M of debt (vs €500M loans + €0.5M cash). */
  tranches: [
    { id: "A", className: "A", originalBalance: 600_000_000, currentBalance: 600_000_000, coupon: 0.015, isIncomeNote: false, /* … */ },
    { id: "F", className: "Sub", originalBalance: 10_000_000, currentBalance: 10_000_000, coupon: 0, isIncomeNote: true, /* … */ },
  ],
};
```

**Engine-trustee tie-out** (`engine-trustee-tieout.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
import { buildFromResolved } from "../build-projection-inputs";
import euroXVContext from "../../../../new_context.json";
import { CLO_DEFAULTS } from "../defaults";

/** For every deal with a published trustee report at a known
 *  post-determination payment date, the engine's modeled period-1 ending
 *  Principal Account balance must match the trustee's reported ending
 *  balance, ±1 EUR rounding tolerance.
 *
 *  REQUIRED PRE-WRITE VERIFICATION (do BEFORE specifying expected values):
 *  Run `runProjection(buildFromResolved(euroXV.resolved, CLO_DEFAULTS))`
 *  locally. Inspect:
 *    1. `periods[0].date` — what date does engine Q1 END on?
 *    2. `periods[0].endingPrincipalAccount` — what value does engine model?
 *
 *  Then pick the trustee snapshot that covers the same date. If
 *  periods[0].date === "2026-04-15", the comparator is BNY Apr-15 ending
 *  balance (€0 for Euro XV). If periods[0].date === "2026-07-15", the
 *  comparator is BNY Jul-15 (NOT YET PUBLISHED at plan-write time;
 *  test would defer until that report exists). If periods[0].date is
 *  something else, that itself is a discovery — the engine's period
 *  boundary semantics need clarification before the test can have a
 *  defensible expected value.
 *
 *  DO NOT hardcode `trusteeEndingPrincipalAccount` until the
 *  verification step above is done and `periods[0].date` is known.
 *
 *  Fixture additions: when a new deal is added under
 *  __tests__/fixtures/trustee-snapshots/ with a published trustee Note
 *  Valuation, append it to the table below — and run the same
 *  verification (engine periods[0].date → trustee snapshot date match)
 *  before specifying the expected value. */
const TRUSTEE_SNAPSHOTS = [
  // {
  //   name: "Euro XV (Ares EU CLO XV)",
  //   resolved: euroXVContext.resolved,
  //   trusteePaymentDate: <fill from periods[0].date>,
  //   trusteeEndingPrincipalAccount: <fill from BNY snapshot at trusteePaymentDate>,
  // },
];

describe("engine modeled stub-period state ties out to trustee", () => {
  for (const snap of TRUSTEE_SNAPSHOTS) {
    it(`${snap.name}: periods[0].endingPrincipalAccount ≈ trustee ${snap.trusteePaymentDate}`, () => {
      const inputs = buildFromResolved(snap.resolved, CLO_DEFAULTS);
      const result = runProjection(inputs);
      const modeled = result.periods[0].endingPrincipalAccount;
      expect(Math.abs(modeled - snap.trusteeEndingPrincipalAccount)).toBeLessThan(1);
    });
  }
});
```

---

## 5 · Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Engine field addition breaks fixture deserialization | Low | Med | v6 only adds engine fields; never renames. Targeted snapshot regen. |
| Acceleration `availableForTranches: null` misinterpreted as bug | Med | Low | Explanatory header in Phase 3; test asserting null is intentional. |
| `inception-irr` extraction loses subtle dependency | Low | High | Manual before/after screenshots; behavior-preserving refactor. |
| Engine-trustee tie-out test fails for Euro XV | Low | High | Indicates engine Q1 semantic disagreement (stub vs full quarter); resolves as Phase 8 work, not a test bug. Documented in test comment. |
| `equityWipedOut` UX copy unclear to partners | Low | Low | Implementer chooses copy; not an architectural concern. |
| `bookValue` migration silently changes a number | None | — | Mathematically identical formulas verified; pure refactor. |
| AST enforcement test creates false positives | Med | Low | Per-occurrence allow comments. Backout: same rule fires twice on master without code change → disable rule scope for 24h while reproducer found. |
| AST `ui-recomputes-book-value` rule too narrow / too broad | Med | Low | Pattern matches `Math.max(0, …loans + … - debt …)`; tunable. |
| `principalAccountCashForward` deletion breaks consumer that read v5 plan | None | — | Field never shipped; v5 was a draft plan, not merged code. |
| Phase 7 surface audit reveals violations larger than expected | Med | Med | Stop condition prevents indefinite drag; surfaces split into per-PR scope. |
| Phase 8 reveals many heuristic-as-value patterns | Med | Med | α/β/γ triage rubric makes each disposition explicit; no infinite expansion. |
| Diagnostic script's `new_context.json` path breaks | Med | Low | CI smoke test using §4.4 synthetic fixture is durable oracle. |
| Chat assistant generates computed numbers in prose | Med | High | Phase 7 three-check audit; prompt audit removes calculation verbs. |
| ts-morph dependency rejected by user | — | — | Pre-approved by Q2 default. Fallback specified. |
| Pre-flight stakeholder questions answered "no" or "counter" | Med | Med | Plan revision required per §-1; explicit gate prevents downstream rework. |

---

## 6 · Sequencing summary

```
Phase 1  Engine fields + I1 + I2 + tieout  ── independent       (~380 LOC, ~4 h)
Phase 2  Service: inception-irr            ── independent       (~210 LOC, ~2 h)
Phase 3  PeriodTrace rewrite               ── needs Phase 1     (~450 LOC, ~4 h)
Phase 4  bookValue migration (silent)      ── needs Phase 1     (~60 LOC, ~1 h)
Phase 5  DELETED                           ── (no work)
Phase 6  Documentation + AST enforcement   ── needs Phases 3+4  (~210 LOC, ~3 h)
Phase 7  Audit deferred surfaces           ── needs Phase 6     (9.5-13 h total)
Phase 8  Heuristic-as-value sweep          ── independent       (4-8 h)
```

**Canonical PR ordering:**

| PR # | Phases bundled | Why bundled | Stakeholder gate? |
|------|---------------|-------------|-------------------|
| 1    | Phase 1 (incl I1, I2, tieout test) | Engine prep + tie-out | No (no partner-visible shift in v6) |
| 2    | Phase 2 | Service extraction, no behavior change | No |
| 3    | Phase 3 + Phase 4 | UI cleanup; numerically silent | No |
| 4    | Phase 6 | AST enforcement; passes immediately because PR 3 cleared violations | No |
| 5+   | Phase 7 micro-PRs | One per audited surface | Per-surface as needed |
| (parallel) | Phase 8 | Heuristic sweep; can run alongside any PR | No |

PR descriptions disclose:
- **No partner-visible TOTAL shifts** in v6. The earlier "+2pp Forward
  IRR" and "+€1.8M bookValue" disclosures were retracted in v6 after the
  v5→v6 architectural review confirmed both were heuristic artifacts.
  Forward IRR stays at the engine's truthful number; displayed bookValue
  stays at the same number the engine internally uses for the IRR cost
  basis.
- **PR 3 has partner-visible PER-ROW shifts in PeriodTrace**: equity-from-
  interest displays projected ~€1.80M instead of €0 on Jul-2026 (and
  similar on other periods); previously-invisible rows for OC cures,
  reinv OC diversion, trustee/admin overflow, and incentive fee surface
  when their underlying engine values are non-zero. Totals (Total Equity
  Distribution, Forward IRR, bookValue) are unchanged. PR 3 description
  must enumerate the per-row changes explicitly — see §-1 numeric-shifts
  note.

**Total active engineering**: 14 hours (PRs 1-4) + 9.5-13 hours (PR 5+) +
4-8 hours (Phase 8). Calendar: 2-3 weeks for PRs 1-4; Phase 7 + Phase 8
land over following 2-4 weeks at user discretion.

---

## 7 · Out of scope (deliberately)

- The `inceptionIrr` math itself is correct; this plan moves it, not redesigns.
- `bookValue` formula unchanged; v6 collapses two implementations to one source.
- Harness comparison (`harness.ts`) already correctly placed.
- `optionalRedemption: ReinvEnd+24` wiring (separate concern).
- Resolver-side audits for sign convention regressions on fields other
  than `principalAccountCash` (covered partially by Phase 8 sweep).
- New UI features (different scenario presets, refi modeling, etc.).
- Renaming `principalAccountCash` (deferred indefinitely; signed-vs-forward
  ambiguity dissolved in v6 since `principalAccountCashForward` is deleted
  and `principalAccountCash` keeps one consistent semantic at all three
  call sites).
- "Fixing" the Forward IRR being "too negative" — the engine is correct;
  −11.95% on Euro XV is the truthful answer. If partners expect a different
  number, the conversation is about deal assumptions, not model code.

---

## 8 · How to actually start

1. **Step 0 — Complete §-1 pre-flight gate.** Get user attestation on Q1,
   Q2, Q3. Update plan if any answer differs from default. **No code
   begins until this step is done.**

2. **PR 1 — Phase 1 (~4 h active, 1-2 days calendar).**
   - Add engine fields per §1.1, §1.2, §1.3 (I1), §1.4 (I2). Disambiguating
     comment on line 995. Construct §4.4 synthetic fixture.
     `engine-trustee-tieout.test.ts` with Euro XV snapshot.
   - Pre-merge JSON-serialization audit (Phase 1 work item 6).
   - Extend `debug-q1-waterfall.ts` with inline inception-IRR.
   - Targeted snapshot regen.
   - No stakeholder gate; no numeric shift.

3. **PR 2 — Phase 2 (~2 h active, 1 day calendar).**
   - Extract `inception-irr` to service. Tests including wiped-out case.
     Manual before/after screenshots.
   - One-line cleanup commit on `debug-q1-waterfall.ts` to use the service.

4. **PR 3 — Phase 3 + Phase 4 (~5 h active, 2-3 days calendar).**
   - Helper extraction + PeriodTrace rewrite using §0.75 mapping.
     Acceleration explanatory header. `bookValue` migration with
     wiped-out UX fallback. Helper test + integration test (§4.2).
   - Manual before/after screenshots confirming the bug regression case
     (equity-from-interest = €1.80M, not €0).

5. **PR 4 — Phase 6 (~3 h active, 2 days calendar).**
   - Drop AST enforcement test. CI path-filter gate. CLAUDE.md consistency
     update. PR template per Q3.

6. **PR 5+ — Phase 7 micro-PRs (9.5-13 h total, 1-3 weeks).**
   - One per surface. Chat surface gets dedicated PR with three-check audit.

7. **PR-parallel — Phase 8 (4-8 h, ad-hoc).**
   - Run the heuristic-as-value sweep across `web/lib/clo/**`. File
     dispositions per α / β / γ rubric. Each γ deletion ships as its own
     micro-PR.

**Total**: 14 active engineering hours (PRs 1-4) + 9.5-13 hours (PR 5+) +
4-8 hours (Phase 8). Calendar: 2-3 weeks for PRs 1-4.

The diagnostic script (`web/scripts/debug-q1-waterfall.ts`), the §4.4
synthetic fixture CI tests, and the §4.4 trustee tie-out test are the
regression oracles throughout. The §4.2 integration test is the
regression oracle for the principle itself.
