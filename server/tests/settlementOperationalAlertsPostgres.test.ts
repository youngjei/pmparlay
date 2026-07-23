import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { config } from "../config";
import { closePool } from "../db/client";
import { syncSettlementOperationalAlerts } from "../db/settlementAlertRepository";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = path.join(process.cwd(), "server/db/migrations");
const originalDatabaseUrl = config.DATABASE_URL;

async function applyMigrations(client: pg.Client, through?: string) {
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql") && (!through || name <= through))
    .sort();
  for (const migration of migrations) {
    await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
  }
}

async function applyMigration(client: pg.Client, migration: string) {
  await client.query(await readFile(path.join(migrationsDirectory, migration), "utf8"));
}

function databaseUrlForSchema(schema: string) {
  const url = new URL(testDatabaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

async function withDisposableSchema(
  context: TestContext,
  run: (client: pg.Client) => Promise<void>,
  through?: string
) {
  if (!testDatabaseUrl) {
    context.skip();
    return;
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
  }

  const client = new pg.Client({ connectionString: testDatabaseUrl });
  try {
    await client.connect();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      context.skip();
      return;
    }
    throw error;
  }

  const schema = `settlement_alert_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await applyMigrations(client, through);
    await closePool();
    config.DATABASE_URL = databaseUrlForSchema(schema);
    await run(client);
  } finally {
    await closePool();
    config.DATABASE_URL = originalDatabaseUrl;
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

async function seedPendingLeg(client: pg.Client) {
  const ids = {
    user: randomUUID(),
    policy: randomUUID(),
    market: randomUUID(),
    outcome: randomUUID(),
    snapshot: randomUUID(),
    quote: randomUUID(),
    quoteLeg: randomUUID(),
    ticket: randomUUID(),
    ticketLeg: randomUUID()
  };
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [ids.user, `${ids.user}@example.test`]);
  await client.query(
    "INSERT INTO policy_versions (id, version, description, policy) VALUES ($1, $2, 'alert test', '{}'::jsonb)",
    [ids.policy, `alert-${ids.policy}`]
  );
  await client.query(
    `
      INSERT INTO markets (id, source, source_market_id, question, market_url, category, end_date)
      VALUES ($1, 'polymarket', $2, 'Alert test?', 'https://polymarket.com/event/alert-test', 'Other', '2026-07-10T00:00:00Z')
    `,
    [ids.market, `alert-${ids.market}`]
  );
  await client.query(
    "INSERT INTO market_outcomes (id, market_id, outcome, token_id) VALUES ($1, $2, 'Yes', '12345')",
    [ids.outcome, ids.market]
  );
  await client.query(
    `
      INSERT INTO market_snapshots (id, market_id, source_response_hash, raw)
      VALUES ($1, $2, 'alert-snapshot', $3)
    `,
    [
      ids.snapshot,
      ids.market,
      {
        outcomes: [
          {
            outcome: "Yes",
            endDate: "2026-07-10T00:00:00Z",
            marketId: `alert-${ids.market}`,
            conditionId: `0x${"1".repeat(64)}`,
            tokenId: "12345"
          }
        ]
      }
    ]
  );
  await client.query(
    `
      INSERT INTO quotes (
        id, user_id, policy_version_id, status, stake_micro_usd, operation_fee_micro_usd,
        spread_bps, implied_probability_bps, offered_payout_micro_usd, expires_at
      )
      VALUES ($1, $2, $3, 'accepted', 1000000, 500000, 0, 5000, 2000000, now() + interval '1 hour')
    `,
    [ids.quote, ids.user, ids.policy]
  );
  await client.query(
    `
      INSERT INTO quote_legs (id, quote_id, market_id, outcome_id, market_snapshot_id, outcome, quoted_price_bps)
      VALUES ($1, $2, $3, $4, $5, 'Yes', 5000)
    `,
    [ids.quoteLeg, ids.quote, ids.market, ids.outcome, ids.snapshot]
  );
  await client.query(
    `
      INSERT INTO tickets (id, user_id, quote_id, status, accounting_mode, funding_currency)
      VALUES ($1, $2, $3, 'live', 'house_book_usdc', 'USDC')
    `,
    [ids.ticket, ids.user, ids.quote]
  );
  await client.query(
    `
      INSERT INTO ticket_legs (id, ticket_id, quote_leg_id, status, settlement_due_at)
      VALUES ($1, $2, $3, 'pending', '2026-07-10T00:00:00Z')
    `,
    [ids.ticketLeg, ids.ticket, ids.quoteLeg]
  );
  return ids;
}

afterEach(async () => {
  await closePool();
  config.DATABASE_URL = originalDatabaseUrl;
});

postgresDescribe("settlement operational alerts PostgreSQL integration", () => {
  it("deduplicates, escalates, audits, emits outbox events, and auto-remediates", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const ids = await seedPendingLeg(client);
      const thresholds = { warningAfterMs: 24 * 60 * 60_000, criticalAfterMs: 72 * 60 * 60_000 };

      const first = await syncSettlementOperationalAlerts({
        ...thresholds,
        now: new Date("2026-07-12T00:00:00Z")
      });
      const duplicate = await syncSettlementOperationalAlerts({
        ...thresholds,
        now: new Date("2026-07-12T01:00:00Z")
      });
      const escalation = await syncSettlementOperationalAlerts({
        ...thresholds,
        now: new Date("2026-07-14T00:00:00Z")
      });

      expect(first).toMatchObject({ opened: 1, escalated: 0 });
      expect(duplicate).toMatchObject({ opened: 0, escalated: 0, reasonChanged: 0 });
      expect(escalation).toMatchObject({ opened: 0, escalated: 1 });

      const openIncident = await client.query<{ count: string; severity: string }>(
        `
          SELECT count(*) OVER ()::text AS count, severity
          FROM financial_incidents
          WHERE kind = 'settlement_leg_attention' AND status = 'open'
        `
      );
      expect(openIncident.rows).toEqual([{ count: "1", severity: "critical" }]);

      await client.query("UPDATE ticket_legs SET status = 'won', settled_at = now() WHERE id = $1", [ids.ticketLeg]);
      const remediation = await syncSettlementOperationalAlerts({
        ...thresholds,
        now: new Date("2026-07-14T00:05:00Z")
      });
      expect(remediation.remediated).toBe(1);

      const transitions = await client.query<{ action: string }>(
        `
          SELECT action
          FROM audit_log
          WHERE entity_id = $1 AND action LIKE 'settlement.alert.%'
          ORDER BY created_at, id
        `,
        [ids.ticketLeg]
      );
      expect(transitions.rows.map((row) => row.action)).toEqual([
        "settlement.alert.opened",
        "settlement.alert.escalated",
        "settlement.alert.remediated"
      ]);

      const outbox = await client.query<{ topic: string }>(
        "SELECT topic FROM outbox WHERE topic LIKE 'settlement.alert.%' ORDER BY created_at, id"
      );
      expect(outbox.rows.map((row) => row.topic)).toEqual([
        "settlement.alert.opened",
        "settlement.alert.escalated",
        "settlement.alert.remediated"
      ]);
    });
  });

  it("opens an immediate critical incident for a blocked leg before its due time", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const ids = await seedPendingLeg(client);
      await client.query(
        `
          UPDATE ticket_legs
          SET resolution_state = 'settlement_blocked', settlement_due_at = '2026-08-01T00:00:00Z'
          WHERE id = $1
        `,
        [ids.ticketLeg]
      );

      const result = await syncSettlementOperationalAlerts({
        now: new Date("2026-07-14T00:00:00Z"),
        warningAfterMs: 24 * 60 * 60_000,
        criticalAfterMs: 72 * 60 * 60_000
      });
      expect(result).toMatchObject({ opened: 1 });

      const incident = await client.query<{ severity: string; reason: string }>(
        "SELECT severity, reason FROM financial_incidents WHERE entity_id = $1 AND status = 'open'",
        [ids.ticketLeg]
      );
      expect(incident.rows[0]).toEqual({ severity: "critical", reason: "settlement_blocked" });
    });
  });

  it("deduplicates an alert when two settlement cycles race", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const ids = await seedPendingLeg(client);
      const input = {
        now: new Date("2026-07-12T00:00:00Z"),
        warningAfterMs: 24 * 60 * 60_000,
        criticalAfterMs: 72 * 60 * 60_000
      };

      const results = await Promise.all([
        syncSettlementOperationalAlerts(input),
        syncSettlementOperationalAlerts(input)
      ]);

      expect(results.reduce((total, result) => total + result.opened, 0)).toBe(1);
      const incidents = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM financial_incidents WHERE entity_id = $1 AND status = 'open'",
        [ids.ticketLeg]
      );
      const audits = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM audit_log WHERE entity_id = $1 AND action = 'settlement.alert.opened'",
        [ids.ticketLeg]
      );
      const outbox = await client.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM outbox
          WHERE topic = 'settlement.alert.opened'
            AND payload->>'ticketLegId' = $1
        `,
        [ids.ticketLeg]
      );
      expect(incidents.rows[0]?.count).toBe("1");
      expect(audits.rows[0]?.count).toBe("1");
      expect(outbox.rows[0]?.count).toBe("1");
    });
  });

  it("reserves bounded batch capacity for an existing alert that needs escalation", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const existing = await seedPendingLeg(client);
      await syncSettlementOperationalAlerts({
        now: new Date("2026-07-12T00:00:00Z"),
        warningAfterMs: 24 * 60 * 60_000,
        criticalAfterMs: 72 * 60 * 60_000,
        limit: 1
      });
      for (let index = 0; index < 4; index += 1) {
        await seedPendingLeg(client);
      }

      const result = await syncSettlementOperationalAlerts({
        now: new Date("2026-07-14T00:00:00Z"),
        warningAfterMs: 24 * 60 * 60_000,
        criticalAfterMs: 72 * 60 * 60_000,
        limit: 2
      });

      expect(result).toMatchObject({ candidates: 3, escalated: 1, opened: 2 });
      const incident = await client.query<{ severity: string }>(
        "SELECT severity FROM financial_incidents WHERE entity_id = $1 AND status = 'open'",
        [existing.ticketLeg]
      );
      expect(incident.rows[0]?.severity).toBe("critical");
    });
  });

  it("rotates existing incidents while continuing to admit new alerts across bounded cycles", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const existing: Array<Awaited<ReturnType<typeof seedPendingLeg>>> = [];
      for (let index = 0; index < 3; index += 1) {
        existing.push(await seedPendingLeg(client));
      }
      await syncSettlementOperationalAlerts({
        now: new Date("2026-07-12T00:00:00Z"),
        warningAfterMs: 24 * 60 * 60_000,
        criticalAfterMs: 72 * 60 * 60_000,
        limit: 3
      });
      const fresh = await seedPendingLeg(client);

      for (let cycle = 0; cycle < 3; cycle += 1) {
        await syncSettlementOperationalAlerts({
          now: new Date(`2026-07-14T00:0${cycle}:00Z`),
          warningAfterMs: 24 * 60 * 60_000,
          criticalAfterMs: 72 * 60 * 60_000,
          limit: 1
        });
      }

      const incidents = await client.query<{ entityId: string; severity: string }>(
        `
          SELECT entity_id::text AS "entityId", severity
          FROM financial_incidents
          WHERE entity_id = ANY($1::uuid[]) AND status = 'open'
        `,
        [[...existing.map((ids) => ids.ticketLeg), fresh.ticketLeg]]
      );
      expect(incidents.rows).toHaveLength(4);
      expect(incidents.rows.filter((row) => existing.some((ids) => ids.ticketLeg === row.entityId))).toEqual(
        expect.arrayContaining(existing.map((ids) => ({ entityId: ids.ticketLeg, severity: "critical" })))
      );
    });
  });

  it("rejects a newly frozen leg without an immutable settlement due time", async (context) => {
    await withDisposableSchema(context, async (client) => {
      const ids = await seedPendingLeg(client);
      await client.query("ALTER TABLE ticket_legs DISABLE TRIGGER ticket_legs_frozen_validation_provenance");
      try {
        await expect(
          client.query(
            `
              INSERT INTO ticket_legs (
                id, ticket_id, quote_leg_id, status, settlement_frozen_at, settlement_due_at
              )
              VALUES ($1, $2, $3, 'pending', now(), NULL)
            `,
            [randomUUID(), ids.ticket, ids.quoteLeg]
          )
        ).rejects.toThrow(/frozen_ticket_leg_settlement_due_missing/);
      } finally {
        await client.query("ALTER TABLE ticket_legs ENABLE TRIGGER ticket_legs_frozen_validation_provenance");
      }
    });
  });

  it("backfills a malformed legacy snapshot from the market deadline without aborting migration 0042", async (context) => {
    await withDisposableSchema(
      context,
      async (client) => {
        const ids = await seedPendingLeg(client);
        await client.query(
          `
            UPDATE market_snapshots
            SET raw = jsonb_set(raw, '{outcomes,0,endDate}', to_jsonb('2026-99-99T00:00:00Z'::text))
            WHERE id = $1
          `,
          [ids.snapshot]
        );
        await client.query("UPDATE ticket_legs SET settlement_due_at = NULL WHERE id = $1", [ids.ticketLeg]);

        await applyMigration(client, "0042_frozen_settlement_due.sql");

        const result = await client.query<{ settlementDueAt: Date | null }>(
          "SELECT settlement_due_at AS \"settlementDueAt\" FROM ticket_legs WHERE id = $1",
          [ids.ticketLeg]
        );
        expect(result.rows[0]?.settlementDueAt?.toISOString()).toBe("2026-07-10T00:00:00.000Z");
      },
      "0041_settlement_operational_alerts.sql"
    );
  });
});
