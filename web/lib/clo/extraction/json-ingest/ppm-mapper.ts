// web/lib/clo/extraction/json-ingest/ppm-mapper.ts

import type {
  PpmJson,
  PpmJsonTranche,
  PpmJsonTransactionParty,
  IndustryCapAppliesWhenJson,
} from "./types";
import { pctToBps, decimalSpreadToBps, parseFlexibleDate } from "./utils";

export type PpmSections = Record<string, Record<string, unknown>>;

// PPM-side Zod schemas use `z.string().optional()` — meaning `string | undefined`,
// NOT `string | null`. null values WILL fail safeParse. All mapper fields that
// might be absent must use `?? undefined`, and any `parseFlexibleDate` result
// must be coerced with `?? undefined` before being placed into a PPM-schema field.
const u = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

function mapTransactionOverview(ppm: PpmJson): Record<string, unknown> {
  const di = ppm.section_1_deal_identity;
  const cm = di.transaction_parties.find((p) => p.role === "Collateral Manager");
  return {
    dealName: di.legal_name,
    issuerLegalName: di.legal_name,
    collateralManager: u(cm?.entity),
    jurisdiction: u(di.jurisdiction),
    entityType: u(di.entity_form),
    governingLaw: u(di.jurisdiction),
    currency: u(ppm.meta.reporting_currency as string | undefined),
    listingExchange: u(di.listing),
  };
}

function mapCapitalStructure(ppm: PpmJson): Record<string, unknown> {
  const tranches = ppm.section_3_capital_structure.tranches;

  // section_7_interest_mechanics.interest_deferral is keyed by snake_case base
  // class (class_a, class_b, ...). Sub-classes (B-1, B-2) inherit from base.
  // Subordinated has "n/a" — residual notes don't accrue/defer like rated notes,
  // so we map that to false (not deferrable in the rated-note sense).
  const deferralBlock = (ppm as unknown as { section_7_interest_mechanics?: { interest_deferral?: Record<string, { deferral_permitted: boolean | string }> } })
    .section_7_interest_mechanics?.interest_deferral ?? {};
  const deferrableForClass = (className: string): boolean | undefined => {
    const lc = className.toLowerCase().trim();
    if (/sub|subordinated|residual|equity|income/.test(lc)) {
      // Subordinated/residual notes don't have a stated coupon — the engine's
      // deferral mechanic (PIK shortfalls onto class balance) is meaningless
      // for them. Force false regardless of what the LLM extracted from the
      // PPM's interest_deferral block; misclassification here would cause the
      // engine to PIK residual shortfalls onto sub-note balance, inflating
      // book value and IRR by potentially millions.
      return false;
    }
    // Base class: "Class B-1" → "b" → look up "class_b"
    const stripped = lc.replace(/^class\s+/, "");
    const baseLetter = stripped.match(/^([a-z])/)?.[1];
    if (!baseLetter) return undefined;
    const entry = deferralBlock[`class_${baseLetter}`];
    if (!entry) return undefined;
    if (typeof entry.deferral_permitted === "boolean") return entry.deferral_permitted;
    return undefined;
  };

  return {
    capitalStructure: tranches.map((t: PpmJsonTranche) => {
      const spreadBps =
        t.margin_decimal != null ? decimalSpreadToBps(t.margin_decimal)
        : t.spread_pct != null ? pctToBps(t.spread_pct)
        : t.fixed_coupon_decimal != null ? decimalSpreadToBps(t.fixed_coupon_decimal)
        : t.fixed_coupon_pct != null ? pctToBps(t.fixed_coupon_pct)
        : null;
      const isSub = /sub|subordinated|residual/i.test(t.class) || t.rate_type === "residual";
      return {
        class: t.class,
        principalAmount: String(t.principal),
        rateType: t.rate_type ?? undefined,   // ppmCapitalStructure schema is string | undefined (not nullable)
        referenceRate: t.rate_type === "floating" ? "EURIBOR" : undefined,
        spreadBps: spreadBps ?? undefined,
        rating: {
          fitch: t.fitch ?? undefined,
          moodys: t.moodys ?? undefined,
        },
        isSubordinated: isSub,
        deferrable: deferrableForClass(t.class),
        maturityDate: parseFlexibleDate(ppm.section_3_capital_structure.common_maturity as string | undefined) ?? undefined,
      };
    }),
    dealSizing: {
      targetParAmount: ppm.section_1_deal_identity.target_par_amount?.amount != null
        ? String(ppm.section_1_deal_identity.target_par_amount.amount)
        : undefined,
      totalRatedNotes: ppm.section_3_capital_structure.rated_notes_principal != null
        ? String(ppm.section_3_capital_structure.rated_notes_principal)
        : undefined,
      totalSubordinatedNotes: ppm.section_3_capital_structure.subordinated_principal != null
        ? String(ppm.section_3_capital_structure.subordinated_principal)
        : undefined,
      totalDealSize: ppm.section_3_capital_structure.total_principal != null
        ? String(ppm.section_3_capital_structure.total_principal)
        : undefined,
    },
  };
}

