"use client";

import { useState, useRef } from "react";
import type { BuyListItem } from "@/lib/clo/types";

export default function BuyListUpload({ initialItems }: { initialItems: BuyListItem[] }) {
  const [items, setItems] = useState<BuyListItem[]>(initialItems);
  const [expanded, setExpanded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError("");
    setSuccess("");
    setUploading(true);

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch("/api/clo/buy-list", { method: "POST", body: formData });
    const data = await res.json();

    if (!res.ok) {
      setError(data.error || "Upload failed");
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setSuccess(data.message);

    const listRes = await fetch("/api/clo/buy-list");
    if (listRes.ok) {
      const listData = await listRes.json();
      setItems(listData.items);
    }

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleClear() {
    if (!confirm("Clear all buy list items?")) return;

    setError("");
    setSuccess("");

    const res = await fetch("/api/clo/buy-list", { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Failed to clear buy list");
      return;
    }

    setItems([]);
    setSuccess("Buy list cleared");
    setExpanded(false);
  }

  function formatNumber(n: number | null): string {
    if (n == null) return "-";
    return n.toLocaleString();
  }

  return (
    <section className="ic-section" style={{
      background: "var(--color-surface)",
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-md)",
      padding: "1.25rem 1.5rem",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <h3 style={{ margin: 0, fontSize: "1rem", fontFamily: "var(--font-display)" }}>
          Buy List
          {items.length > 0 && (
            <span style={{ marginLeft: "0.5rem", fontSize: "0.8rem", color: "var(--color-text-muted)", fontWeight: 400 }}>
              ({items.length} item{items.length !== 1 ? "s" : ""})
            </span>
          )}
        </h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="btn-secondary"
            style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
          >
            {uploading ? "Uploading..." : items.length > 0 ? "Update CSV" : "Upload CSV"}
          </button>
          {items.length > 0 && (
            <>
              <button
                onClick={() => setExpanded(!expanded)}
                className="btn-secondary"
                style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
              >
                {expanded ? "Collapse" : "View"}
              </button>
              <button
                onClick={handleClear}
                className="btn-secondary"
                style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem", color: "var(--color-error, #ef4444)" }}
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-error, #ef4444)" }}>
          {error}
        </div>
      )}

      {success && (
        <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-success, #22c55e)" }}>
          {success}
        </div>
      )}

      {expanded && items.length > 0 && (
        <div style={{ marginTop: "0.75rem", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                {["Obligor", "Sector", "Rating", "Spread", "Price", "Maturity", "Max Size", "Leverage", "Avg Life", "Recovery"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "0.4rem 0.6rem", fontWeight: 600, color: "var(--color-text-muted)", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const rating = [item.moodysRating, item.spRating].filter(Boolean).join("/") || "-";
                return (
                  <tr key={item.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                    <td style={{ padding: "0.4rem 0.6rem", whiteSpace: "nowrap" }}>{item.obligorName}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{item.sector || "-"}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{rating}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{item.spreadBps != null ? `${item.spreadBps}` : "-"}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{item.price != null ? `${item.price}` : "-"}</td>
                    <td style={{ padding: "0.4rem 0.6rem", whiteSpace: "nowrap" }}>{item.maturityDate || "-"}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{formatNumber(item.facilitySize)}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{item.leverage != null ? `${item.leverage}x` : "-"}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{item.averageLifeYears != null ? `${item.averageLifeYears}y` : "-"}</td>
                    <td style={{ padding: "0.4rem 0.6rem" }}>{item.recoveryRate != null ? `${item.recoveryRate}%` : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
