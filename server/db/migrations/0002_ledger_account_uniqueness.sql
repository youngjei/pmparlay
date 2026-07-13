CREATE UNIQUE INDEX IF NOT EXISTS ledger_user_account_unique
  ON ledger_accounts (user_id, account_type, currency)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_platform_account_unique
  ON ledger_accounts (account_type, currency)
  WHERE user_id IS NULL;
