# Ares XV Reingest Readiness

Last checked: 2026-05-15.

## Source Bundle

The current local Ares XV source set is enough to reingest and run the model when these files are used together:

- `ppm.json`
- `compliance.json`
- `/Users/solal/Downloads/ARESXV_CDSDF_260401/SDF *.csv`
- `/Users/solal/Downloads/ARESXV_CDSDF_260401/2026_04_01_output_ares_euro15_positions.csv`
- `/Users/solal/Downloads/ARESEU15_20260420 - Intex Past Cashflows.csv`

The ARESXV folder contains `ARESEU15_20260420 - Intex Past Cashflows.xlsx`, but the current Intex past-cashflows parser expects the CSV export. Use the root Downloads CSV above for that step.

## Fixes Applied For This Bundle

- SDF percentage-like fields now parse single-separator three-decimal values as percentages/rates/prices. This covers fields such as `Market_Value=99.542`, tranche `Coupon=2.966`, note `Spread`, collateral `Current_Spread`, `All_In_Rate`, recovery rates, and asset-level `Mark_Price`.
- `ppm.json` snake_case principal POP input (`interest_waterfall`) is now normalized to the resolver's `interestWaterfall` shape.
- `ppm.json` interest mechanics now map `reference_weighted_average_fixed_coupon` and `deferred_interest_compounds`; the current Ares XV file also carries the PPM values directly.
- `ppm.json` now carries the Ares XV excess CCC threshold block needed by the resolver: 7.5% threshold and the engine's current scalar market-value percentage input.
- Resolver/build warnings now treat the PPM's "trustee fee per agreement" text as non-blocking when waterfall-derived trustee fee bps are already available.

## Offline Dry Run Result

Offline parsing of every CSV in `/Users/solal/Downloads/ARESXV_CDSDF_260401` produced zero parser warnings after the fixes.

An offline resolver/build/projection dry run using `ppm.json`, fixture compliance state, the parsed SDF bundle, and the Intex positions CSV succeeded:

- `buildFromResolved` produced 413 loans, 8 tranches, and initial par of `491406828.93`.
- `runProjection` produced 40 periods.
- First projected date was `2026-07-01`.
- First A/B OC actual was about `136.55` versus trigger `129.37`.
- Composed blocking warnings were empty.

The raw resolver can still emit the trustee-fee warning from PPM text alone. The production build path suppresses that warning only after the waterfall-derived trustee fee bps is present.

## Remaining Caveats

- Include the Intex positions CSV. Without it, the SDF/JSON-only path still leaves rating gaps that can block or degrade the resolver; with positions, the offline check found zero absent Moody's and Fitch ratings.
- The current engine input for excess CCC valuation is scalar (`cccMarketValuePct`), but Ares XV's PPM does not specify a fixed scalar. The exact rule selects the lowest-Market-Value Moody's Caa or Fitch CCC obligations included in the excess bucket and credits their actual Market Value. The scalar `70.0` in `ppm.json` is only an engine-default compatibility fallback, not PPM source truth. Current-period impact is zero: the trustee report shows Moody's Caa at 6.92%, Fitch CCC at 5.87%, both below the 7.5% threshold, and Caa/CCC adjustment is 0. If a future/stress projection breaches the threshold, exact Ares behavior would require per-position excess-bucket selection by market price; `70.0` is an approximation.
- Historical senior-expense carryforward seed derivation is still not automatic. The latest Ares XV bundle can run, but prior full waterfall periods are still needed to compute the exact rolling unused-headroom seed instead of relying on the current user-supplied/zero-seed behavior.
- Active DDTL/revolver ingestion remains blocked only when a real holding has positive unfunded commitment. This bundle's SDF collateral has one DDTL-flagged row but zero unfunded par, so the active-DDTL gate should not block this reingest.
