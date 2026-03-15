import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getVendorById,
  getVendorContracts,
  getVendorTopBuyers,
} from "@/lib/france/queries";
import { TopEntitiesChart, formatEuro } from "@/components/france/Charts";

const cardStyle: React.CSSProperties = {
  padding: "0.6rem 0.8rem",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
};

const cardLabelStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--color-text-muted)",
};

const cardValueStyle: React.CSSProperties = {
  fontSize: "1.1rem",
  fontWeight: 700,
};

export default async function VendorProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const vendorId = decodeURIComponent(id);

  const vendor = await getVendorById(vendorId);
  if (!vendor) notFound();

  const [contracts, topBuyers] = await Promise.all([
    getVendorContracts(vendorId),
    getVendorTopBuyers(vendorId),
  ]);

  const summaryCards = [
    { label: "Contracts", value: vendor.contract_count.toLocaleString() },
    { label: "Total Spend", value: formatEuro(vendor.total_amount_ht) },
    {
      label: "First Seen",
      value: vendor.first_seen
        ? new Date(vendor.first_seen).getFullYear().toString()
        : "—",
    },
    {
      label: "Last Seen",
      value: vendor.last_seen
        ? new Date(vendor.last_seen).getFullYear().toString()
        : "—",
    },
  ];

  return (
    <div className="ic-dashboard">
      <header className="ic-dashboard-header">
        <div>
          <h1>{vendor.name}</h1>
          <p>
            {vendor.id_type} · {vendorId}
          </p>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "0.75rem",
        }}
      >
        {summaryCards.map((card) => (
          <div key={card.label} style={cardStyle}>
            <div style={cardLabelStyle}>{card.label}</div>
            <div style={cardValueStyle}>{card.value}</div>
          </div>
        ))}
      </div>

      {topBuyers.length > 0 && (
        <section className="ic-section">
          <h2>Top Buyers</h2>
          <TopEntitiesChart data={topBuyers} linkPrefix="/france/buyers" />
        </section>
      )}

      {contracts.length > 0 && (
        <section className="ic-section">
          <h2>Contracts</h2>
          <table className="ic-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Buyer</th>
                <th>Object</th>
                <th style={{ textAlign: "right" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.uid}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {c.notification_date
                      ? new Date(c.notification_date).toLocaleDateString(
                          "fr-FR"
                        )
                      : "—"}
                  </td>
                  <td>
                    <Link href={`/france/buyers/${encodeURIComponent(c.buyer_siret)}`}>
                      {c.buyer_name}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/france/contracts/${encodeURIComponent(c.uid)}`}>
                      {c.object ?? "—"}
                    </Link>
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {c.amount_ht != null ? formatEuro(c.amount_ht) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
