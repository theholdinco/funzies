"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ExtractPortfolioButton({ hasPortfolio }: { hasPortfolio: boolean }) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  async function handleExtract() {
    setLoading(true);
    setError("");
    setStatus("Starting extraction...");

    try {
      const res = await fetch("/api/clo/report/extract", { method: "POST" });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Extraction failed");
        setLoading(false);
        setStatus("");
        return;
      }

      const result = await res.json().catch(() => ({}));
      const extractionStatus = result.status === "complete" ? "Extraction complete!" : "Extraction partially complete.";
      setStatus(extractionStatus);
      setLoading(false);
      router.refresh();
    } catch (e) {
      setError(`Extraction failed: ${(e as Error).message}`);
      setLoading(false);
      setStatus("");
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
      <button
        className={hasPortfolio ? "btn-secondary" : "btn-primary"}
        onClick={handleExtract}
        disabled={loading}
        style={{ fontSize: "0.85rem" }}
      >
        {loading
          ? "Extracting..."
          : hasPortfolio
            ? "Re-extract Portfolio Data"
            : "Extract Portfolio Data"}
      </button>
      {loading && status && (
        <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>{status}</span>
      )}
      {error && (
        <span style={{ color: "var(--color-error)", fontSize: "0.8rem" }}>{error}</span>
      )}
    </div>
  );
}
