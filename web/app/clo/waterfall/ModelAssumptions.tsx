"use client";

import React, { useState } from "react";

type AssumptionImpact = "high" | "medium" | "low";

interface Assumption {
  label: string;
  detail: string;
  impact: AssumptionImpact;
}

const ASSUMPTIONS_REGISTER: { domain: string; items: Assumption[] }[] = [
  {
    domain: "Defaults & Recovery",
    items: [
      { label: "Deterministic single-path model", detail: "This is NOT a Monte Carlo simulation. It produces one deterministic cash flow path. Real outcomes have wide distributions around this estimate. A deal projected at 14% IRR might realize anywhere from 8% to 20% depending on actual default timing and severity.", impact: "high" },
      { label: "No default correlation", detail: "Each loan defaults independently based on its rating bucket. In reality, defaults are correlated — economic downturns cause clusters of defaults. This model understates tail risk.", impact: "high" },
      { label: "No rating migration", detail: "Loans stay at their initial rating for the entire projection. In reality, loans get upgraded and downgraded, which changes their default probability and affects CCC bucket limits and OC tests.", impact: "high" },
      { label: "Recovery rates static through projection", detail: "Per-position agency recovery rates apply to both forward-default cash recovery and the T=0 OC numerator credit on already-defaulted holdings. The OC numerator credit follows the indenture's Adjusted Collateral Principal Amount paragraph (e): for each defaulted holding the engine takes the lesser of (per-agency: min of market value and that agency's recovery rate) across the deal's Rating Agencies subset; defaulted holdings more than three years stale contribute zero. The forward-default cash recovery uses the deal's agency subset min (no MV floor — the trustee-reported price at default-time is a stale pre-default snapshot). Reinvested loans always recover at the global rate regardless of agency coverage on the original portfolio (no per-deal recovery curve), and original positions without agency rates inherit it as a fallback. The recovery-rate sensitivity slider perturbs only this global fallback — on a portfolio whose original loans all carry agency rates, the slider moves recoveries on reinvested-only loans. Recovery percentages do not vary with the time of default — real recovery rates fall in downturns when defaults cluster, which the model does not capture.", impact: "medium" },
      { label: "Fixed recovery lag", detail: "Recovery cash arrives after a fixed delay. In practice, recovery timelines are highly variable (months to years) and affect the time value of money.", impact: "low" },
      { label: "No partial recoveries", detail: "Each default either recovers the fixed percentage after the lag, or nothing. Real workouts produce multiple partial payments over time.", impact: "low" },
    ],
  },
  {
    domain: "Interest Rates",
    items: [
      { label: "Flat rate assumption", detail: "The base rate (EURIBOR) is held constant for the entire projection. There is no forward curve, no rate volatility, and no term structure. Since CLO equity returns are highly sensitive to rate movements, this is a major simplification.", impact: "high" },
      { label: "EURIBOR floored at 0%", detail: "The model floors the base rate at 0% for both collateral interest and tranche coupons. Most European CLOs have this floor, but the exact floor level may vary by deal.", impact: "low" },
      { label: "No EURIBOR fixing lag", detail: "The model uses the input rate immediately. Real deals reference EURIBOR fixings from 2 business days prior to the interest period start.", impact: "low" },
    ],
  },
  {
    domain: "Reinvestment & Trading",
    items: [
      // arch-boundary-allow: ui-hardcodes-currency-symbol
      { label: "No active trading", detail: "The model does not capture manager trading activity (sales, purchases, credit risk trades). Real CLO managers actively trade — the Ares XVIII compliance report shows €5.8M in sales with a -€558K loss in a single month. Trading gains/losses directly affect par and returns.", impact: "high" },
      { label: "Uniform reinvestment quality", detail: "All reinvestment goes into a single synthetic loan with one rating and spread. Real reinvestment is diversified across many names, ratings, and spreads.", impact: "medium" },
      { label: "Constant prepayment rate", detail: "CPR is held constant. In reality, prepayments are cyclical — they increase when rates fall (borrowers refinance) and decrease when rates rise. This interacts with reinvestment spread.", impact: "medium" },
    ],
  },
  {
    domain: "Fees & Expenses",
    items: [
      { label: "Incentive fee IRR gate", detail: "Each quarter the model computes cumulative equity IRR (Newton-Raphson). Three cases: (1) IRR \u2264 hurdle \u2192 no fee. (2) IRR > hurdle even after taking the full fee \u2192 full fee charged. (3) Full fee would push IRR below hurdle \u2192 fee is capped at the level that keeps IRR at the hurdle (bisection). Case 2 is the normal path for performing deals. Case 3 only matters near the hurdle boundary. Real deals may have more complex catch-up/clawback provisions.", impact: "low" },
      { label: "No expense reserve modeling", detail: "The PPM allows discretionary top-up of the expense reserve account (PPM step D), which traps cash before it reaches noteholders. This is not modeled.", impact: "low" }, // KI-02 (step D expense reserve top-up)
      { label: "No collateral manager advances", detail: "The PPM allows the manager to make advances (at EURIBOR + 4%) to buy enhancement obligations. These create a senior claim on waterfall cash. Not modeled.", impact: "low" },
    ],
  },
  {
    domain: "Deal Structure",
    items: [
      { label: "No call prediction", detail: "The model does not predict when a deal will be called. Most performing CLOs are called at or near the first call date, which dramatically changes equity returns. Use the call date input to model this scenario.", impact: "high" },
      { label: "No frequency switch", detail: "Some deals switch from quarterly to semi-annual payments after a trigger event. The model is hardcoded to quarterly periods.", impact: "low" }, // KI-04 (Frequency Switch mid-projection cadence/rate switch)
      { label: "Quarterly periodicity", detail: "Cash flows are modeled in quarterly periods with beginning-of-period accrual. Real deals accrue daily and pay on specific calendar dates with business day adjustments.", impact: "low" }, // KI-04 (Frequency Switch mid-projection cadence/rate switch)
      { label: "DDTL draw is a single event", detail: "Unfunded DDTLs draw fully (or at the user-specified percentage) in a single quarter. Real DDTLs may draw in tranches over time. Commitment fees on unfunded amounts are not modeled.", impact: "low" }, // KI-35 (partial DDTL draw discards un-drawn commitment)
    ],
  },
];

