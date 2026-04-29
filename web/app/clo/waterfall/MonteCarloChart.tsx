"use client";

import { useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer,
  AreaChart, Area,
} from "recharts";
import type { MonteCarloResult } from "@/lib/clo/monte-carlo";

interface Props {
  result: MonteCarloResult | null;
  running: boolean;
  progress: number;
}

function buildHistogramData(irrs: Float64Array): { bucket: string; mid: number; count: number; pct: number }[] {
  const MIN = -0.5;
  const MAX = 0.4;
  const STEP = 0.02;
  const buckets: { bucket: string; mid: number; count: number; pct: number }[] = [];

  for (let lo = MIN; lo < MAX; lo += STEP) {
    const mid = lo + STEP / 2;
    let count = 0;
    for (let i = 0; i < irrs.length; i++) {
      if (irrs[i] >= lo && irrs[i] < lo + STEP) count++;
    }
    buckets.push({
      bucket: `${(lo * 100).toFixed(0)}%`,
      mid,
      count,
      pct: (count / irrs.length) * 100,
    });
  }
  return buckets;
}

function findNearestBucket(data: { bucket: string; mid: number }[], value: number | null | undefined): string | undefined {
  if (value == null || data.length === 0) return undefined;
  // Clamp to histogram range — prevents reference lines from vanishing in extreme scenarios
  let best = data[0];
  let bestDist = Math.abs(data[0].mid - value);
  for (const d of data) {
    const dist = Math.abs(d.mid - value);
    if (dist < bestDist) { best = d; bestDist = dist; }
  }
  return best.bucket;
}

function formatPct(v: number | null | undefined): string {
  if (v == null) return "\u2014";
  return `${(v * 100).toFixed(1)}%`;
}

const OC_CLASS_COLORS: Record<string, string> = {
  "A/B": "#1a5276", "C": "#6c3483", "D": "#1e8449", "E": "#b9770e", "F": "#c0392b",
};

