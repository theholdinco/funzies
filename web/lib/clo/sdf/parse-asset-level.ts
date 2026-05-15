import {
  parseCsvLines,
  parseNumeric,
  parsePercentage,
  parseBoolean,
  parseDate,
  trimRating,
} from "./csv-utils";
import { validateMagnitude } from "./magnitude-validator";
import type { SdfParseResult } from "./types";

export interface SdfAssetLevelRow {
  // Matching keys
  issuer_name: string | null;
  security_name: string | null;
  lxid: string | null;

  // Issuer-level ratings
  moodys_issuer_rating: string | null;
  moodys_issuer_sr_unsec_rating: string | null;
  moodys_rating_final: string | null;
  sp_issuer_rating: string | null;
  sp_rating_final: string | null;
  fitch_issuer_rating: string | null;
  fitch_rating_final: string | null;

  // Security-level ratings
  moodys_security_rating: string | null;
  sp_security_rating: string | null;
  fitch_security_rating: string | null;

  // Derived/adjusted ratings
  moodys_dp_rating: string | null;
  moodys_rating_unadjusted: string | null;

  // Credit watch
  moodys_issuer_watch: string | null;
  moodys_security_watch: string | null;
  sp_issuer_watch: string | null;
  sp_security_watch: string | null;

  // Seniority
  security_level_moodys: string | null;
  security_level_sp: string | null;
  security_level: string | null;
  lien_type: string | null;
  sp_priority_category: string | null;

  // Industry codes
  sp_industry_code: string | null;
  moodys_industry_code: string | null;
  fitch_industry_code: string | null;

  // KBRA
  kbra_industry: string | null;
  kbra_rating: string | null;
  kbra_recovery_rate: number | null;

  // Structural
  pik_amount: number | null;
  /** Derived from `pik_amount > 0` at the parser boundary (the SDF
   *  Asset_Level CSV does not carry an explicit Is_PIK column; the
   *  per-period accrued amount IS the structural signal). Null when
   *  pik_amount is null/zero AND no other source provides the flag. */
  is_pik: boolean | null;
  /** Live forward PIK rate in basis points. Sourced from SDF column
   *  `Current_Facility_Spread_PIK` (per-annum decimal, multiplied by
   *  10000 at the parser boundary per anti-pattern #5). Drives the
   *  engine's per-loan PIK accretion in the additive model; zero
   *  when the PIK toggle is currently off (e.g.
   *  Tele Columbus, where pik_amount > 0 captures historical PIK
   *  already absorbed into par but pik_spread_bps = 0). */
  pik_spread_bps: number | null;
  credit_spread_adj: number | null;
  is_current_pay: boolean | null;
  is_defaulted: boolean | null;
  is_sovereign: boolean | null;
  is_enhanced_bond: boolean | null;
  is_interest_only: boolean | null;
  is_principal_only: boolean | null;
  accretion_factor: number | null;
  aggregate_amortized_cost: number | null;
  capitalization_pct: number | null;
  average_life: number | null;
  guarantor: string | null;

  // Price
  current_price: number | null;

  // Identifiers
  facility_id: string | null;
  figi: string | null;
  native_currency: string | null;

  // Dates
  next_payment_date: string | null;
  call_date: string | null;
  put_date: string | null;
  deal_defaulted_begin: string | null;

  // Servicer
  servicer: string | null;
  servicer_moodys_rating: string | null;
  servicer_sp_rating: string | null;
}

