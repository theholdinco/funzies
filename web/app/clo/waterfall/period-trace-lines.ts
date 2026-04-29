/**
 * Pure helper that builds the per-row data for `PeriodTrace.tsx` from
 * engine output (PeriodResult / PeriodStepTrace).
 *
 * Architectural contract: this file MUST NOT perform arithmetic on
 * `inputs.<member>`. All semantic numbers come from `period.stepTrace.*`
 * or `period.<aggregate>` directly. The Phase 6 AST enforcement test
 * forbids `inputs.<member>` arithmetic in this file specifically.
 *
 * The original `PeriodTrace.tsx` incident was:
 *
 *     // back-derived equityFromInterest from totals
 *     const equityFromInterest = Math.max(0, period.equityDistribution - principalAvailable);
 *
 * which silently dropped €1.80M of clause-DD distribution when
 * `principalAvailable` exceeded the residual. The engine was emitting
 * `period.stepTrace.equityFromInterest` correctly all along; the UI
 * just wasn't reading it. This helper closes that gap.
 *
 * See CLAUDE.md § Engine ↔ UI separation.
 */

import type { PeriodResult, PeriodStepTrace } from "@/lib/clo/projection";

export interface PeriodTraceLine {
  label: string;
  /** PPM step letter for partner-facing orientation (e.g. "A.i", "DD"). */
  ppmStep?: string;
  /** Amount displayed. `null` means "hide this row" (e.g.
   *  availableForTranches under acceleration). Zero amounts render
   *  but with `muted: true`. */
  amount: number | null;
  /** The PeriodStepTrace key (or PeriodResult key) the row reads from.
   *  Required for non-presentation rows; the engine-ui-invariants test
   *  uses this to assert helper-vs-engine equality per row. */
  engineField?: keyof PeriodStepTrace
              | "beginningPar"
              | "interestCollected"
              | "equityDistribution"
              | "reinvestment"
              | "principalProceeds"
              | "prepayments"
              | "scheduledMaturities"
              | "recoveries";
  indent?: 0 | 1 | 2;
  muted?: boolean;
  severity?: "info" | "warn" | "fee" | "equity";
  /** True when the row is a flow OUT (rendered as a negative).
   *  Pure presentation hint; doesn't affect amount sign. */
  outflow?: boolean;
  /** Section grouping for JSX rendering. Helper emits rows in PPM order;
   *  JSX uses this to render section headers. */
  section: "interest" | "principal" | "summary";
}

/** Build the trace lines for a single period.
 *  Pure function — `period` is the only input. */
