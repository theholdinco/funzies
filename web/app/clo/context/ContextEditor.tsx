"use client";

import { useState, useEffect } from "react";
import {
  InlineText,
  InlineNumber,
  InlineSelect,
  InlineStringList,
  InlineKeyValue,
} from "@/components/clo/InlineEdit";
import type {
  ExtractedConstraints,
  CoverageTestEntry,
  CollateralQualityTest,
  CapitalStructureEntry,
  FeeEntry,
  KeyParty,
  CloPoolSummary,
  CloComplianceTest,
  CloConcentration,
  HedgingProvisions,
  InterestMechanics,
  RiskRetention,
  VotingAndControl,
  RatingAgencyParameters,
  RedemptionProvision,
  EventOfDefault,
  CMDetails,
  CloTranche,
  CloTrancheSnapshot,
  CloHolding,
  CloAccountBalance,
  CloParValueAdjustment,
  CloAccrual,
  CloTrade,
  CloTradingSummary,
  CloWaterfallStep,
  CloEvent,
  CloSupplementaryData,
  CloProceeds,
  CloExtractionOverflow,
  EquityInceptionData,
} from "@/lib/clo/types";
import { resolveWaterfallInputs } from "@/lib/clo/resolver";
import type { ResolvedDealData, ResolutionWarning } from "@/lib/clo/resolver-types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ContextEditorProps {
  constraints: ExtractedConstraints;
  fundProfile: {
    fundStrategy: string | null;
    targetSectors: string | null;
    riskAppetite: string | null;
    portfolioSize: string | null;
    reinvestmentPeriod: string | null;
    concentrationLimits: string | null;
    covenantPreferences: string | null;
    ratingThresholds: string | null;
    spreadTargets: string | null;
    regulatoryConstraints: string | null;
    portfolioDescription: string | null;
    beliefsAndBiases: string | null;
  };
  complianceData: {
    reportPeriodId: string;
    reportDate: string;
    poolSummary: CloPoolSummary | null;
    complianceTests: CloComplianceTest[];
    concentrations: CloConcentration[];
  } | null;
  tranches?: CloTranche[];
  trancheSnapshots?: CloTrancheSnapshot[];
  holdings?: CloHolding[];
  accountBalances?: CloAccountBalance[];
  parValueAdjustments?: CloParValueAdjustment[];
  dealDates?: { maturity?: string | null; reinvestmentPeriodEnd?: string | null; reportDate?: string | null };
  equityInceptionData?: EquityInceptionData | null;
  extractedDistributions?: { date: string; distribution: number }[];
  accruals?: CloAccrual[];
  trades?: CloTrade[];
  tradingSummary?: CloTradingSummary | null;
  waterfallSteps?: CloWaterfallStep[];
  events?: CloEvent[];
  supplementaryData?: CloSupplementaryData | null;
  proceeds?: CloProceeds[];
  overflow?: CloExtractionOverflow[];
}

// ---------------------------------------------------------------------------
// CollapsibleSection (copied from QuestionnaireForm)
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  badge,
  defaultOpen,
  children,
}: {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", marginBottom: "0.5rem" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.6rem 0.8rem",
          background: "var(--color-surface)",
          border: "none",
          cursor: "pointer",
          fontSize: "0.85rem",
          fontWeight: 600,
          color: "var(--color-text)",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: "0.7rem" }}>{open ? "\u25BC" : "\u25B6"}</span>
        {title}
        {badge && (
          <span style={{
            marginLeft: "auto",
            fontSize: "0.7rem",
            padding: "0.15rem 0.5rem",
            background: "var(--color-accent-subtle)",
            color: "var(--color-accent)",
            borderRadius: "var(--radius-sm)",
            fontWeight: 500,
          }}>
            {badge}
          </span>
        )}
      </button>
      {open && <div style={{ padding: "0.6rem 0.8rem", borderTop: "1px solid var(--color-border)" }}>{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SourceBadge
// ---------------------------------------------------------------------------

function SourceBadge({ source }: { source: "PPM" | "Profile" | "Compliance Report" }) {
  const colors = { PPM: "#6366f1", Profile: "#059669", "Compliance Report": "#d97706" };
  return (
    <span style={{
      fontSize: "0.65rem",
      padding: "0.1rem 0.4rem",
      borderRadius: "9999px",
      background: colors[source] + "20",
      color: colors[source],
      fontWeight: 600,
      marginLeft: "0.5rem",
    }}>
      {source}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.82rem",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.3rem 0.5rem",
  borderBottom: "1px solid var(--color-border)",
  fontWeight: 600,
  fontSize: "0.75rem",
  color: "var(--color-text-muted)",
};

const tdStyle: React.CSSProperties = {
  padding: "0.3rem 0.5rem",
  borderBottom: "1px solid var(--color-border)",
  verticalAlign: "top",
};

const kvRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "baseline",
  marginBottom: "0.4rem",
};

const kvLabelStyle: React.CSSProperties = {
  minWidth: "10rem",
  fontSize: "0.78rem",
  color: "var(--color-text-muted)",
  fontWeight: 500,
};

const addBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "var(--color-accent)",
  fontSize: "0.8rem",
  padding: "0.3rem 0",
};

const removeBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "var(--color-text-muted)",
  fontSize: "0.8rem",
  padding: "0 0.2rem",
};

const groupHeadingStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  fontWeight: 700,
  margin: "1.5rem 0 0.75rem",
  paddingBottom: "0.4rem",
  borderBottom: "2px solid var(--color-border)",
  display: "flex",
  alignItems: "center",
};

