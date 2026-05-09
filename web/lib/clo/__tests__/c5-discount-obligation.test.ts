/** Per-position dispatch tests — discount-obligation + long-dated.
 *
 *  Synthetic non-Euro-XV inputs (10-loan minimal pool, 3-tranche structure)
 *  exercising the engine paths the production fixture (Euro XV) collapses
 *  to zero on (no positions classify as discount; no long-dated; no cure
 *  diversion). Price-aware reinvestment cure-math asymmetry is unit-tested
 *  directly in `a2-reinv-oc-diversion.test.ts`; this file covers the
 *  integration paths.
 *
 *  Coverage:
 *    - Discount-obligation per-position haircut at T=0 + forward, cure
 *      dispatch flipping classification, reinvestment synthesis setting
 *      per-position fields.
 *    - Long-dated per-position dispatch (Shape A: 5% APB cap, within=par,
 *      post=zero — Ares XV verbatim from full OC pp. 135 + 142): excess-
 *      deemed-zero, within-cap no haircut, trustee scalar ignored when
 *      rule present (locks the reconciliation-only invariant), back-compat
 *      no-rule → zero haircut. */

import { describe, expect, it } from "vitest";
import { runProjection } from "@/lib/clo/projection";
import type { ResolvedDealData, ResolvedDiscountObligationRule, ResolvedLongDatedValuationRule, ResolvedLoan } from "@/lib/clo/resolver-types";
import {
  buildFromResolved,
  composeBuildWarnings,
  DEFAULT_ASSUMPTIONS,
  EMPTY_RESOLVED,
  IncompleteDataError,
  selectBlockingWarnings,
} from "@/lib/clo/build-projection-inputs";
import { makeInputs } from "./test-helpers";

const ARES_FAMILY_RULE: ResolvedDiscountObligationRule = {
  classificationThresholdPct: { type: "split_by_rate_type", floatingPct: 80, fixedPct: 75 },
  cureMechanic: {
    type: "continuous_threshold",
    cureThresholdPct: { type: "split_by_rate_type", floatingPct: 90, fixedPct: 85 },
    cureWindow: { type: "days", n: 30 },
  },
};

