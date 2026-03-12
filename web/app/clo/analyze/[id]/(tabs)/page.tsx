import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { query } from "@/lib/db";
import { verifyAnalysisAccess } from "@/lib/clo/access";

export default async function AnalysisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const { id } = await params;

  const hasAccess = await verifyAnalysisAccess(id, session.user.id);
  if (!hasAccess) redirect("/clo");

  const rows = await query<{ status: string }>(
    "SELECT status FROM clo_analyses WHERE id = $1",
    [id]
  );

  if (rows.length === 0) {
    redirect("/clo");
  }

  if (rows[0].status === "complete") {
    redirect(`/clo/analyze/${id}/memo`);
  }

  redirect(`/clo/analyze/${id}/generating`);
}
