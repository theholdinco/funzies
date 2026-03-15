export const RATING_BUCKETS = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "NR"] as const;
export type RatingBucket = typeof RATING_BUCKETS[number];

// Moody's historical 1Y average default rates
export const DEFAULT_RATES_BY_RATING: Record<RatingBucket, number> = {
  AAA: 0.00,
  AA: 0.02,
  A: 0.06,
  BBB: 0.18,
  BB: 1.06,
  B: 3.41,
  CCC: 10.28,
  NR: 2.00,
};

const MOODYS_MAP: Record<string, RatingBucket> = {
  aaa: "AAA",
  aa1: "AA", aa2: "AA", aa3: "AA",
  a1: "A", a2: "A", a3: "A",
  baa1: "BBB", baa2: "BBB", baa3: "BBB",
  ba1: "BB", ba2: "BB", ba3: "BB",
  b1: "B", b2: "B", b3: "B",
  caa1: "CCC", caa2: "CCC", caa3: "CCC",
  ca: "CCC", c: "CCC",
};

const SP_FITCH_MAP: Record<string, RatingBucket> = {
  aaa: "AAA",
  "aa+": "AA", aa: "AA", "aa-": "AA",
  "a+": "A", a: "A", "a-": "A",
  "bbb+": "BBB", bbb: "BBB", "bbb-": "BBB",
  "bb+": "BB", bb: "BB", "bb-": "BB",
  "b+": "B", b: "B", "b-": "B",
  "ccc+": "CCC", ccc: "CCC", "ccc-": "CCC",
  "cc+": "CCC", cc: "CCC", "cc-": "CCC",
  c: "CCC", d: "CCC",
};

function tryMap(rating: string | null, map: Record<string, RatingBucket>): RatingBucket | null {
  if (!rating || !rating.trim()) return null;
  return map[rating.trim().toLowerCase()] ?? null;
}

export function mapToRatingBucket(
  moodys: string | null,
  sp: string | null,
  fitch: string | null,
  composite: string | null
): RatingBucket {
  return (
    tryMap(moodys, MOODYS_MAP) ??
    tryMap(sp, SP_FITCH_MAP) ??
    tryMap(fitch, SP_FITCH_MAP) ??
    tryMap(composite, { ...MOODYS_MAP, ...SP_FITCH_MAP }) ??
    "NR"
  );
}
