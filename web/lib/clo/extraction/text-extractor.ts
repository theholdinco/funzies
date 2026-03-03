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

const MAX_TRANSCRIPTION_PAGES = 15;

async function extractSectionChunk(
  apiKey: string,
  pdfDocument: CloDocument,
  section: SectionEntry,
  chunkStart: number,
  chunkEnd: number,
): Promise<{ markdown: string; truncated: boolean; error?: string }> {
  const chunkBase64 = await extractPdfPages(pdfDocument.base64, chunkStart, chunkEnd);

  const chunkDoc: CloDocument = {
    name: `${pdfDocument.name} (${section.sectionType} pp.${chunkStart}-${chunkEnd})`,
    type: "application/pdf",
    size: chunkBase64.length,
    base64: chunkBase64,
  };

  const maxTokens = 64000;

  const { system, user } = transcriptionPrompt(section);

  const label = `transcribe:${section.sectionType}:pp${chunkStart}-${chunkEnd}`;
  const result = await callAnthropicForText(apiKey, system, [chunkDoc], user, maxTokens, label);

  if (result.error) {
    return { markdown: "", truncated: false, error: result.error };
  }

  return { markdown: result.text, truncated: result.truncated };
}

export async function extractSectionText(
  apiKey: string,
  pdfDocument: CloDocument,
  section: SectionEntry,
): Promise<SectionText> {
  const pageCount = section.pageEnd - section.pageStart + 1;

  // Small section — send directly
  if (pageCount <= MAX_TRANSCRIPTION_PAGES) {
    const result = await extractSectionChunk(apiKey, pdfDocument, section, section.pageStart, section.pageEnd);
    if (result.error) {
      console.error(`[text-extractor] Failed for section "${section.sectionType}" (pages ${section.pageStart}-${section.pageEnd}): ${result.error}`);
    }
    return {
      sectionType: section.sectionType,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      markdown: result.markdown,
      truncated: result.truncated,
    };
  }

  // Large section — chunk and transcribe sequentially, then concatenate
  console.log(`[text-extractor] Section "${section.sectionType}" has ${pageCount} pages, chunking into groups of ${MAX_TRANSCRIPTION_PAGES}`);
  const markdownParts: string[] = [];
  let anyTruncated = false;

  for (let start = section.pageStart; start <= section.pageEnd; start += MAX_TRANSCRIPTION_PAGES) {
    const end = Math.min(start + MAX_TRANSCRIPTION_PAGES - 1, section.pageEnd);
    const result = await extractSectionChunk(apiKey, pdfDocument, section, start, end);
    if (result.error) {
      console.error(`[text-extractor] Failed chunk pages ${start}-${end} of "${section.sectionType}": ${result.error}`);
      continue; // Skip failed chunk, keep others
    }
    if (result.markdown) markdownParts.push(result.markdown);
    if (result.truncated) anyTruncated = true;
  }

  return {
    sectionType: section.sectionType,
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    markdown: markdownParts.join("\n\n"),
    truncated: anyTruncated,
  };
}

export async function extractAllSectionTexts(
  apiKey: string,
  pdfDocument: CloDocument,
  documentMap: DocumentMap,
  concurrency = 3,
): Promise<SectionText[]> {
  const results: SectionText[] = [];
  const sections = [...documentMap.sections];

  for (let i = 0; i < sections.length; i += concurrency) {
    const batch = sections.slice(i, i + concurrency);
    const batchNum = Math.floor(i / concurrency) + 1;
    const totalBatches = Math.ceil(sections.length / concurrency);
    console.log(`[text-extractor] batch ${batchNum}/${totalBatches}: ${batch.map((s) => `${s.sectionType}(pp${s.pageStart}-${s.pageEnd})`).join(", ")}`);
    const batchResults = await Promise.all(
      batch.map(async (section) => {
        try {
          const result = await extractSectionText(apiKey, pdfDocument, section);
          const status = result.markdown ? `OK (${result.markdown.length} chars)` : "EMPTY";
          console.log(`[text-extractor] ${section.sectionType}: ${status}`);
          return result;
        } catch (err) {
          console.error(`[text-extractor] ${section.sectionType}: FAILED — ${(err as Error).message}`);
          return { sectionType: section.sectionType, pageStart: section.pageStart, pageEnd: section.pageEnd, markdown: "", truncated: false };
        }
      }),
    );
    results.push(...batchResults);
  }

  return results;
}
