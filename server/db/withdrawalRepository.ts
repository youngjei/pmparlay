import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { getAddress, isAddress, zeroAddress } from "viem";
import { config } from "../config";
import { parseUsdcMicroUnitsExact } from "../financialAmounts";
import { assertFinancialGateOpenInTransaction, lockFinancialControlGateForMoney } from "../financialGate";
import { staticStagingTreasuryConfig, usesStaticStagingTreasury } from "../stagingTreasury";
import { getPool } from "./client";

export { parseUsdcMicroUnitsExact } from "../financialAmounts";

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const withdrawalRequestHashVersion = "canonical-json-v1" as const;
const withdrawalRpcTimeoutMs = Math.min(config.MARKET_FETCH_TIMEOUT_MS, 10_000);

function normalizeAddress(value: string) {
  if (!isAddress(value)) throw new Error("invalid_evm_address");
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error("invalid_evm_address");
  return address.toLowerCase();
}

function normalizeIdempotencyKey(value?: string) {
  if (value === undefined) return undefined;
  const key = value.trim();
  if (!/^[A-Za-z0-9._~-]{8,200}$/.test(key)) throw new Error("invalid_idempotency_key");
  return key;
}

function normalizeTxHash(value: string) {
  const txHash = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(txHash)) throw new Error("invalid_tx_hash");
  return txHash;
}

function normalizeBlockHash(value: string) {
  const blockHash = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(blockHash)) throw new Error("invalid_block_hash");
  return blockHash;
}

function sha256Json(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function withdrawalRequestHash(input: {
  userId: string;
  chainId: number;
  destinationAddress: string;
  amountMicroUnits: bigint | string;
}) {
  return sha256Json({
    amountMicroUnits: BigInt(input.amountMicroUnits).toString(),
    chainId: input.chainId,
    currency: "USDC",
    destinationAddress: normalizeAddress(input.destinationAddress),
    userId: input.userId
  });
}

function topicAddress(address: string) {
  return `0x${getAddress(address).slice(2).toLowerCase().padStart(64, "0")}`;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!config.ETHEREUM_RPC_URL) {
    throw new Error("withdrawal_receipt_verification_unavailable");
  }

  let response: Response;
  try {
    response = await fetch(config.ETHEREUM_RPC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      }),
      signal: AbortSignal.timeout(withdrawalRpcTimeoutMs)
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("ethereum_rpc_timeout");
    }
    throw error;
  }

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

async function activeTreasuryConfigForWithdrawal(client: pg.PoolClient, chainId: number) {
  if (usesStaticStagingTreasury()) {
    const treasury = staticStagingTreasuryConfig();
    if (chainId !== treasury.chainId) throw new Error("withdrawal_chain_mismatch");
    return treasury;
  }

  const result = await client.query<{
    treasuryAddress: string;
    usdcContractAddress: string;
    requiredConfirmations: number;
  }>(
    `
      SELECT
        treasury_address AS "treasuryAddress",
        usdc_contract_address AS "usdcContractAddress",
        required_confirmations AS "requiredConfirmations"
      FROM treasury_config
      WHERE chain_id = $1
        AND currency = 'USDC'
        AND active = true
      LIMIT 2
      FOR SHARE
    `,
    [chainId]
  );
  const row = result.rows[0];
  if (result.rows.length === 1 && row) {
    return {
      chainId,
      treasuryAddress: normalizeAddress(row.treasuryAddress),
      usdcContractAddress: normalizeAddress(row.usdcContractAddress),
      requiredConfirmations: row.requiredConfirmations
    };
  }

  throw new Error("active_treasury_config_missing");
}

