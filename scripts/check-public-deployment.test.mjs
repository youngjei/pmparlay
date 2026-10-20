import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { checkPublicDeployment, main } from "./check-public-deployment.mjs";

const NOW = Date.parse("2026-10-20T03:00:00Z");
const MARKET_PATH = "/api/markets?limit=1";
const SECRET = "sensitive-response-must-not-be-logged";
const MAX_RESPONSE_BYTES = 256 * 1024;

function readiness() {
  return {
    ok: true,
    database: "connected",
    redis: "connected",
    time: new Date(NOW).toISOString(),
    workers: [
      "market-worker", "outbox-worker", "usdc-deposit-scanner",
      "financial-reconciliation", "settlement-worker", "lp-vault-accounting"
    ].map((name) => ({ name, status: "healthy" }))
  };
}

function catalog() {
  return {
    source: "polymarket",
    asOf: new Date(NOW).toISOString(),
    complete: false,
    outcomes: [{ id: "token-1", marketId: "market-1", question: "Example?", outcome: "Yes", price: 0.5, source: "polymarket" }]
  };
}

async function fixture(t, overrides = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, method: request.method, headers: request.headers });
    const spec = overrides[request.url] ?? {
      body: request.url === MARKET_PATH ? catalog() : request.url === "/readyz" ? readiness() : { ok: true }
    };
    if (spec.hang) return;
    response.writeHead(spec.status ?? 200, { "content-type": "application/json", ...spec.headers });
    if (spec.hangBody) {
      response.write('{"ok":');
      return;
    }
    if (spec.chunks) {
      for (const chunk of spec.chunks) response.write(chunk);
      if (!spec.keepOpen) response.end();
      return;
    }
    response.end(spec.raw ?? JSON.stringify(spec.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    options: {
      now: () => NOW,
      timeoutMs: 1000,
      fetchImpl: (url, options) => {
        const target = new URL(url);
        assert.equal(target.origin, "https://legwork-web-production.up.railway.app");
        assert.equal(options.redirect, "manual");
        assert.equal(options.credentials, "omit");
        return fetch(`${origin}${target.pathname}${target.search}`, options);
      }
    }
  };
}

test("healthy responses pass with real outcomes, including an incomplete index sweep", async (t) => {
  const { options, requests } = await fixture(t);
  const results = await checkPublicDeployment(options);
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.status === 200 && !result.error));
  assert.deepEqual(requests.map((request) => request.path).sort(), ["/healthz", "/readyz", MARKET_PATH].sort());
  assert.ok(requests.every((request) => request.method === "GET" && !request.headers.authorization && !request.headers.cookie));
});

