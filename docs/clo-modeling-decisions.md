# CLO Modeling Decisions Log

Load-bearing decisions about how the CLO engine and UI represent the deal. Seeded
from the post-v6 correctness plan (`docs/plans/2026-04-29-post-v6-correctness-plan.md`,
§3.5). Append-only: revisions create new entries cross-referencing the original
rather than overwriting it (per §14 plan revision protocol).

Each entry: what was decided, alternatives considered, evidence driving the choice,
risks accepted.

Review cadence: append entries when phase gates close, when trustee tie-out failures
are documented, when a v6-style incident closes, or when a plan-level revision lands.

---

## 1. `principalAccountCashForward` deletion (resolver-side manifestation)

**Decided:** 2026-04-29 (v6).

**Decision:** the floored variant `principalAccountCashForward` was deleted from the
resolver. The engine consumes the raw signed `principalAccountCash` only.

**Alternative considered:** keep `principalAccountCashForward` as a floored variant
for an "optimistic" mode toggle.

**Rejected because:** there's no economic justification for the floor. Trustee Apr-15
BNY Note Valuation showed the principal account cleared from −€1.82M (determination
date) to €0 (post-payment) with €0 distributions through the Principal POP — the
overdraft was a real claim against equity that had to be netted, not floored.

**Risk accepted:** forward IRR drops by ~2pp on Euro XV vs. the floored variant's
pre-deletion display; that drop reflects reality, not a bug.

**Cross-reference:** decision #3 covers the engine-side consumption of the same
principle; both rest on the same trustee evidence and the same heuristic-as-value
rejection.

---

## 2. `equityBookValue` + `equityWipedOut` centralization on `ProjectionInitialState`

**Decided:** 2026-04-29 (v6 PR1).

**Decision:** single source: `Math.max(0, totalAssets - totalDebtOutstanding)` with
`equityWipedOut: boolean` flag set when the floor fires. Emitted on
`ProjectionInitialState`. UI consumes; UI does not recompute.

**Alternatives considered:**
- (a) UI computes book independently from resolver state.
- (b) Raw signed value (no floor).

**Rejected because:**
- (a) produced silent drift between engine and UI (canary in
  `architecture-boundary.test.ts` rule `ui-recomputes-book-value`).
- (b) `calculateIrr` returns nonsense on negative-equity series.

**Risk accepted:** β-floor masks negative balance-sheet states; mitigated by
`equityWipedOut` flag plumbed through to UI banner and Monte Carlo short-circuit.

---

## 3. Unfloored `q1Cash` netting (engine-side manifestation)

**Decided:** 2026-04-29 (v6).

**Decision:** the engine signs `initialPrincipalCash` and nets against Q1 principal
collections. (Search `runProjection` for the `q1Cash` injection site; line numbers
will drift, function name will not.)

**Alternative considered:** `Math.max(0, initialPrincipalCash)` heuristic.

**Rejected because:** category γ — manufactures fake alpha. Trustee Apr-15 evidence
shows the overdraft is real; flooring it ignores a real liability.

**Risk accepted:** forward IRR is realistically negative on overdrawn deals; no
ergonomic shortcut.

**Cross-reference:** decision #1 is the resolver-side counterpart that ensures the
floored variant isn't even available for the engine to consume.

---

## 4. Architecture-boundary AST rules — four explicit incident-pattern rules

**Decided:** 2026-04-29 (v6 PR4).

**Decision:** four AST rules in `web/lib/clo/__tests__/architecture-boundary.test.ts`:
- `ui-uses-inputs-in-arithmetic`
- `ui-back-derives-equity`
- `ui-reads-raw-principal-cash`
- `ui-recomputes-book-value`

Scope: `web/(app|components)/clo/.*\.(ts|tsx)$`. Per-occurrence opt-out via
`// arch-boundary-allow: <ruleId>`.

**Alternative considered:** type-aware analysis via `getApparentType()`.

