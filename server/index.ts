import { pathToFileURL } from "node:url";
import { buildApp } from "./app";
import { config } from "./config";
import { closePool } from "./db/client";

type ClosableApp = {
  close(): Promise<unknown>;
  listen(options: { host: string; port: number }): Promise<unknown>;
  log: {
    error(error: unknown, message?: string): void;
    info(message: string): void;
  };
};

type SignalProcess = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
};

export type ShutdownDependencies = {
  app: Pick<ClosableApp, "close" | "log">;
  closeDatabasePool?: () => Promise<void>;
  forceExit?: (code: number) => never | void;
  setExitCode?: (code: number) => void;
  timeoutMs?: number;
};

export function createGracefulShutdown({
  app,
  closeDatabasePool = closePool,
  forceExit = (code) => process.exit(code),
  setExitCode = (code) => {
    process.exitCode = code;
  },
  timeoutMs = 10_000
}: ShutdownDependencies): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return function shutdown() {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      const forceExitTimer = setTimeout(() => {
        app.log.error(new Error("graceful shutdown timed out"), "forcing process exit");
        forceExit(1);
      }, timeoutMs);
      forceExitTimer.unref();

      let cleanupError: unknown;
      try {
        await app.close();
      } catch (error) {
        cleanupError = error;
      }

      try {
        await closeDatabasePool();
      } catch (error) {
        cleanupError ??= error;
      } finally {
        clearTimeout(forceExitTimer);
      }

      if (cleanupError) {
        app.log.error(cleanupError, "graceful shutdown failed");
        setExitCode(1);
      }
    })();

    return shutdownPromise;
  };
}

export function installShutdownHandlers(shutdown: () => Promise<void>, target: SignalProcess = process) {
  const handleSignal = () => {
    void shutdown();
  };

  target.on("SIGTERM", handleSignal);
  target.on("SIGINT", handleSignal);
}

export function assertApiStartupConfig(runtimeConfig: Pick<typeof config, "NODE_ENV" | "OPS_API_KEY"> = config) {
  if (runtimeConfig.NODE_ENV === "production" && !runtimeConfig.OPS_API_KEY) {
    throw new Error("OPS_API_KEY is required for production API startup");
  }
}

export async function startServer(app: ClosableApp = buildApp()) {
  assertApiStartupConfig();
  await app.listen({
    host: config.API_HOST,
    port: config.API_PORT
  });

  installShutdownHandlers(createGracefulShutdown({ app }));
  return app;
}

async function main() {
  let app: ClosableApp | undefined;
  try {
    app = buildApp();
    await startServer(app);
  } catch (error) {
    app?.log.error(error, "API startup failed");
    await app?.close().catch((closeError) => app?.log.error(closeError, "API cleanup after startup failure failed"));
    await closePool().catch((closeError) => app?.log.error(closeError, "database cleanup after startup failure failed"));
    process.exitCode = 1;
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  void main();
}
