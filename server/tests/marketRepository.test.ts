import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketOutcome } from "../../packages/domain/src/types";

const dbMocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  query: vi.fn(),
  release: vi.fn()
}));

vi.mock("../db/client", () => ({
  getPool: () => ({
    query: dbMocks.poolQuery,
    connect: async () => ({
      query: dbMocks.query,
      release: dbMocks.release
    })
  })
}));

import { getPersistedMarketCatalogPage, persistMarketCatalog } from "../db/marketRepository";
import type { MarketCatalogSnapshot } from "../marketCatalog";

function catalogFixture(complete: boolean): MarketCatalogSnapshot {
  return {
    asOf: "2026-07-13T00:00:00.000Z",
    source: "polymarket",
    complete,
    totalFeeds: 2,
    successfulFeeds: complete ? 2 : 1,
    outcomes: [
      {
        id: "election-yes",
        marketId: "election-market",
        conditionId: "condition-election",
        tokenId: "token-election-yes",
        question: "Will a Democrat win the US presidential election?",
        marketUrl: "https://polymarket.com/event/us-election",
        category: "Politics",
        sourceCategory: "Politics",
        sourceTags: ["US", "Election"],
        eventGroupKey: "polymarket:event:us-election",
        eventSlug: "us-election",
        eventTitle: "US Election",
        outcome: "Yes",
        price: 0.4,
        bestAsk: 0.4,
        executablePrice: 0.4,
        requestedNotionalUsd: 25,
        availableAskNotionalUsd: 100,
        priceSource: "clob_vwap",
        orderbookTimestamp: "2026-07-13T00:00:00.000Z",
        endDate: "2027-01-01T00:00:00.000Z",
        liquidity: 1_000,
        volume: 5_000,
        enableOrderBook: true,
        acceptingOrders: true,
        sourceActive: true,
        closed: false,
        archived: false,
        source: "polymarket"
      },
      {
        id: "election-no",
        marketId: "election-market",
        conditionId: "condition-election",
        tokenId: "token-election-no",
        question: "Will a Democrat win the US presidential election?",
        marketUrl: "https://polymarket.com/event/us-election",
        category: "Politics",
        sourceCategory: "Politics",
        sourceTags: ["US", "Election"],
        eventGroupKey: "polymarket:event:us-election",
        eventSlug: "us-election",
        eventTitle: "US Election",
        outcome: "No",
        price: 0.6,
        bestAsk: 0.6,
        executablePrice: 0.6,
        requestedNotionalUsd: 25,
        availableAskNotionalUsd: 100,
        priceSource: "clob_vwap",
        orderbookTimestamp: "2026-07-13T00:00:00.000Z",
        endDate: "2027-01-01T00:00:00.000Z",
        liquidity: 1_000,
        volume: 5_000,
        enableOrderBook: true,
        acceptingOrders: true,
        sourceActive: true,
        closed: false,
        archived: false,
        source: "polymarket"
      }
    ]
  };
}

