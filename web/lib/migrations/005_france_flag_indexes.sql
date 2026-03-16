-- Indexes for flag queries (single-bid, no-competition, amendment inflation)

CREATE INDEX IF NOT EXISTS france_contracts_bids_received_idx
  ON france_contracts (bids_received);

-- Composite index for the common filter pattern: sane amount + buyer
CREATE INDEX IF NOT EXISTS france_contracts_buyer_amount_idx
  ON france_contracts (buyer_siret, amount_ht)
  WHERE amount_ht > 0 AND amount_ht < 999999999;

-- Modification lookups by contract + date (for DISTINCT ON queries)
CREATE INDEX IF NOT EXISTS france_modifications_contract_pub_idx
  ON france_modifications (contract_uid, publication_date DESC NULLS LAST);
