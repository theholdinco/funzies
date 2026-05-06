import type { ExtractedConstraints, CloPoolSummary, CloComplianceTest, CloTranche, CloTrancheSnapshot, CloHolding, CloAccountBalance, CloParValueAdjustment } from "./types";
import type { Citation, ComplianceTestType, ResolvedDealData, ResolvedTranche, ResolvedPool, ResolvedTrigger, ResolvedReinvestmentOcTrigger, ResolvedDates, ResolvedFees, ResolvedLoan, ResolvedComplianceTest, ResolvedEodTest, ResolvedMetadata, ResolvedSeniorExpensesCap, ResolvedDiscountObligationRule, ResolvedLongDatedValuationRule, ResolutionWarning } from "./resolver-types";
import { parseSpreadToBps, normalizeWacSpread } from "./ingestion-gate";
import { isHigherBetter } from "./test-direction";
import { mapToRatingBucket, moodysWarfFactor } from "./rating-mapping";
import { isRatingSentinel, parseNumeric, parseDecoratedAmount } from "./sdf/csv-utils";
import { CLO_DEFAULTS } from "./defaults";
import { computeTopNObligorsPct } from "./pool-metrics";
import { assignDenseSeniorityRanks, classOrderBucket } from "./seniority-rank";
import { canonicalizeDayCount, type DayCountConvention } from "./day-count-canonicalize";
import { resolveAgencyRecovery } from "./recovery-rate";
import { normalizeClassName as normClass } from "./normalize-class-name";
import { resolveMoodysRating, resolveFitchRating, type IntexPositionRow } from "./resolve-rating";

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

/** E1 (Sprint 5) — convert a raw provenance source (carrying `source_pages`
 *  and/or `source_condition` from ppm.json) into the partner-facing
 *  `Citation` shape. Returns null when neither field carries useful info,
 *  so call sites can render unconditionally without a null check. */
