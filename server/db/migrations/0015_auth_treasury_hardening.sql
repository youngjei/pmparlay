ALTER TABLE user_wallets
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS user_wallets_user_active_idx
  ON user_wallets (user_id, active, verified_at DESC);

CREATE TABLE IF NOT EXISTS treasury_config_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id INTEGER NOT NULL,
  currency TEXT NOT NULL,
  treasury_address TEXT NOT NULL,
  usdc_contract_address TEXT NOT NULL,
  required_confirmations INTEGER NOT NULL CHECK (required_confirmations > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

CREATE INDEX IF NOT EXISTS treasury_config_changes_status_idx
  ON treasury_config_changes (status, created_at DESC);
