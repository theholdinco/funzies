import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  getProfileForUser,
  getDealForProfile,
  getLatestReportPeriod,
  getReportPeriodData,
  getTranches,
  getTrancheSnapshots,
  getAccountBalances,
  getParValueAdjustments,
  getHoldings,
  getHistoricalSubNoteDistributions,
  getAccruals,
  getTrades,
  getTradingSummary,
  getWaterfallSteps,
  getEvents,
  getSupplementaryData,
  getProceeds,
  getOverflow,
  rowToProfile,
} from "@/lib/clo/access";
import type { ExtractedConstraints, CloDocument } from "@/lib/clo/types";
import ContextEditor from "./ContextEditor";
import ResetProfile from "./ResetProfile";
import JsonUploadSection from "./JsonUploadSection";

export default async function ContextPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const profileRow = await getProfileForUser(session.user.id);
  if (!profileRow) {
    redirect("/clo/onboarding");
  }

  const profile = rowToProfile(profileRow as unknown as Record<string, unknown>);
  const constraints = (profile.extractedConstraints || {}) as ExtractedConstraints;
  const documents = (profile.documents || []) as CloDocument[];

  const fundProfile = {
    fundStrategy: profile.fundStrategy,
    targetSectors: profile.targetSectors,
    riskAppetite: profile.riskAppetite,
    portfolioSize: profile.portfolioSize,
    reinvestmentPeriod: profile.reinvestmentPeriod,
    concentrationLimits: profile.concentrationLimits,
    covenantPreferences: profile.covenantPreferences,
    ratingThresholds: profile.ratingThresholds,
    spreadTargets: profile.spreadTargets,
    regulatoryConstraints: profile.regulatoryConstraints,
    portfolioDescription: profile.portfolioDescription,
    beliefsAndBiases: profile.beliefsAndBiases,
  };

  let complianceData = null;
  const deal = await getDealForProfile(profile.id);
  const reportPeriod = deal ? await getLatestReportPeriod(deal.id) : null;

  const [tranches, trancheSnapshots, holdings, periodData, accountBalances, parValueAdjustments, extractedDistributions, accruals, trades, tradingSummary, waterfallSteps, events, supplementaryData, proceeds, overflow] = await Promise.all([
    deal ? getTranches(deal.id) : Promise.resolve([]),
    reportPeriod ? getTrancheSnapshots(reportPeriod.id) : Promise.resolve([]),
    reportPeriod ? getHoldings(reportPeriod.id) : Promise.resolve([]),
    reportPeriod ? getReportPeriodData(reportPeriod.id) : Promise.resolve(null),
    reportPeriod ? getAccountBalances(reportPeriod.id) : Promise.resolve([]),
    reportPeriod ? getParValueAdjustments(reportPeriod.id) : Promise.resolve([]),
    deal ? getHistoricalSubNoteDistributions(deal.id) : Promise.resolve([]),
    reportPeriod ? getAccruals(reportPeriod.id) : Promise.resolve([]),
    reportPeriod ? getTrades(reportPeriod.id) : Promise.resolve([]),
    reportPeriod ? getTradingSummary(reportPeriod.id) : Promise.resolve(null),
    reportPeriod ? getWaterfallSteps(reportPeriod.id) : Promise.resolve([]),
    deal ? getEvents(deal.id) : Promise.resolve([]),
    reportPeriod ? getSupplementaryData(reportPeriod.id) : Promise.resolve(null),
    reportPeriod ? getProceeds(reportPeriod.id) : Promise.resolve([]),
    reportPeriod ? getOverflow(reportPeriod.id) : Promise.resolve([]),
  ]);

  if (reportPeriod && periodData) {
    complianceData = {
      reportPeriodId: reportPeriod.id,
      reportDate: reportPeriod.reportDate,
      poolSummary: periodData.poolSummary,
      complianceTests: periodData.complianceTests,
      concentrations: periodData.concentrations,
    };
  }

  const maturityDate =
    deal?.statedMaturityDate ?? constraints.keyDates?.maturityDate ?? null;
  const reinvestmentPeriodEnd =
    deal?.reinvestmentPeriodEnd ?? constraints.keyDates?.reinvestmentPeriodEnd ?? null;

  return (
    <div className="ic-content">
      <div className="standalone-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1>Context Editor</h1>
            <p style={{ color: "var(--color-text-secondary)", fontSize: "0.85rem" }}>
              View and edit the extracted data that feeds into every analysis and chat interaction.
            </p>
          </div>
          <ResetProfile />
        </div>
      </div>

      {documents.length > 0 && (
        <section className="ic-section" style={{ marginBottom: "1.5rem" }}>
          <h2 style={{ fontSize: "0.9rem", margin: "0 0 0.5rem" }}>Uploaded Documents</h2>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {documents.map((doc, i) => (
              <div
                key={i}
                style={{
                  padding: "0.4rem 0.7rem",
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.8rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                }}
              >
                <span style={{ opacity: 0.5 }}>PDF</span>
                <span>{doc.name || `Document ${i + 1}`}</span>
                {doc.docType && (
                  <span style={{ fontSize: "0.7rem", color: "var(--color-text-muted)", textTransform: "uppercase" }}>
                    {doc.docType}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <JsonUploadSection />

      <ContextEditor
        constraints={constraints}
        fundProfile={fundProfile}
        complianceData={complianceData}
        tranches={tranches}
        trancheSnapshots={trancheSnapshots}
        holdings={holdings}
        accountBalances={accountBalances}
        parValueAdjustments={parValueAdjustments}
        dealDates={{ maturity: maturityDate, reinvestmentPeriodEnd, reportDate: reportPeriod?.reportDate ?? null }}
        equityInceptionData={profile.equityInceptionData}
        extractedDistributions={extractedDistributions}
        accruals={accruals}
        trades={trades}
        tradingSummary={tradingSummary}
        waterfallSteps={waterfallSteps}
        events={events}
        supplementaryData={supplementaryData}
        proceeds={proceeds}
        overflow={overflow}
      />
    </div>
  );
}
