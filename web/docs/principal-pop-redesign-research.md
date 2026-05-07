# Principal POP Redesign — Pre-KI Research Note

**Status:** pre-KI research artifact, dated 2026-05-06. Compiled to support filing a new tentative ledger entry for the engine's principal Priority of Payments redesign. **Cross-reference verification completed 2026-05-06** — see §11 for the verification report and resulting changes applied to §3, §4. Two §6 targets remain unresolved (one more European-2.0 indenture read; fresh Ares XV OC pp. 176-179 spot-check); both are tracked in §8 as tentative residuals.

**Implementation status update (2026-05-07):** The Ares XV schema-driven path has shipped through resolver + engine and is closed for the current Ares XV data/state surface. `ResolvedPrincipalPop` is populated from the structured PPM block, `buildFromResolved` threads it into `ProjectionInputs`, and `projection.ts` runs sequenced dispatch: pre-interest clauses for Controlling-Class deferred backfill and mandatory post-RP redemption; post-debt-interest clauses for principal-funded upstream interest backfills, cure-from-principal, and Special Redemption; and a late post-RP clause-S/T pass after sub-management fee and trustee/admin overflow have run from interest. Incentive/residual sequencing stays on the existing engine paths, and event/acquisition arms remain no-op where the model lacks state. Missing structured principal POP now blocks production resolver paths. Remaining closure work is blocked on new data: non-Ares production round-trip validation requires another ingested PPM, and event/acquisition behavior requires event/acquisition state that is zero/absent on current Euro XV.

**Reading order for a cross-reference agent:** §1 establishes the defect against the actual engine code (verified). §2 establishes Ares XV's PPM clauses against `ppm.json` (verified against repo). §3 contains a research-agent survey of cross-manager indenture variation (UNVERIFIED — this is what cross-ref work needs to validate). §4 proposes a schema derived from §3 (UNVERIFIED, treat as STARTING PROMPT). §5 maps Ares XV into the schema. §6 lists explicit verification targets the cross-ref agent should hit. §7 is the conceptual closure path. §8 is the tentative residual. §9 is the draft ledger entry.