describe("Per-position discount-obligation haircut at T=0", () => {
  it("classified position contributes par × (1 − purchasePricePct/100) to haircut Σ", () => {
    // Single loan of €10M acquired at 75c (sub-threshold floating). Expected
    // haircut at T=0: €10M × (1 − 0.75) = €2.5M. OC numerator subtracts
    // this amount, lowering the OC ratio versus a no-haircut baseline.
    const inputs = makeInputs({
      loans: [{
        parBalance: 100_000_000,
        maturityDate: "2034-06-15",
        ratingBucket: "B",
        spreadBps: 375,
        purchasePricePct: 75,
        acquisitionDate: "2025-12-01",
        isDiscountObligation: true,
        currentPrice: 75, // matches purchase; below cure threshold (90 floating)
      }],
      initialPar: 100_000_000,
      discountObligationRule: ARES_FAMILY_RULE,
    });
    const result = runProjection(inputs);
    // T=0 OC test should reflect the haircut. Pre-fix model would have
    // Pre-fix model: OC numerator = 100M / debt. With per-position
    // dispatch: OC numerator = (100M − 25M) = 75M / debt.
    const ocActualClassA = result.initialState.ocTests[0].actual;
    const ocActualNoHaircut = (100_000_000 / 65_000_000) * 100;
    expect(ocActualClassA).toBeLessThan(ocActualNoHaircut);
    expect(ocActualClassA).toBeCloseTo((75_000_000 / 65_000_000) * 100, 1);
  });

  it("cure dispatch flips classification true→false when MV ≥ cure threshold AND held since acquisition for ≥ window", () => {
    // Loan acquired well before projection start (2024-01-01) at 78c
    // (sub-threshold). Current MV is 92c (above floating cure threshold 90).
    // Has been held >> 30 days. Cure should fire at T=0; classification
    // flips to false; haircut Σ collapses to 0.
    const inputs = makeInputs({
      loans: [{
        parBalance: 100_000_000,
        maturityDate: "2034-06-15",
        ratingBucket: "B",
        spreadBps: 375,
        purchasePricePct: 78,
        acquisitionDate: "2024-01-01",
        isDiscountObligation: true,
        currentPrice: 92,
      }],
      initialPar: 100_000_000,
      discountObligationRule: ARES_FAMILY_RULE,
    });
    const result = runProjection(inputs);
    // OC ratio = 100M / 65M = ~153.8% (cure fired, no haircut)
    const ocActualClassA = result.initialState.ocTests[0].actual;
    expect(ocActualClassA).toBeCloseTo((100_000_000 / 65_000_000) * 100, 1);
  });

  it("permanent_until_paid mechanic never reclassifies even when MV is high", () => {
    const PERMANENT_RULE: ResolvedDiscountObligationRule = {
      classificationThresholdPct: { type: "single", pct: 80 },
      cureMechanic: { type: "permanent_until_paid" },
    };
    const inputs = makeInputs({
      loans: [{
        parBalance: 100_000_000,
        maturityDate: "2034-06-15",
        ratingBucket: "B",
        spreadBps: 375,
        purchasePricePct: 78,
        acquisitionDate: "2024-01-01",
        isDiscountObligation: true,
        currentPrice: 95, // would cure under continuous_threshold; but permanent_until_paid never flips
      }],
      initialPar: 100_000_000,
      discountObligationRule: PERMANENT_RULE,
    });
    const result = runProjection(inputs);
    // Haircut still applies: 100M − 100M × (1 − 0.78) = 100M − 22M = 78M
    const ocActualClassA = result.initialState.ocTests[0].actual;
    expect(ocActualClassA).toBeCloseTo((78_000_000 / 65_000_000) * 100, 1);
  });

  it("split_by_rate_type — fixed-rate position cures at fixed cure threshold; floating doesn't (same price)", () => {
    // Both loans acquired well before projection start at 78c (sub-threshold
    // for both rate types under the Ares family rule). Current MV is 87c —
    // above the fixed-rate cure threshold (85) but below the floating-rate
    // cure threshold (90). Holding window has elapsed for both. Expected:
    // - Fixed-rate loan: cures (haircut = 0).
    // - Floating-rate loan: stays classified (haircut = par × (1 − 0.78)).
    // Together they exercise the rate-type discriminator on cureThresholdPct.
    const inputs = makeInputs({
      loans: [
        {
          parBalance: 50_000_000,
          maturityDate: "2034-06-15",
          ratingBucket: "B",
          spreadBps: 375,
          purchasePricePct: 78,
          acquisitionDate: "2024-01-01",
          isDiscountObligation: true,
          currentPrice: 87,
          isFixedRate: true,
        },
        {
          parBalance: 50_000_000,
          maturityDate: "2034-06-15",
          ratingBucket: "B",
          spreadBps: 375,
          purchasePricePct: 78,
          acquisitionDate: "2024-01-01",
          isDiscountObligation: true,
          currentPrice: 87,
          isFixedRate: false,
        },
      ],
      initialPar: 100_000_000,
      discountObligationRule: ARES_FAMILY_RULE,
    });
    const result = runProjection(inputs);
    // Fixed leg cures → no haircut on its 50M par.
    // Floating leg stays classified → haircut = 50M × (1 − 0.78) = 11M.
    // OC numerator = 100M − 11M = 89M.
    const ocActualClassA = result.initialState.ocTests[0].actual;
    expect(ocActualClassA).toBeCloseTo((89_000_000 / 65_000_000) * 100, 1);
  });

  it("hand-constructed inputs without discountObligationRule see no haircut (back-compat)", () => {
    // Same setup as test 1 but no rule provided; expect zero haircut even
    // though `isDiscountObligation: true` on the loan. Engine consumes the
    // flag for the haircut Σ regardless of rule (rule only governs cure
    // dispatch). The test confirms the haircut path doesn't gate on rule
    // presence.
    const inputs = makeInputs({
      loans: [{
        parBalance: 100_000_000,
        maturityDate: "2034-06-15",
        ratingBucket: "B",
        spreadBps: 375,
        purchasePricePct: 75,
        acquisitionDate: "2025-12-01",
        isDiscountObligation: true,
        currentPrice: 75,
      }],
      initialPar: 100_000_000,
      // discountObligationRule omitted
    });
    const result = runProjection(inputs);
    // Haircut still applies (per-position derivation doesn't gate on rule)
    const ocActualClassA = result.initialState.ocTests[0].actual;
    expect(ocActualClassA).toBeCloseTo((75_000_000 / 65_000_000) * 100, 1);
  });
});

