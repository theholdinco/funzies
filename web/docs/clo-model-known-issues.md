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
- [KI-08 — `trusteeFeesPaid` bundled steps B+C (PARTIAL: pre-fill D3 + cap mechanics C3 + 2026-05-04 PPM verifications cleared; day-count residuals remain blocked on KI-12a)](#ki-08)
- [KI-12a — Senior / sub management fee base discrepancy](#ki-12a) — **BLOCKED ON DATA ACQUISITION** (Q4 2025 historical SDF + trustee-report bundles)

### Latent — currently inactive on Euro XV; emerges on portability or stress
*Distinct from "Deferred" (those are intentional design choices about mechanics that exist in the indenture but the model elects not to simulate). "Latent" entries are unmodeled or hardcoded paths whose current Euro XV magnitude happens to be zero, but which will produce wrong numbers the moment a deal hits the triggering condition (different deal structure, different PPM, non-zero balance, FX exposure, etc.). Treat each as a real bug whose materiality is data-dependent, not a deliberate scope decision.*

- [KI-36 — Per-tranche `payment_frequency` extracted but not consumed (uniform quarterly cadence)](#ki-36)
- [KI-38 — FX / multi-currency unmodeled; `native_currency` parsed and discarded](#ki-38)
- [KI-45 — Senior Expenses Cap carryforward seed not populated; mid-life projections start with empty buffer](#ki-45)
- [KI-46 — DDTL draw event inflates forward OC numerator; impliedOcAdjustment frozen at T=0 calibration](#ki-46) — **BLOCKED ON DATA ACQUISITION** (deal with active DDTL draws + non-zero `impliedOcAdjustment`)

### Deferred — intentionally not modeled, magnitude known
- [KI-02 — Step (D) Expense Reserve top-up](#ki-02)
- [KI-03 — Step (V) Effective Date Rating Event redemption](#ki-03)
- [KI-04 — Frequency Switch mid-projection cadence/rate switch (C4 Phase 3)](#ki-04)
- [KI-05 — Supplemental Reserve Account (step BB)](#ki-05)
- [KI-06 — Defaulted Hedge Termination (step AA)](#ki-06)
- [KI-07 — Class C/D/E/F current + deferred interest bundled in step map](#ki-07)

### Cascades — residuals that close as upstream closes

*All three cascades below are gated on KI-12a's harness fix, which is **blocked on data acquisition** (Q4 2025 historical SDF + trustee-report bundles). Don't attempt re-baseline or closure work on these until the source data lands; see KI-12a's blocker note for the data-availability gate and `web/CLAUDE.md` § "Source data access" for the path to acquire it.*

- [KI-12b — Day-count precision active; six class-interest markers under harness period mismatch](#ki-12b) — **blocked on KI-12a data**
- [KI-13 — Sub distribution cascade residual](#ki-13) — **blocked on KI-12a data**
- [KI-14 — IC compositional parity at T=0 (cascade)](#ki-14) — **blocked on KI-12a data**

### Design decisions — documented for audit clarity (not open issues)
- [KI-19 — NR positions proxied to Caa2 for WARF (Moody's convention)](#ki-19)

*KI-44 (proposed during 2026-04-30 audit, not added): a candidate raised that `parse-collateral.ts:209-210` writes absolute `Market_Value` into the percent-shaped `current_price` column, with the bug masked on Euro XV by Asset Level enrichment. Verified not a bug. Two pieces of evidence: (i) `ENRICHMENT_COLUMNS` at `sdf/ingest.ts:450` lists only `current_price`, not `market_value` — Asset Level cannot overwrite `market_value`; (ii) every fixture row shows `marketValue == currentPrice` (e.g. 80.097, 99.823, 91.797) which is consistent only with `raw.Market_Value` being itself percent-shaped. If `raw.Market_Value` were absolute, the two columns would diverge after enrichment because only `current_price` gets overwritten. Conclusion: `raw.Market_Value` is percent-shaped despite the misleading column name; parser is correct; consumers are correct. Disposition: not added to ledger; no anchor created (any code referencing `KI-44` would be referencing a non-issue and the disclosure-bijection scanner correctly rejects it). A future verification against the SDF spec would close the question definitively.*

---

<a id="ki-02"></a>
### [KI-02] Step (D) Expense Reserve top-up

**PPM reference:** Condition 3.3(d).
**Current engine behavior:** Not modeled. No `stepTrace.expenseReserve` field exists on `PeriodStepTrace`; the N1 harness mapper hardcodes the bucket to 0 (`backtest-harness.ts:285`). `ppm-step-map.ts:106` documents the bucket as "NOT EMITTED by engine (KI-02)".
**PPM-correct behavior:** CM-discretionary deposit during Reinvestment Period to maintain senior-expense headroom.
**Quantitative magnitude:** €0 in Euro XV Q1 2026 waterfall. Typically €0 in steady-state; activates only when senior-expense accruals are building toward the cap.
**Deferral rationale:** Discretionary and rarely activated. Our observed data has zero Q1 expense-reserve deposit across Euro XV's 17-period Intex history.
**Path to close:** Add `expenseReserveDepositBps` user input; engine routes to reserve account. Activates only when a deal exercises step (D); until then the engine emits 0 correctly.
**Test:** No active marker — both engine and trustee emit 0 on Euro XV. The `expenseReserve` row in the N1 harness table (Infinity tolerance) is the passive audit channel; a non-zero trustee value on a future deal would surface via that row.

---

<a id="ki-03"></a>
### [KI-03] Step (V) Effective Date Rating Event redemption

**PPM reference:** Condition 7.3, p.180.
**Current engine behavior:** Not modeled; engine has no rating-downgrade detection. No `stepTrace.effectiveDateRating` field exists; the N1 harness mapper hardcodes the bucket to 0 (`backtest-harness.ts:286`). `ppm-step-map.ts:124` documents the bucket as "NOT EMITTED by engine (KI-03)".
**PPM-correct behavior:** Triggered by rating agency downgrade during the Effective Period; mandatory redemption.
**Quantitative magnitude:** Euro XV is past Effective Date (closed Dec 2022); step is permanently inactive for this deal.
**Deferral rationale:** Inactive for every deal that makes it past the Effective Date ramp. For deals in-ramp only.
**Path to close:** Out of scope unless we model pre-Effective-Date CLOs.
**Test:** No active marker — permanently inactive for Euro XV. The `effectiveDateRating` row in the N1 harness table passes (both sides 0).

---

<a id="ki-04"></a>
### [KI-04] Frequency Switch mid-projection cadence/rate switch (C4 Phase 3)

**PPM reference:** Condition 1 (Frequency Switch Event), pp.127–128.
**Current engine behavior:** Trigger evaluation modeled in C4 Phase 2 (once it ships); warning fires if both (b) concentration and (c) interest-shortfall conditions cross their thresholds. Post-switch semi-annual cadence, 6M EURIBOR, and €500 Issuer Profit modeled via C4 Phase 1's manual `freqSwitchActive` flag. **Automatic mid-projection cadence/rate switching is not modeled.**
**PPM-correct behavior:** On trigger, switch quarterly → semi-annual payment dates, 3M → 6M EURIBOR, Issuer Profit €250 → €500. One-time and irreversible.
**Quantitative magnitude:** Euro XV currently has 0% Frequency-Switch-Obligation concentration (no loans with ≥6M payment frequency). Trigger (b) cannot fire without a structural pool change. Phase 3 impact is theoretical for this deal.
**Deferral rationale:** Engine rework to support variable periods-per-year mid-simulation (day-count, period calendar, OC/IC cadence, DDTL timing, call quantization). Rarely-hit scenario — Phase 2 warning + Phase 1 manual flip provide workable modeling coverage for any stress scenario an analyst would run.

**Cadence-coupled hardcodings that MUST be touched together when this lands** — independent enumerations of "periods per year = 4" sites that are correct under quarterly cadence and silently wrong under semi-annual:

- **T=0 IC test** (`projection.ts:1259-1276`): scheduled-interest base divided by literal `/ 4` instead of `dayCountFraction(...)`. Each of the seven IC numerator and denominator constructions in the T=0 block uses `/ 4` directly. Under semi-annual cadence the numerator is overstated by 2× and the IC ratio is correspondingly wrong.
- **Incentive-fee circular solver** (`projection.ts` — three call sites: two normal-mode at the in-loop interest+principal-path emit, one post-acceleration inside `runPostAccelerationWaterfall`'s step (V) dispatch): all three pass `periodsPerYear = 4` literal to `resolveIncentiveFee(equityCashFlows, ..., 4)`. The post-accel site routes `periodsPerYear` through `PostAccelExecutorInput.periodsPerYear` so the call site at the executor invocation is the load-bearing literal-4 location. Under semi-annual cadence the IRR annualization is wrong at all three sites; the hurdle test then fires at the wrong threshold.

These were originally tracked as "A10" and "A11" in the 2026-04-30 audit. They are sub-items of KI-04, not separate KIs — but they must be enumerated explicitly because closing KI-04 by only fixing the trigger detection without touching these sites leaves silent residual bugs that would not be caught by the trigger-detection test alone.

**Path to close:** Trigger: a deal where the trigger actually fires, or a partner request. The fix sequence is (a) replace literal `/ 4` and `4`-as-periods-per-year throughout the engine with day-count-fraction or `periodsPerYear` derived from the active cadence, (b) carry a per-projection `cadence: "quarterly" | "semiAnnual"` value as input, (c) implement automatic switch detection on (b) concentration + (c) interest-shortfall conditions, (d) re-run the N1 harness on a pre-switch fixture and a post-switch synthetic to confirm.

**Test:** No active marker — trigger does not fire on Euro XV (0% Frequency-Switch-Obligation concentration). Future deals that trip the trigger would surface as a cadence mismatch in the N1 harness period-count row. When the fix lands, also add (i) a synthetic T=0 IC test under semi-annual cadence asserting the correct day-count fraction is applied (catching the line 1259-1276 site), and (ii) a synthetic incentive-fee scenario under semi-annual cadence asserting `resolveIncentiveFee` annualizes correctly (catching all three solver call sites — two normal-mode + one post-accel via `PostAccelExecutorInput.periodsPerYear`).

---

<a id="ki-05"></a>
### [KI-05] Supplemental Reserve Account (step BB)

**PPM reference:** Condition 3.3(b).
**Current engine behavior:** Not modeled. No `stepTrace.supplementalReserve` field exists; the N1 harness mapper hardcodes the bucket to 0 (`backtest-harness.ts:288`). `ppm-step-map.ts:130` documents the bucket as "NOT EMITTED by engine (KI-05)". This entry covers the *flow into* the account during the waterfall; the *opening balance* is consumed by the engine via `ProjectionInputs.initialSupplementalReserveBalance` per the user-driven `supplementalReserveDisposition` (PPM Condition 3(j)(vi) manager discretion).
**PPM-correct behavior:** CM-discretionary deposit during Reinvestment Period, funds reinvestment buffer.
**Quantitative magnitude:** Not exercised on Euro XV per observed waterfall data.
**Deferral rationale:** CM-discretionary; not used in current operations.
**Path to close:** Add `supplementalReserveDepositBps` user input; engine routes to reserve account. Activates only when a deal exercises step (BB).
**Test:** No active marker — engine and trustee both 0 on Euro XV. The `supplementalReserve` row in the N1 harness table (Infinity tolerance) surfaces if a deal exercises it.

---

<a id="ki-06"></a>
### [KI-06] Defaulted Hedge Termination (step AA)

**PPM reference:** Condition 3.3(a).
**Current engine behavior:** Modeled as 0 by the N1 harness mapper (`backtest-harness.ts:287`); `ppm-step-map.ts:129` documents the bucket as "NOT EMITTED by engine (KI-06)". Non-defaulted hedge payments flow through step (F) (`stepTrace.hedgePaymentPaid`, declared at `projection.ts:265`, emitted at `:2463`).
**PPM-correct behavior:** Activates if a hedge counterparty defaults; termination payments flow through accelerated position in step (AA).
**Quantitative magnitude:** 0 in current data; activates only in hedge-counterparty-default scenarios (rare).
**Deferral rationale:** Contingent on counterparty default; model would need hedge-counterparty state which the upstream data pipeline doesn't track.
**Path to close:** Out of scope without hedge counterparty data pipeline.
**Test:** No active marker — activates only on counterparty default. `defaultedHedgeTermination` in the N1 harness table (Infinity tolerance) surfaces the magnitude if it ever triggers.

---

<a id="ki-07"></a>
### [KI-07] Class C/D/E/F deferred-balance pay-down may commingle with current interest under stress (currently latent on Euro XV)

**PPM reference:** PPM step codes (J) (current interest) and (K) (deferred-interest accrual / pay-down) for Class C; (M)/(N) for D; (P)/(Q) for E; (S)/(T) for F.

**Current engine behavior — corrected (was previously framed as "bundled in step map", which is contradicted by the code):** Engine emits step (J) and step (K) as **separate** fields:
- `classC_current` ← `PeriodResult.trancheInterest[].paid` (`backtest-harness.ts:303`, sourced from `projection.ts:2156`).
- `classC_deferred` ← `stepTrace.deferredAccrualByTranche` (`backtest-harness.ts:309`, sourced from `projection.ts:295, 1418-1419, 2194`).
- `ppm-step-map.ts:157-167` maps each bucket to a single PPM step code (`["j"]`, `["k"]`, etc.), not a bundled list.

The genuine latent risk this entry tracks: under deferred-interest stress, deferred-balance **pay-downs** (cash flowing OUT of `deferredBalances` back to noteholders) are routed via `deferredPay = Math.min(deferredBalances[t.className], remainingPrelim)` at `projection.ts:1956-1957`, and this paid-out amount may not surface as a separately-labelled PPM-step bucket — it is added back to the same `trancheInterest[].paid` field that carries current interest. Under stress, a partner reading the trace sees a `classC_current` row that combines (i) actual step (J) current interest and (ii) step (K) deferred pay-down, with no separation. This is the actual bundling concern.

**PPM-correct behavior:** Separate step lines for current interest (J/M/P/S) and deferred-balance accrual / pay-down (K/N/Q/T). Engine should emit a `stepTrace.classX_deferredPaydown` row distinct from `classX_current` whenever residual interest pays down deferred balance.

**Quantitative magnitude:** 0 drift on Euro XV Q1 2026 (no deferred-balance state to pay down). Under stress where Class C/D/E/F deferred balances accumulate and then a high-interest period flushes some of that deferred back, the bundled output cannot be cleanly compared against split trustee lines.

**Deferral rationale:** No deferred state in current data → no observable bundling on Euro XV. Splitting requires extending `stepTrace` with deferred-paydown rows distinct from current-interest rows.

**Path to close:** After B1+B2 (compositional EoD + post-acceleration) land — engine then carries non-trivial deferred-balance state across periods (T=0 deferred-interest seeding for non-compounding PPMs is wired via `ResolvedTranche.deferredInterestBalance` and the conditional seed at `projection.ts`). Add `stepTrace.classX_deferredPaydown` for X ∈ {C, D, E, F}, populated from `deferredPay` at `projection.ts:1956-1957`. Update `backtest-harness.ts` and `ppm-step-map.ts` mappings to surface the new field as PPM step (K)/(N)/(Q)/(T). Update the trace renderer to display the row.

**Test:** `n1-correctness.test.ts > "green buckets" > Class C/D/E/F deferred interest is zero (no stress)`. No stress case exists on Euro XV; under deferred-interest stress this assertion will need to move into a `failsWithMagnitude` marker covering the new `classX_deferredPaydown` row.

---

<a id="ki-08"></a>
### [KI-08] `trusteeFeesPaid` bundled steps B+C — **PARTIALLY CLOSED (pre-fill D3 + cap mechanics C3 + 2026-05-04 PPM verifications)**

**Status (2026-05-04, PPM verifications + cap-completion shipped):** Mechanics shipped + four PPM design assumptions verified against Ares European CLO XV Offering Circular pp. 150-151 (Condition 1 "Senior Expenses Cap") + pp. 159-161 (Pre-Acceleration POP steps B/C/Y/Z). All four assumptions were CONTRADICTED and the engine has been amended to PPM-correct behavior. Four additional structural cap defects surfaced during the verification (component (a) mixed day-count, CPA-vs-APB cap base, 3-period rolling carryforward, VAT inclusion) all closed in the same PR — engine now dispatches on `seniorExpensesCapComponentADayCount`, `seniorExpensesCapBaseMode`, `seniorExpensesCapCarryforwardPeriods`, and `seniorExpensesCapVatRatePct`. Only the KI-08 day-count residuals remain open (gated on KI-12a data).

**What shipped:**

1. **Pre-fill (D3, Sprint 2)**: `defaultsFromResolved` back-derives `trusteeFeeBps` AND `adminFeeBps` separately from Q1 waterfall steps B + C (Euro XV: 0.0969 bps trustee, 5.147 bps admin, 5.244 combined).
2. **Cap + overflow (C3, Sprint 3)**: `ProjectionInputs.adminFeeBps` + `ProjectionInputs.seniorExpensesCapBps` added. Engine emits trustee + admin fees jointly capped at the per-period cap; overflow routes to PPM steps (Y) trustee-overflow and (Z) admin-overflow, paying from residual interest after tranche interest + sub mgmt fee.
3. **PPM verifications (this PR, 2026-05-04)**:
   - Cap value structure ({a} €300K/yr fixed + {b} 2.5 bps × CPA per OC pp. 150-151) wired through new `ResolvedSeniorExpensesCap` interface on `ResolvedDealData` + new `ProjectionInputs.seniorExpensesCapAbsoluteFloorPerYear` field. Replaces the unstructured 20-bps-only fallback.
   - `max(2× observed, 20 bps)` heuristic in `defaultsFromResolved` removed; the cap value now comes from PPM via `resolved.seniorExpensesCap.bpsPerYear` per project rule (silent fallbacks on missing computational extraction are bugs).
   - B/C in-cap allocation switched from pro-rata to sequential B-first per OC Condition 3(c)(C) ("less any amounts paid pursuant to paragraph (B) above"). Engine block at `projection.ts:2848-2861` dispatches on `seniorExpensesCapAllocationWithinCap`.
   - Y/Z overflow allocation switched from pro-rata to sequential Y-first per POP convention. Engine block at `projection.ts:3795-3811` dispatches on `seniorExpensesCapOverflowAllocation`.
   - Resolver emits `severity: "error", blocking: true` when a deal has fee rows but no PPM cap extracted.

**Partner-visible behavior on Euro XV**: observed combined ~5.24 bps well below the PPM cap (~5.43 bps composite at €107K/quarter on €493M beginPar × 91/360 day-count, vs observed €64K/quarter) → no overflow fires, N1 harness bit-identical pre/post the 2026-05-04 amendments. `trusteeFeesPaid` ties to trustee within €722 (day-count residual from 91/360 engine vs 90/360 trustee). Stress scenarios with observed > cap now produce sequential B-first / Y-first per PPM.

**Tests (7 new C3 tests):**
- `c3-senior-expenses-cap.test.ts` — base case (no overflow), high-fee overflow (50 bps + 20 bps cap → 30 bps overflow), extreme cap (1 bps), overflow-limited-by-residual, backward-compatibility (undefined cap = unbounded).
- `d3-defaults-from-resolved.test.ts` — `trusteeFeeBps` + `adminFeeBps` separately back-derived; sum matches pre-C3 combined extraction; `seniorExpensesCapBps` derivation from Q1 observed.
- `b2-post-acceleration.test.ts` — under acceleration (PPM 10(b)) trustee + admin pay uncapped; regression guard asserts `stepTrace.adminFeesPaid / trusteeOnly = adminFeeBps / trusteeFeeBps` exactly.

**Day-count residual markers (registered via `failsWithMagnitude`, close with KI-12a harness fix):**
- `n1-correctness.test.ts > KI-08-dayCountResidual-trustee` — `expectedDrift: 13, tolerance: 5`.
- `n1-correctness.test.ts > KI-08-dayCountResidual-admin` — `expectedDrift: 709, tolerance: 50`.

Both markers track the 91/360-vs-90/360 day-count residual exposed by the harness period mismatch (sibling mechanism to the six KI-12b class-interest markers); they re-baseline or remove together when KI-12a lands.

**Blocked on KI-12a data acquisition (added 2026-05-02).** Closure of these two day-count residual markers (the only KI-08 sub-component still moving) waits on KI-12a's harness fix, which itself is blocked on re-ingesting Q4 2025 (or earlier) historical SDF + trustee-report bundles for Euro XV — see [KI-12a's blocker note](#ki-12a). Don't attempt closure work on these markers until that data lands.

**Cascade re-baselines**: KI-13a adjusted by the C3 split preserving aggregate behavior; `stepTrace.trusteeFeesPaid` currently bundles steps (B)+(C)+(Y)+(Z) to preserve the N1 harness bucket semantics. Split-out fields (`adminFeesPaid`, `trusteeOverflowPaid`, `adminOverflowPaid`) are additive diagnostic fields — the harness will be un-aggregated in a follow-up (see task #48).

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
- Trustee fees, taxes, issuer profit (KI-01/08/09): orthogonal — engine emits 0 regardless of period.

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
- `trusteeFeesPaid` (KI-08) — the €64,660 drift magnitude reflects trustee's Q1 fee; engine emits 0 because `trusteeFeeBps=0` default. The "expected magnitude" is period-mismatch-contaminated: after KI-08 pre-fill, the residual fee drift will be whatever Q2's fee base implies, not Q1's.
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

**Blocked on KI-12a data acquisition (added 2026-05-02).** This residual moves only as upstream KIs close. The largest open upstream — KI-12a — is blocked on re-ingesting Q4 2025 historical SDF + trustee-report bundles; see [KI-12a's blocker note](#ki-12a). Re-baselining `KI-13a-engineMath` is gated on that data landing. Don't attempt re-baseline work here until then.

**PPM reference:** Step (DD) — residual to sub (equity) note.
**Current engine behavior:** `subDistribution` is the residual bucket; every upstream drift (taxes, trustee fee, mgmt fees, fee-base) cascades into it. Direction depends on the net sign of those drifts.
**PPM-correct behavior:** N/A — this is a cascade, not an independent mechanic. Closes automatically as upstream KIs close.
**Quantitative magnitude:**
- Engine-math (legit pins, post-KI-01 close): −€50,992.24/quarter. Counter-intuitive negative sign: KI-12b class-interest day-count drifts (+€48,019) + KI-12a fee-base day-count drifts (+€34,792) + trustee/admin residuals minus KI-09 taxes (−€6,202) and KI-01 issuer profit (−€250). Multiple drifts compound or cancel; the sign is not a stable indicator. Verified live by N1 harness (`subDistribution | dd | … delta -50992.24`).
- Production path (no pins): historically reported as +€617,122/quarter. **No `KI-13b-productionPath` marker currently exists in the codebase** (no `n1-production-path.test.ts` file); the +€617K number originated as a one-time measurement and has not been pinned by an active assertion. Either re-instate the production-path harness with a marker, or drop the production-path number from this entry. Until then, treat the +€617K figure as historical context, not as a verified live drift.
**Deferral rationale:** Structural — residual that tracks the sum of upstream corrections.
**Path to close:** Closes progressively as KI-01 / KI-08 / KI-09 / KI-10 / KI-11 / KI-12a close. No standalone work.
**Test:** `n1-correctness.test.ts > "currently broken buckets" > subDistribution` (ki: `KI-13a-engineMath`, expectedDrift **−€50,992.24** ± €50). The production-path counterpart referenced in prior versions of this entry was never landed; if the production-path drift is judged worth tracking, write a new `n1-production-path.test.ts` and pin a fresh `KI-13b-productionPath` marker before referencing it here. The `expectedDrift` on `KI-13a-engineMath` must be re-baselined (or the marker removed if drift closes) whenever an upstream KI moves.

**⚠ Maintenance checklist** — include in every PR that closes or moves an upstream KI (01 / 08 / 09 / 10 / 11 / 12a):
- [ ] Did this PR close or modify an upstream KI's expected drift magnitude?
- [ ] If yes: re-run the harness and update `KI-13a-engineMath.expectedDrift` in `n1-correctness.test.ts`.
- [ ] If yes (and KI-10/11 moved): same for `KI-13b-productionPath.expectedDrift` in `n1-production-path.test.ts` — only if a production-path harness has been re-instated; no such file exists today (see entry body).
- [ ] If the cascade drift dropped below tolerance, remove the failsWithMagnitude marker and move KI-13 to Closed.
- [ ] Note: signs can flip during the close sequence — re-check the sign, not just the magnitude.

---

<a id="ki-14"></a>
### [KI-14] IC compositional parity at T=0 (cascade residual)

**Blocked on KI-12a data acquisition (added 2026-05-02).** The remaining ~3 pp drift across Classes A/B, C, D is the KI-12a fee-base mismatch flowing into the IC numerator at T=0. Closes when KI-12a closes, which is blocked on re-ingesting Q4 2025 historical SDF + trustee-report bundles; see [KI-12a's blocker note](#ki-12a). Don't attempt re-baseline of `KI-IC-AB` / `KI-IC-C` / `KI-IC-D` until then.

**PPM reference:** Condition 12 (Interest Coverage Test); §(A)(i), (A)(ii), (B), (C), (E)(1) components in the numerator.
**Current engine behavior:** Engine computes IC at T=0 (`initialState.icTests`) by deducting PPM §(A)(i) taxes, §(B) trustee, §(C) admin, §(E) senior mgmt, §(F) hedge from the scheduled interest base. Under legit pins (production path via `defaultsFromResolved`), engine IC ratios still sit slightly above trustee because KI-01 (issuer profit) and KI-12a (senior mgmt fee base mismatch) remain open — net residual drift ~3 pp per class.
**PPM-correct behavior:** IC numerator includes the full set of §(A)–§(F) deductions correctly attributed.
**Quantitative magnitude (post-Sprint-3 KI-08 admin + KI-09 taxes closure, Q1 2026):**
  - Class A/B: +3.960 pp drift (was +6.600 pre-cascade; Δ −2.64 pp from admin+taxes deductions landing in initialState)
  - Class C: +3.525 pp drift (was +5.865; Δ −2.34 pp)
  - Class D: +3.070 pp drift (was +5.117; Δ −2.05 pp)
**Deferral rationale:** Cascade — not an independent formula bug. The IC parity test exists because the component cash-flow checks in n1-correctness don't exercise the aggregation/denominator logic of the IC formula itself; a mis-aggregation would slip through.

**Important — test input path correctness (fixed Sprint 3):** The prior test setup spread `DEFAULT_ASSUMPTIONS` with `taxesBps: 0, adminFeeBps: 0, trusteeFeeBps: 0`, meaning the markers could not move when KI-08 admin or KI-09 taxes closed (the input path zeroed the very fields those closures would add to the numerator). Swapped to `defaultsFromResolved(fixture.resolved, fixture.raw)` — the production path used by `ProjectionModel.tsx` — so the cascade actually cascades. Closure of admin/taxes then shifted the observed drift by the expected ~2-3 pp per class, confirming both the fix and the cascade wiring.
**Path to close:** Closes progressively as KI-01 / KI-12a close. No standalone work.
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

<a id="ki-29"></a>
### [KI-29] Long-dated obligation forward-period valuation rule not modeled — **PARTIAL: discount-obligation leg closed; long-dated classification done; long-dated valuation residual remains**

**Status (closure of discount-obligation leg + KI-33 in same PR, 2026-05-05):**

The discount-obligation leg of this entry CLOSED:
- `ResolvedLoan` carries `purchasePricePct`, `acquisitionDate`, `isDiscountObligation`, `isLongDated` per-position.
- Per-deal `ResolvedDiscountObligationRule` (Condition 1 classification + cure mechanic) extracted from PPM via `ppm.json:section_5_fees_and_hurdle.discount_obligation`. Resolver blocks via `severity: "error", blocking: true` when missing on a non-greenfield deal.
- Engine drives the OC numerator's discount-obligation haircut from per-position Σ at every period (T=0 and forward) via `computeDiscountHaircut(loanStates)` at `projection.ts:2266` + `:3655`. Per-position survivingPar decays naturally as positions amortize / prepay / default.
- Cure mechanic dispatch (`continuous_threshold` with rate-type discriminator and holding-since-acquisition window; `permanent_until_paid`) re-evaluates classification per period via `applyCureDispatch`.
- KI-33 closed in the same PR: `computeReinvOcDiversion` is price-aware (returns `{ cashDiverted, parBought }` with above-threshold-vs-sub-threshold dispatch); all four reinvestment synthesis sites set per-position fields including `purchasePricePct = reinvestmentPricePct` and `isDiscountObligation = isSubThreshold`.

Long-dated leg:
- Per-position **classification** done — `loan.isLongDated = (loan.maturityDate > deal.maturityDate)`. Cross-deal indenture surveys (Law Insider, SEC EDGAR-filed CLO indentures) confirm this classification rule is law-firm-templated and identical across managers; safe to treat as universal.
- Per-deal **valuation rule** NOT modeled. Engine continues to consume the trustee's static `longDatedObligationHaircut` scalar at every period; mechanically bound to a partner-facing banner (`LongDatedStaticBanner`) that fires whenever the scalar is > 0.

**PPM reference + design space (long-dated residual):** Condition 1 ("Long-Dated Obligation"); Condition 10(a)(iv) Adjusted Collateral Principal Amount. Industry research (S&P "Par Wars" series, Sep 2022 + Feb 2020; Fitch "U.S. CLO Indenture Features Explained"; Law Insider canonical clauses; SEC EDGAR-filed indentures from Carlyle, Owl Rock, et al.) shows the long-dated valuation rule has TWO canonical shapes — variation between managers is parameter-tuning within these shapes, not structural divergence:

- **Shape A — "binary exclusion / cap-then-zero"** (older / simpler / typical of European CLO 2.0). Cap percentage is the load-bearing knob; canonical conservative is 2.5% of CPA, with 5% (Ares XV) at the more permissive end. Excess deemed zero. Within-cap valued at par.
- **Shape B — "tiered haircut by years past Stated Maturity"** (newer / post-2018, post-2017 manager-flexibility trend). Within-cap (≤ 2 years past Stated Maturity): `min(MarketValue × par, 70% × par)`. Beyond cliff (> 2 years past Stated Maturity): zero. Excess-above-cap valuation: hard zero (conservative) or `min(S&P CV, Fitch CV)` (manager-friendly variant; e.g. Ares XVIII).

A finite enum suffices to encode the design space:
```ts
type LongDatedValuationRule = {
  shape: "binary" | "tiered_70_or_mv";
  capPctOfBase: number;            // 2.5 / 5 typical
  capBase: "APB" | "CPA";
  postCapTreatment: "zero" | "agency_cv_min";
  cliffYearsPastStatedMaturity: number | null;  // null for binary; 2 typical for tiered
};
```
Local PPM sample (Ares XV + Ares XVIII) maps cleanly into this schema. Other major managers (Apollo, Blackstone, Carlyle, KKR, GSO, Sound Point, etc.) are documented in the same shape space — variation is in the parameters, not the structure.

**Current engine behavior (residual):** `ResolvedDealData.longDatedObligationHaircut` (number) is consumed at the OC numerator construction at every period (the same scalar across all periods). Per-position `LoanState.isLongDated` is set but never read by the haircut Σ — there's no per-deal valuation rule for the engine to dispatch on.

**Quantitative magnitude (residual) on Euro XV today: zero bias.** Verified by direct probe: T=0 long-dated count is 0 (no loan in the pool has stated maturity > 2036-01-15); forward-projected reinvestments never go long-dated (reinvestment cutoff at Q1, latest synthesised loan matures at Q21, deal runs to Q28 — every reinvestment matures within deal life). Engine's static-scalar output (0) and a fully-implemented per-deal valuation rule's output (0) are identical for every period of every projection. The residual is genuinely portability-only — it produces wrong numbers on a different deal (longer reinvestment-tenor-vs-deal-maturity ratio, or T=0 long-dated positions present), not on Ares XV.

**Path to close (residual):**
1. Encode the discriminated union above as `ResolvedDealData.longDatedValuationRule` (new field).
2. Extend `ppm.json` schema with `section_5_fees_and_hurdle.long_dated_obligation` block; populate Ares XV (Shape A: binary, 5% APB, post-cap zero, no cliff) and Ares XVIII (Shape B: tiered, 2.5% CPA, post-cap agency_cv_min, 2yr cliff).
3. Resolver consumes the block; blocks via `severity: "error", blocking: true` when missing on a deal whose pool composition could carry long-dated positions (same shape as the discount-obligation gate).
4. Engine drives the long-dated haircut from per-position Σ over `loanStates` filtered by `isLongDated`, applying the per-deal rule's dispatch.
5. Delete `LongDatedStaticBanner.tsx` in lockstep with the engine swap; remove this entry from the ledger entirely (closed = deleted).
6. Validate the schema by ingesting at least one non-Ares PPM (Apollo, Blackstone, Carlyle, KKR, etc.) before declaring the residual closed — confirms the canonical shapes survive a manager-different deal.

**Test:** behavior pinned by `KI-29-longDatedStatic` in `c5-discount-obligation.test.ts` (synthetic fixture with non-zero `longDatedObligationHaircut`; asserts the static scalar deducts identically at T=0 and at q=1 — flips when the per-deal forward-period valuation rule lands). Not in `failsWithMagnitude` shape because the residual carries zero current magnitude on Euro XV (no long-dated positions; trustee scalar = 0); the marker pins the behavior, not a wrong-number drift.

---

<a id="ki-36"></a>
### [KI-36] Per-tranche `payment_frequency` extracted but not consumed (uniform quarterly cadence)

**PPM reference:** Per-tranche indenture term. Each tranche's payment frequency (Quarterly / Semi-Annual / Monthly) is PPM-specified per class.

**Current engine behavior:** Extraction populates `clo_tranches.payment_frequency` from the SDF (`web/lib/clo/sdf/parse-notes.ts` `payment_frequency` column) and `access.ts:540` reads it onto `CloTranche.paymentFrequency`. The field is not propagated to `ResolvedTranche` and is unread by the engine. The projection generates period boundaries via `addQuarters(_, 1)` at the period stub anchor — quarterly cadence for every tranche regardless of indenture terms. There is no mechanism to express semi-annual or monthly cadence, nor to mix cadences across tranches in a single deal.

**PPM-correct behavior:** Each tranche carries its PPM-specified payment frequency; the engine generates per-tranche period ends and accrues interest on those windows.

**Quantitative magnitude:** Zero on Euro XV (all 8 tranches are quarterly). Latent on any deal with one or more semi-annual tranches (engine would treat them as quarterly → 2× the period count, distorted day-count, distorted IRR), or any deal with a mixed-cadence structure (currently impossible to model).

**Deferral rationale:** Engine refactor required to support variable per-tranche cadence. Closely related to KI-04 (Frequency Switch) — when KI-04 lands, the natural extension is per-tranche cadence rather than just deal-level.

**Path to close:**
1. Add `paymentFrequency: "Quarterly" | "SemiAnnual" | "Monthly"` to `ResolvedTranche`.
2. Populate from `CloTranche.paymentFrequency` in `resolveTranches` (both DB and PPM-fallback branches).
3. Replace the engine's deal-level `addQuarters(_, 1)` cadence with per-tranche period-end derivation. This requires a per-tranche payment schedule, not the current single shared schedule.
4. Update synthetic test fixtures to verify mixed-cadence deals project correctly.

**Test:** No active marker on Euro XV (uniform quarterly). When engine support lands, synthetic-deal tests for semi-annual and mixed-cadence pin the new behavior.

---

<a id="ki-38"></a>
### [KI-38] FX / multi-currency unmodeled; `native_currency` parsed and discarded

**PPM reference:** Multi-currency CLO mechanics (USD/EUR/GBP cross-currency hedges, FX revaluation on holdings denominated in non-deal currency).

**Current engine behavior:** `web/lib/clo/sdf/parse-collateral.ts:17-19, 146-150` extracts:

- `native_currency_balance: number | null` (the loan's balance in its own currency)
- `native_currency: string | null` (the loan's denomination)
- `currency: string | null` (set to the same value as `native_currency`)

No FX rate is ingested. The engine does not consume `currency` anywhere — `web/lib/clo/projection.ts` has no references. Loan par values are summed as if all denominated in the deal currency.

**PPM-correct behavior:** A USD-denominated loan in a EUR-denominated deal must be revalued at the prevailing EUR/USD rate each period (typically using the trustee report's reference FX). The deal's hedge legs (if cross-currency) net out the FX exposure at a contracted rate.

**Quantitative magnitude:** Zero on Euro XV — single-currency (EUR-investing-in-EUR-loans), no FX exposure. Latent on any multi-currency deal. On a US BSL CLO with 100% USD assets denominated in USD, this works by coincidence (engine treats sums as USD). On a European deal with a USD sleeve (~5-10% of par typical in some structures), the engine over- or under-states pool par by the EUR/USD drift × USD share — easily 5-10pp swings during periods of FX volatility.

**Deferral rationale:** Multi-currency support is a substantial engine + extraction extension. Tagged latent because Euro XV is single-currency.

**Path to close:** Out of scope until a multi-currency deal is in the pipeline. When that arrives, a separate sprint covers (a) FX rate ingestion, (b) per-loan revaluation, (c) cross-currency hedge legs, (d) currency-bucketed concentration tests.

**Test:** No active marker. Required when a multi-currency deal is onboarded.

---

<a id="ki-45"></a>
### [KI-45] Senior Expenses Cap carryforward seed not populated; mid-life projections start with empty buffer

**PPM reference:** Condition 1 ("Senior Expenses Cap") proviso (ii), OC pp. 150-151. Each Payment Date's cap is augmented by Σ unused stated-cap headroom from the prior N Payment Dates (Ares XV: 3 pre-FSE).

**Current engine behavior:** `web/lib/clo/projection.ts:367` declares `seniorExpensesCapCarryforwardSeed?: number[]` on `ProjectionInputs`; the engine consumes it at `projection.ts:2425-2427` to seed the FIFO buffer at projection start. **No production caller populates the field** — `web/lib/clo/build-projection-inputs.ts` doesn't include it in the `buildFromResolved` return, `defaultsFromResolved` doesn't compute it, and `web/app/clo/waterfall/ProjectionModel.tsx` doesn't pass it. Engine docstring at `projection.ts:2421-2424` already documents the gap: *"Default empty — appropriate at deal inception; latent under-count for mid-life projections that lack the seed input."* Every production projection starts with `capCarryforwardHistory = []` regardless of the deal's trustee history. The field is exercised only by the synthetic test at `web/lib/clo/__tests__/c3-senior-expenses-cap.test.ts:389-390`.

**PPM-correct behavior:** The seed is the trailing N entries of `max(0, statedCap_priorPD - cappedPaid_priorPD)` from the deal's most recent N PDs. For Ares XV (carryforward = 3), the seed is the unused headroom from the latest 3 historical PDs. With proper seeding, q=1's cap reflects the deal's actual position in the carryforward window rather than treating the projection as a fresh deal-inception run.

**Quantitative magnitude:** On Euro XV, the seed entry derived from the latest historical period would be ~€120K (stated cap ~€383K vs actual paid ~€263K per period — observed fees ~5.24 bps against a 2.5 bps + €300K floor cap). For a 3-period buffer the seed sum could reach ~€360K at q=1. **Currently zero on partner-facing cash flows** — Euro XV's fees don't bind the cap, so adding €360K of headroom raises `period.stepTrace.seniorExpensesCapAmount` from ~€383K to ~€743K but `cappedRequested ≈ €263K < both`, leaving paid amounts and equity distributions unchanged. Magnitude becomes partner-facing on any deal where fees approach the cap.

**Deferral rationale:** Two-axis blocker:
1. **Implementation** — the partial fix (1-period seed from the latest period's `raw.waterfallSteps` step B+C amount minus computed stated cap) requires approximating the prior-determination-date pool state from the current state (the latest pool summary in the DB is the determination date AT the latest PD, not BEFORE it). The approximation is workable (~2% drift on the seed entry) but introduces a documented modeling shortcut that needs its own validation.
2. **Data** — the full PPM-faithful 3-period seed requires historical waterfall data for the prior 2 PDs. Per `web/CLAUDE.md` § "Source data access", per-period coverage is uneven; only the latest period for Euro XV has the full per-period ingest. Prior quarters carry only `clo_tranche_snapshots` from the Intex DealCF backfill — no `clo_waterfall_steps`, no historical pool summary, no historical account balances. The full fix is gated on extending the historical ingest pipeline.

**Path to close:**
1. Ingest historical waterfall data: `clo_waterfall_steps` + `clo_pool_summary` + `clo_account_balances` for at least the prior `seniorExpensesCapCarryforwardPeriods` periods of every deal.
2. Resolver computes seed entries from the historical step B+C amounts vs computed stated cap at each prior determination date.
3. Thread the seed through `buildFromResolved` (likely as a derived field on `ResolvedDealData` rather than `UserAssumptions` — the seed is structural deal state, not a user input).
4. Marker test asserts the non-zero seed magnitude on a fixture with multi-period historical data.
5. Flip the existing marker (described below) from `=== 0` to the computed magnitude.

**Test:** `web/lib/clo/__tests__/c3-senior-expenses-cap.test.ts` — marker pinning `result.periods[0].stepTrace.seniorExpensesCapCarryforwardSum === 0` on a mid-life Euro XV projection with `seniorExpensesCapCarryforwardPeriods=3`. The empty-buffer behavior is exactly the silent under-count the KI describes; closing the KI flips the assertion to the computed seed magnitude.

---

<a id="ki-46"></a>
### [KI-46] DDTL draw event inflates forward OC numerator; `impliedOcAdjustment` frozen at T=0 calibration — **BLOCKED ON DATA ACQUISITION**

**PPM reference:** Aggregate Principal Balance definition paragraph (a) (OC p. 142): "outstanding principal amount of such Revolving Obligation or Delayed Drawdown Collateral Obligation, plus any undrawn commitments that have not been irrevocably cancelled". Adjusted Collateral Principal Amount definition (OC p. 101) paragraph (a) (APB) and paragraph (d) (Principal Account cash). Per PPM, AdjCPA carries APB which by definition INCLUDES unfunded DDTL commitments — a DDTL draw moves par from "outstanding amount" to "drawn balance" within paragraph (a), no net change to APB, and decrements paragraph (d) cash by the drawn amount.

**Current engine behavior:**
- Resolver at `web/lib/clo/resolver.ts:2419-2423` strips `ddtlUnfundedPar` (T=0 unfunded DDTL par) from `impliedOcAdjustment` so the engine's T=0 OC numerator reproduces the trustee's reported number under the engine convention "OC numerator excludes unfunded DDTL commitments".
- `impliedOcAdjustment` is then frozen as a scalar passed via `ProjectionInputs.impliedOcAdjustment`. The forward-period OC numerator at `web/lib/clo/projection.ts:3925-3927` subtracts both `(impliedOcAdjustment + currentDdtlUnfundedPar)`. When a DDTL with `survivingPar = D` draws at quarter `q` (engine flips `isDelayedDraw = false`, par moves from unfunded → funded bucket via `web/lib/clo/projection.ts:1396-1401`), `endingPar` grows by `D` and `currentDdtlUnfundedPar` shrinks by `D`. Net forward OC numerator change is `+2D`. Trustee AdjCPA target change is at most `+D` (engine convention) or `0` (PPM convention — bucket-only move). Engine over-states forward OC numerator by `D` (engine convention) or `2D` (PPM convention) per period from `q` forward.

**PPM-correct behavior:** The fix shape is documented inline at `web/lib/clo/resolver.ts:2424-2440`. Track `cumulativeDdtlDrawnPar` in the engine, increment at the DDTL draw event, and either (a) subtract from forward OC numerator alongside `impliedOcAdjustment + currentDdtlUnfundedPar`, or (b) re-calibrate `impliedOcAdjustment` per period using the engine's running pool state. Option (a) is smaller; option (b) generalizes to other forward dynamics that may surface analogous frozen-scalar drift.

**Quantitative magnitude (Euro XV today):** Zero. Euro XV's compliance report at the latest payment date (Apr 15 2026) carries `ddtlUnfundedPar ≈ €581K` but no DDTL draw events scheduled within the projection horizon (the harness's fixture-regeneration test confirms `impliedOcAdjustment ≈ €0` on Euro XV — close-enough to zero that the bucket-move drift produces no observable wrong number). The bug is dormant on the only ingested deal; activates immediately on any deal where (i) a DDTL has `drawQuarter` within the projection horizon AND (ii) `impliedOcAdjustment > 0`.

**Quantitative magnitude (synthetic test fixture):** With pool €210M, €10M DDTL drawing fully at q=4, `impliedOcAdjustment = €1M`, default tranches at €65M Class A debt: forward OC ratio jumps by >10 percentage points at the draw quarter (from `~3 OC points pre-draw` to `~14 OC points post-draw` in the marker test's units). Pinned by the marker.

**Deferral rationale (data constraint, not implementation difficulty):**

The fix shape is straightforward. What's blocked is *verifying* the fix produces the right number. Two unknowns require external data:

1. **Trustee `totalPar` convention.** The SDF's `totalPar` field (which feeds `pool.totalPar` in the resolver) may carry the PPM-literal AdjCPA (which includes unfunded DDTL via APB(a)) or a derived figure that excludes unfunded DDTL. The convention varies by trustee (BNY's report on Euro XV vs another trustee on a different deal). Without checking against an actual report on a deal with non-zero DDTL draws, a fix that assumes one convention may be silently wrong under the other. A wrong fix would flip the over-statement direction (engine under-states by `D` per period instead of over-stating).

2. **DDTL draw event in the SDF transactions table.** The current ingestion pipeline (`web/lib/clo/sdf/parse-transactions.ts`) reads transaction rows, but the engine's `drawQuarter` field on `LoanInput` is not populated from this — it's a user assumption (`UserAssumptions.ddtlDrawQuarter`). To validate the fix's forward dynamics against trustee reality, we need a deal whose trustee reports a draw event at a specific quarter AND whose post-draw OC ratio is known to the cent. Euro XV's BNY report has no such event in the historical period covered.

**Path to close:**

1. **Acquire** a quarterly trustee bundle (SDF + BNY note valuation PDF + Intex past cashflows) for a deal with at least one DDTL draw event within the recent reporting period AND a non-trivial `impliedOcAdjustment` (residual between trustee Adjusted CPA and components the engine identifies). The deal needs: (a) DDTL positions classified `is_delayed_draw = true` at one period, then funded at a later period in the trustee's holdings table; (b) the trustee-reported Adjusted CPA at both periods; (c) ideally `impliedOcAdjustment > 0` at T=0 (so the strip at `resolver.ts:2422` actually fires and the bug surfaces).

2. **Verify** the trustee's `totalPar` convention by comparing PPM AdjCPA(a)+(d) computation against the trustee-reported number. If they match within €1k, trustee uses PPM-literal convention. If trustee = PPM AdjCPA - unfunded, trustee uses the engine's "exclude unfunded" convention. Document the result.

3. **Implement** the chosen variant of the fix:
   - **Variant A** (engine-convention target): track `cumulativeDdtlDrawnPar`; subtract from forward OC numerator alongside `impliedOcAdjustment` and `currentDdtlUnfundedPar`. Engine forward OC = AdjCPA - currentDdtlUnfundedPar (matches trustee under engine convention).
   - **Variant B** (PPM-convention target): track `cumulativeDdtlDrawnPar`; subtract from forward OC numerator AND remove the `currentDdtlUnfundedPar` subtraction entirely. Engine forward OC = AdjCPA (matches trustee under PPM convention).

4. **Test:** flip the marker assertion below from `> 10` (current bug magnitude) to `< 0.5` (corrected — bucket-move produces only the natural per-period OC drift from interest accrual / cash redistribution, not the +D or +2D inflation).

5. Update the inline comment at `resolver.ts:2422-2440` to describe the closure rather than the open question.

**Test:** `web/lib/clo/__tests__/projection-fixed-rate-ddtl.test.ts > KI-46-ddtlPostDrawOcInflation`. Synthetic fixture (€210M pool, €10M DDTL drawing fully at q=4, `impliedOcAdjustment = €1M`, default tranches) pinning the OC ratio jump > 10 points at the draw quarter. Marker flips when the fix lands.

---
