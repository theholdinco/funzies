import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../projection");
  vi.resetModules();
});

describe("fair-value shared run cache", () => {
  async function loadWithMock() {
    const runProjection = vi.fn((inputs: { equityEntryPrice?: number; baseRatePct?: number }) => {
      const entryPrice = inputs.equityEntryPrice ?? 100;
      const baseRate = inputs.baseRatePct ?? 0;
      return {
        initialState: { equityWipedOut: false },
        equityIrr: 1 - entryPrice / 100 + baseRate / 10_000,
      };
    });
    vi.doMock("../projection", () => ({ runProjection }));
    const service = await import("../services/fair-value");
    return { runProjection, service };
  }

  it("reuses projection runs for repeated hurdle solves on the same input object and sub note par", async () => {
    const { runProjection, service } = await loadWithMock();
    const inputs = { baseRatePct: 2 } as any;

    const first = service.computeFairValueAtHurdle(inputs, 1_000, 0.2);
    const callCount = runProjection.mock.calls.length;
    const second = service.computeFairValueAtHurdle(inputs, 1_000, 0.2);

    expect(second).toEqual(first);
    expect(runProjection).toHaveBeenCalledTimes(callCount);
  });

  it("invalidates the cache when the same input object mutates", async () => {
    const { runProjection, service } = await loadWithMock();
    const inputs = { baseRatePct: 2 } as any;

    service.computeFairValueAtHurdle(inputs, 1_000, 0.2);
    const beforeMutation = runProjection.mock.calls.length;
    inputs.baseRatePct = 3;
    service.computeFairValueAtHurdle(inputs, 1_000, 0.2);

    expect(runProjection.mock.calls.length).toBeGreaterThan(beforeMutation);
  });

  it("keeps separate cache entries for different sub note par values", async () => {
    const { runProjection, service } = await loadWithMock();
    const inputs = { baseRatePct: 2 } as any;

    service.computeFairValueAtHurdle(inputs, 1_000, 0.2);
    const beforeSecondPar = runProjection.mock.calls.length;
    service.computeFairValueAtHurdle(inputs, 2_000, 0.2);

    expect(runProjection.mock.calls.length).toBeGreaterThan(beforeSecondPar);
  });
});
