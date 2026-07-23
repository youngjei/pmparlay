import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getAddress, isAddress, zeroAddress } from "viem";
import { lockFinancialControlGateForMoney } from "../financialGate";
import type { VerifiedHouseFundingTransfer } from "../houseFundingVerification";
import { getPool } from "./client";

export type RecordHouseFundingInput = VerifiedHouseFundingTransfer & {
  operatorId: string;
  approverId: string;
  reason: string;
};

export type HouseFundingResult = {
  evidenceId: string;
  ledgerTransactionId: string;
  amountMicroUnits: string;
  houseOperatingBalanceMicroUnits?: string;
  idempotentReplay: boolean;
};

function normalizeAddress(value: string) {
  if (!isAddress(value)) throw new Error("invalid_evm_address");
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error("invalid_evm_address");
  return address.toLowerCase();
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

function normalizeHumanId(value: string, error: string) {
  const id = value.trim();
  if (!/^[A-Za-z0-9._:@-]{3,200}$/.test(id)) throw new Error(error);
  return id;
}

function normalizeReason(value: string) {
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 1_000) throw new Error("invalid_house_funding_reason");
  return reason;
}

async function ensureLedgerAccount(client: pg.PoolClient, accountType: string) {
  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO ledger_accounts (user_id, account_type, currency)
      VALUES (NULL, $1, 'USDC')
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [accountType]
  );
  if (inserted.rows[0]) return inserted.rows[0].id;

  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM ledger_accounts
      WHERE user_id IS NULL AND account_type = $1 AND currency = 'USDC'
      LIMIT 1
    `,
    [accountType]
  );
  if (!existing.rows[0]) throw new Error(`house_funding_ledger_account_missing:${accountType}`);
  return existing.rows[0].id;
}

async function houseOperatingBalance(client: pg.PoolClient, accountId: string) {
  const result = await client.query<{ balance: string }>(
    `SELECT COALESCE(sum(amount_micro_units), 0)::text AS balance FROM ledger_entries WHERE account_id = $1`,
    [accountId]
  );
  return result.rows[0]?.balance || "0";
}

export async function recordVerifiedHouseFunding(input: RecordHouseFundingInput): Promise<HouseFundingResult> {
  const txHash = normalizeTxHash(input.txHash);
  const blockHash = normalizeBlockHash(input.blockHash);
  const fromAddress = normalizeAddress(input.fromAddress);
  const toAddress = normalizeAddress(input.toAddress);
  const tokenAddress = normalizeAddress(input.tokenAddress);
  const operatorId = normalizeHumanId(input.operatorId, "invalid_house_funding_operator_id");
  const approverId = normalizeHumanId(input.approverId, "invalid_house_funding_approver_id");
  const reason = normalizeReason(input.reason);
  if (operatorId.toLowerCase() === approverId.toLowerCase()) throw new Error("house_funding_distinct_approver_required");
  if (fromAddress === toAddress) throw new Error("house_funding_self_transfer");
  if (!Number.isSafeInteger(input.logIndex) || input.logIndex < 0) throw new Error("invalid_log_index");
  if (input.blockNumber < 0n || input.amountMicroUnits <= 0n || !Number.isInteger(input.confirmations) || input.confirmations <= 0) {
    throw new Error("invalid_house_funding_evidence");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // A confirmed external transfer repairs custody accounting, so it remains allowed while the gate is closed.
    await lockFinancialControlGateForMoney(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `onchain-transfer:${input.chainId}:${txHash}:${input.logIndex}`
    ]);

    const existing = await client.query<{
      id: string;
      ledger_transaction_id: string;
      amount_micro_units: string;
      block_number: string;
      block_hash: string;
      from_address: string;
      to_address: string;
      token_address: string;
    }>(
      `
        SELECT
          id,
          ledger_transaction_id,
          amount_micro_units::text,
          block_number::text,
          block_hash,
          from_address,
          to_address,
          token_address
        FROM house_funding_evidence
        WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3
        FOR UPDATE
      `,
      [input.chainId, txHash, input.logIndex]
    );
    if (existing.rows[0]) {
      const evidence = existing.rows[0];
      if (
        evidence.amount_micro_units !== input.amountMicroUnits.toString() ||
        evidence.block_number !== input.blockNumber.toString() ||
        evidence.block_hash !== blockHash ||
        evidence.from_address !== fromAddress ||
        evidence.to_address !== toAddress ||
        evidence.token_address !== tokenAddress
      ) {
        throw new Error("house_funding_evidence_conflict");
      }
      await client.query("COMMIT");
      return {
        evidenceId: evidence.id,
        ledgerTransactionId: evidence.ledger_transaction_id,
        amountMicroUnits: evidence.amount_micro_units,
        idempotentReplay: true
      };
    }

    const existingClaim = await client.query<{ claim_type: string }>(
      `
        SELECT claim_type
        FROM onchain_transfer_claims
        WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3
        FOR UPDATE
      `,
      [input.chainId, txHash, input.logIndex]
    );
    if (existingClaim.rows[0]) throw new Error(`onchain_transfer_already_claimed:${existingClaim.rows[0].claim_type}`);

    const representedDeposit = await client.query<{ id: string; status: string; credited_transaction_id: string | null }>(
      `
        SELECT id, status, credited_transaction_id
        FROM onchain_deposits
        WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3
        LIMIT 1
        FOR UPDATE
      `,
      [input.chainId, txHash, input.logIndex]
    );
    if (representedDeposit.rows[0]?.credited_transaction_id || representedDeposit.rows[0]?.status === "credited") {
      throw new Error("house_funding_onchain_deposit_conflict");
    }

    const linkedWallet = await client.query<{ id: string }>(
      `
        SELECT id
        FROM user_wallets
        WHERE chain_id = $1 AND lower(address) = $2 AND active = true
        LIMIT 1
        FOR SHARE
      `,
      [input.chainId, fromAddress]
    );
    if (linkedWallet.rows[0]) throw new Error("house_funding_source_linked_to_user_wallet");

    const houseOperatingAccountId = await ensureLedgerAccount(client, "house_usdc_operating");
    const externalFundingAccountId = await ensureLedgerAccount(client, "external_house_funding");
    await client.query("SELECT id FROM ledger_accounts WHERE id = ANY($1::uuid[]) FOR UPDATE", [
      [houseOperatingAccountId, externalFundingAccountId].sort()
    ]);

    const evidenceId = randomUUID();
    const ledgerTransactionId = randomUUID();
    await client.query(
      `
        INSERT INTO house_funding_evidence (
          id, chain_id, tx_hash, log_index, block_number, block_hash, from_address, to_address, token_address,
          amount_micro_units, confirmations, ledger_transaction_id, operator_id, approver_id, reason, receipt
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `,
      [
        evidenceId,
        input.chainId,
        txHash,
        input.logIndex,
        input.blockNumber.toString(),
        blockHash,
        fromAddress,
        toAddress,
        tokenAddress,
        input.amountMicroUnits.toString(),
        input.confirmations,
        ledgerTransactionId,
        operatorId,
        approverId,
        reason,
        input.receipt
      ]
    );
    await client.query(
      `
        INSERT INTO onchain_transfer_claims (
          chain_id, tx_hash, log_index, claim_type, house_funding_evidence_id
        )
        VALUES ($1, $2, $3, 'house_funding', $4)
      `,
      [input.chainId, txHash, input.logIndex, evidenceId]
    );
    await client.query(
      `
        INSERT INTO ledger_entries (transaction_id, account_id, amount_micro_units, currency, memo)
        VALUES
          ($1, $2, $3, 'USDC', 'verified external house funding'),
          ($1, $4, $5, 'USDC', 'verified external house funding')
      `,
      [
        ledgerTransactionId,
        externalFundingAccountId,
        (-input.amountMicroUnits).toString(),
        houseOperatingAccountId,
        input.amountMicroUnits.toString()
      ]
    );
    await client.query(
      `
        INSERT INTO audit_log (action, entity_type, entity_id, metadata)
        VALUES ('house_funding.recorded', 'house_funding_evidence', $1, $2)
      `,
      [
        evidenceId,
        {
          operatorId,
          approverId,
          reason,
          chainId: input.chainId,
          txHash,
          logIndex: input.logIndex,
          blockHash,
          fromAddress,
          toAddress,
          tokenAddress,
          amountMicroUnits: input.amountMicroUnits.toString(),
          confirmations: input.confirmations,
          ledgerTransactionId
        }
      ]
    );
    const balance = await houseOperatingBalance(client, houseOperatingAccountId);
    await client.query("COMMIT");
    return {
      evidenceId,
      ledgerTransactionId,
      amountMicroUnits: input.amountMicroUnits.toString(),
      houseOperatingBalanceMicroUnits: balance,
      idempotentReplay: false
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
