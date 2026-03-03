"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

export default function UpdateComplianceReport({ hasPortfolio }: { hasPortfolio: boolean }) {
  const [status, setStatus] = useState<"idle" | "uploading" | "extracting" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [progressText, setProgressText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (fileInputRef.current) fileInputRef.current.value = "";

    setError("");
    setStatus("uploading");

    try {
      const formData = new FormData();
      formData.append("files", file);
      formData.append("docType", "compliance");

      const uploadRes = await fetch("/api/clo/profile/upload", {
        method: "POST",
        body: formData,
      });

      if (!uploadRes.ok) {
        const data = await uploadRes.json().catch(() => ({}));
        setError(data.error || "Upload failed");
        setStatus("error");
        return;
      }

      setStatus("extracting");
      setProgressText("Queued — waiting for extraction to start...");

      const extractRes = await fetch("/api/clo/report/extract", { method: "POST" });

      if (!extractRes.ok) {
        const data = await extractRes.json().catch(() => ({}));
        setError(data.error || "Extraction failed");
        setStatus("error");
        return;
      }

      // Also queue portfolio extraction
      fetch("/api/clo/profile/extract-portfolio", { method: "POST" }).catch(() => {});

      // Poll for completion (up to 40 minutes)
      for (let i = 0; i < 480; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const pollRes = await fetch("/api/clo/report/extract");
          if (pollRes.ok) {
            const data = await pollRes.json();
            if (data.status === "complete") {
              setStatus("done");
              setProgressText("");
              router.refresh();
              setTimeout(() => setStatus("idle"), 3000);
              return;
            }
            if (data.status === "error") {
              setError(data.error || "Extraction failed");
              setStatus("error");
              setProgressText("");
              return;
            }
            const detail = data.progress?.detail;
            if (detail) {
              setProgressText(detail);
            } else if (data.status === "extracting") {
              setProgressText("Extracting compliance data...");
            }
          }
        } catch {
          // Continue polling
        }
      }

      setStatus("done");
      setProgressText("");
      router.refresh();
    } catch (e) {
      setError(`Failed: ${(e as Error).message}`);
      setStatus("error");
      setProgressText("");
    }
  }

  const buttonLabel =
    status === "uploading"
      ? "Uploading..."
      : status === "extracting"
        ? "Extracting..."
        : status === "done"
          ? "Done"
          : status === "error"
            ? "Retry"
            : hasPortfolio
              ? "Update Report"
              : "Upload Report";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        onChange={handleFileSelected}
        style={{ display: "none" }}
      />
      <button
        className={hasPortfolio ? "btn-secondary" : "btn-primary"}
        onClick={() => {
          if (status === "error") setError("");
          fileInputRef.current?.click();
        }}
        disabled={status === "uploading" || status === "extracting"}
        style={{ fontSize: "0.85rem" }}
      >
        {buttonLabel}
      </button>
      {status === "extracting" && progressText && (
        <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <span className="spinner" style={{ width: "0.7rem", height: "0.7rem", flexShrink: 0 }} />
          {progressText}
        </span>
      )}
      {status === "done" && (
        <span style={{ fontSize: "0.8rem", color: "var(--color-high, #16a34a)" }}>
          Extraction complete
        </span>
      )}
      {error && (
        <span style={{ color: "var(--color-error, #dc2626)", fontSize: "0.8rem" }}>{error}</span>
      )}
    </div>
  );
}
