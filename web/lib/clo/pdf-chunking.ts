import { PDFDocument } from "pdf-lib";
import type { CloDocument } from "./types";

export const MAX_PDF_PAGES = 75;

export type PipelineDocument = { name: string; type: string; base64: string };

interface PdfChunk {
  base64: string;
  pageStart: number;
  pageEnd: number;
  totalPages: number;
}

async function splitPdf(base64Data: string, pageLimit?: number): Promise<PdfChunk[]> {
  const limit = pageLimit ?? MAX_PDF_PAGES;
  const pdfBytes = Buffer.from(base64Data, "base64");
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const totalPages = pdfDoc.getPageCount();

  if (totalPages <= limit) {
    return [{ base64: base64Data, pageStart: 1, pageEnd: totalPages, totalPages }];
  }

  const chunks: PdfChunk[] = [];

  for (let start = 0; start < totalPages; start += limit) {
    const end = Math.min(start + limit, totalPages);
    const chunkDoc = await PDFDocument.create();
    const pages = await chunkDoc.copyPages(pdfDoc, Array.from({ length: end - start }, (_, i) => start + i));

    for (const page of pages) {
      chunkDoc.addPage(page);
    }

    const chunkBytes = await chunkDoc.save();
    chunks.push({
      base64: Buffer.from(chunkBytes).toString("base64"),
      pageStart: start + 1,
      pageEnd: end,
      totalPages,
    });
  }

  return chunks;
}

export interface DocumentChunkSet {
  documents: CloDocument[];
  chunkLabel: string;
}

export async function chunkDocuments(documents: CloDocument[], pageLimit?: number): Promise<DocumentChunkSet[]> {
  const limit = pageLimit ?? MAX_PDF_PAGES;

  // Count total PDF pages across all documents
  let totalPdfPages = 0;
  const pdfChunkMap: Map<number, PdfChunk[]> = new Map();

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (doc.type !== "application/pdf") continue;

    const chunks = await splitPdf(doc.base64, limit);
    pdfChunkMap.set(i, chunks);
    totalPdfPages += chunks[0].totalPages;
  }

  // If everything fits in one request, return as-is
  if (totalPdfPages <= limit) {
    return [{ documents, chunkLabel: "all pages" }];
  }

  // Build chunk sets where each set has ≤limit total PDF pages
  const chunkSets: DocumentChunkSet[] = [];
  const nonPdfDocs = documents.filter((d) => d.type !== "application/pdf");

  // Collect all individual PDF chunks with their source doc info
  const allChunks: { docIndex: number; docName: string; chunk: PdfChunk }[] = [];
  for (const [docIndex, chunks] of pdfChunkMap) {
    for (const chunk of chunks) {
      allChunks.push({ docIndex, docName: documents[docIndex].name, chunk });
    }
  }

  // Group chunks into sets of ≤limit pages
  let currentPages = 0;
  let currentChunks: typeof allChunks = [];

  for (const entry of allChunks) {
    const chunkPageCount = entry.chunk.pageEnd - entry.chunk.pageStart + 1;

    if (currentPages + chunkPageCount > limit && currentChunks.length > 0) {
      chunkSets.push(buildChunkSet(currentChunks, nonPdfDocs));
      currentChunks = [];
      currentPages = 0;
    }

    currentChunks.push(entry);
    currentPages += chunkPageCount;
  }

  if (currentChunks.length > 0) {
    chunkSets.push(buildChunkSet(currentChunks, nonPdfDocs));
  }

  return chunkSets;
}

function buildChunkSet(
  chunks: { docIndex: number; docName: string; chunk: PdfChunk }[],
  nonPdfDocs: CloDocument[],
): DocumentChunkSet {
  const labels: string[] = [];
  const docs: CloDocument[] = [...nonPdfDocs];

  for (const { docName, chunk } of chunks) {
    docs.push({
      name: `${docName} (pages ${chunk.pageStart}-${chunk.pageEnd})`,
      type: "application/pdf",
      size: chunk.base64.length,
      base64: chunk.base64,
    });
    labels.push(`${docName} pp.${chunk.pageStart}-${chunk.pageEnd} of ${chunk.totalPages}`);
  }

  return { documents: docs, chunkLabel: labels.join(", ") };
}

async function getPdfPageCount(base64Data: string): Promise<number> {
  const pdfBytes = Buffer.from(base64Data, "base64");
  const pdfDoc = await PDFDocument.load(pdfBytes);
  return pdfDoc.getPageCount();
}

/**
 * Truncates documents to fit within the 100-page PDF limit.
 * Prioritizes documents by their order (put important docs first).
 * Large PDFs that would exceed the limit are truncated to their first N pages.
 */
export async function fitDocumentsToPageLimit(
  documents: PipelineDocument[],
  pageLimit?: number,
): Promise<PipelineDocument[]> {
  const limit = pageLimit ?? MAX_PDF_PAGES;
  let totalPages = 0;
  const result: PipelineDocument[] = [];

  for (const doc of documents) {
    if (doc.type !== "application/pdf") {
      result.push(doc);
      continue;
    }

    const pageCount = await getPdfPageCount(doc.base64);

    if (totalPages + pageCount <= limit) {
      result.push(doc);
      totalPages += pageCount;
      continue;
    }

    const remaining = limit - totalPages;
    if (remaining <= 0) break;

    // Truncate this PDF to fit remaining space
    const pdfBytes = Buffer.from(doc.base64, "base64");
    const srcDoc = await PDFDocument.load(pdfBytes);
    const truncatedDoc = await PDFDocument.create();
    const pages = await truncatedDoc.copyPages(srcDoc, Array.from({ length: remaining }, (_, i) => i));
    for (const page of pages) truncatedDoc.addPage(page);
    const truncatedBytes = await truncatedDoc.save();

    result.push({
      name: `${doc.name} (first ${remaining} of ${pageCount} pages)`,
      type: doc.type,
      base64: Buffer.from(truncatedBytes).toString("base64"),
    });
    totalPages += remaining;
    break;
  }

  return result;
}

/**
 * Chunks documents for pipeline calls that produce free-form text.
 * Returns chunk sets compatible with the Anthropic SDK document format.
 */
export async function chunkPipelineDocuments(
  documents: PipelineDocument[],
): Promise<{ documents: PipelineDocument[]; chunkLabel: string }[]> {
  const asCloDoc = documents.map((d) => ({ ...d, size: d.base64.length }));
  const chunkSets = await chunkDocuments(asCloDoc);
  return chunkSets.map((cs) => ({
    documents: cs.documents.map(({ name, type, base64 }) => ({ name, type, base64 })),
    chunkLabel: cs.chunkLabel,
  }));
}
