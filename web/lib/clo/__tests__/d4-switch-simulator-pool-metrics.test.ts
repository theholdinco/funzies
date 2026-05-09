/**
 * D4 — Switch simulator pool-metric recomputation (Sprint 4).
 *
 * `applySwitch` now returns `switchedResolved` with a recomputed `poolSummary`
 * so partner UI comparing base vs switched pool summaries sees compliance
 * impact of the proposed trade directly. Shared computation lives in
 * `pool-metrics.ts` — same helpers as the projection engine's per-period
 * metrics (single source of truth, no parallel-implementation drift).
 *
 * Scope:
 *   ✅ warf, walYears, wacSpreadBps, pctCccAndBelow recomputed from switchedLoans.
 *   ✅ top10ObligorsPct new field, resolver + applySwitch both populate.
 *   ✅ numberOfObligors recounted on switched pool.
 *   ❌ pctCovLite / pctPik / pctBonds / pctSeniorSecured / etc — inherited
 *      stale from base pool (no per-loan data); see applySwitch comment.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySwitch } from "@/lib/clo/switch-simulator";
import { defaultsFromResolved, IncompleteDataError } from "@/lib/clo/build-projection-inputs";
import { runProjection } from "@/lib/clo/projection";
import type { ResolvedDealData, ResolvedLoan } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof defaultsFromResolved>[1];
};

const assumptions = defaultsFromResolved(fixture.resolved, fixture.raw);
const dealCurrency = fixture.resolved.currency ?? "EUR";

// Pick a mid-par B loan to swap away from (Euro XV pool is B-heavy).
const sellIdx = fixture.resolved.loans.findIndex(
  (l) => l.ratingBucket === "B" && l.parBalance > 500_000 && !l.isDelayedDraw,
);

/** Compute the engine's baseline pool metrics by running a NO-OP switch
 *  (sell 0 par, buy a zero-par placeholder). Establishes engine-vs-engine
 *  apples-to-apples comparison so test assertions are robust to small
 *  numerical differences between the engine's per-period methodology and
 *  the trustee's reported `resolved.poolSummary` snapshot. */
function engineBaseline(): ResolvedDealData["poolSummary"] {
  const zeroBuyLoan: ResolvedLoan = {
    parBalance: 0,
    maturityDate: fixture.resolved.loans[sellIdx].maturityDate,
    ratingBucket: "B",
    spreadBps: 0,
    obligorName: "",
    warfFactor: 2720,
    currency: dealCurrency,
  };
  const result = applySwitch(
    fixture.resolved,
    { sellLoanIndex: sellIdx, sellParAmount: 0, buyLoan: zeroBuyLoan, sellPrice: 100, buyPrice: 100 },
    assumptions,
  );
  return result.switchedResolved.poolSummary;
}
const enginBase = engineBaseline();

describe("D4 — top10ObligorsPct populated on engine-computed pool", () => {
  it("applySwitch computes top10ObligorsPct on the switched pool", () => {
    const top10 = enginBase.top10ObligorsPct;
    expect(top10).not.toBeNull();
    // Euro XV's well-diversified pool — top 10 typically 5-25% of par.
    // Tests the engine's computation; resolver-side population tested
    // indirectly via fresh re-ingest on real data (fixture JSON predates
    // the top10ObligorsPct field and persists null; re-ingest populates it).
    expect(top10!).toBeGreaterThan(3);
    expect(top10!).toBeLessThan(40);
  });
});

