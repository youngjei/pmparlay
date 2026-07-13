import { createHash } from "node:crypto";
import type pg from "pg";
import type { MarketOutcome } from "../../packages/domain/src/types";
import type { MarketCatalogSnapshot } from "../marketCatalog";
import { getPool } from "./client";

type MarketGroup = {
  marketId: string;
  outcomes: MarketOutcome[];
};

function groupOutcomes(outcomes: MarketOutcome[]) {
  const groups = new Map<string, MarketGroup>();

  for (const outcome of outcomes) {
    const current = groups.get(outcome.marketId);
    if (current) {
      current.outcomes.push(outcome);
    } else {
      groups.set(outcome.marketId, {
        marketId: outcome.marketId,
        outcomes: [outcome]
      });
    }
  }

  return [...groups.values()];
}

function microUsd(value?: number) {
  if (!Number.isFinite(value)) return null;
  return Math.round((value || 0) * 1_000_000);
}

function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function finiteNumbers(values: Array<number | undefined>) {
  return values.filter((value): value is number => Number.isFinite(value));
}

async function upsertMarket(client: pg.PoolClient, group: MarketGroup) {
  const primary = group.outcomes[0];
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO markets (
        source,
        source_market_id,
        condition_id,
        question,
        market_url,
        category,
        end_date,
        neg_risk,
        rfq_enabled,
        active,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, now())
      ON CONFLICT (source, source_market_id)
      DO UPDATE SET
        condition_id = EXCLUDED.condition_id,
        question = EXCLUDED.question,
        market_url = EXCLUDED.market_url,
        category = EXCLUDED.category,
        end_date = EXCLUDED.end_date,
        neg_risk = EXCLUDED.neg_risk,
        rfq_enabled = EXCLUDED.rfq_enabled,
        active = true,
        updated_at = now()
      RETURNING id
    `,
    [
      primary.source,
      primary.marketId,
      primary.conditionId || null,
      primary.question,
      primary.marketUrl,
      primary.category,
      primary.endDate || null,
      primary.negRisk ?? null,
      primary.rfqEnabled ?? null
    ]
  );

  return result.rows[0].id;
}

async function upsertOutcome(client: pg.PoolClient, marketId: string, outcome: MarketOutcome) {
  await client.query(
    `
      INSERT INTO market_outcomes (market_id, outcome, token_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (market_id, outcome)
      DO UPDATE SET token_id = EXCLUDED.token_id
    `,
    [marketId, outcome.outcome, outcome.tokenId || null]
  );
}

async function insertSnapshot(client: pg.PoolClient, marketId: string, group: MarketGroup, catalog: MarketCatalogSnapshot) {
  const primary = group.outcomes[0];
  const raw = {
    marketId: group.marketId,
    outcomes: group.outcomes,
    capturedAt: catalog.asOf,
    complete: catalog.complete,
    totalFeeds: catalog.totalFeeds,
    successfulFeeds: catalog.successfulFeeds
  };

  await client.query(
    `
      INSERT INTO market_snapshots (
        market_id,
        captured_at,
        source_response_hash,
        volume_micro_usd,
        liquidity_micro_usd,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [marketId, catalog.asOf, hashJson(raw), microUsd(primary.volume), microUsd(primary.liquidity), raw]
  );
}

export async function persistMarketCatalog(catalog: MarketCatalogSnapshot) {
  const client = await getPool().connect();
  const groups = groupOutcomes(catalog.outcomes);

  try {
    await client.query("BEGIN");

    if (groups.length > 0 && catalog.complete) {
      await client.query(
        `
          UPDATE markets
          SET active = false, updated_at = now()
          WHERE source = 'polymarket'
            AND NOT (source_market_id = ANY($1::text[]))
        `,
        [groups.map((group) => group.marketId)]
      );
    }

    for (const group of groups) {
      const marketId = await upsertMarket(client, group);
      for (const outcome of group.outcomes) {
        await upsertOutcome(client, marketId, outcome);
      }
      await insertSnapshot(client, marketId, group, catalog);
    }

    await client.query("COMMIT");
    return {
      markets: groups.length,
      outcomes: catalog.outcomes.length,
      snapshots: groups.length,
      deactivatedMissingMarkets: Boolean(catalog.complete)
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPersistedMarketCatalog(): Promise<MarketCatalogSnapshot> {
  const result = await getPool().query<{
    outcome_id: string;
    source_market_id: string;
    condition_id: string | null;
    token_id: string | null;
    question: string;
    market_url: string;
    category: string;
    outcome: string;
    end_date: Date | null;
    neg_risk: boolean | null;
    rfq_enabled: boolean | null;
    captured_at: Date;
    volume_micro_usd: string | null;
    liquidity_micro_usd: string | null;
    raw: {
      outcomes?: MarketOutcome[];
      complete?: boolean;
      totalFeeds?: number;
      successfulFeeds?: number;
    };
  }>(
    `
      WITH selected_markets AS (
        SELECT
          markets.id,
          markets.source_market_id,
          markets.condition_id,
          markets.question,
          markets.market_url,
          markets.category,
          markets.end_date,
          markets.neg_risk,
          markets.rfq_enabled,
          latest_snapshot.id AS snapshot_id,
          latest_snapshot.captured_at,
          latest_snapshot.volume_micro_usd,
          latest_snapshot.liquidity_micro_usd,
          latest_snapshot.raw
        FROM markets
        JOIN LATERAL (
          SELECT *
          FROM market_snapshots
          WHERE market_snapshots.market_id = markets.id
          ORDER BY captured_at DESC
          LIMIT 1
        ) latest_snapshot ON true
        WHERE markets.source = 'polymarket'
          AND markets.active = true
          AND (markets.end_date IS NULL OR markets.end_date > now())
          AND latest_snapshot.captured_at >= (
            SELECT max(captured_at) - interval '15 minutes'
            FROM market_snapshots
          )
        ORDER BY latest_snapshot.volume_micro_usd DESC NULLS LAST, markets.updated_at DESC
        LIMIT 250
      )
      SELECT
        market_outcomes.id::text AS outcome_id,
        selected_markets.source_market_id,
        selected_markets.condition_id,
        market_outcomes.token_id,
        selected_markets.question,
        selected_markets.market_url,
        selected_markets.category,
        market_outcomes.outcome,
        selected_markets.end_date,
        selected_markets.neg_risk,
        selected_markets.rfq_enabled,
        selected_markets.captured_at,
        selected_markets.volume_micro_usd::text,
        selected_markets.liquidity_micro_usd::text,
        selected_markets.raw
      FROM selected_markets
      JOIN market_outcomes ON market_outcomes.market_id = selected_markets.id
    `
  );

  if (result.rows.length === 0) {
    throw new Error("No persisted market catalog available. Run npm run index:markets first.");
  }

  const latestCapturedAt = Math.max(...result.rows.map((row) => row.captured_at.getTime()));
  const asOf = new Date(latestCapturedAt).toISOString();
  const latestRows = result.rows.filter((row) => row.captured_at.getTime() === latestCapturedAt);
  const completeValues = latestRows.map((row) => row.raw.complete).filter((value): value is boolean => typeof value === "boolean");
  const totalFeedCounts = finiteNumbers(latestRows.map((row) => row.raw.totalFeeds));
  const successfulFeedCounts = finiteNumbers(latestRows.map((row) => row.raw.successfulFeeds));
  const marketOrder = new Map<string, number>();
  for (const row of result.rows) {
    if (!marketOrder.has(row.source_market_id)) {
      marketOrder.set(row.source_market_id, marketOrder.size);
    }
  }

  const outcomes = result.rows
    .map((row) => {
      const rawOutcomeIndex = row.raw.outcomes?.findIndex((item) => item.outcome === row.outcome) ?? -1;
      const rawOutcome = rawOutcomeIndex >= 0 ? row.raw.outcomes?.[rawOutcomeIndex] : undefined;
      if (!rawOutcome || !Number.isFinite(rawOutcome.price)) return undefined;

      const outcome: MarketOutcome = {
        id: row.outcome_id,
        marketId: row.source_market_id,
        question: row.question,
        marketUrl: row.market_url,
        category: row.category,
        outcome: row.outcome,
        price: rawOutcome.price,
        sourceAsOf: row.captured_at.toISOString(),
        endDate: row.end_date?.toISOString(),
        liquidity: row.liquidity_micro_usd ? Number(row.liquidity_micro_usd) / 1_000_000 : rawOutcome.liquidity,
        volume: row.volume_micro_usd ? Number(row.volume_micro_usd) / 1_000_000 : rawOutcome.volume,
        image: rawOutcome.image,
        icon: rawOutcome.icon,
        bestBid: rawOutcome.bestBid,
        bestAsk: rawOutcome.bestAsk,
        spread: rawOutcome.spread,
        enableOrderBook: rawOutcome.enableOrderBook,
        negRisk: row.neg_risk ?? rawOutcome.negRisk,
        rfqEnabled: row.rfq_enabled ?? rawOutcome.rfqEnabled,
        source: "polymarket" as const
      };

      if (row.condition_id) outcome.conditionId = row.condition_id;
      if (row.token_id) outcome.tokenId = row.token_id;
      if (row.end_date) outcome.endDate = row.end_date.toISOString();
      return {
        outcome,
        marketOrder: marketOrder.get(row.source_market_id) ?? Number.MAX_SAFE_INTEGER,
        outcomeOrder: rawOutcomeIndex
      };
    })
    .filter((item) => Boolean(item))
    .sort((a, b) => a!.marketOrder - b!.marketOrder || a!.outcomeOrder - b!.outcomeOrder)
    .map((item) => item!.outcome);

  return {
    asOf,
    source: "polymarket",
    complete: completeValues.length > 0 ? completeValues.every(Boolean) : undefined,
    totalFeeds: totalFeedCounts.length > 0 ? Math.max(...totalFeedCounts) : undefined,
    successfulFeeds: successfulFeedCounts.length > 0 ? Math.min(...successfulFeedCounts) : undefined,
    outcomes
  };
}
