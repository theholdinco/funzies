/**
 * DATA INCOMPLETE banner ↔ blocking-warning bijection.
 *
 * Mechanically binds the UI's banner-row source to the engine-side
 * `buildFromResolved` gate. The bijection has three legs:
 *
 *  1. `selectBlockingWarnings` is the single predicate. Tested directly.
 *  2. `buildFromResolved` throws `IncompleteDataError` with exactly the
 *     warnings `selectBlockingWarnings` returns — no more, no less.
 *  3. `ProjectionModel.tsx` (the partner-facing surface) drives its
 *     banner from `selectBlockingWarnings`, never from a divergent
 *     inline `.filter(w => w.blocking ...)`. AST-asserted.
 *
 * If any leg breaks, the bijection breaks: the gate could refuse the
 * projection while the banner shows nothing (silent refusal — partner
 * sees an empty page with no explanation), or the banner could enumerate
 * warnings that the gate doesn't actually block on (false alarm). Both
 * are partner-visible failures the umbrella exists to prevent.
 */

import { describe, expect, it } from "vitest";
import { Node, Project } from "ts-morph";
import { resolve } from "path";
import {
  buildFromResolved,
  composeBuildWarnings,
  EMPTY_RESOLVED,
  DEFAULT_ASSUMPTIONS,
  IncompleteDataError,
  selectBlockingWarnings,
  selectNonBlockingWarnings,
} from "../build-projection-inputs";
import type { ResolutionWarning } from "../resolver-types";

const TSCONFIG_PATH = resolve(__dirname, "../../../tsconfig.json");
const PROJECTION_MODEL_PATH = resolve(
  __dirname,
  "../../../app/clo/waterfall/ProjectionModel.tsx",
);

// Mirror architecture-boundary.test.ts: instantiate the ts-morph Project
// once at module scope. Each `new Project(...)` loads + type-checks the
// entire TS project (multi-second cost); creating it inside each `it()`
// would multiply that cost by the number of AST tests for no benefit.
const sharedProject = new Project({ tsConfigFilePath: TSCONFIG_PATH });
const HELPER_PATH = resolve(__dirname, "../build-projection-inputs.ts");

interface DivergentFilterOffender {
  file: string;
  line: number;
  text: string;
}

const CURRENCY_TEST_ASSUMPTIONS = {
  ...DEFAULT_ASSUMPTIONS,
  reinvestmentPricePct: 100,
};

/**
 * Walk a source file's AST and surface every `<expr>.filter((<arg>) => ... .blocking ...)`
 * call. Used to catch divergent re-implementations of `selectBlockingWarnings`
 * outside the canonical helper file. Walks the AST (not the source text) so
 * documentation comments mentioning `.filter(w => w.blocking)` don't false-fire.
 *
 * Known limitation: only catches arrow / function expressions inline. A
 * `.filter(namedPredicate)` whose body references `.blocking` is not detected.
 * No production code does this today; promoting `blocking` to required at the
 * `ResolutionWarning` type level (already true on the discriminated union for
 * `severity === "error"`) closes the gap structurally.
 */
