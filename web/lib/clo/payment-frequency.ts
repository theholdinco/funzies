export type PaymentFrequency = "monthly" | "quarterly" | "semi_annual";

function detectSimplePaymentFrequency(s: string): PaymentFrequency | null {
  const hits = new Set<PaymentFrequency>();
  if (s === "1 month" || s === "1 months" || s === "monthly" || s === "month" || /\bmonthly\b/.test(s)) hits.add("monthly");
  if (
    s === "3 month" ||
    s === "3 months" ||
    s === "3m" ||
    s === "quarterly" ||
    s === "quarter" ||
    /\bquarterly\b/.test(s) ||
    /\bevery (?:three|3) months\b/.test(s) ||
    /\beach quarter\b/.test(s)
  ) {
    hits.add("quarterly");
  }
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

function mentionsUnsupportedLaterFrequency(s: string): boolean {
  const later = s.match(/\b(?:thereafter|after(?:wards)?|following)\b(.+)$/)?.[1];
  const afterSwitch = later ?? s.match(/\b(?:prior to|before|until)\b.+?\band\b(.+)$/)?.[1];
  if (!afterSwitch) return false;
  return /\b(?:monthly|1\s*months?|weekly|bi[-\s]?weekly|daily|custom|irregular)\b/.test(afterSwitch);
}

export function normalizePaymentFrequency(raw: string | null | undefined): PaymentFrequency | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  if (/\bnot\s+(monthly|quarterly|semi\s*annual(?:ly)?|semiannual(?:ly)?)\b/.test(s)) return null;
  if (mentionsUnsupportedLaterFrequency(s)) return null;
  if (/\bno\b.*\bfrequency switch\b.*\b(?:occurred|has occurred|event)\b/.test(s)) {
    const detected = detectSimplePaymentFrequency(s);
    if (detected) return detected;
  }
  const currentPhasePrefix = s.split(/\bprior to\b|\bbefore\b|\buntil\b/)[0]?.trim();
  if (currentPhasePrefix && currentPhasePrefix !== s) {
    const detected = detectSimplePaymentFrequency(currentPhasePrefix);
    if (detected) return detected;
  }
  const beforeThereafter = s.split(/\bthereafter\b/)[0]?.trim();
  if (beforeThereafter && beforeThereafter !== s) {
    const currentPhrase = /^\s*(prior to|before)\b/.test(beforeThereafter)
      ? beforeThereafter.split(/[,;]/).slice(1).join(" ").trim()
      : beforeThereafter;
    const detected = currentPhrase ? detectSimplePaymentFrequency(currentPhrase) : null;
    if (detected) return detected;
  }
  if (/\bfrequency switch\b/.test(s) || /\bprior to\b.*\bthereafter\b/.test(s)) return null;

  return detectSimplePaymentFrequency(s);
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
