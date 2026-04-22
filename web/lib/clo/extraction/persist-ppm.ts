import type { Pool } from "pg";
import { normalizeClassName } from "../api.js";
import type { CapitalStructureEntry } from "../types/index.js";

function parseAmount(s: string | undefined | null): number | null {
  if (!s) return null;
  const cleaned = String(s).replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseSpreadBps(s: string | undefined | null): number | null {
  if (!s) return null;
  const str = String(s).trim();
  if (str === "N/A" || str === "-" || str === "") return null;
  // Match patterns like "SOFR + 145bps", "E + 1.50%", "145 bps", "1.45%"
  const bpsMatch = str.match(/(\d+(?:\.\d+)?)\s*bps/i);
  if (bpsMatch) return parseFloat(bpsMatch[1]);
  const pctMatch = str.match(/[+]\s*(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) return parseFloat(pctMatch[1]) * 100;
  const perCentMatch = str.match(/(\d+(?:\.\d+)?)\s*per\s*cent/i);
  if (perCentMatch) return parseFloat(perCentMatch[1]) * 100;
  // Fallback: plain number (e.g., "145" from a column labeled "Spread (bps)")
  const plainNum = parseFloat(str.replace(/[,\s]/g, ""));
  if (!isNaN(plainNum) && plainNum > 0) return plainNum;
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
        closing_date, effective_date, reinvestment_period_end, non_call_period_end,
        stated_maturity_date, collateral_manager, governing_law, ppm_constraints
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id`,
      [
        profileId,
        di.dealName ?? null,
        di.issuerLegalName ?? null,
        di.jurisdiction ?? null,
        di.currency ?? null,
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
    values.push(i + 1);

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
