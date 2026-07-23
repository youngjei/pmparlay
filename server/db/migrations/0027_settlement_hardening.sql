ALTER TABLE ticket_legs
  ADD COLUMN IF NOT EXISTS settlement_question TEXT,
  ADD COLUMN IF NOT EXISTS settlement_outcome TEXT,
  ADD COLUMN IF NOT EXISTS settlement_source_market_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_position_id TEXT,
  ADD COLUMN IF NOT EXISTS settlement_collection_id TEXT;

-- 0028 performs an auditable quarantine pass before adding/validating frozen
-- identity constraints. Do not infer a CTF position, collection, question,
-- or market from incomplete legacy data here.

CREATE INDEX IF NOT EXISTS ticket_legs_blocked_resolution_due_idx
  ON ticket_legs (next_resolution_check_at, created_at)
  WHERE status IN ('pending', 'disputed')
    AND resolution_state = 'settlement_blocked';

CREATE INDEX IF NOT EXISTS ticket_legs_normal_resolution_due_idx
  ON ticket_legs (status, next_resolution_check_at, created_at)
  WHERE resolution_state <> 'settlement_blocked';

DROP INDEX IF EXISTS settlements_ticket_leg_source_idx;

CREATE INDEX IF NOT EXISTS settlements_ticket_leg_source_created_idx
  ON settlements (ticket_leg_id, source, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_append_only_table_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table_mutation:%', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS settlement_proofs_append_only_trigger ON settlement_proofs;
CREATE TRIGGER settlement_proofs_append_only_trigger
BEFORE UPDATE OR DELETE ON settlement_proofs
FOR EACH ROW
EXECUTE FUNCTION prevent_append_only_table_mutation();

DROP TRIGGER IF EXISTS settlements_append_only_trigger ON settlements;
CREATE TRIGGER settlements_append_only_trigger
BEFORE UPDATE OR DELETE ON settlements
FOR EACH ROW
EXECUTE FUNCTION prevent_append_only_table_mutation();

DROP TRIGGER IF EXISTS audit_log_append_only_trigger ON audit_log;
CREATE TRIGGER audit_log_append_only_trigger
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION prevent_append_only_table_mutation();
