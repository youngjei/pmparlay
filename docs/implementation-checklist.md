# LEGWORK Implementation Checklist

Status: Canonical
Last updated: 2026-10-20

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

- [ ] Before mainnet: upgrade Railway and split the grouped workers into six isolated services: market indexer, outbox, deposits, reconciliation, settlements, and LP accounting.
- Authenticated operator RBAC and production-grade dual approval.
- Managed cloud deployment, external monitoring, and managed PITR rehearsal.
- Mainnet Safe policy, legal/geo gates, bankroll approval, Polymarket API dependency review and disclosure, and external security audit.
- Automated hedging, AI risk decisions, smart-contract escrow, and automated Safe signing.

## Sprint 5: LP Vault Shadow Foundation

- [x] Record founder-approved rolling-cycle, economics, custody, full-collateral, liquidity-gated redemption, and transparency policy in canonical documents.
- [x] Add immutable founder-funded Sepolia shadow-vault metadata with PostgreSQL constraint coverage. The public API no longer exposes the retired serial-epoch model.
- [x] Add an idempotent, deployment-safe provisioner pinned to the configured Sepolia Safe and Circle test USDC.
- [x] Add deterministic micro-USDC solvency math for the 100% hard floor, 125% operating floor, pending basket capacity, and maximum junior outflow.
- [x] Include active payment-intent capacity in worker reconciliation evidence, rounded and reserved separately per payment intent.
- [x] Add a GET-only, rate-limited, no-store public vault endpoint that withholds stale, malformed, untrusted, or wrong-scope values.
- [x] Add the `LP Vault` destination, one clear founder-shadow notice, verified reserve and collateral dashboard, progressive technical evidence, loading/error recovery, and no fake LP financial actions.
- [x] Add frontend formula verification, independent five-minute stale expiry, fetch timeout, deep-link/back-forward checks, and 320px overflow coverage.
- [x] Close independent post-remediation security/architecture and UX review with no critical or high-severity finding.
- [x] Deploy migrations `0044`, `0046`, and `0047`, run the shadow provisioner, produce a fresh reconciliation, and verify `/api/lp-vault` on Railway.

Local checkpoint evidence on 2026-09-04: 528 unit tests, 57 PostgreSQL integration tests, 44 Chromium journeys, and four wallet-runtime journeys passed. Frontend and API typechecks, the production build, bundle budgets, a clean ARM64 Docker build, and the production-container HTTP smoke test passed. Clean `npm ci` installs and the local dependency audit reported zero vulnerabilities. Migrations `0044`, `0046`, and `0047` applied cleanly to the local development database; Railway deployment verification remains unchecked above.

## Sprint 6: Rolling LP Vault Accounting Foundation

- [x] Replace fixed-cohort documentation and product copy with the approved rolling daily-cycle model.
- [x] Use integer micro-USDC and fixed non-transferable share units for every canonical financial calculation.
- [x] Record deposits as pending immediately and activate each exactly once at the next 00:00 UTC cycle using the common pre-deposit share price.
- [x] Separate economic NAV, collateral solvency, estimated P&L, finalized P&L, and reserved redemption liquidity.
- [x] Conservatively mark unresolved tickets and fall back to full offered payout when reliable pricing is unavailable.
- [x] Implement the internal shadow redemption lifecycle: queued FIFO request, liquidity admission, active 72-hour redemption, binding end valuation, atomic burn, payable, and claimable state.
- [x] Keep queued and admitted shares active in P&L and new exposure until end-period burn.
- [x] Persist hash-chained events plus append-only cycles, liability marks, NAV checkpoints, share records, reserve marks, and closing states.
- [x] Run one idempotent daily accounting worker inside the existing small-scale Railway financial-worker group without enabling public LP fund movement.
- [x] Extend `GET /api/lp-vault` with independently fresh verified reserve and daily accounting evidence; unavailable data must never render as `$0`.
- [x] Present verified assets, collateral coverage, rolling accounting, and the future LP lifecycle without fake deposit, withdrawal, return, or APY controls.
- [x] Prove exact replay, duplicate prevention, restart behavior, deposit timing, settlement recognition, stale-source failure, and multiple daily cycles with zero unexplained micro-USDC difference.
- [x] Pass unit, real PostgreSQL, API, build, desktop, and mobile tests.
- [x] Close independent `gpt-5.6-sol` accounting/security and product/UX reviews with no unresolved critical or high-severity finding.

Community deposits, wallet-owned LP shares, real LP withdrawals, and customer-quote enforcement remain out of scope until this foundation and the later legal, dedicated-custody, risk, and independent-audit gates pass.

