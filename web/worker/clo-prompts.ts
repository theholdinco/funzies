import type { CloProfile, PanelMember, LoanAnalysis, ExtractedPortfolio, ExtractedConstraints, CloPoolSummary, CloComplianceTest, CloConcentration, CloEvent, CloExtractionOverflow } from "../lib/clo/types.js";

const QUALITY_RULES = `
## Quality Rules
- Source honesty: never fabricate data, studies, or statistics. Use "based on professional judgment" when no hard data exists.
- Stay on the question: >80% of your response must be direct answer. No filler.
- Practical and actionable: this is for real credit decisions, not an academic exercise.
- Speak plainly: if stripping jargon makes the idea disappear, there was no idea.
- Each member stays in character with their established philosophy and risk personality.
- WEB SEARCH: You have web search available. Use it to verify claims, check recent news about borrowers or sectors, find current market data, and confirm financial details. Always cite your sources when referencing search results.
- SLOP BAN — the following phrases are BANNED. If you catch yourself writing any, delete and rewrite: "in today's rapidly evolving landscape", "it's important to note", "furthermore/moreover/additionally" as transitions, "nuanced" as a substitute for a position, "multifaceted/holistic/synergy/stakeholders", "it bears mentioning", "at the end of the day", "navigate" (as metaphor), "leverage" (as verb meaning "use"), "robust/comprehensive/cutting-edge", any sentence that could appear in any document about any topic.`;

function formatConstraints(constraints: CloProfile["extractedConstraints"], mode: "compact" | "full" = "full"): string {
  if (!constraints || Object.keys(constraints).length === 0) return "";
  const c = constraints as ExtractedConstraints;

  // Helper: resolve new fields with legacy fallback
  const targetPar = c.dealSizing?.targetParAmount ?? c.targetParAmount;
  const cmName = c.cmDetails?.name ?? c.collateralManager;
  const issuerName = c.dealIdentity?.issuerLegalName ?? c.issuer;
  const dealName = c.dealIdentity?.dealName;
  const jurisdiction = c.dealIdentity?.jurisdiction;
  const rpEnd = c.keyDates?.reinvestmentPeriodEnd ?? c.reinvestmentPeriod?.end;
  const ncEnd = c.keyDates?.nonCallPeriodEnd ?? c.nonCallPeriod?.end;
  const maturity = c.keyDates?.maturityDate ?? c.maturityDate;
  const payFreq = c.keyDates?.paymentFrequency ?? c.paymentDates;
  const freqSwitch = c.keyDates?.frequencySwitchEvent ?? c.frequencySwitchEvent;

  const lines: string[] = [];

  // --- COMPACT: concise context for chat / debate ---
  if (mode === "compact") {
    // Deal identity (1 line)
    const idParts = [dealName, cmName, jurisdiction].filter(Boolean);
    if (idParts.length) lines.push(`Deal: ${idParts.join(" | ")}`);

    // Key dates (1 line)
    const dateParts: string[] = [];
    if (rpEnd) dateParts.push(`RP end ${rpEnd}`);
    if (ncEnd) dateParts.push(`NC end ${ncEnd}`);
    if (maturity) dateParts.push(`maturity ${maturity}`);
    if (dateParts.length) lines.push(`Dates: ${dateParts.join(", ")}`);

    // Capital structure (abbreviated)
    if (c.capitalStructure?.length) {
      const tranches = c.capitalStructure
        .map((t) => `  ${t.class}: ${t.principalAmount} @ ${t.spread}`)
        .join("\n");
      lines.push(`CAPITAL STRUCTURE:\n${tranches}`);
    }

    // Key metrics inline
    const metrics: string[] = [];
    if (c.warfLimit != null) metrics.push(`WARF≤${c.warfLimit}`);
    if (c.wasMinimum != null) metrics.push(`WAS≥${c.wasMinimum}bps`);
    if (c.walMaximum != null) metrics.push(`WAL≤${c.walMaximum}y`);
    if (c.diversityScoreMinimum != null) metrics.push(`Diversity≥${c.diversityScoreMinimum}`);
    if (metrics.length) lines.push(`Key Metrics: ${metrics.join(", ")}`);

    // Coverage tests (trigger levels)
    if (c.coverageTestEntries?.length) {
      const ct = c.coverageTestEntries
        .map((t) => `  ${t.class}: OC ${t.parValueRatio || "?"}, IC ${t.interestCoverageRatio || "?"}`)
        .join("\n");
      lines.push(`COVERAGE TESTS:\n${ct}`);
    } else if (c.coverageTests && Object.keys(c.coverageTests).length > 0) {
      const ct = Object.entries(c.coverageTests).map(([k, v]) => `  ${k}: ${v}`).join("\n");
      lines.push(`COVERAGE TESTS:\n${ct}`);
    }

    // Top 10 portfolio profile tests
    if (c.portfolioProfileTests && Object.keys(c.portfolioProfileTests).length > 0) {
      const entries = Object.entries(c.portfolioProfileTests).slice(0, 10);
      const tests = entries.map(([k, v]) => `  ${k}: min ${v.min || "N/A"}, max ${v.max || "N/A"}`).join("\n");
      lines.push(`PORTFOLIO PROFILE TESTS (top ${entries.length}):\n${tests}`);
    }

    // ESG count only
    if (c.esgExclusions?.length) {
      lines.push(`ESG Exclusions: ${c.esgExclusions.length} categories`);
    }

    if (targetPar) lines.push(`Target Par: ${targetPar}`);

    return lines.join("\n");
  }

  // --- FULL: all 30 sections for analysis pipeline ---

  // Section 1: Deal Identity
  if (c.dealIdentity) {
    const di = c.dealIdentity;
    const parts = Object.entries(di).filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    if (parts) lines.push(`DEAL IDENTITY:\n${parts}`);
  }

  // Section 2: Key Dates
  {
    const dateParts: string[] = [];
    if (rpEnd) dateParts.push(`  Reinvestment Period End: ${rpEnd}`);
    if (ncEnd) dateParts.push(`  Non-Call Period End: ${ncEnd}`);
    if (maturity) dateParts.push(`  Maturity: ${maturity}`);
    if (c.reinvestmentPeriod?.start) dateParts.push(`  Reinvestment Period Start: ${c.reinvestmentPeriod.start}`);
    if (payFreq) dateParts.push(`  Payment Frequency: ${payFreq}`);
    if (freqSwitch) dateParts.push(`  Frequency Switch: ${freqSwitch}`);
    if (c.keyDates?.originalIssueDate) dateParts.push(`  Original Issue: ${c.keyDates.originalIssueDate}`);
    if (c.keyDates?.firstPaymentDate) dateParts.push(`  First Payment: ${c.keyDates.firstPaymentDate}`);
    if (dateParts.length) lines.push(`KEY DATES:\n${dateParts.join("\n")}`);
  }

  // Section 3: Capital Structure
  if (c.capitalStructure?.length) {
    const tranches = c.capitalStructure
      .map((t) => `  ${t.class}: ${t.principalAmount} @ ${t.spread} (${t.rating?.fitch || ""}/${t.rating?.sp || ""})${t.deferrable ? " [deferrable]" : ""}`)
      .join("\n");
    lines.push(`CAPITAL STRUCTURE:\n${tranches}`);
  }

  // Section 4: Deal Sizing
  if (targetPar) lines.push(`Target Par Amount: ${targetPar}`);
  if (cmName) lines.push(`Collateral Manager: ${cmName}`);
  if (issuerName) lines.push(`Issuer: ${issuerName}`);
  if (c.dealSizing) {
    const ds = c.dealSizing;
    if (ds.totalDealSize) lines.push(`  Total Deal Size: ${ds.totalDealSize}`);
    if (ds.equityPctOfDeal) lines.push(`  Equity % of Deal: ${ds.equityPctOfDeal}`);
    if (ds.cleanUpCallThresholdPct) lines.push(`  Clean-Up Call: ${ds.cleanUpCallThresholdPct}`);
  }

  // Section 5: Coverage Tests
  if (c.coverageTestEntries?.length) {
    const ct = c.coverageTestEntries
      .map((t) => `  ${t.class}: OC ${t.parValueRatio || "?"}, IC ${t.interestCoverageRatio || "?"}`)
      .join("\n");
    lines.push(`\nCOVERAGE TESTS:\n${ct}`);
  } else if (c.coverageTests && Object.keys(c.coverageTests).length > 0) {
    const testsStr = Object.entries(c.coverageTests).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    lines.push(`\nCOVERAGE TESTS:\n${testsStr}`);
  }

  // Reinvestment OC Test
  if (c.reinvestmentOcTest?.trigger) {
    const rot = c.reinvestmentOcTest;
    lines.push(`Reinvestment OC Test: ${rot.trigger}${rot.diversionAmount ? ` → divert ${rot.diversionAmount}` : ""}${rot.diversionOptions ? ` (${rot.diversionOptions})` : ""}`);
  }

  // Section 6: Collateral Quality Tests
  if (Array.isArray(c.collateralQualityTests) && c.collateralQualityTests.length > 0) {
    const cqt = c.collateralQualityTests
      .map((t) => `  ${t.name}${t.agency ? ` (${t.agency})` : ""}: ${t.value ?? "N/A"}${t.appliesDuring ? ` [${t.appliesDuring}]` : ""}`)
      .join("\n");
    lines.push(`\nCOLLATERAL QUALITY TESTS:\n${cqt}`);
  } else if (c.collateralQualityTests && !Array.isArray(c.collateralQualityTests) && Object.keys(c.collateralQualityTests).length > 0) {
    // Legacy Record<string, ...> format
    const cqt = Object.entries(c.collateralQualityTests as Record<string, unknown>)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    if (cqt) lines.push(`\nCOLLATERAL QUALITY TESTS:\n${cqt}`);
  }

  // Section 7: Portfolio Profile Tests
  if (c.portfolioProfileTests && Object.keys(c.portfolioProfileTests).length > 0) {
    const tests = Object.entries(c.portfolioProfileTests)
      .map(([k, v]) => `  ${k}: min ${v.min || "N/A"}, max ${v.max || "N/A"}${v.notes ? ` (${v.notes})` : ""}`)
      .join("\n");
    lines.push(`\nPORTFOLIO PROFILE TESTS:\n${tests}`);
  } else if (c.concentrationLimits && Object.keys(c.concentrationLimits).length > 0) {
    const limitsStr = Object.entries(c.concentrationLimits).map(([k, v]) => `${k}: ${v}`).join(", ");
    lines.push(`PPM Concentration Limits: ${limitsStr}`);
  }

  // Section 8: Eligibility Criteria
  if (c.eligibilityCriteria?.length) {
    lines.push(`\nELIGIBILITY CRITERIA:\n${c.eligibilityCriteria.map((e) => `  - ${e}`).join("\n")}`);
  } else if (c.eligibleCollateral) {
    lines.push(`Eligible Collateral: ${c.eligibleCollateral}`);
  }

  // Section 9: Reinvestment Criteria
  if (c.reinvestmentCriteria) {
    const rc = c.reinvestmentCriteria;
    const parts: string[] = [];
    if (rc.duringReinvestment) parts.push(`  During RP: ${rc.duringReinvestment}`);
    if (rc.postReinvestment) parts.push(`  Post RP: ${rc.postReinvestment}`);
    if (rc.substituteRequirements) parts.push(`  Substitute: ${rc.substituteRequirements}`);
    if (rc.targetParBalance) parts.push(`  Target Par Balance: ${rc.targetParBalance}`);
    if (parts.length) lines.push(`\nREINVESTMENT CRITERIA:\n${parts.join("\n")}`);
  }

  // Section 10: Waterfall
  if (c.waterfall) {
    const w = c.waterfall;
    const parts: string[] = [];
    if (w.interestPriority) parts.push(`  Interest: ${w.interestPriority}`);
    if (w.principalPriority) parts.push(`  Principal: ${w.principalPriority}`);
    if (w.postAcceleration) parts.push(`  Post-Acceleration: ${w.postAcceleration}`);
    if (parts.length) lines.push(`\nWATERFALL:\n${parts.join("\n")}`);
  } else if (c.waterfallSummary) {
    lines.push(`\nWATERFALL:\n${c.waterfallSummary}`);
  }

  // Section 11: Fees
  if (c.fees?.length) {
    const feesStr = c.fees.map((f) => `  ${f.name}: ${f.rate || ""}${f.basis ? ` (${f.basis})` : ""}${f.description ? ` — ${f.description}` : ""}`).join("\n");
    lines.push(`\nFEES:\n${feesStr}`);
  } else if (c.collateralManagerFees && Object.keys(c.collateralManagerFees).length > 0) {
    const fees = Object.entries(c.collateralManagerFees).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    lines.push(`\nCOLLATERAL MANAGER FEES:\n${fees}`);
  }

  // Section 12: Accounts
  if (c.accounts?.length) {
    const accts = c.accounts.map((a) => `  ${a.name}: ${a.purpose}`).join("\n");
    lines.push(`\nACCOUNTS:\n${accts}`);
  }

  // Section 13: Key Parties
  if (c.keyParties?.length) {
    const parties = c.keyParties.map((p) => `  ${p.role}: ${p.entity}`).join("\n");
    lines.push(`\nKEY PARTIES:\n${parties}`);
  }

  // Section 14: Hedging
  if (c.hedging) {
    const h = c.hedging;
    const parts = Object.entries(h).filter(([, v]) => v != null).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    if (parts) lines.push(`\nHEDGING:\n${parts}`);
  }

  // Section 15: Redemption Provisions
  if (c.redemptionProvisions?.length) {
    const rp = c.redemptionProvisions.map((r) => `  ${r.type}: ${r.description}`).join("\n");
    lines.push(`\nREDEMPTION PROVISIONS:\n${rp}`);
  }

  // Section 16: Events of Default
  if (c.eventsOfDefault?.length) {
    const eod = c.eventsOfDefault.map((e) => `  ${e.event}: ${e.description}`).join("\n");
    lines.push(`\nEVENTS OF DEFAULT:\n${eod}`);
  }

  // Section 17: Voting & Control
  if (c.votingAndControl) {
    const vc = c.votingAndControl;
    const parts = Object.entries(vc).filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    if (parts) lines.push(`\nVOTING & CONTROL:\n${parts}`);
  }

  // Section 18: Interest Mechanics
  if (c.interestMechanics) {
    const im = c.interestMechanics;
    const parts: string[] = [];
    if (im.dayCount) parts.push(`  Day Count: ${im.dayCount}`);
    if (im.referenceRate) parts.push(`  Reference Rate: ${im.referenceRate}`);
    if (im.deferralClasses?.length) parts.push(`  Deferral Classes: ${im.deferralClasses.join(", ")}`);
    if (im.deferredInterestCompounds != null) parts.push(`  Deferred Interest Compounds: ${im.deferredInterestCompounds}`);
    if (im.subNoteInterest) parts.push(`  Sub Note Interest: ${im.subNoteInterest}`);
    if (im.withholdingTaxGrossUp != null) parts.push(`  Withholding Tax Gross-Up: ${im.withholdingTaxGrossUp}`);
    if (parts.length) lines.push(`\nINTEREST MECHANICS:\n${parts.join("\n")}`);
  }

  // Section 19: Risk Retention
  if (c.riskRetention) {
    const rr = c.riskRetention;
    const parts: string[] = [];
    if (rr.euUk) parts.push(`  EU/UK: ${JSON.stringify(rr.euUk)}`);
    if (rr.us) parts.push(`  US: ${JSON.stringify(rr.us)}`);
    if (parts.length) lines.push(`\nRISK RETENTION:\n${parts.join("\n")}`);
  }

  // Section 20: Tax
  if (c.tax) {
    const parts = Object.entries(c.tax).filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    if (parts) lines.push(`\nTAX:\n${parts}`);
  }

  // Section 21: Transfer Restrictions
  if (c.transferRestrictions?.length) {
    const tr = c.transferRestrictions.map((t) => `  ${t.investorType}: ${t.requirements}`).join("\n");
    lines.push(`\nTRANSFER RESTRICTIONS:\n${tr}`);
  }

  // Section 22: Reports
  if (c.reports?.length) {
    const rp = c.reports.map((r) => `  ${r.type}${r.frequency ? ` (${r.frequency})` : ""}${r.preparedBy ? ` — ${r.preparedBy}` : ""}`).join("\n");
    lines.push(`\nREPORTS:\n${rp}`);
  }

  // Section 23: CM Details
  if (c.cmDetails) {
    const cmd = c.cmDetails;
    const parts = Object.entries(cmd).filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    if (parts) lines.push(`\nCM DETAILS:\n${parts}`);
  }

  // Section 24: CM Trading Constraints
  if (c.cmTradingConstraints) {
    const cmt = c.cmTradingConstraints;
    const parts: string[] = [];
    if (cmt.discretionarySales) parts.push(`  Discretionary Sales: ${cmt.discretionarySales}`);
    if (cmt.requiredSaleTypes?.length) parts.push(`  Required Sale Types: ${cmt.requiredSaleTypes.join(", ")}`);
    if (cmt.postReinvestmentTrading) parts.push(`  Post-RP Trading: ${cmt.postReinvestmentTrading}`);
    if (parts.length) lines.push(`\nCM TRADING CONSTRAINTS:\n${parts.join("\n")}`);
  }

  // Section 25: Refinancing History
  if (c.refinancingHistory?.length) {
    const rh = c.refinancingHistory.map((r) => `  ${r.date}: ${r.details}`).join("\n");
    lines.push(`\nREFINANCING HISTORY:\n${rh}`);
  }

  // Section 26: Additional Issuance
  if (c.additionalIssuance) {
    lines.push(`\nADDITIONAL ISSUANCE: ${c.additionalIssuance.permitted ? "Permitted" : "Not permitted"}${c.additionalIssuance.conditions ? ` — ${c.additionalIssuance.conditions}` : ""}`);
  }

  // Section 27: Risk Factors
  if (c.riskFactors && Object.keys(c.riskFactors).length > 0) {
    const rf = Object.entries(c.riskFactors).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    lines.push(`\nRISK FACTORS:\n${rf}`);
  }

  // Section 28: Conflicts of Interest
  if (c.conflictsOfInterest?.length) {
    lines.push(`\nCONFLICTS OF INTEREST:\n${c.conflictsOfInterest.map((ci) => `  - ${ci}`).join("\n")}`);
  }

  // Section 29: Rating Agency Parameters
  if (c.ratingAgencyParameters) {
    const rap = c.ratingAgencyParameters;
    const parts = Object.entries(rap).filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    if (parts) lines.push(`\nRATING AGENCY PARAMETERS:\n${parts}`);
  }

  // Section 30: Legal Protections
  if (c.legalProtections?.length) {
    const lp = c.legalProtections.map((l) => `  ${l.feature}: ${l.description}`).join("\n");
    lines.push(`\nLEGAL PROTECTIONS:\n${lp}`);
  }

  // Key metrics (legacy)
  if (c.warfLimit != null) lines.push(`WARF Limit: ${c.warfLimit}`);
  if (c.wasMinimum != null) lines.push(`WAS Minimum: ${c.wasMinimum} bps`);
  if (c.walMaximum != null) lines.push(`WAL Maximum: ${c.walMaximum} years`);
  if (c.diversityScoreMinimum != null) lines.push(`Diversity Score Minimum: ${c.diversityScoreMinimum}`);

  // Loss mitigation (legacy)
  if (c.lossMitigationLimits && Object.keys(c.lossMitigationLimits).length > 0) {
    const lm = Object.entries(c.lossMitigationLimits).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    lines.push(`\nLOSS MITIGATION LIMITS:\n${lm}`);
  }

  // ESG
  if (c.esgExclusions?.length) {
    lines.push(`\nESG EXCLUSIONS:\n${c.esgExclusions.map((e) => `  - ${e}`).join("\n")}`);
  }

  // Rating thresholds (legacy)
  if (c.ratingThresholds) lines.push(`Rating Thresholds: ${c.ratingThresholds}`);

  // Other / catch-all (legacy)
  if (c.otherConstraints?.length) {
    lines.push(`Other Constraints: ${c.otherConstraints.join("; ")}`);
  }
  if (c.additionalProvisions) {
    lines.push(`\nADDITIONAL PPM PROVISIONS:\n${c.additionalProvisions}`);
  }

  return lines.join("\n");
}

