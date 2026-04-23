// Pure deterministic CLO waterfall projection engine — no React, no DOM.
// Runs entirely client-side for instant recalculation.

import { CLO_DEFAULTS } from "./defaults";

export interface LoanInput {
  parBalance: number;
  maturityDate: string;
  ratingBucket: string;
  spreadBps: number;
  isFixedRate?: boolean;
  fixedCouponPct?: number;
  isDelayedDraw?: boolean;
  ddtlSpreadBps?: number;
  drawQuarter?: number;
}

export type DefaultDrawFn = (survivingPar: number, hazardRate: number) => number;

export interface ProjectionInputs {
  initialPar: number;
  wacSpreadBps: number;
  baseRatePct: number;
  baseRateFloorPct: number; // floor on reference rate (e.g. 0 for EURIBOR floored at 0%)
  seniorFeePct: number;
  subFeePct: number;
  trusteeFeeBps: number; // Trustee + admin expenses (PPM Steps A-D), in bps p.a. on collateral par
  hedgeCostBps: number; // Scheduled hedge payments (PPM Step F), in bps p.a. on collateral par
  incentiveFeePct: number; // % of residual above IRR hurdle (PPM Steps BB/U), e.g. 20
  incentiveFeeHurdleIrr: number; // annualized IRR hurdle, e.g. 0.12 for 12%
  postRpReinvestmentPct: number; // % of principal proceeds reinvested post-RP (0-100, typically 0-50)
  callDate: string | null; // optional redemption date — if set, projection stops here and liquidates
  callPricePct: number; // liquidation price as % of par on call date (e.g. 100 = par, 98 = 2% discount)
  reinvestmentOcTrigger: { triggerLevel: number; rank: number; diversionPct: number } | null; // Reinvestment OC test — diversionPct % of remaining interest diverted during RP
  tranches: {
    className: string;
    currentBalance: number;
    spreadBps: number;
    seniorityRank: number;
    isFloating: boolean;
    isIncomeNote: boolean;
    isDeferrable: boolean;
    isAmortising?: boolean; // principal paid from interest waterfall on fixed schedule (e.g. Class X)
    amortisationPerPeriod?: number | null; // fixed amount per quarter (null = pay full remaining balance)
    amortStartDate?: string | null; // date when amort begins (e.g. second payment date). If null or past, amort active immediately.
  }[];
  ocTriggers: { className: string; triggerLevel: number; rank: number }[];
  icTriggers: { className: string; triggerLevel: number; rank: number }[];
  reinvestmentPeriodEnd: string | null;
  maturityDate: string | null;
  currentDate: string;
  loans: LoanInput[];
  defaultRatesByRating: Record<string, number>;
  cprPct: number;
  recoveryPct: number;
  recoveryLagMonths: number;
  reinvestmentSpreadBps: number;
  reinvestmentTenorQuarters: number;
  reinvestmentRating: string | null; // null = use portfolio modal
  cccBucketLimitPct: number; // CCC excess above this % of par is haircut in OC test
  cccMarketValuePct: number; // market value assumption for CCC excess haircut (% of par)
  deferredInterestCompounds: boolean; // whether PIK'd interest itself earns interest
  initialPrincipalCash?: number; // uninvested principal in accounts at projection start (flows through waterfall Q1)
  preExistingDefaultedPar?: number; // par of pre-existing defaulted loans
  preExistingDefaultRecovery?: number; // market-price recovery for priced defaulted holdings
  unpricedDefaultedPar?: number; // par of defaulted holdings without market price (model applies recoveryPct)
  preExistingDefaultOcValue?: number; // recovery value for OC numerator (agency rate — typically higher than market)
  discountObligationHaircut?: number; // net OC deduction for discount obligations (from trustee report)
  longDatedObligationHaircut?: number; // net OC deduction for long-dated obligations (from trustee report)
  impliedOcAdjustment?: number; // derived residual between trustee's Adjusted CPA and identified components
  quartersSinceReport?: number; // quarters between compliance report and projection start (adjusts default recovery timing)
  ddtlDrawPercent?: number; // % of DDTL par actually funded on draw (default 100)
  equityEntryPrice?: number; // user-specified entry price for equity IRR (overrides balance-sheet implied value)
}

/** Per-step waterfall emission for N1 harness comparison against trustee
 *  realized waterfall rows. All values here are already computed as local
 *  variables inside the period loop — this sub-object just exposes them
 *  on the output so the harness can tie out trustee vs engine step-by-step.
 *
 *  Trustee-step mapping (see web/lib/clo/ppm-step-map.ts):
 *    - trusteeFeesPaid        → PPM steps (B) + (C) (bundled until C3 splits; see KI-08)
 *    - seniorMgmtFeePaid      → PPM step (E) (current + past-due bundled)
 *    - hedgePaymentPaid       → PPM step (F) (non-defaulted hedge only)
 *    - subMgmtFeePaid         → PPM step (X)
 *    - incentiveFeeFromInterest → PPM step (CC) (interest waterfall)
 *    - incentiveFeeFromPrincipal → PPM step (U) (principal waterfall)
 *    - ocCureDiversions       → PPM steps (I)/(L)/(O)/(R)/(U) keyed by tranche rank
 *    - reinvOcDiversion       → PPM step (W) (Reinvestment OC Test diversion)
 *    - equityFromInterest     → PPM step (DD) (interest residual to sub notes)
 *    - equityFromPrincipal    → Principal waterfall residual to sub notes
 *    - deferredAccrualByTranche → PPM steps (K)/(N)/(Q)/(T) PIK additions this period
 */
export interface PeriodStepTrace {
  trusteeFeesPaid: number;
  seniorMgmtFeePaid: number;
  hedgePaymentPaid: number;
  subMgmtFeePaid: number;
  incentiveFeeFromInterest: number;
  incentiveFeeFromPrincipal: number;
  ocCureDiversions: Array<{ rank: number; mode: "reinvest" | "paydown"; amount: number }>;
  reinvOcDiversion: number;
  equityFromInterest: number;
  equityFromPrincipal: number;
  deferredAccrualByTranche: Record<string, number>;
}

export interface PeriodResult {
  periodNum: number;
  date: string;
  beginningPar: number;
  defaults: number;
  prepayments: number;
  scheduledMaturities: number;
  recoveries: number;
  reinvestment: number;
  endingPar: number;
  interestCollected: number;
  beginningLiabilities: number;
  endingLiabilities: number;
  trancheInterest: { className: string; due: number; paid: number }[];
  tranchePrincipal: { className: string; paid: number; endBalance: number }[];
  ocTests: { className: string; actual: number; trigger: number; passing: boolean }[];
  icTests: { className: string; actual: number; trigger: number; passing: boolean }[];
  equityDistribution: number;
  defaultsByRating: Record<string, number>;
  /** Per-step trace for N1 waterfall-replay harness. */
  stepTrace: PeriodStepTrace;
}

/** Beginning-of-period-1 snapshot — "as of the determination date" state
 *  BEFORE any forward-projection mutations (defaults, prepayments, paydowns,
 *  reinvestment). This is what trustee reports measure; the N6 harness ties
 *  these out against `raw.complianceData.complianceTests` at T=0.
 *  Expose as a separate field rather than periods[0] because periods[0] is
 *  post-Q1 end-state. */
export interface ProjectionInitialState {
  /** Pool par at period start (funded loans, excludes unfunded DDTL). */
  poolPar: number;
  /** OC numerator at period start (APB + principal cash − haircuts + adjustments). */
  ocNumerator: number;
  /** Per-class OC test actuals at T=0, matching trustee determination-date values. */
  ocTests: { className: string; actual: number; trigger: number; passing: boolean }[];
  /** Per-class IC test actuals at T=0. */
  icTests: { className: string; actual: number; trigger: number; passing: boolean }[];
}

