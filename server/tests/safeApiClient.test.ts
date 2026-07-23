import { describe, expect, it, vi } from "vitest";
import { SafeApiClient, SafeApiError, redactSecret, safeChainPrefix } from "../safeApiClient";

describe("Safe API client", () => {
  it("maps supported settlement chains to Safe API EIP3770 prefixes", () => {
    expect(safeChainPrefix(1)).toBe("eth");
    expect(safeChainPrefix(11155111)).toBe("sep");
    expect(() => safeChainPrefix(8453)).toThrow("unsupported_safe_chain_8453");
  });

  it("fetches Safe info with bearer auth without exposing the key in errors", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ address: "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B", threshold: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = new SafeApiClient({
      baseUrl: "https://api.safe.global/",
      apiKey: "safe-test-key-that-must-not-leak",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const info = await client.getSafeInfo(11155111, "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B");

    expect(info.threshold).toBe(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.safe.global/tx-service/sep/api/v1/safes/0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B/",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer safe-test-key-that-must-not-leak"
        }),
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("bounds Safe API reads and composes a caller cancellation signal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, options?: RequestInit) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.signal).not.toBe(controller.signal);
      expect(options?.signal?.aborted).toBe(false);
      controller.abort();
      expect(options?.signal?.aborted).toBe(true);
      return new Response(JSON.stringify({ address: "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B" }), { status: 200 });
    });
    const client = new SafeApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.getSafeInfo(11155111, "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B", { signal: controller.signal });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns sanitized HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ detail: "invalid api key safe-test-key-that-must-not-leak" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    });
    const client = new SafeApiClient({
      apiKey: "safe-test-key-that-must-not-leak",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(client.getSafeInfo(11155111, "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B")).rejects.toMatchObject({
      name: "SafeApiError",
      status: 401,
      message: "safe_api_http_401"
    } satisfies Partial<SafeApiError>);
  });

  it("maps network and timeout failures to sanitized client errors", async () => {
    const networkClient = new SafeApiClient({
      fetchImpl: vi.fn(async () => {
        throw new Error("request to https://api.safe.global/secret failed");
      }) as unknown as typeof fetch
    });
    await expect(networkClient.getSafeInfo(11155111, "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B")).rejects.toMatchObject({
      name: "SafeApiError",
      status: 0,
      message: "safe_api_request_failed"
    } satisfies Partial<SafeApiError>);

    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    try {
      const timeoutClient = new SafeApiClient({
        fetchImpl: vi.fn(async () => {
          timeoutController.abort();
          throw new DOMException("request timed out", "TimeoutError");
        }) as unknown as typeof fetch
      });
      await expect(timeoutClient.getSafeInfo(11155111, "0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B")).rejects.toMatchObject({
        name: "SafeApiError",
        status: 408,
        message: "safe_api_timeout"
      } satisfies Partial<SafeApiError>);
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("redacts secrets for diagnostics", () => {
    expect(redactSecret("short")).toBe("[redacted]");
    expect(redactSecret("safe-test-key-that-must-not-leak")).toBe("safe...[redacted]...leak");
  });
});
