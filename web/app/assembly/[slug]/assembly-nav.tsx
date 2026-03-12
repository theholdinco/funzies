"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAssembly, useAssemblyId, useAssemblyAccess } from "@/lib/assembly-context";
import SharePanel from "@/components/SharePanel";
import type { Topic } from "@/lib/types";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function cleanTitle(title: string): string {
  return title.replace(/\s*—\s*Final.*$/, "").replace(/\s*--\s*Assembly.*$/, "");
}

function isSocrate(name: string): boolean {
  return name.toLowerCase().includes("socrate");
}

function formatStructure(structure: string): string {
  const names: Record<string, string> = {
    "grande-table": "Town Hall",
    "rapid-fire": "Crossfire",
    "deep-dive": "Deep Dive",
  };
  return (
    names[structure] ??
    structure
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );
}

interface SidebarAssembly {
  id: string;
  slug: string;
  topic_input: string;
  status: string;
  created_at: string;
}

function formatRelativeDate(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function AssemblyNav({ slug }: { topic?: Topic; slug: string }) {
  const topic = useAssembly();
  const assemblyId = useAssemblyId();
  const accessLevel = useAssemblyAccess();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [history, setHistory] = useState<SidebarAssembly[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/assemblies?sidebar=true")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: SidebarAssembly[]) => {
        setHistory(data);
        setHistoryLoaded(true);
      })
      .catch(() => setHistoryLoaded(true));
  }, []);

  const base = `/assembly/${slug}`;
  const shortTitle = truncate(cleanTitle(topic.title), 30);

  const isActive = useCallback(
    (path: string) => pathname === path,
    [pathname]
  );

  const closeNav = () => setNavOpen(false);

  useEffect(() => {
    document.body.classList.toggle("nav-open", navOpen);
    return () => document.body.classList.remove("nav-open");
  }, [navOpen]);

  const titleLink = topic.synthesis ? `${base}/synthesis` : base;

  return (
    <>
      <button
        className="nav-hamburger"
        aria-label="Open menu"
        onClick={() => setNavOpen(!navOpen)}
      >
        &#9776;
      </button>
      <div className="nav-overlay" onClick={closeNav} />
      <nav>
        <div className="nav-brand">
          <img src="/logo/black-icon.png" alt="" className="nav-brand-icon" />
          Million Minds
        </div>

        <Link href="/" onClick={closeNav}>
          <span className="nav-icon">&#9776;</span> Home
        </Link>

        <div className="nav-divider" />
        <div className="nav-section">
          <Link href={titleLink} className="nav-section-title" onClick={closeNav}>
            {shortTitle}
          </Link>

          {topic.synthesis && (
            <Link
              href={`${base}/synthesis`}
              className={isActive(`${base}/synthesis`) ? "active" : ""}
              onClick={closeNav}
            >
              <span className="nav-icon">&#9733;</span> Consensus
            </Link>
          )}

          {topic.characters.filter((c) => !isSocrate(c.name)).length > 0 && (
            <Link
              href={`${base}/characters`}
              className={isActive(`${base}/characters`) ? "active" : ""}
              onClick={closeNav}
            >
              <span className="nav-icon">&#9823;</span> The Panel
            </Link>
          )}

          {topic.iterations.map((iter) => (
            <Link
              key={iter.number}
              href={`${base}/iteration/${iter.number}`}
              className={
                isActive(`${base}/iteration/${iter.number}`) ? "active" : ""
              }
              onClick={closeNav}
            >
              <span className="nav-icon">&#9656;</span>{" "}
              {formatStructure(iter.structure)}
            </Link>
          ))}

          {topic.deliverables.length > 0 && (
            <Link
              href={`${base}/deliverables`}
              className={isActive(`${base}/deliverables`) ? "active" : ""}
              onClick={closeNav}
            >
              <span className="nav-icon">&#9998;</span> Deliverables
            </Link>
          )}

          {topic.referenceLibrary && (
            <Link
              href={`${base}/references`}
              className={isActive(`${base}/references`) ? "active" : ""}
              onClick={closeNav}
            >
              <span className="nav-icon">&#9783;</span> Babylon&#39;s Library
            </Link>
          )}

          {(topic.followUps.length > 0 || (topic as Topic & { isComplete?: boolean }).isComplete) && (
            <Link
              href={`${base}/trajectory`}
              className={isActive(`${base}/trajectory`) ? "active" : ""}
              onClick={closeNav}
            >
              <span className="nav-icon">&#8634;</span> Thinking Trail
              {topic.followUps.filter(f => f.insight?.hasInsight).length > 0 && (
                <span className="badge badge-tag" style={{ marginLeft: "0.5rem", fontSize: "0.7rem" }}>
                  {topic.followUps.filter(f => f.insight?.hasInsight).length}
                </span>
              )}
            </Link>
          )}
        </div>

        {accessLevel === "owner" && (
          <>
            <div className="nav-divider" />
            <button
              className="nav-share-btn"
              onClick={() => { setShareOpen(true); closeNav(); }}
            >
              <span className="nav-icon">&#8618;</span> Share
            </button>
          </>
        )}

        <div className="nav-divider" />
        <div className="nav-history-header">
          <span className="nav-section-title" style={{ padding: 0 }}>History</span>
          <Link href="/new" className="nav-history-new" onClick={closeNav}>+ New</Link>
        </div>
        <div className="nav-history-list">
          {!historyLoaded ? (
            <div className="nav-history-loading" />
          ) : history.length === 0 ? (
            <span className="nav-history-empty">No assemblies yet</span>
          ) : (
            history.map((a) => (
              <Link
                key={a.id}
                href={`/assembly/${a.slug}`}
                className={`nav-history-item${a.slug === slug ? " active" : ""}`}
                onClick={closeNav}
              >
                <span className="nav-history-title">{truncate(a.topic_input, 35)}</span>
                <span className="nav-history-date">{formatRelativeDate(a.created_at)}</span>
              </Link>
            ))
          )}
        </div>
      </nav>

      {shareOpen && (
        <SharePanel assemblyId={assemblyId} onClose={() => setShareOpen(false)} />
      )}
    </>
  );
}
