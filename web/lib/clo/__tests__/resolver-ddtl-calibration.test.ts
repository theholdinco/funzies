/**
 * Resolver-side correctness tests for the DDTL OC calibration strip.
 * Asserts the identity:
 *
 *   ddtlCalibrationOffset = preStripImpliedOcAdjustment - postStripImpliedOcAdjustment
 *                         = min(preStripImplied, ddtlUnfundedPar)   when both > 0
 *                         = 0                                        otherwise
 *
 * Three cases (R = pre-strip implied, D = ddtlUnfundedPar):
 *   A. R > D    → offset = D; post-strip implied = R - D
 *   B. 0 < R ≤ D → offset = R; post-strip implied = 0
 *   C. R ≤ 0 or D = 0 → offset = 0; post-strip implied unchanged
 *
 * Exercised through `resolveWaterfallInputs` because the strip is internal
 * (per the canonical pattern shared with resolver-hedge.test.ts). Inputs
 * mutate Euro XV's pool totals and one holding's `unfundedCommitment` to
 * drive each case. The unfunded-commitment blocking warning still fires
 * (the engine refuses to run on unfunded DDTL data today) but does not
 * prevent the resolver from computing and emitting the calibration fields,
 * which is what the engine path consumes when the data becomes available.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWaterfallInputs } from "@/lib/clo/resolver";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");

interface RawFixture {
  raw: {
    constraints: Record<string, unknown>;
    complianceData: { poolSummary?: { totalPar?: number; totalPrincipalBalance?: number } } & Record<string, unknown>;
    tranches: unknown[];
    trancheSnapshots: unknown[];
    holdings: Array<{ unfundedCommitment?: number; isDelayedDraw?: boolean | null; isRevolving?: boolean | null }> & unknown[];
    dealDates: unknown;
    accountBalances: unknown[];
    parValueAdjustments: unknown[];
  };
}

function loadRaw(): RawFixture["raw"] {
  return JSON.parse(JSON.stringify(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")).raw));
}

function runResolver(raw: RawFixture["raw"]) {
  return resolveWaterfallInputs(
    raw.constraints as Parameters<typeof resolveWaterfallInputs>[0],
    raw.complianceData as Parameters<typeof resolveWaterfallInputs>[1],
    raw.tranches as Parameters<typeof resolveWaterfallInputs>[2],
    raw.trancheSnapshots as Parameters<typeof resolveWaterfallInputs>[3],
    raw.holdings as Parameters<typeof resolveWaterfallInputs>[4],
    raw.dealDates as Parameters<typeof resolveWaterfallInputs>[5],
    raw.accountBalances as Parameters<typeof resolveWaterfallInputs>[6],
    raw.parValueAdjustments as Parameters<typeof resolveWaterfallInputs>[7],
  );
}

/**
 * Tag one holding as a DDTL with the requested `unfundedCommitment`, and
 * shift `poolSummary.totalPar` to drive `implied = preStripImpliedOcAdjustment`
 * to the requested target. Returns the actual pre-strip implied the resolver
 * is expected to compute, so the test can read it back for assertions.
 *
 * The resolver's implied formula is:
 *   implied = totalPrincipalBalance + principalAccountCash
 *           - defaultedHaircut - discountHaircut - longDatedHaircut
 *           - totalPar
 * Holding `totalPrincipalBalance` constant and shifting `totalPar` lets us
 * dial implied without touching the rest of the deal.
 */
function configureCalibration(
  raw: RawFixture["raw"],
  opts: { preStripImplied: number; unfundedCommitment: number; holdingIndex?: number },
) {
  const pool = raw.complianceData.poolSummary;
  if (pool == null || pool.totalPar == null || pool.totalPrincipalBalance == null) {
    throw new Error("fixture missing poolSummary totals");
  }
  // For pre-strip implied to equal `target`, we need
  //   totalPar = totalPrincipalBalance + cash - haircuts - target
  // Run the resolver once on the unmodified fixture to capture the cash +
  // haircut contribution (everything except totalPar), then back-solve.
  const baseline = runResolver(raw);
  const baselineImplied = baseline.resolved.impliedOcAdjustment; // = (TPB + cash - haircuts) - totalPar_now
  const fixedTerm = baselineImplied + pool.totalPar; // = TPB + cash - haircuts
  pool.totalPar = fixedTerm - opts.preStripImplied;

  const idx = opts.holdingIndex ?? 0;
  raw.holdings[idx] = {
    ...raw.holdings[idx],
    isDelayedDraw: true,
    unfundedCommitment: opts.unfundedCommitment,
  };
}

