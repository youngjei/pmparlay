ALTER TABLE ticket_legs
  ADD COLUMN IF NOT EXISTS settlement_authority TEXT;

UPDATE ticket_legs
SET settlement_authority = 'polygon_ctf'
WHERE settlement_authority IS NULL
  AND settlement_source IS NOT NULL;

ALTER TABLE ticket_legs
  DROP CONSTRAINT IF EXISTS ticket_legs_settlement_authority_check,
  DROP CONSTRAINT IF EXISTS ticket_legs_frozen_settlement_identity_check;

ALTER TABLE ticket_legs
  ADD CONSTRAINT ticket_legs_settlement_authority_check
  CHECK (settlement_authority IS NULL OR settlement_authority IN ('polygon_ctf', 'polymarket_api')),
  ADD CONSTRAINT ticket_legs_frozen_settlement_identity_check
  CHECK (
    settlement_frozen_at IS NULL
    OR (
      settlement_source = 'polymarket_ctf'
      AND settlement_authority IN ('polygon_ctf', 'polymarket_api')
      AND settlement_chain_id = 137
      AND settlement_contract_address IS NOT NULL
      AND settlement_collateral_address IS NOT NULL
      AND settlement_condition_id IS NOT NULL
      AND settlement_token_id IS NOT NULL
      AND settlement_position_id = settlement_token_id
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
      AND (
        (
          settlement_authority = 'polygon_ctf'
          AND settlement_collection_id IS NOT NULL
          AND settlement_identity_validation_block_number IS NOT NULL
          AND settlement_identity_validation_block_number > 0
          AND settlement_identity_validation_block_hash ~ '^0x[0-9a-fA-F]{64}$'
        )
        OR (
          settlement_authority = 'polymarket_api'
          AND settlement_collection_id IS NULL
          AND settlement_identity_validation_block_number IS NULL
          AND settlement_identity_validation_block_hash IS NULL
        )
      )
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
    IF NEW.settlement_authority = 'polygon_ctf' THEN
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
    ELSIF NEW.settlement_authority = 'polymarket_api' THEN
      SELECT EXISTS (
        SELECT 1
        FROM settlement_proofs
        WHERE settlement_proofs.id = NEW.settlement_identity_validation_proof_id
          AND settlement_proofs.ticket_leg_id = NEW.id
          AND settlement_proofs.source = 'legwork_settlement_identity'
          AND settlement_proofs.proof_kind = 'polymarket_api_identity_validation'
          AND settlement_proofs.result = 'pending'
          AND settlement_proofs.confidence = 'api_signal'
          AND settlement_proofs.chain_id = NEW.settlement_chain_id
          AND lower(settlement_proofs.contract_address) = lower(NEW.settlement_contract_address)
          AND lower(settlement_proofs.collateral_address) = lower(NEW.settlement_collateral_address)
          AND lower(settlement_proofs.condition_id) = lower(NEW.settlement_condition_id)
          AND settlement_proofs.token_id = NEW.settlement_token_id
          AND settlement_proofs.outcome_index = NEW.settlement_outcome_index
          AND settlement_proofs.block_number IS NULL
          AND settlement_proofs.block_hash IS NULL
          AND jsonb_typeof(settlement_proofs.provider_evidence) = 'array'
          AND jsonb_array_length(settlement_proofs.provider_evidence) >= 2
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(settlement_proofs.provider_evidence) AS evidence
            WHERE evidence->>'provider' = 'gamma' AND evidence->>'status' = 'ok'
          )
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(settlement_proofs.provider_evidence) AS evidence
            WHERE evidence->>'provider' = 'clob' AND evidence->>'status' = 'ok'
          )
          AND settlement_proofs.raw->>'authority' = 'polymarket_api'
          AND NULLIF(settlement_proofs.raw->>'identityFingerprint', '') IS NOT NULL
      ) INTO validation_proof_matches;
    ELSE
      validation_proof_matches := false;
    END IF;

    IF NOT validation_proof_matches THEN
      RAISE EXCEPTION 'frozen_ticket_leg_validation_provenance_invalid:%', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_frozen_ticket_leg_identity_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.settlement_frozen_at IS NOT NULL
    AND (
      NEW.settlement_authority IS DISTINCT FROM OLD.settlement_authority
      OR NEW.settlement_source IS DISTINCT FROM OLD.settlement_source
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
