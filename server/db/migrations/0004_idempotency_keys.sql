CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  user_scope TEXT NOT NULL DEFAULT 'anonymous',
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX idempotency_keys_route_key_scope_idx
  ON idempotency_keys (route, idempotency_key, user_scope);

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