function OcFailureSection({ result }: { result: MonteCarloResult }) {
  const [expanded, setExpanded] = useState(false);
  const peak = result.peakOcFailurePct;
  const stressLabel = peak < 2 ? "very low" : peak < 10 ? "low" : peak < 25 ? "moderate" : peak < 50 ? "elevated" : "high";

  // Get all OC classes from the first quarter's byClass
  const ocClasses = Object.keys(result.ocFailureByQuarter[0]?.byClass ?? {});

  return (
    <div style={{
      marginTop: "0.75rem",
      border: "1px solid var(--color-border-light)",
      borderRadius: "var(--radius-sm)",
      background: "var(--color-surface)",
    }}>
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
        OC Stress: {stressLabel}
        <span style={{ fontWeight: 400, color: "var(--color-text-muted)" }}>({peak.toFixed(1)}% peak failure rate)</span>
      </button>

      {expanded && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={result.ocFailureByQuarter} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <XAxis
                dataKey="quarter"
                tick={{ fontSize: 9 }}
                tickFormatter={(q) => `Q${q}`}
                interval={3}
              />
              <YAxis
                tick={{ fontSize: 9 }}
                tickFormatter={(v) => `${v.toFixed(0)}%`}
                width={35}
                domain={[0, "auto"]}
              />
              <Tooltip
                formatter={(value, name) => [`${Number(value).toFixed(1)}%`, String(name)]}
                labelFormatter={(q) => `Quarter ${q}`}
              />
              {ocClasses.map((cls) => (
                <Area
                  key={cls}
                  type="monotone"
                  dataKey={`byClass.${cls}`}
                  name={`Class ${cls}`}
                  stroke={OC_CLASS_COLORS[cls] ?? "#888"}
                  fill={OC_CLASS_COLORS[cls] ?? "#888"}
                  fillOpacity={0.15}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export default function MonteCarloChart({ result, running, progress }: Props) {
  const histogramData = useMemo(
    () => (result ? buildHistogramData(result.irrs) : []),
    [result]
  );

  const labelStyle: React.CSSProperties = {
    fontSize: "0.68rem",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--color-text-muted)",
    marginBottom: "0.5rem",
    marginTop: "0.5rem",
  };

  return (
    <div>
      {/* Progress bar */}
      {running && (
        <div style={{ marginBottom: "0.75rem" }}>
          <div style={{
            height: 3,
            background: "var(--color-border)",
            borderRadius: 2,
            overflow: "hidden",
          }}>
            <div style={{
              height: "100%",
              width: `${progress * 100}%`,
              background: "var(--color-accent)",
              transition: "width 0.2s",
            }} />
          </div>
          <div style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", marginTop: "0.2rem" }}>
            Running {Math.round(progress * 10000).toLocaleString()} / 10,000 simulations...
          </div>
        </div>
      )}

      {!result && !running && (
        <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", padding: "1rem 0" }}>
          Monte Carlo simulation will run automatically when assumptions are set.
        </div>
      )}

      {result && result.wipedOut && (
        <div style={{
          padding: "0.75rem 1rem",
          border: "1px solid var(--color-low)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-low-bg)",
          fontSize: "0.8rem",
          color: "var(--color-low)",
          lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Monte Carlo not meaningful for insolvent deal.</div>
          The deal is balance-sheet insolvent at t=0 (total debt exceeds total assets). Every scenario yields no positive equity IRR; percentiles would all be undefined. Run an entry-price override to model recovery scenarios from a non-zero cost basis.
        </div>
      )}

      {result && !result.wipedOut && (
        <>
          {/* Percentile summary */}
          <div style={{
            display: "flex",
            gap: "1.5rem",
            marginBottom: "0.75rem",
            fontSize: "0.8rem",
          }}>
            <span>P5: <strong>{formatPct(result.percentiles.p5)}</strong></span>
            <span>P25: <strong>{formatPct(result.percentiles.p25)}</strong></span>
            <span>Median: <strong style={{ color: "var(--color-accent)" }}>{formatPct(result.percentiles.p50)}</strong></span>
            <span>P75: <strong>{formatPct(result.percentiles.p75)}</strong></span>
            <span>P95: <strong>{formatPct(result.percentiles.p95)}</strong></span>
            <span style={{ marginLeft: "auto", color: "var(--color-text-muted)" }}>
              {result.runCount.toLocaleString()} runs
            </span>
          </div>

          {/* IRR Histogram */}
          <div style={labelStyle}>IRR Distribution</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={histogramData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 9 }}
                interval={4}
              />
              <YAxis
                tick={{ fontSize: 9 }}
                tickFormatter={(v) => `${v.toFixed(0)}%`}
                width={35}
              />
              <Tooltip
                formatter={(value) => [`${Number(value).toFixed(1)}%`, "Frequency"]}
                labelFormatter={(label) => `IRR ${label}`}
              />
              <Bar
                dataKey="pct"
                fill="var(--color-accent)"
                radius={[1, 1, 0, 0]}
                isAnimationActive={false}
              />
              <ReferenceLine
                x={findNearestBucket(histogramData, result.percentiles.p5)}
                stroke="#c00"
                strokeDasharray="3 3"
                label={{ value: "P5", position: "top", fontSize: 9, fill: "#c00" }}
              />
              <ReferenceLine
                x={findNearestBucket(histogramData, result.percentiles.p50)}
                stroke="var(--color-accent)"
                strokeDasharray="3 3"
                label={{ value: "P50", position: "top", fontSize: 9 }}
              />
              <ReferenceLine
                x={findNearestBucket(histogramData, result.percentiles.p95)}
                stroke="#0a0"
                strokeDasharray="3 3"
                label={{ value: "P95", position: "top", fontSize: 9, fill: "#0a0" }}
              />
            </BarChart>
          </ResponsiveContainer>

          {/* OC Failure — collapsible with per-class breakdown */}
          {result.ocFailureByQuarter.some(q => q.failurePct > 0) && (
            <OcFailureSection result={result} />
          )}
        </>
      )}
    </div>
  );
}
