CREATE INDEX IF NOT EXISTS market_snapshots_catalog_sequence_desc_idx
  ON market_snapshots (catalog_sequence DESC);

CREATE INDEX IF NOT EXISTS markets_live_catalog_candidate_idx
  ON markets (end_date) INCLUDE (id)
  WHERE source = 'polymarket'
    AND publicly_visible = true
    AND active = true
    AND closed = false
    AND archived = false
    AND accepting_orders = true
    AND enable_order_book = true;
