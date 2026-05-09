"use client";

import { useState, useEffect } from "react";
import type { BuyListItem } from "@/lib/clo/types";

interface BuyListLoanSelectorProps {
  onSelect: (item: BuyListItem) => void;
}

export type { BuyListItem };

export default function BuyListLoanSelector({ onSelect }: BuyListLoanSelectorProps) {
  const [items, setItems] = useState<BuyListItem[]>([]);
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/clo/buy-list")
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data) => {
        setItems(data.items || []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  if (!loaded || items.length === 0) return null;

  const query = search.toLowerCase();
  const filtered = items.filter(
    (item) =>
      item.obligorName.toLowerCase().includes(query) ||
      (item.sector?.toLowerCase().includes(query) ?? false)
  );

  function formatRating(item: BuyListItem): string {
    return [item.moodysRating, item.spRating].filter(Boolean).join("/") || "-";
  }

  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: "0.5rem",
        padding: "0.75rem",
        marginBottom: "1rem",
        background: "var(--color-bg-secondary, var(--color-bg-card, transparent))",
      }}
    >
      <label
        style={{
          display: "block",
          fontSize: "0.85rem",
          fontWeight: 600,
          color: "var(--color-text-secondary)",
          marginBottom: "0.5rem",
        }}
      >
        Select from Buy List
      </label>
      <input
        type="text"
        className="ic-input"
        placeholder="Search by name or sector..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: "0.5rem" }}
      />
      <div style={{ maxHeight: "200px", overflowY: "auto" }}>
        {filtered.length === 0 && (
          <div style={{ padding: "0.5rem", color: "var(--color-text-secondary)", fontSize: "0.85rem" }}>
            No matching loans
          </div>
        )}
        {filtered.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "0.5rem",
              border: "none",
              borderBottom: "1px solid var(--color-border)",
              background: "transparent",
              cursor: "pointer",
              fontSize: "0.85rem",
              color: "var(--color-text)",
              borderRadius: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-hover, rgba(128,128,128,0.1))")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <div style={{ fontWeight: 600 }}>{item.obligorName}</div>
            <div style={{ color: "var(--color-text-secondary)", marginTop: "0.15rem" }}>
              {[
                item.sector,
                formatRating(item),
                item.spreadBps != null ? `${item.spreadBps}bps` : null,
                item.currency,
                item.price != null ? `@${item.price}` : null,
              ]
                .filter(Boolean)
                .join(" \u00B7 ")}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
