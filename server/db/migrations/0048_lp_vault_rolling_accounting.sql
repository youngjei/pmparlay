-- Rolling LP accounting is evidence-only in this migration. It creates no
-- custody instruction, ledger transfer, or public deposit/withdrawal path.

CREATE OR REPLACE FUNCTION prevent_lp_vault_accounting_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%_is_append_only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE lp_vault_accounting_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  book_version BIGINT NOT NULL CHECK (book_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'accounting_incepted',
    'cycle_opened',
    'liability_marked',
    'ticket_liability_marked',
    'settlement_recognized',
    'protocol_fee_accrued',
    'protocol_fee_released',
    'nav_checkpointed',
    'liquidity_marked',
    'expense_accrued',
    'deposit_pending',
    'deposit_activated',
    'deposit_rejected',
    'redemption_requested',
    'redemption_waiting',
    'redemption_admitted',
    'redemption_redeeming',
    'redemption_reserve_marked',
    'redemption_payable_matured',
    'redemption_reserved',
    'redemption_finalized',
    'redemption_claimable',
    'redemption_canceled',
    'cycle_closed'
  )),
  entity_id UUID NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  previous_event_hash TEXT CHECK (previous_event_hash ~ '^sha256:[a-f0-9]{64}$'),
  event_hash TEXT NOT NULL UNIQUE CHECK (event_hash ~ '^sha256:[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, book_version)
);

COMMENT ON TABLE lp_vault_accounting_events IS
  'Hash-chained, append-only evidence for replaying every rolling LP accounting version. No event moves funds.';

CREATE OR REPLACE FUNCTION seal_lp_vault_accounting_event()
RETURNS trigger AS $$
DECLARE
  prior_version BIGINT;
  prior_hash TEXT;
  calculated_payload_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lp-vault-accounting:' || NEW.vault_id::text, 0));

  SELECT book_version, event_hash
  INTO prior_version, prior_hash
  FROM lp_vault_accounting_events
  WHERE vault_id = NEW.vault_id
  ORDER BY book_version DESC
  LIMIT 1
  FOR UPDATE;

  IF prior_version IS NULL THEN
    IF NEW.book_version <> 1 OR NEW.previous_event_hash IS NOT NULL THEN
      RAISE EXCEPTION 'lp_vault_accounting_event_chain_mismatch';
    END IF;
  ELSIF NEW.book_version <> prior_version + 1 OR NEW.previous_event_hash IS DISTINCT FROM prior_hash THEN
    RAISE EXCEPTION 'lp_vault_accounting_event_chain_mismatch';
  END IF;

  calculated_payload_hash := 'sha256:' || encode(digest(convert_to(NEW.payload::text, 'UTF8'), 'sha256'), 'hex');
  NEW.payload_hash := calculated_payload_hash;
  NEW.event_hash := 'sha256:' || encode(
    digest(
      convert_to(
        NEW.vault_id::text || ':' || NEW.book_version::text || ':' ||
        COALESCE(NEW.previous_event_hash, '') || ':' || NEW.event_type || ':' ||
        NEW.entity_id::text || ':' || calculated_payload_hash,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_accounting_events_seal_trigger
BEFORE INSERT ON lp_vault_accounting_events
FOR EACH ROW
EXECUTE FUNCTION seal_lp_vault_accounting_event();

CREATE TRIGGER lp_vault_accounting_events_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_accounting_events
FOR EACH ROW
EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TABLE lp_vault_accounting_idempotency (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  operation_scope TEXT NOT NULL CHECK (operation_scope IN (
    'daily_checkpoint',
    'expense_accrual',
    'pending_deposit',
    'deposit_activation',
    'redemption_admission',
    'redemption_waiting',
    'redemption_window',
    'redemption_finalization',
    'redemption_claimable'
  )),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  result_entity_type TEXT NOT NULL,
  result_entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, operation_scope, idempotency_key)
);

COMMENT ON TABLE lp_vault_accounting_idempotency IS
  'Immutable vault-and-operation-scoped request fingerprints. Reusing a key with another payload is a conflict.';

CREATE TRIGGER lp_vault_accounting_idempotency_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_accounting_idempotency
FOR EACH ROW
EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TABLE lp_vault_daily_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  cutoff_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'marked', 'checkpointed', 'closed')),
  opened_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  marked_at TIMESTAMPTZ,
  checkpointed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  UNIQUE (vault_id, cutoff_date),
  UNIQUE (id, vault_id),
  CHECK (
    (status = 'open' AND marked_at IS NULL AND checkpointed_at IS NULL AND closed_at IS NULL)
    OR (status = 'marked' AND marked_at IS NOT NULL AND checkpointed_at IS NULL AND closed_at IS NULL)
    OR (status = 'checkpointed' AND marked_at IS NOT NULL AND checkpointed_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'closed' AND marked_at IS NOT NULL AND checkpointed_at IS NOT NULL AND closed_at IS NOT NULL)
  )
);

COMMENT ON TABLE lp_vault_daily_cycles IS
  'One UTC accounting cutoff per vault. Mutable status is only a constrained workflow pointer; economic records are immutable.';

CREATE TABLE lp_vault_daily_cycle_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id UUID NOT NULL REFERENCES lp_vault_daily_cycles(id),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('open', 'marked', 'checkpointed', 'closed')),
  to_status TEXT NOT NULL CHECK (to_status IN ('open', 'marked', 'checkpointed', 'closed')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_status IS DISTINCT FROM to_status)
);

CREATE INDEX lp_vault_daily_cycle_history_cycle_idx
  ON lp_vault_daily_cycle_history (cycle_id, recorded_at, id);

CREATE TRIGGER lp_vault_daily_cycle_history_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_daily_cycle_history
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TABLE lp_vault_accounting_inceptions (
  vault_id UUID PRIMARY KEY REFERENCES lp_vaults(id),
  inception_at TIMESTAMPTZ NOT NULL,
  source_reconciliation_snapshot_id UUID NOT NULL REFERENCES financial_reconciliation_snapshots(id),
  founder_seed_residual_micro_units BIGINT NOT NULL CHECK (founder_seed_residual_micro_units >= 0),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE lp_vault_accounting_inceptions IS
  'Immutable boundary: pre-inception reconciled residual is founder seed, not a retroactive protocol-fee payable.';

CREATE TRIGGER lp_vault_accounting_inceptions_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_accounting_inceptions
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TABLE lp_vault_protocol_fee_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  ticket_id UUID REFERENCES tickets(id),
  ticket_reserve_id UUID REFERENCES ticket_reserves(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('accrual', 'release')),
  amount_micro_units BIGINT NOT NULL CHECK (amount_micro_units > 0),
  source_reference TEXT NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 300),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  effective_at TIMESTAMPTZ NOT NULL,
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, event_type, source_reference),
  CHECK (
    (event_type = 'accrual' AND ticket_id IS NOT NULL AND ticket_reserve_id IS NOT NULL)
    OR (event_type = 'release' AND ticket_id IS NULL AND ticket_reserve_id IS NULL)
  )
);

CREATE UNIQUE INDEX lp_vault_protocol_fee_events_ticket_accrual_idx
  ON lp_vault_protocol_fee_events (vault_id, ticket_id)
  WHERE event_type = 'accrual';

COMMENT ON TABLE lp_vault_protocol_fee_events IS
  'Append-only post-inception protocol fee accruals and releases. Net balance is excluded once from LP NAV.';

CREATE TRIGGER lp_vault_protocol_fee_events_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_protocol_fee_events
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TABLE lp_vault_approved_expense_accruals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  amount_micro_units BIGINT NOT NULL CHECK (amount_micro_units > 0),
  accrued_on DATE NOT NULL,
  approval_reference TEXT NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 300),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, approval_reference)
);

COMMENT ON TABLE lp_vault_approved_expense_accruals IS
  'Append-only approved and capped direct vault expense evidence; kept separate from protocol fee ownership.';

CREATE TRIGGER lp_vault_approved_expense_accruals_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_approved_expense_accruals
FOR EACH ROW
EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TABLE lp_vault_ticket_liability_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  cycle_id UUID NOT NULL,
  ticket_id UUID NOT NULL REFERENCES tickets(id),
  stake_micro_units BIGINT NOT NULL CHECK (stake_micro_units >= 0),
  gross_payout_micro_units BIGINT NOT NULL CHECK (gross_payout_micro_units >= 0),
  marked_liability_micro_units BIGINT NOT NULL CHECK (
    marked_liability_micro_units >= 0 AND marked_liability_micro_units <= gross_payout_micro_units
  ),
  mark_source TEXT NOT NULL CHECK (mark_source = 'gross_payout_fallback'),
  fallback_reason TEXT NOT NULL CHECK (length(fallback_reason) BETWEEN 1 AND 500),
  evidence_time TIMESTAMPTZ NOT NULL,
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, ticket_id),
  FOREIGN KEY (cycle_id, vault_id) REFERENCES lp_vault_daily_cycles(id, vault_id),
  CHECK (marked_liability_micro_units = gross_payout_micro_units)
);

COMMENT ON TABLE lp_vault_ticket_liability_marks IS
  'One immutable unresolved-ticket mark per cycle. Fallback is the full gross payout, never a silent zero.';

CREATE TABLE lp_vault_settlement_recognitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  cycle_id UUID NOT NULL,
  ticket_id UUID NOT NULL UNIQUE REFERENCES tickets(id),
  settlement_summary_id UUID NOT NULL UNIQUE REFERENCES ticket_settlement_summaries(id),
  frozen_stake_micro_units BIGINT NOT NULL CHECK (frozen_stake_micro_units >= 0),
  final_payout_micro_units BIGINT NOT NULL CHECK (final_payout_micro_units >= 0),
  protocol_fee_micro_units BIGINT NOT NULL CHECK (protocol_fee_micro_units >= 0),
  finalized_pnl_micro_units BIGINT NOT NULL,
  recognized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  FOREIGN KEY (cycle_id, vault_id) REFERENCES lp_vault_daily_cycles(id, vault_id),
  CHECK (finalized_pnl_micro_units = frozen_stake_micro_units - final_payout_micro_units)
);

COMMENT ON TABLE lp_vault_settlement_recognitions IS
  'Exactly-once settled-ticket underwriting P&L. Protocol operation fees are evidence but excluded from P&L.';

CREATE TRIGGER lp_vault_ticket_liability_marks_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_ticket_liability_marks
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TRIGGER lp_vault_settlement_recognitions_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_settlement_recognitions
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TABLE lp_vault_liability_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  cycle_id UUID NOT NULL,
  source_reconciliation_snapshot_id UUID NOT NULL REFERENCES financial_reconciliation_snapshots(id),
  canonical_block_number BIGINT NOT NULL CHECK (canonical_block_number >= 0),
  canonical_block_hash TEXT NOT NULL CHECK (canonical_block_hash ~ '^0x[a-f0-9]{64}$'),
  senior_user_obligations_micro_units BIGINT NOT NULL CHECK (senior_user_obligations_micro_units >= 0),
  gross_unresolved_payouts_micro_units BIGINT NOT NULL CHECK (gross_unresolved_payouts_micro_units >= 0),
  marked_unresolved_liability_micro_units BIGINT NOT NULL CHECK (marked_unresolved_liability_micro_units >= 0),
  protocol_fee_payable_micro_units BIGINT NOT NULL CHECK (protocol_fee_payable_micro_units >= 0),
  approved_expense_payable_micro_units BIGINT NOT NULL CHECK (approved_expense_payable_micro_units >= 0),
  pending_deposit_liability_micro_units BIGINT NOT NULL CHECK (pending_deposit_liability_micro_units >= 0),
  matured_redemption_payable_micro_units BIGINT NOT NULL CHECK (matured_redemption_payable_micro_units >= 0),
  nav_deductions_micro_units BIGINT NOT NULL CHECK (nav_deductions_micro_units >= 0),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, cycle_id),
  UNIQUE (cycle_id),
  FOREIGN KEY (cycle_id, vault_id) REFERENCES lp_vault_daily_cycles(id, vault_id),
  CHECK (
    nav_deductions_micro_units =
      senior_user_obligations_micro_units +
      marked_unresolved_liability_micro_units +
      protocol_fee_payable_micro_units +
      approved_expense_payable_micro_units +
      pending_deposit_liability_micro_units +
      matured_redemption_payable_micro_units
  )
);