export interface ProjectionResult {
  periods: PeriodResult[];
  equityIrr: number | null;
  totalEquityDistributions: number;
  tranchePayoffQuarter: Record<string, number | null>;
  /** T=0 snapshot for N6 compliance parity harness. */
  initialState: ProjectionInitialState;
}

export function validateInputs(inputs: ProjectionInputs): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (!inputs.tranches || inputs.tranches.length === 0) {
    errors.push({ field: "tranches", message: "Capital structure is required" });
  }
  if (!inputs.initialPar || inputs.initialPar <= 0) {
    errors.push({ field: "initialPar", message: "Current portfolio par amount is required" });
  }
  if (!inputs.maturityDate) {
    errors.push({ field: "maturityDate", message: "Deal maturity date is required for projection timeline" });
  }
  const missingSpread = inputs.tranches?.some(
    (t) => !t.isIncomeNote && (t.spreadBps === null || t.spreadBps === undefined)
  );
  if (missingSpread) {
    errors.push({ field: "trancheSpreads", message: "Tranche spread/coupon data needed for interest calculations" });
  }
  return errors;
}

export function quartersBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  return Math.ceil(months / 3);
}

export function addQuarters(dateIso: string, quarters: number): string {
  const d = new Date(dateIso);
  const origDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + quarters * 3);
  // If the day rolled forward (e.g. Jan 31 + 3mo → May 1), clamp to last day of target month
  if (d.getUTCDate() !== origDay) {
    d.setUTCDate(0); // last day of previous month
  }
  return d.toISOString().slice(0, 10);
}

// Helper: compute tranche coupon rate as a decimal
function trancheCouponRate(t: ProjectionInputs["tranches"][number], baseRatePct: number, baseRateFloorPct: number): number {
  // Floating: base rate (floored per deal terms) + spread. Fixed: spread represents the full coupon.
  return t.isFloating
    ? (Math.max(baseRateFloorPct, baseRatePct) + t.spreadBps / 100) / 100
    : t.spreadBps / 10000;
}

