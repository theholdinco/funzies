import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function FranceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="ic-layout">
      <aside className="ic-sidebar">
        <div className="ic-sidebar-header">
          <Link href="/" className="ic-sidebar-logo">
            <img src="/logo/black-text.png" alt="Million Minds" className="sidebar-logo-img" />
          </Link>
          <span className="ic-sidebar-badge">FRANCE</span>
        </div>

        <nav className="ic-sidebar-nav">
          <Link href="/france" className="ic-nav-link">
            <span className="ic-nav-icon">&#9670;</span>
            Dashboard
          </Link>
          <Link href="/france/contracts" className="ic-nav-link">
            <span className="ic-nav-icon">&#9670;</span>
            Contracts
          </Link>
          <Link href="/france/analytics" className="ic-nav-link">
            <span className="ic-nav-icon">&#9670;</span>
            Analytics
          </Link>
        </nav>
      </aside>

      <main className="ic-main">
        {children}
      </main>
    </div>
  );
}
