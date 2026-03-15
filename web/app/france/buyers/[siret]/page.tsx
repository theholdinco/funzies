import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getBuyerBySiret,
  getBuyerContracts,
  getBuyerTopVendors,
  getBuyerProcedureBreakdown,
} from "@/lib/france/queries";
import {
  TopEntitiesChart,
  ProcedureBreakdownChart,
  formatEuro,
} from "@/components/france/Charts";

export default async function BuyerPage({
  params,
}: {
  params: Promise<{ siret: string }>;
}) {
  const { siret } = await params;
  const buyer = await getBuyerBySiret(siret);
  if (!buyer) notFound();

  const [contracts, topVendors, procedureBreakdown] = await Promise.all([
    getBuyerContracts(siret),
    getBuyerTopVendors(siret),
    getBuyerProcedureBreakdown(siret),
  ]);

  const cards = [
    { label: "Contracts", value: buyer.contract_count.toLocaleString() },
    { label: "Total Spend", value: formatEuro(buyer.total_amount_ht) },
    {
      label: "First Seen",
      value: new Date(buyer.first_seen).getFullYear().toString(),
    },
    {
      label: "Last Seen",
      value: new Date(buyer.last_seen).getFullYear().toString(),
    },
  ];

  return (
    <div className="ic-dashboard">
      <header className="ic-dashboard-header">
        <div>
          <h1>{buyer.name}</h1>
          <p>SIRET: {buyer.siret}</p>
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
          </div>
        ))}
      </div>

      <section className="ic-section">
        <h2>Procedure Types</h2>
        <ProcedureBreakdownChart data={procedureBreakdown} />
      </section>

      <section className="ic-section">
        <h2>Top Vendors</h2>
        <TopEntitiesChart data={topVendors} linkPrefix="/france/vendors" />
      </section>

      <section className="ic-section">
        <h2>Contracts</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--color-border)",
                textAlign: "left",
              }}
            >
              <th style={{ padding: "0.4rem 0.6rem", color: "var(--color-text-muted)" }}>Date</th>
              <th style={{ padding: "0.4rem 0.6rem", color: "var(--color-text-muted)" }}>Object</th>
              <th style={{ padding: "0.4rem 0.6rem", color: "var(--color-text-muted)" }}>Procedure</th>
              <th style={{ padding: "0.4rem 0.6rem", color: "var(--color-text-muted)", textAlign: "right" }}>Amount</th>
              <th style={{ padding: "0.4rem 0.6rem", color: "var(--color-text-muted)", textAlign: "right" }}>Bids</th>
            </tr>
          </thead>
          <tbody>
            {contracts.map((c) => (
              <tr
                key={c.uid}
                style={{ borderBottom: "1px solid var(--color-border)" }}
              >
                <td style={{ padding: "0.4rem 0.6rem", whiteSpace: "nowrap" }}>
                  {c.notification_date
                    ? new Date(c.notification_date).toLocaleDateString("fr-FR")
                    : "—"}
                </td>
                <td style={{ padding: "0.4rem 0.6rem", maxWidth: 400 }}>
                  <Link
                    href={`/france/contracts/${encodeURIComponent(c.uid)}`}
                    style={{
                      color: "var(--color-accent)",
                      textDecoration: "none",
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {c.object || "—"}
                  </Link>
                </td>
                <td style={{ padding: "0.4rem 0.6rem" }}>{c.procedure || "—"}</td>
                <td style={{ padding: "0.4rem 0.6rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {c.amount_ht != null ? formatEuro(c.amount_ht) : "—"}
                </td>
                <td style={{ padding: "0.4rem 0.6rem", textAlign: "right" }}>
                  {c.bids_received ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
