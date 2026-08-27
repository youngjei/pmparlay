import { createHash } from "node:crypto";
import type pg from "pg";
import type { MarketOutcome } from "../../packages/domain/src/types";
import type {
  MarketCatalogGroup,
  MarketCatalogPage,
  MarketCatalogQuery,
  MarketCatalogSnapshot,
  MarketCatalogSort,
  MarketCatalogTombstone
} from "../marketCatalog";
import {
  annotateCatalogOutcomes,
  marketEligibilityConfigFromEnv,
  publicCatalogLimitFromEnv,
  type MarketCatalogOutcome,
  type MarketEligibilityConfig
} from "../marketTaxonomy";
import { getPool } from "./client";

type MarketGroup = {
  marketId: string;
  outcomes: MarketCatalogOutcome[];
};

type PersistedMarketRecord = MarketCatalogOutcome | (MarketCatalogTombstone & Partial<Pick<MarketCatalogOutcome, "taxonomy" | "relationships" | "eligibility">>);

export type CatalogReadOptions = MarketCatalogQuery & {
  now?: Date;
  eligibilityConfig?: MarketEligibilityConfig;
  /** Candidate reads are re-priced from CLOB before they are returned publicly. */
  requireFreshOrderBook?: boolean;
  maxSnapshotAgeMs?: number;
};

type MarketCatalogSweep = NonNullable<MarketCatalogSnapshot["sweep"]>;

export type PersistMarketCatalogOptions = {
  signal?: AbortSignal;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Allows index jobs and tests to use one explicit trusted clock value. */
  now?: Date;
};

function positiveIntegerEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("market_index_aborted");
}

