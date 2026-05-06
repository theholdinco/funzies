/**
 * Moody's CLO Industry Classification — canonical 33-industry list.
 *
 * Reference: Moody's CLO methodology — "Moody's Approach to Rating
 * Collateralized Loan Obligations" (industry classification appendix).
 * Codes are Moody's CLO industry codes (4-digit numeric); names are the
 * canonical industry names as published by Moody's.
 *
 * Aliases include common partner-uploaded free-text variants. Coverage is
 * deliberately conservative — when a free-text doesn't match, the partner
 * picks from a dropdown via the override flow (`clo_industry_alias_overrides`),
 * which extends coverage organically without us guessing on long-tail aliases.
 *
 * Per anti-pattern #1 ("don't overfit to one deal") the alias list MUST NOT
 * include deal-specific shorthand observed in Euro XV that doesn't generalize
 * to other deals — only conventional industry abbreviations.
 */

import type { IndustryClassification } from "./types";

export const MOODYS_33: IndustryClassification[] = [
  { code: "1010", canonicalName: "Aerospace and Defense", aliases: ["aerospace", "defense", "aerospace & defense", "a&d"] },
  { code: "1020", canonicalName: "Automotive", aliases: ["auto", "autos", "automobile", "automobiles"] },
  { code: "1030", canonicalName: "Banking, Finance, Insurance and Real Estate", aliases: ["banking", "finance", "insurance", "real estate", "bfire", "fire", "financial services", "financials"] },
  { code: "1040", canonicalName: "Beverage, Food and Tobacco", aliases: ["beverage", "food", "tobacco", "beverages", "food & beverage", "f&b"] },
  { code: "1050", canonicalName: "Capital Equipment", aliases: ["capital goods", "industrial equipment", "machinery"] },
  { code: "1060", canonicalName: "Chemicals, Plastics and Rubber", aliases: ["chemicals", "plastics", "rubber", "specialty chemicals"] },
  { code: "1070", canonicalName: "Construction and Building", aliases: ["construction", "building", "building products", "homebuilding"] },
  { code: "1080", canonicalName: "Consumer goods: Durable", aliases: ["consumer durables", "durable goods", "consumer goods durable"] },
  { code: "1090", canonicalName: "Consumer goods: Non-durable", aliases: ["consumer non-durables", "consumer goods", "non-durable goods", "consumer staples"] },
  { code: "1100", canonicalName: "Containers, Packaging and Glass", aliases: ["containers", "packaging", "glass", "container & packaging"] },
  { code: "1110", canonicalName: "Energy: Electricity", aliases: ["electricity", "power generation", "power"] },
  { code: "1120", canonicalName: "Energy: Oil and Gas", aliases: ["oil & gas", "oil and gas", "o&g", "oil", "gas", "petroleum", "energy"] },
  { code: "1130", canonicalName: "Environmental Industries", aliases: ["environmental", "waste management", "recycling"] },
  { code: "1140", canonicalName: "Forest Products and Paper", aliases: ["forest products", "paper", "paper & packaging", "lumber"] },
  { code: "1150", canonicalName: "Healthcare and Pharmaceuticals", aliases: ["healthcare", "pharmaceuticals", "pharma", "health care", "biotech", "medical devices"] },
  { code: "1160", canonicalName: "High Tech Industries", aliases: ["technology", "tech", "high tech", "software", "information technology", "it", "tmt"] },
  { code: "1170", canonicalName: "Hotel, Gaming and Leisure", aliases: ["hotels", "gaming", "leisure", "lodging", "hospitality", "casinos", "restaurants and leisure"] },
  { code: "1180", canonicalName: "Media: Advertising, Printing and Publishing", aliases: ["advertising", "printing", "publishing", "media advertising"] },
  { code: "1190", canonicalName: "Media: Broadcasting and Subscription", aliases: ["broadcasting", "cable", "tv", "subscription media"] },
  { code: "1200", canonicalName: "Media: Diversified and Production", aliases: ["media", "media production", "film", "entertainment"] },
  { code: "1210", canonicalName: "Metals and Mining", aliases: ["metals", "mining", "metals & mining", "steel"] },
  { code: "1220", canonicalName: "Retail", aliases: ["retailing", "retailers", "specialty retail", "department stores"] },
  { code: "1230", canonicalName: "Services: Business", aliases: ["business services", "professional services", "commercial services"] },
  { code: "1240", canonicalName: "Services: Consumer", aliases: ["consumer services", "personal services"] },
  { code: "1250", canonicalName: "Sovereign and Public Finance", aliases: ["sovereign", "public finance", "government", "municipal"] },
  { code: "1260", canonicalName: "Telecommunications", aliases: ["telecom", "telecommunications", "telco", "wireless", "mobile"] },
  { code: "1270", canonicalName: "Transportation: Cargo", aliases: ["cargo", "freight", "logistics", "shipping", "trucking"] },
  { code: "1280", canonicalName: "Transportation: Consumer", aliases: ["consumer transportation", "passenger transport", "airlines", "rail"] },
  { code: "1290", canonicalName: "Utilities: Electric", aliases: ["electric utilities", "electricity utility"] },
  { code: "1300", canonicalName: "Utilities: Oil and Gas", aliases: ["gas utilities", "oil and gas utilities"] },
  { code: "1310", canonicalName: "Utilities: Water", aliases: ["water utilities", "water"] },
  { code: "1320", canonicalName: "Wholesale", aliases: ["wholesalers", "distribution", "wholesale trade"] },
  { code: "1330", canonicalName: "Education", aliases: ["education services", "for-profit education", "schools"] },
];

if (MOODYS_33.length !== 33) {
  throw new Error(`MOODYS_33 must contain exactly 33 industries; got ${MOODYS_33.length}`);
}
