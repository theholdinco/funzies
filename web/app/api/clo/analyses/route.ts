import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { getPanelForUser } from "@/lib/clo/access";
import { canonicalCurrency } from "@/lib/clo/currency";

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const panel = await getPanelForUser(user.id);
  if (!panel) {
    return NextResponse.json({ error: "No panel found" }, { status: 404 });
  }

  const analyses = await query(
    `SELECT id, title, status, current_phase, analysis_type, borrower_name, created_at, completed_at
     FROM clo_analyses
     WHERE panel_id = $1
     ORDER BY created_at DESC`,
    [panel.id]
  );

  return NextResponse.json(analyses);
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const panel = await getPanelForUser(user.id);
  if (!panel) {
    return NextResponse.json({ error: "No panel found" }, { status: 404 });
  }

  if (panel.status !== "active") {
    return NextResponse.json(
      { error: "Panel must be active to create analyses" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const {
    title,
    analysisType,
    hasFiles,
    borrowerName,
    sector,
    loanType,
    spreadCoupon,
    rating,
    maturity,
    currency,
    facilitySize,
    leverage,
    interestCoverage,
    covenantsSummary,
    ebitda,
    revenue,
    companyDescription,
    notes,
    switchBorrowerName,
    switchSector,
    switchLoanType,
    switchSpreadCoupon,
    switchRating,
    switchMaturity,
    switchCurrency,
    switchFacilitySize,
    switchLeverage,
    switchInterestCoverage,
    switchCovenantsSummary,
    switchEbitda,
    switchRevenue,
    switchCompanyDescription,
    switchNotes,
  } = body;
  const normalizedCurrency = typeof currency === "string" && currency.trim()
    ? canonicalCurrency(currency) ?? currency.trim().toUpperCase()
    : null;
  const currencyRaw = typeof currency === "string" && currency.trim() ? currency.trim() : null;
  const currencyCanonical = currencyRaw ? canonicalCurrency(currencyRaw) : null;
  const normalizedSwitchCurrency = typeof switchCurrency === "string" && switchCurrency.trim()
    ? canonicalCurrency(switchCurrency) ?? switchCurrency.trim().toUpperCase()
    : null;
  const switchCurrencyRaw = typeof switchCurrency === "string" && switchCurrency.trim() ? switchCurrency.trim() : null;
  const switchCurrencyCanonical = switchCurrencyRaw ? canonicalCurrency(switchCurrencyRaw) : null;

  if (!title) {
    return NextResponse.json(
      { error: "Title is required" },
      { status: 400 }
    );
  }

  if (analysisType && analysisType !== "buy" && analysisType !== "switch") {
    return NextResponse.json(
      { error: "analysisType must be 'buy' or 'switch'" },
      { status: 400 }
    );
  }

  const rows = await query<{ id: string }>(
    `INSERT INTO clo_analyses (
      panel_id, title, analysis_type, borrower_name, sector, loan_type,
      spread_coupon, rating, maturity, currency,
      currency_raw, currency_canonical, currency_source,
      facility_size, leverage,
      interest_coverage, covenants_summary, ebitda, revenue,
      company_description, notes,
      switch_borrower_name, switch_sector, switch_loan_type,
      switch_spread_coupon, switch_rating, switch_maturity, switch_currency,
      switch_currency_raw, switch_currency_canonical, switch_currency_source,
      switch_facility_size, switch_leverage, switch_interest_coverage,
      switch_covenants_summary, switch_ebitda, switch_revenue,
      switch_company_description, switch_notes,
      status
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
      $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40
    ) RETURNING id`,
    [
      panel.id,
      title,
      analysisType || "buy",
      borrowerName || null,
      sector || null,
      loanType || null,
      spreadCoupon || null,
      rating || null,
      maturity || null,
      normalizedCurrency,
      currencyRaw,
      currencyCanonical,
      currencyRaw ? "analysis_form" : null,
      facilitySize || null,
      leverage || null,
      interestCoverage || null,
      covenantsSummary || null,
      ebitda || null,
      revenue || null,
      companyDescription || null,
      notes || null,
      switchBorrowerName || null,
      switchSector || null,
      switchLoanType || null,
      switchSpreadCoupon || null,
      switchRating || null,
      switchMaturity || null,
      normalizedSwitchCurrency,
      switchCurrencyRaw,
      switchCurrencyCanonical,
      switchCurrencyRaw ? "analysis_form" : null,
      switchFacilitySize || null,
      switchLeverage || null,
      switchInterestCoverage || null,
      switchCovenantsSummary || null,
      switchEbitda || null,
      switchRevenue || null,
      switchCompanyDescription || null,
      switchNotes || null,
      hasFiles ? "uploading" : "queued",
    ]
  );

  return NextResponse.json({ id: rows[0].id }, { status: 201 });
}
