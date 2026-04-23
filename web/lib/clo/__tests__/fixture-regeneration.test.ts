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
  const { resolved } = resolveWaterfallInputs(
    raw.constraints,
    raw.complianceData,
    raw.tranches,
    raw.trancheSnapshots,
    raw.holdings,
    raw.dealDates,
    raw.accountBalances,
    raw.parValueAdjustments,
  );

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
});