function formatPortfolioState(portfolio: ExtractedPortfolio | null): string {
  if (!portfolio) return "";

  const sections: string[] = [];

  if (portfolio.reportDate) {
    sections.push(`Report Date: ${portfolio.reportDate}`);
  }

  if (portfolio.testResults?.length > 0) {
    const tests = portfolio.testResults
      .map((t) => `  ${t.name}: ${t.actual}% (trigger: ${t.trigger}%, cushion: ${t.cushion >= 0 ? "+" : ""}${t.cushion}%, ${t.passing ? "PASSING" : "FAILING"})`)
      .join("\n");
    sections.push(`Test Results:\n${tests}`);
  }

  if (portfolio.metrics?.length > 0) {
    const metrics = portfolio.metrics
      .map((m) => `  ${m.name}: ${m.current} (limit: ${m.limit}, ${m.passing ? "PASSING" : "FAILING"})`)
      .join("\n");
    sections.push(`Portfolio Metrics:\n${metrics}`);
  }

  if (portfolio.cccBucket) {
    const ccc = portfolio.cccBucket;
    sections.push(`CCC Bucket: ${ccc.current}% / ${ccc.limit}% limit${ccc.holdings?.length ? ` (${ccc.holdings.length} names: ${ccc.holdings.join(", ")})` : ""}`);
  }

  if (portfolio.concentrations) {
    const parts: string[] = [];
    if (portfolio.concentrations.topExposures?.length > 0) {
      const top = portfolio.concentrations.topExposures
        .slice(0, 10)
        .map((c) => `  ${c.category}: ${c.percentage}%${c.limit != null ? ` / ${c.limit}% limit` : ""}`)
        .join("\n");
      parts.push(`Top Exposures:\n${top}`);
    }
    if (portfolio.concentrations.bySector?.length > 0) {
      const sec = portfolio.concentrations.bySector
        .slice(0, 10)
        .map((c) => `  ${c.category}: ${c.percentage}%${c.limit != null ? ` / ${c.limit}% limit` : ""}`)
        .join("\n");
      parts.push(`Sector Concentration:\n${sec}`);
    }
    if (parts.length > 0) sections.push(parts.join("\n"));
  }

  if (portfolio.holdings?.length > 0) {
    sections.push(`Total Holdings: ${portfolio.holdings.length} positions`);
  }

  return sections.join("\n\n");
}

function formatProfile(profile: CloProfile): string {
  const base = `Fund Strategy: ${profile.fundStrategy || "Not specified"}
Target Sectors: ${profile.targetSectors || "Not specified"}
Risk Appetite: ${profile.riskAppetite || "Not specified"}
Portfolio Size: ${profile.portfolioSize || "Not specified"}
Reinvestment Period: ${profile.reinvestmentPeriod || "Not specified"}
Concentration Limits: ${profile.concentrationLimits || "Not specified"}
Covenant Preferences: ${profile.covenantPreferences || "Not specified"}
Rating Thresholds: ${profile.ratingThresholds || "Not specified"}
Spread Targets: ${profile.spreadTargets || "Not specified"}
Regulatory Constraints: ${profile.regulatoryConstraints || "Not specified"}
Portfolio Description: ${profile.portfolioDescription || "Not specified"}
Beliefs & Biases: ${profile.beliefsAndBiases || "Not specified"}`;

  const extracted = formatConstraints(profile.extractedConstraints, "compact");
  if (extracted) {
    return `${base}\n\n--- PPM-EXTRACTED CONSTRAINTS ---\n${extracted}`;
  }
  return base;
}

