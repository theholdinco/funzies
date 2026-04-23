import type { ExtractedConstraints, CloPoolSummary, CloComplianceTest, CloTranche, CloTrancheSnapshot, CloHolding, CloAccountBalance, CloParValueAdjustment } from "./types";
import type { ResolvedDealData, ResolvedTranche, ResolvedPool, ResolvedTrigger, ResolvedReinvestmentOcTrigger, ResolvedDates, ResolvedFees, ResolvedLoan, ResolvedComplianceTest, ResolvedEodTest, ResolvedMetadata, ResolutionWarning } from "./resolver-types";
import { parseSpreadToBps, normalizeWacSpread } from "./ingestion-gate";
import { mapToRatingBucket, moodysWarfFactor } from "./rating-mapping";
import { isRatingSentinel } from "./sdf/csv-utils";
import { CLO_DEFAULTS } from "./defaults";

/** Defensive sentinel stripper for rating strings already in the DB. The SDF
 *  parser now filters these at ingest (see trimRating), but pre-fix rows can
 *  still carry "***", "NR", "--", etc. Treat any sentinel as missing. */
function cleanRating(r: string | null | undefined): string | null {
  if (r == null) return null;
  return isRatingSentinel(r) ? null : r;
}

/** Remove keys with null/undefined values to avoid JSON bloat. */
function stripNulls<T extends Record<string, unknown>>(obj: T): T {
  const result = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (v != null) result[k] = v;
  }
  return result as T;
}

function addQuartersForResolver(dateIso: string, quarters: number): string {
  const d = new Date(dateIso);
  const origDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + quarters * 3);
  // Clamp to last day of target month if day rolled forward (e.g. Jan 31 + 3mo → Apr 30)
  if (d.getUTCDate() !== origDay) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** Normalize a concentration test / portfolio profile bucket name for name-based joins.
 *  Strips leading "(a)" / "(p)(i)" prefixes, collapses punctuation, lowercases. */
