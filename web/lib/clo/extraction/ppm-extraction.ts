import type { CloDocument } from "../types";
import type { ProgressCallback } from "./runner";
import { mapDocument } from "./document-mapper";
import { extractPdfText } from "./pdf-text-extractor";
import { extractAllSectionTexts } from "./text-extractor";
import { extractAllSections, extractSection } from "./section-extractor";
import { normalizePpmSectionResults } from "./normalizer";
import { mergeAllPasses, EXTRACTION_PASSES } from "./multi-pass-merger";
import type { SectionExtractionResult } from "./section-extractor";

// ---------------------------------------------------------------------------
// Single PPM extraction pass: mapping → text → structured extraction.
// ---------------------------------------------------------------------------
interface PpmSinglePassResult {
  sectionResults: SectionExtractionResult[];
  sectionTexts: Array<{ sectionType: string; pageStart: number; pageEnd: number; markdown: string; truncated: boolean }>;
}

async function runSinglePpmPass(
  passNum: number,
  apiKey: string,
  pdfDoc: CloDocument,
  documents: CloDocument[],
): Promise<PpmSinglePassResult> {
  const label = `[ppm-pass-${passNum}]`;

  // Phase 1: Map document structure
  console.log(`${label} mapping document...`);
  const documentMap = await mapDocument(apiKey, documents);
  console.log(`${label} found ${documentMap.sections.length} sections`);

  // Phase 2: Extract text with pdfplumber (deterministic)
  let sectionTexts: Array<{ sectionType: string; pageStart: number; pageEnd: number; markdown: string; truncated: boolean }>;
  try {
    const pdfText = await extractPdfText(pdfDoc.base64);
    sectionTexts = documentMap.sections.map((section) => ({
      sectionType: section.sectionType,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      markdown: pdfText.pages
        .filter((p) => p.page >= section.pageStart && p.page <= section.pageEnd)
        .map((p) => p.text)
        .join("\n\n"),
      truncated: false,
    }));
  } catch (err) {
    console.warn(`${label} pdfplumber failed, falling back to Claude transcription: ${(err as Error).message}`);
    sectionTexts = await extractAllSectionTexts(apiKey, pdfDoc, documentMap);
  }
  console.log(`${label} text extracted for ${sectionTexts.filter((t) => t.markdown.length > 0).length} sections`);

  // Phase 3: Extract structured data per section
  const MULTI_PASS_TEMPERATURE = 0.2;
  const sectionResults = await extractAllSections(apiKey, sectionTexts, documentMap.documentType, 3, MULTI_PASS_TEMPERATURE);
  console.log(`${label} extracted ${sectionResults.filter((r) => r.data != null).length}/${sectionResults.length} sections`);

  return { sectionResults, sectionTexts };
}

