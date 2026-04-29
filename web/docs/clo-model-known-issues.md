# CLO Projection Model — Known Issues Ledger

Every PPM mechanic the model doesn't currently simulate, or simulates with documented drift, is listed below. This ledger is the reference for what the model *deliberately does not model* and what drift you should expect when comparing our engine to trustee-reported data.

Each entry carries:

- **PPM reference** — clause / section / page where the mechanic is specified.
- **Current engine behavior** — exactly what the code does today.
- **PPM-correct behavior** — what the model would do if the gap were closed.
- **Quantitative magnitude** — order-of-magnitude impact; where possible, per-deal euros and basis-points cumulative.
- **Deferral rationale** — why it's in the ledger rather than fixed.
- **Path to close** — specific sprint / plan reference + remaining effort.
- **Test** — forward-pointer(s) to the `failsWithMagnitude` marker(s) asserting the current documented magnitude. Ledger ↔ test is a bijection: when a fix lands, the marker must be removed AND this entry moved to Closed.

Updated per sprint. Entries are closed (marked `[CLOSED]`) when the corresponding fix ships and is verified in the N1 harness.

---

## Index

Categorized so a partner reading cold can separate "what's still wrong" from "what we decided." Section membership is authoritative; the numerical KI order is historical (sprint-chronological).