function formatMembers(members: PanelMember[]): string {
  return members
    .map(
      (m) =>
        `## ${m.name} | ${m.role}\nPhilosophy: ${m.investmentPhilosophy}\nSpecializations: ${m.specializations.join(", ")}\nRisk Personality: ${m.riskPersonality}\nDecision Style: ${m.decisionStyle}`
    )
    .join("\n\n");
}

function formatAnalysis(analysis: Pick<LoanAnalysis, "title" | "analysisType" | "borrowerName" | "sector" | "loanType" | "spreadCoupon" | "rating" | "maturity" | "facilitySize" | "leverage" | "interestCoverage" | "covenantsSummary" | "ebitda" | "revenue" | "companyDescription" | "notes" | "switchBorrowerName" | "switchSector" | "switchLoanType" | "switchSpreadCoupon" | "switchRating" | "switchMaturity" | "switchFacilitySize" | "switchLeverage" | "switchInterestCoverage" | "switchCovenantsSummary" | "switchEbitda" | "switchRevenue" | "switchCompanyDescription" | "switchNotes">): string {
  let result = `Title: ${analysis.title}
Analysis Type: ${analysis.analysisType || "buy"}
Borrower: ${analysis.borrowerName || "Not specified"}
Sector: ${analysis.sector || "Not specified"}
Loan Type: ${analysis.loanType || "Not specified"}
Spread/Coupon: ${analysis.spreadCoupon || "Not specified"}
Rating: ${analysis.rating || "Not specified"}
Maturity: ${analysis.maturity || "Not specified"}
Facility Size: ${analysis.facilitySize || "Not specified"}
Leverage: ${analysis.leverage || "Not specified"}
Interest Coverage: ${analysis.interestCoverage || "Not specified"}
Covenants Summary: ${analysis.covenantsSummary || "Not specified"}
EBITDA: ${analysis.ebitda || "Not specified"}
Revenue: ${analysis.revenue || "Not specified"}
Company Description: ${analysis.companyDescription || "Not specified"}
Notes: ${analysis.notes || "None"}`;

  if (analysis.analysisType === "switch") {
    result += `

--- Switch Target ---
Switch Borrower: ${analysis.switchBorrowerName || "Not specified"}
Switch Sector: ${analysis.switchSector || "Not specified"}
Switch Loan Type: ${analysis.switchLoanType || "Not specified"}
Switch Spread/Coupon: ${analysis.switchSpreadCoupon || "Not specified"}
Switch Rating: ${analysis.switchRating || "Not specified"}
Switch Maturity: ${analysis.switchMaturity || "Not specified"}
Switch Facility Size: ${analysis.switchFacilitySize || "Not specified"}
Switch Leverage: ${analysis.switchLeverage || "Not specified"}
Switch Interest Coverage: ${analysis.switchInterestCoverage || "Not specified"}
Switch Covenants Summary: ${analysis.switchCovenantsSummary || "Not specified"}
Switch EBITDA: ${analysis.switchEbitda || "Not specified"}
Switch Revenue: ${analysis.switchRevenue || "Not specified"}
Switch Company Description: ${analysis.switchCompanyDescription || "Not specified"}
Switch Notes: ${analysis.switchNotes || "None"}`;
  }

  return result;
}

// ─── PPM Extraction ─────────────────────────────────────────────────

export function ppmExtractionPrompt(): { system: string; user: string } {
  return {
    system: `You are a CLO structuring expert. Extract ALL deal terms from the PPM/Offering Circular into a single JSON object (no markdown fences, no explanation). The schema has 30 sections — populate every section where data exists, omit sections entirely if no data found.

{
  "dealIdentity": { "dealName": "...", "issuerLegalName": "...", "jurisdiction": "...", "entityType": "...", "registrationNumber": "...", "registeredAddress": "...", "governingLaw": "...", "currency": "...", "listingExchange": "...", "volckerRuleStatus": "..." },

  "keyDates": { "originalIssueDate": "YYYY-MM-DD", "currentIssueDate": "...", "maturityDate": "...", "nonCallPeriodEnd": "...", "reinvestmentPeriodEnd": "...", "firstPaymentDate": "...", "paymentFrequency": "Quarterly on 15 Jan/Apr/Jul/Oct", "frequencySwitchEvent": "..." },

  "capitalStructure": [
    { "class": "A", "designation": "Senior Secured", "principalAmount": "€248,000,000", "rateType": "floating", "referenceRate": "3m EURIBOR", "spreadBps": 122, "spread": "3m EURIBOR + 1.22%", "rating": { "fitch": "AAAsf", "sp": "AAA(sf)" }, "ratingAddressesTimelyInterest": true, "deferrable": false, "issuePrice": "100%", "maturityDate": "2038-04-15", "minDenominationRegS": "€100,000", "minDenomination144a": null, "isSubordinated": false, "clearing": "Euroclear/Clearstream" }
  ],

  "dealSizing": { "targetParAmount": "€400,000,000", "totalRatedNotes": "...", "totalSubordinatedNotes": "...", "totalDealSize": "...", "equityPctOfDeal": "...", "cleanUpCallThresholdPct": "15%", "classXAmortisation": "..." },

  "coverageTestEntries": [
    { "class": "A/B", "parValueRatio": "130.13%", "interestCoverageRatio": "120%" }
  ],
  "reinvestmentOcTest": { "trigger": "Class F PV Ratio < 102.45%", "appliesDuring": "reinvestment period", "diversionAmount": "50% of remaining interest proceeds", "diversionOptions": "..." },

  "collateralQualityTests": [
    { "name": "Maximum Fitch WARF", "agency": "Fitch", "value": 2800, "appliesDuring": "reinvestment period" },
    { "name": "Minimum WAS", "agency": null, "value": "3.50%", "appliesDuring": "all times" }
  ],

  "portfolioProfileTests": {
    "testName": { "min": "90%", "max": null, "notes": "optional notes" }
  },

  "eligibilityCriteria": [ "criterion 1", "criterion 2" ],

  "reinvestmentCriteria": { "duringReinvestment": "...", "postReinvestment": "...", "substituteRequirements": "...", "targetParBalance": "..." },

  "waterfall": { "interestPriority": "structured prose of interest waterfall steps", "principalPriority": "structured prose of principal waterfall steps", "postAcceleration": "..." },

  "fees": [
    { "name": "Senior Management Fee", "rate": "0.15%", "basis": "per annum on Collateral Principal Amount", "description": "..." }
  ],

  "accounts": [ { "name": "Payment Account", "purpose": "..." } ],

  "keyParties": [ { "role": "Trustee", "entity": "..." } ],

  "hedging": { "currencyHedgeRequired": true, "hedgeTypes": "...", "counterpartyRatingReq": "...", "replacementTimeline": "...", "maxCurrencyHedgePct": "20%", "terminationWaterfallPosition": "..." },

  "redemptionProvisions": [ { "type": "Optional Redemption", "description": "..." } ],

  "eventsOfDefault": [ { "event": "Non-payment", "description": "..." } ],

  "votingAndControl": { "controllingClass": "Class A", "ordinaryResolution": "50%+", "extraordinaryResolution": "66.67%", "cmNotesVotingRestrictions": "..." },

  "interestMechanics": { "dayCount": "Actual/360", "referenceRate": "3m EURIBOR", "interpolation": "...", "deferralClasses": ["E","F"], "deferredInterestCompounds": true, "subNoteInterest": "...", "withholdingTaxGrossUp": false },

  "riskRetention": { "euUk": { "holder": "...", "type": "vertical slice", "amount": "5%", "reporting": "..." }, "us": { "type": "...", "amount": "...", "hedgingRestriction": "..." } },

  "tax": { "jurisdiction": "Ireland", "section110": "...", "withholding": "...", "usTreatment": "...", "fatcaCrs": "..." },

  "transferRestrictions": [ { "investorType": "US Person", "requirements": "QIB + QP" } ],

  "reports": [ { "type": "Monthly Report", "frequency": "Monthly", "preparedBy": "Trustee" } ],

  "cmDetails": { "name": "...", "parent": "...", "jurisdiction": "...", "replacementMechanism": "...", "resignationTerms": "..." },

  "cmTradingConstraints": { "discretionarySales": "...", "requiredSaleTypes": ["Credit Risk","Defaulted"], "postReinvestmentTrading": "..." },

  "managementOfPortfolio": "Full text of the Management of the Portfolio section — PM authority, permitted activities, restrictions on trading, discretionary powers, investment guidelines",

  "termsAndConditionsOfSales": "Full text of Terms and Conditions of Sales section — sale requirements, conditions precedent, notice periods, pricing requirements",

  "tradingRestrictionsByTestBreach": [{ "testName": "OC Test Class A", "consequence": "If failed, interest proceeds diverted to pay down senior notes until cured" }],

  "refinancingHistory": [ { "date": "2021-06-15", "details": "..." } ],

  "additionalIssuance": { "permitted": true, "conditions": "..." },

  "riskFactors": { "category": "summary" },

  "conflictsOfInterest": [ "..." ],

  "ratingAgencyParameters": { "spCdoMonitor": "...", "spIndustryClassifications": "...", "spRecoveryRates": "...", "spDiversityMeasure": "...", "fitchTestMatrix": "...", "fitchWARF": "...", "fitchWARR": "...", "fitchIndustryClassifications": "..." },

  "legalProtections": [ { "feature": "Limited Recourse", "description": "..." } ],

  "targetParAmount": "€X",
  "collateralManager": "Name",
  "issuer": "Name",
  "warfLimit": 2800,
  "wasMinimum": 350,
  "walMaximum": 5.0,
  "diversityScoreMinimum": 60,
  "esgExclusions": [ "Controversial weapons (any revenue)", "..." ],
  "lossMitigationLimits": { "maxOutstanding": "2%", "maxExtended": "2%", "maxCumulativePrincipal": "5%", "maxCumulativeTotal": "10%" },
  "additionalProvisions": "FREE-FORM CATCH-ALL — see instructions below"
}

CAPITAL STRUCTURE EXTRACTION — CRITICAL:
- The capital structure table is typically found in the FIRST 5-10 pages of the PPM, often in a summary or term sheet section.
- You MUST extract ALL tranches/classes — from the most senior (Class A / AAA) through the equity/subordinated notes.
- Do NOT focus only on the tranche being described in the main body text. Find the summary table that lists ALL classes.
- Include: class name, designation, principal amount, rate type (fixed/floating), reference rate, spread in bps, ratings from ALL agencies (Fitch, S&P, Moody's if available), deferability, issue price, maturity.
- If the PPM only describes one tranche in detail but references others, still extract all tranches from the summary table.

CM TRADING CONSTRAINTS & TRADING RESTRICTIONS — CRITICAL:
- Extract the LINK between test breaches and trading restrictions. For example: "If the CCC/Caa bucket exceeds 7.5% of the portfolio, the PM cannot purchase additional CCC-rated assets."
- Extract concentration-based trading limits: single obligor limits, industry limits, country limits, and what happens when they are breached.
- For tradingRestrictionsByTestBreach, map EACH compliance test to its consequence when breached (e.g., OC test failure → proceeds diversion, CCC excess → purchase restriction).
- Extract "Management of the Portfolio" section FULLY — PM authority, permitted activities, investment guidelines.
- Extract "Terms and Conditions of Sales" section FULLY — conditions for sales, required sale types, discretionary limits.

CRITICAL — additionalProvisions is the safety net. After populating all structured sections, write EVERYTHING remaining that could possibly be relevant into this field as structured prose with section headers. This includes but is not limited to:
- Workout/restructured loan treatment and haircuts
- Equity contribution and par flush mechanics
- Discretionary sale baskets beyond what cmTradingConstraints captures
- Bespoke eligibility definitions and carve-outs (e.g. Eligible Interest Rate Obligation, Restructured Obligation Criteria)
- Currency hedging conditions and triggers
- Maturity amendment provisions
- Interest deferral mechanics detail beyond interestMechanics
- Note Event of Default curing provisions
- Collateral Manager advance provisions
- Bivariate Risk Table limits
- Fitch Test Matrix mechanics (variable limits based on matrix/case selection)
- Clean-up call mechanics detail
- Optional/Mandatory/Special redemption mechanics detail
- Any conditional triggers, exceptions, or edge cases in tests
- Defined terms that modify the plain-English meaning of other fields
- ANY clause, provision, or data point you encounter that doesn't cleanly map to a structured field
When in doubt, INCLUDE IT HERE. It is far better to duplicate information than to lose it. Quote specific PPM language when exact wording matters.

Rules:
- Extract ONLY explicitly stated values. Use null for missing fields.
- Omit entire sections if no data found (don't emit empty objects/arrays).
- Include % signs in string values. Numbers for bps/WARF/WAL/diversity.
- The legacy top-level fields (targetParAmount, collateralManager, etc.) MUST also be emitted for backward compatibility — duplicate from the structured sections.
- For eligibilityCriteria, list EVERY criterion (typically 30-45 items).
- For portfolioProfileTests, include ALL tests with min/max limits.
- For esgExclusions, list ALL categories with revenue thresholds.
- EXHAUSTIVENESS IS PARAMOUNT. If you see data in the PPM that seems potentially relevant but doesn't clearly fit a structured field, extract it into additionalProvisions. Never skip something because you're unsure where it belongs — put it in the catch-all.
- Completeness > brevity. This JSON will be large.`,
    user: `Extract ALL deal terms from the attached CLO documents into the 30-section JSON schema. Be exhaustive — capture every clause a portfolio manager or analyst might need. If anything in the document seems potentially relevant but doesn't clearly fit a structured field, include it in additionalProvisions. Return only the JSON object.`,
  };
}

