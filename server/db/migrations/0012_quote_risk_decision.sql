ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS risk_decision TEXT NOT NULL DEFAULT 'accept';

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_risk_decision_check;

ALTER TABLE quotes
  ADD CONSTRAINT quotes_risk_decision_check
  CHECK (risk_decision IN ('accept', 'review', 'reject'));
