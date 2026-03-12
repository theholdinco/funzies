import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { query } from "@/lib/db";
import { verifyAnalysisAccess } from "@/lib/clo/access";
import type { ParsedAnalysis, CreditRiskAssessment } from "@/lib/clo/types";

const RISK_COLORS: Record<string, { color: string; bg: string }> = {
  low: { color: "var(--color-high)", bg: "var(--color-high-bg)" },
  moderate: { color: "var(--color-medium)", bg: "var(--color-medium-bg)" },
  high: { color: "var(--color-low)", bg: "var(--color-low-bg)" },
  "very-high": { color: "#7f1d1d", bg: "#fecaca" },
};

function RiskBadge({ level }: { level: string }) {
  const config = RISK_COLORS[level] || RISK_COLORS.moderate;
  return (
    <span
      className="ic-verdict-badge"
      style={{
        color: config.color,
        background: config.bg,
        border: `1px solid ${config.color}`,
        fontSize: "0.9rem",
      }}
    >
      {level.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase())} Risk
    </span>
  );
}

function RiskView({ risk }: { risk: CreditRiskAssessment }) {
  return (
    <div className="ic-risk">
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "2rem" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: "1.3rem", margin: 0 }}>
          Risk Assessment
        </h2>
        <RiskBadge level={risk.overallRisk} />
      </div>

      {risk.categories?.length > 0 && (
        <div className="ic-risk-categories">
          {risk.categories.map((cat, i) => {
            const config = RISK_COLORS[cat.level?.toLowerCase()] || RISK_COLORS.moderate;
            return (
              <div key={i} className="ic-risk-category">
                <div className="ic-risk-category-header">
                  <span className="ic-risk-category-name">{cat.name}</span>
                  <span
                    className="ic-member-tag"
                    style={{ color: config.color, borderColor: config.color }}
                  >
                    {cat.level}
                  </span>
                </div>
                <p className="ic-risk-category-analysis">{cat.analysis}</p>
              </div>
            );
          })}
        </div>
      )}

      {risk.mitigants?.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem", marginBottom: "0.75rem" }}>
            Mitigants
          </h3>
          <ul style={{ paddingLeft: "1.25rem" }}>
            {risk.mitigants.map((m, i) => (
              <li key={i} style={{ fontSize: "0.9rem", lineHeight: 1.6, marginBottom: "0.4rem", color: "var(--color-text-secondary)" }}>
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default async function RiskPage({
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

  const risk = rows[0].parsed_data?.riskAssessment;
  if (!risk) {
    return <p style={{ color: "var(--color-text-muted)" }}>Risk assessment not yet available.</p>;
  }

  return <RiskView risk={risk} />;
}
