"use client";

import React, { useState } from "react";
import { SliderInput } from "./SliderInput";
import { useDealCurrency } from "./CurrencyContext";
import { currencySymbol } from "./helpers";
import type { ResolutionWarning } from "@/lib/clo/resolver-types";

/** Engine-assumption inputs that have no PPM-extraction path: PPM step (A)(i)
 *  Issuer taxes, step (A)(ii) Issuer Profit Amount, plus the C3-split step (B)
 *  trustee and step (C) admin fees when the PPM rate is "per agreement". Pre-
 *  fix these were silently back-derived from observed step amounts in
 *  `defaultsFromResolved`; that path is gone (paid amount is not contractual
 *  forward rate). The user accepts the observed-period suggestion via the
 *  one-click button or types an explicit value; either clears the
 *  corresponding resolver-time blocking gate via composeBuildWarnings. */
export function EngineExpensesPanel({
  issuerProfitAmount, onIssuerProfitChange,
  trusteeFeeBps, onTrusteeFeeChange,
  adminFeeBps, onAdminFeeChange,
  hedgeCostBps, onHedgeCostChange,
  prefillWarnings,
}: {
  issuerProfitAmount: number; onIssuerProfitChange: (v: number) => void;
  trusteeFeeBps: number; onTrusteeFeeChange: (v: number) => void;
  adminFeeBps: number; onAdminFeeChange: (v: number) => void;
  hedgeCostBps: number; onHedgeCostChange: (v: number) => void;
  prefillWarnings: ResolutionWarning[];
}) {
  const [open, setOpen] = useState(true);
  const sym = currencySymbol(useDealCurrency());
  const suggestionFor = (field: string): { value: number; resolvedFrom: string | undefined } | null => {
    const w = prefillWarnings.find((p) => p.field === field && typeof p.suggestedValue === "number");
    if (!w || w.suggestedValue == null) return null;
    return { value: w.suggestedValue, resolvedFrom: w.resolvedFrom };
  };

  const profitSuggestion = suggestionFor("assumptions.issuerProfitAmount");
  const trusteeSuggestion = suggestionFor("assumptions.trusteeFeeBps");
  const adminSuggestion = suggestionFor("assumptions.adminFeeBps");
  const hedgeSuggestion = suggestionFor("assumptions.hedgeCostBps");

  const useSuggestedBtnStyle: React.CSSProperties = {
    fontSize: "0.62rem",
    padding: "0.18rem 0.45rem",
    border: "1px solid var(--color-accent)",
    background: "var(--color-accent-bg, rgba(59,130,246,0.08))",
    color: "var(--color-accent)",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    whiteSpace: "nowrap",
  };

  const renderSuggestion = (
    suggestion: { value: number; resolvedFrom: string | undefined } | null,
    apply: (v: number) => void,
    formatValue: (v: number) => string,
  ) => {
    if (!suggestion) return null;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.2rem", fontSize: "0.63rem", color: "var(--color-text-muted)" }}>
        <span>Observed: {formatValue(suggestion.value)}</span>
        <button
          type="button"
          style={useSuggestedBtnStyle}
          onClick={() => apply(suggestion.value)}
          title={suggestion.resolvedFrom ? `Provenance: ${suggestion.resolvedFrom}` : "Set the field to the observed-step suggestion"}
        >
          Use suggested
        </button>
      </div>
    );
  };

  return (
    <div style={{ marginTop: "0.75rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.4rem", padding: "0.5rem 0.8rem", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem", color: "var(--color-text-muted)", textAlign: "left", fontFamily: "var(--font-body)" }}
      >
        <span>
          <span style={{ fontSize: "0.65rem", marginRight: "0.3rem" }}>{open ? "▾" : "▸"}</span>
          Engine Assumptions — Step (A)(i)/(A)(ii) + Trustee/Admin
        </span>
        {(issuerProfitAmount === 0 || trusteeFeeBps === 0 || adminFeeBps === 0 || (hedgeSuggestion != null && hedgeCostBps === 0)) && (
          <span style={{ fontSize: "0.6rem", fontWeight: 600, padding: "0.1rem 0.35rem", borderRadius: "3px", background: "var(--color-warning, #d97706)18", color: "var(--color-warning, #d97706)" }}>
            ZEROED
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          {/* arch-boundary-allow: ui-hardcodes-currency-symbol (documentation prose; not a numeric display) */}
          <div style={{ fontSize: "0.68rem", color: "var(--color-text-muted)", marginBottom: "0.75rem", lineHeight: 1.5 }}>
            These fields have no PPM-extraction path (taxes are regulatory; admin/trustee fees are typically &quot;per agreement&quot;; Issuer Profit Amount is a fixed periodic amount defined in the deal docs). Each gates the projection until set. Click &quot;Use suggested&quot; to accept the observed-prior-period value, or type an explicit number.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1.25rem" }}>
            <div>
              <SliderInput label="Issuer Profit" value={issuerProfitAmount} onChange={onIssuerProfitChange} min={0} max={1000} step={50} suffix={` ${sym} per period`} hint="PPM step (A)(ii). Fixed periodic amount retained by the issuer each Payment Date." />
              {renderSuggestion(profitSuggestion, onIssuerProfitChange, (v) => `${sym}${v.toFixed(2)}`)}
            </div>
            <div>
              <SliderInput label="Trustee Fee" value={trusteeFeeBps} onChange={onTrusteeFeeChange} min={0} max={20} step={0.05} suffix=" bps p.a. on CPA" hint="PPM step (B). Trustee Fees and Expenses, jointly subject to the Senior Expenses Cap with admin." />
              {renderSuggestion(trusteeSuggestion, onTrusteeFeeChange, (v) => `${v.toFixed(3)} bps`)}
            </div>
            <div>
              <SliderInput label="Admin Fee" value={adminFeeBps} onChange={onAdminFeeChange} min={0} max={20} step={0.1} suffix=" bps p.a. on CPA" hint="PPM step (C). Administrative Expenses (collateral admin, custody, transparency reporting, etc.), jointly capped with trustee at the Senior Expenses Cap." />
              {renderSuggestion(adminSuggestion, onAdminFeeChange, (v) => `${v.toFixed(3)} bps`)}
            </div>
            <div>
              <SliderInput label="Hedge Cost" value={hedgeCostBps} onChange={onHedgeCostChange} min={0} max={200} step={1} suffix=" bps p.a. on par" hint="PPM step (F). Hedge / swap periodic cost. Resolver-extracted from PPM hedge fee row when present (resolveHedgeCost); build-time blocking gate refuses the projection when observed Step F shows hedge cashflows but neither extraction nor user has supplied a rate." />
              {renderSuggestion(hedgeSuggestion, onHedgeCostChange, (v) => `${v.toFixed(3)} bps`)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
