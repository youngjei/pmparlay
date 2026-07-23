import { describe, expect, it, vi } from "vitest";
import { assertApiStartupConfig, createGracefulShutdown, installShutdownHandlers } from "../index";

describe("API lifecycle", () => {
  it("requires an operator credential before production API startup", () => {
    expect(() => assertApiStartupConfig({ NODE_ENV: "production", OPS_API_KEY: undefined })).toThrow(
      "OPS_API_KEY is required for production API startup"
    );
    expect(() =>
      assertApiStartupConfig({ NODE_ENV: "production", OPS_API_KEY: "test-ops-api-key-at-least-20-characters" })
    ).not.toThrow();
  });

  it("closes the app before the database pool and is idempotent", async () => {
    const events: string[] = [];
    const app = {
      close: vi.fn(async () => {
        events.push("app");
      }),
      log: { error: vi.fn(), info: vi.fn() }
    };
    const closeDatabasePool = vi.fn(async () => {
      events.push("pool");
    });
    const shutdown = createGracefulShutdown({ app, closeDatabasePool, timeoutMs: 1_000 });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await first;

    expect(events).toEqual(["app", "pool"]);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(closeDatabasePool).toHaveBeenCalledTimes(1);
  });

  it("registers SIGTERM and SIGINT without touching the real process", async () => {
    const handlers = new Map<NodeJS.Signals, () => void>();
    const shutdown = vi.fn(async () => undefined);
    installShutdownHandlers(shutdown, {
      on: (signal, listener) => {
        handlers.set(signal, listener);
      }
    });

    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();
    await Promise.resolve();

    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it("only forces exit when shutdown exceeds its timeout", async () => {
    vi.useFakeTimers();
    let finishClose: (() => void) | undefined;
    const app = {
      close: vi.fn(() => new Promise<void>((resolve) => {
        finishClose = resolve;
      })),
      log: { error: vi.fn(), info: vi.fn() }
    };
    const forceExit = vi.fn();
    const shutdown = createGracefulShutdown({ app, forceExit, timeoutMs: 10 });

    const pending = shutdown();
    await vi.advanceTimersByTimeAsync(10);
    expect(forceExit).toHaveBeenCalledWith(1);

    finishClose?.();
    await pending;
    vi.useRealTimers();
  });
});
