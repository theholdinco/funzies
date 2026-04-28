// web/lib/clo/extraction/json-ingest/ppm-mapper.ts

import type {
  PpmJson,
  PpmJsonTranche,
  PpmJsonTransactionParty,
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
      const sub = deferralBlock.subordinated_notes?.deferral_permitted;
      if (sub === true) return true;
      if (sub === false) return false;
      // "n/a" or missing → not deferrable in the rated sense
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
  return {
    coverageTestEntries: entries,
    reinvestmentOcTest: reinv ? {
      trigger: `${reinv.required_ratio_pct}%`,
      appliesDuring: reinv.description ?? undefined,
      diversionAmount: reinv.trigger_action ?? undefined,
    } : undefined,
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
  return { fees, accounts: [], _feesProvenance: feesProvenance ?? undefined };
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
    _poolProvenance: portfolioProvenance ?? undefined,
  };
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