const saveBtnStyle: React.CSSProperties = {
  padding: "0.5rem 1.5rem",
  background: "var(--color-accent)",
  color: "white",
  border: "none",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
  fontSize: "0.85rem",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/_/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ContextEditor({
  constraints: initialConstraints,
  fundProfile: initialProfile,
  complianceData: initialCompliance,
  tranches,
  trancheSnapshots,
  holdings,
  accountBalances,
  parValueAdjustments,
  dealDates,
  equityInceptionData: initialInceptionData,
  extractedDistributions,
  accruals,
  trades,
  tradingSummary,
  waterfallSteps,
  events,
  supplementaryData,
  proceeds,
  overflow,
}: ContextEditorProps) {
  const [constraints, setConstraints] = useState<ExtractedConstraints>(initialConstraints);
  const [fundProfile, setFundProfile] = useState(initialProfile);
  const [complianceData, setComplianceData] = useState(initialCompliance);

  const [resolved, setResolved] = useState<ResolvedDealData | null>(null);
  const [resolutionWarnings, setResolutionWarnings] = useState<ResolutionWarning[]>([]);

  useEffect(() => {
    const { resolved: r, warnings: w } = resolveWaterfallInputs(
      constraints,
      complianceData ? { poolSummary: complianceData.poolSummary, complianceTests: complianceData.complianceTests, concentrations: complianceData.concentrations } : null,
      tranches ?? [],
      trancheSnapshots ?? [],
      holdings ?? [],
      dealDates,
      accountBalances ?? [],
      parValueAdjustments ?? [],
    );
    setResolved(r);
    setResolutionWarnings(w);
  }, [constraints, complianceData, tranches, trancheSnapshots, holdings, accountBalances, parValueAdjustments, dealDates]);

  const [constraintsDirty, setConstraintsDirty] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [complianceDirty, setComplianceDirty] = useState(false);

  const [savingConstraints, setSavingConstraints] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingCompliance, setSavingCompliance] = useState(false);

  const [inceptionData, setInceptionData] = useState<EquityInceptionData>(
    initialInceptionData ?? { purchaseDate: null, purchasePriceCents: null, payments: [] }
  );
  const [inceptionDirty, setInceptionDirty] = useState(false);
  const [savingInception, setSavingInception] = useState(false);

  // --- Update helpers ---

  function updateConstraint<K extends keyof ExtractedConstraints>(key: K, value: ExtractedConstraints[K]) {
    setConstraints((prev) => ({ ...prev, [key]: value }));
    setConstraintsDirty(true);
  }

  function updateProfile<K extends keyof typeof fundProfile>(key: K, value: (typeof fundProfile)[K]) {
    setFundProfile((prev) => ({ ...prev, [key]: value }));
    setProfileDirty(true);
  }

  function updateCompliance<K extends keyof NonNullable<typeof complianceData>>(
    key: K,
    value: NonNullable<typeof complianceData>[K],
  ) {
    setComplianceData((prev) => (prev ? { ...prev, [key]: value } : prev));
    setComplianceDirty(true);
  }

  // --- Save handlers ---

  async function saveConstraints() {
    setSavingConstraints(true);
    const res = await fetch("/api/clo/profile/constraints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extractedConstraints: constraints }),
    });
    setSavingConstraints(false);
    if (res.ok) setConstraintsDirty(false);
  }

  async function saveProfile() {
    setSavingProfile(true);
    const res = await fetch("/api/clo/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fund_strategy: fundProfile.fundStrategy,
        target_sectors: fundProfile.targetSectors,
        risk_appetite: fundProfile.riskAppetite,
        portfolio_size: fundProfile.portfolioSize,
        reinvestment_period: fundProfile.reinvestmentPeriod,
        concentration_limits: fundProfile.concentrationLimits,
        covenant_preferences: fundProfile.covenantPreferences,
        rating_thresholds: fundProfile.ratingThresholds,
        spread_targets: fundProfile.spreadTargets,
        regulatory_constraints: fundProfile.regulatoryConstraints,
        portfolio_description: fundProfile.portfolioDescription,
        beliefs_and_biases: fundProfile.beliefsAndBiases,
      }),
    });
    setSavingProfile(false);
    if (res.ok) setProfileDirty(false);
  }

  async function saveInception() {
    setSavingInception(true);
    const res = await fetch("/api/clo/profile/inception", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ equityInceptionData: inceptionData }),
    });
    setSavingInception(false);
    if (res.ok) setInceptionDirty(false);
  }

  async function saveCompliance() {
    if (!complianceData) return;
    setSavingCompliance(true);
    const res = await fetch("/api/clo/compliance", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportPeriodId: complianceData.reportPeriodId,
        poolSummary: complianceData.poolSummary,
        complianceTests: complianceData.complianceTests?.map((t) => ({
          id: t.id,
          updates: {
            testName: t.testName,
            testType: t.testType,
            testClass: t.testClass,
            triggerLevel: t.triggerLevel,
            actualValue: t.actualValue,
            isPassing: t.isPassing,
            cushionPct: t.cushionPct,
            cushionAmount: t.cushionAmount,
          },
        })),
        concentrations: complianceData.concentrations?.map((c) => ({
          id: c.id,
          updates: {
            concentrationType: c.concentrationType,
            bucketName: c.bucketName,
            actualPct: c.actualPct,
            limitPct: c.limitPct,
            isPassing: c.isPassing,
          },
        })),
      }),
    });
    setSavingCompliance(false);
    if (res.ok) setComplianceDirty(false);
  }

  // --- Array mutators for constraint sub-fields ---

  function updateCoverageRow(index: number, field: keyof CoverageTestEntry, value: string) {
    const rows = [...((constraints.coverageTestEntries || []) as CoverageTestEntry[])];
    rows[index] = { ...rows[index], [field]: value };
    updateConstraint("coverageTestEntries", rows);
  }

  function addCoverageRow() {
    const rows = [...((constraints.coverageTestEntries || []) as CoverageTestEntry[])];
    rows.push({ class: "", parValueRatio: "", interestCoverageRatio: "" });
    updateConstraint("coverageTestEntries", rows);
  }

  function removeCoverageRow(index: number) {
    updateConstraint("coverageTestEntries", ((constraints.coverageTestEntries || []) as CoverageTestEntry[]).filter((_, i) => i !== index));
  }

  function updateCQTRow(index: number, field: keyof CollateralQualityTest, value: string) {
    const rows = [...((constraints.collateralQualityTests || []) as CollateralQualityTest[])];
    rows[index] = { ...rows[index], [field]: value };
    updateConstraint("collateralQualityTests", rows);
  }

  function addCQTRow() {
    const rows = [...((constraints.collateralQualityTests || []) as CollateralQualityTest[])];
    rows.push({ name: "", agency: "", value: "", appliesDuring: "" });
    updateConstraint("collateralQualityTests", rows);
  }

  function removeCQTRow(index: number) {
    updateConstraint("collateralQualityTests", ((constraints.collateralQualityTests || []) as CollateralQualityTest[]).filter((_, i) => i !== index));
  }

  function updateCapStructRow(index: number, field: string, value: string | number) {
    const rows = [...((constraints.capitalStructure || []) as CapitalStructureEntry[])];
    if (field === "ratingFitch" || field === "ratingMoodys" || field === "ratingSp") {
      const ratingKey = field === "ratingFitch" ? "fitch" : field === "ratingMoodys" ? "moodys" : "sp";
      rows[index] = { ...rows[index], rating: { ...rows[index].rating, [ratingKey]: value as string } };
    } else {
      rows[index] = { ...rows[index], [field]: value } as CapitalStructureEntry;
    }
    updateConstraint("capitalStructure", rows);
  }

  function addCapStructRow() {
    const rows = [...((constraints.capitalStructure || []) as CapitalStructureEntry[])];
    rows.push({ class: "", principalAmount: "", spread: "", rating: {}, issuePrice: "", maturityDate: "" });
    updateConstraint("capitalStructure", rows);
  }

  function removeCapStructRow(index: number) {
    updateConstraint("capitalStructure", ((constraints.capitalStructure || []) as CapitalStructureEntry[]).filter((_, i) => i !== index));
  }

  function updateFeeRow(index: number, field: keyof FeeEntry, value: string) {
    const rows = [...((constraints.fees || []) as FeeEntry[])];
    rows[index] = { ...rows[index], [field]: value };
    updateConstraint("fees", rows);
  }

  function addFeeRow() {
    const rows = [...((constraints.fees || []) as FeeEntry[])];
    rows.push({ name: "", rate: "", basis: "", description: "" });
    updateConstraint("fees", rows);
  }

  function removeFeeRow(index: number) {
    updateConstraint("fees", ((constraints.fees || []) as FeeEntry[]).filter((_, i) => i !== index));
  }

  function updateAccountRow(index: number, field: "name" | "purpose", value: string) {
    const rows = [...((constraints.accounts || []) as { name: string; purpose: string }[])];
    rows[index] = { ...rows[index], [field]: value };
    updateConstraint("accounts", rows);
  }

  function addAccountRow() {
    const rows = [...((constraints.accounts || []) as { name: string; purpose: string }[])];
    rows.push({ name: "", purpose: "" });
    updateConstraint("accounts", rows);
  }

  function removeAccountRow(index: number) {
    updateConstraint("accounts", ((constraints.accounts || []) as { name: string; purpose: string }[]).filter((_, i) => i !== index));
  }

  function updateKeyPartyRow(index: number, field: keyof KeyParty, value: string) {
    const rows = [...((constraints.keyParties || []) as KeyParty[])];
    rows[index] = { ...rows[index], [field]: value };
    updateConstraint("keyParties", rows);
  }

  function addKeyPartyRow() {
    const rows = [...((constraints.keyParties || []) as KeyParty[])];
    rows.push({ role: "", entity: "" });
    updateConstraint("keyParties", rows);
  }

  function removeKeyPartyRow(index: number) {
    updateConstraint("keyParties", ((constraints.keyParties || []) as KeyParty[]).filter((_, i) => i !== index));
  }

  function updateTradingRestrictionRow(index: number, field: "testName" | "consequence", value: string) {
    const rows = [...((constraints.tradingRestrictionsByTestBreach || []) as { testName: string; consequence: string }[])];
    rows[index] = { ...rows[index], [field]: value };
    updateConstraint("tradingRestrictionsByTestBreach", rows);
  }

  function addTradingRestrictionRow() {
    const rows = [...((constraints.tradingRestrictionsByTestBreach || []) as { testName: string; consequence: string }[])];
    rows.push({ testName: "", consequence: "" });
    updateConstraint("tradingRestrictionsByTestBreach", rows);
  }

  function removeTradingRestrictionRow(index: number) {
    updateConstraint("tradingRestrictionsByTestBreach", ((constraints.tradingRestrictionsByTestBreach || []) as { testName: string; consequence: string }[]).filter((_, i) => i !== index));
  }

  // --- Portfolio profile tests helpers ---

  const portfolioProfileTests = (constraints.portfolioProfileTests || {}) as Record<string, { min?: string | null; max?: string | null; notes?: string }>;

  function updatePPTField(testName: string, field: "min" | "max" | "notes", value: string) {
    const updated = { ...portfolioProfileTests, [testName]: { ...portfolioProfileTests[testName], [field]: value } };
    updateConstraint("portfolioProfileTests", updated);
  }

  function addPPTRow() {
    const updated = { ...portfolioProfileTests, "": { min: null, max: null, notes: "" } };
    updateConstraint("portfolioProfileTests", updated);
  }

  function removePPTRow(testName: string) {
    const updated = { ...portfolioProfileTests };
    delete updated[testName];
    updateConstraint("portfolioProfileTests", updated);
  }

  function renamePPTRow(oldName: string, newName: string) {
    const updated: typeof portfolioProfileTests = {};
    for (const [k, v] of Object.entries(portfolioProfileTests)) {
      updated[k === oldName ? newName : k] = v;
    }
    updateConstraint("portfolioProfileTests", updated);
  }

  // --- Render helpers for remaining structural ---

  function renderObjectFields(obj: Record<string, unknown>, path: string[], onUpdate: (path: string[], value: string) => void) {
    return Object.entries(obj).map(([key, val]) => {
      if (val === null || val === undefined || typeof val === "boolean") {
        return (
          <div key={key} style={kvRowStyle}>
            <span style={kvLabelStyle}>{humanize(key)}</span>
            <InlineText value={String(val ?? "")} onChange={(v) => onUpdate([...path, key], v)} />
          </div>
        );
      }
      if (typeof val === "string" || typeof val === "number") {
        return (
          <div key={key} style={kvRowStyle}>
            <span style={kvLabelStyle}>{humanize(key)}</span>
            <InlineText value={String(val)} onChange={(v) => onUpdate([...path, key], v)} multiline={String(val).length > 80} />
          </div>
        );
      }
      if (Array.isArray(val)) {
        if (val.length === 0) return null;
        if (typeof val[0] === "string") {
          return (
            <div key={key} style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.3rem" }}>{humanize(key)}</div>
              <InlineStringList
                items={val as string[]}
                onChange={(items) => onUpdate([...path, key], JSON.stringify(items))}
              />
            </div>
          );
        }
        // Object array — render as mini table
        if (typeof val[0] === "object") {
          const keys = Object.keys(val[0] as Record<string, unknown>);
          return (
            <div key={key} style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.3rem" }}>{humanize(key)}</div>
              <table style={tableStyle}>
                <thead>
                  <tr>{keys.map((k) => <th key={k} style={thStyle}>{humanize(k)}</th>)}</tr>
                </thead>
                <tbody>
                  {(val as Record<string, unknown>[]).map((row, ri) => (
                    <tr key={ri}>
                      {keys.map((k) => (
                        <td key={k} style={tdStyle}>
                          <InlineText value={String(row[k] ?? "")} onChange={(v) => onUpdate([...path, key, String(ri), k], v)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
      }
      if (typeof val === "object") {
        return (
          <div key={key} style={{ marginBottom: "0.5rem", paddingLeft: "0.5rem", borderLeft: "2px solid var(--color-border)" }}>
            <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.3rem" }}>{humanize(key)}</div>
            {renderObjectFields(val as Record<string, unknown>, [...path, key], onUpdate)}
          </div>
        );
      }
      return null;
    });
  }

  function handleRemainingUpdate(path: string[], value: string) {
    const topKey = path[0] as keyof ExtractedConstraints;
    const current = constraints[topKey];

    if (path.length === 2 && typeof current === "object" && !Array.isArray(current)) {
      updateConstraint(topKey, { ...(current as Record<string, unknown>), [path[1]]: value } as ExtractedConstraints[typeof topKey]);
      return;
    }

    // Deep path update (arrays/nested)
    function deepSet(obj: unknown, keys: string[], val: string): unknown {
      if (keys.length === 0) return val;
      const [head, ...rest] = keys;
      if (Array.isArray(obj)) {
        const idx = Number(head);
        const copy = [...obj];
        copy[idx] = deepSet(copy[idx], rest, val);
        return copy;
      }
      if (typeof obj === "object" && obj !== null) {
        return { ...(obj as Record<string, unknown>), [head]: deepSet((obj as Record<string, unknown>)[head], rest, val) };
      }
      return val;
    }

    const updated = deepSet(current, path.slice(1), value);
    updateConstraint(topKey, updated as ExtractedConstraints[typeof topKey]);
  }

  // --- Covered constraint keys (everything rendered in explicit sections) ---

  const coveredKeys = new Set<string>([
    "coverageTestEntries", "reinvestmentOcTest", "collateralQualityTests", "portfolioProfileTests",
    "eligibilityCriteria", "tradingRestrictionsByTestBreach", "dealIdentity", "keyDates",
    "capitalStructure", "dealSizing", "waterfall", "reinvestmentCriteria", "cmDetails",
    "cmTradingConstraints", "fees", "accounts", "keyParties",
    // Legacy fields we skip
    "targetParAmount", "collateralManager", "issuer", "eligibleCollateral",
    "concentrationLimits", "coverageTests", "collateralManagerFees", "lossMitigationLimits",
    "esgExclusions", "warfLimit", "wasMinimum", "walMaximum", "diversityScoreMinimum",
    "reinvestmentPeriod", "nonCallPeriod", "maturityDate", "paymentDates",
    "frequencySwitchEvent", "waterfallSummary", "ratingThresholds", "otherConstraints",
    "additionalProvisions",
  ]);

  const remainingKeys = Object.keys(constraints).filter(
    (k) => !coveredKeys.has(k) && constraints[k as keyof ExtractedConstraints] != null,
  );

  // =========================================================================
  // RENDER
  // =========================================================================

  const asArray = <T,>(v: unknown): T[] => Array.isArray(v) ? v as T[] : [];

  const coverageRows = asArray<CoverageTestEntry>(constraints.coverageTestEntries);
  const cqtRows = asArray<CollateralQualityTest>(constraints.collateralQualityTests);
  const tradingRestrictions = asArray<{ testName: string; consequence: string }>(constraints.tradingRestrictionsByTestBreach);
  const eligibility = asArray<string>(constraints.eligibilityCriteria);
  const dealIdentity = (constraints.dealIdentity || {}) as Record<string, string | undefined>;
  const keyDates = (constraints.keyDates || {}) as Record<string, string | undefined>;
  const capStruct = asArray<CapitalStructureEntry>(constraints.capitalStructure);
  const dealSizing = (constraints.dealSizing || {}) as Record<string, string | undefined>;
  const waterfall = (constraints.waterfall || {}) as Record<string, string | undefined>;
  const reinvCriteria = (constraints.reinvestmentCriteria || {}) as Record<string, string | undefined>;
  const cmDetails = (constraints.cmDetails || {}) as CMDetails;
  const cmTrading = (constraints.cmTradingConstraints || {}) as Record<string, unknown>;
  const feeRows = asArray<FeeEntry>(constraints.fees);
  const accountRows = asArray<{ name: string; purpose: string }>(constraints.accounts);
  const keyPartyRows = asArray<KeyParty>(constraints.keyParties);

  function exportContext() {
    // Full raw payload — everything fetched from the DB (PDF-extracted + SDF-extracted).
    // Tables populated by SDF ingestion: accruals, trades, tradingSummary, waterfallSteps,
    // events, supplementaryData, plus the SDF-enriched columns already inside tranches /
    // trancheSnapshots / holdings / accountBalances.
    const raw = {
      constraints,
      fundProfile,
      complianceData,
      tranches: tranches ?? [],
      trancheSnapshots: trancheSnapshots ?? [],
      holdings: holdings ?? [],
      accountBalances: accountBalances ?? [],
      parValueAdjustments: parValueAdjustments ?? [],
      accruals: accruals ?? [],
      trades: trades ?? [],
      tradingSummary: tradingSummary ?? null,
      waterfallSteps: waterfallSteps ?? [],
      events: events ?? [],
      supplementaryData: supplementaryData ?? null,
      proceeds: proceeds ?? [],
      overflow: overflow ?? [],
      dealDates: dealDates ?? null,
      equityInceptionData: inceptionData ?? null,
      extractedDistributions: extractedDistributions ?? [],
    };
    const data = resolved
      ? { resolved, warnings: resolutionWarnings, raw }
      : raw;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "clo-context.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importContext(file: File) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        // Handle both flat format { constraints, fundProfile, complianceData }
        // and nested format { resolved, warnings, raw: { constraints, fundProfile, complianceData } }
        const source = data.raw ?? data;
        if (source.constraints) {
          setConstraints(source.constraints);
          setConstraintsDirty(false);
          await fetch("/api/clo/profile/constraints", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ extractedConstraints: source.constraints }),
          });
        }
        if (source.fundProfile) {
          setFundProfile(source.fundProfile);
          setProfileDirty(false);
          await fetch("/api/clo/profile", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fund_strategy: source.fundProfile.fundStrategy,
              target_sectors: source.fundProfile.targetSectors,
              risk_appetite: source.fundProfile.riskAppetite,
              portfolio_size: source.fundProfile.portfolioSize,
              reinvestment_period: source.fundProfile.reinvestmentPeriod,
              concentration_limits: source.fundProfile.concentrationLimits,
              covenant_preferences: source.fundProfile.covenantPreferences,
              rating_thresholds: source.fundProfile.ratingThresholds,
              spread_targets: source.fundProfile.spreadTargets,
              regulatory_constraints: source.fundProfile.regulatoryConstraints,
              portfolio_description: source.fundProfile.portfolioDescription,
              beliefs_and_biases: source.fundProfile.beliefsAndBiases,
            }),
          });
        }
        if (source.complianceData) {
          setComplianceData(source.complianceData);
          setComplianceDirty(false);
        }
      } catch { /* ignore parse errors */ }
    };
    reader.readAsText(file);
  }

  return (
    <div style={{ maxWidth: "64rem" }}>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button
          onClick={exportContext}
          style={{ ...saveBtnStyle, background: "var(--color-surface)", color: "var(--color-text)", border: "1px solid var(--color-border)" }}
        >
          Export JSON
        </button>
        <label style={{ ...saveBtnStyle, background: "var(--color-surface)", color: "var(--color-text)", border: "1px solid var(--color-border)", cursor: "pointer" }}>
          Import JSON
          <input
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files?.[0]) importContext(e.target.files[0]); }}
          />
        </label>
      </div>

      {resolutionWarnings.length > 0 && (
        <div style={{
          marginBottom: "1rem",
          padding: "0.75rem 1rem",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)",
        }}>
          <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", fontWeight: 600 }}>
            Resolution Warnings ({resolutionWarnings.length})
          </h3>
          {resolutionWarnings.map((w, i) => (
            <div key={i} style={{
              fontSize: "0.8rem",
              padding: "0.25rem 0",
              color: w.severity === "error" ? "var(--color-error, #c00)"
                   : w.severity === "warn" ? "var(--color-warning, #a60)"
                   : "var(--color-text-muted)",
            }}>
              <strong>{w.field}:</strong> {w.message}
              {w.resolvedFrom && <span style={{ opacity: 0.7 }}> ({w.resolvedFrom})</span>}
            </div>
          ))}
        </div>
      )}

      {/* ================================================================= */}
      {/* GROUP 1: Compliance & Tests                                       */}
      {/* ================================================================= */}

      <h2 style={groupHeadingStyle}>
        Group 1: Compliance &amp; Tests <SourceBadge source="PPM" />
      </h2>

      {/* Section 1: Coverage Tests */}
      <CollapsibleSection title="Coverage Tests" defaultOpen>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Class</th>
              <th style={thStyle}>Par Value Ratio</th>
              <th style={thStyle}>Interest Coverage Ratio</th>
              <th style={{ ...thStyle, width: "2rem" }} />
            </tr>
          </thead>
          <tbody>
            {coverageRows.map((row, i) => (
              <tr key={i}>
                <td style={tdStyle}><InlineText value={row.class} onChange={(v) => updateCoverageRow(i, "class", v)} /></td>
                <td style={tdStyle}><InlineText value={row.parValueRatio || ""} onChange={(v) => updateCoverageRow(i, "parValueRatio", v)} /></td>
                <td style={tdStyle}><InlineText value={row.interestCoverageRatio || ""} onChange={(v) => updateCoverageRow(i, "interestCoverageRatio", v)} /></td>
                <td style={tdStyle}><button type="button" onClick={() => removeCoverageRow(i)} style={removeBtnStyle} title="Remove">&times;</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={addCoverageRow} style={addBtnStyle}>+ Add row</button>
      </CollapsibleSection>

      {/* Section 2: Collateral Quality Tests */}
      <CollapsibleSection title="Collateral Quality Tests">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Agency</th>
              <th style={thStyle}>Value</th>
              <th style={thStyle}>Applies During</th>
              <th style={{ ...thStyle, width: "2rem" }} />
            </tr>
          </thead>
          <tbody>
            {cqtRows.map((row, i) => (
              <tr key={i}>
                <td style={tdStyle}><InlineText value={row.name} onChange={(v) => updateCQTRow(i, "name", v)} /></td>
                <td style={tdStyle}><InlineText value={row.agency || ""} onChange={(v) => updateCQTRow(i, "agency", v)} /></td>
                <td style={tdStyle}><InlineText value={String(row.value ?? "")} onChange={(v) => updateCQTRow(i, "value", v)} /></td>
                <td style={tdStyle}><InlineText value={row.appliesDuring || ""} onChange={(v) => updateCQTRow(i, "appliesDuring", v)} /></td>
                <td style={tdStyle}><button type="button" onClick={() => removeCQTRow(i)} style={removeBtnStyle} title="Remove">&times;</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={addCQTRow} style={addBtnStyle}>+ Add row</button>
      </CollapsibleSection>

      {/* Section 3: Portfolio Profile Tests */}
      <CollapsibleSection title="Portfolio Profile Tests">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Test Name</th>
              <th style={thStyle}>Min</th>
              <th style={thStyle}>Max</th>
              <th style={thStyle}>Notes</th>
              <th style={{ ...thStyle, width: "2rem" }} />
            </tr>
          </thead>
          <tbody>
            {Object.entries(portfolioProfileTests).map(([testName, entry]) => (
              <tr key={testName}>
                <td style={tdStyle}><InlineText value={testName} onChange={(v) => renamePPTRow(testName, v)} /></td>
                <td style={tdStyle}><InlineText value={entry.min ?? ""} onChange={(v) => updatePPTField(testName, "min", v)} /></td>
                <td style={tdStyle}><InlineText value={entry.max ?? ""} onChange={(v) => updatePPTField(testName, "max", v)} /></td>
                <td style={tdStyle}><InlineText value={entry.notes || ""} onChange={(v) => updatePPTField(testName, "notes", v)} /></td>
                <td style={tdStyle}><button type="button" onClick={() => removePPTRow(testName)} style={removeBtnStyle} title="Remove">&times;</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={addPPTRow} style={addBtnStyle}>+ Add row</button>
      </CollapsibleSection>

      {/* Section 4: Eligibility Criteria */}
      <CollapsibleSection title="Eligibility Criteria">
        <InlineStringList
          items={eligibility}
          onChange={(items) => updateConstraint("eligibilityCriteria", items)}
        />
      </CollapsibleSection>

      {/* Section 5: Trading Restrictions by Test Breach */}
      <CollapsibleSection title="Trading Restrictions by Test Breach">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Test Name</th>
              <th style={thStyle}>Consequence</th>
              <th style={{ ...thStyle, width: "2rem" }} />
            </tr>
          </thead>
          <tbody>
            {tradingRestrictions.map((row, i) => (
              <tr key={i}>
                <td style={tdStyle}><InlineText value={row.testName} onChange={(v) => updateTradingRestrictionRow(i, "testName", v)} /></td>
                <td style={tdStyle}><InlineText value={row.consequence} onChange={(v) => updateTradingRestrictionRow(i, "consequence", v)} /></td>
                <td style={tdStyle}><button type="button" onClick={() => removeTradingRestrictionRow(i)} style={removeBtnStyle} title="Remove">&times;</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={addTradingRestrictionRow} style={addBtnStyle}>+ Add row</button>
      </CollapsibleSection>

      {constraintsDirty && (
        <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={saveConstraints} disabled={savingConstraints} style={saveBtnStyle}>
            {savingConstraints ? "Saving..." : "Save PPM Changes"}
          </button>
        </div>
      )}

      {/* ================================================================= */}
      {/* GROUP 2: Deal Structure                                           */}
      {/* ================================================================= */}

      <h2 style={groupHeadingStyle}>
        Group 2: Deal Structure <SourceBadge source="PPM" />
      </h2>

      {/* Section 6: Deal Identity */}
      <CollapsibleSection title="Deal Identity" defaultOpen>
        {Object.entries(dealIdentity).map(([key, val]) => (
          <div key={key} style={kvRowStyle}>
            <span style={kvLabelStyle}>{humanize(key)}</span>
            <InlineText
              value={val || ""}
              onChange={(v) => updateConstraint("dealIdentity", { ...constraints.dealIdentity, [key]: v })}
            />
          </div>
        ))}
      </CollapsibleSection>

      {/* Section 7: Key Dates */}
      <CollapsibleSection title="Key Dates">
        {Object.entries(keyDates).map(([key, val]) => (
          <div key={key} style={kvRowStyle}>
            <span style={kvLabelStyle}>{humanize(key)}</span>
            <InlineText
              value={val || ""}
              onChange={(v) => updateConstraint("keyDates", { ...constraints.keyDates, [key]: v })}
            />
          </div>
        ))}
      </CollapsibleSection>

      {/* Section 8: Capital Structure */}
      <CollapsibleSection title="Capital Structure">
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Class</th>
                <th style={thStyle}>Principal</th>
                <th style={thStyle}>Rate Type</th>
                <th style={thStyle}>Spread</th>
                <th style={thStyle}>Rating (Fitch)</th>
                <th style={thStyle}>Rating (Moody&apos;s)</th>
                <th style={thStyle}>Rating (S&amp;P)</th>
                <th style={{ ...thStyle, width: "2rem" }} />
              </tr>
            </thead>
            <tbody>
              {capStruct.map((row, i) => (
                <tr key={i}>
                  <td style={tdStyle}><InlineText value={row.class} onChange={(v) => updateCapStructRow(i, "class", v)} /></td>
                  <td style={tdStyle}><InlineText value={row.principalAmount} onChange={(v) => updateCapStructRow(i, "principalAmount", v)} /></td>
                  <td style={tdStyle}><InlineText value={row.rateType || ""} onChange={(v) => updateCapStructRow(i, "rateType", v)} /></td>
                  <td style={tdStyle}>
                    {(() => {
                      const normCls = (s: string) => s.replace(/^class\s+/i, "").replace(/\s+notes?$/i, "").trim().toLowerCase();
                      const resolvedTranche = resolved?.tranches.find(t => normCls(t.className) === normCls(row.class));
                      if (resolvedTranche && !resolvedTranche.isIncomeNote) {
                        return (
                          <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            <InlineNumber
                              value={resolvedTranche.spreadBps}
                              onChange={(v) => {
                                updateCapStructRow(i, "spreadBps", v ?? 0);
                                updateCapStructRow(i, "spread", v != null ? `${v}bps` : "");
                              }}
                            />
                            <span style={{
                              fontSize: "0.65rem",
                              padding: "0.1rem 0.3rem",
                              borderRadius: "3px",
                              background: resolvedTranche.source === "ppm" ? "#e8f0fe" : resolvedTranche.source === "snapshot" ? "#e6f4ea" : "#fef7e0",
                              color: "#555",
                            }}>
                              {resolvedTranche.source}
                            </span>
                          </span>
                        );
                      }
                      return <span style={{ color: "var(--color-text-muted)" }}>&mdash;</span>;
                    })()}
                  </td>
                  <td style={tdStyle}><InlineText value={row.rating?.fitch || ""} onChange={(v) => updateCapStructRow(i, "ratingFitch", v)} /></td>
                  <td style={tdStyle}><InlineText value={row.rating?.moodys || ""} onChange={(v) => updateCapStructRow(i, "ratingMoodys", v)} /></td>
                  <td style={tdStyle}><InlineText value={row.rating?.sp || ""} onChange={(v) => updateCapStructRow(i, "ratingSp", v)} /></td>
                  <td style={tdStyle}><button type="button" onClick={() => removeCapStructRow(i)} style={removeBtnStyle} title="Remove">&times;</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" onClick={addCapStructRow} style={addBtnStyle}>+ Add row</button>
      </CollapsibleSection>

      {/* Section 9: Deal Sizing */}
      <CollapsibleSection title="Deal Sizing">
        {Object.entries(dealSizing).map(([key, val]) => (
          <div key={key} style={kvRowStyle}>
            <span style={kvLabelStyle}>{humanize(key)}</span>
            <InlineText
              value={val || ""}
              onChange={(v) => updateConstraint("dealSizing", { ...constraints.dealSizing, [key]: v })}
            />
          </div>
        ))}
      </CollapsibleSection>

      {/* Section 10: Waterfall */}
      <CollapsibleSection title="Waterfall">
        {Object.entries(waterfall).map(([key, val]) => (
          <div key={key} style={{ marginBottom: "0.6rem" }}>
            <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.2rem" }}>{humanize(key)}</div>
            <InlineText
              value={val || ""}
              onChange={(v) => updateConstraint("waterfall", { ...constraints.waterfall, [key]: v })}
              multiline
            />
          </div>
        ))}
      </CollapsibleSection>

      {/* Section 11: Reinvestment Criteria */}
      <CollapsibleSection title="Reinvestment Criteria">
        {Object.entries(reinvCriteria).map(([key, val]) => (
          <div key={key} style={{ marginBottom: "0.6rem" }}>
            <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.2rem" }}>{humanize(key)}</div>
            <InlineText
              value={val || ""}
              onChange={(v) => updateConstraint("reinvestmentCriteria", { ...constraints.reinvestmentCriteria, [key]: v })}
              multiline
            />
          </div>
        ))}
      </CollapsibleSection>

      {/* Section 12: CM Details & Trading */}
      <CollapsibleSection title="CM Details &amp; Trading">
        <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 600, marginBottom: "0.4rem" }}>Collateral Manager</div>
        {Object.entries(cmDetails).map(([key, val]) => (
          <div key={key} style={kvRowStyle}>
            <span style={kvLabelStyle}>{humanize(key)}</span>
            <InlineText
              value={String(val ?? "")}
              onChange={(v) => updateConstraint("cmDetails", { ...constraints.cmDetails, [key]: v } as CMDetails)}
            />
          </div>
        ))}
        <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 600, margin: "0.8rem 0 0.4rem" }}>Trading Constraints</div>
        {Object.entries(cmTrading).map(([key, val]) => {
          if (Array.isArray(val)) {
            return (
              <div key={key} style={{ marginBottom: "0.5rem" }}>
                <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.2rem" }}>{humanize(key)}</div>
                <InlineStringList
                  items={val as string[]}
                  onChange={(items) => updateConstraint("cmTradingConstraints", { ...constraints.cmTradingConstraints, [key]: items })}
                />
              </div>
            );
          }
          return (
            <div key={key} style={kvRowStyle}>
              <span style={kvLabelStyle}>{humanize(key)}</span>
              <InlineText
                value={String(val ?? "")}
                onChange={(v) => updateConstraint("cmTradingConstraints", { ...constraints.cmTradingConstraints, [key]: v })}
              />
            </div>
          );
        })}
      </CollapsibleSection>

      {/* Section 13: Fees, Accounts, Key Parties */}
      <CollapsibleSection title="Fees, Accounts, Key Parties">
        {/* Fees */}
        <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 600, marginBottom: "0.4rem" }}>Fees</div>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Rate</th>
              <th style={thStyle}>Basis</th>
              <th style={thStyle}>Description</th>
              <th style={{ ...thStyle, width: "2rem" }} />
            </tr>
          </thead>
          <tbody>
            {feeRows.map((row, i) => (
              <tr key={i}>
                <td style={tdStyle}><InlineText value={row.name} onChange={(v) => updateFeeRow(i, "name", v)} /></td>
                <td style={tdStyle}><InlineText value={row.rate || ""} onChange={(v) => updateFeeRow(i, "rate", v)} /></td>
                <td style={tdStyle}><InlineText value={row.basis || ""} onChange={(v) => updateFeeRow(i, "basis", v)} /></td>
                <td style={tdStyle}><InlineText value={row.description || ""} onChange={(v) => updateFeeRow(i, "description", v)} /></td>
                <td style={tdStyle}><button type="button" onClick={() => removeFeeRow(i)} style={removeBtnStyle} title="Remove">&times;</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={addFeeRow} style={addBtnStyle}>+ Add row</button>

        {/* Accounts */}
        <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 600, margin: "0.8rem 0 0.4rem" }}>Accounts</div>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Purpose</th>
              <th style={{ ...thStyle, width: "2rem" }} />
            </tr>
          </thead>
          <tbody>
            {accountRows.map((row, i) => (
              <tr key={i}>
                <td style={tdStyle}><InlineText value={row.name} onChange={(v) => updateAccountRow(i, "name", v)} /></td>
                <td style={tdStyle}><InlineText value={row.purpose} onChange={(v) => updateAccountRow(i, "purpose", v)} /></td>
                <td style={tdStyle}><button type="button" onClick={() => removeAccountRow(i)} style={removeBtnStyle} title="Remove">&times;</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={addAccountRow} style={addBtnStyle}>+ Add row</button>

        {/* Key Parties */}
        <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 600, margin: "0.8rem 0 0.4rem" }}>Key Parties</div>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Role</th>
              <th style={thStyle}>Entity</th>
              <th style={{ ...thStyle, width: "2rem" }} />
            </tr>
          </thead>
          <tbody>
            {keyPartyRows.map((row, i) => (
              <tr key={i}>
                <td style={tdStyle}><InlineText value={row.role} onChange={(v) => updateKeyPartyRow(i, "role", v)} /></td>
                <td style={tdStyle}><InlineText value={row.entity} onChange={(v) => updateKeyPartyRow(i, "entity", v)} /></td>
                <td style={tdStyle}><button type="button" onClick={() => removeKeyPartyRow(i)} style={removeBtnStyle} title="Remove">&times;</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={addKeyPartyRow} style={addBtnStyle}>+ Add row</button>
      </CollapsibleSection>

      {constraintsDirty && (
        <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={saveConstraints} disabled={savingConstraints} style={saveBtnStyle}>
            {savingConstraints ? "Saving..." : "Save PPM Changes"}
          </button>
        </div>
      )}

      {/* ================================================================= */}
      {/* GROUP 3: Fund Profile & Portfolio                                  */}
      {/* ================================================================= */}

      <h2 style={groupHeadingStyle}>
        Group 3: Fund Profile &amp; Portfolio
      </h2>

      {/* Section 14: Fund Strategy & Preferences */}
      <CollapsibleSection title="Fund Strategy &amp; Preferences" badge="Profile" defaultOpen>
        <div style={{ marginBottom: "0.6rem" }}>
          <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.2rem" }}>
            Fund Strategy <SourceBadge source="Profile" />
          </div>
          <InlineText value={fundProfile.fundStrategy || ""} onChange={(v) => updateProfile("fundStrategy", v)} multiline />
        </div>
        <div style={kvRowStyle}>
          <span style={kvLabelStyle}>Risk Appetite <SourceBadge source="Profile" /></span>
          <InlineSelect
            value={fundProfile.riskAppetite || "moderate"}
            options={[
              { value: "conservative", label: "Conservative" },
              { value: "moderate", label: "Moderate" },
              { value: "aggressive", label: "Aggressive" },
            ]}
            onChange={(v) => updateProfile("riskAppetite", v)}
          />
        </div>
        <div style={{ marginBottom: "0.6rem" }}>
          <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.2rem" }}>
            Target Sectors <SourceBadge source="Profile" />
          </div>
          <InlineText value={fundProfile.targetSectors || ""} onChange={(v) => updateProfile("targetSectors", v)} multiline />
        </div>
        <div style={kvRowStyle}>
          <span style={kvLabelStyle}>Portfolio Size <SourceBadge source="Profile" /></span>
          <InlineText value={fundProfile.portfolioSize || ""} onChange={(v) => updateProfile("portfolioSize", v)} />
        </div>
      </CollapsibleSection>

      {/* Section 15: Beliefs & Thresholds */}
      <CollapsibleSection title="Beliefs &amp; Thresholds" badge="Profile">
        <div style={{ marginBottom: "0.6rem" }}>
          <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.2rem" }}>Beliefs &amp; Biases</div>
          <InlineText value={fundProfile.beliefsAndBiases || ""} onChange={(v) => updateProfile("beliefsAndBiases", v)} multiline />
        </div>
        <div style={kvRowStyle}>
          <span style={kvLabelStyle}>Rating Thresholds</span>
          <InlineText value={fundProfile.ratingThresholds || ""} onChange={(v) => updateProfile("ratingThresholds", v)} />
        </div>
        <div style={kvRowStyle}>
          <span style={kvLabelStyle}>Spread Targets</span>
          <InlineText value={fundProfile.spreadTargets || ""} onChange={(v) => updateProfile("spreadTargets", v)} />
        </div>
        <div style={{ marginBottom: "0.6rem" }}>
          <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.2rem" }}>Concentration Limits</div>
          <InlineText value={fundProfile.concentrationLimits || ""} onChange={(v) => updateProfile("concentrationLimits", v)} multiline />
        </div>
        <div style={{ marginBottom: "0.6rem" }}>
          <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 500, marginBottom: "0.2rem" }}>Regulatory Constraints</div>
          <InlineText value={fundProfile.regulatoryConstraints || ""} onChange={(v) => updateProfile("regulatoryConstraints", v)} multiline />
        </div>
      </CollapsibleSection>

      {/* Section: Equity Inception */}
      <CollapsibleSection title="Equity Inception">
        <div style={kvRowStyle}>
          <span style={kvLabelStyle}>Purchase Date</span>
          <input
            type="date"
            value={inceptionData.purchaseDate ?? ""}
            onChange={(e) => {
              setInceptionData(prev => ({ ...prev, purchaseDate: e.target.value || null }));
              setInceptionDirty(true);
            }}
            style={{ fontSize: "0.82rem", fontFamily: "var(--font-mono)", padding: "0.2rem 0.4rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)" }}
          />
        </div>
        <div style={kvRowStyle}>
          <span style={kvLabelStyle}>Purchase Price (cents)</span>
          <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
            <input
              type="number"
              step="0.5"
              min="1"
              max="150"
              value={inceptionData.purchasePriceCents ?? ""}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setInceptionData(prev => ({ ...prev, purchasePriceCents: isNaN(v) ? null : v }));
                setInceptionDirty(true);
              }}
              style={{ width: "70px", fontSize: "0.82rem", fontFamily: "var(--font-mono)", padding: "0.2rem 0.4rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)", textAlign: "right" }}
            />
            <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>cents on dollar</span>
          </div>
        </div>

        <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", fontWeight: 600, margin: "0.8rem 0 0.4rem" }}>
          Past Payments {inceptionData.payments.length > 0 && `(${inceptionData.payments.filter(p => p.distribution != null).length}/${inceptionData.payments.length} entered)`}
        </div>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Payment Date</th>
              <th style={thStyle}>Distribution</th>
              <th style={{ ...thStyle, width: "2rem" }} />
            </tr>
          </thead>
          <tbody>
            {inceptionData.payments.map((payment, i) => (
              <tr key={i}>
                <td style={tdStyle}>
                  <input
                    type="date"
                    value={payment.date}
                    onChange={(e) => {
                      setInceptionData(prev => {
                        const updated = [...prev.payments];
                        updated[i] = { ...updated[i], date: e.target.value };
                        return { ...prev, payments: updated };
                      });
                      setInceptionDirty(true);
                    }}
                    style={{ fontSize: "0.82rem", fontFamily: "var(--font-mono)", padding: "0.2rem 0.4rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)" }}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    type="number"
                    step="1000"
                    min="0"
                    value={payment.distribution ?? ""}
                    placeholder="--"
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setInceptionData(prev => {
                        const updated = [...prev.payments];
                        updated[i] = { ...updated[i], distribution: isNaN(v) ? null : v };
                        return { ...prev, payments: updated };
                      });
                      setInceptionDirty(true);
                    }}
                    style={{ width: "120px", fontSize: "0.82rem", fontFamily: "var(--font-mono)", padding: "0.2rem 0.4rem", border: "1px solid var(--color-border-light)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-text)", textAlign: "right" }}
                  />
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    onClick={() => {
                      setInceptionData(prev => ({
                        ...prev,
                        payments: prev.payments.filter((_, j) => j !== i),
                      }));
                      setInceptionDirty(true);
                    }}
                    style={removeBtnStyle}
                    title="Remove"
                  >&times;</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => {
              setInceptionData(prev => ({
                ...prev,
                payments: [...prev.payments, { date: "", distribution: null }],
              }));
              setInceptionDirty(true);
            }}
            style={addBtnStyle}
          >+ Add payment</button>
          {extractedDistributions && extractedDistributions.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setInceptionData(prev => ({
                  ...prev,
                  payments: extractedDistributions.map(d => ({ date: d.date, distribution: d.distribution })),
                }));
                setInceptionDirty(true);
              }}
              style={{ ...addBtnStyle, fontSize: "0.75rem" }}
            >Pre-fill from reports ({extractedDistributions.length})</button>
          )}
        </div>
      </CollapsibleSection>

      {inceptionDirty && (
        <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={saveInception} disabled={savingInception} style={saveBtnStyle}>
            {savingInception ? "Saving..." : "Save Inception Data"}
          </button>
        </div>
      )}

      {profileDirty && (
        <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={saveProfile} disabled={savingProfile} style={saveBtnStyle}>
            {savingProfile ? "Saving..." : "Save Profile Changes"}
          </button>
        </div>
      )}

      {/* Section 16: Pool Summary */}
      {complianceData && complianceData.poolSummary && (
        <CollapsibleSection title="Pool Summary" badge="Compliance Report">
          {([
            ["totalPar", "Total Par"],
            ["warf", "WARF"],
            ["walYears", "WAL (Years)"],
            ["diversityScore", "Diversity Score"],
            ["wacSpread", "WAC Spread"],
            ["pctCccAndBelow", "% CCC & Below"],
            ["pctFixedRate", "% Fixed Rate"],
            ["pctCovLite", "% Cov-Lite"],
            ["pctSecondLien", "% Second Lien"],
            ["pctSeniorSecured", "% Senior Secured"],
            ["pctBonds", "% Bonds"],
            ["pctDefaulted", "% Defaulted"],
          ] as [keyof CloPoolSummary, string][]).map(([field, label]) => (
            <div key={field} style={kvRowStyle}>
              <span style={kvLabelStyle}>{label} <SourceBadge source="Compliance Report" /></span>
              <InlineNumber
                value={complianceData.poolSummary![field] as number | null}
                onChange={(v) => {
                  updateCompliance("poolSummary", { ...complianceData.poolSummary!, [field]: v });
                }}
              />
            </div>
          ))}
        </CollapsibleSection>
      )}

      {/* Section 17: Concentrations */}
      {complianceData && complianceData.concentrations.length > 0 && (
        <CollapsibleSection title="Concentrations" badge="Compliance Report">
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Bucket</th>
                  <th style={thStyle}>Actual %</th>
                  <th style={thStyle}>Limit %</th>
                  <th style={thStyle}>Passing</th>
                </tr>
              </thead>
              <tbody>
                {complianceData.concentrations.map((c, i) => (
                  <tr key={c.id}>
                    <td style={tdStyle}>
                      <InlineText
                        value={c.concentrationType}
                        onChange={(v) => {
                          const rows = [...complianceData.concentrations];
                          rows[i] = { ...rows[i], concentrationType: v as CloConcentration["concentrationType"] };
                          updateCompliance("concentrations", rows);
                        }}
                      />
                    </td>
                    <td style={tdStyle}>
                      <InlineText
                        value={c.bucketName}
                        onChange={(v) => {
                          const rows = [...complianceData.concentrations];
                          rows[i] = { ...rows[i], bucketName: v };
                          updateCompliance("concentrations", rows);
                        }}
                      />
                    </td>
                    <td style={tdStyle}>
                      <InlineNumber
                        value={c.actualPct}
                        onChange={(v) => {
                          const rows = [...complianceData.concentrations];
                          rows[i] = { ...rows[i], actualPct: v };
                          updateCompliance("concentrations", rows);
                        }}
                      />
                    </td>
                    <td style={tdStyle}>
                      <InlineNumber
                        value={c.limitPct}
                        onChange={(v) => {
                          const rows = [...complianceData.concentrations];
                          rows[i] = { ...rows[i], limitPct: v };
                          updateCompliance("concentrations", rows);
                        }}
                      />
                    </td>
                    <td style={tdStyle}>
                      <InlineSelect
                        value={c.isPassing == null ? "" : c.isPassing ? "true" : "false"}
                        options={[
                          { value: "true", label: "Pass" },
                          { value: "false", label: "Fail" },
                          { value: "", label: "N/A" },
                        ]}
                        onChange={(v) => {
                          const rows = [...complianceData.concentrations];
                          rows[i] = { ...rows[i], isPassing: v === "" ? null : v === "true" };
                          updateCompliance("concentrations", rows);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CollapsibleSection>
      )}

      {complianceDirty && (
        <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={saveCompliance} disabled={savingCompliance} style={saveBtnStyle}>
            {savingCompliance ? "Saving..." : "Save Compliance Changes"}
          </button>
        </div>
      )}

      {/* Section 18: Remaining Structural */}
      {remainingKeys.length > 0 && (
        <>
          <h2 style={{ ...groupHeadingStyle, marginTop: "2rem" }}>
            Remaining Structural <SourceBadge source="PPM" />
          </h2>
          {remainingKeys.map((key) => {
            const val = constraints[key as keyof ExtractedConstraints];
            if (val == null) return null;

            // String
            if (typeof val === "string") {
              return (
                <CollapsibleSection key={key} title={humanize(key)}>
                  <InlineText
                    value={val}
                    onChange={(v) => updateConstraint(key as keyof ExtractedConstraints, v as ExtractedConstraints[keyof ExtractedConstraints])}
                    multiline={val.length > 80}
                  />
                </CollapsibleSection>
              );
            }

            // String array
            if (Array.isArray(val) && (val.length === 0 || typeof val[0] === "string")) {
              return (
                <CollapsibleSection key={key} title={humanize(key)}>
                  <InlineStringList
                    items={val as string[]}
                    onChange={(items) => updateConstraint(key as keyof ExtractedConstraints, items as ExtractedConstraints[keyof ExtractedConstraints])}
                  />
                </CollapsibleSection>
              );
            }

            // Object array
            if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
              const objArr = val as Record<string, unknown>[];
              const cols = Object.keys(objArr[0]);
              return (
                <CollapsibleSection key={key} title={humanize(key)}>
                  <table style={tableStyle}>
                    <thead>
                      <tr>{cols.map((c) => <th key={c} style={thStyle}>{humanize(c)}</th>)}</tr>
                    </thead>
                    <tbody>
                      {objArr.map((row, ri) => (
                        <tr key={ri}>
                          {cols.map((c) => (
                            <td key={c} style={tdStyle}>
                              <InlineText
                                value={String(row[c] ?? "")}
                                onChange={(v) => handleRemainingUpdate([key, String(ri), c], v)}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CollapsibleSection>
              );
            }

            // Plain object
            if (typeof val === "object" && !Array.isArray(val)) {
              return (
                <CollapsibleSection key={key} title={humanize(key)}>
                  {renderObjectFields(val as Record<string, unknown>, [key], handleRemainingUpdate)}
                </CollapsibleSection>
              );
            }

            return null;
          })}

          {constraintsDirty && (
            <div style={{ marginTop: "1rem", display: "flex", justifyContent: "flex-end" }}>
              <button onClick={saveConstraints} disabled={savingConstraints} style={saveBtnStyle}>
                {savingConstraints ? "Saving..." : "Save PPM Changes"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
