export const LP_VAULT_CLIENT_MAX_AGE_MS = 5 * 60_000;

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

export type LpVaultEpochStatus = "planned" | "active" | "runoff" | "finalized" | "canceled";

export type LpVaultResponse = {
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
    status: LpVaultEpochStatus;
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

export type LpVaultFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type LpVaultDisplayState = "ready" | Exclude<LpVaultAvailability, "available">;

export class LpVaultFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LpVaultFetchError";
  }
}

const availabilityValues = new Set<LpVaultAvailability>([
  "available",
  "service_unavailable",
  "vault_unconfigured",
  "vault_misconfigured",
  "reconciliation_absent",
  "reconciliation_malformed",
  "reconciliation_untrusted",
  "reconciliation_wrong_scope",
  "reconciliation_future",
  "reconciliation_stale"
]);
const epochStatuses = new Set<LpVaultEpochStatus>(["planned", "active", "runoff", "finalized", "canceled"]);
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const blockHashPattern = /^0x[0-9a-fA-F]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toMicroUnits(value: number) {
  const scaled = value * 1_000_000;
  if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 0.000_001) return undefined;
  return BigInt(Math.round(scaled));
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isVault(value: unknown): value is NonNullable<LpVaultResponse["vault"]> {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.key === "string" &&
    typeof value.name === "string" &&
    value.capitalSource === "founder" &&
    value.custodyModel === "logical_operating_treasury" &&
    value.communityCustody === false &&
    typeof value.treasuryAddress === "string" &&
    addressPattern.test(value.treasuryAddress) &&
    typeof value.tokenAddress === "string" &&
    addressPattern.test(value.tokenAddress)
  );
}

function isEpoch(value: unknown): value is NonNullable<LpVaultResponse["epoch"]> {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    Number.isInteger(value.number) &&
    Number(value.number) > 0 &&
    epochStatuses.has(value.status as LpVaultEpochStatus) &&
    isIsoDate(value.startsAt) &&
    (value.finalizedAt === undefined || isIsoDate(value.finalizedAt))
  );
}