COMMENT ON COLUMN lp_vault_liability_marks.protocol_fee_payable_micro_units IS
  'Activated per-leg operation fees retained by the protocol and excluded from LP NAV.';
COMMENT ON COLUMN lp_vault_liability_marks.approved_expense_payable_micro_units IS
  'Approved accrued direct vault expenses, independently excluded from LP NAV.';
COMMENT ON COLUMN lp_vault_liability_marks.matured_redemption_payable_micro_units IS
  'Finalized redemption payable after share burn; no transfer is implied.';
COMMENT ON COLUMN lp_vault_liability_marks.nav_deductions_micro_units IS
  'Economic NAV deductions. Active redemption reserves are deliberately excluded while their shares remain active.';

CREATE TABLE lp_vault_nav_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  cycle_id UUID NOT NULL,
  liability_mark_id UUID NOT NULL UNIQUE REFERENCES lp_vault_liability_marks(id),
  source_reconciliation_snapshot_id UUID NOT NULL REFERENCES financial_reconciliation_snapshots(id),
  prior_checkpoint_id UUID REFERENCES lp_vault_nav_checkpoints(id),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  accounting_version BIGINT NOT NULL CHECK (accounting_version > 0),
  gross_assets_micro_units BIGINT NOT NULL CHECK (gross_assets_micro_units >= 0),
  net_asset_value_micro_units BIGINT NOT NULL CHECK (net_asset_value_micro_units >= 0),
  share_supply_units NUMERIC(78, 0) NOT NULL CHECK (share_supply_units >= 0),
  share_price_numerator_micro_units BIGINT NOT NULL CHECK (share_price_numerator_micro_units >= 0),
  share_price_denominator_units NUMERIC(78, 0) NOT NULL CHECK (share_price_denominator_units >= 0),
  estimated_pnl_micro_units BIGINT NOT NULL,
  finalized_pnl_micro_units BIGINT NOT NULL,
  calculation_version TEXT NOT NULL CHECK (calculation_version = 'rolling-nav-v1'),
  checkpointed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, cycle_id),
  UNIQUE (cycle_id),
  UNIQUE (vault_id, accounting_version),
  FOREIGN KEY (cycle_id, vault_id) REFERENCES lp_vault_daily_cycles(id, vault_id),
  CHECK (share_price_numerator_micro_units = net_asset_value_micro_units),
  CHECK (share_price_denominator_units = share_supply_units)
);

COMMENT ON TABLE lp_vault_nav_checkpoints IS
  'One immutable NAV checkpoint per daily cutoff, tied to canonical reconciliation and a hash-chained book version.';
COMMENT ON COLUMN lp_vault_nav_checkpoints.share_price_numerator_micro_units IS
  'Exact rational price numerator. The repository, never its caller, derives it from trusted assets and liabilities.';

CREATE TABLE lp_vault_pending_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  user_id UUID NOT NULL REFERENCES users(id),
  amount_micro_units BIGINT NOT NULL CHECK (amount_micro_units > 0),
  eligible_after_cutoff DATE NOT NULL,
  source_reference TEXT NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 300),
  request_payload_hash TEXT NOT NULL CHECK (request_payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected')),
  activation_checkpoint_id UUID REFERENCES lp_vault_nav_checkpoints(id),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  UNIQUE (vault_id, source_reference),
  CHECK (
    (status = 'pending' AND activation_checkpoint_id IS NULL AND activated_at IS NULL AND rejected_at IS NULL)
    OR (status = 'active' AND activation_checkpoint_id IS NOT NULL AND activated_at IS NOT NULL AND rejected_at IS NULL)
    OR (status = 'rejected' AND activation_checkpoint_id IS NULL AND activated_at IS NULL AND rejected_at IS NOT NULL)
  )
);

CREATE INDEX lp_vault_pending_deposits_status_idx
  ON lp_vault_pending_deposits (vault_id, status, eligible_after_cutoff, created_at);

CREATE OR REPLACE FUNCTION validate_lp_vault_pending_deposit_insert()
RETURNS trigger AS $$
DECLARE
  event_record lp_vault_accounting_events%ROWTYPE;
  inception_record lp_vault_accounting_inceptions%ROWTYPE;
  expected_cutoff DATE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lp-vault-accounting:' || NEW.vault_id::text, 0));
  SELECT * INTO event_record FROM lp_vault_accounting_events WHERE id = NEW.accounting_event_id;
  SELECT * INTO inception_record FROM lp_vault_accounting_inceptions WHERE vault_id = NEW.vault_id;
  IF NEW.source_reference = 'internal:founder-seed:v1' THEN
    expected_cutoff := (inception_record.inception_at AT TIME ZONE 'UTC')::date;
  ELSE
    expected_cutoff := ((now() AT TIME ZONE 'UTC')::date + 1);
    NEW.created_at := now();
  END IF;
  IF inception_record.vault_id IS NULL
    OR event_record.id IS NULL
    OR event_record.vault_id <> NEW.vault_id
    OR event_record.event_type <> 'deposit_pending'
    OR event_record.entity_id <> NEW.id
    OR NEW.status <> 'pending'
    OR NEW.activation_checkpoint_id IS NOT NULL
    OR NEW.activated_at IS NOT NULL
    OR NEW.rejected_at IS NOT NULL
    OR NEW.eligible_after_cutoff <> expected_cutoff
  THEN
    RAISE EXCEPTION 'lp_vault_pending_deposit_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_pending_deposits_validate_insert_trigger
BEFORE INSERT ON lp_vault_pending_deposits
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_pending_deposit_insert();

CREATE TABLE lp_vault_share_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, user_id),
  UNIQUE (id, vault_id)
);

COMMENT ON TABLE lp_vault_share_positions IS
  'Immutable owner identity for non-transferable LP shares. Balances are replayed from mint and burn events.';

CREATE TABLE lp_vault_redemption_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  position_id UUID NOT NULL,
  requested_share_units NUMERIC(78, 0) NOT NULL CHECK (requested_share_units > 0),
  request_payload_hash TEXT NOT NULL CHECK (request_payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  queue_sequence BIGSERIAL NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'waiting_liquidity', 'admitted', 'redeeming', 'finalized', 'claimable', 'canceled'
  )),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  waiting_liquidity_at TIMESTAMPTZ,
  redemption_starts_at TIMESTAMPTZ,
  redemption_ends_at TIMESTAMPTZ,
  redeeming_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  claimable_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  UNIQUE (id, vault_id),
  FOREIGN KEY (position_id, vault_id) REFERENCES lp_vault_share_positions(id, vault_id),
  CHECK (redemption_ends_at IS NULL OR redemption_ends_at = redemption_starts_at + interval '72 hours'),
  CHECK (
    (status = 'queued' AND waiting_liquidity_at IS NULL AND redemption_starts_at IS NULL
      AND redeeming_at IS NULL AND finalized_at IS NULL AND claimable_at IS NULL AND canceled_at IS NULL)
    OR (status = 'waiting_liquidity' AND waiting_liquidity_at IS NOT NULL AND redemption_starts_at IS NULL
      AND redeeming_at IS NULL AND finalized_at IS NULL AND claimable_at IS NULL AND canceled_at IS NULL)
    OR (status = 'admitted' AND redemption_starts_at IS NOT NULL AND redemption_ends_at IS NOT NULL
      AND redeeming_at IS NULL AND finalized_at IS NULL AND claimable_at IS NULL AND canceled_at IS NULL)
    OR (status = 'redeeming' AND redemption_starts_at IS NOT NULL AND redemption_ends_at IS NOT NULL
      AND redeeming_at IS NOT NULL AND finalized_at IS NULL AND claimable_at IS NULL AND canceled_at IS NULL)
    OR (status = 'finalized' AND redemption_starts_at IS NOT NULL AND redemption_ends_at IS NOT NULL
      AND redeeming_at IS NOT NULL AND finalized_at IS NOT NULL AND claimable_at IS NULL AND canceled_at IS NULL)
    OR (status = 'claimable' AND redemption_starts_at IS NOT NULL AND redemption_ends_at IS NOT NULL
      AND redeeming_at IS NOT NULL AND finalized_at IS NOT NULL AND claimable_at IS NOT NULL AND canceled_at IS NULL)
    OR (status = 'canceled' AND redemption_starts_at IS NULL AND redeeming_at IS NULL
      AND finalized_at IS NULL AND claimable_at IS NULL AND canceled_at IS NOT NULL)
  )
);

CREATE INDEX lp_vault_redemption_requests_queue_idx
  ON lp_vault_redemption_requests (vault_id, status, queue_sequence);

CREATE UNIQUE INDEX lp_vault_redemption_requests_one_open_per_position_idx
  ON lp_vault_redemption_requests (position_id)
  WHERE status IN ('queued', 'waiting_liquidity', 'admitted', 'redeeming');

CREATE TABLE lp_vault_redemption_request_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_request_id UUID NOT NULL REFERENCES lp_vault_redemption_requests(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_status IS DISTINCT FROM to_status)
);

CREATE TABLE lp_vault_redemption_reserves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  redemption_request_id UUID NOT NULL UNIQUE,
  reserved_share_units NUMERIC(78, 0) NOT NULL CHECK (reserved_share_units > 0),
  admission_reconciliation_snapshot_id UUID NOT NULL REFERENCES financial_reconciliation_snapshots(id),
  admission_accounting_cycle_id UUID NOT NULL,
  admission_checkpoint_id UUID NOT NULL REFERENCES lp_vault_nav_checkpoints(id),
  required_liquidity_micro_units BIGINT NOT NULL CHECK (required_liquidity_micro_units >= 0),
  available_liquidity_before_micro_units BIGINT NOT NULL CHECK (available_liquidity_before_micro_units >= 0),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (redemption_request_id, vault_id) REFERENCES lp_vault_redemption_requests(id, vault_id),
  FOREIGN KEY (admission_accounting_cycle_id, vault_id) REFERENCES lp_vault_daily_cycles(id, vault_id),
  UNIQUE (admission_reconciliation_snapshot_id)
);

COMMENT ON TABLE lp_vault_redemption_reserves IS
  'Immutable share-hold and fresh-reconciliation admission evidence. It does not freeze the final redemption value.';

CREATE OR REPLACE FUNCTION calculate_lp_vault_redemption_admission_capacity(
  p_vault_id UUID,
  p_reconciliation_snapshot_id UUID,
  p_accounting_cycle_id UUID,
  p_checkpoint_id UUID,
  p_redemption_request_id UUID
)
RETURNS TABLE (
  required_liquidity_micro_units BIGINT,
  available_liquidity_before_micro_units BIGINT
) AS $$
DECLARE
  snapshot_record financial_reconciliation_snapshots%ROWTYPE;
  vault_record lp_vaults%ROWTYPE;
  request_record lp_vault_redemption_requests%ROWTYPE;
  snapshot_is_current_transaction BOOLEAN;
  latest_cycle_id UUID;
  latest_checkpoint_id UUID;
  closing_nav_micro_units BIGINT;
  closing_share_supply_units NUMERIC(78, 0);
  current_user_available BIGINT;
  current_user_claimable BIGINT;
  current_user_checkout BIGINT;
  current_pending_withdrawals BIGINT;
  senior_obligations BIGINT;
  pending_lp_deposits BIGINT;
  protocol_fee_payable BIGINT;
  approved_expense_payable BIGINT;
  matured_redemption_payable BIGINT;
  active_redemption_reserves BIGINT;
  gross_unresolved_live_payouts BIGINT;
  pending_soft_reservation_operating_charge BIGINT;
  operating_floor BIGINT;
  unavailable_liquidity NUMERIC;
  calculated_required BIGINT;
  calculated_available BIGINT;
