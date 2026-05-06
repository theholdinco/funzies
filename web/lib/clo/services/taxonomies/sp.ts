/**
 * S&P CLO Industry Classification — canonical industry list (modeled on
 * S&P's Global Industry Classification System / CLO industry taxonomy).
 *
 * Reference: S&P Global Ratings — "CDO Monitor / Industry Classifications"
 * documentation. Codes are S&P's CLO industry codes (alphanumeric, "MMxx"
 * prefix in S&P's published list); names are the canonical S&P industry
 * names.
 *
 * Same conservative-aliases discipline as moodys-33.ts — the override flow
 * (`clo_industry_alias_overrides`) extends coverage organically without us
 * guessing on long-tail aliases. Aliases never overlap across industries.
 */

import type { IndustryClassification } from "./types";

export const SP_INDUSTRIES: IndustryClassification[] = [
  { code: "MM01", canonicalName: "Aerospace and Defense", aliases: ["aerospace", "defense", "aerospace & defense"] },
  { code: "MM02", canonicalName: "Air Transport", aliases: ["airlines", "aviation", "air freight"] },
  { code: "MM03", canonicalName: "Automotive", aliases: ["auto", "autos", "automobile", "automobiles", "auto parts"] },
  { code: "MM04", canonicalName: "Beverage and Tobacco", aliases: ["beverages", "tobacco", "drinks"] },
  { code: "MM05", canonicalName: "Brokers, Dealers and Investment Houses", aliases: ["brokers", "investment banks", "asset management"] },
  { code: "MM06", canonicalName: "Building and Development", aliases: ["construction", "building products", "homebuilders", "building"] },
  { code: "MM07", canonicalName: "Business Equipment and Services", aliases: ["business services", "professional services", "office equipment"] },
  { code: "MM08", canonicalName: "Cable and Satellite Television", aliases: ["cable tv", "satellite tv", "cable television"] },
  { code: "MM09", canonicalName: "Chemicals and Plastics", aliases: ["chemicals", "plastics", "specialty chemicals"] },
  { code: "MM10", canonicalName: "Clothing/Textiles", aliases: ["apparel", "textiles", "clothing", "fashion"] },
  { code: "MM11", canonicalName: "Conglomerates", aliases: ["diversified industrials", "conglomerate"] },
  { code: "MM12", canonicalName: "Containers and Glass Products", aliases: ["containers", "glass", "packaging glass"] },
  { code: "MM13", canonicalName: "Cosmetics/Toiletries", aliases: ["cosmetics", "personal care", "toiletries", "beauty"] },
  { code: "MM14", canonicalName: "Drugs", aliases: ["pharmaceuticals", "pharma", "drugs", "biotech"] },
  { code: "MM15", canonicalName: "Ecological Services and Equipment", aliases: ["environmental", "waste management", "ecological"] },
  { code: "MM16", canonicalName: "Electronics/Electrical", aliases: ["electronics", "electrical equipment", "semiconductors"] },
  { code: "MM17", canonicalName: "Equipment Leasing", aliases: ["equipment leasing", "leasing"] },
  { code: "MM18", canonicalName: "Farming/Agriculture", aliases: ["agriculture", "farming", "agribusiness"] },
  { code: "MM19", canonicalName: "Financial Intermediaries", aliases: ["financial services", "specialty finance", "financials"] },
  { code: "MM20", canonicalName: "Food/Drug Retailers", aliases: ["grocery", "drug stores", "supermarkets", "food retail"] },
  { code: "MM21", canonicalName: "Food Products", aliases: ["food", "packaged food", "food processors"] },
  { code: "MM22", canonicalName: "Food Service", aliases: ["restaurants", "food service", "quick service restaurants"] },
  { code: "MM23", canonicalName: "Forest Products", aliases: ["forest products", "paper", "lumber", "timber"] },
  { code: "MM24", canonicalName: "Health Care", aliases: ["healthcare", "health care services", "hospitals", "medical"] },
  { code: "MM25", canonicalName: "Home Furnishings", aliases: ["home furnishings", "furniture", "household goods"] },
  { code: "MM26", canonicalName: "Lodging and Casinos", aliases: ["lodging", "hotels", "casinos", "gaming", "hospitality"] },
  { code: "MM27", canonicalName: "Industrial Equipment", aliases: ["industrial machinery", "machinery", "capital equipment"] },
  { code: "MM28", canonicalName: "Insurance", aliases: ["insurance carriers", "p&c insurance", "life insurance"] },
  { code: "MM29", canonicalName: "Leisure Goods/Activities/Movies", aliases: ["leisure", "entertainment", "movies", "film", "recreation"] },
  { code: "MM30", canonicalName: "Nonferrous Metals/Minerals", aliases: ["metals", "mining", "minerals", "metals & mining"] },
  { code: "MM31", canonicalName: "Oil and Gas", aliases: ["oil and gas", "oil & gas", "o&g", "energy", "petroleum"] },
  { code: "MM32", canonicalName: "Publishing", aliases: ["publishing", "newspapers", "media publishing"] },
  { code: "MM33", canonicalName: "Radio and Television", aliases: ["radio", "television", "broadcasting"] },
  { code: "MM34", canonicalName: "Retailers (except Food and Drug)", aliases: ["retail", "specialty retail", "department stores", "retailers"] },
  { code: "MM35", canonicalName: "Steel", aliases: ["steel", "iron and steel"] },
];

if (SP_INDUSTRIES.length !== 35) {
  throw new Error(`SP_INDUSTRIES must contain exactly 35 industries; got ${SP_INDUSTRIES.length}`);
}
