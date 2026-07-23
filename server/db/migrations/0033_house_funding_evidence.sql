CREATE TABLE IF NOT EXISTS house_funding_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  amount_micro_units BIGINT NOT NULL CHECK (amount_micro_units > 0),
  confirmations INTEGER NOT NULL CHECK (confirmations > 0),
  ledger_transaction_id UUID NOT NULL UNIQUE,
  operator_id TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index),
  CHECK (operator_id <> approver_id)
);

CREATE INDEX IF NOT EXISTS house_funding_evidence_block_idx
  ON house_funding_evidence (chain_id, block_number DESC);

CREATE OR REPLACE FUNCTION prevent_house_funding_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'house_funding_evidence_is_append_only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS house_funding_evidence_append_only_trigger
  ON house_funding_evidence;

CREATE TRIGGER house_funding_evidence_append_only_trigger
BEFORE UPDATE OR DELETE ON house_funding_evidence
FOR EACH ROW
EXECUTE FUNCTION prevent_house_funding_evidence_mutation();
