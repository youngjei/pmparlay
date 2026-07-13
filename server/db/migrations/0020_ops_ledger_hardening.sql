CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_chain_tx_unique_idx
  ON withdrawal_requests (chain_id, onchain_tx_hash)
  WHERE onchain_tx_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_balanced_ledger_transaction()
RETURNS trigger AS $$
DECLARE
  new_balance BIGINT;
  old_balance BIGINT;
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.transaction_id IS NOT NULL THEN
    SELECT COALESCE(sum(amount_micro_units), 0)::BIGINT
    INTO new_balance
    FROM ledger_entries
    WHERE transaction_id = NEW.transaction_id
      AND currency = NEW.currency;

    IF new_balance <> 0 THEN
      RAISE EXCEPTION 'unbalanced_ledger_transaction:%:%:%', NEW.transaction_id, NEW.currency, new_balance;
    END IF;
  END IF;

  IF TG_OP = 'DELETE'
    OR (
      TG_OP = 'UPDATE'
      AND (OLD.transaction_id <> NEW.transaction_id OR OLD.currency <> NEW.currency)
    )
  THEN
    SELECT COALESCE(sum(amount_micro_units), 0)::BIGINT
    INTO old_balance
    FROM ledger_entries
    WHERE transaction_id = OLD.transaction_id
      AND currency = OLD.currency;

    IF old_balance <> 0 THEN
      RAISE EXCEPTION 'unbalanced_ledger_transaction:%:%:%', OLD.transaction_id, OLD.currency, old_balance;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_balanced_transaction_trigger ON ledger_entries;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced_transaction_trigger
AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_balanced_ledger_transaction();
