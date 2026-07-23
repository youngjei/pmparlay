# LEGWORK Implementation Checklist

Status: Canonical
Last updated: 2026-07-21

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
- [ ] Exercise won, lost, void/refund, claim, and supervised withdrawal states where test markets permit.
- [ ] Reconcile user ledger, house ledger, Safe balance, reserves, and liabilities after every scenario.
- [ ] Produce a redacted lifecycle report with public transaction and state-transition evidence.
- [ ] Complete independent `gpt-5.6-sol` security and product QA.

## Sprint 4: Settlement Completion

- [x] Persist an explicit settlement authority on every frozen ticket leg.
- [x] Implement supervised-staging authority from both Polymarket Gamma and CLOB APIs.
- [x] Require exact frozen market, condition, token, outcome, index, and neg-risk identity agreement.
- [x] Require both providers to agree on a terminal result and persist two matching observations.
- [x] Enforce the stability window from PostgreSQL time, not caller-supplied timestamps.
- [x] Cover standard binary, negative-risk, disagreement, malformed response, outage, and explicit 50/50 void cases.
- [x] Keep manual house-book settlement disabled and preserve append-only proof, audit, and replay controls.
- [x] Add overdue-leg monitoring and actionable settlement alerts.
- [x] Pass focused unit and real PostgreSQL migration/finality tests.
- [ ] Complete a real ticket settlement-to-claim drill in supervised Sepolia staging.
- [ ] Pass the full unit, PostgreSQL, integration, runtime, security, and independent `gpt-5.6-sol` QA gates.

For supervised Sepolia, Polygon RPC is intentionally deferred by product decision. The dormant `polygon_ctf` authority remains available for a later onchain-source migration and must be reconsidered before mainnet; it is not a blocker for the approved Gamma+CLOB staging policy.

## User Inputs And External Dependencies

- [x] Privy project and identity tokens configured.
- [x] WalletConnect project configured.
- [x] Sepolia Safe and Circle Sepolia USDC configured.
- [x] Historical 14 Sepolia USDC removed from the Safe.
- [x] Funded gitignored bot wallet available.
- [ ] New opening house capital sent to the Safe and recorded from its transaction evidence.
- [ ] Managed staging hosting, Postgres, Redis, secret storage, and monitoring architecture approved.
- [ ] Previously shared Safe API key rotated before any deployment.

## Deferred Beyond Sprint 4

- Authenticated operator RBAC and production-grade dual approval.
- Managed cloud deployment, external monitoring, and managed PITR rehearsal.
- Mainnet Safe policy, legal/geo gates, bankroll approval, onchain settlement-source decision, and external security audit.
- Automated hedging, AI risk decisions, smart-contract escrow, and automated Safe signing.
