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

    // Build IC profile context
    const profiles = await query<{
      investment_philosophy: string;
      risk_tolerance: string;
      asset_classes: string[];
      geographic_preferences: string;
      current_portfolio: string;
    }>(
      "SELECT investment_philosophy, risk_tolerance, asset_classes, geographic_preferences, current_portfolio FROM investor_profiles WHERE user_id = $1",
      [user.id]
    );
    if (!profiles.length) return NextResponse.json(null);

    const p = profiles[0];

    // Get active evaluation titles
    const evals = await query<{ title: string }>(
      `SELECT e.title FROM ic_evaluations e
       JOIN ic_committees c ON e.committee_id = c.id
       JOIN investor_profiles ip ON c.profile_id = ip.id
       WHERE ip.user_id = $1 AND e.status IN ('running', 'complete')
       ORDER BY e.created_at DESC LIMIT 10`,
      [user.id]
    );

    const evalTitles = evals.map((e) => e.title).join(", ");

    const profileContext = [
      `Investment philosophy: ${p.investment_philosophy || "N/A"}`,
      `Risk tolerance: ${p.risk_tolerance || "N/A"}`,
      `Asset classes: ${Array.isArray(p.asset_classes) ? p.asset_classes.join(", ") : "N/A"}`,
      `Geographic preferences: ${p.geographic_preferences || "N/A"}`,
      `Current portfolio: ${p.current_portfolio || "N/A"}`,
      evalTitles ? `Active evaluations: ${evalTitles}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await getUserBriefingDigest(user.id, "ic", apiKey, profileContext);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[ic/briefing] Error generating briefing:", err);
    return NextResponse.json(null);
  }
}