export function ppmDeepDiveEligibilityPrompt(firstPassJson: string): { system: string; user: string } {
  return {
    system: `You are a CLO structuring expert performing a FOCUSED DEEP-DIVE on eligibility criteria, portfolio tests, and ESG exclusions. A first-pass extraction has already been done. Your ONLY job is to find items the first pass missed in these specific areas.

Return a single JSON object (no markdown fences, no explanation) containing ONLY new/corrected data for these fields:

{
  "eligibilityCriteria": [ ...ONLY items the first pass missed... ],
  "portfolioProfileTests": { ...ONLY tests the first pass missed or got wrong... },
  "esgExclusions": [ ...ONLY items the first pass missed... ],
  "collateralQualityTests": [ ...ONLY tests the first pass missed... ],
  "coverageTestEntries": [ ...ONLY classes the first pass missed... ],
  "reinvestmentCriteria": { ...ONLY if first pass missed or incomplete... },
  "ratingAgencyParameters": { ...ONLY if first pass missed fields... },
  "managementOfPortfolio": "ONLY if first pass missed or under-captured the Management of the Portfolio section. Extract the FULL section including: PM authority and scope, permitted activities, investment guidelines, restrictions, discretionary powers.",
  "termsAndConditionsOfSales": "ONLY if first pass missed or under-captured. Extract: sale conditions, requirements for discretionary/credit-risk/credit-improved sales, notice periods, pricing requirements, permitted sale types."
}

WHERE TO LOOK — these sections are commonly buried in:
- **Annexes/Schedules** — eligibility criteria are often in a separate schedule, not inline
- **Portfolio Profile Test tables** — look for large tables with 25-35 rows of min/max limits. Common tests the first pass misses: casino/gambling, annual pay, zero coupon, restructured obligations, participations, discount obligations, distressed exchange, credit estimate, private rating, DIP loans, delayed drawdown, revolving facilities, letter of credit facilities
- **ESG Exclusion Schedule** — usually a dedicated annex with 15-30 categories including specific revenue thresholds (e.g., "thermal coal mining >1% revenue", "Arctic oil/gas exploration any revenue", "palm oil >5% revenue"). Often has both direct involvement and revenue-based thresholds.
- **Defined Terms** — terms like "Eligible Collateral Obligation", "Collateral Quality Test", "Fitch Test Matrix" often contain additional constraints within their definitions
- **Conditional/tiered limits** — many tests have exceptions like "max 2.5% per obligor, except up to 3 obligors may be at 3.0%" — include the full conditional language
- **Management of the Portfolio** — usually a dedicated section (often Chapter/Article titled "Management of the Collateral" or "The Portfolio Manager" or "Collateral Management"). Contains PM authority, trading guidelines, investment restrictions.
- **Terms and Conditions of Sales** — often near the trading/sales sections. Describes conditions under which the PM can sell assets, including discretionary sales, credit-risk sales, credit-improved sales.

COUNTING CHECK: A typical European CLO PPM has:
- 30-45 eligibility criteria (if first pass has <25, you're likely missing some)
- 25-35 portfolio profile tests (if first pass has <20, check the tables again)
- 15-30 ESG exclusion categories (if first pass has <10, check the ESG annex)

If the first pass captured everything in these areas, return: {}

Rules:
- Do NOT re-emit items the first pass already captured — only new items.
- Include the FULL text of each criterion/test, including exceptions and conditions.
- For portfolioProfileTests, use the same format: { "min": "X%", "max": "Y%", "notes": "exceptions" }`,
    user: `Here is the first-pass extraction. Re-read the attached PPM and focus EXCLUSIVELY on finding missed eligibility criteria, portfolio profile tests, ESG exclusions, collateral quality tests, and rating agency parameters.

FIRST-PASS EXTRACTION:
${firstPassJson}`,
  };
}

export function ppmDeepDiveStructuralPrompt(firstPassJson: string): { system: string; user: string } {
  return {
    system: `You are a CLO structuring expert performing a FOCUSED DEEP-DIVE on structural provisions and deal mechanics. A first-pass extraction has already been done. Your ONLY job is to find structural provisions the first pass missed or under-captured.

Return a single JSON object (no markdown fences, no explanation) containing ONLY new/corrected data for these fields:

{
  "waterfall": { ...if first pass missed steps or got priority wrong... },
  "hedging": { ...if first pass missed provisions... },
  "redemptionProvisions": [ ...ONLY provisions the first pass missed... ],
  "eventsOfDefault": [ ...ONLY events the first pass missed... ],
  "interestMechanics": { ...if first pass missed fields... },
  "votingAndControl": { ...if first pass missed fields... },
  "cmTradingConstraints": { ...if first pass missed provisions... },
  "cmDetails": { ...if first pass missed fields... },
  "transferRestrictions": [ ...ONLY restrictions the first pass missed... ],
  "legalProtections": [ ...ONLY protections the first pass missed... ],
  "additionalIssuance": { ...if first pass missed or incomplete... },
  "tax": { ...if first pass missed fields... },
  "riskRetention": { ...if first pass missed fields... },
  "lossMitigationLimits": { ...if first pass missed or incomplete... },
  "tradingRestrictionsByTestBreach": [{ "testName": "...", "consequence": "..." }],
  "additionalProvisions": "NEW TEXT ONLY — provisions the first pass missed entirely"
}

WHERE TO LOOK — structural provisions commonly missed:
- **Waterfall detail** — each numbered step of interest and principal waterfalls. First pass often summarizes; you should capture each step with its conditions.
- **Hedging conditions** — rating triggers for hedge counterparty replacement, eligible hedge provider requirements, hedge termination waterfall position
- **Redemption mechanics** — Optional, Mandatory, Special, Tax redemption with specific conditions and timing. Clean-up call threshold and mechanics.
- **Events of Default** — typically 8-12 events including non-payment, breach of OC tests for extended period, insolvency, etc. First pass often gets 3-4.
- **Interest deferral cascades** — which classes defer, PIK vs non-PIK treatment, compounding, cure mechanics
- **CM trading restrictions** — discretionary sale baskets, credit-improved/credit-risk/defaulted sale requirements, post-reinvestment constraints
- **CM removal/replacement** — for-cause vs without-cause, required majorities, transition mechanics
- **Loss mitigation obligations** — limits, growth mechanics, interaction with par value tests
- **Workout obligations** — restructured obligation criteria, participation mechanics
- **Maturity amendment** — conditions under which loan maturities can be extended
- **Defined terms that create hidden constraints** — e.g., "Aggregate Principal Balance" excluding defaulted obligations affects OC test calculations
- **Test breach consequences** — scattered throughout the PPM, often in waterfall descriptions, coverage test sections, and portfolio management sections. Map each test (OC par, OC MV, IC, WARF, WAL, WAS, Diversity, CCC bucket, etc.) to what happens when it fails. Common consequences: proceeds diversion, purchase restrictions, mandatory redemption, acceleration triggers. Also check for tiered consequences (e.g., "minor breach" vs "major breach").

If the first pass captured everything in these areas, return: {}

Rules:
- Do NOT re-emit items the first pass already captured — only new items.
- For additionalProvisions, include ONLY new text to APPEND.
- Quote specific PPM language for provisions where exact wording matters (e.g., event of default triggers, redemption conditions).`,
    user: `Here is the first-pass extraction. Re-read the attached PPM and focus EXCLUSIVELY on finding missed structural provisions, waterfall details, events of default, redemption mechanics, hedging conditions, CM provisions, and any deal mechanics the first pass under-captured.

FIRST-PASS EXTRACTION:
${firstPassJson}`,
  };
}

// ─── Portfolio Extraction ────────────────────────────────────────────

/** @deprecated Use the new multi-table extraction pipeline (clo-report-extraction prompts) instead */
export function portfolioExtractionPrompt(): { system: string; user: string } {
  return {
    system: `You are a CLO compliance report analyst. Parse the attached compliance/trustee report and extract the current portfolio state into structured JSON.

Return a single JSON object (no markdown fences, no explanation) with this structure:

{
  "holdings": [
    {
      "issuer": "Company Name",
      "notional": 5000,
      "rating": "B2/B",
      "spread": 375,
      "sector": "Healthcare",
      "maturity": "2028-06-15",
      "loanType": "First Lien TL"
    }
  ],
  "testResults": [
    {
      "name": "Senior OC",
      "actual": 128.5,
      "trigger": 120.0,
      "passing": true,
      "cushion": 8.5
    }
  ],
  "metrics": [
    {
      "name": "WARF",
      "current": 2850,
      "limit": 3000,
      "direction": "max",
      "passing": true
    }
  ],
  "cccBucket": {
    "current": 5.2,
    "limit": 7.5,
    "holdings": ["Issuer A", "Issuer B"]
  },
  "concentrations": {
    "bySector": [{ "category": "Healthcare", "percentage": 12.5, "limit": 15.0 }],
    "byRating": [{ "category": "B2", "percentage": 35.0 }],
    "topExposures": [{ "category": "Company X", "percentage": 2.1, "limit": 2.5 }]
  },
  "reportDate": "2024-12-31"
}

Rules:
- Extract ONLY data explicitly stated in the report. Use null for missing fields.
- Spreads must be in basis points as numbers (e.g. 375, not "L+375").
- Notional amounts in thousands (par amount).
- Calculate cushion as actual minus trigger for compliance tests.
- For metrics, direction is "max" if the limit is a ceiling, "min" if it is a floor.
- passing = true if the test/metric is within limits.
- Extract ALL holdings from the portfolio schedule — do not truncate.
- Extract ALL compliance tests (OC, IC at every tranche level).
- Extract ALL concentration data (sector, rating, single-name).
- If a CCC bucket section exists, list all CCC-rated issuers.
- reportDate should be the as-of date of the report.`,
    user: `Extract the complete portfolio state from the attached compliance/trustee report. Return only the JSON object.`,
  };
}

// ─── Report Period Formatting ────────────────────────────────────────

