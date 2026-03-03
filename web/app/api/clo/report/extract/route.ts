import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { decryptApiKey } from "@/lib/crypto";
import { runSectionExtraction } from "@/lib/clo/extraction/runner";
import type { CloDocument } from "@/lib/clo/types";

export async function POST() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profiles = await query<{
    id: string;
    documents: CloDocument[];
  }>(
    "SELECT id, documents FROM clo_profiles WHERE user_id = $1",
    [user.id],
  );

  if (profiles.length === 0) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const profile = profiles[0];
  const documents = profile.documents || [];

  if (documents.length === 0) {
    return NextResponse.json({ error: "No documents uploaded" }, { status: 400 });
  }

  const userRows = await query<{ encrypted_api_key: Buffer; api_key_iv: Buffer }>(
    "SELECT encrypted_api_key, api_key_iv FROM users WHERE id = $1",
    [user.id],
  );

  if (!userRows.length || !userRows[0].encrypted_api_key) {
    return NextResponse.json({ error: "No API key configured" }, { status: 400 });
  }

  const apiKey = decryptApiKey(userRows[0].encrypted_api_key, userRows[0].api_key_iv);

  try {
    const result = await runSectionExtraction(profile.id, apiKey, documents);
    return NextResponse.json(result);
  } catch (e) {
    const message = (e as Error).message;
    if (message.includes("401") || message.includes("invalid x-api-key") || message.includes("invalid api key")) {
      return NextResponse.json(
        { error: "Your API key is invalid or expired. Please update it in Settings." },
        { status: 401 },
      );
    }
    if (message.includes("429") || message.includes("Rate")) {
      return NextResponse.json(
        { error: "Rate limited. Please wait a moment and try again." },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: "Extraction failed", details: message },
      { status: 500 },
    );
  }
}
