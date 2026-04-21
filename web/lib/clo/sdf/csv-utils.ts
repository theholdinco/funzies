const MONTH_MAP: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

export function parseCsvLines(csvText: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const cleaned = csvText.replace(/^\uFEFF/, "");
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCsvRow(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return { headers, rows };
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

export function parseNumeric(value: string | undefined | null): number | null {
  if (value == null || value.trim() === "") return null;
  let cleaned = value.trim();
  const isNegative = cleaned.startsWith("(") && cleaned.endsWith(")");
  if (isNegative) cleaned = cleaned.slice(1, -1);
  cleaned = cleaned.replace(/,/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return isNegative ? -num : num;
}

export function parseBoolean(value: string | undefined | null): boolean | null {
  if (value == null || value.trim() === "") return null;
  const v = value.trim().toUpperCase();
  if (v === "TRUE" || v === "YES") return true;
  if (v === "FALSE" || v === "NO") return false;
  return null;
}

export function parseDate(
  value: string | undefined | null,
  expectedFormat: "DD.MM.YYYY" | "DD-Mon-YYYY" | "DD Mon YYYY"
): string | null {
  if (value == null || value.trim() === "") return null;
  const v = value.trim();

  const tryParse = (fmt: string, s: string): string | null => {
    if (fmt === "DD.MM.YYYY") {
      const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    }
    if (fmt === "DD-Mon-YYYY") {
      const m = s.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
      if (m && MONTH_MAP[m[2]]) return `${m[3]}-${MONTH_MAP[m[2]]}-${m[1]}`;
    }
    if (fmt === "DD Mon YYYY") {
      const m = s.match(/^(\d{2})\s+([A-Za-z]{3})\s+(\d{4})$/);
      if (m && MONTH_MAP[m[2]]) return `${m[3]}-${MONTH_MAP[m[2]]}-${m[1]}`;
    }
    return null;
  };

  const result = tryParse(expectedFormat, v);
  if (result) return result;

  for (const fmt of ["DD.MM.YYYY", "DD-Mon-YYYY", "DD Mon YYYY"] as const) {
    if (fmt === expectedFormat) continue;
    const fallback = tryParse(fmt, v);
    if (fallback) {
      console.warn(`SDF date "${v}" parsed with fallback format ${fmt} instead of ${expectedFormat}`);
      return fallback;
    }
  }

  console.warn(`SDF date "${v}" could not be parsed with any format`);
  return null;
}

export function parsePercentage(value: string | undefined | null): number | null {
  if (value == null || value.trim() === "") return null;
  const cleaned = value.trim().replace(/%$/, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

export function trimRating(value: string | undefined | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function spreadToBps(value: number | undefined | null): number | null {
  if (value == null) return null;
  return Math.round(value * 100);
}
