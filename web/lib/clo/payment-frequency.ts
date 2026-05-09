export type PaymentFrequency = "monthly" | "quarterly" | "semi_annual";

export function normalizePaymentFrequency(raw: string | null | undefined): PaymentFrequency | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  if (/\bnot\s+(monthly|quarterly|semi\s*annual(?:ly)?|semiannual(?:ly)?)\b/.test(s)) return null;
  if (/\bfrequency switch\b/.test(s) || /\bprior to\b.*\bthereafter\b/.test(s)) return null;

  const hits = new Set<PaymentFrequency>();
  if (s === "1 month" || s === "1 months" || s === "monthly" || s === "month" || /\bmonthly\b/.test(s)) hits.add("monthly");
  if (s === "3 month" || s === "3 months" || s === "3m" || s === "quarterly" || s === "quarter" || /\bquarterly\b/.test(s) || /\bevery three months\b/.test(s)) hits.add("quarterly");
  if (
    s === "6 month" ||
    s === "6 months" ||
    s === "6m" ||
    s === "semi annual" ||
    s === "semi annually" ||
    s === "semiannual" ||
    s === "semiannually" ||
    /\bsemi annual(?:ly)?\b/.test(s) ||
    /\bsemiannual(?:ly)?\b/.test(s)
  ) {
    hits.add("semi_annual");
  }
  if (hits.size !== 1) return null;
  return [...hits][0];
}

export function paymentFrequencyMonths(frequency: PaymentFrequency): number {
  switch (frequency) {
    case "monthly":
      return 1;
    case "quarterly":
      return 3;
    case "semi_annual":
      return 6;
  }
}
