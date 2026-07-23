ALTER TABLE market_outcomes
  ADD COLUMN IF NOT EXISTS source_outcome_id TEXT;

UPDATE market_outcomes
SET source_outcome_id = markets.source_market_id || '-' || market_outcomes.outcome
FROM markets
WHERE markets.id = market_outcomes.market_id
  AND markets.source = 'polymarket'
  AND market_outcomes.source_outcome_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS market_outcomes_source_outcome_id_idx
  ON market_outcomes (source_outcome_id)
  WHERE source_outcome_id IS NOT NULL;
