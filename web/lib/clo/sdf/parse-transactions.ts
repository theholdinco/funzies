import { parseCsvLines, parseNumeric, parseDate } from "./csv-utils";
import type { SdfParseResult } from "./types";

export interface SdfTransactionRow {
  obligor_name: string | null;
  facility_name: string | null;
  isin: string | null;
  settlement_price: number | null;
  settlement_amount: number | null;
  par_amount: null;
  cash_flow_type: string | null;
  trade_type: string | null;
  trade_date: string | null;
  settlement_date: string | null;
  book_date: string | null;
  transaction_code: string | null;
  description: string | null;
  sale_reason: string | null;
  is_credit_risk_sale: boolean;
  is_credit_improved: boolean;
  is_discretionary: boolean;
  trust_account: string | null;
  native_amount: number | null;
  native_currency: string | null;
  figi: null;
  data_source: string;
}

function deriveTradeType(cashFlowType: string | null, transactionCode: string | null): string | null {
  const cft = cashFlowType?.toLowerCase() ?? "";
  const code = transactionCode?.toUpperCase() ?? "";

  if (cft.includes("purchase") || code === "BUY") return "PURCHASE";
  if (cft.includes("sale") || code === "SELL") return "SALE";
  if (cft.includes("paydown")) return "PAYDOWN";
  if (cft.includes("prepay")) return "PREPAYMENT";
  return null;
}

function parseSaleCode(saleCode: string | null): {
  is_credit_risk_sale: boolean;
  is_credit_improved: boolean;
  is_discretionary: boolean;
} {
  const code = saleCode?.trim() ?? "";
  if (code === "CR" || code === "Credit Risk") return { is_credit_risk_sale: true, is_credit_improved: false, is_discretionary: false };
  if (code === "CI" || code === "Credit Improved") return { is_credit_risk_sale: false, is_credit_improved: true, is_discretionary: false };
  if (code === "D" || code === "Discretionary") return { is_credit_risk_sale: false, is_credit_improved: false, is_discretionary: true };
  return { is_credit_risk_sale: false, is_credit_improved: false, is_discretionary: false };
}

// Spec says "Cash In without security name → skip (STIF adjustment)".
// In practice, STIF rows have empty Issuer_Name but populated Security_Name
// ("Cash Account - Interest Payment Rec"). Checking issuerName is equivalent
// for current SDF data and more reliable.
function isStifAdjustment(cashFlowType: string | null, issuerName: string | null): boolean {
  return cashFlowType?.trim() === "Cash In" && (!issuerName || issuerName.trim() === "");
}

function extractTrustAccount(raw: string | undefined | null): string | null {
  if (!raw || raw.trim() === "") return null;
  // BNY wraps trust account in ="..." formula format
  const match = raw.trim().match(/^="?(.+?)"?$/);
  return match ? match[1] : raw.trim();
}

export function parseTransactions(csvText: string): SdfParseResult<SdfTransactionRow> {
  const { rows: csvRows } = parseCsvLines(csvText);

  const firstRow = csvRows[0];
  const dealName = firstRow?.Deal_Name?.trim() || null;
  const asOfDate = parseDate(firstRow?.As_of_Date, "DD-Mon-YYYY");
  const periodBeginDate = parseDate(firstRow?.Period_Begin_Date, "DD-Mon-YYYY");

  const rows: SdfTransactionRow[] = [];

  for (const raw of csvRows) {
    const cashFlowType = raw.Cash_Flow_Type?.trim() || null;
    const issuerName = raw.Issuer_Name?.trim() || null;

    if (isStifAdjustment(cashFlowType, issuerName)) continue;

    const transactionCode = raw.Transaction_Code?.trim() || null;
    const saleCode = raw.Sale_Code?.trim() || null;
    const { is_credit_risk_sale, is_credit_improved, is_discretionary } = parseSaleCode(saleCode);

    rows.push({
      obligor_name: issuerName,
      facility_name: raw.Security_Name?.trim() || null,
      isin: raw.ISIN?.trim() || null,
      settlement_price: parseNumeric(raw.Price),
      settlement_amount: parseNumeric(raw.Amount),
      par_amount: null,
      cash_flow_type: cashFlowType,
      trade_type: deriveTradeType(cashFlowType, transactionCode),
      trade_date: parseDate(raw.Transaction_Date, "DD-Mon-YYYY"),
      settlement_date: parseDate(raw.Settle_Date, "DD-Mon-YYYY"),
      book_date: parseDate(raw.Book_Date, "DD-Mon-YYYY"),
      transaction_code: transactionCode,
      description: raw.Description?.trim() || null,
      sale_reason: raw.Sale_Reason?.trim() || null,
      is_credit_risk_sale,
      is_credit_improved,
      is_discretionary,
      trust_account: extractTrustAccount(raw.Trust_Account),
      native_amount: parseNumeric(raw.Native_Amount),
      native_currency: raw.Native_CCY?.trim() || null,
      figi: null,
      data_source: "sdf",
    });
  }

  return {
    fileType: "transactions",
    periodBeginDate,
    asOfDate,
    dealName,
    rows,
    rowCount: rows.length,
  };
}
