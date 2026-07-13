CREATE TABLE IF NOT EXISTS user_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  label TEXT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (address),
  UNIQUE (user_id, address)
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS privy_user_id TEXT UNIQUE;

ALTER TABLE user_wallets
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'privy';

CREATE INDEX IF NOT EXISTS user_wallets_user_idx
  ON user_wallets (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_auth_nonces (
  nonce TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  uri TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wallet_auth_nonces_expiry_idx
  ON wallet_auth_nonces (expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id UUID REFERENCES user_wallets(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON auth_sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS treasury_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id INTEGER NOT NULL,
  currency TEXT NOT NULL,
  treasury_address TEXT NOT NULL,
  usdc_contract_address TEXT NOT NULL,
  required_confirmations INTEGER NOT NULL CHECK (required_confirmations > 0),
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS treasury_config_one_active_idx
  ON treasury_config (chain_id, currency)
  WHERE active;