export function runProjection(inputs: ProjectionInputs, defaultDrawFn?: DefaultDrawFn): ProjectionResult {
  const {
    initialPar, wacSpreadBps, baseRatePct, baseRateFloorPct, seniorFeePct, subFeePct,
    trusteeFeeBps, hedgeCostBps, incentiveFeePct, incentiveFeeHurdleIrr,
    postRpReinvestmentPct, callDate, callPricePct, reinvestmentOcTrigger,
    tranches, ocTriggers, icTriggers,
    reinvestmentPeriodEnd, maturityDate, currentDate,
    loans, defaultRatesByRating, cprPct, recoveryPct, recoveryLagMonths,
    reinvestmentSpreadBps, reinvestmentTenorQuarters, reinvestmentRating: reinvestmentRatingOverride,
    cccBucketLimitPct, cccMarketValuePct, deferredInterestCompounds,
    initialPrincipalCash = 0, preExistingDefaultedPar = 0, preExistingDefaultRecovery = 0, unpricedDefaultedPar = 0, preExistingDefaultOcValue = 0,
    discountObligationHaircut = 0, longDatedObligationHaircut = 0, impliedOcAdjustment = 0, quartersSinceReport = 0,
    ddtlDrawPercent = 100,
  } = inputs;

  const maturityQuarters = maturityDate ? Math.max(1, quartersBetween(currentDate, maturityDate)) : CLO_DEFAULTS.defaultMaxTenorYears * 4;
  // If a call date is set, the projection ends at the earlier of call or maturity
  const callQuarters = callDate ? Math.max(1, quartersBetween(currentDate, callDate)) : null;
  const totalQuarters = callQuarters ? Math.min(callQuarters, maturityQuarters) : maturityQuarters;
  const recoveryLagQ = Math.max(0, Math.round(recoveryLagMonths / 3));

  // Pre-compute quarterly hazard rates per rating bucket
  const quarterlyHazard: Record<string, number> = {};
  for (const [rating, annualCDR] of Object.entries(defaultRatesByRating)) {
    const clamped = Math.max(0, Math.min(annualCDR, 99.99));
    quarterlyHazard[rating] = 1 - Math.pow(1 - clamped / 100, 0.25);
  }

  // Quarterly prepay rate
  const clampedCpr = Math.max(0, Math.min(cprPct, 99.99));
  const qPrepayRate = 1 - Math.pow(1 - clampedCpr / 100, 0.25);

  // Internal per-loan state
  interface LoanState {
    survivingPar: number;
    maturityQuarter: number;
    ratingBucket: string;
    spreadBps: number;
    isFixedRate?: boolean;
    fixedCouponPct?: number;
    isDelayedDraw?: boolean;
    ddtlSpreadBps?: number;
    drawQuarter?: number;
  }

  const loanStates: LoanState[] = loans.map((l) => ({
    survivingPar: l.parBalance,
    // Don't clamp to totalQuarters — loans with maturity beyond the call/maturity date
    // should NOT be treated as maturing at par. Instead, they remain as surviving par
    // that gets liquidated at callPricePct on the final period.
    maturityQuarter: Math.max(1, quartersBetween(currentDate, l.maturityDate)),
    ratingBucket: l.ratingBucket,
    spreadBps: l.spreadBps,
    isFixedRate: l.isFixedRate,
    fixedCouponPct: l.fixedCouponPct,
    isDelayedDraw: l.isDelayedDraw,
    ddtlSpreadBps: l.ddtlSpreadBps,
    drawQuarter: l.drawQuarter,
  }));

  // Remove never_draw DDTLs (drawQuarter <= 0) — they never fund and shouldn't appear in the portfolio
  for (let i = loanStates.length - 1; i >= 0; i--) {
    if (loanStates[i].isDelayedDraw && (loanStates[i].drawQuarter ?? 0) <= 0) {
      loanStates.splice(i, 1);
    }
  }

  const hasLoans = loanStates.length > 0;
  // Average loan size — used to chunk reinvestment into realistic individual loans for Monte Carlo.
  // Excludes unfunded DDTLs (already spliced for never_draw, still present for draw_at_deadline).
  const fundedLoans = loanStates.filter(l => !l.isDelayedDraw);
  const avgLoanSize = fundedLoans.length > 0
    ? fundedLoans.reduce((s, l) => s + l.survivingPar, 0) / fundedLoans.length
    : 0;

  // Reinvestment rating: user override or portfolio's par-weighted modal bucket (funded loans only)
  const reinvestmentRating = reinvestmentRatingOverride ?? (() => {
    const parByRating: Record<string, number> = {};
    for (const l of fundedLoans) {
      parByRating[l.ratingBucket] = (parByRating[l.ratingBucket] ?? 0) + l.survivingPar;
    }
    let best = "NR";
    let bestPar = 0;
    for (const [rating, par] of Object.entries(parByRating)) {
      // Tie-break alphabetically for deterministic results regardless of loan order
      if (par > bestPar || (par === bestPar && rating < best)) { best = rating; bestPar = par; }
    }
    return best;
  })();

  // Track tranche balances (debt outstanding per tranche)
  const trancheBalances: Record<string, number> = {};
  // Deferred interest that doesn't compound — tracked separately so it
  // doesn't earn interest, but IS included in OC denominator and paydown.
  const deferredBalances: Record<string, number> = {};
  const sortedTranches = [...tranches].sort((a, b) => a.seniorityRank - b.seniorityRank);
  const debtTranches = sortedTranches.filter((t) => !t.isIncomeNote);
  const resolvedAmortPerPeriod: Record<string, number> = {};
  for (const t of sortedTranches) {
    trancheBalances[t.className] = t.currentBalance;
    deferredBalances[t.className] = 0;
    if (t.isAmortising) {
      resolvedAmortPerPeriod[t.className] = t.amortisationPerPeriod ?? (t.currentBalance / CLO_DEFAULTS.defaultScheduledAmortPeriods);
    }
  }

  const ocTriggersByClass = ocTriggers;
  const icTriggersByClass = icTriggers;

  // Recovery pipeline: future cash from defaulted assets
  const recoveryPipeline: { quarter: number; amount: number }[] = [];

  // Seed recovery from pre-existing defaults (loans already defaulted before projection start).
  // Priced holdings: use market-price recovery. Unpriced holdings: use model recoveryPct.
  // Timing adjustment: if the compliance report is N quarters old, the default happened at least
  // N quarters ago, so the recovery is N quarters closer. Uses reportDate as proxy for default
  // date since exact default dates are rarely available in compliance reports.
  if (preExistingDefaultedPar > 0) {
    const totalRecovery = preExistingDefaultRecovery + unpricedDefaultedPar * (recoveryPct / 100);
    if (totalRecovery > 0) {
      const adjustedRecoveryQ = Math.max(1, 1 + recoveryLagQ - quartersSinceReport);
      recoveryPipeline.push({ quarter: adjustedRecoveryQ, amount: totalRecovery });
    }
  }

  // When loans are provided, use their total as the starting par (not the Adjusted CPA
  // which includes cash, haircuts, and other OC adjustments that are modeled separately).
  // Funded loan total excludes unfunded DDTLs — consistent with beginningPar/endingPar.
  const loanTotal = hasLoans ? loanStates.filter(l => !l.isDelayedDraw).reduce((s, l) => s + l.survivingPar, 0) : 0;
  let currentPar = hasLoans ? loanTotal : initialPar;
  const periods: PeriodResult[] = [];
  const equityCashFlows: number[] = [];

  const tranchePayoffQuarter: Record<string, number | null> = {};
  let totalEquityDistributions = 0;

  const totalDebtOutstanding = debtTranches.reduce((s, t) => s + t.currentBalance, 0);
  // Equity investment: user-specified entry price if provided, otherwise balance-sheet implied value.
  const totalAssets = hasLoans ? loanTotal + initialPrincipalCash : initialPar;
  const bookValue = Math.max(0, totalAssets - totalDebtOutstanding);
  const equityInvestment = inputs.equityEntryPrice != null && inputs.equityEntryPrice > 0
    ? inputs.equityEntryPrice
    : bookValue;
  equityCashFlows.push(-equityInvestment);

  for (const t of sortedTranches) {
    tranchePayoffQuarter[t.className] = null;
  }

  const rpEndDate = reinvestmentPeriodEnd ? new Date(reinvestmentPeriodEnd) : null;

  // ── T=0 snapshot for N6 harness (determination-date compliance parity) ──
  // Computed BEFORE the period loop runs. Uses initial trancheBalances (no
  // mutations), initial pool par, initial principal cash, agency default
  // adjustments, and haircuts — equivalent to what the trustee reports as
  // of the determination date.
  const initialState: ProjectionInitialState = (() => {
    const poolPar = hasLoans ? loanTotal : initialPar;
    const ocEligibleAtStart = debtTranches.filter((t) => !t.isAmortising);

    // Pre-existing default OC adjustment — same formula as the in-loop version
    // at period q=1 (before any recovery arrives).
    const preExistingCashRecovery = preExistingDefaultRecovery + unpricedDefaultedPar * (recoveryPct / 100);
    const adjustedArrivalQ = Math.max(1, 1 + recoveryLagQ - quartersSinceReport);
    const preExistingRecoveryStillPending = preExistingDefaultedPar > 0 && 1 < adjustedArrivalQ;
    const ocDefaultAdjustment = (preExistingDefaultOcValue > 0 && preExistingRecoveryStillPending)
      ? preExistingDefaultOcValue - preExistingCashRecovery
      : 0;
    // Pending recoveries arriving at or before q=1 (zero at T=0 since we haven't elapsed any period yet)
    const pendingRecoveryValue = 0;
    const currentDdtlUnfundedPar = hasLoans
      ? loanStates.filter(l => l.isDelayedDraw).reduce((s, l) => s + l.survivingPar, 0)
      : 0;
    const ocNumerator = poolPar + initialPrincipalCash + pendingRecoveryValue + ocDefaultAdjustment
      - discountObligationHaircut - longDatedObligationHaircut - impliedOcAdjustment - currentDdtlUnfundedPar;

    const ocTests: ProjectionInitialState["ocTests"] = ocTriggersByClass.map((oc) => {
      const debtAtAndAbove = ocEligibleAtStart
        .filter((t) => t.seniorityRank <= oc.rank)
        .reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);
      const actual = debtAtAndAbove > 0 ? (ocNumerator / debtAtAndAbove) * 100 : 999;
      return { className: oc.className, actual, trigger: oc.triggerLevel, passing: actual >= oc.triggerLevel };
    });

    // At T=0, the trustee IC test uses [Interest Collection − Senior Expenses
    // (A-D) − Senior Mgmt Fee (E) − Hedge Payments (F)] / [Interest Due on
    // senior tranches]. Replicate with initial pool par × effective rate for
    // the numerator base, minus the quarterly fees. Fees use the same formula
    // as the in-loop per-period deduction so pre-fill parity flows through.
    const scheduledInterestOnCollateral = poolPar * (wacSpreadBps / 10000 + baseRatePct / 100) / 4;
    const trusteeFeeAmountT0 = poolPar * (trusteeFeeBps / 10000) / 4;
    const seniorFeeAmountT0 = poolPar * (seniorFeePct / 100) / 4;
    const hedgeCostAmountT0 = poolPar * (hedgeCostBps / 10000) / 4;
    const interestAfterFeesT0 = Math.max(
      0,
      scheduledInterestOnCollateral - trusteeFeeAmountT0 - seniorFeeAmountT0 - hedgeCostAmountT0,
    );
    const icTests: ProjectionInitialState["icTests"] = icTriggersByClass.map((ic) => {
      const interestDueAtAndAbove = ocEligibleAtStart
        .filter((t) => t.seniorityRank <= ic.rank)
        .reduce((s, t) => s + trancheBalances[t.className] * trancheCouponRate(t, baseRatePct, baseRateFloorPct) / 4, 0);
      const actual = interestDueAtAndAbove > 0 ? (interestAfterFeesT0 / interestDueAtAndAbove) * 100 : 999;
      return { className: ic.className, actual, trigger: ic.triggerLevel, passing: actual >= ic.triggerLevel };
    });

    return { poolPar, ocNumerator, ocTests, icTests };
  })();

  const draw: DefaultDrawFn = defaultDrawFn ?? ((par, hz) => par * hz);
  for (let q = 1; q <= totalQuarters; q++) {
    const periodDate = addQuarters(currentDate, q);
    const inRP = rpEndDate ? new Date(periodDate) <= rpEndDate : false;
    const isMaturity = q === totalQuarters;

    // ── 1. Beginning par ──────────────────────────────────────────
    // ── 1b. DDTL draw event (before beginningPar capture) ──────────
    if (hasLoans) {
      for (const loan of loanStates) {
        if (!loan.isDelayedDraw) continue;
        if (q === loan.drawQuarter) {
          const fundedPar = loan.survivingPar * (ddtlDrawPercent / 100);
          loan.survivingPar = fundedPar;
          loan.spreadBps = loan.ddtlSpreadBps ?? 0;
          loan.isDelayedDraw = false;
        }
      }
    }

    // Beginning par excludes unfunded DDTLs — they are not deployed collateral
    // and should not be in the fee base (trustee, management, hedge fees).
    const beginningPar = hasLoans
      ? loanStates.filter(l => !l.isDelayedDraw).reduce((s, l) => s + l.survivingPar, 0)
      : currentPar;
    const beginningLiabilities = debtTranches.reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);

    // ── Step-trace accumulators (for N1 harness) ────────────────────────
    // Multi-site values (OC cure diversions, reinv OC diversion, PIK accrual)
    // need accumulation across the period. Single-site fee amounts are captured
    // directly at emission.
    const _stepTrace_ocCureDiversions: Array<{ rank: number; mode: "reinvest" | "paydown"; amount: number }> = [];
    let _stepTrace_reinvOcDiversion = 0;
    const _stepTrace_deferredAccrualByTranche: Record<string, number> = {};
    for (const t of debtTranches) _stepTrace_deferredAccrualByTranche[t.className] = 0;

    // Per-loan beginning par for interest calc (post-draw, so newly-funded DDTLs are included)
    const loanBeginningPar = hasLoans ? loanStates.map((l) => l.survivingPar) : [];

    // ── 2. Per-loan maturities (before defaults — maturing loans pay at par) ──
    let totalMaturities = 0;
    if (hasLoans) {
      for (const loan of loanStates) {
        if (loan.isDelayedDraw) continue;
        if (q === loan.maturityQuarter) {
          totalMaturities += loan.survivingPar;
          loan.survivingPar = 0;
        }
      }
    }

    // ── 3. Per-loan defaults (only on non-maturing surviving loans) ──
    let totalDefaults = 0;
    const defaultsByRating: Record<string, number> = {};

    if (hasLoans) {
      for (const loan of loanStates) {
        if (loan.survivingPar <= 0) continue;
        if (loan.isDelayedDraw) continue;
        const hazard = quarterlyHazard[loan.ratingBucket] ?? 0;
        const loanDefaults = draw(loan.survivingPar, hazard);
        loan.survivingPar -= loanDefaults;
        totalDefaults += loanDefaults;
        if (loanDefaults > 0) {
          defaultsByRating[loan.ratingBucket] = (defaultsByRating[loan.ratingBucket] ?? 0) + loanDefaults;
        }
      }
    }

    if (totalDefaults > 0 && recoveryPct > 0) {
      recoveryPipeline.push({ quarter: q + recoveryLagQ, amount: totalDefaults * (recoveryPct / 100) });
    }

    // ── 4. Per-loan prepayments ─────────────────────────────────────
    let totalPrepayments = 0;
    if (hasLoans) {
      for (const loan of loanStates) {
        if (loan.survivingPar > 0) {
          if (loan.isDelayedDraw) continue;
          const prepay = loan.survivingPar * qPrepayRate;
          loan.survivingPar -= prepay;
          totalPrepayments += prepay;
        }
      }
    }

    // ── Aggregate ──────────────────────────────────────────────────
    let defaults: number;
    let prepayments: number;
    const scheduledMaturities = totalMaturities;
    if (hasLoans) {
      defaults = totalDefaults;
      prepayments = totalPrepayments;
    } else {
      // Fallback: apply aggregate CDR/CPR to currentPar.
      // Without loan-level data, weight toward non-zero buckets (AAA/AA at 0% would
      // dilute the average if included equally with B/CCC).
      const allRates = Object.values(defaultRatesByRating);
      const avgAnnualCdr = allRates.length > 0
        ? allRates.reduce((s, v) => s + v, 0) / allRates.length
        : 0;
      const qHazard = 1 - Math.pow(1 - Math.min(avgAnnualCdr, 99.99) / 100, 0.25);
      defaults = currentPar * qHazard;
      currentPar -= defaults;
      prepayments = currentPar * qPrepayRate;
      currentPar -= prepayments;

      if (defaults > 0 && recoveryPct > 0) {
        recoveryPipeline.push({ quarter: q + recoveryLagQ, amount: defaults * (recoveryPct / 100) });
      }
    }

    // ── 5. Recoveries ───────────────────────────────────────────
    const recoveries = isMaturity
      ? recoveryPipeline.filter((r) => r.quarter >= q).reduce((s, r) => s + r.amount, 0)
      : recoveryPipeline.filter((r) => r.quarter === q).reduce((s, r) => s + r.amount, 0);

    // ── 6. Interest collection ─────────────────────────────────
    const flooredBaseRate = Math.max(baseRateFloorPct, baseRatePct);
    let interestCollected: number;
    if (hasLoans) {
      interestCollected = 0;
      for (let i = 0; i < loanStates.length; i++) {
        const loan = loanStates[i];
        if (loan.isDelayedDraw) continue;
        const loanBegPar = loanBeginningPar[i];
        if (loan.isFixedRate) {
          interestCollected += loanBegPar * (loan.fixedCouponPct ?? 0) / 100 / 4;
        } else {
          interestCollected += loanBegPar * (flooredBaseRate + loan.spreadBps / 100) / 100 / 4;
        }
      }
      // Q1: initial principal cash earns interest at money market rate (~ESTR) for the quarter.
      // This cash sits in accounts before being reinvested or paid down.
      if (q === 1 && initialPrincipalCash > 0) {
        // Cash in principal accounts earns MMF/ESTR yield, not EURIBOR. Using the floored
        // base rate as a proxy — ESTR tracks ~10-15bps below 3M EURIBOR, immaterial here.
        interestCollected += initialPrincipalCash * flooredBaseRate / 100 / 4;
      }
    } else {
      const allInRate = (flooredBaseRate + wacSpreadBps / 100) / 100;
      interestCollected = beginningPar * allInRate / 4;
    }

    // ── 7. Reinvestment ─────────────────────────────────────────
    // No reinvestment on the final period (call or maturity) — the deal is winding down.
    let reinvestment = 0;
    const principalProceeds = prepayments + scheduledMaturities + recoveries;
    // Q1: initial principal cash (uninvested proceeds already in accounts) treated as
    // additional principal proceeds — reinvested during RP, flows to paydown outside RP.
    // Policy: during RP, cash IS reinvested (manager has discretion to deploy).
    // Post-RP, cash goes to paydown only — the indenture restricts reinvestment to new
    // principal proceeds from the portfolio, not pre-existing account balances.
    const q1Cash = (q === 1) ? initialPrincipalCash : 0;
    const totalPrincipalAvailable = principalProceeds + q1Cash;
    if (!isMaturity && inRP) {
      reinvestment = totalPrincipalAvailable;
    } else if (!isMaturity && postRpReinvestmentPct > 0 && principalProceeds > 0) {
      // Post-RP limited reinvestment (credit improved/risk sales, unscheduled principal)
      reinvestment = principalProceeds * (postRpReinvestmentPct / 100);
    }
    if (reinvestment > 0 && hasLoans) {
      const matQ = q + reinvestmentTenorQuarters;
      // Split reinvestment into individual loans sized to the portfolio average.
      // Improves Monte Carlo accuracy: each loan defaults independently instead
      // of one giant loan going all-or-nothing.
      if (avgLoanSize > 0 && reinvestment > avgLoanSize * 1.5) {
        let remaining = reinvestment;
        while (remaining > 0) {
          const par = Math.min(avgLoanSize, remaining);
          loanStates.push({ survivingPar: par, ratingBucket: reinvestmentRating, spreadBps: reinvestmentSpreadBps, maturityQuarter: matQ, isFixedRate: false, isDelayedDraw: false });
          remaining -= par;
        }
      } else {
        loanStates.push({ survivingPar: reinvestment, ratingBucket: reinvestmentRating, spreadBps: reinvestmentSpreadBps, maturityQuarter: matQ, isFixedRate: false, isDelayedDraw: false });
      }
    }

    // Update currentPar from loan states or fallback.
    // Excludes unfunded DDTLs — they are not deployed collateral.
    if (hasLoans) {
      currentPar = loanStates.filter(l => !l.isDelayedDraw).reduce((s, l) => s + l.survivingPar, 0);
    } else {
      if (reinvestment > 0) {
        currentPar += reinvestment;
      }
    }

    let endingPar = hasLoans
      ? loanStates.filter(l => !l.isDelayedDraw).reduce((s, l) => s + l.survivingPar, 0)
      : currentPar;

    // ── 8. Preliminary principal paydown ─────────────────────────
    // Pay down tranches from principal proceeds BEFORE computing OC
    // tests so the ratios use post-paydown liability balances. This
    // avoids a false OC breach at the RP boundary where par drops
    // (no reinvestment) but liabilities haven't been reduced yet.
    //
    // IMPORTANT: Save BOP tranche balances first — interest DUE and
    // IC tests must use beginning-of-period balances since interest
    // accrues on the balance before any principal paydown.
    // PPM Steps A-D: Trustee/admin fees paid before senior management fee
    const trusteeFeeAmount = beginningPar * (trusteeFeeBps / 10000) / 4;
    // PPM Step E: Senior collateral management fee
    const seniorFeeAmount = beginningPar * (seniorFeePct / 100) / 4;
    // PPM Step F: Hedge payments
    const hedgeCostAmount = beginningPar * (hedgeCostBps / 10000) / 4;
    const totalSeniorExpenses = trusteeFeeAmount + seniorFeeAmount + hedgeCostAmount;
    const interestAfterFees = Math.max(0, interestCollected - totalSeniorExpenses);

    const bopTrancheBalances: Record<string, number> = {};
    for (const t of debtTranches) {
      bopTrancheBalances[t.className] = trancheBalances[t.className];
    }

    const liquidationProceeds = isMaturity ? endingPar * (callDate ? callPricePct / 100 : 1) : 0;
    let prelimPrincipal = prepayments + scheduledMaturities + recoveries + q1Cash - reinvestment + liquidationProceeds;
    if (prelimPrincipal < 0) prelimPrincipal = 0;
    if (isMaturity) {
      if (hasLoans) {
        for (const loan of loanStates) {
          loan.survivingPar = 0;
        }
      }
      currentPar = 0;
      endingPar = 0;
    }

    // Track principal paid per tranche across preliminary + diversion passes
    const principalPaid: Record<string, number> = {};
    for (const t of sortedTranches) {
      principalPaid[t.className] = 0;
    }

    // First pass: pay down from principal proceeds only
    // Deferred interest on a tranche is paid before its principal.
    // Amortising tranches (Class X) are SKIPPED during normal periods — they pay down
    // from interest proceeds. At maturity/call, all tranches are paid sequentially.
    let remainingPrelim = prelimPrincipal;
    for (const t of sortedTranches) {
      if (t.isIncomeNote || (t.isAmortising && !isMaturity)) continue;
      // Pay off deferred interest first, then principal
      const deferredPay = Math.min(deferredBalances[t.className], remainingPrelim);
      deferredBalances[t.className] -= deferredPay;
      remainingPrelim -= deferredPay;
      const principalPay = Math.min(trancheBalances[t.className], remainingPrelim);
      trancheBalances[t.className] -= principalPay;
      remainingPrelim -= principalPay;
      principalPaid[t.className] += deferredPay + principalPay;
    }

    // ── 9. Compute OC & IC ratios ────────────────────────────────
    // OC uses post-paydown balances (liability position after payments).
    // IC uses BOP balances (interest due accrued on beginning balance).
    //
    // Adjusted Collateral Principal Amount = ending par + principal account cash
    // + recovery value of defaulted-but-pending securities - CCC excess haircut
    // Principal account cash: uninvested principal sitting in accounts (remainingPrelim)
    // At maturity, all pending recoveries are already accelerated into `recoveries` (and thus
    // into prelimPrincipal/remainingPrelim), so don't count them again in the OC numerator.
    const pendingRecoveryValue = isMaturity ? 0 : recoveryPipeline
      .filter((r) => r.quarter > q)
      .reduce((s, r) => s + r.amount, 0);
    // OC numerator adjustment for pre-existing defaults: the trustee credits defaulted assets
    // at the lesser-of-agency recovery rate, which can be ABOVE or BELOW market price.
    // When agency > market: positive adjustment (trustee gives more OC credit than cash value).
    // When agency < market: negative adjustment (trustee caps OC credit below cash value).
    // Disappears when recovery arrives (adjusted for report staleness).
    const preExistingCashRecovery = preExistingDefaultRecovery + unpricedDefaultedPar * (recoveryPct / 100);
    const adjustedArrivalQ = Math.max(1, 1 + recoveryLagQ - quartersSinceReport);
    const preExistingRecoveryStillPending = preExistingDefaultedPar > 0 && !isMaturity && q < adjustedArrivalQ;
    // When agency data exists: adjust OC from cash value to agency value (can be negative).
    // When no agency data (preExistingDefaultOcValue = 0): no adjustment, use cash as-is.
    const ocDefaultAdjustment = (preExistingDefaultOcValue > 0 && preExistingRecoveryStillPending)
      ? preExistingDefaultOcValue - preExistingCashRecovery
      : 0;
    const currentDdtlUnfundedPar = hasLoans
      ? loanStates.filter(l => l.isDelayedDraw).reduce((s, l) => s + l.survivingPar, 0)
      : 0;
    let ocNumerator = endingPar + remainingPrelim + pendingRecoveryValue + ocDefaultAdjustment
      - discountObligationHaircut - longDatedObligationHaircut - impliedOcAdjustment - currentDdtlUnfundedPar;
    if (hasLoans && cccBucketLimitPct > 0) {
      const cccPar = loanStates
        .filter((l) => !l.isDelayedDraw && l.ratingBucket === "CCC" && l.survivingPar > 0)
        .reduce((s, l) => s + l.survivingPar, 0);
      const cccLimitAbs = endingPar * (cccBucketLimitPct / 100);
      const cccExcess = Math.max(0, cccPar - cccLimitAbs);
      if (cccExcess > 0) {
        // Haircut: replace par with market value for the excess amount
        const haircut = cccExcess * (1 - cccMarketValuePct / 100);
        ocNumerator -= haircut;
      }
    }

    const ocResults: PeriodResult["ocTests"] = [];
    const icResults: PeriodResult["icTests"] = [];

    // Amortising tranches (Class X) are excluded from OC/IC denominators per PPM definitions.
    // Par Value Ratio denominators only reference the rated notes (A through F), not Class X.
    const ocEligibleTranches = debtTranches.filter((t) => !t.isAmortising);

    for (const oc of ocTriggersByClass) {
      const debtAtAndAbove = ocEligibleTranches
        .filter((t) => t.seniorityRank <= oc.rank)
        .reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);
      const actual = debtAtAndAbove > 0 ? (ocNumerator / debtAtAndAbove) * 100 : 999;
      const passing = actual >= oc.triggerLevel;
      ocResults.push({ className: oc.className, actual, trigger: oc.triggerLevel, passing });
    }

    for (const ic of icTriggersByClass) {
      const interestDueAtAndAbove = ocEligibleTranches
        .filter((t) => t.seniorityRank <= ic.rank)
        .reduce((s, t) => s + bopTrancheBalances[t.className] * trancheCouponRate(t, baseRatePct, baseRateFloorPct) / 4, 0);
      const actual = interestDueAtAndAbove > 0 ? (interestAfterFees / interestDueAtAndAbove) * 100 : 999;
      const passing = actual >= ic.triggerLevel;
      icResults.push({ className: ic.className, actual, trigger: ic.triggerLevel, passing });
    }

    const failingOcRanks = new Set(
      ocTriggersByClass
        .filter((oc) => ocResults.some((r) => r.className === oc.className && !r.passing))
        .map((oc) => oc.rank)
    );
    const failingIcRanks = new Set(
      icTriggersByClass
        .filter((ic) => icResults.some((r) => r.className === ic.className && !r.passing))
        .map((ic) => ic.rank)
    );

    // ── 10. Interest waterfall (OC/IC-gated) ─────────────────────
    // Interest DUE uses BOP balances (accrued before paydown).
    // Class X interest is paid sequentially (earlier in the loop). Class X amortisation
    // and Class A interest are paid pro rata per PPM Step G if there is a shortfall.
    let availableInterest = interestCollected;
    const trancheInterest: PeriodResult["trancheInterest"] = [];

    // PPM Steps A-D: Taxes, trustee fees, admin expenses, expense reserve
    availableInterest -= Math.min(trusteeFeeAmount, availableInterest);
    // PPM Step E: Senior collateral management fee
    availableInterest -= Math.min(seniorFeeAmount, availableInterest);
    // PPM Step F: Hedge payments
    availableInterest -= Math.min(hedgeCostAmount, availableInterest);

    // Step G (PPM): Class X amort + Class A interest are paid pro rata / pari passu.
    // Class X amort starts on the second payment date (q >= 2) per PPM definition.
    // Compute Class X amort demand alongside the most senior non-amortising tranche
    // interest so they share proportionally in a shortfall scenario.
    const amortDemand: Record<string, number> = {};
    for (const t of debtTranches) {
      if (!t.isAmortising || trancheBalances[t.className] <= 0.01) continue;
      // Amort only active after the start date (e.g. second payment date per PPM)
      if (t.amortStartDate && new Date(periodDate) < new Date(t.amortStartDate)) continue;
      const scheduleAmt = resolvedAmortPerPeriod[t.className] ?? trancheBalances[t.className];
      amortDemand[t.className] = Math.min(scheduleAmt, trancheBalances[t.className]);
    }

    // Find the most senior non-amortising tranche rank (typically Class A)
    const seniorNonAmortRank = debtTranches.find((t) => !t.isAmortising)?.seniorityRank;

    let diverted = false;
    for (let di = 0; di < debtTranches.length; di++) {
      const t = debtTranches[di];
      const rate = trancheCouponRate(t, baseRatePct, baseRateFloorPct);
      const due = bopTrancheBalances[t.className] * rate / 4;

      // Step G (PPM): Class X interest, Class X amort, and Class A interest are
      // paid pro rata and pari passu. When we reach Class A's rank, pay all three
      // components proportionally if there's a shortfall.
      if (!diverted && seniorNonAmortRank != null && t.seniorityRank === seniorNonAmortRank) {
        const totalAmortDue = Object.values(amortDemand).reduce((s, v) => s + v, 0);
        // Class X interest was already paid above (earlier iteration). Here we handle
        // Class X amort + Class A interest as the remaining pari passu components.
        const totalStepGDue = totalAmortDue + due;
        if (totalStepGDue > 0 && totalStepGDue > availableInterest) {
          // Pro rata shortfall — split available funds between amort and Class A interest
          const ratio = availableInterest / totalStepGDue;
          for (const [cls, amt] of Object.entries(amortDemand)) {
            const amortPay = amt * ratio;
            trancheBalances[cls] -= amortPay;
            principalPaid[cls] += amortPay;
          }
          const interestPay = due * ratio;
          availableInterest = 0;
          trancheInterest.push({ className: t.className, due, paid: interestPay });
          continue; // skip the normal interest payment below
        } else {
          // Enough to pay both in full
          for (const [cls, amt] of Object.entries(amortDemand)) {
            trancheBalances[cls] -= amt;
            availableInterest -= amt;
            principalPaid[cls] += amt;
          }
          // Class A interest falls through to normal payment below
        }
      }

      if (diverted) {
        trancheInterest.push({ className: t.className, due, paid: 0 });
        // PIK: capitalize unpaid interest onto deferrable tranche balance
        // Only if the tranche still has outstanding principal (not fully redeemed)
        if (t.isDeferrable && due > 0 && bopTrancheBalances[t.className] > 0.01) {
          if (deferredInterestCompounds) {
            trancheBalances[t.className] += due;
          } else {
            deferredBalances[t.className] += due;
          }
        }
        continue;
      }

      const paid = Math.min(due, availableInterest);
      availableInterest -= paid;
      trancheInterest.push({ className: t.className, due, paid });
      // PIK: capitalize any shortfall onto deferrable tranche balance
      if (t.isDeferrable && paid < due && bopTrancheBalances[t.className] > 0.01) {
        const shortfall = due - paid;
        if (deferredInterestCompounds) {
          trancheBalances[t.className] += shortfall;
        } else {
          deferredBalances[t.className] += shortfall;
        }
        _stepTrace_deferredAccrualByTranche[t.className] = (_stepTrace_deferredAccrualByTranche[t.className] ?? 0) + shortfall;
      }

      // Only check diversion at rank boundaries — all tranches at the same rank must be paid first
      const nextTranche = debtTranches[di + 1];
      const atRankBoundary = !nextTranche || nextTranche.seniorityRank > t.seniorityRank;
      if (atRankBoundary && (failingOcRanks.has(t.seniorityRank) || failingIcRanks.has(t.seniorityRank))) {
        // Compute minimum diversion needed to cure the failing OC test.
        // PPM: divert "until the applicable Coverage Tests are satisfied."
        // OC = numerator / denominator >= trigger
        // During RP: diversion buys collateral → increases numerator
        //   Need: (numerator + x) / denominator >= trigger → x = trigger * denominator - numerator
        // Outside RP: diversion pays down senior tranches → decreases denominator
        //   Need: numerator / (denominator - x) >= trigger → x = denominator - numerator / trigger
        const failingOc = ocTriggersByClass.find(
          (oc) => oc.rank === t.seniorityRank && ocResults.some((r) => r.className === oc.className && !r.passing)
        );
        const failingIc = icTriggersByClass.find(
          (ic) => ic.rank === t.seniorityRank && icResults.some((r) => r.className === ic.className && !r.passing)
        );

        let cureAmount = 0;

        if (failingOc) {
          const debtAtAndAbove = ocEligibleTranches
            .filter((tr) => tr.seniorityRank <= failingOc.rank)
            .reduce((s, tr) => s + trancheBalances[tr.className] + deferredBalances[tr.className], 0);
          const trigger = failingOc.triggerLevel / 100; // convert from percentage to ratio
          if (inRP && !failingIc) {
            // OC-only during RP: diversion buys collateral → increases numerator
            cureAmount = Math.max(0, trigger * debtAtAndAbove - ocNumerator);
          } else {
            // Outside RP, or IC also failing (forces paydown): decreases denominator
            cureAmount = Math.max(0, debtAtAndAbove - ocNumerator / trigger);
          }
        }

        // IC cure: pay down notes to reduce interest due until IC is satisfied.
        // IC = interestAfterFees / interestDue >= trigger
        // Paying down tranche X reduces interestDue by (paydown * couponRate / 4).
        // Compute iteratively since paydown is sequential (most senior first).
        if (failingIc) {
          const icTriggerRatio = failingIc.triggerLevel / 100;
          const interestDueAtAndAbove = ocEligibleTranches
            .filter((tr) => tr.seniorityRank <= failingIc.rank)
            .reduce((s, tr) => s + bopTrancheBalances[tr.className] * trancheCouponRate(tr, baseRatePct, baseRateFloorPct) / 4, 0);
          const neededInterestDue = interestAfterFees / icTriggerRatio;
          const reductionNeeded = Math.max(0, interestDueAtAndAbove - neededInterestDue);

          if (reductionNeeded > 0) {
            // Compute how much principal paydown achieves the needed interest_due reduction.
            // Pay down most senior tranche first — each € reduces interestDue by couponRate/4.
            let reductionRemaining = reductionNeeded;
            let icCureAmount = 0;
            for (const tr of ocEligibleTranches.filter((tr) => tr.seniorityRank <= failingIc.rank)) {
              if (reductionRemaining <= 0) break;
              const couponPerPar = trancheCouponRate(tr, baseRatePct, baseRateFloorPct) / 4;
              if (couponPerPar <= 0) continue;
              const trancheAvailable = trancheBalances[tr.className] + deferredBalances[tr.className];
              const paydownForThisTranche = Math.min(reductionRemaining / couponPerPar, trancheAvailable);
              icCureAmount += paydownForThisTranche;
              reductionRemaining -= paydownForThisTranche * couponPerPar;
            }
            cureAmount = Math.max(cureAmount, icCureAmount);
          }
        }

        let diversion = Math.min(cureAmount, availableInterest);
        availableInterest -= diversion;
        if (availableInterest <= 0.01) diverted = true; // fully consumed → skip junior tranches

        if (diversion > 0) {
          const _mode: "reinvest" | "paydown" = inRP && !failingIc ? "reinvest" : "paydown";
          _stepTrace_ocCureDiversions.push({ rank: t.seniorityRank, mode: _mode, amount: diversion });
          if (inRP && !failingIc) {
            // During RP with OC-only failure: buy collateral to increase OC numerator
            currentPar += diversion;
            ocNumerator += diversion;
            if (hasLoans) {
              loanStates.push({
                survivingPar: diversion,
                ratingBucket: reinvestmentRating,
                spreadBps: reinvestmentSpreadBps,
                maturityQuarter: q + reinvestmentTenorQuarters,
                isFixedRate: false,
                isDelayedDraw: false,
              });
            }
          } else {
            // Outside RP, or IC failure: pay down senior tranches (reduces OC denominator / IC denominator)
            let remaining = diversion;
            for (const dt of sortedTranches) {
              if (dt.isIncomeNote || remaining <= 0) continue;
              const ddp = Math.min(deferredBalances[dt.className], remaining);
              deferredBalances[dt.className] -= ddp;
              remaining -= ddp;
              const dp = Math.min(trancheBalances[dt.className], remaining);
              trancheBalances[dt.className] -= dp;
              principalPaid[dt.className] += ddp + dp;
              remaining -= dp;
            }
          }
        }
      }
    }

    // PPM Step V: Reinvestment OC Test — divert a percentage of remaining interest during RP to buy collateral.
    // Evaluated after standard OC cures which may have bought collateral (updating ocNumerator).
    let reinvOcFailing = false;
    if (inRP && reinvestmentOcTrigger && availableInterest > 0) {
      const reinvOcDebt = ocEligibleTranches
        .filter((tr) => tr.seniorityRank <= reinvestmentOcTrigger.rank)
        .reduce((s, tr) => s + trancheBalances[tr.className] + deferredBalances[tr.className], 0);
      const reinvOcActual = reinvOcDebt > 0 ? (ocNumerator / reinvOcDebt) * 100 : 999;
      reinvOcFailing = reinvOcActual < reinvestmentOcTrigger.triggerLevel;
    }
    if (reinvOcFailing && availableInterest > 0) {
      const diversion = availableInterest * (reinvestmentOcTrigger!.diversionPct / 100);
      _stepTrace_reinvOcDiversion = diversion;
      availableInterest -= diversion;
      currentPar += diversion;
      if (hasLoans && diversion > 0) {
        loanStates.push({
          survivingPar: diversion,
          ratingBucket: reinvestmentRating,
          spreadBps: reinvestmentSpreadBps,
          maturityQuarter: q + reinvestmentTenorQuarters,
          isFixedRate: false,
          isDelayedDraw: false,
        });
      }
    }

    // Refresh endingPar after any RP OC diversion may have purchased collateral
    if (hasLoans) endingPar = loanStates.filter(l => !l.isDelayedDraw).reduce((s, l) => s + l.survivingPar, 0);
    else endingPar = currentPar;

    // PPM Step W: Subordinated management fee — paid after all debt tranches
    const subFeeAmount = beginningPar * (subFeePct / 100) / 4;
    availableInterest -= Math.min(subFeeAmount, availableInterest);

    // PPM Step BB: Incentive management fee — % of residual when equity IRR > hurdle.
    // Incentive fee is circular: the fee reduces equity distributions, which reduces
    // the IRR, which determines whether the fee should be charged. resolveIncentiveFee
    // handles this by checking three regimes — see function docstring.
    let incentiveFeeFromInterest = 0;
    if (incentiveFeePct > 0 && incentiveFeeHurdleIrr > 0 && availableInterest > 0) {
      incentiveFeeFromInterest = resolveIncentiveFee(
        equityCashFlows, availableInterest, incentiveFeePct, incentiveFeeHurdleIrr, 4
      );
      availableInterest -= incentiveFeeFromInterest;
    }

    const equityFromInterest = availableInterest;

    // ── 11. Build principal results ──────────────────────────────
    let availablePrincipal = remainingPrelim;

    const tranchePrincipal: PeriodResult["tranchePrincipal"] = [];
    for (const t of sortedTranches) {
      if (t.isIncomeNote) {
        tranchePrincipal.push({ className: t.className, paid: 0, endBalance: trancheBalances[t.className] });
        continue;
      }
      tranchePrincipal.push({ className: t.className, paid: principalPaid[t.className], endBalance: trancheBalances[t.className] + deferredBalances[t.className] });

      if (trancheBalances[t.className] + deferredBalances[t.className] <= 0.01 && tranchePayoffQuarter[t.className] === null) {
        tranchePayoffQuarter[t.className] = q;
      }
    }

    const endingLiabilities = debtTranches.reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);

    // PPM Step U: Incentive fee from principal proceeds (same IRR-gated circularity).
    // Compute total fee on combined interest+principal, then subtract what was already
    // taken from interest to get the incremental principal fee.
    let incentiveFeeFromPrincipal = 0;
    if (incentiveFeePct > 0 && incentiveFeeHurdleIrr > 0 && availablePrincipal > 0) {
      const preFeeInterestForEquity = equityFromInterest + incentiveFeeFromInterest;
      const totalAvailable = preFeeInterestForEquity + availablePrincipal;
      const totalFee = resolveIncentiveFee(
        equityCashFlows, totalAvailable, incentiveFeePct, incentiveFeeHurdleIrr, 4
      );
      incentiveFeeFromPrincipal = Math.max(0, totalFee - incentiveFeeFromInterest);
      availablePrincipal -= incentiveFeeFromPrincipal;
    }

    // Capture equity-from-principal residual BEFORE it's summed into equityDistribution,
    // so the stepTrace separates PPM step (DD) (interest residual) from principal residual.
    const equityFromPrincipal = availablePrincipal;
    const equityDistribution = equityFromInterest + equityFromPrincipal;
    totalEquityDistributions += equityDistribution;
    equityCashFlows.push(equityDistribution);

    periods.push({
      periodNum: q,
      date: periodDate,
      beginningPar,
      defaults,
      prepayments,
      scheduledMaturities,
      recoveries,
      reinvestment,
      endingPar,
      beginningLiabilities,
      endingLiabilities,
      interestCollected,
      trancheInterest,
      tranchePrincipal,
      ocTests: ocResults,
      icTests: icResults,
      equityDistribution,
      defaultsByRating,
      stepTrace: {
        trusteeFeesPaid: trusteeFeeAmount,
        seniorMgmtFeePaid: seniorFeeAmount,
        hedgePaymentPaid: hedgeCostAmount,
        subMgmtFeePaid: subFeeAmount,
        incentiveFeeFromInterest,
        incentiveFeeFromPrincipal,
        ocCureDiversions: _stepTrace_ocCureDiversions,
        reinvOcDiversion: _stepTrace_reinvOcDiversion,
        equityFromInterest,
        equityFromPrincipal,
        deferredAccrualByTranche: _stepTrace_deferredAccrualByTranche,
      },
    });

    // Prune exhausted loans to keep iteration cost O(active loans) per period.
    // Critical for Monte Carlo performance where thousands of runs accumulate dead entries.
    if (hasLoans) {
      let write = 0;
      for (let read = 0; read < loanStates.length; read++) {
        if (loanStates[read].survivingPar > 0) loanStates[write++] = loanStates[read];
      }
      loanStates.length = write;
    }

    // Stop early if all debt paid off and collateral is depleted
    const remainingDebt = debtTranches.reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);
    if (remainingDebt <= 0.01 && endingPar <= 0.01) break;
  }

  const equityIrr = calculateIrr(equityCashFlows, 4);

  return { periods, equityIrr, totalEquityDistributions, tranchePayoffQuarter, initialState };
}

