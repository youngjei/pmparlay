# LEGWORK Infra And Secrets

## Current Infrastructure

LEGWORK is now a small modular monolith:

- `web`: React/Vite frontend.
- `api`: Fastify backend in `server/`.
- `domain`: shared pricing/risk package in `packages/domain`.
- `db`: Postgres schema and migration runner in `server/db`.
- `redis`: local Redis service in `docker-compose.yml`, ready for BullMQ/worker jobs.
- `rate-limit`: memory-backed locally; Redis-backed when `RATE_LIMIT_BACKEND=redis`.

Current backend capabilities:

- live market catalog endpoint,
- server-side quote endpoint,
- server-side risk/math execution,
- in-memory quote lookup for active quote retrieval,
- durable quote persistence when `DATABASE_URL` is configured,
- play-money ticket acceptance,
- double-entry ledger rows for accepted play tickets,
- house-book USDC accounting mode scaffolding,
- per-ticket reserve rows for worst-case house liability,
- closed-beta exposure caps for stake, payout, user, market, and event risk,
- double-entry play-money payout/refund rows when tickets settle final,
- open market exposure endpoint,
- Postgres migrations.
- containerized API runtime through `Dockerfile.api`,
- compose app profile that runs migrations before starting the API.
- outbox worker for durable async events.
- outbox dead-letter status for messages that exhaust retries.
- worker heartbeat files and compose healthchecks for background worker liveness.

Current CI:

- frontend build,
- API typecheck,
- unit tests,
- Playwright e2e,
- npm audit,
- Gitleaks.

## Current Secrets

No real API keys, private keys, wallet keys, or custody keys are currently required.

The only secret-like runtime value today is:

- `DATABASE_URL`: required for `npm run db:migrate` and future durable persistence.
- `OPS_API_KEY`: required before exposing `/api/ops/*` outside local development.
- `REDIS_URL`: required for BullMQ workers and Redis-backed rate limits.
- `BETA_USER_API_KEY`: temporary bearer gate for production-mode API containers until
  real auth exists. It is not a replacement for proper sessions/RBAC.

`Idempotency-Key` is also accepted on quote and ticket mutation routes. It is not a
secret, but it is persisted with a request hash so retries can safely replay a prior
response instead of creating duplicate state.

`ACCOUNTING_MODE` defaults to `play_money`. The future real-money path is
`house_book_usdc`, with `LEDGER_CURRENCY=USDC` and `SETTLEMENT_CHAIN_ID=1` for Ethereum
mainnet. Do not enable that mode for users until wallet deposits, withdrawals, and
treasury reconciliation are implemented and tested.

`VITE_ALLOW_DIRECT_POLYMARKET_FALLBACK` should stay `false` outside local development so
the browser cannot bypass the server-authoritative market catalog.

Local development can use the Docker URL in `.env.example`:

```text
DATABASE_URL=postgres://legwork:legwork_dev_password@127.0.0.1:5432/legwork
```

That local password is not a production secret. Hosted database URLs must never be
committed.

Local Postgres has been verified with:

- migrations applied,
- live market indexing,
- quote persistence,
- play-money ticket acceptance,
- play-money settlement payout ledger entries,
- exposure views.
- automatic settlement polling for Polymarket legs,
- append-only settlement proof history,
- operator settlement proof inspection.

When `DATABASE_URL` is configured outside tests, `/api/markets` and `/api/quotes` read
from the persisted market catalog. The indexer is the only path that fetches live Gamma
data directly, which keeps quote source data aligned with persisted snapshots.

Local Redis is also available through Docker for the upcoming worker/queue slice.

## Future Secrets To Shield

Current public auth configuration:

- `VITE_PRIVY_APP_ID` / `PRIVY_APP_ID`: Privy app id. This is not a private key.
- `VITE_WALLETCONNECT_PROJECT_ID`: WalletConnect project id for the browser wallet modal.
- `PRIVY_JWKS_URL`: public Privy JWKS endpoint used by the API to verify JWTs.

Values still needed before production house-book mode:

