import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getAddress, isAddress, zeroAddress } from "viem";
import { config } from "../config";
import { getPool } from "./client";

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function normalizeAddress(value: string) {
  if (!isAddress(value)) throw new Error("invalid_evm_address");
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error("invalid_evm_address");
  return address.toLowerCase();
}

function topicAddress(address: string) {
  return `0x${getAddress(address).slice(2).toLowerCase().padStart(64, "0")}`;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!config.ETHEREUM_RPC_URL) {
    throw new Error("withdrawal_receipt_verification_unavailable");
  }

  const response = await fetch(config.ETHEREUM_RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`ethereum_rpc_http_${response.status}`);
  }

  const payload = (await response.json()) as { result?: T | null; error?: { message?: string } };
  if (payload.error) {
    throw new Error(payload.error.message || "ethereum_rpc_error");
  }
  if (payload.result === undefined || payload.result === null) {
    throw new Error("withdrawal_tx_not_found");
  }

  return payload.result;
}

async function activeTreasuryForWithdrawal(client: pg.PoolClient, chainId: number) {
  const result = await client.query<{
    treasuryAddress: string;
    usdcContractAddress: string;
  }>(
    `
      SELECT
        treasury_address AS "treasuryAddress",
        usdc_contract_address AS "usdcContractAddress"
      FROM treasury_config
      WHERE chain_id = $1
        AND currency = 'USDC'
        AND active = true
      LIMIT 1
    `,
    [chainId]
  );
  const active = result.rows[0];
  if (active) {
    return {
      treasuryAddress: normalizeAddress(active.treasuryAddress),
      usdcContractAddress: normalizeAddress(active.usdcContractAddress)
    };
  }

  if (config.TREASURY_SAFE_ADDRESS && chainId === config.SETTLEMENT_CHAIN_ID) {
    return {
      treasuryAddress: normalizeAddress(config.TREASURY_SAFE_ADDRESS),
      usdcContractAddress: normalizeAddress(config.USDC_CONTRACT_ADDRESS)
    };
  }

  throw new Error("treasury_config_missing");
}

async function verifyWithdrawalTransfer(input: {
  chainId: number;
  txHash: string;
  destinationAddress: string;
  amountMicroUnits: bigint;
  treasuryAddress: string;
  usdcContractAddress: string;
}) {
  const receipt = await rpc<{
    status?: string;
    logs?: Array<{
      address?: string;
      topics?: string[];
      data?: string;
    }>;
  }>("eth_getTransactionReceipt", [input.txHash]);

  if (receipt.status !== "0x1") {
    throw new Error("withdrawal_tx_failed");
  }

  const treasuryTopic = topicAddress(input.treasuryAddress);
  const destinationTopic = topicAddress(input.destinationAddress);
  const usdcAddress = normalizeAddress(input.usdcContractAddress);
  const matchingLog = (receipt.logs || []).find((log) => {
    if (!log.address || normalizeAddress(log.address) !== usdcAddress) return false;
    if (log.topics?.[0]?.toLowerCase() !== transferTopic) return false;
    if (log.topics?.[1]?.toLowerCase() !== treasuryTopic) return false;
    if (log.topics?.[2]?.toLowerCase() !== destinationTopic) return false;
    if (!log.data) return false;
    return BigInt(log.data) === input.amountMicroUnits;
  });

  if (!matchingLog) {
    throw new Error("withdrawal_tx_transfer_mismatch");
  }
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

async function ledgerBalanceMicroUnits(client: pg.PoolClient, accountId: string) {
  const result = await client.query<{ balance: string }>(
    `
      SELECT COALESCE(sum(amount_micro_units), 0)::text AS balance
      FROM ledger_entries
      WHERE account_id = $1
    `,
    [accountId]
  );
  return BigInt(result.rows[0]?.balance || 0);
}

export type WithdrawalRequest = {
  id: string;
  status: string;
  chainId: number;
  destinationAddress: string;
  amountUsdc: number;
  onchainTxHash?: string;
  createdAt: string;
  updatedAt: string;
};

function microToUsdc(value: string | bigint) {
  return Number(value) / 1_000_000;
}

export async function createWithdrawalRequest(input: { userId: string; destinationAddress: string; amountMicroUnits: bigint; chainId: number }) {
  if (input.amountMicroUnits <= 0n) throw new Error("invalid_withdrawal_amount");
  const destinationAddress = normalizeAddress(input.destinationAddress);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const walletResult = await client.query<{ id: string }>(
      `
        SELECT id
        FROM user_wallets
        WHERE user_id = $1
          AND address = $2
          AND chain_id = $3
          AND active = true
        LIMIT 1
        FOR UPDATE
      `,
      [input.userId, destinationAddress, input.chainId]
    );
    const wallet = walletResult.rows[0];
    if (!wallet) throw new Error("destination_wallet_not_linked");

    const userAccountId = await ensureLedgerAccount(client, input.userId, "user_usdc_available", "USDC");
    const pendingAccountId = await ensureLedgerAccount(client, null, "pending_usdc_withdrawals", "USDC");
    await client.query("SELECT id FROM ledger_accounts WHERE id = ANY($1::uuid[]) FOR UPDATE", [[pendingAccountId, userAccountId].sort()]);
    const balance = await ledgerBalanceMicroUnits(client, userAccountId);
    if (balance < input.amountMicroUnits) {
      throw new Error("insufficient_user_balance");
    }

    const requestId = randomUUID();
    const transactionId = randomUUID();
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, 'USDC', 'withdrawal requested'),
          ($1, $4, $5, 'USDC', 'withdrawal requested')
      `,
      [transactionId, userAccountId, (-input.amountMicroUnits).toString(), pendingAccountId, input.amountMicroUnits.toString()]
    );
    await client.query(
      `
        INSERT INTO withdrawal_requests (
          id,
          user_id,
          wallet_id,
          chain_id,
          destination_address,
          amount_micro_units,
          status,
          request_transaction_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7)
      `,
      [requestId, input.userId, wallet.id, input.chainId, destinationAddress, input.amountMicroUnits.toString(), transactionId]
    );
    await client.query(
      `
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'withdrawal.requested', 'withdrawal_request', $2, $3)
      `,
      [
        input.userId,
        requestId,
        {
          destinationAddress,
          amountMicroUnits: input.amountMicroUnits.toString(),
          ledgerTransactionId: transactionId
        }
      ]
    );
    await client.query("COMMIT");
    return {
      id: requestId,
      status: "requested" as const,
      requestTransactionId: transactionId
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWithdrawalRequests(userId: string): Promise<WithdrawalRequest[]> {
  const result = await getPool().query<{
    id: string;
    status: string;
    chainId: number;
    destinationAddress: string;
    amountMicroUnits: string;
    onchainTxHash: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(
    `
      SELECT
        id,
        status,
        chain_id AS "chainId",
        destination_address AS "destinationAddress",
        amount_micro_units::text AS "amountMicroUnits",
        onchain_tx_hash AS "onchainTxHash",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM withdrawal_requests
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    chainId: row.chainId,
    destinationAddress: row.destinationAddress,
    amountUsdc: microToUsdc(row.amountMicroUnits),
    onchainTxHash: row.onchainTxHash || undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }));
}

