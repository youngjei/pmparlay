ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS source_category TEXT,
  ADD COLUMN IF NOT EXISTS canonical_category TEXT,
  ADD COLUMN IF NOT EXISTS source_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS taxonomy JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS event_group_key TEXT,
  ADD COLUMN IF NOT EXISTS event_title TEXT,
  ADD COLUMN IF NOT EXISTS event_slug TEXT,
  ADD COLUMN IF NOT EXISTS relationship_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS eligibility_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS publicly_visible BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accepting_orders BOOLEAN,
  ADD COLUMN IF NOT EXISTS enable_order_book BOOLEAN;

UPDATE markets
SET
  source_category = COALESCE(source_category, category),
  canonical_category = COALESCE(canonical_category, category),
  last_seen_at = COALESCE(last_seen_at, updated_at);

CREATE INDEX IF NOT EXISTS markets_public_catalog_idx
  ON markets (source, publicly_visible, active, closed, archived, end_date, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS markets_catalog_category_idx
  ON markets (source, canonical_category)
  WHERE publicly_visible = true;

CREATE INDEX IF NOT EXISTS markets_catalog_event_group_idx
  ON markets (source, event_group_key)
  WHERE publicly_visible = true;

CREATE INDEX IF NOT EXISTS markets_catalog_search_idx
  ON markets USING gin (to_tsvector('simple', coalesce(question, '') || ' ' || coalesce(event_title, '') || ' ' || coalesce(event_slug, '')));

CREATE INDEX IF NOT EXISTS market_snapshots_captured_idx
  ON market_snapshots (captured_at DESC);
