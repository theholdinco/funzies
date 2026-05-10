"use client";

import React, { useState, useMemo, useCallback } from "react";
import type { ResolvedDealData, ResolvedLoan, ResolutionWarning } from "@/lib/clo/resolver-types";
import type { BuyListItem, CloHolding } from "@/lib/clo/types";
import { IncompleteDataError, type UserAssumptions } from "@/lib/clo/build-projection-inputs";
import { applySwitch } from "@/lib/clo/switch-simulator";
import { computeSwitchDeltas } from "@/lib/clo/services";
import { runProjection, type ProjectionResult } from "@/lib/clo/projection";
import { RATING_BUCKETS, mapToRatingBucket } from "@/lib/clo/rating-mapping";
import { buyListFiltersFromResolved, filterBuyList } from "@/lib/clo/buy-list-filter";
import { canonicalCurrency } from "@/lib/clo/currency";
import { parseFacilitySizeAmount } from "@/lib/clo/facility-size";
import { formatPct } from "./helpers";
import { useFormatAmount } from "./CurrencyContext";

interface SwitchPrefill {
  sellName: string | null;
  buyName: string | null;
  buySpread: string | null;
  buyRating: string | null;
  buyMaturity: string | null;
  buyCurrency: string | null;
  buyPar: string | null;
}

interface Props {
  resolved: ResolvedDealData;
  holdings: CloHolding[];
  buyList: BuyListItem[];
  userAssumptions: UserAssumptions;
  prefill?: SwitchPrefill | null;
  // Threaded through to applySwitch so the buildFromResolved gate
  // fires when any warning carries `blocking: true`. ProjectionModel
  // already gates the parent render, but threading here is defence-in-
  // depth: if a future caller renders us anyway, applySwitch's gate
  // throws rather than silently computing on sentinel data.
  resolutionWarnings?: ResolutionWarning[];
}

type BuyLoanScheduleFields = Pick<
  ResolvedLoan,
  | "assetPaymentPeriodRaw"
  | "assetPaymentIntervalMonths"
  | "assetPaymentScheduleSource"
  | "nextPaymentDate"
  | "accrualBeginDate"
  | "accrualEndDate"
  | "openingAccruedInterest"
>;

function pickBuyLoanScheduleFields(item: BuyListItem): Partial<BuyLoanScheduleFields> | null {
  const candidate = item as BuyListItem & Partial<BuyLoanScheduleFields>;
  const scheduleFields: Partial<BuyLoanScheduleFields> = {};

  if (candidate.assetPaymentPeriodRaw !== undefined) scheduleFields.assetPaymentPeriodRaw = candidate.assetPaymentPeriodRaw;
  if (candidate.assetPaymentIntervalMonths !== undefined) scheduleFields.assetPaymentIntervalMonths = candidate.assetPaymentIntervalMonths;
  if (candidate.assetPaymentScheduleSource !== undefined) scheduleFields.assetPaymentScheduleSource = candidate.assetPaymentScheduleSource;
  if (candidate.nextPaymentDate !== undefined) scheduleFields.nextPaymentDate = candidate.nextPaymentDate;
  if (candidate.accrualBeginDate !== undefined) scheduleFields.accrualBeginDate = candidate.accrualBeginDate;
  if (candidate.accrualEndDate !== undefined) scheduleFields.accrualEndDate = candidate.accrualEndDate;
  if (candidate.openingAccruedInterest !== undefined) scheduleFields.openingAccruedInterest = candidate.openingAccruedInterest;

  return Object.keys(scheduleFields).length > 0 ? scheduleFields : null;
}

// Pure formatter — takes a pre-computed delta from the service layer and
// renders it as a percentage string with sign + color. No arithmetic on
// engine values here (UI layering rule). The pre-fix `formatDelta` and
// `useFormatAmountDelta` helpers performed `after - before` in the UI;
// they are removed in favor of `computeSwitchDeltas` (service layer).
function formatIrrDelta(delta: number | null): { text: string; color: string } {
  if (delta == null) return { text: "—", color: "inherit" };
  return {
    text: `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}%`,
    color: delta > 0 ? "var(--color-high)" : delta < 0 ? "var(--color-low)" : "inherit",
  };
}