function trimOrNull(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function deriveLienType(
  lienTypeRaw: string | undefined,
  isSecondLien: string | undefined
): string | null {
  const explicit = trimOrNull(lienTypeRaw);
  if (explicit) return explicit;
  const secondLien = parseBoolean(isSecondLien);
  if (secondLien === true) return "Second Lien";
  return null;
}

function deriveMoodysDpRating(
  adjDpRating: string | undefined,
  dpRatingFinal: string | undefined
): string | null {
  // Moodys_DP_Rating_Final overrides Moodys_Adj_DP_Rating_for_WARF
  const final = trimRating(dpRatingFinal);
  if (final) return final;
  return trimRating(adjDpRating);
}

export function parseAssetLevel(
  csvText: string
): SdfParseResult<SdfAssetLevelRow> {
  const { rows: csvRows } = parseCsvLines(csvText);

  const firstRow = csvRows[0];
  const dealName = trimOrNull(firstRow?.Deal_Name);
  const periodBeginDate = parseDate(
    firstRow?.Period_Begin_Date,
    "DD Mon YYYY"
  );
  const asOfDate = parseDate(firstRow?.As_Of_Date, "DD Mon YYYY");

  const rows: SdfAssetLevelRow[] = csvRows.map((raw) => ({
    // Matching keys
    issuer_name: trimOrNull(raw.Issuer_Name),
    security_name: trimOrNull(raw.Security_Name),
    lxid: trimOrNull(raw.LoanX_ID),

    // Issuer-level ratings
    moodys_issuer_rating: trimRating(raw.Issuer_Moodys_Rating),
    moodys_issuer_sr_unsec_rating: trimRating(
      raw.Issuer_Moodys_Sr_Unsec_Rating
    ),
    moodys_rating_final: trimRating(raw.Moodys_Rating_Final),
    sp_issuer_rating: trimRating(raw.Issuer_SP_Rating),
    sp_rating_final: trimRating(raw.SP_Rating_Final),
    fitch_issuer_rating: trimRating(raw.Issuer_Fitch_Rating),
    fitch_rating_final: trimRating(raw.Fitch_Rating_Final),

    // Security-level ratings
    moodys_security_rating: trimRating(raw.Moodys_Security_Rating),
    sp_security_rating: trimRating(raw.SP_Security_Rating),
    fitch_security_rating: trimRating(raw.Fitch_Security_Rating),

    // Derived/adjusted ratings
    moodys_dp_rating: deriveMoodysDpRating(
      raw.Moodys_Adj_DP_Rating_for_WARF,
      raw.Moodys_DP_Rating_Final
    ),
    moodys_rating_unadjusted: trimRating(raw.Moodys_Rating_Unadjusted),

    // Credit watch
    moodys_issuer_watch: trimOrNull(raw.Moodys_Issuer_CreditWatch),
    moodys_security_watch: trimOrNull(raw.Moodys_Security_CreditWatch),
    sp_issuer_watch: trimOrNull(raw.SP_Issuer_CreditWatch),
    sp_security_watch: trimOrNull(raw.SP_Security_CreditWatch),

    // Seniority
    security_level_moodys: trimOrNull(raw.Security_Level_Moody),
    security_level_sp: trimOrNull(raw.Security_Level_SP),
    security_level: trimOrNull(raw.Security_Level),
    lien_type: deriveLienType(raw.Lien_Type, raw.Second_Lien_Loan),
    sp_priority_category: trimOrNull(raw.SP_Priority_Category),

    // Industry codes
    sp_industry_code: trimOrNull(raw.SP_Industry_Code),
    moodys_industry_code: trimOrNull(raw.Moodys_Industry_Code),
    fitch_industry_code: trimOrNull(raw.Fitch_Industry_Code),

    // KBRA
    kbra_industry: trimOrNull(raw.Issuer_Industry_Classification_KBRA),
    kbra_rating: trimRating(raw.Portfolio_Issue_Derived_Rating_KBRA),
    kbra_recovery_rate: parseNumeric(raw.Recovery_Rate_KBRA),

    // Structural — `pik_amount` is the cumulative historical PIK already
    // absorbed into par (denormalized facility-level total per CSV row).
    // Used as the "structurally PIK" signal for the resolver three-tier
    // ladder and as observability; does NOT drive forward engine accretion.
    //
    // `pik_spread_bps` is the LIVE forward PIK rate.
    // SDF column `Current_Facility_Spread_PIK` is a per-annum decimal
    // (e.g. 0.01 = 1.0%); converted to bps to match the existing
    // `spread_bps` shape on the same table. Magnitude validation (>15% =
    // 1500 bps) lives at the resolver boundary, not here — parser stays
    // mechanical per the source-data layer's responsibility.
    //
    // Anti-pattern #5 (boundaries assert sign and scale): the parser
    // multiplies the SDF decimal by 10000 once at this boundary; every
    // downstream consumer reads bps and never the source decimal.
    ...(((): { pik_amount: number | null; is_pik: boolean | null; pik_spread_bps: number | null } => {
      const pikAmount = parseNumeric(raw.PIK_Amount);
      const pikSpreadDecimal = parseNumeric(raw.Current_Facility_Spread_PIK);
      const pikSpreadBps = pikSpreadDecimal != null ? Math.round(pikSpreadDecimal * 10000) : null;
      return {
        pik_amount: pikAmount,
        is_pik: pikAmount != null && pikAmount > 0 ? true : null,
        pik_spread_bps: pikSpreadBps,
      };
    })()),
    credit_spread_adj: parseNumeric(raw.Credit_Spread_Adj),
    is_current_pay: parseBoolean(raw.Is_Current_Pay),
    is_defaulted: parseBoolean(raw.Is_Default),
    is_sovereign: parseBoolean(raw.Sovereign),
    is_enhanced_bond: parseBoolean(raw.Enhanced_Bond),
    is_interest_only: parseBoolean(raw.Interest_Only),
    is_principal_only: parseBoolean(raw.Principal_Only),
    accretion_factor: parseNumeric(raw.Accretion_Factor),
    aggregate_amortized_cost: parseNumeric(raw.Aggregate_Amortized_Cost),
    capitalization_pct: parseNumeric(raw.Capitalization_Percentage),
    average_life: parseNumeric(raw.Average_Life),
    guarantor: trimOrNull(raw.Guarantor),

    // Price — percent-canonical (0..200 with 1% floor). Validator catches
    // fraction-shape regressions and absolute-vs-percent confusions at the
    // parser boundary; resolver/engine consumers trust the percent shape.
    current_price: validateMagnitude("market_value", parsePercentage(raw.Mark_Price)),

    // Identifiers
    facility_id: trimOrNull(raw.Facility_ID),
    figi: trimOrNull(raw.FIGI),
    native_currency: trimOrNull(raw.Currency),

    // Dates
    next_payment_date: parseDate(
      raw.Interest_Next_Payment_Date,
      "DD Mon YYYY"
    ),
    call_date: parseDate(raw.Call_Date, "DD-Mon-YYYY"),
    put_date: parseDate(raw.Put_Date, "DD-Mon-YYYY"),
    deal_defaulted_begin: parseDate(raw.Deal_Defaulted_Begin, "DD-Mon-YYYY"),

    // Servicer
    servicer: trimOrNull(raw.Servicer),
    servicer_moodys_rating: trimRating(raw.Servicer_Moodys_Rating),
    servicer_sp_rating: trimRating(raw.Servicer_SP_Rating),
  }));

  return {
    fileType: "asset_level",
    periodBeginDate,
    asOfDate,
    dealName,
    rows,
    rowCount: rows.length,
  };
}
