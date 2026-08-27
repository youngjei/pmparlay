import { spawn as spawnChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const workerEntrypoints = {
  marketIndexer: fileURLToPath(new URL("./marketIndexerWorker.ts", import.meta.url)),
  outbox: fileURLToPath(new URL("./outboxWorker.ts", import.meta.url)),
  deposits: fileURLToPath(new URL("./usdcDepositScannerWorker.ts", import.meta.url)),
  settlements: fileURLToPath(new URL("./settlementResolverWorker.ts", import.meta.url)),
  reconciliation: fileURLToPath(new URL("./reconciliationWorker.ts", import.meta.url))
} as const;

export const workerGroups = {
  market: [
    { name: "market-indexer", entrypoint: workerEntrypoints.marketIndexer },
    { name: "outbox", entrypoint: workerEntrypoints.outbox }
  ],
  financial: [
    { name: "deposits", entrypoint: workerEntrypoints.deposits },
    { name: "settlements", entrypoint: workerEntrypoints.settlements },
    { name: "reconciliation", entrypoint: workerEntrypoints.reconciliation }
  ]
} as const;

export type WorkerGroupName = keyof typeof workerGroups;
type ShutdownSignal = "SIGTERM" | "SIGINT";
type ChildSignal = ShutdownSignal | "SIGKILL";

type WorkerChild = {
  kill: (signal?: ChildSignal) => boolean;
  once: {
    (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
};

type ProcessTarget = {
  env: NodeJS.ProcessEnv;
  execPath: string;
  on: (signal: ShutdownSignal, listener: () => void) => unknown;
  exit: (code?: number) => unknown;
};

type SpawnWorker = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" }
) => WorkerChild;

export type WorkerGroupSupervisorDependencies = {
  processTarget?: ProcessTarget;
  spawn?: SpawnWorker;
  shutdownGraceMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  log?: Pick<Console, "error" | "info">;
};

export function isWorkerGroupName(value: string | undefined): value is WorkerGroupName {
  return value === "market" || value === "financial";
}

export function createWorkerGroupSupervisor(
  group: WorkerGroupName,
  dependencies: WorkerGroupSupervisorDependencies = {}
) {
  const target = dependencies.processTarget || process;
  const defaultSpawn: SpawnWorker = (command, args, options) => spawnChildProcess(command, args, options) as WorkerChild;
  const spawn: SpawnWorker = dependencies.spawn || defaultSpawn;
  const setTimer = dependencies.setTimeout || globalThis.setTimeout;
  const clearTimer = dependencies.clearTimeout || globalThis.clearTimeout;
  const log = dependencies.log || console;
  const workers = workerGroups[group];
  const children = new Map<string, WorkerChild>();
  const exited = new Set<string>();
  const shutdownGraceMs = dependencies.shutdownGraceMs ?? 10_000;
  let started = false;
  let shutdownCode: number | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    if (shutdownTimer) clearTimer(shutdownTimer);
    target.exit(code);
  };

  const isEveryChildExited = () => exited.size === children.size;

  const terminateRemainingChildren = (signal: ChildSignal) => {
    for (const [name, child] of children) {
      if (exited.has(name)) continue;
      try {
        child.kill(signal);
      } catch (error) {
        log.error(`worker_group_child_kill_failed:${name}`, error);
      }
    }
  };

  const requestShutdown = (code: number, signal: ShutdownSignal) => {
    if (shutdownCode !== undefined) return;
    shutdownCode = code;
    terminateRemainingChildren(signal);

    if (isEveryChildExited()) {
      finish(code);
      return;
    }

    shutdownTimer = setTimer(() => {
      terminateRemainingChildren("SIGKILL");
      finish(code);
    }, shutdownGraceMs);
  };

  const handleChildExit = (script: string, code: number | null, signal: NodeJS.Signals | null) => {
    if (exited.has(script)) return;
    exited.add(script);

    if (shutdownCode === undefined) {
      log.error(`worker_group_child_exited:${group}:${script}`, { code, signal });
      requestShutdown(1, "SIGTERM");
      return;
    }

    if (isEveryChildExited()) finish(shutdownCode);
  };

  const handleChildError = (script: string, error: Error) => {
    if (shutdownCode !== undefined) return;
    log.error(`worker_group_child_error:${group}:${script}`, error);
    requestShutdown(1, "SIGTERM");
  };

  const start = () => {
    if (started) throw new Error("worker_group_supervisor_already_started");
    started = true;

    target.on("SIGTERM", () => requestShutdown(0, "SIGTERM"));
    target.on("SIGINT", () => requestShutdown(0, "SIGINT"));

    try {
      for (const worker of workers) {
        const child = spawn(target.execPath, ["--import", "tsx", worker.entrypoint], {
          env: target.env,
          stdio: "inherit"
        });
        children.set(worker.name, child);
        child.once("exit", (code, signal) => handleChildExit(worker.name, code, signal));
        child.once("error", (error) => handleChildError(worker.name, error));
      }
    } catch (error) {
      log.error(`worker_group_spawn_failed:${group}`, error);
      requestShutdown(1, "SIGTERM");
    }
  };

  return {
    start,
    requestShutdown,
    childNames: workers.map((worker) => worker.name)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const group = process.argv[2];
  if (!isWorkerGroupName(group)) {
    console.error("Usage: tsx server/workers/workerGroupSupervisor.ts <market|financial>");
    process.exit(1);
  } else {
    createWorkerGroupSupervisor(group).start();
  }
}
