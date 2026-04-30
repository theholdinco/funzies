/**
 * Diagnostic: run the projection engine for one or more periods on the
 * `new_context.json` snapshot and dump a step-by-step waterfall ledger.
 *
 * Each period prints two ledgers:
 *   1) Interest waterfall — every step that consumes `availableInterest`,
 *      ending with equityFromInterest. Sum should equal interestCollected.
 *   2) Principal waterfall — flows in (prepays, maturities, recoveries,
 *      initial cash) minus reinvestment and tranche paydowns; residual is
 *      equityFromPrincipal.
 *
 * Run:    DEAL_ID=4573778b-3967-4805-a544-9b58d465af4d \
 *         npx tsx scripts/debug-q1-waterfall.ts
 *
 * Or with a different context file:
 *   CTX=path/to/new_context.json npx tsx scripts/debug-q1-waterfall.ts
 *
 * Optional flags:
 *   PERIODS=4   (default 1) — number of periods to dump
 *   ENTRY_CENTS=95  (default 95) — sub-note entry price in cents
 *   FLOOR_NEG_CASH=1 — floor principalAccountCash at 0 before runProjection
 *                     (lets us A/B-test Fix #1 without modifying the engine)
 */

import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { runProjection } from "../lib/clo/projection";
import type { ProjectionInputs } from "../lib/clo/projection";
import type { ResolvedDealData } from "../lib/clo/resolver-types";
import { computeInceptionIrr } from "../lib/clo/services";
import {
  buildFromResolved,
  defaultsFromResolved,
  defaultsFromIntex,
  type UserAssumptions,
} from "../lib/clo/build-projection-inputs";
import type { IntexAssumptions } from "../lib/clo/intex/parse-past-cashflows";

function fmt(n: number | null | undefined, width = 16): string {
  if (n == null || !isFinite(n)) return String(n).padStart(width);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(width);
}

function row(label: string, amount: number, runningTotal?: number): string {
  const a = fmt(amount);
  const r = runningTotal != null ? `  → remaining ${fmt(runningTotal)}` : "";
  return `  ${label.padEnd(38)} ${a}${r}`;
}

