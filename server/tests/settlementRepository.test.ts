import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config";
import * as settlementRepository from "../db/settlementRepository";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({
    query: dbMocks.query,
    connect: async () => ({
      query: dbMocks.clientQuery,
      release: dbMocks.release
    })
  })
}));

import {
  backfillSettlementIdentities,
  claimTicketToAvailable,
  deriveTicketStatus,
  prepareTicketSettlementIdentities,
  listBlockedSettlementLegs,
  listPendingSettlementLegs,
  recordLegSettlement,
  recordSettlementProof,
  validateAndFreezeTicketSettlementIdentitiesInTransaction,
  validateFrozenSettlementIdentitiesForTicketInTransaction
} from "../db/settlementRepository";

const ctfAddress = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const collateralAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const conditionId = `0x${"1".repeat(64)}`;
const proofBlockHash = `0x${"3".repeat(64)}`;
const collectionId = `0x${"2".repeat(64)}`;
const rpcEndpoints = [
  { url: "https://rpc-a.example", normalizedUrl: "https://rpc-a.example/", endpointId: "endpoint-a", operator: "operator-a" },
  { url: "https://rpc-b.example", normalizedUrl: "https://rpc-b.example/", endpointId: "endpoint-b", operator: "operator-b" }
];

function positionProviderEvidence() {
  return rpcEndpoints.map((endpoint, index) => ({
    provider: index === 0 ? "primary" : "secondary",
    rpcHost: new URL(endpoint.url).host,
    rpcEndpointId: endpoint.endpointId,
    rpcOperator: endpoint.operator,
    status: "ok" as const,
    chainId: 137,
    finalizedBlockNumber: 1000,
    proofBlockNumber: 1000,
    proofBlockHash,
    blockNumber: 1000,
    blockHash: proofBlockHash,
    computedPositionId: "12345",
    collectionId,
    readMode: "blockHash" as const,
    blockHashReadSupported: true
  }));
}

function payoutProviderEvidence() {
  return rpcEndpoints.map((endpoint, index) => ({
    provider: index === 0 ? "primary" : "secondary",
    rpcHost: new URL(endpoint.url).host,
    rpcEndpointId: endpoint.endpointId,
    rpcOperator: endpoint.operator,
    status: "ok",
    chainId: 137,
    finalizedBlockNumber: 1000,
    proofBlockNumber: 1000,
    proofBlockHash,
    blockNumber: 1000,
    blockHash: proofBlockHash,
    payoutDenominator: "1",
    payoutNumerators: ["1", "0"],
    readMode: "blockHash",
    blockHashReadSupported: true
  }));
}

function finalCtfProof(overrides: Record<string, unknown> = {}) {
  return {
    source: "polymarket_ctf",
    proofKind: "ctf_payout_vector",
    result: "won",
    confidence: "onchain_confirmed",
    chainId: 137,
    contractAddress: ctfAddress,
    collateralAddress,
    conditionId,
    tokenId: "12345",
    outcomeIndex: 0,
    payoutNumerator: "1",
    payoutDenominator: "1",
    payoutVector: ["1", "0"],
    blockNumber: 1000,
    blockHash: proofBlockHash,
    providerEvidence: payoutProviderEvidence(),
    resolvedAt: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
}

function apiProviderEvidence() {
  return [
    {
      provider: "gamma",
      status: "ok",
      fetchedAt: "2026-07-21T09:03:00.000Z",
      sourceMarketId: "market-api-test",
      conditionId,
      closed: true,
      umaResolutionStatus: "RESOLVED",
      outcomes: ["Yes", "No"],
      tokenIds: ["12345", "67890"],
      outcomePrices: ["1", "0"]
    },
    {
      provider: "clob",
      status: "ok",
      fetchedAt: "2026-07-21T09:03:00.000Z",
      conditionId,
      closed: true,
      acceptingOrders: false,
      is50_50Outcome: false,
      tokens: [
        { tokenId: "12345", outcome: "Yes", price: 1, winner: true },
        { tokenId: "67890", outcome: "No", price: 0, winner: false }
      ]
    }
  ];
}

function finalApiProof(overrides: Record<string, unknown> = {}) {
  return {
    source: "polymarket_api",
    proofKind: "polymarket_api_outcome",
    result: "won",
    confidence: "api_signal",
    chainId: 137,
    contractAddress: ctfAddress,
    collateralAddress,
    conditionId,
    tokenId: "12345",
    outcomeIndex: 0,
    winningTokenId: "12345",
    payoutNumerator: "1",
    payoutDenominator: "1",
    payoutVector: ["1", "0"],
    resolvedAt: "2026-07-21T08:00:00.000Z",
    providerEvidence: apiProviderEvidence(),
    raw: {
      candidateProofId: "candidate-proof-test",
      fingerprint: "a".repeat(64),
      firstObservedAt: "2026-07-21T09:00:00.000Z",
      confirmedAt: "2026-07-21T09:03:00.000Z"
    },
    ...overrides
  };
}

function lockedHouseLeg(overrides: Record<string, unknown> = {}) {
  return {
    ticket_id: "ticket-test",
    status: "pending",
    settlementSource: "polymarket_ctf",
    settlementAuthority: "polygon_ctf",
    settlementChainId: 137,
    settlementContractAddress: ctfAddress,
    settlementCollateralAddress: collateralAddress,
    settlementConditionId: conditionId,
    settlementTokenId: "12345",
    settlementPositionId: "12345",
    settlementOutcomeIndex: 0,
    settlementPayoutSlotCount: 2,
    settlementIdentityValidationProofId: "11111111-1111-1111-1111-111111111111",
    settlementIdentityValidationBlockNumber: "1000",
    settlementIdentityValidationBlockHash: proofBlockHash,
    settlementFrozenAt: new Date("2026-07-01T00:00:02.000Z"),
    settlementDueAt: new Date("2026-07-20T00:00:00.000Z"),
    ...overrides
  };
}

function lockedApiHouseLeg(overrides: Record<string, unknown> = {}) {
  return lockedHouseLeg({
    settlementAuthority: "polymarket_api",
    settlementSourceMarketId: "market-api-test",
    settlementOutcome: "Yes",
    settlementIdentityValidationBlockNumber: null,
    settlementIdentityValidationBlockHash: null,
    ...overrides
  });
}

function mockApiSettlementIdentityLock(input: {
  candidateCreatedAt?: Date;
  checkedAt?: Date;
  candidateRaw?: Record<string, unknown>;
} = {}) {
  const candidateRaw = {
    fingerprint: "a".repeat(64),
    firstObservedAt: "2026-07-21T09:00:00.000Z",
    ...input.candidateRaw
  };
  dbMocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("ticket_legs.ticket_id, tickets.accounting_mode")) {
      return { rows: [{ ticket_id: "ticket-test", accounting_mode: "house_book_usdc" }] };
    }
    if (sql.includes("SELECT accounting_mode, status FROM tickets") && sql.includes("FOR UPDATE")) {
      return { rows: [{ accounting_mode: "house_book_usdc", status: "live" }] };
    }
    if (sql.includes("settlement_outcome_index AS \"settlementOutcomeIndex\"")) {
      return { rows: [lockedApiHouseLeg()] };
    }
    if (sql.includes("proof_kind = 'polymarket_api_resolution_candidate'")) {
      return {
        rows: [{
          result: "won",
          conditionId,
          tokenId: "12345",
          outcomeIndex: 0,
          payoutNumerator: "1",
          payoutDenominator: "1",
          payoutVector: ["1", "0"],
          raw: candidateRaw,
          createdAt: input.candidateCreatedAt || new Date("2026-07-21T09:00:00.000Z"),
          checkedAt: input.checkedAt || new Date("2026-07-21T09:03:00.000Z")
        }]
      };
    }
    if (sql.includes("INSERT INTO settlement_proofs")) return { rows: [{ id: "settlement-proof-test" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
}

function mockHouseSettlementIdentityLock(leg = lockedHouseLeg()) {
  dbMocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("ticket_legs.ticket_id, tickets.accounting_mode")) {
      return { rows: [{ ticket_id: "ticket-test", accounting_mode: "house_book_usdc" }] };
    }
    if (sql.includes("SELECT accounting_mode, status FROM tickets") && sql.includes("FOR UPDATE")) {
      return { rows: [{ accounting_mode: "house_book_usdc", status: "live" }] };
    }
    if (sql.includes("settlement_outcome_index AS \"settlementOutcomeIndex\"")) {
      return { rows: [leg] };
    }
    if (sql.includes("INSERT INTO settlement_proofs")) return { rows: [{ id: "settlement-proof-test" }], rowCount: 1 };
    if (sql.includes("SELECT status FROM tickets")) return { rows: [{ status: "voided" }] };
    return { rows: [], rowCount: 1 };
  });
}

