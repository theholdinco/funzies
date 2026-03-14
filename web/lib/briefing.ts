import { query } from "@/lib/db";

export async function fetchAndStoreBriefings(): Promise<{ fetched: string[]; skipped: string[]; errors: string[] }> {
  const briefApiKey = process.env.BRIEF_API_KEY;
  if (!briefApiKey) {
    return { fetched: [], skipped: [], errors: ["BRIEF_API_KEY not configured"] };
  }

  const fetched: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const briefType of ["general", "clo"] as const) {
    const existing = await query<{ id: string }>(
      "SELECT id FROM daily_briefings WHERE brief_type = $1 AND fetched_at > now() - interval '1 hour' LIMIT 1",
      [briefType]
    );
    if (existing.length > 0) {
      skipped.push(briefType);
      continue;
    }

    const res = await fetch(`http://89.167.78.232:3000/briefing/${briefType}?id=-1`, {
      headers: { Authorization: `Bearer ${briefApiKey}` },
    });
    if (!res.ok) {
      errors.push(`${briefType}: HTTP ${res.status}`);
      continue;
    }
    const content = await res.text();
    if (!content.trim()) {
      errors.push(`${briefType}: empty response`);
      continue;
    }

    await query(
      "INSERT INTO daily_briefings (brief_type, content) VALUES ($1, $2)",
      [briefType, content]
    );
    fetched.push(briefType);
  }

  return { fetched, skipped, errors };
}

export async function getLatestBriefing(
  briefType = "general"
): Promise<string | null> {
  const rows = await query<{ content: string }>(
    "SELECT content FROM daily_briefings WHERE brief_type = $1 ORDER BY fetched_at DESC LIMIT 1",
    [briefType]
  );
  return rows[0]?.content ?? null;
}

export async function getUserBriefingDigest(
  userId: string,
  product: "ic" | "clo",
  apiKey: string,
  profileContext: string
): Promise<{ relevant: boolean; digest_md: string | null } | null> {
  const briefings = await query<{ id: string; content: string }>(
    "SELECT id, content FROM daily_briefings WHERE brief_type = 'general' ORDER BY fetched_at DESC LIMIT 1"
  );
  if (briefings.length === 0) return null;

  const briefing = briefings[0];

  // Check cache
  const cached = await query<{ relevant: boolean; digest_md: string | null }>(
    "SELECT relevant, digest_md FROM user_briefing_digests WHERE user_id = $1 AND briefing_id = $2 AND product = $3",
    [userId, briefing.id, product]
  );
  if (cached.length > 0) return cached[0];

  // Merge product-specific briefing if available
  let combinedContent = briefing.content;
  if (product === "clo") {
    const cloBriefings = await query<{ content: string }>(
      "SELECT content FROM daily_briefings WHERE brief_type = 'clo' ORDER BY fetched_at DESC LIMIT 1"
    );
    if (cloBriefings.length > 0) {
      combinedContent += "\n\nCLO-SPECIFIC BRIEFING:\n" + cloBriefings[0].content;
    }
  }

  // Generate digest via Claude Haiku
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are a market intelligence filter for CLO portfolio managers. Given a daily briefing and a user's profile, determine which items are relevant to this specific portfolio/profile.

CRITICAL CLO KNOWLEDGE (apply when summarizing CLO market items):
- AUDIENCE: The user is a CLO portfolio manager who buys and manages leveraged loans inside CLO vehicles. Do NOT recommend buying/selling CLO tranches or CLO equity on the secondary market — that is not what a CLO PM does.
- SPREAD = MARGIN: Spread (bps) is the margin above the reference rate (SOFR, EURIBOR). It is independent of where the base rate sits. Higher SOFR does NOT reduce spreads — it raises the all-in coupon but the margin is unchanged. When comparing loans, always consider both price and spread together: a loan trading below par has a higher effective margin than its stated spread.
- The CLO equity arb = asset spread (loan WAS) minus liability cost (tranche spreads). Tight liabilities (low AAA spreads) HELP the arb by reducing funding costs — do NOT describe tight liabilities as negative.
- Widening liabilities hurt the arb; declining loan WAS hurts the arb. Only describe "compressed from both sides" when BOTH asset spreads fall AND liability spreads widen.
- Credit deterioration (defaults, downgrades, sector distress) WIDENS collateral spreads — do NOT call this "spread compression." Spread compression means loans reprice tighter, which happens in strong markets, not distress.
- Equity distribution cuts can stem from credit losses, OC test diversions, lower reinvestment margins, or arb compression — distinguish the actual cause.
- Existing CLO equity benefits from locked-in liability costs from original pricing — current new-issue spreads are irrelevant to existing deal economics.

BRIEFING:
${combinedContent}

USER PROFILE:
${profileContext}

Respond with JSON only: { "relevant": boolean, "digest": "markdown string or null" }
- If nothing in the briefing is relevant to this specific user's portfolio/profile, set relevant=false and digest=null.
- If there are relevant items, set relevant=true and write a concise digest (3-8 bullet points) highlighting ONLY the items that matter to this user and why.
- Be specific about why each item matters to their particular holdings, sectors, or strategy.
- If the source briefing contains factually incorrect CLO analysis (e.g., claiming tight liabilities hurt the arb), correct it in your digest.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    console.error("[briefing] Digest generation failed:", response.status);
    return null;
  }

  const data = await response.json();
  const text =
    data.content?.[0]?.type === "text" ? data.content[0].text : "";

  let relevant = false;
  let digestMd: string | null = null;

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      relevant = !!parsed.relevant;
      digestMd = parsed.digest || null;
    }
  } catch {
    // If parsing fails, treat as not relevant
  }

  // Cache result
  await query(
    `INSERT INTO user_briefing_digests (user_id, briefing_id, product, relevant, digest_md)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, briefing_id, product) DO NOTHING`,
    [userId, briefing.id, product, relevant, digestMd]
  );

  return { relevant, digest_md: digestMd };
}