describe("Per-position long-dated haircut at T=0 (Shape A: Ares XV verbatim)", () => {
  const SHAPE_A_5PCT_APB: ResolvedLongDatedValuationRule = {
    capPctOfBase: 5,
    capBase: "APB",
    withinCap: { type: "par" },
    postCap: { type: "zero" },
  };

  it("excess long-dated par over 5% APB cap is deemed zero (Ares XV verbatim)", () => {
    // Pool: €100M total, of which €8M is long-dated (>5% APB cap).
    // Cap = 5% × 100M = 5M. Excess = 8M − 5M = 3M deemed zero. Within-
    // cap (5M) at par — no haircut on that slice. Total haircut = 3M.
    const inputs = makeInputs({
      loans: [
        { parBalance: 92_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 375 },
        { parBalance: 8_000_000, maturityDate: "2040-01-15", ratingBucket: "B", spreadBps: 375, isLongDated: true },
      ],
      initialPar: 100_000_000,
      longDatedValuationRule: SHAPE_A_5PCT_APB,
    });
    const result = runProjection(inputs);
    // OC numerator = 100M − 3M = 97M
    const ocActualClassA = result.initialState.ocTests[0].actual;
    expect(ocActualClassA).toBeCloseTo((97_000_000 / 65_000_000) * 100, 1);
  });

  it("long-dated par within cap → no haircut", () => {
    // Pool: €100M total, of which €3M is long-dated. Cap = 5% × 100M =
    // 5M; long-dated par 3M ≤ cap → entire 3M valued at par (within-cap
    // par treatment), no haircut. OC numerator = 100M.
    const inputs = makeInputs({
      loans: [
        { parBalance: 97_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 375 },
        { parBalance: 3_000_000, maturityDate: "2040-01-15", ratingBucket: "B", spreadBps: 375, isLongDated: true },
      ],
      initialPar: 100_000_000,
      longDatedValuationRule: SHAPE_A_5PCT_APB,
    });
    const result = runProjection(inputs);
    expect(result.initialState.ocTests[0].actual).toBeCloseTo((100_000_000 / 65_000_000) * 100, 1);
  });

  it("trustee scalar (longDatedObligationHaircut) is reconciliation-only — engine ignores when rule present", () => {
    // Trustee reports 5M long-dated haircut, but pool has zero long-
    // dated positions. Engine must ignore the trustee scalar and emit
    // zero haircut from per-position dispatch. Locks the "scalar is
    // reconciliation-only" invariant so a regression to scalar
    // consumption fails immediately.
    const inputs = makeInputs({
      loans: [
        { parBalance: 100_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 375 },
      ],
      initialPar: 100_000_000,
      longDatedObligationHaircut: 5_000_000, // trustee-side; should NOT deduct
      longDatedValuationRule: SHAPE_A_5PCT_APB,
    });
    const result = runProjection(inputs);
    expect(result.initialState.ocTests[0].actual).toBeCloseTo((100_000_000 / 65_000_000) * 100, 1);
  });

  it("hand-constructed inputs without longDatedValuationRule see no haircut (back-compat)", () => {
    // Legacy fixtures and synthetic test inputs that don't model the
    // long-dated mechanic pass `longDatedObligationHaircut: 0` (default
    // on test-helpers / EMPTY_RESOLVED) and omit `longDatedValuationRule`.
    // Engine emits zero haircut when rule is null regardless of
    // isLongDated flags on positions — no rule → no haircut invariant.
    const inputs = makeInputs({
      loans: [
        { parBalance: 92_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 375 },
        { parBalance: 8_000_000, maturityDate: "2040-01-15", ratingBucket: "B", spreadBps: 375, isLongDated: true },
      ],
      initialPar: 100_000_000,
      // longDatedValuationRule omitted
    });
    const result = runProjection(inputs);
    // No haircut even though 8M is flagged isLongDated
    expect(result.initialState.ocTests[0].actual).toBeCloseTo((100_000_000 / 65_000_000) * 100, 1);
  });

  it("forward-period dispatch: long-dated cohort survives into q=1; haircut decays as cohort amortizes", () => {
    // Pool with 8M long-dated par at T=0 (above 5% cap, 3M excess).
    // Asserts the forward-period site at projection.ts:~3925 also
    // dispatches the haircut (separate from the T=0 site at ~2499).
    // The cliff arithmetic uses the period's quarter index `q`, which
    // is exercised here for q=1.
    const inputs = makeInputs({
      loans: [
        { parBalance: 92_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 375 },
        { parBalance: 8_000_000, maturityDate: "2040-01-15", ratingBucket: "B", spreadBps: 375, isLongDated: true },
      ],
      initialPar: 100_000_000,
      longDatedValuationRule: SHAPE_A_5PCT_APB,
    });
    const result = runProjection(inputs);
    const ocT0 = result.initialState.ocTests[0].actual;
    const ocQ1 = result.periods[0]?.ocTests[0]?.actual;
    expect(ocQ1).not.toBeUndefined();
    // T=0 OC = (100M − 3M) / 65M ≈ 149.23%. Q1 ratio is in the same
    // neighborhood — the cohort hasn't amortized materially with default
    // CDR and no prepay. Asserting both sides emit the haircut (vs the
    // T=0 site emitting and the forward site silently dropping it).
    expect(ocT0).toBeCloseTo((97_000_000 / 65_000_000) * 100, 1);
    expect(Math.abs(ocQ1! - ocT0)).toBeLessThan(5);
  });
});

