import { closePool } from "./db/client";
import {
  backfillSettlementIdentities,
  getSettlementIdentityQuarantineSummary
} from "./db/settlementRepository";

function positiveIntegerArgument(name: string, fallback: number) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}_must_be_positive_integer`);
  }
  return value;
}

function optionalPositiveIntegerArgument(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}_must_be_positive_integer`);
  }
  return value;
}

export async function runSettlementIdentityBackfillCommand(input: {
  limit?: number;
  batches?: number;
  backfill?: typeof backfillSettlementIdentities;
  quarantineSummary?: typeof getSettlementIdentityQuarantineSummary;
  log?: (line: string) => void;
} = {}) {
  const limit = input.limit ?? positiveIntegerArgument("--limit", 100);
  const batches = input.batches ?? optionalPositiveIntegerArgument("--batches");
  const backfill = input.backfill || backfillSettlementIdentities;
  const quarantineSummary = input.quarantineSummary || getSettlementIdentityQuarantineSummary;
  const log = input.log || console.log;
  let checked = 0;
  let frozen = 0;
  let quarantined = 0;
  let retryable = 0;
  let skipped = 0;
  let drained = false;

  for (let batch = 1; batches === undefined || batch <= batches; batch += 1) {
    const result = await backfill(limit);
    checked += result.checked;
    frozen += result.results.filter((item) => item.status === "frozen").length;
    quarantined += result.results.filter((item) => item.status === "quarantined").length;
    retryable += result.results.filter((item) => item.status === "retryable").length;
    skipped += result.results.filter((item) => item.status === "skipped").length;
    log(JSON.stringify({ event: "settlement.identity_backfill.batch", batch, ...result }));
    if (result.checked < limit) {
      drained = true;
      break;
    }
  }

  const remaining = await quarantineSummary();
  const exitCode = remaining.unresolved > 0 || !drained ? 1 : 0;
  log(JSON.stringify({
    event: "settlement.identity_backfill.complete",
    checked,
    frozen,
    quarantined,
    retryable,
    skipped,
    drained,
    remaining,
    ok: exitCode === 0
  }));
  return { checked, frozen, quarantined, retryable, skipped, drained, remaining, exitCode };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runSettlementIdentityBackfillCommand();
    process.exitCode = result.exitCode;
  } finally {
    await closePool();
  }
}
