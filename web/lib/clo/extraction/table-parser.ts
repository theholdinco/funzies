import type { PageTableData, TableData } from "./table-extractor";

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------

export interface TableParseResult<T> {
  data: T | null;
  quality: number;
  recordCount: number;
  nullFieldRatio: number;
  typeErrors: string[];
  notes: string[];
}

export function scoreResult<T extends Record<string, unknown>>(
  records: T[],
  expectedCountRange: [number, number],
  requiredFields: (keyof T)[],
): Omit<TableParseResult<T[]>, "data"> {
  const notes: string[] = [];
  const typeErrors: string[] = [];

  if (records.length === 0) {
    return { quality: 0, recordCount: 0, nullFieldRatio: 1, typeErrors: [], notes: ["no records extracted"] };
  }

  let score = 0;
  score += 0.3;

  const [minCount, maxCount] = expectedCountRange;
  if (records.length >= minCount && records.length <= maxCount) {
    score += 0.2;
  } else {
    notes.push(`record count ${records.length} outside expected range [${minCount}, ${maxCount}]`);
  }

  let totalFields = 0;
  let nullFields = 0;
  for (const record of records) {
    for (const field of requiredFields) {
      totalFields++;
      if (record[field] == null || record[field] === "") nullFields++;
    }
  }
  const nullFieldRatio = totalFields > 0 ? nullFields / totalFields : 1;

  if (nullFieldRatio < 0.3) {
    score += 0.3;
  } else {
    notes.push(`null field ratio ${(nullFieldRatio * 100).toFixed(0)}% exceeds 30% threshold`);
  }

  if (typeErrors.length === 0) {
    score += 0.2;
  }

  return { quality: score, recordCount: records.length, nullFieldRatio, typeErrors, notes };
}

// ---------------------------------------------------------------------------
// Table utilities
// ---------------------------------------------------------------------------

export function tablesForPages(allPages: PageTableData[], startPage: number, endPage: number): { page: number; table: TableData }[] {
  const result: { page: number; table: TableData }[] = [];
  for (const p of allPages) {
    if (p.page >= startPage && p.page <= endPage) {
      for (const table of p.tables) {
        result.push({ page: p.page, table });
      }
    }
  }
  return result;
}

export function textForPages(allPages: PageTableData[], startPage: number, endPage: number): string {
  return allPages
    .filter((p) => p.page >= startPage && p.page <= endPage)
    .map((p) => p.text)
    .join("\n\n");
}

export function parseNumber(cell: string | null | undefined): number | null {
  if (!cell) return null;
  const cleaned = cell.replace(/[,%\s]/g, "").replace(/[()]/g, "");
  if (cleaned === "" || cleaned === "N/A" || cleaned === "-" || cleaned === "n/a") return null;
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
}

export function parsePercent(cell: string | null | undefined): number | null {
  if (!cell) return null;
  const match = cell.match(/([\d.,]+)\s*%/);
  if (match) return parseNumber(match[1]);
  return parseNumber(cell);
}

