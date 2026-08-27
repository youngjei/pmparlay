# Railway Sepolia Staging

Status: Required deployment configuration
Last updated: 2026-08-27

The supervised beta uses five Railway services: Postgres, Redis, the public web/API, and two grouped worker services. The API serves the compiled React application on the same origin, so browser API calls do not depend on a separate proxy or cross-origin configuration.

## Services

Create the Railway services `Postgres` and `Redis`, then create these repository services from `youngjei/pmparlay` on `main`:

| Service | Start command | Public domain |
| --- | --- | --- |
| `Postgres` | Railway Postgres plugin | No |
| `Redis` | Railway Redis plugin | No |
| `legwork-web` | Docker image default (`npm run start:api`) | Yes |
| `legwork-markets` | `npm run start:worker:market` | No |
| `legwork-financial` | `npm run start:worker:financial` | No |

Railway automatically detects the root `Dockerfile`. Run `npm run db:migrate && npm run db:backfill-settlement-identities` as the `legwork-web` pre-deploy command. The grouped commands must run as one replica each. Use `/readyz` as the web health check: it returns `503` until Postgres, Redis, and fresh successful heartbeats from all four required worker roles are healthy. `/healthz` is only a process-liveness check.

Do not run multiple replicas of either grouped worker service. PostgreSQL singleton leases reject duplicate financial workers, but deployment configuration should still request exactly one replica per group.

## Shared Runtime Variables

Configure these on all three repository services unless a narrower scope is noted:

```text
ACCOUNTING_MODE=house_book_usdc
LEDGER_CURRENCY=USDC
SETTLEMENT_CHAIN_ID=11155111
SETTLEMENT_AUTHORITY=polymarket_api
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
RATE_LIMIT_BACKEND=redis
RATE_LIMIT_SKIP_ON_REDIS_ERROR=false
TREASURY_SAFE_ADDRESS=0x1d4Fd58d9fC24c9F3C8dA0dEB4A05E7d122ef17B
STAGING_EXPECTED_SAFE_OWNER=0xbb87c00499e15C3cCB24821BAE384A69797Fe1B8
USDC_CONTRACT_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
USDC_REQUIRED_CONFIRMATIONS=12
ETHEREUM_RPC_URL=<Sepolia RPC URL>
PRIVY_APP_ID=cmr8w638r01zw0djs68l0yfy3
MAX_USER_LIABILITY_USD=100
MAX_MARKET_LIABILITY_USD=250
MAX_EVENT_LIABILITY_USD=250
OPS_API_KEY=<random secret with at least 32 bytes>
```

`SAFE_API_KEY` is optional because LEGWORK does not automate Safe signing or broadcast. If it is configured for read-only Safe metadata, keep it backend-only and never prefix it with `VITE_`.

Set `API_HOST=0.0.0.0` only on `legwork-web`. `USDC_DEPOSIT_START_BLOCK` must be captured immediately before the first beta funding transfer and set only on `legwork-financial`. Do not use a moving lookback for the beta ledger boundary.

## Web Runtime Variable

Set `WEB_ORIGIN` on `legwork-web` at runtime after its public domain is known. It is used for server CORS and is not a Vite build variable:

```text
WEB_ORIGIN=https://<legwork-web public domain>
```

## Web Build Variables

Set these on `legwork-web`. The Docker build declares these as build arguments because Vite embeds public configuration at build time:

```text
VITE_ENABLE_PRIVY=true
VITE_PRIVY_APP_ID=cmr8w638r01zw0djs68l0yfy3
VITE_WALLETCONNECT_PROJECT_ID=9d411c24f4f2aead9d0f3bbac5842134
VITE_SETTLEMENT_CHAIN_ID=11155111
VITE_USDC_CONTRACT_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
VITE_ALLOW_DIRECT_POLYMARKET_FALLBACK=false
```

Railway supplies `PORT`; the server maps it automatically. Do not set `API_PORT` unless a fixed private port is intentionally required.

## Verification

1. Confirm migrations and settlement-identity backfill succeed in pre-deploy logs.
2. Confirm both grouped worker services are running one replica each and all required worker heartbeats are fresh in `GET /readyz`.
3. Confirm `GET /healthz`, `/`, `/favicon.svg`, and `/api/markets` return successfully from the public domain.
4. Connect the user wallet, verify Sepolia USDC balance, create a maximum `$5` basket, and follow it through submitted, confirming, repricing, and live.
5. Confirm the ticket appears immediately in `Portfolio`, every transaction link targets Sepolia Etherscan, and ledger/Safe reconciliation remains exact.
6. Restart each worker once and repeat readiness plus reconciliation checks.

The site is not considered live merely because Railway is connected to GitHub. It is live only after a public domain serves the current commit and `/readyz` reports all dependencies and required workers healthy.
