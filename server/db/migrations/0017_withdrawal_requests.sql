CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID REFERENCES user_wallets(id),
  chain_id INTEGER NOT NULL,
  destination_address TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDC',
  amount_micro_units BIGINT NOT NULL CHECK (amount_micro_units > 0),
  status TEXT NOT NULL CHECK (status IN ('requested', 'sent', 'canceled', 'failed')),
  request_transaction_id UUID NOT NULL,
  completion_transaction_id UUID,
  onchain_tx_hash TEXT,
  operator_id TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS withdrawal_requests_user_idx
  ON withdrawal_requests (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS withdrawal_requests_status_idx
  ON withdrawal_requests (status, created_at ASC);
