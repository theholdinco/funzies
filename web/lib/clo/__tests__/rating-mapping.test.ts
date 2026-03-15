import { describe, it, expect } from "vitest";
import { mapToRatingBucket, DEFAULT_RATES_BY_RATING, RATING_BUCKETS } from "../rating-mapping";

describe("mapToRatingBucket", () => {
  it("maps Moody's ratings to buckets", () => {
    expect(mapToRatingBucket("Aaa", null, null, null)).toBe("AAA");
    expect(mapToRatingBucket("Aa1", null, null, null)).toBe("AA");
    expect(mapToRatingBucket("Aa2", null, null, null)).toBe("AA");
    expect(mapToRatingBucket("Aa3", null, null, null)).toBe("AA");
    expect(mapToRatingBucket("A1", null, null, null)).toBe("A");
    expect(mapToRatingBucket("A2", null, null, null)).toBe("A");
    expect(mapToRatingBucket("A3", null, null, null)).toBe("A");
    expect(mapToRatingBucket("Baa1", null, null, null)).toBe("BBB");
    expect(mapToRatingBucket("Baa2", null, null, null)).toBe("BBB");
    expect(mapToRatingBucket("Baa3", null, null, null)).toBe("BBB");
    expect(mapToRatingBucket("Ba1", null, null, null)).toBe("BB");
    expect(mapToRatingBucket("Ba2", null, null, null)).toBe("BB");
    expect(mapToRatingBucket("Ba3", null, null, null)).toBe("BB");
    expect(mapToRatingBucket("B1", null, null, null)).toBe("B");
    expect(mapToRatingBucket("B2", null, null, null)).toBe("B");
    expect(mapToRatingBucket("B3", null, null, null)).toBe("B");
    expect(mapToRatingBucket("Caa1", null, null, null)).toBe("CCC");
    expect(mapToRatingBucket("Caa2", null, null, null)).toBe("CCC");
    expect(mapToRatingBucket("Caa3", null, null, null)).toBe("CCC");
    expect(mapToRatingBucket("Ca", null, null, null)).toBe("CCC");
    expect(mapToRatingBucket("C", null, null, null)).toBe("CCC");
  });

  it("maps S&P ratings to buckets", () => {
    expect(mapToRatingBucket(null, "AAA", null, null)).toBe("AAA");
    expect(mapToRatingBucket(null, "AA+", null, null)).toBe("AA");
    expect(mapToRatingBucket(null, "AA", null, null)).toBe("AA");
    expect(mapToRatingBucket(null, "AA-", null, null)).toBe("AA");
    expect(mapToRatingBucket(null, "A+", null, null)).toBe("A");
    expect(mapToRatingBucket(null, "BBB-", null, null)).toBe("BBB");
    expect(mapToRatingBucket(null, "BB+", null, null)).toBe("BB");
    expect(mapToRatingBucket(null, "B-", null, null)).toBe("B");
    expect(mapToRatingBucket(null, "CCC+", null, null)).toBe("CCC");
    expect(mapToRatingBucket(null, "CCC", null, null)).toBe("CCC");
    expect(mapToRatingBucket(null, "CC", null, null)).toBe("CCC");
    expect(mapToRatingBucket(null, "D", null, null)).toBe("CCC");
  });

  it("uses Moody's first, then S&P, then Fitch, then composite", () => {
    expect(mapToRatingBucket("B1", "BB+", "A+", "BBB")).toBe("B");
    expect(mapToRatingBucket(null, "BB+", "A+", "BBB")).toBe("BB");
    expect(mapToRatingBucket(null, null, "A+", "BBB")).toBe("A");
    expect(mapToRatingBucket(null, null, null, "BBB")).toBe("BBB");
  });

  it("maps unrecognizable strings to NR", () => {
    expect(mapToRatingBucket("WR", null, null, null)).toBe("NR");
    expect(mapToRatingBucket("NR", null, null, null)).toBe("NR");
    expect(mapToRatingBucket(null, "NR", null, null)).toBe("NR");
    expect(mapToRatingBucket(null, null, null, null)).toBe("NR");
    expect(mapToRatingBucket("", "", "", "")).toBe("NR");
  });

  it("handles case-insensitive matching", () => {
    expect(mapToRatingBucket("baa1", null, null, null)).toBe("BBB");
    expect(mapToRatingBucket(null, "bbb+", null, null)).toBe("BBB");
  });
});

describe("DEFAULT_RATES_BY_RATING", () => {
  it("has an entry for every bucket", () => {
    for (const bucket of RATING_BUCKETS) {
      expect(DEFAULT_RATES_BY_RATING[bucket]).toBeDefined();
      expect(typeof DEFAULT_RATES_BY_RATING[bucket]).toBe("number");
    }
  });
});
