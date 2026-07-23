ALTER TABLE worker_runtime_heartbeats
  ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS latest_failure VARCHAR(512);

CREATE INDEX IF NOT EXISTS worker_runtime_heartbeats_success_freshness_idx
  ON worker_runtime_heartbeats (last_success_at DESC);

CREATE INDEX IF NOT EXISTS worker_runtime_heartbeats_failure_freshness_idx
  ON worker_runtime_heartbeats (last_failure_at DESC);
