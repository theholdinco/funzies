/**
 * Fair-value-at-hurdle service.
 *
 * Binary-searches the entry-price (in cents of subNotePar) at which the
 * forward equity IRR equals a target hurdle. Pure function over engine
 * inputs; the engine is invoked once per bisection step.
 *
 * Forward IRR is monotonically decreasing in entry price (higher purchase
 * price → larger initial outflow → lower IRR for fixed projected cashflows).
 * Bisection brackets [MIN_CENTS, MAX_CENTS] = [0.1c, 200c].
 *
 * Statuses:
 *  - "converged"          — bisection found a price within TOLERANCE_CENTS.
 *  - "below_hurdle"       — even at near-free entry the deal can't reach the
 *                           target IRR. priceCents = null.
 *  - "above_max_bracket"  — at MAX_CENTS the IRR is still above the target;
 *                           a richer entry price would still clear the
 *                           hurdle. priceCents = null.
 *  - "wiped_out"          — calibration says equity is balance-sheet
 *                           insolvent at t=0; IRR is undefined regardless
 *                           of entry price. priceCents = null.
 *
 * Caller responsibility: rerun on assumption changes; cache via useMemo
 * upstream. Each call performs ~12 engine runs (one bracket calibration +
 * ~11 bisection steps).
 */

import { runProjection, type ProjectionInputs } from "../projection";

export type FairValueStatus = "converged" | "below_hurdle" | "above_max_bracket" | "wiped_out";

export interface FairValueResult {
  hurdle: number;
  priceCents: number | null;
  status: FairValueStatus;
  iterations: number;
}

const MAX_CENTS = 200;
const TOLERANCE_CENTS = 0.05;
const MAX_ITERATIONS = 30;
// Probe ladder: used to find a finite-IRR lower-bracket anchor. Newton-Raphson
// can fail to converge at near-free entry (IRR asymptotically large) or at
// very high entry on impaired deals (all flows negative). We walk a fixed
// ladder of probe prices and pick the lowest one whose IRR is finite as the
// bisection lower bracket.
const PROBE_LADDER = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];

function irrAtPrice(
  inputs: ProjectionInputs,
  subNotePar: number,
  priceCents: number,
): number | null {
  const equityEntryPrice = subNotePar * (priceCents / 100);
  const result = runProjection({ ...inputs, equityEntryPrice });
  return result.equityIrr;
}

export function computeFairValueAtHurdle(
  inputs: ProjectionInputs,
  subNotePar: number,
  targetIrr: number,
): FairValueResult {
  if (subNotePar <= 0) {
    return { hurdle: targetIrr, priceCents: null, status: "wiped_out", iterations: 0 };
  }

  // Short-circuit on balance-sheet-insolvent deals before bracket sweeps.
  const calibration = runProjection({ ...inputs, equityEntryPrice: subNotePar });
  if (calibration.initialState.equityWipedOut) {
    return { hurdle: targetIrr, priceCents: null, status: "wiped_out", iterations: 0 };
  }

  // Walk the probe ladder; collect prices where IRR is finite. The lowest
  // anchors the bisection lower bracket; the highest anchors the upper.
  const probes: { priceCents: number; irr: number }[] = [];
  for (const p of PROBE_LADDER) {
    const irr = irrAtPrice(inputs, subNotePar, p);
    if (irr !== null && Number.isFinite(irr)) {
      probes.push({ priceCents: p, irr });
    }
  }
  if (probes.length === 0) {
    return { hurdle: targetIrr, priceCents: null, status: "wiped_out", iterations: PROBE_LADDER.length };
  }

  const lowest = probes[0];
  const highest = probes[probes.length - 1];

  // At the lowest finite-IRR price the IRR is at its highest measurable value.
  // If even that's below the target, the deal can't reach the hurdle.
  if (lowest.irr < targetIrr) {
    return { hurdle: targetIrr, priceCents: null, status: "below_hurdle", iterations: probes.length };
  }
  // At the highest finite-IRR price the IRR is at its lowest measurable value.
  // If that's still above the target, the bracket cap [0, MAX_CENTS] doesn't
  // contain the fair-value price.
  if (highest.irr > targetIrr) {
    return { hurdle: targetIrr, priceCents: null, status: "above_max_bracket", iterations: probes.length };
  }

  let lo = lowest.priceCents;
  let hi = highest.priceCents;
  let iterations = probes.length;
  while (hi - lo > TOLERANCE_CENTS && iterations < MAX_ITERATIONS) {
    const mid = (lo + hi) / 2;
    const irr = irrAtPrice(inputs, subNotePar, mid);
    iterations++;
    // Null IRR mid-bisection: treat as above-target (search higher prices).
    // The bracket boundaries above guarantee the search stays inside
    // [lowest.priceCents, highest.priceCents] where IRR was finite, so this
    // case is rare but defensible if Newton-Raphson stalls on a midpoint.
    if (irr === null || irr > targetIrr) lo = mid;
    else hi = mid;
  }

  return {
    hurdle: targetIrr,
    priceCents: (lo + hi) / 2,
    status: "converged",
    iterations,
  };
}

export function computeFairValuesAtHurdles(
  inputs: ProjectionInputs,
  subNotePar: number,
  targetIrrs: number[],
): FairValueResult[] {
  return targetIrrs.map((t) => computeFairValueAtHurdle(inputs, subNotePar, t));
}
