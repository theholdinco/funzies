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

import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectionInputs } from "@/lib/clo/projection";
import type { BacktestInputs } from "@/lib/clo/backtest-types";
import { runBacktestHarness, type HarnessResult } from "@/lib/clo/backtest-harness";
import type { EngineBucket } from "@/lib/clo/ppm-step-map";

/** E2 (Sprint 5) — Static map from harness engine bucket to the KI ledger
 *  entries that document its expected drift. Rendered as small badges on
 *  non-green rows so partners can click through from a drift to the ledger
 *  explanation. Only buckets with real documented drift or deferred
 *  modeling are included; a bucket showing red without a KI badge = genuine
 *  unexpected drift, partner should flag. Ledger anchors at
 *  `docs/clo-model-known-issues.md#ki-<id>` (kebab-case). */
const BUCKET_TO_KI: Partial<Record<EngineBucket, { ids: string[]; blurb: string }>> = {
  taxes: { ids: ["KI-09"], blurb: "Issuer taxes (A.i). CLOSED Sprint 3. Residual is 91/360 vs 90/360 harness-period-mismatch — closes fully with KI-12a." },
  issuerProfit: { ids: ["KI-01"], blurb: "Issuer Profit Amount (A.ii). CLOSED Sprint 4. Fixed €250/period — engine ties to the cent." },
  trusteeFeesPaid: { ids: ["KI-08", "KI-16"], blurb: "Trustee fee (B) back-derived from Q1 waterfall (D3). Cap mechanics shipped in C3. 3 assumptions pending PPM verification (KI-16)." },
  adminFeesPaid: { ids: ["KI-08", "KI-16"], blurb: "Admin fee (C), split from trustee post-C3. Day-count residual closes with KI-12a." },
  subDistribution: { ids: ["KI-13", "KI-13a"], blurb: "Sub distribution residual — cascade from KI-01/08/09/12a/12b. Re-baselined on each upstream closure." },
  classA_interest: { ids: ["KI-12b", "KI-12a"], blurb: "Class A interest day-count drift. Engine Q2 (91/360) vs trustee Q1 (90/360) period mismatch — closes with KI-12a." },
  classB_interest: { ids: ["KI-12b", "KI-12a"], blurb: "Class B interest day-count drift. Same mechanic as Class A." },
  classC_current: { ids: ["KI-12b", "KI-12a"], blurb: "Class C current interest day-count drift." },
  classD_current: { ids: ["KI-12b", "KI-12a"], blurb: "Class D current interest day-count drift." },
  classE_current: { ids: ["KI-12b", "KI-12a"], blurb: "Class E current interest day-count drift." },
  classF_current: { ids: ["KI-12b", "KI-12a"], blurb: "Class F current interest day-count drift." },
  seniorMgmtFeePaid: { ids: ["KI-12a"], blurb: "Senior mgmt fee (E). Fee-base harness period mismatch — engine beginningPar vs trustee prior-DD ACB." },
  subMgmtFeePaid: { ids: ["KI-12a"], blurb: "Sub mgmt fee (X). Same fee-base mismatch as senior mgmt." },
  expenseReserve: { ids: ["KI-02"], blurb: "Expense Reserve top-up (D). Deferred — CM-discretionary; usually zero." },
  effectiveDateRating: { ids: ["KI-03"], blurb: "Effective Date Rating Event (V). Deferred — inactive post-ramp." },
  defaultedHedgeTermination: { ids: ["KI-06"], blurb: "Defaulted hedge termination (AA). Deferred — hedge-default-only." },
  supplementalReserve: { ids: ["KI-05"], blurb: "Supplemental Reserve (BB). Deferred — CM-discretionary." },
  incentiveFeePaid: { ids: ["KI-15"], blurb: "Incentive fee. Hardcoded inactive under acceleration (B2); normal-mode ties via resolveIncentiveFee solver." },
  reinvestmentBlockedCompliance: { ids: [], blurb: "C1 audit metric — amount of reinvestment the engine blocked due to WARF trigger enforcement. No PPM step / no trustee analogue." },
};

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

function fmt2(n: number): string {
  return n.toFixed(2);
}

function buildCsv(result: HarnessResult): string {
  const header = ["engineBucket", "ppmSteps", "description", "actual", "projected", "delta", "absDelta", "tolerance", "withinTolerance"];
  const escape = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const rows = result.steps.map((s) => [
    s.engineBucket,
    s.ppmSteps.join("+"),
    s.description,
    fmt2(s.actual),
    fmt2(s.projected),
    fmt2(s.delta),
    fmt2(s.absDelta),
    isFinite(s.tolerance) ? fmt2(s.tolerance) : "Infinity",
    s.withinTolerance ? "YES" : "NO",
  ].map(escape).join(","));
  return [header.join(","), ...rows].join("\n");
}

