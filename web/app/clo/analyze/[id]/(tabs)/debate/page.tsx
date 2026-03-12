import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { query } from "@/lib/db";
import { verifyAnalysisAccess } from "@/lib/clo/access";
import type { ParsedAnalysis, PanelMember } from "@/lib/clo/types";
import DebateViewer from "@/components/ic/DebateViewer";

export default async function DebatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) notFound();

  const { id } = await params;

  const hasAccess = await verifyAnalysisAccess(id, session.user.id);
  if (!hasAccess) notFound();

  const rows = await query<{
    parsed_data: ParsedAnalysis | null;
    panel_id: string;
    dynamic_specialists: PanelMember[] | null;
  }>(
    "SELECT parsed_data, panel_id, dynamic_specialists FROM clo_analyses WHERE id = $1",
    [id]
  );

  if (rows.length === 0) {
    notFound();
  }

  const debate = rows[0].parsed_data?.debate;
  if (!debate?.length) {
    return <p style={{ color: "var(--color-text-muted)" }}>Debate not yet available.</p>;
  }

  const panels = await query<{ members: PanelMember[] }>(
    "SELECT members FROM clo_panels WHERE id = $1",
    [rows[0].panel_id]
  );
  const standingMembers = (panels[0]?.members || []) as PanelMember[];
  const dynamicSpecialists = (rows[0].dynamic_specialists || []) as PanelMember[];
  const members = [...standingMembers, ...dynamicSpecialists];

  return <DebateViewer rounds={debate} members={members} />;
}
