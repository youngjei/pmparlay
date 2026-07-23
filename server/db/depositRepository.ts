import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getAddress, isAddress, zeroAddress } from "viem";
import {
  lockFinancialControlGateForMoney,
  lockFinancialControlGateForMutation,
  setFinancialControlGate
} from "../financialGate";
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

export type DepositCreditResult =
  | {
      id: string;
      status: "duplicate";
      ledgerTransactionId?: string;
      reorgRestored?: boolean;
    }
  | {
      id: string;
      status: "ignored";
    }
  | {
      id: string;
      status: "credited";
      userId: string;
      walletId: string;
      ledgerTransactionId: string;
    }
  | {
      id: string;
      status: "payment_confirmed";
      userId: string;
      walletId: string;
      quoteId: string;
      paymentIntentId: string;
      ledgerTransactionId: string;
    };

export type ScanCursor = {
  lastScannedBlock: bigint;
  lastScannedBlockHash?: string;
};

export type ScanBlockObservation = {
  blockNumber: bigint;
  blockHash: string;
};

export type DepositTreasuryScanConfig = {
  id?: string;
  chainId: number;
  currency: "USDC";
  treasuryAddress: string;
  usdcContractAddress: string;
  requiredConfirmations: number;
  active: boolean;
  updatedAt?: string;
};

export type CanonicalDepositFact = {
  txHash: string;
  logIndex: number;
  blockHash?: string | null;
};

function normalizeTxHash(value: string) {
  const txHash = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(txHash)) throw new Error("invalid_tx_hash");
  return txHash;
}

function normalizeBlockHash(value?: string | null) {
  if (!value) return undefined;
  const blockHash = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(blockHash)) throw new Error("invalid_block_hash");
  return blockHash;
}

function canonicalDepositFactKey(fact: CanonicalDepositFact) {
  return `${normalizeTxHash(fact.txHash)}:${fact.logIndex}:${normalizeBlockHash(fact.blockHash) || ""}`;
}

