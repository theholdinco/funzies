import { auth } from "@/lib/auth";
import { notFound } from "next/navigation";
import { query } from "@/lib/db";
import Link from "next/link";

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
  }>(
    `SELECT analysis_type, borrower_name, spread_coupon, rating,
            switch_borrower_name, switch_spread_coupon, switch_rating
     FROM clo_analyses WHERE id = $1`,
    [id]
  );

  if (analyses.length === 0 || analyses[0].analysis_type !== "switch") {
    return <p style={{ padding: "2rem", color: "var(--color-text-muted)" }}>Waterfall impact is only available for switch analyses.</p>;
  }

  const a = analyses[0];

  return (
    <div style={{ padding: "1.5rem 0" }}>
      <div
        style={{
          border: "1px solid var(--color-border-light)",
          borderRadius: "var(--radius-sm)",
          padding: "1.25rem",
          background: "var(--color-surface)",
          maxWidth: "36rem",
        }}
      >
        <div style={{ fontSize: "0.72rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: "0.75rem" }}>
          Switch Summary
        </div>
        <div style={{ display: "flex", gap: "1.5rem", marginBottom: "1rem", fontSize: "0.85rem" }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: "0.15rem" }}>Sell</div>
            <div style={{ color: "var(--color-text-muted)" }}>
              {a.borrower_name ?? "Unknown"} · {a.rating ?? "—"} · {a.spread_coupon ?? "—"}
            </div>
          </div>
          <div style={{ color: "var(--color-text-muted)", alignSelf: "center", fontSize: "1.1rem" }}>→</div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: "0.15rem" }}>Buy</div>
            <div style={{ color: "var(--color-text-muted)" }}>
              {a.switch_borrower_name ?? "Unknown"} · {a.switch_rating ?? "—"} · {a.switch_spread_coupon ?? "—"}
            </div>
          </div>
        </div>
        <p style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", marginBottom: "1rem", lineHeight: 1.5 }}>
          For full waterfall impact analysis with adjustable assumptions, use the Switch Simulator on the Waterfall page.
        </p>
        <Link
          href="/clo/waterfall"
          style={{
            display: "inline-block",
            padding: "0.5rem 1rem",
            fontSize: "0.8rem",
            fontWeight: 600,
            background: "var(--color-accent)",
            color: "#fff",
            borderRadius: "var(--radius-sm)",
            textDecoration: "none",
          }}
        >
          Open Switch Simulator →
        </Link>
      </div>
    </div>
  );
}
