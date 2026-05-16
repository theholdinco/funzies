import React from "react";

export function SummaryCard({
  label,
  value,
  subValue,
  subValueSeverity,
}: {
  label: string;
  value: string;
  /** Optional small context line shown below the main value (e.g.
   *  "87% in first 8 quarters"). Hidden when undefined. */
  subValue?: string;
  /** Visual styling for the subValue: "info" (default — muted text),
   *  "warn" (amber, for partner-facing concentration / wipeout signals). */
  subValueSeverity?: "info" | "warn";
}) {
  const subValueColor =
    subValueSeverity === "warn"
      ? "var(--color-warning, #d97706)"
      : "var(--color-text-muted)";
  return (
    <div
      style={{
        padding: "1.25rem",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border-light)",
        borderRadius: "var(--radius-sm)",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: "0.7rem", fontWeight: 500, color: "var(--color-text-muted)", marginBottom: "0.35rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "1.15rem",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          color: "var(--color-text)",
        }}
      >
        {value}
      </div>
      {subValue && (
        <div
          style={{
            fontSize: "0.7rem",
            fontWeight: 500,
            color: subValueColor,
            marginTop: "0.3rem",
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {subValue}
        </div>
      )}
    </div>
  );
}
