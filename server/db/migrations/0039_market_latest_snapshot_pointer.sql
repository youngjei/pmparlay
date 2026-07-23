-- The public catalog normally reads the newest snapshot for every live market.
-- Keep that relationship on markets so the read is a primary-key join instead of
-- one latest-snapshot index lookup per candidate market.
SET LOCAL lock_timeout = '5s';

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS current_snapshot_id UUID;

ALTER TABLE markets
  DROP CONSTRAINT IF EXISTS markets_current_snapshot_id_fkey;

ALTER TABLE markets
  ADD CONSTRAINT markets_current_snapshot_id_fkey
  FOREIGN KEY (current_snapshot_id) REFERENCES market_snapshots(id)
  NOT VALID;

CREATE OR REPLACE FUNCTION maintain_market_current_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE markets
    SET current_snapshot_id = NEW.id
    WHERE id = NEW.market_id
      AND (
        current_snapshot_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM market_snapshots AS current_snapshot
          WHERE current_snapshot.id = markets.current_snapshot_id
            AND current_snapshot.catalog_sequence >= NEW.catalog_sequence
        )
      );
    RETURN NEW;
  END IF;

  -- Snapshot pruning intentionally retains the newest two unreferenced rows,
  -- but keep the pointer valid for direct administrative deletes as well.
  UPDATE markets
  SET current_snapshot_id = replacement.id
  FROM LATERAL (
    SELECT id
    FROM market_snapshots
    WHERE market_id = OLD.market_id
      AND id <> OLD.id
    ORDER BY catalog_sequence DESC NULLS LAST, id DESC
    LIMIT 1
  ) AS replacement
  WHERE markets.id = OLD.market_id
    AND markets.current_snapshot_id = OLD.id;

  UPDATE markets
  SET current_snapshot_id = NULL
  WHERE id = OLD.market_id
    AND current_snapshot_id = OLD.id;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS market_snapshots_current_snapshot_insert ON market_snapshots;
CREATE TRIGGER market_snapshots_current_snapshot_insert
AFTER INSERT ON market_snapshots
FOR EACH ROW
EXECUTE FUNCTION maintain_market_current_snapshot();

DROP TRIGGER IF EXISTS market_snapshots_current_snapshot_delete ON market_snapshots;
CREATE TRIGGER market_snapshots_current_snapshot_delete
BEFORE DELETE ON market_snapshots
FOR EACH ROW
EXECUTE FUNCTION maintain_market_current_snapshot();