/**
 * Solve the incentive fee circularity: find the fee F such that
 * the post-fee equity IRR is consistent with the fee being charged.
 *
 * Three regimes:
 *   1. Pre-fee IRR ≤ hurdle → F = 0
 *   2. Full fee AND post-fee IRR > hurdle → F = available × feePct/100
 *   3. Full fee pushes IRR below hurdle → bisect to find F where post-fee IRR ≈ hurdle
 */
function resolveIncentiveFee(
  priorCashFlows: number[],
  availableAmount: number,
  feePct: number,
  hurdleIrr: number,
  periodsPerYear: number,
): number {
  const cf = [...priorCashFlows, availableAmount];
  const lastIdx = cf.length - 1;

  // Regime 1: no fee needed
  const preFeeIrr = calculateIrr(cf, periodsPerYear);
  if (preFeeIrr === null || preFeeIrr <= hurdleIrr) return 0;

  // Regime 2: full flat fee
  const fullFee = availableAmount * (feePct / 100);
  cf[lastIdx] = availableAmount - fullFee;
  const postFullFeeIrr = calculateIrr(cf, periodsPerYear);
  if (postFullFeeIrr !== null && postFullFeeIrr >= hurdleIrr) return fullFee;

  // Regime 3: bisect — full fee pushes IRR below hurdle
  let lo = 0;
  let hi = fullFee;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    cf[lastIdx] = availableAmount - mid;
    const midIrr = calculateIrr(cf, periodsPerYear);
    if (midIrr === null || midIrr < hurdleIrr) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return lo;
}