test("health 200 cannot mask readiness 503 and markets 500; summary is sanitized and exit code fails", async (t) => {
  const { options } = await fixture(t, {
    "/readyz": { status: 503, body: { ok: false, detail: SECRET } },
    [MARKET_PATH]: { status: 500, body: { error: SECRET } }
  });
  const directory = await mkdtemp(join(tmpdir(), "legwork-uptime-"));
  const summary = join(directory, "summary.md");
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  const originalLog = console.log;
  const logs = [];
  process.env.GITHUB_STEP_SUMMARY = summary;
  console.log = (line) => logs.push(line);
  try {
    assert.equal(await main(options), 1);
    assert.match(logs.join("\n"), /PASS \/healthz HTTP 200/);
    assert.match(logs.join("\n"), /FAIL \/readyz HTTP 503/);
    assert.match(logs.join("\n"), /FAIL \/api\/markets\?limit=1 HTTP 500/);
    assert.ok(!logs.join("\n").includes(SECRET));
    assert.ok(!(await readFile(summary, "utf8")).includes(SECRET));
  } finally {
    console.log = originalLog;
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [name, path, spec, expected] of [
  ["wrong health ok", "/healthz", { body: { ok: "true" } }, "expected ok: true"],
  ["missing readiness ok", "/readyz", { body: {} }, "expected ok: true"],
  ["minimal obsolete readiness", "/readyz", { body: { ok: true } }, "readiness dependencies not connected"],
  ["unavailable readiness", "/readyz", { body: { ok: false, detail: SECRET } }, "endpoint reports unavailable"],
  ["empty catalog", MARKET_PATH, { body: { ...catalog(), outcomes: [] } }, "missing live market outcomes"],
  ["wrong markets array", MARKET_PATH, { body: { source: "polymarket", markets: [{}] } }, "missing live market outcomes"],
  ["placeholder outcome", MARKET_PATH, { body: { ...catalog(), outcomes: [{}] } }, "invalid live market outcomes"],
  ["demo catalog", MARKET_PATH, { body: { ...catalog(), source: "demo" } }, "missing live market outcomes"],
  ["unavailable catalog", MARKET_PATH, { body: { ...catalog(), error: SECRET } }, "endpoint reports unavailable"],
  ["stale catalog", MARKET_PATH, { body: { ...catalog(), asOf: new Date(NOW - 30 * 60_000 - 1).toISOString() } }, "stale market catalog"],
  ["invalid timestamp", MARKET_PATH, { body: { ...catalog(), asOf: "invalid" } }, "missing or invalid catalog timestamp"],
  ["missing timestamp", MARKET_PATH, { body: { ...catalog(), asOf: undefined } }, "missing or invalid catalog timestamp"],
  ["future timestamp", MARKET_PATH, { body: { ...catalog(), asOf: new Date(NOW + 60_001).toISOString() } }, "catalog timestamp is in the future"],
  ["invalid JSON", "/healthz", { raw: SECRET }, "invalid JSON or interrupted body"],
  ["null JSON", "/healthz", { body: null }, "invalid JSON object"],
  ["no content", "/healthz", { status: 204, raw: "" }, "invalid JSON or interrupted body"],
  ["redirect", "/readyz", { status: 302, headers: { location: "/redirect-target" }, body: {} }, "non-2xx response"]
]) {
  test(`rejects ${name}`, async (t) => {
    const { options, requests } = await fixture(t, { [path]: spec });
    const results = await checkPublicDeployment(options);
    assert.equal(results.find((result) => result.path === path).error, expected);
    assert.equal(results.filter((result) => result.error).length, 1);
    assert.equal(requests.length, 3);
    assert.ok(!JSON.stringify(results).includes(SECRET));
  });
}

for (const [name, patch, expected] of [
  ["missing database", { database: undefined }, "readiness dependencies not connected"],
  ["unconfigured database", { database: "not_configured" }, "readiness dependencies not connected"],
  ["skipped database", { database: "skipped" }, "readiness dependencies not connected"],
  ["missing redis", { redis: undefined }, "readiness dependencies not connected"],
  ["unrequired redis", { redis: "not_required" }, "readiness dependencies not connected"],
  ["skipped redis", { redis: "skipped" }, "readiness dependencies not connected"],
  ["missing worker roster", { workers: undefined }, "invalid readiness worker roles"],
  ["obsolete four-worker roster", {
    workers: readiness().workers.filter(({ name }) => !["outbox-worker", "lp-vault-accounting"].includes(name))
  }, "invalid readiness worker roles"],
  ["duplicate worker replacing LP", {
    workers: [...readiness().workers.slice(0, -1), readiness().workers[0]]
  }, "invalid readiness worker roles"],
  ["extra duplicate worker", { workers: [...readiness().workers, readiness().workers[0]] }, "invalid readiness worker roles"],
  ["unknown worker replacing LP", {
    workers: [...readiness().workers.slice(0, -1), { name: "unknown-worker", status: "healthy" }]
  }, "invalid readiness worker roles"],
  ["null worker", { workers: [...readiness().workers.slice(0, -1), null] }, "invalid readiness worker roles"],
  ["missing readiness time", { time: undefined }, "missing or invalid readiness timestamp"],
  ["invalid readiness time", { time: "invalid" }, "missing or invalid readiness timestamp"],
  ["stale readiness time", { time: new Date(NOW - 120_001).toISOString() }, "stale readiness timestamp"],
  ["future readiness time", { time: new Date(NOW + 60_001).toISOString() }, "readiness timestamp is in the future"]
]) {
  test(`rejects ${name}`, async (t) => {
    const { options } = await fixture(t, { "/readyz": { body: { ...readiness(), ...patch } } });
    const results = await checkPublicDeployment(options);
    assert.equal(results.find(({ path }) => path === "/readyz").error, expected);
    assert.equal(results.filter(({ error }) => error).length, 1);
  });
}

for (const worker of readiness().workers) {
  test(`rejects missing required role ${worker.name}`, async (t) => {
    const body = readiness();
    body.workers = body.workers.filter(({ name }) => name !== worker.name);
    const { options } = await fixture(t, { "/readyz": { body } });
    const results = await checkPublicDeployment(options);
    assert.equal(results.find(({ path }) => path === "/readyz").error, "invalid readiness worker roles");
  });
}

for (const status of ["failed", "stale", "missing", undefined]) {
  test(`rejects worker status ${status} even with readiness ok true`, async (t) => {
    const body = readiness();
    body.workers[1] = { name: "outbox-worker", status, latestFailure: SECRET };
    const { options } = await fixture(t, { "/readyz": { body } });
    const results = await checkPublicDeployment(options);
    assert.equal(results.find(({ path }) => path === "/readyz").error, "unhealthy readiness workers");
    assert.ok(!JSON.stringify(results).includes(SECRET));
  });
}

test("accepts a reordered unique worker roster and readiness time at freshness boundary", async (t) => {
  const body = readiness();
  body.workers.reverse();
  body.time = new Date(NOW - 120_000).toISOString();
  const { options } = await fixture(t, { "/readyz": { body } });
  assert.ok((await checkPublicDeployment(options)).every(({ error }) => !error));
});

for (const [name, spec] of [
  ["oversized Content-Length without a completed body", {
    headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) }, hangBody: true
  }],
  ["oversized chunked body without Content-Length or stream completion", {
    chunks: [SECRET, "x".repeat(MAX_RESPONSE_BYTES / 2), "x".repeat(MAX_RESPONSE_BYTES / 2)], keepOpen: true
  }],
  ["oversized multibyte decoded body", {
    chunks: [SECRET, "\u00e9".repeat(MAX_RESPONSE_BYTES / 2)]
  }],
  ["oversized gzip-decoded body with small Content-Length", (() => {
    const raw = gzipSync(SECRET + "x".repeat(MAX_RESPONSE_BYTES));
    return { raw, headers: { "content-encoding": "gzip", "content-length": String(raw.length) } };
  })()]
]) {
  test(`rejects ${name} with a sanitized size error before JSON parsing`, async (t) => {
    const { options } = await fixture(t, { "/healthz": spec });
    const results = await checkPublicDeployment(options);
    assert.equal(results.find(({ path }) => path === "/healthz").error, "response body exceeds size limit");
    assert.equal(results.filter(({ error }) => error).length, 1);
    assert.ok(!JSON.stringify(results).includes(SECRET));
  });
}

