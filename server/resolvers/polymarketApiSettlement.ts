import { createHash } from "node:crypto";
import { config } from "../config";

export type PolymarketApiSettlementIdentity = {
  sourceMarketId: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  outcomeSlotCount: number;
  negRisk?: boolean;
};

export type PolymarketApiProviderEvidence = {
  provider: "gamma" | "clob";
  status: "ok" | "error";
  fetchedAt: string;
  httpStatus?: number;
  sourceMarketId?: string;
  conditionId?: string;
  closed?: boolean;
  active?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  umaResolutionStatus?: string;
  closedTime?: string;
  is50_50Outcome?: boolean;
  negRisk?: boolean;
  outcomes?: string[];
  tokenIds?: string[];
  outcomePrices?: string[];
  tokens?: Array<{ tokenId: string; outcome: string; price?: number; winner: boolean }>;
  error?: string;
};

export type PolymarketApiIdentityValidation = {
  authority: "polymarket_api";
  valid: boolean;
  retryable: boolean;
  computedPositionId?: string;
  identityFingerprint?: string;
  providerEvidence: PolymarketApiProviderEvidence[];
  error?: string;
};

export type PolymarketApiResolutionRead =
  | {
      status: "pending" | "unavailable" | "identity_invalid" | "disagreement";
      providerEvidence: PolymarketApiProviderEvidence[];
      identityFingerprint?: string;
      error?: string;
    }
  | {
      status: "candidate";
      result: "won" | "lost" | "voided";
      proofKind: "polymarket_api_outcome" | "polymarket_api_50_50_void";
      payoutNumerator: string;
      payoutDenominator: string;
      payoutVector: string[];
      winningTokenId?: string;
      fingerprint: string;
      identityFingerprint: string;
      resolvedAt: string;
      providerEvidence: PolymarketApiProviderEvidence[];
    };

type GammaMarket = {
  id?: string | number;
  conditionId?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  umaResolutionStatus?: string;
  closedTime?: string;
  negRisk?: boolean;
};

type ClobToken = {
  token_id?: string;
  outcome?: string;
  price?: number;
  winner?: boolean;
};

type ClobMarket = {
  condition_id?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  accepting_orders?: boolean;
  is_50_50_outcome?: boolean;
  neg_risk?: boolean;
  tokens?: ClobToken[];
};

