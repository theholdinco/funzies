// Pure deterministic CLO waterfall projection engine — no React, no DOM.
// Runs entirely client-side for instant recalculation.

import { CLO_DEFAULTS } from "./defaults";
import { POST_ACCEL_SEQUENCE } from "./waterfall-schema";
import { warfFactorToQuarterlyHazard } from "./rating-mapping";
import {
  BUCKET_WARF_FALLBACK,
  aggregateQualityMetrics,
  computePoolQualityMetrics,
  type PoolQualityMetrics,
  type QualityMetricLoan,
} from "./pool-metrics";
import {
  applySeniorExpensesToAvailable,
  sumSeniorExpensesPreOverflow,
  type SeniorExpenseBreakdown,
} from "./senior-expense-breakdown";
import type { DayCountConvention } from "./day-count-canonicalize";
import type { ResolvedDiscountObligationRule, ResolvedLongDatedValuationRule } from "./resolver-types";
import { resolveAgencyRecovery } from "./recovery-rate";

export interface LoanInput {
  /** Currently-funded (drawn) par. Interest accrues on this balance only.
   *  For a fully-drawn DDTL this equals the SDF Principal_Funded_Balance
   *  (Eleda-shape: parBalance > 0, undrawnCommitment === 0); for an entirely
   *  unfunded DDTL pre-draw this is 0 with the future commitment carried in
   *  `undrawnCommitment`. The engine never accrues interest on the unfunded
   *  portion. */
  parBalance: number;
  maturityDate: string;
  ratingBucket: string;
  spreadBps: number;
  isFixedRate?: boolean;
  fixedCouponPct?: number;
  /** Facility-type tag — DDTL (Delayed Draw Term Loan). Informational only.
   *  Survives the draw event (a fully drawn DDTL is still a DDTL facility,
   *  used by the Revolving/DDTL concentration test). The currently-unfunded
   *  state lives on `undrawnCommitment`, NOT here. */
  isDelayedDraw?: boolean;
  /** Facility-type tag — revolving credit facility. Informational; same
   *  semantics as `isDelayedDraw` (tag survives draws). The currently-
   *  unfunded state lives on `undrawnCommitment`. */
  isRevolving?: boolean;
  /** Currently-unfunded commitment (un-drawn portion of a DDTL or revolver).
   *  Subtracted from the OC numerator per PPM Adjusted Collateral Principal
   *  Amount. Defaults to 0 when undefined. Drops as the engine's draw event
   *  fires; preserved across partial draws (the un-drawn residual remains
   *  on this field rather than being silently discarded). */
  undrawnCommitment?: number;
  ddtlSpreadBps?: number;
  drawQuarter?: number;
  /** Current market price as percentage of par (e.g. 98.5 = 98.5c on the euro).
   *  Used for A3 call-at-MtM liquidation. Null/undefined = fall back to par (100). */
  currentPrice?: number | null;
  /** C2 — Moody's WARF factor for this position (Aaa=1, Ca/C=10000). Used for
   *  forward-projection WARF. When absent the engine derives from ratingBucket
   *  via `BUCKET_WARF_FALLBACK` (coarse-bucket midpoint — less accurate than
   *  per-position sub-bucket rating but acceptable for reinvestment paths). */
  warfFactor?: number | null;
  /** Per PPM "Deferring Security" — excluded from Floating Par denominator
   *  in `computePoolQualityMetrics`. Optional; defaults to undefined (treated
   *  as not deferring). */
  isDeferring?: boolean;
  /** Per PPM "Loss Mitigation Loan" — excluded from Floating Par AND from
   *  Caa/CCC concentration denominators. Optional; defaults to undefined. */
  isLossMitigationLoan?: boolean;
  /** ISO 4217 currency code. Used by `computePoolQualityMetrics` to flag
   *  Non-Euro Obligations (excluded from Floating Par when the deal currency
   *  differs). Optional; treated as deal-currency-denominated when absent. */
  currency?: string;
  /** Per-agency Moody's sub-bucket rating (e.g. "Caa2") for the per-agency
   *  Caa/CCC concentration tests. Optional; falls back to `ratingBucket`
   *  when both per-agency ratings are absent. */
  moodysRatingFinal?: string;
  /** Per-agency Fitch sub-bucket rating (e.g. "CCC+"). Same role as
   *  `moodysRatingFinal`. */
  fitchRatingFinal?: string;
  /** Lineage tag for the rung that produced `moodysRatingFinal`. Drives
   *  `qualityMetrics.pctMoodysRatingDerivedFromSp`. */
  moodysRatingSource?: import("./resolve-rating").MoodysRatingSource;
  /** True when Intex tags this position's Moody's OR Fitch rating as a
   *  credit estimate or private letter rating. Drives
   *  `qualityMetrics.pctOnCreditEstimateOrPrivateRating`. */
  isCreditEstimateOrPrivateRating?: boolean;
  /** Per-position day-count convention (canonicalized from
   *  `clo_holdings.day_count_convention`). When undefined, the engine
   *  falls back to Actual/360 — preserves byte-identical output on
   *  legacy fixtures whose loans don't carry this field. Reinvested
   *  loans synthesized inside the engine are always Actual/360 (the
   *  market default for floating Euro-denominated paper) and leave
   *  this field unset. */
  dayCountConvention?: DayCountConvention;
  /** Per-position EURIBOR floor in PERCENT (e.g. 0.5 = 0.5%, NOT 50%).
   *  Sourced from `clo_holdings.floor_rate` via the SDF Collateral File.
   *  When undefined, the engine falls back to the deal-level
   *  `baseRateFloorPct` (preserves byte-identical output on fixtures
   *  whose loans carry no per-position floor). The floating-rate
   *  per-loan accrual binds the floor at `max(loan.floorRate ??
   *  baseRateFloorPct, baseRatePct)` so each loan respects its own
   *  origination floor. Material in low-rate scenarios; zero impact
   *  when EURIBOR > all per-position floors. */
  floorRate?: number;
  /** Per-position agency recovery rates. Carried through `ResolvedLoan` to
   *  the engine; resolved at LoanState construction via
   *  `resolveAgencyRecovery` (single owner of the "lesser of available
   *  agency rates" convention shared with the resolver's T=0 site). When
   *  all three are undefined, the engine falls back to the global
   *  `recoveryPct` for the loan's forward-default recovery. */
  recoveryRateMoodys?: number;
  recoveryRateSp?: number;
  recoveryRateFitch?: number;
  /** Live forward PIK rate in basis points. Sourced
   *  from SDF `Current_Facility_Spread_PIK` via `ResolvedLoan.pikSpreadBps`.
   *  When > 0, the engine accretes `par × pikSpreadBps/10000 × dayFrac`
   *  to surviving par each period (additive on top of the cash leg —
   *  does NOT subtract from the existing `all_in_rate` / `fixedCouponPct`
   *  cash accrual). Zero / undefined → no PIK accretion (cash-paying or
   *  toggle-off PIK loan). */
  pikSpreadBps?: number;
  /** Per-position purchase price as percent of par (immutable post-
   *  acquisition). Sourced from `ResolvedLoan.purchasePricePct` (in turn
   *  from the SDF row's `purchase_price` column or the LLM-extracted
   *  holding's purchasePrice). Drives the discount-obligation
   *  classification at every period. Distinct from `currentPrice` —
   *  conflating them is a known footgun (purchase is locked at
   *  acquisition; current evolves with market). */
  purchasePricePct?: number;
  /** Date of acquisition (ISO YYYY-MM-DD). Used by the cure mechanic
   *  to gate "MV at-or-above cure threshold *since acquisition*". */
  acquisitionDate?: string;
  /** Per-position Discount Obligation classification flag at projection
   *  start. Re-evaluated per period inside the engine under the deal's
   *  `discountObligationRule.cureMechanic` (continuous_threshold may
   *  flip true→false; permanent_until_paid never flips). */
  isDiscountObligation?: boolean;
  /** Per-position Long-Dated Collateral Obligation classification flag.
   *  Universal classification rule (loan.maturityDate > deal.maturityDate);
   *  static — no cure mechanic. Engine consumes per period at the OC
   *  numerator construction site, dispatching the per-deal
   *  `longDatedValuationRule` (cap percentage, withinCap, postCap) over
   *  the Σ of long-dated positions. */
  isLongDated?: boolean;
}

// C2 — Coarse RatingBucket → Moody's WARF factor. Imported from pool-metrics.ts
// to share the convention between the projection engine (D2 per-position hazard
// fallback; reinvested-loan factor) and the switch simulator (D4 post-switch
// pool recomputation). NR → Caa2 (6500) per Moody's CLO methodology; see KI-19.

export type DefaultDrawFn = (survivingPar: number, hazardRate: number) => number;

export interface ProjectionInputs {
  initialPar: number;
  wacSpreadBps: number;
  baseRatePct: number;
  baseRateFloorPct: number; // floor on reference rate (e.g. 0 for EURIBOR floored at 0%)
  seniorFeePct: number;
  subFeePct: number;
  /** PPM step (A)(i) Issuer taxes, in bps p.a. on collateral par. Deducted
   *  before trustee fees. Default 0 when no Q1 actuals available.
   *  Back-derived by `defaultsFromResolved` from Q1 waterfall step (A)(i). */
  taxesBps?: number;
  /** PPM step (A)(ii) Issuer Profit Amount. Absolute € per period (not bps,
   *  not annualized). Per PPM Condition 1 definitions: €250 per regular
   *  period, €500 per period post-Frequency-Switch Event. Deducted between
   *  taxes (A.i) and trustee fees (B). Default 0 when no Q1 actuals
   *  available. Back-derived by `defaultsFromResolved` from Q1 step (A)(ii). */
  issuerProfitAmount?: number;
  trusteeFeeBps: number; // PPM step (B) trustee, in bps p.a. on collateral par
  /** C3 — PPM step (C) administrative expenses, in bps p.a. on collateral par.
   *  Jointly capped with trusteeFeeBps under Senior Expenses Cap; overflow
   *  routes to step (Z). Optional field (undefined on legacy test inputs). */
  adminFeeBps?: number;
  /** C3 — Senior Expenses Cap component (b) in bps p.a. on Collateral Principal
   *  Amount. Jointly bounds (trusteeFeeBps + adminFeeBps) expense emission;
   *  overflow above the cap routes to PPM steps (Y) trustee overflow and (Z)
   *  admin overflow, paid from residual interest after tranche interest + sub
   *  mgmt fee. Ares XV: 2.5 (= 0.025% per annum). Optional (defaults to
   *  effectively unbounded when undefined). */
  seniorExpensesCapBps?: number;
  /** C3 — Senior Expenses Cap component (a) absolute fixed component in
   *  €/year. Pro-rated by `dayFracActual` per period. Ares XV: 300_000.
   *  Optional (defaults to 0 when undefined; legacy test inputs that predate
   *  this field continue to behave as bps-only cap). */
  seniorExpensesCapAbsoluteFloorPerYear?: number;
  /** C3 — Senior Expenses Cap allocation rule for the capped portion (PPM
   *  steps B + C). Ares XV: "sequential_b_first" — Condition 3(c)(C) reads
   *  "less any amounts paid pursuant to paragraph (B) above" → trustee gets
   *  cap headroom first, admin gets the remainder. Optional; defaults to
   *  "pro_rata" for legacy test inputs. */
  seniorExpensesCapAllocationWithinCap?: "pro_rata" | "sequential_b_first";
  /** C3 — Senior Expenses Cap overflow allocation rule for steps Y + Z. Ares
   *  XV: "sequential_y_first" per POP convention. Optional; defaults to
   *  "pro_rata" for legacy test inputs. */
  seniorExpensesCapOverflowAllocation?: "pro_rata" | "sequential_y_first";
  /** C3 — Day-count for cap component (a) absolute floor. PPM proviso (a):
   *  Actual/360 on the deal's first PD; 30/360 on every other PD —
   *  represented as "30_360_after_first". Some deals apply uniform
   *  Actual/360 ("actual_360"). Optional; defaults to "actual_360"
   *  preserving legacy uniform behavior. Engine dispatches on the
   *  computed `isFirstPaymentDateOfDeal` flag derived from `firstPaymentDate`
   *  vs `currentDate`. */
  seniorExpensesCapComponentADayCount?: "30_360_after_first" | "actual_360";
  /** C3 — Cap base for component (b) bps × pool. PPM Condition 1 specifies
   *  Collateral Principal Amount (CPA = APB of Collateral Obligations
   *  including defaulted at par + Principal Account + Unused Proceeds
   *  Account). When "APB", engine uses `beginningPar` only (legacy).
   *  Optional; defaults to "APB". */
  seniorExpensesCapBaseMode?: "CPA" | "APB";
  /** C3 — Number of preceding Payment Dates whose unused cap headroom
   *  carries forward (PPM proviso (ii)). Ares XV: 3 pre-FSE, 1 post-FSE.
   *  Null = no carryforward (legacy behavior). */
  seniorExpensesCapCarryforwardPeriods?: number | null;
  /** C3 — Whether VAT on capped expenses counts toward cap (PPM proviso (i)).
   *  When fee inputs are gross-of-VAT (typical trustee back-derive path) the
   *  engine path is correct without explicit gross-up; this flag combined
   *  with non-null `seniorExpensesCapVatRatePct` triggers an explicit
   *  gross-up of `cappedRequested` for hand-set net-of-VAT inputs. */
  seniorExpensesCapVatIncluded?: boolean;
  /** C3 — Applicable VAT rate (%) to gross up `cappedRequested` by when
   *  fees are quoted net-of-VAT. Null when fees already include VAT. */
  seniorExpensesCapVatRatePct?: number | null;
  /** PPM Condition 1 first Payment Date of the deal. Used by the cap
   *  construction to decide component (a) day-count under
   *  `seniorExpensesCapComponentADayCount === "30_360_after_first"`:
   *  if `currentDate < firstPaymentDate`, the projection's first period is
   *  the deal's first PD (Actual/360); otherwise mid-life projection
   *  (30/360). Strict less-than because on the boundary
   *  `currentDate === firstPaymentDate`, q=1 ends at firstPaymentDate + 1Q
   *  (the deal's SECOND PD), so 30/360 applies. Null/undefined: engine
   *  assumes mid-life (30/360) — the engine has no anchor to distinguish
   *  the deal's first PD from any other. */
  firstPaymentDate?: string | null;
  hedgeCostBps: number; // Scheduled hedge payments (PPM Step F), in bps p.a. on collateral par
  incentiveFeePct: number; // % of residual above IRR hurdle (PPM Steps BB/U), e.g. 20
  incentiveFeeHurdleIrr: number; // annualized IRR hurdle, e.g. 0.12 for 12%
  postRpReinvestmentPct: number; // % of principal proceeds reinvested post-RP (0-100, typically 0-50)
  /** Manager call gating (post-v6 plan §4.1). When "none", `callDate` is
   *  ignored and the projection runs to maturity. When "optionalRedemption",
   *  the engine liquidates at `callDate` per `callPriceMode`. The Phase A
   *  type union deliberately excludes `"economic"` — that mode requires a
   *  threshold-design pre-commit (Phase D §7.4). */
  callMode: "none" | "optionalRedemption";
  /** Stub-period engine (post-v6 plan §4.2). When true (and
   *  `firstPeriodEndDate` is set), period 1 runs from `currentDate` to
   *  `firstPeriodEndDate` (intra-period stub) instead of a full quarter; CDR
   *  and CPR are prorated by the actual day-count fraction. Subsequent
   *  periods are full quarters from `firstPeriodEndDate`. Default
   *  undefined/false preserves byte-identical engine output on existing
   *  fixtures (period 1 = currentDate → currentDate + 1 quarter, no
   *  hazard proration). Caller computes `firstPeriodEndDate` from the deal's
   *  payment-cadence anchor (typically `dates.firstPaymentDate` walked
   *  forward by quarters until the first scheduled date strictly after
   *  `currentDate`). */
  stubPeriod?: boolean;
  firstPeriodEndDate?: string | null;
  /** Reinvestment-period extension (post-v6 plan §4.5). When set, the engine
   *  uses `max(reinvestmentPeriodEnd, reinvestmentPeriodExtension)` as the
   *  effective RP end — the user's extension can extend, but cannot
   *  inadvertently shorten, an already-late extracted RP end. Null means no
   *  extension; the extracted RP end is used as-is. */
  reinvestmentPeriodExtension?: string | null;
  callDate: string | null; // optional redemption date — when callMode === "optionalRedemption", projection stops here and liquidates
  /** Non-Call Period End — PPM Condition 7.2. The earliest date at which
   *  the manager can call. When set and `callMode === "optionalRedemption"`,
   *  the engine refuses `callDate < nonCallPeriodEnd` (pre-NCP call is
   *  economically incoherent — the option doesn't exist). When null/undefined
   *  the gate is skipped (NCP not known → engine cannot enforce). The
   *  canonical user path through `buildFromResolved` blocks at the resolver
   *  layer when NCP is missing on a CLO; this engine field is the backstop
   *  for hand-constructed inputs. Optional so synthetic test fixtures that
   *  do not model a call boundary stay terse — they pay no migration cost
   *  for adding the field, and the gate stays inert on those inputs. */
  nonCallPeriodEnd?: string | null;
  callPricePct: number; // liquidation price as % of par; only used when callPriceMode === "manual"
  /** Call liquidation price semantics (A3):
   *  - 'par': every position sells at face value (callPricePct ignored).
   *  - 'market': every position sells at its observed currentPrice; throws if
   *    holdings-level prices aren't available (post-v6 plan §4.1 — no silent
   *    par fallback; that would manufacture optimism on healthy deals).
   *  - 'manual': every position sells at `callPricePct` (flat percentage of par,
   *    regardless of market).
   *    Legacy behavior; useful for quick stress ("assume everything sells at 98c"). */
  callPriceMode: "par" | "market" | "manual";
  reinvestmentOcTrigger: { triggerLevel: number; rank: number; diversionPct: number } | null; // Reinvestment OC test — diversionPct % of remaining interest diverted during RP
  /** B1 — Event of Default Par Value Test (PPM 10(a)(iv)). Distinct from
   *  class-level OC; uses compositional numerator + Class-A-only denominator.
   *  Null/undefined = deal has no separately-tracked EoD test (legacy test
   *  fixtures pre-B1; synthetic inputs that don't need EoD). Engine emits
   *  `initialState.eodTest = null` when absent. */
  eventOfDefaultTest?: { triggerLevel: number } | null;
  tranches: {
    className: string;
    currentBalance: number;
    spreadBps: number;
    seniorityRank: number;
    isFloating: boolean;
    isIncomeNote: boolean;
    isDeferrable: boolean;
    isAmortising?: boolean; // principal paid from interest waterfall on fixed schedule (e.g. Class X)
    amortisationPerPeriod?: number | null; // fixed amount per quarter (null = pay full remaining balance)
    amortStartDate?: string | null; // date when amort begins (e.g. second payment date). If null or past, amort active immediately.
    /** PPM § 10(a)(i) — prior-period cumulative unpaid base interest carried
     *  into the projection (€). Seeds the engine's running `interestShortfall`
     *  state at T=0. Null/undefined → 0 (no carry). On a deal whose trustee
     *  report shows mid-grace shortfall on a non-deferrable senior tranche,
     *  populating this from the resolver makes EoD-on-shortfall fire at the
     *  PPM-correct period. Today the resolver returns null pending PPM
     *  extraction; the type and engine path are wired so a future extraction
     *  fix is a one-line resolver change. */
    priorInterestShortfall?: number | null;
    /** PPM § 10(a)(i) — consecutive-period shortfall counter at T=0. Pairs
     *  with `priorInterestShortfall`: if the trustee report shows N periods
     *  of consecutive non-payment, seed counter to N so the engine fires EoD
     *  at the correct boundary rather than re-deriving from scratch. Same
     *  null/undefined → 0 default + same TODO as `priorInterestShortfall`. */
    priorShortfallCount?: number | null;
    /** PPM Condition 6(c) — opening Deferred Interest balance at T=0 (€).
     *  Sourced from trustee `CloTrancheSnapshot.deferredInterestBalance`.
     *  Engine seed semantics are conditional on `deferredInterestCompounds`:
     *    - compounds=true → ignored (PIK already in currentBalance under
     *      compounding PPM; seeding would double-count).
     *    - compounds=false → seeds `deferredBalances[className]` (separate
     *      sub-account convention).
     *  Resolver populates from snapshot; null = trustee did not report. */
    deferredInterestBalance?: number | null;
    /** Per-tranche day-count convention (canonicalized from
     *  `clo_tranches.day_count_convention`). When undefined, the engine
     *  falls back to `isFloating ? actual_360 : 30_360` — preserves
     *  byte-identical output on legacy fixtures. Class B-2 in Euro XV
     *  carries 30E/360 and is the load-bearing case for this field. */
    dayCountConvention?: DayCountConvention;
  }[];
  ocTriggers: { className: string; triggerLevel: number; rank: number }[];
  icTriggers: { className: string; triggerLevel: number; rank: number }[];
  reinvestmentPeriodEnd: string | null;
  maturityDate: string | null;
  currentDate: string;
  loans: LoanInput[];
  defaultRatesByRating: Record<string, number>;
  /** §7.5 — Optional time-varying CDR path. When present, called once per
   *  quarter (1-indexed) to obtain that period's `defaultRatesByRating`
   *  map. When absent, the engine uses the constant `defaultRatesByRating`
   *  for every quarter.
   *
   *  Semantics under per-position WARF (the only hazard branch): the
   *  returned map is converted to a per-bucket *multiplier* against
   *  `defaultRatesByRating`. If the returned bucket is `5%` and the
   *  constant baseline is `2%`, the multiplier is `5/2 = 2.5×`, which
   *  scales each loan's WARF-derived hazard by 2.5× for that quarter.
   *  When the constant baseline for a bucket is zero, the multiplier is
   *  undefined and the engine falls back to the bucket-map hazard for
   *  that loan — callers wanting "no defaults" should pair a non-zero
   *  baseline with a zero-returning path-fn (multiplier 0/baseline = 0
   *  → hazard = warfHazard × 0 = 0).
   *
   *  The function form is the breakage-free alternative to the original
   *  `Record<bucket, pct[]>` proposal — same modeling power, no fixture
   *  migration cost. Monte Carlo callers supply a path that draws each
   *  quarter from a calibrated distribution; deterministic callers can
   *  hard-code a stress curve. */
  cdrMultiplierPathFn?: (q: number) => Record<string, number>;
  cprPct: number;
  recoveryPct: number;
  recoveryLagMonths: number;
  /** Deal's Rating Agencies set per the indenture (e.g. `["moodys", "fitch"]`
   *  for Ares European XV, oc.txt:368-369). Consumed at LoanState construction
   *  to filter per-position agency recovery rates: a holding rated by an
   *  agency that is not the deal's Rating Agency does NOT contribute to the
   *  per-loan recovery rate (the agency's RR is irrelevant to this indenture's
   *  Adjusted CPA paragraph (e) per `oc.txt:7120-7124`). Optional with
   *  `["moodys", "sp", "fitch"]` fallback for hand-constructed test fixtures
   *  that don't model the agency-subset distinction; production callers via
   *  `buildFromResolved` always pass the resolved set explicitly. */
  ratingAgencies?: ("moodys" | "sp" | "fitch")[];
  reinvestmentSpreadBps: number;
  reinvestmentTenorQuarters: number;
  reinvestmentRating: string | null; // null = use portfolio modal
  /** Assumed purchase price (as percent of par) for reinvested loans
   *  synthesized mid-projection. Drives the price-aware cure math in
   *  `computeReinvOcDiversion` and the per-position classification of
   *  synthesised loans (sub-threshold purchases become discount obligations
   *  immediately). Default 100 (par-purchase) for hand-constructed test
   *  inputs. Production callers via `buildFromResolved` resolve in this
   *  order: `UserAssumptions.reinvestmentPricePct` slider override →
   *  pool-weighted-average `currentPrice` (Σ par × currentPrice / Σ par
   *  over loans) → 100 fallback when the pool carries no priced positions. */
  reinvestmentPricePct?: number;
  /** Provenance tag for `reinvestmentPricePct`. Surfaced via
   *  `initialState.reinvestmentPriceSource` for partner-facing
   *  transparency and the par-fallback banner. */
  reinvestmentPriceSource?: "user_override" | "pool_was_derived" | "par_fallback";
  cccBucketLimitPct: number; // CCC excess above this % of par is haircut in OC test
  cccMarketValuePct: number; // market value assumption for CCC excess haircut (% of par)
  deferredInterestCompounds: boolean; // whether PIK'd interest itself earns interest
  initialPrincipalCash?: number; // uninvested principal in accounts at projection start (flows through waterfall Q1)
  /** Unused Proceeds Account opening balance at T=0. Per PPM Condition 1
   *  CPA definition (d), the Balance "standing to the credit of the Principal
   *  Account and the Unused Proceeds Account" augments the Collateral
   *  Principal Amount used as the Senior Expenses Cap component (b) base.
   *  The engine has no flow that mutates this balance across periods, so
   *  it contributes to CPA at q=1 only; q≥2 is treated as zero. Default 0. */
  initialUnusedProceedsCash?: number;
  /** Mid-life carryforward seed: prior unused stated-cap headroom
   *  from the trustee history, length up to `seniorExpensesCapCarryforwardPeriods`.
   *  Engine appends this to the carryforward FIFO buffer at projection
   *  start so a mid-life projection's first periods see the same
   *  augmentation the trustee report would. Default empty (appropriate
   *  at deal inception). */
  seniorExpensesCapCarryforwardSeed?: number[];
  /** Interest Account opening balance at T=0. Per PPM Condition 3(j)(ii)(1)
   *  the Interest Account is fully transferred to the Payment Account on the
   *  Business Day prior to each Payment Date for disbursement under the
   *  Interest Priority of Payments — so the opening balance flows into Q1
   *  `availableInterest` ahead of step (A)(i). The balance also earns yield
   *  per Condition 3(j)(ii)(B); the engine mirrors `initialPrincipalCash`
   *  yield treatment. NOT credited to the OC numerator (Adjusted Collateral
   *  Principal Amount per Condition 1(d) limits account-cash credit to the
   *  Principal Account and the Unused Proceeds Account only). Included in
   *  `equityBookValue` as a balance-sheet identity. */
  initialInterestAccountCash?: number;
  /** Interest Smoothing Account opening balance at T=0. Per PPM
   *  Condition 3(j)(xii) the Smoothing Amount deposited at a given
   *  Determination Date is transferred BACK to the Interest Account on
   *  the BD after the next Payment Date — so a non-zero opening balance
   *  is mid-cycle and flushes into Q1 `availableInterest` automatically.
   *  Q1 treatment of opening balance is independent of Frequency Switch
   *  Event (FSE only gates FUTURE deposits to zero per the Smoothing
   *  Amount definition). Multi-period FSE-coupled deposit/withdrawal
   *  dynamics are out-of-scope here (KI-04). NOT credited to the OC
   *  numerator. Included in `equityBookValue`. */
  initialInterestSmoothingBalance?: number;
  /** Expense Reserve Account opening balance at T=0. Per PPM
   *  Condition 3(j)(x)(4) and Interest Priority of Payments steps (B) +
   *  (C), the Expense Reserve Balance augments the Senior Expenses Cap
   *  each period: trustee/admin fees can draw up to
   *  `seniorExpensesCap + expenseReserveBalance`. Drains as overflow is
   *  paid; carries forward across periods until exhausted. Distinct
   *  from KI-02 step (D) deposit-into-reserve flow. NOT credited to the
   *  OC numerator. Included in `equityBookValue`. */
  initialExpenseReserveBalance?: number;
  /** Supplemental Reserve Account opening balance at T=0. Per PPM
   *  Condition 3(j)(vi) the Collateral Manager has discretion across
   *  eight Permitted Uses; no automatic flow on a determination date.
   *  Q1 treatment is governed by `supplementalReserveDisposition`
   *  (modeling assumption — defaults to "principalCash" which mirrors
   *  `initialPrincipalCash` Q1 routing). NOT credited to the OC
   *  numerator. Included in `equityBookValue`. */
  initialSupplementalReserveBalance?: number;
  /** User assumption — Q1 disposition of the Supplemental Reserve
   *  opening balance. PPM Condition 3(j)(vi) gives the manager
   *  discretion; this is a modeling assumption, not an extracted value.
   *  "principalCash" (default) mirrors `initialPrincipalCash` routing
   *  (RP→reinvestment, post-RP→senior paydown). "interest" routes the
   *  balance into Q1 `availableInterest` (PPM 3(j)(vi)(B)). "hold"
   *  leaves the balance on the books (claim against equity at maturity). */
  supplementalReserveDisposition?: "principalCash" | "interest" | "hold";
  preExistingDefaultedPar?: number; // par of pre-existing defaulted loans
  preExistingDefaultRecovery?: number; // market-price recovery for priced defaulted holdings
  unpricedDefaultedPar?: number; // par of defaulted holdings without market price (model applies recoveryPct)
  preExistingDefaultOcValue?: number; // recovery value for OC numerator (agency rate — typically higher than market)
  /** Trustee-reported long-dated haircut (`parValueAdjustments`
   *  LONG_DATED_HAIRCUT rows). Engine no longer consumes for the OC
   *  numerator — see `longDatedValuationRule` for the per-deal
   *  valuation rule the engine dispatches on. Retained for the T=0
   *  reconciliation drift warning at the resolver layer. */
  longDatedObligationHaircut?: number;
  /** PPM Discount Obligation classification + cure rule (Condition 1).
   *  Resolver-extracted; engine consumes per-period for per-position
   *  discount-obligation classification and price-aware cure math.
   *  Null on legacy fixtures and synthetic test inputs that don't model
   *  the discount mechanic — engine leaves all positions classified by
   *  whatever LoanInput.isDiscountObligation arrives at. */
  discountObligationRule?: ResolvedDiscountObligationRule | null;
  /** PPM Long-Dated Obligation valuation rule (Condition 1 + APB(e)).
   *  Resolver-extracted; engine drives the long-dated haircut from
   *  per-position Σ over `loanStates` filtered by `isLongDated`,
   *  dispatching on `withinCap` × `postCap`. Null on legacy fixtures
   *  and hand-constructed test inputs — engine emits zero haircut
   *  when null (matches greenfield / no-rule semantics). */
  longDatedValuationRule?: ResolvedLongDatedValuationRule | null;
  impliedOcAdjustment?: number; // derived residual between trustee's Adjusted CPA and identified components
  quartersSinceReport?: number; // quarters between compliance report and projection start (adjusts default recovery timing)
  ddtlDrawPercent?: number; // % of DDTL par actually funded on draw (default 100)
  equityEntryPrice?: number; // user-specified entry price for equity IRR (overrides balance-sheet implied value)
  /** PPM § 10(a)(i) — number of consecutive *payment-date* interest
   *  shortfalls on a non-deferrable senior tranche before an Event of
   *  Default fires. Null/undefined defaults to 0 — the PPM-correct
   *  semantic for the standard cure window. PPM § 10(a)(i) typically
   *  cures EoD if the missed payment is made within ~5 business days
   *  of the payment date, which is sub-period in a quarterly model:
   *  if the payment is still unpaid at the *next* checkpoint (this
   *  engine's period boundary), the cure window has lapsed. Set
   *  explicitly only when modelling a deal whose PPM grants a multi-
   *  period grace (rare; provided as an input for completeness). */
  interestNonPaymentGracePeriods?: number | null;
  /** C1 — Moody's Maximum WARF trigger (e.g. 3148 on Euro XV). When set, the
   *  engine scales down reinvestment if the purchase at `reinvestmentRating`
   *  would cause post-buy WARF to breach the trigger (and WARF wasn't already
   *  breaching). Excess principal flows to senior paydown instead. Null =
   *  no enforcement. */
  moodysWarfTriggerLevel?: number | null;
  /** C1 — Minimum Weighted Average Floating Spread trigger in bps (e.g. 365
   *  on Euro XV). When set, engine scales down reinvestment that would push
   *  post-buy `floatingWAS + ExcessWAC` below the trigger. Null = no
   *  enforcement (deal not rated by Moody's or no Min WAS test extracted). */
  minWasBps?: number | null;
  /** C1 — Moody's Caa Obligations concentration limit in pct (e.g. 7.5 on
   *  Euro XV). Engine blocks reinvestment that would push post-buy
   *  `pctMoodysCaa` above the limit. Null = no enforcement. */
  moodysCaaLimitPct?: number | null;
  /** C1 — Fitch CCC Obligations concentration limit in pct (e.g. 7.5 on
   *  Euro XV). Engine blocks reinvestment that would push post-buy
   *  `pctFitchCcc` above the limit. Null = no enforcement. */
  fitchCccLimitPct?: number | null;
  /** C2 — PPM Reference Weighted Average Fixed Coupon (%); PDF p. 305.
   *  Anchor for the Excess WAC adjustment in `computePoolQualityMetrics`.
   *  When omitted the helper defaults to 4.0% (Euro XV value). */
  referenceWafcPct?: number | null;
  /** C2 — Deal currency (ISO 4217). Loans whose `currency` differs are
   *  excluded from the Floating Par denominator as Non-Euro Obligations.
   *  When null/omitted, no currency filter applies. */
  dealCurrency?: string | null;
  /** D2b — Per-bucket override hook. When a rating bucket appears in this
   *  list, the engine uses the user's `defaultRatesByRating[bucket]` hazard
   *  for every loan in that bucket, overriding the per-position WARF hazard.
   *  Buckets absent from the list keep per-position WARF (the D2 default).
   *  Wired to the UI bucket-CDR sliders: a slider that the user has touched
   *  reports its bucket here, so the slider value actually takes effect. */
  overriddenBuckets?: readonly string[];
}

