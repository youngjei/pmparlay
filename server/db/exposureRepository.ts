import { getPool } from "./client";
import type { QuoteResponse } from "../quoteService";
import type { RiskCheck } from "../../packages/domain/src/riskEngine";

function microUsdToUsd(value: string | number | null) {
  return Number(value || 0) / 1_000_000;
}

function usdToMicroUnits(value: number, label: string) {
  const scaled = Math.round(value * 1_000_000);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(scaled)) {
    throw new Error(`invalid_exposure_value:${label}`);
  }
  return BigInt(scaled);
}

type ExposureCheckLimits = {
  maxMarketLiabilityUsd: number;
  maxEventLiabilityUsd: number;
  maxUserLiabilityUsd?: number;
  userId?: string;
  includeSoftReservations?: boolean;
  excludePaymentIntentId?: string;
};

export async function listOpenMarketExposure() {
  const result = await getPool().query<{
    market_id: string;
    source_market_id: string;
    question: string;
    market_url: string;
    outcome: string;
    open_tickets: string;
    open_payment_intents?: string;
    worst_case_liability_micro_usd: string;
  }>(
    `
      SELECT
        market_id,
        source_market_id,
        question,
        market_url,
        outcome,
        open_tickets::text,
        open_payment_intents::text,
        worst_case_liability_micro_usd::text
      FROM open_market_exposure_with_soft
      ORDER BY worst_case_liability_micro_usd DESC
      LIMIT 50
    `
  );

  return result.rows.map((row) => ({
    marketId: row.market_id,
    sourceMarketId: row.source_market_id,
    question: row.question,
    marketUrl: row.market_url,
    outcome: row.outcome,
    openTickets: Number(row.open_tickets),
    openPaymentIntents: Number(row.open_payment_intents || 0),
    worstCaseLiabilityUsd: microUsdToUsd(row.worst_case_liability_micro_usd)
  }));
}

