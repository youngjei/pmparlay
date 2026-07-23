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

export const accountFinancialIntegrationHooks = {
  houseFundingEntrypoint: "server/recordHouseFunding.ts",
  evidenceTable: "house_funding_evidence"
} as const;

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
