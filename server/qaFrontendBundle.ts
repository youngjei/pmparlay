import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve("dist");
const html = await readFile(path.join(distDir, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/i);
if (!entryMatch?.[1]) throw new Error("Could not identify the production frontend entry chunk");

const entryPath = path.join(distDir, entryMatch[1].replace(/^\//, ""));
const entry = await readFile(entryPath);
const gzipBytes = gzipSync(entry, { level: 9 }).byteLength;
const maxInitialGzipBytes = Number(process.env.FRONTEND_QA_MAX_INITIAL_GZIP_BYTES || 250_000);
const assetNames = await readdir(path.join(distDir, "assets"));
const walletRuntimeName = assetNames.find((name) => /^WalletRuntime-[A-Za-z0-9_-]+\.js$/.test(name));
if (!walletRuntimeName) throw new Error("Could not identify the deferred wallet runtime chunk");
const walletRuntimePath = path.join(distDir, "assets", walletRuntimeName);
const walletRuntime = await readFile(walletRuntimePath);
const walletRuntimeGzipBytes = gzipSync(walletRuntime, { level: 9 }).byteLength;
const maxWalletRuntimeGzipBytes = Number(process.env.FRONTEND_QA_MAX_WALLET_RUNTIME_GZIP_BYTES || 650_000);

if (!Number.isFinite(maxInitialGzipBytes) || maxInitialGzipBytes <= 0) {
  throw new Error("FRONTEND_QA_MAX_INITIAL_GZIP_BYTES must be a positive number");
}
if (gzipBytes > maxInitialGzipBytes) {
  throw new Error(`Initial frontend bundle exceeds its gzip budget: ${gzipBytes} > ${maxInitialGzipBytes} bytes`);
}
if (!Number.isFinite(maxWalletRuntimeGzipBytes) || maxWalletRuntimeGzipBytes <= 0) {
  throw new Error("FRONTEND_QA_MAX_WALLET_RUNTIME_GZIP_BYTES must be a positive number");
}
if (walletRuntimeGzipBytes > maxWalletRuntimeGzipBytes) {
  throw new Error(
    `Deferred wallet runtime exceeds its gzip budget: ${walletRuntimeGzipBytes} > ${maxWalletRuntimeGzipBytes} bytes`
  );
}

console.log(
  JSON.stringify(
    {
      entry: path.relative(distDir, entryPath),
      rawBytes: entry.byteLength,
      gzipBytes,
      maxInitialGzipBytes,
      walletRuntime: path.relative(distDir, walletRuntimePath),
      walletRuntimeRawBytes: walletRuntime.byteLength,
      walletRuntimeGzipBytes,
      maxWalletRuntimeGzipBytes
    },
    null,
    2
  )
);
