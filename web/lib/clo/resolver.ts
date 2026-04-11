import type { ExtractedConstraints, CloPoolSummary, CloComplianceTest, CloTranche, CloTrancheSnapshot, CloHolding } from "./types";
import type { ResolvedDealData, ResolvedTranche, ResolvedPool, ResolvedTrigger, ResolvedReinvestmentOcTrigger, ResolvedDates, ResolvedFees, ResolvedLoan, ResolutionWarning } from "./resolver-types";
import { parseSpreadToBps, normalizeWacSpread } from "./ingestion-gate";
import { mapToRatingBucket } from "./rating-mapping";
import { CLO_DEFAULTS } from "./defaults";

function addQuartersForResolver(dateIso: string, quarters: number): string {
  const d = new Date(dateIso);
  d.setUTCMonth(d.getUTCMonth() + quarters * 3);
  return d.toISOString().slice(0, 10);
}

function normClass(s: string): string {
  const base = s.replace(/^class\s+/i, "").replace(/[-\s]+notes?$/i, "").trim().toLowerCase();
  // Normalize subordinated variants: "subordinated", "sub", "subordinated notes" all → "sub"
  if (base === "subordinated" || base.startsWith("subordinated")) return "sub";
  return base;
}

/** Normalize a numeric string handling both US (1,500,000.00) and European (1.500.000,00) formats. */
function normalizeNumericString(raw: string): string {
  // European format: dots as thousands separators, comma as decimal (e.g. "1.500.000,00")
  if (/\d\.\d{3}[.,]/.test(raw) || /\d\.\d{3}\.\d{3}/.test(raw)) {
    return raw.replace(/\./g, "").replace(",", ".");
  }
  // Standard: strip commas (thousands separators), keep dots (decimal)
  return raw.replace(/,/g, "");
}

function parseAmount(s: string | undefined | null): number {
  if (!s) return 0;
  // Detect ranges like "100,000,000-200,000,000" or "100,000,000 - 200,000,000"
  // and take the first value (lower bound) instead of concatenating.
  const rangeMatch = s.match(/^[^0-9]*?([\d,._]+)\s*[-–—]\s*([\d,._]+)/);
  if (rangeMatch) {
    const cleaned = normalizeNumericString(rangeMatch[1]).replace(/[^0-9.]/g, "");
    return parseFloat(cleaned) || 0;
  }
  // Preserve leading minus sign for negative values.
  const negMatch = s.match(/^[^0-9]*(-)\s*([\d,._]+)/);
  if (negMatch) {
    const cleaned = normalizeNumericString(negMatch[2]).replace(/[^0-9.]/g, "");
    return -(parseFloat(cleaned) || 0);
  }
  const normalized = normalizeNumericString(s);
  const cleaned = normalized.replace(/[^0-9.]/g, "");
  return parseFloat(cleaned) || 0;
}

function isOcTest(t: { testType?: string | null; testName?: string | null }): boolean {
  if (t.testType === "OC_PAR" || t.testType === "OC_MV") return true;
  const name = (t.testName ?? "").toLowerCase();
  return name.includes("overcollateral") || name.includes("par value") || (name.includes("oc") && name.includes("ratio"));
}

function isIcTest(t: { testType?: string | null; testName?: string | null }): boolean {
  if (t.testType === "IC") return true;
  const name = (t.testName ?? "").toLowerCase();
  return name.includes("interest coverage") || (name.includes("ic") && name.includes("ratio"));
}

function dedupTriggers(triggers: { className: string; triggerLevel: number }[], warnings: ResolutionWarning[]): { className: string; triggerLevel: number }[] {
  const byClass = new Map<string, { className: string; triggerLevel: number }>();
  for (const t of triggers) {
    const existing = byClass.get(t.className);
    if (!existing) {
      byClass.set(t.className, t);
    } else if (t.triggerLevel !== existing.triggerLevel) {
      // Keep the higher (more restrictive) trigger but warn about the discrepancy
      warnings.push({
        field: `trigger.${t.className}`,
        message: `Duplicate trigger for ${t.className}: ${existing.triggerLevel}% vs ${t.triggerLevel}% — keeping ${Math.max(existing.triggerLevel, t.triggerLevel)}%`,
        severity: "warn",
      });
      if (t.triggerLevel > existing.triggerLevel) {
        byClass.set(t.className, t);
      }
    }
  }
  return Array.from(byClass.values());
}

