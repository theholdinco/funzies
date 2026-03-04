export interface ExtractionAuditEntry {
  sectionType: string;
  method: "table" | "claude" | "table+claude_fallback";
  pagesScanned: string;
  recordsExtracted: number;
  fieldsPerRecord: number;
  qualityScore: number;
  nullFieldRatio: number;
  typeErrors: string[];
  rawSamples: Record<string, unknown>[];
  dataQualityNotes: string[];
  durationMs: number;
}

export interface ExtractionAuditLog {
  extractionDateTime: string;
  documentType: "compliance_report" | "ppm";
  pdfPages: number;
  entries: ExtractionAuditEntry[];
}

export function createAuditLog(documentType: "compliance_report" | "ppm", pdfPages: number): ExtractionAuditLog {
  return {
    extractionDateTime: new Date().toISOString(),
    documentType,
    pdfPages,
    entries: [],
  };
}

export function addAuditEntry(log: ExtractionAuditLog, entry: ExtractionAuditEntry): void {
  log.entries.push(entry);
  const tag = entry.method === "table" ? "TABLE" : entry.method === "claude" ? "CLAUDE" : "FALLBACK";
  console.log(
    `[audit] ${entry.sectionType}: ${tag} | quality=${entry.qualityScore.toFixed(2)} | records=${entry.recordsExtracted} | nulls=${(entry.nullFieldRatio * 100).toFixed(0)}% | ${entry.durationMs}ms`,
  );
  if (entry.typeErrors.length > 0) {
    console.log(`[audit]   type errors: ${entry.typeErrors.join(", ")}`);
  }
  for (const note of entry.dataQualityNotes) {
    console.log(`[audit]   note: ${note}`);
  }
}

export function logAuditSummary(log: ExtractionAuditLog): void {
  const tableSections = log.entries.filter((e) => e.method === "table");
  const claudeSections = log.entries.filter((e) => e.method === "claude");
  const fallbackSections = log.entries.filter((e) => e.method === "table+claude_fallback");
  const totalRecords = log.entries.reduce((sum, e) => sum + e.recordsExtracted, 0);
  const avgQuality = log.entries.length > 0
    ? log.entries.reduce((sum, e) => sum + e.qualityScore, 0) / log.entries.length
    : 0;

  console.log(`[audit] ═══ EXTRACTION AUDIT SUMMARY ═══`);
  console.log(`[audit] table-extracted: ${tableSections.length} sections`);
  console.log(`[audit] claude-extracted: ${claudeSections.length} sections`);
  console.log(`[audit] fallback (table→claude): ${fallbackSections.length} sections`);
  console.log(`[audit] total records: ${totalRecords}`);
  console.log(`[audit] avg quality: ${avgQuality.toFixed(2)}`);
  console.log(`[audit] ════════════════════════════════`);
}
