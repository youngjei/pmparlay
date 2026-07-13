import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getAddress, isAddress, zeroAddress } from "viem";
import { getPool } from "./client";
import { claimConfirmedQuotePaymentDeposit } from "./paymentIntentRepository";

function normalizeAddress(value: string) {
  if (!isAddress(value)) throw new Error("invalid_evm_address");
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error("invalid_evm_address");
  return address.toLowerCase();
}

async function ensureLedgerAccount(client: pg.PoolClient, userId: string | null, accountType: string, currency: "USDC") {
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
  if (!existing.rows[0]) throw new Error(`Unable to create ledger account ${accountType}:USDC`);
  return existing.rows[0].id;
}

export type ConfirmedDepositInput = {
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash?: string;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string;
  amountMicroUnits: bigint;
  confirmations: number;
  raw: unknown;
};

export async function creditConfirmedDeposit(input: ConfirmedDepositInput) {
  const fromAddress = normalizeAddress(input.fromAddress);
  const toAddress = normalizeAddress(input.toAddress);
  const tokenAddress = normalizeAddress(input.tokenAddress);
  if (input.amountMicroUnits <= 0n) throw new Error("invalid_deposit_amount");

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO onchain_deposits (
          chain_id,
          tx_hash,
          log_index,
          block_number,
          block_hash,
          from_address,
          to_address,
          token_address,
          amount_micro_units,
          status,
          confirmations,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'observed', $10, $11)
        ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
      `,
      [
        input.chainId,
        input.txHash,
        input.logIndex,
        input.blockNumber.toString(),
        input.blockHash || null,
        fromAddress,
        toAddress,
        tokenAddress,
        input.amountMicroUnits.toString(),
        input.confirmations,
        input.raw
      ]
    );

    const depositResult = await client.query<{
      id: string;
      status: "observed" | "credited" | "ignored";
      credited_transaction_id: string | null;
    }>(
      `
        SELECT id, status, credited_transaction_id
        FROM onchain_deposits
        WHERE chain_id = $1
          AND tx_hash = $2
          AND log_index = $3
        FOR UPDATE
      `,
      [input.chainId, input.txHash, input.logIndex]
    );
    const deposit = depositResult.rows[0];
    if (!deposit) throw new Error("deposit_record_missing");
    if (deposit.status === "credited" || deposit.status === "ignored") {
      await client.query("COMMIT");
      return {
        id: deposit.id,
        status: deposit.status,
        ledgerTransactionId: deposit.credited_transaction_id || undefined
      };
    }

    const walletResult = await client.query<{ id: string; user_id: string }>(
      `
        SELECT id, user_id
        FROM user_wallets
        WHERE address = $1
          AND chain_id = $2
          AND active = true
        LIMIT 1
        FOR UPDATE
      `,
      [fromAddress, input.chainId]
    );
    const wallet = walletResult.rows[0];
    if (!wallet) {
      await client.query(
        `
          UPDATE onchain_deposits
          SET status = 'ignored', confirmations = $2, updated_at = now()
          WHERE id = $1
        `,
        [deposit.id, input.confirmations]
      );
      await client.query("COMMIT");
      return {
        id: deposit.id,
        status: "ignored" as const
      };
    }

    const quotePayment = await claimConfirmedQuotePaymentDeposit(client, {
      chainId: input.chainId,
      txHash: input.txHash,
      depositId: deposit.id,
      userId: wallet.user_id,
      walletId: wallet.id,
      fromAddress,
      toAddress,
      tokenAddress,
      amountMicroUnits: input.amountMicroUnits,
      confirmations: input.confirmations
    });
    if (quotePayment) {
      await client.query(
        `
          UPDATE onchain_deposits
          SET
            status = 'credited',
            user_id = $2,
            wallet_id = $3,
            confirmations = $4,
            credited_transaction_id = $5,
            payment_intent_id = $6,
            updated_at = now()
          WHERE id = $1
        `,
        [deposit.id, wallet.user_id, wallet.id, input.confirmations, quotePayment.ledgerTransactionId, quotePayment.paymentIntentId]
      );
      await client.query("COMMIT");
      return {
        id: deposit.id,
        status: "payment_confirmed" as const,
        userId: wallet.user_id,
        walletId: wallet.id,
        quoteId: quotePayment.quoteId,
        paymentIntentId: quotePayment.paymentIntentId,
        ledgerTransactionId: quotePayment.ledgerTransactionId
      };
    }

    const transactionId = randomUUID();
    const userAccountId = await ensureLedgerAccount(client, wallet.user_id, "user_usdc_available", "USDC");
    const clearingAccountId = await ensureLedgerAccount(client, null, "external_usdc_deposits", "USDC");
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, 'USDC', 'onchain USDC deposit credited'),
          ($1, $4, $5, 'USDC', 'onchain USDC deposit credited')
      `,
      [transactionId, userAccountId, input.amountMicroUnits.toString(), clearingAccountId, (-input.amountMicroUnits).toString()]
    );
    await client.query(
      `
        UPDATE onchain_deposits
        SET
          status = 'credited',
          user_id = $2,
          wallet_id = $3,
          confirmations = $4,
          credited_transaction_id = $5,
          updated_at = now()
        WHERE id = $1
      `,
      [deposit.id, wallet.user_id, wallet.id, input.confirmations, transactionId]
    );
    await client.query(
      `
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'deposit.credited', 'onchain_deposit', $2, $3)
      `,
      [
        wallet.user_id,
        deposit.id,
        {
          chainId: input.chainId,
          txHash: input.txHash,
          logIndex: input.logIndex,
          amountMicroUnits: input.amountMicroUnits.toString(),
          ledgerTransactionId: transactionId
        }
      ]
    );
    await client.query("COMMIT");
    return {
      id: deposit.id,
      status: "credited" as const,
      userId: wallet.user_id,
      walletId: wallet.id,
      ledgerTransactionId: transactionId
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getScanCursor(chainId: number, cursorName: string) {
  const result = await getPool().query<{ lastScannedBlock: string }>(
    `
      SELECT last_scanned_block::text AS "lastScannedBlock"
      FROM onchain_scan_cursors
      WHERE chain_id = $1
        AND cursor_name = $2
      LIMIT 1
    `,
    [chainId, cursorName]
  );
  const row = result.rows[0];
  return row ? BigInt(row.lastScannedBlock) : undefined;
}

export async function saveScanCursor(chainId: number, cursorName: string, lastScannedBlock: bigint) {
  await getPool().query(
    `
      INSERT INTO onchain_scan_cursors (chain_id, cursor_name, last_scanned_block)
      VALUES ($1, $2, $3)
      ON CONFLICT (chain_id, cursor_name)
      DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = now()
    `,
    [chainId, cursorName, lastScannedBlock.toString()]
  );
}
