# CLO Projection Model — Known Issues Ledger

Every PPM mechanic the model doesn't currently simulate, or simulates with documented drift, is listed below. This ledger is the reference for what the model *deliberately does not model* and what drift you should expect when comparing our engine to trustee-reported data.

**Editorial principle (2026-04-30, after correctness-first audit):** This is a financial-model ledger. Every claim about current engine behavior must be traceable to a specific `file:line` that has been read. Magnitudes that are not pinned by an active `failsWithMagnitude` marker are tagged "tentative" or "historical" — never asserted as live drift. **Time and effort estimates are not part of any entry**: the only relevant axes for prioritization are correctness leverage (how many wrong numbers a fix corrects), how silent the current bug is (silent worse than loud), and how downstream invariants depend on it. Whether a fix takes an hour or a week is irrelevant to whether it should land before the next partner-facing number is shown.

Each entry carries:

- **PPM reference** — clause / section / page where the mechanic is specified.
- **Current engine behavior** — exactly what the code does today, with `file:line`.
- **PPM-correct behavior** — what the model would do if the gap were closed.
- **Quantitative magnitude** — pinned euros / bps / pp where a marker exists; tentative or historical context where not.
- **Deferral rationale** — why it's in the ledger rather than fixed (intent, dependency, or "latent — not yet activated by available data").
- **Path to close** — specific code changes + corresponding test. No effort estimate.
- **Test** — forward-pointer(s) to the `failsWithMagnitude` marker(s) asserting the current documented magnitude. Ledger ↔ test is a bijection: when a fix lands, the marker must be removed AND this entry moved to Closed. New KI entries SHIP with their marker test in the same change.

Updated per sprint. Entries are closed by deleting the entry, its index pointer, and its anchor entirely once the corresponding fix ships and is verified in the N1 harness — no `[CLOSED]` marker is left behind. The entry's `failsWithMagnitude` marker test is removed (or its assertion flipped from "documents the bug" to "asserts the fix") in the same change. Codebase rationale that the closed entry used to provide is described directly in code via inline invariant comments (no orphan KI-XX cross-references), so the bijection scan in `web/lib/clo/__tests__/disclosure-bijection.test.ts` flips loud on any stale reference.

---

## Index

Categorized so a partner reading cold can separate "what's still wrong" from "what we decided." Section membership is authoritative; the numerical KI order is historical (sprint-chronological).

