import { closePool } from "./db/client";
import { recordVerifiedHouseFunding } from "./db/houseFundingRepository";
import { configuredHouseFundingSettings, verifyHouseFundingTransfer } from "./houseFundingVerification";

type Arguments = {
  txHash: string;
  logIndex: number;
  operatorId: string;
  approverId: string;
  reason: string;
};

function usage() {
  return "Usage: npm run house:fund -- --tx-hash <hash> --log-index <index> --operator-id <id> --approver-id <different-id> --reason <reason>";
}

function requiredArgument(values: Map<string, string>, name: string) {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`missing_${name}`);
  return value;
}

export function parseHouseFundingArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) throw new Error("invalid_house_funding_arguments");
    values.set(name, value);
  }
  const allowed = new Set(["--tx-hash", "--log-index", "--operator-id", "--approver-id", "--reason"]);
  if ([...values.keys()].some((name) => !allowed.has(name))) throw new Error("invalid_house_funding_arguments");
  const rawLogIndex = requiredArgument(values, "--log-index");
  if (!/^(0|[1-9][0-9]*)$/.test(rawLogIndex)) throw new Error("invalid_log_index");
  const logIndex = Number(rawLogIndex);
  if (!Number.isSafeInteger(logIndex)) throw new Error("invalid_log_index");
  return {
    txHash: requiredArgument(values, "--tx-hash"),
    logIndex,
    operatorId: requiredArgument(values, "--operator-id"),
    approverId: requiredArgument(values, "--approver-id"),
    reason: requiredArgument(values, "--reason")
  };
}

export async function runHouseFundingCli(argv: string[]) {
  const args = parseHouseFundingArguments(argv);
  const verified = await verifyHouseFundingTransfer({
    txHash: args.txHash,
    logIndex: args.logIndex,
    settings: configuredHouseFundingSettings()
  });
  return recordVerifiedHouseFunding({ ...verified, operatorId: args.operatorId, approverId: args.approverId, reason: args.reason });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await runHouseFundingCli(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "house_funding_failed");
    console.error(usage());
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
