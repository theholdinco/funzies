import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-helpers";
import { query } from "@/lib/db";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sidebar = request.nextUrl.searchParams.get("sidebar") === "true";

  if (sidebar) {
    const assemblies = await query(
      `SELECT * FROM (
        SELECT a.id, a.slug, a.topic_input, a.status, a.created_at
        FROM assemblies a WHERE a.user_id = $1
        UNION
        SELECT a.id, a.slug, a.topic_input, a.status, a.created_at
        FROM assembly_shares s JOIN assemblies a ON s.assembly_id = a.id
        WHERE s.user_id = $1
      ) sub ORDER BY created_at DESC LIMIT 20`,
      [user.id]
    );
    return NextResponse.json(assemblies);
  }

  const assemblies = await query(
    `SELECT id, slug, topic_input, status, current_phase, created_at, completed_at
     FROM assemblies WHERE user_id = $1 ORDER BY created_at DESC`,
    [user.id]
  );

  return NextResponse.json(assemblies);
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const topicInput = body.topicInput?.trim();

  if (!topicInput) {
    return NextResponse.json({ error: "Topic is required" }, { status: 400 });
  }

  const slug = generateSlug(topicInput);
  const githubRepoOwner = body.githubRepoOwner || null;
  const githubRepoName = body.githubRepoName || null;
  const githubRepoBranch = body.githubRepoBranch || "main";
  const initialStatus = body.hasFiles ? "uploading" : "queued";

  const rows = await query<{ id: string; slug: string }>(
    `INSERT INTO assemblies (id, user_id, slug, topic_input, status, github_repo_owner, github_repo_name, github_repo_branch)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
     RETURNING id, slug`,
    [user.id, slug, topicInput, initialStatus, githubRepoOwner, githubRepoName, githubRepoBranch]
  );

  return NextResponse.json(rows[0], { status: 201 });
}

function generateSlug(topic: string): string {
  const base = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "");
  const suffix = Date.now().toString(36).slice(-4);
  return `${base}-${suffix}`;
}