function isSnapshot(value: unknown): value is NonNullable<LpVaultResponse["snapshot"]> {
  if (!isRecord(value) || !isRecord(value.gate)) return false;
  const structurallyValid = (
    value.accountingScope === "global_house_book_not_lp_attributed" &&
    isIsoDate(value.asOf) &&
    typeof value.blockNumber === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value.blockNumber) &&
    typeof value.blockHash === "string" &&
    blockHashPattern.test(value.blockHash) &&
    isFiniteNumber(value.treasuryAssetsUsd) && value.treasuryAssetsUsd >= 0 &&
    isFiniteNumber(value.seniorUserObligationsUsd) && value.seniorUserObligationsUsd >= 0 &&
    isFiniteNumber(value.grossUnresolvedPayoutsUsd) && value.grossUnresolvedPayoutsUsd >= 0 &&
    isFiniteNumber(value.reservedNetLiabilityUsd) && value.reservedNetLiabilityUsd >= 0 &&
    isFiniteNumber(value.hardCapitalUsd) &&
    isFiniteNumber(value.hardSolvencyFloorUsd) && value.hardSolvencyFloorUsd >= 0 &&
    isFiniteNumber(value.operatingCoverageBufferUsd) && value.operatingCoverageBufferUsd >= 0 &&
    isFiniteNumber(value.pendingBasketStakeUsd) && value.pendingBasketStakeUsd >= 0 &&
    isFiniteNumber(value.pendingBasketMaxPayoutUsd) && value.pendingBasketMaxPayoutUsd >= 0 &&
    Number.isSafeInteger(value.pendingBasketCount) && Number(value.pendingBasketCount) >= 0 &&
    isFiniteNumber(value.pendingBasketCapacityChargeUsd) && value.pendingBasketCapacityChargeUsd >= 0 &&
    isFiniteNumber(value.operatingWithdrawalFloorUsd) && value.operatingWithdrawalFloorUsd >= value.hardSolvencyFloorUsd &&
    isFiniteNumber(value.capitalAboveWithdrawalFloorUsd) && value.capitalAboveWithdrawalFloorUsd >= 0 &&
    (value.grossCoverage === null || isFiniteNumber(value.grossCoverage)) &&
    isFiniteNumber(value.custodyDeltaUsd) &&
    (value.solvencyStatus === "healthy" || value.solvencyStatus === "operating_buffer_breached" || value.solvencyStatus === "collateral_shortfall") &&
    (value.gate.underwriting === "open" || value.gate.underwriting === "paused") &&
    (value.gate.seniorOperations === "open" || value.gate.seniorOperations === "restricted" || value.gate.seniorOperations === "blocked") &&
    value.gate.lpWithdrawals === "not_live"
  );
  if (!structurallyValid) return false;

  const treasuryAssets = toMicroUnits(value.treasuryAssetsUsd as number);
  const seniorUserObligations = toMicroUnits(value.seniorUserObligationsUsd as number);
  const grossUnresolvedPayouts = toMicroUnits(value.grossUnresolvedPayoutsUsd as number);
  const hardCapital = toMicroUnits(value.hardCapitalUsd as number);
  const hardSolvencyFloor = toMicroUnits(value.hardSolvencyFloorUsd as number);
  const operatingCoverageBuffer = toMicroUnits(value.operatingCoverageBufferUsd as number);
  const pendingBasketStake = toMicroUnits(value.pendingBasketStakeUsd as number);
  const pendingBasketMaxPayout = toMicroUnits(value.pendingBasketMaxPayoutUsd as number);
  const pendingBasketCount = BigInt(value.pendingBasketCount as number);
  const pendingBasketCapacityCharge = toMicroUnits(value.pendingBasketCapacityChargeUsd as number);
  const operatingWithdrawalFloor = toMicroUnits(value.operatingWithdrawalFloorUsd as number);
  const capitalAboveWithdrawalFloor = toMicroUnits(value.capitalAboveWithdrawalFloorUsd as number);
  if (
    treasuryAssets === undefined ||
    seniorUserObligations === undefined ||
    grossUnresolvedPayouts === undefined ||
    hardCapital === undefined ||
    hardSolvencyFloor === undefined ||
    operatingCoverageBuffer === undefined ||
    pendingBasketStake === undefined ||
    pendingBasketMaxPayout === undefined ||
    pendingBasketCapacityCharge === undefined ||
    operatingWithdrawalFloor === undefined ||
    capitalAboveWithdrawalFloor === undefined
  ) return false;

  const expectedHardSolvencyFloor = seniorUserObligations + grossUnresolvedPayouts;
  const expectedOperatingBuffer = (grossUnresolvedPayouts + 3n) / 4n;
  const pendingBasketOperatingFloor = (pendingBasketMaxPayout * 125n + 99n) / 100n;
  const minimumPendingBasketCapacityCharge = pendingBasketOperatingFloor > pendingBasketStake
    ? pendingBasketOperatingFloor - pendingBasketStake
    : 0n;
  const maximumPendingBasketCapacityCharge = minimumPendingBasketCapacityCharge +
    (pendingBasketCount > 0n ? pendingBasketCount - 1n : 0n);
  const expectedOperatingFloor = expectedHardSolvencyFloor + expectedOperatingBuffer + pendingBasketCapacityCharge;
  const expectedCapitalAboveWithdrawalFloor = treasuryAssets > expectedOperatingFloor
    ? treasuryAssets - expectedOperatingFloor
    : 0n;
  if (
    hardCapital !== treasuryAssets - expectedHardSolvencyFloor ||
    hardSolvencyFloor !== expectedHardSolvencyFloor ||
    operatingCoverageBuffer !== expectedOperatingBuffer ||
    (pendingBasketCount === 0n && (pendingBasketStake !== 0n || pendingBasketMaxPayout !== 0n)) ||
    pendingBasketCapacityCharge < minimumPendingBasketCapacityCharge ||
    pendingBasketCapacityCharge > maximumPendingBasketCapacityCharge ||
    operatingWithdrawalFloor !== expectedOperatingFloor ||
    capitalAboveWithdrawalFloor !== expectedCapitalAboveWithdrawalFloor
  ) return false;

  const expectedSolvencyStatus = treasuryAssets < expectedHardSolvencyFloor
    ? "collateral_shortfall"
    : treasuryAssets < expectedOperatingFloor
      ? "operating_buffer_breached"
      : "healthy";
  if (
    value.solvencyStatus !== expectedSolvencyStatus ||
    (expectedSolvencyStatus !== "healthy" && value.gate.underwriting !== "paused")
  ) return false;

  if (grossUnresolvedPayouts === 0n) return value.grossCoverage === null;
  const coverageNumerator = treasuryAssets - seniorUserObligations;
  const absoluteNumerator = coverageNumerator < 0n ? -coverageNumerator : coverageNumerator;
  const roundedCoverage = (absoluteNumerator * 1_000_000n + grossUnresolvedPayouts / 2n) / grossUnresolvedPayouts;
  const expectedCoverage = Number(coverageNumerator < 0n ? -roundedCoverage : roundedCoverage) / 1_000_000;
  return typeof value.grossCoverage === "number" && Math.abs(value.grossCoverage - expectedCoverage) <= 0.000_001;
}