describe("D4 — applySwitch recomputes pool quality metrics", () => {
  it("blocks proposed buy loans with missing currency instead of assuming deal currency", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const buyLoan: ResolvedLoan = {
      parBalance: sellLoan.parBalance,
      maturityDate: sellLoan.maturityDate,
      ratingBucket: sellLoan.ratingBucket,
      spreadBps: sellLoan.spreadBps,
      currentPrice: sellLoan.currentPrice,
    };

    try {
      applySwitch(
        fixture.resolved,
        { sellLoanIndex: sellIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 95, buyPrice: 95 },
        assumptions,
      );
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual([expect.objectContaining({
        field: "loans.currency",
        severity: "error",
        blocking: true,
        message: expect.stringMatching(/missing loan currency/),
      })]);
    }
  });

  it("runProjection backstop blocks direct callers with deal currency but missing loan currency", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const inputs = applySwitch(
      fixture.resolved,
      {
        sellLoanIndex: sellIdx,
        sellParAmount: 0,
        buyLoan: {
          parBalance: 0,
          maturityDate: sellLoan.maturityDate,
          ratingBucket: sellLoan.ratingBucket,
          spreadBps: sellLoan.spreadBps,
          currency: dealCurrency,
        },
        sellPrice: 100,
        buyPrice: 100,
      },
      assumptions,
    ).baseInputs;

    expect(() =>
      runProjection({
        ...inputs,
        loans: [
          ...inputs.loans,
          {
            parBalance: 1_000_000,
            maturityDate: sellLoan.maturityDate,
            ratingBucket: sellLoan.ratingBucket,
            spreadBps: sellLoan.spreadBps,
          },
        ],
      }),
    ).toThrow(/without recognized loan currency/);
  });

  it("runProjection backstop blocks direct callers with loan exposure and no deal currency", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const inputs = applySwitch(
      fixture.resolved,
      {
        sellLoanIndex: sellIdx,
        sellParAmount: 0,
        buyLoan: {
          parBalance: 0,
          maturityDate: sellLoan.maturityDate,
          ratingBucket: sellLoan.ratingBucket,
          spreadBps: sellLoan.spreadBps,
          currency: dealCurrency,
        },
        sellPrice: 100,
        buyPrice: 100,
      },
      assumptions,
    ).baseInputs;

    expect(() =>
      runProjection({
        ...inputs,
        dealCurrency: null,
        loans: [
          {
            parBalance: 1_000_000,
            maturityDate: sellLoan.maturityDate,
            ratingBucket: sellLoan.ratingBucket,
            spreadBps: sellLoan.spreadBps,
            currency: "EUR",
          },
          {
            parBalance: 1_000_000,
            maturityDate: sellLoan.maturityDate,
            ratingBucket: sellLoan.ratingBucket,
            spreadBps: sellLoan.spreadBps,
            currency: "USD",
          },
        ],
      }),
    ).toThrow(/dealCurrency is missing/);
  });

  it("runProjection backstop blocks aggregate-only exposure with no deal currency", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const inputs = applySwitch(
      fixture.resolved,
      {
        sellLoanIndex: sellIdx,
        sellParAmount: 0,
        buyLoan: {
          parBalance: 0,
          maturityDate: sellLoan.maturityDate,
          ratingBucket: sellLoan.ratingBucket,
          spreadBps: sellLoan.spreadBps,
          currency: dealCurrency,
        },
        sellPrice: 100,
        buyPrice: 100,
      },
      assumptions,
    ).baseInputs;

    expect(() =>
      runProjection({
        ...inputs,
        dealCurrency: null,
        initialPar: 1_000_000,
        loans: [],
      }),
    ).toThrow(/dealCurrency is missing/);
  });

  it("applySwitch does not mutate caller-provided warning arrays", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const warnings: import("@/lib/clo/resolver-types").ResolutionWarning[] = [{
      field: "probe",
      message: "probe",
      severity: "warn" as const,
      blocking: false as const,
    }];
    applySwitch(
      fixture.resolved,
      {
        sellLoanIndex: sellIdx,
        sellParAmount: sellLoan.parBalance,
        buyLoan: {
          parBalance: sellLoan.parBalance,
          maturityDate: sellLoan.maturityDate,
          ratingBucket: sellLoan.ratingBucket,
          spreadBps: sellLoan.spreadBps,
          currentPrice: sellLoan.currentPrice,
          currency: dealCurrency,
        },
        sellPrice: 95,
        buyPrice: 95,
      },
      assumptions,
      warnings,
    );
    expect(warnings).toHaveLength(1);
  });

  it("runProjection canonicalizes currency aliases before pool-quality metrics", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const inputs = applySwitch(
      fixture.resolved,
      {
        sellLoanIndex: sellIdx,
        sellParAmount: 0,
        buyLoan: {
          parBalance: 0,
          maturityDate: sellLoan.maturityDate,
          ratingBucket: sellLoan.ratingBucket,
          spreadBps: sellLoan.spreadBps,
          currency: dealCurrency,
        },
        sellPrice: 100,
        buyPrice: 100,
      },
      assumptions,
    ).baseInputs;

    const canonical = runProjection({
      ...inputs,
      dealCurrency: "EUR",
      loans: inputs.loans.map((loan) => ({ ...loan, currency: "EUR" })),
    });
    const alias = runProjection({
      ...inputs,
      dealCurrency: "Euro",
      loans: inputs.loans.map((loan) => ({ ...loan, currency: "EUR (Euro) denominated" })),
    });

    expect(alias.periods[0].qualityMetrics.floatingWasBps).toBeGreaterThan(0);
    expect(alias.periods[0].qualityMetrics.floatingWasBps).toBeCloseTo(
      canonical.periods[0].qualityMetrics.floatingWasBps,
      8,
    );
  });

  it("swapping B→CCC raises WARF monotonically", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const buyLoan: ResolvedLoan = {
      parBalance: sellLoan.parBalance,
      maturityDate: sellLoan.maturityDate,
      ratingBucket: "CCC",
      spreadBps: sellLoan.spreadBps + 200,
      obligorName: "Synthetic CCC Obligor",
      warfFactor: 6500, // Caa2
      currency: dealCurrency,
    };
    const result = applySwitch(
      fixture.resolved,
      { sellLoanIndex: sellIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 95, buyPrice: 95 },
      assumptions,
    );
    const switchedWarf = result.switchedResolved.poolSummary.warf;
    expect(switchedWarf).toBeGreaterThan(enginBase.warf);
  });

  it("swapping B→CCC raises pctCccAndBelow when buy par is meaningful", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const buyLoan: ResolvedLoan = {
      parBalance: 10_000_000,
      maturityDate: sellLoan.maturityDate,
      ratingBucket: "CCC",
      spreadBps: 600,
      obligorName: "Big CCC Position",
      warfFactor: 6500,
      currency: dealCurrency,
    };
    const result = applySwitch(
      fixture.resolved,
      { sellLoanIndex: sellIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 95, buyPrice: 95 },
      assumptions,
    );
    const switchedPctCcc = result.switchedResolved.poolSummary.pctCccAndBelow ?? 0;
    expect(switchedPctCcc).toBeGreaterThan(enginBase.pctCccAndBelow ?? 0);
  });

  it("increasing spread on buy raises wacSpreadBps", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const buyLoan: ResolvedLoan = {
      parBalance: sellLoan.parBalance,
      maturityDate: sellLoan.maturityDate,
      ratingBucket: "B",
      spreadBps: sellLoan.spreadBps + 100,
      obligorName: "Wider Spread",
      warfFactor: sellLoan.warfFactor,
      currency: dealCurrency,
    };
    const result = applySwitch(
      fixture.resolved,
      { sellLoanIndex: sellIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 100, buyPrice: 100 },
      assumptions,
    );
    const switchedWas = result.switchedResolved.poolSummary.wacSpreadBps;
    expect(switchedWas).toBeGreaterThan(enginBase.wacSpreadBps);
  });

  it("extending maturity raises walYears", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const sellMatYears = (new Date(sellLoan.maturityDate).getTime() - new Date(fixture.resolved.dates.currentDate).getTime()) / (1000 * 86400 * 365.25);
    const longerMatYear = Math.ceil(sellMatYears) + 5;
    const buyLoan: ResolvedLoan = {
      parBalance: sellLoan.parBalance,
      maturityDate: `${new Date(fixture.resolved.dates.currentDate).getUTCFullYear() + longerMatYear}-01-15`,
      ratingBucket: "B",
      spreadBps: sellLoan.spreadBps,
      obligorName: "Longer Mat",
      warfFactor: sellLoan.warfFactor,
      currency: dealCurrency,
    };
    const result = applySwitch(
      fixture.resolved,
      { sellLoanIndex: sellIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 100, buyPrice: 100 },
      assumptions,
    );
    const switchedWal = result.switchedResolved.poolSummary.walYears;
    expect(switchedWal).toBeGreaterThan(enginBase.walYears);
  });
});

