-- Snapshot deletion checks this referencing column once per pruned row.
CREATE INDEX IF NOT EXISTS markets_current_snapshot_id_idx
  ON markets (current_snapshot_id);
