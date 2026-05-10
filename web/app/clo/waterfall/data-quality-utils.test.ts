import { describe, expect, it } from "vitest";
import { dataQualityErrorMessage, parseWarnings } from "./data-quality-utils";

describe("dataQualityErrorMessage", () => {
  it("renders explicit stale-period errors with refresh guidance", async () => {
    const response = Response.json({ error: "Stale report period" }, { status: 409 });

    await expect(dataQualityErrorMessage(response)).resolves.toBe(
      "Stale report period. Refresh to rerun data quality.",
    );
  });

  it("uses refresh fallback text when a 409 body is not JSON", async () => {
    const response = new Response("not-json", { status: 409 });

    await expect(dataQualityErrorMessage(response)).resolves.toBe(
      "Report data changed. Refresh to rerun data quality.",
    );
  });

  it("renders non-409 route errors directly when available", async () => {
    const response = Response.json({ error: "API error" }, { status: 429 });

    await expect(dataQualityErrorMessage(response)).resolves.toBe("API error");
  });
});

describe("parseWarnings", () => {
  it("parses JSON array warnings and normalizes unknown severities to info", () => {
    expect(parseWarnings(JSON.stringify([
      { severity: "error", message: "Missing maturity", action: "Add date" },
      { severity: "notice", message: "Looks fine" },
    ]))).toEqual([
      { severity: "error", message: "Missing maturity", action: "Add date" },
      { severity: "info", message: "Looks fine", action: "" },
    ]);
  });

  it("throws on malformed JSON-looking model output", () => {
    expect(() => parseWarnings("[{bad json]")).toThrow(/not valid JSON/);
  });

  it("keeps markdown fallback parsing for legacy model output", () => {
    expect(parseWarnings("- Missing maturity — Add maturity date")).toEqual([
      { severity: "error", message: "Missing maturity", action: "Add maturity date" },
    ]);
  });
});
