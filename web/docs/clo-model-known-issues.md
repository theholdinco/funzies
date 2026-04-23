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

- [KI-01 — Step (A)(ii) Issuer Profit Amount (€250/quarter)](#ki-01)
- [KI-02 — Step (D) Expense Reserve top-up](#ki-02)
- [KI-03 — Step (V) Effective Date Rating Event redemption](#ki-03)
- [KI-04 — Frequency Switch mid-projection cadence/rate switch (C4 Phase 3)](#ki-04)
- [KI-05 — Supplemental Reserve Account (step BB)](#ki-05)
- [KI-06 — Defaulted Hedge Termination (step AA)](#ki-06)
- [KI-07 — Class C/D/E/F current + deferred interest bundled in step map](#ki-07)
- [KI-08 — Sprint 0 `trusteeFeesPaid` bundles PPM steps B + C](#ki-08)
- [KI-09 — Step (A)(i) Issuer taxes not modeled](#ki-09)
- [KI-10 — baseRate pre-fill gap (D3 family)](#ki-10)
- [KI-11 — Senior / sub management fee pre-fill gap (C3 family)](#ki-11)
- [KI-12a — Senior / sub management fee base discrepancy](#ki-12a)
- [KI-12b — B3 day-count approximation (matters on non-90-day periods)](#ki-12b)
- [KI-13 — Sub distribution cascade residual](#ki-13)
- [KI-14 — IC compositional parity at T=0 (cascade)](#ki-14)

---

<a id="ki-01"></a>
### [KI-01] Step (A)(ii) Issuer Profit Amount

**PPM reference:** Condition 1 definitions, p.127.
**Current engine behavior:** Not modeled; engine skips step (A)(ii) entirely. `stepTrace.issuerProfit` emits 0.
**PPM-correct behavior:** €250 per quarter deducted from interest proceeds before trustee fees. €500 per period post-Frequency-Switch Event.
**Quantitative magnitude:** €250 × 4 = €1,000/year on a €500M deal ≈ 0.02 bps of annualized waterfall throughput. Below N1 tolerance for every downstream step.
**Deferral rationale:** Immaterial. Explicit constant €1K/year addable as an input with ~2 hours of engine work; not worth the API surface unless a partner explicitly asks.
**Path to close:** Tier D follow-up; ~0.25 day.
**Test:** Infinity-tolerance (informational) in both `n1-correctness.test.ts` and `n1-production-path.test.ts` under "engine-does-not-model steps" → `issuerProfit`. Asserts trustee-side magnitude of €250/period (sanity that the trustee value is still what KI-01 documents).

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
### [KI-08] Sprint 0 `trusteeFeesPaid` bundles PPM steps B + C

**PPM reference:** Steps (B) (Trustee Fees) and (C) (Administrative Expenses), both subject to the Senior Expenses Cap.
**Current engine behavior:** The engine uses a single `trusteeFeeBps` input covering both trustee and admin fees (`projection.ts:494`). The `stepTrace.trusteeFeesPaid` field therefore represents B+C combined. Without pre-fill from Q1 actuals, `trusteeFeeBps` defaults to 0 (PPM says "per agreement"), so the engine emits 0.
**PPM-correct behavior:** B and C are distinct PPM steps with separate amounts in the trustee report. Euro XV Q1 2026: step B = €1,194.44, step C = €63,465.76. Jointly capped under the Senior Expenses Cap; overflow to steps (Y) and (Z).
**Quantitative magnitude:** €64,660/quarter on €491M par = ~5.3 bps/year; ~€258K/year; ~€2.6M cumulative over a 10-year projection. Appears as `trusteeFeesPaid: -€64,660` in the N1 harness delta table. Cascades into `subDistribution` and incentive-fee timing.
**Deferral rationale:** Requires (1) pre-fill `trusteeFeeBps` and `adminFeeBps` from observed Q1 waterfall steps (A1/D3 pre-fill family) AND (2) split the engine's single fee input into two + add the Senior Expenses Cap with overflow (C3 scope).
**Path to close:** Sprint 3 / C3. Pre-fill lands with the cap + overflow refactor. Effort subsumed in C3.
**Test:** `n1-correctness.test.ts > "currently broken buckets" > trusteeFeesPaid` (ki: `KI-08`, expectedDrift: −€64,660.20 ± €100) and `n1-production-path.test.ts > "pre-fill gap drifts" > trusteeFeesPaid` (ki: `KI-08`, same magnitude — trusteeFeeBps is 0 in both paths since neither pins it). Both markers remove together when C3 ships.

---

<a id="ki-09"></a>
### [KI-09] Step (A)(i) Issuer taxes not modeled

**PPM reference:** Condition 1 definitions (Issuer profit / tax provisions); step (A)(i) in the interest waterfall.
**Current engine behavior:** Not modeled. `stepTrace.taxes` emits 0.
**PPM-correct behavior:** Issuer income taxes deducted before any other interest waterfall payment. Per Euro XV Q1 2026 trustee report: €6,133/quarter.
**Quantitative magnitude:** €6,133/quarter = €24,532/year on Euro XV. On a €42.56M equity cost basis (95c × €44.8M sub par) ≈ 5.8 bps annual drag; cumulative ~€245K over a 10-year projection. Flows straight into `subDistribution` residual every period. Not immaterial.
**Deferral rationale:** Trivial additive engine change (15 lines: `taxesBps` input, deduct before trustee fees, emit on `stepTrace.taxes`). Deferred from Sprint 0 scope only because A.i's magnitude wasn't surfaced until the N1 harness ran against the fixture on Apr 23, 2026.
**Path to close:** Tier D follow-up. ~0.5 day. When it lands, KI-09 closes and `subDistribution` drift tightens by ~€6,133/quarter.
**Test:** Infinity-tolerance (informational) in both `n1-correctness.test.ts` and `n1-production-path.test.ts` under "engine-does-not-model steps" → `taxes`. Asserts trustee-side magnitude of ~€6,133/period. When the engine lands a `taxes` emitter, swap these informational asserts for a real tie-out assertion (|drift| ≤ €1) and move KI-09 to Closed.

---

<a id="ki-10"></a>
### [KI-10] baseRate pre-fill gap (D3 family)

**PPM reference:** N/A — this is an input-pipeline gap, not a PPM mechanic.
**Current engine behavior:** `DEFAULT_ASSUMPTIONS.baseRatePct = 2.1%` (static). The user-facing sliders pre-populate from this default rather than from observed EURIBOR.
**PPM-correct behavior:** `baseRatePct` pre-fills from `raw.trancheSnapshots[*].currentIndexRate` (the per-class observed reference rate on the deal). Legitimate external authority — equivalent to reading from a rates feed.
**Quantitative magnitude:** Euro XV Q1 2026 observed EURIBOR = 2.016% vs 2.1% default → ~8.4 bps drift on every floater. Per class on Q1 2026: Class A ~€65K, Class B ~€7K, Class C ~€7K, Class D ~€7K, Class E ~€5K, Class F ~€3K per period. Compounds every period.
**Deferral rationale:** Pre-fill wiring lives in a future `defaultsFromResolved(resolved, raw)` consolidation; shipping it standalone would be cheap but D3 bundles the baseRate + fee + recovery-rate pre-fill family into one pass.
**Path to close:** Sprint 1 / D3 pre-fill family.
**Test:** `n1-production-path.test.ts > "pre-fill gap drifts" > classA_interest..classF_current` — six `failsWithMagnitude` markers (ki: `KI-10`), one per class. Markers remove as a group when D3 ships. The engine-math path (`n1-correctness.test.ts`) pins baseRate from the fixture so those six classes are green there.

---

<a id="ki-11"></a>
### [KI-11] Senior / sub management fee pre-fill gap (C3 family)

**PPM reference:** N/A — input-pipeline gap.
**Current engine behavior:** `seniorFeePct` and `subFeePct` default to 0. The PPM carries contractual values that the resolver already extracts into `resolved.fees.seniorFeePct` / `subFeePct`, but the projection-inputs builder does not read them.
**PPM-correct behavior:** Pre-fill both rates from `resolved.fees.*`. These are contractual PPM values; legitimately external authority.
**Quantitative magnitude:** Euro XV Q1 2026: seniorMgmtFee €176,587/quarter unemitted, subMgmtFee €412,037/quarter unemitted. Flows straight into `subDistribution` overpayment.
**Deferral rationale:** Part of the D3 consolidation pass; bundled with KI-10 to minimize churn in the inputs builder.
**Path to close:** Sprint 3 / C3 (fee pre-fill family).
**Test:** `n1-production-path.test.ts > "pre-fill gap drifts" > seniorMgmtFeePaid | subMgmtFeePaid` — two `failsWithMagnitude` markers (ki: `KI-11`). The engine-math path pins these two rates from `resolved.fees`, so seniorMgmtFee/subMgmtFee drift there is engine-arithmetic (KI-12) not pre-fill.

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

---

<a id="ki-12b"></a>
### [KI-12b] B3 day-count approximation — currently masked by harness period mismatch

**PPM reference:** Condition 1 — "Day count (Actual/360 float, 30/360 fixed)"; confirmed via `ppm.json` grep and PPM worked example (see KI-12a).
**Current engine behavior:** Engine divides by 4 (periods-per-year proxy) for interest-denominated steps. For periods of exactly 90 days this is identical to Actual/360 (`90/360 = 1/4`). For periods of 89 / 91 / 92 days or any semi-annual period, the approximation drifts.
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

**Implication for Sprint 1 sequencing:** Shipping B3 **before** KI-12a's harness fix will produce a spurious "Sprint 1 broke six tests" signal. KI-12b's closure is therefore **entangled with KI-12a**, not independent. Either:
- (i) Fix KI-12a first (harness period mismatch → rebuild fixture at Q4 2025 determination or move to multi-period historical backtest), then ship B3 — drifts stay at |drift| < €1 through the transition.
- (ii) Ship B3 first accepting the six "new" class-interest drifts as expected KI-12a symptoms; add temporary `failsWithMagnitude` markers with documented magnitudes; close them when KI-12a lands.
- **Recommended: (i).** Cleaner narrative; KI-12a is structural, KI-12b becomes a clean arithmetic fix on top of a valid harness.

**Deferral rationale:** Engine rework — day-count traversal is load-bearing across the waterfall, touches every coupon line, needs a per-tranche config surface.
**Path to close:** Sprint 1 / B3 (per-tranche day-count + actual-days period length), but gated behind KI-12a per the sequencing note above.
**Test:** No active marker today — drift is zero under the current `/4 = 90/360` coincidence. When B3 ships or KI-12a ships (whichever first), expect six new markers (one per class interest bucket) with documented magnitudes; close them as the other KI resolves.

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
**Current engine behavior:** Engine computes IC at T=0 (`initialState.icTests`) from `interestCollections − (issuerProfit + taxes + trusteeFees + seniorMgmt)`. Under legit pins (baseRate + senior/sub fee rates), the engine emits IC ratios higher than trustee because KI-01 + KI-08 + KI-09 (issuer profit, trustee fee, taxes) are not deducted, and KI-12a (fee-base) causes senior mgmt fee to be over-deducted — net effect is a positive drift per class.
**PPM-correct behavior:** IC numerator includes the full set of §(A)–§(E) deductions correctly attributed.
**Quantitative magnitude (under legit pins, Q1 2026):**
  - Class A/B: +6.600 pp drift (engine 254.680 vs trustee 248.080)
  - Class C: +5.865 pp drift (engine 226.475 vs trustee 220.610)
  - Class D: +5.117 pp drift (engine 197.447 vs trustee 192.330)
**Deferral rationale:** Cascade — not an independent formula bug. The IC parity test exists because the component cash-flow checks in n1-correctness don't exercise the aggregation/denominator logic of the IC formula itself; a mis-aggregation would slip through. Under legit pins the drift magnitudes are deterministic and documented; regressions (formula or aggregation changes) would move these magnitudes and surface.
**Path to close:** Closes progressively as KI-01 / KI-08 / KI-09 / KI-12a close. No standalone work.
**Test:** `backtest-harness.test.ts > "N6 harness" > Class A/B|C|D IC compositional parity at T=0` — three `failsWithMagnitude` markers (`KI-IC-AB`, `KI-IC-C`, `KI-IC-D`), tolerance 0.05pp (equals close threshold — these are relatively tight compared to expected magnitudes 5-6pp, so the conflation risk is negligible). Same re-baseline discipline as KI-13: every PR closing an upstream KI must re-run the harness and update these three `expectedDrift` values.

---

## Closed issues

_(None yet. Entries move here when their corresponding fix ships and is verified green in the N1 harness.)_
