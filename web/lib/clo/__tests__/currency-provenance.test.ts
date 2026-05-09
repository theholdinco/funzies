import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(__dirname, path), "utf8");
}

describe("KI-38/KI-36 provenance columns", () => {
  it("schema and migration preserve raw, canonical, and source fields", () => {
    const schema = source("../../schema.sql");
    const migration = source("../../migrations/019_currency_frequency_provenance.sql");
    const combined = `${schema}\n${migration}`;

    for (const column of [
      "deal_currency_raw",
      "deal_currency_canonical",
      "deal_currency_source",
      "currency_raw",
      "currency_canonical",
      "currency_source",
      "payment_frequency_raw",
      "payment_frequency_canonical",
      "payment_frequency_source",
      "switch_currency_raw",
      "switch_currency_canonical",
      "switch_currency_source",
    ]) {
      expect(combined).toContain(column);
    }
  });

  it("SDF and JSON ingestion populate provenance at the source boundary", () => {
    const sdfIngest = source("../sdf/ingest.ts");
    const jsonPersist = source("../extraction/json-ingest/persist-compliance.ts");
    const jsonMapper = source("../extraction/json-ingest/compliance-mapper.ts");

    expect(sdfIngest).toContain("sdf_collateral");
    expect(sdfIngest).toContain("sdf_asset_level");
    expect(sdfIngest).toContain("sdf_notes");
    expect(sdfIngest).toContain("sdf_accounts");
    expect(sdfIngest).toContain("sdf_transactions");
    expect(sdfIngest).toContain("payment_frequency_canonical");
    expect(sdfIngest).toContain("normalizePaymentFrequency");

    expect(jsonPersist).toContain("withCurrencyProvenance");
    expect(jsonPersist).toContain("json_reporting_currency");
    expect(jsonMapper).toContain("currencyRaw");
    expect(jsonMapper).toContain("currencyCanonical");
    expect(jsonMapper).toContain("currencySource");
  });

  it("user-uploaded buy/switch candidates preserve submitted and canonical currency", () => {
    const buyListRoute = source("../../../app/api/clo/buy-list/route.ts");
    const analysesRoute = source("../../../app/api/clo/analyses/route.ts");
    const buyListStore = source("../buy-list.ts");

    expect(buyListRoute).toContain("currencyRaw");
    expect(buyListRoute).toContain("currencyCanonical");
    expect(buyListRoute).toContain("buy_list_upload");
    expect(buyListStore).toContain("currency_raw, currency_canonical, currency_source");
    expect(buyListStore).toContain("item.currencyCanonical ?? null");

    expect(analysesRoute).toContain("currency_raw, currency_canonical, currency_source");
    expect(analysesRoute).toContain("switch_currency_raw, switch_currency_canonical, switch_currency_source");
    expect(analysesRoute).toContain("analysis_form");
  });

  it("resolver treats trustee/SDF tranche frequency as stronger than PPM-synced DB frequency", () => {
    const resolver = source("../resolver.ts");

    expect(resolver).toContain("paymentFrequencySource");
    expect(resolver).toContain("dbIsPpmSynced");
    expect(resolver).toContain("Trustee/SDF tranche payment frequency");
  });
});