async function verifyWithdrawalTransfer(input: {
  chainId: number;
  txHash: string;
  destinationAddress: string;
  amountMicroUnits: bigint;
  treasuryAddress: string;
  usdcContractAddress: string;
  requiredConfirmations: number;
}) {
  const chainId = await rpc<string>("eth_chainId", []);
  if (BigInt(chainId) !== BigInt(input.chainId)) throw new Error("withdrawal_chain_mismatch");

  const receipt = await rpc<{
    status?: string;
    transactionHash?: string;
    blockNumber?: string;
    blockHash?: string;
    logs?: Array<{
      address?: string;
      topics?: string[];
      data?: string;
      blockNumber?: string;
      blockHash?: string;
    }>;
  }>("eth_getTransactionReceipt", [input.txHash]);

  if (receipt.status !== "0x1") {
    throw new Error("withdrawal_tx_failed");
  }
  if (receipt.transactionHash && normalizeTxHash(receipt.transactionHash) !== input.txHash) {
    throw new Error("withdrawal_tx_hash_mismatch");
  }
  if (!receipt.blockNumber || !receipt.blockHash) {
    throw new Error("withdrawal_tx_uncanonical");
  }

  const receiptBlockNumber = BigInt(receipt.blockNumber);
  const receiptBlockHash = normalizeBlockHash(receipt.blockHash);
  const canonicalBlock = await rpc<{ hash?: string } | null>("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!canonicalBlock?.hash || normalizeBlockHash(canonicalBlock.hash) !== receiptBlockHash) {
    throw new Error("withdrawal_tx_not_canonical");
  }

  const currentBlock = BigInt(await rpc<string>("eth_blockNumber", []));
  const confirmations = currentBlock >= receiptBlockNumber ? currentBlock - receiptBlockNumber + 1n : 0n;
  if (confirmations < BigInt(input.requiredConfirmations)) {
    throw new Error("withdrawal_tx_unfinalized");
  }

  const treasuryTopic = topicAddress(input.treasuryAddress);
  const destinationTopic = topicAddress(input.destinationAddress);
  const usdcAddress = normalizeAddress(input.usdcContractAddress);
  const matchingLog = (receipt.logs || []).find((log) => {
    if (!log.address || normalizeAddress(log.address) !== usdcAddress) return false;
    if (log.blockNumber && BigInt(log.blockNumber) !== receiptBlockNumber) return false;
    if (log.blockHash && normalizeBlockHash(log.blockHash) !== receiptBlockHash) return false;
    if (log.topics?.[0]?.toLowerCase() !== transferTopic) return false;
    if (log.topics?.[1]?.toLowerCase() !== treasuryTopic) return false;
    if (log.topics?.[2]?.toLowerCase() !== destinationTopic) return false;
    if (!log.data) return false;
    return BigInt(log.data) === input.amountMicroUnits;
  });

  if (!matchingLog) {
    throw new Error("withdrawal_tx_transfer_mismatch");
  }

  return {
    receiptBlockNumber,
    receiptBlockHash,
    confirmations
  };
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

type WithdrawalRequestCreationRow = {
  id: string;
  status: string;
  chain_id: number;
  destination_address: string;
  amount_micro_units: string;
  request_transaction_id: string;
  idempotency_key: string | null;
  request_hash: string | null;
  request_hash_version: string | null;
};

export type WithdrawalRequestCreationResult = {
  id: string;
  status: string;
  requestTransactionId: string;
  idempotencyKey?: string;
  requestHash?: string;
  idempotentReplay?: boolean;
};

function microToUsdc(value: string | bigint) {
  return Number(value) / 1_000_000;
}

function withdrawalRequestResult(row: WithdrawalRequestCreationRow, idempotentReplay = false): WithdrawalRequestCreationResult {
  return {
    id: row.id,
    status: row.status,
    requestTransactionId: row.request_transaction_id,
    idempotencyKey: row.idempotency_key || undefined,
    requestHash: row.request_hash || undefined,
    idempotentReplay
  };
}

async function reusableWithdrawalRequest(
  client: pg.PoolClient,
  input: {
    userId: string;
    destinationAddress: string;
    amountMicroUnits: bigint;
    chainId: number;
    idempotencyKey?: string;
  }
) {
  const result = await client.query<WithdrawalRequestCreationRow>(
    `
      SELECT
        id,
        status,
        chain_id,
        destination_address,
        amount_micro_units::text,
        request_transaction_id::text,
        idempotency_key,
        request_hash,
        request_hash_version
      FROM withdrawal_requests
      WHERE user_id = $1
        AND (
          ($2::text IS NOT NULL AND idempotency_key = $2)
          OR (
            status IN ('requested', 'proposed')
            AND chain_id = $3
            AND destination_address = $4
            AND amount_micro_units = $5
          )
        )
      ORDER BY
        CASE WHEN $2::text IS NOT NULL AND idempotency_key = $2 THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [input.userId, input.idempotencyKey || null, input.chainId, input.destinationAddress, input.amountMicroUnits.toString()]
  );
  return result.rows[0];
}

export async function createWithdrawalRequest(input: {
  userId: string;
  destinationAddress: string;
  amountMicroUnits: bigint;
  chainId: number;
  idempotencyKey?: string;
}): Promise<WithdrawalRequestCreationResult> {
  if (input.amountMicroUnits <= 0n) throw new Error("invalid_withdrawal_amount");
  const destinationAddress = normalizeAddress(input.destinationAddress);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const requestHash = withdrawalRequestHash({
    userId: input.userId,
    destinationAddress,
    amountMicroUnits: input.amountMicroUnits,
    chainId: input.chainId
  });
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await assertFinancialGateOpenInTransaction(client, { operation: "withdrawal.request" });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `withdrawal:${input.userId}:${input.chainId}:${destinationAddress}:${input.amountMicroUnits.toString()}:${idempotencyKey || ""}`
    ]);

    const reusable = await reusableWithdrawalRequest(client, {
      userId: input.userId,
      destinationAddress,
      amountMicroUnits: input.amountMicroUnits,
      chainId: input.chainId,
      idempotencyKey
    });
    if (reusable) {
      if (
        idempotencyKey &&
        reusable.idempotency_key === idempotencyKey &&
        (reusable.request_hash && reusable.request_hash_version === withdrawalRequestHashVersion
          ? reusable.request_hash !== requestHash
          : reusable.chain_id !== input.chainId ||
            reusable.destination_address !== destinationAddress ||
            BigInt(reusable.amount_micro_units) !== input.amountMicroUnits)
      ) {
        throw new Error("idempotency_key_conflict");
      }
      await client.query("COMMIT");
      return withdrawalRequestResult(reusable, true);
    }

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
    await client.query("SELECT id FROM ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
      [pendingAccountId, userAccountId].sort()
    ]);
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
          request_transaction_id,
          idempotency_key,
          request_hash,
          request_hash_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9, $10)
      `,
      [
        requestId,
        input.userId,
        wallet.id,
        input.chainId,
        destinationAddress,
        input.amountMicroUnits.toString(),
        transactionId,
        idempotencyKey || null,
        requestHash,
        withdrawalRequestHashVersion
      ]
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
          ledgerTransactionId: transactionId,
          idempotencyKey: idempotencyKey || null,
          requestHash,
          requestHashVersion: withdrawalRequestHashVersion
        }
      ]
    );
    await client.query("COMMIT");
    return {
      id: requestId,
      status: "requested" as const,
      requestTransactionId: transactionId,
      idempotencyKey,
      requestHash
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

export type CancelWithdrawalInput = {
  withdrawalRequestId: string;
  actor: "user";
  userId: string;
  reason?: string;
};

export type WithdrawalCancellationResult = {
  id: string;
  status: "canceled";
  completionTransactionId: string;
  result: "canceled" | "already_canceled";
};

function cancellationReason(input: CancelWithdrawalInput) {
  const reason = input.reason?.trim();
  if (reason !== undefined && (reason.length === 0 || reason.length > 500)) {
    throw new Error("invalid_withdrawal_cancellation_reason");
  }
  return reason || "withdrawal_canceled_by_user";
}

export async function cancelWithdrawalRequest(input: CancelWithdrawalInput): Promise<WithdrawalCancellationResult> {
  const reason = cancellationReason(input);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    // A cancellation reverses an existing reservation and must serialize with sent.
    // It remains available when the gate is closed so reserved user funds cannot be stranded.
    await lockFinancialControlGateForMoney(client);
    const requestResult = await client.query<{
      id: string;
      user_id: string;
      amount_micro_units: string;
      status: string;
      completion_transaction_id: string | null;
      onchain_tx_hash: string | null;
      sent_at: Date | null;
    }>(
      `
        SELECT
          id,
          user_id,
          amount_micro_units::text,
          status,
          completion_transaction_id::text,
          onchain_tx_hash,
          sent_at
        FROM withdrawal_requests
        WHERE id = $1
        FOR UPDATE
      `,
      [input.withdrawalRequestId]
    );
    const request = requestResult.rows[0];
    if (!request) throw new Error("withdrawal_not_found");

    if (request.user_id !== input.userId) {
      throw new Error("withdrawal_not_owned");
    }

    if (request.status === "canceled") {
      if (!request.completion_transaction_id) throw new Error("withdrawal_cancellation_incomplete");
      await client.query("COMMIT");
      return {
        id: request.id,
        status: "canceled",
        completionTransactionId: request.completion_transaction_id,
        result: "already_canceled"
      };
    }
    if (request.status === "sent" || request.status === "failed" || request.sent_at) {
      throw new Error("withdrawal_terminal_state");
    }
    if (request.onchain_tx_hash) throw new Error("withdrawal_onchain_execution_exists");

    if (request.status !== "requested") {
      throw new Error("withdrawal_not_cancelable");
    }

    const amountMicroUnits = BigInt(request.amount_micro_units);
    const userAccountId = await ensureLedgerAccount(client, request.user_id, "user_usdc_available", "USDC");
    const pendingAccountId = await ensureLedgerAccount(client, null, "pending_usdc_withdrawals", "USDC");
    await client.query("SELECT id FROM ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
      [pendingAccountId, userAccountId].sort()
    ]);

    const transactionId = randomUUID();
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, 'USDC', 'withdrawal canceled'),
          ($1, $4, $5, 'USDC', 'withdrawal canceled')
      `,
      [transactionId, pendingAccountId, (-amountMicroUnits).toString(), userAccountId, amountMicroUnits.toString()]
    );
    await client.query(
      `
        UPDATE withdrawal_requests
        SET
          status = 'canceled',
          completion_transaction_id = $2,
          canceled_at = now(),
          failure_reason = $3,
          operator_id = $4,
          updated_at = now()
        WHERE id = $1
          AND status IN ('requested', 'proposed')
      `,
      [request.id, transactionId, reason, null]
    );
    await client.query(
      `
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'withdrawal.canceled', 'withdrawal_request', $2, $3)
      `,
      [
        input.userId,
        request.id,
        {
          actor: "user",
          reason,
          ledgerTransactionId: transactionId
        }
      ]
    );
    await client.query("COMMIT");
    return {
      id: request.id,
      status: "canceled",
      completionTransactionId: transactionId,
      result: "canceled"
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const cancelWithdrawal = cancelWithdrawalRequest;

export async function markWithdrawalSent(input: { id: string; operatorId: string; onchainTxHash: string }) {
  const normalizedTxHash = normalizeTxHash(input.onchainTxHash);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    // This transition reconciles a transfer the Safe has already executed, so it must
    // remain possible while the gate is closed without permitting any new movement.
    await lockFinancialControlGateForMoney(client);
    const result = await client.query<{
      id: string;
      user_id: string;
      chain_id: number;
      destination_address: string;
      amount_micro_units: string;
      status: string;
      safe_proposal_payload: SafeWithdrawalProposalHookPayload | null;
      safe_proposal_hash: string | null;
      safe_proposed_at: Date | null;
      safe_proposed_by: string | null;
    }>(
      `
        SELECT
          id,
          user_id,
          chain_id,
          destination_address,
          amount_micro_units::text,
          status,
          safe_proposal_payload,
          safe_proposal_hash,
          safe_proposed_at,
          safe_proposed_by
        FROM withdrawal_requests
        WHERE id = $1
        FOR UPDATE
      `,
      [input.id]
    );
    const request = result.rows[0];
    if (!request) throw new Error("withdrawal_not_found");
    if (request.status !== "proposed") throw new Error("withdrawal_not_proposed");
    if (!request.safe_proposal_payload || !request.safe_proposal_hash || !request.safe_proposed_at || !request.safe_proposed_by) {
      throw new Error("withdrawal_safe_proposal_missing");
    }

    const amountMicroUnits = BigInt(request.amount_micro_units);
    const treasury = await activeTreasuryConfigForWithdrawal(client, request.chain_id);
    const expectedProposal = buildSafeWithdrawalProposalHookPayload({
      withdrawalRequestId: request.id,
      chainId: request.chain_id,
      safeAddress: treasury.treasuryAddress,
      usdcContractAddress: treasury.usdcContractAddress,
      destinationAddress: request.destination_address,
      amountMicroUnits
    });
    const expectedProposalHash = safeWithdrawalProposalHash(expectedProposal);
    const persistedProposalHash = safeWithdrawalProposalHash(request.safe_proposal_payload);
    if (request.safe_proposal_hash !== expectedProposalHash || persistedProposalHash !== expectedProposalHash) {
      throw new Error("withdrawal_safe_proposal_mismatch");
    }
    const initialVerification = await verifyWithdrawalTransfer({
      chainId: expectedProposal.chainId,
      txHash: normalizedTxHash,
      destinationAddress: expectedProposal.destinationAddress,
      amountMicroUnits: BigInt(expectedProposal.amountMicroUnits),
      treasuryAddress: expectedProposal.safeAddress,
      usdcContractAddress: expectedProposal.tokenAddress,
      requiredConfirmations: treasury.requiredConfirmations
    });

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
    const verification = await verifyWithdrawalTransfer({
      chainId: expectedProposal.chainId,
      txHash: normalizedTxHash,
      destinationAddress: expectedProposal.destinationAddress,
      amountMicroUnits: BigInt(expectedProposal.amountMicroUnits),
      treasuryAddress: expectedProposal.safeAddress,
      usdcContractAddress: expectedProposal.tokenAddress,
      requiredConfirmations: treasury.requiredConfirmations
    });
    if (
      verification.receiptBlockNumber !== initialVerification.receiptBlockNumber ||
      verification.receiptBlockHash !== initialVerification.receiptBlockHash
    ) {
      throw new Error("withdrawal_tx_reorged_before_commit");
    }
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
          onchain_block_number = $5,
          onchain_block_hash = $6,
          onchain_confirmations = $7,
          sent_at = now(),
          updated_at = now()
        WHERE id = $1
          AND status = 'proposed'
          AND safe_proposal_hash = $8
      `,
      [
        input.id,
        transactionId,
        normalizedTxHash,
        input.operatorId,
        verification.receiptBlockNumber.toString(),
        verification.receiptBlockHash,
        verification.confirmations.toString(),
        expectedProposalHash
      ]
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
          ledgerTransactionId: transactionId,
          treasuryAddress: treasury.treasuryAddress,
          usdcContractAddress: treasury.usdcContractAddress,
          receiptBlockNumber: verification.receiptBlockNumber.toString(),
          receiptBlockHash: verification.receiptBlockHash,
          confirmations: verification.confirmations.toString(),
          safeProposalHash: expectedProposalHash
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

