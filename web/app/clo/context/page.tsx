import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  getProfileForUser,
  getDealForProfile,
  getLatestReportPeriod,
  getReportPeriodData,
  rowToProfile,
} from "@/lib/clo/access";
import type { ExtractedConstraints, CloDocument } from "@/lib/clo/types";
import ContextEditor from "./ContextEditor";
import ResetProfile from "./ResetProfile";

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
  if (deal) {
    const latestPeriod = await getLatestReportPeriod(deal.id);
    if (latestPeriod) {
      const periodData = await getReportPeriodData(latestPeriod.id);
      complianceData = {
        reportPeriodId: latestPeriod.id,
        reportDate: latestPeriod.reportDate,
        poolSummary: periodData.poolSummary,
        complianceTests: periodData.complianceTests,
        concentrations: periodData.concentrations,
      };
    }
  }

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

      <ContextEditor
        constraints={constraints}
        fundProfile={fundProfile}
        complianceData={complianceData}
      />
    </div>
  );
}