describe("D4 — top10ObligorsPct recomputed on switch", () => {
  it("adding a huge new obligor raises top10ObligorsPct", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    // Buy a massive position on a new obligor — should rank into the top 10.
    const buyLoan: ResolvedLoan = {
      parBalance: 30_000_000, // ~6% of Euro XV's €493M pool — definitely top 10
      maturityDate: sellLoan.maturityDate,
      ratingBucket: "B",
      spreadBps: sellLoan.spreadBps,
      obligorName: "Massive New Obligor",
      warfFactor: sellLoan.warfFactor,
      currency: dealCurrency,
    };
    const result = applySwitch(
      fixture.resolved,
      { sellLoanIndex: sellIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 100, buyPrice: 100 },
      assumptions,
    );
    const switchedTop10 = result.switchedResolved.poolSummary.top10ObligorsPct!;
    expect(switchedTop10).toBeGreaterThan(enginBase.top10ObligorsPct!);
  });
});

// pctCovLite delta-recompute: applySwitch adjusts the base pctCovLite for
// the swap when both legs carry a known isCovLite, otherwise inherits +
// emits a coverage warning. The cases below pin both branches.
describe("D4 — pctCovLite delta-recompute", () => {
  it("delta-recompute fires when both legs have known isCovLite", () => {
    // Find a non-cov-lite sell candidate.
    const sellNonCovLiteIdx = fixture.resolved.loans.findIndex(
      (l) => l.isCovLite === false && l.parBalance > 500_000 && !l.isDelayedDraw,
    );
    expect(sellNonCovLiteIdx).toBeGreaterThan(-1);
    const sellLoan = fixture.resolved.loans[sellNonCovLiteIdx];
    // Buy a cov-lite replacement of the same par.
    const buyLoan: ResolvedLoan = {
      parBalance: sellLoan.parBalance,
      maturityDate: sellLoan.maturityDate,
      ratingBucket: "B",
      spreadBps: sellLoan.spreadBps,
      obligorName: "Cov-Lite Replacement",
      warfFactor: sellLoan.warfFactor,
      currency: dealCurrency,
      isCovLite: true,
    };
    const warnings: import("@/lib/clo/resolver-types").ResolutionWarning[] = [];
    const result = applySwitch(
      fixture.resolved,
      { sellLoanIndex: sellNonCovLiteIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 100, buyPrice: 100 },
      assumptions,
      warnings,
    );

    // The engine computes the delta using sum-of-loans as the denominator
    // (not poolSummary.totalPar, which can include unfunded DDTLs / pre-
    // existing defaults). Compute the same denominator here for an
    // engine-vs-engine assertion.
    const switchedSumLoans = result.switchedResolved.loans.reduce((s, l) => s + l.parBalance, 0);
    // sell is non-cov-lite (removed=0); buy is cov-lite (added=sellLoan.par).
    const baseCovLitePar = (fixture.resolved.poolSummary.pctCovLite! / 100) * fixture.resolved.poolSummary.totalPar;
    const expectedNewPar = baseCovLitePar + sellLoan.parBalance;
    const expectedPct = (expectedNewPar / switchedSumLoans) * 100;

    expect(result.switchedResolved.poolSummary.pctCovLite).toBeCloseTo(expectedPct, 4);
    // Switched value should be HIGHER than base (added cov-lite par).
    expect(result.switchedResolved.poolSummary.pctCovLite!).toBeGreaterThan(
      fixture.resolved.poolSummary.pctCovLite!,
    );
    // No coverage warning when both legs are known.
    expect(warnings.filter(w => w.field === "switched_pctCovLite")).toHaveLength(0);
  });

  it("inherits without mutating caller warnings when buy leg has unknown isCovLite", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const buyLoan: ResolvedLoan = {
      parBalance: sellLoan.parBalance,
      maturityDate: sellLoan.maturityDate,
      ratingBucket: "B",
      spreadBps: sellLoan.spreadBps,
      obligorName: "Unknown Cov-Lite",
      warfFactor: sellLoan.warfFactor,
      currency: dealCurrency,
      // isCovLite deliberately omitted — partner-supplied buy loan with no flag
    };
    const warnings: import("@/lib/clo/resolver-types").ResolutionWarning[] = [];
    const result = applySwitch(
      fixture.resolved,
      { sellLoanIndex: sellIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 100, buyPrice: 100 },
      assumptions,
      warnings,
    );

    // Inherits base value when delta-recompute can't fire.
    expect(result.switchedResolved.poolSummary.pctCovLite).toBe(
      fixture.resolved.poolSummary.pctCovLite,
    );
    expect(warnings.find(w => w.field === "switched_pctCovLite")).toBeUndefined();
  });

  // pctPik delta-recompute keys on `pikSpreadBps > 0` ("actively accreting
  // PIK"), not on the structural `isPik` boolean. Same gating shape as
  // pctCovLite: both swap legs need a known pikSpreadBps for the recompute
  // to fire.
  it("pctPik delta-recompute fires when both legs have known pikSpreadBps", () => {
    const sellNonPikIdx = fixture.resolved.loans.findIndex(
      (l) => l.pikSpreadBps === undefined && l.parBalance > 500_000 && !l.isDelayedDraw,
    );
    expect(sellNonPikIdx).toBeGreaterThan(-1);
    const sellLoan = fixture.resolved.loans[sellNonPikIdx];
    const buyLoan: ResolvedLoan = {
      parBalance: sellLoan.parBalance,
      maturityDate: sellLoan.maturityDate,
      ratingBucket: "B",
      spreadBps: sellLoan.spreadBps,
      obligorName: "PIK Replacement",
      warfFactor: sellLoan.warfFactor,
      currency: dealCurrency,
      pikSpreadBps: 100,  // actively accreting at 1%
    };
    // Sell leg needs an explicit pikSpreadBps for the delta-recompute to
    // fire (undefined blocks the recompute, same as undefined isCovLite).
    // Use 0 to represent "extraction succeeded, no PIK".
    const sellWithKnownPik = { ...sellLoan, pikSpreadBps: 0 };
    const swappedResolved = {
      ...fixture.resolved,
      loans: fixture.resolved.loans.map((l, i) => i === sellNonPikIdx ? sellWithKnownPik : l),
    };
    const warnings: import("@/lib/clo/resolver-types").ResolutionWarning[] = [];
    const result = applySwitch(
      swappedResolved,
      { sellLoanIndex: sellNonPikIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 100, buyPrice: 100 },
      assumptions,
      warnings,
    );

    // Delta: sell is non-PIK (pikSpreadBps=0 → removed=0); buy is actively-
    // accreting PIK (pikSpreadBps=100 → added=sellLoan.par).
    const switchedSumLoans = result.switchedResolved.loans.reduce((s, l) => s + l.parBalance, 0);
    if (fixture.resolved.poolSummary.pctPik != null) {
      const basePikPar = (fixture.resolved.poolSummary.pctPik / 100) * fixture.resolved.poolSummary.totalPar;
      const expectedPct = ((basePikPar + sellLoan.parBalance) / switchedSumLoans) * 100;
      expect(result.switchedResolved.poolSummary.pctPik).toBeCloseTo(expectedPct, 4);
    } else {
      // Base pctPik is null on Euro XV (no pool-level PIK share extracted) —
      // delta-recompute returns null and emits coverage warn.
      expect(result.switchedResolved.poolSummary.pctPik).toBeNull();
      expect(warnings.find(w => w.field === "switched_pctPik")).toBeDefined();
    }
  });

  it("pctPik inherits without mutating caller warnings when buy leg has unknown pikSpreadBps", () => {
    const sellLoan = fixture.resolved.loans[sellIdx];
    const buyLoan: ResolvedLoan = {
      parBalance: sellLoan.parBalance,
      maturityDate: sellLoan.maturityDate,
      ratingBucket: "B",
      spreadBps: sellLoan.spreadBps,
      obligorName: "Unknown PIK",
      warfFactor: sellLoan.warfFactor,
      currency: dealCurrency,
      // pikSpreadBps deliberately omitted
    };
    const warnings: import("@/lib/clo/resolver-types").ResolutionWarning[] = [];
    const result = applySwitch(
      fixture.resolved,
      { sellLoanIndex: sellIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 100, buyPrice: 100 },
      assumptions,
      warnings,
    );
    expect(result.switchedResolved.poolSummary.pctPik).toBe(
      fixture.resolved.poolSummary.pctPik,
    );
    expect(warnings.find(w => w.field === "switched_pctPik")).toBeUndefined();
  });
});

