import Link from "next/link";
import "./france.css";

export const dynamic = "force-dynamic";

export default async function FranceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="fr-layout">
      <aside className="fr-sidebar">
        <div className="fr-sidebar-header">
          <Link href="/">
            <img
              src="/logo/black-text.png"
              alt="Million Minds"
              className="sidebar-logo-img"
            />
          </Link>
          <span className="fr-sidebar-badge">FRANCE</span>
        </div>

        <nav className="fr-sidebar-nav">
          <Link href="/france" className="fr-nav-link">
            <span className="fr-nav-icon">&#9632;</span>
            Dashboard
          </Link>
          <Link href="/france/contracts" className="fr-nav-link">
            <span className="fr-nav-icon">&#9670;</span>
            Contracts
          </Link>
          <Link href="/france/analytics" className="fr-nav-link">
            <span className="fr-nav-icon">&#9679;</span>
            Analytics
          </Link>
        </nav>

        <div className="fr-sidebar-footer">
          Source:{" "}
          <a
            href="https://data.gouv.fr"
            target="_blank"
            rel="noopener noreferrer"
          >
            data.gouv.fr
          </a>
          <br />
          BOAMP &middot; DECP
        </div>
      </aside>

      <main className="fr-main">{children}</main>
    </div>
  );
}
