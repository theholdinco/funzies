import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { getPool, query } from "@/lib/db";
import { syncPpmToRelationalTables } from "@/lib/clo/extraction/persist-ppm";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { extractedConstraints } = body;

  if (!extractedConstraints) {
    return NextResponse.json({ error: "Missing extractedConstraints" }, { status: 400 });
  }

  const rows = await query<{ id: string }>(
    `UPDATE clo_profiles
     SET extracted_constraints = $1::jsonb, updated_at = now()
     WHERE user_id = $2
     RETURNING id`,
    [JSON.stringify(extractedConstraints), user.id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  // Sync to clo_deals.ppm_constraints
  try {
    await query(
      `UPDATE clo_deals SET ppm_constraints = $1::jsonb, updated_at = now()
       WHERE profile_id = $2`,
      [JSON.stringify(extractedConstraints), rows[0].id]
    );
    await syncPpmToRelationalTables(getPool(), rows[0].id, extractedConstraints);
  } catch {
    // Non-fatal — deal may not exist yet
  }

  return NextResponse.json({ profileId: rows[0].id });
}
