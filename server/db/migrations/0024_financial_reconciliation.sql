ALTER TABLE onchain_scan_cursors
  ADD COLUMN IF NOT EXISTS last_scanned_block_hash TEXT;

ALTER TABLE onchain_deposits
  ADD COLUMN IF NOT EXISTS reorged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reorg_reason TEXT;

ALTER TABLE onchain_deposits
  DROP CONSTRAINT IF EXISTS onchain_deposits_status_check;

ALTER TABLE onchain_deposits
  ADD CONSTRAINT onchain_deposits_status_check
  CHECK (status IN ('observed', 'credited', 'ignored', 'reorged'));

CREATE UNIQUE INDEX IF NOT EXISTS onchain_deposits_chain_block_log_unique_idx
  ON onchain_deposits (chain_id, block_hash, log_index)
  WHERE block_hash IS NOT NULL
    AND status <> 'reorged';

CREATE UNIQUE INDEX IF NOT EXISTS onchain_deposits_credited_transaction_unique_idx
  ON onchain_deposits (credited_transaction_id)
  WHERE credited_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS onchain_deposits_reorged_idx
  ON onchain_deposits (chain_id, block_number DESC)
  WHERE status = 'reorged';

CREATE INDEX IF NOT EXISTS treasury_config_scan_idx
  ON treasury_config (chain_id, currency, active, updated_at DESC);

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS safe_proposal_id TEXT,
  ADD COLUMN IF NOT EXISTS safe_proposal_payload JSONB,
  ADD COLUMN IF NOT EXISTS safe_proposed_at TIMESTAMPTZ;

ALTER TABLE withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;

ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_status_check
  CHECK (status IN ('requested', 'proposed', 'sent', 'canceled', 'failed'));

ALTER TABLE withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_state_contract_check;

ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_state_contract_check
  CHECK (
    (
      status IN ('requested', 'proposed')
      AND request_transaction_id IS NOT NULL
      AND completion_transaction_id IS NULL
      AND sent_at IS NULL
    )
    OR (
      status = 'sent'
      AND request_transaction_id IS NOT NULL
      AND completion_transaction_id IS NOT NULL
      AND onchain_tx_hash IS NOT NULL
    )
    OR status IN ('canceled', 'failed')
  );

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_request_transaction_unique_idx
  ON withdrawal_requests (request_transaction_id);

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_user_idempotency_unique_idx
  ON withdrawal_requests (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND status IN ('requested', 'proposed', 'sent');

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_open_natural_unique_idx
  ON withdrawal_requests (user_id, chain_id, destination_address, amount_micro_units)
  WHERE status IN ('requested', 'proposed');

CREATE TABLE IF NOT EXISTS financial_reconciliation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  treasury_assets_micro_units BIGINT NOT NULL,
  internal_custody_micro_units BIGINT NOT NULL,
  user_available_micro_units BIGINT NOT NULL,
  user_claimable_micro_units BIGINT NOT NULL,
  user_checkout_micro_units BIGINT NOT NULL DEFAULT 0,
  open_stake_micro_units BIGINT NOT NULL,
  open_reserve_micro_units BIGINT NOT NULL,
  pending_withdrawal_micro_units BIGINT NOT NULL,
  house_equity_micro_units BIGINT NOT NULL,
  unexplained_delta_micro_units BIGINT NOT NULL,
  launch_gate TEXT NOT NULL CHECK (launch_gate IN ('ready', 'blocked')),
  operation_gate TEXT NOT NULL CHECK (operation_gate IN ('open', 'restricted', 'blocked')),
  gate_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  treasury_assets JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_block_number BIGINT,
  observed_block_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS financial_reconciliation_snapshots_created_idx
  ON financial_reconciliation_snapshots (created_at DESC);

CREATE INDEX IF NOT EXISTS financial_reconciliation_snapshots_gate_idx
  ON financial_reconciliation_snapshots (launch_gate, operation_gate, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_financial_reconciliation_snapshot_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'financial_reconciliation_snapshots_are_append_only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS financial_reconciliation_snapshots_append_only_trigger
  ON financial_reconciliation_snapshots;

CREATE TRIGGER financial_reconciliation_snapshots_append_only_trigger
BEFORE UPDATE OR DELETE ON financial_reconciliation_snapshots
FOR EACH ROW
EXECUTE FUNCTION prevent_financial_reconciliation_snapshot_mutation();
