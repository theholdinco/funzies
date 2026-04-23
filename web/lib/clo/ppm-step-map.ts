/**
 * PPM interest waterfall step-code map.
 *
 * Maps trustee waterfall step descriptions (e.g. "(A)(i)", "(E)(1)", "(X)(3)")
 * to a canonical lowercase form ("a.i", "e.1", "x.3") and — for each engine
 * emitted bucket — to the set of PPM step codes it covers. This is the heart
 * of the N1 waterfall-replay harness: it's how we know which trustee rows
 * correspond to which engine outputs.
 *
 * Reference: `raw.constraints.waterfall.interestPriority` in the Ares Euro XV
 * offering circular lists 35 interest steps (A)(i) through (DD). The canonical
 * form below preserves the trustee's lettering but uses dot-notation for
 * sub-indices.
 */

// ----------------------------------------------------------------------------
// Canonical step codes

/** Canonical lowercase step codes for the 35 PPM interest waterfall steps.
 *  Notation: uppercase trustee letter → lowercase; parenthesized sub-index
 *  (roman or digit) → dot-separated suffix. */
export type PpmInterestStep =
  | "a.i"   | "a.ii"
  | "b"     | "c"     | "d"
  | "e.1"   | "e.2"
  | "f"
  | "g"     | "h"
  | "i"
  | "j"     | "k"     | "l"
  | "m"     | "n"     | "o"
  | "p"     | "q"     | "r"
  | "s"     | "t"     | "u"
  | "v"     | "w"
  | "x.1"   | "x.2"   | "x.3"
  | "y"     | "z"
  | "aa"    | "bb"    | "cc"    | "dd";

/** All 35 canonical codes, in PPM sequential order. */
export const PPM_INTEREST_STEPS: readonly PpmInterestStep[] = [
  "a.i", "a.ii",
  "b", "c", "d",
  "e.1", "e.2",
  "f",
  "g", "h",
  "i",
  "j", "k", "l",
  "m", "n", "o",
  "p", "q", "r",
  "s", "t", "u",
  "v", "w",
  "x.1", "x.2", "x.3",
  "y", "z",
  "aa", "bb", "cc", "dd",
] as const;

// ----------------------------------------------------------------------------
// Normalization

/** Normalize a trustee-report step description like "(E)(1)" or "(A)(ii)"
 *  into the canonical lowercase form ("e.1" / "a.ii").
 *
 *  Returns null if the description doesn't match the known pattern (e.g.
 *  "opening" summary rows, blank strings).
 *
 *  Format-tolerant: accepts "(E)(1)" (full parens), "E(1)" (missing outer
 *  paren), "E.1" (already canonical), "(E)1" (missing inner parens). */
export function normalizePpmStepCode(description: string | null | undefined): PpmInterestStep | null {
  if (!description) return null;
  const s = description.trim();
  if (!s) return null;

  // Pattern A: (X)(sub) or X(sub) or (X)(sub)   — letter + optional sub
  //            sub is either roman (i, ii, iii, iv, v) or decimal digit(s).
  const match = s.match(/^\(?([a-z]+)\)?(?:\s*[.(]\s*([ivx]+|\d+)\s*\)?)?\s*$/i);
  if (!match) return null;

  const letter = match[1].toLowerCase();
  const sub = (match[2] ?? "").toLowerCase();
  const canonical = sub ? `${letter}.${sub}` : letter;

  return (PPM_INTEREST_STEPS as readonly string[]).includes(canonical)
    ? (canonical as PpmInterestStep)
    : null;
}

// ----------------------------------------------------------------------------
// Engine bucket → PPM step mapping
//
// `PeriodStepTrace` (in projection.ts) emits buckets at coarser granularity
// than the 35 PPM steps. The harness uses this map to:
//   - sum trustee-reported amounts across the step codes a bucket covers
//   - compare that sum against the engine's emitted bucket amount
//
// Buckets the engine does NOT emit (A(i) taxes, A(ii) Issuer Profit, D, V,
// Y, Z, AA, BB) are modeled as zero by the harness — see KI-01/02/03/05/06
// in the known-issues ledger. The corresponding trustee rows are mostly zero
// for Euro XV Q1 as well, so deltas are trivial.

/** Semantic names for the buckets the engine emits in `PeriodResult.stepTrace`
 *  and adjacent PeriodResult fields. */
