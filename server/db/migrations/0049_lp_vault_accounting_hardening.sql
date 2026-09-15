CREATE TABLE financial_book_state (
  scope TEXT PRIMARY KEY CHECK (scope = 'global'),
  book_version BIGINT NOT NULL CHECK (book_version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO financial_book_state (scope, book_version)
VALUES ('global', 0)
ON CONFLICT (scope) DO NOTHING;

CREATE OR REPLACE FUNCTION advance_financial_book_version()
RETURNS trigger AS $$
BEGIN
  UPDATE financial_book_state
  SET book_version = book_version + 1,
      updated_at = now()
  WHERE scope = 'global';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_advance_financial_book_trigger
AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
FOR EACH STATEMENT EXECUTE FUNCTION advance_financial_book_version();

CREATE TRIGGER ticket_reserves_advance_financial_book_trigger
AFTER INSERT OR UPDATE OR DELETE ON ticket_reserves
FOR EACH STATEMENT EXECUTE FUNCTION advance_financial_book_version();

CREATE TRIGGER ticket_settlement_summaries_advance_financial_book_trigger
AFTER INSERT OR UPDATE OR DELETE ON ticket_settlement_summaries
FOR EACH STATEMENT EXECUTE FUNCTION advance_financial_book_version();

CREATE TRIGGER quote_payment_exposure_reservations_advance_financial_book_trigger
AFTER INSERT OR UPDATE OR DELETE ON quote_payment_exposure_reservations
FOR EACH STATEMENT EXECUTE FUNCTION advance_financial_book_version();

CREATE TRIGGER withdrawal_requests_advance_financial_book_trigger
AFTER INSERT OR UPDATE OR DELETE ON withdrawal_requests
FOR EACH STATEMENT EXECUTE FUNCTION advance_financial_book_version();

ALTER TABLE financial_reconciliation_snapshots
  ADD COLUMN financial_book_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN financial_state_hash TEXT;

ALTER TABLE financial_reconciliation_snapshots
  ADD CONSTRAINT financial_reconciliation_book_version_check
    CHECK (financial_book_version >= 0),
  ADD CONSTRAINT financial_reconciliation_state_hash_check
    CHECK (financial_state_hash IS NULL OR financial_state_hash ~ '^sha256:[a-f0-9]{64}$');

CREATE INDEX financial_reconciliation_snapshots_accounting_source_idx
  ON financial_reconciliation_snapshots (
    chain_id,
    currency,
    financial_book_version,
    created_at DESC
  )
  WHERE source = 'worker' AND unexplained_delta_micro_units = 0;

ALTER TABLE lp_vault_liability_marks
  ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'on_time',
  ADD COLUMN financial_book_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN financial_state_hash TEXT,
  ADD COLUMN recovery_before_snapshot_id UUID REFERENCES financial_reconciliation_snapshots(id);

ALTER TABLE lp_vault_liability_marks
  ALTER COLUMN source_mode DROP DEFAULT,
  ADD CONSTRAINT lp_vault_liability_mark_source_evidence_check CHECK (
    source_mode IN ('on_time', 'unchanged_state_recovery')
    AND financial_book_version >= 0
    AND (financial_state_hash IS NULL OR financial_state_hash ~ '^sha256:[a-f0-9]{64}$')
    AND (
      (source_mode = 'on_time' AND recovery_before_snapshot_id IS NULL)
      OR (source_mode = 'unchanged_state_recovery' AND recovery_before_snapshot_id IS NOT NULL
        AND financial_state_hash IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION validate_lp_vault_liability_mark()
RETURNS trigger AS $$
DECLARE
  cycle_cutoff DATE;
  expected_senior BIGINT;
  expected_gross BIGINT;
  expected_marked BIGINT;
  expected_protocol_fees BIGINT;
  expected_expenses BIGINT;
  expected_pending_deposits BIGINT;
  expected_matured_payables BIGINT;
  expected_open_ticket_count BIGINT;
  marked_ticket_count BIGINT;
  reconciliation_record financial_reconciliation_snapshots%ROWTYPE;
  recovery_record financial_reconciliation_snapshots%ROWTYPE;
  vault_record lp_vaults%ROWTYPE;
  source_timestamp TIMESTAMPTZ;
  recovery_timestamp TIMESTAMPTZ;
BEGIN
  SELECT cutoff_date INTO cycle_cutoff
  FROM lp_vault_daily_cycles
  WHERE id = NEW.cycle_id AND vault_id = NEW.vault_id;
  IF cycle_cutoff IS NULL THEN RAISE EXCEPTION 'lp_vault_cycle_scope_mismatch'; END IF;

  SELECT * INTO reconciliation_record
  FROM financial_reconciliation_snapshots
  WHERE id = NEW.source_reconciliation_snapshot_id;
  SELECT * INTO vault_record FROM lp_vaults WHERE id = NEW.vault_id;

  IF reconciliation_record.id IS NULL
    OR reconciliation_record.source IS DISTINCT FROM 'worker'
    OR reconciliation_record.currency IS DISTINCT FROM vault_record.currency
    OR reconciliation_record.chain_id IS DISTINCT FROM vault_record.chain_id
    OR lower(reconciliation_record.scope_treasury_address) IS DISTINCT FROM lower(vault_record.treasury_address)
    OR lower(reconciliation_record.scope_token_address) IS DISTINCT FROM lower(vault_record.token_address)
    OR reconciliation_record.observed_block_number IS NULL
    OR reconciliation_record.observed_block_hash IS NULL
    OR reconciliation_record.unexplained_delta_micro_units <> 0
    OR reconciliation_record.created_at > now()
    OR COALESCE(reconciliation_record.metrics->>'observedBlockTimestamp', '') !~ '^[0-9]+$'
  THEN
    RAISE EXCEPTION 'lp_vault_reconciliation_not_canonical';
  END IF;
  source_timestamp := to_timestamp((reconciliation_record.metrics->>'observedBlockTimestamp')::double precision);
  IF source_timestamp > reconciliation_record.created_at
    OR source_timestamp < (cycle_cutoff::timestamp AT TIME ZONE 'UTC')
    OR NEW.financial_book_version IS DISTINCT FROM reconciliation_record.financial_book_version
    OR NEW.financial_state_hash IS DISTINCT FROM reconciliation_record.financial_state_hash
  THEN
    RAISE EXCEPTION 'lp_vault_reconciliation_not_canonical';
  END IF;

  IF NEW.source_mode = 'on_time' THEN
    IF NEW.recovery_before_snapshot_id IS NOT NULL
      OR reconciliation_record.created_at < (cycle_cutoff::timestamp AT TIME ZONE 'UTC')
      OR reconciliation_record.created_at > ((cycle_cutoff::timestamp AT TIME ZONE 'UTC') + interval '5 minutes')
      OR source_timestamp > ((cycle_cutoff::timestamp AT TIME ZONE 'UTC') + interval '5 minutes')
    THEN RAISE EXCEPTION 'lp_vault_reconciliation_not_canonical'; END IF;
  ELSIF NEW.source_mode = 'unchanged_state_recovery' THEN
    SELECT * INTO recovery_record FROM financial_reconciliation_snapshots
    WHERE id = NEW.recovery_before_snapshot_id;
    IF recovery_record.id IS NULL
      OR recovery_record.source IS DISTINCT FROM 'worker'
      OR recovery_record.chain_id IS DISTINCT FROM reconciliation_record.chain_id
      OR recovery_record.currency IS DISTINCT FROM reconciliation_record.currency
      OR lower(recovery_record.scope_treasury_address) IS DISTINCT FROM lower(reconciliation_record.scope_treasury_address)
      OR lower(recovery_record.scope_token_address) IS DISTINCT FROM lower(reconciliation_record.scope_token_address)
      OR recovery_record.unexplained_delta_micro_units <> 0
      OR recovery_record.financial_book_version IS DISTINCT FROM reconciliation_record.financial_book_version
      OR recovery_record.financial_state_hash IS NULL
      OR recovery_record.financial_state_hash IS DISTINCT FROM reconciliation_record.financial_state_hash
      OR COALESCE(recovery_record.metrics->>'observedBlockTimestamp', '') !~ '^[0-9]+$'
    THEN RAISE EXCEPTION 'lp_vault_due_cycle_recovery_unsafe'; END IF;
    recovery_timestamp := to_timestamp((recovery_record.metrics->>'observedBlockTimestamp')::double precision);
    IF recovery_timestamp > (cycle_cutoff::timestamp AT TIME ZONE 'UTC')
      OR recovery_timestamp > recovery_record.created_at
      OR recovery_record.created_at > (cycle_cutoff::timestamp AT TIME ZONE 'UTC')
      OR reconciliation_record.created_at < (cycle_cutoff::timestamp AT TIME ZONE 'UTC')
    THEN RAISE EXCEPTION 'lp_vault_due_cycle_recovery_unsafe'; END IF;
  ELSE
    RAISE EXCEPTION 'lp_vault_liability_mark_source_mode_invalid';
  END IF;

  expected_senior := reconciliation_record.user_available_micro_units
    + reconciliation_record.user_claimable_micro_units
    + reconciliation_record.user_checkout_micro_units
    + reconciliation_record.pending_withdrawal_micro_units;
  SELECT count(*)::BIGINT,COALESCE(sum(gross_payout_micro_units),0)::BIGINT,
    COALESCE(sum(marked_liability_micro_units),0)::BIGINT
  INTO marked_ticket_count,expected_gross,expected_marked
  FROM lp_vault_ticket_liability_marks WHERE cycle_id=NEW.cycle_id;
  SELECT count(*)::BIGINT INTO expected_open_ticket_count
  FROM ticket_reserves reserves
  WHERE reserves.accounting_mode='house_book_usdc' AND reserves.currency='USDC'
    AND reserves.created_at<=reconciliation_record.created_at
    AND NOT EXISTS (SELECT 1 FROM ticket_settlement_summaries summaries
      WHERE summaries.ticket_id=reserves.ticket_id AND summaries.created_at<=reconciliation_record.created_at);
  SELECT COALESCE(sum(CASE WHEN event_type='accrual' THEN amount_micro_units ELSE -amount_micro_units END),0)::BIGINT
  INTO expected_protocol_fees FROM lp_vault_protocol_fee_events
  WHERE vault_id=NEW.vault_id AND effective_at<=reconciliation_record.created_at;
  expected_protocol_fees := expected_protocol_fees + COALESCE((
    SELECT sum(protocol_rounding_dust_micro_units)::BIGINT FROM lp_vault_cycle_closing_states
    WHERE vault_id=NEW.vault_id AND closed_at<=reconciliation_record.created_at),0);
  SELECT COALESCE(sum(amount_micro_units),0)::BIGINT INTO expected_expenses
  FROM lp_vault_approved_expense_accruals WHERE vault_id=NEW.vault_id AND accrued_on<=cycle_cutoff;
  SELECT COALESCE(sum(amount_micro_units),0)::BIGINT INTO expected_pending_deposits
  FROM lp_vault_pending_deposits WHERE vault_id=NEW.vault_id AND status='pending';
  SELECT COALESCE(sum(matured_amount_micro_units),0)::BIGINT INTO expected_matured_payables
  FROM lp_vault_redemption_payables WHERE vault_id=NEW.vault_id;

  IF NEW.canonical_block_number<>reconciliation_record.observed_block_number
    OR lower(NEW.canonical_block_hash) IS DISTINCT FROM lower(reconciliation_record.observed_block_hash)
    OR NEW.senior_user_obligations_micro_units<>expected_senior
    OR marked_ticket_count<>expected_open_ticket_count
    OR EXISTS (SELECT 1 FROM lp_vault_ticket_liability_marks ticket_marks
      WHERE ticket_marks.cycle_id=NEW.cycle_id AND ticket_marks.evidence_time<>reconciliation_record.created_at)
    OR NEW.gross_unresolved_payouts_micro_units<>expected_gross
    OR NEW.marked_unresolved_liability_micro_units<>expected_marked
    OR NEW.protocol_fee_payable_micro_units<>expected_protocol_fees
    OR NEW.approved_expense_payable_micro_units<>expected_expenses
    OR NEW.pending_deposit_liability_micro_units<>expected_pending_deposits
    OR NEW.matured_redemption_payable_micro_units<>expected_matured_payables
    OR NEW.nav_deductions_micro_units<>(expected_senior+expected_marked+expected_protocol_fees+
      expected_expenses+expected_pending_deposits+expected_matured_payables)
  THEN RAISE EXCEPTION 'lp_vault_liability_mark_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_lp_vault_ticket_liability_mark()
RETURNS trigger AS $$
DECLARE
  reserve_record ticket_reserves%ROWTYPE;
  cycle_record lp_vault_daily_cycles%ROWTYPE;
  event_record lp_vault_accounting_events%ROWTYPE;
BEGIN
  SELECT * INTO reserve_record FROM ticket_reserves WHERE ticket_id = NEW.ticket_id;
  SELECT * INTO cycle_record FROM lp_vault_daily_cycles WHERE id = NEW.cycle_id;
  SELECT * INTO event_record FROM lp_vault_accounting_events WHERE id = NEW.accounting_event_id;
  IF reserve_record.id IS NULL
    OR reserve_record.accounting_mode <> 'house_book_usdc'
    OR reserve_record.currency <> 'USDC'
    OR reserve_record.created_at > NEW.evidence_time
    OR EXISTS (
      SELECT 1 FROM ticket_settlement_summaries summaries
      WHERE summaries.ticket_id = NEW.ticket_id
        AND summaries.created_at <= NEW.evidence_time
    )
    OR NEW.stake_micro_units <> reserve_record.stake_micro_units
    OR NEW.gross_payout_micro_units <> reserve_record.offered_payout_micro_units
    OR cycle_record.vault_id <> NEW.vault_id
    OR NEW.evidence_time > now()
    OR NEW.evidence_time < (cycle_record.cutoff_date::timestamp AT TIME ZONE 'UTC')
    OR NEW.mark_source <> 'gross_payout_fallback'
    OR event_record.vault_id <> NEW.vault_id
    OR event_record.event_type <> 'ticket_liability_marked'
    OR event_record.entity_id <> NEW.id
  THEN RAISE EXCEPTION 'lp_vault_ticket_liability_mark_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE lp_vault_daily_cycles
  ADD COLUMN close_mode TEXT,
  ADD COLUMN source_delay_ms BIGINT,
  ADD COLUMN recovery_before_snapshot_id UUID REFERENCES financial_reconciliation_snapshots(id);

ALTER TABLE lp_vault_daily_cycles
  ADD CONSTRAINT lp_vault_daily_cycle_close_evidence_check CHECK (
    (
      status = 'closed'
      AND close_mode IN ('on_time', 'unchanged_state_recovery')
      AND source_delay_ms IS NOT NULL
      AND source_delay_ms >= 0
      AND (
        (close_mode = 'on_time' AND recovery_before_snapshot_id IS NULL)
        OR (close_mode = 'unchanged_state_recovery' AND recovery_before_snapshot_id IS NOT NULL)
      )
    )
    OR (
      status <> 'closed'
      AND close_mode IS NULL
      AND source_delay_ms IS NULL
      AND recovery_before_snapshot_id IS NULL
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION enforce_lp_vault_daily_cycle_close_evidence()
RETURNS trigger AS $$
BEGIN
  IF OLD.close_mode IS NOT NULL
    AND (
      OLD.close_mode IS DISTINCT FROM NEW.close_mode
      OR OLD.source_delay_ms IS DISTINCT FROM NEW.source_delay_ms
      OR OLD.recovery_before_snapshot_id IS DISTINCT FROM NEW.recovery_before_snapshot_id
    )
  THEN
    RAISE EXCEPTION 'lp_vault_daily_cycle_close_evidence_is_immutable';
  END IF;

  IF NEW.status = 'closed' THEN
    IF NEW.close_mode NOT IN ('on_time', 'unchanged_state_recovery')
      OR NEW.source_delay_ms IS NULL
      OR NEW.source_delay_ms < 0
      OR (NEW.close_mode = 'on_time' AND NEW.recovery_before_snapshot_id IS NOT NULL)
      OR (NEW.close_mode = 'unchanged_state_recovery' AND NEW.recovery_before_snapshot_id IS NULL)
    THEN
      RAISE EXCEPTION 'lp_vault_daily_cycle_close_evidence_missing';
    END IF;
  ELSIF NEW.close_mode IS NOT NULL OR NEW.source_delay_ms IS NOT NULL
    OR NEW.recovery_before_snapshot_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'lp_vault_daily_cycle_close_evidence_premature';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_daily_cycles_close_evidence_trigger
BEFORE UPDATE ON lp_vault_daily_cycles
FOR EACH ROW
EXECUTE FUNCTION enforce_lp_vault_daily_cycle_close_evidence();

CREATE TABLE lp_vault_redemption_waiting_evidence (
  id UUID PRIMARY KEY,
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  redemption_request_id UUID NOT NULL REFERENCES lp_vault_redemption_requests(id),
  source_reconciliation_snapshot_id UUID NOT NULL REFERENCES financial_reconciliation_snapshots(id),
  required_liquidity_micro_units BIGINT NOT NULL CHECK (required_liquidity_micro_units > 0),
  available_liquidity_before_micro_units BIGINT NOT NULL CHECK (available_liquidity_before_micro_units >= 0),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (required_liquidity_micro_units > available_liquidity_before_micro_units)
);

INSERT INTO lp_vault_redemption_waiting_evidence (
  id,
  vault_id,
  redemption_request_id,
  source_reconciliation_snapshot_id,
  required_liquidity_micro_units,
  available_liquidity_before_micro_units,
  accounting_event_id,
  recorded_at
)
SELECT
  events.entity_id,
  events.vault_id,
  (events.payload->>'requestId')::uuid,
  (events.payload->>'reconciliationSnapshotId')::uuid,
  (events.payload->>'requiredLiquidityMicroUnits')::bigint,
  (events.payload->>'availableLiquidityBeforeMicroUnits')::bigint,
  events.id,
  events.recorded_at
FROM lp_vault_accounting_events events
JOIN lp_vault_redemption_requests requests
  ON requests.id::text = events.payload->>'requestId'
  AND requests.vault_id = events.vault_id
JOIN financial_reconciliation_snapshots snapshots
  ON snapshots.id::text = events.payload->>'reconciliationSnapshotId'
WHERE events.event_type = 'redemption_waiting'
  AND COALESCE(events.payload->>'requestId','') ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND COALESCE(events.payload->>'reconciliationSnapshotId','') ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND COALESCE(events.payload->>'requiredLiquidityMicroUnits','') ~ '^[1-9][0-9]*$'
  AND COALESCE(events.payload->>'availableLiquidityBeforeMicroUnits','') ~ '^[0-9]+$'
  AND (events.payload->>'requiredLiquidityMicroUnits')::numeric
    > (events.payload->>'availableLiquidityBeforeMicroUnits')::numeric
  AND events.payload = jsonb_build_object(
    'requestId', requests.id::text,
    'reconciliationSnapshotId', snapshots.id::text,
    'requiredLiquidityMicroUnits', events.payload->>'requiredLiquidityMicroUnits',
    'availableLiquidityBeforeMicroUnits', events.payload->>'availableLiquidityBeforeMicroUnits'
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM lp_vault_accounting_events events
    LEFT JOIN lp_vault_redemption_waiting_evidence evidence
      ON evidence.accounting_event_id = events.id
    WHERE events.event_type = 'redemption_waiting'
      AND evidence.accounting_event_id IS NULL
  ) THEN
    RAISE EXCEPTION 'lp_vault_redemption_waiting_legacy_evidence_invalid';
  END IF;
END;
$$;

CREATE TRIGGER lp_vault_redemption_waiting_evidence_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_redemption_waiting_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE OR REPLACE FUNCTION validate_lp_vault_redemption_waiting_evidence()
RETURNS trigger AS $$
DECLARE
  event_record lp_vault_accounting_events%ROWTYPE;
  request_record lp_vault_redemption_requests%ROWTYPE;
BEGIN
  SELECT * INTO event_record FROM lp_vault_accounting_events WHERE id = NEW.accounting_event_id;
  SELECT * INTO request_record FROM lp_vault_redemption_requests WHERE id = NEW.redemption_request_id;
  IF event_record.id IS NULL
    OR request_record.id IS NULL
    OR request_record.vault_id <> NEW.vault_id
    OR event_record.vault_id <> NEW.vault_id
    OR event_record.event_type <> 'redemption_waiting'
    OR event_record.entity_id <> NEW.id
    OR event_record.payload <> jsonb_build_object(
      'requestId', NEW.redemption_request_id::text,
      'reconciliationSnapshotId', NEW.source_reconciliation_snapshot_id::text,
      'requiredLiquidityMicroUnits', NEW.required_liquidity_micro_units::text,
      'availableLiquidityBeforeMicroUnits', NEW.available_liquidity_before_micro_units::text
    )
  THEN RAISE EXCEPTION 'lp_vault_redemption_waiting_evidence_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_redemption_waiting_evidence_validate_trigger
BEFORE INSERT ON lp_vault_redemption_waiting_evidence
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_redemption_waiting_evidence();

COMMENT ON TABLE financial_book_state IS
  'Monotonic serialization fence for committed money mutations used by reconciliation and LP accounting.';

COMMENT ON COLUMN financial_reconciliation_snapshots.financial_book_version IS
  'Committed financial book version observed while the global financial mutation lock was held.';

COMMENT ON COLUMN financial_reconciliation_snapshots.financial_state_hash IS
  'Canonical hash of treasury evidence and internal financial position at reconciliation time.';

COMMENT ON COLUMN lp_vault_daily_cycles.close_mode IS
  'Whether the cycle used evidence in the normal cutoff window or a fresh, explicitly recorded recovery snapshot.';

COMMENT ON COLUMN lp_vault_liability_marks.source_mode IS
  'Immutable valuation-source mode, including fail-closed unchanged-state recovery for missed cutoffs.';
