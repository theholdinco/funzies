import { query } from "../db";
import type { BuyListItem } from "./types";

// pg returns NUMERIC columns as strings — convert to number safely
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function rowToBuyListItem(row: Record<string, unknown>): BuyListItem {
  return {
    id: row.id as string,
    profileId: row.profile_id as string,
    obligorName: row.obligor_name as string,
    facilityName: (row.facility_name as string) ?? null,
    sector: (row.sector as string) ?? null,
    moodysRating: (row.moodys_rating as string) ?? null,
    spRating: (row.sp_rating as string) ?? null,
    spreadBps: num(row.spread_bps),
    referenceRate: (row.reference_rate as string) ?? null,
    price: num(row.price),
    maturityDate: (row.maturity_date as string) ?? null,
    facilitySize: num(row.facility_size),
    leverage: num(row.leverage),
    interestCoverage: num(row.interest_coverage),
    isCovLite: row.is_cov_lite != null ? (row.is_cov_lite as boolean) : null,
    averageLifeYears: num(row.average_life_years),
    recoveryRate: num(row.recovery_rate),
    notes: (row.notes as string) ?? null,
    createdAt: (row.created_at as string) || "",
  };
}

export async function getBuyListForProfile(profileId: string): Promise<BuyListItem[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM clo_buy_list_items WHERE profile_id = $1 ORDER BY obligor_name",
    [profileId]
  );
  return rows.map(rowToBuyListItem);
}

export async function getBuyListForUser(userId: string): Promise<BuyListItem[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT bli.* FROM clo_buy_list_items bli
     JOIN clo_profiles cp ON cp.id = bli.profile_id
     WHERE cp.user_id = $1
     ORDER BY bli.obligor_name`,
    [userId]
  );
  return rows.map(rowToBuyListItem);
}

export async function replaceBuyList(
  profileId: string,
  items: Omit<BuyListItem, "id" | "profileId" | "createdAt">[]
): Promise<BuyListItem[]> {
  await query("DELETE FROM clo_buy_list_items WHERE profile_id = $1", [profileId]);

  if (items.length === 0) return [];

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;

  for (const item of items) {
    const start = paramIndex;
    placeholders.push(
      `($${start},$${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5},$${start + 6},$${start + 7},$${start + 8},$${start + 9},$${start + 10},$${start + 11},$${start + 12},$${start + 13},$${start + 14},$${start + 15},$${start + 16})`
    );
    values.push(
      profileId,
      item.obligorName,
      item.facilityName,
      item.sector,
      item.moodysRating,
      item.spRating,
      item.spreadBps,
      item.referenceRate,
      item.price,
      item.maturityDate,
      item.facilitySize,
      item.leverage,
      item.interestCoverage,
      item.isCovLite,
      item.averageLifeYears,
      item.recoveryRate,
      item.notes
    );
    paramIndex += 17;
  }

  const rows = await query<Record<string, unknown>>(
    `INSERT INTO clo_buy_list_items (
      profile_id, obligor_name, facility_name, sector, moodys_rating,
      sp_rating, spread_bps, reference_rate, price, maturity_date,
      facility_size, leverage, interest_coverage, is_cov_lite,
      average_life_years, recovery_rate, notes
    ) VALUES ${placeholders.join(", ")}
    RETURNING *`,
    values
  );
  return rows.map(rowToBuyListItem);
}

export async function clearBuyList(profileId: string): Promise<void> {
  await query("DELETE FROM clo_buy_list_items WHERE profile_id = $1", [profileId]);
}

export function formatBuyList(items: BuyListItem[]): string {
  if (items.length === 0) return "";

  const lines = items
    .map((item) => {
      const parts: string[] = [`Obligor: ${item.obligorName}`];
      if (item.facilityName) parts.push(`Facility: ${item.facilityName}`);
      if (item.sector) parts.push(`Sector: ${item.sector}`);
      if (item.moodysRating || item.spRating) {
        const ratings = [item.moodysRating, item.spRating].filter(Boolean).join("/");
        parts.push(`Rating: ${ratings}`);
      }
      if (item.spreadBps != null) parts.push(`Spread: ${item.spreadBps}bps`);
      if (item.price != null) parts.push(`Price: ${item.price}`);
      if (item.maturityDate) parts.push(`Maturity: ${item.maturityDate}`);
      if (item.facilitySize != null) parts.push(`Max Size: ${item.facilitySize}`);
      if (item.leverage != null) parts.push(`Leverage: ${item.leverage}x`);
      if (item.interestCoverage != null) parts.push(`IC: ${item.interestCoverage}x`);
      if (item.isCovLite != null) parts.push(`Cov-Lite: ${item.isCovLite ? "Yes" : "No"}`);
      if (item.averageLifeYears != null) parts.push(`Avg Life: ${item.averageLifeYears}y`);
      if (item.recoveryRate != null) parts.push(`Recovery: ${item.recoveryRate}%`);
      if (item.notes) parts.push(`Notes: ${item.notes}`);
      return parts.join(" | ");
    })
    .join("\n");
  return `Note: "Max Size" is the maximum facility size available — the manager can buy or swap up to that amount, not necessarily the full size.\n${lines}`;
}
