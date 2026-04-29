import React from "react";
import type { PeriodResult } from "@/lib/clo/projection";
import { formatAmount } from "./helpers";
import { buildPeriodTraceLines, isAccelerationPeriod, type PeriodTraceLine } from "./period-trace-lines";

/**
 * Renders the per-period waterfall trace using engine-emitted values.
 *
 * Architectural contract: this component MUST NOT compute semantic
 * numbers. All amounts come from the helper (`buildPeriodTraceLines`)
 * which reads engine output directly. The Phase 6 AST enforcement test
 * forbids `inputs.<member>` arithmetic in this file.
 *
 * See CLAUDE.md § Engine ↔ UI separation.
 */
export function PeriodTrace({ period }: { period: PeriodResult }) {
  const lines = buildPeriodTraceLines(period);
  const acceleration = isAccelerationPeriod(lines);

  const interestLines = lines.filter((l) => l.section === "interest");
  const principalLines = lines.filter((l) => l.section === "principal");
  const summaryLines = lines.filter((l) => l.section === "summary");

  return (
    <div style={containerStyle}>
      {acceleration && <AccelerationHeader />}

      <SectionHeader>Interest Waterfall</SectionHeader>
      {interestLines.map((line, i) => (
        <Line key={`i-${i}`} line={line} />
      ))}

      <SectionHeader style={{ marginTop: "0.75rem" }}>Principal Waterfall</SectionHeader>
      {principalLines.map((line, i) => (
        <Line key={`p-${i}`} line={line} />
      ))}

      {summaryLines.length > 0 && (
        <>
          <div style={dividerStyle} />
          {summaryLines.map((line, i) => (
            <Line key={`s-${i}`} line={line} />
          ))}
        </>
      )}

      {(period.ocTests.length > 0 || period.icTests.length > 0) && (
        <div style={{ ...lineStyle, ...indentStyle(1), flexWrap: "wrap", gap: "0.4rem", marginTop: "0.4rem" }}>
          {period.ocTests.map((t) => (
            <span key={`oc-${t.className}`} style={{ color: t.passing ? "var(--color-high)" : "var(--color-low)", fontSize: "0.68rem" }}>
              {t.passing ? "✓" : "✗"} {t.className} OC {t.actual.toFixed(1)}%
            </span>
          ))}
          {period.icTests.map((t) => (
            <span key={`ic-${t.className}`} style={{ color: t.passing ? "var(--color-high)" : "var(--color-low)", fontSize: "0.68rem" }}>
              {t.passing ? "✓" : "✗"} {t.className} IC {t.actual.toFixed(1)}%
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Line({ line }: { line: PeriodTraceLine }) {
  // Hide rows where the engine emits null (e.g. availableForTranches under
  // acceleration). Acceleration header is rendered separately at the top.
  if (line.amount === null) return null;

  const color =
    line.severity === "fee" ? "var(--color-low)" :
    line.severity === "warn" ? "var(--color-low)" :
    line.severity === "equity" ? "var(--color-high)" :
    undefined;

  const isOutflow = line.outflow && line.amount > 0;
  const formatted = isOutflow ? `-${formatAmount(line.amount)}` : formatAmount(line.amount);

  const fontWeight = line.severity === "equity" ? 600 : undefined;

  const rowStyle: React.CSSProperties = {
    ...lineStyle,
    ...indentStyle(line.indent ?? 0),
    ...(line.muted ? mutedStyle : {}),
    fontWeight,
  };
  const labelStyleResolved: React.CSSProperties = {
    color: color ?? (line.indent ? "var(--color-text-muted)" : undefined),
  };
  const amountStyleResolved: React.CSSProperties = { color };

  return (
    <div style={rowStyle}>
      <span style={labelStyleResolved}>
        {line.ppmStep && <span style={ppmStepStyle}>({line.ppmStep})</span>}
        {line.label}
      </span>
      <span style={amountStyleResolved}>{formatted}</span>
    </div>
  );
}

function AccelerationHeader() {
  return (
    <div style={accelHeaderStyle}>
      <strong>Accelerated distribution active.</strong>{" "}
      Interest and principal pool together, with tranches paid sequentially by
      seniority. Senior-expenses cap is suspended (PPM § 10(b)).
    </div>
  );
}

function SectionHeader({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontWeight: 600,
      fontSize: "0.68rem",
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      color: "var(--color-text-muted)",
      marginBottom: "0.4rem",
      ...style,
    }}>{children}</div>
  );
}

const containerStyle: React.CSSProperties = {
  padding: "0.75rem 1rem",
  background: "var(--color-surface-alt, var(--color-surface))",
  borderTop: "1px dashed var(--color-border-light)",
  fontSize: "0.72rem",
};

const lineStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "0.2rem 0",
  fontSize: "0.72rem",
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
};

function indentStyle(level: 0 | 1 | 2): React.CSSProperties {
  if (level === 0) return {};
  return { paddingLeft: level === 1 ? "1.2rem" : "2.4rem" };
}

const mutedStyle: React.CSSProperties = {
  opacity: 0.55,
  fontStyle: "italic",
  fontSize: "0.68rem",
};

const ppmStepStyle: React.CSSProperties = {
  fontSize: "0.62rem",
  fontWeight: 500,
  marginRight: "0.4rem",
  opacity: 0.65,
  fontFamily: "var(--font-mono)",
};

const dividerStyle: React.CSSProperties = {
  borderTop: "1px solid var(--color-border-light)",
  margin: "0.3rem 0",
};

const accelHeaderStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  marginBottom: "0.6rem",
  background: "var(--color-warning-bg, rgba(255, 193, 7, 0.08))",
  border: "1px solid var(--color-warning-border, rgba(255, 193, 7, 0.4))",
  borderRadius: "4px",
  fontSize: "0.68rem",
  lineHeight: 1.4,
};
