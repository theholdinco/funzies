const ISO_4217_CODES = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD",
  "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR",
  "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD",
  "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON",
  "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP",
  "SLE", "SOS", "SRD", "SSP", "STN", "SYP", "SZL", "THB", "TJS", "TMT",
  "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU",
  "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF", "YER",
  "ZAR", "ZMW",
] as const;

const RECOGNIZED_CURRENCY_CODES = new Set<string>(ISO_4217_CODES);

export function canonicalCurrency(raw: string | null | undefined): string | null {
  const text = raw?.trim().toUpperCase();
  if (!text) return null;
  if (/\bNON[-\s]?(?:BASE|DEAL|CURRENC(?:Y|IES)|EURO|EUR|USD|US DOLLAR|STERLING|POUND|GBP)\b/.test(text)) {
    return null;
  }
  if (text.includes("€")) return "EUR";
  if (text.includes("£")) return "GBP";
  if (text === "$" || text.includes("US$") || text.includes("U.S.$")) return "USD";
  const compact = text.replace(/[^A-Z]/g, "");
  if (!compact) return null;
  const tokens = [...text.matchAll(/\b[A-Z]{3}\b/g)]
    .map((m) => m[0])
    .filter((t) => RECOGNIZED_CURRENCY_CODES.has(t));
  if (new Set(tokens).size > 1) return null;
  const token = tokens[0];
  if (token && RECOGNIZED_CURRENCY_CODES.has(token)) return token;
  if (/\bEURO(?:S)?\b/.test(text) || /\bEURO[-\s]?DENOMINATED\b/.test(text)) return "EUR";
  if (compact.includes("CAD") || compact.includes("CANADIANDOLLAR")) return "CAD";
  if (compact.includes("AUD") || compact.includes("AUSTRALIANDOLLAR")) return "AUD";
  if (compact === "US" || compact.includes("USD") || compact.includes("USDOLLAR") || compact.includes("UNITEDSTATESDOLLAR")) return "USD";
  if (compact.includes("GBP") || compact.includes("STERLING") || compact.includes("POUND")) return "GBP";
  return RECOGNIZED_CURRENCY_CODES.has(compact) ? compact : null;
}