**Deferred to:** Phase D §7.1 as substantive correctness improvement; current rules
guard against the original incident pattern but are bypassable by destructuring or
renaming.

**Risk accepted:** identifier-rename evades detection; mitigated by Phase D
type-aware upgrade.

---

## 5. Wiped-out short-circuits — explicit guard on `equityIrr` + Monte Carlo

**Decided:** 2026-04-29 (post-v6 review).

**Decision:**
- In `runProjection`, `equityIrr` is wrapped:
  `initialState.equityWipedOut ? null : calculateIrr(equityCashFlows, 4)`.
- In `runMonteCarlo`, calibration short-circuits before any scenario when
  `calibration.initialState.equityWipedOut`, returning `wipedOut: true` with NaN
  percentiles and zero runs.
- `MonteCarloChart.tsx` surfaces a "balance-sheet insolvent" banner when
  `result.wipedOut === true`.

**Alternative considered:** rely on the implicit chain (`-0 >= 0` early return; all
non-negative cashflows naturally producing IRR=null).

**Rejected because:** that chain depends on JS semantic + downstream non-negativity
invariants neither of which is enforced.

**Risk accepted:** explicit guard adds one branch but makes the contract direct.

---

## 6. Auto-fill UX — three forward-IRR displays side-by-side

**Decided:** 2026-04-29 (this plan, Phase 0 §3.1).

**Decision:** display three forward IRRs simultaneously (cost basis, book, fair
value at 10% hurdle). Slider becomes a secondary "what-if" input that drives a
fourth row, not the primary display.

**Alternative considered:** change slider default from inception purchase price (95c
on Euro XV) to `equityBookValue`.

