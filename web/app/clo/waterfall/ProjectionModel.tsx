"use client";

import React, { useState, useMemo } from "react";
import Link from "next/link";
import type {
  CloTranche,
  CloTrancheSnapshot,
  CloPoolSummary,
  CloComplianceTest,
  CloHolding,
  ExtractedConstraints,
} from "@/lib/clo/types";
import {
  runProjection,
  validateInputs,
  computeSensitivity,
  type ProjectionInputs,
  type ProjectionResult,
  type PeriodResult,
  type SensitivityRow,
  type LoanInput,
} from "@/lib/clo/projection";
import type { ResolvedDealData, ResolutionWarning } from "@/lib/clo/resolver-types";
import { buildFromResolved } from "@/lib/clo/build-projection-inputs";
import { DEFAULT_RATES_BY_RATING, RATING_BUCKETS, type RatingBucket } from "@/lib/clo/rating-mapping";
import SuggestAssumptions from "./SuggestAssumptions";
import { CLO_DEFAULTS } from "@/lib/clo/defaults";
import { useMonteCarlo } from "@/lib/clo/useMonteCarlo";
import MonteCarloChart from "./MonteCarloChart";

interface Props {
  maturityDate: string | null;
  reinvestmentPeriodEnd: string | null;
  tranches: CloTranche[];
  trancheSnapshots: CloTrancheSnapshot[];
  poolSummary: CloPoolSummary | null;
  complianceTests: CloComplianceTest[];
  constraints: ExtractedConstraints;
  holdings: CloHolding[];
  panelId: string | null;
  dealContext: Record<string, unknown>;
  resolved?: ResolvedDealData;
  resolutionWarnings?: ResolutionWarning[];
}

function formatPct(val: number): string {
  return `${val.toFixed(2)}%`;
}

