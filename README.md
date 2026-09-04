# LEGWORK

Production-oriented prediction-market basket app for composing source-linked Polymarket outcomes into one ticket.

## Run locally

```bash
npm install
cp .env.example .env
docker compose up -d postgres redis
npm run db:migrate
npm run index:markets
npm run dev:local
```

The frontend prefers the LEGWORK API at `/api/markets`. In local development, Vite proxies `/api` to
`http://127.0.0.1:8787` when `npm run dev:api` is running. If the backend is unavailable, the UI falls
back to direct Polymarket Gamma reads for development only. Production builds fail closed unless
`VITE_ALLOW_DIRECT_POLYMARKET_FALLBACK=true` is explicitly set.

LEGWORK intentionally shows live source-linked markets only. It does not show demo or fabricated markets.
With `DATABASE_URL` configured, the API searches and pages the persisted discovery catalog, then refreshes the visible token IDs from CLOB before returning prices. Checkout refreshes the selected legs again for exact stake depth. Run `npm run index:markets` before quoting against a fresh database.

## Checks

```bash
npm run build
npm run typecheck:api
npm run test:unit
npm run test:e2e
npm audit --audit-level=high
```

## Local backend utilities

```bash
npm run db:stats
npm run db:latest
npm run db:maintenance
npm run queue:index-markets
npm run worker:markets
npm run worker:outbox
npm run worker:settlements
```

Run the API as a production-style container against local Postgres/Redis:

```bash
docker compose --profile app --profile worker build
docker compose --profile app --profile worker up -d
curl http://127.0.0.1:8787/readyz
```

Stop only the app containers:

```bash
docker compose --profile app --profile worker stop
docker compose --profile app --profile worker rm -f
```

## Current Scope

- Browse source-linked live Polymarket outcomes with catalog freshness metadata.
- Build a multi-leg basket and request server-authored quotes.
- Collect Sepolia USDC payments through a Safe treasury and activate confirmed tickets.
- Track Portfolio tickets, purchase tx logs, settlement states, and withdrawal requests.
- Inspect a read-only founder-funded Sepolia LP Vault shadow dashboard with source-linked reserves, full-collateral floors, pending basket capacity, and fail-closed freshness checks.
- Run deposit and settlement workers in local runtime with heartbeat checks.
- Enforce launch exposure caps, quote expiry, payment reconciliation, ledger balancing, and ops controls.

The next target is supervised Sepolia staging. Direct-payment recovery, Gamma+CLOB settlement finality, reconciliation, Safe withdrawal, PostgreSQL concurrency, and lifecycle controls are implemented locally. The isolated staging database and zero-balance Safe reconcile exactly; remaining gates include deliberate opening house capital, supervised end-to-end payment and settlement drills, managed deployment infrastructure, external monitoring, and independent QA tracked in `docs/production-roadmap.md`. Ethereum mainnet remains disabled until its treasury, legal/geo, API-settlement, security, and operations review is approved.

See [the supervised Sepolia staging operations runbook](docs/staging-operations.md) for startup, health, drill, incident, backup, and shutdown procedures. LP Vault policy, staged implementation gates, formulas, and future publishing notes live in [the LP Vault roadmap](docs/lp-vault-roadmap.md) and [transparency standard](docs/lp-vault-transparency.md).
