import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { query } from "@/lib/db";
import { verifyAnalysisAccess } from "@/lib/clo/access";
import type { ParsedAnalysis, PanelMember, CreditVerdict } from "@/lib/clo/types";

const VERDICT_COLORS: Record<string, { color: string; bg: string }> = {
  strong_buy: { color: "#1a5c36", bg: "#d4edda" },
  buy: { color: "var(--color-high)", bg: "var(--color-high-bg)" },
  hold: { color: "var(--color-medium)", bg: "var(--color-medium-bg)" },
  pass: { color: "#c53030", bg: "#fee2e2" },
  strong_pass: { color: "#7f1d1d", bg: "#fecaca" },
};

function CreditVerdictBadge({ verdict }: { verdict: CreditVerdict }) {
  const config = VERDICT_COLORS[verdict] || VERDICT_COLORS.hold;
  const label = VOTE_LABELS[verdict] || verdict;
  return (
    <div
      className="ic-verdict-badge"
      style={{ color: config.color, background: config.bg, border: `1px solid ${config.color}` }}
    >
      {label}
    </div>
  );
}

const VOTE_LABELS: Record<string, string> = {
  strong_buy: "Strong Buy",
  buy: "Buy",
  hold: "Hold",
  pass: "Pass",
  strong_pass: "Strong Pass",
};

export default async function RecommendationPage({
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

  const rec = rows[0].parsed_data?.recommendation;
  if (!rec) {
    return <p style={{ color: "var(--color-text-muted)" }}>Recommendation not yet available.</p>;
  }

  const panels = await query<{ members: PanelMember[] }>(
    "SELECT members FROM clo_panels WHERE id = $1",
    [rows[0].panel_id]
  );
  const standingMembers = (panels[0]?.members || []) as PanelMember[];
  const dynamicSpecialists = (rows[0].dynamic_specialists || []) as PanelMember[];
  const members = [...standingMembers, ...dynamicSpecialists];
  const avatarMap = new Map(members.map((m) => [m.name, m.avatarUrl]));

  return (
    <div className="ic-recommendation">
      <div style={{ textAlign: "center", marginBottom: "2rem" }}>
        <CreditVerdictBadge verdict={rec.verdict} />
      </div>

      {rec.votes?.length > 0 && (
        <div>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem", marginBottom: "1rem" }}>
            Vote Tally
          </h3>
          <div className="ic-vote-grid">
            {rec.votes.map((vote, i) => {
              const avatar = avatarMap.get(vote.memberName);
              return (
                <div key={i} className="ic-vote-card">
                  <div className="ic-vote-header">
                    {avatar ? (
                      <img src={avatar} alt={vote.memberName} className="ic-vote-avatar" />
                    ) : (
                      <div className="ic-member-avatar-placeholder" style={{ width: 28, height: 28, fontSize: "0.7rem" }}>
                        {vote.memberName.charAt(0)}
                      </div>
                    )}
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{vote.memberName}</div>
                      <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                        {VOTE_LABELS[vote.vote] || vote.vote}
                        {vote.conviction && ` (${vote.conviction})`}
                      </div>
                    </div>
                  </div>
                  <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                    {vote.rationale}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {rec.dissents?.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem", marginBottom: "0.75rem" }}>
            Dissents
          </h3>
          {rec.dissents.map((d, i) => (
            <p key={i} style={{ fontSize: "0.9rem", color: "var(--color-text-secondary)", lineHeight: 1.6, marginBottom: "0.5rem" }}>
              {d}
            </p>
          ))}
        </div>
      )}

      {rec.conditions?.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem", marginBottom: "0.75rem" }}>
            Conditions for Investment
          </h3>
          <ul style={{ paddingLeft: "1.25rem" }}>
            {rec.conditions.map((c, i) => (
              <li key={i} style={{ fontSize: "0.9rem", lineHeight: 1.6, marginBottom: "0.4rem", color: "var(--color-text-secondary)" }}>
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
