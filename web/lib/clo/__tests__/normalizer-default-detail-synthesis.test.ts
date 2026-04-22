import { describe, it, expect, vi } from "vitest";
import { normalizeSectionResults } from "../extraction/normalizer";

function emptyReportId() { return "00000000-0000-0000-0000-000000000001"; }
function emptyDealId() { return "00000000-0000-0000-0000-000000000002"; }

describe("normalizeSectionResults — default_detail phantom synthesis", () => {
  it("synthesizes phantom holdings for unmatched defaulted obligors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sections = {
      asset_schedule: { holdings: [{ obligorName: "Unrelated Co", parBalance: 10_000_000, isDefaulted: false }] },
      default_detail: {
        defaults: [
          { obligorName: "Phantom One", parAmount: 2_000_000, marketPrice: 30, recoveryRateMoodys: 40, recoveryRateSp: 35, recoveryRateFitch: 45, isDefaulted: true },
          { obligorName: "Phantom Two", parAmount: 1_500_000, marketPrice: 20, isDefaulted: true },
        ],
      },
    };
    const { holdings } = normalizeSectionResults(sections as never, emptyReportId(), emptyDealId());
    const phantoms = holdings.filter(h => h.is_defaulted);
    expect(phantoms).toHaveLength(2);
    expect(phantoms.map(p => p.obligor_name).sort()).toEqual(["Phantom One", "Phantom Two"]);
    expect(phantoms.find(p => p.obligor_name === "Phantom One")?.par_balance).toBe(2_000_000);
    expect(phantoms.find(p => p.obligor_name === "Phantom One")?.recovery_rate_moodys).toBe(40);
    expect(phantoms.find(p => p.obligor_name === "Phantom One")?.data_origin).toBe("synthesized_from_default_detail");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("default_detail synthesis: created 2 phantom holdings"));
    warn.mockRestore();
  });

  it("does NOT synthesize when defaulted obligors already match holdings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sections = {
      asset_schedule: { holdings: [{ obligorName: "Defaulted Co", parBalance: 2_000_000, isDefaulted: false }] },
      default_detail: {
        defaults: [{ obligorName: "Defaulted Co", parAmount: 2_000_000, marketPrice: 30, isDefaulted: true }],
      },
    };
    const { holdings } = normalizeSectionResults(sections as never, emptyReportId(), emptyDealId());
    expect(holdings).toHaveLength(1);
    expect(holdings[0].is_defaulted).toBe(true);
    const synthLogs = warn.mock.calls.filter(c => String(c[0]).includes("default_detail synthesis"));
    expect(synthLogs).toHaveLength(0);
    warn.mockRestore();
  });

  it("skips default_detail rows with null or zero parAmount", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sections = {
      asset_schedule: { holdings: [] },
      default_detail: {
        defaults: [
          { obligorName: "No Par Co", parAmount: null, isDefaulted: true },
          { obligorName: "Zero Par Co", parAmount: 0, isDefaulted: true },
          { obligorName: "Valid Co", parAmount: 1_000_000, isDefaulted: true },
        ],
      },
    };
    const { holdings } = normalizeSectionResults(sections as never, emptyReportId(), emptyDealId());
    expect(holdings).toHaveLength(1);
    expect(holdings[0].obligor_name).toBe("Valid Co");
    warn.mockRestore();
  });

  it("does NOT synthesize when a holding fuzzy-matches the default_detail name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sections = {
      asset_schedule: { holdings: [{ obligorName: "ACME Holdings LLC", parBalance: 10_000_000, isDefaulted: false }] },
      default_detail: {
        defaults: [{ obligorName: "ACME Holdings", parAmount: 2_000_000, isDefaulted: true }],
      },
    };
    const { holdings } = normalizeSectionResults(sections as never, emptyReportId(), emptyDealId());
    // Expect exactly one holding — the fuzzy-matched original, flagged defaulted — not a phantom duplicate
    expect(holdings).toHaveLength(1);
    expect(holdings[0].obligor_name).toBe("ACME Holdings LLC");
    expect(holdings[0].is_defaulted).toBe(true);
    const synthLogs = warn.mock.calls.filter(c => String(c[0]).includes("default_detail synthesis"));
    expect(synthLogs).toHaveLength(0);
    warn.mockRestore();
  });

  it("does NOT synthesize when a pre-flagged holding fuzzy-matches default_detail name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sections = {
      asset_schedule: {
        holdings: [{ obligorName: "ACME Holdings LLC", parBalance: 10_000_000, isDefaulted: true }],
      },
      default_detail: {
        defaults: [{ obligorName: "ACME Holdings", parAmount: 2_000_000, isDefaulted: true }],
      },
    };
    const { holdings } = normalizeSectionResults(sections as never, emptyReportId(), emptyDealId());
    expect(holdings).toHaveLength(1);
    expect(holdings[0].obligor_name).toBe("ACME Holdings LLC");
    expect(holdings[0].is_defaulted).toBe(true);
    const synthLogs = warn.mock.calls.filter(c => String(c[0]).includes("default_detail synthesis"));
    expect(synthLogs).toHaveLength(0);
    warn.mockRestore();
  });
});
