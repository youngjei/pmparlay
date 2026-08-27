import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MarketOutcome } from "../../packages/domain/src/types";
import type { MarketCatalogSnapshot } from "../marketCatalog";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = testDatabaseUrl ? describe : describe.skip;
const schema = `market_catalog_test_${process.pid}_${randomBytes(5).toString("hex")}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
let admin: pg.Client;
let repository: typeof import("../db/marketRepository");
let closePool: typeof import("../db/client").closePool;

function schemaConnectionString(connectionString: string) {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

function indexedOutcome(marketId: string, volume: number, asOf: string, category = "Politics", eventSuffix = "original"): MarketOutcome {
  return {
    id: `${marketId}-yes`,
    marketId,
    conditionId: `${marketId}-condition`,
    tokenId: `${marketId}-token`,
    question: `Will ${marketId} happen?`,
    marketUrl: `https://polymarket.com/event/${marketId}`,
    category,
    sourceCategory: category,
    sourceTags: [category],
    eventGroupKey: `polymarket:event:${marketId}-${eventSuffix}`,
    eventTitle: `${marketId} ${eventSuffix}`,
    eventSlug: `${marketId}-${eventSuffix}`,
    outcome: "Yes",
    price: 0.4,
    bestBid: 0.39,
    bestAsk: 0.4,
    executablePrice: 0.4,
    vwapPrice: 0.4,
    requestedNotionalUsd: 25,
    availableAskNotionalUsd: 100,
    spread: 0.01,
    priceSource: "clob_vwap",
    orderbookTimestamp: asOf,
    orderbookHash: `${marketId}-${asOf}`,
    sourceAsOf: asOf,
    endDate: "2027-01-01T00:00:00.000Z",
    liquidity: 2_000,
    volume,
    enableOrderBook: true,
    acceptingOrders: true,
    sourceActive: true,
    closed: false,
    archived: false,
    source: "polymarket"
  };
}

function catalog(asOf: string, outcomes: MarketOutcome[], sweep?: MarketCatalogSnapshot["sweep"]): MarketCatalogSnapshot {
  return {
    asOf,
    source: "polymarket",
    outcomes,
    complete: sweep?.complete ?? true,
    totalFeeds: 1,
    successfulFeeds: 1,
    sweep
  };
}

