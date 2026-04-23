/**
 * A1 — Equity entry price auto-fill from inception data.
 *
 * PPM + inception data (`raw.equityInceptionData.purchasePriceCents`) carry the
 * secondary-market buyer's cost basis in cents of sub note face. Before A1:
 * engine defaulted to `bookValue = collateral + cash − debt`, which for Euro XV
 * (≈56c implied) is lower than actual purchase (95c), overstating forward IRR
 * and firing the incentive-fee hurdle prematurely.
 *
 * A1 plumbs `UserAssumptions.equityEntryPriceCents` through `buildFromResolved`
 * as `subNotePar × (cents / 100)`. Tests here are first-principles arithmetic
 * on the conversion — independent of the N1 harness frame.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFromResolved, DEFAULT_ASSUMPTIONS } from "@/lib/clo/build-projection-inputs";
import { runProjection } from "@/lib/clo/projection";
import type { ResolvedDealData } from "@/lib/clo/resolver-types";

const FIXTURE_PATH = join(__dirname, "fixtures", "euro-xv-q1.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  resolved: ResolvedDealData;
};

describe("A1 — equityEntryPriceCents → equityEntryPrice conversion", () => {
  it("null cents → engine default (no equityEntryPrice on inputs)", () => {
    const inputs = buildFromResolved(fixture.resolved, {
      ...DEFAULT_ASSUMPTIONS,
      equityEntryPriceCents: null,
    });
    expect(inputs.equityEntryPrice).toBeUndefined();
  });

  it("95c on Euro XV sub note = €42,560,000 (44.8M × 0.95)", () => {
    // Euro XV sub note par = €44.8M per fixture. 95c purchase price → €42.56M.
    const inputs = buildFromResolved(fixture.resolved, {
      ...DEFAULT_ASSUMPTIONS,
      equityEntryPriceCents: 95,
    });
    const subNote = fixture.resolved.tranches.find(t => t.isIncomeNote);
    const expected = (subNote?.originalBalance ?? 0) * 0.95;
    expect(inputs.equityEntryPrice).toBeCloseTo(expected, 2);
    // Sanity: Euro XV sub is €44.8M so expected should be ≈€42,560,000.
    expect(expected).toBeCloseTo(42_560_000, -2);
  });

  it("conversion uses originalBalance, not currentBalance (amortized sub note)", () => {
    // Simulate a deal post-RP where the sub note has amortized down — e.g.
    // original €44.8M face, currentBalance dropped to €30M. The buyer's
    // cost basis is an invariant of the purchase event: 95c × €44.8M face
    // = €42.56M, NOT 95c × current €30M = €28.5M. Using currentBalance
    // would silently produce the wrong cost basis.
    const subNote = fixture.resolved.tranches.find(t => t.isIncomeNote);
    if (!subNote) throw new Error("fixture missing sub note tranche");
    const amortizedResolved: ResolvedDealData = {
      ...fixture.resolved,
      tranches: fixture.resolved.tranches.map(t =>
        t.isIncomeNote ? { ...t, currentBalance: 30_000_000 } : t,
      ),
    };
    const inputs = buildFromResolved(amortizedResolved, {
      ...DEFAULT_ASSUMPTIONS,
      equityEntryPriceCents: 95,
    });
    // Must reflect original €44.8M × 0.95 = €42.56M, not current €30M × 0.95.
    expect(inputs.equityEntryPrice).toBeCloseTo(subNote.originalBalance * 0.95, 2);
    expect(inputs.equityEntryPrice).not.toBeCloseTo(30_000_000 * 0.95, 0);
  });

  it("100c → sub notes valued at face (originalBalance)", () => {
    const inputs = buildFromResolved(fixture.resolved, {
      ...DEFAULT_ASSUMPTIONS,
      equityEntryPriceCents: 100,
    });
    const subNote = fixture.resolved.tranches.find(t => t.isIncomeNote);
    expect(inputs.equityEntryPrice).toBeCloseTo(subNote?.originalBalance ?? 0, 2);
  });

  it("50c → sub notes valued at 50% of face (distressed secondary)", () => {
    const inputs = buildFromResolved(fixture.resolved, {
      ...DEFAULT_ASSUMPTIONS,
      equityEntryPriceCents: 50,
    });
    const subNote = fixture.resolved.tranches.find(t => t.isIncomeNote);
    const expected = (subNote?.originalBalance ?? 0) * 0.5;
    expect(inputs.equityEntryPrice).toBeCloseTo(expected, 2);
  });

  it("missing sub note → no equityEntryPrice (no NaN, no zero-division)", () => {
    const withoutSubNote: ResolvedDealData = {
      ...fixture.resolved,
      tranches: fixture.resolved.tranches.filter(t => !t.isIncomeNote),
    };
    const inputs = buildFromResolved(withoutSubNote, {
      ...DEFAULT_ASSUMPTIONS,
      equityEntryPriceCents: 95,
    });
    expect(inputs.equityEntryPrice).toBeUndefined();
  });
});

describe("A1 — integration: equityEntryPriceCents flows through to engine IRR", () => {
  it("setting equityEntryPriceCents shifts equityIrr by the expected ~−13pp vs default (book)", () => {
    // Empirical anchor. With DEFAULT_ASSUMPTIONS, Euro XV's engine produces
    // (post-B1 / Sprint 2 fixture patch on principalAccountCash):
    //   - 95c cost basis (€42.56M) → equityIrr ≈ lower
    //   - book-value default → equityIrr ≈ higher (because lower cost basis)
    //   - gap ≈ −15.71pp
    //
    // History: pre-B1 this gap was −12.92pp. B1's resolver fix corrected
    // `principalAccountCash` from 0 to −€1.82M (the overdrawn Principal EUR
    // account), which flows into the book-value computation via the pool-
    // level cash term → book value drops slightly → book-value-default IRR
    // rises → gap widens. Cascade re-baseline per PR template.
    const inputs95 = buildFromResolved(fixture.resolved, {
      ...DEFAULT_ASSUMPTIONS,
      equityEntryPriceCents: 95,
    });
    const inputsDefault = buildFromResolved(fixture.resolved, DEFAULT_ASSUMPTIONS);
    const result95 = runProjection(inputs95);
    const resultDefault = runProjection(inputsDefault);

    expect(Number.isFinite(result95.equityIrr!)).toBe(true);
    expect(Number.isFinite(resultDefault.equityIrr!)).toBe(true);

    const gapPp = (result95.equityIrr! - resultDefault.equityIrr!) * 100;
    // Direction: higher cost basis → lower IRR (gap is negative).
    expect(gapPp).toBeLessThan(0);
    // Magnitude: within ±1pp of the documented −12.92pp anchor. If this moves,
    // a material engine change happened — either A1's plumbing or downstream
    // IRR / cashflow logic.
    expect(gapPp).toBeCloseTo(-15.71, 0);
  });
});
