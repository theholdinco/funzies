/**
 * Sidecar types for the N1 waterfall-replay harness and N6 compliance-parity
 * harness. Option C architecture: resolver (`resolveWaterfallInputs`) emits
 * *model inputs* for the projection engine; this module carries *realized
 * actuals* (trustee reports, compliance outputs, account balances) used only
 * for verification and backtest. The engine stays agnostic to backtest data;
 * only the harness consumes both.
 *
 * Shape is a narrow projection of `context.json.raw.*` — one period's worth
 * of trustee-side state. For multi-period backtests (plan item D6b), pass an
 * array of these.
 */

export interface BacktestWaterfallStep {
  /** "INTEREST" or "PRINCIPAL". Null when the row is a summary/total line. */
  waterfallType: string | null;
  /** 1-based ordinal in the trustee report's step list. */
  priorityOrder: number | null;
  /** Trustee's human description, e.g. "(E)(1)" or "Sub Mgmt Fee". */
  description: string | null;
  amountDue: number | null;
  amountPaid: number | null;
  fundsAvailableBefore: number | null;
  fundsAvailableAfter: number | null;
  isOcTestDiversion: boolean | null;
  isIcTestDiversion: boolean | null;
}

export interface BacktestTrancheSnapshot {
  /** Class name as stored in `clo_tranches.class_name` (e.g. "Class A", "Subordinated Notes"). */
  className: string;
  interestPaid: number | null;
  principalPaid: number | null;
  endingBalance: number | null;
  interestShortfall: number | null;
  cumulativeShortfall: number | null;
  deferredInterestBalance: number | null;
  /** Base rate observed for the period (e.g., 3M EURIBOR). */
  currentIndexRate: number | null;
}

export interface BacktestComplianceTest {
  testName: string;
  /** e.g. "OC_PAR", "IC", "WARF", "WAL", "WAS", "RECOVERY", "DIVERSITY", "CONCENTRATION", "ELIGIBILITY", "INTEREST_DIVERSION". */
  testType: string | null;
  actualValue: number | null;
  triggerLevel: number | null;
  isPassing: boolean | null;
}

export interface BacktestAccountBalance {
  accountName: string;
  accountType: string | null;
  balanceAmount: number | null;
  accountInterest: number | null;
}

export interface BacktestInputs {
  /** Trustee determination date (e.g. "2026-04-01"). */
  reportDate: string | null;
  /** Payment date (e.g. "2026-04-15"). */
  paymentDate: string | null;
  /** Aggregate principal balance at period start, used for fee-rate checks. */
  beginningPar: number | null;
  waterfallSteps: BacktestWaterfallStep[];
  trancheSnapshots: BacktestTrancheSnapshot[];
  complianceTests: BacktestComplianceTest[];
  accountBalances: BacktestAccountBalance[];
}

/** Minimal view of the `raw` section of a context.json fixture — only the
 *  fields `buildBacktestInputs` reads. Accepts both the full `context.json`
 *  raw shape and a narrow subset. */
export interface BacktestRawSource {
  waterfallSteps?: Array<Partial<BacktestWaterfallStep> & { dataSource?: string | null }> | null;
  trancheSnapshots?: Array<{
    trancheId?: string;
    interestPaid?: number | null;
    principalPaid?: number | null;
    endingBalance?: number | null;
    interestShortfall?: number | null;
    cumulativeShortfall?: number | null;
    deferredInterestBalance?: number | null;
    currentIndexRate?: number | null;
  }> | null;
  tranches?: Array<{ id?: string; className?: string }> | null;
  complianceData?: {
    complianceTests?: BacktestComplianceTest[] | null;
    poolSummary?: { totalPrincipalBalance?: number | null } | null;
    /** Optional full concentration rows — not used by buildBacktestInputs,
     *  but typed here so test callers can access them on the raw source. */
    concentrations?: Array<{
      bucketName?: string | null;
      actualValue?: number | null;
      actualPct?: number | null;
    }> | null;
  } | null;
  accountBalances?: BacktestAccountBalance[] | null;
  dealDates?: {
    reportDate?: string | null;
    paymentDate?: string | null;
  } | null;
}

/** Build BacktestInputs from a context.json-shaped raw payload. Joins
 *  trancheSnapshots to tranches by id so each snapshot carries its class name
 *  directly. Tolerant of partial inputs — every field defaults to null if the
 *  source doesn't provide it. */
export function buildBacktestInputs(raw: BacktestRawSource): BacktestInputs {
  const trancheIdToClass = new Map<string, string>();
  for (const t of raw.tranches ?? []) {
    if (t.id && t.className) trancheIdToClass.set(t.id, t.className);
  }

  const trancheSnapshots: BacktestTrancheSnapshot[] = (raw.trancheSnapshots ?? []).map((s) => ({
    className: s.trancheId ? (trancheIdToClass.get(s.trancheId) ?? "(unknown)") : "(unknown)",
    interestPaid: s.interestPaid ?? null,
    principalPaid: s.principalPaid ?? null,
    endingBalance: s.endingBalance ?? null,
    interestShortfall: s.interestShortfall ?? null,
    cumulativeShortfall: s.cumulativeShortfall ?? null,
    deferredInterestBalance: s.deferredInterestBalance ?? null,
    currentIndexRate: s.currentIndexRate ?? null,
  }));

  const waterfallSteps: BacktestWaterfallStep[] = (raw.waterfallSteps ?? []).map((w) => ({
    waterfallType: w.waterfallType ?? null,
    priorityOrder: w.priorityOrder ?? null,
    description: w.description ?? null,
    amountDue: w.amountDue ?? null,
    amountPaid: w.amountPaid ?? null,
    fundsAvailableBefore: w.fundsAvailableBefore ?? null,
    fundsAvailableAfter: w.fundsAvailableAfter ?? null,
    isOcTestDiversion: w.isOcTestDiversion ?? null,
    isIcTestDiversion: w.isIcTestDiversion ?? null,
  }));

  return {
    reportDate: raw.dealDates?.reportDate ?? null,
    paymentDate: raw.dealDates?.paymentDate ?? null,
    beginningPar: raw.complianceData?.poolSummary?.totalPrincipalBalance ?? null,
    waterfallSteps,
    trancheSnapshots,
    complianceTests: raw.complianceData?.complianceTests ?? [],
    accountBalances: raw.accountBalances ?? [],
  };
}
