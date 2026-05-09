/**
 * Fixture regeneration probe — verifies that running the current resolver on
 * `fixture.raw` produces exactly the fields in `fixture.resolved` that have
 * been hand-patched during Sprint 1 / B1 (principalAccountCash,
 * impliedOcAdjustment, ocTriggers without EOD, eventOfDefaultTest).
 *
 * If the probe passes, the fixture is canonical — reproducible from the
 * current resolver + raw data, and the patches can be retired in favour of
 * actual regeneration. If it fails, it surfaces latent resolver bugs that
 * the hand-patches papered over.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWaterfallInputs } from "@/lib/clo/resolver";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

describe("fixture regeneration probe", () => {
  const raw = fixture.raw;
  const { resolved, warnings } = resolveWaterfallInputs(
    raw.constraints,
    raw.complianceData,
    raw.tranches,
    raw.trancheSnapshots,
    raw.holdings,
    raw.dealDates,
    raw.accountBalances,
    raw.parValueAdjustments,
  );

  it("fresh Euro XV resolver output has no KI-36/KI-38 blocking warnings", () => {
    const relevantBlockingWarnings = warnings.filter((w) => {
      if (!w.blocking) return false;
      return (
        w.field === "currency" ||
        w.field === "loans.currency" ||
        w.field === "accountBalances.currency" ||
        w.field.includes("paymentFrequency")
      );
    });

    expect(relevantBlockingWarnings).toEqual([]);
  });

  it("regenerated principalAccountCash matches fixture-patched value", () => {
    expect(resolved.principalAccountCash).toBeCloseTo(fixture.resolved.principalAccountCash, 2);
    // And is negative (the Euro XV overdraft).
    expect(resolved.principalAccountCash).toBeLessThan(0);
  });

  it("regenerated impliedOcAdjustment matches fixture-patched value (≈ 0)", () => {
    expect(resolved.impliedOcAdjustment).toBeCloseTo(fixture.resolved.impliedOcAdjustment, -1);
    expect(Math.abs(resolved.impliedOcAdjustment)).toBeLessThan(10);
  });

  it("regenerated ocTriggers does NOT contain EOD", () => {
    const hasEod = resolved.ocTriggers.some(
      (t) => t.className.toLowerCase() === "eod" || t.className.toLowerCase().includes("event of default"),
    );
    expect(hasEod).toBe(false);
    expect(resolved.ocTriggers.length).toBe(fixture.resolved.ocTriggers.length);
  });

  it("regenerated eventOfDefaultTest matches fixture", () => {
    expect(resolved.eventOfDefaultTest).not.toBeNull();
    expect(resolved.eventOfDefaultTest!.triggerLevel).toBeCloseTo(102.5, 2);
  });

  it("numeric pool/fee fields match fixture", () => {
    expect(resolved.poolSummary.totalPrincipalBalance).toBeCloseTo(
      fixture.resolved.poolSummary.totalPrincipalBalance,
      2,
    );
    expect(resolved.fees.seniorFeePct).toBeCloseTo(fixture.resolved.fees.seniorFeePct, 4);
    expect(resolved.fees.subFeePct).toBeCloseTo(fixture.resolved.fees.subFeePct, 4);
  });

  // Recursive full-equality guard on every top-level `resolved.*`
  // field. The original spot-check tests above cover individual patched
  // fields but missed silent drift for ~20 days (caught at D4 ship:
  // top10ObligorsPct never populated in fixture, pctSecondLien: 0 → null
  // drift undetected since Sprint 0). This iterator walks fresh vs stored
  // resolved output recursively and fails with named mismatches.
  //
  // Fields skipped (non-deterministic / volatile): `metadata` (carries
  // timestamps + sdfFilesIngested which change per ingest); `loans` (large
  // array — per-field field-drift on 400+ loans produces massive test output
  // for a single resolver-level change; delegate loan-shape coverage to
  // dedicated resolver tests if needed).
  it("every top-level resolved.* field matches fresh resolver output (recursive full-equality)", () => {
    const SKIP_TOP_KEYS = new Set(["metadata", "loans"]);
    const mismatches: string[] = [];
    const walk = (path: string, fresh: unknown, stored: unknown) => {
      // Null/undefined equivalence.
      if (fresh == null && stored == null) return;
      if (fresh == null || stored == null) {
        mismatches.push(`${path}: fresh=${String(fresh)} vs stored=${String(stored)}`);
        return;
      }
      // Arrays: compare length + element-wise.
      if (Array.isArray(fresh) || Array.isArray(stored)) {
        if (!Array.isArray(fresh) || !Array.isArray(stored)) {
          mismatches.push(`${path}: array shape mismatch`);
          return;
        }
        if (fresh.length !== stored.length) {
          mismatches.push(`${path}: length fresh=${fresh.length} vs stored=${stored.length}`);
          return;
        }
        for (let i = 0; i < fresh.length; i++) {
          walk(`${path}[${i}]`, fresh[i], stored[i]);
        }
        return;
      }
      // Objects: walk every key on both sides.
      if (typeof fresh === "object" && typeof stored === "object") {
        const keys = new Set([...Object.keys(fresh), ...Object.keys(stored)]);
        for (const k of keys) {
          walk(`${path}.${k}`, (fresh as Record<string, unknown>)[k], (stored as Record<string, unknown>)[k]);
        }
        return;
      }
      // Numbers: allow 1e-4 relative tolerance for float artifacts.
      if (typeof fresh === "number" && typeof stored === "number") {
        const tol = Math.max(1e-6, Math.abs(stored) * 1e-4);
        if (Math.abs(fresh - stored) > tol) {
          mismatches.push(`${path}: fresh=${fresh} vs stored=${stored} (Δ=${fresh - stored})`);
        }
        return;
      }
      // Primitives: strict equality.
      if (fresh !== stored) {
        mismatches.push(`${path}: fresh=${JSON.stringify(fresh)} vs stored=${JSON.stringify(stored)}`);
      }
    };

    const freshResolved = resolved as unknown as Record<string, unknown>;
    const storedResolved = fixture.resolved as Record<string, unknown>;
    const topKeys = new Set([...Object.keys(freshResolved), ...Object.keys(storedResolved)]);
    for (const k of topKeys) {
      if (SKIP_TOP_KEYS.has(k)) continue;
      walk(k, freshResolved[k], storedResolved[k]);
    }
    expect(mismatches.slice(0, 20), mismatches.join("\n")).toEqual([]);
  });
});
