import { createHash } from "node:crypto";
import type pg from "pg";
import { getAddress, isAddress, zeroAddress } from "viem";
import { config } from "../config";
import {
  evaluateReconciliationGate as scoreReconciliationGate,
  lockFinancialControlGateForMutation
} from "../financialGate";
import { staticStagingTreasuryConfig, usesStaticStagingTreasury } from "../stagingTreasury";
import { getPool } from "./client";
import {
  admitNextLpVaultRedemption,
  closeDueLpVaultAccountingForReconciliation,
  type LpVaultRedemptionAdmissionResult
} from "./lpVaultAccountingRepository";

export { evaluateReconciliationGate } from "../financialGate";

export type TreasuryAssetSnapshotInput = {
  chainId: number;
  treasuryAddress: string;
  tokenAddress: string;
  balanceMicroUnits: bigint | string;
  blockNumber?: bigint;
  blockHash?: string;
  blockTimestamp?: bigint;
  source: "onchain";
};

export type CanonicalBlockVerifier = (input: { blockNumber: bigint; blockHash: string }) => Promise<void>;

export type FinancialReconciliationSnapshot = {
  id: string;
  chainId: number;
  currency: "USDC";
  treasuryAssetsMicroUnits: string;
  internalCustodyMicroUnits: string;
  userAvailableMicroUnits: string;
  userClaimableMicroUnits: string;
  userCheckoutMicroUnits: string;
  openStakeMicroUnits: string;
  openReserveMicroUnits: string;
  pendingWithdrawalMicroUnits: string;
  houseEquityMicroUnits: string;
  unexplainedDeltaMicroUnits: string;
  launchGate: "ready" | "blocked";
  operationGate: "open" | "restricted" | "blocked";
  gateReasons: string[];
  treasuryAssets: TreasuryAssetSnapshotInput[];
  metrics: Record<string, string>;
  observedBlockNumber?: string;
  observedBlockHash?: string;
  source: "worker" | "legacy";
  scopeTreasuryAddress?: string;
  scopeTokenAddress?: string;
  createdAt: string;
};

type SnapshotRow = {
  id: string;
  chainId: number;
  currency: "USDC";
  treasuryAssetsMicroUnits: string;
  internalCustodyMicroUnits: string;
  userAvailableMicroUnits: string;
  userClaimableMicroUnits: string;
  userCheckoutMicroUnits: string;
  openStakeMicroUnits: string;
  openReserveMicroUnits: string;
  pendingWithdrawalMicroUnits: string;
  houseEquityMicroUnits: string;
  unexplainedDeltaMicroUnits: string;
  launchGate: "ready" | "blocked";
  operationGate: "open" | "restricted" | "blocked";
  gateReasons: string[];
  treasuryAssets: TreasuryAssetSnapshotInput[];
  metrics: Record<string, string>;
  observedBlockNumber: string | null;
  observedBlockHash: string | null;
  source: "worker" | "legacy";
  scopeTreasuryAddress: string | null;
  scopeTokenAddress: string | null;
  createdAt: Date;
};

type InternalReconciliationPosition = {
  internalCustodyMicroUnits: bigint;
  userAvailableMicroUnits: bigint;
  userClaimableMicroUnits: bigint;
  userCheckoutMicroUnits: bigint;
  openStakeMicroUnits: bigint;
  openOperationFeeMicroUnits: bigint;
  openReserveMicroUnits: bigint;
  grossUnresolvedLiveTicketPayoutMicroUnits: bigint;
  softReservationCount: bigint;
  softReservationStakeMicroUnits: bigint;
  softReservationGrossPayoutMicroUnits: bigint;
  softReservationOperatingChargeMicroUnits: bigint;
  pendingWithdrawalMicroUnits: bigint;
  pendingWithdrawalLedgerMicroUnits: bigint;
  houseOperatingLedgerMicroUnits: bigint;
  houseReserveLedgerMicroUnits: bigint;
};