function proofWithEvidenceMutation(mutator: (evidence: Array<Record<string, unknown>>) => void) {
  const proof = structuredClone(finalCtfProof()) as ReturnType<typeof finalCtfProof>;
  mutator(proof.providerEvidence as Array<Record<string, unknown>>);
  return proof;
}

function settlementLegRow(overrides: Record<string, unknown> = {}) {
  return {
    ticketLegId: "ticket-leg-test",
    ticketId: "ticket-test",
    quoteId: "quote-test",
    question: "Will test settle?",
    outcome: "Yes",
    marketUrl: "https://polymarket.com/event/test",
    conditionId: "condition-test",
    tokenId: "token-test",
    settlementSource: "polymarket_ctf",
    settlementAuthority: "polygon_ctf",
    settlementChainId: 137,
    settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
    settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    settlementConditionId: "condition-test",
    settlementTokenId: "token-test",
    settlementOutcomeIndex: 0,
    settlementPayoutSlotCount: 2,
    settlementQuestionId: "question-test",
    settlementUmaAdapter: "uma-ctf-adapter",
    settlementUmaAdapterVersion: "v1",
    settlementEventId: "event-test",
    settlementNegRiskGroupId: null,
    settlementRulesSnapshotHash: "rules-hash-test",
    settlementSourceSnapshotId: "snapshot-test",
    settlementFrozenAt: new Date("2026-07-01T00:00:02.000Z"),
    settlementDueAt: new Date("2026-07-20T00:00:00.000Z"),
    endDate: new Date("2026-07-01T00:00:00.000Z"),
    negRisk: false,
    status: "pending",
    resolutionState: "pending",
    resolutionAttempts: 0,
    resolutionUpdatedAt: new Date("2026-07-02T00:00:00.000Z"),
    nextResolutionCheckAt: new Date("2026-07-02T00:05:00.000Z"),
    lastResolutionError: null,
    ticketStatus: "live",
    createdAt: new Date("2026-07-01T00:00:01.000Z"),
    ...overrides
  };
}

beforeEach(() => {
  dbMocks.query.mockReset();
  dbMocks.clientQuery.mockReset();
  dbMocks.release.mockReset();
  config.POLYGON_RPC_ENDPOINTS.splice(
    0,
    config.POLYGON_RPC_ENDPOINTS.length,
    ...rpcEndpoints.map((endpoint) => ({ ...endpoint }))
  );
});