function mapKeyDates(ppm: PpmJson): Record<string, unknown> {
  const kd = ppm.section_2_key_dates;
  return {
    originalIssueDate: u(parseFlexibleDate(kd.issue_date)),
    currentIssueDate: u(parseFlexibleDate(kd.effective_date_actual)),
    maturityDate: u(parseFlexibleDate(kd.stated_maturity)),
    nonCallPeriodEnd: u(parseFlexibleDate(kd.non_call_period_end)),
    reinvestmentPeriodEnd: u(parseFlexibleDate(kd.reinvestment_period_end)),
    firstPaymentDate: u(parseFlexibleDate(kd.first_payment_date)),
    paymentFrequency: u(kd.payment_frequency),
  };
}

function mapKeyParties(ppm: PpmJson): Record<string, unknown> {
  const parties = ppm.section_1_deal_identity.transaction_parties;
  const cm = parties.find((p) => p.role === "Collateral Manager");
  return {
    keyParties: parties.map((p: PpmJsonTransactionParty) => ({
      role: p.role,
      entity: p.entity,
    })),
    cmDetails: cm ? { name: cm.entity, parent: undefined, replacementMechanism: undefined } : undefined,
  };
}

function mapCoverageTests(ppm: PpmJson): Record<string, unknown> {
  const ct = ppm.section_4_coverage_tests;
  // Build one entry per class_group, combining PV + IC on the same class_group.
  // Schema expects `class`, `parValueRatio` (string), `interestCoverageRatio` (string).
  const byClass = new Map<string, { pv?: number; ic?: number }>();
  for (const p of ct.par_value_tests) {
    const entry = byClass.get(p.class_group) ?? {};
    entry.pv = p.required_ratio_pct;
    byClass.set(p.class_group, entry);
  }
  for (const i of ct.interest_coverage_tests) {
    const entry = byClass.get(i.class_group) ?? {};
    entry.ic = i.required_ratio_pct;
    byClass.set(i.class_group, entry);
  }
  const entries = Array.from(byClass.entries()).map(([klass, v]) => ({
    class: klass,
    parValueRatio: v.pv != null ? `${v.pv}%` : undefined,
    interestCoverageRatio: v.ic != null ? `${v.ic}%` : undefined,
  }));
  const reinv = ct.reinvestment_oc_test;
  const cccAdj = ct.excess_ccc_adjustment;
  return {
    coverageTestEntries: entries,
    reinvestmentOcTest: reinv ? {
      trigger: `${reinv.required_ratio_pct}%`,
      appliesDuring: reinv.description ?? undefined,
      diversionAmount: reinv.trigger_action ?? undefined,
    } : undefined,
    // Outer-nullable, inner-required. Pass null through so the
    // normalizer/resolver can distinguish "PPM JSON ingested but no Excess
    // CCC Adjustment field" from "field present with values".
    excessCccAdjustment: cccAdj
      ? { thresholdPct: String(cccAdj.threshold_pct), marketValuePct: String(cccAdj.market_value_pct) }
      : cccAdj === null ? null : undefined,
    // Preserve EoD hybrid composition as passthrough (schema is .passthrough())
    eventOfDefaultParValueTest: ct.event_of_default_par_value_test,
  };
}

/** E1 (Sprint 5) — derive a normalized provenance object from a ppm.json
 *  section's `source_pages` (number[] | object) + `source_condition`. Returns
 *  null when neither field is set. The `pageSelector` lets callers pick a
 *  sub-key for sections whose source_pages is a structured map (e.g.
 *  section_8 carries `{portfolio_profile: [...], collateral_quality_tests: [...]}`). */