describe("Industry-cap — switch simulator industry-distribution delta", () => {
  it("post-switch poolSummary carries industryDistributionPct + largestIndustryPct fields (null on Euro XV — coverage incomplete)", () => {
    // Euro XV today: per-loan industryCode is unpopulated (PR3 resolver
    // path requires the PPM clause-(t) extraction which hasn't been run
    // on the fixture). The shared helper returns null on both fields when
    // no loans carry industryCode. Engine + switch-sim agree.
    const sellLoan = fixture.resolved.loans[sellIdx];
    const buyLoan: ResolvedLoan = {
      parBalance: sellLoan.parBalance,
      maturityDate: sellLoan.maturityDate,
      ratingBucket: "B",
      spreadBps: sellLoan.spreadBps,
      obligorName: "TestObligor",
      warfFactor: sellLoan.warfFactor,
      currency: dealCurrency,
    };
    const result = applySwitch(
      fixture.resolved,
      { sellLoanIndex: sellIdx, sellParAmount: sellLoan.parBalance, buyLoan, sellPrice: 100, buyPrice: 100 },
      assumptions,
    );
    // Field present — null when coverage incomplete; non-null shape is an
    // Array<{industryCode, industryName, parPct}> sorted descending.
    expect("industryDistributionPct" in result.switchedResolved.poolSummary).toBe(true);
    expect("largestIndustryPct" in result.switchedResolved.poolSummary).toBe(true);
  });

  it("post-switch industry distribution recomputed when every loan carries industryCode", () => {
    // Synthesize a small pool where every loan carries industryCode, swap
    // a 1010-tagged loan for a 1020-tagged loan, and assert the
    // distribution shifts as expected.
    const taggedLoans: ResolvedLoan[] = [
      { parBalance: 30_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, obligorName: "A", warfFactor: 2720, currentPrice: 99, industryCode: "1010", industryName: "Aerospace and Defense", currency: dealCurrency },
      { parBalance: 30_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, obligorName: "B", warfFactor: 2720, currentPrice: 99, industryCode: "1020", industryName: "Automotive", currency: dealCurrency },
      { parBalance: 40_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 350, obligorName: "C", warfFactor: 2720, currentPrice: 99, industryCode: "1030", industryName: "Banking", currency: dealCurrency },
    ];
    const taggedResolved: ResolvedDealData = {
      ...fixture.resolved,
      loans: taggedLoans,
      poolSummary: { ...fixture.resolved.poolSummary, totalPar: 100_000_000 },
    };
    // Sell 30M from bucket 1010; buy a 30M position in bucket 1030.
    const result = applySwitch(
      taggedResolved,
      {
        sellLoanIndex: 0,
        sellParAmount: 30_000_000,
        buyLoan: {
          parBalance: 30_000_000,
          maturityDate: "2030-01-15",
          ratingBucket: "B",
          spreadBps: 350,
          obligorName: "D",
          warfFactor: 2720,
          currency: dealCurrency,
          industryCode: "1030",
          industryName: "Banking",
        },
        sellPrice: 100,
        buyPrice: 100,
      },
      assumptions,
    );
    const dist = result.switchedResolved.poolSummary.industryDistributionPct;
    expect(dist).not.toBeNull();
    // Post-swap: 1010=0, 1020=30M, 1030=70M (40M existing + 30M new).
    // Distribution descending: 1030 (70%), 1020 (30%).
    expect(dist!.length).toBe(2);
    expect(dist![0].industryCode).toBe("1030");
    expect(dist![0].parPct).toBeCloseTo(70, 0);
    expect(dist![1].industryCode).toBe("1020");
    expect(dist![1].parPct).toBeCloseTo(30, 0);
    expect(result.switchedResolved.poolSummary.largestIndustryPct).toBeCloseTo(70, 0);
  });
});