### Open — currently wrong, path to close documented
- [KI-12a — Senior / sub management fee base discrepancy](#ki-12a)
- [KI-16 — KI-08 closure assumptions pending PPM verification](#ki-16)
- [KI-17 — wacSpreadBps methodology gap (±30 bps drift vs trustee)](#ki-17)
- [KI-18 — pctCccAndBelow coarse-bucket collapse (±3pp vs trustee per-agency max)](#ki-18)
- [KI-20 — D2 legacy escape-hatch on 6 test-factory sites](#ki-20)
- [KI-21 — Parallel implementations of same calculation (PARTIAL — Scope 1+2 closed; Scope 3 accel + T=0 remains)](#ki-21)
- [KI-23 — Industry taxonomy missing on BuyListItem + ResolvedLoan blocks industry-cap filtering](#ki-23)
- [KI-24 — E1 citation propagation coverage is partial (8 deferred paths)](#ki-24)

### Deferred — intentionally not modeled, magnitude known
- [KI-02 — Step (D) Expense Reserve top-up](#ki-02)
- [KI-03 — Step (V) Effective Date Rating Event redemption](#ki-03)
- [KI-04 — Frequency Switch mid-projection cadence/rate switch (C4 Phase 3)](#ki-04)
- [KI-05 — Supplemental Reserve Account (step BB)](#ki-05)
- [KI-06 — Defaulted Hedge Termination (step AA)](#ki-06)
- [KI-07 — Class C/D/E/F current + deferred interest bundled in step map](#ki-07)
- [KI-15 — B2 accelerated-mode incentive fee hardcoded inactive](#ki-15)

### Cascades — residuals that close as upstream closes
- [KI-12b — Day-count precision active; six class-interest markers under harness period mismatch](#ki-12b)
- [KI-13 — Sub distribution cascade residual](#ki-13)
- [KI-14 — IC compositional parity at T=0 (cascade)](#ki-14)

### Design decisions — documented for audit clarity (not open issues)
- [KI-19 — NR positions proxied to Caa2 for WARF (Moody's convention)](#ki-19)

### Closed — fixes shipped, verification green
- [KI-01 — Step (A)(ii) Issuer Profit Amount **(CLOSED Sprint 4)**](#ki-01)
- [KI-08 — `trusteeFeesPaid` bundled steps B+C **(PARTIALLY CLOSED — pre-fill D3 + cap mechanics C3; see KI-16 for the 3 remaining assumptions)**](#ki-08)
- [KI-09 — Step (A)(i) Issuer taxes **(CLOSED Sprint 3)**](#ki-09)
- [KI-10 — baseRate pre-fill gap **(CLOSED D3)**](#ki-10)
- [KI-11 — Senior / sub management fee rate pre-fill **(CLOSED D3; fee-base tracked as KI-12a)**](#ki-11)
- [KI-22 — Fixture-regeneration test was a spot-check for 20 days **(CLOSED Sprint 4)**](#ki-22)
- [KI-25 — UI back-derivation of engine values (PeriodTrace + bookValue) **(CLOSED 2026-04-29)**](#ki-25)

---

<a id="ki-01"></a>
### [KI-01] Step (A)(ii) Issuer Profit Amount — CLOSED (Sprint 4, 2026-04-23)

**PPM reference:** Condition 1 definitions, p.127. €250 per regular period deducted from interest proceeds between taxes (A.i) and trustee fees (B). €500 per period post-Frequency-Switch Event (handled by KI-04 when that closes).

**Pre-fix behavior:** Not modeled. `stepTrace.issuerProfit` emitted 0. Engine `subDistribution` over-stated by exactly €250/period on Euro XV because the waterfall's `availableInterest -=` chain skipped step (A.ii).

**Pre-fix quantitative magnitude:** €250/quarter = €1,000/year on Euro XV. Cumulative ~€10,000 over a 10-year projection — immaterial in isolation but material to KI-13a cascade cleanliness (it was the last non-day-count bucket feeding into the sub residual).

**Fix (Sprint 4):** `issuerProfitAmount` added to `ProjectionInputs` + `UserAssumptions` (absolute € per period, not bps). Engine deducts at PPM step (A.ii) position — after taxes at (A.i), before trustee at (B) — in both:
- **Normal mode** (`projection.ts`): added to `totalSeniorExpenses` for IC parity AND to the `availableInterest -=` chain for cash flow. The first fix without the second emits correctly on stepTrace but never removes the €250 from sub residual — caught by the KI-13a cascade probe before ship. See [KI-21](#ki-21) for the architectural tracking of the two-parallel-accumulator pattern.
- **Accelerated mode** (`runPostAccelerationWaterfall`): new `seniorExpenses.issuerProfit` field on the executor input + output, same priority position. PPM 10(b) preserves step ordering under acceleration.
- **T=0 initial state** (`initialState.icTests`): `issuerProfitAmountT0` added to the IC numerator deduction chain alongside taxes / admin / trustee / senior / hedge so compositional parity tracks the in-loop computation.

**Pre-fill:** `defaultsFromResolved` back-derives from `raw.waterfallSteps` step (A)(ii). Regex matches `"(A)(ii)"` or `"A.ii"` formats. Sanity bound: 0 < amount < €1,000 (covers €250 regular + €500 post-Frequency-Switch). Euro XV Q1 observed: €250.00 exactly.

**Cascade re-baseline:** KI-13a expected drift −€50,742.24 → −€50,992.24 (Δ = −€250 exact, matches engine emission to the cent — no day-count residual since amount is fixed absolute, not accrued).

**Cascade sub-tolerance verification (KI-IC-AB/C/D + KI-13b):** The €250 deduction flows into the IC numerator (`totalSeniorExpenses`) as well as cash flow. Measured Δ_IC per class from T=0 initialState probe: Class C = −0.00828 pp (denom ≈ €3.02M), Class D = −0.00722 pp (denom ≈ €3.46M). Class A/B denom is smaller (≈ €2.68M interest due), so |Δ_pp| ≈ −250 / 2,681,150 × 100 = −0.0093 pp. All three classes shift under the 0.05 pp tolerance → no KI-IC re-baseline required. KI-13b production-path markers use the same math — unchanged.

**Verification:** Engine emits €250.00/period, ties to trustee €250.00 to the cent. N1 harness `issuerProfit` bucket tolerance tightened from Infinity → €1 (now the tightest tolerance in the step table). 558/558 tests green post-close.

**Tests:** `n1-correctness.test.ts > "KI-01 CLOSED: engine emits €250 issuer profit, ties to trustee to the cent"`. Shipped as a closed-KI positive-enforcement assertion (`row.projected ≈ 250, |delta| < 1`) replacing the prior informational "engine emits 0; trustee collected €250" marker.

---

<a id="ki-02"></a>
### [KI-02] Step (D) Expense Reserve top-up

**PPM reference:** Condition 3.3(d).
**Current engine behavior:** Not modeled; engine emits 0 at step (D).
**PPM-correct behavior:** CM-discretionary deposit during Reinvestment Period to maintain senior-expense headroom.
**Quantitative magnitude:** €0 in Euro XV Q1 2026 waterfall. Typically €0 in steady-state; activates only when senior-expense accruals are building toward the cap.
**Deferral rationale:** Discretionary and rarely activated. Our observed data has zero Q1 expense-reserve deposit across Euro XV's 17-period Intex history.
**Path to close:** Add `expenseReserveDepositBps` user input; engine routes to reserve account. ~0.5 day when exercised.
**Test:** No active marker — both engine and trustee emit 0 on Euro XV. The `expenseReserve` row in the N1 harness table (Infinity tolerance) is the passive audit channel; a non-zero trustee value on a future deal would surface via that row.

---

<a id="ki-03"></a>
### [KI-03] Step (V) Effective Date Rating Event redemption

**PPM reference:** Condition 7.3, p.180.
**Current engine behavior:** Not modeled; engine has no rating-downgrade detection. `stepTrace.effectiveDateRating` emits 0.
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
**Path to close:** ~3–5 days standalone. Trigger: a deal where the trigger actually fires, or a partner request.
**Test:** No active marker — trigger does not fire on Euro XV (0% Frequency-Switch-Obligation concentration). Future deals that trip the trigger would surface as a cadence mismatch in the N1 harness period-count row.

---

<a id="ki-05"></a>
### [KI-05] Supplemental Reserve Account (step BB)

**PPM reference:** Condition 3.3(b).
**Current engine behavior:** Not modeled. `stepTrace.supplementalReserve` emits 0.
**PPM-correct behavior:** CM-discretionary deposit during Reinvestment Period, funds reinvestment buffer.
**Quantitative magnitude:** Not exercised on Euro XV per observed waterfall data.
**Deferral rationale:** CM-discretionary; not used in current operations.
**Path to close:** ~0.5 day when exercised.
**Test:** No active marker — engine and trustee both 0 on Euro XV. The `supplementalReserve` row in the N1 harness table (Infinity tolerance) surfaces if a deal exercises it.

---

<a id="ki-06"></a>
### [KI-06] Defaulted Hedge Termination (step AA)

**PPM reference:** Condition 3.3(a).
**Current engine behavior:** Modeled as 0. Non-defaulted hedge payments flow through step (F) (`stepTrace.hedgePaymentPaid`).
**PPM-correct behavior:** Activates if a hedge counterparty defaults; termination payments flow through accelerated position in step (AA).
**Quantitative magnitude:** 0 in current data; activates only in hedge-counterparty-default scenarios (rare).
**Deferral rationale:** Contingent on counterparty default; model would need hedge-counterparty state which the upstream data pipeline doesn't track.
**Path to close:** Out of scope without hedge counterparty data pipeline.
**Test:** No active marker — activates only on counterparty default. `defaultedHedgeTermination` in the N1 harness table (Infinity tolerance) surfaces the magnitude if it ever triggers.

---

<a id="ki-07"></a>
### [KI-07] Class C/D/E/F current + deferred interest bundled in step map

**PPM reference:** PPM step codes (J)+(K), (M)+(N), (P)+(Q), (S)+(T).
**Current engine behavior:** Engine emits combined interest output per class (e.g. `classC_current` = PPM step J only; deferred K is tracked separately in `stepTrace.deferredAccrualByTranche`).
**PPM-correct behavior:** Separate step lines for current interest (J/M/P/S) and deferred interest (K/N/Q/T).
**Quantitative magnitude:** 0 drift on Euro XV Q1 2026 (no deferred interest on any class). Under deferred-interest stress, bundled output can't be cleanly compared against split trustee lines.
**Deferral rationale:** No deferred state in current data; split engine output requires engine refactor.
**Path to close:** Post-B2 refinement. ~0.5 day after B1+B2 (compositional EoD + post-acceleration) land. Engine acquires per-class deferred-balance state in those sprints; splitting the bucket becomes trivial.
**Test:** `n1-correctness.test.ts > "green buckets" > Class C/D/E/F deferred interest is zero (no stress)`. No stress case exists on Euro XV; under deferred-interest stress the bundled output can't be cleanly asserted against the split trustee lines, and this assertion will need to move into a `failsWithMagnitude` marker.

---

<a id="ki-08"></a>
### [KI-08] `trusteeFeesPaid` bundled steps B+C — **PARTIALLY CLOSED (pre-fill D3 + cap mechanics C3)**

**Status (2026-04-23, Sprint 3 C3 landed):** Mechanics shipped; three design assumptions remain unverified against the Ares European XV PPM. Tracking the open verifications under [KI-16](#ki-16) so the ledger does not overclaim closure.

**What shipped:**

1. **Pre-fill (D3, Sprint 2)**: `defaultsFromResolved` back-derives `trusteeFeeBps` AND `adminFeeBps` separately from Q1 waterfall steps B + C (Euro XV: 0.0969 bps trustee, 5.147 bps admin, 5.244 combined).
2. **Cap + overflow (C3, Sprint 3)**: `ProjectionInputs.adminFeeBps` + `ProjectionInputs.seniorExpensesCapBps` added. Engine emits trustee + admin fees jointly capped at `seniorExpensesCapBps` × beginningPar × dayFrac; overflow routes to PPM steps (Y) trustee-overflow and (Z) admin-overflow, paying from residual interest after tranche interest + sub mgmt fee.

**What is NOT verified yet (blocks "FULLY CLOSED" status — tracked in [KI-16](#ki-16)):**
- **20 bps cap default** when `defaultsFromResolved` cannot infer from observed data: a reasonable heuristic but not cross-referenced against the Ares XV PPM Senior Expenses Cap definition.
- **2× observed heuristic** for the cap default when Q1 observed is present (`max(2× observed, 20 bps)`): protects against breaching the cap with modest fee growth, but the "2×" multiple is engineering judgment, not a PPM-documented buffer.
- **Pro-rata overflow allocation** between `trusteeOverflowPaid` and `adminOverflowPaid`: the engine splits overflow proportionally to the requested trustee vs admin shares, but the PPM may specify sequential payout (trustee first, then admin) or a different allocation rule.

**Partner-visible behavior on Euro XV**: observed combined ~5.24 bps well below default cap of 20 bps → no overflow, `trusteeFeesPaid` ties to trustee within €722 (day-count residual from 91/360 engine vs 90/360 trustee). Stress scenarios with observed > cap produce proportional overflow split between trustee and admin buckets. The three assumptions only bite in stress scenarios; Euro XV base case is unaffected.

**Tests (7 new C3 tests):**
- `c3-senior-expenses-cap.test.ts` — base case (no overflow), high-fee overflow (50 bps + 20 bps cap → 30 bps overflow), extreme cap (1 bps), overflow-limited-by-residual, backward-compatibility (undefined cap = unbounded).
- `d3-defaults-from-resolved.test.ts` — `trusteeFeeBps` + `adminFeeBps` separately back-derived; sum matches pre-C3 combined extraction; `seniorExpensesCapBps` derivation from Q1 observed.
- `b2-post-acceleration.test.ts` — under acceleration (PPM 10(b)) trustee + admin pay uncapped; regression guard asserts `stepTrace.adminFeesPaid / trusteeOnly = adminFeeBps / trusteeFeeBps` exactly.

**Cascade re-baselines**: KI-13a adjusted by the C3 split preserving aggregate behavior; `stepTrace.trusteeFeesPaid` currently bundles steps (B)+(C)+(Y)+(Z) to preserve the N1 harness bucket semantics. Split-out fields (`adminFeesPaid`, `trusteeOverflowPaid`, `adminOverflowPaid`) are additive diagnostic fields — the harness will be un-aggregated in a follow-up (see task #48).

**Ledger disposition**: remain OPEN (partial) until KI-16 resolves the three PPM verifications. Then move to Closed issues.

---

<a id="ki-09"></a>
### [KI-09] Step (A)(i) Issuer taxes — CLOSED (Sprint 3, 2026-04-23)

**PPM reference:** Condition 1 definitions (Issuer profit / tax provisions); step (A)(i) in the interest waterfall.

**Pre-fix behavior:** Not modeled. `stepTrace.taxes` emitted 0. Engine `subDistribution` over-stated by ~€6,133/quarter on Euro XV because taxes never came out of the top of the waterfall.

**Pre-fix quantitative magnitude:** €6,133/quarter = €24,532/year on Euro XV. On a €42.56M equity cost basis (95c × €44.8M sub par) ≈ 5.8 bps annual drag; cumulative ~€245K over a 10-year projection.

**Fix (Sprint 3):** `taxesBps` added to `ProjectionInputs` + `UserAssumptions`. Engine deducts taxes at step (A)(i) before any other senior expense. `stepTrace.taxes` emits the amount. `defaultsFromResolved` back-derives `taxesBps` from raw `waterfallSteps` step (A)(i) annualized on beginningPar (Euro XV: 0.497 bps = €6,133/quarter, matched to the cent). Accel branch (B2) also passes `taxesAmount` through to the post-acceleration executor since taxes remain payable under acceleration per PPM 10.

**Verification:** Engine produces €6,202/period vs trustee €6,133 = €69 day-count residual at 91/360 vs 90/360. Decomposed: engine taxesAmount = beginningPar × (taxesBps / 10000) × (91 / 360), trustee reports annualized tax × (90 / 360) window. On the €493.3M Euro XV pool at 0.497 bps the ratio is 91/90 = 1.0111, so residual ≈ €6,133 × 0.0111 = €68.7 (matches observed €69 to the cent). Same day-count mechanic as KI-12b for tranche interest — it's a harness-period-mismatch artifact, not an engine bug; closes with KI-12a.

**Cascade re-baseline:** N1 harness `taxes` bucket tolerance tightened from Infinity to €100. KI-13a cascade re-baselined from −€44,540 to −€50,742 (Δ = −€6,202 matching engine emission to the euro). KI-IC-AB/C/D cascade moved ~1-2 pp on each class (see KI-14).

---

<a id="ki-10"></a>
### [KI-10] baseRate pre-fill gap (D3 family) — **CLOSED (D3, 2026-04-23)**

**Status:** Closed in Sprint 2 / D3. `defaultsFromResolved(resolved, raw)` pre-fills `baseRatePct` from `raw.trancheSnapshots[*].currentIndexRate` when available (Euro XV: 2.016%). Both `n1-correctness.test.ts` and the ProjectionModel UI now use this helper; the static 2.1% default only applies when no observed rate is present in the snapshot feed.

**Closing commit work:** ~2 hrs (helper + 9 unit tests + wire-up in 2 consumers).
**Residual behavior:** None. The six per-class Euro XV drifts previously attributed to KI-10 (€65K on Class A, ~€28K across B-F combined per quarter) were bundled with KI-12b day-count drifts; after D3, what remains on those buckets is purely KI-12b (harness period mismatch, one extra day of accrual).
**Test:** `d3-defaults-from-resolved.test.ts` — 9 tests anchoring the pre-fill behavior including Euro XV observed-EURIBOR spot-check (2.016% matches fixture).

---

<a id="ki-11"></a>
### [KI-11] Senior / sub management fee **rate** pre-fill — **CLOSED (D3); FEE-BASE REMAINS OPEN (KI-12a)**

**Status (2026-04-23):** Partial close. Pre-fill of `seniorFeePct` / `subFeePct` / `incentiveFeePct` / `incentiveFeeHurdleIrr` landed in Sprint 2 / D3 via `defaultsFromResolved`. The resolver's PPM extraction had always populated `resolved.fees.*`; D3 is the plumbing that makes those flow into `UserAssumptions` as pre-fill defaults. The KI-11 **rate** pre-fill gap is closed.

**What REMAINS open (tracked under KI-12a, not KI-11):** The ~€22.35M fee-BASE discrepancy — engine computes fees off `beginningPar` (current fixture snapshot = €493.3M) while trustee computes off prior Determination Date balance (= €470.9M). This is the N1 harness period-mismatch, structurally distinct from rate pre-fill. **Do not conflate: D3 closed the wrong-rates problem; the wrong-base problem is KI-12a's territory.**
**Residual behavior:** None from KI-11. The €24,354 subMgmtFee / €10,438 seniorMgmtFee N1 drifts that remain on Euro XV are KI-12a (period mismatch) + KI-12b (day-count on 91/360), not KI-11.
**Test:** `d3-defaults-from-resolved.test.ts` — fee-rate pre-fill tests; expected senior=0.15%, sub=0.35%, incentive=20%, hurdle=12%.

---

<a id="ki-12a"></a>
### [KI-12a] N1 harness period mismatch — engine Q2 projection vs trustee Q1 actual

**Context:** This entry was originally framed as "Senior/sub management fee base discrepancy (attribution pending)" and then narrowed to "fee-base period-timing snapshot error." Independent review flagged that the actual issue is one level up: **the N1 harness is not a Q1 replay at all — it's a Q2 forward projection compared against Q1 trustee data.** The fee drift is the symptom most visible; the cause is structural to the harness.

**Evidence that the harness runs Q2, not Q1:**

- `projection.ts:184` `addQuarters(dateIso, q)` + `projection.ts:413` `periodDate = addQuarters(currentDate, q)`.
- Fixture `resolved.dates.currentDate = 2026-04-01`.
- `addQuarters('2026-04-01', 1) = '2026-07-01'` — period 1 is July, not April.
- `backtest-harness.ts:154` uses `result.periods[0]`; `:221` pulls the trustee `paymentDate` from `backtest` (Apr 15 2026 in the fixture). **These are different quarters.**

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

Not closed by Sprint 1 / B3 (day-count) or Sprint 3 / C3 (fee pre-fill). Structural harness work, estimated ~1 day including fixture re-extraction and re-baseline of every marker.

**Test:** `n1-correctness.test.ts > "currently broken buckets" > seniorMgmtFeePaid | subMgmtFeePaid` — two `failsWithMagnitude` markers (ki: `KI-12a-seniorMgmt`, `KI-12a-subMgmt`). These markers currently measure *harness period-mismatch drift*, not engine fee-base error. When the harness fix ships, both markers must be re-baselined (likely to near-zero) or removed and replaced with correctness assertions on the residual post-fix drift.

**Scope note (B2 accelerated mode):** KI-12a's fee-base discrepancy applies in BOTH normal and accelerated-waterfall modes. B2's accelerated executor receives `trusteeFeeAmount`, `seniorFeeAmount`, `hedgeCostAmount` computed via the same `beginningPar * rate * dayFrac` formula as normal mode — it inherits the same fee-base gap. A partner who digs into a stress-scenario demo will see senior-expense numbers that carry the same ~€27K/quarter drift from PPM-exact as normal mode. The fix for KI-12a (harness fixture regeneration at prior Determination Date, or multi-period historical harness) closes the gap in both modes simultaneously.

---

<a id="ki-12b"></a>
### [KI-12b] Day-count precision active; surfacing KI-12a period mismatch on 6 class-interest buckets

**Status (2026-04-23 update):** B3 shipped. `dayCountFraction` helper + per-tranche convention (Actual/360 float, 30/360 fixed) replaced the legacy `/4` everywhere in the period loop. First-principles arithmetic tests (`b3-day-count.test.ts`, 11 cases) anchor the helper to PPM worked example `2.966% × 310M × 90/360 = €2,298,650`.

**What KI-12b now represents:** residual drift on the harness's six class-interest buckets caused by the KI-12a period mismatch becoming arithmetically visible. Pre-B3, the `/4 = 90/360` coincidence masked this — engine Q2 (91 days) and trustee Q1 (90 days) produced identical tranche coupons under /4. Post-B3, engine Q2 accrues Actual/360 on 91 days and diverges from trustee's 90-day window by one day of interest per tranche.

**PPM reference:** Condition 1 — "Day count (Actual/360 float, 30/360 fixed)"; confirmed via `ppm.json` grep and PPM worked example (see KI-12a).
**Current engine behavior:** B3 landed. Engine uses `dayCountFraction("actual_360"|"30_360", periodStart, periodEnd)` for tranche coupons, loan interest, and all management/trustee/hedge fees. `trancheDayFrac(t) = t.isFloating ? dayFracActual : dayFrac30`.
**PPM-correct behavior:** Per-tranche day-count convention + actual days in the period. Applies across every interest-denominated step (tranche coupons, management fees, hedge legs).

**Quantitative magnitude — the B3 / KI-12a interaction (new in 2026-04-23 review):**

The Class A/B/C/D/E/F interest tie-outs currently pass at |drift| < €1 under legit pins in `n1-correctness.test.ts`. That's a **coincidence that B3 will break**, because:

- Under interpretation B (see KI-12a), engine's period 1 is **Q2 2026 = Apr 15 → Jul 15 = 91 days** (30+31+30).
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

**PPM reference:** Step (DD) — residual to sub (equity) note.
**Current engine behavior:** `subDistribution` is the residual bucket; every upstream drift (taxes, trustee fee, mgmt fees, fee-base) cascades into it. Direction depends on the net sign of those drifts.
**PPM-correct behavior:** N/A — this is a cascade, not an independent mechanic. Closes automatically as upstream KIs close.
**Quantitative magnitude:**
- Engine-math (legit pins): −€607.93/quarter. Counter-intuitive negative sign: fee-base over-payment on senior/sub mgmt fees (+€27,941 combined, KI-12a) + incentive-fee circular solver rounding more than offset the engine's missing trustee fee (−€64,660, KI-08). Exposes the sign-cancellation trap — multiple drifts can compound or cancel.
- Production path (no pins): +€617,122/quarter. Under no pre-fill, engine under-pays every fee line, so subDistribution absorbs all of those missed outflows.
**Deferral rationale:** Structural — residual that tracks the sum of upstream corrections.
**Path to close:** Closes progressively as KI-01 / KI-08 / KI-09 / KI-10 / KI-11 / KI-12a close. No standalone work.
**Test:** `n1-correctness.test.ts > "currently broken buckets" > subDistribution` (ki: `KI-13a-engineMath`, expectedDrift −€607.93 ± €50). `n1-production-path.test.ts > "sub distribution cascade" > subDistribution` (ki: `KI-13b-productionPath`, expectedDrift +€617,122.40 ± €1,000). Both expectedDrifts must be re-baselined (or the markers removed if drift closes) whenever an upstream KI moves.

**⚠ Maintenance checklist** — include in every PR that closes or moves an upstream KI (01 / 08 / 09 / 10 / 11 / 12a):
- [ ] Did this PR close or modify an upstream KI's expected drift magnitude?
- [ ] If yes: re-run the harness and update `KI-13a-engineMath.expectedDrift` in `n1-correctness.test.ts`.
- [ ] If yes (and KI-10/11 moved): same for `KI-13b-productionPath.expectedDrift` in `n1-production-path.test.ts`.
- [ ] If the cascade drift dropped below tolerance, remove the failsWithMagnitude marker and move KI-13 to Closed.
- [ ] Note: signs can flip during the close sequence — re-check the sign, not just the magnitude.

---

<a id="ki-14"></a>
### [KI-14] IC compositional parity at T=0 (cascade residual)

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

<a id="ki-15"></a>
### [KI-15] B2 accelerated-mode incentive fee hardcoded inactive

**PPM reference:** Post-acceleration Priority of Payments step (V) — "Incentive Collateral Management Fee (if Incentive Fee IRR Threshold met)." Same IRR-threshold mechanics as the normal-mode step (CC) / (U).
**Current engine behavior:** B2's accelerated executor is called with `incentiveFeeActive: false` hardcoded at `projection.ts` in the accel branch (deliberate simplification). Under acceleration the incentive fee is emitted as zero regardless of whether equity cash-flow history would satisfy the IRR hurdle.
**PPM-correct behavior:** Run the same IRR-threshold test used in normal-mode step (CC), on the combined pre-breach + accelerated-mode equity cash-flow series. If the hurdle is met, incentive fee fires at the configured percentage; else zero.
**Quantitative magnitude:** Scenario-dependent. Under most distressed paths the hurdle is NOT met (equity cash flows collapse under acceleration — if the deal is accelerating, it's usually because upstream losses have swamped distributions), so the hardcoded behavior matches PPM intent within tolerance. BUT in scenarios where pre-breach equity distributions were large (e.g., a previously well-performing deal that trips EoD late in the reinvestment period due to a single large default cluster), the accumulated equity IRR may still clear the hurdle. In those scenarios, the hardcoded `false` under-reports incentive fee owed and over-reports residual to Sub Notes.
**Deferral rationale:** Restoring the IRR solver under acceleration requires carrying equity-cash-flow state across the normal → accelerated mode transition and wiring the same `resolveIncentiveFee` circular solver used in normal mode. Not structural; tedious. Low priority relative to the Sprint 2 B1+B2 scope.
**Path to close:** Add `incentiveFeeActive` computation in the engine's accel branch: call `resolveIncentiveFee` with the current equity-cash-flow series and hurdle, pass the resulting active flag + computed fee to the executor. ~0.5 day.
**Test:** No active marker — requires a synthetic scenario where pre-breach equity distributions accumulate above the hurdle, then EoD triggers. Not covered by current B2 stress tests (which use low-MV + high-default scenarios that have near-zero pre-breach distributions). When the fix lands, add a test that constructs such a scenario and verifies incentive fee fires correctly under acceleration.

---

<a id="ki-16"></a>
### [KI-16] KI-08 closure assumptions pending PPM verification

**PPM reference:** Condition 10 (Senior Expenses Cap) + steps (Y) / (Z) (post-cap overflow distribution). Ares European XV PPM — sections have not yet been cross-referenced against the C3 implementation.

**What is assumed without PPM confirmation:**

1. **20 bps default cap** when no observed Q1 senior-expense data is present. The engine falls back to 20 bps × beginningPar × dayFrac; this is a market-convention heuristic, not an Ares XV-specific figure. If the PPM specifies a different absolute bps cap, all stress-scenario overflow math is off by the ratio.
2. **`max(2× observed, 20 bps)` heuristic** when D3 can infer observed fees. The "2×" buffer is engineering judgment to keep the cap from biting in modest fee-growth scenarios; the PPM may specify a different buffer (1.5×, 3×) or no heuristic at all (cap is a hard bps number independent of observed).
3. **Pro-rata overflow allocation** between trustee and admin overflow buckets (steps Y / Z). The engine splits overflow proportionally to each component's uncapped request. The PPM may specify sequential payout (trustee overflow pays before admin overflow), or a fixed allocation (e.g., admin gets 100% of overflow up to a sub-cap). Under Euro XV base case observed is below cap so this doesn't manifest; under stress it drives whether trustee or admin is under-paid first.

**Quantitative magnitude:** Zero on Euro XV base case (observed < cap → no overflow). Material in stress scenarios: the C3 high-fee overflow test uses 50 bps requested vs 20 bps cap → 30 bps overflow = ~€37K/quarter on beginningPar €493M, and the current pro-rata split routes ~€36K to trustee overflow and ~€1K to admin overflow. If PPM specifies sequential payout trustee-first, the numbers don't change; if sequential admin-first, the split flips.

**Path to close:** Read the Ares European XV PPM sections on Senior Expenses Cap and steps (Y) / (Z). Compare against `projection.ts:1764-1773` overflow logic and `build-projection-inputs.ts` cap default derivation. Either (a) confirm the three assumptions are correct and promote KI-08 to FULLY CLOSED, or (b) amend the engine to match PPM and re-run C3 tests.

**Estimated effort:** ~1 hour (PPM read + cross-reference + small code amendment if needed). Blocked only on having the PPM available.

**Tests:** C3 tests continue to pin the current assumptions. When the PPM read completes, the stress-scenario tests may need their expected overflow values re-calibrated; the base-case Euro XV test is insensitive.

---

<a id="ki-17"></a>
### [KI-17] wacSpreadBps methodology gap (Sprint 3 C2)

**PPM reference:** Condition 1 / definitions — "Weighted Average Spread". Trustee reports pool WAS via a specific methodology that likely (a) adjusts fixed-rate coupons to a floating equivalent via `(coupon − baseRate) × par`, (b) excludes defaulted or discount-obligation positions from the denominator, and/or (c) applies a PPM-defined WAS formula that differs from a simple par-weighted average of `spreadBps`.

**Current engine behavior:** `PeriodQualityMetrics.wacSpreadBps` in `projection.ts` is a par-weighted average of `LoanState.spreadBps` as-set by the resolver. At T=0 on Euro XV the engine emits ~397 bps vs trustee 368 bps — a systematic +29 bps drift.

**PPM-correct behavior:** Match the trustee's WAS methodology bit-for-bit.

**Quantitative magnitude:** ±30 bps at T=0 (≈8% relative). Grows or shrinks as fixed-rate loans default or are added via reinvestment.

**Impact on compliance enforcement:** Euro XV's Minimum WAS trigger is 3.65% vs observed 3.68% — a **3 bps cushion**. Engine's ±30 bps uncertainty straddles that cushion by 10×. C1 reinvestment compliance explicitly does NOT enforce against the WAS trigger until this gap closes; the Minimum WAS check is left as a partner-facing advisory (not a hard block).

**Path to close:** Read Ares European XV PPM "Weighted Average Spread" definition. Amend `computeQualityMetrics` to match — likely adjust fixed-rate loans to `max(0, fixedCouponPct − baseRatePct)` bps and exclude defaulted par from the denominator. Re-baseline the C2 T=0 parity test (`wacSpreadBps` tolerance from ±30 bps to ±5 bps). Then extend C1 enforcement to include Minimum WAS.

**Test:** `c2-quality-forward-projection.test.ts > "period-1 WARF, WAL, WAS match resolver within day-count tolerance"` — current tolerance ±30 bps on WAS documents the gap. When closed, tighten to ±5 bps and add an assertion that fixed-rate adjustment is applied.

**⚠ Test deletion required on closure:** `c1-reinvestment-compliance.test.ts > "Minimum WAS breach via reinvestment spread=0 does NOT block (KI-17 — deferred)"` is a deferred-enforcement honesty guard — it asserts the current non-enforcement behavior and **must be DELETED (not flipped) when KI-17 closes**. The PR that lands WAS enforcement must delete the test and replace it with a "spread=0 reinvestment is blocked" positive-enforcement assertion. A surviving honesty guard would assert an old non-enforcement claim against the new correct code.

---

<a id="ki-18"></a>
### [KI-18] pctCccAndBelow coarse-bucket collapse (Sprint 3 C2)

**PPM reference:** Condition 1 / definitions — "Caa Obligation", "CCC Obligation". Separate per-agency definitions (Moody's Caa1/Caa2/Caa3 + Ca + C, and Fitch CCC+/CCC/CCC-/CC/C). The trustee's "Caa and below" concentration test takes the **max across agencies** — a position counted by either rating agency flips it into the bucket.

**Current engine behavior:** `PeriodQualityMetrics.pctCccAndBelow` counts positions with `ratingBucket === "CCC"` from the engine's coarse `RatingBucket` ("AAA", "AA", "A", "BBB", "BB", "B", "CCC", "NR"). This collapses all sub-bucket and per-agency granularity into a single bucket, sourced from whichever rating the resolver picked (typically Moody's if available, else Fitch). It may also mis-treat defaulted positions depending on how the resolver assigns `ratingBucket` on default.

**PPM-correct behavior:** Compute per-agency buckets (Moody's Caa rollup, Fitch CCC rollup), take the max. Include defaulted positions in the Caa bucket (PPM convention).

**Quantitative magnitude:** ±3pp at T=0 on Euro XV (engine vs trustee reported 6.92%). That's ≈43% relative error on a compliance bucket.

**Impact on compliance enforcement:** Euro XV's Moody's Caa concentration trigger is ~7.5% vs observed 6.92% — a **0.58 pp cushion**. Engine's ±3 pp uncertainty is 5× the cushion. C1 reinvestment compliance explicitly does NOT enforce against the Caa concentration test until this gap closes.

**Path to close:** (a) Extend `ResolvedLoan` to carry per-agency rating tuples (e.g., `moodysRating`, `fitchRating`, `moodysIsCaa`, `fitchIsCcc`) already partially populated by the resolver. (b) Update `PeriodQualityMetrics.pctCccAndBelow` to compute max across agencies per position, summed over par. (c) Verify defaulted-position handling matches PPM convention. (d) Re-baseline the C2 T=0 parity test (tolerance from ±3 pp to ±0.1 pp).

**Test:** `c2-quality-forward-projection.test.ts > "period-1 WARF, WAL, WAS match resolver within day-count tolerance"` — current tolerance ±3 pp on pctCccAndBelow documents the gap. When closed, tighten to ±0.1 pp and extend C1 to enforce the Caa concentration test.

**⚠ No active honesty-guard test yet** (C1 test file currently guards only the WAS path via the KI-17 test). When KI-18 closure extends C1 to enforce Caa concentration, add a pre-closure honesty guard AND document its deletion sibling here — same discipline as KI-17. Do not leave a stale "we don't enforce Caa" assertion in the codebase once Caa enforcement ships.

---

<a id="ki-23"></a>
### [KI-23] Industry taxonomy missing on BuyListItem + ResolvedLoan blocks industry-cap enforcement

**Context:** CLO indentures typically cap single-industry concentration (e.g., "largest industry ≤ 15% of par"). Enforcing this requires per-loan industry classification under a standardized taxonomy (Moody's 35-industry list, S&P 35-industry list, or PPM-specific mapping).

**Current engine behavior:** Two affected surfaces — neither can compute industry concentration:

1. **`ResolvedLoan`** has no industry field. The switch-simulator's D4 pool-metric recomputation explicitly skips `largestIndustryPct` for this reason (see D4 code comment).
2. **`BuyListItem`** has a `sector: string | null` field, but it's **free-text** (partner-entered "Technology" / "Retail & Restaurants" / etc.). Without taxonomy normalization, an "exclude largest industry" filter would group near-duplicates ("Tech", "Technology", "Software & Tech") as distinct industries and under-enforce.

The D5 buy-list filter therefore ships 4 enforceable filters (WARF / WAS / excludeCaa / excludeCovLite) and defers industry. Partner demo story: "3 of 5 PPM filter categories fully enforced; industry filter deferred pending taxonomy normalization, documented as KI-23."

**PPM-correct behavior:** Per-loan industry tagged against the deal's canonical taxonomy (Moody's or S&P depending on PPM). Industry concentration computed as `max_per_industry(Σ par) / total par × 100`. Cap enforced at reinvestment (C1) + filter (D5) + forward projection (C2).

**Quantitative magnitude:** Unknown without data. On Euro XV, `pool?.largestIndustryPct` is not populated and no concentration test row tracks it; resolver emits nothing for industry.

**Path to close (tiered):**

- **Tier 1 (buy-list filter, D5 extension):** Normalize `BuyListItem.sector` via a lookup table (or add a `sectorKey` canonicalized column). Add `maxIndustryPct` + `excludeLargestIndustry` filters. ~0.5 day.
- **Tier 2 (ResolvedLoan extension, D4 + C2 extension):** Add `industry: string | null` + `industryKey: string | null` to `ResolvedLoan`. Populate from holdings data (resolver extracts from SDF if present, else null). Extend `computePoolQualityMetrics` + switch simulator with `largestIndustryPct`. Extend C1 reinvestment compliance to enforce industry cap. ~1-1.5 days.
- **Tier 3 (C2 concentration test coverage):** Add industry concentration test to `resolved.concentrationTests` + compliance enforcement during forward projection. ~0.5 day.

Total ~2-3 days across tiers. Priority: MEDIUM (partner-demo gap but not blocking for Euro XV where industry concentration is likely within caps).

**Test:** None standalone until Tier 1 ships. When it does, a `d5-industry-filter.test.ts` pinned to synthetic buy-list items would cover the normalization + filter logic.

---

<a id="ki-21"></a>
### [KI-21] Parallel implementations of same calculation in multiple engine sites (architectural — PARTIAL: Scope 1+2 closed, Scope 3 remains)

**Status (2026-04-23):** Scope 1 (quality metrics) closed Sprint 4; Scope 2 (normal-mode waterfall two-path drift) closed Sprint 5; Scope 3 (accel executor + T=0 initialState hardcoded field enumerations) remains open — surfaced during Sprint 5 closure-verification probe.

**Original scope (Sprint 4 / KI-01 ship):** Engine had multiple parallel-implementation sites where "same calculation maintained in two places" risked drift:

1. **Quality-metric computation:** projection engine (per-period closure), switch simulator (inline recomputation), resolver T=0 (inline). Three implementations that needed to agree.
2. **Senior-expense two-path drift (normal mode):** IC-numerator path (`totalSeniorExpenses` → `interestAfterFees`) vs cash-flow path (`availableInterest -=` chain). Two parallel accumulators computing the same six senior-expense amounts that had to stay in sync.

**Scope 1 close (Sprint 4 / D4, 2026-04-23):** `lib/clo/pool-metrics.ts` now hosts the canonical implementations of `computePoolQualityMetrics`, `computeTopNObligorsPct`, and `BUCKET_WARF_FALLBACK`. Three consumers (projection engine, switch simulator, resolver) delegate to the shared helpers — drift-by-construction eliminated.

**How Scope 2 surfaced (Sprint 4):** KI-01 ship. First-pass fix added `issuerProfitPaid` to `totalSeniorExpenses` only. Harness showed engine emitting €250 correctly AND KI-13a cascade probe showed sub-distribution drift UNCHANGED — meaning cash flow didn't lose the €250. Fixed by adding to the `availableInterest -=` chain; drift shifted by exactly −€250 as theory predicted.

**Scope 2 close (Sprint 5, 2026-04-23):** Retired via `lib/clo/senior-expense-breakdown.ts` extraction — same template as D4's `pool-metrics.ts`. The IC numerator and the cash-flow chain in `projection.ts`'s normal-mode period loop now both derive from the same `SeniorExpenseBreakdown` object: the IC path calls `sumSeniorExpensesPreOverflow(breakdown)`, the cash-flow path calls `applySeniorExpensesToAvailable(breakdown, availableInterest)`. Two-path drift eliminated in normal mode.

**Scope 3 (still open) — cross-site field-enumeration consistency:** The Scope 2 closure applies only to the normal-mode period loop. Two OTHER engine sites still maintain hardcoded six-field senior-expense enumerations:

1. **Accelerated executor** (`runPostAccelerationWaterfall`, ~line 536 in `projection.ts`): hardcoded `seniorPaid = { taxes: pay(input.seniorExpenses.taxes), issuerProfit: pay(...), trusteeFees: pay(...), adminExpenses: pay(...), seniorMgmtFee: pay(...), hedgePayments: pay(...) }`. Single-path (no internal parallel-accumulator bug) but DOES hardcode the full field list at a site separate from the normal-mode breakdown.
2. **T=0 initialState.icTests** (~line 1049 in `projection.ts`): hardcoded subtraction `scheduledInterest − taxesAmountT0 − issuerProfitAmountT0 − trusteeFeeAmountT0 − adminFeeAmountT0 − seniorFeeAmountT0 − hedgeCostAmountT0`. Also single-path internally but maintains its own field enumeration.

**Concrete failure mode:** a future KI that adds a new senior expense (e.g., modeling KI-02 Expense Reserve top-up at step (D)) would update the `SeniorExpenseBreakdown` type and the normal-mode callsite picks it up automatically (Scope 2 closure win). BUT the accel executor + T=0 initialState would silently skip the new expense until a reader remembers to touch those sites. That's the vigilance-based maintenance Scope 2 was supposed to retire — just scoped narrowly.

**Path to close (Scope 3):** Extend the breakdown's use to the other two sites:
- Accel executor: accept a `breakdown: SeniorExpenseBreakdown` instead of the current field-by-field `seniorExpenses` param. Internal `pay(...)` loop iterates the breakdown's fields in PPM order. Callers (the accel branch in the period loop) pass the same breakdown they already construct.
- T=0 initialState: construct a `SeniorExpenseBreakdown` at T=0 using quarterly rates instead of per-period amounts, then call `sumSeniorExpensesPreOverflow(breakdownT0)` once. Removes the hardcoded subtraction chain.

Estimated ~1-2 hours careful refactor + N1-harness re-verification. Low priority until a new senior expense lands (KI-02 Expense Reserve would be the natural trigger).

**Verification (Sprint 5, Scope 2 only):** Full suite green with unchanged numerical output. KI-13a expected drift unchanged at −€50,992.24 ± €50, KI-12b markers unchanged, KI-IC-AB/C/D markers unchanged. The refactor consolidated the normal-mode representation; it did not change any computed amount.

**Tests:** `lib/clo/__tests__/senior-expense-breakdown.test.ts` covers the helpers' arithmetic and PPM-order truncation. Full waterfall correctness regression remains in `n1-correctness.test.ts`.

---

<a id="ki-24"></a>
### [KI-24] E1 citation propagation coverage is partial (8 deferred paths)

**Context:** Sprint 5 / E1 shipped PPM citation propagation on three partner-facing surfaces: `ResolvedPool`, `ResolvedFees`, `ResolvedEodTest`. Partner hovering the Pool or Fees header sees "Source: PPM p.23, 27, 287, 295" / "p.22, 23, 146" / "p.207, 208 (OC Condition 10(a)(iv))" as intended.

**What's NOT covered (surfaced in the E1 subagent's completion report):** Eight ppm.json source-annotated paths carry `source_pages` or `source_condition` but don't yet propagate into partner-facing tooltips. Enumerated:

1. `section_1_deal_identity.source_pages = [1, 17, 18, 19, 240, 327]` — no current consumer; would tooltip a deal-identity header.
2. `section_2_key_dates.source_pages = [18, 19, 20, 21, 22]` — could attach to `ResolvedDates` (maturity / reinvestment end / non-call). Intentionally omitted from E1 scope; reasonable follow-up.
3. `section_3_capital_structure.source_pages = [18]` — per-tranche citations. E1 explicitly excluded `ResolvedLoan` / `ResolvedTrigger` per scope.
4. `section_4_coverage_tests.source_pages = [28, 207, 208]` — section-level page range. Only the EoD subsection is plumbed; class-level OC / IC triggers would need per-trigger citations on `ResolvedTrigger`.
5. `section_6_waterfall.source_condition = "OC Condition 3(c)"`, `source_pages = [176, 179]` + `post_acceleration_priority_of_payments.source_condition = "OC Condition 10"` — no current `Resolved*` consumer for waterfall shape (engine implements the waterfall; no partner-facing tooltip surface today).
6. `section_7_interest_mechanics.source_condition` — flows through `constraints.interestMechanics` passthrough; no partner-facing slider rooted in it today.
7. `section_8_portfolio_and_quality_tests.source_pages.{moodys_matrix, fitch_matrix}` — rating-matrix-specific pages. Only `portfolio_profile` and `collateral_quality_tests` are folded into `poolSummary.citation`; matrix pages intentionally omitted (not partner-facing fields).
8. `section_9_collateral_manager_replacement.source_pages = [313, 318]` — no UI surface today.

**Partner-visible impact:** A partner asking "where does this Class A/B OC test trigger come from?" sees no citation on the OC row today (coverage gap #4). Same for reinvestment-period-end date (gap #2), class coupon formulas (gap #3), waterfall clause-level references (gap #5). E1 shipped the pattern; extending it to these eight paths is mechanical but not free.

**Path to close:**
- **Tier 1 (partner-demo value, ~1-2 hours total):** Key dates + class-level OC/IC triggers. Most frequent partner questions are "where's this date/trigger from?" Add `citation?` field to `ResolvedTrigger` + `ResolvedDates`; populate in resolver from `section_4` + `section_2` provenance. Wire tooltips into the trigger display + dates display.
- **Tier 2 (institutional completeness, ~2-3 hours):** Per-tranche citations + waterfall section citations. Requires extending `ResolvedTranche` (partner tranche panel tooltips) and introducing a waterfall-rendering surface that doesn't exist today.
- **Tier 3 (rating matrix, misc, ~1 hour):** Moody's / Fitch rating matrix pages; collateral manager replacement section. Low-demand surfaces.

Total ~4-6 hours across tiers. Priority: MEDIUM — Tier 1 would close the most common partner "where from?" questions; Tier 2+ can wait for specific asks.

**Test:** No standalone test required until each deferred path ships. When a path lands, extend the existing `e1-citation-propagation.test.ts` with a per-surface assertion.

---

<a id="ki-22"></a>
### [KI-22] Fixture-regeneration test was a field-by-field spot check, not full-equality — CLOSED (Sprint 4, 2026-04-23)

**Pre-fix behavior:** Sprint 0 shipped `fixture-regeneration.test.ts` framed as a "drift canary" — running the current resolver on `fixture.raw` and verifying output matches `fixture.resolved`. The stated purpose: permanent drift protection so the fixture stays canonical as the resolver evolves.

**What the test actually did:** Checked 5 specific assertions on a handful of fields (`principalAccountCash`, `impliedOcAdjustment`, ocTriggers length, eventOfDefaultTest.triggerLevel, totalPrincipalBalance + two fee fields). Any resolver change that populated a NEW field, or changed a field NOT in that narrow list, passed silently.

**How this surfaced:** Sprint 4 / D4. Added `top10ObligorsPct` to `ResolvedPool`, expected the fixture-regeneration test to fail and guide the fixture update. It did not. Investigation revealed the spot-check nature. Extending to a full iterator immediately surfaced two additional drifts that had been latent:

1. **`pctSecondLien: 0 → null`**: drift since Sprint 0. Resolver intentionally emits null when the source doesn't carry a dedicated pctSecondLien column (it's combined with HY/Mezz/Unsecured in a 4-category bucket). Sprint 4 fix: resolver now infers `pctSecondLien: 0` when `pctSeniorSecured === 100` (mutually exclusive lien categories make 0 certain). Fixture patched to match new resolver output.
2. **`reinvestmentOcTrigger.rank: 99 → 7`**: Sprint 0-era fixture used the fallback "no-OC-triggers" rank 99; fresh resolver correctly computes `mostJuniorOcRank = 7` (Class F). Fixture patched.

Both drifts had been invisible for ~20 days of active development. Every "fixture is canonical" claim across Sprint 1-3 was built on the spot-check illusion.

**Fix (Sprint 4):** Extended `fixture-regeneration.test.ts` with a recursive full-equality iterator. Walks every field on top-level `resolved.*` (skipping volatile `metadata` + large `loans` array), compares fresh vs stored with named mismatch reports, numeric fields use 1e-4 relative tolerance. Fails with "fieldPath: fresh=X vs stored=Y" on any drift.

**Current behavior:** 566/566 green, full-equality guard active. Next new `ResolvedDealData.*` field or any silent resolver change will trip the guard immediately.

**Path to close:** Closed in Sprint 4. Follow-up (lower priority): extend coverage to the `loans` array — currently skipped because per-field drift on 400+ loans would produce unmanageable test output for a single resolver change. If needed, add a separate loan-shape regeneration test that samples a few canonical loans or compares aggregates.

**Tests:** `fixture-regeneration.test.ts > "every top-level resolved.* field matches fresh resolver output (recursive full-equality)"`.

---

<a id="ki-20"></a>
### [KI-20] D2 legacy escape-hatch on 6 test-factory sites (Sprint 4)

**Context:** Sprint 4 shipped D2 (per-position WARF hazard) as the engine's production default. Legacy test factories that predate D2 compute expected defaults from `defaultRatesByRating[ratingBucket]` hand-math — under the new default they would fail (bucket rate ≠ WARF-derived per-position rate). Rather than re-baselining ~30 hand-computed expected values in one PR, the factories were pinned to `useLegacyBucketHazard: true` as a bridge.

**Current engine behavior:** Production default = per-position WARF hazard. Six test-factory sites explicitly opt into legacy bucket behavior:
1. `lib/clo/__tests__/test-helpers.ts:makeInputs` (shared factory, ~5 test files consume)
2. `lib/clo/__tests__/projection-edge-cases.test.ts:makeSimpleInputs`
3. `lib/clo/__tests__/projection-edge-cases.test.ts:makeMultiTrancheInputs`
4. `lib/clo/__tests__/projection-cure.test.ts:makeRealisticInputs`
5. `lib/clo/__tests__/projection-structure.test.ts:makeFullDealInputs`
6. `lib/clo/__tests__/projection-structure.test.ts:makeFeeTestInputs` (local to one describe block)

**Partner-visible impact:** None on production behavior — Euro XV runs through `buildFromResolved`/`defaultsFromResolved` which is NOT pinned to legacy. N1 / N6 / B1 / B2 / C1 / C2 / C3 tests all run on per-position hazard already and pass (D2's precision benefit is materially visible only in stress scenarios with concentrated sub-bucket exposure, not in Euro XV base case).

**Path to close:** For each of the 6 test factories, (a) determine which tests it serves actually depend on hand-computed default-hazard math (as opposed to just wanting plausible defaults for other mechanics), (b) for math-dependent tests, re-baseline expected values to the per-position formula, (c) remove the legacy pin from the factory once all its tests re-baseline, (d) delete `useLegacyBucketHazard` entirely once no pin sites remain.

**Forcing function:** Engine emits `console.warn` when `useLegacyBucketHazard: true` is passed (`projection.ts`, one-shot per `runProjection` call). Test output surfaces the deprecation so a future developer sees it in CI. Without the warn, flag becomes permanent tech debt framed as temporary.

**Estimated effort:** ~2 hours per factory (1–2 days total) spread across sprints. Not a Sprint 4 blocker.

**Test:** No standalone marker. Closure signal is: all six pin sites deleted, `useLegacyBucketHazard` field removed from `ProjectionInputs`, full suite green.

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

<a id="ki-25"></a>
### [KI-25] UI back-derivation of engine values — CLOSED (2026-04-29)

**Incident reference:** April 2026 "missing €1.80M of interest residual" investigation. Two confidently-wrong diagnoses across two LLM agents and the user before root cause was identified.

**Pre-fix behavior:** `web/app/clo/waterfall/PeriodTrace.tsx:13-14` back-derived `equityFromInterest` as `Math.max(0, period.equityDistribution - principalAvailable)` from totals. When `principalAvailable` exceeded the residual, this silently dropped clause-DD distribution from the displayed trace. A second instance: `ProjectionModel.tsx:374` independently re-computed `bookValue` with the same formula the engine emits — two parallel implementations of the same calculation.

**Quantitative magnitude:** UI displayed €0 instead of €1.80M of equity-from-interest in Q1 of Euro XV. Engine output was correct throughout; the UI was lying about which values came from where. No engine number was wrong.

**Fix:**
1. `period.stepTrace.equityFromInterest` and `equityFromPrincipal` now consumed directly by the UI via `web/app/clo/waterfall/period-trace-lines.ts` (pure helper). `PeriodTrace.tsx` is now a thin renderer over engine output.
2. `result.initialState.equityBookValue` and `result.initialState.equityWipedOut` added to engine output. UI reads these directly; the parallel UI computation deleted.
3. Service module `web/lib/clo/services/inception-irr.ts` extracted from inline UI useMemo — accepts engine output + user inputs, returns IRR result. Pure-function, unit-tested.
4. AST enforcement test `lib/clo/__tests__/architecture-boundary.test.ts` codifies four anti-patterns (UI arithmetic on `inputs.*`, back-derivation from `period.equityDistribution`, raw reads of `resolved.principalAccountCash` in arithmetic, re-deriving `Math.max(0, loans - debt)` book-value formula). Per-occurrence opt-out via `// arch-boundary-allow: <ruleId>`.

**Path to close:** Closed. See `CLAUDE.md § Engine ↔ UI separation` for the layering rules and `docs/plans/2026-04-29-engine-ui-separation-plan.md` for the full implementation history.

**Tests:** `app/clo/waterfall/__tests__/period-trace-lines.test.ts` (engineField completeness + per-row engine equality + acceleration handling). `lib/clo/__tests__/inception-irr.test.ts` (8 cases: default anchor, user override, counterfactual, terminal, empty, subNotePar≤0, equityWipedOut). `lib/clo/__tests__/architecture-boundary.test.ts` (regression-prevention).

