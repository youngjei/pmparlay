CREATE UNIQUE INDEX IF NOT EXISTS quote_payment_intents_chain_tx_unique_idx
  ON quote_payment_intents (chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL
    AND status IN ('pending', 'submitted', 'confirmed', 'activated');

CREATE INDEX IF NOT EXISTS onchain_deposits_payment_reconcile_idx
  ON onchain_deposits (
    chain_id,
    tx_hash,
    to_address,
    token_address,
    amount_micro_units,
    user_id,
    status
  )
  WHERE payment_intent_id IS NULL;
