"use client";

import { useState, useMemo } from "react";
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
  addQuarters,
  type ProjectionInputs,
  type ProjectionResult,
  type LoanInput,
} from "@/lib/clo/projection";
import { mapToRatingBucket, DEFAULT_RATES_BY_RATING, RATING_BUCKETS, type RatingBucket } from "@/lib/clo/rating-mapping";
import SuggestAssumptions from "./SuggestAssumptions";

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
  const [y, m] = isoDate.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${y.slice(2)}`;
}

const TRANCHE_COLORS = [
  "#2d6a4f", "#5a7c2f", "#92641a", "#b54a32", "#7c3aed", "#2563eb",
];

const WATERFALL_MECHANICS = [
  {
    label: "1. Collateral cash flows",
    detail: "Each quarter, the portfolio generates cash from three sources: interest collected on performing loans, principal from maturing and prepaying loans, and recovery cash from previously defaulted loans. Defaults and prepayments reduce the performing pool each period.",
  },
  {
    label: "2. Senior fees",
    detail: "Trustee, administrative, and collateral manager senior fees are deducted first from interest collections before any tranche receives payment.",
  },
  {
    label: "3. Interest waterfall",
    detail: "After senior fees, interest is paid to debt tranches in seniority order (most senior first). After paying each tranche, the OC and IC tests at that level are checked. If a test fails, all remaining interest is diverted to principal paydown — junior tranches receive nothing.",
  },
  {
    label: "4. OC test (overcollateralization)",
    detail: "OC ratio = performing collateral par / debt outstanding at-and-above the tested class. If the ratio falls below the trigger (e.g. 120%), the test fails. This protects senior investors by diverting cash from equity to pay down debt when collateral erodes.",
  },
  {
    label: "5. IC test (interest coverage)",
    detail: "IC ratio = interest collected (after senior fees) / interest due on debt at-and-above the tested class. If the ratio falls below the trigger, the test fails. This ensures there's enough interest income to service the debt before equity gets paid.",
  },
  {
    label: "6. Principal waterfall",
    detail: "Principal proceeds (prepayments + maturities + recoveries − reinvestment + any diverted interest) pay down debt tranches in seniority order. During the reinvestment period, most principal is reinvested rather than used for paydown. At deal maturity, all remaining collateral is liquidated.",
  },
  {
    label: "7. Equity distribution",
    detail: "Whatever remains after senior fees, tranche interest, and tranche principal goes to equity holders. This includes residual interest (if no OC/IC diversion consumed it) plus any leftover principal proceeds.",
  },
  {
    label: "8. Equity IRR",
    detail: "The annualized internal rate of return on equity cash flows, computed via Newton-Raphson. The initial investment (collateral par minus total debt) is the negative cash flow at time zero; quarterly equity distributions are the positive cash flows.",
  },
];

const MODEL_SIMPLIFICATIONS = [
  {
    label: "Per-loan default model",
    detail: "Each loan is modeled individually with a rating-based annual default rate (converted to a quarterly hazard rate). Defaults reduce a loan's expected surviving par each quarter. At maturity, only the surviving portion exits the pool.",
  },
  {
    label: "Recovery pipeline",
    detail: "Defaulted par generates recovery cash equal to the recovery rate, arriving after a configurable lag. Recovery is cash, not par restoration — it flows to the principal waterfall. At deal maturity, all pending recoveries are accelerated.",
  },
  {
    label: "Reinvestment",
    detail: "During the reinvestment period, proceeds are reinvested into a synthetic loan each quarter using the configured rating, spread, and maturity tenor. Post-RP, all proceeds flow to the principal waterfall instead.",
  },
  {
    label: "Constant assumption rates",
    detail: "Default rates, CPR, recovery rate, and base rate are held constant across all periods. Real performance will vary over time.",
  },
  {
    label: "Quarterly periodicity",
    detail: "Cash flows are modeled in quarterly periods. Interest accrues on beginning-of-period par rather than daily accrual.",
  },
  {
    label: "Full diversion on OC/IC failure",
    detail: "When an OC or IC test fails, all remaining interest is diverted to principal paydown. Real indentures may allow partial cure.",
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

  const classXAmort = constraints.dealSizing?.classXAmortisation;
  const classXAmortPerQuarter = classXAmort ? parseAmount(classXAmort) : null;

  return Array.from(byClass.values()).map((e, idx) => {
    const isSubordinated = e.isSubordinated ?? e.class.toLowerCase().includes("sub");
    const isFloating = e.rateType?.toLowerCase().includes("float") ??
      (e.spread?.toLowerCase().includes("euribor") || e.spread?.toLowerCase().includes("sofr") || false);
    const isClassX = /^(class\s+)?x$/i.test(e.class.trim());
    return {
      className: e.class,
      currentBalance: parseAmount(e.principalAmount),
      spreadBps: e.spreadBps ?? 0,
      seniorityRank: idx + 1,
      isFloating,
      isIncomeNote: isSubordinated,
      isDeferrable: e.deferrable ?? false,
      isAmortising: isClassX,
      amortisationPerPeriod: isClassX ? classXAmortPerQuarter : null,
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
  holdings,
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

  // Deduplicate triggers by className — keep highest triggerLevel (most conservative)
  function dedupTriggers(triggers: { className: string; triggerLevel: number }[]) {
    const byClass = new Map<string, { className: string; triggerLevel: number }>();
    for (const t of triggers) {
      const existing = byClass.get(t.className);
      if (!existing || t.triggerLevel > existing.triggerLevel) {
        byClass.set(t.className, t);
      }
    }
    return Array.from(byClass.values());
  }

  const ocTriggersRaw = useMemo(() => {
    const fromTests = complianceTests
      .filter((t) => isOcTest(t) && t.triggerLevel !== null && t.testClass)
      .map((t) => ({ className: t.testClass!, triggerLevel: t.triggerLevel! }));
    const raw = fromTests.length > 0
      ? fromTests
      : (constraints.coverageTestEntries ?? [])
          .filter((e) => e.class && e.parValueRatio && parseFloat(e.parValueRatio))
          .map((e) => ({ className: e.class!, triggerLevel: parseFloat(e.parValueRatio!) }));
    return dedupTriggers(raw);
  }, [complianceTests, constraints]);

  const icTriggersRaw = useMemo(() => {
    const fromTests = complianceTests
      .filter((t) => isIcTest(t) && t.triggerLevel !== null && t.testClass)
      .map((t) => ({ className: t.testClass!, triggerLevel: t.triggerLevel! }));
    const raw = fromTests.length > 0
      ? fromTests
      : (constraints.coverageTestEntries ?? [])
          .filter((e) => e.class && e.interestCoverageRatio && parseFloat(e.interestCoverageRatio))
          .map((e) => ({ className: e.class!, triggerLevel: parseFloat(e.interestCoverageRatio!) }));
    return dedupTriggers(raw);
  }, [complianceTests, constraints]);

  const trancheInputs = useMemo(() => {
    if (tranches.length > 0) {
      const snapshotByTrancheId = new Map(trancheSnapshots.map((s) => [s.trancheId, s]));
      const classXAmort = constraints.dealSizing?.classXAmortisation;
      const classXAmortPerQuarter = classXAmort ? parseAmount(classXAmort) : null;
      return [...tranches]
        .sort((a, b) => (a.seniorityRank ?? 99) - (b.seniorityRank ?? 99))
        .map((t) => {
          const snap = snapshotByTrancheId.get(t.id);
          const isClassX = /^(class\s+)?x$/i.test(t.className.trim());
          return {
            className: t.className,
            currentBalance: snap?.currentBalance ?? t.originalBalance ?? 0,
            spreadBps: t.spreadBps ?? 0,
            seniorityRank: t.seniorityRank ?? 99,
            isFloating: t.isFloating ?? true,
            isIncomeNote: t.isIncomeNote ?? t.isSubordinate ?? false,
            isDeferrable: t.isDeferrable ?? false,
            isAmortising: isClassX,
            amortisationPerPeriod: isClassX ? classXAmortPerQuarter : null,
          };
        });
    }
    return buildTranchesFromConstraints(constraints);
  }, [tranches, trancheSnapshots, constraints]);

  // Resolve a single class letter (e.g. "B", "D-RR") to a tranche seniority rank
  function resolveOneClass(cls: string): number {
    // Strip "-RR" suffix for matching (e.g. "D-RR" → match "Class D" or "D")
    const base = cls.replace(/-RR$/i, "");
    // 1. Exact match
    const exact = trancheInputs.find((t) => t.className === cls || t.className === base);
    if (exact) return exact.seniorityRank;
    // 2. Prefix match: "B" matches "Class B", "Class B-1", "B-2", etc.
    const prefixMatches = trancheInputs.filter(
      (t) =>
        t.className.startsWith(`Class ${base}`) ||
        t.className.startsWith(`${base}-`) ||
        t.className.toUpperCase() === `CLASS ${base.toUpperCase()}`
    );
    if (prefixMatches.length > 0) {
      // Use most senior rank (lowest number) — debt sum naturally includes all via rank filter
      return Math.min(...prefixMatches.map((t) => t.seniorityRank));
    }
    return 0; // unmapped
  }

  // Resolve trigger class names → tranche seniority ranks
  // Handles compound classes like "A/B" (split on /, use most junior = highest rank)
  function resolveRank(triggerClass: string): number {
    const parts = triggerClass.split("/");
    const ranks = parts.map(resolveOneClass).filter((r) => r > 0);
    if (ranks.length === 0) return 0; // unmapped
    // For compound "A/B", the OC test protects at-and-above the most junior class
    return Math.max(...ranks);
  }

  const ocTriggers = useMemo(
    () => ocTriggersRaw.map((oc) => ({ ...oc, rank: resolveRank(oc.className) })),
    [ocTriggersRaw, trancheInputs]
  );
  const icTriggers = useMemo(
    () => icTriggersRaw.map((ic) => ({ ...ic, rank: resolveRank(ic.className) })),
    [icTriggersRaw, trancheInputs]
  );
  const unmappedOc = ocTriggers.filter((oc) => oc.rank === 0);
  const unmappedIc = icTriggers.filter((ic) => ic.rank === 0);

  const [defaultRates, setDefaultRates] = useState<Record<string, number>>({ ...DEFAULT_RATES_BY_RATING });
  const [cprPct, setCprPct] = useState(15);
  const [recoveryPct, setRecoveryPct] = useState(60);
  const [recoveryLagMonths, setRecoveryLagMonths] = useState(12);
  const [reinvestmentSpreadBps, setReinvestmentSpreadBps] = useState(350);
  const [reinvestmentTenorYears, setReinvestmentTenorYears] = useState(5);
  const [reinvestmentRating, setReinvestmentRating] = useState<string>("auto");
  const [baseRatePct, setBaseRatePct] = useState(4.5);
  const [seniorFeePct, setSeniorFeePct] = useState(0.45);
  const [subFeePct, setSubFeePct] = useState(0.20);
  const [cccBucketLimitPct, setCccBucketLimitPct] = useState(7.5);
  const [cccMarketValuePct, setCccMarketValuePct] = useState(70);
  const [showCashFlows, setShowCashFlows] = useState(false);

  const loanInputs: LoanInput[] = useMemo(() => {
    const fallbackMaturity = maturityDate ?? addQuarters(new Date().toISOString().slice(0, 10), 40);
    return holdings
      .filter((h) => h.parBalance && h.parBalance > 0 && !h.isDefaulted)
      .map((h) => ({
        parBalance: h.parBalance!,
        maturityDate: h.maturityDate ?? fallbackMaturity,
        ratingBucket: mapToRatingBucket(h.moodysRating ?? null, h.spRating ?? null, h.fitchRating ?? null, h.compositeRating ?? null),
        spreadBps: h.spreadBps ?? (poolSummary?.wacSpread ? (poolSummary.wacSpread < 20 ? poolSummary.wacSpread * 100 : poolSummary.wacSpread) : 0),
      }));
  }, [holdings, maturityDate, poolSummary]);

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
    () => ({
      initialPar: poolSummary?.totalPar ?? 0,
      wacSpreadBps: (() => {
        const was = poolSummary?.wacSpread ?? 0;
        return was < 20 ? was * 100 : was;
      })(),
      baseRatePct,
      seniorFeePct,
      subFeePct,
      tranches: trancheInputs,
      ocTriggers,
      icTriggers,
      reinvestmentPeriodEnd,
      maturityDate,
      currentDate: new Date().toISOString().slice(0, 10),
      loans: loanInputs,
      defaultRatesByRating: defaultRates,
      cprPct,
      recoveryPct,
      recoveryLagMonths,
      reinvestmentSpreadBps,
      reinvestmentTenorQuarters: reinvestmentTenorYears * 4,
      reinvestmentRating: reinvestmentRating === "auto" ? null : reinvestmentRating,
      cccBucketLimitPct,
      cccMarketValuePct,
      deferredInterestCompounds: constraints.interestMechanics?.deferredInterestCompounds ?? true,
    }),
    [
      poolSummary, baseRatePct, seniorFeePct, subFeePct, trancheInputs, ocTriggers, icTriggers,
      maturityDate, reinvestmentPeriodEnd, loanInputs, defaultRates, cprPct, recoveryPct, recoveryLagMonths,
      reinvestmentSpreadBps, reinvestmentTenorYears, reinvestmentRating, cccBucketLimitPct, cccMarketValuePct,
      constraints.interestMechanics?.deferredInterestCompounds,
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
          <SliderInput label="Base Rate (SOFR)" value={baseRatePct} onChange={setBaseRatePct} min={0} max={8} step={0.25} suffix="%" />
          <SliderInput label="Senior Fee Rate" value={seniorFeePct} onChange={setSeniorFeePct} min={0} max={1} step={0.05} suffix="%" />
          <SliderInput label="Sub Mgmt Fee" value={subFeePct} onChange={setSubFeePct} min={0} max={0.5} step={0.05} suffix="%" />
          <SliderInput label="CCC Bucket Limit" value={cccBucketLimitPct} onChange={setCccBucketLimitPct} min={0} max={15} step={0.5} suffix="%" />
          <SliderInput label="CCC Mkt Value" value={cccMarketValuePct} onChange={setCccMarketValuePct} min={0} max={100} step={5} suffix="%" />
        </div>
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
                  overflowY: "auto",
                  maxHeight: "520px",
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
                    <tr style={{ borderBottom: "2px solid var(--color-border)", textAlign: "right", background: "var(--color-surface)", position: "sticky", top: 0, zIndex: 1 }}>
                      <th style={{ padding: "0.5rem 0.6rem", textAlign: "left", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Date</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Beg Par</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Defaults</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Prepays</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Maturities</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Recoveries</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Reinvest</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>End Par</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Beg Liab</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>End Liab</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Interest</th>
                      <th style={{ padding: "0.5rem 0.6rem", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)" }}>Equity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.periods.map((p) => (
                      <tr key={p.periodNum} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                        <td style={{ padding: "0.45rem 0.6rem", fontWeight: 500, fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatDate(p.date)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.beginningPar)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: p.defaults > 0 ? "var(--color-low)" : undefined }}>
                          {formatAmount(p.defaults)}
                        </td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.prepayments)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.scheduledMaturities)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.recoveries)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.reinvestment)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.endingPar)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.beginningLiabilities)}</td>
                        <td style={{ padding: "0.45rem 0.6rem", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>{formatAmount(p.endingLiabilities)}</td>
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

function DisclosureItem({ label, detail }: { label: string; detail: string }) {
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
          width: "0.35rem",
          height: "0.35rem",
          marginTop: "0.35rem",
          borderRadius: "50%",
          background: "var(--color-text-muted)",
        }}
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
          fontSize: "0.75rem",
          color: "var(--color-text-muted)",
          textAlign: "left",
          fontFamily: "var(--font-body)",
        }}
      >
        <span style={{ fontSize: "0.65rem" }}>{open ? "▾" : "▸"}</span>
        How This Model Works
      </button>
      {open && (
        <div style={{ padding: "0 0.8rem 0.8rem" }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.5rem", paddingTop: "0.25rem" }}>
            Waterfall Mechanics
          </div>
          {WATERFALL_MECHANICS.map((a) => (
            <DisclosureItem key={a.label} label={a.label} detail={a.detail} />
          ))}
          <div style={{ fontSize: "0.68rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginTop: "1rem", marginBottom: "0.5rem" }}>
            Model Simplifications
          </div>
          {MODEL_SIMPLIFICATIONS.map((a) => (
            <DisclosureItem key={a.label} label={a.label} detail={a.detail} />
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
