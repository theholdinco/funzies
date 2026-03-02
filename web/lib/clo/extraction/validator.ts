import type { Pass1Output, Pass2Output, Pass3Output } from "./schemas";

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
  "caa1", "caa2", "caa3", "caa", "ca", "c", "d",
  "ccc+", "ccc", "ccc-", "cc", "c", "d", "sd",
  "ccc", "cc", "c", "d", "rd",
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
        const c4 = check("wa_spread", pool.wacSpread, waSpread, 10, "abs", "WA spread (bps)");
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