function isLpVaultResponse(value: unknown): value is LpVaultResponse {
  if (!isRecord(value) || value.mode !== "shadow" || value.depositsEnabled !== false) return false;
  if (!availabilityValues.has(value.availability as LpVaultAvailability)) return false;
  if (
    !isRecord(value.network) ||
    value.network.chainId !== 11155111 ||
    value.network.name !== "Sepolia" ||
    value.network.currency !== "USDC"
  ) return false;
  if (value.vault !== null && !isVault(value.vault)) return false;
  if (value.epoch !== null && !isEpoch(value.epoch)) return false;
  if (value.snapshot !== null && !isSnapshot(value.snapshot)) return false;
  if (value.availability === "available" && (!value.vault || !value.snapshot)) return false;
  if (value.availability !== "available" && value.snapshot !== null) return false;
  return true;
}

export async function fetchLpVault(
  endpoint = "/api/lp-vault",
  fetcher: LpVaultFetcher = fetch,
  signal?: AbortSignal
): Promise<LpVaultResponse> {
  let response: Awaited<ReturnType<LpVaultFetcher>>;

  try {
    response = await fetcher(endpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal
    });
  } catch {
    throw new LpVaultFetchError("Unable to reach the vault service.");
  }

  if (!response.ok) {
    throw new LpVaultFetchError("Unable to load vault availability.", response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LpVaultFetchError("Vault availability returned an invalid response.", response.status);
  }

  if (!isLpVaultResponse(payload)) {
    throw new LpVaultFetchError("Vault availability returned an unexpected response.", response.status);
  }

  return payload;
}

export function collateralHealthCopy(snapshot: NonNullable<LpVaultResponse["snapshot"]>): {
  label: string;
  detail: string;
  tone: "healthy" | "warning" | "critical";
} {
  if (snapshot.treasuryAssetsUsd < snapshot.hardSolvencyFloorUsd) {
    return {
      label: "Collateral shortfall",
      detail: "New bets and withdrawals must remain paused.",
      tone: "critical"
    };
  }
  if (snapshot.treasuryAssetsUsd < snapshot.operatingWithdrawalFloorUsd) {
    return {
      label: "Payouts covered",
      detail: "The 25% operating buffer is below target, so future LP withdrawals would be paused.",
      tone: "warning"
    };
  }
  return {
    label: "Fully collateralized",
    detail: "The 25% operating buffer is intact.",
    tone: "healthy"
  };
}

export function getLpVaultDisplayState(data: LpVaultResponse, now = Date.now()): LpVaultDisplayState {
  if (data.availability !== "available") return data.availability;
  if (!data.snapshot || !data.vault) return "reconciliation_malformed";
  const ageMs = now - Date.parse(data.snapshot.asOf);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "reconciliation_future";
  if (ageMs > LP_VAULT_CLIENT_MAX_AGE_MS) return "reconciliation_stale";
  return "ready";
}

