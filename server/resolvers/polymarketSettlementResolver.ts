import type { PendingSettlementLeg, ResolutionState, SettlementProofInput, SettlementResult } from "../db/settlementRepository";

type ClobMarketToken = {
  token_id?: string;
  outcome?: string;
  winner?: boolean;
  price?: number;
};

type ClobMarket = {
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  accepting_orders?: boolean;
  condition_id?: string;
  question?: string;
  end_date_iso?: string;
  is_50_50_outcome?: boolean;
  tokens?: ClobMarketToken[];
};

type ResolverOptions = {
  requireOnchain: boolean;
  fetchMarket?: (conditionId: string, signal?: AbortSignal) => Promise<ClobMarket>;
  signal?: AbortSignal;
};

export type PolymarketSettlementDecision =
  | {
      kind: "final";
      result: SettlementResult;
      proof: Omit<SettlementProofInput, "ticketLegId">;
    }
  | {
      kind: "observe";
      resolutionState: ResolutionState;
      result?: SettlementProofInput["result"];
      proofKind: string;
      error?: string;
      nextCheckSeconds: number;
      raw: unknown;
    };

async function fetchClobMarket(conditionId: string, signal?: AbortSignal): Promise<ClobMarket> {
  const response = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
    headers: {
      accept: "application/json"
    },
    signal
  });

  if (!response.ok) {
    throw new Error(`clob_market_${response.status}`);
  }

  return (await response.json()) as ClobMarket;
}

function selectedToken(market: ClobMarket, tokenId: string) {
  return (market.tokens || []).find((token) => token.token_id === tokenId);
}

function winningToken(market: ClobMarket) {
  return (market.tokens || []).find((token) => token.winner === true);
}

function isPast(value?: string) {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

export async function resolvePolymarketLeg(
  leg: Pick<PendingSettlementLeg, "conditionId" | "tokenId" | "outcome" | "endDate">,
  options: ResolverOptions
): Promise<PolymarketSettlementDecision> {
  if (!leg.conditionId || !leg.tokenId) {
    return {
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "missing_market_identifiers",
      error: "condition_id_or_token_id_missing",
      nextCheckSeconds: 3600,
      raw: { conditionId: leg.conditionId, tokenId: leg.tokenId }
    };
  }

  const market = await (options.fetchMarket || fetchClobMarket)(leg.conditionId, options.signal);
  const token = selectedToken(market, leg.tokenId);

  if (!token) {
    return {
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "clob_market_token_missing",
      error: "selected_token_missing_from_clob_market",
      nextCheckSeconds: 3600,
      raw: market
    };
  }

  if (market.is_50_50_outcome) {
    return {
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "clob_market_partial_resolution",
      error: "partial_or_50_50_resolution_requires_policy",
      nextCheckSeconds: 3600,
      raw: market
    };
  }

  if (!market.closed) {
    return {
      kind: "observe",
      resolutionState: isPast(leg.endDate || market.end_date_iso) ? "awaiting_oracle" : "pending",
      result: "pending",
      proofKind: "clob_market_open",
      nextCheckSeconds: isPast(leg.endDate || market.end_date_iso) ? 300 : 3600,
      raw: market
    };
  }

  const winner = winningToken(market);
  if (!winner?.token_id) {
    return {
      kind: "observe",
      resolutionState: "disputed",
      result: "disputed",
      proofKind: "clob_market_closed_without_winner",
      error: "closed_market_has_no_winning_token",
      nextCheckSeconds: 900,
      raw: market
    };
  }

  const result: SettlementResult = winner.token_id === leg.tokenId ? "won" : "lost";
  const baseProof: Omit<SettlementProofInput, "ticketLegId"> = {
    source: "polymarket_clob",
    proofKind: "clob_market_winner",
    result,
    confidence: "api_signal",
    conditionId: leg.conditionId,
    tokenId: leg.tokenId,
    winningTokenId: winner.token_id,
    resolvedAt: new Date().toISOString(),
    raw: market
  };

  if (options.requireOnchain) {
    return {
      kind: "observe",
      resolutionState: "settlement_blocked",
      result: "blocked",
      proofKind: "onchain_confirmation_required",
      error: "clob_winner_detected_but_onchain_confirmation_required",
      nextCheckSeconds: 300,
      raw: {
        market,
        apiProof: baseProof
      }
    };
  }

  return {
    kind: "final",
    result,
    proof: baseProof
  };
}