function findDivergentBlockingFilters(sf: ReturnType<Project["getSourceFile"]>): DivergentFilterOffender[] {
  if (!sf) return [];
  const filePath = sf.getFilePath();
  const offenders: DivergentFilterOffender[] = [];
  sf.forEachDescendant((d) => {
    if (!Node.isCallExpression(d)) return;
    const callee = d.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    if (callee.getName() !== "filter") return;
    const args = d.getArguments();
    if (args.length === 0) return;
    const arg = args[0];
    if (!Node.isArrowFunction(arg) && !Node.isFunctionExpression(arg)) return;
    let bodyHasBlocking = false;
    arg.forEachDescendant((bd) => {
      if (Node.isPropertyAccessExpression(bd) && bd.getName() === "blocking") {
        bodyHasBlocking = true;
      }
    });
    if (bodyHasBlocking) {
      offenders.push({
        file: filePath.replace(/^.*\/web\//, "web/"),
        line: d.getStartLineNumber(),
        text: d.getText().slice(0, 120),
      });
    }
  });
  return offenders;
}

describe("selectBlockingWarnings (the single predicate)", () => {
  it("returns empty when input is empty", () => {
    expect(selectBlockingWarnings([])).toEqual([]);
  });

  it("returns empty when no warning carries blocking: true", () => {
    const ws: ResolutionWarning[] = [
      { field: "a", message: "x", severity: "warn", blocking: false },
      { field: "b", message: "y", severity: "error", blocking: false },
      { field: "c", message: "z", severity: "info", blocking: false },
      { field: "d", message: "w", severity: "error", blocking: false },
    ];
    expect(selectBlockingWarnings(ws)).toEqual([]);
  });

  it("returns exactly the blocking subset, preserving order", () => {
    const ws: ResolutionWarning[] = [
      { field: "a", message: "x", severity: "warn", blocking: false },
      { field: "b", message: "y", severity: "error", blocking: true },
      { field: "c", message: "z", severity: "info", blocking: false },
      { field: "d", message: "w", severity: "error", blocking: true },
      { field: "e", message: "v", severity: "error", blocking: false },
    ];
    const out = selectBlockingWarnings(ws);
    expect(out.map((w) => w.field)).toEqual(["b", "d"]);
  });

  it("predicate uses blocking literally, not severity (severity=error alone does not block)", () => {
    // Pre-discriminated-union, this test constructed `severity: "warn", blocking: true`
    // to prove the predicate uses `blocking === true` strict equality and not
    // `severity === "error"`. The discriminated union now forbids that combo at
    // the type level, so the test inverts: construct the carve-out shape
    // `severity: "error", blocking: false` (the real-world combo at the
    // resolver's concentration-vocabulary site) and prove the predicate does NOT
    // select it. Same intent: severity is presentational; blocking is the gate.
    const ws: ResolutionWarning[] = [
      { field: "error-advisory", message: "x", severity: "error", blocking: false },
      { field: "error-blocking", message: "y", severity: "error", blocking: true },
    ];
    const out = selectBlockingWarnings(ws);
    expect(out.map((w) => w.field)).toEqual(["error-blocking"]);
  });

  it("uses strict equality on `=== true` — only literal boolean true blocks", () => {
    // Locks the runtime contract: TypeScript catches non-boolean values in
    // the `blocking` field at compile time, but this test exists to prevent
    // a future change to the predicate (e.g. truthy check) that would make
    // `blocking: 1` or `blocking: "yes"` accidentally block. The strict
    // equality is what guarantees `undefined` and `false` consistently
    // bypass — which is the contract the gate, the banner, and the AST
    // scan all rely on.
    // We bypass TS via a cast solely to construct the runtime values.
    const ws: ResolutionWarning[] = [
      { field: "truthy-non-bool", message: "x", severity: "error", blocking: 1 as unknown as boolean },
      { field: "string-true", message: "y", severity: "error", blocking: "true" as unknown as boolean },
      { field: "real-true", message: "z", severity: "error", blocking: true },
    ];
    expect(selectBlockingWarnings(ws).map((w) => w.field)).toEqual(["real-true"]);
  });
});

describe("buildFromResolved gate uses the same predicate", () => {
  it("does not throw when no warnings provided", () => {
    expect(() =>
      buildFromResolved(EMPTY_RESOLVED, DEFAULT_ASSUMPTIONS),
    ).not.toThrow();
  });

  it("does not throw when warnings exist but none are blocking", () => {
    const ws: ResolutionWarning[] = [
      { field: "a", message: "advisory", severity: "warn", blocking: false },
      { field: "b", message: "advisory", severity: "error", blocking: false },
    ];
    expect(() =>
      buildFromResolved(EMPTY_RESOLVED, DEFAULT_ASSUMPTIONS, ws),
    ).not.toThrow();
  });

  it("throws IncompleteDataError when a blocking warning exists", () => {
    const ws: ResolutionWarning[] = [
      {
        field: "fees.seniorFeePct",
        message: "missing",
        severity: "error",
        blocking: true,
      },
    ];
    expect(() =>
      buildFromResolved(EMPTY_RESOLVED, DEFAULT_ASSUMPTIONS, ws),
    ).toThrow(IncompleteDataError);
  });

  it("error.errors equals selectBlockingWarnings(input) — exact bijection", () => {
    const ws: ResolutionWarning[] = [
      { field: "a", message: "advisory", severity: "warn", blocking: false },
      { field: "b", message: "missing", severity: "error", blocking: true },
      { field: "c", message: "advisory", severity: "info", blocking: false },
      { field: "d", message: "missing", severity: "error", blocking: true },
    ];
    try {
      buildFromResolved(EMPTY_RESOLVED, DEFAULT_ASSUMPTIONS, ws);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      const err = e as IncompleteDataError;
      expect(err.errors).toEqual(selectBlockingWarnings(ws));
    }
  });

  it("dedupes resolver/build payment-frequency blockers for the same tranche cause", () => {
    const warnings: ResolutionWarning[] = [
      {
        field: "A.paymentFrequency",
        message: "No payment frequency found for interest-bearing tranche A.",
        severity: "error",
        blocking: true,
      },
      {
        field: "tranches.A.paymentFrequency",
        message: "Tranche \"A\" is missing its payment frequency.",
        severity: "error",
        blocking: true,
      },
    ];

    expect(selectBlockingWarnings(warnings)).toHaveLength(1);
    expect(selectNonBlockingWarnings(warnings)).toEqual([]);
  });

  it.each([
    { name: "missing", paymentFrequency: undefined, firstPaymentDate: "2026-04-15", message: /missing its payment frequency/ },
    { name: "unsupported", paymentFrequency: "weekly", firstPaymentDate: "2026-04-15", message: /unsupported payment frequency/ },
    { name: "monthly", paymentFrequency: "monthly", firstPaymentDate: "2026-04-15", message: /pays monthly/ },
    { name: "semi-annual without anchor", paymentFrequency: "semi_annual", firstPaymentDate: null, message: /pays semi-annually/ },
  ])("build-only KI-36 $name payment-frequency blocker is selected exactly like buildFromResolved errors", ({ paymentFrequency, firstPaymentDate, message }) => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.dates.firstPaymentDate = firstPaymentDate;
    resolved.tranches = [
      {
        className: "A",
        currentBalance: 100_000_000,
        originalBalance: 100_000_000,
        spreadBps: 150,
        seniorityRank: 1,
        isFloating: true,
        isIncomeNote: false,
        isDeferrable: false,
        isAmortising: false,
        amortisationPerPeriod: null,
        amortStartDate: null,
        source: "manual",
        priorInterestShortfall: null,
        priorShortfallCount: null,
        deferredInterestBalance: null,
        paymentFrequency: paymentFrequency as never,
      },
    ];
    if (paymentFrequency === undefined) delete resolved.tranches[0].paymentFrequency;

    const composed = composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, []);
    const selected = selectBlockingWarnings(composed);

    expect(selected).toHaveLength(1);
    expect(selected[0]).toEqual(expect.objectContaining({
      field: "tranches.A.paymentFrequency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(message),
    }));
    try {
      buildFromResolved(resolved, DEFAULT_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("build-only currency blocker refuses non-deal-currency collateral with a plain-language message", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "EUR",
        currentPrice: 99,
      },
      {
        parBalance: 2_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "USD",
        currentPrice: 99,
      },
    ];

    const composed = composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
    const selected = selectBlockingWarnings(composed);

    expect(selected).toEqual([expect.objectContaining({
      field: "loans.currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/Collateral includes non-EUR currency exposure \(USD 2,000,000\)/),
    })]);
    expect(selected.find((w) => w.field === "loans.currency")?.message).not.toMatch(/KI-38/);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("build-only currency blocker refuses missing deal currency when loan exposure exists", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = null;
    resolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "EUR",
        currentPrice: 99,
      },
    ];

    const composed = composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
    const selected = selectBlockingWarnings(composed);

    expect(selected).toEqual([expect.objectContaining({
      field: "currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/Deal currency is missing/),
    })]);
    expect(selected.find((w) => w.field === "currency")?.message).not.toMatch(/KI-38/);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("build-only currency blocker includes unfunded foreign-currency commitments", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.loans = [
      {
        parBalance: 0,
        undrawnCommitment: 3_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "GBP",
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([expect.objectContaining({
      field: "loans.currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/non-EUR currency exposure \(GBP 3,000,000\)/),
    })]);
    expect(selected.find((w) => w.field === "loans.currency")?.message).not.toMatch(/KI-38/);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("build-only currency blocker refuses exposed loans with missing loan currency", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.loans = [
      {
        parBalance: 1_500_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currentPrice: 99,
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([expect.objectContaining({
      field: "loans.currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/missing loan currency \(1,500,000\)/),
    })]);
    expect(selected.find((w) => w.field === "loans.currency")?.message).not.toMatch(/KI-38/);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("build-only currency blocker refuses aggregate pool currency evidence without loan-level currencies", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.concentrationTests = [
      {
        testName: "Currency concentration",
        testClass: null,
        actualValue: 5,
        triggerLevel: 10,
        cushion: 5,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "CURRENCY",
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([expect.objectContaining({
      field: "loans.currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/Pool-level currency concentration data is present/),
    })]);
    expect(selected.find((w) => w.field === "loans.currency")?.message).not.toMatch(/KI-38/);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("build-only currency blocker recognizes name-only currency concentration evidence", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.concentrationTests = [
      {
        testName: "Non-Euro Obligations",
        testClass: null,
        actualValue: 2,
        triggerLevel: 10,
        cushion: 8,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "OTHER",
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([expect.objectContaining({
      field: "loans.currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/Pool-level currency concentration data is present/),
    })]);
    expect(selected.find((w) => w.field === "loans.currency")?.message).not.toMatch(/KI-38/);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("build-only currency blocker recognizes Non-EUR aggregate concentration wording", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.concentrationTests = [
      {
        testName: "Non-EUR Obligations",
        testClass: null,
        actualValue: 2,
        triggerLevel: 10,
        cushion: 8,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "OTHER",
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([expect.objectContaining({
      field: "loans.currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/Pool-level currency concentration data is present/),
    })]);
    expect(selected.find((w) => w.field === "loans.currency")?.message).not.toMatch(/KI-38/);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("build-only currency blocker refuses positive currency concentration even when loan-level par totals match", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.loans = [
      {
        parBalance: 25_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "EUR",
        currentPrice: 99,
      },
    ];
    resolved.concentrationTests = [
      {
        testName: "Non-Euro Obligations",
        testClass: null,
        actualValue: 2,
        triggerLevel: 10,
        cushion: 8,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "OTHER",
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([expect.objectContaining({
      field: "loans.currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/currency concentration data indicates non-EUR exposure/),
    })]);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("non-target aggregate concentration wording does not imply foreign exposure", () => {
    const usdResolved = structuredClone(EMPTY_RESOLVED);
    usdResolved.currency = "USD";
    usdResolved.poolSummary.totalPar = 25_000_000;
    usdResolved.poolSummary.totalPrincipalBalance = 25_000_000;
    usdResolved.loans = [
      {
        parBalance: 25_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "USD",
        currentPrice: 99,
      },
    ];
    usdResolved.concentrationTests = [
      {
        testName: "Non-Euro Obligations",
        testClass: null,
        actualValue: 100,
        triggerLevel: 100,
        cushion: 0,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "CURRENCY",
      },
    ];
    expect(selectBlockingWarnings(
      composeBuildWarnings(usdResolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);

    const eurResolved = structuredClone(usdResolved);
    eurResolved.currency = "EUR";
    eurResolved.loans = [{ ...usdResolved.loans[0], currency: "EUR" }];
    eurResolved.concentrationTests = [{ ...usdResolved.concentrationTests[0], testName: "Non-USD Obligations" }];
    expect(selectBlockingWarnings(
      composeBuildWarnings(eurResolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);
  });

  it("targeted non-deal aggregate concentration wording still blocks", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "USD";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.loans = [
      {
        parBalance: 25_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "USD",
        currentPrice: 99,
      },
    ];
    resolved.concentrationTests = [
      {
        testName: "Non-USD Obligations",
        testClass: null,
        actualValue: 2,
        triggerLevel: 10,
        cushion: 8,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "OTHER",
      },
    ];

    expect(selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([expect.objectContaining({
      field: "loans.currency",
      message: expect.stringMatching(/currency concentration data indicates non-USD exposure/),
    })]);
  });

  it("pool-summary currency percentage evidence blocks when loan currencies do not identify it", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.poolSummary.pctUsdDenominated = 2;
    resolved.loans = [
      {
        parBalance: 25_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "EUR",
        currentPrice: 99,
      },
    ];

    expect(selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([expect.objectContaining({
      field: "loans.currency",
      message: expect.stringMatching(/currency concentration data indicates non-EUR exposure/),
    })]);
  });

  it("build-only currency blocker refuses aggregate pool exposure even without parsed currency concentration evidence", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([expect.objectContaining({
      field: "loans.currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/Pool-level collateral exposure exceeds loan-level exposure/),
    })]);
    expect(selected.find((w) => w.field === "loans.currency")?.message).not.toMatch(/KI-38/);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("build-only currency blocker refuses aggregate residual exposure when placeholder loans have no par", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.loans = [
      {
        parBalance: 0,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([expect.objectContaining({
      field: "loans.currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/Pool-level collateral exposure exceeds loan-level exposure/),
    })]);
    try {
      buildFromResolved(resolved, CURRENCY_TEST_ASSUMPTIONS, []);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("currency comparison normalizes common EUR aliases without blocking same-currency collateral", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "Euro";
    resolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "EUR",
        currentPrice: 99,
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([]);
  });

  it("currency comparison normalizes decorated EUR and GBP aliases without blocking same-currency collateral", () => {
    const eurResolved = structuredClone(EMPTY_RESOLVED);
    eurResolved.currency = "EUR";
    eurResolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "EUR (Euro) denominated",
        currentPrice: 99,
      },
    ];
    expect(selectBlockingWarnings(
      composeBuildWarnings(eurResolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);

    const gbpResolved = structuredClone(EMPTY_RESOLVED);
    gbpResolved.currency = "GBP";
    gbpResolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "British Pounds Sterling",
        currentPrice: 99,
      },
    ];
    expect(selectBlockingWarnings(
      composeBuildWarnings(gbpResolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);
  });

  it("currency comparison normalizes common USD symbols without blocking same-currency collateral", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "US$";
    resolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "USD",
        currentPrice: 99,
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([]);
  });

  it("currency comparison does not map Canadian or Australian dollars to USD", () => {
    const cadResolved = structuredClone(EMPTY_RESOLVED);
    cadResolved.currency = "CAD";
    cadResolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "Canadian Dollar",
        currentPrice: 99,
      },
    ];
    expect(selectBlockingWarnings(
      composeBuildWarnings(cadResolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);

    const usdResolved = structuredClone(EMPTY_RESOLVED);
    usdResolved.currency = "USD";
    usdResolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "Australian Dollar",
        currentPrice: 99,
      },
    ];
    expect(selectBlockingWarnings(
      composeBuildWarnings(usdResolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([expect.objectContaining({
      field: "loans.currency",
      message: expect.stringMatching(/non-USD currency exposure \(AUD 1,000,000\)/),
    })]);
  });

  it("same-currency aggregate concentration rows do not imply foreign exposure", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.loans = [
      {
        parBalance: 25_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "EUR",
        currentPrice: 99,
      },
    ];
    resolved.concentrationTests = [
      {
        testName: "EUR Obligations",
        testClass: null,
        actualValue: 100,
        triggerLevel: 100,
        cushion: 0,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "CURRENCY",
      },
      {
        testName: "Base Currency Obligations",
        testClass: null,
        actualValue: 100,
        triggerLevel: 100,
        cushion: 0,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "CURRENCY",
      },
    ];

    expect(selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);
  });

  it("same-currency aggregate concentration rows can support aggregate-only currency evidence", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.concentrationTests = [
      {
        testName: "EUR Obligations",
        testClass: null,
        actualValue: 100,
        triggerLevel: 100,
        cushion: 0,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "CURRENCY",
      },
      {
        testName: "Base Currency Obligations",
        testClass: null,
        actualValue: 100,
        triggerLevel: 100,
        cushion: 0,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "CURRENCY",
      },
    ];

    expect(selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);
  });

  it("deal-currency pool-summary percentage below 100 implies non-deal-currency exposure", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.poolSummary.totalPar = 25_000_000;
    resolved.poolSummary.totalPrincipalBalance = 25_000_000;
    resolved.poolSummary.pctEurDenominated = 95;
    resolved.loans = [
      {
        parBalance: 25_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "EUR",
        currentPrice: 99,
      },
    ];

    expect(selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([expect.objectContaining({
      field: "loans.currency",
      message: expect.stringMatching(/currency concentration data indicates non-EUR exposure/),
    })]);
  });

  it("negated currency labels are not treated as same-currency scalar loan evidence", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "Non-Euro Obligations",
        currentPrice: 99,
      },
    ];

    expect(selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([expect.objectContaining({
      field: "loans.currency",
      message: expect.stringMatching(/missing loan currency/),
    })]);
  });

  it("ambiguous multi-currency scalar labels are not treated as same-currency evidence", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "EUR";
    resolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "EUR/USD",
        currentPrice: 99,
      },
    ];

    expect(selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([expect.objectContaining({
      field: "loans.currency",
      message: expect.stringMatching(/missing loan currency/),
    })]);
  });

  it("regional European concentration wording is not treated as EUR currency evidence", () => {
    const usdResolved = structuredClone(EMPTY_RESOLVED);
    usdResolved.currency = "USD";
    usdResolved.poolSummary.totalPar = 25_000_000;
    usdResolved.poolSummary.totalPrincipalBalance = 25_000_000;
    usdResolved.loans = [
      {
        parBalance: 25_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "USD",
        currentPrice: 99,
      },
    ];
    usdResolved.concentrationTests = [
      {
        testName: "European Obligations",
        testClass: null,
        actualValue: 30,
        triggerLevel: 50,
        cushion: 20,
        isPassing: true,
        canonicalType: "other",
        concentrationType: "CURRENCY",
      },
    ];
    expect(selectBlockingWarnings(
      composeBuildWarnings(usdResolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);

    const eurResolved = structuredClone(usdResolved);
    eurResolved.currency = "EUR";
    eurResolved.loans = [{ ...usdResolved.loans[0], currency: "EUR" }];
    eurResolved.concentrationTests = [{ ...usdResolved.concentrationTests[0], testName: "Non-European Obligations" }];
    expect(selectBlockingWarnings(
      composeBuildWarnings(eurResolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);
  });

  it("currency comparison refuses unrecognized 3-letter pseudo-currencies", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "ABC";
    resolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "ABC",
        currentPrice: 99,
      },
    ];

    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    );

    expect(selected).toEqual([expect.objectContaining({
      field: "currency",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/Deal currency is missing/),
    })]);
  });

  it("currency comparison accepts recognized ISO currencies beyond the common deal set", () => {
    const resolved = structuredClone(EMPTY_RESOLVED);
    resolved.currency = "PLN";
    resolved.loans = [
      {
        parBalance: 1_000_000,
        maturityDate: "2030-01-15",
        ratingBucket: "B",
        spreadBps: 350,
        currency: "PLN",
        currentPrice: 99,
      },
    ];

    expect(selectBlockingWarnings(
      composeBuildWarnings(resolved, CURRENCY_TEST_ASSUMPTIONS, []),
    )).toEqual([]);
  });
});

describe("UI surfaces drive the banner from the same predicate", () => {
  it("ProjectionModel.tsx imports composeBuildWarnings + selectBlockingWarnings (no inline replacement)", () => {
    // Distinct from the divergent-filter scan below: this confirms the file
    // actually wires the helper in. The cross-file scan would pass if a UI
    // had no `.blocking` filter AT ALL (and rendered no banner) — that
    // would silently break the bijection from the other side. This
    // assertion locks ProjectionModel as a known consumer.
    const sf = sharedProject.getSourceFileOrThrow(PROJECTION_MODEL_PATH);
    expect(
      sf.getFullText().includes("selectBlockingWarnings"),
      "ProjectionModel.tsx must import + call selectBlockingWarnings to keep the banner aligned with the engine-side gate. If this fails, the banner is using its own filter and can silently disagree with what buildFromResolved actually refuses.",
    ).toBe(true);
    expect(
      sf.getFullText().includes("composeBuildWarnings"),
      "ProjectionModel.tsx must compose resolver warnings with build-time warnings before selecting blocking warnings, or DATA INCOMPLETE can miss buildFromResolved-only gates.",
    ).toBe(true);
  });

  it("no divergent inline `.filter(w => w.blocking ...)` anywhere under web/{app,lib,components,scripts}", () => {
    // Catches divergent re-implementations of the predicate. The canonical
    // call site lives in build-projection-inputs.ts:selectBlockingWarnings;
    // any other occurrence is drift waiting to happen.
    const offenders: DivergentFilterOffender[] = [];
    for (const sf of sharedProject.getSourceFiles()) {
      const filePath = sf.getFilePath();
      if (filePath === HELPER_PATH) continue;
      if (!/\/web\/(app|lib|components|scripts)\//.test(filePath)) continue;
      if (filePath.includes("/__tests__/")) continue;
      offenders.push(...findDivergentBlockingFilters(sf));
    }
    expect(
      offenders,
      `Divergent \`.filter(w => w.blocking ...)\` found outside build-projection-inputs.ts. Replace with selectBlockingWarnings to keep the gate and the banner aligned. Sites:\n${offenders
        .map((o) => `  ${o.file}:${o.line} → ${o.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
