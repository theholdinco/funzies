/**
 * Pure unit tests for the conservative-side encoding helpers used by the
 * hero-card comparison cells (Forward IRR + Mark-to-model).
 *
 * Replaces the prior `SideBySideIrr.test.tsx` render tests, which pinned
 * a React component that no longer reaches the production UI. The
 * encoding logic is now layout-agnostic; testing the pure functions
 * here closes the coverage gap left when the component was deleted.
 */

import { describe, it, expect } from "vitest";
import { compareConservative, formatCallDate } from "../comparison-encoding";

describe("compareConservative", () => {
  it("strict less-than → that side gets bold; the other gets dim", () => {
    const r = compareConservative(0.10, 0.15);
    expect(r).toEqual({ aBold: true, bBold: false, aDim: false, bDim: true });
    const flipped = compareConservative(0.15, 0.10);
    expect(flipped).toEqual({ aBold: false, bBold: true, aDim: true, bDim: false });
  });

  it("equal numerics → no bold, no dim (regression: prior fair-value branch dimmed both)", () => {
    const r = compareConservative(0.13, 0.13);
    expect(r).toEqual({ aBold: false, bBold: false, aDim: false, bDim: false });
  });

  it("works for negative numerics (more-negative is conservative)", () => {
    // -10% is "lower" than -1% → -10% is more conservative for the
    // equity holder (worse outcome).
    const r = compareConservative(-0.10, -0.01);
    expect(r.aBold).toBe(true);
    expect(r.bDim).toBe(true);
  });

  it("status string vs numeric → incomparable, all flags false", () => {
    expect(compareConservative("wiped out", 0.05)).toEqual({
      aBold: false, bBold: false, aDim: false, bDim: false,
    });
    expect(compareConservative(0.05, "no forward data")).toEqual({
      aBold: false, bBold: false, aDim: false, bDim: false,
    });
  });

  it("null / undefined → incomparable", () => {
    expect(compareConservative(null, 0.05).aBold).toBe(false);
    expect(compareConservative(0.05, null).bBold).toBe(false);
    expect(compareConservative(undefined, 0.05).aBold).toBe(false);
    expect(compareConservative(0.05, undefined).bBold).toBe(false);
  });

  it("both status strings → incomparable", () => {
    expect(compareConservative("wiped out", "wiped out")).toEqual({
      aBold: false, bBold: false, aDim: false, bDim: false,
    });
  });
});

describe("formatCallDate", () => {
  it("formats mid-month date as 'Mmm 'YY'", () => {
    expect(formatCallDate("2026-04-30")).toBe("Apr '26");
    expect(formatCallDate("2027-12-15")).toBe("Dec '27");
  });

  it("does not roll back at month boundaries (timezone safety)", () => {
    // Regression: `new Date("2027-01-01").toLocaleString({month:"short"})`
    // returns "Dec" in negative-UTC zones because the ISO string is
    // parsed as UTC midnight and shifts back to Dec 31 local. The string-
    // slice implementation reads month/year directly from the ISO and
    // is timezone-independent.
    expect(formatCallDate("2027-01-01")).toBe("Jan '27");
    expect(formatCallDate("2026-12-31")).toBe("Dec '26");
    expect(formatCallDate("2030-01-01")).toBe("Jan '30");
  });

  it("two-digit year is the last two digits of the ISO year", () => {
    expect(formatCallDate("2099-06-15")).toBe("Jun '99");
    expect(formatCallDate("2100-06-15")).toBe("Jun '00");
  });

  it("handles all twelve months", () => {
    const expected = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (let m = 1; m <= 12; m++) {
      const iso = `2026-${String(m).padStart(2, "0")}-15`;
      expect(formatCallDate(iso)).toBe(`${expected[m - 1]} '26`);
    }
  });
});