function switchCurrencyRecoveryCopy(errors: { field: string; message: string }[]): string {
  const text = errors.map((e) => `${e.field} ${e.message}`).join(" ");
  if (/non-[A-Z]{3}|FX conversion|cross-currency/i.test(text)) {
    return "The buy loan is not in the deal currency. This simulator is unavailable until FX conversion and hedge cashflows are modeled.";
  }
  if (/currency/i.test(text)) {
    return "Enter the buy loan currency above or re-upload the buy list with a currency column.";
  }
  return "";
}

export function SwitchSimulator({ resolved, holdings, buyList, userAssumptions, prefill, resolutionWarnings }: Props) {
  const formatAmount = useFormatAmount();
  const dealCurrency = canonicalCurrency(resolved.currency);
  const [sellLoanIndex, setSellLoanIndex] = useState<number | null>(null);
  const [sellParAmount, setSellParAmount] = useState(0);
  const [buySpreadBps, setBuySpreadBps] = useState(350);
  const [buyRating, setBuyRating] = useState("B");
  const [buyMaturity, setBuyMaturity] = useState(resolved.dates.maturity);
  const [buyParAmount, setBuyParAmount] = useState(0);
  const [buyCurrency, setBuyCurrency] = useState("");
  const [selectedBuyListCurrencyMissing, setSelectedBuyListCurrencyMissing] = useState(false);
  const [selectedBuyScheduleFields, setSelectedBuyScheduleFields] = useState<Partial<BuyLoanScheduleFields> | null>(null);
  const [sellPrice, setSellPrice] = useState(100);
  const [buyPrice, setBuyPrice] = useState(100);

  // Pre-fill from URL params (analysis page redirect) — runs once
  const prefillApplied = React.useRef(false);
  React.useEffect(() => {
    if (!prefill || prefillApplied.current) return;
    prefillApplied.current = true;

    if (prefill.sellName) {
      const target = prefill.sellName.toLowerCase();
      const matchIdx = resolved.loans.findIndex((loan) =>
        loan.obligorName?.toLowerCase().includes(target)
      );
      if (matchIdx >= 0 && resolved.loans[matchIdx]) {
        setSellLoanIndex(matchIdx);
        setSellParAmount(resolved.loans[matchIdx].parBalance);
        setBuyParAmount(resolved.loans[matchIdx].parBalance);
      }
    }
    if (prefill.buySpread) {
      const spread = parseFloat(prefill.buySpread);
      if (!isNaN(spread)) setBuySpreadBps(spread >= 10 ? spread : spread * 100);
    }
    if (prefill.buyRating) setBuyRating(mapToRatingBucket(null, null, null, prefill.buyRating));
    if (prefill.buyMaturity) setBuyMaturity(prefill.buyMaturity);
    if (prefill.buyCurrency) {
      setBuyCurrency(canonicalCurrency(prefill.buyCurrency) ?? prefill.buyCurrency.trim().toUpperCase());
      setSelectedBuyListCurrencyMissing(false);
    } else if (prefill.buyName || prefill.buySpread || prefill.buyRating || prefill.buyMaturity || prefill.buyPar) {
      setBuyCurrency("");
      setSelectedBuyListCurrencyMissing(true);
    }
    if (prefill.buyPar) {
      const par = parseFacilitySizeAmount(prefill.buyPar);
      if (par != null) setBuyParAmount(par);
    }
  }, [prefill, resolved.loans]);

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
    if (prefill?.buyMaturity) return;
    setBuyMaturity(resolved.dates.maturity);
  }, [prefill?.buyMaturity, resolved.dates.maturity]);

  React.useEffect(() => {
    if (prefill) return;
    setBuyCurrency("");
  }, [prefill]);

  const sellOptions = useMemo(() => {
    return resolved.loans.map((loan, idx) => {
      const name = loan.obligorName ?? `Loan ${idx + 1}`;
      return { idx, name, loan };
    });
  }, [resolved.loans]);

  const handleBuyListSelect = useCallback((item: BuyListItem) => {
    if (item.spreadBps) setBuySpreadBps(item.spreadBps);
    if (item.moodysRating || item.spRating) {
      setBuyRating(mapToRatingBucket(item.moodysRating ?? null, item.spRating ?? null, null, null));
    }
    if (item.maturityDate) setBuyMaturity(item.maturityDate);
    if (item.facilitySize) setBuyParAmount(item.facilitySize);
    const itemCurrency = canonicalCurrency(item.currency) ?? item.currency?.trim().toUpperCase() ?? "";
    setBuyCurrency(itemCurrency);
    setSelectedBuyListCurrencyMissing(itemCurrency === "");
    setSelectedBuyScheduleFields(pickBuyLoanScheduleFields(item));
  }, []);

  const buyLoan: ResolvedLoan = useMemo(() => ({
    parBalance: buyParAmount,
    maturityDate: buyMaturity,
    ratingBucket: buyRating,
    spreadBps: buySpreadBps,
    currency: (canonicalCurrency(buyCurrency) ?? buyCurrency.trim().toUpperCase()) || undefined,
    ...(selectedBuyScheduleFields ?? {}),
  }), [buyParAmount, buyMaturity, buyRating, buySpreadBps, buyCurrency, selectedBuyScheduleFields]);

  const { switchResult, baseResult, switchedResult, dataErrors, runtimeError } = useMemo(() => {
    if (sellLoanIndex === null) return { switchResult: null, baseResult: null, switchedResult: null, dataErrors: null, runtimeError: null };
    try {
      const sr = applySwitch(
        resolved,
        { sellLoanIndex, sellParAmount, buyLoan, sellPrice, buyPrice },
        userAssumptions,
        resolutionWarnings,
      );
      const br = runProjection(sr.baseInputs);
      const swr = runProjection(sr.switchedInputs);
      return { switchResult: sr, baseResult: br, switchedResult: swr, dataErrors: null, runtimeError: null };
    } catch (e) {
      if (e instanceof IncompleteDataError) {
        return { switchResult: null, baseResult: null, switchedResult: null, dataErrors: e.errors, runtimeError: null };
      }
      return {
        switchResult: null,
        baseResult: null,
        switchedResult: null,
        dataErrors: null,
        runtimeError: e instanceof Error ? e.message : "Projection failed.",
      };
    }
  }, [resolved, sellLoanIndex, sellParAmount, buyLoan, sellPrice, buyPrice, userAssumptions, resolutionWarnings]);

  // Service-layer deltas — UI never subtracts engine values. See
  // web/lib/clo/services/switch-deltas.ts for the single source of truth.
  const deltas = useMemo(
    () => (baseResult && switchedResult ? computeSwitchDeltas(baseResult, switchedResult) : null),
    [baseResult, switchedResult],
  );

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

      {/* Buy loan — from buy list or manual entry.
          D5: pre-filter candidates against deal PPM triggers (Moody's WARF
          + Minimum WAS) before showing the picker. Partner sees only
          compliance-passing candidates by default, with "M of N match"
          attribution below. Binary excludeCaa/excludeCovLite toggles left
          out — that's UI-redesign scope (tracked as D5.1 follow-up). */}
      {buyList.length > 0 && (() => {
        const prefilledFilters = buyListFiltersFromResolved(resolved);
        const filtered = filterBuyList(buyList, prefilledFilters);
        return (
          <>
            <BuyLoanSelector
              buyList={filtered.passed}
              onSelect={handleBuyListSelect}
              prefillName={prefill?.buyName}
            />
            {filtered.dropped.length > 0 && (
              <div style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", marginTop: "-0.75rem", marginBottom: "0.75rem", opacity: 0.85 }}>
                Buy list filtered to PPM-compliant candidates:
                {" "}{filtered.passed.length} of {buyList.length} match deal caps (Moody's WARF ≤ {prefilledFilters.maxWarfFactor ?? "—"}, min spread ≥ {prefilledFilters.minSpreadBps ?? "—"} bps).
                {" "}{filtered.dropped.length} dropped.
              </div>
            )}
          </>
        );
      })()}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={{ border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", padding: "0.75rem", background: "var(--color-surface)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--color-text-muted)" }}>
              {buyList.length > 0 ? "Buy Loan Details" : "Buy Loan"}
            </div>
            {prefill && buySpreadBps > 0 && (
              <span style={{ fontSize: "0.6rem", fontWeight: 600, padding: "0.1rem 0.35rem", borderRadius: "3px", background: "var(--color-accent)18", color: "var(--color-accent)" }}>FROM ANALYSIS</span>
            )}
          </div>
          {buyList.length > 0 && !prefill && (
            <div style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", marginBottom: "0.5rem", opacity: 0.8 }}>
              Pre-filled from buy list selection above. Adjust any field to override.
            </div>
          )}
          {prefill && (
            <div style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", marginBottom: "0.5rem", opacity: 0.8 }}>
              Pre-filled from switch analysis. Adjust any field to override.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "0.75rem" }}>
            <div><div style={labelStyle}>Spread (bps)</div><input type="number" value={buySpreadBps} onChange={(e) => setBuySpreadBps(parseFloat(e.target.value) || 0)} style={inputStyle} /></div>
            <div><div style={labelStyle}>Rating</div><select value={buyRating} onChange={(e) => setBuyRating(e.target.value)} style={inputStyle}>{RATING_BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}</select></div>
            <div><div style={labelStyle}>Maturity</div><input type="date" value={buyMaturity} onChange={(e) => setBuyMaturity(e.target.value)} style={inputStyle} /></div>
            <div><div style={labelStyle}>Par Amount</div><input type="number" value={buyParAmount} onChange={(e) => setBuyParAmount(parseFloat(e.target.value) || 0)} style={inputStyle} /></div>
            <div>
              <div style={labelStyle}>Currency</div>
              <input
                value={buyCurrency}
                onChange={(e) => {
                  setBuyCurrency(e.target.value.toUpperCase());
                  setSelectedBuyListCurrencyMissing(false);
                }}
                placeholder={dealCurrency ?? "e.g. EUR"}
                style={inputStyle}
              />
              <div style={{ fontSize: "0.62rem", color: selectedBuyListCurrencyMissing ? "var(--color-low)" : "var(--color-text-muted)", marginTop: "0.2rem" }}>
                {selectedBuyListCurrencyMissing ? "Buy-list item has no currency. Enter a 3-letter code." : `3-letter code${dealCurrency ? `, e.g. ${dealCurrency}.` : "."}`}
              </div>
            </div>
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

      {dataErrors && dataErrors.length > 0 && (
        <div style={{ padding: "1rem", color: "var(--color-text-muted)", fontSize: "0.85rem", border: "1px dashed var(--color-border-light)", borderRadius: "var(--radius-sm)" }}>
          Unable to simulate switch — {switchCurrencyRecoveryCopy(dataErrors) || "Projection inputs are incomplete."}
        </div>
      )}

      {runtimeError && (
        <div style={{ padding: "1rem", color: "var(--color-text-muted)", fontSize: "0.85rem", border: "1px dashed var(--color-border-light)", borderRadius: "var(--radius-sm)" }}>
          Unable to simulate switch — {runtimeError}
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
                <td style={{ ...cellStyle, color: formatIrrDelta(deltas?.equityIrrDelta ?? null).color, fontWeight: 600 }}>{formatIrrDelta(deltas?.equityIrrDelta ?? null).text}</td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Total Equity Distributions</td>
                <td style={cellStyle}>{formatAmount(baseResult.totalEquityDistributions)}</td>
                <td style={cellStyle}>{formatAmount(switchedResult.totalEquityDistributions)}</td>
                <td
                  style={{
                    ...cellStyle,
                    color: deltas && deltas.totalEquityDistributionsDelta > 0
                      ? "var(--color-high)"
                      : deltas && deltas.totalEquityDistributionsDelta < 0
                        ? "var(--color-low)"
                        : "inherit",
                  }}
                >
                  {deltas ? formatAmount(deltas.totalEquityDistributionsDelta) : "—"}
                </td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Spread (swapped position)</td>
                <td style={cellStyle}>{sellLoan?.spreadBps ?? "—"} bps</td>
                <td style={cellStyle}>{buySpreadBps} bps</td>
                <td
                  style={{
                    ...cellStyle,
                    color: switchResult.spreadDelta > 0
                      ? "var(--color-high)"
                      : switchResult.spreadDelta < 0
                        ? "var(--color-low)"
                        : "inherit",
                  }}
                >
                  {switchResult.spreadDelta > 0 ? "+" : ""}
                  {switchResult.spreadDelta} bps
                </td>
              </tr>
              <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ ...cellStyle, textAlign: "left" }}>Rating (swapped position)</td>
                <td style={cellStyle}>{switchResult.ratingChange.from}</td>
                <td style={cellStyle}>{switchResult.ratingChange.to}</td>
                <td style={cellStyle}>
                  {switchResult.ratingChange.from === switchResult.ratingChange.to
                    ? "—"
                    : switchResult.ratingChange.from + " → " + switchResult.ratingChange.to}
                </td>
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
  const formatAmount = useFormatAmount();
  // Per-OC-test cushion deltas + per-period equity deltas come from the
  // service layer — UI never subtracts engine values inline.
  const deltas = computeSwitchDeltas(baseResult, switchedResult);
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
              {deltas.ocCushionDeltasPeriod1.map((d) => (
                  <tr key={d.className} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                    <td style={{ ...cellStyle, textAlign: "left", fontWeight: 500 }}>{d.className}</td>
                    <td style={cellStyle}>{d.baseActual.toFixed(2)}%</td>
                    <td style={cellStyle}>{d.switchedActual == null ? "—" : `${d.switchedActual.toFixed(2)}%`}</td>
                    <td
                      style={{
                        ...cellStyle,
                        color: d.switchedActual == null
                          ? "inherit"
                          : d.delta > 0
                            ? "var(--color-high)"
                            : d.delta < 0
                              ? "var(--color-low)"
                              : "inherit",
                      }}
                    >
                      {d.switchedActual == null ? "—" : `${d.delta > 0 ? "+" : ""}${d.delta.toFixed(2)}%`}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>Equity Distribution Delta (First 12 Quarters)</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "2px solid var(--color-border)" }}><th style={{ ...headerStyle, textAlign: "left" }}>Quarter</th><th style={headerStyle}>Before</th><th style={headerStyle}>After</th><th style={headerStyle}>Delta</th></tr></thead>
            <tbody>
              {deltas.equityDistributionDeltasByPeriod.slice(0, 12).map((d) => (
                  <tr key={d.period} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                    <td style={{ ...cellStyle, textAlign: "left", fontWeight: 500 }}>Q{d.period}</td>
                    <td style={cellStyle}>{formatAmount(d.baseAmount)}</td>
                    <td style={cellStyle}>{formatAmount(d.switchedAmount)}</td>
                    <td style={{ ...cellStyle, color: d.delta > 0 ? "var(--color-high)" : d.delta < 0 ? "var(--color-low)" : "inherit" }}>
                      {d.delta !== 0 ? formatAmount(d.delta) : "—"}
                    </td>
                  </tr>
                ))}
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
  const formatAmount = useFormatAmount();

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
  prefillName,
}: {
  buyList: BuyListItem[];
  onSelect: (item: BuyListItem) => void;
  prefillName?: string | null;
}) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(!prefillName);
  const formatAmount = useFormatAmount();

  // Auto-match from prefill name
  React.useEffect(() => {
    if (!prefillName || selectedId) return;
    const match = buyList.find((item) =>
      item.obligorName.toLowerCase().includes(prefillName.toLowerCase())
    );
    if (match) {
      setSelectedId(match.id);
      setOpen(false);
      onSelect(match);
    }
  }, [prefillName, buyList, selectedId, onSelect]);

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
    return formatAmount(item.facilitySize);
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
              {[selected.sector, formatRating(selected), selected.spreadBps ? `${selected.spreadBps} bps` : null, selected.currency, formatSize(selected)].filter(Boolean).join(" · ")}
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
                      {[item.sector, formatRating(item), item.spreadBps ? `${item.spreadBps} bps` : null, item.currency, formatSize(item)].filter(Boolean).join(" · ")}
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
