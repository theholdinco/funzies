"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { marked } from "marked";
import GeneratingProgress from "@/components/clo/GeneratingProgress";
import FollowUpChat from "@/components/clo/FollowUpChat";
import type { LoanIdea, PanelMember } from "@/lib/clo/types";
import Link from "next/link";

interface ScreeningSession {
  id: string;
  panel_id: string;
  focus_area: string;
  status: string;
  parsed_data: {
    ideas?: LoanIdea[];
    gapAnalysis?: string;
    raw?: string;
  };
  error_message?: string;
  created_at: string;
}

const SCREENING_PHASES = [
  { key: "gap-analysis", label: "Gap Analysis" },
  { key: "screening-debate", label: "Screening Debate" },
  { key: "screening-synthesis", label: "Screening Synthesis" },
];

const RISK_COLORS: Record<string, string> = {
  low: "var(--color-high)",
  moderate: "var(--color-medium)",
  high: "var(--color-low)",
};

function LoanIdeaCard({ idea }: { idea: LoanIdea }) {
  const [expanded, setExpanded] = useState(false);
  const riskColor = RISK_COLORS[idea.riskLevel?.toLowerCase()] || "var(--color-medium)";

  return (
    <div
      className="ic-idea-card"
      onClick={() => setExpanded(!expanded)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
    >
      <div className="ic-idea-header">
        <h3 className="ic-idea-title">{idea.title}</h3>
        <div className="ic-idea-tags">
          {idea.sector && (
            <span className="ic-eval-type-tag">{idea.sector}</span>
          )}
          {idea.loanType && (
            <span className="ic-member-tag">{idea.loanType}</span>
          )}
          {idea.expectedSpread && (
            <span className="ic-member-tag">{idea.expectedSpread}</span>
          )}
          {idea.riskLevel && (
            <span className="ic-member-tag" style={{ color: riskColor, borderColor: riskColor }}>
              {idea.riskLevel} risk
            </span>
          )}
        </div>
      </div>

      <p className="ic-idea-thesis">
        {expanded ? idea.thesis : idea.thesis?.slice(0, 120) + (idea.thesis?.length > 120 ? "..." : "")}
      </p>

      {expanded && (
        <div className="ic-idea-expanded">
          {idea.rationale && (
            <div className="ic-member-section">
              <h4>Rationale</h4>
              <p>{idea.rationale}</p>
            </div>
          )}
          {idea.keyRisks?.length > 0 && (
            <div className="ic-member-section">
              <h4>Key Risks</h4>
              <ul>
                {idea.keyRisks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {idea.implementationSteps?.length > 0 && (
            <div className="ic-member-section">
              <h4>Implementation</h4>
              <ol>
                {idea.implementationSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ScreeningSessionPage() {
  const params = useParams();
  const id = params.id as string;
  const [session, setSession] = useState<ScreeningSession | null>(null);
  const [members, setMembers] = useState<PanelMember[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSession = useCallback(() => {
    fetch(`/api/clo/screenings/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then((data) => {
        setSession(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (members.length > 0) return;
    fetch("/api/clo/panel")
      .then((r) => r.json())
      .then((panel) => {
        if (panel.members) setMembers(panel.members);
      })
      .catch(() => {});
  }, [members.length]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  if (loading) {
    return (
      <div className="ic-dashboard">
        <p style={{ color: "var(--color-text-muted)" }}>Loading...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="ic-dashboard">
        <div className="ic-empty-state">
          <h1>Not Found</h1>
          <p>This screening session could not be found.</p>
          <Link href="/clo/screenings" className="btn-primary">
            Back to Screenings
          </Link>
        </div>
      </div>
    );
  }

  const isGenerating = session.status === "queued" || session.status === "running";

  if (isGenerating) {
    return (
      <div className="ic-dashboard">
        <Link href="/clo/screenings" className="standalone-back">
          &larr; Back to Screenings
        </Link>
        <div className="standalone-header" style={{ textAlign: "left" }}>
          <h1>Portfolio Screening</h1>
          <p>
            {session.focus_area
              ? `Focus: ${session.focus_area}`
              : "Your panel is screening for loan opportunities."}
          </p>
        </div>
        <GeneratingProgress
          streamUrl={`/api/clo/screenings/${id}/stream`}
          phases={SCREENING_PHASES}
          onComplete={fetchSession}
          onError={fetchSession}
        />
      </div>
    );
  }

  if (session.status === "error") {
    return (
      <div className="ic-dashboard">
        <Link href="/clo/screenings" className="standalone-back">
          &larr; Back to Screenings
        </Link>
        <div className="ic-empty-state">
          <h1>Screening Error</h1>
          <p>{session.error_message || "An error occurred during screening."}</p>
          <Link href="/clo/screenings" className="btn-primary">
            Try Again
          </Link>
        </div>
      </div>
    );
  }

  const parsedData = session.parsed_data || {};
  const ideas = parsedData.ideas || [];
  const gapAnalysis = parsedData.gapAnalysis || "";

  return (
    <div className="ic-dashboard">
      <Link href="/clo/screenings" className="standalone-back">
        &larr; Back to Screenings
      </Link>

      <header className="ic-dashboard-header">
        <div>
          <h1>{session.focus_area || "Portfolio Screening"}</h1>
          <p>
            {ideas.length} idea{ideas.length !== 1 ? "s" : ""} identified &middot;{" "}
            {new Date(session.created_at).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
      </header>

      {gapAnalysis && (
        <section className="ic-section">
          <h2>Portfolio Gap Analysis</h2>
          <div
            className="ic-gap-analysis markdown-content"
            dangerouslySetInnerHTML={{
              __html: marked.parse(gapAnalysis, { async: false }) as string,
            }}
          />
        </section>
      )}

      {ideas.length > 0 && (
        <section className="ic-section">
          <h2>Loan Opportunities</h2>
          <div className="ic-idea-grid">
            {ideas.map((idea, i) => (
              <LoanIdeaCard key={i} idea={idea} />
            ))}
          </div>
        </section>
      )}

      {members.length > 0 && (
        <section className="ic-section">
          <FollowUpChat
            apiUrl={`/api/clo/screenings/${id}/follow-ups`}
            members={members}
            title="Follow Up"
            placeholders={{
              analyst: "Ask about these screening results...",
              "ask-panel": "Ask the panel about these opportunities...",
              debate: "What should the panel debate about this screening?",
            }}
          />
        </section>
      )}
    </div>
  );
}