export function formatReportPeriodState(
  poolSummary: CloPoolSummary | null,
  complianceTests: CloComplianceTest[],
  concentrations: CloConcentration[],
  events: CloEvent[],
  overflow: CloExtractionOverflow[]
): string {
  const sections: string[] = [];

  if (poolSummary) {
    const metrics: string[] = [];
    if (poolSummary.totalPar != null) metrics.push(`Total Par: ${poolSummary.totalPar.toLocaleString()}`);
    if (poolSummary.targetPar != null) metrics.push(`Target Par: ${poolSummary.targetPar.toLocaleString()}`);
    if (poolSummary.parSurplusDeficit != null) metrics.push(`Par Surplus/Deficit: ${poolSummary.parSurplusDeficit.toLocaleString()}`);
    if (poolSummary.numberOfObligors != null) metrics.push(`Obligors: ${poolSummary.numberOfObligors}`);
    if (poolSummary.numberOfAssets != null) metrics.push(`Assets: ${poolSummary.numberOfAssets}`);
    if (poolSummary.numberOfIndustries != null) metrics.push(`Industries: ${poolSummary.numberOfIndustries}`);
    if (poolSummary.warf != null) metrics.push(`WARF: ${poolSummary.warf}`);
    if (poolSummary.walYears != null) metrics.push(`WAL: ${poolSummary.walYears}y`);
    if (poolSummary.wacSpread != null) metrics.push(`WAS: ${poolSummary.wacSpread} bps`);
    if (poolSummary.diversityScore != null) metrics.push(`Diversity Score: ${poolSummary.diversityScore}`);
    if (poolSummary.waRecoveryRate != null) metrics.push(`WA Recovery: ${poolSummary.waRecoveryRate}%`);
    if (poolSummary.pctCccAndBelow != null) metrics.push(`CCC & Below: ${poolSummary.pctCccAndBelow}%`);
    if (poolSummary.pctDefaulted != null) metrics.push(`Defaulted: ${poolSummary.pctDefaulted}%`);
    if (poolSummary.pctFixedRate != null) metrics.push(`Fixed Rate: ${poolSummary.pctFixedRate}%`);
    if (poolSummary.pctCovLite != null) metrics.push(`Cov-Lite: ${poolSummary.pctCovLite}%`);
    if (poolSummary.pctSecondLien != null) metrics.push(`Second Lien: ${poolSummary.pctSecondLien}%`);
    if (poolSummary.pctBonds != null) metrics.push(`Bonds: ${poolSummary.pctBonds}%`);
    if (metrics.length > 0) {
      sections.push(`POOL SUMMARY:\n${metrics.map((m) => `  ${m}`).join("\n")}`);
    }
  }

  if (complianceTests.length > 0) {
    const tests = complianceTests
      .map((t) => {
        const parts = [`  ${t.testName}`];
        if (t.actualValue != null) parts.push(`actual: ${t.actualValue}`);
        if (t.triggerLevel != null) parts.push(`trigger: ${t.triggerLevel}`);
        if (t.cushionPct != null) parts.push(`cushion: ${t.cushionPct >= 0 ? "+" : ""}${t.cushionPct}%`);
        if (t.isPassing != null) parts.push(t.isPassing ? "PASSING" : "FAILING");
        if (t.consequenceIfFail) parts.push(`consequence: ${t.consequenceIfFail}`);
        return parts.join(" | ");
      })
      .join("\n");
    sections.push(`COMPLIANCE TESTS:\n${tests}`);
  }

  if (concentrations.length > 0) {
    const byType = new Map<string, CloConcentration[]>();
    for (const c of concentrations) {
      const group = byType.get(c.concentrationType) ?? [];
      group.push(c);
      byType.set(c.concentrationType, group);
    }
    const concParts: string[] = [];
    for (const [type, items] of byType) {
      const lines = items
        .slice(0, 15)
        .map((c) => {
          const parts = [`    ${c.bucketName}`];
          if (c.actualPct != null) parts.push(`${c.actualPct}%`);
          if (c.limitPct != null) parts.push(`limit: ${c.limitPct}%`);
          if (c.isPassing != null) parts.push(c.isPassing ? "OK" : "BREACH");
          return parts.join(" | ");
        })
        .join("\n");
      concParts.push(`  ${type}:\n${lines}`);
    }
    sections.push(`CONCENTRATIONS:\n${concParts.join("\n")}`);
  }

  if (events.length > 0) {
    const evtLines = events
      .slice(0, 10)
      .map((e) => {
        const parts = [`  ${e.eventType ?? "EVENT"}`];
        if (e.eventDate) parts.push(e.eventDate);
        if (e.description) parts.push(e.description);
        if (e.isEventOfDefault) parts.push("[EVENT OF DEFAULT]");
        if (e.isCured) parts.push("[CURED]");
        return parts.join(" | ");
      })
      .join("\n");
    sections.push(`RECENT EVENTS:\n${evtLines}`);
  }

  if (overflow.length > 0) {
    const ofLines = overflow
      .slice(0, 5)
      .map((o) => `  ${o.label ?? o.sourceSection ?? "overflow"}: ${typeof o.content === "string" ? o.content.slice(0, 200) : JSON.stringify(o.content).slice(0, 200)}`)
      .join("\n");
    sections.push(`EXTRACTION OVERFLOW (additional data):\n${ofLines}`);
  }

  return sections.join("\n\n");
}

// ─── Senior Analyst Chat ────────────────────────────────────────────

export function seniorAnalystSystemPrompt(
  profile: CloProfile,
  portfolioSnapshot: string,
  reportPeriodContext?: string
): string {
  const constraintsSection = formatConstraints(profile.extractedConstraints, "compact")
    ? `\nEXTRACTED VEHICLE CONSTRAINTS:\n${formatConstraints(profile.extractedConstraints, "compact")}`
    : "";

  const portfolioState = formatPortfolioState(profile.extractedPortfolio);
  const portfolioStateSection = portfolioState
    ? `\nCURRENT PORTFOLIO STATE (from compliance report):\n${portfolioState}`
    : "";

  const reportPeriodSection = reportPeriodContext
    ? `\nCURRENT REPORT PERIOD DATA (from compliance report extraction):\n${reportPeriodContext}`
    : "";

  return `You are a senior CLO credit analyst with deep expertise in leveraged loan portfolios and CLO vehicle management. You work alongside the portfolio manager to make better, faster decisions.

The CLO's PPM/Listing Particulars and compliance reports are attached as document content in the conversation. Every constraint in the PPM is a hard rule. Reference specific sections when citing constraints.
${constraintsSection}
${portfolioStateSection}
${reportPeriodSection}

PORTFOLIO PROFILE:
${formatProfile(profile)}
${portfolioSnapshot ? `\nPORTFOLIO HISTORY:\n${portfolioSnapshot}` : ""}

YOUR JOB:
A. Compliance-Aware Trade Ideas — before recommending any buy/sell, check against ALL PPM constraints: coverage tests, collateral quality tests, portfolio profile tests, eligibility criteria, concentration limits, WARF/WAS/WAL/diversity, CCC bucket, and reinvestment criteria. Show impact on each.
B. Portfolio Optimization — identify swaps that improve multiple dimensions. Show before/after impact.
C. Early Warning — track borrowers trending toward CCC/default. Model compliance test impact of downgrades. Consider event of default triggers and their cure provisions.
D. Waterfall Awareness — understand which payment date is next, whether test failure diverts equity cash. Reference the interest and principal priority of payments.
E. Structural Awareness — know the hedging requirements, redemption provisions, interest deferral mechanics, transfer restrictions, and voting/control provisions. Flag when a trade or event interacts with these structural features.
F. Actionable Output — lead with conclusion and trade, then data. Format: Recommendation → Why → Portfolio Impact → Risk → Compliance Check.
G. Real-Time Research — you have web search available. Use it to check recent credit events, rating actions, loan trading levels, sector news, and market commentary when relevant to the discussion. Always cite your sources.

Your edge: connecting the credit view to the FULL structural constraints of THIS vehicle — not just the headline metrics but eligibility criteria, reinvestment rules, hedging conditions, redemption mechanics, and legal protections — in real time.

RULES:
- Never fabricate data. If you don't have a number, say so.
- Show your math on compliance impacts.
- When discussing a loan: always assess it relative to THIS CLO, not in the abstract.
- If a trade would breach a limit, flag it immediately with the specific limit and current cushion.
- Cite specific PPM sections when referencing constraints.
- Be direct, concise, and actionable. No throat-clearing.

${QUALITY_RULES}`;
}

// ─── Panel Generation ────────────────────────────────────────────────

export function profileAnalysisPrompt(profile: CloProfile): { system: string; user: string } {
  return {
    system: `You are an expert CLO credit analysis panel architect. Analyze a CLO manager's questionnaire responses and determine the optimal panel composition for their credit analysis needs.

Your analysis should consider their fund strategy, target sectors, risk appetite, concentration limits, covenant preferences, and any stated beliefs or biases.

Output a structured analysis with:
1. **Manager Profile Summary** — Key characteristics distilled from the questionnaire
2. **Panel Needs** — What types of credit expertise and perspectives this manager needs
3. **Recommended Roles** — 5-7 specific panel roles with rationale for each. Include at minimum:
   - A senior credit analyst (deep fundamental analysis)
   - A distressed debt specialist (downside/recovery expertise)
   - An industry/sector analyst (sector-specific knowledge)
   - A quantitative risk analyst (portfolio metrics, WARF, WAL)
   - A legal/structural expert (covenants, documentation, structure)
   - A portfolio strategist (relative value, portfolio construction)
4. **Dynamic Tensions** — Which roles will naturally disagree and why that is productive

${QUALITY_RULES}`,
    user: `Analyze this CLO manager profile and recommend panel composition:

${formatProfile(profile)}`,
  };
}

export function panelGenerationPrompt(
  profileAnalysis: string,
  profile: CloProfile
): { system: string; user: string } {
  return {
    system: `You are an expert at creating diverse, realistic credit analysis panel members for a CLO manager. Generate ~6 panel members based on the profile analysis.

Each member must have genuine depth — these are senior credit professionals with decades of experience, strong opinions, and distinct analytical frameworks.

## Required Diversity
- A senior credit analyst who dissects fundamentals
- A distressed debt specialist who instinctively sees downside and recovery scenarios
- An industry/sector analyst with deep domain knowledge
- A quantitative risk analyst focused on portfolio metrics and modeling
- A legal/structural expert who scrutinizes covenants and documentation
- A portfolio strategist focused on relative value and portfolio construction

## Format for Each Member

## Member N: Full Name | ROLE

### Background
2-3 sentences. Focus on career-defining experiences that shaped their credit worldview.

### Investment Philosophy
Their core credit belief system in 2-3 sentences.

### Specializations
3-5 areas of deep expertise, comma-separated.

### Decision Style
How they approach credit decisions — analytical, intuitive, consensus-seeking, etc.

### Risk Personality
Their relationship with risk — how they assess it, what makes them comfortable/uncomfortable.

### Notable Positions
2-3 bullet points of memorable credit positions they have taken (real-sounding but fictional).

### Blind Spots
1-2 things this person systematically underweights or fails to see.

### Full Profile
A detailed markdown profile (3-5 paragraphs) covering their career arc, credit track record highlights, how they interact with other panel members, and what they bring to the table.

## No Strawmen
Every member must be the strongest possible version of their perspective. If you can easily reconcile two members' positions, they are not different enough. The distressed debt specialist must have genuinely compelling reasons to be cautious, not just be "the negative one."

${QUALITY_RULES}`,
    user: `Generate the credit analysis panel based on this analysis:

Profile Analysis:
${profileAnalysis}

CLO Manager Profile:
${formatProfile(profile)}`,
  };
}

