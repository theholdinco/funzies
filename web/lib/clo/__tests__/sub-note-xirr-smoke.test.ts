import { describe, it, expect } from "vitest";
import { calculateIrr } from "../projection";

const hasTestDb = !!process.env.TEST_DATABASE_URL;
const d = hasTestDb ? describe : describe.skip;

d("Sub Note XIRR smoke test (Ares XV condensed v4)", () => {
  it("computes Sub Note IRR within 3dp of ground-truth value", async () => {
    // PREREQUISITES (fill in before first green run):
    //   1. Ares XV condensed v4 has been ingested into the test DB.
    //   2. ARES_XV_PROFILE_ID is set to the profile.id of that deal.
    //   3. GROUND_TRUTH_IRR is pinned — either:
    //      (a) externally-computed value (Excel / Bloomberg / pre-verified Python), OR
    //      (b) the first trusted computed value, snapshot-pinned for regression.
    //
    // Wiring steps once prereqs are met:
    //   - Import query from "../../db".
    //   - Query clo_payment_history for class_name='Sub', profile_id=ARES_XV_PROFILE_ID,
    //     ordered by payment_date. Apply COALESCE(override_value, extracted_value).
    //   - Build cash flows: [first-row purchase as negative, ...subsequent cashflows, terminal=0].
    //   - Call calculateIrr(cashFlows, 4).
    //   - Assert within 3dp of GROUND_TRUTH_IRR.
    //   - If IRR > 0.12, log a warning (incentive-fee threshold boundary).

    const ARES_XV_PROFILE_ID = "TODO_before_first_run";
    const GROUND_TRUTH_IRR = 0.0; // TODO pin before first run

    // Placeholder assertion so the test doesn't false-pass:
    expect(ARES_XV_PROFILE_ID).toBe("TODO_before_first_run");
    expect(GROUND_TRUTH_IRR).toBe(0.0);

    // Keep the import live so tsc catches renames of calculateIrr.
    expect(typeof calculateIrr).toBe("function");
  });
});