function deriveSectionProvenance(
  section: { source_pages?: unknown; source_condition?: unknown } | null | undefined,
  pageSelector?: (pagesObj: Record<string, unknown>) => number[] | null,
): { source_pages: number[] | null; source_condition: string | null } | null {
  if (!section) return null;
  let pages: number[] | null = null;
  const rawPages = section.source_pages;
  if (Array.isArray(rawPages)) {
    pages = rawPages.filter((p): p is number => typeof p === "number");
  } else if (rawPages && typeof rawPages === "object" && pageSelector) {
    pages = pageSelector(rawPages as Record<string, unknown>);
  }
  const cond = typeof section.source_condition === "string" ? section.source_condition : null;
  if ((pages == null || pages.length === 0) && cond == null) return null;
  return { source_pages: pages, source_condition: cond };
}

function mapFeesAndExpenses(ppm: PpmJson): Record<string, unknown> {
  const feesProvenance = deriveSectionProvenance(ppm.section_5_fees_and_hurdle as { source_pages?: unknown; source_condition?: unknown });
  const fees = ppm.section_5_fees_and_hurdle.fees.map((f) => {
    const ratePctPa = f.rate_pct_pa;
    const ratePct = f.rate_pct;
    const rate = ratePctPa != null ? String(ratePctPa)
      : ratePct != null ? String(ratePct)
      : (f.rate as string | undefined);
    const rateUnit =
      ratePctPa != null ? "pct_pa"
      : ratePct != null && f.name?.toLowerCase().includes("incentive") ? "pct_of_residual"
      : f.rate === "Per Trust Deed" || f.rate === "Per Condition 1 definition" ? "per_agreement"
      : ratePct != null ? "pct_pa"
      : null;
    return {
      name: f.name,
      rate,
      rateUnit,
      basis: f.basis ?? undefined,
      description: [f.waterfall_clause, f.seniority, f.trigger, f.vat_treatment].filter(Boolean).join("; ") || undefined,
      hurdleRate: f.trigger === "Incentive Fee IRR Threshold"
        ? ppm.section_5_fees_and_hurdle.incentive_fee_irr_threshold?.threshold_pct_pa != null
          ? `${ppm.section_5_fees_and_hurdle.incentive_fee_irr_threshold.threshold_pct_pa}%`
          : undefined
        : undefined,
    };
  });
  return {
    fees,
    accounts: [],
    seniorExpensesCap: mapSeniorExpensesCap(ppm),
    discountObligation: mapDiscountObligation(ppm),
    longDatedObligation: mapLongDatedObligation(ppm),
    _feesProvenance: feesProvenance ?? undefined,
  };
}

/** Read the Condition 1 Senior Expenses Cap structured definition from
 *  ppm.json into a typed shape consumed by the resolver. */
function mapSeniorExpensesCap(ppm: PpmJson): unknown {
  const block = ppm.section_5_fees_and_hurdle.senior_expenses_cap;
  if (!block) return null;
  const bpsPerYear =
    typeof block.bps_per_annum === "number" ? block.bps_per_annum : null;
  if (bpsPerYear == null) return null;
  const allocation = block.allocation_within_cap;
  const overflow = block.overflow_allocation;
  const componentADayCount = (block as { component_a_day_count?: unknown })
    .component_a_day_count;
  const vatRatePct = (block as { vat_rate_pct?: unknown }).vat_rate_pct;
  return {
    bpsPerYear,
    absoluteFloorEurPerYear:
      typeof block.absolute_floor_eur_per_annum === "number"
        ? block.absolute_floor_eur_per_annum
        : null,
    componentADayCount:
      componentADayCount === "actual_360" ? "actual_360" : "30_360_after_first",
    base: block.base === "APB" ? "APB" : "CPA",
    period: block.period === "per_annum" ? "per_annum" : "per_payment_date",
    allocationWithinCap:
      allocation === "pro_rata" ? "pro_rata" : "sequential_b_first",
    overflowAllocation:
      overflow === "pro_rata" ? "pro_rata" : "sequential_y_first",
    carryforwardPeriods:
      typeof block.carryforward_periods === "number"
        ? block.carryforward_periods
        : null,
    vatIncluded: block.vat_included === true,
    vatRatePct: typeof vatRatePct === "number" ? vatRatePct : null,
    sourcePages: Array.isArray(block.source_pages)
      ? block.source_pages.filter((p): p is number => typeof p === "number")
      : null,
    sourceCondition:
      typeof (block as { source_condition?: unknown }).source_condition === "string"
        ? ((block as { source_condition?: string }).source_condition ?? null)
        : null,
  };
}

