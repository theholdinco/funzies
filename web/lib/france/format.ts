export function formatEuro(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B€`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M€`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K€`;
  return `${Math.round(value)}€`;
}