export function avatarMappingPrompt(members: string): string {
  return `Given the credit analysis panel member profiles below, map each member to DiceBear Adventurer avatar options that visually match their described profile — age, gender, ethnicity, personality, and professional appearance.

## Available Options

Pick ONE value for each field from these exact options:

- **skinColor**: "9e5622", "763900", "ecad80", "f2d3b1"
- **hair**: one of: "long01", "long02", "long03", "long04", "long05", "long06", "long07", "long08", "long09", "long10", "long11", "long12", "long13", "long14", "long15", "long16", "long17", "long18", "long19", "long20", "long21", "long22", "long23", "long24", "long25", "long26", "short01", "short02", "short03", "short04", "short05", "short06", "short07", "short08", "short09", "short10", "short11", "short12", "short13", "short14", "short15", "short16", "short17", "short18", "short19"
- **hairColor**: one of: "0e0e0e", "3eac2c", "6a4e35", "85c2c6", "796a45", "562306", "592454", "ab2a18", "ac6511", "afafaf", "b7a259", "cb6820", "dba3be", "e5d7a3"
- **eyes**: one of: "variant01", "variant02", "variant03", "variant04", "variant05", "variant06", "variant07", "variant08", "variant09", "variant10", "variant11", "variant12", "variant13", "variant14", "variant15", "variant16", "variant17", "variant18", "variant19", "variant20", "variant21", "variant22", "variant23", "variant24", "variant25", "variant26"
- **eyebrows**: one of: "variant01", "variant02", "variant03", "variant04", "variant05", "variant06", "variant07", "variant08", "variant09", "variant10", "variant11", "variant12", "variant13", "variant14", "variant15"
- **mouth**: one of: "variant01", "variant02", "variant03", "variant04", "variant05", "variant06", "variant07", "variant08", "variant09", "variant10", "variant11", "variant12", "variant13", "variant14", "variant15", "variant16", "variant17", "variant18", "variant19", "variant20", "variant21", "variant22", "variant23", "variant24", "variant25", "variant26", "variant27", "variant28", "variant29", "variant30"
- **glasses**: one of: "variant01", "variant02", "variant03", "variant04", "variant05", or "none"
- **features**: one of: "birthmark", "blush", "freckles", "mustache", or "none"

## Rules
- Match skin color to the member's implied ethnicity/background
- Match hair style and color to gender and age cues in the biography
- Use glasses for analytical/academic types when it fits
- Use "mustache" feature for older male members when appropriate
- Make each member visually distinct from the others

## Output Format

Return ONLY a valid JSON array with no markdown formatting, no code fences, no explanation. Each element:

[
  {
    "name": "Member Full Name",
    "skinColor": "...",
    "hair": "...",
    "hairColor": "...",
    "eyes": "...",
    "eyebrows": "...",
    "mouth": "...",
    "glasses": "...",
    "features": "..."
  }
]

Members:
${members}`;
}

// ─── Analysis ────────────────────────────────────────────────────────

export function creditAnalysisPrompt(
  analysis: Pick<LoanAnalysis, "title" | "analysisType" | "borrowerName" | "sector" | "loanType" | "spreadCoupon" | "rating" | "maturity" | "facilitySize" | "leverage" | "interestCoverage" | "covenantsSummary" | "ebitda" | "revenue" | "companyDescription" | "notes" | "switchBorrowerName" | "switchSector" | "switchLoanType" | "switchSpreadCoupon" | "switchRating" | "switchMaturity" | "switchFacilitySize" | "switchLeverage" | "switchInterestCoverage" | "switchCovenantsSummary" | "switchEbitda" | "switchRevenue" | "switchCompanyDescription" | "switchNotes">,
  profile: CloProfile,
  reportPeriodContext?: string
): { system: string; user: string } {
  return {
    system: `You are a senior CLO credit analyst. This analysis serves a specific CLO vehicle with specific constraints — every assessment must be grounded in THIS vehicle's PPM, compliance state, and portfolio composition.

Extract and organize:
1. **Key Credit Facts** — What we know for certain from the provided information
2. **Borrower Overview** — The borrower's business, market position, and competitive dynamics
3. **Capital Structure** — Leverage, coverage ratios, facility terms, and structural considerations
4. **Relative Value Assessment** — Is the spread compensation adequate for the risk? What are comparable credits trading at? What assumptions drive the spread?
5. **Management / Sponsor Assessment** — Who is the sponsor/management team? Track record in this sector? Alignment of incentives with lenders?
6. **Sector Dynamics** — Industry trends, cyclicality, and sector-specific risks
7. **Information Gaps** — What critical information is missing
8. **CLO Fit Assessment** — CRITICAL SECTION. For THIS CLO vehicle:
   - WARF contribution: what is this credit's rating factor and how does it move the portfolio WARF?
   - Concentration impact: single-name and industry concentration after adding this credit
   - WAL contribution: does the maturity fit within the CLO's WAL test?
   - Spread vs WAS: does this credit's spread help or hurt the weighted average spread?
   - CCC bucket impact: if rated CCC or at risk of downgrade, what is the CCC bucket impact?
   - OC/IC test impact: how does adding this credit affect overcollateralization and interest coverage tests?
   - Eligibility: does this credit meet ALL eligibility criteria (asset type, currency, minimum rating, domicile, ESG compliance, etc.)?
   - Reinvestment criteria: if post-reinvestment period, does this credit qualify under the restricted trading rules?
   - Portfolio profile tests: does adding this credit breach any of the 30+ portfolio profile test limits?
   - Hedging: if non-base-currency, does it require a currency hedge and is one available within limits?
   - Transfer restrictions: any issues with the credit's form or clearing that conflict with the CLO's transfer requirements?
   Reference ALL PPM constraints and compliance report when assessing fit.
9. **Preliminary Credit Flags** — Obvious credit risks based on available information
10. **Falsifiable Thesis** — State the credit thesis as 2-3 specific, testable claims. For each claim: what specific evidence would disprove it?
11. **Kill Criteria** — 3-5 specific conditions that, if true, should kill this credit regardless of other merits. These must be concrete and verifiable (e.g., "leverage exceeds 7x with no credible deleveraging path" not "too much leverage")

If source documents are attached (PPM/Listing Particulars, compliance reports, monthly reports, etc.), analyze them thoroughly — extract all relevant credit terms, portfolio data, concentration limits, OC/IC test results, and loan-level details. These documents are the primary source of truth and should take precedence over manually entered fields.

Be thorough but concise. Flag uncertainty explicitly — do not fill gaps with assumptions.

${QUALITY_RULES}`,
    user: `Analyze this loan opportunity:

${formatAnalysis(analysis)}

CLO Manager Profile:
${formatProfile(profile)}
${formatConstraints(profile.extractedConstraints, "full") ? `\nPPM CONSTRAINTS (use for CLO Fit Assessment math):\n${formatConstraints(profile.extractedConstraints, "full")}` : ""}
${formatPortfolioState(profile.extractedPortfolio) ? `\nCURRENT PORTFOLIO STATE (use as baseline for impact calculations):\n${formatPortfolioState(profile.extractedPortfolio)}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (extracted from latest compliance report — use for all compliance test numbers, pool metrics, concentration breakdowns, and portfolio composition):\n${reportPeriodContext}` : ""}`,
  };
}

export function dynamicSpecialistPrompt(
  analysis: string,
  existingMembers: PanelMember[],
  profile: CloProfile
): { system: string; user: string } {
  return {
    system: `You are a CLO panel staffing advisor. Based on a credit analysis and the existing panel, determine if additional specialist expertise is needed for this specific loan review.

If the loan requires deep domain expertise not covered by the existing panel (e.g., healthcare regulatory for a pharma borrower, maritime expertise for a shipping company), generate 1-2 dynamic specialists.

If the existing panel already covers the needed expertise, output exactly:
NO_ADDITIONAL_SPECIALISTS_NEEDED

If specialists are needed, output them in this format:

## Member N: Full Name | ROLE

### Background
2-3 sentences of relevant domain expertise.

### Investment Philosophy
Their approach to credit analysis in this specific domain.

### Specializations
3-5 areas, comma-separated.

### Decision Style
How they evaluate credits in this domain.

### Risk Personality
Their risk assessment approach for this domain.

### Notable Positions
2-3 bullet points.

### Blind Spots
1-2 items.

${QUALITY_RULES}`,
    user: `Should we add specialists for this loan review?

Credit Analysis:
${analysis}

Existing Panel Members:
${formatMembers(existingMembers)}

CLO Manager Profile:
${formatProfile(profile)}`,
  };
}

export function individualAssessmentsPrompt(
  members: PanelMember[],
  analysis: string,
  profile: CloProfile,
  history: string,
  reportPeriodContext?: string
): { system: string; user: string } {
  const historySection = history
    ? `\n\n## Panel History\nPrevious analyses for context on how the panel has evolved:\n${history}`
    : "";

  return {
    system: `You are simulating a credit analysis panel where each member gives their initial independent assessment of a loan opportunity before group discussion.

Each member must assess the loan through their specific lens — risk personality, credit philosophy, and specializations. Assessments should be genuinely independent and reflect each member's character.

For each member, output:

## [MemberName]

### Position
Their initial stance on the credit (2-3 sentences).

### Key Points
Bulleted list of 3-5 points that support or inform their position.

### Concerns
Bulleted list of 2-4 specific concerns from their perspective.

### Assumptions
Label each key assumption underlying the member's position as one of:
- [VERIFIED] — backed by audited financials, public filings, or independently verifiable data
- [MANAGEMENT CLAIM] — stated by company/sponsor but not independently verified (e.g., projected EBITDA, synergy targets)
- [ASSUMPTION] — the member is filling an information gap with judgment

This labeling must carry forward into all subsequent phases.

Members must stay in character. A distressed debt specialist should see different things than a portfolio strategist. The quant risk analyst should focus on metrics while the legal expert examines covenants. Specifically:
- The **legal/structural expert** MUST reference the CLO's actual structural provisions — events of default triggers, redemption mechanics, hedging requirements, voting/control provisions, interest deferral mechanics, and transfer restrictions from the PPM constraints.
- The **quant risk analyst** MUST check the credit against ALL portfolio profile tests, coverage tests, collateral quality tests, and concentration limits — not just headline WARF/WAS/WAL.
- The **portfolio strategist** MUST assess eligibility criteria compliance and reinvestment criteria fit.

${QUALITY_RULES}`,
    user: `Each panel member should give their initial credit assessment:

Credit Analysis:
${analysis}

Panel Members:
${formatMembers(members)}

CLO Manager Profile:
${formatProfile(profile)}${historySection}
${formatConstraints(profile.extractedConstraints, "full") ? `\nPPM CONSTRAINTS (members must reference these — especially structural/legal expert):\n${formatConstraints(profile.extractedConstraints, "full")}` : ""}
${formatPortfolioState(profile.extractedPortfolio) ? `\nCURRENT PORTFOLIO STATE:\n${formatPortfolioState(profile.extractedPortfolio)}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (actual test results, pool metrics, concentrations, events — members MUST reference these numbers):\n${reportPeriodContext}` : ""}`,
  };
}

