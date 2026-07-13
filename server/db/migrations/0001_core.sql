CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  source_market_id TEXT NOT NULL,
  condition_id TEXT,
  question TEXT NOT NULL,
  market_url TEXT NOT NULL,
  category TEXT NOT NULL,
  end_date TIMESTAMPTZ,
  neg_risk BOOLEAN,
  rfq_enabled BOOLEAN,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_market_id)
);

CREATE TABLE market_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES markets(id),
  outcome TEXT NOT NULL,
  token_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, outcome)
);

CREATE TABLE market_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID NOT NULL REFERENCES markets(id),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_response_hash TEXT NOT NULL,
  volume_micro_usd BIGINT,
  liquidity_micro_usd BIGINT,
  raw JSONB NOT NULL
);

CREATE INDEX market_snapshots_market_captured_idx ON market_snapshots (market_id, captured_at DESC);

CREATE TABLE policy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  policy JSONB NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  policy_version_id UUID NOT NULL REFERENCES policy_versions(id),
  status TEXT NOT NULL CHECK (status IN ('quoted', 'accepted', 'expired', 'rejected')),
  stake_micro_usd BIGINT NOT NULL CHECK (stake_micro_usd >= 0),
  operation_fee_micro_usd BIGINT NOT NULL CHECK (operation_fee_micro_usd >= 0),
  spread_bps INTEGER NOT NULL CHECK (spread_bps >= 0),
  implied_probability_bps INTEGER NOT NULL CHECK (implied_probability_bps >= 0),
  offered_payout_micro_usd BIGINT NOT NULL CHECK (offered_payout_micro_usd >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ
);

CREATE TABLE quote_legs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  market_id UUID NOT NULL REFERENCES markets(id),
  outcome_id UUID NOT NULL REFERENCES market_outcomes(id),
  market_snapshot_id UUID NOT NULL REFERENCES market_snapshots(id),
  outcome TEXT NOT NULL,
  quoted_price_bps INTEGER NOT NULL CHECK (quoted_price_bps >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE risk_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('ok', 'warn', 'block')),
  label TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  quote_id UUID NOT NULL UNIQUE REFERENCES quotes(id),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'live', 'won', 'lost', 'voided', 'paid')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ticket_legs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  quote_leg_id UUID NOT NULL REFERENCES quote_legs(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'won', 'lost', 'voided', 'disputed')),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  account_type TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES ledger_accounts(id),
  amount_micro_units BIGINT NOT NULL,
  currency TEXT NOT NULL,
  memo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);

CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_leg_id UUID NOT NULL REFERENCES ticket_legs(id),
  source TEXT NOT NULL,
  result TEXT NOT NULL,
  proof_reference TEXT,
  raw JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX outbox_status_available_idx ON outbox (status, available_at);
