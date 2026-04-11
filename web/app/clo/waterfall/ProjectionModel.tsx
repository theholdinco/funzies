"use client";

import React, { useState, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type {
  CloTranche,
  CloTrancheSnapshot,
  CloPoolSummary,
  CloComplianceTest,
  CloHolding,
  ExtractedConstraints,
  BuyListItem,
} from "@/lib/clo/types";
import {
  runProjection,
  validateInputs,
  type ProjectionInputs,
  type ProjectionResult,
  type LoanInput,
} from "@/lib/clo/projection";
import type { ResolvedDealData, ResolutionWarning } from "@/lib/clo/resolver-types";
import { buildFromResolved, EMPTY_RESOLVED } from "@/lib/clo/build-projection-inputs";
import { DEFAULT_RATES_BY_RATING, RATING_BUCKETS, type RatingBucket } from "@/lib/clo/rating-mapping";
import SuggestAssumptions from "./SuggestAssumptions";
import { CLO_DEFAULTS } from "@/lib/clo/defaults";
import { useMonteCarlo } from "@/lib/clo/useMonteCarlo";
import MonteCarloChart from "./MonteCarloChart";
import { formatPct, formatAmount, formatDate, TRANCHE_COLORS } from "./helpers";
import { SliderInput, SelectInput } from "./SliderInput";
import { SummaryCard } from "./SummaryCard";
import { ModelInputsPanel } from "./ModelInputsPanel";
import { PeriodTrace } from "./PeriodTrace";
import { FeeAssumptions } from "./FeeAssumptions";
import { ModelAssumptions } from "./ModelAssumptions";
import { DefaultRatePanel } from "./DefaultRatePanel";
import { SwitchSimulator } from "./SwitchSimulator";
import { type UserAssumptions } from "@/lib/clo/build-projection-inputs";

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
  buyList?: BuyListItem[];
}

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
  buyList,
}: Props) {
  // Read URL params for pre-filling switch simulator from analysis page
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  const switchPrefill = useMemo(() => {
    if (urlTab !== "switch") return null;
    return {
      sellName: searchParams.get("sell"),
      buyName: searchParams.get("buyName"),
      buySpread: searchParams.get("buySpread"),
      buyRating: searchParams.get("buyRating"),
      buyMaturity: searchParams.get("buyMaturity"),
      buyPar: searchParams.get("buyPar"),
    };
  }, [urlTab, searchParams]);

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
  const [baseRateFloorPct, setBaseRateFloorPct] = useState<number>(resolved?.baseRateFloorPct ?? CLO_DEFAULTS.baseRateFloorPct);
  const [cccBucketLimitPct, setCccBucketLimitPct] = useState<number>(CLO_DEFAULTS.cccBucketLimitPct);
  const [cccMarketValuePct, setCccMarketValuePct] = useState<number>(CLO_DEFAULTS.cccMarketValuePct);
  // Fee assumptions — pre-filled from resolved PPM data if available, otherwise defaults (zero).
  const initFees = resolved?.fees;
  const [seniorFeePct, setSeniorFeePct] = useState<number>(initFees?.seniorFeePct ?? CLO_DEFAULTS.seniorFeePct);
  const [subFeePct, setSubFeePct] = useState<number>(initFees?.subFeePct ?? CLO_DEFAULTS.subFeePct);
  const [trusteeFeeBps, setTrusteeFeeBps] = useState<number>(initFees?.trusteeFeeBps ?? CLO_DEFAULTS.trusteeFeeBps);
  const [hedgeCostBps, setHedgeCostBps] = useState<number>(CLO_DEFAULTS.hedgeCostBps);
  const [incentiveFeePct, setIncentiveFeePct] = useState<number>(initFees?.incentiveFeePct ?? CLO_DEFAULTS.incentiveFeePct);
  const [incentiveFeeHurdleIrr, setIncentiveFeeHurdleIrr] = useState<number>(
    initFees?.incentiveFeeHurdleIrr ? initFees.incentiveFeeHurdleIrr * 100 : CLO_DEFAULTS.incentiveFeeHurdleIrr
  );
  const [postRpReinvestmentPct, setPostRpReinvestmentPct] = useState<number>(CLO_DEFAULTS.postRpReinvestmentPct);
  const [callDate, setCallDate] = useState<string | null>(null);
  const [callPricePct, setCallPricePct] = useState<number>(100);
  const [showTransparency, setShowTransparency] = useState(false);
  const [expandedPeriod, setExpandedPeriod] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"projection" | "switch">(urlTab === "switch" ? "switch" : "projection");

  // Pre-fill fee sliders when resolved data changes (only on first load, not on re-renders
  // that would stomp user edits). Track whether fees have been initialized.
  const feesInitialized = useRef(false);
  React.useEffect(() => {
    if (!resolved || feesInitialized.current) return;
    feesInitialized.current = true;
    const f = resolved.fees;
    if (f.seniorFeePct != null) setSeniorFeePct(f.seniorFeePct);
    if (f.subFeePct != null) setSubFeePct(f.subFeePct);
    if (f.trusteeFeeBps != null) setTrusteeFeeBps(f.trusteeFeeBps);
    if (f.incentiveFeePct != null) setIncentiveFeePct(f.incentiveFeePct);
    if (f.incentiveFeeHurdleIrr != null) setIncentiveFeeHurdleIrr(f.incentiveFeeHurdleIrr * 100); // stored as decimal, display as %
    if (resolved.dates.nonCallPeriodEnd) setCallDate(null);
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
      const resolvedData = resolved ?? EMPTY_RESOLVED;
      return buildFromResolved(resolvedData, {
        baseRatePct,
        baseRateFloorPct,
        defaultRates: defaultRates,
        cprPct,
        recoveryPct,
        recoveryLagMonths,
        reinvestmentSpreadBps,
        reinvestmentTenorYears,
        reinvestmentRating: reinvestmentRating === "auto" ? null : reinvestmentRating,
        cccBucketLimitPct,
        cccMarketValuePct,
        deferredInterestCompounds: resolved?.deferredInterestCompounds ?? true,
        postRpReinvestmentPct,
        hedgeCostBps,
        callDate,
        callPricePct,
        seniorFeePct,
        subFeePct,
        trusteeFeeBps,
        incentiveFeePct,
        incentiveFeeHurdleIrr,
      });
    },
    [
      resolved, baseRatePct, baseRateFloorPct, defaultRates, cprPct, recoveryPct, recoveryLagMonths,
      reinvestmentSpreadBps, reinvestmentTenorYears, reinvestmentRating, cccBucketLimitPct, cccMarketValuePct,
      resolved?.deferredInterestCompounds,
      seniorFeePct, subFeePct, trusteeFeeBps, hedgeCostBps, incentiveFeePct, incentiveFeeHurdleIrr, postRpReinvestmentPct,
      callDate, callPricePct,
    ]
  );

  const userAssumptions: UserAssumptions = useMemo(() => ({
    baseRatePct,
    baseRateFloorPct,
    defaultRates: defaultRates,
    cprPct,
    recoveryPct,
    recoveryLagMonths,
    reinvestmentSpreadBps,
    reinvestmentTenorYears,
    reinvestmentRating: reinvestmentRating === "auto" ? null : reinvestmentRating,
    cccBucketLimitPct,
    cccMarketValuePct,
    deferredInterestCompounds: resolved?.deferredInterestCompounds ?? true,
    postRpReinvestmentPct,
    hedgeCostBps,
    callDate,
    callPricePct,
    seniorFeePct,
    subFeePct,
    trusteeFeeBps,
    incentiveFeePct,
    incentiveFeeHurdleIrr,
  }), [
    baseRatePct, baseRateFloorPct, defaultRates, cprPct, recoveryPct, recoveryLagMonths,
    reinvestmentSpreadBps, reinvestmentTenorYears, reinvestmentRating, cccBucketLimitPct, cccMarketValuePct,
    resolved?.deferredInterestCompounds,
    postRpReinvestmentPct, hedgeCostBps, callDate, callPricePct, seniorFeePct, subFeePct, trusteeFeeBps, incentiveFeePct, incentiveFeeHurdleIrr,
  ]);

  const validationErrors = useMemo(() => validateInputs(inputs), [inputs]);
  const result: ProjectionResult | null = useMemo(
    () => (validationErrors.length === 0 ? runProjection(inputs) : null),
    [inputs, validationErrors]
  );

  const deferredInputs = React.useDeferredValue(inputs);
  const deferredResult = React.useDeferredValue(result);


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

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 0, marginBottom: "1.5rem", borderBottom: "2px solid var(--color-border-light)" }}>
        {(["projection", "switch"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "0.6rem 1.25rem",
              fontSize: "0.8rem",
              fontWeight: activeTab === tab ? 600 : 400,
              fontFamily: "var(--font-body)",
              color: activeTab === tab ? "var(--color-text)" : "var(--color-text-muted)",
              background: "none",
              border: "none",
              borderBottom: activeTab === tab ? "2px solid var(--color-accent)" : "2px solid transparent",
              marginBottom: "-2px",
              cursor: "pointer",
              transition: "color 0.15s",
            }}
          >
            {tab === "projection" ? "Projection" : "Switch Simulator"}
          </button>
        ))}
      </div>

      {activeTab === "projection" && (<>
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
          <SliderInput label="CPR (Annual Prepay Rate)" value={cprPct} onChange={setCprPct} min={0} max={30} step={0.5} suffix="%" hint="Constant annual prepayment rate. Higher CPR means faster par decline and earlier principal return." />
          <SliderInput label="Recovery Rate" value={recoveryPct} onChange={setRecoveryPct} min={0} max={80} step={1} suffix="%" hint="Percentage of defaulted par recovered as cash after the recovery lag period." />
          <SliderInput label="Recovery Lag" value={recoveryLagMonths} onChange={setRecoveryLagMonths} min={0} max={24} step={1} suffix=" mo" hint="Months between a loan default and when recovery cash is received." />
          <SliderInput label="Reinvestment Spread" value={reinvestmentSpreadBps} onChange={setReinvestmentSpreadBps} min={0} max={500} step={10} suffix=" bps" hint="Spread (over base rate) earned on newly purchased loans during the reinvestment period." />
          <SliderInput label="Reinvestment Tenor" value={reinvestmentTenorYears} onChange={setReinvestmentTenorYears} min={1} max={10} step={1} suffix=" yr" hint="Average maturity of newly reinvested loans, in years from purchase." />
          <SliderInput label="Base Rate (EURIBOR)" value={baseRatePct} onChange={setBaseRatePct} min={0} max={8} step={0.25} suffix="%" hint="3-month EURIBOR assumption, held flat for the entire projection. Floored at 0%." />
          <SliderInput label="Post-RP Reinvestment" value={postRpReinvestmentPct} onChange={setPostRpReinvestmentPct} min={0} max={100} step={5} suffix="%" hint="Percentage of principal proceeds reinvested after the reinvestment period ends. 0% means all proceeds go to tranche paydown." />
          <SliderInput label="CCC Bucket Limit" value={cccBucketLimitPct} onChange={setCccBucketLimitPct} min={0} max={15} step={0.5} suffix="%" hint="CCC-rated par exceeding this % of total par gets haircut to market value in the OC test numerator." />
          <SliderInput label="CCC Mkt Value" value={cccMarketValuePct} onChange={setCccMarketValuePct} min={0} max={100} step={5} suffix="%" hint="Market value assumption (as % of par) for CCC excess in the OC haircut calculation." />
          <div>
            <SelectInput
              label="Reinvestment Rating"
              value={reinvestmentRating}
              onChange={setReinvestmentRating}
              options={[
                { value: "auto", label: "Portfolio Avg" },
                ...RATING_BUCKETS.map((b) => ({ value: b, label: b })),
              ]}
            />
            <div style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", marginTop: "0.3rem", lineHeight: 1.4, opacity: 0.8 }}>
              Rating bucket for reinvested loans. &quot;Portfolio Avg&quot; uses the par-weighted modal rating.
            </div>
          </div>
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
          callDate={callDate} onCallDateChange={setCallDate}
          callPricePct={callPricePct} onCallPriceChange={setCallPricePct}
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
      </>)}

      {activeTab === "switch" && resolved && (
        <div>
          <SwitchSimulator
            resolved={resolved}
            holdings={holdings}
            buyList={buyList ?? []}
            userAssumptions={userAssumptions}
            prefill={switchPrefill}
          />
          {/* Assumptions — identical to Projection tab */}
          <div
            style={{
              padding: "1.25rem",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border-light)",
              borderRadius: "var(--radius-sm)",
              marginTop: "1.5rem",
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
              <SliderInput label="CPR (Annual Prepay Rate)" value={cprPct} onChange={setCprPct} min={0} max={30} step={0.5} suffix="%" hint="Constant annual prepayment rate. Higher CPR means faster par decline and earlier principal return." />
              <SliderInput label="Recovery Rate" value={recoveryPct} onChange={setRecoveryPct} min={0} max={80} step={1} suffix="%" hint="Percentage of defaulted par recovered as cash after the recovery lag period." />
              <SliderInput label="Recovery Lag" value={recoveryLagMonths} onChange={setRecoveryLagMonths} min={0} max={24} step={1} suffix=" mo" hint="Months between a loan default and when recovery cash is received." />
              <SliderInput label="Reinvestment Spread" value={reinvestmentSpreadBps} onChange={setReinvestmentSpreadBps} min={0} max={500} step={10} suffix=" bps" hint="Spread (over base rate) earned on newly purchased loans during the reinvestment period." />
              <SliderInput label="Reinvestment Tenor" value={reinvestmentTenorYears} onChange={setReinvestmentTenorYears} min={1} max={10} step={1} suffix=" yr" hint="Average maturity of newly reinvested loans, in years from purchase." />
              <SliderInput label="Base Rate (EURIBOR)" value={baseRatePct} onChange={setBaseRatePct} min={0} max={8} step={0.25} suffix="%" hint="3-month EURIBOR assumption, held flat for the entire projection. Floored at 0%." />
              <SliderInput label="Post-RP Reinvestment" value={postRpReinvestmentPct} onChange={setPostRpReinvestmentPct} min={0} max={100} step={5} suffix="%" hint="Percentage of principal proceeds reinvested after the reinvestment period ends. 0% means all proceeds go to tranche paydown." />
              <SliderInput label="CCC Bucket Limit" value={cccBucketLimitPct} onChange={setCccBucketLimitPct} min={0} max={15} step={0.5} suffix="%" hint="CCC-rated par exceeding this % of total par gets haircut to market value in the OC test numerator." />
              <SliderInput label="CCC Mkt Value" value={cccMarketValuePct} onChange={setCccMarketValuePct} min={0} max={100} step={5} suffix="%" hint="Market value assumption (as % of par) for CCC excess in the OC haircut calculation." />
              <div>
                <SelectInput
                  label="Reinvestment Rating"
                  value={reinvestmentRating}
                  onChange={setReinvestmentRating}
                  options={[
                    { value: "auto", label: "Portfolio Avg" },
                    ...RATING_BUCKETS.map((b) => ({ value: b, label: b })),
                  ]}
                />
                <div style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", marginTop: "0.3rem", lineHeight: 1.4, opacity: 0.8 }}>
                  Rating bucket for reinvested loans. &quot;Portfolio Avg&quot; uses the par-weighted modal rating.
                </div>
              </div>
            </div>

            <FeeAssumptions
              seniorFeePct={seniorFeePct} onSeniorFeeChange={setSeniorFeePct}
              subFeePct={subFeePct} onSubFeeChange={setSubFeePct}
              trusteeFeeBps={trusteeFeeBps} onTrusteeFeeChange={setTrusteeFeeBps}
              hedgeCostBps={hedgeCostBps} onHedgeCostChange={setHedgeCostBps}
              incentiveFeePct={incentiveFeePct} onIncentiveFeeChange={setIncentiveFeePct}
              incentiveFeeHurdleIrr={incentiveFeeHurdleIrr} onHurdleChange={setIncentiveFeeHurdleIrr}
              hasResolvedFees={!!resolved && (resolved.fees.seniorFeePct > 0 || resolved.fees.subFeePct > 0)}
              callDate={callDate} onCallDateChange={setCallDate}
              callPricePct={callPricePct} onCallPriceChange={setCallPricePct}
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
        </div>
      )}
    </div>
  );
}