export function analysisDebatePrompt(
  members: PanelMember[],
  assessments: string,
  analysis: string,
  profile: CloProfile,
  reportPeriodContext?: string
): { system: string; user: string } {
  return {
    system: `You are orchestrating a structured credit panel debate with 3 rounds. Panel members challenge each other's assessments with genuine adversarial pressure on the borrower's creditworthiness.

## Structure

### Round 1: Steel-Man Then Attack
Each member must first state the strongest version of a specific opposing member's argument (name them), THEN explain why it's still wrong from a credit perspective. No one may simply restate their own position — they must demonstrate they understand the other side before attacking it.

### Round 2: Kill Criteria Test
For each kill criterion from the credit analysis, members debate whether the evidence meets or fails the threshold. The distressed debt specialist leads, but all members must weigh in. For each criterion, reach an explicit verdict: CLEARED, UNRESOLVED, or FAILED.

### Round 3: What Changes Your Mind?
Each member states the single piece of credit information that would flip their position (e.g., "if interest coverage drops below 1.5x" or "if the covenant package gets tightened to include a leverage ratchet"). Others challenge whether that information is obtainable and whether the stated threshold is honest. If any member's position hasn't changed at all from their initial assessment, they must explain why — not just restate.

## Early Consensus Rule
If after Round 2 the panel has reached genuine consensus (all kill criteria CLEARED with no meaningful dissent, OR a kill criterion FAILED with unanimous agreement), you may skip Round 3. Instead, write a brief "## Consensus Reached" section explaining why further debate would not surface new information. Only do this if consensus is truly unanimous — a single substantive dissent means Round 3 must proceed.

## Format

Use clear round headers and **Speaker:** attribution:

## Round 1: Steel-Man Then Attack

**MemberName:** Their statement here.

**AnotherMember:** Their response.

## Rules
- Members ENGAGE with each other by name, not just restate positions
- At least one member should visibly update their view during the debate
- The debate should surface credit risks or strengths that no single assessment captured
- For switch analyses, frame the debate as a comparative assessment of the two credits
- Keep exchanges sharp — 2-4 sentences per turn, not paragraphs
- Assumption labels ([VERIFIED], [MANAGEMENT CLAIM], [ASSUMPTION]) from assessments must be preserved when referencing claims
- Convergence check: When members appear to agree, one member must challenge: "Are we actually agreeing, or using different words for different positions?" Surface at least one case where apparent agreement masks a real disagreement.
- Members speak only when their expertise genuinely informs the point. Not every member needs to respond to every topic. Silence is better than filler.
- Brevity signals understanding. The best debate contributions are 2-4 sentences that change how others think, not paragraphs that restate a framework.
- At least once during the debate, a member must be challenged on their stated blind spot (from their profile). The challenger should name the blind spot and explain how it applies to this specific credit.
- The legal/structural expert should raise at least one point about the CLO's structural provisions (events of default, redemption mechanics, hedging requirements, interest deferral, or voting/control) that interacts with this credit.
- When debating portfolio fit, members must reference specific PPM constraints — not just "it might breach limits" but "the single-name limit is 2.5% and this would use X% of it."

${QUALITY_RULES}`,
    user: `Run the credit panel debate:

Individual Assessments:
${assessments}

Credit Analysis:
${analysis}

Panel Members:
${formatMembers(members)}

CLO Manager Profile:
${formatProfile(profile)}
${formatConstraints(profile.extractedConstraints, "full") ? `\nPPM CONSTRAINTS (reference specific provisions in the debate):\n${formatConstraints(profile.extractedConstraints, "full")}` : ""}
${formatPortfolioState(profile.extractedPortfolio) ? `\nCURRENT PORTFOLIO STATE:\n${formatPortfolioState(profile.extractedPortfolio)}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (use actual test cushions, WARF, WAS, concentrations when debating portfolio impact):\n${reportPeriodContext}` : ""}`,
  };
}

export function premortemPrompt(
  members: PanelMember[],
  debate: string,
  analysis: string,
  profile: CloProfile,
  reportPeriodContext?: string
): { system: string; user: string } {
  return {
    system: `You are facilitating a structured pre-mortem exercise for a CLO credit analysis panel. Research shows pre-mortems improve decision accuracy by ~30%.

## Premise
It is 18 months later and this loan has defaulted or been significantly downgraded. The panel must explain what went wrong.

## Phase 1: Individual Failure Narratives
Each panel member writes a 3-5 sentence narrative explaining what went wrong — from their specific area of expertise. The distressed debt specialist focuses on what recovery looks like now, the credit analyst on what fundamental deterioration occurred, the quant on what portfolio metrics blew through limits, the legal expert on what covenant failures enabled the deterioration, etc.

## Phase 2: Plausibility Ranking
Given these failure scenarios, rank them from most to least plausible. For the top 3 most plausible scenarios:
- What specific evidence available TODAY supports or contradicts this failure mode?
- What would you need to see TODAY to rule it out?
- Does this failure mode interact with any of the kill criteria from the credit analysis?

## Phase 3: CLO-Specific Vulnerabilities
Given the full PPM constraints, which failure scenarios would cause the most damage to THIS specific CLO portfolio? Consider:
- Coverage test breaches (OC/IC) and resulting waterfall diversion
- WARF/WAS/WAL/diversity score limit breaches
- CCC bucket overflow and excess CCC haircuts
- Concentration limit breaches (single-name, industry, sector)
- Event of Default triggers — would this default cause a Note Event of Default?
- Reinvestment period interaction — does the failure occur during or post-reinvestment? How does that change the manager's ability to trade?
- Hedging exposure — if the credit is non-EUR, is there counterparty risk on the currency hedge?
- Interest deferral cascades — would coverage test failure trigger deferral on junior classes?
A single-name default that's manageable for a diversified portfolio may be catastrophic if it pushes the CLO past structural triggers.

## Format

### Failure Narratives

**MemberName (Role):** Their failure narrative here.

### Plausibility Ranking

1. **Most Plausible Failure:** Description
   - Evidence today: ...
   - What would rule it out: ...
   - Kill criteria interaction: ...

### CLO-Specific Vulnerabilities
Analysis of which failures are most damaging given this manager's portfolio constraints.

${QUALITY_RULES}`,
    user: `Run the pre-mortem exercise:

Debate Transcript:
${debate}

Credit Analysis:
${analysis}

Panel Members:
${formatMembers(members)}

CLO Manager Profile:
${formatProfile(profile)}
${formatConstraints(profile.extractedConstraints, "compact") ? `\nPPM CONSTRAINTS:\n${formatConstraints(profile.extractedConstraints, "compact")}` : ""}
${formatPortfolioState(profile.extractedPortfolio) ? `\nCURRENT PORTFOLIO STATE:\n${formatPortfolioState(profile.extractedPortfolio)}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (actual compliance state — use for CLO-specific vulnerability assessment):\n${reportPeriodContext}` : ""}`,
  };
}

export function creditMemoPrompt(
  debate: string,
  assessments: string,
  analysis: string,
  profile: CloProfile,
  title?: string,
  premortem?: string,
  reportPeriodContext?: string
): { system: string; user: string } {
  return {
    system: `You are a senior credit analyst synthesizing a panel debate into a formal credit memo.

## Required Sections

# ${title || "[Loan Title]"} — Credit Memo

## Executive Summary
3-5 bullet points capturing the key conclusion and credit recommendation.

## Company/Borrower Overview
Business description, market position, competitive landscape, and management/sponsor assessment. Include sponsor track record and incentive alignment.

## Financial Analysis
Key financial metrics discussed — leverage, coverage, EBITDA margins, revenue trends, free cash flow. Include the falsifiable claims from the credit analysis and note whether they were challenged or validated during the debate. Note: base this on what was discussed, do not fabricate numbers.

## Credit Strengths
Bulleted list of factors supporting the credit, ranked by significance.

## Credit Weaknesses
Bulleted list of credit concerns, ranked by severity. Incorporate the most plausible failure scenarios from the pre-mortem exercise.

## Structural Review
Covenant package assessment, documentation quality, security/collateral, and structural protections. Reference the CLO's own structural features where relevant: hedging requirements, interest deferral mechanics, redemption provisions, events of default triggers, voting/control provisions, and reinvestment criteria that affect how this credit interacts with the vehicle.

## Relative Value
Spread compensation relative to risk, comparison to comparable credits, and fair value assessment.

## Pre-Mortem Findings
Summarize the top 3 most plausible default/downgrade scenarios and what evidence today supports or contradicts each. Note which scenarios are most damaging given this CLO's specific portfolio constraints.

## Kill Criteria Status
For each kill criterion from the credit analysis, state whether it was CLEARED, UNRESOLVED, or FAILED during the debate.

## Portfolio Context
How does this credit fit or conflict with the current CLO portfolio holdings? Reference compliance cushions from the compliance report if available. Assess impact on diversification, WARF, WAS, WAL, and concentration limits.

## Recommendation
The panel's synthesized view — not a simple vote count but a reasoned conclusion reflecting the weight of argument. For switch analyses, include a comparative section explaining whether the switch improves portfolio quality.

## Self-Verification
Before finalizing, audit your own output:
- Are all financial figures sourced from the debate/analysis, not invented?
- Does every "Information Gap" from the credit analysis appear verbatim?
- Are assumption labels ([VERIFIED], [MANAGEMENT CLAIM], [ASSUMPTION]) preserved where referenced?
- Would a reader who hasn't seen the debate understand this memo standalone?

## Quality Gates (apply before finalizing)
- Plaintext test: For every key claim, rewrite it in one sentence using no jargon. If the plain version sounds obvious or empty, the original was disguising a lack of substance — delete it.
- Falsifiability test: For every major claim, what evidence would disprove it? If nothing could, the claim is empty — delete it.

${QUALITY_RULES}`,
    user: `Synthesize this credit panel debate into a credit memo:

Debate Transcript:
${debate}

Individual Assessments:
${assessments}

Credit Analysis:
${analysis}
${premortem ? `\nPre-Mortem Analysis:\n${premortem}` : ""}

CLO Manager Profile:
${formatProfile(profile)}
${formatConstraints(profile.extractedConstraints, "full") ? `\nPPM CONSTRAINTS:\n${formatConstraints(profile.extractedConstraints, "full")}` : ""}
${formatPortfolioState(profile.extractedPortfolio) ? `\nCURRENT PORTFOLIO STATE (reference for Portfolio Context section):\n${formatPortfolioState(profile.extractedPortfolio)}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (use actual numbers for Portfolio Context — test cushions, pool metrics, concentrations, events):\n${reportPeriodContext}` : ""}`,
  };
}

export function riskAssessmentPrompt(
  debate: string,
  analysis: string,
  profile: CloProfile,
  premortem?: string,
  reportPeriodContext?: string
): { system: string; user: string } {
  return {
    system: `You are a risk assessment specialist producing a structured risk report for a loan opportunity based on the credit panel debate. Show your math — provide numeric estimates for all constraint checks where possible.

## Required Output

## Overall Risk Rating
State one of: low, moderate, high, very-high
Provide a 1-2 sentence justification.

## Risk Categories

For each category below, provide:
- **Level**: low / moderate / high / very-high
- **Analysis**: 2-3 sentences on the specific risks identified

Categories:
1. **Credit Risk** — borrower fundamentals, default probability, recovery expectations
2. **Market Risk** — spread volatility, secondary market liquidity, mark-to-market exposure
3. **Liquidity Risk** — loan trading liquidity, CLO reinvestment flexibility, redemption risk
4. **Structural Risk** — covenant quality, documentation gaps, subordination, collateral
5. **Sector Risk** — industry cyclicality, regulatory headwinds, competitive dynamics
6. **Concentration Risk** — single-name exposure, sector overlap, portfolio WARF impact

## CLO Constraint Violations
Check the loan against ALL of the manager's PPM constraints and flag any violations:
- **Eligibility Criteria**: Does this credit meet every eligibility criterion (asset type, currency, rating floor, domicile, ESG compliance, minimum obligor size, etc.)? Check each criterion.
- **Concentration Limits**: Does adding this name breach single-name, sector, or industry concentration limits? Check against ALL portfolio profile tests.
- **Rating Thresholds**: Does this credit's rating fit within the CLO's rating bucket limits? Would it push the CCC bucket over the limit?
- **WARF Impact**: How does adding this credit affect the portfolio's weighted average rating factor?
- **Spread Targets**: Does the spread meet the portfolio's minimum spread target?
- **WAL Impact**: Does the maturity fit within WAL limits?
- **Coverage Tests**: Impact on OC/IC test cushions at every tranche level?
- **Reinvestment Criteria**: Is the CLO in or past its reinvestment period? Does this credit qualify under the applicable trading rules?
- **Hedging**: If non-base-currency, is a currency hedge required? Does it fit within the max currency hedge percentage?
- **Transfer Restrictions**: Any form/clearing issues that conflict with the CLO's restrictions?
- **Collateral Quality Tests**: Impact on Fitch WARF, minimum recovery rate, S&P CDO Monitor, and other quality tests?

For each constraint, state explicitly: WITHIN LIMITS, AT RISK, or VIOLATED.

## Portfolio Impact
How does adding this loan interact with the existing CLO portfolio? Does it improve or worsen diversification? What is the marginal impact on WARF, WAL, and spread? Does it help or hurt the CLO's compliance tests?

## Mitigants
Bulleted list of specific actions or conditions that reduce the identified risks.

Ground your analysis primarily in what was discussed during the debate and pre-mortem, but you may identify additional risks that are standard for this type of credit even if not explicitly raised. Pay special attention to the most plausible default/downgrade scenarios from the pre-mortem.

## Quality Gates (apply before finalizing)
- Plaintext test: For every key claim, rewrite it in one sentence using no jargon. If the plain version sounds obvious or empty, the original was disguising a lack of substance — delete it.
- Falsifiability test: For every major claim, what evidence would disprove it? If nothing could, the claim is empty — delete it.

${QUALITY_RULES}`,
    user: `Produce the risk assessment:

Debate Transcript:
${debate}

Credit Analysis:
${analysis}
${premortem ? `\nPre-Mortem Analysis:\n${premortem}` : ""}

CLO Manager Profile:
${formatProfile(profile)}
${formatConstraints(profile.extractedConstraints, "full") ? `\nPPM CONSTRAINTS (use for constraint violation checks):\n${formatConstraints(profile.extractedConstraints, "full")}` : ""}
${formatPortfolioState(profile.extractedPortfolio) ? `\nCURRENT PORTFOLIO STATE (use as baseline for portfolio impact math):\n${formatPortfolioState(profile.extractedPortfolio)}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (actual compliance state — use for all constraint violation checks and portfolio impact math):\n${reportPeriodContext}` : ""}`,
  };
}

