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
    <div className="fr-page">
      <header className="fr-page-header">
        <h1>{contract.object || "Contract Detail"}</h1>
        <p>
          <Link href={`/france/buyers/${encodeURIComponent(contract.buyer_siret)}`}>
            {contract.buyer_name}
          </Link>
          {contract.amount_ht != null && (
            <> &mdash; {formatEuro(contract.amount_ht)}</>
          )}
        </p>
      </header>

      <section className="fr-section">
        <h2 className="fr-section-title">Contract Details</h2>
        <div className="fr-detail-grid">
          {fields.map((field) => (
            <div key={field.label} className="fr-detail-card">
              <div className="fr-detail-label">{field.label}</div>
              <div className="fr-detail-value">{field.value}</div>
            </div>
          ))}
        </div>
      </section>

      {vendors.length > 0 && (
        <section className="fr-section">
          <h2 className="fr-section-title">Vendors</h2>
          <div className="fr-tag-list">
            {vendors.map((v) => (
              <Link
                key={v.vendor_id}
                href={`/france/vendors/${encodeURIComponent(v.vendor_id)}`}
                className="fr-tag"
              >
                {v.vendor_name}
              </Link>
            ))}
          </div>
        </section>
      )}

      {modifications.length > 0 && (
        <section className="fr-section">
          <h2 className="fr-section-title">Modifications</h2>
          <div className="fr-mod-grid">
            {modifications.map((mod) => {
              const pctChange =
                mod.new_amount_ht != null && contract.amount_ht
                  ? ((mod.new_amount_ht - contract.amount_ht) / contract.amount_ht) * 100
                  : null;

              return (
                <div key={mod.id} className="fr-mod-card">
                  <div className="fr-mod-date">
                    {mod.publication_date
                      ? new Date(mod.publication_date).toLocaleDateString("fr-FR")
                      : "\u2014"}
                  </div>
                  {mod.new_amount_ht != null && (
                    <div className="fr-mod-amount">
                      {formatEuro(mod.new_amount_ht)}
                      {pctChange != null && (
                        <span
                          className={
                            pctChange > 0 ? "fr-mod-change--up" : "fr-mod-change--down"
                          }
                        >
                          {pctChange > 0 ? "+" : ""}
                          {pctChange.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  )}
                  {mod.modification_object && (
                    <div className="fr-mod-desc">{mod.modification_object}</div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {contract.anomalies && (
        <section className="fr-section">
          <h2 className="fr-section-title">Anomalies</h2>
          <p className="fr-text-muted">{contract.anomalies}</p>
        </section>
      )}
    </div>
  );
}
