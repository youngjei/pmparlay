CREATE TABLE IF NOT EXISTS worker_runtime_heartbeats (
  worker_name TEXT PRIMARY KEY,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  process_id INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_runtime_heartbeats_freshness_idx
  ON worker_runtime_heartbeats (heartbeat_at DESC);
