# External-Materials Audit — Post-v6 Phase 0 Label Changes

**Date:** 2026-04-29
**Trigger:** Post-v6 correctness plan §3.9 (Phase 0 deliverable).
**Scope:** documents and partner-shared materials referencing the pre-2026-04-29
"Projected Forward IRR" / "Inception IRR (since closing)" / "Inception IRR (user
anchor)" labels and the auto-fill-from-inception slider behavior.

## Why this audit exists

Phase 0 changes partner-visible labels:

- `Projected Forward IRR` → `Forward IRR (held to legal final, no call)`
- The single `Inception IRR (since closing | user anchor)` line → three rows:
  `Realized` / `Mark-to-book` / `Mark-to-model`
- The slider's primary role (driving the headline IRR) → demoted to a "what-if"
  custom row alongside three fixed-anchor rows (cost basis / book / fair-value-10%)
- Auto-fill from inception cost basis on page load → removed entirely

Existing external materials referencing the old labels silently become wrong
post-Phase 0. This audit catalogs occurrences and triages each.

## Findings

### Internal docs (in-repo)

| Path | Occurrence | Triage |
|---|---|---|
| `docs/plans/2026-04-29-post-v6-correctness-plan.md` | Multiple references in the plan body and review history | **Keep as-is.** This document IS the plan that authorizes the change; references to old labels here are historical / definitional. |
| `docs/superpowers/specs/2026-04-18-inception-irr-design.md` | Line 67: refers to the old "Projected Forward IRR" card placement | **Annotate.** This is the predecessor design doc for the v6 inception-IRR work; superseded by Phase 0 §3.1+§3.2. Add a header note. |
| `docs/clo-modeling-decisions.md` | References "auto-fill" in the context of decision #6 (which describes the change) | **Keep as-is.** Decision is about removing auto-fill; references are explaining what was removed. |
| `web/docs/clo-model-known-issues.md` | KI entries, no IRR-label references found in this audit | **No action.** |

### Partner-shared materials

| Material | Location | Status |
|---|---|---|
| Partner deck (Euro XV) | _Not in repo_ — solo project; no partner deck shared yet | **No-op.** |
| PDF exports | _Not yet built_ (PDF export is a Phase D deliverable) | **No-op until Phase D.** |
| Slack/email screenshots | _Not in repo_ | **No-op.** |
| Onboarding guide | _Not yet built_ | **No-op until written.** |

### Code-level remnants

| Path | Occurrence | Triage |
|---|---|---|
| `web/app/clo/waterfall/ProjectionModel.tsx` | Old labels and auto-fill removed in PR0.1 / PR0.4 | **Done.** |
| `web/scripts/debug-q1-waterfall.ts` | Uses `inceptionIrr.primary.irr` (now mark-to-book equivalent via back-compat field) and prints "user IRR" / "default IRR" labels | **Annotate.** Script is a developer debug tool; labels remain ambiguous to the developer reading them. Acceptable for now since it's not partner-facing. Annotate inline that "default IRR" = mark-to-book at default anchor. |

## Action items

1. ✅ Add header note to `docs/superpowers/specs/2026-04-18-inception-irr-design.md`:
   "Superseded by post-v6 Phase 0 §3.1 + §3.2; this doc represents the v6 design that
   shipped a single mark-to-book IRR — Phase 0 ships all three modes."
2. ✅ Annotate `web/scripts/debug-q1-waterfall.ts` with a comment near the IRR
   prints noting the labels.
3. (No-op) Partner-facing materials don't exist yet; this audit's output becomes
   the diff baseline if they do.

## Audit summary

- **Persistence migration (§3.8): no migration needed.** The slider state is
  in-memory React useState only; no URL params, no localStorage. The pre-existing
  auto-fill from `equityInceptionData.purchasePriceCents` was the only
  persistence-like behavior, and it was removed in PR0.4.
- **External materials catalog (§3.9):** above. Two doc-level annotations + a
  developer-script comment cover the in-repo surface. No partner deliverables
  exist yet, so no external-material drift.
- **Phase 0 → Phase A gate** per §11: state migration shipped (trivially —
  nothing to migrate); external-materials audit complete (this document).
