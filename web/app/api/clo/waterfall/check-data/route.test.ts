import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  query: vi.fn(),
  decryptApiKey: vi.fn(),
  verifyPanelAccess: vi.fn(),
  getAccountBalances: vi.fn(),
  getAccruals: vi.fn(),
  getHoldings: vi.fn(),
  getIntexPositionsByReportPeriod: vi.fn(),
  getParValueAdjustments: vi.fn(),
  getReportPeriodData: vi.fn(),
  getTrancheSnapshots: vi.fn(),
  getTranches: vi.fn(),
  resolveWaterfallInputs: vi.fn(),
  processAnthropicStream: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
}));
vi.mock("@/lib/auth-helpers", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/db", () => ({ query: mocks.query }));
vi.mock("@/lib/crypto", () => ({ decryptApiKey: mocks.decryptApiKey }));
vi.mock("@/lib/clo/access", () => ({
  getAccountBalances: mocks.getAccountBalances,
  getAccruals: mocks.getAccruals,
  getHoldings: mocks.getHoldings,
  getIntexPositionsByReportPeriod: mocks.getIntexPositionsByReportPeriod,
  getParValueAdjustments: mocks.getParValueAdjustments,
  getReportPeriodData: mocks.getReportPeriodData,
  getTrancheSnapshots: mocks.getTrancheSnapshots,
  getTranches: mocks.getTranches,
  verifyPanelAccess: mocks.verifyPanelAccess,
}));
vi.mock("@/lib/clo/resolver", () => ({ resolveWaterfallInputs: mocks.resolveWaterfallInputs }));
vi.mock("@/lib/claude-stream", () => ({ processAnthropicStream: mocks.processAnthropicStream }));

import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://test.local/api/clo/waterfall/check-data", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function emptyAnthropicResponse(): Response {
  return new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200 });
}

function latestReportRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "period-latest",
    latest_id: "period-latest",
    deal_id: "deal-1",
    deal_name: "Ares Euro XV",
    deal_currency: "EUR",
    stated_maturity_date: "2034-01-01",
    reinvestment_period_end: "2028-01-01",
    report_date: "2026-03-31",
    extracted_constraints: {},
    ...overrides,
  };
}

function installDefaultQueryResponses() {
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("rp.id AS latest_id") && sql.includes("FROM clo_panels p")) {
      return [latestReportRow()];
    }
    if (/FROM clo_report_periods rp\s+JOIN clo_deals/i.test(sql)) {
      return [latestReportRow({ id: params?.[0], latest_id: params?.[0] })];
    }
    if (/SELECT encrypted_api_key, api_key_iv FROM users/i.test(sql)) {
      return [{ encrypted_api_key: Buffer.from("encrypted"), api_key_iv: Buffer.from("iv") }];
    }
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
  mocks.verifyPanelAccess.mockResolvedValue(true);
  mocks.decryptApiKey.mockReturnValue("anthropic-key");
  mocks.getTranches.mockResolvedValue([]);
  mocks.getTrancheSnapshots.mockResolvedValue([]);
  mocks.getReportPeriodData.mockResolvedValue(null);
  mocks.getAccountBalances.mockResolvedValue([]);
  mocks.getParValueAdjustments.mockResolvedValue([]);
  mocks.getHoldings.mockResolvedValue([]);
  mocks.getAccruals.mockResolvedValue([]);
  mocks.getIntexPositionsByReportPeriod.mockResolvedValue([]);
  mocks.resolveWaterfallInputs.mockReturnValue({
    resolved: {
      currency: "EUR",
      tranches: [],
      loans: [],
      concentrationTests: [],
    },
    warnings: [],
  });
  mocks.processAnthropicStream.mockImplementation(async (_reader, controller: ReadableStreamDefaultController, encoder: TextEncoder) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text", content: "[]" })}\n\n`));
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(emptyAnthropicResponse()));
  installDefaultQueryResponses();
});

describe("POST /api/clo/waterfall/check-data", () => {
  it("rejects explicit null reportPeriodId when a latest report exists", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (/SELECT rp\.id[\s\S]+ORDER BY report_date DESC/i.test(sql)) return [{ id: "period-latest" }];
      return [];
    });

    const response = await POST(request({
      panelId: "panel-1",
      dealContext: { reportPeriodId: null },
    }) as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Report data changed; refresh required" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid reportPeriodId before API key lookup or Anthropic fetch", async () => {
    const response = await POST(request({
      panelId: "panel-1",
      dealContext: { reportPeriodId: 123 },
    }) as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid reportPeriodId" });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects inaccessible and stale requested report periods", async () => {
    mocks.query.mockResolvedValueOnce([]);

    const inaccessible = await POST(request({
      panelId: "panel-1",
      dealContext: { reportPeriodId: "period-old" },
    }) as never);
    expect(inaccessible.status).toBe(409);
    await expect(inaccessible.json()).resolves.toEqual({ error: "Stale or inaccessible report period" });

    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce([latestReportRow({ id: "period-old", latest_id: "period-latest" })]);
    const stale = await POST(request({
      panelId: "panel-1",
      dealContext: { reportPeriodId: "period-old" },
    }) as never);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "Stale report period" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("omitted reportPeriodId rebuilds latest server context and streams done", async () => {
    const response = await POST(request({
      panelId: "panel-1",
      dealContext: {},
    }) as never);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(mocks.getTranches).toHaveBeenCalledWith("deal-1");
    expect(mocks.getHoldings).toHaveBeenCalledWith("period-latest");
    expect(mocks.resolveWaterfallInputs).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "anthropic-key" }),
      }),
    );
    expect(text).toContain(`data: ${JSON.stringify({ type: "text", content: "[]" })}`);
    expect(text).toContain(`data: ${JSON.stringify({ type: "done" })}`);
  });

  it("passes through Anthropic non-OK responses without streaming", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("rate limit", { status: 429 }));

    const response = await POST(request({
      panelId: "panel-1",
      dealContext: {},
    }) as never);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "API error", details: "rate limit" });
    expect(mocks.processAnthropicStream).not.toHaveBeenCalled();
  });

  it("serializes stream processing errors as SSE error events", async () => {
    mocks.processAnthropicStream.mockRejectedValueOnce(new Error("upstream exploded"));

    const response = await POST(request({
      panelId: "panel-1",
      dealContext: {},
    }) as never);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain(`data: ${JSON.stringify({ type: "error", message: "upstream exploded" })}`);
    expect(text).not.toContain(`data: ${JSON.stringify({ type: "done" })}`);
  });
});