async function main() {
  const ctxPath = resolvePath(process.env.CTX ?? "../new_context.json");
  const json = JSON.parse(readFileSync(ctxPath, "utf-8")) as {
    resolved: ResolvedDealData & { /* JSON is structurally compatible */ };
    raw: {
      trancheSnapshots?: unknown[];
      waterfallSteps?: unknown[];
      deal?: { intexAssumptions?: IntexAssumptions | null };
    };
  };
  const resolved = json.resolved;
  const raw = json.raw;

  // Optional A/B test of Fix #1: floor a negative principalAccountCash to 0
  // before handing it to the engine. The signed value remains in `resolved`
  // for OC-numerator tie-out semantics; this just blocks Q1's q1Cash from
  // going negative (the SDF determination-date overdraft gets cleared by
  // the upcoming payment date before Q1's accrual period begins).
  if (process.env.FLOOR_NEG_CASH === "1" && resolved.principalAccountCash < 0) {
    console.log(`[FLOOR_NEG_CASH] flooring principalAccountCash from ${resolved.principalAccountCash} → 0`);
    (resolved as { principalAccountCash: number }).principalAccountCash = 0;
  }

  console.log("=".repeat(78));
  console.log("CONTEXT");
  console.log("=".repeat(78));
  console.log(`  ctx file:               ${ctxPath}`);
  console.log(`  currentDate:            ${resolved.dates.currentDate}`);
  console.log(`  reinvestmentPeriodEnd:  ${resolved.dates.reinvestmentPeriodEnd}`);
  console.log(`  totalPar:               ${fmt(resolved.poolSummary.totalPar)}`);
  console.log(`  principalAccountCash:   ${fmt(resolved.principalAccountCash)}`);
  console.log(`  ddtlUnfundedPar:        ${fmt(resolved.ddtlUnfundedPar)}`);
  console.log(`  reinvOcTrigger:         ${JSON.stringify(resolved.reinvestmentOcTrigger)}`);
  console.log(`  ocTriggers:             ${resolved.ocTriggers.length} tests`);
  for (const t of resolved.ocTriggers) {
    console.log(`     ${(t.className).padEnd(6)} trigger=${t.triggerLevel.toFixed(2)}%  rank=${t.rank}`);
  }

  // Mirror ProjectionModel's pre-fill chain: defaultsFromResolved → defaultsFromIntex.
  // The raw snippet is what defaultsFromResolved looks at — only trancheSnapshots
  // and waterfallSteps; we cast loosely since we just need the shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawForDefaults = { trancheSnapshots: raw.trancheSnapshots as any, waterfallSteps: raw.waterfallSteps as any };
  let assumptions: UserAssumptions = defaultsFromResolved(resolved, rawForDefaults);
  if (raw.deal?.intexAssumptions) {
    assumptions = defaultsFromIntex(assumptions, raw.deal.intexAssumptions);
    console.log(`  intex pre-fill applied: cpr=${assumptions.cprPct}, cdr-broadcast, recovery=${assumptions.recoveryPct}, lag=${assumptions.recoveryLagMonths}, reinvSpread=${assumptions.reinvestmentSpreadBps}bps, reinvTenor=${assumptions.reinvestmentTenorYears}y`);
  } else {
    console.log("  intex pre-fill: none (no intexAssumptions on deal)");
  }

  // User-visible entry price (95c) — converts to absolute € cost basis like the UI.
  const entryCents = Number(process.env.ENTRY_CENTS ?? 95);
  const subNoteFace = resolved.tranches.find((t) => t.isIncomeNote)?.currentBalance ?? 0;
  assumptions.equityEntryPriceCents = entryCents;

  console.log(`  entry: ${entryCents}c  ×  subNoteFace ${fmt(subNoteFace)}  =  ${fmt(subNoteFace * entryCents / 100)} cost basis`);

  // Build ProjectionInputs. equityEntryPrice (absolute €) is folded in by buildFromResolved.
  const inputs: ProjectionInputs = buildFromResolved(resolved, assumptions);

  console.log(`  ProjectionInputs.initialPrincipalCash: ${fmt(inputs.initialPrincipalCash ?? 0)}`);
  console.log(`  ProjectionInputs.equityEntryPrice:     ${fmt(inputs.equityEntryPrice ?? 0)}`);

  // Run projection
  const result = runProjection(inputs);

  const periodsToShow = Math.min(Number(process.env.PERIODS ?? 1), result.periods.length);

  for (let p = 0; p < periodsToShow; p++) {
    const period = result.periods[p];
    const st = period.stepTrace;

    console.log("");
    console.log("=".repeat(78));
    console.log(`PERIOD ${period.periodNum}  date=${period.date}  isAccelerated=${period.isAccelerated}`);
    console.log("=".repeat(78));
    console.log("");
    console.log("POOL FLOW");
    console.log(row("beginningPar", period.beginningPar));
    console.log(row("− defaults", -period.defaults));
    console.log(row("− prepayments", -period.prepayments));
    console.log(row("− scheduledMaturities", -period.scheduledMaturities));
    console.log(row("+ reinvestment", period.reinvestment));
    console.log(row("= endingPar", period.endingPar));
    console.log("");
    console.log("LIABILITIES");
    console.log(row("beginningLiabilities", period.beginningLiabilities));
    console.log(row("endingLiabilities", period.endingLiabilities));

    console.log("");
    console.log("INTEREST WATERFALL");
    let avail = period.interestCollected;
    console.log(row("interestCollected", period.interestCollected, avail));
    avail -= st.taxes;          console.log(row("− (A.i) taxes", -st.taxes, avail));
    avail -= st.issuerProfit;   console.log(row("− (A.ii) issuer profit", -st.issuerProfit, avail));
    avail -= st.trusteeFeesPaid;console.log(row("− (B) trustee fees", -st.trusteeFeesPaid, avail));
    avail -= st.adminFeesPaid;  console.log(row("− (C) admin fees", -st.adminFeesPaid, avail));
    avail -= st.seniorMgmtFeePaid;console.log(row("− (E) senior mgmt fee", -st.seniorMgmtFeePaid, avail));
    avail -= st.hedgePaymentPaid;console.log(row("− (F) hedge payment", -st.hedgePaymentPaid, avail));
    let totalTrancheInterest = 0;
    for (const ti of period.trancheInterest) {
      avail -= ti.paid;
      totalTrancheInterest += ti.paid;
      console.log(row(`− ${ti.className} interest paid`, -ti.paid, avail));
    }
    if (st.ocCureDiversions.length > 0) {
      for (const d of st.ocCureDiversions) {
        avail -= d.amount;
        console.log(row(`− OC/IC cure rank=${d.rank} (${d.mode})`, -d.amount, avail));
      }
    }
    avail -= st.reinvOcDiversion;
    console.log(row("− (W) reinv OC diversion", -st.reinvOcDiversion, avail));
    avail -= st.subMgmtFeePaid;
    console.log(row("− (X) sub mgmt fee", -st.subMgmtFeePaid, avail));
    avail -= st.trusteeOverflowPaid;
    console.log(row("− (Y) trustee overflow", -st.trusteeOverflowPaid, avail));
    avail -= st.adminOverflowPaid;
    console.log(row("− (Z) admin overflow", -st.adminOverflowPaid, avail));
    avail -= st.incentiveFeeFromInterest;
    console.log(row("− (CC) incentive fee", -st.incentiveFeeFromInterest, avail));
    console.log(row("= (DD) equity from interest", st.equityFromInterest));
    const tieOutInt = avail - st.equityFromInterest;
    console.log(`  TIE-OUT (residual − equityFromInterest): ${fmt(tieOutInt)} (should be 0)`);

    console.log("");
    console.log("OC TESTS (post-period)");
    for (const oc of period.ocTests) {
      const flag = oc.passing ? "PASS" : "FAIL";
      const cushion = oc.actual - oc.trigger;
      console.log(`  ${(oc.className).padEnd(6)} actual=${oc.actual.toFixed(3)}%  trigger=${oc.trigger.toFixed(3)}%  ${flag}  cushion=${cushion.toFixed(3)}pp`);
    }
    console.log("");
    console.log("IC TESTS (post-period)");
    for (const ic of period.icTests) {
      const flag = ic.passing ? "PASS" : "FAIL";
      console.log(`  ${(ic.className).padEnd(6)} actual=${ic.actual.toFixed(3)}%  trigger=${ic.trigger.toFixed(3)}%  ${flag}`);
    }

    console.log("");
    console.log("PRINCIPAL WATERFALL");
    console.log(row("prepayments", period.prepayments));
    console.log(row("scheduledMaturities", period.scheduledMaturities));
    console.log(row("recoveries", period.recoveries));
    if (p === 0) console.log(row("+ initialPrincipalCash (q1Cash)", inputs.initialPrincipalCash ?? 0));
    console.log(row("− reinvestment", -period.reinvestment));
    let trancheParPaid = 0;
    for (const tp of period.tranchePrincipal) {
      if (tp.paid !== 0) {
        console.log(row(`− ${tp.className} principal paid`, -tp.paid));
        trancheParPaid += tp.paid;
      }
    }
    console.log(row("− (U) incentive fee from principal", -st.incentiveFeeFromPrincipal));
    console.log(row("= equity from principal", st.equityFromPrincipal));
    console.log(row("TOTAL EQUITY DISTRIBUTION", period.equityDistribution));
    console.log(`  (= equityFromInterest ${fmt(st.equityFromInterest)} + equityFromPrincipal ${fmt(st.equityFromPrincipal)})`);
  }

  console.log("");
  console.log("=".repeat(78));
  console.log("SUMMARY ACROSS ALL PERIODS");
  console.log("=".repeat(78));
  console.log(`  totalEquityDistributions: ${fmt(result.totalEquityDistributions)}`);
  console.log(`  equityIrr (annualized):   ${result.equityIrr != null ? (result.equityIrr * 100).toFixed(2) + "%" : "null"}`);
  console.log(`  totalDistributionsCount:  ${result.periods.filter(p => p.equityDistribution > 0).length} of ${result.periods.length}`);

  // ─── Equity book value (PR1 / Phase 1, I2) ─────────────────────────────────
  console.log("");
  console.log("=".repeat(78));
  console.log("EQUITY BOOK VALUE (canonical, from ProjectionInitialState)");
  console.log("=".repeat(78));
  console.log(`  equityBookValue:          ${fmt(result.initialState.equityBookValue)}`);
  console.log(`  equityWipedOut:           ${result.initialState.equityWipedOut}`);

  // ─── Inception-IRR (delegated to the service layer) ───────────────────────
  console.log("");
  console.log("=".repeat(78));
  console.log("INCEPTION-IRR (via web/lib/clo/services/inception-irr.ts)");
  console.log("=".repeat(78));

  const subTranche = resolved.tranches.find((t) => t.isIncomeNote);
  const subNotePar = subTranche?.originalBalance ?? subTranche?.currentBalance ?? 0;

  const rawAny = json.raw as unknown as {
    equityInceptionData?: { purchaseDate?: string; purchasePriceCents?: number };
    extractedDistributions?: Array<{ date: string; distribution: number }>;
    deal?: { closingDate?: string };
  };
  const userAnchorDate = rawAny.equityInceptionData?.purchaseDate ?? null;
  const userAnchorCents = rawAny.equityInceptionData?.purchasePriceCents ?? null;
  const closingDate = rawAny.deal?.closingDate ?? resolved.dates.firstPaymentDate ?? null;

  console.log(`  subNotePar:               ${fmt(subNotePar)}`);
  console.log(`  terminalValue (book):     ${fmt(result.initialState.equityBookValue)} @ ${resolved.dates.currentDate}`);
  console.log(`  closingDate:              ${closingDate}`);

  // Default-anchor IRR (no user override): primary uses closingDate at 100c.
  const defaultRun = computeInceptionIrr({
    subNotePar,
    equityBookValue: result.initialState.equityBookValue,
    equityWipedOut: result.initialState.equityWipedOut,
    closingDate,
    currentDate: resolved.dates.currentDate,
    userAnchor: null,
    historicalDistributions: rawAny.extractedDistributions ?? [],
    forwardDistributions: result.periods.map((p) => ({ date: p.date, amount: p.equityDistribution })),
  });
  // Note: `default IRR` here is the mark-to-book mode (`primary.irr` is kept
  // as a back-compat alias for `primary.markToBookIrr`). Post-v6 §3.2 ships
  // three modes in the partner UI; this script prints only mark-to-book for
  // brevity.
  if (defaultRun) {
    const irr = defaultRun.primary.irr;
    console.log(`  default IRR (100c, mark-to-book): ${irr != null ? (irr * 100).toFixed(2) + "%" : "null"} (${defaultRun.primary.distributionCount} distributions)`);
  }

  // User-override IRR + counterfactual when an override is present in context.
  if (userAnchorDate && userAnchorCents != null) {
    const userRun = computeInceptionIrr({
      subNotePar,
      equityBookValue: result.initialState.equityBookValue,
      equityWipedOut: result.initialState.equityWipedOut,
      closingDate,
      currentDate: resolved.dates.currentDate,
      userAnchor: { date: userAnchorDate, priceCents: userAnchorCents },
      historicalDistributions: rawAny.extractedDistributions ?? [],
      forwardDistributions: result.periods.map((p) => ({ date: p.date, amount: p.equityDistribution })),
    });
    const irr = userRun?.primary.irr;
    console.log(`  user override anchor:     ${userAnchorDate} @ ${userAnchorCents}c`);
    console.log(`  user IRR:                 ${irr != null ? (irr * 100).toFixed(2) + "%" : "null"} (${userRun?.primary.distributionCount ?? 0} distributions)`);
    if (userRun?.counterfactual) {
      const cIrr = userRun.counterfactual.irr;
      console.log(`  counterfactual:           ${cIrr != null ? (cIrr * 100).toFixed(2) + "%" : "null"} (${userRun.counterfactual.anchorDate} at ${userRun.counterfactual.anchorPriceCents}c, ${userRun.counterfactual.distributionCount} distributions)`);
    }
  } else {
    console.log(`  user override:            (none)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
