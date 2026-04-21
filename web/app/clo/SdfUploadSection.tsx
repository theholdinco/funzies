"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { detectSdfFileType } from "@/lib/clo/sdf/detect";
import type { SdfFileType } from "@/lib/clo/sdf/types";

interface SdfDetectedFile {
  file: File;
  fileType: SdfFileType | null;
  rowCount: number;
}

const SDF_TYPE_LABELS: Record<SdfFileType, string> = {
  test_results: "Test Results",
  notes: "Notes",
  collateral_file: "Collateral File",
  asset_level: "Asset Level",
  accounts: "Accounts",
  transactions: "Transactions",
  accruals: "Accruals",
};

export default function SdfUploadSection({ dealId }: { dealId: string }) {
  const [sdfFiles, setSdfFiles] = useState<SdfDetectedFile[]>([]);
  const [sdfUploading, setSdfUploading] = useState(false);
  const [sdfResults, setSdfResults] = useState<any>(null);
  const [sdfError, setSdfError] = useState<string | null>(null);
  const sdfInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function handleSdfFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    const detected = await Promise.all(
      selected.map(async (file) => {
        const text = await file.text();
        const fileType = detectSdfFileType(text);
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
        const rowCount = Math.max(0, lines.length - 1);
        return { file, fileType, rowCount };
      })
    );
    setSdfFiles(detected);
    setSdfResults(null);
    setSdfError(null);
  }

  async function handleSdfUpload() {
    setSdfUploading(true);
    setSdfError(null);

    const formData = new FormData();
    formData.append("dealId", dealId);
    for (const { file } of sdfFiles) {
      formData.append("files", file);
    }

    const res = await fetch("/api/clo/sdf/ingest", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      setSdfError(data.error || "Upload failed");
    } else {
      setSdfResults(data);
      router.refresh();
    }

    setSdfUploading(false);
  }

  return (
    <section className="ic-section" style={{
      background: "var(--color-accent-subtle)",
      border: "1px solid var(--color-accent)",
      borderRadius: "var(--radius-md)",
      padding: "1.25rem 1.5rem",
    }}>
      <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.5rem" }}>Structured Data Files (SDF)</div>

      <input
        ref={sdfInputRef}
        type="file"
        accept=".csv"
        multiple
        onChange={handleSdfFileChange}
        style={{ display: "none" }}
      />
      <button
        onClick={() => sdfInputRef.current?.click()}
        disabled={sdfUploading}
        className="btn-secondary"
        style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
      >
        {sdfFiles.length > 0 ? `${sdfFiles.length} CSV file${sdfFiles.length !== 1 ? "s" : ""}` : "Choose CSV files..."}
      </button>

      {sdfFiles.length > 0 && (
        <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
          {sdfFiles.map(({ file, fileType, rowCount }) => {
            const recognized = fileType !== null;
            const label = recognized ? SDF_TYPE_LABELS[fileType] : "Unrecognized";
            return (
              <div key={file.name} style={{ fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <span style={{ color: recognized ? "var(--color-success, #22c55e)" : "var(--color-error, #ef4444)" }}>
                  {recognized ? "\u2713" : "\u2717"}
                </span>
                <span>{file.name}</span>
                <span style={{ color: "var(--color-text-muted)" }}>
                  — {recognized ? `${label} \u00b7 ${rowCount} rows` : label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {sdfResults && (
        <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
          {sdfResults.results?.map((r: any) => (
            <div key={r.fileType} style={{ fontSize: "0.8rem", color: r.status === "success" ? "var(--color-success, #22c55e)" : "var(--color-error, #ef4444)" }}>
              {r.status === "success" ? "\u2713" : "\u2717"} {SDF_TYPE_LABELS[r.fileType as SdfFileType] ?? r.fileType} — {r.rowCount} rows
              {r.error && <span> ({r.error})</span>}
            </div>
          ))}
        </div>
      )}

      {sdfFiles.length > 0 && (
        <div style={{ marginTop: "0.5rem" }}>
          <button
            onClick={handleSdfUpload}
            disabled={sdfUploading}
            className="btn-primary"
            style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
          >
            {sdfUploading ? "Uploading..." : "Upload & Ingest"}
          </button>
        </div>
      )}

      {sdfError && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-error, #ef4444)" }}>
          {sdfError}
        </div>
      )}
    </section>
  );
}
