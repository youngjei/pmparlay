import type pg from "pg";
import { getAddress, isAddress, zeroAddress } from "viem";
import {
  CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS,
  SEPOLIA_PAYMENT_CHAIN_ID
} from "../config";
import { getActiveFinancialControlGate, type FinancialControlGate } from "../financialGate";
import type { FinancialReconciliationSnapshot } from "./reconciliationRepository";
import { getPool } from "./client";
import { evaluateVaultSolvency } from "../vaultSolvency";

export const FOUNDER_SEPOLIA_SHADOW_VAULT_ID = "00000000-0000-4000-8000-000000000001";
export const FOUNDER_SEPOLIA_SHADOW_VAULT_KEY = "founder-sepolia-shadow";
export const LP_VAULT_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

export type LpVaultAvailability =
  | "available"
  | "service_unavailable"
  | "vault_unconfigured"
  | "vault_misconfigured"
  | "reconciliation_absent"
  | "reconciliation_malformed"
  | "reconciliation_untrusted"
  | "reconciliation_wrong_scope"
  | "reconciliation_future"
  | "reconciliation_stale";

export type ConfiguredShadowVault = {
  id: string;
  vaultKey: string;
  displayName: string;
  mode: "shadow";
  chainId: number;
  currency: "USDC";
  treasuryAddress: string;
  tokenAddress: string;
  capitalSource: "founder";
  custodyModel: "logical_operating_treasury";
  communityCustody: false;
  depositsEnabled: false;
  createdAt: string;
};

export type ShadowVaultEpoch = {
  id: string;
  vaultId: string;
  epochNumber: number;
  status: "planned" | "active" | "runoff" | "finalized" | "canceled";
  startsAt: string;
  finalizedAt?: string;
};

export type GlobalHouseBookReconciliation = FinancialReconciliationSnapshot;

export type PublicLpVaultView = {
  mode: "shadow";
  network: {
    chainId: number;
    name: "Sepolia";
    currency: "USDC";
  };
  depositsEnabled: false;
  availability: LpVaultAvailability;
  vault: null | {
    id: string;
    key: string;
    name: string;
    capitalSource: "founder";
    custodyModel: "logical_operating_treasury";
    communityCustody: false;
    treasuryAddress: string;
    tokenAddress: string;
  };
  epoch: null | {
    id: string;
    number: number;
    status: ShadowVaultEpoch["status"];
    startsAt: string;
    finalizedAt?: string;
  };
  snapshot: null | {
    accountingScope: "global_house_book_not_lp_attributed";
    asOf: string;
    blockNumber: string;
    blockHash: string;
    treasuryAssetsUsd: number;
    seniorUserObligationsUsd: number;
    grossUnresolvedPayoutsUsd: number;
    reservedNetLiabilityUsd: number;
    hardCapitalUsd: number;
    hardSolvencyFloorUsd: number;
    operatingCoverageBufferUsd: number;
    pendingBasketStakeUsd: number;
    pendingBasketMaxPayoutUsd: number;
    pendingBasketCount: number;
    pendingBasketCapacityChargeUsd: number;
    operatingWithdrawalFloorUsd: number;
    capitalAboveWithdrawalFloorUsd: number;
    grossCoverage: number | null;
    custodyDeltaUsd: number;
    solvencyStatus: "healthy" | "operating_buffer_breached" | "collateral_shortfall";
    gate: {
      underwriting: "open" | "paused";
      seniorOperations: "open" | "restricted" | "blocked";
      lpWithdrawals: "not_live";
    };
  };
};

type VaultRow = Omit<ConfiguredShadowVault, "createdAt"> & { createdAt: Date };
type EpochRow = Omit<ShadowVaultEpoch, "startsAt" | "finalizedAt"> & {
  startsAt: Date;
  finalizedAt: Date | null;
};
type ReconciliationRow = Omit<FinancialReconciliationSnapshot, "createdAt"> & { createdAt: Date };
type Queryable = pg.Pool | pg.PoolClient | pg.Client;

const baseView = {
  mode: "shadow" as const,
  network: {
    chainId: SEPOLIA_PAYMENT_CHAIN_ID,
    name: "Sepolia" as const,
    currency: "USDC" as const
  },
  depositsEnabled: false as const
};

function normalizedAddress(value: unknown) {
  if (typeof value !== "string" || !isAddress(value)) return undefined;
  const address = getAddress(value);
  return address === zeroAddress ? undefined : address.toLowerCase();
}

