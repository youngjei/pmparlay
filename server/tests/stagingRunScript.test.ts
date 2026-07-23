import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const processes: ChildProcess[] = [];
const directories: string[] = [];
const execFile = promisify(execFileCallback);

async function fixture(failMarket: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "legwork-staging-run-"));
  directories.push(directory);
  const bin = path.join(directory, "bin");
  const scripts = path.join(directory, "scripts");
  const context = path.join(directory, ".context");
  await Promise.all([mkdir(bin), mkdir(scripts), mkdir(context)]);
  const envFile = path.join(context, "sepolia-staging.env");
  await writeFile(envFile, "NODE_ENV=test\n");
  await chmod(envFile, 0o600);
  const supervisor = path.join(scripts, "staging-run.sh");
  await writeFile(supervisor, await readFile(path.join(process.cwd(), "scripts/staging-run.sh"), "utf8"));
  await writeFile(
    path.join(scripts, "staging-env-files.sh"),
    await readFile(path.join(process.cwd(), "scripts/staging-env-files.sh"), "utf8")
  );
  const node = path.join(bin, "node");
  await writeFile(
    node,
    `#!/bin/sh
echo $$ >> "$TMPDIR/children.pids"
case "$*" in
  *marketIndexerWorker.ts*) ${failMarket ? "sleep 0.2; exit 7" : ":"} ;;
esac
trap 'exit 0' TERM INT
printf '%s\n' "\${SHOULD_NOT_LEAK-unset}|\${DOTENV_CONFIG_PATH-unset}" >> "$TMPDIR/child.env"
printf '%s\n' "$*" >> "$TMPDIR/child.args"
while :; do sleep 1; done
`
  );
  await chmod(node, 0o755);
  return {
    directory,
    envFile,
    supervisor,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: directory,
      SHOULD_NOT_LEAK: "ambient-value"
    }
  };
}

function runSupervisor(supervisor: string, env: NodeJS.ProcessEnv) {
  const child = spawn("/bin/bash", [supervisor], { env, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  return child;
}

async function exitCode(child: ChildProcess, timeoutMs = 5_000) {
  return await Promise.race([
    new Promise<number | null>((resolve) => child.once("exit", resolve)),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("staging_supervisor_exit_timeout")), timeoutMs))
  ]);
}

async function childPids(directory: string) {
  const contents = await readFile(path.join(directory, "children.pids"), "utf8");
  return contents.trim().split("\n").map(Number);
}

async function waitForChildPids(directory: string, expected = 5, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pids = await childPids(directory);
      if (pids.length === expected) return pids;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("staging_children_start_timeout");
}

function expectStopped(pids: number[]) {
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
}

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGTERM");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("staging foreground supervisor", () => {
  it("rejects a symlinked canonical staging environment", async () => {
    const input = await fixture(false);
    const target = path.join(input.directory, "redirected.env");
    await writeFile(target, "NODE_ENV=test\n");
    await rm(input.envFile);
    await symlink(target, input.envFile);
    const child = runSupervisor(input.supervisor, input.env);
    await expect(exitCode(child)).resolves.toBe(1);
  });

  it("loads a protected Polygon settlement sidecar after the generated staging environment", async () => {
    const input = await fixture(false);
    const settlementEnv = path.join(input.directory, ".context", "polygon-settlement.env");
    await writeFile(
      settlementEnv,
      "SETTLEMENT_AUTHORITY=polygon_ctf\nSETTLEMENT_RPC_QUORUM=2\nPOLYGON_RPC_URL=https://primary.example/rpc\nPOLYGON_RPC_OPERATOR=primary\nPOLYGON_SECONDARY_RPC_URL=https://secondary.example/rpc\nPOLYGON_SECONDARY_RPC_OPERATOR=secondary\n"
    );
    await chmod(settlementEnv, 0o600);

    const child = runSupervisor(input.supervisor, input.env);
    await waitForChildPids(input.directory);
    child.kill("SIGTERM");
    await expect(exitCode(child, 2_000)).resolves.not.toBeNull();

    const args = (await readFile(path.join(input.directory, "child.args"), "utf8")).trim().split("\n");
    expect(args).toHaveLength(5);
    expect(args.every((line) => line.indexOf("sepolia-staging.env") < line.indexOf("polygon-settlement.env"))).toBe(true);
  });

  it("applies the later Polygon authority in a real Node process", async () => {
    const input = await fixture(false);
    const settlementEnv = path.join(input.directory, ".context", "polygon-settlement.env");
    await writeFile(input.envFile, "SETTLEMENT_AUTHORITY=polymarket_api\n");
    await chmod(input.envFile, 0o600);
    await writeFile(settlementEnv, "SETTLEMENT_AUTHORITY=polygon_ctf\n");
    await chmod(settlementEnv, 0o600);

    const result = await execFile(process.execPath, [
      `--env-file=${input.envFile}`,
      `--env-file=${settlementEnv}`,
      "-p",
      "process.env.SETTLEMENT_AUTHORITY"
    ]);
    expect(result.stdout.trim()).toBe("polygon_ctf");
  });

  it("rejects unsupported Polygon settlement keys before starting children", async () => {
    const input = await fixture(false);
    const settlementEnv = path.join(input.directory, ".context", "polygon-settlement.env");
    await writeFile(settlementEnv, "POLYGON_RPC_URL=https://primary.example/rpc\nSAFE_API_KEY=must-not-load\n");
    await chmod(settlementEnv, 0o600);

    const child = runSupervisor(input.supervisor, input.env);
    await expect(exitCode(child)).resolves.toBe(1);
    await expect(readFile(path.join(input.directory, "children.pids"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked Polygon settlement sidecar before starting children", async () => {
    const input = await fixture(false);
    const target = path.join(input.directory, "redirected-polygon.env");
    const settlementEnv = path.join(input.directory, ".context", "polygon-settlement.env");
    await writeFile(target, "SETTLEMENT_REQUIRE_ONCHAIN=true\n");
    await symlink(target, settlementEnv);

    const child = runSupervisor(input.supervisor, input.env);
    await expect(exitCode(child)).resolves.toBe(1);
    await expect(readFile(path.join(input.directory, "children.pids"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects permissive Polygon settlement sidecar permissions before starting children", async () => {
    const input = await fixture(false);
    const settlementEnv = path.join(input.directory, ".context", "polygon-settlement.env");
    await writeFile(settlementEnv, "SETTLEMENT_REQUIRE_ONCHAIN=true\n");
    await chmod(settlementEnv, 0o644);

    const child = runSupervisor(input.supervisor, input.env);
    await expect(exitCode(child)).resolves.toBe(1);
    await expect(readFile(path.join(input.directory, "children.pids"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails and cleans up every sibling when one service exits", async () => {
    const input = await fixture(true);
    const child = runSupervisor(input.supervisor, input.env);
    await expect(exitCode(child)).resolves.toBe(7);
    expectStopped(await childPids(input.directory));
  });

  it("terminates every child promptly on SIGTERM", async () => {
    const input = await fixture(false);
    const child = runSupervisor(input.supervisor, input.env);
    const pids = await waitForChildPids(input.directory);
    child.kill("SIGTERM");
    await expect(exitCode(child, 2_000)).resolves.not.toBeNull();
    expectStopped(pids);
    const captured = await readFile(path.join(input.directory, "child.env"), "utf8");
    expect(captured.trim().split("\n")).toHaveLength(5);
    expect(captured.trim().split("\n").every((line) => line === "unset|/dev/null")).toBe(true);
  });
});
