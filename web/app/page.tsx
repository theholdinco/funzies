import { auth } from "@/lib/auth";
import { query } from "@/lib/db";
import { redirect } from "next/navigation";
import Link from "next/link";
import AuthForm from "@/components/AuthForm";
import { AssemblyCard } from "@/components/AssemblyCard";
import EmptyDashboard from "@/components/EmptyDashboard";
import GitHubConnect from "@/components/GitHubConnect";

interface AssemblyRow {
  id: string;
  slug: string;
  topic_input: string;
  status: string;
  current_phase: string | null;
  created_at: string;
  completed_at: string | null;
  shared_by?: string | null;
  shared_role?: string | null;
}

export default async function Dashboard() {
  const session = await auth();

  if (!session?.user) {
    return <LandingPage />;
  }

  const userId = session.user.id;

  const userRows = await query<{
    api_key_valid: boolean | null;
    api_key_prefix: string | null;
    free_trial_used: boolean;
  }>(
    "SELECT api_key_valid, api_key_prefix, free_trial_used FROM users WHERE id = $1",
    [userId]
  );

  const hasApiKey = !!userRows[0]?.api_key_prefix;
  const freeTrialAvailable = !hasApiKey && !userRows[0]?.free_trial_used;

  if (!hasApiKey && !freeTrialAvailable) {
    redirect("/onboarding");
  }

  const [ownAssemblies, sharedAssemblies] = await Promise.all([
    query<AssemblyRow>(
      `SELECT id, slug, topic_input, status, current_phase, created_at, completed_at
       FROM assemblies
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    ),
    query<AssemblyRow>(
      `SELECT a.id, a.slug, a.topic_input, a.status, a.current_phase, a.created_at, a.completed_at,
              COALESCE(u.name, u.email) as shared_by, s.role as shared_role
       FROM assembly_shares s
       JOIN assemblies a ON s.assembly_id = a.id
       JOIN users u ON a.user_id = u.id
       WHERE s.user_id = $1
       ORDER BY a.created_at DESC`,
      [userId]
    ),
  ]);

  const assemblies = [...ownAssemblies, ...sharedAssemblies].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <div className="dashboard">
      {userRows[0]?.api_key_valid === false && hasApiKey && (
        <div className="api-key-warning">
          Your API key is no longer valid. <a href="/onboarding">Update it</a> to continue using Million Minds.
        </div>
      )}
      {freeTrialAvailable && (
        <div className="api-key-warning" style={{ borderColor: "var(--color-high)" }}>
          Free trial — 1 panel + 5 interactions. <a href="/onboarding">Add your API key</a> for unlimited access.
        </div>
      )}

      <div className="dashboard-github-bar">
        <Link href="/tokens" className="dashboard-bar-link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          API Tokens
        </Link>
        <GitHubConnect />
      </div>

      {assemblies.length === 0 ? (
        <EmptyDashboard />
      ) : (
        <>
          <header className="dashboard-header">
            <div>
              <h1>Your Panels</h1>
              <p>Adversarial debates powered by a Million Minds</p>
            </div>
            <Link href="/new" className="dashboard-cta">
              + New Panel
            </Link>
          </header>
          <div className="assembly-list">
            {assemblies.map((a) => (
              <AssemblyCard
                key={a.id}
                assembly={a}
                sharedBy={a.shared_by}
                sharedRole={a.shared_role}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LandingPage() {
  return (
    <div className="landing">
      <div className="landing-hero">
        <div className="landing-hero-inner">
          <div className="landing-badge">Adversarial Deliberation Engine</div>
          <img src="/logo/black-text.png" alt="Million Minds" className="landing-logo" />
          <h1 className="landing-title sr-only">Million Minds</h1>
          <p className="landing-subtitle">
            Fresh minds every time. Incompatible frameworks.
            One structured collision that reveals what no single perspective can.
          </p>

          <div className="landing-features">
            <div className="landing-feature">
              <span className="landing-feature-icon">&#9670;</span>
              <div>
                <strong>Grande Table Debates</strong>
                <span>Multi-round adversarial deliberation between characters with irreconcilable worldviews</span>
              </div>
            </div>
            <div className="landing-feature">
              <span className="landing-feature-icon">&#9670;</span>
              <div>
                <strong>Deep Synthesis</strong>
                <span>Structured convergence mapping, tension analysis, and actionable deliverables</span>
              </div>
            </div>
            <div className="landing-feature">
              <span className="landing-feature-icon">&#9670;</span>
              <div>
                <strong>Living Documents</strong>
                <span>Ask follow-up questions, challenge conclusions, and explore the reference library</span>
              </div>
            </div>
          </div>

          <div className="landing-colophon">
            Try your first panel free &middot; No API key required &middot; Full panel in ~5 minutes
          </div>
        </div>
      </div>

      <div className="landing-auth">
        <div className="landing-auth-inner">
          <p className="landing-auth-heading">Get started</p>
          <AuthForm />
        </div>
      </div>
    </div>
  );
}