/** Per-step waterfall emission for N1 harness comparison against trustee
 *  realized waterfall rows. All values here are already computed as local
 *  variables inside the period loop — this sub-object just exposes them
 *  on the output so the harness can tie out trustee vs engine step-by-step.
 *
 *  Trustee-step mapping (see web/lib/clo/ppm-step-map.ts):
 *    - taxes                  → PPM step (A)(i) (issuer taxes Sprint 3)
 *    - trusteeFeesPaid        → PPM step (B) ONLY (trustee fee; split from admin in Sprint 3 / C3)
 *    - adminFeesPaid          → PPM step (C) (admin expenses; split from trustee in Sprint 3 / C3)
 *    - trusteeOverflowPaid    → PPM step (Y) (trustee-fee overflow past cap, residual-interest funded)
 *    - adminOverflowPaid      → PPM step (Z) (admin-expense overflow past cap)
 *    - seniorMgmtFeePaid      → PPM step (E) (current + past-due bundled)
 *    - hedgePaymentPaid       → PPM step (F) (non-defaulted hedge only)
 *    - subMgmtFeePaid         → PPM step (X)
 *    - incentiveFeeFromInterest → PPM step (CC) (interest waterfall)
 *    - incentiveFeeFromPrincipal → PPM step (U) (principal waterfall)
 *    - ocCureDiversions       → PPM steps (I)/(L)/(O)/(R)/(U) keyed by tranche rank
 *    - reinvOcDiversion       → PPM step (W) (Reinvestment OC Test diversion)
 *    - equityFromInterest     → PPM step (DD) (interest residual to sub notes)
 *    - equityFromPrincipal    → Principal waterfall residual to sub notes
 *    - classXAmortFromInterest → PPM step (G) (Class X amort paid from interest pool, pari-passu with Class A interest)
 *    - deferredAccrualByTranche → PPM steps (K)/(N)/(Q)/(T) PIK additions this period
 */
export interface PeriodStepTrace {
  /** PPM step (A)(i) Issuer taxes. Engine emits zero pre-fix; post-fix
   *  populated via `taxesBps` input. Euro XV Q1 2026 observed: €6,133/quarter. */
  taxes: number;
  /** PPM step (A)(ii) Issuer Profit Amount. Fixed absolute deduction
   *  per period (€250 regular, €500 post-Frequency-Switch on Euro XV). Engine
   *  emits zero pre-fix; post-fix populated via `issuerProfitAmount` input. */
  issuerProfit: number;
  /** PPM step (B) — trustee fee, capped portion actually paid. Split from
   *  `adminFeesPaid` in Sprint 3 / C3 so the N1 harness can distinguish
   *  trustee vs admin drift. Pre-C3 this field bundled steps (B)+(C)+(Y)+(Z). */
  trusteeFeesPaid: number;
  /** PPM step (C) — admin expenses, capped portion actually paid. */
  adminFeesPaid: number;
  seniorMgmtFeePaid: number;
  hedgePaymentPaid: number;
  /** Interest residual after PPM steps (A.i)→(F): `interestCollected` minus
   *  taxes, issuerProfit, trustee+admin (capped portions only), seniorMgmt,
   *  hedge. The amount entering the tranche-interest pari-passu loop (PPM
   *  step (G) onward).
   *
   *  NULL under acceleration mode: the Post-Acceleration Priority of
   *  Payments steps (B)+(C) proviso ("provided that following an acceleration
   *  of the Notes pursuant to Condition 10(b) (Acceleration) [...] the
   *  Senior Expenses Cap shall not apply") removes the cap, and
   *  interest+principal pool together for sequential P+I distribution by
   *  seniority; "available for tranches" doesn't have a coherent meaning. UI
   *  must hide the row when null AND render an explanatory header.
   *
   *  See CLAUDE.md § Engine ↔ UI separation: the UI MUST consume this field
   *  directly rather than recomputing `interestCollected − fees`. The
   *  original PeriodTrace incident did exactly that and silently dropped
   *  clauses A.i, A.ii, C. */
  availableForTranches: number | null;
  subMgmtFeePaid: number;
  incentiveFeeFromInterest: number;
  incentiveFeeFromPrincipal: number;
  ocCureDiversions: Array<{ rank: number; mode: "reinvest" | "paydown"; amount: number }>;
  reinvOcDiversion: number;
  /** PPM step (Y) — trustee-fee overflow paid from residual interest after
   *  tranche interest + sub mgmt fee. Zero when trustee + admin fees were
   *  fully accommodated under the Senior Expenses Cap, and zero under
   *  acceleration (cap removed by Post-Acceleration Priority of Payments
   *  steps (B)+(C) proviso citing Condition 10(b) Acceleration; the
   *  post-accel executor pays trustee/admin uncapped from the pooled
   *  stream and there is no overflow lane). */
  trusteeOverflowPaid: number;
  /** PPM step (Z) — admin-expense overflow. Same mechanics as trustee. */
  adminOverflowPaid: number;
  /** Senior Expenses Cap effective amount used at this period's cap test
   *  — equals `bps × cap base + floor + carryforward augmentation +
   *  expense-reserve augmentation`. This is the value passed to
   *  `Math.min(cappedRequested, capAmount)` at the cap site, so it
   *  reflects everything that expanded headroom (reserve included).
   *  Carryforward bookkeeping itself is computed against the STATED cap
   *  (bps + floor only) so reserve / carryforward augmentations don't
   *  re-enter next period's headroom — see the `statedCap` local at the
   *  carryforward-push site. Exposed for marker tests verifying CPA-vs-
   *  APB cap base dispatch and carryforward accumulation. */
  seniorExpensesCapAmount: number;
  /** Σ unused-headroom carried forward from preceding PDs (PPM Condition 1
   *  proviso (ii)). Zero at period 1 (or when carryforward is disabled).
   *  This is the carryforward sum component of `seniorExpensesCapAmount`;
   *  it is NOT `seniorExpensesCapAmount − (bps + floor cap)` because the
   *  emitted cap also includes any expense-reserve augmentation. */
  seniorExpensesCapCarryforwardSum: number;
  equityFromInterest: number;
  equityFromPrincipal: number;
  /** PPM step (G) — Class X (or other amortising-tranche) scheduled
   *  amortization paid from the interest pool, pari-passu with Class A
   *  interest. The engine consumes this amount from `availableInterest`
   *  at the step G site; partner-visible aggregators must include it
   *  when reconciling interest-side flows against `interestCollected`,
   *  or `Σ stepTrace.*(interest waterfall) ≤ interestCollected` is
   *  unsound. Zero on deals with no `isAmortising: true` tranche. */
  classXAmortFromInterest: number;
  deferredAccrualByTranche: Record<string, number>;
  /** C1 — Reinvestment amount blocked this period because the purchase would
   *  have caused the Moody's WARF trigger to breach. Zero when no enforcement
   *  is active (no trigger set) or the purchase fit within the trigger.
   *  Blocked principal flows to senior paydown instead of reinvestment. */
  reinvestmentBlockedCompliance: number;
  /** Per-period draw from the Expense Reserve Account used to pay PPM steps
   *  (B) and (C) above the standard Senior Expenses Cap (Condition 3(j)(x)(4)).
   *  Zero when the standard cap was sufficient OR when the reserve is empty.
   *  Always zero under acceleration: Post-Acceleration Priority of
   *  Payments steps (B)+(C) proviso citing Condition 10(b) removes the
   *  cap, so there is no over-cap to draw on. */
  expenseReserveDraw: number;
}

/** C2 — Forward-projected portfolio quality + concentration metrics.
 *  Computed from `loanStates` at period END (post-defaults, post-prepayments,
 *  post-reinvestment) so the metrics reflect what the portfolio actually looks
 *  like exiting the period. `periods[N].qualityMetrics` = state entering
 *  period N+1, matching trustee determination-date methodology. These mirror
 *  the T=0 metrics on `resolved.poolSummary` (warf / walYears / wacSpreadBps
 *  / pctCccAndBelow) so partner comparisons are apples-to-apples.
 *
 *  C1 reinvestment enforcement covers all four reinvestment-period triggers
 *  (Moody's WARF, Min Weighted Average Floating Spread, Moody's Caa
 *  concentration, Fitch CCC concentration) per PPM Section 8 + Condition 1
 *  definitions (PDF pp. 287, 302-305, 127, 138). NR positions proxy as Caa2
 *  (WARF=6500) per Moody's CLO methodology — see KI-19. */
/** Per-period alias of the shared `PoolQualityMetrics` shape. Engine emits
 *  this at each period end; switch simulator uses the same shape for
 *  pre/post-trade comparison. See `pool-metrics.ts` for the compute helper +
 *  methodology documentation. */
export type PeriodQualityMetrics = PoolQualityMetrics;

export interface PeriodResult {
  periodNum: number;
  date: string;
  beginningPar: number;
  defaults: number;
  prepayments: number;
  scheduledMaturities: number;
  recoveries: number;
  /** Aggregate principal proceeds for the period: prepayments + scheduledMaturities
   *  + recoveries. Emitted from the engine so the UI never sums these three fields
   *  itself. See CLAUDE.md § Engine ↔ UI separation. */
  principalProceeds: number;
  reinvestment: number;
  endingPar: number;
  /** Per-period balance instrumentation (post-v6 plan §4.3). Conservation
   *  invariant: `endingPerformingPar[N] === beginningPerformingPar[N+1]`. */
  endingPerformingPar: number;
  beginningPerformingPar: number;
  /** Sum of `defaultedParPending` across all loans at period end (loan-level mode);
   *  zero in aggregate mode. Conservation: `endingDefaultedPar[N+1] - endingDefaultedPar[N]`
   *  matches new defaults this period − recovered defaults this period. */
  endingDefaultedPar: number;
  beginningDefaultedPar: number;
  /** Σ undrawnCommitment across all loanStates at period end. Subtracted from
   *  the OC numerator per PPM Adjusted Collateral Principal Amount (the
   *  un-drawn portion of a DDTL/revolver doesn't count as deployable
   *  collateral). Conserved across partial draws — when a DDTL draws
   *  ddtlDrawPercent of its commitment, the (1 − ddtlDrawPercent) residual
   *  remains on this field rather than being silently discarded. Zero on
   *  deals with no DDTL/revolver positions and on deals where every DDTL is
   *  fully drawn (Eleda-shape: `parBalance > 0`, `undrawnCommitment === 0`). */
  endingUndrawnCommitment: number;
  /** Principal POP account balance at start/end of period. The engine fully
   *  distributes collections each period, so these are typically 0 — non-zero
   *  only in the q=1 case where `initialPrincipalCash` is non-zero (the
   *  determination-date overdraft / surplus carried into the period). Emitted
   *  for trustee tie-out comparison. */
  beginningPrincipalAccount: number;
  endingPrincipalAccount: number;
  /** Interest POP account balance at start/end. Same fully-distribute model;
   *  always 0 in the current engine. Emitted for tie-out symmetry. */
  beginningInterestAccount: number;
  endingInterestAccount: number;
  interestCollected: number;
  beginningLiabilities: number;
  endingLiabilities: number;
  trancheInterest: { className: string; due: number; paid: number }[];
  /** Per-tranche **cumulative** running interest-shortfall balance at end-
   *  of-period. Tracks unpaid base interest on non-deferrable, non-amortising
   *  senior tranches (rank-protected per PPM § 10(a)(i)) ACCUMULATED across
   *  all pre-acceleration periods up to and including this one. The `due`
   *  field above is the period's pure base coupon — it does NOT include
   *  carried shortfall (non-deferrable means non-deferrable; soft-deferrable
   *  carry-forward into next period's pre-accel demand would silently
   *  diverge from trustee data on stress). The cumulative carry is consumed
   *  by:
   *    (a) the EoD-on-shortfall detector — fires when consecutive shortfall
   *        periods exceed `interestNonPaymentGracePeriods`, and
   *    (b) the post-acceleration handoff — folds the carry into
   *        `interestDueByTranche` so the accelerated claim is whole, then
   *        resets the cumulative to 0.
   *  Deferrable tranches use `deferredBalances` (PIK) instead and stay at
   *  zero here. Empty / all-zero in healthy scenarios. **Always cumulative
   *  pre-accel; always empty under post-accel** (the carry has been folded
   *  and reset by the handoff). Under acceleration the per-period unpaid
   *  amount lives on `perPeriodInterestShortfall` — distinct semantic, do
   *  not confuse the two when summing across periods.
   *
   *  **Non-display field by current intent.** Per CLAUDE.md principle 4,
   *  every engine output is potentially partner-facing; this field is
   *  emitted for engine observability (EoD trigger introspection in tests,
   *  N1-harness diagnostics, post-accel claim audit) but is NOT surfaced
   *  in any UI row today. The sibling `stepTrace.deferredAccrualByTranche`
   *  has the same shape (engine-internal observability for the deferrable-
   *  PIK flow) and the same non-display status. If a partner-facing
   *  surface needs to display "senior interest shortfall: €X,XXX", the
   *  rule is: read FROM this field — never re-derive from `due − paid`
   *  in the UI (that breaks the "display equals engine output" invariant
   *  exactly as the April 2026 incident did for `equityFromInterest`). */
  interestShortfall: Record<string, number>;
  /** Per-tranche **per-period** unpaid-interest amount from the accelerated
   *  waterfall — distinct semantic from `interestShortfall` (cumulative
   *  pre-accel carry). Empty / absent in pre-accel periods; populated only
   *  under acceleration with the single-period shortfall the post-accel
   *  executor could not pay. Summing this across post-accel periods gives
   *  total unpaid since acceleration; summing it with `interestShortfall`
   *  is meaningless (different units of time aggregation). */
  perPeriodInterestShortfall: Record<string, number>;
  /** Per-tranche consecutive-shortfall counter feeding the PPM § 10(a)(i)
   *  EoD trigger. Increments each pre-acceleration period the rank-protected
   *  tranche accrues new shortfall (`interestShortfall[c] − bopShortfall[c] >
   *  0.01`); resets to 0 on a fully-paid period. EoD fires when count exceeds
   *  `interestNonPaymentGracePeriods`. Frozen under post-acceleration (counter
   *  is no longer mutated once `isAccelerated` is set). Emitted so a partner-
   *  facing surface can show "Class A — 2 of 3 grace periods consumed" or
   *  similar countdown without re-deriving from interestShortfall deltas. */
  interestShortfallCount: Record<string, number>;
  /** Per-tranche principal-side state. `paid` is the TOTAL paid to the
   *  tranche this period (sum of amort-from-interest at step G + principal-
   *  pool paydowns post-step-G). `paidFromInterest` is the portion sourced
   *  from the interest pool at step G — non-zero only for amortising
   *  tranches in periods where amort fires. Partner-visible UIs that
   *  organize the trace by source pool (interest vs principal sections)
   *  must subtract `paidFromInterest` from `paid` to avoid double-rendering
   *  the same dollars in both sections. Aggregate sum across tranches:
   *  `Σ paidFromInterest === stepTrace.classXAmortFromInterest`. */
  tranchePrincipal: { className: string; paid: number; paidFromInterest: number; endBalance: number }[];
  ocTests: { className: string; actual: number; trigger: number; passing: boolean }[];
  icTests: { className: string; actual: number; trigger: number; passing: boolean }[];
  /** B1 — EoD test per period (null if deal has no separately-tracked EoD). */
  eodTest: EventOfDefaultTestResult | null;
  /** B2 — whether this period ran under the post-acceleration waterfall.
   *  Flipped by an EoD breach in a prior period (or at T=0); irreversible. */
  isAccelerated: boolean;
  /** B1 Tier 2 — per-loan default events that fired in this period. Each
   *  entry is `(loanIndex, defaultedPar, scheduledRecoveryQuarter,
   *  recoveryAmount)`. The aggregate `defaults` field is the sum of these
   *  entries' `defaultedPar`; `period.recoveries` over the projection
   *  matches Σ(events scheduled at q) × event.recoveryAmount. Per-event
   *  `recoveryAmount` carries the per-loan agency recovery rate when
   *  available, else the global `recoveryPct` fallback.
   *  The test suite asserts both identities directly so the dual-
   *  accounting paths (per-loan `defaultEvents` vs aggregate
   *  `recoveryPipeline`) cannot silently diverge. Empty array on
   *  zero-default periods AND on the no-loan-data fallback path
   *  (aggregate-only `recoveries` emission; cross-path identity is
   *  structurally inapplicable there). */
  loanDefaultEvents: Array<{
    loanIndex: number;
    defaultedPar: number;
    scheduledRecoveryQuarter: number;
    recoveryAmount: number;
  }>;
  equityDistribution: number;
  defaultsByRating: Record<string, number>;
  /** Per-step trace for N1 waterfall-replay harness. */
  stepTrace: PeriodStepTrace;
  /** C2 — End-of-period portfolio quality/concentration metrics. Matches the
   *  shape of `resolved.poolSummary.{warf,walYears,wacSpreadBps,pctCccAndBelow}`
   *  so T=0 vs forward comparisons are apples-to-apples. */
  qualityMetrics: PeriodQualityMetrics;
}

/** Beginning-of-period-1 snapshot — "as of the determination date" state
 *  BEFORE any forward-projection mutations (defaults, prepayments, paydowns,
 *  reinvestment). This is what trustee reports measure; the N6 harness ties
 *  these out against `raw.complianceData.complianceTests` at T=0.
 *  Expose as a separate field rather than periods[0] because periods[0] is
 *  post-Q1 end-state. */
export interface ProjectionInitialState {
  /** Pool par at period start (funded loans, excludes unfunded DDTL). */
  poolPar: number;
  /** OC numerator at period start (APB + principal cash − haircuts + adjustments). */
  ocNumerator: number;
  /** Per-class OC test actuals at T=0, matching trustee determination-date values. */
  ocTests: { className: string; actual: number; trigger: number; passing: boolean }[];
  /** Per-class IC test actuals at T=0. */
  icTests: { className: string; actual: number; trigger: number; passing: boolean }[];
  /** B1 — Event of Default Par Value Test at T=0. Null if deal has no
   *  separately-tracked EoD test (legacy fixture / test scenario). */
  eodTest: EventOfDefaultTestResult | null;
  /** Total non-DDTL non-defaulted loan par + signed principalAccountCash −
   *  non-equity tranche balance, floored at 0. THE canonical "what equity
   *  is worth right now" value — same number used internally as the equity
   *  cost basis for forward IRR (line ~1014: `equityCashFlows.push(-equityInvestment)`)
   *  and externally as the partner-facing book-value card and the inception-IRR
   *  terminal. Single source of truth; UI must read this field, not recompute it.
   *
   *  See CLAUDE.md § Engine ↔ UI separation. */
  equityBookValue: number;
  /** True iff totalAssets ≤ totalDebtOutstanding at t=0 — i.e., the line-995
   *  floor fired and equityCashFlows[0] = -0. The deal is balance-sheet
   *  insolvent; calculateIrr() returns null on the all-non-negative series.
   *  UI must label this state ("Deal is balance-sheet insolvent; IRR not
   *  meaningful") rather than show "N/A". */
  equityWipedOut: boolean;
  /** T=0 opening balances of each named PPM account. Emitted on
   *  initialState (T=0 invariants) per Principle 4 — UI reads from here
   *  rather than re-deriving from inputs. `principalAccountCash` is
   *  signed (overdrafts negative). The four reserves are positive-only
   *  by convention. All five contribute to `equityBookValue` as a
   *  balance-sheet identity; only `principalAccountCash` is credited
   *  to the OC numerator (PPM Condition 1(d)). */
  openingAccountBalances: {
    principalAccountCash: number;
    unusedProceedsCash: number;
    interestAccountCash: number;
    interestSmoothingBalance: number;
    supplementalReserveBalance: number;
    expenseReserveBalance: number;
  };
  /** T=0 Senior Expenses Cap effective amount used for the IC compositional
   *  parity test — bps × cap base + floor (per the /4 flat quarterly
   *  approximation). Reflects CPA-vs-APB dispatch (`seniorExpensesCapBaseMode`)
   *  and VAT gross-up if applicable. Exposed for marker tests verifying
   *  T=0 dispatch parity with the in-period site. */
  seniorExpensesCapAmountT0: number;
  /** T=0 cap-test capped requested amount (trustee + admin grossed up by
   *  VAT when applicable). Exposed for marker tests verifying the VAT
   *  gross-up path at T=0 mirrors the in-period site. */
  seniorExpensesCapRequestedT0: number;
  /** Reinvestment purchase price (percent of par) the engine actually
   *  applied. Exposed for partner-facing transparency — synthesised
   *  reinvestment loans are valued at this price, and the source tag
   *  identifies the derivation lineage:
   *    - `user_override`: UserAssumptions.reinvestmentPricePct was set
   *    - `pool_was_derived`: Σ par × currentPrice / Σ par over priced
   *      funded loans
   *    - `par_fallback`: greenfield path (resolved.loans.length === 0).
   *      The with-loans-but-no-prices case is gated upstream in
   *      `composeBuildWarnings` (blocking) so this tag fires only when
   *      par is correct — greenfield deals don't reinvest until they ramp. */
  reinvestmentPricePctApplied: number;
  reinvestmentPriceSource: "user_override" | "pool_was_derived" | "par_fallback";
}

export interface ProjectionResult {
  periods: PeriodResult[];
  equityIrr: number | null;
  totalEquityDistributions: number;
  tranchePayoffQuarter: Record<string, number | null>;
  /** T=0 snapshot for N6 compliance parity harness. */
  initialState: ProjectionInitialState;
}

export function validateInputs(inputs: ProjectionInputs): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (!inputs.tranches || inputs.tranches.length === 0) {
    errors.push({ field: "tranches", message: "Capital structure is required" });
  }
  if (!inputs.initialPar || inputs.initialPar <= 0) {
    errors.push({ field: "initialPar", message: "Current portfolio par amount is required" });
  }
  if (!inputs.maturityDate) {
    errors.push({ field: "maturityDate", message: "Deal maturity date is required for projection timeline" });
  }
  const missingSpread = inputs.tranches?.some(
    (t) => !t.isIncomeNote && (t.spreadBps === null || t.spreadBps === undefined)
  );
  if (missingSpread) {
    errors.push({ field: "trancheSpreads", message: "Tranche spread/coupon data needed for interest calculations" });
  }
  return errors;
}

export function quartersBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  return Math.ceil(months / 3);
}

/**
 * Reinvestment OC Test diversion amount per PPM:
 *   `raw.constraints.reinvestmentOcTest.diversionAmount` specifies "Interest
 *   diversion (LESSER OF 50% of residual Interest Proceeds or cure amount)
 *   during Reinvestment Period".
 *
 * During RP, diversion buys collateral → raises numerator. Cure amount solves:
 *   (numerator + x) / debt ≥ trigger → x = trigger × debt − numerator.
 *
 * Returns 0 when (a) no interest to divert, (b) no rated debt, (c) test passes.
 *
 * Price-aware OC cure cash sizing: returns both `cashDiverted` (subtracted
 * from availableInterest) and `parBought` (pushed as new survivingPar).
 * Math depends on whether the synthesised loan is sub-threshold:
 *
 *   - Above-threshold (purchasePricePct >= classificationThresholdPct):
 *     not a discount obligation → contributes full par to OC numerator.
 *     Cash needed for `numeratorGain` of cure: `cash = numeratorGain ×
 *     purchasePricePct/100` (LEVERAGED — €1 cash buys €1/price par which
 *     contributes €1/price numerator).
 *
 *   - Sub-threshold: synthesised position is a discount obligation →
 *     contributes `par × purchasePricePct/100` to numerator after the
 *     per-position haircut. Cash needed: `cash = numeratorGain` (no
 *     leverage; same dollar of OC ratio per dollar of cash). Buying
 *     sub-threshold paper does change pool composition (more par for the
 *     same cash) but does not improve OC ratio more than holding cash.
 *
 * parBought = cashDiverted × (100 / purchasePricePct) in both cases.
 * Caller uses parBought to size the new loan, cashDiverted to consume
 * available interest. Caller is also responsible for setting
 * `isDiscountObligation` on the synthesised loan per the same threshold
 * test (so the haircut Σ on the next period reflects classification).
 */
export function computeReinvOcDiversion(
  availableInterest: number,
  ocNumerator: number,
  reinvOcDebt: number,
  triggerLevelPct: number,
  diversionPct: number,
  purchasePricePct: number = 100,
  isSubThresholdPurchase: boolean = false,
): { cashDiverted: number; parBought: number } {
  if (availableInterest <= 0) return { cashDiverted: 0, parBought: 0 };
  if (reinvOcDebt <= 0) return { cashDiverted: 0, parBought: 0 };
  const actualPct = (ocNumerator / reinvOcDebt) * 100;
  if (actualPct >= triggerLevelPct) return { cashDiverted: 0, parBought: 0 };
  const numeratorGainNeeded = Math.max(0, (triggerLevelPct / 100) * reinvOcDebt - ocNumerator);
  const cashNeededForCure = isSubThresholdPurchase
    ? numeratorGainNeeded
    : numeratorGainNeeded * (purchasePricePct / 100);
  const maxDiversion = availableInterest * (diversionPct / 100);
  const cashDiverted = Math.min(maxDiversion, cashNeededForCure);
  const parBought = purchasePricePct > 0 ? cashDiverted * (100 / purchasePricePct) : cashDiverted;
  return { cashDiverted, parBought };
}

/**
 * B1 — Event of Default Par Value Test (PPM OC Condition 10(a)(iv)).
 *
 * Compositional numerator, distinct from the class-level OC_PAR test family:
 *   component (1) — Aggregate Principal Balance of NON-defaulted Collateral Obligations (at par)
 *   component (2) — For each Defaulted Obligation: Market Value × Principal Balance
 *   component (3) — Principal Proceeds standing on the Principal Account (Measurement Date)
 *
 * Denominator is Class A Principal Amount Outstanding ONLY (NOT all tranches).
 *
 * Previously implemented as a rank-99 OC trigger running against the class-level
 * loop, which made the denominator include all tranches (sub notes + everything)
 * — driving the ratio ~5-10× higher than spec and making the test essentially
 * impossible to breach. B1 fixes this structurally.
 *
 * Defaulted loan pricing: uses `currentPrice` (cents of par) when available.
 * Reinvested / newly-originated loans that default before acquiring a market
 * price fall back to `defaultedPriceFallbackPct` (default 100 = par) — this is
 * conservative because using par for a defaulted position overstates the
 * numerator. Prefer to always have a market price on defaulted positions.
 */
export interface EventOfDefaultTestResult {
  numeratorComponents: {
    nonDefaultedApb: number;
    defaultedMvPb: number;
    principalCash: number;
  };
  numeratorTotal: number;
  denominator: number;
  actualPct: number;
  triggerLevel: number;
  passing: boolean;
}

export function computeEventOfDefaultTest(
  loanStates: Array<{
    survivingPar: number;
    isDefaulted?: boolean;
    currentPrice?: number | null;
  }>,
  principalCash: number,
  classAPrincipalOutstanding: number,
  triggerLevel: number,
  defaultedPriceFallbackPct = 100,
): EventOfDefaultTestResult {
  let nonDefaultedApb = 0;
  let defaultedMvPb = 0;
  for (const l of loanStates) {
    // survivingPar > 0 is the funded-base predicate; un-drawn DDTL/revolver
    // commitments contribute zero (their notional sits on undrawnCommitment).
    if (l.survivingPar <= 0) continue;
    if (l.isDefaulted) {
      const price = l.currentPrice != null ? l.currentPrice : defaultedPriceFallbackPct;
      defaultedMvPb += l.survivingPar * (price / 100);
    } else {
      nonDefaultedApb += l.survivingPar;
    }
  }
  const numeratorTotal = nonDefaultedApb + defaultedMvPb + principalCash;
  const actualPct = classAPrincipalOutstanding > 0
    ? (numeratorTotal / classAPrincipalOutstanding) * 100
    : 999;
  return {
    numeratorComponents: { nonDefaultedApb, defaultedMvPb, principalCash },
    numeratorTotal,
    denominator: classAPrincipalOutstanding,
    actualPct,
    triggerLevel,
    passing: actualPct >= triggerLevel,
  };
}

/**
 * Senior-tranche Principal Amount Outstanding — the EoD test denominator.
 *
 * The senior tranche is the rated debt tranche(s) at the lowest seniorityRank
 * (rank 1 by convention). Identification is rank-based, NOT name-based: real
 * CLOs name this tranche variously ("Class A", "Class A-1", "A-1A", "A"), and
 * a pari-passu split (A-1 + A-2 sharing rank 1) sums BOTH balances. Income
 * notes (sub notes) are excluded even when mis-ranked at rank 1 in malformed
 * inputs.
 *
 * Principal-only — PPM Condition 10(a)(iv) defines the denominator as the
 * Principal Amount Outstanding of the senior tranche, NOT principal plus
 * deferred interest. The D1 guard at the head of `runProjection` throws on
 * any tranche whose name starts with "A" or "B" carrying isDeferrable=true,
 * which covers the standard naming convention but is itself name-based
 * (would miss a senior tranche named e.g. "K-1" or "X-1" marked deferrable);
 * if such an input ever reaches this helper, including deferred interest
 * here would inflate the denominator and silently SUPPRESS EoD breaches,
 * which is why the helper takes principal only and not the deferred map.
 *
 * Returns 0 only when there are no debt tranches at all (degenerate input).
 *
 * Single source of truth for the T=0 initialState EoD test and the forward-
 * period EoD test. Keeping both sites bound to this helper prevents the
 * recurrence of the "string match Class A" overfit pattern that the forward
 * site silently re-introduced post-T=0 closure.
 */
export function computeSeniorTranchePao(
  tranches: Array<{ className: string; seniorityRank: number; isIncomeNote: boolean }>,
  trancheBalances: Record<string, number>,
): number {
  const debtTranches = tranches.filter((t) => !t.isIncomeNote);
  if (debtTranches.length === 0) return 0;
  const minRank = Math.min(...debtTranches.map((t) => t.seniorityRank));
  return debtTranches
    .filter((t) => t.seniorityRank === minRank)
    .reduce((s, t) => {
      // Throw on missing-key — a tranche present in `tranches` but absent
      // from the balance map is a data-shape bug. Silent `?? 0` would
      // collapse the EoD denominator and resurrect the exact "always
      // passing" failure shape this helper exists to prevent. Per CLAUDE.md
      // principle 5 (boundaries assert sign and scale).
      const cur = trancheBalances[t.className];
      if (cur === undefined) {
        throw new Error(
          `computeSeniorTranchePao: tranche "${t.className}" missing from trancheBalances ` +
            `(cur=${cur}). Caller must construct the map from the same tranches array.`,
        );
      }
      return s + cur;
    }, 0);
}

/**
 * B2 — Post-acceleration waterfall executor (Stage 1 implementation).
 *
 * Distributes a single pool of cash (interest + principal combined, per
 * PPM Condition 10(a)) through `POST_ACCEL_SEQUENCE`:
 *   1. Senior expenses (taxes, trustee, admin, senior mgmt, hedge) — uncapped
 *   2. Rated tranches in seniority order: Class A P+I fully sequential →
 *      Class B pari passu pro-rata (B-1 + B-2) → Class C/D/E/F each sequential
 *   3. Sub-ordinated fees (sub mgmt, defaulted hedge, incentive if hurdle met)
 *   4. Residual to Sub Noteholders
 *
 * For each tranche, interest due is paid before principal; principal then
 * absorbs remaining capacity until the tranche is retired, at which point
 * excess cash flows to the next tranche. Under acceleration, deferred
 * interest no longer PIKs — unpaid interest is a shortfall against the
 * residual (Sub Notes bucket).
 *
 * Inputs are already-computed period-level quantities; the executor doesn't
 * recompute interest accruals or day-count. Caller supplies:
 *   - totalCash: pooled interest + principal available for distribution
 *   - tranches: input tranche definitions (for sequencing + pari passu groups)
 *   - trancheBalances, deferredBalances: current-period balances (mutable;
 *     executor writes post-paydown balances back)
 *   - senior expense amounts pre-computed to match normal-mode fee semantics
 *     (day-count, rate) so partner-visible fee numbers are consistent
 *   - tranche interest due amounts per tranche
 *   - Class B pari passu group is detected via `isB1B2Group` heuristic.
 */
