import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import { query } from "@/lib/db";

async function verifyAnalysisAccess(analysisId: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT a.id FROM clo_analyses a
     JOIN clo_panels p ON a.panel_id = p.id
     JOIN clo_profiles pr ON p.profile_id = pr.id
     WHERE a.id = $1 AND pr.user_id = $2`,
    [analysisId, userId]
  );
  return rows.length > 0;
}

export default async function WaterfallPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) notFound();

  const { id } = await params;
  const hasAccess = await verifyAnalysisAccess(id, session.user.id);
  if (!hasAccess) notFound();

  const analyses = await query<{
    analysis_type: string;
    borrower_name: string | null;
    spread_coupon: string | null;
    rating: string | null;
    switch_borrower_name: string | null;
    switch_spread_coupon: string | null;
    switch_rating: string | null;
    switch_maturity: string | null;
    switch_facility_size: string | null;
  }>(
    `SELECT analysis_type, borrower_name, spread_coupon, rating,
            switch_borrower_name, switch_spread_coupon, switch_rating,
            switch_maturity, switch_facility_size
     FROM clo_analyses WHERE id = $1`,
    [id]
  );

  if (analyses.length === 0 || analyses[0].analysis_type !== "switch") {
    return <p style={{ padding: "2rem", color: "var(--color-text-muted)" }}>Waterfall impact is only available for switch analyses.</p>;
  }

  const a = analyses[0];

  // Parse buy spread from "EURIBOR + 325bps" or "325" format
  const buySpreadMatch = a.switch_spread_coupon?.match(/([\d.]+)/);
  const buySpread = buySpreadMatch ? buySpreadMatch[1] : "";

  const params2 = new URLSearchParams();
  params2.set("tab", "switch");
  if (a.borrower_name) params2.set("sell", a.borrower_name);
  if (buySpread) params2.set("buySpread", buySpread);
  if (a.switch_rating) params2.set("buyRating", a.switch_rating);
  if (a.switch_maturity) params2.set("buyMaturity", a.switch_maturity);
  if (a.switch_facility_size) params2.set("buyPar", a.switch_facility_size);

  redirect(`/clo/waterfall?${params2.toString()}`);
}
