import { callAnthropicForText } from "../api";
import { extractPdfPages } from "../pdf-chunking";
import type { CloDocument } from "../types";
import type { DocumentMap, SectionEntry } from "./document-mapper";

export interface SectionText {
  sectionType: string;
  pageStart: number;
  pageEnd: number;
  markdown: string;
  truncated: boolean;
}

function transcriptionPrompt(section: SectionEntry): { system: string; user: string } {
  const sectionInstructions: Record<string, string> = {
    asset_schedule:
      "This section contains asset schedule tables (often split across Asset Info I, II, III or similar sub-tables). Merge all sub-tables into a single unified markdown table. Include every row — do not skip or summarize any holdings.",
    waterfall:
      "This section contains payment waterfall distributions. Preserve the exact payment priority order. Include zero amounts. Keep all shortfall indicators and diversion triggers.",
    concentration_tables:
      "This section contains concentration test tables. Create a separate markdown table per concentration type (e.g., industry, country, rating, obligor). Include both actual and limit values for each entry.",
  };

  const extra = sectionInstructions[section.sectionType] ?? "";

  const system = `You are a precise document transcriber. Convert the provided PDF pages into clean markdown text.

Rules:
- Preserve ALL numbers exactly as they appear — do not round, estimate, or omit any numeric value.
- Render tables as markdown tables with proper alignment.
- Keep all headers, labels, and section titles.
- Do not add commentary, interpretation, or summarization.
- Do not skip any content on the pages.
- Use standard markdown formatting (headers, bold, lists) to reflect the document structure.${extra ? `\n\n${extra}` : ""}`;

  const user = `Transcribe the following pages (${section.sectionType}, pages ${section.pageStart}–${section.pageEnd}) to clean markdown. Output only the markdown transcription.`;

  return { system, user };
}

async function extractSectionText(
  apiKey: string,
  pdfDocument: CloDocument,
  section: SectionEntry,
): Promise<SectionText> {
  const sectionBase64 = await extractPdfPages(
    pdfDocument.base64,
    section.pageStart,
    section.pageEnd,
  );

  const sectionDoc: CloDocument = {
    name: `${pdfDocument.name} (${section.sectionType} pp.${section.pageStart}-${section.pageEnd})`,
    type: "application/pdf",
    size: sectionBase64.length,
    base64: sectionBase64,
  };

  const pageCount = section.pageEnd - section.pageStart + 1;
  const maxTokens = Math.min(64000, pageCount * 2000);

  const { system, user } = transcriptionPrompt(section);

  const result = await callAnthropicForText(apiKey, system, [sectionDoc], user, maxTokens);

  if (result.error) {
    throw new Error(`Text extraction failed for section "${section.sectionType}" (pages ${section.pageStart}-${section.pageEnd}): ${result.error}`);
  }

  return {
    sectionType: section.sectionType,
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    markdown: result.text,
    truncated: result.truncated,
  };
}

export async function extractAllSectionTexts(
  apiKey: string,
  pdfDocument: CloDocument,
  documentMap: DocumentMap,
): Promise<SectionText[]> {
  return Promise.all(
    documentMap.sections.map((section) =>
      extractSectionText(apiKey, pdfDocument, section),
    ),
  );
}
