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
    return NextResponse.json({ error: "No profile found" }, { status: 404 });
  }

  const profileId = profiles[0].id;

  // Delete deal and all cascading data (report periods, holdings, tests, etc.)
  await query("DELETE FROM clo_deals WHERE profile_id = $1", [profileId]);

  // Reset profile to clean state
  await query(
    `UPDATE clo_profiles
     SET documents = '[]'::jsonb,
         extracted_constraints = '{}'::jsonb,
         extracted_portfolio = NULL,
         ppm_extraction_status = NULL,
         ppm_extracted_at = NULL,
         ppm_raw_extraction = NULL,
         updated_at = now()
     WHERE id = $1`,
    [profileId],
  );

  return NextResponse.json({ ok: true });
}