function pageRow(marketId: string, volumeMicroUsd: string, capturedAt = "2026-07-13T00:00:00.000Z") {
  const outcome: MarketOutcome = {
    id: `${marketId}-yes`,
    marketId,
    conditionId: `${marketId}-condition`,
    tokenId: `${marketId}-token`,
    question: `Will ${marketId} happen?`,
    marketUrl: `https://polymarket.com/event/${marketId}`,
    category: "Politics",
    sourceCategory: "Politics",
    eventGroupKey: `polymarket:event:${marketId}`,
    eventTitle: marketId,
    eventSlug: marketId,
    outcome: "Yes",
    price: 0.4,
    bestAsk: 0.4,
    executablePrice: 0.4,
    requestedNotionalUsd: 25,
    availableAskNotionalUsd: 100,
    priceSource: "clob_vwap" as const,
    orderbookTimestamp: capturedAt,
    endDate: "2027-01-01T00:00:00.000Z",
    liquidity: 2_000,
    volume: Number(volumeMicroUsd) / 1_000_000,
    sourceActive: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    enableOrderBook: true,
    source: "polymarket" as const
  };
  return {
    outcome_id: `${marketId}-outcome-id`,
    source_market_id: marketId,
    sort_market_id: marketId,
    condition_id: `${marketId}-condition`,
    token_id: `${marketId}-token`,
    question: `Will ${marketId} happen?`,
    market_url: `https://polymarket.com/event/${marketId}`,
    category: "Politics",
    source_category: "Politics",
    canonical_category: "Politics",
    source_tags: [],
    taxonomy: {},
    event_group_key: `polymarket:event:${marketId}`,
    event_title: marketId,
    event_slug: marketId,
    relationship_metadata: {},
    eligibility_metadata: {},
    source_active: true,
    closed: false,
    archived: false,
    accepting_orders: true,
    enable_order_book: true,
    outcome: "Yes",
    end_date: new Date("2027-01-01T00:00:00.000Z"),
    neg_risk: false,
    rfq_enabled: false,
    captured_at: new Date(capturedAt),
    volume_micro_usd: volumeMicroUsd,
    liquidity_micro_usd: "2000000000",
    total_count: "2",
    cursor_value_1: volumeMicroUsd,
    cursor_value_2: "2000000000",
    cursor_value_3: capturedAt,
    snapshot_sequence: "42",
    outcome_order: 1,
    outcome_record: outcome,
    raw: {
      complete: true,
      totalFeeds: 1,
      successfulFeeds: 1,
      publiclyVisible: true,
      market: outcome,
      outcomes: [outcome]
    }
  };
}

beforeEach(() => {
  dbMocks.poolQuery.mockReset();
  dbMocks.query.mockReset();
  dbMocks.release.mockReset();
  dbMocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  dbMocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("NOT (source_market_id = ANY")) {
      return { rows: [], rowCount: 2 };
    }

    if (sql.includes("RETURNING id")) {
      return { rows: [{ id: "market-db-id" }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });
});

