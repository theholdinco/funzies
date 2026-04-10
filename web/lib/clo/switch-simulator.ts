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

  // Cash-adjusted par impact: selling at discount means fewer cash proceeds,
  // buying at premium means the cash buys less par than the notional suggests.
  // cashProceeds = sellPar * (sellPrice/100); parBought = cashProceeds / (buyPrice/100)
  const cashProceeds = sellLoan.parBalance * (sellPrice / 100);
  const parBought = cashProceeds / (buyPrice / 100);
  const parDelta = parBought - sellLoan.parBalance;

  // Adjust the buy loan's par balance to reflect what the cash actually buys
  const adjustedBuyLoan: ResolvedLoan = { ...buyLoan, parBalance: parBought };
  switchedLoans[switchedLoans.length - 1] = adjustedBuyLoan;

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
    spreadDelta: adjustedBuyLoan.spreadBps - sellLoan.spreadBps,
    ratingChange: { from: sellLoan.ratingBucket, to: adjustedBuyLoan.ratingBucket },
  };
}
