ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;

ALTER TABLE outbox
  ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead'));

CREATE INDEX outbox_dead_status_idx ON outbox (status, attempts)
  WHERE status = 'dead';
