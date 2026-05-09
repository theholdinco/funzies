import { describe, expect, it } from "vitest";
import { parseFacilitySizeAmount } from "../facility-size";

describe("parseFacilitySizeAmount", () => {
  it("parses common shorthand without shrinking billions to millions", () => {
    expect(parseFacilitySizeAmount("$500M")).toBe(500_000_000);
    expect(parseFacilitySizeAmount("500 mm")).toBe(500_000_000);
    expect(parseFacilitySizeAmount("1.2bn")).toBe(1_200_000_000);
    expect(parseFacilitySizeAmount("$1.2B")).toBe(1_200_000_000);
    expect(parseFacilitySizeAmount("750k")).toBe(750_000);
  });

  it("keeps fully written amounts as entered", () => {
    expect(parseFacilitySizeAmount("500,000,000")).toBe(500_000_000);
    expect(parseFacilitySizeAmount("EUR 100,000,000")).toBe(100_000_000);
  });
});
