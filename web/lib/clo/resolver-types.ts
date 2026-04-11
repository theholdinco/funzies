export interface ResolvedReinvestmentOcTrigger {
  triggerLevel: number;
  rank: number;
  diversionPct: number; // % of remaining interest diverted when test fails (e.g. 50 for 50%)
}

export interface ResolvedDealData {
  tranches: ResolvedTranche[];
  poolSummary: ResolvedPool;
  ocTriggers: ResolvedTrigger[];
  icTriggers: ResolvedTrigger[];
  reinvestmentOcTrigger: ResolvedReinvestmentOcTrigger | null;
  dates: ResolvedDates;
  fees: ResolvedFees;
  loans: ResolvedLoan[];
  deferredInterestCompounds: boolean; // whether PIK'd interest itself earns interest in subsequent periods
  baseRateFloorPct: number | null; // extracted reference rate floor (null = not extracted, use default)
}

export type ResolvedSource = "db_tranche" | "ppm" | "snapshot" | "manual";

export interface ResolvedTranche {
  className: string;
  currentBalance: number;
  originalBalance: number;
  spreadBps: number;
  seniorityRank: number;
  isFloating: boolean;
  isIncomeNote: boolean;
  isDeferrable: boolean;
  isAmortising: boolean;
  amortisationPerPeriod: number | null;
  amortStartDate: string | null; // when amort begins (null = active immediately)
  source: ResolvedSource;
}

export interface ResolvedPool {
  totalPar: number;
  wacSpreadBps: number;
  warf: number;
  walYears: number;
  diversityScore: number;
  numberOfObligors: number;
}

export interface ResolvedTrigger {
  className: string;
  triggerLevel: number;
  rank: number;
  testType: "OC" | "IC";
  source: "compliance" | "ppm";
}

export interface ResolvedDates {
  maturity: string;
  reinvestmentPeriodEnd: string | null;
  nonCallPeriodEnd: string | null;
  firstPaymentDate: string | null;
  currentDate: string;
}

export interface ResolvedFees {
  seniorFeePct: number;
  subFeePct: number;
  trusteeFeeBps: number; // Trustee + admin expenses (PPM Steps B-C), in bps p.a.
  incentiveFeePct: number; // Incentive management fee as % of residual above IRR hurdle (e.g. 20)
  incentiveFeeHurdleIrr: number; // IRR hurdle for incentive fee (annualized, e.g. 0.12 for 12%)
}

export interface ResolvedLoan {
  parBalance: number;
  maturityDate: string;
  ratingBucket: string;
  spreadBps: number;
  obligorName?: string;
}

export type WarningSeverity = "info" | "warn" | "error";

export interface ResolutionWarning {
  field: string;
  message: string;
  severity: WarningSeverity;
  resolvedFrom?: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface Fix {
  field: string;
  message: string;
  before: unknown;
  after: unknown;
}
