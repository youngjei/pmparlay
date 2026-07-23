import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production Compose invariants", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");

  it("uses one shared 12-confirmation policy for every service", () => {
    expect(compose).toContain("USDC_REQUIRED_CONFIRMATIONS: ${USDC_REQUIRED_CONFIRMATIONS:-12}");
    expect(compose).not.toContain("USDC_REQUIRED_CONFIRMATIONS:-3");
    expect(compose.match(/^\s+USDC_REQUIRED_CONFIRMATIONS:/gm)).toHaveLength(1);
  });

  it("blocks API and worker startup on migrations and settlement-identity backfill", () => {
    expect(compose).toContain('command: ["sh", "-c", "npm run db:migrate && npm run db:backfill-settlement-identities"]');
    expect(compose.match(/migrate:\n\s+condition: service_completed_successfully/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps Safe credentials backend-only while making the browser origin deployable", () => {
    expect(compose).toContain("WEB_ORIGIN: ${WEB_ORIGIN:-http://localhost:5173}");
    expect(compose).toContain("SAFE_API_BASE_URL: ${SAFE_API_BASE_URL:-https://api.safe.global}");
    expect(compose).toContain("SAFE_API_KEY: ${SAFE_API_KEY:-}");
    expect(compose).not.toContain("VITE_SAFE_API_KEY");
  });
});
