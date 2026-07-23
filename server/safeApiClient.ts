import { getAddress } from "viem";
import { config } from "./config";

type FetchLike = typeof fetch;

type SafeApiClientOptions = {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
};

type SafeApiRequestOptions = {
  signal?: AbortSignal;
};

const outboundReadTimeoutMs = 10_000;

export type SafeInfo = {
  address: string;
  nonce?: number;
  threshold?: number;
  owners?: string[];
  implementation?: string;
  fallbackHandler?: string;
  guard?: string;
  version?: string;
};

export function safeChainPrefix(chainId: number) {
  if (chainId === 1) return "eth";
  if (chainId === 11155111) return "sep";
  throw new Error(`unsupported_safe_chain_${chainId}`);
}

export function redactSecret(value?: string) {
  if (!value) return undefined;
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}...[redacted]...${value.slice(-4)}`;
}

export class SafeApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SafeApiError";
    this.status = status;
  }
}

function safeApiHeaders(apiKey?: string) {
  const headers: Record<string, string> = {
    accept: "application/json"
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

export class SafeApiClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: SafeApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || config.SAFE_API_BASE_URL);
    this.apiKey = options.apiKey ?? config.SAFE_API_KEY;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async getSafeInfo(chainId: number, safeAddress: string, options: SafeApiRequestOptions = {}): Promise<SafeInfo> {
    const prefix = safeChainPrefix(chainId);
    const address = getAddress(safeAddress);
    return this.request<SafeInfo>(`/tx-service/${prefix}/api/v1/safes/${address}/`, options.signal);
  }

  private async request<T>(path: string, callerSignal?: AbortSignal): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(outboundReadTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: safeApiHeaders(this.apiKey),
        signal
      });
    } catch {
      throw new SafeApiError(timeoutSignal.aborted ? 408 : 0, timeoutSignal.aborted ? "safe_api_timeout" : "safe_api_request_failed");
    }

    if (!response.ok) {
      throw new SafeApiError(response.status, `safe_api_http_${response.status}`);
    }

    return (await response.json()) as T;
  }
}
