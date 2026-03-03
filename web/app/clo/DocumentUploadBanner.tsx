"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

export default function DocumentUploadBanner({ hasDocuments }: { hasDocuments?: boolean }) {
  const [ppmFiles, setPpmFiles] = useState<File[]>([]);
  const [complianceFiles, setComplianceFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const ppmInputRef = useRef<HTMLInputElement>(null);
  const complianceInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const pollExtraction = useCallback(async () => {
    setExtracting(true);
    setStatusText("Extracting constraints from PPM...");

    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));

      const res = await fetch("/api/clo/profile/extract");
      if (!res.ok) continue;

      const data = await res.json();

      if (data.status === "complete") {
        if (data.extractedConstraints) {
          await fetch("/api/clo/profile/constraints", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ extractedConstraints: data.extractedConstraints }),
          });
        }
        setStatusText("");
        setExtracting(false);
        setDone(true);
        router.refresh();
        return;
      }

      if (data.status === "error") {
        setError(data.error || "Extraction failed");
        setExtracting(false);
        setStatusText("");
        return;
      }

      if (data.status === "extracting") {
        setStatusText("Extracting constraints from PPM (this may take several minutes for large documents)...");
      }
    }

    setError("Extraction timed out. Check back later.");
    setExtracting(false);
    setStatusText("");
  }, [router]);

  async function handleUpload() {
    if (ppmFiles.length === 0 && complianceFiles.length === 0) return;
    setError("");
    setUploading(true);

    // Upload PPM files
    if (ppmFiles.length > 0) {
      const ppmFormData = new FormData();
      ppmFiles.forEach((f) => ppmFormData.append("files", f));
      ppmFormData.append("docType", "ppm");

      const ppmRes = await fetch("/api/clo/profile/upload", {
        method: "POST",
        body: ppmFormData,
      });

      if (!ppmRes.ok) {
        const data = await ppmRes.json();
        setError(data.error || "PPM upload failed.");
        setUploading(false);
        return;
      }
    }

    // Upload compliance files
    if (complianceFiles.length > 0) {
      const compFormData = new FormData();
      complianceFiles.forEach((f) => compFormData.append("files", f));
      compFormData.append("docType", "compliance");

      const compRes = await fetch("/api/clo/profile/upload", {
        method: "POST",
        body: compFormData,
      });

      if (!compRes.ok) {
        const data = await compRes.json();
        setError(data.error || "Compliance report upload failed.");
        setUploading(false);
        return;
      }
    }

    setUploading(false);
    const hadPpm = ppmFiles.length > 0;
    const hadCompliance = complianceFiles.length > 0;
    setPpmFiles([]);
    setComplianceFiles([]);

    // Queue PPM extraction
    if (hadPpm) {
      await fetch("/api/clo/profile/extract", { method: "POST" });
    }

    // Queue compliance report extraction + portfolio extraction
    if (hadCompliance) {
      setExtracting(true);
      setStatusText("Extracting compliance data (this may take several minutes)...");
      fetch("/api/clo/report/extract", { method: "POST" })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setError(data.error || "Report extraction failed");
          }
        })
        .catch(() => {});
      fetch("/api/clo/profile/extract-portfolio", { method: "POST" }).catch(() => {});
    }

    // Start polling for PPM extraction completion
    if (hadPpm) {
      pollExtraction();
    } else if (hadCompliance) {
      // Poll for compliance extraction by checking report periods
      pollComplianceExtraction();
    }
  }

  async function pollComplianceExtraction() {
    setExtracting(true);
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const elapsed = (i + 1) * 5;
      setStatusText(`Extracting compliance data (${elapsed}s)...`);
      try {
        const res = await fetch("/api/clo/report/extract");
        if (res.ok) {
          const data = await res.json();
          if (data.status === "complete") {
            setExtracting(false);
            setDone(true);
            setStatusText("");
            router.refresh();
            return;
          }
          if (data.status === "error") {
            setExtracting(false);
            setError(data.error || "Report extraction failed");
            setStatusText("");
            return;
          }
        }
      } catch {
        // Continue polling
      }
    }
    setExtracting(false);
    setDone(true);
    setStatusText("");
    router.refresh();
  }

  const busy = uploading || extracting;
  const hasFiles = ppmFiles.length > 0 || complianceFiles.length > 0;

  // Hide when docs exist and no active extraction/upload
  if (hasDocuments && !busy && !error && !done) return null;

  // Show completion message briefly
  if (done && !busy) {
    return (
      <section className="ic-section" style={{
        background: "var(--color-accent-subtle)",
        border: "1px solid var(--color-success, #22c55e)",
        borderRadius: "var(--radius-md)",
        padding: "1rem 1.5rem",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", color: "var(--color-success, #22c55e)" }}>
          Extraction complete. Refresh the page to see updated data.
          <button className="btn-secondary" onClick={() => { setDone(false); router.refresh(); }} style={{ fontSize: "0.8rem", marginLeft: "auto" }}>
            Refresh
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="ic-section" style={{
      background: "var(--color-accent-subtle)",
      border: "1px solid var(--color-accent)",
      borderRadius: "var(--radius-md)",
      padding: "1.25rem 1.5rem",
    }}>
      <h3 style={{ margin: "0 0 0.4rem", fontSize: "1rem", fontFamily: "var(--font-display)" }}>
        Upload Documents
      </h3>
      <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
        Upload your PPM and compliance reports separately to unlock constraint extraction, portfolio monitoring,
        and compliance-aware analysis.
      </p>

      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.3rem" }}>PPM / Listing Particulars</div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              ref={ppmInputRef}
              type="file"
              accept=".pdf"
              multiple
              onChange={(e) => setPpmFiles(Array.from(e.target.files || []))}
              style={{ display: "none" }}
            />
            <button
              onClick={() => ppmInputRef.current?.click()}
              disabled={busy}
              className="btn-secondary"
              style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
            >
              {ppmFiles.length > 0
                ? `${ppmFiles.length} PPM file${ppmFiles.length !== 1 ? "s" : ""}`
                : "Choose PPM"}
            </button>
          </div>
          {ppmFiles.length > 0 && !busy && (
            <div style={{ marginTop: "0.3rem", fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
              {ppmFiles.map((f) => f.name).join(", ")}
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.3rem" }}>Compliance / Trustee Report (optional)</div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              ref={complianceInputRef}
              type="file"
              accept=".pdf"
              multiple
              onChange={(e) => setComplianceFiles(Array.from(e.target.files || []))}
              style={{ display: "none" }}
            />
            <button
              onClick={() => complianceInputRef.current?.click()}
              disabled={busy}
              className="btn-secondary"
              style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
            >
              {complianceFiles.length > 0
                ? `${complianceFiles.length} report${complianceFiles.length !== 1 ? "s" : ""}`
                : "Choose Reports"}
            </button>
          </div>
          {complianceFiles.length > 0 && !busy && (
            <div style={{ marginTop: "0.3rem", fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
              {complianceFiles.map((f) => f.name).join(", ")}
            </div>
          )}
        </div>
      </div>

      {hasFiles && (
        <div style={{ marginTop: "0.75rem" }}>
          <button
            onClick={handleUpload}
            disabled={busy}
            className="btn-primary"
            style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
          >
            {uploading ? "Uploading..." : "Upload & Extract"}
          </button>
        </div>
      )}

      {statusText && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-text-muted)", display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <span className="spinner" style={{ width: "0.8rem", height: "0.8rem" }} />
          {statusText}
        </div>
      )}

      {error && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-error, #ef4444)" }}>
          {error}
        </div>
      )}
    </section>
  );
}
