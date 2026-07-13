import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./client";

function microToUnits(value: string | number | null) {
  return Number(value || 0) / 1_000_000;
}

export type AccountSummary = {
  balances: Array<{
    accountType: string;
    currency: string;
    balance: number;
  }>;
  openTickets: number;
  openStakeUsd: number;
  openPotentialPayoutUsd: number;
  openNetLiabilityUsd: number;
};

export type HouseBankrollAdjustment = {
  transactionId: string;
  currency: "USDC";
  amountUsdc: number;
  houseOperatingBalanceUsdc: number;
};

async function ensureLedgerAccount(client: pg.PoolClient, userId: string | null, accountType: string, currency: string) {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO ledger_accounts (user_id, account_type, currency)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [userId, accountType, currency]
  );

  if (result.rows[0]) return result.rows[0].id;

  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM ledger_accounts
      WHERE user_id IS NOT DISTINCT FROM $1
        AND account_type = $2
        AND currency = $3
      LIMIT 1
    `,
    [userId, accountType, currency]
  );

  if (!existing.rows[0]) throw new Error(`Unable to create ledger account ${accountType}:${currency}`);
  return existing.rows[0].id;
}

async function ledgerBalanceMicroUnits(client: pg.PoolClient, accountId: string) {
  const result = await client.query<{ balance: string }>(
    `
      SELECT COALESCE(sum(amount_micro_units), 0)::text AS balance
      FROM ledger_entries
      WHERE account_id = $1
    `,
    [accountId]
  );
  return Number(result.rows[0]?.balance || 0);
}

export async function getAccountSummary(userId: string): Promise<AccountSummary> {
  const balancesResult = await getPool().query<{
    accountType: string;
    currency: string;
    balance: string;
  }>(
    `
      SELECT
        ledger_accounts.account_type AS "accountType",
        ledger_accounts.currency,
        COALESCE(sum(ledger_entries.amount_micro_units), 0)::text AS balance
      FROM ledger_accounts
      LEFT JOIN ledger_entries ON ledger_entries.account_id = ledger_accounts.id
      WHERE ledger_accounts.user_id = $1
      GROUP BY ledger_accounts.id
      ORDER BY ledger_accounts.currency ASC, ledger_accounts.account_type ASC
    `,
    [userId]
  );

  const exposureResult = await getPool().query<{
    openTickets: string;
    openStakeMicroUsd: string;
    openPotentialPayoutMicroUsd: string;
    openNetLiabilityMicroUsd: string;
  }>(
    `
      SELECT
        count(DISTINCT tickets.id)::text AS "openTickets",
        COALESCE(sum(quotes.stake_micro_usd), 0)::text AS "openStakeMicroUsd",
        COALESCE(sum(quotes.offered_payout_micro_usd), 0)::text AS "openPotentialPayoutMicroUsd",
        COALESCE(sum(GREATEST(quotes.offered_payout_micro_usd - quotes.stake_micro_usd, 0)), 0)::text AS "openNetLiabilityMicroUsd"
      FROM tickets
      JOIN quotes ON quotes.id = tickets.quote_id
      WHERE tickets.user_id = $1
        AND tickets.status IN ('accepted', 'live')
    `,
    [userId]
  );
  const exposure = exposureResult.rows[0];

  return {
    balances: balancesResult.rows.map((row) => ({
      accountType: row.accountType,
      currency: row.currency,
      balance: microToUnits(row.balance)
    })),
    openTickets: Number(exposure?.openTickets || 0),
    openStakeUsd: microToUnits(exposure?.openStakeMicroUsd || 0),
    openPotentialPayoutUsd: microToUnits(exposure?.openPotentialPayoutMicroUsd || 0),
    openNetLiabilityUsd: microToUnits(exposure?.openNetLiabilityMicroUsd || 0)
  };
}

export async function fundHouseBankroll(input: {
  amountUsdc: number;
  operatorId: string;
  reason: string;
  reference: string;
}): Promise<HouseBankrollAdjustment> {
  if (!Number.isFinite(input.amountUsdc) || input.amountUsdc <= 0) {
    throw new Error("invalid_bankroll_amount");
  }

  const amountMicroUnits = Math.round(input.amountUsdc * 1_000_000);
  if (amountMicroUnits <= 0) {
    throw new Error("invalid_bankroll_amount");
  }

  const client = await getPool().connect();
  const transactionId = randomUUID();

  try {
    await client.query("BEGIN");
    const houseOperatingAccountId = await ensureLedgerAccount(client, null, "house_usdc_operating", "USDC");
    const externalFundingAccountId = await ensureLedgerAccount(client, null, "external_house_funding", "USDC");

    await client.query("SELECT id FROM ledger_accounts WHERE id IN ($1, $2) ORDER BY id FOR UPDATE", [
      houseOperatingAccountId,
      externalFundingAccountId
    ]);

    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, 'USDC', 'house bankroll funded'),
          ($1, $4, $5, 'USDC', 'house bankroll funded')
      `,
      [transactionId, houseOperatingAccountId, amountMicroUnits, externalFundingAccountId, -amountMicroUnits]
    );

    await client.query(
      `
        INSERT INTO audit_log (action, entity_type, entity_id, metadata)
        VALUES ('house_bankroll.funded', 'ledger_transaction', $1, $2)
      `,
      [
        transactionId,
        {
          operatorId: input.operatorId,
          amountMicroUnits,
          currency: "USDC",
          reason: input.reason,
          reference: input.reference
        }
      ]
    );

    const balance = await ledgerBalanceMicroUnits(client, houseOperatingAccountId);
    await client.query("COMMIT");

    return {
      transactionId,
      currency: "USDC",
      amountUsdc: amountMicroUnits / 1_000_000,
      houseOperatingBalanceUsdc: balance / 1_000_000
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