export async function creditConfirmedDeposit(input: ConfirmedDepositInput): Promise<DepositCreditResult> {
  const txHash = normalizeTxHash(input.txHash);
  const fromAddress = normalizeAddress(input.fromAddress);
  const toAddress = normalizeAddress(input.toAddress);
  const tokenAddress = normalizeAddress(input.tokenAddress);
  const blockHash = normalizeBlockHash(input.blockHash);
  if (input.amountMicroUnits <= 0n) throw new Error("invalid_deposit_amount");

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await lockFinancialControlGateForMoney(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `onchain-transfer:${input.chainId}:${txHash}:${input.logIndex}`
    ]);
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
        txHash,
        input.logIndex,
        input.blockNumber.toString(),
        blockHash || null,
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
      status: "observed" | "credited" | "ignored" | "reorged";
      credited_transaction_id: string | null;
      block_number: string;
      block_hash: string | null;
      from_address: string;
      to_address: string;
      token_address: string;
      amount_micro_units: string;
    }>(
      `
        SELECT
          id,
          status,
          credited_transaction_id,
          block_number::text,
          block_hash,
          from_address,
          to_address,
          token_address,
          amount_micro_units::text
        FROM onchain_deposits
        WHERE chain_id = $1
          AND tx_hash = $2
          AND log_index = $3
        FOR UPDATE
      `,
      [input.chainId, txHash, input.logIndex]
    );
    const deposit = depositResult.rows[0];
    if (!deposit) throw new Error("deposit_record_missing");

    const sameFact =
      deposit.from_address === fromAddress &&
      deposit.to_address === toAddress &&
      deposit.token_address === tokenAddress &&
      BigInt(deposit.amount_micro_units) === input.amountMicroUnits;
    if (!sameFact) throw new Error("deposit_fact_conflict");

    const sameCanonicalBlock =
      BigInt(deposit.block_number) === input.blockNumber && (deposit.block_hash || undefined) === (blockHash || undefined);

    if (deposit.status === "credited" || (deposit.status === "reorged" && deposit.credited_transaction_id)) {
      if (deposit.status === "reorged" && deposit.credited_transaction_id) {
        await client.query(
          `
            UPDATE onchain_deposits
            SET confirmations = GREATEST(confirmations, $2), updated_at = now()
            WHERE id = $1
          `,
          [deposit.id, input.confirmations]
        );
        await client.query("COMMIT");
        return {
          id: deposit.id,
          status: "duplicate" as const,
          ledgerTransactionId: deposit.credited_transaction_id,
          reorgRestored: false
        };
      }
      if (!sameCanonicalBlock) {
        await client.query(
          `
            UPDATE onchain_deposits
            SET
              status = 'credited',
              block_number = $2,
              block_hash = $3,
              confirmations = $4,
              raw = $5,
              reorged_at = NULL,
              reorg_reason = NULL,
              updated_at = now()
            WHERE id = $1
          `,
          [deposit.id, input.blockNumber.toString(), blockHash || null, input.confirmations, input.raw]
        );
      } else {
        await client.query(
          `
            UPDATE onchain_deposits
            SET confirmations = GREATEST(confirmations, $2), updated_at = now()
            WHERE id = $1
          `,
          [deposit.id, input.confirmations]
        );
      }
      await client.query("COMMIT");
      return {
        id: deposit.id,
        status: "duplicate" as const,
        ledgerTransactionId: deposit.credited_transaction_id || undefined,
        reorgRestored: deposit.status === "reorged" || undefined
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
          SET
            status = 'ignored',
            block_number = $2,
            block_hash = $3,
            confirmations = $4,
            raw = $5,
            reorged_at = NULL,
            reorg_reason = NULL,
            updated_at = now()
          WHERE id = $1
        `,
        [deposit.id, input.blockNumber.toString(), blockHash || null, input.confirmations, input.raw]
      );
      await client.query("COMMIT");
      return {
        id: deposit.id,
        status: "ignored" as const
      };
    }

    await client.query(
      `
        INSERT INTO onchain_transfer_claims (
          chain_id, tx_hash, log_index, claim_type, onchain_deposit_id
        )
        VALUES ($1, $2, $3, 'user_deposit', $4)
        ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
      `,
      [input.chainId, txHash, input.logIndex, deposit.id]
    );
    const transferClaim = await client.query<{ claim_type: string; onchain_deposit_id: string | null }>(
      `
        SELECT claim_type, onchain_deposit_id
        FROM onchain_transfer_claims
        WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3
        FOR UPDATE
      `,
      [input.chainId, txHash, input.logIndex]
    );
    const claim = transferClaim.rows[0];
    if (!claim || claim.claim_type !== "user_deposit" || claim.onchain_deposit_id !== deposit.id) {
      await client.query(
        `
          UPDATE onchain_deposits
          SET status = 'ignored', updated_at = now()
          WHERE id = $1 AND credited_transaction_id IS NULL
        `,
        [deposit.id]
      );
      await client.query("COMMIT");
      return { id: deposit.id, status: "ignored" as const };
    }

    const quotePayment = await claimConfirmedQuotePaymentDeposit(client, {
      chainId: input.chainId,
      txHash,
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
            block_number = $4,
            block_hash = $5,
            confirmations = $6,
            credited_transaction_id = $7,
            payment_intent_id = $8,
            raw = $9,
            reorged_at = NULL,
            reorg_reason = NULL,
            updated_at = now()
          WHERE id = $1
        `,
        [
          deposit.id,
          wallet.user_id,
          wallet.id,
          input.blockNumber.toString(),
          blockHash || null,
          input.confirmations,
          quotePayment.ledgerTransactionId,
          quotePayment.paymentIntentId,
          input.raw
        ]
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
          block_number = $4,
          block_hash = $5,
          confirmations = $6,
          credited_transaction_id = $7,
          raw = $8,
          reorged_at = NULL,
          reorg_reason = NULL,
          updated_at = now()
        WHERE id = $1
      `,
      [deposit.id, wallet.user_id, wallet.id, input.blockNumber.toString(), blockHash || null, input.confirmations, transactionId, input.raw]
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
          txHash,
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
  const result = await getPool().query<{ lastScannedBlock: string; lastScannedBlockHash: string | null }>(
    `
      SELECT
        last_scanned_block::text AS "lastScannedBlock",
        last_scanned_block_hash AS "lastScannedBlockHash"
      FROM onchain_scan_cursors
      WHERE chain_id = $1
        AND cursor_name = $2
      LIMIT 1
    `,
    [chainId, cursorName]
  );
  const row = result.rows[0];
  return row
    ? {
        lastScannedBlock: BigInt(row.lastScannedBlock),
        lastScannedBlockHash: row.lastScannedBlockHash || undefined
      }
    : undefined;
}

export async function saveScanCursor(
  chainId: number,
  cursorName: string,
  lastScannedBlock: bigint,
  lastScannedBlockHash?: string,
  blockObservations: ScanBlockObservation[] = []
) {
  const blockHash = normalizeBlockHash(lastScannedBlockHash) || null;
  const observations = new Map<string, string>();
  for (const observation of blockObservations) {
    if (observation.blockNumber < 0n || observation.blockNumber > lastScannedBlock) {
      throw new Error("invalid_scan_block_observation");
    }
    observations.set(observation.blockNumber.toString(), normalizeBlockHash(observation.blockHash)!);
  }
  if (blockHash) observations.set(lastScannedBlock.toString(), blockHash);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`scan-cursor:${chainId}:${cursorName}`]);
    const result = await client.query(
      `
        INSERT INTO onchain_scan_cursors (chain_id, cursor_name, last_scanned_block, last_scanned_block_hash)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (chain_id, cursor_name)
        DO UPDATE SET
          last_scanned_block = EXCLUDED.last_scanned_block,
          last_scanned_block_hash = EXCLUDED.last_scanned_block_hash,
          updated_at = now()
        WHERE onchain_scan_cursors.last_scanned_block <= EXCLUDED.last_scanned_block
      `,
      [chainId, cursorName, lastScannedBlock.toString(), blockHash]
    );
    if (result.rowCount !== 1) throw new Error("scan_cursor_regression");
    if (observations.size > 0) {
      await client.query(
        `
          INSERT INTO onchain_scan_block_observations (
            chain_id,
            cursor_name,
            block_number,
            block_hash
          )
          SELECT $1, $2, observed.block_number, observed.block_hash
          FROM unnest($3::bigint[], $4::text[]) AS observed(block_number, block_hash)
          ON CONFLICT (chain_id, cursor_name, block_number)
          DO UPDATE SET
            block_hash = EXCLUDED.block_hash,
            observed_at = now()
        `,
        [chainId, cursorName, [...observations.keys()], [...observations.values()]]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listScanBlockObservations(input: {
  chainId: number;
  cursorName: string;
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<ScanBlockObservation[]> {
  const result = await getPool().query<{ blockNumber: string; blockHash: string }>(
    `
      SELECT
        block_number::text AS "blockNumber",
        block_hash AS "blockHash"
      FROM onchain_scan_block_observations
      WHERE chain_id = $1
        AND cursor_name = $2
        AND block_number BETWEEN $3 AND $4
      ORDER BY block_number DESC
    `,
    [input.chainId, input.cursorName, input.fromBlock.toString(), input.toBlock.toString()]
  );
  return result.rows.map((row) => ({
    blockNumber: BigInt(row.blockNumber),
    blockHash: normalizeBlockHash(row.blockHash)!
  }));
}

export async function blockDepositScannerForMissingAncestor(input: {
  chainId: number;
  cursorName: string;
  previousCursorBlock: bigint;
  lookbackFromBlock: bigint;
  mismatchedBlocks: bigint[];
}) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await lockFinancialControlGateForMutation(client);
    const identity = {
      chainId: input.chainId,
      cursorName: input.cursorName,
      previousCursorBlock: input.previousCursorBlock.toString()
    };
    const existing = await client.query<{ id: string }>(
      `
        SELECT id
        FROM financial_incidents
        WHERE kind = 'deposit_scanner_common_ancestor_missing'
          AND status = 'open'
          AND metadata @> $1::jsonb
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [identity]
    );
    const incidentId = existing.rows[0]?.id || randomUUID();
    if (!existing.rows[0]) {
      await client.query(
        `
          INSERT INTO financial_incidents (
            id,
            severity,
            status,
            kind,
            entity_type,
            reason,
            metadata
          )
          VALUES ($1, 'critical', 'open', 'deposit_scanner_common_ancestor_missing', 'onchain_deposit_scanner', $2, $3)
        `,
        [
          incidentId,
          "No canonical common ancestor was found inside the configured deposit overlap window.",
          {
            ...identity,
            lookbackFromBlock: input.lookbackFromBlock.toString(),
            mismatchedBlocks: input.mismatchedBlocks.map((block) => block.toString()),
            requiresOperatorRemediation: true
          }
        ]
      );
      await client.query(
        `
          INSERT INTO audit_log (action, entity_type, entity_id, metadata)
          VALUES ('deposit_scanner.integrity_blocked', 'financial_incident', $1, $2)
        `,
        [incidentId, { ...identity, requiresOperatorRemediation: true }]
      );
    }
    await setFinancialControlGate(client, {
      operationGate: "blocked",
      reason: "deposit_scanner_common_ancestor_missing",
      incidentId,
      metadata: {
        ...identity,
        lookbackFromBlock: input.lookbackFromBlock.toString(),
        mismatchedBlocks: input.mismatchedBlocks.map((block) => block.toString()),
        requiresOperatorRemediation: true
      }
    });
    await client.query("COMMIT");
    return { incidentId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listDepositTreasuryScanConfigs(chainId: number, currency: "USDC"): Promise<DepositTreasuryScanConfig[]> {
  const result = await getPool().query<{
    id: string;
    chainId: number;
    currency: "USDC";
    treasuryAddress: string;
    usdcContractAddress: string;
    requiredConfirmations: number;
    active: boolean;
    updatedAt: Date;
  }>(
    `
      SELECT
        id,
        chain_id AS "chainId",
        currency,
        treasury_address AS "treasuryAddress",
        usdc_contract_address AS "usdcContractAddress",
        required_confirmations AS "requiredConfirmations",
        active,
        updated_at AS "updatedAt"
      FROM treasury_config
      WHERE chain_id = $1
        AND currency = $2
      ORDER BY active DESC, updated_at DESC
    `,
    [chainId, currency]
  );

  return result.rows.map((row) => ({
    id: row.id,
    chainId: row.chainId,
    currency: row.currency,
    treasuryAddress: normalizeAddress(row.treasuryAddress),
    usdcContractAddress: normalizeAddress(row.usdcContractAddress),
    requiredConfirmations: row.requiredConfirmations,
    active: row.active,
    updatedAt: row.updatedAt.toISOString()
  }));
}

export async function markReorgedDeposits(input: {
  chainId: number;
  fromBlock: bigint;
  toBlock: bigint;
  toAddresses: string[];
  tokenAddresses: string[];
  canonicalFacts: CanonicalDepositFact[];
  reason: string;
}) {
  if (input.toBlock < input.fromBlock) {
    return {
      reorged: 0,
      creditedReorged: 0,
      houseFundingReorged: 0
    };
  }

  const toAddresses = [...new Set(input.toAddresses.map(normalizeAddress))];
  const tokenAddresses = [...new Set(input.tokenAddresses.map(normalizeAddress))];
  if (toAddresses.length === 0 || tokenAddresses.length === 0) {
    return {
      reorged: 0,
      creditedReorged: 0,
      houseFundingReorged: 0
    };
  }

  const canonical = new Set(input.canonicalFacts.map(canonicalDepositFactKey));
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await lockFinancialControlGateForMutation(client);
    const candidates = await client.query<{
      id: string;
      tx_hash: string;
      log_index: number;
      block_hash: string | null;
      status: string;
      credited_transaction_id: string | null;
      payment_intent_id: string | null;
      user_id: string | null;
      wallet_id: string | null;
      amount_micro_units: string;
    }>(
      `
        SELECT
          id,
          tx_hash,
          log_index,
          block_hash,
          status,
          credited_transaction_id,
          payment_intent_id,
          user_id,
          wallet_id,
          amount_micro_units::text
        FROM onchain_deposits
        WHERE chain_id = $1
          AND block_number BETWEEN $2 AND $3
          AND to_address = ANY($4::text[])
          AND token_address = ANY($5::text[])
          AND status <> 'reorged'
        FOR UPDATE
      `,
      [input.chainId, input.fromBlock.toString(), input.toBlock.toString(), toAddresses, tokenAddresses]
    );

    let reorged = 0;
    let creditedReorged = 0;
    let houseFundingReorged = 0;
    for (const candidate of candidates.rows) {
      if (
        canonical.has(
          canonicalDepositFactKey({
            txHash: candidate.tx_hash,
            logIndex: candidate.log_index,
            blockHash: candidate.block_hash
          })
        )
      ) {
        continue;
      }
      let compensationTransactionId: string | undefined;
      let incidentId: string | undefined;
      if (candidate.credited_transaction_id) {
        compensationTransactionId = randomUUID();
        const compensationEntries = await client.query<{ id: string }>(
          `
            INSERT INTO ledger_entries (
              transaction_id,
              account_id,
              amount_micro_units,
              currency,
              memo
            )
            SELECT
              $1,
              ledger_entries.account_id,
              -ledger_entries.amount_micro_units,
              ledger_entries.currency,
              'onchain deposit reorg compensation'
            FROM ledger_entries
            WHERE ledger_entries.transaction_id = $2
            RETURNING id
          `,
          [compensationTransactionId, candidate.credited_transaction_id]
        );
        if (compensationEntries.rowCount === 0) throw new Error("credited_deposit_ledger_missing");

        incidentId = randomUUID();
        await client.query(
          `
            INSERT INTO financial_incidents (
              id,
              severity,
              status,
              kind,
              entity_type,
              entity_id,
              reason,
              metadata
            )
            VALUES ($1, 'critical', 'open', 'credited_deposit_reorg', 'onchain_deposit', $2, $3, $4)
          `,
          [
            incidentId,
            candidate.id,
            input.reason,
            {
              chainId: input.chainId,
              txHash: candidate.tx_hash,
              logIndex: candidate.log_index,
              amountMicroUnits: candidate.amount_micro_units,
              originalCreditedTransactionId: candidate.credited_transaction_id,
              compensationTransactionId,
              paymentIntentId: candidate.payment_intent_id,
              userId: candidate.user_id,
              walletId: candidate.wallet_id,
              requiresOperatorRemediation: true
            }
          ]
        );
        await setFinancialControlGate(client, {
          operationGate: "blocked",
          reason: "credited_deposit_reorg",
          incidentId,
          metadata: {
            depositId: candidate.id,
            originalCreditedTransactionId: candidate.credited_transaction_id,
            compensationTransactionId,
            requiresOperatorRemediation: true
          }
        });
      } else if (candidate.status === "credited") {
        incidentId = randomUUID();
        await client.query(
          `
            INSERT INTO financial_incidents (
              id,
              severity,
              status,
              kind,
              entity_type,
              entity_id,
              reason,
              metadata
            )
            VALUES ($1, 'critical', 'open', 'credited_deposit_reorg_missing_ledger_link', 'onchain_deposit', $2, $3, $4)
          `,
          [
            incidentId,
            candidate.id,
            input.reason,
            {
              chainId: input.chainId,
              txHash: candidate.tx_hash,
              logIndex: candidate.log_index,
              amountMicroUnits: candidate.amount_micro_units,
              paymentIntentId: candidate.payment_intent_id,
              userId: candidate.user_id,
              walletId: candidate.wallet_id,
              requiresOperatorRemediation: true
            }
          ]
        );
        await setFinancialControlGate(client, {
          operationGate: "blocked",
          reason: "credited_deposit_reorg_missing_ledger_link",
          incidentId,
          metadata: {
            depositId: candidate.id,
            requiresOperatorRemediation: true
          }
        });
      }
      await client.query(
        `
          UPDATE onchain_deposits
          SET
            status = 'reorged',
            reorg_compensation_transaction_id = COALESCE(reorg_compensation_transaction_id, $3),
            reorg_incident_id = COALESCE(reorg_incident_id, $4),
            reorged_at = COALESCE(reorged_at, now()),
            reorg_reason = $2,
            updated_at = now()
          WHERE id = $1
        `,
        [candidate.id, input.reason, compensationTransactionId || null, incidentId || null]
      );
      await client.query(
        `
          INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
          VALUES ($1, 'deposit.reorged', 'onchain_deposit', $2, $3)
        `,
        [
          candidate.user_id,
          candidate.id,
          {
            chainId: input.chainId,
            txHash: candidate.tx_hash,
            logIndex: candidate.log_index,
            reason: input.reason,
            originalCreditedTransactionId: candidate.credited_transaction_id,
            compensationTransactionId: compensationTransactionId || null,
            incidentId: incidentId || null
          }
        ]
      );
      reorged += 1;
      if (candidate.status === "credited" || candidate.credited_transaction_id) creditedReorged += 1;
    }

    const fundingCandidates = await client.query<{
      id: string;
      tx_hash: string;
      log_index: number;
      block_hash: string;
      amount_micro_units: string;
      ledger_transaction_id: string;
    }>(
      `
        SELECT
          funding.id,
          funding.tx_hash,
          funding.log_index,
          funding.block_hash,
          funding.amount_micro_units::text,
          funding.ledger_transaction_id
        FROM house_funding_evidence funding
        LEFT JOIN house_funding_reorgs reorgs
          ON reorgs.house_funding_evidence_id = funding.id
        WHERE funding.chain_id = $1
          AND funding.block_number BETWEEN $2 AND $3
          AND funding.to_address = ANY($4::text[])
          AND funding.token_address = ANY($5::text[])
          AND reorgs.id IS NULL
        FOR UPDATE OF funding
      `,
      [input.chainId, input.fromBlock.toString(), input.toBlock.toString(), toAddresses, tokenAddresses]
    );

    for (const funding of fundingCandidates.rows) {
      if (
        canonical.has(
          canonicalDepositFactKey({
            txHash: funding.tx_hash,
            logIndex: funding.log_index,
            blockHash: funding.block_hash
          })
        )
      ) {
        continue;
      }

      const compensationTransactionId = randomUUID();
      const compensationEntries = await client.query<{ id: string }>(
        `
          INSERT INTO ledger_entries (
            transaction_id, account_id, amount_micro_units, currency, memo
          )
          SELECT
            $1,
            ledger_entries.account_id,
            -ledger_entries.amount_micro_units,
            ledger_entries.currency,
            'house funding reorg compensation'
          FROM ledger_entries
          WHERE ledger_entries.transaction_id = $2
          RETURNING id
        `,
        [compensationTransactionId, funding.ledger_transaction_id]
      );
      if (compensationEntries.rowCount === 0) throw new Error("house_funding_ledger_missing");

      const incidentId = randomUUID();
      await client.query(
        `
          INSERT INTO financial_incidents (
            id, severity, status, kind, entity_type, entity_id, reason, metadata
          )
          VALUES ($1, 'critical', 'open', 'house_funding_reorg', 'house_funding_evidence', $2, $3, $4)
        `,
        [
          incidentId,
          funding.id,
          input.reason,
          {
            chainId: input.chainId,
            txHash: funding.tx_hash,
            logIndex: funding.log_index,
            amountMicroUnits: funding.amount_micro_units,
            originalLedgerTransactionId: funding.ledger_transaction_id,
            compensationTransactionId,
            requiresOperatorRemediation: true
          }
        ]
      );
      await client.query(
        `
          INSERT INTO house_funding_reorgs (
            house_funding_evidence_id, compensation_transaction_id, incident_id, reason
          )
          VALUES ($1, $2, $3, $4)
        `,
        [funding.id, compensationTransactionId, incidentId, input.reason]
      );
      await client.query(
        `
          INSERT INTO audit_log (action, entity_type, entity_id, metadata)
          VALUES ('house_funding.reorged', 'house_funding_evidence', $1, $2)
        `,
        [
          funding.id,
          {
            chainId: input.chainId,
            txHash: funding.tx_hash,
            logIndex: funding.log_index,
            reason: input.reason,
            originalLedgerTransactionId: funding.ledger_transaction_id,
            compensationTransactionId,
            incidentId
          }
        ]
      );
      await setFinancialControlGate(client, {
        operationGate: "blocked",
        reason: "house_funding_reorg",
        incidentId,
        metadata: {
          houseFundingEvidenceId: funding.id,
          originalLedgerTransactionId: funding.ledger_transaction_id,
          compensationTransactionId,
          requiresOperatorRemediation: true
        }
      });
      houseFundingReorged += 1;
    }

    await client.query("COMMIT");
    return {
      reorged,
      creditedReorged,
      houseFundingReorged
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