function exactMicroUnits(value: unknown, options: { nonnegative?: boolean } = {}) {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = BigInt(value);
  if (options.nonnegative && parsed < 0n) return undefined;
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) return undefined;
  return parsed;
}

function microUnitsToUsd(value: bigint) {
  return Number(value) / 1_000_000;
}

function ratioToSixDecimals(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) return null;
  const scale = 1_000_000n;
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const rounded = (absoluteNumerator * scale + denominator / 2n) / denominator;
  return Number(numerator < 0n ? -rounded : rounded) / Number(scale);
}

function publicVault(vault: ConfiguredShadowVault) {
  return {
    id: vault.id,
    key: vault.vaultKey,
    name: vault.displayName,
    capitalSource: vault.capitalSource,
    custodyModel: vault.custodyModel,
    communityCustody: vault.communityCustody,
    treasuryAddress: vault.treasuryAddress,
    tokenAddress: vault.tokenAddress
  };
}

function publicEpoch(epoch?: ShadowVaultEpoch) {
  if (!epoch) return null;
  return {
    id: epoch.id,
    number: epoch.epochNumber,
    status: epoch.status,
    startsAt: epoch.startsAt,
    ...(epoch.finalizedAt ? { finalizedAt: epoch.finalizedAt } : {})
  };
}

function unavailableView(
  availability: Exclude<LpVaultAvailability, "available">,
  vault?: ConfiguredShadowVault,
  epoch?: ShadowVaultEpoch
): PublicLpVaultView {
  return {
    ...baseView,
    availability,
    vault: vault ? publicVault(vault) : null,
    epoch: publicEpoch(epoch),
    snapshot: null
  };
}

export function unavailableLpVaultPublicView(): PublicLpVaultView {
  return unavailableView("service_unavailable");
}

function validConfiguredVault(vault: ConfiguredShadowVault) {
  return (
    vault.id === FOUNDER_SEPOLIA_SHADOW_VAULT_ID &&
    vault.vaultKey === FOUNDER_SEPOLIA_SHADOW_VAULT_KEY &&
    vault.displayName.length > 0 &&
    vault.mode === "shadow" &&
    vault.chainId === SEPOLIA_PAYMENT_CHAIN_ID &&
    vault.currency === "USDC" &&
    vault.capitalSource === "founder" &&
    vault.custodyModel === "logical_operating_treasury" &&
    vault.communityCustody === false &&
    vault.depositsEnabled === false &&
    Boolean(normalizedAddress(vault.treasuryAddress)) &&
    normalizedAddress(vault.tokenAddress) === CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS.toLowerCase()
  );
}

