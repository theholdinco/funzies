import {
  parseCsvLines,
  parseNumeric,
  parseDate,
  trimRating,
  spreadToBps,
} from "./csv-utils";
import type { SdfParseResult } from "./types";

export interface SdfNoteRow {
  // Tranche identification
  class_name: string;
  raw_tranche_name: string;

  // Tranche master data
  tranche_type: string | null;
  liab_prin: string | null;
  original_balance: number | null;
  spread_bps: number | null;
  rating_fitch: string | null;
  rating_moodys: string | null;
  rating_sp: string | null;
  reference_rate: string | null;
  payment_frequency: string | null;
  day_count_convention: string | null;
  cusip: string | null;
  isin: string | null;
  currency: string | null;
  legal_maturity_date: string | null;
  amount_native: number | null;
  vendor_custom_fields: Record<string, unknown> | null;

  // Snapshot data
  current_balance: number | null;
  coupon_rate: number | null;
  rating_fitch_issuance: string | null;
  rating_moodys_issuance: string | null;
  rating_sp_issuance: string | null;
  interest_accrued: number | null;
  ic_interest: number | null;
  base_rate: number | null;
  accrual_start_date: string | null;
  accrual_end_date: string | null;
  unscheduled_principal_paydown: number | null;
  data_source: string;
}

function trimOrNull(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeClassName(trancheName: string): string {
  if (trancheName.includes("Subordinated")) return "Subordinated Notes";

  // Strip "Class " prefix, grab the letter+number portion
  const withoutClass = trancheName.replace(/^Class\s+/i, "");

  // Handle "B 1", "B 2" — letter space digit (before the general regex which stops at the space)
  const spaceMatch = withoutClass.match(/^([A-Z])\s+(\d)/i);
  if (spaceMatch) return `Class ${spaceMatch[1]}-${spaceMatch[2]}`;

  const match = withoutClass.match(/^([A-Z][A-Z0-9-]*)/i);
  if (!match) return trancheName;

  let portion = match[1];

  // Normalize "B1" → "B-1"
  portion = portion.replace(/^([A-Z])(\d)$/i, "$1-$2");

  return `Class ${portion}`;
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

function buildVendorCustomFields(
  raw: Record<string, string>
): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};
  const keys = [
    "BNY_LiabOuts_userstring1",
    "LiabOut_UserPercentage1",
    "BNY_LiabOuts_Useramt1",
    "BNY_LiabOuts_Useramt2",
  ];
  for (const key of keys) {
    const val = trimOrNull(raw[key]);
    if (val !== null) fields[key] = val;
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

export function parseNotes(csvText: string): SdfParseResult<SdfNoteRow> {
  const { rows: csvRows } = parseCsvLines(csvText);

  const firstRow = csvRows[0];
  const dealName = trimOrNull(firstRow?.Deal_Name);

  const rows: SdfNoteRow[] = csvRows.map((raw) => {
    const rawTrancheName = raw.Tranche_Name?.trim() ?? "";
    const spreadRaw = parseNumeric(raw.Spread);
    const originalAmount = parseNumeric(raw.Original_Amount);
    const amountNative = parseNumeric(raw.Amount_Native);

    return {
      class_name: normalizeClassName(rawTrancheName),
      raw_tranche_name: rawTrancheName,

      tranche_type: trimOrNull(raw.Tranche_Type),
      liab_prin: trimOrNull(raw.Liab_Prin),
      original_balance: originalAmount ?? amountNative,
      spread_bps: spreadToBps(spreadRaw),
      rating_fitch: trimRating(raw.Fitch_Rating),
      rating_moodys: trimRating(raw.Moodys_Rating),
      rating_sp: trimRating(raw.SP_Rating),
      reference_rate: trimOrNull(raw.Rate_Index),
      payment_frequency: trimOrNull(raw.Payment_Frequency),
      day_count_convention: buildDayCountConvention(
        raw.Tranche_Month_Count,
        raw.Tranche_Year_Count
      ),
      cusip: trimOrNull(raw.CUSIP),
      isin: trimOrNull(raw.ISIN),
      currency: trimOrNull(raw.Currency_Identifier),
      legal_maturity_date:
        parseDate(raw.CRY_Maturity_Date, "DD.MM.YYYY") ??
        parseDate(raw.Maturity_Date, "DD.MM.YYYY"),
      amount_native: amountNative,
      vendor_custom_fields: buildVendorCustomFields(raw),

      current_balance: parseNumeric(raw.Current_Principal),
      coupon_rate: parseNumeric(raw.Coupon),
      rating_fitch_issuance: trimRating(raw.Fitch_Rating_Issuance),
      rating_moodys_issuance: trimRating(raw.Moodys_Rating_Issuance),
      rating_sp_issuance: trimRating(raw.SP_Rating_Issuance),
      interest_accrued: parseNumeric(raw.Interest),
      ic_interest: parseNumeric(raw.IC_Interest),
      base_rate: parseNumeric(raw.Base_Rate),
      accrual_start_date: parseDate(raw.Start_Date, "DD.MM.YYYY"),
      accrual_end_date: parseDate(raw.End_Date, "DD.MM.YYYY"),
      unscheduled_principal_paydown: parseNumeric(
        raw.Unscheduled_Principal_Paydown
      ),
      data_source: "sdf",
    };
  });

  return {
    fileType: "notes",
    periodBeginDate: null,
    asOfDate: null,
    dealName,
    rows,
    rowCount: rows.length,
  };
}
