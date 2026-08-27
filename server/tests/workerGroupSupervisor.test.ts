import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createWorkerGroupSupervisor } from "../workers/workerGroupSupervisor";

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
}

function createHarness() {
  const handlers = new Map<string, () => void>();
  const children: FakeChild[] = [];
  const exit = vi.fn();
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const processTarget = {
    env: { TEST_WORKER: "true" },
    execPath: "/usr/local/bin/node",
    on: vi.fn((signal: string, listener: () => void) => {
      handlers.set(signal, listener);
    }),
    exit
  };
  const log = {
    error: vi.fn(),
    info: vi.fn()
  };

  return { children, exit, handlers, log, processTarget, spawn };
}

describe("worker group supervisor", () => {
  it("starts each worker in the selected group as a separate child process", () => {
    const harness = createHarness();
    const supervisor = createWorkerGroupSupervisor("market", {
      processTarget: harness.processTarget,
      spawn: harness.spawn,
      log: harness.log
    });

    supervisor.start();

    expect(harness.spawn).toHaveBeenNthCalledWith(1, "/usr/local/bin/node", ["--import", "tsx", expect.stringMatching(/marketIndexerWorker\.ts$/)], {
      env: harness.processTarget.env,
      stdio: "inherit"
    });
    expect(harness.spawn).toHaveBeenNthCalledWith(2, "/usr/local/bin/node", ["--import", "tsx", expect.stringMatching(/outboxWorker\.ts$/)], {
      env: harness.processTarget.env,
      stdio: "inherit"
    });
    expect(harness.handlers.keys()).toEqual(new Map([["SIGTERM", expect.any(Function)], ["SIGINT", expect.any(Function)]]).keys());
  });

  it("terminates siblings and exits nonzero when a child exits unexpectedly", () => {
    const harness = createHarness();
    const supervisor = createWorkerGroupSupervisor("financial", {
      processTarget: harness.processTarget,
      spawn: harness.spawn,
      log: harness.log
    });
    supervisor.start();

    harness.children[0]!.emit("exit", 1, null);

    expect(harness.children[0]!.kill).not.toHaveBeenCalled();
    expect(harness.children[1]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(harness.children[2]!.kill).toHaveBeenCalledWith("SIGTERM");

    harness.children[1]!.emit("exit", null, "SIGTERM");
    harness.children[2]!.emit("exit", null, "SIGTERM");
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it("forwards termination once and exits cleanly after every child stops", () => {
    const harness = createHarness();
    const supervisor = createWorkerGroupSupervisor("market", {
      processTarget: harness.processTarget,
      spawn: harness.spawn,
      log: harness.log
    });
    supervisor.start();

    harness.handlers.get("SIGTERM")?.();
    harness.handlers.get("SIGINT")?.();
    for (const child of harness.children) {
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }

    harness.children[0]!.emit("exit", null, "SIGTERM");
    harness.children[1]!.emit("exit", null, "SIGTERM");
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it("does not race a child error with a termination signal", () => {
    const harness = createHarness();
    const supervisor = createWorkerGroupSupervisor("market", {
      processTarget: harness.processTarget,
      spawn: harness.spawn,
      log: harness.log
    });
    supervisor.start();

    harness.children[0]!.emit("error", new Error("worker unavailable"));
    harness.handlers.get("SIGTERM")?.();
    harness.children[0]!.emit("exit", 1, null);
    harness.children[1]!.emit("exit", null, "SIGTERM");

    expect(harness.children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(harness.children[1]!.kill).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it("force kills unresponsive siblings before exiting after the shutdown grace period", () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const supervisor = createWorkerGroupSupervisor("market", {
      processTarget: harness.processTarget,
      spawn: harness.spawn,
      shutdownGraceMs: 50,
      log: harness.log
    });
    supervisor.start();

    harness.children[0]!.emit("exit", 1, null);
    vi.advanceTimersByTime(50);

    expect(harness.children[0]!.kill).not.toHaveBeenCalled();
    expect(harness.children[1]!.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(harness.children[1]!.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
