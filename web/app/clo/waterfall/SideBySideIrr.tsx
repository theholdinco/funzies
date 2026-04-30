"use client";

import React from "react";
import { formatPct } from "./helpers";

/**
 * Post-v6 plan §9 #5 / option (d): side-by-side IRR cell. Each side accepts
 * `number` (IRR — formatted as a percent), `string` (status fallback like
 * "wiped out" / "no forward data"), or `null` (renders as "—"). The
 * `withCall` parameter can additionally be `undefined`, which means "no
 * with-call companion exists for this deal" and triggers single-column
 * graceful degradation. The "(more conservative)" marker only appears when
 * both sides are numeric (status text or null are incomparable). This
 * reverses the regression introduced by the original (d) ship where
 * non-computed mark-to-model statuses degraded to "— · —" with no
 * indication of why; status text now propagates through the cell.
 *
 * Extracted from `ProjectionModel.tsx` to enable render-state tests
 * (`__tests__/SideBySideIrr.test.tsx`).
 */
export type IrrCellValue = number | string | null;

export function SideBySideIrr({
  noCall,
  withCall,
}: {
  noCall: IrrCellValue;
  withCall: IrrCellValue | undefined;
}) {
  const fmt = (v: IrrCellValue): string => {
    if (typeof v === "string") return v;
    if (v == null) return "—";
    return formatPct(v * 100);
  };
  if (withCall === undefined) {
    return (
      <strong style={{ fontFamily: "var(--font-display)", fontSize: "1rem", letterSpacing: "-0.02em" }}>
        {fmt(noCall)}
      </strong>
    );
  }
  const bothNumeric = typeof noCall === "number" && typeof withCall === "number";
  const noCallLower = bothNumeric && (noCall as number) < (withCall as number);
  const withCallLower = bothNumeric && (withCall as number) < (noCall as number);
  const conservativeMarker = (
    <span style={{ fontSize: "0.6rem", fontWeight: 400, opacity: 0.75, marginLeft: "0.15rem" }}>(more conservative)</span>
  );
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: "0.3rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
      <span style={{ display: "inline-flex", alignItems: "baseline" }}>
        <strong style={{ fontFamily: "var(--font-display)", fontSize: "1rem", letterSpacing: "-0.02em" }}>
          {fmt(noCall)}
        </strong>
        {noCallLower && conservativeMarker}
      </span>
      <span style={{ opacity: 0.5 }}>{"·"}</span>
      <span style={{ display: "inline-flex", alignItems: "baseline" }}>
        <strong style={{ fontFamily: "var(--font-display)", fontSize: "1rem", letterSpacing: "-0.02em" }}>
          {fmt(withCall)}
        </strong>
        {withCallLower && conservativeMarker}
      </span>
    </span>
  );
}
