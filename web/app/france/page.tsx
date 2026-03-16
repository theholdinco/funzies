import Link from "next/link";
import {
  getFlagStats,
  getLowestCompetitionBuyers,
  getTopNoCompetitionSpenders,
  getWorstAmendmentInflations,
} from "@/lib/france/queries";
import { formatEuro } from "@/lib/france/format";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function FranceFlagsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const showComp = Math.min(parseInt(params.comp ?? "10", 10) || 10, 200);
  const showNoComp = Math.min(parseInt(params.nocomp ?? "10", 10) || 10, 200);
  const showInflation = Math.min(parseInt(params.inflation ?? "10", 10) || 10, 200);

  const [stats, lowestCompetition, topNoComp, worstInflations] =
    await Promise.all([
      getFlagStats(),
      getLowestCompetitionBuyers(showComp),
      getTopNoCompetitionSpenders(showNoComp),
      getWorstAmendmentInflations(showInflation),
    ]);

  function moreUrl(key: string, current: number): string {
    const p = new URLSearchParams();
    if (params.comp && key !== "comp") p.set("comp", params.comp);
    if (params.nocomp && key !== "nocomp") p.set("nocomp", params.nocomp);
    if (params.inflation && key !== "inflation") p.set("inflation", params.inflation);
    p.set(key, String(current + PAGE_SIZE));
    return `/france?${p.toString()}`;
  }

  return (
    <div className="fr-page">
      <header className="fr-page-header">
        <h1>Procurement Red Flags</h1>
        <p>Anomaly detection across French public procurement data (DECP)</p>
      </header>

      <div className="fr-stats-grid">
        <div className="fr-stat-card">
          <div className="fr-stat-label">Single-Bid Rate</div>
          <div className="fr-stat-value">{stats.singleBidRate.toFixed(1)}%</div>
          <div className="fr-stat-sub">from {stats.singleBidRate2019.toFixed(1)}% in 2019</div>
        </div>
        <div className="fr-stat-card">
          <div className="fr-stat-label">No-Competition</div>
          <div className="fr-stat-value">{formatEuro(stats.noCompetitionSpend)}</div>
          <div className="fr-stat-sub">{stats.noCompetitionContracts.toLocaleString()} contracts</div>
        </div>
        <div className="fr-stat-card">
          <div className="fr-stat-label">Doubled Contracts</div>
          <div className="fr-stat-value">{stats.doubledContracts.toLocaleString()}</div>
          <div className="fr-stat-sub">post-award value &gt;2x</div>
        </div>
        <div className="fr-stat-card">
          <div className="fr-stat-label">Missing Bid Data</div>
          <div className="fr-stat-value">{stats.missingBidDataPct.toFixed(1)}%</div>
          <div className="fr-stat-sub">of all contracts</div>
        </div>
      </div>

      <section className="fr-section">
        <h2 className="fr-section-title">Lowest Competition Buyers</h2>
        <div className="fr-table-wrap">
          <table className="fr-table">
            <thead>
              <tr>
                <th>Buyer</th>
                <th className="fr-table-right">Contracts w/ Bids</th>
                <th className="fr-table-right">Single Bid %</th>
                <th className="fr-table-right">Total Spend</th>
              </tr>
            </thead>
            <tbody>
              {lowestCompetition.map((row) => (
                <tr key={row.siret}>
                  <td>
                    <Link href={`/france/buyers/${row.siret}`}>{row.name}</Link>
                  </td>
                  <td className="fr-table-right fr-table-num">
                    {row.contractsWithBids.toLocaleString()}
                  </td>
                  <td className="fr-table-right fr-table-num">
                    {row.singleBidPct.toFixed(1)}%
                  </td>
                  <td className="fr-table-right fr-table-num">
                    {formatEuro(row.totalSpend)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {lowestCompetition.length >= showComp && (
          <Link href={moreUrl("comp", showComp)} className="fr-btn fr-btn--secondary fr-show-more">
            Show {PAGE_SIZE} more
          </Link>
        )}
      </section>

      <section className="fr-section">
        <h2 className="fr-section-title">Top No-Competition Spenders</h2>
        <div className="fr-table-wrap">
          <table className="fr-table">
            <thead>
              <tr>
                <th>Buyer</th>
                <th className="fr-table-right">No-Comp Contracts</th>
                <th className="fr-table-right">Total No-Comp Spend</th>
              </tr>
            </thead>
            <tbody>
              {topNoComp.map((row) => (
                <tr key={row.siret}>
                  <td>
                    <Link href={`/france/buyers/${row.siret}`}>{row.name}</Link>
                  </td>
                  <td className="fr-table-right fr-table-num">
                    {row.noCompContracts.toLocaleString()}
                  </td>
                  <td className="fr-table-right fr-table-num">
                    {formatEuro(row.noCompSpend)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {topNoComp.length >= showNoComp && (
          <Link href={moreUrl("nocomp", showNoComp)} className="fr-btn fr-btn--secondary fr-show-more">
            Show {PAGE_SIZE} more
          </Link>
        )}
      </section>

      <section className="fr-section">
        <h2 className="fr-section-title">Worst Amendment Inflations</h2>
        <div className="fr-table-wrap">
          <table className="fr-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Buyer</th>
                <th className="fr-table-right">Original</th>
                <th className="fr-table-right">Final</th>
                <th className="fr-table-right">Increase %</th>
              </tr>
            </thead>
            <tbody>
              {worstInflations.map((row) => (
                <tr key={row.uid}>
                  <td className="fr-table-truncate">
                    <Link href={`/france/contracts/${row.uid}`}>{row.object}</Link>
                  </td>
                  <td>{row.buyerName}</td>
                  <td className="fr-table-right fr-table-num">
                    {formatEuro(row.originalAmount)}
                  </td>
                  <td className="fr-table-right fr-table-num">
                    {formatEuro(row.finalAmount)}
                  </td>
                  <td className="fr-table-right fr-table-danger">
                    +{row.pctIncrease.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {worstInflations.length >= showInflation && (
          <Link href={moreUrl("inflation", showInflation)} className="fr-btn fr-btn--secondary fr-show-more">
            Show {PAGE_SIZE} more
          </Link>
        )}
      </section>
    </div>
  );
}
