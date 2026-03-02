"use client";

import Link from "next/link";
import { marked } from "marked";
import type { PanelMember } from "@/lib/clo/types";
import CloFollowUpModal from "@/components/clo/FollowUpModal";

interface AnalysisHistoryEntry {
  analysisId: string;
  title: string;
  type: "assessment" | "debate";
  excerpt: string;
}

interface MemberProfileClientProps {
  member: PanelMember;
  members: PanelMember[];
  panelId: string;
  analysisOptions: { id: string; title: string; borrowerName: string }[];
  analysisHistory: AnalysisHistoryEntry[];
  prev: PanelMember | null;
  next: PanelMember | null;
}

function md(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

function riskColor(personality: string): string {
  const lower = personality.toLowerCase();
  if (lower.includes("conservative")) return "var(--color-high)";
  if (lower.includes("aggressive")) return "var(--color-low)";
  return "var(--color-medium)";
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function MemberProfileClient({
  member,
  members,
  panelId,
  analysisOptions,
  analysisHistory,
  prev,
  next,
}: MemberProfileClientProps) {
  const color = riskColor(member.riskPersonality);

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">Home</Link>
        <span className="separator">/</span>
        <Link href="/clo">CLO</Link>
        <span className="separator">/</span>
        <Link href="/clo/panel">Panel</Link>
        <span className="separator">/</span>
        <span className="current">{member.name}</span>
      </div>

      <div className="profile-header">
        {member.avatarUrl ? (
          <img
            src={member.avatarUrl}
            alt={member.name}
            className="profile-avatar"
          />
        ) : (
          <div className="profile-avatar" style={{ background: color }}>
            {initials(member.name)}
          </div>
        )}
        <div>
          <h1 style={{ marginBottom: "0.15rem" }}>{member.name}</h1>
          <div className="profile-meta">
            <span className="badge badge-tag">{member.role}</span>
            <span
              className="ic-risk-dot"
              style={{ background: color }}
            />
            <span
              style={{
                color: "var(--color-text-secondary)",
                fontSize: "0.88rem",
              }}
            >
              {member.riskPersonality}
            </span>
          </div>
        </div>
      </div>

      {member.background && (
        <>
          <h2>Background</h2>
          <div
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: md(member.background) }}
          />
        </>
      )}

      {member.investmentPhilosophy && (
        <>
          <h2>Investment Philosophy</h2>
          <div
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: md(member.investmentPhilosophy) }}
          />
        </>
      )}

      {member.specializations.length > 0 && (
        <>
          <h2>Specializations</h2>
          <div className="ic-member-tags">
            {member.specializations.map((s, i) => (
              <span key={i} className="ic-member-tag">
                {s}
              </span>
            ))}
          </div>
        </>
      )}

      {member.decisionStyle && (
        <>
          <h2>Decision Style</h2>
          <div
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: md(member.decisionStyle) }}
          />
        </>
      )}

      {member.notablePositions.length > 0 && (
        <>
          <h2>Notable Positions</h2>
          <ol>
            {member.notablePositions.map((p, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: md(p) }} />
            ))}
          </ol>
        </>
      )}

      {member.blindSpots.length > 0 && (
        <>
          <h2>Blind Spots</h2>
          <ul>
            {member.blindSpots.map((b, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: md(b) }} />
            ))}
          </ul>
        </>
      )}

      {member.fullProfile && (
        <>
          <h2>Full Profile</h2>
          <div
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: md(member.fullProfile.replace(/^##?\s+.*?\n+/, "")) }}
          />
        </>
      )}

      {analysisHistory.length > 0 && (
        <>
          <h2>Analysis History</h2>
          <p
            style={{
              color: "var(--color-text-secondary)",
              fontSize: "0.85rem",
              marginBottom: "1rem",
            }}
          >
            {analysisHistory.length} contribution{analysisHistory.length !== 1 ? "s" : ""} across analyses
          </p>
          {analysisHistory.map((entry, i) => (
            <details key={i}>
              <summary>
                {entry.title}{" "}
                <span className="badge badge-tag">{entry.type}</span>
              </summary>
              <div className="details-content">
                <p>{entry.excerpt}</p>
                <Link
                  href={`/clo/analyze/${entry.analysisId}/${entry.type === "debate" ? "debate" : "memo"}`}
                  style={{ fontSize: "0.82rem" }}
                >
                  View in context &rarr;
                </Link>
              </div>
            </details>
          ))}
        </>
      )}

      <CloFollowUpModal
        panelId={panelId}
        members={members}
        defaultMember={member.name}
        pageType="member"
        analyses={analysisOptions}
      />

      <hr />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "0.85rem",
        }}
      >
        {prev ? (
          <Link href={`/clo/panel/${prev.number}`}>
            &larr; {prev.name}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/clo/panel/${next.number}`}>
            {next.name} &rarr;
          </Link>
        ) : (
          <span />
        )}
      </div>
    </>
  );
}
