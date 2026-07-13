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
With `DATABASE_URL` configured, the API serves markets from the persisted catalog. Run
`npm run index:markets` before quoting against a fresh database.

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
docker compose --profile app build api migrate
docker compose --profile app up -d api
curl http://127.0.0.1:8787/readyz
```

Stop only the app containers:

```bash
docker compose --profile app stop api
docker compose --profile app rm -f api migrate
```

## Current Scope

- Browse source-linked live Polymarket outcomes with catalog freshness metadata.
- Build a multi-leg basket and request server-authored quotes.
- Collect Sepolia USDC payments through a Safe treasury and activate confirmed tickets.
- Track Portfolio tickets, purchase tx logs, settlement states, and withdrawal requests.
- Run deposit and settlement workers in local runtime with heartbeat checks.
- Enforce launch exposure caps, quote expiry, payment reconciliation, ledger balancing, and ops controls.

Before mainnet launch, finish the remaining external integration work: on-chain Polymarket settlement confirmation, production monitoring/alerts, and final legal/geo controls.
