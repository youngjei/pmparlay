CREATE OR REPLACE VIEW open_market_exposure AS
SELECT
  markets.id AS market_id,
  markets.source,
  markets.source_market_id,
  markets.question,
  markets.market_url,
  market_outcomes.outcome,
  count(DISTINCT tickets.id)::BIGINT AS open_tickets,
  sum(GREATEST(quotes.offered_payout_micro_usd - quotes.stake_micro_usd, 0))::BIGINT AS worst_case_liability_micro_usd
FROM tickets
JOIN quotes ON quotes.id = tickets.quote_id
JOIN quote_legs ON quote_legs.quote_id = quotes.id
JOIN markets ON markets.id = quote_legs.market_id
JOIN market_outcomes ON market_outcomes.id = quote_legs.outcome_id
WHERE tickets.status IN ('accepted', 'live')
GROUP BY
  markets.id,
  markets.source,
  markets.source_market_id,
  markets.question,
  markets.market_url,
  market_outcomes.outcome;

CREATE OR REPLACE VIEW open_event_exposure AS
SELECT
  market_url,
  count(DISTINCT market_id)::BIGINT AS markets,
  sum(open_tickets)::BIGINT AS open_ticket_legs,
  sum(worst_case_liability_micro_usd)::BIGINT AS worst_case_liability_micro_usd
FROM open_market_exposure
GROUP BY market_url;
