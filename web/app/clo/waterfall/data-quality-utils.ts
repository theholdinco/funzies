export interface DataQualityWarning {
  severity: "error" | "warning" | "info";
  message: string;
  action: string;
}

export async function dataQualityErrorMessage(res: Response): Promise<string> {
  let message =
    res.status === 409
      ? "Report data changed. Refresh to rerun data quality."
      : "Could not run data quality check.";
  try {
    const body = await res.json();
    if (typeof body?.error === "string" && body.error.trim()) {
      message = res.status === 409
        ? `${body.error}. Refresh to rerun data quality.`
        : body.error;
    }
  } catch {
    // keep status-derived message
  }
  return message;
}

export function parseWarnings(text: string): DataQualityWarning[] {
  const warnings: DataQualityWarning[] = [];

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.severity && item.message) {
            warnings.push({
              severity: item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "info",
              message: item.message,
              action: item.action || "",
            });
          }
        }
        return warnings;
      }
    }
  } catch {
    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith("```json")) {
      throw new Error("Data quality response was not valid JSON");
    }
  }

  const lines = text.split("\n").filter((line) => line.trim());
  for (const line of lines) {
    const stripped = line.replace(/^[-*]\s*/, "").trim();
    if (!stripped) continue;

    let severity: DataQualityWarning["severity"] = "info";
    if (/\b(error|missing|required|blocking)\b/i.test(stripped)) severity = "error";
    else if (/\b(warning|unusual|mismatch|verify|check)\b/i.test(stripped)) severity = "warning";

    const dashIdx = stripped.indexOf("—");
    if (dashIdx > 0) {
      warnings.push({
        severity,
        message: stripped.slice(0, dashIdx).trim(),
        action: stripped.slice(dashIdx + 1).trim(),
      });
    } else {
      warnings.push({ severity, message: stripped, action: "" });
    }
  }

  return warnings;
}
