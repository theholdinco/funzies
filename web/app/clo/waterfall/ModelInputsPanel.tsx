"use client";

import React, { useState } from "react";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";
import type { ProjectionInputs } from "@/lib/clo/projection";
import { useFormatAmount } from "./CurrencyContext";
import { CitationTooltip } from "@/components/clo/CitationTooltip";

export function ModelInputsPanel({ resolved, inputs }: { resolved: ResolvedDealData; inputs: ProjectionInputs }) {
  const [open, setOpen] = useState(false);
  const formatAmount = useFormatAmount();

  const sourceBadge = (source: string) => {
    const colors: Record<string, string> = {
      snapshot: "var(--color-high)",
      compliance: "var(--color-high)",
      db_tranche: "var(--color-accent)",
      ppm: "var(--color-warning, #d97706)",
      default: "var(--color-low)",
    };
    const labels: Record<string, string> = {
      snapshot: "Trustee report",
      compliance: "Trustee report",
      db_tranche: "Deal database",
      ppm: "PPM",
      default: "Model fallback",
    };
    return (
      <span style={{ fontSize: "0.6rem", fontWeight: 600, padding: "0.1rem 0.35rem", borderRadius: "3px", background: `${colors[source] ?? "var(--color-text-muted)"}18`, color: colors[source] ?? "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
        {labels[source] ?? source}
      </span>
    );
  };

  const kvStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "0.3rem 0", fontSize: "0.73rem", borderBottom: "1px solid var(--color-border-light)" };
  const kvLabel: React.CSSProperties = { color: "var(--color-text-muted)" };
  const kvValue: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: "0.72rem", fontWeight: 500 };

  return (
    <div style={{ marginBottom: "1rem" }}>
      <button onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.3rem 0", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem", color: "var(--color-text-muted)", fontFamily: "var(--font-body)" }}>
        <span style={{ fontSize: "0.6rem" }}>{open ? "▾" : "▸"}</span>
        Model Inputs
      </button>
      {open && (
        <div style={{ marginTop: "0.5rem" }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>Capital Structure</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.73rem", fontVariantNumeric: "tabular-nums", marginBottom: "1rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--color-border)", textAlign: "right" }}>
                {["Class", "Balance", "Spread", "Type", "Defer.", "Source"].map((h) => (
                  <th key={h} style={{ padding: "0.35rem 0.5rem", textAlign: h === "Class" || h === "Source" ? "left" : "right", fontWeight: 600, fontSize: "0.65rem", textTransform: "uppercase", color: "var(--color-text-muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resolved.tranches.map((t) => (
                <tr key={t.className} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                  <td style={{ padding: "0.35rem 0.5rem", fontWeight: 500 }}>{t.className}</td>
                  <td style={{ padding: "0.35rem 0.5rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(t.currentBalance)}</td>
                  <td style={{ padding: "0.35rem 0.5rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                    {t.isIncomeNote ? "\u2014" : t.isFloating ? `${t.spreadBps} bps` : `Fixed ${(t.spreadBps / 100).toFixed(2)}%`}
                  </td>
                  <td style={{ padding: "0.35rem 0.5rem", textAlign: "right", fontSize: "0.72rem" }}>{t.isFloating ? "Float" : "Fixed"}</td>
                  <td style={{ padding: "0.35rem 0.5rem", textAlign: "right", fontSize: "0.72rem" }}>{t.isDeferrable ? "Yes" : "No"}</td>
                  <td style={{ padding: "0.35rem 0.5rem" }}>{sourceBadge(t.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>
                Fees
                <CitationTooltip citation={resolved.fees.citation ?? null} />
              </div>
              <div style={kvStyle}><span style={kvLabel}>Senior Mgmt</span> <span style={kvValue}>{resolved.fees.seniorFeePct}%</span></div>
              <div style={kvStyle}><span style={kvLabel}>Sub Mgmt</span> <span style={kvValue}>{resolved.fees.subFeePct}%</span></div>
              <div style={kvStyle}><span style={kvLabel}>Trustee/Admin</span> <span style={kvValue}>{resolved.fees.trusteeFeeBps} bps</span></div>
              <div style={kvStyle}><span style={kvLabel}>Incentive</span> <span style={kvValue}>{resolved.fees.incentiveFeePct > 0 ? `${resolved.fees.incentiveFeePct}%` : "None"}</span></div>
              <div style={kvStyle}><span style={kvLabel}>Hedge Cost</span> <span style={kvValue}>{inputs.hedgeCostBps} bps</span></div>
            </div>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>Dates</div>
              <div style={kvStyle}><span style={kvLabel}>Maturity</span> <span style={kvValue}>{resolved.dates.maturity}</span></div>
              <div style={kvStyle}><span style={kvLabel}>RP End</span> <span style={kvValue}>{resolved.dates.reinvestmentPeriodEnd ?? "N/A"}</span></div>
              <div style={kvStyle}><span style={kvLabel}>Non-Call</span> <span style={kvValue}>{resolved.dates.nonCallPeriodEnd ?? "N/A"}</span></div>
              <div style={kvStyle}><span style={kvLabel}>Call Date</span> <span style={kvValue}>{inputs.callDate ?? "Not set"}</span></div>
            </div>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>
                Pool
                <CitationTooltip citation={resolved.poolSummary.citation ?? null} />
              </div>
              <div style={kvStyle}><span style={kvLabel}>Initial Par</span> <span style={kvValue}>{formatAmount(resolved.poolSummary.totalPar)}</span></div>
              <div style={kvStyle}><span style={kvLabel}>WAC Spread</span> <span style={kvValue}>{resolved.poolSummary.wacSpreadBps} bps</span></div>
              <div style={kvStyle}><span style={kvLabel}>Loans</span> <span style={kvValue}>{resolved.loans.length}</span></div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>OC Triggers</div>
              {resolved.ocTriggers.map((t) => (
                <div key={t.className} style={kvStyle}><span style={kvLabel}>{t.className}</span> <span style={kvValue}>{t.triggerLevel}% {sourceBadge(t.source)}</span></div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>IC Triggers</div>
              {resolved.icTriggers.map((t) => (
                <div key={t.className} style={kvStyle}><span style={kvLabel}>{t.className}</span> <span style={kvValue}>{t.triggerLevel}% {sourceBadge(t.source)}</span></div>
              ))}
              {resolved.reinvestmentOcTrigger && (
                <>
                  <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginTop: "0.5rem", marginBottom: "0.4rem" }}>Reinvestment OC</div>
                  <div style={kvStyle}><span style={kvLabel}>Trigger</span> <span style={kvValue}>{resolved.reinvestmentOcTrigger.triggerLevel}%</span></div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
