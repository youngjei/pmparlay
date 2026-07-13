CREATE TABLE IF NOT EXISTS onchain_deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  amount_micro_units BIGINT NOT NULL CHECK (amount_micro_units > 0),
  user_id UUID REFERENCES users(id),
  wallet_id UUID REFERENCES user_wallets(id),
  status TEXT NOT NULL CHECK (status IN ('observed', 'credited', 'ignored')),
  confirmations INTEGER NOT NULL DEFAULT 0,
  credited_transaction_id UUID,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS onchain_deposits_user_idx
  ON onchain_deposits (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS onchain_deposits_status_idx
  ON onchain_deposits (status, chain_id, block_number DESC);

CREATE TABLE IF NOT EXISTS onchain_scan_cursors (
  chain_id INTEGER NOT NULL,
  cursor_name TEXT NOT NULL,
  last_scanned_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, cursor_name)
);
