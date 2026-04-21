import {
  parseCsvLines,
  parseNumeric,
  parseBoolean,
  parseDate,
  trimRating,
  spreadToBps,
} from "./csv-utils";
import type { SdfParseResult } from "./types";

export interface SdfCollateralRow {
  obligor_name: string | null;
  facility_name: string | null;
  par_balance: number | null;
  principal_balance: number | null;
  unfunded_commitment: number | null;
  native_currency_balance: number | null;
  native_currency: string | null;
  currency: string | null;
  gross_purchase_price: number | null;
  purchase_price: number | null;
  premium_discount_amount: number | null;
  discount_amount: number | null;
  premium_amount: number | null;
  asset_type: string | null;
  country: string | null;
  country_code: string | null;
  is_fixed_rate: boolean | null;
  all_in_rate: number | null;
  reference_rate: string | null;
  index_rate: number | null;
  floor_rate: number | null;
  spread_bps: number | null;
  day_count_convention: string | null;
  accrual_begin_date: string | null;
  accrual_end_date: string | null;
  payment_period: string | null;
  sp_industry: string | null;
  moodys_industry: string | null;
  industry_description: string | null;
  moodys_rating: string | null;
  sp_rating: string | null;
  fitch_rating: string | null;
  recovery_rate_moodys: number | null;
  recovery_rate_sp: number | null;
  recovery_rate_fitch: number | null;
  issue_date: string | null;
  maturity_date: string | null;
  default_date: string | null;
  default_reason: string | null;
  is_defaulted: boolean;
  next_payment_date: string | null;
  affiliate_id: string | null;
  lxid: string | null;
  is_cov_lite: boolean | null;
  security_level: string | null;
  lien_type: string | null;
  market_value: number | null;
  current_price: number | null;
  cusip: string | null;
  isin: string | null;
  facility_code: string | null;
  data_source: string;
}

function trimOrNull(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function computeUnfundedCommitment(
  commitment: number | null,
  fundedBalance: number | null
): number | null {
  if (commitment === null || fundedBalance === null) return null;
  return commitment - fundedBalance;
}

function parseCouponType(value: string | null | undefined): boolean | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "fixed") return true;
  if (v === "floating") return false;
  return null;
}

function buildDayCountConvention(
  monthCount: string | undefined,
  yearCount: string | undefined
): string | null {
  const mc = trimOrNull(monthCount);
  const yc = trimOrNull(yearCount);
  if (mc === null && yc === null) return null;
  return `${mc ?? ""}/${yc ?? ""}`;
}

function deriveSecurityLevel(
  securityLevel: string | undefined,
  isMezzanine: string | undefined
): string | null {
  const level = trimOrNull(securityLevel);
  if (level !== null) return level;
  const mezz = parseBoolean(isMezzanine);
  if (mezz === true) return "Mezzanine";
  return null;
}

function deriveLienType(isSecondLien: string | undefined): string | null {
  const val = parseBoolean(isSecondLien);
  if (val === true) return "Second Lien";
  return null;
}

export function parseCollateralFile(
  csvText: string
): SdfParseResult<SdfCollateralRow> {
  const { rows: csvRows } = parseCsvLines(csvText);

  const firstRow = csvRows[0];
  const dealName = trimOrNull(firstRow?.Deal_Name);

  const rows: SdfCollateralRow[] = csvRows.map((raw) => {
    const parBalance = parseNumeric(raw.Principal_Funded_Balance);
    const commitment = parseNumeric(raw.Commitment);
    const grossPurchasePrice = parseNumeric(raw.Gross_Purchase_Price);
    const marketValue = parseNumeric(raw.Market_Value);
    const defaultDate = parseDate(raw.Default_Date, "DD.MM.YYYY");
    const nativeCurrency = trimOrNull(raw.Native_Currency);
    const spreadRaw = parseNumeric(raw.Current_Spread);

    return {
      obligor_name: trimOrNull(raw.Issuer_Name),
      facility_name: trimOrNull(raw.Security_Name),
      par_balance: parBalance,
      principal_balance: parseNumeric(raw.Principal_Balance),
      unfunded_commitment: computeUnfundedCommitment(commitment, parBalance),
      native_currency_balance: parseNumeric(
        raw.Native_Principal_Funded_Balance
      ),
      native_currency: nativeCurrency,
      currency: nativeCurrency,
      gross_purchase_price: grossPurchasePrice,
      purchase_price: grossPurchasePrice,
      premium_discount_amount: parseNumeric(raw.Premium_Discount),
      discount_amount: parseNumeric(raw.Discount),
      premium_amount: parseNumeric(raw.Premium),
      asset_type: trimOrNull(raw.Security_Type1),
      country: trimOrNull(raw.Country_Name),
      country_code: trimOrNull(raw.Country_Code),
      is_fixed_rate: parseCouponType(raw.Coupon_Type),
      all_in_rate: parseNumeric(raw.All_In_Rate),
      reference_rate: trimOrNull(raw.Index_Type),
      index_rate: parseNumeric(raw.Index),
      floor_rate: parseNumeric(raw.Index_Floor_Rate),
      spread_bps: spreadToBps(spreadRaw),
      day_count_convention: buildDayCountConvention(
        raw.Month_Count,
        raw.Year_Count
      ),
      accrual_begin_date: parseDate(
        raw.Current_Interest_Accrual_Begin_Date,
        "DD.MM.YYYY"
      ),
      accrual_end_date: parseDate(
        raw.Current_Interest_Accrual_End_Date,
        "DD.MM.YYYY"
      ),
      payment_period: trimOrNull(raw.Payment_Period),
      sp_industry: trimOrNull(
        raw["Issuer_Industry_Classification___S_P"]
      ),
      moodys_industry: trimOrNull(raw.Moodys_Industry_Name),
      industry_description: trimOrNull(raw.Fitch_Industry_Name),
      moodys_rating: trimRating(raw.Moodys_Rating),
      sp_rating: trimRating(raw.SP_Rating),
      fitch_rating: trimRating(raw.Fitch_Rating),
      recovery_rate_moodys: parseNumeric(raw.Moodys_Recovery_Rate),
      recovery_rate_sp: parseNumeric(raw.SP_Recovery_Rate),
      recovery_rate_fitch: parseNumeric(raw.Fitch_Recovery_Rate),
      issue_date: parseDate(raw.Issue_Date, "DD.MM.YYYY"),
      maturity_date: parseDate(raw.Maturity_Date, "DD.MM.YYYY"),
      default_date: defaultDate,
      default_reason: trimOrNull(raw.Reason_for_Default),
      is_defaulted: defaultDate !== null,
      next_payment_date: parseDate(raw.Next_Payment_Date, "DD.MM.YYYY"),
      affiliate_id: trimOrNull(raw.AffiliateID),
      lxid: trimOrNull(raw.LoanX_ID),
      is_cov_lite: parseBoolean(raw.Cov_Lite),
      security_level: deriveSecurityLevel(raw.Security_Level, raw.Is_Mezzanine),
      lien_type: deriveLienType(raw.Is_Second_Lein),
      market_value: marketValue,
      current_price: marketValue,
      cusip: trimOrNull(raw.CUSIP),
      isin: trimOrNull(raw.ISIN),
      facility_code: trimOrNull(raw.Security_Facility_Code),
      data_source: "sdf",
    };
  });

  return {
    fileType: "collateral_file",
    periodBeginDate: null,
    asOfDate: null,
    dealName,
    rows,
    rowCount: rows.length,
  };
}