- `TREASURY_SAFE_ADDRESS`: public Safe treasury address for Ethereum mainnet USDC.
- `ETHEREUM_RPC_URL`: needed for deposit/withdrawal reconciliation and Safe/USDC contract verification.
- `OPS_API_KEY` for temporary operator endpoint protection.
- Privy app secret only if server-side Privy admin APIs are introduced.

Future secrets to shield:

- OAuth client secrets if social login is added.
- Sentry/PostHog/Plausible keys.
- KYC provider API keys.
- Email provider API keys.
- Payment/custody provider API keys.
- Webhook signing secrets.
- Any wallet, trading, treasury, or private keys.

Rules:

- No private keys in the browser.
- No private keys in `.env` on app servers once money movement exists; use custody/KMS.
- No real secrets in git.
- Rotate any value accidentally exposed in logs or screenshots.
- Keep idempotency enabled on all persistent mutation routes before any real deposits,
  payments, or payouts are introduced.

## Auth And Treasury Controls

Wallet auth uses Privy wallet login in the browser and Privy JWT verification in the API.
The frontend must sync the Privy identity token to `/api/auth/privy/sync` before real-money
quote checkout is enabled. The API verifies the access token and identity token against the
configured Privy app and persists active linked Ethereum wallets server-side.

Treasury config changes are not applied by the initial operator request. `POST
/api/ops/treasury/config` creates a pending change with `X-Operator-Id` and a reason. `POST
/api/ops/treasury/config/:id/approve` must be called by a different operator id before the
new treasury config becomes active.

This is an application-level guard, not a substitute for Safe multisig controls. Before real
funds move, add RPC-based checks that the treasury address is the expected Safe contract on
Ethereum mainnet, the USDC contract matches the chain allowlist, and the Safe owner threshold
matches the closed-beta treasury policy.

## USDC Deposit Attribution

The first deposit path is scanner-based and works without private keys:

- User connects a wallet through Privy.
- Server sync stores active linked Ethereum wallets in `user_wallets`.
- User sends Ethereum mainnet USDC from that linked wallet to the configured Safe treasury.
- `worker:deposits` scans confirmed USDC `Transfer` logs to the treasury address.
- Transfers from active linked wallets credit `user_usdc_available`.
- Transfers from unknown wallets are recorded as `ignored` so operators can investigate.

The deposit ledger entry credits the user account and debits an `external_usdc_deposits`
clearing account. It does not credit `house_usdc_operating`, because user deposits are a
platform liability, not house bankroll.

Current limitation: deposits are attributed by sender wallet. If a user sends from an exchange
or an unlinked wallet, the scanner cannot safely assign the funds automatically. Closed beta
should instruct users to deposit only from their connected wallet until user-specific deposit
addresses or a custody provider are added.

## House Bankroll Funding

House-book tickets require available house operating balance before LEGWORK accepts open
liability. Operators can seed the internal house bankroll ledger through:

```bash
curl -X POST "$API_URL/api/ops/bankroll/fund" \
  -H "Authorization: Bearer $OPS_API_KEY" \
  -H "X-Operator-Id: ops-a" \
  -H "Content-Type: application/json" \
  --data '{
    "amountUsdc": 500,
    "reason": "Seed closed beta reserves",
    "reference": "safe-tx-or-sepolia-reference"
  }'
```

The route writes double-entry ledger rows and an audit-log event. The `reference` should
point to the Safe funding transaction or an explicit testnet funding reference. This is an
operator accounting control, not an onchain transfer; before real money, reconciliation
must prove the internal house operating balance is backed by treasury USDC.

## USDC Withdrawal Requests

The current withdrawal path is deliberately manual on the signing side:

- User requests a USDC withdrawal to an active linked wallet.
- The API debits `user_usdc_available` and credits `pending_usdc_withdrawals`.
- Ops sends USDC from the Safe treasury outside the app.
- Ops records the onchain tx hash through `/api/ops/withdrawals/:id/mark-sent`.
- The API clears `pending_usdc_withdrawals` into `external_usdc_withdrawals`.