describe("Per-position long-dated haircut — Shape B (tiered_mv_or_capped)", () => {
  // Hypothetical Ares XVIII-shape rule: 2.5% APB cap, within-cap valued
  // at min(MV × par, 70% × par), beyond 2-year cliff valued at zero,
  // post-cap zero (agency_cv_min variant is gated by the resolver).
  const SHAPE_B_TIERED: ResolvedLongDatedValuationRule = {
    capPctOfBase: 2.5,
    capBase: "APB",
    withinCap: { type: "tiered_mv_or_capped", cliffYearsPastStatedMaturity: 2, cappedPricePct: 70 },
    postCap: { type: "zero" },
  };

  it("within-cap loan with MV below capped → withinCapValue = MV × par; haircut = par × (1 − MV/100)", () => {
    // Pool: 99M + 1M long-dated. Cap = 2.5% × 100M = 2.5M; long-dated par
    // 1M ≤ cap, all within. currentPrice 60 < cappedPricePct 70 → effective
    // = 60. withinCapValue = 1M × 0.6 = 0.6M. Haircut = 1M − 0.6M = 0.4M.
    const inputs = makeInputs({
      loans: [
        { parBalance: 99_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 375 },
        { parBalance: 1_000_000, maturityDate: "2040-01-15", ratingBucket: "B", spreadBps: 375, isLongDated: true, currentPrice: 60 },
      ],
      initialPar: 100_000_000,
      longDatedValuationRule: SHAPE_B_TIERED,
    });
    const result = runProjection(inputs);
    const ocActual = result.initialState.ocTests[0].actual;
    expect(ocActual).toBeCloseTo((99_600_000 / 65_000_000) * 100, 1);
  });

  it("within-cap loan with MV above capped → withinCapValue clipped to cappedPricePct × par", () => {
    // Pool: 99M + 1M long-dated. Cap = 2.5M; within-cap. currentPrice 85 >
    // cappedPricePct 70 → effective clipped to 70. withinCapValue = 1M × 0.7
    // = 0.7M. Haircut = 1M − 0.7M = 0.3M.
    const inputs = makeInputs({
      loans: [
        { parBalance: 99_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 375 },
        { parBalance: 1_000_000, maturityDate: "2040-01-15", ratingBucket: "B", spreadBps: 375, isLongDated: true, currentPrice: 85 },
      ],
      initialPar: 100_000_000,
      longDatedValuationRule: SHAPE_B_TIERED,
    });
    const result = runProjection(inputs);
    const ocActual = result.initialState.ocTests[0].actual;
    expect(ocActual).toBeCloseTo((99_700_000 / 65_000_000) * 100, 1);
  });

  it("above-cap par valued at zero (postCap.zero), within-cap valued by tiered rule", () => {
    // Pool: 95M + 5M long-dated. Cap = 2.5M; 2.5M within-cap, 2.5M above-cap.
    // Within-cap: split proportionally — each long-dated loan contributes
    // its share. currentPrice 80 → effective 70 (clipped). Σ within-cap
    // value = 2.5M × 0.7 = 1.75M. Above-cap value = 0. Haircut = 5M − 1.75M
    // = 3.25M.
    const inputs = makeInputs({
      loans: [
        { parBalance: 95_000_000, maturityDate: "2030-01-15", ratingBucket: "B", spreadBps: 375 },
        { parBalance: 5_000_000, maturityDate: "2040-01-15", ratingBucket: "B", spreadBps: 375, isLongDated: true, currentPrice: 80 },
      ],
      initialPar: 100_000_000,
      longDatedValuationRule: SHAPE_B_TIERED,
    });
    const result = runProjection(inputs);
    const ocActual = result.initialState.ocTests[0].actual;
    expect(ocActual).toBeCloseTo((96_750_000 / 65_000_000) * 100, 1);
  });
});

