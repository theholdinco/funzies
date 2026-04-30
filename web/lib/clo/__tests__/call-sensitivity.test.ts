/**
 * Call-sensitivity grid — post-v6 plan §5.3.
 *
 * 4 dates × 2 modes = 8 cells (default). Validates:
 *  - default callDates derive from optionalRedemptionDate (annual offsets)
 *  - explicit callDates override the default
 *  - market-mode missing prices propagate as per-cell errors, not throws
 *  - par mode IRR is computed on every supplied date (no holdings prereq)
 */

import { describe, it, expect } from "vitest";
import { callSensitivityGrid } from "../services/call-sensitivity";
import { addQuarters } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

describe("Call-sensitivity grid (post-v6 plan §5.3)", () => {
  it("default: 4 dates × 2 modes = 8 cells when optionalRedemptionDate provided", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    // Pure par-only sweep (skip market) — keeps test off the holdings dependency.
    const cells = callSensitivityGrid(inputs, {
      optionalRedemptionDate: "2027-04-15",
      callPriceModes: ["par"],
    });
    expect(cells).toHaveLength(4);
    expect(cells[0].callDate).toBe("2027-04-15");
    expect(cells[1].callDate).toBe(addQuarters("2027-04-15", 4));
    expect(cells[2].callDate).toBe(addQuarters("2027-04-15", 8));
    expect(cells[3].callDate).toBe(addQuarters("2027-04-15", 12));
    cells.forEach((c) => {
      expect(c.callPriceMode).toBe("par");
      expect(c.error).toBeNull();
      expect(c.irr).not.toBeNull();
    });
  });

  it("throws if optionalRedemptionDate is null and no explicit callDates supplied", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    expect(() => callSensitivityGrid(inputs, { callPriceModes: ["par"] })).toThrowError(
      /Cannot derive default callDates/,
    );
  });

  it("explicit callDates override the default derivation", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const explicit = ["2028-01-15", "2029-01-15"];
    const cells = callSensitivityGrid(inputs, {
      callDates: explicit,
      callPriceModes: ["par"],
    });
    expect(cells.map((c) => c.callDate)).toEqual(explicit);
  });

  it("market mode without holdings → per-cell market_price_missing error (does not abort grid)", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const cells = callSensitivityGrid(inputs, {
      callDates: ["2028-01-15"],
      callPriceModes: ["par", "market"],
    });
    expect(cells).toHaveLength(2);
    const par = cells.find((c) => c.callPriceMode === "par")!;
    const market = cells.find((c) => c.callPriceMode === "market")!;
    expect(par.error).toBeNull();
    expect(par.irr).not.toBeNull();
    expect(market.error).toBe("market_price_missing");
    expect(market.irr).toBeNull();
  });

  it("default callPriceModes = par + market (cartesian product)", () => {
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(2),
      cprPct: 5,
    });
    const cells = callSensitivityGrid(inputs, {
      optionalRedemptionDate: "2027-04-15",
    });
    expect(cells).toHaveLength(8);
    const dates = new Set(cells.map((c) => c.callDate));
    const modes = new Set(cells.map((c) => c.callPriceMode));
    expect(dates.size).toBe(4);
    expect(modes).toEqual(new Set(["par", "market"]));
  });
});