export type SafeWithdrawalProposalHookInput = {
  withdrawalRequestId: string;
  chainId: number;
  safeAddress: string;
  usdcContractAddress: string;
  destinationAddress: string;
  amountMicroUnits: bigint | string;
};

export type SafeWithdrawalProposalHookPayload = {
  withdrawalRequestId: string;
  chainId: number;
  safeAddress: string;
  tokenAddress: string;
  destinationAddress: string;
  amountMicroUnits: string;
  tokenTransferCall: {
    to: string;
    value: "0";
    data: string;
  };
};

export type SafeWithdrawalProposalResult = SafeWithdrawalProposalHookPayload & {
  status: "proposed";
  requestHash: string;
  safeProposalHash: string;
  safeApiBroadcast: "disabled";
  safeApiBroadcastReason: "safe_signing_architecture_not_configured";
};

function uint256Hex(value: bigint | string) {
  const amount = BigInt(value);
  if (amount <= 0n) throw new Error("invalid_withdrawal_amount");
  return amount.toString(16).padStart(64, "0");
}

export function buildSafeWithdrawalProposalHookPayload(input: SafeWithdrawalProposalHookInput): SafeWithdrawalProposalHookPayload {
  const safeAddress = normalizeAddress(input.safeAddress);
  const tokenAddress = normalizeAddress(input.usdcContractAddress);
  const destinationAddress = normalizeAddress(input.destinationAddress);
  const amountMicroUnits = BigInt(input.amountMicroUnits);
  const transferSelector = "a9059cbb";
  const encodedDestination = destinationAddress.slice(2).padStart(64, "0");
  const encodedAmount = uint256Hex(amountMicroUnits);

  return {
    withdrawalRequestId: input.withdrawalRequestId,
    chainId: input.chainId,
    safeAddress,
    tokenAddress,
    destinationAddress,
    amountMicroUnits: amountMicroUnits.toString(),
    tokenTransferCall: {
      to: tokenAddress,
      value: "0",
      data: `0x${transferSelector}${encodedDestination}${encodedAmount}`
    }
  };
}