/** Read the Condition 1 Discount Obligation structured definition from
 *  ppm.json into a typed shape consumed by the resolver. Mirrors the
 *  ResolvedDiscountObligationRule discriminated union shape directly so
 *  resolver consumption is mechanical (no field-level renaming). Drops
 *  null/missing if any structurally-required field absent — resolver
 *  then emits a blocking warning on the missing rule. */
function mapDiscountObligation(ppm: PpmJson): unknown {
  const block = ppm.section_5_fees_and_hurdle.discount_obligation;
  if (!block) return null;
  const classification = block.classification_threshold;
  const cure = block.cure_mechanic;
  if (!classification || !cure) return null;

  const mapThreshold = (t: typeof classification): unknown => {
    if (t.type === "single") {
      return { type: "single", pct: t.pct };
    }
    return {
      type: "split_by_rate_type",
      floatingPct: t.floating_pct,
      fixedPct: t.fixed_pct,
    };
  };

  let cureMechanicMapped: unknown;
  if (cure.type === "continuous_threshold") {
    cureMechanicMapped = {
      type: "continuous_threshold",
      cureThresholdPct: mapThreshold(cure.cure_threshold),
      cureWindow:
        cure.cure_window.type === "days"
          ? { type: "days", n: cure.cure_window.n }
          : { type: "payment_dates", n: cure.cure_window.n },
    };
  } else {
    cureMechanicMapped = { type: "permanent_until_paid" };
  }

  return {
    classificationThresholdPct: mapThreshold(classification),
    cureMechanic: cureMechanicMapped,
    sourcePages: Array.isArray(block.source_pages)
      ? block.source_pages.filter((p): p is number => typeof p === "number")
      : null,
    sourceCondition:
      typeof block.source_condition === "string" ? block.source_condition : null,
  };
}

/** Read the Conditions 1 + APB(e) "Long-Dated Collateral Obligation"
 *  valuation rule from ppm.json into a typed shape consumed by the
 *  resolver. Mirrors the ResolvedLongDatedValuationRule discriminated
 *  union shape (snake_case → camelCase). Returns null if any
 *  structurally-required field is absent — resolver then emits a
 *  blocking warning on the missing rule. */
function mapLongDatedObligation(ppm: PpmJson): unknown {
  const block = ppm.section_5_fees_and_hurdle.long_dated_obligation;
  if (!block) return null;
  if (
    typeof block.cap_pct_of_base !== "number" ||
    (block.cap_base !== "APB" && block.cap_base !== "CPA") ||
    !block.within_cap ||
    !block.post_cap
  ) {
    return null;
  }

  let withinCap: unknown;
  if (block.within_cap.type === "par") {
    withinCap = { type: "par" };
  } else if (block.within_cap.type === "tiered_mv_or_capped") {
    // Validate the variant's required numeric fields. Untyped passthrough
    // would surface as NaN haircuts in the engine (silent — every OC test
    // appears failing with no warning); resolver handles null with a
    // blocking warning instead.
    if (
      typeof block.within_cap.cliff_years_past_stated_maturity !== "number" ||
      typeof block.within_cap.capped_price_pct !== "number"
    ) {
      return null;
    }
    withinCap = {
      type: "tiered_mv_or_capped",
      cliffYearsPastStatedMaturity: block.within_cap.cliff_years_past_stated_maturity,
      cappedPricePct: block.within_cap.capped_price_pct,
    };
  } else {
    return null;
  }
  let postCap: unknown;
  if (block.post_cap.type === "zero") {
    postCap = { type: "zero" };
  } else if (block.post_cap.type === "agency_cv_min") {
    postCap = { type: "agency_cv_min" };
  } else {
    return null;
  }

  return {
    capPctOfBase: block.cap_pct_of_base,
    capBase: block.cap_base,
    withinCap,
    postCap,
    sourcePages: Array.isArray(block.source_pages)
      ? block.source_pages.filter((p): p is number => typeof p === "number")
      : null,
    sourceCondition:
      typeof block.source_condition === "string" ? block.source_condition : null,
  };
}

