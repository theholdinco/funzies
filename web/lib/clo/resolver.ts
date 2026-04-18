import type { ExtractedConstraints, CloPoolSummary, CloComplianceTest, CloTranche, CloTrancheSnapshot, CloHolding, CloAccountBalance, CloParValueAdjustment } from "./types";
import type { ResolvedDealData, ResolvedTranche, ResolvedPool, ResolvedTrigger, ResolvedReinvestmentOcTrigger, ResolvedDates, ResolvedFees, ResolvedLoan, ResolutionWarning } from "./resolver-types";
import { parseSpreadToBps, normalizeWacSpread } from "./ingestion-gate";
import { mapToRatingBucket } from "./rating-mapping";
import { CLO_DEFAULTS } from "./defaults";

function addQuartersForResolver(dateIso: string, quarters: number): string {
  const d = new Date(dateIso);
  const origDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + quarters * 3);
  // Clamp to last day of target month if day rolled forward (e.g. Jan 31 + 3mo → Apr 30)
  if (d.getUTCDate() !== origDay) d.setUTCDate(0);
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
  const tt = (t.testType ?? "").toLowerCase();
  if (tt === "oc_par" || tt === "oc_mv" || tt === "overcollateralization" || tt.startsWith("oc")) return true;
  const name = (t.testName ?? "").toLowerCase();
  return name.includes("overcollateral") || name.includes("par value") || (name.includes("oc") && name.includes("ratio"));
}

function isIcTest(t: { testType?: string | null; testName?: string | null }): boolean {
  if (t.testType === "IC") return true;
  const name = (t.testName ?? "").toLowerCase();
  return name.includes("interest coverage") || (name.includes("ic") && name.includes("ratio"));
}

