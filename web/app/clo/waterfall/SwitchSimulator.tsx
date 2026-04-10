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
  const [sellParAmount, setSellParAmount] = useState(0);
  const [buySpreadBps, setBuySpreadBps] = useState(350);
  const [buyRating, setBuyRating] = useState("B");
  const [buyMaturity, setBuyMaturity] = useState(resolved.dates.maturity);
  const [buyParAmount, setBuyParAmount] = useState(0);
  const [sellPrice, setSellPrice] = useState(100);
  const [buyPrice, setBuyPrice] = useState(100);

  const sellLoan = sellLoanIndex !== null ? resolved.loans[sellLoanIndex] : null;

  // When sell loan selection changes, default sell amount to full position and buy par to match
  const handleSellSelect = (idx: number | null) => {
    setSellLoanIndex(idx);
    if (idx !== null) {
      const loan = resolved.loans[idx];
      setSellParAmount(loan.parBalance);
      setBuyParAmount(loan.parBalance);
    }
  };

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
    if (item.facilitySize) setBuyParAmount(item.facilitySize);
  };

  const buyLoan: ResolvedLoan = useMemo(() => ({
    parBalance: buyParAmount,
    maturityDate: buyMaturity,
    ratingBucket: buyRating,
    spreadBps: buySpreadBps,
  }), [buyParAmount, buyMaturity, buyRating, buySpreadBps]);

  const { switchResult, baseResult, switchedResult } = useMemo(() => {
    if (sellLoanIndex === null) return { switchResult: null, baseResult: null, switchedResult: null };
    const sr = applySwitch(resolved, { sellLoanIndex, sellParAmount, buyLoan, sellPrice, buyPrice }, userAssumptions);
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
      {/* Sell loan — searchable portfolio selector */}
      <LoanSelector
        label="Sell Loan"
        holdings={sellOptions}
        selectedIndex={sellLoanIndex}
        onSelect={handleSellSelect}
      />

      {/* Sell amount — can be partial */}
      {sellLoan && (
        <div style={{ marginBottom: "1.25rem", display: "flex", gap: "1rem", alignItems: "center" }}>
          <div>
            <div style={labelStyle}>Sell Amount</div>
            <input type="number" value={sellParAmount} onChange={(e) => setSellParAmount(parseFloat(e.target.value) || 0)} style={{ ...inputStyle, width: "10rem" }} />
          </div>
          <div style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", marginTop: "1.2rem" }}>
            of {formatAmount(sellLoan.parBalance)} position
            {sellParAmount < sellLoan.parBalance - 0.01 && (
              <span style={{ color: "var(--color-warning, #d97706)", marginLeft: "0.5rem" }}>(partial sale)</span>
            )}
          </div>
        </div>
      )}

      {/* Buy loan — from buy list or manual entry */}
      {buyList.length > 0 && (
        <BuyLoanSelector
          buyList={buyList}
          onSelect={handleBuyListSelect}
        />
      )}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={{ border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", padding: "0.75rem", background: "var(--color-surface)" }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>
            {buyList.length > 0 ? "Buy Loan Details" : "Buy Loan"}
          </div>
          {buyList.length > 0 && (
            <div style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", marginBottom: "0.5rem", opacity: 0.8 }}>
              Pre-filled from buy list selection above. Adjust any field to override.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem" }}>
            <div><div style={labelStyle}>Spread (bps)</div><input type="number" value={buySpreadBps} onChange={(e) => setBuySpreadBps(parseFloat(e.target.value) || 0)} style={inputStyle} /></div>
            <div><div style={labelStyle}>Rating</div><select value={buyRating} onChange={(e) => setBuyRating(e.target.value)} style={inputStyle}>{RATING_BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}</select></div>
            <div><div style={labelStyle}>Maturity</div><input type="date" value={buyMaturity} onChange={(e) => setBuyMaturity(e.target.value)} style={inputStyle} /></div>
            <div><div style={labelStyle}>Par Amount</div><input type="number" value={buyParAmount} onChange={(e) => setBuyParAmount(parseFloat(e.target.value) || 0)} style={inputStyle} /></div>
          </div>
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

function LoanSelector({
  label,
  holdings,
  selectedIndex,
  onSelect,
}: {
  label: string;
  holdings: { idx: number; name: string; loan: ResolvedLoan }[];
  selectedIndex: number | null;
  onSelect: (idx: number | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const query = search.toLowerCase();
  const filtered = query
    ? holdings.filter((h) => h.name.toLowerCase().includes(query) || h.loan.ratingBucket.toLowerCase().includes(query))
    : holdings;

  const selected = selectedIndex !== null ? holdings.find((h) => h.idx === selectedIndex) : null;

  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div style={{ border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", padding: "0.75rem", background: "var(--color-surface)" }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>{label}</div>
        {selected && !open ? (
          <button
            onClick={() => { setOpen(true); setSearch(""); }}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "0.5rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", cursor: "pointer", fontSize: "0.85rem" }}
          >
            <div style={{ fontWeight: 600 }}>{selected.name}</div>
            <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
              {selected.loan.ratingBucket} · {selected.loan.spreadBps} bps · {formatAmount(selected.loan.parBalance)}
            </div>
          </button>
        ) : (
          <>
            <input
              type="text"
              placeholder="Search by name or rating..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setOpen(true)}
              style={{ width: "100%", padding: "0.4rem 0.5rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border-light)", fontSize: "0.8rem", marginBottom: "0.4rem", background: "var(--color-surface)", color: "var(--color-text)" }}
            />
            {open && (
              <div style={{ maxHeight: "240px", overflowY: "auto" }}>
                {filtered.length === 0 && (
                  <div style={{ padding: "0.5rem", color: "var(--color-text-muted)", fontSize: "0.8rem" }}>No matching loans</div>
                )}
                {filtered.map((h) => (
                  <button
                    key={h.idx}
                    onClick={() => { onSelect(h.idx); setOpen(false); setSearch(""); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "0.5rem", border: "none", borderBottom: "1px solid var(--color-border-light)", background: h.idx === selectedIndex ? "var(--color-surface-alt, rgba(128,128,128,0.08))" : "transparent", cursor: "pointer", fontSize: "0.85rem", color: "var(--color-text)", borderRadius: 0 }}
                    onMouseEnter={(e) => { if (h.idx !== selectedIndex) e.currentTarget.style.background = "var(--color-surface-alt, rgba(128,128,128,0.05))"; }}
                    onMouseLeave={(e) => { if (h.idx !== selectedIndex) e.currentTarget.style.background = "transparent"; }}
                  >
                    <div style={{ fontWeight: 600 }}>{h.name}</div>
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
                      {h.loan.ratingBucket} · {h.loan.spreadBps} bps · {formatAmount(h.loan.parBalance)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function BuyLoanSelector({
  buyList,
  onSelect,
}: {
  buyList: BuyListItem[];
  onSelect: (item: BuyListItem) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = search.toLowerCase();
  const filtered = query
    ? buyList.filter((item) =>
        item.obligorName.toLowerCase().includes(query) ||
        (item.sector?.toLowerCase().includes(query) ?? false) ||
        (item.moodysRating?.toLowerCase().includes(query) ?? false) ||
        (item.spRating?.toLowerCase().includes(query) ?? false)
      )
    : buyList;

  const selected = selectedId ? buyList.find((b) => b.id === selectedId) : null;

  const formatRating = (item: BuyListItem) =>
    [item.moodysRating, item.spRating].filter(Boolean).join("/") || "NR";

  const formatSize = (item: BuyListItem) => {
    if (!item.facilitySize) return "";
    return item.facilitySize >= 1_000_000 ? `€${(item.facilitySize / 1_000_000).toFixed(1)}M` : `€${(item.facilitySize / 1_000).toFixed(0)}K`;
  };

  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div style={{ border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", padding: "0.75rem", background: "var(--color-surface)" }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>Buy Loan (from buy list)</div>
        {selected && !open ? (
          <button
            onClick={() => { setOpen(true); setSearch(""); }}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "0.5rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", cursor: "pointer", fontSize: "0.85rem" }}
          >
            <div style={{ fontWeight: 600 }}>{selected.obligorName}</div>
            <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
              {[selected.sector, formatRating(selected), selected.spreadBps ? `${selected.spreadBps} bps` : null, formatSize(selected)].filter(Boolean).join(" · ")}
            </div>
          </button>
        ) : (
          <>
            <input
              type="text"
              placeholder="Search by name, sector, or rating..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setOpen(true)}
              style={{ width: "100%", padding: "0.4rem 0.5rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border-light)", fontSize: "0.8rem", marginBottom: "0.4rem", background: "var(--color-surface)", color: "var(--color-text)" }}
            />
            {open && (
              <div style={{ maxHeight: "240px", overflowY: "auto" }}>
                {filtered.length === 0 && (
                  <div style={{ padding: "0.5rem", color: "var(--color-text-muted)", fontSize: "0.8rem" }}>No matching items</div>
                )}
                {filtered.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { onSelect(item); setSelectedId(item.id); setOpen(false); setSearch(""); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "0.5rem", border: "none", borderBottom: "1px solid var(--color-border-light)", background: item.id === selectedId ? "var(--color-surface-alt, rgba(128,128,128,0.08))" : "transparent", cursor: "pointer", fontSize: "0.85rem", color: "var(--color-text)", borderRadius: 0 }}
                    onMouseEnter={(e) => { if (item.id !== selectedId) e.currentTarget.style.background = "var(--color-surface-alt, rgba(128,128,128,0.05))"; }}
                    onMouseLeave={(e) => { if (item.id !== selectedId) e.currentTarget.style.background = "transparent"; }}
                  >
                    <div style={{ fontWeight: 600 }}>{item.obligorName}</div>
                    <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
                      {[item.sector, formatRating(item), item.spreadBps ? `${item.spreadBps} bps` : null, formatSize(item)].filter(Boolean).join(" · ")}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