export interface PostAccelExecutorInput {
  totalCash: number;
  tranches: ProjectionInputs["tranches"];
  trancheBalances: Record<string, number>;
  deferredBalances: Record<string, number>;
  /** Senior expenses in PPM order, expressed as the canonical
   *  `SeniorExpenseBreakdown`. Under post-acceleration the cap doesn't
   *  apply (PPM 10(b)), so callers pass the full requested amount in
   *  `trusteeCapped` / `adminCapped` with zero `trusteeOverflow` /
   *  `adminOverflow`. Issuer profit is a fixed absolute amount per PPM
   *  Condition 1; still paid under acceleration (priority order preserved
   *  by PPM 10(b)). */
  seniorExpenses: SeniorExpenseBreakdown;
  /** Interest due per tranche this period (from trancheCouponRate × balance
   *  × dayFrac). Residual interest not paid is a shortfall (not PIKed). */
  interestDueByTranche: Record<string, number>;
  /** Sub-ordinated fees — paid only if rated notes are fully retired and
   *  cash remains. */
  subMgmtFee: number;
  /** Sub Note cash-flow series prior to this accel period's residual.
   *  Index 0 is the equity investment (negative); subsequent entries are
   *  per-period distributions (positive). Threaded across the normal→accel
   *  mode transition — the live accumulator already contains pre-breach
   *  distributions plus any earlier accel-mode residuals. Used by
   *  `resolveIncentiveFee` to test whether cumulative IRR clears
   *  `incentiveFeeHurdleIrr`. Same convention as the normal-mode
   *  `equityCashFlows` accumulator. Empty array disables the fee. */
  priorEquityCashFlows: number[];
  /** Annualized IRR hurdle for PPM Acceleration POP step (V) (decimal —
   *  e.g. 0.12 for 12%). Same hurdle as normal-mode steps (CC) / (U) per
   *  PPM Condition 11. Zero or negative disables the fee. */
  incentiveFeeHurdleIrr: number;
  /** Periods per year for IRR annualization. Quarterly cadence = 4. KI-04
   *  will replace literal-4 sites with deal-cadence-derived values when
   *  Frequency Switch lands. */
  periodsPerYear: number;
  incentiveFeePct: number;
}

export interface PostAccelExecutorResult {
  /** Per-tranche distribution: how much interest vs principal was paid. */
  trancheDistributions: Array<{
    className: string;
    interestDue: number;
    interestPaid: number;
    principalPaid: number;
    endBalance: number;
  }>;
  seniorExpensesPaid: SeniorExpenseBreakdown;
  subMgmtFeePaid: number;
  incentiveFeePaid: number;
  residualToSub: number;
  /** Per-period unpaid-interest shortfall on any tranche under acceleration —
   *  difference between `interestDueByTranche` (which already includes the
   *  pre-accel carry folded by the projection at the handoff) and what the
   *  accelerated waterfall actually paid. Not PIKed (acceleration discharges
   *  PIK semantics). Distinct semantic from `PeriodResult.interestShortfall`,
   *  which is a cumulative pre-accel running balance — this field is single-
   *  period. */
  perPeriodInterestShortfall: Record<string, number>;
}

export function runPostAccelerationWaterfall(input: PostAccelExecutorInput): PostAccelExecutorResult {
  let remaining = input.totalCash;

  // ── 1. Senior expenses (PPM steps A.i, A.ii, B, C, E, F). Uncapped under
  //      acceleration per PPM 10(b); the canonical helper truncates each
  //      step against `remaining` (Math.min(amount, remaining)), matching
  //      the prior `pay(...)` chain bit-for-bit under non-negative inputs
  //      and non-negative `totalCash` (both guaranteed at this site —
  //      `remaining` is monotonic in [0, totalCash]). Y/Z overflow does
  //      not exist under acceleration; the helper returns zeros in those
  //      fields and the post-accel stepTrace pins them to zero. ──
  const seniorExpensesApplied = applySeniorExpensesToAvailable(
    input.seniorExpenses,
    remaining,
  );
  remaining = seniorExpensesApplied.remainingAvailable;
  const seniorPaid = seniorExpensesApplied.paid;

  // `pay` continues to be used for sub mgmt fee + incentive fee below.
  const pay = (amount: number): number => {
    const paid = Math.min(amount, Math.max(0, remaining));
    remaining -= paid;
    return paid;
  };

  // ── 2. Rated tranches: P+I combined, sequential except Class B pari passu. ──
  const trancheDistributions: PostAccelExecutorResult["trancheDistributions"] = [];
  const perPeriodInterestShortfall: Record<string, number> = {};

  // Sort rated tranches (exclude sub notes + amortising Class X) by seniority.
  const ratedTranches = input.tranches
    .filter((t) => !t.isIncomeNote && !t.isAmortising)
    .sort((a, b) => a.seniorityRank - b.seniorityRank);

  // Group by seniorityRank so pari passu classes (e.g., B-1 + B-2) absorb together.
  const processedRanks = new Set<number>();
  for (const t of ratedTranches) {
    if (processedRanks.has(t.seniorityRank)) continue;
    processedRanks.add(t.seniorityRank);
    const group = ratedTranches.filter((g) => g.seniorityRank === t.seniorityRank);

    // Sum interest due + principal outstanding for the group.
    const totalInterestDue = group.reduce(
      (s, g) => s + (input.interestDueByTranche[g.className] ?? 0),
      0,
    );
    const totalPrincipal = group.reduce(
      (s, g) => s + input.trancheBalances[g.className] + input.deferredBalances[g.className],
      0,
    );

    // Pay group's interest (pro rata across members by interest due).
    const interestPaid = Math.min(totalInterestDue, Math.max(0, remaining));
    remaining -= interestPaid;

    // Pay group's principal (pro rata by outstanding balance).
    const principalPaid = Math.min(totalPrincipal, Math.max(0, remaining));
    remaining -= principalPaid;

    for (const g of group) {
      const gInterestDue = input.interestDueByTranche[g.className] ?? 0;
      const gPrincipal = input.trancheBalances[g.className] + input.deferredBalances[g.className];

      // Pro-rate this group's interest and principal by the member's share.
      const gInterestShare = totalInterestDue > 0 ? gInterestDue / totalInterestDue : 0;
      const gPrincipalShare = totalPrincipal > 0 ? gPrincipal / totalPrincipal : 0;
      const gInterestPaid = interestPaid * gInterestShare;
      const gPrincipalPaid = principalPaid * gPrincipalShare;

      // Shortfall: unpaid interest is NOT PIKed under acceleration.
      const shortfall = gInterestDue - gInterestPaid;
      if (shortfall > 0.01) perPeriodInterestShortfall[g.className] = shortfall;

      // Post-paydown balance.
      const endBalance = Math.max(0, gPrincipal - gPrincipalPaid);
      trancheDistributions.push({
        className: g.className,
        interestDue: gInterestDue,
        interestPaid: gInterestPaid,
        principalPaid: gPrincipalPaid,
        endBalance,
      });
    }

    if (remaining <= 0) break;
  }

  // ── 3. Sub-ordinated steps (Q, V). Only if rated notes exhausted. Step
  //      (T) Defaulted Hedge Termination is unmodeled — see KI-06. ──
  const subMgmtFeePaid = pay(input.subMgmtFee);
  // PPM Acceleration POP step (V) — Incentive Collateral Management Fee.
  // Same IRR-threshold mechanic as normal-mode steps (CC) / (U): three
  // regimes inside `resolveIncentiveFee` — pre-fee IRR < hurdle → 0; full
  // pct fee post-fee IRR ≥ hurdle → full fee; otherwise bisect to keep
  // post-fee IRR at the hurdle. The cumulative Sub Note cashflow series
  // (`priorEquityCashFlows`) carries pre-breach + earlier accel-mode
  // distributions; this period's pre-fee residual is the next inflow the
  // solver tests against.
  let incentiveFeePaid = 0;
  if (
    input.incentiveFeePct > 0 &&
    input.incentiveFeeHurdleIrr > 0 &&
    remaining > 0
  ) {
    const fee = resolveIncentiveFee(
      input.priorEquityCashFlows,
      Math.max(0, remaining),
      input.incentiveFeePct,
      input.incentiveFeeHurdleIrr,
      input.periodsPerYear, // KI-04 routes through `input.periodsPerYear`; the literal-4 lives at the engine call site at projection.ts:~3757.
    );
    incentiveFeePaid = pay(fee);
  }

  // ── 4. Residual to Sub Noteholders. ──
  const residualToSub = Math.max(0, remaining);

  return {
    trancheDistributions,
    seniorExpensesPaid: seniorPaid,
    subMgmtFeePaid,
    incentiveFeePaid,
    residualToSub,
    perPeriodInterestShortfall,
  };
}

/**
 * Call-liquidation proceeds per PPM. Three modes (post-v6 plan §4.1):
 *   - 'par': every position sells at face value. `callPricePct` ignored.
 *   - 'market': every position sells at its observed `currentPrice`. Throws
 *     when `currentPrice` is null/undefined on any non-delayed-draw funded
 *     position — the engine refuses a silent par fallback because that would
 *     bias the displayed IRR upward on healthy deals (par-call IRR is generally
 *     better than market-call IRR for deals trading above par). Callers must
 *     choose 'par' or 'manual' for deals without holdings-level prices.
 *   - 'manual': every position sells at `callPricePct` (flat percentage of par,
 *     regardless of market). Useful for "assume 95c liquidation" stress runs.
 *
 * Unfunded DDTLs are excluded — no deployed collateral to liquidate.
 *
 * Throws `MarketPriceMissingError` (a plain `Error` subclass with discriminator)
 * when 'market' is selected but data is missing, so the UI can catch and
 * prompt the user to switch modes.
 */
export class MarketPriceMissingError extends Error {
  readonly kind = "market_price_missing";
  constructor(message: string) {
    super(message);
    this.name = "MarketPriceMissingError";
  }
}

/**
 * Thrown when an `optionalRedemption` callDate violates a date invariant.
 *
 * Two reasons enumerate every refusable case:
 *  - `"past"` — callDate is strictly before currentDate. "Calling in the
 *    past" is not a meaningful scenario; the engine would silently floor
 *    to one quarter and produce an absurd IRR.
 *  - `"preNcp"` — callDate is strictly before nonCallPeriodEnd. PPM
 *    Condition 7.2 prohibits a call before the Non-Call Period End; the
 *    option does not exist.
 *
 * The UI and service layers catch this and render a non-dismissible
 * inline message that names the violated invariant and the specific
 * dates, so the partner sees why the IRR cells are empty rather than a
 * silently-substituted number for a different scenario.
 */
export class InvalidCallDateError extends Error {
  readonly kind = "invalid_call_date";
  readonly reason: "past" | "preNcp";
  readonly callDate: string;
  readonly currentDate: string;
  readonly nonCallPeriodEnd: string | null;
  constructor(
    reason: "past" | "preNcp",
    callDate: string,
    currentDate: string,
    nonCallPeriodEnd: string | null,
  ) {
    const msg =
      reason === "past"
        ? `Call date ${callDate} is before currentDate ${currentDate} — calling in the past is not a meaningful scenario.`
        : `Call date ${callDate} is before non-call period end ${nonCallPeriodEnd} — PPM Condition 7.2 prohibits a pre-NCP call.`;
    super(msg);
    this.name = "InvalidCallDateError";
    this.reason = reason;
    this.callDate = callDate;
    this.currentDate = currentDate;
    this.nonCallPeriodEnd = nonCallPeriodEnd;
  }
}

export function computeCallLiquidation(
  loanStates: Array<{ survivingPar: number; currentPrice?: number | null }>,
  callPricePct: number,
  mode: "par" | "market" | "manual",
): number {
  let total = 0;
  let missingMarketPriceCount = 0;
  for (const l of loanStates) {
    // survivingPar > 0 covers both "fully matured / liquidated" and
    // "currently un-drawn DDTL/revolver" — neither has cash to liquidate.
    if (l.survivingPar <= 0) continue;
    let effectivePrice: number;
    switch (mode) {
      case "par":
        effectivePrice = 100;
        break;
      case "market":
        if (l.currentPrice == null) {
          missingMarketPriceCount++;
          continue;
        }
        effectivePrice = l.currentPrice;
        break;
      case "manual":
        effectivePrice = callPricePct;
        break;
    }
    total += l.survivingPar * (effectivePrice / 100);
  }
  if (mode === "market" && missingMarketPriceCount > 0) {
    throw new MarketPriceMissingError(
      `Market call price requires loan-level market values; ${missingMarketPriceCount} ` +
        `position(s) lack currentPrice. Set callPriceMode to 'par' or 'manual'.`,
    );
  }
  return total;
}

/**
 * Day-count fraction between two ISO dates per a named convention.
 *
 * Consumers:
 *   - `runProjection` inner period loop — per-loan and per-tranche accrual,
 *     plus all management / trustee / hedge fees.
 *   - `b3-day-count.test.ts` — first-principles correctness tests (PPM worked
 *     example, leap year, 30/360 invariance).
 *
 * Conventions supported (Ares XV PPM Condition 1 "Day count" + per-position
 * overrides extracted from `clo_holdings.day_count_convention` and
 * `clo_tranches.day_count_convention`):
 *   - 'actual_360': actual days / 360. Market default for Euro-denominated
 *     floating instruments and for management / trustee / hedge fees.
 *   - '30_360': US 30/360 (Bond Basis). Day-of-month clamps to 30 if the
 *     end date's day > 30 and the start date's day ≥ 30 (ISDA §4.16(f)).
 *   - '30e_360': European 30/360 (ISDA §4.16(g)). Both endpoints capped at
 *     30; NO anchor rule (the start-day-≥-30 condition is not required).
 *     Used by Euro-denominated fixed-rate positions (Class B-2 carries
 *     this on Euro XV; majority of the fixture's fixed-rate loans are
 *     "30/360 (European)" which is the same convention).
 *   - 'actual_365': actual days / 365 (Actual/365 Fixed). Used by a small
 *     subset of GBP / non-Euro positions on Euro XV.
 *
 * ISO date inputs must be YYYY-MM-DD. End date is exclusive (standard CLO
 * convention): Jan 15 → Apr 15 counts as 90 actual days, not 91.
 */
export function dayCountFraction(
  convention: DayCountConvention,
  startIso: string,
  endIso: string,
): number {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  if (convention === "30_360") {
    // US 30/360: ISDA §4.16(f). d1 = min(sd, 30); d2 = min(ed, 30) only
    // when d1 >= 30 (the anchor-clamp rule).
    const d1 = sd === 31 ? 30 : sd;
    const d2 = (ed === 31 && d1 >= 30) ? 30 : ed;
    const days = (ey - sy) * 360 + (em - sm) * 30 + (d2 - d1);
    return days / 360;
  }
  if (convention === "30e_360") {
    // 30E/360: ISDA §4.16(g). Both endpoints unconditionally capped at
    // 30 — no anchor rule. Diverges from US 30/360 only when the end
    // date is the 31st AND the start date's day < 30.
    const d1 = sd === 31 ? 30 : sd;
    const d2 = ed === 31 ? 30 : ed;
    const days = (ey - sy) * 360 + (em - sm) * 30 + (d2 - d1);
    return days / 360;
  }
  if (convention === "actual_365") {
    const start = Date.UTC(sy, sm - 1, sd);
    const end = Date.UTC(ey, em - 1, ed);
    const days = Math.round((end - start) / 86_400_000);
    return days / 365;
  }
  // actual_360
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  const days = Math.round((end - start) / 86_400_000);
  return days / 360;
}

export function addQuarters(dateIso: string, quarters: number): string {
  const d = new Date(dateIso);
  const origDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + quarters * 3);
  // If the day rolled forward (e.g. Jan 31 + 3mo → May 1), clamp to last day of target month
  if (d.getUTCDate() !== origDay) {
    d.setUTCDate(0); // last day of previous month
  }
  return d.toISOString().slice(0, 10);
}

// Helper: compute tranche coupon rate as a decimal
function trancheCouponRate(t: ProjectionInputs["tranches"][number], baseRatePct: number, baseRateFloorPct: number): number {
  // Floating: base rate (floored per deal terms) + spread. Fixed: spread represents the full coupon.
  return t.isFloating
    ? (Math.max(baseRateFloorPct, baseRatePct) + t.spreadBps / 100) / 100
    : t.spreadBps / 10000;
}

