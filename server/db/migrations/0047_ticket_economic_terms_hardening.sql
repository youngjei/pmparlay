-- This release changes settlement economics. Keep ticket reads and money moves
-- outside the short pre-beta backfill transaction so claims cannot outrun quarantine.
LOCK TABLE tickets IN ACCESS EXCLUSIVE MODE;

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_offered_payout_covers_stake_check;

ALTER TABLE quotes
  ADD CONSTRAINT quotes_offered_payout_covers_stake_check
  CHECK (status = 'rejected' OR offered_payout_micro_usd >= stake_micro_usd)
  NOT VALID;

COMMENT ON CONSTRAINT quotes_offered_payout_covers_stake_check ON quotes IS
  'New usable quotes cannot return less than stake. Historical rows are remediated before this constraint is validated.';

ALTER TABLE ticket_legs
  ADD COLUMN IF NOT EXISTS accepted_price_bps INTEGER;

UPDATE ticket_legs
SET accepted_price_bps = quote_legs.quoted_price_bps
FROM quote_legs
WHERE quote_legs.id = ticket_legs.quote_leg_id
  AND ticket_legs.accepted_price_bps IS NULL;

ALTER TABLE ticket_legs
  ALTER COLUMN accepted_price_bps SET NOT NULL;

ALTER TABLE ticket_legs
  DROP CONSTRAINT IF EXISTS ticket_legs_accepted_price_bps_check;

ALTER TABLE ticket_legs
  ADD CONSTRAINT ticket_legs_accepted_price_bps_check
  CHECK (accepted_price_bps >= 0 AND accepted_price_bps <= 10000);

CREATE OR REPLACE FUNCTION freeze_ticket_leg_accepted_price()
RETURNS trigger AS $$
DECLARE
  source_price_bps INTEGER;
  source_quote_id UUID;
  ticket_quote_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ticket_leg_economic_identity_immutable:%', OLD.id;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
    OR NEW.quote_leg_id IS DISTINCT FROM OLD.quote_leg_id
    OR NEW.accepted_price_bps IS DISTINCT FROM OLD.accepted_price_bps
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'ticket_leg_economic_identity_immutable:%', OLD.id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT quoted_price_bps, quote_id
    INTO source_price_bps, source_quote_id
    FROM quote_legs
    WHERE id = NEW.quote_leg_id;

    SELECT quote_id
    INTO ticket_quote_id
    FROM tickets
    WHERE id = NEW.ticket_id;

    IF source_price_bps IS NULL
      OR source_quote_id IS DISTINCT FROM ticket_quote_id
      OR (NEW.accepted_price_bps IS NOT NULL AND NEW.accepted_price_bps IS DISTINCT FROM source_price_bps)
    THEN
      RAISE EXCEPTION 'ticket_leg_accepted_terms_invalid:%', NEW.id;
    END IF;

    NEW.accepted_price_bps := source_price_bps;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_legs_accepted_price_freeze ON ticket_legs;
CREATE TRIGGER ticket_legs_accepted_price_freeze
BEFORE INSERT OR UPDATE OR DELETE ON ticket_legs
FOR EACH ROW
EXECUTE FUNCTION freeze_ticket_leg_accepted_price();

CREATE OR REPLACE FUNCTION prevent_ticket_economic_identity_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ticket_economic_identity_immutable:%', OLD.id;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
    OR NEW.accounting_mode IS DISTINCT FROM OLD.accounting_mode
    OR NEW.funding_currency IS DISTINCT FROM OLD.funding_currency
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'ticket_economic_identity_immutable:%', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tickets_economic_identity_immutable_trigger ON tickets;
CREATE TRIGGER tickets_economic_identity_immutable_trigger
BEFORE UPDATE OR DELETE ON tickets
FOR EACH ROW
EXECUTE FUNCTION prevent_ticket_economic_identity_mutation();

CREATE OR REPLACE FUNCTION prevent_accepted_quote_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'accepted'
    OR EXISTS (SELECT 1 FROM tickets WHERE quote_id = OLD.id)
  THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.stake_micro_usd IS DISTINCT FROM OLD.stake_micro_usd
      OR NEW.operation_fee_micro_usd IS DISTINCT FROM OLD.operation_fee_micro_usd
      OR NEW.spread_bps IS DISTINCT FROM OLD.spread_bps
      OR NEW.implied_probability_bps IS DISTINCT FROM OLD.implied_probability_bps
      OR NEW.offered_payout_micro_usd IS DISTINCT FROM OLD.offered_payout_micro_usd
      OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
    THEN
      RAISE EXCEPTION 'accepted_quote_economic_terms_immutable:%', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accepted_quotes_immutable_trigger ON quotes;
CREATE TRIGGER accepted_quotes_immutable_trigger
BEFORE UPDATE ON quotes
FOR EACH ROW
EXECUTE FUNCTION prevent_accepted_quote_mutation();

