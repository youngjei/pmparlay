import { getPool } from "./client";
import type { QuoteResponse } from "../quoteService";
import type { RiskCheck } from "../../packages/domain/src/riskEngine";

function microUsdToUsd(value: string | number | null) {
  return Number(value || 0) / 1_000_000;
}

export async function listOpenMarketExposure() {
  const result = await getPool().query<{
    market_id: string;
    source_market_id: string;
    question: string;
    market_url: string;
    outcome: string;
    open_tickets: string;
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
        worst_case_liability_micro_usd::text
      FROM open_market_exposure
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
    worstCaseLiabilityUsd: microUsdToUsd(row.worst_case_liability_micro_usd)
  }));
}

export async function exposureChecksForQuote(
  quote: QuoteResponse,
  limits: {
    maxMarketLiabilityUsd: number;
    maxEventLiabilityUsd: number;
  }
): Promise<RiskCheck[]> {
  if (quote.status !== "quoted") return [];

  const sourceMarketIds = [...new Set(quote.legs.map((leg) => leg.marketId))];
  const outcomes = [...new Set(quote.legs.map((leg) => leg.outcome))];
  const marketUrls = [...new Set(quote.legs.map((leg) => leg.marketUrl).filter(Boolean))] as string[];
  const incrementalLiabilityUsd = Math.max(0, quote.potentialPayoutUsd - quote.stakeUsd);
  const checks: RiskCheck[] = [];

  const marketExposure = await getPool().query<{
    source_market_id: string;
    outcome: string;
    worst_case_liability_micro_usd: string;
  }>(
    `
      SELECT source_market_id, outcome, worst_case_liability_micro_usd::text
      FROM open_market_exposure
      WHERE source_market_id = ANY($1::text[])
        AND outcome = ANY($2::text[])
    `,
    [sourceMarketIds, outcomes]
  );
  const exposureByMarketOutcome = new Map(
    marketExposure.rows.map((row) => [`${row.source_market_id}:${row.outcome}`, microUsdToUsd(row.worst_case_liability_micro_usd)])
  );

  for (const leg of quote.legs) {
    const currentExposureUsd = exposureByMarketOutcome.get(`${leg.marketId}:${leg.outcome}`) || 0;
    const nextExposureUsd = currentExposureUsd + incrementalLiabilityUsd;
    if (nextExposureUsd > limits.maxMarketLiabilityUsd) {
      checks.push({
        level: "block",
        label: "Market exposure",
        detail: `Open liability on this market would exceed the ${limits.maxMarketLiabilityUsd} USD launch cap.`
      });
      break;
    }

    if (nextExposureUsd > limits.maxMarketLiabilityUsd * 0.8) {
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
        FROM open_event_exposure
        WHERE market_url = ANY($1::text[])
      `,
      [marketUrls]
    );
    const exposureByEvent = new Map(eventExposure.rows.map((row) => [row.market_url, microUsdToUsd(row.worst_case_liability_micro_usd)]));

    for (const marketUrl of marketUrls) {
      const currentExposureUsd = exposureByEvent.get(marketUrl) || 0;
      const nextExposureUsd = currentExposureUsd + incrementalLiabilityUsd;
      if (nextExposureUsd > limits.maxEventLiabilityUsd) {
        checks.push({
          level: "block",
          label: "Event exposure",
          detail: `Open liability on this event would exceed the ${limits.maxEventLiabilityUsd} USD launch cap.`
        });
        break;
      }

      if (nextExposureUsd > limits.maxEventLiabilityUsd * 0.8) {
        checks.push({
          level: "warn",
          label: "Event exposure",
          detail: "Open liability on at least one selected event is approaching the launch cap."
        });
        break;
      }
    }
  }

  return checks;
}