export function runProjection(inputs: ProjectionInputs, defaultDrawFn?: DefaultDrawFn): ProjectionResult {
  const {
    initialPar, wacSpreadBps, baseRatePct, baseRateFloorPct, seniorFeePct, subFeePct,
    taxesBps = 0, issuerProfitAmount = 0, trusteeFeeBps, adminFeeBps = 0,
    seniorExpensesCapBps,
    seniorExpensesCapAbsoluteFloorPerYear = 0,
    // Neutral defaults match DEFAULT_ASSUMPTIONS in build-projection-inputs.ts.
    // PPM-correct mechanics (e.g., Ares XV's "sequential_b_first" /
    // "sequential_y_first") arrive via the resolver path through
    // `defaultsFromResolved` → `resolved.seniorExpensesCap`; hand-constructed
    // ProjectionInputs (test factories, legacy fixtures) get the neutral
    // pro-rata baseline rather than any deal-specific PPM mechanic.
    seniorExpensesCapAllocationWithinCap = "pro_rata",
    seniorExpensesCapOverflowAllocation = "pro_rata",
    seniorExpensesCapComponentADayCount = "actual_360",
    seniorExpensesCapBaseMode = "APB",
    seniorExpensesCapCarryforwardPeriods = null,
    seniorExpensesCapVatIncluded = false,
    seniorExpensesCapVatRatePct = null,
    firstPaymentDate = null,
    hedgeCostBps, incentiveFeePct, incentiveFeeHurdleIrr,
    postRpReinvestmentPct, callMode, callDate, nonCallPeriodEnd, callPricePct, callPriceMode, reinvestmentOcTrigger, eventOfDefaultTest,
    stubPeriod, firstPeriodEndDate,
    reinvestmentPeriodExtension,
    tranches, ocTriggers, icTriggers,
    reinvestmentPeriodEnd, maturityDate, currentDate,
    loans, defaultRatesByRating, cdrMultiplierPathFn, cprPct, recoveryPct, recoveryLagMonths,
    ratingAgencies,
    reinvestmentSpreadBps, reinvestmentTenorQuarters, reinvestmentRating: reinvestmentRatingOverride, reinvestmentPricePct = 100, reinvestmentPriceSource = "user_override",
    cccBucketLimitPct, cccMarketValuePct, deferredInterestCompounds,
    initialPrincipalCash = 0,
    initialUnusedProceedsCash = 0,
    initialInterestAccountCash = 0,
    initialInterestSmoothingBalance = 0,
    initialExpenseReserveBalance = 0,
    initialSupplementalReserveBalance = 0,
    supplementalReserveDisposition = "principalCash",
    seniorExpensesCapCarryforwardSeed,
    preExistingDefaultedPar = 0, preExistingDefaultRecovery = 0, unpricedDefaultedPar = 0, preExistingDefaultOcValue = 0,
    impliedOcAdjustment = 0, quartersSinceReport = 0,
    discountObligationRule = null,
    longDatedValuationRule = null,
    ddtlDrawPercent = 100,
    moodysWarfTriggerLevel = null,
    minWasBps: minWasBpsTrigger = null,
    moodysCaaLimitPct: moodysCaaLimitPctTrigger = null,
    fitchCccLimitPct: fitchCccLimitPctTrigger = null,
    referenceWafcPct = null,
    dealCurrency = null,
    overriddenBuckets,
    interestNonPaymentGracePeriods,
  } = inputs;
  // PPM § 10(a)(i) grace period for non-deferrable senior interest
  // shortfall before EoD fires. Default 0 (conservative — any shortfall
  // fires immediately) when the resolver hasn't extracted a per-deal
  // value. See ProjectionInputs docstring.
  const eodGrace = interestNonPaymentGracePeriods ?? 0;
  const overriddenBucketSet = overriddenBuckets && overriddenBuckets.length > 0
    ? new Set<string>(overriddenBuckets)
    : null;

  // D1: the two most-senior debt tranches (structurally Class A and Class B,
  // regardless of label) are non-deferrable per PPM — if they don't receive
  // full interest, the deal hits an Event of Default (not PIK). A tranche
  // incorrectly marked deferrable here would silently compound deferred
  // interest onto a non-deferrable balance and over-report equity — very
  // wrong. Fail fast so the resolver or user input is caught before it
  // poisons the projection.
  //
  // Predicate is rank-based, not name-based: protected = the lowest two
  // distinct seniorityRank values among non-income, non-amortising tranches.
  // This handles Class X-bearing structures (X amortising at rank 1 → A=2,
  // B=3 protected), pari-passu splits (B-1/B-2 sharing rank 2 both
  // protected), and non-canonical labels (a senior tranche named e.g.
  // "K-1" still trips the guard because rank, not name, decides).
  // Amortising tranches (Class X) are also non-deferrable per PPM and trip
  // a separate guard.
  const nonAmortDebtRanks = Array.from(
    new Set(
      tranches.filter((t) => !t.isIncomeNote && !t.isAmortising).map((t) => t.seniorityRank),
    ),
  ).sort((a, b) => a - b);
  const seniorProtectedRanks = new Set(nonAmortDebtRanks.slice(0, 2));
  for (const t of tranches) {
    if (t.isIncomeNote) continue;
    if (t.isAmortising && t.isDeferrable) {
      throw new Error(
        `Tranche "${t.className}" is amortising AND marked isDeferrable=true, ` +
          `but amortising tranches (e.g. Class X) cannot defer interest per PPM. ` +
          `Check resolver output or tranche input.`,
      );
    }
    if (seniorProtectedRanks.has(t.seniorityRank) && t.isDeferrable) {
      throw new Error(
        `Tranche "${t.className}" (seniorityRank=${t.seniorityRank}) is marked ` +
          `isDeferrable=true, but the two most-senior debt ranks (structurally ` +
          `Class A/B) are non-deferrable per PPM — non-payment of interest is ` +
          `an Event of Default, not deferral. Check resolver output or tranche input.`,
      );
    }
    // PPM § 10(a)(i) seed validation: priorInterestShortfall and
    // priorShortfallCount are non-deferrable-only state. Deferrables
    // track shortfall via `deferredBalances` (separate engine state).
    //
    // The user-facing UX for this data-shape invariant flows through
    // the blocking-warning gate in `buildFromResolved` (DATA INCOMPLETE
    // banner via `selectBlockingWarnings` → `IncompleteDataError`). The
    // engine assert below is defense-in-depth ONLY — a backstop for
    // code paths
    // that synthesize `ProjectionInputs` without going through
    // `buildFromResolved` (e.g. test fixtures constructed by hand). On
    // those paths the user sees an engine throw rather than the banner;
    // the recommended path is to construct via buildFromResolved so the
    // banner fires instead.
    const hasShortfallSeed =
      (t.priorInterestShortfall ?? null) !== null ||
      (t.priorShortfallCount ?? null) !== null;
    if (hasShortfallSeed && (t.isDeferrable || t.isAmortising || t.isIncomeNote)) {
      throw new Error(
        `Tranche "${t.className}" carries priorInterestShortfall / ` +
          `priorShortfallCount but is deferrable / amortising / income-note. ` +
          `These seeds apply only to non-deferrable senior debt tranches per ` +
          `PPM § 10(a)(i). Construct ProjectionInputs via buildFromResolved ` +
          `to surface this as a DATA INCOMPLETE banner instead of a throw.`,
      );
    }
    // PPM Condition 6(c) deferred-bucket seed validation: deferrables
    // are the only class that carries `deferredInterestBalance`. Same
    // user-facing UX rule as above — the canonical surface is the
    // banner via `buildFromResolved`; this throw is defense-in-depth
    // for hand-constructed inputs that bypass the gate.
    if (t.deferredInterestBalance != null && !t.isDeferrable) {
      throw new Error(
        `Tranche "${t.className}" is non-deferrable but carries ` +
          `deferredInterestBalance. Non-deferrables breach EoD on missed ` +
          `interest per PPM § 10(a)(i); they cannot accumulate to a deferred ` +
          `bucket. Construct ProjectionInputs via buildFromResolved to ` +
          `surface this as a DATA INCOMPLETE banner instead of a throw.`,
      );
    }
    // Sign invariant on the deferred-bucket seed. The boundary gate in
    // composeBuildWarnings refuses negative values before buildFromResolved
    // can return; this throw mirrors that on the hand-constructed-inputs
    // path so a negative seed cannot reach the engine and produce a
    // negative-balance bucket at runtime.
    if (t.deferredInterestBalance != null && t.deferredInterestBalance < 0) {
      throw new Error(
        `Tranche "${t.className}" carries a negative ` +
          `deferredInterestBalance (${t.deferredInterestBalance}). The ` +
          `deferred-interest sub-account is non-negative by construction; ` +
          `a negative value indicates extraction sign-flip or column ` +
          `misalignment. Construct ProjectionInputs via buildFromResolved ` +
          `to surface this as a DATA INCOMPLETE banner instead of a throw.`,
      );
    }
  }

  // Stub-period anchor (post-v6 plan §4.2). When `stubPeriod === true` and
  // `firstPeriodEndDate` is supplied, period 1 ends at the supplied date and
  // is shorter than a full quarter. Subsequent periods are full quarters
  // starting from that date. When `stubPeriod` is absent/false, the anchor
  // is `addQuarters(currentDate, 1)` — preserves pre-§4.2 behavior exactly.
  const useStub = stubPeriod === true && firstPeriodEndDate != null;
  const stubAnchor = useStub ? firstPeriodEndDate! : addQuarters(currentDate, 1);
  // periodEnd(q): end of period q. q=1 → stubAnchor; q>=2 → stubAnchor + (q-1) quarters.
  const periodEndDate = (q: number): string =>
    q === 1 ? stubAnchor : addQuarters(stubAnchor, q - 1);
  const periodStartDate = (q: number): string =>
    q === 1 ? currentDate : periodEndDate(q - 1);

  const maturityQuarters = maturityDate
    ? useStub
      ? 1 + Math.max(0, quartersBetween(stubAnchor, maturityDate))
      : Math.max(1, quartersBetween(currentDate, maturityDate))
    : CLO_DEFAULTS.defaultMaxTenorYears * 4;
  // Manager call gate (post-v6 plan §4.1): the call only fires when callMode is
  // "optionalRedemption" AND callDate is set. callMode === "none" is the
  // conservative baseline (project to legal final). Either condition false →
  // ignore callDate.
  const callActive = callMode === "optionalRedemption" && callDate != null;
  // PPM Condition 7.2 enforcement: refuse pre-NCP and past callDates. The
  // canonical user path through buildFromResolved + applyOptionalRedemptionCall
  // intercepts upstream and renders a banner; this engine guard is the
  // backstop for hand-constructed inputs (tests, harnesses, future
  // programmatic callers). NCP gate skipped when nonCallPeriodEnd is null —
  // the resolver layer blocks ingestion of CLOs without an extracted NCP, so
  // null here indicates a synthetic input that has no NCP to enforce against.
  // Past-date check has no override: calling in the past is never a
  // meaningful scenario, even under stress.
  if (callActive && callDate != null) {
    const ncp = nonCallPeriodEnd ?? null;
    if (callDate < currentDate) {
      throw new InvalidCallDateError("past", callDate, currentDate, ncp);
    }
    if (ncp != null && callDate < ncp) {
      throw new InvalidCallDateError("preNcp", callDate, currentDate, ncp);
    }
  }
  const callQuarters = callActive && callDate
    ? useStub
      ? 1 + Math.max(0, quartersBetween(stubAnchor, callDate))
      : Math.max(1, quartersBetween(currentDate, callDate))
    : null;
  const totalQuarters = callQuarters ? Math.min(callQuarters, maturityQuarters) : maturityQuarters;
  const recoveryLagQ = Math.max(0, Math.round(recoveryLagMonths / 3));

  // Pre-compute quarterly hazard rates per rating bucket. Used by the
  // `overriddenBuckets` UI-slider override path and by the cdrMultiplierPathFn
  // Infinity-fallback edge case. See the default-draw loop below.
  // §7.5: when `cdrMultiplierPathFn` is supplied the engine recomputes
  // hazard per quarter from the path; the constant-path (`quarterlyHazard`)
  // is the q=undefined / fallback case used everywhere
  // `cdrMultiplierPathFn` is absent.
  const cdrToHazard = (annualCDR: number): number => {
    const clamped = Math.max(0, Math.min(annualCDR, 99.99));
    return 1 - Math.pow(1 - clamped / 100, 0.25);
  };
  const computeQuarterlyHazard = (cdrMap: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [rating, annualCDR] of Object.entries(cdrMap)) {
      out[rating] = cdrToHazard(annualCDR);
    }
    return out;
  };
  const quarterlyHazardConstant = computeQuarterlyHazard(defaultRatesByRating);

  // Quarterly prepay rate
  const clampedCpr = Math.max(0, Math.min(cprPct, 99.99));
  const qPrepayRate = 1 - Math.pow(1 - clampedCpr / 100, 0.25);

  // Internal per-loan state
  interface LoanState {
    survivingPar: number;
    maturityQuarter: number;
    ratingBucket: string;
    spreadBps: number;
    /** C2 — Moody's WARF factor for this position. Set from LoanInput.warfFactor
     *  when present (per-position rating), else fallback to coarse-bucket midpoint
     *  via BUCKET_WARF_FALLBACK. Reinvested loans use the bucket fallback on
     *  `reinvestmentRating`. */
    warfFactor: number;
    isFixedRate?: boolean;
    fixedCouponPct?: number;
    isDeferring?: boolean;
    isLossMitigationLoan?: boolean;
    currency?: string;
    moodysRatingFinal?: string;
    fitchRatingFinal?: string;
    moodysRatingSource?: import("./resolve-rating").MoodysRatingSource;
    isCreditEstimateOrPrivateRating?: boolean;
    isDelayedDraw?: boolean;
    /** Facility-type tag — revolving credit facility. Informational; survives
     *  draws. Currently-unfunded quantity lives on `undrawnCommitment`. */
    isRevolving?: boolean;
    /** Currently-unfunded commitment (drawn par lives on `survivingPar`).
     *  Initialized from `LoanInput.undrawnCommitment ?? 0`. Decremented in
     *  the per-period draw event by the drawn amount; preserved across
     *  partial draws so the residual still subtracts from the OC numerator
     *  (per PPM Adjusted Collateral Principal Amount) and is still visible
     *  to the never-draw splice / commitment-end disposition. */
    undrawnCommitment: number;
    ddtlSpreadBps?: number;
    drawQuarter?: number;
    /** Per-position market price as % of par. Set from LoanInput.currentPrice on
     *  initial construction. Reinvested positions default to 100 (just-originated
     *  at par). Used for A3 call-at-MtM liquidation AND B1 EoD MV × PB. */
    currentPrice?: number | null;
    /** B1 Tier 2 — per-position defaulted par awaiting recovery. Populated by
     *  the Monte Carlo default loop; drained when the corresponding recovery
     *  event arrives (quarter q + recoveryLagQ). While > 0, the loan
     *  contributes to the EoD Σ(MV × PB) component at currentPrice. */
    defaultedParPending: number;
    /** Scheduled per-position recovery events. Each entry drains
     *  `defaultedParPending` by its `defaultedPar` when its `quarter` arrives.
     *  Cash flow is captured separately via the aggregate `recoveryPipeline`
     *  so existing downstream cash accounting is unchanged. */
    defaultEvents: Array<{ quarter: number; defaultedPar: number }>;
    /** Per-position day-count convention. Carried from `LoanInput` (in turn
     *  from `clo_holdings.day_count_convention`). Undefined for synthetic
     *  reinvestment loans created mid-projection — those use Actual/360 by
     *  market default for floating Euro paper. */
    dayCountConvention?: DayCountConvention;
    /** Per-position EURIBOR floor in PERCENT. Carried from `LoanInput`
     *  (in turn from `clo_holdings.floor_rate`). Undefined for synthetic
     *  reinvestment loans — those fall back to the deal-level
     *  `baseRateFloorPct`. */
    floorRate?: number;
    /** Per-position recovery rate as a fraction (0..1), resolved from the
     *  loan's agency recovery rates via `resolveAgencyRecovery` at
     *  LoanState construction. Consumed at the forward-default firing
     *  site to compute per-loan recovered cash; falls back to the global
     *  `recoveryPct / 100` when undefined. Synthetic reinvestment loans
     *  leave this unset — see the inline comment at the default site
     *  for the original-vs-reinvested asymmetry. */
    recoveryRateAgency?: number;
    /** Live forward PIK rate in basis points. Carried
     *  from `LoanInput.pikSpreadBps`. When > 0, the per-loan accrual
     *  loop additively accretes `par × pikSpreadBps/10000 × dayFrac` to
     *  `survivingPar` on top of the cash interest path. Synthetic
     *  reinvestment loans leave this undefined (default cash-paying). */
    pikSpreadBps?: number;
    /** Per-position purchase price as percent of par (immutable).
     *  Carried from `LoanInput.purchasePricePct`. The cure mechanic
     *  may reclassify `isDiscountObligation` per period, but
     *  `purchasePricePct` itself is a one-time stamp from acquisition
     *  and never updates. Synthetic reinvestment loans set this at
     *  synthesis time from the calibration-derived assumption. */
    purchasePricePct?: number;
    /** Acquisition date (ISO YYYY-MM-DD). Used by the cure mechanic
     *  to require holding-since-acquisition before cure can fire. */
    acquisitionDate?: string;
    /** Discount Obligation classification flag — re-evaluated each
     *  period by the cure-mechanic dispatch in the period loop.
     *  `continuous_threshold` may flip true→false when MV crosses
     *  the cure threshold; `permanent_until_paid` never flips. */
    isDiscountObligation?: boolean;
    /** Long-Dated Collateral Obligation classification flag — static
     *  per-position (no cure). Engine dispatches the per-deal
     *  `longDatedValuationRule` over Σ of positions where this is true,
     *  applying within-cap and post-cap valuation independently. */
    isLongDated?: boolean;
  }

  // Per-deal Rating Agencies subset is required. Production callers via
  // `buildFromResolved` always populate from `resolved.ratingAgencies` (strict
  // capital-structure-only derivation). Hand-constructed test fixtures must
  // set the field explicitly via `makeInputs` (which defaults to all three
  // agencies) or per-test override. A widening fallback default here would
  // silently re-introduce all-three-agencies behavior at the forward-default
  // site for any hand-constructed inputs that omit the field — exactly the
  // "don't overfit to a single deal" silent shape this filter exists to close.
  // Empty array carries the same silent-fallback shape as `undefined`: an empty
  // subset makes `resolveAgencyRecovery` return `undefined`, which causes the
  // forward-default site to silently fall back to the global `recoveryPct`.
  // The resolver emits a blocking warning on the empty-set case so production
  // callers catch it via IncompleteDataError; this throw is the backstop for
  // hand-constructed test fixtures that bypass `buildFromResolved`.
  if (!ratingAgencies || ratingAgencies.length === 0) {
    throw new Error(
      `ProjectionInputs.ratingAgencies missing or empty. Production callers must construct ` +
        `inputs via buildFromResolved (which populates from resolved.ratingAgencies); ` +
        `test fixtures must pass the field explicitly. The OC numerator's per-agency ` +
        `recovery dispatch and the forward-default site both filter against this ` +
        `subset; an empty or missing value cannot be silently widened to all agencies.`,
    );
  }

  const loanStates: LoanState[] = loans.map((l) => ({
    survivingPar: l.parBalance,
    // Don't clamp to totalQuarters — loans with maturity beyond the call/maturity date
    // should NOT be treated as maturing at par. Instead, they remain as surviving par
    // that gets liquidated at callPricePct on the final period.
    maturityQuarter: Math.max(1, quartersBetween(currentDate, l.maturityDate)),
    ratingBucket: l.ratingBucket,
    spreadBps: l.spreadBps,
    warfFactor: l.warfFactor ?? BUCKET_WARF_FALLBACK[l.ratingBucket] ?? BUCKET_WARF_FALLBACK.NR,
    isFixedRate: l.isFixedRate,
    fixedCouponPct: l.fixedCouponPct,
    isDeferring: l.isDeferring,
    isLossMitigationLoan: l.isLossMitigationLoan,
    currency: l.currency,
    moodysRatingFinal: l.moodysRatingFinal,
    fitchRatingFinal: l.fitchRatingFinal,
    moodysRatingSource: l.moodysRatingSource,
    isCreditEstimateOrPrivateRating: l.isCreditEstimateOrPrivateRating,
    isDelayedDraw: l.isDelayedDraw,
    isRevolving: l.isRevolving,
    undrawnCommitment: l.undrawnCommitment ?? 0,
    ddtlSpreadBps: l.ddtlSpreadBps,
    drawQuarter: l.drawQuarter,
    currentPrice: l.currentPrice,
    defaultedParPending: 0,
    defaultEvents: [],
    dayCountConvention: l.dayCountConvention,
    floorRate: l.floorRate,
    recoveryRateAgency: resolveAgencyRecovery(
      { moodys: l.recoveryRateMoodys, sp: l.recoveryRateSp, fitch: l.recoveryRateFitch },
      ratingAgencies,
      // No mvFloor at the forward-default site: at default-time the trustee-
      // reported `currentPrice` is a stale pre-default snapshot, not informative
      // about post-default workout recovery. The PPM's `min(MV, RR)` per-agency
      // construction governs the T=0 OC numerator (Adjusted CPA paragraph (e),
      // oc.txt:7120-7124), not the modeled cash recovery upon a forward default.
    ),
    pikSpreadBps: l.pikSpreadBps,
    purchasePricePct: l.purchasePricePct,
    acquisitionDate: l.acquisitionDate,
    isDiscountObligation: l.isDiscountObligation,
    isLongDated: l.isLongDated,
  }));

  // Remove never-draw DDTL/revolver commitments (drawQuarter <= 0) — the un-
  // drawn notional terminates without funding, so it shouldn't sit on the OC
  // subtractor for the rest of the projection. Gate on undrawnCommitment > 0
  // (the quantitative state); a fully-drawn DDTL facility (Eleda-shape:
  // parBalance > 0, undrawnCommitment === 0) is NOT a never-draw — it has
  // nothing left to draw, and its funded balance continues to accrue
  // interest. A partially-drawn DDTL with a positive residual on
  // undrawnCommitment and a non-positive drawQuarter is the never-draw shape:
  // zero the un-drawn residual, keep the funded portion.
  for (let i = loanStates.length - 1; i >= 0; i--) {
    const l = loanStates[i];
    if (l.undrawnCommitment > 0 && (l.drawQuarter ?? 0) <= 0) {
      if (l.survivingPar > 0) {
        l.undrawnCommitment = 0;
      } else {
        loanStates.splice(i, 1);
      }
    }
  }

  const hasLoans = loanStates.length > 0;
  // Average loan size — used to chunk reinvestment into realistic individual
  // loans for Monte Carlo. "Funded" = currently-drawn par > 0 — independent
  // of the isDelayedDraw facility-type tag (a fully-drawn DDTL is funded).
  const fundedLoans = loanStates.filter(l => l.survivingPar > 0);
  const avgLoanSize = fundedLoans.length > 0
    ? fundedLoans.reduce((s, l) => s + l.survivingPar, 0) / fundedLoans.length
    : 0;

  // Reinvestment rating: user override or portfolio's par-weighted modal bucket (funded loans only)
  const reinvestmentRating = reinvestmentRatingOverride ?? (() => {
    const parByRating: Record<string, number> = {};
    for (const l of fundedLoans) {
      parByRating[l.ratingBucket] = (parByRating[l.ratingBucket] ?? 0) + l.survivingPar;
    }
    let best = "NR";
    let bestPar = 0;
    for (const [rating, par] of Object.entries(parByRating)) {
      // Tie-break alphabetically for deterministic results regardless of loan order
      if (par > bestPar || (par === bestPar && rating < best)) { best = rating; bestPar = par; }
    }
    return best;
  })();
  // C2 — WARF factor for reinvested positions. Uses the coarse-bucket fallback
  // (no per-position sub-bucket on reinvestment). NR→b2 proxy if bucket unknown.
  const reinvestmentWarfFactor = BUCKET_WARF_FALLBACK[reinvestmentRating] ?? BUCKET_WARF_FALLBACK.NR;

  // Sub-threshold flag for synthesised reinvestment loans, computed
  // once at engine setup since reinvestment-purchase shape doesn't vary per
  // period. Reinvestment-rate-type derived from the pool's par-weighted
  // majority — managers typically reinvest in the same shape as the
  // existing collateral. A pool that is >50% par-weighted fixed-rate
  // synthesises fixed-rate reinvestments (classified at the deal's
  // fixed-rate threshold, e.g. Ares family 75); else floating (e.g. 80).
  // Hardcoding `false` here would silently mis-classify reinvested loans
  // on a fixed-rate-heavy deal whose rule splits by rate type. When the
  // rule is null (greenfield / hand-constructed inputs), no classification
  // applies and synthesised loans default to non-discount.
  const reinvIsFixedRate = (() => {
    if (fundedLoans.length === 0) return false;
    let fixedPar = 0;
    let totalPar = 0;
    for (const l of fundedLoans) {
      totalPar += l.survivingPar;
      if (l.isFixedRate) fixedPar += l.survivingPar;
    }
    return totalPar > 0 && fixedPar / totalPar > 0.5;
  })();
  const reinvIsSubThreshold = (() => {
    if (discountObligationRule == null) return false;
    const t = discountObligationRule.classificationThresholdPct;
    const threshold =
      t.type === "single"
        ? t.pct
        : reinvIsFixedRate
          ? t.fixedPct
          : t.floatingPct;
    return reinvestmentPricePct < threshold;
  })();

  // C1 — Max reinvestment amount that keeps the post-buy pool compliant with
  // every active reinvestment-period trigger:
  //   - Moody's Maximum WARF (`moodysWarfTriggerLevel`)
  //   - Min Weighted Average Floating Spread (`minWasBpsTrigger`,
  //     `floatingWAS + ExcessWAC`)
  //   - Moody's Caa Obligations concentration (`moodysCaaLimitPctTrigger`)
  //   - Fitch CCC Obligations concentration (`fitchCccLimitPctTrigger`)
  // Returns `requested` when no trigger is active or the buy fits entirely;
  // returns the boundary amount when the buy would breach a passing test;
  // returns 0 when the test is already breaching AND the reinvestment would
  // worsen it ("manager can maintain-or-improve but not actively worsen a
  // breaching test" — the engine's PPM-intent model). When several triggers
  // bind, the most restrictive boundary wins. Pure function of current
  // `loanStates` plus per-deal trigger inputs.
  const maxCompliantReinvestment = (currentQuarter: number, requested: number): number => {
    let allowed = requested;

    // Source the sums from the shared aggregator so the gate's pre-buy state
    // is bit-identical with `computePoolQualityMetrics`'s end-of-period
    // output. Drift between the two would mean the gate enforces against a
    // different pool than the one the partner sees on `qualityMetrics` —
    // exactly the parallel-implementation trap the shared helper exists to
    // prevent.
    const qLoans: QualityMetricLoan[] = [];
    for (const l of loanStates) {
      // survivingPar <= 0 covers both matured/liquidated loans and currently
      // un-drawn DDTL/revolver commitments (the un-drawn notional sits on
      // undrawnCommitment, not survivingPar — it is not deployed collateral
      // for purposes of the quality gate).
      if (l.survivingPar <= 0) continue;
      // Same partial-default exclusion as `computeQualityMetrics` —
      // mirroring the per-period helper exactly is load-bearing: the
      // gate's pre-buy state and the per-period output must apply
      // identical exclusions, else a reinvestment would be allowed
      // against one denominator and displayed against another.
      if (l.defaultedParPending > 0) continue;
      qLoans.push({
        parBalance: l.survivingPar,
        warfFactor: l.warfFactor,
        yearsToMaturity: 0, // unused by the gate's boundary math
        spreadBps: l.spreadBps,
        ratingBucket: l.ratingBucket,
        isFixedRate: l.isFixedRate,
        fixedCouponPct: l.fixedCouponPct,
        isDeferring: l.isDeferring,
        isLossMitigationLoan: l.isLossMitigationLoan,
        currency: l.currency,
        moodysRatingFinal: l.moodysRatingFinal,
        fitchRatingFinal: l.fitchRatingFinal,
        moodysRatingSource: l.moodysRatingSource,
        isCreditEstimateOrPrivateRating: l.isCreditEstimateOrPrivateRating,
      });
    }
    const {
      warfSum,
      totalPar: par,
      floatingPar,
      floatingSpreadSum,
      fixedPar,
      fixedCouponSum,
      concDenom,
      moodysCaaPar,
      fitchCccPar,
    } = aggregateQualityMetrics(qLoans, { dealCurrency });

    // ── WARF gate ──────────────────────────────────────────────────────────
    if (moodysWarfTriggerLevel != null && moodysWarfTriggerLevel > 0 && par > 0) {
      const factor = reinvestmentWarfFactor;
      const currentWarf = warfSum / par;
      // Factor at-or-below current WARF: adding it improves or holds. No limit.
      if (factor > currentWarf) {
        const postWarf = (warfSum + allowed * factor) / (par + allowed);
        if (postWarf > moodysWarfTriggerLevel) {
          // amount = (trigger × par − warfSum) / (factor − trigger).
          const denom = factor - moodysWarfTriggerLevel;
          if (denom > 0) {
            const boundary = (moodysWarfTriggerLevel * par - warfSum) / denom;
            allowed = Math.min(allowed, Math.max(0, boundary));
          }
        }
      }
    }

    // ── WAS gate (Min Weighted Average Floating Spread) ────────────────────
    // Reinvestment is floating-rate by construction (ratingBucket fallback,
    // spreadBps = reinvestmentSpreadBps). It contributes only to floating
    // numerator and floating denominator; the Excess WAC numerator (a
    // function of fixedPar / fixedCoupon) is invariant to X, the denominator
    // floatingPar grows with X.
    if (minWasBpsTrigger != null && minWasBpsTrigger > 0 && floatingPar > 0) {
      const refWAFC = referenceWafcPct ?? 4.0;
      const wafc = fixedPar > 0 ? fixedCouponSum / fixedPar : 0;
      const excessNumerator = (wafc - refWAFC) * 100 * fixedPar;
      // currentWAS bps = (floatingSpreadSum + excessNumerator) / floatingPar.
      const wasNumerator = floatingSpreadSum + excessNumerator;
      const currentWas = wasNumerator / floatingPar;
      const spread = reinvestmentSpreadBps;
      // If reinvestment spread ≥ current weighted-average, post-buy ≥ current.
      // If spread ≥ trigger, dilution toward trigger from above is fine.
      if (spread < currentWas && spread < minWasBpsTrigger) {
        const postNumerator = wasNumerator + allowed * spread;
        const postDenominator = floatingPar + allowed;
        const postWas = postNumerator / postDenominator;
        if (postWas < minWasBpsTrigger) {
          // X * (trigger − spread) = wasNumerator − trigger × floatingPar
          const denom = minWasBpsTrigger - spread;
          if (denom > 0) {
            const boundary = (wasNumerator - minWasBpsTrigger * floatingPar) / denom;
            allowed = Math.min(allowed, Math.max(0, boundary));
          }
        }
      }
    }

    // ── Moody's Caa concentration gate ─────────────────────────────────────
    // Reinvestment counts toward Caa only when its bucket-fallback rating is
    // CCC (engine reinvestment positions don't carry per-agency sub-buckets).
    // Non-CCC reinvestment dilutes the existing Caa share — never violates.
    if (
      moodysCaaLimitPctTrigger != null &&
      moodysCaaLimitPctTrigger > 0 &&
      concDenom > 0 &&
      reinvestmentRating === "CCC"
    ) {
      const limitFrac = moodysCaaLimitPctTrigger / 100;
      const denominator = 1 - limitFrac;
      if (denominator > 0) {
        // Already breaching → adding CCC always worsens (post > current when
        // current < 100% CCC). Block.
        if (moodysCaaPar / concDenom > limitFrac) {
          allowed = 0;
        } else {
          // Boundary: (caaPar + X)/(denom + X) = limit
          // X = (limit × denom − caaPar) / (1 − limit)
          const boundary = (limitFrac * concDenom - moodysCaaPar) / denominator;
          allowed = Math.min(allowed, Math.max(0, boundary));
        }
      }
    }

    // ── Fitch CCC concentration gate ───────────────────────────────────────
    if (
      fitchCccLimitPctTrigger != null &&
      fitchCccLimitPctTrigger > 0 &&
      concDenom > 0 &&
      reinvestmentRating === "CCC"
    ) {
      const limitFrac = fitchCccLimitPctTrigger / 100;
      const denominator = 1 - limitFrac;
      if (denominator > 0) {
        if (fitchCccPar / concDenom > limitFrac) {
          allowed = 0;
        } else {
          const boundary = (limitFrac * concDenom - fitchCccPar) / denominator;
          allowed = Math.min(allowed, Math.max(0, boundary));
        }
      }
    }

    return allowed;
  };

  // C2 — Compute end-of-period portfolio quality + concentration metrics from
  // `loanStates`. Ignores un-drawn commitment and defaulted par pending recovery.
  // Called at each period emit so partner can see forward drift. Delegates
  // the math to `computePoolQualityMetrics` in pool-metrics.ts so the switch
  // simulator uses identical formulas — single source of truth, no drift.
  const computeQualityMetrics = (currentQuarter: number): PeriodQualityMetrics => {
    const qloans = [];
    for (const l of loanStates) {
      // survivingPar <= 0 catches both matured/liquidated and un-drawn
      // DDTL/revolver — neither contributes to the deployed pool.
      if (l.survivingPar <= 0) continue;
      // Per PPM Condition 1 / definitions ("Defaulted Obligations", PDF p.
      // index TBD), the whole obligor is excluded from the Caa/CCC
      // concentration sets once any portion of its position is in default,
      // not just the defaulted portion. The conservative interpretation
      // (apply now, refine if PPM read says otherwise) skips any loan with
      // `defaultedParPending > 0` from the per-period quality metrics —
      // its surviving piece must NOT count toward Caa/CCC numerator or
      // denominator. Without this filter, a partially-defaulted Caa loan
      // would silently inflate `pctMoodysCaa` (numerator and denominator
      // both grow, but the rating-Caa flag biases the ratio upward),
      // potentially pushing reinvestment compliance gates past their
      // triggers. Magnitude is zero on Euro XV today (no partial defaults
      // in fixture) but emerges on portability + stress scenarios.
      if (l.defaultedParPending > 0) continue;
      qloans.push({
        parBalance: l.survivingPar,
        warfFactor: l.warfFactor,
        yearsToMaturity: Math.max(0, l.maturityQuarter - currentQuarter) / 4,
        spreadBps: l.spreadBps,
        ratingBucket: l.ratingBucket,
        isFixedRate: l.isFixedRate,
        fixedCouponPct: l.fixedCouponPct,
        isDeferring: l.isDeferring,
        isLossMitigationLoan: l.isLossMitigationLoan,
        currency: l.currency,
        moodysRatingFinal: l.moodysRatingFinal,
        fitchRatingFinal: l.fitchRatingFinal,
        moodysRatingSource: l.moodysRatingSource,
        isCreditEstimateOrPrivateRating: l.isCreditEstimateOrPrivateRating,
      });
    }
    return computePoolQualityMetrics(qloans, {
      referenceWAFC: referenceWafcPct ?? undefined,
      dealCurrency,
    });
  };

  // Track tranche balances (debt outstanding per tranche)
  const trancheBalances: Record<string, number> = {};
  // Deferred interest that doesn't compound — tracked separately so it
  // doesn't earn interest, but IS included in OC denominator and paydown.
  const deferredBalances: Record<string, number> = {};
  const sortedTranches = [...tranches].sort((a, b) => a.seniorityRank - b.seniorityRank);
  const debtTranches = sortedTranches.filter((t) => !t.isIncomeNote);
  const resolvedAmortPerPeriod: Record<string, number> = {};
  // Interest-payment shortfall on non-deferrable senior tranches. Per PPM
  // § 10(a)(i), missed interest on a non-deferrable tranche is NOT a PIK
  // accrual (no soft-deferrable carry-forward into next period's pre-accel
  // demand) — it is an EoD trigger after the deal-specific grace period.
  // This map records cumulative unpaid base interest per tranche so:
  //   (a) the EoD detector can fire when consecutive shortfall periods
  //       exceed `interestNonPaymentGracePeriods`, and
  //   (b) the post-acceleration handoff folds the running balance into
  //       `interestDueByTranche` (line ~2091) so the breach claim is whole.
  // Deferrable tranches use `deferredBalances` for PIK and don't accrue
  // here. Empty / all-zero in healthy scenarios.
  const interestShortfall: Record<string, number> = {};
  // Consecutive-period shortfall counter per non-deferrable senior tranche.
  // Increments each period the tranche is owed interest and receives less
  // than the full amount; resets to 0 on a fully-paid period. Drives the
  // PPM § 10(a)(i) grace-period gate for EoD detection.
  const shortfallCount: Record<string, number> = {};
  for (const t of sortedTranches) {
    trancheBalances[t.className] = t.currentBalance;
    // PPM Condition 6(c) opening Deferred Interest seed. Conditional on
    // the deal's compounding convention:
    //   - compounds=true (Ares-family PPMs): per Condition 6(c),
    //     "Deferred Interest [...] will be added to the principal amount
    //     of the [Class] Notes [...] and thereafter will accrue interest
    //     at the rate of interest applicable to that Class." Prior PIK
    //     is therefore embedded in `currentBalance` (the trustee's
    //     `endingBalance`/`Current` column reflects PAO + accumulated
    //     PIK). Seeding from `t.deferredInterestBalance` would double-
    //     count. Engine ignores the trustee field; the
    //     buildFromResolved gate emits a soft cause-tree warning when a
    //     populated value is encountered under compounding so the
    //     partner can verify (informational disclosure vs extraction
    //     misalignment vs non-Ares snapshot-timing wrinkle).
    //   - compounds=false (non-compounding PPMs that hold deferred in a
    //     separate sub-account, NOT added to PAO). The trustee field
    //     carries the T=0 sub-account balance; engine seeds here.
    //
    // The buildFromResolved gate ensures the trustee value, if present
    // on a non-deferrable tranche, has already been refused (DATA
    // INCOMPLETE banner). It also blocks values exceeding currentBalance
    // under compounding (mathematically impossible per PPM 6(c)).
    deferredBalances[t.className] = deferredInterestCompounds
      ? 0
      : (t.deferredInterestBalance ?? 0);
    // Seed PPM § 10(a)(i) running state from the input. Null/undefined → 0
    // (no prior carry; standard for a healthy projection start). Populated
    // from a resolver-extracted trustee shortfall snapshot when the deal's
    // most recent payment date showed unpaid senior interest mid-grace.
    interestShortfall[t.className] = t.priorInterestShortfall ?? 0;
    shortfallCount[t.className] = t.priorShortfallCount ?? 0;
    if (t.isAmortising) {
      resolvedAmortPerPeriod[t.className] = t.amortisationPerPeriod ?? (t.currentBalance / CLO_DEFAULTS.defaultScheduledAmortPeriods);
    }
  }
  // EoD-protected tranches per PPM § 10(a)(i): the same set the D1 guard
  // uses (non-income, non-amortising tranches at the lowest two distinct
  // seniorityRank values). Computed once here rather than re-derived per
  // period — the rank topology is invariant across the projection.
  //
  // Edge case: a deal with NO non-amortising debt tranches (entire debt
  // stack is amortising — extremely unusual, structurally inconsistent
  // with PPM § 10(a)(i) which presumes a non-deferrable senior at risk
  // of payment shortfall) yields an empty set. The shortfall mechanic
  // then silently does nothing. This matches reality: there's no rank-
  // protected tranche to protect; § 10(a)(i) does not apply.
  // `accrueShortfall` skips amortising tranches anyway (line ~2660 below),
  // so `interestShortfall` would stay all-zero and the trigger has nothing
  // to detect. If a deal of this shape ever appears, the silent-disable
  // is the correct PPM-faithful behavior — but flag for a cross-check
  // against the deal's specific § 10 wording.
  const eodProtectedClassNames = new Set(
    tranches
      .filter((t) => !t.isIncomeNote && !t.isAmortising && seniorProtectedRanks.has(t.seniorityRank))
      .map((t) => t.className),
  );

  const ocTriggersByClass = ocTriggers;
  const icTriggersByClass = icTriggers;

  // Recovery pipeline: future cash from defaulted assets
  const recoveryPipeline: { quarter: number; amount: number }[] = [];

  // Seed recovery from pre-existing defaults (loans already defaulted before projection start).
  // Priced holdings: use market-price recovery. Unpriced holdings: use model recoveryPct.
  // Timing adjustment: if the compliance report is N quarters old, the default happened at least
  // N quarters ago, so the recovery is N quarters closer. Uses reportDate as proxy for default
  // date since exact default dates are rarely available in compliance reports.
  if (preExistingDefaultedPar > 0) {
    const totalRecovery = preExistingDefaultRecovery + unpricedDefaultedPar * (recoveryPct / 100);
    if (totalRecovery > 0) {
      const adjustedRecoveryQ = Math.max(1, 1 + recoveryLagQ - quartersSinceReport);
      recoveryPipeline.push({ quarter: adjustedRecoveryQ, amount: totalRecovery });
    }
  }

  // When loans are provided, use their total as the starting par (not the Adjusted CPA
  // which includes cash, haircuts, and other OC adjustments that are modeled separately).
  // Funded loan total excludes unfunded DDTLs — consistent with beginningPar/endingPar.
  // survivingPar IS the funded balance — un-drawn DDTL/revolver commitments
  // sit on `undrawnCommitment` and contribute zero here. The pre-fix
  // `!isDelayedDraw` filter was redundant and Eleda-shape unsafe (a fully-
  // drawn DDTL was excluded by the tag despite carrying live funded par).
  const loanTotal = hasLoans ? loanStates.reduce((s, l) => s + l.survivingPar, 0) : 0;
  let currentPar = hasLoans ? loanTotal : initialPar;
  const periods: PeriodResult[] = [];
  const equityCashFlows: number[] = [];

  const tranchePayoffQuarter: Record<string, number | null> = {};
  let totalEquityDistributions = 0;

  const totalDebtOutstanding = debtTranches.reduce((s, t) => s + t.currentBalance, 0);
  // Equity investment: user-specified entry price if provided, otherwise balance-sheet implied value.
  // Balance-sheet identity: cash held in the four reserve accounts is a real claim against equity
  // at T=0 regardless of the manager's eventual disposition (Interest / Supplemental flow per their
  // PPM rules; Smoothing flushes back; Expense Reserve drains as cap overflow). Per PPM Condition 1
  // these reserves do NOT enter the OC numerator (Adjusted Collateral Principal Amount limits
  // account-cash credit to Principal + Unused Proceeds), but they DO sit on the deal's balance
  // sheet and the equity holder's claim includes them.
  const reserveAccountTotal =
    initialInterestAccountCash +
    initialInterestSmoothingBalance +
    initialSupplementalReserveBalance +
    initialExpenseReserveBalance;
  const totalAssets = hasLoans
    ? loanTotal + initialPrincipalCash + reserveAccountTotal
    : initialPar + reserveAccountTotal;
  // The Math.max(0, totalAssets - totalDebtOutstanding) here is an
  // ACCOUNTING-CONVENTION floor (Phase 8 triage category β): negative
  // balance-sheet equity is reported as zero by convention. NOT a heuristic-
  // disguised-as-value (the once-proposed `q1Cash` floor at line ~1316 was
  // that, and was rejected because it manufactured fake alpha by ignoring
  // the determination-date overdraft).
  //
  // When this floor fires, equityCashFlows[0] = -0 and calculateIrr() returns
  // null on the all-non-negative series. Surfaced via initialState.equityWipedOut
  // so the UI can label this state rather than show "N/A".
  //
  // Note: the negative principalAccountCash IS retained inside totalAssets —
  // the determination-date overdraft is a real claim against equity at t=0.
  // Q1's principal-collection netting at line ~1316 uses the same signed
  // value; both are correct; floored variants would be wrong.
  const equityBookValueRaw = totalAssets - totalDebtOutstanding;
  const bookValue = Math.max(0, equityBookValueRaw);
  const equityWipedOut = equityBookValueRaw <= 0;
  const equityInvestment = inputs.equityEntryPrice != null && inputs.equityEntryPrice > 0
    ? inputs.equityEntryPrice
    : bookValue;
  equityCashFlows.push(-equityInvestment);

  for (const t of sortedTranches) {
    tranchePayoffQuarter[t.className] = null;
  }

  // Post-v6 plan §4.5: effective RP end is `max(extracted, user extension)`.
  // The max() preserves a late extracted RP — a user-set extension can lengthen
  // but never shorten the active reinvestment window.
  const effectiveRpEnd =
    reinvestmentPeriodExtension && reinvestmentPeriodEnd
      ? reinvestmentPeriodExtension > reinvestmentPeriodEnd
        ? reinvestmentPeriodExtension
        : reinvestmentPeriodEnd
      : reinvestmentPeriodExtension ?? reinvestmentPeriodEnd;
  const rpEndDate = effectiveRpEnd ? new Date(effectiveRpEnd) : null;

  // Per-position discount-obligation haircut Σ. Each classified position
  // contributes `par × (1 − purchasePricePct/100)` to the OC numerator
  // deduction; the haircut shrinks automatically as positions amortize /
  // prepay / default (their `survivingPar` decays in the existing
  // loanStates mutation paths).
  //
  // Skips contribution when `purchasePricePct == null` (no extracted
  // price — no signal, contribute zero), `purchasePricePct >= 100`
  // (premium-purchase has no haircut by definition). Hand-constructed test
  // fixtures that don't model the discount mechanic see all loans with
  // `isDiscountObligation === undefined` and the haircut collapses to zero
  // — same numerical output as the pre-KI-29 path on those inputs. Un-drawn
  // DDTL/revolver commitments contribute zero implicitly via survivingPar=0;
  // their un-drawn notional is captured separately on the OC subtractor.
  const computeDiscountHaircut = (states: LoanState[]): number => {
    let total = 0;
    for (const l of states) {
      if (l.isDiscountObligation !== true) continue;
      if (l.purchasePricePct == null || l.purchasePricePct >= 100) continue;
      total += l.survivingPar * (1 - l.purchasePricePct / 100);
    }
    return total;
  };

  // Cure-mechanic dispatch. Re-evaluates `isDiscountObligation`
  // per period under the per-deal `discountObligationRule.cureMechanic`
  // variant. `continuous_threshold` may flip true→false when the
  // position's current MV is at or above the cure threshold and the
  // holding-since-acquisition window has elapsed; `permanent_until_paid`
  // never flips (returns immediately). At quarterly engine cadence with
  // static `currentPrice` from ingestion, the dispatch is a no-op after
  // the initial T=0 application — but it remains correctly per-period
  // because (i) reinvested loans synthesised mid-projection get
  // classified at synthesis time and may cure on a later PD, and (ii)
  // any future engine extension that models price evolution will exercise
  // the per-period dispatch automatically. Both `days` and `payment_dates`
  // cure-window variants collapse to "current price >= cure threshold
  // AND held-since-acquisition >= window" at PD granularity — see
  // ResolvedCureWindow docstring for the simplification rationale.
  const applyCureDispatch = (states: LoanState[], asOfDate: string): void => {
    if (discountObligationRule == null) return;
    if (discountObligationRule.cureMechanic.type !== "continuous_threshold") return;
    const cm = discountObligationRule.cureMechanic;
    const asOfMs = new Date(asOfDate).getTime();
    for (const l of states) {
      if (l.isDiscountObligation !== true) continue;
      if (l.currentPrice == null) continue;
      const cureThreshold =
        cm.cureThresholdPct.type === "single"
          ? cm.cureThresholdPct.pct
          : l.isFixedRate
            ? cm.cureThresholdPct.fixedPct
            : cm.cureThresholdPct.floatingPct;
      if (l.currentPrice < cureThreshold) continue;
      // Holding-since-acquisition window check. Conservative: positions
      // missing acquisitionDate cannot cure (we can't assert the window
      // has elapsed). Synthesised reinvestment loans set acquisitionDate
      // at synthesis time so this check fires correctly for them.
      if (l.acquisitionDate == null) continue;
      const acquiredMs = new Date(l.acquisitionDate).getTime();
      const meetsWindow =
        cm.cureWindow.type === "days"
          ? (asOfMs - acquiredMs) / (24 * 3600 * 1000) >= cm.cureWindow.n
          : quartersBetween(l.acquisitionDate, asOfDate) >= cm.cureWindow.n;
      if (meetsWindow) {
        l.isDiscountObligation = false;
      }
    }
  };

  // Per-position long-dated obligation haircut Σ. Dispatches
  // on the per-deal `longDatedValuationRule.withinCap` × `postCap`:
  //
  //   withinCap.par                — within-cap par valued at face (no
  //                                  haircut on the within-cap slice).
  //   withinCap.tiered_mv_or_capped — within-cap valued at
  //                                  min(currentPrice, cappedPricePct);
  //                                  beyond `cliffYearsPastStatedMaturity`
  //                                  past stated maturity, valued at zero.
  //   postCap.zero                  — above-cap par valued at zero
  //                                  (Ares-family "deemed zero").
  //   postCap.agency_cv_min         — NOT REACHABLE: resolver gates
  //                                  selection of this variant on
  //                                  per-position S&P/Fitch CV
  //                                  ingestion which doesn't exist
  //                                  today. Engine asserts.
  //
  // Rule is null on hand-constructed test inputs and on legacy fixtures
  // — engine emits zero haircut on those inputs. Allocation between
  // within-cap and above-cap par is proportional across the long-dated
  // cohort (avoids order-dependent surprises if a future caller re-
  // orders loanStates).
  //
  // Portability gap: defaulted long-dated positions use survivingPar
  // rather than Fitch Collateral Value — see ResolvedLongDatedValuationRule
  // JSDoc for the verbatim PPM clause and rationale.
  const computeLongDatedHaircut = (
    states: LoanState[],
    asOfQuarter: number,
    rule: ResolvedLongDatedValuationRule | null,
    apbBase: number,
    cpaBase: number,
  ): number => {
    if (rule == null) return 0;
    const longDated = states.filter(
      l => l.isLongDated === true && !l.isDelayedDraw && l.survivingPar > 0,
    );
    if (longDated.length === 0) return 0;
    const totalLongDatedPar = longDated.reduce((s, l) => s + l.survivingPar, 0);
    const baseAmount = rule.capBase === "APB" ? apbBase : cpaBase;
    const capAmount = Math.max(0, baseAmount * (rule.capPctOfBase / 100));

    const withinCapShare =
      totalLongDatedPar <= capAmount ? 1 : capAmount / totalLongDatedPar;

    let haircut = 0;
    for (const l of longDated) {
      const withinCapPar = l.survivingPar * withinCapShare;

      // Within-cap valuation — exhaustive on rule.withinCap.type.
      let withinCapValue: number;
      if (rule.withinCap.type === "par") {
        withinCapValue = withinCapPar;
      } else if (rule.withinCap.type === "tiered_mv_or_capped") {
        // Quarters past stated maturity = how far the as-of period is
        // past the loan's maturityQuarter (which itself is the quarter
        // index of the loan's stated maturity from projection start).
        // Negative when maturity is in the future.
        const yearsPast = (asOfQuarter - l.maturityQuarter) / 4;
        if (yearsPast > rule.withinCap.cliffYearsPastStatedMaturity) {
          withinCapValue = 0;
        } else if (l.currentPrice == null) {
          // No MV signal — conservative: floor at cappedPricePct.
          withinCapValue = withinCapPar * (rule.withinCap.cappedPricePct / 100);
        } else {
          const effectivePct = Math.min(l.currentPrice, rule.withinCap.cappedPricePct);
          withinCapValue = withinCapPar * (effectivePct / 100);
        }
      } else {
        // Exhaustiveness guard — adding a new `withinCap.type` variant
        // without a matching engine branch must be a compile error here,
        // not a silent NaN haircut at runtime.
        const _exhaustive: never = rule.withinCap;
        throw new Error(`computeLongDatedHaircut: unhandled withinCap variant ${JSON.stringify(_exhaustive)}`);
      }

      // Post-cap is "zero" for every reachable code path.
      // `agency_cv_min` is gated upstream by resolveLongDatedObligation
      // (resolver-blocking warning when selected without per-position CV
      // ingestion); the engine asserts here as a defense-in-depth
      // invariant for hand-constructed inputs that bypass buildFromResolved.
      if (rule.postCap.type !== "zero") {
        throw new Error(
          "computeLongDatedHaircut invariant: postCap.agency_cv_min reached the engine; " +
          "resolver-blocking gate (resolveLongDatedObligation) should have refused this input.",
        );
      }
      haircut += l.survivingPar - withinCapValue;
    }
    return haircut;
  };

  // ── T=0 snapshot for N6 harness (determination-date compliance parity) ──
  // Computed BEFORE the period loop runs. Uses initial trancheBalances (no
  // mutations), initial pool par, initial principal cash, agency default
  // adjustments, and haircuts — equivalent to what the trustee reports as
  // of the determination date.
  const initialState: ProjectionInitialState = (() => {
    const poolPar = hasLoans ? loanTotal : initialPar;
    const ocEligibleAtStart = debtTranches.filter((t) => !t.isAmortising);

    // Pre-existing default OC adjustment — same formula as the in-loop version
    // at period q=1 (before any recovery arrives).
    const preExistingCashRecovery = preExistingDefaultRecovery + unpricedDefaultedPar * (recoveryPct / 100);
    const adjustedArrivalQ = Math.max(1, 1 + recoveryLagQ - quartersSinceReport);
    const preExistingRecoveryStillPending = preExistingDefaultedPar > 0 && 1 < adjustedArrivalQ;
    const ocDefaultAdjustment = (preExistingDefaultOcValue > 0 && preExistingRecoveryStillPending)
      ? preExistingDefaultOcValue - preExistingCashRecovery
      : 0;
    // Pending recoveries arriving at or before q=1 (zero at T=0 since we haven't elapsed any period yet)
    const pendingRecoveryValue = 0;
    // OC-numerator subtractor for un-drawn DDTL/revolver commitments. Sums
    // `undrawnCommitment` across all loans — independent of the
    // `isDelayedDraw` facility-type tag (a fully-drawn DDTL contributes 0
    // here because its undrawnCommitment is 0; a partial draw correctly
    // contributes the residual rather than the silently-discarded zero of
    // the pre-fix path).
    const currentDdtlUnfundedPar = hasLoans
      ? loanStates.reduce((s, l) => s + l.undrawnCommitment, 0)
      : 0;
    if (hasLoans) applyCureDispatch(loanStates, currentDate);
    const discountHaircutT0 = hasLoans ? computeDiscountHaircut(loanStates) : 0;
    // Long-dated haircut sourced from per-position dispatch. APB base =
    // Σ Principal Balance excluding undrawn DDTL commitments (per
    // Aggregate Principal Balance definition para (a)) — `poolPar`
    // already excludes DDTLs (loanTotal is built from
    // `loanStates.filter(!isDelayedDraw)`). CPA base adds Principal
    // Account cash (per Adjusted CPA definition para (d)). Helper
    // returns 0 when the rule is null.
    const apbBaseT0 = poolPar;
    const cpaBaseT0 = poolPar + initialPrincipalCash;
    const longDatedHaircutT0 = hasLoans
      ? computeLongDatedHaircut(loanStates, 0, longDatedValuationRule, apbBaseT0, cpaBaseT0)
      : 0;
    const ocNumerator = poolPar + initialPrincipalCash + pendingRecoveryValue + ocDefaultAdjustment
      - discountHaircutT0 - longDatedHaircutT0 - impliedOcAdjustment - currentDdtlUnfundedPar;

    const ocTests: ProjectionInitialState["ocTests"] = ocTriggersByClass.map((oc) => {
      const debtAtAndAbove = ocEligibleAtStart
        .filter((t) => t.seniorityRank <= oc.rank)
        .reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);
      const actual = debtAtAndAbove > 0 ? (ocNumerator / debtAtAndAbove) * 100 : 999;
      return { className: oc.className, actual, trigger: oc.triggerLevel, passing: actual >= oc.triggerLevel };
    });

    // At T=0, the trustee IC test uses [Interest Collection − Senior Expenses
    // (A-D) − Senior Mgmt Fee (E) − Hedge Payments (F)] / [Interest Due on
    // senior tranches]. Replicate with initial pool par × effective rate for
    // the numerator base, minus the quarterly fees. Fees use the same formula
    // as the in-loop per-period deduction so pre-fill parity flows through —
    // including taxes (A.i) and admin (C), which were missing pre-Sprint-3
    // and broke the KI-IC-AB/C/D cascade (closures of KI-08 and the taxes/issuerProfit upstream didn't
    // move observed drift because this computation wasn't deducting them).
    const scheduledInterestOnCollateral = poolPar * (wacSpreadBps / 10000 + baseRatePct / 100) / 4;
    const taxesAmountT0 = poolPar * (taxesBps / 10000) / 4;
    // Issuer Profit is a fixed € per period (not par-scaled), same
    // absolute value at T=0 as in the forward loop. Deducting at T=0 keeps
    // IC compositional parity aligned with the in-loop path.
    const issuerProfitAmountT0 = issuerProfitAmount;
    // VAT gross-up applied at construction (mirror the in-period site) so
    // both the cap test AND the IC compositional subtraction below see the
    // VAT-inclusive amount. Issuer pays gross to the recipient (recipient
    // gets net, tax authority gets VAT) — `trusteeFeeAmountT0` represents
    // cash leaving the issuer, which is gross.
    const vatGrossUpT0Pre =
      seniorExpensesCapVatIncluded && seniorExpensesCapVatRatePct != null
        ? 1 + seniorExpensesCapVatRatePct / 100
        : 1;
    const trusteeFeeAmountT0 = poolPar * (trusteeFeeBps / 10000) / 4 * vatGrossUpT0Pre;
    const adminFeeAmountT0 = poolPar * (adminFeeBps / 10000) / 4 * vatGrossUpT0Pre;
    const seniorFeeAmountT0 = poolPar * (seniorFeePct / 100) / 4;
    const hedgeCostAmountT0 = poolPar * (hedgeCostBps / 10000) / 4;
    // Fold the six per-T0 fee amounts into the canonical
    // SeniorExpenseBreakdown so a future senior expense (e.g. KI-02 step
    // (D) Expense Reserve top-up) auto-propagates here. The IC numerator
    // at T=0 uses REQUESTED amounts (parity with the normal-mode IC
    // numerator at the period loop), so trusteeOverflow / adminOverflow
    // are zero and the cap is not exercised at this site.
    const seniorExpenseBreakdownT0: SeniorExpenseBreakdown = {
      taxes: taxesAmountT0,
      issuerProfit: issuerProfitAmountT0,
      trusteeCapped: trusteeFeeAmountT0,
      adminCapped: adminFeeAmountT0,
      seniorMgmt: seniorFeeAmountT0,
      hedge: hedgeCostAmountT0,
      trusteeOverflow: 0,
      adminOverflow: 0,
    };
    const totalSeniorExpensesT0 = sumSeniorExpensesPreOverflow(seniorExpenseBreakdownT0);
    // PPM Condition 1, "Interest Coverage Amount" definition (paraphrased
    // and elided for brevity from the Ares Euro CLO XV final offering
    // circular, ll. 8951-9005; sub-paragraph labels follow the source's
    // labelling, which intentionally reuses (a)/(b) — verbatim text for
    // each sub-paragraph the engine consumes is quoted in full below):
    //   "Interest Coverage Amount" means, on any particular Measurement Date
    //   (without double counting), the sum of:
    //     (a) the Balance standing to the credit of the Interest Account;
    //     (b) plus the scheduled interest payments [...] due but not yet
    //         received [...] in the Due Period in which such Measurement Date
    //         occurs [...]
    //     [next-(a)] minus the amounts payable pursuant to paragraphs (A)
    //         through to (F) of the Interest Priority of Payments on the
    //         following Payment Date;
    //     [next-(b)] minus any of the above amounts that would be payable
    //         into the Interest Smoothing Account on the BD after the
    //         Determination Date at the end of the Due Period;
    //     (c) plus any amounts that would be payable from the Expense
    //         Reserve Account (only in respect of amounts that are not
    //         designated for transfer to the Principal Account), the First
    //         Period Reserve Account, the Interest Smoothing Account
    //         and/or the Currency Account to the Interest Account in the
    //         Due Period in which such Measurement Date falls (without
    //         double counting any such amounts which have been already
    //         transferred to the Interest Account).
    // Engine modeling — verified PPM citations:
    //   • paragraph (a): `initialInterestAccountCash`
    //   • paragraph (c) Smoothing: `initialInterestSmoothingBalance`
    //     (Condition 3(j)(xii) flushback BD after next Payment Date)
    //   • paragraph (c) Expense Reserve: `expenseReserveInflowT0` =
    //     min(reserve, max(0, requested - standardCap)) — the projected
    //     over-cap transfer per Condition 3(j)(x)(4) on PD-2BD
    //   • Supplemental routed to Interest only when disposition === "interest"
    //     (PPM 3(j)(vi)(B))
    //   • paragraph (c) First Period Reserve and Currency Account are NOT
    //     currently threaded as inputs — Euro XV reports zero on both.
    //     Resolver gates a non-zero opening balance on a future deal as a
    //     blocking extraction failure (`severity: "error"`) so the engine
    //     refuses to run rather than silently understate the IC numerator.
    // Two-component cap, same shape as the in-period cap construction below:
    // (a) absolute €/yr floor + (b) bps × pool par, both pro-rated. T=0 uses
    // the /4 flat quarterly approximation while the in-period path uses
    // precise dayFracActual; directionally consistent on stub first periods.
    // Floor term must apply at T=0 too — omitting it understates the cap by
    // `floorPerYear/4` and falsely drains the expense reserve into
    // `reserveContributionT0` → Q1 IC numerator. CPA-vs-APB dispatch: when
    // `seniorExpensesCapBaseMode === "CPA"`, the cap base augments by
    // `initialPrincipalCash` floored at zero (Principal Account balance at
    // the prior Determination Date). Component (a) day-count: /4 = 0.25 ≈
    // 30/360 exactly and ≈ Actual/360 on a 91-day quarter — the
    // approximation is directionally correct under either dispatch, so no
    // explicit branch here. Carryforward is empty at T=0 (no prior periods).
    // VAT gross-up applied symmetrically with the in-period site (per-bucket
    // at construction above; the sum here is already VAT-inclusive).
    const cpaAddendaT0 =
      seniorExpensesCapBaseMode === "CPA"
        ? Math.max(0, initialPrincipalCash) + Math.max(0, initialUnusedProceedsCash)
        : 0;
    const capAmountFromCapBpsT0 = seniorExpensesCapBps != null
      ? (poolPar + cpaAddendaT0) * (seniorExpensesCapBps / 10000) / 4
        + seniorExpensesCapAbsoluteFloorPerYear / 4
      : Infinity;
    const cappedRequestedT0 = trusteeFeeAmountT0 + adminFeeAmountT0;
    const expenseReserveInflowT0 = Math.min(
      initialExpenseReserveBalance,
      Math.max(0, cappedRequestedT0 - capAmountFromCapBpsT0),
    );
    const reserveContributionT0 =
      initialInterestAccountCash +
      initialInterestSmoothingBalance +
      expenseReserveInflowT0 +
      (supplementalReserveDisposition === "interest"
        ? initialSupplementalReserveBalance
        : 0);
    // Yield on the FOUR reserve accounts during Q1 (Interest, Smoothing,
    // Expense, Supplemental) — cash sits in the accounts and accrues at the
    // floored base rate regardless of which disposition the manager later
    // directs. Q1 in-loop adds the same term to `interestCollected` (see
    // the reserve-yield block at q===1). T=0 uses the /4 flat quarterly
    // approximation while Q1 uses the precise `dayFracActual` — directionally
    // consistent (both ~one-quarter), not numerically identical on stub
    // first periods.
    const reserveYieldBaseT0 =
      initialInterestAccountCash +
      initialInterestSmoothingBalance +
      initialExpenseReserveBalance +
      initialSupplementalReserveBalance;
    const flooredBaseRateT0 = Math.max(baseRatePct, baseRateFloorPct);
    const reserveYieldT0 = reserveYieldBaseT0 * flooredBaseRateT0 / 100 / 4;
    const interestAfterFeesT0 = Math.max(
      0,
      scheduledInterestOnCollateral + reserveContributionT0 + reserveYieldT0 - totalSeniorExpensesT0,
    );
    const icTests: ProjectionInitialState["icTests"] = icTriggersByClass.map((ic) => {
      const interestDueAtAndAbove = ocEligibleAtStart
        .filter((t) => t.seniorityRank <= ic.rank)
        .reduce((s, t) => s + trancheBalances[t.className] * trancheCouponRate(t, baseRatePct, baseRateFloorPct) / 4, 0);
      const actual = interestDueAtAndAbove > 0 ? (interestAfterFeesT0 / interestDueAtAndAbove) * 100 : 999;
      return { className: ic.className, actual, trigger: ic.triggerLevel, passing: actual >= ic.triggerLevel };
    });

    // B1 — Event of Default Par Value Test (PPM 10(a)(iv)) at T=0.
    // Compositional numerator, Class-A-only denominator. Runs only when the
    // resolver emitted a separately-tracked EoD test (post-B1 fixtures).
    let eodTest: EventOfDefaultTestResult | null = null;
    if (eventOfDefaultTest) {
      // loanStates carry per-position par + currentPrice; at T=0 none are
      // defaulted (pre-existing defaults are already extracted to
      // preExistingDefaultedPar/OcValue and excluded from the loan list).
      // computeEventOfDefaultTest gates on survivingPar > 0; un-drawn
      // DDTL/revolver commitments contribute zero implicitly.
      const eodLoanStates = loanStates.map((l) => ({
        survivingPar: l.survivingPar,
        isDefaulted: false, // per-position default state activates in B1 tier-2
        currentPrice: l.currentPrice,
      }));
      const classAPao = computeSeniorTranchePao(tranches, trancheBalances);
      eodTest = computeEventOfDefaultTest(
        eodLoanStates,
        initialPrincipalCash,
        classAPao,
        eventOfDefaultTest.triggerLevel,
      );
    }

    return {
      poolPar,
      ocNumerator,
      ocTests,
      icTests,
      eodTest,
      equityBookValue: bookValue,
      equityWipedOut,
      openingAccountBalances: {
        principalAccountCash: initialPrincipalCash,
        unusedProceedsCash: initialUnusedProceedsCash,
        interestAccountCash: initialInterestAccountCash,
        interestSmoothingBalance: initialInterestSmoothingBalance,
        supplementalReserveBalance: initialSupplementalReserveBalance,
        expenseReserveBalance: initialExpenseReserveBalance,
      },
      seniorExpensesCapAmountT0: capAmountFromCapBpsT0,
      seniorExpensesCapRequestedT0: cappedRequestedT0,
      reinvestmentPricePctApplied: reinvestmentPricePct,
      reinvestmentPriceSource,
    };
  })();

  // B2 — Post-acceleration mode flag. Persists across periods once set (PPM
  // Condition 10: acceleration irreversible without Class A supermajority,
  // which we model as permanent). Triggered by EoD breach at T=0 or in any
  // forward period. Flip happens AT the end of the breaching period, so the
  // NEXT period runs under acceleration.
  //
  // Two independent T=0 EoD checks:
  //   1. Compositional EoD (par-coverage test) via `initialState.eodTest`.
  //   2. PPM § 10(a)(i) interest-non-payment grace already exceeded at T=0
  //      via a seeded `priorShortfallCount` exceeding `eodGrace` on a
  //      rank-protected tranche. Without this check, a deal arriving with
  //      e.g. count=3 / grace=2 would silently run period 1 under pre-accel
  //      (which is wrong — the breach already occurred pre-projection).
  let isAccelerated =
    (initialState.eodTest !== null && !initialState.eodTest.passing) ||
    sortedTranches.some(
      (t) =>
        eodProtectedClassNames.has(t.className) &&
        (t.priorShortfallCount ?? 0) > eodGrace,
    );

  const draw: DefaultDrawFn = defaultDrawFn ?? ((par, hz) => par * hz);

  // Expense Reserve Account multi-period state. Per PPM Condition 3(j)(x)(4)
  // and Interest Priority of Payments steps (B) + (C), the Expense Reserve
  // Balance augments the Senior Expenses Cap each period: trustee/admin fees
  // can be paid up to `Senior Expenses Cap + expenseReserveBalance`, with
  // any draw above the standard cap draining the reserve. Carries forward
  // across periods until exhausted; deposits into the reserve via step (D)
  // are KI-02's scope (out of this PR), so the balance only decreases here.
  let expenseReserveBalance = initialExpenseReserveBalance;

  // Supplemental Reserve Account multi-period state under "hold" disposition.
  // Per PPM Condition 3(j)(vi)(G), the Balance is released to the Payment
  // Account for distribution under the Principal Priority of Payments or
  // the Post-Acceleration Priorities of Payment "(1) at the direction of
  // the Collateral Manager at any time prior to a Note Event of Default
  // or (2) automatically upon an acceleration of the Notes in accordance
  // with Condition 10(b) (Acceleration)". Modeling: the balance is held
  // until the projection's terminal event — either the maturity period
  // (manager-directed release at deal wind-up) or the first period running
  // under acceleration (automatic release per (G)(2)). After release the
  // balance is zeroed so subsequent periods contribute nothing. Under the
  // "principalCash" / "interest" dispositions the balance is consumed at
  // q=1 elsewhere; this state stays at 0 in those cases.
  let heldSupplementalReserveBalance =
    supplementalReserveDisposition === "hold" ? initialSupplementalReserveBalance : 0;

  // Senior Expenses Cap rolling carryforward state (PPM Condition 1
  // proviso (ii)). Each period's unused stated-cap headroom is appended;
  // the buffer is FIFO-trimmed to `seniorExpensesCapCarryforwardPeriods`
  // (Ares XV: 3 pre-FSE; 1 post-FSE — the engine doesn't model the FSE
  // window switch yet, so the static value carries throughout). The next
  // period's cap is augmented by Σ buffer. Inert when the field is null.
  // Mid-life projection seed: caller threads `seniorExpensesCapCarryforwardSeed`
  // populated from trustee history. Default empty — appropriate at deal
  // inception; latent under-count for mid-life projections that lack the
  // seed input.
  const capCarryforwardHistory: number[] = seniorExpensesCapCarryforwardSeed
    ? [...seniorExpensesCapCarryforwardSeed]
    : [];

  // Prior-Determination-Date Principal Account balance for the CPA cap
  // base. PPM Condition 1 component (b) bases the bps × CPA cap on CPA "as
  // at the Determination Date immediately preceding the Payment Date". For
  // q=1 this is the projection's opening `initialPrincipalCash`; for q≥2
  // it's the prior period's end-of-period principal account balance, which
  // can be non-zero when prelim cash exceeds debt available to pay down
  // (over-collateralised maturity periods, post-RP residuals after tranche
  // amortisation completes). Unused Proceeds Account balance is added at
  // q=1 only — the engine has no flow that mutates it across periods, so
  // q≥2 treats the balance as zero by construction. Floored at zero —
  // overdrafts do not credit CPA per PPM definition (a balance is the
  // signed amount; CPA contributions are a credit, not a debit).
  let priorPeriodEndPrincipalCash = initialPrincipalCash;
  for (let q = 1; q <= totalQuarters; q++) {
    const periodDate = periodEndDate(q);
    const inRP = rpEndDate ? new Date(periodDate) <= rpEndDate : false;
    const isMaturity = q === totalQuarters;
    // Snapshot interestShortfall at start of period so we can detect
    // whether THIS period accrued a shortfall (post − pre > 0) for
    // shortfallCount + EoD-on-shortfall gating. Only pre-accel mutates
    // interestShortfall via accrueShortfall; post-accel folds the prior
    // running balance into interestDueByTranche and resets to 0.
    const bopInterestShortfall: Record<string, number> = { ...interestShortfall };
    // §7.5 + decision R: pull this quarter's path map once and use it for
    // BOTH the bucket-map hazard (legacy / fallback branch of the per-loan
    // default loop) AND the per-bucket multiplier on the per-position WARF
    // branch. Calling `cdrMultiplierPathFn(q)` once per quarter — calling
    // it twice would duplicate-count `q` in observability tests and double
    // any side effects the caller might have.
    const cdrPathMapThisQuarter = cdrMultiplierPathFn ? cdrMultiplierPathFn(q) : null;
    const quarterlyHazard = cdrPathMapThisQuarter
      ? computeQuarterlyHazard(cdrPathMapThisQuarter)
      : quarterlyHazardConstant;
    // Per-bucket multiplier = path[bucket] / baseline[bucket]. Applied to
    // warfFactor-derived hazards. When baseline is zero (path non-zero),
    // the multiplier is undefined and we fall back to the path's bucket-map
    // hazard for that loan — matches the bucket-map branch's semantic.
    const cdrPathMultiplier = (() => {
      if (!cdrPathMapThisQuarter) return null;
      const out: Record<string, number> = {};
      for (const bucket of Object.keys(cdrPathMapThisQuarter)) {
        const baseline = defaultRatesByRating[bucket] ?? 0;
        if (baseline > 0) {
          out[bucket] = cdrPathMapThisQuarter[bucket] / baseline;
        } else {
          // Baseline 0 → multiplier undefined. Encode as Infinity sentinel;
          // the consumer below interprets this as "use bucket-map hazard".
          out[bucket] = cdrPathMapThisQuarter[bucket] > 0 ? Infinity : 1;
        }
      }
      return out;
    })();

    // B3 / §4.2: period accrual window. Default cadence is full quarters from
    // currentDate; with stubPeriod=true, period 1 is `currentDate → firstPeriodEndDate`
    // (partial quarter), and periods 2+ run as full quarters from firstPeriodEndDate.
    const periodStart = periodStartDate(q);
    const periodEnd = periodDate;
    const dayFracActual = dayCountFraction("actual_360", periodStart, periodEnd);
    const dayFrac30 = dayCountFraction("30_360", periodStart, periodEnd);
    const dayFrac30E = dayCountFraction("30e_360", periodStart, periodEnd);
    const dayFracActual365 = dayCountFraction("actual_365", periodStart, periodEnd);
    /** Per-convention cache. One lookup per loan/tranche per period. */
    const dayFracByConvention: Record<DayCountConvention, number> = {
      actual_360: dayFracActual,
      "30_360": dayFrac30,
      "30e_360": dayFrac30E,
      actual_365: dayFracActual365,
    };
    // Period fraction relative to a standard quarter (0.25 year). Used to
    // prorate quarterly hazard / prepay rates for stub periods. For full
    // quarters this is approximately 1.0 and would alter pinned hazards by
    // ~1% (90 vs 91 days); we therefore only enable proration when stub mode
    // is active to preserve byte-identical output on legacy fixtures.
    const periodFraction = dayFracActual / 0.25;
    const prorate = (rate: number): number =>
      useStub && q === 1 ? 1 - Math.pow(1 - rate, periodFraction) : rate;
    /** Day-count fraction for a given tranche this period. Reads the
     *  per-tranche convention extracted from `clo_tranches.day_count_convention`
     *  (canonicalized in resolver). Falls back to the legacy
     *  isFloating ? actual_360 : 30_360 default when undefined — preserves
     *  byte-identical output on legacy test fixtures whose synthetic tranches
     *  don't carry the field. */
    const trancheDayFrac = (t: ProjectionInputs["tranches"][number]): number =>
      t.dayCountConvention != null
        ? dayFracByConvention[t.dayCountConvention]
        : (t.isFloating ? dayFracActual : dayFrac30);

    // ── §4.3 balance instrumentation: capture defaulted-par at period start
    // BEFORE any per-period mutations so the conservation invariant holds.
    const beginningDefaultedPar = hasLoans
      ? loanStates.reduce((s, l) => s + l.defaultedParPending, 0)
      : 0;

    // ── 1. Beginning par ──────────────────────────────────────────
    // ── 1b. DDTL/revolver draw event (before beginningPar capture) ──────
    // Gates on `undrawnCommitment > 0` (the quantitative state), not on
    // `isDelayedDraw` (the facility-type tag — survives the draw). At the
    // configured drawQuarter we move `ddtlDrawPercent` of the un-drawn
    // notional into `survivingPar`; the (1 − ddtlDrawPercent) residual is
    // PRESERVED on `undrawnCommitment` rather than silently overwritten —
    // pre-fix the residual was discarded, dropping it from the OC subtractor
    // and any subsequent draw window. Spread is promoted to the parent-
    // facility ddtlSpread on the first draw that actually funds; subsequent
    // partial draws keep the same spread.
    if (hasLoans) {
      for (const loan of loanStates) {
        if (loan.undrawnCommitment <= 0) continue;
        if (q === loan.drawQuarter) {
          const drawn = loan.undrawnCommitment * (ddtlDrawPercent / 100);
          if (drawn > 0) {
            loan.survivingPar += drawn;
            loan.undrawnCommitment -= drawn;
            loan.spreadBps = loan.ddtlSpreadBps ?? loan.spreadBps;
          }
        }
      }
    }

    // Beginning par sums currently-funded balances. Un-drawn DDTL/revolver
    // commitments contribute zero (their notional sits on undrawnCommitment
    // and is captured separately by the OC subtractor).
    const beginningPar = hasLoans
      ? loanStates.reduce((s, l) => s + l.survivingPar, 0)
      : currentPar;
    const beginningLiabilities = debtTranches.reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);

    // ── Step-trace accumulators (for N1 harness) ────────────────────────
    // Multi-site values (OC cure diversions, reinv OC diversion, PIK accrual)
    // need accumulation across the period. Single-site fee amounts are captured
    // directly at emission.
    const _stepTrace_ocCureDiversions: Array<{ rank: number; mode: "reinvest" | "paydown"; amount: number }> = [];
    let _stepTrace_reinvOcDiversion = 0;
    let _stepTrace_classXAmortFromInterest = 0;
    const _amortFromInterestByTranche: Record<string, number> = {};
    for (const t of debtTranches) _amortFromInterestByTranche[t.className] = 0;
    const _stepTrace_deferredAccrualByTranche: Record<string, number> = {};
    for (const t of debtTranches) _stepTrace_deferredAccrualByTranche[t.className] = 0;

    // Per-loan beginning par for interest calc (post-draw, so newly-funded DDTLs are included)
    const loanBeginningPar = hasLoans ? loanStates.map((l) => l.survivingPar) : [];

    // ── 2. Per-loan maturities (before defaults — maturing loans pay at par) ──
    let totalMaturities = 0;
    if (hasLoans) {
      for (const loan of loanStates) {
        if (loan.survivingPar <= 0) continue;
        if (q === loan.maturityQuarter) {
          totalMaturities += loan.survivingPar;
          loan.survivingPar = 0;
        }
      }
    }

    // ── 3a. Drain defaulted-par-pending on loans whose recovery arrived
    //     this period. Cash flow is handled separately by the aggregate
    //     `recoveryPipeline`; this loop only updates the per-loan
    //     defaultedParPending so the EoD MV × PB component reflects current
    //     (not-yet-recovered) defaulted par at the end of this period.
    if (hasLoans) {
      for (const loan of loanStates) {
        if (loan.defaultEvents.length === 0) continue;
        const arrived = loan.defaultEvents.filter((e) => e.quarter <= q);
        const remaining = loan.defaultEvents.filter((e) => e.quarter > q);
        for (const e of arrived) {
          loan.defaultedParPending = Math.max(0, loan.defaultedParPending - e.defaultedPar);
        }
        loan.defaultEvents = remaining;
      }
    }

    // ── 3b. Per-loan defaults (only on non-maturing surviving loans) ──
    let totalDefaults = 0;
    const defaultsByRating: Record<string, number> = {};
    const loanDefaultEventsThisPeriod: PeriodResult["loanDefaultEvents"] = [];

    if (hasLoans) {
      for (let idx = 0; idx < loanStates.length; idx++) {
        const loan = loanStates[idx];
        // survivingPar <= 0 covers matured / liquidated loans AND un-drawn
        // DDTL/revolver commitments (notional on undrawnCommitment, no
        // funded leg to suffer a default).
        if (loan.survivingPar <= 0) continue;
        // Per-position hazard is the only path (Moody's CLO methodology).
        // Distinguishes Caa1 (factor 4770 ≈ 6.3% annual) from Caa3 (8070
        // ≈ 15.2% annual) which the bucket map averaged together as "CCC"
        // at 10.28%. UI bucket-CDR sliders that the user touches activate
        // `overriddenBuckets` to route those buckets through the bucket-map
        // branch so the slider value is consumed; un-touched buckets stay
        // on per-position WARF.
        const isBucketOverridden = overriddenBucketSet?.has(loan.ratingBucket) ?? false;
        let baseHazard: number;
        if (isBucketOverridden) {
          // Bucket-map branch — already path-aware via `quarterlyHazard`
          // recompute above.
          baseHazard = quarterlyHazard[loan.ratingBucket] ?? 0;
        } else {
          // Per-position WARF branch. Scale by cdrPathMultiplier when a
          // path is active; otherwise constant.
          const warfHazard = warfFactorToQuarterlyHazard(loan.warfFactor);
          if (cdrPathMultiplier == null) {
            baseHazard = warfHazard;
          } else {
            const m = cdrPathMultiplier[loan.ratingBucket] ?? 1;
            if (m === Infinity) {
              // Baseline 0, path non-zero — fall back to bucket-map path
              // hazard since the multiplier is undefined.
              baseHazard = quarterlyHazard[loan.ratingBucket] ?? 0;
            } else {
              baseHazard = warfHazard * m;
            }
          }
        }
        const hazard = prorate(baseHazard);
        const loanDefaults = draw(loan.survivingPar, hazard);
        loan.survivingPar -= loanDefaults;
        totalDefaults += loanDefaults;
        if (loanDefaults > 0) {
          defaultsByRating[loan.ratingBucket] = (defaultsByRating[loan.ratingBucket] ?? 0) + loanDefaults;
          const scheduledRecoveryQuarter = q + recoveryLagQ;
          // Per-position recovery rate from agency-supplied rates when
          // available, else fall back to the global model `recoveryPct`.
          // Asymmetry vs T=0: at the resolver's pre-existing-defaulted reduction
          // a third tier (currentPrice as recovered value) sits between agency
          // rates and 0; that tier does NOT apply here because at forward-
          // default-time `currentPrice` is a stale snapshot of a pre-default
          // performing loan, not a recovery proxy.
          // Reinvested-loan asymmetry: synthetic loans created at the four
          // reinvestment-synthesis sites carry no `recoveryRateAgency` and so
          // recover at the global `recoveryPct`. The agency-rate path needs
          // an extracted per-position rate, which a synthesized loan has no
          // source for at the moment of synthesis. Closing the asymmetry
          // would require a per-deal-PPM bucket→recovery mapping; CLAUDE.md
          // anti-pattern #1 ("don't overfit to a single deal") forbids
          // hardcoding a market-standard table without per-deal extraction.
          // Until that extraction lands, synthetic loans share the global
          // rate with the sensitivity slider's perturbation domain — the
          // slider therefore moves recoveries on synthesized + agency-rate-
          // missing loans only, not on agency-rate-covered original loans.
          const rate = loan.recoveryRateAgency ?? (recoveryPct / 100);
          const recoveredCash = loanDefaults * rate;
          // B1 Tier 2: track per-position defaulted par + scheduled recovery.
          loan.defaultedParPending += loanDefaults;
          loan.defaultEvents.push({ quarter: scheduledRecoveryQuarter, defaultedPar: loanDefaults });
          // Per-event push to recoveryPipeline (replaces the prior aggregate
          // push). One default → one event → one pipeline entry, with NO inner
          // gate on recoveredCash > 0 — Tier 1 identity (Σ defaultedPar ===
          // period.defaults) requires every default present even when its
          // recovery is zero. Sum-of-zeros is harmless at the consumer.
          recoveryPipeline.push({ quarter: scheduledRecoveryQuarter, amount: recoveredCash });
          loanDefaultEventsThisPeriod.push({
            loanIndex: idx,
            defaultedPar: loanDefaults,
            scheduledRecoveryQuarter,
            recoveryAmount: recoveredCash,
          });
        }
      }
    }

    // ── 4. Per-loan prepayments ─────────────────────────────────────
    let totalPrepayments = 0;
    if (hasLoans) {
      for (const loan of loanStates) {
        // survivingPar > 0 already excludes un-drawn DDTL/revolver
        // commitments (their notional sits on undrawnCommitment).
        if (loan.survivingPar > 0) {
          const prepay = loan.survivingPar * prorate(qPrepayRate);
          loan.survivingPar -= prepay;
          totalPrepayments += prepay;
        }
      }
    }

    // ── Aggregate ──────────────────────────────────────────────────
    let defaults: number;
    let prepayments: number;
    const scheduledMaturities = totalMaturities;
    if (hasLoans) {
      defaults = totalDefaults;
      prepayments = totalPrepayments;
    } else {
      // Fallback: apply aggregate CDR/CPR to currentPar.
      // Without loan-level data, weight toward non-zero buckets (AAA/AA at 0% would
      // dilute the average if included equally with B/CCC).
      const allRates = Object.values(defaultRatesByRating);
      const avgAnnualCdr = allRates.length > 0
        ? allRates.reduce((s, v) => s + v, 0) / allRates.length
        : 0;
      const qHazard = 1 - Math.pow(1 - Math.min(avgAnnualCdr, 99.99) / 100, 0.25);
      defaults = currentPar * prorate(qHazard);
      currentPar -= defaults;
      prepayments = currentPar * prorate(qPrepayRate);
      currentPar -= prepayments;

      if (defaults > 0 && recoveryPct > 0) {
        // No-loan-data fallback: aggregate-only emission. Does NOT push to
        // `loanDefaultEventsThisPeriod` because there are no per-loan events
        // to emit — the cross-path identity (`Σ event.recoveryAmount ===
        // period.recoveries`) is structurally inapplicable on this path, not
        // just untested. The B1 Tier 2 test gates on `hasLoans` accordingly.
        recoveryPipeline.push({ quarter: q + recoveryLagQ, amount: defaults * (recoveryPct / 100) });
      }
    }

    // ── 5. Recoveries ───────────────────────────────────────────
    const recoveries = isMaturity
      ? recoveryPipeline.filter((r) => r.quarter >= q).reduce((s, r) => s + r.amount, 0)
      : recoveryPipeline.filter((r) => r.quarter === q).reduce((s, r) => s + r.amount, 0);

    // ── 6. Interest collection ─────────────────────────────────
    // Cash leg per position. The cash interest path uses the existing
    // `all_in_rate` / `fixedCouponPct` from the loan, which (verified
    // against trustee transactions on Financiere) represents the cash
    // leg only — the PIK leg is additive and dispatched separately
    // below.
    //
    // PIK accretion: when `loan.pikSpreadBps > 0`,
    // additionally accretes `loanBegPar × (pikSpreadBps/10000) ×
    // dayFrac` to `loan.survivingPar`. ADDITIVE — never subtracts from
    // cash leg, never re-routes the existing accrual.
    //
    // Conventions pinned by synthetic tests in
    // `__tests__/asset-pik-accretion.test.ts`:
    //   - PIK accrues on PRE-default pre-maturity par (`loanBegPar`,
    //     captured at line ~2324 before steps 2–4 mutate
    //     `loan.survivingPar`). Matches the cash interest convention.
    //   - PIK adds to POST-default surviving par. A 50% partial default
    //     this period leaves the surviving 50% with the full period's
    //     PIK accretion accreted onto it. (Mirrors the cash leg, which
    //     accrues on pre-default par regardless of mid-period default.)
    //   - At maturity (q === loan.maturityQuarter), PIK accretion is
    //     SKIPPED — the loan is being redeemed; the principal payout
    //     captures the loan's pre-maturity par via step 2's
    //     `totalMaturities += loan.survivingPar` (run before the PIK
    //     loop). Skipping avoids zombie PIK on a zeroed surviving par
    //     and matches "PIK stops at redemption" trustee convention.
    //     Economic delta: one period of PIK once at end-of-life
    //     (~€12K once on Financiere at maturity Jul 2029).
    const flooredBaseRate = Math.max(baseRateFloorPct, baseRatePct);
    let interestCollected: number;
    if (hasLoans) {
      interestCollected = 0;
      for (let i = 0; i < loanStates.length; i++) {
        const loan = loanStates[i];
        const loanBegPar = loanBeginningPar[i];
        // Un-drawn DDTL/revolver commitments have loanBegPar=0 (their notional
        // sits on undrawnCommitment, not survivingPar) and contribute 0
        // interest; skip explicitly so the per-loan accrual block is a no-op.
        if (loanBegPar <= 0) continue;
        // Per-position accrual convention. Reads from
        // `clo_holdings.day_count_convention` via the resolver/canonicalizer.
        // Synthetic reinvestment loans carry no convention and fall back to
        // Actual/360 (market default for floating Euro paper).
        const loanDayFrac = loan.dayCountConvention != null
          ? dayFracByConvention[loan.dayCountConvention]
          : dayFracActual;
        if (loan.isFixedRate) {
          interestCollected += loanBegPar * (loan.fixedCouponPct ?? 0) / 100 * loanDayFrac;
        } else {
          // Per-position EURIBOR floor. Falls back to the deal-level
          // `baseRateFloorPct` when the loan carries no per-position floor.
          // Material in stress paths where EURIBOR drops below the per-loan
          // origination floor: a 0.5% floor on a position binds when EURIBOR
          // falls to 0.3%, and the engine accrues at 0.5% + spread instead
          // of 0.3% + spread. Pre-fix engine ignored per-loan floors and
          // applied the deal-level floor uniformly.
          const loanFlooredBase = Math.max(loan.floorRate ?? baseRateFloorPct, baseRatePct);
          interestCollected += loanBegPar * (loanFlooredBase + loan.spreadBps / 100) / 100 * loanDayFrac;
        }
        // Additive PIK accretion. Skip at maturity per the convention above.
        if (loan.pikSpreadBps != null && loan.pikSpreadBps > 0 && q !== loan.maturityQuarter) {
          const pikAccretion = loanBegPar * (loan.pikSpreadBps / 10000) * loanDayFrac;
          loan.survivingPar += pikAccretion;
        }
      }
      // Q1: initial principal cash earns interest at money market rate (~ESTR) for the quarter.
      // This cash sits in accounts before being reinvested or paid down.
      if (q === 1 && initialPrincipalCash > 0) {
        // Cash in principal accounts earns MMF/ESTR yield, not EURIBOR. Using the floored
        // base rate as a proxy — ESTR tracks ~10-15bps below 3M EURIBOR, immaterial here.
        interestCollected += initialPrincipalCash * flooredBaseRate / 100 * dayFracActual;
      }
      // Q1: yield on the four reserve account opening balances. PPM
      // Condition 3(j)(ii)(B) routes "all interest accrued in respect of
      // the Balances standing to the credit of the [non-Counterparty-
      // Downgrade] Accounts" into the Interest Account — same ESTR-proxy
      // rate as the Principal Account. The yield on the Supplemental
      // balance accrues regardless of the manager's eventual disposition
      // choice (cash sits in the account during the period until disposed).
      //
      // Q1: opening balances of the Interest Account and the Interest
      // Smoothing Account flow into `interestCollected` (PPM 3(j)(ii)(1):
      // "all Interest Proceeds standing to the credit of the Interest
      // Account shall be transferred to the Payment Account to the extent
      // required for disbursement pursuant to the Interest Priority of
      // Payments save for amounts deposited after the end of the related
      // Due Period and any amounts to be disbursed pursuant to (2) below
      // [collateral acquisition accrued interest] or amounts representing
      // any Hedge Issuer Tax Credit Payments to be disbursed pursuant to
      // (3) below"; the engine routes the full opening balance because
      // (i) the carve-outs are all zero or near-zero on Euro XV and
      // (ii) the residual is a fungible Interest Account balance against
      // the next-period IC numerator either way; PPM 3(j)(xii): Smoothing
      // Account flushed back to Interest Account on BD after the next
      // Payment Date). The Supplemental Reserve balance also routes here
      // when the user disposition is "interest" (PPM 3(j)(vi)(B)). All
      // three flow through the IC numerator (`interestAfterFees`) at line
      // ~2565 — PPM Condition 1's Interest Coverage Amount definition
      // (a) "the Balance standing to the credit of the Interest Account"
      // requires this. NOT credited to the OC numerator (Adjusted CPA per
      // Condition 1(d) limits account-cash credit to Principal Account +
      // Unused Proceeds Account).
      if (q === 1) {
        const suppToInterest =
          supplementalReserveDisposition === "interest"
            ? initialSupplementalReserveBalance
            : 0;
        const reserveBalanceContribution =
          initialInterestAccountCash +
          initialInterestSmoothingBalance +
          suppToInterest;
        const reserveYieldBase =
          initialInterestAccountCash +
          initialInterestSmoothingBalance +
          initialExpenseReserveBalance +
          initialSupplementalReserveBalance;
        if (reserveBalanceContribution > 0) {
          interestCollected += reserveBalanceContribution;
        }
        if (reserveYieldBase > 0) {
          interestCollected += reserveYieldBase * flooredBaseRate / 100 * dayFracActual;
        }
      }
    } else {
      const allInRate = (flooredBaseRate + wacSpreadBps / 100) / 100;
      interestCollected = beginningPar * allInRate * dayFracActual;
    }

    // ── 7. Reinvestment ─────────────────────────────────────────
    // No reinvestment on the final period (call or maturity) — the deal is winding down.
    let reinvestment = 0;
    const principalProceeds = prepayments + scheduledMaturities + recoveries;
    // Q1: initial principal cash (uninvested proceeds already in accounts) treated as
    // additional principal proceeds — reinvested during RP, flows to paydown outside RP.
    // Policy: during RP, cash IS reinvested (manager has discretion to deploy).
    // Post-RP, cash goes to paydown only — the indenture restricts reinvestment to new
    // principal proceeds from the portfolio, not pre-existing account balances.
    //
    // Supplemental Reserve opening balance (PPM Condition 3(j)(vi)) joins
    // the q1Cash bucket only when the user disposition is "principalCash"
    // (default — mirrors manager-incentive-aligned canonical case). The
    // "interest" disposition routes the balance into Q1 `availableInterest`
    // separately (handled at the interest-waterfall opening below); the
    // "hold" disposition keeps the balance held in `heldSupplementalReserveBalance`
    // (no Q1 cash effect) until the terminal release per Condition
    // 3(j)(vi)(G) at maturity or upon acceleration — handled below.
    const q1SuppToPrincipal =
      q === 1 && supplementalReserveDisposition === "principalCash"
        ? initialSupplementalReserveBalance
        : 0;
    // PPM Condition 3(j)(vi)(G) terminal release. Under "hold" disposition
    // the held balance is released to the Payment Account at maturity (1)
    // or upon acceleration (2). Released amount routes through the
    // Principal Priority of Payments via `prelimPrincipal` (normal path)
    // or pools into `totalCashUnderAccel` (post-accel path). Fires at most
    // once per projection — `heldSupplementalReserveBalance` is zeroed on
    // release so subsequent periods contribute nothing.
    let suppReserveTerminalRelease = 0;
    if (heldSupplementalReserveBalance > 0 && (isMaturity || isAccelerated)) {
      suppReserveTerminalRelease = heldSupplementalReserveBalance;
      heldSupplementalReserveBalance = 0;
    }
    const q1Cash = (q === 1) ? initialPrincipalCash + q1SuppToPrincipal : 0;
    const totalPrincipalAvailable = principalProceeds + q1Cash + suppReserveTerminalRelease;
    if (!isMaturity && inRP) {
      reinvestment = totalPrincipalAvailable;
    } else if (!isMaturity && postRpReinvestmentPct > 0 && principalProceeds > 0) {
      // Post-RP limited reinvestment (credit improved/risk sales, unscheduled principal)
      reinvestment = principalProceeds * (postRpReinvestmentPct / 100);
    }
    // C1 — Reinvestment compliance enforcement. The single gate
    // `maxCompliantReinvestment` applies all four triggers in turn (WARF,
    // Min WAS, Moody's Caa, Fitch CCC) and returns the most-restrictive
    // boundary. The blocked portion falls through to the principal
    // waterfall for senior paydown.
    let reinvestmentBlockedCompliance = 0;
    const anyComplianceTriggerActive =
      moodysWarfTriggerLevel != null ||
      minWasBpsTrigger != null ||
      moodysCaaLimitPctTrigger != null ||
      fitchCccLimitPctTrigger != null;
    if (reinvestment > 0 && hasLoans && anyComplianceTriggerActive) {
      const allowed = maxCompliantReinvestment(q, reinvestment);
      if (allowed < reinvestment) {
        reinvestmentBlockedCompliance = reinvestment - allowed;
        reinvestment = allowed;
      }
    }
    if (reinvestment > 0 && hasLoans) {
      const matQ = q + reinvestmentTenorQuarters;
      // `reinvestment` is the cash amount; par bought at the assumed
      // reinvestment price. avgLoanSize is a CASH ceiling (matches the
      // pool's dollar-weighted typical position size); the per-loan
      // `survivingPar` is the cash chunk × 1/(price/100). Sub-threshold
      // purchases set isDiscountObligation true at synthesis time so
      // the per-period haircut Σ correctly deducts on the next
      // determination date.
      const isLongDatedSynth = matQ > totalQuarters;
      const synthCommonFields = {
        ratingBucket: reinvestmentRating,
        spreadBps: reinvestmentSpreadBps,
        warfFactor: reinvestmentWarfFactor,
        maturityQuarter: matQ,
        isFixedRate: reinvIsFixedRate,
        isDelayedDraw: false,
        undrawnCommitment: 0,
        defaultedParPending: 0,
        defaultEvents: [],
        purchasePricePct: reinvestmentPricePct,
        acquisitionDate: periodDate,
        isDiscountObligation: reinvIsSubThreshold,
        isLongDated: isLongDatedSynth,
      };
      if (avgLoanSize > 0 && reinvestment > avgLoanSize * 1.5) {
        let remaining = reinvestment;
        while (remaining > 0) {
          const cashChunk = Math.min(avgLoanSize, remaining);
          loanStates.push({ survivingPar: cashChunk * (100 / reinvestmentPricePct), ...synthCommonFields });
          remaining -= cashChunk;
        }
      } else {
        loanStates.push({ survivingPar: reinvestment * (100 / reinvestmentPricePct), ...synthCommonFields });
      }
    }

    // Update currentPar / endingPar from currently-drawn balances.
    // Un-drawn DDTL/revolver commitments contribute zero implicitly via
    // survivingPar=0; their notional is captured separately on the OC
    // subtractor (Σ undrawnCommitment).
    if (hasLoans) {
      currentPar = loanStates.reduce((s, l) => s + l.survivingPar, 0);
    } else {
      if (reinvestment > 0) {
        currentPar += reinvestment;
      }
    }

    let endingPar = hasLoans
      ? loanStates.reduce((s, l) => s + l.survivingPar, 0)
      : currentPar;

    // ── 8. Preliminary principal paydown ─────────────────────────
    // Pay down tranches from principal proceeds BEFORE computing OC
    // tests so the ratios use post-paydown liability balances. This
    // avoids a false OC breach at the RP boundary where par drops
    // (no reinvestment) but liabilities haven't been reduced yet.
    //
    // IMPORTANT: Save BOP tranche balances first — interest DUE and
    // IC tests must use beginning-of-period balances since interest
    // accrues on the balance before any principal paydown.
    //
    // C3 — Senior Expenses Cap at steps (B) + (C):
    //   Trustee fee (B) + Admin expenses (C) jointly capped at
    //   `seniorExpensesCapBps` × beginningPar × dayFrac. Capped portion is
    //   paid up-front as part of senior expenses; any overflow defers to
    //   PPM step (Y) trustee-overflow and (Z) admin-overflow, which pay
    //   from residual interest AFTER tranche interest + sub mgmt fee.
    //   When the cap isn't set (undefined), expenses emit uncapped —
    //   legacy / synthetic-test behaviour.
    // Step (A)(i) Issuer taxes. Deducted before trustee fees per PPM.
    const taxesAmount = beginningPar * (taxesBps / 10000) * dayFracActual;
    // Step (A)(ii) Issuer Profit Amount. Fixed absolute € per period
    // (PPM Condition 1 definitions — €250 regular, €500 post-Frequency-Switch).
    // Deducted immediately after taxes and before trustee fees. Not
    // day-count adjusted (fixed amount per waterfall event, not an accrual).
    const issuerProfitPaid = issuerProfitAmount;
    // VAT inclusion (PPM proviso (i)): when fee inputs are net-of-VAT and
    // `vatRatePct` is set, gross up the per-bucket requested amounts so
    // both the cap comparison and the per-bucket overflow allocation see
    // VAT-inclusive amounts. The engine's `trusteeFeeBps` / `adminFeeBps`
    // typically come from `defaultsFromResolved` which back-derives from
    // waterfall step B/C amounts paid (gross-of-VAT under BNY trustee
    // convention) — `vatRatePct: null` is the default and produces no
    // gross-up. Hand-set net-of-VAT inputs set vatRatePct explicitly.
    const vatGrossUp =
      seniorExpensesCapVatIncluded && seniorExpensesCapVatRatePct != null
        ? 1 + seniorExpensesCapVatRatePct / 100
        : 1;
    const trusteeFeeRequested =
      beginningPar * (trusteeFeeBps / 10000) * dayFracActual * vatGrossUp;
    const adminFeeRequested =
      beginningPar * (adminFeeBps / 10000) * dayFracActual * vatGrossUp;
    const cappedRequested = trusteeFeeRequested + adminFeeRequested;
    // Expense Reserve cap-augmentation per PPM Condition 3(j)(x)(4): trustee
    // (B) and admin (C) fees can be paid up to `cap + expenseReserveBalance`.
    // The opening cap (PPM-defined Senior Expenses Cap) and the augmentation
    // are separate: cappedPaid above the opening cap drains the reserve
    // pro-tanto; the rest still routes to Y/Z overflow. Reserve balance is
    // floored at zero by the PPM ("shall not cause the balance of the
    // Expense Reserve Account to fall below zero").
    // PPM Senior Expenses Cap: two-component cap per OC Condition 1 —
    // (a) absolute fixed €/yr floor + (b) bps × CPA. Ares XV: (a) €300K p.a.
    // + (b) 2.5 bps. Component (b) is always Actual/360. Component (a)
    // dispatches on `seniorExpensesCapComponentADayCount`: when
    // "30_360_after_first" + not the deal's first PD, accrue at 30/360
    // (PPM proviso (a)(y)); else Actual/360. Cap base dispatches on
    // `seniorExpensesCapBaseMode`: when "CPA", augment by Principal
    // Account balance at the prior Determination Date. q=1 sources from
    // `initialPrincipalCash`; q>=2 the engine has fully consumed prior-
    // period principal cash via reinvestment / paydown so the addendum
    // is zero by construction. Floored at zero — overdrafts do not credit
    // CPA. Cap is augmented by Σ unused-headroom from the trailing N PDs
    // (PPM proviso (ii)) when `seniorExpensesCapCarryforwardPeriods` > 0.
    // When `seniorExpensesCapBps` is undefined the cap is uncapped (legacy
    // synthetic-test behavior); the absolute floor alone never produces
    // an Infinity cap, so the `null bps → Infinity` sentinel is preserved.
    // PPM proviso (a)(x) fires on the deal's first PD only. The projection's
    // q=1 IS the deal's first PD when (a) firstPaymentDate is set and (b)
    // currentDate is strictly before it — q=1 then runs from currentDate to
    // currentDate + 1Q ≈ firstPaymentDate, which is the first PD. On
    // currentDate === firstPaymentDate, q=1's payment date is the SECOND
    // PD (firstPaymentDate + 1Q), so (a)(y) 30/360 applies. Null
    // firstPaymentDate → mid-life by convention (engine has no anchor to
    // distinguish first PD from any other), so 30/360.
    const isFirstPdOfDeal =
      q === 1 && firstPaymentDate != null && currentDate < firstPaymentDate;
    const componentADayFrac =
      seniorExpensesCapComponentADayCount === "30_360_after_first" && !isFirstPdOfDeal
        ? dayFrac30
        : dayFracActual;
    const cpaAddenda =
      seniorExpensesCapBaseMode === "CPA"
        ? Math.max(0, priorPeriodEndPrincipalCash) +
          (q === 1 ? Math.max(0, initialUnusedProceedsCash) : 0)
        : 0;
    const carryforwardSum =
      seniorExpensesCapCarryforwardPeriods != null && seniorExpensesCapCarryforwardPeriods > 0
        ? capCarryforwardHistory.reduce((s, h) => s + h, 0)
        : 0;
    const capAmountFromCapBps = seniorExpensesCapBps != null
      ? (beginningPar + cpaAddenda) * (seniorExpensesCapBps / 10000) * dayFracActual
        + seniorExpensesCapAbsoluteFloorPerYear * componentADayFrac
        + carryforwardSum
      : Infinity;
    const capAmount = capAmountFromCapBps + expenseReserveBalance;
    const cappedPaid = Math.min(cappedRequested, capAmount);
    const cappedOverflowTotal = cappedRequested - cappedPaid;
    // Carryforward bookkeeping: each period contributes
    // `max(0, statedCap - cappedPaid)` to the FIFO ring buffer. The
    // "stated Senior Expenses Cap" per PPM is the bps + floor amount —
    // expense-reserve and carryforward augmentations are NOT part of the
    // stated cap (they are explicit augmentation mechanisms that don't
    // reduce next period's headroom contribution). Buffer is FIFO-trimmed
    // to `seniorExpensesCapCarryforwardPeriods` so future periods see at
    // most N preceding contributions.
    if (
      seniorExpensesCapCarryforwardPeriods != null &&
      seniorExpensesCapCarryforwardPeriods > 0 &&
      seniorExpensesCapBps != null
    ) {
      const statedCap =
        (beginningPar + cpaAddenda) * (seniorExpensesCapBps / 10000) * dayFracActual
        + seniorExpensesCapAbsoluteFloorPerYear * componentADayFrac;
      const usedAgainstStated = Math.min(cappedPaid, statedCap);
      capCarryforwardHistory.push(Math.max(0, statedCap - usedAgainstStated));
      while (capCarryforwardHistory.length > seniorExpensesCapCarryforwardPeriods) {
        capCarryforwardHistory.shift();
      }
    }
    // Drain bookkeeping deferred to the senior-expense waterfall site —
    // the reserve PHYSICALLY transfers cash to the Interest Account before
    // the helper consumes the augmented pool (Condition 3(j)(x)(4)
    // "second Business Day prior to each Payment Date"), so the drain
    // equals the transfer amount, not a post-hoc accounting subtraction.
    // Initialized to zero here; mutated below where `availableInterest`
    // is augmented and the helper consumes the augmented pool. Gated on
    // !isAccelerated — under acceleration the engine runs the Post-
    // Acceleration Priority of Payments via `runPostAccelerationWaterfall`,
    // which has its OWN cap-removal proviso at steps (B)+(C): "provided
    // that following an acceleration of the Notes pursuant to Condition
    // 10(b) (Acceleration) [...] the Senior Expenses Cap shall not apply"
    // (PPM ll. 14167-14177). The cap-augmentation mechanism does not
    // apply in that branch — the post-accel executor pays trustee/admin
    // uncapped from the pooled interest+principal stream. (PPM Condition
    // 3(c)(i)(B)+(C) carries an analogous proviso for pre-acceleration
    // EoD, but the engine's `isAccelerated=true` corresponds to the
    // post-acceleration state, not pre-accel-with-EoD.)
    let expenseReserveDraw = 0;
    // B/C in-cap allocation per PPM Condition 3(c). Ares XV's
    // OC clause (C) reads "less any amounts paid pursuant to paragraph (B)
    // above" → trustee fees consume cap headroom first; admin gets the
    // remainder. The legacy "pro_rata" branch is preserved for any deal
    // whose PPM specifies pari-passu (or for fixtures that explicitly set
    // it for backward compatibility), dispatched via the resolved field.
    let trusteeFeeAmount: number;
    let adminFeeAmount: number;
    if (seniorExpensesCapAllocationWithinCap === "sequential_b_first") {
      trusteeFeeAmount = Math.min(trusteeFeeRequested, capAmount);
      adminFeeAmount = Math.min(adminFeeRequested, Math.max(0, capAmount - trusteeFeeAmount));
    } else {
      const cappedRatio = cappedRequested > 0 ? cappedPaid / cappedRequested : 0;
      trusteeFeeAmount = trusteeFeeRequested * cappedRatio;
      adminFeeAmount = adminFeeRequested * cappedRatio;
    }
    // Overflow per bucket (for emission at steps Y/Z) is the bucket-level
    // residual under either rule: requested minus paid-into-cap.
    const trusteeOverflowRequested = trusteeFeeRequested - trusteeFeeAmount;
    const adminOverflowRequested = adminFeeRequested - adminFeeAmount;

    // PPM Step E: Senior collateral management fee (NOT capped).
    const seniorFeeAmount = beginningPar * (seniorFeePct / 100) * dayFracActual;
    // PPM Step F: Hedge payments (NOT capped).
    const hedgeCostAmount = beginningPar * (hedgeCostBps / 10000) * dayFracActual;
    // Single canonical breakdown drives BOTH the IC numerator (via
    // sumSeniorExpensesPreOverflow) AND the cash-flow chain (via
    // applySeniorExpensesToAvailable below). Trustee/admin overflow at
    // steps Y/Z is computed separately on residual interest after tranche
    // interest, so it's set later (see `trusteeOverflowPaid` block).
    //
    // Consumer asymmetry (intentional, do not "fix"): the IC numerator
    // below uses requested (`sumSeniorExpensesPreOverflow(seniorExpenseBreakdown)`)
    // while stepTrace emission uses paid (the `paid` return of
    // applySeniorExpensesToAvailable). The IC denominator at the IC test
    // below is contractual interest due (par × coupon × dayfrac, not
    // actually-paid tranche interest), so the numerator is contractual for
    // dimensional symmetry — IC is a forward-looking compliance ratio of
    // contractual obligations, not a backward-looking cash report. This
    // matches the canonical CLO-market reading of IC tests.
    //
    // Caveat: PPM language varies. A deal whose PPM explicitly defines
    // the IC numerator as "Interest Proceeds minus actually-paid senior
    // expenses" would require switching the consumer to `paid`. We have
    // not verified Euro XV's specific PPM clause; on portability to a
    // new deal, re-confirm the IC definition and adjust if needed.
    //
    // Numerical equivalence under the floor at the next line means the
    // output is identical today; the comment is documentation-only for
    // now, but flips to load-bearing the moment either the floor is
    // removed (see comment there) or a per-deal IC definition diverges.
    const seniorExpenseBreakdown: SeniorExpenseBreakdown = {
      taxes: taxesAmount,
      issuerProfit: issuerProfitPaid,
      trusteeCapped: trusteeFeeAmount,
      adminCapped: adminFeeAmount,
      seniorMgmt: seniorFeeAmount,
      hedge: hedgeCostAmount,
      trusteeOverflow: 0,
      adminOverflow: 0,
    };
    const totalSeniorExpenses = sumSeniorExpensesPreOverflow(seniorExpenseBreakdown);
    // PPM Condition 1 paragraph (c) Expense Reserve inflow — the projected
    // over-cap transfer per Condition 3(j)(x)(4). Computed here (before the
    // IC numerator) so both the IC numerator AND the cash-flow path (which
    // mutates `availableInterest` and `expenseReserveBalance` at the helper
    // site below) consume the SAME value. T=0 IC carries the same term
    // (`expenseReserveInflowT0`); per-period parity requires this to be
    // included in `interestAfterFees`. Gated on !isAccelerated mirroring
    // the cap-suppression branch.
    const expenseReserveTransferToInterest = !isAccelerated
      ? Math.min(
          expenseReserveBalance,
          Math.max(0, cappedRequested - capAmountFromCapBps),
        )
      : 0;
    // The Math.max(0, …) floor here is load-bearing for the requested-vs-paid
    // equivalence noted above: under stress where requested > available, paid
    // = available (truncated by the helper), so available − paid = 0; without
    // this floor, available − requested would go negative and the two
    // formulations would diverge in the IC numerator. If you remove the
    // floor (e.g., to throw on < 0 as a stricter invariant), the IC consumer
    // must switch to `seniorExpensesApplied.paid` to preserve the equivalence.
    const interestAfterFees = Math.max(
      0,
      interestCollected + expenseReserveTransferToInterest - totalSeniorExpenses,
    );

    const bopTrancheBalances: Record<string, number> = {};
    for (const t of debtTranches) {
      bopTrancheBalances[t.className] = trancheBalances[t.className];
    }

    // Post-v6 plan §4.1: when manager call fires (callActive), liquidate per
    // callPriceMode. When the projection reaches legal final without a call,
    // loans redeem at par. Aggregate-mode deals (no loan list) under manual
    // mode fall back to endingPar × callPricePct/100; under par/market modes
    // the aggregate fallback is endingPar at face value (no per-position info
    // to apply market prices to). The "market without loans" combination is
    // not supported — runProjection's pre-period validation should catch.
    const liquidationProceeds = isMaturity
      ? (callActive
          ? (hasLoans
              ? computeCallLiquidation(loanStates, callPricePct, callPriceMode)
              : callPriceMode === "manual"
                ? endingPar * (callPricePct / 100)
                : endingPar)
          : endingPar)
      : 0;
    let prelimPrincipal = prepayments + scheduledMaturities + recoveries + q1Cash + suppReserveTerminalRelease - reinvestment + liquidationProceeds;
    if (prelimPrincipal < 0) prelimPrincipal = 0;

    // B2 — Post-acceleration branch. If the prior period triggered EoD
    // (isAccelerated set at end of period q-1), pool interest + principal
    // into a single cash stream and distribute through POST_ACCEL_SEQUENCE.
    // Senior expenses uncapped, rated tranches P+I sequential (Class A first,
    // then B pari passu, then C/D/E/F), sub fees and incentive only if
    // rated notes fully retired, residual to Sub Noteholders. Deferred
    // interest under acceleration is NOT PIKed — unpaid interest is a
    // shortfall captured in the executor's output for diagnostic visibility.
    if (isAccelerated) {
      const totalCashUnderAccel = interestCollected + prelimPrincipal;

      // Interest due per tranche from BOP balances × coupon × day-count fraction,
      // PLUS any pre-acceleration carried shortfall on non-deferrable tranches.
      // Once accelerated, prior-period unpaid interest becomes part of the
      // accelerated interest claim — losing it on the handoff would silently
      // discharge the obligation and overstate residual cash.
      const interestDueByTranche: Record<string, number> = {};
      for (const t of debtTranches) {
        const baseDue =
          bopTrancheBalances[t.className] * trancheCouponRate(t, baseRatePct, baseRateFloorPct) * trancheDayFrac(t);
        interestDueByTranche[t.className] = baseDue + (interestShortfall[t.className] ?? 0);
      }
      // Reset pre-accel carry now that it's been folded into the accelerated
      // claim — post-accel tracks its own period shortfall in accelResult.
      // Scope MUST mirror `accrueShortfall`'s write predicate (non-amortising
      // non-income debt) — anything else is a no-op today (amortising and
      // income tranches never accrue) and a latent trap if a future change
      // routes amortising-tranche shortfall through this state.
      //
      // INVARIANT: this reset must occur BEFORE the EoD-on-shortfall
      // detector reads `interestShortfall`. The current detector at the
      // pre-accel emit site is gated `if (!isAccelerated)` — so the
      // post-accel branch never reaches the detector. If that gate is
      // ever relaxed (e.g., to detect a secondary EoD condition under
      // acceleration), the reset here would have already cleared the
      // value and `delta = end - bop` would always be ≤ 0, silently
      // disabling the detector. Preserve the gate, or move the reset.
      for (const t of debtTranches) {
        if (!t.isAmortising) interestShortfall[t.className] = 0;
      }

      // Sub mgmt fee amount (same formula as normal mode, subject to cash).
      const subFeeAmountUnderAccel = beginningPar * (subFeePct / 100) * dayFracActual;

      const accelResult = runPostAccelerationWaterfall({
        totalCash: totalCashUnderAccel,
        tranches,
        trancheBalances,
        deferredBalances,
        // Post-Acceleration Priority of Payments steps (B)+(C) proviso
        // (PPM ll. 14167-14177): "provided that following an acceleration
        // of the Notes pursuant to Condition 10(b) (Acceleration) [...]
        // the Senior Expenses Cap shall not apply". Trustee + admin fees
        // pay uncapped at steps (B) and (C) directly, with no Y/Z overflow
        // deferral — so the full requested amount sits in the cap-eligible
        // field and `trusteeOverflow` / `adminOverflow` are zero. KI-12a
        // fee-base discrepancy on `seniorMgmt` (beginningPar vs prior
        // Determination Date ACB) inherited from normal mode.
        seniorExpenses: {
          taxes: taxesAmount,
          issuerProfit: issuerProfitPaid,
          trusteeCapped: trusteeFeeRequested,
          adminCapped: adminFeeRequested,
          seniorMgmt: seniorFeeAmount,
          hedge: hedgeCostAmount,
          trusteeOverflow: 0,
          adminOverflow: 0,
        },
        interestDueByTranche,
        subMgmtFee: subFeeAmountUnderAccel,
        // PPM Acceleration POP step (V): incentive fee gated on cumulative
        // Sub Note IRR. Pass the live `equityCashFlows` accumulator —
        // already contains pre-breach distributions + earlier accel-mode
        // residuals; does NOT yet contain this period's residual (the
        // executor adds it as the next inflow before running the IRR test).
        priorEquityCashFlows: equityCashFlows,
        incentiveFeeHurdleIrr,
        periodsPerYear: 4, // KI-04 — third literal-4 call site (alongside the two normal-mode sites at the incentive-fee solver calls); deal-cadence-derive when Frequency Switch lands.
        incentiveFeePct,
      });

      // Apply post-executor tranche balances.
      for (const d of accelResult.trancheDistributions) {
        const origPrincipal = trancheBalances[d.className];
        // Principal portion is deducted from trancheBalances; deferred stays
        // put (no PIK under acceleration, no cure-type drains either).
        trancheBalances[d.className] = Math.max(0, origPrincipal - d.principalPaid);
      }

      const endingLiabilitiesAccel = debtTranches.reduce(
        (s, t) => s + trancheBalances[t.className] + deferredBalances[t.className],
        0,
      );
      const equityDistributionAccel = accelResult.residualToSub;
      totalEquityDistributions += equityDistributionAccel;
      equityCashFlows.push(equityDistributionAccel);

      // §4.3 balance instrumentation (post-acceleration branch).
      const endingDefaultedParAccel = hasLoans
        ? loanStates.reduce((s, l) => s + l.defaultedParPending, 0)
        : 0;
      const endingUndrawnCommitmentAccel = hasLoans
        ? loanStates.reduce((s, l) => s + l.undrawnCommitment, 0)
        : 0;

      periods.push({
        periodNum: q,
        date: periodDate,
        beginningPar,
        beginningPerformingPar: beginningPar,
        endingPerformingPar: endingPar,
        beginningDefaultedPar,
        endingDefaultedPar: endingDefaultedParAccel,
        endingUndrawnCommitment: endingUndrawnCommitmentAccel,
        beginningPrincipalAccount: 0,
        endingPrincipalAccount: 0,
        beginningInterestAccount: 0,
        endingInterestAccount: 0,
        defaults,
        prepayments,
        scheduledMaturities,
        recoveries,
        principalProceeds: prepayments + scheduledMaturities + recoveries,
        reinvestment: 0,
        endingPar,
        interestCollected,
        beginningLiabilities,
        endingLiabilities: endingLiabilitiesAccel,
        trancheInterest: accelResult.trancheDistributions.map((d) => ({
          className: d.className,
          due: d.interestDue,
          paid: d.interestPaid,
        })),
        tranchePrincipal: accelResult.trancheDistributions.map((d) => ({
          className: d.className,
          paid: d.principalPaid,
          // Acceleration: amortising tranches are excluded from the accel
          // waterfall (`runPostAccelerationWaterfall` filters !isAmortising).
          // Step-G amort lane doesn't apply post-breach. Zero per the
          // stepTrace.classXAmortFromInterest = 0 invariant.
          paidFromInterest: 0,
          endBalance: d.endBalance,
        })),
        // Pre-acceleration cumulative carry was folded into
        // `interestDueByTranche` at the handoff (line ~2163) and reset to
        // 0; the field's cumulative-carry semantic is consistent across
        // accel/pre-accel by emitting empty here. Post-accel per-period
        // unpaid lives on its own field below.
        interestShortfall: {},
        // Per-period unpaid interest from the accelerated waterfall.
        // Distinct semantic from `interestShortfall` (cumulative pre-accel
        // carry) — populated only under acceleration.
        perPeriodInterestShortfall: { ...accelResult.perPeriodInterestShortfall },
        // Counter is frozen under post-acceleration (no longer mutated).
        // Emit empty so consumers iterating across periods don't see
        // stale counter values from the breach period.
        interestShortfallCount: {},
        // OC / IC / EoD tests emitted empty under acceleration — PPM-correct,
        // not a deferred simplification. The class-level OC/IC cure mechanics
        // don't apply post-acceleration: coverage-test diversions only fire
        // during normal operations to keep the deal out of distress. Once
        // accelerated, the waterfall just pays down rated notes sequentially
        // and those tests stop gating cash flow. Same for EoD — the condition
        // already triggered; further checks are moot until acceleration is
        // rescinded (which we model as never).
        ocTests: [],
        icTests: [],
        eodTest: null,
        isAccelerated: true,
        loanDefaultEvents: loanDefaultEventsThisPeriod,
        equityDistribution: equityDistributionAccel,
        defaultsByRating,
        stepTrace: {
          // Post-Acceleration Priority of Payments steps (B)+(C) proviso
          // citing Condition 10(b) (PPM ll. 14167-14177) suppresses the
          // Senior Expenses Cap, so trustee + admin pay directly at the
          // post-accel steps (B)+(C) uncapped, with no overflow deferral
          // to (Y)/(Z). Each step emits its own bucket so
          // the N1 harness compares B vs B and C vs C — the B2 regression
          // guard asserts adminFeesPaid > 0 directly, no subtraction needed.
          taxes: accelResult.seniorExpensesPaid.taxes,
          issuerProfit: accelResult.seniorExpensesPaid.issuerProfit,
          trusteeFeesPaid: accelResult.seniorExpensesPaid.trusteeCapped,
          adminFeesPaid: accelResult.seniorExpensesPaid.adminCapped,
          trusteeOverflowPaid: 0,
          adminOverflowPaid: 0,
          // Cap is suppressed under acceleration (post-accel POP proviso);
          // emit zero for both diagnostic fields.
          seniorExpensesCapAmount: 0,
          seniorExpensesCapCarryforwardSum: 0,
          seniorMgmtFeePaid: accelResult.seniorExpensesPaid.seniorMgmt,
          hedgePaymentPaid: accelResult.seniorExpensesPaid.hedge,
          // Acceleration mode: Post-Acceleration Priority of Payments
          // steps (B)+(C) proviso citing Condition 10(b) (PPM ll.
          // 14167-14177) removes the Senior Expenses Cap, and
          // interest+principal pool together for sequential P+I
          // distribution. "Available for tranches" doesn't have a
          // coherent meaning here. UI hides the row + renders an
          // explanatory header.
          availableForTranches: null,
          subMgmtFeePaid: accelResult.subMgmtFeePaid,
          // Incentive fee collapsed into a single bucket under acceleration —
          // the executor returns one aggregated value (pre-residual), and the
          // normal-mode interest/principal split isn't meaningful here.
          // incentiveFeeFromPrincipal hardcoded 0 preserves stepTrace shape
          // without duplicating the fee. Partner-visible total = incentiveFeePaid.
          incentiveFeeFromInterest: accelResult.incentiveFeePaid,
          incentiveFeeFromPrincipal: 0,
          // OC cure + reinvestment OC diversion both emit zero under
          // acceleration — PPM-correct, not deferred. Cure mechanics only
          // apply during normal operations; under acceleration the waterfall
          // is unconditionally sequential P+I by seniority, no diversion.
          ocCureDiversions: [],
          reinvOcDiversion: 0,
          // Equity collapsed into a single bucket (residualToSub). The
          // normal-mode interest/principal equity split doesn't apply
          // because under acceleration all cash is pooled before distribution.
          equityFromInterest: equityDistributionAccel,
          equityFromPrincipal: 0,
          // Acceleration pools interest+principal into a single sequential
          // P+I distribution by seniority — there's no separate "amort
          // from interest" lane to expose. Step G's normal-mode pari-passu
          // mechanic doesn't apply post-breach. Emit 0 to satisfy the type.
          classXAmortFromInterest: 0,
          // Deferred-accrual map empty under acceleration — deferred interest
          // does NOT PIK post-breach (PPM 10(b)); unpaid interest becomes a
          // shortfall captured in accelResult.perPeriodInterestShortfall instead.
          deferredAccrualByTranche: {},
          // Acceleration skips the normal-mode reinvestment decision entirely
          // (sequential P+I paydown by seniority); no C1 enforcement applies.
          reinvestmentBlockedCompliance: 0,
          // Acceleration removes the Senior Expenses Cap (Post-Acceleration
          // Priority of Payments steps (B)+(C) proviso citing Condition
          // 10(b), PPM ll. 14167-14177), so no cap-overflow draw on the
          // Expense Reserve under accel.
          expenseReserveDraw: 0,
        },
        qualityMetrics: computeQualityMetrics(q),
      });

      // Record tranche payoff quarter(s) for any tranche that reached zero.
      for (const d of accelResult.trancheDistributions) {
        if (d.endBalance <= 0.01 && tranchePayoffQuarter[d.className] == null) {
          tranchePayoffQuarter[d.className] = q;
        }
      }

      // Same early-break guard as the normal-mode path: if all debt is
      // retired and pool is depleted, stop the loop to avoid emitting
      // zero-padded periods for the remainder of maturityQuarters.
      if (endingLiabilitiesAccel <= 0.01 && endingPar <= 0.01) break;
      continue; // Skip normal waterfall for this period.
    }

    if (isMaturity) {
      if (hasLoans) {
        for (const loan of loanStates) {
          loan.survivingPar = 0;
        }
      }
      currentPar = 0;
      endingPar = 0;
    }

    // Track principal paid per tranche across preliminary + diversion passes
    const principalPaid: Record<string, number> = {};
    for (const t of sortedTranches) {
      principalPaid[t.className] = 0;
    }

    // First pass: pay down from principal proceeds only.
    // Deferred interest on a tranche is paid before its principal.
    // Amortising tranches (Class X) are SKIPPED during normal periods — they pay
    // down from interest proceeds. At maturity/call, all tranches are paid.
    //
    // Pari-passu absorption: tranches at the same `seniorityRank` (A-1+A-2,
    // B-1+B-2) split available principal pro-rata by deferred-then-principal
    // balance instead of B-1 paying down to zero before B-2 sees a cent.
    let remainingPrelim = prelimPrincipal;
    const principalRanksInOrder: number[] = [];
    const principalGroupByRank = new Map<number, typeof sortedTranches>();
    for (const t of sortedTranches) {
      if (t.isIncomeNote || (t.isAmortising && !isMaturity)) continue;
      if (!principalGroupByRank.has(t.seniorityRank)) {
        principalRanksInOrder.push(t.seniorityRank);
        principalGroupByRank.set(t.seniorityRank, []);
      }
      principalGroupByRank.get(t.seniorityRank)!.push(t);
    }
    for (const rank of principalRanksInOrder) {
      const group = principalGroupByRank.get(rank)!;
      // Phase 1: deferred — pro-rata across group by deferredBalance.
      const groupDeferred = group.reduce((s, t) => s + deferredBalances[t.className], 0);
      const deferredPaidGroup = Math.min(groupDeferred, remainingPrelim);
      remainingPrelim -= deferredPaidGroup;
      const deferredShare: Record<string, number> = {};
      for (const t of group) {
        const share = groupDeferred > 0 ? deferredPaidGroup * (deferredBalances[t.className] / groupDeferred) : 0;
        deferredShare[t.className] = share;
        deferredBalances[t.className] -= share;
      }
      // Phase 2: principal — pro-rata across group by trancheBalance.
      const groupPrincipal = group.reduce((s, t) => s + trancheBalances[t.className], 0);
      const principalPaidGroup = Math.min(groupPrincipal, remainingPrelim);
      remainingPrelim -= principalPaidGroup;
      for (const t of group) {
        const share = groupPrincipal > 0 ? principalPaidGroup * (trancheBalances[t.className] / groupPrincipal) : 0;
        trancheBalances[t.className] -= share;
        principalPaid[t.className] += deferredShare[t.className] + share;
      }
      if (remainingPrelim <= 0.01) break;
    }

    // ── 9. Compute OC & IC ratios ────────────────────────────────
    // OC uses post-paydown balances (liability position after payments).
    // IC uses BOP balances (interest due accrued on beginning balance).
    //
    // Adjusted Collateral Principal Amount = ending par + principal account cash
    // + recovery value of defaulted-but-pending securities - CCC excess haircut
    // Principal account cash: uninvested principal sitting in accounts (remainingPrelim)
    // At maturity, all pending recoveries are already accelerated into `recoveries` (and thus
    // into prelimPrincipal/remainingPrelim), so don't count them again in the OC numerator.
    const pendingRecoveryValue = isMaturity ? 0 : recoveryPipeline
      .filter((r) => r.quarter > q)
      .reduce((s, r) => s + r.amount, 0);
    // OC numerator adjustment for pre-existing defaults: the trustee credits defaulted assets
    // at the lesser-of-agency recovery rate, which can be ABOVE or BELOW market price.
    // When agency > market: positive adjustment (trustee gives more OC credit than cash value).
    // When agency < market: negative adjustment (trustee caps OC credit below cash value).
    // Disappears when recovery arrives (adjusted for report staleness).
    const preExistingCashRecovery = preExistingDefaultRecovery + unpricedDefaultedPar * (recoveryPct / 100);
    const adjustedArrivalQ = Math.max(1, 1 + recoveryLagQ - quartersSinceReport);
    const preExistingRecoveryStillPending = preExistingDefaultedPar > 0 && !isMaturity && q < adjustedArrivalQ;
    // When agency data exists: adjust OC from cash value to agency value (can be negative).
    // When no agency data (preExistingDefaultOcValue = 0): no adjustment, use cash as-is.
    const ocDefaultAdjustment = (preExistingDefaultOcValue > 0 && preExistingRecoveryStillPending)
      ? preExistingDefaultOcValue - preExistingCashRecovery
      : 0;
    // OC-numerator subtractor — Σ undrawnCommitment over all loans.
    // Independent of the isDelayedDraw facility tag (a fully-drawn DDTL
    // contributes 0; a partially-drawn DDTL contributes the preserved
    // residual rather than the silently-discarded zero of the pre-fix path).
    const currentDdtlUnfundedPar = hasLoans
      ? loanStates.reduce((s, l) => s + l.undrawnCommitment, 0)
      : 0;
    // Adjusted CPA per PPM Condition 1(d) limits account-cash credit to
    // the Principal Account and Unused Proceeds Account — Reserve accounts
    // do NOT credit. The released Supplemental balance entered
    // `prelimPrincipal` at the maturity / acceleration release site (PPM
    // 3(j)(vi)(G) routes through the Principal Priority of Payments). If
    // any portion remains in `remainingPrelim` after rated-tranche
    // paydown, that residual is reserve cash, not Principal Account cash,
    // and is excluded from the Adjusted CPA numerator below.
    //
    // Observability note: under the engine's current waterfall structure,
    // a non-zero `remainingPrelim` post-paydown at `isMaturity=true`
    // implies all rated debt was retired (cash > debt), which collapses
    // the OC ratio denominator to 0 and surfaces the `999` sentinel —
    // making the inflation invisible in `ocTests[i].actual`. The
    // subtraction is therefore not pinned by an observable test today;
    // it is retained as a Principle 5 ("boundaries assert sign and
    // scale") invariant — `ocNumerator` is a boundary that the PPM
    // Adjusted-CPA semantic forbids reserve cash from crossing,
    // independent of whether any current downstream consumer reads it.
    const suppReserveLeftoverInRemainingPrelim = Math.min(remainingPrelim, suppReserveTerminalRelease);
    // Carry end-of-period Principal Account balance to next period's
    // CPA cap base. `remainingPrelim` is the post-paydown residual — the
    // cash sitting in the Principal Account at the Determination Date
    // immediately preceding period q+1's Payment Date.
    priorPeriodEndPrincipalCash = remainingPrelim;
    if (hasLoans) applyCureDispatch(loanStates, periodDate);
    const discountHaircut = hasLoans ? computeDiscountHaircut(loanStates) : 0;
    // Long-dated haircut from per-position dispatch (forward).
    // APB base is `endingPar` (already excludes DDTLs via the
    // `filter(!isDelayedDraw)` in its definition). CPA base adds the
    // Principal Account residual cash. Long-dated par decays naturally
    // through the existing loanStates mutation paths (amortization /
    // prepayment / default).
    const apbBasePeriod = endingPar;
    const cpaBasePeriod = endingPar + remainingPrelim;
    const longDatedHaircut = hasLoans
      ? computeLongDatedHaircut(loanStates, q, longDatedValuationRule, apbBasePeriod, cpaBasePeriod)
      : 0;
    let ocNumerator = endingPar + remainingPrelim - suppReserveLeftoverInRemainingPrelim
      + pendingRecoveryValue + ocDefaultAdjustment
      - discountHaircut - longDatedHaircut - impliedOcAdjustment - currentDdtlUnfundedPar;
    if (hasLoans && cccBucketLimitPct > 0) {
      const cccPar = loanStates
        .filter((l) => l.ratingBucket === "CCC" && l.survivingPar > 0)
        .reduce((s, l) => s + l.survivingPar, 0);
      const cccLimitAbs = endingPar * (cccBucketLimitPct / 100);
      const cccExcess = Math.max(0, cccPar - cccLimitAbs);
      if (cccExcess > 0) {
        // Haircut: replace par with market value for the excess amount
        const haircut = cccExcess * (1 - cccMarketValuePct / 100);
        ocNumerator -= haircut;
      }
    }

    const ocResults: PeriodResult["ocTests"] = [];
    const icResults: PeriodResult["icTests"] = [];

    // Amortising tranches (Class X) are excluded from OC/IC denominators per PPM definitions.
    // Par Value Ratio denominators only reference the rated notes (A through F), not Class X.
    const ocEligibleTranches = debtTranches.filter((t) => !t.isAmortising);

    for (const oc of ocTriggersByClass) {
      const debtAtAndAbove = ocEligibleTranches
        .filter((t) => t.seniorityRank <= oc.rank)
        .reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);
      const actual = debtAtAndAbove > 0 ? (ocNumerator / debtAtAndAbove) * 100 : 999;
      const passing = actual >= oc.triggerLevel;
      ocResults.push({ className: oc.className, actual, trigger: oc.triggerLevel, passing });
    }

    // B1 Tier 2 — in-loop EoD check. Compositional numerator uses per-position
    // defaultedParPending (drained as recoveries arrive) × currentPrice; plus
    // non-defaulted surviving par; plus current principal cash. Denominator is
    // Class A balance (post-period-mutations, since this runs after paydowns).
    let eodPeriodResult: EventOfDefaultTestResult | null = null;
    if (eventOfDefaultTest && hasLoans) {
      const eodInput: Array<{
        survivingPar: number;
        isDefaulted: boolean;
        currentPrice?: number | null;
      }> = [];
      for (const l of loanStates) {
        if (l.survivingPar > 0) {
          eodInput.push({ survivingPar: l.survivingPar, isDefaulted: false });
        }
        if (l.defaultedParPending > 0) {
          eodInput.push({
            survivingPar: l.defaultedParPending,
            isDefaulted: true,
            currentPrice: l.currentPrice,
          });
        }
      }
      const classAPao = computeSeniorTranchePao(tranches, trancheBalances);
      // Principal Account cash at measurement date = `remainingPrelim` —
      // principal proceeds still parked on the account after the first
      // paydown pass, before any further distribution. Same quantity the
      // class OC numerator uses (see ocNumerator computation above). Under
      // stress (defaults spiking, reinvestment opportunities shrinking,
      // post-RP with throttled reinvestment) this is strictly positive and
      // flows into component (3) of the compositional numerator. Previously
      // this was hardcoded to 0, under-counting the numerator and making
      // forward-loop EoD detection insensitive in exactly the distressed
      // scenarios where the test needs to be sensitive.
      eodPeriodResult = computeEventOfDefaultTest(
        eodInput,
        remainingPrelim,
        classAPao,
        eventOfDefaultTest.triggerLevel,
      );
    }

    for (const ic of icTriggersByClass) {
      const interestDueAtAndAbove = ocEligibleTranches
        .filter((t) => t.seniorityRank <= ic.rank)
        .reduce((s, t) => s + bopTrancheBalances[t.className] * trancheCouponRate(t, baseRatePct, baseRateFloorPct) * trancheDayFrac(t), 0);
      const actual = interestDueAtAndAbove > 0 ? (interestAfterFees / interestDueAtAndAbove) * 100 : 999;
      const passing = actual >= ic.triggerLevel;
      icResults.push({ className: ic.className, actual, trigger: ic.triggerLevel, passing });
    }

    const failingOcRanks = new Set(
      ocTriggersByClass
        .filter((oc) => ocResults.some((r) => r.className === oc.className && !r.passing))
        .map((oc) => oc.rank)
    );
    const failingIcRanks = new Set(
      icTriggersByClass
        .filter((ic) => icResults.some((r) => r.className === ic.className && !r.passing))
        .map((ic) => ic.rank)
    );

    // ── 10. Interest waterfall (OC/IC-gated) ─────────────────────
    // Interest DUE uses BOP balances (accrued before paydown).
    // Class X interest is paid sequentially (earlier in the loop). Class X amortisation
    // and Class A interest are paid pro rata per PPM Step G if there is a shortfall.
    let availableInterest = interestCollected;
    const trancheInterest: PeriodResult["trancheInterest"] = [];

    // Expense Reserve cash transfer to Interest Account per PPM
    // Condition 3(j)(x)(4): "on the second Business Day prior to each
    // Payment Date, any amounts to be paid pursuant to paragraphs (B) and
    // (C) of the Interest Priority of Payments in excess of the Senior
    // Expenses Cap to the Interest Account, provided that any such
    // payments [...] shall not cause the balance of the Expense Reserve
    // Account to fall below zero". The reserve is held as cash; it
    // physically transfers to the Interest Account before the waterfall
    // fires and augments the cash pool from which (B)+(C) are paid.
    // Modeled as a pre-augmentation of `availableInterest` before the
    // helper consumes it. Drain equals the transfer (the reserve cash
    // physically left the account). Same paragraph (c) flow that the
    // T=0 IC numerator construction includes, mirrored at Q1.
    // Gated on !isAccelerated — under PPM Condition 3(c)(i)(B)+(C)
    // proviso "following the occurrence of an Event of Default, the
    // Senior Expenses Cap shall not apply", post-accel fees pay
    // uncapped from the pooled stream and the reserve cap-augmentation
    // mechanism does not apply.
    if (expenseReserveTransferToInterest > 0) {
      availableInterest += expenseReserveTransferToInterest;
      expenseReserveBalance -= expenseReserveTransferToInterest;
      expenseReserveDraw = expenseReserveTransferToInterest;
    }

    // PPM Steps (A)(i) → (F): senior expenses deducted in strict PPM order
    // (taxes → issuer profit → trustee capped → admin capped → senior mgmt
    // → hedge). Single helper drives this AND the IC numerator above from
    // the same `seniorExpenseBreakdown` object — drift-by-construction
    // impossible because both consumers read the same field set. The
    // `paid` return is consumed by stepTrace emission below (post-truncation
    // values per partner-visible "actually paid" semantic); the IC numerator
    // above keeps the requested-deducted reading on purpose — see comment
    // at the IC numerator construction.
    const seniorExpensesApplied = applySeniorExpensesToAvailable(
      seniorExpenseBreakdown,
      availableInterest,
    );
    availableInterest = seniorExpensesApplied.remainingAvailable;
    const seniorExpensesPaid = seniorExpensesApplied.paid;

    // Capture residual at this point for stepTrace.availableForTranches —
    // the amount entering the tranche-interest pari-passu loop (PPM step G
    // onward), before any tranche or OC-cure mutations. UI consumes this
    // directly. See CLAUDE.md § Engine ↔ UI separation: the original
    // PeriodTrace incident recomputed this from period × inputs and dropped
    // clauses (A.i), (A.ii), (C).
    const availableForTranches = availableInterest;

    // Step G (PPM): Class X amort + Class A interest are paid pro rata / pari passu.
    // Class X amort starts on the second payment date (q >= 2) per PPM definition.
    // Compute Class X amort demand alongside the most senior non-amortising tranche
    // interest so they share proportionally in a shortfall scenario.
    const amortDemand: Record<string, number> = {};
    for (const t of debtTranches) {
      if (!t.isAmortising || trancheBalances[t.className] <= 0.01) continue;
      // Amort only active after the start date (e.g. second payment date per PPM)
      if (t.amortStartDate && new Date(periodDate) < new Date(t.amortStartDate)) continue;
      const scheduleAmt = resolvedAmortPerPeriod[t.className] ?? trancheBalances[t.className];
      amortDemand[t.className] = Math.min(scheduleAmt, trancheBalances[t.className]);
    }

    // Find the most senior non-amortising tranche rank (typically Class A)
    const seniorNonAmortRank = debtTranches.find((t) => !t.isAmortising)?.seniorityRank;

    // Group debtTranches by seniorityRank so pari-passu classes (A-1+A-2,
    // B-1+B-2) absorb interest pro-rata under shortfall instead of B-1
    // taking the full available before B-2 sees a cent. The post-acceleration
    // executor (`runPostAccelerationWaterfall`) has the same shape; this is
    // the pre-accel mirror. Pro-rata splits use `gInterestDue / totalGroupDue`
    // (the engine's existing rule for the post-accel path) so two pari-passu
    // tranches with different spreads share by interest demand rather than
    // by balance — matches PPM "pari passu and pro rata" semantics.
    const ranksInOrder: number[] = [];
    const groupByRank = new Map<number, typeof debtTranches>();
    for (const t of debtTranches) {
      if (!groupByRank.has(t.seniorityRank)) {
        ranksInOrder.push(t.seniorityRank);
        groupByRank.set(t.seniorityRank, []);
      }
      groupByRank.get(t.seniorityRank)!.push(t);
    }

    let diverted = false;
    for (const rank of ranksInOrder) {
      const group = groupByRank.get(rank)!;
      const dueByMember: Record<string, number> = {};
      let totalGroupDue = 0;
      for (const t of group) {
        const rate = trancheCouponRate(t, baseRatePct, baseRateFloorPct);
        const d = bopTrancheBalances[t.className] * rate * trancheDayFrac(t);
        dueByMember[t.className] = d;
        totalGroupDue += d;
      }

      // Helper: at every payment-allocation site below, accrue the per-member
      // shortfall to either deferredBalances (deferrable, PIK semantic) or
      // interestShortfall (non-deferrable, EoD-trigger semantic). PPM-correct
      // non-deferrable mechanic: missed interest is NOT paid back in pre-
      // acceleration; it's tracked here for visibility, fed into the EoD
      // detector (consecutive-shortfall-count > grace → EoD), and folded
      // into post-acceleration interestDueByTranche when the breach declares.
      const accrueShortfall = (
        t: ProjectionInputs["tranches"][number],
        due: number,
        paid: number,
      ) => {
        if (paid >= due - 0.01) return;
        if (bopTrancheBalances[t.className] <= 0.01) return;
        const shortfall = due - paid;
        if (t.isDeferrable) {
          if (deferredInterestCompounds) {
            trancheBalances[t.className] += shortfall;
          } else {
            deferredBalances[t.className] += shortfall;
          }
          _stepTrace_deferredAccrualByTranche[t.className] =
            (_stepTrace_deferredAccrualByTranche[t.className] ?? 0) + shortfall;
        } else if (!t.isAmortising && !t.isIncomeNote) {
          // Non-deferrable debt tranche: shortfall accrues for diagnostic
          // visibility and post-acceleration claim integrity. Carry-forward
          // into next period's pre-accel demand is INTENTIONALLY NOT
          // performed — that would model a soft-deferrable behavior which
          // is the antithesis of "non-deferrable". The shortfall is
          // collected (a) by the EoD trigger when consecutive-shortfall-
          // count on a RANK-PROTECTED tranche (top-two non-amort debt
          // ranks per `eodProtectedClassNames`) exceeds the PPM grace
          // period — non-protected non-deferrable juniors track shortfall
          // here but don't drive the EoD trigger; and (b) by the post-
          // acceleration handoff which folds the running interestShortfall
          // balance for ALL non-deferrable debt tranches into
          // interestDueByTranche.
          interestShortfall[t.className] = (interestShortfall[t.className] ?? 0) + shortfall;
        }
      };

      if (diverted) {
        for (const t of group) {
          const due = dueByMember[t.className];
          trancheInterest.push({ className: t.className, due, paid: 0 });
          accrueShortfall(t, due, 0);
        }
        continue;
      }

      // Step G (PPM): at the senior-non-amort rank, fold Class X amort demand
      // into the pari-passu basket alongside the group's interest. Under
      // shortfall, the X-amort + group-interest basket splits pro-rata across
      // ALL components. The original sequential loop ran this fold once per
      // tranche at the senior-non-amort rank, which double-paid X amort on a
      // pari-passu A-1+A-2 split — the rank-grouped form handles X amort
      // exactly once per period regardless of A-rank cardinality.
      if (seniorNonAmortRank != null && rank === seniorNonAmortRank) {
        const totalAmortDue = Object.values(amortDemand).reduce((s, v) => s + v, 0);
        const totalStepGDue = totalAmortDue + totalGroupDue;
        if (totalStepGDue > 0 && totalStepGDue > availableInterest) {
          const ratio = availableInterest / totalStepGDue;
          for (const [cls, amt] of Object.entries(amortDemand)) {
            const amortPay = amt * ratio;
            trancheBalances[cls] -= amortPay;
            principalPaid[cls] += amortPay;
            _stepTrace_classXAmortFromInterest += amortPay;
            _amortFromInterestByTranche[cls] = (_amortFromInterestByTranche[cls] ?? 0) + amortPay;
          }
          for (const t of group) {
            const due = dueByMember[t.className];
            const paid = due * ratio;
            trancheInterest.push({ className: t.className, due, paid });
            accrueShortfall(t, due, paid);
          }
          availableInterest = 0;
          // Step G fully consumed available; subsequent groups produce
          // zero paid via the same Math.min(totalGroupDue, 0) = 0 path,
          // with PIK / shortfall on shortfall handled per-member.
        } else {
          // Enough to pay X amort in full; group interest pays normally below.
          for (const [cls, amt] of Object.entries(amortDemand)) {
            trancheBalances[cls] -= amt;
            availableInterest -= amt;
            principalPaid[cls] += amt;
            _stepTrace_classXAmortFromInterest += amt;
            _amortFromInterestByTranche[cls] = (_amortFromInterestByTranche[cls] ?? 0) + amt;
          }
          // Pay group interest pro-rata (or in full if available exceeds totalGroupDue)
          const groupPaid = Math.min(totalGroupDue, availableInterest);
          availableInterest -= groupPaid;
          for (const t of group) {
            const due = dueByMember[t.className];
            const memberPaid = totalGroupDue > 0 ? groupPaid * (due / totalGroupDue) : 0;
            trancheInterest.push({ className: t.className, due, paid: memberPaid });
            accrueShortfall(t, due, memberPaid);
          }
        }
      } else {
        // Non-Step-G group: pay group interest pro-rata across members.
        const groupPaid = Math.min(totalGroupDue, availableInterest);
        availableInterest -= groupPaid;
        for (const t of group) {
          const due = dueByMember[t.className];
          const memberPaid = totalGroupDue > 0 ? groupPaid * (due / totalGroupDue) : 0;
          trancheInterest.push({ className: t.className, due, paid: memberPaid });
          accrueShortfall(t, due, memberPaid);
        }
      }

      // Diversion check at end of rank group — all members at this rank are
      // paid before any cure fires. Replaces the per-iteration
      // `atRankBoundary` check from the sequential form.
      if (failingOcRanks.has(rank) || failingIcRanks.has(rank)) {
        const failingOc = ocTriggersByClass.find(
          (oc) => oc.rank === rank && ocResults.some((r) => r.className === oc.className && !r.passing)
        );
        const failingIc = icTriggersByClass.find(
          (ic) => ic.rank === rank && icResults.some((r) => r.className === ic.className && !r.passing)
        );

        let cureAmount = 0;

        if (failingOc) {
          const debtAtAndAbove = ocEligibleTranches
            .filter((tr) => tr.seniorityRank <= failingOc.rank)
            .reduce((s, tr) => s + trancheBalances[tr.className] + deferredBalances[tr.className], 0);
          const trigger = failingOc.triggerLevel / 100;
          if (inRP && !failingIc) {
            // Reinvestment cure: divert interest, buy collateral, lift the
            // OC numerator. `cureAmount` is the CASH needed (consumed from
            // availableInterest below). Mirror computeReinvOcDiversion's
            // price-aware sizing: above-threshold purchases are leveraged
            // (€1 cash → €1/price par → €1/price numerator gain, so cash
            // needed = numeratorGain × price/100); sub-threshold purchases
            // become discount obligations and contribute par × price/100
            // post-haircut to numerator (no leverage; cash = numeratorGain).
            const numeratorGainNeeded = Math.max(0, trigger * debtAtAndAbove - ocNumerator);
            cureAmount = reinvIsSubThreshold
              ? numeratorGainNeeded
              : numeratorGainNeeded * (reinvestmentPricePct / 100);
          } else {
            cureAmount = Math.max(0, debtAtAndAbove - ocNumerator / trigger);
          }
        }

        if (failingIc) {
          const icTriggerRatio = failingIc.triggerLevel / 100;
          const interestDueAtAndAbove = ocEligibleTranches
            .filter((tr) => tr.seniorityRank <= failingIc.rank)
            .reduce((s, tr) => s + bopTrancheBalances[tr.className] * trancheCouponRate(tr, baseRatePct, baseRateFloorPct) * trancheDayFrac(tr), 0);
          const neededInterestDue = interestAfterFees / icTriggerRatio;
          const reductionNeeded = Math.max(0, interestDueAtAndAbove - neededInterestDue);

          if (reductionNeeded > 0) {
            let reductionRemaining = reductionNeeded;
            let icCureAmount = 0;
            for (const tr of ocEligibleTranches.filter((tr) => tr.seniorityRank <= failingIc.rank)) {
              if (reductionRemaining <= 0) break;
              const couponPerPar = trancheCouponRate(tr, baseRatePct, baseRateFloorPct) * trancheDayFrac(tr);
              if (couponPerPar <= 0) continue;
              const trancheAvailable = trancheBalances[tr.className] + deferredBalances[tr.className];
              const paydownForThisTranche = Math.min(reductionRemaining / couponPerPar, trancheAvailable);
              icCureAmount += paydownForThisTranche;
              reductionRemaining -= paydownForThisTranche * couponPerPar;
            }
            cureAmount = Math.max(cureAmount, icCureAmount);
          }
        }

        const diversion = Math.min(cureAmount, availableInterest);
        availableInterest -= diversion;
        if (availableInterest <= 0.01) diverted = true;

        if (diversion > 0) {
          const _mode: "reinvest" | "paydown" = inRP && !failingIc ? "reinvest" : "paydown";
          _stepTrace_ocCureDiversions.push({ rank, mode: _mode, amount: diversion });
          if (inRP && !failingIc) {
            // Price-aware synthesis. `diversion` here is the cash amount
            // diverted to reinvestment; par bought scales with
            // 1/(purchasePricePct/100) so sub-par purchases buy more par
            // for the same cash. OC numerator increment depends on whether
            // the synthesised loan is sub-threshold (discount-obligation
            // → contributes post-haircut value) or above (full par).
            const cureParBought = diversion * (100 / reinvestmentPricePct);
            const cureNumeratorGain = reinvIsSubThreshold
              ? cureParBought * (reinvestmentPricePct / 100)
              : cureParBought;
            const cureMaturityQ = q + reinvestmentTenorQuarters;
            currentPar += cureParBought;
            ocNumerator += cureNumeratorGain;
            if (hasLoans) {
              loanStates.push({
                survivingPar: cureParBought,
                ratingBucket: reinvestmentRating,
                spreadBps: reinvestmentSpreadBps,
                warfFactor: reinvestmentWarfFactor,
                maturityQuarter: cureMaturityQ,
                isFixedRate: reinvIsFixedRate,
                isDelayedDraw: false,
                undrawnCommitment: 0,
                defaultedParPending: 0,
                defaultEvents: [],
                purchasePricePct: reinvestmentPricePct,
                acquisitionDate: periodDate,
                isDiscountObligation: reinvIsSubThreshold,
                isLongDated: cureMaturityQ > totalQuarters,
              });
            }
          } else {
            // Cure paydown application — rank-grouped pari-passu so a B-1+B-2
            // pair at the failing rank shares the diversion pro-rata by
            // balance instead of B-1 paying to zero before B-2 is touched.
            // Same template as the principal first-pass refactor; deferred
            // is paid first then principal, both pro-rata within each group.
            //
            // Excludes amortising tranches (Class X): the cure amount is
            // computed against `ocEligibleTranches` (which omits amortising)
            // because Class X is not in the OC denominator. Applying the
            // diversion to Class X would consume cash without reducing the
            // denominator the cure aims to satisfy, leaving the OC test
            // un-cured. Income notes excluded for the same reason (residual
            // claim, not part of the senior-debt stack the cure targets).
            let remaining = diversion;
            const cureRanksInOrder: number[] = [];
            const cureGroupByRank = new Map<number, typeof sortedTranches>();
            for (const dt of sortedTranches) {
              if (dt.isIncomeNote || dt.isAmortising) continue;
              if (!cureGroupByRank.has(dt.seniorityRank)) {
                cureRanksInOrder.push(dt.seniorityRank);
                cureGroupByRank.set(dt.seniorityRank, []);
              }
              cureGroupByRank.get(dt.seniorityRank)!.push(dt);
            }
            for (const cr of cureRanksInOrder) {
              if (remaining <= 0) break;
              const cgroup = cureGroupByRank.get(cr)!;
              const groupDeferred = cgroup.reduce((s, t) => s + deferredBalances[t.className], 0);
              const deferredPaidGroup = Math.min(groupDeferred, remaining);
              remaining -= deferredPaidGroup;
              for (const t of cgroup) {
                const share = groupDeferred > 0 ? deferredPaidGroup * (deferredBalances[t.className] / groupDeferred) : 0;
                deferredBalances[t.className] -= share;
                principalPaid[t.className] += share;
              }
              const groupPrincipal = cgroup.reduce((s, t) => s + trancheBalances[t.className], 0);
              const principalPaidGroup = Math.min(groupPrincipal, remaining);
              remaining -= principalPaidGroup;
              for (const t of cgroup) {
                const share = groupPrincipal > 0 ? principalPaidGroup * (trancheBalances[t.className] / groupPrincipal) : 0;
                trancheBalances[t.className] -= share;
                principalPaid[t.className] += share;
              }
            }
          }
        }
      }
    }

    // PPM Step V: Reinvestment OC Test — divert a percentage of remaining interest during RP to buy collateral.
    // Evaluated after standard OC cures which may have bought collateral (updating ocNumerator).
    if (inRP && reinvestmentOcTrigger && availableInterest > 0) {
      const reinvOcDebt = ocEligibleTranches
        .filter((tr) => tr.seniorityRank <= reinvestmentOcTrigger.rank)
        .reduce((s, tr) => s + trancheBalances[tr.className] + deferredBalances[tr.className], 0);
      const { cashDiverted, parBought } = computeReinvOcDiversion(
        availableInterest,
        ocNumerator,
        reinvOcDebt,
        reinvestmentOcTrigger.triggerLevel,
        reinvestmentOcTrigger.diversionPct,
        reinvestmentPricePct,
        reinvIsSubThreshold,
      );
      if (cashDiverted > 0) {
        _stepTrace_reinvOcDiversion = cashDiverted;
        availableInterest -= cashDiverted;
        currentPar += parBought;
        // OC numerator: full par for above-threshold; par × purchasePrice/100
        // for sub-threshold (the per-position discount-obligation haircut
        // gets subtracted at the next period's haircut Σ pass — for the
        // current-period in-place ocNumerator update, contribute the
        // post-haircut net so the in-period cure measurement is consistent).
        ocNumerator += reinvIsSubThreshold
          ? parBought * (reinvestmentPricePct / 100)
          : parBought;
        const synthMaturityQ = q + reinvestmentTenorQuarters;
        if (hasLoans) {
          loanStates.push({
            survivingPar: parBought,
            ratingBucket: reinvestmentRating,
            spreadBps: reinvestmentSpreadBps,
            warfFactor: reinvestmentWarfFactor,
            maturityQuarter: synthMaturityQ,
            isFixedRate: reinvIsFixedRate,
            isDelayedDraw: false,
            undrawnCommitment: 0,
            defaultedParPending: 0,
            defaultEvents: [],
            purchasePricePct: reinvestmentPricePct,
            acquisitionDate: periodDate,
            isDiscountObligation: reinvIsSubThreshold,
            isLongDated: synthMaturityQ > totalQuarters,
          });
        }
      }
    }

    // Refresh endingPar after any RP OC diversion may have purchased collateral.
    // survivingPar IS the funded balance — un-drawn commitments contribute zero implicitly.
    if (hasLoans) endingPar = loanStates.reduce((s, l) => s + l.survivingPar, 0);
    else endingPar = currentPar;

    // PPM Step X: Subordinated management fee — paid after all debt tranches.
    // Capture the truncated paid amount so stepTrace emits "actually paid";
    // the requested `subFeeAmount` overstates payment under stress when
    // `availableInterest` is exhausted before reaching this step.
    const subFeeAmount = beginningPar * (subFeePct / 100) * dayFracActual;
    const subFeePaid = Math.min(subFeeAmount, availableInterest);
    availableInterest -= subFeePaid;

    // PPM Steps (Y) trustee-overflow + (Z) admin-overflow.
    // POP convention: each step is paid in full from residual interest before
    // the next step receives anything. Step (Z) clause text carries no joint-
    // allocation language; sequential Y-first is the PPM-correct rule.
    // The "pro_rata" branch is preserved for any deal whose PPM specifies
    // pari-passu allocation on the overflow steps (rare).
    let trusteeOverflowPaid = 0;
    let adminOverflowPaid = 0;
    if (cappedOverflowTotal > 0 && availableInterest > 0) {
      if (seniorExpensesCapOverflowAllocation === "sequential_y_first") {
        trusteeOverflowPaid = Math.min(trusteeOverflowRequested, availableInterest);
        availableInterest -= trusteeOverflowPaid;
        adminOverflowPaid = Math.min(adminOverflowRequested, availableInterest);
        availableInterest -= adminOverflowPaid;
      } else {
        const overflowPayable = Math.min(cappedOverflowTotal, availableInterest);
        const overflowRatio = cappedOverflowTotal > 0 ? overflowPayable / cappedOverflowTotal : 0;
        trusteeOverflowPaid = trusteeOverflowRequested * overflowRatio;
        adminOverflowPaid = adminOverflowRequested * overflowRatio;
        availableInterest -= overflowPayable;
      }
    }

    // PPM Step BB: Incentive management fee — % of residual when equity IRR > hurdle.
    // Incentive fee is circular: the fee reduces equity distributions, which reduces
    // the IRR, which determines whether the fee should be charged. resolveIncentiveFee
    // handles this by checking three regimes — see function docstring.
    let incentiveFeeFromInterest = 0;
    if (incentiveFeePct > 0 && incentiveFeeHurdleIrr > 0 && availableInterest > 0) {
      incentiveFeeFromInterest = resolveIncentiveFee(
        equityCashFlows, availableInterest, incentiveFeePct, incentiveFeeHurdleIrr, 4
      );
      availableInterest -= incentiveFeeFromInterest;
    }

    const equityFromInterest = availableInterest;

    // ── 11. Build principal results ──────────────────────────────
    let availablePrincipal = remainingPrelim;

    const tranchePrincipal: PeriodResult["tranchePrincipal"] = [];
    for (const t of sortedTranches) {
      if (t.isIncomeNote) {
        tranchePrincipal.push({ className: t.className, paid: 0, paidFromInterest: 0, endBalance: trancheBalances[t.className] });
        continue;
      }
      tranchePrincipal.push({
        className: t.className,
        paid: principalPaid[t.className],
        paidFromInterest: _amortFromInterestByTranche[t.className] ?? 0,
        endBalance: trancheBalances[t.className] + deferredBalances[t.className],
      });

      if (trancheBalances[t.className] + deferredBalances[t.className] <= 0.01 && tranchePayoffQuarter[t.className] === null) {
        tranchePayoffQuarter[t.className] = q;
      }
    }

    const endingLiabilities = debtTranches.reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);

    // PPM Step U: Incentive fee from principal proceeds (same IRR-gated circularity).
    // Compute total fee on combined interest+principal, then subtract what was already
    // taken from interest to get the incremental principal fee.
    let incentiveFeeFromPrincipal = 0;
    if (incentiveFeePct > 0 && incentiveFeeHurdleIrr > 0 && availablePrincipal > 0) {
      const preFeeInterestForEquity = equityFromInterest + incentiveFeeFromInterest;
      const totalAvailable = preFeeInterestForEquity + availablePrincipal;
      const totalFee = resolveIncentiveFee(
        equityCashFlows, totalAvailable, incentiveFeePct, incentiveFeeHurdleIrr, 4
      );
      incentiveFeeFromPrincipal = Math.max(0, totalFee - incentiveFeeFromInterest);
      availablePrincipal -= incentiveFeeFromPrincipal;
    }

    // Capture equity-from-principal residual BEFORE it's summed into equityDistribution,
    // so the stepTrace separates PPM step (DD) (interest residual) from principal residual.
    const equityFromPrincipal = availablePrincipal;
    const equityDistribution = equityFromInterest + equityFromPrincipal;
    totalEquityDistributions += equityDistribution;
    equityCashFlows.push(equityDistribution);

    // §4.3 balance instrumentation (normal-waterfall branch).
    const endingDefaultedParNormal = hasLoans
      ? loanStates.reduce((s, l) => s + l.defaultedParPending, 0)
      : 0;
    const endingUndrawnCommitmentNormal = hasLoans
      ? loanStates.reduce((s, l) => s + l.undrawnCommitment, 0)
      : 0;

    // PPM § 10(a)(i) EoD-on-shortfall trigger — Phase 1 (pre-emit):
    // update `shortfallCount` based on this period's accrual and compute
    // the `eodOnShortfall` flag. Done BEFORE the emit so the emitted
    // `interestShortfallCount` reflects the end-of-period post-update
    // count (consistent with `interestShortfall`, which is also end-of-
    // period). The `isAccelerated` flip is deliberately deferred to
    // Phase 2 (after emit) — the emit must reflect the regime period N
    // actually ran under (pre-accel here), not the regime period N+1
    // will run under. A period emitting `isAccelerated=true` would imply
    // the post-acceleration waterfall executed for it, which only
    // happens in the post-accel branch above.
    let eodOnShortfall = false;
    for (const cls of eodProtectedClassNames) {
      const delta = (interestShortfall[cls] ?? 0) - (bopInterestShortfall[cls] ?? 0);
      if (delta > 0.01) {
        shortfallCount[cls] = (shortfallCount[cls] ?? 0) + 1;
        if (shortfallCount[cls] > eodGrace) eodOnShortfall = true;
      } else {
        shortfallCount[cls] = 0;
      }
    }

    periods.push({
      periodNum: q,
      date: periodDate,
      beginningPar,
      beginningPerformingPar: beginningPar,
      endingPerformingPar: endingPar,
      beginningDefaultedPar,
      endingDefaultedPar: endingDefaultedParNormal,
      endingUndrawnCommitment: endingUndrawnCommitmentNormal,
      beginningPrincipalAccount: 0,
      endingPrincipalAccount: 0,
      beginningInterestAccount: 0,
      endingInterestAccount: 0,
      defaults,
      prepayments,
      scheduledMaturities,
      recoveries,
      principalProceeds: prepayments + scheduledMaturities + recoveries,
      reinvestment,
      endingPar,
      beginningLiabilities,
      endingLiabilities,
      interestCollected,
      trancheInterest,
      tranchePrincipal,
      // Snapshot end-of-period interestShortfall (cumulative carry) so the
      // period's running balance is partner-visible. Skip zero entries to
      // keep the field clean in healthy runs.
      interestShortfall: Object.fromEntries(
        Object.entries(interestShortfall).filter(([, v]) => v > 0.01),
      ),
      // Empty in pre-accel periods — the per-period shortfall semantic only
      // applies under acceleration. Pre-accel uses cumulative carry above.
      perPeriodInterestShortfall: {},
      // Snapshot end-of-period shortfallCount — partner-facing countdown to
      // EoD without re-deriving the state machine. Captured AFTER the
      // trigger block (above the emit) so the value reflects this period's
      // post-update count: count==grace+1 on the period that fires EoD,
      // count==0 on a fully-paid period.
      interestShortfallCount: Object.fromEntries(
        Object.entries(shortfallCount).filter(([, v]) => v > 0),
      ),
      ocTests: ocResults,
      icTests: icResults,
      eodTest: eodPeriodResult,
      isAccelerated, // false at this emit site — normal path
      loanDefaultEvents: loanDefaultEventsThisPeriod,
      equityDistribution,
      defaultsByRating,
      stepTrace: {
        // Post-truncation paid amounts (consumed from `seniorExpensesPaid`
        // and `subFeePaid` above). Per the actually-paid invariant: every
        // fee/expense field on PeriodStepTrace must be sourced from the
        // truncated paid value, never the pre-truncation requested object,
        // or `Σ stepTrace.*(interest waterfall) ≤ interestCollected` breaks
        // and partner-visible aggregators overstate fees. trusteeOverflow /
        // adminOverflow already use truncated locals from the Y/Z block.
        taxes: seniorExpensesPaid.taxes,
        issuerProfit: seniorExpensesPaid.issuerProfit, // PPM A.ii
        // Each field maps to exactly one PPM step so the N1 harness ties
        // engine-emission to trustee-reported on a per-step basis. Pre-C3
        // `trusteeFeesPaid` bundled (B)+(C)+(Y)+(Z); the split lets us
        // distinguish trustee vs admin drift (and in/out of cap) under
        // both normal and accelerated paths.
        trusteeFeesPaid: seniorExpensesPaid.trusteeCapped, // PPM (B)
        adminFeesPaid: seniorExpensesPaid.adminCapped,     // PPM (C)
        trusteeOverflowPaid,                               // PPM (Y)
        adminOverflowPaid,                                 // PPM (Z)
        seniorExpensesCapAmount: capAmount,
        seniorExpensesCapCarryforwardSum: carryforwardSum,
        seniorMgmtFeePaid: seniorExpensesPaid.seniorMgmt,
        hedgePaymentPaid: seniorExpensesPaid.hedge,
        availableForTranches,
        subMgmtFeePaid: subFeePaid,
        incentiveFeeFromInterest,
        incentiveFeeFromPrincipal,
        ocCureDiversions: _stepTrace_ocCureDiversions,
        reinvOcDiversion: _stepTrace_reinvOcDiversion,
        equityFromInterest,
        equityFromPrincipal,
        classXAmortFromInterest: _stepTrace_classXAmortFromInterest,
        deferredAccrualByTranche: _stepTrace_deferredAccrualByTranche,
        reinvestmentBlockedCompliance,
        expenseReserveDraw,
      },
      qualityMetrics: computeQualityMetrics(q),
    });

    // Prune exhausted loans to keep iteration cost O(active loans) per period.
    // "Exhausted" requires BOTH survivingPar <= 0 AND undrawnCommitment <= 0
    // — a currently-un-drawn DDTL/revolver has survivingPar=0 but a live
    // commitment waiting for its draw event; pruning it pre-draw silently
    // drops the un-drawn notional from the OC subtractor and prevents the
    // draw event from firing in any subsequent period. Critical for Monte
    // Carlo performance where thousands of runs accumulate dead entries.
    if (hasLoans) {
      let write = 0;
      for (let read = 0; read < loanStates.length; read++) {
        const l = loanStates[read];
        if (l.survivingPar > 0 || l.undrawnCommitment > 0) {
          loanStates[write++] = l;
        }
      }
      loanStates.length = write;
    }

    // Stop early if all debt paid off and collateral is depleted
    const remainingDebt = debtTranches.reduce((s, t) => s + trancheBalances[t.className] + deferredBalances[t.className], 0);
    if (remainingDebt <= 0.01 && endingPar <= 0.01) {
      // PPM Condition 3(j)(vi)(G)(1): "at the direction of the Collateral
      // Manager at any time prior to a Note Event of Default" — natural
      // wind-up (collateral and debt both depleted before the configured
      // maturity quarter) is functionally a manager-directed terminal
      // event. Release any pending "hold" Supplemental Reserve balance
      // into the just-emitted period's principal residual so the partner-
      // facing equity distribution at deal end reflects it. This preserves
      // the configured-maturity-or-acceleration release path above for
      // those scenarios; this branch covers the deal-winds-up-early case.
      if (heldSupplementalReserveBalance > 0.01) {
        const release = heldSupplementalReserveBalance;
        heldSupplementalReserveBalance = 0;
        const lastPeriod = periods[periods.length - 1];
        lastPeriod.equityDistribution += release;
        lastPeriod.stepTrace.equityFromPrincipal += release;
        totalEquityDistributions += release;
        equityCashFlows[equityCashFlows.length - 1] += release;
      }
      break;
    }

    // PPM § 10(a)(i) EoD-on-shortfall trigger — Phase 2 (post-emit):
    // flip `isAccelerated` for the NEXT period if either the compositional
    // EoD test (`eodPeriodResult`) or the interest-non-payment grace-period
    // gate (`eodOnShortfall`, set in Phase 1 above) tripped this period.
    // Irreversible once set. Phase 1's `eodOnShortfall` flag is in scope
    // here because both phases run under the same pre-accel branch — the
    // post-accel branch `continue`s above and never reaches either phase.
    if ((eodPeriodResult && !eodPeriodResult.passing) || eodOnShortfall) {
      isAccelerated = true;
    }
  }

  // Explicit insolvency guard: if t=0 balance sheet is underwater, IRR is
  // undefined regardless of subsequent cashflow series. The implicit chain
  // (bookValue=0 → equityInvestment=0 → cf[0]=-0 → calculateIrr early-return
  // on all-non-negative) holds today but depends on JS treating -0 >= 0 as
  // true and on every downstream equity flow remaining non-negative. Make
  // the contract explicit instead of inferring it.
  const equityIrr = initialState.equityWipedOut
    ? null
    : calculateIrr(equityCashFlows, 4);

  return { periods, equityIrr, totalEquityDistributions, tranchePayoffQuarter, initialState };
}

