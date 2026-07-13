# Database Setup

LEGWORK uses Postgres as the source of truth.

## Local Development

Use Docker Postgres:

```bash
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run index:markets
npm run db:stats
```

Periodic maintenance:

```bash
npm run db:maintenance
```

This currently removes expired idempotency keys and marks stale quoted rows as `expired`.

Current local scripts:

- `npm run db:migrate`: applies SQL migrations.
- `npm run index:markets`: fetches live Polymarket markets and persists market snapshots.
- `npm run queue:index-markets`: enqueues a BullMQ market indexing job.
- `npm run worker:markets`: runs the market indexing worker.
- `npm run db:stats`: prints table counts.

## Recommended Free Hosted Database

Use Neon Postgres first.

Reasons:

- Postgres-compatible and easy to migrate away from later.
- Free tier is suitable for prototype database workloads.
- Branching is useful for staging and preview environments.
- It keeps LEGWORK backend-owned instead of tying core architecture to a BaaS too early.

Use Supabase instead if the near-term priority becomes bundled auth/storage/realtime.

Avoid treating Railway as the dependable free database default. Its free path is
credit/trial-style and is better for quick deployment experiments than a stable database
foundation.

## Hosted Setup

1. Create a Neon project.
2. Copy the pooled or direct Postgres connection string.
3. Set `DATABASE_URL` in the server environment, not in committed files.
4. Run:

```bash
npm run db:migrate
npm run index:markets
npm run db:stats
```

## Migration Notes

Everything in the current schema is ordinary Postgres:

- no Neon-specific extensions,
- no Supabase-specific features,
- no vendor lock-in.

That keeps future migration paths open:

- Neon free -> Neon paid,
- Neon -> Supabase,
- Neon -> managed Postgres/RDS,
- local Docker -> hosted Postgres.

## Current Schema Coverage

Current migrations create:

- users,
- markets,
- market outcomes,
- market snapshots,
- policy versions,
- quotes,
- quote legs,
- risk checks,
- tickets,
- ticket legs,
- ledger accounts,
- ledger entries,
- settlements,
- audit log,
- outbox.

Still missing:

- auth tables from the final auth provider,
- Redis-backed job/lock state,
- exposure counters,
- settlement worker checkpoints,
- admin/operator permissions.
