/**
 * Opening-balance routing for the four named PPM accounts beyond the
 * Principal Account.
 *
 * Pins the engine's Q1 consumption of:
 *
 *   - Interest Account opening balance (PPM Condition 3(j)(ii)(1))
 *   - Interest Smoothing Account opening balance (PPM Condition 3(j)(xii))
 *   - Expense Reserve Account opening balance (PPM Condition 3(j)(x)(4) +
 *     Interest Priority of Payments steps (B) + (C))
 *   - Supplemental Reserve Account opening balance (PPM Condition 3(j)(vi);
 *     manager discretion → user-assumption-driven via
 *     `supplementalReserveDisposition`)
 *
 * Each test isolates a single non-zero opening balance and asserts:
 *   (a) the engine moves the right amount into the right Q1 channel
 *       (availableInterest, q1Cash, or augmented Senior Expenses Cap);
 *   (b) `equityBookValue` reflects the balance as a balance-sheet identity;
 *   (c) `initialState.ocNumerator` is UNCHANGED — Adjusted Collateral
 *       Principal Amount per PPM Condition 1(d) limits account-cash credit
 *       to the Principal Account + Unused Proceeds Account, and these tests
 *       guard against any future PR routing reserve cash into the OC numerator;
 *   (d) `initialState.openingAccountBalances` echoes the input values —
 *       the canonical T=0 emission UI consumes per the engine-as-source-of-
 *       truth doctrine.
 */

import { describe, it, expect } from "vitest";
import { runProjection } from "../projection";
import { makeInputs, uniformRates } from "./test-helpers";

const BASE_INPUTS = () =>
  makeInputs({
    defaultRatesByRating: uniformRates(0), // no defaults; isolate cash effect
    cprPct: 0,
  });

describe("Interest Account opening balance — PPM 3(j)(ii)(1)", () => {
  it("Q1 availableInterest increases by the opening balance + yield (mirrors initialPrincipalCash treatment)", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withCash = runProjection({
      ...BASE_INPUTS(),
      initialInterestAccountCash: 1_000_000,
    });
    // Q1 interestCollected gain = balance + yield(balance @ floored base rate × Q1 dayfrac).
    // Yield is small relative to balance (~quarter × few %), so the increase
    // is dominated by the balance itself. Verify with a tight lower bound
    // (>= balance) and a loose upper bound (< balance × 1.05).
    const delta =
      withCash.periods[0].interestCollected -
      baseline.periods[0].interestCollected;
    expect(delta).toBeGreaterThanOrEqual(1_000_000);
    expect(delta).toBeLessThan(1_050_000);
  });

  it("equityBookValue increases by the opening balance (balance-sheet identity)", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withCash = runProjection({
      ...BASE_INPUTS(),
      initialInterestAccountCash: 1_000_000,
    });
    expect(
      withCash.initialState.equityBookValue -
        baseline.initialState.equityBookValue,
    ).toBeCloseTo(1_000_000, 6);
  });

  it("ocNumerator at T=0 is UNCHANGED — Interest Account does NOT credit Adjusted CPA per Condition 1(d)", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withCash = runProjection({
      ...BASE_INPUTS(),
      initialInterestAccountCash: 1_000_000,
    });
    expect(withCash.initialState.ocNumerator).toBeCloseTo(
      baseline.initialState.ocNumerator,
      6,
    );
  });
});

describe("Interest Smoothing opening balance — PPM 3(j)(xii)", () => {
  it("Q1 availableInterest increases by the opening balance + yield", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withSmoothing = runProjection({
      ...BASE_INPUTS(),
      initialInterestSmoothingBalance: 500_000,
    });
    const delta =
      withSmoothing.periods[0].interestCollected -
      baseline.periods[0].interestCollected;
    expect(delta).toBeGreaterThanOrEqual(500_000);
    expect(delta).toBeLessThan(525_000);
  });

  it("ocNumerator at T=0 is UNCHANGED — Smoothing balance does NOT credit Adjusted CPA", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withSmoothing = runProjection({
      ...BASE_INPUTS(),
      initialInterestSmoothingBalance: 500_000,
    });
    expect(withSmoothing.initialState.ocNumerator).toBeCloseTo(
      baseline.initialState.ocNumerator,
      6,
    );
  });
});

