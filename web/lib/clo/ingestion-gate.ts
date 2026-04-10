import type { ExtractedConstraints } from "./types";
import type { ValidationError, Fix } from "./resolver-types";

export function parseSpreadToBps(spreadBps: number | undefined | null, spreadStr: string | undefined | null): number | null {
  if (spreadBps != null && spreadBps > 0) return spreadBps;
  if (!spreadStr) return null;

  const pctMatch = spreadStr.match(/([\d.]+)\s*%/);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    if (pct > 0) return Math.round(pct * 100);
  }

  const bpsMatch = spreadStr.match(/([\d.]+)\s*bps/i);
  if (bpsMatch) return Math.round(parseFloat(bpsMatch[1]));

  // Plain number: >= 10 is bps (e.g. "150"), < 10 is likely percentage (e.g. "1.47" = 147bps)
  const plain = parseFloat(spreadStr);
  if (!isNaN(plain) && plain > 0) {
    return plain >= 10 ? Math.round(plain) : Math.round(plain * 100);
  }

  return null;
}

function normalizeTestType(testType: string | null, testName: string | null): string | null {
  if (testType === "OC_PAR" || testType === "OC_MV" || testType === "IC") return testType;
  const name = (testName ?? "").toLowerCase();
  if (name.includes("par value") || name.includes("overcollateral") || (name.includes("oc") && name.includes("ratio"))) return "OC_PAR";
  if (name.includes("interest coverage") || (name.includes("ic") && name.includes("ratio"))) return "IC";
  if (testType && testType.toLowerCase().includes("oc")) return "OC_PAR";
  if (testType && testType.toLowerCase().includes("ic")) return "IC";
  return testType;
}

function fixStringNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result = { ...obj };
  for (const [key, value] of Object.entries(result)) {
    if (value === "null" || value === "NULL" || value === "undefined") {
      result[key] = null;
    }
  }
  return result;
}

export function validateAndNormalizeConstraints(
  raw: ExtractedConstraints
): { ok: true; data: ExtractedConstraints; fixes: Fix[] } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const fixes: Fix[] = [];
  const data = structuredClone(raw);

  if (data.keyDates) {
    const fixed = fixStringNulls(data.keyDates as unknown as Record<string, unknown>);
    data.keyDates = fixed as typeof data.keyDates;
  }

  const capStruct = data.capitalStructure ?? [];
  if (capStruct.length === 0) {
    errors.push({ field: "capitalStructure", message: "Capital structure has zero tranches" });
  }

  for (const entry of capStruct) {
    const isSubordinated = entry.isSubordinated ?? entry.class.toLowerCase().includes("sub");
    if (isSubordinated) continue;

    const resolved = parseSpreadToBps(entry.spreadBps, entry.spread);
    if (resolved == null) {
      errors.push({
        field: `${entry.class}.spreadBps`,
        message: `No spread found for ${entry.class} — neither spreadBps (${entry.spreadBps}) nor spread string ("${entry.spread}") could be parsed`,
      });
    } else if (resolved !== entry.spreadBps) {
      fixes.push({
        field: `${entry.class}.spreadBps`,
        message: `Resolved spreadBps from spread string "${entry.spread}"`,
        before: entry.spreadBps,
        after: resolved,
      });
      entry.spreadBps = resolved;
    }
  }

  const maturity = data.keyDates?.maturityDate;
  if (!maturity) {
    const trancheMaturity = capStruct.find(e => e.maturityDate)?.maturityDate;
    if (!trancheMaturity) {
      errors.push({ field: "keyDates.maturityDate", message: "No maturity date found in key dates or tranche entries" });
    }
  }

  for (const entry of data.coverageTestEntries ?? []) {
    if (entry.parValueRatio == null && entry.interestCoverageRatio == null) {
      errors.push({
        field: `coverageTest.${entry.class}`,
        message: `Coverage test for ${entry.class} has no trigger level`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data, fixes };
}

export function normalizeComplianceTestType(
  tests: Array<{ testType: string | null; testName: string; isPassing: boolean | null; actualValue: number | null; triggerLevel: number | null }>
): { tests: typeof tests; fixes: Fix[] } {
  const fixes: Fix[] = [];
  for (const test of tests) {
    const normalized = normalizeTestType(test.testType, test.testName);
    if (normalized !== test.testType) {
      fixes.push({
        field: `complianceTest.${test.testName}.testType`,
        message: `Normalized testType from "${test.testType}" to "${normalized}"`,
        before: test.testType,
        after: normalized,
      });
      test.testType = normalized;
    }

    if (test.isPassing == null && test.actualValue != null && test.triggerLevel != null) {
      const passing = test.actualValue >= test.triggerLevel;
      fixes.push({
        field: `complianceTest.${test.testName}.isPassing`,
        message: `Computed isPassing=${passing} from actual ${test.actualValue} vs trigger ${test.triggerLevel}`,
        before: null,
        after: passing,
      });
      test.isPassing = passing;
    }
  }
  return { tests, fixes };
}

export function normalizeWacSpread(value: number | null): { bps: number; fix: Fix | null } {
  if (value == null) return { bps: 0, fix: null };
  if (value < 20) {
    const bps = Math.round(value * 100);
    return {
      bps,
      fix: {
        field: "poolSummary.wacSpread",
        message: `Interpreted wacSpread ${value} as percentage → ${bps} bps${value >= 10 ? ' (ambiguous — could be bps)' : ''}`,
        before: value,
        after: bps,
      },
    };
  }
  return { bps: Math.round(value), fix: null };
}