export function calculateIrr(cashFlows: number[], periodsPerYear: number = 4): number | null {
  if (cashFlows.length < 2) return null;
  if (cashFlows.every((cf) => cf >= 0) || cashFlows.every((cf) => cf <= 0)) return null;

  // Newton-Raphson on periodic rate, then annualize
  let rate = 0.05;

  let converged = false;
  for (let iter = 0; iter < 200; iter++) {
    let npv = 0;
    let dNpv = 0;
    for (let i = 0; i < cashFlows.length; i++) {
      const discount = Math.pow(1 + rate, i);
      npv += cashFlows[i] / discount;
      dNpv -= (i * cashFlows[i]) / Math.pow(1 + rate, i + 1);
    }
    if (Math.abs(dNpv) < 1e-12) break;
    const newRate = rate - npv / dNpv;
    if (Math.abs(newRate - rate) < 1e-9) {
      rate = newRate;
      converged = true;
      break;
    }
    rate = newRate;
    // Guard against divergence
    if (rate < -0.99) rate = -0.99;
    if (rate > 10) rate = 10;
  }

  if (!converged) return null;

  // Annualize: (1 + periodic)^periodsPerYear - 1
  const annualized = Math.pow(1 + rate, periodsPerYear) - 1;
  if (!isFinite(annualized) || isNaN(annualized)) return null;
  return annualized;
}

