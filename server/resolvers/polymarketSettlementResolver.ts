import { createPublicClient, http, type Address, type Hex } from "viem";
import { polygon } from "viem/chains";
import { buildSettlementRpcEndpoints, config, type SettlementAuthority, type SettlementRpcEndpoint } from "../config";
import type {
  PendingSettlementLeg,
  PolymarketApiSettlementCandidate,
  ResolutionState,
  SettlementProofInput,
  SettlementResult
} from "../db/settlementRepository";
import {
  readPolymarketApiResolution,
  type PolymarketApiResolutionRead,
  type PolymarketApiSettlementIdentity
} from "./polymarketApiSettlement";

const POLYMARKET_CTF_SOURCE = "polymarket_ctf";
const POLYMARKET_API_SOURCE = "polymarket_api";

const conditionalTokensAbi = [
  {
    type: "function",
    name: "payoutDenominator",
    stateMutability: "view",
    inputs: [{ name: "conditionId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "payoutNumerators",
    stateMutability: "view",
    inputs: [
      { name: "conditionId", type: "bytes32" },
      { name: "index", type: "uint256" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "getCollectionId",
    stateMutability: "view",
    inputs: [
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSet", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bytes32" }]
  },
  {
    type: "function",
    name: "getPositionId",
    stateMutability: "view",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "collectionId", type: "bytes32" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

type ClobMarketToken = {
  token_id?: string;
  outcome?: string;
  winner?: boolean;
  price?: number;
};

type ClobMarket = {
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  accepting_orders?: boolean;
  condition_id?: string;
  question?: string;
  end_date_iso?: string;
  is_50_50_outcome?: boolean;
  tokens?: ClobMarketToken[];
};

type CtfPayoutSnapshot = {
  provider: string;
  chainId: number;
  contractAddress: string;
  conditionId: string;
  payoutDenominator: string;
  payoutNumerators: string[];
  blockNumber: number;
  blockHash: string;
};

export type CtfProviderEvidence = {
  provider: string;
  rpcHost?: string;
  rpcEndpointId?: string;
  rpcOperator?: string;
  status: "ok" | "error";
  chainId?: number;
  finalizedBlockNumber?: number;
  finalizedBlockHash?: string;
  proofBlockNumber?: number;
  proofBlockHash?: string;
  blockNumber?: number;
  blockHash?: string;
  payoutDenominator?: string;
  payoutNumerators?: string[];
  computedPositionId?: string;
  collectionId?: string;
  readMode?: "blockHash" | "blockNumber_reverified";
  blockHashReadSupported?: boolean;
  blockHashReverified?: boolean;
  blockHashReadError?: string;
  error?: string;
};

export type CtfPayoutQuorumRead = {
  snapshots: CtfPayoutSnapshot[];
  providerEvidence: CtfProviderEvidence[];
};

type ReadCtfPayoutsInput = {
  chainId: number;
  contractAddress: string;
  conditionId: string;
  outcomeSlotCount: number;
  rpcUrls?: string[];
  rpcEndpoints?: SettlementRpcEndpoint[];
};

type CtfPositionSnapshot = {
  provider: string;
  chainId: number;
  contractAddress: string;
  collateralAddress: string;
  conditionId: string;
  outcomeIndex: number;
  collectionId: string;
  computedPositionId: string;
  blockNumber: number;
  blockHash: string;
};

export type CtfPositionQuorumRead = {
  snapshots: CtfPositionSnapshot[];
  providerEvidence: CtfProviderEvidence[];
};

export type ValidateCtfSettlementIdentityInput = {
  chainId: number;
  contractAddress: string;
  collateralAddress: string;
  conditionId: string;
  tokenId: string;
  outcomeIndex: number;
  outcomeSlotCount?: number;
};

type ReadCtfPositionIdInput = ValidateCtfSettlementIdentityInput & {
  rpcUrls?: string[];
  rpcEndpoints?: SettlementRpcEndpoint[];
};

export type CtfSettlementIdentityValidation = {
  valid: boolean;
  retryable: boolean;
  computedPositionId?: string;
  collectionId?: string;
  blockNumber?: number;
  blockHash?: string;
  providerEvidence: CtfProviderEvidence[];
  error?: string;
};

type ResolverOptions = {
  requireOnchain: boolean;
  authority?: SettlementAuthority;
  readCtfPayouts?: (input: ReadCtfPayoutsInput) => Promise<CtfPayoutQuorumRead>;
  readCtfPositionIds?: (input: ReadCtfPositionIdInput) => Promise<CtfPositionQuorumRead>;
  readPolymarketApiResolution?: (input: PolymarketApiSettlementIdentity) => Promise<PolymarketApiResolutionRead>;
  previousApiCandidate?: PolymarketApiSettlementCandidate;
  stabilityMs?: number;
  nowMs?: number;
  quorumThreshold?: number;
  signal?: AbortSignal;
};

export type PolymarketSettlementDecision =
  | {
      kind: "final";
      result: SettlementResult;
      proof: Omit<SettlementProofInput, "ticketLegId">;
    }
  | {
      kind: "observe";
      resolutionState: ResolutionState;
      result?: SettlementProofInput["result"];
      proofKind: string;
      proof?: Omit<SettlementProofInput, "ticketLegId">;
      error?: string;
      nextCheckSeconds: number;
      raw: unknown;
    };

function isPast(value?: string) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

function isHexAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isBytes32(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function safeNumber(value: bigint, label: string) {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`${label}_exceeds_safe_integer`);
  }
  return asNumber;
}

function providerLabel(index: number) {
  if (index === 0) return "primary";
  if (index === 1) return "secondary";
  return `rpc_${index + 1}`;
}

function rpcHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function rpcEndpointsFromInput(input: { rpcUrls?: string[]; rpcEndpoints?: SettlementRpcEndpoint[] }) {
  if (input.rpcEndpoints?.length) return input.rpcEndpoints;
  return buildSettlementRpcEndpoints((input.rpcUrls || []).map((url) => ({ url })));
}

function providerForEndpoint(endpoint: SettlementRpcEndpoint, index: number) {
  return {
    ...endpoint,
    provider: providerLabel(index),
    rpcHost: rpcHost(endpoint.url)
  };
}

function endpointEvidence(endpoint: ReturnType<typeof providerForEndpoint>) {
  return {
    provider: endpoint.provider,
    rpcHost: endpoint.rpcHost,
    rpcEndpointId: endpoint.endpointId,
    rpcOperator: endpoint.operator
  };
}

function createPolygonRpcClient(url: string) {
  return createPublicClient({
    chain: polygon,
    transport: http(url, {
      retryCount: 0,
      timeout: 10_000
    })
  });
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function verifyBlockHashAfterNumberRead(
  client: ReturnType<typeof createPolygonRpcClient>,
  blockNumber: number,
  expectedBlockHash: string
) {
  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  if (block.hash?.toLowerCase() !== expectedBlockHash.toLowerCase()) {
    throw new Error("ctf_block_hash_changed_after_number_read");
  }
}

export async function readCtfPayoutQuorum(input: ReadCtfPayoutsInput): Promise<CtfPayoutQuorumRead> {
  const contractAddress = input.contractAddress;
  const conditionId = input.conditionId;
  if (!isHexAddress(contractAddress)) {
    throw new Error("invalid_ctf_contract_address");
  }
  if (!isBytes32(conditionId)) {
    throw new Error("invalid_condition_id");
  }
  const endpoints = rpcEndpointsFromInput(input).map(providerForEndpoint);

  const headResults = await Promise.all(
    endpoints.map(async (endpoint) => {
      const evidenceBase = endpointEvidence(endpoint);

      try {
        const client = createPolygonRpcClient(endpoint.url);
        const chainId = await client.getChainId();
        const block = await client.getBlock({ blockTag: "finalized" });
        if (block.number === null || block.hash === null) {
          throw new Error("finalized_block_unavailable");
        }

        return {
          ok: true as const,
          ...endpoint,
          chainId,
          finalizedBlockNumber: safeNumber(block.number, "finalized_block_number"),
          finalizedBlockHash: block.hash
        };
      } catch (error) {
        const evidence: CtfProviderEvidence = {
          ...evidenceBase,
          status: "error",
          error: error instanceof Error ? error.message : "ctf_finalized_head_failed"
        };
        return { ok: false as const, evidence };
      }
    })
  );
  const providerEvidence: CtfProviderEvidence[] = headResults.map((result) =>
    result.ok
      ? {
          provider: result.provider,
          rpcHost: result.rpcHost,
          rpcEndpointId: result.endpointId,
          rpcOperator: result.operator,
          status: "ok",
          chainId: result.chainId,
          finalizedBlockNumber: result.finalizedBlockNumber,
          finalizedBlockHash: result.finalizedBlockHash
        }
      : result.evidence
  );
  const okHeads = headResults.filter((result): result is Extract<(typeof headResults)[number], { ok: true }> => result.ok);
  if (okHeads.length === 0) {
    return {
      snapshots: [],
      providerEvidence
    };
  }

  const commonBlockNumber = Math.min(...okHeads.map((result) => result.finalizedBlockNumber));
  const exactBlockResults = await Promise.all(
    okHeads.map(async (head) => {
      try {
        const client = createPolygonRpcClient(head.url);
        const block = await client.getBlock({ blockNumber: BigInt(commonBlockNumber) });
        if (block.number === null || block.hash === null) {
          throw new Error("common_block_unavailable");
        }
        return {
          ...head,
          ok: true as const,
          proofBlockNumber: safeNumber(block.number, "proof_block_number"),
          proofBlockHash: block.hash
        };
      } catch (error) {
        return {
          ok: false as const,
          provider: head.provider,
          evidence: {
            provider: head.provider,
            rpcHost: head.rpcHost,
            rpcEndpointId: head.endpointId,
            rpcOperator: head.operator,
            status: "error" as const,
            chainId: head.chainId,
            finalizedBlockNumber: head.finalizedBlockNumber,
            finalizedBlockHash: head.finalizedBlockHash,
            proofBlockNumber: commonBlockNumber,
            error: error instanceof Error ? error.message : "ctf_common_block_fetch_failed"
          }
        };
      }
    })
  );
  const okBlocks = exactBlockResults.filter((result): result is Extract<(typeof exactBlockResults)[number], { ok: true }> => result.ok);
  const firstProofHash = okBlocks[0]?.proofBlockHash;
  const hashMismatch = Boolean(firstProofHash && okBlocks.some((result) => result.proofBlockHash.toLowerCase() !== firstProofHash.toLowerCase()));
  if (!firstProofHash || hashMismatch) {
    return {
      snapshots: [],
      providerEvidence: exactBlockResults.map((result) =>
        result.ok
          ? {
              provider: result.provider,
              rpcHost: result.rpcHost,
              rpcEndpointId: result.endpointId,
              rpcOperator: result.operator,
              status: hashMismatch ? "error" : "ok",
              chainId: result.chainId,
              finalizedBlockNumber: result.finalizedBlockNumber,
              finalizedBlockHash: result.finalizedBlockHash,
              proofBlockNumber: result.proofBlockNumber,
              proofBlockHash: result.proofBlockHash,
              blockNumber: result.proofBlockNumber,
              blockHash: result.proofBlockHash,
              error: hashMismatch ? "ctf_common_block_hash_mismatch" : undefined
            }
          : result.evidence
      )
    };
  }

  const readResults = await Promise.all(
    okBlocks.map(async (block) => {
      const evidenceBase = {
        provider: block.provider,
        rpcHost: block.rpcHost,
        rpcEndpointId: block.endpointId,
        rpcOperator: block.operator,
        chainId: block.chainId,
        finalizedBlockNumber: block.finalizedBlockNumber,
        finalizedBlockHash: block.finalizedBlockHash,
        proofBlockNumber: block.proofBlockNumber,
        proofBlockHash: block.proofBlockHash,
        blockNumber: block.proofBlockNumber,
        blockHash: block.proofBlockHash
      };

      try {
        const client = createPolygonRpcClient(block.url);
        let readMode: CtfProviderEvidence["readMode"] = "blockHash";
        let blockHashReadSupported = true;
        let blockHashReverified: boolean | undefined;
        let blockHashReadError: string | undefined;
        let payoutDenominator: string;
        let payoutNumerators: string[];
        try {
          payoutDenominator = (
            await client.readContract({
              address: contractAddress,
              abi: conditionalTokensAbi,
              functionName: "payoutDenominator",
              args: [conditionId],
              blockHash: block.proofBlockHash as Hex,
              requireCanonical: true
            })
          ).toString();
          payoutNumerators = await Promise.all(
            Array.from({ length: input.outcomeSlotCount }, async (_, outcomeIndex) =>
              (
                await client.readContract({
                  address: contractAddress,
                  abi: conditionalTokensAbi,
                  functionName: "payoutNumerators",
                  args: [conditionId, BigInt(outcomeIndex)],
                  blockHash: block.proofBlockHash as Hex,
                  requireCanonical: true
                })
              ).toString()
            )
          );
        } catch (error) {
          blockHashReadError = errorMessage(error, "ctf_block_hash_read_failed");
          readMode = "blockNumber_reverified";
          blockHashReadSupported = false;
          const blockNumber = BigInt(block.proofBlockNumber);
          payoutDenominator = (
            await client.readContract({
              address: contractAddress,
              abi: conditionalTokensAbi,
              functionName: "payoutDenominator",
              args: [conditionId],
              blockNumber
            })
          ).toString();
          payoutNumerators = await Promise.all(
            Array.from({ length: input.outcomeSlotCount }, async (_, outcomeIndex) =>
              (
                await client.readContract({
                  address: contractAddress,
                  abi: conditionalTokensAbi,
                  functionName: "payoutNumerators",
                  args: [conditionId, BigInt(outcomeIndex)],
                  blockNumber
                })
              ).toString()
            )
          );
          await verifyBlockHashAfterNumberRead(client, block.proofBlockNumber, block.proofBlockHash);
          blockHashReverified = true;
        }
        const snapshot: CtfPayoutSnapshot = {
          provider: block.provider,
          chainId: block.chainId,
          contractAddress,
          conditionId,
          payoutDenominator,
          payoutNumerators,
          blockNumber: block.proofBlockNumber,
          blockHash: block.proofBlockHash
        };
        const evidence: CtfProviderEvidence = {
          ...evidenceBase,
          status: "ok",
          readMode,
          blockHashReadSupported,
          blockHashReverified,
          blockHashReadError,
          payoutDenominator,
          payoutNumerators
        };
        return { snapshot, evidence };
      } catch (error) {
        const evidence: CtfProviderEvidence = {
          ...evidenceBase,
          status: "error",
          error: error instanceof Error ? error.message : "ctf_common_block_read_failed"
        };
        return { evidence };
      }
    })
  );
  const nonReadEvidence = [
    ...headResults.flatMap((result) => (result.ok ? [] : [result.evidence])),
    ...exactBlockResults.flatMap((result) => (result.ok ? [] : [result.evidence]))
  ];

  return {
    snapshots: readResults.flatMap((result) => ("snapshot" in result && result.snapshot ? [result.snapshot] : [])) as CtfPayoutSnapshot[],
    providerEvidence: [...nonReadEvidence, ...readResults.map((result) => result.evidence)]
  };
}

const zeroCollectionId = `0x${"00".repeat(32)}` as Hex;

export async function readCtfPositionIdQuorum(input: ReadCtfPositionIdInput): Promise<CtfPositionQuorumRead> {
  if (!isHexAddress(input.contractAddress)) {
    throw new Error("invalid_ctf_contract_address");
  }
  if (!isHexAddress(input.collateralAddress)) {
    throw new Error("invalid_ctf_collateral_address");
  }
  if (!isBytes32(input.conditionId)) {
    throw new Error("invalid_condition_id");
  }
  const contractAddress = input.contractAddress as Address;
  const collateralAddress = input.collateralAddress as Address;
  const conditionId = input.conditionId as Hex;
  const endpoints = rpcEndpointsFromInput(input).map(providerForEndpoint);

  const headResults = await Promise.all(
    endpoints.map(async (endpoint) => {
      const evidenceBase = endpointEvidence(endpoint);
      try {
        const client = createPolygonRpcClient(endpoint.url);
        const chainId = await client.getChainId();
        const block = await client.getBlock({ blockTag: "finalized" });
        if (block.number === null || block.hash === null) {
          throw new Error("finalized_block_unavailable");
        }
        return {
          ok: true as const,
          ...endpoint,
          chainId,
          finalizedBlockNumber: safeNumber(block.number, "finalized_block_number"),
          finalizedBlockHash: block.hash
        };
      } catch (error) {
        return {
          ok: false as const,
          evidence: {
            ...evidenceBase,
            status: "error" as const,
            error: error instanceof Error ? error.message : "ctf_finalized_head_failed"
          }
        };
      }
    })
  );
  const okHeads = headResults.filter((result): result is Extract<(typeof headResults)[number], { ok: true }> => result.ok);
  if (okHeads.length === 0) {
    return {
      snapshots: [],
      providerEvidence: headResults.map((result) =>
        result.ok
          ? {
              provider: result.provider,
              rpcHost: result.rpcHost,
              rpcEndpointId: result.endpointId,
              rpcOperator: result.operator,
              status: "ok",
              chainId: result.chainId,
              finalizedBlockNumber: result.finalizedBlockNumber,
              finalizedBlockHash: result.finalizedBlockHash
            }
          : result.evidence
      )
    };
  }

  const proofBlockNumber = Math.min(...okHeads.map((result) => result.finalizedBlockNumber));
  const exactBlockResults = await Promise.all(
    okHeads.map(async (head) => {
      try {
        const client = createPolygonRpcClient(head.url);
        const block = await client.getBlock({ blockNumber: BigInt(proofBlockNumber) });
        if (block.number === null || block.hash === null) {
          throw new Error("common_block_unavailable");
        }
        return {
          ...head,
          ok: true as const,
          proofBlockNumber: safeNumber(block.number, "proof_block_number"),
          proofBlockHash: block.hash
        };
      } catch (error) {
        return {
          ok: false as const,
          evidence: {
            provider: head.provider,
            rpcHost: head.rpcHost,
            rpcEndpointId: head.endpointId,
            rpcOperator: head.operator,
            status: "error" as const,
            chainId: head.chainId,
            finalizedBlockNumber: head.finalizedBlockNumber,
            finalizedBlockHash: head.finalizedBlockHash,
            proofBlockNumber,
            error: error instanceof Error ? error.message : "ctf_common_block_fetch_failed"
          }
        };
      }
    })
  );
  const okBlocks = exactBlockResults.filter((result): result is Extract<(typeof exactBlockResults)[number], { ok: true }> => result.ok);
  const proofBlockHash = okBlocks[0]?.proofBlockHash;
  const hashMismatch = Boolean(proofBlockHash && okBlocks.some((result) => result.proofBlockHash.toLowerCase() !== proofBlockHash.toLowerCase()));
  if (!proofBlockHash || hashMismatch) {
    return {
      snapshots: [],
      providerEvidence: exactBlockResults.map((result) =>
        result.ok
          ? {
              provider: result.provider,
              rpcHost: result.rpcHost,
              rpcEndpointId: result.endpointId,
              rpcOperator: result.operator,
              status: hashMismatch ? "error" : "ok",
              chainId: result.chainId,
              finalizedBlockNumber: result.finalizedBlockNumber,
              finalizedBlockHash: result.finalizedBlockHash,
              proofBlockNumber: result.proofBlockNumber,
              proofBlockHash: result.proofBlockHash,
              blockNumber: result.proofBlockNumber,
              blockHash: result.proofBlockHash,
              error: hashMismatch ? "ctf_common_block_hash_mismatch" : undefined
            }
          : result.evidence
      )
    };
  }

  const readResults = await Promise.all(
    okBlocks.map(async (block) => {
      const evidenceBase = {
        provider: block.provider,
        rpcHost: block.rpcHost,
        rpcEndpointId: block.endpointId,
        rpcOperator: block.operator,
        chainId: block.chainId,
        finalizedBlockNumber: block.finalizedBlockNumber,
        finalizedBlockHash: block.finalizedBlockHash,
        proofBlockNumber: block.proofBlockNumber,
        proofBlockHash: block.proofBlockHash,
        blockNumber: block.proofBlockNumber,
        blockHash: block.proofBlockHash
      };
      try {
        const client = createPolygonRpcClient(block.url);
        const indexSet = 1n << BigInt(input.outcomeIndex);
        let readMode: CtfProviderEvidence["readMode"] = "blockHash";
        let blockHashReadSupported = true;
        let blockHashReverified: boolean | undefined;
        let blockHashReadError: string | undefined;
        let collectionId: Hex;
        let computedPositionId: string;
        try {
          collectionId = await client.readContract({
            address: contractAddress,
            abi: conditionalTokensAbi,
            functionName: "getCollectionId",
            args: [zeroCollectionId, conditionId, indexSet],
            blockHash: block.proofBlockHash as Hex,
            requireCanonical: true
          });
          computedPositionId = (
            await client.readContract({
              address: contractAddress,
              abi: conditionalTokensAbi,
              functionName: "getPositionId",
              args: [collateralAddress, collectionId],
              blockHash: block.proofBlockHash as Hex,
              requireCanonical: true
            })
          ).toString();
        } catch (error) {
          blockHashReadError = errorMessage(error, "ctf_block_hash_read_failed");
          readMode = "blockNumber_reverified";
          blockHashReadSupported = false;
          const blockNumber = BigInt(block.proofBlockNumber);
          collectionId = await client.readContract({
            address: contractAddress,
            abi: conditionalTokensAbi,
            functionName: "getCollectionId",
            args: [zeroCollectionId, conditionId, indexSet],
            blockNumber
          });
          computedPositionId = (
            await client.readContract({
              address: contractAddress,
              abi: conditionalTokensAbi,
              functionName: "getPositionId",
              args: [collateralAddress, collectionId],
              blockNumber
            })
          ).toString();
          await verifyBlockHashAfterNumberRead(client, block.proofBlockNumber, block.proofBlockHash);
          blockHashReverified = true;
        }
        const snapshot: CtfPositionSnapshot = {
          provider: block.provider,
          chainId: block.chainId,
          contractAddress,
          collateralAddress,
          conditionId,
          outcomeIndex: input.outcomeIndex,
          collectionId,
          computedPositionId,
          blockNumber: block.proofBlockNumber,
          blockHash: block.proofBlockHash
        };
        const evidence: CtfProviderEvidence = {
          ...evidenceBase,
          status: "ok",
          readMode,
          blockHashReadSupported,
          blockHashReverified,
          blockHashReadError,
          collectionId,
          computedPositionId
        };
        return { snapshot, evidence };
      } catch (error) {
        const evidence: CtfProviderEvidence = {
          ...evidenceBase,
          status: "error",
          error: error instanceof Error ? error.message : "ctf_position_read_failed"
        };
        return { evidence };
      }
    })
  );
  const nonReadEvidence = [
    ...headResults.flatMap((result) => (result.ok ? [] : [result.evidence])),
    ...exactBlockResults.flatMap((result) => (result.ok ? [] : [result.evidence]))
  ];

  return {
    snapshots: readResults.flatMap((result) => ("snapshot" in result && result.snapshot ? [result.snapshot] : [])) as CtfPositionSnapshot[],
    providerEvidence: [...nonReadEvidence, ...readResults.map((result) => result.evidence)]
  };
}

function samePayoutSnapshot(left: CtfPayoutSnapshot, right: CtfPayoutSnapshot) {
  return (
    left.chainId === right.chainId &&
    left.contractAddress.toLowerCase() === right.contractAddress.toLowerCase() &&
    left.conditionId.toLowerCase() === right.conditionId.toLowerCase() &&
    left.blockNumber === right.blockNumber &&
    left.blockHash.toLowerCase() === right.blockHash.toLowerCase() &&
    left.payoutDenominator === right.payoutDenominator &&
    left.payoutNumerators.length === right.payoutNumerators.length &&
    left.payoutNumerators.every((value, index) => value === right.payoutNumerators[index])
  );
}

function samePositionSnapshot(left: CtfPositionSnapshot, right: CtfPositionSnapshot) {
  return (
    left.chainId === right.chainId &&
    left.contractAddress.toLowerCase() === right.contractAddress.toLowerCase() &&
    left.collateralAddress.toLowerCase() === right.collateralAddress.toLowerCase() &&
    left.conditionId.toLowerCase() === right.conditionId.toLowerCase() &&
    left.outcomeIndex === right.outcomeIndex &&
    left.collectionId.toLowerCase() === right.collectionId.toLowerCase() &&
    left.computedPositionId === right.computedPositionId &&
    left.blockNumber === right.blockNumber &&
    left.blockHash.toLowerCase() === right.blockHash.toLowerCase()
  );
}

export async function validateCtfSettlementIdentity(
  input: ValidateCtfSettlementIdentityInput,
  options: Pick<ResolverOptions, "readCtfPositionIds" | "quorumThreshold"> = {}
): Promise<CtfSettlementIdentityValidation> {
  if (input.chainId !== 137) {
    return {
      valid: false,
      retryable: false,
      providerEvidence: [],
      error: "ctf_identity_requires_polygon_chain_137"
    };
  }
  if (!isHexAddress(input.contractAddress) || !isHexAddress(input.collateralAddress) || !isBytes32(input.conditionId)) {
    return {
      valid: false,
      retryable: false,
      providerEvidence: [],
      error: "ctf_identity_invalid_address_or_condition"
    };
  }
  const outcomeSlotCount = input.outcomeSlotCount || 2;
  if (input.outcomeIndex < 0 || input.outcomeIndex >= outcomeSlotCount) {
    return {
      valid: false,
      retryable: false,
      providerEvidence: [],
      error: "ctf_identity_outcome_index_out_of_range"
    };
  }

  try {
    BigInt(input.tokenId);
  } catch {
    return {
      valid: false,
      retryable: false,
      providerEvidence: [],
      error: "ctf_identity_token_id_not_uint"
    };
  }

  const rpcEndpoints = config.POLYGON_RPC_ENDPOINTS;
  if (!options.readCtfPositionIds && rpcEndpoints.length === 0) {
    return {
      valid: false,
      retryable: true,
      providerEvidence: [],
      error: "ctf_position_rpc_unconfigured"
    };
  }

  const read = await (options.readCtfPositionIds || readCtfPositionIdQuorum)({
    ...input,
    outcomeSlotCount,
    rpcEndpoints
  });
  const quorumThreshold = options.quorumThreshold || config.SETTLEMENT_RPC_QUORUM;
  const validSnapshots = read.snapshots.filter((snapshot) => snapshot.chainId === input.chainId);
  if (validSnapshots.length < quorumThreshold) {
    return {
      valid: false,
      retryable: true,
      providerEvidence: read.providerEvidence,
      error: "ctf_position_quorum_unavailable"
    };
  }

  const [primarySnapshot, ...remainingSnapshots] = validSnapshots;
  if (remainingSnapshots.some((snapshot) => !samePositionSnapshot(primarySnapshot, snapshot))) {
    return {
      valid: false,
      retryable: true,
      providerEvidence: read.providerEvidence,
      error: "ctf_position_quorum_disagreement"
    };
  }

  const expectedTokenId = primarySnapshot.computedPositionId;
  const actualTokenId = BigInt(input.tokenId).toString();
  if (expectedTokenId !== actualTokenId) {
    return {
      valid: false,
      retryable: false,
      computedPositionId: expectedTokenId,
      collectionId: primarySnapshot.collectionId,
      blockNumber: primarySnapshot.blockNumber,
      blockHash: primarySnapshot.blockHash,
      providerEvidence: read.providerEvidence,
      error: "ctf_position_id_mismatch"
    };
  }

  return {
    valid: true,
    retryable: false,
    computedPositionId: expectedTokenId,
    collectionId: primarySnapshot.collectionId,
    blockNumber: primarySnapshot.blockNumber,
    blockHash: primarySnapshot.blockHash,
    providerEvidence: read.providerEvidence
  };
}

function observe(input: {
  source?: string;
  resolutionState: ResolutionState;
  result?: SettlementProofInput["result"];
  proofKind: string;
  confidence?: SettlementProofInput["confidence"];
  chainId?: number;
  contractAddress?: string;
  collateralAddress?: string;
  conditionId?: string;
  tokenId?: string;
  outcomeIndex?: number;
  winningTokenId?: string;
  payoutNumerator?: string;
  payoutDenominator?: string;
  payoutVector?: string[];
  blockNumber?: number;
  blockHash?: string;
  resolvedAt?: string;
  providerEvidence?: unknown;
  nextCheckSeconds: number;
  error?: string;
  raw: unknown;
}): PolymarketSettlementDecision {
  return {
    kind: "observe",
    resolutionState: input.resolutionState,
    result: input.result,
    proofKind: input.proofKind,
    proof: {
      source: input.source || POLYMARKET_CTF_SOURCE,
      proofKind: input.proofKind,
      result: input.result || "pending",
      confidence: input.confidence || "api_signal",
      chainId: input.chainId,
      contractAddress: input.contractAddress,
      collateralAddress: input.collateralAddress,
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      outcomeIndex: input.outcomeIndex,
      winningTokenId: input.winningTokenId,
      payoutNumerator: input.payoutNumerator,
      payoutDenominator: input.payoutDenominator,
      payoutVector: input.payoutVector,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      resolvedAt: input.resolvedAt,
      providerEvidence: input.providerEvidence,
      raw: input.raw
    },
    error: input.error,
    nextCheckSeconds: input.nextCheckSeconds,
    raw: input.raw
  };
}

function classifyPayout(snapshot: CtfPayoutSnapshot, outcomeIndex: number): { result: SettlementResult; proofKind: string } {
  const denominator = BigInt(snapshot.payoutDenominator);
  const vector = snapshot.payoutNumerators.map((value) => BigInt(value));

  if (denominator <= 0n) {
    throw new Error("payout_not_resolved");
  }

  if (outcomeIndex < 0 || outcomeIndex >= vector.length) {
    throw new Error("settlement_outcome_index_out_of_range");
  }

  const hasPartialPayout = vector.some((numerator) => numerator !== 0n && numerator !== denominator);
  const fullWinnerIndexes = vector.flatMap((numerator, index) => (numerator === denominator ? [index] : []));
  if (hasPartialPayout || fullWinnerIndexes.length !== 1) {
    return {
      result: "voided",
      proofKind: "ctf_partial_or_canceled_payout"
    };
  }

  return {
    result: fullWinnerIndexes[0] === outcomeIndex ? "won" : "lost",
    proofKind: "ctf_payout_vector"
  };
}

async function resolvePolymarketApiLeg(
  input: {
    identity: PolymarketApiSettlementIdentity;
    endDate?: string;
    chainId: number;
    contractAddress: string;
    collateralAddress: string;
  },
  options: ResolverOptions
): Promise<PolymarketSettlementDecision> {
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const stabilityMs = options.stabilityMs ?? config.SETTLEMENT_API_STABILITY_MS;
  const read = await (options.readPolymarketApiResolution || readPolymarketApiResolution)(input.identity);
  const common = {
    source: POLYMARKET_API_SOURCE,
    chainId: input.chainId,
    contractAddress: input.contractAddress,
    collateralAddress: input.collateralAddress,
    conditionId: input.identity.conditionId,
    tokenId: input.identity.tokenId,
    outcomeIndex: input.identity.outcomeIndex,
    providerEvidence: read.providerEvidence
  };
  const rawBase = {
    authority: "polymarket_api",
    settlementIdentity: input.identity,
    providerEvidence: read.providerEvidence,
    identityFingerprint: read.identityFingerprint
  };

  if (read.status === "unavailable") {
    return observe({
      ...common,
      resolutionState: isPast(input.endDate) ? "awaiting_oracle" : "pending",
      result: "pending",
      proofKind: "polymarket_api_unavailable",
      nextCheckSeconds: 60,
      error: read.error || "polymarket_api_unavailable",
      raw: rawBase
    });
  }
  if (read.status === "identity_invalid") {
    return observe({
      ...common,
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "polymarket_api_identity_invalid",
      nextCheckSeconds: 3600,
      error: read.error || "polymarket_api_identity_invalid",
      raw: rawBase
    });
  }
  if (read.status === "disagreement") {
    return observe({
      ...common,
      resolutionState: "disputed",
      result: "disputed",
      proofKind: "polymarket_api_disagreement",
      nextCheckSeconds: 300,
      error: read.error || "polymarket_api_disagreement",
      raw: rawBase
    });
  }
  if (read.status === "pending") {
    return observe({
      ...common,
      resolutionState: isPast(input.endDate) ? "awaiting_oracle" : "pending",
      result: "pending",
      proofKind: "polymarket_api_not_terminal",
      nextCheckSeconds: isPast(input.endDate) ? 60 : 3600,
      raw: rawBase
    });
  }

  const candidate = read as Extract<PolymarketApiResolutionRead, { status: "candidate" }>;
  const previous = options.previousApiCandidate;
  const previousMatches = Boolean(
    previous &&
    previous.fingerprint === candidate.fingerprint &&
    previous.result === candidate.result &&
    Number.isFinite(Date.parse(previous.firstObservedAt))
  );
  const firstObservedAt = previousMatches ? previous!.firstObservedAt : now.toISOString();
  const stableForMs = Math.max(0, nowMs - Date.parse(firstObservedAt));
  const candidateRaw = {
    ...rawBase,
    fingerprint: candidate.fingerprint,
    firstObservedAt,
    terminalProofKind: candidate.proofKind,
    result: candidate.result,
    payoutNumerator: candidate.payoutNumerator,
    payoutDenominator: candidate.payoutDenominator,
    payoutVector: candidate.payoutVector,
    winningTokenId: candidate.winningTokenId,
    resolvedAt: candidate.resolvedAt
  };

  if (!previousMatches || stableForMs < stabilityMs) {
    return observe({
      ...common,
      resolutionState: "resolution_candidate",
      result: candidate.result,
      proofKind: "polymarket_api_resolution_candidate",
      winningTokenId: candidate.winningTokenId,
      payoutNumerator: candidate.payoutNumerator,
      payoutDenominator: candidate.payoutDenominator,
      payoutVector: candidate.payoutVector,
      resolvedAt: candidate.resolvedAt,
      nextCheckSeconds: Math.max(30, Math.ceil((stabilityMs - stableForMs) / 1000)),
      raw: candidateRaw
    });
  }

  return {
    kind: "final",
    result: candidate.result,
    proof: {
      source: POLYMARKET_API_SOURCE,
      proofKind: candidate.proofKind,
      result: candidate.result,
      confidence: "api_signal",
      chainId: input.chainId,
      contractAddress: input.contractAddress,
      collateralAddress: input.collateralAddress,
      conditionId: input.identity.conditionId,
      tokenId: input.identity.tokenId,
      outcomeIndex: input.identity.outcomeIndex,
      winningTokenId: candidate.winningTokenId,
      payoutNumerator: candidate.payoutNumerator,
      payoutDenominator: candidate.payoutDenominator,
      payoutVector: candidate.payoutVector,
      resolvedAt: candidate.resolvedAt,
      providerEvidence: read.providerEvidence,
      raw: {
        ...candidateRaw,
        candidateProofId: previous!.proofId,
        confirmedAt: now.toISOString(),
        stableForMs
      }
    }
  };
}

export async function resolvePolymarketLeg(
  leg: Pick<
    PendingSettlementLeg,
    | "conditionId"
    | "tokenId"
    | "outcome"
    | "endDate"
    | "negRisk"
    | "settlementAuthority"
    | "settlementChainId"
    | "settlementContractAddress"
    | "settlementCollateralAddress"
    | "settlementConditionId"
    | "settlementTokenId"
    | "settlementOutcomeIndex"
    | "settlementPayoutSlotCount"
    | "settlementSourceMarketId"
    | "settlementOutcome"
    | "settlementNegRisk"
  >,
  options: ResolverOptions
): Promise<PolymarketSettlementDecision> {
  const chainId = leg.settlementChainId || config.POLYGON_SETTLEMENT_CHAIN_ID;
  const contractAddress = leg.settlementContractAddress || config.POLYMARKET_CTF_ADDRESS;
  const collateralAddress = leg.settlementCollateralAddress || config.POLYMARKET_COLLATERAL_ADDRESS;
  const conditionId = leg.settlementConditionId || leg.conditionId;
  const tokenId = leg.settlementTokenId || leg.tokenId;
  const outcomeIndex = leg.settlementOutcomeIndex;
  const outcomeSlotCount = leg.settlementPayoutSlotCount || 2;
  const authority = leg.settlementAuthority || options.authority || (options.requireOnchain ? "polygon_ctf" : config.SETTLEMENT_AUTHORITY);

  if (authority === "polymarket_api") {
    const sourceMarketId = leg.settlementSourceMarketId;
    const outcome = leg.settlementOutcome || leg.outcome;
    if (
      chainId !== 137 ||
      !conditionId ||
      !isBytes32(conditionId) ||
      !tokenId ||
      !sourceMarketId ||
      !outcome ||
      outcomeIndex === undefined ||
      outcomeIndex === null ||
      outcomeIndex < 0 ||
      outcomeIndex >= outcomeSlotCount
    ) {
      return observe({
        source: POLYMARKET_API_SOURCE,
        resolutionState: "settlement_blocked",
        result: "blocked",
        proofKind: "polymarket_api_identity_incomplete",
        chainId,
        contractAddress,
        collateralAddress,
        conditionId,
        tokenId,
        outcomeIndex,
        nextCheckSeconds: 3600,
        error: "polymarket_api_frozen_identity_incomplete",
        raw: {
          authority,
          sourceMarketId,
          conditionId,
          tokenId,
          outcome,
          outcomeIndex,
          outcomeSlotCount
        }
      });
    }
    return resolvePolymarketApiLeg(
      {
        identity: {
          sourceMarketId,
          conditionId,
          tokenId,
          outcome,
          outcomeIndex,
          outcomeSlotCount,
          negRisk: leg.settlementNegRisk ?? leg.negRisk
        },
        endDate: leg.endDate,
        chainId,
        contractAddress,
        collateralAddress
      },
      options
    );
  }

  const rawBase = {
    sourceHint: {
      status: "not_used_for_settlement",
      reason: "settlement_uses_frozen_identity_and_polygon_ctf_only"
    },
    settlementIdentity: {
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      outcomeSlotCount,
      negRisk: leg.negRisk
    }
  };

  if (chainId !== 137) {
    return observe({
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_invalid_chain",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      nextCheckSeconds: 3600,
      error: "polymarket_ctf_settlement_requires_polygon_chain_137",
      raw: rawBase
    });
  }

  if (!conditionId || !tokenId || outcomeIndex === undefined || outcomeIndex === null) {
    return observe({
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "settlement_identity_not_frozen",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      nextCheckSeconds: 3600,
      error: "condition_token_or_outcome_index_missing",
      raw: rawBase
    });
  }

  if (!isBytes32(conditionId)) {
    return observe({
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_invalid_condition_id",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      nextCheckSeconds: 3600,
      error: "condition_id_must_be_bytes32",
      raw: rawBase
    });
  }

  if (!isHexAddress(contractAddress)) {
    return observe({
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_invalid_contract_address",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      nextCheckSeconds: 3600,
      error: "ctf_contract_address_invalid",
      raw: rawBase
    });
  }

  if (outcomeIndex < 0 || outcomeIndex >= outcomeSlotCount) {
    return observe({
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_invalid_outcome_index",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      nextCheckSeconds: 3600,
      error: "outcome_index_out_of_range",
      raw: rawBase
    });
  }

  const rpcEndpoints = config.POLYGON_RPC_ENDPOINTS;
  if (!options.readCtfPayouts && rpcEndpoints.length === 0) {
    return observe({
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_rpc_unconfigured",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      nextCheckSeconds: 3600,
      error: options.requireOnchain ? "polygon_rpc_url_required" : "polygon_rpc_url_missing",
      raw: rawBase
    });
  }

  const read = await (options.readCtfPayouts || readCtfPayoutQuorum)({
    chainId,
    contractAddress,
    conditionId,
    outcomeSlotCount,
    rpcEndpoints
  });
  const providerEvidence = read.providerEvidence;
  const validSnapshots = read.snapshots.filter((snapshot) => snapshot.chainId === chainId);
  const quorumThreshold = options.quorumThreshold || config.SETTLEMENT_RPC_QUORUM;
  const raw = {
    ...rawBase,
    providerEvidence,
    snapshots: validSnapshots
  };

  if (validSnapshots.length < quorumThreshold) {
    return observe({
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_rpc_quorum_unavailable",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      providerEvidence,
      nextCheckSeconds: 300,
      error: "ctf_rpc_quorum_unavailable",
      raw
    });
  }

  const [primarySnapshot, ...remainingSnapshots] = validSnapshots;
  if (remainingSnapshots.some((snapshot) => !samePayoutSnapshot(primarySnapshot, snapshot))) {
    return observe({
      resolutionState: "disputed",
      result: "disputed",
      proofKind: "ctf_rpc_quorum_disagreement",
      confidence: "onchain_confirmed",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      providerEvidence,
      nextCheckSeconds: 300,
      error: "ctf_rpc_quorum_disagreement",
      raw
    });
  }

  if (BigInt(primarySnapshot.payoutDenominator) === 0n) {
    return observe({
      resolutionState: isPast(leg.endDate) ? "awaiting_oracle" : "pending",
      result: "pending",
      proofKind: "ctf_unresolved",
      confidence: "onchain_confirmed",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      payoutNumerator: primarySnapshot.payoutNumerators[outcomeIndex],
      payoutDenominator: primarySnapshot.payoutDenominator,
      payoutVector: primarySnapshot.payoutNumerators,
      blockNumber: primarySnapshot.blockNumber,
      blockHash: primarySnapshot.blockHash,
      providerEvidence,
      nextCheckSeconds: isPast(leg.endDate) ? 300 : 3600,
      raw
    });
  }

  let payout;
  try {
    payout = classifyPayout(primarySnapshot, outcomeIndex);
  } catch (error) {
    return observe({
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_payout_vector_invalid",
      confidence: "onchain_confirmed",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      payoutNumerator: primarySnapshot.payoutNumerators[outcomeIndex],
      payoutDenominator: primarySnapshot.payoutDenominator,
      payoutVector: primarySnapshot.payoutNumerators,
      blockNumber: primarySnapshot.blockNumber,
      blockHash: primarySnapshot.blockHash,
      providerEvidence,
      nextCheckSeconds: 300,
      error: error instanceof Error ? error.message : "ctf_payout_vector_invalid",
      raw
    });
  }

  return {
    kind: "final",
    result: payout.result,
    proof: {
      source: POLYMARKET_CTF_SOURCE,
      proofKind: payout.proofKind,
      result: payout.result,
      confidence: "onchain_confirmed",
      chainId,
      contractAddress,
      collateralAddress,
      conditionId,
      tokenId,
      outcomeIndex,
      payoutNumerator: primarySnapshot.payoutNumerators[outcomeIndex],
      payoutDenominator: primarySnapshot.payoutDenominator,
      payoutVector: primarySnapshot.payoutNumerators,
      blockNumber: primarySnapshot.blockNumber,
      blockHash: primarySnapshot.blockHash,
      providerEvidence,
      resolvedAt: new Date().toISOString(),
      raw
    }
  };
}
