ALTER TABLE quote_payment_intents
  DROP CONSTRAINT IF EXISTS quote_payment_intents_status_check;

ALTER TABLE quote_payment_intents
  ADD CONSTRAINT quote_payment_intents_status_check
  CHECK (status IN ('pending', 'submitted', 'confirmed', 'activating', 'activated', 'expired', 'failed', 'recoverable'));

ALTER TABLE quote_payment_intents
  ADD COLUMN IF NOT EXISTS submission_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tracking_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activation_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activation_claim_token UUID,
  ADD COLUMN IF NOT EXISTS activation_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activation_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_adverse_bps INTEGER NOT NULL DEFAULT 50 CHECK (max_adverse_bps >= 0),
  ADD COLUMN IF NOT EXISTS estimated_payout_micro_usd BIGINT,
  ADD COLUMN IF NOT EXISTS min_final_payout_micro_usd BIGINT,
  ADD COLUMN IF NOT EXISTS final_payout_micro_usd BIGINT,
  ADD COLUMN IF NOT EXISTS final_quote_id UUID,
  ADD COLUMN IF NOT EXISTS amount_received_micro_units BIGINT CHECK (amount_received_micro_units >= 0),
  ADD COLUMN IF NOT EXISTS surplus_micro_units BIGINT CHECK (surplus_micro_units >= 0),
  ADD COLUMN IF NOT EXISTS checkout_ledger_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_release_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS surplus_release_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS activation_funding_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS recovery_detail TEXT;

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS parent_quote_id UUID REFERENCES quotes(id),
  ADD COLUMN IF NOT EXISTS quote_kind TEXT NOT NULL DEFAULT 'estimate';

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_quote_kind_check;

ALTER TABLE quotes
  ADD CONSTRAINT quotes_quote_kind_check
  CHECK (quote_kind IN ('estimate', 'final'));

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_final_parent_check;