### Open — currently wrong, path to close documented
- [KI-08 — Trustee/admin fee split residuals (PARTIAL: pre-fill D3 + cap mechanics C3 + 2026-05-04 PPM verifications cleared; day-count residuals remain blocked on KI-12a)](#ki-08)
- [KI-12a — Senior / sub management fee base discrepancy](#ki-12a) — **BLOCKED ON DATA ACQUISITION** (Q4 2025 historical SDF + trustee-report bundles)

### Latent / Scoped — inactive for Euro XV liability schedule, active only where noted
*Distinct from "Deferred" (those are intentional design choices about mechanics that exist in the indenture but the model elects not to simulate). "Latent" entries are unmodeled or hardcoded paths whose current Euro XV magnitude happens to be zero, but which will produce wrong numbers the moment a deal hits the triggering condition (different deal structure, different PPM, non-zero balance, FX exposure, etc.). Treat each as a real bug whose materiality is data-dependent, not a deliberate scope decision.*

- [KI-36 — Per-tranche `payment_frequency` consumed for liability interest schedule; monthly liability waterfalls remain out of scope](#ki-36)
- [KI-38 — FX / multi-currency cashflows blocked unless same-currency can be proven](#ki-38)
- [KI-45 — Senior Expenses Cap carryforward seed is user-supplied; automatic historical ingest not wired](#ki-45)
- [KI-67 — Active DDTL/revolver ingestion and trustee validation blocked on missing mechanics](#ki-67) — **BLOCKED ON SOURCE DATA / MODELING SUPPORT** (commitment fees, commitment expiry, URRA, draw-event parity)
- [KI-66 — Principal POP backfill conditionality unmodeled (Ares XV path closed; remaining work needs new PPM/event data)](#ki-66) — **BLOCKED ON NEW DATA FOR FULL CLOSURE** (structured Ares XV resolver/engine path shipped 2026-05-07; missing structured principal POP now blocks production resolver paths)

### Deferred — intentionally not modeled, magnitude known
- [KI-03 — Step (V) Effective Date Rating Event redemption](#ki-03)
- [KI-04 — Frequency Switch mid-projection cadence/rate switch (C4 Phase 3)](#ki-04)
- [KI-06 — Defaulted Hedge Termination (step AA)](#ki-06)

### Cascades — residuals that close as upstream closes

*All three cascades below are gated on KI-12a's harness fix, which is **blocked on data acquisition** (Q4 2025 historical SDF + trustee-report bundles). Don't attempt re-baseline or closure work on these until the source data lands; see KI-12a's blocker note for the data-availability gate and `web/CLAUDE.md` § "Source data access" for the path to acquire it.*

- [KI-12b — Day-count precision active; six class-interest markers under harness period mismatch](#ki-12b) — **blocked on KI-12a data**
- [KI-13 — Sub distribution cascade residual](#ki-13) — **blocked on KI-12a data**
- [KI-14 — IC compositional parity at T=0 (cascade)](#ki-14) — **blocked on KI-12a data**

### Tentative — discovered mid-task, verification pending before closure or escalation
- [KI-69 — Section 110 Issuer taxes: closed-form structural model, unmodeled GAAP residual on Euro XV](#ki-69)

### Design decisions — documented for audit clarity (not open issues)
- [KI-19 — NR positions proxied to Caa2 for WARF (Moody's convention)](#ki-19)

*KI-44 (proposed during 2026-04-30 audit, not added): a candidate raised that `parse-collateral.ts:209-210` writes absolute `Market_Value` into the percent-shaped `current_price` column, with the bug masked on Euro XV by Asset Level enrichment. Verified not a bug. Two pieces of evidence: (i) `ENRICHMENT_COLUMNS` at `sdf/ingest.ts:450` lists only `current_price`, not `market_value` — Asset Level cannot overwrite `market_value`; (ii) every fixture row shows `marketValue == currentPrice` (e.g. 80.097, 99.823, 91.797) which is consistent only with `raw.Market_Value` being itself percent-shaped. If `raw.Market_Value` were absolute, the two columns would diverge after enrichment because only `current_price` gets overwritten. Conclusion: `raw.Market_Value` is percent-shaped despite the misleading column name; parser is correct; consumers are correct. Disposition: not added to ledger; no anchor created (any code referencing `KI-44` would be referencing a non-issue and the disclosure-bijection scanner correctly rejects it). A future verification against the SDF spec would close the question definitively.*

---

<a id="ki-03"></a>
### [KI-03] Step (V) Effective Date Rating Event redemption

**PPM reference:** Condition 7.3, p.180.
**Current engine behavior:** Not modeled; engine has no rating-downgrade detection. No `stepTrace.effectiveDateRating` field exists; the N1 harness mapper hardcodes the bucket to 0 (`backtest-harness.ts:367`). `ppm-step-map.ts:126` documents the bucket as "NOT EMITTED by engine (KI-03)".
**PPM-correct behavior:** Triggered by rating agency downgrade during the Effective Period; mandatory redemption.
**Quantitative magnitude:** Euro XV is past Effective Date (closed Dec 2022); step is permanently inactive for this deal.
**Deferral rationale:** Inactive for every deal that makes it past the Effective Date ramp. For deals in-ramp only.
**Path to close:** Out of scope unless we model pre-Effective-Date CLOs.
**Test:** No active marker — permanently inactive for Euro XV. The `effectiveDateRating` row in the N1 harness table passes (both sides 0).

---

<a id="ki-04"></a>
### [KI-04] Frequency Switch mid-projection cadence/rate switch (C4 Phase 3)

**PPM reference:** Condition 1 (Frequency Switch Event), pp.127–128.
**Current engine behavior:** Trigger evaluation modeled in C4 Phase 2 (once it ships); warning fires if both (b) concentration and (c) interest-shortfall conditions cross their thresholds. Manual post-switch what-if support is not currently wired into the projection engine. **Automatic mid-projection cadence/rate switching is not modeled.**
**PPM-correct behavior:** On trigger, switch quarterly → semi-annual payment dates, 3M → 6M EURIBOR, Issuer Profit €250 → €500. One-time and irreversible.
**Quantitative magnitude:** Euro XV's liability tranches are quarterly, so the liability-cadence impact is zero on the current fixture. The current asset fixture contains monthly, two-month, quarterly, and semi-annual loan payment-frequency fields; recognized anchored asset schedules are now modeled as loan-level interest receivable timing. Automatic Frequency Switch remains theoretical for this deal unless the switch trigger is hit by a structural pool change.
**Deferral rationale:** Engine rework to support variable periods-per-year mid-simulation (day-count, period calendar, OC/IC cadence, DDTL timing, call quantization). Rarely-hit scenario, but closure still requires actual post-switch engine behavior rather than a documentation-only assumption.

**Blocked-on-new-data boundary:** KI-04 closure needs either (a) a fixture/deal where the Frequency Switch Event actually fires, including the post-switch payment-date/rate/issuer-profit treatment, or (b) a partner-approved synthetic fixture encoding those post-switch economics. Without that data, the engine can only preserve the current quarterly Euro XV behavior and the documented warning path; it cannot validate the switched calendar against trustee or PPM cash-routing evidence.

**Cadence-coupled hardcodings that MUST be touched together when this lands** — independent enumerations of "periods per year = 4" sites that are correct under quarterly cadence and silently wrong under semi-annual:

- **Automatic cadence switching still open:** T=0 IC and in-period liability interest now use actual day-count/payment-window scheduled due amounts. Remaining KI-04 work is switching the whole deal calendar/rate/issuer-profit regime after a Frequency Switch trigger, not the old `/4` T=0 shortcut.
- **Incentive-fee circular solver — closed for date annualization in KI-36 follow-up:** normal-mode and post-acceleration incentive-fee gates now call the date-aware solver with the actual emitted payment dates. The legacy periodic `resolveIncentiveFee(..., periodsPerYear)` remains only as a compatibility helper for direct unit tests and non-engine callers. Remaining KI-04 work is cadence switching itself, not IRR annualization of the already-emitted cash-flow dates.

These were originally tracked as "A10" and "A11" in the 2026-04-30 audit. They are sub-items of KI-04, not separate KIs — but they must be enumerated explicitly because closing KI-04 by only fixing the trigger detection without touching these sites leaves silent residual bugs that would not be caught by the trigger-detection test alone.

**Path to close:** Trigger: a deal where the trigger actually fires, or a partner request. The fix sequence is (a) carry a per-projection `cadence: "quarterly" | "semiAnnual"` value as input, (b) implement automatic switch detection on (b) concentration + (c) interest-shortfall conditions, (c) switch payment dates, reference rate tenor, and issuer profit on the triggered schedule, (d) re-run the N1 harness on a pre-switch fixture and a post-switch synthetic to confirm.

**Test:** No active marker — trigger does not fire on Euro XV. Future deals that trip the trigger would surface as a cadence mismatch in the N1 harness period-count row. Existing KI-36 tests cover semi-annual tranche scheduled due/skip behavior. Existing projection tests cover date-aware incentive-fee annualization. KI-04 closure still needs a post-switch synthetic that changes the emitted deal payment-date calendar and rate/issuer-profit regime.

---

<a id="ki-06"></a>
### [KI-06] Defaulted Hedge Termination (step AA)

**PPM reference:** Condition 3.3(a).
**Current engine behavior:** Modeled as 0 by the N1 harness mapper (`backtest-harness.ts:368`); `ppm-step-map.ts:131` documents the bucket as "NOT EMITTED by engine (KI-06)". Non-defaulted hedge payments flow through step (F) (`stepTrace.hedgePaymentPaid`, declared at `projection.ts:596`, emitted in both normal-mode (`:4888`) and post-acceleration (`:3998`) paths).
**PPM-correct behavior:** Activates if a hedge counterparty defaults; termination payments flow through accelerated position in step (AA).
**Quantitative magnitude:** 0 in current data; activates only in hedge-counterparty-default scenarios (rare).
**Deferral rationale:** Contingent on counterparty default; model would need hedge-counterparty state which the upstream data pipeline doesn't track.
**Path to close:** Out of scope without hedge counterparty data pipeline.
**Test:** No active marker — activates only on counterparty default. `defaultedHedgeTermination` in the N1 harness table (Infinity tolerance) surfaces the magnitude if it ever triggers.

---

<a id="ki-08"></a>
### [KI-08] Trustee/admin fee split residuals — **PARTIALLY CLOSED (pre-fill D3 + cap mechanics C3 + 2026-05-04 PPM verifications)**

**Status (2026-05-04, PPM verifications + cap-completion shipped):** Mechanics shipped + four PPM design assumptions verified against Ares European CLO XV Offering Circular pp. 150-151 (Condition 1 "Senior Expenses Cap") + pp. 159-161 (Pre-Acceleration POP steps B/C/Y/Z). All four assumptions were CONTRADICTED and the engine has been amended to PPM-correct behavior. Four additional structural cap defects surfaced during the verification (component (a) mixed day-count, CPA-vs-APB cap base, 3-period rolling carryforward, VAT inclusion) all closed in the same PR — engine now dispatches on `seniorExpensesCapComponentADayCount`, `seniorExpensesCapBaseMode`, `seniorExpensesCapCarryforwardPeriods`, and `seniorExpensesCapVatRatePct`. Only the KI-08 day-count residuals remain open (gated on KI-12a data).

**What shipped:**

1. **Pre-fill (D3, Sprint 2; superseded 2026-05-16)**: `defaultsFromResolved` originally back-derived `trusteeFeeBps` AND `adminFeeBps` (and `taxesBps` / `issuerProfitAmount` / `hedgeCostBps`) from Q1 waterfall step amounts. Euro XV examples: 0.0969 bps trustee from Step B, 5.147 bps admin from Step C, 0.497 bps taxes from Step A(i), €250 profit from Step A(ii). **All five back-derives were removed in 2026-05-16** after the silent-paid-to-forward-rate pattern was identified (single-quarter extrapolation, cap-binding distortion, lumpy items — a single quarter's paid amount cannot serve as the contractual forward rate for the life of the deal). Observed step amounts are now surfaced as non-blocking INFO suggestion warnings via `diagnoseFeePrefill` carrying `suggestedValue` and `resolvedFrom` for the `EngineExpensesPanel`'s "Use suggested" affordance — explicit user acceptance, not silent inference. Blocking gates by surface: (i) resolver-time `resolver.ts ~1715` (trustee, admin) fire when a fee row is present in `constraints.fees` with rate "per agreement"; the C3 split at `resolver.ts ~1661` resolves trustee and admin into separate `ResolvedFees.trusteeFeeBps` / `adminFeeBps` fields. (ii) resolver-time `resolveAssumptionGates` (taxes, issuer profit) fire when the PPM waterfall narrative mentions taxes / Issuer Profit Amount. (iii) build-time `composeBuildWarnings` (hedge) fires when raw `waterfallSteps` shows a hedge-labeled Step F with positive amountPaid but neither `resolved.hedgeCostBps` nor the user assumption is positive — hedge evidence lives in raw, not constraints, so the gate must run at build time with `raw` threaded through `buildFromResolved`'s new optional 4th parameter.
2. **Cap + overflow (C3, Sprint 3)**: `ProjectionInputs.adminFeeBps` + `ProjectionInputs.seniorExpensesCapBps` added. Engine emits trustee + admin fees jointly capped at the per-period cap; overflow routes to PPM steps (Y) trustee-overflow and (Z) admin-overflow, paying from residual interest after tranche interest + sub mgmt fee.
3. **PPM verifications (this PR, 2026-05-04)**:
   - Cap value structure ({a} €300K/yr fixed + {b} 2.5 bps × CPA per OC pp. 150-151) wired through new `ResolvedSeniorExpensesCap` interface on `ResolvedDealData` + new `ProjectionInputs.seniorExpensesCapAbsoluteFloorPerYear` field. Replaces the unstructured 20-bps-only fallback.
   - `max(2× observed, 20 bps)` heuristic in `defaultsFromResolved` removed; the cap value now comes from PPM via `resolved.seniorExpensesCap.bpsPerYear` per project rule (silent fallbacks on missing computational extraction are bugs).
   - B/C in-cap allocation switched from pro-rata to sequential B-first per OC Condition 3(c)(C) ("less any amounts paid pursuant to paragraph (B) above"). Engine block at `projection.ts:3703` dispatches on `seniorExpensesCapAllocationWithinCap`.
   - Y/Z overflow allocation switched from pro-rata to sequential Y-first per POP convention. Engine block at `projection.ts:4715` dispatches on `seniorExpensesCapOverflowAllocation`.
   - Resolver emits `severity: "error", blocking: true` when a deal has fee rows but no PPM cap extracted.

**Partner-visible behavior on Euro XV**: observed combined ~5.24 bps well below the PPM cap (~5.43 bps composite at €107K/quarter on €493M beginPar × 91/360 day-count, vs observed €64K/quarter) → no overflow fires, N1 harness bit-identical pre/post the 2026-05-04 amendments in aggregate. The N1 harness now reads the split buckets directly: `trusteeFeesPaid` is PPM step (B) and `adminFeesPaid` is PPM step (C). Their remaining drifts are the small split day-count residuals below (91/360 engine vs 90/360 trustee), not a bundled B+C gap. Stress scenarios with observed > cap now produce sequential B-first / Y-first per PPM.

**Tests (7 new C3 tests):**
- `c3-senior-expenses-cap.test.ts` — base case (no overflow), high-fee overflow (50 bps + 20 bps cap → 30 bps overflow), extreme cap (1 bps), overflow-limited-by-residual, backward-compatibility (undefined cap = unbounded).
- `d3-defaults-from-resolved.test.ts` — post-2026-05-16: asserts the back-derive is GONE (`defaultsFromResolved` leaves `trusteeFeeBps` + `adminFeeBps` + `taxesBps` + `issuerProfitAmount` at DEFAULT_ASSUMPTIONS unless resolver extracted positive values); asserts `diagnoseFeePrefill` emits one INFO suggestion per observed waterfall step with `suggestedValue` populated; asserts `composeBuildWarnings` un-blocks each gate symmetrically when the corresponding user assumption is set positive.
- `b2-post-acceleration.test.ts` — under acceleration (PPM 10(b)) trustee + admin pay uncapped; regression guard asserts `stepTrace.adminFeesPaid / trusteeOnly = adminFeeBps / trusteeFeeBps` exactly.

**Day-count residual markers (registered via `failsWithMagnitude`, close with KI-12a harness fix):**
- `n1-correctness.test.ts > KI-08-dayCountResidual-trustee` — `expectedDrift: 13, tolerance: 5`.
- `n1-correctness.test.ts > KI-08-dayCountResidual-admin` — `expectedDrift: 709, tolerance: 50`.

Both markers track the 91/360-vs-90/360 day-count residual exposed by the harness period mismatch (sibling mechanism to the six KI-12b class-interest markers); they re-baseline or remove together when KI-12a lands.

**Blocked on KI-12a data acquisition (added 2026-05-02).** Closure of these two day-count residual markers (the only KI-08 sub-component still moving) waits on KI-12a's harness fix, which itself is blocked on re-ingesting Q4 2025 (or earlier) historical SDF + trustee-report bundles for Euro XV — see [KI-12a's blocker note](#ki-12a). Don't attempt closure work on these markers until that data lands.

**Cascade re-baselines**: KI-13a adjusted when the fee model split PPM step (B) trustee from step (C) admin while preserving aggregate cash behavior. Current N1 bucket semantics are unaggregated for the ordinary fee steps (`trusteeFeesPaid` = B, `adminFeesPaid` = C); overflow fields remain separate diagnostics for stressed cases. Any future fee-bucket change must re-run the KI-13a total residual marker and the KI-13a bridge marker because the residual is downstream of both fee rows.

**Ledger disposition**: remain OPEN (partial) until the day-count residual markers close (gated on KI-12a data acquisition).

---

<a id="ki-12a"></a>
### [KI-12a] N1 harness period mismatch — engine Q2 projection vs trustee Q1 actual

**Blocked on data acquisition (added 2026-05-02).** Closure requires re-ingesting at least one prior reporting cycle (Q4 2025, payment date Jan 15 2026) into the database — full SDF bundle (all `SDF *.csv` files) plus the BNY trustee monthly report and note valuation PDFs. **Neither the DB nor `~/Downloads/ARESXV_CDSDF_*` has these.** Verified 2026-05-02: `clo_report_periods` carries 17 historical rows for Euro XV, but only the latest (Q1 2026, `b064df0b-9c12-4624-9d1c-ca776bfaf600`) has full per-period ingest; all 16 prior periods carry only the Intex past-cashflows backfill (`clo_tranche_snapshots` rows with `data_source='intex_past_cashflows'`) — no holdings, no pool summary, no compliance tests, no waterfall steps, no account balances. Q1 SDF on disk does NOT carry prior-period state (no "prior period" columns; verified `parse-notes.ts` / `parse-collateral.ts`). Reverse-applying Q1 trade activity from `clo_trades` is not viable — most rows have null `par_amount` and null `trade_type` (they're cashflow events, not buy/sell records). **Don't attempt closure work on KI-12a or its dependents (KI-12b, KI-13, KI-14, KI-08 day-count residuals) until the Q4 2025 source bundle is acquired and ingested.** See `web/CLAUDE.md` § "Source data access (CLO product)" for the data-acquisition guidance.

**Context:** This entry was originally framed as "Senior/sub management fee base discrepancy (attribution pending)" and then narrowed to "fee-base period-timing snapshot error." Independent review flagged that the actual issue is one level up: **the N1 harness is not a Q1 replay at all — it's a Q2 forward projection compared against Q1 trustee data.** The fee drift is the symptom most visible; the cause is structural to the harness.

**Evidence that the harness runs Q2, not Q1:**

- `projection.ts:944` `addQuarters(currentDate, 1)` (period-1 anchor when `stubPeriod` is absent) + `projection.ts:1332` `const periodDate = periodEndDate(q);` (per-period date inside the loop).
- Fixture `resolved.dates.currentDate = 2026-04-01`.
- `addQuarters('2026-04-01', 1) = '2026-07-01'` — period 1 is July, not April.
- `backtest-harness.ts:164` uses `result.periods[0]`; `:231` pulls the trustee `paymentDate` from `backtest` (Apr 15 2026 in the fixture). **These are different quarters.**

**Why the harness still ties on tranche interest but not on fees:**

- Tranche interest: during reinvestment period (`reinvestmentPeriodEnd = 2026-07-14`, still active in Q2) tranche balances are stable and the base rate is pinned from Q1 observed EURIBOR. Engine Q2 interest ≈ trustee Q1 interest coincidentally → Class A/B/C/D/E/F all match within €1 under legit pins.
- Senior/sub mgmt fees: accrue on pool balance. Trustee Q1 fee base = €470,899,177 (cross-verified: senior fee €176,587.19 / (0.15%/4) = €470.9M; sub fee €412,036.78 / (0.35%/4) = €470.9M; agreement within €4). Engine Q2 fee base = current pool snapshot = €493,252,343. Delta **€22,353,166 ≈ €22.35M**. Growth-sensitive field → drifts legitimately.
- Trustee fees, taxes, and issuer profit are now emitted by the engine and tie within tolerance in the current N1 harness. They remain relevant here only as closed/upstream residual components that changed the cascade baseline over time, not as current zero-emission bugs.

**What the €22.35M is NOT:**

| Hypothesis | Fixture evidence | Rejected by |
|---|---|---|
| DDTL unfunded in engine base | €581k total | Magnitude (~38× too small) |
| PIK accrual in base | €2.38M | Magnitude (~9× too small) |
| Defaulted par in base | €0 | Zero defaulted positions in fixture |
| Discount obligations at par | €0 | Zero discount obligations |
| CCC excess at market value | Moody's Caa 6.92 vs 7.5 | Under limit — no haircut triggered |
| Bonds at MV rather than par | Delta €5.1M | Wrong magnitude |
| Loans at MV rather than par | Delta €20.2M (loanPar €440.8M − loanPriceMV €420.6M) | **Not rejected.** Sign is correct (trustee base is lower than engine by ~€22M; MV < par lowers base). Magnitude is €2M shy of the target. Plausibly a component of a combined PPM rule (e.g., some loan sub-bucket carried at MV + the bonds-at-MV delta €5.1M + another haircut). Not the full explanation on its own. |
| **Q1 reinvestment growth** | Gross Q1 trade settlement €5.5M out / €5.3M in; net −€232,893 | **Trade activity ceiling of ~€5M can't produce €22M pool growth.** `parAmount` and `acquisitionDate` both null in fixture, so we can't verify directly, but the cash-flow bound is firm. |

**What the €22.35M MIGHT be — narrowed via PPM grep (2026-04-23):**

`rg -A3 'collateral principal|senior.*fee|management fee' ppm.json` confirms:
- **Fee basis is "Collateral Principal Amount" (CPA)** for both Senior (§E, 0.15% p.a.) and Sub (§X, 0.35% p.a.) management fees — distinct from "Aggregate Principal Balance" (APB, the engine's `beginningPar`) and distinct from "Adjusted Collateral Principal Amount" (ACPA, which §10(a)(iv) uses as the OC numerator: APB of non-defaulted + MV×PB of defaulted + Principal Proceeds in Principal Account on Measurement Date).
- **Day-count is Actual/360 (floating), 30/360 (fixed).** PPM's own worked example: `2.96600% × 310M × 90/360 = €2,298,650` ties out to 15-Apr-2026 Class A Interest exactly. Confirms engine's /4 is identical to PPM's 90/360 on this specific 90-day quarter.
- **Condition 1 definition of CPA is NOT transcribed** in `ppm.json`; it lives on PDF pp. 390–397. Final narrowing of KI-12a requires reading those pages of the source PDF (`Ares CLO XV - Final Offering Circular dated 14 December 2021.pdf`).

**Candidates that remain after this narrowing:**
- Loan-at-MV + bond-at-MV combined haircut rule (evidence table row 7: €20.2M + €5.1M overshoots to €25.3M, but a specific sub-bucket applied at MV could land at €22.35M)
- Mid-period balance-weighted average rather than a snapshot
- A specific Condition 1 CPA-exclusion class applied to a subset of holdings (cov-lite? specific industry? deferred interest obligations?) that sums to ~€22.35M

**Day-count is NOT the cause on Q1 2026:** Accrual window Jan 15 → Apr 15 = 31+28+31 = 90 days; Actual/360 = 90/360 = 1/4 — identical to engine's periods-per-year proxy. Day-count drift on non-90-day periods is tracked separately as KI-12b.

**Under interpretation B, the scope widens:** Any N1 bucket that depends on pool balance at time T has the same structural mismatch. Fields to re-audit after the harness fix:
- `trusteeFeesPaid` / `adminFeesPaid` (KI-08) — the old €64,660 bundled drift was closed by trustee/admin pre-fill and split bucket emission. The only live KI-08 markers are the split day-count residuals: ~€13 on trustee step (B) and ~€709 on admin step (C), both period-mismatch-contaminated and removed or re-baselined with KI-12a.
- `subDistribution` cascade — residual of everything above. Period-mismatch drift sits underneath every component drift.
- `initialState.ocTests` (passes ~0.01%): OC matches because trustee OC and engine initialState both anchor on the Q1 Determination Date balance (~= current fixture snapshot); the fee clause anchors on the prior Determination Date. Different mechanics, same report.

**Path to close — harness-level, not engine-level:**

The engine is probably not wrong about Q2; the harness is pretending Q2 is Q1. Two fixes, either works:

- (a) **Rebuild the fixture at the prior Determination Date (Q4 2025).** `periods[0]` then replays Q1 2026 and the harness comparison becomes semantically valid. Blast radius: one re-extraction; changes every current drift magnitude (re-baseline all markers). **Recommended.**
- (b) **Add an engine "rewind" step** that backs Q1 activity out of the fixture to reconstruct Q4 2025 state, then runs `periods[0]` from there. Heavier (needs reverse-apply of reinvestment, amortization, payment), and the rewind itself carries approximation error.
- Either fix obsoletes the current per-bucket KI-12a drift magnitudes. Post-fix, the residual fee drift is whatever TRULY remains — and *that* is what should carry a per-bucket KI entry if it's non-zero.

Not closed by Sprint 1 / B3 (day-count) or Sprint 3 / C3 (fee pre-fill). Structural harness work covering fixture re-extraction at the prior Determination Date AND re-baseline of every cascade marker (KI-12b classA-F, KI-13a, KI-IC-AB/C/D) — both must land in the same change to keep the bijection consistent.

**Test:** `n1-correctness.test.ts > "currently broken buckets" > seniorMgmtFeePaid | subMgmtFeePaid` — two `failsWithMagnitude` markers (ki: `KI-12a-seniorMgmt`, `KI-12a-subMgmt`). These markers currently measure *harness period-mismatch drift*, not engine fee-base error. When the harness fix ships, both markers must be re-baselined (likely to near-zero) or removed and replaced with correctness assertions on the residual post-fix drift.

**Scope note (B2 accelerated mode):** KI-12a's fee-base discrepancy applies in BOTH normal and accelerated-waterfall modes. B2's accelerated executor receives `trusteeFeeAmount`, `seniorFeeAmount`, `hedgeCostAmount` computed via the same `beginningPar * rate * dayFrac` formula as normal mode — it inherits the same fee-base gap. A partner who digs into a stress-scenario demo will see senior-expense numbers that carry the same ~€27K/quarter drift from PPM-exact as normal mode. The fix for KI-12a (harness fixture regeneration at prior Determination Date, or multi-period historical harness) closes the gap in both modes simultaneously.

---

<a id="ki-12b"></a>
### [KI-12b] Day-count precision active; surfacing KI-12a period mismatch on 6 class-interest buckets

**Blocked on KI-12a data acquisition (added 2026-05-02).** All six class-interest markers close (or re-baseline) in lockstep with KI-12a's harness fix, which is blocked on re-ingesting Q4 2025 historical SDF + trustee-report bundles. See [KI-12a's blocker note](#ki-12a). Don't attempt closure here; nothing in this entry moves until KI-12a's data lands.

**Status (2026-04-23 update):** B3 shipped. `dayCountFraction` helper + per-tranche convention (Actual/360 float, 30/360 fixed) replaced the legacy `/4` everywhere in the period loop. First-principles arithmetic tests (`b3-day-count.test.ts`, 11 cases) anchor the helper to PPM worked example `2.966% × 310M × 90/360 = €2,298,650`.

**What KI-12b now represents:** residual drift on the harness's six class-interest buckets caused by the KI-12a period mismatch becoming arithmetically visible. Pre-B3, the `/4 = 90/360` coincidence masked this — engine Q2 (91 days) and trustee Q1 (90 days) produced identical tranche coupons under /4. Post-B3, engine Q2 accrues Actual/360 on 91 days and diverges from trustee's 90-day window by one day of interest per tranche.

**PPM reference:** Condition 1 — "Day count (Actual/360 float, 30/360 fixed)"; confirmed via `ppm.json` grep and PPM worked example (see KI-12a).
**Current engine behavior:** B3 landed. The engine reads `loan.dayCountConvention` and `tranche.dayCountConvention` (canonicalized to one of `actual_360 | 30_360 | 30e_360 | actual_365`) and dispatches via `dayCountFraction(convention, periodStart, periodEnd)`. Per-period cache `dayFracByConvention` precomputes all four. `trancheDayFrac(t)` returns `dayFracByConvention[t.dayCountConvention]` when set, else falls back to `t.isFloating ? actual_360 : 30_360` for legacy synthetic inputs without an explicit convention. Loan-side per-position accrual at the interest-collection site uses the same dispatch. Management / trustee / hedge fees remain on Actual/360 per Condition 1 (deal-level, not per-position).
**PPM-correct behavior:** Per-tranche / per-loan day-count convention + actual days in the period. Applies across every interest-denominated step (tranche coupons, loan accrual, management fees, hedge legs).

**Quantitative magnitude — the B3 / KI-12a interaction (new in 2026-04-23 review):**

The Class A/B/C/D/E/F interest tie-outs currently pass at |drift| < €1 under legit pins in `n1-correctness.test.ts`. That's a **coincidence that B3 will break**, because:

- Under interpretation B (see KI-12a), engine's period 1 is **Q2 2026 = Apr 1 → Jul 1 = 91 days** (30+31+30). With `currentDate = 2026-04-01` and `addQuarters(currentDate, 1) = 2026-07-01`, the boundary anchors at Apr 1 / Jul 1, not Apr 15 / Jul 15. Day-count holds at 91 by coincidence (30+31+30 either way).
- Trustee Q1 2026 is **Jan 15 → Apr 15 = 90 days** (31+28+31, cross-verified with PPM worked example `× 90/360`).
- Engine's current `/4 = 0.25` coincidentally equals trustee's `90/360 = 0.25` exactly → Q2 engine interest = Q1 trustee interest on the same pinned rate and balance.
- **When B3 replaces `/4` with actual-days/360, engine period 1 becomes `91/360 = 0.2528`**, breaking the coincidence. The drift per class is (class_balance × class_rate × 1/360). Q1 rates and ending balances give approximate one-day drifts:

  | Class | Balance (€) | Rate (≈) | +Δ under B3 (€) |
  |---|---|---|---|
  | A | 310M | 2.97% | 25,575 |
  | B (B-1 + B-2) | 45M | 3.44% | 4,300 |
  | C | 32.5M | 4.12% | 3,720 |
  | D | 34.4M | 5.16% | 4,930 |
  | E | 25.6M | 8.13% | 5,780 |
  | F | 15M | 10.87% | 4,530 |
  | **Total** | | | **≈ €48,800 / period** |

  Class A alone contributes ~52% of the total; treating it as "~€25K per class" overstates the picture.
- This drift is NOT an engine regression — it's the harness period mismatch (KI-12a) finally bleeding through the arithmetic once the `/4 = 90/360` coincidence is gone.

**Sprint 1 sequencing (historical note):** Pre-ship analysis anticipated that shipping B3 before KI-12a would produce a spurious "Sprint 1 broke six tests" signal. That prediction was correct — and the six `failsWithMagnitude` markers below formalize the drift so it's documented rather than flagged as regression.

**Empirical magnitudes (measured against Euro XV fixture, legit-pinned, post-B3 engine):**

| Class | Post-B3 drift (€) | Formula check |
|---|---|---|
| A | +25,540.56 | 310M × 2.966% × 1/360 ≈ €25,545 ✓ |
| B (B-1 + B-2) | +3,483.75 | 45M × (avg 3.44%) × 1/360 ≈ €4,300 (B-2 is fixed 30/360 = 0, so only B-1 floating contributes; hence lower than the combined estimate) |
| C | +3,715.83 | 32.5M × (avg 4.12%) × 1/360 ≈ €3,720 ✓ |
| D | +4,932.81 | 34.375M × (avg 5.17%) × 1/360 ≈ €4,940 ✓ |
| E | +5,784.13 | 25.625M × (avg 8.13%) × 1/360 ≈ €5,790 ✓ |
| F | +4,527.50 | 15M × (avg 10.87%) × 1/360 ≈ €4,530 ✓ |
| **Total** | **+€47,984.68** | Within 2% of the pre-ship prediction (~€48.8K) |

**Cascade impact:** KI-13a-engineMath re-baselined from −€607.93 (pre-B3) to +€20,841.63 (post-B3) — sign flipped because the six positive KI-12b drifts + KI-12a fee drifts (~€35K) outweigh the negative KI-08/09/01 drifts (−€71K). Textbook example of reviewer's warning that cascade signs can flip mid-close.

**Path to close:** All six markers remove together when KI-12a (harness period mismatch) lands — either a Q4 2025 fixture that makes `periods[0]` a Q1 replay, or multi-period historical backtest.

**Test:** `n1-correctness.test.ts > "currently broken buckets"` — six `failsWithMagnitude` markers:
- `KI-12b-classA` (+€25,540.56 ± €50)
- `KI-12b-classB` (+€3,483.75 ± €50)
- `KI-12b-classC` (+€3,715.83 ± €50)
- `KI-12b-classD` (+€4,932.81 ± €50)
- `KI-12b-classE` (+€5,784.13 ± €50)
- `KI-12b-classF` (+€4,527.50 ± €50)

---

<a id="ki-13"></a>
### [KI-13] Sub distribution cascade residual

**Blocked on KI-12a data acquisition (added 2026-05-02).** This residual moves as upstream KIs close and as the asset-cash timing model becomes more faithful. The largest open upstream — KI-12a — is blocked on re-ingesting Q4 2025 historical SDF + trustee-report bundles; see [KI-12a's blocker note](#ki-12a). Re-baselining both KI-13a markers is expected when upstream fee/day-count components or scheduled asset-cash treatment changes.

**PPM reference:** Step (DD) — residual to sub (equity) note.
**Current engine behavior:** `subDistribution` is the residual bucket; every upstream drift (taxes, trustee fee, mgmt fees, fee-base) cascades into it. Direction depends on the net sign of those drifts.
**PPM-correct behavior:** N/A — this is a cascade, not an independent mechanic. Closes automatically as upstream KIs close.
**Quantitative magnitude:**
- Engine-math total residual (legit pins, post same-tick defaulted-share asset-interest writeoff re-baseline): **−€254,223.24/quarter** (±€100 tolerance). Counter-intuitive negative sign: KI-12b class-interest day-count drifts (+€48,019) + KI-12a fee-base day-count drifts (+€34,792) + current trustee/admin/tax/issuer-profit residual components, shifted further by per-loan day-count fixture propagation, KI-36 monthly internal timing, scheduled asset cash receipts, duplicate-accrual asset-schedule consistency review, holding-level accrualEndDate anchor recovery, inferred opening asset-interest receivable from prior scheduled payment dates, and same-tick defaulted-share asset-interest writeoff. Multiple drifts compound or cancel; the sign is not a stable indicator. Current total is verified live by N1 harness (`subDistribution | dd | ... delta -254223.24`); asset cash timing is separately pinned by `fixture-regeneration.test.ts` on `interestCollected`, `endingAssetInterestReceivable`, and the non-blocking asset-schedule warning inventory.
- Engine-math bridge residual after modeled upstream interest-waterfall drift: **−€170,655.81/quarter** (±€100 tolerance). This second KI-13a marker intentionally uses the same KI id because it is not a separate issue; it pins the residual bridge after summing emitted upstream outflow drift buckets. It catches stale cascade re-baselines where `subDistribution.expectedDrift` moves but the modeled upstream bridge is not reviewed.
- Production path (no pins): historically reported as +€617,122/quarter. **No `KI-13b-productionPath` marker currently exists in the codebase** (no `n1-production-path.test.ts` file); the +€617K number originated as a one-time measurement and has not been pinned by an active assertion. Either re-instate the production-path harness with a marker, or drop the production-path number from this entry. Until then, treat the +€617K figure as historical context, not as a verified live drift.
**Deferral rationale:** Structural — residual that tracks the sum of upstream corrections.
**Path to close:** Closes progressively as the remaining open upstream fee-base/day-count residuals close, especially KI-12a / KI-12b. No standalone work.
**Test:** `n1-correctness.test.ts > "currently broken buckets"` has two explicit `KI-13a-engineMath` markers:
- `subDistribution total residual matches trustee within €1000` - expectedDrift **−€254,223.24** ± €100.
- `subDistribution upstream bridge residual after modeled waterfall drifts` - expectedDrift **−€170,655.81** ± €100.

The production-path counterpart referenced in prior versions of this entry was never landed; if the production-path drift is judged worth tracking, write a new `n1-production-path.test.ts` and pin a fresh `KI-13b-productionPath` marker before referencing it here. Both `KI-13a-engineMath` expected drifts must be re-baselined (or removed if drift closes) whenever an upstream KI or asset-cash schedule treatment moves.

**⚠ Maintenance checklist** — include in every PR that closes or moves an upstream residual feeding the sub-distribution cascade (currently KI-12a / KI-12b, plus any newly opened N1 bucket residual):
- [ ] Did this PR close or modify an upstream KI's expected drift magnitude?
- [ ] If yes: re-run the harness and update both `KI-13a-engineMath` markers in `n1-correctness.test.ts` (total residual and upstream bridge).
- [ ] If yes and a production-path harness has been re-instated: update `KI-13b-productionPath.expectedDrift` in `n1-production-path.test.ts`; no such file exists today (see entry body).
- [ ] If the cascade drift dropped below tolerance, remove the failsWithMagnitude marker and move KI-13 to Closed.
- [ ] Note: signs can flip during the close sequence — re-check the sign, not just the magnitude.

---

<a id="ki-14"></a>
### [KI-14] IC compositional parity at T=0 (cascade residual)

**Blocked on KI-12a data acquisition (added 2026-05-02).** The remaining IC drift across Classes A/B, C, D is a cascade residual after scheduled asset-cash timing and the current fee/day-count model. It closes progressively when KI-12a and related upstream residuals close, which is blocked on re-ingesting Q4 2025 historical SDF + trustee-report bundles; see [KI-12a's blocker note](#ki-12a).

**PPM reference:** Condition 12 (Interest Coverage Test); §(A)(i), (A)(ii), (B), (C), (E)(1) components in the numerator.
**Current engine behavior:** Engine computes IC at T=0 (`initialState.icTests`) by deducting PPM §(A)(i) taxes, §(B) trustee, §(C) admin, §(E) senior mgmt, §(F) hedge from the scheduled interest base. Under legit pins (production path via `defaultsFromResolved`), the collateral interest base now uses scheduled asset cash receipts through the first projected payment date. Engine IC ratios sit below trustee by the active residual amounts below.
**PPM-correct behavior:** IC numerator includes the full set of §(A)–§(F) deductions correctly attributed.
**Quantitative magnitude (post asset-interest schedule re-baseline, Q1 2026):**
  - Class A/B: −5.660 pp drift
  - Class C: −5.050 pp drift
  - Class D: −4.400 pp drift
**Deferral rationale:** Cascade — not an independent formula bug. The IC parity test exists because the component cash-flow checks in n1-correctness don't exercise the aggregation/denominator logic of the IC formula itself; a mis-aggregation would slip through.

**Important — test input path correctness (fixed Sprint 3):** The prior test setup spread `DEFAULT_ASSUMPTIONS` with `taxesBps: 0, adminFeeBps: 0, trusteeFeeBps: 0`, meaning the markers could not move when KI-08 admin or KI-09 taxes closed (the input path zeroed the very fields those closures would add to the numerator). Swapped to `defaultsFromResolved(fixture.resolved, fixture.raw)` — the production path used by `ProjectionModel.tsx` — so the cascade actually cascades. Closure of admin/taxes then shifted the observed drift by the expected ~2-3 pp per class, confirming both the fix and the cascade wiring.
**Path to close:** Closes progressively as KI-12a and related upstream fee-base/day-count residuals close. No standalone work.
**Test:** `backtest-harness.test.ts > "N6 harness" > Class A/B|C|D IC compositional parity at T=0` — three `failsWithMagnitude` markers (`KI-IC-AB`, `KI-IC-C`, `KI-IC-D`), tolerance 0.05pp. Every PR closing an upstream KI must re-run the harness and update these three `expectedDrift` values.

---

<a id="ki-19"></a>
### [KI-19] NR positions proxied to Caa2 for WARF — Moody's CLO methodology convention

**Moody's methodology reference:** "Moody's Global Approach to Rating Collateralized Loan Obligations" / CLO rating methodology: **unrated positions are treated as Caa2 (WARF=6500) unless the manager has obtained and documented a shadow rating on the position.** This is the conservative default — it prevents NR-heavy portfolios from understating expected credit risk.

**Current engine behavior (Sprint 3):** `BUCKET_WARF_FALLBACK.NR = 6500` (Caa2). An earlier design considered a B2 midpoint (2720, non-investment-grade proxy) but was rejected because it understates WARF drift under NR-concentrated reinvestment scenarios, which materially affects C1's WARF enforcement (a reinvestment at "NR" would appear to improve WARF when Moody's would treat it as worsening).

**PPM-correct behavior:** Matches current engine (Caa2 = 6500). Decision documented for audit clarity; not an open item.

**Quantitative magnitude:** On Euro XV (12 NR positions, ~2.8% of par), NR=6500 vs NR=2720 shifts T=0 engine WARF by ~100 WARF points. That's material relative to the 113-point trigger cushion (3148 vs 3035). Engine-trustee WARF parity is tighter under the 6500 convention.

**Decision status:** CLOSED — 6500 convention shipped Sprint 3. Tracked here so a future reviewer sees the rationale (B2=2720 would have been a partner-visible under-enforcement).

**Alternative considered:** Make NR fallback a user input so the partner can override (e.g., when managers have obtained shadow ratings). Not done in Sprint 3 — adds UI surface without clear demand. Revisit if a deal ships NR loans with documented shadow ratings.

**Test:** `c2-quality-forward-projection.test.ts > "every period has a qualityMetrics object with finite numbers"` covers the path. Explicit NR-convention test could be added when a fixture with meaningful NR concentration arrives.

---

<a id="ki-36"></a>
### [KI-36] Per-tranche `payment_frequency` consumed for liability interest schedule; monthly liabilities remain out of scope

**PPM reference:** Per-tranche indenture term. Each tranche's payment frequency (Quarterly / Semi-Annual / Monthly) is PPM-specified per class.

**Current engine behavior:** KI-36 v1 is implemented for liability tranche interest scheduling on emitted deal payment dates. SDF/JSON/PPM values normalize to `monthly | quarterly | semi_annual`, thread through `ResolvedTranche` and `ProjectionInputs.tranches[]`, and are consumed by the engine. Quarterly tranches pay every emitted payment row; semi-annual tranches accrue through skipped quarterly rows and are due on aligned semi-annual payment dates and final maturity/call payment dates. Unsupported or missing interest-bearing tranche frequency blocks loudly for interest-bearing tranches, including direct hand-constructed `ProjectionInputs`. Monthly liability tranches are intentionally blocked because the engine does not yet model monthly deal waterfall cash routing.

**PPM-correct behavior:** Each tranche carries its PPM-specified payment frequency; the engine accrues interest continuously and makes current interest due only on that tranche's scheduled payment dates. If a deal itself pays monthly, waterfall rows and account routing must also be monthly.

**Quantitative magnitude:** Zero on Euro XV liability-tranche frequency because all Euro XV liability tranches are quarterly. The monthly internal asset/accrual clock is active and contributes to the KI-13 sub-distribution cascade; that live N1 residual is tracked under KI-13, not as a liability-frequency mismatch. Semi-annual and mixed quarterly/semi-annual liability structures are covered by synthetic tests. Monthly liability structures remain blocked rather than silently modeled as quarterly.

**Deferral rationale:** Remaining open scope is not the tranche frequency field itself; it is monthly deal waterfall routing. Exact monthly liability cash routing requires deal-level monthly payment dates/account routing review. Asset interest receipt scheduling is now modeled at loan level when the resolver has complete, non-contradictory interval + anchor evidence; incomplete asset schedule evidence remains compatibility mode.

**Blocked-on-new-data/model boundary:**
- **Monthly liability waterfalls:** requires a deal/PPM section with monthly liability payment dates and the exact account-routing language for cash accumulated between monthly payment dates. KI-36 v1 blocks monthly liability tranches rather than guessing how quarterly-reporting rows should route monthly payments.
- **Asset per-loan payment schedules:** implemented for recognized 1-, 2-, 3-, and 6-month intervals when a valid next payment anchor is present. Scheduled loans accrue to a loan-level receivable and release cash on borrower payment/payoff dates; missing, invalid, unsupported, or contradictory schedule evidence stays compatibility mode or blocks as appropriate.
- **DDTL exact draw date under stub periods:** `drawQuarter` remains a coarse user assumption and maps to the first monthly tick of that projected quarter. Exact stub-period draw behavior needs an explicit draw month/date input or trustee draw-event data; the engine should not infer a real draw date from a quarter-only assumption.
- **Exact account yield:** opening account cash currently earns the engine's existing money-market proxy. Exact account yield would require account-level rate/source fields by account and currency; no such projection input is available today.
- **Tranche frequency provenance:** closed for fresh ingestion. Reingest writes raw/canonical/source columns for liability payment frequency and the resolver treats trustee/SDF frequency evidence as stronger than PPM-synced DB frequency. Older rows should be rebuilt by reingest rather than interpreted without provenance.
- **Legacy direct inputs:** hand-constructed `ProjectionInputs` must now state interest-bearing tranche `paymentFrequency` explicitly; older synthetic fixtures were updated to use explicit quarterly frequency.

**Path to close:**
1. Add deal-level monthly waterfall row generation and account routing once a monthly liability deal/PPM route is reviewed.
2. Extend asset scheduling only if future source data supports additional intervals or explicit amortization calendars.
3. Keep KI-04 separate for automatic Frequency Switch deal-calendar changes.

**Test:** `ki36-payment-frequency.test.ts` covers normalization, fail-closed unsupported/missing/monthly cases, semi-annual due/skip/shortfall behavior, mixed quarterly + semi-annual tranches, monthly internal default/prepay/recovery timing, and the compatibility grid for the current all-quarterly Euro XV harness.

---

<a id="ki-38"></a>
### [KI-38] FX / multi-currency cashflows blocked unless same-currency can be proven

**PPM reference:** Multi-currency CLO mechanics (USD/EUR/GBP cross-currency hedges, FX revaluation on holdings denominated in non-deal currency).

**Current engine behavior:** The resolver preserves deal currency and loan currency (`currency` / `nativeCurrency`) and canonicalizes common EUR/USD/GBP aliases. Production projection build gates now fail closed when:

- deal currency is missing while collateral exposure exists,
- positive loan exposure has missing/unrecognized currency,
- loan-level currency differs from deal currency,
- pool-level currency concentration evidence exists but loan-level currencies do not identify the exposure,
- buy-list or switch-analysis candidates lack currency evidence.

`ProjectionInputs.dealCurrency` is passed into the engine for same-currency metrics, and `runProjection` has a direct-input backstop for missing, unrecognized, incomplete, or mixed currency evidence. No FX rates or hedge cashflows are modeled; non-deal-currency collateral is blocked rather than converted.

**PPM-correct behavior:** A USD-denominated loan in a EUR-denominated deal must be revalued at the prevailing EUR/USD rate each period (typically using the trustee report's reference FX). The deal's hedge legs (if cross-currency) net out the FX exposure at a contracted rate.

**Quantitative magnitude:** Zero on Euro XV when its EUR deal currency and EUR loan currencies are present. Multi-currency deals no longer produce a silently wrong projection; they block until FX conversion and hedge mechanics are implemented. On a European deal with a USD sleeve (~5-10% of par typical in some structures), the unimplemented model would otherwise over- or under-state pool par by EUR/USD drift × USD share, easily a partner-visible swing during FX volatility.

**Deferral rationale:** The closed scope here is fail-closed same-currency verification. Full multi-currency support remains a substantial engine + extraction extension: FX rate ingestion, per-loan revaluation, hedge-leg cashflows, and currency-bucketed concentration modeling.

**Blocked-on-new-data/model boundary:**
- **Legacy buy-list rows without candidate currency:** remain blocked until the candidate currency is supplied or the buy list is re-uploaded with a currency column. The migration intentionally does not infer candidate currency from deal currency.
- **Non-deal-currency collateral or switch candidates:** require FX rates and hedge cashflow modeling before projection can run.
- **Currency provenance:** closed for fresh ingestion. SDF, JSON compliance, PPM/PDF sync, buy-list uploads, and analysis/switch forms write raw/canonical/source currency fields. Older rows should be rebuilt by reingest rather than interpreted without provenance.
- **Stale non-empty deal currency:** fresh reingest is the source of truth for extracted deal/reporting currency and writes provenance beside the canonical value. Manual edits still require product policy before they can override extracted source data.
- **Account-cash currency evidence:** production resolver paths block or infer same-currency account cash from explicit account currency or account-name currency tokens. A fully self-contained direct-engine account-cash backstop would require carrying account-level currency evidence through `ResolvedDealData` / `ProjectionInputs`, not just numeric opening cash.

**Path to close:** Add (a) FX rate ingestion, (b) per-loan native/deal-currency revaluation, (c) cross-currency hedge legs, and (d) currency-bucketed concentration tests once a multi-currency deal is in scope.

**Test:** `incomplete-data-banner-bijection.test.ts` covers missing/foreign/aggregate-evidence blockers and alias canonicalization. `d4-switch-simulator-pool-metrics.test.ts` covers missing buy-leg currency and direct `runProjection` backstop. Full FX tests are still required when multi-currency support is implemented.

---

<a id="ki-45"></a>
### [KI-45] Senior Expenses Cap carryforward seed is user-supplied; automatic historical ingest not wired

**PPM reference:** Condition 1 ("Senior Expenses Cap") proviso (ii), OC pp. 150-151. Each Payment Date's cap is augmented by Σ unused stated-cap headroom from the prior N Payment Dates (Ares XV: 3 pre-FSE).

**Current engine behavior:** The engine supports `ProjectionInputs.seniorExpensesCapCarryforwardSeed?: number[]` and consumes it to seed the FIFO buffer at projection start. Production now exposes `UserAssumptions.seniorExpensesCapCarryforwardSeedAmount: number | null`: `null` means the historical seed is unknown, explicit `0` means the user elects a zero seed, and a positive euro amount is expanded evenly across the active carryforward window before reaching the engine. The q=1 aggregate headroom matches the user input while the synthetic historical buckets age out over future periods. The UI surfaces a non-blocking warning when carryforward is active but the seed is unknown. The remaining gap is automatic derivation: no resolver/context-ingest path currently computes the actual vintage-specific historical seed from prior trustee periods.

**PPM-correct behavior:** The seed is the trailing N entries of `max(0, statedCap_priorPD - cappedPaid_priorPD)` from the deal's most recent N PDs. For Ares XV (carryforward = 3), the seed is the unused headroom from the latest 3 historical PDs. With proper seeding, q=1's cap reflects the deal's actual position in the carryforward window rather than treating the projection as a fresh deal-inception run.

**Quantitative magnitude:** On Euro XV, the seed entry derived from the latest historical period would be ~€120K (stated cap ~€383K vs actual paid ~€263K per period — observed fees ~5.24 bps against a 2.5 bps + €300K floor cap). For a 3-period buffer the seed sum could reach ~€360K at q=1. If left unknown, the model uses a €0 seed. On Euro XV this is trace-only today because fees don't bind the cap; the user-supplied €360K seed raises `period.stepTrace.seniorExpensesCapAmount` but `cappedRequested` remains below both seeded and unseeded caps. Magnitude becomes partner-facing on any deal where fees approach the cap.

**Deferral rationale:** This is now an ingestion/structured-context gap rather than an engine mechanics gap. The current CLO context JSON / resolver path carries the PPM carryforward window but not the prior-period unused-headroom entries needed to populate the seed automatically. Full automatic closure requires historical waterfall data for the prior carryforward window. Per source-data notes, only the latest Euro XV period has full per-period ingest; prior quarters carry only Intex DealCF backfill and lack `clo_waterfall_steps`, historical pool summary, and account balances.

**Path to close:**
1. Extend CLO context JSON ingestion / resolver output to carry historical waterfall rows, pool summary, and account balances for at least the prior `seniorExpensesCapCarryforwardPeriods` periods.
2. Compute each historical seed entry as `max(0, statedCap_priorPD - cappedPaidPriorPD)` using the period's PPM cap base/day-count mechanics and step B+C capped payments.
3. Thread the computed vintage-specific seed array through `buildFromResolved` as structural deal state, with user input remaining an aggregate override when history is missing or disputed.
4. Replace the unknown-seed warning with source attribution for the computed seed.

**Test:** `web/lib/clo/__tests__/c3-senior-expenses-cap.test.ts` now pins the practical behavior: unknown seed warns and defaults to €0, user-supplied seed threads into q=1 carryforward headroom, and stressed senior expenses move from overflow into capped B/C capacity. Full automatic closure should add a multi-period historical fixture asserting the computed seed magnitude and source attribution.

---

<a id="ki-67"></a>
### [KI-67] Active DDTL/revolver ingestion and trustee validation blocked on missing mechanics — **BLOCKED ON SOURCE DATA / MODELING SUPPORT**

**PPM reference:** Aggregate Principal Balance definition paragraph (a) for Revolving / Delayed Drawdown Collateral Obligations, plus commitment-fee and reserve-account provisions that govern unfunded commitments and any Unfunded Reserve Account / URRA mechanics for the relevant deal family.

**Current engine behavior:** Real imported holdings with active unfunded DDTL/revolver exposure are refused before projection. In `resolver.ts:2490-2518`, any DDTL/revolver holding with `undrawnCommitment > 0` emits a blocking `undrawnCommitment` warning because the projection engine does not yet model the live commitment-fee leg, commitment-end date, or URRA deposit/release mechanics. Synthetic projection inputs can exercise DDTL draw math, and fully-drawn DDTLs are allowed because `undrawnCommitment === 0`.

**PPM-correct behavior:** A real active DDTL/revolver should project funded interest on drawn balances, commitment fees on undrawn balances, commitment expiry/cancellation, draw timing from trustee transaction evidence when available, and any deal-specific URRA cash movements required by the indenture. Once those mechanics are modeled, the existing DDTL OC calibration guard can be validated against a trustee period containing an actual draw event.

**Quantitative magnitude:** Unknown and deal-specific. The blocking gate is intentional because silently projecting active unfunded commitments would set commitment fees to zero and omit URRA cash flows; both magnitudes are per-loan and unbounded without source data.

**Deferral rationale:** The required inputs are not available in the structured source path today. The SDF Collateral File does not carry per-loan commitment-fee bps or commitment-end dates, and structured `ppm.json` does not currently extract URRA mechanics. Loosening the blocking gate before adding those inputs would make partner-facing projections look complete while missing live economics.

**Path to close:**
1. Extend extraction/resolution to source per-loan commitment-fee bps and commitment-end/cancellation dates for active DDTL/revolver positions.
2. Extract or encode deal-specific URRA deposit/release mechanics from the PPM and thread them into projection inputs.
3. Populate draw timing from trustee transaction rows where available, with user assumptions remaining an explicit override rather than the only source.
4. Replace the blanket `undrawnCommitment` blocking warning with narrower blocking gates for missing required fields.
5. Acquire a trustee bundle with an actual DDTL/revolver draw and validate post-draw OC parity, including whether that trustee uses the engine convention or the PPM-literal APB convention.

**Test:** Current blocking behavior is pinned by `web/lib/clo/__tests__/blocking-extraction-failures.test.ts` tests for active unfunded DDTL/revolver `undrawnCommitment`. Closure should add resolver tests for the narrowed active-DDTL gate, engine tests for commitment-fee / commitment-expiry / URRA cash-flow routing, and a live fixture or approved synthetic trustee-parity fixture that exercises a real draw event through `buildFromResolved`.

---

<a id="ki-66"></a>
### [KI-66] Principal POP backfill conditionality unmodeled — **ARES XV CLOSED; FULL CLOSURE BLOCKED ON NEW DATA**

**Status (2026-05-07):** The current Ares XV principal-POP path is closed for the data and state the model has today. Schema-driven extraction and Ares XV engine dispatch shipped and deep-review amended. The resolver now exposes `ResolvedDealData.principalPop`; the projection engine walks structured clauses in sequenced passes: pass 1 before OC/IC measurement for Controlling-Class deferred backfill and mandatory post-RP redemption; pass 2 after debt-interest/cure for upstream interest backfills, cure-from-principal, and Special Redemption; and a late clause-S/T pass after sub-management fee and trustee/admin overflow have run from interest, preserving S-before-T principal-POP ordering. Missing structured principal POP now emits `severity:"error", blocking:true` on production resolver paths; the engine's null-`principalPop` fallback remains only for direct synthetic `ProjectionInputs`.

**Full KI closure is blocked on new data, not additional Ares XV engine work.** The remaining work requires either (a) a non-Ares PPM ingested through the same structured schema, or (b) future event/acquisition state for clauses that are dormant on current Euro XV. Until one of those data conditions exists, there is no current Ares XV behavior left to make more correct.

**What shipped:**

1. **Schema and resolver (2026-05-06):** `ResolvedPrincipalPop` discriminated union added in `web/lib/clo/resolver-types.ts`; `ppm.json` carries Ares XV's 22 structured principal-POP clauses; `resolvePrincipalPop` validates every clause variant and wires `resolved.principalPop` through `buildFromResolved`.
2. **Controlling-Class derivation:** engine derives the highest-rank-with-non-zero-BOP-balance Controlling Class, verified uniform across 4 sampled indentures (Ares XV, Carlyle DL 24-1, Golub 18, Barings 19) per cross-reference §11.2 in `web/docs/principal-pop-redesign-research.md`.
3. **Sequenced schema dispatch:** `web/lib/clo/projection.ts` keeps OC/IC measurement on a start-of-period snapshot, runs pass 1 for pre-interest principal mutations, runs pass 2 after debt-interest/cure for clauses whose predicates or amounts depend on those outcomes, then runs clauses (S)/(T) after downstream interest steps (W)-(Z) have established their shortfalls.
4. **User-input structural clauses:** `specialRedemptionAmount` and `reinvestingHolderRedemptionAmount` are now explicit assumptions, defaulted to zero. When set, the engine reserves those elected amounts before RP reinvestment so the matching principal-POP clause can consume them.
5. **Marker tests** in `web/lib/clo/__tests__/ki07-deferred-paydown.test.ts` (KI-66 describe block). Regression tests pin both the original gated behavior and the new schema dispatch:
   - "PPM Condition 3(c) clause (D)": minimal-interest fixture demonstrating Class C deferred is NOT paid from principal POP while Class A is outstanding. `tranchePrincipal[C].paid` in period 1 ≈ €4M (principal phase 2 only) post-fix vs ~€5M pre-fix (would have included €1M deferred share).
   - "PPM Condition 3(c) clauses (D)/(G)/(J)/(M)": same fixture with multiple deferrable ranks (C and D). Confirms gating applies uniformly.
   - "schema POP clause (P)": Special Redemption reserve survives RP reinvestment and redeems notes in pass 2.
   - "schema POP clause (A)": principal proceeds backfill unpaid current interest without redeeming principal.
   - "schema POP clause (D)": Controlling-Class deferred backfill pays deferred only, without accidentally redeeming principal.
   - "schema POP clause (S)": post-RP principal backfills downstream sub-management fee only after the ordinary interest-side step runs short.
   - "schema POP clauses (S)/(T)": post-RP downstream overflow backfill has priority over Reinvesting Holder amount.
6. **Blocking extraction gate:** `web/lib/clo/__tests__/blocking-extraction-failures.test.ts` pins missing `principalPriorityOfPayments` as a blocking `principalPop` warning.
7. **Clause-coverage matrix:** `web/lib/clo/__tests__/ki66-principal-pop-coverage.test.ts` pins the Ares XV structured A-V clause list and asserts every clause has an explicit engine treatment category.

**Partner-visible behavior on Euro XV today: zero impact under base case.** No PIK state, no Coverage/PV cure failure, no Special Redemption/Reinvesting Holder election, and no Effective Date Rating Event on current Euro XV. The change activates under stress or explicit user election.

**PPM reference:** Ares XV OC Condition 3(c), Principal Priority of Payments, clauses (A) through (V). Mapped in `ppm.json:249-276`. Clauses (D)/(G)/(J)/(M) explicitly require Class C/D/E/F to be Controlling Class for principal-side deferred backfill — that's the gate this closure ships.

**Blocked residuals — what needs new data before it can close:**

- **Effective Date Rating Event redemption** (clause (O)) — **needs event-state data:** schema arm is present but no rating-event state input exists; remains equivalent to KI-03 and is permanently inactive for current Euro XV.
- **Restructured Asset Acquisition** — **needs acquisition/cap-state data:** workout-loan / rescue-financing path identified in cross-reference §11.6; schema arm exists for portability, but no acquisition-authorization user input or per-deal cap-state engine path exists.
- **Non-Ares portability** — **needs another PPM:** the schema was verified against a small sample. At least one non-Ares production PPM should be ingested and round-tripped before treating the schema as fully portable.

Each residual is zero on current Euro XV base case.

**Path to full close once new data exists:**

1. **Validation against ≥1 non-Ares PPM ingested in production** — KI-29-shape portability checkpoint. The Controlling-Class gating's hardcoded `highest_rank_outstanding` definition is sample-bounded; lifting it to extracted per-deal config waits on a deal that surfaces an alternative.
2. **1 additional European 2.0 indenture read** to confirm the PV-vs-Coverage-Test bifurcation is European-typical (vs Ares-family-specific). Tracked in `web/docs/principal-pop-redesign-research.md` §8.3.
3. **Add event/acquisition state** only if a future deal actually activates Effective Date Rating Event or Restructured Asset Acquisition.

**Tests pinning the closed slice:**
- `web/lib/clo/__tests__/ki07-deferred-paydown.test.ts > KI-66 — Controlling-Class gating on principal POP deferred paydown` (7 KI-66 tests). The marker tests pin the post-fix PPM-correct behavior and schema dispatch. KI-27 case 1 (€5M Class E PIK seed on Euro XV) continues to pass — Class E PIK is paid via vanilla step (K) interest-side and / or terminal liquidation rather than principal-POP backfill while A/B/C/D outstanding.
- `web/lib/clo/__tests__/ki66-principal-pop-coverage.test.ts` (3 tests). Pins 22 structured Ares XV clauses and the per-clause engine treatment matrix.

---

<a id="ki-69"></a>
### KI-69 — Section 110 Issuer taxes: closed-form structural model, unmodeled GAAP residual on Euro XV

**PPM reference:** Pre-Acceleration POP step (A)(i) "to the payment of taxes owing by the Issuer accrued in respect of the related Due Period". Irish corporate income tax is governed by Section 110 of the Taxes Consolidation Act 1997 (12.5% rate on Section 110 taxable income). Verified against the Ares CLO XV final OC dated 14 December 2021:
- Section 110 framework: Issuer is taxed on GAAP profit after deducting noteholder interest (OC L3745-3756).
- Step (A)(i) explicitly EXCLUDES corporate income tax on the Issuer Profit Amount itself (OC L10810-10815), save for VAT and withholding pass-throughs which route through other steps (admin VAT through step (C) per OC L7150-7151; senior management fee VAT through step (E) per OC L10841).
- Issuer Profit Amount is defined at €250/quarter pre-Frequency-Switch and €500/quarter post-FSE, capped at €1,000/year (OC L9257-9261).
- Finance Act 2019 sub-note interest deductibility limitation (OC L3758-3767): applies only when a holder owns >20% AND exercises significant influence AND is resident in a non-relevant-territory. The Euro XV Retention Holder is Ares European Loan Funding II Limited, a Jersey entity (OC L16842-44) holding at least 5% of sub-notes (OC L1942-1943) — the 5% level is below the 20% threshold, so the limitation does not fire on the modeled retention slice.

**Current engine behavior (post-2026-05-16):** `taxesBps` was removed from `UserAssumptions` and `ProjectionInputs`. The engine hardcodes step (A)(i) to 0 — both at the T=0 site (`projection.ts:3341 const taxesAmountT0 = 0`) and inside the forward-period loop (`projection.ts:4356 const taxesAmount = 0`). The hardcoding is structurally justified by the Section 110 closed-form `0.125 × max(0, gaap_taxable_income − IPA)`, which clamps to 0 on the flow-balanced projection the engine constructs: deductible flows (noteholder interest + fees + expenses) net interest received down to approximately the Issuer Profit Amount, leaving no residual taxable income after deducting IPA (and step (A)(i) explicitly excludes the CIT on Issuer Profit per OC L10810-10815). Hardcoding 0 takes the analytical limit of the formula under flow balance rather than recomputing it on each period — the bracket is provably non-positive on every period of the construction, so the constant is the closed-form's value, not an independent shortcut. This is the structurally-correct answer under the assumptions the engine can carry (cash-basis flow accounting, no GAAP-vs-cash timing differences, no per-asset accounting-basis tracking). The engine no longer accepts a partner-set bps × par fallback, because that shortcut produced silently wrong numbers on any deal whose tax-base composition or pool par diverges from Euro XV's ratio.

**Quantitative magnitude — unmodeled GAAP residual:** On Euro XV Q1 2026, trustee actual step (A)(i) was €6,133 — i.e. ~€24,500/year of Section 110 corporate tax on accounting-basis profit that the engine's cash-flow construction does not capture. The N1 harness drift marker `KI-69-section110-residual` (in `n1-correctness.test.ts`) pins this at -€6,133/quarter (engine 0 − trustee €6,133) with tolerance €50. The residual is the sum of (a) GAAP-vs-cash timing differences on per-asset interest accrual and recoveries, (b) any Section 110-relevant accounting items the trustee CIT computation captures but the cash-flow waterfall narrative does not surface (e.g. discounts on collateral acquired below par, withholding tax true-ups, prior-quarter under/over accruals), and (c) any sub-note interest non-deductibility under Finance Act 2019 if a >20%+influence+non-relevant-territory condition activates in a future period that we cannot detect from the SDF / PPM alone.

**Data that would close the residual (i.e. take KI-69 from "structurally modeled, residual pinned" to "tied to trustee actuals to the cent"):**
1. **Periodic trustee CIT certifications.** The Issuer's tax agent files an Irish CT1 return annually and the trustee receives quarterly accruals — none of which are in the SDF or the PPM. Without these we cannot reconstruct the GAAP taxable-income figure the trustee paid against.
2. **Audited financial statements (annual).** The Section 110 taxable income is computed from the audited Irish GAAP / FRS 101 P&L, not from cash flows. The CLO publishes annual financials but they're not in the SDF distribution; they would need to be ingested as a separate per-period (or per-year) source.
3. **Per-asset accounting-basis tracking.** GAAP-vs-cash differences fundamentally require tracking each asset's accounting basis (acquisition price, EIR, amortized cost) separately from its par balance. The engine today tracks par only; lifting accounting basis into the resolver and threading it through `PeriodResult` is a non-trivial cross-cutting change.
4. **Sub-note holder concentration tracking with influence + residency flags.** Finance Act 2019 non-deductibility requires (>20% holder share) AND (significant influence) AND (non-relevant-territory residence). The first is in principle observable from sub-note holder rolls but the latter two are off-shore facts (board representation, tax residency certificates) that the SDF / Intex / trustee files do not surface.

**Why the structural closed-form is the right place to stop short of (1)-(4):** The previous `taxesBps × par × dayFrac` model produced approximately-correct numbers on Euro XV when the user accepted the observed-step suggestion (~0.5 bps) but was structurally wrong on any deal whose pool par or tax-base composition diverged. The Section 110 closed-form is structurally correct on every deal (the formula is the actual statutory rule) — it just leaves a documented residual on flow-balanced projections because the engine does not carry the GAAP timing inputs that would close the gap. The residual is partner-visible via the N1 harness marker and the KI-69 entry; it does not silently distort projections, because the engine never claims to capture the GAAP-vs-cash timing differences.

**Test:** `web/lib/clo/__tests__/n1-correctness.test.ts` — `taxes (PPM step A(i)) Section 110 unmodeled residual` (marker `KI-69-section110-residual`, `expectedDrift: -6133`, `tolerance: 50`). Closes when periodic trustee CIT certifications + audited financial statements + per-asset accounting basis are ingested.

---
