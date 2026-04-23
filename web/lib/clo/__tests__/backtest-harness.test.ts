/**
 * Harness infrastructure + N6 compliance parity.
 *
 * Per-bucket engine correctness (N1) lives in two dedicated siblings:
 *   - n1-correctness.test.ts     — legit-pinned engine arithmetic vs trustee
 *   - n1-production-path.test.ts — unpinned DEFAULT_ASSUMPTIONS path a user sees
 *
 * What this file retains:
 *   - Step-map integrity (guards vocabulary drift in ppm-step-map.ts)
 *   - buildBacktestInputs shape equivalence across call sites
 *   - Fixture PPM tie-out (detects fixture regeneration drift)
 *   - N6: resolver ↔ trustee compliance transport + engine T=0 OC_PAR parity
 *
 * See /Users/solal/.claude/plans/clo-modeling-correctness-plan.md §N1 and §N6.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runBacktestHarness } from "@/lib/clo/backtest-harness";
import { buildBacktestInputs } from "@/lib/clo/backtest-types";
import { buildFromResolved, DEFAULT_ASSUMPTIONS } from "@/lib/clo/build-projection-inputs";
import { normalizePpmStepCode, PPM_INTEREST_STEPS, ENGINE_BUCKET_TO_PPM } from "@/lib/clo/ppm-step-map";
import { runProjection } from "@/lib/clo/projection";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";
import { failsWithMagnitude } from "./fails-with-magnitude";

// ----------------------------------------------------------------------------
// Fixture load
// ----------------------------------------------------------------------------

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
  raw: Parameters<typeof buildBacktestInputs>[0];
};

// ----------------------------------------------------------------------------
// Step-map sanity checks — catch vocabulary drift on first sign of trouble
// ----------------------------------------------------------------------------

describe("N1 harness — step map integrity", () => {
  it("every raw.waterfallSteps description in the fixture resolves to a known PPM step code", () => {
    const interestSteps = (fixture.raw.waterfallSteps ?? []).filter(
      (s) => s && s.waterfallType === "INTEREST",
    );
    const unmapped: string[] = [];
    for (const s of interestSteps) {
      const desc = s?.description;
      if (!desc) continue;
      if (desc.toLowerCase() === "opening") continue; // summary row
      const canonical = normalizePpmStepCode(desc);
      if (!canonical) unmapped.push(desc);
    }
    if (unmapped.length > 0) {
      console.error(`Unmapped waterfall step descriptions: ${unmapped.join(", ")}`);
    }
    expect(unmapped).toEqual([]);
  });

  it("fixture contains all 34 interest waterfall steps (A(i) through DD)", () => {
    // Note: there are 35 steps total if we count (A)(i) and (A)(ii) separately,
    // but our PPM_INTEREST_STEPS list enumerates 34 (we split 'a' into 'a.i' and 'a.ii').
    // The fixture should have one trustee row per canonical step.
    const interestSteps = (fixture.raw.waterfallSteps ?? []).filter(
      (s) => s && s.waterfallType === "INTEREST" && s.description && s.description.toLowerCase() !== "opening",
    );
    const canonicalInFixture = new Set(
      interestSteps.map((s) => normalizePpmStepCode(s!.description ?? "")).filter(Boolean),
    );
    for (const step of PPM_INTEREST_STEPS) {
      expect(canonicalInFixture.has(step), `Fixture missing PPM step (${step})`).toBe(true);
    }
  });

  it("every EngineBucket in ENGINE_BUCKET_TO_PPM is produced by the harness extractor", () => {
    // Guards against silent coverage loss when someone adds a new bucket to
    // the map but forgets to wire it into runBacktestHarness's emitter.
    const pinnedAssumptions = {
      ...DEFAULT_ASSUMPTIONS,
      seniorFeePct: fixture.resolved.fees.seniorFeePct,
      subFeePct: fixture.resolved.fees.subFeePct,
      trusteeFeeBps: fixture.resolved.fees.trusteeFeeBps,
    };
    const projectionInputs = buildFromResolved(fixture.resolved, pinnedAssumptions);
    const backtest = buildBacktestInputs(fixture.raw);
    const result = runBacktestHarness(projectionInputs, backtest);

    const expectedBuckets = Object.keys(ENGINE_BUCKET_TO_PPM);
    const emittedBuckets = new Set(result.steps.map((s) => s.engineBucket as string));
    const missing = expectedBuckets.filter((b) => !emittedBuckets.has(b));
    expect(missing, `ENGINE_BUCKET_TO_PPM declares ${expectedBuckets.length} buckets but harness emits ${emittedBuckets.size}. Missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("normalizePpmStepCode never silently drops a fixture description", () => {
    // The harness logs a console.warn on unmapped descriptions; this test
    // asserts no unmapped descriptions exist on the canned fixture. If this
    // fails, a new trustee format snuck into the fixture that ppm-step-map
    // doesn't handle.
    const pinnedAssumptions = { ...DEFAULT_ASSUMPTIONS };
    const projectionInputs = buildFromResolved(fixture.resolved, pinnedAssumptions);
    const backtest = buildBacktestInputs(fixture.raw);
    const result = runBacktestHarness(projectionInputs, backtest);
    expect(
      result.unmappedTrusteeDescriptions,
      `Harness dropped ${result.unmappedTrusteeDescriptions.length} trustee waterfall description(s): ${result.unmappedTrusteeDescriptions.join(", ")}. Extend ppm-step-map.ts normalizePpmStepCode().`,
    ).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// buildBacktestInputs shape-equivalence test
//
// Two call sites consume buildBacktestInputs: the N1 test passes the full
// context.json raw shape, and the UI (ProjectionModel.tsx) assembles a narrow
// subset from separate DB-loaded props. Field names and nesting must match
// — this test asserts both paths produce equivalent BacktestInputs shape.
// ----------------------------------------------------------------------------

describe("buildBacktestInputs — shape equivalence across call sites", () => {
  it("test-path and UI-path produce structurally equivalent outputs on the same data", () => {
    // Test path: pass the full raw shape from context.json.
    const fromRaw = buildBacktestInputs(fixture.raw);

    // UI path: pass individual DB-loaded fields the way ProjectionModel assembles them.
    const fromSeparateProps = buildBacktestInputs({
      waterfallSteps: fixture.raw.waterfallSteps ?? undefined,
      trancheSnapshots: fixture.raw.trancheSnapshots ?? undefined,
      tranches: fixture.raw.tranches ?? undefined,
      complianceData: {
        complianceTests: fixture.raw.complianceData?.complianceTests ?? undefined,
        poolSummary: fixture.raw.complianceData?.poolSummary
          ? { totalPrincipalBalance: fixture.raw.complianceData.poolSummary.totalPrincipalBalance }
          : null,
      },
      accountBalances: fixture.raw.accountBalances ?? undefined,
      dealDates: fixture.raw.dealDates ?? undefined,
    });

    // Lengths must match (dropping a list is the most common drift).
    expect(fromRaw.waterfallSteps.length).toBe(fromSeparateProps.waterfallSteps.length);
    expect(fromRaw.trancheSnapshots.length).toBe(fromSeparateProps.trancheSnapshots.length);
    expect(fromRaw.complianceTests.length).toBe(fromSeparateProps.complianceTests.length);
    expect(fromRaw.accountBalances.length).toBe(fromSeparateProps.accountBalances.length);
    expect(fromRaw.beginningPar).toBe(fromSeparateProps.beginningPar);
    expect(fromRaw.reportDate).toBe(fromSeparateProps.reportDate);
    expect(fromRaw.paymentDate).toBe(fromSeparateProps.paymentDate);

    // First row of each list — spot-check field-name parity, catches nesting drift.
    if (fromRaw.waterfallSteps.length > 0) {
      const a = fromRaw.waterfallSteps[0];
      const b = fromSeparateProps.waterfallSteps[0];
      expect(a.description).toBe(b.description);
      expect(a.amountPaid).toBe(b.amountPaid);
      expect(a.priorityOrder).toBe(b.priorityOrder);
    }
    if (fromRaw.trancheSnapshots.length > 0) {
      const a = fromRaw.trancheSnapshots[0];
      const b = fromSeparateProps.trancheSnapshots[0];
      expect(a.className).toBe(b.className);
      expect(a.interestPaid).toBe(b.interestPaid);
      expect(a.endingBalance).toBe(b.endingBalance);
    }
  });
});

// ----------------------------------------------------------------------------
// Fixture PPM tie-out — guards the canned fixture against silent regeneration
// drift. If the PPM worked example values move, the N1 correctness tolerances
// in the sibling test files need recalibration.
// ----------------------------------------------------------------------------

describe("Euro XV fixture PPM tie-out (infrastructure sanity checks)", () => {
  it("fixture's Class A Apr-2026 realized interest = €2,298,650 (PPM worked example)", () => {
    const backtest = buildBacktestInputs(fixture.raw);
    const stepG = backtest.waterfallSteps.find(
      (s) => s.waterfallType === "INTEREST" && normalizePpmStepCode(s.description) === "g",
    );
    expect(stepG, "Fixture missing PPM step (G) Class A interest").toBeDefined();
    expect(stepG!.amountPaid).toBeCloseTo(2298650, 0);
  });

  it("fixture's sub distribution Apr-2026 = €1,857,942.69 (ties to P16 of Intex history)", () => {
    const backtest = buildBacktestInputs(fixture.raw);
    const stepDD = backtest.waterfallSteps.find(
      (s) => s.waterfallType === "INTEREST" && normalizePpmStepCode(s.description) === "dd",
    );
    expect(stepDD, "Fixture missing PPM step (DD) Sub distribution").toBeDefined();
    expect(stepDD!.amountPaid).toBeCloseTo(1857942.69, 2);
  });
});

// ----------------------------------------------------------------------------
// N6 — Compliance Parity Harness
//
// Engine's T=0 forward projection must reproduce the trustee-reported
// quantitative compliance values: 6 OC_PAR tests, 3 IC tests. The other
// quantitative categories (WARF/WAL/WAS/DIVERSITY/RECOVERY, concentration %s)
// are resolver-transported (passed through from the same trustee report the
// fixture was built from) so parity is tautological — they're exercised by
// the resolver tests, not here. The harness scope that matters:
//
//   - OC_PAR tests (6): engine computes from its own numerator/denominator;
//     any drift vs trustee reveals engine-side OC math issues.
//   - IC tests (3): engine computes from interestAfterFees / interestDue;
//     drift reveals fee-deduction or denominator mismatches.
//
// Both are expected to tie out closely at T=0. If the engine's Class A/B OC
// differs from trustee's 136.98%, that's a real bug.
// ----------------------------------------------------------------------------

describe("N6 harness — Euro XV T=0 compliance parity (resolver ↔ trustee)", () => {
  // N6 scope: verify the RESOLVER's pool-summary and trigger emission ties out
  // against the trustee's realized T=0 compliance values. This is a regression
  // gate on the resolver → engine input pipeline, not on engine forward math
  // (which the N1 test covers at per-period granularity).
  //
  // True engine forward-projection tie-out isn't meaningful at "T=0" because
  // `runProjection(...).periods[0]` is post-Q1 state, not period-start state.
  // If we ever need per-period OC/IC tie-out during multi-period backtest
  // (plan item D6b), we'll need to extract beginning-of-period snapshots
  // from the engine — separate scope.

  const tests = fixture.raw.complianceData?.complianceTests ?? [];

  it("resolver ocTriggers trigger levels match trustee reported triggers", () => {
    const trusteeTriggers = new Map<string, number>();
    for (const t of tests) {
      if (t.testType !== "OC_PAR") continue;
      if (t.triggerLevel == null) continue;
      // Extract class key: "Class A/B Par Value Test" → "A/B"; "Event of Default" → "EOD"
      const classMatch = t.testName.match(/Class\s+([A-Z](?:\/[A-Z])?(?:-\d)?)/i);
      if (classMatch) trusteeTriggers.set(classMatch[1].toUpperCase(), t.triggerLevel);
      else if (t.testName.toLowerCase().includes("event of default")) trusteeTriggers.set("EOD", t.triggerLevel);
    }

    const resolvedByClass = new Map<string, number>();
    for (const t of fixture.resolved.ocTriggers) {
      resolvedByClass.set(t.className.replace(/^Class /i, "").toUpperCase(), t.triggerLevel);
    }

    const outOfTol: string[] = [];
    for (const [cls, trusteeTrigger] of trusteeTriggers) {
      const resolvedTrigger = resolvedByClass.get(cls);
      if (resolvedTrigger == null) {
        outOfTol.push(`${cls}: missing from resolved.ocTriggers`);
        continue;
      }
      if (Math.abs(resolvedTrigger - trusteeTrigger) > 0.01) {
        outOfTol.push(`${cls}: ${resolvedTrigger} vs ${trusteeTrigger} (Δ${(resolvedTrigger - trusteeTrigger).toFixed(3)})`);
      }
    }
    expect(outOfTol).toEqual([]);
  });

  it("resolver icTriggers trigger levels match trustee reported triggers", () => {
    const trusteeTriggers = new Map<string, number>();
    for (const t of tests) {
      if (t.testType !== "IC") continue;
      if (t.triggerLevel == null) continue;
      const classMatch = t.testName.match(/Class\s+([A-Z](?:\/[A-Z])?(?:-\d)?)/i);
      if (classMatch) trusteeTriggers.set(classMatch[1].toUpperCase(), t.triggerLevel);
    }
    const resolvedByClass = new Map<string, number>();
    for (const t of fixture.resolved.icTriggers) {
      resolvedByClass.set(t.className.replace(/^Class /i, "").toUpperCase(), t.triggerLevel);
    }
    const outOfTol: string[] = [];
    for (const [cls, trusteeTrigger] of trusteeTriggers) {
      const resolvedTrigger = resolvedByClass.get(cls);
      if (resolvedTrigger == null) { outOfTol.push(`${cls}: missing from resolved.icTriggers`); continue; }
      if (Math.abs(resolvedTrigger - trusteeTrigger) > 0.01) {
        outOfTol.push(`${cls}: ${resolvedTrigger} vs ${trusteeTrigger} (Δ${(resolvedTrigger - trusteeTrigger).toFixed(3)})`);
      }
    }
    expect(outOfTol).toEqual([]);
  });

  it("resolver concentrationTests actualValues match trustee raw.concentrations[] within 0.1%", () => {
    // The resolver transports raw.complianceData.concentrations[] (63 buckets)
    // into resolved.concentrationTests[], applying unit normalization
    // (trustee stores fractions 0-1; resolver stores percentages 0-100).
    //
    // This test verifies 1:1 transport — if the resolver ever drops, reorders,
    // corrupts, or mis-normalizes a concentration row, this test fails loudly.
    //
    // Tolerance 0.1% (pp) per plan — below Euro XV's tightest live cushion
    // (Moody's Caa at 0.58pp), so drift of this magnitude is a resolver bug
    // or data-quality issue worth catching.
    const rawConcentrations = fixture.raw.complianceData?.concentrations ?? [];
    const resolvedConc = fixture.resolved.concentrationTests;

    // Resolver emits concentration rows in same order as raw.concentrations[].
    // Verify count matches (regression guard: if count drifts, resolver dropped
    // or invented rows).
    expect(
      resolvedConc.length,
      `resolved.concentrationTests count (${resolvedConc.length}) ≠ raw.concentrations count (${rawConcentrations.length}). Resolver dropped or invented rows.`,
    ).toBe(rawConcentrations.length);

    const outOfTol: string[] = [];
    for (let i = 0; i < resolvedConc.length; i++) {
      const ct = resolvedConc[i];
      const raw = rawConcentrations[i] as { bucketName?: string; actualValue?: number | null; actualPct?: number | null };
      if (ct.actualValue == null) continue;

      // Trustee value: prefer actualPct when present (already in %), else actualValue (fraction → ×100).
      const rawPct = raw.actualPct != null ? raw.actualPct
        : raw.actualValue != null && raw.actualValue >= 0 && raw.actualValue <= 1.5 ? raw.actualValue * 100
        : raw.actualValue;
      if (rawPct == null) continue;

      const delta = Math.abs(ct.actualValue - rawPct);
      if (delta > 0.1) {
        outOfTol.push(`[${i}] ${ct.testName}: resolved ${ct.actualValue.toFixed(3)} vs trustee ${rawPct.toFixed(3)} (Δ${delta.toFixed(3)})`);
      }
    }
    expect(outOfTol, outOfTol.join("\n")).toEqual([]);
  });

  it("engine initialState OC_PAR actuals match trustee reported actuals within 0.01%", () => {
    // True T=0 parity — uses ProjectionResult.initialState (BOP of period 1,
    // before any forward mutations). Matches trustee's determination-date
    // OC values. Skips the EoD test (rank 99) — its compositional numerator
    // vs Class-A-only denominator is a B1 Sprint 2 deliverable (KI-unnumbered
    // in compositional-EoD design).
    // OC at T=0 is par-based (principal balances only) and fee-independent,
    // so DEFAULT_ASSUMPTIONS is sufficient here — no pinning needed.
    const projectionInputs = buildFromResolved(fixture.resolved, DEFAULT_ASSUMPTIONS);
    const result = runProjection(projectionInputs);

    const trusteeOcByName = new Map<string, number>();
    for (const t of tests) {
      if (t.testType !== "OC_PAR") continue;
      if (t.actualValue == null) continue;
      trusteeOcByName.set(t.testName, t.actualValue);
    }

    const outOfTol: string[] = [];
    let compared = 0;
    for (const et of result.initialState.ocTests) {
      // Match engine className ("A/B", "C", "D", "E", "F", "EOD") to trustee testName pattern.
      const trusteeName = Array.from(trusteeOcByName.keys()).find((tn) => {
        const m = tn.match(/Class\s+([A-Z](?:\/[A-Z])?)/i);
        return m && m[1].toUpperCase() === et.className.toUpperCase();
      });
      if (!trusteeName) continue; // skip EOD (not named "Class X"); covered separately once B1 lands
      const trusteeActual = trusteeOcByName.get(trusteeName)!;
      compared++;
      const delta = Math.abs(et.actual - trusteeActual);
      if (delta > 0.01) {
        outOfTol.push(`${et.className}: engine ${et.actual.toFixed(3)} vs trustee ${trusteeActual.toFixed(3)} (Δ${delta.toFixed(3)})`);
      }
    }
    expect(compared, `Too few OC_PAR tests compared — expected 5 (A/B through F), got ${compared}`).toBeGreaterThanOrEqual(5);
    expect(outOfTol, outOfTol.join("\n")).toEqual([]);
  });

  // Engine T=0 IC compositional parity. The component drifts (taxes, trustee
  // fees, fee-base) are individually tested in n1-correctness, but the IC
  // *formula* (interestAfterFees / interestDue aggregated the right way per
  // class) needs its own assertion — a bug in aggregation or denominator
  // construction wouldn't surface in per-bucket cash-flow checks.
  //
  // Under legit pins, remaining IC drift is driven by KI-01 (€250 issuer
  // profit) + KI-08 (€64,660 trustee fee) + KI-09 (€6,133 taxes) + KI-12a
  // (fee-base over-payment) net, cascaded through the IC numerator. Each
  // class's drift is documented separately because the denominators differ.
  // When any upstream KI closes, all three IC markers need re-baselining —
  // same maintenance discipline as KI-13 cascade.
  {
    const projectionInputs = buildFromResolved(fixture.resolved, {
      ...DEFAULT_ASSUMPTIONS,
      baseRatePct:
        fixture.raw.trancheSnapshots?.find((s) => s && s.currentIndexRate != null)?.currentIndexRate ?? 2.1,
      seniorFeePct: fixture.resolved.fees.seniorFeePct,
      subFeePct: fixture.resolved.fees.subFeePct,
      incentiveFeePct: fixture.resolved.fees.incentiveFeePct,
      incentiveFeeHurdleIrr: fixture.resolved.fees.incentiveFeeHurdleIrr * 100,
    });
    const icResult = runProjection(projectionInputs);
    const trusteeIcByClass = new Map<string, number>();
    for (const t of tests) {
      if (t.testType !== "IC" || t.actualValue == null) continue;
      const m = t.testName.match(/Class\s+([A-Z](?:\/[A-Z])?)/i);
      if (m) trusteeIcByClass.set(m[1].toUpperCase(), t.actualValue);
    }
    const icDrift = (className: string): number => {
      const et = icResult.initialState.icTests.find((e) => e.className.toUpperCase() === className);
      if (!et) throw new Error(`Engine did not emit IC test for class ${className}`);
      const trusteeActual = trusteeIcByClass.get(className);
      if (trusteeActual == null) throw new Error(`Trustee did not report IC test for class ${className}`);
      return et.actual - trusteeActual;
    };

    failsWithMagnitude(
      {
        ki: "KI-IC-AB",
        closesIn: "Progressively as KI-01 / KI-08 / KI-09 / KI-12a close (re-baseline on each)",
        expectedDrift: 6.600,
        tolerance: 0.05,
        // closeThreshold = tolerance is intentional and safe here: |expectedDrift|
        // is 6.6pp and tolerance is 0.05pp, so the "partial-fix masks as close"
        // window is 0.05/6.6 ≈ 0.75% of the expected magnitude — vanishingly
        // narrow. Compare KI-13a where |expectedDrift| = €607 and tolerance = €50
        // would leave a 8% window, which is why KI-13a sets closeThreshold=5.
        closeThreshold: 0.05,
      },
      "Class A/B IC compositional parity at T=0 (pp)",
      () => icDrift("A/B"),
    );
    failsWithMagnitude(
      {
        ki: "KI-IC-C",
        closesIn: "Progressively as KI-01 / KI-08 / KI-09 / KI-12a close (re-baseline on each)",
        expectedDrift: 5.865,
        tolerance: 0.05,
        closeThreshold: 0.05,
      },
      "Class C IC compositional parity at T=0 (pp)",
      () => icDrift("C"),
    );
    failsWithMagnitude(
      {
        ki: "KI-IC-D",
        closesIn: "Progressively as KI-01 / KI-08 / KI-09 / KI-12a close (re-baseline on each)",
        expectedDrift: 5.117,
        tolerance: 0.05,
        closeThreshold: 0.05,
      },
      "Class D IC compositional parity at T=0 (pp)",
      () => icDrift("D"),
    );
  }

  it("resolver poolSummary quantitative metrics match trustee reported actuals within tolerance", () => {
    // WARF / WAL / WAS / diversity / waRecoveryRate — the core portfolio metrics
    // that tie directly from trustee report into resolved.poolSummary.
    const getActual = (testType: string, namePattern?: RegExp): number | null => {
      for (const t of tests) {
        if (t.testType !== testType) continue;
        if (namePattern && !namePattern.test(t.testName)) continue;
        return t.actualValue;
      }
      return null;
    };

    // Moody's WARF — pool summary ties to Moody's Maximum WARF test actual.
    const moodysWarf = getActual("WARF", /Moody/i);
    if (moodysWarf != null) {
      expect(fixture.resolved.poolSummary.warf).toBeCloseTo(moodysWarf, 0);
    }

    // WAL.
    const wal = getActual("WAL");
    if (wal != null) {
      expect(fixture.resolved.poolSummary.walYears).toBeCloseTo(wal, 2);
    }

    // Diversity.
    const diversity = getActual("DIVERSITY");
    if (diversity != null) {
      expect(fixture.resolved.poolSummary.diversityScore).toBeCloseTo(diversity, 0);
    }

    // WAS — resolver stores as bps; trustee reports as % (e.g., 3.68). Compare after conversion.
    const was = getActual("WAS", /floating spread/i);
    if (was != null) {
      expect(fixture.resolved.poolSummary.wacSpreadBps / 100).toBeCloseTo(was, 2);
    }

    // Moody's Recovery.
    const moodysRecovery = getActual("RECOVERY", /Moody/i);
    if (moodysRecovery != null && fixture.resolved.poolSummary.waRecoveryRate != null) {
      expect(fixture.resolved.poolSummary.waRecoveryRate).toBeCloseTo(moodysRecovery, 1);
    }
  });
});

