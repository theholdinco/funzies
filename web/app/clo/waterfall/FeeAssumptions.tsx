"use client";

import React, { useState } from "react";
import { SliderInput } from "./SliderInput";
import { CitationTooltip } from "@/components/clo/CitationTooltip";
import type { Citation } from "@/lib/clo/resolver-types";

export function FeeAssumptions({
  seniorFeePct, onSeniorFeeChange,
  subFeePct, onSubFeeChange,
  trusteeFeeBps, onTrusteeFeeChange,
  hedgeCostBps, onHedgeCostChange,
  incentiveFeePct, onIncentiveFeeChange,
  incentiveFeeHurdleIrr, onHurdleChange,
  hasResolvedFees,
  feesCitation,
  callMode, onCallModeChange,
  callDate, onCallDateChange,
  callPricePct, onCallPriceChange,
  callPriceMode, onCallPriceModeChange,
  portfolioInfo,
  ddtlDrawAssumption, onDdtlDrawAssumptionChange,
  ddtlDrawQuarter, onDdtlDrawQuarterChange,
  ddtlDrawPercent, onDdtlDrawPercentChange,
}: {
  seniorFeePct: number; onSeniorFeeChange: (v: number) => void;
  subFeePct: number; onSubFeeChange: (v: number) => void;
  trusteeFeeBps: number; onTrusteeFeeChange: (v: number) => void;
  hedgeCostBps: number; onHedgeCostChange: (v: number) => void;
  incentiveFeePct: number; onIncentiveFeeChange: (v: number) => void;
  incentiveFeeHurdleIrr: number; onHurdleChange: (v: number) => void;
  hasResolvedFees: boolean;
  feesCitation?: Citation | null;
  callMode: "none" | "optionalRedemption"; onCallModeChange: (v: "none" | "optionalRedemption") => void;
  callDate: string | null; onCallDateChange: (v: string | null) => void;
  callPricePct: number; onCallPriceChange: (v: number) => void;
  callPriceMode: "par" | "market" | "manual"; onCallPriceModeChange: (v: "par" | "market" | "manual") => void;
  portfolioInfo: {
    fixedRateCount: number; fixedRatePar: number; fixedRatePct: number;
    ddtlCount: number; ddtlPar: number; hasDdtls: boolean; hasFixedRate: boolean;
  };
  ddtlDrawAssumption: 'draw_at_deadline' | 'never_draw' | 'custom_quarter';
  onDdtlDrawAssumptionChange: (v: 'draw_at_deadline' | 'never_draw' | 'custom_quarter') => void;
  ddtlDrawQuarter: number;
  onDdtlDrawQuarterChange: (v: number) => void;
  ddtlDrawPercent: number;
  onDdtlDrawPercentChange: (v: number) => void;
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
          <CitationTooltip citation={feesCitation ?? null} />
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
            <SliderInput label="Sub Mgmt Fee" value={subFeePct} onChange={onSubFeeChange} min={0} max={1} step={0.05} suffix="% p.a. on par" hint="Paid quarterly from interest after all tranche payments" />
            <SliderInput label="Trustee / Admin" value={trusteeFeeBps} onChange={onTrusteeFeeChange} min={0} max={10} step={1} suffix=" bps p.a. on par" hint="Paid first from interest, before management fee" />
            <SliderInput label="Hedge Cost" value={hedgeCostBps} onChange={onHedgeCostChange} min={0} max={50} step={1} suffix=" bps p.a. on par" hint="Approximation of FX hedge costs, paid from interest before tranche payments" />
            <SliderInput label="Incentive Fee" value={incentiveFeePct} onChange={onIncentiveFeeChange} min={0} max={30} step={1} suffix="% of residual" hint="% of residual interest + principal each quarter, but only when equity IRR exceeds the hurdle" />
            <SliderInput label="Incentive Hurdle" value={incentiveFeeHurdleIrr} onChange={onHurdleChange} min={0} max={20} step={0.5} suffix="% IRR" hint="Fee is zero while equity IRR is below this rate. Above it, the full percentage applies unless it would push IRR below the hurdle" />
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.25rem" }}>
                <label style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", fontWeight: 500 }}>Manager call</label>
                <span style={{ fontSize: "0.7rem", fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--color-text-muted)" }}>
                  {callMode === "none" ? "no call" : callDate ?? "no date set"}
                </span>
              </div>
              <div style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", marginBottom: "0.3rem", lineHeight: 1.4, opacity: 0.8 }}>
                Models an optional-redemption call at the chosen date. Per the post-v6 plan §4.1, "no call" is the conservative baseline.
              </div>
              <div style={{ display: "flex", gap: "0.35rem", marginBottom: "0.4rem" }}>
                <button
                  onClick={() => onCallModeChange("none")}
                  style={{
                    flex: 1,
                    padding: "0.3rem 0.5rem",
                    fontSize: "0.7rem",
                    fontWeight: callMode === "none" ? 600 : 500,
                    border: `1px solid ${callMode === "none" ? "var(--color-accent)" : "var(--color-border-light)"}`,
                    background: callMode === "none" ? "var(--color-accent-bg, rgba(59,130,246,0.08))" : "var(--color-surface)",
                    color: callMode === "none" ? "var(--color-accent)" : "var(--color-text-muted)",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                  }}
                >
                  No call
                </button>
                <button
                  onClick={() => onCallModeChange("optionalRedemption")}
                  style={{
                    flex: 1,
                    padding: "0.3rem 0.5rem",
                    fontSize: "0.7rem",
                    fontWeight: callMode === "optionalRedemption" ? 600 : 500,
                    border: `1px solid ${callMode === "optionalRedemption" ? "var(--color-accent)" : "var(--color-border-light)"}`,
                    background: callMode === "optionalRedemption" ? "var(--color-accent-bg, rgba(59,130,246,0.08))" : "var(--color-surface)",
                    color: callMode === "optionalRedemption" ? "var(--color-accent)" : "var(--color-text-muted)",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                  }}
                >
                  Optional redemption
                </button>
              </div>
              {callMode === "optionalRedemption" && (
                <>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.4rem" }}>
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
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.2rem" }}>
                    <label style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", fontWeight: 500 }}>Call price</label>
                  </div>
                  <div style={{ display: "flex", gap: "0.3rem", marginBottom: callPriceMode === "manual" ? "0.4rem" : 0 }}>
                    {(["par", "market", "manual"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => onCallPriceModeChange(mode)}
                        style={{
                          flex: 1,
                          padding: "0.25rem 0.4rem",
                          fontSize: "0.66rem",
                          fontWeight: callPriceMode === mode ? 600 : 500,
                          border: `1px solid ${callPriceMode === mode ? "var(--color-accent)" : "var(--color-border-light)"}`,
                          background: callPriceMode === mode ? "var(--color-accent-bg, rgba(59,130,246,0.08))" : "var(--color-surface)",
                          color: callPriceMode === mode ? "var(--color-accent)" : "var(--color-text-muted)",
                          borderRadius: "var(--radius-sm)",
                          cursor: "pointer",
                          textTransform: "capitalize",
                        }}
                        title={
                          mode === "par"
                            ? "Each position sells at face value (100c)."
                            : mode === "market"
                            ? "Each position sells at its observed market price. Throws if any position is missing currentPrice."
                            : "Every position sells at the flat % below, regardless of market."
                        }
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  {callPriceMode === "manual" && (
                    <SliderInput
                      label="Liquidation price"
                      value={callPricePct}
                      onChange={onCallPriceChange}
                      min={80}
                      max={105}
                      step={0.5}
                      suffix="% of par"
                      hint="Flat sale price for every position, regardless of market."
                    />
                  )}
                </>
              )}
            </div>
          </div>
          {(portfolioInfo.hasFixedRate || portfolioInfo.hasDdtls) && (
            <div style={{ marginTop: "0.75rem", padding: "0.5rem 0.6rem", background: "var(--color-surface-alt, #f8f9fa)", borderRadius: "var(--radius-sm)", fontSize: "0.68rem", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
              {portfolioInfo.hasFixedRate && (
                <div>{portfolioInfo.fixedRateCount} fixed-rate position{portfolioInfo.fixedRateCount !== 1 ? "s" : ""} ({portfolioInfo.fixedRatePct.toFixed(1)}% of par) — coupon unaffected by base rate changes. Quarterly accrual assumed.</div>
              )}
              {portfolioInfo.hasDdtls && (
                <div style={{ marginTop: portfolioInfo.hasFixedRate ? "0.3rem" : 0 }}>
                  {portfolioInfo.ddtlCount} unfunded DDTL{portfolioInfo.ddtlCount !== 1 ? "s" : ""} ({"\u20AC"}{(portfolioInfo.ddtlPar / 1000).toFixed(0)}K) — no interest until drawn.
                </div>
              )}
            </div>
          )}
          {portfolioInfo.hasDdtls && (
            <div style={{ marginTop: "0.5rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1.25rem" }}>
              <div>
                <label style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", fontWeight: 500, display: "block", marginBottom: "0.25rem" }}>DDTL Draw Assumption</label>
                <select
                  value={ddtlDrawAssumption}
                  onChange={(e) => onDdtlDrawAssumptionChange(e.target.value as 'draw_at_deadline' | 'never_draw' | 'custom_quarter')}
                  style={{ fontSize: "0.75rem", fontFamily: "var(--font-mono)", padding: "0.3rem 0.5rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)", width: "100%" }}
                >
                  <option value="draw_at_deadline">Draw at Q4 (1 year)</option>
                  <option value="never_draw">Never draw (expires Q1)</option>
                  <option value="custom_quarter">Custom quarter</option>
                </select>
                <div style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", marginTop: "0.2rem", lineHeight: 1.4, opacity: 0.8 }}>
                  When unfunded DDTLs convert to funded loans
                </div>
              </div>
              {ddtlDrawAssumption === "custom_quarter" && (
                <>
                  <SliderInput label="Draw Quarter" value={ddtlDrawQuarter} onChange={onDdtlDrawQuarterChange} min={1} max={20} step={1} suffix="" hint="Quarter from projection start when DDTLs are drawn" />
                  <SliderInput label="Draw %" value={ddtlDrawPercent} onChange={onDdtlDrawPercentChange} min={0} max={100} step={10} suffix="% of commitment" hint="Percentage of DDTL commitment that is drawn (remainder expires)" />
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
