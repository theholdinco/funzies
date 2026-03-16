// Pure deterministic CLO waterfall projection engine — no React, no DOM.
// Runs entirely client-side for instant recalculation.

export interface LoanInput {
  parBalance: number;
  maturityDate: string;
  ratingBucket: string;
  spreadBps: number;
}

export interface ProjectionInputs {
  initialPar: number;
  wacSpreadBps: number;
  baseRatePct: number;
  seniorFeePct: number;
  subFeePct: number;
  tranches: {
    className: string;
    currentBalance: number;
    spreadBps: number;
    seniorityRank: number;
    isFloating: boolean;
    isIncomeNote: boolean;
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
}

export interface ProjectionResult {
  periods: PeriodResult[];
  equityIrr: number | null;
  totalEquityDistributions: number;
  tranchePayoffQuarter: Record<string, number | null>;
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
    (t) => !t.isIncomeNote && (t.spreadBps === null || t.spreadBps === undefined || t.spreadBps === 0)
  );
  if (missingSpread) {
    errors.push({ field: "trancheSpreads", message: "Tranche spread/coupon data needed for interest calculations" });
  }
  return errors;
}

export function quartersBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  return Math.ceil(months / 3);
}

export function addQuarters(dateIso: string, quarters: number): string {
  const d = new Date(dateIso);
  d.setMonth(d.getMonth() + quarters * 3);
  return d.toISOString().slice(0, 10);
}

// Helper: compute tranche coupon rate as a decimal
function trancheCouponRate(t: ProjectionInputs["tranches"][number], baseRatePct: number): number {
  // Floating: base rate + spread. Fixed: spread represents the full coupon.
  return t.isFloating
    ? (baseRatePct + t.spreadBps / 100) / 100
    : t.spreadBps / 10000;
}

