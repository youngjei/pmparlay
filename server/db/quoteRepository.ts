import type { RiskCheck } from "../../packages/domain/src/riskEngine";
import { DEFAULT_RISK_POLICY } from "../../packages/domain/src/riskEngine";
import type { QuoteLeg, QuoteResponse } from "../quoteService";
import { getPool } from "./client";

function microUsd(value: number) {
  return Math.round(value * 1_000_000);
}

function bps(value: number) {
  return Math.round(value * 10_000);
}

async function ensurePolicyVersion(client: import("pg").PoolClient) {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO policy_versions (version, description, policy, active)
      VALUES ($1, $2, $3, true)
      ON CONFLICT (version)
      DO UPDATE SET
        description = EXCLUDED.description,
        policy = EXCLUDED.policy,
        active = true
      RETURNING id
    `,
    ["server-risk-v1", "Initial deterministic launch risk policy", DEFAULT_RISK_POLICY]
  );

  return result.rows[0].id;
}

async function latestMarketRefs(client: import("pg").PoolClient, leg: QuoteResponse["legs"][number]) {
  const result = await client.query<{
    market_id: string;
    outcome_id: string;
    snapshot_id: string;
  }>(
    `
      SELECT
        markets.id AS market_id,
        market_outcomes.id AS outcome_id,
        market_snapshots.id AS snapshot_id
      FROM markets
      JOIN market_outcomes
        ON market_outcomes.market_id = markets.id
        AND market_outcomes.outcome = $3
      JOIN LATERAL (
        SELECT id
        FROM market_snapshots
        WHERE market_snapshots.market_id = markets.id
        ORDER BY captured_at DESC
        LIMIT 1
      ) market_snapshots ON true
      WHERE markets.source = 'polymarket'
        AND markets.source_market_id = $1
        AND markets.condition_id IS NOT DISTINCT FROM $2
      LIMIT 1
    `,
    [leg.marketId, leg.conditionId || null, leg.outcome]
  );

  if (!result.rows[0]) {
    throw new Error(`No persisted market snapshot found for quote leg ${leg.id}`);
  }

  return result.rows[0];
}

async function insertRiskCheck(client: import("pg").PoolClient, quoteId: string, check: RiskCheck) {
  await client.query(
    `
      INSERT INTO risk_checks (quote_id, level, label, detail)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `,
    [quoteId, check.level, check.label, check.detail]
  );
}

export async function persistQuote(quote: QuoteResponse, userId?: string) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const policyVersionId = await ensurePolicyVersion(client);

    await client.query(
      `
        INSERT INTO quotes (
          id,
          user_id,
          policy_version_id,
          status,
          stake_micro_usd,
          operation_fee_micro_usd,
          spread_bps,
          implied_probability_bps,
          offered_payout_micro_usd,
          risk_decision,
          expires_at,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        quote.id,
        userId || null,
        policyVersionId,
        quote.status,
        microUsd(quote.stakeUsd),
        microUsd(quote.operationFeeUsd),
        bps(quote.quoteSpread),
        bps(quote.basketProbability),
        microUsd(quote.potentialPayoutUsd),
        quote.riskDecision,
        quote.expiresAt,
        quote.createdAt
      ]
    );

    for (const leg of quote.legs) {
      const refs = await latestMarketRefs(client, leg);
      await client.query(
        `
          INSERT INTO quote_legs (
            quote_id,
            market_id,
            outcome_id,
            market_snapshot_id,
            outcome,
            quoted_price_bps
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING
        `,
        [quote.id, refs.market_id, refs.outcome_id, refs.snapshot_id, leg.outcome, bps(leg.price)]
      );
    }

    for (const check of quote.riskChecks) {
      await insertRiskCheck(client, quote.id, check);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPersistedQuote(id: string, userId?: string): Promise<QuoteResponse | undefined> {
  const client = await getPool().connect();

  try {
    const quoteResult = await client.query<{
      id: string;
      status: "quoted" | "accepted" | "expired" | "rejected";
      stake_micro_usd: string;
      operation_fee_micro_usd: string;
      spread_bps: number;
      implied_probability_bps: number;
      offered_payout_micro_usd: string;
      risk_decision: "accept" | "review" | "reject";
      expires_at: Date;
      created_at: Date;
      source_as_of: Date | null;
    }>(
      `
        SELECT
          quotes.id,
          quotes.status,
          quotes.stake_micro_usd::text,
          quotes.operation_fee_micro_usd::text,
          quotes.spread_bps,
          quotes.implied_probability_bps,
          quotes.offered_payout_micro_usd::text,
          quotes.risk_decision,
          quotes.expires_at,
          quotes.created_at,
          max(market_snapshots.captured_at) AS source_as_of
        FROM quotes
        LEFT JOIN quote_legs ON quote_legs.quote_id = quotes.id
        LEFT JOIN market_snapshots ON market_snapshots.id = quote_legs.market_snapshot_id
        WHERE quotes.id = $1
          AND ($2::uuid IS NULL OR quotes.user_id = $2)
        GROUP BY quotes.id
      `,
      [id, userId || null]
    );
    const quote = quoteResult.rows[0];
    if (!quote) return undefined;

    const legsResult = await client.query<{
      id: string;
      market_id: string;
      condition_id: string | null;
      token_id: string | null;
      question: string;
      outcome: string;
      quoted_price_bps: number;
      market_url: string | null;
      end_date: Date | null;
      volume_micro_usd: string | null;
      liquidity_micro_usd: string | null;
    }>(
      `
        SELECT
          market_outcomes.id,
          markets.source_market_id AS market_id,
          markets.condition_id,
          market_outcomes.token_id,
          markets.question,
          quote_legs.outcome,
          quote_legs.quoted_price_bps,
          markets.market_url,
          markets.end_date,
          market_snapshots.volume_micro_usd::text,
          market_snapshots.liquidity_micro_usd::text
        FROM quote_legs
        JOIN markets ON markets.id = quote_legs.market_id
        JOIN market_outcomes ON market_outcomes.id = quote_legs.outcome_id
        JOIN market_snapshots ON market_snapshots.id = quote_legs.market_snapshot_id
        WHERE quote_legs.quote_id = $1
        ORDER BY quote_legs.created_at ASC
      `,
      [id]
    );

    const checksResult = await client.query<{
      level: "ok" | "warn" | "block";
      label: string;
      detail: string;
    }>(
      `
        SELECT level, label, detail
        FROM risk_checks
        WHERE quote_id = $1
        ORDER BY created_at ASC
      `,
      [id]
    );

    const stakeUsd = Number(quote.stake_micro_usd) / 1_000_000;
    const operationFeeUsd = Number(quote.operation_fee_micro_usd) / 1_000_000;
    const potentialPayoutUsd = Number(quote.offered_payout_micro_usd) / 1_000_000;
    const basketProbability = quote.implied_probability_bps / 10_000;
    const quoteSpread = quote.spread_bps / 10_000;
    const payoutMultiple = stakeUsd > 0 ? potentialPayoutUsd / stakeUsd : 0;
    const hasBlock = checksResult.rows.some((check) => check.level === "block");

    const legs: QuoteLeg[] = legsResult.rows.map((leg) => ({
      id: leg.id,
      marketId: leg.market_id,
      conditionId: leg.condition_id || undefined,
      tokenId: leg.token_id || undefined,
      question: leg.question,
      outcome: leg.outcome,
      price: leg.quoted_price_bps / 10_000,
      marketUrl: leg.market_url || undefined,
      endDate: leg.end_date?.toISOString(),
      volume: leg.volume_micro_usd ? Number(leg.volume_micro_usd) / 1_000_000 : undefined,
      liquidity: leg.liquidity_micro_usd ? Number(leg.liquidity_micro_usd) / 1_000_000 : undefined
    }));

    return {
      id: quote.id,
      status: quote.status,
      createdAt: quote.created_at.toISOString(),
      expiresAt: quote.expires_at.toISOString(),
      sourceAsOf: (quote.source_as_of || quote.created_at).toISOString(),
      stakeUsd,
      operationFeeUsd,
      totalCostUsd: stakeUsd + operationFeeUsd,
      basketPrice: basketProbability,
      basketProbability,
      quoteSpread,
      payoutMultiple,
      potentialPayoutUsd,
      riskDecision: hasBlock || quote.status === "rejected" ? "reject" : quote.risk_decision,
      riskChecks: checksResult.rows,
      legs
    };
  } finally {
    client.release();
  }
}