export function parseDate(cell: string | null | undefined): string | null {
  if (!cell) return null;
  const trimmed = cell.trim();
  if (trimmed === "" || trimmed === "N/A" || trimmed === "-") return null;

  const ddMonYyyy = trimmed.match(/(\d{1,2})-(\w{3})-(\d{4})/);
  if (ddMonYyyy) {
    const months: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    };
    const mon = months[ddMonYyyy[2]];
    if (mon) return `${ddMonYyyy[3]}-${mon}-${ddMonYyyy[1].padStart(2, "0")}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // MM/DD/YYYY or M/D/YYYY (US format, common in BNY Mellon reports)
  const slashMdy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMdy) {
    return `${slashMdy[3]}-${slashMdy[1].padStart(2, "0")}-${slashMdy[2].padStart(2, "0")}`;
  }

  return null;
}

export function isHeaderRow(row: string[]): boolean {
  const headerKeywords = ["test name", "class", "description", "security id", "type", "numerator", "denominator", "isin", "obligor", "original balance", "current balance", "spread", "coupon rate", "par balance", "maturity"];
  const text = row.join(" ").toLowerCase();
  return headerKeywords.some((kw) => text.includes(kw));
}

// ---------------------------------------------------------------------------
// Compliance Summary Parser (pages 2-3)
// ---------------------------------------------------------------------------

export interface ParsedDealDates {
  reportDate: string | null;
  paymentDate: string | null;
  closingDate: string | null;
  effectiveDate: string | null;
  reinvestmentPeriodEnd: string | null;
  statedMaturity: string | null;
}

export interface ParsedComplianceSummary {
  reportDate: string | null;
  paymentDate: string | null;
  dealName: string | null;
  trusteeName: string | null;
  collateralManager: string | null;
  tranches: Array<{
    className: string;
    principalAmount: number | null;
    currentBalance: number | null;
    couponRate: number | null;
    spread: number | null;
    rating: string | null;
    maturityDate: string | null;
  }>;
  totalPar: number | null;
  warf: number | null;
  diversityScore: number | null;
  numberOfAssets: number | null;
  numberOfObligors: number | null;
  walYears: number | null;
  waRecoveryRate: number | null;
  wacSpread: number | null;
  dealDates: ParsedDealDates;
}

function extractDealSummaryDates(text: string): ParsedDealDates {
  const find = (patterns: RegExp[]): string | null => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return parseDate(m[1]);
    }
    return null;
  };

  return {
    reportDate: find([/(?:As of|Report Date)[:\s]+(\d{1,2}-\w{3}-\d{4})/i]),
    paymentDate: find([/(?:Current Payment Date|Next Payment Date|Payment Date)[:\s]+(\d{1,2}-\w{3}-\d{4})/i]),
    closingDate: find([/(?:Closing Date|Original Closing Date)[:\s]+(\d{1,2}-\w{3}-\d{4})/i]),
    effectiveDate: find([/(?:Effective Date)[:\s]+(\d{1,2}-\w{3}-\d{4})/i]),
    reinvestmentPeriodEnd: find([/(?:Reinvestment Period End Date|Reinvestment.*End)[:\s]+(\d{1,2}-\w{3}-\d{4})/i]),
    statedMaturity: find([/(?:Stated Maturity|Legal Final Maturity)[:\s]+(\d{1,2}-\w{3}-\d{4})/i]),
  };
}

function extractPoolMetrics(text: string): Pick<ParsedComplianceSummary, "totalPar" | "warf" | "diversityScore" | "numberOfAssets" | "numberOfObligors" | "walYears" | "waRecoveryRate" | "wacSpread"> {
  const findNum = (patterns: RegExp[]): number | null => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return parseNumber(m[1]);
    }
    return null;
  };

  return {
    totalPar: findNum([/Adjusted.*Collateral.*Principal[:\s]+([\d,]+)/i, /(?:Aggregate.*Principal|Total Par|Collateral Principal)[:\s]+([\d,]+)/i]),
    warf: findNum([/(?:WARF|Weighted Average Rating Factor)[:\s]+([\d,.]+)/i]),
    diversityScore: findNum([/(?:Diversity Score)[:\s]+([\d.]+)/i]),
    numberOfAssets: findNum([/(?:Number of Assets|No\.\s*of\s*Assets)[:\s]+(\d+)/i]),
    numberOfObligors: findNum([/(?:Number of Obligors|No\.\s*of\s*Obligors)[:\s]+(\d+)/i]),
    walYears: findNum([/(?:WAL|Weighted Average Life)[:\s]+([\d.]+)/i]),
    waRecoveryRate: findNum([/(?:WA Recovery Rate|Weighted Average Recovery)[:\s]+([\d.]+)/i]),
    wacSpread: findNum([/(?:WA Spread|Weighted Average Spread)[:\s]+([\d.]+)/i]),
  };
}

/** Detect column mapping from a header row for capital structure tables */
function detectTrancheColumnMap(row: string[]): Record<string, number> | null {
  const map: Record<string, number> = {};
  let foundAny = false;
  for (let i = 0; i < row.length; i++) {
    const cell = (row[i] ?? "").toLowerCase().trim();
    if (/original.*balance|principal.*amount|notional/i.test(cell)) { map.principalAmount = i; foundAny = true; }
    else if (/current.*balance|outstanding/i.test(cell)) { map.currentBalance = i; foundAny = true; }
    else if (/spread.*bps|spread/i.test(cell)) { map.spread = i; foundAny = true; }
    else if (/coupon.*rate|coupon/i.test(cell)) { map.couponRate = i; foundAny = true; }
    else if (/all.in.*rate/i.test(cell)) { map.allInRate = i; foundAny = true; }
    else if (/rating/i.test(cell)) { map.rating = i; foundAny = true; }
    else if (/maturity/i.test(cell)) { map.maturityDate = i; foundAny = true; }
  }
  return foundAny ? map : null;
}

export function parseComplianceSummaryTables(
  allPages: PageTableData[],
  startPage: number,
  endPage: number,
): TableParseResult<ParsedComplianceSummary> {
  const pageTables = tablesForPages(allPages, startPage, endPage);
  const text = textForPages(allPages, startPage, endPage);

  const tranches: ParsedComplianceSummary["tranches"] = [];

  for (const { table } of pageTables) {
    // Try to detect column mapping from header row
    let colMap: Record<string, number> | null = null;
    for (const row of table.rows) {
      const detected = detectTrancheColumnMap(row);
      if (detected && Object.keys(detected).length >= 2) {
        colMap = detected;
        break;
      }
    }

    for (const row of table.rows) {
      if (row.length < 3) continue;
      if (isHeaderRow(row)) continue;
      const firstCell = row[0]?.trim() ?? "";

      if (/^(Class\s|Senior|Subordinated|[A-F][-\d]?\b|Sub\b|Mezz|Equity)/i.test(firstCell)) {
        if (colMap) {
          // Header-aware mapping
          tranches.push({
            className: firstCell,
            principalAmount: colMap.principalAmount != null ? parseNumber(row[colMap.principalAmount]) : null,
            currentBalance: colMap.currentBalance != null ? parseNumber(row[colMap.currentBalance]) : null,
            couponRate: colMap.couponRate != null ? parsePercent(row[colMap.couponRate]) : (colMap.allInRate != null ? parsePercent(row[colMap.allInRate]) : null),
            spread: colMap.spread != null ? parseNumber(row[colMap.spread]) : null,
            rating: colMap.rating != null ? (row[colMap.rating]?.trim() || null) : null,
            maturityDate: colMap.maturityDate != null ? parseDate(row[colMap.maturityDate]) : null,
          });
        } else {
          // Fallback: hardcoded positions
          tranches.push({
            className: firstCell,
            principalAmount: parseNumber(row[1]),
            currentBalance: parseNumber(row[2]),
            couponRate: parsePercent(row[3]),
            spread: parseNumber(row[4]),
            rating: row.length > 6 ? (row[6]?.trim() || null) : null,
            maturityDate: row.length > 13 ? parseDate(row[13]) : null,
          });
        }
      }
    }
  }

  const dealDates = extractDealSummaryDates(text);
  const poolMetrics = extractPoolMetrics(text);

  const reportDateMatch = text.match(/(?:As of|Report Date)[:\s]+(\d{1,2}-\w{3}-\d{4})/i);
  const dealNameMatch = text.match(/Ares European CLO [IVXLCDM]+ DAC/i) ?? text.match(/([A-Z][A-Za-z\s]+ CLO [IVXLCDM]+[A-Za-z\s]*)/);

  const result: ParsedComplianceSummary = {
    reportDate: reportDateMatch ? parseDate(reportDateMatch[1]) : dealDates.reportDate,
    paymentDate: dealDates.paymentDate,
    dealName: dealNameMatch ? dealNameMatch[0].trim() : null,
    trusteeName: null,
    collateralManager: null,
    tranches,
    ...poolMetrics,
    dealDates,
  };

  const scoring = scoreResult(
    tranches as unknown as Record<string, unknown>[],
    [4, 30],
    ["className", "currentBalance"] as never[],
  );

  return { data: result, ...scoring };
}

// ---------------------------------------------------------------------------
// Compliance Test Parser (pages 3-8)
// ---------------------------------------------------------------------------

export interface ParsedComplianceTest {
  testName: string;
  testType: string;
  testClass: string | null;
  numerator: number | null;
  denominator: number | null;
  actualValue: number | null;
  triggerLevel: number | null;
  isPassing: boolean | null;
}

function classifyTestType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("par value") || lower.includes("overcollateral")) return "Par Value";
  if (lower.includes("interest coverage")) return "Interest Coverage";
  if (lower.includes("credit exposure")) return "Credit Exposure";
  if (lower.includes("weighted average")) return "Weighted Average";
  if (lower.includes("concentration") || lower.includes("industry") || lower.includes("country")) return "Concentration";
  return "Other";
}

function extractTestClass(name: string): string | null {
  const m = name.match(/Class(?:es)?\s+([A-F](?:\/[A-F])?(?:-RR)?)/i);
  return m ? m[1].toUpperCase() : null;
}

export function parseComplianceTestTables(
  allPages: PageTableData[],
  startPage: number,
  endPage: number,
): TableParseResult<ParsedComplianceTest[]> {
  const pageTables = tablesForPages(allPages, startPage, endPage);
  const tests: ParsedComplianceTest[] = [];
  const seen = new Set<string>();

  for (const { table } of pageTables) {
    for (const row of table.rows) {
      if (row.length < 8) continue;

      const testName = row[0]?.trim() ?? "";
      if (testName.length < 3) continue;
      if (isHeaderRow(row)) continue;

      const hasNumericData = row.slice(1).some((cell) => parseNumber(cell) !== null);
      if (!hasNumericData) continue;

      const dedupKey = testName.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const resultCell = row[7]?.trim() ?? "";

      tests.push({
        testName,
        testType: classifyTestType(testName),
        testClass: extractTestClass(testName),
        numerator: parseNumber(row[1]),
        denominator: parseNumber(row[2]),
        actualValue: parsePercent(row[4]) ?? parseNumber(row[4]),
        triggerLevel: parsePercent(row[5]) ?? parseNumber(row[5]),
        isPassing: resultCell.toLowerCase().includes("pass") ? true
          : resultCell.toLowerCase().includes("fail") ? false
          : null,
      });
    }
  }

  const scoring = scoreResult(
    tests as unknown as Record<string, unknown>[],
    [5, 150],
    ["testName", "actualValue", "triggerLevel"] as never[],
  );

  return { data: tests, ...scoring };
}

// ---------------------------------------------------------------------------
// Holdings Parser (pages 10-28)
// ---------------------------------------------------------------------------

export interface ParsedHolding {
  obligorName: string;
  securityId: string | null;
  assetType: string | null;
  marketPrice: number | null;
  parBalance: number | null;
  principalBalance: number | null;
  unfundedAmount: number | null;
  securityLevel: string | null;
  maturityDate: string | null;
}

function detectAssetTypeFromText(pageText: string): string | null {
  const lower = pageText.toLowerCase();
  if (lower.includes("asset information i") || lower.includes("term loan")) return "Term Loan";
  if (lower.includes("asset information ii") || lower.includes("bond")) return "Bond";
  if (lower.includes("asset information iii") || lower.includes("equity")) return "Equity";
  return null;
}

/** Detect column mapping from a header row for holdings tables */
function detectHoldingsColumnMap(row: string[]): Record<string, number> | null {
  const map: Record<string, number> = {};
  let foundAny = false;
  for (let i = 0; i < row.length; i++) {
    const cell = (row[i] ?? "").toLowerCase().trim();
    if (/obligor|issuer|borrower|name/i.test(cell) && i === 0) { map.obligor = i; }
    else if (/security.*id|isin|cusip|identifier/i.test(cell)) { map.securityId = i; foundAny = true; }
    else if (/market.*price|price/i.test(cell)) { map.marketPrice = i; foundAny = true; }
    else if (/par.*balance|par.*amount|par\b/i.test(cell)) { map.parBalance = i; foundAny = true; }
    else if (/principal.*balance|principal/i.test(cell)) { map.principalBalance = i; foundAny = true; }
    else if (/unfunded|commitment/i.test(cell)) { map.unfundedAmount = i; foundAny = true; }
    else if (/security.*level|lien|seniority/i.test(cell)) { map.securityLevel = i; foundAny = true; }
    else if (/maturity/i.test(cell)) { map.maturityDate = i; foundAny = true; }
  }
  return foundAny ? map : null;
}

export function parseHoldingsTables(
  allPages: PageTableData[],
  startPage: number,
  endPage: number,
): TableParseResult<ParsedHolding[]> {
  const holdings: ParsedHolding[] = [];
  const seen = new Set<string>();
  let currentAssetType: string | null = "Term Loan";
  let colMap: Record<string, number> | null = null;

  for (const p of allPages) {
    if (p.page < startPage || p.page > endPage) continue;

    const detectedType = detectAssetTypeFromText(p.text);
    if (detectedType) currentAssetType = detectedType;

    for (const table of p.tables) {
      // Try to detect column mapping from header row (first row or any row matching header patterns)
      if (!colMap) {
        for (const row of table.rows) {
          const detected = detectHoldingsColumnMap(row);
          if (detected && Object.keys(detected).length >= 2) {
            colMap = detected;
            break;
          }
        }
      }

      for (const row of table.rows) {
        if (row.length < 5) continue;

        const obligor = row[colMap?.obligor ?? 0]?.trim() ?? "";
        if (obligor.length < 3) continue;
        if (isHeaderRow(row)) continue;
        if (/^(total|sub-?total|grand total)/i.test(obligor)) continue;

        const secIdIdx = colMap?.securityId ?? 1;
        const secId = row[secIdIdx]?.trim() ?? "";
        const dedupKey = `${obligor.toLowerCase()}|${secId.toLowerCase()}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        if (colMap) {
          // Header-aware mapping
          holdings.push({
            obligorName: obligor,
            securityId: secId || null,
            assetType: currentAssetType,
            marketPrice: colMap.marketPrice != null ? parseNumber(row[colMap.marketPrice]) : null,
            parBalance: colMap.parBalance != null ? parseNumber(row[colMap.parBalance]) : null,
            principalBalance: colMap.principalBalance != null ? parseNumber(row[colMap.principalBalance]) : null,
            unfundedAmount: colMap.unfundedAmount != null ? parseNumber(row[colMap.unfundedAmount]) : null,
            securityLevel: colMap.securityLevel != null ? (row[colMap.securityLevel]?.trim() || null) : null,
            maturityDate: colMap.maturityDate != null ? parseDate(row[colMap.maturityDate]) : null,
          });
        } else {
          // Fallback: hardcoded positions
          holdings.push({
            obligorName: obligor,
            securityId: secId || null,
            assetType: currentAssetType,
            marketPrice: parseNumber(row[3]),
            parBalance: parseNumber(row[4]),
            principalBalance: parseNumber(row[5]),
            unfundedAmount: parseNumber(row[6]),
            securityLevel: row[7]?.trim() || null,
            maturityDate: parseDate(row[8]),
          });
        }
      }
    }
  }

  const scoring = scoreResult(
    holdings as unknown as Record<string, unknown>[],
    [50, 500],
    ["obligorName", "parBalance", "maturityDate"] as never[],
  );

  return { data: holdings, ...scoring };
}