export function recommendationPrompt(
  memo: string,
  risk: string,
  debate: string,
  members: PanelMember[],
  profile: CloProfile,
  premortem?: string,
  reportPeriodContext?: string
): { system: string; user: string } {
  const constraints = formatConstraints(profile.extractedConstraints, "full");
  const portfolioState = formatPortfolioState(profile.extractedPortfolio);

  return {
    system: `You are facilitating the final credit panel vote. Each panel member casts their vote based on the full debate, credit memo, risk assessment, and pre-mortem.

## Format

For each member:

## [MemberName]
Vote: [strong_buy / buy / hold / pass / strong_pass]
Conviction: [high / medium / low]
Rationale: 2-3 sentences explaining their vote, referencing specific points from the debate.

After all individual votes, provide:

## Aggregate Recommendation
- **Verdict**: The panel's overall recommendation based on the vote pattern and weight of argument (not just majority). For switch analyses, the verdict should specifically address whether to proceed with the switch.
- **Dissents**: Any notable dissents and their reasoning
- **Conditions**: Specific conditions or milestones that would change the recommendation
- **Trade Implementation**: If PASS — what conditions make it a BUY? If BUY — optimal position size given CLO constraints, WARF/WAS impact, concentration utilization
- **Kill Criteria Status**: For each kill criterion, confirm whether it has been CLEARED or flag it as UNRESOLVED. Any FAILED criterion must be prominently noted.
- **Pre-Mortem Response**: Address the top 2-3 most plausible default/downgrade scenarios — what makes the panel confident (or not) that they won't occur?

## PPM Compliance Impact (REQUIRED)
Before finalizing the verdict, stress-test this loan against ALL of the CLO's PPM constraints. For each applicable limit below, show the math:
- **Eligibility**: Does this credit pass every eligibility criterion? If any criterion fails, the verdict MUST be PASS.
- **Concentration limits**: Would adding this loan breach any single-name, sector, industry, or portfolio profile test limit? Check ALL profile tests, not just headline limits.
- **WARF**: Show current WARF, estimated new WARF with this loan, and the PPM limit.
- **WAS**: Show current WAS, estimated new WAS, and the PPM minimum.
- **CCC bucket**: Show current %, projected %, and the limit.
- **WAL**, **diversity score**, **OC/IC test cushions**: Impact at every tranche level.
- **Collateral quality tests**: Impact on Fitch WARF, recovery rate, S&P CDO Monitor.
- **Reinvestment criteria**: Is this purchase permitted given the current reinvestment period status?
- **Hedging**: If non-base-currency, does it fit within the max currency hedge percentage?
- **Structural triggers**: Could this credit, if it deteriorates, trigger a coverage test failure that causes interest deferral on junior classes or diverts principal through the reinvestment OC test?
- If ANY hard limit would be breached, the verdict MUST be PASS regardless of credit quality — flag the specific breach prominently.
- If data is insufficient to calculate a specific impact, state what data is missing rather than skipping the check.

## Consistency Rules
- Each member's final vote must be CONSISTENT with their debate positions. If a member raised serious unresolved concerns during the debate, they cannot vote strong_buy without explaining what resolved those concerns.
- If a member's position has shifted from the debate, they must explicitly state what changed their mind.
- A distressed debt specialist who raised serious recovery concerns should not suddenly vote strong_buy without explanation.

## Quality Gates (apply before finalizing)
- Plaintext test: For every key claim, rewrite it in one sentence using no jargon. If the plain version sounds obvious or empty, the original was disguising a lack of substance — delete it.
- Falsifiability test: For every major claim, what evidence would disprove it? If nothing could, the claim is empty — delete it.

${QUALITY_RULES}`,
    user: `Each member casts their final vote:

Credit Memo:
${memo}

Risk Assessment:
${risk}

Debate Transcript:
${debate}
${premortem ? `\nPre-Mortem Analysis:\n${premortem}` : ""}

Panel Members:
${formatMembers(members)}

CLO Manager Profile:
${formatProfile(profile)}
${constraints ? `\nPPM CONSTRAINTS (use these for compliance impact math):\n${constraints}` : ""}
${portfolioState ? `\nCURRENT PORTFOLIO STATE (use these as baseline for impact calculations):\n${portfolioState}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (actual test results and pool metrics — use for PPM Compliance Impact section math):\n${reportPeriodContext}` : ""}`,
  };
}

// ─── Screening ───────────────────────────────────────────────────────

export function portfolioGapAnalysisPrompt(
  profile: CloProfile,
  recentAnalyses: string,
  reportPeriodContext?: string
): { system: string; user: string } {
  const portfolioState = formatPortfolioState(profile.extractedPortfolio);

  return {
    system: `You are a CLO portfolio strategist analyzing gaps in a CLO portfolio relative to the manager's stated targets and constraints.

The CLO's PPM/Listing Particulars and compliance reports are attached as document content. Use these as the primary source of truth for all constraints, test thresholds, and portfolio composition.

Produce a structured analysis:

## Portfolio Summary
Current portfolio characteristics, stated objectives, and key metrics (WARF, WAL, spread targets, sector exposure). Use actual numbers from the compliance report where available.

## Gap Analysis
Where the portfolio diverges from stated goals — WARF drift, WAL mismatches, spread compression, sector over/under-exposure, rating bucket imbalances, concentration limit proximity. Reference specific test cushions and how close each metric is to its limit.

## Opportunity Areas
3-5 areas where new loan additions could close identified gaps, ranked by impact. Show the math — e.g. "adding a B1-rated credit with 400bps spread would improve WAS by ~2bps while staying within WARF limit (current: 2850, limit: 3000)."

## Constraints
Factors that limit available options — reference ALL PPM constraints: eligibility criteria, portfolio profile tests, concentration limits, coverage tests, collateral quality tests, reinvestment criteria, hedging limits, and transfer restrictions. Reference specific PPM thresholds and current utilization.

${QUALITY_RULES}`,
    user: `Analyze CLO portfolio gaps:

CLO Manager Profile:
${formatProfile(profile)}
${formatConstraints(profile.extractedConstraints, "full") ? `\nPPM CONSTRAINTS (reference all applicable limits):\n${formatConstraints(profile.extractedConstraints, "full")}` : ""}
${portfolioState ? `\nCURRENT PORTFOLIO STATE:\n${portfolioState}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (actual compliance state — use for gap analysis baseline, test cushions, concentration utilization):\n${reportPeriodContext}` : ""}

Recent Analyses:
${recentAnalyses || "No recent analyses."}`,
  };
}

export function screeningDebatePrompt(
  members: PanelMember[],
  gapAnalysis: string,
  focusArea: string,
  profile: CloProfile,
  reportPeriodContext?: string
): { system: string; user: string } {
  const portfolioState = formatPortfolioState(profile.extractedPortfolio);

  return {
    system: `You are orchestrating a credit panel loan screening session where panel members discuss loan opportunities to address CLO portfolio gaps.

The CLO's PPM/Listing Particulars and compliance reports are attached as document content. Members should reference specific constraints and current compliance state when evaluating proposals.

The panel should:
1. React to the gap analysis — do they agree with the identified portfolio gaps?
2. Propose specific loan characteristics, sectors, or credit themes within the focus area
3. Challenge each other's proposals on credit quality AND portfolio fit — does adding this type of credit breach any concentration limit, portfolio profile test, or eligibility criterion? Does it help or hurt WARF/WAS/WAL/coverage tests?
4. Build on promising screening criteria collaboratively
5. Quantify compliance impact where possible — "adding a CCC credit would push the bucket from 5.2% to ~5.8%, still within the 7.5% limit"
6. Consider structural constraints — reinvestment criteria (if post-RP), hedging requirements for non-base-currency credits, and eligibility criteria that filter out certain asset types

Format as a natural discussion with **Speaker:** attribution. 2-3 rounds of exchange. Each member should contribute at least once based on their specialization.

${QUALITY_RULES}`,
    user: `Run the loan screening debate:

Focus Area: ${focusArea || "General portfolio optimization"}

Gap Analysis:
${gapAnalysis}
${formatConstraints(profile.extractedConstraints, "full") ? `\nPPM CONSTRAINTS (reference when evaluating proposals):\n${formatConstraints(profile.extractedConstraints, "full")}` : ""}
${portfolioState ? `\nCURRENT PORTFOLIO STATE:\n${portfolioState}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (use actual test cushions and concentrations when evaluating compliance impact of proposals):\n${reportPeriodContext}` : ""}

Panel Members:
${formatMembers(members)}

CLO Manager Profile:
${formatProfile(profile)}`,
  };
}

export function screeningSynthesisPrompt(
  debate: string,
  gapAnalysis: string,
  profile: CloProfile,
  reportPeriodContext?: string
): { system: string; user: string } {
  const portfolioState = formatPortfolioState(profile.extractedPortfolio);

  return {
    system: `You are synthesizing a credit panel loan screening session into 3-5 structured loan opportunity ideas.

The CLO's PPM/Listing Particulars and compliance reports are attached as document content. Every constraint check must reference the actual current portfolio state and PPM limits.

For each idea, output:

## Idea N: Title

### Thesis
2-3 sentences on the core credit argument and portfolio fit.

### Sector
The target sector or industry.

### Loan Type
The loan structure (e.g., first lien term loan, second lien, unitranche).

### Risk Level
low / moderate / high / very-high

### Expected Spread
Qualitative or quantitative spread expectation (e.g., "L+400-450bps").

### Rationale
Why this loan profile addresses the identified portfolio gaps and aligns with the manager's strategy.

### Key Risks
Bulleted list of 2-4 risks.

### Feasibility Score
Rate 1-5 — how actionable is this loan idea given the CLO's constraints? (1 = breaches multiple limits, 5 = fully compliant and actionable)

### Key Assumption
The single assumption that, if wrong, makes this loan idea worthless.

### Constraint Check
Does this idea violate any stated CLO constraints? Check ALL of: eligibility criteria, portfolio profile tests, concentration limits, coverage tests, collateral quality tests, WARF/WAS/WAL/diversity, CCC bucket, reinvestment criteria, hedging limits, and ESG exclusions. State explicitly: CLEAR or VIOLATION with explanation.

### Implementation Steps
Numbered list of 3-5 concrete next steps.

${QUALITY_RULES}`,
    user: `Synthesize the screening session into structured loan ideas:

Debate Transcript:
${debate}

Gap Analysis:
${gapAnalysis}
${formatConstraints(profile.extractedConstraints, "full") ? `\nPPM CONSTRAINTS (use for constraint checks):\n${formatConstraints(profile.extractedConstraints, "full")}` : ""}
${portfolioState ? `\nCURRENT PORTFOLIO STATE:\n${portfolioState}` : ""}
${reportPeriodContext ? `\nCOMPLIANCE REPORT DATA (use actual compliance numbers for constraint checks and feasibility scoring):\n${reportPeriodContext}` : ""}

CLO Manager Profile:
${formatProfile(profile)}`,
  };
}
