# LEGWORK Implementation Checklist

Status: Canonical
Last updated: 2026-09-04

An item is complete only after implementation, automated testing, runtime verification, and independent QA when the risk or blast radius warrants it. The current release target is supervised Sepolia staging, not mainnet.

## Sprint 1: Market And Frontend Performance

- [x] Enforce live, tradable, non-expired market eligibility.
- [x] Add server-side pagination, search, categories, and sort order.
- [x] Group sibling markets by Polymarket event without losing source links.
- [x] Keep checkout pricing independent from catalog snapshots.
- [x] Keep market browsing and basket access usable on desktop, tablet, and mobile.
- [x] Pass database-performance, unit, build, and browser regression tests.

## Sprint 2: Fresh Isolated Sepolia Environment

- [x] Provision an isolated `legwork_sepolia_staging` database and Redis database 1.
- [x] Apply the complete migration chain through `0043` from an empty financial state.
- [x] Pin Sepolia, Circle test USDC, the approved Safe, and its expected owner.
- [x] Remove the unexplained historical Safe balance and verify the onchain balance is zero.
- [x] Verify zero unexplained reconciliation difference and an open launch gate.
- [x] Add a staging-safe house-funding command that cannot fall back to the development environment.
- [ ] Send and record a new, deliberate opening house-capital transfer.
- [ ] Repeat worker startup, restart, backup, restore, and independent `gpt-5.6-sol` QA on migration `0043`.

Evidence on 2026-07-21: a mode-`0600` pre-migration backup was created, migration `0043_polymarket_api_settlement_authority.sql` was applied, all financial tables remained empty, the Safe held zero USDC, no settlement identity was quarantined, and `staging:qa:open` returned `launchGate: ready`, `operationGate: open`, and `unexplainedDeltaMicroUnits: 0`.

## Sprint 3: Automated Bot-Wallet Lifecycle

- [x] Load the gitignored Sepolia bot wallet without logging or committing its private key.
- [x] Verify its Sepolia ETH and Circle test-USDC balances.
- [x] Verify real Privy SIWE authentication without an app secret or auth bypass.
- [ ] Automate quote creation, payment intent creation, exact USDC transfer, and transaction submission.
- [ ] Verify confirmation, requote, activation, Portfolio visibility, and frozen settlement evidence.
- [ ] Exercise duplicate submission, expiry, delayed confirmation, worker restart, and RPC-failure recovery.
- [ ] Exercise won, lost, partial-void, all-void stake-return, claim, and supervised withdrawal states where test markets permit.
- [ ] Reconcile user ledger, house ledger, Safe balance, reserves, and liabilities after every scenario.
- [ ] Produce a redacted lifecycle report with public transaction and state-transition evidence.
- [ ] Complete independent `gpt-5.6-sol` security and product QA.

## Sprint 4: Settlement Completion

- [x] Persist an explicit settlement authority on every frozen ticket leg.
- [x] Implement supervised-staging authority from both Polymarket Gamma and CLOB APIs.
- [x] Require exact frozen market, condition, token, outcome, index, and neg-risk identity agreement.
- [x] Require both providers to agree on a terminal result and persist two matching observations.
- [x] Enforce the stability window from PostgreSQL time, not caller-supplied timestamps.
- [x] Cover standard binary, negative-risk, disagreement, malformed response, outage, and explicit 50/50 detection.
- [x] Replace whole-ticket 50/50 cancellation with the approved frozen-input per-leg void calculation and append-only final settlement summary.
- [x] Cover one void leg with remaining winners, one void leg with a remaining loser, multiple void legs, and all-legs-void automatic stake return.
- [x] Freeze accepted stake, fee, payout, reserve liability, and per-leg prices at the database boundary; settle only from those records.
- [x] Quarantine every pre-hardening ticket with void evidence but no final summary, exclude it from claims, and expose an honest settlement-review state.
- [ ] Cover recoverable duplicate, partial, late, unsupported-token, and overpayment transfers without treating them as activated-ticket refunds.
- [x] Keep manual house-book settlement disabled and preserve append-only proof, audit, and replay controls.
- [x] Add overdue-leg monitoring and actionable settlement alerts.
- [x] Pass focused unit and real PostgreSQL migration/finality tests.
- [ ] Complete a real ticket settlement-to-claim drill in supervised Sepolia staging.
- [ ] Pass the full unit, PostgreSQL, integration, runtime, security, and independent `gpt-5.6-sol` QA gates.