type TrustedTreasuryAssetSnapshot = Omit<TreasuryAssetSnapshotInput, "balanceMicroUnits" | "blockNumber" | "blockHash" | "blockTimestamp"> & {
  treasuryAddress: string;
  tokenAddress: string;
  balanceMicroUnits: bigint;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
};

export const reconciliationApiIntegrationHooks = {
  latestSnapshot: {
    method: "GET",
    path: "/api/ops/reconciliation/latest",
    repositoryFunction: "getLatestReconciliationSnapshot"
  },
  gateStatus: {
    method: "GET",
    path: "/api/ops/financial-gate",
    moduleFunction: "getFinancialGateDecision"
  },
  snapshotCreation: "worker-only",
  workerEntrypoint: "server/workers/reconciliationWorker.ts",
  workerFunction: "processFinancialReconciliation"
} as const;

function toBigInt(value: string | bigint | null | undefined) {
  return BigInt(value || 0);
}

function rowToSnapshot(row: SnapshotRow): FinancialReconciliationSnapshot {
  return {
    id: row.id,
    chainId: row.chainId,
    currency: row.currency,
    treasuryAssetsMicroUnits: row.treasuryAssetsMicroUnits,
    internalCustodyMicroUnits: row.internalCustodyMicroUnits,
    userAvailableMicroUnits: row.userAvailableMicroUnits,
    userClaimableMicroUnits: row.userClaimableMicroUnits,
    userCheckoutMicroUnits: row.userCheckoutMicroUnits,
    openStakeMicroUnits: row.openStakeMicroUnits,
    openReserveMicroUnits: row.openReserveMicroUnits,
    pendingWithdrawalMicroUnits: row.pendingWithdrawalMicroUnits,
    houseEquityMicroUnits: row.houseEquityMicroUnits,
    unexplainedDeltaMicroUnits: row.unexplainedDeltaMicroUnits,
    launchGate: row.launchGate,
    operationGate: row.operationGate,
    gateReasons: row.gateReasons,
    treasuryAssets: row.treasuryAssets,
    metrics: row.metrics,
    observedBlockNumber: row.observedBlockNumber || undefined,
    observedBlockHash: row.observedBlockHash || undefined,
    source: row.source,
    scopeTreasuryAddress: row.scopeTreasuryAddress || undefined,
    scopeTokenAddress: row.scopeTokenAddress || undefined,
    createdAt: row.createdAt.toISOString()
  };
}

function normalizeAddress(value: string) {
  if (!isAddress(value)) throw new Error("invalid_evm_address");
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error("invalid_evm_address");
  return address.toLowerCase();
}

function normalizeBlockHash(value: string) {
  const blockHash = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(blockHash)) throw new Error("invalid_block_hash");
  return blockHash;
}

