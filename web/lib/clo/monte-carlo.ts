// web/lib/clo/monte-carlo.ts

import { runProjection, type ProjectionInputs, type DefaultDrawFn } from "./projection";

export interface MonteCarloPercentiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface MonteCarloResult {
  runCount: number;
  irrs: Float64Array;
  percentiles: MonteCarloPercentiles;
  meanIrr: number;
  ocFailureByQuarter: { quarter: number; failurePct: number; byClass: Record<string, number> }[];
  peakOcFailurePct: number;
  medianEquityDistributions: number;
}

function bernoulliDraw(survivingPar: number, hazardRate: number): number {
  return Math.random() < hazardRate ? survivingPar : 0;
}

function percentile(sorted: Float64Array, p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export function runMonteCarlo(
  inputs: ProjectionInputs,
  runCount: number,
  onProgress?: (completed: number) => void,
): MonteCarloResult {
  const irrs = new Float64Array(runCount);
  const equityDists = new Float64Array(runCount);

  // Determine total quarters for OC tracking.
  // Use the maximum possible projection length so MC runs with different
  // default paths don't silently lose OC data for later quarters.
  const calibration = runProjection(inputs);
  const totalQuarters = Math.max(calibration.periods.length, inputs.maturityDate
    ? Math.ceil((new Date(inputs.maturityDate).getTime() - new Date(inputs.currentDate).getTime()) / (1000 * 60 * 60 * 24 * 91.25))
    : calibration.periods.length);
  // Track OC failures per quarter per class
  const ocClasses = calibration.periods[0]?.ocTests.map(t => t.className) ?? [];
  const ocFailureCounts = new Uint32Array(totalQuarters); // any class
  const ocFailureByClass: Record<string, Uint32Array> = {};
  for (const cls of ocClasses) {
    ocFailureByClass[cls] = new Uint32Array(totalQuarters);
  }

  for (let i = 0; i < runCount; i++) {
    const result = runProjection(inputs, bernoulliDraw);

    irrs[i] = result.equityIrr ?? -Infinity;
    equityDists[i] = result.totalEquityDistributions;

    // Track OC failures per quarter per class
    for (let q = 0; q < result.periods.length; q++) {
      let anyFail = false;
      for (const test of result.periods[q].ocTests) {
        if (!test.passing) {
          anyFail = true;
          if (ocFailureByClass[test.className]) {
            ocFailureByClass[test.className][q]++;
          }
        }
      }
      if (anyFail) ocFailureCounts[q]++;
    }

    if (onProgress && (i + 1) % 500 === 0) {
      onProgress(i + 1);
    }
  }

  // Sort IRRs for percentile computation
  const sortedIrrs = new Float64Array(irrs);
  sortedIrrs.sort();

  // Sort equity distributions for median
  const sortedDists = new Float64Array(equityDists);
  sortedDists.sort();

  // Compute mean IRR (excluding nulls represented as -Infinity)
  let irrSum = 0;
  let irrCount = 0;
  for (let i = 0; i < irrs.length; i++) {
    if (isFinite(irrs[i])) {
      irrSum += irrs[i];
      irrCount++;
    }
  }

  const ocFailureByQuarter = Array.from(ocFailureCounts).map((count, q) => {
    const byClass: Record<string, number> = {};
    for (const cls of ocClasses) {
      byClass[cls] = (ocFailureByClass[cls][q] / runCount) * 100;
    }
    return { quarter: q + 1, failurePct: (count / runCount) * 100, byClass };
  });
  const peakOcFailurePct = Math.max(0, ...ocFailureByQuarter.map(q => q.failurePct));

  return {
    runCount,
    irrs: sortedIrrs,
    percentiles: {
      p5: percentile(sortedIrrs, 0.05),
      p25: percentile(sortedIrrs, 0.25),
      p50: percentile(sortedIrrs, 0.50),
      p75: percentile(sortedIrrs, 0.75),
      p95: percentile(sortedIrrs, 0.95),
    },
    meanIrr: irrCount > 0 ? irrSum / irrCount : 0,
    ocFailureByQuarter,
    peakOcFailurePct,
    medianEquityDistributions: percentile(sortedDists, 0.50),
  };
}
