ALTER TABLE worker_runtime_heartbeats
  ADD COLUMN IF NOT EXISTS instance_id TEXT;

UPDATE worker_runtime_heartbeats
SET instance_id = 'legacy:' || md5(worker_name) || ':' || COALESCE(process_id::text, 'unknown')
WHERE instance_id IS NULL;

ALTER TABLE worker_runtime_heartbeats
  ALTER COLUMN instance_id SET NOT NULL;

ALTER TABLE worker_runtime_heartbeats
  DROP CONSTRAINT IF EXISTS worker_runtime_heartbeats_instance_id_nonempty;

ALTER TABLE worker_runtime_heartbeats
  ADD CONSTRAINT worker_runtime_heartbeats_instance_id_nonempty
  CHECK (length(btrim(instance_id)) BETWEEN 1 AND 128);