describe("Expense Reserve opening balance — PPM 3(j)(x)(4) cap-augmentation at steps (B)+(C)", () => {
  it("expands the effective Senior Expenses Cap; reserve drains by the over-cap pay amount", () => {
    // Construct a scenario where trustee+admin requested EXCEEDS the standard
    // cap so the augmentation matters. Standard cap from makeInputs is the
    // engine default (no seniorExpensesCapBps set on the test fixture →
    // uncapped). Set an explicit small cap so requested > cap, then add a
    // reserve and verify the over-cap portion gets paid.
    const base = makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      trusteeFeeBps: 30, // 30 bps p.a. on ~€100M par → ~€7.5K/quarter
      adminFeeBps: 20, //  20 bps p.a. → ~€5K/quarter
      seniorExpensesCapBps: 4, // tight cap → ~€1K/quarter; overflow ~€11.5K
    });

    const noReserve = runProjection(base);
    const withReserve = runProjection({
      ...base,
      initialExpenseReserveBalance: 100_000, // >> overflow, so cap is fully covered
    });

    const noReserveCappedPaid =
      noReserve.periods[0].stepTrace.trusteeFeesPaid +
      noReserve.periods[0].stepTrace.adminFeesPaid;
    const withReserveCappedPaid =
      withReserve.periods[0].stepTrace.trusteeFeesPaid +
      withReserve.periods[0].stepTrace.adminFeesPaid;

    // With the reserve, more of the requested fee is paid AT (B)+(C) rather
    // than overflowing to (Y)+(Z). The augmented cap absorbs the overflow.
    expect(withReserveCappedPaid).toBeGreaterThan(noReserveCappedPaid);

    // The reserve drain equals exactly the over-cap portion that got paid.
    const drawQ1 = withReserve.periods[0].stepTrace.expenseReserveDraw;
    expect(drawQ1).toBeCloseTo(
      withReserveCappedPaid - noReserveCappedPaid,
      2,
    );
    expect(drawQ1).toBeGreaterThan(0);
  });

  it("zero draw when standard cap was sufficient", () => {
    const base = makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      trusteeFeeBps: 1,
      adminFeeBps: 1,
      seniorExpensesCapBps: 50, // generous cap
    });
    const result = runProjection({
      ...base,
      initialExpenseReserveBalance: 100_000,
    });
    expect(result.periods[0].stepTrace.expenseReserveDraw).toBe(0);
  });

  it("reserve drains across periods until exhausted", () => {
    const base = makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      trusteeFeeBps: 30,
      adminFeeBps: 20,
      seniorExpensesCapBps: 4, // ~€11.5K/quarter overflow at €100M par
    });
    const result = runProjection({
      ...base,
      initialExpenseReserveBalance: 25_000, // drains in ~2-3 quarters
    });
    // Sum of draws across all periods cannot exceed the opening balance
    // (PPM-floor: "shall not cause the balance ... to fall below zero").
    const totalDrain = result.periods.reduce(
      (s, p) => s + p.stepTrace.expenseReserveDraw,
      0,
    );
    expect(totalDrain).toBeLessThanOrEqual(25_000 + 0.01);
    // And there is some drain in early periods (the reserve is doing work).
    expect(result.periods[0].stepTrace.expenseReserveDraw).toBeGreaterThan(0);
  });

  it("ocNumerator at T=0 is UNCHANGED — Expense Reserve balance does NOT credit Adjusted CPA", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withReserve = runProjection({
      ...BASE_INPUTS(),
      initialExpenseReserveBalance: 100_000,
    });
    expect(withReserve.initialState.ocNumerator).toBeCloseTo(
      baseline.initialState.ocNumerator,
      6,
    );
  });

  it("PPM 3(j)(x)(4) cash transfer: under interest-shortfall stress, reserve cash augments the senior-expense pool (paragraph (c) inflow)", () => {
    // Per PPM Condition 3(j)(x)(4) the reserve PHYSICALLY transfers cash
    // to the Interest Account on the second BD prior to each Payment
    // Date — equal to the projected over-cap requested amount, capped at
    // the reserve balance. The cash augments the pool from which steps
    // (B)+(C) are paid. Pre-fix the engine treated the reserve as a CAP
    // augmenter only (capAmount enlarged but no cash added to
    // `availableInterest`), so under interest-shortfall stress the
    // helper truncated trustee/admin paid below what the reserve was
    // available to fund — silent under-payment of senior expenses. The
    // mirror PPM citation is the IC numerator paragraph (c) which
    // includes "amounts that would be payable from the Expense Reserve
    // Account ... to the Interest Account in the Due Period."
    //
    // Stress scenario: interestCollected near zero (wacSpread + per-loan
    // spread + base rate all zeroed), cap small, reserve large. Post-fix
    // the reserve cash flows through, trustee+admin paid > interestCollected
    // (the difference funded by reserve cash).
    const inputs = makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      baseRatePct: 0,
      baseRateFloorPct: 0,
      wacSpreadBps: 0,
      trusteeFeeBps: 100,        // ~50K / quarter requested at full dayfrac
      adminFeeBps: 100,
      seniorExpensesCapBps: 4,   // ~2K cap → ~98K over-cap requested
      initialExpenseReserveBalance: 100_000,
    });
    // Zero per-loan spreads so loan-level interest accrual = 0 (otherwise
    // the per-loan interestCollected branch dominates and the fixture is
    // not stressed enough).
    inputs.loans = inputs.loans!.map((l) => ({ ...l, spreadBps: 0 }));
    const result = runProjection(inputs);
    const p1 = result.periods[0];
    const cappedPaidActual =
      p1.stepTrace.trusteeFeesPaid + p1.stepTrace.adminFeesPaid;
    const draw = p1.stepTrace.expenseReserveDraw;
    // Post-fix invariant: under stress, reserve cash augments payment.
    // Drain reflects the physical cash transfer (over-cap requested
    // capped at reserve balance), so drain > 0 in this stress fixture.
    expect(draw).toBeGreaterThan(0);
    // Actually-paid trustee+admin EXCEEDS interestCollected by the reserve
    // transfer amount (the cash augmentation). Pre-fix this assertion
    // would have failed because the reserve provided no cash — the helper
    // truncated paid against interestCollected alone.
    expect(cappedPaidActual).toBeGreaterThan(p1.interestCollected);
    // Drain bounded by the reserve balance (PPM-floor invariant: "shall
    // not cause the balance ... to fall below zero").
    expect(draw).toBeLessThanOrEqual(100_000 + 0.01);
  });

  it("IC numerator paragraph (c) at Q1 (per-period) includes Expense Reserve over-cap inflow — T=0/Q1 parity", () => {
    // Per-period IC numerator (`interestAfterFees`) must include the
    // PPM paragraph (c) reserve transfer so T=0 and Q1 agree on the
    // ratio's numerator. Pre-fix, T=0 added the inflow but Q1 did not
    // (the cash-augmentation block ran AFTER the IC numerator was
    // computed), creating a silent T=0/Q1 asymmetry that would have
    // understated Q1 IC ratios on any deal where the cap binds and
    // the reserve has cash. Fixed by hoisting the inflow calc up to
    // the same site where the IC numerator is constructed.
    const baseTight = makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      trusteeFeeBps: 30,
      adminFeeBps: 20,
      seniorExpensesCapBps: 4,
    });
    const noReserve = runProjection(baseTight);
    const withReserve = runProjection({
      ...baseTight,
      initialExpenseReserveBalance: 1_000_000,
    });
    // Q1 per-period IC test under "with reserve" must show a HIGHER
    // ratio than "no reserve" by approximately the inflow amount over
    // the IC denominator. Bilateral bound (lower + upper) catches both
    // (a) missing-inflow regressions (ratio doesn't move) and (b) double-
    // counting regressions (ratio moves more than the inflow allows).
    const noReservePeriodIc = noReserve.periods[0].icTests[0];
    const withReservePeriodIc = withReserve.periods[0].icTests[0];
    const ratioDelta = withReservePeriodIc.actual - noReservePeriodIc.actual;
    // Inflow magnitude per period: over-cap requested per period ~
    // (50bps - 4bps) × 100M × dayfracQ1 ≈ €12K (BOUNDED BY per-period
    // over-cap, not the full reserve balance). IC denominator ~ 65M ×
    // 5% × dayfracQ1 ≈ €830K. So ratio delta ≈ 12K/830K × 100 ≈ 1.4pp.
    // The bilateral bound (0.5pp, 10pp) catches stale-zero (delta ≈ 0
    // — the bug fixed in this round) and double-counted-inflow without
    // depending on exact day-count arithmetic. A doubled-inflow regression
    // would push delta past ~3pp; the 10pp ceiling provides headroom for
    // legitimate dayfrac variance.
    expect(ratioDelta).toBeGreaterThan(0.5);
    expect(ratioDelta).toBeLessThan(10);
  });

  it("IC numerator paragraph (c) at T=0 includes Expense Reserve over-cap inflow", () => {
    // PPM Condition 1, "Interest Coverage Amount" paragraph (c) (verified
    // verbatim against the offering circular ll. 8993-8997): "plus any
    // amounts that would be payable from the Expense Reserve Account
    // (only in respect of amounts that are not designated for transfer
    // to the Principal Account), the First Period Reserve Account, the
    // Interest Smoothing Account and/or the Currency Account to the
    // Interest Account in the Due Period". The Expense Reserve over-cap
    // transfer per Condition 3(j)(x)(4) is the IC paragraph (c) flow;
    // T=0 IC must include it for snapshot ↔ Q1 directional consistency.
    //
    // Discriminating fixture: tight cap so requested > standard cap
    // (forcing a non-zero over-cap transfer), reserve large enough to
    // fund it, and at least one rated tranche so the IC test has a
    // finite actual ratio.
    const baseTight = makeInputs({
      defaultRatesByRating: uniformRates(0),
      cprPct: 0,
      trusteeFeeBps: 30,
      adminFeeBps: 20,
      seniorExpensesCapBps: 4,
    });
    const noReserve = runProjection(baseTight);
    const withReserve = runProjection({
      ...baseTight,
      initialExpenseReserveBalance: 1_000_000,
    });
    // Bilateral bound on the T=0 IC delta — catches both stale-zero
    // (no inflow added — the bug fixed in this round) and obvious
    // double-counting regressions (delta should not exceed the inflow
    // contribution to the numerator divided by the IC denominator).
    // Inflow at T=0 uses /4 flat: (50bps - 4bps) × 100M / 4 ≈ €115K,
    // capped at reserve balance (1M). IC denominator (Class A interest
    // due at default fixture's coupon) on the order of €100K-€500K, so
    // ratio delta is in the ~10-100pp range. The bilateral bound
    // (1pp, 200pp) catches stale-zero and obvious double-counting
    // without depending on exact day-count or coupon arithmetic.
    const noReserveIc = noReserve.initialState.icTests[0];
    const withReserveIc = withReserve.initialState.icTests[0];
    const ratioDelta = withReserveIc.actual - noReserveIc.actual;
    expect(ratioDelta).toBeGreaterThan(1);
    expect(ratioDelta).toBeLessThan(200);
  });
});

