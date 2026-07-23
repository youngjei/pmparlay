ALTER TABLE ticket_legs
  ADD COLUMN IF NOT EXISTS settlement_due_at TIMESTAMPTZ;

-- Legacy rows use their purchased quote snapshot where possible. The mutable
-- catalog date is only a last-resort legacy fallback and is never consulted
-- again once settlement_due_at has been frozen.
UPDATE ticket_legs
SET settlement_due_at = frozen_due.due_at
FROM (
  SELECT
    ticket_legs.id AS ticket_leg_id,
    COALESCE(
      CASE
        WHEN pg_input_is_valid(snapshot_outcome.value->>'endDate', 'timestamp with time zone')
          THEN (snapshot_outcome.value->>'endDate')::timestamptz
        ELSE NULL
      END,
      CASE
        WHEN pg_input_is_valid(market_snapshots.raw->'market'->>'endDate', 'timestamp with time zone')
          THEN (market_snapshots.raw->'market'->>'endDate')::timestamptz
        ELSE NULL
      END,
      markets.end_date
    ) AS due_at
  FROM ticket_legs
  JOIN quote_legs ON quote_legs.id = ticket_legs.quote_leg_id
  JOIN market_snapshots ON market_snapshots.id = quote_legs.market_snapshot_id
  JOIN markets ON markets.id = quote_legs.market_id
  LEFT JOIN LATERAL (
    SELECT value
    FROM jsonb_array_elements(COALESCE(market_snapshots.raw->'outcomes', '[]'::jsonb)) AS outcome(value)
    WHERE outcome.value->>'outcome' = quote_legs.outcome
    LIMIT 1
  ) snapshot_outcome ON true
) AS frozen_due
WHERE ticket_legs.id = frozen_due.ticket_leg_id
  AND ticket_legs.settlement_due_at IS NULL
  AND frozen_due.due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS ticket_legs_unresolved_settlement_due_idx
  ON ticket_legs (settlement_due_at, resolution_state, created_at)
  WHERE status IN ('pending', 'disputed');

CREATE OR REPLACE FUNCTION enforce_ticket_leg_settlement_due_freeze()
RETURNS trigger AS $$
BEGIN
  IF NEW.settlement_frozen_at IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.settlement_frozen_at IS NULL)
    AND NEW.settlement_due_at IS NULL
  THEN
    RAISE EXCEPTION 'frozen_ticket_leg_settlement_due_missing:%', NEW.id;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.settlement_frozen_at IS NOT NULL
    AND NEW.settlement_due_at IS DISTINCT FROM OLD.settlement_due_at
  THEN
    RAISE EXCEPTION 'frozen_ticket_leg_settlement_due_immutable:%', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_legs_settlement_due_freeze ON ticket_legs;
CREATE TRIGGER ticket_legs_settlement_due_freeze
BEFORE INSERT OR UPDATE ON ticket_legs
FOR EACH ROW
EXECUTE FUNCTION enforce_ticket_leg_settlement_due_freeze();