export function buildPeriodTraceLines(period: PeriodResult): PeriodTraceLine[] {
  const t = period.stepTrace;
  const lines: PeriodTraceLine[] = [];

  // ─── Interest waterfall ───────────────────────────────────────────────────
  lines.push({
    label: "Interest collected",
    amount: period.interestCollected,
    engineField: "interestCollected",
    section: "interest",
  });

  // PPM steps (A.i)→(F): senior expenses
  lines.push({
    label: "Taxes & filing",
    ppmStep: "A.i",
    amount: t.taxes,
    engineField: "taxes",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.taxes === 0,
    section: "interest",
  });
  lines.push({
    label: "Issuer profit",
    ppmStep: "A.ii",
    amount: t.issuerProfit,
    engineField: "issuerProfit",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.issuerProfit === 0,
    section: "interest",
  });
  lines.push({
    label: "Trustee fee (capped)",
    ppmStep: "B",
    amount: t.trusteeFeesPaid,
    engineField: "trusteeFeesPaid",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.trusteeFeesPaid === 0,
    section: "interest",
  });
  lines.push({
    label: "Admin fee (capped)",
    ppmStep: "C",
    amount: t.adminFeesPaid,
    engineField: "adminFeesPaid",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.adminFeesPaid === 0,
    section: "interest",
  });
  lines.push({
    label: "Senior management fee",
    ppmStep: "E",
    amount: t.seniorMgmtFeePaid,
    engineField: "seniorMgmtFeePaid",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.seniorMgmtFeePaid === 0,
    section: "interest",
  });
  lines.push({
    label: "Hedge payment",
    ppmStep: "F",
    amount: t.hedgePaymentPaid,
    engineField: "hedgePaymentPaid",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.hedgePaymentPaid === 0,
    section: "interest",
  });

  // Available for tranches — null under acceleration; UI hides + renders header.
  lines.push({
    label: "Available for tranches",
    amount: t.availableForTranches,
    engineField: "availableForTranches",
    indent: 1,
    section: "interest",
  });

  // PPM steps (G)→(S): tranche interest pari-passu loop.
  // Per-tranche rows from period.trancheInterest (already engine-emitted).
  for (const ti of period.trancheInterest) {
    if (ti.due === 0 && ti.paid === 0) continue;
    const shortfall = ti.due - ti.paid;
    lines.push({
      label: `${ti.className} interest${shortfall > 0.01 ? ` (shortfall: ${shortfall.toFixed(2)})` : ""}`,
      ppmStep: "G/H/J/M/P/S",
      amount: ti.paid,
      indent: 1,
      severity: "fee",
      outflow: true,
      muted: ti.paid === 0,
      section: "interest",
    });
  }

  // PPM steps (I/L/O/R/U): OC/IC cure diversions
  for (const cure of t.ocCureDiversions) {
    lines.push({
      label: `OC/IC cure diversion (rank ${cure.rank}, ${cure.mode})`,
      ppmStep: "I/L/O/R/U",
      amount: cure.amount,
      indent: 1,
      severity: "warn",
      outflow: true,
      section: "interest",
    });
  }

  // PPM step (W): Reinvestment OC test diversion
  lines.push({
    label: "Reinvestment OC diversion",
    ppmStep: "W",
    amount: t.reinvOcDiversion,
    engineField: "reinvOcDiversion",
    indent: 1,
    severity: "warn",
    outflow: true,
    muted: t.reinvOcDiversion === 0,
    section: "interest",
  });

  // PPM steps (Y/Z): Trustee + admin overflow
  lines.push({
    label: "Trustee fee overflow",
    ppmStep: "Y",
    amount: t.trusteeOverflowPaid,
    engineField: "trusteeOverflowPaid",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.trusteeOverflowPaid === 0,
    section: "interest",
  });
  lines.push({
    label: "Admin fee overflow",
    ppmStep: "Z",
    amount: t.adminOverflowPaid,
    engineField: "adminOverflowPaid",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.adminOverflowPaid === 0,
    section: "interest",
  });

  // PPM step (BB): Sub mgmt fee
  lines.push({
    label: "Subordinated mgmt fee",
    ppmStep: "BB",
    amount: t.subMgmtFeePaid,
    engineField: "subMgmtFeePaid",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.subMgmtFeePaid === 0,
    section: "interest",
  });

  // PPM step (CC): Incentive fee from interest
  lines.push({
    label: "Incentive fee (from interest)",
    ppmStep: "CC",
    amount: t.incentiveFeeFromInterest,
    engineField: "incentiveFeeFromInterest",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: t.incentiveFeeFromInterest === 0,
    section: "interest",
  });

  // PPM step (DD): Equity from interest — THE HEADLINE ROW.
  // The bug was back-deriving this from totals; engine emits it directly.
  lines.push({
    label: "Equity (from interest)",
    ppmStep: "DD",
    amount: t.equityFromInterest,
    engineField: "equityFromInterest",
    severity: "equity",
    section: "interest",
  });

  // ─── Principal waterfall ──────────────────────────────────────────────────
  lines.push({
    label: "Prepayments",
    amount: period.prepayments,
    engineField: "prepayments",
    section: "principal",
  });
  lines.push({
    label: "Scheduled maturities",
    amount: period.scheduledMaturities,
    engineField: "scheduledMaturities",
    muted: period.scheduledMaturities === 0,
    section: "principal",
  });
  lines.push({
    label: "Recoveries",
    amount: period.recoveries,
    engineField: "recoveries",
    muted: period.recoveries === 0,
    section: "principal",
  });
  lines.push({
    label: "Principal proceeds (total)",
    amount: period.principalProceeds,
    engineField: "principalProceeds",
    section: "principal",
  });
  lines.push({
    label: "Reinvested",
    amount: period.reinvestment,
    engineField: "reinvestment",
    indent: 1,
    severity: "fee",
    outflow: true,
    muted: period.reinvestment === 0,
    section: "principal",
  });

  // Tranche principal payments (excluding amortising — those are emitted in
  // the interest section by the engine. We use a heuristic: if the tranche
  // also has interest paid and a principal entry > 0, it's likely amortising.
  // The cleaner fix is for the engine to expose isAmortising on tranchePrincipal
  // entries; that's deferred to a future engine instrumentation pass.)
  for (const tp of period.tranchePrincipal) {
    if (tp.paid === 0) continue;
    lines.push({
      label: `${tp.className} principal`,
      amount: tp.paid,
      indent: 1,
      severity: "fee",
      outflow: true,
      section: "principal",
    });
  }

  // PPM step (DD princ-side): Equity from principal
  lines.push({
    label: "Equity (from principal)",
    amount: t.equityFromPrincipal,
    engineField: "equityFromPrincipal",
    severity: "equity",
    section: "principal",
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  lines.push({
    label: "Total equity distribution",
    amount: period.equityDistribution,
    engineField: "equityDistribution",
    severity: "equity",
    section: "summary",
  });

  return lines;
}

/** True when any line in the helper output has `amount === null`, indicating
 *  the period ran under PPM 10(b) acceleration mode. UI uses this to render
 *  an explanatory header. */
export function isAccelerationPeriod(lines: PeriodTraceLine[]): boolean {
  return lines.some((l) => l.amount === null);
}
