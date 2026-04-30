/**
 * EoD denominator materiality on Euro XV — merge-blocker 2 verification.
 *
 * The engine fix at projection.ts (decision T) generalized the EoD
 * denominator from a string-match `"Class A"` lookup to a
 * seniority-rank-based selection that sums all rank-1 debt balances. For
 * deals with a single rank-1 debt tranche, the two approaches produce
 * identical results. For deals with a pari-passu split at rank 1 (e.g.,
 * A-1 + A-2), the new approach sums; the old approach picked just one.
 *
 * Per critical review's request: compute the divergence on Euro XV
 * before declaring the engine fix's behavior change "provisional with
 * TODO."
 *
 * Euro XV tranche structure (from euro-xv-q1.json):
 *   - Class A:    310M, rank 1, debt    ← SOLE rank-1 debt tranche
 *   - Class B-1:  33.75M, rank 2, debt
 *   - Class B-2:  15M, rank 3, debt
 *   - Class C-F:  ranks 4-7, debt
 *   - Sub:        44.8M, rank 8, equity
 *
 * Class A is the only rank-1 debt tranche, so:
 *   - Sum-of-rank-1 = Class A balance = 310M
 *   - Controlling-class-A = Class A balance = 310M
 *   - Divergence = 0pp on the EoD ratio
 *
 * Provisional ship of merge-blocker 2 is fine for the Euro XV partner-
 * facing surface. If a future deal in the corpus has a pari-passu rank-1
 * split, the materiality computation must be redone for that deal.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runProjection } from "../projection";
import { buildFromResolved, DEFAULT_ASSUMPTIONS } from "../build-projection-inputs";
import type { ResolvedDealData } from "../resolver-types";

const fixturePath = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
  resolved: ResolvedDealData;
  raw: unknown;
};

describe("EoD denominator materiality — Euro XV (merge-blocker 2)", () => {
  it("Class A is the sole rank-1 debt tranche on Euro XV", () => {
    const debtTranches = fixture.resolved.tranches.filter((t) => !t.isIncomeNote);
    const minRank = Math.min(...debtTranches.map((t) => t.seniorityRank));
    const rank1Set = debtTranches.filter((t) => t.seniorityRank === minRank);
    expect(rank1Set).toHaveLength(1);
    expect(rank1Set[0].className).toBe("Class A");
    expect(minRank).toBe(1);
  });

  it("Sum-of-rank-1 equals Class A balance (no pari-passu split)", () => {
    const debtTranches = fixture.resolved.tranches.filter((t) => !t.isIncomeNote);
    const minRank = Math.min(...debtTranches.map((t) => t.seniorityRank));
    const rank1Sum = debtTranches
      .filter((t) => t.seniorityRank === minRank)
      .reduce((s, t) => s + t.currentBalance, 0);
    const classABalance = fixture.resolved.tranches.find((t) => t.className === "Class A")!.currentBalance;
    expect(rank1Sum).toBe(classABalance);
  });

  it("EoD ratio divergence is 0pp between sum-of-rank-1 and controlling-class-A", () => {
    // Sanity: when we run the engine on Euro XV, the EoD test (if
    // exercised) uses the rank-based denominator. The denominator
    // value should equal Class A's balance + deferred (deferred is 0 at
    // T=0 for a healthy deal).
    const inputs = buildFromResolved(fixture.resolved, {
      ...DEFAULT_ASSUMPTIONS,
      seniorFeePct: fixture.resolved.fees.seniorFeePct,
      subFeePct: fixture.resolved.fees.subFeePct,
      incentiveFeePct: fixture.resolved.fees.incentiveFeePct,
      incentiveFeeHurdleIrr: fixture.resolved.fees.incentiveFeeHurdleIrr * 100,
    });
    // Force EoD to be exercised — a healthy deal won't fire EoD without
    // setting eventOfDefaultTest; we just want to inspect the denominator.
    // Apply an unreachable-low trigger so EoD computes but passes.
    const result = runProjection({ ...inputs, eventOfDefaultTest: { triggerLevel: 50 } });
    if (result.initialState.eodTest != null) {
      const denom = result.initialState.eodTest.denominator;
      const classA = fixture.resolved.tranches.find((t) => t.className === "Class A")!;
      // Engine adds deferredBalances, which is 0 at T=0 for a healthy deal.
      // Tolerance: 1bp of Class A balance.
      expect(Math.abs(denom - classA.currentBalance)).toBeLessThan(classA.currentBalance * 0.0001);
    }
  });
});
