import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";

const apps: Array<ReturnType<typeof buildApp>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production frontend delivery", () => {
  it("serves the SPA without masking unknown API routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "legwork-static-"));
    roots.push(root);
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<!doctype html><title>LEGWORK</title><div id=\"root\"></div>");
    await writeFile(join(root, "assets", "app-test.js"), "console.log('legwork')");

    const app = buildApp({ serveFrontend: true, frontendRoot: root });
    apps.push(app);

    const home = await app.inject({ method: "GET", url: "/" });
    expect(home.statusCode).toBe(200);
    expect(home.headers["cache-control"]).toBe("no-cache");
    expect(home.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(home.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(home.body).toContain("LEGWORK");

    const asset = await app.inject({ method: "GET", url: "/assets/app-test.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const missingApi = await app.inject({ method: "GET", url: "/api/not-a-real-route", headers: { accept: "text/html" } });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toEqual({ error: "not_found" });
  });
});
