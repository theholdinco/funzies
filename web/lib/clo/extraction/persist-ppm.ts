import type { Pool } from "pg";
import { normalizeClassName } from "../api";
import type { CapitalStructureEntry } from "../types/index";
import { parseNumeric, parseDecoratedAmount } from "../sdf/csv-utils";
import { assignDenseSeniorityRanks } from "../seniority-rank";
import { canonicalCurrency } from "../currency";
import { normalizePaymentFrequency } from "../payment-frequency";

function parseAmount(s: string | undefined | null): number | null {
  return parseDecoratedAmount(s);
}

function parseSpreadBps(s: string | undefined | null): number | null {
  if (!s) return null;
  const str = String(s).trim();
  if (str === "N/A" || str === "-" || str === "") return null;
  // Match patterns like "SOFR + 145bps", "E + 1.50%", "145 bps", "1.45%",
  // "+1,5%" (European). The digit capture is locale-permissive ([\d.,]+) so
  // European-format numbers reach the unit-conversion branch instead of falling
  // through to the plain-number fallback (which would silently drop the %→bps
  // conversion).
  const bpsMatch = str.match(/([\d.,]+)\s*bps/i);
  if (bpsMatch) return parseNumeric(bpsMatch[1]);
  // `[+]?` — the leading `+` is optional. Pre-fix the regex required `+`,
  // which meant "1.45%" (a bare percent string with no SOFR/E + base) silently
  // fell through to the plain-number branch and was misinterpreted as bps
  // (1.45 bps instead of 145 bps). Now both "+1.45%" and "1.45%" reach the
  // unit-conversion branch.
  const pctMatch = str.match(/[+]?\s*([\d.,]+)\s*%/);
  if (pctMatch) {
    const pct = parseNumeric(pctMatch[1]);
    return pct != null ? pct * 100 : null;
  }
  const perCentMatch = str.match(/([\d.,]+)\s*per\s*cent/i);
  if (perCentMatch) {
    const pct = parseNumeric(perCentMatch[1]);
    return pct != null ? pct * 100 : null;
  }
  // Fallback: plain number from a column labeled "Spread (bps)" — locale-aware.
  // Accept 0 (an index-flat floating-rate note has spreadBps = 0 — valid input,
  // not a parser failure). Negative values fall through to null (no real
  // spread is negative).
  const plainNum = parseNumeric(str);
  if (plainNum != null && plainNum >= 0) return plainNum;
  return null;
}

