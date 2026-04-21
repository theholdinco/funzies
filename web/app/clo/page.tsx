import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { query } from "@/lib/db";
import { getProfileForUser, getProfileDocumentMeta, getPanelForUser, rowToProfile, getDealForProfile, getLatestReportPeriod, getReportPeriodData, getAccountBalances, getEvents, getHoldings } from "@/lib/clo/access";
import Link from "next/link";
import type { PanelMember } from "@/lib/clo/types";
import type { ExtractedConstraints, ExtractedPortfolio, ComplianceTest, PortfolioMetric, ConcentrationBreakdown, CloComplianceTest, CloConcentration, CloPoolSummary, CloAccountBalance, CloEvent, CapitalStructureEntry, CloHolding } from "@/lib/clo/types";
import UpdateComplianceReport from "./UpdateComplianceReport";
import DataQualityBadge from "./DataQualityBadge";
import DocumentUploadBanner from "./DocumentUploadBanner";
import SdfUploadSection from "./SdfUploadSection";
import BriefingCard from "@/components/BriefingCard";
import BuyListUpload from "./BuyListUpload";
import { getBuyListForProfile } from "@/lib/clo/buy-list";

function CLOHealthSummary({ constraints }: { constraints: Record<string, unknown> | null }) {
  if (!constraints || Object.keys(constraints).length === 0) return null;

  const c = constraints as unknown as ExtractedConstraints;
  const items: { label: string; value: string }[] = [];

  // Deal identity
  const dealName = c.dealIdentity?.dealName;
  if (dealName) items.push({ label: "Deal", value: dealName });

  const cmName = c.cmDetails?.name ?? c.collateralManager;
  if (cmName) items.push({ label: "CM", value: cmName });

  // Key metrics
  if (c.warfLimit != null) items.push({ label: "WARF Limit", value: String(c.warfLimit) });
  if (c.wasMinimum != null) items.push({ label: "WAS Min", value: `${c.wasMinimum} bps` });
  if (c.walMaximum != null) items.push({ label: "WAL Max", value: `${c.walMaximum}y` });
  if (c.diversityScoreMinimum != null) items.push({ label: "Diversity Min", value: String(c.diversityScoreMinimum) });

  // Dates — new fields first, then legacy
  const rpEnd = c.keyDates?.reinvestmentPeriodEnd ?? c.reinvestmentPeriod?.end;
  if (rpEnd) items.push({ label: "RP End", value: rpEnd });

  const ncEnd = c.keyDates?.nonCallPeriodEnd ?? c.nonCallPeriod?.end;
  if (ncEnd) items.push({ label: "Non-Call End", value: ncEnd });

  const maturity = c.keyDates?.maturityDate ?? c.maturityDate;
  if (maturity) items.push({ label: "Maturity", value: maturity });

  if (items.length === 0) return null;

  return (
    <section className="ic-section">
      <h2>Deal Overview</h2>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        gap: "0.75rem",
      }}>
        {items.map((item) => (
          <div
            key={item.label}
            style={{
              padding: "0.6rem 0.8rem",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <div style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {item.label}
            </div>
            <div style={{ fontSize: "0.95rem", fontWeight: 600, marginTop: "0.2rem" }}>
              {item.value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function cushionColor(cushion: number, trigger?: number | null): string {
  const relativeCushion = trigger != null && trigger !== 0
    ? (Math.abs(cushion) / Math.abs(trigger)) * 100
    : Math.abs(cushion);
  if (relativeCushion >= 5) return "var(--color-success, #22c55e)";
  if (relativeCushion >= 2) return "var(--color-warning, #eab308)";
  return "var(--color-error, #ef4444)";
}

function deduplicateTests(tests: CloComplianceTest[]): CloComplianceTest[] {
  const best = new Map<string, CloComplianceTest>();
  for (const t of tests) {
    const key = `${t.testName}::${t.testClass ?? ""}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, t);
    } else {
      // Keep the one with more data (non-null fields)
      const score = (c: CloComplianceTest) => [c.actualValue, c.triggerLevel, c.cushionPct, c.isPassing].filter((v) => v != null).length;
      if (score(t) > score(existing)) best.set(key, t);
    }
  }
  return Array.from(best.values());
}

function testBarColor(t: CloComplianceTest, cushion: number): string {
  if (t.isPassing === true) {
    const trigger = t.triggerLevel;
    if (trigger == null || trigger === 0) return "var(--color-success, #22c55e)";
    const relativeCushion = (Math.abs(cushion) / Math.abs(trigger)) * 100;
    if (relativeCushion >= 5) return "var(--color-success, #22c55e)";
    return "var(--color-warning, #eab308)";
  }
  if (t.isPassing === false) return "var(--color-error, #ef4444)";
  return cushionColor(cushion, t.triggerLevel);
}

function TestComplianceSection({ tests, newTests }: { tests?: ComplianceTest[]; newTests?: CloComplianceTest[] }) {
  // Filter out empty/zero-value tests from partial extractions, then deduplicate
  const validTests = newTests?.filter((t) => (t.actualValue != null && t.actualValue !== 0) || (t.triggerLevel != null && t.triggerLevel !== 0));
  const dedupedTests = validTests && validTests.length > 0 ? deduplicateTests(validTests) : undefined;
  if (dedupedTests && dedupedTests.length > 0) {
    return (
      <section className="ic-section">
        <h2>Test Compliance</h2>
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {dedupedTests.map((t) => {
            const actual = t.actualValue ?? 0;
            // Compute missing trigger from actual - cushion if we have cushion data
            const trigger = t.triggerLevel ?? (t.cushionPct != null ? actual - t.cushionPct : null);
            const hasTrigger = trigger != null && trigger !== 0;
            const triggerVal = trigger ?? 0;
            const cushion = t.cushionPct ?? (hasTrigger ? actual - triggerVal : null);
            const maxVal = Math.max(actual, triggerVal) * 1.1 || 1;
            const actualPct = (actual / maxVal) * 100;
            const triggerPct = hasTrigger ? (triggerVal / maxVal) * 100 : 0;
            const color = testBarColor(t, cushion ?? 0);
            return (
              <div key={t.id}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "0.25rem" }}>
                  <span style={{ fontWeight: 600 }}>{t.testName}{t.testClass ? ` (${t.testClass})` : ""}</span>
                  <span style={{ color: "var(--color-text-muted)" }}>
                    {actual.toFixed(1)}%
                    {hasTrigger && ` (trigger: ${triggerVal.toFixed(1)}%, cushion: ${cushion != null && cushion >= 0 ? "+" : ""}${cushion != null ? cushion.toFixed(1) : "?"}%)`}
                    {t.isPassing != null && (
                      <span style={{ marginLeft: "0.5rem", color: t.isPassing ? "var(--color-success, #22c55e)" : "var(--color-error, #ef4444)", fontWeight: 600 }}>
                        {t.isPassing ? "PASS" : "FAIL"}
                      </span>
                    )}
                  </span>
                </div>
                <div style={{ position: "relative", height: "1.25rem", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, height: "100%", width: `${actualPct}%`, background: color, opacity: 0.3, borderRadius: "var(--radius-sm)" }} />
                  {hasTrigger && (
                    <div style={{ position: "absolute", top: 0, left: `${triggerPct}%`, width: "2px", height: "100%", background: "var(--color-text-muted)" }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  // Legacy fallback
  if (!tests || tests.length === 0) return null;
  return (
    <section className="ic-section">
      <h2>Test Compliance</h2>
      <div style={{ display: "grid", gap: "0.75rem" }}>
        {tests.map((t) => {
          const actual = t.actual ?? 0;
          const trigger = t.trigger ?? 0;
          const cushion = t.cushion ?? 0;
          const maxVal = Math.max(actual, trigger) * 1.1 || 1;
          const actualPct = (actual / maxVal) * 100;
          const triggerPct = (trigger / maxVal) * 100;
          const color = cushionColor(cushion, trigger);
          return (
            <div key={t.name}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "0.25rem" }}>
                <span style={{ fontWeight: 600 }}>{t.name}</span>
                <span style={{ color: "var(--color-text-muted)" }}>
                  {(t.actual ?? 0).toFixed(1)}% (trigger: {(t.trigger ?? 0).toFixed(1)}%, cushion: {(t.cushion ?? 0) >= 0 ? "+" : ""}{(t.cushion ?? 0).toFixed(1)}%)
                </span>
              </div>
              <div style={{ position: "relative", height: "1.25rem", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, height: "100%", width: `${actualPct}%`, background: color, opacity: 0.3, borderRadius: "var(--radius-sm)" }} />
                <div style={{ position: "absolute", top: 0, left: `${triggerPct}%`, width: "2px", height: "100%", background: "var(--color-text-muted)" }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PoolMetricsSection({ poolSummary }: { poolSummary: CloPoolSummary }) {
  const metrics: { label: string; value: string; sub?: string }[] = [];

  if (poolSummary.totalPar != null) metrics.push({ label: "Total Par", value: poolSummary.totalPar.toLocaleString() });
  if (poolSummary.targetPar != null) metrics.push({ label: "Target Par", value: poolSummary.targetPar.toLocaleString() });
  if (poolSummary.numberOfObligors != null) metrics.push({ label: "Obligors", value: String(poolSummary.numberOfObligors) });
  if (poolSummary.numberOfAssets != null) metrics.push({ label: "Assets", value: String(poolSummary.numberOfAssets) });
  if (poolSummary.warf != null) metrics.push({ label: "WARF", value: String(poolSummary.warf) });
  if (poolSummary.walYears != null) metrics.push({ label: "WAL", value: `${poolSummary.walYears.toFixed(2)}y` });
  if (poolSummary.wacSpread != null) {
    // Extraction may return spread as percentage (e.g. 3.85) or bps (e.g. 385)
    const was = poolSummary.wacSpread;
    metrics.push({ label: "WAS", value: was < 20 ? `${was}%` : `${was} bps` });
  }
  if (poolSummary.diversityScore != null) metrics.push({ label: "Diversity", value: String(poolSummary.diversityScore) });
  if (poolSummary.waRecoveryRate != null) metrics.push({ label: "WA Recovery", value: `${poolSummary.waRecoveryRate.toFixed(1)}%` });
  if (poolSummary.pctCccAndBelow != null) metrics.push({ label: "CCC & Below", value: `${poolSummary.pctCccAndBelow.toFixed(1)}%` });
  if (poolSummary.pctDefaulted != null) metrics.push({ label: "Defaulted", value: `${poolSummary.pctDefaulted.toFixed(1)}%` });
  if (poolSummary.pctFixedRate != null) metrics.push({ label: "Fixed Rate", value: `${poolSummary.pctFixedRate.toFixed(1)}%` });
  if (poolSummary.pctCovLite != null) metrics.push({ label: "Cov-Lite", value: `${poolSummary.pctCovLite.toFixed(1)}%` });

  if (metrics.length === 0) return null;

  return (
    <section className="ic-section">
      <h2>Pool Metrics</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: "0.75rem" }}>
        {metrics.map((m) => (
          <div
            key={m.label}
            style={{
              padding: "0.6rem 0.8rem",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <div style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {m.label}
            </div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700, marginTop: "0.2rem" }}>
              {m.value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PortfolioMetricsSection({ metrics }: { metrics: PortfolioMetric[] }) {
  if (!metrics || metrics.length === 0) return null;
  return (
    <section className="ic-section">
      <h2>Portfolio Metrics</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "0.75rem" }}>
        {metrics.map((m) => {
          const ratio = m.limit > 0 && m.current > 0
            ? (m.direction === "max" ? (m.current / m.limit) * 100 : (m.limit / m.current) * 100)
            : 0;
          const pct = Math.min(ratio, 100);
          const color = m.passing
            ? "var(--color-success, #22c55e)"
            : "var(--color-error, #ef4444)";
          return (
            <div key={m.name} style={{ padding: "0.6rem 0.8rem", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--color-text-muted)", marginBottom: "0.3rem" }}>
                <span style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.name}</span>
                <span>{m.direction === "max" ? "max" : "min"}: {m.limit}</span>
              </div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: "0.4rem" }}>{m.current}</div>
              <div style={{ height: "0.4rem", background: "var(--color-border)", borderRadius: "2px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: "2px" }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CccBucketSection({ ccc }: { ccc?: ExtractedPortfolio["cccBucket"] }) {
  if (!ccc) return null;
  const pct = ccc.limit > 0 ? (ccc.current / ccc.limit) * 100 : 0;
  const color = pct < 70
    ? "var(--color-success, #22c55e)"
    : pct < 90
      ? "var(--color-warning, #eab308)"
      : "var(--color-error, #ef4444)";
  return (
    <section className="ic-section">
      <h2>CCC Bucket</h2>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <span style={{ fontSize: "1.2rem", fontWeight: 700 }}>{ccc.current}%</span>
        <span style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>/ {ccc.limit}% limit</span>
      </div>
      <div style={{ height: "0.5rem", background: "var(--color-border)", borderRadius: "3px", overflow: "hidden", marginBottom: "0.75rem" }}>
        <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: color, borderRadius: "3px" }} />
      </div>
      {ccc.holdings && ccc.holdings.length > 0 && (
        <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
          <span style={{ fontWeight: 600 }}>CCC Holdings:</span>{" "}
          {ccc.holdings.join(", ")}
        </div>
      )}
    </section>
  );
}

function NewConcentrationsSection({ concentrations }: { concentrations: CloConcentration[] }) {
  if (!concentrations || concentrations.length === 0) return null;

  const byType = new Map<string, CloConcentration[]>();
  for (const c of concentrations) {
    const group = byType.get(c.concentrationType) ?? [];
    group.push(c);
    byType.set(c.concentrationType, group);
  }

  const typeLabels: Record<string, string> = {
    INDUSTRY: "By Industry",
    COUNTRY: "By Country",
    SINGLE_OBLIGOR: "Top Obligor Exposures",
    RATING: "By Rating",
    MATURITY: "By Maturity",
    SPREAD: "By Spread",
    ASSET_TYPE: "By Asset Type",
    CURRENCY: "By Currency",
  };

  const entries = Array.from(byType.entries());
  const columns = Math.min(entries.length, 3);
  const gridCols = columns >= 3 ? "1fr 1fr 1fr" : columns === 2 ? "1fr 1fr" : "1fr";

  const hasSingleObligor = byType.has("SINGLE_OBLIGOR");

  return (
    <section className="ic-section">
      <h2>Concentrations</h2>
      <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: "1.5rem" }}>
        {entries.map(([type, items]) => (
          <div key={type}>
            <h3 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}>{typeLabels[type] ?? type}</h3>
            {items.slice(0, 10).map((item) => (
              <div key={item.id} style={{ marginBottom: "0.4rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", marginBottom: "0.15rem" }}>
                  <span>{item.bucketName}</span>
                  <span>{item.actualPct != null ? `${item.actualPct.toFixed(1)}%` : ""}{item.limitPct != null ? ` / ${item.limitPct}%` : ""}</span>
                </div>
                <div style={{ position: "relative", height: "0.5rem", background: "var(--color-border)", borderRadius: "3px", overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${Math.min(item.actualPct ?? 0, 100)}%`,
                    background: item.isPassing === false || (item.actualPct != null && item.limitPct != null && item.actualPct > item.limitPct)
                      ? "var(--color-error, #ef4444)"
                      : "var(--color-success, #22c55e)",
                    borderRadius: "3px",
                  }} />
                  {item.limitPct != null && (
                    <div style={{ position: "absolute", top: 0, left: `${Math.min(item.limitPct, 100)}%`, width: "2px", height: "100%", background: "var(--color-text-muted)" }} />
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {hasSingleObligor && (
        <p style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", marginTop: "0.75rem", fontStyle: "italic" }}>
          Obligor names from compliance test section. Names may differ from holdings schedule.
        </p>
      )}
    </section>
  );
}

function LegacyConcentrationsSection({ concentrations }: { concentrations: ExtractedPortfolio["concentrations"] }) {
  if (!concentrations) return null;
  const hasSector = concentrations.bySector?.length > 0;
  const hasRating = concentrations.byRating?.length > 0;
  const hasTop = concentrations.topExposures?.length > 0;
  if (!hasSector && !hasRating && !hasTop) return null;

  function renderBars(items: ConcentrationBreakdown[]) {
    return items.map((item) => (
      <div key={item.category} style={{ marginBottom: "0.4rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", marginBottom: "0.15rem" }}>
          <span>{item.category}</span>
          <span>{(item.percentage ?? 0).toFixed(1)}%{item.limit != null ? ` / ${item.limit}%` : ""}</span>
        </div>
        <div style={{ position: "relative", height: "0.5rem", background: "var(--color-border)", borderRadius: "3px", overflow: "hidden" }}>
          <div style={{
            height: "100%",
            width: `${Math.min(item.percentage ?? 0, 100)}%`,
            background: item.limit != null && (item.percentage ?? 0) > item.limit
              ? "var(--color-error, #ef4444)"
              : "var(--color-accent)",
            borderRadius: "3px",
          }} />
          {item.limit != null && (
            <div style={{ position: "absolute", top: 0, left: `${Math.min(item.limit, 100)}%`, width: "2px", height: "100%", background: "var(--color-text-muted)" }} />
          )}
        </div>
      </div>
    ));
  }

  const columns = [hasSector, hasRating, hasTop].filter(Boolean).length;
  const gridCols = columns >= 3 ? "1fr 1fr 1fr" : columns === 2 ? "1fr 1fr" : "1fr";

  return (
    <section className="ic-section">
      <h2>Concentrations</h2>
      <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: "1.5rem" }}>
        {hasSector && (
          <div>
            <h3 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}>By Sector</h3>
            {renderBars(concentrations.bySector)}
          </div>
        )}
        {hasRating && (
          <div>
            <h3 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}>By Rating</h3>
            {renderBars(concentrations.byRating)}
          </div>
        )}
        {hasTop && (
          <div>
            <h3 style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}>Top Exposures</h3>
            {renderBars(concentrations.topExposures)}
          </div>
        )}
      </div>
    </section>
  );
}

function AccountBalancesSection({ balances }: { balances: CloAccountBalance[] }) {
  const withData = balances?.filter((b) => b.balanceAmount != null && b.balanceAmount !== 0);
  if (!withData || withData.length === 0) return null;

  return (
    <section className="ic-section">
      <h2>Account Balances</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0.75rem" }}>
        {withData.map((b) => (
          <div
            key={b.id}
            style={{
              padding: "0.6rem 0.8rem",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <div style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.2rem" }}>
              {b.accountName}
              {b.accountType && <span style={{ marginLeft: "0.3rem", fontWeight: 400 }}>({b.accountType})</span>}
            </div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>
              {b.balanceAmount != null ? b.balanceAmount.toLocaleString() : "N/A"}
              {b.currency && <span style={{ fontSize: "0.75rem", fontWeight: 400, marginLeft: "0.3rem" }}>{b.currency}</span>}
            </div>
            {b.requiredBalance != null && (
              <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginTop: "0.2rem" }}>
                Required: {b.requiredBalance.toLocaleString()}
                {b.excessDeficit != null && (
                  <span style={{ marginLeft: "0.4rem", color: b.excessDeficit >= 0 ? "var(--color-success, #22c55e)" : "var(--color-error, #ef4444)" }}>
                    ({b.excessDeficit >= 0 ? "+" : ""}{b.excessDeficit.toLocaleString()})
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function EventsSection({ events }: { events: CloEvent[] }) {
  if (!events || events.length === 0) return null;

  return (
    <section className="ic-section">
      <h2>Recent Events</h2>
      <div style={{ display: "grid", gap: "0.5rem" }}>
        {events.slice(0, 10).map((e) => (
          <div
            key={e.id}
            style={{
              padding: "0.5rem 0.8rem",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              display: "flex",
              gap: "0.75rem",
              alignItems: "baseline",
            }}
          >
            <span style={{
              fontSize: "0.7rem",
              fontWeight: 600,
              padding: "0.15rem 0.4rem",
              borderRadius: "var(--radius-sm)",
              background: e.isEventOfDefault ? "var(--color-error, #ef4444)" : "var(--color-accent-subtle)",
              color: e.isEventOfDefault ? "#fff" : "var(--color-accent)",
              whiteSpace: "nowrap",
            }}>
              {e.eventType ?? "EVENT"}
            </span>
            {e.eventDate && (
              <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>{e.eventDate}</span>
            )}
            <span style={{ fontSize: "0.8rem", flex: 1 }}>{e.description}</span>
            {e.isCured && (
              <span style={{ fontSize: "0.7rem", color: "var(--color-success, #22c55e)", fontWeight: 600 }}>CURED</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function HoldingsPreview({ holdings }: { holdings: ExtractedPortfolio["holdings"] }) {
  if (!holdings || holdings.length === 0) return null;
  const top20 = [...holdings].sort((a, b) => b.notional - a.notional).slice(0, 20);
  return (
    <section className="ic-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Top Holdings ({holdings.length} total)</h2>
        <Link href="/clo/holdings" className="ic-section-link" style={{ marginTop: 0 }}>
          View all &rarr;
        </Link>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--color-border)", textAlign: "left" }}>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Issuer</th>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)", textAlign: "right" }}>Notional (K)</th>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Rating</th>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)", textAlign: "right" }}>Spread</th>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Sector</th>
            </tr>
          </thead>
          <tbody>
            {top20.map((h, i) => (
              <tr key={i} style={{ borderBottom: "1px solid var(--color-border)" }}>
                <td style={{ padding: "0.4rem 0.6rem" }}>{h.issuer}</td>
                <td style={{ padding: "0.4rem 0.6rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{h.notional.toLocaleString()}</td>
                <td style={{ padding: "0.4rem 0.6rem" }}>{h.rating}</td>
                <td style={{ padding: "0.4rem 0.6rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{h.spread}</td>
                <td style={{ padding: "0.4rem 0.6rem" }}>{h.sector}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function completenessScore(entry: CapitalStructureEntry): number {
  let score = 0;
  if (entry.principalAmount && !/not specified/i.test(entry.principalAmount)) score += 3;
  if (entry.rating?.fitch) score += 2;
  if (entry.rating?.sp) score += 2;
  if (entry.spread && entry.spread !== "—") score += 1;
  if (entry.deferrable != null) score += 1;
  return score;
}

function normalizeClassKey(name: string | undefined): string {
  if (!name) return "UNKNOWN";
  return name.replace(/^class\s+/i, "").replace(/-?RR$/i, "").replace(/\s+notes?$/i, "").trim().toUpperCase();
}

function CapitalStructureSection({ capitalStructure }: { capitalStructure: CapitalStructureEntry[] }) {
  if (!capitalStructure || capitalStructure.length === 0) return null;

  const bestByClass = new Map<string, CapitalStructureEntry>();
  for (const entry of capitalStructure) {
    const key = normalizeClassKey(entry.class);
    const existing = bestByClass.get(key);
    if (!existing || completenessScore(entry) > completenessScore(existing)) {
      bestByClass.set(key, entry);
    }
  }
  const deduplicated = Array.from(bestByClass.values());

  return (
    <section className="ic-section">
      <h2>Capital Structure</h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--color-border)", textAlign: "left" }}>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Class</th>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)", textAlign: "right" }}>Principal Amount</th>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Spread</th>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Rating (Fitch / S&P)</th>
              <th style={{ padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)" }}>Deferrable</th>
            </tr>
          </thead>
          <tbody>
            {deduplicated.map((entry) => (
              <tr key={entry.class} style={{ borderBottom: "1px solid var(--color-border)" }}>
                <td style={{ padding: "0.4rem 0.6rem", fontWeight: 600 }}>{entry.class}</td>
                <td style={{ padding: "0.4rem 0.6rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{entry.principalAmount}</td>
                <td style={{ padding: "0.4rem 0.6rem" }}>{entry.spread || "—"}</td>
                <td style={{ padding: "0.4rem 0.6rem" }}>{[entry.rating?.fitch, entry.rating?.sp].filter(Boolean).join(" / ") || "—"}</td>
                <td style={{ padding: "0.4rem 0.6rem" }}>{entry.deferrable == null ? "—" : entry.deferrable ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NewHoldingsPreview({ holdings }: { holdings: CloHolding[] }) {
  if (!holdings || holdings.length === 0) return null;
  const totalPar = holdings.reduce((sum, h) => sum + (h.parBalance ?? 0), 0);
  const top10 = [...holdings].sort((a, b) => (b.parBalance ?? 0) - (a.parBalance ?? 0)).slice(0, 10);
  return (
    <section className="ic-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <h2 style={{ margin: 0 }}>Top 10 Obligors ({holdings.length} total)</h2>
        <Link href="/clo/holdings" className="ic-section-link" style={{ marginTop: 0 }}>
          View all &rarr;
        </Link>
      </div>
      <div>
        {top10.map((h) => {
          const pct = totalPar > 0 && h.parBalance != null ? (h.parBalance / totalPar) * 100 : 0;
          return (
            <div key={h.id} style={{ marginBottom: "0.4rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "0.15rem" }}>
                <span>{h.obligorName ?? "—"}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{pct.toFixed(1)}%</span>
              </div>
              <div style={{ height: "0.4rem", background: "var(--color-border)", borderRadius: "3px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(pct * 5, 100)}%`, background: "var(--color-accent)", borderRadius: "3px" }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface AnalysisRow {
  id: string;
  title: string;
  borrower_name: string;
  analysis_type: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export default async function CLODashboard() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const profile = await getProfileForUser(session.user.id);

  if (!profile) {
    return (
      <div className="ic-dashboard">
        <div className="ic-empty-state">
          <h1>Credit Panel</h1>
          <p>
            Upload your PPM and compliance report to get started. We&apos;ll extract
            your CLO&apos;s constraints and build a bespoke panel of credit specialists.
          </p>
          <Link href="/clo/onboarding" className="btn-primary">
            Get Started
          </Link>
        </div>
      </div>
    );
  }

  const cloProfile = rowToProfile(profile as unknown as Record<string, unknown>);
  const buyListItems = await getBuyListForProfile(cloProfile.id);
  const portfolio = cloProfile.extractedPortfolio;
  const documentMeta = await getProfileDocumentMeta(session.user.id);
  const hasDocuments = documentMeta.length > 0;

  // Fetch new extraction data
  const deal = await getDealForProfile(cloProfile.id);
  let reportPeriod: Awaited<ReturnType<typeof getLatestReportPeriod>> = null;
  let periodData: Awaited<ReturnType<typeof getReportPeriodData>> | null = null;
  let accountBalances: CloAccountBalance[] = [];
  let events: CloEvent[] = [];
  let newHoldings: CloHolding[] = [];

  if (deal) {
    reportPeriod = await getLatestReportPeriod(deal.id);
    if (reportPeriod) {
      periodData = await getReportPeriodData(reportPeriod.id);
      accountBalances = await getAccountBalances(reportPeriod.id);
      events = await getEvents(deal.id);
      newHoldings = await getHoldings(reportPeriod.id);
    }
  }

  const hasNewData = periodData != null;
  const hasPortfolioData = hasNewData || portfolio != null;
  const reportDate = reportPeriod?.reportDate ?? portfolio?.reportDate;

  const panel = await getPanelForUser(session.user.id);

  if (!panel || panel.status === "queued" || panel.status === "generating") {
    return (
      <div className="ic-dashboard">
        <div className="ic-empty-state">
          <h1>Panel Generating</h1>
          <p>
            Your credit panel is being assembled. This typically takes a
            few minutes. Refresh to check progress.
          </p>
          {panel && (
            <Link href="/clo/panel/generating" className="btn-secondary">
              View Progress
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (panel.status === "error") {
    return (
      <div className="ic-dashboard">
        <div className="ic-empty-state">
          <h1>Panel Error</h1>
          <p>
            There was an issue generating your panel.{" "}
            {panel.error_message || "Please try again."}
          </p>
          <Link href="/clo/onboarding" className="btn-primary">
            Retry Onboarding
          </Link>
        </div>
      </div>
    );
  }

  const members = (panel.members || []) as PanelMember[];

  const analyses = await query<AnalysisRow>(
    `SELECT id, title, borrower_name, analysis_type, status, created_at, completed_at
     FROM clo_analyses
     WHERE panel_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [panel.id]
  );

  return (
    <div className="ic-dashboard">
      <header className="ic-dashboard-header">
        <div>
          <h1>Credit Panel</h1>
          <p>
            {members.length} member{members.length !== 1 ? "s" : ""} &middot;{" "}
            {analyses.length} analysis{analyses.length !== 1 ? "es" : ""}
          </p>
        </div>
        <div className="ic-dashboard-actions">
          <Link href="/clo/chat" className="btn-primary">
            Chat with Analyst
          </Link>
          <Link href="/clo/analyze/new" className="btn-secondary">
            New Analysis
          </Link>
          <Link href="/clo/screenings" className="btn-secondary">
            Portfolio Screening
          </Link>
        </div>
      </header>

      <BriefingCard product="clo" />

      <DocumentUploadBanner hasDocuments={hasDocuments} />
      {deal?.id && <SdfUploadSection dealId={deal.id} />}

      <BuyListUpload initialItems={buyListItems} />

      {documentMeta.length > 0 && (
        <section className="ic-section">
          <h2>CLO Documents</h2>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {documentMeta.map((doc, i) => (
              <span
                key={i}
                style={{
                  padding: "0.3rem 0.7rem",
                  background: "var(--color-accent-subtle)",
                  color: "var(--color-accent)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.8rem",
                  fontWeight: 500,
                }}
              >
                {doc.name}
              </span>
            ))}
          </div>
        </section>
      )}

      <CLOHealthSummary constraints={profile.extracted_constraints as Record<string, unknown> | null} />

      {cloProfile.extractedConstraints?.capitalStructure && cloProfile.extractedConstraints.capitalStructure.length > 0 && (
        <CapitalStructureSection capitalStructure={cloProfile.extractedConstraints.capitalStructure} />
      )}

      {hasDocuments && (
        <section className="ic-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>
              Portfolio State
              {reportDate && (
                <span style={{ fontSize: "0.75rem", fontWeight: 400, color: "var(--color-text-muted)", marginLeft: "0.5rem" }}>
                  as of {reportDate}
                </span>
              )}
            </h2>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <DataQualityBadge dataQuality={reportPeriod?.dataQuality ?? null} />
              <UpdateComplianceReport hasPortfolio={hasPortfolioData} />
            </div>
          </div>
          {!hasPortfolioData && (
            <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", marginTop: "0.5rem" }}>
              No portfolio data extracted yet. Click the button above to extract holdings, compliance tests, and concentrations from your compliance report.
            </p>
          )}
        </section>
      )}

      {hasNewData && (
        <>
          <TestComplianceSection newTests={periodData!.complianceTests} />
          {periodData!.poolSummary && <PoolMetricsSection poolSummary={periodData!.poolSummary} />}

          <NewConcentrationsSection concentrations={periodData!.concentrations} />
          <AccountBalancesSection balances={accountBalances} />
          <EventsSection events={events} />
          {newHoldings.length > 0 && !periodData!.concentrations?.some(c => c.concentrationType === "SINGLE_OBLIGOR") ? (
            <NewHoldingsPreview holdings={newHoldings} />
          ) : portfolio?.holdings && portfolio.holdings.length > 0 ? (
            <HoldingsPreview holdings={portfolio.holdings} />
          ) : null}
        </>
      )}

      {!hasNewData && portfolio && (
        <>
          <TestComplianceSection tests={portfolio.testResults} />
          <PortfolioMetricsSection metrics={portfolio.metrics} />
          <CccBucketSection ccc={portfolio.cccBucket} />
          <LegacyConcentrationsSection concentrations={portfolio.concentrations} />
          <HoldingsPreview holdings={portfolio.holdings} />
        </>
      )}

      <section className="ic-section">
        <h2>Your Panel</h2>
        <div className="ic-member-grid">
          {members.slice(0, 6).map((m) => (
            <div key={m.number} className="ic-member-card">
              <div className="ic-member-name">{m.name}</div>
              <div className="ic-member-role">{m.role}</div>
              <div className="ic-member-spec">
                {m.specializations?.slice(0, 2).join(", ")}
              </div>
            </div>
          ))}
        </div>
        <Link href="/clo/panel" className="ic-section-link">
          View full panel &rarr;
        </Link>
      </section>

      <section className="ic-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
          <h2 style={{ margin: 0 }}>Recent Analyses</h2>
          <Link href="/clo/analyses" className="ic-section-link" style={{ marginTop: 0 }}>
            View all &rarr;
          </Link>
        </div>
        {analyses.length > 0 ? (
          <div className="ic-eval-list">
            {analyses.map((a) => (
              <Link
                key={a.id}
                href={`/clo/analyze/${a.id}`}
                className="ic-eval-card"
              >
                <div className="ic-eval-title">
                  {a.title || a.borrower_name}
                </div>
                <div className="ic-eval-meta">
                  <span className={`ic-eval-status ic-eval-status-${a.status}`}>
                    {a.status}
                  </span>
                  <span className="ic-eval-type-tag">{a.analysis_type}</span>
                  <span>
                    {new Date(a.created_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
            No analyses yet. Use &ldquo;New Analysis&rdquo; to evaluate a credit opportunity.
          </p>
        )}
      </section>
    </div>
  );
}