function resolveTranches(
  constraints: ExtractedConstraints,
  dbTranches: CloTranche[],
  snapshots: CloTrancheSnapshot[],
  warnings: ResolutionWarning[],
): ResolvedTranche[] {
  const snapshotByTrancheId = new Map(snapshots.map(s => [s.trancheId, s]));
  const classXAmort = constraints.dealSizing?.classXAmortisation;
  const classXAmortPerPeriod = classXAmort ? parseAmount(classXAmort) : null;
  if (!classXAmortPerPeriod) {
    warnings.push({ field: "classXAmortisation", message: "Class X amortisation per period not extracted — model will estimate by dividing balance evenly over 5 quarters. Set manually if different.", severity: "warn" });
  }

  // Compute Class X amort start date: "second Payment Date following Issue Date"
  // = one quarter after firstPaymentDate
  const firstPayment = constraints.keyDates?.firstPaymentDate;
  const classXAmortStartDate = firstPayment ? addQuartersForResolver(firstPayment, 1) : null;

  // Build PPM spread lookup
  const ppmSpreadByClass = new Map<string, number>();
  const ppmBalanceByClass = new Map<string, number>();
  const ppmDeferrableByClass = new Map<string, boolean>();
  const ppmSubByClass = new Map<string, boolean>();

  for (const e of constraints.capitalStructure ?? []) {
    const key = normClass(e.class);
    const bps = parseSpreadToBps(e.spreadBps, e.spread);
    if (bps != null && bps > 0) ppmSpreadByClass.set(key, bps);
    ppmBalanceByClass.set(key, parseAmount(e.principalAmount));
    if (e.deferrable != null) ppmDeferrableByClass.set(key, e.deferrable);
    ppmSubByClass.set(key, e.isSubordinated ?? e.class.toLowerCase().includes("sub"));
  }

  // If DB tranches exist, use them as the primary source
  if (dbTranches.length > 0) {
    return [...dbTranches]
      .sort((a, b) => (a.seniorityRank ?? 99) - (b.seniorityRank ?? 99))
      .map(t => {
        const snap = snapshotByTrancheId.get(t.id);
        const key = normClass(t.className);
        const isClassX = /^(class\s+)?x$/i.test(t.className.trim());
        const isSub = t.isIncomeNote ?? t.isSubordinate ?? ppmSubByClass.get(key) ?? t.className.toLowerCase().includes("sub");

        let spreadBps = t.spreadBps ?? ppmSpreadByClass.get(key) ?? 0;
        if (spreadBps === 0 && !isSub) {
          warnings.push({
            field: `${t.className}.spreadBps`,
            message: `No spread found for ${t.className} in DB or PPM constraints`,
            severity: "error",
          });
        }
        if (t.spreadBps == null && ppmSpreadByClass.has(key)) {
          warnings.push({
            field: `${t.className}.spreadBps`,
            message: `Using PPM spread (${ppmSpreadByClass.get(key)} bps) — DB tranche has null`,
            severity: "info",
            resolvedFrom: "ppm_constraints",
          });
        }

        return {
          className: t.className,
          currentBalance: snap?.currentBalance ?? t.originalBalance ?? ppmBalanceByClass.get(key) ?? 0,
          originalBalance: t.originalBalance ?? ppmBalanceByClass.get(key) ?? 0,
          spreadBps,
          seniorityRank: t.seniorityRank ?? 99,
          isFloating: t.isFloating ?? true,
          isIncomeNote: isSub,
          isDeferrable: t.isDeferrable ?? ppmDeferrableByClass.get(key) ?? false,
          isAmortising: isClassX,
          amortisationPerPeriod: isClassX ? (classXAmortPerPeriod ?? null) : null,
          amortStartDate: isClassX ? classXAmortStartDate : null,
          source: snap ? "snapshot" as const : "db_tranche" as const,
        };
      });
  }

  // Fallback: build from PPM capital structure
  const entries = constraints.capitalStructure ?? [];
  const byClass = new Map<string, typeof entries[number]>();
  for (const e of entries) {
    const key = normClass(e.class);
    const existing = byClass.get(key);
    if (!existing || (parseAmount(e.principalAmount) > 0 && (!existing.principalAmount || parseAmount(existing.principalAmount) === 0))) {
      byClass.set(key, e);
    }
  }

  // Sort by class letter to ensure correct seniority regardless of LLM extraction order.
  // Standard CLO classes: X, A, B, C, D, E, F, then subordinated/equity last.
  const classOrder = (e: typeof entries[number]): number => {
    const name = e.class.replace(/^class\s+/i, "").trim().toLowerCase();
    if (/^x$/i.test(name)) return 0;
    if (e.isSubordinated || name.includes("sub") || name.includes("equity") || name.includes("income")) return 100;
    // Single letter classes (A=1, B=2, ..., F=6) — handles "A-1", "A-2" etc.
    const letter = name.match(/^([a-z])/)?.[1];
    if (letter) return letter.charCodeAt(0) - 96; // a=1, b=2, ...
    return 50; // unknown → middle
  };
  const sortedEntries = Array.from(byClass.values()).sort((a, b) => classOrder(a) - classOrder(b));

  return sortedEntries.map((e, idx) => {
    const isSub = e.isSubordinated ?? e.class.toLowerCase().includes("sub");
    const isFloating = e.rateType
      ? e.rateType.toLowerCase().includes("float")
      : (e.spread?.toLowerCase().includes("euribor") || e.spread?.toLowerCase().includes("sofr") || false);
    const isClassX = /^(class\s+)?x$/i.test(e.class.trim());
    const spreadBps = parseSpreadToBps(e.spreadBps, e.spread) ?? 0;

    if (spreadBps === 0 && !isSub) {
      warnings.push({
        field: `${e.class}.spreadBps`,
        message: `No spread found for ${e.class} in PPM constraints`,
        severity: "error",
      });
    }

    return {
      className: e.class,
      currentBalance: parseAmount(e.principalAmount),
      originalBalance: parseAmount(e.principalAmount),
      spreadBps,
      seniorityRank: idx + 1,
      isFloating,
      isIncomeNote: isSub,
      isDeferrable: e.deferrable ?? false,
      isAmortising: isClassX,
      amortisationPerPeriod: isClassX ? (classXAmortPerPeriod ?? null) : null,
      amortStartDate: isClassX ? classXAmortStartDate : null,
      source: "ppm" as const,
    };
  });
}