describe("Supplemental Reserve opening balance — PPM 3(j)(vi) manager discretion", () => {
  it("disposition='principalCash' (default): balance routes into Q1 reinvestment during RP", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withSupp = runProjection({
      ...BASE_INPUTS(),
      initialSupplementalReserveBalance: 2_000_000,
      // disposition omitted → default 'principalCash'
    });
    // During RP, q1Cash flows into reinvestment. The Q1 reinvestment value
    // should increase by the Supplemental balance.
    const delta =
      withSupp.periods[0].reinvestment - baseline.periods[0].reinvestment;
    expect(delta).toBeCloseTo(2_000_000, 0);
  });

  it("disposition='interest': balance routes into Q1 availableInterest", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withSupp = runProjection({
      ...BASE_INPUTS(),
      initialSupplementalReserveBalance: 2_000_000,
      supplementalReserveDisposition: "interest",
    });
    const delta =
      withSupp.periods[0].interestCollected -
      baseline.periods[0].interestCollected;
    // Balance + yield (the four-account yield base includes Supplemental
    // regardless of disposition because cash sits in the account during the
    // period before the manager directs it).
    expect(delta).toBeGreaterThanOrEqual(2_000_000);
    expect(delta).toBeLessThan(2_100_000);
  });

  it("disposition='hold': only yield credited to interest, no balance contribution", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withSupp = runProjection({
      ...BASE_INPUTS(),
      initialSupplementalReserveBalance: 2_000_000,
      supplementalReserveDisposition: "hold",
    });
    // Q1 reinvestment unchanged — no principal-cash routing under "hold".
    expect(withSupp.periods[0].reinvestment).toBeCloseTo(
      baseline.periods[0].reinvestment,
      0,
    );
    // Q1 availableInterest gains ONLY the yield. Yield = balance × floored
    // base rate × dayfrac ≈ 2_000_000 × 0.02 × 0.25 = €10,000 at the test
    // fixture's default rate. The tight upper bound (< 30K) is the load-bearing
    // guard: any partial-leak of the balance into interest (the failure mode
    // a routing-condition typo would produce) blows past 30K, while legitimate
    // yield variation across base-rate / dayfrac stays well under. The lower
    // bound (> 0) confirms yield IS firing — not silently dropped.
    const interestDelta =
      withSupp.periods[0].interestCollected -
      baseline.periods[0].interestCollected;
    expect(interestDelta).toBeGreaterThan(0);
    expect(interestDelta).toBeLessThan(30_000);
  });

  it("disposition='hold': held balance continues to earn account yield after Q1", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withSupp = runProjection({
      ...BASE_INPUTS(),
      initialSupplementalReserveBalance: 2_000_000,
      supplementalReserveDisposition: "hold",
    });

    expect(withSupp.periods[1].interestCollected).toBeGreaterThan(
      baseline.periods[1].interestCollected,
    );
  });

  it("disposition='hold': terminal release at maturity flows the balance to equity (PPM Condition 3(j)(vi)(G)(1))", () => {
    // Under "hold" disposition the Supplemental Reserve balance is kept in
    // the account during the deal life and released at the terminal event
    // — here, the maturity period — to the Payment Account for distribution
    // via the Principal Priority of Payments. With zero defaults all rated
    // notes amortise to zero by maturity, so the released principal flows
    // through to the residual equity holder. Total equity distributions
    // under "hold" must exceed the no-Supplemental baseline by approximately
    // the held balance (+ a small yield-on-reserve term across the deal life).
    //
    // Failure mode this guards: the engine drops the balance on the floor
    // at maturity (manufactures a silent IRR understatement equal to the
    // entire Supplemental balance, undetected because no error is raised).
    const baseline = runProjection(BASE_INPUTS());
    const heldNoStress = runProjection({
      ...BASE_INPUTS(),
      initialSupplementalReserveBalance: 2_000_000,
      supplementalReserveDisposition: "hold",
    });
    const equityDelta =
      heldNoStress.totalEquityDistributions -
      baseline.totalEquityDistributions;
    expect(equityDelta).toBeGreaterThan(1_950_000);
  });

  it("disposition='hold': maturity-period principal proceeds jump by the held balance (release site)", () => {
    // Pin the release at the exact period (the maturity period) — guards
    // against a future change that releases somewhere else (e.g., into
    // interest at the final period, or smearing over multiple periods).
    const baseline = runProjection(BASE_INPUTS());
    const heldNoStress = runProjection({
      ...BASE_INPUTS(),
      initialSupplementalReserveBalance: 2_000_000,
      supplementalReserveDisposition: "hold",
    });
    const lastBaseline = baseline.periods[baseline.periods.length - 1];
    const lastHeld = heldNoStress.periods[heldNoStress.periods.length - 1];
    // `principalProceeds` on the period output is collateral cashflow
    // (prepayments + scheduledMaturities + recoveries) and excludes the
    // reserve release per the existing accel/normal symmetry. The release
    // shows up in the equity distribution at the terminal period.
    const finalEquityDelta =
      lastHeld.equityDistribution - lastBaseline.equityDistribution;
    expect(finalEquityDelta).toBeGreaterThan(1_950_000);
  });


  it("equityBookValue increases by the opening balance regardless of disposition", () => {
    const baseline = runProjection(BASE_INPUTS());
    for (const disp of ["principalCash", "interest", "hold"] as const) {
      const result = runProjection({
        ...BASE_INPUTS(),
        initialSupplementalReserveBalance: 2_000_000,
        supplementalReserveDisposition: disp,
      });
      expect(
        result.initialState.equityBookValue -
          baseline.initialState.equityBookValue,
      ).toBeCloseTo(2_000_000, 6);
    }
  });

  it("ocNumerator at T=0 is UNCHANGED for every disposition — Supplemental does NOT credit Adjusted CPA", () => {
    const baseline = runProjection(BASE_INPUTS());
    for (const disp of ["principalCash", "interest", "hold"] as const) {
      const result = runProjection({
        ...BASE_INPUTS(),
        initialSupplementalReserveBalance: 2_000_000,
        supplementalReserveDisposition: disp,
      });
      expect(result.initialState.ocNumerator).toBeCloseTo(
        baseline.initialState.ocNumerator,
        6,
      );
    }
  });
});