BEGIN
  SELECT * INTO snapshot_record
  FROM financial_reconciliation_snapshots
  WHERE id = p_reconciliation_snapshot_id;
  SELECT (xmin::text::BIGINT = txid_current()) INTO snapshot_is_current_transaction
  FROM financial_reconciliation_snapshots
  WHERE id = p_reconciliation_snapshot_id;
  SELECT * INTO vault_record FROM lp_vaults WHERE id = p_vault_id;
  SELECT * INTO request_record
  FROM lp_vault_redemption_requests
  WHERE id = p_redemption_request_id AND vault_id = p_vault_id
  FOR UPDATE;

  IF snapshot_record.id IS NULL
    OR vault_record.id IS NULL
    OR request_record.id IS NULL
    OR snapshot_is_current_transaction IS NOT TRUE
    OR snapshot_record.source IS DISTINCT FROM 'worker'
    OR snapshot_record.launch_gate IS DISTINCT FROM 'ready'
    OR snapshot_record.operation_gate IS DISTINCT FROM 'open'
    OR snapshot_record.unexplained_delta_micro_units <> 0
    OR snapshot_record.observed_block_number IS NULL
    OR snapshot_record.observed_block_hash !~ '^0x[a-f0-9]{64}$'
    OR snapshot_record.created_at > now()
    OR snapshot_record.created_at < now() - interval '5 minutes'
    OR (
      CASE
        WHEN COALESCE(snapshot_record.metrics->>'observedBlockTimestamp', '') ~ '^[0-9]+$' THEN
          (snapshot_record.metrics->>'observedBlockTimestamp')::NUMERIC > extract(epoch FROM now())
          OR (snapshot_record.metrics->>'observedBlockTimestamp')::NUMERIC
            < extract(epoch FROM now() - interval '5 minutes')
        ELSE TRUE
      END
    )
    OR snapshot_record.chain_id IS DISTINCT FROM vault_record.chain_id
    OR snapshot_record.currency IS DISTINCT FROM vault_record.currency
    OR lower(snapshot_record.scope_treasury_address) IS DISTINCT FROM lower(vault_record.treasury_address)
    OR lower(snapshot_record.scope_token_address) IS DISTINCT FROM lower(vault_record.token_address)
    OR request_record.status NOT IN ('queued', 'waiting_liquidity')
    OR current_setting('legwork.financial_global_exclusive_lock', true) IS DISTINCT FROM 'held'
  THEN
    RAISE EXCEPTION 'lp_vault_redemption_admission_evidence_invalid';
  END IF;

  SELECT cycles.id, checkpoints.id, closing.closing_economic_nav_micro_units,
    closing.closing_share_supply_units
  INTO latest_cycle_id, latest_checkpoint_id, closing_nav_micro_units, closing_share_supply_units
  FROM lp_vault_daily_cycles cycles
  JOIN lp_vault_nav_checkpoints checkpoints ON checkpoints.cycle_id = cycles.id
  JOIN lp_vault_cycle_closing_states closing ON closing.cycle_id = cycles.id
  WHERE cycles.vault_id = p_vault_id AND cycles.status = 'closed'
  ORDER BY cycles.cutoff_date DESC
  LIMIT 1;

  IF latest_cycle_id IS NULL
    OR latest_cycle_id IS DISTINCT FROM p_accounting_cycle_id
    OR latest_checkpoint_id IS DISTINCT FROM p_checkpoint_id
    OR closing_share_supply_units <= 0
  THEN
    RAISE EXCEPTION 'lp_vault_redemption_accounting_evidence_invalid';
  END IF;

  SELECT
    COALESCE(sum(entries.amount_micro_units) FILTER (WHERE accounts.account_type = 'user_usdc_available'), 0)::BIGINT,
    COALESCE(sum(entries.amount_micro_units) FILTER (WHERE accounts.account_type = 'user_usdc_claimable'), 0)::BIGINT,
    COALESCE(sum(entries.amount_micro_units) FILTER (WHERE accounts.account_type = 'user_usdc_checkout'), 0)::BIGINT
  INTO current_user_available, current_user_claimable, current_user_checkout
  FROM ledger_accounts accounts
  LEFT JOIN ledger_entries entries ON entries.account_id = accounts.id
  WHERE accounts.currency = 'USDC';
  SELECT COALESCE(sum(amount_micro_units), 0)::BIGINT INTO current_pending_withdrawals
  FROM withdrawal_requests
  WHERE currency = 'USDC' AND status IN ('requested', 'proposed');

  IF snapshot_record.user_available_micro_units <> current_user_available
    OR snapshot_record.user_claimable_micro_units <> current_user_claimable
    OR snapshot_record.user_checkout_micro_units <> current_user_checkout
    OR snapshot_record.pending_withdrawal_micro_units <> current_pending_withdrawals
    OR current_user_available < 0
    OR current_user_claimable < 0
    OR current_user_checkout < 0
    OR current_pending_withdrawals < 0
  THEN
    RAISE EXCEPTION 'lp_vault_redemption_snapshot_position_mismatch';
  END IF;
  senior_obligations := current_user_available + current_user_claimable + current_user_checkout + current_pending_withdrawals;

  SELECT COALESCE(sum(amount_micro_units), 0)::BIGINT INTO pending_lp_deposits
  FROM lp_vault_pending_deposits
  WHERE vault_id = p_vault_id AND status = 'pending';
  SELECT COALESCE(sum(CASE WHEN event_type = 'accrual' THEN amount_micro_units ELSE -amount_micro_units END), 0)::BIGINT
    + COALESCE((SELECT sum(protocol_rounding_dust_micro_units)::BIGINT
      FROM lp_vault_cycle_closing_states WHERE vault_id = p_vault_id), 0)
  INTO protocol_fee_payable
  FROM lp_vault_protocol_fee_events
  WHERE vault_id = p_vault_id;
  SELECT COALESCE(sum(amount_micro_units), 0)::BIGINT INTO approved_expense_payable
  FROM lp_vault_approved_expense_accruals WHERE vault_id = p_vault_id;
  SELECT COALESCE(sum(matured_amount_micro_units), 0)::BIGINT INTO matured_redemption_payable
  FROM lp_vault_redemption_payables WHERE vault_id = p_vault_id;

  SELECT COALESCE(sum(div(
    reserves.reserved_share_units * closing_nav_micro_units::NUMERIC + closing_share_supply_units - 1,
    closing_share_supply_units
  )), 0)::BIGINT INTO active_redemption_reserves
  FROM lp_vault_redemption_reserves reserves
  JOIN lp_vault_redemption_requests requests ON requests.id = reserves.redemption_request_id
  WHERE reserves.vault_id = p_vault_id AND requests.status IN ('admitted', 'redeeming');

  SELECT COALESCE(sum(reserves.offered_payout_micro_units), 0)::BIGINT
  INTO gross_unresolved_live_payouts
  FROM ticket_reserves reserves
  WHERE reserves.accounting_mode = 'house_book_usdc'
    AND reserves.currency = vault_record.currency
    AND reserves.status = 'reserved'
    AND NOT EXISTS (
      SELECT 1 FROM ticket_settlement_summaries summaries WHERE summaries.ticket_id = reserves.ticket_id
    );
  SELECT COALESCE(sum(GREATEST(
    div(quotes.offered_payout_micro_usd::NUMERIC * 125 + 99, 100)::BIGINT - quotes.stake_micro_usd,
    0
  )), 0)::BIGINT
  INTO pending_soft_reservation_operating_charge
  FROM quote_payment_exposure_reservations reservations
  JOIN quotes ON quotes.id = reservations.quote_id
  WHERE reservations.status = 'reserved' AND reservations.expires_at > now();

  IF COALESCE(snapshot_record.metrics->>'grossUnresolvedLiveTicketPayoutMicroUnits', '') !~ '^[0-9]+$'
    OR COALESCE(snapshot_record.metrics->>'softReservationOperatingChargeMicroUnits', '') !~ '^[0-9]+$'
    OR (snapshot_record.metrics->>'grossUnresolvedLiveTicketPayoutMicroUnits')::NUMERIC <> gross_unresolved_live_payouts
    OR (snapshot_record.metrics->>'softReservationOperatingChargeMicroUnits')::NUMERIC
      <> pending_soft_reservation_operating_charge
  THEN
    RAISE EXCEPTION 'lp_vault_redemption_snapshot_exposure_mismatch';
  END IF;

  operating_floor := div(gross_unresolved_live_payouts::NUMERIC * 125 + 99, 100)::BIGINT
    + pending_soft_reservation_operating_charge;
  calculated_required := div(
    request_record.requested_share_units * closing_nav_micro_units::NUMERIC + closing_share_supply_units - 1,
    closing_share_supply_units
  )::BIGINT;
  unavailable_liquidity := senior_obligations::NUMERIC + pending_lp_deposits::NUMERIC
    + protocol_fee_payable::NUMERIC + approved_expense_payable::NUMERIC
    + matured_redemption_payable::NUMERIC + active_redemption_reserves::NUMERIC + operating_floor::NUMERIC;
  calculated_available := GREATEST(snapshot_record.treasury_assets_micro_units::NUMERIC - unavailable_liquidity, 0)::BIGINT;

  RETURN QUERY SELECT calculated_required, calculated_available;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_lp_vault_redemption_reserve()
RETURNS trigger AS $$
DECLARE
  request_record lp_vault_redemption_requests%ROWTYPE;
  available_share_units NUMERIC(78, 0);
  already_reserved_share_units NUMERIC(78, 0);
  capacity_record RECORD;
  event_record lp_vault_accounting_events%ROWTYPE;
  older_waiting BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('financial-control-gate:global', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('lp-vault-accounting:' || NEW.vault_id::text, 0));
  SELECT * INTO request_record
  FROM lp_vault_redemption_requests
  WHERE id = NEW.redemption_request_id
  FOR UPDATE;
  SELECT COALESCE(sum(CASE WHEN event_type = 'mint' THEN share_units ELSE -share_units END), 0)
  INTO available_share_units
  FROM lp_vault_share_events
  WHERE position_id = request_record.position_id;
  SELECT COALESCE(sum(reserves.reserved_share_units), 0)
  INTO already_reserved_share_units
  FROM lp_vault_redemption_reserves reserves
  JOIN lp_vault_redemption_requests requests ON requests.id = reserves.redemption_request_id
  WHERE requests.position_id = request_record.position_id
    AND requests.id <> NEW.redemption_request_id
    AND requests.status IN ('admitted', 'redeeming');
  SELECT * INTO capacity_record
  FROM calculate_lp_vault_redemption_admission_capacity(
    NEW.vault_id,
    NEW.admission_reconciliation_snapshot_id,
    NEW.admission_accounting_cycle_id,
    NEW.admission_checkpoint_id,
    NEW.redemption_request_id
  );
  SELECT * INTO event_record FROM lp_vault_accounting_events WHERE id = NEW.accounting_event_id;

  SELECT count(*)::BIGINT INTO older_waiting
  FROM lp_vault_redemption_requests
  WHERE vault_id = NEW.vault_id
    AND queue_sequence < request_record.queue_sequence
    AND status IN ('queued', 'waiting_liquidity');

  IF request_record.id IS NULL
    OR request_record.vault_id <> NEW.vault_id
    OR request_record.status NOT IN ('queued', 'waiting_liquidity')
    OR NEW.reserved_share_units <> request_record.requested_share_units
    OR NEW.reserved_share_units + already_reserved_share_units > available_share_units
    OR NEW.required_liquidity_micro_units IS DISTINCT FROM capacity_record.required_liquidity_micro_units
    OR NEW.available_liquidity_before_micro_units IS DISTINCT FROM capacity_record.available_liquidity_before_micro_units
    OR NEW.required_liquidity_micro_units > NEW.available_liquidity_before_micro_units
    OR older_waiting <> 0
    OR event_record.vault_id IS DISTINCT FROM NEW.vault_id
    OR event_record.event_type IS DISTINCT FROM 'redemption_admitted'
    OR event_record.entity_id IS DISTINCT FROM NEW.id
    OR event_record.payload->>'requestId' IS DISTINCT FROM NEW.redemption_request_id::text
    OR event_record.payload->>'reconciliationSnapshotId' IS DISTINCT FROM NEW.admission_reconciliation_snapshot_id::text
    OR event_record.payload->>'accountingCycleId' IS DISTINCT FROM NEW.admission_accounting_cycle_id::text
    OR event_record.payload->>'accountingCheckpointId' IS DISTINCT FROM NEW.admission_checkpoint_id::text
    OR event_record.payload->>'requiredLiquidityMicroUnits' IS DISTINCT FROM NEW.required_liquidity_micro_units::text
    OR event_record.payload->>'availableLiquidityBeforeMicroUnits' IS DISTINCT FROM NEW.available_liquidity_before_micro_units::text
  THEN
    RAISE EXCEPTION 'lp_vault_redemption_reserve_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_redemption_reserves_validate_trigger