/**
 * Solve the incentive fee circularity: find the fee F such that
 * the post-fee equity IRR is consistent with the fee being charged.
 *
 * Three regimes:
 *   1. Pre-fee IRR ≤ hurdle → F = 0
 *   2. Full fee AND post-fee IRR > hurdle → F = available × feePct/100
 *   3. Full fee pushes IRR below hurdle → bisect to find F where post-fee IRR ≈ hurdle
 */
export function resolveIncentiveFee(
  priorCashFlows: number[],
  availableAmount: number,
  feePct: number,
  hurdleIrr: number,
  periodsPerYear: number,
): number {
  const cf = [...priorCashFlows, availableAmount];
  const lastIdx = cf.length - 1;

  // Regime 1: no fee needed
  const preFeeIrr = calculateIrr(cf, periodsPerYear);
  if (preFeeIrr === null || preFeeIrr <= hurdleIrr) return 0;

  // Regime 2: full flat fee
  const fullFee = availableAmount * (feePct / 100);
  cf[lastIdx] = availableAmount - fullFee;
  const postFullFeeIrr = calculateIrr(cf, periodsPerYear);
  if (postFullFeeIrr !== null && postFullFeeIrr >= hurdleIrr) return fullFee;

  // Regime 3: bisect — full fee pushes IRR below hurdle
  let lo = 0;
  let hi = fullFee;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    cf[lastIdx] = availableAmount - mid;
    const midIrr = calculateIrr(cf, periodsPerYear);
    if (midIrr === null || midIrr < hurdleIrr) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return lo;
}