export async function syncPpmToRelationalTables(
  pool: Pool,
  profileId: string,
  extractedConstraints: Record<string, unknown>,
): Promise<void> {
  const isNullish = (v: unknown) => v == null || v === "null";

  // Look up or create deal
  let deals = await pool.query<{ id: string }>(
    "SELECT id FROM clo_deals WHERE profile_id = $1",
    [profileId],
  );
  if (deals.rows.length === 0) {
    // Deal doesn't exist yet (PPM extraction ran before compliance report).
    // Create it from the extracted constraints so tranches can be linked.
    const di = (extractedConstraints.dealIdentity ?? {}) as Record<string, string>;
    const kd = (extractedConstraints.keyDates ?? {}) as Record<string, string>;
    const cm = (extractedConstraints.cmDetails ?? {}) as Record<string, string>;
    deals = await pool.query<{ id: string }>(
      `INSERT INTO clo_deals (
        profile_id, deal_name, issuer_legal_entity, jurisdiction, deal_currency,
        deal_currency_raw, deal_currency_canonical, deal_currency_source,
        closing_date, effective_date, reinvestment_period_end, non_call_period_end,
        stated_maturity_date, collateral_manager, governing_law, ppm_constraints
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING id`,
      [
        profileId,
        di.dealName ?? null,
        di.issuerLegalName ?? null,
        di.jurisdiction ?? null,
        canonicalCurrency(di.currency) ?? di.currency ?? null,
        di.currency ?? null,
        canonicalCurrency(di.currency),
        di.currency ? "ppm" : null,
        kd.originalIssueDate ?? null,
        kd.currentIssueDate ?? null,
        kd.reinvestmentPeriodEnd ?? null,
        kd.nonCallPeriodEnd ?? null,
        kd.maturityDate ?? null,
        cm.name ?? (extractedConstraints.collateralManager as string) ?? null,
        di.governingLaw ?? null,
        JSON.stringify(extractedConstraints),
      ],
    );
    console.log(`[worker] syncPpm: created deal ${deals.rows[0].id} for profile ${profileId}`);
  }
  const dealId = deals.rows[0].id;
  const dealIdentity = (extractedConstraints.dealIdentity ?? {}) as Record<string, string>;
  const keyDateMetadata = (extractedConstraints.keyDates ?? {}) as Record<string, string>;
  const dealMetadataClauses: string[] = [];
  const dealMetadataValues: unknown[] = [];
  let md = 1;
  const addMetadataIfPresent = (column: string, value: unknown, overwrite = false) => {
    if (isNullish(value) || value === "") return;
    dealMetadataClauses.push(
      overwrite
        ? `${column} = $${md++}`
        : `${column} = CASE WHEN ${column} IS NULL OR ${column}::text = '' THEN $${md++} ELSE ${column} END`,
    );
    dealMetadataValues.push(value);
  };
  addMetadataIfPresent("deal_name", dealIdentity.dealName);
  addMetadataIfPresent("issuer_legal_entity", dealIdentity.issuerLegalName);
  addMetadataIfPresent("jurisdiction", dealIdentity.jurisdiction);
  addMetadataIfPresent("deal_currency", canonicalCurrency(dealIdentity.currency) ?? dealIdentity.currency, true);
  addMetadataIfPresent("deal_currency_raw", dealIdentity.currency, true);
  addMetadataIfPresent("deal_currency_canonical", canonicalCurrency(dealIdentity.currency), true);
  addMetadataIfPresent("deal_currency_source", dealIdentity.currency ? "ppm" : null, true);
  addMetadataIfPresent("governing_law", dealIdentity.governingLaw);
  addMetadataIfPresent("closing_date", keyDateMetadata.originalIssueDate);
  addMetadataIfPresent("effective_date", keyDateMetadata.currentIssueDate);
  if (dealMetadataClauses.length > 0) {
    dealMetadataValues.push(dealId);
    await pool.query(
      `UPDATE clo_deals SET ${dealMetadataClauses.join(", ")} WHERE id = $${md}`,
      dealMetadataValues,
    );
  }

  // Sync capital structure → clo_tranches
  const capitalStructure = (extractedConstraints.capitalStructure ?? []) as CapitalStructureEntry[];
  if (capitalStructure.length === 0) {
    console.log(`[worker] syncPpm: no capital structure entries, skipping tranche sync`);
    return;
  }

  // Sort: non-subordinated first (by array order), subordinated last
  const sorted = [...capitalStructure];
  sorted.sort((a, b) => {
    if (a.isSubordinated && !b.isSubordinated) return 1;
    if (!a.isSubordinated && b.isSubordinated) return -1;
    return 0;
  });

  // Pari-passu collapse: A-1+A-2 share rank 1, B-1+B-2 share rank 2, etc. The
  // engine groups by equal `seniorityRank` for pari-passu absorption — see
  // `web/lib/clo/seniority-rank.ts` for the rule and the resolver-side mirror.
  const denseRanks = assignDenseSeniorityRanks(
    sorted.map((e) => ({ className: e.class, isSubordinated: e.isSubordinated })),
  );

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const normalizedName = normalizeClassName(entry.class);

    // Find or create tranche
    const allTranches = await pool.query<{ id: string; class_name: string }>(
      "SELECT id, class_name FROM clo_tranches WHERE deal_id = $1",
      [dealId],
    );
    let tranche = allTranches.rows.find((t) => normalizeClassName(t.class_name) === normalizedName);

    if (!tranche) {
      const inserted = await pool.query<{ id: string; class_name: string }>(
        `INSERT INTO clo_tranches (deal_id, class_name) VALUES ($1, $2) RETURNING id, class_name`,
        [dealId, entry.class],
      );
      tranche = inserted.rows[0];
    }

    // Build update
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let pi = 1;

    // Detect subordinated/equity tranches by flag OR name pattern (needed before spread default)
    const isSub = entry.isSubordinated ??
      (/\b(sub|equity|income|residual)\b/i.test(entry.class) ||
       /\b(sub|equity|income|residual)\b/i.test(entry.designation ?? ""));

    let spreadBps = entry.spreadBps ?? parseSpreadBps(entry.spread);
    // Guard: if AI returned percentage (e.g., 1.45) instead of bps (145), convert
    if (spreadBps != null && spreadBps > 0 && spreadBps < 20) {
      spreadBps = Math.round(spreadBps * 100);
    }
    // Income notes (sub/equity) get residual cash flows, default spread to 0
    if (spreadBps == null && isSub) spreadBps = 0;
    if (spreadBps != null) {
      setClauses.push(`spread_bps = $${pi++}`);
      values.push(spreadBps);
    }

    const balance = parseAmount(entry.principalAmount);
    if (balance != null) {
      setClauses.push(`original_balance = $${pi++}`);
      values.push(balance);
    }

    if (entry.rateType) {
      setClauses.push(`is_floating = $${pi++}`);
      values.push(entry.rateType.toLowerCase() === "floating");
    } else if (isSub) {
      // Income notes are not floating-rate
      setClauses.push(`is_floating = $${pi++}`);
      values.push(false);
    }
    const paymentFrequencyRaw = entry.paymentFrequency?.trim() || null;
    setClauses.push(`payment_frequency = $${pi++}`);
    values.push(paymentFrequencyRaw);
    setClauses.push(`payment_frequency_raw = $${pi++}`);
    values.push(paymentFrequencyRaw);
    setClauses.push(`payment_frequency_canonical = $${pi++}`);
    values.push(normalizePaymentFrequency(paymentFrequencyRaw));
    setClauses.push(`payment_frequency_source = $${pi++}`);
    values.push(paymentFrequencyRaw ? "ppm" : null);
    setClauses.push(`is_subordinate = $${pi++}`);
    values.push(!!isSub);
    setClauses.push(`is_income_note = $${pi++}`);
    values.push(!!isSub);

    console.log(`[worker] syncPpm: tranche "${entry.class}" → normalized="${normalizedName}", spreadBps=${spreadBps}, balance=${balance}, isSub=${isSub}, isFloating=${entry.rateType}`);

    if (entry.deferrable != null) {
      setClauses.push(`is_deferrable = $${pi++}`);
      values.push(entry.deferrable);
    }

    if (entry.rating?.sp) {
      setClauses.push(`rating_sp = $${pi++}`);
      values.push(entry.rating.sp);
    }

    if (entry.rating?.fitch) {
      setClauses.push(`rating_fitch = $${pi++}`);
      values.push(entry.rating.fitch);
    }

    if (entry.referenceRate) {
      setClauses.push(`reference_rate = $${pi++}`);
      values.push(entry.referenceRate);
    }

    setClauses.push(`seniority_rank = $${pi++}`);
    values.push(denseRanks[i]);

    if (setClauses.length > 0) {
      values.push(tranche.id);
      await pool.query(
        `UPDATE clo_tranches SET ${setClauses.join(", ")} WHERE id = $${pi}`,
        values,
      );
    }
  }

  // Clean up duplicate tranches that now normalize to the same name (from pre-alias-fix runs)
  const allTranchesFinal = await pool.query<{ id: string; class_name: string }>(
    "SELECT id, class_name FROM clo_tranches WHERE deal_id = $1 ORDER BY id",
    [dealId],
  );
  const seenNorm = new Map<string, string>(); // normalizedName → first tranche id
  for (const t of allTranchesFinal.rows) {
    const norm = normalizeClassName(t.class_name);
    if (seenNorm.has(norm)) {
      // Duplicate — reassign snapshots then delete
      const keepId = seenNorm.get(norm)!;
      await pool.query(
        "UPDATE clo_tranche_snapshots SET tranche_id = $1 WHERE tranche_id = $2",
        [keepId, t.id],
      );
      await pool.query("DELETE FROM clo_tranches WHERE id = $1", [t.id]);
      console.log(`[worker] syncPpm: removed duplicate tranche "${t.class_name}" (${t.id}), kept ${keepId}`);
    } else {
      seenNorm.set(norm, t.id);
    }
  }

  console.log(`[worker] syncPpm: synced ${sorted.length} tranches to clo_tranches`);

  // Sync dates → clo_deals
  const firstEntry = capitalStructure[0];
  const maturityDate = firstEntry?.maturityDate;
  const keyDates = extractedConstraints.keyDates as Record<string, unknown> | undefined;

  const reinvestmentEnd = keyDates && !isNullish(keyDates.reinvestmentPeriodEnd)
    ? keyDates.reinvestmentPeriodEnd as string
    : null;
  const nonCallEnd = keyDates && !isNullish(keyDates.nonCallPeriodEnd)
    ? keyDates.nonCallPeriodEnd as string
    : null;

  if (maturityDate || reinvestmentEnd || nonCallEnd) {
    const dateClauses: string[] = [];
    const dateValues: unknown[] = [];
    let di = 1;

    if (maturityDate) {
      dateClauses.push(`stated_maturity_date = $${di++}`);
      dateValues.push(maturityDate);
    }
    if (reinvestmentEnd) {
      dateClauses.push(`reinvestment_period_end = $${di++}`);
      dateValues.push(reinvestmentEnd);
    }
    if (nonCallEnd) {
      dateClauses.push(`non_call_period_end = $${di++}`);
      dateValues.push(nonCallEnd);
    }

    dateValues.push(dealId);
    await pool.query(
      `UPDATE clo_deals SET ${dateClauses.join(", ")} WHERE id = $${di}`,
      dateValues,
    );
    console.log(`[worker] syncPpm: updated deal dates (maturity=${maturityDate}, reinvEnd=${reinvestmentEnd}, nonCallEnd=${nonCallEnd})`);
  }

  // Sync collateral manager name
  const cmDetails = extractedConstraints.cmDetails as Record<string, unknown> | undefined;
  const keyPartiesArray = Array.isArray(extractedConstraints.keyParties)
    ? extractedConstraints.keyParties as Array<{ role?: string; entity?: string }>
    : [];
  const cmFromKeyParties = keyPartiesArray.find(
    (p) => p.role?.toLowerCase().includes("collateral manager"),
  )?.entity;
  const cmName = (cmDetails?.name as string) ?? cmFromKeyParties ?? null;
  if (cmName) {
    await pool.query(
      `UPDATE clo_deals SET collateral_manager = $1 WHERE id = $2 AND (collateral_manager IS NULL OR collateral_manager = '')`,
      [cmName, dealId],
    );
    console.log(`[worker] syncPpm: updated collateral_manager=${cmName}`);
  }
}
