import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { readCtfPayoutQuorum, resolvePolymarketLeg } from "../resolvers/polymarketSettlementResolver";

const conditionId = `0x${"11".repeat(32)}`;
const contractAddress = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const collateralAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const sharedBlockHash = `0x${"ab".repeat(32)}`;
const divergentBlockHash = `0x${"cd".repeat(32)}`;

type ProviderScenario = {
  chainId?: number;
  finalizedBlockNumber?: number;
  finalizedBlockHash?: string;
  proofBlockHash?: string;
  outage?: boolean;
  rejectBlockHashReads?: boolean;
};

function rpcBlock(number: number, hash: string) {
  return {
    number: `0x${number.toString(16)}`,
    hash,
    parentHash: `0x${"00".repeat(32)}`,
    nonce: "0x0000000000000000",
    sha3Uncles: `0x${"00".repeat(32)}`,
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: `0x${"00".repeat(32)}`,
    stateRoot: `0x${"00".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    miner: "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x0",
    gasUsed: "0x0",
    timestamp: "0x0",
    transactions: [],
    uncles: [],
    mixHash: `0x${"00".repeat(32)}`,
    baseFeePerGas: "0x0"
  };
}

function rpcResult(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, message: string) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

async function startRpcServer(scenarios: Record<string, ProviderScenario>) {
  const server = createServer(async (request, response) => {
    const body = await new Promise<string>((resolve, reject) => {
      let value = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        value += chunk;
      });
      request.on("end", () => resolve(value));
      request.on("error", reject);
    });
    const payload = JSON.parse(body) as { id: unknown; method: string; params?: unknown[] };
    const scenario = scenarios[request.url || ""];
    const fail = (message: string) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(rpcError(payload.id, message));
    };

    if (!scenario || scenario.outage) {
      fail("provider unavailable");
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    if (payload.method === "eth_chainId") {
      response.end(rpcResult(payload.id, `0x${(scenario.chainId ?? 137).toString(16)}`));
      return;
    }
    if (payload.method === "eth_getBlockByNumber") {
      const requestedBlock = payload.params?.[0];
      const blockNumber = requestedBlock === "finalized"
        ? (scenario.finalizedBlockNumber ?? 100)
        : Number.parseInt(String(requestedBlock), 16);
      const blockHash = requestedBlock === "finalized"
        ? (scenario.finalizedBlockHash ?? sharedBlockHash)
        : (scenario.proofBlockHash ?? sharedBlockHash);
      response.end(rpcResult(payload.id, rpcBlock(blockNumber, blockHash)));
      return;
    }
    if (payload.method === "eth_call") {
      const blockReference = payload.params?.[1];
      if (scenario.rejectBlockHashReads && typeof blockReference === "object" && blockReference !== null && "blockHash" in blockReference) {
        response.end(rpcError(payload.id, "block hash reads unsupported"));
        return;
      }
      response.end(rpcResult(payload.id, `0x${"0".repeat(63)}1`));
      return;
    }

    fail(`unexpected method ${payload.method}`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("rpc_test_server_address_unavailable");
  }

  return {
    server,
    urls: Object.keys(scenarios).map((path) => `http://127.0.0.1:${address.port}${path}`)
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const leg = {
  conditionId,
  tokenId: "yes-token",
  outcome: "Yes",
  endDate: "2026-07-20T00:00:00Z",
  negRisk: false,
  settlementChainId: 137,
  settlementContractAddress: contractAddress,
  settlementCollateralAddress: collateralAddress,
  settlementConditionId: conditionId,
  settlementTokenId: "yes-token",
  settlementOutcomeIndex: 0,
  settlementPayoutSlotCount: 2
};

async function readFrom(urls: string[]) {
  return readCtfPayoutQuorum({
    chainId: 137,
    contractAddress,
    conditionId,
    outcomeSlotCount: 2,
    rpcEndpoints: testEndpoints(urls)
  });
}

async function resolveFrom(urls: string[]) {
  return resolvePolymarketLeg(leg, {
    requireOnchain: true,
    quorumThreshold: 2,
    readCtfPayouts: (input) => readCtfPayoutQuorum({ ...input, rpcEndpoints: testEndpoints(urls) })
  });
}

function testEndpoints(urls: string[]) {
  return urls.map((url, index) => ({
    url,
    normalizedUrl: url,
    endpointId: `test-rpc-${index + 1}`,
    operator: `test-operator-${index + 1}`
  }));
}

describe("Polymarket CTF RPC payout reader", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
  });

  async function rpc(scenarios: Record<string, ProviderScenario>) {
    const fixture = await startRpcServer(scenarios);
    servers.push(fixture.server);
    return fixture.urls;
  }

  it("fails closed with bounded outage evidence and cannot finalize", async () => {
    const urls = await rpc({ "/primary": { outage: true }, "/secondary": { outage: true } });

    const read = await readFrom(urls);
    const decision = await resolveFrom(urls);

    expect(read.snapshots).toEqual([]);
    expect(read.providerEvidence).toHaveLength(2);
    expect(read.providerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "primary", status: "error", error: expect.stringContaining("provider unavailable") }),
        expect.objectContaining({ provider: "secondary", status: "error", error: expect.stringContaining("provider unavailable") })
      ])
    );
    expect(read.providerEvidence).not.toEqual(expect.arrayContaining([expect.objectContaining({ rpcUrl: expect.anything() })]));
    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_rpc_quorum_unavailable"
    });
  });

  it("keeps a one-provider payout read below quorum and non-final", async () => {
    const urls = await rpc({ "/primary": {}, "/secondary": { outage: true } });

    const read = await readFrom(urls);
    const decision = await resolveFrom(urls);

    expect(read.snapshots).toHaveLength(1);
    expect(read.snapshots[0]).toMatchObject({ provider: "primary", chainId: 137, blockHash: sharedBlockHash });
    expect(read.providerEvidence).toHaveLength(2);
    expect(read.providerEvidence.filter((evidence) => evidence.status === "ok")).toHaveLength(1);
    expect(read.providerEvidence.filter((evidence) => evidence.status === "error")).toHaveLength(1);
    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_rpc_quorum_unavailable"
    });
  });

  it("filters non-Polygon snapshots through resolvePolymarketLeg and remains non-final", async () => {
    const urls = await rpc({ "/primary": { chainId: 1 }, "/secondary": { chainId: 1 } });

    const read = await readFrom(urls);
    const decision = await resolveFrom(urls);

    expect(read.snapshots).toHaveLength(2);
    expect(read.snapshots.every((snapshot) => snapshot.chainId === 1)).toBe(true);
    expect(read.providerEvidence).toHaveLength(2);
    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_rpc_quorum_unavailable"
    });
  });

  it("rejects divergent hashes for the common finalized block before payout reads", async () => {
    const urls = await rpc({
      "/primary": { finalizedBlockHash: sharedBlockHash, proofBlockHash: sharedBlockHash },
      "/secondary": { finalizedBlockHash: divergentBlockHash, proofBlockHash: divergentBlockHash }
    });

    const read = await readFrom(urls);
    const decision = await resolveFrom(urls);

    expect(read.snapshots).toEqual([]);
    expect(read.providerEvidence).toHaveLength(2);
    expect(read.providerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "error", proofBlockNumber: 100, error: "ctf_common_block_hash_mismatch" })
      ])
    );
    expect(decision).toMatchObject({
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "ctf_rpc_quorum_unavailable"
    });
  });

  it("falls back to block-number reads only after re-verifying the proof block hash", async () => {
    const urls = await rpc({ "/primary": { rejectBlockHashReads: true }, "/secondary": { rejectBlockHashReads: true } });

    const read = await readFrom(urls);

    expect(read.snapshots).toHaveLength(2);
    expect(read.snapshots.every((snapshot) => snapshot.blockHash === sharedBlockHash)).toBe(true);
    expect(read.providerEvidence).toHaveLength(2);
    expect(read.providerEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "ok",
          readMode: "blockNumber_reverified",
          blockHashReadSupported: false,
          blockHashReverified: true,
          blockHashReadError: expect.stringContaining("block hash reads unsupported")
        })
      ])
    );
  });
});
