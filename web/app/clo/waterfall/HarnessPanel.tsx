"use client";

/**
 * N1 Waterfall Replay Harness Panel.
 *
 * Live diagnostic view of engine-vs-trustee drift for the most recent realized
 * period. Two modes (when `engineMathInputs` is supplied):
 *
 *   - Production path (default): uses `inputs` verbatim — i.e. what the user
 *     sees given current slider state and today's pre-fill pipeline. Exposes
 *     the full pre-fill-gap drift picture (matches n1-production-path.test.ts).
 *   - Engine math: uses `engineMathInputs` — legit-pinned inputs (observed
 *     EURIBOR + PPM fees from resolved.fees; trusteeFeeBps intentionally NOT
 *     pinned — circular). Exposes engine arithmetic drift only (matches
 *     n1-correctness.test.ts).
 *
 * When `engineMathInputs` is not provided, the panel runs in production mode
 * only and hides the toggle.
 *
 * Tolerance bands: green (within), amber (1×–5×), red (>5× or Infinity with
 * non-zero drift — engine-does-not-model steps surface for audit visibility
 * but don't fail the status count).
 *
 * See /Users/solal/.claude/plans/clo-modeling-correctness-plan.md §N1.
 */

import { useMemo, useState } from "react";
import type { ProjectionInputs } from "@/lib/clo/projection";
import type { BacktestInputs } from "@/lib/clo/backtest-types";
import { runBacktestHarness } from "@/lib/clo/backtest-harness";

interface Props {
  inputs: ProjectionInputs;
  backtest: BacktestInputs;
  /** Legit-pinned inputs for engine-math mode. If omitted, toggle is hidden. */
  engineMathInputs?: ProjectionInputs;
}

type Mode = "production" | "engine-math";

const cellStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  fontFamily: "var(--font-mono)",
  fontSize: "0.72rem",
  textAlign: "right",
  borderBottom: "1px solid var(--color-border-light)",
  fontVariantNumeric: "tabular-nums",
};

const headerCellStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  fontSize: "0.68rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--color-text-muted)",
  textAlign: "left",
  fontWeight: 600,
  position: "sticky",
  top: 0,
  background: "var(--color-surface)",
  borderBottom: "1px solid var(--color-border)",
  zIndex: 1,
};