describe("market catalog persistence safety", () => {
  it("sets bounded transaction-local statement and lock timeouts", async () => {
    await persistMarketCatalog(catalogFixture(false), { statementTimeoutMs: 1_234, lockTimeoutMs: 321 });

    const timeoutSetup = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("set_config('statement_timeout'"));
    expect(timeoutSetup?.[1]).toEqual(["1234ms", "321ms"]);
  });

  it("persists source-eligible discovery records without index-time CLOB evidence", async () => {
    const catalog = catalogFixture(false);
    catalog.outcomes = catalog.outcomes.map((outcome) => ({
      ...outcome,
      bestAsk: undefined,
      executablePrice: undefined,
      requestedNotionalUsd: undefined,
      availableAskNotionalUsd: undefined,
      priceSource: undefined,
      orderbookTimestamp: undefined
    }));

    const result = await persistMarketCatalog(catalog, { now: new Date("2026-07-13T00:00:00.000Z") });

    expect(dbMocks.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO markets"))).toBe(true);
    expect(result).toMatchObject({ markets: 1, outcomes: 2, snapshots: 1 });
  });

  it("rolls back without market writes when the job aborts during sweep-state locking", async () => {
    const controller = new AbortController();
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) controller.abort(new Error("market_index_job_timeout:test"));
      return { rows: [], rowCount: 0 };
    });
    const catalog = {
      ...catalogFixture(false),
      sweep: {
        resource: "events" as const,
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 1,
        nextCursor: "cursor-two",
        complete: false,
        truncated: true,
        stoppedReason: "page_cap" as const
      }
    };

    await expect(persistMarketCatalog(catalog, { signal: controller.signal })).rejects.toThrow("market_index_job_timeout:test");

    const sqlCalls = dbMocks.query.mock.calls.map((call) => String(call[0]));
    expect(sqlCalls).toContain("ROLLBACK");
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO markets"))).toBe(false);
  });

  it("does not mark missing markets non-public after partial sweeps", async () => {
    const result = await persistMarketCatalog(catalogFixture(false));
    const sqlCalls = dbMocks.query.mock.calls.map((call) => String(call[0]));

    expect(sqlCalls.some((sql) => sql.includes("NOT (source_market_id = ANY"))).toBe(false);
    expect(result).toMatchObject({
      markedMissingMarketsNonPublic: false,
      missingMarketsMarkedNonPublic: 0
    });
  });

  it("does not reconcile missing markets from an unswept complete catalog", async () => {
    const result = await persistMarketCatalog(catalogFixture(true));
    const missingUpdate = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("NOT (source_market_id = ANY"));

    expect(missingUpdate).toBeUndefined();
    expect(result).toMatchObject({
      markedMissingMarketsNonPublic: false,
      missingMarketsMarkedNonPublic: 0,
      sweepGenerationComplete: false
    });
  });

  it("reconciles missing markets after a sweep-aware generation completes", async () => {
    const catalog = {
      ...catalogFixture(true),
      sweep: {
        resource: "events" as const,
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 5,
        complete: true,
        truncated: false,
        stoppedReason: "end" as const
      }
    };

    const result = await persistMarketCatalog(catalog, { now: new Date("2026-07-13T00:00:00.000Z") });
    const missingUpdate = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("NOT (source_market_id = ANY"));

    expect(missingUpdate?.[1]).toEqual([["election-market"], "2026-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z"]);
    expect(result).toMatchObject({
      markedMissingMarketsNonPublic: true,
      missingMarketsMarkedNonPublic: 2,
      sweepGenerationComplete: true
    });
  });

  it("persists explicit closed and inactive records as non-public during partial sweeps", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("source_market_id = ANY")) return { rows: [{ source_market_id: "election-market" }], rowCount: 1 };
      if (sql.includes("RETURNING id")) return { rows: [{ id: "market-db-id" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const catalog = catalogFixture(false);
    catalog.outcomes = catalog.outcomes.map((outcome) => ({
      ...outcome,
      sourceActive: false,
      closed: true
    }));

    await persistMarketCatalog(catalog);

    const marketUpsert = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO markets"));
    expect(marketUpsert?.[1][18]).toBe(false);
    expect(marketUpsert?.[1][20]).toBe(true);
    expect(marketUpsert?.[1][24]).toBe(false);
  });

  it("fails closed at ingest when a Gamma-active market ended after the feed was captured", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("source_market_id = ANY")) return { rows: [{ source_market_id: "election-market" }], rowCount: 1 };
      if (sql.includes("RETURNING id")) return { rows: [{ id: "market-db-id" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const catalog = catalogFixture(false);
    catalog.outcomes = catalog.outcomes.map((outcome) => ({
      ...outcome,
      endDate: "2026-07-13T12:00:00.000Z",
      sourceActive: true,
      closed: false,
      archived: false,
      acceptingOrders: true
    }));

    await persistMarketCatalog(catalog, { now: new Date("2026-07-14T00:00:00.000Z") });

    const marketUpsert = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO markets"));
    expect(marketUpsert?.[1][18]).toBe(false);
  });

  it("skips never-seen ineligible groups while retaining their sweep membership", async () => {
    const catalog = catalogFixture(false);
    catalog.outcomes = catalog.outcomes.map((outcome) => ({
      ...outcome,
      liquidity: 0,
      volume: 0
    }));
    catalog.sweep = {
      resource: "events",
      attemptedPages: 1,
      successfulPages: 1,
      maxPages: 1,
      nextCursor: "cursor-two",
      complete: false,
      truncated: true,
      stoppedReason: "page_cap"
    };

    const result = await persistMarketCatalog(catalog);
    const sweepUpdate = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO market_catalog_sweep_state"));

    expect(sweepUpdate?.[1][4]).toEqual(["election-market"]);
    expect(dbMocks.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO markets"))).toBe(false);
    expect(result).toMatchObject({ markets: 0, outcomes: 0, snapshots: 0 });
  });

  it("inserts a previously skipped group when a later sweep makes it eligible", async () => {
    const ineligible = catalogFixture(false);
    ineligible.outcomes = ineligible.outcomes.map((outcome) => ({
      ...outcome,
      liquidity: 0,
      volume: 0
    }));

    const now = new Date("2026-07-13T00:00:00.000Z");
    await persistMarketCatalog(ineligible, { now });
    const result = await persistMarketCatalog(catalogFixture(false), { now });

    const marketUpserts = dbMocks.query.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO markets"));
    expect(marketUpserts).toHaveLength(1);
    expect(result).toMatchObject({ markets: 1, outcomes: 2, snapshots: 1 });
  });

  it("prunes only older unreferenced snapshots for markets touched by the batch", async () => {
    await persistMarketCatalog(catalogFixture(false), { now: new Date("2026-07-13T00:00:00.000Z") });

    const prune = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("ranked_unreferenced"));
    const sql = String(prune?.[0]);

    expect(prune?.[1]).toEqual([["market-db-id"], 2]);
    expect(sql).toContain("ranked_unreferenced.snapshot_rank > $2::integer");
    expect(sql).toContain("quote_legs.market_snapshot_id = market_snapshots.id");
    expect(sql).toContain("ticket_legs.settlement_source_snapshot_id = market_snapshots.id");
  });

  it("bounds snapshot retention from MARKET_SNAPSHOT_UNREFERENCED_RETENTION", async () => {
    const original = process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION;
    process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION = "99";

    try {
      await persistMarketCatalog(catalogFixture(false), { now: new Date("2026-07-13T00:00:00.000Z") });
      const prune = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("ranked_unreferenced"));
      expect(prune?.[1]).toEqual([["market-db-id"], 10]);

      dbMocks.query.mockClear();
      process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION = "0";
      await persistMarketCatalog(catalogFixture(false), { now: new Date("2026-07-13T00:00:00.000Z") });
      const minimumPrune = dbMocks.query.mock.calls.find(([sql]) => String(sql).includes("ranked_unreferenced"));
      expect(minimumPrune?.[1]).toEqual([["market-db-id"], 1]);
    } finally {
      if (original === undefined) delete process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION;
      else process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION = original;
    }
  });

  it("uses all observed groups for complete-sweep reconciliation even when new rows are skipped", async () => {
    const catalog = catalogFixture(true);
    catalog.outcomes = catalog.outcomes.map((outcome) => ({
      ...outcome,
      liquidity: 0,
      volume: 0
    }));
    catalog.sweep = {
      resource: "events",
      attemptedPages: 1,
      successfulPages: 1,
      maxPages: 1,
      complete: true,
      truncated: false,
      stoppedReason: "end"
    };

    const result = await persistMarketCatalog(catalog, { now: new Date("2026-07-13T00:00:00.000Z") });
    const missingUpdate = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("NOT (source_market_id = ANY"));

    expect(missingUpdate?.[1][0]).toEqual(["election-market"]);
    expect(result).toMatchObject({ markets: 0, outcomes: 0, snapshots: 0, sweepGenerationComplete: true });
  });

  it("ignores tombstones for markets that have never been persisted", async () => {
    const catalog: MarketCatalogSnapshot = {
      ...catalogFixture(false),
      outcomes: [],
      tombstones: [
        {
          marketId: "unknown-market",
          question: "Was this unknown market archived?",
          category: "Other",
          sourceActive: false,
          closed: true,
          archived: false,
          source: "polymarket"
        }
      ]
    };

    const result = await persistMarketCatalog(catalog);
    const knownTombstoneLookup = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("source_market_id = ANY"));

    expect(knownTombstoneLookup?.[1]).toEqual([["unknown-market"]]);
    expect(dbMocks.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO markets"))).toBe(false);
    expect(dbMocks.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO market_outcomes"))).toBe(false);
    expect(dbMocks.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO market_snapshots"))).toBe(false);
    expect(result).toMatchObject({ markets: 0, outcomes: 0, snapshots: 0 });
  });

  it("updates known tombstones without normalized outcomes and creates snapshots", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("source_market_id = ANY")) {
        return {
          rows: [{ source_market_id: "settled-condition" }, { source_market_id: "archived-malformed" }],
          rowCount: 2
        };
      }

      if (sql.includes("RETURNING id")) return { rows: [{ id: "market-db-id" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const catalog: MarketCatalogSnapshot = {
      ...catalogFixture(false),
      outcomes: [],
      tombstones: [
        {
          marketId: "settled-condition",
          conditionId: "settled-condition",
          question: "Did the settled market resolve?",
          category: "Politics",
          sourceActive: false,
          closed: true,
          archived: false,
          acceptingOrders: false,
          source: "polymarket"
        },
        {
          marketId: "archived-malformed",
          question: "Was this malformed market archived?",
          category: "Other",
          sourceActive: true,
          closed: false,
          archived: true,
          source: "polymarket"
        }
      ],
      sweep: {
        resource: "events",
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 1,
        nextCursor: "cursor-two",
        complete: false,
        truncated: true,
        stoppedReason: "page_cap"
      }
    };

    const result = await persistMarketCatalog(catalog, { now: new Date("2026-07-13T00:00:00.000Z") });
    const knownTombstoneLookup = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("source_market_id = ANY"));
    const marketUpserts = dbMocks.query.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO markets"));
    const settledParams = marketUpserts.find((call) => call[1][1] === "settled-condition")?.[1];
    const archivedParams = marketUpserts.find((call) => call[1][1] === "archived-malformed")?.[1];

    expect(knownTombstoneLookup?.[1]).toEqual([["settled-condition", "archived-malformed"]]);
    expect(marketUpserts).toHaveLength(2);
    expect(settledParams?.[18]).toBe(false);
    expect(settledParams?.[20]).toBe(true);
    expect(settledParams?.[24]).toBe(false);
    expect(archivedParams?.[18]).toBe(false);
    expect(archivedParams?.[21]).toBe(true);
    expect(dbMocks.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO market_outcomes"))).toBe(false);
    expect(dbMocks.query.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO market_snapshots"))).toHaveLength(2);
    expect(result).toMatchObject({ markets: 2, outcomes: 0, snapshots: 2 });
  });

  it("excludes tombstone-only IDs from sweep membership", async () => {
    const catalog: MarketCatalogSnapshot = {
      ...catalogFixture(false),
      tombstones: [
        {
          marketId: "unknown-tombstone",
          question: "Was this unknown market closed?",
          category: "Other",
          sourceActive: false,
          closed: true,
          archived: false,
          source: "polymarket"
        }
      ],
      sweep: {
        resource: "events",
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 1,
        nextCursor: "cursor-two",
        complete: false,
        truncated: true,
        stoppedReason: "page_cap"
      }
    };

    await persistMarketCatalog(catalog, { now: new Date("2026-07-13T00:00:00.000Z") });

    const sweepUpdate = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO market_catalog_sweep_state"));
    const marketUpserts = dbMocks.query.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO markets"));

    expect(sweepUpdate?.[1][4]).toEqual(["election-market"]);
    expect(marketUpserts).toHaveLength(1);
    expect(marketUpserts[0][1][1]).toBe("election-market");
  });

  it("reconciles missing markets after a continued durable sweep reaches the end", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM market_catalog_sweep_state") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              source: "polymarket",
              resource: "events",
              generation_version: 2,
              generation_started_at: new Date("2026-07-13T00:00:00.000Z"),
              generation_started_after_cursor: null,
              next_cursor: "cursor-two",
              seen_market_ids: ["market-one"],
              attempted_pages: 1,
              successful_pages: 1,
              complete: false,
              truncated: true,
              stopped_reason: "page_cap",
              updated_at: new Date("2026-07-13T00:00:01.000Z"),
              completed_at: null
            }
          ],
          rowCount: 1
        };
      }

      if (sql.includes("NOT (source_market_id = ANY")) {
        return { rows: [], rowCount: 2 };
      }

      if (sql.includes("RETURNING id")) {
        return { rows: [{ id: "market-db-id" }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    });

    const catalog = {
      ...catalogFixture(false),
      sweep: {
        resource: "events" as const,
        expectedGenerationVersion: 2,
        startedAfterCursor: "cursor-two",
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 5,
        complete: false,
        truncated: false,
        stoppedReason: "end" as const
      }
    };

    const result = await persistMarketCatalog(catalog, { now: new Date("2026-07-13T00:00:00.000Z") });
    const missingUpdate = dbMocks.query.mock.calls.find((call) => String(call[0]).includes("NOT (source_market_id = ANY"));

    expect(missingUpdate?.[1]).toEqual([
      ["election-market", "market-one"],
      "2026-07-13T00:00:00.000Z",
      "2026-07-13T00:00:00.000Z"
    ]);
    expect(result).toMatchObject({
      markedMissingMarketsNonPublic: true,
      sweepGenerationComplete: true
    });
  });

  it("ignores a stale continuation page after another worker advances the cursor", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM market_catalog_sweep_state") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              source: "polymarket",
              resource: "events",
              generation_version: 2,
              generation_started_at: new Date("2026-07-13T00:00:00.000Z"),
              generation_started_after_cursor: null,
              next_cursor: "cursor-new",
              seen_market_ids: ["market-one", "market-two"],
              attempted_pages: 2,
              successful_pages: 2,
              complete: false,
              truncated: true,
              stopped_reason: "page_cap",
              updated_at: new Date("2026-07-13T00:00:02.000Z"),
              completed_at: null
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const catalog = {
      ...catalogFixture(false),
      sweep: {
        resource: "events" as const,
        expectedGenerationVersion: 2,
        startedAfterCursor: "cursor-old",
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 1,
        nextCursor: "cursor-new",
        complete: false,
        truncated: true,
        stoppedReason: "page_cap" as const
      }
    };

    const result = await persistMarketCatalog(catalog);
    const sqlCalls = dbMocks.query.mock.calls.map((call) => String(call[0]));

    expect(sqlCalls.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO market_catalog_sweep_state"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO markets"))).toBe(false);
    expect(result).toMatchObject({ staleSweepPageIgnored: true, markets: 0 });
  });

  it("ignores an overlapping first page while a generation is already in progress", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM market_catalog_sweep_state") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              source: "polymarket",
              resource: "events",
              generation_version: 1,
              generation_started_at: new Date("2026-07-13T00:00:00.000Z"),
              generation_started_after_cursor: null,
              next_cursor: "cursor-two",
              seen_market_ids: ["market-one"],
              attempted_pages: 1,
              successful_pages: 1,
              complete: false,
              truncated: true,
              stopped_reason: "page_cap",
              updated_at: new Date("2026-07-13T00:00:01.000Z"),
              completed_at: null
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const catalog = {
      ...catalogFixture(false),
      sweep: {
        resource: "events" as const,
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 1,
        nextCursor: "cursor-two",
        complete: false,
        truncated: true,
        stoppedReason: "page_cap" as const
      }
    };

    const result = await persistMarketCatalog(catalog);

    expect(result).toMatchObject({ staleSweepPageIgnored: true, markets: 0 });
    expect(dbMocks.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO markets"))).toBe(false);
  });

  it("rejects a late full first page after another worker completes the generation", async () => {
    dbMocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM market_catalog_sweep_state") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              source: "polymarket",
              resource: "events",
              generation_version: 1,
              generation_started_at: new Date("2026-07-13T00:00:00.000Z"),
              generation_started_after_cursor: null,
              next_cursor: null,
              seen_market_ids: ["market-one"],
              attempted_pages: 1,
              successful_pages: 1,
              complete: true,
              truncated: false,
              stopped_reason: "end",
              updated_at: new Date("2026-07-13T00:00:01.000Z"),
              completed_at: new Date("2026-07-13T00:00:01.000Z")
            }
          ],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const catalog = {
      ...catalogFixture(true),
      sweep: {
        resource: "events" as const,
        expectedGenerationVersion: 0,
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 5,
        complete: true,
        truncated: false,
        stoppedReason: "end" as const
      }
    };

    const result = await persistMarketCatalog(catalog);

    expect(result).toMatchObject({ staleSweepPageIgnored: true, markets: 0 });
    expect(dbMocks.query.mock.calls.some((call) => String(call[0]).includes("NOT (source_market_id = ANY"))).toBe(false);
    expect(dbMocks.query.mock.calls.some((call) => String(call[0]).includes("INSERT INTO markets"))).toBe(false);
  });
});

