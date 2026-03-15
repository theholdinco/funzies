import Link from "next/link";
import {
  getVendorConcentration,
  getAmendmentInflation,
  getCompetitionByYear,
} from "@/lib/france/queries";
import { formatEuro } from "@/components/france/Charts";

type View = "concentration" | "amendments" | "competition";

const tabs: { label: string; view: View }[] = [
  { label: "Vendor Concentration", view: "concentration" },
  { label: "Amendment Inflation", view: "amendments" },
  { label: "Competition Analysis", view: "competition" },
];

const thStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  fontWeight: 600,
  color: "var(--color-text-muted)",
  textAlign: "left",
};

const tdStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid var(--color-border)",
};

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
    <div className="ic-dashboard">
      <header className="ic-dashboard-header">
        <div>
          <h1>Analytics</h1>
          <p>Procurement pattern analysis</p>
        </div>
      </header>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
        {tabs.map(({ label, view: tabView }) => {
          const isActive = view === tabView;
          return (
            <Link
              key={tabView}
              href={`/france/analytics?view=${tabView}`}
              style={{
                padding: "0.4rem 1rem",
                fontSize: "0.85rem",
                borderRadius: "var(--radius-sm)",
                textDecoration: "none",
                border: "1px solid var(--color-border)",
                background: isActive ? "var(--color-accent)" : "var(--color-surface)",
                color: isActive ? "#fff" : "var(--color-text)",
              }}
            >
              {label}
            </Link>
          );
        })}
      </div>

      <div style={{ overflowX: "auto" }}>
        {view === "concentration" && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr>
                {["#", "Vendor", "Total Spend", "Contracts", "Market Share (%)"].map((col) => (
                  <th key={col} style={thStyle}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(concentration as Awaited<ReturnType<typeof getVendorConcentration>>).map(
                (row, i) => (
                  <tr key={row.id}>
                    <td style={tdStyle}>{i + 1}</td>
                    <td style={tdStyle}>
                      <Link href={`/france/vendors/${row.id}`}>{row.name}</Link>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {formatEuro(row.total_amount)}
                    </td>
                    <td style={tdStyle}>{row.contract_count.toLocaleString()}</td>
                    <td style={tdStyle}>{row.market_share.toFixed(2)}%</td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        )}

        {view === "amendments" && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr>
                {["Contract", "Buyer", "Original Amount", "Final Amount", "Increase %", "Mods"].map(
                  (col) => (
                    <th key={col} style={thStyle}>
                      {col}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {(amendments as Awaited<ReturnType<typeof getAmendmentInflation>>).map((row) => (
                <tr key={row.contract_uid}>
                  <td
                    style={{
                      ...tdStyle,
                      maxWidth: 260,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Link href={`/france/contracts/${row.contract_uid}`}>{row.object}</Link>
                  </td>
                  <td style={tdStyle}>{row.buyer_name}</td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {formatEuro(row.original_amount)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {formatEuro(row.final_amount)}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      color: "red",
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    +{row.pct_increase.toFixed(1)}%
                  </td>
                  <td style={tdStyle}>{row.modification_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === "competition" && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
            <thead>
              <tr>
                {["Year", "Procedure", "Total Spend", "Contracts", "Avg Bids"].map((col) => (
                  <th key={col} style={thStyle}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(competition as Awaited<ReturnType<typeof getCompetitionByYear>>).map((row, i) => (
                <tr key={i}>
                  <td style={tdStyle}>{row.year}</td>
                  <td style={tdStyle}>{row.procedure}</td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {formatEuro(row.total_amount)}
                  </td>
                  <td style={tdStyle}>{row.contract_count.toLocaleString()}</td>
                  <td style={tdStyle}>{row.avg_bids.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
