ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS accounting_mode TEXT NOT NULL DEFAULT 'play_money',
  ADD COLUMN IF NOT EXISTS funding_currency TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE tickets
  DROP CONSTRAINT IF EXISTS tickets_accounting_mode_check;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_accounting_mode_check
  CHECK (accounting_mode IN ('play_money', 'house_book_usdc'));

CREATE TABLE IF NOT EXISTS ticket_reserves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  accounting_mode TEXT NOT NULL CHECK (accounting_mode IN ('play_money', 'house_book_usdc')),
  currency TEXT NOT NULL,
  stake_micro_units BIGINT NOT NULL CHECK (stake_micro_units >= 0),
  operation_fee_micro_units BIGINT NOT NULL CHECK (operation_fee_micro_units >= 0),
  offered_payout_micro_units BIGINT NOT NULL CHECK (offered_payout_micro_units >= 0),
  net_liability_micro_units BIGINT NOT NULL CHECK (net_liability_micro_units >= 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'released', 'paid', 'voided', 'canceled')),
  purchase_transaction_id UUID NOT NULL,
  reserve_transaction_id UUID,
  release_transaction_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_reserves_status_idx
  ON ticket_reserves (status, accounting_mode, currency);

CREATE INDEX IF NOT EXISTS ticket_reserves_user_status_idx
  ON ticket_reserves (user_id, status, accounting_mode);

CREATE OR REPLACE VIEW open_user_exposure AS
SELECT
  tickets.user_id,
  count(DISTINCT tickets.id)::BIGINT AS open_tickets,
  sum(GREATEST(quotes.offered_payout_micro_usd - quotes.stake_micro_usd, 0))::BIGINT AS worst_case_liability_micro_usd
FROM tickets
JOIN quotes ON quotes.id = tickets.quote_id
WHERE tickets.status IN ('accepted', 'live')
GROUP BY tickets.user_id;