describeWithPostgres("market repository PostgreSQL integration", () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await admin.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}", public`);

    const migrationsDir = path.resolve("server/db/migrations");
    for (const migration of ["0001_core.sql", "0021_market_catalog_integrity.sql", "0025_market_catalog_sweep_state.sql"]) {
      await admin.query(await readFile(path.join(migrationsDir, migration), "utf8"));
    }
    await admin.query(
      "ALTER TABLE ticket_legs ADD COLUMN settlement_source_snapshot_id UUID REFERENCES market_snapshots(id)"
    );
    await admin.query(await readFile(path.join(migrationsDir, "0030_market_snapshot_retention_indexes.sql"), "utf8"));
    await admin.query(await readFile(path.join(migrationsDir, "0031_market_source_outcome_identity.sql"), "utf8"));
    await admin.query(await readFile(path.join(migrationsDir, "0039_market_latest_snapshot_pointer.sql"), "utf8"));

    process.env.DATABASE_URL = schemaConnectionString(testDatabaseUrl!);
    process.env.NODE_ENV = "test";
    vi.resetModules();
    repository = await import("../db/marketRepository");
    ({ closePool } = await import("../db/client"));
  }, 30_000);

  afterAll(async () => {
    await closePool?.();
    if (admin) {
      await admin.query("SET search_path TO public");
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }, 30_000);

  it("serializes overlapping sweep pages and advances generation state once", async () => {
    const asOf = new Date().toISOString();
    const sweep: NonNullable<MarketCatalogSnapshot["sweep"]> = {
      resource: "events",
      expectedGenerationVersion: 0,
      attemptedPages: 1,
      successfulPages: 1,
      maxPages: 1,
      nextCursor: "cursor-two",
      complete: false,
      truncated: true,
      stoppedReason: "page_cap"
    };
    const page = catalog(asOf, [indexedOutcome("concurrent-market", 10_000, asOf)], sweep);

    const results = await Promise.all([repository.persistMarketCatalog(page), repository.persistMarketCatalog(page)]);
    const state = await admin.query(`SELECT generation_version, next_cursor, seen_market_ids FROM "${schema}".market_catalog_sweep_state`);
    const snapshots = await admin.query(`SELECT count(*)::integer AS count FROM "${schema}".market_snapshots`);

    expect(results.filter((result) => result.staleSweepPageIgnored)).toHaveLength(1);
    expect(results.filter((result) => !result.staleSweepPageIgnored)).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ generation_version: 1, next_cursor: "cursor-two", seen_market_ids: ["concurrent-market"] });
    expect(snapshots.rows[0].count).toBe(1);
  });

  it("preserves the last full-sweep completion while the next generation is in progress", async () => {
    await admin.query(`DELETE FROM "${schema}".market_catalog_sweep_state`);

    const completedAsOf = new Date().toISOString();
    await repository.persistMarketCatalog(
      catalog(completedAsOf, [indexedOutcome("completed-sweep-market", 10_000, completedAsOf)], {
        resource: "events",
        expectedGenerationVersion: 0,
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 1,
        complete: true,
        truncated: false,
        stoppedReason: "end"
      })
    );
    const completedState = await admin.query(
      `SELECT generation_version, completed_at FROM "${schema}".market_catalog_sweep_state WHERE source = 'polymarket'`
    );

    const progressAsOf = new Date().toISOString();
    await repository.persistMarketCatalog(
      catalog(progressAsOf, [indexedOutcome("next-sweep-market", 10_000, progressAsOf)], {
        resource: "events",
        expectedGenerationVersion: completedState.rows[0].generation_version,
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 2,
        nextCursor: "next-generation-cursor",
        complete: false,
        truncated: true,
        stoppedReason: "page_cap"
      })
    );
    const inProgressState = await admin.query(
      `SELECT complete, next_cursor, completed_at FROM "${schema}".market_catalog_sweep_state WHERE source = 'polymarket'`
    );

    expect(completedState.rows[0].completed_at).toBeInstanceOf(Date);
    expect(inProgressState.rows[0]).toMatchObject({ complete: false, next_cursor: "next-generation-cursor" });
    expect(inProgressState.rows[0].completed_at?.getTime()).toBe(completedState.rows[0].completed_at.getTime());
  });

  it("preserves a quote-referenced market and snapshot when the market becomes a tombstone", async () => {
    const asOf = new Date().toISOString();
    await repository.persistMarketCatalog(catalog(asOf, [indexedOutcome("quoted-tombstone", 10_000, asOf)]));

    const persisted = await admin.query(
      `
        SELECT markets.id AS market_id, market_outcomes.id AS outcome_id, market_snapshots.id AS snapshot_id
        FROM "${schema}".markets
        JOIN "${schema}".market_outcomes ON market_outcomes.market_id = markets.id
        JOIN "${schema}".market_snapshots ON market_snapshots.market_id = markets.id
        WHERE markets.source_market_id = 'quoted-tombstone'
        ORDER BY market_snapshots.catalog_sequence DESC
        LIMIT 1
      `
    );
    const { market_id: marketId, outcome_id: outcomeId, snapshot_id: snapshotId } = persisted.rows[0];
    const policy = await admin.query(
      `INSERT INTO "${schema}".policy_versions (version, description, policy) VALUES ('tombstone-preservation', 'test', '{}'::jsonb) RETURNING id`
    );
    const quote = await admin.query(
      `
        INSERT INTO "${schema}".quotes (
          policy_version_id, status, stake_micro_usd, operation_fee_micro_usd, spread_bps,
          implied_probability_bps, offered_payout_micro_usd, expires_at
        )
        VALUES ($1, 'quoted', 1, 0, 0, 5_000, 2, now() + interval '1 hour')
        RETURNING id
      `,
      [policy.rows[0].id]
    );
    await admin.query(
      `
        INSERT INTO "${schema}".quote_legs (
          quote_id, market_id, outcome_id, market_snapshot_id, outcome, quoted_price_bps
        )
        VALUES ($1, $2, $3, $4, 'Yes', 4_000)
      `,
      [quote.rows[0].id, marketId, outcomeId, snapshotId]
    );

    await repository.persistMarketCatalog({
      ...catalog(asOf, []),
      tombstones: [
        {
          marketId: "quoted-tombstone",
          conditionId: "quoted-tombstone-condition",
          question: "Will quoted-tombstone happen?",
          category: "Politics",
          sourceActive: false,
          closed: true,
          archived: false,
          acceptingOrders: false,
          source: "polymarket"
        }
      ]
    });

    const preserved = await admin.query(
      `
        SELECT
          markets.publicly_visible,
          markets.closed,
          (SELECT count(*)::integer FROM "${schema}".market_snapshots WHERE market_id = $1) AS snapshot_count,
          EXISTS (SELECT 1 FROM "${schema}".market_snapshots WHERE id = $2) AS quoted_snapshot_exists,
          EXISTS (
            SELECT 1 FROM "${schema}".quote_legs
            WHERE quote_id = $3 AND market_id = $1 AND market_snapshot_id = $2
          ) AS quote_leg_exists
        FROM "${schema}".markets
        WHERE markets.id = $1
      `,
      [marketId, snapshotId, quote.rows[0].id]
    );

    expect(preserved.rows[0]).toMatchObject({
      publicly_visible: false,
      closed: true,
      snapshot_count: 2,
      quoted_snapshot_exists: true,
      quote_leg_exists: true
    });
  });

  it("maintains the current snapshot pointer without regressing to an older snapshot", async () => {
    const initialAsOf = new Date(Date.now() + 10_000).toISOString();
    const refreshedAsOf = new Date(new Date(initialAsOf).getTime() + 1_000).toISOString();
    await repository.persistMarketCatalog(catalog(initialAsOf, [indexedOutcome("pointer-maintenance", 10_000, initialAsOf)]));
    await repository.persistMarketCatalog(catalog(refreshedAsOf, [indexedOutcome("pointer-maintenance", 20_000, refreshedAsOf)]));

    const current = await admin.query(
      `
        SELECT markets.id AS market_id, markets.current_snapshot_id, market_snapshots.catalog_sequence
        FROM "${schema}".markets
        JOIN "${schema}".market_snapshots ON market_snapshots.id = markets.current_snapshot_id
        WHERE markets.source_market_id = 'pointer-maintenance'
      `
    );
    const { market_id: marketId, current_snapshot_id: currentSnapshotId, catalog_sequence: currentSequence } = current.rows[0];

    await admin.query(
      `
        INSERT INTO "${schema}".market_snapshots (
          market_id, captured_at, source_response_hash, volume_micro_usd, liquidity_micro_usd, raw, catalog_sequence
        )
        VALUES ($1, $2, 'stale-pointer-test', 1, 1, '{"outcomes": []}'::jsonb, $3::bigint - 1)
      `,
      [marketId, initialAsOf, currentSequence]
    );

    const afterStaleInsert = await admin.query(
      `SELECT current_snapshot_id FROM "${schema}".markets WHERE id = $1`,
      [marketId]
    );
    expect(afterStaleInsert.rows[0].current_snapshot_id).toBe(currentSnapshotId);

    await admin.query(`DELETE FROM "${schema}".market_snapshots WHERE id = $1`, [currentSnapshotId]);
    const afterCurrentDelete = await admin.query(
      `
        SELECT markets.current_snapshot_id, market_snapshots.catalog_sequence
        FROM "${schema}".markets
        JOIN "${schema}".market_snapshots ON market_snapshots.id = markets.current_snapshot_id
        WHERE markets.id = $1
      `,
      [marketId]
    );
    expect(Number(afterCurrentDelete.rows[0].catalog_sequence)).toBe(Number(currentSequence) - 1);
  });

  it("backfills the newest snapshot pointer for an existing market", async () => {
    const initialAsOf = new Date(Date.now() + 20_000).toISOString();
    const refreshedAsOf = new Date(new Date(initialAsOf).getTime() + 1_000).toISOString();
    await repository.persistMarketCatalog(catalog(initialAsOf, [indexedOutcome("pointer-backfill", 10_000, initialAsOf)]));
    await repository.persistMarketCatalog(catalog(refreshedAsOf, [indexedOutcome("pointer-backfill", 20_000, refreshedAsOf)]));

    const expected = await admin.query(
      `
        SELECT market_snapshots.id
        FROM "${schema}".market_snapshots
        JOIN "${schema}".markets ON markets.id = market_snapshots.market_id
        WHERE markets.source_market_id = 'pointer-backfill'
        ORDER BY market_snapshots.catalog_sequence DESC, market_snapshots.id DESC
        LIMIT 1
      `
    );
    await admin.query(
      `UPDATE "${schema}".markets SET current_snapshot_id = NULL WHERE source_market_id = 'pointer-backfill'`
    );
    const backfillMigration = await readFile(
      path.join(path.resolve("server/db/migrations"), "0040_backfill_market_latest_snapshot_pointer.sql"),
      "utf8"
    );
    expect(backfillMigration).toContain("pg_advisory_xact_lock(hashtext('market_catalog_sweep_state:polymarket'))");
    await admin.query("BEGIN");
    await admin.query(backfillMigration);
    await admin.query("COMMIT");

    const backfilled = await admin.query(
      `SELECT current_snapshot_id FROM "${schema}".markets WHERE source_market_id = 'pointer-backfill'`
    );
    const constraint = await admin.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'markets_current_snapshot_id_fkey' AND connamespace = $1::regnamespace`,
      [schema]
    );
    expect(backfilled.rows[0].current_snapshot_id).toBe(expected.rows[0].id);
    expect(constraint.rows[0].convalidated).toBe(true);
  });

  it("keeps the production default of two unreferenced snapshots", async () => {
    const base = Date.now();
    for (let index = 0; index < 5; index += 1) {
      const asOf = new Date(base + index * 1_000).toISOString();
      await repository.persistMarketCatalog(catalog(asOf, [indexedOutcome("bounded-snapshots", 10_000 + index, asOf, "Politics", `revision-${index}`)]));
    }

    const snapshots = await admin.query(
      `
        SELECT count(*)::integer AS count
        FROM "${schema}".market_snapshots
        JOIN "${schema}".markets ON markets.id = market_snapshots.market_id
        WHERE markets.source_market_id = 'bounded-snapshots'
      `
    );

    expect(snapshots.rows[0].count).toBe(2);
  });

  it("honors the bounded MARKET_SNAPSHOT_UNREFERENCED_RETENTION override", async () => {
    const originalRetention = process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION;
    process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION = "3";

    try {
      const base = Date.now();
      for (let index = 0; index < 5; index += 1) {
        const asOf = new Date(base + index * 1_000).toISOString();
        await repository.persistMarketCatalog(
          catalog(asOf, [indexedOutcome("configured-retention", 10_000 + index, asOf, "Politics", `revision-${index}`)])
        );
      }

      const snapshots = await admin.query(
        `
          SELECT count(*)::integer AS count
          FROM "${schema}".market_snapshots
          JOIN "${schema}".markets ON markets.id = market_snapshots.market_id
          WHERE markets.source_market_id = 'configured-retention'
        `
      );

      expect(snapshots.rows[0].count).toBe(3);
    } finally {
      if (originalRetention === undefined) delete process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION;
      else process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION = originalRetention;
    }
  });

  it("prunes the reconciliation snapshot of a market missing from a complete sweep", async () => {
    const base = Date.now();
    for (let index = 0; index < 3; index += 1) {
      const asOf = new Date(base + index * 1_000).toISOString();
      await repository.persistMarketCatalog(catalog(asOf, [indexedOutcome("missing-after-sweep", 10_000 + index, asOf)]));
    }

    const sweepAt = new Date(base + 4_000).toISOString();
    const currentSweep = await admin.query(
      `SELECT generation_version, next_cursor FROM "${schema}".market_catalog_sweep_state WHERE source = 'polymarket' AND resource = 'events'`
    );
    await repository.persistMarketCatalog(
      catalog(sweepAt, [indexedOutcome("still-observed", 20_000, sweepAt)], {
        resource: "events",
        expectedGenerationVersion: currentSweep.rows[0]?.generation_version || 0,
        startedAfterCursor: currentSweep.rows[0]?.next_cursor || undefined,
        attemptedPages: 1,
        successfulPages: 1,
        maxPages: 1,
        complete: true,
        truncated: false,
        stoppedReason: "end"
      })
    );

    const result = await admin.query(
      `
        SELECT markets.publicly_visible, count(market_snapshots.id)::integer AS snapshot_count
        FROM "${schema}".markets
        JOIN "${schema}".market_snapshots ON market_snapshots.market_id = markets.id
        WHERE markets.source_market_id = 'missing-after-sweep'
        GROUP BY markets.id
      `
    );

    expect(result.rows[0]).toMatchObject({ publicly_visible: false, snapshot_count: 2 });
  });

  it("loads Gamma-only discovery outcomes exactly before request-time CLOB hydration", async () => {
    const asOf = new Date().toISOString();
    const discoveryOutcome = {
      ...indexedOutcome("gamma-only", 10_000, asOf),
      bestBid: undefined,
      bestAsk: undefined,
      executablePrice: undefined,
      vwapPrice: undefined,
      requestedNotionalUsd: undefined,
      availableAskNotionalUsd: undefined,
      spread: undefined,
      priceSource: "gamma" as const,
      orderbookTimestamp: undefined,
      orderbookHash: undefined
    };
    await repository.persistMarketCatalog(catalog(asOf, [discoveryOutcome]), { now: new Date(asOf) });

    const exact = await repository.getPersistedMarketOutcomesByIds([discoveryOutcome.id], {
      now: new Date(asOf),
      maxSnapshotAgeMs: 60_000
    });
    const candidates = await repository.getPersistedMarketCatalogPage({
      now: new Date(asOf),
      requireFreshOrderBook: false,
      maxSnapshotAgeMs: 60_000
    });

    expect(exact).toMatchObject({ complete: true });
    expect(exact.outcomes).toHaveLength(1);
    expect(exact.outcomes[0]).toMatchObject({ id: discoveryOutcome.id, priceSource: "gamma" });
    expect(candidates.outcomes.some((outcome) => outcome.id === discoveryOutcome.id)).toBe(true);
    const executableOnly = await repository.getPersistedMarketCatalogPage({
      now: new Date(asOf),
      requireFreshOrderBook: true,
      maxSnapshotAgeMs: 60_000
    });
    expect(executableOnly.outcomes.some((outcome) => outcome.id === discoveryOutcome.id)).toBe(false);
  });

  it("keeps visibility, category, and event grouping pinned across a concurrent refresh", async () => {
    const firstAsOf = new Date(Date.now() + 1_000).toISOString();
    const firstOutcomes = [
      indexedOutcome("snapshot-a", 30_000, firstAsOf),
      indexedOutcome("snapshot-b", 20_000, firstAsOf),
      indexedOutcome("snapshot-c", 10_000, firstAsOf)
    ];
    await repository.persistMarketCatalog(catalog(firstAsOf, firstOutcomes));

    const firstPage = await repository.getPersistedMarketCatalogPage({ limit: 1, now: new Date(firstAsOf) });
    expect(firstPage.outcomes[0].marketId).toBe("snapshot-a");

    const refreshAsOf = new Date(new Date(firstAsOf).getTime() + 1_000).toISOString();
    await repository.persistMarketCatalog(
      catalog(refreshAsOf, [
        indexedOutcome("snapshot-a", 1, refreshAsOf, "Crypto", "refreshed"),
        indexedOutcome("snapshot-b", 99_000, refreshAsOf, "Crypto", "refreshed"),
        indexedOutcome("snapshot-c", 98_000, refreshAsOf, "Crypto", "refreshed")
      ])
    );

    const mutableRow = await admin.query(
      `
        SELECT canonical_category, event_group_key, current_snapshot_id
        FROM "${schema}".markets
        WHERE source_market_id = 'snapshot-b'
      `
    );
    const secondPage = await repository.getPersistedMarketCatalogPage({
      limit: 1,
      cursor: firstPage.pageInfo.nextCursor,
      now: new Date(refreshAsOf)
    });

    expect(mutableRow.rows[0]).toMatchObject({
      canonical_category: "Crypto",
      event_group_key: "polymarket:event:snapshot-b-refreshed",
      current_snapshot_id: expect.any(String)
    });
    expect(secondPage.outcomes[0]).toMatchObject({
      marketId: "snapshot-b",
      category: "Politics",
      eventGroupKey: "polymarket:event:snapshot-b-original",
      eventTitle: "snapshot-b original"
    });
  });

  it("omits expired legacy public rows while retaining future live rows", async () => {
    const asOf = "2026-07-14T00:00:00.000Z";
    const now = new Date("2026-07-14T00:01:00.000Z");
    const expired = {
      ...indexedOutcome("legacy-expired", 20_000, asOf),
      endDate: "2026-07-14T00:00:00.000Z"
    };
    const future = indexedOutcome("future-live", 10_000, asOf);

    await repository.persistMarketCatalog(catalog(asOf, [expired, future]), { now });

    // Simulate rows written before the ingest cutoff existed: their stored and snapshot visibility are stale.
    await admin.query(`
      UPDATE "${schema}".markets
      SET publicly_visible = true
      WHERE source_market_id = 'legacy-expired'
    `);
    await admin.query(`
      UPDATE "${schema}".market_snapshots
      SET raw = jsonb_set(raw, '{publiclyVisible}', 'true'::jsonb)
      WHERE market_id = (
        SELECT id FROM "${schema}".markets WHERE source_market_id = 'legacy-expired'
      )
    `);

    const page = await repository.getPersistedMarketCatalogPage({ limit: 10, now });

    expect(page.outcomes.map((outcome) => outcome.marketId)).toEqual(["future-live"]);
  });

  it("reads older discovery candidates for request-time CLOB refresh without treating their prices as fresh", async () => {
    const asOf = "2026-07-14T00:00:00.000Z";
    const now = new Date("2026-07-14T00:10:00.000Z");
    await repository.persistMarketCatalog(catalog(asOf, [indexedOutcome("discovery-candidate", 30_000, asOf)]), {
      now: new Date(asOf)
    });

    await expect(
      repository.getPersistedMarketCatalogPage({
        search: "discovery-candidate",
        now,
        eligibilityConfig: {
          minLiquidityUsd: 1_000,
          minVolumeUsd: 5_000,
          maxSpread: 0.2,
          maxPublicAgeMs: 120_000,
          requireOrderBook: true,
          allowUnknownLiquiditySignals: false
        }
      })
    ).rejects.toThrow("No persisted market catalog available");

    const candidates = await repository.getPersistedMarketCatalogPage({
      search: "discovery-candidate",
      now,
      requireFreshOrderBook: false,
      maxSnapshotAgeMs: 30 * 60_000
    });

    expect(candidates.outcomes.map((outcome) => outcome.marketId)).toEqual(["discovery-candidate"]);
  });

  it("fills first and cursor pages past malformed public snapshot rows", async () => {
    const asOf = new Date(Date.now() + 30_000).toISOString();
    const invalidMarkets = [
      indexedOutcome("underfill-invalid-a", 9_000_000_000, asOf),
      indexedOutcome("underfill-invalid-b", 8_900_000_000, asOf)
    ];
    const validMarkets = [
      indexedOutcome("underfill-valid-a", 8_800_000_000, asOf),
      indexedOutcome("underfill-valid-b", 8_700_000_000, asOf),
      indexedOutcome("underfill-valid-c", 8_600_000_000, asOf)
    ];
    await repository.persistMarketCatalog(catalog(asOf, [...invalidMarkets, ...validMarkets]));
    await admin.query(
      `
        UPDATE "${schema}".market_snapshots
        SET raw = jsonb_set(raw, '{outcomes}', '[]'::jsonb)
        WHERE id IN (
          SELECT markets.current_snapshot_id
          FROM "${schema}".markets
          WHERE markets.source_market_id = ANY($1::text[])
        )
      `,
      [invalidMarkets.map((outcome) => outcome.marketId)]
    );

    const firstPage = await repository.getPersistedMarketCatalogPage({
      search: "underfill",
      limit: 1,
      sort: "volume",
      requireFreshOrderBook: false,
      maxSnapshotAgeMs: 6 * 60 * 60_000,
      now: new Date(asOf)
    });
    expect([...new Set(firstPage.outcomes.map((outcome) => outcome.marketId))]).toEqual(["underfill-valid-a"]);
    expect(firstPage.pageInfo.hasMore).toBe(true);
    expect(firstPage.pageInfo.nextCursor).toBeTruthy();

    const secondPage = await repository.getPersistedMarketCatalogPage({
      search: "underfill",
      cursor: firstPage.pageInfo.nextCursor,
      limit: 1,
      sort: "volume",
      requireFreshOrderBook: false,
      maxSnapshotAgeMs: 6 * 60 * 60_000,
      now: new Date(asOf)
    });
    expect([...new Set(secondPage.outcomes.map((outcome) => outcome.marketId))]).toEqual(["underfill-valid-b"]);
  });

  it("keeps maximum-size discovery pages paginated within the database budget", async () => {
    const asOf = new Date().toISOString();
    const prefix = `pagination-boundary-${randomBytes(4).toString("hex")}`;
    const outcomes = Array.from({ length: 251 }, (_, index) =>
      indexedOutcome(`${prefix}-${String(index).padStart(3, "0")}`, 1_000_000 - index, asOf)
    );
    await repository.persistMarketCatalog(catalog(asOf, outcomes));

    const firstStartedAt = performance.now();
    const first = await repository.getPersistedMarketCatalogPage({
      search: prefix,
      limit: 250,
      sort: "volume",
      requireFreshOrderBook: false,
      maxSnapshotAgeMs: 60_000
    });
    const firstLatencyMs = performance.now() - firstStartedAt;

    expect(new Set(first.outcomes.map((outcome) => outcome.marketId)).size).toBe(250);
    expect(first.pageInfo.hasMore).toBe(true);
    expect(first.pageInfo.nextCursor).toBeTruthy();
    expect(firstLatencyMs).toBeLessThan(Number(process.env.MARKET_QA_MAX_DB_LATENCY_MS || 2_500));

    const second = await repository.getPersistedMarketCatalogPage({
      search: prefix,
      cursor: first.pageInfo.nextCursor,
      limit: 250,
      sort: "volume",
      requireFreshOrderBook: false,
      maxSnapshotAgeMs: 60_000
    });
    expect(new Set(second.outcomes.map((outcome) => outcome.marketId)).size).toBe(1);
    expect(second.pageInfo.hasMore).toBe(false);
  }, 30_000);
});
