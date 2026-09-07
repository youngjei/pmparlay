import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({ query: dbMocks.query })
}));

import { getTicket, listClaimableTickets } from "../db/ticketRepository";

const userA = "00000000-0000-0000-0000-000000000001";
const userB = "00000000-0000-0000-0000-000000000002";

function ticketId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function row(
  index: number,
  createdAt: string,
  options: { userId?: string; voided?: boolean; status?: "claimable" | "won" | "voided"; finalPayoutMicroUsd?: string | null } = {}
) {
  const cursorCreatedAt = createdAt.replace(/\.(\d{3})Z$/, ".$1000Z");
  return {
    userId: options.userId || userA,
    ticketId: ticketId(index),
    quoteId: `quote-${index}`,
    status: options.status || "claimable",
    createdAt: new Date(createdAt),
    cursorCreatedAt,
    updatedAt: new Date(createdAt),
    stakeMicroUsd: "25000000",
    operationFeeMicroUsd: "1000000",
    potentialPayoutMicroUsd: "100000000",
    accountingMode: "house_book_usdc",
    currency: "USDC",
    legs: "2",
    pendingLegs: "0",
    wonLegs: options.voided ? "1" : "2",
    lostLegs: "0",
    voidedLegs: options.voided ? "1" : "0",
    disputedLegs: "0",
    finalPayoutMicroUsd: options.finalPayoutMicroUsd ?? null
  };
}

beforeEach(() => {
  dbMocks.query.mockReset();
});

describe("claimable ticket discovery", () => {
  it("uses a user-scoped keyset so claimable tickets older than the newest 50 remain discoverable", async () => {
    const rows = [
      ...Array.from({ length: 52 }, (_, index) => row(index + 1, `2026-07-10T00:${String(59 - index).padStart(2, "0")}:00.000Z`)),
      row(53, "2026-07-09T00:00:00.000Z"),
      row(54, "2026-07-11T00:00:00.000Z", { userId: userB }),
      row(55, "2026-07-11T00:01:00.000Z", { status: "won" })
    ];

    dbMocks.query.mockImplementation(async (sql: string, params: [string, string | null, string | null, number]) => {
      expect(sql).toContain("tickets.user_id = $1");
      expect(sql).toContain("tickets.status = 'claimable'");
      expect(sql).toContain("tickets.created_at DESC, tickets.id DESC");
      expect(sql).not.toContain("tickets.status IN");

      const [requestedUserId, cursorCreatedAt, cursorTicketId, limit] = params;
      const filtered = rows
        .filter((candidate) => candidate.userId === requestedUserId && candidate.status === "claimable")
        .filter((candidate) => {
          if (!cursorCreatedAt || !cursorTicketId) return true;
          return (
            candidate.cursorCreatedAt < cursorCreatedAt ||
            (candidate.cursorCreatedAt === cursorCreatedAt && candidate.ticketId < cursorTicketId)
          );
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.ticketId.localeCompare(a.ticketId));
      return { rows: filtered.slice(0, limit) };
    });

    const firstPage = await listClaimableTickets(userA, { limit: 50 });

    expect(firstPage.tickets).toHaveLength(50);
    expect(firstPage.tickets.map((ticket) => ticket.ticketId)).toEqual(Array.from({ length: 50 }, (_, index) => ticketId(index + 1)));
    expect(firstPage.pageInfo.hasMore).toBe(true);
    expect(firstPage.pageInfo.nextCursor).toEqual(expect.any(String));

    const secondPage = await listClaimableTickets(userA, {
      limit: 50,
      cursor: firstPage.pageInfo.nextCursor
    });

    expect(secondPage.tickets.map((ticket) => ticket.ticketId)).toEqual([ticketId(51), ticketId(52), ticketId(53)]);
    expect(secondPage.pageInfo).toEqual({ limit: 50, hasMore: false, nextCursor: undefined });
    expect(dbMocks.query.mock.calls.every(([, params]) => params[0] === userA)).toBe(true);
  });

  it("reads a partial-void winner's immutable final payout", async () => {
    dbMocks.query.mockResolvedValueOnce({
      rows: [
        row(1, "2026-07-10T00:01:00.000Z"),
        row(2, "2026-07-10T00:00:00.000Z", { voided: true, finalPayoutMicroUsd: "40000000" })
      ]
    });

    const page = await listClaimableTickets(userA, { limit: 10 });

    expect(page.tickets.map((ticket) => ticket.claimableAmountUsd)).toEqual([100, 40]);
  });

  it("carries PostgreSQL's six-digit UTC cursor timestamp without converting it through Date", async () => {
    dbMocks.query.mockResolvedValueOnce({
      rows: [
        {
          ...row(1, "2026-07-10T00:00:00.123Z"),
          cursorCreatedAt: "2026-07-10T00:00:00.123456Z"
        },
        {
          ...row(2, "2026-07-10T00:00:00.123Z"),
          cursorCreatedAt: "2026-07-10T00:00:00.123455Z"
        }
      ]
    });

    const page = await listClaimableTickets(userA, { limit: 1 });
    const cursor = JSON.parse(Buffer.from(page.pageInfo.nextCursor!, "base64url").toString("utf8"));

    expect(cursor).toEqual({
      createdAt: "2026-07-10T00:00:00.123456Z",
      ticketId: ticketId(1)
    });
  });

  it("does not expose an all-void automatic stake return as claimable winnings", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM tickets") && sql.includes("purchase_payment")) {
        return {
          rows: [
            {
              ...row(1, "2026-07-10T00:00:00.000Z", {
                voided: true,
                status: "voided",
                finalPayoutMicroUsd: "25000000"
              }),
              purchaseTxHash: null,
              purchaseChainId: null
            }
          ]
        };
      }
      if (sql.includes("FROM ticket_legs")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const ticket = await getTicket(ticketId(1), userA);

    expect(ticket).toMatchObject({ status: "voided", claimableAmountUsd: 0 });
  });
});
