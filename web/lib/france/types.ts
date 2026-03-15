// --- Raw Parquet row ---

export interface DecpParquetRow {
  uid: string;
  id: string;
  acheteur_id: string;
  acheteur_nom: string;
  titulaire_id: string;
  titulaire_typeIdentifiant: string;
  titulaire_denominationSociale: string;
  nature: string;
  objet: string;
  codeCPV: string;
  procedure: string;
  montant: number;
  dureeMois: number;
  dateNotification: string;
  datePublicationDonnees: string;
  lieuExecution_code: string;
  lieuExecution_nom: string;
  offresRecues: number;
  formePrix: string;
  idAccordCadre: string;
  donneesActuelles: boolean;
  anomalies: string;
  objetModification: string;
}

// --- Database row types ---

export interface FranceContract {
  uid: string;
  market_id: string;
  buyer_siret: string;
  buyer_name: string;
  nature: string;
  object: string;
  cpv_code: string;
  cpv_division: string;
  procedure: string;
  amount_ht: number;
  duration_months: number;
  notification_date: string;
  publication_date: string;
  location_code: string;
  location_name: string;
  bids_received: number;
  form_of_price: string;
  framework_id: string;
  anomalies: string;
  synced_at: string;
}

export interface FranceContractVendor {
  contract_uid: string;
  vendor_id: string;
  vendor_name: string;
}

export interface FranceVendor {
  id: string;
  id_type: string;
  name: string;
  siret: string | null;
  siren: string | null;
  contract_count: number;
  total_amount_ht: number;
  first_seen: string;
  last_seen: string;
  sirene_enriched: boolean;
  synced_at: string;
}

export interface FranceBuyer {
  siret: string;
  name: string;
  contract_count: number;
  total_amount_ht: number;
  first_seen: string;
  last_seen: string;
  synced_at: string;
}

export interface FranceModification {
  id: string;
  contract_uid: string;
  modification_object: string;
  new_amount_ht: number | null;
  new_duration_months: number | null;
  new_vendor_id: string | null;
  new_vendor_name: string | null;
  publication_date: string;
  source_hash: string;
  synced_at: string;
}

export interface FranceSyncMeta {
  id: number;
  last_modified: number | null;
  content_length: number | null;
  rows_processed: number | null;
  rows_inserted: number | null;
  rows_updated: number | null;
  last_sync_at: string | null;
}

// --- Dashboard / query result types ---

export interface SpendByYear {
  year: number;
  total_amount: number;
  contract_count: number;
}

export interface TopEntity {
  id: string;
  name: string;
  total_amount: number;
  contract_count: number;
}

export interface ProcedureBreakdown {
  procedure: string;
  total_amount: number;
  contract_count: number;
  pct: number;
}

export interface DashboardSummary {
  total_contracts: number;
  total_spend: number;
  unique_vendors: number;
  unique_buyers: number;
  avg_bids: number;
}