export function deriveLpVaultPublicView(input: {
  vault?: ConfiguredShadowVault;
  epoch?: ShadowVaultEpoch;
  globalReconciliation?: GlobalHouseBookReconciliation;
  financialControlGate?: FinancialControlGate;
  now?: Date;
  maxSnapshotAgeMs?: number;
}): PublicLpVaultView {
  const { vault, epoch, globalReconciliation: reconciliation } = input;
  if (!vault) return unavailableView("vault_unconfigured");
  if (!validConfiguredVault(vault)) return unavailableView("vault_misconfigured");
  if (!reconciliation) return unavailableView("reconciliation_absent", vault, epoch);

  if (reconciliation.source !== "worker") {
    return unavailableView("reconciliation_untrusted", vault, epoch);
  }

  const blockNumber = exactMicroUnits(reconciliation.observedBlockNumber, { nonnegative: true });
  const blockHash = typeof reconciliation.observedBlockHash === "string"
    ? reconciliation.observedBlockHash.toLowerCase()
    : "";
  const createdAtMs = Date.parse(reconciliation.createdAt);
  const treasuryAssets = exactMicroUnits(reconciliation.treasuryAssetsMicroUnits, { nonnegative: true });
  const internalCustody = exactMicroUnits(reconciliation.internalCustodyMicroUnits);
  const userAvailable = exactMicroUnits(reconciliation.userAvailableMicroUnits, { nonnegative: true });
  const userClaimable = exactMicroUnits(reconciliation.userClaimableMicroUnits, { nonnegative: true });
  const userCheckout = exactMicroUnits(reconciliation.userCheckoutMicroUnits, { nonnegative: true });
  const openStake = exactMicroUnits(reconciliation.openStakeMicroUnits, { nonnegative: true });
  const openReserve = exactMicroUnits(reconciliation.openReserveMicroUnits, { nonnegative: true });
  const pendingWithdrawals = exactMicroUnits(reconciliation.pendingWithdrawalMicroUnits, { nonnegative: true });
  const houseEquity = exactMicroUnits(reconciliation.houseEquityMicroUnits);
  const custodyDelta = exactMicroUnits(reconciliation.unexplainedDeltaMicroUnits);
  const asset = Array.isArray(reconciliation.treasuryAssets) && reconciliation.treasuryAssets.length === 1
    ? reconciliation.treasuryAssets[0]
    : undefined;
  const assetBalance = exactMicroUnits(asset?.balanceMicroUnits, { nonnegative: true });
  const assetBlockNumber = exactMicroUnits(asset?.blockNumber?.toString(), { nonnegative: true });
  const assetBlockHash = typeof asset?.blockHash === "string" ? asset.blockHash.toLowerCase() : "";
  const softReservationStake = exactMicroUnits(reconciliation.metrics?.softReservationStakeMicroUnits, { nonnegative: true });
  const softReservationGrossPayout = exactMicroUnits(reconciliation.metrics?.softReservationGrossPayoutMicroUnits, { nonnegative: true });
  const softReservationCount = exactMicroUnits(reconciliation.metrics?.softReservationCount, { nonnegative: true });
  const softReservationOperatingCharge = exactMicroUnits(reconciliation.metrics?.softReservationOperatingChargeMicroUnits, { nonnegative: true });

  if (
    blockNumber === undefined ||
    !/^0x[0-9a-f]{64}$/.test(blockHash) ||
    !Number.isFinite(createdAtMs) ||
    treasuryAssets === undefined ||
    internalCustody === undefined ||
    userAvailable === undefined ||
    userClaimable === undefined ||
    userCheckout === undefined ||
    openStake === undefined ||
    openReserve === undefined ||
    pendingWithdrawals === undefined ||
    houseEquity === undefined ||
    custodyDelta === undefined ||
    !asset ||
    assetBalance === undefined ||
    assetBlockNumber === undefined ||
    assetBalance !== treasuryAssets ||
    assetBlockNumber !== blockNumber ||
    assetBlockHash !== blockHash ||
    softReservationStake === undefined ||
    softReservationGrossPayout === undefined ||
    softReservationCount === undefined ||
    softReservationOperatingCharge === undefined ||
    !["ready", "blocked"].includes(reconciliation.launchGate) ||
    !["open", "restricted", "blocked"].includes(reconciliation.operationGate)
  ) {
    return unavailableView("reconciliation_malformed", vault, epoch);
  }

  const vaultTreasuryAddress = normalizedAddress(vault.treasuryAddress);
  const vaultTokenAddress = normalizedAddress(vault.tokenAddress);
  const scopeTreasuryAddress = normalizedAddress(reconciliation.scopeTreasuryAddress);
  const scopeTokenAddress = normalizedAddress(reconciliation.scopeTokenAddress);
  const assetTreasuryAddress = normalizedAddress(asset.treasuryAddress);
  const assetTokenAddress = normalizedAddress(asset.tokenAddress);

  if (
    !scopeTreasuryAddress ||
    !scopeTokenAddress ||
    !assetTreasuryAddress ||
    !assetTokenAddress ||
    asset.source !== "onchain"
  ) {
    return unavailableView("reconciliation_untrusted", vault, epoch);
  }

  if (
    reconciliation.chainId !== vault.chainId ||
    reconciliation.currency !== vault.currency ||
    asset.chainId !== vault.chainId ||
    scopeTreasuryAddress !== vaultTreasuryAddress ||
    scopeTokenAddress !== vaultTokenAddress ||
    assetTreasuryAddress !== vaultTreasuryAddress ||
    assetTokenAddress !== vaultTokenAddress
  ) {
    return unavailableView("reconciliation_wrong_scope", vault, epoch);
  }

  const seniorUserObligations = userAvailable + userClaimable + userCheckout + pendingWithdrawals;
  const grossUnresolvedPayouts = openStake + openReserve;
  if (
    houseEquity !== treasuryAssets - seniorUserObligations - grossUnresolvedPayouts ||
    custodyDelta !== treasuryAssets - internalCustody
  ) {
    return unavailableView("reconciliation_malformed", vault, epoch);
  }

  const nowMs = (input.now || new Date()).getTime();
  const snapshotAgeMs = nowMs - createdAtMs;
  if (snapshotAgeMs < 0) return unavailableView("reconciliation_future", vault, epoch);
  if (snapshotAgeMs > (input.maxSnapshotAgeMs ?? LP_VAULT_SNAPSHOT_MAX_AGE_MS)) {
    return unavailableView("reconciliation_stale", vault, epoch);
  }

  const solvency = evaluateVaultSolvency({
    eligibleAssetsMicroUnits: treasuryAssets,
    seniorUserObligationsMicroUnits: seniorUserObligations,
    grossUnresolvedPayoutsMicroUnits: grossUnresolvedPayouts,
    pendingBasketStakeMicroUnits: softReservationStake,
    pendingBasketMaxPayoutMicroUnits: softReservationGrossPayout,
    pendingBasketCapacityChargeMicroUnits: softReservationOperatingCharge
  });
  const aggregateChargeFloor = evaluateVaultSolvency({
    eligibleAssetsMicroUnits: treasuryAssets,
    seniorUserObligationsMicroUnits: seniorUserObligations,
    grossUnresolvedPayoutsMicroUnits: grossUnresolvedPayouts,
    pendingBasketStakeMicroUnits: softReservationStake,
    pendingBasketMaxPayoutMicroUnits: softReservationGrossPayout
  }).pendingBasketCapacityChargeMicroUnits;
  const aggregateRoundingCeiling = aggregateChargeFloor + (softReservationCount > 0n ? softReservationCount - 1n : 0n);
  if (
    (softReservationCount === 0n && (softReservationStake !== 0n || softReservationGrossPayout !== 0n)) ||
    softReservationOperatingCharge < aggregateChargeFloor ||
    softReservationOperatingCharge > aggregateRoundingCeiling
  ) {
    return unavailableView("reconciliation_malformed", vault, epoch);
  }
  const seniorOperations = input.financialControlGate?.operationGate === "blocked" || reconciliation.operationGate === "blocked"
    ? "blocked"
    : input.financialControlGate?.operationGate === "restricted" || reconciliation.operationGate === "restricted"
      ? "restricted"
      : "open";

  return {
    ...baseView,
    availability: "available",
    vault: publicVault(vault),
    epoch: publicEpoch(epoch),
    snapshot: {
      accountingScope: "global_house_book_not_lp_attributed",
      asOf: new Date(createdAtMs).toISOString(),
      blockNumber: blockNumber.toString(),
      blockHash,
      treasuryAssetsUsd: microUnitsToUsd(treasuryAssets),
      seniorUserObligationsUsd: microUnitsToUsd(seniorUserObligations),
      grossUnresolvedPayoutsUsd: microUnitsToUsd(grossUnresolvedPayouts),
      reservedNetLiabilityUsd: microUnitsToUsd(openReserve),
      hardCapitalUsd: microUnitsToUsd(houseEquity),
      hardSolvencyFloorUsd: microUnitsToUsd(solvency.hardSolvencyFloorMicroUnits),
      operatingCoverageBufferUsd: microUnitsToUsd(solvency.liveTicketCoverageBufferMicroUnits),
      pendingBasketStakeUsd: microUnitsToUsd(softReservationStake),
      pendingBasketMaxPayoutUsd: microUnitsToUsd(softReservationGrossPayout),
      pendingBasketCount: Number(softReservationCount),
      pendingBasketCapacityChargeUsd: microUnitsToUsd(softReservationOperatingCharge),
      operatingWithdrawalFloorUsd: microUnitsToUsd(solvency.operatingWithdrawalFloorMicroUnits),
      capitalAboveWithdrawalFloorUsd: microUnitsToUsd(solvency.capitalAboveWithdrawalFloorMicroUnits),
      grossCoverage: ratioToSixDecimals(treasuryAssets - seniorUserObligations, grossUnresolvedPayouts),
      custodyDeltaUsd: microUnitsToUsd(custodyDelta),
      solvencyStatus: solvency.status,
      gate: {
        underwriting:
          reconciliation.launchGate === "ready" &&
          solvency.status === "healthy" &&
          !input.financialControlGate
            ? "open"
            : "paused",
        seniorOperations,
        lpWithdrawals: "not_live"
      }
    }
  };
}