function resolveTriggers(
  complianceTests: CloComplianceTest[],
  constraints: ExtractedConstraints,
  resolvedTranches: ResolvedTranche[],
  warnings: ResolutionWarning[],
): { oc: ResolvedTrigger[]; ic: ResolvedTrigger[] } {
  // Resolve a class name (possibly compound like "A/B") to its most junior seniority rank
  function resolveRank(cls: string): number {
    const parts = cls.split("/").map(s => s.trim());
    let maxRank = 0;
    for (const part of parts) {
      const base = part.replace(/-RR$/i, "").trim();
      const exact = resolvedTranches.find(t => normClass(t.className) === normClass(base));
      if (exact) { maxRank = Math.max(maxRank, exact.seniorityRank); continue; }
      const prefix = resolvedTranches.filter(t =>
        normClass(t.className).startsWith(normClass(base)) || normClass(t.className).startsWith(base.toLowerCase())
      );
      if (prefix.length > 0) { maxRank = Math.max(maxRank, ...prefix.map(t => t.seniorityRank)); continue; }
    }
    return maxRank || 99;
  }

  // From compliance tests
  const ocFromTests = complianceTests
    .filter(t => isOcTest(t) && t.triggerLevel != null && t.testClass)
    .map(t => ({ className: t.testClass!, triggerLevel: t.triggerLevel! }));
  const icFromTests = complianceTests
    .filter(t => isIcTest(t) && t.triggerLevel != null && t.testClass)
    .map(t => ({ className: t.testClass!, triggerLevel: t.triggerLevel! }));

  // From PPM constraints (fallback)
  const ocFromPpm = (constraints.coverageTestEntries ?? [])
    .filter(e => e.class && e.parValueRatio && parseFloat(e.parValueRatio))
    .map(e => ({ className: e.class!, triggerLevel: parseFloat(e.parValueRatio!) }));
  const icFromPpm = (constraints.coverageTestEntries ?? [])
    .filter(e => e.class && e.interestCoverageRatio && parseFloat(e.interestCoverageRatio))
    .map(e => ({ className: e.class!, triggerLevel: parseFloat(e.interestCoverageRatio!) }));

  const ocRaw = ocFromTests.length > 0 ? ocFromTests : ocFromPpm;
  const icRaw = icFromTests.length > 0 ? icFromTests : icFromPpm;
  const ocSource = ocFromTests.length > 0 ? "compliance" as const : "ppm" as const;
  const icSource = icFromTests.length > 0 ? "compliance" as const : "ppm" as const;

  if (ocRaw.length === 0) {
    warnings.push({ field: "ocTriggers", message: "No OC triggers found in compliance tests or PPM", severity: "warn" });
  }

  const oc: ResolvedTrigger[] = dedupTriggers(ocRaw, warnings).map(t => {
    let triggerLevel = t.triggerLevel;
    // Values < 10 are almost certainly ratios (e.g. 1.05 → 105%).
    // Values >= 90 are treated as percentages (e.g. 105.0% stays 105.0%).
    // Values 10–90 are in no-man's land: no real OC trigger is 10-90%.
    // Both interpretations (as-is = too low, ×100 = too high) are wrong,
    // so we warn at error severity and leave as-is (perpetually-passing is
    // safer than perpetually-failing, which would wipe out equity).
    if (triggerLevel > 0 && triggerLevel < 10) {
      triggerLevel = triggerLevel * 100;
      warnings.push({ field: `ocTrigger.${t.className}`, message: `OC trigger ${t.triggerLevel} looks like a ratio, converting to ${triggerLevel}%`, severity: "warn" });
    } else if (triggerLevel >= 10 && triggerLevel < 90) {
      warnings.push({ field: `ocTrigger.${t.className}`, message: `OC trigger ${triggerLevel}% for ${t.className} is implausible — no CLO OC trigger is 10-90%. Check extraction and set manually.`, severity: "error" });
    }
    if (triggerLevel > 200) {
      warnings.push({ field: `ocTrigger.${t.className}`, message: `OC trigger ${triggerLevel}% for ${t.className} seems unusually high`, severity: "warn" });
    }
    return { className: t.className, triggerLevel, rank: resolveRank(t.className), testType: "OC" as const, source: ocSource };
  });

  const ic: ResolvedTrigger[] = dedupTriggers(icRaw, warnings).map(t => {
    let triggerLevel = t.triggerLevel;
    // IC triggers: values < 10 are ratios (e.g. 1.20 → 120%). IC triggers are
    // typically 100-200%. Values >= 10 are treated as percentages.
    if (triggerLevel > 0 && triggerLevel < 10) {
      triggerLevel = triggerLevel * 100;
      warnings.push({ field: `icTrigger.${t.className}`, message: `IC trigger ${t.triggerLevel} looks like a ratio, converting to ${triggerLevel}%`, severity: "warn" });
    }
    if (triggerLevel > 500) {
      warnings.push({ field: `icTrigger.${t.className}`, message: `IC trigger ${triggerLevel}% for ${t.className} seems unusually high`, severity: "warn" });
    }
    return { className: t.className, triggerLevel, rank: resolveRank(t.className), testType: "IC" as const, source: icSource };
  });

  return { oc, ic };
}