This gives users and operators a durable ticket for withdrawals without putting treasury
private keys on the app server. Automated Safe transaction proposal/signing can be added
later, but should require stronger operator identity, multisig policy checks, and tx
simulation before submission.

## Recommended Free Database Path

Use two database tiers:

1. Local development: Docker Postgres from `docker-compose.yml`.
2. Hosted free prototype: Neon Postgres.

Why Neon first:

- It is Postgres-compatible.
- The free plan is currently suitable for prototypes.
- It is database-focused, so migration to paid Postgres/RDS later is straightforward.
- Branching is useful for preview environments.

Supabase is also reasonable if LEGWORK wants bundled auth/storage soon, but for this
repo's current backend-first direction Neon is cleaner.

Railway is less ideal as the database default because its free path is credit/trial
or usage-credit based rather than a dependable long-lived free database.

## Local Database Commands

```bash
cp .env.example .env
docker compose up -d postgres redis
npm run db:migrate
npm run index:markets
npm run db:stats
```

Stop local Postgres:

```bash
docker compose down
```

Delete local database data:

```bash
docker compose down -v
```

## Local App Container Commands

Build and run the API container against local Docker Postgres/Redis:

```bash
docker compose --profile app build api migrate
docker compose --profile app up -d api
curl http://127.0.0.1:8787/healthz
```

Stop only the app containers while leaving Postgres/Redis running:

```bash
docker compose --profile app stop api
docker compose --profile app rm -f api migrate
```

Run the market worker container profile:

```bash
docker compose --profile worker up market-worker
```

The market worker enqueues an immediate index job at startup and then repeats according
to `MARKET_INDEX_INTERVAL_MS` (default `60000`).

Run the outbox worker:

```bash
npm run worker:outbox
docker compose --profile worker up outbox-worker
```

`api`, `market-worker`, and `outbox-worker` use `restart: unless-stopped` in compose.
`market-worker` and `outbox-worker` also write heartbeat files checked by Docker
healthchecks. Outbox rows move to `dead` after retry exhaustion so ops can distinguish
permanent delivery failures from normal pending backlog.

Run the settlement worker:

```bash
npm run worker:settlements
docker compose --profile worker up settlement-worker
```

The settlement worker polls pending ticket legs, checks Polymarket CLOB market resolution,
records append-only proof observations, and settles play-money tickets when finalization is
allowed. In production, `SETTLEMENT_REQUIRE_ONCHAIN` defaults to `true`; until the Polygon
CTF confirmation adapter is implemented, closed markets are recorded as blocked instead of
being paid from an API-only winner signal.

Run periodic database maintenance:

```bash
npm run db:maintenance
```

Current packaging note: the API container runs TypeScript with `tsx` as a production
runtime dependency. That is acceptable for this POC-to-beta phase, but a later hardening
pass should compile the server to plain JavaScript and remove runtime transpilation.

## Missing Production Infra

Still missing before a real beta:

- hosted Postgres,
- Redis/BullMQ in a managed staging/prod environment,
- auth/session store,
- real user-owned quote/ticket storage,
- real auth-backed user-owned quote/ticket storage,
- wallet connect and wallet-to-user linking,
- Ethereum mainnet USDC deposit detection,
- user balance, reserved balance, claimable balance, and withdrawal APIs,
- Safe multisig treasury setup and reconciliation reporting,
- protected admin/ops console,
- OpenTelemetry/Sentry,
- deployment target,
- environment separation: dev/staging/prod,
- backup/restore drill,
- `RATE_LIMIT_BACKEND=redis` in staging/prod,
- Cloudflare/WAF/geo controls.

Important: `/api/ops/*` is protected by `OPS_API_KEY` when configured, and disabled by
production auth posture when secrets are absent. That is still only temporary operator
protection, not a proper admin session/RBAC system.

Still missing before any real money:

- legal model and jurisdiction,
- onchain CTF settlement confirmation and redemption-proof adapter,
- explicit policy for 50/50, void, canceled, neg-risk, and disputed outcomes,
- KYC/AML and age gate where required,
- responsible gambling controls,
- custody/wallet/key-management architecture,
- treasury/reserve policy,
- external security review,
- incident response runbook.