describe("market catalog public query", () => {
  it("uses keyset ordering and escaped ILIKE search", async () => {
    await expect(getPersistedMarketCatalogPage({ search: "50%_rain", limit: 10 })).rejects.toThrow(
      "No persisted market catalog available"
    );

    const [sql, params] = dbMocks.poolQuery.mock.calls[0];
    expect(String(sql)).toContain("ILIKE");
    expect(String(sql)).toContain("ESCAPE '\\'");
    expect(String(sql)).toContain("ORDER BY sort_value_1 DESC");
    expect(String(sql)).toContain("market_snapshots.captured_at <= $2::timestamptz");
    expect(String(sql)).toContain("market_snapshots.catalog_sequence <= snapshot_boundary.catalog_sequence");
    expect(String(sql)).toContain("candidate_markets AS MATERIALIZED");
    expect(String(sql)).toContain("SELECT id, source_market_id, end_date, current_snapshot_id");
    expect(String(sql)).toContain("first_page_candidate_markets AS MATERIALIZED");
    expect(String(sql)).not.toContain("candidate_markets AS MATERIALIZED (\n        SELECT *");
    expect(String(sql)).toContain("markets.end_date IS NULL OR markets.end_date > $3::timestamptz");
    expect(String(sql)).toContain("availableAskNotionalUsd");
    expect(String(sql)).toContain("requestedNotionalUsd");
    expect(String(sql)).toContain("orderbookTimestamp");
    expect(String(sql)).toContain("outcome_record->'sourceActive' = 'true'::jsonb");
    expect(String(sql)).toContain("outcome_record->'closed' = 'false'::jsonb");
    expect(String(sql)).toContain("NULLIF(btrim(catalog_outcome.outcome_record->>'conditionId'), '') IS NOT NULL");
    expect(String(sql)).toContain("NULLIF(btrim(catalog_outcome.outcome_record->>'tokenId'), '') IS NOT NULL");
    expect(String(sql)).not.toContain("COALESCE((catalog_outcome.outcome_record->>'sourceActive')::boolean, true)");
    expect(String(sql)).not.toContain("markets.publicly_visible");
    expect(String(sql)).not.toContain("markets.category");
    expect(String(sql)).not.toContain("markets.event_group_key");
    expect(String(sql)).not.toContain("JOIN market_outcomes");
    expect(String(sql)).not.toContain("markets.updated_at");
    expect(String(sql)).not.toContain(" OFFSET ");
    expect(params).toContain("%50\\%\\_rain%");
  });

  it("keeps the first-page snapshot boundary across an index refresh", async () => {
    dbMocks.poolQuery
      .mockResolvedValueOnce({ rows: [pageRow("market-a", "10000000000"), pageRow("market-b", "9000000000")], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [pageRow("market-b", "9000000000")], rowCount: 1 });

    const firstPage = await getPersistedMarketCatalogPage({ limit: 1, now: new Date("2026-07-13T00:00:10.000Z") });
    const secondPage = await getPersistedMarketCatalogPage({
      limit: 1,
      cursor: firstPage.pageInfo.nextCursor,
      now: new Date("2026-07-13T00:00:11.000Z")
    });
    const [secondSql, secondParams] = dbMocks.poolQuery.mock.calls[1];

    expect(firstPage.outcomes.map((outcome) => outcome.marketId)).toEqual(["market-a"]);
    expect(secondPage.outcomes.map((outcome) => outcome.marketId)).toEqual(["market-b"]);
    expect(secondParams[0]).toBe("42");
    expect(secondParams[1]).toBe("2026-07-13T00:00:10.000Z");
    expect(secondParams[2]).toBe("2026-07-13T00:00:11.000Z");
    expect(String(secondSql)).toContain("market_snapshots.captured_at <= $2::timestamptz");
    expect(String(secondSql)).toContain("market_snapshots.catalog_sequence <= snapshot_boundary.catalog_sequence");
    expect(String(secondSql)).not.toContain("markets.updated_at");
    expect(secondPage.outcomes[0]).toMatchObject({
      category: "Politics",
      eventGroupKey: "polymarket:event:market-b",
      eventTitle: "market-b"
    });
  });

  it("does not replay expired order-book evidence from an old cursor", async () => {
    dbMocks.poolQuery
      .mockResolvedValueOnce({ rows: [pageRow("market-a", "10000000000"), pageRow("market-b", "9000000000")], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [pageRow("market-b", "9000000000")], rowCount: 1 });

    const firstPage = await getPersistedMarketCatalogPage({ limit: 1, now: new Date("2026-07-13T00:00:10.000Z") });

    await expect(
      getPersistedMarketCatalogPage({
        limit: 1,
        cursor: firstPage.pageInfo.nextCursor,
        now: new Date("2026-07-13T00:05:00.000Z")
      })
    ).rejects.toThrow("No public persisted market catalog rows are currently eligible");
  });

  it("rejects persisted outcomes without fresh notional-backed depth", async () => {
    const row = pageRow("thin-market", "10000000000");
    row.outcome_record = {
      ...row.outcome_record,
      executablePrice: undefined,
      availableAskNotionalUsd: 1,
      priceSource: "gamma"
    };
    row.raw.outcomes = [row.outcome_record];
    dbMocks.poolQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    await expect(getPersistedMarketCatalogPage({ now: new Date("2026-07-13T00:00:10.000Z") })).rejects.toThrow(
      "No public persisted market catalog rows are currently eligible"
    );
  });

  it("fails closed for an expired outcome-level date even when legacy market metadata is future", async () => {
    const row = pageRow("legacy-outcome-date", "10000000000");
    row.outcome_record = {
      ...row.outcome_record,
      endDate: "2026-07-13T00:00:00.000Z"
    };
    row.raw.outcomes = [row.outcome_record];
    dbMocks.poolQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    await expect(getPersistedMarketCatalogPage({ now: new Date("2026-07-13T00:00:10.000Z") })).rejects.toThrow(
      "No public persisted market catalog rows are currently eligible"
    );
  });

  it("rejects cursor scope mismatches before querying", async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        v: 2,
        fp: "wrong-fingerprint",
        sort: "volume",
        snapshotAt: "2026-07-13T00:00:00.000Z",
        snapshotSequence: "42",
        values: ["1", "1", "2026-07-13T00:00:00.000Z"],
        marketId: "market-one"
      }),
      "utf8"
    ).toString("base64url");

    await expect(getPersistedMarketCatalogPage({ cursor, search: "world cup" })).rejects.toThrow("market_catalog_cursor_scope_mismatch");
    expect(dbMocks.poolQuery).not.toHaveBeenCalled();
  });
});
