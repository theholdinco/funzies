// web/lib/clo/extraction/json-ingest/utils.ts

// 0.95 (percent) → 95 (bps). Input must already be in percent (not decimal).
export function pctToBps(pct: number | null | undefined): number | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  return Math.round(pct * 100);
}

// 0.0095 (decimal) → 0.95 (percent)
export function decimalToPct(dec: number | null | undefined): number | null {
  if (dec == null || !Number.isFinite(dec)) return null;
  return dec * 100;
}

// 1.3698 (ratio) → 136.98 (percent). For OC/IC ratios stored as decimals.
export function ratioToPct(ratio: number | null | undefined): number | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  return ratio * 100;
}

// 0.0095 (decimal spread) → 95 (bps)
export function decimalSpreadToBps(dec: number | null | undefined): number | null {
  if (dec == null || !Number.isFinite(dec)) return null;
  return Math.round(dec * 10000);
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// "29-Sep-2032" or "29 Sep 2032" → "2032-09-29"
// "2032-09-29" passes through untouched.
// Returns null on unparseable input (e.g. empty, "null", unparseable).
export function parseFlexibleDate(s: string | null | undefined): string | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null") return null;

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // DD-Mon-YYYY
  const m = trimmed.match(/^(\d{1,2})[\s\-\/](\w{3})[\s\-\/](\d{4})$/);
  if (m) {
    const [, day, mon, year] = m;
    const mm = MONTHS[mon.toLowerCase()];
    if (mm) return `${year}-${mm}-${day.padStart(2, "0")}`;
  }

  // Give up — let downstream surface the bad value rather than silently coerce
  return null;
}

// NOTE: do NOT define a normalizeClassName here. The project already exports one
// from web/lib/clo/api.ts (returns "A", "B-1", "SUBORDINATED"). That is the form
// the worker's syncPpmToRelationalTables uses for lookups. Any mapper or persist
// helper that needs to match tranches MUST import it from api.ts — not reinvent
// a second normalisation convention.

// "LX28443T7" → "LX28443T7" (pass-through)
// "XS3134529562" → null (not an LXID)
export function extractLxid(securityId: string | null | undefined): string | null {
  if (!securityId) return null;
  const t = securityId.trim().toUpperCase();
  return /^LX\w+$/.test(t) ? t : null;
}

// "XS3134529562" → "XS3134529562"
// "LX28443T7" → null (LXID, not ISIN)
export function extractIsin(securityId: string | null | undefined): string | null {
  if (!securityId) return null;
  const t = securityId.trim().toUpperCase();
  if (t.startsWith("LX")) return null;
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(t) ? t : null;
}
