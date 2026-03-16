import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getVendorById,
  getVendorContracts,
  getVendorTopBuyers,
} from "@/lib/france/queries";
import { TopEntitiesChart } from "@/components/france/Charts";
import { formatEuro } from "@/lib/france/format";

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
        : "\u2014",
    },
    {
      label: "Last Seen",
      value: vendor.last_seen
        ? new Date(vendor.last_seen).getFullYear().toString()
        : "\u2014",
    },
  ];

  return (
    <div className="fr-page">
      <header className="fr-page-header">
        <h1>{vendor.name}</h1>
        <p>
          {vendor.id_type} · {vendorId}
        </p>
      </header>

      <div className="fr-stats-grid">
        {summaryCards.map((card) => (
          <div key={card.label} className="fr-stat-card">
            <div className="fr-stat-label">{card.label}</div>
            <div className="fr-stat-value">{card.value}</div>
          </div>
        ))}
      </div>

      {topBuyers.length > 0 && (
        <section className="fr-section">
          <h2 className="fr-section-title">Top Buyers</h2>
          <TopEntitiesChart data={topBuyers} linkPrefix="/france/buyers" />
        </section>
      )}

      {contracts.length > 0 && (
        <section className="fr-section">
          <h2 className="fr-section-title">Contracts</h2>
          <table className="fr-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Buyer</th>
                <th>Object</th>
                <th className="fr-table-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.uid}>
                  <td className="fr-table-nowrap">
                    {c.notification_date
                      ? new Date(c.notification_date).toLocaleDateString(
                          "fr-FR"
                        )
                      : "\u2014"}
                  </td>
                  <td>
                    <Link href={`/france/buyers/${encodeURIComponent(c.buyer_siret)}`}>
                      {c.buyer_name}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/france/contracts/${encodeURIComponent(c.uid)}`}>
                      {c.object ?? "\u2014"}
                    </Link>
                  </td>
                  <td className="fr-table-right fr-table-num">
                    {c.amount_ht != null ? formatEuro(c.amount_ht) : "\u2014"}
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
