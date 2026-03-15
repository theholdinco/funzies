import Link from "next/link";
import { getContracts, ContractFilters } from "@/lib/france/queries";
import { formatEuro } from "@/lib/france/format";

const inputStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  fontSize: "0.85rem",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
};

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
    <div className="ic-dashboard">
      <header className="ic-dashboard-header">
        <div>
          <h1>Contract Explorer</h1>
          <p>{total.toLocaleString()} contracts found</p>
        </div>
      </header>

      <form
        method="GET"
        action="/france/contracts"
        style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}
      >
        <input
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="Search contracts..."
          style={inputStyle}
        />
        <input
          name="yearFrom"
          defaultValue={params.yearFrom ?? ""}
          placeholder="Year from"
          style={{ ...inputStyle, width: 100 }}
        />
        <input
          name="yearTo"
          defaultValue={params.yearTo ?? ""}
          placeholder="Year to"
          style={{ ...inputStyle, width: 100 }}
        />
        <button type="submit" className="btn-primary">
          Filter
        </button>
      </form>

      <div style={{ overflowX: "auto", marginTop: "1rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
          <thead>
            <tr>
              {["Date", "Buyer", "Object", "Procedure", "Amount", "Bids"].map((col) => (
                <th
                  key={col}
                  style={{
                    padding: "0.5rem 0.6rem",
                    fontWeight: 600,
                    color: "var(--color-text-muted)",
                    textAlign: col === "Amount" ? "right" : "left",
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.uid} style={{ borderBottom: "1px solid var(--color-border)" }}>
                <td style={{ padding: "0.4rem 0.6rem", whiteSpace: "nowrap" }}>
                  {c.notification_date
                    ? new Date(c.notification_date).toLocaleDateString("fr-FR")
                    : "—"}
                </td>
                <td style={{ padding: "0.4rem 0.6rem" }}>
                  <Link href={`/france/buyers/${c.buyer_siret}`}>{c.buyer_name}</Link>
                </td>
                <td
                  style={{
                    padding: "0.4rem 0.6rem",
                    maxWidth: 300,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <Link href={`/france/contracts/${c.uid}`}>{c.object}</Link>
                </td>
                <td style={{ padding: "0.4rem 0.6rem" }}>{c.procedure ?? "—"}</td>
                <td
                  style={{
                    padding: "0.4rem 0.6rem",
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {c.amount_ht != null ? formatEuro(Number(c.amount_ht)) : "—"}
                </td>
                <td style={{ padding: "0.4rem 0.6rem" }}>{c.bids_received ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: "1rem",
          marginTop: "1.5rem",
        }}
      >
        {currentPage > 1 && (
          <Link href={buildUrl(currentPage - 1)} className="btn-secondary">
            Previous
          </Link>
        )}
        <span style={{ fontSize: "0.85rem" }}>
          Page {currentPage} of {totalPages}
        </span>
        {currentPage < totalPages && (
          <Link href={buildUrl(currentPage + 1)} className="btn-secondary">
            Next
          </Link>
        )}
      </div>
    </div>
  );
}