export function runProjection(inputs: ProjectionInputs): ProjectionResult {
  const {
    initialPar, wacSpreadBps, baseRatePct, seniorFeePct, subFeePct,
    tranches, ocTriggers, icTriggers,
    reinvestmentPeriodEnd, maturityDate, currentDate,
    loans, defaultRatesByRating, cprPct, recoveryPct, recoveryLagMonths,
    reinvestmentSpreadBps, reinvestmentTenorQuarters, reinvestmentRating: reinvestmentRatingOverride,
  } = inputs;

  const totalQuarters = maturityDate ? Math.max(1, quartersBetween(currentDate, maturityDate)) : 40;
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
  }

  const loanStates: LoanState[] = loans.map((l) => ({
    survivingPar: l.parBalance,
    maturityQuarter: Math.max(1, Math.min(quartersBetween(currentDate, l.maturityDate), totalQuarters)),
    ratingBucket: l.ratingBucket,
    spreadBps: l.spreadBps,
  }));

  const hasLoans = loanStates.length > 0;

  // Reinvestment rating: user override or portfolio's par-weighted modal bucket
  const reinvestmentRating = reinvestmentRatingOverride ?? (() => {
    const parByRating: Record<string, number> = {};
    for (const l of loans) {
      parByRating[l.ratingBucket] = (parByRating[l.ratingBucket] ?? 0) + l.parBalance;
    }
    let best = "NR";
    let bestPar = 0;
    for (const [rating, par] of Object.entries(parByRating)) {
      if (par > bestPar) { best = rating; bestPar = par; }
    }
    return best;
  })();

  // Track tranche balances (debt outstanding per tranche)
  const trancheBalances: Record<string, number> = {};
  const sortedTranches = [...tranches].sort((a, b) => a.seniorityRank - b.seniorityRank);
  const debtTranches = sortedTranches.filter((t) => !t.isIncomeNote);
  for (const t of sortedTranches) {
    trancheBalances[t.className] = t.currentBalance;
  }

  const ocTriggersByClass = ocTriggers;
  const icTriggersByClass = icTriggers;

  // Recovery pipeline: future cash from defaulted assets
  const recoveryPipeline: { quarter: number; amount: number }[] = [];

  let currentPar = initialPar;
  const periods: PeriodResult[] = [];
  const equityCashFlows: number[] = [];

  const tranchePayoffQuarter: Record<string, number | null> = {};
  let totalEquityDistributions = 0;

  const totalDebtOutstanding = debtTranches.reduce((s, t) => s + t.currentBalance, 0);
  const equityInvestment = Math.max(0, initialPar - totalDebtOutstanding);
  equityCashFlows.push(-equityInvestment);

  for (const t of sortedTranches) {
    tranchePayoffQuarter[t.className] = null;
  }

  const rpEndDate = reinvestmentPeriodEnd ? new Date(reinvestmentPeriodEnd) : null;

  for (let q = 1; q <= totalQuarters; q++) {
    const periodDate = addQuarters(currentDate, q);
    const inRP = rpEndDate ? new Date(periodDate) <= rpEndDate : false;
    const isMaturity = q === totalQuarters;

    // ── 1. Beginning par ──────────────────────────────────────────
    const beginningPar = hasLoans
      ? loanStates.reduce((s, l) => s + l.survivingPar, 0)
      : currentPar;
    const beginningLiabilities = debtTranches.reduce((s, t) => s + trancheBalances[t.className], 0);

    // Save per-loan beginning par for interest calc
    const loanBeginningPar = hasLoans ? loanStates.map((l) => l.survivingPar) : [];

    // ── 2. Per-loan defaults ────────────────────────────────────────
    let totalDefaults = 0;
    const defaultsByRating: Record<string, number> = {};

    if (hasLoans) {
      for (const loan of loanStates) {
        const hazard = quarterlyHazard[loan.ratingBucket] ?? 0;
        const loanDefaults = loan.survivingPar * hazard;
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

    // ── 3. Per-loan maturities ──────────────────────────────────────
    let totalMaturities = 0;
    if (hasLoans) {
      for (const loan of loanStates) {
        if (q === loan.maturityQuarter) {
          totalMaturities += loan.survivingPar;
          loan.survivingPar = 0;
        }
      }
    }

    // ── 4. Per-loan prepayments ─────────────────────────────────────
    let totalPrepayments = 0;
    if (hasLoans) {
      for (const loan of loanStates) {
        if (loan.survivingPar > 0) {
          const prepay = loan.survivingPar * qPrepayRate;
          loan.survivingPar -= prepay;
          totalPrepayments += prepay;
        }
      }
    }

    // ── Aggregate ──────────────────────────────────────────────────
    const defaults = hasLoans ? totalDefaults : currentPar * 0;
    const scheduledMaturities = totalMaturities;
    const prepayments = hasLoans ? totalPrepayments : 0;

    if (!hasLoans) {
      // Fallback: no per-loan tracking, just keep currentPar stable (no defaults/prepay/maturity)
    }

    // ── 5. Recoveries ───────────────────────────────────────────
    const recoveries = isMaturity
      ? recoveryPipeline.filter((r) => r.quarter >= q).reduce((s, r) => s + r.amount, 0)
      : recoveryPipeline.filter((r) => r.quarter === q).reduce((s, r) => s + r.amount, 0);

    // ── 6. Interest collection ─────────────────────────────────
    let interestCollected: number;
    if (hasLoans) {
      interestCollected = 0;
      for (let i = 0; i < loanStates.length; i++) {
        const loan = loanStates[i];
        const loanBegPar = loanBeginningPar[i];
        interestCollected += loanBegPar * (baseRatePct + loan.spreadBps / 100) / 100 / 4;
      }
    } else {
      const allInRate = (baseRatePct + wacSpreadBps / 100) / 100;
      interestCollected = beginningPar * allInRate / 4;
    }

    // ── 7. Reinvestment ─────────────────────────────────────────
    let reinvestment = 0;
    if (inRP) {
      reinvestment = prepayments + scheduledMaturities + recoveries;
      if (hasLoans && reinvestment > 0) {
        loanStates.push({
          survivingPar: reinvestment,
          ratingBucket: reinvestmentRating,
          spreadBps: reinvestmentSpreadBps,
          maturityQuarter: Math.min(q + reinvestmentTenorQuarters, totalQuarters),
        });
      }
    }

    // Update currentPar from loan states or fallback
    if (hasLoans) {
      currentPar = loanStates.reduce((s, l) => s + l.survivingPar, 0);
      if (inRP) {
        // currentPar already includes reinvested loans
      }
    } else {
      if (inRP) {
        currentPar += reinvestment;
      }
    }

    let endingPar = hasLoans
      ? loanStates.reduce((s, l) => s + l.survivingPar, 0)
      : currentPar;

    // ── 8. Preliminary principal paydown ─────────────────────────
    // Pay down tranches from principal proceeds BEFORE computing OC
    // tests so the ratios use post-paydown liability balances. This
    // avoids a false OC breach at the RP boundary where par drops
    // (no reinvestment) but liabilities haven't been reduced yet.
    const seniorFeeAmount = beginningPar * (seniorFeePct / 100) / 4;
    const interestAfterFees = Math.max(0, interestCollected - seniorFeeAmount);

    const liquidationProceeds = isMaturity ? endingPar : 0;
    let prelimPrincipal = prepayments + scheduledMaturities + recoveries - reinvestment + liquidationProceeds;
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
    let remainingPrelim = prelimPrincipal;
    for (const t of sortedTranches) {
      if (t.isIncomeNote) continue;
      const paid = Math.min(trancheBalances[t.className], remainingPrelim);
      trancheBalances[t.className] -= paid;
      principalPaid[t.className] += paid;
      remainingPrelim -= paid;
    }

    // ── 9. Compute OC & IC ratios (post-paydown balances) ─────
    const ocResults: PeriodResult["ocTests"] = [];
    const icResults: PeriodResult["icTests"] = [];

    for (const oc of ocTriggersByClass) {
      const debtAtAndAbove = debtTranches
        .filter((t) => t.seniorityRank <= oc.rank)
        .reduce((s, t) => s + trancheBalances[t.className], 0);
      const actual = debtAtAndAbove > 0 ? (endingPar / debtAtAndAbove) * 100 : 999;
      const passing = actual >= oc.triggerLevel;
      ocResults.push({ className: oc.className, actual, trigger: oc.triggerLevel, passing });
    }

    for (const ic of icTriggersByClass) {
      const interestDueAtAndAbove = debtTranches
        .filter((t) => t.seniorityRank <= ic.rank)
        .reduce((s, t) => s + trancheBalances[t.className] * trancheCouponRate(t, baseRatePct) / 4, 0);
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
    let availableInterest = interestCollected;
    const trancheInterest: PeriodResult["trancheInterest"] = [];

    availableInterest -= Math.min(seniorFeeAmount, availableInterest);

    let diverted = false;
    for (const t of debtTranches) {
      if (diverted) {
        const rate = trancheCouponRate(t, baseRatePct);
        const due = trancheBalances[t.className] * rate / 4;
        trancheInterest.push({ className: t.className, due, paid: 0 });
        continue;
      }

      const rate = trancheCouponRate(t, baseRatePct);
      const due = trancheBalances[t.className] * rate / 4;
      const paid = Math.min(due, availableInterest);
      availableInterest -= paid;
      trancheInterest.push({ className: t.className, due, paid });

      if (failingOcRanks.has(t.seniorityRank) || failingIcRanks.has(t.seniorityRank)) {
        // Divert remaining interest to pay down senior tranches
        let diversion = availableInterest;
        availableInterest = 0;
        diverted = true;
        for (const dt of sortedTranches) {
          if (dt.isIncomeNote || diversion <= 0) continue;
          const dp = Math.min(trancheBalances[dt.className], diversion);
          trancheBalances[dt.className] -= dp;
          principalPaid[dt.className] += dp;
          diversion -= dp;
        }
      }
    }

    // Subordinated management fee — paid after all debt tranches, before equity
    const subFeeAmount = beginningPar * (subFeePct / 100) / 4;
    availableInterest -= Math.min(subFeeAmount, availableInterest);

    const equityFromInterest = availableInterest;

    // ── 11. Build principal results ──────────────────────────────
    let availablePrincipal = remainingPrelim;

    const tranchePrincipal: PeriodResult["tranchePrincipal"] = [];
    for (const t of sortedTranches) {
      if (t.isIncomeNote) {
        tranchePrincipal.push({ className: t.className, paid: 0, endBalance: trancheBalances[t.className] });
        continue;
      }
      tranchePrincipal.push({ className: t.className, paid: principalPaid[t.className], endBalance: trancheBalances[t.className] });

      if (trancheBalances[t.className] <= 0.01 && tranchePayoffQuarter[t.className] === null) {
        tranchePayoffQuarter[t.className] = q;
      }
    }

    const endingLiabilities = debtTranches.reduce((s, t) => s + trancheBalances[t.className], 0);

    const equityDistribution = equityFromInterest + availablePrincipal;
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
    });

    // Stop early if all debt paid off and collateral is depleted
    const remainingDebt = debtTranches.reduce((s, t) => s + trancheBalances[t.className], 0);
    if (remainingDebt <= 0.01 && endingPar <= 0.01) break;
  }

  const equityIrr = calculateIrr(equityCashFlows, 4);

  return { periods, equityIrr, totalEquityDistributions, tranchePayoffQuarter };
}

export function calculateIrr(cashFlows: number[], periodsPerYear: number = 4): number | null {
  if (cashFlows.length < 2) return null;
  if (cashFlows.every((cf) => cf >= 0) || cashFlows.every((cf) => cf <= 0)) return null;

  // Newton-Raphson on periodic rate, then annualize
  let rate = 0.05;

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
      break;
    }
    rate = newRate;
    // Guard against divergence
    if (rate < -0.99) rate = -0.99;
    if (rate > 10) rate = 10;
  }

  // Annualize: (1 + periodic)^periodsPerYear - 1
  const annualized = Math.pow(1 + rate, periodsPerYear) - 1;
  if (!isFinite(annualized) || isNaN(annualized)) return null;
  return annualized;
}
