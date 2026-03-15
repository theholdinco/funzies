import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getContractByUid,
  getContractVendors,
  getContractModifications,
} from "@/lib/france/queries";
import { formatEuro } from "@/lib/france/format";

export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ uid: string }>;
}) {
  const { uid } = await params;
  const decodedUid = decodeURIComponent(uid);

  const contract = await getContractByUid(decodedUid);
  if (!contract) notFound();

  const [vendors, modifications] = await Promise.all([
    getContractVendors(contract.uid),
    getContractModifications(contract.uid),
  ]);

  const notificationDate = contract.notification_date
    ? new Date(contract.notification_date).toLocaleDateString("fr-FR")
    : null;

  const fields: { label: string; value: string | number }[] = [
    { label: "UID", value: contract.uid },
    contract.nature && { label: "Nature", value: contract.nature },
    contract.procedure && { label: "Procedure", value: contract.procedure },
    contract.cpv_code && { label: "CPV", value: contract.cpv_code },
    contract.duration_months != null && {
      label: "Duration",
      value: `${contract.duration_months} months`,
    },
    notificationDate && { label: "Notification Date", value: notificationDate },
    contract.location_name && {
      label: "Location",
      value: contract.location_name,
    },
    contract.bids_received != null && {
      label: "Bids Received",
      value: contract.bids_received,
    },
    contract.form_of_price && {
      label: "Price Form",
      value: contract.form_of_price,
    },
    contract.framework_id && {
      label: "Framework ID",
      value: contract.framework_id,
    },
  ].filter(Boolean) as { label: string; value: string | number }[];

  return (
    <div className="ic-dashboard">
      <header className="ic-dashboard-header">
        <div>
          <h1>{contract.object || "Contract Detail"}</h1>
          <p>
            <Link href={`/france/buyers/${encodeURIComponent(contract.buyer_siret)}`}>
              {contract.buyer_name}
            </Link>
            {contract.amount_ht != null && (
              <> &mdash; {formatEuro(contract.amount_ht)}</>
            )}
          </p>
        </div>
      </header>

      <section className="ic-section">
        <h2>Contract Details</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "0.5rem",
          }}
        >
          {fields.map((field) => (
            <div
              key={field.label}
              style={{
                padding: "0.5rem 0.8rem",
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
                {field.label}
              </div>
              <div style={{ fontSize: "0.9rem", marginTop: "0.2rem" }}>
                {field.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {vendors.length > 0 && (
        <section className="ic-section">
          <h2>Vendors</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {vendors.map((v) => (
              <Link
                key={v.vendor_id}
                href={`/france/vendors/${encodeURIComponent(v.vendor_id)}`}
                style={{
                  padding: "0.4rem 0.8rem",
                  background: "var(--color-accent-subtle)",
                  color: "var(--color-accent)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.85rem",
                  textDecoration: "none",
                }}
              >
                {v.vendor_name}
              </Link>
            ))}
          </div>
        </section>
      )}

      {modifications.length > 0 && (
        <section className="ic-section">
          <h2>Modifications</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: "0.75rem",
            }}
          >
            {modifications.map((mod) => {
              const pctChange =
                mod.new_amount_ht != null && contract.amount_ht
                  ? ((mod.new_amount_ht - contract.amount_ht) / contract.amount_ht) * 100
                  : null;

              return (
                <div
                  key={mod.id}
                  style={{
                    padding: "0.5rem 0.8rem",
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--color-text-muted)",
                      marginBottom: "0.25rem",
                    }}
                  >
                    {mod.publication_date
                      ? new Date(mod.publication_date).toLocaleDateString("fr-FR")
                      : "—"}
                  </div>
                  {mod.new_amount_ht != null && (
                    <div style={{ fontWeight: 600 }}>
                      {formatEuro(mod.new_amount_ht)}
                      {pctChange != null && (
                        <span
                          style={{
                            marginLeft: "0.5rem",
                            fontSize: "0.8rem",
                            color: pctChange > 0 ? "var(--color-danger)" : "var(--color-success)",
                          }}
                        >
                          {pctChange > 0 ? "+" : ""}
                          {pctChange.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  )}
                  {mod.modification_object && (
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--color-text-muted)",
                        marginTop: "0.25rem",
                      }}
                    >
                      {mod.modification_object}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {contract.anomalies && (
        <section className="ic-section">
          <h2>Anomalies</h2>
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.9rem" }}>
            {contract.anomalies}
          </p>
        </section>
      )}
    </div>
  );
}