function AssumptionItem({ label, detail, impact }: { label: string; detail: string; impact: AssumptionImpact }) {
  const dotColor = impact === "high" ? "var(--color-low)" : impact === "medium" ? "var(--color-warning, #d97706)" : "var(--color-text-muted)";
  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        padding: "0.4rem 0",
        borderTop: "1px solid var(--color-border-light)",
        fontSize: "0.75rem",
        lineHeight: 1.4,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: "0.4rem",
          height: "0.4rem",
          marginTop: "0.3rem",
          borderRadius: "50%",
          background: dotColor,
        }}
        title={`Impact: ${impact}`}
      />
      <div>
        <span style={{ fontWeight: 600 }}>{label}:</span>{" "}
        <span style={{ color: "var(--color-text-muted)" }}>{detail}</span>
      </div>
    </div>
  );
}

export function ModelAssumptions() {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        marginBottom: "1.5rem",
        border: "1px solid var(--color-border-light)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-surface)",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          padding: "0.6rem 0.8rem",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "0.8rem",
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          textAlign: "left",
          fontFamily: "var(--font-body)",
        }}
      >
        <span style={{ fontSize: "0.65rem" }}>{open ? "▾" : "▸"}</span>
        Model Assumptions & Limitations
      </button>
      {open && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", marginBottom: "0.75rem", paddingTop: "0.25rem", lineHeight: 1.5 }}>
            This is a simplified deterministic projection. All outputs are estimates based on the assumptions below.{" "}
            <span style={{ fontWeight: 600 }}>Items marked with a red dot could change the equity IRR by 200+ basis points.</span>
          </div>
          {ASSUMPTIONS_REGISTER.map((group) => (
            <div key={group.domain}>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginTop: "0.75rem", marginBottom: "0.4rem" }}>
                {group.domain}
              </div>
              {group.items.map((a) => (
                <AssumptionItem key={a.label} label={a.label} detail={a.detail} impact={a.impact} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
