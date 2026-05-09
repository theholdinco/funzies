import { parseDecoratedAmount } from "./sdf/csv-utils";

export function parseFacilitySizeAmount(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  const text = raw?.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const multiplier =
    /\d\s*(bn|billion|b)\b/.test(lower)
      ? 1_000_000_000
      : /\d\s*(mm|mn|million|m)\b/.test(lower)
        ? 1_000_000
        : /\d\s*(k|thousand)\b/.test(lower)
          ? 1_000
          : 1;
  const parsed = parseDecoratedAmount(text);
  if (parsed == null || parsed <= 0) return null;
  return parsed * multiplier;
}
