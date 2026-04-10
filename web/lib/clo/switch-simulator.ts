import type { ResolvedDealData, ResolvedLoan } from "./resolver-types";
import type { ProjectionInputs } from "./projection";
import { buildFromResolved, type UserAssumptions } from "./build-projection-inputs";

export interface SwitchParams {
  sellLoanIndex: number;
  sellParAmount: number; // how much par to sell (can be less than the full position for partial sales)
  buyLoan: ResolvedLoan; // the buy loan with its own par amount
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
  const { sellLoanIndex, sellParAmount, buyLoan, sellPrice, buyPrice } = params;
  const sellLoan = resolved.loans[sellLoanIndex];

  const baseInputs = buildFromResolved(resolved, assumptions);

  // Build switched loan pool
  const switchedLoans = [...resolved.loans];
  const actualSellPar = Math.min(sellParAmount, sellLoan.parBalance);

  if (actualSellPar >= sellLoan.parBalance - 0.01) {
    // Full sale — remove the loan entirely
    switchedLoans.splice(sellLoanIndex, 1);
  } else {
    // Partial sale — reduce the loan's par
    switchedLoans[sellLoanIndex] = { ...sellLoan, parBalance: sellLoan.parBalance - actualSellPar };
  }

  // Add buy loan with its specified par amount
  switchedLoans.push(buyLoan);

  // Par delta = buy par - sell par (straightforward, prices don't change par)
  const parDelta = buyLoan.parBalance - actualSellPar;

  // Recalculate WAC spread from the updated loan list
  const switchedTotalPar = switchedLoans.reduce((s, l) => s + l.parBalance, 0);
  const switchedWacSpreadBps = switchedTotalPar > 0
    ? switchedLoans.reduce((s, l) => s + l.spreadBps * l.parBalance, 0) / switchedTotalPar
    : resolved.poolSummary.wacSpreadBps;

  const switchedResolved: ResolvedDealData = {
    ...resolved,
    loans: switchedLoans,
    poolSummary: {
      ...resolved.poolSummary,
      totalPar: resolved.poolSummary.totalPar + parDelta,
      wacSpreadBps: switchedWacSpreadBps,
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