// ---------------------------------------------------------------------------
// Concentration Parser (derived from compliance tests)
// ---------------------------------------------------------------------------

export interface ParsedConcentration {
  concentrationType: string;
  bucketName: string;
  actualValue: number | null;
  actualPct: number | null;
  limitValue: number | null;
  limitPct: number | null;
  isPassing: boolean | null;
}

const CONCENTRATION_KEYWORDS = ["credit exposure", "concentration", "industry", "country", "rating", "obligor", "single", "domiciled"];

export function parseConcentrationFromTests(tests: ParsedComplianceTest[]): TableParseResult<ParsedConcentration[]> {
  const concentrations: ParsedConcentration[] = [];

  for (const test of tests) {
    const lower = test.testName.toLowerCase();
    if (!CONCENTRATION_KEYWORDS.some((kw) => lower.includes(kw))) continue;

    concentrations.push({
      concentrationType: test.testType === "Credit Exposure" ? "SINGLE_OBLIGOR"
        : lower.includes("industry") ? "INDUSTRY"
        : lower.includes("country") ? "COUNTRY"
        : lower.includes("rating") ? "RATING"
        : "OTHER",
      bucketName: test.testName,
      actualValue: test.numerator ?? test.actualValue,
      actualPct: test.actualValue,
      limitValue: test.denominator ?? test.triggerLevel,
      limitPct: test.triggerLevel,
      isPassing: test.isPassing,
    });
  }

  const scoring = scoreResult(
    concentrations as unknown as Record<string, unknown>[],
    [5, 100],
    ["bucketName", "actualValue"] as never[],
  );

  return { data: concentrations, ...scoring };
}