function dedupTriggers(triggers: { className: string; triggerLevel: number; source: "compliance" | "ppm" }[], warnings: ResolutionWarning[]): { className: string; triggerLevel: number; source: "compliance" | "ppm" }[] {
  const byClass = new Map<string, { className: string; triggerLevel: number; source: "compliance" | "ppm" }>();
  for (const t of triggers) {
    const key = normClass(t.className);
    const existing = byClass.get(key);
    if (!existing) {
      byClass.set(key, t);
    } else if (t.triggerLevel !== existing.triggerLevel) {
      // Keep the higher (more restrictive) trigger but warn about the discrepancy
      warnings.push({
        field: `trigger.${t.className}`,
        message: `Duplicate trigger for ${t.className}: ${existing.triggerLevel}% vs ${t.triggerLevel}% — keeping ${Math.max(existing.triggerLevel, t.triggerLevel)}%`,
        severity: "warn",
      });
      if (t.triggerLevel > existing.triggerLevel) {
        byClass.set(key, t);
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

  // Default amort start: "second Payment Date" = one quarter after firstPaymentDate
  const firstPayment = constraints.keyDates?.firstPaymentDate;
  const defaultAmortStartDate = firstPayment ? addQuartersForResolver(firstPayment, 1) : null;

  // Build PPM per-tranche lookups
  const ppmSpreadByClass = new Map<string, number>();
  const ppmBalanceByClass = new Map<string, number>();
  const ppmDeferrableByClass = new Map<string, boolean>();
  const ppmSubByClass = new Map<string, boolean>();
  const ppmAmortByClass = new Map<string, number>();
  const ppmAmortStartByClass = new Map<string, string>();

  for (const e of constraints.capitalStructure ?? []) {
    const key = normClass(e.class);
    const bps = parseSpreadToBps(e.spreadBps, e.spread);
    if (bps != null && bps > 0) ppmSpreadByClass.set(key, bps);
    ppmBalanceByClass.set(key, parseAmount(e.principalAmount));
    if (e.deferrable != null) ppmDeferrableByClass.set(key, e.deferrable);
    ppmSubByClass.set(key, e.isSubordinated ?? e.class.toLowerCase().includes("sub"));
    if (e.amortisationPerPeriod) {
      const amt = parseAmount(e.amortisationPerPeriod);
      if (amt > 0) ppmAmortByClass.set(key, amt);
    }
    if (e.amortStartDate) ppmAmortStartByClass.set(key, e.amortStartDate);
  }

  // If DB tranches exist, use them as the primary source
  if (dbTranches.length > 0) {
    return [...dbTranches]
      .sort((a, b) => (a.seniorityRank ?? 99) - (b.seniorityRank ?? 99))
      .map(t => {
        const snap = snapshotByTrancheId.get(t.id);
        const key = normClass(t.className);
        const isSub = t.isIncomeNote ?? t.isSubordinate ?? ppmSubByClass.get(key) ?? t.className.toLowerCase().includes("sub");
        const ppmAmort = ppmAmortByClass.get(key) ?? null;
        // Prefer compliance report's actual principal paid over PPM's contractual schedule.
        // If snapshot reports 0, keep PPM schedule (one zero-payment period doesn't cancel the schedule).
        const snapshotAmort = snap?.principalPaid != null && snap.principalPaid > 0 ? snap.principalPaid : null;
        const amortPerPeriod = snapshotAmort ?? ppmAmort;
        const hasAmort = amortPerPeriod != null;
        if (snapshotAmort != null && ppmAmort != null && snapshotAmort !== ppmAmort) {
          warnings.push({
            field: `${t.className}.amortisationPerPeriod`,
            message: `Compliance report principal paid (${snapshotAmort.toLocaleString()}) differs from PPM schedule (${ppmAmort.toLocaleString()}) — using compliance report`,
            severity: "info",
            resolvedFrom: "snapshot",
          });
        }

        let spreadBps = t.spreadBps ?? ppmSpreadByClass.get(key) ?? 0;
        // Defense-in-depth: if spread looks like a percentage (< 20) after DB read, convert.
        // This should not fire if ingestion is correct — if it does, log a warning.
        if (spreadBps > 0 && spreadBps < 20 && !isSub) {
          warnings.push({ field: `${t.className}.spreadBps`, message: `Spread ${spreadBps} looks like percentage (not bps) — converting to ${Math.round(spreadBps * 100)} bps. Check ingestion.`, severity: "warn" });
          spreadBps = Math.round(spreadBps * 100);
        }
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
          currentBalance: snap?.endingBalance ?? snap?.currentBalance ?? t.originalBalance ?? ppmBalanceByClass.get(key) ?? 0,
          originalBalance: ppmBalanceByClass.get(key) ?? t.originalBalance ?? 0,
          spreadBps,
          seniorityRank: t.seniorityRank ?? 99,
          isFloating: t.isFloating ?? true,
          isIncomeNote: isSub,
          isDeferrable: t.isDeferrable ?? ppmDeferrableByClass.get(key) ?? false,
          isAmortising: hasAmort,
          amortisationPerPeriod: amortPerPeriod,
          amortStartDate: hasAmort ? (ppmAmortStartByClass.get(key) ?? defaultAmortStartDate) : null,
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
    const key = normClass(e.class);
    const amortPerPeriod = ppmAmortByClass.get(key) ?? null;
    const hasAmort = amortPerPeriod != null;
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
      isAmortising: hasAmort,
      amortisationPerPeriod: amortPerPeriod,
      amortStartDate: hasAmort ? (ppmAmortStartByClass.get(key) ?? defaultAmortStartDate) : null,
      source: "ppm" as const,
    };
  });
}

/** Per-class merge: use compliance trigger when available, fill gaps from PPM. */
function mergeTriggersPerClass(
  fromTests: { className: string; triggerLevel: number; source: "compliance" | "ppm" }[],
  fromPpm: { className: string; triggerLevel: number; source: "compliance" | "ppm" }[],
  testType: string,
  warnings: ResolutionWarning[],
): { className: string; triggerLevel: number; source: "compliance" | "ppm" }[] {
  if (fromTests.length === 0) return fromPpm;
  if (fromPpm.length === 0) return fromTests;

  const testsByClass = new Map(fromTests.map(t => [normClass(t.className), t]));
  const merged = [...fromTests];

  for (const ppm of fromPpm) {
    const key = normClass(ppm.className);
    if (!testsByClass.has(key)) {
      merged.push(ppm);
      warnings.push({
        field: `${testType}Trigger.${ppm.className}`,
        message: `${testType} trigger for ${ppm.className} not found in compliance report — using PPM value (${ppm.triggerLevel})`,
        severity: "info",
        resolvedFrom: "ppm_constraints",
      });
    }
  }

  return merged;
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

  type TriggerEntry = { className: string; triggerLevel: number; source: "compliance" | "ppm" };

  // From compliance tests
  const ocFromTests: TriggerEntry[] = complianceTests
    .filter(t => isOcTest(t) && t.triggerLevel != null && t.testClass)
    .map(t => ({ className: t.testClass!, triggerLevel: t.triggerLevel!, source: "compliance" as const }));
  const icFromTests: TriggerEntry[] = complianceTests
    .filter(t => isIcTest(t) && t.triggerLevel != null && t.testClass)
    .map(t => ({ className: t.testClass!, triggerLevel: t.triggerLevel!, source: "compliance" as const }));

  // From PPM constraints (fallback)
  const ocFromPpm: TriggerEntry[] = (constraints.coverageTestEntries ?? [])
    .filter(e => e.class && e.parValueRatio && parseFloat(e.parValueRatio))
    .map(e => ({ className: e.class!, triggerLevel: parseFloat(e.parValueRatio!), source: "ppm" as const }));
  const icFromPpm: TriggerEntry[] = (constraints.coverageTestEntries ?? [])
    .filter(e => e.class && e.interestCoverageRatio && parseFloat(e.interestCoverageRatio))
    .map(e => ({ className: e.class!, triggerLevel: parseFloat(e.interestCoverageRatio!), source: "ppm" as const }));

  // Per-class merge: prefer compliance trigger for each class, fill gaps from PPM
  const ocRaw = mergeTriggersPerClass(ocFromTests, ocFromPpm, "OC", warnings);
  const icRaw = mergeTriggersPerClass(icFromTests, icFromPpm, "IC", warnings);

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
    return { className: t.className, triggerLevel, rank: resolveRank(t.className), testType: "OC" as const, source: t.source };
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
    return { className: t.className, triggerLevel, rank: resolveRank(t.className), testType: "IC" as const, source: t.source };
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

  // Warn if trustee fee is 0 but the PPM mentions one — "per agreement" means we couldn't extract the rate
  if (trusteeFeeBps === 0 && (constraints.fees ?? []).some(f => {
    const n = (f.name ?? "").toLowerCase();
    return n.includes("trustee") || n.includes("admin");
  })) {
    warnings.push({ field: "fees.trusteeFeeBps", message: "Trustee/admin fee found in PPM but rate is 'per agreement' — set manually from the compliance report fee schedule (typically 1-5 bps).", severity: "warn" });
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
  dealDates?: { maturity?: string | null; reinvestmentPeriodEnd?: string | null; reportDate?: string | null },
  accountBalances?: CloAccountBalance[],
  parValueAdjustments?: CloParValueAdjustment[],
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
    totalPrincipalBalance: pool?.totalPrincipalBalance ?? 0,
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
  // Snap currentDate to the compliance report's payment date so projection periods
  // start from the last known state and align with the deal's payment schedule.
  // Falls back to snapping today to the nearest payment date if no report is available.
  const today = new Date().toISOString().slice(0, 10);
  const firstPayment = constraints.keyDates?.firstPaymentDate ?? null;
  const reportPaymentDate = dealDates?.reportDate ?? null;
  let currentDate = today;
  if (reportPaymentDate && firstPayment) {
    // Snap the report date to the nearest payment date on the deal's schedule
    const fp = new Date(firstPayment);
    const reportD = new Date(reportPaymentDate);
    const cursor = new Date(fp);
    let snapped = cursor.toISOString().slice(0, 10);
    while (cursor <= reportD) {
      snapped = cursor.toISOString().slice(0, 10);
      cursor.setUTCMonth(cursor.getUTCMonth() + 3);
    }
    currentDate = snapped;
  } else if (firstPayment) {
    // No report — snap today to the nearest payment date
    const fp = new Date(firstPayment);
    const now = new Date(today);
    const cursor = new Date(fp);
    while (cursor <= now) {
      currentDate = cursor.toISOString().slice(0, 10);
      cursor.setUTCMonth(cursor.getUTCMonth() + 3);
    }
  }
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

  // Quarters between compliance report date and projection start.
  // Used to adjust recovery timing for pre-existing defaults — if the report flagged
  // a loan as defaulted N quarters ago, the recovery is N quarters closer than a fresh default.
  const reportDate = dealDates?.reportDate ?? null;
  let quartersSinceReport = 0;
  if (reportDate) {
    const reportD = new Date(reportDate);
    const currentD = new Date(currentDate);
    const monthsDiff = (currentD.getFullYear() - reportD.getFullYear()) * 12 + (currentD.getMonth() - reportD.getMonth());
    quartersSinceReport = Math.max(0, Math.floor(monthsDiff / 3));
  }

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
  // Prefer compliance trigger level for the reinvestment OC test when available.
  // The reinvestment OC test is typically at the same level as the most junior OC trigger (Class F).
  if (reinvestmentOcTrigger && ocTriggers.length > 0) {
    const juniorCompliance = [...ocTriggers].filter(t => t.source === "compliance").sort((a, b) => b.rank - a.rank);
    if (juniorCompliance.length > 0 && juniorCompliance[0].rank === reinvestmentOcTrigger.rank) {
      reinvestmentOcTrigger = { ...reinvestmentOcTrigger, triggerLevel: juniorCompliance[0].triggerLevel };
    }
  }

  // --- Loans ---
  const fallbackMaturity = resolvedMaturity;
  const activeHoldings = holdings.filter(h => h.parBalance != null && h.parBalance > 0 && !h.isDefaulted);
  const nonDdtlHoldings = activeHoldings.filter(h => !h.isDelayedDraw);

  const loans: ResolvedLoan[] = activeHoldings.map(h => {
    const isFixed = h.isFixedRate === true;
    const isDdtl = h.isDelayedDraw === true;
    const ratingBucket = mapToRatingBucket(h.moodysRating ?? null, h.spRating ?? null, h.fitchRating ?? null, h.compositeRating ?? null);

    let fixedCouponPct: number | undefined;
    if (isFixed) {
      if (h.allInRate != null) {
        fixedCouponPct = h.allInRate;
      } else if (h.spreadBps != null) {
        fixedCouponPct = h.spreadBps / 100;
        warnings.push({ field: "fixedCouponPct", message: `Fixed-rate loan "${h.obligorName ?? "unknown"}" has no allInRate — using spreadBps (${h.spreadBps}) as coupon proxy (${fixedCouponPct}%).`, severity: "warn" });
      } else {
        fixedCouponPct = wacSpreadBps / 100;
        warnings.push({ field: "fixedCouponPct", message: `Fixed-rate loan "${h.obligorName ?? "unknown"}" has no allInRate or spreadBps — falling back to WAC spread as coupon (${fixedCouponPct}%).`, severity: "warn" });
      }
    }

    let ddtlSpreadBps: number | undefined;
    if (isDdtl) {
      const candidates = nonDdtlHoldings.filter(c => c.obligorName != null && c.obligorName === h.obligorName);
      if (candidates.length > 1) {
        warnings.push({ field: "ddtlSpreadBps", message: `DDTL "${h.obligorName ?? "unknown"}" matched ${candidates.length} parent facilities — using largest par with closest maturity as tiebreaker.`, severity: "warn" });
      }
      if (candidates.length > 0) {
        const ddtlMaturity = h.maturityDate ?? fallbackMaturity;
        const parent = [...candidates].sort((a, b) => {
          const parDiff = (b.parBalance ?? 0) - (a.parBalance ?? 0);
          if (parDiff !== 0) return parDiff;
          const aDist = Math.abs(new Date(a.maturityDate ?? fallbackMaturity).getTime() - new Date(ddtlMaturity).getTime());
          const bDist = Math.abs(new Date(b.maturityDate ?? fallbackMaturity).getTime() - new Date(ddtlMaturity).getTime());
          return aDist - bDist;
        })[0];
        ddtlSpreadBps = parent.spreadBps ?? wacSpreadBps;
      } else {
        ddtlSpreadBps = wacSpreadBps;
        warnings.push({ field: "ddtlSpreadBps", message: `DDTL "${h.obligorName ?? "unknown"}" has no matching parent facility — using WAC spread (${wacSpreadBps} bps).`, severity: "warn" });
      }
    }

    return {
      parBalance: h.parBalance!,
      maturityDate: h.maturityDate ?? fallbackMaturity,
      ratingBucket,
      spreadBps: isFixed ? 0 : (isDdtl ? 0 : (h.spreadBps ?? wacSpreadBps)),
      obligorName: h.obligorName ?? undefined,
      isFixedRate: isFixed || undefined,
      fixedCouponPct,
      isDelayedDraw: isDdtl || undefined,
      ddtlSpreadBps,
    };
  });

  // --- Pre-existing Defaults ---
  // Defaulted holdings are excluded from the loan list (no interest income).
  // For each holding: use market price recovery if available, track unpriced par
  // separately so the engine can apply its model recoveryPct to the remainder.
  const defaultedHoldings = holdings.filter(h => h.isDefaulted && h.parBalance != null && h.parBalance > 0);
  const preExistingDefaultedPar = defaultedHoldings.reduce((s, h) => s + h.parBalance!, 0);
  let preExistingDefaultRecovery = 0; // market-price-based recovery for priced holdings
  let unpricedDefaultedPar = 0; // par of holdings without market price (engine applies recoveryPct)
  for (const h of defaultedHoldings) {
    if (h.currentPrice != null && h.currentPrice > 0) {
      // currentPrice in percentage format (e.g. 31.29 = 31.29% of par).
      // Ambiguity: values in (0, 1) could be 0.5% or 50% — we treat as decimal (50%).
      // True fix requires normalizing at the extraction layer based on source format.
      preExistingDefaultRecovery += h.parBalance! * (h.currentPrice >= 1 ? h.currentPrice / 100 : h.currentPrice);
    } else {
      unpricedDefaultedPar += h.parBalance!;
    }
  }
  // Agency recovery value for OC numerator — the indenture uses the LESSER of available
  // agency recovery rates (e.g. "Lesser of Fitch Collateral Value and S&P Collateral Value").
  const preExistingDefaultOcValue = defaultedHoldings.reduce((s, h) => {
    const rates = [h.recoveryRateMoodys, h.recoveryRateSp, h.recoveryRateFitch]
      .filter((r): r is number => r != null && r > 0);
    if (rates.length > 0) {
      const minRate = Math.min(...rates);
      // Agency rates in percentage format (e.g. 28.5 = 28.5%)
      return s + h.parBalance! * (minRate >= 1 ? minRate / 100 : minRate);
    }
    // No agency rates — fall back to market price
    if (h.currentPrice != null && h.currentPrice > 0) {
      return s + h.parBalance! * (h.currentPrice >= 1 ? h.currentPrice / 100 : h.currentPrice);
    }
    // No data — return 0 so engine uses model recoveryPct
    return s;
  }, 0);

  // --- Principal Account Cash ---
  // Uninvested principal sitting in accounts (counts toward OC numerator).
  // Sum all accounts with type PRINCIPAL or name containing "principal".
  const principalAccountCash = (accountBalances ?? [])
    .filter(a => a.balanceAmount != null && a.balanceAmount > 0 &&
      (a.accountType === "PRINCIPAL" || (a.accountName ?? "").toLowerCase().includes("principal")))
    .reduce((s, a) => s + a.balanceAmount!, 0);

  // --- Discount & Long-Dated Obligation Haircuts ---
  // The trustee's Adjusted CPA deducts par of discount/long-dated obligations and adds back
  // their recovery values. The NET haircut is the OC numerator reduction. Extract from the
  // par value adjustments section (already in DB from compliance report extraction).
  const pvAdj = parValueAdjustments ?? [];
  const discountObligationHaircut = pvAdj
    .filter(a => a.adjustmentType === "DISCOUNT_OBLIGATION_HAIRCUT" && a.netAmount != null)
    .reduce((s, a) => s + Math.abs(a.netAmount!), 0);
  const longDatedObligationHaircut = pvAdj
    .filter(a => a.adjustmentType === "LONG_DATED_HAIRCUT" && a.netAmount != null)
    .reduce((s, a) => s + Math.abs(a.netAmount!), 0);

  // --- Implied OC Adjustment ---
  // Residual between the trustee's Adjusted CPA and the components we can now identify
  // (principal balance + cash - defaulted haircut - discount haircut - long-dated haircut).
  // Captures any remaining trustee adjustments we haven't explicitly modeled.
  // Sanity-checked: if implausibly large (>5% of par) or negative, discard and warn.
  const totalPar = pool?.totalPar ?? 0;
  const totalPrincipalBalance = pool?.totalPrincipalBalance ?? 0;
  let impliedOcAdjustment = 0;
  if (totalPar > 0 && totalPrincipalBalance > 0) {
    const defaultedHaircut = preExistingDefaultedPar - preExistingDefaultOcValue;
    const implied = totalPrincipalBalance + principalAccountCash - defaultedHaircut - discountObligationHaircut - longDatedObligationHaircut - totalPar;
    if (implied < -100) {
      // Only warn if the residual is meaningfully negative (not just floating point noise)
      warnings.push({ field: "impliedOcAdjustment", message: `Adjusted CPA reconciliation has negative residual (${Math.round(implied).toLocaleString()}). Unmodeled trustee adjustments may be inflating the Adjusted CPA. OC adjustment set to 0.`, severity: "info" });
    } else if (implied < 0) {
      // Negligible negative residual (rounding) — reconciliation effectively closes. No warning.
    } else if (implied > totalPar * 0.05) {
      warnings.push({ field: "impliedOcAdjustment", message: `Derived OC adjustment (${Math.round(implied).toLocaleString()}) is >5% of par — likely includes adjustments beyond unfunded revolvers. Capping at 0.`, severity: "warn" });
    } else {
      impliedOcAdjustment = implied;
    }
  }

  const ddtlUnfundedPar = loans
    .filter(l => l.isDelayedDraw)
    .reduce((s, l) => s + l.parBalance, 0);
  if (ddtlUnfundedPar > 0 && impliedOcAdjustment > 0) {
    impliedOcAdjustment = Math.max(0, impliedOcAdjustment - ddtlUnfundedPar);
  }

  // --- Base Rate Floor ---
  // Extracted from interest mechanics section. null = not extracted (use default from CLO_DEFAULTS).
  // Guard against string "null" from loose extraction typing.
  const rawFloor = constraints.interestMechanics?.referenceRateFloorPct;
  const baseRateFloorPct = (typeof rawFloor === "number") ? rawFloor : null;

  // --- Deferred Interest Compounding ---
  // Extracted from interest mechanics section. Defaults to true (standard CLO convention).
  // Guard against string "null" from loose extraction typing.
  let deferredInterestCompounds = true;
  const rawCompounds = constraints.interestMechanics?.deferredInterestCompounds;
  if (typeof rawCompounds === "boolean") {
    deferredInterestCompounds = rawCompounds;
  } else if (tranches.some(t => t.isDeferrable)) {
    warnings.push({ field: "deferredInterestCompounds", message: "Deal has deferrable tranches but no PIK compounding info extracted — assuming deferred interest compounds (standard convention). Set manually if different.", severity: "warn" });
  }

  return {
    resolved: { tranches, poolSummary, ocTriggers, icTriggers, reinvestmentOcTrigger, dates, fees, loans, principalAccountCash, preExistingDefaultedPar, preExistingDefaultRecovery, unpricedDefaultedPar, preExistingDefaultOcValue, discountObligationHaircut, longDatedObligationHaircut, impliedOcAdjustment, quartersSinceReport, ddtlUnfundedPar, deferredInterestCompounds, baseRateFloorPct },
    warnings,
  };
}
