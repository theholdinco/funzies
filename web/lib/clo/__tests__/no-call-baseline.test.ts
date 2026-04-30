/**
 * Helper test for the no-call baseline derivation.
 *
 * Pins the centralized "no-call" semantic so any future consumer that
 * skips the helper (or any change to the helper itself) breaks loudly
 * instead of silently shifting label semantics in the UI.
 */

import { describe, it, expect } from "vitest";
import { runProjection, type ProjectionInputs } from "../projection";
import {
  deriveNoCallBaseInputs,
  applyOptionalRedemptionCall,
} from "../services/no-call-baseline";
import { makeInputs, uniformRates } from "./test-helpers";

describe("deriveNoCallBaseInputs", () => {
  it("forces callMode to 'none' even when input has optionalRedemption set", () => {
    const inputs: ProjectionInputs = makeInputs({
      callMode: "optionalRedemption",
      callDate: "2028-01-15",
      callPriceMode: "manual",
      callPricePct: 95,
    });
    const baseline = deriveNoCallBaseInputs(inputs);
    expect(baseline.callMode).toBe("none");
    expect(baseline.callDate).toBeNull();
  });

  it("strips equityEntryPrice if present", () => {
    const inputs = makeInputs({}) as ProjectionInputs & { equityEntryPrice?: number };
    const augmented = { ...inputs, equityEntryPrice: 12_345_678 };
    const baseline = deriveNoCallBaseInputs(augmented);
    expect("equityEntryPrice" in baseline).toBe(false);
  });

  it("preserves all non-call, non-entry-price fields", () => {
    const inputs = makeInputs({
      cprPct: 7,
      recoveryPct: 42,
      callMode: "optionalRedemption",
      callDate: "2028-01-15",
    });
    const baseline = deriveNoCallBaseInputs(inputs);
    expect(baseline.cprPct).toBe(7);
    expect(baseline.recoveryPct).toBe(42);
    expect(baseline.tranches).toEqual(inputs.tranches);
    expect(baseline.loans).toEqual(inputs.loans);
  });

  it("running the engine on baseline produces same result regardless of input callMode", () => {
    // The whole point: two inputs that differ only in callMode/callDate
    // produce identical baselines, hence identical engine output.
    const a = makeInputs({ callMode: "none", callDate: null });
    const b = makeInputs({
      callMode: "optionalRedemption",
      callDate: "2028-01-15",
      callPriceMode: "manual",
      callPricePct: 90,
    });
    const baselineA = deriveNoCallBaseInputs(a);
    const baselineB = deriveNoCallBaseInputs(b);
    const resultA = runProjection(baselineA);
    const resultB = runProjection(baselineB);
    expect(resultB.equityIrr).toBe(resultA.equityIrr);
    expect(resultB.totalEquityDistributions).toBeCloseTo(resultA.totalEquityDistributions, 2);
  });
});

describe("applyOptionalRedemptionCall", () => {
  it("sets callMode to optionalRedemption + callDate, callPriceMode 'par' at 100%", () => {
    const baseline = deriveNoCallBaseInputs(makeInputs({}));
    const withCall = applyOptionalRedemptionCall(baseline, "2029-04-15");
    expect(withCall.callMode).toBe("optionalRedemption");
    expect(withCall.callDate).toBe("2029-04-15");
    expect(withCall.callPriceMode).toBe("par");
    expect(withCall.callPricePct).toBe(100);
  });

  it("preserves all other fields from the baseline", () => {
    const baseline = deriveNoCallBaseInputs(makeInputs({ cprPct: 11, recoveryPct: 60 }));
    const withCall = applyOptionalRedemptionCall(baseline, "2029-04-15");
    expect(withCall.cprPct).toBe(11);
    expect(withCall.recoveryPct).toBe(60);
  });

  it("with-call run produces different IRR than no-call baseline (when call is in horizon)", () => {
    const baseline = deriveNoCallBaseInputs(
      makeInputs({
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    const withCall = applyOptionalRedemptionCall(baseline, "2028-01-15");
    const noCallResult = runProjection(baseline);
    const withCallResult = runProjection(withCall);
    // The two runs should not produce identical IRRs — the call truncates
    // the projection. (Direction is deal-dependent; magnitude > 1bp.)
    expect(withCallResult.equityIrr).not.toBe(noCallResult.equityIrr);
    if (noCallResult.equityIrr != null && withCallResult.equityIrr != null) {
      expect(Math.abs(withCallResult.equityIrr - noCallResult.equityIrr)).toBeGreaterThan(0.0001);
    }
  });
});