CREATE OR REPLACE FUNCTION prevent_accepted_quote_leg_mutation()
RETURNS trigger AS $$
DECLARE
  target_quote_id UUID := COALESCE(OLD.quote_id, NEW.quote_id);
BEGIN
  IF EXISTS (
    SELECT 1
    FROM quotes
    WHERE id = target_quote_id
      AND status = 'accepted'
  ) OR EXISTS (
    SELECT 1
    FROM ticket_legs
    WHERE quote_leg_id = OLD.id
  )
  THEN
    RAISE EXCEPTION 'accepted_quote_leg_immutable:%', OLD.id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accepted_quote_legs_immutable_trigger ON quote_legs;
CREATE TRIGGER accepted_quote_legs_immutable_trigger
BEFORE UPDATE OR DELETE ON quote_legs
FOR EACH ROW
EXECUTE FUNCTION prevent_accepted_quote_leg_mutation();

CREATE OR REPLACE FUNCTION prevent_ticket_reserve_economic_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ticket_reserve_economic_terms_immutable:%', OLD.id;
  END IF;

  IF NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.accounting_mode IS DISTINCT FROM OLD.accounting_mode
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.stake_micro_units IS DISTINCT FROM OLD.stake_micro_units
    OR NEW.operation_fee_micro_units IS DISTINCT FROM OLD.operation_fee_micro_units
    OR NEW.offered_payout_micro_units IS DISTINCT FROM OLD.offered_payout_micro_units
    OR NEW.net_liability_micro_units IS DISTINCT FROM OLD.net_liability_micro_units
    OR NEW.purchase_transaction_id IS DISTINCT FROM OLD.purchase_transaction_id
    OR NEW.reserve_transaction_id IS DISTINCT FROM OLD.reserve_transaction_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'ticket_reserve_economic_terms_immutable:%', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_reserves_economic_terms_immutable_trigger ON ticket_reserves;
CREATE TRIGGER ticket_reserves_economic_terms_immutable_trigger
BEFORE UPDATE OR DELETE ON ticket_reserves
FOR EACH ROW
EXECUTE FUNCTION prevent_ticket_reserve_economic_mutation();

WITH legacy_void_tickets AS (
  SELECT
    tickets.id AS ticket_id,
    tickets.status AS ticket_status,
    count(DISTINCT ticket_legs.id) FILTER (WHERE ticket_legs.status = 'voided') AS voided_leg_status_count,
    count(DISTINCT settlements.id) FILTER (WHERE settlements.result = 'voided') AS void_settlement_count,
    count(DISTINCT settlements.id) FILTER (
      WHERE settlements.source = 'legwork_void_policy'
        AND settlements.proof_reference = 'whole_ticket_void_precedence'
    ) AS synthetic_settlement_count
  FROM tickets
  JOIN ticket_legs ON ticket_legs.ticket_id = tickets.id
  LEFT JOIN settlements ON settlements.ticket_leg_id = ticket_legs.id
  WHERE NOT EXISTS (
    SELECT 1
    FROM ticket_settlement_summaries
    WHERE ticket_settlement_summaries.ticket_id = tickets.id
  )
  GROUP BY tickets.id
  HAVING count(DISTINCT ticket_legs.id) FILTER (WHERE ticket_legs.status = 'voided') > 0
    OR count(DISTINCT settlements.id) FILTER (WHERE settlements.result = 'voided') > 0
)
INSERT INTO ticket_settlement_policy_quarantines (ticket_id, reason, evidence)
SELECT
  ticket_id,
  'legacy_void_policy_requires_reconciliation',
  jsonb_build_object(
    'ticketStatus', ticket_status,
    'voidedLegStatusCount', voided_leg_status_count,
    'voidSettlementCount', void_settlement_count,
    'syntheticSettlementCount', synthetic_settlement_count,
    'requiresSupervisedReconciliation', true
  )
FROM legacy_void_tickets
ON CONFLICT (ticket_id) DO UPDATE
SET
  reason = EXCLUDED.reason,
  evidence = ticket_settlement_policy_quarantines.evidence || EXCLUDED.evidence
WHERE ticket_settlement_policy_quarantines.resolved_at IS NULL;

INSERT INTO ticket_settlement_policy_quarantines (ticket_id, reason, evidence)
SELECT
  tickets.id,
  'legacy_ticket_financial_terms_missing',
  jsonb_build_object(
    'ticketStatus', tickets.status,
    'ticketReserveMissing', true,
    'requiresSupervisedReconciliation', true
  )
FROM tickets
LEFT JOIN ticket_reserves ON ticket_reserves.ticket_id = tickets.id
WHERE ticket_reserves.id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM ticket_settlement_summaries
    WHERE ticket_settlement_summaries.ticket_id = tickets.id
  )
ON CONFLICT (ticket_id) DO UPDATE
SET
  reason = EXCLUDED.reason,
  evidence = ticket_settlement_policy_quarantines.evidence || EXCLUDED.evidence
WHERE ticket_settlement_policy_quarantines.resolved_at IS NULL;