Foundation evidence on 2026-09-12: 609 unit tests, 71 real PostgreSQL tests, and four Chromium LP Vault journeys passed; one unrelated legacy direct-pay migration case remains intentionally skipped. API typecheck, production build, frontend bundle budgets, `git diff --check`, and the production dependency audit also passed, with zero reported vulnerabilities. Two independent `gpt-5.6-sol` reviews found no unresolved critical or high-severity issue. Reconciliation admission accepts only a confirmation-safe canonical block whose source-evidence timestamp is no more than five minutes old. The source evidence time (`asOf`) and worker completion time (`processedAt`) are retained separately. Before public LP funds, add a monotonic financial-book serialization boundary, deterministic missed-cutoff recovery, and projection-by-projection replay verification.

## Sprint 6 Hardening Checkpoint

- [x] Add a transactionally monotonic financial-book version covering ledger, ticket reserve, settlement, payment exposure, and withdrawal mutations.
- [x] Hash canonical reconciled financial state and require the latest committed book version before cycle close.
- [x] Recover a missed cutoff only from canonical snapshots that bracket it with an unchanged book version and state hash.
- [x] Record immutable close mode, source delay, and recovery evidence on liability marks and daily cycles.
- [x] Verify every accounting event against its direct projection or share/redemption lifecycle history.
- [x] Add the LP accounting worker to production readiness and local staging supervision.
- [x] Add an operator replay command for release verification.
- [x] Expand the attached Railway Postgres volume to at least 1 GB, verify a protected portable backup through a full PostgreSQL 18 restore, and deploy migrations `0048` and `0049`. Native backup creation is unavailable on the current Hobby plan; the restored portable archive is the supervised-staging substitute.
- [ ] Complete runtime verification of all six workers and the public catalog after the 2026-10-20 recovery.
- [x] Verify the operator-provided Alchemy Sepolia endpoint against the saved historical block hash and a ten-block USDC log request, without logging its key.
- [x] Separate RPC log-page limits from logical catch-up windows, pace scanner requests, preserve reorg overlap, and keep financial readiness closed while behind or incomplete. Pass 627 unit tests, API typecheck, production build, and independent review with no critical, high, or medium finding.
- [x] Add migration `0050` for the market latest-snapshot foreign-key index, verify focused PostgreSQL index/retention tests, and verify the production index is valid. Reclaim unused catalog storage without deleting financial history.
- [ ] Verify the deployed deposit scanner reaches confirmed head without skipping saved history, then repeat full readiness and reconciliation checks.
- [ ] Verify exact LP accounting replay after the first canonical post-migration 00:00 UTC close. Accounting stays unavailable before that close; community fund movement remains disabled.

Hardening evidence on 2026-09-15: 616 unit tests, 82 real PostgreSQL tests, 45 Chromium journeys, production build, API typecheck, frontend bundle budgets, and the production dependency audit passed. Independent accounting and operations reviews closed the transaction-boundary, legacy-upgrade, exact-projection, first-cutoff, and worker-supervision findings. Railway Hobby is active, the public API is healthy, and a portable production dump was checksum-verified; deployment remains blocked only by the attached Postgres volume being 426 MB of 500 MB. No production migration was attempted.

Recovery update on 2026-10-20: PR #15 had merged on October 1, but Railway still served revision `7552e29`. The attached 500 MB volume filled and PostgreSQL repeatedly failed recovery with `No space left on device`; both worker deployments had been removed after prolonged crashes. The volume is now 1 GB (Railway offered 1 GB or 5 GB, so the smaller option stayed within the approved 2 GB ceiling). The database recovered, a fresh portable backup was fully restored with matching financial content fingerprints and original migration checksums, migrations `0048`/`0049` applied, and the normal pre-deploy command was restored. All three repository services were deployed from reviewed revision `17af144`, with `ALWAYS` restart policies. Markets load and five of six worker roles are healthy; the deposit scanner remains blocked by the public Sepolia RPC's `pruned history unavailable` response for its saved scan range. The cursor has not been skipped and new payment intents remain gated. GitHub deployment-trigger creation still requires the repository's Railway App access to be repaired. LP accounting is in `waiting_first_cutoff` until 2026-10-21 00:00 UTC (09:00 KST); exact replay remains unverified until then. See the staging runbook for backup and recovery controls.

Recovery follow-up: the operator supplied a working Alchemy Sepolia endpoint. Its ten-block log-range limit requires paginated catch-up, not a cursor reset. A missing `markets.current_snapshot_id` index caused snapshot-pruning timeouts; after building it concurrently, generation 1081 completed its 199-page sweep. With the indexer paused, compaction of catalog state and market tables reclaimed about 180 MB of dead storage; the attached filesystem then reported about 60% used and 350 MiB available. No financial rows were removed. The scanner's saved position was roughly 120,000 blocks behind; deployment and catch-up must complete before marking runtime recovery finished.