export function safeWithdrawalProposalHash(payload: SafeWithdrawalProposalHookPayload) {
  return sha256Json({
    amountMicroUnits: payload.amountMicroUnits,
    chainId: payload.chainId,
    destinationAddress: payload.destinationAddress,
    safeAddress: payload.safeAddress,
    tokenAddress: payload.tokenAddress,
    tokenTransferCall: payload.tokenTransferCall,
    withdrawalRequestId: payload.withdrawalRequestId
  });
}

export async function buildAndPersistSafeWithdrawalProposal(input: {
  withdrawalRequestId: string;
  operatorId: string;
}): Promise<SafeWithdrawalProposalResult> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await assertFinancialGateOpenInTransaction(client, { operation: "withdrawal.safe_propose" });
    const requestResult = await client.query<{
      id: string;
      user_id: string;
      chain_id: number;
      destination_address: string;
      amount_micro_units: string;
      status: string;
      request_hash: string | null;
      request_hash_version: string | null;
    }>(
      `
        SELECT
          id,
          user_id,
          chain_id,
          destination_address,
          amount_micro_units::text,
          status,
          request_hash,
          request_hash_version
        FROM withdrawal_requests
        WHERE id = $1
        FOR UPDATE
      `,
      [input.withdrawalRequestId]
    );
    const request = requestResult.rows[0];
    if (!request) throw new Error("withdrawal_not_found");
    if (request.status !== "requested") throw new Error("withdrawal_not_requested");

    const treasury = await activeTreasuryConfigForWithdrawal(client, request.chain_id);
    const payload = buildSafeWithdrawalProposalHookPayload({
      withdrawalRequestId: request.id,
      chainId: request.chain_id,
      safeAddress: treasury.treasuryAddress,
      usdcContractAddress: treasury.usdcContractAddress,
      destinationAddress: request.destination_address,
      amountMicroUnits: request.amount_micro_units
    });
    const requestHash = withdrawalRequestHash({
      userId: request.user_id,
      chainId: request.chain_id,
      destinationAddress: request.destination_address,
      amountMicroUnits: request.amount_micro_units
    });
    if (
      request.request_hash_version === withdrawalRequestHashVersion &&
      request.request_hash !== requestHash
    ) {
      throw new Error("withdrawal_request_hash_mismatch");
    }
    const safeProposalHash = safeWithdrawalProposalHash(payload);

    await client.query(
      `
        UPDATE withdrawal_requests
        SET
          status = 'proposed',
          safe_proposal_payload = $2,
          safe_proposal_hash = $3,
          safe_proposed_by = $4,
          safe_proposed_at = now(),
          updated_at = now()
        WHERE id = $1
      `,
      [request.id, payload, safeProposalHash, input.operatorId]
    );
    await client.query(
      `
        INSERT INTO audit_log (action, entity_type, entity_id, metadata)
        VALUES ('withdrawal.safe_proposed', 'withdrawal_request', $1, $2)
      `,
      [
        request.id,
        {
          operatorId: input.operatorId,
          requestHash,
          safeProposalHash,
          safeApiBroadcast: "disabled",
          safeApiBroadcastReason: "safe_signing_architecture_not_configured"
        }
      ]
    );
    await client.query("COMMIT");
    return {
      ...payload,
      status: "proposed",
      requestHash,
      safeProposalHash,
      safeApiBroadcast: "disabled",
      safeApiBroadcastReason: "safe_signing_architecture_not_configured"
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function proposeWithdrawalWithSafeApiHook(input: {
  withdrawalRequestId: string;
  operatorId: string;
}): Promise<SafeWithdrawalProposalResult> {
  return buildAndPersistSafeWithdrawalProposal(input);
}