Polygon RPC is not required by the approved production trust model. The dormant `polygon_ctf` adapter may be retained for a future defense-in-depth option, but it is not a staging or mainnet blocker.

## User Inputs And External Dependencies

- [x] Privy project and identity tokens configured.
- [x] WalletConnect project configured.
- [x] Sepolia Safe and Circle Sepolia USDC configured.
- [x] Historical 14 Sepolia USDC removed from the Safe.
- [x] Funded gitignored bot wallet available.
- [ ] New opening house capital sent to the Safe and recorded from its transaction evidence.
- [x] Managed staging hosting, Postgres, Redis, secret storage, and grouped workers deployed on the approved small-scale Railway topology.
- [ ] External alerting and managed backup/PITR configured and rehearsed against the deployed Railway environment.
- [ ] Export the linked Railway project with the current Railway CLI, review the generated `.railway/railway.ts`, and keep service commands and health checks reproducible without committing secrets.
- [ ] Remediate any historical below-stake quotes and validate `quotes_offered_payout_covers_stake_check` before mainnet; new and updated quotes are already enforced.
- [ ] Previously shared Safe API key rotated before any mainnet or public production deployment (explicitly deferred during the supervised friends-and-family Sepolia beta).

## Deferred Beyond Sprint 4

- [ ] Before mainnet: upgrade Railway and split the grouped workers into five isolated services: market indexer, deposits, reconciliation, settlements, and outbox.
- Authenticated operator RBAC and production-grade dual approval.
- Managed cloud deployment, external monitoring, and managed PITR rehearsal.
- Mainnet Safe policy, legal/geo gates, bankroll approval, Polymarket API dependency review and disclosure, and external security audit.
- Automated hedging, AI risk decisions, smart-contract escrow, and automated Safe signing.

## Sprint 5: LP Vault Shadow Foundation

- [x] Record founder-approved epoch, economics, custody, full-collateral, withdrawal-ordering, and transparency policy in canonical documents.
- [x] Add immutable founder-funded Sepolia shadow-vault and serial epoch metadata with PostgreSQL constraint coverage.
- [x] Add an idempotent, deployment-safe provisioner pinned to the configured Sepolia Safe and Circle test USDC.
- [x] Add deterministic micro-USDC solvency math for the 100% hard floor, 125% operating floor, pending basket capacity, and maximum junior outflow.
- [x] Include active payment-intent capacity in worker reconciliation evidence, rounded and reserved separately per payment intent.
- [x] Add a GET-only, rate-limited, no-store public vault endpoint that withholds stale, malformed, untrusted, or wrong-scope values.
- [x] Add the `LP Vault` destination, source-linked reserve dashboard, conditional collateral health, loading/error recovery, and no fake LP financial actions.
- [x] Add frontend formula verification, independent five-minute stale expiry, fetch timeout, deep-link/back-forward checks, and 320px overflow coverage.
- [x] Close independent post-remediation security/architecture and UX review with no critical or high-severity finding.
- [ ] Deploy migrations `0044`, `0046`, and `0047`, run the shadow provisioner, produce a fresh reconciliation, and verify `/api/lp-vault` on Railway.

Local checkpoint evidence on 2026-09-04: 528 unit tests, 57 PostgreSQL integration tests, 44 Chromium journeys, and four wallet-runtime journeys passed. Frontend and API typechecks, the production build, bundle budgets, a clean ARM64 Docker build, and the production-container HTTP smoke test passed. Clean `npm ci` installs and the local dependency audit reported zero vulnerabilities. Migrations `0044`, `0046`, and `0047` applied cleanly to the local development database; Railway deployment verification remains unchecked above.

The next sprint is the vault-specific replayable shadow book. It includes immutable ticket/epoch attribution, book versions and events, protocol-fee payables, vault-scoped reconciliation, deterministic scenario limits, and simulated redemption plans. Community deposits, LP units, real LP withdrawals, and customer-quote enforcement remain out of scope until that shadow system passes concurrency, replay, legal, custody, and independent-review gates.
