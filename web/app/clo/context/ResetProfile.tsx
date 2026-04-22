"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ResetProfile() {
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const router = useRouter();

  async function handleReset() {
    setResetting(true);
    const res = await fetch("/api/clo/profile/reset", { method: "POST" });
    if (res.ok) {
      router.push("/clo");
      router.refresh();
    } else {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      alert(`Reset failed: ${body.error ?? `HTTP ${res.status}`}`);
      setResetting(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <span style={{ fontSize: "0.8rem", color: "var(--color-error, #ef4444)" }}>
          This will delete all documents, extracted data, and compliance reports.
        </span>
        <button
          className="btn-secondary"
          onClick={() => setConfirming(false)}
          disabled={resetting}
          style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem" }}
        >
          Cancel
        </button>
        <button
          onClick={handleReset}
          disabled={resetting}
          style={{
            fontSize: "0.8rem",
            padding: "0.35rem 0.7rem",
            background: "var(--color-error, #ef4444)",
            color: "white",
            border: "none",
            borderRadius: "var(--radius-sm)",
            cursor: resetting ? "wait" : "pointer",
          }}
        >
          {resetting ? "Resetting..." : "Confirm Reset"}
        </button>
      </div>
    );
  }

  return (
    <button
      className="btn-secondary"
      onClick={() => setConfirming(true)}
      style={{ fontSize: "0.8rem", padding: "0.35rem 0.7rem", whiteSpace: "nowrap" }}
    >
      Clear &amp; Re-upload
    </button>
  );
}
