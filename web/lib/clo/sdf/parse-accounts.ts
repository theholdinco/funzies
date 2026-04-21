import { parseCsvLines, parseNumeric, parseDate } from "./csv-utils";
import type { SdfParseResult } from "./types";

export interface SdfAccountRow {
  account_name: string;
  account_type: string;
  balance_amount: number | null;
  account_interest: number | null;
  data_source: string;
}

function deriveAccountType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("interest")) return "INTEREST";
  if (lower.includes("princip")) return "PRINCIPAL";
  if (lower.includes("currency")) return "CURRENCY";
  if (lower.includes("exp res") || lower.includes("reserve")) return "RESERVE";
  if (lower.includes("payment")) return "PAYMENT";
  if (lower.includes("hedge")) return "HEDGE";
  if (lower.includes("custody")) return "CUSTODY";
  return "OTHER";
}

export function parseAccounts(csvText: string): SdfParseResult<SdfAccountRow> {
  const { rows: csvRows } = parseCsvLines(csvText);

  const firstRow = csvRows[0];
  const dealName = firstRow?.Deal_Name?.trim() || null;
  const asOfDate = parseDate(firstRow?.As_Of_Date, "DD-Mon-YYYY");
  const periodBeginDate = parseDate(firstRow?.Period_Begin_Date, "DD-Mon-YYYY");

  const rows: SdfAccountRow[] = csvRows.map((raw) => {
    const accountName = raw.Account_Name?.trim() ?? "";
    return {
      account_name: accountName,
      account_type: deriveAccountType(accountName),
      balance_amount: parseNumeric(raw.Account_Principal_Balance),
      account_interest: parseNumeric(raw.Account_Interest),
      data_source: "sdf",
    };
  });

  return {
    fileType: "accounts",
    periodBeginDate,
    asOfDate,
    dealName,
    rows,
    rowCount: rows.length,
  };
}
