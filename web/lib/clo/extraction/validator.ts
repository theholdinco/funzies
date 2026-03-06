import type { Pass1Output, Pass2Output, Pass3Output, Pass4Output } from "./schemas";
import type { CapitalStructureEntry } from "../types";

export interface ValidationCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  expected: number | null;
  actual: number | null;
  discrepancy: number | null;
  message: string;
}

export interface ValidationResult {
  checks: ValidationCheck[];
  score: number;
  totalChecks: number;
  checksRun: number;
  checksSkipped: number;
}

const CCC_RATINGS = new Set([
  // Moody's: Caa and below
  "caa1", "caa2", "caa3", "caa", "ca",
  // S&P: CCC and below
  "ccc+", "ccc", "ccc-", "cc", "sd",
  // Fitch: CCC and below
  "rd",
  // Shared across agencies
  "c", "d",
]);

function isCccOrBelow(rating: string | null | undefined): boolean {
  if (!rating) return false;
  return CCC_RATINGS.has(rating.toLowerCase().trim());
}

function pctDiff(expected: number, actual: number): number {
  if (expected === 0) return actual === 0 ? 0 : 100;
  return Math.abs((actual - expected) / expected) * 100;
}

function absDiff(expected: number, actual: number): number {
  return Math.abs(actual - expected);
}

function check(
  name: string,
  expected: number | null | undefined,
  actual: number | null | undefined,
  tolerance: number,
  unit: "pct" | "abs",
  description: string,
): ValidationCheck | null {
  if (expected == null || actual == null) return null;

  const diff = unit === "pct" ? pctDiff(expected, actual) : absDiff(expected, actual);
  const withinTolerance = diff <= tolerance;
  const status = withinTolerance ? "pass" : diff <= tolerance * 2 ? "warn" : "fail";

  const discrepancy = Math.round(diff * 100) / 100;

  const msg = withinTolerance
    ? `${description}: matches within ${discrepancy}${unit === "pct" ? "%" : ""}`
    : `${description}: expected ${expected}, got ${actual} (off by ${discrepancy}${unit === "pct" ? "%" : ""})`;

  return { name, status, expected, actual, discrepancy, message: msg };
}

