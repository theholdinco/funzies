import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({ body, init }),
  },
}));
vi.mock("@/lib/auth-helpers", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/clo/access", () => ({ getProfileForUser: vi.fn() }));
vi.mock("@/lib/clo/buy-list", () => ({
  clearBuyList: vi.fn(),
  getBuyListForProfile: vi.fn(),
  replaceBuyList: vi.fn(),
}));

let parseCsv: typeof import("./route").parseCsv;

beforeAll(async () => {
  ({ parseCsv } = await import("./route"));
});

describe("buy-list CSV parsing", () => {
  it("rejects malformed schedule numeric fields instead of dropping them", () => {
    expect(() =>
      parseCsv("obligor,accrued_interest\nBad Accrued,($100)\n"),
    ).toThrow(/invalid numeric value for accrued_interest/i);

    expect(() =>
      parseCsv("obligor,payment_period,asset_payment_interval_months\nBad Interval,3 Months,quarterly\n"),
    ).toThrow(/invalid numeric value for asset_payment_interval_months/i);
  });

  it("keeps supported raw payment period backfill when numeric interval is blank", () => {
    const [item] = parseCsv("obligor,payment_period,asset_payment_interval_months\nGood Interval,3 Months,\n");

    expect(item.assetPaymentPeriodRaw).toBe("3 Months");
    expect(item.assetPaymentIntervalMonths).toBe(3);
  });
});
