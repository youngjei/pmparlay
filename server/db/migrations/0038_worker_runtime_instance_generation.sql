CREATE SEQUENCE IF NOT EXISTS worker_runtime_instance_generation_seq AS BIGINT;

ALTER TABLE worker_runtime_heartbeats
  ADD COLUMN IF NOT EXISTS instance_generation BIGINT;

UPDATE worker_runtime_heartbeats
SET instance_generation = nextval('worker_runtime_instance_generation_seq')
WHERE instance_generation IS NULL;

ALTER TABLE worker_runtime_heartbeats
  ALTER COLUMN instance_generation SET NOT NULL;

ALTER TABLE worker_runtime_heartbeats
  DROP CONSTRAINT IF EXISTS worker_runtime_heartbeats_instance_generation_positive;

ALTER TABLE worker_runtime_heartbeats
  ADD CONSTRAINT worker_runtime_heartbeats_instance_generation_positive
  CHECK (instance_generation > 0);