export function calculateIrr(cashFlows: number[], periodsPerYear: number = 4): number | null {
  if (cashFlows.length < 2) return null;
  if (cashFlows.every((cf) => cf >= 0) || cashFlows.every((cf) => cf <= 0)) return null;

  // Newton-Raphson on periodic rate, then annualize
  let rate = 0.05;

  let converged = false;
  for (let iter = 0; iter < 200; iter++) {
    let npv = 0;
    let dNpv = 0;
    for (let i = 0; i < cashFlows.length; i++) {
      const discount = Math.pow(1 + rate, i);
      npv += cashFlows[i] / discount;
      dNpv -= (i * cashFlows[i]) / Math.pow(1 + rate, i + 1);
    }
    if (Math.abs(dNpv) < 1e-12) break;
    const newRate = rate - npv / dNpv;
    if (Math.abs(newRate - rate) < 1e-9) {
      rate = newRate;
      converged = true;
      break;
    }
    rate = newRate;
    // Guard against divergence
    if (rate < -0.99) rate = -0.99;
    if (rate > 10) rate = 10;
  }

  if (!converged) return null;

  // Annualize: (1 + periodic)^periodsPerYear - 1
  const annualized = Math.pow(1 + rate, periodsPerYear) - 1;
  if (!isFinite(annualized) || isNaN(annualized)) return null;
  return annualized;
}

