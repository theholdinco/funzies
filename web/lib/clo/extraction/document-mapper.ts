import { z } from "zod";
import { callAnthropicWithTool, buildDocumentContent } from "../api";
import { zodToToolSchema } from "./schema-utils";
import type { CloDocument } from "../types";

// Section types for compliance reports (trustee reports / monthly reports)
export const COMPLIANCE_SECTION_TYPES = [
  "compliance_summary",
  "par_value_tests",
  "interest_coverage_tests",
  "asset_schedule",
  "concentration_tables",
  "waterfall",
  "trading_activity",
  "interest_accrual",
  "account_balances",
  "supplementary",
] as const;

// Section types for PPMs (Private Placement Memorandums)
export const PPM_SECTION_TYPES = [
  "transaction_overview",
  "capital_structure",
  "coverage_tests",
  "eligibility_criteria",
  "portfolio_constraints",
  "waterfall_rules",
  "fees_and_expenses",
  "key_dates",
  "key_parties",
  "redemption",
  "hedging",
] as const;

const sectionSchema = z.object({
  sectionType: z.string(),
  pageStart: z.number(),
  pageEnd: z.number(),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string().optional(),
});

const documentMapSchema = z.object({
  documentType: z.enum(["compliance_report", "ppm"]),
  sections: z.array(sectionSchema),
});

export type DocumentMap = z.infer<typeof documentMapSchema>;
export type SectionEntry = z.infer<typeof sectionSchema>;

function mapperPrompt(): { system: string; user: string } {
  const system = `You are a CLO document analyst. Your task is to identify the structure of a CLO document by finding each major section and the page range it occupies.

First, determine the document type:
- "compliance_report": A trustee report, monthly/quarterly compliance report, or payment date report. Contains test results, asset schedules, waterfall distributions, and account balances.
- "ppm": A Private Placement Memorandum or offering circular. Contains deal terms, eligibility criteria, waterfall rules, and legal provisions.

Then identify which sections are present and their page ranges.

For compliance reports, look for these section types:
${COMPLIANCE_SECTION_TYPES.map((t) => `- ${t}`).join("\n")}

For PPMs, look for these section types:
${PPM_SECTION_TYPES.map((t) => `- ${t}`).join("\n")}

Rules:
- Page numbers are 1-indexed (first page of the PDF is page 1).
- Set confidence to "high" when section boundaries are clearly marked with headers/titles.
- Set confidence to "medium" when the section is identifiable but boundaries are approximate.
- Set confidence to "low" when the content is ambiguous or spread across non-contiguous pages.
- Add notes for unusual layouts, merged sections, or anything noteworthy.
- Only include sections that are actually present in the document. Do not guess or fabricate sections.
- A section's pageEnd must be >= its pageStart.
- Sections may overlap if content spans shared pages.`;

  const user = `Analyze this CLO document. Identify the document type and map out all sections with their page ranges. Use the provided tool to return the structured result.`;

  return { system, user };
}

export async function mapDocument(
  apiKey: string,
  documents: CloDocument[],
): Promise<DocumentMap> {
  const { system, user } = mapperPrompt();
  const content = buildDocumentContent(documents, user);

  const inputSchema = zodToToolSchema(documentMapSchema);

  const result = await callAnthropicWithTool(apiKey, system, content, 4096, {
    name: "map_document_sections",
    description: "Return the document type and a list of identified sections with their page ranges.",
    inputSchema,
  });

  if (result.error) {
    throw new Error(`Document mapping failed: ${result.error}`);
  }

  if (!result.data) {
    throw new Error("Document mapping returned no data");
  }

  return result.data as unknown as DocumentMap;
}