function resolveFees(constraints: ExtractedConstraints, warnings: ResolutionWarning[]): ResolvedFees {
  let seniorFeePct: number = CLO_DEFAULTS.seniorFeePct;
  let subFeePct: number = CLO_DEFAULTS.subFeePct;
  let trusteeFeeBps: number = CLO_DEFAULTS.trusteeFeeBps;
  let incentiveFeePct: number = CLO_DEFAULTS.incentiveFeePct;
  let incentiveFeeHurdleIrr: number = CLO_DEFAULTS.incentiveFeeHurdleIrr;

  for (const fee of constraints.fees ?? []) {
    const name = fee.name?.toLowerCase() ?? "";
    const rate = parseFloat(fee.rate ?? "");
    if (isNaN(rate)) continue;
    const unit = fee.rateUnit ?? null;

    // Helper: convert rate to percentage, handling bps_pa unit or heuristic fallback
    const toPctPa = (r: number, fieldName: string): number => {
      if (unit === "bps_pa") {
        warnings.push({ field: fieldName, message: `Converted ${r} bps to ${r / 100}% (rateUnit: bps_pa)`, severity: "info" });
        return r / 100;
      }
      if (unit === "pct_pa") return r;
      // No explicit unit — use heuristic: management fees > 5 are almost certainly bps
      if (r > 5) {
        warnings.push({ field: fieldName, message: `Fee rate ${r} looks like bps (no rateUnit), converting to ${r / 100}%`, severity: "warn" });
        return r / 100;
      }
      return r;
    };

    if (name.includes("senior") && (name.includes("mgmt") || name.includes("management"))) {
      seniorFeePct = toPctPa(rate, "fees.seniorFeePct");
    } else if (name.includes("sub") && (name.includes("mgmt") || name.includes("management"))) {
      subFeePct = toPctPa(rate, "fees.subFeePct");
    } else if (name.includes("trustee") || name.includes("admin")) {
      // Trustee fees are in bps — if unit says pct_pa, convert
      if (unit === "pct_pa") {
        trusteeFeeBps = rate * 100;
        warnings.push({ field: "fees.trusteeFeeBps", message: `Converted trustee fee ${rate}% to ${rate * 100} bps (rateUnit: pct_pa)`, severity: "info" });
      } else {
        trusteeFeeBps = rate;
      }
      if (trusteeFeeBps > 50) {
        warnings.push({ field: "fees.trusteeFeeBps", message: `Trustee fee ${trusteeFeeBps} bps seems unusually high`, severity: "warn" });
      }
    } else if (name.includes("incentive") || name.includes("performance")) {
      incentiveFeePct = rate;
      if (rate > 50) {
        warnings.push({ field: "fees.incentiveFeePct", message: `Incentive fee ${rate}% seems unusually high`, severity: "warn" });
      }
      const hurdleRaw = parseFloat(fee.hurdleRate ?? "");
      if (!isNaN(hurdleRaw) && hurdleRaw > 0) {
        incentiveFeeHurdleIrr = hurdleRaw > 1 ? hurdleRaw / 100 : hurdleRaw;
      } else if (incentiveFeePct > 0) {
        // Standard European CLO equity hurdle is ~12% IRR. Using 0% would mean
        // the incentive fee fires on any positive return, which is too aggressive.
        incentiveFeeHurdleIrr = 0.12;
        warnings.push({ field: "fees.incentiveFeeHurdleIrr", message: `Incentive fee present (${incentiveFeePct}%) but no hurdle rate found — assuming 12% IRR hurdle. This directly affects equity IRR calculation. Set manually if different.`, severity: "error", resolvedFrom: "not extracted → defaulted to 12%" });
      }
    }
  }

  return { seniorFeePct, subFeePct, trusteeFeeBps, incentiveFeePct, incentiveFeeHurdleIrr };
}