/**
 * Date-aware IRR using Actual/365 year-fractions, anchored at the first
 * cashflow's date. Replaces the periodic `calculateIrr` for series where
 * cashflows aren't on a uniform cadence — e.g., a since-inception sub-note
 * IRR with a deal-closing anchor, payment-date distributions, and a terminal
 * value as-of the current determination date.
 *
 * Cashflows must be sorted by date; the first row is the investment outflow
 * (negative amount), the rest are inflows.
 */
export function calculateIrrFromDatedCashflows(
  flows: Array<{ date: string; amount: number }>,
): number | null {
  if (flows.length < 2) return null;
  const hasOut = flows.some((f) => f.amount < 0);
  const hasIn = flows.some((f) => f.amount > 0);
  if (!hasOut || !hasIn) return null;

  const t0 = Date.parse(flows[0].date);
  if (!Number.isFinite(t0)) return null;
  const years: number[] = flows.map((f) => {
    const t = Date.parse(f.date);
    if (!Number.isFinite(t)) return NaN;
    return (t - t0) / (1000 * 60 * 60 * 24 * 365);
  });
  if (years.some((y) => !Number.isFinite(y))) return null;

  let rate = 0.08;
  let converged = false;
  for (let iter = 0; iter < 200; iter++) {
    let npv = 0;
    let dNpv = 0;
    for (let i = 0; i < flows.length; i++) {
      const y = years[i];
      const discount = Math.pow(1 + rate, y);
      npv += flows[i].amount / discount;
      dNpv -= (y * flows[i].amount) / Math.pow(1 + rate, y + 1);
    }
    if (Math.abs(dNpv) < 1e-12) break;
    const newRate = rate - npv / dNpv;
    if (Math.abs(newRate - rate) < 1e-9) {
      rate = newRate;
      converged = true;
      break;
    }
    rate = newRate;
    if (rate < -0.99) rate = -0.99;
    if (rate > 10) rate = 10;
  }

  if (!converged) return null;
  if (!isFinite(rate) || isNaN(rate)) return null;
  return rate;
}