export async function markWithdrawalSent(input: { id: string; operatorId: string; onchainTxHash: string }) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(input.onchainTxHash)) throw new Error("invalid_tx_hash");
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: string;
      user_id: string;
      chain_id: number;
      destination_address: string;
      amount_micro_units: string;
      status: string;
    }>(
      `
        SELECT id, user_id, chain_id, destination_address, amount_micro_units::text, status
        FROM withdrawal_requests
        WHERE id = $1
        FOR UPDATE
      `,
      [input.id]
    );
    const request = result.rows[0];
    if (!request) throw new Error("withdrawal_not_found");
    if (request.status !== "requested") throw new Error("withdrawal_not_pending");
    const normalizedTxHash = input.onchainTxHash.toLowerCase();

    const reusedTx = await client.query<{ id: string }>(
      `
        SELECT id
        FROM withdrawal_requests
        WHERE chain_id = $1
          AND onchain_tx_hash = $2
          AND id <> $3
        LIMIT 1
        FOR UPDATE
      `,
      [request.chain_id, normalizedTxHash, input.id]
    );
    if (reusedTx.rows[0]) throw new Error("withdrawal_tx_hash_conflict");

    const transactionId = randomUUID();
    const pendingAccountId = await ensureLedgerAccount(client, null, "pending_usdc_withdrawals", "USDC");
    const externalAccountId = await ensureLedgerAccount(client, null, "external_usdc_withdrawals", "USDC");
    const amountMicroUnits = BigInt(request.amount_micro_units);
    const treasury = await activeTreasuryForWithdrawal(client, request.chain_id);
    await verifyWithdrawalTransfer({
      chainId: request.chain_id,
      txHash: normalizedTxHash,
      destinationAddress: request.destination_address,
      amountMicroUnits,
      treasuryAddress: treasury.treasuryAddress,
      usdcContractAddress: treasury.usdcContractAddress
    });
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, 'USDC', 'withdrawal sent'),
          ($1, $4, $5, 'USDC', 'withdrawal sent')
      `,
      [transactionId, pendingAccountId, (-amountMicroUnits).toString(), externalAccountId, amountMicroUnits.toString()]
    );
    await client.query(
      `
        UPDATE withdrawal_requests
        SET
          status = 'sent',
          completion_transaction_id = $2,
          onchain_tx_hash = $3,
          operator_id = $4,
          sent_at = now(),
          updated_at = now()
        WHERE id = $1
      `,
      [input.id, transactionId, normalizedTxHash, input.operatorId]
    );
    await client.query(
      `
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'withdrawal.sent', 'withdrawal_request', $2, $3)
      `,
      [
        request.user_id,
        input.id,
        {
          operatorId: input.operatorId,
          onchainTxHash: normalizedTxHash,
          ledgerTransactionId: transactionId
        }
      ]
    );
    await client.query("COMMIT");
    return {
      id: input.id,
      status: "sent" as const,
      completionTransactionId: transactionId
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
