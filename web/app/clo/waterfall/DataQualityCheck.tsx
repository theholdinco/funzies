"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  dataQualityErrorMessage,
  parseWarnings,
  type DataQualityWarning as Warning,
} from "./data-quality-utils";

interface Props {
  panelId: string;
  dealContext: Record<string, unknown>;
}

export default function DataQualityCheck({ panelId, dealContext }: Props) {
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dealContextKey = useMemo(() => JSON.stringify(dealContext), [dealContext]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    async function check() {
      try {
        const parsedDealContext = JSON.parse(dealContextKey);
        const res = await fetch("/api/clo/waterfall/check-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ panelId, dealContext: parsedDealContext }),
          signal: controller.signal,
        });

        if (!res.ok) {
          if (controller.signal.aborted) return;
          setError(await dataQualityErrorMessage(res));
          setLoading(false);
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
          if (controller.signal.aborted) return;
          setLoading(false);
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let sawTerminalEvent = false;

        const processLine = (rawLine: string) => {
          const line = rawLine.trimEnd();
          if (!line.startsWith("data: ")) return;
          const data = line.slice(6);
          try {
            const event = JSON.parse(data);
            if (event.type === "text") {
              fullText += event.content;
            }
            if (event.type === "error") {
              throw new Error(event.message || "Data quality stream failed");
            }
            if (event.type === "done") {
              sawTerminalEvent = true;
            }
          } catch (err) {
            if (err instanceof Error && err.message !== "Unexpected end of JSON input") {
              throw err;
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) processLine(line);
          if (sawTerminalEvent) break;
        }

        buffer += decoder.decode();
        if (buffer.trim()) processLine(buffer);
        if (!sawTerminalEvent) {
          throw new Error("Data quality stream ended before completion");
        }
        const parsed = parseWarnings(fullText);
        if (controller.signal.aborted) return;
        setWarnings(parsed);
      } catch (err) {
        if (!controller.signal.aborted && (err as Error).name !== "AbortError") {
          setError("Data quality check failed");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    check();

    return () => controller.abort();
  }, [panelId, dealContextKey]);

  if (error) {
    return (
      <div
        className="wf-section"
        style={{
          padding: "0.85rem 1rem",
          marginBottom: "1.5rem",
          border: "1px solid var(--color-border-light)",
          borderRadius: "var(--radius-sm)",
          color: "var(--color-text-muted)",
          fontSize: "0.82rem",
          background: "var(--color-surface)",
        }}
      >
        {error}
      </div>
    );
  }
  if (loading) {
    return (
      <div
        className="wf-section"
        style={{
          padding: "0.85rem 1rem",
          marginBottom: "1.5rem",
          border: "1px solid var(--color-border-light)",
          borderRadius: "var(--radius-sm)",
          color: "var(--color-text-muted)",
          fontSize: "0.82rem",
          background: "var(--color-surface)",
        }}
      >
        Checking data quality...
      </div>
    );
  }
  if (warnings.length === 0) return null;

  const severityStyles = {
    error: { bg: "var(--color-low-bg)", border: "var(--color-low-border)", text: "var(--color-low)" },
    warning: { bg: "var(--color-medium-bg)", border: "var(--color-medium-border)", text: "var(--color-medium)" },
    info: { bg: "#eff6ff", border: "#93c5fd", text: "#1e40af" },
  };

  return (
    <div className="wf-section" style={{ marginBottom: "2rem" }}>
      <h3
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "0.95rem",
          fontWeight: 600,
          marginBottom: "0.75rem",
        }}
      >
        Data Quality
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        {warnings.map((w, i) => {
          const styles = severityStyles[w.severity];
          return (
            <div
              key={i}
              style={{
                padding: "0.65rem 0.85rem",
                background: styles.bg,
                border: `1px solid ${styles.border}`,
                borderRadius: "var(--radius-sm)",
                fontSize: "0.8rem",
                color: styles.text,
              }}
            >
              <div style={{ fontWeight: 500, marginBottom: w.action ? "0.2rem" : 0 }}>{w.message}</div>
              {w.action && (
                <div style={{ fontSize: "0.72rem", opacity: 0.8 }}>
                  {w.action}
                  {w.severity === "error" && (
                    <>
                      {" "}
                      <Link
                        href="/clo/context"
                        style={{ color: styles.text, textDecoration: "underline" }}
                      >
                        Fix in Context Editor
                      </Link>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