function downloadBlob(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function filenameBase(mode: Mode, periodDate: string | null): string {
  return `n1-delta-${mode}-${periodDate ?? "unknown-date"}`;
}

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
          N1 Harness — Engine Q2 projection vs Trustee {result.periodDate ?? ""} actual
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
          <div style={{ display: "flex", gap: "0.25rem", padding: "0.5rem 1rem 0.25rem", alignItems: "center", flexWrap: "wrap" }}>
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
            <span style={{ flex: 1 }} />
            <ModeButton
              active={false}
              onClick={() => downloadBlob(buildCsv(result), `${filenameBase(mode, result.periodDate)}.csv`, "text/csv;charset=utf-8")}
            >
              Download CSV
            </ModeButton>
            <ModeButton
              active={false}
              onClick={() => {
                const payload = {
                  ...result,
                  meta: {
                    mode,
                    exportedAt: new Date().toISOString(),
                    summary: {
                      stepsWithinTolerance: result.summary.stepsWithinTolerance,
                      stepsOutOfTolerance: result.summary.stepsOutOfTolerance,
                      stepsCount: result.summary.stepsCount,
                      sumAbsDelta: result.summary.sumAbsDelta,
                      maxAbsDelta: result.maxAbsDelta,
                      maxAbsDeltaBucket: result.maxAbsDeltaBucket,
                    },
                  },
                };
                downloadBlob(JSON.stringify(payload, null, 2), `${filenameBase(mode, result.periodDate)}.json`, "application/json");
              }}
            >
              Download JSON
            </ModeButton>
          </div>
          <p style={{ padding: "0.5rem 1rem", fontSize: "0.78rem", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
            {mode === "engine-math" ? (
              <>
                Engine projects forward one quarter (Q2) from the fixture's current-period
                snapshot and compares against trustee's most recent realized period (Q1).
                This is <em>not</em> a Q1 replay — the engine has no rewind; the current
                snapshot is its starting state. Pre-fills come from <code>defaultsFromResolved</code>
                (observed EURIBOR, PPM fee rates, Q1-waterfall-derived trustee fee). Remaining
                drift = period-mismatch effects on balance-sensitive fields (KI-12a/12b) and
                engine-does-not-model deductions (KI-01/09).
              </>
            ) : (
              <>
                Live view using current slider state. Same Q2-vs-Q1 framing as engine-math
                mode — tweak any assumption slider above to see how it moves the delta table.
              </>
            )}
            {" "}Rows with documented drift carry KI-xx badges linking to the ledger entry
            that explains the residual; a red row without a KI badge is unexpected drift.
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
                      <td style={{ ...cellStyle, textAlign: "left", fontFamily: "var(--font-sans)" }}>
                        {s.engineBucket}
                        <KiBadges bucket={s.engineBucket} />
                      </td>
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

/** E2 — KI badge(s) next to an engine bucket. Click opens a small in-app
 *  popover showing the ledger blurb; closes on outside-click or Escape.
 *  Kept fully in-app so partners don't get ripped off to GitHub (offline-
 *  safe, branch-safe). A full in-app ledger viewer is a future follow-up;
 *  for now the blurb + file-path pointer is the partner-facing explanation. */
function KiBadges({ bucket }: { bucket: EngineBucket }) {
  const meta = BUCKET_TO_KI[bucket];
  if (!meta || meta.ids.length === 0) return null;
  return (
    <span style={{ marginLeft: "0.5rem", display: "inline-flex", gap: "0.25rem" }}>
      {meta.ids.map((id) => (
        <KiBadge key={id} id={id} blurb={meta.blurb} />
      ))}
    </span>
  );
}

function KiBadge({ id, blurb }: { id: string; blurb: string }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <span ref={wrapperRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          fontSize: "0.62rem",
          fontFamily: "var(--font-mono)",
          padding: "0.1rem 0.35rem",
          borderRadius: "3px",
          border: `1px solid ${open ? "var(--color-accent)" : "var(--color-border-light)"}`,
          background: open ? "var(--color-accent-bg, rgba(59,130,246,0.08))" : "var(--color-surface)",
          color: open ? "var(--color-accent)" : "var(--color-text-muted)",
          letterSpacing: "0.02em",
          cursor: "pointer",
          fontWeight: open ? 600 : 500,
        }}
      >
        {id}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${id} ledger entry`}
          style={{
            position: "absolute",
            zIndex: 100,
            top: "calc(100% + 0.35rem)",
            left: 0,
            minWidth: "320px",
            maxWidth: "420px",
            padding: "0.75rem 0.85rem",
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            fontSize: "0.75rem",
            fontFamily: "var(--font-sans)",
            color: "var(--color-text)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
            whiteSpace: "normal",
            lineHeight: 1.5,
            textAlign: "left",
            textTransform: "none",
            letterSpacing: "normal",
            fontWeight: 400,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: "0.4rem",
              gap: "0.5rem",
            }}
          >
            <strong style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--color-text)" }}>{id}</strong>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              aria-label="Close"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "var(--color-text-muted)",
                fontSize: "1rem",
                lineHeight: 1,
                padding: "0 0.15rem",
              }}
            >
              ×
            </button>
          </div>
          <div style={{ color: "var(--color-text-muted)" }}>{blurb}</div>
          <div
            style={{
              marginTop: "0.55rem",
              paddingTop: "0.5rem",
              borderTop: "1px solid var(--color-border-light)",
              fontSize: "0.65rem",
              color: "var(--color-text-muted)",
              fontStyle: "italic",
            }}
          >
            Full entry: <code style={{ fontFamily: "var(--font-mono)" }}>docs/clo-model-known-issues.md#{id.toLowerCase()}</code>
          </div>
        </div>
      )}
    </span>
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
