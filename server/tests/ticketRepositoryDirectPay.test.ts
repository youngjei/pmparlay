import { beforeEach, describe, expect, it, vi } from "vitest";

const freezeMocks = vi.hoisted(() => ({
  prepareTicketSettlementIdentities: vi.fn(),
  validateAndFreezeTicketSettlementIdentitiesInTransaction: vi.fn()
}));

vi.mock("../db/settlementRepository", () => ({
  prepareTicketSettlementIdentities: freezeMocks.prepareTicketSettlementIdentities,
  validateAndFreezeTicketSettlementIdentitiesInTransaction: freezeMocks.validateAndFreezeTicketSettlementIdentitiesInTransaction
}));

import { acceptQuoteInTransaction } from "../db/ticketRepository";

const client = {
  query: vi.fn()
};

const userId = "00000000-0000-0000-0000-000000000001";
const allowFinancialGate = async () => ({
  allowed: true,
  launchGate: "ready" as const,
  operationGate: "open" as const,
  reasons: [],
  maxSnapshotAgeMs: 300_000
});

beforeEach(() => {
  client.query.mockReset();
  freezeMocks.prepareTicketSettlementIdentities.mockReset();
  freezeMocks.validateAndFreezeTicketSettlementIdentitiesInTransaction.mockReset();
});