async function loadConfiguredShadowVault(queryable: Queryable) {
  const result = await queryable.query<VaultRow>(
    `
      SELECT
        id,
        vault_key AS "vaultKey",
        display_name AS "displayName",
        mode,
        chain_id AS "chainId",
        currency,
        treasury_address AS "treasuryAddress",
        token_address AS "tokenAddress",
        capital_source AS "capitalSource",
        custody_model AS "custodyModel",
        community_custody AS "communityCustody",
        deposits_enabled AS "depositsEnabled",
        created_at AS "createdAt"
      FROM lp_vaults
      WHERE singleton_key = true
      LIMIT 2
    `
  );
  if (result.rows.length !== 1) return undefined;
  return {
    ...result.rows[0],
    createdAt: result.rows[0].createdAt.toISOString()
  } satisfies ConfiguredShadowVault;
}

async function loadLatestShadowEpoch(queryable: Queryable, vaultId: string) {
  const result = await queryable.query<EpochRow>(
    `
      SELECT
        id,
        vault_id AS "vaultId",
        epoch_number AS "epochNumber",
        status,
        starts_at AS "startsAt",
        finalized_at AS "finalizedAt"
      FROM lp_vault_epochs
      WHERE vault_id = $1
      ORDER BY epoch_number DESC
      LIMIT 1
    `,
    [vaultId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    ...row,
    startsAt: row.startsAt.toISOString(),
    finalizedAt: row.finalizedAt?.toISOString()
  } satisfies ShadowVaultEpoch;
}

async function loadLatestGlobalHouseBookReconciliation(queryable: Queryable, chainId: number) {
  const result = await queryable.query<ReconciliationRow>(
    `
      SELECT
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
      FROM financial_reconciliation_snapshots
      WHERE chain_id = $1
        AND currency = 'USDC'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [chainId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    ...row,
    createdAt: row.createdAt.toISOString()
  } satisfies GlobalHouseBookReconciliation;
}

export async function getLpVaultPublicView(options: {
  now?: Date;
  maxSnapshotAgeMs?: number;
  queryable?: Queryable;
} = {}): Promise<PublicLpVaultView> {
  const queryable = options.queryable || getPool();
  const vault = await loadConfiguredShadowVault(queryable);
  if (!vault) return unavailableView("vault_unconfigured");
  const [epoch, globalReconciliation, financialControlGate] = await Promise.all([
    loadLatestShadowEpoch(queryable, vault.id),
    loadLatestGlobalHouseBookReconciliation(queryable, vault.chainId),
    getActiveFinancialControlGate(queryable)
  ]);
  return deriveLpVaultPublicView({
    vault,
    epoch,
    globalReconciliation,
    financialControlGate,
    now: options.now,
    maxSnapshotAgeMs: options.maxSnapshotAgeMs
  });
}

export async function provisionFounderSepoliaShadowVault(input: {
  treasuryAddress: string;
  tokenAddress?: string;
  queryable?: Queryable;
}) {
  const queryable = input.queryable || getPool();
  const treasuryAddress = normalizedAddress(input.treasuryAddress);
  const tokenAddress = normalizedAddress(input.tokenAddress || CIRCLE_SEPOLIA_USDC_CONTRACT_ADDRESS);
  if (!treasuryAddress || !tokenAddress) throw new Error("invalid_shadow_vault_scope");

  await queryable.query(
    `
      INSERT INTO lp_vaults (
        id,
        singleton_key,
        vault_key,
        display_name,
        mode,
        chain_id,
        currency,
        treasury_address,
        token_address,
        capital_source,
        custody_model,
        community_custody,
        deposits_enabled
      )
      VALUES ($1, true, $2, $3, 'shadow', $4, 'USDC', $5, $6, 'founder', 'logical_operating_treasury', false, false)
      ON CONFLICT (singleton_key) DO NOTHING
    `,
    [
      FOUNDER_SEPOLIA_SHADOW_VAULT_ID,
      FOUNDER_SEPOLIA_SHADOW_VAULT_KEY,
      "LEGWORK Founder Shadow Vault",
      SEPOLIA_PAYMENT_CHAIN_ID,
      treasuryAddress,
      tokenAddress
    ]
  );

  const configured = await loadConfiguredShadowVault(queryable);
  if (
    !configured ||
    !validConfiguredVault(configured) ||
    configured.treasuryAddress !== treasuryAddress ||
    configured.tokenAddress !== tokenAddress
  ) {
    throw new Error("shadow_vault_configuration_mismatch");
  }
  return configured;
}
