/**
 * Event of Default denominator — pari-passu summing branch.
 *
 * Merge-blocker fix to PR C.1 generalized the engine's EoD denominator (PPM
 * 10(a)(iv)) from a string match `tranches.find(t => t.className === "Class A")`
 * to a seniority-rank-based selection that sums all rated debt at the
 * minimum seniorityRank. The pari-passu summing branch fires when more than
 * one debt tranche shares rank 1 (e.g., A-1 / A-2).
 *
 * Synthetic-fixtures #10 exercises the single-tranche-at-rank-1 case; this
 * test pins the pari-passu summing semantic that the rank 1 := A-1 + A-2
 * generalization implies.
 *
 * What this test pins:
 *  - Both rank-1 balances are summed into the EoD denominator
 *  - The summed denominator is what determines whether the test fails
 *  - Behavior diverges from a hypothetical "first rank-1 tranche only"
 *    implementation when balances differ between A-1 and A-2
 *
 * What this test does NOT pin:
 *  - Whether PPM 10(a)(iv) language for any specific deal mandates
 *    summing both rank-1 classes vs taking only the controlling-class
 *    designate. Deal-by-deal PPM language varies; the engine's summing
 *    semantic is the modeling choice the resolver hands it. This test
 *    documents that choice without claiming PPM-correctness for a
 *    particular deal.
 */

import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

describe("EoD denominator — pari-passu rank-1 summing", () => {
  it("two debt tranches at rank 1 sum balances into the denominator", () => {
    // A-1: 35M, A-2: 25M, total senior rank-1 par = 60M.
    // Pool 100M, no principal cash → numerator 100M.
    // Ratio = 100M / 60M = 166.67% → fails trigger 200, accelerates.
    const inputs = makeInputs({
      tranches: [
        { className: "A-1", currentBalance: 35_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "A-2", currentBalance: 25_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "B", currentBalance: 10_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 30_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [
        { className: "A-1", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 110, rank: 2 },
      ],
      icTriggers: [
        { className: "A-1", triggerLevel: 130, rank: 1 },
        { className: "B", triggerLevel: 110, rank: 2 },
      ],
      eventOfDefaultTest: { triggerLevel: 200 },
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    expect(result.initialState.eodTest).not.toBeNull();
    const eod = result.initialState.eodTest!;
    // Denominator should equal the SUM of the two rank-1 balances, not just one.
    expect(eod.denominator).toBeCloseTo(60_000_000, 0);
    // Ratio is ~166.7% (numerator includes WAS-bearing pool); fails trigger 200.
    expect(eod.actualPct).toBeLessThan(200);
    expect(eod.passing).toBe(false);
    // Engine accelerates — at least one period flips to the post-acceleration branch.
    expect(result.periods.some((p) => p.isAccelerated)).toBe(true);
  });

  it("denominator changes when rank-1 set composition changes", () => {
    // Compare two fixtures that differ only in rank-1 composition. The
    // summing semantic predicts: A-1=35M alone → denom 35M; A-1=35M + A-2=25M → denom 60M.
    // A larger denominator → smaller ratio → easier to fail the EoD test.
    const single = runProjection(
      makeInputs({
        tranches: [
          { className: "A-1", currentBalance: 35_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
          { className: "B", currentBalance: 10_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
          { className: "Sub", currentBalance: 55_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [
          { className: "A-1", triggerLevel: 130, rank: 1 },
          { className: "B", triggerLevel: 110, rank: 2 },
        ],
        icTriggers: [
          { className: "A-1", triggerLevel: 130, rank: 1 },
          { className: "B", triggerLevel: 110, rank: 2 },
        ],
        eventOfDefaultTest: { triggerLevel: 200 },
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    const split = runProjection(
      makeInputs({
        tranches: [
          { className: "A-1", currentBalance: 35_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
          { className: "A-2", currentBalance: 25_000_000, spreadBps: 130, seniorityRank: 1, isFloating: true, isIncomeNote: false, isDeferrable: false },
          { className: "B", currentBalance: 10_000_000, spreadBps: 250, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
          { className: "Sub", currentBalance: 30_000_000, spreadBps: 0, seniorityRank: 3, isFloating: false, isIncomeNote: true, isDeferrable: false },
        ],
        ocTriggers: [
          { className: "A-1", triggerLevel: 130, rank: 1 },
          { className: "B", triggerLevel: 110, rank: 2 },
        ],
        icTriggers: [
          { className: "A-1", triggerLevel: 130, rank: 1 },
          { className: "B", triggerLevel: 110, rank: 2 },
        ],
        eventOfDefaultTest: { triggerLevel: 200 },
        defaultRatesByRating: uniformRates(2),
        cprPct: 5,
      }),
    );
    const singleDenom = single.initialState.eodTest!.denominator;
    const splitDenom = split.initialState.eodTest!.denominator;
    expect(singleDenom).toBeCloseTo(35_000_000, 0);
    expect(splitDenom).toBeCloseTo(60_000_000, 0);
    expect(splitDenom).toBeGreaterThan(singleDenom);
  });

  it("rank-1 selection ignores non-debt (income note) tranches", () => {
    // Construct a degenerate case: a Sub note placed at seniorityRank 1
    // (unusual but possible in malformed inputs). The EoD denom should
    // still ignore it because it's `isIncomeNote: true`.
    const inputs = makeInputs({
      tranches: [
        { className: "A", currentBalance: 50_000_000, spreadBps: 130, seniorityRank: 2, isFloating: true, isIncomeNote: false, isDeferrable: false },
        { className: "Sub", currentBalance: 20_000_000, spreadBps: 0, seniorityRank: 1, isFloating: false, isIncomeNote: true, isDeferrable: false },
      ],
      ocTriggers: [{ className: "A", triggerLevel: 130, rank: 1 }],
      icTriggers: [{ className: "A", triggerLevel: 130, rank: 1 }],
      eventOfDefaultTest: { triggerLevel: 200 },
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const result = runProjection(inputs);
    // Denom should be Class A's 50M, NOT the Sub's 20M, even though Sub
    // is at lower seniorityRank.
    expect(result.initialState.eodTest!.denominator).toBeCloseTo(50_000_000, 0);
  });
});
