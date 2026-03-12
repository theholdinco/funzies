import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { getProfileForUser } from "@/lib/clo/access";
import { getBuyListForProfile, replaceBuyList, clearBuyList } from "@/lib/clo/buy-list";
import type { BuyListItem } from "@/lib/clo/types";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ROWS = 500;

type ParsedItem = Omit<BuyListItem, "id" | "profileId" | "createdAt">;

function normalizeHeader(header: string): string {
  return header.toLowerCase().trim().replace(/[\s\-]+/g, "_").replace(/[']/g, "");
}

const COLUMN_MAP: Record<string, string> = {
  obligor: "obligorName",
  obligor_name: "obligorName",
  borrower: "obligorName",
  borrower_name: "obligorName",
  name: "obligorName",
  facility: "facilityName",
  facility_name: "facilityName",
  sector: "sector",
  industry: "sector",
  moodys: "moodysRating",
  moodys_rating: "moodysRating",
  moody_s: "moodysRating",
  sp: "spRating",
  sp_rating: "spRating",
  "s&p": "spRating",
  spread: "spreadBps",
  spread_bps: "spreadBps",
  reference_rate: "referenceRate",
  ref_rate: "referenceRate",
  price: "price",
  offer_price: "price",
  current_price: "price",
  maturity: "maturityDate",
  maturity_date: "maturityDate",
  facility_size: "facilitySize",
  size: "facilitySize",
  max_size: "facilitySize",
  leverage: "leverage",
  interest_coverage: "interestCoverage",
  ic: "interestCoverage",
  cov_lite: "isCovLite",
  covenant_lite: "isCovLite",
  average_life: "averageLifeYears",
  avg_life: "averageLifeYears",
  wal: "averageLifeYears",
  recovery: "recoveryRate",
  recovery_rate: "recoveryRate",
  notes: "notes",
  commentary: "notes",
};

const NUMERIC_FIELDS = new Set([
  "spreadBps", "price", "facilitySize", "leverage",
  "interestCoverage", "averageLifeYears", "recoveryRate",
]);

function parseNumber(value: string): number | null {
  const cleaned = value.replace(/[,$%]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function parseBoolean(value: string): boolean | null {
  const v = value.toLowerCase().trim();
  if (["true", "yes", "y", "1"].includes(v)) return true;
  if (["false", "no", "n", "0"].includes(v)) return false;
  return null;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(text: string): ParsedItem[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("CSV must have a header row and at least one data row");

  const headers = parseCsvLine(lines[0]);
  const fieldMap: (string | null)[] = headers.map((h) => {
    const normalized = normalizeHeader(h);
    return COLUMN_MAP[normalized] ?? null;
  });

  if (!fieldMap.includes("obligorName")) {
    throw new Error("CSV must include an obligor/borrower/name column");
  }

  const dataLines = lines.slice(1);
  if (dataLines.length > MAX_ROWS) {
    throw new Error(`CSV exceeds maximum of ${MAX_ROWS} rows (found ${dataLines.length})`);
  }

  const items: ParsedItem[] = [];

  for (const line of dataLines) {
    const values = parseCsvLine(line);
    const item: Record<string, unknown> = {
      obligorName: "",
      facilityName: null,
      sector: null,
      moodysRating: null,
      spRating: null,
      spreadBps: null,
      referenceRate: null,
      price: null,
      maturityDate: null,
      facilitySize: null,
      leverage: null,
      interestCoverage: null,
      isCovLite: null,
      averageLifeYears: null,
      recoveryRate: null,
      notes: null,
    };

    for (let i = 0; i < values.length; i++) {
      const field = fieldMap[i];
      if (!field) continue;
      const val = values[i].trim();
      if (!val) continue;

      if (NUMERIC_FIELDS.has(field)) {
        item[field] = parseNumber(val);
      } else if (field === "isCovLite") {
        item[field] = parseBoolean(val);
      } else {
        item[field] = val;
      }
    }

    if (!item.obligorName) continue;
    items.push(item as unknown as ParsedItem);
  }

  return items;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ items: [] });
  }

  const items = await getBuyListForProfile(profile.id);
  return NextResponse.json({ items });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ error: "No CLO profile found" }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File exceeds 5MB limit" }, { status: 400 });
  }

  const text = await file.text();

  let items: ParsedItem[];
  try {
    items = parseCsv(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse CSV";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (items.length === 0) {
    return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
  }

  await replaceBuyList(profile.id, items);

  return NextResponse.json({
    count: items.length,
    message: `Successfully imported ${items.length} buy list item${items.length !== 1 ? "s" : ""}`,
  });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profile = await getProfileForUser(user.id);
  if (!profile) {
    return NextResponse.json({ error: "No CLO profile found" }, { status: 404 });
  }

  await clearBuyList(profile.id);
  return NextResponse.json({ message: "Buy list cleared" });
}