export default function HarnessPanel({ inputs, backtest, engineMathInputs }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("production");

  const activeInputs = mode === "engine-math" && engineMathInputs ? engineMathInputs : inputs;

  const result = useMemo(() => {
    try {
      return runBacktestHarness(activeInputs, backtest);
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      } as { error: string };
    }
  }, [activeInputs, backtest]);

  if ("error" in result) {
    return (
      <section style={{ marginTop: "2rem", padding: "1rem", border: "1px solid var(--color-low-border)", borderRadius: "var(--radius-sm)", background: "var(--color-low-bg)", color: "var(--color-low)", fontSize: "0.85rem" }}>
        Harness error: {result.error}
      </section>
    );
  }

  const statusColor = result.allWithinTolerance ? "var(--color-high)" : "var(--color-low)";
  const statusBg = result.allWithinTolerance ? "var(--color-high-bg)" : "var(--color-low-bg)";
  const statusBorder = result.allWithinTolerance ? "var(--color-high-border)" : "var(--color-low-border)";

  return (
    <section style={{ marginTop: "2rem", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.75rem 1rem",
          background: statusBg,
          border: "none",
          borderBottom: open ? `1px solid ${statusBorder}` : "none",
          color: "var(--color-text)",
          fontSize: "0.9rem",
          fontWeight: 600,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "0.65rem" }}>{open ? "▾" : "▸"}</span>
          N1 Waterfall Replay — Engine vs Trustee (Q1 {result.periodDate ?? ""})
        </span>
        <span style={{ color: statusColor, fontSize: "0.82rem", fontFamily: "var(--font-mono)" }}>
          {result.summary.stepsWithinTolerance}/{result.summary.stepsCount} within tolerance
          {!result.allWithinTolerance && (
            <>
              {" "}· max δ €{result.maxAbsDelta.toFixed(0)} ({result.maxAbsDeltaBucket})
            </>
          )}
        </span>
      </button>
      {open && (
        <div style={{ background: "var(--color-surface)", padding: "0.5rem 0" }}>
          <div style={{ display: "flex", gap: "0.25rem", padding: "0.5rem 1rem 0.25rem" }}>
            <ModeButton active={mode === "production"} onClick={() => setMode("production")}>
              Production path
            </ModeButton>
            <ModeButton
              active={mode === "engine-math"}
              disabled={!engineMathInputs}
              title={
                engineMathInputs
                  ? undefined
                  : "Engine-math mode requires observed reference rate from trancheSnapshots (not available on fixed-only pools or deals with an incomplete snapshot feed)."
              }
              onClick={() => engineMathInputs && setMode("engine-math")}
            >
              Engine math (legit-pinned){engineMathInputs ? "" : " — unavailable"}
            </ModeButton>
          </div>
          <p style={{ padding: "0.5rem 1rem", fontSize: "0.78rem", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
            {mode === "engine-math" ? (
              <>
                Engine arithmetic against trustee with externally-authoritative pins (observed
                EURIBOR + PPM fees). <em>trusteeFeeBps is intentionally NOT pinned</em> — deriving
                it from trustee output would be circular. Remaining drift = engine correctness
                gaps (KI-08 trustee fee pre-fill + B3 day-count). Tolerances set at post-Sprint-1
                target levels.
              </>
            ) : (
              <>
                Live replay using current slider state — what a user actually sees.
                Exposes the full pre-fill-gap picture in addition to engine arithmetic drift.
                Tweak any assumption slider above and the table re-computes.
              </>
            )}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem" }}>
              <thead>
                <tr>
                  <th style={{ ...headerCellStyle, textAlign: "left" }}>Bucket</th>
                  <th style={{ ...headerCellStyle, textAlign: "left" }}>PPM steps</th>
                  <th style={{ ...headerCellStyle, textAlign: "right" }}>Actual (€)</th>
                  <th style={{ ...headerCellStyle, textAlign: "right" }}>Projected (€)</th>
                  <th style={{ ...headerCellStyle, textAlign: "right" }}>Δ (€)</th>
                  <th style={{ ...headerCellStyle, textAlign: "right" }}>Tolerance (€)</th>
                  <th style={{ ...headerCellStyle, textAlign: "center" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {result.steps.map((s) => {
                  const ratio = s.tolerance === Infinity ? 0 : s.absDelta / Math.max(s.tolerance, 1e-9);
                  const isInfinite = !isFinite(s.tolerance);
                  const rowBg =
                    s.withinTolerance && !isInfinite ? undefined
                    : isInfinite && s.absDelta > 0 ? "var(--color-medium-bg)"
                    : ratio > 5 ? "var(--color-low-bg)"
                    : "var(--color-medium-bg)";
                  const statusCellColor =
                    s.withinTolerance && !isInfinite ? "var(--color-high)"
                    : isInfinite && s.absDelta > 0 ? "var(--color-medium)"
                    : ratio > 5 ? "var(--color-low)"
                    : "var(--color-medium)";
                  const statusSymbol =
                    s.withinTolerance && !isInfinite ? "✓"
                    : isInfinite ? "∞"
                    : "✗";
                  return (
                    <tr key={s.engineBucket} style={{ background: rowBg }}>
                      <td style={{ ...cellStyle, textAlign: "left", fontFamily: "var(--font-sans)" }}>{s.engineBucket}</td>
                      <td style={{ ...cellStyle, textAlign: "left", color: "var(--color-text-muted)" }}>{s.ppmSteps.join(", ")}</td>
                      <td style={cellStyle}>{s.actual.toLocaleString("en-EU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={cellStyle}>{s.projected.toLocaleString("en-EU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={{ ...cellStyle, color: s.absDelta > 0 ? statusCellColor : undefined, fontWeight: s.absDelta > 0 ? 600 : undefined }}>
                        {s.delta >= 0 ? "+" : ""}{s.delta.toLocaleString("en-EU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td style={{ ...cellStyle, color: "var(--color-text-muted)" }}>
                        {isFinite(s.tolerance) ? s.tolerance.toLocaleString("en-EU", { maximumFractionDigits: 2 }) : "∞"}
                      </td>
                      <td style={{ ...cellStyle, textAlign: "center", color: statusCellColor, fontWeight: 600 }}>{statusSymbol}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function ModeButton({ active, onClick, children, disabled, title }: { active: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: "0.3rem 0.75rem",
        fontSize: "0.75rem",
        fontWeight: active ? 600 : 500,
        border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
        background: active ? "var(--color-accent-bg)" : "var(--color-surface)",
        color: disabled ? "var(--color-text-faint)" : active ? "var(--color-accent)" : "var(--color-text-muted)",
        borderRadius: "var(--radius-sm)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}