BEFORE INSERT ON lp_vault_redemption_reserves
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_redemption_reserve();

CREATE TABLE lp_vault_redemption_reserve_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  cycle_id UUID NOT NULL,
  redemption_request_id UUID NOT NULL,
  checkpoint_id UUID NOT NULL REFERENCES lp_vault_nav_checkpoints(id),
  reserved_share_units NUMERIC(78, 0) NOT NULL CHECK (reserved_share_units > 0),
  reserved_amount_micro_units BIGINT NOT NULL CHECK (reserved_amount_micro_units >= 0),
  calculation_version TEXT NOT NULL CHECK (calculation_version = 'dynamic-pro-rata-floor-v1'),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, redemption_request_id),
  FOREIGN KEY (cycle_id, vault_id) REFERENCES lp_vault_daily_cycles(id, vault_id),
  FOREIGN KEY (redemption_request_id, vault_id) REFERENCES lp_vault_redemption_requests(id, vault_id)
);

CREATE TABLE lp_vault_redemption_payables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  redemption_request_id UUID NOT NULL UNIQUE,
  reserve_mark_id UUID NOT NULL UNIQUE REFERENCES lp_vault_redemption_reserve_marks(id),
  matured_share_units NUMERIC(78, 0) NOT NULL CHECK (matured_share_units > 0),
  matured_amount_micro_units BIGINT NOT NULL CHECK (matured_amount_micro_units >= 0),
  redeemed_cost_basis_micro_units BIGINT NOT NULL CHECK (redeemed_cost_basis_micro_units >= 0),
  finalized_redemption_pnl_micro_units BIGINT NOT NULL,
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  matured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (redemption_request_id, vault_id) REFERENCES lp_vault_redemption_requests(id, vault_id),
  CHECK (finalized_redemption_pnl_micro_units = matured_amount_micro_units - redeemed_cost_basis_micro_units)
);

CREATE TABLE lp_vault_liquidity_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  cycle_id UUID NOT NULL,
  checkpoint_id UUID NOT NULL UNIQUE REFERENCES lp_vault_nav_checkpoints(id),
  nav_deductions_micro_units BIGINT NOT NULL CHECK (nav_deductions_micro_units >= 0),
  active_redemption_reserve_micro_units BIGINT NOT NULL CHECK (active_redemption_reserve_micro_units >= 0),
  collateral_requirements_micro_units BIGINT NOT NULL CHECK (collateral_requirements_micro_units >= 0),
  free_liquidity_micro_units BIGINT NOT NULL CHECK (free_liquidity_micro_units >= 0),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, cycle_id),
  FOREIGN KEY (cycle_id, vault_id) REFERENCES lp_vault_daily_cycles(id, vault_id)
);

COMMENT ON TABLE lp_vault_redemption_reserve_marks IS
  'Per-cycle cash valuation of admitted active shares. Values move with canonical NAV until final burn.';
COMMENT ON TABLE lp_vault_liquidity_marks IS
  'Collateral view: gross unresolved payouts and active redemption reserves reduce liquidity, not economic NAV.';

CREATE TABLE lp_vault_share_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  position_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('mint', 'burn')),
  share_units NUMERIC(78, 0) NOT NULL CHECK (share_units > 0),
  cost_basis_micro_units BIGINT NOT NULL CHECK (cost_basis_micro_units >= 0),
  pending_deposit_id UUID REFERENCES lp_vault_pending_deposits(id),
  redemption_request_id UUID REFERENCES lp_vault_redemption_requests(id),
  checkpoint_id UUID NOT NULL REFERENCES lp_vault_nav_checkpoints(id),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (position_id, vault_id) REFERENCES lp_vault_share_positions(id, vault_id),
  CHECK (
    (event_type = 'mint' AND pending_deposit_id IS NOT NULL AND redemption_request_id IS NULL)
    OR (event_type = 'burn' AND pending_deposit_id IS NULL AND redemption_request_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX lp_vault_share_events_one_mint_per_deposit_idx
  ON lp_vault_share_events (pending_deposit_id)
  WHERE pending_deposit_id IS NOT NULL;

CREATE UNIQUE INDEX lp_vault_share_events_one_burn_per_redemption_idx
  ON lp_vault_share_events (redemption_request_id)
  WHERE redemption_request_id IS NOT NULL;

CREATE INDEX lp_vault_share_events_position_idx
  ON lp_vault_share_events (position_id, recorded_at, id);

CREATE TABLE lp_vault_share_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  position_id UUID NOT NULL,
  mint_share_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_share_events(id),
  original_share_units NUMERIC(78, 0) NOT NULL CHECK (original_share_units > 0),
  original_cost_basis_micro_units BIGINT NOT NULL CHECK (original_cost_basis_micro_units > 0),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (position_id, vault_id) REFERENCES lp_vault_share_positions(id, vault_id)
);

CREATE TABLE lp_vault_share_lot_burn_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  lot_id UUID NOT NULL REFERENCES lp_vault_share_lots(id),
  burn_share_event_id UUID NOT NULL REFERENCES lp_vault_share_events(id),
  burned_share_units NUMERIC(78, 0) NOT NULL CHECK (burned_share_units > 0),
  allocated_cost_basis_micro_units BIGINT NOT NULL CHECK (allocated_cost_basis_micro_units >= 0),
  prior_cumulative_burned_share_units NUMERIC(78, 0) NOT NULL CHECK (prior_cumulative_burned_share_units >= 0),
  cumulative_burned_share_units NUMERIC(78, 0) NOT NULL CHECK (cumulative_burned_share_units > 0),
  prior_cumulative_allocated_basis_micro_units BIGINT NOT NULL CHECK (prior_cumulative_allocated_basis_micro_units >= 0),
  cumulative_allocated_basis_micro_units BIGINT NOT NULL CHECK (cumulative_allocated_basis_micro_units >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lot_id, burn_share_event_id),
  CHECK (cumulative_burned_share_units = prior_cumulative_burned_share_units + burned_share_units),
  CHECK (cumulative_allocated_basis_micro_units = prior_cumulative_allocated_basis_micro_units + allocated_cost_basis_micro_units)
);

COMMENT ON TABLE lp_vault_share_lots IS
  'One immutable cost-basis lot per mint. Ownership follows the immutable non-transferable position.';
COMMENT ON TABLE lp_vault_share_lot_burn_allocations IS
  'Append-only FIFO lot consumption using cumulative-floor basis deltas, making split and combined burns equivalent.';

CREATE TABLE lp_vault_cycle_closing_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  cycle_id UUID NOT NULL UNIQUE,
  checkpoint_id UUID NOT NULL UNIQUE REFERENCES lp_vault_nav_checkpoints(id),
  activated_deposit_micro_units BIGINT NOT NULL CHECK (activated_deposit_micro_units >= 0),
  matured_redemption_micro_units BIGINT NOT NULL CHECK (matured_redemption_micro_units >= 0),
  protocol_rounding_dust_micro_units BIGINT NOT NULL CHECK (protocol_rounding_dust_micro_units >= 0),
  closing_economic_nav_micro_units BIGINT NOT NULL CHECK (closing_economic_nav_micro_units >= 0),
  closing_share_supply_units NUMERIC(78, 0) NOT NULL CHECK (closing_share_supply_units >= 0),
  accounting_event_id UUID NOT NULL UNIQUE REFERENCES lp_vault_accounting_events(id),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (cycle_id, vault_id) REFERENCES lp_vault_daily_cycles(id, vault_id)
);

COMMENT ON TABLE lp_vault_cycle_closing_states IS
  'Immutable post-mint and post-burn cycle state derived from the canonical pre-deposit checkpoint.';

CREATE TRIGGER lp_vault_cycle_closing_states_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_cycle_closing_states
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TRIGGER lp_vault_share_lots_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_share_lots
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TRIGGER lp_vault_share_lot_burn_allocations_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_share_lot_burn_allocations
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE OR REPLACE FUNCTION validate_lp_vault_accounting_inception()
RETURNS trigger AS $$
DECLARE
  reconciliation_record financial_reconciliation_snapshots%ROWTYPE;
  vault_record lp_vaults%ROWTYPE;
  expected_seed BIGINT;
BEGIN
  SELECT * INTO reconciliation_record FROM financial_reconciliation_snapshots
  WHERE id = NEW.source_reconciliation_snapshot_id;
  SELECT * INTO vault_record FROM lp_vaults WHERE id = NEW.vault_id;
  expected_seed := reconciliation_record.treasury_assets_micro_units
    - reconciliation_record.user_available_micro_units
    - reconciliation_record.user_claimable_micro_units
    - reconciliation_record.user_checkout_micro_units
    - reconciliation_record.pending_withdrawal_micro_units
    - reconciliation_record.open_stake_micro_units
    - reconciliation_record.open_reserve_micro_units;
  IF reconciliation_record.id IS NULL
    OR reconciliation_record.source IS DISTINCT FROM 'worker'
    OR reconciliation_record.unexplained_delta_micro_units <> 0
    OR reconciliation_record.chain_id <> vault_record.chain_id
    OR reconciliation_record.currency <> vault_record.currency
    OR lower(reconciliation_record.scope_treasury_address) IS DISTINCT FROM lower(vault_record.treasury_address)
    OR lower(reconciliation_record.scope_token_address) IS DISTINCT FROM lower(vault_record.token_address)
    OR reconciliation_record.observed_block_number IS NULL
    OR reconciliation_record.observed_block_hash IS NULL
    OR (
      CASE
        WHEN COALESCE(reconciliation_record.metrics->>'observedBlockTimestamp', '') ~ '^[0-9]+$' THEN
          to_timestamp((reconciliation_record.metrics->>'observedBlockTimestamp')::double precision)
            > reconciliation_record.created_at
          OR reconciliation_record.created_at
            - to_timestamp((reconciliation_record.metrics->>'observedBlockTimestamp')::double precision)
            > interval '5 minutes'
        ELSE TRUE
      END
    )
    OR NEW.inception_at <> reconciliation_record.created_at
    OR NEW.founder_seed_residual_micro_units <> expected_seed
  THEN RAISE EXCEPTION 'lp_vault_accounting_inception_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_accounting_inceptions_validate_trigger
BEFORE INSERT ON lp_vault_accounting_inceptions
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_accounting_inception();

