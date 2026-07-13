ALTER TABLE ticket_legs
  ADD COLUMN IF NOT EXISTS resolution_state TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS resolution_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_resolution_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS resolution_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_resolution_error TEXT;

ALTER TABLE ticket_legs
  DROP CONSTRAINT IF EXISTS ticket_legs_resolution_state_check;

ALTER TABLE ticket_legs
  ADD CONSTRAINT ticket_legs_resolution_state_check
  CHECK (
    resolution_state IN (
      'pending',
      'resolution_candidate',
      'awaiting_oracle',
      'disputed',
      'resolved_won',
      'resolved_lost',
      'resolved_void',
      'resolved_partial',
      'settlement_blocked'
    )
  );

CREATE INDEX IF NOT EXISTS ticket_legs_resolution_due_idx
  ON ticket_legs (next_resolution_check_at, resolution_state, status);

CREATE TABLE IF NOT EXISTS settlement_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_leg_id UUID NOT NULL REFERENCES ticket_legs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  proof_kind TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('pending', 'won', 'lost', 'voided', 'partial', 'disputed', 'blocked')),
  confidence TEXT NOT NULL CHECK (confidence IN ('api_signal', 'onchain_confirmed', 'manual_override')),
  condition_id TEXT,
  token_id TEXT,
  winning_token_id TEXT,
  payout_numerator NUMERIC,
  payout_denominator NUMERIC,
  block_number BIGINT,
  tx_hash TEXT,
  resolved_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_leg_id, source, proof_kind)
);

CREATE INDEX IF NOT EXISTS settlement_proofs_leg_created_idx
  ON settlement_proofs (ticket_leg_id, created_at DESC);