function mapPortfolioConstraints(ppm: PpmJson): Record<string, unknown> {
  const sec = ppm.section_8_portfolio_and_quality_tests;
  const limits = sec.portfolio_profile_limits_selected ?? [];
  const quality = sec.collateral_quality_tests ?? [];
  const portfolioProfileTests: Record<string, { min?: string | null; max?: string | null; notes?: string }> = {};
  for (const l of limits) {
    portfolioProfileTests[l.bucket] = {
      min: l.direction === ">=" ? String(l.limit_pct) : null,
      max: l.direction === "<=" ? String(l.limit_pct) : null,
      notes: l.note ?? l.basis,
    };
  }
  // section_8.source_pages is a structured object — collect every page from
  // portfolio_profile + collateral_quality_tests for the pool-summary citation.
  const portfolioProvenance = deriveSectionProvenance(sec as { source_pages?: unknown; source_condition?: unknown }, (obj) => {
    const collected: number[] = [];
    for (const key of ["portfolio_profile", "collateral_quality_tests"]) {
      const v = obj[key];
      if (Array.isArray(v)) for (const p of v) if (typeof p === "number") collected.push(p);
    }
    return collected.length > 0 ? collected : null;
  });
  return {
    collateralQualityTests: quality.map((q) => ({
      name: q.test,
      agency: /moody/i.test(q.test) ? "Moody's" : /fitch/i.test(q.test) ? "Fitch" : undefined,
      value: q.description ?? null,
    })),
    portfolioProfileTests,
    industryConcentrationTest: mapIndustryConcentrationTest(ppm),
    _poolProvenance: portfolioProvenance ?? undefined,
  };
}

/** Map clause (t) — industry concentration cap — from ppm.json into a typed
 *  shape consumed by the resolver. KI-23 closure.
 *
 *  Failure-closed discipline (anti-pattern #3):
 *   - Whole block missing/null → present:null (resolver decides whether to
 *     block based on SDF evidence).
 *   - present:false → no constraint.
 *   - present:true with no taxonomy → present:true, rules:null (resolver blocks).
 *   - present:true with one unrecognized rule kind → present:true, rules:null
 *     (resolver blocks). NOT a silent drop — any unmapped kind taints the
 *     entire extraction.
 *   - present:true with non-empty unmapped_rule_descriptions → present:true,
 *     rules:null (resolver blocks).
 *
 *  Snake_case → camelCase translation; structurally invalid rules drop the
 *  entire rule set.
 *
 *  Exported for direct unit testing — `mapPpm` invokes this via
 *  `mapPortfolioConstraints`; tests can also call it with a fixture
 *  block without constructing a full PpmJson. */
