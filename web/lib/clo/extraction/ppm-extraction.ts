import type { CloDocument } from "../types";
import type { ProgressCallback } from "./runner";
import { mapDocument } from "./document-mapper";
import { extractAllSectionTexts } from "./text-extractor";
import { extractAllSections } from "./section-extractor";
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

  // Merge into extractedConstraints format
  const extractedConstraints = normalizePpmSectionResults(sections);

  extractedConstraints._extractionPasses = sectionResults.length;
  extractedConstraints._sectionBasedExtraction = true;

  return { extractedConstraints, rawOutputs };
}
