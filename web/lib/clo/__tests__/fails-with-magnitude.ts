import { expect, it } from "vitest";

/**
 * `failsWithMagnitude` — test helper for documented "known broken" state.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Purpose: assert that a measured drift matches the known bug's documented
 * magnitude. The pattern replaces Vitest's raw `.fails()` which can silently
 * absorb regressions — if a bug gets WORSE, `.fails()` still treats the test
 * as passing because the assertion still fails.
 *
 * This helper uses a three-way verdict:
 *
 *   1. |observed| < tolerance         →  FAIL  "drift closed, remove marker"
 *       (the fix landed; test author must remove this helper and add a real
 *        correctness assertion)
 *
 *   2. |observed − expected| ≤ tolerance  →  PASS
 *       (known broken state, magnitude as documented)
 *
 *   3. otherwise                      →  FAIL  "drift magnitude changed,
 *                                              investigate regression"
 *       (bug got better-but-not-closed, or worse, or something else moved)
 *
 * The `ki` and `closesIn` strings go into the test name so failures carry
 * context directly — a developer debugging a CI failure sees which KI entry
 * and which sprint they're looking at without digging into the test body.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Usage:
 *   failsWithMagnitude(
 *     {
 *       ki: "KI-08",
 *       closesIn: "Sprint 3 / C3",
 *       expectedDrift: -64660.20,
 *       tolerance: 100,
 *     },
 *     "trusteeFeesPaid matches trustee",
 *     () => computedDrift
 *   );
 */
export interface FailsWithMagnitudeOpts {
  /** KI ledger entry identifier (e.g. "KI-08"). Appears in test name and failure message. */
  ki: string;
  /** Human description of the closing sprint (e.g. "Sprint 3 / C3"). */
  closesIn: string;
  /** Documented drift magnitude under current broken state. Signed (projected − actual). */
  expectedDrift: number;
  /** Acceptable deviation around `expectedDrift`. */
  tolerance: number;
  /** Threshold below which `|observed|` is treated as "drift closed" (fix landed,
   *  remove the marker). Defaults to `tolerance`. Set this EXPLICITLY and tighter
   *  than `tolerance` when `|expectedDrift|` is small enough that a partial fix
   *  could drop observed drift below `tolerance` without actually closing — e.g.
   *  KI-13 cascade markers where expectedDrift is in the hundreds and tolerance
   *  is €50, a partial upstream close could trigger a false "CLOSED" signal.
   *  A good rule of thumb: set `closeThreshold` to ~10% of `|expectedDrift|` for
   *  cascade markers; accept `tolerance` as the default for well-separated cases
   *  (|expectedDrift| ≥ 10× tolerance). */
  closeThreshold?: number;
}

/**
 * Register a test that asserts a documented-bug drift has its documented magnitude.
 *
 * @param opts - ledger metadata (KI ref, closing sprint, expected magnitude)
 * @param testName - short human title for the bucket/assertion
 * @param observedDriftFn - returns the measured (projected − actual) drift in the same
 *                         units as `expectedDrift`. Throws become test failures.
 */
export function failsWithMagnitude(
  opts: FailsWithMagnitudeOpts,
  testName: string,
  observedDriftFn: () => number,
): void {
  const fullName =
    `[${opts.ki}, closes ${opts.closesIn}] ${testName} ` +
    `— expected drift ${formatDrift(opts.expectedDrift)} ± ${formatDrift(opts.tolerance)}`;

  const closeThreshold = opts.closeThreshold ?? opts.tolerance;

  it(fullName, () => {
    const observed = observedDriftFn();

    // Three-way verdict.
    if (Math.abs(observed) < closeThreshold) {
      // Case 1: drift closed. Fix landed.
      throw new Error(
        `[${opts.ki}] drift CLOSED. ` +
          `Observed drift = ${formatDrift(observed)} (|·| < close threshold ${formatDrift(closeThreshold)}). ` +
          `Expected pre-fix magnitude was ${formatDrift(opts.expectedDrift)}. ` +
          `Remove the failsWithMagnitude marker at this test site, ` +
          `update the KI ledger entry to status=closed (closed in ${opts.closesIn}), ` +
          `and add a real correctness assertion in its place.`,
      );
    }

    // Case 2/3: magnitude check.
    const delta = Math.abs(observed - opts.expectedDrift);
    expect(
      delta <= opts.tolerance,
      `[${opts.ki}] drift MAGNITUDE CHANGED. ` +
        `Expected ${formatDrift(opts.expectedDrift)} ± ${formatDrift(opts.tolerance)} ` +
        `(per KI ledger entry, closes ${opts.closesIn}). ` +
        `Observed: ${formatDrift(observed)} (Δ vs expected: ${formatDrift(observed - opts.expectedDrift)}). ` +
        `Either (a) a partial fix landed — update the ledger entry and this expectedDrift; ` +
        `(b) a regression introduced additional drift — investigate the recent engine changes; ` +
        `(c) a compensating bug was added that offsets this one — investigate upstream.`,
    ).toBe(true);
  });
}

function formatDrift(v: number): string {
  if (!isFinite(v)) return `${v}`;
  const sign = v >= 0 ? "+" : "−";
  return `${sign}€${Math.abs(v).toLocaleString("en-EU", { maximumFractionDigits: 2 })}`;
}
