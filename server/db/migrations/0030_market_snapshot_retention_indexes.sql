CREATE INDEX IF NOT EXISTS market_snapshots_market_sequence_idx
  ON market_snapshots (market_id, catalog_sequence DESC);

CREATE INDEX IF NOT EXISTS quote_legs_market_snapshot_idx
  ON quote_legs (market_snapshot_id);

CREATE INDEX IF NOT EXISTS ticket_legs_settlement_source_snapshot_idx
  ON ticket_legs (settlement_source_snapshot_id)
  WHERE settlement_source_snapshot_id IS NOT NULL;