export function resolveWaterfallInputs(
  constraints: ExtractedConstraints,
  complianceData: {
    poolSummary: CloPoolSummary | null;
    complianceTests: CloComplianceTest[];
    concentrations: unknown[];
  } | null,
  dbTranches: CloTranche[],
  trancheSnapshots: CloTrancheSnapshot[],
  holdings: CloHolding[],
  dealDates?: { maturity?: string | null; reinvestmentPeriodEnd?: string | null },
): { resolved: ResolvedDealData; warnings: ResolutionWarning[] } {
  const warnings: ResolutionWarning[] = [];

  // --- Tranches ---
  const rawTranches = resolveTranches(constraints, dbTranches, trancheSnapshots, warnings);

  // Deduplicate by normalized class name — keep the entry with the lower seniority rank
  // (more authoritative). This handles "Subordinated Notes" vs "Sub" from different sources.
  const seenClasses = new Map<string, number>();
  const tranches: ResolvedTranche[] = [];
  for (const t of rawTranches) {
    const key = normClass(t.className);
    const existingIdx = seenClasses.get(key);
    if (existingIdx != null) {
      const existing = tranches[existingIdx];
      // Prefer snapshot > db_tranche > ppm (snapshot has current balances)
      const sourcePriority: Record<string, number> = { snapshot: 3, db_tranche: 2, ppm: 1, manual: 4 };
      const tPrio = sourcePriority[t.source] ?? 0;
      const ePrio = sourcePriority[existing.source] ?? 0;
      if (tPrio > ePrio || (tPrio === ePrio && t.seniorityRank < existing.seniorityRank)) {
        tranches[existingIdx] = t;
      }
      warnings.push({
        field: `${t.className}`,
        message: `Duplicate tranche "${t.className}" (source: ${t.source}) merged with "${existing.className}" (source: ${existing.source})`,
        severity: "info",
      });
    } else {
      seenClasses.set(key, tranches.length);
      tranches.push(t);
    }
  }

  // --- Pool Summary ---
  const pool = complianceData?.poolSummary;
  const { bps: wacSpreadBps, fix: wacFix } = normalizeWacSpread(pool?.wacSpread ?? null);
  if (wacFix) warnings.push({ field: wacFix.field, message: wacFix.message, severity: "info", resolvedFrom: `${wacFix.before} → ${wacFix.after}` });

  const poolSummary: ResolvedPool = {
    totalPar: pool?.totalPar ?? 0,
    wacSpreadBps,
    warf: pool?.warf ?? 0,
    walYears: pool?.walYears ?? 0,
    diversityScore: pool?.diversityScore ?? 0,
    numberOfObligors: pool?.numberOfObligors ?? 0,
  };

  if (poolSummary.totalPar === 0) {
    warnings.push({ field: "poolSummary.totalPar", message: "Total par is 0 — no pool summary data", severity: "error" });
  }

  // --- Triggers ---
  const { oc: ocTriggers, ic: icTriggers } = resolveTriggers(
    complianceData?.complianceTests ?? [],
    constraints,
    tranches,
    warnings,
  );

  // --- Dates ---
  const currentDate = new Date().toISOString().slice(0, 10);
  const maturity = dealDates?.maturity ?? constraints.keyDates?.maturityDate ?? null;
  // Dynamic fallback: currentDate + defaultMaxTenorYears (instead of hardcoded date)
  let resolvedMaturity = maturity;
  if (!resolvedMaturity) {
    const fallbackYear = new Date().getFullYear() + CLO_DEFAULTS.defaultMaxTenorYears;
    resolvedMaturity = `${fallbackYear}-01-15`;
    warnings.push({ field: "dates.maturity", message: `No maturity date found — using fallback ${resolvedMaturity} (current date + ${CLO_DEFAULTS.defaultMaxTenorYears} years). Set maturity manually.`, severity: "error" });
  }

  const dates: ResolvedDates = {
    maturity: resolvedMaturity,
    reinvestmentPeriodEnd: dealDates?.reinvestmentPeriodEnd ?? constraints.keyDates?.reinvestmentPeriodEnd ?? null,
    nonCallPeriodEnd: constraints.keyDates?.nonCallPeriodEnd ?? null,
    firstPaymentDate: constraints.keyDates?.firstPaymentDate ?? null,
    currentDate,
  };

  // --- Fees ---
  const fees = resolveFees(constraints, warnings);

  // --- Reinvestment OC Trigger ---
  // Resolved from PPM's reinvestmentOcTest field, with fallback to the most junior OC test
  let reinvestmentOcTrigger: ResolvedReinvestmentOcTrigger | null = null;
  const reinvOcRaw = constraints.reinvestmentOcTest;

  // Parse diversion percentage from the extracted diversionAmount string (e.g. "Up to 50%...", "100%")
  let diversionPct = 50; // common default
  if (reinvOcRaw?.diversionAmount) {
    const pctMatch = reinvOcRaw.diversionAmount.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pctMatch) {
      diversionPct = parseFloat(pctMatch[1]);
    } else {
      warnings.push({ field: "reinvestmentOcTrigger.diversionPct", message: `Could not parse diversion percentage from "${reinvOcRaw.diversionAmount}" — defaulting to 50%`, severity: "warn" });
    }
  } else if (reinvOcRaw?.trigger) {
    warnings.push({ field: "reinvestmentOcTrigger.diversionPct", message: `Reinvestment OC trigger found but no diversion amount specified — defaulting to 50%`, severity: "warn" });
  }

  if (reinvOcRaw?.trigger) {
    let triggerLevel = parseFloat(reinvOcRaw.trigger);
    if (!isNaN(triggerLevel) && triggerLevel > 0) {
      // Apply the same ratio→percentage normalization as standard OC triggers:
      // values < 10 are almost certainly ratios (e.g. 1.05 → 105%).
      if (triggerLevel < 10) {
        warnings.push({ field: "reinvestmentOcTrigger", message: `Reinvestment OC trigger ${triggerLevel} looks like a ratio, converting to ${triggerLevel * 100}%`, severity: "warn" });
        triggerLevel = triggerLevel * 100;
      } else if (triggerLevel >= 10 && triggerLevel < 90) {
        warnings.push({ field: "reinvestmentOcTrigger", message: `Reinvestment OC trigger ${triggerLevel}% is implausible (10-90%). Check extraction and set manually.`, severity: "error" });
      }
      if (triggerLevel > 200) {
        warnings.push({ field: "reinvestmentOcTrigger", message: `Reinvestment OC trigger ${triggerLevel}% seems unusually high`, severity: "warn" });
      }
      // Use the most junior OC test rank (typically Class F)
      const sortedOc = [...ocTriggers].sort((a, b) => b.rank - a.rank);
      reinvestmentOcTrigger = { triggerLevel, rank: sortedOc[0]?.rank ?? 99, diversionPct };
    }
  }
  if (!reinvestmentOcTrigger && ocTriggers.length > 0) {
    // Fallback: derive from the most junior OC trigger
    const sortedOc = [...ocTriggers].sort((a, b) => b.rank - a.rank);
    reinvestmentOcTrigger = { triggerLevel: sortedOc[0].triggerLevel, rank: sortedOc[0].rank, diversionPct };
  }

  // --- Loans ---
  const fallbackMaturity = resolvedMaturity;
  const loans: ResolvedLoan[] = holdings
    .filter(h => h.parBalance != null && h.parBalance > 0 && !h.isDefaulted)
    .map(h => ({
      parBalance: h.parBalance!,
      maturityDate: h.maturityDate ?? fallbackMaturity,
      ratingBucket: mapToRatingBucket(h.moodysRating ?? null, h.spRating ?? null, h.fitchRating ?? null, h.compositeRating ?? null),
      spreadBps: h.spreadBps ?? wacSpreadBps,
      obligorName: h.obligorName ?? undefined,
    }));

  // --- Base Rate Floor ---
  // Extracted from interest mechanics section. null = not extracted (use default from CLO_DEFAULTS).
  const baseRateFloorPct = constraints.interestMechanics?.referenceRateFloorPct ?? null;

  // --- Deferred Interest Compounding ---
  // Extracted from interest mechanics section. Defaults to true (standard CLO convention).
  let deferredInterestCompounds = true;
  if (constraints.interestMechanics?.deferredInterestCompounds !== undefined) {
    deferredInterestCompounds = constraints.interestMechanics.deferredInterestCompounds;
  } else if (tranches.some(t => t.isDeferrable)) {
    warnings.push({ field: "deferredInterestCompounds", message: "Deal has deferrable tranches but no PIK compounding info extracted — assuming deferred interest compounds (standard convention). Set manually if different.", severity: "warn" });
  }

  return {
    resolved: { tranches, poolSummary, ocTriggers, icTriggers, reinvestmentOcTrigger, dates, fees, loans, deferredInterestCompounds, baseRateFloorPct },
    warnings,
  };
}
