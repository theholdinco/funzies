import Link from "next/link";
import {
  getVendorConcentration,
  getAmendmentInflation,
  getCompetitionByYear,
} from "@/lib/france/queries";
import { formatEuro } from "@/lib/france/format";

type View = "concentration" | "amendments" | "competition";

const tabs: { label: string; view: View }[] = [
  { label: "Vendor Concentration", view: "concentration" },
  { label: "Amendment Inflation", view: "amendments" },
  { label: "Competition Analysis", view: "competition" },
];

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const view: View = (params.view as View) ?? "concentration";

  const [concentration, amendments, competition] = await Promise.all([
    view === "concentration"
      ? getVendorConcentration(params.cpv)
      : Promise.resolve([]),
    view === "amendments" ? getAmendmentInflation() : Promise.resolve([]),
    view === "competition" ? getCompetitionByYear() : Promise.resolve([]),
  ]);

  return (
    <div className="fr-page">
      <header className="fr-page-header">
        <h1>Analytics</h1>
        <p>Procurement pattern analysis</p>
      </header>

      <div className="fr-tabs">
        {tabs.map(({ label, view: tabView }) => (
          <Link
            key={tabView}
            href={`/france/analytics?view=${tabView}`}
            className={`fr-tab${view === tabView ? " fr-tab--active" : ""}`}
          >
            {label}
          </Link>
        ))}
      </div>

      <div className="fr-table-wrap">
        {view === "concentration" && (
          <table className="fr-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Vendor</th>
                <th className="fr-table-right">Total Spend</th>
                <th>Contracts</th>
                <th>Market Share (%)</th>
              </tr>
            </thead>
            <tbody>
              {(concentration as Awaited<ReturnType<typeof getVendorConcentration>>).map(
                (row, i) => (
                  <tr key={row.id}>
                    <td>{i + 1}</td>
                    <td>
                      <Link href={`/france/vendors/${row.id}`}>{row.name}</Link>
                    </td>
                    <td className="fr-table-right fr-table-num">
                      {formatEuro(row.total_amount)}
                    </td>
                    <td>{row.contract_count.toLocaleString()}</td>
                    <td>{row.market_share.toFixed(2)}%</td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        )}

        {view === "amendments" && (
          <table className="fr-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Buyer</th>
                <th className="fr-table-right">Original Amount</th>
                <th className="fr-table-right">Final Amount</th>
                <th>Increase %</th>
                <th>Mods</th>
              </tr>
            </thead>
            <tbody>
              {(amendments as Awaited<ReturnType<typeof getAmendmentInflation>>).map((row) => (
                <tr key={row.contract_uid}>
                  <td className="fr-table-truncate">
                    <Link href={`/france/contracts/${row.contract_uid}`}>{row.object}</Link>
                  </td>
                  <td>{row.buyer_name}</td>
                  <td className="fr-table-right fr-table-num">
                    {formatEuro(row.original_amount)}
                  </td>
                  <td className="fr-table-right fr-table-num">
                    {formatEuro(row.final_amount)}
                  </td>
                  <td className="fr-table-danger fr-table-num">
                    +{row.pct_increase.toFixed(1)}%
                  </td>
                  <td>{row.modification_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === "competition" && (
          <table className="fr-table">
            <thead>
              <tr>
                <th>Year</th>
                <th>Procedure</th>
                <th className="fr-table-right">Total Spend</th>
                <th>Contracts</th>
                <th>Avg Bids</th>
              </tr>
            </thead>
            <tbody>
              {(competition as Awaited<ReturnType<typeof getCompetitionByYear>>).map((row, i) => (
                <tr key={i}>
                  <td>{row.year}</td>
                  <td>{row.procedure}</td>
                  <td className="fr-table-right fr-table-num">
                    {formatEuro(row.total_amount)}
                  </td>
                  <td>{row.contract_count.toLocaleString()}</td>
                  <td>{row.avg_bids.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
