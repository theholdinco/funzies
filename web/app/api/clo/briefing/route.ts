import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { decryptApiKey } from "@/lib/crypto";
import { getUserBriefingDigest } from "@/lib/briefing";

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userRows = await query<{ encrypted_api_key: Buffer; api_key_iv: Buffer }>(
      "SELECT encrypted_api_key, api_key_iv FROM users WHERE id = $1",
      [user.id]
    );
    if (!userRows.length || !userRows[0].encrypted_api_key) {
      return NextResponse.json(null);
    }

    const apiKey = decryptApiKey(userRows[0].encrypted_api_key, userRows[0].api_key_iv);

    // Build CLO profile context
    const profiles = await query<{
      fund_strategy: string;
      target_sectors: string;
      risk_appetite: string;
      portfolio_description: string;
      concentration_limits: string;
      extracted_portfolio: { concentrations?: { bySector?: { category: string; percentage: number }[] } } | null;
    }>(
      "SELECT fund_strategy, target_sectors, risk_appetite, portfolio_description, concentration_limits, extracted_portfolio FROM clo_profiles WHERE user_id = $1",
      [user.id]
    );
    if (!profiles.length) return NextResponse.json(null);

    const p = profiles[0];

    const sectorConcentrations = p.extracted_portfolio?.concentrations?.bySector
      ?.map((s) => `${s.category} (${s.percentage.toFixed(1)}%)`)
      .join(", ");

    const profileContext = [
      `Fund strategy: ${p.fund_strategy || "N/A"}`,
      `Target sectors: ${p.target_sectors || "N/A"}`,
      `Risk appetite: ${p.risk_appetite || "N/A"}`,
      `Portfolio description: ${p.portfolio_description || "N/A"}`,
      `Concentration limits: ${p.concentration_limits || "N/A"}`,
      sectorConcentrations ? `Sector concentrations: ${sectorConcentrations}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await getUserBriefingDigest(user.id, "clo", apiKey, profileContext);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[clo/briefing] Error generating briefing:", err);
    return NextResponse.json(null);
  }
}
