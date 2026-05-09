"use client";

import { useState, useMemo } from "react";
import type { ResolvedDealData, ResolvedLoan, ResolutionWarning } from "@/lib/clo/resolver-types";
import { runProjection } from "@/lib/clo/projection";
import { applySwitch } from "@/lib/clo/switch-simulator";
import { computeSwitchDeltas } from "@/lib/clo/services";
import { DEFAULT_ASSUMPTIONS, IncompleteDataError, type UserAssumptions } from "@/lib/clo/build-projection-inputs";
import { mapToRatingBucket } from "@/lib/clo/rating-mapping";
import { canonicalCurrency } from "@/lib/clo/currency";
import { parseFacilitySizeAmount } from "@/lib/clo/facility-size";
import { formatAmount as helpersFormatAmount } from "@/app/clo/waterfall/helpers";

interface LoanDescription {
  borrowerName: string;
  spreadCoupon: string;
  rating: string;
  maturity: string;
  facilitySize: string;
  currency?: string | null;
}

interface Props {
  resolved: ResolvedDealData;
  sellLoan: LoanDescription;
  buyLoan: LoanDescription;
  assumptions?: UserAssumptions;
  // Threaded through to applySwitch so its buildFromResolved gate
  // fires on blocking warnings. Optional; gate bypasses if omitted.
  resolutionWarnings?: ResolutionWarning[];
}

