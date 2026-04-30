"use client";

import React from "react";
import { type FairValueResult } from "@/lib/clo/services";
import { compareConservative, formatCallDate } from "./comparison-encoding";
import { formatPct } from "./helpers";

/**
 * Forward IRR card body — tabular layout with explicit `no call` /
 * `called Mmm 'YY` column headers when a with-call companion exists.
 * Conservative side renders bold/full-opacity; the higher (less
 * conservative) side renders regular-weight at 0.55 opacity. Equality,
 * status text, and null all collapse to neutral rendering (no bold,
 * no dim) — the strict-inequality bug from the prior fair-value branch
 * is fixed at the helper layer.
 *
 * Extracted from `ProjectionModel.tsx` so the render shape is testable
 * via `react-dom/server` against synthetic fixtures (healthy / wiped-out
 * / no-with-call) without mounting the full ProjectionModel state tree.
 */
export interface ForwardIrrRow {
  label: string;
  /** Anchor price; null for fair-value row (variable). */
  cents: number | null;
  noCall: number | null;
  /** undefined = no with-call companion (single column); null = with-call exists but no IRR. */
  withCall: number | null | undefined;
}

export interface ForwardIrrTableProps {
  rows: ForwardIrrRow[];
  fairValueNoCall: FairValueResult | null;
  fairValueWithCall: FairValueResult | null;
  /** Whether the deal has a meaningful with-call comparison. Drives the
   *  3- vs 2-column layout, headers, and legend. */
  hasWithCall: boolean;
  /** ISO date used for the "called Mmm 'YY" column header. Required when
   *  `hasWithCall` is true. */
  withCallDate: string | null;
  /** Optional @custom row appended at the bottom with a divider. */
  customEntryIrr: { noCall: number | null; withCall: number | null | undefined } | null;
  customEntryPriceCents: number | null;
}

const labelStyle: React.CSSProperties = {
  color: "rgba(255,255,255,0.85)",
  fontSize: "0.78rem",
};

const headerStyle: React.CSSProperties = {
  fontSize: "0.55rem",
  fontWeight: 500,
  color: "rgba(255,255,255,0.6)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  textAlign: "right",
};

function valueCellStyle(isConservative: boolean, isDimmed: boolean): React.CSSProperties {
  return {
    fontFamily: "var(--font-display)",
    fontSize: "0.95rem",
    letterSpacing: "-0.02em",
    fontWeight: isConservative ? 700 : 500,
    opacity: isDimmed ? 0.55 : 1,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  };
}

function fmtIrr(v: number | string | null | undefined): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "string") return v;
  return formatPct(v * 100);
}

function renderPrice(fv: FairValueResult | null): string {
  if (!fv) return "—";
  if (fv.status === "converged" && fv.priceCents != null) return `${fv.priceCents.toFixed(0)}c`;
  if (fv.status === "below_hurdle") return "below hurdle";
  if (fv.status === "above_max_bracket") return "exceeds 200c";
  return "—";
}

export function ForwardIrrTable({
  rows,
  fairValueNoCall,
  fairValueWithCall,
  hasWithCall,
  withCallDate,
  customEntryIrr,
  customEntryPriceCents,
}: ForwardIrrTableProps) {
  const fvNoCallPrice = fairValueNoCall?.status === "converged" ? fairValueNoCall.priceCents : null;
  const fvWithCallPrice = fairValueWithCall?.status === "converged" ? fairValueWithCall.priceCents : null;
  const fvEnc = compareConservative(fvNoCallPrice, fvWithCallPrice);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: hasWithCall ? "1fr auto auto" : "1fr auto",
        columnGap: "0.9rem",
        rowGap: "0.35rem",
        alignItems: "baseline",
      }}
    >
      {hasWithCall && withCallDate && (
        <>
          <span />
          <span style={headerStyle}>no call</span>
          <span style={headerStyle}>called {formatCallDate(withCallDate)}</span>
        </>
      )}
      {rows.map((row) => {
        // In single-column mode there's no comparison to encode, so
        // force neutral rendering (no bold, no dim). Otherwise the
        // no-call cell would render bold against an unshown with-call
        // value, suggesting a comparison the partner can't see.
        const enc = hasWithCall ? compareConservative(row.noCall, row.withCall) : null;
        return (
          <React.Fragment key={row.label}>
            <span style={labelStyle}>
              {row.label}
              {row.cents != null && ` (${row.cents.toFixed(0)}c)`}
            </span>
            <span style={valueCellStyle(enc?.aBold ?? false, enc?.aDim ?? false)}>{fmtIrr(row.noCall)}</span>
            {hasWithCall && enc && (
              <span style={valueCellStyle(enc.bBold, enc.bDim)}>{fmtIrr(row.withCall)}</span>
            )}
          </React.Fragment>
        );
      })}
      {fairValueNoCall && (
        <>
          <span style={labelStyle}>@ fair value-10%</span>
          <span style={valueCellStyle(hasWithCall && fvEnc.aBold, hasWithCall && fvEnc.aDim)}>{renderPrice(fairValueNoCall)}</span>
          {hasWithCall && (
            <span style={valueCellStyle(fvEnc.bBold, fvEnc.bDim)}>{renderPrice(fairValueWithCall)}</span>
          )}
        </>
      )}
      {customEntryPriceCents != null && customEntryIrr && (() => {
        const enc = hasWithCall ? compareConservative(customEntryIrr.noCall, customEntryIrr.withCall) : null;
        const customLabelStyle: React.CSSProperties = {
          ...labelStyle,
          color: "rgba(255,255,255,0.7)",
          fontSize: "0.72rem",
          paddingTop: "0.4rem",
          borderTop: "1px solid rgba(255,255,255,0.18)",
        };
        const customValueStyle = (b: boolean, d: boolean): React.CSSProperties => ({
          ...valueCellStyle(b, d),
          fontSize: "0.85rem",
          paddingTop: "0.4rem",
          borderTop: "1px solid rgba(255,255,255,0.18)",
        });
        return (
          <>
            <span style={customLabelStyle}>@ custom ({customEntryPriceCents}c)</span>
            <span style={customValueStyle(enc?.aBold ?? false, enc?.aDim ?? false)}>{fmtIrr(customEntryIrr.noCall)}</span>
            {hasWithCall && enc && (
              <span style={customValueStyle(enc.bBold, enc.bDim)}>{fmtIrr(customEntryIrr.withCall)}</span>
            )}
          </>
        );
      })()}
      {hasWithCall && (
        <span
          style={{
            gridColumn: "1 / -1",
            fontSize: "0.55rem",
            fontWeight: 400,
            color: "rgba(255,255,255,0.55)",
            marginTop: "0.4rem",
            textAlign: "right",
            letterSpacing: "0.02em",
          }}
        >
          bold = more conservative
        </span>
      )}
    </div>
  );
}
