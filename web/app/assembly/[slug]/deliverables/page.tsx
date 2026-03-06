"use client";

import { useState } from "react";
import Link from "next/link";
import { marked } from "marked";
import { useAssembly, useAssemblyId } from "@/lib/assembly-context";
import FollowUpModal from "@/components/FollowUpModal";
import HighlightChat from "@/components/HighlightChat";
import { buildCharacterMaps, isSocrate } from "@/lib/character-utils";

function md(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

export default function DeliverablesPage() {
  const topic = useAssembly();
  const assemblyId = useAssemblyId();
  const base = `/assembly/${topic.slug}`;
  const { avatarUrlMap } = buildCharacterMaps(topic.characters);
  const [activeVersion, setActiveVersion] = useState(topic.deliverables.length - 1);
  const [showProvenance, setShowProvenance] = useState(false);
  const hasVerification = topic.verification.length > 0;
  const hasReferences = !!topic.referenceLibrary;

  if (topic.deliverables.length === 0) {
    return <p>No deliverables available.</p>;
  }

  const hasMultipleVersions = topic.deliverables.length > 1;
  const activeDeliverable = topic.deliverables[activeVersion];

  return (
    <>
      <div className="breadcrumb">
        <Link href="/">Home</Link>
        <span className="separator">/</span>
        <Link href={base}>
          {topic.title.length > 30
            ? topic.title.slice(0, 29) + "\u2026"
            : topic.title}
        </Link>
        <span className="separator">/</span>
        <span className="current">Deliverables</span>
        {(hasVerification || hasReferences) && (
          <button
            onClick={() => setShowProvenance((v) => !v)}
            className={`provenance-toggle${showProvenance ? " active" : ""}`}
            style={{ marginLeft: "auto" }}
          >
            {showProvenance ? "Hide" : "Show"} Sources &amp; Verification
          </button>
        )}
      </div>

      <h1>Deliverables</h1>
      <p className="page-subtitle">
        {hasMultipleVersions
          ? `${topic.deliverables.length} versions`
          : "1 output document"}
      </p>

      {hasMultipleVersions && (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginBottom: "1.5rem",
            flexWrap: "wrap",
          }}
        >
          {topic.deliverables.map((d, i) => {
            const version = d.version || i + 1;
            const label = version === 1
              ? "v1 — Original"
              : `v${version}${d.createdAt ? ` — ${new Date(d.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`;

            return (
              <button
                key={d.slug}
                onClick={() => setActiveVersion(i)}
                style={{
                  padding: "0.4rem 0.9rem",
                  border: i === activeVersion
                    ? "2px solid var(--color-accent)"
                    : "1px solid var(--color-border)",
                  borderRadius: "6px",
                  background: i === activeVersion
                    ? "var(--color-accent)"
                    : "var(--color-surface)",
                  color: i === activeVersion ? "#fff" : "var(--color-text)",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                  fontWeight: i === activeVersion ? 600 : 400,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {showProvenance && (
        <div className="provenance-panel">
          {hasVerification && (
            <details open>
              <summary className="provenance-section-header">
                Verification Notes
              </summary>
              {topic.verification.map((v, i) => (
                <div
                  key={i}
                  className="provenance-content markdown-content"
                  dangerouslySetInnerHTML={{ __html: md(v.content) }}
                />
              ))}
            </details>
          )}
          {hasReferences && (
            <details>
              <summary className="provenance-section-header">
                Reference Library
              </summary>
              <div
                className="provenance-content markdown-content"
                dangerouslySetInnerHTML={{
                  __html: md(topic.referenceLibrary!),
                }}
              />
            </details>
          )}
        </div>
      )}

      {activeDeliverable && (
        <div id={activeDeliverable.slug}>
          <div
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: md(activeDeliverable.content) }}
          />
        </div>
      )}

      <FollowUpModal
        assemblyId={assemblyId}
        characters={topic.characters.filter((c) => !isSocrate(c.name)).map((c) => c.name)}
        avatarUrlMap={avatarUrlMap}
        currentPage="deliverables"
        pageType="deliverables"
        followUps={topic.followUps}
      />
      <HighlightChat
        assemblyId={assemblyId}
        characters={topic.characters.filter((c) => !isSocrate(c.name)).map((c) => c.name)}
        avatarUrlMap={avatarUrlMap}
        currentPage="deliverables"
        defaultMode="ask-assembly"
      />
    </>
  );
}
