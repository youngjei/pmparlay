import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const directories: string[] = [];

async function fixture(lifecycleEnvironment?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "legwork-staging-lifecycle-"));
  directories.push(root);
  const scripts = path.join(root, "scripts");
  const context = path.join(root, ".context");
  const bin = path.join(root, "bin");
  await Promise.all([mkdir(scripts), mkdir(context), mkdir(bin)]);
  for (const filename of ["staging-bot-lifecycle.sh", "staging-env-files.sh"]) {
    await writeFile(path.join(scripts, filename), await readFile(path.join(process.cwd(), "scripts", filename), "utf8"));
  }
  const stagingEnvironment = path.join(context, "sepolia-staging.env");
  await writeFile(stagingEnvironment, "NODE_ENV=production\n");
  await chmod(stagingEnvironment, 0o600);
  const lifecycleFile = path.join(context, "sepolia-lifecycle.env");
  if (lifecycleEnvironment !== undefined) {
    await writeFile(lifecycleFile, lifecycleEnvironment);
    await chmod(lifecycleFile, 0o600);
  }
  const fakeNode = path.join(bin, "node");
  await writeFile(
    fakeNode,
    "#!/bin/sh\nprintf 'ambient=%s\\n' \"${SHOULD_NOT_LEAK-unset}\"\nprintf 'args=%s\\n' \"$*\"\n"
  );
  await chmod(fakeNode, 0o755);
  return {
    root,
    lifecycleFile,
    script: path.join(scripts, "staging-bot-lifecycle.sh"),
    environment: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, SHOULD_NOT_LEAK: "secret-ambient-value" }
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("protected Sepolia bot lifecycle command", () => {
  const validEnvironment = [
    "QA_SEPOLIA_BOT_ACCESS_TOKEN=access-token",
    "QA_SEPOLIA_BOT_IDENTITY_TOKEN=identity-token",
    "QA_SEPOLIA_LIFECYCLE_CONFIRM=sepolia-positive-lifecycle",
    "QA_SEPOLIA_LIFECYCLE_RUN_ID=controlled-run-1",
    ""
  ].join("\n");

  it("loads only protected environment files and drops ambient values", async () => {
    const input = await fixture(validEnvironment);

    const result = await execFile("/bin/bash", [input.script, "--stake-usd", "1"], { env: input.environment });

    expect(result.stdout).toContain("ambient=unset");
    expect(result.stdout).toContain("sepolia-staging.env");
    expect(result.stdout).toContain("sepolia-lifecycle.env");
    expect(result.stdout).toContain("server/qaSepoliaBotLifecycle.ts --stake-usd 1");
    expect(result.stdout).not.toContain("secret-ambient-value");
  });

  it("rejects lifecycle credentials with permissive file permissions", async () => {
    const input = await fixture(validEnvironment);
    await chmod(input.lifecycleFile, 0o644);

    await expect(execFile("/bin/bash", [input.script], { env: input.environment })).rejects.toMatchObject({ code: 1 });
  });

  it("rejects symlinked lifecycle credentials", async () => {
    const input = await fixture();
    const target = path.join(input.root, "redirected.env");
    await writeFile(target, validEnvironment);
    await symlink(target, input.lifecycleFile);

    await expect(execFile("/bin/bash", [input.script], { env: input.environment })).rejects.toMatchObject({ code: 1 });
  });

  it("rejects unsupported keys and a missing fund-movement confirmation", async () => {
    const unsupported = await fixture(`${validEnvironment}SAFE_API_KEY=must-not-load\n`);
    await expect(execFile("/bin/bash", [unsupported.script], { env: unsupported.environment })).rejects.toMatchObject({ code: 1 });

    const unconfirmed = await fixture("QA_SEPOLIA_BOT_ACCESS_TOKEN=access-token\n");
    await expect(execFile("/bin/bash", [unconfirmed.script], { env: unconfirmed.environment })).rejects.toMatchObject({ code: 1 });
  });
});
