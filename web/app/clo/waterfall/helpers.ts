export function formatPct(val: number): string {
  return `${val.toFixed(2)}%`;
}

export function formatAmount(val: number): string {
  if (Math.abs(val) >= 1e6) return `€${(val / 1e6).toFixed(2)}M`;
  if (Math.abs(val) >= 1e3) return `€${(val / 1e3).toFixed(1)}K`;
  return `€${val.toFixed(0)}`;
}

export function formatDate(isoDate: string): string {
  if (!isoDate || !isoDate.includes("-")) return "—";
  const [y, m] = isoDate.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1] ?? "?"} ${y.slice(2)}`;
}

export const TRANCHE_COLORS = [
  "#2d6a4f", "#5a7c2f", "#92641a", "#b54a32", "#7c3aed", "#2563eb",
];
