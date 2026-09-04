CREATE TABLE lp_vaults (
  id UUID PRIMARY KEY,
  singleton_key BOOLEAN NOT NULL DEFAULT true UNIQUE CHECK (singleton_key),
  vault_key TEXT NOT NULL UNIQUE CHECK (vault_key = 'founder-sepolia-shadow'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  mode TEXT NOT NULL CHECK (mode = 'shadow'),
  chain_id INTEGER NOT NULL CHECK (chain_id = 11155111),
  currency TEXT NOT NULL CHECK (currency = 'USDC'),
  treasury_address TEXT NOT NULL CHECK (treasury_address ~ '^0x[0-9a-f]{40}$'),
  token_address TEXT NOT NULL CHECK (token_address = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'),
  capital_source TEXT NOT NULL CHECK (capital_source = 'founder'),
  custody_model TEXT NOT NULL CHECK (custody_model = 'logical_operating_treasury'),
  community_custody BOOLEAN NOT NULL DEFAULT false CHECK (NOT community_custody),
  deposits_enabled BOOLEAN NOT NULL DEFAULT false CHECK (NOT deposits_enabled),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE lp_vaults IS
  'Singleton founder-funded Sepolia shadow-vault metadata. It does not represent segregated community custody.';

CREATE OR REPLACE FUNCTION prevent_lp_vault_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'lp_vault_is_immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vaults_immutable_trigger
BEFORE UPDATE OR DELETE ON lp_vaults
FOR EACH ROW
EXECUTE FUNCTION prevent_lp_vault_mutation();

CREATE TABLE lp_vault_epochs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES lp_vaults(id),
  epoch_number INTEGER NOT NULL CHECK (epoch_number > 0),
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'runoff', 'finalized', 'canceled')),
  starts_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, epoch_number),
  CHECK (
    (status = 'finalized' AND finalized_at IS NOT NULL AND finalized_at > starts_at)
    OR (status <> 'finalized' AND finalized_at IS NULL)
  )
);

CREATE UNIQUE INDEX lp_vault_epochs_one_open_idx
  ON lp_vault_epochs (vault_id)
  WHERE status IN ('planned', 'active', 'runoff');

COMMENT ON TABLE lp_vault_epochs IS
  'Serial shadow-observation epochs only. No deposit, unit, redemption, or ticket-attribution semantics are implied.';

CREATE TABLE lp_vault_epoch_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_id UUID NOT NULL REFERENCES lp_vault_epochs(id),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('planned', 'active', 'runoff', 'finalized', 'canceled')),
  to_status TEXT NOT NULL CHECK (to_status IN ('planned', 'active', 'runoff', 'finalized', 'canceled')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_status IS DISTINCT FROM to_status)
);

CREATE INDEX lp_vault_epoch_history_epoch_idx
  ON lp_vault_epoch_history (epoch_id, recorded_at DESC);

CREATE TRIGGER lp_vault_epoch_history_append_only_trigger
BEFORE UPDATE OR DELETE ON lp_vault_epoch_history
FOR EACH ROW
EXECUTE FUNCTION prevent_append_only_mutation();

CREATE OR REPLACE FUNCTION enforce_lp_vault_epoch_transition()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lp_vault_epoch_cannot_be_deleted';
  END IF;

  IF OLD.vault_id IS DISTINCT FROM NEW.vault_id
    OR OLD.epoch_number IS DISTINCT FROM NEW.epoch_number
    OR OLD.starts_at IS DISTINCT FROM NEW.starts_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'lp_vault_epoch_identity_is_immutable';
  END IF;

  IF OLD.status = NEW.status AND OLD.finalized_at IS NOT DISTINCT FROM NEW.finalized_at THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'planned' AND NEW.status IN ('active', 'canceled'))
    OR (OLD.status = 'active' AND NEW.status = 'runoff')
    OR (OLD.status = 'runoff' AND NEW.status = 'finalized')
  ) THEN
    RAISE EXCEPTION 'invalid_lp_vault_epoch_transition:%:%', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_epochs_transition_trigger
BEFORE UPDATE OR DELETE ON lp_vault_epochs
FOR EACH ROW
EXECUTE FUNCTION enforce_lp_vault_epoch_transition();

CREATE OR REPLACE FUNCTION record_lp_vault_epoch_history()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lp_vault_epoch_history (epoch_id, from_status, to_status, recorded_at)
    VALUES (NEW.id, NULL, NEW.status, NEW.created_at);
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO lp_vault_epoch_history (epoch_id, from_status, to_status)
    VALUES (NEW.id, OLD.status, NEW.status);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lp_vault_epochs_history_trigger
AFTER INSERT OR UPDATE ON lp_vault_epochs
FOR EACH ROW
EXECUTE FUNCTION record_lp_vault_epoch_history();