function formatAmount(val: number): string {
  if (Math.abs(val) >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (Math.abs(val) >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

function formatDate(isoDate: string): string {
  if (!isoDate || !isoDate.includes("-")) return "—";
  const [y, m] = isoDate.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1] ?? "?"} ${y.slice(2)}`;
}

const TRANCHE_COLORS = [
  "#2d6a4f", "#5a7c2f", "#92641a", "#b54a32", "#7c3aed", "#2563eb",
];

// Comprehensive assumptions register — organized by domain with impact severity.
// Impact: "high" = could change IRR by 200+ bps, "medium" = 50-200 bps, "low" = under 50 bps
type AssumptionImpact = "high" | "medium" | "low";

interface Assumption {
  label: string;
  detail: string;
  impact: AssumptionImpact;
}

const ASSUMPTIONS_REGISTER: { domain: string; items: Assumption[] }[] = [
  {
    domain: "Defaults & Recovery",
    items: [
      { label: "Deterministic single-path model", detail: "This is NOT a Monte Carlo simulation. It produces one deterministic cash flow path. Real outcomes have wide distributions around this estimate. A deal projected at 14% IRR might realize anywhere from 8% to 20% depending on actual default timing and severity.", impact: "high" },
      { label: "No default correlation", detail: "Each loan defaults independently based on its rating bucket. In reality, defaults are correlated — economic downturns cause clusters of defaults. This model understates tail risk.", impact: "high" },
      { label: "No rating migration", detail: "Loans stay at their initial rating for the entire projection. In reality, loans get upgraded and downgraded, which changes their default probability and affects CCC bucket limits and OC tests.", impact: "high" },
      { label: "Constant recovery rate", detail: "A single recovery rate applies to all defaults regardless of rating, sector, seniority, or economic conditions. Real recovery rates vary widely (20-80%) and are lower in downturns when defaults are highest.", impact: "medium" },
      { label: "Fixed recovery lag", detail: "Recovery cash arrives after a fixed delay. In practice, recovery timelines are highly variable (months to years) and affect the time value of money.", impact: "low" },
      { label: "No partial recoveries", detail: "Each default either recovers the fixed percentage after the lag, or nothing. Real workouts produce multiple partial payments over time.", impact: "low" },
    ],
  },
  {
    domain: "Interest Rates",
    items: [
      { label: "Flat rate assumption", detail: "The base rate (EURIBOR) is held constant for the entire projection. There is no forward curve, no rate volatility, and no term structure. Since CLO equity returns are highly sensitive to rate movements, this is a major simplification.", impact: "high" },
      { label: "EURIBOR floored at 0%", detail: "The model floors the base rate at 0% for both collateral interest and tranche coupons. Most European CLOs have this floor, but the exact floor level may vary by deal.", impact: "low" },
      { label: "No day count conventions", detail: "Interest accrues as simple quarterly fractions (annual rate / 4). Real deals use specific day count conventions (Actual/360, 30/360) that produce slightly different amounts.", impact: "low" },
      { label: "No EURIBOR fixing lag", detail: "The model uses the input rate immediately. Real deals reference EURIBOR fixings from 2 business days prior to the interest period start.", impact: "low" },
    ],
  },
  {
    domain: "Reinvestment & Trading",
    items: [
      { label: "No active trading", detail: "The model does not capture manager trading activity (sales, purchases, credit risk trades). Real CLO managers actively trade — the Ares XVIII compliance report shows €5.8M in sales with a -€558K loss in a single month. Trading gains/losses directly affect par and returns.", impact: "high" },
      { label: "Reinvestment at par", detail: "Reinvested assets are always purchased at par (100 cents on the dollar). In practice, managers buy at varying prices — discounts improve returns, premiums reduce them.", impact: "medium" },
      { label: "Uniform reinvestment quality", detail: "All reinvestment goes into a single synthetic loan with one rating and spread. Real reinvestment is diversified across many names, ratings, and spreads.", impact: "medium" },
      { label: "Constant prepayment rate", detail: "CPR is held constant. In reality, prepayments are cyclical — they increase when rates fall (borrowers refinance) and decrease when rates rise. This interacts with reinvestment spread.", impact: "medium" },
    ],
  },
  {
    domain: "Fees & Expenses",
    items: [
      { label: "Simplified incentive fee", detail: "The incentive fee uses a linear hurdle approximation, not a true IRR gate. The actual incentive fee calculation in most indentures is more complex, involving catch-up provisions and look-back periods.", impact: "medium" },
      { label: "No expense reserve modeling", detail: "The PPM allows discretionary top-up of the expense reserve account, which traps cash before it reaches noteholders. This is not modeled.", impact: "low" },
      { label: "No Senior Expenses Cap", detail: "Real deals cap total non-management expenses (typically €350K-500K/year). The model applies fees without this cap.", impact: "low" },
      { label: "No collateral manager advances", detail: "The PPM allows the manager to make advances (at EURIBOR + 4%) to buy enhancement obligations. These create a senior claim on waterfall cash. Not modeled.", impact: "low" },
    ],
  },
  {
    domain: "Deal Structure",
    items: [
      { label: "No call prediction", detail: "The model does not predict when a deal will be called. Most performing CLOs are called at or near the first call date, which dramatically changes equity returns. Use the call date input to model this scenario.", impact: "high" },
      { label: "No post-acceleration waterfall", detail: "Following an Event of Default, the real waterfall collapses into a simplified combined priority. This distressed scenario is not modeled.", impact: "medium" },
      { label: "No frequency switch", detail: "Some deals switch from quarterly to semi-annual payments after a trigger event. The model is hardcoded to quarterly periods.", impact: "low" },
      { label: "Quarterly periodicity", detail: "Cash flows are modeled in quarterly periods with beginning-of-period accrual. Real deals accrue daily and pay on specific calendar dates with business day adjustments.", impact: "low" },
      { label: "No discount obligation haircut", detail: "Assets purchased below 85% of par should be carried at purchase price in OC calculations. The model only applies CCC excess haircuts.", impact: "low" },
    ],
  },
];

export default function ProjectionModel({
  maturityDate,
  reinvestmentPeriodEnd,
  tranches,
  trancheSnapshots,
  poolSummary,
  complianceTests,
  constraints,
  holdings,
  panelId,
  dealContext,
  resolved,
  resolutionWarnings,
}: Props) {
  const trancheInputs = resolved?.tranches ?? [];
  const ocTriggers = resolved?.ocTriggers ?? [];
  const icTriggers = resolved?.icTriggers ?? [];
  const unmappedOc = ocTriggers.filter((oc) => oc.rank === 0);
  const unmappedIc = icTriggers.filter((ic) => ic.rank === 0);

  const [defaultRates, setDefaultRates] = useState<Record<string, number>>({ ...DEFAULT_RATES_BY_RATING });
  const [cprPct, setCprPct] = useState<number>(CLO_DEFAULTS.cprPct);
  const [recoveryPct, setRecoveryPct] = useState<number>(CLO_DEFAULTS.recoveryPct);
  const [recoveryLagMonths, setRecoveryLagMonths] = useState<number>(CLO_DEFAULTS.recoveryLagMonths);
  const [reinvestmentSpreadBps, setReinvestmentSpreadBps] = useState<number>(CLO_DEFAULTS.reinvestmentSpreadBps);
  const [reinvestmentTenorYears, setReinvestmentTenorYears] = useState<number>(CLO_DEFAULTS.reinvestmentTenorYears);
  const [reinvestmentRating, setReinvestmentRating] = useState<string>("auto");
  const [baseRatePct, setBaseRatePct] = useState<number>(CLO_DEFAULTS.baseRatePct);
  const [cccBucketLimitPct, setCccBucketLimitPct] = useState<number>(CLO_DEFAULTS.cccBucketLimitPct);
  const [cccMarketValuePct, setCccMarketValuePct] = useState<number>(CLO_DEFAULTS.cccMarketValuePct);
  // Fee assumptions — start at 0 (no hidden impact), pre-filled from resolved PPM data
  const [seniorFeePct, setSeniorFeePct] = useState<number>(CLO_DEFAULTS.seniorFeePct);
  const [subFeePct, setSubFeePct] = useState<number>(CLO_DEFAULTS.subFeePct);
  const [trusteeFeeBps, setTrusteeFeeBps] = useState<number>(CLO_DEFAULTS.trusteeFeeBps);
  const [hedgeCostBps, setHedgeCostBps] = useState<number>(CLO_DEFAULTS.hedgeCostBps);
  const [incentiveFeePct, setIncentiveFeePct] = useState<number>(CLO_DEFAULTS.incentiveFeePct);
  const [incentiveFeeHurdleIrr, setIncentiveFeeHurdleIrr] = useState<number>(CLO_DEFAULTS.incentiveFeeHurdleIrr);
  const [postRpReinvestmentPct, setPostRpReinvestmentPct] = useState<number>(CLO_DEFAULTS.postRpReinvestmentPct);
  const [showTransparency, setShowTransparency] = useState(false);
  const [expandedPeriod, setExpandedPeriod] = useState<number | null>(null);

  // Pre-fill fee sliders when resolved data arrives (extraction found real values)
  React.useEffect(() => {
    if (!resolved) return;
    const f = resolved.fees;
    if (f.seniorFeePct > 0) setSeniorFeePct(f.seniorFeePct);
    if (f.subFeePct > 0) setSubFeePct(f.subFeePct);
    if (f.trusteeFeeBps > 0) setTrusteeFeeBps(f.trusteeFeeBps);
    if (f.incentiveFeePct > 0) setIncentiveFeePct(f.incentiveFeePct);
    if (f.incentiveFeeHurdleIrr > 0) setIncentiveFeeHurdleIrr(f.incentiveFeeHurdleIrr * 100); // stored as decimal, display as %
  }, [resolved]);

  const loanInputs: LoanInput[] = resolved?.loans ?? [];

  const ratingDistribution = useMemo(() => {
    const dist: Record<string, { count: number; par: number }> = {};
    for (const bucket of RATING_BUCKETS) {
      dist[bucket] = { count: 0, par: 0 };
    }
    for (const loan of loanInputs) {
      const b = loan.ratingBucket as RatingBucket;
      if (dist[b]) {
        dist[b].count++;
        dist[b].par += loan.parBalance;
      }
    }
    return dist;
  }, [loanInputs]);

  const weightedAvgCdr = useMemo(() => {
    const totalPar = loanInputs.reduce((s, l) => s + l.parBalance, 0);
    if (totalPar === 0) return 0;
    return loanInputs.reduce((s, l) => s + l.parBalance * (defaultRates[l.ratingBucket] ?? 0), 0) / totalPar;
  }, [loanInputs, defaultRates]);

  const inputs: ProjectionInputs = useMemo(
    () => {
      if (!resolved) {
        // Safe default that will fail validation rather than crash
        return {
          initialPar: 0,
          wacSpreadBps: 0,
          baseRatePct,
          seniorFeePct,
          subFeePct,
          trusteeFeeBps,
          hedgeCostBps,
          incentiveFeePct,
          incentiveFeeHurdleIrr: incentiveFeeHurdleIrr / 100,
          postRpReinvestmentPct,
          callDate: null,
          reinvestmentOcTrigger: null,
          tranches: [],
          ocTriggers: [],
          icTriggers: [],
          reinvestmentPeriodEnd: null,
          maturityDate: null,
          currentDate: new Date().toISOString().slice(0, 10),
          loans: [],
          defaultRatesByRating: defaultRates,
          cprPct,
          recoveryPct,
          recoveryLagMonths,
          reinvestmentSpreadBps,
          reinvestmentTenorQuarters: reinvestmentTenorYears * 4,
          reinvestmentRating: null,
          cccBucketLimitPct,
          cccMarketValuePct,
          deferredInterestCompounds: true,
        };
      }
      return buildFromResolved(resolved, {
        baseRatePct,
        defaultRates: defaultRates,
        cprPct,
        recoveryPct,
        recoveryLagMonths,
        reinvestmentSpreadBps,
        reinvestmentTenorYears,
        reinvestmentRating: reinvestmentRating === "auto" ? null : reinvestmentRating,
        cccBucketLimitPct,
        cccMarketValuePct,
        deferredInterestCompounds: constraints.interestMechanics?.deferredInterestCompounds ?? true,
        postRpReinvestmentPct,
        hedgeCostBps,
        callDate: null,
        seniorFeePct,
        subFeePct,
        trusteeFeeBps,
        incentiveFeePct,
        incentiveFeeHurdleIrr,
      });
    },
    [
      resolved, baseRatePct, defaultRates, cprPct, recoveryPct, recoveryLagMonths,
      reinvestmentSpreadBps, reinvestmentTenorYears, reinvestmentRating, cccBucketLimitPct, cccMarketValuePct,
      constraints.interestMechanics?.deferredInterestCompounds,
      seniorFeePct, subFeePct, trusteeFeeBps, hedgeCostBps, incentiveFeePct, incentiveFeeHurdleIrr, postRpReinvestmentPct,
    ]
  );

  const validationErrors = useMemo(() => validateInputs(inputs), [inputs]);
  const result: ProjectionResult | null = useMemo(
    () => (validationErrors.length === 0 ? runProjection(inputs) : null),
    [inputs, validationErrors]
  );

  const sensitivity: SensitivityRow[] = useMemo(
    () => {
      if (!result || result.equityIrr === null) return [];
      return computeSensitivity(inputs, result.equityIrr);
    },
    [inputs, result]
  );

  const mc = useMonteCarlo(validationErrors.length === 0 ? inputs : null);

  const handleApplyAssumptions = (assumptions: {
    cdrPct: number;
    cprPct: number;
    recoveryPct: number;
    recoveryLagMonths: number;
    reinvestmentSpreadBps: number;
  }) => {
    const uniform: Record<string, number> = {};
    for (const bucket of RATING_BUCKETS) {
      uniform[bucket] = assumptions.cdrPct;
    }
    setDefaultRates(uniform);
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

      {loanInputs.length === 0 && validationErrors.length === 0 && (
        <div
          style={{
            padding: "0.75rem 1rem",
            border: "1px solid var(--color-warning-border, #e5c07b)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-warning-bg, #fdf6e3)",
            marginBottom: "1rem",
            fontSize: "0.82rem",
            color: "var(--color-warning, #946c00)",
          }}
        >
          No per-loan holdings data — projection uses aggregate CDR/CPR applied to total par, which is less accurate than per-loan modeling.
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
          <SliderInput label="CPR (Annual Prepay Rate)" value={cprPct} onChange={setCprPct} min={0} max={30} step={0.5} suffix="%" />
          <SliderInput label="Recovery Rate" value={recoveryPct} onChange={setRecoveryPct} min={0} max={80} step={1} suffix="%" />
          <SliderInput label="Recovery Lag" value={recoveryLagMonths} onChange={setRecoveryLagMonths} min={0} max={24} step={1} suffix=" mo" />
          <SliderInput label="Reinvestment Spread" value={reinvestmentSpreadBps} onChange={setReinvestmentSpreadBps} min={0} max={500} step={10} suffix=" bps" />
          <SliderInput label="Reinvestment Tenor" value={reinvestmentTenorYears} onChange={setReinvestmentTenorYears} min={1} max={10} step={1} suffix=" yr" />
          <SelectInput
            label="Reinvestment Rating"
            value={reinvestmentRating}
            onChange={setReinvestmentRating}
            options={[
              { value: "auto", label: "Portfolio Avg" },
              ...RATING_BUCKETS.map((b) => ({ value: b, label: b })),
            ]}
          />
          <SliderInput label="Base Rate (EURIBOR)" value={baseRatePct} onChange={setBaseRatePct} min={0} max={8} step={0.25} suffix="%" />
          <SliderInput label="Post-RP Reinvestment" value={postRpReinvestmentPct} onChange={setPostRpReinvestmentPct} min={0} max={100} step={5} suffix="%" />
          <SliderInput label="CCC Bucket Limit" value={cccBucketLimitPct} onChange={setCccBucketLimitPct} min={0} max={15} step={0.5} suffix="%" />
          <SliderInput label="CCC Mkt Value" value={cccMarketValuePct} onChange={setCccMarketValuePct} min={0} max={100} step={5} suffix="%" />
        </div>

        {/* Fees & Expenses — collapsible, pre-filled from PPM extraction */}
        <FeeAssumptions
          seniorFeePct={seniorFeePct} onSeniorFeeChange={setSeniorFeePct}
          subFeePct={subFeePct} onSubFeeChange={setSubFeePct}
          trusteeFeeBps={trusteeFeeBps} onTrusteeFeeChange={setTrusteeFeeBps}
          hedgeCostBps={hedgeCostBps} onHedgeCostChange={setHedgeCostBps}
          incentiveFeePct={incentiveFeePct} onIncentiveFeeChange={setIncentiveFeePct}
          incentiveFeeHurdleIrr={incentiveFeeHurdleIrr} onHurdleChange={setIncentiveFeeHurdleIrr}
          hasResolvedFees={!!resolved && (resolved.fees.seniorFeePct > 0 || resolved.fees.subFeePct > 0)}
        />
        <div style={{ marginTop: "1rem" }}>
          <DefaultRatePanel
            defaultRates={defaultRates}
            onChange={setDefaultRates}
            ratingDistribution={ratingDistribution}
            weightedAvgCdr={weightedAvgCdr}
          />
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

      {/* Unmapped OC/IC trigger warnings */}
      {(unmappedOc.length > 0 || unmappedIc.length > 0) && (
        <div
          style={{
            padding: "0.75rem 1rem",
            border: "1px solid #d4a017",
            borderRadius: "var(--radius-sm)",
            background: "#fef9e7",
            marginBottom: "1rem",
            fontSize: "0.78rem",
            color: "#7d6608",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>OC/IC Trigger Mapping Warnings</div>
          {unmappedOc.map((oc) => (
            <div key={oc.className}>&bull; OC trigger &quot;{oc.className}&quot; — no matching tranche, test disabled</div>
          ))}
          {unmappedIc.map((ic) => (
            <div key={ic.className}>&bull; IC trigger &quot;{ic.className}&quot; — no matching tranche, test disabled</div>
          ))}
        </div>
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
                Equity IRR <span style={{ fontSize: "0.55rem", fontWeight: 400, letterSpacing: "0.02em", opacity: 0.7 }}>(model estimate)</span>
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

          {/* Monte Carlo Analysis — visible by default */}
          <div style={{ marginBottom: "1.5rem" }}>
            <h3 style={{ fontSize: "0.95rem", fontWeight: 600, marginBottom: "0.75rem" }}>
              Monte Carlo Simulation
              <span style={{ fontSize: "0.75rem", fontWeight: 400, color: "var(--color-text-muted)", marginLeft: "0.5rem" }}>
                {mc.running ? "running..." : mc.result ? `${mc.result.runCount.toLocaleString()} runs` : ""}
              </span>
            </h3>
            <MonteCarloChart
              result={mc.result}
              running={mc.running}
              progress={mc.progress}
            />
          </div>

          {/* Transparency section */}
          <div
            style={{
              marginBottom: "1.5rem",
              border: "1px solid var(--color-border-light)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface)",
            }}
          >
            <button
              onClick={() => setShowTransparency(!showTransparency)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                padding: "0.6rem 0.8rem",
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: "0.8rem",
                fontWeight: 600,
                color: "var(--color-text-secondary)",
                textAlign: "left",
                fontFamily: "var(--font-body)",
              }}
            >
              <span style={{ fontSize: "0.65rem" }}>{showTransparency ? "▾" : "▸"}</span>
              Transparency
            </button>

            {showTransparency && (
              <div style={{ padding: "0 0.8rem 0.8rem" }}>
                <SensitivityTable rows={sensitivity} baseIrr={result.equityIrr} />
                {resolved && <ModelInputsPanel resolved={resolved} inputs={inputs} />}

              </div>
            )}
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
                            {payoffQ !== null ? formatDate(result.periods[payoffQ - 1]?.date ?? "") : "—"}
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
                      title={`${formatDate(p.date)}: ${formatAmount(p.endingPar)}`}
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
              <span>{formatDate(result.periods[0]?.date ?? "")}</span>
              <span>{formatDate(result.periods[result.periods.length - 1]?.date ?? "")}</span>
            </div>
          </div>

          {/* Cash Flow Detail */}
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: "0.95rem", fontWeight: 600, marginBottom: "0.75rem" }}>
            Cash Flow Detail
          </h3>
          <div
            style={{
              overflowX: "auto",
              overflowY: "auto",
              maxHeight: "600px",
              border: "1px solid var(--color-border-light)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <table
              className="wf-table"
              style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem", fontVariantNumeric: "tabular-nums" }}
            >
              <thead>
                <tr style={{ borderBottom: "2px solid var(--color-border)", textAlign: "right", background: "var(--color-surface)", position: "sticky", top: 0, zIndex: 1 }}>
                  {["Date", "Beg Par", "Defaults", "Prepays", "Maturities", "Recoveries", "Reinvest", "End Par", "Beg Liab", "End Liab", "Interest", "Equity"].map((h) => (
                    <th key={h} style={{ padding: "0.5rem 0.6rem", textAlign: h === "Date" ? "left" : "right", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.periods.map((p) => (
                  <React.Fragment key={p.periodNum}>
                    <tr
                      onClick={() => setExpandedPeriod(expandedPeriod === p.periodNum ? null : p.periodNum)}
                      style={{ borderBottom: "1px solid var(--color-border-light)", cursor: "pointer", background: expandedPeriod === p.periodNum ? "var(--color-surface-alt, var(--color-surface))" : undefined }}
                    >
                      <td style={{ padding: "0.45rem 0.6rem", fontWeight: 500, fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                        <span style={{ fontSize: "0.6rem", marginRight: "0.3rem" }}>{expandedPeriod === p.periodNum ? "▾" : "▸"}</span>
                        {formatDate(p.date)}
                      </td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.beginningPar)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: p.defaults > 0 ? "var(--color-low)" : undefined }}>{formatAmount(p.defaults)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.prepayments)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.scheduledMaturities)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.recoveries)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.reinvestment)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.endingPar)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.beginningLiabilities)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.endingLiabilities)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.interestCollected)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: p.equityDistribution > 0 ? "var(--color-high)" : undefined, fontWeight: p.equityDistribution > 0 ? 600 : undefined }}>{formatAmount(p.equityDistribution)}</td>
                    </tr>
                    {expandedPeriod === p.periodNum && (
                      <tr>
                        <td colSpan={12} style={{ padding: 0 }}>
                          <PeriodTrace period={p} inputs={inputs} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
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

function SelectInput({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.4rem" }}>
        <label style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", fontWeight: 500 }}>{label}</label>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "0.35rem 0.5rem",
          fontSize: "0.82rem",
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          border: "1px solid var(--color-border-light)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)",
          color: "var(--color-text)",
          cursor: "pointer",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function AssumptionItem({ label, detail, impact }: { label: string; detail: string; impact: AssumptionImpact }) {
  const dotColor = impact === "high" ? "var(--color-low)" : impact === "medium" ? "var(--color-warning, #d97706)" : "var(--color-text-muted)";
  return (
    <div
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
          width: "0.4rem",
          height: "0.4rem",
          marginTop: "0.3rem",
          borderRadius: "50%",
          background: dotColor,
        }}
        title={`Impact: ${impact}`}
      />
      <div>
        <span style={{ fontWeight: 600 }}>{label}:</span>{" "}
        <span style={{ color: "var(--color-text-muted)" }}>{detail}</span>
      </div>
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
          fontSize: "0.8rem",
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          textAlign: "left",
          fontFamily: "var(--font-body)",
        }}
      >
        <span style={{ fontSize: "0.65rem" }}>{open ? "▾" : "▸"}</span>
        Model Assumptions & Limitations
      </button>
      {open && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", marginBottom: "0.75rem", paddingTop: "0.25rem", lineHeight: 1.5 }}>
            This is a simplified deterministic projection. All outputs are estimates based on the assumptions below.{" "}
            <span style={{ fontWeight: 600 }}>Items marked with a red dot could change the equity IRR by 200+ basis points.</span>
          </div>
          {ASSUMPTIONS_REGISTER.map((group) => (
            <div key={group.domain}>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginTop: "0.75rem", marginBottom: "0.4rem" }}>
                {group.domain}
              </div>
              {group.items.map((a) => (
                <AssumptionItem key={a.label} label={a.label} detail={a.detail} impact={a.impact} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DefaultRatePanel({
  defaultRates,
  onChange,
  ratingDistribution,
  weightedAvgCdr,
}: {
  defaultRates: Record<string, number>;
  onChange: (rates: Record<string, number>) => void;
  ratingDistribution: Record<string, { count: number; par: number }>;
  weightedAvgCdr: number;
}) {
  const [open, setOpen] = useState(true);
  const [uniformInput, setUniformInput] = useState("");

  const applyUniform = () => {
    const val = parseFloat(uniformInput);
    if (!isNaN(val) && val >= 0) {
      const rates: Record<string, number> = {};
      for (const bucket of RATING_BUCKETS) rates[bucket] = val;
      onChange(rates);
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
          <span style={{ fontSize: "0.65rem", marginRight: "0.3rem" }}>{open ? "\u25BE" : "\u25B8"}</span>
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
            return (
              <div key={bucket} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.3rem 0" }}>
                <div style={{ width: "2.5rem", fontSize: "0.72rem", fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
                  {bucket}
                </div>
                <div style={{ width: "4rem", fontSize: "0.65rem", color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                  {dist.count > 0 ? `${dist.count} \u00B7 ${parPct.toFixed(0)}%` : "\u2014"}
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
              </div>
            );
          })}
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

function SensitivityTable({ rows, baseIrr }: { rows: SensitivityRow[]; baseIrr: number | null }) {
  if (rows.length === 0 || baseIrr === null) return null;
  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>
        IRR Sensitivity
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.75rem", fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid var(--color-border)", textAlign: "right" }}>
            {["Assumption", "Base", "Down", "Up", "IRR Impact"].map((h) => (
              <th key={h} style={{ padding: "0.4rem 0.6rem", textAlign: h === "Assumption" ? "left" : "right", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const downDelta = row.downIrr !== null ? (row.downIrr - baseIrr) * 100 : null;
            const upDelta = row.upIrr !== null ? (row.upIrr - baseIrr) * 100 : null;
            return (
              <tr key={row.assumption} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                <td style={{ padding: "0.45rem 0.6rem", fontWeight: 500 }}>{row.assumption}</td>
                <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{row.base}</td>
                <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{row.down}</td>
                <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{row.up}</td>
                <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                  {downDelta !== null && upDelta !== null ? (
                    <>
                      <span style={{ color: downDelta >= 0 ? "var(--color-high)" : "var(--color-low)" }}>
                        {downDelta >= 0 ? "+" : ""}{downDelta.toFixed(2)}%
                      </span>
                      {" / "}
                      <span style={{ color: upDelta >= 0 ? "var(--color-high)" : "var(--color-low)" }}>
                        {upDelta >= 0 ? "+" : ""}{upDelta.toFixed(2)}%
                      </span>
                    </>
                  ) : "N/A"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModelInputsPanel({ resolved, inputs }: { resolved: ResolvedDealData; inputs: ProjectionInputs }) {
  const [open, setOpen] = useState(false);

  const sourceBadge = (source: string) => {
    const colors: Record<string, string> = {
      snapshot: "var(--color-high)",
      compliance: "var(--color-high)",
      db_tranche: "var(--color-accent)",
      ppm: "var(--color-warning, #d97706)",
      default: "var(--color-low)",
    };
    return (
      <span style={{ fontSize: "0.6rem", fontWeight: 600, padding: "0.1rem 0.35rem", borderRadius: "3px", background: `${colors[source] ?? "var(--color-text-muted)"}18`, color: colors[source] ?? "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
        {source}
      </span>
    );
  };

  const kvStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "0.3rem 0", fontSize: "0.73rem", borderBottom: "1px solid var(--color-border-light)" };
  const kvLabel: React.CSSProperties = { color: "var(--color-text-muted)" };
  const kvValue: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: "0.72rem", fontWeight: 500 };

  return (
    <div style={{ marginBottom: "1rem" }}>
      <button onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.3rem 0", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem", color: "var(--color-text-muted)", fontFamily: "var(--font-body)" }}>
        <span style={{ fontSize: "0.6rem" }}>{open ? "▾" : "▸"}</span>
        Model Inputs
      </button>
      {open && (
        <div style={{ marginTop: "0.5rem" }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>Capital Structure</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.73rem", fontVariantNumeric: "tabular-nums", marginBottom: "1rem" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--color-border)", textAlign: "right" }}>
                {["Class", "Balance", "Spread", "Type", "Defer.", "Source"].map((h) => (
                  <th key={h} style={{ padding: "0.35rem 0.5rem", textAlign: h === "Class" || h === "Source" ? "left" : "right", fontWeight: 600, fontSize: "0.65rem", textTransform: "uppercase", color: "var(--color-text-muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resolved.tranches.map((t) => (
                <tr key={t.className} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                  <td style={{ padding: "0.35rem 0.5rem", fontWeight: 500 }}>{t.className}</td>
                  <td style={{ padding: "0.35rem 0.5rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(t.currentBalance)}</td>
                  <td style={{ padding: "0.35rem 0.5rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
                    {t.isIncomeNote ? "\u2014" : t.isFloating ? `${t.spreadBps} bps` : `Fixed ${(t.spreadBps / 100).toFixed(2)}%`}
                  </td>
                  <td style={{ padding: "0.35rem 0.5rem", textAlign: "right", fontSize: "0.72rem" }}>{t.isFloating ? "Float" : "Fixed"}</td>
                  <td style={{ padding: "0.35rem 0.5rem", textAlign: "right", fontSize: "0.72rem" }}>{t.isDeferrable ? "Yes" : "No"}</td>
                  <td style={{ padding: "0.35rem 0.5rem" }}>{sourceBadge(t.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>Fees</div>
              <div style={kvStyle}><span style={kvLabel}>Senior Mgmt</span> <span style={kvValue}>{resolved.fees.seniorFeePct}%</span></div>
              <div style={kvStyle}><span style={kvLabel}>Sub Mgmt</span> <span style={kvValue}>{resolved.fees.subFeePct}%</span></div>
              <div style={kvStyle}><span style={kvLabel}>Trustee/Admin</span> <span style={kvValue}>{resolved.fees.trusteeFeeBps} bps</span></div>
              <div style={kvStyle}><span style={kvLabel}>Incentive</span> <span style={kvValue}>{resolved.fees.incentiveFeePct > 0 ? `${resolved.fees.incentiveFeePct}%` : "None"}</span></div>
              <div style={kvStyle}><span style={kvLabel}>Hedge Cost</span> <span style={kvValue}>{inputs.hedgeCostBps} bps</span></div>
            </div>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>Dates</div>
              <div style={kvStyle}><span style={kvLabel}>Maturity</span> <span style={kvValue}>{resolved.dates.maturity}</span></div>
              <div style={kvStyle}><span style={kvLabel}>RP End</span> <span style={kvValue}>{resolved.dates.reinvestmentPeriodEnd ?? "N/A"}</span></div>
              <div style={kvStyle}><span style={kvLabel}>Non-Call</span> <span style={kvValue}>{resolved.dates.nonCallPeriodEnd ?? "N/A"}</span></div>
              <div style={kvStyle}><span style={kvLabel}>Call Date</span> <span style={kvValue}>{inputs.callDate ?? "Not set"}</span></div>
            </div>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>Pool</div>
              <div style={kvStyle}><span style={kvLabel}>Initial Par</span> <span style={kvValue}>{formatAmount(resolved.poolSummary.totalPar)}</span></div>
              <div style={kvStyle}><span style={kvLabel}>WAC Spread</span> <span style={kvValue}>{resolved.poolSummary.wacSpreadBps} bps</span></div>
              <div style={kvStyle}><span style={kvLabel}>Loans</span> <span style={kvValue}>{resolved.loans.length}</span></div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>OC Triggers</div>
              {resolved.ocTriggers.map((t) => (
                <div key={t.className} style={kvStyle}><span style={kvLabel}>{t.className}</span> <span style={kvValue}>{t.triggerLevel}% {sourceBadge(t.source)}</span></div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>IC Triggers</div>
              {resolved.icTriggers.map((t) => (
                <div key={t.className} style={kvStyle}><span style={kvLabel}>{t.className}</span> <span style={kvValue}>{t.triggerLevel}% {sourceBadge(t.source)}</span></div>
              ))}
              {resolved.reinvestmentOcTrigger && (
                <>
                  <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginTop: "0.5rem", marginBottom: "0.4rem" }}>Reinvestment OC</div>
                  <div style={kvStyle}><span style={kvLabel}>Trigger</span> <span style={kvValue}>{resolved.reinvestmentOcTrigger.triggerLevel}%</span></div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PeriodTrace({ period, inputs }: { period: PeriodResult; inputs: ProjectionInputs }) {
  const beginPar = period.beginningPar;
  const trusteeFee = beginPar * (inputs.trusteeFeeBps / 10000) / 4;
  const seniorFee = beginPar * (inputs.seniorFeePct / 100) / 4;
  const hedgeCost = beginPar * (inputs.hedgeCostBps / 10000) / 4;
  const subFee = beginPar * (inputs.subFeePct / 100) / 4;
  const availableAfterSenior = period.interestCollected - trusteeFee - seniorFee - hedgeCost;

  const principalAvailable = Math.max(0, period.prepayments + period.scheduledMaturities + period.recoveries - period.reinvestment);
  const equityFromInterest = Math.max(0, period.equityDistribution - principalAvailable);

  const lineStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "0.2rem 0", fontSize: "0.72rem", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" };
  const indent: React.CSSProperties = { paddingLeft: "1.2rem" };
  const labelStyle: React.CSSProperties = { color: "var(--color-text-muted)" };
  const feeColor = "var(--color-low)";
  const eqColor = "var(--color-high)";
  const dividerStyle: React.CSSProperties = { borderTop: "1px solid var(--color-border-light)", margin: "0.3rem 0" };

  return (
    <div style={{ padding: "0.75rem 1rem", background: "var(--color-surface-alt, var(--color-surface))", borderTop: "1px dashed var(--color-border-light)", fontSize: "0.72rem" }}>
      <div style={{ fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.4rem" }}>Interest Waterfall</div>
      <div style={lineStyle}><span>Interest Collected</span><span>{formatAmount(period.interestCollected)}</span></div>
      <div style={{ ...lineStyle, ...indent }}><span style={{ color: feeColor }}>Trustee/Admin ({inputs.trusteeFeeBps} bps)</span><span style={{ color: feeColor }}>-{formatAmount(trusteeFee)}</span></div>
      <div style={{ ...lineStyle, ...indent }}><span style={{ color: feeColor }}>Senior Mgmt Fee ({inputs.seniorFeePct}%)</span><span style={{ color: feeColor }}>-{formatAmount(seniorFee)}</span></div>
      {hedgeCost > 0 && <div style={{ ...lineStyle, ...indent }}><span style={{ color: feeColor }}>Hedge Costs ({inputs.hedgeCostBps} bps)</span><span style={{ color: feeColor }}>-{formatAmount(hedgeCost)}</span></div>}
      <div style={{ ...lineStyle, ...indent, fontWeight: 500 }}><span>Available for tranches</span><span>{formatAmount(Math.max(0, availableAfterSenior))}</span></div>

      {period.trancheInterest.map((t) => (
        <div key={t.className} style={{ ...lineStyle, ...indent }}>
          <span style={labelStyle}>{t.className} interest{t.paid < t.due ? ` (shortfall: ${formatAmount(t.due - t.paid)})` : ""}</span>
          <span>{t.paid > 0 ? `-${formatAmount(t.paid)}` : "\u2014"}</span>
        </div>
      ))}

      {(period.ocTests.length > 0 || period.icTests.length > 0) && (
        <div style={{ ...lineStyle, ...indent, flexWrap: "wrap", gap: "0.4rem" }}>
          {period.ocTests.map((t) => (
            <span key={`oc-${t.className}`} style={{ color: t.passing ? "var(--color-high)" : "var(--color-low)", fontSize: "0.68rem" }}>
              {t.passing ? "\u2713" : "\u2717"} {t.className} OC {t.actual.toFixed(1)}%
            </span>
          ))}
          {period.icTests.map((t) => (
            <span key={`ic-${t.className}`} style={{ color: t.passing ? "var(--color-high)" : "var(--color-low)", fontSize: "0.68rem" }}>
              {t.passing ? "\u2713" : "\u2717"} {t.className} IC {t.actual.toFixed(1)}%
            </span>
          ))}
        </div>
      )}

      <div style={{ ...lineStyle, ...indent }}><span style={{ color: feeColor }}>Sub Mgmt Fee ({inputs.subFeePct}%)</span><span style={{ color: feeColor }}>-{formatAmount(subFee)}</span></div>
      <div style={dividerStyle} />
      <div style={{ ...lineStyle, fontWeight: 600 }}><span style={{ color: eqColor }}>Equity (from interest)</span><span style={{ color: eqColor }}>{formatAmount(equityFromInterest)}</span></div>

      <div style={{ fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginTop: "0.75rem", marginBottom: "0.4rem" }}>Principal Waterfall</div>
      <div style={lineStyle}><span>Prepayments</span><span>{formatAmount(period.prepayments)}</span></div>
      <div style={lineStyle}><span>Maturities</span><span>{formatAmount(period.scheduledMaturities)}</span></div>
      <div style={lineStyle}><span>Recoveries</span><span>{formatAmount(period.recoveries)}</span></div>
      {period.reinvestment > 0 && <div style={{ ...lineStyle, ...indent }}><span style={{ color: feeColor }}>Reinvested</span><span style={{ color: feeColor }}>-{formatAmount(period.reinvestment)}</span></div>}
      {period.tranchePrincipal.filter((t) => t.paid > 0).map((t) => (
        <div key={t.className} style={{ ...lineStyle, ...indent }}><span style={labelStyle}>{t.className} principal</span><span>-{formatAmount(t.paid)}</span></div>
      ))}
      <div style={dividerStyle} />
      <div style={{ ...lineStyle, fontWeight: 700 }}><span style={{ color: eqColor }}>Total Equity Distribution</span><span style={{ color: eqColor }}>{formatAmount(period.equityDistribution)}</span></div>
    </div>
  );
}

function FeeAssumptions({
  seniorFeePct, onSeniorFeeChange,
  subFeePct, onSubFeeChange,
  trusteeFeeBps, onTrusteeFeeChange,
  hedgeCostBps, onHedgeCostChange,
  incentiveFeePct, onIncentiveFeeChange,
  incentiveFeeHurdleIrr, onHurdleChange,
  hasResolvedFees,
}: {
  seniorFeePct: number; onSeniorFeeChange: (v: number) => void;
  subFeePct: number; onSubFeeChange: (v: number) => void;
  trusteeFeeBps: number; onTrusteeFeeChange: (v: number) => void;
  hedgeCostBps: number; onHedgeCostChange: (v: number) => void;
  incentiveFeePct: number; onIncentiveFeeChange: (v: number) => void;
  incentiveFeeHurdleIrr: number; onHurdleChange: (v: number) => void;
  hasResolvedFees: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: "0.75rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.4rem", padding: "0.5rem 0.8rem", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem", color: "var(--color-text-muted)", textAlign: "left", fontFamily: "var(--font-body)" }}
      >
        <span>
          <span style={{ fontSize: "0.65rem", marginRight: "0.3rem" }}>{open ? "▾" : "▸"}</span>
          Fees & Expenses
        </span>
        {hasResolvedFees && <span style={{ fontSize: "0.6rem", fontWeight: 600, padding: "0.1rem 0.35rem", borderRadius: "3px", background: "var(--color-high)18", color: "var(--color-high)" }}>FROM PPM</span>}
        {!hasResolvedFees && (seniorFeePct === 0 && subFeePct === 0) && <span style={{ fontSize: "0.6rem", fontWeight: 600, padding: "0.1rem 0.35rem", borderRadius: "3px", background: "var(--color-warning, #d97706)18", color: "var(--color-warning, #d97706)" }}>NOT SET</span>}
      </button>
      {open && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          <div style={{ fontSize: "0.68rem", color: "var(--color-text-muted)", marginBottom: "0.75rem", lineHeight: 1.5 }}>
            {hasResolvedFees
              ? "Pre-filled from PPM extraction. Adjust if the extracted values look wrong."
              : "No fees were extracted from the PPM. Set them manually or the model will assume zero fees (overstating equity returns)."
            }
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1.25rem" }}>
            <SliderInput label="Senior Mgmt Fee" value={seniorFeePct} onChange={onSeniorFeeChange} min={0} max={1} step={0.05} suffix="% p.a." />
            <SliderInput label="Sub Mgmt Fee" value={subFeePct} onChange={onSubFeeChange} min={0} max={0.5} step={0.05} suffix="% p.a." />
            <SliderInput label="Trustee/Admin Fee" value={trusteeFeeBps} onChange={onTrusteeFeeChange} min={0} max={10} step={1} suffix=" bps" />
            <SliderInput label="Hedge Cost" value={hedgeCostBps} onChange={onHedgeCostChange} min={0} max={50} step={1} suffix=" bps" />
            <SliderInput label="Incentive Fee" value={incentiveFeePct} onChange={onIncentiveFeeChange} min={0} max={30} step={1} suffix="% of residual" />
            <SliderInput label="Incentive Hurdle IRR" value={incentiveFeeHurdleIrr} onChange={onHurdleChange} min={0} max={20} step={0.5} suffix="%" />
          </div>
        </div>
      )}
    </div>
  );
}