export interface SensitivityRow {
  assumption: string;
  base: string;
  down: string;
  up: string;
  downIrr: number | null;
  upIrr: number | null;
}

export function computeSensitivity(
  baseInputs: ProjectionInputs,
  baseIrr: number | null,
): SensitivityRow[] {
  const scenarios: { assumption: string; base: string; down: string; up: string; makeDown: () => ProjectionInputs; makeUp: () => ProjectionInputs }[] = [
    {
      assumption: "CDR (uniform)",
      base: formatSensPct(avgCdr(baseInputs.defaultRatesByRating)),
      down: formatSensPct(Math.max(0, avgCdr(baseInputs.defaultRatesByRating) - 1)),
      up: formatSensPct(avgCdr(baseInputs.defaultRatesByRating) + 1),
      makeDown: () => ({ ...baseInputs, defaultRatesByRating: shiftAllRates(baseInputs.defaultRatesByRating, -1) }),
      makeUp: () => ({ ...baseInputs, defaultRatesByRating: shiftAllRates(baseInputs.defaultRatesByRating, 1) }),
    },
    {
      assumption: "CPR",
      base: formatSensPct(baseInputs.cprPct),
      down: formatSensPct(Math.max(0, baseInputs.cprPct - 5)),
      up: formatSensPct(baseInputs.cprPct + 5),
      makeDown: () => ({ ...baseInputs, cprPct: Math.max(0, baseInputs.cprPct - 5) }),
      makeUp: () => ({ ...baseInputs, cprPct: baseInputs.cprPct + 5 }),
    },
    {
      assumption: "Base Rate",
      base: formatSensPct(baseInputs.baseRatePct),
      down: formatSensPct(Math.max(0, baseInputs.baseRatePct - 1)),
      up: formatSensPct(baseInputs.baseRatePct + 1),
      makeDown: () => ({ ...baseInputs, baseRatePct: Math.max(0, baseInputs.baseRatePct - 1) }),
      makeUp: () => ({ ...baseInputs, baseRatePct: baseInputs.baseRatePct + 1 }),
    },
    {
      assumption: "Recovery Rate",
      base: formatSensPct(baseInputs.recoveryPct),
      down: formatSensPct(Math.max(0, baseInputs.recoveryPct - 10)),
      up: formatSensPct(Math.min(100, baseInputs.recoveryPct + 10)),
      makeDown: () => ({ ...baseInputs, recoveryPct: Math.max(0, baseInputs.recoveryPct - 10) }),
      makeUp: () => ({ ...baseInputs, recoveryPct: Math.min(100, baseInputs.recoveryPct + 10) }),
    },
    {
      assumption: "Reinvestment Spread",
      base: `${baseInputs.reinvestmentSpreadBps} bps`,
      down: `${Math.max(0, baseInputs.reinvestmentSpreadBps - 50)} bps`,
      up: `${baseInputs.reinvestmentSpreadBps + 50} bps`,
      makeDown: () => ({ ...baseInputs, reinvestmentSpreadBps: Math.max(0, baseInputs.reinvestmentSpreadBps - 50) }),
      makeUp: () => ({ ...baseInputs, reinvestmentSpreadBps: baseInputs.reinvestmentSpreadBps + 50 }),
    },
  ];

  const rows: SensitivityRow[] = scenarios.map((s) => {
    if (baseIrr === null) {
      return { assumption: s.assumption, base: s.base, down: s.down, up: s.up, downIrr: null, upIrr: null };
    }
    const downResult = runProjection(s.makeDown());
    const upResult = runProjection(s.makeUp());
    return {
      assumption: s.assumption,
      base: s.base,
      down: s.down,
      up: s.up,
      downIrr: downResult.equityIrr,
      upIrr: upResult.equityIrr,
    };
  });

  rows.sort((a, b) => {
    const impactA = Math.max(Math.abs((a.downIrr ?? 0) - (baseIrr ?? 0)), Math.abs((a.upIrr ?? 0) - (baseIrr ?? 0)));
    const impactB = Math.max(Math.abs((b.downIrr ?? 0) - (baseIrr ?? 0)), Math.abs((b.upIrr ?? 0) - (baseIrr ?? 0)));
    return impactB - impactA;
  });

  return rows;
}

function formatSensPct(val: number): string {
  return `${val.toFixed(1)}%`;
}

function avgCdr(rates: Record<string, number>): number {
  const vals = Object.values(rates);
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
}

function shiftAllRates(rates: Record<string, number>, delta: number): Record<string, number> {
  const shifted: Record<string, number> = {};
  for (const [k, v] of Object.entries(rates)) {
    shifted[k] = Math.max(0, v + delta);
  }
  return shifted;
}
