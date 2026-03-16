import Link from "next/link";
import { getContracts, ContractFilters } from "@/lib/france/queries";
import { formatEuro } from "@/lib/france/format";

export default async function ContractExplorerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;

  const currentPage = parseInt(params.page ?? "1", 10) || 1;

  const filters: ContractFilters = {
    yearFrom: params.yearFrom ? parseInt(params.yearFrom, 10) : undefined,
    yearTo: params.yearTo ? parseInt(params.yearTo, 10) : undefined,
    buyerSiret: params.buyer,
    vendorId: params.vendor,
    cpvDivision: params.cpv,
    procedure: params.procedure,
    amountMin: params.amountMin ? parseFloat(params.amountMin) : undefined,
    amountMax: params.amountMax ? parseFloat(params.amountMax) : undefined,
    search: params.q,
    page: currentPage,
    pageSize: 50,
  };

  const { rows, total } = await getContracts(filters);

  const totalPages = Math.ceil(total / 50);

  function buildUrl(page: number): string {
    const p = new URLSearchParams();
    if (params.q) p.set("q", params.q);
    if (params.yearFrom) p.set("yearFrom", params.yearFrom);
    if (params.yearTo) p.set("yearTo", params.yearTo);
    if (params.buyer) p.set("buyer", params.buyer);
    if (params.vendor) p.set("vendor", params.vendor);
    if (params.cpv) p.set("cpv", params.cpv);
    if (params.procedure) p.set("procedure", params.procedure);
    if (params.amountMin) p.set("amountMin", params.amountMin);
    if (params.amountMax) p.set("amountMax", params.amountMax);
    p.set("page", String(page));
    return `/france/contracts?${p.toString()}`;
  }

  return (
    <div className="fr-page">
      <header className="fr-page-header">
        <h1>Contract Explorer</h1>
        <p>{total.toLocaleString()} contracts found</p>
      </header>

      <form
        method="GET"
        action="/france/contracts"
        className="fr-filter-form"
      >
        <input
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="Search contracts..."
          className="fr-input"
        />
        <input
          name="yearFrom"
          defaultValue={params.yearFrom ?? ""}
          placeholder="Year from"
          className="fr-input fr-input--narrow"
        />
        <input
          name="yearTo"
          defaultValue={params.yearTo ?? ""}
          placeholder="Year to"
          className="fr-input fr-input--narrow"
        />
        <button type="submit" className="fr-btn fr-btn--primary">
          Filter
        </button>
      </form>

      <div className="fr-table-wrap">
        <table className="fr-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Buyer</th>
              <th>Object</th>
              <th>Procedure</th>
              <th className="fr-table-right">Amount</th>
              <th>Bids</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.uid}>
                <td className="fr-table-nowrap">
                  {c.notification_date
                    ? new Date(c.notification_date).toLocaleDateString("fr-FR")
                    : "\u2014"}
                </td>
                <td>
                  <Link href={`/france/buyers/${c.buyer_siret}`}>{c.buyer_name}</Link>
                </td>
                <td className="fr-table-truncate">
                  <Link href={`/france/contracts/${c.uid}`}>{c.object}</Link>
                </td>
                <td>{c.procedure ?? "\u2014"}</td>
                <td className="fr-table-right fr-table-num">
                  {c.amount_ht != null ? formatEuro(Number(c.amount_ht)) : "\u2014"}
                </td>
                <td>{c.bids_received ?? "\u2014"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="fr-pagination">
        {currentPage > 1 && (
          <Link href={buildUrl(currentPage - 1)} className="fr-btn fr-btn--secondary">
            Previous
          </Link>
        )}
        <span className="fr-pagination-info">
          Page {currentPage} of {totalPages}
        </span>
        {currentPage < totalPages && (
          <Link href={buildUrl(currentPage + 1)} className="fr-btn fr-btn--secondary">
            Next
          </Link>
        )}
      </div>
    </div>
  );
}