export function validateExtraction(
  pass1: Pass1Output | null,
  pass2: Pass2Output | null,
  pass3: Pass3Output | null,
): ValidationResult {
  const checks: ValidationCheck[] = [];
  let skipped = 0;

  const pool = pass1?.poolSummary;
  const holdings = pass2?.holdings;
  const tests = pass1?.complianceTests;
  const concentrations = pass3?.concentrations;

  // ─── Pool-Level Checks (Pass 1 vs Pass 2) ───

  if (pool && holdings && holdings.length > 0) {
    const holdingsWithPar = holdings.filter((h) => h.parBalance != null);
    const totalHoldingsPar = holdingsWithPar.reduce((sum, h) => sum + (h.parBalance ?? 0), 0);

    const c1 = check("total_par_match", pool.totalPar, totalHoldingsPar, 2, "pct", "Total par");
    if (c1) checks.push(c1); else skipped++;

    const uniqueObligors = new Set(holdings.map((h) => h.obligorName?.toLowerCase().trim()).filter(Boolean)).size;
    const c2 = check("obligor_count", pool.numberOfObligors, uniqueObligors, 2, "abs", "Obligor count");
    if (c2) checks.push(c2); else skipped++;

    const c3 = check("asset_count", pool.numberOfAssets, holdings.length, 1, "abs", "Asset count");
    if (c3) checks.push(c3); else skipped++;

    if (pool.wacSpread != null) {
      const holdingsWithSpread = holdingsWithPar.filter((h) => h.spreadBps != null);
      if (holdingsWithSpread.length > 0) {
        const totalParForSpread = holdingsWithSpread.reduce((sum, h) => sum + (h.parBalance ?? 0), 0);
        const waSpread = totalParForSpread > 0
          ? holdingsWithSpread.reduce((sum, h) => sum + (h.spreadBps ?? 0) * (h.parBalance ?? 0), 0) / totalParForSpread
          : 0;
        // Normalize units: if summary WA spread looks like percentage (<20) but calculated is bps (>100), convert
        const wacSpreadBps = pool.wacSpread < 20 && waSpread > 100 ? pool.wacSpread * 100 : pool.wacSpread;
        const c4 = check("wa_spread", wacSpreadBps, waSpread, 10, "abs", "WA spread (bps)");
        if (c4) checks.push(c4); else skipped++;
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }

    if (pool.pctFixedRate != null && totalHoldingsPar > 0) {
      const fixedPar = holdings.filter((h) => h.isFixedRate === true).reduce((sum, h) => sum + (h.parBalance ?? 0), 0);
      const calcFixedPct = (fixedPar / totalHoldingsPar) * 100;
      const c5 = check("fixed_rate_pct", pool.pctFixedRate, calcFixedPct, 1, "abs", "Fixed rate %");
      if (c5) checks.push(c5); else skipped++;
    } else {
      skipped++;
    }

    if (pool.pctCccAndBelow != null && totalHoldingsPar > 0) {
      const cccPar = holdings
        .filter((h) => isCccOrBelow(h.moodysRating) || isCccOrBelow(h.spRating) || isCccOrBelow(h.compositeRating))
        .reduce((sum, h) => sum + (h.parBalance ?? 0), 0);
      const calcCccPct = (cccPar / totalHoldingsPar) * 100;
      const c6 = check("ccc_pct", pool.pctCccAndBelow, calcCccPct, 1, "abs", "CCC & below %");
      if (c6) checks.push(c6); else skipped++;
    } else {
      skipped++;
    }

    if (pool.pctDefaulted != null && totalHoldingsPar > 0) {
      const defaultedPar = holdings.filter((h) => h.isDefaulted === true).reduce((sum, h) => sum + (h.parBalance ?? 0), 0);
      const calcDefaultedPct = (defaultedPar / totalHoldingsPar) * 100;
      const c7 = check("defaulted_pct", pool.pctDefaulted, calcDefaultedPct, 0.5, "abs", "Defaulted %");
      if (c7) checks.push(c7); else skipped++;
    } else {
      skipped++;
    }
  } else {
    skipped += 7;
  }

  // ─── Compliance Test Consistency (Pass 1 vs Pass 3) ───

  if (concentrations && concentrations.length > 0 && tests && tests.length > 0) {
    const industryBuckets = concentrations.filter((c) => c.concentrationType === "INDUSTRY");
    const maxIndustryPct = industryBuckets.reduce((max, c) => Math.max(max, c.actualPct ?? 0), 0);
    const industryTests = tests.filter((t) =>
      t.testType === "CONCENTRATION" && t.testName?.toLowerCase().includes("industry")
    );
    if (maxIndustryPct > 0 && industryTests.length > 0) {
      const industryLimit = industryTests[0].triggerLevel ?? industryTests[0].thresholdLevel;
      if (industryLimit != null) {
        const status = maxIndustryPct <= industryLimit ? "pass" : "fail";
        checks.push({
          name: "industry_concentration",
          status,
          expected: industryLimit,
          actual: maxIndustryPct,
          discrepancy: Math.round((maxIndustryPct - industryLimit) * 100) / 100,
          message: status === "pass"
            ? `Largest industry bucket (${maxIndustryPct.toFixed(1)}%) within limit (${industryLimit}%)`
            : `Largest industry bucket (${maxIndustryPct.toFixed(1)}%) exceeds limit (${industryLimit}%)`,
        });
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }

    const obligorBuckets = concentrations.filter((c) => c.concentrationType === "SINGLE_OBLIGOR");
    const maxObligorPct = obligorBuckets.reduce((max, c) => Math.max(max, c.actualPct ?? 0), 0);
    const obligorTests = tests.filter((t) =>
      t.testType === "CONCENTRATION" && (t.testName?.toLowerCase().includes("obligor") || t.testName?.toLowerCase().includes("single"))
    );
    if (maxObligorPct > 0 && obligorTests.length > 0) {
      const obligorLimit = obligorTests[0].triggerLevel ?? obligorTests[0].thresholdLevel;
      if (obligorLimit != null) {
        const status = maxObligorPct <= obligorLimit ? "pass" : "fail";
        checks.push({
          name: "single_obligor_concentration",
          status,
          expected: obligorLimit,
          actual: maxObligorPct,
          discrepancy: Math.round((maxObligorPct - obligorLimit) * 100) / 100,
          message: status === "pass"
            ? `Largest obligor exposure (${maxObligorPct.toFixed(1)}%) within limit (${obligorLimit}%)`
            : `Largest obligor exposure (${maxObligorPct.toFixed(1)}%) exceeds limit (${obligorLimit}%)`,
        });
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  } else {
    skipped += 2;
  }

  // ─── Internal Consistency (within Pass 1) ───

  if (tests && tests.length > 0) {
    let ocCheckRan = false;
    let cushionCheckRan = false;
    let ocFailures = 0;
    let ocTotal = 0;
    let cushionFailures = 0;
    let cushionTotal = 0;

    for (const t of tests) {
      if (t.numerator != null && t.denominator != null && t.denominator !== 0 && t.actualValue != null) {
        ocCheckRan = true;
        ocTotal++;
        const calculated = (t.numerator / t.denominator) * 100;
        if (absDiff(calculated, t.actualValue) > 0.1) {
          ocFailures++;
        }
      }

      if (t.actualValue != null && t.triggerLevel != null && t.cushionPct != null) {
        cushionCheckRan = true;
        cushionTotal++;
        const calculated = t.actualValue - t.triggerLevel;
        if (absDiff(calculated, t.cushionPct) > 0.1) {
          cushionFailures++;
        }
      }
    }

    if (ocCheckRan) {
      const status = ocFailures === 0 ? "pass" : ocFailures <= 1 ? "warn" : "fail";
      checks.push({
        name: "oc_test_math",
        status,
        expected: 0,
        actual: ocFailures,
        discrepancy: ocFailures,
        message: ocFailures === 0
          ? `OC test math consistent across ${ocTotal} tests`
          : `${ocFailures}/${ocTotal} OC tests have numerator/denominator ≠ actualValue`,
      });
    } else {
      skipped++;
    }

    if (cushionCheckRan) {
      const status = cushionFailures === 0 ? "pass" : cushionFailures <= 1 ? "warn" : "fail";
      checks.push({
        name: "cushion_math",
        status,
        expected: 0,
        actual: cushionFailures,
        discrepancy: cushionFailures,
        message: cushionFailures === 0
          ? `Cushion math consistent across ${cushionTotal} tests`
          : `${cushionFailures}/${cushionTotal} tests have actualValue - triggerLevel ≠ cushionPct`,
      });
    } else {
      skipped++;
    }
  } else {
    skipped += 2;
  }

  const passed = checks.filter((c) => c.status === "pass").length;

  return {
    checks,
    score: passed,
    totalChecks: 11,
    checksRun: checks.length,
    checksSkipped: skipped,
  };
}

// ─── Cap Structure Cross-Validation (PPM vs Compliance Report) ───

/** Normalize class name for matching: "Class A-1" → "A1", "Sub Notes" → "SUBNOTES" */
const TRANCHE_NAME_ALIASES: Record<string, string> = {
  SUB: "SUBORDINATED",
  SUBORD: "SUBORDINATED",
  SUBORDINATEDNOTES: "SUBORDINATED",
  SUBNOTES: "SUBORDINATED",
  EQ: "EQUITY",
  EQUITYNOTES: "EQUITY",
  MEZZ: "MEZZANINE",
  INCOMENOTES: "INCOMENOTE",
  INCOME: "INCOMENOTE",
  RESIDUAL: "INCOMENOTE",
};

function normalizeCapClassName(name: string): string {
  const stripped = name
    .replace(/^class(es)?\s+/i, "")
    .replace(/[\s\-\/]+/g, "")
    .toUpperCase();
  return TRANCHE_NAME_ALIASES[stripped] ?? stripped;
}

/** Parse a principal amount string like "€150,000,000" or "150000000" to a number */
function parsePrincipalAmount(amount: string): number | null {
  const cleaned = amount.replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

export function validateCapStructure(
  ppmCapStructure: CapitalStructureEntry[] | undefined,
  trancheSnapshots: Pass4Output["trancheSnapshots"] | undefined,
): ValidationCheck[] {
  if (!ppmCapStructure || ppmCapStructure.length === 0 || !trancheSnapshots || trancheSnapshots.length === 0) {
    return [];
  }

  const checks: ValidationCheck[] = [];

  // Build lookup maps by normalized class name
  const ppmByClass = new Map<string, CapitalStructureEntry>();
  for (const entry of ppmCapStructure) {
    ppmByClass.set(normalizeCapClassName(entry.class), entry);
  }

  const reportByClass = new Map<string, Pass4Output["trancheSnapshots"][number]>();
  for (const snap of trancheSnapshots) {
    reportByClass.set(normalizeCapClassName(snap.className), snap);
  }

  // 1. Check tranche count mismatch
  // Filter out equity/sub notes from PPM count since compliance reports sometimes omit them
  const ppmRatedTranches = ppmCapStructure.filter((e) => {
    const norm = normalizeCapClassName(e.class);
    return !norm.includes("SUB") && !norm.includes("EQUITY") && !norm.includes("INCOME");
  });
  const reportTranches = trancheSnapshots.filter((s) => {
    const norm = normalizeCapClassName(s.className);
    return !norm.includes("SUB") && !norm.includes("EQUITY") && !norm.includes("INCOME");
  });

  if (ppmRatedTranches.length !== reportTranches.length) {
    checks.push({
      name: "cap_structure_tranche_count",
      status: "warn",
      expected: ppmRatedTranches.length,
      actual: reportTranches.length,
      discrepancy: Math.abs(ppmRatedTranches.length - reportTranches.length),
      message: `Cap structure mismatch: PPM has ${ppmRatedTranches.length} rated tranches but compliance report has ${reportTranches.length}. This may indicate a tranche reset or restructuring — verify which is current.`,
    });
  }

  // 2. Check for tranches in report but not in PPM (new tranches after reset)
  const reportOnlyClasses: string[] = [];
  for (const [normName, snap] of reportByClass) {
    if (!ppmByClass.has(normName)) {
      reportOnlyClasses.push(snap.className);
    }
  }
  if (reportOnlyClasses.length > 0) {
    checks.push({
      name: "cap_structure_new_tranches",
      status: "warn",
      expected: 0,
      actual: reportOnlyClasses.length,
      discrepancy: reportOnlyClasses.length,
      message: `Compliance report contains tranches not found in PPM: ${reportOnlyClasses.join(", ")}. The PPM may be outdated (e.g., post-reset/refinancing). The compliance report likely reflects the current structure.`,
    });
  }

  // 3. Check for tranches in PPM but not in report (retired tranches)
  const ppmOnlyClasses: string[] = [];
  for (const [normName, entry] of ppmByClass) {
    if (!reportByClass.has(normName)) {
      ppmOnlyClasses.push(entry.class);
    }
  }
  if (ppmOnlyClasses.length > 0) {
    checks.push({
      name: "cap_structure_missing_tranches",
      status: "warn",
      expected: ppmOnlyClasses.length,
      actual: 0,
      discrepancy: ppmOnlyClasses.length,
      message: `PPM tranches not found in compliance report: ${ppmOnlyClasses.join(", ")}. These may have been retired, paid down, or renamed in a reset.`,
    });
  }

  // 4. For matched tranches, compare principal amounts
  for (const [normName, ppmEntry] of ppmByClass) {
    const reportSnap = reportByClass.get(normName);
    if (!reportSnap) continue;

    const ppmAmount = parsePrincipalAmount(ppmEntry.principalAmount);
    const reportBalance = reportSnap.currentBalance ?? reportSnap.beginningBalance;

    if (ppmAmount != null && reportBalance != null && ppmAmount > 0) {
      const diff = Math.abs(reportBalance - ppmAmount);
      const pctDiff = (diff / ppmAmount) * 100;

      // Only flag if balance is higher than PPM (indicates reset upward) or significantly different
      if (pctDiff > 5) {
        const isHigher = reportBalance > ppmAmount;
        checks.push({
          name: `cap_structure_balance_${normName}`,
          status: "warn",
          expected: ppmAmount,
          actual: reportBalance,
          discrepancy: Math.round(pctDiff * 100) / 100,
          message: `${ppmEntry.class}: compliance report balance (${reportBalance.toLocaleString()}) is ${isHigher ? "higher" : "lower"} than PPM original amount (${ppmAmount.toLocaleString()}) by ${pctDiff.toFixed(1)}%.${isHigher ? " This likely indicates a tranche reset — compliance report reflects current structure." : " Normal amortization or paydown."}`,
        });
      }
    }
  }

  // 5. If ANY mismatch was found, add an overall advisory
  if (checks.length > 0) {
    checks.unshift({
      name: "cap_structure_mismatch_advisory",
      status: "warn",
      expected: null,
      actual: null,
      discrepancy: null,
      message: `PPM and compliance report capital structures differ. When documents disagree, the compliance report typically reflects the most recent state (post-reset, refinancing, or amendment). Verify against the latest supplemental indenture or trustee notice.`,
    });
  }

  return checks;
}

// ─── Section-Based Validation (Phase 4) ───

export function validateSectionExtraction(
  sections: Record<string, Record<string, unknown> | null>,
): ValidationResult {
  const checks: ValidationCheck[] = [];
  let skipped = 0;

  const summary = sections.compliance_summary as Record<string, unknown> | null;
  const holdings = (sections.asset_schedule as Record<string, unknown> | null)?.holdings as Array<Record<string, unknown>> | undefined;
  const pvTests = (sections.par_value_tests as Record<string, unknown> | null)?.tests as Array<Record<string, unknown>> | undefined;
  const icTests = (sections.interest_coverage_tests as Record<string, unknown> | null)?.tests as Array<Record<string, unknown>> | undefined;
  const allTests = [...(pvTests || []), ...(icTests || [])];
  const concentrations = (sections.concentration_tables as Record<string, unknown> | null)?.concentrations as Array<Record<string, unknown>> | undefined;

  // ─── Pool-Level Checks (summary vs holdings) ───

  if (summary && holdings && holdings.length > 0) {
    const holdingsWithPar = holdings.filter((h) => h.parBalance != null);
    const totalHoldingsPar = holdingsWithPar.reduce((sum, h) => sum + (h.parBalance as number ?? 0), 0);

    const c1 = check("total_par_match", summary.totalPar as number | null, totalHoldingsPar, 2, "pct", "Total par");
    if (c1) checks.push(c1); else skipped++;

    const uniqueObligors = new Set(holdings.map((h) => (h.obligorName as string | null)?.toLowerCase().trim()).filter(Boolean)).size;
    const c2 = check("obligor_count", summary.numberOfObligors as number | null, uniqueObligors, 2, "abs", "Obligor count");
    if (c2) checks.push(c2); else skipped++;

    const c3 = check("asset_count", summary.numberOfAssets as number | null, holdings.length, 1, "abs", "Asset count");
    if (c3) checks.push(c3); else skipped++;

    const rawWacSpread = summary.wacSpread as number | null | undefined;
    if (rawWacSpread != null) {
      const holdingsWithSpread = holdingsWithPar.filter((h) => h.spreadBps != null);
      if (holdingsWithSpread.length > 0) {
        const totalParForSpread = holdingsWithSpread.reduce((sum, h) => sum + (h.parBalance as number ?? 0), 0);
        const waSpread = totalParForSpread > 0
          ? holdingsWithSpread.reduce((sum, h) => sum + (h.spreadBps as number ?? 0) * (h.parBalance as number ?? 0), 0) / totalParForSpread
          : 0;
        // Normalize units: if summary WA spread looks like percentage (<20) but calculated is bps (>100), convert
        const wacSpread = rawWacSpread < 20 && waSpread > 100 ? rawWacSpread * 100 : rawWacSpread;
        const c4 = check("wa_spread", wacSpread, waSpread, 10, "abs", "WA spread (bps)");
        if (c4) checks.push(c4); else skipped++;
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }

    const pctFixedRate = summary.pctFixedRate as number | null | undefined;
    if (pctFixedRate != null && totalHoldingsPar > 0) {
      const fixedPar = holdings.filter((h) => h.isFixedRate === true).reduce((sum, h) => sum + (h.parBalance as number ?? 0), 0);
      const calcFixedPct = (fixedPar / totalHoldingsPar) * 100;
      const c5 = check("fixed_rate_pct", pctFixedRate, calcFixedPct, 1, "abs", "Fixed rate %");
      if (c5) checks.push(c5); else skipped++;
    } else {
      skipped++;
    }

    const pctCccAndBelow = summary.pctCccAndBelow as number | null | undefined;
    if (pctCccAndBelow != null && totalHoldingsPar > 0) {
      const cccPar = holdings
        .filter((h) =>
          isCccOrBelow(h.moodysRating as string | null) ||
          isCccOrBelow(h.spRating as string | null) ||
          isCccOrBelow(h.compositeRating as string | null)
        )
        .reduce((sum, h) => sum + (h.parBalance as number ?? 0), 0);
      const calcCccPct = (cccPar / totalHoldingsPar) * 100;
      const c6 = check("ccc_pct", pctCccAndBelow, calcCccPct, 1, "abs", "CCC & below %");
      if (c6) checks.push(c6); else skipped++;
    } else {
      skipped++;
    }

    const pctDefaulted = summary.pctDefaulted as number | null | undefined;
    if (pctDefaulted != null && totalHoldingsPar > 0) {
      const defaultedPar = holdings.filter((h) => h.isDefaulted === true).reduce((sum, h) => sum + (h.parBalance as number ?? 0), 0);
      const calcDefaultedPct = (defaultedPar / totalHoldingsPar) * 100;
      const c7 = check("defaulted_pct", pctDefaulted, calcDefaultedPct, 0.5, "abs", "Defaulted %");
      if (c7) checks.push(c7); else skipped++;
    } else {
      skipped++;
    }
  } else {
    skipped += 7;
  }

  // ─── Concentration Checks ───

  if (concentrations && concentrations.length > 0 && allTests.length > 0) {
    const industryBuckets = concentrations.filter((c) => c.concentrationType === "INDUSTRY");
    const maxIndustryPct = industryBuckets.reduce((max, c) => Math.max(max, c.actualPct as number ?? 0), 0);
    const industryTests = allTests.filter((t) =>
      t.testType === "CONCENTRATION" && (t.testName as string | undefined)?.toLowerCase().includes("industry")
    );
    if (maxIndustryPct > 0 && industryTests.length > 0) {
      const industryLimit = (industryTests[0].triggerLevel ?? industryTests[0].thresholdLevel) as number | undefined;
      if (industryLimit != null) {
        const status = maxIndustryPct <= industryLimit ? "pass" : "fail";
        checks.push({
          name: "industry_concentration",
          status,
          expected: industryLimit,
          actual: maxIndustryPct,
          discrepancy: Math.round((maxIndustryPct - industryLimit) * 100) / 100,
          message: status === "pass"
            ? `Largest industry bucket (${maxIndustryPct.toFixed(1)}%) within limit (${industryLimit}%)`
            : `Largest industry bucket (${maxIndustryPct.toFixed(1)}%) exceeds limit (${industryLimit}%)`,
        });
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }

    const obligorBuckets = concentrations.filter((c) => c.concentrationType === "SINGLE_OBLIGOR");
    const maxObligorPct = obligorBuckets.reduce((max, c) => Math.max(max, c.actualPct as number ?? 0), 0);
    const obligorTests = allTests.filter((t) =>
      t.testType === "CONCENTRATION" && ((t.testName as string | undefined)?.toLowerCase().includes("obligor") || (t.testName as string | undefined)?.toLowerCase().includes("single"))
    );
    if (maxObligorPct > 0 && obligorTests.length > 0) {
      const obligorLimit = (obligorTests[0].triggerLevel ?? obligorTests[0].thresholdLevel) as number | undefined;
      if (obligorLimit != null) {
        const status = maxObligorPct <= obligorLimit ? "pass" : "fail";
        checks.push({
          name: "single_obligor_concentration",
          status,
          expected: obligorLimit,
          actual: maxObligorPct,
          discrepancy: Math.round((maxObligorPct - obligorLimit) * 100) / 100,
          message: status === "pass"
            ? `Largest obligor exposure (${maxObligorPct.toFixed(1)}%) within limit (${obligorLimit}%)`
            : `Largest obligor exposure (${maxObligorPct.toFixed(1)}%) exceeds limit (${obligorLimit}%)`,
        });
      } else {
        skipped++;
      }
    } else {
      skipped++;
    }
  } else {
    skipped += 2;
  }

  // ─── Internal Consistency (OC/IC test math) ───

  if (allTests.length > 0) {
    let ocCheckRan = false;
    let cushionCheckRan = false;
    let ocFailures = 0;
    let ocTotal = 0;
    let cushionFailures = 0;
    let cushionTotal = 0;

    for (const t of allTests) {
      const numerator = t.numerator as number | null | undefined;
      const denominator = t.denominator as number | null | undefined;
      const actualValue = t.actualValue as number | null | undefined;
      const triggerLevel = t.triggerLevel as number | null | undefined;
      const cushionPct = t.cushionPct as number | null | undefined;

      if (numerator != null && denominator != null && denominator !== 0 && actualValue != null) {
        ocCheckRan = true;
        ocTotal++;
        const calculated = (numerator / denominator) * 100;
        if (absDiff(calculated, actualValue) > 0.1) {
          ocFailures++;
        }
      }

      if (actualValue != null && triggerLevel != null && cushionPct != null) {
        cushionCheckRan = true;
        cushionTotal++;
        const calculated = actualValue - triggerLevel;
        if (absDiff(calculated, cushionPct) > 0.1) {
          cushionFailures++;
        }
      }
    }

    if (ocCheckRan) {
      const status = ocFailures === 0 ? "pass" : ocFailures <= 1 ? "warn" : "fail";
      checks.push({
        name: "oc_test_math",
        status,
        expected: 0,
        actual: ocFailures,
        discrepancy: ocFailures,
        message: ocFailures === 0
          ? `OC test math consistent across ${ocTotal} tests`
          : `${ocFailures}/${ocTotal} OC tests have numerator/denominator ≠ actualValue`,
      });
    } else {
      skipped++;
    }

    if (cushionCheckRan) {
      const status = cushionFailures === 0 ? "pass" : cushionFailures <= 1 ? "warn" : "fail";
      checks.push({
        name: "cushion_math",
        status,
        expected: 0,
        actual: cushionFailures,
        discrepancy: cushionFailures,
        message: cushionFailures === 0
          ? `Cushion math consistent across ${cushionTotal} tests`
          : `${cushionFailures}/${cushionTotal} tests have actualValue - triggerLevel ≠ cushionPct`,
      });
    } else {
      skipped++;
    }
  } else {
    skipped += 2;
  }

  const passed = checks.filter((c) => c.status === "pass").length;

  return {
    checks,
    score: passed,
    totalChecks: 11,
    checksRun: checks.length,
    checksSkipped: skipped,
  };
}

// ─── Repair Query Builder ───

export interface RepairQuery {
  sectionType: string;
  reason: string;
  instruction: string;
}

export function buildRepairQueries(
  validationResult: ValidationResult,
  sections: Record<string, Record<string, unknown> | null>,
): RepairQuery[] {
  const repairs: RepairQuery[] = [];

  // Check for entirely missing required sections
  const requiredSections = [
    "compliance_summary",
    "asset_schedule",
    "par_value_tests",
    "interest_coverage_tests",
    "concentration_tables",
  ];
  for (const sectionType of requiredSections) {
    if (sections[sectionType] === null || sections[sectionType] === undefined) {
      repairs.push({
        sectionType,
        reason: "missing_section",
        instruction: "Section was not found in the document. Try full document search.",
      });
    }
  }

  // Check for failing validation checks
  const failingChecks = validationResult.checks.filter((c) => c.status === "fail");

  for (const c of failingChecks) {
    switch (c.name) {
      case "asset_count":
        repairs.push({
          sectionType: "asset_schedule",
          reason: c.name,
          instruction: `Extracted ${c.actual} holdings but expected ${c.expected}. Find the missing holdings.`,
        });
        break;
      case "total_par_match":
        repairs.push({
          sectionType: "asset_schedule",
          reason: c.name,
          instruction: `Total par from holdings ($${c.actual}) doesn't match summary ($${c.expected}). Verify par balances.`,
        });
        break;
      case "wa_spread":
        repairs.push({
          sectionType: "asset_schedule",
          reason: c.name,
          instruction: "WA spread mismatch. Verify spread values for holdings.",
        });
        break;
      case "oc_test_math":
        repairs.push({
          sectionType: "par_value_tests",
          reason: c.name,
          instruction: "Some OC tests have inconsistent math. Re-extract tests.",
        });
        break;
      case "cushion_math":
        repairs.push({
          sectionType: "interest_coverage_tests",
          reason: c.name,
          instruction: "Some IC tests have inconsistent cushion math. Re-extract tests.",
        });
        break;
    }
  }

  return repairs;
}
