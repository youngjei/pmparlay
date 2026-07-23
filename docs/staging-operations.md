# Supervised Sepolia Staging Operations

This runbook is for a supervised Sepolia house-book drill. It is not a production or mainnet launch procedure. One operator starts or stops services; a separate reviewer approves treasury changes and Safe activity.

## Guardrails

- This deployment is locked to `SETTLEMENT_CHAIN_ID=11155111` and Circle Sepolia USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`; production startup rejects any other payment chain or USDC address. Ethereum mainnet requires a deliberate, separately reviewed deployment-specific configuration and code change later.
- Use `NODE_ENV=production`, `ACCOUNTING_MODE=house_book_usdc`, `LEDGER_CURRENCY=USDC`, and `SETTLEMENT_CHAIN_ID=11155111` only with an approved Sepolia Safe and the Sepolia USDC address in `.env.example`.
- Do not put secrets in Git, `VITE_*` variables, terminal history, tickets, or logs. Keep `DATABASE_URL`, `OPS_API_KEY`, `SAFE_API_KEY`, `ETHEREUM_RPC_URL`, and any hosted-service credentials in the staging secret store or an untracked environment file. `PRIVY_APP_ID` is public; `SAFE_API_KEY` is backend-only.
- Require `OPS_API_KEY` before exposing `/api/ops/*`. Use `Authorization: Bearer $OPS_API_KEY` for every ops request. This shared staging credential is not sufficient evidence of two distinct people, so production-mode runtime treasury mutation is disabled and Safe withdrawal actions remain supervised.
- Ethereum mainnet is prohibited: no mainnet chain ID, Safe, USDC address, RPC, funding, signing, withdrawal, or deposit scan. Supervised Sepolia uses `SETTLEMENT_AUTHORITY=polymarket_api`: both Polymarket Gamma and CLOB must agree across a PostgreSQL-enforced stability window. Polygon CTF reads remain dormant unless a separately reviewed sidecar changes the authority.
- A financial gate must be `allowed: true`, `launchGate: "ready"`, and `operationGate: "open"` before any payment, ticket activation, claim, bankroll, withdrawal request, or Safe proposal. The sole exception is the fully verified `mark-sent` ledger repair for a Safe transfer that has already executed, described below.

## Prerequisites

Prepare an untracked staging environment from `.env.example` with:

- A unique `POSTGRES_PASSWORD` for Compose and a matching host-local `DATABASE_URL`; Compose binds the API, Postgres, and Redis to `127.0.0.1` only. Production startup requires `RATE_LIMIT_BACKEND=redis` and `RATE_LIMIT_SKIP_ON_REDIS_ERROR=false`.
- Sepolia `ETHEREUM_RPC_URL`, `TREASURY_SAFE_ADDRESS`, `USDC_CONTRACT_ADDRESS`, and an explicit confirmation count. The example sets `USDC_REQUIRED_CONFIRMATIONS=12`.
- `PRIVY_APP_ID` and its JWKS URL or the derived default.
- No Polygon RPC credential is required for the approved supervised-Sepolia authority. Two independent Polygon RPC operators are required only if the dormant `polygon_ctf` authority is deliberately re-enabled.
- An `OPS_API_KEY` of at least 20 characters, held only by staging operators. Use a separate approved Safe owner outside this process for any Safe transaction. Replace the shared key with authenticated operator roles before unattended or mainnet operation.

Before starting, confirm the effective values are Sepolia-only and that no mainnet treasury or token address was copied in. Do not print the environment to validate it.

Keep Polygon provider URLs in the gitignored sidecar `.context/polygon-settlement.env`, not in chat, source, shell arguments, or the generated base staging file. Create or protect the file with `umask 077; touch .context/polygon-settlement.env; chmod 600 .context/polygon-settlement.env`, then open it in a local editor and add only:

```dotenv
SETTLEMENT_AUTHORITY=polygon_ctf
SETTLEMENT_RPC_QUORUM=2
POLYGON_RPC_URL="<primary-private-url>"
POLYGON_RPC_OPERATOR="<primary-operator>"
POLYGON_SECONDARY_RPC_URL="<secondary-private-url>"
POLYGON_SECONDARY_RPC_OPERATOR="<secondary-operator>"
```

The two operator labels must identify genuinely independent providers. The staging runners reject symlinks, permissions other than `0600`, unsupported keys, duplicate normalized URLs, and duplicate operator labels. They load this sidecar after `.context/sepolia-staging.env`, so it survives `staging:provision` and overrides the generated `SETTLEMENT_AUTHORITY=polymarket_api` only when the protected file exists. Do not create this sidecar for the currently approved API-authority drill.

## Startup And Migration Order

Local supervised staging uses a dedicated `legwork_sepolia_staging` database and Redis database 1 on the existing loopback-only containers. It does not copy or restore development users, tickets, balances, deposits, or ledger entries. Run from the repository root after the local Postgres and Redis containers are healthy:

```bash
npm run staging:provision
npm run staging:qa
npm run staging:run
npm run staging:web
```

`staging:provision` is idempotent and applies the complete migration and settlement-identity backfill chain. For a reset, use only `npm run staging:reset`: it requires stopped services, creates and checksum-validates a backup, restores it into a disposable database, fingerprints every public table, and binds a mode-`0600` restore attestation to the exact archive digest before the provisioner may drop state. A direct `staging:provision -- --reset` without that attestation fails closed. The reset also requires `STAGING_RESET_CONFIRM` to equal the exact staging database name. Both commands generate `.context/sepolia-staging.env` with mode `0600`, preserve its generated ops key and deposit scan start across idempotent runs, verify the payment RPC is Sepolia, and pin Circle Sepolia USDC plus the approved Safe owner. Treat any nonzero backfill or preflight exit as a startup blocker.

`staging:run` owns the API and required market, deposit, reconciliation, and settlement workers as one foreground process group. Run `staging:web` in a second terminal; it exposes only public Privy, chain, and token values to Vite and proxies `/api` to staging port `8790`. Both launchers use sanitized environments that ambient database or API variables cannot redirect. For isolated manual debugging, use only the staging wrappers:

```bash
npm run staging:worker:markets
npm run staging:worker:deposits
npm run staging:worker:reconciliation
npm run staging:worker:settlements
```

The market worker is required whenever users browse markets. It advances a durable Polymarket cursor in one-page jobs, refreshes already-known markets, admits newly eligible markets, and keeps every quote- or ticket-referenced snapshot while pruning older unreferenced snapshots. The one-page limit avoids long database transactions. Sweep duration depends on Polymarket's active catalog size and can take hours at the default one-minute cadence; monitor `market_catalog_sweep_state` instead of assuming a fixed page count. The last completed-sweep timestamp remains available while the next generation is in progress. Start `npm run start:worker:outbox` only when its queue is in use. `npm run dev:local` starts the frontend, API, market, deposit, reconciliation, and settlement processes as a development convenience, but it is not a supervised staging procedure.

The market worker and all financial workers hold PostgreSQL singleton leases. A second process must exit with `worker_already_running`; a restarted process must record a new runtime generation and a new successful cycle before `/readyz` returns healthy.

Docker Compose includes the reconciliation worker with the same startup dependency and heartbeat healthcheck used by the other financial workers. Its `migrate` service runs both database migrations and the settlement-identity backfill; a nonzero backfill exit prevents the API and workers from starting. Every service receives the same 12-confirmation default from shared production configuration.

The Sepolia Safe, Circle USDC address, chain, and confirmation count come only from reviewed deployment secrets. Production-mode `POST /api/ops/treasury/config` and its approval route are disabled. Changing treasury scope requires a new deployment review; do not edit database treasury rows directly.

## Health Checks

```bash
curl -fsS http://127.0.0.1:8790/healthz
curl -fsS http://127.0.0.1:8790/readyz
curl -fsS http://127.0.0.1:8790/api/ops/treasury/config \
  -H "Authorization: Bearer $OPS_API_KEY"
curl -fsS http://127.0.0.1:8790/api/ops/financial-gate \
  -H "Authorization: Bearer $OPS_API_KEY"
```

`/healthz` only proves the API process is alive. `/readyz` also checks configured Postgres, Redis, and shared production worker health. It does not prove that an initial full market-catalog sweep has completed; run `npm run qa:markets` as a separate catalog release check. Catalog QA requires a full sweep within six hours and current-generation progress within five minutes by default, then refreshes its sample from CLOB. These thresholds are separate because a bounded full sweep can legitimately take hours while a stuck worker must be detected quickly. The financial-gate response must show a recent worker snapshot with a verified block number/hash and trusted treasury/token scope. A snapshot older than five minutes blocks money movement.

For workers started under Compose, their process healthchecks run `npm run worker:health` against a heartbeat file. Workers also write shared database health every 10 seconds so the API can detect a missing cross-container dependency. Process heartbeats are stale after 45 seconds by default; the last successful work cycle is stale after 180 seconds so legitimate 60-90 second scans are not marked failed. A worker restart clears the previous process's success state until the new process completes a successful cycle. Deposit, reconciliation, and settlement workers each hold a PostgreSQL advisory-lock singleton lease; a duplicate process exits and a crashed process releases the lease with its database session. For manually started workers, inspect their structured logs and ensure they continue to emit `deposit.scan`, `financial.reconciliation.snapshot`, or `settlement.batch` activity as applicable. The authenticated financial-gate endpoint also exposes reconciliation freshness.

## Happy-Path Drill

1. Confirm `/readyz` succeeds, the approved treasury config is Sepolia, and the financial gate is open.
2. Create a small, disposable Sepolia-USDC payment through the user flow. The payment intent progresses `pending -> submitted -> confirmed -> activating -> activated`; the deposit scanner confirms the transfer and retries confirmed activations.
3. Check the user's `GET /api/payment-intents` and the ticket/portfolio flow with that authenticated user. Do not create payments while the gate is restricted or blocked.
4. Confirm a fresh gate snapshot after the deposit. Query `GET /api/ops/exposure` with the ops bearer token and verify exposure is consistent with the deliberately small drill.
5. For settlement, query `GET /api/ops/settlements/pending`, `GET /api/ops/settlements/alerts`, and `GET /api/ops/ticket-legs/<ticket-leg-id>/proofs`. In house-book mode, manual `POST /api/ops/ticket-legs/<id>/settle` is intentionally rejected. A leg finalizes only after Gamma and CLOB agree on the frozen identity and terminal result twice, with matching persisted fingerprints separated by at least `SETTLEMENT_API_STABILITY_MS`. The repository measures candidate age from PostgreSQL time.
6. For a withdrawal drill, make a small request through the authenticated user flow. After independent human review, create the unsigned Safe payload:

```bash
curl -sS -X POST http://127.0.0.1:8790/api/ops/withdrawals/<withdrawal-id>/propose \
  -H "Authorization: Bearer $OPS_API_KEY" -H "X-Operator-Id: operator-a"
```

The API records `requested -> proposed` and returns a USDC transfer payload and hash. It does not broadcast to Safe. **TODO:** use an approved external Safe signing workflow, independently compare Safe, token, destination, amount, chain, and proposal hash, then submit the Sepolia transaction. After its required confirmations, record the exact transaction hash:

```bash
curl -sS -X POST http://127.0.0.1:8790/api/ops/withdrawals/<withdrawal-id>/mark-sent \
  -H "Authorization: Bearer $OPS_API_KEY" -H "X-Operator-Id: operator-b" \
  -H 'Content-Type: application/json' \
  --data '{"onchainTxHash":"0x<66-character-transaction-hash>"}'
```

`mark-sent` verifies the canonical Sepolia USDC transfer, Safe proposal, amount, destination, and confirmations before `proposed -> sent`. Because the Safe transfer has already happened, this exact verified transition remains available when reconciliation is closed so the matching ledger debit can repair the temporary delta; it cannot initiate a transfer or create a proposal.

## House Funding Ledger Repair

Under the supervised staging procedure, one human initiates the small Sepolia USDC transfer and a second human independently reviews it using the approved Safe or an approved external funding wallet. After the transfer is successful and has the configured confirmation depth, record the already-completed transfer with its exact receipt log index:

```bash
npm run staging:house:fund -- \
  --tx-hash 0x<66-character-transaction-hash> \
  --log-index <decimal-transfer-log-index> \
  --operator-id operator-a \
  --approver-id operator-b \
  --reason "Sepolia house funding reviewed"
```

The CLI reads the configured `ETHEREUM_RPC_URL`, `SETTLEMENT_CHAIN_ID`, `TREASURY_SAFE_ADDRESS`, `USDC_CONTRACT_ADDRESS`, and confirmation depth. It verifies the canonical successful receipt and one exact external USDC `Transfer` log to the configured Safe, rejects Safe self-transfers and active user-wallet sources, and atomically claims the transfer so it can never also become a user deposit. It then writes immutable evidence and the balanced house ledger entry. The operator and approver labels must differ, but they are audit labels rather than authenticated identities; this command is permitted only under supervised staging and is not production-grade dual control. Authenticated operator RBAC and independently signed approval remain required before unattended operation or mainnet. The command never constructs, signs, submits, or broadcasts a transaction and requires no private key. A matching repeat returns the original ledger transaction without another credit; conflicting evidence fails closed.

The deposit overlap scan also revalidates house-funding evidence. If a previously recorded transfer disappears after a reorg, it writes an append-only compensating ledger transaction, opens a critical incident, and blocks financial operations. The original evidence and ownership claim remain immutable.

A fresh staging ledger must start against a zero-USDC Safe. Historical user payments or unexplained Safe balances must not be relabeled as house funding. If the approved Safe already has a balance, use its external signing workflow to move that balance out and independently review the transfer. Then make one new external house-capital transfer and record only that transfer through `staging:house:fund`. Require `npm run staging:qa:open` to report a zero unexplained difference before accepting a user payment.

This is a post-transfer reconciliation repair, so it remains available while the financial gate is closed. It is not permission to fund the Safe through the application: stop on any verification failure, preserve the receipt and incident context, and have the two operators resolve it outside the service.

## Incidents

### Reconciliation Delta Or Closed Gate

1. Stop new payment, activation, claim, bankroll, and withdrawal actions. The application gate should already reject them.
2. Capture `/api/ops/financial-gate`, `/api/ops/treasury/config`, `/api/ops/exposure`, reconciliation-worker logs, and the observed block/hash. Do not clear or overwrite state.
3. Check the reconciliation worker is running with the intended Sepolia RPC and treasury config; restart only the failed worker after recording the incident. It will write a new canonical snapshot.
4. Resume only after a fresh snapshot reports `allowed: true`, no `treasury_internal_delta`, `negative_house_equity`, or `pending_withdrawal_ledger_mismatch` reasons, and a second operator approves the incident close.

The financial gate is derived from trusted reconciliation snapshots and cannot be manually set or cleared. This is intentional for supervised staging. Authenticated reconciliation and gate endpoints expose the source snapshot, reasons, and metrics; richer audited operator identity and incident tooling are deferred until before unattended operation.

### Deep Deposit Reorg

1. Stop new money movement and preserve deposit-worker logs. Do not manually credit or delete deposits.
2. The scanner rescans an overlap, marks changed deposits reorged, and seeks a common ancestor. `deposit_scan_common_ancestor_missing` blocks the scanner rather than guessing.
3. Verify the RPC endpoint, the Sepolia canonical chain, scan cursor, and the configured start/lookback range with engineering. Restart the deposit worker only after a common-ancestor recovery procedure is reviewed.

**TODO:** no operator command exists to inspect/reset a blocked scan cursor or execute a deep-reorg repair; this requires an audited code/database procedure.

### Stuck Payment Or Activation

1. Record the quote ID, user, intent status, transaction hash, and scanner output. Never ask a user to resend USDC until the original transfer is reconciled.
2. Let the deposit worker retry `confirmed` activations. A valid confirmed payment may move through `activating`; a lease conflict returns `payment_activation_in_progress`.
3. Investigate `recoverable` or `late_confirmation` using payment and database audit records. The supplied maintenance script only expires stale `pending`/`submitted` intents; it does not repair confirmed/recoverable payments.

Users can inspect their own recoverable payment intents, and the deposit worker retries confirmed activation and moves unsafe or expired intents into recovery. There is intentionally no operator mutation that can force activation; supervised incidents use the saved evidence and existing idempotent transitions.

### Stuck Settlement

1. Query pending legs, open alerts, and proofs using the ops endpoints above; preserve the sanitized resolver failure category and frozen settlement identity. Resolver exception strings and provider evidence fields named as errors are redacted before persistence and API exposure.
2. The worker opens one warning 24 hours after the ticket's immutable purchased-market end time, escalates it to critical after 72 hours, and opens a critical alert immediately for `settlement_blocked` or a legacy frozen leg with no recoverable due time. Configure these thresholds with `SETTLEMENT_OVERDUE_WARNING_MS` and `SETTLEMENT_OVERDUE_CRITICAL_MS`; critical must remain greater than warning.
3. Every open, escalation, reason change, and remediation is written to the append-only audit log and transactional outbox. Repeated polls update the incident but do not emit duplicate transition events. `SETTLEMENT_ALERT_BATCH_SIZE` is a per-cycle budget for each of two cohorts: existing incidents rotate by their last evaluation time while new incidents receive a separate equal budget. A terminal leg automatically remediates its open alert.
4. Check both Polymarket Gamma and CLOB availability and compare their frozen market, condition, and token identities plus terminal results. Restart the settlement worker after correcting a transport outage, then wait for a fresh candidate and the full stability window. A disagreement remains non-final.
5. Do not use the manual settle endpoint in house-book mode or override settlement evidence. Escalate `settlement_blocked` or repeated resolver errors to engineering.

### Withdrawal Or Safe Proposal

1. A withdrawal remains `requested` until proposal creation, then `proposed` until `mark-sent`; do not create a replacement request for the same funds. A user may cancel an unproposed request. A proposed request cannot be canceled because the current unsigned payload has no Safe nonce or transaction-service record that can prove non-execution. Complete it through verified `mark-sent` or preserve it as an incident until the Safe workflow is reconciled.
2. For a malformed or mismatched Safe payload, stop and compare the saved proposal hash against the requested Safe, USDC contract, destination, amount, and Sepolia chain. The service will reject proposal/transaction mismatches.
3. For `withdrawal_tx_*`, `withdrawal_receipt_verification_unavailable`, or RPC errors, do not mark sent manually. Wait for canonical required confirmations and retry the existing `mark-sent` request with the same transaction hash.

Safe API signing/broadcast is intentionally unconfigured even when `SAFE_API_KEY` exists. Proposed withdrawals therefore remain supervised; automated Safe transaction status polling, broadcast, and replacement are deferred until the signing architecture is approved.

## Backup, Restore, And Shutdown

Before migration, treasury change, Safe drill, or shutdown, capture the current gate response, worker logs, and a timestamped Postgres dump. Local supervised backup and restore verification are automated; scheduling, off-machine encrypted storage, retention, and managed PITR remain deployment work.

Create a mode-`0600` custom-format dump under `.context/backups` and rehearse it into a uniquely named disposable database:

```bash
npm run staging:backup
STAGING_RESTORE_REHEARSAL_CONFIRM=RESTORE npm run staging:restore-rehearsal
```

The rehearsal accepts only dumps and matching SHA-256 sidecars inside `.context/backups`, validates the archive, compares migration names and checksums, and compares row counts plus deterministic content fingerprints for every public application table. Exact comparison requires a quiescent source database, so stop the staging supervisor before the backup/rehearsal pair. A successful run writes a mode-`0600` content-addressed restore attestation. The rehearsal always drops only its `legwork_restore_rehearsal_*` target and never restores over or drops the source database. `npm run staging:reset` requires that attestation for its newly created recovery point before it may destroy the staging database. A real restore still requires stopping the API and workers, selecting a new isolated target, running migrations, and requiring a fresh open reconciliation gate before money movement.

A local non-destructive rehearsal completed on 2026-07-14 against migrations through `0042`. A fresh mode-`0600` backup was captured immediately before applying migration `0043` on 2026-07-21. Repeat the restore rehearsal against the current `0043` schema before supervised funds are accepted, then repeat it against the selected managed staging database and encrypted backup/PITR mechanism.

For orderly shutdown, first stop new user traffic and wait for an in-flight scan/settlement iteration to finish. Stop workers, then API, then state services only if the environment is being torn down:

```bash
docker compose --profile app stop api
docker compose --profile worker stop market-worker outbox-worker settlement-worker deposit-worker reconciliation-worker
docker compose stop postgres redis
```

For manually started workers, send `SIGTERM` and wait for their current loop to exit. Do not remove volumes during a staging incident or before a verified backup.