CREATE OR REPLACE FUNCTION validate_lp_vault_protocol_fee_event()
RETURNS trigger AS $$
DECLARE
  inception_record lp_vault_accounting_inceptions%ROWTYPE;
  reserve_record ticket_reserves%ROWTYPE;
  current_balance BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lp-vault-accounting:' || NEW.vault_id::text, 0));
  SELECT * INTO inception_record FROM lp_vault_accounting_inceptions WHERE vault_id = NEW.vault_id;
  IF inception_record.vault_id IS NULL THEN RAISE EXCEPTION 'lp_vault_accounting_inception_missing'; END IF;
  IF NEW.event_type = 'accrual' THEN
    SELECT * INTO reserve_record FROM ticket_reserves WHERE id = NEW.ticket_reserve_id;
    IF reserve_record.id IS NULL OR reserve_record.ticket_id <> NEW.ticket_id
      OR reserve_record.accounting_mode <> 'house_book_usdc' OR reserve_record.currency <> 'USDC'
      OR reserve_record.created_at < inception_record.inception_at
      OR NEW.effective_at <> reserve_record.created_at
      OR NEW.amount_micro_units <> reserve_record.operation_fee_micro_units
    THEN RAISE EXCEPTION 'lp_vault_protocol_fee_accrual_mismatch'; END IF;
  ELSE
    SELECT COALESCE(sum(CASE WHEN event_type = 'accrual' THEN amount_micro_units ELSE -amount_micro_units END), 0)::BIGINT
    INTO current_balance FROM lp_vault_protocol_fee_events WHERE vault_id = NEW.vault_id;
    IF NEW.effective_at < inception_record.inception_at OR NEW.amount_micro_units > current_balance THEN
      RAISE EXCEPTION 'lp_vault_protocol_fee_release_exceeds_payable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_protocol_fee_events_validate_trigger
BEFORE INSERT ON lp_vault_protocol_fee_events
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_protocol_fee_event();

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
    OR NEW.evidence_time > ((cycle_record.cutoff_date::timestamp AT TIME ZONE 'UTC') + interval '5 minutes')
    OR NEW.mark_source <> 'gross_payout_fallback'
    OR event_record.vault_id <> NEW.vault_id
    OR event_record.event_type <> 'ticket_liability_marked'
    OR event_record.entity_id <> NEW.id
  THEN RAISE EXCEPTION 'lp_vault_ticket_liability_mark_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_ticket_liability_marks_validate_trigger
BEFORE INSERT ON lp_vault_ticket_liability_marks
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_ticket_liability_mark();

CREATE OR REPLACE FUNCTION validate_lp_vault_settlement_recognition()
RETURNS trigger AS $$
DECLARE
  summary_record ticket_settlement_summaries%ROWTYPE;
  reserve_record ticket_reserves%ROWTYPE;
  inception_record lp_vault_accounting_inceptions%ROWTYPE;
  event_record lp_vault_accounting_events%ROWTYPE;
BEGIN
  SELECT * INTO summary_record FROM ticket_settlement_summaries WHERE id = NEW.settlement_summary_id;
  SELECT * INTO reserve_record FROM ticket_reserves WHERE ticket_id = NEW.ticket_id;
  SELECT * INTO inception_record FROM lp_vault_accounting_inceptions WHERE vault_id = NEW.vault_id;
  SELECT * INTO event_record FROM lp_vault_accounting_events WHERE id = NEW.accounting_event_id;
  IF summary_record.id IS NULL
    OR summary_record.ticket_id <> NEW.ticket_id
    OR NEW.frozen_stake_micro_units <> summary_record.stake_micro_units
    OR NEW.final_payout_micro_units <> summary_record.final_payout_micro_units
    OR NEW.protocol_fee_micro_units <> summary_record.operation_fee_micro_units
    OR reserve_record.id IS NULL
    OR reserve_record.accounting_mode <> 'house_book_usdc'
    OR reserve_record.currency <> 'USDC'
    OR inception_record.vault_id IS NULL
    OR summary_record.created_at <= inception_record.inception_at
    OR NEW.recognized_at < summary_record.created_at
    OR event_record.vault_id <> NEW.vault_id
    OR event_record.event_type <> 'settlement_recognized'
    OR event_record.entity_id <> NEW.id
  THEN RAISE EXCEPTION 'lp_vault_settlement_recognition_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_settlement_recognitions_validate_trigger
BEFORE INSERT ON lp_vault_settlement_recognitions
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_settlement_recognition();

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
  vault_record lp_vaults%ROWTYPE;
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
    OR reconciliation_record.created_at < (cycle_cutoff::timestamp AT TIME ZONE 'UTC')
    OR reconciliation_record.created_at > ((cycle_cutoff::timestamp AT TIME ZONE 'UTC') + interval '5 minutes')
    OR (
      CASE
        WHEN COALESCE(reconciliation_record.metrics->>'observedBlockTimestamp', '') ~ '^[0-9]+$' THEN
          (reconciliation_record.metrics->>'observedBlockTimestamp')::NUMERIC
            < extract(epoch FROM (cycle_cutoff::timestamp AT TIME ZONE 'UTC'))
          OR (reconciliation_record.metrics->>'observedBlockTimestamp')::NUMERIC
            > extract(epoch FROM ((cycle_cutoff::timestamp AT TIME ZONE 'UTC') + interval '5 minutes'))
          OR to_timestamp((reconciliation_record.metrics->>'observedBlockTimestamp')::double precision)
            > reconciliation_record.created_at
        ELSE TRUE
      END
    )
  THEN
    RAISE EXCEPTION 'lp_vault_reconciliation_not_canonical';
  END IF;

  expected_senior := reconciliation_record.user_available_micro_units +
    reconciliation_record.user_claimable_micro_units +
    reconciliation_record.user_checkout_micro_units +
    reconciliation_record.pending_withdrawal_micro_units;
  SELECT count(*)::BIGINT, COALESCE(sum(gross_payout_micro_units), 0)::BIGINT,
    COALESCE(sum(marked_liability_micro_units), 0)::BIGINT
  INTO marked_ticket_count, expected_gross, expected_marked
  FROM lp_vault_ticket_liability_marks
  WHERE cycle_id = NEW.cycle_id;

  SELECT count(*)::BIGINT INTO expected_open_ticket_count
  FROM ticket_reserves reserves
  WHERE reserves.accounting_mode = 'house_book_usdc'
    AND reserves.currency = 'USDC'
    AND reserves.created_at <= reconciliation_record.created_at
    AND NOT EXISTS (
      SELECT 1 FROM ticket_settlement_summaries summaries
      WHERE summaries.ticket_id = reserves.ticket_id
        AND summaries.created_at <= reconciliation_record.created_at
    );

  SELECT COALESCE(sum(CASE WHEN event_type = 'accrual' THEN amount_micro_units ELSE -amount_micro_units END), 0)::BIGINT
  INTO expected_protocol_fees
  FROM lp_vault_protocol_fee_events
  WHERE vault_id = NEW.vault_id AND effective_at <= reconciliation_record.created_at;
  expected_protocol_fees := expected_protocol_fees + COALESCE((
    SELECT sum(protocol_rounding_dust_micro_units)::BIGINT
    FROM lp_vault_cycle_closing_states
    WHERE vault_id = NEW.vault_id AND closed_at <= reconciliation_record.created_at
  ), 0);

  SELECT COALESCE(sum(amount_micro_units), 0)::BIGINT INTO expected_expenses
  FROM lp_vault_approved_expense_accruals
  WHERE vault_id = NEW.vault_id AND accrued_on <= cycle_cutoff;

  SELECT COALESCE(sum(amount_micro_units), 0)::BIGINT INTO expected_pending_deposits
  FROM lp_vault_pending_deposits
  WHERE vault_id = NEW.vault_id AND status = 'pending';

  SELECT COALESCE(sum(matured_amount_micro_units), 0)::BIGINT INTO expected_matured_payables
  FROM lp_vault_redemption_payables
  WHERE vault_id = NEW.vault_id;

  IF NEW.canonical_block_number <> reconciliation_record.observed_block_number
    OR lower(NEW.canonical_block_hash) IS DISTINCT FROM lower(reconciliation_record.observed_block_hash)
    OR NEW.senior_user_obligations_micro_units <> expected_senior
    OR marked_ticket_count <> expected_open_ticket_count
    OR EXISTS (
      SELECT 1 FROM lp_vault_ticket_liability_marks ticket_marks
      WHERE ticket_marks.cycle_id = NEW.cycle_id
        AND ticket_marks.evidence_time <> reconciliation_record.created_at
    )
    OR NEW.gross_unresolved_payouts_micro_units <> expected_gross
    OR NEW.marked_unresolved_liability_micro_units <> expected_marked
    OR NEW.protocol_fee_payable_micro_units <> expected_protocol_fees
    OR NEW.approved_expense_payable_micro_units <> expected_expenses
    OR NEW.pending_deposit_liability_micro_units <> expected_pending_deposits
    OR NEW.matured_redemption_payable_micro_units <> expected_matured_payables
  THEN
    RAISE EXCEPTION 'lp_vault_liability_mark_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_liability_marks_validate_trigger
BEFORE INSERT ON lp_vault_liability_marks
FOR EACH ROW
EXECUTE FUNCTION validate_lp_vault_liability_mark();

CREATE TRIGGER lp_vault_liability_marks_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_liability_marks
FOR EACH ROW
EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE OR REPLACE FUNCTION validate_lp_vault_nav_checkpoint()
RETURNS trigger AS $$
DECLARE
  mark_record lp_vault_liability_marks%ROWTYPE;
  reconciliation_record financial_reconciliation_snapshots%ROWTYPE;
  event_record lp_vault_accounting_events%ROWTYPE;
  latest_checkpoint UUID;
  calculated_supply NUMERIC(78, 0);
  calculated_estimated_pnl BIGINT;
  calculated_finalized_pnl BIGINT;
  unrecognized_settlement_count BIGINT;
BEGIN
  SELECT * INTO mark_record FROM lp_vault_liability_marks WHERE id = NEW.liability_mark_id;
  SELECT * INTO reconciliation_record
  FROM financial_reconciliation_snapshots
  WHERE id = NEW.source_reconciliation_snapshot_id;
  SELECT * INTO event_record FROM lp_vault_accounting_events WHERE id = NEW.accounting_event_id;
  SELECT id INTO latest_checkpoint
  FROM lp_vault_nav_checkpoints
  WHERE vault_id = NEW.vault_id
  ORDER BY accounting_version DESC
  LIMIT 1;
  SELECT COALESCE(sum(CASE WHEN event_type = 'mint' THEN share_units ELSE -share_units END), 0)::NUMERIC(78, 0)
  INTO calculated_supply
  FROM lp_vault_share_events
  WHERE vault_id = NEW.vault_id;
  SELECT COALESCE(sum(stake_micro_units - marked_liability_micro_units), 0)::BIGINT
  INTO calculated_estimated_pnl
  FROM lp_vault_ticket_liability_marks
  WHERE cycle_id = NEW.cycle_id;
  SELECT COALESCE(sum(finalized_pnl_micro_units), 0)::BIGINT
  INTO calculated_finalized_pnl
  FROM lp_vault_settlement_recognitions
  WHERE vault_id = NEW.vault_id;
  SELECT count(*)::BIGINT
  INTO unrecognized_settlement_count
  FROM ticket_settlement_summaries summaries
  JOIN ticket_reserves reserves ON reserves.ticket_id = summaries.ticket_id
  JOIN lp_vault_accounting_inceptions inception ON inception.vault_id = NEW.vault_id
  WHERE reserves.accounting_mode = 'house_book_usdc'
    AND reserves.currency = 'USDC'
    AND summaries.created_at > inception.inception_at
    AND summaries.created_at <= reconciliation_record.created_at
    AND NOT EXISTS (
      SELECT 1 FROM lp_vault_settlement_recognitions recognitions
      WHERE recognitions.vault_id = NEW.vault_id
        AND recognitions.settlement_summary_id = summaries.id
    );

  IF mark_record.id IS NULL
    OR mark_record.vault_id <> NEW.vault_id
    OR mark_record.cycle_id <> NEW.cycle_id
    OR mark_record.source_reconciliation_snapshot_id <> NEW.source_reconciliation_snapshot_id
    OR event_record.id IS NULL
    OR event_record.vault_id <> NEW.vault_id
    OR event_record.event_type <> 'nav_checkpointed'
    OR event_record.entity_id <> NEW.id
    OR event_record.book_version <> NEW.accounting_version
    OR NEW.prior_checkpoint_id IS DISTINCT FROM latest_checkpoint
    OR NEW.share_supply_units <> calculated_supply
    OR NEW.estimated_pnl_micro_units <> calculated_estimated_pnl
    OR NEW.finalized_pnl_micro_units <> calculated_finalized_pnl
    OR unrecognized_settlement_count <> 0
    OR reconciliation_record.id IS NULL
    OR reconciliation_record.id <> mark_record.source_reconciliation_snapshot_id
    OR NEW.gross_assets_micro_units <> reconciliation_record.treasury_assets_micro_units
    OR NEW.gross_assets_micro_units < mark_record.nav_deductions_micro_units
    OR NEW.net_asset_value_micro_units <> NEW.gross_assets_micro_units - mark_record.nav_deductions_micro_units
    OR (NEW.share_supply_units = 0 AND NEW.net_asset_value_micro_units > 0)
  THEN
    RAISE EXCEPTION 'lp_vault_nav_checkpoint_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_nav_checkpoints_validate_trigger
