CREATE TABLE IF NOT EXISTS settlement_identity_quarantines (
  ticket_leg_id UUID PRIMARY KEY REFERENCES ticket_legs(id),
  ticket_id UUID NOT NULL REFERENCES tickets(id),
  reason TEXT NOT NULL,
  identity_snapshot JSONB NOT NULL,
  first_quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  quarantine_count INTEGER NOT NULL DEFAULT 1,
  retryable BOOLEAN NOT NULL DEFAULT false,
  next_retry_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

ALTER TABLE settlement_identity_quarantines
  ADD COLUMN IF NOT EXISTS retryable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS settlement_identity_quarantines_retry_schedule_idx
  ON settlement_identity_quarantines (retryable, next_retry_at, ticket_id)
  WHERE resolved_at IS NULL;

ALTER TABLE ticket_legs
  ADD COLUMN IF NOT EXISTS settlement_identity_validation_proof_id UUID REFERENCES settlement_proofs(id),
  ADD COLUMN IF NOT EXISTS settlement_identity_validation_block_number NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS settlement_identity_validation_block_hash TEXT;

-- A prior deployment may have installed the old condition-id constraint.
-- Remove it before resetting unsafe legacy candidates for explicit backfill.
ALTER TABLE ticket_legs
  DROP CONSTRAINT IF EXISTS ticket_legs_settlement_identity_check,
  DROP CONSTRAINT IF EXISTS ticket_legs_settlement_outcome_index_check,
  DROP CONSTRAINT IF EXISTS ticket_legs_settlement_payout_slot_count_check;

ALTER TABLE ticket_legs
  ALTER COLUMN settlement_identity_raw DROP DEFAULT;

WITH unsafe_frozen_legs AS (
  SELECT ticket_legs.id, ticket_legs.ticket_id, to_jsonb(ticket_legs) AS identity_snapshot
  FROM ticket_legs
  WHERE settlement_frozen_at IS NOT NULL
    AND (
      settlement_source IS DISTINCT FROM 'polymarket_ctf'
      OR settlement_chain_id IS DISTINCT FROM 137
      OR settlement_contract_address IS NULL
      OR settlement_collateral_address IS NULL
      OR settlement_condition_id IS NULL
      OR settlement_token_id IS NULL
      OR settlement_position_id IS NULL
      OR settlement_collection_id IS NULL
      OR settlement_outcome_index IS NULL
      OR settlement_payout_slot_count IS NULL
      OR settlement_payout_slot_count <= 0
      OR settlement_question IS NULL
      OR settlement_outcome IS NULL
      OR settlement_source_market_id IS NULL
      OR settlement_source_snapshot_id IS NULL
      OR settlement_rules_snapshot_hash IS NULL
      OR settlement_identity_raw IS NULL
      OR settlement_identity_validation_proof_id IS NULL
      OR settlement_identity_validation_block_number IS NULL
      OR settlement_identity_validation_block_hash IS NULL
    )
)
INSERT INTO settlement_identity_quarantines (
  ticket_leg_id,
  ticket_id,
  reason,
  identity_snapshot,
  retryable,
  next_retry_at,
  resolved_at
)
SELECT
  id,
  ticket_id,
  'legacy_frozen_settlement_identity_incomplete',
  identity_snapshot,
  true,
  now(),
  NULL
FROM unsafe_frozen_legs
ON CONFLICT (ticket_leg_id) DO UPDATE
SET
  reason = EXCLUDED.reason,
  identity_snapshot = EXCLUDED.identity_snapshot,
  last_quarantined_at = now(),
  quarantine_count = settlement_identity_quarantines.quarantine_count + 1,
  retryable = true,
  next_retry_at = now(),
  resolved_at = NULL;

-- The original values remain in settlement_identity_quarantines. Clearing the
-- candidate is intentional: it permits only the explicit CTF backfill path to
-- construct and validate a replacement before a new freeze.
WITH unsafe_frozen_legs AS (
  SELECT id
  FROM ticket_legs
  WHERE settlement_frozen_at IS NOT NULL
    AND (
      settlement_source IS DISTINCT FROM 'polymarket_ctf'
      OR settlement_chain_id IS DISTINCT FROM 137
      OR settlement_contract_address IS NULL
      OR settlement_collateral_address IS NULL
      OR settlement_condition_id IS NULL
      OR settlement_token_id IS NULL
      OR settlement_position_id IS NULL
      OR settlement_collection_id IS NULL
      OR settlement_outcome_index IS NULL
      OR settlement_payout_slot_count IS NULL
      OR settlement_payout_slot_count <= 0
      OR settlement_question IS NULL
      OR settlement_outcome IS NULL
      OR settlement_source_market_id IS NULL
      OR settlement_source_snapshot_id IS NULL
      OR settlement_rules_snapshot_hash IS NULL
      OR settlement_identity_raw IS NULL
      OR settlement_identity_validation_proof_id IS NULL
      OR settlement_identity_validation_block_number IS NULL
      OR settlement_identity_validation_block_hash IS NULL
    )
)
UPDATE ticket_legs
SET
  settlement_source = NULL,
  settlement_chain_id = NULL,
  settlement_contract_address = NULL,
  settlement_collateral_address = NULL,
  settlement_condition_id = NULL,
  settlement_token_id = NULL,
  settlement_outcome_index = NULL,
  settlement_payout_slot_count = NULL,
  settlement_question_id = NULL,
  settlement_uma_adapter = NULL,
  settlement_uma_adapter_version = NULL,
  settlement_event_id = NULL,
  settlement_neg_risk_group_id = NULL,
  settlement_rules_snapshot_hash = NULL,
  settlement_source_snapshot_id = NULL,
  settlement_neg_risk = NULL,
  settlement_question = NULL,
  settlement_outcome = NULL,
  settlement_source_market_id = NULL,
  settlement_position_id = NULL,
  settlement_collection_id = NULL,
  settlement_identity_validation_proof_id = NULL,
  settlement_identity_validation_block_number = NULL,
  settlement_identity_validation_block_hash = NULL,
  settlement_frozen_at = NULL,
  resolution_state = 'settlement_blocked',
  resolution_updated_at = now(),
  last_resolution_error = 'legacy_frozen_settlement_identity_quarantined',
  next_resolution_check_at = now() + interval '1 hour'
WHERE id IN (SELECT id FROM unsafe_frozen_legs);

ALTER TABLE ticket_legs
  ADD CONSTRAINT ticket_legs_frozen_settlement_identity_check
  CHECK (
    settlement_frozen_at IS NULL
    OR (
      settlement_source = 'polymarket_ctf'
      AND settlement_chain_id = 137
      AND settlement_contract_address IS NOT NULL
      AND settlement_collateral_address IS NOT NULL
      AND settlement_condition_id IS NOT NULL
      AND settlement_token_id IS NOT NULL
      AND settlement_position_id IS NOT NULL
      AND settlement_collection_id IS NOT NULL
      AND settlement_outcome_index IS NOT NULL
      AND settlement_payout_slot_count IS NOT NULL
      AND settlement_payout_slot_count > 0
      AND settlement_outcome_index >= 0
      AND settlement_outcome_index < settlement_payout_slot_count
      AND settlement_question IS NOT NULL
      AND settlement_outcome IS NOT NULL
      AND settlement_source_market_id IS NOT NULL
      AND settlement_source_snapshot_id IS NOT NULL
      AND settlement_rules_snapshot_hash IS NOT NULL
      AND settlement_identity_raw IS NOT NULL
      AND settlement_identity_validation_proof_id IS NOT NULL
      AND settlement_identity_validation_block_number IS NOT NULL
      AND settlement_identity_validation_block_number > 0
      AND settlement_identity_validation_block_hash ~ '^0x[0-9a-fA-F]{64}$'
    )
  ) NOT VALID;

ALTER TABLE ticket_legs
  VALIDATE CONSTRAINT ticket_legs_frozen_settlement_identity_check;

CREATE OR REPLACE FUNCTION enforce_frozen_ticket_leg_validation_provenance()
RETURNS trigger AS $$
DECLARE
  validation_proof_matches BOOLEAN;
BEGIN
  IF NEW.settlement_frozen_at IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM settlement_proofs
      WHERE settlement_proofs.id = NEW.settlement_identity_validation_proof_id
        AND settlement_proofs.ticket_leg_id = NEW.id
        AND settlement_proofs.source = 'legwork_settlement_identity'
        AND settlement_proofs.proof_kind = 'ctf_position_id_validation'
        AND settlement_proofs.result = 'pending'
        AND settlement_proofs.confidence = 'onchain_confirmed'
        AND settlement_proofs.chain_id = NEW.settlement_chain_id
        AND lower(settlement_proofs.contract_address) = lower(NEW.settlement_contract_address)
        AND lower(settlement_proofs.collateral_address) = lower(NEW.settlement_collateral_address)
        AND lower(settlement_proofs.condition_id) = lower(NEW.settlement_condition_id)
        AND settlement_proofs.token_id = NEW.settlement_token_id
        AND settlement_proofs.outcome_index = NEW.settlement_outcome_index
        AND settlement_proofs.block_number::NUMERIC = NEW.settlement_identity_validation_block_number
        AND lower(settlement_proofs.block_hash) = lower(NEW.settlement_identity_validation_block_hash)
        AND jsonb_typeof(settlement_proofs.provider_evidence) = 'array'
        AND jsonb_array_length(settlement_proofs.provider_evidence) > 0
    ) INTO validation_proof_matches;

    IF NOT validation_proof_matches THEN
      RAISE EXCEPTION 'frozen_ticket_leg_validation_provenance_invalid:%', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_legs_frozen_validation_provenance ON ticket_legs;