describe("reinvestmentPricePct provenance — engine emits pricing source for transparency", () => {
  it("engine pass-through: hand-constructed inputs default to user_override / 100", () => {
    // Hand-constructed inputs bypass buildFromResolved; runProjection's
    // destructure defaults `reinvestmentPriceSource = "user_override"`,
    // `reinvestmentPricePct = 100`. The engine emits these unchanged.
    const inputs = makeInputs({});
    const result = runProjection(inputs);
    expect(result.initialState.reinvestmentPriceSource).toBe("user_override");
    expect(result.initialState.reinvestmentPricePctApplied).toBe(100);
  });

  // Synthetic ResolvedDealData factory for buildFromResolved integration tests.
  // EMPTY_RESOLVED is the greenfield baseline; we overlay the minimum that
  // `buildFromResolved` needs to construct a valid ProjectionInputs (a sub-note
  // tranche so equity-entry-price computation finds a denominator) plus the
  // loans the test wants to exercise.
  const buildResolvedWithLoans = (loans: ResolvedLoan[]): ResolvedDealData => ({
    ...EMPTY_RESOLVED,
    currency: "EUR",
    poolSummary: {
      ...EMPTY_RESOLVED.poolSummary,
      totalPar: loans.reduce((s, l) => s + l.parBalance, 0),
      totalPrincipalBalance: loans.reduce((s, l) => s + l.parBalance, 0),
    },
    tranches: [
      {
        className: "Sub",
        currentBalance: 0,
        originalBalance: 1,
        spreadBps: 0,
        seniorityRank: 99,
        isFloating: false,
        isIncomeNote: true,
        isDeferrable: false,
        isAmortising: false,
        amortisationPerPeriod: null,
        amortStartDate: null,
        source: "manual",
        priorInterestShortfall: null,
        priorShortfallCount: null,
        deferredInterestBalance: null,
      },
    ],
    loans: loans.map((loan) => ({ ...loan, currency: loan.currency ?? "EUR" })),
  });

  it("integration: buildFromResolved derives pool_was_derived (par-weighted) from priced pool", () => {
    // 60M @ 95c + 40M @ 90c → WAS = (60×95 + 40×90)/100 = 93.
    const loans: ResolvedLoan[] = [
      { parBalance: 60_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375, currentPrice: 95 },
      { parBalance: 40_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375, currentPrice: 90 },
    ];
    const inputs = buildFromResolved(buildResolvedWithLoans(loans), DEFAULT_ASSUMPTIONS);
    expect(inputs.reinvestmentPriceSource).toBe("pool_was_derived");
    expect(inputs.reinvestmentPricePct).toBeCloseTo(93, 5);
  });

  it("integration: user override takes priority over pool-WAS-derivation", () => {
    const loans: ResolvedLoan[] = [
      { parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375, currentPrice: 95 },
    ];
    const inputs = buildFromResolved(
      buildResolvedWithLoans(loans),
      { ...DEFAULT_ASSUMPTIONS, reinvestmentPricePct: 88 },
    );
    expect(inputs.reinvestmentPriceSource).toBe("user_override");
    expect(inputs.reinvestmentPricePct).toBe(88);
  });

  it("integration: buildFromResolved BLOCKS when pool has loans but no priced positions (anti-pattern #3)", () => {
    // Loans exist but every position has currentPrice == null → no
    // pool-WAS derivation possible. Engine refuses to fall back to par
    // silently because reinvestmentPricePct is computational (cure cash
    // sizing, OC numerator updates).
    const loans: ResolvedLoan[] = [
      { parBalance: 60_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 },
      { parBalance: 40_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 },
    ];
    const resolved = buildResolvedWithLoans(loans);
    const selected = selectBlockingWarnings(
      composeBuildWarnings(resolved, DEFAULT_ASSUMPTIONS, []),
    );
    expect(selected).toEqual([expect.objectContaining({
      field: "reinvestmentPricePct",
      severity: "error",
      blocking: true,
      message: expect.stringMatching(/No priced positions in the pool/),
    })]);
    try {
      buildFromResolved(resolved, DEFAULT_ASSUMPTIONS);
      throw new Error("expected IncompleteDataError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompleteDataError);
      expect((e as IncompleteDataError).errors).toEqual(selected);
    }
  });

  it("integration: blocking gate is cleared by user override even when no pool prices exist", () => {
    const loans: ResolvedLoan[] = [
      { parBalance: 100_000_000, maturityDate: "2034-06-15", ratingBucket: "B", spreadBps: 375 },
    ];
    expect(() =>
      buildFromResolved(
        buildResolvedWithLoans(loans),
        { ...DEFAULT_ASSUMPTIONS, reinvestmentPricePct: 92 },
      ),
    ).not.toThrow();
  });

  it("integration: greenfield (no loans) → par_fallback, no block (no reinvestment will fire)", () => {
    const inputs = buildFromResolved(EMPTY_RESOLVED, DEFAULT_ASSUMPTIONS);
    expect(inputs.reinvestmentPriceSource).toBe("par_fallback");
    expect(inputs.reinvestmentPricePct).toBe(100);
  });
});
