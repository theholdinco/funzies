"use client";

import React, { useState } from "react";
import { RATING_BUCKETS } from "@/lib/clo/rating-mapping";

/** Visual indicator of what's driving the displayed per-bucket rate.
 *  - WARF: bucket not in overriddenBuckets — engine uses per-loan
 *    `warfFactorToQuarterlyHazard(loan.warfFactor)` for every loan in
 *    the bucket; the panel displays the WARF-seeded par-weighted
 *    bucket aggregate (set by the WARF-seed effect in ProjectionModel).
 *  - Intex: bucket is overridden AND current rate equals the active
 *    Intex CDR — engine consumes the Intex scenario rate.
 *  - Override: bucket is overridden AND current rate ≠ Intex CDR (or
 *    no Intex active) — user explicitly set this rate.
 *
 *  This was added after a class of silent-wrong-number bugs where the
 *  Intex overlay set `defaultRates` without setting `overriddenBuckets`,
 *  so the panel displayed Intex CDR while the engine silently ran WARF.
 *  Without source visibility, the same shape can come back as new
 *  overlay sources land; the badge forces a runtime answer to "what is
 *  the engine actually using." */
type SourceBadge = "WARF" | "Override" | "Intex";

function bucketSource(
  bucket: string,
  overriddenBuckets: readonly string[],
  intexCdrPct: number | null,
  currentRate: number,
): SourceBadge {
  if (!overriddenBuckets.includes(bucket)) return "WARF";
  if (intexCdrPct != null && Math.abs(currentRate - intexCdrPct) < 1e-9) {
    return "Intex";
  }
  return "Override";
}

const BADGE_STYLES: Record<SourceBadge, React.CSSProperties> = {
  WARF: {
    color: "var(--color-text-muted)",
    background: "var(--color-surface-alt, rgba(0,0,0,0.04))",
    border: "1px solid var(--color-border-light)",
  },
  Override: {
    color: "var(--color-accent, #2563eb)",
    background: "var(--color-accent-bg, rgba(37,99,235,0.08))",
    border: "1px solid var(--color-accent, #2563eb)",
  },
  Intex: {
    color: "var(--color-warning, #d97706)",
    background: "rgba(217,119,6,0.08)",
    border: "1px solid var(--color-warning, #d97706)",
  },
};

export function DefaultRatePanel({
  defaultRates,
  onChange,
  onApplyUniform,
  ratingDistribution,
  weightedAvgCdr,
  overriddenBuckets,
  intexCdrPct,
}: {
  defaultRates: Record<string, number>;
  /** Slider-drag handler. Delta-based override marking is fine here
   *  — user clearly intends to override any bucket they drag. */
  onChange: (rates: Record<string, number>) => void;
  /** "Set all to X% / Apply" handler. The consumer marks every
   *  RATING_BUCKETS bucket overridden (including buckets that are
   *  currently empty in the pool — future reinvestment into those
   *  buckets should also be hit by the user's stated rate, not
   *  silently fall back to WARF). Unconditional regardless of
   *  whether the displayed value numerically changed — an explicit
   *  "Apply 2%" when the panel already shows 2% should still take
   *  effect (historical bug: delta-based handler silently no-op'd
   *  this case). */
  onApplyUniform: (rate: number) => void;
  ratingDistribution: Record<string, { count: number; par: number }>;
  weightedAvgCdr: number;
  /** Buckets the engine is currently honoring user/scenario rates for.
   *  Drives the source badge per bucket. */
  overriddenBuckets: readonly string[];
  /** Active Intex CDR rate, if any. When set AND a bucket's current
   *  rate equals it, the bucket's badge reads "Intex" instead of
   *  "Override". */
  intexCdrPct: number | null;
}) {
  const [open, setOpen] = useState(true);
  const [uniformInput, setUniformInput] = useState("");

  const applyUniform = () => {
    const val = parseFloat(uniformInput);
    if (!isNaN(val) && val >= 0) {
      onApplyUniform(val);
      setUniformInput("");
    }
  };

  const totalPar = Object.values(ratingDistribution).reduce((s, d) => s + d.par, 0);

  return (
    <div
      style={{
        border: "1px solid var(--color-border-light)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-surface)",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0.6rem 0.8rem",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "0.75rem",
          color: "var(--color-text-secondary)",
          textAlign: "left",
          fontFamily: "var(--font-body)",
        }}
      >
        <span>
          <span style={{ fontSize: "0.65rem", marginRight: "0.3rem" }}>{open ? "▾" : "▸"}</span>
          Default Rates by Rating
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
          Wtd Avg: {weightedAvgCdr.toFixed(2)}%
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem", paddingBottom: "0.5rem", borderBottom: "1px solid var(--color-border-light)" }}>
            <label style={{ fontSize: "0.7rem", color: "var(--color-text-muted)" }}>Set all to:</label>
            <input
              type="number"
              value={uniformInput}
              onChange={(e) => setUniformInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyUniform()}
              placeholder="%"
              style={{
                width: "4rem",
                padding: "0.25rem 0.4rem",
                fontSize: "0.75rem",
                fontFamily: "var(--font-mono)",
                border: "1px solid var(--color-border-light)",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-bg)",
              }}
            />
            <button
              onClick={applyUniform}
              style={{
                padding: "0.25rem 0.5rem",
                fontSize: "0.7rem",
                background: "var(--color-surface-alt)",
                border: "1px solid var(--color-border-light)",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}
            >
              Apply
            </button>
          </div>

          {RATING_BUCKETS.filter((b) => ratingDistribution[b]?.par > 0).map((bucket) => {
            const dist = ratingDistribution[bucket];
            const parPct = totalPar > 0 ? (dist.par / totalPar) * 100 : 0;
            const source = bucketSource(
              bucket,
              overriddenBuckets,
              intexCdrPct,
              defaultRates[bucket] ?? 0,
            );
            return (
              <div key={bucket} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.3rem 0" }}>
                <div style={{ width: "2.5rem", fontSize: "0.72rem", fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
                  {bucket}
                </div>
                <div style={{ width: "4rem", fontSize: "0.65rem", color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                  {dist.count > 0 ? `${dist.count} · ${parPct.toFixed(0)}%` : "—"}
                </div>
                <input
                  type="range"
                  className="wf-slider"
                  min={0}
                  max={20}
                  step={0.1}
                  value={defaultRates[bucket] ?? 0}
                  onChange={(e) => onChange({ ...defaultRates, [bucket]: parseFloat(e.target.value) })}
                  style={{ flex: 1 }}
                />
                <span style={{ width: "3rem", textAlign: "right", fontSize: "0.72rem", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                  {(defaultRates[bucket] ?? 0).toFixed(1)}%
                </span>
                <span
                  title={
                    source === "WARF"
                      ? "Engine uses per-loan WARF hazard for this bucket. Displayed value is the WARF-seeded par-weighted aggregate; move the slider to override."
                      : source === "Intex"
                        ? "Active Intex CDR scenario rate. Engine consumes this exact value for the whole bucket."
                        : "User override. Engine consumes this exact value for the whole bucket."
                  }
                  style={{
                    fontSize: "0.58rem",
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    padding: "0.1rem 0.3rem",
                    borderRadius: "3px",
                    letterSpacing: "0.04em",
                    minWidth: "3.4rem",
                    textAlign: "center",
                    ...BADGE_STYLES[source],
                  }}
                >
                  {source.toUpperCase()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
