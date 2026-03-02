"use client";

import Link from "next/link";
import type { PanelMember } from "@/lib/clo/types";

interface PanelMemberCardProps {
  member: PanelMember;
}

const RISK_COLORS: Record<string, string> = {
  conservative: "var(--color-high)",
  moderate: "var(--color-medium)",
  aggressive: "var(--color-low)",
};

export default function PanelMemberCard({ member }: PanelMemberCardProps) {
  const riskColor = RISK_COLORS[member.riskPersonality?.toLowerCase()] || "var(--color-medium)";

  return (
    <Link
      href={`/clo/panel/${member.number}`}
      className="ic-member-detail-card"
      style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}
    >
      <div className="ic-member-detail-header">
        {member.avatarUrl ? (
          <img
            src={member.avatarUrl}
            alt={member.name}
            className="ic-member-avatar"
          />
        ) : (
          <div className="ic-member-avatar-placeholder">
            {member.name.charAt(0)}
          </div>
        )}
        <div className="ic-member-detail-info">
          <div className="ic-member-detail-name">{member.name}</div>
          <div className="ic-member-detail-role">{member.role}</div>
        </div>
        <span
          className="ic-risk-dot"
          style={{ background: riskColor }}
          title={`Risk: ${member.riskPersonality}`}
        />
      </div>

      {member.background && (
        <p className="ic-member-detail-bio">
          {member.background.slice(0, 100) + (member.background.length > 100 ? "..." : "")}
        </p>
      )}

      {member.specializations?.length > 0 && (
        <div className="ic-member-tags">
          {member.specializations.map((s) => (
            <span key={s} className="ic-member-tag">{s}</span>
          ))}
        </div>
      )}
    </Link>
  );
}
