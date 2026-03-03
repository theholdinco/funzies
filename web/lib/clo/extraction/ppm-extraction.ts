import type { CloDocument } from "../types";
import type { ProgressCallback } from "./runner";
import { mapDocument } from "./document-mapper";
import { extractAllSectionTexts } from "./text-extractor";
import { extractAllSections, extractSection } from "./section-extractor";
import { normalizePpmSectionResults } from "./normalizer";

export async function runSectionPpmExtraction(
  apiKey: string,
  documents: CloDocument[],
  onProgress?: ProgressCallback,
): Promise<{ extractedConstraints: Record<string, unknown>; rawOutputs: Record<string, string> }> {
  const progress = onProgress ?? (() => {});
  const pdfDoc = documents.find((d) => d.type === "application/pdf");
  if (!pdfDoc) throw new Error("No PDF document found");

  // Phase 1: Map document structure
  await progress("mapping", "Identifying document sections...");
  const documentMap = await mapDocument(apiKey, documents);
  await progress("mapping_done", `Found ${documentMap.sections.length} sections`);

  // Phase 2: Transcribe sections to markdown (parallel)
  await progress("transcribing", `Transcribing ${documentMap.sections.length} sections to text...`);
  const sectionTexts = await extractAllSectionTexts(apiKey, pdfDoc, documentMap);
  await progress("transcribing_done", `Transcribed ${sectionTexts.filter((t) => t.markdown.length > 0).length}/${documentMap.sections.length} sections`);

  // Phase 3: Extract structured data per section (parallel)
  await progress("extracting", `Extracting structured data from sections...`);
  const sectionResults = await extractAllSections(apiKey, sectionTexts, documentMap.documentType);
  await progress("extracting_done", `Extracted data from ${sectionResults.filter((r) => r.data != null).length}/${sectionTexts.length} sections`);

  // Build sections map and raw outputs
  const sections: Record<string, Record<string, unknown> | null> = {};
  const rawOutputs: Record<string, string> = {};

  for (let i = 0; i < sectionResults.length; i++) {
    const result = sectionResults[i];
    sections[result.sectionType] = result.data;
    rawOutputs[result.sectionType] = sectionTexts[i]?.markdown ?? "";
  }

  // Fallback: if key_dates returned all nulls, re-extract from transaction_overview text
  // (dates often appear in the term sheet/summary which the mapper may assign to transaction_overview)
  const keyDatesData = sections.key_dates as Record<string, unknown> | null;
  const isNullish = (v: unknown) => v == null || v === "null";
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
