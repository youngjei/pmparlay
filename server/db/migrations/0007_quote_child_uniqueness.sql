CREATE UNIQUE INDEX quote_legs_quote_outcome_idx
  ON quote_legs (quote_id, outcome_id);

CREATE UNIQUE INDEX risk_checks_quote_label_detail_idx
  ON risk_checks (quote_id, label, detail);
