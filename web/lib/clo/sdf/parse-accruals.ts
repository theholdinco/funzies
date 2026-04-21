import { parseCsvLines, parseNumeric, parseDate } from "./csv-utils";
import type { SdfParseResult } from "./types";

export interface SdfAccrualRow {
  issuer_name: string | null;
  security_name: string | null;
  figi: string | null;
  loanx_id: string | null;
  security_id: string | null;
  accrual_rollup_id: string | null;
  accrual_begin_date: string | null;
  accrual_end_date: string | null;
  day_count: string | null;
  coupon_type: string | null;
  payment_frequency: string | null;
  par_amount: number | null;
  rate_index: string | null;
  has_floor: boolean | null;
  floor_rate: number | null;
  tax_rate: number | null;
  all_in_rate: number | null;
  spread: number | null;
  adjusted_spread: number | null;
  annual_interest: number | null;
}

function parseHasFloor(value: string | undefined | null): boolean | null {
  if (!value || value.trim() === "") return null;
  const v = value.trim().toLowerCase();
  if (v === "yes") return true;
  if (v === "no") return false;
  return null;
}

export function parseAccruals(csvText: string): SdfParseResult<SdfAccrualRow> {
  const { rows: csvRows } = parseCsvLines(csvText);

  const firstRow = csvRows[0];
  const dealName = firstRow?.Deal_Name?.trim() || null;
  const asOfDate = parseDate(firstRow?.As_Of_Date, "DD Mon YYYY");
  const periodBeginDate = parseDate(firstRow?.Period_Begin_Date, "DD Mon YYYY");

  const rows: SdfAccrualRow[] = csvRows.map((raw) => ({
    issuer_name: raw.Issuer_Name?.trim() || null,
    security_name: raw.Security_Name?.trim() || null,
    figi: raw.FIGI?.trim() || null,
    loanx_id: raw.LoanX_ID?.trim() || null,
    security_id: raw.Security_ID?.trim() || null,
    accrual_rollup_id: raw.Accrual_Rollup_ID?.trim() || null,
    accrual_begin_date: parseDate(raw.Accrual_Begin_Date, "DD Mon YYYY"),
    accrual_end_date: parseDate(raw.Accrual_End_Date, "DD Mon YYYY"),
    day_count: raw.Days?.trim() || null,
    coupon_type: raw.Coupon_Type?.trim() || null,
    payment_frequency: raw.Payment_Frequency?.trim() || null,
    par_amount: parseNumeric(raw.Amount),
    rate_index: raw.Rate_Index?.trim() || null,
    has_floor: parseHasFloor(raw.Libor_Base_Floor),
    floor_rate: parseNumeric(raw.Libor_Base_Floor_Rate),
    tax_rate: parseNumeric(raw.Tax_Rate),
    all_in_rate: parseNumeric(raw.All_In_Rate),
    spread: parseNumeric(raw.Spread),
    adjusted_spread: parseNumeric(raw.Adjusted_Spread),
    annual_interest: parseNumeric(raw.Annual_Interest_Adjusted_Spread),
  }));

  return {
    fileType: "accruals",
    periodBeginDate,
    asOfDate,
    dealName,
    rows,
    rowCount: rows.length,
  };
}