describe("direct-pay ticket settlement identity gate", () => {
  it("validates frozen CTF identity before quote-accepted ledger and reserve writes", async () => {
    const candidateIdentities = [
      {
        ticketLegId: "ticket-leg-test",
        ticketId: "ticket-test",
        settlementSource: "polymarket_ctf",
        settlementChainId: 137,
        settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
        settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        settlementConditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
        settlementTokenId: "123",
        settlementOutcomeIndex: 0,
        settlementPayoutSlotCount: 2,
        settlementRulesSnapshotHash: "snapshot-hash-test",
        settlementSourceSnapshotId: "snapshot-test",
        settlementFrozenAt: "2026-07-13T12:00:31.000Z"
      }
    ];
    freezeMocks.prepareTicketSettlementIdentities.mockResolvedValueOnce(candidateIdentities);
    freezeMocks.validateAndFreezeTicketSettlementIdentitiesInTransaction.mockImplementationOnce(async (_client, input) => {
      const validation = await input.validateCandidateIdentity(candidateIdentities[0]);
      if (!validation.valid) throw new Error(validation.error);
      return [];
    });
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes("FROM quotes") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "quote-final",
              status: "quoted",
              user_id: userId,
              stake_micro_usd: "25000000",
              operation_fee_micro_usd: "500000",
              offered_payout_micro_usd: "90000000",
              risk_decision: "accept",
              expires_at: new Date("2099-07-13T12:00:45.000Z")
            }
          ]
        };
      }
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: params?.[1] }] };
      if (text.includes("SELECT id FROM ledger_accounts")) return { rows: [] };
      if (text.includes("COALESCE(sum(amount_micro_units)")) return { rows: [{ balance: "100000000" }] };
      if (text.includes("ORDER BY markets.source_market_id")) {
        return {
          rows: [
            {
              source_market_id: "btc-up",
              outcome: "Yes",
              market_url: "https://polymarket.com/event/btc-up"
            }
          ]
        };
      }
      if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (text.includes("open_market_exposure")) return { rows: [] };
      if (text.includes("open_event_exposure")) return { rows: [] };
      if (text.includes("open_user_exposure")) return { rows: [{ worst_case_liability_micro_usd: "0" }] };
      if (text.includes("UPDATE quotes SET status = 'accepted'")) return { rows: [] };
      if (text.includes("INSERT INTO tickets")) return { rows: [] };
      if (text.includes("INSERT INTO ticket_legs")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    });

    await expect(
      acceptQuoteInTransaction(client as never, "quote-final", userId, {
        accountingMode: "house_book_usdc",
        currency: "USDC",
        maxUserLiabilityUsd: 1000,
        maxMarketLiabilityUsd: 1000,
        maxEventLiabilityUsd: 1000,
        includeSoftReservations: true,
        excludePaymentIntentId: "11111111-1111-1111-1111-111111111111",
        assertFinancialGateOpenInTransaction: allowFinancialGate,
        requireSettlementIdentity: true,
        validateSettlementIdentity: async () => ({
          valid: false,
          retryable: false,
          providerEvidence: [],
          error: "ctf_position_id_mismatch"
        })
      })
    ).rejects.toThrow("ctf_position_id_mismatch");

    const calls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(calls.some((sql) => sql.includes("quote accepted"))).toBe(false);
    expect(calls.some((sql) => sql.includes("ticket liability reserved"))).toBe(false);
    expect(calls.some((sql) => sql.includes("INSERT INTO ticket_reserves"))).toBe(false);
  });

  it("keeps ledger and reserve arithmetic exact above the JavaScript safe-integer boundary", async () => {
    let gateChecked = false;
    const candidateIdentities = [
      {
        ticketLegId: "ticket-leg-test",
        ticketId: "ticket-test",
        settlementSource: "polymarket_ctf",
        settlementChainId: 137,
        settlementContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
        settlementCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        settlementConditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
        settlementTokenId: "123",
        settlementOutcomeIndex: 0,
        settlementPayoutSlotCount: 2,
        settlementRulesSnapshotHash: "snapshot-hash-test",
        settlementSourceSnapshotId: "snapshot-test",
        settlementFrozenAt: "2026-07-13T12:00:31.000Z"
      }
    ];
    freezeMocks.prepareTicketSettlementIdentities.mockResolvedValueOnce(candidateIdentities);
    freezeMocks.validateAndFreezeTicketSettlementIdentitiesInTransaction.mockImplementationOnce(async (_client, input) => {
      await input.validateCandidateIdentity(candidateIdentities[0]);
      return candidateIdentities;
    });

    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      expect(gateChecked).toBe(true);
      const text = String(sql);
      if (text.includes("FROM quotes") && text.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: "quote-final",
              status: "quoted",
              user_id: userId,
              stake_micro_usd: "9007199254740992",
              operation_fee_micro_usd: "500000",
              offered_payout_micro_usd: "9007199255740993",
              risk_decision: "accept",
              expires_at: new Date("2099-07-13T12:00:45.000Z")
            }
          ]
        };
      }
      if (text.includes("INSERT INTO ledger_accounts")) return { rows: [{ id: String(params?.[1]) }] };
      if (text.includes("COALESCE(sum(amount_micro_units)")) return { rows: [{ balance: "10000000000000000" }] };
      if (text.includes("ORDER BY markets.source_market_id")) {
        return {
          rows: [
            {
              source_market_id: "btc-up",
              outcome: "Yes",
              market_url: "https://polymarket.com/event/btc-up"
            }
          ]
        };
      }
      if (text.includes("open_user_exposure")) return { rows: [{ worst_case_liability_micro_usd: "0" }] };
      return { rows: [] };
    });

    await expect(
      acceptQuoteInTransaction(client as never, "quote-final", userId, {
        accountingMode: "house_book_usdc",
        currency: "USDC",
        maxUserLiabilityUsd: 1000,
        maxMarketLiabilityUsd: 1000,
        maxEventLiabilityUsd: 1000,
        assertFinancialGateOpenInTransaction: async () => {
          gateChecked = true;
          return allowFinancialGate();
        },
        requireSettlementIdentity: true,
        validateSettlementIdentity: async () => ({
          valid: true,
          retryable: false,
          providerEvidence: []
        })
      })
    ).resolves.toMatchObject({
      quoteId: "quote-final",
      accountingMode: "house_book_usdc"
    });

    const acceptedLedgerWrite = client.query.mock.calls.find(([sql]) => String(sql).includes("'quote accepted'"));
    expect(acceptedLedgerWrite?.[1]?.[2]).toBe("-9007199255240992");
    expect(acceptedLedgerWrite?.[1]?.[4]).toBe("9007199255240992");

    const reserveWrite = client.query.mock.calls.find(([sql]) => String(sql).includes("'ticket liability reserved'"));
    expect(reserveWrite?.[1]?.[2]).toBe("-1000001");
    expect(reserveWrite?.[1]?.[5]).toBe("1000001");

    const ticketReserveWrite = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO ticket_reserves"));
    expect(ticketReserveWrite?.[1]?.slice(4, 8)).toEqual([
      "9007199254740992",
      "500000",
      "9007199255740993",
      "1000001"
    ]);
  });
});
