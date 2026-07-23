# LEGWORK Database Operations

Status: Current development guide
Last updated: 2026-07-13

Postgres is LEGWORK's financial and product source of truth. Redis/BullMQ coordinates jobs but is not authoritative for balances, tickets, payments, settlement, or reconciliation.

## Local Setup

```bash
cp .env.example .env
docker compose up -d postgres redis
npm run db:migrate
npm run index:markets
npm run db:stats
```

For the isolated supervised Sepolia database, keep the existing state containers and run:

```bash
npm run staging:provision
npm run staging:qa
npm run staging:run
```

This uses `legwork_sepolia_staging` and Redis database 1. It never imports the development ledger. `npm run staging:reset` is an explicit destructive rebuild of only the safety-prefixed staging database.

Run the complete local product with API and financial workers:

```bash
npm run dev:local
```

## Schema Ownership

SQL migrations in `server/db/migrations` are append-only after deployment. They cover:

- users, Privy wallet identities, and treasury configuration;
- market snapshots, eligibility, event groups, and index sweep state;
- quotes, quote legs, payment intents, exposure reservations, and tickets;
- double-entry ledger accounts and entries;
- onchain deposits, withdrawals, Safe proposal evidence, and reorg handling;
- CTF settlement identity, proof history, claims, and quarantine;
- reconciliation snapshots, incidents, financial gates, audit logs, and outbox delivery.

Repository helpers must not create schema at runtime. A fresh database must reach the current schema using only `npm run db:migrate`.

## Operational Rules

- Never put `DATABASE_URL` in browser variables or committed files.
- Use separate databases and credentials for local, Sepolia staging, and mainnet.
- The API and each worker receive least-privilege credentials; migration credentials are separate.
- Staging must enable encrypted backups and point-in-time recovery before handling supervised funds.
- Run migration, rollback/recovery, and restore drills against a copy of staging data before mainnet review.
- Financial tables and accepted settlement evidence are append-only or changed only through audited compensating transactions.

## Hosted Database

The hosted Postgres vendor remains an explicit architecture decision. Selection must compare connection limits, transaction semantics, backups/PITR, region, maintenance windows, observability, and migration portability. The current schema uses ordinary Postgres and should not depend on vendor-specific database APIs.

## Useful Commands

```bash
npm run db:migrate
npm run db:stats
npm run db:latest
npm run db:maintenance
npm run index:markets
npm run queue:index-markets
npm run worker:markets
npm run worker:reconciliation
```

Before staging deployment, add and verify a migration smoke test that creates an empty database, applies every migration, checks constraints/triggers, and exercises concurrent financial mutations against real Postgres.
