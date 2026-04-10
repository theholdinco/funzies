import type { ResolvedDealData, ResolvedLoan } from "./resolver-types";
import type { ProjectionInputs } from "./projection";
import { buildFromResolved, type UserAssumptions } from "./build-projection-inputs";

export interface SwitchParams {
  sellLoanIndex: number;
  buyLoan: ResolvedLoan;
  sellPrice: number; // percent of par, e.g. 98
  buyPrice: number; // percent of par, e.g. 101
}

export interface SwitchResult {
  baseInputs: ProjectionInputs;
  switchedInputs: ProjectionInputs;
  parDelta: number;
  spreadDelta: number;
  ratingChange: { from: string; to: string };
}

export function applySwitch(
  resolved: ResolvedDealData,
  params: SwitchParams,
  assumptions: UserAssumptions,
): SwitchResult {
  const { sellLoanIndex, buyLoan, sellPrice, buyPrice } = params;
  const sellLoan = resolved.loans[sellLoanIndex];

  const baseInputs = buildFromResolved(resolved, assumptions);

  // Clone loans, remove sell, add buy
  const switchedLoans = [...resolved.loans];
  switchedLoans.splice(sellLoanIndex, 1);
  switchedLoans.push(buyLoan);

  // Par impact: notional par change (not cash proceeds)
  const parDelta = buyLoan.parBalance - sellLoan.parBalance;

  const switchedResolved: ResolvedDealData = {
    ...resolved,
    loans: switchedLoans,
    poolSummary: {
      ...resolved.poolSummary,
      totalPar: resolved.poolSummary.totalPar + parDelta,
    },
  };

  const switchedInputs = buildFromResolved(switchedResolved, assumptions);

  return {
    baseInputs,
    switchedInputs,
    parDelta,
    spreadDelta: buyLoan.spreadBps - sellLoan.spreadBps,
    ratingChange: { from: sellLoan.ratingBucket, to: buyLoan.ratingBucket },
  };
}
