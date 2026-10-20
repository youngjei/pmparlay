# Railway Sepolia Staging

Status: Required deployment configuration
Last updated: 2026-10-20

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

This five-service layout is the approved small-scale staging topology. Before mainnet, upgrade Railway capacity and replace the two grouped worker services with six isolated worker services: market indexer, outbox, deposits, reconciliation, settlements, and LP accounting. Keep the public web/API, Postgres, and Redis as separate services.

Railway automatically detects the root `Dockerfile`. The normal `legwork-web` pre-deploy command is `npm run db:migrate && npm run db:backfill-settlement-identities && npm run db:provision-lp-vault-shadow`. Migration `0049` is the exception: disable the automatic pre-deploy command for its first rollout, complete the backup and storage checks below, apply and verify `0049` as a supervised one-off migration, then restore the normal pre-deploy command. The vault provisioner is idempotent and refuses any scope except the configured Sepolia house book, treasury Safe, and Circle test-USDC token. The grouped commands must run as one replica each. Use `/healthz` as Railway's deployment health check so web deployment does not depend circularly on workers starting first. Monitor `/readyz` separately as the release gate: it returns `503` until Postgres, Redis, and fresh successful heartbeats from all six required worker roles are healthy, including `lp-vault-accounting`.

Migration `0049` installs the financial-book serialization fence and safe missed-cutoff recovery evidence. Before applying it, require an attached Postgres volume of at least 1 GB with at least 30% free, stop repository services, and take a portable `pg_dump` plus a Railway volume backup when the plan supports it. As of 2026-10-20 the Railway API restricts native backups to Pro workspaces. For supervised Sepolia on Hobby, a protected portable archive with a successful full restore rehearsal, matching financial content fingerprints, and verified migration checksums is the accepted substitute. This does not provide native snapshots or point-in-time recovery. Do not attach, delete, or resize a detached volume while its ownership is uncertain. A new installation reports `waiting_first_cutoff` until its first post-migration 00:00 UTC boundary; that state is healthy only during the installation day and exposes no verified accounting value. After the first canonical close, `npm run db:verify-lp-vault-accounting` must report an exact replay before LP accounting is considered release-ready. Missing or inconsistent cutoff evidence after the bootstrap day remains a hard worker failure.

Migration `0047` takes a short exclusive ticket-table lock while it freezes accepted terms and installs legacy quarantines. Run this pre-beta migration during a maintenance window with money-moving traffic paused. The migration runner's five-second lock timeout fails the deploy instead of waiting indefinitely when an older request has not drained.

The Railway dashboard remains the current deployment source of truth. Before the private-beta release candidate, install and link the current Railway CLI, export the project configuration, review its generated `.railway/railway.ts`, and validate a configuration plan without embedding secrets. Until that export is reviewed, compare every service command, replica count, restart policy, pre-deploy command, and health check against this runbook before deployment.

Run `npm run staging:qa:managed` inside the Railway web service for the migration-manifest, managed Postgres/Redis, Sepolia Safe, settlement quarantine, and financial-gate release check. The `--managed` path accepts only non-loopback Postgres and Redis targets; the Sepolia chain, Circle test-USDC contract, Safe owner, and threshold checks remain mandatory.

The repository is public. Railway still needs an active GitHub App installation for `youngjei/pmparlay` before enabling automatic deployments from `main`. `railway up` remains the manual deployment path while that installation is absent; do not replace the GitHub App connection with a personal access token stored in the repository.

A connected repository name is not proof of automatic deployment. Verify a `main` deployment trigger exists for each of the three repository services and that the trigger can access this repository. On 2026-10-20 Railway rejected trigger creation with a repository-access error even though reconnecting the source succeeded. Until the GitHub App permissions are repaired, upload all three services from the same clean, reviewed revision and record the revision in each deployment message.

Do not run multiple replicas of either grouped worker service. PostgreSQL singleton leases reject duplicate financial workers, but deployment configuration should still request exactly one replica per group.

Use `ALWAYS` restart policy for the three repository services in supervised staging. A finite `ON_FAILURE` retry budget allowed both worker deployments to be removed after a sustained dependency outage. Restarts do not fix full disks or invalid configuration; an unhealthy `/readyz` still requires operator attention. Keep the startup health check on `/healthz` and verify the complete service separately.

The `Public Deployment Uptime` GitHub workflow checks `/healthz`, `/readyz`, and a nonempty, fresh public catalog every fifteen minutes and on manual dispatch. Confirm Actions failure notifications reach the operator. GitHub schedules are best-effort and can be disabled after prolonged repository inactivity; they are initial staging monitoring, not guaranteed paging. Every release must also verify all three running revisions, all six healthy worker roles, fresh markets, and reconciliation. A green web deployment alone is insufficient.

