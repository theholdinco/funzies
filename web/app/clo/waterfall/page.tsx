import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  getProfileForUser,
  getDealForProfile,
  getLatestReportPeriod,
  getReportPeriodData,
  getWaterfallSteps,
  getTranches,
  getTrancheSnapshots,
  getAccountBalances,
  getParValueAdjustments,
  getHoldings,
  getTrades,
  getPanelForUser,
  getHistoricalSubNoteDistributions,
  getIntexPositionsByReportPeriod,
  rowToProfile,
} from "@/lib/clo/access";
import { getBuyListForUser } from "@/lib/clo/buy-list";
import type { ExtractedConstraints } from "@/lib/clo/types";
import { resolveWaterfallInputs } from "@/lib/clo/resolver";
import ProjectionModel from "./ProjectionModel";
import DataQualityCheck from "./DataQualityCheck";

export default async function WaterfallPage() {
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
  const deal = await getDealForProfile(profile.id);

  // Fetch report-level data if a deal record exists
  const reportPeriod = deal ? await getLatestReportPeriod(deal.id) : null;

  const [waterfallSteps, tranches, trancheSnapshots, periodData, accountBalances, parValueAdjustments, holdings, trades, extractedDistributions, intexPositions] =
    await Promise.all([
      reportPeriod ? getWaterfallSteps(reportPeriod.id) : Promise.resolve([]),
      deal ? getTranches(deal.id) : Promise.resolve([]),
      reportPeriod ? getTrancheSnapshots(reportPeriod.id) : Promise.resolve([]),
      reportPeriod ? getReportPeriodData(reportPeriod.id) : Promise.resolve(null),
      reportPeriod ? getAccountBalances(reportPeriod.id) : Promise.resolve([]),
      reportPeriod ? getParValueAdjustments(reportPeriod.id) : Promise.resolve([]),
      reportPeriod ? getHoldings(reportPeriod.id) : Promise.resolve([]),
      reportPeriod ? getTrades(reportPeriod.id) : Promise.resolve([]),
      deal ? getHistoricalSubNoteDistributions(deal.id) : Promise.resolve([]),
      reportPeriod ? getIntexPositionsByReportPeriod(reportPeriod.id) : Promise.resolve(new Map()),
    ]);

  const panel = await getPanelForUser(session.user.id);
  const buyList = await getBuyListForUser(session.user.id);

  // Resolve deal dates — prefer clo_deals, fall back to extractedConstraints
  const dealName =
    deal?.dealName ?? constraints.dealIdentity?.dealName ?? null;
  const maturityDate =
    deal?.statedMaturityDate ?? constraints.keyDates?.maturityDate ?? null;
  const reinvestmentPeriodEnd =
    deal?.reinvestmentPeriodEnd ?? constraints.keyDates?.reinvestmentPeriodEnd ?? null;

  const { resolved, warnings: resolutionWarnings } = resolveWaterfallInputs(
    constraints,
    periodData ? { poolSummary: periodData.poolSummary, complianceTests: periodData.complianceTests, concentrations: periodData.concentrations } : null,
    tranches,
    trancheSnapshots,
    holdings,
    { maturity: maturityDate, reinvestmentPeriodEnd, reportDate: reportPeriod?.reportDate ?? null, dealCurrency: deal?.dealCurrency ?? null },
    accountBalances,
    parValueAdjustments,
    intexPositions,
  );

  // Build deal context for AI features
  const dealContext = {
    dealName,
    dealCurrency: resolved.currency,
    maturityDate,
    reinvestmentPeriodEnd,
    poolSummary: periodData?.poolSummary ?? null,
    complianceTests: periodData?.complianceTests ?? [],
    concentrationTests: resolved.concentrationTests,
    tranches,
    resolvedTranches: resolved.tranches.map((t) => ({
      className: t.className,
      paymentFrequency: t.paymentFrequency ?? null,
      isIncomeNote: t.isIncomeNote,
      spreadBps: t.spreadBps,
      isFloating: t.isFloating,
    })),
    trancheSnapshots,
    accountBalances,
    collateralCurrencySummary: {
      totalLoans: resolved.loans.length,
      missingCurrencyCount: resolved.loans.filter((loan) => loan.parBalance > 0 && !loan.currency).length,
      currencies: Array.from(new Set(resolved.loans.map((loan) => loan.currency).filter(Boolean))).sort(),
    },
    deterministicWarnings: resolutionWarnings,
    constraints,
    reportDate: reportPeriod?.reportDate ?? null,
  };

  return (
    <div className="ic-dashboard" style={{ maxWidth: "1200px" }}>
      <h1
        style={{
          fontFamily: "var(--font-display)",
          marginBottom: "0.5rem",
          letterSpacing: "-0.01em",
        }}
      >
        Waterfall Model
      </h1>
      {dealName && (
        <p
          style={{
            color: "var(--color-text-muted)",
            marginBottom: "2rem",
            fontSize: "0.9rem",
          }}
        >
          {dealName}
          {reportPeriod && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.82rem" }}>
              {" "}&middot; {reportPeriod.reportDate}
            </span>
          )}
        </p>
      )}

      {panel && <DataQualityCheck panelId={panel.id} dealContext={dealContext} />}

      <ProjectionModel
        maturityDate={maturityDate}
        reinvestmentPeriodEnd={reinvestmentPeriodEnd}
        tranches={tranches}
        trancheSnapshots={trancheSnapshots}
        poolSummary={periodData?.poolSummary ?? null}
        complianceTests={periodData?.complianceTests ?? []}
        constraints={constraints}
        holdings={holdings}
        panelId={panel?.id ?? null}
        dealContext={dealContext}
        resolved={resolved}
        resolutionWarnings={resolutionWarnings}
        buyList={buyList}
        equityInceptionData={profile.equityInceptionData}
        intexAssumptions={deal?.intexAssumptions ?? null}
        extractedDistributions={extractedDistributions}
        closingDate={deal?.closingDate ?? constraints.keyDates?.originalIssueDate ?? null}
        waterfallSteps={waterfallSteps}
        accountBalances={accountBalances}
        trades={trades}
        reportDate={reportPeriod?.reportDate ?? null}
        paymentDate={reportPeriod?.paymentDate ?? null}
      />
    </div>
  );
}
