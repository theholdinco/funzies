import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getProfileForUser } from "@/lib/clo/access";
import Link from "next/link";

export default async function CLOLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/");
  }

  const profile = await getProfileForUser(session.user.id);

  return (
    <div className="ic-layout">
      <aside className="ic-sidebar">
        <div className="ic-sidebar-header">
          <Link href="/" className="ic-sidebar-logo">
            <img src="/logo/black-text.png" alt="Million Minds" className="sidebar-logo-img" />
          </Link>
          <span className="ic-sidebar-badge">CLO</span>
        </div>

        <nav className="ic-sidebar-nav">
          <Link href="/clo" className="ic-nav-link">
            <span className="ic-nav-icon">&#9670;</span>
            Dashboard
          </Link>
          {profile && (
            <>
              <Link href="/clo/panel" className="ic-nav-link">
                <span className="ic-nav-icon">&#9670;</span>
                Panel
              </Link>
              <Link href="/clo/context" className="ic-nav-link">
                <span className="ic-nav-icon">&#9670;</span>
                Context
              </Link>
              <Link href="/clo/analyze/new" className="ic-nav-link">
                <span className="ic-nav-icon">&#9670;</span>
                New Analysis
              </Link>
              <Link href="/clo/screenings" className="ic-nav-link">
                <span className="ic-nav-icon">&#9670;</span>
                Screenings
              </Link>
            </>
          )}
        </nav>

        <div className="ic-sidebar-footer">
          <Link href="/" className="ic-nav-link ic-nav-link-muted">
            &larr; Back to Panels
          </Link>
        </div>
      </aside>

      <main className="ic-main">
        {children}
        {profile && (
          <Link
            href="/clo/context"
            style={{
              position: "fixed",
              bottom: "1.5rem",
              left: "1.5rem",
              padding: "0.4rem 0.8rem",
              fontSize: "0.75rem",
              color: "var(--color-text-muted)",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              opacity: 0.7,
              textDecoration: "none",
              zIndex: 50,
            }}
          >
            Edit Context
          </Link>
        )}
      </main>
    </div>
  );
}
