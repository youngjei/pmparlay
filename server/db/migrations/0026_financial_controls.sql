CREATE TABLE IF NOT EXISTS financial_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'remediated', 'dismissed')),
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  remediated_at TIMESTAMPTZ,
  remediated_by TEXT,
  remediation_note TEXT
);

CREATE INDEX IF NOT EXISTS financial_incidents_open_idx
  ON financial_incidents (status, severity, created_at DESC)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS financial_control_gates (
  scope TEXT PRIMARY KEY CHECK (scope = 'global'),
  operation_gate TEXT NOT NULL CHECK (operation_gate IN ('restricted', 'blocked')),
  reason TEXT NOT NULL,
  incident_id UUID REFERENCES financial_incidents(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at TIMESTAMPTZ,
  cleared_by TEXT,
  clear_reason TEXT
);

CREATE TABLE IF NOT EXISTS financial_constraint_quarantine (
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  constraint_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  row_data JSONB NOT NULL,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  remediated_at TIMESTAMPTZ,
  remediated_by TEXT,
  remediation_note TEXT,
  PRIMARY KEY (source_table, source_id, constraint_name)
);

COMMENT ON TABLE financial_constraint_quarantine IS
  'Legacy rows that prevent financial constraint validation. Remediate the source row, record remediation here, then VALIDATE the named constraint.';

CREATE OR REPLACE FUNCTION prevent_append_only_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%_is_append_only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_append_only_trigger ON ledger_entries;

CREATE TRIGGER ledger_entries_append_only_trigger
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION prevent_append_only_mutation();

DROP TRIGGER IF EXISTS audit_log_append_only_trigger ON audit_log;

CREATE TRIGGER audit_log_append_only_trigger
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION prevent_append_only_mutation();

ALTER TABLE onchain_deposits
  ADD COLUMN IF NOT EXISTS reorg_compensation_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS reorg_incident_id UUID REFERENCES financial_incidents(id);

CREATE UNIQUE INDEX IF NOT EXISTS onchain_deposits_reorg_compensation_unique_idx
  ON onchain_deposits (reorg_compensation_transaction_id)
  WHERE reorg_compensation_transaction_id IS NOT NULL;

ALTER TABLE onchain_deposits
  DROP CONSTRAINT IF EXISTS onchain_deposits_state_contract_check;

ALTER TABLE onchain_deposits
  ADD CONSTRAINT onchain_deposits_state_contract_check
  CHECK ((
    (
      status = 'observed'
      AND credited_transaction_id IS NULL
      AND reorged_at IS NULL
    )
    OR (
      status = 'ignored'
      AND credited_transaction_id IS NULL
    )
    OR (
      status = 'credited'
      AND credited_transaction_id IS NOT NULL
      AND user_id IS NOT NULL
      AND wallet_id IS NOT NULL
    )
    OR (
      status = 'reorged'
      AND reorged_at IS NOT NULL
      AND reorg_reason IS NOT NULL
      AND (
        credited_transaction_id IS NULL
        OR reorg_compensation_transaction_id IS NOT NULL
        OR reorg_incident_id IS NOT NULL
      )
    )
  ) IS TRUE) NOT VALID;

CREATE TABLE IF NOT EXISTS onchain_scan_block_observations (
  chain_id INTEGER NOT NULL,
  cursor_name TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, cursor_name, block_number),
  CHECK (block_number >= 0),
  CHECK (block_hash ~ '^0x[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS onchain_scan_block_observations_desc_idx
  ON onchain_scan_block_observations (chain_id, cursor_name, block_number DESC);

CREATE OR REPLACE FUNCTION enforce_onchain_scan_cursor_monotonic()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.last_scanned_block < OLD.last_scanned_block THEN
    RAISE EXCEPTION 'onchain_scan_cursor_regression:%:%:%:%',
      NEW.chain_id,
      NEW.cursor_name,
      OLD.last_scanned_block,
      NEW.last_scanned_block;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS onchain_scan_cursors_monotonic_trigger ON onchain_scan_cursors;

CREATE TRIGGER onchain_scan_cursors_monotonic_trigger
BEFORE UPDATE ON onchain_scan_cursors
FOR EACH ROW
EXECUTE FUNCTION enforce_onchain_scan_cursor_monotonic();

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS request_hash TEXT,
  ADD COLUMN IF NOT EXISTS request_hash_version TEXT,
  ADD COLUMN IF NOT EXISTS safe_proposal_hash TEXT,
  ADD COLUMN IF NOT EXISTS safe_proposed_by TEXT,
  ADD COLUMN IF NOT EXISTS onchain_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS onchain_block_hash TEXT,
  ADD COLUMN IF NOT EXISTS onchain_confirmations INTEGER;

UPDATE withdrawal_requests
SET request_hash_version = 'legacy-unknown-v0'
WHERE request_hash IS NOT NULL
  AND request_hash_version IS NULL;

UPDATE withdrawal_requests
SET
  request_hash = 'sha256:' || encode(
  digest(
    '{"amountMicroUnits":' || to_json(amount_micro_units::text)::text ||
    ',"chainId":' || chain_id::text ||
    ',"currency":"USDC"' ||
    ',"destinationAddress":' || to_json(lower(destination_address))::text ||
    ',"userId":' || to_json(user_id::text)::text ||
    '}',
    'sha256'
  ),
  'hex'
  ),
  request_hash_version = 'canonical-json-v1'
WHERE request_hash IS NULL;

ALTER TABLE withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_hash_contract_check;

ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_hash_contract_check
  CHECK ((
    request_hash_version IN ('canonical-json-v1', 'legacy-unknown-v0')
    AND request_hash ~ '^sha256:[a-f0-9]{64}$'
    AND (safe_proposal_hash IS NULL OR safe_proposal_hash ~ '^sha256:[a-f0-9]{64}$')
    AND (onchain_block_hash IS NULL OR onchain_block_hash ~ '^0x[a-f0-9]{64}$')
  ) IS TRUE) NOT VALID;

ALTER TABLE withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_state_contract_check;

ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_state_contract_check
  CHECK ((
    (
      status = 'requested'
      AND request_transaction_id IS NOT NULL
      AND completion_transaction_id IS NULL
      AND sent_at IS NULL
      AND safe_proposal_hash IS NULL
    )
    OR (
      status = 'proposed'
      AND request_transaction_id IS NOT NULL
      AND completion_transaction_id IS NULL
      AND sent_at IS NULL
      AND safe_proposal_payload IS NOT NULL
      AND safe_proposal_hash IS NOT NULL
      AND safe_proposed_at IS NOT NULL
      AND safe_proposed_by IS NOT NULL
    )
    OR (
      status = 'sent'
      AND request_transaction_id IS NOT NULL
      AND completion_transaction_id IS NOT NULL
      AND onchain_tx_hash IS NOT NULL
      AND onchain_block_number IS NOT NULL
      AND onchain_block_hash IS NOT NULL
      AND onchain_confirmations IS NOT NULL
      AND operator_id IS NOT NULL
      AND sent_at IS NOT NULL
      AND safe_proposal_payload IS NOT NULL
      AND safe_proposal_hash IS NOT NULL
      AND safe_proposed_at IS NOT NULL
      AND safe_proposed_by IS NOT NULL
    )
    OR status IN ('canceled', 'failed')
  ) IS TRUE) NOT VALID;

CREATE OR REPLACE FUNCTION prevent_withdrawal_request_immutable_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.wallet_id IS DISTINCT FROM NEW.wallet_id
    OR OLD.chain_id IS DISTINCT FROM NEW.chain_id
    OR OLD.destination_address IS DISTINCT FROM NEW.destination_address
    OR OLD.currency IS DISTINCT FROM NEW.currency
    OR OLD.amount_micro_units IS DISTINCT FROM NEW.amount_micro_units
    OR OLD.request_transaction_id IS DISTINCT FROM NEW.request_transaction_id
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
    OR OLD.request_hash_version IS DISTINCT FROM NEW.request_hash_version
  THEN
    RAISE EXCEPTION 'withdrawal_request_is_immutable';
  END IF;

  IF OLD.safe_proposal_hash IS NOT NULL
    AND (
      OLD.safe_proposal_hash IS DISTINCT FROM NEW.safe_proposal_hash
      OR OLD.safe_proposal_payload IS DISTINCT FROM NEW.safe_proposal_payload
      OR OLD.safe_proposal_id IS DISTINCT FROM NEW.safe_proposal_id
      OR OLD.safe_proposed_at IS DISTINCT FROM NEW.safe_proposed_at
      OR OLD.safe_proposed_by IS DISTINCT FROM NEW.safe_proposed_by
    )
  THEN
    RAISE EXCEPTION 'withdrawal_safe_proposal_is_immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS withdrawal_requests_immutable_trigger ON withdrawal_requests;

CREATE TRIGGER withdrawal_requests_immutable_trigger
BEFORE UPDATE ON withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION prevent_withdrawal_request_immutable_mutation();

ALTER TABLE financial_reconciliation_snapshots
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS scope_treasury_address TEXT,
  ADD COLUMN IF NOT EXISTS scope_token_address TEXT;

ALTER TABLE financial_reconciliation_snapshots
  ALTER COLUMN source DROP DEFAULT;

ALTER TABLE financial_reconciliation_snapshots
  DROP CONSTRAINT IF EXISTS financial_reconciliation_snapshot_provenance_check;

ALTER TABLE financial_reconciliation_snapshots
  ADD CONSTRAINT financial_reconciliation_snapshot_provenance_check
  CHECK ((
    source = 'legacy'
    OR (
      source = 'worker'
      AND observed_block_number IS NOT NULL
      AND observed_block_number >= 0
      AND observed_block_hash ~ '^0x[a-f0-9]{64}$'
      AND scope_treasury_address ~ '^0x[a-f0-9]{40}$'
      AND scope_token_address ~ '^0x[a-f0-9]{40}$'
      AND jsonb_typeof(treasury_assets) = 'array'
      AND jsonb_array_length(treasury_assets) = 1
      AND treasury_assets->0->>'source' = 'onchain'
      AND treasury_assets->0->>'chainId' = chain_id::text
      AND lower(treasury_assets->0->>'treasuryAddress') = scope_treasury_address
      AND lower(treasury_assets->0->>'tokenAddress') = scope_token_address
      AND treasury_assets->0->>'blockNumber' = observed_block_number::text
      AND lower(treasury_assets->0->>'blockHash') = observed_block_hash
    )
  ) IS TRUE) NOT VALID;

INSERT INTO financial_constraint_quarantine (source_table, source_id, constraint_name, reason, row_data)
SELECT
  'onchain_deposits',
  deposits.id::text,
  'onchain_deposits_state_contract_check',
  'legacy_deposit_state_contract_violation',
  to_jsonb(deposits)
FROM onchain_deposits deposits
WHERE NOT ((
  (status = 'observed' AND credited_transaction_id IS NULL AND reorged_at IS NULL)
  OR (status = 'ignored' AND credited_transaction_id IS NULL)
  OR (status = 'credited' AND credited_transaction_id IS NOT NULL AND user_id IS NOT NULL AND wallet_id IS NOT NULL)
  OR (
    status = 'reorged'
    AND reorged_at IS NOT NULL
    AND reorg_reason IS NOT NULL
    AND (
      credited_transaction_id IS NULL
      OR reorg_compensation_transaction_id IS NOT NULL
      OR reorg_incident_id IS NOT NULL
    )
  )
) IS TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO financial_constraint_quarantine (source_table, source_id, constraint_name, reason, row_data)
SELECT
  'withdrawal_requests',
  withdrawals.id::text,
  'withdrawal_requests_hash_contract_check',
  'legacy_withdrawal_hash_contract_violation',
  to_jsonb(withdrawals)
FROM withdrawal_requests withdrawals
WHERE NOT ((
  request_hash_version IN ('canonical-json-v1', 'legacy-unknown-v0')
  AND request_hash ~ '^sha256:[a-f0-9]{64}$'
  AND (safe_proposal_hash IS NULL OR safe_proposal_hash ~ '^sha256:[a-f0-9]{64}$')
  AND (onchain_block_hash IS NULL OR onchain_block_hash ~ '^0x[a-f0-9]{64}$')
) IS TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO financial_constraint_quarantine (source_table, source_id, constraint_name, reason, row_data)
SELECT
  'withdrawal_requests',
  withdrawals.id::text,
  'withdrawal_requests_state_contract_check',
  'legacy_withdrawal_state_contract_violation',
  to_jsonb(withdrawals)
FROM withdrawal_requests withdrawals
WHERE NOT ((
  (
    status = 'requested'
    AND request_transaction_id IS NOT NULL
    AND completion_transaction_id IS NULL
    AND sent_at IS NULL
    AND safe_proposal_hash IS NULL
  )
  OR (
    status = 'proposed'
    AND request_transaction_id IS NOT NULL
    AND completion_transaction_id IS NULL
    AND sent_at IS NULL
    AND safe_proposal_payload IS NOT NULL
    AND safe_proposal_hash IS NOT NULL
    AND safe_proposed_at IS NOT NULL
    AND safe_proposed_by IS NOT NULL
  )
  OR (
    status = 'sent'
    AND request_transaction_id IS NOT NULL
    AND completion_transaction_id IS NOT NULL
    AND onchain_tx_hash IS NOT NULL
    AND onchain_block_number IS NOT NULL
    AND onchain_block_hash IS NOT NULL
    AND onchain_confirmations IS NOT NULL
    AND operator_id IS NOT NULL
    AND sent_at IS NOT NULL
    AND safe_proposal_payload IS NOT NULL
    AND safe_proposal_hash IS NOT NULL
    AND safe_proposed_at IS NOT NULL
    AND safe_proposed_by IS NOT NULL
  )
  OR status IN ('canceled', 'failed')
) IS TRUE)
ON CONFLICT DO NOTHING;

INSERT INTO financial_constraint_quarantine (source_table, source_id, constraint_name, reason, row_data)
SELECT
  'financial_reconciliation_snapshots',
  snapshots.id::text,
  'financial_reconciliation_snapshot_provenance_check',
  'legacy_reconciliation_snapshot_untrusted',
  to_jsonb(snapshots)
FROM financial_reconciliation_snapshots snapshots
WHERE source = 'legacy'
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  pending_constraint TEXT;
  incident_id UUID;
BEGIN
  FOREACH pending_constraint IN ARRAY ARRAY[
    'onchain_deposits_state_contract_check',
    'withdrawal_requests_hash_contract_check',
    'withdrawal_requests_state_contract_check',
    'financial_reconciliation_snapshot_provenance_check'
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM financial_constraint_quarantine
      WHERE constraint_name = pending_constraint
        AND remediated_at IS NULL
    ) THEN
      INSERT INTO financial_incidents (severity, status, kind, entity_type, reason, metadata)
      VALUES (
        'critical',
        'open',
        'financial_constraint_quarantine',
        'database_constraint',
        'legacy rows require operator remediation before constraint validation',
        jsonb_build_object('constraintName', pending_constraint)
      )
      RETURNING id INTO incident_id;

      INSERT INTO financial_control_gates (scope, operation_gate, reason, incident_id, metadata)
      VALUES (
        'global',
        'blocked',
        'financial_constraint_quarantine',
        incident_id,
        jsonb_build_object('constraintName', pending_constraint)
      )
      ON CONFLICT (scope) DO UPDATE SET
        operation_gate = 'blocked',
        reason = EXCLUDED.reason,
        incident_id = EXCLUDED.incident_id,
        metadata = EXCLUDED.metadata,
        set_at = now(),
        cleared_at = NULL;
    ELSE
      CASE pending_constraint
        WHEN 'onchain_deposits_state_contract_check' THEN
          EXECUTE 'ALTER TABLE onchain_deposits VALIDATE CONSTRAINT onchain_deposits_state_contract_check';
        WHEN 'withdrawal_requests_hash_contract_check' THEN
          EXECUTE 'ALTER TABLE withdrawal_requests VALIDATE CONSTRAINT withdrawal_requests_hash_contract_check';
        WHEN 'withdrawal_requests_state_contract_check' THEN
          EXECUTE 'ALTER TABLE withdrawal_requests VALIDATE CONSTRAINT withdrawal_requests_state_contract_check';
        WHEN 'financial_reconciliation_snapshot_provenance_check' THEN
          EXECUTE 'ALTER TABLE financial_reconciliation_snapshots VALIDATE CONSTRAINT financial_reconciliation_snapshot_provenance_check';
      END CASE;
    END IF;
  END LOOP;
END;
$$;