BEFORE INSERT ON lp_vault_nav_checkpoints
FOR EACH ROW
EXECUTE FUNCTION validate_lp_vault_nav_checkpoint();

CREATE TRIGGER lp_vault_nav_checkpoints_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_nav_checkpoints
FOR EACH ROW
EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE OR REPLACE FUNCTION validate_lp_vault_redemption_reserve_mark()
RETURNS trigger AS $$
DECLARE
  request_record lp_vault_redemption_requests%ROWTYPE;
  reserve_record lp_vault_redemption_reserves%ROWTYPE;
  checkpoint_record lp_vault_nav_checkpoints%ROWTYPE;
  reconciliation_record financial_reconciliation_snapshots%ROWTYPE;
  request_status_at_cutoff TEXT;
  expected_amount BIGINT;
BEGIN
  SELECT * INTO request_record FROM lp_vault_redemption_requests WHERE id = NEW.redemption_request_id;
  SELECT * INTO reserve_record FROM lp_vault_redemption_reserves WHERE redemption_request_id = NEW.redemption_request_id;
  SELECT * INTO checkpoint_record FROM lp_vault_nav_checkpoints WHERE id = NEW.checkpoint_id;
  SELECT * INTO reconciliation_record FROM financial_reconciliation_snapshots
  WHERE id = checkpoint_record.source_reconciliation_snapshot_id;
  SELECT history.to_status INTO request_status_at_cutoff
  FROM lp_vault_redemption_request_history history
  WHERE history.redemption_request_id = NEW.redemption_request_id
    AND history.recorded_at <= reconciliation_record.created_at
  ORDER BY history.recorded_at DESC, history.id DESC
  LIMIT 1;
  IF checkpoint_record.share_supply_units <= 0 THEN RAISE EXCEPTION 'lp_vault_redemption_supply_missing'; END IF;
  expected_amount := div(
    NEW.reserved_share_units::NUMERIC * checkpoint_record.net_asset_value_micro_units::NUMERIC,
    checkpoint_record.share_supply_units::NUMERIC
  )::BIGINT;
  IF request_status_at_cutoff NOT IN ('admitted', 'redeeming')
    OR request_record.vault_id <> NEW.vault_id
    OR reserve_record.reserved_share_units <> NEW.reserved_share_units
    OR checkpoint_record.vault_id <> NEW.vault_id
    OR checkpoint_record.cycle_id <> NEW.cycle_id
    OR NEW.reserved_amount_micro_units <> expected_amount
  THEN RAISE EXCEPTION 'lp_vault_redemption_reserve_mark_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_redemption_reserve_marks_validate_trigger
BEFORE INSERT ON lp_vault_redemption_reserve_marks
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_redemption_reserve_mark();

CREATE OR REPLACE FUNCTION validate_lp_vault_liquidity_mark()
RETURNS trigger AS $$
DECLARE
  checkpoint_record lp_vault_nav_checkpoints%ROWTYPE;
  liability_record lp_vault_liability_marks%ROWTYPE;
  expected_active BIGINT;
  active_request_count BIGINT;
  reserve_mark_count BIGINT;
  expected_requirements BIGINT;
BEGIN
  SELECT * INTO checkpoint_record FROM lp_vault_nav_checkpoints WHERE id = NEW.checkpoint_id;
  SELECT * INTO liability_record FROM lp_vault_liability_marks WHERE id = checkpoint_record.liability_mark_id;
  SELECT count(*)::BIGINT, COALESCE(sum(reserved_amount_micro_units), 0)::BIGINT
  INTO reserve_mark_count, expected_active
  FROM lp_vault_redemption_reserve_marks WHERE cycle_id = NEW.cycle_id;
  SELECT count(*)::BIGINT INTO active_request_count
  FROM lp_vault_redemption_requests requests
  WHERE requests.vault_id = NEW.vault_id
    AND (
      SELECT history.to_status
      FROM lp_vault_redemption_request_history history
      JOIN financial_reconciliation_snapshots reconciliation
        ON reconciliation.id = checkpoint_record.source_reconciliation_snapshot_id
      WHERE history.redemption_request_id = requests.id
        AND history.recorded_at <= reconciliation.created_at
      ORDER BY history.recorded_at DESC, history.id DESC
      LIMIT 1
    ) IN ('admitted', 'redeeming');
  expected_requirements := liability_record.nav_deductions_micro_units
    - liability_record.marked_unresolved_liability_micro_units
    + liability_record.gross_unresolved_payouts_micro_units
    + expected_active;
  IF checkpoint_record.vault_id <> NEW.vault_id
    OR checkpoint_record.cycle_id <> NEW.cycle_id
    OR reserve_mark_count <> active_request_count
    OR NEW.nav_deductions_micro_units <> liability_record.nav_deductions_micro_units
    OR NEW.active_redemption_reserve_micro_units <> expected_active
    OR NEW.collateral_requirements_micro_units <> expected_requirements
    OR checkpoint_record.gross_assets_micro_units < expected_requirements
    OR NEW.free_liquidity_micro_units <> checkpoint_record.gross_assets_micro_units - expected_requirements
  THEN RAISE EXCEPTION 'lp_vault_liquidity_mark_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_liquidity_marks_validate_trigger
BEFORE INSERT ON lp_vault_liquidity_marks
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_liquidity_mark();

CREATE OR REPLACE FUNCTION validate_lp_vault_redemption_payable()
RETURNS trigger AS $$
DECLARE
  request_record lp_vault_redemption_requests%ROWTYPE;
  reserve_mark_record lp_vault_redemption_reserve_marks%ROWTYPE;
  checkpoint_record lp_vault_nav_checkpoints%ROWTYPE;
  reconciliation_record financial_reconciliation_snapshots%ROWTYPE;
  allocated_shares NUMERIC(78, 0);
  allocated_basis BIGINT;
BEGIN
  SELECT * INTO request_record FROM lp_vault_redemption_requests WHERE id = NEW.redemption_request_id;
  SELECT * INTO reserve_mark_record FROM lp_vault_redemption_reserve_marks WHERE id = NEW.reserve_mark_id;
  SELECT * INTO checkpoint_record FROM lp_vault_nav_checkpoints WHERE id = reserve_mark_record.checkpoint_id;
  SELECT * INTO reconciliation_record FROM financial_reconciliation_snapshots
  WHERE id = checkpoint_record.source_reconciliation_snapshot_id;
  SELECT COALESCE(sum(allocations.burned_share_units), 0)::NUMERIC(78, 0),
    COALESCE(sum(allocations.allocated_cost_basis_micro_units), 0)::BIGINT
  INTO allocated_shares, allocated_basis
  FROM lp_vault_share_lot_burn_allocations allocations
  JOIN lp_vault_share_events burns ON burns.id = allocations.burn_share_event_id
  WHERE burns.redemption_request_id = NEW.redemption_request_id;
  IF request_record.status <> 'redeeming'
    OR request_record.vault_id <> NEW.vault_id
    OR reserve_mark_record.redemption_request_id <> NEW.redemption_request_id
    OR reconciliation_record.created_at < request_record.redemption_ends_at
    OR NEW.matured_share_units <> request_record.requested_share_units
    OR NEW.matured_amount_micro_units <> reserve_mark_record.reserved_amount_micro_units
    OR allocated_shares <> NEW.matured_share_units
    OR NEW.redeemed_cost_basis_micro_units <> allocated_basis
  THEN RAISE EXCEPTION 'lp_vault_redemption_payable_mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_redemption_payables_validate_trigger
BEFORE INSERT ON lp_vault_redemption_payables
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_redemption_payable();

CREATE OR REPLACE FUNCTION validate_lp_vault_share_event()
RETURNS trigger AS $$
DECLARE
  position_record lp_vault_share_positions%ROWTYPE;
  deposit_record lp_vault_pending_deposits%ROWTYPE;
  request_record lp_vault_redemption_requests%ROWTYPE;
  checkpoint_record lp_vault_nav_checkpoints%ROWTYPE;
  cycle_record lp_vault_daily_cycles%ROWTYPE;
  accounting_event_record lp_vault_accounting_events%ROWTYPE;
  expected_shares NUMERIC(78, 0);
  current_shares NUMERIC(78, 0);
  owner_total_deposit_micro_units BIGINT;
  owner_minted_share_units NUMERIC(78, 0);
