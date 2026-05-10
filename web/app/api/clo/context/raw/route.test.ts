import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getProfileForUser: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
}));
vi.mock("@/lib/auth-helpers", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/clo/access", () => ({ getProfileForUser: mocks.getProfileForUser }));
vi.mock("@/lib/db", () => ({ getClient: mocks.getClient }));

import { POST } from "./route";

type QueryCall = { sql: string; params?: unknown[] };

const TABLE_COLUMNS: Record<string, string[]> = {
  clo_tranches: ["id", "deal_id", "class_name", "isin", "cusip", "common_code", "current_balance"],
  clo_tranche_snapshots: ["id", "report_period_id", "tranche_id", "current_balance", "spread_bps", "data_source"],
  clo_pool_summary: ["id", "report_period_id", "total_collateral_balance", "data_source"],
  clo_compliance_tests: ["id", "report_period_id", "test_type", "class_name", "actual_pct", "trigger_pct", "data_source"],
  clo_concentrations: ["id", "report_period_id", "concentration_type", "bucket_name", "actual_pct", "limit_pct", "data_source"],
  clo_holdings: ["id", "report_period_id", "obligor_name", "par_balance", "data_source"],
  clo_accruals: ["id", "report_period_id", "loanx_id", "payment_frequency", "accrual_end_date", "data_source"],
  clo_trades: ["id", "report_period_id", "obligor_name", "trade_type", "par_amount", "data_source"],
  clo_waterfall_steps: ["id", "report_period_id", "step_code", "amount", "data_source"],
  clo_account_balances: ["id", "report_period_id", "account_name", "balance", "data_source"],
  clo_par_value_adjustments: ["id", "report_period_id", "adjustment_type", "amount", "data_source"],
  clo_proceeds: ["id", "report_period_id", "proceed_type", "amount", "data_source"],
  clo_extraction_overflow: ["id", "report_period_id", "section_key", "payload", "data_source"],
  clo_trading_summary: ["id", "report_period_id", "total_purchases", "data_source"],
  clo_events: ["id", "deal_id", "report_period_id", "event_type", "event_date", "description", "data_source"],
};

function jsonRequest(body: unknown): Request {
  return { json: async () => body } as Request;
}

function makeClient(options: { failOn?: RegExp } = {}) {
  const calls: QueryCall[] = [];
  const trancheIds = new Set<string>();
  let insertedTrancheSequence = 0;
  const release = vi.fn();

  const client = {
    calls,
    release,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (options.failOn?.test(sql)) throw new Error("snapshot boom");
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (/information_schema\.columns/i.test(sql)) {
        const table = String(params?.[0]);
        return { rows: (TABLE_COLUMNS[table] ?? []).map((column_name) => ({ column_name })) };
      }
      if (/INSERT INTO clo_deals/i.test(sql)) return { rows: [{ id: "deal-1" }] };
      if (/INSERT INTO clo_report_periods/i.test(sql)) return { rows: [{ id: "period-1" }] };
      if (/SELECT id, class_name, isin, cusip, common_code FROM clo_tranches/i.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT INTO clo_tranches/i.test(sql) && /RETURNING id/i.test(sql)) {
        insertedTrancheSequence += 1;
        const id = `new-tranche-${insertedTrancheSequence}`;
        trancheIds.add(id);
        return { rows: [{ id }] };
      }
      if (/SELECT id FROM clo_tranches WHERE deal_id/i.test(sql)) {
        return { rows: Array.from(trancheIds).map((id) => ({ id })) };
      }
      return { rows: [] };
    },
  };

  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
  mocks.getProfileForUser.mockResolvedValue({ id: "profile-1" });
});

describe("POST /api/clo/context/raw", () => {
  it("restores present-null metadata and destructive empty report objects", async () => {
    const client = makeClient();
    mocks.getClient.mockResolvedValue(client);

    const response = await POST(jsonRequest({
      raw: {
        dealDates: {
          reportDate: "2026-03-31",
          paymentDate: null,
        },
        supplementaryData: null,
        tradingSummary: null,
        complianceData: {
          poolSummary: {},
        },
      },
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      dealId: "deal-1",
      reportPeriodId: "period-1",
      counts: {
        poolSummary: 0,
        tradingSummary: 0,
        supplementaryData: 1,
      },
    });
    expect(client.calls.some((call) =>
      /UPDATE clo_report_periods SET payment_date = \$1, supplementary_data = \$2::jsonb/i.test(call.sql) &&
      call.params?.[0] === null &&
      call.params?.[1] === null
    )).toBe(true);
    expect(client.calls.some((call) => /DELETE FROM clo_pool_summary WHERE report_period_id = \$1/i.test(call.sql))).toBe(true);
    expect(client.calls.some((call) => /DELETE FROM clo_trading_summary WHERE report_period_id = \$1/i.test(call.sql))).toBe(true);
    expect(client.calls.map((call) => call.sql)).toContain("COMMIT");
    expect(client.calls.map((call) => call.sql)).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("destructively restores empty arrays and remaps tranche snapshot ids", async () => {
    const client = makeClient();
    mocks.getClient.mockResolvedValue(client);

    const response = await POST(jsonRequest({
      raw: {
        dealDates: { reportDate: "2026-03-31" },
        complianceData: { reportPeriodId: "source-period" },
        tranches: [
          { id: "old-tranche-a", className: "Class A", isin: "XS0001", currentBalance: 100 },
        ],
        trancheSnapshots: [
          { trancheId: "old-tranche-a", currentBalance: 95, spreadBps: 150 },
        ],
        holdings: [],
        events: [
          { reportPeriodId: "source-period", eventType: "current", eventDate: "2026-03-31" },
          { reportPeriodId: null, eventType: "deal-level", description: "global event" },
          { reportPeriodId: "other-period", eventType: "ignored" },
        ],
      },
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.counts).toMatchObject({
      tranches: 1,
      trancheSnapshots: 1,
      holdings: 0,
      events: 2,
    });
    const snapshotInsert = client.calls.find((call) => /INSERT INTO clo_tranche_snapshots/i.test(call.sql));
    expect(snapshotInsert?.params).toContain("new-tranche-1");
    expect(snapshotInsert?.params).not.toContain("old-tranche-a");
    expect(client.calls.some((call) => /DELETE FROM clo_holdings WHERE report_period_id = \$1/i.test(call.sql))).toBe(true);

    const eventInserts = client.calls.filter((call) => /INSERT INTO clo_events/i.test(call.sql));
    expect(eventInserts).toHaveLength(2);
    expect(eventInserts.some((call) => call.params?.includes("period-1"))).toBe(true);
    expect(eventInserts.some((call) => call.params?.includes(null))).toBe(true);
  });

  it("rolls back and releases the client when a mid-restore insert fails", async () => {
    const client = makeClient({ failOn: /INSERT INTO clo_tranche_snapshots/i });
    mocks.getClient.mockResolvedValue(client);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(jsonRequest({
      raw: {
        dealDates: { reportDate: "2026-03-31" },
        tranches: [
          { id: "old-tranche-a", className: "Class A", currentBalance: 100 },
        ],
        trancheSnapshots: [
          { trancheId: "old-tranche-a", currentBalance: 95 },
        ],
      },
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("snapshot boom");
    expect(client.calls.map((call) => call.sql)).toContain("BEGIN");
    expect(client.calls.map((call) => call.sql)).toContain("ROLLBACK");
    expect(client.calls.map((call) => call.sql)).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
