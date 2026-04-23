/**
 * B2 — Post-acceleration waterfall schema.
 *
 * Per PPM Condition 10(a): once an Event of Default occurs and the Class A
 * Noteholders direct acceleration, the normal two-waterfall model (separate
 * Interest and Principal priorities) collapses into a single "Priority of
 * Payments upon Acceleration." All proceeds — interest collections, principal
 * proceeds, recoveries — pool into one cash stream distributed in this order.
 *
 * Key structural differences from the normal waterfall:
 *
 *   1. Combined P+I, not separated. Each rated tranche receives interest AND
 *      principal in one pass, not split across two priority lists.
 *
 *   2. Fully sequential on Class A: absorbs cash until retired (P+I) before
 *      any flow to Class B. Classes C through F are also sequential. Class B
 *      tranches (B-1, B-2) remain pari passu within Class B.
 *
 *   3. Overflow buckets collapse. Trustee/admin expense caps disappear under
 *      acceleration (PPM 10(b)); those fees pay uncapped at step (B)/(C).
 *
 *   4. Deferred interest stops PIK-ing. C/D/E/F unpaid interest is a cumulative
 *      shortfall that feeds the principal-side absorption, not capitalized.
 *
 *   5. Irreversible. Once flipped, stays flipped for the remainder of the
 *      projection. Per PPM 10(d) the acceleration can only be rescinded by
 *      Class A supermajority consent — modelled as non-reversible here.
 *
 * Source: `raw.constraints.waterfall.postAcceleration` extraction from the
 * Ares XV PPM (see `ppm.json` section 9 waterfall tables). Text reads:
 *   "(A) taxes + profit → (B) trustee fees uncapped → (C) admin expenses
 *    uncapped → (D) senior mgmt fee → (E) hedge periodic/termination
 *    (non-defaulted) → (F) Class A P+I → (G) Class B P+I pari passu →
 *    (H) Class C I+P sequential → … → (Q) Sub mgmt fee → (T) hedge
 *    defaulted termination → (V) incentive fee if IRR met →
 *    (W) residual to Sub Noteholders"
 */

/** Step kinds drive the executor's dispatch logic. The `bucket` field is
 *  free-form documentation and does NOT need to match `ppm-step-map.ts`'s
 *  engine-bucket naming (that map is for the N1 normal-waterfall harness). */
export type PostAccelStepKind =
  | "senior_expense"  // flat cash deduction: taxes, trustee, admin, senior mgmt, hedge
  | "tranche_pi"      // combined P+I for a tranche (or pari passu group of tranches)
  | "sub_expense"     // sub mgmt fee, defaulted hedge, incentive fee
  | "residual";       // step W — all remaining to Sub Noteholders

export interface PostAccelStep {
  code: string;
  kind: PostAccelStepKind;
  description: string;
  /** For `tranche_pi` steps: class match (by className starts-with, case-insensitive).
   *  A single matching tranche → fully sequential. Multiple matching tranches →
   *  pari passu pro-rata by balance within the group. */
  trancheMatch?: string | string[];
}

export const POST_ACCEL_SEQUENCE: PostAccelStep[] = [
  { code: "A", kind: "senior_expense", description: "Taxes + Profit Amount" },
  { code: "B", kind: "senior_expense", description: "Trustee Fees & Expenses (uncapped)" },
  { code: "C", kind: "senior_expense", description: "Administrative Expenses (uncapped)" },
  { code: "D", kind: "senior_expense", description: "Senior Collateral Management Fee" },
  { code: "E", kind: "senior_expense", description: "Hedge periodic + termination (non-defaulted)" },
  { code: "F", kind: "tranche_pi", description: "Class A P+I (fully sequential)", trancheMatch: "Class A" },
  { code: "G", kind: "tranche_pi", description: "Class B P+I (pari passu pro-rata)", trancheMatch: ["Class B-1", "Class B-2", "Class B"] },
  { code: "H", kind: "tranche_pi", description: "Class C I+P (sequential)", trancheMatch: "Class C" },
  { code: "I", kind: "tranche_pi", description: "Class D I+P (sequential)", trancheMatch: "Class D" },
  { code: "J", kind: "tranche_pi", description: "Class E I+P (sequential)", trancheMatch: "Class E" },
  { code: "K", kind: "tranche_pi", description: "Class F I+P (sequential)", trancheMatch: "Class F" },
  { code: "Q", kind: "sub_expense", description: "Sub Collateral Management Fee" },
  { code: "T", kind: "sub_expense", description: "Hedge defaulted termination" },
  { code: "V", kind: "sub_expense", description: "Incentive fee (if IRR hurdle met)" },
  { code: "W", kind: "residual", description: "Residual to Sub Noteholders" },
];