BEGIN
  SELECT * INTO position_record FROM lp_vault_share_positions WHERE id = NEW.position_id;
  SELECT * INTO checkpoint_record FROM lp_vault_nav_checkpoints WHERE id = NEW.checkpoint_id;
  SELECT * INTO cycle_record FROM lp_vault_daily_cycles WHERE id = checkpoint_record.cycle_id;
  SELECT * INTO accounting_event_record FROM lp_vault_accounting_events WHERE id = NEW.accounting_event_id;
  IF position_record.vault_id <> NEW.vault_id OR checkpoint_record.vault_id <> NEW.vault_id THEN
    RAISE EXCEPTION 'lp_vault_share_event_scope_mismatch';
  END IF;
  IF NEW.event_type = 'mint' THEN
    SELECT * INTO deposit_record FROM lp_vault_pending_deposits WHERE id = NEW.pending_deposit_id;
    SELECT COALESCE(sum(amount_micro_units), 0)::BIGINT
    INTO owner_total_deposit_micro_units
    FROM lp_vault_pending_deposits deposits
    WHERE deposits.vault_id = NEW.vault_id
      AND deposits.user_id = position_record.user_id
      AND deposits.eligible_after_cutoff <= cycle_record.cutoff_date
      AND (
        deposits.status = 'pending'
        OR deposits.activation_checkpoint_id = NEW.checkpoint_id
      );
    IF checkpoint_record.share_supply_units = 0 AND checkpoint_record.net_asset_value_micro_units = 0 THEN
      owner_minted_share_units := owner_total_deposit_micro_units::NUMERIC * 1000000000000::NUMERIC;
    ELSIF checkpoint_record.share_supply_units <= 0 OR checkpoint_record.net_asset_value_micro_units <= 0 THEN
      RAISE EXCEPTION 'lp_vault_share_price_unavailable';
    ELSE
      owner_minted_share_units := div(
        owner_total_deposit_micro_units::NUMERIC * checkpoint_record.share_supply_units::NUMERIC,
        checkpoint_record.net_asset_value_micro_units::NUMERIC
      )::NUMERIC(78, 0);
    END IF;
    WITH eligible AS (
      SELECT deposits.id, deposits.amount_micro_units
      FROM lp_vault_pending_deposits deposits
      WHERE deposits.vault_id = NEW.vault_id
        AND deposits.user_id = position_record.user_id
        AND deposits.eligible_after_cutoff <= cycle_record.cutoff_date
        AND (
          deposits.status = 'pending'
          OR deposits.activation_checkpoint_id = NEW.checkpoint_id
        )
    ), ranked AS (
      SELECT id,
        div(owner_minted_share_units * amount_micro_units::NUMERIC,
          owner_total_deposit_micro_units::NUMERIC)::NUMERIC(78, 0) AS base_shares,
        row_number() OVER (
          ORDER BY mod(owner_minted_share_units * amount_micro_units::NUMERIC,
            owner_total_deposit_micro_units::NUMERIC) DESC, id
        ) AS allocation_rank,
        sum(div(owner_minted_share_units * amount_micro_units::NUMERIC,
          owner_total_deposit_micro_units::NUMERIC)) OVER ()::NUMERIC(78, 0) AS allocated_base_shares
      FROM eligible
    )
    SELECT base_shares + CASE
      WHEN allocation_rank <= owner_minted_share_units - allocated_base_shares THEN 1
      ELSE 0
    END
    INTO expected_shares
    FROM ranked
    WHERE id = deposit_record.id;
    IF deposit_record.vault_id <> NEW.vault_id
      OR deposit_record.user_id <> position_record.user_id
      OR deposit_record.status <> 'pending'
      OR deposit_record.eligible_after_cutoff > cycle_record.cutoff_date
      OR owner_total_deposit_micro_units <= 0
      OR owner_minted_share_units <= 0
      OR expected_shares IS NULL
      OR NEW.share_units <> expected_shares
      OR NEW.cost_basis_micro_units <> deposit_record.amount_micro_units
      OR accounting_event_record.vault_id <> NEW.vault_id
      OR accounting_event_record.event_type <> 'deposit_activated'
      OR accounting_event_record.entity_id <> NEW.id
      OR NOT accounting_event_record.payload ?& ARRAY[
        'depositId','userId','positionId','checkpointId','lotId','amountMicroUnits','shareUnits'
      ]
      OR accounting_event_record.payload->>'depositId' <> NEW.pending_deposit_id::TEXT
      OR accounting_event_record.payload->>'userId' <> position_record.user_id::TEXT
      OR accounting_event_record.payload->>'positionId' <> NEW.position_id::TEXT
      OR accounting_event_record.payload->>'checkpointId' <> NEW.checkpoint_id::TEXT
      OR (accounting_event_record.payload->>'amountMicroUnits')::BIGINT <> NEW.cost_basis_micro_units
      OR (accounting_event_record.payload->>'shareUnits')::NUMERIC <> NEW.share_units
    THEN RAISE EXCEPTION 'lp_vault_share_mint_mismatch'; END IF;
  ELSE
    SELECT * INTO request_record FROM lp_vault_redemption_requests WHERE id = NEW.redemption_request_id;
    SELECT COALESCE(sum(CASE WHEN event_type = 'mint' THEN share_units ELSE -share_units END), 0)::NUMERIC(78, 0)
    INTO current_shares FROM lp_vault_share_events WHERE position_id = NEW.position_id;
    IF request_record.vault_id <> NEW.vault_id
      OR request_record.position_id <> NEW.position_id
      OR request_record.status <> 'redeeming'
      OR NEW.share_units <> request_record.requested_share_units
      OR NEW.share_units > current_shares
      OR accounting_event_record.vault_id <> NEW.vault_id
      OR accounting_event_record.event_type <> 'redemption_payable_matured'
      OR accounting_event_record.entity_id <> NEW.id
      OR NOT accounting_event_record.payload ?& ARRAY[
        'requestId','userId','positionId','checkpointId','payableId','shareUnits',
        'payableMicroUnits','costBasisMicroUnits','allocations'
      ]
      OR accounting_event_record.payload->>'requestId' <> NEW.redemption_request_id::TEXT
      OR accounting_event_record.payload->>'userId' <> position_record.user_id::TEXT
      OR accounting_event_record.payload->>'positionId' <> NEW.position_id::TEXT
      OR accounting_event_record.payload->>'checkpointId' <> NEW.checkpoint_id::TEXT
      OR (accounting_event_record.payload->>'shareUnits')::NUMERIC <> NEW.share_units
      OR (accounting_event_record.payload->>'costBasisMicroUnits')::BIGINT <> NEW.cost_basis_micro_units
      OR jsonb_typeof(accounting_event_record.payload->'allocations') <> 'array'
    THEN RAISE EXCEPTION 'lp_vault_share_burn_mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_share_events_validate_trigger
BEFORE INSERT ON lp_vault_share_events
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_share_event();

CREATE OR REPLACE FUNCTION validate_lp_vault_lot_burn_allocation()
RETURNS trigger AS $$
DECLARE
  lot_record lp_vault_share_lots%ROWTYPE;
  burn_record lp_vault_share_events%ROWTYPE;
  prior_shares NUMERIC(78, 0);
  prior_basis BIGINT;
  expected_cumulative_basis BIGINT;
  earlier_unburned BIGINT;
BEGIN
  SELECT * INTO lot_record FROM lp_vault_share_lots WHERE id = NEW.lot_id;
  SELECT * INTO burn_record FROM lp_vault_share_events WHERE id = NEW.burn_share_event_id;
  SELECT COALESCE(max(cumulative_burned_share_units), 0)::NUMERIC(78, 0),
    COALESCE(max(cumulative_allocated_basis_micro_units), 0)::BIGINT
  INTO prior_shares, prior_basis
  FROM lp_vault_share_lot_burn_allocations WHERE lot_id = NEW.lot_id;
  SELECT count(*)::BIGINT INTO earlier_unburned
  FROM lp_vault_share_lots earlier
  WHERE earlier.position_id = lot_record.position_id
    AND (earlier.opened_at, earlier.id) < (lot_record.opened_at, lot_record.id)
    AND COALESCE((SELECT max(a.cumulative_burned_share_units)
      FROM lp_vault_share_lot_burn_allocations a WHERE a.lot_id = earlier.id), 0) < earlier.original_share_units;

  IF NEW.vault_id <> lot_record.vault_id
    OR burn_record.event_type <> 'burn'
    OR burn_record.position_id <> lot_record.position_id
    OR NEW.prior_cumulative_burned_share_units <> prior_shares
    OR NEW.prior_cumulative_allocated_basis_micro_units <> prior_basis
    OR NEW.cumulative_burned_share_units > lot_record.original_share_units
    OR earlier_unburned <> 0
  THEN RAISE EXCEPTION 'lp_vault_lot_burn_allocation_mismatch'; END IF;

  IF NEW.cumulative_burned_share_units = lot_record.original_share_units THEN
    expected_cumulative_basis := lot_record.original_cost_basis_micro_units;
  ELSE
    expected_cumulative_basis := div(
      lot_record.original_cost_basis_micro_units::NUMERIC * NEW.cumulative_burned_share_units::NUMERIC,
      lot_record.original_share_units::NUMERIC
    )::BIGINT;
  END IF;
  IF NEW.cumulative_allocated_basis_micro_units <> expected_cumulative_basis THEN
    RAISE EXCEPTION 'lp_vault_lot_cost_basis_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_share_lot_burn_allocations_validate_trigger
BEFORE INSERT ON lp_vault_share_lot_burn_allocations
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_lot_burn_allocation();

CREATE OR REPLACE FUNCTION validate_lp_vault_completed_share_event()
RETURNS trigger AS $$
DECLARE
  allocated_shares NUMERIC(78, 0);
  allocated_basis BIGINT;
  lot_record lp_vault_share_lots%ROWTYPE;
  accounting_event_record lp_vault_accounting_events%ROWTYPE;
  payable_record lp_vault_redemption_payables%ROWTYPE;
  expected_allocations JSONB;
BEGIN
  SELECT * INTO accounting_event_record FROM lp_vault_accounting_events WHERE id = NEW.accounting_event_id;
  IF NEW.event_type = 'mint' THEN
    SELECT * INTO lot_record FROM lp_vault_share_lots WHERE mint_share_event_id = NEW.id;
    IF lot_record.id IS NULL OR lot_record.vault_id <> NEW.vault_id
      OR lot_record.position_id <> NEW.position_id
      OR lot_record.original_share_units <> NEW.share_units
      OR lot_record.original_cost_basis_micro_units <> NEW.cost_basis_micro_units
      OR accounting_event_record.payload->>'lotId' <> lot_record.id::TEXT
    THEN RAISE EXCEPTION 'lp_vault_mint_lot_missing'; END IF;
  ELSE
    SELECT COALESCE(sum(burned_share_units), 0)::NUMERIC(78, 0),
      COALESCE(sum(allocated_cost_basis_micro_units), 0)::BIGINT
    INTO allocated_shares, allocated_basis
    FROM lp_vault_share_lot_burn_allocations WHERE burn_share_event_id = NEW.id;
    IF allocated_shares <> NEW.share_units OR allocated_basis <> NEW.cost_basis_micro_units THEN
      RAISE EXCEPTION 'lp_vault_burn_allocation_incomplete';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'lotId', allocations.lot_id::TEXT,
      'burnedShareUnits', allocations.burned_share_units::TEXT,
      'allocatedCostBasisMicroUnits', allocations.allocated_cost_basis_micro_units::TEXT,
      'priorCumulativeBurnedShareUnits', allocations.prior_cumulative_burned_share_units::TEXT,
      'cumulativeBurnedShareUnits', allocations.cumulative_burned_share_units::TEXT,
      'priorCumulativeAllocatedBasisMicroUnits', allocations.prior_cumulative_allocated_basis_micro_units::TEXT,
      'cumulativeAllocatedBasisMicroUnits', allocations.cumulative_allocated_basis_micro_units::TEXT
    ) ORDER BY lots.opened_at, lots.id), '[]'::JSONB)
    INTO expected_allocations
    FROM lp_vault_share_lot_burn_allocations allocations
    JOIN lp_vault_share_lots lots ON lots.id = allocations.lot_id
    WHERE allocations.burn_share_event_id = NEW.id;
    SELECT * INTO payable_record FROM lp_vault_redemption_payables
    WHERE accounting_event_id = NEW.accounting_event_id;
    IF payable_record.id IS NULL
      OR payable_record.vault_id <> NEW.vault_id
      OR payable_record.redemption_request_id <> NEW.redemption_request_id
      OR payable_record.matured_share_units <> NEW.share_units
      OR payable_record.redeemed_cost_basis_micro_units <> NEW.cost_basis_micro_units
      OR accounting_event_record.payload->>'payableId' <> payable_record.id::TEXT
      OR (accounting_event_record.payload->>'payableMicroUnits')::BIGINT <> payable_record.matured_amount_micro_units
      OR accounting_event_record.payload->'allocations' <> expected_allocations
    THEN RAISE EXCEPTION 'lp_vault_burn_projection_mismatch'; END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER lp_vault_share_events_completed_trigger
AFTER INSERT ON lp_vault_share_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_completed_share_event();

