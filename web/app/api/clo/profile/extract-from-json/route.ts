import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";
import { ingestPpmJson, ingestComplianceJson } from "@/lib/clo/extraction/json-ingest/ingest";
import type { PpmJson, ComplianceJson } from "@/lib/clo/extraction/json-ingest/types";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const profiles = await query<{ id: string }>(
    `SELECT id FROM clo_profiles WHERE user_id = $1`,
    [user.id],
  );
  if (profiles.length === 0) return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  const profileId = profiles[0].id;

  let body: { ppm?: PpmJson; compliance?: ComplianceJson };
  try {
    body = (await req.json()) as { ppm?: PpmJson; compliance?: ComplianceJson };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.ppm && !body.compliance) {
    return NextResponse.json({ error: "Provide ppm and/or compliance" }, { status: 400 });
  }

  const result: Record<string, unknown> = {};

  if (body.ppm) {
    const r = await ingestPpmJson(profileId, body.ppm);
    if (!r.ok) return NextResponse.json({ error: "PPM validation failed", details: r.errors }, { status: 422 });
    result.ppm = r;
  }

  if (body.compliance) {
    const r = await ingestComplianceJson(profileId, body.compliance);
    if (!r.ok) return NextResponse.json({ error: "Compliance validation failed", details: r.errors }, { status: 422 });
    result.compliance = r;
  }

  return NextResponse.json({ status: "ok", ...result });
}
