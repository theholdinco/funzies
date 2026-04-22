"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export default function JsonUploadSection() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const ppmRef = useRef<HTMLInputElement>(null);
  const complianceRef = useRef<HTMLInputElement>(null);

  async function onUpload(kind: "ppm" | "compliance", file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("File is not valid JSON");
      }
      const res = await fetch("/api/clo/profile/extract-from-json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [kind]: parsed }),
      });
      const respText = await res.text();
      let data: Record<string, unknown> | null = null;
      if (respText.trim()) {
        try {
          data = JSON.parse(respText) as Record<string, unknown>;
        } catch {
          throw new Error(`Server returned non-JSON (${res.status}): ${respText.slice(0, 400)}`);
        }
      }
      if (!res.ok) {
        const msg = (data?.error as string | undefined)
          ?? (data?.message as string | undefined)
          ?? `HTTP ${res.status}${respText.trim() ? ` · ${respText.slice(0, 200)}` : " (empty body — check server logs)"}`;
        throw new Error(msg);
      }
      setResult(data ?? { status: "ok" });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleFileChange(kind: "ppm" | "compliance", e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onUpload(kind, file);
    e.target.value = "";
  }

  return (
    <section className="ic-section" style={{ marginBottom: "1.5rem" }}>
      <h2 style={{ fontSize: "0.9rem", margin: "0 0 0.5rem" }}>Upload JSON Data</h2>
      <p style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", margin: "0 0 0.75rem" }}>
        Import extracted PPM or compliance data directly from a JSON file.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <input
          ref={ppmRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => handleFileChange("ppm", e)}
        />
        <input
          ref={complianceRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={(e) => handleFileChange("compliance", e)}
        />
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={() => ppmRef.current?.click()}
          style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem", cursor: busy ? "wait" : "pointer" }}
        >
          Upload PPM JSON
        </button>
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={() => complianceRef.current?.click()}
          style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem", cursor: busy ? "wait" : "pointer" }}
        >
          Upload Compliance JSON
        </button>
        {busy && (
          <span style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
            Uploading…
          </span>
        )}
      </div>
      {error && (
        <p style={{ fontSize: "0.8rem", color: "var(--color-error, #ef4444)", margin: "0.5rem 0 0" }}>
          {error}
        </p>
      )}
      {result && (
        <p style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)", margin: "0.5rem 0 0" }}>
          Import successful.{" "}
          {typeof result.extracted === "number" ? `${result.extracted} fields extracted.` : "Data saved."}
        </p>
      )}
    </section>
  );
}