export function canShowLpVaultAmounts(data: LpVaultResponse, now = Date.now()): boolean {
  return getLpVaultDisplayState(data, now) === "ready";
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}x`;
}

export function formatDateTime(value?: string): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not scheduled";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
}

export function formatReconciliationAge(asOf: string, now = Date.now()): string {
  const then = new Date(asOf).getTime();
  if (!Number.isFinite(then)) return "Unknown age";
  const elapsedSeconds = Math.max(0, Math.floor((now - then) / 1000));
  if (elapsedSeconds < 60) return "Just now";
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h ago`;
  return `${Math.floor(elapsedSeconds / 86_400)}d ago`;
}

export function shortHash(value: string, start = 8, end = 6): string {
  if (value.length <= start + end + 1) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function explorerBaseUrl(chainId: number): string | undefined {
  if (chainId === 11155111) return "https://sepolia.etherscan.io";
  if (chainId === 1) return "https://etherscan.io";
  return undefined;
}

export function explorerUrl(baseUrl: string | undefined, path: string): string | undefined {
  if (!baseUrl || !path) return undefined;
  try {
    return new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return undefined;
  }
}

export function gateCopy(
  gate: "open" | "paused" | "restricted" | "blocked" | "not_live"
): { label: string; tone: "open" | "restricted" | "blocked" } {
  switch (gate) {
    case "open":
      return { label: "Operating normally", tone: "open" };
    case "paused":
      return { label: "Paused by reserve policy", tone: "restricted" };
    case "restricted":
      return { label: "Operating with restrictions", tone: "restricted" };
    case "not_live":
      return { label: "Not live", tone: "blocked" };
    case "blocked":
      return { label: "Paused pending review", tone: "blocked" };
  }
}

export function liquidityWindowCopy(epoch: LpVaultResponse["epoch"]): { value: string; detail: string } {
  if (!epoch) return { value: "Not scheduled", detail: "No shadow epoch is active." };
  if (epoch.status === "planned") {
    return { value: formatDateTime(epoch.startsAt), detail: `Epoch ${epoch.number} is planned.` };
  }
  if (epoch.status === "active") {
    return { value: "After full run-off", detail: `Epoch ${epoch.number} is underwriting.` };
  }
  if (epoch.status === "runoff") {
    return { value: "After final settlement", detail: `Epoch ${epoch.number} is resolving open positions.` };
  }
  if (epoch.status === "finalized") {
    return { value: formatDateTime(epoch.finalizedAt), detail: `Epoch ${epoch.number} is finalized.` };
  }
  return { value: "Not scheduled", detail: `Epoch ${epoch.number} was canceled.` };
}

export function unavailableCopy(state: Exclude<LpVaultDisplayState, "ready">): {
  title: string;
  detail: string;
} {
  switch (state) {
    case "service_unavailable":
      return { title: "Vault service is unavailable", detail: "Try again once the vault service is reachable." };
    case "vault_unconfigured":
      return { title: "Vault setup in progress", detail: "Shadow capital will appear once the vault is configured." };
    case "vault_misconfigured":
      return { title: "Vault setup needs review", detail: "Capital figures are withheld until the configured scope is verified." };
    case "reconciliation_absent":
      return { title: "Reconciliation pending", detail: "Capital figures will appear after the first verified reconciliation." };
    case "reconciliation_malformed":
      return { title: "Reconciliation needs review", detail: "Capital figures are withheld because the latest record is incomplete." };
    case "reconciliation_untrusted":
      return { title: "Reconciliation source is unverified", detail: "Capital figures are withheld until their source can be trusted." };
    case "reconciliation_wrong_scope":
      return { title: "Vault scope does not match", detail: "Capital figures are withheld until treasury and token scope agree." };
    case "reconciliation_future":
      return { title: "Reconciliation time needs review", detail: "Capital figures are withheld because the latest timestamp is invalid." };
    case "reconciliation_stale":
      return { title: "Reconciliation is out of date", detail: "Capital figures are withheld until a current reconciliation is available." };
  }
}