async function connectWithSignal(signal?: AbortSignal) {
  const connection = getPool().connect();
  if (!signal) return connection;
  if (signal.aborted) {
    void connection.then((client) => client.release(), () => undefined);
    throwIfAborted(signal);
  }

  let aborted = false;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const onAbort = () => {
    aborted = true;
    rejectAbort?.(signal.reason instanceof Error ? signal.reason : new Error("market_index_aborted"));
  };
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([connection, abort]);
  } catch (error) {
    if (aborted) void connection.then((client) => client.release(), () => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function groupOutcomes(outcomes: MarketCatalogOutcome[]) {
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

function unreferencedSnapshotRetentionFromEnv() {
  const configured = process.env.MARKET_SNAPSHOT_UNREFERENCED_RETENTION;
  if (configured === undefined || configured.trim() === "") return 2;

  const parsed = Number(configured);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(Math.max(Math.floor(parsed), 1), 10);
}

function finiteNumbers(values: Array<number | undefined>) {
  return values.filter((value): value is number => Number.isFinite(value));
}

function boundedLimit(limit: number | undefined) {
  const fallback = publicCatalogLimitFromEnv();
  if (!Number.isFinite(limit) || !limit) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), 250);
}

function microUsdThreshold(value: number) {
  return Math.round(value * 1_000_000);
}

type CursorPayload = {
  v: 2;
  fp: string;
  sort: MarketCatalogSort;
  snapshotAt: string;
  snapshotSequence: string;
  values: string[];
  marketId: string;
};

type SortField = {
  expression: string;
  direction: "ASC" | "DESC";
  type: "bigint" | "timestamptz";
};

function normalizedCatalogQuery(options: MarketCatalogQuery) {
  return {
    search: options.search?.trim().replace(/\s+/g, " ").toLowerCase() || undefined,
    category: options.category?.trim() || undefined,
    sort: options.sort || "volume",
    eventGroupKey: options.eventGroupKey?.trim() || undefined
  };
}

function queryFingerprint(options: MarketCatalogQuery) {
  return hashJson(normalizedCatalogQuery(options));
}

function encodePublicCursor(payload: CursorPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePublicCursor(cursor: string | undefined, expectedFingerprint: string, expectedSort: MarketCatalogSort) {
  if (!cursor) return undefined;

  let parsed: Partial<CursorPayload>;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
  } catch {
    throw new Error("market_catalog_cursor_invalid");
  }

  if (
    parsed.v !== 2 ||
    parsed.fp !== expectedFingerprint ||
    parsed.sort !== expectedSort ||
    typeof parsed.snapshotAt !== "string" ||
    !Number.isFinite(new Date(parsed.snapshotAt).getTime()) ||
    typeof parsed.snapshotSequence !== "string" ||
    !/^\d+$/.test(parsed.snapshotSequence) ||
    !Array.isArray(parsed.values) ||
    !parsed.values.every((value) => typeof value === "string") ||
    typeof parsed.marketId !== "string" ||
    !parsed.marketId
  ) {
    throw new Error("market_catalog_cursor_scope_mismatch");
  }

  return parsed as CursorPayload;
}

function sortFields(sort: MarketCatalogSort): SortField[] {
  switch (sort) {
    case "liquidity":
      return [
        { expression: "COALESCE(latest_snapshot.liquidity_micro_usd, -1)", direction: "DESC", type: "bigint" },
        { expression: "COALESCE(latest_snapshot.volume_micro_usd, -1)", direction: "DESC", type: "bigint" },
        { expression: "latest_snapshot.captured_at", direction: "DESC", type: "timestamptz" }
      ];
    case "ending_soon":
      return [
        {
          expression: "COALESCE(latest_snapshot.end_date, '9999-12-31T00:00:00Z'::timestamptz)",
          direction: "ASC",
          type: "timestamptz"
        },
        { expression: "COALESCE(latest_snapshot.volume_micro_usd, -1)", direction: "DESC", type: "bigint" },
        { expression: "latest_snapshot.captured_at", direction: "DESC", type: "timestamptz" }
      ];
    case "newest":
      return [
        { expression: "latest_snapshot.captured_at", direction: "DESC", type: "timestamptz" },
        { expression: "COALESCE(latest_snapshot.volume_micro_usd, -1)", direction: "DESC", type: "bigint" }
      ];
    case "volume":
    default:
      return [
        { expression: "COALESCE(latest_snapshot.volume_micro_usd, -1)", direction: "DESC", type: "bigint" },
        { expression: "COALESCE(latest_snapshot.liquidity_micro_usd, -1)", direction: "DESC", type: "bigint" },
        { expression: "latest_snapshot.captured_at", direction: "DESC", type: "timestamptz" }
      ];
  }
}

function sortSelectList(fields: SortField[]) {
  return [0, 1, 2]
    .map((index) => {
      const field = fields[index];
      return field ? `${field.expression} AS sort_value_${index + 1}` : `NULL::text AS sort_value_${index + 1}`;
    })
    .join(",\n          ");
}

function sortOrderClause(fields: SortField[], qualifier = "") {
  const prefix = qualifier ? `${qualifier}.` : "";
  return [
    ...fields.map((field, index) => `${prefix}sort_value_${index + 1} ${field.direction}`),
    `${prefix}sort_market_id ASC`
  ].join(", ");
}

function directSortOrderClause(fields: SortField[], tieBreaker: string) {
  return [...fields.map((field) => `${field.expression} ${field.direction}`), `${tieBreaker} ASC`].join(", ");
}

function addParam(params: unknown[], value: unknown) {
  params.push(value);
  return params.length;
}

function cursorCast(field: SortField) {
  return field.type === "timestamptz" ? "timestamptz" : "bigint";
}

function keysetPredicate(fields: SortField[], cursor: CursorPayload | undefined, params: unknown[]) {
  if (!cursor) return "";
  if (cursor.values.length !== fields.length) throw new Error("market_catalog_cursor_scope_mismatch");

  const equality: string[] = [];
  const clauses: string[] = [];

  fields.forEach((field, index) => {
    const paramIndex = addParam(params, cursor.values[index]);
    const cast = cursorCast(field);
    const comparator = field.direction === "DESC" ? "<" : ">";
    clauses.push(`(${[...equality, `sort_value_${index + 1} ${comparator} $${paramIndex}::${cast}`].join(" AND ")})`);
    equality.push(`sort_value_${index + 1} = $${paramIndex}::${cast}`);
  });

  const marketIdIndex = addParam(params, cursor.marketId);
  clauses.push(`(${[...equality, `sort_market_id > $${marketIdIndex}::text`].join(" AND ")})`);
  return `WHERE ${clauses.join("\n            OR ")}`;
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

async function upsertMarket(client: pg.PoolClient, primary: PersistedMarketRecord, publiclyVisible: boolean, seenAt: string) {
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
        source_category,
        canonical_category,
        source_tags,
        taxonomy,
        event_group_key,
        event_title,
        event_slug,
        relationship_metadata,
        eligibility_metadata,
        publicly_visible,
        last_seen_at,
        closed,
        archived,
        accepting_orders,
        enable_order_book,
        active,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, now())
      ON CONFLICT (source, source_market_id)
      DO UPDATE SET
        condition_id = EXCLUDED.condition_id,
        question = EXCLUDED.question,
        market_url = EXCLUDED.market_url,
        category = EXCLUDED.category,
        end_date = EXCLUDED.end_date,
        neg_risk = EXCLUDED.neg_risk,
        rfq_enabled = EXCLUDED.rfq_enabled,
        source_category = EXCLUDED.source_category,
        canonical_category = EXCLUDED.canonical_category,
        source_tags = EXCLUDED.source_tags,
        taxonomy = EXCLUDED.taxonomy,
        event_group_key = EXCLUDED.event_group_key,
        event_title = EXCLUDED.event_title,
        event_slug = EXCLUDED.event_slug,
        relationship_metadata = EXCLUDED.relationship_metadata,
        eligibility_metadata = EXCLUDED.eligibility_metadata,
        publicly_visible = EXCLUDED.publicly_visible,
        last_seen_at = EXCLUDED.last_seen_at,
        closed = EXCLUDED.closed,
        archived = EXCLUDED.archived,
        accepting_orders = EXCLUDED.accepting_orders,
        enable_order_book = EXCLUDED.enable_order_book,
        active = EXCLUDED.active,
        updated_at = now()
      RETURNING id
    `,
    [
      primary.source,
      primary.marketId,
      primary.conditionId || null,
      primary.question,
      primary.marketUrl || "",
      primary.category,
      primary.endDate || null,
      primary.negRisk ?? null,
      primary.rfqEnabled ?? null,
      primary.sourceCategory || null,
      primary.taxonomy?.category || primary.category,
      JSON.stringify(primary.sourceTags || []),
      JSON.stringify(primary.taxonomy || {}),
      primary.eventGroupKey || null,
      primary.eventTitle || null,
      primary.eventSlug || null,
      JSON.stringify(primary.relationships || {}),
      JSON.stringify(primary.eligibility || {}),
      publiclyVisible,
      primary.sourceAsOf || seenAt,
      primary.closed ?? false,
      primary.archived ?? false,
      primary.acceptingOrders ?? null,
      primary.enableOrderBook ?? null,
      primary.sourceActive === true
    ]
  );

  return result.rows[0].id;
}

function tombstoneRecord(tombstone: MarketCatalogTombstone, catalog: MarketCatalogSnapshot): PersistedMarketRecord {
  const thresholds = {
    ...marketEligibilityConfigFromEnv(),
    requireOrderBook: false
  };
  const status = tombstone.sourceActive === false ? "source_inactive" : tombstone.closed ? "closed" : "archived";

  return {
    ...tombstone,
    sourceAsOf: tombstone.sourceAsOf || catalog.asOf,
    eligibility: {
      eligible: false,
      status,
      reason: `Polymarket explicitly reports this market as ${status.replace("source_", "")}.`,
      evaluatedAt: catalog.asOf,
      thresholds,
      signals: {
        endDate: tombstone.endDate,
        sourceActive: tombstone.sourceActive,
        closed: tombstone.closed,
        archived: tombstone.archived,
        acceptingOrders: tombstone.acceptingOrders,
        enableOrderBook: tombstone.enableOrderBook,
        hasExecutableOrderBook: false,
        liquidityUsd: tombstone.liquidity,
        volumeUsd: tombstone.volume
      }
    }
  };
}

async function upsertOutcome(client: pg.PoolClient, marketId: string, outcome: MarketOutcome) {
  await client.query(
    `
      INSERT INTO market_outcomes (market_id, outcome, token_id, source_outcome_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (market_id, outcome)
      DO UPDATE SET
        token_id = EXCLUDED.token_id,
        source_outcome_id = EXCLUDED.source_outcome_id
    `,
    [marketId, outcome.outcome, outcome.tokenId || null, outcome.id]
  );
}

async function insertSnapshot(client: pg.PoolClient, marketId: string, group: MarketGroup, catalog: MarketCatalogSnapshot) {
  const primary = group.outcomes[0];
  const publiclyVisible = group.outcomes.some((outcome) => outcome.eligibility?.eligible === true);
  const raw = {
    schemaVersion: 2,
    marketId: group.marketId,
    market: primary,
    outcomes: group.outcomes,
    publiclyVisible,
    capturedAt: catalog.asOf,
    complete: catalog.complete,
    totalFeeds: catalog.totalFeeds,
    successfulFeeds: catalog.successfulFeeds,
    nextCursor: catalog.nextCursor,
    sweep: catalog.sweep
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

async function insertTombstoneSnapshot(client: pg.PoolClient, marketId: string, tombstone: PersistedMarketRecord, catalog: MarketCatalogSnapshot) {
  const raw = {
    schemaVersion: 2,
    marketId: tombstone.marketId,
    market: tombstone,
    outcomes: [],
    publiclyVisible: false,
    visibilityReason: "explicit_source_tombstone",
    capturedAt: catalog.asOf,
    complete: catalog.complete,
    totalFeeds: catalog.totalFeeds,
    successfulFeeds: catalog.successfulFeeds,
    nextCursor: catalog.nextCursor,
    sweep: catalog.sweep
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
    [marketId, catalog.asOf, hashJson(raw), microUsd(tombstone.volume), microUsd(tombstone.liquidity), raw]
  );
}

async function pruneUnreferencedMarketSnapshots(client: pg.PoolClient, marketIds: string[]) {
  const uniqueIds = [...new Set(marketIds)];
  if (uniqueIds.length === 0) return 0;
  const retention = unreferencedSnapshotRetentionFromEnv();

  const result = await client.query(
    `
      WITH ranked_unreferenced AS (
        SELECT
          market_snapshots.id,
          row_number() OVER (
            PARTITION BY market_snapshots.market_id
            ORDER BY market_snapshots.catalog_sequence DESC
          ) AS snapshot_rank
        FROM market_snapshots
        WHERE market_snapshots.market_id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1
            FROM quote_legs
            WHERE quote_legs.market_snapshot_id = market_snapshots.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ticket_legs
            WHERE ticket_legs.settlement_source_snapshot_id = market_snapshots.id
          )
      )
      DELETE FROM market_snapshots
      USING ranked_unreferenced
      WHERE market_snapshots.id = ranked_unreferenced.id
        AND ranked_unreferenced.snapshot_rank > $2::integer
    `,
    [uniqueIds, retention]
  );

  return result.rowCount || 0;
}

export type MarketCatalogSweepState = {
  source: "polymarket";
  resource: "events";
  generationVersion: number;
  generationStartedAt: string;
  generationStartedAfterCursor?: string;
  nextCursor?: string;
  seenMarketIds: string[];
  attemptedPages: number;
  successfulPages: number;
  complete: boolean;
  truncated: boolean;
  stoppedReason?: MarketCatalogSweep["stoppedReason"];
  updatedAt: string;
  completedAt?: string;
};

type MarketCatalogSweepStateRow = {
  source: "polymarket";
  resource: "events";
  generation_version: number;
  generation_started_at: Date;
  generation_started_after_cursor: string | null;
  next_cursor: string | null;
  seen_market_ids: string[] | null;
  attempted_pages: number;
  successful_pages: number;
  complete: boolean;
  truncated: boolean;
  stopped_reason: MarketCatalogSweep["stoppedReason"] | null;
  updated_at: Date;
  completed_at: Date | null;
};

function sweepStateFromRow(row: MarketCatalogSweepStateRow): MarketCatalogSweepState {
  return {
    source: row.source,
    resource: row.resource,
    generationVersion: row.generation_version,
    generationStartedAt: row.generation_started_at.toISOString(),
    generationStartedAfterCursor: row.generation_started_after_cursor || undefined,
    nextCursor: row.next_cursor || undefined,
    seenMarketIds: row.seen_market_ids || [],
    attemptedPages: row.attempted_pages,
    successfulPages: row.successful_pages,
    complete: row.complete,
    truncated: row.truncated,
    stoppedReason: row.stopped_reason || undefined,
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString()
  };
}

export async function getMarketCatalogSweepState(): Promise<MarketCatalogSweepState | undefined> {
  const result = await getPool().query<MarketCatalogSweepStateRow>(
    `
      SELECT
        source,
        resource,
        generation_version,
        generation_started_at,
        generation_started_after_cursor,
        next_cursor,
        seen_market_ids,
        attempted_pages,
        successful_pages,
        complete,
        truncated,
        stopped_reason,
        updated_at,
        completed_at
      FROM market_catalog_sweep_state
      WHERE source = 'polymarket'
    `
  );

  return result.rows[0] ? sweepStateFromRow(result.rows[0]) : undefined;
}

export async function resetMarketCatalogSweepAfterInvalidCursor(input: {
  expectedGenerationVersion: number;
  expectedCursor: string;
}): Promise<number | undefined> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('market_catalog_sweep_state:polymarket'))");
    const result = await client.query<{ generation_version: number }>(
      `
        UPDATE market_catalog_sweep_state
        SET generation_version = generation_version + 1,
            generation_started_at = now(),
            generation_started_after_cursor = NULL,
            next_cursor = NULL,
            seen_market_ids = '{}'::text[],
            attempted_pages = 0,
            successful_pages = 0,
            complete = false,
            truncated = false,
            stopped_reason = NULL,
            updated_at = now(),
            completed_at = NULL
        WHERE source = 'polymarket'
          AND generation_version = $1
          AND next_cursor = $2
        RETURNING generation_version
      `,
      [input.expectedGenerationVersion, input.expectedCursor]
    );
    await client.query("COMMIT");
    return result.rows[0]?.generation_version;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function uniqueMarketIds(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

async function updateSweepStateForCatalog(client: pg.PoolClient, catalog: MarketCatalogSnapshot, marketIds: string[]) {
  const sweep = catalog.sweep;
  const currentSeenMarketIds = uniqueMarketIds(marketIds);

  if (!sweep) {
    return {
      fullGenerationComplete: false,
      reconcileMarketIds: [],
      stalePageIgnored: false
    };
  }

  await client.query("SELECT pg_advisory_xact_lock(hashtext('market_catalog_sweep_state:polymarket'))");

  const existingResult = await client.query<MarketCatalogSweepStateRow>(
    `
      SELECT
        source,
        resource,
        generation_version,
        generation_started_at,
        generation_started_after_cursor,
        next_cursor,
        seen_market_ids,
        attempted_pages,
        successful_pages,
        complete,
        truncated,
        stopped_reason,
        updated_at,
        completed_at
      FROM market_catalog_sweep_state
      WHERE source = 'polymarket'
      FOR UPDATE
    `
  );
  const existing = existingResult.rows[0];
  const startedFromBeginning = !sweep.startedAfterCursor;
  const expectedGenerationVersion = sweep.expectedGenerationVersion ?? 0;
  const currentGenerationVersion = existing?.generation_version ?? 0;
  const stalePageIgnored = Boolean(
    expectedGenerationVersion !== currentGenerationVersion ||
      (existing &&
        (startedFromBeginning
          ? !existing.complete && Boolean(existing.next_cursor)
          : existing.next_cursor !== sweep.startedAfterCursor))
  );

  if (stalePageIgnored) {
    return {
      fullGenerationComplete: false,
      reconcileMarketIds: [],
      stalePageIgnored: true
    };
  }

  const continuedExistingGeneration = Boolean(existing && sweep.startedAfterCursor && existing.next_cursor === sweep.startedAfterCursor);
  const previousSeenMarketIds = continuedExistingGeneration ? existing?.seen_market_ids || [] : [];
  const seenMarketIds = uniqueMarketIds([...previousSeenMarketIds, ...currentSeenMarketIds]);
  const generationStartedAfterCursor = startedFromBeginning
    ? null
    : continuedExistingGeneration
      ? existing?.generation_started_after_cursor || null
      : sweep.startedAfterCursor || null;
  const generationStartedAt = startedFromBeginning || !existing || !continuedExistingGeneration ? catalog.asOf : existing.generation_started_at.toISOString();
  const reachedEnd = sweep.stoppedReason === "end" && !sweep.nextCursor && !sweep.truncated;
  const fullGenerationComplete = reachedEnd && generationStartedAfterCursor === null;
  const attemptedPages = (continuedExistingGeneration ? existing?.attempted_pages || 0 : 0) + sweep.attemptedPages;
  const successfulPages = (continuedExistingGeneration ? existing?.successful_pages || 0 : 0) + sweep.successfulPages;
  const generationVersion = currentGenerationVersion + 1;

  await client.query(
    `
      INSERT INTO market_catalog_sweep_state (
        source,
        resource,
        generation_version,
        generation_started_at,
        generation_started_after_cursor,
        next_cursor,
        seen_market_ids,
        attempted_pages,
        successful_pages,
        complete,
        truncated,
        stopped_reason,
        updated_at,
        completed_at
      )
      VALUES ('polymarket', 'events', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), CASE WHEN $8 THEN now() ELSE NULL END)
      ON CONFLICT (source)
      DO UPDATE SET
        resource = EXCLUDED.resource,
        generation_version = EXCLUDED.generation_version,
        generation_started_at = EXCLUDED.generation_started_at,
        generation_started_after_cursor = EXCLUDED.generation_started_after_cursor,
        next_cursor = EXCLUDED.next_cursor,
        seen_market_ids = EXCLUDED.seen_market_ids,
        attempted_pages = EXCLUDED.attempted_pages,
        successful_pages = EXCLUDED.successful_pages,
        complete = EXCLUDED.complete,
        truncated = EXCLUDED.truncated,
        stopped_reason = EXCLUDED.stopped_reason,
        updated_at = now(),
        completed_at = CASE WHEN EXCLUDED.complete THEN EXCLUDED.completed_at ELSE market_catalog_sweep_state.completed_at END
    `,
    [
      generationVersion,
      generationStartedAt,
      generationStartedAfterCursor,
      fullGenerationComplete ? null : sweep.nextCursor || null,
      seenMarketIds,
      attemptedPages,
      successfulPages,
      fullGenerationComplete,
      sweep.truncated,
      sweep.stoppedReason
    ]
  );

  return {
    fullGenerationComplete,
    reconcileMarketIds: fullGenerationComplete ? seenMarketIds : [],
    stalePageIgnored: false
  };
}

export async function persistMarketCatalog(catalog: MarketCatalogSnapshot, options: PersistMarketCatalogOptions = {}) {
  const statementTimeoutMs = options.statementTimeoutMs ?? positiveIntegerEnv(process.env.MARKET_INDEX_DB_STATEMENT_TIMEOUT_MS, 15_000);
  const lockTimeoutMs = Math.min(
    options.lockTimeoutMs ?? positiveIntegerEnv(process.env.MARKET_INDEX_DB_LOCK_TIMEOUT_MS, 5_000),
    statementTimeoutMs
  );
  const now = options.now || new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("market_catalog_invalid_current_time");
  const client = await connectWithSignal(options.signal);
  const groups = groupOutcomes(
    annotateCatalogOutcomes(catalog.outcomes, {
      now,
      eligibilityConfig: {
        ...marketEligibilityConfigFromEnv(),
        requireOrderBook: false
      }
    })
  );
  const groupedMarketIds = new Set(groups.map((group) => group.marketId));
  const tombstones = (catalog.tombstones || [])
    .filter((tombstone) => !groupedMarketIds.has(tombstone.marketId))
    .map((tombstone) => tombstoneRecord(tombstone, catalog));
  let missingMarketsMarkedNonPublic = 0;
  let markedMissingMarketsNonPublic = false;
  const touchedMarketIds: string[] = [];

  try {
    throwIfAborted(options.signal);
    await client.query("BEGIN");
    await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", [
      `${statementTimeoutMs}ms`,
      `${lockTimeoutMs}ms`
    ]);
    throwIfAborted(options.signal);

    const sweepState = await updateSweepStateForCatalog(
      client,
      {
        ...catalog,
        complete: catalog.sweep ? catalog.sweep.complete : catalog.complete
      },
      groups.map((group) => group.marketId)
    );
    throwIfAborted(options.signal);

    if (sweepState.stalePageIgnored) {
      await client.query("COMMIT");
      return {
        markets: 0,
        outcomes: 0,
        snapshots: 0,
        snapshotsPruned: 0,
        deactivatedMissingMarkets: false,
        markedMissingMarketsNonPublic: false,
        missingMarketsMarkedNonPublic: 0,
        sweepGenerationComplete: false,
        sweepNextCursor: catalog.sweep?.nextCursor,
        staleSweepPageIgnored: true
      };
    }

    const knownGroupIds = new Set<string>();
    if (groups.length > 0) {
      const knownGroups = await client.query<{ source_market_id: string }>(
        `
          SELECT source_market_id
          FROM markets
          WHERE source = 'polymarket'
            AND source_market_id = ANY($1::text[])
        `,
        [groups.map((group) => group.marketId)]
      );
      for (const market of knownGroups.rows) {
        knownGroupIds.add(market.source_market_id);
      }
    }
    const groupsToPersist = groups.filter(
      (group) =>
        knownGroupIds.has(group.marketId) ||
        group.outcomes.some((outcome) => outcome.eligibility?.eligible === true)
    );

    const knownTombstoneIds = new Set<string>();
    if (tombstones.length > 0) {
      const knownTombstones = await client.query<{ source_market_id: string }>(
        `
          SELECT source_market_id
          FROM markets
          WHERE source = 'polymarket'
            AND source_market_id = ANY($1::text[])
        `,
        [tombstones.map((tombstone) => tombstone.marketId)]
      );
      for (const market of knownTombstones.rows) {
        knownTombstoneIds.add(market.source_market_id);
      }
    }
    const knownTombstones = tombstones.filter((tombstone) => knownTombstoneIds.has(tombstone.marketId));

    for (const group of groupsToPersist) {
      throwIfAborted(options.signal);
      const primary = group.outcomes[0];
      const publiclyVisible = group.outcomes.some((outcome) => outcome.eligibility?.eligible === true);
      const marketId = await upsertMarket(client, primary, publiclyVisible, catalog.asOf);
      touchedMarketIds.push(marketId);
      for (const outcome of group.outcomes) {
        await upsertOutcome(client, marketId, outcome);
      }
      await insertSnapshot(client, marketId, group, catalog);
    }

    for (const tombstone of knownTombstones) {
      throwIfAborted(options.signal);
      const marketId = await upsertMarket(client, tombstone, false, catalog.asOf);
      touchedMarketIds.push(marketId);
      await insertTombstoneSnapshot(client, marketId, tombstone, catalog);
    }

    if (sweepState.reconcileMarketIds.length > 0) {
      throwIfAborted(options.signal);
      const missingResult = await client.query<{ market_id: string }>(
        `
          WITH hidden_markets AS (
            UPDATE markets
            SET publicly_visible = false, updated_at = now()
            WHERE source = 'polymarket'
              AND publicly_visible = true
              AND (
                NOT (source_market_id = ANY($1::text[]))
                OR end_date <= $3::timestamptz
              )
            RETURNING id, end_date
          )
          INSERT INTO market_snapshots (
            market_id,
            captured_at,
            source_response_hash,
            volume_micro_usd,
            liquidity_micro_usd,
            raw
          )
          SELECT
            hidden_markets.id,
            $2::timestamptz,
            encode(digest((latest_snapshot.raw || jsonb_build_object(
              'publiclyVisible', false,
              'visibilityReason', CASE
                WHEN hidden_markets.end_date <= $3::timestamptz THEN 'expired_at_complete_sweep'
                ELSE 'missing_from_complete_sweep'
              END,
              'capturedAt', $2::text
            ))::text, 'sha256'), 'hex'),
            latest_snapshot.volume_micro_usd,
            latest_snapshot.liquidity_micro_usd,
            latest_snapshot.raw || jsonb_build_object(
              'publiclyVisible', false,
              'visibilityReason', CASE
                WHEN hidden_markets.end_date <= $3::timestamptz THEN 'expired_at_complete_sweep'
                ELSE 'missing_from_complete_sweep'
              END,
              'capturedAt', $2::text
            )
          FROM hidden_markets
          JOIN LATERAL (
            SELECT *
            FROM market_snapshots
            WHERE market_snapshots.market_id = hidden_markets.id
            ORDER BY catalog_sequence DESC
            LIMIT 1
          ) latest_snapshot ON true
          RETURNING market_id
        `,
        [sweepState.reconcileMarketIds, catalog.asOf, now.toISOString()]
      );
      missingMarketsMarkedNonPublic = missingResult.rowCount || 0;
      touchedMarketIds.push(...missingResult.rows.map((row) => row.market_id));
      markedMissingMarketsNonPublic = true;
    }

    const snapshotsPruned = await pruneUnreferencedMarketSnapshots(client, touchedMarketIds);

    throwIfAborted(options.signal);
    await client.query("COMMIT");
    return {
      markets: groupsToPersist.length + knownTombstones.length,
      outcomes: groupsToPersist.reduce((count, group) => count + group.outcomes.length, 0),
      snapshots: groupsToPersist.length + knownTombstones.length,
      snapshotsPruned,
      deactivatedMissingMarkets: false,
      markedMissingMarketsNonPublic,
      missingMarketsMarkedNonPublic,
      sweepGenerationComplete: sweepState.fullGenerationComplete,
      sweepNextCursor: catalog.sweep?.nextCursor,
      staleSweepPageIgnored: false
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function jsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function jsonObject<T extends Record<string, unknown>>(value: unknown): T | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : undefined;
}

export async function getPersistedMarketCatalogPage(options: CatalogReadOptions = {}): Promise<MarketCatalogPage> {
  const now = options.now || new Date();
  const eligibilityConfig = options.eligibilityConfig || marketEligibilityConfigFromEnv();
  const requireFreshOrderBook = options.requireFreshOrderBook ?? true;
  const maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? eligibilityConfig.maxPublicAgeMs;
  const readEligibilityConfig = {
    ...eligibilityConfig,
    maxPublicAgeMs: maxSnapshotAgeMs,
    maxSpread: requireFreshOrderBook ? eligibilityConfig.maxSpread : 1,
    requireOrderBook: requireFreshOrderBook
  };
  const limit = boundedLimit(options.limit);
  const sort: MarketCatalogSort = options.sort || "volume";
  const fingerprint = queryFingerprint(options);
  const cursor = decodePublicCursor(options.cursor, fingerprint, sort);
  const snapshotAt = cursor?.snapshotAt || now.toISOString();
  const evaluationNow = now;
  const fields = sortFields(sort);
  const params: unknown[] = [];
  const snapshotSequenceIndex = addParam(params, cursor?.snapshotSequence || null);
  const snapshotAtIndex = addParam(params, snapshotAt);
  const evaluationNowIndex = addParam(params, evaluationNow.toISOString());
  const maxAgeIndex = addParam(params, maxSnapshotAgeMs);
  const minLiquidityIndex = addParam(params, microUsdThreshold(eligibilityConfig.minLiquidityUsd));
  const minVolumeIndex = addParam(params, microUsdThreshold(eligibilityConfig.minVolumeUsd));
  const maxSpreadIndex = requireFreshOrderBook ? addParam(params, eligibilityConfig.maxSpread) : undefined;
  const filters = [
    `EXISTS (
      SELECT 1
      FROM eligible_outcomes
      WHERE eligible_outcomes.snapshot_id = latest_snapshot.snapshot_id
    )`
  ];
  if (requireFreshOrderBook) {
    const eligibleOutcomeCount = `(SELECT count(*) FROM eligible_outcomes WHERE eligible_outcomes.snapshot_id = latest_snapshot.snapshot_id)`;
    filters.push(`${eligibleOutcomeCount} >= 2`);
    filters.push(`${eligibleOutcomeCount} = jsonb_array_length(COALESCE(latest_snapshot.raw->'outcomes', '[]'::jsonb))`);
  }
  const candidateFilters: string[] = [];

  if (options.search?.trim()) {
    const normalizedSearch = options.search.trim().replace(/\s+/g, " ");
    const index = addParam(params, `%${escapeLikePattern(normalizedSearch)}%`);
    if (cursor) {
      filters.push(`(
        coalesce(latest_snapshot.market_record->>'question', '') || ' ' ||
        coalesce(latest_snapshot.market_record->>'eventTitle', '') || ' ' ||
        coalesce(latest_snapshot.market_record->>'eventSlug', '') || ' ' ||
        coalesce(latest_snapshot.market_record->>'marketId', '')
      ) ILIKE $${index} ESCAPE '\\'`);
    } else {
      candidateFilters.push(`(
        coalesce(markets.question, '') || ' ' ||
        coalesce(markets.event_title, '') || ' ' ||
        coalesce(markets.event_slug, '') || ' ' ||
        coalesce(markets.source_market_id, '')
      ) ILIKE $${index} ESCAPE '\\'`);
    }
  }

  if (options.category?.trim()) {
    const index = addParam(params, options.category.trim());
    if (cursor) {
      filters.push(`COALESCE(latest_snapshot.market_record->'taxonomy'->>'category', latest_snapshot.market_record->>'category') = $${index}`);
    } else {
      candidateFilters.push(`COALESCE(markets.canonical_category, markets.category) = $${index}`);
    }
  }

  if (options.eventGroupKey?.trim()) {
    const index = addParam(params, options.eventGroupKey.trim());
    if (cursor) {
      filters.push(`latest_snapshot.market_record->>'eventGroupKey' = $${index}`);
    } else {
      candidateFilters.push(`markets.event_group_key = $${index}`);
    }
  }

  const cursorPredicate = keysetPredicate(fields, cursor, params);
  // Preserve one look-ahead row even at the public maximum page size.
  const firstPageCandidateLimitIndex = addParam(params, Math.max(250, limit + 1));
  const limitIndex = addParam(params, limit + 1);
  const useFastCursorCandidates = Boolean(
    cursor &&
      !requireFreshOrderBook &&
      !options.search?.trim() &&
      !options.category?.trim() &&
      !options.eventGroupKey?.trim()
  );
  const historicalSnapshotsSql = cursor
    ? `
        SELECT
          changed_markets.id AS market_db_id,
          changed_markets.source_market_id,
          historical_snapshot.id AS snapshot_id,
          historical_snapshot.captured_at,
          historical_snapshot.volume_micro_usd,
          historical_snapshot.liquidity_micro_usd,
          historical_snapshot.raw,
          historical_snapshot.catalog_sequence,
          snapshot_boundary.catalog_sequence AS snapshot_boundary_sequence
        FROM (
          SELECT markets.id, markets.source_market_id
          FROM candidate_markets markets
          CROSS JOIN snapshot_boundary
          LEFT JOIN market_snapshots AS current_snapshot
            ON current_snapshot.id = markets.current_snapshot_id
          WHERE current_snapshot.id IS NULL
            OR current_snapshot.captured_at > $${snapshotAtIndex}::timestamptz
            OR current_snapshot.catalog_sequence > snapshot_boundary.catalog_sequence
        ) AS changed_markets
        CROSS JOIN snapshot_boundary
        JOIN LATERAL (
          SELECT market_snapshots.*
          FROM market_snapshots
          WHERE market_snapshots.market_id = changed_markets.id
            AND market_snapshots.captured_at <= $${snapshotAtIndex}::timestamptz
            AND market_snapshots.catalog_sequence <= snapshot_boundary.catalog_sequence
          ORDER BY market_snapshots.catalog_sequence DESC
          LIMIT 1
        ) AS historical_snapshot ON true
      `
    : `
        SELECT pointer_snapshots.*
        FROM pointer_snapshots
        WHERE false
      `;

  const result = await getPool().query<{
    outcome_id: string;
    source_market_id: string;
    sort_market_id: string;
    condition_id: string | null;
    token_id: string | null;
    question: string;
    market_url: string;
    category: string;
    source_category: string | null;
    canonical_category: string | null;
    source_tags: unknown;
    taxonomy: unknown;
    event_group_key: string | null;
    event_title: string | null;
    event_slug: string | null;
    relationship_metadata: unknown;
    eligibility_metadata: unknown;
    source_active: boolean | null;
    closed: boolean | null;
    archived: boolean | null;
    accepting_orders: boolean | null;
    enable_order_book: boolean | null;
    outcome: string;
    end_date: Date | null;
    neg_risk: boolean | null;
    rfq_enabled: boolean | null;
    captured_at: Date;
    volume_micro_usd: string | null;
    liquidity_micro_usd: string | null;
    cursor_value_1: string | null;
    cursor_value_2: string | null;
    cursor_value_3: string | null;
    snapshot_sequence: string;
    outcome_order: number;
    outcome_record: MarketOutcome;
    raw: {
      market?: MarketOutcome;
      publiclyVisible?: boolean;
      outcomes?: MarketOutcome[];
      complete?: boolean;
      totalFeeds?: number;
      successfulFeeds?: number;
      nextCursor?: string;
      sweep?: MarketCatalogSnapshot["sweep"];
    };
  }>(
    `
      WITH snapshot_boundary AS (
        SELECT COALESCE($${snapshotSequenceIndex}::bigint, MAX(catalog_sequence)) AS catalog_sequence
        FROM market_snapshots
      ),
      candidate_markets AS MATERIALIZED (
        SELECT id, source_market_id, end_date, current_snapshot_id
        FROM markets AS markets
        WHERE source = 'polymarket'
          AND publicly_visible = true
          AND active = true
          AND closed = false
          AND archived = false
          AND accepting_orders = true
          AND enable_order_book = true
          AND (end_date IS NULL OR end_date > $${evaluationNowIndex}::timestamptz)
          ${candidateFilters.length > 0 ? `AND ${candidateFilters.join("\n          AND ")}` : ""}
      ),
      first_page_candidate_markets AS MATERIALIZED (
        SELECT markets.id, markets.source_market_id, markets.end_date, markets.current_snapshot_id
        FROM candidate_markets markets
        JOIN market_snapshots AS latest_snapshot
          ON latest_snapshot.id = markets.current_snapshot_id
        WHERE latest_snapshot.captured_at >= $${evaluationNowIndex}::timestamptz - ($${maxAgeIndex}::double precision * interval '1 millisecond')
          AND ${
            eligibilityConfig.allowUnknownLiquiditySignals
              ? `(
                  (latest_snapshot.liquidity_micro_usd IS NULL AND latest_snapshot.volume_micro_usd IS NULL)
                  OR latest_snapshot.liquidity_micro_usd >= $${minLiquidityIndex}::bigint
                  OR latest_snapshot.volume_micro_usd >= $${minVolumeIndex}::bigint
                )`
              : `(
                  latest_snapshot.liquidity_micro_usd >= $${minLiquidityIndex}::bigint
                  OR latest_snapshot.volume_micro_usd >= $${minVolumeIndex}::bigint
                )`
          }
        ORDER BY ${directSortOrderClause(fields, "markets.source_market_id")}
        LIMIT $${firstPageCandidateLimitIndex}
      ),
      pointer_snapshots AS MATERIALIZED (
        SELECT
          markets.id AS market_db_id,
          markets.source_market_id,
          market_snapshots.id AS snapshot_id,
          market_snapshots.captured_at,
          market_snapshots.volume_micro_usd,
          market_snapshots.liquidity_micro_usd,
          market_snapshots.raw,
          market_snapshots.catalog_sequence,
          snapshot_boundary.catalog_sequence AS snapshot_boundary_sequence
        FROM ${cursor || requireFreshOrderBook ? "candidate_markets" : "first_page_candidate_markets"} markets
        CROSS JOIN snapshot_boundary
        JOIN market_snapshots
          ON market_snapshots.id = markets.current_snapshot_id
        WHERE market_snapshots.captured_at <= $${snapshotAtIndex}::timestamptz
          AND market_snapshots.catalog_sequence <= snapshot_boundary.catalog_sequence
      ),
      historical_snapshots AS MATERIALIZED (
        ${historicalSnapshotsSql}
      ),
      pinned_snapshots AS (
        SELECT * FROM pointer_snapshots
        UNION ALL
        SELECT * FROM historical_snapshots
      ),
      cursor_page_candidate_snapshots AS MATERIALIZED (
        SELECT
          ranked.market_db_id,
          ranked.source_market_id,
          ranked.snapshot_id,
          ranked.captured_at,
          ranked.volume_micro_usd,
          ranked.liquidity_micro_usd,
          ranked.raw,
          ranked.catalog_sequence,
          ranked.snapshot_boundary_sequence
        FROM (
          SELECT
            latest_snapshot.*,
            ${sortSelectList(fields)},
            latest_snapshot.source_market_id AS sort_market_id
          FROM pinned_snapshots latest_snapshot
          JOIN candidate_markets markets ON markets.id = latest_snapshot.market_db_id
          WHERE latest_snapshot.captured_at >= $${evaluationNowIndex}::timestamptz - ($${maxAgeIndex}::double precision * interval '1 millisecond')
            AND (markets.end_date IS NULL OR markets.end_date > $${evaluationNowIndex}::timestamptz)
            AND ${
              eligibilityConfig.allowUnknownLiquiditySignals
                ? `(
                    (latest_snapshot.liquidity_micro_usd IS NULL AND latest_snapshot.volume_micro_usd IS NULL)
                    OR latest_snapshot.liquidity_micro_usd >= $${minLiquidityIndex}::bigint
                    OR latest_snapshot.volume_micro_usd >= $${minVolumeIndex}::bigint
                  )`
                : `(
                    latest_snapshot.liquidity_micro_usd >= $${minLiquidityIndex}::bigint
                    OR latest_snapshot.volume_micro_usd >= $${minVolumeIndex}::bigint
                  )`
            }
        ) AS ranked
        ${useFastCursorCandidates ? cursorPredicate : "WHERE false"}
        ORDER BY ${sortOrderClause(fields, "ranked")}
        LIMIT $${firstPageCandidateLimitIndex}
      ),
      fresh_pinned_snapshots AS (
        SELECT
          latest_snapshot.*,
          COALESCE(latest_snapshot.raw->'market', latest_snapshot.raw->'outcomes'->0) AS market_record,
          CASE
            WHEN COALESCE(latest_snapshot.raw->'market', latest_snapshot.raw->'outcomes'->0)->>'endDate' ~ '^\\d{4}-\\d{2}-\\d{2}T'
              THEN (COALESCE(latest_snapshot.raw->'market', latest_snapshot.raw->'outcomes'->0)->>'endDate')::timestamptz
            ELSE NULL
          END AS end_date
        FROM ${useFastCursorCandidates ? "cursor_page_candidate_snapshots" : "pinned_snapshots"} latest_snapshot
        JOIN candidate_markets markets ON markets.id = latest_snapshot.market_db_id
        WHERE latest_snapshot.captured_at >= $${evaluationNowIndex}::timestamptz - ($${maxAgeIndex}::double precision * interval '1 millisecond')
          AND (markets.end_date IS NULL OR markets.end_date > $${evaluationNowIndex}::timestamptz)
      ),
      eligible_outcomes AS (
        SELECT
          latest_snapshot.snapshot_id,
          catalog_outcome.outcome_record,
          catalog_outcome.outcome_order::integer
        FROM fresh_pinned_snapshots latest_snapshot
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(latest_snapshot.raw->'outcomes', '[]'::jsonb))
          WITH ORDINALITY AS catalog_outcome(outcome_record, outcome_order)
        WHERE COALESCE((latest_snapshot.raw->>'publiclyVisible')::boolean, false) = true
          AND catalog_outcome.outcome_record->>'source' = 'polymarket'
          AND catalog_outcome.outcome_record->'sourceActive' = 'true'::jsonb
          AND catalog_outcome.outcome_record->'closed' = 'false'::jsonb
          AND catalog_outcome.outcome_record->'archived' = 'false'::jsonb
          AND catalog_outcome.outcome_record->'acceptingOrders' = 'true'::jsonb
          AND catalog_outcome.outcome_record->'enableOrderBook' = 'true'::jsonb
          AND (
            catalog_outcome.outcome_record->>'endDate' IS NULL
            OR catalog_outcome.outcome_record->>'endDate' !~ '^\\d{4}-\\d{2}-\\d{2}T'
            OR (catalog_outcome.outcome_record->>'endDate')::timestamptz > $${evaluationNowIndex}::timestamptz
          )
          AND NULLIF(btrim(catalog_outcome.outcome_record->>'conditionId'), '') IS NOT NULL
          AND NULLIF(btrim(catalog_outcome.outcome_record->>'tokenId'), '') IS NOT NULL
          ${
            requireFreshOrderBook
              ? `AND catalog_outcome.outcome_record->>'priceSource' IN ('clob_ask', 'clob_vwap')
          AND jsonb_typeof(catalog_outcome.outcome_record->'bestAsk') = 'number'
          AND (catalog_outcome.outcome_record->>'bestAsk')::double precision > 0
          AND (catalog_outcome.outcome_record->>'bestAsk')::double precision < 1
          AND jsonb_typeof(catalog_outcome.outcome_record->'executablePrice') = 'number'
          AND (catalog_outcome.outcome_record->>'executablePrice')::double precision > 0.01
          AND (catalog_outcome.outcome_record->>'executablePrice')::double precision < 0.99
          AND jsonb_typeof(catalog_outcome.outcome_record->'requestedNotionalUsd') = 'number'
          AND (catalog_outcome.outcome_record->>'requestedNotionalUsd')::double precision > 0
          AND jsonb_typeof(catalog_outcome.outcome_record->'availableAskNotionalUsd') = 'number'
          AND (catalog_outcome.outcome_record->>'availableAskNotionalUsd')::double precision >=
            (catalog_outcome.outcome_record->>'requestedNotionalUsd')::double precision
          AND catalog_outcome.outcome_record->>'orderbookTimestamp' ~ '^\\d{4}-\\d{2}-\\d{2}T'
          AND (catalog_outcome.outcome_record->>'orderbookTimestamp')::timestamptz >=
            $${evaluationNowIndex}::timestamptz - ($${maxAgeIndex}::double precision * interval '1 millisecond')
          AND (catalog_outcome.outcome_record->>'orderbookTimestamp')::timestamptz <=
            $${evaluationNowIndex}::timestamptz + interval '30 seconds'
          AND (
            jsonb_typeof(catalog_outcome.outcome_record->'spread') IS DISTINCT FROM 'number'
            OR (catalog_outcome.outcome_record->>'spread')::double precision <= $${maxSpreadIndex!}::double precision
          )`
              : ""
          }
          AND ${
            eligibilityConfig.allowUnknownLiquiditySignals
              ? `(
                  (latest_snapshot.liquidity_micro_usd IS NULL AND latest_snapshot.volume_micro_usd IS NULL)
                  OR latest_snapshot.liquidity_micro_usd >= $${minLiquidityIndex}::bigint
                  OR latest_snapshot.volume_micro_usd >= $${minVolumeIndex}::bigint
                )`
              : `(
                  latest_snapshot.liquidity_micro_usd >= $${minLiquidityIndex}::bigint
                  OR latest_snapshot.volume_micro_usd >= $${minVolumeIndex}::bigint
                )`
          }
      ),
      filtered_markets AS (
        SELECT
          latest_snapshot.market_db_id AS id,
          COALESCE(latest_snapshot.raw->>'marketId', latest_snapshot.market_record->>'marketId') AS source_market_id,
          latest_snapshot.market_record->>'conditionId' AS condition_id,
          latest_snapshot.market_record->>'question' AS question,
          COALESCE(latest_snapshot.market_record->>'marketUrl', '') AS market_url,
          COALESCE(latest_snapshot.market_record->>'category', 'Other') AS category,
          latest_snapshot.market_record->>'sourceCategory' AS source_category,
          COALESCE(latest_snapshot.market_record->'taxonomy'->>'category', latest_snapshot.market_record->>'category', 'Other') AS canonical_category,
          COALESCE(latest_snapshot.market_record->'sourceTags', '[]'::jsonb) AS source_tags,
          COALESCE(latest_snapshot.market_record->'taxonomy', '{}'::jsonb) AS taxonomy,
          latest_snapshot.market_record->>'eventGroupKey' AS event_group_key,
          latest_snapshot.market_record->>'eventTitle' AS event_title,
          latest_snapshot.market_record->>'eventSlug' AS event_slug,
          COALESCE(latest_snapshot.market_record->'relationships', '{}'::jsonb) AS relationship_metadata,
          COALESCE(latest_snapshot.market_record->'eligibility', '{}'::jsonb) AS eligibility_metadata,
          COALESCE((latest_snapshot.market_record->>'sourceActive')::boolean, true) AS source_active,
          COALESCE((latest_snapshot.market_record->>'closed')::boolean, false) AS closed,
          COALESCE((latest_snapshot.market_record->>'archived')::boolean, false) AS archived,
          COALESCE((latest_snapshot.market_record->>'acceptingOrders')::boolean, true) AS accepting_orders,
          COALESCE((latest_snapshot.market_record->>'enableOrderBook')::boolean, true) AS enable_order_book,
          latest_snapshot.end_date,
          (latest_snapshot.market_record->>'negRisk')::boolean AS neg_risk,
          (latest_snapshot.market_record->>'rfqEnabled')::boolean AS rfq_enabled,
          latest_snapshot.snapshot_id,
          latest_snapshot.captured_at,
          latest_snapshot.volume_micro_usd,
          latest_snapshot.liquidity_micro_usd,
          latest_snapshot.raw,
          ${sortSelectList(fields)},
          COALESCE(latest_snapshot.raw->>'marketId', latest_snapshot.market_record->>'marketId') AS sort_market_id,
          latest_snapshot.snapshot_boundary_sequence::text AS snapshot_sequence
        FROM fresh_pinned_snapshots latest_snapshot
        WHERE ${filters.join("\n          AND ")}
      ),
      selected_markets AS (
        SELECT *
        FROM filtered_markets
        ${cursorPredicate}
        ORDER BY ${sortOrderClause(fields)}
        LIMIT $${limitIndex}
      )
      SELECT
        catalog_outcome.outcome_record->>'id' AS outcome_id,
        COALESCE(catalog_outcome.outcome_record->>'marketId', selected_markets.source_market_id) AS source_market_id,
        selected_markets.sort_market_id,
        catalog_outcome.outcome_record->>'conditionId' AS condition_id,
        catalog_outcome.outcome_record->>'tokenId' AS token_id,
        catalog_outcome.outcome_record->>'question' AS question,
        COALESCE(catalog_outcome.outcome_record->>'marketUrl', '') AS market_url,
        COALESCE(catalog_outcome.outcome_record->>'category', 'Other') AS category,
        catalog_outcome.outcome_record->>'sourceCategory' AS source_category,
        COALESCE(catalog_outcome.outcome_record->'taxonomy'->>'category', catalog_outcome.outcome_record->>'category', 'Other') AS canonical_category,
        COALESCE(catalog_outcome.outcome_record->'sourceTags', '[]'::jsonb) AS source_tags,
        COALESCE(catalog_outcome.outcome_record->'taxonomy', '{}'::jsonb) AS taxonomy,
        catalog_outcome.outcome_record->>'eventGroupKey' AS event_group_key,
        catalog_outcome.outcome_record->>'eventTitle' AS event_title,
        catalog_outcome.outcome_record->>'eventSlug' AS event_slug,
        COALESCE(catalog_outcome.outcome_record->'relationships', '{}'::jsonb) AS relationship_metadata,
        COALESCE(catalog_outcome.outcome_record->'eligibility', '{}'::jsonb) AS eligibility_metadata,
        (catalog_outcome.outcome_record->>'sourceActive')::boolean AS source_active,
        (catalog_outcome.outcome_record->>'closed')::boolean AS closed,
        (catalog_outcome.outcome_record->>'archived')::boolean AS archived,
        (catalog_outcome.outcome_record->>'acceptingOrders')::boolean AS accepting_orders,
        (catalog_outcome.outcome_record->>'enableOrderBook')::boolean AS enable_order_book,
        catalog_outcome.outcome_record->>'outcome' AS outcome,
        selected_markets.end_date,
        (catalog_outcome.outcome_record->>'negRisk')::boolean AS neg_risk,
        (catalog_outcome.outcome_record->>'rfqEnabled')::boolean AS rfq_enabled,
        selected_markets.captured_at,
        selected_markets.volume_micro_usd::text,
        selected_markets.liquidity_micro_usd::text,
        selected_markets.sort_value_1::text AS cursor_value_1,
        selected_markets.sort_value_2::text AS cursor_value_2,
        selected_markets.sort_value_3::text AS cursor_value_3,
        selected_markets.snapshot_sequence,
        catalog_outcome.outcome_order,
        catalog_outcome.outcome_record,
        selected_markets.raw
      FROM selected_markets
      JOIN eligible_outcomes catalog_outcome ON catalog_outcome.snapshot_id = selected_markets.snapshot_id
      ORDER BY ${sortOrderClause(fields, "selected_markets")}, catalog_outcome.outcome_order ASC
    `,
    params
  );

  if (result.rows.length === 0) {
    throw new Error("No persisted market catalog available. Run npm run index:markets first.");
  }

  const marketIdsInOrder: string[] = [];
  for (const row of result.rows) {
    if (!marketIdsInOrder.includes(row.source_market_id)) {
      marketIdsInOrder.push(row.source_market_id);
    }
  }
  const selectedMarketIds = new Set(marketIdsInOrder.slice(0, limit));
  const pageRows = result.rows.filter((row) => selectedMarketIds.has(row.source_market_id));
  const lastMarketId = marketIdsInOrder[Math.min(marketIdsInOrder.length, limit) - 1];
  const lastCursorRow = lastMarketId ? pageRows.find((row) => row.source_market_id === lastMarketId) : undefined;

  const oldestCapturedAt = Math.min(...pageRows.map((row) => row.captured_at.getTime()));
  const asOf = new Date(oldestCapturedAt).toISOString();
  const completeValues = pageRows.map((row) => row.raw.complete).filter((value): value is boolean => typeof value === "boolean");
  const totalFeedCounts = finiteNumbers(pageRows.map((row) => row.raw.totalFeeds));
  const successfulFeedCounts = finiteNumbers(pageRows.map((row) => row.raw.successfulFeeds));
  const marketOrder = new Map<string, number>();
  for (const row of pageRows) {
    if (!marketOrder.has(row.source_market_id)) {
      marketOrder.set(row.source_market_id, marketOrder.size);
    }
  }

  const outcomes = pageRows
    .map((row) => {
      if (row.captured_at.getTime() < evaluationNow.getTime() - maxSnapshotAgeMs) return undefined;
      if (row.closed || row.archived || row.accepting_orders === false || row.enable_order_book === false || row.source_active === false) return undefined;
      const rawOutcomeIndex = row.outcome_order - 1;
      const rawOutcome = row.outcome_record;
      if (!rawOutcome || !Number.isFinite(rawOutcome.price)) return undefined;

      const outcome: MarketOutcome = {
        id: row.outcome_id,
        marketId: row.source_market_id,
        question: row.question,
        marketUrl: row.market_url,
        category: row.canonical_category || row.category,
        outcome: row.outcome,
        price: rawOutcome.price,
        sourceAsOf: row.captured_at.toISOString(),
        endDate: rawOutcome.endDate || row.end_date?.toISOString(),
        liquidity: row.liquidity_micro_usd ? Number(row.liquidity_micro_usd) / 1_000_000 : rawOutcome.liquidity,
        volume: row.volume_micro_usd ? Number(row.volume_micro_usd) / 1_000_000 : rawOutcome.volume,
        image: rawOutcome.image,
        icon: rawOutcome.icon,
        bestBid: rawOutcome.bestBid,
        bestAsk: rawOutcome.bestAsk,
        executablePrice: rawOutcome.executablePrice,
        vwapPrice: rawOutcome.vwapPrice,
        requestedNotionalUsd: rawOutcome.requestedNotionalUsd,
        availableAskNotionalUsd: rawOutcome.availableAskNotionalUsd,
        spread: rawOutcome.spread,
        priceSource: rawOutcome.priceSource,
        orderbookTimestamp: rawOutcome.orderbookTimestamp,
        orderbookHash: rawOutcome.orderbookHash,
        enableOrderBook: rawOutcome.enableOrderBook,
        negRisk: row.neg_risk ?? rawOutcome.negRisk,
        rfqEnabled: row.rfq_enabled ?? rawOutcome.rfqEnabled,
        sourceCategory: row.source_category || rawOutcome.sourceCategory,
        sourceTags: jsonArray(row.source_tags).length ? jsonArray(row.source_tags) : rawOutcome.sourceTags,
        taxonomy: jsonObject(row.taxonomy) || rawOutcome.taxonomy,
        eventGroupKey: row.event_group_key || rawOutcome.eventGroupKey,
        eventTitle: row.event_title || rawOutcome.eventTitle,
        eventSlug: row.event_slug || rawOutcome.eventSlug,
        relationships: jsonObject(row.relationship_metadata) || rawOutcome.relationships,
        eligibility: jsonObject(row.eligibility_metadata) || rawOutcome.eligibility,
        sourceActive: row.source_active ?? rawOutcome.sourceActive,
        closed: row.closed ?? rawOutcome.closed,
        archived: row.archived ?? rawOutcome.archived,
        acceptingOrders: row.accepting_orders ?? rawOutcome.acceptingOrders,
        source: "polymarket" as const
      };

      if (row.condition_id) outcome.conditionId = row.condition_id;
      if (row.token_id) outcome.tokenId = row.token_id;
      if (!outcome.endDate && row.end_date) outcome.endDate = row.end_date.toISOString();
      const annotated = annotateCatalogOutcomes([outcome], {
        now: evaluationNow,
        eligibilityConfig: readEligibilityConfig
      })[0];
      if (annotated.eligibility?.eligible === false) return undefined;
      return {
        outcome: annotated,
        marketOrder: marketOrder.get(row.source_market_id) ?? Number.MAX_SAFE_INTEGER,
        outcomeOrder: rawOutcomeIndex
      };
    })
    .filter((item) => Boolean(item))
    .sort((a, b) => a!.marketOrder - b!.marketOrder || a!.outcomeOrder - b!.outcomeOrder)
    .map((item) => item!.outcome);

  if (outcomes.length === 0) {
    throw new Error("No public persisted market catalog rows are currently eligible.");
  }

  const groupsByKey = new Map<string, MarketCatalogGroup>();
  for (const outcome of outcomes) {
    if (!outcome.eventGroupKey) continue;
    const current = groupsByKey.get(outcome.eventGroupKey) || {
      eventGroupKey: outcome.eventGroupKey,
      eventTitle: outcome.eventTitle,
      eventSlug: outcome.eventSlug,
      category: outcome.category,
      marketCount: 0,
      outcomeCount: 0
    };
    current.outcomeCount += 1;
    if (outcome.outcome === outcomes.find((item) => item.marketId === outcome.marketId)?.outcome) {
      current.marketCount += 1;
    }
    groupsByKey.set(outcome.eventGroupKey, current);
  }

  const hasMore = marketIdsInOrder.length > limit;
  const publicNextCursor =
    hasMore && lastCursorRow
      ? encodePublicCursor({
          v: 2,
          fp: fingerprint,
          sort,
          snapshotAt,
          snapshotSequence: lastCursorRow.snapshot_sequence,
          values: [lastCursorRow.cursor_value_1, lastCursorRow.cursor_value_2, lastCursorRow.cursor_value_3]
            .slice(0, fields.length)
            .map((value) => String(value)),
          marketId: lastCursorRow.sort_market_id
        })
      : undefined;

  return {
    asOf,
    source: "polymarket",
    complete: completeValues.length > 0 ? completeValues.every(Boolean) : undefined,
    totalFeeds: totalFeedCounts.length > 0 ? Math.max(...totalFeedCounts) : undefined,
    successfulFeeds: successfulFeedCounts.length > 0 ? Math.min(...successfulFeedCounts) : undefined,
    nextCursor: publicNextCursor,
    sweep: pageRows.find((row) => row.raw.sweep)?.raw.sweep,
    outcomes,
    groups: [...groupsByKey.values()],
    pageInfo: {
      limit,
      offset: 0,
      nextCursor: publicNextCursor,
      hasMore,
      total: undefined
    }
  };
}

export async function getPersistedMarketCatalog(options: CatalogReadOptions = {}): Promise<MarketCatalogSnapshot> {
  return getPersistedMarketCatalogPage(options);
}

export async function getPersistedMarketOutcomesByIds(
  outcomeIds: string[],
  options: Pick<CatalogReadOptions, "now" | "maxSnapshotAgeMs"> = {}
): Promise<MarketCatalogSnapshot> {
  const requestedIds = outcomeIds.map((id) => id.trim()).filter(Boolean);
  if (requestedIds.length === 0) {
    return { asOf: (options.now || new Date()).toISOString(), source: "polymarket", complete: true, outcomes: [] };
  }
  if (requestedIds.length > 20 || new Set(requestedIds).size !== requestedIds.length) {
    throw new Error("market_outcome_ids_invalid");
  }

  const now = options.now || new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("market_catalog_invalid_current_time");
  const maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? 30 * 60_000;
  const result = await getPool().query<{
    requested_id: string;
    captured_at: Date;
    outcome_record: MarketCatalogOutcome;
  }>(
    `
      WITH requested AS (
        SELECT outcome_id AS requested_id, ordinality
        FROM unnest($1::text[]) WITH ORDINALITY AS requested_outcome(outcome_id, ordinality)
      )
      SELECT
        requested.requested_id,
        latest_snapshot.captured_at,
        snapshot_outcome.outcome_record
      FROM requested
      JOIN markets
        ON markets.source = 'polymarket'
      JOIN market_outcomes
        ON market_outcomes.market_id = markets.id
        AND market_outcomes.source_outcome_id = requested.requested_id
      JOIN market_snapshots AS latest_snapshot
        ON latest_snapshot.id = markets.current_snapshot_id
      JOIN LATERAL (
        SELECT outcome_record
        FROM jsonb_array_elements(COALESCE(latest_snapshot.raw->'outcomes', '[]'::jsonb)) AS catalog_outcome(outcome_record)
        WHERE outcome_record->>'id' = requested.requested_id
        LIMIT 1
      ) snapshot_outcome ON true
      WHERE markets.publicly_visible = true
        AND markets.active = true
        AND markets.closed = false
        AND markets.archived = false
        AND markets.accepting_orders = true
        AND markets.enable_order_book = true
        AND (markets.end_date IS NULL OR markets.end_date > $2::timestamptz)
        AND NULLIF(btrim(markets.condition_id), '') IS NOT NULL
        AND NULLIF(btrim(market_outcomes.token_id), '') IS NOT NULL
        AND latest_snapshot.captured_at >= $2::timestamptz - ($3::double precision * interval '1 millisecond')
        AND snapshot_outcome.outcome_record->'sourceActive' = 'true'::jsonb
        AND snapshot_outcome.outcome_record->'closed' = 'false'::jsonb
        AND snapshot_outcome.outcome_record->'archived' = 'false'::jsonb
        AND snapshot_outcome.outcome_record->'acceptingOrders' = 'true'::jsonb
        AND snapshot_outcome.outcome_record->'enableOrderBook' = 'true'::jsonb
        AND NULLIF(btrim(snapshot_outcome.outcome_record->>'conditionId'), '') IS NOT NULL
        AND NULLIF(btrim(snapshot_outcome.outcome_record->>'tokenId'), '') IS NOT NULL
      ORDER BY requested.ordinality
    `,
    [requestedIds, now.toISOString(), maxSnapshotAgeMs]
  );

  const outcomes = annotateCatalogOutcomes(
    result.rows.map((row) => ({
      ...row.outcome_record,
      sourceAsOf: row.captured_at.toISOString()
    })),
    {
      now,
      eligibilityConfig: {
        ...marketEligibilityConfigFromEnv(),
        requireOrderBook: false
      }
    }
  ).filter((outcome) => outcome.eligibility?.eligible === true);
  const capturedTimes = result.rows.map((row) => row.captured_at.getTime()).filter(Number.isFinite);

  return {
    asOf: capturedTimes.length > 0 ? new Date(Math.min(...capturedTimes)).toISOString() : now.toISOString(),
    source: "polymarket",
    complete: outcomes.length === requestedIds.length,
    outcomes
  };
}