describe("openingAccountBalances on initialState — canonical T=0 emission", () => {
  it("Unused Proceeds Account credits equity book value, T=0 OC, and Q1 principal cash", () => {
    const baseline = runProjection({
      ...BASE_INPUTS(),
      reinvestmentPeriodEnd: null,
      postRpReinvestmentPct: 0,
    });
    const withUnused = runProjection({
      ...BASE_INPUTS(),
      reinvestmentPeriodEnd: null,
      postRpReinvestmentPct: 0,
      initialUnusedProceedsCash: 600,
    });

    const principalPaid = withUnused.periods[0].tranchePrincipal.reduce((s, p) => s + p.paid, 0);
    const baselinePrincipalPaid = baseline.periods[0].tranchePrincipal.reduce((s, p) => s + p.paid, 0);

    expect(withUnused.initialState.equityBookValue - baseline.initialState.equityBookValue).toBeCloseTo(600, 6);
    expect(withUnused.initialState.ocNumerator - baseline.initialState.ocNumerator).toBeCloseTo(600, 6);
    expect(principalPaid - baselinePrincipalPaid).toBeCloseTo(600, 6);
  });

  it("Unused Proceeds Account earns Q1 account yield like Principal Account cash", () => {
    const baseline = runProjection(BASE_INPUTS());
    const withUnused = runProjection({
      ...BASE_INPUTS(),
      initialUnusedProceedsCash: 1_000_000,
    });
    const delta = withUnused.periods[0].interestCollected - baseline.periods[0].interestCollected;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(15_000);
  });

  it("echoes input balances field-by-field; reads as the partner-facing T=0 row", () => {
    const result = runProjection({
      ...BASE_INPUTS(),
      initialPrincipalCash: 100,
      initialUnusedProceedsCash: 600,
      initialInterestAccountCash: 200,
      initialInterestSmoothingBalance: 300,
      initialSupplementalReserveBalance: 400,
      initialExpenseReserveBalance: 500,
    });
    expect(result.initialState.openingAccountBalances).toEqual({
      principalAccountCash: 100,
      unusedProceedsCash: 600,
      interestAccountCash: 200,
      interestSmoothingBalance: 300,
      supplementalReserveBalance: 400,
      expenseReserveBalance: 500,
    });
  });

  it("emits Q1 beginning period account balances for modeled opening account cash", () => {
    const result = runProjection({
      ...BASE_INPUTS(),
      initialPrincipalCash: 100,
      initialUnusedProceedsCash: 600,
      initialInterestAccountCash: 200,
      initialInterestSmoothingBalance: 300,
    });

    expect(result.periods[0].beginningPrincipalAccount).toBeCloseTo(700, 6);
    expect(result.periods[0].beginningInterestAccount).toBeCloseTo(500, 6);
  });

  it("zero by default (no inputs set)", () => {
    const result = runProjection(BASE_INPUTS());
    expect(result.initialState.openingAccountBalances).toEqual({
      principalAccountCash: 0,
      unusedProceedsCash: 0,
      interestAccountCash: 0,
      interestSmoothingBalance: 0,
      supplementalReserveBalance: 0,
      expenseReserveBalance: 0,
    });
  });
});

describe("Equity book value: balance-sheet identity sums all four reserves + signed principal cash", () => {
  it("all four reserves populated → equityBookValue increases by their sum", () => {
    const baseline = runProjection(BASE_INPUTS());
    const result = runProjection({
      ...BASE_INPUTS(),
      initialInterestAccountCash: 100_000,
      initialInterestSmoothingBalance: 200_000,
      initialSupplementalReserveBalance: 400_000,
      initialExpenseReserveBalance: 300_000,
    });
    expect(
      result.initialState.equityBookValue -
        baseline.initialState.equityBookValue,
    ).toBeCloseTo(1_000_000, 6);
  });
});
