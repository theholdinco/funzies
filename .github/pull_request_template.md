## Summary

<!-- One or two sentences on what this PR does and why. -->

## CLO cascade marker check

Cascade markers in `web/lib/clo/__tests__/` (KI-13a, KI-13b, KI-IC-AB, KI-IC-C, KI-IC-D) carry hard-coded `expectedDrift` values that represent the *net* residual after every upstream KI. A PR that closes or moves an upstream KI's magnitude but leaves the cascade markers stale will either mask a regression (false green) or fabricate one (false red).

**Pick one**:

- [ ] **This PR does not modify any KI marker magnitudes or close any KI.** (Default for most PRs — check this and move on.)
- [ ] **This PR touches at least one of: KI-01 / KI-08 / KI-09 / KI-10 / KI-11 / KI-12a.** Then:
  - [ ] Re-ran `npx vitest run lib/clo/__tests__/n1-correctness.test.ts lib/clo/__tests__/n1-production-path.test.ts lib/clo/__tests__/backtest-harness.test.ts` after the change.
  - [ ] Updated `KI-13a-engineMath` `expectedDrift` in `n1-correctness.test.ts`.
  - [ ] Updated `KI-13b-productionPath` `expectedDrift` in `n1-production-path.test.ts` (if an input-pipeline KI moved: KI-10 / KI-11).
  - [ ] Updated `KI-IC-AB`, `KI-IC-C`, `KI-IC-D` `expectedDrift` in `backtest-harness.test.ts`.
  - [ ] If a cascade drift crossed its `closeThreshold`, removed the `failsWithMagnitude` marker and moved the corresponding KI ledger entry to Closed.
  - [ ] Re-checked the **sign** of each cascade drift — signs can flip mid-close as offsetting drifts come down at different rates.

## Test plan

<!-- Bulleted checklist of what you tested locally. -->