export async function runSectionPpmExtraction(
  apiKey: string,
  documents: CloDocument[],
  onProgress?: ProgressCallback,
): Promise<{ extractedConstraints: Record<string, unknown>; rawOutputs: Record<string, string> }> {
  const progress = onProgress ?? (() => {});
  const pdfDoc = documents.find((d) => d.type === "application/pdf");
  if (!pdfDoc) throw new Error("No PDF document found");

  // Run N independent extraction passes in parallel, then merge
  await progress("extracting", `Running ${EXTRACTION_PASSES} independent PPM extraction passes...`);
  console.log(`[ppm-extraction] starting ${EXTRACTION_PASSES} independent passes in parallel`);

  const passResults = await Promise.all(
    Array.from({ length: EXTRACTION_PASSES }, (_, i) =>
      runSinglePpmPass(i + 1, apiKey, pdfDoc, documents),
    ),
  );

  // Merge section results across all passes with AI reconciliation
  await progress("merging", `Merging ${EXTRACTION_PASSES} passes with AI reconciliation...`);
  const allSectionResults = passResults.map((p) => p.sectionResults);
  const sectionResults = await mergeAllPasses(apiKey, allSectionResults);
  const successfulExtracts = sectionResults.filter((r) => r.data != null);
  await progress("extracting_done", `Merged ${EXTRACTION_PASSES} passes → ${successfulExtracts.length} sections`);

  // Use the first pass's text for raw outputs
  const sectionTexts = passResults[0].sectionTexts;

  // Build sections map and raw outputs
  const sections: Record<string, Record<string, unknown> | null> = {};
  const rawOutputs: Record<string, string> = {};

  for (const result of sectionResults) {
    sections[result.sectionType] = result.data;
    const matchingText = sectionTexts.find((t) => t.sectionType === result.sectionType);
    rawOutputs[result.sectionType] = matchingText?.markdown ?? "";
  }

  // Fallback: if key_dates returned all nulls, re-extract from transaction_overview text
  // (dates often appear in the term sheet/summary which the mapper may assign to transaction_overview)
  const keyDatesData = sections.key_dates as Record<string, unknown> | null;
  const isNullish = (v: unknown) => v == null || v === "null" || v === "<UNKNOWN>" || v === "UNKNOWN";
  const allDatesNull = keyDatesData && Object.values(keyDatesData).every(isNullish);
  if (allDatesNull) {
    const overviewText = sectionTexts.find((t) => t.sectionType === "transaction_overview");
    const capStructText = sectionTexts.find((t) => t.sectionType === "capital_structure");
    // Combine available term sheet texts for date extraction
    const fallbackTexts = [overviewText, capStructText].filter(Boolean);
    if (fallbackTexts.length > 0) {
      const combinedMarkdown = fallbackTexts.map((t) => t!.markdown).join("\n\n---\n\n");
      console.log(`[ppm-extraction] key_dates all null — retrying extraction from transaction_overview + capital_structure text (${combinedMarkdown.length} chars)`);
      const fallbackResult = await extractSection(
        apiKey,
        { sectionType: "key_dates", pageStart: 0, pageEnd: 0, markdown: combinedMarkdown, truncated: false },
        "ppm",
      );
      if (fallbackResult.data) {
        const hasValues = Object.values(fallbackResult.data).some((v) => !isNullish(v));
        if (hasValues) {
          console.log(`[ppm-extraction] key_dates fallback succeeded`);
          sections.key_dates = fallbackResult.data;
        }
      }
    }
  }

  // Log detailed extraction summary per section
  console.log(`[ppm-extraction] ═══ SECTION DATA SUMMARY ═══`);
  for (const [sectionType, data] of Object.entries(sections)) {
    if (!data) {
      console.log(`[ppm-extraction] ${sectionType}: NULL (extraction failed)`);
      continue;
    }
    const keys = Object.keys(data);
    const summary: string[] = [];
    for (const key of keys) {
      const val = data[key];
      if (Array.isArray(val)) {
        summary.push(`${key}=${val.length} items`);
      } else if (val === null || val === undefined) {
        summary.push(`${key}=null`);
      } else if (typeof val === "object") {
        summary.push(`${key}={${Object.keys(val as Record<string, unknown>).length} keys}`);
      } else {
        const s = String(val);
        summary.push(`${key}=${s.length > 80 ? s.slice(0, 80) + "..." : s}`);
      }
    }
    console.log(`[ppm-extraction] ${sectionType}: ${summary.join(", ")}`);
  }
  console.log(`[ppm-extraction] ═══════════════════════════`);

  // Merge into extractedConstraints format
  const extractedConstraints = normalizePpmSectionResults(sections);

  // Log the final merged constraints
  console.log(`[ppm-extraction] ═══ FINAL CONSTRAINTS ═══`);
  for (const [key, value] of Object.entries(extractedConstraints)) {
    if (key.startsWith("_")) continue;
    if (Array.isArray(value)) {
      console.log(`[ppm-extraction] ${key}: ${value.length} items`);
      // Log first few items for arrays
      for (const item of value.slice(0, 3)) {
        if (typeof item === "object" && item) {
          const preview = Object.entries(item as Record<string, unknown>)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
            .join(", ");
          console.log(`[ppm-extraction]   - ${preview}`);
        }
      }
      if (value.length > 3) console.log(`[ppm-extraction]   ... and ${value.length - 3} more`);
    } else if (typeof value === "object" && value) {
      const obj = value as Record<string, unknown>;
      const fields = Object.entries(obj).filter(([, v]) => v != null).map(([k, v]) => {
        const s = String(v);
        return `${k}=${s.length > 40 ? s.slice(0, 40) + "..." : s}`;
      });
      console.log(`[ppm-extraction] ${key}: {${fields.join(", ")}}`);
    } else {
      console.log(`[ppm-extraction] ${key}: ${value}`);
    }
  }
  console.log(`[ppm-extraction] ═══════════════════════`);

  extractedConstraints._extractionPasses = sectionResults.length;
  extractedConstraints._sectionBasedExtraction = true;

  return { extractedConstraints, rawOutputs };
}
