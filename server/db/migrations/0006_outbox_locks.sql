ALTER TABLE outbox
  ADD COLUMN locked_at TIMESTAMPTZ;

UPDATE outbox
SET locked_at = created_at
WHERE status = 'processing' AND locked_at IS NULL;

CREATE INDEX outbox_processing_locked_idx ON outbox (status, locked_at);
