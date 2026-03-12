import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { query } from "@/lib/db";
import { verifyAnalysisAccess } from "@/lib/clo/access";
import type { ParsedAnalysis } from "@/lib/clo/types";
import MemoViewer from "@/components/ic/MemoViewer";

export default async function MemoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) notFound();

  const { id } = await params;

  const hasAccess = await verifyAnalysisAccess(id, session.user.id);
  if (!hasAccess) notFound();

  const rows = await query<{ parsed_data: ParsedAnalysis | null }>(
    "SELECT parsed_data FROM clo_analyses WHERE id = $1",
    [id]
  );

  if (rows.length === 0) {
    notFound();
  }

  const memo = rows[0].parsed_data?.memo;
  if (!memo) {
    return <p style={{ color: "var(--color-text-muted)" }}>Memo not yet available.</p>;
  }

  return <MemoViewer memo={memo} />;
}
