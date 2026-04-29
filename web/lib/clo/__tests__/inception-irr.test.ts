import { describe, it, expect } from "vitest";
import { computeInceptionIrr, type InceptionIrrInput } from "../services/inception-irr";

const SUB_PAR = 10_000_000;
const CLOSING = "2022-01-15";
const CURRENT = "2026-04-01";

function baseInput(overrides: Partial<InceptionIrrInput> = {}): InceptionIrrInput {
  return {
    subNotePar: SUB_PAR,
    equityBookValue: 5_500_000,
    equityWipedOut: false,
    closingDate: CLOSING,
    currentDate: CURRENT,
    userAnchor: null,
    historicalDistributions: [
      { date: "2022-07-15", distribution: 200_000 },
      { date: "2023-01-15", distribution: 300_000 },
      { date: "2023-07-15", distribution: 250_000 },
      { date: "2024-01-15", distribution: 400_000 },
      { date: "2025-01-15", distribution: 350_000 },
    ],
    ...overrides,
  };
}

describe("computeInceptionIrr", () => {
  it("default anchor (closing + 100c) with synthetic 5-distribution stream produces a finite IRR", () => {
    const r = computeInceptionIrr(baseInput());
    expect(r).not.toBeNull();
    expect(r!.primary.isUserOverride).toBe(false);
    expect(r!.primary.anchorDate).toBe(CLOSING);
    expect(r!.primary.anchorPriceCents).toBe(100);
    expect(r!.primary.distributionCount).toBe(5);
    expect(r!.primary.irr).not.toBeNull();
    expect(Number.isFinite(r!.primary.irr!)).toBe(true);
    expect(r!.terminalValue).toBe(5_500_000);
    expect(r!.terminalDate).toBe(CURRENT);
    expect(r!.counterfactual).toBeNull(); // no user override → no counterfactual
    expect(r!.wipedOut).toBe(false);
  });

  it("user anchor override (post-closing date, 95c) — distributions before anchor are filtered out", () => {
    const r = computeInceptionIrr(baseInput({
      userAnchor: { date: "2024-01-15", priceCents: 95 },
    }));
    expect(r).not.toBeNull();
    expect(r!.primary.isUserOverride).toBe(true);
    expect(r!.primary.anchorDate).toBe("2024-01-15");
    expect(r!.primary.anchorPriceCents).toBe(95);
    // Distributions strictly AFTER 2024-01-15 and BEFORE 2026-04-01:
    // only the 2025-01-15 entry qualifies. Distributions on 2024-01-15
    // itself are excluded (strict >).
    expect(r!.primary.distributionCount).toBe(1);
  });

  it("counterfactual is present when user override differs from default", () => {
    const r = computeInceptionIrr(baseInput({
      userAnchor: { date: "2024-04-17", priceCents: 95 },
    }));
    expect(r!.counterfactual).not.toBeNull();
    expect(r!.counterfactual!.anchorDate).toBe(CLOSING);
    expect(r!.counterfactual!.anchorPriceCents).toBe(100);
    expect(r!.counterfactual!.distributionCount).toBe(5); // all distributions match
  });

  it("counterfactual is null when override == default (closing date at 100c)", () => {
    const r = computeInceptionIrr(baseInput({
      userAnchor: { date: CLOSING, priceCents: 100 },
    }));
    // hasUserOverride is true but default == override → counterfactual skipped.
    expect(r!.counterfactual).toBeNull();
  });

  it("terminal value and date come from inputs (not hardcoded)", () => {
    const r = computeInceptionIrr(baseInput({
      equityBookValue: 1_234_567,
      currentDate: "2027-09-15",
    }));
    expect(r!.terminalValue).toBe(1_234_567);
    expect(r!.terminalDate).toBe("2027-09-15");
  });

  it("empty distributions returns sensible result (cost + terminal only)", () => {
    const r = computeInceptionIrr(baseInput({ historicalDistributions: [] }));
    expect(r).not.toBeNull();
    expect(r!.primary.distributionCount).toBe(0);
    // 2-flow series (cost + terminal) — calculateIrrFromDatedCashflows returns
    // a defined IRR for any 2-flow series with one negative + one positive.
    expect(r!.primary.irr).not.toBeNull();
  });

  it("subNotePar <= 0 returns null", () => {
    expect(computeInceptionIrr(baseInput({ subNotePar: 0 }))).toBeNull();
    expect(computeInceptionIrr(baseInput({ subNotePar: -1 }))).toBeNull();
  });

  it("equityWipedOut: true returns wipedOut=true with null IRR", () => {
    const r = computeInceptionIrr(baseInput({
      equityWipedOut: true,
      equityBookValue: 0,
    }));
    expect(r).not.toBeNull();
    expect(r!.wipedOut).toBe(true);
    expect(r!.primary.irr).toBeNull();
    expect(r!.terminalValue).toBe(0);
  });
});