export async function exposureChecksForQuote(
  quote: QuoteResponse,
  limits: ExposureCheckLimits
): Promise<RiskCheck[]> {
  if (quote.status !== "quoted") return [];

  const sourceMarketIds = [...new Set(quote.legs.map((leg) => leg.marketId))];
  const outcomes = [...new Set(quote.legs.map((leg) => leg.outcome))];
  const marketUrls = [...new Set(quote.legs.map((leg) => leg.marketUrl).filter(Boolean))] as string[];
  const incrementalLiabilityUsd = Math.max(0, quote.potentialPayoutUsd - quote.stakeUsd);
  const incrementalLiabilityMicroUsd = usdToMicroUnits(incrementalLiabilityUsd, "quote_liability");
  const checks: RiskCheck[] = [];
  const includeSoftReservations = limits.includeSoftReservations !== false;

  const marketExposure = await getPool().query<{
    source_market_id: string;
    outcome: string;
    worst_case_liability_micro_usd: string;
  }>(
    `
      WITH hard AS (
        SELECT source_market_id, outcome, worst_case_liability_micro_usd::BIGINT AS exposure
        FROM open_market_exposure
        WHERE source_market_id = ANY($1::text[])
          AND outcome = ANY($2::text[])
      ),
      soft AS (
        SELECT
          markets.source_market_id,
          quote_legs.outcome,
          sum(quote_payment_exposure_reservations.liability_micro_usd)::BIGINT AS exposure
        FROM quote_payment_exposure_reservations
        JOIN quote_legs ON quote_legs.quote_id = quote_payment_exposure_reservations.quote_id
        JOIN markets ON markets.id = quote_legs.market_id
        WHERE $3::boolean
          AND quote_payment_exposure_reservations.status = 'reserved'
          AND quote_payment_exposure_reservations.expires_at > now()
          AND ($4::uuid IS NULL OR quote_payment_exposure_reservations.payment_intent_id <> $4)
          AND markets.source_market_id = ANY($1::text[])
          AND quote_legs.outcome = ANY($2::text[])
        GROUP BY markets.source_market_id, quote_legs.outcome
      )
      SELECT
        source_market_id,
        outcome,
        sum(exposure)::text AS worst_case_liability_micro_usd
      FROM (
        SELECT * FROM hard
        UNION ALL
        SELECT * FROM soft
      ) exposures
      GROUP BY source_market_id, outcome
    `,
    [sourceMarketIds, outcomes, includeSoftReservations, limits.excludePaymentIntentId || null]
  );
  const exposureByMarketOutcome = new Map(
    marketExposure.rows.map((row) => [`${row.source_market_id}:${row.outcome}`, BigInt(row.worst_case_liability_micro_usd)])
  );
  const maxMarketLiabilityMicroUsd = usdToMicroUnits(limits.maxMarketLiabilityUsd, "market_limit");

  for (const leg of quote.legs) {
    const currentExposureMicroUsd = exposureByMarketOutcome.get(`${leg.marketId}:${leg.outcome}`) || 0n;
    const nextExposureMicroUsd = currentExposureMicroUsd + incrementalLiabilityMicroUsd;
    if (nextExposureMicroUsd > maxMarketLiabilityMicroUsd) {
      checks.push({
        level: "block",
        label: "Market exposure",
        detail: `Open liability on this market would exceed the ${limits.maxMarketLiabilityUsd} USD launch cap.`
      });
      break;
    }

    if (nextExposureMicroUsd * 5n > maxMarketLiabilityMicroUsd * 4n) {
      checks.push({
        level: "warn",
        label: "Market exposure",
        detail: "Open liability on at least one selected market is approaching the launch cap."
      });
      break;
    }
  }

  if (marketUrls.length > 0) {
    const eventExposure = await getPool().query<{
      market_url: string;
      worst_case_liability_micro_usd: string;
    }>(
      `
      SELECT market_url, worst_case_liability_micro_usd::text
      FROM (
        WITH hard AS (
          SELECT market_url, worst_case_liability_micro_usd::BIGINT AS exposure
          FROM open_event_exposure
          WHERE market_url = ANY($1::text[])
        ),
        soft AS (
          SELECT
            markets.market_url,
            sum(quote_payment_exposure_reservations.liability_micro_usd)::BIGINT AS exposure
          FROM quote_payment_exposure_reservations
          JOIN quote_legs ON quote_legs.quote_id = quote_payment_exposure_reservations.quote_id
          JOIN markets ON markets.id = quote_legs.market_id
          WHERE $2::boolean
            AND quote_payment_exposure_reservations.status = 'reserved'
            AND quote_payment_exposure_reservations.expires_at > now()
            AND ($3::uuid IS NULL OR quote_payment_exposure_reservations.payment_intent_id <> $3)
            AND markets.market_url = ANY($1::text[])
          GROUP BY markets.market_url
        )
        SELECT
          market_url,
          sum(exposure)::text AS worst_case_liability_micro_usd
        FROM (
          SELECT * FROM hard
          UNION ALL
          SELECT * FROM soft
        ) exposures
        GROUP BY market_url
      ) event_exposure
      `,
      [marketUrls, includeSoftReservations, limits.excludePaymentIntentId || null]
    );
    const exposureByEvent = new Map(eventExposure.rows.map((row) => [row.market_url, BigInt(row.worst_case_liability_micro_usd)]));
    const maxEventLiabilityMicroUsd = usdToMicroUnits(limits.maxEventLiabilityUsd, "event_limit");

    for (const marketUrl of marketUrls) {
      const currentExposureMicroUsd = exposureByEvent.get(marketUrl) || 0n;
      const nextExposureMicroUsd = currentExposureMicroUsd + incrementalLiabilityMicroUsd;
      if (nextExposureMicroUsd > maxEventLiabilityMicroUsd) {
        checks.push({
          level: "block",
          label: "Event exposure",
          detail: `Open liability on this event would exceed the ${limits.maxEventLiabilityUsd} USD launch cap.`
        });
        break;
      }

      if (nextExposureMicroUsd * 5n > maxEventLiabilityMicroUsd * 4n) {
        checks.push({
          level: "warn",
          label: "Event exposure",
          detail: "Open liability on at least one selected event is approaching the launch cap."
        });
        break;
      }
    }
  }

  if (limits.userId && limits.maxUserLiabilityUsd) {
    const userExposure = await getPool().query<{ worst_case_liability_micro_usd: string }>(
      `
        WITH hard AS (
          SELECT COALESCE(worst_case_liability_micro_usd, 0)::BIGINT AS exposure
          FROM open_user_exposure
          WHERE user_id = $1
        ),
        soft AS (
          SELECT COALESCE(sum(liability_micro_usd), 0)::BIGINT AS exposure
          FROM quote_payment_exposure_reservations
          WHERE $2::boolean
            AND user_id = $1
            AND status = 'reserved'
            AND expires_at > now()
            AND ($3::uuid IS NULL OR payment_intent_id <> $3)
        )
        SELECT (COALESCE((SELECT exposure FROM hard), 0) + COALESCE((SELECT exposure FROM soft), 0))::text
          AS worst_case_liability_micro_usd
      `,
      [limits.userId, includeSoftReservations, limits.excludePaymentIntentId || null]
    );
    const currentExposureMicroUsd = BigInt(userExposure.rows[0]?.worst_case_liability_micro_usd || 0);
    const nextExposureMicroUsd = currentExposureMicroUsd + incrementalLiabilityMicroUsd;
    const maxUserLiabilityMicroUsd = usdToMicroUnits(limits.maxUserLiabilityUsd, "user_limit");
    if (nextExposureMicroUsd > maxUserLiabilityMicroUsd) {
      checks.push({
        level: "block",
        label: "User exposure",
        detail: `Open liability for this user would exceed the ${limits.maxUserLiabilityUsd} USD launch cap.`
      });
    } else if (nextExposureMicroUsd * 5n > maxUserLiabilityMicroUsd * 4n) {
      checks.push({
        level: "warn",
        label: "User exposure",
        detail: "Open liability for this user is approaching the launch cap."
      });
    }
  }

  return checks;
}
