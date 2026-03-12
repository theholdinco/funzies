import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { query } from "@/lib/db";
import { verifyAnalysisAccess } from "@/lib/clo/access";
import type { PanelMember } from "@/lib/clo/types";
import FollowUpChat from "@/components/clo/FollowUpChat";

export default async function FollowUpsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) notFound();

  const { id } = await params;

  const hasAccess = await verifyAnalysisAccess(id, session.user.id);
  if (!hasAccess) notFound();

  const rows = await query<{ panel_id: string; dynamic_specialists: PanelMember[] }>(
    "SELECT panel_id, dynamic_specialists FROM clo_analyses WHERE id = $1",
    [id]
  );

  if (rows.length === 0) {
    notFound();
  }

  const panels = await query<{ members: PanelMember[] }>(
    "SELECT members FROM clo_panels WHERE id = $1",
    [rows[0].panel_id]
  );
  const standingMembers = (panels[0]?.members || []) as PanelMember[];
  const dynamicSpecialists = (rows[0].dynamic_specialists || []) as PanelMember[];
  const members = [...standingMembers, ...dynamicSpecialists];

  return <FollowUpChat apiUrl={`/api/clo/analyses/${id}/follow-ups`} members={members} />;
}
