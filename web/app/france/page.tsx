import {
  getDashboardSummary,
  getSpendByYear,
  getTopBuyers,
  getTopVendors,
  getProcedureBreakdown,
} from "@/lib/france/queries";
import {
  SpendByYearChart,
  TopEntitiesChart,
  ProcedureBreakdownChart,
} from "@/components/france/Charts";
import { formatEuro } from "@/lib/france/format";

export default async function FranceDashboard() {
  const [summary, spendByYear, topBuyers, topVendors, procedureBreakdown] =
    await Promise.all([
      getDashboardSummary(),
      getSpendByYear(),
      getTopBuyers(),
      getTopVendors(),
      getProcedureBreakdown(),
    ]);

  const cards = [
    {
      label: "Contracts",
      value: summary.total_contracts.toLocaleString(),
      sub: formatEuro(summary.total_spend) + " total",
    },
    {
      label: "Vendors",
      value: summary.unique_vendors.toLocaleString(),
    },
    {
      label: "Buyers",
      value: summary.unique_buyers.toLocaleString(),
    },
    {
      label: "Avg Bids",
      value: summary.avg_bids.toString(),
      sub: "per contract",
    },
  ];

  return (
    <div className="ic-dashboard">
      <header className="ic-dashboard-header">
        <div>
          <h1>French Public Procurement</h1>
          <p>DECP contract data from data.gouv.fr</p>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "0.75rem",
        }}
      >
        {cards.map((card) => (
          <div
            key={card.label}
            style={{
              padding: "0.8rem 1rem",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <div
              style={{
                fontSize: "0.7rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--color-text-muted)",
              }}
            >
              {card.label}
            </div>
            <div style={{ fontSize: "1.3rem", fontWeight: 700 }}>
              {card.value}
            </div>
            {card.sub && (
              <div
                style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}
              >
                {card.sub}
              </div>
            )}
          </div>
        ))}
      </div>

      <section className="ic-section">
        <h2>Spend by Year</h2>
        <SpendByYearChart data={spendByYear} />
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
        <section className="ic-section">
          <h2>Top 10 Buyers</h2>
          <TopEntitiesChart data={topBuyers} linkPrefix="/france/buyers" />
        </section>
        <section className="ic-section">
          <h2>Top 10 Vendors</h2>
          <TopEntitiesChart data={topVendors} linkPrefix="/france/vendors" />
        </section>
      </div>

      <section className="ic-section">
        <h2>Procedure Type Breakdown</h2>
        <ProcedureBreakdownChart data={procedureBreakdown} />
      </section>
    </div>
  );
}
