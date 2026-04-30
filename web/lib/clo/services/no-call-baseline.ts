/**
 * No-call baseline derivation — post-v6 plan §9 #11 / decision-log entry S.
 *
 * Centralizes the canonical "no-call" projection-input derivation. Two
 * helpers:
 *
 *  - `deriveNoCallBaseInputs(inputs)`: strips the entry-price slider state
 *    AND pins `callMode: "none"` / `callDate: null`. The result represents
 *    the partner-facing "held to legal final, no call" baseline that drives
 *    the canonical Forward IRR rows, Fair Value @ hurdle anchors, and the
 *    inception-IRR mark-to-model `forwardDistributions`. Independent of
 *    user slider state.
 *
 *  - `applyOptionalRedemptionCall(noCallBase, callDate)`: overlays the
 *    optional-redemption call at `callDate` with par mode. The result
 *    represents the canonical "with call" alternative used in side-by-side
 *    displays (post-v6 plan §9 #5 / option (d)).
 *
 * Why centralize: the duplicated inline derivation in `ProjectionModel.tsx`
 * was the proximate cause of the merge-blocker 1 spot-fix scope gap —
 * `forwardIrrTriple` / `fairValues` / `inceptionIrr` got the no-call pin
 * but `entryPriceSweep` and the `@ custom` row didn't. Centralizing makes
 * "find all consumers of the no-call baseline" a single grep, and keeps
 * the no-call semantic in one place.
 */

import type { ProjectionInputs } from "../projection";

export function deriveNoCallBaseInputs(
  inputs: ProjectionInputs & { equityEntryPrice?: number },
): ProjectionInputs {
  const { equityEntryPrice: _strip, ...rest } = inputs;
  void _strip;
  return { ...rest, callMode: "none", callDate: null };
}

export function applyOptionalRedemptionCall(
  noCallBase: ProjectionInputs,
  callDate: string,
): ProjectionInputs {
  return {
    ...noCallBase,
    callMode: "optionalRedemption",
    callDate,
    callPriceMode: "par",
    callPricePct: 100,
  };
}
