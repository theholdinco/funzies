import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { query } from "@/lib/db";
import { verifyAnalysisAccess } from "@/lib/clo/access";
import Link from "next/link";

interface AnalysisRow {
  id: string;
  title: string;
  status: string;
  current_phase: string | null;
}

export default async function AnalysisLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const { id } = await params;

  const hasAccess = await verifyAnalysisAccess(id, session.user.id);
  if (!hasAccess) {
    notFound();
  }

  const rows = await query<AnalysisRow>(
    "SELECT id, title, status, current_phase FROM clo_analyses WHERE id = $1",
    [id]
  );

  if (rows.length === 0) {
    notFound();
  }

  const analysis = rows[0];
  if (analysis.status === "queued" || analysis.status === "running") {
    redirect(`/clo/analyze/${id}/generating`);
  }
  const isComplete = analysis.status === "complete";
  const base = `/clo/analyze/${id}`;

  const tabs = [
    { label: "Memo", href: `${base}/memo`, show: isComplete },
    { label: "Risk", href: `${base}/risk`, show: isComplete },
    { label: "Recommendation", href: `${base}/recommendation`, show: isComplete },
    { label: "Debate", href: `${base}/debate`, show: isComplete },
    { label: "Q&A", href: `${base}/follow-ups`, show: isComplete },
  ];

  const visibleTabs = tabs.filter((t) => t.show);

  return (
    <div className="ic-content">
      <div className="ic-eval-layout">
        <div className="ic-eval-header">
          <Link href="/clo" className="standalone-back">
            &larr; Dashboard
          </Link>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: "1.5rem", fontWeight: 600 }}>
            {analysis.title}
          </h1>
          <span className={`ic-eval-status ic-eval-status-${analysis.status}`}>
            {analysis.status}
          </span>
        </div>

        {visibleTabs.length > 0 && (
          <nav className="ic-eval-tabs">
            {visibleTabs.map((tab) => (
              <Link key={tab.href} href={tab.href} className="ic-eval-tab">
                {tab.label}
              </Link>
            ))}
          </nav>
        )}

        <div className="ic-eval-body">{children}</div>
      </div>
    </div>
  );
}