type ApiRead = {
  gamma?: GammaMarket;
  clob?: ClobMarket;
  providerEvidence: PolymarketApiProviderEvidence[];
  unavailable: boolean;
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type PolymarketApiSettlementDependencies = {
  fetch?: (url: string, init: RequestInit) => Promise<FetchResponse>;
  now?: () => Date;
};

function normalizedOutcome(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

function sameHex(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function stringArray(value: unknown): string[] | undefined {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return undefined;
  return parsed as string[];
}

function canonicalDecimal(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (Math.abs(parsed) < 1e-9) return "0";
  if (Math.abs(parsed - 0.5) < 1e-9) return "0.5";
  if (Math.abs(parsed - 1) < 1e-9) return "1";
  return undefined;
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function apiUrl(base: string, path: string) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function providerError(
  provider: PolymarketApiProviderEvidence["provider"],
  fetchedAt: string,
  error: string,
  httpStatus?: number
): PolymarketApiProviderEvidence {
  return { provider, status: "error", fetchedAt, error, httpStatus };
}

async function fetchJson(
  provider: PolymarketApiProviderEvidence["provider"],
  url: string,
  fetchedAt: string,
  request: PolymarketApiSettlementDependencies["fetch"]
) {
  const fetcher = request || ((target: string, init: RequestInit) => fetch(target, init) as Promise<FetchResponse>);
  let response: FetchResponse;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(config.POLYMARKET_SETTLEMENT_API_TIMEOUT_MS)
    });
  } catch (error) {
    return {
      evidence: providerError(
        provider,
        fetchedAt,
        error instanceof Error && error.name === "TimeoutError" ? "request_timeout" : "request_failed"
      )
    };
  }
  if (!response.ok) {
    return { evidence: providerError(provider, fetchedAt, `http_${response.status}`, response.status) };
  }
  try {
    return { payload: await response.json(), httpStatus: response.status };
  } catch {
    return { evidence: providerError(provider, fetchedAt, "invalid_json", response.status) };
  }
}

function gammaEvidence(market: GammaMarket, fetchedAt: string, httpStatus: number): PolymarketApiProviderEvidence {
  return {
    provider: "gamma",
    status: "ok",
    fetchedAt,
    httpStatus,
    sourceMarketId: market.id === undefined ? undefined : String(market.id),
    conditionId: market.conditionId,
    active: market.active,
    closed: market.closed,
    archived: market.archived,
    umaResolutionStatus: market.umaResolutionStatus,
    closedTime: market.closedTime,
    negRisk: market.negRisk,
    outcomes: stringArray(market.outcomes),
    tokenIds: stringArray(market.clobTokenIds),
    outcomePrices: stringArray(market.outcomePrices)
  };
}

function clobEvidence(market: ClobMarket, fetchedAt: string, httpStatus: number): PolymarketApiProviderEvidence {
  return {
    provider: "clob",
    status: "ok",
    fetchedAt,
    httpStatus,
    conditionId: market.condition_id,
    active: market.active,
    closed: market.closed,
    archived: market.archived,
    acceptingOrders: market.accepting_orders,
    is50_50Outcome: market.is_50_50_outcome,
    negRisk: market.neg_risk,
    tokens: Array.isArray(market.tokens)
      ? market.tokens.flatMap((token) =>
          typeof token.token_id === "string" && typeof token.outcome === "string"
            ? [{ tokenId: token.token_id, outcome: token.outcome, price: token.price, winner: token.winner === true }]
            : []
        )
      : undefined
  };
}

async function readMarkets(
  identity: PolymarketApiSettlementIdentity,
  dependencies: PolymarketApiSettlementDependencies = {}
): Promise<ApiRead> {
  const now = dependencies.now?.() || new Date();
  const fetchedAt = now.toISOString();
  const [gammaRead, clobRead] = await Promise.all([
    fetchJson(
      "gamma",
      apiUrl(config.POLYMARKET_GAMMA_API_BASE_URL, `markets/${encodeURIComponent(identity.sourceMarketId)}`),
      fetchedAt,
      dependencies.fetch
    ),
    fetchJson(
      "clob",
      apiUrl(config.POLYMARKET_CLOB_API_BASE_URL, `markets/${encodeURIComponent(identity.conditionId)}`),
      fetchedAt,
      dependencies.fetch
    )
  ]);

  const gamma = gammaRead.payload && typeof gammaRead.payload === "object" && !Array.isArray(gammaRead.payload)
    ? (gammaRead.payload as GammaMarket)
    : undefined;
  const clob = clobRead.payload && typeof clobRead.payload === "object" && !Array.isArray(clobRead.payload)
    ? (clobRead.payload as ClobMarket)
    : undefined;
  const evidence = [
    gamma ? gammaEvidence(gamma, fetchedAt, gammaRead.httpStatus || 200) : gammaRead.evidence || providerError("gamma", fetchedAt, "invalid_payload"),
    clob ? clobEvidence(clob, fetchedAt, clobRead.httpStatus || 200) : clobRead.evidence || providerError("clob", fetchedAt, "invalid_payload")
  ];

  return {
    gamma,
    clob,
    providerEvidence: evidence,
    unavailable: evidence.some((item) => item.status === "error")
  };
}

function validateReadIdentity(identity: PolymarketApiSettlementIdentity, read: ApiRead) {
  const gamma = read.gamma;
  const clob = read.clob;
  if (!gamma || !clob) return { valid: false, error: "polymarket_api_unavailable" };

  const sourceMarketId = gamma.id === undefined ? undefined : String(gamma.id);
  const outcomes = stringArray(gamma.outcomes);
  const tokenIds = stringArray(gamma.clobTokenIds);
  const clobTokens = Array.isArray(clob.tokens) ? clob.tokens : undefined;
  if (
    sourceMarketId !== identity.sourceMarketId ||
    !gamma.conditionId ||
    !sameHex(gamma.conditionId, identity.conditionId) ||
    !clob.condition_id ||
    !sameHex(clob.condition_id, identity.conditionId) ||
    !outcomes ||
    !tokenIds ||
    !clobTokens ||
    outcomes.length !== identity.outcomeSlotCount ||
    tokenIds.length !== identity.outcomeSlotCount ||
    clobTokens.length !== identity.outcomeSlotCount ||
    identity.outcomeIndex < 0 ||
    identity.outcomeIndex >= identity.outcomeSlotCount ||
    (identity.negRisk !== undefined &&
      (gamma.negRisk !== identity.negRisk || clob.neg_risk !== identity.negRisk))
  ) {
    return { valid: false, error: "polymarket_api_identity_mismatch" };
  }

  const selectedTokenId = tokenIds[identity.outcomeIndex];
  const selectedOutcome = outcomes[identity.outcomeIndex];
  const clobTokenIds = clobTokens.map((token) => token.token_id);
  const uniqueGammaTokens = new Set(tokenIds);
  const uniqueClobTokens = new Set(clobTokenIds);
  const selectedClobToken = clobTokens.find((token) => token.token_id === identity.tokenId);
  if (
    selectedTokenId !== identity.tokenId ||
    !selectedOutcome ||
    normalizedOutcome(selectedOutcome) !== normalizedOutcome(identity.outcome) ||
    !selectedClobToken ||
    typeof selectedClobToken.outcome !== "string" ||
    normalizedOutcome(selectedClobToken.outcome) !== normalizedOutcome(identity.outcome) ||
    uniqueGammaTokens.size !== identity.outcomeSlotCount ||
    uniqueClobTokens.size !== identity.outcomeSlotCount ||
    tokenIds.some((tokenId) => !uniqueClobTokens.has(tokenId))
  ) {
    return { valid: false, error: "polymarket_api_token_or_outcome_mismatch" };
  }

  return {
    valid: true,
    identityFingerprint: fingerprint({
      sourceMarketId: identity.sourceMarketId,
      conditionId: identity.conditionId.toLowerCase(),
      tokenIds,
      outcomes: outcomes.map(normalizedOutcome),
      negRisk: identity.negRisk
    })
  };
}

export async function validatePolymarketApiSettlementIdentity(
  identity: PolymarketApiSettlementIdentity,
  dependencies: PolymarketApiSettlementDependencies = {}
): Promise<PolymarketApiIdentityValidation> {
  const read = await readMarkets(identity, dependencies);
  if (read.unavailable) {
    return {
      authority: "polymarket_api",
      valid: false,
      retryable: true,
      providerEvidence: read.providerEvidence,
      error: "polymarket_api_unavailable"
    };
  }
  const validation = validateReadIdentity(identity, read);
  if (!validation.valid) {
    return {
      authority: "polymarket_api",
      valid: false,
      retryable: false,
      providerEvidence: read.providerEvidence,
      error: validation.error
    };
  }
  return {
    authority: "polymarket_api",
    valid: true,
    retryable: false,
    computedPositionId: identity.tokenId,
    identityFingerprint: validation.identityFingerprint,
    providerEvidence: read.providerEvidence
  };
}

export async function readPolymarketApiResolution(
  identity: PolymarketApiSettlementIdentity,
  dependencies: PolymarketApiSettlementDependencies = {}
): Promise<PolymarketApiResolutionRead> {
  const read = await readMarkets(identity, dependencies);
  if (read.unavailable) {
    return { status: "unavailable", providerEvidence: read.providerEvidence, error: "polymarket_api_unavailable" };
  }
  const validation = validateReadIdentity(identity, read);
  if (!validation.valid || !validation.identityFingerprint) {
    return {
      status: "identity_invalid",
      providerEvidence: read.providerEvidence,
      error: validation.error || "polymarket_api_identity_mismatch"
    };
  }

  const gamma = read.gamma!;
  const clob = read.clob!;
  const gammaTerminal = gamma.closed === true && gamma.umaResolutionStatus?.trim().toLowerCase() === "resolved";
  const clobTerminal = clob.closed === true && clob.accepting_orders === false;
  if (!gammaTerminal || !clobTerminal) {
    return {
      status: "pending",
      providerEvidence: read.providerEvidence,
      identityFingerprint: validation.identityFingerprint
    };
  }

  const prices = stringArray(gamma.outcomePrices)?.map(canonicalDecimal);
  const tokens = clob.tokens || [];
  if (!prices || prices.length !== identity.outcomeSlotCount || prices.some((value) => value === undefined)) {
    return {
      status: "disagreement",
      providerEvidence: read.providerEvidence,
      identityFingerprint: validation.identityFingerprint,
      error: "polymarket_api_terminal_prices_invalid"
    };
  }

  const canonicalPrices = prices as string[];
  const winningIndexes = canonicalPrices.flatMap((value, index) => (value === "1" ? [index] : []));
  const winnerTokens = tokens.filter((token) => token.winner === true);
  const standard = winningIndexes.length === 1 && canonicalPrices.every((value) => value === "0" || value === "1");
  const voided =
    identity.outcomeSlotCount === 2 &&
    canonicalPrices.every((value) => value === "0.5") &&
    clob.is_50_50_outcome === true &&
    winnerTokens.length === 0 &&
    tokens.every((token) => typeof token.price === "number" && Math.abs(token.price - 0.5) < 1e-9);

  if (standard) {
    const winningIndex = winningIndexes[0];
    const winningTokenId = stringArray(gamma.clobTokenIds)?.[winningIndex];
    if (
      !winningTokenId ||
      winnerTokens.length !== 1 ||
      winnerTokens[0]?.token_id !== winningTokenId
    ) {
      return {
        status: "disagreement",
        providerEvidence: read.providerEvidence,
        identityFingerprint: validation.identityFingerprint,
        error: "polymarket_api_winner_disagreement"
      };
    }
    const payoutVector = canonicalPrices;
    const result = winningIndex === identity.outcomeIndex ? "won" : "lost";
    const resolvedAt = gamma.closedTime && Number.isFinite(Date.parse(gamma.closedTime))
      ? new Date(gamma.closedTime).toISOString()
      : (dependencies.now?.() || new Date()).toISOString();
    return {
      status: "candidate",
      result,
      proofKind: "polymarket_api_outcome",
      payoutNumerator: payoutVector[identity.outcomeIndex],
      payoutDenominator: "1",
      payoutVector,
      winningTokenId,
      fingerprint: fingerprint({
        authority: "polymarket_api",
        identityFingerprint: validation.identityFingerprint,
        payoutDenominator: "1",
        payoutVector,
        winningTokenId
      }),
      identityFingerprint: validation.identityFingerprint,
      resolvedAt,
      providerEvidence: read.providerEvidence
    };
  }

  if (voided) {
    const payoutVector = ["1", "1"];
    return {
      status: "candidate",
      result: "voided",
      proofKind: "polymarket_api_50_50_void",
      payoutNumerator: "1",
      payoutDenominator: "2",
      payoutVector,
      fingerprint: fingerprint({
        authority: "polymarket_api",
        identityFingerprint: validation.identityFingerprint,
        payoutDenominator: "2",
        payoutVector
      }),
      identityFingerprint: validation.identityFingerprint,
      resolvedAt: gamma.closedTime && Number.isFinite(Date.parse(gamma.closedTime))
        ? new Date(gamma.closedTime).toISOString()
        : (dependencies.now?.() || new Date()).toISOString(),
      providerEvidence: read.providerEvidence
    };
  }

  return {
    status: "disagreement",
    providerEvidence: read.providerEvidence,
    identityFingerprint: validation.identityFingerprint,
    error: "polymarket_api_terminal_outcome_unsupported"
  };
}