function normalizeConcName(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/^\s*\([a-z0-9]+\)(?:\([iv]+\))?\s*/i, "") // strip lettered prefix
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normClass(s: string): string {
  const lower = String(s ?? "").toLowerCase().trim();
  if (!lower) return "";
  // Subordinated / equity / income-note variants all collapse to "sub"
  if (lower.includes("subordinated") || lower.startsWith("sub ") || lower === "sub"
      || lower.includes("equity") || lower.includes("income note") || lower.includes("income-note")) {
    return "sub";
  }
  // Strip "class " prefix and trailing "-notes"/"notes" suffix
  const stripped = lower.replace(/^class(es)?\s+/i, "").replace(/[-\s]+notes?$/i, "").trim();
  // Take only the first class-letter token (e.g. "a", "b-1", "b2") —
  // collapses "A" and "A Senior Secured FRN due 2032" to the same key.
  const match = stripped.match(/^([a-z](?:[-\s]?[0-9]+)?)\b/);
  return match ? match[1].replace(/\s+/g, "-") : stripped;
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
    if (!e.class) continue; // skip malformed entries lacking a class identifier
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
  const entries = (constraints.capitalStructure ?? []).filter(e => e.class); // skip class-less entries
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
    const name = (e.class ?? "").replace(/^class\s+/i, "").trim().toLowerCase();
    if (/^x$/i.test(name)) return 0;
    if (e.isSubordinated || name.includes("sub") || name.includes("equity") || name.includes("income")) return 100;
    // Single letter classes (A=1, B=2, ..., F=6) — handles "A-1", "A-2" etc.
    const letter = name.match(/^([a-z])/)?.[1];
    if (letter) return letter.charCodeAt(0) - 96; // a=1, b=2, ...
    return 50; // unknown → middle
  };
  const sortedEntries = Array.from(byClass.values()).sort((a, b) => classOrder(a) - classOrder(b));

  return sortedEntries.map((e, idx) => {
    const className = e.class ?? "";
    const isSub = e.isSubordinated ?? className.toLowerCase().includes("sub");
    const isFloating = e.rateType
      ? e.rateType.toLowerCase().includes("float")
      : (e.spread?.toLowerCase().includes("euribor") || e.spread?.toLowerCase().includes("sofr") || false);
    const key = normClass(className);
    const amortPerPeriod = ppmAmortByClass.get(key) ?? null;
    const hasAmort = amortPerPeriod != null;
    const spreadBps = parseSpreadToBps(e.spreadBps, e.spread) ?? 0;

    if (spreadBps === 0 && !isSub) {
      warnings.push({
        field: `${className}.spreadBps`,
        message: `No spread found for ${className} in PPM constraints`,
        severity: "error",
      });
    }

    return {
      className,
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
  eventOfDefaultConstraint: { required_ratio_pct?: number; source_pages?: number[] } | null | undefined,
): { oc: ResolvedTrigger[]; ic: ResolvedTrigger[]; eventOfDefaultTest: ResolvedEodTest | null } {
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

  // From PPM constraints (fallback). Real CLO PV triggers are >=103.24% for the
  // most junior class (Class F is typically 103-106%). The 102.5% value the
  // PPM extractor sometimes returns labeled as "Class A" is actually the
  // Event of Default test (§10(a)(iv)) misassigned to a class column. Filter
  // out implausibly-low (<103%) class triggers so they don't poison the
  // ocTriggers list AND the reinvestmentOcTrigger fallback.
  const ocFromPpm: TriggerEntry[] = (constraints.coverageTestEntries ?? [])
    .filter(e => e.class && e.parValueRatio && parseFloat(e.parValueRatio))
    .filter(e => {
      const v = parseFloat(e.parValueRatio!);
      if (v < 103 && v > 1) {
        warnings.push({
          field: `coverageTest.${e.class}`,
          message: `PPM coverage test for ${e.class} has parValueRatio ${v}% — implausibly low for a class PV trigger (minimum is ~103% for Class F). Likely the EoD threshold (102.5%) misassigned to a class column. Ignoring.`,
          severity: "warn",
        });
        return false;
      }
      return true;
    })
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

  // B1: Extract Event of Default Par Value Test (PPM Condition 10(a)(iv)) as
  // a distinct artifact, not a class-level OC trigger. The compliance test is
  // emitted with testClass "EOD" → rank 99 by resolveRank fallback. Filter
  // that entry out of the OC list and carry it on its own field with spec
  // metadata from raw.constraints when available.
  const eodEntries = oc.filter((t) => normClass(t.className) === "eod");
  const ocWithoutEod = oc.filter((t) => normClass(t.className) !== "eod");
  let eventOfDefaultTest: ResolvedEodTest | null = null;
  const constraintTrigger = eventOfDefaultConstraint?.required_ratio_pct;
  if (eodEntries.length > 0) {
    // Prefer compliance-reported level; fall back to PPM constraint if somehow missing.
    const eodLevel = eodEntries[0].triggerLevel;
    const sourcePage = eventOfDefaultConstraint?.source_pages?.[0] ?? null;
    eventOfDefaultTest = { triggerLevel: eodLevel, sourcePage };
    if (constraintTrigger != null && Math.abs(constraintTrigger - eodLevel) > 0.01) {
      warnings.push({
        field: "eventOfDefaultTest",
        message: `EoD trigger mismatch: compliance reports ${eodLevel}%, PPM constraint reports ${constraintTrigger}%. Using compliance value.`,
        severity: "warn",
      });
    }
  } else if (constraintTrigger != null) {
    // No compliance row (older reports), fall back to PPM constraint.
    eventOfDefaultTest = {
      triggerLevel: constraintTrigger,
      sourcePage: eventOfDefaultConstraint?.source_pages?.[0] ?? null,
    };
  }

  return { oc: ocWithoutEod, ic, eventOfDefaultTest };
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

  // Sanity: every CLO has a Senior Collateral Management Fee (~0.10-0.20% p.a.)
  // and a Subordinated CMF (~0.30-0.50% p.a.). If either is exactly 0, the PPM
  // fees extraction likely regressed (LLM dropped the row or returned rate=null).
  // Downstream waterfall math with zero mgmt fees dramatically overstates Sub
  // Note distributions — warn loudly so the user catches it.
  const feeNames = (constraints.fees ?? []).map(f => (f.name ?? "").toLowerCase());
  const hasSeniorMgmtFeeName = feeNames.some(n => n.includes("senior") && (n.includes("mgmt") || n.includes("management")));
  const hasSubMgmtFeeName = feeNames.some(n => n.includes("sub") && (n.includes("mgmt") || n.includes("management")));
  if (seniorFeePct === 0) {
    warnings.push({
      field: "fees.seniorFeePct",
      message: hasSeniorMgmtFeeName
        ? `Senior Management Fee entry found but rate extracted as 0 — likely a PPM extraction regression (LLM returned rate=null or "per_agreement"). Check raw.constraints.fees. Typical Senior CMF is 0.10-0.20% p.a. — set manually.`
        : `No Senior Management Fee found in extracted constraints.fees[]. PPM extraction may have dropped the row. Typical Senior CMF is 0.10-0.20% p.a. — set manually.`,
      severity: "error",
    });
  }
  if (subFeePct === 0) {
    warnings.push({
      field: "fees.subFeePct",
      message: hasSubMgmtFeeName
        ? `Subordinated Management Fee entry found but rate extracted as 0 — likely a PPM extraction regression. Typical Sub CMF is 0.30-0.50% p.a. — set manually.`
        : `No Subordinated Management Fee found in extracted constraints.fees[]. Typical Sub CMF is 0.30-0.50% p.a. — set manually.`,
      severity: "error",
    });
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

  // Derive fallbacks from holdings when compliance_summary / CQ tests didn't populate.
  // Numeric zero is treated as "unset" for counts + WARF so the fallbacks kick in.
  const uniqueObligors = new Set(holdings.map(h => (h.obligorName ?? "").toLowerCase().trim()).filter(s => s.length > 0));
  const numberOfObligorsDerived = uniqueObligors.size;
  const numberOfObligors = (pool?.numberOfObligors != null && pool.numberOfObligors > 0)
    ? pool.numberOfObligors
    : numberOfObligorsDerived;

  // Derive composition percentages from concentrations[] when the poolSummary
  // columns (pctFixedRate, pctCovLite, etc.) are null. concentrations.actualValue
  // is a decimal fraction (0.0742 = 7.42%); we emit percentage values.
  const concentrationsList = (complianceData?.concentrations ?? []) as Array<Record<string, unknown>>;
  const concByName = new Map<string, number>();
  for (const c of concentrationsList) {
    const name = normalizeConcName(String(c.bucketName ?? c.concentrationType ?? ""));
    if (!name) continue;
    const actualPct = typeof c.actualPct === "number" ? c.actualPct : null;
    const raw = actualPct ?? (typeof c.actualValue === "number" ? c.actualValue : null);
    if (raw == null) continue;
    // Concentrations.actualValue is always a decimal fraction (1.0 = 100%,
    // 0.0742 = 7.42%). Multiply by 100 for fractions ≤ 1.5 (tolerance for
    // rounding); values above that are assumed to already be percentages.
    const pct = raw >= 0 && raw <= 1.5 ? raw * 100 : raw;
    if (!concByName.has(name)) concByName.set(name, pct);
  }
  const pickConc = (...names: string[]): number | null => {
    for (const n of names) {
      const v = concByName.get(n);
      if (v != null) return v;
    }
    return null;
  };
  /** Round to 4 decimal places to tame float artifacts (0.0093 × 100 =
   *  0.9299999999999999). Null passes through. */
  const round4 = (v: number | null): number | null =>
    v == null ? null : Math.round(v * 1e4) / 1e4;
  // Prefer poolSummary.pct* when populated, else derive from concentrations.
  const num = (x: unknown): number | null => (typeof x === "number" && !isNaN(x) ? x : null);
  const derivedPctFixedRate     = round4(num(pool?.pctFixedRate) ?? pickConc("fixed rate cdos", "fixed rate collateral debt obligations"));
  const derivedPctCovLite       = round4(num(pool?.pctCovLite) ?? pickConc("cov lite loans", "covenant lite loans"));
  // pctPik isn't on CloPoolSummary — concentrations-only.
  const derivedPctPik           = round4(pickConc("pik securities", "pik obligations"));
  const moodysCaa = pickConc("moody s caa obligations");
  const fitchCcc = pickConc("fitch ccc obligations");
  // CCC bucket: OC cares about the worse read — take the higher of the two agencies.
  const derivedPctCccAndBelow   = round4(num(pool?.pctCccAndBelow)
    ?? (moodysCaa != null || fitchCcc != null ? Math.max(moodysCaa ?? 0, fitchCcc ?? 0) : null));
  const derivedPctBonds         = round4(num(pool?.pctBonds) ?? pickConc("sr secured bonds hy bonds mezz"));
  const derivedPctSeniorSecured = round4(num(pool?.pctSeniorSecured) ?? pickConc("senior secured obligations"));
  // pctSecondLien intentionally NOT mapped from "Unsecured / HY / Mezz / 2nd Lien"
  // — that's a 4-category combined bucket; using it as second-lien only would
  // overclaim on deals with any HY/mezz. Prefer pool?.pctSecondLien if the
  // source provides it directly; otherwise leave null.
  const derivedPctSecondLien    = round4(num(pool?.pctSecondLien));
  const derivedPctCurrentPay    = round4(num(pool?.pctCurrentPay) ?? pickConc("current pay obligations"));

  const poolSummary: ResolvedPool = {
    totalPar: pool?.totalPar ?? 0,
    totalPrincipalBalance: pool?.totalPrincipalBalance ?? 0,
    wacSpreadBps,
    warf: pool?.warf ?? 0,
    walYears: pool?.walYears ?? 0,
    diversityScore: pool?.diversityScore ?? 0,
    numberOfObligors,
    numberOfAssets: num(pool?.numberOfAssets),
    totalMarketValue: num(pool?.totalMarketValue),
    waRecoveryRate: num(pool?.waRecoveryRate),
    pctFixedRate: derivedPctFixedRate,
    pctCovLite: derivedPctCovLite,
    pctPik: derivedPctPik,
    pctCccAndBelow: derivedPctCccAndBelow,
    pctBonds: derivedPctBonds,
    pctSeniorSecured: derivedPctSeniorSecured,
    pctSecondLien: derivedPctSecondLien,
    pctCurrentPay: derivedPctCurrentPay,
  };

  if (poolSummary.totalPar === 0) {
    warnings.push({ field: "poolSummary.totalPar", message: "Total par is 0 — no pool summary data", severity: "error" });
  }

  // --- Triggers ---
  const eodConstraint =
    (constraints as unknown as { eventOfDefaultParValueTest?: { required_ratio_pct?: number; source_pages?: number[] } | null })
      .eventOfDefaultParValueTest ?? null;
  const { oc: ocTriggers, ic: icTriggers, eventOfDefaultTest } = resolveTriggers(
    complianceData?.complianceTests ?? [],
    constraints,
    tranches,
    warnings,
    eodConstraint,
  );

  // --- Dates ---
  // currentDate is the projection start. When the compliance report provides
  // a determination date (dealDates.reportDate), use it directly — it's the
  // authoritative "as of" date for every number in the report. Snapping to
  // the previous quarterly payment date (which the prior implementation did)
  // silently backdated currentDate by up to 3 months (e.g. a 2026-04-01
  // determination date was snapping to 2026-01-15, misaligning every
  // downstream projection period). Only fall back to the payment-schedule
  // snap when we don't have a report date.
  const today = new Date().toISOString().slice(0, 10);
  const firstPayment = constraints.keyDates?.firstPaymentDate ?? null;
  const reportPaymentDate = dealDates?.reportDate ?? null;
  let currentDate = today;
  if (reportPaymentDate) {
    currentDate = reportPaymentDate;
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
  // Priority: (1) compliance test explicitly named "Reinvestment OC" with
  // testType INTEREST_DIVERSION — authoritative; (2) PPM's reinvestmentOcTest
  // gated to >=103% (PPM extractor sometimes conflates the §10(a)(iv) EoD
  // threshold of 102.5% with the Reinvestment OC trigger); (3) most junior
  // class OC trigger as last resort.
  let reinvestmentOcTrigger: ResolvedReinvestmentOcTrigger | null = null;
  const reinvOcRaw = constraints.reinvestmentOcTest;

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

  const mostJuniorOcRank = ocTriggers.length > 0
    ? [...ocTriggers].sort((a, b) => b.rank - a.rank)[0].rank
    : 99;

  const complianceReinvOc = (complianceData?.complianceTests ?? []).find(t => {
    const name = (t.testName ?? "").toLowerCase();
    return t.triggerLevel != null
      && t.triggerLevel > 0
      && name.includes("reinvestment")
      && (t.testType === "INTEREST_DIVERSION" || name.includes("oc") || name.includes("overcollateral"));
  });
  if (complianceReinvOc?.triggerLevel != null) {
    reinvestmentOcTrigger = {
      triggerLevel: complianceReinvOc.triggerLevel,
      rank: mostJuniorOcRank,
      diversionPct,
    };
  }

  if (!reinvestmentOcTrigger && reinvOcRaw?.trigger) {
    let triggerLevel = parseFloat(reinvOcRaw.trigger);
    if (!isNaN(triggerLevel) && triggerLevel > 0) {
      if (triggerLevel < 10) {
        warnings.push({ field: "reinvestmentOcTrigger", message: `Reinvestment OC trigger ${triggerLevel} looks like a ratio, converting to ${triggerLevel * 100}%`, severity: "warn" });
        triggerLevel = triggerLevel * 100;
      }
      if (triggerLevel < 103) {
        warnings.push({
          field: "reinvestmentOcTrigger",
          message: `PPM reinvestmentOcTest.trigger is ${triggerLevel}% — implausibly low (typical range 103-106%). Likely the §10(a)(iv) EoD threshold (102.5%) misassigned. Ignoring PPM value.`,
          severity: "warn",
        });
      } else {
        if (triggerLevel > 200) {
          warnings.push({ field: "reinvestmentOcTrigger", message: `Reinvestment OC trigger ${triggerLevel}% seems unusually high`, severity: "warn" });
        }
        reinvestmentOcTrigger = { triggerLevel, rank: mostJuniorOcRank, diversionPct };
      }
    }
  }

  if (!reinvestmentOcTrigger && ocTriggers.length > 0) {
    const sortedOc = [...ocTriggers].filter(t => t.triggerLevel >= 103).sort((a, b) => b.rank - a.rank);
    if (sortedOc.length > 0) {
      reinvestmentOcTrigger = { triggerLevel: sortedOc[0].triggerLevel, rank: sortedOc[0].rank, diversionPct };
    }
  }

  // --- Loans ---
  const fallbackMaturity = resolvedMaturity;
  // Bonds carry parBalance=0 by SDF convention (the "funded balance" concept
  // doesn't apply — their outstanding par lives in principalBalance). Use the
  // higher of the two so bonds aren't silently dropped. The SDF parser now
  // handles this at ingestion time; this fallback protects already-ingested
  // rows and any other source that mirrors the SDF convention.
  const holdingPar = (h: typeof holdings[number]): number =>
    (h.parBalance && h.parBalance > 0) ? h.parBalance
    : (h.principalBalance && h.principalBalance > 0) ? h.principalBalance
    : 0;
  const activeHoldings = holdings.filter(h => holdingPar(h) > 0 && !h.isDefaulted);
  const nonDdtlHoldings = activeHoldings.filter(h => !h.isDelayedDraw);

  const loans: ResolvedLoan[] = activeHoldings.map(h => {
    const isFixed = h.isFixedRate === true;
    const isDdtl = h.isDelayedDraw === true;
    // Clean rating sentinels defensively — pre-fix rows in the DB still carry
    // "***" / "NR" / "--" etc. from the SDF; trimRating handles new ingests.
    const moodys = cleanRating(h.moodysRating);
    const sp = cleanRating(h.spRating);
    const fitch = cleanRating(h.fitchRating);
    const moodysFinal = cleanRating(h.moodysRatingFinal);
    const spFinal = cleanRating(h.spRatingFinal);
    const fitchFinal = cleanRating(h.fitchRatingFinal);
    const moodysDp = cleanRating(h.moodysDpRating);
    const ratingBucket = mapToRatingBucket(moodys, sp, fitch, cleanRating(h.compositeRating));

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

    const creditWatch = [
      h.moodysIssuerWatch,
      h.moodysSecurityWatch,
      h.spIssuerWatch,
      h.spSecurityWatch,
    ].some(w => w && w.toLowerCase().includes('negative')) || undefined;

    // Moody's uses its DP (Default Probability) rating for WARF when available,
    // falling back to the final/published rating, then the raw Moody's rating.
    const warfFactor =
      moodysWarfFactor(moodysDp)
      ?? moodysWarfFactor(moodysFinal)
      ?? moodysWarfFactor(moodys)
      ?? undefined;

    return stripNulls({
      parBalance: holdingPar(h),
      maturityDate: h.maturityDate ?? fallbackMaturity,
      ratingBucket,
      spreadBps: isFixed ? 0 : (isDdtl ? 0 : (h.spreadBps ?? wacSpreadBps)),
      obligorName: h.obligorName ?? undefined,
      isFixedRate: isFixed || undefined,
      fixedCouponPct,
      isDelayedDraw: isDdtl || undefined,
      ddtlSpreadBps,
      // Full ratings (sentinel-cleaned)
      moodysRating: moodys ?? undefined,
      spRating: sp ?? undefined,
      fitchRating: fitch ?? undefined,
      // Derived ratings (sentinel-cleaned)
      moodysRatingFinal: moodysFinal ?? undefined,
      spRatingFinal: spFinal ?? undefined,
      fitchRatingFinal: fitchFinal ?? undefined,
      // Market data
      currentPrice: h.currentPrice ?? undefined,
      marketValue: h.marketValue ?? undefined,
      // Structural
      lienType: h.lienType ?? undefined,
      isDefaulted: h.isDefaulted ?? undefined,
      defaultDate: h.defaultDate ?? undefined,
      floorRate: h.floorRate ?? undefined,
      pikAmount: h.pikAmount ?? undefined,
      creditWatch: creditWatch || undefined,
      warfFactor,
    });
  });

  // --- Pre-existing Defaults ---
  // Defaulted holdings are excluded from the loan list (no interest income).
  // For each holding: use market price recovery if available, track unpriced par
  // separately so the engine can apply its model recoveryPct to the remainder.
  const defaultedHoldings = holdings.filter(h => h.isDefaulted && holdingPar(h) > 0);
  const preExistingDefaultedPar = defaultedHoldings.reduce((s, h) => s + holdingPar(h), 0);
  let preExistingDefaultRecovery = 0; // market-price-based recovery for priced holdings
  let unpricedDefaultedPar = 0; // par of holdings without market price (engine applies recoveryPct)
  for (const h of defaultedHoldings) {
    const par = holdingPar(h);
    if (h.currentPrice != null && h.currentPrice > 0) {
      // currentPrice in percentage format (e.g. 31.29 = 31.29% of par).
      // Ambiguity: values in (0, 1) could be 0.5% or 50% — we treat as decimal (50%).
      // True fix requires normalizing at the extraction layer based on source format.
      preExistingDefaultRecovery += par * (h.currentPrice >= 1 ? h.currentPrice / 100 : h.currentPrice);
    } else {
      unpricedDefaultedPar += par;
    }
  }
  // Agency recovery value for OC numerator — the indenture uses the LESSER of available
  // agency recovery rates (e.g. "Lesser of Fitch Collateral Value and S&P Collateral Value").
  const preExistingDefaultOcValue = defaultedHoldings.reduce((s, h) => {
    const par = holdingPar(h);
    const rates = [h.recoveryRateMoodys, h.recoveryRateSp, h.recoveryRateFitch]
      .filter((r): r is number => r != null && r > 0);
    if (rates.length > 0) {
      const minRate = Math.min(...rates);
      // Agency rates in percentage format (e.g. 28.5 = 28.5%)
      return s + par * (minRate >= 1 ? minRate / 100 : minRate);
    }
    // No agency rates — fall back to market price
    if (h.currentPrice != null && h.currentPrice > 0) {
      return s + par * (h.currentPrice >= 1 ? h.currentPrice / 100 : h.currentPrice);
    }
    // No data — return 0 so engine uses model recoveryPct
    return s;
  }, 0);

  // --- Principal Account Cash ---
  // Uninvested principal sitting in the Principal Account. Counts toward the
  // OC numerator per PPM 10(a)(iv) — SIGNED: credits positive, overdrafts
  // negative. Euro XV Q1 fixture carries a −€1,817,413 overdraft which the
  // trustee correctly deducts from the numerator (158.52% tie-out). A
  // positive-only filter under-reports in exactly this case.
  //
  // Name match also covers the "Principle" typo variant (some ingest paths
  // produce it) without requiring data cleanup upstream.
  const principalAccountCash = (accountBalances ?? [])
    .filter((a) => {
      if (a.balanceAmount == null) return false;
      if (a.accountType === "PRINCIPAL") return true;
      const name = (a.accountName ?? "").toLowerCase();
      return name.includes("principal") || name.includes("principle");
    })
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

  // --- Quality & Concentration Tests ---
  // Quality tests (WARF/WAL/WAS/diversity/recovery) come from clo_compliance_tests
  // (populated by §6 Collateral Quality Tests section extraction).
  //
  // Concentration tests (63 portfolio-profile buckets from §7) live in their own
  // table clo_concentrations, NOT in compliance_tests. The resolver had been
  // filtering compliance_tests for testType=CONCENTRATION which only ever
  // surfaced stray rows — the real 63 buckets were invisible. Surface them
  // from complianceData.concentrations[] directly.
  const allComplianceTests = complianceData?.complianceTests ?? [];
  const qualityTestTypes = new Set(['WARF', 'WAL', 'WAS', 'DIVERSITY', 'RECOVERY']);

  const qualityTests: ResolvedComplianceTest[] = allComplianceTests
    .filter(t => t.testType && qualityTestTypes.has(t.testType))
    .map(t => ({
      testName: t.testName,
      testClass: t.testClass,
      actualValue: t.actualValue,
      triggerLevel: t.triggerLevel,
      cushion: round4(t.cushionPct),
      isPassing: t.isPassing,
    }));

  // Concentration tests come from three sources of varying completeness:
  //   (1) clo_concentrations — 63 buckets with bucketName + actualValue (no limit)
  //   (2) clo_compliance_tests (testType=CONCENTRATION) — ~36 rows with both
  //       actual and trigger, but only covers lettered sections (a)–(dd)
  //   (3) PPM portfolioProfileTests — constraint limits by bucket name
  //
  // The concentrationType letter ("a", "b", "p(i)") in source (1) matches the
  // "(a) ...", "(b) ...", "(p)(i) ..." prefix in source (2), giving a clean
  // join for the lettered buckets. Per-rating Fitch/Moody's buckets all use
  // concentrationType="z" and have no simple PPM limit (matrix-governed).
  const concentrationsRaw = (complianceData?.concentrations ?? []) as Array<Record<string, unknown>>;
  const concTestsByLetter = new Map<string, CloComplianceTest>();
  for (const t of allComplianceTests) {
    if (t.testType !== "CONCENTRATION") continue;
    // Match leading "(a)", "(p)(i)", "(dd)" patterns
    const m = (t.testName ?? "").match(/^\s*\(([a-z]+)\)(?:\(([iv]+)\))?/i);
    if (!m) continue;
    const letter = m[1].toLowerCase();
    const roman = (m[2] ?? "").toLowerCase();
    const key = roman ? `${letter}(${roman})` : letter;
    concTestsByLetter.set(key, t);
  }

  const ppmProfile = constraints.portfolioProfileTests ?? {};
  const ppmByKey = new Map<string, { max: number | null; min: number | null }>();
  for (const [name, limits] of Object.entries(ppmProfile)) {
    const max = parseFloat((limits as { max?: string | null }).max ?? "");
    const min = parseFloat((limits as { min?: string | null }).min ?? "");
    ppmByKey.set(normalizeConcName(name), {
      max: isNaN(max) ? null : max,
      min: isNaN(min) ? null : min,
    });
  }

  const concentrationTests: ResolvedComplianceTest[] = concentrationsRaw.map(c => {
    const bucketName = (c.bucketName ?? c.concentrationType ?? "") as string;
    const concType = (c.concentrationType ?? "") as string;

    // Prefer compliance test (has both actual + trigger + passing flag)
    const ct = concTestsByLetter.get(concType.toLowerCase());
    if (ct) {
      return {
        testName: bucketName || ct.testName,
        testClass: null,
        actualValue: ct.actualValue,
        triggerLevel: ct.triggerLevel,
        cushion: round4(ct.cushionPct ?? (ct.triggerLevel != null && ct.actualValue != null ? ct.triggerLevel - ct.actualValue : null)),
        isPassing: ct.isPassing,
      };
    }

    // Fall back to concentrations row + PPM limit join by normalized name
    const actualPct = typeof c.actualPct === "number" ? c.actualPct : null;
    const rawActual = actualPct ?? (typeof c.actualValue === "number" ? c.actualValue : null);
    // concentrations.actualValue is a decimal ratio (0.0692 = 6.92%). PPM limits
    // are percentages (7.5 = 7.5%). Normalize actual to percentage for cushion math.
    const actualValue = rawActual != null && rawActual > 0 && rawActual < 1 ? rawActual * 100 : rawActual;

    const ppmLimit = ppmByKey.get(normalizeConcName(bucketName));
    const limitPct = typeof c.limitPct === "number" ? c.limitPct : null;
    const limitValue = typeof c.limitValue === "number" ? c.limitValue : null;
    const triggerLevel = limitPct ?? limitValue ?? ppmLimit?.max ?? ppmLimit?.min ?? null;

    return {
      testName: bucketName,
      testClass: null,
      actualValue: round4(actualValue),
      triggerLevel,
      cushion: round4((triggerLevel != null && actualValue != null) ? triggerLevel - actualValue : null),
      isPassing: typeof c.isPassing === "boolean" ? c.isPassing : null,
    };
  });

  // --- Data Source Metadata ---
  // Per-row data_source tags are a single literal "sdf" today, which is too coarse
  // to answer "which SDF files were ingested?". Infer the answer from the shape of
  // data the resolver can see: each SDF file populates a distinctive surface.
  // Note: transactions and accruals are not passed to the resolver — the caller
  // (ContextEditor) can merge those in separately if needed.
  const rowTags = new Set<string>();
  for (const h of holdings) { if (h.dataSource) rowTags.add(h.dataSource); }
  for (const t of allComplianceTests) { if (t.dataSource) rowTags.add(t.dataSource); }
  for (const s of trancheSnapshots) { if (s.dataSource) rowTags.add(s.dataSource); }
  for (const a of accountBalances ?? []) { if (a.dataSource) rowTags.add(a.dataSource); }

  const sdfFilesIngested: string[] = [];
  if (trancheSnapshots.length > 0) sdfFilesIngested.push("sdf_notes");
  if (holdings.length > 0) sdfFilesIngested.push("sdf_collateral");
  // Asset Level enriches holdings with fields the Collateral File doesn't carry
  // (moodys_dp_rating, watchlist flags, derived ratings). Presence of any enrichment
  // field is a reliable fingerprint that Asset Level was ingested.
  if (holdings.some(h => h.moodysRatingFinal || h.moodysDpRating || h.moodysIssuerWatch || h.moodysSecurityWatch)) {
    sdfFilesIngested.push("sdf_asset_level");
  }
  if (allComplianceTests.length > 0) sdfFilesIngested.push("sdf_test_results");
  if ((accountBalances ?? []).length > 0) sdfFilesIngested.push("sdf_accounts");

  // PPM ingest was invisible to the previous detection because constraints don't
  // carry a per-row data_source. Detect presence by checking the structural shape.
  const pdfExtracted: string[] = [];
  const hasPpm =
    (constraints.capitalStructure ?? []).length > 0
    || (constraints.fees ?? []).length > 0
    || !!constraints.keyDates?.maturityDate
    || !!constraints.dealIdentity?.dealName
    || !!constraints.interestMechanics;
  if (hasPpm) pdfExtracted.push("ppm");

  // Carry any non-"sdf" row tags through. Some upserts produce composite tags
  // like "sdf+intex_past_cashflows" when a later ingest appends to an existing
  // snapshot — split on "+" so each source ends up in the right bucket rather
  // than emitting the literal composite string.
  for (const tag of rowTags) {
    if (!tag || tag === "sdf") continue;
    for (const part of tag.split("+").map(s => s.trim()).filter(Boolean)) {
      if (part === "sdf") continue; // already covered by shape detection
      if (part.startsWith("sdf")) {
        if (!sdfFilesIngested.includes(part)) sdfFilesIngested.push(part);
      } else if (part.startsWith("pdf") || part === "ppm") {
        if (!pdfExtracted.includes(part)) pdfExtracted.push(part);
      } else if (part.startsWith("intex")) {
        // Intex backfill is a historical-cashflow source. Not PDF, not SDF CSV.
        // Record in pdfExtracted as the closest non-sdf bucket; downstream
        // consumers that want to distinguish can read the full tag.
        if (!pdfExtracted.includes(part)) pdfExtracted.push(part);
      }
    }
  }

  let dataSource: ResolvedMetadata["dataSource"] = null;
  const hasSdf = sdfFilesIngested.length > 0;
  const hasPdf = pdfExtracted.length > 0;
  if (hasSdf && hasPdf) dataSource = "mixed";
  else if (hasSdf) dataSource = "sdf";
  else if (hasPdf) dataSource = "pdf";

  const metadata: ResolvedMetadata = {
    reportDate: dealDates?.reportDate ?? null,
    dataSource,
    sdfFilesIngested,
    pdfExtracted,
  };

  // --- Diagnostic warnings ---
  // (a) Duplicate holdings rows from the SDF Collateral File. Two scales of
  // duplication matter to consumers:
  //   - strict (obligor, facilityCode, parBalance) identical clusters:
  //     trustee sometimes emits the same lot multiple times
  //   - aggregated (obligor, facilityCode) pairs: purchase-lot fragmentation —
  //     same facility bought across multiple tranches at different par sizes
  // Consumers rendering a per-facility view (memo, UI) care about the
  // aggregated number, which is typically much larger. Pool totals already
  // include both kinds, so we never dedup at ingest (would break the SDF
  // reconciliation); surface both counts so consumers know what to collapse.
  {
    const totalWithKeys = holdings.filter(h => h.obligorName && h.facilityCode && h.parBalance).length;
    const strictCounts = new Map<string, number>();
    const pairCounts = new Map<string, number>();
    for (const h of holdings) {
      if (!h.obligorName || !h.facilityCode || !h.parBalance) continue;
      const strictKey = `${h.obligorName}|${h.facilityCode}|${h.parBalance}`;
      strictCounts.set(strictKey, (strictCounts.get(strictKey) ?? 0) + 1);
      const pairKey = `${h.obligorName}|${h.facilityCode}`;
      pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
    }
    let strictClusters = 0;
    let strictRows = 0;
    for (const n of strictCounts.values()) if (n > 1) { strictClusters++; strictRows += n; }
    const uniquePairs = pairCounts.size;
    const pairDelta = totalWithKeys - uniquePairs;
    if (strictClusters > 0 || pairDelta > 0) {
      warnings.push({
        field: "holdings.duplicateClusters",
        message: `${totalWithKeys} raw holdings collapse to ${uniquePairs} unique (obligor, facilityCode) pairs — ${pairDelta} rows are purchase-lot fragments. Of those, ${strictRows} row(s) in ${strictClusters} cluster(s) are identical on (obligor, facilityCode, parBalance). Pool totals include all rows; per-facility consumers should aggregate by (obligorName, facilityCode) and sum par.`,
        severity: "info",
      });
    }
  }

  // (b) Compliance tests with an actual value but no trigger AND isPassing is
  // not explicitly true. Without a trigger, downstream consumers that filter
  // on trigger != null will silently drop them — hiding the WAS-excl-floor
  // and Frequency Switch tests that the PPM expects but the SDF leaves
  // uncompleted. "Not true" catches both explicit-fail and "Not Calculated".
  {
    const uncomputed = allComplianceTests.filter(t =>
      t.triggerLevel == null
      && t.actualValue != null
      && t.isPassing !== true
    );
    if (uncomputed.length > 0) {
      const names = uncomputed.map(t => t.testName).filter(Boolean).slice(0, 5).join("; ");
      warnings.push({
        field: "complianceTests.uncomputedTests",
        message: `${uncomputed.length} test(s) have an actual value but no trigger and are not marked passing — consumers filtering on triggerLevel != null will hide them. Examples: ${names}`,
        severity: "warn",
      });
    }
  }

  // (c) Join-vocabulary drift guard. The concentration-trigger join relies on
  // "(a)"..."(dd)" lettered prefixes in compliance test names. If the SDF ever
  // changes that convention (or we ingest a different trustee's variant),
  // fall loud here rather than silently producing zero matches.
  {
    const concCount = allComplianceTests.filter(t => t.testType === "CONCENTRATION").length;
    const matchedLetters = concTestsByLetter.size;
    if (concCount >= 10 && matchedLetters < 20) {
      const samples = allComplianceTests
        .filter(t => t.testType === "CONCENTRATION")
        .slice(0, 3)
        .map(t => t.testName)
        .join("; ");
      warnings.push({
        field: "concentrationJoin.vocabulary",
        message: `Concentration letter-prefix join matched only ${matchedLetters} of ${concCount} CONCENTRATION tests. The "(a)", "(b)", "(p)(i)" naming convention may have changed. Sample names: ${samples}`,
        severity: "error",
      });
    }
  }

  return {
    resolved: { tranches, poolSummary, ocTriggers, icTriggers, qualityTests, concentrationTests, reinvestmentOcTrigger, eventOfDefaultTest, dates, fees, loans, metadata, principalAccountCash, preExistingDefaultedPar, preExistingDefaultRecovery, unpricedDefaultedPar, preExistingDefaultOcValue, discountObligationHaircut, longDatedObligationHaircut, impliedOcAdjustment, quartersSinceReport, ddtlUnfundedPar, deferredInterestCompounds, baseRateFloorPct },
    warnings,
  };
}