export type EngineBucket =
  | "taxes"                 // step a.i  — NOT EMITTED by engine (KI-01)
  | "issuerProfit"          // step a.ii — NOT EMITTED by engine (KI-01)
  | "trusteeFeesPaid"       // steps b + c (bundled at Sprint 0; KI-08)
  | "expenseReserve"        // step d    — NOT EMITTED by engine (KI-02)
  | "seniorMgmtFeePaid"     // steps e.1 + e.2 (current + past-due bundled)
  | "hedgePaymentPaid"      // step f
  | "classA_interest"       // step g    (from PeriodResult.trancheInterest[ClassA].paid)
  | "classB_interest"       // step h    (from PeriodResult.trancheInterest[ClassB-*].paid — B-1 + B-2 pari passu)
  | "ocCure_AB"             // step i    (from stepTrace.ocCureDiversions filtered by rank)
  | "classC_current"        // step j    (from PeriodResult.trancheInterest[ClassC].paid)
  | "classC_deferred"       // step k    (from stepTrace.deferredAccrualByTranche[ClassC])
  | "ocCure_C"              // step l
  | "classD_current"        // step m
  | "classD_deferred"       // step n
  | "ocCure_D"              // step o
  | "classE_current"        // step p
  | "classE_deferred"       // step q
  | "pvCure_E"              // step r
  | "classF_current"        // step s
  | "classF_deferred"       // step t
  | "pvCure_F"              // step u
  | "effectiveDateRating"   // step v    — NOT EMITTED by engine (KI-03)
  | "reinvOcDiversion"      // step w
  | "subMgmtFeePaid"        // steps x.1 + x.2 + x.3 (bundled)
  | "trusteeOverflow"       // step y    — NOT EMITTED by engine pre-C3 (KI for Sprint 3)
  | "adminOverflow"         // step z    — NOT EMITTED by engine pre-C3
  | "defaultedHedgeTermination" // step aa — NOT EMITTED by engine (KI-06)
  | "supplementalReserve"   // step bb   — NOT EMITTED by engine (KI-05)
  | "incentiveFeePaid"      // step cc
  | "subDistribution";      // step dd   (from stepTrace.equityFromInterest)

/** Maps each engine bucket to the PPM step codes it covers.
 *  The harness sums trustee `amountPaid` across `ENGINE_BUCKET_TO_PPM[bucket]`
 *  and compares against the engine's emitted bucket value. */
export const ENGINE_BUCKET_TO_PPM: Record<EngineBucket, readonly PpmInterestStep[]> = {
  taxes: ["a.i"],
  issuerProfit: ["a.ii"],
  trusteeFeesPaid: ["b", "c"],          // Sprint 0: bundled. Sprint 3 / C3 splits into separate buckets.
  expenseReserve: ["d"],
  seniorMgmtFeePaid: ["e.1", "e.2"],
  hedgePaymentPaid: ["f"],
  classA_interest: ["g"],
  classB_interest: ["h"],
  ocCure_AB: ["i"],
  classC_current: ["j"],
  classC_deferred: ["k"],
  ocCure_C: ["l"],
  classD_current: ["m"],
  classD_deferred: ["n"],
  ocCure_D: ["o"],
  classE_current: ["p"],
  classE_deferred: ["q"],
  pvCure_E: ["r"],
  classF_current: ["s"],
  classF_deferred: ["t"],
  pvCure_F: ["u"],
  effectiveDateRating: ["v"],
  reinvOcDiversion: ["w"],
  subMgmtFeePaid: ["x.1", "x.2", "x.3"],
  trusteeOverflow: ["y"],
  adminOverflow: ["z"],
  defaultedHedgeTermination: ["aa"],
  supplementalReserve: ["bb"],
  incentiveFeePaid: ["cc"],
  subDistribution: ["dd"],
} as const;

/** Reverse lookup: given a canonical step code, which engine bucket covers it?
 *  Returns null for steps no bucket covers (shouldn't happen given the
 *  complete forward map, but useful for exhaustiveness checks). */
export function ppmStepToEngineBucket(step: PpmInterestStep): EngineBucket | null {
  for (const [bucket, steps] of Object.entries(ENGINE_BUCKET_TO_PPM) as Array<[EngineBucket, readonly PpmInterestStep[]]>) {
    if (steps.includes(step)) return bucket;
  }
  return null;
}
