-- Keep this data migration separate from the schema migration so existing
-- catalog readers can remain online until the backfill is complete. The whole
-- update is transactional: a timeout rolls it back and a rerun safely retries.
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '5s';

-- Serialize with persistMarketCatalog so a live index transaction cannot move a
-- pointer forward while this historical backfill is choosing its replacement.
SELECT pg_advisory_xact_lock(hashtext('market_catalog_sweep_state:polymarket'));

-- catalog_sequence is the catalog's snapshot-boundary ordering. Use the same
-- ordering here so existing public cursors retain their historical meaning.
UPDATE markets
SET current_snapshot_id = latest_snapshot.id
FROM (
  SELECT DISTINCT ON (market_id)
    market_id,
    id
  FROM market_snapshots
  ORDER BY market_id, catalog_sequence DESC NULLS LAST, id DESC
) AS latest_snapshot
WHERE markets.id = latest_snapshot.market_id
  AND markets.current_snapshot_id IS DISTINCT FROM latest_snapshot.id;

ALTER TABLE markets
  VALIDATE CONSTRAINT markets_current_snapshot_id_fkey;
