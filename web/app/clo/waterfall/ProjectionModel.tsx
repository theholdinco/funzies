"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type {
  CloTranche,
  CloTrancheSnapshot,
  CloPoolSummary,
  CloComplianceTest,
  ExtractedConstraints,
} from "@/lib/clo/types";
import {
  runProjection,
  validateInputs,
  type ProjectionInputs,
  type ProjectionResult,
} from "@/lib/clo/projection";
import SuggestAssumptions from "./SuggestAssumptions";

interface Props {
  maturityDate: string | null;
  reinvestmentPeriodEnd: string | null;
  tranches: CloTranche[];
  trancheSnapshots: CloTrancheSnapshot[];
  poolSummary: CloPoolSummary | null;
  complianceTests: CloComplianceTest[];
  constraints: ExtractedConstraints;
  panelId: string | null;
  dealContext: Record<string, unknown>;
}

function formatPct(val: number): string {
  return `${val.toFixed(2)}%`;
}

function formatAmount(val: number): string {
  if (Math.abs(val) >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (Math.abs(val) >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

const TRANCHE_COLORS = [
  "#2d6a4f", "#5a7c2f", "#92641a", "#b54a32", "#7c3aed", "#2563eb",
];

const MODEL_ASSUMPTIONS = [
  {
    label: "Quarterly periodicity",
    detail: "Cash flows are modeled in quarterly periods. Interest accrues on beginning-of-period par rather than daily accrual.",
  },
  {
    label: "Full diversion on OC/IC failure",
    detail: "When an OC or IC test fails, all remaining interest is diverted to principal paydown. Real indentures may allow partial cure.",
  },
  {
    label: "No deferred interest",
    detail: "Interest shortfalls on junior tranches do not accrue or compound into future periods.",
  },
  {
    label: "Floating-rate collateral",
    detail: "All portfolio assets are assumed to be floating-rate (base rate + WAC spread). Fixed-rate collateral is not modeled separately.",
  },
  {
    label: "No scheduled amortization",
    detail: "Principal reductions come only from prepayments, defaults/recoveries, and maturity liquidation. Scheduled loan amortization is not modeled.",
  },
  {
    label: "Constant assumption rates",
    detail: "CDR, CPR, recovery rate, and base rate are held constant across all periods. Real performance will vary over time.",
  },
];

function parseAmount(s: string | undefined | null): number {
  if (!s) return 0;
  const cleaned = s.replace(/[^0-9.]/g, "");
  return parseFloat(cleaned) || 0;
}

function buildTranchesFromConstraints(constraints: ExtractedConstraints) {
  const entries = constraints.capitalStructure ?? [];
  if (entries.length === 0) return [];

  // Deduplicate by class name — keep the entry with the most data (has principalAmount and spread)
  const byClass = new Map<string, typeof entries[number]>();
  for (const e of entries) {
    const existing = byClass.get(e.class);
    if (!existing || (parseAmount(e.principalAmount) > 0 && (!existing.principalAmount || parseAmount(existing.principalAmount) === 0))) {
      byClass.set(e.class, e);
    }
  }

  return Array.from(byClass.values()).map((e, idx) => {
    const isSubordinated = e.isSubordinated ?? e.class.toLowerCase().includes("sub");
    const isFloating = e.rateType?.toLowerCase().includes("float") ??
      (e.spread?.toLowerCase().includes("euribor") || e.spread?.toLowerCase().includes("sofr") || false);
    return {
      className: e.class,
      currentBalance: parseAmount(e.principalAmount),
      spreadBps: e.spreadBps ?? 0,
      seniorityRank: idx + 1,
      isFloating,
      isIncomeNote: isSubordinated,
    };
  });
}

export default function ProjectionModel({
  maturityDate,
  reinvestmentPeriodEnd,
  tranches,
  trancheSnapshots,
  poolSummary,
  complianceTests,
  constraints,
  panelId,
  dealContext,
}: Props) {
  const isOcTest = (t: { testType?: string | null; testName?: string | null }) => {
    if (t.testType === "OC_PAR" || t.testType === "OC_MV") return true;
    const name = (t.testName ?? "").toLowerCase();
    return name.includes("overcollateral") || name.includes("par value") || (name.includes("oc") && name.includes("ratio"));
  };
  const isIcTest = (t: { testType?: string | null; testName?: string | null }) => {
    if (t.testType === "IC") return true;
    const name = (t.testName ?? "").toLowerCase();
    return name.includes("interest coverage") || (name.includes("ic") && name.includes("ratio"));
  };

  const ocTriggersFromTests = complianceTests
    .filter((t) => isOcTest(t) && t.triggerLevel !== null && t.testClass)
    .map((t) => ({ className: t.testClass!, triggerLevel: t.triggerLevel! }));

  const icTriggersFromTests = complianceTests
    .filter((t) => isIcTest(t) && t.triggerLevel !== null && t.testClass)
    .map((t) => ({ className: t.testClass!, triggerLevel: t.triggerLevel! }));

  // Fall back to extractedConstraints coverage tests if no compliance test records
  const ocTriggers = ocTriggersFromTests.length > 0
    ? ocTriggersFromTests
    : (constraints.coverageTestEntries ?? [])
        .filter((e) => e.parValueRatio && parseFloat(e.parValueRatio))
        .map((e) => ({ className: e.class, triggerLevel: parseFloat(e.parValueRatio!) }));

  const icTriggers = icTriggersFromTests.length > 0
    ? icTriggersFromTests
    : (constraints.coverageTestEntries ?? [])
        .filter((e) => e.interestCoverageRatio && parseFloat(e.interestCoverageRatio))
        .map((e) => ({ className: e.class, triggerLevel: parseFloat(e.interestCoverageRatio!) }));

  const snapshotByTrancheId = new Map(trancheSnapshots.map((s) => [s.trancheId, s]));
  const trancheInputs = tranches.length > 0
    ? tranches
        .sort((a, b) => (a.seniorityRank ?? 99) - (b.seniorityRank ?? 99))
        .map((t) => {
          const snap = snapshotByTrancheId.get(t.id);
          return {
            className: t.className,
            currentBalance: snap?.currentBalance ?? t.originalBalance ?? 0,
            spreadBps: t.spreadBps ?? 0,
            seniorityRank: t.seniorityRank ?? 99,
            isFloating: t.isFloating ?? true,
            isIncomeNote: t.isIncomeNote ?? t.isSubordinate ?? false,
          };
        })
    : buildTranchesFromConstraints(constraints);

  const [cdrPct, setCdrPct] = useState(2);
  const [cprPct, setCprPct] = useState(15);
  const [recoveryPct, setRecoveryPct] = useState(60);
  const [recoveryLagMonths, setRecoveryLagMonths] = useState(12);
  const [reinvestmentSpreadBps, setReinvestmentSpreadBps] = useState(350);
  const [baseRatePct, setBaseRatePct] = useState(4.5);
  const [seniorFeePct, setSeniorFeePct] = useState(0.45);
  const [showCashFlows, setShowCashFlows] = useState(false);

  const inputs: ProjectionInputs = useMemo(
    () => ({
      initialPar: poolSummary?.totalPar ?? 0,
      wacSpreadBps: (() => {
        const was = poolSummary?.wacSpread ?? 0;
        // Extraction may return spread as percentage (e.g. 3.85) or bps (e.g. 385)
        return was < 20 ? was * 100 : was;
      })(),
      baseRatePct,
      seniorFeePct,
      tranches: trancheInputs,
      ocTriggers,
      icTriggers,
      reinvestmentPeriodEnd,
      maturityDate,
      currentDate: new Date().toISOString().slice(0, 10),
      cdrPct,
      cprPct,
      recoveryPct,
      recoveryLagMonths,
      reinvestmentSpreadBps,
    }),
    [
      poolSummary, baseRatePct, seniorFeePct, trancheInputs, ocTriggers, icTriggers,
      maturityDate, reinvestmentPeriodEnd, cdrPct, cprPct, recoveryPct, recoveryLagMonths, reinvestmentSpreadBps,
    ]
  );

  const validationErrors = useMemo(() => validateInputs(inputs), [inputs]);
  const result: ProjectionResult | null = useMemo(
    () => (validationErrors.length === 0 ? runProjection(inputs) : null),
    [inputs, validationErrors]
  );

  const handleApplyAssumptions = (assumptions: {
    cdrPct: number;
    cprPct: number;
    recoveryPct: number;
    recoveryLagMonths: number;
    reinvestmentSpreadBps: number;
  }) => {
    setCdrPct(assumptions.cdrPct);
    setCprPct(assumptions.cprPct);
    setRecoveryPct(assumptions.recoveryPct);
    setRecoveryLagMonths(assumptions.recoveryLagMonths);
    setReinvestmentSpreadBps(assumptions.reinvestmentSpreadBps);
  };

  return (
    <div className="wf-section" style={{ marginTop: "2.5rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "0.75rem",
          marginBottom: "1.25rem",
          borderBottom: "1px solid var(--color-border-light)",
          paddingBottom: "0.75rem",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "1.2rem",
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          Projection Model
        </h2>
      </div>

      {/* Validation gate */}
      {validationErrors.length > 0 && (
        <div
          style={{
            padding: "1.25rem",
            border: "1px solid var(--color-low-border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-low-bg)",
            marginBottom: "1.5rem",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--color-low)", marginBottom: "0.5rem", fontSize: "0.9rem" }}>
            Missing data — projection cannot run
          </div>
          {validationErrors.map((e, i) => (
            <div key={i} style={{ fontSize: "0.82rem", color: "var(--color-low)", marginBottom: "0.2rem" }}>
              &bull; {e.message}
            </div>
          ))}
          <Link
            href="/clo/context"
            style={{
              display: "inline-block",
              marginTop: "0.75rem",
              fontSize: "0.82rem",
              color: "var(--color-low)",
              textDecoration: "underline",
            }}
          >
            Fix in Context Editor &rarr;
          </Link>
        </div>
      )}

      {/* Input section */}
      <div
        style={{
          padding: "1.25rem",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border-light)",
          borderRadius: "var(--radius-sm)",
          marginBottom: "1.5rem",
        }}
      >
        <div style={{ fontSize: "0.72rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "1rem" }}>
          Assumptions
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "1.25rem",
          }}
        >
          <SliderInput label="CDR (Annual Default Rate)" value={cdrPct} onChange={setCdrPct} min={0} max={10} step={0.25} suffix="%" />
          <SliderInput label="CPR (Annual Prepay Rate)" value={cprPct} onChange={setCprPct} min={0} max={30} step={0.5} suffix="%" />
          <SliderInput label="Recovery Rate" value={recoveryPct} onChange={setRecoveryPct} min={0} max={80} step={1} suffix="%" />
          <SliderInput label="Recovery Lag" value={recoveryLagMonths} onChange={setRecoveryLagMonths} min={0} max={24} step={1} suffix=" mo" />
          <SliderInput label="Reinvestment Spread" value={reinvestmentSpreadBps} onChange={setReinvestmentSpreadBps} min={0} max={500} step={10} suffix=" bps" />
          <SliderInput label="Base Rate (SOFR)" value={baseRatePct} onChange={setBaseRatePct} min={0} max={8} step={0.25} suffix="%" />
          <SliderInput label="Senior Fee Rate" value={seniorFeePct} onChange={setSeniorFeePct} min={0} max={1} step={0.05} suffix="%" />
        </div>
      </div>

      {/* AI Suggest */}
      {panelId && (
        <SuggestAssumptions
          panelId={panelId}
          dealContext={dealContext}
          onApply={handleApplyAssumptions}
        />
      )}

      {/* Results */}
      {result && (
        <div style={{ marginTop: "1.5rem" }}>
          {/* Summary cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "1rem",
              marginBottom: "2rem",
            }}
          >
            {/* Hero card: Equity IRR */}
            <div
              style={{
                padding: "1.25rem",
                background: "linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%)",
                borderRadius: "var(--radius-sm)",
                textAlign: "center",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  width: "60px",
                  height: "60px",
                  background: "rgba(255,255,255,0.06)",
                  borderRadius: "0 0 0 60px",
                }}
              />
              <div style={{ fontSize: "0.7rem", fontWeight: 500, color: "rgba(255,255,255,0.7)", marginBottom: "0.35rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Equity IRR
              </div>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1.8rem",
                  fontWeight: 700,
                  color: "#fff",
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "-0.02em",
                }}
              >
                {result.equityIrr !== null ? formatPct(result.equityIrr * 100) : "N/A"}
              </div>
            </div>

            <SummaryCard
              label="Total Equity Distributions"
              value={formatAmount(result.totalEquityDistributions)}
            />
            <SummaryCard
              label="Projection Periods"
              value={`${result.periods.length} quarters`}
            />
          </div>

          {/* Model simplifications disclosure */}
          <ModelAssumptions />

          {/* Tranche payoff timeline */}
          <div style={{ marginBottom: "2rem" }}>
            <h3
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "0.95rem",
                fontWeight: 600,
                marginBottom: "0.75rem",
              }}
            >
              Tranche Payoff Timeline
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {trancheInputs
                .filter((t) => !t.isIncomeNote)
                .map((t, idx) => {
                  const payoffQ = result.tranchePayoffQuarter[t.className];
                  const maxQ = result.periods.length;
                  const barPct = payoffQ !== null ? (payoffQ / maxQ) * 100 : 100;
                  const color = TRANCHE_COLORS[idx % TRANCHE_COLORS.length];
                  return (
                    <div key={t.className} style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                      <div
                        style={{
                          width: "4.5rem",
                          fontSize: "0.78rem",
                          fontWeight: 600,
                          fontFamily: "var(--font-mono)",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {t.className}
                      </div>
                      <div
                        style={{
                          flex: 1,
                          height: "1.5rem",
                          background: "var(--color-surface)",
                          borderRadius: "var(--radius-sm)",
                          overflow: "hidden",
                          border: "1px solid var(--color-border-light)",
                        }}
                      >
                        <div
                          style={{
                            width: `${barPct}%`,
                            height: "100%",
                            background: payoffQ !== null
                              ? `linear-gradient(90deg, ${color}, ${color}dd)`
                              : "var(--color-border)",
                            borderRadius: "var(--radius-sm)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "flex-end",
                            paddingRight: "0.4rem",
                            transition: "width 0.4s ease",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "0.65rem",
                              color: "#fff",
                              fontWeight: 600,
                              fontFamily: "var(--font-mono)",
                              textShadow: "0 1px 2px rgba(0,0,0,0.2)",
                            }}
                          >
                            {payoffQ !== null ? `Q${payoffQ}` : "—"}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Portfolio balance chart */}
          <div style={{ marginBottom: "2rem" }}>
            <h3
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "0.95rem",
                fontWeight: 600,
                marginBottom: "0.75rem",
              }}
            >
              Portfolio Par Balance
            </h3>
            <div
              style={{
                position: "relative",
                height: "140px",
                background: "var(--color-surface)",
                border: "1px solid var(--color-border-light)",
                borderRadius: "var(--radius-sm)",
                padding: "0.75rem 0.5rem 0.25rem",
                overflow: "hidden",
              }}
            >
              {/* Subtle grid lines */}
              {[0.25, 0.5, 0.75].map((pct) => (
                <div
                  key={pct}
                  style={{
                    position: "absolute",
                    left: "0.5rem",
                    right: "0.5rem",
                    top: `${(1 - pct) * 80 + 8}%`,
                    height: "1px",
                    background: "var(--color-border-light)",
                    opacity: 0.5,
                  }}
                />
              ))}
              <div style={{ display: "flex", alignItems: "flex-end", height: "100%", gap: "1px", position: "relative", zIndex: 1 }}>
                {result.periods.map((p) => {
                  const maxPar = result.periods[0]?.beginningPar || 1;
                  const heightPct = (p.endingPar / maxPar) * 100;
                  return (
                    <div
                      key={p.periodNum}
                      title={`Q${p.periodNum}: ${formatAmount(p.endingPar)}`}
                      style={{
                        flex: 1,
                        height: `${heightPct}%`,
                        background: "linear-gradient(to top, var(--color-accent), var(--color-accent-hover))",
                        borderRadius: "2px 2px 0 0",
                        minWidth: "3px",
                        opacity: 0.75,
                        transition: "opacity 0.15s ease",
                      }}
                      onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = "1"; }}
                      onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = "0.75"; }}
                    />
                  );
                })}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.65rem", color: "var(--color-text-muted)", marginTop: "0.35rem", fontFamily: "var(--font-mono)" }}>
              <span>Q1</span>
              <span>Q{result.periods.length}</span>
            </div>
          </div>

          {/* Cash flow table */}
          <div>
            <button
              onClick={() => setShowCashFlows(!showCashFlows)}
              style={{
                background: showCashFlows ? "var(--color-surface-alt)" : "var(--color-surface)",
                border: "1px solid var(--color-border-light)",
                borderRadius: "var(--radius-sm)",
                padding: "0.5rem 1rem",
                cursor: "pointer",
                fontSize: "0.8rem",
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-body)",
                transition: "background 0.15s ease",
              }}
            >
              {showCashFlows ? "▾ Hide" : "▸ Show"} Cash Flow Detail
            </button>

            {showCashFlows && (
              <div
                style={{
                  overflowX: "auto",
                  marginTop: "0.75rem",
                  border: "1px solid var(--color-border-light)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <table
                  className="wf-table"
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "0.75rem",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--color-border)", textAlign: "right", background: "var(--color-surface)" }}>
                      <th style={{ padding: "0.5rem 0.6rem", textAlign: "left", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Qtr</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Beg Par</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Defaults</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Prepays</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Recoveries</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Reinvest</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>End Par</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Interest</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Equity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.periods.map((p) => (
                      <tr key={p.periodNum} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                        <td style={{ padding: "0.45rem 0.6rem", fontWeight: 500, fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>Q{p.periodNum}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.beginningPar)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: p.defaults > 0 ? "var(--color-low)" : undefined }}>
                          {formatAmount(p.defaults)}
                        </td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.prepayments)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.recoveries)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.reinvestment)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.endingPar)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.interestCollected)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: p.equityDistribution > 0 ? "var(--color-high)" : undefined, fontWeight: p.equityDistribution > 0 ? 600 : undefined }}>
                          {formatAmount(p.equityDistribution)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SliderInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  suffix: string;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.4rem" }}>
        <label style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", fontWeight: 500 }}>{label}</label>
        <span
          style={{
            fontSize: "0.82rem",
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
            color: "var(--color-text)",
          }}
        >
          {value}{suffix}
        </span>
      </div>
      <input
        type="range"
        className="wf-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

function ModelAssumptions() {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        marginBottom: "1.5rem",
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
          alignItems: "center",
          gap: "0.4rem",
          padding: "0.6rem 0.8rem",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "0.75rem",
          color: "var(--color-text-muted)",
          textAlign: "left",
          fontFamily: "var(--font-body)",
        }}
      >
        <span style={{ fontSize: "0.65rem" }}>{open ? "▾" : "▸"}</span>
        Model Simplifications &amp; Assumptions
      </button>
      {open && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          {MODEL_ASSUMPTIONS.map((a) => (
            <div
              key={a.label}
              style={{
                display: "flex",
                gap: "0.5rem",
                padding: "0.4rem 0",
                borderTop: "1px solid var(--color-border-light)",
                fontSize: "0.75rem",
                lineHeight: 1.4,
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: "0.35rem",
                  height: "0.35rem",
                  marginTop: "0.35rem",
                  borderRadius: "50%",
                  background: "var(--color-text-muted)",
                }}
              />
              <div>
                <span style={{ fontWeight: 600 }}>{a.label}:</span>{" "}
                <span style={{ color: "var(--color-text-muted)" }}>{a.detail}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        padding: "1.25rem",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border-light)",
        borderRadius: "var(--radius-sm)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "0.7rem", fontWeight: 500, color: "var(--color-text-muted)", marginBottom: "0.35rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1.15rem",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: "var(--color-text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