function financialStateHash(input: {
  chainId: number;
  currency: "USDC";
  treasuryAssets: TrustedTreasuryAssetSnapshot[];
  position: InternalReconciliationPosition;
}) {
  const assets = input.treasuryAssets.map((asset) => ({
    chainId: asset.chainId,
    treasuryAddress: asset.treasuryAddress,
    tokenAddress: asset.tokenAddress,
    balanceMicroUnits: asset.balanceMicroUnits.toString(),
    source: asset.source
  }));
  const position = Object.fromEntries(
    Object.entries(input.position).map(([key, value]) => [key, value.toString()])
  );
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ chainId: input.chainId, currency: input.currency, assets, position }))
    .digest("hex")}`;
}

function normalizeTrustedTreasuryAssets(input: {
  chainId: number;
  treasuryAssets: TreasuryAssetSnapshotInput[];
  treasuryAddress: string;
  tokenAddress: string;
}): TrustedTreasuryAssetSnapshot[] {
  if (input.treasuryAssets.length !== 1) throw new Error("reconciliation_treasury_scope_mismatch");
  return input.treasuryAssets.map((asset) => {
    if (asset.chainId !== input.chainId) throw new Error("treasury_asset_chain_mismatch");
    if (asset.source !== "onchain") throw new Error("reconciliation_asset_source_untrusted");
    if (asset.blockNumber === undefined) throw new Error("treasury_asset_block_number_required");
    if (!asset.blockHash) throw new Error("treasury_asset_block_hash_required");
    if (asset.blockTimestamp === undefined) throw new Error("treasury_asset_block_timestamp_required");
    const blockNumber = BigInt(asset.blockNumber);
    if (blockNumber < 0n) throw new Error("invalid_block_number");
    const balanceMicroUnits = toBigInt(asset.balanceMicroUnits);
    const blockTimestamp = BigInt(asset.blockTimestamp);
    if (balanceMicroUnits < 0n) throw new Error("invalid_treasury_asset_balance");
    if (blockTimestamp < 0n) throw new Error("invalid_treasury_asset_block_timestamp");
    const treasuryAddress = normalizeAddress(asset.treasuryAddress);
    const tokenAddress = normalizeAddress(asset.tokenAddress);
    if (treasuryAddress !== input.treasuryAddress || tokenAddress !== input.tokenAddress) {
      throw new Error("reconciliation_treasury_scope_mismatch");
    }
    return {
      ...asset,
      treasuryAddress,
      tokenAddress,
      balanceMicroUnits,
      blockNumber,
      blockHash: normalizeBlockHash(asset.blockHash),
      blockTimestamp
    };
  });
}

async function loadActiveReconciliationScope(client: pg.PoolClient, chainId: number) {
  if (chainId !== config.SETTLEMENT_CHAIN_ID) throw new Error("reconciliation_payment_chain_mismatch");
  if (usesStaticStagingTreasury()) {
    const treasury = staticStagingTreasuryConfig();
    return {
      treasuryAddress: treasury.treasuryAddress.toLowerCase(),
      tokenAddress: treasury.usdcContractAddress.toLowerCase()
    };
  }

  const result = await client.query<{
    treasuryAddress: string;
    tokenAddress: string;
  }>(
    `
      SELECT
        treasury_address AS "treasuryAddress",
        usdc_contract_address AS "tokenAddress"
      FROM treasury_config
      WHERE chain_id = $1
        AND currency = 'USDC'
        AND active = true
      LIMIT 2
      FOR SHARE
    `,
    [chainId]
  );
  if (result.rows.length !== 1) throw new Error("active_treasury_config_missing");
  return {
    treasuryAddress: normalizeAddress(result.rows[0].treasuryAddress),
    tokenAddress: normalizeAddress(result.rows[0].tokenAddress)
  };
}

async function ledgerBalancesByAccountType(client: pg.PoolClient) {
  const result = await client.query<{ account_type: string; balance: string }>(
    `
      SELECT
        ledger_accounts.account_type,
        COALESCE(sum(ledger_entries.amount_micro_units), 0)::text AS balance
      FROM ledger_accounts
      LEFT JOIN ledger_entries ON ledger_entries.account_id = ledger_accounts.id
      WHERE ledger_accounts.currency = 'USDC'
      GROUP BY ledger_accounts.account_type
    `
  );
  return new Map(result.rows.map((row) => [row.account_type, toBigInt(row.balance)]));
}

async function internalCustodyMicroUnits(client: pg.PoolClient) {
  const result = await client.query<{ balance: string }>(
    `
      SELECT COALESCE(sum(ledger_entries.amount_micro_units), 0)::text AS balance
      FROM ledger_entries
      JOIN ledger_accounts ON ledger_accounts.id = ledger_entries.account_id
      WHERE ledger_accounts.currency = 'USDC'
        AND ledger_accounts.account_type NOT LIKE 'external_%'
    `
  );
  return toBigInt(result.rows[0]?.balance);
}

async function openReservePosition(client: pg.PoolClient) {
  const result = await client.query<{
    stake: string;
    operationFee: string;
    reserve: string;
    grossPayout: string;
  }>(
    `
      SELECT
        COALESCE(sum(stake_micro_units), 0)::text AS stake,
        COALESCE(sum(operation_fee_micro_units), 0)::text AS "operationFee",
        COALESCE(sum(net_liability_micro_units), 0)::text AS reserve,
        COALESCE(sum(offered_payout_micro_units), 0)::text AS "grossPayout"
      FROM ticket_reserves
      WHERE accounting_mode = 'house_book_usdc'
        AND currency = 'USDC'
        AND status = 'reserved'
        AND NOT EXISTS (
          SELECT 1 FROM ticket_settlement_summaries summaries
          WHERE summaries.ticket_id = ticket_reserves.ticket_id
        )
    `
  );
  const row = result.rows[0];
  return {
    openStakeMicroUnits: toBigInt(row?.stake),
    openOperationFeeMicroUnits: toBigInt(row?.operationFee),
    openReserveMicroUnits: toBigInt(row?.reserve),
    grossUnresolvedLiveTicketPayoutMicroUnits: toBigInt(row?.grossPayout)
  };
}

async function softReservationPosition(client: pg.PoolClient) {
  const result = await client.query<{
    reservationCount: string;
    stake: string;
    grossPayout: string;
    operatingCharge: string;
  }>(
    `
      WITH active_reservations AS (
        SELECT
          quotes.stake_micro_usd AS stake,
          quotes.offered_payout_micro_usd AS gross_payout,
          GREATEST(
            ((quotes.offered_payout_micro_usd * 125 + 99) / 100) - quotes.stake_micro_usd,
            0
          ) AS operating_charge
        FROM quote_payment_exposure_reservations
        JOIN quotes ON quotes.id = quote_payment_exposure_reservations.quote_id
        WHERE quote_payment_exposure_reservations.status = 'reserved'
          AND quote_payment_exposure_reservations.expires_at > now()
      )
      SELECT
        count(*)::text AS "reservationCount",
        COALESCE(sum(stake), 0)::text AS stake,
        COALESCE(sum(gross_payout), 0)::text AS "grossPayout",
        COALESCE(sum(operating_charge), 0)::text AS "operatingCharge"
      FROM active_reservations
    `
  );
  const row = result.rows[0];
  return {
    softReservationCount: toBigInt(row?.reservationCount),
    softReservationStakeMicroUnits: toBigInt(row?.stake),
    softReservationGrossPayoutMicroUnits: toBigInt(row?.grossPayout),
    softReservationOperatingChargeMicroUnits: toBigInt(row?.operatingCharge)
  };
}

async function pendingWithdrawalRequests(client: pg.PoolClient) {
  const result = await client.query<{ pending: string }>(
    `
      SELECT COALESCE(sum(amount_micro_units), 0)::text AS pending
      FROM withdrawal_requests
      WHERE currency = 'USDC'
        AND status IN ('requested', 'proposed')
    `
  );
  return toBigInt(result.rows[0]?.pending);
}

async function loadInternalPosition(client: pg.PoolClient): Promise<InternalReconciliationPosition> {
  const balances = await ledgerBalancesByAccountType(client);
  const reserves = await openReservePosition(client);
  const softReservations = await softReservationPosition(client);
  return {
    internalCustodyMicroUnits: await internalCustodyMicroUnits(client),
    userAvailableMicroUnits: balances.get("user_usdc_available") || 0n,
    userClaimableMicroUnits: balances.get("user_usdc_claimable") || 0n,
    userCheckoutMicroUnits: balances.get("user_usdc_checkout") || 0n,
    pendingWithdrawalMicroUnits: await pendingWithdrawalRequests(client),
    pendingWithdrawalLedgerMicroUnits: balances.get("pending_usdc_withdrawals") || 0n,
    houseOperatingLedgerMicroUnits: balances.get("house_usdc_operating") || 0n,
    houseReserveLedgerMicroUnits: balances.get("house_usdc_reserve") || 0n,
    ...reserves,
    ...softReservations
  };
}

export type CreateReconciliationSnapshotInput = {
  source: "worker";
  chainId: number;
  currency?: "USDC";
  treasuryAssets: TreasuryAssetSnapshotInput[];
  verifyCanonicalBlock: CanonicalBlockVerifier;
  driftToleranceMicroUnits?: bigint;
  operationWarnToleranceMicroUnits?: bigint;
};

async function createReconciliationSnapshotInTransaction(
  client:pg.PoolClient,
  input:CreateReconciliationSnapshotInput
) {
  if (input.source !== "worker") throw new Error("reconciliation_snapshot_source_untrusted");
  const currency = input.currency || "USDC";
  await lockFinancialControlGateForMutation(client);
  await client.query("SELECT set_config('legwork.financial_global_exclusive_lock', 'held', true)");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`financial-reconciliation:${input.chainId}:${currency}`]);
    const financialBook = await client.query<{ book_version: string }>(
      "SELECT book_version::text FROM financial_book_state WHERE scope='global' FOR SHARE"
    );
    if (!financialBook.rows[0]) throw new Error("financial_book_state_missing");
    const scope = await loadActiveReconciliationScope(client, input.chainId);
    const treasuryAssets = normalizeTrustedTreasuryAssets({
      chainId: input.chainId,
      treasuryAssets: input.treasuryAssets,
      ...scope
    });
    const position = await loadInternalPosition(client);
    if (position.userAvailableMicroUnits < 0n || position.userClaimableMicroUnits < 0n
      || position.userCheckoutMicroUnits < 0n || position.pendingWithdrawalMicroUnits < 0n) {
      throw new Error("reconciliation_negative_senior_balance");
    }
    const treasuryAssetsMicroUnits = treasuryAssets.reduce((sum, asset) => sum + asset.balanceMicroUnits, 0n);
    const knownLiabilitiesMicroUnits =
      position.userAvailableMicroUnits +
      position.userClaimableMicroUnits +
      position.userCheckoutMicroUnits +
      position.pendingWithdrawalMicroUnits +
      position.openStakeMicroUnits +
      position.openReserveMicroUnits;
    const houseEquityMicroUnits = treasuryAssetsMicroUnits - knownLiabilitiesMicroUnits;
    const unexplainedDeltaMicroUnits = treasuryAssetsMicroUnits - position.internalCustodyMicroUnits;
    const gate = scoreReconciliationGate({
      unexplainedDeltaMicroUnits,
      houseEquityMicroUnits,
      pendingWithdrawalMicroUnits: position.pendingWithdrawalMicroUnits,
      pendingWithdrawalLedgerMicroUnits: position.pendingWithdrawalLedgerMicroUnits,
      driftToleranceMicroUnits: input.driftToleranceMicroUnits,
      operationWarnToleranceMicroUnits: input.operationWarnToleranceMicroUnits
    });
    const observedBlockNumber = treasuryAssets.reduce<bigint | undefined>((latest, asset) => {
      return latest === undefined || asset.blockNumber > latest ? asset.blockNumber : latest;
    }, undefined);
    const observedBlockHash = treasuryAssets.find((asset) => asset.blockNumber === observedBlockNumber)?.blockHash;
    const metrics: Record<string, string> = {
      knownLiabilitiesMicroUnits: knownLiabilitiesMicroUnits.toString(),
      pendingWithdrawalLedgerMicroUnits: position.pendingWithdrawalLedgerMicroUnits.toString(),
      houseOperatingLedgerMicroUnits: position.houseOperatingLedgerMicroUnits.toString(),
      houseReserveLedgerMicroUnits: position.houseReserveLedgerMicroUnits.toString(),
      openOperationFeeMicroUnits: position.openOperationFeeMicroUnits.toString(),
      softReservationCount: position.softReservationCount.toString(),
      softReservationStakeMicroUnits: position.softReservationStakeMicroUnits.toString(),
      softReservationGrossPayoutMicroUnits: position.softReservationGrossPayoutMicroUnits.toString(),
      softReservationOperatingChargeMicroUnits: position.softReservationOperatingChargeMicroUnits.toString(),
      grossUnresolvedLiveTicketPayoutMicroUnits: position.grossUnresolvedLiveTicketPayoutMicroUnits.toString(),
      observedBlockTimestamp: treasuryAssets[0].blockTimestamp.toString(),
      treasuryAssetCount: treasuryAssets.length.toString()
    };
    if (observedBlockNumber === undefined || !observedBlockHash) throw new Error("reconciliation_observed_block_missing");
    await input.verifyCanonicalBlock({
      blockNumber: observedBlockNumber,
      blockHash: observedBlockHash
    });
    const gateReasonsJson = JSON.stringify(gate.reasons);
    const treasuryAssetsJson = JSON.stringify(
      treasuryAssets.map((asset) => ({
        ...asset,
        balanceMicroUnits: asset.balanceMicroUnits.toString(),
        blockNumber: asset.blockNumber.toString(),
        blockTimestamp: asset.blockTimestamp.toString()
      }))
    );
    const metricsJson = JSON.stringify(metrics);
    const stateHash = financialStateHash({
      chainId: input.chainId,
      currency,
      treasuryAssets,
      position
    });

    const result = await client.query<SnapshotRow>(
      `
        INSERT INTO financial_reconciliation_snapshots (
          chain_id,
          currency,
          treasury_assets_micro_units,
          internal_custody_micro_units,
          user_available_micro_units,
          user_claimable_micro_units,
          user_checkout_micro_units,
          open_stake_micro_units,
          open_reserve_micro_units,
          pending_withdrawal_micro_units,
          house_equity_micro_units,
          unexplained_delta_micro_units,
          launch_gate,
          operation_gate,
          gate_reasons,
          treasury_assets,
          metrics,
          observed_block_number,
          observed_block_hash,
          source,
          scope_treasury_address,
          scope_token_address,
          financial_book_version,
          financial_state_hash
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17,
          $18,
          $19,
          $20,
          $21,
          $22,
          $23,
          $24
        )
        RETURNING
          id,
          chain_id AS "chainId",
          currency,
          treasury_assets_micro_units::text AS "treasuryAssetsMicroUnits",
          internal_custody_micro_units::text AS "internalCustodyMicroUnits",
          user_available_micro_units::text AS "userAvailableMicroUnits",
          user_claimable_micro_units::text AS "userClaimableMicroUnits",
          user_checkout_micro_units::text AS "userCheckoutMicroUnits",
          open_stake_micro_units::text AS "openStakeMicroUnits",
          open_reserve_micro_units::text AS "openReserveMicroUnits",
          pending_withdrawal_micro_units::text AS "pendingWithdrawalMicroUnits",
          house_equity_micro_units::text AS "houseEquityMicroUnits",
          unexplained_delta_micro_units::text AS "unexplainedDeltaMicroUnits",
          launch_gate AS "launchGate",
          operation_gate AS "operationGate",
          gate_reasons AS "gateReasons",
          treasury_assets AS "treasuryAssets",
          metrics,
          observed_block_number::text AS "observedBlockNumber",
          observed_block_hash AS "observedBlockHash",
          source,
          scope_treasury_address AS "scopeTreasuryAddress",
          scope_token_address AS "scopeTokenAddress",
          created_at AS "createdAt"
      `,
      [
        input.chainId,
        currency,
        treasuryAssetsMicroUnits.toString(),
        position.internalCustodyMicroUnits.toString(),
        position.userAvailableMicroUnits.toString(),
        position.userClaimableMicroUnits.toString(),
        position.userCheckoutMicroUnits.toString(),
        position.openStakeMicroUnits.toString(),
        position.openReserveMicroUnits.toString(),
        position.pendingWithdrawalMicroUnits.toString(),
        houseEquityMicroUnits.toString(),
        unexplainedDeltaMicroUnits.toString(),
        gate.launchGate,
        gate.operationGate,
        gateReasonsJson,
        treasuryAssetsJson,
        metricsJson,
        observedBlockNumber?.toString() || null,
        observedBlockHash || null,
        input.source,
        scope.treasuryAddress,
        scope.tokenAddress,
        financialBook.rows[0].book_version,
        stateHash
      ]
    );

  return rowToSnapshot(result.rows[0]);
}

async function runReconciliationTransaction<T>(run:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
  const client=await getPool().connect();
  try{
    // The exclusive global lock is the serialization boundary. READ COMMITTED
    // observes any money transaction that committed while this worker waited.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result=await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function preverifyCanonicalReconciliationInput(
  input:CreateReconciliationSnapshotInput
):Promise<CreateReconciliationSnapshotInput>{
  if(input.source!=="worker") throw new Error("reconciliation_snapshot_source_untrusted");
  const first=input.treasuryAssets[0];
  if(!first?.blockHash||first.blockNumber===undefined) throw new Error("reconciliation_observed_block_missing");
  const blockNumber=BigInt(first.blockNumber);
  const blockHash=normalizeBlockHash(first.blockHash);
  if(input.treasuryAssets.some(asset=>asset.blockNumber===undefined||BigInt(asset.blockNumber)!==blockNumber
    ||!asset.blockHash||normalizeBlockHash(asset.blockHash)!==blockHash)) {
    throw new Error("reconciliation_assets_block_mismatch");
  }
  await input.verifyCanonicalBlock({blockNumber,blockHash});
  return {...input,verifyCanonicalBlock:async candidate=>{
    if(candidate.blockNumber!==blockNumber||normalizeBlockHash(candidate.blockHash)!==blockHash)
      throw new Error("reconciliation_preverified_block_mismatch");
  }};
}

export async function createReconciliationSnapshot(input:CreateReconciliationSnapshotInput){
  const verifiedInput=await preverifyCanonicalReconciliationInput(input);
  return await runReconciliationTransaction(client=>createReconciliationSnapshotInTransaction(client,verifiedInput));
}

export type ReconciliationSnapshotWithLpVaultAdmission = FinancialReconciliationSnapshot & {
  lpVaultAdmission?:LpVaultRedemptionAdmissionResult;
  lpVaultAccounting?:Awaited<ReturnType<typeof closeDueLpVaultAccountingForReconciliation>>;
};

export async function createReconciliationSnapshotWithLpVaultAdmission(
  input:CreateReconciliationSnapshotInput
):Promise<ReconciliationSnapshotWithLpVaultAdmission>{
  const verifiedInput=await preverifyCanonicalReconciliationInput(input);
  return await runReconciliationTransaction(async client=>{
    const snapshot=await createReconciliationSnapshotInTransaction(client,verifiedInput);
    const vaults=await client.query<{id:string}>(`SELECT id FROM lp_vaults
      WHERE chain_id=$1 AND currency=$2
        AND lower(treasury_address)=lower($3) AND lower(token_address)=lower($4)
        AND mode='shadow' AND community_custody=false AND deposits_enabled=false
      ORDER BY id LIMIT 2 FOR SHARE`,[
      snapshot.chainId,snapshot.currency,snapshot.scopeTreasuryAddress,snapshot.scopeTokenAddress
    ]);
    if(vaults.rows.length>1) throw new Error("lp_vault_reconciliation_scope_ambiguous");
    if(vaults.rows.length===0) return snapshot;
    const lpVaultAdmission=await admitNextLpVaultRedemption(client,{
      vaultId:vaults.rows[0].id,reconciliationSnapshotId:snapshot.id
    });
    const lpVaultAccounting=await closeDueLpVaultAccountingForReconciliation(client,snapshot.id);
    return {...snapshot,lpVaultAdmission,...(lpVaultAccounting?{lpVaultAccounting}:{})};
  });
}

export async function getLatestReconciliationSnapshot(client?: pg.PoolClient) {
  const queryable = client || getPool();
  const staticTreasury = usesStaticStagingTreasury() ? staticStagingTreasuryConfig() : undefined;
  const treasuryJoin = staticTreasury
    ? ""
    : `JOIN treasury_config active_treasury
        ON active_treasury.chain_id = snapshots.chain_id
       AND active_treasury.currency = snapshots.currency
       AND active_treasury.active = true
       AND lower(active_treasury.treasury_address) = lower(snapshots.scope_treasury_address)
       AND lower(active_treasury.usdc_contract_address) = lower(snapshots.scope_token_address)`;
  const treasuryScope = staticTreasury
    ? `AND lower(snapshots.scope_treasury_address) = lower($2)
        AND lower(snapshots.scope_token_address) = lower($3)
        AND lower(snapshots.treasury_assets->0->>'treasuryAddress') = lower($2)
        AND lower(snapshots.treasury_assets->0->>'tokenAddress') = lower($3)`
    : `AND lower(snapshots.treasury_assets->0->>'treasuryAddress') = lower(active_treasury.treasury_address)
        AND lower(snapshots.treasury_assets->0->>'tokenAddress') = lower(active_treasury.usdc_contract_address)`;
  const result = await queryable.query<SnapshotRow>(
    `
      SELECT
        snapshots.id,
        snapshots.chain_id AS "chainId",
        snapshots.currency,
        snapshots.treasury_assets_micro_units::text AS "treasuryAssetsMicroUnits",
        snapshots.internal_custody_micro_units::text AS "internalCustodyMicroUnits",
        snapshots.user_available_micro_units::text AS "userAvailableMicroUnits",
        snapshots.user_claimable_micro_units::text AS "userClaimableMicroUnits",
        snapshots.user_checkout_micro_units::text AS "userCheckoutMicroUnits",
        snapshots.open_stake_micro_units::text AS "openStakeMicroUnits",
        snapshots.open_reserve_micro_units::text AS "openReserveMicroUnits",
        snapshots.pending_withdrawal_micro_units::text AS "pendingWithdrawalMicroUnits",
        snapshots.house_equity_micro_units::text AS "houseEquityMicroUnits",
        snapshots.unexplained_delta_micro_units::text AS "unexplainedDeltaMicroUnits",
        snapshots.launch_gate AS "launchGate",
        snapshots.operation_gate AS "operationGate",
        snapshots.gate_reasons AS "gateReasons",
        snapshots.treasury_assets AS "treasuryAssets",
        snapshots.metrics,
        snapshots.observed_block_number::text AS "observedBlockNumber",
        snapshots.observed_block_hash AS "observedBlockHash",
        snapshots.source,
        scope_treasury_address AS "scopeTreasuryAddress",
        scope_token_address AS "scopeTokenAddress",
        snapshots.created_at AS "createdAt"
      FROM financial_reconciliation_snapshots snapshots
      ${treasuryJoin}
      WHERE snapshots.chain_id = $1
        AND snapshots.currency = 'USDC'
        AND snapshots.source = 'worker'
        AND jsonb_array_length(snapshots.treasury_assets) = 1
        AND snapshots.treasury_assets->0->>'source' = 'onchain'
        AND snapshots.treasury_assets->0->>'chainId' = snapshots.chain_id::text
        ${treasuryScope}
      ORDER BY snapshots.created_at DESC
      LIMIT 1
      ${client ? (staticTreasury ? "FOR SHARE OF snapshots" : "FOR SHARE OF snapshots, active_treasury") : ""}
    `,
    staticTreasury
      ? [config.SETTLEMENT_CHAIN_ID, staticTreasury.treasuryAddress, staticTreasury.usdcContractAddress]
      : [config.SETTLEMENT_CHAIN_ID]
  );
  return result.rows[0] ? rowToSnapshot(result.rows[0]) : undefined;
}
