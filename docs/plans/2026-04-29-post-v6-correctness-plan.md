# Post-v6 Correctness Plan

**Date:** 2026-04-29
**Status:** v2 — synthesized from six review rounds; final pre-implementation revision
**Supersedes:** v1 of this plan; Phase 7+ open items in `2026-04-29-engine-ui-separation-plan.md`
**Successor to:** v6 Engine ↔ UI Separation Plan (architecture refactor, shipped)
**Revision protocol:** see §14

---

## 0 · Why this plan exists

v6 closed the engine ↔ UI separation defect: engine emits canonical values, UI consumes engine output, AST test prevents back-derivation regressions. That work shipped clean (648/652 tests green, every PeriodTrace row matches engine output to the cent on Euro XV).

The post-v6 conversation surfaced a different failure mode: **the model is numerically correct but partner-confusing**, because:

1. The `equityEntryPriceCents` slider auto-fills from inception cost basis (95c on 2024-04-17), which conflates "what I paid in 2024" with "today's hypothetical entry price."
2. "Book value" is displayed without "fair value" alongside it, so partners read book as fair.
3. "Inception IRR (since closing): +8.89%" is a mark-to-book-today hypothetical, but reads like a realized return.
4. "Projected Forward IRR" carries no qualifier about its no-call assumption, despite vintage-2021 Euro CLOs being heavy call candidates.
5. Manager call optionality is unmodeled (callDate = "Not set" → projects to legal final 2036).
6. Monte Carlo perturbs only default paths, not call-timing or rate-path stochasticity, producing a deceptively-tight 100%-negative distribution.
7. Several model-vs-market boundaries are crossed silently (e.g. "Fair Value @ 10% IRR: 36c" reads like a market quote, but it's a model output).

This plan addresses each, ordered by leverage (smallest fixes with biggest comprehension impact first; preventive infrastructure last).

## 1 · Review history that produced this plan

- **Review #1 (in-thread, post-v6):** the implementor's own critical pass — found AST rules bypassable by destructuring/rename, bookValue migration silent-claim unverified, Phase 8 sweep sampled-not-exhaustive, no commits, trustee tie-out deferred.
- **Review #2 (independent):** flagged 4 specific items (3 already shipped in this session; 1 — auto-fill UX bug — was a real gap). Plan-level critique: phase ordering inverts known-defect-vs-preventive priority; Phase II overscoped; methodological concerns on stochastic call pmf and CDR breaking-API change.
- **Review #3 (independent):** verified the 3 already-shipped claims; conceded most pushbacks; added critical points: cross-deal validation chicken-and-egg (synthetic vs real), undecided product decisions, decision-log seed too generic, Greeks ambiguity (risk vs pricing), model-vs-market limit.
- **Review #4 (independent, post-v1-plan):** caught 11 items including the §3.3 vs §9 #5 internal contradiction (toggle vs side-by-side), §4.1 dead "economic" callMode, §4.5 reset spec ~30% complete, §6.1 sanity bounds mathematically wrong, missing distressed-state fixtures (PIK, OC failure, post-acceleration), missing inline `(model)` marker, two-runs MC perf concern. All 11 applied.
- **Review #5 (independent, post-R4-edits):** caught 14 items including (A) §12 vs §6.1 fixture count mismatch, (B) §3.1 vs §3.4 fair-value asymmetry, (C) combinatoric explosion when Phase A I.1 lands (3 entry prices × 2 call modes), (D) §7.15 D-α + design-pre-commit conflict, plus spec gaps in trustee tolerances, RP extension semantics, mark-to-model date alignment, call-sensitivity date derivation. All applied in v2 (this revision).
- **Review #6 (independent, post-R5-edits/implementor critique):** pushed back on the chevron-per-row resolution to (C) — correctly identified that hiding with-call values behind row-level chevrons recreated the original failure mode; replaced with a single all-rows toggle. Caught self-validating-correctness epistemic gap (named in §10 / §13). Caught duplicated cold-read test placement (§11 vs §12). Caught counterintuitive call-mode IRR cases. Caught missing plan-revision protocol (§14 added). All applied in v2.

This plan is the synthesis. It supersedes v1. Round 6 is the last text review pre-implementation; round 7+ happens against running code, not against the document.

---

## 2 · Phase summary

| Phase | Theme | Effort character | Dependencies |
|---|---|---|---|
| **0** | Cohesive small fixes, framing decisions, decision-log seeding | ~1-2 weeks; mix of UX, services, prose | Already-shipped: scope widening, equityWipedOut guard, MC short-circuit |
| **A** | Engine completeness for headline credibility (manager call, stub period, balance instrumentation, RP extension, trustee tie-out) | ~2-3 weeks; substantive engine work | Phase 0 decisions; PPM extraction upstream |
| **B** | Sensitivity infrastructure (slim — three services, one card augmentation) | ~1 week | Phase A I.1 (manager call) |
| **C** | Coverage broadening (synthetic-fixture cross-deal validation incl. distressed states, trustee replay, optional per-loan defaults) | ~2 weeks | Phase A V.3 (trustee tie-out as template) |
| **D** | Long-tail correctness, hardening, deferred items including reset modeling (with design pre-commit) | indefinite; pull as bandwidth allows; D-α/β/γ tags inside Phase D order pull | None individually |

Out-of-scope items named explicitly in §8.

---

## 3 · Phase 0 — Cohesive small fixes, framing, decisions

**Theme:** the smallest fixes with the biggest comprehension dividend, plus product decisions that gate later phases. All small enough to ship together as one PR or two close PRs.

### 3.1 Auto-fill UX → side-by-side display (not slider default flip)

**Problem:** `ProjectionModel.tsx` auto-fills the forward entry-price slider from `equityInceptionData.purchasePriceCents`. The slider drives forward-IRR computation, which is then displayed as "Projected Forward IRR." User can't tell if this is "IRR at my cost basis" or "IRR at today's market price" — the slider claims to mean both.

**Decision:** keep the slider but reframe what's displayed. Display three forward IRRs side-by-side instead of one number that depends on the slider value.

```
Equity card layout:
─────────────────────────────────────────────────────────────────────
  Book Value: 55.4c (€24.8M)
  Fair Value @ 10% IRR (model): 36c · @ 15% IRR (model): 27c
─────────────────────────────────────────────────────────────────────
  Forward IRR @ your cost basis (95c):     -11.95%
  Forward IRR @ book (55c):                  -0.4%
  Forward IRR @ fair value-10% (36c):       +10.0%
─────────────────────────────────────────────────────────────────────
  [Slider] Custom entry price: [___] cents → IRR: --.--%
─────────────────────────────────────────────────────────────────────
```

The user gets all three numbers without slider games. The custom slider becomes a secondary "what-if" input rather than the primary display driver.

**Asymmetry between Fair Value display (§3.4) and Forward-IRR triple (this section):**

Two fair-value-at-hurdle numbers are displayed at card-level (Book Value line, top of card): `@ 10% IRR` and `@ 15% IRR`. The Forward-IRR triple uses ONLY the 10%-hurdle fair value as its third anchor row (labeled `fair value-10%` for clarity). Reason: a triple is the right cognitive load; expanding to four rows ("fair value @ 10% IRR" + "fair value @ 15% IRR") muddies the cost-basis / book / fair-value taxonomy by introducing a fourth concept (which hurdle). The 15% fair-value is shown card-level to anchor the partner's bid range but is not anchored to a forward-IRR row. Document explicitly so future implementors don't re-litigate.

**Files:**
- `web/app/clo/waterfall/ProjectionModel.tsx`: replace single `<ForwardIrr>` with `<ForwardIrrTriple>` rendering cost-basis / book / fair-value rows.
- `web/lib/clo/services/fair-value.ts`: new service (binary-searches entry price for target IRR; supports multiple hurdles per §3.4).
- Tests: `web/lib/clo/__tests__/fair-value.test.ts` (monotonicity, convergence within 0.1c, NaN handling for wiped-out deals, no-convergence handling for impaired deals).

**Edge cases — explicit:**

- **No inception data (no historical purchase):** the cost-basis row is hidden; the book and fair-value rows render as normal. Tooltip on the missing row's slot says "No inception cost basis on file." User can still enter a custom price via the slider.
- **Wiped-out deal (`equityWipedOut === true`):** all three rows render "—" with a single inline message: "Equity is balance-sheet insolvent — IRR undefined regardless of entry price." Slider is hidden in this state. Companion to the existing wiped-out banner.
- **Fair value below 0c (deal so impaired even free entry doesn't reach the hurdle):** binary search brackets at [0c, 200c]; if the upper bracket's IRR is still below the target hurdle, fair value renders "no convergence at hurdle X%" with a tooltip explaining the deal can't achieve the target IRR at any reasonable entry price. Service returns `{ priceCents: null, reason: "below_hurdle" }` rather than a near-zero number.
- **Slider interaction:** the three primary rows are pinned to (cost basis, book, fair value at hurdle). They do NOT update when the slider moves. The slider drives a SEPARATE fourth row labeled "Forward IRR @ custom price (Xc): Y%" that renders below the three primary rows. This way the slider can't be confused with the auto-fill behavior it replaces.

**Success criteria:** partner reads three explicit numbers; auto-fill confusion eliminated by structure, not by slider behavior. Edge cases (no inception, wiped-out, no-convergence) render explicit messages rather than misleading numbers.

### 3.2 Three IRR taxonomy — show all three, don't pick one

**Problem:** "Inception IRR (since closing): +8.89%" reads like a realized return but uses today's book as terminal. Three legitimate methodologies exist; current UI picks one and labels it ambiguously.

**Decision:** ship all three as separate displays, each labeled explicitly.

```
Realized IRR (cashflows received only):           X%
Mark-to-book IRR (if called at book today):       Y%   ← formerly "since closing"
Mark-to-model IRR (held to maturity, no call):    Z%   ← model-projected forward NPV
```

Each answers a different question (backward-looking realized; hypothetical immediate exit; forward model projection). Refusing to collapse them is itself the product decision.

**Files:**
- `web/lib/clo/services/inception-irr.ts`: extend `computeInceptionIrr` to return three modes: `realized`, `markToBook`, `markToModel`.
- `web/app/clo/waterfall/ProjectionModel.tsx`: render all three.
- Tests: extend `inception-irr.test.ts` for the three modes.

**Complexity callout — mark-to-model is more than a one-mode addition.** It composes:
1. Read realized distributions from `extractedDistributions` (already extracted; in the resolver pipeline)
2. Run the forward projection (already runs; same `runProjection` engine path used elsewhere)
3. Reconcile date alignment between historical distribution dates and engine-projected payment dates per the canonical rule (below)
4. Stitch the two cashflow streams into a single time-anchored series for `calculateIrrFromDatedCashflows`
5. Return the IRR plus the assumption set used (so the displayed number can be qualified)

**Canonical date-alignment rule (committed):**
- The realized series ends at the last historical distribution date `D_last`.
- The forward series starts at the first scheduled payment date strictly after `currentDate`. Call this `D_first_forward`.
- Any gap `D_last < t < D_first_forward` contributes implicit zero cashflow (no double counting; no extrapolation).
- **Inverse case error** (`currentDate < D_last`, i.e., realized data is dated after `currentDate` — shouldn't normally happen but possible with stale or future-dated data): throw with explicit error `"Mark-to-model: latest realized distribution dated after currentDate. Refusing to build mixed series."` Do not silently skip or coerce.
- **No realized distributions**: render mark-to-model as "no historical data" with explanation; fall back to forward-only IRR using purchase-anchor (or book if no purchase).

Most of the work is in (3) and (4). The data sources exist; the integration is bounded; tests should cover misaligned dates, the inverse case, and missing realized distributions explicitly. Phase 0 scope still appropriate, but allocate enough time for the alignment work.

**Phase 0 timeline mitigation (per §10 risk):** if alignment work overruns, ship realized + mark-to-book first; mark-to-model as a Phase 0.5 ship after the rest of Phase 0 lands.

**Success criteria:** three numbers, three labels, no ambiguity about which one represents what. Mark-to-model handles missing realized distributions (renders as "no historical data") and date misalignment (renders explicit warning).

### 3.3 Forward-IRR no-call qualifier — Phase 0 ships single labeled row, Phase A adds a second row alongside

**Problem:** "Projected Forward IRR" doesn't disclose the no-call assumption. The label is wrong-by-omission for vintage-2021 deals.

**Decision:** label the assumption inline. Phase 0 ships ONE labeled row. Phase A I.1 adds a SECOND row, side-by-side, never replaces the first.

Phase 0 (single row, with explicit assumption):

```
Forward IRR (held to legal final, no call):     -11.95%
```

Phase A I.1 (two rows, side-by-side, never a toggle — see §9 #5):

```
Forward IRR (no call, held to legal final):                   -11.95%
Forward IRR (call at optional redemption date @ par):          -X.XX%
```

The user reads both numbers. No dropdown, no toggle. A toggle hides the comparison the partner needs.

**Files:**
- `web/app/clo/waterfall/ProjectionModel.tsx`: relabel in Phase 0; render second row in Phase A.

### 3.4 Fair-value-at-hurdle service + display, with model-vs-market disclaimer

**Problem:** there's no displayed "what's a fair price" number anywhere on the page. Partners infer fair value from book value (wrong). Even when displayed, fair value can be mistaken for a market quote.

**Decision:** ship `fair-value.ts` service (already noted in §3.1). Display Fair Value at TWO hurdles by default (10% and 15%), with the inline (model) marker — not just a tooltip. Single-hurdle was too narrow; institutional CLO equity buyers typically target 12-15% on seasoned secondary, not 10%.

```
Book Value: 55.4c (€24.8M)
Fair Value @ 10% IRR (model): 36c (€16.1M)
Fair Value @ 15% IRR (model): 27c (€12.1M)
                              ⓘ Implied fair value under the model's current assumptions.
                              ⓘ NOT a market quote; transactable price may differ.
```

Note the **inline `(model)` marker** in the visible label, not just the tooltip. Tooltips are easy to miss; the inline marker puts the disclaimer in the visual signal.

**Default:** ship two hurdles by default (10% + 15%) — both visible. The 10% hurdle anchors the institutional minimum (recovery / rates-driven secondary buyers), the 15% hurdle anchors the more aggressive secondary buyer hurdle. The forward-IRR triple (per §3.1) uses the 10% hurdle's fair value as its third anchor row.

**Fallback:** if screen real estate forces dropping to a single hurdle (e.g., narrow viewport responsive layout), default to **12%** (median of typical institutional secondary CLO equity hurdles), rendered as `Fair Value @ [12% ▼] IRR (model): XXc` with dropdown options [8, 10, 12, 15]. The 12% default applies ONLY to the single-hurdle fallback, not the default two-hurdle layout. State this explicitly to prevent inconsistency between desktop (10% + 15%) and mobile (12%) defaults.

**Files:**
- `web/lib/clo/services/fair-value.ts`: service supports an array of hurdles, returns `{ hurdle, priceCents, convergenceIterations, status: "converged" | "below_hurdle" | "wiped_out" }[]`.
- `web/app/clo/waterfall/ProjectionModel.tsx`: render fair-value rows next to book; inline `(model)` marker; tooltip with full disclaimer.

**Success criteria:** fair value displayed at two hurdles by default; `(model)` marker visible in the label without hover; tooltip reinforces but isn't load-bearing.

### 3.5 Decision log — `docs/clo-modeling-decisions.md`

**Problem:** v6's load-bearing decisions are scattered across CLAUDE.md, the v6 plan, KI-25, and PR descriptions. Future investigators can't find them quickly.

**Decision:** seed `docs/clo-modeling-decisions.md` with nine enumerated decisions plus the engine-silence boundary. Each entry: what was decided, alternatives considered, evidence driving the choice, risks accepted. Decision-log review cadence: append entries when phase gates close, when trustee tie-out failures are documented, when a v6-style incident closes, or when a plan-level revision lands per §14.

Seeds:

1. **`principalAccountCashForward` deletion (resolver-side manifestation of the unfloored-overdraft principle; see also #3).** Decided 2026-04-29. Floor-at-zero variant manufactured fake alpha by ignoring determination-date overdraft. Trustee Apr-15 BNY Note Valuation showed the principal account cleared from −€1.82M (determination date) to €0 (post-payment) with €0 distributions through the Principal POP — i.e., the overdraft was a real claim against equity that had to be netted, not floored. Alternative considered: keep `principalAccountCashForward` as floored variant for "optimistic" mode. Rejected because there's no economic justification for the floor. Risk accepted: forward IRR drops by ~2pp on Euro XV vs the floored variant's pre-deletion display; that drop reflects reality. **Cross-reference:** decision #3 covers the engine-side consumption of the same principle; both rest on the same trustee evidence and the same heuristic-as-value rejection.

2. **`equityBookValue` + `equityWipedOut` centralization on `ProjectionInitialState`.** Decided 2026-04-29 (PR1). Single source: `Math.max(0, totalAssets - totalDebtOutstanding)` with `equityWipedOut: boolean` flag set when the floor fires. Alternatives considered: (a) UI computes book independently (rejected — produced silent drift between engine and UI); (b) raw signed value (rejected — calculateIrr returns nonsense on negative-equity series). Risk accepted: β-floor masks negative balance-sheet states; mitigated by `equityWipedOut` flag plumbed through to UI banner and MC short-circuit.

3. **Unfloored `q1Cash` netting (engine-side manifestation of the unfloored-overdraft principle; see also #1).** Decided 2026-04-29 (v6). Engine signs `initialPrincipalCash` and nets against Q1 principal collections (search `runProjection` for `q1Cash` injection site; line numbers will drift, function name will not). Alternative considered: `Math.max(0, initialPrincipalCash)` heuristic (rejected as category γ — manufactures fake alpha; trustee Apr-15 evidence shows the overdraft is real). Risk accepted: forward IRR is realistically negative on overdrawn deals; no ergonomic shortcut. **Cross-reference:** decision #1 is the resolver-side counterpart that ensures the floored variant isn't even available for the engine to consume.

4. **Architecture-boundary AST rules — four explicit incident-pattern rules, identifier-string-matching first pass.** Decided 2026-04-29 (PR4). Rules: `ui-uses-inputs-in-arithmetic`, `ui-back-derives-equity`, `ui-reads-raw-principal-cash`, `ui-recomputes-book-value`. Scope: `web/(app|components)/clo/.*`. Alternative considered: type-aware analysis via `getApparentType()` (deferred to Phase D as substantive correctness improvement; current rules guard against the original incident pattern but are bypassable by destructuring/renaming). Risk accepted: identifier-rename evades detection; mitigated by Phase D type-aware upgrade.

5. **Wiped-out short-circuits — explicit guard on `equityIrr` + Monte Carlo.** Decided 2026-04-29 (post-v6 review). In `runProjection`, the equityIrr computation is wrapped: `initialState.equityWipedOut ? null : calculateIrr(equityCashFlows, 4)`. In `runMonteCarlo`, calibration short-circuits before any scenario when `calibration.initialState.equityWipedOut`, returning `wipedOut: true` with NaN percentiles and zero runs. UI (`MonteCarloChart`) surfaces "balance-sheet insolvent" banner. Alternative considered: rely on implicit chain (`-0 >= 0` early return; all-non-negative cashflows). Rejected because chain depends on JS semantic + downstream non-negativity invariants neither enforced. Risk accepted: explicit guard adds one branch but makes the contract direct.

6. **Auto-fill UX — three forward-IRR displays side-by-side, not a default-flipped slider.** Decided this plan (Phase 0). Displays cost-basis, book, fair-value forward IRRs simultaneously. Slider becomes secondary what-if input. Alternative considered: change slider default from inception cost to book value (rejected as slider-game UX; doesn't surface the three meaningful entry-price points). Risk accepted: UI is denser by one row; mitigated by clear labeling.

7. **Since-closing IRR methodology — three modes shipped, not one picked.** Decided this plan (Phase 0). Realized / mark-to-book / mark-to-model shown as separate displays. Alternative considered: pick one canonical mode (rejected because all three answer different legitimate questions). Risk accepted: more screen real estate; mitigated by labeling and grouping.

8. **Default forward-run model state — two scenarios shown side-by-side once Phase A I.1 lands.** Decided this plan (Phase 0 anticipates; Phase A wires). "No call" remains the conservative baseline; "Optional redemption call at par" becomes the realistic baseline once I.1 ships. UI displays both. Alternative considered: pick one default (rejected because hardcoding either biases the headline). Risk accepted: more numbers; mitigated by anticipation in Phase 0 labeling so no re-relabel.

9. **Meta-decision: question/answer correspondence (failure pattern from the 95c-confusion incident).** Decided this plan (Phase 0). When a UI control's behavior depends on caller-side state (slider value, toggle position, etc.), but the displayed result label is invariant, the label has lost the question/answer correspondence. The original PeriodTrace bug AND the 95c auto-fill confusion are two instances of the same pattern: a single number was displayed but it was answering a different question depending on caller-side state, and the label didn't disclose the dependency. Resolution policy:
   - **(a) Encode the state in the label** ("Forward IRR @ your cost basis", "Forward IRR @ book") so the label changes when the state changes
   - **(b) Display the result for each meaningful state** simultaneously (the three-row triple is this approach)
   - **(c) Hide/disable the control when its state isn't meaningful** (e.g., slider hidden when wipedOut)
   Auto-fill behaviors require explicit naming of the question being auto-answered. Future review checklist for any UI surfacing CLO-engine output: search for `value={...}` patterns where the value depends on state but the surrounding label doesn't reference that state. Risk accepted: this is a heuristic, not a tractable AST rule; relies on review discipline.

**Plus a "what the engine is silent on" boundary section:**

The engine does NOT model:
- Market quote / transactable bid for the equity (no secondary curve, no dealer feeds)
- Individual credit events on individual loans (probabilistic only)
- Manager-behavior prediction (manager will/won't call, won't extend RP, won't reset)
- Forward EURIBOR path beyond the user-supplied curve
- Liquidity / transaction costs / market frictions

These are intentional omissions. Future workstreams may close some; named explicitly in §8.

**Files:**
- `docs/clo-modeling-decisions.md`: new file with sections per decision.

### 3.6 Architecture-boundary scope already widened

**Status:** SHIPPED in this session. `architecture-boundary.test.ts:58/69/80/91` covers `web/(app|components)/clo/.*`. No further work.

### 3.7 Wiped-out guards already in place

**Status:** SHIPPED in this session.
- In `runProjection`: explicit `initialState.equityWipedOut ? null : calculateIrr(...)`.
- In `runMonteCarlo`: short-circuit before any scenario; returns `wipedOut: true` with NaN percentiles.
- `MonteCarloChart.tsx`: red insolvency banner when `result.wipedOut === true`.

No further work.

### 3.8 State migration for saved entry prices

**Problem:** Phase 0 reframes the entry-price slider from primary driver to secondary what-if. If a user has a saved entry price (URL params, localStorage, backend state), Phase 0 must preserve user state across the migration.

**Required pieces:**
- Audit current state-persistence mechanism for `equityEntryPriceCents`. Likely: URL params and possibly localStorage.
- Migrate any saved value to a `customEntryPriceCents` slot (the new "what-if" slider). Don't lose user-entered overrides.
- If the saved value matches the inception purchase price (95c on Euro XV), drop it — that's the auto-fill the migration is undoing. Otherwise preserve as a custom override.
- Decision-log entry: "Phase 0 migration of saved entry-price slider state — auto-filled values dropped; user-entered overrides preserved."

**Tests:** unit test for migration function over a few saved-state shapes.

### 3.9 External-materials audit

**Problem:** Phase 0 changes partner-visible labels ("Projected Forward IRR" → "Forward IRR (held to legal final, no call)"). Existing external materials referencing the old labels — partner decks, exported PDFs, screenshots embedded in docs — silently become wrong post-Phase 0.

**Required pieces:**
- Pre-Phase-0 deliverable: audit `docs/`, `web/docs/`, any partner-shared decks or PDFs, screenshot-based onboarding for occurrences of old labels: "Projected Forward IRR", "Inception IRR", "Inception IRR (since closing)", "Inception IRR (user anchor)".
- Catalog occurrences. Decide per-instance: (a) update to new label, (b) annotate with "(pre-2026-04 labeling — see <new doc>)", or (c) supersede the document with a new version.
- This is a scope-of-work item, not a bureaucratic one: solo authorship doesn't mean solo consumption. The plan's outputs are partner-facing.

### 3.10 Phase 0 success criteria

- Partner views the equity card and sees three forward IRRs (cost basis / book / fair value-10%), each labeled.
- Partner views the equity card and sees Fair Value @ 10% IRR + @ 15% IRR alongside Book Value, with the inline `(model)` marker on the visible label and full disclaimer in the tooltip.
- Three relabels live: "Mark-to-book IRR (called at book today)", "Forward IRR (held to legal final, no call)", "Realized IRR (cashflows received only)".
- `docs/clo-modeling-decisions.md` enumerates 9+ decisions with paragraphs each, plus the engine-silence boundary.
- Saved entry-price state migrated cleanly per §3.8; no user-entered overrides lost.
- External materials audit (§3.9) catalog complete; old-label occurrences identified and triaged.
- All existing tests still pass.

---

## 4 · Phase A — Engine completeness for headline credibility

**Theme:** make the headline forward-IRR number meaningful. Current value (-11.95% on Euro XV at 95c entry) is correct given assumptions but unrealistic because manager call is unmodeled. Phase A adds the missing levers and tie-out validation against trustee data.

### 4.1 I.1 — Manager call modeling

**Required pieces:**

1. **Resolver:** add `optionalRedemptionDate: string | null` to `ResolvedDates`. Extracted from PPM § Optional Redemption (PPM citations indicate which page; resolver pulls if available, else null with warning).
2. **ProjectionInputs:** add three fields:
   - `callMode: "none" | "optionalRedemption"` (Phase A scope only — `"economic"` mode is deferred to Phase D §7.4 where the methodology is designed; do NOT include `"economic"` in the type union until then)
   - `callPriceMode: "par" | "market" | "manual"` (distinct from `callPricePct`)
   - `callPricePct: number` (used when `callPriceMode === "manual"`)
3. **Engine:** when `callMode !== "none"` and the chosen call date is reached, execute clean liquidation:
   - Pool sold at liquidation price (par / market / manual)
   - Debt paid at par per priority (senior to junior)
   - **Incentive fee on call:** if equity IRR through the call date exceeds the PPM hurdle, the incentive fee fires per PPM § CC. Engine must compute the cumulative-IRR-at-call and deduct incentive fee from the residual before returning to equity. Without this, equity residual at call is overstated by 20% × excess-over-hurdle.
   - Residual (post-incentive-fee) to equity in one bullet at the call date
4. **UI:** wire `callMode` and `callPriceMode` to controls in the Dates panel. Default `callMode = "none"` for backwards-compatible display; secondary "Optional redemption call at par" view shown side-by-side per Phase 0 decision.

**Market-mode fallback semantics (committed):** when `callPriceMode = "market"` is selected but holdings-level market values aren't reliably extracted, engine throws with explicit error: `"Market call price requires loan-level market values; deal does not have these. Set callPriceMode to 'par' or 'manual'."` UI catches this error and surfaces it as a user-actionable prompt. **Do NOT silently fall back to par** — that manufactures fake optimism (par-call IRR is generally better than market-call IRR for healthy deals trading above par; the silent fallback would bias the displayed IRR upward).

**Tests:**
- Per-tranche payoff order under call (senior pays first, equity gets residual).
- Residual to equity matches PPM § Optional Redemption waterfall.
- Call date earlier than first scheduled payment date errors out cleanly.
- Call price < debt par triggers tranche shortfall (currently undefined behavior).
- Incentive fee fires on call when IRR > hurdle; doesn't fire otherwise. Verify against PPM § CC.
- Market-mode fallback throws cleanly when holdings-level market values are absent.
- Counterintuitive case: `equityIrr_with_call < equityIrr_no_call` for a deal where the call retires equity at zero residual but continued operation would have produced distributions. UI displays both; partner reads the spread to see when call is value-destructive.

**Deferred (out of scope for this plan, named explicitly):**
- **Partial / clean-up calls.** Some PPMs allow partial redemption when pool falls below a clean-up threshold. Engine currently models all-or-nothing call; partial-call mechanics deferred. If a deal's PPM specifies clean-up calls, the manual call-date input lets the user model the timing but not the partial mechanic; flag in UI provenance.

**Upstream gate:** PPM optional-redemption-date extraction. If extraction is unreliable for a given deal, require manual call-date entry in the UI before showing the "with call" IRR for that deal (no silent "no call" fallback — that just preserves the pre-Phase-A defect). Show explicit "Manual entry required" prompt with provenance badge distinguishing extracted vs. manually-entered.

### 4.2 I.3 — Stub-period engine (opt-in, not universal)

**Required pieces:**

1. Engine accepts `currentDate` intra-period (not aligned to scheduled payment dates).
2. **Opt-in via `stubPeriod?: boolean` flag in `ProjectionInputs`** (default false). When false, current behavior preserved (currentDate must align to a payment date or engine assumes alignment); when true, first emitted period is a stub from `currentDate` → `nextPaymentDate`.
3. Stub period uses prorated day-count fractions, prorated CPR/CDR, prorated fees.
4. Subsequent periods are full quarters as today.

**Backwards compatibility — committed:** stub-period is opt-in by design. Universal stub-period would silently change the semantics of ~25 existing fixture tests that assume aligned `currentDate`. Opt-in preserves those; new code (trustee tie-out, intra-period scenarios) sets `stubPeriod: true` explicitly. Migration path: tests that benefit from stub-period semantics opt in over time; legacy tests stay aligned.

**Tests:**
- Stub period day-count: Apr 1 → Apr 15 fraction matches Actual/360 expectation.
- Stub period interest accrual: scaled correctly.
- Stub period defaults: per-loan hazard scaled to fractional period.
- Default-false back-compat: existing fixtures (callable without setting `stubPeriod`) produce byte-identical output to pre-Phase-A engine on Euro XV.

**Unblocks:** trustee tie-out test (V.3) and intra-period scenario analysis ("if defaults happen this week, what happens at next distribution").

### 4.3 I.4 — Per-period balance instrumentation

**Required pieces:**

Add to `PeriodResult`:
- `endingPrincipalAccount: number`
- `beginningPrincipalAccount: number`
- `endingInterestAccount: number`
- `beginningInterestAccount: number`
- `endingDefaultedPar: number`
- `endingPerformingPar: number`

Engine has these internally as running balances; just expose. No semantic change.

**Tests:**
- Conservation: `endingPrincipalAccount[N] = beginningPrincipalAccount[N+1]` for every N.
- Conservation: `endingDefaultedPar[N+1] - endingDefaultedPar[N]` matches new defaults this period − recovered defaults this period.

**Unblocks:** trustee tie-out test (V.3).

### 4.4 V.3 — Trustee tie-out test

**Required pieces:**

Given a deal with a trustee report at date D:
1. Run engine with `currentDate = D - 1 day` and `stubPeriod: true`, project through D.
2. Assert engine's emitted-at-D values match trustee report ± per-bucket tolerance (table below).
3. Failures with documented tolerance and KI-xx links pass; undocumented red rows fail the test.

**Concrete tolerances (committed; calibrated from N1 harness on Euro XV):**

| Bucket | Tolerance | Rationale |
|---|---|---|
| `endingPrincipalAccount` | ±€1 | Penny-rounding only; trustee and engine should agree to the cent on a closed account |
| `endingInterestAccount` | ±€1 | Same as above |
| Per-tranche interest paid | ±€10 | Day-count drift KI-12b absorbs <€10 typical; tighten as KI closes |
| `equityFromInterest` | ±€10 (canary) / ±€1,000 (KI-13 absorbed) | KI-13/KI-13a sub-distribution cascade explains residual |
| `equityFromPrincipal` | ±€1 | Normally zero in healthy quarters; tight if non-zero |
| OC ratios | ±0.05 pp | Composition cascade KI-14 |
| IC ratios | ±0.10 pp | KI-14 cascade tolerance |
| Senior fees (taxes, issuer profit, trustee, admin, senior mgmt, hedge) | ±€100 each | KI-12a sub-mgmt-fee base discrepancy applies |

**KI-entry schema for documented drifts:**

```
[KI-xx] <name>
Status: documented drift (engine-trustee tie-out)
Bucket: <bucket name>
Observed delta: €X (engine N - trustee N)
Allowed tolerance: €Y
Rationale: <why this drift exists; cross-reference upstream KI if cascade>
Closure path: <what changes the delta to zero — typically another KI closing>
```

**Fixture:** Euro XV BNY Apr-15 actual (already in `new_context.json`).

**Tests:** new `web/lib/clo/__tests__/engine-trustee-tieout.test.ts`.

**Depends on:** I.3 (stub period) + I.4 (balance instrumentation).

### 4.5 I.2 — Reinvestment Period extension only (reset deferred to Phase D)

**Problem:** v6 plan conflated reset and RP extension. They are different optionalities with very different scopes.

**RP extension (Phase A scope):** add `reinvestmentPeriodExtension: string | null` to inputs. Engine computes effective RP end as `max(extractedReinvestmentPeriodEnd, reinvestmentPeriodExtension)` — the user-supplied extension can extend, but cannot inadvertently shorten, an already-late extracted RP end. Engine reads the effective RP end as the gate for reinvestment. That's it. Simple, standalone, ships in Phase A.

**Tests:** include a case where `extension < extractedRP` to confirm the max() semantics — extension shouldn't shorten the RP.

**Reset (deferred to Phase D §7.x — too underspecified for Phase A).** A real reset is more than "liquidate + new debt." Missing pieces that need design before code:
1. **Pool replacement.** A reset typically refreshes the portfolio (new WAS, new ratings, new spreads). Engine needs post-reset portfolio assumptions, not just tranche specs.
2. **Equity cashflow at reset.** Equity holders may fund the difference between liquidation value and new debt issued — positive or negative cashflow to equity, not a silent "rolling into new vintage."
3. **New RP start.** A reset typically refreshes the RP. Implicit (default duration from reset date)? Explicit (user provides new RP end)?
4. **Day-count and accrual continuity** across the reset boundary. Stub period before reset; new period after?
5. **Hedge termination + new hedge.** If the deal had a hedge, what happens at reset?

The Phase A plan as previously written committed to "ship reset" but covered ~30% of the actual mechanics. Deferring to Phase D where the design pre-commit can happen first.

**Tests (Phase A scope, RP extension only):**
- RP extension: equity distributions for periods between scheduled-RP-end and extended-RP-end use reinvestment-spread regime, not amortization regime.
- Pre-extension behavior unchanged when `reinvestmentPeriodExtension === null`.

### 4.6 Phase A success criteria

- Forward IRR display has both "no call" and "optional redemption call at par" scenarios visible side-by-side.
- Engine produces materially different forward IRR for `callMode = "none"` vs `"optionalRedemption"` (concrete: Euro XV at 95c entry, expected directional shift towards less negative under call).
- Trustee tie-out test passes for Euro XV BNY Apr-15 fixture (within documented tolerances; failures linked to KI ledger).
- Stub-period day-count and accrual tests green.
- RP extension is independently testable engine feature.
- Reset modeling is **explicitly deferred** to Phase D §7.x with the missing-mechanics list captured.

### 4.7 Phase A dependencies

- Upstream: PPM extraction must reliably surface optional-redemption-date. If not, ship I.1 with manual-override field flagged in UI.
- Phase 0 decisions (especially "two scenarios side-by-side") must be locked so the UI surface for I.1 is known.

---

## 5 · Phase B — Sensitivity infrastructure (slim)

**Theme:** three services and one card augmentation. No Greeks (yet), no scenario presets, no separate tab. Answer the partner's "what's a fair price" and "what changes if called early" questions; defer the rest until partners ask.

### 5.1 Entry-price-vs-IRR sweep

**File:** `web/lib/clo/services/entry-price-sweep.ts`

```ts
export function sweepEntryPrice(
  inputs: ProjectionInputs,
  prices: number[],
): { priceCents: number; irr: number | null }[]
```

Pure function. For each price, sets `equityEntryPrice`, runs `runProjection`, returns IRR. Tests: monotonicity (higher price → lower IRR for non-wiped-out deals).

### 5.2 Fair-value-at-hurdle

Already shipped in Phase 0 (§3.1, §3.4). Just confirm it's in `web/lib/clo/services/fair-value.ts`.

### 5.3 Call-sensitivity grid

**File:** `web/lib/clo/services/call-sensitivity.ts`

```ts
export function callSensitivityGrid(
  inputs: ProjectionInputs,
  options?: { callDates?: string[]; callPriceModes?: ("par" | "market")[] },
): { callDate: string; callPriceMode: string; irr: number | null }[]
```

**Default callDates** when `options.callDates` is undefined: derived from the deal's `optionalRedemptionDate` (Phase A I.1 output) plus annual offsets — `[ord, ord+1y, ord+2y, ord+3y]`. The Euro-XV-specific hardcoded dates (`["2027-04-15", "2028-04-15", "2029-04-15", "2030-04-15"]`) are wrong for any deal with a different non-call period; deal-aware default selection generalizes. If `optionalRedemptionDate` is null (extraction failed), service errors out with `"Cannot derive default callDates without optionalRedemptionDate; supply explicit callDates option."`

**Default callPriceModes** when `options.callPriceModes` is undefined: `["par", "market"]`. Per §4.1, market-mode falls back to error if holdings-level market values aren't extracted; service propagates that error per cell rather than aborting the whole grid.

4 dates × 2 modes = 8 numbers. Renders as a small table in the equity card, not a heatmap. Form-factor decision can change later; data is the load-bearing piece.

### 5.4 UI augmentation

**File:** `web/app/clo/waterfall/ProjectionModel.tsx`

Add a "Sensitivities" expandable section below the equity card:
- Entry-price curve table (8 rows: 25c, 35c, ..., 95c)
- Call-sensitivity table (8 cells: 4 dates × 2 modes)
- Each annotated with "(model output, not market quote)"

No separate tab. No fancy charts. Tables and labels.

### 5.5 What's deferred to Phase D

- Risk greeks (∂IRR/∂CDR, etc.)
- Pricing greeks (DV01, spread duration) — separate plan with secondary-curve prerequisite
- Scenario presets (base/bearish/bullish)
- Heatmaps / charts
- Sensitivities tab as separate route

These ship if and only if a partner asks.

### 5.6 Phase B success criteria

- Partner can read "what's it worth" off the fair-value display (Phase 0).
- Partner can read "what changes if called at Q4/Q8/Q12 at par or market" off the call-sensitivity table.
- Partner can read the entry-price-vs-IRR curve for any custom hurdle.
- All annotated with model-vs-market disclaimer.

---

## 6 · Phase C — Coverage broadening

**Theme:** generalize beyond Euro XV. Synthetic fixtures first; real-deal extraction is a separate workstream.

### 6.1 Synthetic-fixture cross-deal validation

**Required pieces:**

Build hand-constructed `ResolvedDealData` fixtures covering structural variations:

1. **5-class structure:** A, B, C, D, Sub. No Class F. Tests reinvestment-OC trigger seniority gracefully.
2. **7-class structure with A-1/A-2 split:** A-1, A-2, B, C, D, E, F, Sub. Tests pari-passu pari-payment-date logic.
3. **A-only deal:** A, Sub. No mezz. Tests zero-mezz-deferral path.
4. **Fixed-rate-heavy deal:** at least 3 fixed tranches. Tests fixed/floating mix.
5. **Hedge-heavy deal:** material hedge cost (50+ bps). Tests step (F) accruals.
6. **No-RP deal:** RP already ended at currentDate. Tests post-RP amortization-only path.
7. **Wiped-out deal:** totalDebt > totalAssets. Tests Phase 0 and Phase A wiped-out plumbing.
8. **Deal with active deferred interest (PIK):** Class C/D/E with current pay shortfalls, deferred interest accruing. Tests PIK compounding path which Euro XV doesn't exercise (all classes pay current).
9. **Deal with active OC failure (cure diversion firing):** Class E or F OC test below trigger; `ocCureDiversions` non-empty. Tests the cure-diversion engine path that Euro XV doesn't exercise (all OC tests pass with cushion).
10. **Deal with active EoD (post-acceleration mode):** `eventOfDefaultTest.isAccelerated === true`. Tests `runPostAccelerationWaterfall` and acceleration-mode `availableForTranches: null` rendering.

**Test:** `web/lib/clo/__tests__/synthetic-fixtures.test.ts`. Each fixture runs through `runProjection`, asserts:
- No NaN, no Infinity in any emitted field
- IRR in [-50%, +50%] **OR** null (with `equityWipedOut === true` for the null case)
- Book value cents in [0c, 200c] (floored at 0; healthy deals can exceed 100c if assets > debt + sub par; document the actual expected upper bound per fixture)
- OC test ratios > 50% **OR** documented insolvency state (acceleration / EoD / wiped-out)
- Period count consistent with maturity
- For each fixture's distinguishing engine path, assert the corresponding `stepTrace` field is non-zero (e.g., `ocCureDiversions.length > 0` for fixture #9; `isAccelerated === true` for fixture #10)

This catches structural bugs in resolver / engine without requiring real-deal extraction.

### 6.2 V.4 — Trustee waterfall replay

**Required pieces:**

Given a trustee report at period N:
1. Run engine with `currentDate = trustee_report_date_N - 1 day`.
2. Project through trustee_report_date_N (uses Phase A I.3 stub period).
3. Compare engine's emitted period N against trustee period N+1 (since the trustee report describes payments due at the next date).

Tighter loop than the multi-period harness (T1) but same comparison logic.

**Test:** `web/lib/clo/__tests__/trustee-replay.test.ts`. Initial fixture: Euro XV BNY Apr-15.

### 6.3 V.5 — Per-loan default backtest (gated)

**Required pieces:**

For deals where loan-level default events are extracted (Euro XV partial), replay engine with loan-level hazards instead of bucketed:

1. Take the current bucketed default model.
2. Take a loan-level hazard model (e.g., per-loan PD from rating + time-to-maturity).
3. Run both; compare to trustee.

If loan-level is closer to trustee than bucketed, switch the default. If not, keep bucketed and document why.

**Gate:** loan-level extraction must be available. For Euro XV, partial; deal-by-deal availability varies.

### 6.4 Real-deal extraction is OUT OF SCOPE

Acquiring more real CLO data, parsing PPMs for more vintages, building extraction infrastructure for non-Euro-XV deals — all separate workstreams. Named in §8.

### 6.5 Phase C success criteria

- Synthetic fixtures green; engine satisfies the §6.1 sanity bounds (IRR in [-50%, +50%] ∪ null; book in [0c, 200c]; OC > 50% ∪ documented insolvency; engine path assertions per fixture-specific distinguishing field).
- Trustee replay test green for Euro XV; framework ready for additional fixtures.
- Per-loan default backtest done or explicitly deferred with rationale.

---

## 7 · Phase D — Long-tail correctness, hardening, deferred items

**Theme:** indefinite list, pulled as bandwidth allows. Each item is independently shippable.

**Priority tags within Phase D:**

- **D-α (high-priority correctness — pull next when Phase D starts):** items that close real gaps. §7.1, §7.5, §7.7, §7.8, §7.15a (design), §7.15b (implementation, gated on §7.15a).
- **D-β (hardening — pull when bandwidth allows):** items that prevent hypothetical regressions. §7.2, §7.6, §7.9, §7.10, §7.11.
- **D-γ (deferred until partner demand or specific external trigger):** items justified only by anticipated need. §7.3 (risk greeks — table-stakes for institutional, but no current partner asking), §7.4 (stochastic call timing — needs design pre-commit), §7.12 (hedge interaction — material only for hedged deals; Euro XV is unhedged), §7.14 (documentation polish), §7.16 (deferred Phase B items).

This makes "pull as bandwidth allows" actionable: when a developer has a free afternoon, they pull D-α first; D-β if no D-α remains; D-γ only if D-β is exhausted or external trigger arrives.

### 7.1 [D-α] Type-aware AST rules

**Problem:** v6 AST rules are bypassable by destructuring or rename (verified by canary).

**Fix:** replace string-identifier matching with `getApparentType()` / `getSymbol()` resolution via ts-morph. Each rule's `detect()` becomes type-aware: e.g., `ui-back-derives-equity` detects ANY arithmetic on a value whose type resolves to `PeriodResult["equityDistribution"]`, regardless of how it's named.

**Tests:** canaries with destructured forms (`const { equityDistribution } = period; const x = equityDistribution - 100;`) should fire the rule.

**File:** `web/lib/clo/__tests__/architecture-boundary.test.ts`.

### 7.2 [D-β] Engine purity AST + determinism property test

**Files:**
- `web/lib/clo/__tests__/engine-purity.test.ts`: AST-asserts no `import "react"` / `import "next/*"` / `fetch(` / `process.env.*` (except in test scaffolding) / `Date.now()` / `async function` in `projection.ts`, `harness.ts`, `sensitivity.ts`.
- `web/lib/clo/__tests__/engine-determinism.test.ts`: run engine 100x with identical inputs; assert byte-identical outputs (deep equality on `result`).

Preventive infrastructure. No current violations, but cheap insurance.

### 7.3 [D-γ] Risk greeks (numerical derivatives)

**File:** `web/lib/clo/services/risk-greeks.ts`

Centered numerical derivatives of forward IRR w.r.t. each assumption, with configurable bump size:
- `∂IRR/∂CDR` per rating bucket
- `∂IRR/∂CPR`
- `∂IRR/∂recoveryPct`
- `∂IRR/∂baseRatePct`
- `∂IRR/∂reinvestmentSpreadBps`

Rendered as a table in the Sensitivities section.

**NOT pricing greeks.** Pricing greeks (DV01, spread duration, convexity) require a modeled secondary curve (equity-spread-to-IRR mapping); that's a separate plan with prerequisite work, not in scope for this plan.

### 7.4 [D-γ] I.5 — Stochastic call timing in Monte Carlo (with defensible methodology)

**Problem:** hand-tuned pmf is stochasticity theatre.

**Defensible methodology options:**

1. **Economic call rule:** call fires when residual manager-fee economics flip below a threshold. Requires defining the threshold (e.g., AUM × subFeePct < some-fixed-cost). Explicit, defensible, deal-specific.

2. **Empirical call distribution:** distribution sampled from historical Euro CLO calls (vendor data: BAML, JPM CLO research, etc.). Requires data acquisition.

Pause for design review before shipping any version. Hand-tuned pmf is rejected.

### 7.5 [D-α] I.6 — CDR sample paths (optional-fn API, not breaking change)

**Problem:** `Record<bucket, pct>` → `Record<bucket, pct[]>` invalidates every test fixture.

**Fix:** keep current `defaultRatesByRating: Record<bucket, pct>`. Add optional `cdrPathFn?: (q: number) => Record<bucket, pct>`. When present, called once per quarter; when absent, current constant behavior. Same modeling power, no migration cost.

### 7.6 [D-β] I.7 — Recovery lag stochasticity

Add `recoveryLagDistribution?: { meanMonths: number; sigmaMonths: number }`. MC samples from log-normal. Constant case: sigma = 0.

### 7.7 [D-α] I.8 — Base rate path

**Problem:** flat EURIBOR is unrealistic.

**Required pieces:**

1. Replace `baseRatePct: number` with `baseRateCurve?: { quarterIndex: number; rate: number }[]`. Default: constant from current `baseRatePct`.
2. Pre-fill from market forward curve (data acquisition is a separate workstream; ship the API first, populate later).
3. MC samples rate path with stress shocks (parallel ±100bps, etc.).

### 7.8 [D-α] VI.6 — `calculateIrr` bracketed bisection

**Problem:** ad-hoc Newton-Raphson can fail to converge on pathological cashflow series.

**Fix:** replace with bracketed bisection that always converges in [-99%, +1000%] range. Add tests for:
- Alternating-sign cashflows
- Near-zero cashflows
- All-zero cashflows (returns null)
- All-negative cashflows (returns null per existing convention)
- Very large cashflows (no overflow)

### 7.9 [D-β] VI.2 — Per-loan default modeling

Replaces bucketed defaults with per-loan hazards from Moody's CLO methodology (PD curves by rating, time-to-maturity, sector). Toggle switches between bucketed (current default) and per-loan. Ships only if Phase C V.5 confirms it tightens vs. trustee.

### 7.10 [D-β] VI.3 — Industry concentration enforcement (KI-23 close)

Add `industry: string | null` to `ResolvedLoan`. Populate from holdings data. Extend `computePoolQualityMetrics` and switch simulator with `largestIndustryPct`. Extend C1 reinvestment compliance to enforce industry cap.

### 7.11 [D-β] VI.4 — Frequency switch event

KI-04: when frequency switch trips mid-projection, interest accrual cadence changes (quarterly → semi-annual). Currently not modeled. Add as engine state transition.

### 7.12 [D-γ] VI.5 — Hedge interaction

Hedging-cost-vs-payment-vs-termination interaction. For deals with currency or interest-rate hedges, the cost interaction can move IRR materially. Currently `hedgeCostBps` is a flat accrual; doesn't model swap notional decay, terminations on default, or settlement payments.

For Euro XV (`hedgeCostBps = 0`) this is genuinely long-tail. For currency-hedged deals it materially affects IRR. Priority depends on deal universe.

### 7.13 [ongoing] Decision-log extension

As phase gates close and trustee-tie-out failures are documented, append post-decision-validation entries to `docs/clo-modeling-decisions.md`. The log is a living document, not a one-shot seed. Triggers per §3.5: phase gate closure, trustee tie-out failure documentation, v6-style incident closure, plan-level revision per §14. Untagged within Phase D priority because it's process work, not feature work.

### 7.14 [D-γ] Documentation polish

- Per-deal CLO modeling notes (one per partner-facing deal).
- API documentation for engine + service layer (TSDoc → generated docs).
- Onboarding guide for new contributors to the engine.
- Glossary as a standalone doc (not just an inline UI element).

### 7.15a [D-α] Reset modeling — design spec (pullable independently)

Moved from Phase A §4.5 because the spec was 30% complete. **§7.15a is a design-only deliverable**: it produces `docs/plans/clo-reset-design.md` and does not touch engine code. The implementation (§7.15b) is gated on §7.15a's design merging.

**Output:** `docs/plans/clo-reset-design.md` covering:

1. **Pool replacement.** A reset typically refreshes the portfolio (new WAS, new ratings, new spreads). Engine accepts post-reset portfolio assumptions, not just tranche specs.
2. **Equity cashflow at reset.** Equity holders may fund the difference between liquidation value and new debt issued — positive or negative cashflow to equity, modeled explicitly.
3. **New RP start.** Reset typically refreshes the RP. Decide: implicit (default duration from reset date) vs. explicit (user provides new RP end).
4. **Day-count and accrual continuity** across the reset boundary. Stub period before reset; new period after?
5. **Hedge termination + new hedge.** If the deal had a hedge, define what happens at reset.
6. **Tranche restructuring.** New tranches issued at reset typically have different sizes / coupons / maturities. Document how engine ingests post-reset tranche specs.
7. **Reset cost / OID.** Reset typically incurs new-issuance costs and OID amortization. Model or absorb?

**Success criteria for §7.15a:** design doc covers all seven mechanics with concrete data-flow diagrams; engine input/output shapes specified; UI control surface specified; test plan enumerated. Sign-off before §7.15b begins.

### 7.15b [D-α, gated on §7.15a] Reset modeling — implementation

Ships only after §7.15a's design merges and is validated against at least one PPM § Reset reference. Until §7.15a merges, this section is a placeholder.

**Files (post-design-pre-commit):**
- `web/lib/clo/projection.ts`: reset state transition
- `web/lib/clo/services/reset-modeling.ts`: equity-cashflow-at-reset service (depends on liquidation price service)
- `web/app/clo/waterfall/ProjectionModel.tsx`: reset-date input control + reset-cashflow display

### 7.16 [D-γ] Deferred from Phase B (pull on partner request)

- Pricing greeks (separate plan; secondary-curve prerequisite)
- Scenario presets (base/bearish/bullish)
- Heatmaps / charts
- Sensitivities as a separate route
- Provenance markers on every displayed number

### 7.17 Items already in queue (T1, T2, T5)

- T1: Multi-period engine-vs-Intex backtest harness (P0–P16) — extension of Phase C V.4
- T2: KI-12a close (sub mgmt fee base discrepancy)
- T5: KI-21 Scope 3 step-executor refactor (Sprint 6)

---

## 8 · Out of scope (explicit boundary)

These are real workstreams but not in this plan. Naming them prevents scope creep.

**Market data integration**
- Bloomberg / IHS Markit / dealer-runs for secondary CLO equity quotes
- Live EURIBOR forward curve fetch
- Loan-level market-value-of-pool feeds
- Manager-call activity database

**Real-deal extraction infrastructure**
- PPM / SDF / Intex extraction for non-Euro-XV deals
- Multi-deal resolver-canonicalization expansion
- Cross-deal data-quality framework

**Pricing greeks workstream**
- Secondary curve modeling (equity-spread-to-IRR mapping)
- DV01 / spread duration / convexity
- Refi-economic call price modeling

**Manager-behavior prediction**
- ML or rule-based prediction of whether manager will call / extend / reset
- Manager-track-record analysis
- Equity-vote modeling for call decisions

**Individual credit verdicts**
- Loan-level default prediction (engine models hazard rates, not events)
- Sector / rating-migration forecasting
- Rating-action-driven scenario propagation

Each is a real partner-need but a separate planning effort. Do not blur into this plan.

---

## 9 · Open product decisions

These should be locked before substantive code on the affected items begins. Phase 0 commits to all of them; this section enumerates them in one place.

| # | Decision | Phase 0 commitment |
|---|---|---|
| 1 | Auto-fill UX for entry-price slider | Side-by-side three-IRR display; slider becomes secondary what-if |
| 2 | Since-closing IRR methodology | Ship all three (realized / mark-to-book / mark-to-model) |
| 3 | Default forward-run model state | Two scenarios side-by-side once Phase A I.1 lands ("no call" + "optional redemption at par"); "no call" remains conservative baseline |
| 4 | Call-price default in I.1 | "par" default, with manual override; market-mode requires holdings-level market values to be reliable |
| 5 | Engine-emitted IRR if call modeled | Single number (the called IRR); UI surfaces both no-call and called IRRs from two engine runs, not a hybrid. **Critically, the side-by-side display extends to all derivations** that depend on the call assumption — Forward IRRs, Fair Value @ hurdle, Mark-to-model IRR — not just the headline forward-IRR row. (#11 covers default state and toggle behavior; this row covers what's derived simultaneously.) |
| 6 | Stub-period currentDate scope | Engine accepts ANY intra-period currentDate; no special-case "Apr 15 trustee snapshot" mode |
| 7 | Wiped-out terminal display | No IRR shown (Phase 0 already done via UI banner); decision log entry frames why |
| 8 | Reset modeling vs RP extension | RP extension ships in Phase A as standalone; reset deferred to Phase D §7.15a (design) + §7.15b (implementation gated on design merge): pool replacement, equity cashflow, new RP start, accrual continuity, hedge interaction, tranche restructuring, reset cost/OID |
| 9 | Cross-deal validation strategy | Synthetic fixtures first; real-deal extraction is a separate workstream |
| 10 | Greeks scope | Risk greeks ship in Phase D as numerical derivatives; pricing greeks deferred to separate plan |
| 11 | Phase A side-by-side default state and toggle | When Phase A I.1 lands: default state shows "no call" only across all rows (Forward IRR rows, Fair Value rows, Mark-to-model row). A SINGLE page-level toggle flips ALL rows simultaneously to "with call at par" — never per-row chevrons (those would recreate the original 95c-confusion failure pattern by hiding the comparison the partner needs). Toggle state is not preserved across sessions; default-state-on-load is always "no call" so a fresh viewer sees the conservative baseline first. |
| 12 | Card density philosophy | Phase 0 ships card with three forward-IRR rows + two fair-value rows + three since-closing-IRR rows + book value + custom slider = ~10 lines. This is intentionally dense. Re-evaluate density in Phase D ONLY if (a) a partner explicitly reports density confusion in writing during the cold-read gate (per §11) or post-Phase-0 use, OR (b) a usability review surfaces a specific row that a real reader misreads. Density alone is not a Phase D trigger; misreading is. |
| 13 | Counterintuitive IRR ordering | When two forward IRRs are displayed (Phase A I.1: no-call vs with-call), the rows are ALWAYS ordered "no-call first, with-call second" regardless of which is more conservative or which the deal's IRR ranks higher. A small inline marker indicates which is more conservative for the displayed deal (`(more conservative)` next to the lower IRR; for healthy deals where call is value-additive, marker is on the no-call row; for deals where call is value-destructive, marker is on the with-call row). Reason: ordering by magnitude flips deal-by-deal, breaking the partner's mental anchor. Fixed ordering + marker preserves the anchor while still surfacing the ranking. |

---

## 10 · Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| PPM optional-redemption-date extraction unreliable across deals | Med | Require manual call-date entry in the UI before showing a "with call" IRR for that deal. Provenance badge on the call-date input distinguishes extracted vs. manually-entered. Do NOT silently fall back to "no call" — that just preserves the pre-Phase-A defect; instead show explicit "Manual entry required" prompt for deals where extraction failed. |
| Trustee tie-out reveals systematic engine drift | Low-Med | Phase A V.3 catches it before partner-facing impact; KI-ledger framework absorbs documented drifts; undocumented drift fails the test |
| Synthetic fixtures don't catch real-deal bugs | Med | Phase C runs synthetic AND trustee-replay; real-deal coverage grows as extractions land |
| Phase C reveals v6-era engine bugs requiring dedicated remediation | Med | If trustee tie-out (V.3) or synthetic fixtures (C.1) surface bugs in v6-shipped code, that remediation pre-empts Phase D. Plan implicitly assumes v6 is structurally correct based on Euro XV validation only; cross-deal exposure may invalidate that assumption. Mitigation: budget Phase D as flexible/pull-as-bandwidth so v6-era remediation can take priority. |
| Type-aware AST rules produce false positives | Low | Per-occurrence allow comments (`// arch-boundary-allow: <ruleId>`) already in the framework |
| Manager-call default flips partner-facing IRR materially | Med | Phase 0 ships side-by-side display; partner sees both numbers; no hidden default |
| Fair-value-at-hurdle misread as market quote | High | Inline `(model)` marker in the visible label, not just tooltip; tooltip reinforces with full disclaimer; decision log boundary section names the limit. Inline marker is load-bearing — tooltips alone are too easy to miss. |
| Two-runs MC for forward IRR doubles raw simulation cost | Med | Share calibration between both runs (one calibration, two simulation passes); use the same Bernoulli seed sequence so both runs see identical default paths and differ only in `callDate`. Marginal cost is ~1.2× per scenario, not 2×. Alternative: surface MC for one mode by default with explicit "compute MC for the other mode" button if perf still suffers. |
| Phase A I.1 surface-area churn (call modes interact with RP extension, EoD acceleration) | Med | Comprehensive engine-internal test suite; tests for each pair-wise interaction. Reset is deferred to Phase D so that interaction set is removed from Phase A scope. |
| Phase D items pulled out-of-order, breaking Phase C | Low | Each Phase D item independent; if dependency exists, document explicitly in task description; D-α/β/γ priority tagging at §7 makes pull order explicit |
| Concept-level: partners want a different UI than the side-by-side decided in §9 | Med | Walk Phase 0 through with fresh eyes after a day's break; iterate before locking. Ship to staging first; lock to production only after one week of self-use without confusion |
| Concept-level: 12% (or 10%) is wrong default hurdle for fair-value display | Med | Ship two hurdles by default (10% + 15%) so partner sees both anchor points; allow dropdown for [8, 10, 12, 15] if screen real estate is constrained |
| Concept-level: side-by-side display increases confusion rather than reducing it | Low-Med | Walk through with fresh eyes; if confusion increases, re-evaluate (decision log entry will record the reversal) |
| Phase 0 timeline overrun on mark-to-model alignment work | Med | Per §3.2 mitigation: ship realized + mark-to-book first if alignment work overruns; mark-to-model lands as Phase 0.5 patch. Do NOT delay Phase A on mark-to-model alone; the headline credibility gap (manager call) is more partner-visible than the third IRR variant. |
| Self-validating correctness gap — only Euro XV trustee evidence; no external CLO-modeler review | Med-High | Acknowledged limit named in §13 as a non-promise of this plan. Mitigations within scope: (a) synthetic fixtures (Phase C §6.1) catch structural bugs without requiring a second deal's trustee; (b) trustee-replay framework (Phase C §6.2) is structurally ready for additional deals as extractions land; (c) cross-deal extraction is itself an out-of-scope workstream named in §8. The gap closes only when external review or additional trustee tie-outs land — both are post-plan workstreams. |
| Phase D card density trigger condition ambiguous (§9 #12) | Low | Trigger is in writing: reader self-reports confusion during cold-read gate (§11), or a usability review identifies a specific misread row. "Looks dense" alone does NOT trigger density work. Without this, Phase D risks chasing an aesthetic preference rather than a correctness signal. |
| Counterintuitive IRR ordering misreading (§9 #13) | Low | Fixed-order + inline marker partially mitigates; if marker still misread, fall back to badge styling (color, icon) or re-evaluate ordering policy. Decision log entry will record any reversal. Cold-read gate (§11) catches first-instance misreading. |

---

## 11 · Execution sequencing

Recommended order, but each phase is internally parallelizable:

```
Week 1-2:   Phase 0 (cohesive small fixes + decisions + decision log seed)
Week 3-5:   Phase A (engine completeness — I.1, I.3, I.4, V.3, I.2-split)
Week 6:     Phase B (slim sensitivity infrastructure)
Week 7-8:   Phase C (synthetic-fixture cross-deal validation, trustee replay)
Ongoing:    Phase D (pull as bandwidth allows)
```

**Critical dependencies (cannot reorder):**
- Phase 0 §3.5 (decision log) precedes Phase A code (so decisions aren't re-debated)
- Phase A I.3 + I.4 → Phase A V.3 (stub period and balance instrumentation gate trustee tie-out)
- Phase A I.1 → Phase B call-sensitivity (call-sensitivity needs the call lever to perturb)
- Phase A V.3 → Phase C V.4 (trustee replay extends single-period tie-out logic)

**Parallelizable (no internal dependency):**
- Phase 0 §3.1, §3.2, §3.3, §3.4 can ship in any order or together
- Phase A I.1 and Phase A I.2-split are independent
- Phase C synthetic fixtures and Phase A I.1 are independent
- Phase D items are mostly independent of each other

**Gates (must complete before next phase starts):**
- Phase 0 → Phase A: decision log committed (§3.5, 9 entries + engine-silence boundary), three IRRs displayed (§3.2), fair-value displayed (two hurdles, §3.4), three relabels live (§3.3, §3.2), state migration shipped (§3.8), external-materials audit complete (§3.9), **single cold-read pass** ("Phase 0 cold-read"): ship behind feature flag to staging, take at least 24h break, return cold and check whether the page reads correctly without context. Document confusion-points found; iterate before promoting to GA. (Distinct from §12 aggregate cold-read which spans the full plan.)
- Phase A → Phase B: trustee tie-out test green for Euro XV, manager call lever verified
- Phase B → Phase C: fair-value and call-sensitivity services unit-tested and rendered
- Phase C → no gate to Phase D (Phase D items pull asynchronously). EXCEPT: if Phase C surfaces v6-era engine bugs, those take priority over Phase D scheduling.

---

## 12 · Success criteria for the entire plan

The plan is "done" when:

1. The 95c-confusion thread cannot recur. A partner viewing the equity card sees three forward IRRs, fair value next to book value, and the model-vs-market disclaimer. Auto-fill is reframed.
2. Manager call is a first-class engine input. Default UI displays both "no call" and "optional redemption at par" forward IRRs side-by-side, with a single page-level toggle (per §9 #11), not per-row chevrons.
3. Trustee tie-out test passes for Euro XV BNY Apr-15. Synthetic fixtures pass for **all 10 structural variations** (§6.1). Trustee replay framework ready for additional fixtures.
4. Decision log captures 9+ load-bearing decisions (§3.5 plus appended post-decision-validation entries per §7.13), plus the engine-silence boundary statement.
5. Risk greeks ship for diagnostic transparency.
6. Architecture boundary AST is type-aware, not identifier-string-matching.
7. Engine purity and determinism are AST-enforced.
8. All v6 incidents and post-v6 review findings have either shipped fixes, gated work items, or documented deferrals.
9. **Plan-end aggregate cold-read** (distinct from the §11 Phase 0 cold-read, which is a single phase gate). Once Phases 0–C are shipped and Phase D pulls have stabilized, do one full-plan cold-read pass: 48h break, return cold, walk the equity card and the sensitivities section as a partner would. Document any remaining ambiguities. This is the closing acceptance pass; only the items it surfaces (if any) gate the plan as "done."

---

## 13 · What this plan deliberately does NOT promise

- A market-correct equity valuation. The engine produces a model verdict, not a market verdict.
- A prediction of manager behavior. The engine models consequences of choices, not the choices themselves.
- A correct answer for every deal. Cross-deal validation will surface engine bugs; closing them is itself ongoing work.
- A complete CLO equity desk tool. Pricing greeks, secondary curves, market-data integration, and manager-behavior prediction are all named as separate workstreams in §8.
- A fixed-deadline ship. Phase D items pull as bandwidth allows; no urgency assigned beyond Phase 0.
- **Independent third-party validation of correctness.** This plan is internally validated: solo author, single deal (Euro XV) with full trustee evidence, synthetic fixtures hand-constructed by the same author. The plan does not promise a CLO-modeler peer review, a buy-side desk's sign-off, or a vendor-tool cross-check. This is a real epistemic gap — the engine could be self-consistently wrong on a structural pattern Euro XV doesn't exercise. Mitigations within scope: synthetic fixtures (§6.1), trustee-replay framework (§6.2), AST architecture-boundary enforcement (§3.6, §7.1), KI-ledger discipline. External validation (additional trustee tie-outs, vendor-tool comparison, peer review) is a separate post-plan workstream named in §8 under "Real-deal extraction infrastructure" and "Market data integration."

The plan is a correctness path, not a product spec. It says: "fix the things the engine should be telling the truth about, in priority order, so a partner reading the page can trust each displayed number to mean what it says." Beyond that, product decisions belong to product, not to this plan.

---

## 14 · Plan revision protocol

The plan is a working document. As implementation surfaces new information, the plan must update — but in a controlled way so the conversation history and decision rationale stay legible.

**Edit-in-place (no version bump) for:**
- Typos, broken cross-references, dead links.
- Tightening a sentence without changing the decision it expresses.
- Adding cross-references to KI entries that close.
- Updating "Status: SHIPPED" markers when work lands.

**Version bump (e.g., v2 → v3) required for:**
- Reversing or materially modifying a decision in §3.5 or §9.
- Adding a new phase, removing a phase, or reordering phases.
- Adding or removing a section in §3.x, §4.x, §5.x, §6.x, §7.x.
- Changing a success criterion in §3.10 / §4.6 / §5.6 / §6.5 / §12.
- Changing a gate in §11.

**Version bump procedure:**
1. Update the `**Status:**` line at the top of the plan with the new version + date.
2. Append a Review-history entry to §1 summarizing what triggered the bump.
3. If a §3.5 decision is reversed, append a "decision reversal" entry to `docs/clo-modeling-decisions.md` per §7.13 (don't silently overwrite the original; reversal is its own entry).
4. If a phase is dropped or re-scoped, mark in-progress tasks as "stopped due to plan revision" rather than "completed" or "abandoned."

**Out-of-band changes (do NOT update the plan; just document in the relevant log):**
- Trustee tie-out failure documentation → KI ledger.
- Day-by-day sequencing decisions during Phase 0 implementation → commit messages, not plan edits.
- Solo design choices that don't move a §3.5 / §9 decision → decision log appendix per §7.13.

**Why this matters:** the plan accumulated 6 review rounds. Without a versioning protocol, future investigators (including the author after time off) lose the ability to reconstruct WHY a decision is the way it is. Edit-in-place silently overwrites context. Version bumps force the author to articulate what changed.

---

## Appendix A · Cross-references

- **v6 Engine ↔ UI Separation Plan:** `docs/plans/2026-04-29-engine-ui-separation-plan.md`
- **CLAUDE.md § Engine ↔ UI separation:** `CLAUDE.md`
- **Known issues ledger:** `web/docs/clo-model-known-issues.md`
- **KI-25 (engine-UI separation closure):** same file, section `[KI-25]`
- **Modeling decisions log (this plan §3.5):** `docs/clo-modeling-decisions.md` (created in Phase 0)
- **Architecture-boundary test:** `web/lib/clo/__tests__/architecture-boundary.test.ts`
- **Period-trace helper:** `web/app/clo/waterfall/period-trace-lines.ts`
- **Inception-IRR service:** `web/lib/clo/services/inception-irr.ts`

## Appendix B · Glossary of IRR variants used in this plan

- **Realized IRR:** historical cashflows received only, no terminal mark. Backward-looking.
- **Mark-to-book IRR:** historical cashflows + terminal = today's `equityBookValue`. Hypothetical "if called at book today" exit.
- **Mark-to-model IRR:** historical cashflows + terminal = engine-projected forward distributions (PV at IRR). Forward-looking with model assumptions.
- **Mark-to-market IRR (out of scope per §8):** historical cashflows + terminal = secondary-market quote for equity at today's date. Not produced by this engine; would require secondary-curve modeling (equity-spread-to-IRR mapping fed by dealer feeds or market-data integration). Named explicitly to close the conceptual loop: readers see why mark-to-book and mark-to-model exist but mark-to-market does not — the engine has no market-data input.
- **Forward IRR:** current `result.equityIrr`. Cost basis at user-supplied entry price + projected cashflows + terminal at maturity.
- **Forward IRR (no call):** as above, with `callMode = "none"`.
- **Forward IRR (with call):** as above, with `callMode = "optionalRedemption"` and `callPriceMode = "par"`.
- **IRR-implied fair value:** entry price at which forward IRR equals a target hurdle (e.g., 10%). Computed via binary search.
- **Risk greek (in this plan):** numerical partial derivative of forward IRR w.r.t. an assumption (CDR, CPR, recovery, etc.). Diagnostic.
- **Pricing greek (in this plan, deferred):** spread duration, DV01, convexity. Requires secondary curve modeling. Out of scope.

## Appendix C · Engine definition glossary

Terms used to describe what "engine" produces vs. what "service" or "UI" can do. Lifted from CLAUDE.md § Engine ↔ UI separation; restated here so this plan is self-contained.

- **Engine output (canonical):** any field on `ProjectionResult`, `PeriodResult`, `PeriodStepTrace`, or `ProjectionInitialState`. The UI may read these directly; semantic computation on these belongs in engine or service layer, never inline in UI.
- **Service-layer composition:** pure function in `web/lib/clo/services/<topic>.ts` that combines engine output with user inputs (purchase date, entry price) or external historical data (trustee distributions, market hurdles). Service functions are the legitimate site for derivations the engine doesn't natively emit.
- **UI presentation:** formatting (`%`, `€`, ISO dates), filtering for visibility, sorting, conditional CSS. NOT semantic.
- **Engine-silence boundary:** values the engine deliberately does NOT produce (market quote, manager-behavior prediction, individual credit verdict, forward EURIBOR path beyond user-supplied curve, liquidity / transaction costs). Decision log §3.5 names these explicitly. Plans that depend on these are out-of-scope per §8.
- **Heuristic-as-value triage:** in this plan, the α/β/γ category for substituting a heuristic where the engine should emit a real value:
  - **α (worst):** heuristic that flips a sign or floors a structurally-signed value (e.g., the deleted `principalAccountCashForward` floor).
  - **β (medium):** heuristic that masks a state without contradicting an invariant (e.g., `equityBookValue` floor at zero with `equityWipedOut` flag).
  - **γ (least bad):** heuristic clearly labeled as a model assumption with the partner-facing disclosure (e.g., default 10%/15% hurdles in fair-value display).
  Phase 0 §3.4 and §3.5 commit which category each shipped heuristic falls under.