export interface SensitivityRow {
  assumption: string;
  base: string;
  down: string;
  up: string;
  downIrr: number | null;
  upIrr: number | null;
}

export function computeSensitivity(
  baseInputs: ProjectionInputs,
  baseIrr: number | null,
): SensitivityRow[] {
  const scenarios: { assumption: string; base: string; down: string; up: string; makeDown: () => ProjectionInputs; makeUp: () => ProjectionInputs }[] = [
    {
      assumption: "CDR (uniform)",
      base: formatSensPct(avgCdr(baseInputs.defaultRatesByRating)),
      down: formatSensPct(Math.max(0, avgCdr(baseInputs.defaultRatesByRating) - 1)),
      up: formatSensPct(avgCdr(baseInputs.defaultRatesByRating) + 1),
      // D2b — the shifted bucket rates only take effect when the buckets are
      // in the override set (otherwise the engine uses per-position WARF).
      // Flag every bucket present in the rate map so the ±1 pct shift is
      // actually applied to the hazard path.
      makeDown: () => ({
        ...baseInputs,
        defaultRatesByRating: shiftAllRates(baseInputs.defaultRatesByRating, -1),
        overriddenBuckets: Object.keys(baseInputs.defaultRatesByRating),
      }),
      makeUp: () => ({
        ...baseInputs,
        defaultRatesByRating: shiftAllRates(baseInputs.defaultRatesByRating, 1),
        overriddenBuckets: Object.keys(baseInputs.defaultRatesByRating),
      }),
    },
    {
      assumption: "CPR",
      base: formatSensPct(baseInputs.cprPct),
      down: formatSensPct(Math.max(0, baseInputs.cprPct - 5)),
      up: formatSensPct(baseInputs.cprPct + 5),
      makeDown: () => ({ ...baseInputs, cprPct: Math.max(0, baseInputs.cprPct - 5) }),
      makeUp: () => ({ ...baseInputs, cprPct: baseInputs.cprPct + 5 }),
    },
    {
      assumption: "Base Rate",
      base: formatSensPct(baseInputs.baseRatePct),
      down: formatSensPct(Math.max(0, baseInputs.baseRatePct - 1)),
      up: formatSensPct(baseInputs.baseRatePct + 1),
      makeDown: () => ({ ...baseInputs, baseRatePct: Math.max(0, baseInputs.baseRatePct - 1) }),
      makeUp: () => ({ ...baseInputs, baseRatePct: baseInputs.baseRatePct + 1 }),
    },
    {
      assumption: "Recovery Rate",
      base: formatSensPct(baseInputs.recoveryPct),
      down: formatSensPct(Math.max(0, baseInputs.recoveryPct - 10)),
      up: formatSensPct(Math.min(100, baseInputs.recoveryPct + 10)),
      makeDown: () => ({ ...baseInputs, recoveryPct: Math.max(0, baseInputs.recoveryPct - 10) }),
      makeUp: () => ({ ...baseInputs, recoveryPct: Math.min(100, baseInputs.recoveryPct + 10) }),
    },
    {
      assumption: "Reinvestment Spread",
      base: `${baseInputs.reinvestmentSpreadBps} bps`,
      down: `${Math.max(0, baseInputs.reinvestmentSpreadBps - 50)} bps`,
      up: `${baseInputs.reinvestmentSpreadBps + 50} bps`,
      makeDown: () => ({ ...baseInputs, reinvestmentSpreadBps: Math.max(0, baseInputs.reinvestmentSpreadBps - 50) }),
      makeUp: () => ({ ...baseInputs, reinvestmentSpreadBps: baseInputs.reinvestmentSpreadBps + 50 }),
    },
  ];

  const rows: SensitivityRow[] = scenarios.map((s) => {
    if (baseIrr === null) {
      return { assumption: s.assumption, base: s.base, down: s.down, up: s.up, downIrr: null, upIrr: null };
    }
    const downResult = runProjection(s.makeDown());
    const upResult = runProjection(s.makeUp());
    return {
      assumption: s.assumption,
      base: s.base,
      down: s.down,
      up: s.up,
      downIrr: downResult.equityIrr,
      upIrr: upResult.equityIrr,
    };
  });

  rows.sort((a, b) => {
    const impactA = Math.max(Math.abs((a.downIrr ?? 0) - (baseIrr ?? 0)), Math.abs((a.upIrr ?? 0) - (baseIrr ?? 0)));
    const impactB = Math.max(Math.abs((b.downIrr ?? 0) - (baseIrr ?? 0)), Math.abs((b.upIrr ?? 0) - (baseIrr ?? 0)));
    return impactB - impactA;
  });

  return rows;
}

function formatSensPct(val: number): string {
  return `${val.toFixed(1)}%`;
}

function avgCdr(rates: Record<string, number>): number {
  const vals = Object.values(rates);
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
}

function shiftAllRates(rates: Record<string, number>, delta: number): Record<string, number> {
  const shifted: Record<string, number> = {};
  for (const [k, v] of Object.entries(rates)) {
    shifted[k] = Math.max(0, v + delta);
  }
  return shifted;
}