function parseSpread(s: string): number {
  const m = s.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function formatPct(v: number | null): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function formatIrrDelta(delta: number | null): { text: string; color: string } {
  if (delta == null) return { text: "—", color: "inherit" };
  const sign = delta >= 0 ? "+" : "";
  return {
    text: `${sign}${(delta * 100).toFixed(2)}%`,
    color: delta > 0 ? "var(--color-high, #2a7)" : delta < 0 ? "var(--color-low, #c44)" : "inherit",
  };
}

function switchCurrencyRecoveryCopy(errors: { field: string; message: string }[]): string {
  const text = errors.map((e) => `${e.field} ${e.message}`).join(" ");
  if (/non-[A-Z]{3}|FX conversion|cross-currency/i.test(text)) {
    return "The buy loan is not in the deal currency. Waterfall impact is unavailable until FX conversion and hedge cashflows are modeled.";
  }
  if (/currency/i.test(text)) {
    return "Add the buy loan currency to the switch analysis or re-upload the buy list with a currency column.";
  }
  return "";
}

export default function SwitchWaterfallImpact({ resolved, sellLoan, buyLoan, assumptions, resolutionWarnings }: Props) {
  const [sellPrice, setSellPrice] = useState(100);
  const [buyPrice, setBuyPrice] = useState(100);
  const [expanded, setExpanded] = useState(false);
  const formatAmount = (v: number) => helpersFormatAmount(v, resolved.currency);

  const sellIndex = useMemo(() => {
    const sellSpread = parseSpread(sellLoan.spreadCoupon);
    const sellRating = mapToRatingBucket(null, null, null, sellLoan.rating);
    const idx = resolved.loans.findIndex(
      (l) => l.ratingBucket === sellRating && Math.abs(l.spreadBps - sellSpread) < 50,
    );
    return idx >= 0 ? idx : 0;
  }, [resolved.loans, sellLoan]);

  const buyResolvedLoan: ResolvedLoan = useMemo(() => {
    const spread = parseSpread(buyLoan.spreadCoupon);
    const rating = mapToRatingBucket(null, null, null, buyLoan.rating);
    const par = parseFacilitySizeAmount(buyLoan.facilitySize) || resolved.loans[sellIndex]?.parBalance || 0;
    return {
      parBalance: par,
      maturityDate: buyLoan.maturity || resolved.dates.maturity,
      ratingBucket: rating,
      spreadBps: spread > 0 ? (spread < 10 ? Math.round(spread * 100) : Math.round(spread)) : resolved.poolSummary.wacSpreadBps,
      currency: (canonicalCurrency(buyLoan.currency) ?? buyLoan.currency?.trim().toUpperCase()) || undefined,
    };
  }, [buyLoan, resolved, sellIndex]);

  const switchComputation = useMemo(() => {
    if (sellIndex < 0 || !resolved.loans[sellIndex]) return null;
    try {
      return {
        switchResult: applySwitch(
          resolved,
          { sellLoanIndex: sellIndex, sellParAmount: resolved.loans[sellIndex].parBalance, buyLoan: buyResolvedLoan, sellPrice, buyPrice },
          assumptions ?? DEFAULT_ASSUMPTIONS,
          resolutionWarnings,
        ),
        dataErrors: null,
      };
    } catch (e) {
      if (e instanceof IncompleteDataError) {
        return { switchResult: null, dataErrors: e.errors };
      }
      throw e;
    }
  }, [resolved, sellIndex, buyResolvedLoan, sellPrice, buyPrice, assumptions, resolutionWarnings]);
  const switchResult = switchComputation?.switchResult ?? null;
  const dataErrors = switchComputation?.dataErrors ?? null;

  const projectionComputation = useMemo(() => {
    if (!switchResult) return { baseResult: null, switchedResult: null, runtimeError: null };
    try {
      return {
        baseResult: runProjection(switchResult.baseInputs),
        switchedResult: runProjection(switchResult.switchedInputs),
        runtimeError: null,
      };
    } catch (e) {
      return {
        baseResult: null,
        switchedResult: null,
        runtimeError: e instanceof Error ? e.message : "Projection failed.",
      };
    }
  }, [switchResult]);
  const baseResult = projectionComputation.baseResult;
  const switchedResult = projectionComputation.switchedResult;

  if (dataErrors && dataErrors.length > 0) {
    return (
      <p style={{ padding: "1rem", color: "var(--color-text-muted)" }}>
        Unable to simulate switch — {switchCurrencyRecoveryCopy(dataErrors) || "Projection inputs are incomplete."}
      </p>
    );
  }

  if (projectionComputation.runtimeError) {
    return (
      <p style={{ padding: "1rem", color: "var(--color-text-muted)" }}>
        Unable to simulate switch — {projectionComputation.runtimeError}
      </p>
    );
  }

  if (!switchResult || !baseResult || !switchedResult) {
    return <p style={{ padding: "1rem", color: "var(--color-text-muted)" }}>Unable to simulate switch — loan matching failed.</p>;
  }

  // All deltas come from the service helper — UI never subtracts engine
  // values inline. See web/lib/clo/services/switch-deltas.ts for the
  // single source of truth.
  const deltas = computeSwitchDeltas(baseResult, switchedResult);
  const irrDelta = formatIrrDelta(deltas.equityIrrDelta);

  const cellStyle: React.CSSProperties = {
    padding: "0.5rem 0.75rem",
    fontSize: "0.8rem",
    fontFamily: "var(--font-mono)",
    textAlign: "right",
  };

  const headerStyle: React.CSSProperties = {
    ...cellStyle,
    fontWeight: 600,
    fontSize: "0.7rem",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
    fontFamily: "var(--font-body)",
  };

  return (
    <div style={{ maxWidth: "48rem" }}>
      <h3 style={{ fontSize: "0.95rem", fontWeight: 600, marginBottom: "1rem" }}>Waterfall Impact</h3>

      {/* Transaction cost inputs */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.25rem", fontSize: "0.8rem" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          Sell price:
          <input
            type="number"
            value={sellPrice}
            onChange={(e) => setSellPrice(parseFloat(e.target.value) || 100)}
            style={{
              width: "4rem",
              padding: "0.3rem",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              fontSize: "0.8rem",
              fontFamily: "var(--font-mono)",
            }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          Buy price:
          <input
            type="number"
            value={buyPrice}
            onChange={(e) => setBuyPrice(parseFloat(e.target.value) || 100)}
            style={{
              width: "4rem",
              padding: "0.3rem",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              fontSize: "0.8rem",
              fontFamily: "var(--font-mono)",
            }}
          />
        </label>
      </div>

      {/* Delta summary table */}
      <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)" }}>
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
            <td style={cellStyle}>{formatPct(baseResult.equityIrr)}</td>
            <td style={cellStyle}>{formatPct(switchedResult.equityIrr)}</td>
            <td style={{ ...cellStyle, color: irrDelta.color, fontWeight: 600 }}>{irrDelta.text}</td>
          </tr>
          <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
            <td style={{ ...cellStyle, textAlign: "left" }}>Total Equity Distributions</td>
            <td style={cellStyle}>{formatAmount(baseResult.totalEquityDistributions)}</td>
            <td style={cellStyle}>{formatAmount(switchedResult.totalEquityDistributions)}</td>
            <td
              style={{
                ...cellStyle,
                color:
                  deltas.totalEquityDistributionsDelta > 0
                    ? "var(--color-high, #2a7)"
                    : deltas.totalEquityDistributionsDelta < 0
                      ? "var(--color-low, #c44)"
                      : "inherit",
              }}
            >
              {formatAmount(deltas.totalEquityDistributionsDelta)}
            </td>
          </tr>
          <tr style={{ borderBottom: "1px solid var(--color-border-light)" }}>
            <td style={{ ...cellStyle, textAlign: "left" }}>Spread (swapped position)</td>
            <td style={cellStyle}>{resolved.loans[sellIndex]?.spreadBps ?? 0} bps</td>
            <td style={cellStyle}>{buyResolvedLoan.spreadBps} bps</td>
            <td
              style={{
                ...cellStyle,
                color:
                  switchResult.spreadDelta > 0
                    ? "var(--color-high, #2a7)"
                    : switchResult.spreadDelta < 0
                      ? "var(--color-low, #c44)"
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
          <tr>
            <td style={{ ...cellStyle, textAlign: "left" }}>Par Impact</td>
            <td style={cellStyle}>—</td>
            <td style={cellStyle}>—</td>
            <td style={{ ...cellStyle, color: switchResult.parDelta >= 0 ? "var(--color-high, #2a7)" : "var(--color-low, #c44)" }}>
              {formatAmount(switchResult.parDelta)}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Expandable OC cushion detail */}
      <div
        style={{
          marginTop: "1rem",
          border: "1px solid var(--color-border-light)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)",
        }}
      >
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            width: "100%",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "0.6rem 0.8rem",
            fontSize: "0.8rem",
            fontWeight: 600,
            color: "var(--color-text-secondary)",
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            textAlign: "left",
            fontFamily: "var(--font-body)",
          }}
        >
          <span style={{ fontSize: "0.65rem" }}>{expanded ? "▾" : "▸"}</span>
          OC Cushion & Cash Flow Detail
        </button>

        {expanded && (
          <div style={{ padding: "0 0.8rem 0.8rem" }}>
            <div
              style={{
                fontSize: "0.7rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--color-text-muted)",
                marginBottom: "0.4rem",
              }}
            >
              OC Cushion Changes (Period 1)
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "1rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <th style={{ ...headerStyle, textAlign: "left" }}>Class</th>
                  <th style={headerStyle}>Before</th>
                  <th style={headerStyle}>After</th>
                  <th style={headerStyle}>Delta</th>
                </tr>
              </thead>
              <tbody>
                {deltas.ocCushionDeltasPeriod1.map((d) => (
                    <tr key={d.className} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                      <td style={{ ...cellStyle, textAlign: "left" }}>{d.className}</td>
                      <td style={cellStyle}>{d.baseActual.toFixed(2)}%</td>
                      <td style={cellStyle}>{d.switchedActual == null ? "—" : `${d.switchedActual.toFixed(2)}%`}</td>
                      <td
                        style={{
                          ...cellStyle,
                          color: d.switchedActual == null
                            ? "inherit"
                            : d.delta > 0
                              ? "var(--color-high, #2a7)"
                              : d.delta < 0
                                ? "var(--color-low, #c44)"
                                : "inherit",
                        }}
                      >
                        {d.switchedActual == null ? "—" : `${d.delta > 0 ? "+" : ""}${d.delta.toFixed(2)}%`}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>

            <div
              style={{
                fontSize: "0.7rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: "var(--color-text-muted)",
                marginBottom: "0.4rem",
              }}
            >
              Equity Distribution Delta (first 12 quarters)
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <th style={{ ...headerStyle, textAlign: "left" }}>Quarter</th>
                  <th style={headerStyle}>Before</th>
                  <th style={headerStyle}>After</th>
                  <th style={headerStyle}>Delta</th>
                </tr>
              </thead>
              <tbody>
                {deltas.equityDistributionDeltasByPeriod.slice(0, 12).map((row) => {
                  return (
                    <tr key={row.period} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                      <td style={{ ...cellStyle, textAlign: "left" }}>Q{row.period}</td>
                      <td style={cellStyle}>{formatAmount(row.baseAmount)}</td>
                      <td style={cellStyle}>{formatAmount(row.switchedAmount)}</td>
                      <td
                        style={{
                          ...cellStyle,
                          color: row.delta > 0 ? "var(--color-high, #2a7)" : row.delta < 0 ? "var(--color-low, #c44)" : "inherit",
                        }}
                      >
                        {row.delta !== 0 ? formatAmount(row.delta) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
