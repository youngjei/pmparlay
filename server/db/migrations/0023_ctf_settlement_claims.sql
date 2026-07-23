ALTER TABLE ticket_legs
  ADD COLUMN IF NOT EXISTS settlement_source TEXT,
  ADD COLUMN IF NOT EXISTS settlement_chain_id INTEGER,
  ADD COLUMN IF NOT EXISTS settlement_contract_address TEXT,
  ADD COLUMN IF NOT EXISTS settlement_collateral_address TEXT,
  ADD COLUMN IF NOT EXISTS settlement_condition_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_token_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_outcome_index INTEGER,
  ADD COLUMN IF NOT EXISTS settlement_payout_slot_count INTEGER,
  ADD COLUMN IF NOT EXISTS settlement_question_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_uma_adapter TEXT,
  ADD COLUMN IF NOT EXISTS settlement_uma_adapter_version TEXT,
  ADD COLUMN IF NOT EXISTS settlement_event_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_neg_risk_group_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_rules_snapshot_hash TEXT,
  ADD COLUMN IF NOT EXISTS settlement_source_snapshot_id UUID REFERENCES market_snapshots(id),
  ADD COLUMN IF NOT EXISTS settlement_neg_risk BOOLEAN,
  ADD COLUMN IF NOT EXISTS settlement_frozen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settlement_identity_raw JSONB;

-- Legacy tickets can be partially populated. Settlement identity constraints
-- are installed only after 0028 quarantines unsafe rows; do not manufacture
-- defaults for a financial identity during schema migration.

CREATE INDEX IF NOT EXISTS ticket_legs_settlement_identity_idx
  ON ticket_legs (
    settlement_chain_id,
    settlement_contract_address,
    settlement_collateral_address,
    settlement_condition_id,
    settlement_outcome_index
  )
  WHERE settlement_condition_id IS NOT NULL;

ALTER TABLE settlement_proofs
  ADD COLUMN IF NOT EXISTS chain_id INTEGER,
  ADD COLUMN IF NOT EXISTS contract_address TEXT,
  ADD COLUMN IF NOT EXISTS collateral_address TEXT,
  ADD COLUMN IF NOT EXISTS outcome_index INTEGER,
  ADD COLUMN IF NOT EXISTS payout_vector NUMERIC[],
  ADD COLUMN IF NOT EXISTS block_hash TEXT,
  ADD COLUMN IF NOT EXISTS provider_evidence JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS settlement_proofs_ctf_condition_idx
  ON settlement_proofs (
    chain_id,
    contract_address,
    collateral_address,
    condition_id,
    outcome_index,
    checked_at DESC
  )
  WHERE condition_id IS NOT NULL;

ALTER TABLE tickets
  DROP CONSTRAINT IF EXISTS tickets_status_check;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_status_check
  CHECK (status IN ('accepted', 'live', 'won', 'lost', 'voided', 'claimable', 'paid'));

CREATE TABLE IF NOT EXISTS settlement_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  amount_micro_units BIGINT NOT NULL CHECK (amount_micro_units > 0),
  currency TEXT NOT NULL,
  ledger_transaction_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS settlement_claims_user_created_idx
  ON settlement_claims (user_id, created_at DESC);
