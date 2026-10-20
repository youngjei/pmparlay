import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ORIGIN = "https://legwork-web-production.up.railway.app";
const ENDPOINTS = ["/healthz", "/readyz", "/api/markets?limit=1"];
const REQUEST_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_READINESS_AGE_MS = 2 * 60_000;
// Mirror REQUIRED_RUNTIME_WORKERS without importing application dependencies.
const EXPECTED_WORKERS = [
  "market-worker",
  "outbox-worker",
  "usdc-deposit-scanner",
  "financial-reconciliation",
  "settlement-worker",
  "lp-vault-accounting"
];
// Match the API's default MARKET_CATALOG_HARD_MAX_AGE_MS.
const MAX_CATALOG_AGE_MS = 30 * 60_000;
const CLOCK_SKEW_MS = 60_000;

class ResponseTooLargeError extends Error {}

async function readBoundedJson(response) {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    throw new ResponseTooLargeError();
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new ResponseTooLargeError();
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateBody(path, body, now) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "invalid JSON object";
  if (body.error !== undefined || body.ok === false) return "endpoint reports unavailable";
  if (path !== "/api/markets?limit=1") {
    if (body.ok !== true) return "expected ok: true";
    if (path === "/readyz") {
      if (body.database !== "connected" || body.redis !== "connected") return "readiness dependencies not connected";
      if (!Array.isArray(body.workers)) return "invalid readiness worker roles";
      const names = new Set(body.workers.map((worker) => worker?.name));
      if (body.workers.length !== EXPECTED_WORKERS.length || names.size !== EXPECTED_WORKERS.length ||
        !EXPECTED_WORKERS.every((name) => names.has(name))) return "invalid readiness worker roles";
      if (body.workers.some((worker) => worker.status !== "healthy")) return "unhealthy readiness workers";
      const time = typeof body.time === "string" ? Date.parse(body.time) : NaN;
      if (!Number.isFinite(time)) return "missing or invalid readiness timestamp";
      if (time > now + CLOCK_SKEW_MS) return "readiness timestamp is in the future";
      if (now - time > MAX_READINESS_AGE_MS) return "stale readiness timestamp";
    }
    return undefined;
  }

  if (body.source !== "polymarket" || !Array.isArray(body.outcomes) || body.outcomes.length === 0) {
    return "missing live market outcomes";
  }
  if (!body.outcomes.every((outcome) =>
    outcome && outcome.source === "polymarket" &&
    [outcome.id, outcome.marketId, outcome.question, outcome.outcome].every(nonemptyString) &&
    Number.isFinite(outcome.price) && outcome.price > 0 && outcome.price < 1
  )) {
    return "invalid live market outcomes";
  }

  const asOf = typeof body.asOf === "string" ? Date.parse(body.asOf) : NaN;
  if (!Number.isFinite(asOf)) return "missing or invalid catalog timestamp";
  if (asOf > now + CLOCK_SKEW_MS) return "catalog timestamp is in the future";
  if (now - asOf > MAX_CATALOG_AGE_MS) return "stale market catalog";
  // `complete` describes the index sweep, not whether this page is available.
  return undefined;
}

export async function checkPublicDeployment({ fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, now = Date.now } = {}) {
  return Promise.all(ENDPOINTS.map(async (path) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let status;
    let receivedHeaders = false;
    try {
      const response = await fetchImpl(`${ORIGIN}${path}`, {
        method: "GET",
        headers: { accept: "application/json", "cache-control": "no-cache" },
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal
      });
      receivedHeaders = true;
      status = response.status;
      if (!response.ok) return { path, status, error: "non-2xx response" };
      const body = await readBoundedJson(response);
      return { path, status, error: validateBody(path, body, now()) };
    } catch (error) {
      return {
        path,
        status,
        error: error instanceof ResponseTooLargeError ? "response body exceeds size limit" :
          controller.signal.aborted ? "request timed out" : receivedHeaders ? "invalid JSON or interrupted body" : "request failed"
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }));
}

export async function main(options) {
  const results = await checkPublicDeployment(options);
  const lines = results.map(({ path, status, error }) =>
    `${error ? "FAIL" : "PASS"} ${path} HTTP ${status ?? "unavailable"}${error ? `: ${error}` : ""}`
  );
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Public Deployment Uptime\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`);
  }
  return results.some(({ error }) => error) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
