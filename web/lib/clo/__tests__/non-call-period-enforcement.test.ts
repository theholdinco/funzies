/**
 * Non-call period and past-date enforcement on `optionalRedemption`
 * callDate.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Purpose: pin the three-layer gate that refuses economically-incoherent
 * call dates. PPM Condition 7.2 prohibits a call before the Non-Call
 * Period End; "calling in the past" is meaningless under any economic
 * convention. Both shapes were silent on user error before — the engine
 * floored to one quarter and produced absurd IRRs.
 *
 * Cases pin the design:
 *
 *   (1) Engine throws InvalidCallDateError(reason="preNcp") when callDate
 *       is strictly before nonCallPeriodEnd.
 *
 *   (2) Engine throws InvalidCallDateError(reason="past") when callDate
 *       is strictly before currentDate. No override — calling in the
 *       past is never a meaningful scenario.
 *
 *   (3) Engine accepts when nonCallPeriodEnd is null/undefined (gate
 *       skipped). The canonical user path through buildFromResolved
 *       blocks at the resolver layer when NCP is missing on a CLO; this
 *       case covers synthetic test fixtures that have no NCP to enforce.
 *
 *   (4) Engine accepts callDate > maturityDate. The engine's
 *       Math.min(callQuarters, maturityQuarters) handles this gracefully
 *       (deal matures naturally; call is irrelevant). Not a refusable
 *       case — locks against a future regression that adds a spurious
 *       throw here.
 *
 *   (5) Service `applyOptionalRedemptionCall` (three sub-cases): throws
 *       InvalidCallDateError(reason="preNcp") on pre-NCP, throws
 *       InvalidCallDateError(reason="past") on past, accepts a forward
 *       post-NCP date without throwing.
 *
 *   (6) Priority ordering: when callDate is BOTH past AND pre-NCP (i.e.
 *       callDate < currentDate < nonCallPeriodEnd), the past check fires
 *       first. Locks the documented priority against a future refactor
 *       that accidentally inverts the order — partner debugging an
 *       invalid date gets the most-actionable diagnostic ("the date is
 *       in the past") rather than a derived one ("you were also pre-NCP,
 *       but had you not been past, the next year still would not work").
 *
 * The resolver-side promotion of missing NCP to a blocking warning (which
 * closes the silent-fallback hole that would otherwise let a deal with no
 * extracted NCP skip the engine gate by virtue of `nonCallPeriodEnd=null`)
 * is pinned in `blocking-extraction-failures.test.ts` per the canonical-
 * inventory convention for blocking-warning sites.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from "vitest";
import {
  runProjection,
  InvalidCallDateError,
  type ProjectionInputs,
} from "@/lib/clo/projection";
import {
  applyOptionalRedemptionCall,
  deriveNoCallBaseInputs,
} from "@/lib/clo/services/no-call-baseline";
import { makeInputs, uniformRates } from "./test-helpers";

// makeInputs's currentDate default is "2026-03-09".
const FIXTURE_CURRENT_DATE = "2026-03-09";

// =============================================================================
// Case 1 — engine throws on pre-NCP callDate
// =============================================================================

describe("Engine refuses pre-NCP callDate", () => {
  it("callMode=optionalRedemption + callDate < nonCallPeriodEnd → InvalidCallDateError(preNcp)", () => {
    const inputs: ProjectionInputs = {
      ...makeInputs({
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
      callMode: "optionalRedemption",
      callDate: "2027-01-15",
      nonCallPeriodEnd: "2028-06-15",
    };

    let captured: unknown = null;
    try {
      runProjection(inputs);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(InvalidCallDateError);
    const err = captured as InvalidCallDateError;
    expect(err.reason).toBe("preNcp");
    expect(err.callDate).toBe("2027-01-15");
    expect(err.nonCallPeriodEnd).toBe("2028-06-15");
    expect(err.message).toMatch(/Condition 7\.2|pre-NCP/);
  });
});

// =============================================================================
// Case 2 — engine throws on past callDate (no override)
// =============================================================================

describe("Engine refuses past callDate", () => {
  it("callMode=optionalRedemption + callDate < currentDate → InvalidCallDateError(past)", () => {
    const inputs: ProjectionInputs = {
      ...makeInputs({}),
      callMode: "optionalRedemption",
      callDate: "2020-01-15", // far in the past
      // currentDate from makeInputs default = "2026-03-09"
    };

    let captured: unknown = null;
    try {
      runProjection(inputs);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(InvalidCallDateError);
    const err = captured as InvalidCallDateError;
    expect(err.reason).toBe("past");
    expect(err.callDate).toBe("2020-01-15");
    expect(err.currentDate).toBe(FIXTURE_CURRENT_DATE);
    expect(err.message).toMatch(/before currentDate|past is not a meaningful/);
  });
});

// =============================================================================
// Case 3 — engine accepts when nonCallPeriodEnd is null (gate skipped)
// =============================================================================

describe("Engine accepts pre-NCP-shaped date when NCP is null (gate skipped)", () => {
  it("callMode=optionalRedemption + callDate forward + nonCallPeriodEnd=null → runs to completion", () => {
    const inputs: ProjectionInputs = {
      ...makeInputs({
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
      callMode: "optionalRedemption",
      callDate: "2028-01-15", // forward, no NCP to refuse against
      nonCallPeriodEnd: null,
    };

    const result = runProjection(inputs);
    expect(result.equityIrr).not.toBeNull();
  });
});

// =============================================================================
// Case 4 — engine accepts callDate > maturityDate (Math.min handles it)
// =============================================================================

describe("Engine accepts callDate beyond maturity (deal matures naturally)", () => {
  it("callMode=optionalRedemption + callDate > maturityDate → runs to natural maturity", () => {
    // makeInputs default maturity = "2034-06-15"
    const inputs: ProjectionInputs = {
      ...makeInputs({
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
      callMode: "optionalRedemption",
      callDate: "2050-01-15", // far past maturity
      nonCallPeriodEnd: null,
    };

    expect(() => runProjection(inputs)).not.toThrow();
    const callResult = runProjection(inputs);

    // Engine should produce same result as no-call run since the call
    // never fires (call quarters > maturity quarters → totalQuarters
    // bounded by maturity).
    const noCallInputs: ProjectionInputs = { ...inputs, callMode: "none", callDate: null };
    const noCallResult = runProjection(noCallInputs);
    if (callResult.equityIrr != null && noCallResult.equityIrr != null) {
      expect(callResult.equityIrr).toBeCloseTo(noCallResult.equityIrr, 10);
    }
  });

  it("callDate after legal maturity in the same regular payment bucket does not extend maturity", () => {
    const inputs: ProjectionInputs = {
      ...makeInputs({
        defaultRatesByRating: uniformRates(0),
        cprPct: 0,
        maturityDate: "2026-05-09",
      }),
      callMode: "optionalRedemption",
      callDate: "2026-06-01",
      nonCallPeriodEnd: null,
    };

    const result = runProjection(inputs);
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].date).toBe("2026-05-09");
  });
});

// =============================================================================
// Case 5 — service `applyOptionalRedemptionCall` throws InvalidCallDateError
// =============================================================================

describe("Service-layer validation (applyOptionalRedemptionCall)", () => {
  it("applyOptionalRedemptionCall(_, preNcpDate, bounds) → InvalidCallDateError(preNcp)", () => {
    const baseline = deriveNoCallBaseInputs(makeInputs({}));

    let captured: unknown = null;
    try {
      applyOptionalRedemptionCall(baseline, "2027-01-15", {
        currentDate: "2026-03-09",
        nonCallPeriodEnd: "2028-06-15",
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(InvalidCallDateError);
    const err = captured as InvalidCallDateError;
    expect(err.reason).toBe("preNcp");
    expect(err.callDate).toBe("2027-01-15");
    expect(err.currentDate).toBe("2026-03-09");
    expect(err.nonCallPeriodEnd).toBe("2028-06-15");
  });

  it("applyOptionalRedemptionCall(_, pastDate, bounds) → InvalidCallDateError(past)", () => {
    const baseline = deriveNoCallBaseInputs(makeInputs({}));

    let captured: unknown = null;
    try {
      applyOptionalRedemptionCall(baseline, "2020-01-15", {
        currentDate: "2026-03-09",
        nonCallPeriodEnd: "2028-06-15",
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(InvalidCallDateError);
    const err = captured as InvalidCallDateError;
    expect(err.reason).toBe("past");
    expect(err.callDate).toBe("2020-01-15");
  });

  it("applyOptionalRedemptionCall accepts a forward post-NCP date without throwing", () => {
    const baseline = deriveNoCallBaseInputs(makeInputs({}));
    const result = applyOptionalRedemptionCall(baseline, "2029-01-15", {
      currentDate: "2026-03-09",
      nonCallPeriodEnd: "2028-06-15",
    });
    expect(result.callMode).toBe("optionalRedemption");
    expect(result.callDate).toBe("2029-01-15");
  });
});

// =============================================================================
// Case 6 — priority: past beats preNcp when both conditions apply
// =============================================================================

describe("Priority: past wins over preNcp when both apply", () => {
  it("callDate < currentDate < nonCallPeriodEnd → InvalidCallDateError(past)", () => {
    // A date that is both past AND pre-NCP. The past diagnostic is more
    // actionable for the user (the year is wrong); preNcp would be derived
    // and misleading once the year is corrected.
    const inputs: ProjectionInputs = {
      ...makeInputs({}),
      callMode: "optionalRedemption",
      callDate: "2020-01-15", // past
      nonCallPeriodEnd: "2028-06-15", // future; gate would fire if we got past the past-check
    };

    let captured: unknown = null;
    try {
      runProjection(inputs);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(InvalidCallDateError);
    expect((captured as InvalidCallDateError).reason).toBe("past");
  });

  it("service-level: same priority — past wins over preNcp", () => {
    const baseline = deriveNoCallBaseInputs(makeInputs({}));
    let captured: unknown = null;
    try {
      applyOptionalRedemptionCall(baseline, "2020-01-15", {
        currentDate: "2026-03-09",
        nonCallPeriodEnd: "2028-06-15",
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(InvalidCallDateError);
    expect((captured as InvalidCallDateError).reason).toBe("past");
  });
});
