"use client";

import React, { useState } from "react";
import { SliderInput } from "./SliderInput";

export function FeeAssumptions({
  seniorFeePct, onSeniorFeeChange,
  subFeePct, onSubFeeChange,
  trusteeFeeBps, onTrusteeFeeChange,
  hedgeCostBps, onHedgeCostChange,
  incentiveFeePct, onIncentiveFeeChange,
  incentiveFeeHurdleIrr, onHurdleChange,
  hasResolvedFees,
  callDate, onCallDateChange,
  callPricePct, onCallPriceChange,
}: {
  seniorFeePct: number; onSeniorFeeChange: (v: number) => void;
  subFeePct: number; onSubFeeChange: (v: number) => void;
  trusteeFeeBps: number; onTrusteeFeeChange: (v: number) => void;
  hedgeCostBps: number; onHedgeCostChange: (v: number) => void;
  incentiveFeePct: number; onIncentiveFeeChange: (v: number) => void;
  incentiveFeeHurdleIrr: number; onHurdleChange: (v: number) => void;
  hasResolvedFees: boolean;
  callDate: string | null; onCallDateChange: (v: string | null) => void;
  callPricePct: number; onCallPriceChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: "0.75rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.4rem", padding: "0.5rem 0.8rem", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem", color: "var(--color-text-muted)", textAlign: "left", fontFamily: "var(--font-body)" }}
      >
        <span>
          <span style={{ fontSize: "0.65rem", marginRight: "0.3rem" }}>{open ? "▾" : "▸"}</span>
          Dates, Fees & Expenses
        </span>
        {hasResolvedFees && <span style={{ fontSize: "0.6rem", fontWeight: 600, padding: "0.1rem 0.35rem", borderRadius: "3px", background: "var(--color-high)18", color: "var(--color-high)" }}>FROM PPM</span>}
        {!hasResolvedFees && (seniorFeePct === 0 && subFeePct === 0) && <span style={{ fontSize: "0.6rem", fontWeight: 600, padding: "0.1rem 0.35rem", borderRadius: "3px", background: "var(--color-warning, #d97706)18", color: "var(--color-warning, #d97706)" }}>NOT SET</span>}
      </button>
      {open && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          <div style={{ fontSize: "0.68rem", color: "var(--color-text-muted)", marginBottom: "0.75rem", lineHeight: 1.5 }}>
            {hasResolvedFees
              ? "Pre-filled from PPM extraction. Adjust if the extracted values look wrong."
              : "No fees were extracted from the PPM. Set them manually or the model will assume zero fees (overstating equity returns)."
            }
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1.25rem" }}>
            <SliderInput label="Senior Mgmt Fee" value={seniorFeePct} onChange={onSeniorFeeChange} min={0} max={1} step={0.05} suffix="% p.a. on par" hint="Paid quarterly from interest before tranche payments" />
            <SliderInput label="Sub Mgmt Fee" value={subFeePct} onChange={onSubFeeChange} min={0} max={0.5} step={0.05} suffix="% p.a. on par" hint="Paid quarterly from interest after all tranche payments" />
            <SliderInput label="Trustee / Admin" value={trusteeFeeBps} onChange={onTrusteeFeeChange} min={0} max={10} step={1} suffix=" bps p.a. on par" hint="Paid first from interest, before management fee" />
            <SliderInput label="Hedge Cost" value={hedgeCostBps} onChange={onHedgeCostChange} min={0} max={50} step={1} suffix=" bps p.a. on par" hint="Approximation of FX hedge costs, paid from interest before tranche payments" />
            <SliderInput label="Incentive Fee" value={incentiveFeePct} onChange={onIncentiveFeeChange} min={0} max={30} step={1} suffix="% of residual" hint="% of residual interest + principal each quarter, but only when equity IRR exceeds the hurdle" />
            <SliderInput label="Incentive Hurdle" value={incentiveFeeHurdleIrr} onChange={onHurdleChange} min={0} max={20} step={0.5} suffix="% IRR" hint="Fee is zero while equity IRR is below this rate. Above it, the full percentage applies unless it would push IRR below the hurdle" />
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.25rem" }}>
                <label style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", fontWeight: 500 }}>Call Date</label>
                <span style={{ fontSize: "0.82rem", fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
                  {callDate ?? "Not set"}
                </span>
              </div>
              <div style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", marginBottom: "0.3rem", lineHeight: 1.4, opacity: 0.8 }}>
                If set, projection ends here with full liquidation. Most CLOs are called at or near the non-call period end date.
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="date"
                  value={callDate ?? ""}
                  onChange={(e) => onCallDateChange(e.target.value || null)}
                  style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", padding: "0.3rem 0.5rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)" }}
                />
                {callDate && (
                  <button
                    onClick={() => onCallDateChange(null)}
                    style={{ fontSize: "0.65rem", padding: "0.2rem 0.5rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text-muted)", cursor: "pointer" }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            {callDate && (
              <SliderInput label="Liquidation Price" value={callPricePct} onChange={onCallPriceChange} min={80} max={105} step={0.5} suffix="% of par" hint="Average price at which the loan portfolio is sold on the call date" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
