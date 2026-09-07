CREATE TABLE IF NOT EXISTS ticket_settlement_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  final_status TEXT NOT NULL CHECK (final_status IN ('won', 'lost', 'voided')),
  calculation_version TEXT NOT NULL,
  stake_micro_units BIGINT NOT NULL CHECK (stake_micro_units >= 0),
  original_offered_payout_micro_units BIGINT NOT NULL CHECK (original_offered_payout_micro_units >= 0),
  final_payout_micro_units BIGINT NOT NULL CHECK (final_payout_micro_units >= 0),
  operation_fee_micro_units BIGINT NOT NULL CHECK (operation_fee_micro_units >= 0),
  calculation JSONB NOT NULL,
  ledger_transaction_id UUID,
  reserve_release_transaction_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_settlement_summaries_status_created_idx
  ON ticket_settlement_summaries (final_status, created_at DESC);

DROP TRIGGER IF EXISTS ticket_settlement_summaries_append_only_trigger ON ticket_settlement_summaries;
CREATE TRIGGER ticket_settlement_summaries_append_only_trigger
BEFORE UPDATE OR DELETE ON ticket_settlement_summaries
FOR EACH ROW
EXECUTE FUNCTION prevent_append_only_table_mutation();

CREATE TABLE IF NOT EXISTS ticket_settlement_policy_quarantines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT
);

INSERT INTO ticket_settlement_policy_quarantines (ticket_id, reason, evidence)
SELECT DISTINCT
  ticket_legs.ticket_id,
  'legacy_whole_ticket_void_precedence',
  jsonb_build_object(
    'syntheticSettlementCount', count(*) OVER (PARTITION BY ticket_legs.ticket_id),
    'requiresSupervisedReconciliation', true
  )
FROM settlements
JOIN ticket_legs ON ticket_legs.id = settlements.ticket_leg_id
WHERE settlements.source = 'legwork_void_policy'
  AND settlements.proof_reference = 'whole_ticket_void_precedence'
ON CONFLICT (ticket_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS ticket_settlement_policy_quarantines_unresolved_idx
  ON ticket_settlement_policy_quarantines (created_at)
  WHERE resolved_at IS NULL;