**Rejected because:** slider-game UX. A single number whose meaning depends on
slider state has lost its question/answer correspondence (decision #9). The
side-by-side display surfaces all three meaningful entry-price points at once.

**Risk accepted:** UI is denser by two rows; mitigated by clear labeling and
ordering.

---

## 7. Since-closing IRR methodology — three modes shipped

**Decided:** 2026-04-29 (this plan, Phase 0 §3.2).

**Decision:** ship `realized`, `markToBook`, and `markToModel` as separate displays.
Each labeled explicitly: realized cashflows only / hypothetical exit at book today /
forward model projection.

**Alternative considered:** pick one canonical mode.

**Rejected because:** all three answer different legitimate questions. Backward-
looking realized; hypothetical immediate exit; forward model projection. Refusing
to collapse them is itself the product decision.

**Risk accepted:** more screen real estate; mitigated by labeling and grouping. If
mark-to-model alignment work overruns Phase 0 timeline, ship realized + mark-to-book
first per §3.2 mitigation.

---

## 8. Default forward-run model state — two scenarios side-by-side once Phase A I.1 lands

**Decided:** 2026-04-29 (this plan, Phase 0 anticipates; Phase A wires).

**Decision:** UI displays two forward IRRs side-by-side: "no call" + "optional
redemption call at par". "No call" remains the conservative baseline; "optional
redemption at par" becomes the realistic baseline once Phase A I.1 ships. A single
page-level toggle flips both rows simultaneously when needed (per §9 #11). Fixed
ordering: no-call first, with-call second; `(more conservative)` marker indicates
which is more conservative for the displayed deal (per §9 #13).

**Alternative considered:** pick one default (either no-call or with-call) and
hide the other behind a toggle.

**Rejected because:** hiding either biases the headline. Hiding with-call behind
per-row chevrons would recreate the original 95c-confusion failure pattern (the
partner has to click to see the comparison they need).

**Risk accepted:** more numbers per row; mitigated by anticipation in Phase 0
labeling so no re-relabel when Phase A I.1 lands.

---

## 9. Meta-decision: question/answer correspondence (failure pattern from the 95c-confusion incident)

**Decided:** 2026-04-29 (this plan, Phase 0 §3.5 #9).

**Decision:** when a UI control's behavior depends on caller-side state (slider
value, toggle position, etc.) but the displayed result label is invariant, the
label has lost the question/answer correspondence. The original PeriodTrace
back-derivation bug AND the 95c auto-fill confusion are two instances of the same
pattern.

**Resolution policy:**
- **(a) Encode the state in the label** ("Forward IRR @ your cost basis", "Forward
  IRR @ book") so the label changes when the state changes.
- **(b) Display the result for each meaningful state** simultaneously (the
  three-row triple is this approach).
- **(c) Hide/disable the control when its state isn't meaningful** (e.g., slider
  hidden when `equityWipedOut`).

Auto-fill behaviors require explicit naming of the question being auto-answered.

**Future review checklist:** for any UI surfacing CLO-engine output, search for
`value={...}` patterns where the value depends on state but the surrounding label
doesn't reference that state.

**Risk accepted:** this is a heuristic, not a tractable AST rule; relies on review
discipline.

---

## Engine-silence boundary

The engine deliberately does NOT model:

- **Market quote / transactable bid for the equity.** No secondary curve, no dealer
  feeds. Fair-value displays are model outputs, marked `(model)` inline; mark-to-
  market IRR is named in Appendix B of the post-v6 plan but is out of scope per §8.
- **Individual credit events on individual loans.** Engine models hazard rates,
  not events. Per-loan default modeling is in Phase D §7.9.
- **Manager-behavior prediction.** The engine models consequences of choices (call
  / don't call, extend RP / don't), not the choices themselves. Manager-call
  modeling Phase A §4.1 takes the choice as input.
- **Forward EURIBOR path beyond the user-supplied curve.** Base rate path
  stochasticity is Phase D §7.7.
- **Liquidity / transaction costs / market frictions.** Out of scope per §8.

These are intentional omissions. Future workstreams may close some; named
explicitly in the post-v6 plan §8.

---

## R. Test/production configuration divergence — process rule

**Decided:** 2026-04-30, after KI-20 + cdrPathFn-WARF revealed it as a recurring
class of bug.

**Decision:** before any new engine feature merges, at least one regression test
must run under production-like configuration:

- `warfFactor` populated on every loan (not the test-helper default of zero or
  fallback).
- `useLegacyBucketHazard: false` (the production D2 path).
- Real-fixture defaults via `buildFromResolved(fixture.resolved, ...)` — **not**
  `makeInputs({ ... })` from `test-helpers.ts`.

**Alternative considered:** trust unit tests calibrated against `makeInputs`
defaults; rely on the backtest harness for production-path coverage.

**Rejected because:** the backtest harness exercises one fixture (Euro XV) on
the full waterfall; it does not exhaustively probe new feature surfaces. Two
independent features (D2 per-position WARF — KI-20; CDR sample-path fn — Phase
D §7.5) both shipped with green test suites because their tests inherited
`useLegacyBucketHazard: true` from `makeInputs`. In production the WARF branch
is taken, and the feature is bypassed entirely. Unit-test green is not
production-path green.

**Pattern:** any feature that branches on `useLegacyBucketHazard`, `warfFactor`,
or any other "test-helper convenience flag" is at risk of the same divergence.
The flag isolates legacy behavior for fixture stability, but tests written
against the flag-on configuration silently route around production code paths.

**How to apply:** when adding a new engine input or branching path, add at
least one test that:
1. Builds inputs via `buildFromResolved(...)` from a real fixture (currently
   `euro-xv-q1.json`), OR
2. Constructs inputs by hand with `useLegacyBucketHazard: false` and
   `warfFactor` populated on every loan via the rating-bucket fallback table.

The Phase D §7.5 (CDR path fn) ship is the canonical example of what this rule
prevents: the override branch is dead code on the production WARF path. A
follow-up PR will extend the override to the WARF branch, and the new test
under this rule will exercise it.

**Risk accepted:** raises the bar for new tests; the burden is small (one
extra assertion per feature) compared to the cost of shipping decorative code
that passes review because the test suite was misconfigured.

---

## S. Canonical no-call baseline — `noCallBaseInputs` in `ProjectionModel.tsx`

**Decided:** 2026-04-30, merge-blocker fix to PR A.9.

**Decision:** the headline Forward IRR triple, Fair Value @ hurdle, and
inception IRR's mark-to-model `forwardDistributions` all derive from a base
input set that explicitly pins `callMode: "none"` and `callDate: null`. The
user's slider-set call settings drive `result` (the @ custom row, the per-
period waterfall trace, the @ custom IRR), but never the canonical no-call
rows.

**Alternative considered:** let `forwardIrrTriple` and `fairValues` inherit
the user's `callMode` from `inputs`. Justification: "the slider is the user's
choice; the hero card should reflect it."

**Rejected because:** the row labels say "no-call" / "held to legal final".
A label that lies under user state is the antipattern named in decision Q
(auto-fill UX failure). With the inheritance, toggling callMode in
FeeAssumptions would silently shift the meaning of every label in the hero
card without any visual signal that the meaning had changed.

The plan §9 #11 explicitly commits to "default state shows no-call only across
all rows" — which the inheritance violates the moment the user activates a
call. PR A.9 is built specifically to enable the no-call vs with-call
comparison; the inheritance bug means the comparison is meaningless in the
configuration that motivates the feature.

**Risk accepted:** when the user wants to model "what's my IRR if I assume
call X at price Y", the @ custom row is now the only place that surfaces it.
This is correct but discoverable only via the entry-price slider's existence,
not via slider state. Future work (plan §9 #5) extends the side-by-side
display to fair-value-at-hurdle and mark-to-model so all derivations show
both anchors simultaneously; this decision documents the canonical-baseline
pinning that side-by-side is built on top of.

**Cross-reference:** decision Q (auto-fill UX failure pattern) — same shape,
different surface. Decision Q says "labels must reference the state they
depend on or display all states simultaneously"; this decision says "the
canonical no-call state is independent of slider, full stop, regardless of
user input."

---

## T. Engine EoD denominator — seniority-rank-based, not string-match

**Decided:** 2026-04-30, merge-blocker fix to PR C.1.

**Decision:** the Event of Default Par Value Test denominator (PPM 10(a)(iv))
identifies the senior-most rated debt tranche by `seniorityRank`. When
multiple tranches share rank 1 (a pari-passu split such as A-1 / A-2), all
balances at that rank are summed.

**Alternative considered:** keep the existing string match
`tranches.find((t) => t.className === "Class A")`.

**Rejected because:** this is the structural-overfit pattern documented for
`POST_ACCEL_SEQUENCE` and `ENGINE_BUCKET_TO_PPM` — Euro-XV-shaped naming
hardcoded into engine logic that should be deal-shape-agnostic. Real Euro
CLO PPMs name the senior-most tranche variously: "Class A", "Class A-1",
"A1F", "A". A pari-passu split (A-1 + A-2 sharing rank 1) needs both
balances summed, which the string match cannot do.

**Surfaced by:** synthetic-fixtures #10 (post-v6 plan §6.1). The fixture's
explicit purpose was to surface non-Euro-XV-shaped deals; the original
implementation passed the test by accommodating the hardcode (renaming the
tranche to "Class A") rather than fixing it. The accommodation was caught in
critical review and reversed: fixture #10 now uses "A" deliberately, and the
engine resolves it via seniorityRank.

**Risk accepted:** if a deal genuinely has a senior-most tranche that should
NOT be the EoD denominator (e.g., a super-senior class above Class A excluded
from the test by PPM), the seniority-rank heuristic will pick it incorrectly.
No such deal in the current corpus; revisit when one surfaces.

**Cross-reference (audited 2026-04-30):**

- **`POST_ACCEL_SEQUENCE` (`waterfall-schema.ts:58`):** confirmed same overfit.
  Each `tranche_pi` step's `trancheMatch` is a string or string-list — `"Class A"`,
  `["Class B-1", "Class B-2", "Class B"]`, `"Class C"` etc. — and the matcher is
  a starts-with-case-insensitive prefix per the type comment at line 52-54. A
  deal with non-`"Class …"`-prefixed tranche names (e.g., synthetic-fixtures #10's
  `"A" / "J" / "Sub"`) would fail to match every entry. Fix shape: replace
  string-based `trancheMatch` with `seniorityRank` predicates.

- **`ENGINE_BUCKET_TO_PPM` (`ppm-step-map.ts:146`):** NOT itself overfit. Its
  keys are engine-internal bucket labels (`classA_interest`, `classB_interest`,
  ...) and its values are PPM step letters; neither side touches deal-specific
  tranche names. The labels are conventional namespacing, not deal-shape
  assumptions.

- **`backtest-harness.ts:301-312` (the consumer):** confirmed overfit. The
  harness emits each bucket value via `trancheInterestByClass.get("Class A")`
  etc. — exact-string `Map.get` lookups against deal tranche names. A
  non-`"Class …"`-named deal would emit zero for every tranche-keyed bucket
  even when the engine produced real interest. Fix shape: same as
  POST_ACCEL_SEQUENCE — resolve tranche identity by seniorityRank, not name.

The original entry's claim that "the same overfit pattern lives in
ENGINE_BUCKET_TO_PPM" was imprecise; the overfit is in the *consumer* of
that map (`backtest-harness.ts`), not the map itself. This audit corrects
the conflation. Both confirmed-overfit sites tracked as Phase D follow-up.

---

## U. `sweepEntryPrice` service signature — `subNotePar` as caller-supplied param

**Decided:** 2026-04-30, during Phase B PR B.1 implementation.

**Decision:** the entry-price-sweep service signature is
`sweepEntryPrice(inputs, prices, subNotePar)` — three args. Prices are
expressed in cents (of subNotePar), and the service multiplies
`subNotePar * (priceCents / 100)` to obtain the absolute
`equityEntryPrice` the engine consumes.

**Alternative considered (a):** match the post-v6 plan §5.1 signature
literally — `sweepEntryPrice(inputs, prices)` with prices interpreted as
absolute amounts. No subNotePar param needed.

**Alternative considered (b):** let the service derive `subNotePar` from
`inputs.tranches.find(t => t.isIncomeNote)?.currentBalance`.

**Chosen because:**
- Cents are the partner-meaningful unit ("what's IRR at 65 cents?"). Plan
  §5.4 specifies the 8-row UI table at "25c, 35c, ..., 95c".
- Alternative (a) shifts the cents↔absolute conversion to every caller
  (the UI and any future surface), duplicating the multiplication.
- Alternative (b) embeds resolver-shape knowledge into the service
  (knowing income-note tranches are the equity tranche). The resolver
  already exposes `subNotePar` via `equityMetrics.subNotePar` in the UI;
  passing it explicitly keeps the service from re-discovering it.

**Risk accepted:** signature divergence from plan §5.1's literal text
(2-arg form). Plan revisions should reflect the actual signature; future
service consumers must remember that prices are cents-of-subNotePar, not
absolute. Cross-deal confusion risk: deals with subNotePar near zero
produce trivially small absolute prices that may underflow engine
arithmetic — service guards via `if (subNotePar <= 0) return all-null`.

**Cross-reference:** decision Q (auto-fill UX failure pattern) — same
shape concern about labels/units. Service callers must label the cents
unit explicitly in any UI surface.

---

## V. Engine-purity test file substitution — `harness.ts` and `sensitivity.ts` do not exist

**Decided:** 2026-04-30, during Phase D §7.2 implementation.

**Decision:** the engine-purity AST guard targets the actual engine-layer
file set:
```
projection.ts
build-projection-inputs.ts
pool-metrics.ts
senior-expense-breakdown.ts
backtest-harness.ts
switch-simulator.ts
```
Plan §7.2 named `projection.ts`, `harness.ts`, `sensitivity.ts`. The
latter two do not exist in the repo — closest siblings are
`backtest-harness.ts` (vs `harness.ts`) and `switch-simulator.ts`
(no `sensitivity.ts` analogue; sensitivity logic lives across multiple
service files now).

**Alternative considered (a):** fail loudly when the named file doesn't
exist (treat the plan as load-bearing).

**Alternative considered (b):** drop scope to whatever files match the
exact names in the plan (only `projection.ts`).

**Alternative considered (c):** include `services/*.ts` (inception-irr,
fair-value, entry-price-sweep, call-sensitivity) in the engine-purity
guard since they are engine-layer per CLAUDE.md.

**Chosen because:**
- (a) blocks the test from running at all, eliminating the value of
  preventive guard infrastructure.
- (b) shrinks scope dramatically — `projection.ts` is one file out of
  six engine-layer modules.
- The substitution preserves the plan's intent ("engine-layer files
  must not import React, fetch, process.env, Date.now, async fns")
  while accommodating actual file-tree shape.

**Risk accepted:** services were excluded from the substituted file
list. If a future service adds `Date.now()` or `process.env`, the guard
won't catch it. Honest scope: services are engine-layer per CLAUDE.md
and SHOULD be included; this is a known gap, not a deliberate exclusion.
Tracked as Phase D follow-up under engine-purity-extension.

**Cross-reference:** decision R (test/prod-config divergence process
rule) — same family. Both are about guards being calibrated to the
configuration where engine code actually runs. Substituting file lists
without auditing for completeness is a smaller version of running tests
under non-prod config.

---

## W. Phase C §6.2 trustee replay — framework only, no Euro XV trustee values loaded

**Decided:** 2026-04-30, during Phase C §6.2 implementation.

**Decision:** `trustee-replay.test.ts` ships as a framework: three tests
that pin the stub-period-engine machinery anchored at an arbitrary
trustee date (1-day stub lands period 1 on the trustee date; hazard
rates scale with day-count; post-stub cadence matches a non-stub
baseline). No actual trustee values from the BNY Apr-15 snapshot or
`new_context.json` are loaded; no engine-period-N vs trustee-period-N+1
comparison fires.

**Alternative considered (a):** plan §6.2's literal asks: "Initial
fixture: Euro XV BNY Apr-15. Engine period N vs trustee period N+1."
Load trustee distributions from `new_context.json`, build a comparison
map, assert engine output within tolerance.

**Alternative considered (b):** rename the test honestly to
`stub-period-replay.test.ts` and acknowledge it duplicates much of
`stub-period.test.ts` rather than establishing a trustee-replay
framework.

**Chosen because:**
- (a) requires non-trivial trustee-data wiring: `new_context.json` is a
  cross-deal export with complex schema (the same data feeds the existing
  `backtest-harness.test.ts`); extracting Apr-15 distributions and aligning
  them to engine `equityDistribution` per period is hours of work, not the
  scope of a single PR.
- (b) is the most honest framing but loses the structural value of the
  stub-period anchoring tests, which DO establish the framework even if
  they don't pin trustee values.
- The stub-period anchoring is genuinely a precondition for trustee
  replay; without it, the engine couldn't run from a non-determination
  date. So the framework tests have load-bearing value even decoupled
  from trustee comparison.

**Risk accepted:** the test name `trustee-replay.test.ts` over-promises.
A reader expecting trustee tie-out will find stub-period sanity checks
instead. The file's docstring is explicit about this scoping, but the
filename masks it.

Followup: A.8 (trustee tie-out — explicitly deferred) is the natural
landing spot for the actual Apr-15 comparison. When A.8 ships, this
file should be renamed (e.g., `stub-period-replay-anchoring.test.ts`)
to free the `trustee-replay.test.ts` slot for the real comparison.

**Cross-reference:** plan §11 cold-read gate. The mismatch between
"trustee replay framework" (the filename) and "stub-period anchoring
tests" (what's actually tested) is the kind of labeling drift cold
review should catch. Same family as decision Q.

---

## X. Decision-log entry quality — seed level vs execution-time level

**Decided:** 2026-04-30, after critical review flagged that
execution-time entries (U, V, W) are not the same artifact as the
eight original seed decisions.

**Decision:** the log distinguishes two entry types:

1. **Seed decisions** (entries 1-8 + Q): architectural choices made
   during plan formation. Full treatment: alternatives considered with
   pros/cons each, evidence (often citing trustee data, plan sections,
   prior incidents), risks accepted, cross-references.

2. **Execution-time decisions** (entries R, S, T, U, V, W): choices
   made during implementation that diverge from the plan or close
   plan-named gaps. Same shape, slightly lighter — alternatives are
   typically 2-3 (not the 4-5 a seed gets), evidence is from the
   immediate code or test (not multi-source), risks are scoped to
   the implementation surface.

**Why distinguish:** seed decisions warrant heavy treatment because
they shape the entire plan. Execution-time decisions are narrower —
"why did sweepEntryPrice take three args" is a smaller question than
"why is fair value model-only with no market quote anchor."

**Risk accepted:** without explicit type-marking on each entry, future
readers may assume all entries had the seed-level rigor. The
introduction text (lines 8-9: "Each entry: what was decided,
alternatives considered, evidence driving the choice, risks accepted")
is the implicit standard. This decision documents that the standard is
maintained but the *depth* varies by decision type.

**Alternative rejected:** flatten the distinction by writing every
entry at seed depth, even one-off implementation choices. Rejected
because the cost (multi-paragraph entry per fixture rename or
signature tweak) outweighs the value.

**How to apply:**
- New entries should follow the alternatives/evidence/risks/cross-ref
  format regardless of type.
- Seed-level entries (architectural, plan-shaping) should attempt 4+
  alternatives with explicit why-rejected for each.
- Execution-time entries can ship with 2-3 alternatives if the
  implementation surface is narrow.
- If unsure which type applies, default to the heavier seed format —
  the marginal cost of a longer entry is small compared to the cost of
  a future reader misreading scope.

**Cross-reference:** plan §3.5 (decision-log seed); plan §7.13
(decision-log extension as ongoing work). This decision codifies the
implicit two-tier system that emerged organically as execution-time
entries were added.

---

## Y. Option (d) — no toggle; side-by-side no-call vs with-call wherever call-mode matters

**Decided:** 2026-04-30, replacing decision 8's "page-level toggle" framing
after critical review of the original (d) ship.

**Decision:** the partner-facing equity surface displays the no-call /
with-call (optional-redemption-at-par) IRR pair side-by-side on every row
where call-mode is a meaningful axis: Forward IRR rows (`@ cost basis`,
`@ book`, `@ custom (Xc)`), the `@ fair value-10%` row (showing implied
prices), the mark-to-model row of the since-inception card, and the
entry-price-vs-IRR sweep in Sensitivities. There is no `showWithCall` /
`callMode` toggle in the UI. When the deal has no extracted
`nonCallPeriodEnd`, only the no-call column renders.

The `(more conservative)` marker is rendered next to whichever side is
numerically lower, and only when both sides are numeric — status text
("wiped out", "no forward data") and `null` cells are incomparable and
omit the marker.

The FeeAssumptions slider does not influence the hero-card IRR rows;
the slider drives the per-period waterfall trace rendered below the hero
card, while the IRR rows above are anchored to the canonical no-call /
with-call-at-ord-par pair regardless of slider state. This decouples the
"play with assumptions" interaction from the "what is the canonical
return for this deal" headline.

**Alternatives considered:**

1. **(a) Page-level toggle** — single button at the top of the equity
   card flips no-call ↔ with-call for every row simultaneously. Decision
   8 (the original 2026-04-29 plan) selected this. Rejected on review:
   recreates the 95c-confusion pattern (decision 9) — the partner has
   to click to see the comparison they need; the headline value depends
   on hidden caller-side state (the toggle position) and the row label
   doesn't reference it.

2. **(b) Per-row chevron expand** — each row shows the no-call IRR
   collapsed and a click-to-expand chevron reveals the with-call
   companion. Rejected because the partner reads the hero card
   sequentially in seconds; per-row interactions amplify the time-to-
   answer for what is supposed to be the headline number. Also the
   PDF export (Phase E) cannot replicate per-row expand state.

3. **(c) Default to with-call with footnote** — display the realistic
   baseline (with-call at par after non-call period end) as the
   primary number; show no-call only in a hover or footnote. Rejected
   because no-call is the conservative number partners need
   underwriting-side; demoting it to footnote optimizes for the
   common-case manager but penalizes the diligence read.

4. **(d) No toggle; side-by-side everywhere call-mode matters**
   (selected). Both columns visible for every row. The partner reads
   the comparison directly without state to track. PDF export
   serializes both columns. The `(more conservative)` marker on the
   lower side gives the same one-look judgment a toggle would, without
   the toggle.

**Rejected (a) on these grounds specifically:**
- Decision 9 named the pattern: "when a UI control's behavior depends
  on caller-side state but the displayed result label is invariant,
  the label has lost the question/answer correspondence." A toggle is
  caller-side state; the IRR row label does not change when the toggle
  flips. Decision 8's framing acknowledged this risk implicitly via
  "fixed ordering: no-call first, with-call second" but left the toggle
  as the gate, which is the failure mode decision 9 documents.
- The partner cost of "click toggle to see other regime" is paid every
  visit. The build cost of side-by-side is paid once.

**Surfaced by:** initial implementation of plan §9 #5 used a page-level
toggle (`showWithCall` boolean, toggle button). The first critical
review noted that the toggle's existence was decision 8's letter but
contradicted decision 9's spirit. The conflict was resolved by
upgrading to (d) — no toggle, side-by-side propagation.

**Risk accepted:**

1. **More numbers per row.** The hero card now reads e.g.
   "@ book 12.5% · 14.2% (more conservative)" instead of one figure.
   Mitigated by (i) consistent column ordering (no-call always first),
   (ii) the `(more conservative)` marker giving partners the headline
   judgment, (iii) the section sub-header naming the columns:
   "(no-call · with-call @ {date}, par)".

2. **Status text in two columns.** Mark-to-model can degrade to
   "wiped out" / "no forward data" / `—` per column independently;
   `SideBySideIrr` accepts `IrrCellValue = number | string | null`
   so each column carries its own status. Initial (d) ship dropped
   the status text (rendered "— · —" under wiped-out and no-realized-
   data states); fixed in same merge as this decision (commit
   strengthens `IrrCellValue` to include strings).

3. **Single-column degradation.** When `nonCallPeriodEnd` is missing
   from extracted data, with-call cannot be derived. `SideBySideIrr`
   accepts `withCall: IrrCellValue | undefined` where `undefined`
   triggers single-column display, distinct from `null` (with-call
   exists but produced no IRR — renders "—"). The ResolvedDealData
   `dates.nonCallPeriodEnd` field is populated by the resolver from
   PPM/SDF; deals without it are typically pre-effective-date or
   already past their NCP and don't need with-call modeling.

**Cross-reference:** plan §9 #5, §9 #11, §9 #13. Supersedes the
"page-level toggle" framing in decision 8 — that decision's
headline ("two scenarios side-by-side") is preserved; the
mechanism (toggle) is replaced by always-on dual columns.
Implementation in `web/app/clo/waterfall/ProjectionModel.tsx`
(`SideBySideIrr` component, `noCallBaseInputs` /
`withCallBaseInputs` helpers, `forwardIrrRows`, `customEntryIrr`,
`inceptionIrrWithCall`, mark-to-model render block, fair-value
@ 10% block, entry-price-sweep dual columns).