CREATE TRIGGER ticket_legs_frozen_validation_provenance
BEFORE INSERT OR UPDATE ON ticket_legs
FOR EACH ROW
EXECUTE FUNCTION enforce_frozen_ticket_leg_validation_provenance();

CREATE OR REPLACE FUNCTION prevent_frozen_ticket_leg_identity_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.settlement_frozen_at IS NOT NULL
    AND (
      NEW.settlement_source IS DISTINCT FROM OLD.settlement_source
      OR NEW.settlement_chain_id IS DISTINCT FROM OLD.settlement_chain_id
      OR NEW.settlement_contract_address IS DISTINCT FROM OLD.settlement_contract_address
      OR NEW.settlement_collateral_address IS DISTINCT FROM OLD.settlement_collateral_address
      OR NEW.settlement_condition_id IS DISTINCT FROM OLD.settlement_condition_id
      OR NEW.settlement_token_id IS DISTINCT FROM OLD.settlement_token_id
      OR NEW.settlement_outcome_index IS DISTINCT FROM OLD.settlement_outcome_index
      OR NEW.settlement_payout_slot_count IS DISTINCT FROM OLD.settlement_payout_slot_count
      OR NEW.settlement_question_id IS DISTINCT FROM OLD.settlement_question_id
      OR NEW.settlement_uma_adapter IS DISTINCT FROM OLD.settlement_uma_adapter
      OR NEW.settlement_uma_adapter_version IS DISTINCT FROM OLD.settlement_uma_adapter_version
      OR NEW.settlement_event_id IS DISTINCT FROM OLD.settlement_event_id
      OR NEW.settlement_neg_risk_group_id IS DISTINCT FROM OLD.settlement_neg_risk_group_id
      OR NEW.settlement_rules_snapshot_hash IS DISTINCT FROM OLD.settlement_rules_snapshot_hash
      OR NEW.settlement_source_snapshot_id IS DISTINCT FROM OLD.settlement_source_snapshot_id
      OR NEW.settlement_neg_risk IS DISTINCT FROM OLD.settlement_neg_risk
      OR NEW.settlement_question IS DISTINCT FROM OLD.settlement_question
      OR NEW.settlement_outcome IS DISTINCT FROM OLD.settlement_outcome
      OR NEW.settlement_source_market_id IS DISTINCT FROM OLD.settlement_source_market_id
      OR NEW.settlement_position_id IS DISTINCT FROM OLD.settlement_position_id
      OR NEW.settlement_collection_id IS DISTINCT FROM OLD.settlement_collection_id
      OR NEW.settlement_identity_raw IS DISTINCT FROM OLD.settlement_identity_raw
      OR NEW.settlement_identity_validation_proof_id IS DISTINCT FROM OLD.settlement_identity_validation_proof_id
      OR NEW.settlement_identity_validation_block_number IS DISTINCT FROM OLD.settlement_identity_validation_block_number
      OR NEW.settlement_identity_validation_block_hash IS DISTINCT FROM OLD.settlement_identity_validation_block_hash
      OR NEW.settlement_frozen_at IS DISTINCT FROM OLD.settlement_frozen_at
    )
  THEN
    RAISE EXCEPTION 'frozen_ticket_leg_settlement_identity_immutable:%', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_legs_frozen_settlement_identity_immutable ON ticket_legs;
CREATE TRIGGER ticket_legs_frozen_settlement_identity_immutable
BEFORE UPDATE ON ticket_legs
FOR EACH ROW
EXECUTE FUNCTION prevent_frozen_ticket_leg_identity_mutation();
