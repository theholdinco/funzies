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
  EquityInceptionData,
  CloWaterfallStep,
  CloAccountBalance,
  CloTrade,
} from "@/lib/clo/types";
import {
  calibrateReinvestmentFromTrades,
  type ReinvestmentCalibration,
} from "@/lib/clo/reinvestment-calibration";
import { buildBacktestInputs } from "@/lib/clo/backtest-types";
import HarnessPanel from "./HarnessPanel";
import {
  runProjection,
  validateInputs,
  type ProjectionInputs,
  type ProjectionResult,
  type LoanInput,
} from "@/lib/clo/projection";
import {
  computeInceptionIrr,
  computeFairValuesAtHurdles,
  type FairValueResult,
  sweepEntryPrice,
  type EntryPriceSweepPoint,
  callSensitivityGrid,
  type CallSensitivityCell,
  deriveNoCallBaseInputs,
  applyOptionalRedemptionCall,
} from "@/lib/clo/services";
import type { ResolvedDealData, ResolutionWarning } from "@/lib/clo/resolver-types";
import { buildFromResolved, DEFAULT_ASSUMPTIONS, EMPTY_RESOLVED, defaultsFromResolved, defaultsFromIntex, diagnoseFeePrefill } from "@/lib/clo/build-projection-inputs";
import type { IntexAssumptions } from "@/lib/clo/intex/parse-past-cashflows";
import { DEFAULT_RATES_BY_RATING, RATING_BUCKETS, type RatingBucket, warfFactorToAnnualCDRPct } from "@/lib/clo/rating-mapping";
import { BUCKET_WARF_FALLBACK } from "@/lib/clo/pool-metrics";
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
import { formatCallDate, type IrrCellValue } from "./comparison-encoding";

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
  equityInceptionData?: EquityInceptionData | null;
  // T4 — Intex DealCF-MV+ scenario inputs (CPR/CDR/Recovery/etc). When
  // present, overlays defaultsFromResolved + trade-calibration so engine
  // projection runs on the same scenario as Intex's published distributions.
  intexAssumptions?: IntexAssumptions | null;
  // T3 — Historical sub-note distributions (Intex via clo_tranche_snapshots).
  // Replaces equityInceptionData.payments as the cashflow source for the
  // since-inception IRR; the blob held stale partial values, while these
  // tie to Intex past distributions to the cent.
  extractedDistributions?: Array<{ date: string; distribution: number }>;
  /** T3 — Deal closing/issue date. Used as the default IRR anchor when the
   *  user hasn't explicitly entered a purchaseDate. */
  closingDate?: string | null;
  // N1 harness inputs — realized trustee data for the latest period
  waterfallSteps?: CloWaterfallStep[];
  accountBalances?: CloAccountBalance[];
  trades?: CloTrade[];
  reportDate?: string | null;
  paymentDate?: string | null;
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
  equityInceptionData,
  intexAssumptions,
  extractedDistributions,
  closingDate,
  waterfallSteps,
  accountBalances,
  trades,
  reportDate,
  paymentDate,
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
  // D2b — Buckets whose slider the user has touched. The engine treats these
  // as bucket-rate overrides of per-position WARF; untouched buckets keep
  // per-position WARF. Slider seeds from per-position WARF (see effect below)
  // so what's shown matches what the engine uses until the user drags.
  const [overriddenBuckets, setOverriddenBuckets] = useState<Set<string>>(new Set());
  const defaultRatesSeeded = useRef(false);
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
  const [taxesBps, setTaxesBps] = useState<number>(0);
  const [issuerProfitAmount, setIssuerProfitAmount] = useState<number>(0);
  const [trusteeFeeBps, setTrusteeFeeBps] = useState<number>(initFees?.trusteeFeeBps ?? CLO_DEFAULTS.trusteeFeeBps);
  const [adminFeeBps, setAdminFeeBps] = useState<number>(0);
  const [seniorExpensesCapBps, setSeniorExpensesCapBps] = useState<number>(20);
  const [hedgeCostBps, setHedgeCostBps] = useState<number>(CLO_DEFAULTS.hedgeCostBps);
  const [incentiveFeePct, setIncentiveFeePct] = useState<number>(initFees?.incentiveFeePct ?? CLO_DEFAULTS.incentiveFeePct);
  const [incentiveFeeHurdleIrr, setIncentiveFeeHurdleIrr] = useState<number>(
    initFees?.incentiveFeeHurdleIrr ? initFees.incentiveFeeHurdleIrr * 100 : CLO_DEFAULTS.incentiveFeeHurdleIrr
  );
  const [postRpReinvestmentPct, setPostRpReinvestmentPct] = useState<number>(CLO_DEFAULTS.postRpReinvestmentPct);
  const [callMode, setCallMode] = useState<"none" | "optionalRedemption">("none");
  const [callDate, setCallDate] = useState<string | null>(null);
  const [callPricePct, setCallPricePct] = useState<number>(100);
  const [callPriceMode, setCallPriceMode] = useState<"par" | "market" | "manual">("par");
  const [ddtlDrawAssumption, setDdtlDrawAssumption] = useState<'draw_at_deadline' | 'never_draw' | 'custom_quarter'>('draw_at_deadline');
  const [ddtlDrawQuarter, setDdtlDrawQuarter] = useState<number>(CLO_DEFAULTS.ddtlDrawQuarter);
  const [ddtlDrawPercent, setDdtlDrawPercent] = useState<number>(CLO_DEFAULTS.ddtlDrawPercent);
  const [equityEntryPriceCents, setEquityEntryPriceCents] = useState<number | null>(null); // null = use book value
  // Forward IRR anchor: which price anchors the projected return. Default
  // is "book" (today's mark-to-book). Other options surface only when the
  // underlying data is available (cost basis from PPM/EquityInceptionData;
  // custom from the entry-price input).
  const [forwardAnchor, setForwardAnchor] = useState<"book" | "cost" | "custom">("book");
  // User-overridable call date for the with-call comparison. `null` means
  // "use the engine-derived default" (max(NCP, currentDate)). Empty string
  // means "no call" — collapse to single column.
  const [userCallDate, setUserCallDate] = useState<string | null>(null);
  // Post-v6 plan §9 #5 / option (d): there is no toggle. When the deal has
  // an extracted `nonCallPeriodEnd`, the no-call/with-call comparison is
  // displayed side-by-side wherever call-mode matters (Forward IRR rows,
  // Fair Value rows, mark-to-model row, entry-price-sweep). When
  // `nonCallPeriodEnd` is null, only the no-call column renders. The user's
  // FeeAssumptions slider drives the per-period waterfall trace below the
  // hero card; the IRR-derived rows above are always anchored to the
  // canonical no-call / with-call-at-ord-par pair regardless of slider.
  // Post-v6 plan §5.4: expandable "Sensitivities" section below the equity
  // card. Default closed — partner reads the headline IRR triple first;
  // expands when they want the curve / call-grid.
  const [showSensitivities, setShowSensitivities] = useState(false);
  const [showTransparency, setShowTransparency] = useState(false);
  const [expandedPeriod, setExpandedPeriod] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"projection" | "switch">(urlTab === "switch" ? "switch" : "projection");

  // Pre-fill sliders from `defaultsFromResolved` — single source of truth for
  // the D3 pre-fill family (baseRate + fees). Only fires once per deal load so
  // it doesn't stomp subsequent user edits. Also pre-fills trusteeFeeBps via
  // the back-derive from Q1 waterfall when the PPM says "per agreement".
  // `diagnoseFeePrefill` produces partner-visible warnings when the pre-fill
  // data source is incomplete (e.g., step C missing → adminFeeBps silently 0).
  const [prefillWarnings, setPrefillWarnings] = useState<ResolutionWarning[]>([]);
  // D6c — reinvestment-calibration result from manager BUY trades. Null when
  // fewer than MIN_TRADES BUYs exist (partner sees generic defaults) or when
  // BUYs can't be enriched from holdings. Displayed as a status line below
  // the reinvestment sliders for attribution.
  const [reinvestmentCalibration, setReinvestmentCalibration] =
    useState<ReinvestmentCalibration | null>(null);
  // T4 — record when Intex assumptions overlaid the pre-fill so the UI can
  // display "Defaults from Intex (Apr 20 2026 export)" alongside the sliders
  // and drive the bearish/matching/aggressive comparison badge.
  const [intexPrefillSource, setIntexPrefillSource] = useState<{ scenario: string | null; ratesAsOf: string | null } | null>(null);
  const feesInitialized = useRef(false);
  React.useEffect(() => {
    if (!resolved || feesInitialized.current) return;
    feesInitialized.current = true;
    const raw = { trancheSnapshots, waterfallSteps };
    const d = defaultsFromResolved(resolved, raw);
    setBaseRatePct(d.baseRatePct);
    setSeniorFeePct(d.seniorFeePct);
    setSubFeePct(d.subFeePct);
    setTaxesBps(d.taxesBps);
    setIssuerProfitAmount(d.issuerProfitAmount);
    setTrusteeFeeBps(d.trusteeFeeBps);
    setAdminFeeBps(d.adminFeeBps);
    setSeniorExpensesCapBps(d.seniorExpensesCapBps);
    setIncentiveFeePct(d.incentiveFeePct);
    setIncentiveFeeHurdleIrr(d.incentiveFeeHurdleIrr);
    setPrefillWarnings(diagnoseFeePrefill(resolved, raw, d));
    if (resolved.dates.nonCallPeriodEnd) setCallDate(null);

    // D6c reinvestment-calibration pre-fill: when the manager has ≥3 BUY
    // trades we can join to holdings, pre-fill the reinvestment sliders
    // with the par-weighted observed values. Gated on the same once-per-load
    // semantic (feesInitialized) so user edits aren't stomped.
    const cal = calibrateReinvestmentFromTrades(
      trades,
      holdings,
      resolved.dates.currentDate,
    );
    if (cal) {
      setReinvestmentCalibration(cal);
      setReinvestmentSpreadBps(cal.reinvestmentSpreadBps);
      setReinvestmentTenorYears(cal.reinvestmentTenorYears);
      setReinvestmentRating(cal.reinvestmentRating);
    }

    // T4 — Intex DealCF-MV+ overlay. Highest precedence for the fields it
    // covers (CPR/CDR/Recovery/recovery-lag/reinvestment spread+tenor) so
    // engine projection runs on Intex's exact scenario inputs and downstream
    // distributions are comparable line-by-line.
    if (intexAssumptions) {
      const overlay = defaultsFromIntex(d, intexAssumptions);
      setCprPct(overlay.cprPct);
      setRecoveryPct(overlay.recoveryPct);
      setRecoveryLagMonths(overlay.recoveryLagMonths);
      setReinvestmentSpreadBps(overlay.reinvestmentSpreadBps);
      setReinvestmentTenorYears(overlay.reinvestmentTenorYears);
      // CDR is broadcast flat to every rating bucket; flat-set defaultRates.
      if (intexAssumptions.cdrPct != null) {
        setDefaultRates(overlay.defaultRates);
      }
      setIntexPrefillSource({
        scenario: intexAssumptions.scenario,
        ratesAsOf: intexAssumptions.ratesAsOf,
      });
    }
  }, [resolved, trancheSnapshots, waterfallSteps, trades, holdings, intexAssumptions]);

  // Auto-fill from inception cost basis was removed in post-v6 plan §3.1 — it
  // conflated "what I paid in 2024" with "today's hypothetical entry price",
  // which is the failure pattern the three-row Forward IRR triple replaces.
  // Cost basis is now displayed as its own row in the Forward IRR card; the
  // slider's role is reduced to a what-if input that drives a separate
  // @ custom row.

  const loanInputs: LoanInput[] = resolved?.loans ?? [];

  // D2b — Seed the per-bucket CDR sliders from per-position WARF (par-weighted
  // per bucket) so the UI shows the rate the engine is actually applying.
  // Fires once per deal load; if the user has already touched any slider the
  // seeded value for that bucket is replaced on next touch anyway. When no
  // WARF factors are present (early render), fall back to DEFAULT_RATES_BY_RATING.
  React.useEffect(() => {
    if (defaultRatesSeeded.current) return;
    if (loanInputs.length === 0) return;
    // T4 — when Intex assumptions broadcast a flat CDR to every bucket, the
    // earlier feesInitialized effect already set defaultRates to the Intex
    // value. Don't stomp it with WARF-seeded per-bucket rates: the Intex
    // overlay is the higher-precedence source for those fields, and stomping
    // would silently desync the displayed "Defaults from Intex" badge from
    // the actual rates applied. User can still touch any slider to override.
    if (intexAssumptions?.cdrPct != null) {
      defaultRatesSeeded.current = true;
      return;
    }
    const parByBucket: Record<string, number> = {};
    const warfSumByBucket: Record<string, number> = {};
    for (const bucket of RATING_BUCKETS) {
      parByBucket[bucket] = 0;
      warfSumByBucket[bucket] = 0;
    }
    for (const loan of loanInputs) {
      const b = loan.ratingBucket;
      if (!(b in parByBucket)) continue;
      const wf = loan.warfFactor ?? BUCKET_WARF_FALLBACK[b] ?? 0;
      parByBucket[b] += loan.parBalance;
      warfSumByBucket[b] += loan.parBalance * wf;
    }
    const seeded: Record<string, number> = {};
    for (const bucket of RATING_BUCKETS) {
      if (parByBucket[bucket] > 0) {
        const avgWf = warfSumByBucket[bucket] / parByBucket[bucket];
        seeded[bucket] = warfFactorToAnnualCDRPct(avgWf);
      } else {
        seeded[bucket] = DEFAULT_RATES_BY_RATING[bucket];
      }
    }
    setDefaultRates(seeded);
    defaultRatesSeeded.current = true;
  }, [loanInputs, intexAssumptions]);

  // Slider change handler — updates the rates AND marks every bucket whose
  // value actually changed as overridden (so the engine consumes the slider
  // instead of per-position WARF for that bucket).
  const handleDefaultRatesChange = React.useCallback((next: Record<string, number>) => {
    setDefaultRates((prev) => {
      setOverriddenBuckets((prevOverrides) => {
        const updated = new Set(prevOverrides);
        for (const bucket of RATING_BUCKETS) {
          const p = prev[bucket] ?? 0;
          const n = next[bucket] ?? 0;
          if (Math.abs(p - n) > 1e-9) updated.add(bucket);
        }
        return updated;
      });
      return next;
    });
  }, []);

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

  const portfolioInfo = useMemo(() => {
    const loans = resolved?.loans ?? [];
    const fixedRateLoans = loans.filter(l => l.isFixedRate);
    const ddtlLoans = loans.filter(l => l.isDelayedDraw);
    const totalPar = loans.reduce((s, l) => s + l.parBalance, 0);
    return {
      fixedRateCount: fixedRateLoans.length,
      fixedRatePar: fixedRateLoans.reduce((s, l) => s + l.parBalance, 0),
      fixedRatePct: totalPar > 0 ? fixedRateLoans.reduce((s, l) => s + l.parBalance, 0) / totalPar * 100 : 0,
      ddtlCount: ddtlLoans.length,
      ddtlPar: ddtlLoans.reduce((s, l) => s + l.parBalance, 0),
      hasDdtls: ddtlLoans.length > 0,
      hasFixedRate: fixedRateLoans.length > 0,
    };
  }, [resolved?.loans]);

  const inputs: ProjectionInputs = useMemo(
    () => {
      const resolvedData = resolved ?? EMPTY_RESOLVED;
      return buildFromResolved(resolvedData, {
        baseRatePct,
        baseRateFloorPct,
        defaultRates: defaultRates,
        overriddenBuckets: Array.from(overriddenBuckets),
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
        callMode,
        callDate,
        callPricePct,
        callPriceMode,
        seniorFeePct,
        subFeePct,
        taxesBps,
        issuerProfitAmount,
        trusteeFeeBps,
        adminFeeBps,
        seniorExpensesCapBps,
        incentiveFeePct,
        incentiveFeeHurdleIrr,
        ddtlDrawAssumption,
        ddtlDrawQuarter,
        ddtlDrawPercent,
        equityEntryPriceCents,
      });
    },
    [
      resolved, baseRatePct, baseRateFloorPct, defaultRates, overriddenBuckets, cprPct, recoveryPct, recoveryLagMonths,
      reinvestmentSpreadBps, reinvestmentTenorYears, reinvestmentRating, cccBucketLimitPct, cccMarketValuePct,
      resolved?.deferredInterestCompounds,
      seniorFeePct, subFeePct, trusteeFeeBps, hedgeCostBps, incentiveFeePct, incentiveFeeHurdleIrr, postRpReinvestmentPct,
      callMode, callDate, callPricePct, callPriceMode, ddtlDrawAssumption, ddtlDrawQuarter, ddtlDrawPercent, equityEntryPriceCents,
    ]
  );

  // Legit-pinned inputs for HarnessPanel's engine-math mode. Mirrors
  // n1-correctness.test.ts: DEFAULT_ASSUMPTIONS + observed EURIBOR + PPM fees
  // from resolved.fees. trusteeFeeBps intentionally NOT pinned (circular).
  const engineMathInputs: ProjectionInputs | undefined = useMemo(() => {
    if (!resolved) return undefined;
    const observedBaseRate = trancheSnapshots.find(s => s && s.currentIndexRate != null)?.currentIndexRate;
    if (observedBaseRate == null) return undefined;
    return buildFromResolved(resolved, {
      ...DEFAULT_ASSUMPTIONS,
      baseRatePct: observedBaseRate,
      seniorFeePct: resolved.fees.seniorFeePct,
      subFeePct: resolved.fees.subFeePct,
      incentiveFeePct: resolved.fees.incentiveFeePct,
      incentiveFeeHurdleIrr: resolved.fees.incentiveFeeHurdleIrr * 100,
    });
  }, [resolved, trancheSnapshots]);

  const userAssumptions: UserAssumptions = useMemo(() => ({
    baseRatePct,
    baseRateFloorPct,
    defaultRates: defaultRates,
    overriddenBuckets: Array.from(overriddenBuckets),
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
    callMode,
    callDate,
    callPricePct,
    callPriceMode,
    seniorFeePct,
    subFeePct,
    taxesBps,
    issuerProfitAmount,
    trusteeFeeBps,
    adminFeeBps,
    seniorExpensesCapBps,
    incentiveFeePct,
    incentiveFeeHurdleIrr,
    ddtlDrawAssumption,
    ddtlDrawQuarter,
    ddtlDrawPercent,
    equityEntryPriceCents,
  }), [
    baseRatePct, baseRateFloorPct, defaultRates, overriddenBuckets, cprPct, recoveryPct, recoveryLagMonths,
    reinvestmentSpreadBps, reinvestmentTenorYears, reinvestmentRating, cccBucketLimitPct, cccMarketValuePct,
    resolved?.deferredInterestCompounds,
    postRpReinvestmentPct, hedgeCostBps, callDate, callPricePct, callPriceMode, seniorFeePct, subFeePct, trusteeFeeBps, incentiveFeePct, incentiveFeeHurdleIrr,
    ddtlDrawAssumption, ddtlDrawQuarter, ddtlDrawPercent, equityEntryPriceCents,
  ]);

  const validationErrors = useMemo(() => validateInputs(inputs), [inputs]);
  const result: ProjectionResult | null = useMemo(
    () => (validationErrors.length === 0 ? runProjection(inputs) : null),
    [inputs, validationErrors]
  );

  // Equity metrics — single canonical source.
  // bookValue + wipedOut come from engine output (result.initialState);
  // subNotePar is a presentation lookup against resolved.tranches (no
  // arithmetic on resolved fields). Phase-6 AST rule forbids re-deriving
  // bookValue locally; engine is the source of truth.
  // See CLAUDE.md § Engine ↔ UI separation.
  const equityMetrics = useMemo(() => {
    if (!resolved || !result) return null;
    const subTranche = resolved.tranches.find((t) => t.isIncomeNote);
    const subNotePar = subTranche?.originalBalance ?? subTranche?.currentBalance ?? 0;
    const bookValue = result.initialState.equityBookValue;
    const bookValueCents = subNotePar > 0 ? (bookValue / subNotePar) * 100 : 0;
    return {
      subNotePar,
      bookValue,
      bookValueCents,
      wipedOut: result.initialState.equityWipedOut,
    };
  }, [resolved, result]);

  // Post-v6 plan §9 #11 + option (d): canonical no-call baseline and
  // with-call overlay are derived once via the centralized helper
  // (lib/clo/services/no-call-baseline.ts). All call-mode-dependent
  // displays read from these baselines; no consumer reaches into `inputs`
  // directly for an "ostensibly no-call" run. See decision-log entry S
  // (callMode pinning) and the helper's docstring for the rationale.
  const noCallBaseInputs = useMemo<ProjectionInputs | null>(() => {
    if (!inputs) return null;
    return deriveNoCallBaseInputs(inputs as ProjectionInputs & { equityEntryPrice?: number });
  }, [inputs]);

  // Effective with-call date: user override > engine default. The engine
  // default is max(NCP, currentDate) — the EARLIEST legal call from
  // currentDate forward. For older deals where NCP has already passed,
  // using the literal NCP date produces nonsensical IRRs ("called at par
  // three years ago"); flooring to currentDate answers the partner-
  // relevant question "what if the manager calls today?".
  //
  // `userCallDate === null` → use engine default. `userCallDate === ""` →
  // no call (with-call comparison disabled). Any other string → use that
  // date verbatim.
  const withCallDate = useMemo<string | null>(() => {
    if (userCallDate === "") return null;
    if (userCallDate != null) return userCallDate;
    const ncEnd = resolved?.dates.nonCallPeriodEnd ?? null;
    const currentDate = resolved?.dates.currentDate ?? null;
    if (!ncEnd || !currentDate) return null;
    return ncEnd > currentDate ? ncEnd : currentDate;
  }, [resolved?.dates.nonCallPeriodEnd, resolved?.dates.currentDate, userCallDate]);

  const withCallBaseInputs = useMemo<ProjectionInputs | null>(() => {
    if (!noCallBaseInputs || !withCallDate) return null;
    return applyOptionalRedemptionCall(noCallBaseInputs, withCallDate);
  }, [noCallBaseInputs, withCallDate]);

  // Fair value @ hurdle — computed under both no-call and with-call so the
  // partner sees both anchor prices (option (d): two columns wherever
  // call-mode matters, no toggle).
  const fairValues = useMemo<FairValueResult[] | null>(() => {
    if (!noCallBaseInputs || !equityMetrics || equityMetrics.wipedOut || equityMetrics.subNotePar <= 0) {
      return null;
    }
    return computeFairValuesAtHurdles(noCallBaseInputs, equityMetrics.subNotePar, [0.10, 0.15]);
  }, [noCallBaseInputs, equityMetrics]);

  const fairValuesWithCall = useMemo<FairValueResult[] | null>(() => {
    if (!withCallBaseInputs || !equityMetrics || equityMetrics.wipedOut || equityMetrics.subNotePar <= 0) {
      return null;
    }
    return computeFairValuesAtHurdles(withCallBaseInputs, equityMetrics.subNotePar, [0.10, 0.15]);
  }, [withCallBaseInputs, equityMetrics]);

  // Forward IRR triple: cost basis / book / fair-value-10%. Two columns
  // when nonCallPeriodEnd is extracted; no-call only otherwise. The
  // structure unifies the prior `forwardIrrTriple` + `forwardIrrTripleWithCall`
  // into a single per-row pair so consumers iterate once.
  // Mark-to-model forward distributions for the inception IRR.
  // `noCallResult` is the no-call projection used as the canonical
  // mark-to-model forward stream; `withCallResult` was previously used
  // for a with-call mark-to-model variant in the inception card but the
  // call-mode comparison now lives in the Forward IRR card alone, so
  // only the no-call variant is consumed here. (Kept as a hook to
  // preserve `inceptionIrrWithCall` wiring; can be removed when that
  // memo is dropped in a follow-up.)
  const noCallResult = useMemo<ProjectionResult | null>(() => {
    if (!noCallBaseInputs) return null;
    return runProjection(noCallBaseInputs);
  }, [noCallBaseInputs]);

  const withCallResult = useMemo<ProjectionResult | null>(() => {
    if (!withCallBaseInputs) return null;
    return runProjection(withCallBaseInputs);
  }, [withCallBaseInputs]);

  // Forward IRR — single-anchor view. The user picks the anchor from a
  // dropdown ("book", "cost", "custom"); the engine produces one no-call
  // IRR and (optionally) one with-call IRR for that anchor. Replaces the
  // prior multi-row layout that displayed all three anchors stacked
  // simultaneously, which the partner found dense and unhelpful.
  const anchorOptions = useMemo<Array<{ id: "book" | "cost" | "custom"; label: string; cents: number | null }>>(() => {
    const options: Array<{ id: "book" | "cost" | "custom"; label: string; cents: number | null }> = [];
    if (equityMetrics?.bookValueCents != null && !equityMetrics.wipedOut) {
      options.push({ id: "book", label: "Book", cents: Math.round(equityMetrics.bookValueCents) });
    }
    if (
      equityInceptionData?.purchasePriceCents != null &&
      equityInceptionData.purchasePriceCents > 0
    ) {
      options.push({ id: "cost", label: "Cost basis", cents: equityInceptionData.purchasePriceCents });
    }
    if (equityEntryPriceCents != null) {
      options.push({ id: "custom", label: "Custom", cents: equityEntryPriceCents });
    }
    return options;
  }, [equityMetrics, equityInceptionData, equityEntryPriceCents]);

  // The selected anchor falls back to "book" when the chosen option
  // isn't available (e.g., user picks "custom" and then clears the
  // custom-price input). Stable in render — never returns null when at
  // least book is available.
  const effectiveAnchor = useMemo<"book" | "cost" | "custom">(() => {
    if (anchorOptions.find((o) => o.id === forwardAnchor)) return forwardAnchor;
    return anchorOptions[0]?.id ?? "book";
  }, [anchorOptions, forwardAnchor]);

  const selectedAnchorIrr = useMemo<{ cents: number; noCall: number | null; withCall: number | null | undefined } | null>(() => {
    if (!noCallBaseInputs || !equityMetrics || equityMetrics.wipedOut) return null;
    const opt = anchorOptions.find((o) => o.id === effectiveAnchor);
    if (!opt || opt.cents == null) return null;
    const ep = equityMetrics.subNotePar * (opt.cents / 100);
    const noCall = runProjection({ ...noCallBaseInputs, equityEntryPrice: ep }).equityIrr;
    const withCall = withCallBaseInputs
      ? runProjection({ ...withCallBaseInputs, equityEntryPrice: ep }).equityIrr
      : undefined;
    return { cents: opt.cents, noCall, withCall };
  }, [noCallBaseInputs, withCallBaseInputs, equityMetrics, anchorOptions, effectiveAnchor]);

  // Post-v6 plan §5.1 / §5.4: entry-price-vs-IRR sweep. Two columns
  // (no-call IRR / with-call IRR per price point) per option (d) — the
  // sweep is a Forward IRR derivation, so it gets the same side-by-side
  // treatment as the hero card. Lazy: only computes when expanded.
  const entryPriceSweep = useMemo<{
    noCall: EntryPriceSweepPoint[];
    withCall: EntryPriceSweepPoint[] | null;
  } | null>(() => {
    if (!showSensitivities || !noCallBaseInputs || !equityMetrics || equityMetrics.wipedOut || equityMetrics.subNotePar <= 0) {
      return null;
    }
    const prices = [25, 35, 45, 55, 65, 75, 85, 95];
    const noCall = sweepEntryPrice(noCallBaseInputs, prices, equityMetrics.subNotePar);
    const withCall = withCallBaseInputs
      ? sweepEntryPrice(withCallBaseInputs, prices, equityMetrics.subNotePar)
      : null;
    return { noCall, withCall };
  }, [showSensitivities, noCallBaseInputs, withCallBaseInputs, equityMetrics]);

  // Post-v6 plan §5.3 / §5.4: call-sensitivity grid (4 dates × 2 modes).
  // The grid varies callMode along the date axis — call-mode IS the sweep
  // dimension here, so the side-by-side framing of (d) doesn't apply.
  // Built off no-call baseline so the grid's cells reflect the deal's
  // canonical state, not the user's slider.
  const callGrid = useMemo<CallSensitivityCell[] | null>(() => {
    if (!showSensitivities || !noCallBaseInputs || !equityMetrics || equityMetrics.wipedOut) return null;
    const ord = resolved?.dates.nonCallPeriodEnd ?? null;
    if (!ord) return null;
    return callSensitivityGrid(noCallBaseInputs, { optionalRedemptionDate: ord });
  }, [showSensitivities, noCallBaseInputs, equityMetrics, resolved?.dates.nonCallPeriodEnd]);

  /**
   * T3 — Since-inception IRR for the sub note position.
   * Composition delegated to the service layer
   * (web/lib/clo/services/inception-irr.ts). Pure function; downstream
   * surfaces (PDF export, partner deck, chat) consume identical numbers.
   * See CLAUDE.md § Engine ↔ UI separation.
   */
  const inceptionIrr = useMemo(() => {
    if (!resolved || !equityMetrics) return null;
    return computeInceptionIrr({
      subNotePar: equityMetrics.subNotePar,
      equityBookValue: equityMetrics.bookValue,
      equityWipedOut: equityMetrics.wipedOut,
      closingDate: closingDate ?? null,
      currentDate: resolved.dates.currentDate,
      userAnchor:
        equityInceptionData?.purchaseDate && equityInceptionData?.purchasePriceCents != null
          ? { date: equityInceptionData.purchaseDate, priceCents: equityInceptionData.purchasePriceCents }
          : null,
      historicalDistributions: extractedDistributions ?? [],
      // forwardDistributions feed the canonical no-call mark-to-model IRR.
      forwardDistributions: noCallResult
        ? noCallResult.periods.map((p) => ({ date: p.date, amount: p.equityDistribution }))
        : null,
    });
  }, [equityInceptionData, equityMetrics, resolved, extractedDistributions, closingDate, noCallResult]);

  // Option (d): with-call mark-to-model companion. Same composition,
  // forward distributions sourced from the with-call run instead.
  // Renders as a second column on the mark-to-model row when present.
  const inceptionIrrWithCall = useMemo(() => {
    if (!resolved || !equityMetrics || !withCallResult) return null;
    return computeInceptionIrr({
      subNotePar: equityMetrics.subNotePar,
      equityBookValue: equityMetrics.bookValue,
      equityWipedOut: equityMetrics.wipedOut,
      closingDate: closingDate ?? null,
      currentDate: resolved.dates.currentDate,
      userAnchor:
        equityInceptionData?.purchaseDate && equityInceptionData?.purchasePriceCents != null
          ? { date: equityInceptionData.purchaseDate, priceCents: equityInceptionData.purchasePriceCents }
          : null,
      historicalDistributions: extractedDistributions ?? [],
      forwardDistributions: withCallResult.periods.map((p) => ({
        date: p.date,
        amount: p.equityDistribution,
      })),
    });
  }, [equityInceptionData, equityMetrics, resolved, extractedDistributions, closingDate, withCallResult]);

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
    setOverriddenBuckets(new Set(RATING_BUCKETS));
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
        {reinvestmentCalibration && (
          <div style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", marginTop: "0.75rem", opacity: 0.8 }}>
            Reinvestment sliders calibrated from {reinvestmentCalibration.tradeCount} manager BUY trades
            {reinvestmentCalibration.minTradeDate && reinvestmentCalibration.maxTradeDate
              ? ` (${reinvestmentCalibration.minTradeDate} to ${reinvestmentCalibration.maxTradeDate})`
              : ""}
            .
          </div>
        )}
        {intexPrefillSource && intexAssumptions && (
          <IntexAssumptionStatus
            source={intexPrefillSource}
            intex={intexAssumptions}
            cprPct={cprPct}
            recoveryPct={recoveryPct}
            defaultRates={defaultRates}
            reinvestmentSpreadBps={reinvestmentSpreadBps}
          />
        )}

        {/* Fees & Expenses — collapsible, pre-filled from PPM extraction */}
        <FeeAssumptions
          seniorFeePct={seniorFeePct} onSeniorFeeChange={setSeniorFeePct}
          subFeePct={subFeePct} onSubFeeChange={setSubFeePct}
          trusteeFeeBps={trusteeFeeBps} onTrusteeFeeChange={setTrusteeFeeBps}
          hedgeCostBps={hedgeCostBps} onHedgeCostChange={setHedgeCostBps}
          incentiveFeePct={incentiveFeePct} onIncentiveFeeChange={setIncentiveFeePct}
          incentiveFeeHurdleIrr={incentiveFeeHurdleIrr} onHurdleChange={setIncentiveFeeHurdleIrr}
          hasResolvedFees={!!resolved && (resolved.fees.seniorFeePct > 0 || resolved.fees.subFeePct > 0)}
          feesCitation={resolved?.fees.citation ?? null}
          callMode={callMode} onCallModeChange={setCallMode}
          callDate={callDate} onCallDateChange={setCallDate}
          callPricePct={callPricePct} onCallPriceChange={setCallPricePct}
          callPriceMode={callPriceMode} onCallPriceModeChange={setCallPriceMode}
          portfolioInfo={portfolioInfo}
          ddtlDrawAssumption={ddtlDrawAssumption} onDdtlDrawAssumptionChange={setDdtlDrawAssumption}
          ddtlDrawQuarter={ddtlDrawQuarter} onDdtlDrawQuarterChange={setDdtlDrawQuarter}
          ddtlDrawPercent={ddtlDrawPercent} onDdtlDrawPercentChange={setDdtlDrawPercent}
        />
        <div style={{ marginTop: "1rem" }}>
          <DefaultRatePanel
            defaultRates={defaultRates}
            onChange={handleDefaultRatesChange}
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

      {/* Data-quality warnings: resolver-level (pool, triggers, etc.) +
          fee-prefill gate (admin source missing, etc.). Merged so the
          partner sees a single panel rather than scattered alerts. */}
      {((resolutionWarnings?.length ?? 0) > 0 || prefillWarnings.length > 0) && (
        <div
          style={{
            padding: "0.75rem 1rem",
            border: "1px solid var(--color-warning-border, #e5c07b)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-warning-bg, #fdf6e3)",
            marginBottom: "1rem",
            fontSize: "0.78rem",
            color: "var(--color-warning, #946c00)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
            Data Quality Warnings ({(resolutionWarnings?.length ?? 0) + prefillWarnings.length})
          </div>
          {(resolutionWarnings ?? []).filter((w) => w.severity !== "info").map((w, i) => (
            <div key={`rw-${i}`}>&bull; <strong>{w.field}:</strong> {w.message}</div>
          ))}
          {prefillWarnings.map((w, i) => (
            <div key={`pw-${i}`}>&bull; <strong>{w.field}:</strong> {w.message}</div>
          ))}
        </div>
      )}

      {/* Equity Entry Price */}
      {equityMetrics && equityMetrics.wipedOut && equityMetrics.subNotePar > 0 && (
        <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", border: "1px solid var(--color-low)", borderRadius: "var(--radius-sm)", background: "var(--color-low-bg)", fontSize: "0.75rem", color: "var(--color-low)", lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Equity is balance-sheet insolvent.</div>
          Total debt outstanding exceeds total assets at the projection start date. The equity tranche has no positive cost basis, and IRR is not meaningful for this scenario.
        </div>
      )}
      {equityMetrics && !equityMetrics.wipedOut && equityMetrics.subNotePar > 0 && (
        <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", fontSize: "0.75rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
            <div style={{ color: "var(--color-text-muted)", lineHeight: 1.5 }}>
              <div>
                <span style={{ fontWeight: 600 }}>Equity par:</span> {"\u20AC"}{(equityMetrics.subNotePar / 1e6).toFixed(1)}M
                {" \u00B7 "}
                <span style={{ fontWeight: 600 }}>Book value:</span> {"\u20AC"}{(equityMetrics.bookValue / 1e6).toFixed(1)}M ({equityMetrics.bookValueCents.toFixed(1)} cents)
              </div>
              {fairValues && (
                <div
                  style={{ marginTop: "0.25rem", fontSize: "0.7rem" }}
                  title="Implied fair value under the model's current assumptions. NOT a market quote; transactable price may differ."
                >
                  {fairValues.map((fv, i) => {
                    const hurdleLabel = `${(fv.hurdle * 100).toFixed(0)}%`;
                    const valueLabel = (() => {
                      if (fv.status === "converged" && fv.priceCents != null) {
                        const cents = fv.priceCents;
                        const value = equityMetrics.subNotePar * (cents / 100);
                        return `${cents.toFixed(1)}c (\u20AC${(value / 1e6).toFixed(1)}M)`;
                      }
                      if (fv.status === "below_hurdle") return "deal can\u2019t reach hurdle";
                      if (fv.status === "above_max_bracket") return "exceeds 200c bracket";
                      return "\u2014";
                    })();
                    return (
                      <span key={fv.hurdle}>
                        {i > 0 && " \u00B7 "}
                        <span style={{ fontWeight: 600 }}>Fair Value @ {hurdleLabel} IRR (model):</span> {valueLabel}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <label style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", fontWeight: 500, whiteSpace: "nowrap" }} title="What-if input: drives the @ custom row in the Forward IRR card. Independent of the cost-basis / book / fair-value rows.">Custom entry (what-if):</label>
              <input
                type="number"
                step="0.5"
                min="1"
                max="150"
                value={equityEntryPriceCents ?? equityMetrics.bookValueCents.toFixed(1)}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setEquityEntryPriceCents(isNaN(v) ? null : v);
                }}
                style={{ width: "60px", fontSize: "0.78rem", fontFamily: "var(--font-mono)", padding: "0.2rem 0.4rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)", textAlign: "right" }}
              />
              <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>cents</span>
              {equityEntryPriceCents != null && (
                <button
                  onClick={() => {
                    setEquityEntryPriceCents(null);
                  }}
                  style={{ fontSize: "0.65rem", padding: "0.15rem 0.4rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text-muted)", cursor: "pointer" }}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          {/* Data-quality warning when inception record exists but price is missing —
              the Forward IRR card's cost-basis row is hidden in this state. */}
          {equityInceptionData?.purchaseDate && equityInceptionData.purchasePriceCents == null && (
            <div style={{ marginTop: "0.5rem", padding: "0.4rem 0.6rem", fontSize: "0.68rem", color: "var(--color-low)", background: "var(--color-low-bg)", borderRadius: "var(--radius-sm)", lineHeight: 1.45 }}>
              Inception data exists (purchase date {equityInceptionData.purchaseDate}) but the purchase price is missing — Forward IRR @ cost basis row is hidden. Use the custom entry slider above to model a hypothetical entry price.
            </div>
          )}
          {/* Post-v6 plan §5.4: Sensitivities expandable. Two tables — entry-price
              curve and call-grid — gated on the section being expanded so the
              ~16 extra engine runs don't fire on initial render. Rendered only
              for non-wiped-out deals with positive sub-note par. */}
          {!equityMetrics.wipedOut && equityMetrics.subNotePar > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <button
                onClick={() => setShowSensitivities((s) => !s)}
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 500,
                  padding: "0.35rem 0.7rem",
                  border: "1px solid var(--color-border-light)",
                  borderRadius: "var(--radius-sm)",
                  background: showSensitivities ? "var(--color-surface-hover, var(--color-surface))" : "var(--color-surface)",
                  color: "var(--color-text)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                }}
              >
                <span style={{ fontSize: "0.65rem", color: "var(--color-text-muted)" }}>{showSensitivities ? "▼" : "▶"}</span>
                Sensitivities
                <span style={{ fontSize: "0.62rem", color: "var(--color-text-muted)", fontWeight: 400 }}>
                  (entry price · call grid)
                </span>
              </button>
              {showSensitivities && (
                <div
                  style={{
                    marginTop: "0.6rem",
                    padding: "0.85rem 1rem",
                    border: "1px solid var(--color-border-light)",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--color-surface)",
                    fontSize: "0.72rem",
                  }}
                >
                  {/* Entry-price curve. */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.35rem" }}>
                      <strong style={{ fontSize: "0.78rem" }}>Entry price → Forward IRR</strong>
                      <span style={{ fontSize: "0.62rem", color: "var(--color-text-muted)" }}>
                        (model output, not market quote)
                      </span>
                    </div>
                    {entryPriceSweep ? (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: "left", padding: "0.25rem 0.4rem", fontWeight: 500, fontSize: "0.65rem", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border-light)" }}>
                              Entry price
                            </th>
                            <th style={{ textAlign: "right", padding: "0.25rem 0.4rem", fontWeight: 500, fontSize: "0.65rem", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border-light)" }}>
                              IRR (no-call)
                            </th>
                            {entryPriceSweep.withCall && (
                              <th style={{ textAlign: "right", padding: "0.25rem 0.4rem", fontWeight: 500, fontSize: "0.65rem", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border-light)" }}>
                                IRR (with-call @ {resolved?.dates.nonCallPeriodEnd}, par)
                              </th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {entryPriceSweep.noCall.map((row, i) => {
                            const withCallRow = entryPriceSweep.withCall?.[i];
                            return (
                              <tr key={row.priceCents}>
                                <td style={{ padding: "0.2rem 0.4rem" }}>{row.priceCents}c</td>
                                <td style={{ padding: "0.2rem 0.4rem", textAlign: "right" }}>
                                  {row.irr != null ? formatPct(row.irr * 100) : "—"}
                                </td>
                                {entryPriceSweep.withCall && (
                                  <td style={{ padding: "0.2rem 0.4rem", textAlign: "right" }}>
                                    {withCallRow?.irr != null ? formatPct(withCallRow.irr * 100) : "—"}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ color: "var(--color-text-muted)", fontSize: "0.7rem" }}>—</div>
                    )}
                  </div>
                  {/* Call-sensitivity grid. */}
                  <div style={{ marginTop: "1rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.35rem" }}>
                      <strong style={{ fontSize: "0.78rem" }}>Call date × price mode → Forward IRR</strong>
                      <span style={{ fontSize: "0.62rem", color: "var(--color-text-muted)" }}>
                        (model output, not market quote)
                      </span>
                    </div>
                    {callGrid ? (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: "left", padding: "0.25rem 0.4rem", fontWeight: 500, fontSize: "0.65rem", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border-light)" }}>
                              Call date
                            </th>
                            <th style={{ textAlign: "left", padding: "0.25rem 0.4rem", fontWeight: 500, fontSize: "0.65rem", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border-light)" }}>
                              Price mode
                            </th>
                            <th style={{ textAlign: "right", padding: "0.25rem 0.4rem", fontWeight: 500, fontSize: "0.65rem", color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border-light)" }}>
                              Forward IRR
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {callGrid.map((cell) => (
                            <tr key={`${cell.callDate}-${cell.callPriceMode}`}>
                              <td style={{ padding: "0.2rem 0.4rem" }}>{cell.callDate}</td>
                              <td style={{ padding: "0.2rem 0.4rem", textTransform: "capitalize" }}>{cell.callPriceMode}</td>
                              <td style={{ padding: "0.2rem 0.4rem", textAlign: "right" }}>
                                {cell.error === "market_price_missing"
                                  ? <span style={{ color: "var(--color-text-muted)", fontSize: "0.65rem" }}>market prices missing</span>
                                  : cell.irr != null
                                    ? formatPct(cell.irr * 100)
                                    : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ color: "var(--color-text-muted)", fontSize: "0.7rem" }}>
                        {resolved?.dates.nonCallPeriodEnd
                          ? "—"
                          : "Optional-redemption date not extracted from PPM; supply explicit call dates to render this grid."}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {result && (
        <div style={{ marginTop: "1.5rem" }}>
          {/* Summary cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "1rem",
              marginBottom: "2rem",
            }}
          >
            {/* Hero card: Forward IRR triple (post-v6 plan §3.1).
                Three rows at fixed anchor prices (cost basis if available,
                book value, fair-value-at-10%). Independent of the entry-price
                slider — the slider drives a separate "custom" row below. */}
            <div
              style={{
                padding: "1rem 1.1rem",
                background: "linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%)",
                borderRadius: "var(--radius-sm)",
                position: "relative",
                overflow: "hidden",
                color: "#fff",
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
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.4rem", marginBottom: "0.65rem" }}>
                <div style={{ fontSize: "0.7rem", fontWeight: 500, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Forward IRR
                </div>
                <span
                  title={
                    "What does 'called' mean? The deal's manager has the option, after the non-call period ends, to redeem all senior notes at par on a quarterly payment date and unwind the deal. " +
                    "Equity then receives whatever's left from selling the underlying loan portfolio. " +
                    "If the portfolio's market value is below par-of-debt, calling wipes out equity — that's why a 'called' IRR can come back deeply negative even when 'no call' is fine."
                  }
                  style={{
                    fontSize: "0.65rem",
                    color: "rgba(255,255,255,0.5)",
                    cursor: "help",
                    border: "1px solid rgba(255,255,255,0.4)",
                    borderRadius: "50%",
                    width: "0.95rem",
                    height: "0.95rem",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 500,
                  }}
                >
                  ?
                </span>
              </div>
              {selectedAnchorIrr ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
                  {/* Controls row: anchor selector + call date input. */}
                  <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem", flex: "1 1 6rem" }}>
                      <span style={{ fontSize: "0.55rem", color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        Anchor
                      </span>
                      <select
                        value={effectiveAnchor}
                        onChange={(e) => setForwardAnchor(e.target.value as "book" | "cost" | "custom")}
                        style={{
                          fontSize: "0.78rem",
                          padding: "0.25rem 0.4rem",
                          background: "rgba(255,255,255,0.12)",
                          color: "#fff",
                          border: "1px solid rgba(255,255,255,0.18)",
                          borderRadius: "0.2rem",
                          fontFamily: "inherit",
                        }}
                      >
                        {anchorOptions.map((opt) => (
                          <option key={opt.id} value={opt.id} style={{ color: "#000" }}>
                            {opt.label} ({opt.cents}c)
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem", flex: "1 1 7rem" }}>
                      <span style={{ fontSize: "0.55rem", color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        Call date
                      </span>
                      <input
                        type="date"
                        value={withCallDate ?? ""}
                        min={resolved?.dates.currentDate ?? undefined}
                        onChange={(e) => setUserCallDate(e.target.value || "")}
                        style={{
                          fontSize: "0.78rem",
                          padding: "0.25rem 0.4rem",
                          background: "rgba(255,255,255,0.12)",
                          color: "#fff",
                          border: "1px solid rgba(255,255,255,0.18)",
                          borderRadius: "0.2rem",
                          fontFamily: "inherit",
                          colorScheme: "dark",
                        }}
                      />
                    </label>
                  </div>
                  {/* IRR values: no-call always shown; called shown when the
                      with-call comparison is active. */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", fontVariantNumeric: "tabular-nums" }}>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", fontSize: "0.78rem" }}>
                      <span style={{ color: "rgba(255,255,255,0.85)" }}>Held to maturity</span>
                      <strong style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem", letterSpacing: "-0.02em" }}>
                        {selectedAnchorIrr.noCall != null ? formatPct(selectedAnchorIrr.noCall * 100) : "—"}
                      </strong>
                    </div>
                    {withCallDate && selectedAnchorIrr.withCall !== undefined && (
                      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", fontSize: "0.78rem" }}>
                        <span style={{ color: "rgba(255,255,255,0.85)" }}>
                          If called {formatCallDate(withCallDate)}
                        </span>
                        <strong style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem", letterSpacing: "-0.02em" }}>
                          {selectedAnchorIrr.withCall != null ? formatPct(selectedAnchorIrr.withCall * 100) : "—"}
                        </strong>
                      </div>
                    )}
                  </div>
                  {/* Implied price for 10% IRR — separate concept (price, not
                      IRR), shown as a small footer note. */}
                  {(() => {
                    const fv10NoCall = fairValues?.find((fv) => fv.hurdle === 0.10) ?? null;
                    const fv10WithCall = fairValuesWithCall?.find((fv) => fv.hurdle === 0.10) ?? null;
                    const renderPrice = (fv: FairValueResult | null): string => {
                      if (!fv) return "—";
                      if (fv.status === "converged" && fv.priceCents != null) return `${fv.priceCents.toFixed(0)}c`;
                      if (fv.status === "below_hurdle") return "below hurdle";
                      if (fv.status === "above_max_bracket") return "exceeds 200c";
                      return "—";
                    };
                    if (!fv10NoCall) return null;
                    return (
                      <div
                        style={{
                          fontSize: "0.6rem",
                          color: "rgba(255,255,255,0.7)",
                          marginTop: "0.2rem",
                          paddingTop: "0.4rem",
                          borderTop: "1px solid rgba(255,255,255,0.18)",
                          lineHeight: 1.4,
                        }}
                      >
                        Buy at <strong style={{ color: "rgba(255,255,255,0.9)" }}>{renderPrice(fv10NoCall)}</strong> for 10% IRR (no call)
                        {fv10WithCall && (
                          <> · <strong style={{ color: "rgba(255,255,255,0.9)" }}>{renderPrice(fv10WithCall)}</strong> if called</>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "1.6rem",
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "-0.02em",
                    textAlign: "center",
                  }}
                >
                  {result.equityIrr !== null ? formatPct(result.equityIrr * 100) : "N/A"}
                </div>
              )}
            </div>

            {/* Since-inception IRR card — post-v6 plan §3.2: ship all three
                modes (realized / mark-to-book / mark-to-model) side by side
                instead of picking one and labeling it ambiguously. */}
            <div
              style={{
                padding: "1rem 1.1rem",
                background: inceptionIrr
                  ? "linear-gradient(135deg, #059669 0%, #047857 100%)"
                  : "var(--color-surface)",
                borderRadius: "var(--radius-sm)",
                position: "relative",
                overflow: "hidden",
                border: inceptionIrr ? "none" : "1px solid var(--color-border)",
                color: inceptionIrr ? "#fff" : "var(--color-text-muted)",
              }}
            >
              <div style={{
                fontSize: "0.7rem",
                fontWeight: 500,
                color: inceptionIrr ? "rgba(255,255,255,0.7)" : "var(--color-text-muted)",
                marginBottom: "0.55rem",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}>
                Since-inception IRR
              </div>
              {inceptionIrr ? (() => {
                // Lead with the deal's lifetime IRR (mark-to-book at
                // closing) — that's what most readers mean by "since
                // inception". Show the user's actual position as a
                // secondary line if they have a purchase override.
                //
                // Why this shape:
                //   - The realized IRR (cashflows / -purchase) was the
                //     headline before, but on a position that hasn't
                //     returned principal yet it reads as a huge negative
                //     number ("-61%") that's mathematically valid but
                //     economically misleading. Dropped from the headline.
                //   - Mark-to-model added a forward-projection IRR with
                //     no-call/with-call columns; partners reported it as
                //     unclear without a clear question being answered.
                //     Moved into the Forward IRR card (where call-mode
                //     comparison belongs).
                //   - What remains: one mark-to-book number per anchor —
                //     "the IRR if you sold at book today, anchored at X."
                const dealLifetime = inceptionIrr.primary.isUserOverride
                  ? inceptionIrr.counterfactual
                  : inceptionIrr.primary;
                const yourPosition = inceptionIrr.primary.isUserOverride
                  ? inceptionIrr.primary
                  : null;
                const fmtIrr = (v: number | null): string => v != null ? formatPct(v * 100) : "—";
                return (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {dealLifetime && dealLifetime.markToBookIrr != null ? (
                      <>
                        <div
                          style={{
                            fontFamily: "var(--font-display)",
                            fontSize: "1.6rem",
                            fontWeight: 700,
                            letterSpacing: "-0.02em",
                            fontVariantNumeric: "tabular-nums",
                            lineHeight: 1.1,
                          }}
                        >
                          {fmtIrr(dealLifetime.markToBookIrr)}
                        </div>
                        <div style={{ fontSize: "0.6rem", color: "rgba(255,255,255,0.7)", marginTop: "0.25rem", lineHeight: 1.4 }}>
                          Mark-to-book since closing ({dealLifetime.anchorDate} at {dealLifetime.anchorPriceCents.toFixed(0)}c)
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: "0.78rem", color: "rgba(255,255,255,0.85)" }}>
                        No closing-date anchor available.
                      </div>
                    )}
                    {yourPosition && yourPosition.markToBookIrr != null && (
                      <div
                        style={{
                          marginTop: "0.65rem",
                          paddingTop: "0.5rem",
                          borderTop: "1px solid rgba(255,255,255,0.18)",
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.15rem",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "0.5rem" }}>
                          <span style={{ fontSize: "0.7rem", color: "rgba(255,255,255,0.85)" }}>
                            Since you bought
                          </span>
                          <strong style={{ fontFamily: "var(--font-display)", fontSize: "1rem", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                            {fmtIrr(yourPosition.markToBookIrr)}
                          </strong>
                        </div>
                        <div style={{ fontSize: "0.55rem", color: "rgba(255,255,255,0.55)", lineHeight: 1.4 }}>
                          Mark-to-book at {yourPosition.anchorDate} ({yourPosition.anchorPriceCents.toFixed(0)}c) · {yourPosition.distributionCount} realized
                        </div>
                      </div>
                    )}
                  </div>
                );
              })() : (
                <div style={{ textAlign: "center" }}>
                  <div
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: "1.6rem",
                      fontWeight: 700,
                      color: "var(--color-text-muted)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    -- %
                  </div>
                  <Link
                    href="/clo/context"
                    style={{ fontSize: "0.65rem", color: "var(--color-accent)", marginTop: "0.2rem", display: "block" }}
                  >
                    Set up in Context
                  </Link>
                </div>
              )}
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
                          <PeriodTrace period={p} />
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
              feesCitation={resolved?.fees.citation ?? null}
              callMode={callMode} onCallModeChange={setCallMode}
              callDate={callDate} onCallDateChange={setCallDate}
              callPricePct={callPricePct} onCallPriceChange={setCallPricePct}
              callPriceMode={callPriceMode} onCallPriceModeChange={setCallPriceMode}
              portfolioInfo={portfolioInfo}
              ddtlDrawAssumption={ddtlDrawAssumption} onDdtlDrawAssumptionChange={setDdtlDrawAssumption}
              ddtlDrawQuarter={ddtlDrawQuarter} onDdtlDrawQuarterChange={setDdtlDrawQuarter}
              ddtlDrawPercent={ddtlDrawPercent} onDdtlDrawPercentChange={setDdtlDrawPercent}
            />
            <div style={{ marginTop: "1rem" }}>
              <DefaultRatePanel
                defaultRates={defaultRates}
                onChange={handleDefaultRatesChange}
                ratingDistribution={ratingDistribution}
                weightedAvgCdr={weightedAvgCdr}
              />
            </div>
          </div>
        </div>
      )}

      {/* N1 Waterfall Replay Harness — reactive to user assumptions above */}
      {(waterfallSteps?.length ?? 0) > 0 && trancheSnapshots.length > 0 && (
        <HarnessPanel
          inputs={inputs}
          engineMathInputs={engineMathInputs}
          backtest={buildBacktestInputs({
            waterfallSteps,
            trancheSnapshots,
            tranches,
            complianceData: {
              complianceTests,
              poolSummary: poolSummary ? { totalPrincipalBalance: poolSummary.totalPrincipalBalance } : null,
            },
            accountBalances,
            dealDates: { reportDate, paymentDate },
          })}
        />
      )}
    </div>
  );
}

/**
 * T4 — Status line under the assumption sliders summarising the Intex pre-fill
 * and a single bearish/matching/aggressive badge that compares the user's
 * current slider values against Intex's published scenario.
 *
 * Stress score = (user CDR / Intex CDR) - (user Recovery / Intex Recovery).
 * Positive ⇒ user is more conservative on credit ⇒ "bearish vs Intex".
 * Negative ⇒ user is more optimistic ⇒ "aggressive vs Intex". Within ±5% of
 * zero ⇒ "matching Intex".
 */
function IntexAssumptionStatus({
  source,
  intex,
  cprPct,
  recoveryPct,
  defaultRates,
  reinvestmentSpreadBps,
}: {
  source: { scenario: string | null; ratesAsOf: string | null };
  intex: IntexAssumptions;
  cprPct: number;
  recoveryPct: number;
  defaultRates: Record<string, number>;
  reinvestmentSpreadBps: number;
}) {
  // User CDR is the simple mean across rating buckets. Intex CDR is a single
  // pool-level number, so the comparison is mean-vs-pool — not perfect, but
  // good enough for a stance summary.
  const userCdrMean = (() => {
    const vals = Object.values(defaultRates);
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  })();

  let badge: { label: string; tone: "bearish" | "matching" | "aggressive" } | null = null;
  if (intex.cdrPct != null && intex.recoveryPct != null && userCdrMean != null) {
    const cdrRatio = userCdrMean / intex.cdrPct;
    const recRatio = recoveryPct / intex.recoveryPct;
    const score = cdrRatio - recRatio;
    if (score > 0.05) badge = { label: "Bearish vs Intex", tone: "bearish" };
    else if (score < -0.05) badge = { label: "Aggressive vs Intex", tone: "aggressive" };
    else badge = { label: "Matching Intex", tone: "matching" };
  }

  const toneColor =
    badge?.tone === "bearish" ? "#d97706"
      : badge?.tone === "aggressive" ? "#7c3aed"
      : "#10b981";

  const dateLabel = source.ratesAsOf?.split(" ")[0] ?? null; // first token = "Apr"
  const monthYear = source.ratesAsOf?.match(/^([A-Za-z]{3})\s+\d{1,2},?\s+(\d{4})/);
  const exportLabel = monthYear ? `${monthYear[1]} ${monthYear[2]}` : (dateLabel ?? "Intex");

  const deltas: string[] = [];
  if (intex.cprPct != null && Math.abs(cprPct - intex.cprPct) > 0.5) {
    deltas.push(`CPR ${cprPct.toFixed(1)}% vs Intex ${intex.cprPct}%`);
  }
  if (intex.cdrPct != null && userCdrMean != null && Math.abs(userCdrMean - intex.cdrPct) > 0.2) {
    deltas.push(`CDR ${userCdrMean.toFixed(2)}% vs Intex ${intex.cdrPct}%`);
  }
  if (intex.recoveryPct != null && Math.abs(recoveryPct - intex.recoveryPct) > 1) {
    deltas.push(`Recovery ${recoveryPct}% vs Intex ${intex.recoveryPct}%`);
  }
  if (intex.reinvestSpreadPct != null) {
    const intexBps = Math.round(intex.reinvestSpreadPct * 100);
    if (Math.abs(reinvestmentSpreadBps - intexBps) > 10) {
      deltas.push(`Reinv spread ${reinvestmentSpreadBps} bps vs Intex ${intexBps} bps`);
    }
  }

  return (
    <div style={{ marginTop: "0.75rem", display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", opacity: 0.85 }}>
        Defaults from Intex {source.scenario ? `(${source.scenario}, ` : "("}
        {exportLabel} export)
      </span>
      {badge && (
        <span
          style={{
            fontSize: "0.65rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "#fff",
            background: toneColor,
            padding: "0.15rem 0.5rem",
            borderRadius: "var(--radius-sm)",
          }}
        >
          {badge.label}
        </span>
      )}
      {deltas.length > 0 && (
        <span style={{ fontSize: "0.65rem", color: "var(--color-text-muted)", opacity: 0.75 }}>
          {deltas.join(" · ")}
        </span>
      )}
    </div>
  );
}
