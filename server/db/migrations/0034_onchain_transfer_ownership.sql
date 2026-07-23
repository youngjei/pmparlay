ALTER TABLE house_funding_evidence
  ADD CONSTRAINT house_funding_evidence_identity_check
  CHECK ((
    tx_hash ~ '^0x[a-f0-9]{64}$'
    AND block_hash ~ '^0x[a-f0-9]{64}$'
    AND from_address ~ '^0x[a-f0-9]{40}$'
    AND to_address ~ '^0x[a-f0-9]{40}$'
    AND token_address ~ '^0x[a-f0-9]{40}$'
    AND from_address <> to_address
    AND length(operator_id) BETWEEN 3 AND 200
    AND length(approver_id) BETWEEN 3 AND 200
    AND length(reason) BETWEEN 3 AND 1000
    AND lower(operator_id) <> lower(approver_id)
  ) IS TRUE) NOT VALID;

ALTER TABLE house_funding_evidence
  VALIDATE CONSTRAINT house_funding_evidence_identity_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM house_funding_evidence funding
    JOIN onchain_deposits deposits
      ON deposits.chain_id = funding.chain_id
     AND deposits.tx_hash = funding.tx_hash
     AND deposits.log_index = funding.log_index
    WHERE deposits.credited_transaction_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'onchain_transfer_ownership_backfill_conflict';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS onchain_transfer_claims (
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  claim_type TEXT NOT NULL CHECK (claim_type IN ('user_deposit', 'house_funding')),
  onchain_deposit_id UUID REFERENCES onchain_deposits(id),
  house_funding_evidence_id UUID REFERENCES house_funding_evidence(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, tx_hash, log_index),
  UNIQUE (onchain_deposit_id),
  UNIQUE (house_funding_evidence_id),
  CHECK (tx_hash ~ '^0x[a-f0-9]{64}$'),
  CHECK ((
    claim_type = 'user_deposit'
    AND onchain_deposit_id IS NOT NULL
    AND house_funding_evidence_id IS NULL
  ) OR (
    claim_type = 'house_funding'
    AND onchain_deposit_id IS NULL
    AND house_funding_evidence_id IS NOT NULL
  ))
);

INSERT INTO onchain_transfer_claims (
  chain_id,
  tx_hash,
  log_index,
  claim_type,
  onchain_deposit_id
)
SELECT
  chain_id,
  tx_hash,
  log_index,
  'user_deposit',
  id
FROM onchain_deposits
WHERE credited_transaction_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO onchain_transfer_claims (
  chain_id,
  tx_hash,
  log_index,
  claim_type,
  house_funding_evidence_id
)
SELECT
  chain_id,
  tx_hash,
  log_index,
  'house_funding',
  id
FROM house_funding_evidence
ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS onchain_transfer_claims_append_only_trigger
  ON onchain_transfer_claims;

CREATE TRIGGER onchain_transfer_claims_append_only_trigger
BEFORE UPDATE OR DELETE ON onchain_transfer_claims
FOR EACH ROW
EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TABLE IF NOT EXISTS house_funding_reorgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  house_funding_evidence_id UUID NOT NULL UNIQUE REFERENCES house_funding_evidence(id),
  compensation_transaction_id UUID NOT NULL UNIQUE,
  incident_id UUID NOT NULL UNIQUE REFERENCES financial_incidents(id),
  reason TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS house_funding_reorgs_append_only_trigger
  ON house_funding_reorgs;

CREATE TRIGGER house_funding_reorgs_append_only_trigger
BEFORE UPDATE OR DELETE ON house_funding_reorgs
FOR EACH ROW
EXECUTE FUNCTION prevent_append_only_mutation();
