import { getAddress } from "viem";
import { config } from "./config";

type FetchLike = typeof fetch;

type SafeApiClientOptions = {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
};

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

  async getSafeInfo(chainId: number, safeAddress: string): Promise<SafeInfo> {
    const prefix = safeChainPrefix(chainId);
    const address = getAddress(safeAddress);
    return this.request<SafeInfo>(`/tx-service/${prefix}/api/v1/safes/${address}/`);
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: safeApiHeaders(this.apiKey)
    });

    if (!response.ok) {
      throw new SafeApiError(response.status, `safe_api_http_${response.status}`);
    }

    return (await response.json()) as T;
  }
}
