CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE market_snapshots
  ADD COLUMN IF NOT EXISTS catalog_sequence BIGSERIAL;

CREATE INDEX IF NOT EXISTS market_snapshots_market_sequence_idx
  ON market_snapshots (market_id, catalog_sequence DESC);

CREATE TABLE IF NOT EXISTS market_catalog_sweep_state (
  source TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  generation_version INTEGER NOT NULL DEFAULT 0 CHECK (generation_version >= 0),
  generation_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generation_started_after_cursor TEXT,
  next_cursor TEXT,
  seen_market_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  attempted_pages INTEGER NOT NULL DEFAULT 0 CHECK (attempted_pages >= 0),
  successful_pages INTEGER NOT NULL DEFAULT 0 CHECK (successful_pages >= 0),
  complete BOOLEAN NOT NULL DEFAULT false,
  truncated BOOLEAN NOT NULL DEFAULT false,
  stopped_reason TEXT CHECK (stopped_reason IN ('end', 'request_failed', 'duplicate_page', 'duplicate_cursor', 'page_cap')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

DROP INDEX IF EXISTS markets_catalog_search_idx;

CREATE INDEX IF NOT EXISTS markets_catalog_search_trgm_idx
  ON markets USING gin ((
    coalesce(question, '') || ' ' ||
    coalesce(event_title, '') || ' ' ||
    coalesce(event_slug, '') || ' ' ||
    coalesce(source_market_id, '')
  ) gin_trgm_ops)
  WHERE source = 'polymarket';

CREATE INDEX IF NOT EXISTS market_catalog_sweep_state_next_cursor_idx
  ON market_catalog_sweep_state (source, next_cursor)
  WHERE next_cursor IS NOT NULL;