CREATE OR REPLACE FUNCTION validate_lp_vault_cycle_closing_state()
RETURNS trigger AS $$
DECLARE
  checkpoint_record lp_vault_nav_checkpoints%ROWTYPE;
  event_record lp_vault_accounting_events%ROWTYPE;
  expected_deposits BIGINT;
  expected_redemptions BIGINT;
  expected_burned_share_units NUMERIC(78, 0);
  expected_supply NUMERIC(78, 0);
  expected_protocol_dust BIGINT;
  expected_nav BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lp-vault-accounting:' || NEW.vault_id::text, 0));
  SELECT * INTO checkpoint_record FROM lp_vault_nav_checkpoints WHERE id = NEW.checkpoint_id;
  SELECT * INTO event_record FROM lp_vault_accounting_events WHERE id = NEW.accounting_event_id;
  SELECT COALESCE(sum(amount_micro_units), 0)::BIGINT
  INTO expected_deposits
  FROM lp_vault_pending_deposits
  WHERE vault_id = NEW.vault_id
    AND status = 'active'
    AND activation_checkpoint_id = NEW.checkpoint_id;
  SELECT COALESCE(sum(payables.matured_amount_micro_units), 0)::BIGINT,
    COALESCE(sum(payables.matured_share_units), 0)::NUMERIC(78, 0)
  INTO expected_redemptions, expected_burned_share_units
  FROM lp_vault_redemption_payables payables
  JOIN lp_vault_redemption_reserve_marks marks ON marks.id = payables.reserve_mark_id
  WHERE payables.vault_id = NEW.vault_id
    AND marks.checkpoint_id = NEW.checkpoint_id;
  SELECT COALESCE(sum(CASE WHEN event_type = 'mint' THEN share_units ELSE -share_units END), 0)::NUMERIC(78, 0)
  INTO expected_supply
  FROM lp_vault_share_events
  WHERE vault_id = NEW.vault_id;

  IF checkpoint_record.share_supply_units > 0
    AND expected_burned_share_units = checkpoint_record.share_supply_units
  THEN
    expected_protocol_dust := div(
      expected_burned_share_units * checkpoint_record.net_asset_value_micro_units::NUMERIC,
      checkpoint_record.share_supply_units
    )::BIGINT - expected_redemptions;
  ELSE
    expected_protocol_dust := 0;
  END IF;
  expected_nav := checkpoint_record.net_asset_value_micro_units
    + expected_deposits - expected_redemptions - expected_protocol_dust;

  IF checkpoint_record.id IS NULL
    OR checkpoint_record.vault_id <> NEW.vault_id
    OR checkpoint_record.cycle_id <> NEW.cycle_id
    OR event_record.id IS NULL
    OR event_record.vault_id <> NEW.vault_id
    OR event_record.event_type <> 'cycle_closed'
    OR event_record.entity_id <> NEW.id
    OR NEW.activated_deposit_micro_units <> expected_deposits
    OR NEW.matured_redemption_micro_units <> expected_redemptions
    OR NEW.protocol_rounding_dust_micro_units <> expected_protocol_dust
    OR NEW.closing_economic_nav_micro_units <> expected_nav
    OR NEW.closing_share_supply_units <> expected_supply
    OR expected_nav < 0
    OR (expected_supply = 0 AND expected_nav > 0)
  THEN
    RAISE EXCEPTION 'lp_vault_cycle_closing_state_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_cycle_closing_states_validate_trigger
BEFORE INSERT ON lp_vault_cycle_closing_states
FOR EACH ROW EXECUTE FUNCTION validate_lp_vault_cycle_closing_state();

CREATE TRIGGER lp_vault_share_positions_immutable_trigger
BEFORE UPDATE OR DELETE ON lp_vault_share_positions
FOR EACH ROW
EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TRIGGER lp_vault_redemption_request_history_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_redemption_request_history
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TRIGGER lp_vault_redemption_reserve_marks_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_redemption_reserve_marks
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TRIGGER lp_vault_redemption_payables_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_redemption_payables
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TRIGGER lp_vault_liquidity_marks_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_liquidity_marks
FOR EACH ROW EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TRIGGER lp_vault_redemption_reserves_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_redemption_reserves
FOR EACH ROW
EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE TRIGGER lp_vault_share_events_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_share_events
FOR EACH ROW
EXECUTE FUNCTION prevent_lp_vault_accounting_evidence_mutation();

CREATE OR REPLACE FUNCTION enforce_lp_vault_daily_cycle_transition()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lp_vault_daily_cycle_cannot_be_deleted'; END IF;
  IF OLD.vault_id IS DISTINCT FROM NEW.vault_id
    OR OLD.cutoff_date IS DISTINCT FROM NEW.cutoff_date
    OR OLD.opened_event_id IS DISTINCT FROM NEW.opened_event_id
    OR OLD.opened_at IS DISTINCT FROM NEW.opened_at
  THEN RAISE EXCEPTION 'lp_vault_daily_cycle_identity_is_immutable'; END IF;

  IF NOT (
    (OLD.status = 'open' AND NEW.status = 'marked' AND EXISTS (
      SELECT 1 FROM lp_vault_liability_marks WHERE cycle_id = OLD.id
    ))
    OR (OLD.status = 'marked' AND NEW.status = 'checkpointed' AND EXISTS (
      SELECT 1 FROM lp_vault_nav_checkpoints checkpoints
      JOIN lp_vault_liquidity_marks liquidity ON liquidity.checkpoint_id = checkpoints.id
      WHERE checkpoints.cycle_id = OLD.id
    ))
    OR (OLD.status = 'checkpointed' AND NEW.status = 'closed' AND EXISTS (
      SELECT 1 FROM lp_vault_cycle_closing_states closing
      WHERE closing.cycle_id = OLD.id AND closing.vault_id = OLD.vault_id
    ))
  ) THEN RAISE EXCEPTION 'invalid_lp_vault_daily_cycle_transition:%:%', OLD.status, NEW.status; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_daily_cycles_transition_trigger
BEFORE UPDATE OR DELETE ON lp_vault_daily_cycles
FOR EACH ROW
EXECUTE FUNCTION enforce_lp_vault_daily_cycle_transition();

CREATE OR REPLACE FUNCTION record_lp_vault_daily_cycle_history()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lp_vault_daily_cycle_history (cycle_id, from_status, to_status, recorded_at)
    VALUES (NEW.id, NULL, NEW.status, NEW.opened_at);
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO lp_vault_daily_cycle_history (cycle_id, from_status, to_status)
    VALUES (NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_daily_cycles_history_trigger
AFTER INSERT OR UPDATE ON lp_vault_daily_cycles
FOR EACH ROW EXECUTE FUNCTION record_lp_vault_daily_cycle_history();

CREATE OR REPLACE FUNCTION enforce_lp_vault_pending_deposit_transition()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lp_vault_pending_deposit_cannot_be_deleted'; END IF;
  IF OLD.vault_id IS DISTINCT FROM NEW.vault_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.amount_micro_units IS DISTINCT FROM NEW.amount_micro_units
    OR OLD.eligible_after_cutoff IS DISTINCT FROM NEW.eligible_after_cutoff
    OR OLD.source_reference IS DISTINCT FROM NEW.source_reference
    OR OLD.request_payload_hash IS DISTINCT FROM NEW.request_payload_hash
    OR OLD.accounting_event_id IS DISTINCT FROM NEW.accounting_event_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN RAISE EXCEPTION 'lp_vault_pending_deposit_identity_is_immutable'; END IF;

  IF NOT (
    (OLD.status = 'pending' AND NEW.status = 'active' AND EXISTS (
      SELECT 1 FROM lp_vault_share_events WHERE pending_deposit_id = OLD.id AND event_type = 'mint'
    ))
    OR (OLD.status = 'pending' AND NEW.status = 'rejected')
  ) THEN RAISE EXCEPTION 'invalid_lp_vault_pending_deposit_transition:%:%', OLD.status, NEW.status; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_pending_deposits_transition_trigger
BEFORE UPDATE OR DELETE ON lp_vault_pending_deposits
FOR EACH ROW
EXECUTE FUNCTION enforce_lp_vault_pending_deposit_transition();

CREATE OR REPLACE FUNCTION enforce_lp_vault_redemption_transition()
RETURNS trigger AS $$
DECLARE
  older_waiting BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lp_vault_redemption_request_cannot_be_deleted'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('lp-vault-accounting:' || NEW.vault_id::text, 0));
  IF OLD.vault_id IS DISTINCT FROM NEW.vault_id
    OR OLD.position_id IS DISTINCT FROM NEW.position_id
    OR OLD.requested_share_units IS DISTINCT FROM NEW.requested_share_units
    OR OLD.request_payload_hash IS DISTINCT FROM NEW.request_payload_hash
    OR OLD.queue_sequence IS DISTINCT FROM NEW.queue_sequence
    OR OLD.accounting_event_id IS DISTINCT FROM NEW.accounting_event_id
    OR OLD.requested_at IS DISTINCT FROM NEW.requested_at
  THEN RAISE EXCEPTION 'lp_vault_redemption_request_identity_is_immutable'; END IF;

  IF NEW.status = 'waiting_liquidity' THEN
    NEW.waiting_liquidity_at := now();
  ELSIF NEW.status = 'admitted' THEN
    NEW.redemption_starts_at := now();
    NEW.redemption_ends_at := NEW.redemption_starts_at + interval '72 hours';
  ELSIF NEW.status = 'redeeming' THEN
    NEW.redeeming_at := now();
  ELSIF NEW.status = 'finalized' THEN
    NEW.finalized_at := now();
  ELSIF NEW.status = 'claimable' THEN
    NEW.claimable_at := now();
  ELSIF NEW.status = 'canceled' THEN
    NEW.canceled_at := now();
  END IF;

  IF NOT (
    (OLD.status = 'queued' AND NEW.status = 'waiting_liquidity')
    OR (OLD.status IN ('queued', 'waiting_liquidity') AND NEW.status = 'admitted')
    OR (OLD.status = 'admitted' AND NEW.status = 'redeeming' AND now() >= NEW.redemption_starts_at)
    OR (OLD.status = 'redeeming' AND NEW.status = 'finalized' AND now() >= NEW.redemption_ends_at
      AND EXISTS (SELECT 1 FROM lp_vault_redemption_payables WHERE redemption_request_id = OLD.id)
      AND EXISTS (SELECT 1 FROM lp_vault_share_events
        WHERE redemption_request_id = OLD.id AND event_type = 'burn'))
    OR (OLD.status = 'finalized' AND NEW.status = 'claimable'
      AND EXISTS (SELECT 1 FROM lp_vault_redemption_payables WHERE redemption_request_id = OLD.id))
    OR (OLD.status IN ('queued', 'waiting_liquidity') AND NEW.status = 'canceled')
  ) THEN RAISE EXCEPTION 'invalid_lp_vault_redemption_transition:%:%', OLD.status, NEW.status; END IF;

  IF NEW.status = 'admitted' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('lp-vault-redemption-admission:' || NEW.vault_id::text, 0));
    SELECT count(*)::BIGINT INTO older_waiting
    FROM lp_vault_redemption_requests
    WHERE vault_id = NEW.vault_id
      AND queue_sequence < NEW.queue_sequence
      AND status IN ('queued', 'waiting_liquidity');
    IF older_waiting <> 0 THEN RAISE EXCEPTION 'lp_vault_redemption_fifo_violation'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM lp_vault_redemption_reserves
      WHERE redemption_request_id = OLD.id
        AND vault_id = OLD.vault_id
        AND reserved_share_units = OLD.requested_share_units
    ) THEN
      RAISE EXCEPTION 'lp_vault_redemption_reserve_missing';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_redemption_requests_transition_trigger
BEFORE UPDATE OR DELETE ON lp_vault_redemption_requests
FOR EACH ROW
EXECUTE FUNCTION enforce_lp_vault_redemption_transition();

CREATE OR REPLACE FUNCTION record_lp_vault_redemption_request_history()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lp_vault_redemption_request_history (redemption_request_id, from_status, to_status, recorded_at)
    VALUES (NEW.id, NULL, NEW.status, NEW.requested_at);
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO lp_vault_redemption_request_history (redemption_request_id, from_status, to_status)
    VALUES (NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_redemption_requests_history_trigger
AFTER INSERT OR UPDATE ON lp_vault_redemption_requests
FOR EACH ROW EXECUTE FUNCTION record_lp_vault_redemption_request_history();
