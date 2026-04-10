"use client";

import React, { useState, useMemo } from "react";
import type { ResolvedDealData, ResolvedLoan } from "@/lib/clo/resolver-types";
import type { BuyListItem, CloHolding } from "@/lib/clo/types";
import type { UserAssumptions } from "@/lib/clo/build-projection-inputs";
import { applySwitch } from "@/lib/clo/switch-simulator";
import { runProjection, type ProjectionResult } from "@/lib/clo/projection";
import { RATING_BUCKETS, mapToRatingBucket } from "@/lib/clo/rating-mapping";
import { formatAmount, formatPct } from "./helpers";

interface Props {
  resolved: ResolvedDealData;
  holdings: CloHolding[];
  buyList: BuyListItem[];
  userAssumptions: UserAssumptions;
}

function formatDelta(before: number | null, after: number | null): { text: string; color: string } {
  if (before == null || after == null) return { text: "—", color: "inherit" };
  const delta = after - before;
  return {
    text: `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}%`,
    color: delta > 0 ? "var(--color-high)" : delta < 0 ? "var(--color-low)" : "inherit",
  };
}

function formatAmountDelta(before: number, after: number): { text: string; color: string } {
  const delta = after - before;
  return {
    text: formatAmount(delta),
    color: delta > 0 ? "var(--color-high)" : delta < 0 ? "var(--color-low)" : "inherit",
  };
}

