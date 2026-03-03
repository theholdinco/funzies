import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";

export async function POST() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profiles = await query<{ id: string }>(
    "SELECT id FROM clo_profiles WHERE user_id = $1",
    [user.id],
  );

  if (profiles.length === 0) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const userRows = await query<{ encrypted_api_key: Buffer }>(
    "SELECT encrypted_api_key FROM users WHERE id = $1",
    [user.id],
  );

  if (!userRows.length || !userRows[0].encrypted_api_key) {
    return NextResponse.json({ error: "No API key configured" }, { status: 400 });
  }

  await query(
    `UPDATE clo_profiles
     SET report_extraction_status = 'queued',
         report_extraction_error = NULL,
         updated_at = now()
     WHERE id = $1`,
    [profiles[0].id],
  );

  return NextResponse.json({ status: "queued", profileId: profiles[0].id });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profiles = await query<{
    id: string;
    report_extraction_status: string | null;
    report_extraction_error: string | null;
    report_extraction_progress: { step: string; detail: string } | null;
  }>(
    "SELECT id, report_extraction_status, report_extraction_error, report_extraction_progress FROM clo_profiles WHERE user_id = $1",
    [user.id],
  );

  if (profiles.length === 0) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const { report_extraction_status, report_extraction_error, report_extraction_progress } = profiles[0];

  return NextResponse.json({
    status: report_extraction_status,
    error: report_extraction_error,
    progress: report_extraction_progress,
  });
}