function extractCitation(
  source: { source_pages?: number[] | null; source_condition?: string | null } | null | undefined,
): Citation | null {
  if (!source) return null;
  const pages = source.source_pages ?? null;
  const cond = source.source_condition ?? null;
  if ((pages == null || pages.length === 0) && cond == null) return null;
  return { sourcePages: pages, sourceCondition: cond };
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

/**
 * Per-class deferrable resolution from the interest-mechanics section.
 *
 * `capitalStructure[].deferrable` is unreliable upstream — the LLM cap-structure
 * prompt asks for it, but the cap-structure pages of a PPM rarely state
 * deferrability inline; the authoritative source is the §7 interest-mechanics
 * block. Without this fall-through, every deal whose cap-structure extraction
 * misses `deferrable` resolves Class C/D/E/F (etc.) to `isDeferrable: false`,
 * silently disabling PIK accrual under junior interest shortfall.
 *
 * Two sources, in preference order:
 *   1. `interestMechanics.deferralClasses` — schematized array of class names
 *      that ARE deferrable. Treat as authoritative when non-empty.
 *   2. `interestMechanics.interest_deferral.class_X.deferral_permitted` — raw
 *      passthrough (snake_case base class). Sub-classes (B-1, B-2) inherit
 *      from the base letter (class_b).
 *
 * Returns `undefined` when neither source has info — caller falls through to
 * the existing default (`false`).
 */
function deferrableFromMechanics(
  mechanics: ExtractedConstraints["interestMechanics"],
  className: string,
): boolean | undefined {
  if (!mechanics) return undefined;
  const target = normClass(className);
  if (!target || target === "sub") return undefined; // residuals not in scope

  // Source 1: schematized list. Non-empty list = authoritative.
  const list = mechanics.deferralClasses;
  if (list && list.length > 0) {
    return list.some((c) => normClass(c) === target);
  }

  // Source 2: raw passthrough block keyed by snake_case base letter.
  const block = (mechanics as unknown as { interest_deferral?: Record<string, { deferral_permitted?: boolean | string }> }).interest_deferral;
  if (block) {
    const base = target.match(/^([a-z])/)?.[1];
    if (!base) return undefined;
    const entry = block[`class_${base}`];
    if (entry && typeof entry.deferral_permitted === "boolean") {
      return entry.deferral_permitted;
    }
  }

  return undefined;
}

function parseAmount(s: string | undefined | null): number {
  if (!s) return 0;
  // Range like "100,000,000-200,000,000" or "100,000,000 - 200,000,000": take
  // the first (lower-bound) value. The regex captures locale-permissive groups
  // ([\d,._]+) and the locale-aware parser handles American/European disambiguation.
  const rangeMatch = s.match(/^[^0-9]*?([\d,._]+)\s*[-–—]\s*([\d,._]+)/);
  if (rangeMatch) return parseNumeric(rangeMatch[1]) ?? 0;
  return parseDecoratedAmount(s) ?? 0;
}

/** Classifies a compliance-test row into one of the canonical types the
 *  engine and downstream filters reason about. The four "real" types map
 *  to load-bearing compliance triggers (Moody's WARF cap, Min WAS, Moody's
 *  Caa concentration, Fitch CCC concentration). All other rows — per-class
 *  OC/IC, WAL, diversity, recovery, lettered concentration buckets — fall
 *  through to "other" and are surfaced for UI display only. The regex set
 *  is intentionally tolerant of trustee report wording variations
 *  ("Min" vs "Minimum", "Floating Spread" vs "Spread"). New canonical types
 *  must extend `ComplianceTestType` and add a branch here. */
export function classifyComplianceTest(testName: string | null | undefined): ComplianceTestType {
  const name = (testName ?? "").toLowerCase();
  if (/moody.*maximum.*weighted average rating factor/.test(name)) return "moodys_max_warf";
  if (/min(?:imum)?.*weighted average.*(?:floating )?spread/.test(name)) return "min_was";
  if (/moody.*caa.*obligation/.test(name)) return "moodys_caa_concentration";
  if (/fitch.*ccc.*obligation/.test(name)) return "fitch_ccc_concentration";
  return "other";
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

/**
 * S&P-tagged compliance test name detection. Two regex constants and a
 * combined predicate live at module scope (parallel to the inline
 * `/moody/i` and `/fitch/i` patterns used at the boolean-derivation site)
 * so the cross-reference exclusion is visible and the convention is one
 * source of truth.
 *
 * Detection: `\bs&p\b` or "standard & poor" anywhere in the test name.
 * Exclusion: cross-reference phrasings like "from S&P", "derived from
 * S&P", "based on S&P", "equivalent to S&P", "mapped to S&P [Scale]" —
 * these are Moody's/Fitch tests that REFERENCE S&P as input or
 * comparison anchor, not S&P-tagged tests themselves. Without exclusion,
 * `isSpRated` false-positives on a Fitch+Moody's deal whose Moody's
 * compliance test is "Moody's Rating derived from S&P".
 */
const SP_TAG_PATTERN = /\bs&p\b|standard\s*&\s*poor/i;
const SP_CROSS_REF_PATTERN = /(?:from|based\s+on|equivalent\s+to|mapped\s+to|derived\s+from|converted\s+to|relative\s+to|vs\.?|versus)\s+s&p\b/i;
function isSpTaggedTestName(name: string): boolean {
  return SP_TAG_PATTERN.test(name) && !SP_CROSS_REF_PATTERN.test(name);
}

/**
 * Compute cushion polarity from direction. Returns null when direction is
 * unknown rather than silently defaulting to a (potentially wrong-sign)
 * formula. Used as a fallback when an upstream `cushion_pct` is null —
 * legacy DB rows ingested before per-row direction classification carry
 * null cushions; the lookup below restores the correct sign without
 * requiring a re-ingest. New ingest writes correct cushions in the SDF
 * parser so this fallback is dormant on fresh data.
 */
function directionalCushion(
  testType: string | null | undefined,
  testName: string | null | undefined,
  actual: number | null,
  trigger: number | null,
): number | null {
  if (actual == null || trigger == null) return null;
  const dir = isHigherBetter(testType ?? null, testName ?? null);
  if (dir === true) return actual - trigger;
  if (dir === false) return trigger - actual;
  return null;
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
        severity: "warn", blocking: false,
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
            severity: "info", blocking: false,
            resolvedFrom: "snapshot",
          });
        }

        let spreadBps = t.spreadBps ?? ppmSpreadByClass.get(key) ?? 0;
        // Defense-in-depth: if spread looks like a percentage (< 20) after DB read, convert.
        // This should not fire if ingestion is correct — if it does, log a warning.
        if (spreadBps > 0 && spreadBps < 20 && !isSub) {
          warnings.push({ field: `${t.className}.spreadBps`, message: `Spread ${spreadBps} looks like percentage (not bps) — converting to ${Math.round(spreadBps * 100)} bps. Check ingestion.`, severity: "warn", blocking: false });
          spreadBps = Math.round(spreadBps * 100);
        }
        if (spreadBps === 0 && !isSub) {
          warnings.push({
            field: `${t.className}.spreadBps`,
            message: `No spread found for ${t.className} in DB or PPM constraints`,
            severity: "error",
            blocking: true,
          });
        }
        if (t.spreadBps == null && ppmSpreadByClass.has(key)) {
          warnings.push({
            field: `${t.className}.spreadBps`,
            message: `Using PPM spread (${ppmSpreadByClass.get(key)} bps) — DB tranche has null`,
            severity: "info", blocking: false,
            resolvedFrom: "ppm_constraints",
          });
        }

        // Per-tranche accrual convention. Two-axis decision:
        //   1. carveOut = isSub || hasAmort. Income notes don't accrue a
        //      coupon; amortising tranches (Class X) ride the engine's
        //      `isFloating ? actual_360 : 30_360` fallback. Both cases
        //      bypass the blocking-on-null rule below.
        //   2. The canonicalizer is invoked iff `t.dayCountConvention`
        //      is non-null OR carveOut is false. When carveOut is true
        //      AND the source is null, the resolved field is left
        //      undefined so the engine fallback fires (preserves pre-fix
        //      accrual on null-DCC Class X / Sub). When the source is
        //      non-null, canonicalization runs regardless of carveOut so
        //      an explicit DCC on a Sub note (Euro XV's "Actual/360") is
        //      preserved as `actual_360` rather than dropped.
        // Outside the carve-out: explicit DCC canonicalizes; null DCC
        // blocks for fixed-rate (no market default) and falls back to
        // Actual/360 with severity:"warn" for floating (Euro default).
        const isFloating = t.isFloating ?? true;
        const carveOut = isSub || hasAmort;
        let trancheDayCountConvention: DayCountConvention | undefined;
        if (carveOut && t.dayCountConvention == null) {
          trancheDayCountConvention = undefined;
        } else {
          const dccResult = canonicalizeDayCount(t.dayCountConvention, {
            isFixedRate: !isFloating && !carveOut,
            field: `${t.className}.dayCountConvention`,
          });
          if (dccResult.warning) {
            warnings.push(
              dccResult.blocking
                ? { field: "dayCountConvention", message: dccResult.warning, severity: "error", blocking: true }
                : { field: "dayCountConvention", message: dccResult.warning, severity: "warn", blocking: false },
            );
          }
          trancheDayCountConvention = dccResult.convention;
        }

        return {
          className: t.className,
          currentBalance: snap?.endingBalance ?? snap?.currentBalance ?? t.originalBalance ?? ppmBalanceByClass.get(key) ?? 0,
          originalBalance: ppmBalanceByClass.get(key) ?? t.originalBalance ?? 0,
          spreadBps,
          seniorityRank: t.seniorityRank ?? 99,
          isFloating,
          isIncomeNote: isSub,
          isDeferrable: t.isDeferrable
            ?? ppmDeferrableByClass.get(key)
            ?? deferrableFromMechanics(constraints.interestMechanics, t.className)
            ?? false,
          isAmortising: hasAmort,
          amortisationPerPeriod: amortPerPeriod,
          amortStartDate: hasAmort ? (ppmAmortStartByClass.get(key) ?? defaultAmortStartDate) : null,
          // PPM § 10(a)(i) prior-period state — null until trustee extraction
          // populates the carried-shortfall and consecutive-period-count
          // fields. Engine treats null as 0 (no prior carry) which is the
          // healthy-start default; populating from a real trustee snapshot
          // is the path-to-close for distressed deals.
          priorInterestShortfall: null,
          priorShortfallCount: null,
          // PPM Condition 6(c) opening Deferred Interest balance — sourced
          // directly from the trustee snapshot. Semantics gated by the
          // deal's `deferredInterestCompounds` flag downstream; see the
          // `ResolvedTranche.deferredInterestBalance` JSDoc and the
          // build-projection-inputs gate for the cause-tree on populated
          // values under compounding PPMs.
          deferredInterestBalance: snap?.deferredInterestBalance ?? null,
          dayCountConvention: trancheDayCountConvention,
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

  // Sort by class-letter bucket so seniority survives LLM extraction-order
  // shuffle. Pari-passu collapse (A-1+A-2 → rank 1, B-1+B-2 → rank 2) is
  // produced by `assignDenseSeniorityRanks` below — same shared helper used
  // by the DB write sites (`extraction/persist-ppm.ts`, `extraction/runner.ts`)
  // so the rank value can't drift between layers.
  const sortedEntries = Array.from(byClass.values()).sort(
    (a, b) =>
      classOrderBucket(a.class, a.isSubordinated) -
      classOrderBucket(b.class, b.isSubordinated),
  );
  const denseRanks = assignDenseSeniorityRanks(
    sortedEntries.map((e) => ({ className: e.class, isSubordinated: e.isSubordinated })),
  );

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
        blocking: true,
      });
    }

    // PPM capital structure carries no day-count convention column. Same
    // tier rule as the DB-tranche branch: income notes don't accrue and
    // amortising tranches (Class X) ride the engine `isFloating ?
    // actual_360 : 30_360` fallback; floating defaults to A/360; fixed
    // non-amortising non-income tranches block (no market default).
    const carveOut = isSub || hasAmort;
    let ppmTrancheDayCountConvention: DayCountConvention | undefined;
    if (carveOut) {
      ppmTrancheDayCountConvention = undefined;
    } else {
      const dccResult = canonicalizeDayCount(undefined, {
        isFixedRate: !isFloating,
        field: `${className}.dayCountConvention`,
      });
      if (dccResult.warning) {
        warnings.push(
          dccResult.blocking
            ? { field: "dayCountConvention", message: dccResult.warning, severity: "error", blocking: true }
            : { field: "dayCountConvention", message: dccResult.warning, severity: "warn", blocking: false },
        );
      }
      ppmTrancheDayCountConvention = dccResult.convention;
    }

    return {
      className,
      currentBalance: parseAmount(e.principalAmount),
      originalBalance: parseAmount(e.principalAmount),
      spreadBps,
      seniorityRank: denseRanks[idx],
      isFloating,
      isIncomeNote: isSub,
      isDeferrable: e.deferrable ?? deferrableFromMechanics(constraints.interestMechanics, className) ?? false,
      isAmortising: hasAmort,
      amortisationPerPeriod: amortPerPeriod,
      amortStartDate: hasAmort ? (ppmAmortStartByClass.get(key) ?? defaultAmortStartDate) : null,
      // PPM § 10(a)(i) prior-period state — null until trustee extraction populates.
      priorInterestShortfall: null,
      priorShortfallCount: null,
      // No trustee snapshot available on this PPM-fallback path → null.
      deferredInterestBalance: null,
      dayCountConvention: ppmTrancheDayCountConvention,
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
        severity: "info", blocking: false,
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
  eventOfDefaultConstraint: { required_ratio_pct?: number; source_pages?: number[]; source_condition?: string } | null | undefined,
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
          severity: "warn", blocking: false,
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
    warnings.push({
      field: "ocTriggers",
      message: "No OC triggers found in compliance tests or PPM. Engine cannot fire any class-level OC test, divert interest under PPM Step V, or detect Event of Default on class paths — every period would silently pass an absent test. Verify extraction or set triggers manually if data is genuinely missing.",
      severity: "error",
      // Empty trigger set looks innocuous but disables the entire OC
      // enforcement pipeline; refuse rather than project as if every
      // test passes.
      blocking: true,
    });
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
      warnings.push({ field: `ocTrigger.${t.className}`, message: `OC trigger ${t.triggerLevel} looks like a ratio, converting to ${triggerLevel}%`, severity: "warn", blocking: false });
    } else if (triggerLevel >= 10 && triggerLevel < 90) {
      warnings.push({
        field: `ocTrigger.${t.className}`,
        message: `OC trigger ${triggerLevel}% for ${t.className} is implausible — no CLO OC trigger is 10-90%. Check extraction and set manually.`,
        severity: "error",
        // The "perpetually-passing" reasoning above is fine for the
        // warning shape but wrong as a run-with-it choice; refuse instead.
        blocking: true,
      });
    }
    if (triggerLevel > 200) {
      warnings.push({ field: `ocTrigger.${t.className}`, message: `OC trigger ${triggerLevel}% for ${t.className} seems unusually high`, severity: "warn", blocking: false });
    }
    return { className: t.className, triggerLevel, rank: resolveRank(t.className), testType: "OC" as const, source: t.source };
  });

  const ic: ResolvedTrigger[] = dedupTriggers(icRaw, warnings).map(t => {
    let triggerLevel = t.triggerLevel;
    // IC triggers: values < 10 are ratios (e.g. 1.20 → 120%). IC triggers are
    // typically 100-200%. Values >= 10 are treated as percentages.
    if (triggerLevel > 0 && triggerLevel < 10) {
      triggerLevel = triggerLevel * 100;
      warnings.push({ field: `icTrigger.${t.className}`, message: `IC trigger ${t.triggerLevel} looks like a ratio, converting to ${triggerLevel}%`, severity: "warn", blocking: false });
    } else if (triggerLevel >= 10 && triggerLevel < 90) {
      warnings.push({
        field: `icTrigger.${t.className}`,
        message: `IC trigger ${triggerLevel}% for ${t.className} is implausible — IC triggers are typically 100-200%, never 10-90%. Likely an extractor column mis-read. Check extraction and set manually.`,
        severity: "error",
        // Sibling shape to the OC band gate at L388-397: a misextracted
        // IC trigger of 50% means the actual ratio of ~150% always passes,
        // IC test silently always-on, no diversion ever fires. Refuse
        // rather than ship a projection against an always-passing test.
        blocking: true,
      });
    }
    if (triggerLevel > 500) {
      warnings.push({ field: `icTrigger.${t.className}`, message: `IC trigger ${triggerLevel}% for ${t.className} seems unusually high`, severity: "warn", blocking: false });
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
  const eodCitation = extractCitation(eventOfDefaultConstraint);
  if (eodEntries.length > 0) {
    // Prefer compliance-reported level; fall back to PPM constraint if somehow missing.
    const eodLevel = eodEntries[0].triggerLevel;
    const sourcePage = eventOfDefaultConstraint?.source_pages?.[0] ?? null;
    eventOfDefaultTest = { triggerLevel: eodLevel, sourcePage, citation: eodCitation };
    if (constraintTrigger != null && Math.abs(constraintTrigger - eodLevel) > 0.01) {
      warnings.push({
        field: "eventOfDefaultTest",
        message: `EoD trigger mismatch: compliance reports ${eodLevel}%, PPM constraint reports ${constraintTrigger}%. Using compliance value.`,
        severity: "warn", blocking: false,
      });
    }
  } else if (constraintTrigger != null) {
    // No compliance row (older reports), fall back to PPM constraint.
    eventOfDefaultTest = {
      triggerLevel: constraintTrigger,
      sourcePage: eventOfDefaultConstraint?.source_pages?.[0] ?? null,
      citation: eodCitation,
    };
  }

  return { oc: ocWithoutEod, ic, eventOfDefaultTest };
}

/** Resolve PPM Condition 1 "Senior Expenses Cap" from
 *  `constraints.seniorExpensesCap` (populated by `mapFeesAndExpenses` from
 *  `ppm.json:section_5_fees_and_hurdle.senior_expenses_cap`).
 *
 *  Per project rule (silent fallbacks on missing computational extraction
 *  are bugs), this emits `severity: "error", blocking: true` when the deal
 *  has fee rows (i.e., extraction is in non-greenfield state) but the cap
 *  is missing — a silently-applied 20 bps default would silently mis-cap
 *  trustee/admin fees on every period of every deal. Greenfield fixtures
 *  (no fees extracted) are exempt; the legacy DEFAULT_ASSUMPTIONS values
 *  flow through. */
function resolveSeniorExpensesCap(
  constraints: ExtractedConstraints,
  warnings: ResolutionWarning[],
): ResolvedSeniorExpensesCap | null {
  const block = constraints.seniorExpensesCap;
  if (!block) {
    const hasFees = (constraints.fees ?? []).length > 0;
    if (hasFees) {
      warnings.push({
        field: "seniorExpensesCap",
        message:
          "PPM Senior Expenses Cap (Condition 1, ppm.json:section_5_fees_and_hurdle.senior_expenses_cap) is not extracted. Cap is deal-specific and bounds steps (B) trustee + (C) admin; falling back to UI/test defaults silently caps fees at the wrong rate. Add the senior_expenses_cap block to ppm.json with bps_per_annum, absolute_floor_eur_per_annum, and the four allocation-rule fields, then re-ingest.",
        severity: "error",
        blocking: true,
      });
    }
    return null;
  }
  return {
    bpsPerYear: block.bpsPerYear,
    absoluteFloorEurPerYear: block.absoluteFloorEurPerYear,
    componentADayCount: block.componentADayCount,
    capBase: block.base,
    capPeriod: block.period,
    allocationWithinCap: block.allocationWithinCap,
    overflowAllocation: block.overflowAllocation,
    carryforwardPeriods: block.carryforwardPeriods,
    vatIncluded: block.vatIncluded,
    vatRatePct: block.vatRatePct,
    citation:
      block.sourcePages != null || block.sourceCondition != null
        ? { sourcePages: block.sourcePages, sourceCondition: block.sourceCondition }
        : null,
  };
}

/** Resolve hedge cost from compliance fees rows (Signal 2).
 *
 *  Two-layer architecture: Signal 1 (back-derive from observed
 *  waterfall step (F)) lives in `defaultsFromResolved`
 *  (build-projection-inputs.ts) — the resolver layer cannot see
 *  `raw.waterfallSteps`. Signal 1 takes precedence when both fire.
 *  Signal 3 (LLM-extracted `hedgePositions[]`) is intentionally out
 *  of scope for the principle-3 closure: `ExtractedConstraints` does
 *  not currently carry the array, and threading it through requires
 *  a separate type-extension refactor.
 *
 *  Detection — two-stage filter on `constraints.fees[]`:
 *    1. INCLUDE rows whose name matches /hedge|swap/i (covers
 *       "Hedge Cost", "Currency Hedge Fee", "IR Swap Premium",
 *       "Cross-Currency Swap", etc.).
 *    2. EXCLUDE rows whose name additionally matches
 *       /termination|replacement|defaulted|mtm|mark[- ]to[- ]market/i.
 *       These are event-driven payments (counterparty default →
 *       step (AA), KI-06; hedge replacement = one-off, not periodic;
 *       MTM = revaluation flowing through the OC numerator, not the
 *       interest waterfall). Including them would double-count or
 *       misclassify event cash as periodic accrual.
 *
 *  Sum across all matched periodic rows. A deal with a "Currency
 *  Hedge" row + an "IR Swap" row carries combined periodic cost at
 *  step (F); both contribute. The single-row case is the special case.
 *
 *  Unit dispatch — per-row, NOT per-deal:
 *    - `bps_pa` explicit → use rate directly.
 *    - `pct_pa` explicit → multiply by 100.
 *    - No unit → BLOCK regardless of magnitude. Hedge cost is quoted
 *      in bps OR pct depending on instrument type (IR swaps typically
 *      bps; currency hedges quoted both ways). The "small values are
 *      pct_pa" heuristic that works for management fees (where pct
 *      is the dominant convention) cannot disambiguate hedge cost
 *      safely — wrong-direction interpretation of a no-unit value
 *      produces a 100× error. Force the source data to declare the
 *      unit explicitly; principle 3 strict.
 *
 *  Sanity warn at ≥200 bps (per row, post-conversion). 200 bps is the
 *  upper bound for cross-currency hedges in stress regimes (IR swaps
 *  are typically 5-30 bps). Values above suggest extraction artefacts
 *  (sign error, unit confusion at the LLM layer, one-off termination
 *  spike misclassified as periodic). Non-blocking — the value is still
 *  used; the warn surfaces at audit time.
 *
 *  Both blocking exits return 0 (not the input rate) to preserve the
 *  bps scale invariant on `resolved.hedgeCostBps` (CLAUDE.md principle
 *  5). The blocking gate via `IncompleteDataError` in
 *  `buildFromResolved` is the primary defense; the 0 sentinel is
 *  defense-in-depth. `resolveFees.toPctPa`'s same-shape blocking
 *  branch returns `r / 100` to match its pct_pa output scale; copying
 *  that pattern here would inject a pct-shaped value into a bps
 *  field — different output scale, same helper structure, scale
 *  invariant must not be conflated.
 *
 *  Engine plumbing already consumes the result via
 *  `ProjectionInputs.hedgeCostBps` at every PPM site (T=0 IC
 *  numerator, per-period normal mode, post-acceleration executor) —
 *  hedge plumbing routes through the canonical `SeniorExpenseBreakdown`
 *  uniformly. This function only fills in the resolver-layer half of
 *  the extraction gap. */
function resolveHedgeCost(
  constraints: ExtractedConstraints,
  warnings: ResolutionWarning[],
): number {
  const periodicHedgeRows = (constraints.fees ?? []).filter((fee) => {
    const name = fee.name?.toLowerCase() ?? "";
    if (!/hedge|swap/.test(name)) return false;
    if (/termination|replacement|defaulted|mtm|mark[- ]to[- ]market/.test(name)) return false;
    return true;
  });

  let totalBps = 0;
  for (const fee of periodicHedgeRows) {
    const rate = parseFloat(fee.rate ?? "");
    const unit = fee.rateUnit ?? null;

    if (isNaN(rate)) {
      warnings.push({
        field: "hedgeCostBps",
        message: `Hedge fee row "${fee.name}" present in extracted constraints.fees[] but rate is unparseable (got "${fee.rate}"). Silent fallback to 0 would emit zero step (F) every period; refusing to run rather than ship that drift. Set the rate manually from the PPM hedge schedule (typical: 5-50 bps p.a. on notional).`,
        severity: "error",
        blocking: true,
      });
      return 0;
    }

    let bps: number;
    if (unit === "bps_pa") {
      bps = rate;
    } else if (unit === "pct_pa") {
      bps = rate * 100;
    } else {
      warnings.push({
        field: "hedgeCostBps",
        message: `Hedge fee row "${fee.name}" rate ${rate} extracted with no rateUnit. Hedge cost conventions vary by instrument (IR swaps typically bps_pa; currency hedges quoted both ways) — the management-fee heuristic ("small values are pct_pa") is unsafe here. Set rateUnit explicitly ("bps_pa" or "pct_pa") in the source data; wrong-direction interpretation would produce a 100× error.`,
        severity: "error",
        blocking: true,
      });
      return 0;
    }

    if (bps >= 200) {
      warnings.push({
        field: "hedgeCostBps",
        message: `Hedge fee row "${fee.name}" extracted at ${bps.toFixed(0)} bps p.a. — at or above the 200 bps sanity threshold. Cross-currency hedges in stress reach ~150 bps; values above this often indicate extraction artefacts (termination spike misclassified as periodic, sign error, unit confusion). Verify against the PPM hedge schedule and the trustee step (F) row.`,
        severity: "warn",
        blocking: false,
      });
    }

    totalBps += bps;
  }
  return totalBps;
}

/** Resolve PPM Condition 1 "Discount Obligation" classification + cure
 *  rule from `constraints.discountObligation` (populated by
 *  `mapFeesAndExpenses` from
 *  `ppm.json:section_5_fees_and_hurdle.discount_obligation`).
 *
 *  Per project rule (silent fallbacks on missing computational extraction
 *  are bugs), this emits `severity: "error", blocking: true` when the
 *  deal has loan rows (extraction not in greenfield state) but the rule
 *  is missing — without it, the engine cannot classify positions as
 *  Discount Obligations and the OC numerator silently misses the
 *  haircut. Greenfield fixtures (no loans extracted) are exempt; the
 *  legacy scalar fallback path flows through. */
function resolveDiscountObligation(
  constraints: ExtractedConstraints,
  warnings: ResolutionWarning[],
  hasLoans: boolean,
): ResolvedDiscountObligationRule | null {
  const block = constraints.discountObligation;
  if (!block) {
    if (hasLoans) {
      warnings.push({
        field: "discountObligationRule",
        message:
          "PPM Discount Obligation rule (Condition 1, ppm.json:section_5_fees_and_hurdle.discount_obligation) is not extracted. Rule is deal-specific (classification threshold, cure mechanic, cure window, optional rate-type split) and drives the OC numerator's discount-obligation haircut at every period plus the price-aware reinvestment cure math. Add the discount_obligation block to ppm.json with classification_threshold and cure_mechanic, then re-ingest.",
        severity: "error",
        blocking: true,
      });
    }
    return null;
  }
  return {
    classificationThresholdPct: block.classificationThresholdPct,
    cureMechanic: block.cureMechanic,
    citation:
      block.sourcePages != null || block.sourceCondition != null
        ? { sourcePages: block.sourcePages, sourceCondition: block.sourceCondition }
        : null,
  };
}

/** Resolve PPM Condition 1 ("Long-Dated Collateral Obligation") + APB
 *  "deemed zero" valuation rule from `constraints.longDatedObligation`
 *  (populated by `mapFeesAndExpenses` from
 *  `ppm.json:section_5_fees_and_hurdle.long_dated_obligation`).
 *
 *  Per project rule (silent fallbacks on missing computational
 *  extraction are bugs), this emits `severity: "error", blocking: true`
 *  when the deal has loan rows but the rule is missing — the engine
 *  cannot compute the long-dated haircut Σ without it. Greenfield
 *  fixtures (no loans extracted) are exempt.
 *
 *  Additional gate: when `postCap.agency_cv_min` is selected, refuses
 *  to resolve unless per-position S&P + Fitch CV is ingested (NOT
 *  TODAY — `ResolvedLoan` carries no `spCalculationValue` /
 *  `fitchCalculationValue`). The variant is encoded in the type system
 *  to document the design space; selection forces the implementer to
 *  extend per-position ingestion alongside the rule. */
function resolveLongDatedObligation(
  constraints: ExtractedConstraints,
  warnings: ResolutionWarning[],
  hasLoans: boolean,
): ResolvedLongDatedValuationRule | null {
  const block = constraints.longDatedObligation;
  if (!block) {
    if (hasLoans) {
      warnings.push({
        field: "longDatedValuationRule",
        message:
          "PPM Long-Dated Obligation rule (Condition 1 + APB \"deemed zero\" paragraph, " +
          "ppm.json:section_5_fees_and_hurdle.long_dated_obligation) is not extracted. " +
          "Rule is deal-specific (cap percentage, capBase, within-cap valuation, " +
          "post-cap treatment) and drives the OC numerator's long-dated haircut at " +
          "every period. Add the long_dated_obligation block to ppm.json with " +
          "cap_pct_of_base, cap_base, within_cap, and post_cap, then re-ingest.",
        severity: "error",
        blocking: true,
      });
    }
    return null;
  }
  if (block.postCap.type === "agency_cv_min") {
    warnings.push({
      field: "longDatedValuationRule.postCap",
      message:
        "PPM long-dated rule selects postCap.agency_cv_min (above-cap valuation = " +
        "min(S&P CV, Fitch CV)), but per-position S&P/Fitch Calculation Value is not " +
        "ingested today. Engine cannot dispatch this variant without " +
        "ResolvedLoan.spCalculationValue + fitchCalculationValue (and corresponding " +
        "SDF / Intex extraction). Extend ingestion before resolving this deal, or " +
        "verify the deal's PPM truly specifies agency_cv_min.",
      severity: "error",
      blocking: true,
    });
    return null;
  }
  return {
    capPctOfBase: block.capPctOfBase,
    capBase: block.capBase,
    withinCap: block.withinCap,
    postCap: block.postCap,
    citation:
      block.sourcePages != null || block.sourceCondition != null
        ? { sourcePages: block.sourcePages, sourceCondition: block.sourceCondition }
        : null,
  };
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
        warnings.push({ field: fieldName, message: `Converted ${r} bps to ${r / 100}% (rateUnit: bps_pa)`, severity: "info", blocking: false });
        return r / 100;
      }
      if (unit === "pct_pa") return r;
      // No explicit unit — heuristic-only path. The wrong guess produces a 100×
      // error in fee accrual (rate of 6 read as bps becomes 0.06%, when the deal
      // genuinely paid 6% p.a.). Refuse rather than apply the heuristic silently;
      // partner sets rateUnit explicitly upstream and re-runs.
      if (r > 5) {
        warnings.push({
          field: fieldName,
          message: `Fee rate ${r} extracted with no rateUnit — heuristic would treat it as bps and convert to ${r / 100}%, but this is a guess. Wrong-direction interpretation produces a 100× error in fee accrual. Set rateUnit explicitly ("bps_pa" or "pct_pa") in the source data.`,
          severity: "error",
          blocking: true,
        });
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
        warnings.push({ field: "fees.trusteeFeeBps", message: `Converted trustee fee ${rate}% to ${rate * 100} bps (rateUnit: pct_pa)`, severity: "info", blocking: false });
      } else {
        trusteeFeeBps = rate;
      }
      if (trusteeFeeBps > 50) {
        warnings.push({ field: "fees.trusteeFeeBps", message: `Trustee fee ${trusteeFeeBps} bps seems unusually high`, severity: "warn", blocking: false });
      }
    } else if (name.includes("incentive") || name.includes("performance")) {
      incentiveFeePct = rate;
      if (rate > 50) {
        warnings.push({ field: "fees.incentiveFeePct", message: `Incentive fee ${rate}% seems unusually high`, severity: "warn", blocking: false });
      }
      const hurdleRaw = parseFloat(fee.hurdleRate ?? "");
      if (!isNaN(hurdleRaw) && hurdleRaw > 0) {
        incentiveFeeHurdleIrr = hurdleRaw > 1 ? hurdleRaw / 100 : hurdleRaw;
      } else if (incentiveFeePct > 0) {
        // Standard European CLO equity hurdle is ~12% IRR. Using 0% would mean
        // the incentive fee fires on any positive return, which is too aggressive.
        incentiveFeeHurdleIrr = 0.12;
        warnings.push({
          field: "fees.incentiveFeeHurdleIrr",
          message: `Incentive fee present (${incentiveFeePct}%) but no hurdle rate found — assuming 12% IRR hurdle. This directly affects equity IRR calculation. Set manually if different.`,
          severity: "error",
          resolvedFrom: "not extracted → defaulted to 12%",
          // Value still set to 0.12 so non-engine reads (debug
          // serialization, type-safety) don't see undefined; gate
          // refuses before the engine consumes.
          blocking: true,
        });
      }
    }
  }

  // Warn if trustee fee is 0 but the PPM mentions one — "per agreement" means we couldn't extract the rate
  if (trusteeFeeBps === 0 && (constraints.fees ?? []).some(f => {
    const n = (f.name ?? "").toLowerCase();
    return n.includes("trustee") || n.includes("admin");
  })) {
    warnings.push({
      field: "fees.trusteeFeeBps",
      message: "Trustee/admin fee found in PPM but rate is 'per agreement' (or otherwise unparseable) — `trusteeFeeBps` stayed at the CLO_DEFAULTS zero, so engine would accrue no trustee fee per period. Refusing to run rather than ship a projection that silently under-states senior expenses by the full trustee accrual. Set the rate manually from the compliance report fee schedule (typically 1-5 bps).",
      severity: "error",
      // Same shape as the senior/sub mgmt fee zero-on-recognized-name sites
      // at L546/556: trustee name found in extraction, rate failed to
      // parse, value silently defaults to 0, engine consumes zero. Refuse.
      blocking: true,
    });
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
      blocking: true,
    });
  }
  if (subFeePct === 0) {
    warnings.push({
      field: "fees.subFeePct",
      message: hasSubMgmtFeeName
        ? `Subordinated Management Fee entry found but rate extracted as 0 — likely a PPM extraction regression. Typical Sub CMF is 0.30-0.50% p.a. — set manually.`
        : `No Subordinated Management Fee found in extracted constraints.fees[]. Typical Sub CMF is 0.30-0.50% p.a. — set manually.`,
      severity: "error",
      blocking: true,
    });
  }

  // E1 (Sprint 5) — surface PPM section provenance for the fees block.
  // ppm-mapper.ts attaches `_feesProvenance` to constraints from
  // section_5_fees_and_hurdle.source_pages.
  const feesProvenance = (constraints as unknown as { _feesProvenance?: { source_pages?: number[] | null; source_condition?: string | null } | null })._feesProvenance ?? null;
  const citation = extractCitation(feesProvenance);

  return { seniorFeePct, subFeePct, trusteeFeeBps, incentiveFeePct, incentiveFeeHurdleIrr, citation };
}