export function mapIndustryConcentrationTest(ppm: PpmJson): unknown {
  const block = ppm.section_8_portfolio_and_quality_tests.industry_concentration_test;
  if (!block) return null;

  const sourcePages = Array.isArray(block.source_pages)
    ? block.source_pages.filter((p): p is number => typeof p === "number")
    : null;
  const sourceCondition = typeof block.source_condition === "string" ? block.source_condition : null;
  const verbatimQuote = typeof block.verbatim_quote === "string" ? block.verbatim_quote : null;

  if (block.present === false) {
    return {
      present: false,
      taxonomy: null,
      rules: null,
      excludedIndustryNames: null,
      dealSpecificIndustryList: null,
      sourcePages,
      sourceCondition,
      verbatimQuote,
    };
  }

  const taxonomy =
    block.taxonomy === "moodys_33" || block.taxonomy === "sp" || block.taxonomy === "deal_specific"
      ? block.taxonomy
      : null;

  const unmapped = Array.isArray(block.unmapped_rule_descriptions)
    ? block.unmapped_rule_descriptions.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];

  // Any unmapped sub-rule taints the extraction — resolver must block rather
  // than enforce a partial rule set. Returning rules:null fires the gate.
  if (unmapped.length > 0) {
    return {
      present: true,
      taxonomy,
      rules: null,
      excludedIndustryNames: Array.isArray(block.excluded_industry_names)
        ? block.excluded_industry_names.filter((s): s is string => typeof s === "string")
        : null,
      dealSpecificIndustryList: Array.isArray(block.deal_specific_industry_list)
        ? block.deal_specific_industry_list.filter((s): s is string => typeof s === "string")
        : null,
      unmappedRuleDescriptions: unmapped,
      sourcePages,
      sourceCondition,
      verbatimQuote,
    };
  }

  if (!taxonomy) {
    return {
      present: true,
      taxonomy: null,
      rules: null,
      excludedIndustryNames: null,
      dealSpecificIndustryList: null,
      sourcePages,
      sourceCondition,
      verbatimQuote,
    };
  }

  const rulesRaw = Array.isArray(block.rules) ? block.rules : [];
  const rules: unknown[] = [];
  let anyRejected = false;
  for (const r of rulesRaw) {
    const appliesWhen = mapAppliesWhen(r.applies_when);
    if (r.kind === "single_rank_max" && typeof r.rank === "number" && typeof r.trigger_pct === "number") {
      rules.push({ kind: "single_rank_max", rank: r.rank, triggerPct: r.trigger_pct, ...(appliesWhen ? { appliesWhen } : {}) });
    } else if (r.kind === "combined_top_n_max" && typeof r.n === "number" && typeof r.trigger_pct === "number") {
      rules.push({ kind: "combined_top_n_max", n: r.n, triggerPct: r.trigger_pct, ...(appliesWhen ? { appliesWhen } : {}) });
    } else if (
      r.kind === "single_class_max" &&
      typeof r.industry_name === "string" &&
      typeof r.trigger_pct === "number"
    ) {
      rules.push({
        kind: "single_class_max",
        industryName: r.industry_name,
        industryCode: typeof r.industry_code === "string" ? r.industry_code : "",
        triggerPct: r.trigger_pct,
        ...(appliesWhen ? { appliesWhen } : {}),
      });
    } else if (
      r.kind === "count_above_threshold" &&
      typeof r.threshold_pct === "number" &&
      typeof r.max_count === "number"
    ) {
      rules.push({
        kind: "count_above_threshold",
        thresholdPct: r.threshold_pct,
        maxCount: r.max_count,
        ...(appliesWhen ? { appliesWhen } : {}),
      });
    } else {
      // Unknown kind OR known kind with malformed numerics — taint the
      // whole extraction so the resolver blocks rather than silently
      // applying the partial rule set.
      anyRejected = true;
    }
  }

  return {
    present: true,
    taxonomy,
    rules: anyRejected ? null : rules,
    excludedIndustryNames: Array.isArray(block.excluded_industry_names)
      ? block.excluded_industry_names.filter((s): s is string => typeof s === "string")
      : null,
    dealSpecificIndustryList: Array.isArray(block.deal_specific_industry_list)
      ? block.deal_specific_industry_list.filter((s): s is string => typeof s === "string")
      : null,
    sourcePages,
    sourceCondition,
    verbatimQuote,
  };
}

function mapAppliesWhen(j: IndustryCapAppliesWhenJson | undefined): unknown {
  if (!j) return null;
  switch (j.kind) {
    case "during_reinvestment_period":
    case "post_reinvestment_period":
      return { kind: j.kind };
    case "ccc_pct_above":
    case "defaulted_pct_above":
      if (typeof j.threshold_pct !== "number") return null;
      return { kind: j.kind, thresholdPct: j.threshold_pct };
  }
}

function mapWaterfallRules(ppm: PpmJson): Record<string, unknown> {
  const wf = ppm.section_6_waterfall;
  const serializeClauses = (clauses: Array<{ clause: string; application: string }>): string =>
    clauses.map((c) => `(${c.clause}) ${c.application}`).join("\n");
  return {
    interestPriority: serializeClauses(wf.interest_priority_of_payments.clauses),
    principalPriority: serializeClauses(wf.principal_priority_of_payments.clauses),
    postAcceleration: wf.post_acceleration_priority_of_payments?.sequence_summary ?? undefined,  // ppmWaterfallRulesSchema is string | undefined, NOT nullable
  };
}

function mapInterestMechanics(ppm: PpmJson): Record<string, unknown> {
  // Schema is passthrough; dump section_7 verbatim.
  return { ...ppm.section_7_interest_mechanics };
}

export function mapPpm(ppm: PpmJson): PpmSections {
  return {
    transaction_overview: mapTransactionOverview(ppm),
    capital_structure: mapCapitalStructure(ppm),
    key_dates: mapKeyDates(ppm),
    key_parties: mapKeyParties(ppm),
    coverage_tests: mapCoverageTests(ppm),
    fees_and_expenses: mapFeesAndExpenses(ppm),
    portfolio_constraints: mapPortfolioConstraints(ppm),
    waterfall_rules: mapWaterfallRules(ppm),
    interest_mechanics: mapInterestMechanics(ppm),
  };
}
