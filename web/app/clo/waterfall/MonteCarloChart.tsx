"use client";

import { useMemo } from "react";
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

function formatPct(v: number | null | undefined): string {
  if (v == null) return "\u2014";
  return `${(v * 100).toFixed(1)}%`;
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

      {result && (
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
                x={histogramData.find(d => d.mid >= (result.percentiles.p5 ?? 0) && d.mid < (result.percentiles.p5 ?? 0) + 0.02)?.bucket}
                stroke="#c00"
                strokeDasharray="3 3"
                label={{ value: "P5", position: "top", fontSize: 9, fill: "#c00" }}
              />
              <ReferenceLine
                x={histogramData.find(d => d.mid >= (result.percentiles.p50 ?? 0) && d.mid < (result.percentiles.p50 ?? 0) + 0.02)?.bucket}
                stroke="var(--color-accent)"
                strokeDasharray="3 3"
                label={{ value: "P50", position: "top", fontSize: 9 }}
              />
              <ReferenceLine
                x={histogramData.find(d => d.mid >= (result.percentiles.p95 ?? 0) && d.mid < (result.percentiles.p95 ?? 0) + 0.02)?.bucket}
                stroke="#0a0"
                strokeDasharray="3 3"
                label={{ value: "P95", position: "top", fontSize: 9, fill: "#0a0" }}
              />
            </BarChart>
          </ResponsiveContainer>

          {/* OC Failure Timeline */}
          {result.ocFailureByQuarter.some(q => q.failurePct > 0) && (
            <>
              <div style={labelStyle}>OC Test Failure Probability by Quarter</div>
              <ResponsiveContainer width="100%" height={120}>
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
                    formatter={(value) => [`${Number(value).toFixed(1)}%`, "Failure probability"]}
                    labelFormatter={(q) => `Quarter ${q}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="failurePct"
                    stroke="#c60"
                    fill="#c60"
                    fillOpacity={0.3}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </>
          )}
        </>
      )}
    </div>
  );
}