ALTER TABLE quotes
  ADD CONSTRAINT quotes_final_parent_check
  CHECK (
    (quote_kind = 'estimate' AND parent_quote_id IS NULL)
    OR (quote_kind = 'final' AND parent_quote_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS quotes_parent_kind_idx
  ON quotes (parent_quote_id, quote_kind, created_at DESC);

ALTER TABLE quote_payment_intents
  DROP CONSTRAINT IF EXISTS quote_payment_intents_final_quote_fk;

ALTER TABLE quote_payment_intents
  ADD CONSTRAINT quote_payment_intents_final_quote_fk
  FOREIGN KEY (final_quote_id) REFERENCES quotes(id);

ALTER TABLE quote_payment_intents
  ALTER COLUMN amount_received_micro_units DROP DEFAULT,
  ALTER COLUMN surplus_micro_units DROP DEFAULT;

CREATE TABLE IF NOT EXISTS direct_pay_migration_quarantine (
  payment_intent_id UUID PRIMARY KEY REFERENCES quote_payment_intents(id) ON DELETE CASCADE,
  original_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TABLE IF EXISTS pg_temp.direct_pay_migration_evidence;

CREATE TEMP TABLE direct_pay_migration_evidence AS
WITH checkout_evidence AS (
  SELECT
    payment_intents.id AS payment_intent_id,
    sum(ledger_entries.amount_micro_units)::BIGINT AS amount_micro_units
  FROM quote_payment_intents payment_intents
  JOIN ledger_entries
    ON ledger_entries.transaction_id = payment_intents.checkout_ledger_transaction_id
   AND ledger_entries.currency = 'USDC'
  JOIN ledger_accounts
    ON ledger_accounts.id = ledger_entries.account_id
   AND ledger_accounts.user_id = payment_intents.user_id
   AND ledger_accounts.account_type = 'user_usdc_checkout'
   AND ledger_accounts.currency = 'USDC'
  WHERE payment_intents.checkout_ledger_transaction_id IS NOT NULL
  GROUP BY payment_intents.id
  HAVING sum(ledger_entries.amount_micro_units) > 0
),
deposit_candidates AS (
  SELECT
    payment_intents.id AS payment_intent_id,
    deposits.id AS deposit_id,
    deposits.amount_micro_units,
    count(*) OVER (PARTITION BY payment_intents.id) AS candidate_count
  FROM quote_payment_intents payment_intents
  JOIN onchain_deposits deposits
    ON deposits.chain_id = payment_intents.chain_id
   AND deposits.tx_hash = payment_intents.tx_hash
   AND lower(deposits.to_address) = lower(payment_intents.treasury_address)
   AND lower(deposits.token_address) = lower(payment_intents.usdc_contract_address)
   AND deposits.user_id = payment_intents.user_id
   AND deposits.status = 'credited'
   AND deposits.credited_transaction_id IS NOT NULL
   AND (
     deposits.id = payment_intents.onchain_deposit_id
     OR payment_intents.onchain_deposit_id IS NULL
   )
),
deposit_evidence AS (
  SELECT payment_intent_id, deposit_id, amount_micro_units
  FROM deposit_candidates
  WHERE candidate_count = 1
)
SELECT
  payment_intents.id AS payment_intent_id,
  checkout_evidence.amount_micro_units AS checkout_amount_micro_units,
  deposit_evidence.amount_micro_units AS deposit_amount_micro_units,
  deposit_evidence.deposit_id,
  COALESCE(checkout_evidence.amount_micro_units, deposit_evidence.amount_micro_units) AS resolved_amount_micro_units
FROM quote_payment_intents payment_intents
LEFT JOIN checkout_evidence ON checkout_evidence.payment_intent_id = payment_intents.id
LEFT JOIN deposit_evidence ON deposit_evidence.payment_intent_id = payment_intents.id;

UPDATE quote_payment_intents AS payment_intents
SET amount_received_micro_units = NULL,
    surplus_micro_units = NULL,
    updated_at = now()
WHERE payment_intents.amount_received_micro_units = 0
  AND payment_intents.status IN ('pending', 'submitted', 'confirmed', 'activating', 'activated')
  AND NOT EXISTS (
    SELECT 1
    FROM direct_pay_migration_evidence evidence
    WHERE evidence.payment_intent_id = payment_intents.id
      AND evidence.resolved_amount_micro_units IS NOT NULL
  );

UPDATE quote_payment_intents AS payment_intents
SET
  amount_received_micro_units = evidence.resolved_amount_micro_units,
  surplus_micro_units = GREATEST(evidence.resolved_amount_micro_units - payment_intents.amount_micro_units, 0),
  onchain_deposit_id = COALESCE(payment_intents.onchain_deposit_id, evidence.deposit_id),
  updated_at = now()
FROM direct_pay_migration_evidence evidence
WHERE evidence.payment_intent_id = payment_intents.id
  AND evidence.resolved_amount_micro_units IS NOT NULL
  AND (payment_intents.amount_received_micro_units IS NULL OR payment_intents.amount_received_micro_units = 0);

INSERT INTO direct_pay_migration_quarantine (payment_intent_id, original_status, reason, evidence)
SELECT
  payment_intents.id,
  payment_intents.status,
  CASE
    WHEN evidence.checkout_amount_micro_units IS DISTINCT FROM evidence.deposit_amount_micro_units
      AND evidence.checkout_amount_micro_units IS NOT NULL
      AND evidence.deposit_amount_micro_units IS NOT NULL
      THEN 'legacy_direct_pay_evidence_conflict'
    WHEN payment_intents.amount_received_micro_units IS NOT NULL
      AND payment_intents.amount_received_micro_units < payment_intents.amount_micro_units
      THEN 'legacy_direct_pay_activated_underpayment'
    ELSE 'legacy_direct_pay_payment_evidence_missing'
  END,
  jsonb_build_object(
    'amountDueMicroUnits', payment_intents.amount_micro_units,
    'amountReceivedMicroUnits', payment_intents.amount_received_micro_units,
    'checkoutAmountMicroUnits', evidence.checkout_amount_micro_units,
    'depositAmountMicroUnits', evidence.deposit_amount_micro_units,
    'onchainDepositId', payment_intents.onchain_deposit_id,
    'checkoutLedgerTransactionId', payment_intents.checkout_ledger_transaction_id
  )
FROM quote_payment_intents payment_intents
LEFT JOIN direct_pay_migration_evidence evidence ON evidence.payment_intent_id = payment_intents.id
WHERE (
    (
      payment_intents.status IN ('confirmed', 'activating', 'activated')
      AND payment_intents.amount_received_micro_units IS NULL
    )
    OR (
      payment_intents.status = 'activated'
      AND payment_intents.amount_received_micro_units < payment_intents.amount_micro_units
    )
    OR (
      payment_intents.status IN ('submitted', 'confirmed', 'activating', 'activated')
      AND evidence.checkout_amount_micro_units IS DISTINCT FROM evidence.deposit_amount_micro_units
      AND evidence.checkout_amount_micro_units IS NOT NULL
      AND evidence.deposit_amount_micro_units IS NOT NULL
    )
  )
ON CONFLICT (payment_intent_id) DO NOTHING;

UPDATE quote_payment_intents AS payment_intents
SET
  status = 'recoverable',
  recovery_reason = CASE
    WHEN payment_intents.amount_received_micro_units > 0
      AND payment_intents.amount_received_micro_units < payment_intents.amount_micro_units
      THEN 'underpayment'
    ELSE 'activation_failed'
  END,
  recovery_detail = 'Legacy direct-pay intent requires evidence-backed recovery after migration.',
  updated_at = now()
WHERE payment_intents.status IN ('confirmed', 'activating')
  AND (
    payment_intents.amount_received_micro_units < payment_intents.amount_micro_units
    OR EXISTS (
      SELECT 1
      FROM direct_pay_migration_quarantine quarantine
      WHERE quarantine.payment_intent_id = payment_intents.id
    )
  );

UPDATE quote_payment_intents AS payment_intents
SET
  status = CASE
    WHEN EXISTS (
      SELECT 1
      FROM direct_pay_migration_quarantine quarantine
      WHERE quarantine.payment_intent_id = payment_intents.id
    ) THEN 'recoverable'
    WHEN payment_intents.amount_received_micro_units >= payment_intents.amount_micro_units THEN 'confirmed'
    ELSE 'recoverable'
  END,
  recovery_reason = CASE
    WHEN EXISTS (
      SELECT 1
      FROM direct_pay_migration_quarantine quarantine
      WHERE quarantine.payment_intent_id = payment_intents.id
    ) THEN 'activation_failed'
    WHEN payment_intents.amount_received_micro_units < payment_intents.amount_micro_units THEN 'underpayment'
    ELSE NULL
  END,
  recovery_detail = CASE
    WHEN EXISTS (
      SELECT 1
      FROM direct_pay_migration_quarantine quarantine
      WHERE quarantine.payment_intent_id = payment_intents.id
    ) THEN 'Legacy submitted transfer has conflicting canonical payment evidence.'
    WHEN payment_intents.amount_received_micro_units < payment_intents.amount_micro_units
      THEN 'Legacy submitted transfer was confirmed below the requested amount.'
    ELSE NULL
  END,
  confirmed_at = COALESCE(payment_intents.confirmed_at, payment_intents.updated_at, payment_intents.created_at),
  updated_at = now()
WHERE payment_intents.status = 'submitted'
  AND payment_intents.amount_received_micro_units IS NOT NULL
  AND payment_intents.amount_received_micro_units > 0;

DROP TABLE IF EXISTS direct_pay_migration_evidence;

UPDATE quote_payment_intents AS payment_intents
SET
  submission_deadline_at = COALESCE(payment_intents.submission_deadline_at, payment_intents.created_at + interval '3 minutes'),
  tracking_deadline_at = COALESCE(
    payment_intents.tracking_deadline_at,
    CASE
      WHEN payment_intents.submitted_at IS NOT NULL THEN payment_intents.submitted_at + interval '15 minutes'
      ELSE NULL
    END
  ),
  estimated_payout_micro_usd = COALESCE(payment_intents.estimated_payout_micro_usd, quotes.offered_payout_micro_usd),
  min_final_payout_micro_usd = COALESCE(
    payment_intents.min_final_payout_micro_usd,
    ((quotes.offered_payout_micro_usd * (10000 - payment_intents.max_adverse_bps)) + 9999) / 10000
  ),
  activation_deadline_at = COALESCE(
    payment_intents.activation_deadline_at,
    CASE
      WHEN payment_intents.confirmed_at IS NOT NULL THEN payment_intents.confirmed_at + interval '5 minutes'
      ELSE NULL
    END
  )
FROM quotes
WHERE quotes.id = payment_intents.quote_id;

ALTER TABLE quote_payment_intents
  ALTER COLUMN submission_deadline_at SET NOT NULL,
  ALTER COLUMN estimated_payout_micro_usd SET NOT NULL,
  ALTER COLUMN min_final_payout_micro_usd SET NOT NULL;

ALTER TABLE quote_payment_intents
  DROP CONSTRAINT IF EXISTS quote_payment_intents_recovery_reason_check;

ALTER TABLE quote_payment_intents
  ADD CONSTRAINT quote_payment_intents_recovery_reason_check
  CHECK (
    recovery_reason IS NULL
    OR recovery_reason IN (
      'late_submission',
      'late_confirmation',
      'underpayment',
      'requote_adverse',
      'market_closed',
      'stale_book',
      'insufficient_depth',
      'risk_review',
      'risk_rejected',
      'exposure_limit',
      'quote_not_found',
      'activation_failed'
    )
  );

CREATE TABLE IF NOT EXISTS quote_payment_exposure_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL UNIQUE REFERENCES quote_payment_intents(id) ON DELETE CASCADE,
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  liability_micro_usd BIGINT NOT NULL CHECK (liability_micro_usd >= 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'released', 'consumed', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quote_payment_exposure_reservations_active_idx
  ON quote_payment_exposure_reservations (status, expires_at, quote_id);

CREATE INDEX IF NOT EXISTS quote_payment_exposure_reservations_user_idx
  ON quote_payment_exposure_reservations (user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS quote_reprice_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  quote_leg_id UUID REFERENCES quote_legs(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quote_reprice_evidence_quote_idx
  ON quote_reprice_evidence (quote_id, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS quote_reprice_evidence_leg_type_idx
  ON quote_reprice_evidence (quote_id, quote_leg_id, evidence_type)
  WHERE quote_leg_id IS NOT NULL;

ALTER TABLE quote_reprice_evidence
  DROP CONSTRAINT IF EXISTS quote_reprice_evidence_quote_leg_required,
  DROP CONSTRAINT IF EXISTS quote_reprice_evidence_canonical_check;

ALTER TABLE quote_reprice_evidence
  ADD CONSTRAINT quote_reprice_evidence_quote_leg_required
  CHECK (quote_leg_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT quote_reprice_evidence_canonical_check
  CHECK (
    (
      evidence_type = 'catalog_snapshot'
      AND evidence ? 'estimateQuoteId'
      AND evidence ? 'estimateQuoteLegId'
      AND evidence ? 'market'
      AND evidence ? 'snapshot'
      AND evidence->'snapshot' ? 'id'
      AND evidence->'snapshot' ? 'sourceResponseHash'
      AND evidence->'snapshot' ? 'capturedAt'
    )
    OR (
      evidence_type = 'live_orderbook'
      AND evidence ? 'market'
      AND evidence ? 'orderbook'
      AND evidence ? 'depth'
      AND evidence ? 'execution'
      AND evidence->'orderbook' ? 'hash'
      AND evidence->'orderbook' ? 'fetchedAt'
      AND evidence->'orderbook' ? 'sourceTimestamp'
      AND evidence->'orderbook' ? 'bestAsk'
      AND evidence->'depth' ? 'requestedNotionalUsd'
      AND evidence->'depth' ? 'availableNotionalUsd'
      AND evidence->'execution' ? 'executablePrice'
    )
    OR (
      evidence_type = 'ask_depth_vwap'
      AND evidence ? 'marketSnapshot'
      AND evidence ? 'orderbook'
      AND evidence ? 'depth'
      AND evidence ? 'execution'
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION prevent_quote_reprice_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'quote_reprice_evidence_append_only:%', OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quote_reprice_evidence_append_only_trigger ON quote_reprice_evidence;

CREATE TRIGGER quote_reprice_evidence_append_only_trigger
BEFORE UPDATE OR DELETE ON quote_reprice_evidence
FOR EACH ROW
EXECUTE FUNCTION prevent_quote_reprice_evidence_mutation();

CREATE OR REPLACE FUNCTION enforce_final_quote_reprice_evidence()
RETURNS trigger AS $$
DECLARE
  target_quote_id UUID;
  missing_evidence_count INTEGER;
  final_leg_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'quotes' THEN
    target_quote_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_quote_id := COALESCE(NEW.quote_id, OLD.quote_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM quotes
    WHERE id = target_quote_id
      AND quote_kind = 'final'
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT
    count(*)::INTEGER,
    count(*) FILTER (
      WHERE NOT (
        EXISTS (
          SELECT 1
          FROM quote_reprice_evidence legacy_evidence
          WHERE legacy_evidence.quote_id = quote_legs.quote_id
            AND legacy_evidence.quote_leg_id = quote_legs.id
            AND legacy_evidence.evidence_type = 'ask_depth_vwap'
        )
        OR (
          EXISTS (
            SELECT 1
            FROM quote_reprice_evidence catalog_evidence
            WHERE catalog_evidence.quote_id = quote_legs.quote_id
              AND catalog_evidence.quote_leg_id = quote_legs.id
              AND catalog_evidence.evidence_type = 'catalog_snapshot'
          )
          AND EXISTS (
            SELECT 1
            FROM quote_reprice_evidence live_evidence
            WHERE live_evidence.quote_id = quote_legs.quote_id
              AND live_evidence.quote_leg_id = quote_legs.id
              AND live_evidence.evidence_type = 'live_orderbook'
          )
        )
      )
    )::INTEGER
  INTO final_leg_count, missing_evidence_count
  FROM quote_legs
  WHERE quote_legs.quote_id = target_quote_id;

  IF final_leg_count = 0 OR missing_evidence_count > 0 THEN
    RAISE EXCEPTION 'final_quote_reprice_evidence_required:%', target_quote_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS final_quote_reprice_evidence_required_on_quotes ON quotes;
DROP TRIGGER IF EXISTS final_quote_reprice_evidence_required_on_legs ON quote_legs;
DROP TRIGGER IF EXISTS final_quote_reprice_evidence_required_on_evidence ON quote_reprice_evidence;

CREATE CONSTRAINT TRIGGER final_quote_reprice_evidence_required_on_quotes
AFTER INSERT OR UPDATE ON quotes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_final_quote_reprice_evidence();

CREATE CONSTRAINT TRIGGER final_quote_reprice_evidence_required_on_legs
AFTER INSERT OR UPDATE ON quote_legs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_final_quote_reprice_evidence();

CREATE CONSTRAINT TRIGGER final_quote_reprice_evidence_required_on_evidence
AFTER INSERT ON quote_reprice_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_final_quote_reprice_evidence();

CREATE OR REPLACE VIEW soft_market_exposure AS
SELECT
  markets.id AS market_id,
  markets.source,
  markets.source_market_id,
  markets.question,
  markets.market_url,
  market_outcomes.outcome,
  count(DISTINCT quote_payment_exposure_reservations.payment_intent_id)::BIGINT AS open_payment_intents,
  sum(quote_payment_exposure_reservations.liability_micro_usd)::BIGINT AS worst_case_liability_micro_usd
FROM quote_payment_exposure_reservations
JOIN quote_legs ON quote_legs.quote_id = quote_payment_exposure_reservations.quote_id
JOIN markets ON markets.id = quote_legs.market_id
JOIN market_outcomes ON market_outcomes.id = quote_legs.outcome_id
WHERE quote_payment_exposure_reservations.status = 'reserved'
  AND quote_payment_exposure_reservations.expires_at > now()
GROUP BY
  markets.id,
  markets.source,
  markets.source_market_id,
  markets.question,
  markets.market_url,
  market_outcomes.outcome;

CREATE OR REPLACE VIEW soft_event_exposure AS
SELECT
  market_url,
  count(DISTINCT market_id)::BIGINT AS markets,
  sum(open_payment_intents)::BIGINT AS open_payment_intents,
  sum(worst_case_liability_micro_usd)::BIGINT AS worst_case_liability_micro_usd
FROM soft_market_exposure
GROUP BY market_url;

CREATE OR REPLACE VIEW open_market_exposure_with_soft AS
SELECT
  COALESCE(open_market_exposure.market_id, soft_market_exposure.market_id) AS market_id,
  COALESCE(open_market_exposure.source, soft_market_exposure.source) AS source,
  COALESCE(open_market_exposure.source_market_id, soft_market_exposure.source_market_id) AS source_market_id,
  COALESCE(open_market_exposure.question, soft_market_exposure.question) AS question,
  COALESCE(open_market_exposure.market_url, soft_market_exposure.market_url) AS market_url,
  COALESCE(open_market_exposure.outcome, soft_market_exposure.outcome) AS outcome,
  COALESCE(open_market_exposure.open_tickets, 0)::BIGINT AS open_tickets,
  COALESCE(soft_market_exposure.open_payment_intents, 0)::BIGINT AS open_payment_intents,
  (
    COALESCE(open_market_exposure.worst_case_liability_micro_usd, 0)
    + COALESCE(soft_market_exposure.worst_case_liability_micro_usd, 0)
  )::BIGINT AS worst_case_liability_micro_usd
FROM open_market_exposure
FULL OUTER JOIN soft_market_exposure
  ON soft_market_exposure.market_id = open_market_exposure.market_id
  AND soft_market_exposure.outcome = open_market_exposure.outcome;

CREATE OR REPLACE VIEW open_event_exposure_with_soft AS
SELECT
  market_url,
  count(DISTINCT market_id)::BIGINT AS markets,
  sum(open_tickets)::BIGINT AS open_ticket_legs,
  sum(open_payment_intents)::BIGINT AS open_payment_intents,
  sum(worst_case_liability_micro_usd)::BIGINT AS worst_case_liability_micro_usd
FROM open_market_exposure_with_soft
GROUP BY market_url;

DROP INDEX IF EXISTS quote_payment_intents_chain_tx_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS quote_payment_intents_chain_tx_unique_idx
  ON quote_payment_intents (chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL
    AND status IN ('pending', 'submitted', 'confirmed', 'activating', 'activated', 'expired', 'recoverable');

CREATE INDEX IF NOT EXISTS quote_payment_intents_activation_work_idx
  ON quote_payment_intents (status, activation_deadline_at, confirmed_at)
  WHERE status IN ('confirmed', 'activating');

CREATE OR REPLACE FUNCTION prevent_policy_version_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.version IS DISTINCT FROM NEW.version
    OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.policy IS DISTINCT FROM NEW.policy
    OR OLD.active IS DISTINCT FROM NEW.active
  THEN
    RAISE EXCEPTION 'policy_version_immutable:%', OLD.version;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS policy_versions_immutable_trigger ON policy_versions;

CREATE TRIGGER policy_versions_immutable_trigger
BEFORE UPDATE ON policy_versions
FOR EACH ROW
EXECUTE FUNCTION prevent_policy_version_mutation();