The staging Postgres volume is intentionally small, but must still meet the 1 GB and 30% free-space deployment floor above. Use this start command so WAL remains bounded while the snapshot retention controls below limit retained catalog storage:

```text
wrapper.sh postgres --port=5432 -c max_connections=100 -c max_wal_size=96MB -c min_wal_size=32MB -c checkpoint_timeout=2min -c checkpoint_completion_target=0.9
```

These values are staging controls, not mainnet capacity targets. Upgrade the database volume and establish storage alerts, backups, and point-in-time recovery before mainnet.

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
TRUST_PROXY_HOPS=1
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

Use these catalog controls on the grouped market service for the free staging footprint. Apply the liquidity and volume thresholds to `legwork-web` as well so public reads and indexing use the same eligibility policy:

```text
MARKET_CATALOG_MIN_LIQUIDITY_USD=10000
MARKET_CATALOG_MIN_VOLUME_USD=50000
MARKET_SNAPSHOT_UNREFERENCED_RETENTION=2
MARKET_INDEX_JOB_TIMEOUT_MS=300000
MARKET_INDEX_DB_SOFT_LIMIT_BYTES=700000000
```

`MARKET_SNAPSHOT_UNREFERENCED_RETENTION` belongs only on `legwork-markets`. Keep at least two snapshots so pagination cursors survive an index refresh. Quote- and ticket-referenced snapshots remain immutable regardless of this setting. `MARKET_INDEX_DB_SOFT_LIMIT_BYTES` stops catalog writes before the minimum 1 GB Railway volume is exhausted; scale it only with measured free space and preserve the 30% migration headroom.

`SAFE_API_KEY` is optional because LEGWORK does not automate Safe signing or broadcast. If it is configured for read-only Safe metadata, keep it backend-only and never prefix it with `VITE_`.

Set `API_HOST=0.0.0.0` only on `legwork-web`. `USDC_DEPOSIT_START_BLOCK` must be captured immediately before the first beta funding transfer and set only on `legwork-financial`. Do not use a moving lookback for the beta ledger boundary.

### Deposit RPC Recovery

Keep provider URLs and keys in Railway variables, never in chat, source, or deployment messages. For the current Alchemy free Sepolia endpoint, configure these on `legwork-financial`:

```text
USDC_DEPOSIT_SCAN_BATCH_BLOCKS=2000
USDC_DEPOSIT_RPC_LOG_PAGE_BLOCKS=10
USDC_DEPOSIT_RPC_MIN_INTERVAL_MS=200
USDC_DEPOSIT_CATCHUP_INTERVAL_MS=1000
USDC_DEPOSIT_POLL_INTERVAL_MS=30000
```

The logical scan window is separate from the provider's per-request log-range limit. The scanner processes contiguous ten-block pages, preserves its 24-block reorg overlap, and saves progress only after the verified range is processed. RPC pacing applies to all scanner RPC methods, not just logs; the provider's quota is shared with any other users of that key. A backlog or incomplete response keeps the scanner unhealthy and money-moving routes closed. Catch-up uses the shorter interval; normal polling resumes only after reaching the confirmed head. Monitor `deposit.scan` events for `backlogBlocks`, `caughtUp`, and cursor progress. Do not reset a cursor or move the start block forward to make readiness green.

Migration `0050` indexes the latest-snapshot foreign key so snapshot retention does not repeatedly scan the entire market table. On an existing busy catalog, the equivalent index may be built concurrently before the transactional migration records it. Verify the index is valid before deployment. Storage guards remain mandatory; never raise the soft limit to conceal a full disk. Catalog-state compaction during a stopped-indexer maintenance window may reclaim dead storage without deleting market or financial records.

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

1. Confirm migrations, settlement-identity backfill, and LP vault provisioning succeed in pre-deploy logs.
2. Confirm both grouped worker services are running one replica each and all six required worker heartbeats are fresh in `GET /readyz`.
3. Confirm `GET /healthz`, `/`, `/favicon.svg`, and `/api/markets` return successfully from the public domain.
4. Connect the user wallet, verify Sepolia USDC balance, create a maximum `$5` basket, and follow it through submitted, confirming, repricing, and live.
5. Confirm the ticket appears immediately in `Portfolio`, every transaction link targets Sepolia Etherscan, and ledger/Safe reconciliation remains exact.
6. Restart each worker once and repeat readiness plus reconciliation checks.
7. Run `npm run db:verify-lp-vault-accounting` and retain its cycle, book-version, hash, and replay totals with the release record.

The site is not considered live merely because Railway is connected to GitHub. It is live only after a public domain serves the current commit and `/readyz` reports all dependencies and required workers healthy.