test("accepts JSON exactly at decoded byte limit", async (t) => {
  const prefix = '{"ok":true,"padding":"';
  const suffix = '"}';
  const raw = prefix + "x".repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(prefix + suffix)) + suffix;
  const { options } = await fixture(t, { "/healthz": { raw } });
  assert.ok((await checkPublicDeployment(options)).every(({ error }) => !error));
});

for (const [name, spec] of [["headers", { hang: true }], ["body", { hangBody: true }]]) {
  test(`bounds timeout while waiting for ${name} and still checks all endpoints`, async (t) => {
    const { options, requests } = await fixture(t, { "/readyz": spec });
    const started = Date.now();
    const results = await checkPublicDeployment({ ...options, timeoutMs: 150 });
    assert.equal(results.find((result) => result.path === "/readyz").error, "request timed out");
    assert.equal(results.filter((result) => result.error).length, 1);
    assert.equal(requests.length, 3);
    assert.ok(Date.now() - started < 2000);
  });
}

test("sanitizes network errors", async () => {
  const results = await checkPublicDeployment({ fetchImpl: async () => { throw new Error(SECRET); } });
  assert.ok(results.every((result) => result.error === "request failed"));
  assert.ok(!JSON.stringify(results).includes(SECRET));
});

for (const [name, overrides, expectedCode] of [
  ["healthy", {}, 0],
  ["unhealthy", { "/readyz": { status: 503, body: { detail: SECRET } } }, 1]
]) {
  test(`CLI exits ${expectedCode} for ${name} local HTTP responses`, async (t) => {
    const { origin } = await fixture(t, overrides);
    const script = new URL("./check-public-deployment.mjs", import.meta.url);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { fileURLToPath } from "node:url";
      Date.now = () => ${NOW};
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        const target = new URL(url);
        return nativeFetch(${JSON.stringify(origin)} + target.pathname + target.search, options);
      };
      process.argv[1] = fileURLToPath(${JSON.stringify(script.href)});
      await import(${JSON.stringify(script.href)});
    `], { env: { ...process.env, GITHUB_STEP_SUMMARY: "" }, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const [code] = await once(child, "close");
    assert.equal(code, expectedCode, output);
    assert.match(output, /PASS \/healthz HTTP 200/);
    assert.match(output, new RegExp(`${expectedCode ? "FAIL" : "PASS"} /readyz HTTP ${expectedCode ? 503 : 200}`));
    assert.ok(!output.includes(SECRET));
  });
}
