CREATE TABLE IF NOT EXISTS quote_payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  chain_id INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
  treasury_address TEXT NOT NULL,
  usdc_contract_address TEXT NOT NULL,
  amount_micro_units BIGINT NOT NULL CHECK (amount_micro_units > 0),
  required_confirmations INTEGER NOT NULL CHECK (required_confirmations > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'confirmed', 'activated', 'expired', 'failed')),
  tx_hash TEXT,
  onchain_deposit_id UUID REFERENCES onchain_deposits(id),
  ticket_id UUID REFERENCES tickets(id),
  expires_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quote_payment_intents_user_idx
  ON quote_payment_intents (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS quote_payment_intents_match_idx
  ON quote_payment_intents (
    chain_id,
    treasury_address,
    usdc_contract_address,
    amount_micro_units,
    status,
    expires_at
  );

CREATE INDEX IF NOT EXISTS quote_payment_intents_tx_hash_idx
  ON quote_payment_intents (chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL;

ALTER TABLE onchain_deposits
  ADD COLUMN IF NOT EXISTS payment_intent_id UUID REFERENCES quote_payment_intents(id);