export function SwitchSimulator({ resolved, holdings, buyList, userAssumptions }: Props) {
  const [sellLoanIndex, setSellLoanIndex] = useState<number | null>(null);
  const [buySpreadBps, setBuySpreadBps] = useState(350);
  const [buyRating, setBuyRating] = useState("B");
  const [buyMaturity, setBuyMaturity] = useState(resolved.dates.maturity);
  const [buyParAmount, setBuyParAmount] = useState(0);
  const [sellPrice, setSellPrice] = useState(100);
  const [buyPrice, setBuyPrice] = useState(100);

  const sellLoan = sellLoanIndex !== null ? resolved.loans[sellLoanIndex] : null;
  React.useEffect(() => {
    if (sellLoan) setBuyParAmount(sellLoan.parBalance);
  }, [sellLoan]);

  // Sync buyMaturity when deal changes
  React.useEffect(() => {
    setBuyMaturity(resolved.dates.maturity);
  }, [resolved.dates.maturity]);

  const sellOptions = useMemo(() => {
    return resolved.loans.map((loan, idx) => {
      const name = loan.obligorName ?? `Loan ${idx + 1}`;
      return { idx, name, loan };
    });
  }, [resolved.loans]);

  const handleBuyListSelect = (item: BuyListItem) => {
    if (item.spreadBps) setBuySpreadBps(item.spreadBps);
    if (item.moodysRating || item.spRating) {
      setBuyRating(mapToRatingBucket(item.moodysRating ?? null, item.spRating ?? null, null, null));
    }
    if (item.maturityDate) setBuyMaturity(item.maturityDate);
    // Don't pre-fill par from facilitySize — it's the full syndicated facility, not the CLO allocation
  };

  const buyLoan: ResolvedLoan = useMemo(() => ({
    parBalance: buyParAmount,
    maturityDate: buyMaturity,
    ratingBucket: buyRating,
    spreadBps: buySpreadBps,
  }), [buyParAmount, buyMaturity, buyRating, buySpreadBps]);

  const { switchResult, baseResult, switchedResult } = useMemo(() => {
    if (sellLoanIndex === null) return { switchResult: null, baseResult: null, switchedResult: null };
    const sr = applySwitch(resolved, { sellLoanIndex, buyLoan, sellPrice, buyPrice }, userAssumptions);
    const br = runProjection(sr.baseInputs);
    const swr = runProjection(sr.switchedInputs);
    return { switchResult: sr, baseResult: br, switchedResult: swr };
  }, [resolved, sellLoanIndex, buyLoan, sellPrice, buyPrice, userAssumptions]);

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "0.4rem 0.5rem", borderRadius: "var(--radius-sm)",
    border: "1px solid var(--color-border-light)", fontSize: "0.8rem",
    fontFamily: "var(--font-mono)", background: "var(--color-surface)", color: "var(--color-text)",
  };
  const labelStyle: React.CSSProperties = { fontSize: "0.72rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.3rem" };
  const cellStyle: React.CSSProperties = { padding: "0.5rem 0.75rem", fontSize: "0.8rem", fontFamily: "var(--font-mono)", textAlign: "right" };
  const headerStyle: React.CSSProperties = { ...cellStyle, fontWeight: 600, fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", fontFamily: "var(--font-body)" };

  return (
    <div>
      {/* Sell loan */}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={labelStyle}>Sell Loan (from portfolio)</div>
        <select value={sellLoanIndex ?? ""} onChange={(e) => setSellLoanIndex(e.target.value ? parseInt(e.target.value) : null)} style={{ ...inputStyle, maxWidth: "32rem" }}>
          <option value="">Select a loan to sell...</option>
          {sellOptions.map((opt) => (
            <option key={opt.idx} value={opt.idx}>
              {opt.name} — {opt.loan.ratingBucket} / {opt.loan.spreadBps} bps — {formatAmount(opt.loan.parBalance)} par
            </option>
          ))}
        </select>
      </div>

      {/* Buy loan */}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={labelStyle}>Buy Loan</div>
        {buyList.length > 0 && (
          <div style={{ marginBottom: "0.75rem" }}>
            <div style={{ fontSize: "0.65rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>From buy list (pre-fills fields below)</div>
            <select onChange={(e) => { const item = buyList[parseInt(e.target.value)]; if (item) handleBuyListSelect(item); }} style={{ ...inputStyle, maxWidth: "32rem" }} defaultValue="">
              <option value="">Pick from buy list...</option>
              {buyList.map((item, i) => (
                <option key={item.id} value={i}>{item.obligorName} — {item.spreadBps ?? "?"} bps — {item.moodysRating ?? item.spRating ?? "NR"}</option>
              ))}
            </select>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem", maxWidth: "32rem" }}>
          <div><div style={labelStyle}>Spread (bps)</div><input type="number" value={buySpreadBps} onChange={(e) => setBuySpreadBps(parseFloat(e.target.value) || 0)} style={inputStyle} /></div>
          <div><div style={labelStyle}>Rating</div><select value={buyRating} onChange={(e) => setBuyRating(e.target.value)} style={inputStyle}>{RATING_BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}</select></div>
          <div><div style={labelStyle}>Maturity</div><input type="date" value={buyMaturity} onChange={(e) => setBuyMaturity(e.target.value)} style={inputStyle} /></div>
          <div><div style={labelStyle}>Par Amount</div><input type="number" value={buyParAmount} onChange={(e) => setBuyParAmount(parseFloat(e.target.value) || 0)} style={inputStyle} /></div>
        </div>
      </div>

      {/* Transaction costs */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", fontSize: "0.8rem" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          Sell price: <input type="number" value={sellPrice} onChange={(e) => setSellPrice(parseFloat(e.target.value) || 100)} style={{ width: "4rem", padding: "0.3rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border-light)", fontSize: "0.8rem", fontFamily: "var(--font-mono)" }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          Buy price: <input type="number" value={buyPrice} onChange={(e) => setBuyPrice(parseFloat(e.target.value) || 100)} style={{ width: "4rem", padding: "0.3rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border-light)", fontSize: "0.8rem", fontFamily: "var(--font-mono)" }} />
        </label>
      </div>

      {/* Empty state */}
      {sellLoanIndex === null && (
        <div style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-muted)", fontSize: "0.85rem", border: "1px dashed var(--color-border-light)", borderRadius: "var(--radius-sm)" }}>
          Select a loan to sell to see the switch impact
        </div>
      )}

      {/* Results */}
      {switchResult && baseResult && switchedResult && (
        <div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1.25rem", maxWidth: "48rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--color-border)" }}>
                <th style={{ ...headerStyle, textAlign: "left" }}>Metric</th>
                <th style={headerStyle}>Before</th>
                <th style={headerStyle}>After</th>
                <th style={headerStyle}>Delta</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left", fontWeight: 600 }}>Equity IRR</td>
                <td style={cellStyle}>{baseResult.equityIrr !== null ? formatPct(baseResult.equityIrr * 100) : "—"}</td>
                <td style={cellStyle}>{switchedResult.equityIrr !== null ? formatPct(switchedResult.equityIrr * 100) : "—"}</td>
                <td style={{ ...cellStyle, color: formatDelta(baseResult.equityIrr, switchedResult.equityIrr).color, fontWeight: 600 }}>{formatDelta(baseResult.equityIrr, switchedResult.equityIrr).text}</td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Total Equity Distributions</td>
                <td style={cellStyle}>{formatAmount(baseResult.totalEquityDistributions)}</td>
                <td style={cellStyle}>{formatAmount(switchedResult.totalEquityDistributions)}</td>
                <td style={{ ...cellStyle, color: formatAmountDelta(baseResult.totalEquityDistributions, switchedResult.totalEquityDistributions).color }}>{formatAmountDelta(baseResult.totalEquityDistributions, switchedResult.totalEquityDistributions).text}</td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Spread (swapped position)</td>
                <td style={cellStyle}>{sellLoan?.spreadBps ?? "—"} bps</td>
                <td style={cellStyle}>{buySpreadBps} bps</td>
                <td style={{ ...cellStyle, color: switchResult.spreadDelta >= 0 ? "var(--color-high)" : "var(--color-low)" }}>{switchResult.spreadDelta >= 0 ? "+" : ""}{switchResult.spreadDelta} bps</td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Rating (swapped position)</td>
                <td style={cellStyle}>{switchResult.ratingChange.from}</td>
                <td style={cellStyle}>{switchResult.ratingChange.to}</td>
                <td style={cellStyle}>{switchResult.ratingChange.from} → {switchResult.ratingChange.to}</td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Par Impact</td>
                <td style={cellStyle}>—</td>
                <td style={cellStyle}>—</td>
                <td style={{ ...cellStyle, color: switchResult.parDelta >= 0 ? "var(--color-high)" : "var(--color-low)", fontWeight: 600 }}>{formatAmount(switchResult.parDelta)}</td>
              </tr>
            </tbody>
          </table>
          <OcEquityDetail baseResult={baseResult} switchedResult={switchedResult} />
        </div>
      )}
    </div>
  );
}

function OcEquityDetail({ baseResult, switchedResult }: { baseResult: ProjectionResult; switchedResult: ProjectionResult }) {
  const [expanded, setExpanded] = useState(false);
  const baseOc = baseResult.periods[0]?.ocTests ?? [];
  const switchedOc = switchedResult.periods[0]?.ocTests ?? [];
  const cellStyle: React.CSSProperties = { padding: "0.5rem 0.75rem", fontSize: "0.8rem", fontFamily: "var(--font-mono)", textAlign: "right" };
  const headerStyle: React.CSSProperties = { ...cellStyle, fontWeight: 600, fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", fontFamily: "var(--font-body)" };

  return (
    <div style={{ border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)" }}>
      <button onClick={() => setExpanded(!expanded)} style={{ width: "100%", display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.6rem 0.8rem", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem", color: "var(--color-text-muted)", fontFamily: "var(--font-body)" }}>
        <span style={{ fontSize: "0.65rem" }}>{expanded ? "▾" : "▸"}</span>
        OC Cushion & Cash Flow Detail
      </button>
      {expanded && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>OC Cushion Changes (Period 1)</div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1rem" }}>
            <thead><tr style={{ borderBottom: "2px solid var(--color-border)" }}><th style={{ ...headerStyle, textAlign: "left" }}>Class</th><th style={headerStyle}>Before</th><th style={headerStyle}>After</th><th style={headerStyle}>Delta</th></tr></thead>
            <tbody>
              {baseOc.map((oc, i) => {
                const sw = switchedOc[i];
                const delta = sw ? sw.actual - oc.actual : 0;
                return (
                  <tr key={oc.className} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                    <td style={{ ...cellStyle, textAlign: "left", fontWeight: 500 }}>{oc.className}</td>
                    <td style={cellStyle}>{oc.actual.toFixed(2)}%</td>
                    <td style={cellStyle}>{sw ? sw.actual.toFixed(2) : "—"}%</td>
                    <td style={{ ...cellStyle, color: delta >= 0 ? "var(--color-high)" : "var(--color-low)" }}>{delta >= 0 ? "+" : ""}{delta.toFixed(2)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>Equity Distribution Delta (First 12 Quarters)</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "2px solid var(--color-border)" }}><th style={{ ...headerStyle, textAlign: "left" }}>Quarter</th><th style={headerStyle}>Before</th><th style={headerStyle}>After</th><th style={headerStyle}>Delta</th></tr></thead>
            <tbody>
              {baseResult.periods.slice(0, 12).map((p, i) => {
                const sw = switchedResult.periods[i];
                const delta = sw ? sw.equityDistribution - p.equityDistribution : 0;
                return (
                  <tr key={p.periodNum} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                    <td style={{ ...cellStyle, textAlign: "left", fontWeight: 500 }}>Q{p.periodNum}</td>
                    <td style={cellStyle}>{formatAmount(p.equityDistribution)}</td>
                    <td style={cellStyle}>{sw ? formatAmount(sw.equityDistribution) : "—"}</td>
                    <td style={{ ...cellStyle, color: delta >= 0 ? "var(--color-high)" : "var(--color-low)" }}>{formatAmount(delta)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
