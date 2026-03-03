"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

export default function UpdateComplianceReport({ hasPortfolio }: { hasPortfolio: boolean }) {
  const [status, setStatus] = useState<"idle" | "uploading" | "extracting" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const router = useRouter();

  function startTimer() {
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((t) => t + 1), 1000);
  }

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

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
      startTimer();

      const extractRes = await fetch("/api/clo/report/extract", { method: "POST" });

      if (!extractRes.ok) {
        stopTimer();
        const data = await extractRes.json().catch(() => ({}));
        setError(data.error || "Extraction failed");
        setStatus("error");
        return;
      }

      // Also queue portfolio extraction
      fetch("/api/clo/profile/extract-portfolio", { method: "POST" }).catch(() => {});

      // Poll for completion
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const pollRes = await fetch("/api/clo/report/extract");
          if (pollRes.ok) {
            const data = await pollRes.json();
            if (data.status === "complete") {
              stopTimer();
              setStatus("done");
              router.refresh();
              setTimeout(() => setStatus("idle"), 3000);
              return;
            }
            if (data.status === "error") {
              stopTimer();
              setError(data.error || "Extraction failed");
              setStatus("error");
              return;
            }
          }
        } catch {
          // Continue polling
        }
      }

      stopTimer();
      setError("Extraction timed out. Please refresh to check status.");
      setStatus("error");
    } catch (e) {
      stopTimer();
      setError(`Failed: ${(e as Error).message}`);
      setStatus("error");
    }
  }

  const buttonLabel =
    status === "uploading"
      ? "Uploading..."
      : status === "extracting"
        ? `Extracting... ${elapsed}s`
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
      {status === "extracting" && (
        <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
          Extracting compliance data (this takes up to 10 minutes)...
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