describe("resolver ddtlCalibrationOffset", () => {
  it("Case A — pre-strip implied > D → offset = D, post-strip implied = pre - D", () => {
    const raw = loadRaw();
    const D = 8_000_000;
    const pre = 12_000_000;
    configureCalibration(raw, { preStripImplied: pre, unfundedCommitment: D });
    const { resolved } = runResolver(raw);
    expect(resolved.ddtlUnfundedPar).toBeCloseTo(D, 0);
    expect(resolved.ddtlCalibrationOffset).toBeCloseTo(D, 0);
    expect(resolved.impliedOcAdjustment).toBeCloseTo(pre - D, 0);
  });

  it("Case B clamped — 0 < pre-strip implied ≤ D → offset = pre, post-strip implied = 0", () => {
    const raw = loadRaw();
    const D = 10_000_000;
    const pre = 4_000_000;
    configureCalibration(raw, { preStripImplied: pre, unfundedCommitment: D });
    const { resolved } = runResolver(raw);
    expect(resolved.ddtlUnfundedPar).toBeCloseTo(D, 0);
    expect(resolved.ddtlCalibrationOffset).toBeCloseTo(pre, 0);
    expect(resolved.impliedOcAdjustment).toBeCloseTo(0, 0);
  });

  it("Case B knife-edge — pre = D → offset = D, post-strip implied = 0", () => {
    const raw = loadRaw();
    const D = 5_000_000;
    configureCalibration(raw, { preStripImplied: D, unfundedCommitment: D });
    const { resolved } = runResolver(raw);
    expect(resolved.ddtlCalibrationOffset).toBeCloseTo(D, 0);
    expect(resolved.impliedOcAdjustment).toBeCloseTo(0, 0);
  });

  it("Case C — pre-strip implied = 0 with positive D → offset = 0 (strip never fires)", () => {
    // Pre-strip implied is clamped to 0 by the resolver when implied < 0,
    // or simply never enters the strip branch when implied = 0. Either
    // way, the calibration offset MUST remain 0 — the engine's forward
    // cumulative-draw subtraction would otherwise over-correct.
    const raw = loadRaw();
    const D = 7_000_000;
    configureCalibration(raw, { preStripImplied: 0, unfundedCommitment: D });
    const { resolved } = runResolver(raw);
    expect(resolved.ddtlUnfundedPar).toBeCloseTo(D, 0);
    expect(resolved.ddtlCalibrationOffset).toBe(0);
    expect(resolved.impliedOcAdjustment).toBe(0);
  });

  it("Case C — negative pre-strip implied (clamped) with positive D → offset = 0", () => {
    const raw = loadRaw();
    const D = 6_000_000;
    configureCalibration(raw, { preStripImplied: -5_000_000, unfundedCommitment: D });
    const { resolved } = runResolver(raw);
    expect(resolved.ddtlUnfundedPar).toBeCloseTo(D, 0);
    expect(resolved.ddtlCalibrationOffset).toBe(0);
    expect(resolved.impliedOcAdjustment).toBe(0);
  });

  it("Case C — D = 0 with positive pre-strip implied → offset = 0, implied untouched", () => {
    const raw = loadRaw();
    configureCalibration(raw, { preStripImplied: 4_000_000, unfundedCommitment: 0 });
    const { resolved } = runResolver(raw);
    expect(resolved.ddtlUnfundedPar).toBe(0);
    expect(resolved.ddtlCalibrationOffset).toBe(0);
    expect(resolved.impliedOcAdjustment).toBeCloseTo(4_000_000, 0);
  });

  it("identity: ddtlCalibrationOffset = preStripImplied - postStripImplied across all cases", () => {
    const cases: Array<{ preStripImplied: number; unfundedCommitment: number }> = [
      { preStripImplied: 12_000_000, unfundedCommitment: 8_000_000 }, // A
      { preStripImplied: 4_000_000, unfundedCommitment: 10_000_000 }, // B clamped
      { preStripImplied: 5_000_000, unfundedCommitment: 5_000_000 }, // B knife-edge
      { preStripImplied: 0, unfundedCommitment: 7_000_000 }, // C zero pre
      { preStripImplied: -5_000_000, unfundedCommitment: 6_000_000 }, // C negative pre
      { preStripImplied: 4_000_000, unfundedCommitment: 0 }, // C D=0
    ];
    for (const c of cases) {
      const raw = loadRaw();
      configureCalibration(raw, c);
      const { resolved } = runResolver(raw);
      // pre-strip implied as the resolver would have computed it BEFORE the
      // strip is `postStripImplied + offset`. Clamping flattens any negative
      // value to 0, so the identity holds against the resolver's *recognised*
      // pre-strip value (i.e., max(0, raw implied)).
      const recognisedPreStrip = Math.max(0, c.preStripImplied);
      expect(resolved.ddtlCalibrationOffset).toBeCloseTo(
        Math.max(0, recognisedPreStrip - resolved.impliedOcAdjustment),
        0,
      );
    }
  });
});
