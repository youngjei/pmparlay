CREATE OR REPLACE FUNCTION enforce_onchain_transfer_claim_references()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM onchain_deposits deposits
    WHERE deposits.credited_transaction_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM onchain_transfer_claims claims
        WHERE claims.claim_type = 'user_deposit'
          AND claims.onchain_deposit_id = deposits.id
          AND claims.chain_id = deposits.chain_id
          AND claims.tx_hash = deposits.tx_hash
          AND claims.log_index = deposits.log_index
      )
  ) THEN
    RAISE EXCEPTION 'onchain_transfer_claim_missing_user_deposit_claim';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM house_funding_evidence evidence
    WHERE NOT EXISTS (
      SELECT 1
      FROM onchain_transfer_claims claims
      WHERE claims.claim_type = 'house_funding'
        AND claims.house_funding_evidence_id = evidence.id
        AND claims.chain_id = evidence.chain_id
        AND claims.tx_hash = evidence.tx_hash
        AND claims.log_index = evidence.log_index
    )
  ) THEN
    RAISE EXCEPTION 'onchain_transfer_claim_missing_house_funding_claim';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS onchain_deposits_transfer_claim_constraint_trigger
  ON onchain_deposits;

CREATE CONSTRAINT TRIGGER onchain_deposits_transfer_claim_constraint_trigger
AFTER INSERT OR UPDATE OR DELETE ON onchain_deposits
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_onchain_transfer_claim_references();

DROP TRIGGER IF EXISTS house_funding_evidence_transfer_claim_constraint_trigger
  ON house_funding_evidence;

CREATE CONSTRAINT TRIGGER house_funding_evidence_transfer_claim_constraint_trigger
AFTER INSERT OR UPDATE OR DELETE ON house_funding_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_onchain_transfer_claim_references();

DROP TRIGGER IF EXISTS onchain_transfer_claims_reference_constraint_trigger
  ON onchain_transfer_claims;

CREATE CONSTRAINT TRIGGER onchain_transfer_claims_reference_constraint_trigger
AFTER INSERT OR UPDATE OR DELETE ON onchain_transfer_claims
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_onchain_transfer_claim_references();
