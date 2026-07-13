ALTER TABLE settlement_proofs
  DROP CONSTRAINT IF EXISTS settlement_proofs_ticket_leg_id_source_proof_kind_key;

CREATE INDEX IF NOT EXISTS settlement_proofs_leg_source_kind_checked_idx
  ON settlement_proofs (ticket_leg_id, source, proof_kind, checked_at DESC);

DROP INDEX IF EXISTS ticket_legs_resolution_due_idx;

CREATE INDEX IF NOT EXISTS ticket_legs_resolution_due_idx
  ON ticket_legs (status, next_resolution_check_at, created_at);