describe("settlement state machine", () => {
  it("does not finalize a loss while unresolved legs could still void the ticket", () => {
    expect(deriveTicketStatus(["won", "lost", "pending"])).toBe("live");
    expect(deriveTicketStatus(["lost", "disputed"])).toBe("live");
  });

  it("voids the whole ticket when any leg is voided regardless of order", () => {
    expect(deriveTicketStatus(["voided", "lost"])).toBe("voided");
    expect(deriveTicketStatus(["voided", "pending"])).toBe("voided");
    expect(deriveTicketStatus(["lost", "voided", "pending"])).toBe("voided");
  });

  it("keeps tickets live while any leg is pending or disputed", () => {
    expect(deriveTicketStatus(["won", "pending"])).toBe("live");
    expect(deriveTicketStatus(["won", "disputed"])).toBe("live");
  });

  it("voids tickets when all final legs include a void and no loss", () => {
    expect(deriveTicketStatus(["won", "voided"])).toBe("voided");
  });

  it("wins tickets only when every leg won", () => {
    expect(deriveTicketStatus(["won", "won"])).toBe("won");
  });

  it("loses tickets only after all legs are terminal and none voided", () => {
    expect(deriveTicketStatus(["won", "lost"])).toBe("lost");
    expect(deriveTicketStatus(["lost", "won", "won"])).toBe("lost");
  });

  it("documents that final leg outcomes require reversals instead of direct flips", () => {
    const finalStatuses = ["won", "lost", "voided"];
    expect(finalStatuses.includes("won")).toBe(true);
    expect(finalStatuses.includes("pending")).toBe(false);
  });

  it("audits unresolved legs on active and final tickets", async () => {
    dbMocks.query.mockResolvedValueOnce({ rows: [] });

    await listPendingSettlementLegs();

    const sql = String(dbMocks.query.mock.calls[0][0]);
    expect(sql).toContain("ticket_legs.status IN ('pending', 'disputed')");
    expect(sql).toContain("tickets.status IN ('accepted', 'live', 'won', 'lost', 'voided')");
    expect(sql).not.toContain("'claimable'");
    expect(sql).not.toContain("'paid'");
  });

  it("keeps blocked unresolved settlements visible in the default ops list", async () => {
    dbMocks.query.mockResolvedValueOnce({
      rows: [
        settlementLegRow({
          resolutionState: "settlement_blocked",
          lastResolutionError: "missing token id"
        })
      ]
    });

    const legs = await listPendingSettlementLegs();
    const sql = String(dbMocks.query.mock.calls[0][0]);

    expect(sql).not.toContain("ticket_legs.resolution_state <> 'settlement_blocked'");
    expect(sql).not.toContain("ticket_legs.next_resolution_check_at <= now()");
    expect(legs[0]).toMatchObject({
      ticketLegId: "ticket-leg-test",
      endDate: "2026-07-01T00:00:00.000Z",
      settlementChainId: 137,
      settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
      settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      settlementOutcomeIndex: 0,
      settlementRulesSnapshotHash: "rules-hash-test",
      settlementFrozenAt: "2026-07-01T00:00:02.000Z",
      resolutionState: "settlement_blocked",
      resolutionUpdatedAt: "2026-07-02T00:00:00.000Z",
      nextResolutionCheckAt: "2026-07-02T00:05:00.000Z",
      lastResolutionError: "missing token id"
    });
  });

  it("supports worker queries for due ended legs without reprocessing blocked rows", async () => {
    dbMocks.query.mockResolvedValueOnce({
      rows: [settlementLegRow()]
    });

    const legs = await listPendingSettlementLegs(25, {
      dueOnly: true,
      includeBlocked: false
    });
    const sql = String(dbMocks.query.mock.calls[0][0]);

    expect(dbMocks.query).toHaveBeenCalledWith(expect.any(String), [25]);
    expect(sql).toContain("ticket_legs.next_resolution_check_at <= now()");
    expect(sql).toContain("ticket_legs.resolution_state <> 'settlement_blocked'");
    expect(legs[0]).toMatchObject({
      ticketLegId: "ticket-leg-test",
      endDate: "2026-07-01T00:00:00.000Z",
      settlementSource: "polymarket_ctf"
    });
  });

  it("supports a dedicated blocked settlement retry queue", async () => {
    dbMocks.query.mockResolvedValueOnce({
      rows: [
        settlementLegRow({
          resolutionState: "settlement_blocked",
          lastResolutionError: "identity validation failed"
        })
      ]
    });

    const legs = await listBlockedSettlementLegs(5, { dueOnly: true });
    const sql = String(dbMocks.query.mock.calls[0][0]);

    expect(dbMocks.query).toHaveBeenCalledWith(expect.any(String), [5]);
    expect(sql).toContain("ticket_legs.resolution_state = 'settlement_blocked'");
    expect(sql).toContain("ticket_legs.next_resolution_check_at <= now()");
    expect(legs[0]).toMatchObject({
      resolutionState: "settlement_blocked",
      lastResolutionError: "identity validation failed"
    });
  });

  it("prepares an unfrozen settlement identity from immutable quote snapshot JSON", async () => {
    dbMocks.clientQuery.mockResolvedValue({
      rows: [
        {
          ticketLegId: "ticket-leg-test",
          ticketId: "ticket-test",
          settlementSource: "polymarket_ctf",
          settlementAuthority: "polygon_ctf",
          settlementChainId: 137,
          settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
          settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
          settlementConditionId: `0x${"1".repeat(64)}`,
          settlementTokenId: "12345",
          settlementOutcomeIndex: 1,
          settlementPayoutSlotCount: 2,
          settlementQuestionId: null,
          settlementUmaAdapter: null,
          settlementUmaAdapterVersion: null,
          settlementEventId: "event-slug",
          settlementNegRiskGroupId: null,
          settlementRulesSnapshotHash: "snapshot-hash",
          settlementSourceSnapshotId: "snapshot-test",
          settlementQuestion: "Will the immutable snapshot win?",
          settlementOutcome: "No",
          settlementSourceMarketId: "market-from-snapshot",
          settlementPositionId: "12345",
          settlementCollectionId: `0x${"2".repeat(64)}`,
          settlementDueAt: new Date("2026-07-20T00:00:00.000Z"),
          settlementFrozenAt: null
        }
      ]
    });

    const identities = await prepareTicketSettlementIdentities(
      { query: dbMocks.clientQuery } as never,
      { ticketId: "ticket-test" }
    );
    const sql = String(dbMocks.clientQuery.mock.calls[0][0]);

    expect(sql).toContain("market_snapshots.raw");
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).not.toContain("JOIN market_outcomes");
    expect(sql).not.toContain("markets.condition_id");
    expect(sql).not.toContain("SET settlement_frozen_at");
    expect(identities[0]).toMatchObject({
      settlementConditionId: `0x${"1".repeat(64)}`,
      settlementOutcomeIndex: 1,
      settlementQuestion: "Will the immutable snapshot win?",
      settlementSourceMarketId: "market-from-snapshot"
    });
  });

  it("does not export an identity freeze or finalization bypass", () => {
    expect("freezeTicketSettlementIdentities" in settlementRepository).toBe(false);
    expect("finalizeTicketSettlementIdentities" in settlementRepository).toBe(false);
    expect("validateAndFreezeTicketSettlementIdentitiesInTransaction" in settlementRepository).toBe(true);
  });

  it("validates frozen CTF identity in the caller transaction", async () => {
    dbMocks.clientQuery
      .mockResolvedValueOnce({
        rows: [
          {
            ticketLegId: "ticket-leg-test",
            settlementAuthority: "polygon_ctf",
            settlementChainId: 137,
            settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
            settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            settlementConditionId: `0x${"1".repeat(64)}`,
            settlementTokenId: "12345",
            settlementOutcomeIndex: 0,
            settlementPayoutSlotCount: 2
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ id: "validation-proof-test" }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    const results = await validateFrozenSettlementIdentitiesForTicketInTransaction(
      { query: dbMocks.clientQuery } as never,
      {
        ticketId: "ticket-test",
        validateIdentity: async () => ({
          valid: true,
          retryable: false,
          computedPositionId: "12345",
          collectionId: `0x${"2".repeat(64)}`,
          blockNumber: 1000,
          blockHash: `0x${"3".repeat(64)}`,
          providerEvidence: positionProviderEvidence()
        })
      }
    );

    expect(results[0]).toMatchObject({
      valid: true,
      computedPositionId: "12345",
      collectionId: `0x${"2".repeat(64)}`
    });
    expect(dbMocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("settlement_collection_id"))).toBe(true);
    expect(dbMocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO settlement_proofs"))).toBe(true);
  });

  it("persists activation-grade validation provenance before the only exported freeze pipeline", async () => {
    const validationRow = {
      ticketLegId: "ticket-leg-test",
      settlementAuthority: "polygon_ctf" as const,
      settlementChainId: 137,
      settlementContractAddress: ctfAddress,
      settlementCollateralAddress: collateralAddress,
      settlementConditionId: conditionId,
      settlementTokenId: "12345",
      settlementOutcomeIndex: 0,
      settlementPayoutSlotCount: 2
    };
    const frozenRow = {
      ...validationRow,
      ticketId: "ticket-test",
      settlementSource: "polymarket_ctf",
      settlementQuestionId: null,
      settlementUmaAdapter: null,
      settlementUmaAdapterVersion: null,
      settlementEventId: "event-test",
      settlementNegRiskGroupId: null,
      settlementRulesSnapshotHash: "rules-hash",
      settlementSourceSnapshotId: "snapshot-test",
      settlementQuestion: "Will test settle?",
      settlementOutcome: "Yes",
      settlementSourceMarketId: "market-test",
      settlementPositionId: "12345",
      settlementCollectionId: collectionId,
      settlementDueAt: new Date("2026-07-20T00:00:00.000Z"),
      settlementFrozenAt: new Date("2026-07-14T00:00:00.000Z")
    };
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM ticket_legs") && sql.includes("FOR UPDATE")) return { rows: [validationRow] };
      if (sql.includes("INSERT INTO settlement_proofs")) return { rows: [{ id: "validation-proof-test" }], rowCount: 1 };
      if (sql.includes("SET settlement_frozen_at")) return { rows: [frozenRow], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const identities = await validateAndFreezeTicketSettlementIdentitiesInTransaction(
      { query: dbMocks.clientQuery } as never,
      {
        ticketId: "ticket-test",
        validateIdentity: async () => ({
          valid: true,
          retryable: false,
          computedPositionId: "12345",
          collectionId,
          blockNumber: 1000,
          blockHash: proofBlockHash,
          providerEvidence: positionProviderEvidence()
        })
      }
    );
    const sqlCalls = dbMocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    const proofIndex = sqlCalls.findIndex((sql) => sql.includes("INSERT INTO settlement_proofs"));
    const provenanceIndex = sqlCalls.findIndex((sql) => sql.includes("settlement_identity_validation_proof_id = $4"));
    const freezeIndex = sqlCalls.findIndex((sql) => sql.includes("SET settlement_frozen_at"));

    expect(proofIndex).toBeGreaterThan(-1);
    expect(provenanceIndex).toBeGreaterThan(proofIndex);
    expect(freezeIndex).toBeGreaterThan(provenanceIndex);
    expect(identities[0]).toMatchObject({ settlementFrozenAt: "2026-07-14T00:00:00.000Z" });
  });

  it("rejects transaction-aware identity validation failures", async () => {
    dbMocks.clientQuery
      .mockResolvedValueOnce({
        rows: [
          {
            ticketLegId: "ticket-leg-test",
            settlementAuthority: "polygon_ctf",
            settlementChainId: 137,
            settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
            settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            settlementConditionId: `0x${"1".repeat(64)}`,
            settlementTokenId: "12345",
            settlementOutcomeIndex: 0,
            settlementPayoutSlotCount: 2
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ id: "validation-proof-test" }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(
      validateFrozenSettlementIdentitiesForTicketInTransaction(
        { query: dbMocks.clientQuery } as never,
        {
          ticketId: "ticket-test",
          validateIdentity: async () => ({
            valid: false,
            retryable: false,
            computedPositionId: "67890",
            collectionId: `0x${"2".repeat(64)}`,
            blockNumber: 1000,
            blockHash: `0x${"3".repeat(64)}`,
            providerEvidence: [{ provider: "primary", status: "ok" }],
            error: "ctf_position_id_mismatch"
          })
        }
      )
    ).rejects.toThrow("settlement_identity_validation_failed:ticket-leg-test:ctf_position_id_mismatch");
    expect(dbMocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("resolution_state = CASE"))).toBe(true);
  });

  it("rejects transaction-aware identity validation when finalized evidence is incomplete", async () => {
    dbMocks.clientQuery
      .mockResolvedValueOnce({
        rows: [
          {
            ticketLegId: "ticket-leg-test",
            settlementAuthority: "polygon_ctf",
            settlementChainId: 137,
            settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
            settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
            settlementConditionId: `0x${"1".repeat(64)}`,
            settlementTokenId: "12345",
            settlementOutcomeIndex: 0,
            settlementPayoutSlotCount: 2
          }
        ]
      })
      .mockResolvedValueOnce({ rows: [{ id: "validation-proof-test" }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(
      validateFrozenSettlementIdentitiesForTicketInTransaction(
        { query: dbMocks.clientQuery } as never,
        {
          ticketId: "ticket-test",
          validateIdentity: async () => ({
            valid: true,
            retryable: true,
            computedPositionId: "12345",
            providerEvidence: [{ provider: "primary", status: "ok" }]
          })
        }
      )
    ).rejects.toThrow("settlement_identity_validation_failed:ticket-leg-test:ctf_identity_validation_incomplete");

    expect(
      dbMocks.clientQuery.mock.calls.some(
        ([sql, params]) => String(sql).includes("INSERT INTO settlement_proofs") && JSON.stringify(params).includes("blocked")
      )
    ).toBe(true);
    expect(dbMocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("resolution_state = CASE"))).toBe(true);
  });

  it("backfill scans existing tickets missing frozen identity", async () => {
    dbMocks.query.mockResolvedValueOnce({ rows: [] });

    const result = await backfillSettlementIdentities(25);
    const sql = String(dbMocks.query.mock.calls[0][0]);

    expect(sql).toContain("ticket_legs.settlement_position_id IS NULL");
    expect(sql).toContain("settlement_identity_quarantines.retryable = false");
    expect(sql).toContain("settlement_identity_quarantines.next_retry_at > now()");
    expect(sql).toContain("settlement_identity_quarantines.resolved_at IS NULL");
    expect(sql).toContain("tickets.status IN ('accepted', 'live', 'won', 'lost', 'voided')");
    expect(sql).not.toContain("'claimable'");
    expect(sql).not.toContain("'paid'");
    expect(result).toEqual({
      checked: 0,
      results: []
    });
  });

  it("marks permanent backfill failures non-retryable with audited attempts", async () => {
    dbMocks.query.mockResolvedValueOnce({ rows: [{ ticketId: "ticket-test" }] });
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM tickets") && sql.includes("FOR UPDATE")) return { rows: [{ status: "live" }] };
      if (sql.includes("WITH leg_identity")) return { rows: [] };
      if (sql.includes("UPDATE ticket_legs") && sql.includes("resolution_state = 'settlement_blocked'")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO settlement_identity_quarantines")) {
        return { rows: [{ quarantine_count: 3 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await backfillSettlementIdentities(1);
    const quarantineCall = dbMocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO settlement_identity_quarantines"));
    const auditCall = dbMocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("ticket.settlement_quarantined"));

    expect(result.results).toEqual([{
      ticketId: "ticket-test",
      status: "quarantined",
      error: "ticket_settlement_identity_no_legs"
    }]);
    expect(quarantineCall?.[1]).toEqual(["ticket-test", "ticket_settlement_identity_no_legs", false, 300]);
    expect(auditCall?.[1]?.[1]).toMatchObject({
      reason: "ticket_settlement_identity_no_legs",
      retryable: false,
      attempts: 3
    });
  });

  it.each(["claimable", "paid"])("skips a ticket that becomes %s after backfill selection", async (status) => {
    dbMocks.query.mockResolvedValueOnce({ rows: [{ ticketId: "ticket-test" }] });
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM tickets") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status }] };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await backfillSettlementIdentities(1);
    const statements = dbMocks.clientQuery.mock.calls.map(([sql]) => String(sql));

    expect(result).toEqual({
      checked: 1,
      results: [{ ticketId: "ticket-test", status: "skipped" }]
    });
    expect(statements.some((sql) => sql.includes("WITH leg_identity"))).toBe(false);
    expect(statements).toContain("COMMIT");
  });

  it("reactivates successfully validated quarantined legs before resolving quarantine", async () => {
    const identity = {
      ticketLegId: "ticket-leg-test",
      ticketId: "ticket-test",
      settlementSource: "polymarket_ctf",
      settlementAuthority: "polygon_ctf" as const,
      settlementChainId: 137,
      settlementContractAddress: ctfAddress,
      settlementCollateralAddress: collateralAddress,
      settlementConditionId: conditionId,
      settlementTokenId: "12345",
      settlementOutcomeIndex: 0,
      settlementPayoutSlotCount: 2,
      settlementQuestionId: null,
      settlementUmaAdapter: null,
      settlementUmaAdapterVersion: null,
      settlementEventId: "event-test",
      settlementNegRiskGroupId: null,
      settlementRulesSnapshotHash: "rules-hash",
      settlementSourceSnapshotId: "snapshot-test",
      settlementQuestion: "Will test settle?",
      settlementOutcome: "Yes",
      settlementSourceMarketId: "market-test",
      settlementPositionId: "12345",
      settlementCollectionId: collectionId,
      settlementDueAt: new Date("2026-07-20T00:00:00.000Z"),
      settlementFrozenAt: new Date("2026-07-14T00:00:00.000Z")
    };
    dbMocks.query.mockResolvedValueOnce({ rows: [{ ticketId: "ticket-test" }] });
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM tickets") && sql.includes("FOR UPDATE")) return { rows: [{ status: "live" }] };
      if (sql.includes("WITH leg_identity")) return { rows: [{ ...identity, settlementFrozenAt: null }] };
      if (sql.includes("FROM ticket_legs") && sql.includes("FOR UPDATE")) return { rows: [identity] };
      if (sql.includes("INSERT INTO settlement_proofs")) return { rows: [{ id: "validation-proof-test" }], rowCount: 1 };
      if (sql.includes("SET settlement_frozen_at")) return { rows: [identity], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const result = await backfillSettlementIdentities(1, {
      validateIdentity: async () => ({
        valid: true,
        retryable: false,
        computedPositionId: "12345",
        collectionId,
        blockNumber: 1000,
        blockHash: proofBlockHash,
        providerEvidence: positionProviderEvidence()
      })
    });
    const calls = dbMocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    const reactivateIndex = calls.findIndex((sql) => sql.includes("resolution_state = 'pending'") && sql.includes("settlement_identity_quarantines"));
    const resolveIndex = calls.findIndex((sql) => sql.includes("SET resolved_at = now()"));

    expect(result.results).toEqual([{ ticketId: "ticket-test", status: "frozen" }]);
    expect(reactivateIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(reactivateIndex);
  });

  it("validates CTF position identity before finalizing a backfill freeze", async () => {
    config.POLYGON_RPC_ENDPOINTS.splice(0);
    const identity = {
      ticketLegId: "ticket-leg-test",
      ticketId: "ticket-test",
      settlementSource: "polymarket_ctf",
      settlementAuthority: "polygon_ctf" as const,
      settlementChainId: 137,
      settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
      settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      settlementConditionId: `0x${"1".repeat(64)}`,
      settlementTokenId: "12345",
      settlementOutcomeIndex: 0,
      settlementPayoutSlotCount: 2,
      settlementQuestion: "Will test settle?",
      settlementOutcome: "Yes",
      settlementSourceMarketId: "test-market",
      settlementRulesSnapshotHash: "snapshot-hash",
      settlementSourceSnapshotId: "snapshot-test",
      settlementPositionId: "12345",
      settlementCollectionId: `0x${"2".repeat(64)}`,
      settlementDueAt: new Date("2026-07-20T00:00:00.000Z"),
      settlementFrozenAt: new Date("2026-07-01T00:00:02.000Z")
    };
    dbMocks.query.mockResolvedValueOnce({ rows: [{ ticketId: "ticket-test" }] });
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM tickets") && sql.includes("FOR UPDATE")) return { rows: [{ status: "live" }] };
      if (sql.includes("WITH leg_identity")) return { rows: [{ ...identity, settlementFrozenAt: null }] };
      if (sql.includes("FROM ticket_legs") && sql.includes("FOR UPDATE")) return { rows: [identity] };
      if (sql.includes("SET settlement_frozen_at")) return { rows: [identity] };
      if (sql.includes("INSERT INTO settlement_proofs")) return { rows: [{ id: "validation-proof-test" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const result = await backfillSettlementIdentities(1);
    const calls = dbMocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    const proofCall = calls.findIndex((sql) => sql.includes("INSERT INTO settlement_proofs"));
    const freezeCall = calls.findIndex((sql) => sql.includes("SET settlement_frozen_at"));

    expect(result.results).toEqual([
      {
        ticketId: "ticket-test",
        status: "retryable",
        error: "settlement_identity_validation_failed:ticket-leg-test:ctf_position_rpc_unconfigured"
      }
    ]);
    expect(proofCall).toBeGreaterThan(-1);
    expect(freezeCall).toBe(-1);
  });

  it("keeps settlement proof, settlement, and audit tables append-only in migration SQL", () => {
    const migration = readFileSync(new URL("../db/migrations/0027_settlement_hardening.sql", import.meta.url), "utf8");

    expect(migration).toContain("DROP INDEX IF EXISTS settlements_ticket_leg_source_idx");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON settlement_proofs");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON settlements");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON audit_log");
  });

  it("quarantines unsafe legacy frozen rows before validating immutable identity SQL", () => {
    const migration = readFileSync(new URL("../db/migrations/0028_settlement_identity_immutability.sql", import.meta.url), "utf8");

    expect(migration).toContain("settlement_identity_quarantines");
    expect(migration).toContain("legacy_frozen_settlement_identity_incomplete");
    expect(migration).toContain("retryable BOOLEAN NOT NULL DEFAULT false");
    expect(migration).toContain("next_retry_at TIMESTAMPTZ");
    expect(migration).toContain("WHERE id IN (SELECT id FROM unsafe_frozen_legs)");
    expect(migration).toContain("settlement_identity_validation_proof_id UUID REFERENCES settlement_proofs(id)");
    expect(migration).toContain("settlement_identity_validation_block_number NUMERIC(78, 0)");
    expect(migration).toContain("settlement_identity_validation_block_hash TEXT");
    expect(migration).toContain("ADD CONSTRAINT ticket_legs_frozen_settlement_identity_check");
    expect(migration).toContain(") NOT VALID;");
    expect(migration).toContain("VALIDATE CONSTRAINT ticket_legs_frozen_settlement_identity_check");
    expect(migration).toContain("enforce_frozen_ticket_leg_validation_provenance");
    expect(migration).toContain("settlement_proofs.ticket_leg_id = NEW.id");
    expect(migration).toContain("settlement_proofs.proof_kind = 'ctf_position_id_validation'");
    expect(migration).toContain("settlement_proofs.confidence = 'onchain_confirmed'");
    expect(migration).toContain("prevent_frozen_ticket_leg_identity_mutation");
    for (const field of [
      "settlement_source",
      "settlement_condition_id",
      "settlement_token_id",
      "settlement_outcome_index",
      "settlement_position_id",
      "settlement_collection_id",
      "settlement_source_snapshot_id",
      "settlement_identity_raw",
      "settlement_identity_validation_proof_id",
      "settlement_identity_validation_block_number",
      "settlement_identity_validation_block_hash",
      "settlement_frozen_at"
    ]) {
      expect(migration).toContain(`NEW.${field} IS DISTINCT FROM OLD.${field}`);
    }
    expect(migration).not.toContain("COALESCE(settlement_position_id, settlement_token_id)");
  });

  it("keeps the claimable audit query valid with exactly one descending order clause", () => {
    const source = readFileSync(new URL("../db/settlementRepository.ts", import.meta.url), "utf8");
    const claimFunction = source.slice(source.indexOf("export async function claimTicketToAvailable"), source.indexOf("export async function recordLegSettlement"));

    expect(claimFunction).not.toMatch(/ORDER BY created_at DESC\s+ORDER BY created_at DESC/);
    expect(claimFunction.match(/ORDER BY created_at DESC/g)).toHaveLength(1);
  });

  it("serializes nested bigint proof evidence and raw payloads before PostgreSQL JSON writes", async () => {
    dbMocks.clientQuery.mockResolvedValueOnce({ rows: [{ id: "proof-test" }], rowCount: 1 });

    await recordSettlementProof(
      { query: dbMocks.clientQuery } as never,
      {
        ticketLegId: "ticket-leg-test",
        source: "polymarket_ctf",
        proofKind: "ctf_payout_vector",
        result: "won",
        confidence: "onchain_confirmed",
        providerEvidence: [{ blockNumber: 1000n, nested: { payout: 1n } }],
        raw: { payoutVector: [1n, 0n], observedAt: new Date("2026-07-14T00:00:00.000Z") }
      }
    );

    const params = dbMocks.clientQuery.mock.calls[0][1];
    expect(JSON.parse(params[19])).toEqual([{ blockNumber: "1000", nested: { payout: "1" } }]);
    expect(JSON.parse(params[20])).toEqual({ payoutVector: ["1", "0"], observedAt: "2026-07-14T00:00:00.000Z" });
    expect(() => JSON.stringify(params)).not.toThrow();
  });

  const houseIdentityMismatchCases: Array<{
    name: string;
    leg?: Record<string, unknown>;
    proof?: () => Record<string, unknown>;
    source?: string;
    result?: "won" | "lost" | "voided" | "disputed";
    proofReference?: string;
    setup?: () => void;
    expected: string;
  }> = [
    {
      name: "rejects a non-CTF frozen source",
      leg: { settlementSource: "manual_ops" },
      expected: "house_book_settlement_frozen_identity_invalid"
    },
    {
      name: "rejects a non-Polygon frozen chain",
      leg: { settlementChainId: 1 },
      expected: "house_book_settlement_frozen_identity_invalid"
    },
    {
      name: "rejects a frozen CTF contract mismatch",
      leg: { settlementContractAddress: `0x${"4".repeat(40)}` },
      expected: "house_book_settlement_frozen_identity_invalid"
    },
    {
      name: "rejects a frozen collateral mismatch",
      leg: { settlementCollateralAddress: `0x${"5".repeat(40)}` },
      expected: "house_book_settlement_frozen_identity_invalid"
    },
    {
      name: "rejects a frozen token and position mismatch",
      leg: { settlementPositionId: "67890" },
      expected: "house_book_settlement_frozen_identity_invalid"
    },
    {
      name: "rejects an unfrozen leg",
      leg: { settlementFrozenAt: null },
      expected: "house_book_settlement_frozen_identity_invalid"
    },
    {
      name: "rejects a frozen leg without activation validation provenance",
      leg: { settlementIdentityValidationProofId: null },
      expected: "house_book_settlement_frozen_identity_invalid"
    },
    {
      name: "rejects a leg moved to another ticket after the unlocked mode lookup",
      leg: { ticket_id: "ticket-other" },
      expected: "ticket_leg_ticket_changed"
    },
    {
      name: "rejects a non-CTF caller source",
      source: "manual_ops",
      expected: "house_book_settlement_requires_polygon_ctf_finality"
    },
    {
      name: "rejects a proof chain mismatch",
      proof: () => finalCtfProof({ chainId: 1 }),
      expected: "house_book_settlement_requires_polygon_ctf_finality"
    },
    {
      name: "rejects a proof CTF contract mismatch",
      proof: () => finalCtfProof({ contractAddress: `0x${"4".repeat(40)}` }),
      expected: "house_book_settlement_requires_polygon_ctf_finality"
    },
    {
      name: "rejects a proof collateral mismatch",
      proof: () => finalCtfProof({ collateralAddress: `0x${"5".repeat(40)}` }),
      expected: "house_book_settlement_requires_polygon_ctf_finality"
    },
    {
      name: "rejects a proof condition mismatch",
      proof: () => finalCtfProof({ conditionId: `0x${"6".repeat(64)}` }),
      expected: "house_book_settlement_requires_polygon_ctf_finality"
    },
    {
      name: "rejects a selected token mismatch",
      proof: () => finalCtfProof({ tokenId: "67890" }),
      expected: "house_book_settlement_requires_polygon_ctf_finality"
    },
    {
      name: "rejects an outcome index mismatch",
      proof: () => finalCtfProof({ outcomeIndex: 1 }),
      expected: "house_book_settlement_requires_polygon_ctf_finality"
    },
    {
      name: "rejects a payout slot count mismatch",
      proof: () => finalCtfProof({ payoutVector: ["1"] }),
      expected: "house_book_settlement_requires_polygon_ctf_finality"
    },
    {
      name: "rejects a selected payout numerator mismatch",
      proof: () => finalCtfProof({ payoutNumerator: "0" }),
      expected: "house_book_settlement_payout_vector_mismatch"
    },
    {
      name: "rejects settlement proof predating identity validation",
      proof: () => finalCtfProof({ blockNumber: 999 }),
      expected: "house_book_settlement_predates_identity_validation"
    },
    {
      name: "rejects a settlement hash differing from identity validation at the same block",
      proof: () => {
        const hash = `0x${"8".repeat(64)}`;
        return finalCtfProof({
          blockHash: hash,
          providerEvidence: payoutProviderEvidence().map((item) => ({ ...item, proofBlockHash: hash, blockHash: hash }))
        });
      },
      expected: "house_book_settlement_identity_validation_block_mismatch"
    },
    {
      name: "rejects a non-canonical full payout vector",
      proof: () => finalCtfProof({ payoutDenominator: "2", payoutVector: ["2", "1"], payoutNumerator: "2" }),
      expected: "house_book_settlement_invalid_payout_vector"
    },
    {
      name: "rejects a caller-declared result mismatch",
      result: "lost",
      expected: "house_book_settlement_result_mismatch"
    },
    {
      name: "rejects a proof-declared result mismatch",
      proof: () => finalCtfProof({ result: "lost" }),
      expected: "house_book_settlement_result_mismatch"
    },
    {
      name: "rejects a proof-kind mismatch",
      proof: () => finalCtfProof({ proofKind: "manual" }),
      expected: "house_book_settlement_result_mismatch"
    },
    {
      name: "rejects a proof-reference mismatch",
      proofReference: "manual",
      expected: "house_book_settlement_result_mismatch"
    },
    {
      name: "rejects a fabricated provider label",
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[0].provider = "operator-a"; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects a missing provider label",
      proof: () => proofWithEvidenceMutation((evidence) => { delete evidence[0].provider; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects a provider operator mismatch",
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[1].rpcOperator = "operator-a"; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects a provider host mismatch",
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[0].rpcHost = "fabricated.example"; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects a provider chain mismatch",
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[0].chainId = 1; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects a non-common proof block",
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[1].proofBlockNumber = 999; evidence[1].blockNumber = 999; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects a non-common proof block hash",
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[1].proofBlockHash = `0x${"7".repeat(64)}`; evidence[1].blockHash = `0x${"7".repeat(64)}`; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects proof beyond a provider finalized block",
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[0].finalizedBlockNumber = 999; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects a provider payout vector mismatch",
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[1].payoutNumerators = ["0", "1"]; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects a non-canonical provider read",
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[0].readMode = "latest"; evidence[0].blockHashReadSupported = false; }),
      expected: "house_book_settlement_malformed_provider_evidence"
    },
    {
      name: "rejects a quorum without distinct operators",
      setup: () => {
        config.POLYGON_RPC_ENDPOINTS[1].operator = "operator-a";
      },
      proof: () => proofWithEvidenceMutation((evidence) => { evidence[1].rpcOperator = "operator-a"; }),
      expected: "house_book_settlement_ctf_operator_quorum_unavailable"
    }
  ];

  it.each(houseIdentityMismatchCases)("$name", async ({ leg, proof, source, result, proofReference, setup, expected }) => {
    setup?.();
    mockHouseSettlementIdentityLock(lockedHouseLeg(leg));

    await expect(
      recordLegSettlement({
        ticketLegId: "ticket-leg-test",
        result: result || "won",
        source: source || "polymarket_ctf",
        proofReference: proofReference || "ctf_payout_vector",
        proof: (proof ? proof() : finalCtfProof()) as never,
        assertFinancialGateOpenInTransaction: vi.fn().mockResolvedValue(undefined) as never
      })
    ).rejects.toThrow(expected);
  });

  it("accepts a 50-50 payout vector only as a whole-ticket void", async () => {
    mockHouseSettlementIdentityLock(lockedHouseLeg({ status: "voided" }));
    const evidence = payoutProviderEvidence().map((item) => ({
      ...item,
      payoutDenominator: "2",
      payoutNumerators: ["1", "1"]
    }));

    const result = await recordLegSettlement({
      ticketLegId: "ticket-leg-test",
      result: "voided",
      source: "polymarket_ctf",
      proofReference: "ctf_partial_or_canceled_payout",
      proof: finalCtfProof({
        proofKind: "ctf_partial_or_canceled_payout",
        result: "voided",
        payoutNumerator: "1",
        payoutDenominator: "2",
        payoutVector: ["1", "1"],
        providerEvidence: evidence
      }) as never,
      assertFinancialGateOpenInTransaction: vi.fn().mockResolvedValue(undefined) as never
    });

    expect(result).toMatchObject({ legStatus: "voided", ticketStatus: "voided" });
  });

  it("accepts a matching Polymarket API result only after the persisted candidate is stable", async () => {
    mockApiSettlementIdentityLock();

    const result = await recordLegSettlement({
      ticketLegId: "ticket-leg-test",
      result: "won",
      source: "polymarket_api",
      proofReference: "polymarket_api_outcome",
      proof: finalApiProof() as never,
      assertFinancialGateOpenInTransaction: vi.fn().mockResolvedValue(undefined) as never
    });

    expect(result).toMatchObject({ ticketLegId: "ticket-leg-test", legStatus: "won" });
    expect(
      dbMocks.clientQuery.mock.calls.some(
        ([sql]) => String(sql).includes("proof_kind = 'polymarket_api_resolution_candidate'") && String(sql).includes("now() AS \"checkedAt\"")
      )
    ).toBe(true);
  });

  it("rejects API finality when proof metadata is old but the persisted candidate is too recent", async () => {
    mockApiSettlementIdentityLock({
      candidateCreatedAt: new Date("2026-07-21T09:02:30.000Z"),
      checkedAt: new Date("2026-07-21T09:03:00.000Z")
    });

    await expect(
      recordLegSettlement({
        ticketLegId: "ticket-leg-test",
        result: "won",
        source: "polymarket_api",
        proofReference: "polymarket_api_outcome",
        proof: finalApiProof() as never,
        assertFinancialGateOpenInTransaction: vi.fn().mockResolvedValue(undefined) as never
      })
    ).rejects.toThrow("house_book_settlement_api_stability_unproven");
  });

  it("rejects API finality when the persisted candidate fingerprint differs", async () => {
    mockApiSettlementIdentityLock({ candidateRaw: { fingerprint: "b".repeat(64) } });

    await expect(
      recordLegSettlement({
        ticketLegId: "ticket-leg-test",
        result: "won",
        source: "polymarket_api",
        proofReference: "polymarket_api_outcome",
        proof: finalApiProof() as never,
        assertFinancialGateOpenInTransaction: vi.fn().mockResolvedValue(undefined) as never
      })
    ).rejects.toThrow("house_book_settlement_api_candidate_mismatch");
  });

  it("opens the financial gate inside settlement transactions before the ledger moves", async () => {
    const calls: string[] = [];
    const assertGate = vi.fn(async () => {
      calls.push("financial-gate");
    });
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("ticket_legs.ticket_id, tickets.accounting_mode")) {
        return { rows: [{ ticket_id: "ticket-test", accounting_mode: "house_book_usdc" }] };
      }
      if (sql.includes("SELECT accounting_mode, status FROM tickets") && sql.includes("FOR UPDATE")) {
        return { rows: [{ accounting_mode: "house_book_usdc", status: "live" }] };
      }
      if (sql.includes("settlement_outcome_index AS \"settlementOutcomeIndex\"")) {
        return { rows: [lockedHouseLeg()] };
      }
      if (sql.includes("SELECT status") && sql.includes("FROM ticket_legs")) return { rows: [{ status: "won" }] };
      if (sql.includes("FROM tickets") && sql.includes("JOIN quotes")) {
        return {
          rows: [{
            user_id: "user-test",
            stake_micro_usd: "1000000",
            offered_payout_micro_usd: "2000000",
            accounting_mode: "house_book_usdc",
            funding_currency: "USDC"
          }]
        };
      }
      if (sql.includes("SELECT action") && sql.includes("FROM audit_log")) return { rows: [] };
      if (sql.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }] };
      if (sql.includes("FROM ticket_reserves")) return { rows: [] };
      if (sql.includes("INSERT INTO settlement_proofs")) return { rows: [{ id: "settlement-proof-test" }] };
      return { rows: [], rowCount: 1 };
    });

    await recordLegSettlement({
      ticketLegId: "ticket-leg-test",
      result: "won",
      source: "polymarket_ctf",
      proofReference: "ctf_payout_vector",
      proof: finalCtfProof() as never,
      assertFinancialGateOpenInTransaction: assertGate as never
    });

    expect(assertGate).toHaveBeenCalledWith(expect.any(Object), { operation: "ticket_settlement" });
    expect(calls.indexOf("financial-gate")).toBeGreaterThan(calls.findIndex((sql) => sql === "BEGIN"));
    expect(calls.indexOf("financial-gate")).toBeLessThan(calls.findIndex((sql) => sql.includes("FOR UPDATE")));
    expect(calls.indexOf("financial-gate")).toBeLessThan(calls.findIndex((sql) => sql.includes("INSERT INTO ledger_entries")));
  });

  it.each(["claimable", "paid"])("rejects automatic settlement mutation for %s tickets", async (status) => {
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("ticket_legs.ticket_id, tickets.accounting_mode")) {
        return { rows: [{ ticket_id: "ticket-test", accounting_mode: "play_money" }] };
      }
      if (sql.includes("SELECT accounting_mode, status FROM tickets") && sql.includes("FOR UPDATE")) {
        return { rows: [{ accounting_mode: "play_money", status }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      recordLegSettlement({
        ticketLegId: "ticket-leg-test",
        result: "won",
        source: "manual_ops"
      })
    ).rejects.toThrow("ticket_settlement_terminal_status");

    const statements = dbMocks.clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("UPDATE ticket_legs"))).toBe(false);
    expect(statements.some((sql) => sql.includes("INSERT INTO settlements"))).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });

  it("preserves an existing reserve release transaction when a historical ticket finalizes", async () => {
    const existingReleaseTransactionId = "22222222-2222-2222-2222-222222222222";
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("ticket_legs.ticket_id, tickets.accounting_mode")) {
        return { rows: [{ ticket_id: "ticket-test", accounting_mode: "play_money" }] };
      }
      if (sql.includes("SELECT accounting_mode, status FROM tickets") && sql.includes("FOR UPDATE")) {
        return { rows: [{ accounting_mode: "play_money", status: "lost" }] };
      }
      if (sql.includes("settlement_outcome_index AS \"settlementOutcomeIndex\"")) {
        return { rows: [{ ...lockedHouseLeg(), settlementSource: null }] };
      }
      if (sql.includes("SELECT status") && sql.includes("FROM ticket_legs")) {
        return { rows: [{ status: "won" }] };
      }
      if (sql.includes("FROM tickets") && sql.includes("JOIN quotes")) {
        return {
          rows: [{
            user_id: "user-test",
            stake_micro_usd: "1000000",
            offered_payout_micro_usd: "2000000",
            accounting_mode: "play_money",
            funding_currency: "USD"
          }]
        };
      }
      if (sql.includes("SELECT action") && sql.includes("FROM audit_log")) return { rows: [] };
      if (sql.includes("INSERT INTO ledger_accounts")) {
        return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }] };
      }
      if (sql.includes("FROM ticket_reserves")) {
        return {
          rows: [{
            id: "reserve-test",
            net_liability_micro_units: "1000000",
            status: "released",
            release_transaction_id: existingReleaseTransactionId
          }]
        };
      }
      if (sql.includes("INSERT INTO settlement_proofs")) {
        return { rows: [{ id: "settlement-proof-test" }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await recordLegSettlement({
      ticketLegId: "ticket-leg-test",
      result: "won",
      source: "manual_ops"
    });

    const reserveUpdate = dbMocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE ticket_reserves")
    );
    expect(reserveUpdate?.[1]).toEqual(["reserve-test", "paid", existingReleaseTransactionId]);

    const reserveReleaseInserts = dbMocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("ticket liability reserve released")
    );
    expect(reserveReleaseInserts).toHaveLength(0);
  });

  it("opens the financial gate before a real-money claim ledger move", async () => {
    const calls: string[] = [];
    const assertGate = vi.fn(async () => {
      calls.push("financial-gate");
    });
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM settlement_claims")) return { rows: [] };
      if (sql.includes("SELECT accounting_mode")) return { rows: [{ accounting_mode: "house_book_usdc" }] };
      return { rows: [] };
    });
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("FROM settlement_claims") && sql.includes("user_id = $1")) return { rows: [] };
      if (sql.includes("FROM tickets") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: "ticket-test", user_id: "user-test", status: "claimable", accounting_mode: "house_book_usdc", funding_currency: "USDC" }] };
      }
      if (sql.includes("FROM settlement_claims") && sql.includes("ticket_id = $1")) return { rows: [] };
      if (sql.includes("action = 'ticket.claimable'")) {
        return { rows: [{ metadata: { claimableMicroUnits: "1000000", currency: "USDC", accountingMode: "house_book_usdc" } }] };
      }
      if (sql.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }] };
      if (sql.includes("WHERE user_id IS NOT DISTINCT FROM")) return { rows: [{ id: "11111111-1111-1111-1111-111111111111" }] };
      if (sql.includes("COALESCE(sum(amount_micro_units)")) return { rows: [{ balance: "1000000" }] };
      return { rows: [], rowCount: 1 };
    });

    await claimTicketToAvailable({
      ticketId: "ticket-test",
      userId: "user-test",
      idempotencyKey: "claim-key",
      assertFinancialGateOpenInTransaction: assertGate as never
    });

    expect(assertGate).toHaveBeenCalledWith(expect.any(Object), { operation: "ticket_claim" });
    expect(calls.indexOf("financial-gate")).toBeGreaterThan(calls.findIndex((sql) => sql === "BEGIN"));
    expect(calls.indexOf("financial-gate")).toBeLessThan(calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock")));
    expect(calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(calls.findIndex((sql) => sql.includes("FOR UPDATE")));
    expect(calls.indexOf("financial-gate")).toBeLessThan(calls.findIndex((sql) => sql.includes("FOR UPDATE")));
    expect(calls.indexOf("financial-gate")).toBeLessThan(calls.findIndex((sql) => sql.includes("INSERT INTO ledger_entries")));
  });

  it("does not require the financial gate for play-money claims", async () => {
    const assertGate = vi.fn();
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM settlement_claims")) return { rows: [] };
      if (sql.includes("SELECT accounting_mode")) return { rows: [{ accounting_mode: "play_money" }] };
      return { rows: [] };
    });
    dbMocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM settlement_claims") && sql.includes("user_id = $1")) {
        return {
          rows: [{
            ticket_id: "ticket-test",
            amount_micro_units: "1000000",
            currency: "USD",
            ledger_transaction_id: "11111111-1111-1111-1111-111111111111",
            idempotency_key: "claim-key"
          }]
        };
      }
      return { rows: [] };
    });

    await claimTicketToAvailable({
      ticketId: "ticket-test",
      userId: "user-test",
      idempotencyKey: "claim-key",
      assertFinancialGateOpenInTransaction: assertGate as never
    });

    expect(assertGate).not.toHaveBeenCalled();
  });

  it("replays an existing claim for the same idempotency key without another ledger move", async () => {
    const assertGate = vi.fn().mockResolvedValue(undefined);
    dbMocks.query.mockResolvedValueOnce({
      rows: [
        {
          ticket_id: "ticket-test",
          amount_micro_units: "42000000",
          currency: "USDC",
          ledger_transaction_id: "11111111-1111-1111-1111-111111111111",
          idempotency_key: "claim-key"
        }
      ]
    });

    const claim = await claimTicketToAvailable({
      ticketId: "ticket-test",
      userId: "user-test",
      idempotencyKey: "claim-key",
      assertFinancialGateOpenInTransaction: assertGate as never
    });

    expect(claim).toMatchObject({
      ticketId: "ticket-test",
      userId: "user-test",
      status: "already_claimed",
      amountMicroUnits: "42000000",
      currency: "USDC"
    });
    expect(assertGate).not.toHaveBeenCalled();
    expect(dbMocks.clientQuery).not.toHaveBeenCalled();
    expect(String(dbMocks.query.mock.calls[0][0])).toContain("FROM settlement_claims");
  });
});
