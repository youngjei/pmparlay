import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

type Runtime = {
  database: string;
  postgresContainer: string;
  postgresUser: string;
  redisContainer: string;
};

export default function globalTeardown() {
  const runtimeFile = path.resolve(".context/privy-e2e-runtime.json");
  try {
    const runtime = JSON.parse(readFileSync(runtimeFile, "utf8")) as Runtime;
    if (!/^legwork_privy_e2e_[0-9]+$/.test(runtime.database)) throw new Error("privy_e2e_database_name_invalid");
    if (!/^legwork-privy-e2e-redis-[0-9]+$/.test(runtime.redisContainer)) throw new Error("privy_e2e_redis_name_invalid");
    if (!/^[a-zA-Z0-9_.-]+$/.test(runtime.postgresContainer) || !/^[a-zA-Z0-9_.-]+$/.test(runtime.postgresUser)) {
      throw new Error("privy_e2e_postgres_identity_invalid");
    }
    execFileSync(
      "docker",
      ["exec", runtime.postgresContainer, "dropdb", "-U", runtime.postgresUser, "--if-exists", "--force", runtime.database],
      { stdio: "ignore" }
    );
    execFileSync("docker", ["rm", "-f", runtime.redisContainer], { stdio: "ignore" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    rmSync(runtimeFile, { force: true });
    rmSync(path.resolve(".context/privy-e2e.lock"), { recursive: true, force: true });
  }
}