Tags used:
- `[VERIFIED]` — claim checked against repo file at the cited file:line
- `[VERIFIED-PPM]` — claim checked against `ppm.json` (the repo's structured PPM extract for Ares XV)
- `[UNVERIFIED-AGENT]` — claim from the research agent's survey, not independently confirmed
- `[TENTATIVE]` — claim with known reliability issues; explicit caveat noted
- `[INFERENCE]` — my synthesis on top of repo-evidence; should be checked by reviewer

---

## §1. The defect (engine code state)

### §1.1 What the engine did before the 2026-05-07 schema dispatch

The principal POP at `web/lib/clo/projection.ts:4096-4118` is a uniformly-simplified pro-rata loop that does not model the conditional backfill structure the PPM specifies. Concretely: `[VERIFIED]`

```
for (const rank of principalRanksInOrder) {
  const group = principalGroupByRank.get(rank)!;
  // Phase 1: deferred — pro-rata across group by deferredBalance.
  const groupDeferred = group.reduce((s, t) => s + deferredBalances[t.className], 0);
  const deferredPaidGroup = Math.min(groupDeferred, remainingPrelim);
  remainingPrelim -= deferredPaidGroup;
  // ... pro-rata distribution within rank
  // Phase 2: principal — pro-rata across group by trancheBalance.
  // ... pro-rata distribution within rank
}
```

This treats every rank uniformly: pay accumulated PIK first, then principal balance, sequentially down the seniority stack. No gating predicates are applied.

### §1.2 What the engine does NOT model

Per the PPM (see §2), Ares XV's principal POP has 22 distinct clauses, 14 of which are conditional backfills gated on predicates: Controlling Class, Coverage Tests, Par Value Tests, Reinvestment Period vs post-Reinvestment Period, Effective Date Rating Event. The engine's loop ignores all gating and runs the same uniform pay-deferred-then-principal-pro-rata for every rank. `[VERIFIED]`

### §1.3 Magnitude

Zero on Ares XV today (no PIK on any deferrable class, no Effective Date events, no Coverage Test failures requiring principal-side cure backfill). Latent in three modes:
- Stress on Ares XV (PIK accrues + principal arrives + junior class isn't Controlling → engine pays PIK from principal regardless of Controlling Class gate, which Ares XV's clause D forbids)
- Late-life Ares XV (after Class A+B paid off, the gating becomes load-bearing)
- Any non-Ares deal (different clause structure, possibly different predicates)

`[VERIFIED]` against `web/lib/clo/__tests__/fixtures/euro-xv-q1.json` showing zero `deferredInterestBalance` on every tranche at the current snapshot.

### §1.4 Why this is anti-pattern #3

Pre-2026-05-07, the engine extracted principal POP text into `ppm.json` but never consumed it — the resolver did not expose clauses to `ResolvedDealData`, and projection ran the uniform loop regardless. That was exactly the "silent fallback on missing computational extraction" shape CLAUDE.md anti-pattern #3 forbids. The schema-driven resolver/engine path now consumes `principalPriorityOfPayments`; this paragraph is retained as historical defect context for KI-66.

---

## §2. Ares XV PPM clauses (verified against ppm.json)

Source: `ppm.json:213-276`. `[VERIFIED-PPM]`

### §2.1 Interest Priority of Payments — 30 clauses A–DD (`ppm.json:213-247`)

The interest waterfall is referenced by the principal POP backfill clauses below. Items (A)–(H) feed clause (A) of the principal POP; items (I), (J), (K), (L) etc. feed clauses (B), (C), (D), (E) etc. of the principal POP respectively.

### §2.2 Principal Priority of Payments — 22 clauses A–V (`ppm.json:249-276`)

| Clause | Application | Predicate |
|---|---|---|
| A | Backfill (A)–(H) [taxes, profit, trustee, admin, expense reserve, sr mgmt fee, hedge, Class A interest, Class B interest] | unconditional |
| B | Backfill (I) — Class A/B Coverage Test cure | A/B Coverage Test failure |
| C | Backfill (J) — Class C current interest | Class C is Controlling Class |
| D | Backfill (K) — Class C deferred interest | Class C is Controlling Class |
| E | Backfill (L) — Class C cure | Class C Coverage Test failure |
| F | Backfill (M) — Class D current interest | Class D is Controlling Class |
| G | Backfill (N) — Class D deferred interest | Class D is Controlling Class |
| H | Backfill (O) — Class D cure | Class D Coverage Test failure |
| I | Backfill (P) — Class E current interest | Class E is Controlling Class |
| J | Backfill (Q) — Class E deferred interest | Class E is Controlling Class |
| K | Backfill (R) — Class E PV cure | Class E Par Value Test failure |
| L | Backfill (S) — Class F current interest | Class F is Controlling Class |
| M | Backfill (T) — Class F deferred interest | Class F is Controlling Class |
| N | Backfill (U) — Class F PV cure | Class F Par Value Test failure |
| O | Backfill (V) — Effective Date Rating Event | Rating Event triggered, S&P confirmation pending |
| P | Special Redemption Amount | CM election on Special Redemption Date |
| Q | Reinvestment / hold (RP) ; reinvest Unscheduled + CIO + CRO sale proceeds (post-RP) | RP-vs-post-RP, manager discretion |
| R | Sequential redemption per Note Payment Sequence | post-RP only |
| S | Backfill (W)–(Z) [reinv OC diversion, sub mgmt fee, trustee/admin overflow] | post-RP only |
| T | Reinvesting Noteholder Reinvestment Amounts | EU risk-retention regime |
| U | Incentive Collateral Management Fee + VAT | subnote IRR Threshold met |
| V | Residual to Subordinated Notes | unconditional terminal |

`[VERIFIED-PPM]` — table is a 1:1 transcription of `ppm.json:253-276`.

### §2.3 Definitions referenced in clauses (per Ares XV OC Condition 1)

- **Controlling Class** = the most senior Class of Notes outstanding at any time. As Class A pays off, Class B becomes Controlling; etc. `[INFERENCE]` — definition not transcribed in `ppm.json`; need direct OC read for verification.
- **Coverage Tests** = OC Test + IC Test, applied to Classes A/B/C/D. `[VERIFIED-PPM]` against the test taxonomy in resolver.
- **Par Value Test** = OC Test only (no IC component), applied to Classes E/F. `[VERIFIED-PPM]` — distinct test surface in `ppm.json` for E/F.
- **Note Payment Sequence** = sequential by seniority rank. `[INFERENCE]` from clause R wording; not separately transcribed.

---

## §3. Cross-manager survey (research agent output)

**Agent ID:** `ae0075a144a957fd7` (general-purpose, run 2026-05-06).

`[UNVERIFIED-AGENT]` for everything in §3 unless explicitly tagged otherwise. The survey is a research sketch, not a verified design baseline. Sample size was four indentures (Ares XV via my summary; three US-domestic via SEC EDGAR).

### §3.1 Sources the agent claimed to read

**Indentures (load-bearing):**
- Carlyle Direct Lending CLO 2024-1, LLC — `https://www.sec.gov/Archives/edgar/data/1702510/000170251024000079/indenture-clo2024x1.htm`
- Barings BDC Static CLO Ltd. 2019-1 — `https://www.sec.gov/Archives/edgar/data/1379785/000137978519000025/exhbiti101-cloindenture.htm`
- Golub Capital BDC CLO 2018 — `https://www.sec.gov/Archives/edgar/data/1476765/000114420418061131/tv507572_ex10-1.htm`
- Ares European CLO XV — via my pre-supplied summary, NOT a fresh OC PDF read

**Methodology / primer:**
- Fitch "U.S. CLO Indenture Features Explained" — `https://your.fitch.group/rs/732-CKH-767/images/U.S.-CLO-Indenture-Features-Explained_Fitch_10238311.pdf` `[TENTATIVE]` — agent self-flagged this fetch as suspiciously paraphrased; do not rely on Fitch citations from the agent
- S&P "Par Wars: The Phantom Limits" (Feb 2020) — `https://www.spglobal.com/ratings/en/research/articles/200221-par-wars-the-phantom-limits-11358238`
- NAIC CLO Primer — `https://content.naic.org/sites/default/files/capital-markets-primer-collateralized-loan-obligations.pdf`
- Moody's CLO methodology — `https://ratings.moodys.com/api/rmc-documents/68357`
- AlterDomus "Excess Interest" — `https://alterdomus.com/insight/understanding-the-impact-of-excess-interest-on-clo-portfolios`
- Ostrum "CLO 2.0 Mechanism" — `https://www.ostrum.com/sites/default/files/2019-12/OSTRUM_Research%20paper_CLO2_EN.pdf`

### §3.2 Key claims (agent's findings)

**Predicate set is closed and small (~11 predicates).** Across the four indentures:
- `unconditional`
- `coverage_test_failure(class)` — cure-redemption gate
- `par_value_test_failure(class)` — cure-redemption gate (observed only in Ares XV; uniformly absent in 3 sampled US-domestic deals)
- `is_controlling_class(class)` — deferred-interest backfill gate
- `during_reinvestment_period`
- `after_reinvestment_period`
- `redemption_event` (Special / Optional / Tax)
- `effective_date_rating_event`
- `retention_deficiency` (EU/Vol-Rule risk-retention override)
- `incentive_fee_threshold_met`
- `enforcement_event` (separate Acceleration POP)
- `restructured_asset_acquisition_authorized` — workout-loan / rescue-financing predicate (added post-cross-ref; gates Principal Proceeds applications for assets that don't meet Collateral Obligation criteria, e.g. Distressed Exchange, Bankruptcy Exchange, Permitted Equity Security, Uptier Priming Debt). See §11.

`[VERIFIED — 4 deals]` — eleventh predicate added by cross-reference §11.6 from Carlyle 2024-1 + Fitch FAQ13 + S&P Par Wars 2020. Sample-bounded but the four deals cover three vintages (2019/2018/2024) and two structural classes (static/managed); predicate set has held across the verified expansion.

**Clause count is derived, not free.** Varies linearly with `(mezz tranches × 2 backfill clauses each) + fixed overhead`:
- Barings static 2019: 7 clauses, 3 secured tranches
- Golub 2018: 13 clauses, 5 tranches
- Carlyle DL 2024-1: 18 sub-clauses, 5 tranches + Reinvesting Holder + Preferred
- Ares XV: 22 clauses, 6 tranches + Effective Date + Reinvesting Noteholder + Incentive

`[UNVERIFIED-AGENT]` — pattern fits 4 data points; could break on Eur 2.0 with non-standard cap structure.

**Controlling Class is uniformly `highest_rank_outstanding`** in all four sampled deals for principal-POP gating purposes.

`[VERIFIED — 4 deals]` — confirmed by direct read of Carlyle 2024-1, Barings 2019, Golub 2018 indenture text in cross-reference §11.2. The original agent's parenthetical claim that "Majority-vote / weighted-class variants exist in Fitch's framework" is `[REFUTED]` — the Fitch PDF (when fetched directly rather than via the paraphrasing fetch the agent self-flagged) does not document Controlling Class derivation variants. The schema's `ControllingClassRule` discriminated union is correspondingly trimmed to a single variant in §4 below; future variants can be added when a deal surfaces one.

**PV-Test-vs-Coverage-Test bifurcation observed in Ares XV; uniformly absent in 3 sampled US-domestic deals.**
- Ares XV: A/B/C/D use Coverage Tests; E/F use Par Value Test only (no IC) `[VERIFIED-PPM]`
- Carlyle 2024: uniform Coverage Tests across A through D `[VERIFIED — direct indenture read, §11.3]`
- Golub 2018: uniform Coverage Tests `[VERIFIED — direct indenture read, §11.3]`
- Barings 2019: uniform Coverage Tests (only Class A tested; no mezz) `[VERIFIED — direct indenture read, §11.3]`

`[REFINED]` — the original "European-typical" labeling is downgraded. The bifurcation is real and structural (schema retains both `coverage_test_cure` and `par_value_test_cure` clause variants), but whether it's "European," "Ares-family," "European 2.0 with EU risk-retention," or some other categorization remains unresolved with a sample of one European deal. Reading one more European 2.0 indenture from a different manager (Permira, BlackRock European, Capital Four, Carlyle European, Investcorp) is the right next step; tracked as residual in §8.

**DDTL pre-siphons the POP** in all four indentures. Agent claims funding-account amounts are subtracted from principal proceeds before the POP runs, treated as a `preWaterfallReservation` rather than a clause.

`[UNVERIFIED-AGENT]` — consistent with engine's current implicit handling (engine never sees DDTL funding flows in principal POP), but verify against actual indenture text to confirm pre-siphon is universal.

### §3.3 Reliability flags (the cross-ref agent should weight these)

1. **Fitch fetch was paraphrased — REFUTED in spirit, CONFIRMED in detail.** Cross-reference §11.5 fetched the PDF directly and refuted the agent's specific Fitch-derived claims (Fitch does NOT document Controlling Class derivation variants; Fitch does NOT document PV-vs-Coverage Test as a separate category). The agent's self-flag was load-bearing — the paraphrasing fetch had injected pattern-matched content not present in Fitch's actual text. What Fitch does authoritatively cover (rescue financing FAQ13, OC Haircuts FAQ9, Exchanges FAQ12, Maturity Amendments FAQ14) the agent missed entirely. Net: claims that survived a direct read are flagged `[VERIFIED]` in §11; claims that did not are `[REFUTED]` and removed from §4.
2. **Ares XV mapping was synthesis, not fresh OC read.** Status unchanged — cross-ref §11 did not perform a fresh OC pp. 176-179 read. Tracked in §8.2 as a tentative residual.
3. **EDGAR URLs verified.** Cross-reference §11.1 confirmed all three URLs return 200 OK and contain the indentures the agent claimed. Tranche counts in agent's §3.2 were off for two of three (Barings 3→2 secured, Golub missed pari-passu C-1/C-2 split, Carlyle missed pari-passu A-Senior split). Schema's `SeniorityRank: number` handles pari-passu sub-classes implicitly (multiple tranches share a rank); §4 adds an explicit comment.
4. **4-deal sample is small but expanded vintage / structural coverage.** Sampled deals span 2018-2024 and include both static (Barings) and managed (Carlyle/Golub/Ares). Predicate set was expanded by one (`restructured_asset_acquisition_authorized`, see flag #5) but otherwise held across the verified expansion. PV-vs-Coverage labeling remains under-sampled with only one European deal.
5. **Workout-loan mechanic — REFUTED. Mechanism IS present in the modern sample.** Cross-reference §11.6 found the workout-loan / rescue-financing mechanism in Carlyle 2024-1 under modern naming: "Restructured Asset" + "Bankruptcy Exchange" + "Distressed Exchange" + "Permitted Equity Security" + "Uptier Priming Debt" cluster, gated on "Restructured Asset Target Par Balance Condition" with explicit caps (≤7.5% Restructured Assets cumulative since Closing; ≤10.0% via Distressed Exchange). Fitch FAQ13 confirms this is routine in 2021-2023 indentures. S&P Par Wars 2020 explicitly names the workout-loan concept. §4 schema gains a `RestructuredAssetAcquisitionClause` variant.

---

## §4. Proposed canonical schema (STARTING PROMPT, not baseline)

`[UNVERIFIED-AGENT]` — agent's discriminated-union sketch. The schema below is a starting point for cross-reference work, not a settled design. Cross-ref agent should treat the schema as "does this round-trip ≥5 indentures?" rather than "is this correct?"

```typescript
// PrincipalPop — discriminated-union encoding of CLO principal POP
//
// Design constraint: must round-trip ≥4 sampled indentures (Ares XV, Carlyle DL 24-1,
// Golub 18, Barings 19) and not bake in Ares-specific clause counts, tranche counts,
// naming conventions, or test-type vocabulary.

export interface PrincipalPop {
  /** Stable IDs for the interest waterfall items the principal POP can backfill.
   *  Cross-references items by ID rather than indenture letter (letters drift). */
  interestWaterfall: InterestWaterfallShape;

  /** Pre-waterfall carve-outs: amounts removed from PP bucket before POP runs
   *  (DDTL/Revolver funding, prior-period reinvest commitments). */
  preWaterfallReservations: PreWaterfallReservation[];

  /** The ordered POP itself — what the engine walks per period. */
  clauses: PrincipalClause[];

  /** Controlling-class resolution. */
  controllingClass: ControllingClassRule;

  /** Sequential/pro-rata mode for redemption-style clauses. */
  redemptionMode: RedemptionMode;

  /** Acceleration / Enforcement-Event waterfall is structurally distinct;
   *  reference, do not inline. */
  accelerationWaterfall: AccelerationWaterfallRef;
}

// ----------------------------------------------------------------------------
// Each clause: discriminated union over the gating predicate.
// ----------------------------------------------------------------------------

export type PrincipalClause =
  | UnconditionalBackfillClause
  | CoverageTestCureClause
  | ParValueTestCureClause
  | ControllingClassBackfillClause
  | EffectiveDateRatingEventClause
  | SpecialRedemptionClause
  | ReinvestmentDiscretionClause
  | MandatoryPostRpRedemptionClause
  | PostRpInterestOverflowClause
  | ReinvestingHolderClause
  | IncentiveFeeClause
  | RestructuredAssetAcquisitionClause   // workout-loan / rescue-financing path; §11.6 added
  | ResidualToSubordinatedClause;

interface ClauseBase {
  /** Stable schema ID; NOT the indenture letter. */
  id: string;
}

interface UnconditionalBackfillClause extends ClauseBase {
  kind: "unconditional_backfill";
  paysItems: InterestItemId[];
}

interface CoverageTestCureClause extends ClauseBase {
  kind: "coverage_test_cure";
  gatingTranche: SeniorityRank;
  payTarget: PayTarget;
}

interface ParValueTestCureClause extends ClauseBase {
  kind: "par_value_test_cure";
  gatingTranche: SeniorityRank;
  payTarget: PayTarget;
}

interface ControllingClassBackfillClause extends ClauseBase {
  kind: "controlling_class_backfill";
  gatingTranche: SeniorityRank;
  paysItems: InterestItemId[];
}

interface ReinvestmentDiscretionClause extends ClauseBase {
  kind: "reinvestment_discretion";
  phase: "rp" | "post_rp_carveout" | "rp_or_post_rp_carveout";
  options: Array<
    | "hold"
    | "reinvest_substitute"
    | "reinvest_unscheduled_or_credit"
    | "redeem_on_retention_deficiency"
  >;
  proceedsSubset: ProceedsSubset | null;
}

interface MandatoryPostRpRedemptionClause extends ClauseBase {
  kind: "mandatory_post_rp_redemption";
  sequence:
    | "note_payment_sequence"
    | "debt_payment_sequence"
    | "pro_rata_within_class";
}

interface PostRpInterestOverflowClause extends ClauseBase {
  kind: "post_rp_interest_overflow";
  paysItems: InterestItemId[];
}

interface IncentiveFeeClause extends ClauseBase {
  kind: "incentive_fee";
  trigger: "subnote_irr_threshold" | "incentive_management_fee_threshold";
  thresholdParam: number;
}

interface RestructuredAssetAcquisitionClause extends ClauseBase {
  kind: "restructured_asset_acquisition";
  /** Which proceeds bucket can fund the acquisition. Carlyle 2024-1 allows
   *  Principal Proceeds for some sub-categories (Distressed Exchange under
   *  caps); other deals restrict to non-principal sources only. */
  proceedsSubset: "principal_only" | "interest_or_principal" | "non_principal_only";
  /** All conditions must hold for the acquisition to be authorized. */
  gatingConditions: Array<
    | "target_par_balance_satisfied"
    | "oc_test_satisfied"
    | "post_acquisition_principal_amount_cap"
    | "cumulative_principal_amount_cap"
  >;
  /** Quantitative limits. Carlyle 2024-1: Restructured Assets ≤ 7.5%
   *  cumulative-since-Closing; Distressed Exchange ≤ 10.0%; Permitted
   *  Equity ≤ 2.5% outstanding. Per-deal extracted. */
  caps: { perAcquisition?: number; cumulativeSinceClosing?: number };
}

// (EffectiveDateRatingEventClause, SpecialRedemptionClause,
//  ReinvestingHolderClause, ResidualToSubordinatedClause — definitions
//  follow the same shape; omitted here for brevity.)

// ----------------------------------------------------------------------------
// Supporting types
// ----------------------------------------------------------------------------

type InterestItemId = string; // stable ID into interestWaterfall

type SeniorityRank = number; // 1 = most senior; identifies tranche by rank,
                              // NOT by class-name string (anti-pattern #1).
                              // Pari-passu sub-classes (e.g. Golub C-1/C-2 or
                              // Carlyle A-Senior split into A-1/A-L1/A-L2)
                              // share the same SeniorityRank — engine's
                              // existing pari-passu absorption logic in the
                              // interest waterfall handles this naturally.

type PayTarget =
  | { kind: "note_payment_sequence_from"; rank: SeniorityRank }
  | { kind: "specific_class"; rank: SeniorityRank };

type ProceedsSubset =
  | "all"
  | "unscheduled_principal_only"
  | "unscheduled_plus_credit_improved_credit_risk"
  | "special_redemption_amount";

type ControllingClassRule =
  | { kind: "highest_rank_outstanding" };      // [VERIFIED — 4 deals via §11.2]
                                                // No alternative variants observed in any
                                                // sampled indenture or in the Fitch PDF
                                                // (direct read, §11.5). The agent's
                                                // earlier `majority_vote_within_class` and
                                                // `balance_weighted` variants were paraphrasing
                                                // artifacts; both removed. Discriminated-union
                                                // shape retained so a future variant can be
                                                // added without breaking the type.

type RedemptionMode =
  | "sequential_npss"
  | "pro_rata_post_rp_with_subnote_election"   // S&P par-wars feature
  | "sequential_then_pro_rata_within_group";

interface PreWaterfallReservation {
  kind:
    | "ddtl_revolver_funding"
    | "prior_period_reinvestment_commitment"
    | "interest_reserve_account_topup";
}

interface InterestWaterfallShape {
  items: InterestWaterfallItem[];
}

interface InterestWaterfallItem {
  id: InterestItemId;
  kind:
    | "taxes"
    | "issuer_profit"
    | "trustee_admin"
    | "expense_reserve"
    | "senior_mgmt_fee"
    | "hedge"
    | "tranche_current_interest"
    | "tranche_deferred_interest"
    | "coverage_test_cure"
    | "par_value_test_cure"
    | "effective_date_rating"
    | "reinv_oc_diversion"
    | "sub_mgmt_fee"
    | "incentive_fee"
    | "subnote_residual";
  tranche?: SeniorityRank;
}

interface AccelerationWaterfallRef {
  pop: PrincipalPop; // recursive — Acceleration POP uses same schema
}
```

### §4.1 Design decisions worth flagging

- **Items referenced by stable ID, not letter.** Ares XV's clause "B" pays interest item (I); Carlyle's "11.1.1.2.1.2" pays a different letter. Letters drift across managers; IDs don't.
- **Predicates as a closed enum.** Agent did not find a predicate in 4 sample deals that didn't fit. `[UNVERIFIED-AGENT]` — verify with cross-ref.
- **`SeniorityRank: number`, not class-name string.** Anti-pattern #1 in CLAUDE.md.
- **Coverage Test vs Par Value Test as separate variants.** Forced by Ares XV E/F.
- **Acceleration POP is recursive into the same schema.** Not flat field on parent.
- **Hurdles, thresholds, OC trigger ratios NOT in this schema.** Live on test/fee definitions referenced by the clauses; per anti-pattern #3 they must be per-deal extracted.

---

## §5. Ares XV mapping into the schema

`[UNVERIFIED-AGENT]` — agent-produced; mapping is internally consistent with §2 but not independently verified against the OC PDF.

| Ares XV clause | Schema clause | Notes |
|---|---|---|
| A | `unconditional_backfill` paysItems = [taxes, profit, trustee, admin, expReserve, srMgmtFee+VAT, hedge, classA_int, classB_int] | The (A)–(H) bundle |
| B | `coverage_test_cure` gatingTranche=2 (B), payTarget=`note_payment_sequence_from rank=1` | A/B Coverage gate |
| C | `controlling_class_backfill` gatingTranche=3 (C), paysItems=[classC_int] | |
| D | `controlling_class_backfill` gatingTranche=3 (C), paysItems=[classC_def_int] | |
| E | `coverage_test_cure` gatingTranche=3 (C), payTarget=`...from rank=1` | C Coverage gate |
| F | `controlling_class_backfill` gatingTranche=4 (D), paysItems=[classD_int] | |
| G | `controlling_class_backfill` gatingTranche=4 (D), paysItems=[classD_def_int] | |
| H | `coverage_test_cure` gatingTranche=4 (D) | |
| I | `controlling_class_backfill` gatingTranche=5 (E), paysItems=[classE_int] | |
| J | `controlling_class_backfill` gatingTranche=5 (E), paysItems=[classE_def_int] | |
| K | `par_value_test_cure` gatingTranche=5 (E) | E uses PV not Coverage |
| L | `controlling_class_backfill` gatingTranche=6 (F), paysItems=[classF_int] | |
| M | `controlling_class_backfill` gatingTranche=6 (F), paysItems=[classF_def_int] | |
| N | `par_value_test_cure` gatingTranche=6 (F) | F uses PV not Coverage |
| O | `effective_date_rating_event` | |
| P | `special_redemption` proceedsSubset=`special_redemption_amount` | |
| Q | `reinvestment_discretion` phase=`rp_or_post_rp_carveout` options=[hold, reinvest_substitute, reinvest_unscheduled_or_credit] | |
| R | `mandatory_post_rp_redemption` sequence=`note_payment_sequence` | |
| S | `post_rp_interest_overflow` paysItems=[reinv_oc_diversion, sub_mgmt_fee, trustee_admin_excess] | |
| T | `reinvesting_holder` | EU-RR mechanism |
| U | `incentive_fee` trigger=`subnote_irr_threshold` thresholdParam=<extract> | |
| V | `residual_to_subordinated` | |

### §5.1 Schema axes UNEXERCISED by Ares XV

These are the portability surfaces — fields whose correctness can only be proved by another deal:
- `controllingClass.kind = "majority_vote_within_class" | "balance_weighted"` (Ares uses `highest_rank_outstanding`)
- `redemptionMode = "pro_rata_post_rp_with_subnote_election"` (Ares is purely sequential)
- `coverage_test_cure.payTarget` other than `note_payment_sequence_from`
- `IncentiveFeeClause.trigger = "incentive_management_fee_threshold"` (Ares uses subnote-IRR-threshold)
- `ReinvestmentDiscretionClause.options` containing `redeem_on_retention_deficiency`
- `PreWaterfallReservation.kind = "interest_reserve_account_topup"`

---

## §6. Verification targets for the cross-reference agent

Six of the eight targets below were addressed by cross-reference work (see §11). Two remain open and roll into §8 as tentative residuals.

### §6.1 High leverage — test these first

1. **EDGAR URL existence and content spot-check.** ✅ `[COMPLETED §11.1]` All three URLs return 200 OK; clause structures match agent claims with two minor refinements (Barings has 2 secured tranches not 3; Golub has pari-passu C-1/C-2 split; Carlyle has pari-passu A-Senior split). Schema's `SeniorityRank: number` handles pari-passu implicitly; comment added in §4.

2. **Controlling Class definition cross-deal.** ✅ `[COMPLETED §11.2]` All three US-domestic indentures verified to use `highest_rank_outstanding`. Agent's parenthetical about Fitch documenting majority-vote / balance-weighted variants `[REFUTED]` — Fitch PDF (direct read, §11.5) does not document Controlling Class derivation variants. `ControllingClassRule` discriminated union trimmed in §4 to a single variant.

3. **Coverage-vs-PV-Test bifurcation cross-deal.** ✅ `[COMPLETED §11.3]` All three US-domestic indentures use Coverage Tests (OC+IC) uniformly across all rated tranches; no Par Value Test (OC-only) appears. The "European-typical" labeling `[REFINED]` to "observed in Ares XV; uniformly absent in 3 sampled US-domestic deals." Bifurcation is real (schema retains both variants); regional-vs-Ares-family categorization remains open with sample of one European deal.

4. **Predicate set closure.** ✅ `[COMPLETED §11.4]` One predicate added: `restructured_asset_acquisition_authorized` (workout-loan / rescue-financing). Other 10 predicates verified via direct indenture reads. Schema gains `RestructuredAssetAcquisitionClause` variant in §4.

### §6.2 Medium leverage — would meaningfully refine the schema

5. **Fitch PDF direct read.** ✅ `[COMPLETED §11.5]` PDF dated June 29, 2023; sample 279 BSL CLOs 2021-2023; 14 FAQ categories. Agent's Fitch-derived specific claims `[REFUTED]`; Fitch's actual coverage (rescue financing FAQ13, OC Haircuts FAQ9, Exchanges FAQ12, Maturity Amendments FAQ14) was missed by agent.

6. **Workout-loan mechanic.** ✅ `[COMPLETED §11.6]` Mechanism IS present in modern sample — Carlyle 2024-1's "Restructured Asset" + "Bankruptcy Exchange" + "Distressed Exchange" + "Permitted Equity Security" + "Uptier Priming Debt" cluster, gated on "Restructured Asset Target Par Balance Condition" with explicit caps. Fitch FAQ13 confirms routine; S&P Par Wars 2020 names the concept. New `RestructuredAssetAcquisitionClause` schema variant in §4.

7. **Sample expansion to 1 more European deal.** ⏳ `[OPEN]` — not addressed by cross-ref pass. The PV-vs-Coverage labeling and the European-2.0 schema generalization both ride on this. Tracked in §8.1 / §8.3 as a tentative residual; resolvable by reading one more European 2.0 indenture (Permira / BlackRock European / Capital Four / Carlyle European / Investcorp).

### §6.3 Low leverage — nice-to-have

8. **Fresh Ares XV OC read (pp. 176-179).** ⏳ `[OPEN]` — not addressed by cross-ref pass. `ppm.json:213-276` is still relied upon as faithful; tracked in §8.2 as a residual. Resolvable by direct PDF spot-check of 2-3 clauses verbatim.

9. **Sell-side primer survey** — Citi / JPM / BofA / Morgan Stanley CLO market overview papers. ⏳ `[NOT PURSUED]` — superseded by direct rating-agency reads (Fitch + S&P Par Wars). Sell-side is corroborative-only; if a future review wants additional confidence, this is the cheapest source to hit.

---

## §7. Conceptual closure path (post-verification)

Assuming §6 verification confirms or modestly refines the schema, the closure path is seven sequential steps:

1. **Verify the survey (§6 work).** Output: schema either confirmed or revised with new clause variants. The note in §4 marked "STARTING PROMPT" gets upgraded to "validated against N indentures" with the validation list explicit.

2. **Encode the schema in `web/lib/clo/resolver-types.ts`.** Add `PrincipalPop` interface + supporting types as a sibling to existing `LongDatedValuationRule` / `IndustryCapRule` / `DiscountObligationRule`. Add `principalPop: PrincipalPop | null` field to `ResolvedDealData`.

3. **Extend `ppm.json` schema with the principal-POP block.** Populate Ares XV from a fresh OC read (clauses A–V mapped per §5). Extend the schema validator to require the block on non-greenfield deals.

4. **Resolver extraction + blocking gate.** Add `resolvePrincipalPop` to `web/lib/clo/resolver.ts`. Same shape as `resolveLongDatedObligation` at lines 876-924: block via `severity: "error", blocking: true` when `ppm.json` lacks the block on a non-greenfield deal. Test in `blocking-extraction-failures.test.ts`.

5. **Engine dispatch refactor at `projection.ts:4096-4118`.** Replace the uniform pro-rata loop with a clause-by-clause walk over `resolved.principalPop.clauses`. For each clause:
   - Check the gating predicate against current period state (RP boundary, Controlling Class, Coverage/PV test results)
   - If predicate evaluates true, dispatch to clause-specific paydown logic
   - Track `remainingPrelim` across clauses
   - Emit per-clause amounts to `stepTrace` (new field; mirror the harness re-route shape from KI-07)

6. **Re-baseline cascade tests.** Run the full `npm test` suite. Tests that pin behavior dependent on the uniform loop will shift; specifically expected to move:
   - `ki27-deferred-interest-seed.test.ts` case 1 (the €5M Class E PIK drift)
   - `b1-compositional-eod.test.ts` (deferred-interest cascades)
   - `b2-post-acceleration.test.ts` (post-accel principal handling — verify it doesn't conflict with the new pre-accel dispatch)
   - `projection-cure.test.ts` (cure mechanics)
   - Possibly `n1-correctness.test.ts` (Euro XV harness — should stay clean given Euro XV's current zero-PIK state)

   Each shifted test gets re-baselined to the new PPM-correct value or removed if the fix supersedes it. Per CLAUDE.md "the ledger ↔ test bijection is load-bearing" — every test movement carries a comment explaining why.

7. **Integrate with KI-07's `deferredPaydownByTranche` field.** The new engine dispatch at the principal-POP site will populate the field at the points where deferred is paid down (now under PPM-correct gating). KI-07's marker tests should still pass under the new dispatch because the field is observability, not behavior.

### §7.1 Decision: KI-07 vs principal-POP redesign as separate PRs

Per the analysis in turn 6 of the conversation: separate PRs. KI-07's marker pins observability; principal-POP redesign's marker pins clause-by-clause dispatch correctness. Different invariants, different PRs, even though they touch overlapping code surfaces.

---

## §8. Tentative residuals (KI-29 shape portability checkpoint)

Three residuals remain tentative after cross-reference verification:

### §8.1 Validation against ≥1 non-Ares PPM ingested in the wild

The schema is grounded in cross-manager survey + verified direct reads of three US-domestic indentures, but Ares XV is the only deal whose PPM is actually ingested into the codebase. KI-29 took the same posture: schema designed from public corpus, ship Ares-XV-correct, leave portability validation as a tentative residual until a non-Ares deal organically arrives in the pipeline. The new principal-POP KI inherits this shape.

What "validated" means for closure of the residual: a non-Ares PPM is ingested, its principal-POP block extracts cleanly into the discriminated union without resolver blocking, and the engine projects the deal to maturity without crashes or unexpected zero-magnitude buckets.

### §8.2 Fresh Ares XV OC read (pp. 176-179)

`ppm.json:213-276` is the structured extract of Ares XV's OC Condition 3(c). Cross-reference §11 did not perform a direct read of the OC PDF to verify the extract is faithful. Tracked here as a low-leverage residual: a 15-minute direct read against the PDF is the right closure step, but doesn't block engine work. Risk if the extract is wrong: the schema-driven dispatch will dispatch on incorrect clauses for Ares XV. Mitigation: the synthetic marker test in §9 catches gross extraction errors; subtle wording differences (e.g. "Class C is Controlling Class" vs "the Notes of which Class C is the Controlling Class") would not be caught.

### §8.3 European-2.0 PV-vs-Coverage Test bifurcation labeling

The bifurcation is structurally real (Ares XV E/F use Par Value Test; the schema has both `coverage_test_cure` and `par_value_test_cure` variants). What remains unverified is whether the bifurcation is "European-typical" (true across non-Ares European 2.0 managers) or "Ares-family-specific" (only Ares XV-style deals). One additional European 2.0 indenture from a different manager (Permira, BlackRock European, Capital Four, Carlyle European, Investcorp) resolves this.

This residual is **labeling-only**, not behavior-blocking. The engine work proceeds either way: schema includes both variants, Ares XV maps cleanly to the PV-Test-for-E/F variant, the engine dispatches per Ares XV's PPM. The residual closes when a non-Ares European deal is read and its PV/Coverage structure is documented.

### §8.4 Workout-loan-era completeness

`RestructuredAssetAcquisitionClause` was added to the schema based on Carlyle 2024-1's "Restructured Asset" + "Bankruptcy Exchange" + "Distressed Exchange" + "Permitted Equity Security" + "Uptier Priming Debt" cluster (§11.6). Whether this single clause variant captures all variation in workout-loan provisions across post-2020 indentures — or whether some managers split workout-loan handling differently (e.g. separate clauses for distressed vs uptier vs bankruptcy) — is unverified beyond Carlyle 2024-1. Resolvable by reading one or two more 2024-vintage indentures (Apollo, Blackstone, KKR, Sound Point — any major BSL CLO manager's recent deal).

---

## §9. Draft KI ledger entry

Format follows existing ledger entries in `web/docs/clo-model-known-issues.md`. Treat this as the body to file once §6 verification completes (or files now as tentative).

```markdown
<a id="ki-NN"></a>
### [KI-NN] Principal POP backfill conditionality unmodeled (engine runs uniformly-simplified loop)

**Status (initial filing, 2026-05-06):** TENTATIVE — design grounded in public-corpus
survey of four CLO indentures (Ares XV, Carlyle DL 2024-1, Golub 2018, Barings 2019)
plus Fitch "U.S. CLO Indenture Features Explained" (Jun 2023) + S&P "Par Wars: The
Phantom Limits" (Feb 2020). Cross-reference verification completed 2026-05-06
(see `web/docs/principal-pop-redesign-research.md` §11). Schema has known portability
surfaces unexercised by Ares XV (see Quantitative magnitude). Validation against
≥1 non-Ares PPM ingestion + 1 additional European 2.0 indenture read are the
residual closure steps.

**PPM reference:** Ares XV OC Condition 3(c), Principal Priority of Payments,
clauses (A) through (V). Mapped in `ppm.json:249-276`.

**Current engine behavior:** `web/lib/clo/projection.ts:4096-4118` runs a uniformly-
simplified principal POP: iterates ranks ascending, for each rank pays accumulated
deferred-balance pro-rata then trancheBalance pro-rata. No gating predicates applied
— the engine ignores the 14 conditional backfill clauses (Controlling Class gating
on (C)-(D) (F)-(G) (I)-(J) (L)-(M); Coverage Tests gating on (B), (E), (H);
Par Value Tests gating on (K), (N); Effective Date Rating Event on (O);
RP-vs-post-RP dispatch on (Q)/(R)/(S)) that the PPM specifies. The
`resolved.principalPop` field does not exist — the resolver discards the principal-
POP block during resolution despite the data being present in `ppm.json`.

**PPM-correct behavior:** Engine consumes a per-deal `PrincipalPop` discriminated
union (see `web/docs/principal-pop-redesign-research.md` §4) extracted from the
deal's PPM. For each period's principal-POP execution, the engine walks the
ordered clauses, evaluates each clause's gating predicate against current period
state (Controlling Class derivation, OC/IC/PV test results, RP boundary), and
dispatches to clause-specific paydown logic when the predicate evaluates true.
Per-clause amounts emit to `stepTrace` for partner-facing trace reconstruction.

**Quantitative magnitude:** Zero on Ares XV today (no PIK on any deferrable
class, no Effective Date events, no Coverage Test failures requiring
principal-side cure backfill). Latent in three modes:
- Stress on Ares XV (PIK accrues + principal arrives + junior class isn't
  Controlling → engine pays PIK from principal regardless of Controlling Class
  gate, which Ares XV's clause (D) forbids)
- Late-life Ares XV (after Class A+B paid off, the gating becomes load-bearing)
- Any non-Ares deal (different clause structure, possibly different predicates)

**Deferral rationale:** Tentative until cross-reference verification confirms
the schema captures the cross-manager design space. Engine work is bounded
(7 sequential steps; see research note §7) but rides on the schema being
correct, which the 4-deal sample size doesn't fully validate.

**Path to close:** See `web/docs/principal-pop-redesign-research.md` §6 for
verification targets and §7 for the conceptual closure sequence. Six
sequential steps after verification: encode schema in resolver-types,
extend ppm.json, resolver extraction + blocking gate, engine dispatch
refactor, re-baseline cascade tests (ki27 case 1, b1, b2, projection-cure
expected to move), integrate with KI-07's `deferredPaydownByTranche` field.
Validation against ≥1 non-Ares PPM remains tentative residual (KI-29 shape).

**Test:** Synthetic marker pinning current uniformly-simplified behavior:
`projection-principal-pop-conditionality.test.ts > KI-NN-uniformLoop` with
fixture exercising Class C PIK accumulation + principal arrival while Class
A outstanding. Asserts current engine pays Class C deferred (engine WRONG
per PPM clause (D) gate). Marker flips when the schema-driven dispatch lands.
```

(Number `KI-NN` to be assigned at filing time per ledger sequence.)

---

## §10. Notes for the user

Updated 2026-05-06 post-cross-reference. Three explicit caveats remain:

1. **§3 and §4 are partially verified.** Cross-reference §11 confirmed the EDGAR claims, the Controlling Class definition, the Coverage-vs-PV bifurcation in US-domestic deals, and added one missing predicate (workout-loan / rescue-financing). It refuted two specific Fitch-derived claims that turned out to be paraphrasing artifacts. The schema in §4 has been trimmed (removed two unsupported `ControllingClassRule` variants) and extended (added `RestructuredAssetAcquisitionClause`). Net: schema is no longer "agent-produced unverified" — it's "verified across 4 deals + agency methodology, with two open residuals tracked in §8."

2. **§7 closure path is unaffected by cross-reference.** The 7-step sequence (verify → encode → extend ppm.json → resolver extraction → engine dispatch → re-baseline → integrate with KI-07) holds. Step 1 ("verify the survey") is now substantively complete except for §6.2.7 and §6.3.8, which roll into §8 residuals rather than gating closure work.

3. **The KI-29 portability residual posture remains a deliberate choice.** Cross-reference work substantively de-risked the schema but did not eliminate the need for the tentative residual on non-Ares PPM ingestion. If you'd rather hold the new KI open until §8.1 closes via real ingestion, the residual becomes a hard blocker.

---

## §11. Cross-reference verification report (2026-05-06)

Source: independent verification pass against §6 targets. Tags: `[VERIFIED]` claim survives independent check; `[REFUTED]` claim is wrong on its face; `[REFINED]` claim is partially correct but needs reformulation; `[UNVERIFIABLE]` claim cannot be confirmed or refuted from accessed sources.

### §11.1 EDGAR URL existence and content spot-check

`[VERIFIED]` All three URLs return 200 OK and content matches the agent's claims. Direct fetches confirmed:

- **Carlyle Direct Lending CLO 2024-1, LLC** — Indenture dated October 29, 2024. Class structure: A-1, A-L1 Loans, A-L1 Notes, A-L2 Loans, A-2, B, C, D, Reinvesting Holder Notes, Preferred Interests. Section 11.1 "Disbursements of Monies from Payment Account" is the principal POP location. Trustee: Wilmington Trust. Closing Date Committed Par Amount: U.S.$420M.
- **Barings BDC Static CLO Ltd. 2019-I** — Indenture dated May 9, 2019. Class structure: Class A-1 ($296.75M), Class A-2 ($51.5M), Subordinated ($101M). Co-Issuer with Barings BDC Static CLO 2019-I, LLC. Trustee: State Street.
- **Golub Capital BDC CLO III LLC** — Indenture dated November 16, 2018. (Agent's "Golub Capital BDC CLO 2018" naming is informal; actual entity is the third in series.) Class structure: A, B, C-1, C-2, D, Subordinated. Trustee: U.S. Bank.

`[REFINED]` Tranche counts in agent's §3.2 had small errors:
- Barings: agent said "3 secured tranches" — actually 2 secured (A-1, A-2) plus unsecured Subordinated.
- Golub: 5 secured rated classes but C-1/C-2 are pari-passu, so 4 seniority ranks structurally.
- Carlyle: 5 distinct seniority ranks but Class A Senior splits pari-passu into A-1 / A-L1 Notes / A-L1 Loans / A-L2 Loans.

**Schema implication:** `SeniorityRank: number` handles pari-passu sub-classes implicitly (multiple tranches share a rank). §4 schema gains an explicit comment.

### §11.2 Controlling Class definition cross-deal

`[VERIFIED]` All three EDGAR indentures use **highest-rank-outstanding**:

- Carlyle 2024-1: "The Class A Senior Debt so long as any Class A Senior Debt is Outstanding; then the Class A-2 Notes... then the Class B Notes... then the Class C Notes... then the Class D Notes... then the Reinvesting Holder Notes... and then the Preferred Interests."
- Barings 2019: "The Class A-1 Notes so long as any Class A-1 Notes are Outstanding; then the Class A-2 Notes... and then the Subordinated Notes."
- Golub 2018: "The Class A Notes so long as any Class A Notes are Outstanding; then the Class B Notes... then the Class C Notes... then the Class D Notes... and then the Subordinated Notes."

`[REFINED]` Agent's claim that "Majority-vote / weighted-class variants exist in Fitch's framework but govern *consent/amendment* rights, not POP gating" is **not supported by the Fitch PDF** when read directly. The Fitch document covers 14 categories but does NOT document Controlling Class derivation variants anywhere. Fitch mentions "Majority of the Controlling Class" / "Supermajority of the Controlling Class" only in voting-threshold contexts (matching Golub's "Supermajority of Controlling Class" for EOD voting), not as alternate Controlling Class derivation rules.

**Schema implication:** `ControllingClassRule` discriminated union trimmed in §4 — dropped `majority_vote_within_class` and `balance_weighted` (neither is supported by any source). Single-variant union retained in discriminated form so future variants can be added without breaking the type.

### §11.3 Coverage Test vs Par Value Test bifurcation

`[VERIFIED]` All three US-domestic EDGAR indentures use **Coverage Tests = OC + IC** uniformly across all rated tranches, including the most-junior:

- Carlyle 2024-1, "Coverage Tests": "The Overcollateralization Ratio Test and the Interest Coverage Test, each as applied to each specified Class of Rated Debt." Class A/B (combined), Class C, Class D — all OC+IC.
- Barings 2019, "Coverage Tests": "The Overcollateralization Ratio Test and the Interest Coverage Test, each as applied to each specified Class or Classes of Secured Notes." Tested only against Class A.
- Golub 2018, "Coverage Tests": "The Overcollateralization Ratio Test and the Interest Coverage Test, each as applied to each specified Class or Classes of Secured Notes." Class A/B (combined), C, D — all OC+IC.

**No Par Value Test (OC-only) appears in any of the three US-domestic deals.** Ares XV's E/F PV-Test is the only PV-only example in the sample.

`[REFINED]` Agent's claim that PV-vs-Coverage bifurcation is "European-typical" is **not yet verified** — the European-typical generalization rides on a sample of one (Ares XV). Verified: PV-Test-only is **not US-domestic**. Whether it's "European," "Ares-family," or "European 2.0 with EU risk-retention" — unresolved with current sample.

**Schema implication:** Both `coverage_test_cure` and `par_value_test_cure` clause variants stay (both real). The "European-typical" labeling in §3.2 is downgraded to "observed in Ares XV; uniformly absent in 3 sampled US-domestic deals." Remaining residual tracked in §8.3.

### §11.4 Predicate set closure

`[REFINED]` Agent's §3.2 enum of ~10 predicates **misses one structurally important mechanism** that surfaces in both Fitch's 2023 report and the Carlyle 2024-1 indenture:

**Restructured-asset / workout-loan / rescue-financing acquisition.** This is an *asset acquisition* clause that consumes principal proceeds to buy obligations that don't meet the Collateral Obligation definition. It's not a redemption (so doesn't fit `redemption_event`), not a backfill (proceeds leave the POP rather than paying noteholders), and not a `reinvestment_discretion` proceeds-subset operation (the asset acquired is structurally distinct from a reinvestment). It's a third application path for principal proceeds.

In Carlyle 2024-1: "Permitted Use Account" + "Restructured Asset Target Par Balance Condition" + "Bankruptcy Exchange" + "Distressed Exchange" + "Permitted Equity Security" + "Uptier Priming Debt" cluster, with explicit Principal Proceeds applications gated on test-satisfaction conditions and percentage caps (≤7.5% Restructured Assets cumulative since Closing; ≤10.0% via Distressed Exchange).

In Fitch FAQ13 terminology: "rescue financing" covering "workout loans, restructured loans, loss mitigation loans, specified equity securities and uptier priming transactions."

**Schema implication:** Added `RestructuredAssetAcquisitionClause` variant in §4. Predicate `restructured_asset_acquisition_authorized` is the 11th in the enumeration.

`[VERIFIED]` Other 10 predicates (unconditional, coverage_test_failure, par_value_test_failure, is_controlling_class, during_reinvestment_period, after_reinvestment_period, redemption_event, effective_date_rating_event, retention_deficiency, incentive_fee_threshold_met, enforcement_event) all surface in at least one of the four sampled deals.

### §11.5 Fitch PDF direct read

`[VERIFIED]` PDF exists at the cited URL and returns 200 OK. Title: "U.S. CLO Indenture Features Explained — Variations Can Protect Against or Increase Credit Risk." Date: June 29, 2023. Sample size: 279 Fitch-rated BSL CLOs from January 2021 to May 2023. Structured as 14 FAQ-format categories with frequency-of-observation buckets.

`[REFUTED]` Agent's specific Fitch-derived claims do not survive direct read:
- Agent claimed Fitch documents "Controlling Class" definition variants. Fitch's report **does not address Controlling Class definition variants** in any of the 14 categories.
- Agent claimed Fitch documents PV-vs-Coverage Test naming variants. Fitch's report does **not address Par Value Test vs Coverage Test naming or structural variants** as a separate category.

`[REFINED]` What Fitch actually covers that the agent missed:
- **Rescue financing** (FAQ13): explicit named categories of workout loans, restructured loans, loss mitigation loans, uptier priming transactions, specified equity securities. Confirms routine in 2021-2023 indentures.
- **Maturity Amendments** (FAQ14): workout/restructuring carveouts in maturity-amendment provisions are common.
- **OC Haircuts** (FAQ9): documents that OC haircuts on rescue-financing assets have been increasing.
- **Exchanges** (FAQ12): distressed and bankruptcy exchanges are routine (75-100% frequency).

The agent's self-flag that the Fitch fetch was paraphrased was load-bearing — every Fitch-derived claim should be re-checked against the actual PDF text, which §11 has now done.

### §11.6 Workout-loan mechanic in S&P Par Wars 2020 + Carlyle 2024-1

`[VERIFIED]` S&P "Par Wars: The Phantom Limits" (Feb 21, 2020) explicitly names the workout-loan concept: introduced in a number of transactions, allows the CLO to participate in offers from distressed companies to which the deal already has exposure even when the new asset does not meet all aspects of the collateral obligation definition. In most cases workout loans are funded with non-principal proceeds (equity contributions, fee waivers), but some indentures allow principal proceeds for workout-loan acquisitions.

`[REFUTED]` Agent's §3.3 reliability flag #5 — "Workout-loan mechanic absent from sample" — is **wrong for Carlyle 2024-1**. The Carlyle indenture's "Restructured Asset" + "Bankruptcy Exchange" + "Distressed Exchange" + "Permitted Equity Security" + "Uptier Priming Debt" cluster, gated by the "Restructured Asset Target Par Balance Condition," is the workout-loan mechanism in modern naming. Specific Principal Proceeds applications:
- Distressed Exchange: cumulative cap of 10.0% of Target Initial Par Amount on assets where the new obligation doesn't satisfy Collateral Obligation criteria.
- Restructured Asset / Permitted Equity Security: ≤7.5% of Target Initial Par cumulative; ≤2.5% outstanding at any time.
- Uptier Priming Debt: gated on the SNMD Condition (a recovery-comparison test).

Whether Barings 2019 and Golub 2018 have analogous mechanisms not separately confirmed — Barings's static structure makes it less applicable; Golub 2018 likely has a less developed version (predates wide adoption per Fitch's framing).

### §11.7 Items unverifiable from §11 work

`[UNVERIFIABLE]` PV-vs-Coverage bifurcation as European-typical vs Ares-family-specific. Sample-of-one limitation; resolves by reading one more European 2.0 indenture from a different manager. Tracked in §8.3.

`[UNVERIFIABLE]` Fresh Ares XV OC pp. 176-179 read. `ppm.json:213-276` is therefore still relied on as faithful. Tracked in §8.2.

### §11.8 Net effect on §3, §4, §5, §6, §7, §8

- **§3.2** updated: predicate set is now 11 (added `restructured_asset_acquisition_authorized`); Controlling Class claim upgraded to `[VERIFIED — 4 deals]`; Fitch parenthetical refuted and removed; PV-vs-Coverage labeling refined.
- **§3.3** updated: flag #1 confirmed-and-acted-upon (Fitch claims refuted); flag #2 unchanged; flag #3 EDGAR URLs verified; flag #4 sample-bounded but predicate set held; flag #5 refuted (workout-loan present in modern sample, schema variant added).
- **§4** schema trimmed (`ControllingClassRule` reduced to single variant) and extended (`RestructuredAssetAcquisitionClause` added). Pari-passu comment added on `SeniorityRank`.
- **§5** Ares XV mapping unchanged.
- **§6** verification targets 1-6 marked completed; 7 and 8 remain open as residuals.
- **§7** closure path unchanged.
- **§8** residuals concretized: §8.1 unchanged; §8.2 stays open (fresh OC read); §8.3 added (European bifurcation labeling); §8.4 added (workout-loan completeness — single Carlyle source).