/** Resolve PPM Condition 1 / 10(a)(iv) Excess CCC Adjustment Amount.
 *  Outer-nullable, inner-required: when the constraint object is missing or
 *  null, both fields emit blocking warnings rather than silently falling back
 *  to a global default — the partner-facing OC numerator depends on per-deal
 *  values (typical European CLO is 7.5% / 70% but ranges are 5–17.5% / 60–80%).
 *  The slider is not an override path: the gate fires before userAssumptions
 *  are read, so any unblock must happen upstream of the resolver. */
function resolveCccThresholds(
  constraints: ExtractedConstraints,
  warnings: ResolutionWarning[],
): { cccBucketLimitPct: number | null; cccMarketValuePct: number | null } {
  const adj = constraints.excessCccAdjustment;
  if (adj == null) {
    warnings.push({
      field: "cccBucketLimitPct",
      message: `Excess CCC Adjustment Amount not extracted from PPM (Condition 1 / 10(a)(iv)). The CCC bucket limit is per-deal; refusing to run rather than apply a global default.`,
      severity: "error",
      blocking: true,
    });
    warnings.push({
      field: "cccMarketValuePct",
      message: `Excess CCC Adjustment Amount not extracted from PPM (Condition 1 / 10(a)(iv)). The CCC market-value floor is per-deal; refusing to run rather than apply a global default.`,
      severity: "error",
      blocking: true,
    });
    return { cccBucketLimitPct: null, cccMarketValuePct: null };
  }
  const threshold = parseFloat(adj.thresholdPct);
  const marketValue = parseFloat(adj.marketValuePct);

  // Plausibility bounds: catches fraction-shape mis-extraction (LLM emits
  // "0.075" when the PPM says "7.5 per cent" → parseFloat passes 0.075
  // through silently, and the engine applies a 100× too-tight haircut cap
  // with no surface signal). Range chosen to bracket every PPM the model
  // might encounter (typical 5–17.5 / 60–80; widened to 1–50 / 1–100 for
  // headroom). Same defensive shape as the OC trigger 10–90% band block.
  const thresholdValid = !isNaN(threshold) && threshold >= 1 && threshold <= 50;
  const marketValueValid = !isNaN(marketValue) && marketValue >= 1 && marketValue <= 100;

  if (isNaN(threshold)) {
    warnings.push({
      field: "cccBucketLimitPct",
      message: `Excess CCC Adjustment thresholdPct extracted but unparseable: "${adj.thresholdPct}". Refusing to run rather than apply a global default.`,
      severity: "error",
      blocking: true,
    });
  } else if (!thresholdValid) {
    warnings.push({
      field: "cccBucketLimitPct",
      message: `Excess CCC Adjustment thresholdPct extracted as ${threshold} — outside plausible range [1, 50]. Likely a fraction-shape mis-extraction (e.g., "0.075" instead of "7.5") or a malformed value. Refusing to run rather than apply an implausible threshold.`,
      severity: "error",
      blocking: true,
    });
  }
  if (isNaN(marketValue)) {
    warnings.push({
      field: "cccMarketValuePct",
      message: `Excess CCC Adjustment marketValuePct extracted but unparseable: "${adj.marketValuePct}". Refusing to run rather than apply a global default.`,
      severity: "error",
      blocking: true,
    });
  } else if (!marketValueValid) {
    warnings.push({
      field: "cccMarketValuePct",
      message: `Excess CCC Adjustment marketValuePct extracted as ${marketValue} — outside plausible range [1, 100]. Likely a fraction-shape mis-extraction (e.g., "0.7" instead of "70") or an impossible value (>100% of par). Refusing to run rather than apply an implausible floor.`,
      severity: "error",
      blocking: true,
    });
  }
  // Atomic return: half-good output (one field parses, the other doesn't)
  // would let a downstream caller bypass the gate and consume a per-deal
  // value alongside the global default for the other — silently producing
  // a hybrid haircut. The per-field blocking warnings above are independent
  // of this atomicity; both still fire when only one field is invalid.
  if (!thresholdValid || !marketValueValid) {
    return { cccBucketLimitPct: null, cccMarketValuePct: null };
  }
  return { cccBucketLimitPct: threshold, cccMarketValuePct: marketValue };
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
  dealDates?: { maturity?: string | null; reinvestmentPeriodEnd?: string | null; reportDate?: string | null; dealCurrency?: string | null },
  accountBalances?: CloAccountBalance[],
  parValueAdjustments?: CloParValueAdjustment[],
  intexPositions?: Map<string, IntexPositionRow>,
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
        severity: "info", blocking: false,
      });
    } else {
      seenClasses.set(key, tranches.length);
      tranches.push(t);
    }
  }

  // --- Pool Summary ---
  const pool = complianceData?.poolSummary;
  const { bps: wacSpreadBps, fix: wacFix } = normalizeWacSpread(pool?.wacSpread ?? null);
  if (wacFix) warnings.push({ field: wacFix.field, message: wacFix.message, severity: "info", blocking: false, resolvedFrom: `${wacFix.before} → ${wacFix.after}` });

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
  // source provides it directly. Soft inference when senior-secured = 100%:
  // all par is senior-secured ⇒ second-lien is 0 by definition (mutually
  // exclusive lien categories). Lets partners see "0% second-lien" on deals
  // like Euro XV rather than "unknown" where the complement arithmetic makes
  // the answer certain.
  const directSecondLien = num(pool?.pctSecondLien);
  const derivedPctSecondLien = round4(
    directSecondLien != null
      ? directSecondLien
      : (derivedPctSeniorSecured === 100 ? 0 : null),
  );
  const derivedPctCurrentPay    = round4(num(pool?.pctCurrentPay) ?? pickConc("current pay obligations"));

  // E1 (Sprint 5) — surface PPM section provenance for the pool-summary block.
  // ppm-mapper.ts attaches `_poolProvenance` to constraints from
  // section_8_portfolio_and_quality_tests.source_pages (portfolio_profile +
  // collateral_quality_tests pages).
  const poolProvenance = (constraints as unknown as { _poolProvenance?: { source_pages?: number[] | null; source_condition?: string | null } | null })._poolProvenance ?? null;
  const poolCitation = extractCitation(poolProvenance);

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
    // D4 — populated after `loans` is constructed below (the helper needs
    // `loans[].obligorName` + `parBalance`). Placeholder null here; patched
    // into the literal once the loan list is ready.
    top10ObligorsPct: null,
    citation: poolCitation,
  };

  if (poolSummary.totalPar === 0) {
    warnings.push({
      field: "poolSummary.totalPar",
      message: "Total par is 0 — no pool summary data",
      severity: "error",
      // Empty pool produces an all-zero projection that's visible
      // only as "everything is strange"; refuse instead.
      blocking: true,
    });
  }

  // F3 canary — extracted pool.pct* fields are silent-null when extraction
  // misses them; resolver back-fills from concentrations. Loud-warn when
  // upstream extraction missed >2 of 7 to surface partial-extraction drift.
  const rawPctNullCount = [
    pool?.pctFixedRate, pool?.pctCovLite, pool?.pctBonds, pool?.pctCccAndBelow,
    pool?.pctSeniorSecured, pool?.pctSecondLien, pool?.pctCurrentPay,
  ].filter((v) => v == null).length;
  if (rawPctNullCount > 2) {
    warnings.push({
      field: "poolSummary.pct*",
      message: `${rawPctNullCount}/7 pool composition pct fields null in upstream extraction; resolver re-derived from concentrations. Verify ingest is reading the concentration table correctly.`,
      severity: "warn", blocking: false,
    });
  }

  // --- Triggers ---
  const eodConstraint =
    (constraints as unknown as { eventOfDefaultParValueTest?: { required_ratio_pct?: number; source_pages?: number[]; source_condition?: string } | null })
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
    warnings.push({
      field: "dates.maturity",
      message: `No maturity date found — using fallback ${resolvedMaturity} (current date + ${CLO_DEFAULTS.defaultMaxTenorYears} years). Set maturity manually.`,
      severity: "error",
      // Fallback horizon ≠ true maturity → wrong period count and
      // wrong cumulative interest; refuse.
      blocking: true,
    });
  }

  const resolvedNonCallPeriodEnd = constraints.keyDates?.nonCallPeriodEnd ?? null;
  if (resolvedNonCallPeriodEnd == null) {
    warnings.push({
      field: "dates.nonCallPeriodEnd",
      message:
        "Non-Call Period End not extracted. Every CLO has a PPM-defined " +
        "Non-Call Period (Condition 7.2); a missing value indicates an " +
        "extraction gap, not a deal without one. The runtime guard on " +
        "pre-NCP callDates is gated on this field — without it, a user " +
        "modelling a call could silently produce IRR for an economically " +
        "impossible scenario. Refusing to project until NCP is resolved.",
      severity: "error",
      blocking: true,
    });
  }

  const dates: ResolvedDates = {
    maturity: resolvedMaturity,
    reinvestmentPeriodEnd: dealDates?.reinvestmentPeriodEnd ?? constraints.keyDates?.reinvestmentPeriodEnd ?? null,
    nonCallPeriodEnd: resolvedNonCallPeriodEnd,
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

  // --- Senior Expenses Cap (PPM Condition 1) ---
  const seniorExpensesCap = resolveSeniorExpensesCap(constraints, warnings);

  // Bonds carry parBalance=0 by SDF convention (the "funded balance" concept
  // doesn't apply — their outstanding par lives in principalBalance). Use the
  // higher of the two so bonds aren't silently dropped. The SDF parser now
  // handles this at ingestion time; this fallback protects already-ingested
  // rows and any other source that mirrors the SDF convention. Defined here
  // (above the per-deal extraction gates) so the discount-obligation
  // blocking gate uses the SAME predicate as the downstream `activeHoldings`
  // filter — anti-pattern #1: helper duplication invites silent drift.
  const holdingPar = (h: typeof holdings[number]): number =>
    (h.parBalance && h.parBalance > 0) ? h.parBalance
    : (h.principalBalance && h.principalBalance > 0) ? h.principalBalance
    : 0;

  // --- Discount Obligation classification + cure rule (PPM Condition 1) ---
  // Sized against the active-holdings predicate (greenfield-exemption signal
  // matching `activeHoldings` below): if the deal carries no live positions
  // there is nothing to classify and the rule's absence is harmless. Once
  // any live position arrives, the rule must be present for the OC numerator's
  // per-position discount haircut to compute. Defaulted/zero-par rows do
  // NOT count — a workout-phase deal with all-defaulted holdings would
  // otherwise falsely block.
  const hasActiveHoldings = holdings.some(h => holdingPar(h) > 0 && !h.isDefaulted);
  const discountObligationRule = resolveDiscountObligation(
    constraints,
    warnings,
    hasActiveHoldings,
  );
  const longDatedValuationRule = resolveLongDatedObligation(
    constraints,
    warnings,
    hasActiveHoldings,
  );

  // --- Excess CCC Adjustment Amount (per-deal CCC haircut params) ---
  const { cccBucketLimitPct, cccMarketValuePct } = resolveCccThresholds(constraints, warnings);

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
      warnings.push({
        field: "reinvestmentOcTrigger.diversionPct",
        message: `Could not parse diversion percentage from "${reinvOcRaw.diversionAmount}" — defaulting to 50%`,
        severity: "error",
        blocking: true,
      });
    }
  } else if (reinvOcRaw?.trigger) {
    warnings.push({
      field: "reinvestmentOcTrigger.diversionPct",
      message: `Reinvestment OC trigger found but no diversion amount specified — defaulting to 50%`,
      severity: "error",
      blocking: true,
    });
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
        warnings.push({ field: "reinvestmentOcTrigger", message: `Reinvestment OC trigger ${triggerLevel} looks like a ratio, converting to ${triggerLevel * 100}%`, severity: "warn", blocking: false });
        triggerLevel = triggerLevel * 100;
      }
      if (triggerLevel < 103) {
        warnings.push({
          field: "reinvestmentOcTrigger",
          message: `PPM reinvestmentOcTest.trigger is ${triggerLevel}% — implausibly low (typical range 103-106%). Likely the §10(a)(iv) EoD threshold (102.5%) misassigned. Ignoring PPM value.`,
          severity: "warn", blocking: false,
        });
      } else {
        if (triggerLevel > 200) {
          warnings.push({ field: "reinvestmentOcTrigger", message: `Reinvestment OC trigger ${triggerLevel}% seems unusually high`, severity: "warn", blocking: false });
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

  // Catch the residual non-portability shape the L374 blocking gate doesn't
  // subsume: PPM mentioned a reinvestment OC test (compliance test row OR PPM
  // raw constraint) but no fall-through path produced a usable trigger
  // (compliance triggerLevel null, PPM trigger filtered as implausibly low,
  // AND no class OC trigger >= 103). Engine `projection.ts:2505` gates Step V
  // diversion behind a truthy check on `reinvestmentOcTrigger` — a null
  // trigger silently disables the diversion mechanism the PPM specified.
  // Refuse rather than emit a "passing" projection computed against an
  // absent test.
  if (!reinvestmentOcTrigger && (complianceReinvOc != null || reinvOcRaw != null)) {
    warnings.push({
      field: "reinvestmentOcTrigger",
      message: "PPM mentioned a reinvestment OC test (compliance test row or PPM raw constraint) but no fall-through path produced a usable trigger — compliance triggerLevel was null, PPM trigger was filtered as implausibly low, AND no class OC trigger ≥ 103. Engine would silently skip Step V diversion. Refuse and verify the reinvestment-OC threshold extraction upstream.",
      severity: "error",
      blocking: true,
    });
  }

  // --- Loans ---
  const fallbackMaturity = resolvedMaturity;

  // Per-position Discount Obligation classification helper. Resolver
  // dispatches on the per-deal rule's `classificationThresholdPct`
  // discriminated union: `single` applies one cutoff to every position,
  // `split_by_rate_type` reads the rate-type flag and picks the
  // floating/fixed cutoff. Used as a derivation fallback when the SDF
  // path didn't populate `is_discount_obligation` on the holding row;
  // returns null when the rule is missing OR the holding has no usable
  // purchase price (resolver has already blocked on missing rule via
  // resolveDiscountObligation; this null path covers greenfield
  // fixtures and synthetic test inputs).
  const classifyAsDiscountObligation = (
    purchasePricePct: number | null,
    isFixedRate: boolean,
  ): boolean | undefined => {
    if (discountObligationRule == null) return undefined;
    if (purchasePricePct == null || purchasePricePct <= 0) return undefined;
    const t = discountObligationRule.classificationThresholdPct;
    const threshold =
      t.type === "single" ? t.pct : isFixedRate ? t.fixedPct : t.floatingPct;
    return purchasePricePct < threshold;
  };

  // `holdingPar` and the active-holdings predicate are defined above
  // (just before the discount-obligation gate) so a single helper backs
  // both the gate and the consumer-side `activeHoldings` filter.
  const activeHoldings = holdings.filter(h => holdingPar(h) > 0 && !h.isDefaulted);
  const nonDdtlHoldings = activeHoldings.filter(h => !h.isDelayedDraw);

  // --- Rating Agencies set (computed pre-loop so the resolveMoodysRating /
  //     resolveFitchRating helpers can gate cross-agency derivation +
  //     terminal-fallback rungs on per-deal agency-set membership). The
  //     empty-set / asymmetry diagnostic warnings are emitted further down. ---
  const ratingAgencies: ("moodys" | "sp" | "fitch")[] = [];
  {
    const cs = constraints.capitalStructure ?? [];
    if (cs.some((e) => e.rating?.moodys != null && e.rating.moodys.trim() !== "")) ratingAgencies.push("moodys");
    if (cs.some((e) => e.rating?.sp != null && e.rating.sp.trim() !== "")) ratingAgencies.push("sp");
    if (cs.some((e) => e.rating?.fitch != null && e.rating.fitch.trim() !== "")) ratingAgencies.push("fitch");
  }

  // Per-position Intex shadow-rating lookup (lxid → isin → facility_id).
  // Empty Map when no Intex positions ingested for this period — the helper
  // falls through to SDF-only resolution. ratingDefinitions (cross-agency
  // derivation tables + terminal default) is currently NOT extracted from
  // the PPM; rungs 7–9 of the ladder remain inert until that extractor
  // ships. Per-position absent ratings emit warn-level diagnostics inside
  // the loop.
  const intexLookup = (intexPositions ?? new Map()) as Map<string, IntexPositionRow>;
  const lookupIntex = (h: CloHolding): IntexPositionRow | undefined =>
    (h.lxid ? intexLookup.get(h.lxid) : undefined)
    ?? (h.isin ? intexLookup.get(h.isin) : undefined)
    ?? (h.facilityId ? intexLookup.get(h.facilityId) : undefined);

  // Collected per-position absent-rating obligors. Aggregated into one
  // blocking warning per agency after the loop — each absent position would
  // silently understate the per-agency Caa/CCC concentration denominator
  // (anti-pattern #3). Active holdings only (defaulted are filtered above).
  const moodysAbsentObligors: string[] = [];
  const fitchAbsentObligors: string[] = [];

  const loans: ResolvedLoan[] = activeHoldings.map(h => {
    const isFixed = h.isFixedRate === true;
    const isDdtl = h.isDelayedDraw === true;
    // Clean rating sentinels defensively — pre-fix rows in the DB still carry
    // "***" / "NR" / "--" etc. from the SDF; trimRating handles new ingests.
    const moodys = cleanRating(h.moodysRating);
    const sp = cleanRating(h.spRating);
    const fitch = cleanRating(h.fitchRating);
    const spFinal = cleanRating(h.spRatingFinal);
    const moodysDp = cleanRating(h.moodysDpRating);

    // Per-position rating ladder (resolve-rating.ts is the single owner of
    // the PPM "Moody's Rating" / "Fitch Rating" definition). SDF channels →
    // Intex shadow channels → cross-agency derivation (gated on extraction)
    // → terminal default (gated on extraction) → absent. Absent positions
    // on a non-LML, non-defaulted holding silently understate the Caa/CCC
    // concentration denominator — we collect them post-loop and emit ONE
    // blocking warning per agency, listing every affected obligor.
    const intex = lookupIntex(h);
    const moodysResolution = resolveMoodysRating(h, intex, { ratingAgencies, ratingDefinitions: undefined });
    const fitchResolution = resolveFitchRating(h, intex, { ratingAgencies, ratingDefinitions: undefined });
    const moodysFinal = moodysResolution.rating;
    const fitchFinal = fitchResolution.rating;
    if (moodysResolution.source === "absent" && ratingAgencies.includes("moodys")) {
      moodysAbsentObligors.push(h.obligorName ?? h.lxid ?? h.isin ?? h.facilityId ?? "unknown");
    }
    if (fitchResolution.source === "absent" && ratingAgencies.includes("fitch")) {
      fitchAbsentObligors.push(h.obligorName ?? h.lxid ?? h.isin ?? h.facilityId ?? "unknown");
    }
    const isCEP = moodysResolution.isCreditEstimateOrPrivate || fitchResolution.isCreditEstimateOrPrivate;

    const ratingBucket = mapToRatingBucket(moodys, sp, fitch, cleanRating(h.compositeRating));

    let fixedCouponPct: number | undefined;
    if (isFixed) {
      if (h.allInRate != null) {
        fixedCouponPct = h.allInRate;
      } else if (h.spreadBps != null) {
        fixedCouponPct = h.spreadBps / 100;
        warnings.push({
          field: "fixedCouponPct",
          message: `Fixed-rate loan "${h.obligorName ?? "unknown"}" has no allInRate — engine would proxy via spreadBps (${h.spreadBps} bps → ${fixedCouponPct}% coupon), but spread is the basis-rate-add of a floater, not a fixed coupon. Wrong substitution yields per-period coupon-accrual error of (true_coupon − spread/100) × par on this position. Refuse and set allInRate explicitly upstream.`,
          severity: "error",
          blocking: true,
        });
      } else {
        fixedCouponPct = wacSpreadBps / 100;
        warnings.push({
          field: "fixedCouponPct",
          message: `Fixed-rate loan "${h.obligorName ?? "unknown"}" has neither allInRate nor spreadBps — engine would fall back to pool WAC (${fixedCouponPct}% coupon). Magnitude unbounded: a fixed-rate bond paying 8% with WAC of 4% would accrue at 4% every period, understating coupon by 50% × par on this position. Refuse and set allInRate explicitly upstream.`,
          severity: "error",
          blocking: true,
        });
      }
    }

    let ddtlSpreadBps: number | undefined;
    if (isDdtl) {
      const candidates = nonDdtlHoldings.filter(c => c.obligorName != null && c.obligorName === h.obligorName);
      if (candidates.length > 1) {
        warnings.push({ field: "ddtlSpreadBps", message: `DDTL "${h.obligorName ?? "unknown"}" matched ${candidates.length} parent facilities — using largest par with closest maturity as tiebreaker.`, severity: "warn", blocking: false });
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
        warnings.push({
          field: "ddtlSpreadBps",
          message: `DDTL "${h.obligorName ?? "unknown"}" has no matching parent facility (no funded holding shares its obligorName) — engine would assign the pool WAC (${wacSpreadBps} bps) as the draw spread. On a deal where the DDTL's true facility spread diverges from WAC, every period after draw accrues at the wrong rate; magnitude is per-loan and unbounded. Refuse and verify the parent-facility obligorName upstream.`,
          severity: "error",
          blocking: true,
        });
      }
    }

    // Moody's uses its DP (Default Probability) rating for WARF when available,
    // falling back to the final/published rating, then the raw Moody's rating.
    const warfFactor =
      moodysWarfFactor(moodysDp)
      ?? moodysWarfFactor(moodysFinal)
      ?? moodysWarfFactor(moodys)
      ?? undefined;

    // Per-loan accrual convention. Block if non-empty unrecognized OR if
    // null on a fixed-rate position (no market default for fixed). Floating
    // null falls back to Actual/360 with severity:"warn" (data-quality
    // signal: market default IS Actual/360 for Euro paper, but non-Euro
    // floating positions use other conventions, so a missing DCC merits
    // more than an FYI).
    const dccResult = canonicalizeDayCount(h.dayCountConvention, {
      isFixedRate: isFixed,
      field: `${h.obligorName ?? "unknown"}.dayCountConvention`,
    });
    if (dccResult.warning) {
      warnings.push(
        dccResult.blocking
          ? { field: "dayCountConvention", message: dccResult.warning, severity: "error", blocking: true }
          : { field: "dayCountConvention", message: dccResult.warning, severity: "warn", blocking: false },
      );
    }

    // Per-loan EURIBOR floor sign + scale invariants (anti-pattern #5).
    // Source convention is PERCENT (e.g. 0.5 = 50bp) on the SDF
    // Collateral File path; magnitude validator rejects > 50%. Sign
    // invariant: a negative floor is structurally meaningless (a floor
    // below zero is no floor at all). Catching it here rather than in
    // the engine because the boundary is the right place to enforce
    // type-system gaps.
    if (h.floorRate != null && h.floorRate < 0) {
      warnings.push({
        field: "floorRate",
        message: `Holding "${h.obligorName ?? "unknown"}": floorRate=${h.floorRate} is negative. Per-position EURIBOR floors are non-negative by construction; a negative value indicates a parser failure or upstream sign-convention error. Refuse and verify the floor_rate ingestion.`,
        severity: "error",
        blocking: true,
      });
    } else if (h.floorRate != null && h.floorRate > 5) {
      warnings.push({
        field: "floorRate",
        message: `Holding "${h.obligorName ?? "unknown"}": floorRate=${h.floorRate}% is implausibly high (typical Euro CLO floors 0.0–1.0%). Likely scale or locale mis-parse.`,
        severity: "warn",
        blocking: false,
      });
    }

    // PIK classification + forward rate (anti-pattern #3, anti-pattern #5).
    //
    // `isPik` (boolean, observability/audit): "structurally PIK" — pikAmount
    //   > 0 OR explicit override. Used by the switch-simulator's pctPik
    //   recompute (semantic: actively accreting PIK; see pikSpreadBps below).
    //
    // `pikSpreadBps` (number, engine dispatch): live forward PIK rate in
    //   basis points. Engine accretes
    //   `par × pikSpreadBps/10000 × dayFrac` to surviving par per period
    //   when > 0; additive on top of the cash leg. Zero means PIK toggle is
    //   currently off (Tele Columbus shape — historical PIK in pikAmount,
    //   no forward accretion).
    //
    // Blocking ladder:
    //   (a) `pikAmount < 0`               → block (sign invariant)
    //   (b) `pikSpreadBps < 0`            → block (sign invariant)
    //   (c) `pikSpreadBps > 1500`         → block (implausible — distressed
    //                                        Euro CLO PIK margins top ~10-12%;
    //                                        15% is the hard ceiling for
    //                                        locale-mis-parse hardening)
    //   (d) `isPik === false AND pikAmount > 0`
    //                                     → block (data-shape contradiction)
    //   (e) `pikAmount > 0 AND pikSpreadBps == null`
    //                                     → block (extraction gap on a
    //                                        position whose source data
    //                                        demonstrates PIK structure)
    //
    // Cases (a–e) failing → no derived flags. Otherwise:
    //   - `isPik === true` (explicit) OR `isPik == null AND pikAmount > 0`
    //       → derivedIsPik = true
    //   - `isPik === false` (explicit, with pikAmount in {null, 0})
    //       → derivedIsPik = false
    //   - else                            → undefined
    //
    // pikSpreadBps propagates 1:1 (zero passes through; only > 0 drives
    // engine accretion).
    let derivedIsPik: boolean | undefined;
    let derivedPikSpreadBps: number | undefined;
    if (h.pikAmount != null && h.pikAmount < 0) {
      warnings.push({
        field: "pikAmount",
        message: `Holding "${h.obligorName ?? "unknown"}": pikAmount=${h.pikAmount} is negative. PIK accruals are non-negative by construction; a negative value indicates a parser failure or upstream sign-convention error. Refuse and verify the pik_amount ingestion.`,
        severity: "error",
        blocking: true,
      });
    } else if (h.pikSpreadBps != null && h.pikSpreadBps < 0) {
      warnings.push({
        field: "pikSpreadBps",
        message: `Holding "${h.obligorName ?? "unknown"}": pikSpreadBps=${h.pikSpreadBps} is negative. PIK margin is non-negative by construction; a negative value indicates a parser failure or sign-convention error. Refuse and verify the Current_Facility_Spread_PIK ingestion.`,
        severity: "error",
        blocking: true,
      });
    } else if (h.pikSpreadBps != null && h.pikSpreadBps > 1500) {
      warnings.push({
        field: "pikSpreadBps",
        message: `Holding "${h.obligorName ?? "unknown"}": pikSpreadBps=${h.pikSpreadBps} (=${(h.pikSpreadBps / 100).toFixed(2)}%) exceeds the 15% (1500 bps) implausibility ceiling. Distressed Euro CLO PIK margins top ~10-12%; values above 15% indicate a locale mis-parse (decimal/thousands confusion) or unit error. Refuse and reconcile upstream.`,
        severity: "error",
        blocking: true,
      });
    } else if (h.isPik === false && (h.pikAmount ?? 0) > 0) {
      warnings.push({
        field: "isPik",
        message: `Holding "${h.obligorName ?? "unknown"}": isPik=false but pikAmount=${h.pikAmount} > 0. The source reports per-period PIK accrual on a position the structural flag claims is non-PIK; one of the two is wrong. The model cannot represent this contradiction — treating the loan as cash-paying over-states cash interest by ${h.pikAmount} this period; treating it as PIK contradicts the explicit flag. Refuse and reconcile upstream.`,
        severity: "error",
        blocking: true,
      });
    } else if ((h.pikAmount ?? 0) > 0 && h.pikSpreadBps == null) {
      warnings.push({
        field: "pikSpreadBps",
        message: `Holding "${h.obligorName ?? "unknown"}": pikAmount=${h.pikAmount} > 0 but pikSpreadBps is missing. The source data demonstrates PIK structure (cumulative PIK already accreted); the engine cannot dispatch forward PIK accretion without the live rate (Current_Facility_Spread_PIK). Refuse and verify the Asset_Level CSV extraction.`,
        severity: "error",
        blocking: true,
      });
    } else {
      // Derive isPik (observability)
      if (h.isPik === true) {
        derivedIsPik = true;
      } else if (h.isPik == null && (h.pikAmount ?? 0) > 0) {
        // Parser-side derivation should already have set is_pik=true on
        // this row; fallback covers DB rows ingested before the parser
        // change.
        derivedIsPik = true;
      } else if (h.isPik === false) {
        derivedIsPik = false;
      }
      // Propagate pikSpreadBps (engine dispatch). Zero passes through and
      // is the explicit "PIK toggle off" signal — the engine guards on
      // > 0 before accreting.
      if (h.pikSpreadBps != null) {
        derivedPikSpreadBps = h.pikSpreadBps;
      }
    }

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
      // Derived ratings (resolved via the rating ladder)
      moodysRatingFinal: moodysFinal ?? undefined,
      spRatingFinal: spFinal ?? undefined,
      fitchRatingFinal: fitchFinal ?? undefined,
      // Lineage tags from the rating ladder. Drive partner-facing
      // pctMoodysRatingDerivedFromSp + pctOnCreditEstimateOrPrivateRating
      // pool-metrics outputs and the consumer-side blocking gate.
      moodysRatingSource: moodysResolution.source,
      fitchRatingSource: fitchResolution.source,
      isCreditEstimateOrPrivateRating: isCEP || undefined,
      // Market data
      currentPrice: h.currentPrice ?? undefined,
      marketValue: h.marketValue ?? undefined,
      // Per-position agency recovery rates — propagate raw (unnormalized) so
      // the engine's forward-default site can call the same `resolveAgencyRecovery`
      // helper used at the T=0 site. Centralizing the convention in one helper
      // is the canonical anti-drift template; see `recovery-rate.ts`.
      // Intex provides per-agency derived recovery rates as a competing source
      // when the SDF doesn't carry the column. Fall back per agency rather
      // than at the helper level so any per-position SDF rate that IS present
      // wins (single-source-of-truth invariant for agency-rate selection).
      recoveryRateMoodys: h.recoveryRateMoodys ?? intex?.moodyDerivedRecoveryRate ?? undefined,
      recoveryRateSp: h.recoveryRateSp ?? intex?.spDerivedRecoveryRate ?? undefined,
      recoveryRateFitch: h.recoveryRateFitch ?? intex?.fitchDerivedRecoveryRate ?? undefined,
      // Structural
      lienType: h.lienType ?? undefined,
      isDefaulted: h.isDefaulted ?? undefined,
      defaultDate: h.defaultDate ?? undefined,
      floorRate: h.floorRate ?? undefined,
      isCovLite: h.isCovLite ?? undefined,
      isPik: derivedIsPik,
      pikSpreadBps: derivedPikSpreadBps,
      warfFactor,
      // Floating WAS denominator excludes Non-Euro Obligations per PPM
      // Condition 1 (PDF p. 302). Sourced from holding's `currency` (post-
      // enrichment) or `nativeCurrency` (raw); upper-cased. Undefined means
      // the loan is assumed deal-currency-denominated.
      currency: (h.currency ?? h.nativeCurrency ?? undefined)?.trim().toUpperCase() || undefined,
      // isDeferring / isLossMitigationLoan are CM-designation flags not
      // present in the SDF. Resolver leaves undefined; only relevant for
      // distressed deals where the source extends to populate them.
      dayCountConvention: dccResult.convention,
      // Per-position discount-obligation + long-dated state. Purchase
      // price + acquisition date carry forward through the engine;
      // classification flags are populated from the SDF row when the
      // LLM/PDF extraction path filled them, else derived from the
      // per-deal rule (discount) or universal rule (long-dated:
      // maturityDate > deal maturity). The engine consumes these
      // per-period at the OC numerator construction site rather than
      // the trustee `discountObligationHaircut` / `longDatedObligationHaircut`
      // scalars (which are retained as reconciliation references).
      purchasePricePct:
        h.purchasePrice != null && h.purchasePrice > 0 ? h.purchasePrice : undefined,
      acquisitionDate: h.acquisitionDate ?? undefined,
      isDiscountObligation:
        h.isDiscountObligation ??
        classifyAsDiscountObligation(h.purchasePrice ?? null, isFixed),
      isLongDated:
        h.isLongDated ??
        (h.maturityDate != null && fallbackMaturity != null
          ? new Date(h.maturityDate).getTime() > new Date(fallbackMaturity).getTime()
          : undefined),
    });
  });

  // Aggregate per-position absent ratings into ONE blocking warning per
  // agency (anti-pattern #3). Each unresolved position would silently land
  // in the agency's Caa/CCC concentration denominator with no rating, so
  // the helper's bucket fallback fires — understating concentration on
  // every Caa-rated obligor whose SDF channel is empty and Intex isn't
  // ingested. Refusing to project is the correct partner-facing behavior
  // ("partner sees nothing < partner sees a plausible-but-wrong number").
  // The DATA INCOMPLETE banner (selectBlockingWarnings → IncompleteDataError
  // in build-projection-inputs.ts) lists the affected obligors so the user
  // knows exactly which positions need Intex coverage.
  if (moodysAbsentObligors.length > 0) {
    const sample = moodysAbsentObligors.slice(0, 8).join(", ");
    const more = moodysAbsentObligors.length > 8 ? ` (+${moodysAbsentObligors.length - 8} more)` : "";
    warnings.push({
      field: "moodysRating",
      message:
        `${moodysAbsentObligors.length} active position(s) have no Moody's rating in any SDF or Intex channel: ${sample}${more}. ` +
        `These positions silently fall into the bucket-rating fallback for the per-agency Caa Obligations test, understating the trustee-reported concentration. ` +
        `Ingest the Intex DealCF positions CSV (Structured Data Files upload) so per-position shadow ratings populate.`,
      severity: "error",
      blocking: true,
    });
  }
  if (fitchAbsentObligors.length > 0) {
    const sample = fitchAbsentObligors.slice(0, 8).join(", ");
    const more = fitchAbsentObligors.length > 8 ? ` (+${fitchAbsentObligors.length - 8} more)` : "";
    warnings.push({
      field: "fitchRating",
      message:
        `${fitchAbsentObligors.length} active position(s) have no Fitch rating in any SDF or Intex channel: ${sample}${more}. ` +
        `These positions silently fall into the bucket-rating fallback for the per-agency Fitch CCC Obligations test, understating the trustee-reported concentration. ` +
        `Ingest the Intex DealCF positions CSV (Structured Data Files upload) so per-position shadow ratings populate.`,
      severity: "error",
      blocking: true,
    });
  }

  // --- Rating Agencies safety-net warnings ---
  // The set itself is computed pre-loop (above) so the rating-ladder helpers
  // can gate cross-agency derivation. Strict by indenture: derived only from
  // tranche capital-structure rating columns; distinct from the permissive
  // `isMoodysRated` / `isFitchRated` / `isSpRated` booleans that OR in
  // compliance-test-name evidence. The two diverge only on extraction-gap
  // shapes; the safety-net warnings below catch that case.
  const cs = constraints.capitalStructure ?? [];

  // Sub-fix A safety net: tranche capital structure has any agency rating
  // data populated, but the derived ratingAgencies set has fewer than 2
  // agencies. Failure shapes this catches: SDF extraction dropped one
  // column it should have populated, or tranche structure didn't transcribe
  // rating sub-fields. Per CLAUDE.md anti-pattern #3 the resolver flags
  // computational-input gaps loudly; non-blocking because a genuinely
  // single-agency-rated deal is uncommon-but-legitimate, and the helper
  // already handles a single-agency subset gracefully.
  const anyTrancheRatingDataPresent = cs.some(
    (e) =>
      (e.rating?.moodys != null && e.rating.moodys.trim() !== "") ||
      (e.rating?.sp != null && e.rating.sp.trim() !== "") ||
      (e.rating?.fitch != null && e.rating.fitch.trim() !== ""),
  );
  if (ratingAgencies.length === 0) {
    // Empty-set is the silent-fallback shape the engine guard cannot catch:
    // capital structure absent or no rating columns populated → empty subset
    // → `resolveAgencyRecovery` returns undefined → forward-default site
    // silently falls back to the global `recoveryPct`. Per anti-pattern #3
    // the resolver flags computational gaps loudly. Blocking because every
    // CLO indenture names ≥ 1 Rating Agency by definition; an empty derived
    // set means extraction failed and the OC numerator cannot be computed.
    warnings.push({
      field: "ratingAgencies",
      message:
        `Derived Rating Agencies set is empty. Every CLO indenture names ≥ 1 Rating ` +
        `Agency; an empty derived set means tranche capital-structure rating columns ` +
        `(moodys / sp / fitch) failed extraction or are not present. The Adjusted CPA ` +
        `paragraph (e) recovery-rate min and the forward-default site both depend on ` +
        `this set; running with an empty subset would silently fall back to the global ` +
        `recoveryPct on every loan. Verify SDF Notes ratings columns and PPM ` +
        `capital-structure rating fields on this deal.`,
      severity: "error", blocking: true,
    });
  } else if (anyTrancheRatingDataPresent && ratingAgencies.length < 2) {
    warnings.push({
      field: "ratingAgencies",
      message:
        `Derived Rating Agencies set [${ratingAgencies.join(", ")}] has fewer ` +
        `than 2 agencies on a deal whose tranche capital structure carries agency rating data. ` +
        `A genuinely single-agency-rated deal is uncommon for European CLOs; this likely ` +
        `indicates an extraction gap on one rating column. The Adjusted CPA paragraph (e) ` +
        `recovery-rate min applies over the deal's Rating Agencies subset only — a missing ` +
        `agency narrows that min and biases the OC numerator. Verify SDF Notes ratings columns ` +
        `and PPM capital-structure rating fields on this deal.`,
      severity: "error", blocking: false,
    });
  }

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
      // currentPrice is percent-canonical (parser-side `validateMagnitude("market_value", ...)`
      // floors to 1 — fraction-shape regressions are rejected at the parser boundary).
      preExistingDefaultRecovery += par * (h.currentPrice / 100);
    } else {
      unpricedDefaultedPar += par;
    }
  }
  // OC numerator credit per defaulted holding — Adjusted CPA paragraph (e)
  // (oc.txt:7120-7124) reads "the lesser of (i) its Fitch Collateral Value
  // and (ii) its Moody's Collateral Value", with each Collateral Value
  // (oc.txt:8765-8777, 9420-9434) defined as `min(Market Value, Recovery
  // Rate) × Principal Balance`. The helper takes the per-agency MV floor
  // BEFORE the cross-agency min; the agency subset is the deal's Rating
  // Agencies (oc.txt:368-369). Plus paragraph (e)'s 3-year zero-out on stale
  // Defaulted Obligations, applied at the holding level.
  // Parse reportDate up-front. If reportDate is null or unparseable, the
  // 3-year staleness check cannot fire (no anchor); lenient default applies
  // (no zero-out). The reportDate-null case is a separate extraction-gate
  // concern (other resolver blocks handle it); here we just treat it as
  // "can't evaluate staleness" without surfacing a duplicate warning.
  const determinationDateObj =
    reportDate != null ? new Date(reportDate) : null;
  const determinationMs =
    determinationDateObj != null && !Number.isNaN(determinationDateObj.getTime())
      ? determinationDateObj.getTime()
      : null;
  const STALE_DEFAULT_THRESHOLD_DAYS = 365 * 3 + 1; // > 3 years; +1 to exclude exactly-3y boundary
  const preExistingDefaultOcValue = defaultedHoldings.reduce((s, h) => {
    const par = holdingPar(h);

    // Sub-fix C: 3-year stale-default zero-out per paragraph (e) proviso.
    // A holding that has been defaulted for > 3 years and continues to be
    // defaulted contributes 0 to the OC numerator, regardless of agency
    // rates or market value. Lenient on missing defaultDate (full RR
    // applies) — see warning below.
    if (h.defaultDate != null && determinationMs != null) {
      const defaultDate = new Date(h.defaultDate);
      if (!Number.isNaN(defaultDate.getTime())) {
        const daysSinceDefault =
          (determinationMs - defaultDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceDefault > STALE_DEFAULT_THRESHOLD_DAYS) {
          return s;
        }
      }
    } else if (h.defaultDate == null) {
      // Per CLAUDE.md anti-pattern #3 — `defaultDate` is computational input
      // (3-year zero-out predicate). Missing on a defaulted holding is an
      // extraction gap. Non-blocking: the gap silently passes the holding
      // through at the lenient (not-stale) side; warning preserves visibility.
      warnings.push({
        field: "holdings.defaultDate",
        message:
          `Defaulted holding "${(h as { obligorName?: string | null }).obligorName ?? "(unnamed)"}" ` +
          `has no defaultDate populated. Cannot evaluate Adjusted CPA paragraph (e) 3-year ` +
          `stale-default zero-out; lenient default applies (full agency/MV credit). Verify SDF ` +
          `Default_Date column or trustee-report defaulted-asset table.`,
        severity: "error", blocking: false,
      });
    } else {
      // h.defaultDate != null && determinationMs == null — reportDate is
      // null/unparseable so the staleness anchor is missing. Lenient default
      // applies (no zero-out). Warn so the gap is visible; reportDate-null
      // typically blocks elsewhere on fully-ingested periods, but on Intex-
      // only historical periods (where the account-balances gate doesn't
      // fire) this is the only surface.
      warnings.push({
        field: "holdings.staleness.reportDate",
        message:
          `Defaulted holding "${(h as { obligorName?: string | null }).obligorName ?? "(unnamed)"}" ` +
          `has defaultDate=${h.defaultDate} but reportDate is null/unparseable — cannot evaluate ` +
          `Adjusted CPA paragraph (e) 3-year stale-default zero-out. Lenient default applies ` +
          `(full agency/MV credit).`,
        severity: "error", blocking: false,
      });
    }

    // Sub-fix B: per-agency MV floor via helper opt. Sub-fix A: agency subset
    // applied inside helper (rates outside the deal's Rating Agencies set
    // are dropped). Returns undefined when no subset-relevant rate exists;
    // we then fall through to the all-signals-missing branch.
    const agencyRate = resolveAgencyRecovery(
      {
        moodys: h.recoveryRateMoodys,
        sp: h.recoveryRateSp,
        fitch: h.recoveryRateFitch,
      },
      ratingAgencies,
      h.currentPrice != null && h.currentPrice > 0
        ? { mvFloor: h.currentPrice }
        : undefined,
    );
    if (agencyRate != null) {
      return s + par * agencyRate;
    }

    // No subset-relevant agency rates AND no MV — Moody's CV paragraph (b)
    // (oc.txt:9420-9434) falls through to MV in this case. We've already
    // exhausted agency rates above; if we got here, MV is the only signal.
    if (h.currentPrice != null && h.currentPrice > 0) {
      return s + par * (h.currentPrice / 100);
    }

    // No agency rates AND no market value — total data gap on a defaulted
    // holding. Per CLAUDE.md anti-pattern #3 a computational-input gap of
    // this severity is loud; non-blocking because the engine already
    // tolerates "0 OC credit" gracefully (the position is just absent from
    // the OC numerator), but the partner needs to know the model is silent
    // on a non-trivial position.
    warnings.push({
      field: "holdings.recoveryAndMV",
      message:
        `Defaulted holding "${(h as { obligorName?: string | null }).obligorName ?? "(unnamed)"}" ` +
        `(par=${par.toFixed(0)}) has neither agency recovery rates within the deal's Rating ` +
        `Agencies subset [${ratingAgencies.join(", ") || "(empty)"}] nor a market value. The OC ` +
        `numerator will not credit this position. Verify SDF Recovery_Rate columns or trustee-` +
        `report Market_Value column on this holding.`,
      severity: "error", blocking: false,
    });
    return s;
  }, 0);

  // --- Account-balances extraction gate ---
  // Every CLO has a populated set of trustee accounts: at minimum the Principal
  // Account, the Interest Account, and the standard reserve accounts (Expense
  // Reserve, Supplemental Reserve, Interest Smoothing). When the SDF compliance
  // bundle has been ingested for this period (compliance tests populated AND
  // tranche snapshots present) but the `accountBalances` array is missing or
  // empty, the SDF Accounts CSV was not parsed — partial extraction. Silent
  // fallback to zero on the four reserve balances would understate equity-side
  // cash claims and (for the Principal Account specifically) misstate the OC
  // numerator signed-overdraft term. CLAUDE.md principle 3: refuse to project
  // rather than substitute a "common default" guess.
  //
  // Predicate gates on `complianceTests.length > 0` rather than `complianceData
  // != null` so:
  //   - Intex-only historical periods (where `data_source = 'intex_past_cashflows'`
  //     populates `trancheSnapshots` but the SDF compliance bundle was never
  //     ingested → empty `complianceTests`) are NOT blocked. The SDF Accounts
  //     CSV is genuinely unavailable on those periods by design — the historical
  //     projection has no source data to demand.
  //   - Synthetic test fixtures with empty / `{}` complianceData fall through.
  //   - Production current-period runs (compliance tests fully populated)
  //     correctly require the Accounts section.
  const trusteeBundleIngested =
    (complianceData?.complianceTests?.length ?? 0) > 0 &&
    trancheSnapshots.length > 0;
  if (
    trusteeBundleIngested &&
    (accountBalances == null || accountBalances.length === 0)
  ) {
    warnings.push({
      field: "accountBalances",
      message:
        "Account-balances section missing or empty despite the trustee " +
        "bundle (compliance data + tranche snapshots) being ingested. The " +
        "SDF Accounts CSV likely was not parsed for this period. Without " +
        "it, principalAccountCash, interestAccountCash, the three reserve " +
        "balances, and any overdraft default silently to zero — wrong " +
        "engine output on any deal whose accounts are non-zero. Refusing " +
        "until extraction lands.",
      severity: "error",
      blocking: true,
    });
  }

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

  // --- D7: Non-principal account balances ---
  // Group remaining account rows by case-insensitive name match so downstream
  // consumers (UI, projection engine callers) can reference each PPM account
  // balance. Exposure only — NOT wired into the engine OC numerator, since
  // which accounts flow into the CPA is deal-specific per the PPM.
  // Rows with null balanceAmount are skipped; multiple matching rows are summed.
  //
  // Token matchers are broadened to handle abbreviated names — trustee reports
  // often use "SMOOTH" / "SUPP RES" / "EXP RES" instead of the full "Smoothing"
  // / "Supplemental" / "Expense Reserve". Strict "smoothing"/"supplemental"/
  // "expense" tokens would silently misroute abbreviated accounts into
  // `interestAccountCash` (the default interest bucket). Caught during Sprint 4
  // D7 review against Euro XV fixture which uses all three abbreviations.
  let interestAccountCash = 0;
  let interestSmoothingBalance = 0;
  let supplementalReserveBalance = 0;
  let expenseReserveBalance = 0;
  let unusedProceedsCash = 0;
  for (const a of accountBalances ?? []) {
    if (a.balanceAmount == null) continue;
    const name = (a.accountName ?? "").toLowerCase();
    // "smooth" matches both "smoothing" and "SMOOTH ACT".
    const isSmoothing = name.includes("smooth");
    // "supp" matches "supplemental" + "SUPP RES". Would also match "supply" /
    // "support" — not expected in PPM account taxonomy; revisit if it surfaces.
    const isSupplemental = name.includes("supp");
    // "exp res" / "expense" both match. The compound "exp res" token is
    // specific enough to avoid colliding with unrelated "exp"/"expiration"
    // account names.
    const isExpense = name.includes("expense") || name.includes("exp res");
    const isPrincipal = name.includes("principal") || name.includes("principle");
    // Mirror the principal-account convention: prefer the structured
    // `accountType` tag (set by the SDF parser's `deriveAccountType`),
    // fall back to substring on the raw name. Substring-only would silently
    // miss alternate UPA naming on the next deal (anti-pattern #1: overfit
    // to one deal's account labels). Per PPM Condition 1 CPA definition (d),
    // the UPA balance augments the Senior Expenses Cap base.
    // The boundary pattern matches `upa` only when surrounded by non-
    // alphanumeric chars (or string edges); JS `\b` treats `_` as a word
    // char, so plain `/\bupa\b/` would silently miss underscore-delimited
    // names like `"upa_account"` that some SDF vendors emit.
    const isUnusedProceeds =
      a.accountType === "UNUSED_PROCEEDS" ||
      name.includes("unused proceeds") ||
      /(?:^|[^a-z0-9])upa(?:[^a-z0-9]|$)/.test(name);
    if (isUnusedProceeds) {
      unusedProceedsCash += a.balanceAmount;
    } else if (isSmoothing) {
      interestSmoothingBalance += a.balanceAmount;
    } else if (isSupplemental) {
      supplementalReserveBalance += a.balanceAmount;
    } else if (isExpense) {
      expenseReserveBalance += a.balanceAmount;
    } else if (name.includes("interest") && !isPrincipal) {
      interestAccountCash += a.balanceAmount;
    }
  }

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

  // --- T=0 reconciliation: per-position derived discount haircut vs trustee scalar ---
  // The engine consumes the per-position derived haircut from
  // ResolvedLoan.purchasePricePct + isDiscountObligation at every
  // period. The trustee scalar above is an INDEPENDENT signal from
  // the compliance report's parValueAdjustments table — they should
  // agree at T=0 within tolerance. A drift means either (a) the SDF
  // holdings extraction missed some discount classifications that the
  // trustee carries (data-quality gap) or (b) the per-deal rule is
  // mis-extracted. Either way the partner needs to know — non-blocking
  // warning surfaces the drift without refusing the projection (the
  // scalar still rides forward as the long-dated haircut, and the
  // discount haircut comes from per-position state in commit 6).
  if (loans.length > 0 && discountObligationHaircut > 0) {
    const derivedHaircut = loans
      .filter(l => l.isDiscountObligation === true && l.purchasePricePct != null)
      .reduce((s, l) => s + l.parBalance * (1 - l.purchasePricePct! / 100), 0);
    const drift = Math.abs(derivedHaircut - discountObligationHaircut);
    const tolerance = Math.max(1000, discountObligationHaircut * 0.05);
    if (drift > tolerance) {
      warnings.push({
        field: "discountObligationHaircut",
        message:
          `T=0 reconciliation drift on discount-obligation haircut: ` +
          `per-position derived = ${Math.round(derivedHaircut).toLocaleString()}, ` +
          `trustee parValueAdjustments = ${Math.round(discountObligationHaircut).toLocaleString()}, ` +
          `delta ${Math.round(drift).toLocaleString()} > tolerance ${Math.round(tolerance).toLocaleString()}. ` +
          `Most likely the SDF holdings extraction missed some discount classifications that the trustee carries — verify isDiscountObligation flags / purchasePrice values on holdings. The engine consumes per-position state forward; this drift indicates the T=0 OC numerator may diverge from the trustee's reported number even before any forward projection.`,
        severity: "warn",
        blocking: false,
      });
    }
  }

  // --- T=0 reconciliation: per-position derived long-dated haircut vs trustee scalar ---
  // Engine consumes per-position dispatch via `longDatedValuationRule`;
  // the trustee `LONG_DATED_HAIRCUT` parValueAdjustments rows remain
  // an independent signal. Drift means either (a) the SDF holdings
  // extraction missed long-dated classifications the trustee carries,
  // or (b) the per-deal valuation rule (cap percentage / capBase /
  // postCap) is mis-extracted from the PPM. Approximation here is a
  // resolver-layer signal — it computes the engine's expected output
  // for Shape A (within=par, post=zero) and Shape B Σ-bound, not the
  // engine's exact per-period dispatch. Drift > tolerance still
  // surfaces a real mismatch worth investigating.
  if (loans.length > 0 && longDatedObligationHaircut > 0) {
    const longDatedPar = loans
      .filter(l => l.isLongDated === true && !l.isDelayedDraw)
      .reduce((s, l) => s + l.parBalance, 0);
    const apbApprox = loans.reduce((s, l) => s + (l.isDelayedDraw ? 0 : l.parBalance), 0);
    let derivedHaircut = 0;
    if (longDatedValuationRule != null && apbApprox > 0) {
      const baseAmount = longDatedValuationRule.capBase === "APB"
        ? apbApprox
        : apbApprox + principalAccountCash; // CPA approx at T=0
      const cap = baseAmount * (longDatedValuationRule.capPctOfBase / 100);
      const excess = Math.max(0, longDatedPar - cap);
      // Conservative under Shape A (within=par, post=zero) — drift
      // matches engine. Under Shape B (within=tiered_mv_or_capped),
      // this lower-bounds the derived haircut; drift > tolerance still
      // catches gross mis-extraction.
      derivedHaircut = excess;
    }
    const drift = Math.abs(derivedHaircut - longDatedObligationHaircut);
    const tolerance = Math.max(1000, longDatedObligationHaircut * 0.10);
    if (drift > tolerance) {
      warnings.push({
        field: "longDatedObligationHaircut",
        message:
          `T=0 reconciliation drift on long-dated haircut: ` +
          `per-position derived (resolver-approx) = ${Math.round(derivedHaircut).toLocaleString()}, ` +
          `trustee parValueAdjustments = ${Math.round(longDatedObligationHaircut).toLocaleString()}, ` +
          `delta ${Math.round(drift).toLocaleString()} > tolerance ${Math.round(tolerance).toLocaleString()}. ` +
          `Verify isLongDated flags on holdings (Σ par at maturityDate > deal maturity should match trustee long-dated par) and the per-deal long_dated_obligation rule (cap_pct_of_base / cap_base) in ppm.json.`,
        severity: "warn",
        blocking: false,
      });
    }
  }

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
      warnings.push({ field: "impliedOcAdjustment", message: `Adjusted CPA reconciliation has negative residual (${Math.round(implied).toLocaleString()}). Unmodeled trustee adjustments may be inflating the Adjusted CPA. OC adjustment set to 0.`, severity: "info", blocking: false });
    } else if (implied < 0) {
      // Negligible negative residual (rounding) — reconciliation effectively closes. No warning.
    } else if (implied > totalPar * 0.05) {
      warnings.push({ field: "impliedOcAdjustment", message: `Derived OC adjustment (${Math.round(implied).toLocaleString()}) is >5% of par — likely includes adjustments beyond unfunded revolvers. Capping at 0.`, severity: "warn", blocking: false });
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
    warnings.push({
      field: "deferredInterestCompounds",
      message: "Deal has deferrable tranches but PIK compounding info was not extracted as a boolean — engine would default to `true` (compound deferred interest). On a deal whose indenture specifies non-compounding, every period over-states the deferred balance, and the over-statement compounds across periods. Refuse and set interestMechanics.deferredInterestCompounds explicitly upstream.",
      severity: "error",
      blocking: true,
    });
  }

  // --- Interest Non-Payment Grace Period (PPM § 10(a)(i)) ---
  // Null = "use the engine's PPM-correct default" (0 periods). PPM § 10(a)(i)
  // cure windows are typically 5 business days post-payment-date — sub-period
  // in a quarterly model, so if a missed payment is still missed at the next
  // period checkpoint the cure has lapsed. Override only when modelling a
  // non-standard deal whose PPM grants a multi-period grace.
  //
  // Severity is `warn`, non-blocking: surfaced in the partner-facing
  // warnings panel (`ProjectionModel.tsx` filters only `info`), but the
  // projection is allowed to run because the wrong-direction error is
  // over-trigger (false EoD under stress), never under-trigger — the
  // displayed numbers are conservative-correct. When extraction lands,
  // flip this site to `severity: "error", blocking: true` — same shape
  // as the other computational-input blocking gates in this resolver.
  const interestNonPaymentGracePeriods: number | null = null;
  warnings.push({
    field: "interestNonPaymentGracePeriods",
    message:
      "PPM § 10(a)(i) interest-non-payment grace period not extracted; engine defaults to 0 (any senior-interest shortfall fires Event of Default immediately). This is the conservative PPM-correct default for the modal quarterly-payment CLO (sub-period cure windows lapse before the next checkpoint). A deal whose PPM grants a multi-period grace would over-trigger acceleration under stress; verify PPM § 10(a)(i) before relying on stress-scenario IRRs.",
    severity: "warn",
    blocking: false,
  });

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
      canonicalType: classifyComplianceTest(t.testName),
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
      const resolvedName = bucketName || ct.testName;
      // Classify on the richest available name. `bucketName` falls through to
      // `concentrationType` (e.g. "n", "o") on deals where `concentrations.bucketName`
      // is null, so a single-letter `resolvedName` would silently classify as
      // "other" and the silent-skip gate would then refuse to project. The
      // compliance-test row carries the lettered + English form ("(n) Moody's
      // Caa Obligations") which is unambiguous to the classifier; prefer it.
      return {
        testName: resolvedName,
        testClass: null,
        actualValue: ct.actualValue,
        triggerLevel: ct.triggerLevel,
        cushion: round4(ct.cushionPct ?? directionalCushion(ct.testType, ct.testName, ct.actualValue, ct.triggerLevel)),
        isPassing: ct.isPassing,
        canonicalType: classifyComplianceTest(ct.testName || bucketName),
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
      // Concentrations-row path has no testType — pass null so isHigherBetter
      // falls through to name-pattern + clause-letter dispatch on bucketName.
      cushion: round4(directionalCushion(null, bucketName, actualValue, triggerLevel)),
      isPassing: typeof c.isPassing === "boolean" ? c.isPassing : null,
      canonicalType: classifyComplianceTest(bucketName),
    };
  });

  // Per-deal rating-agency presence — drives the silent-skip blocking-gate
  // predicate so missing agency-tagged compliance triggers block on
  // rated-by-that-agency deals but are silently absent on not-rated deals.
  //
  // Derivation: OR across two evidence sources so the predicate fails CLOSED
  // (correctly Moody's-rated) whenever either the PPM capital structure OR
  // the SDF compliance data carries Moody's evidence. PPM-only would fail
  // OPEN on a deal whose extraction populated `capitalStructure` rows but
  // dropped the per-tranche `rating` subobjects — silently disabling all
  // three Moody's gates on a Moody's-rated deal. The qualityTests /
  // concentrationTests rows are independent SDF-sourced evidence; a row
  // matching `/moody/i` is conclusive even if PPM extraction missed.
  // Symmetric for Fitch via concentrationTests (Fitch CCC Concentration is
  // the canonical Fitch-tagged compliance test).
  const isMoodysRated =
    (constraints.capitalStructure ?? []).some(
      (e) => e.rating?.moodys != null && e.rating.moodys.trim() !== "",
    ) ||
    qualityTests.some((q) => /moody/i.test(q.testName)) ||
    concentrationTests.some((c) => /moody/i.test(c.testName));
  const isFitchRated =
    (constraints.capitalStructure ?? []).some(
      (e) => e.rating?.fitch != null && e.rating.fitch.trim() !== "",
    ) ||
    qualityTests.some((q) => /fitch/i.test(q.testName)) ||
    concentrationTests.some((c) => /fitch/i.test(c.testName));
  // S&P rating-agency detection. Module-scope `isSpTaggedTestName` excludes
  // cross-reference patterns (e.g. "Moody's Rating derived from S&P"); see
  // helper docstring. False on European CLOs (Euro XV is Fitch+Moody's per
  // oc.txt:368-369); true on US CLOs whose indenture names S&P as a
  // Rating Agency.
  const isSpRated =
    (constraints.capitalStructure ?? []).some(
      (e) => e.rating?.sp != null && e.rating.sp.trim() !== "",
    ) ||
    qualityTests.some((q) => isSpTaggedTestName(q.testName)) ||
    concentrationTests.some((c) => isSpTaggedTestName(c.testName));

  // Permissive-vs-strict asymmetry guard. The strict `ratingAgencies` set
  // (cap-structure-only, line ~1510) drives the OC numerator's per-agency
  // recovery dispatch. The permissive `isXRated` booleans (above) OR in
  // compliance-test-name evidence so the C1 gate doesn't false-skip on
  // tranche-column extraction gaps. The two diverge precisely on the deal
  // shape: cap-structure rating column for X is missing, but a compliance
  // test row references X. On such a deal the OC numerator silently drops
  // X's recovery rates from the per-agency min — wrong number, no signal.
  // Block here so the gap surfaces loudly; the user fixes extraction or
  // confirms the compliance-test detection was a false positive.
  const asymmetricAgencies: string[] = [];
  if (isMoodysRated && !ratingAgencies.includes("moodys")) asymmetricAgencies.push("moodys");
  if (isFitchRated && !ratingAgencies.includes("fitch")) asymmetricAgencies.push("fitch");
  if (isSpRated && !ratingAgencies.includes("sp")) asymmetricAgencies.push("sp");
  if (asymmetricAgencies.length > 0) {
    warnings.push({
      field: "ratingAgencies.asymmetry",
      message:
        `Rating Agencies asymmetry: compliance-test evidence flags the deal as rated by ` +
        `[${asymmetricAgencies.join(", ")}] but tranche capital-structure rating columns ` +
        `did not surface those agencies. The OC numerator's per-agency recovery dispatch ` +
        `(Adjusted CPA paragraph (e)) uses the strict cap-structure-derived set and would ` +
        `silently drop the missing agency's recovery rates. Either (a) extraction missed ` +
        `the tranche rating column — fix and re-ingest — or (b) the compliance-test name ` +
        `match was a cross-reference and the corresponding isXRated detection is a false ` +
        `positive — tighten the helper. Refusing to project until disambiguated.`,
      severity: "error", blocking: true,
    });
  }

  // C1 — silent-skip blocking gate for compliance triggers. Per PPM Section 8
  // (Collateral Quality Tests, PDF p. 287) the Moody's WARF Test, Moody's
  // Minimum Diversity Test, Moody's Recovery Rate Test, and Min Weighted
  // Average Floating Spread Test all apply "while Moody's-rated Notes are
  // outstanding"; the Fitch WARF / Recovery / CCC Concentration tests apply
  // "while Fitch-rated Notes are outstanding". A deal that IS rated by an
  // agency but has its trigger missing from extraction is an extraction
  // failure (silent-fallback per CLAUDE.md principle 3). On such a deal we
  // refuse to project rather than running with no enforcement on a test that
  // PPM-correct math would block. Deals NOT rated by the agency legitimately
  // omit the test → silent-skip is correct.
  const findQualityTrigger = (type: ComplianceTestType) => {
    const t = qualityTests.find((q) => q.canonicalType === type);
    return t?.triggerLevel ?? null;
  };
  const findConcentrationTrigger = (type: ComplianceTestType) => {
    const t = concentrationTests.find((q) => q.canonicalType === type);
    return t?.triggerLevel ?? null;
  };
  if (isMoodysRated) {
    if (findQualityTrigger("moodys_max_warf") == null) {
      warnings.push({
        field: "moodysWarfTriggerLevel",
        message:
          "Moody's-rated deal but Moody's Maximum WARF Test trigger not found in compliance qualityTests. " +
          "C1 reinvestment compliance cannot enforce against the WARF cap without it. Verify trustee report " +
          "exposes the test row, or extend extraction to surface the matrix-elected WARF trigger.",
        severity: "error", blocking: true,
      });
    }
    if (findQualityTrigger("min_was") == null) {
      warnings.push({
        field: "minWasBps",
        message:
          "Moody's-rated deal but Minimum Weighted Average Floating Spread Test trigger not found in " +
          "compliance qualityTests. C1 cannot enforce Min WAS without it. Verify trustee report exposes " +
          "the test row.",
        severity: "error", blocking: true,
      });
    }
    if (findConcentrationTrigger("moodys_caa_concentration") == null) {
      warnings.push({
        field: "moodysCaaLimitPct",
        message:
          "Moody's-rated deal but Moody's Caa Obligations concentration trigger not found in " +
          "concentrationTests. C1 cannot enforce Caa concentration without it. Verify trustee report " +
          "exposes test row '(n) Moody's Caa Obligations' (or equivalent).",
        severity: "error", blocking: true,
      });
    }
  }
  if (isFitchRated) {
    if (findConcentrationTrigger("fitch_ccc_concentration") == null) {
      warnings.push({
        field: "fitchCccLimitPct",
        message:
          "Fitch-rated deal but Fitch CCC Obligations concentration trigger not found in " +
          "concentrationTests. C1 cannot enforce Fitch CCC concentration without it. Verify trustee " +
          "report exposes test row '(o) Fitch - CCC Obligations' (or equivalent).",
        severity: "error", blocking: true,
      });
    }
  }
  // S&P-rated → require at least one S&P-tagged compliance trigger.
  // The Moody's/Fitch branches above enforce per-trigger presence by canonical
  // type (`moodys_max_warf`, `min_was`, `moodys_caa_concentration`,
  // `fitch_ccc_concentration`). S&P-canonical types are not yet enumerated in
  // `ComplianceTestType` (no US CLO PPM in scope to triangulate canonical
  // names). Until they land, the gate enforces the weaker invariant: an
  // S&P-rated deal MUST surface ≥1 S&P-tagged compliance test (by name); zero
  // S&P-tagged triggers on an S&P-rated deal is an extraction failure.
  // TODO: when a US CLO PPM enters scope, add `sp_*` canonical types and
  // per-trigger blocking branches matching the Moody's/Fitch shape above.
  if (isSpRated) {
    const hasAnySpTagged =
      qualityTests.some((q) => isSpTaggedTestName(q.testName)) ||
      concentrationTests.some((c) => isSpTaggedTestName(c.testName));
    if (!hasAnySpTagged) {
      warnings.push({
        field: "spComplianceTests",
        message:
          "S&P-rated deal but no S&P-tagged compliance triggers found in qualityTests or " +
          "concentrationTests (zero test names match the S&P-tagged pattern after cross-reference " +
          "exclusion). C1 cannot enforce S&P-specific compliance gates without them. Verify " +
          "trustee report exposes S&P-tagged test rows (e.g. 'S&P Recovery Rate Test', " +
          "'S&P CCC Concentration', 'S&P CDO Monitor').",
        severity: "error", blocking: true,
      });
    }
  }

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
        severity: "info", blocking: false,
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
        severity: "warn", blocking: false,
      });
    }
  }

  // (c) Compliance tests with both actualValue AND triggerLevel populated but
  // isPassing is null AND direction is genuinely unknown. The partner-
  // facing PASS/FAIL badge at `app/clo/page.tsx:143-146` reads off this
  // field directly and hides itself when null, so these rows show up to
  // the partner without a pass/fail signal. The direction predicate is
  // load-bearing: `isPassing == null` has multiple non-direction sources
  // (SDF `parsePassFail` returns null on its "Not Calculated" branch
  // and on its catch-all for unrecognized Pass_Fail strings — see
  // `sdf/parse-test-results.ts`); without the predicate, those rows
  // fire this warning with a misleading "direction could not be
  // determined" message. The cleaner signal — the SDF parser's
  // `isActive: false` flag — is not plumbed through to the resolver-
  // side compliance test type, so we can't distinguish "vendor declined
  // to compute" from "direction unknown" except by re-running the
  // classifier here. Display-side gap
  // only — no engine arithmetic depends on isPassing — so the warning is
  // severity warn, non-blocking, surfaced via the generic resolution-
  // warnings panel (`ProjectionModel.tsx:1101`, `ContextEditor.tsx:909`).
  {
    const ambiguousDirection = allComplianceTests.filter(t =>
      t.actualValue != null
      && t.triggerLevel != null
      && t.isPassing == null
      && isHigherBetter(t.testType, t.testName) === null
    );
    if (ambiguousDirection.length > 0) {
      const names = ambiguousDirection.map(t => t.testName).filter(Boolean).slice(0, 5).join("; ");
      warnings.push({
        field: "complianceTests.ambiguousDirection",
        message: `${ambiguousDirection.length} compliance test(s) have both actual value and trigger populated but no PASS/FAIL signal — direction (higher-is-better vs lower-is-better) could not be determined from testType / testName / clause-letter. PASS/FAIL badge unavailable on these rows. Examples: ${names}`,
        severity: "warn", blocking: false,
      });
    }
  }

  // (d) Join-vocabulary drift guard. The concentration-trigger join relies on
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
        // Display-only: this field does not enter ProjectionInputs or
        // any waterfall computation. The partner sees an out-of-date
        // concentration taxonomy in the table, never a wrong number.
        // Explicit `blocking: false` so the carve-out is mechanical,
        // not a comment-explained exception.
        blocking: false,
      });
    }
  }

  // D4 — compute top10ObligorsPct from the assembled loan list. Relies on
  // `obligorName` being populated on most positions (resolver does populate
  // it when the SDF row has it). Positions without an obligorName still
  // contribute to total par but not to any obligor bucket — so the metric
  // reflects only identifiable-obligor concentration.
  poolSummary.top10ObligorsPct = loans.length > 0 ? computeTopNObligorsPct(loans, 10) : null;

  // Deal currency. Prefer the deal-level field (CloDeal.dealCurrency) when
  // populated; otherwise derive from the par-weighted modal native_currency
  // across non-defaulted holdings. Null when neither is determinable — UI
  // surfaces a "Set deal currency" banner. Per CLAUDE.md § "Recurring
  // failure modes" principle 1, formatting code MUST read this field; never
  // hardcode `€`/`$`. Enforced by the `ui-hardcodes-currency-symbol` AST
  // rule in architecture-boundary.test.ts.
  let currency: string | null = dealDates?.dealCurrency?.trim() || null;
  if (!currency) {
    // Par-weighted modal — row-count would mis-call deals with a few
    // large foreign-currency positions among many small native-currency
    // ones (principle 1 — don't overfit Euro XV's mostly-uniform sizes).
    const parByCurrency = new Map<string, number>();
    for (const h of holdings) {
      if (h.isDefaulted) continue;
      const c = h.nativeCurrency?.trim().toUpperCase();
      if (!c) continue;
      parByCurrency.set(c, (parByCurrency.get(c) ?? 0) + holdingPar(h));
    }
    if (parByCurrency.size > 0) {
      let best = "";
      let bestPar = 0;
      for (const [c, p] of parByCurrency) {
        if (p > bestPar) { best = c; bestPar = p; }
      }
      currency = best;
    }
  }
  if (!currency) {
    warnings.push({
      field: "currency",
      message: "Deal currency could not be determined from dealCurrency or holdings. UI will display a 'Set deal currency' banner. Multi-currency modeling tracked under KI-38.",
      severity: "warn", blocking: false,
    });
  } else {
    currency = currency.toUpperCase();
  }

  // PPM Target Par Amount (Aggregate Excess Funded Spread denominator term).
  // Source priority: PPM `constraints.dealSizing.targetParAmount` (current
  // schema), else legacy top-level `constraints.targetParAmount`, else DB
  // `pool.targetPar` (number). Null when none — treated as zero in WAS
  // arithmetic with no blocking warning per the type docstring.
  const parseTargetParStr = (s: string | null | undefined): number | null => {
    if (!s || s.trim() === "") return null;
    const v = parseFloat(s.replace(/[^\d.-]/g, ""));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const targetParAmount =
    parseTargetParStr(constraints.dealSizing?.targetParAmount) ??
    parseTargetParStr(constraints.targetParAmount) ??
    (pool?.targetPar != null && pool.targetPar > 0 ? pool.targetPar : null);

  // PPM Reference Weighted Average Fixed Coupon (Excess WAC term, PPM
  // Condition 1, PDF p. 305). Per-deal extracted from PPM section 7
  // (interest mechanics). The prior implementation hardcoded 4.0% as a
  // "European CLO market standard" with an info-level warning — that
  // silent fallback is the exact CLAUDE.md principle 3 violation: a
  // partner-facing computational input (feeds Excess WAC → Min WAS
  // compliance gate) defaulting to a deal-family constant. Wrong on every
  // non-Ares deal whose reference WAFC is anything other than 4.0%. Now
  // reads from `interestMechanics.referenceWeightedAverageFixedCoupon`
  // (typed) or the raw passthrough `reference_weighted_average_fixed_coupon`
  // (snake_case from JSON ingest); blocks if missing.
  const ifmRaw = constraints.interestMechanics as unknown as Record<string, unknown> | undefined;
  const referenceWeightedAverageFixedCoupon: number | null =
    typeof constraints.interestMechanics?.referenceWeightedAverageFixedCoupon === "number"
      ? constraints.interestMechanics.referenceWeightedAverageFixedCoupon
      : typeof ifmRaw?.reference_weighted_average_fixed_coupon === "number"
        ? (ifmRaw.reference_weighted_average_fixed_coupon as number)
        : null;
  if (referenceWeightedAverageFixedCoupon == null) {
    // Excess WAC = (wafc − refWAFC) × 100 × (fixedPar / floatingPar). When
    // the deal has no fixed-rate loans, fixedPar = 0 and the term is zero
    // regardless of refWAFC — the absent extraction has no computational
    // effect and blocking would refuse a valid all-floating-rate CLO. The
    // engine never introduces fixed-rate loans during reinvestment (every
    // reinvestment row is `isFixedRate: false`, see projection.ts), so a
    // deal that starts all-floating stays all-floating. Block only when
    // any loan is fixed-rate; otherwise emit a non-blocking warn so the
    // partner sees the gap but the projection runs (with refWAFC defaulted
    // in the engine via `?? 4.0`, which is multiplied by zero anyway).
    const hasFixedRate = loans.some((l) => l.isFixedRate === true);
    if (hasFixedRate) {
      warnings.push({
        field: "referenceWeightedAverageFixedCoupon",
        message:
          "PPM Reference Weighted Average Fixed Coupon (Condition 1, PDF p. 305) is not extracted — required as the anchor for the Excess WAC term in Floating WAS compliance arithmetic on a deal that holds fixed-rate obligations. Without it, the per-period engine-vs-trustee Floating WAS would drift on any deal whose true reference differs from the previously-hardcoded 4.0% (Ares-family default). Refusing to run rather than ship a projection that silently mis-anchors the Excess WAC.",
        severity: "error",
        blocking: true,
      });
    } else {
      warnings.push({
        field: "referenceWeightedAverageFixedCoupon",
        message:
          "PPM Reference Weighted Average Fixed Coupon (Condition 1, PDF p. 305) is not extracted, but the deal currently has no fixed-rate obligations — Excess WAC term is identically zero so the absent anchor has no computational effect. Projection proceeds; if a future ingest introduces fixed-rate positions, this warning escalates to blocking.",
        severity: "warn",
        blocking: false,
      });
    }
  }

  return {
    resolved: { tranches, poolSummary, ocTriggers, icTriggers, qualityTests, concentrationTests, reinvestmentOcTrigger, eventOfDefaultTest, dates, fees, loans, metadata, principalAccountCash, unusedProceedsCash, interestAccountCash, interestSmoothingBalance, supplementalReserveBalance, expenseReserveBalance, hedgeCostBps: resolveHedgeCost(constraints, warnings), seniorExpensesCap, discountObligationRule, longDatedValuationRule, preExistingDefaultedPar, preExistingDefaultRecovery, unpricedDefaultedPar, preExistingDefaultOcValue, discountObligationHaircut, longDatedObligationHaircut, cccBucketLimitPct, cccMarketValuePct, targetParAmount, referenceWeightedAverageFixedCoupon, isMoodysRated, isFitchRated, isSpRated, ratingAgencies, impliedOcAdjustment, quartersSinceReport, ddtlUnfundedPar, deferredInterestCompounds, interestNonPaymentGracePeriods, baseRateFloorPct, currency },
    warnings,
  };
}
