import Link from "next/link";
import {
  getDashboardSummary,
  getSpendByYear,
  getTopBuyers,
  getTopVendors,
  getProcedureBreakdown,
} from "@/lib/france/queries";
import {
  SpendByYearChart,
  ProcedureBreakdownChart,
} from "@/components/france/Charts";
import { formatEuro } from "@/lib/france/format";
import { TopEntity } from "@/lib/france/types";

function EntityList({
  data,
  linkPrefix,
}: {
  data: TopEntity[];
  linkPrefix: string;
}) {
  const max = Math.max(...data.map((d) => d.total_amount), 1);

  return (
    <div className="fr-entity-list">
      {data.map((item) => (
        <Link
          key={item.id}
          href={`${linkPrefix}/${encodeURIComponent(item.id)}`}
          className="fr-entity-row"
        >
          <span className="fr-entity-name">{item.name}</span>
          <div className="fr-entity-bar">
            <div
              className="fr-entity-bar-fill"
              style={{ width: `${(item.total_amount / max) * 100}%` }}
            />
          </div>
          <span className="fr-entity-amount">
            {formatEuro(item.total_amount)}
          </span>
        </Link>
      ))}
    </div>
  );
}

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
    <div className="fr-page">
      <header className="fr-page-header">
        <h1>French Public Procurement</h1>
        <p>DECP contract data from data.gouv.fr</p>
      </header>

      <div className="fr-stats-grid">
        {cards.map((card) => (
          <div key={card.label} className="fr-stat-card">
            <div className="fr-stat-label">{card.label}</div>
            <div className="fr-stat-value">{card.value}</div>
            {card.sub && <div className="fr-stat-sub">{card.sub}</div>}
          </div>
        ))}
      </div>

      <section className="fr-section">
        <h2 className="fr-section-title">Spend by Year</h2>
        <SpendByYearChart data={spendByYear} />
      </section>

      <div className="fr-two-col">
        <section className="fr-section">
          <h2 className="fr-section-title">Top 10 Buyers</h2>
          <EntityList data={topBuyers} linkPrefix="/france/buyers" />
        </section>
        <section className="fr-section">
          <h2 className="fr-section-title">Top 10 Vendors</h2>
          <EntityList data={topVendors} linkPrefix="/france/vendors" />
        </section>
      </div>

      <section className="fr-section">
        <h2 className="fr-section-title">Procedure Type Breakdown</h2>
        <ProcedureBreakdownChart data={procedureBreakdown} />
      </section>
    </div>
  );
}
