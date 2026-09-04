# LEGWORK Production Roadmap

Status: Canonical
Last updated: 2026-09-04

The immediate release target is supervised Sepolia staging. Mainnet gates are intentionally revisited immediately before an invite-only Ethereum launch.

## Current State

- Phases 0-2 are implemented and locally verified. Persisted discovery uses bounded server-side pagination and a latest-snapshot pointer; public catalog prices and checkout execution quotes remain separate. The payment request allows three minutes to submit a transaction, then tracks a submitted transaction for fifteen minutes while activation requotes against live books.
- Phase 3 now supports two explicit authorities. The approved production authority uses Polymarket Gamma plus CLOB with immutable identity checks, terminal-result agreement, and two append-only matching observations separated by a PostgreSQL-enforced stability window. Accepted ticket economics and per-leg prices are immutable, final payout calculations are append-only, and legacy void-policy tickets fail closed into a supervised quarantine. The dormant Polygon CTF path is optional defense in depth; no single API response can authorize a payout.
- Phase 4 core ledger, deposit, claim, withdrawal, Safe proposal, reconciliation, supervised house-funding evidence, transfer ownership, and reorg compensation controls are implemented. Financial workers have success-aware health checks and PostgreSQL singleton leases. The isolated staging database is the canonical financial test environment. Its Safe and ledger now reconcile from zero; a new deliberate opening-capital transfer still must be sent and recorded. House-funding operator labels are audit metadata, not authenticated dual control.
- Phase 5 is partial. Route limits, Redis fail-closed behavior, production configuration guards, secret scanning, CI, success-aware runtime health, supervised runbooks, and a local backup restore rehearsal exist. Anonymous frontend entry code is below a 250 KiB gzip budget and the deferred wallet runtime is below a 650 KiB gzip budget, with CI and Playwright regression gates. Verified operator RBAC, external monitoring, managed backup/PITR rehearsal against the current schema, and audited repair tooling remain.
- Phase 6 is deployed on the approved small-scale Railway topology with a public web/API service, managed Postgres and Redis, and grouped market/outbox and financial workers. Readiness verifies fresh successful heartbeats for market, deposit, reconciliation, and settlement processing. Opening funding, the automated burner-wallet lifecycle, real settlement-to-claim, managed backup/PITR rehearsal, and external alerting remain incomplete.
- Phase 7 has a read-only founder-funded Sepolia shadow-vault foundation: immutable vault/epoch metadata, an idempotent deployment provisioner, deterministic 100%/125% solvency math, pending-payment capacity observation, a fresh-reconciliation public read API, and a source-linked LP Vault transparency surface. Community deposits, LP units, vault-attributed tickets, enforceable LP withdrawal controls, and return reporting remain disabled.
- Ethereum mainnet remains disabled in code and operations.

## Phase 0: Source and Specification Baseline

- Track every intended source file and exclude local secrets and generated artifacts.
- Establish the product specification and decision log as canonical.
- Make CI reproducible from a fresh checkout.
- Remove or archive contradictory POC-era documents.

Exit criteria: clean intended Git state, clean secret scan, build/typecheck/tests run from the repository, and no competing current roadmap.

## Phase 1: Market Catalog Integrity

- Enforce live/tradable/date/liquidity eligibility at query time.
- Safely deactivate markets after complete index sweeps.
- Group markets by Polymarket event.
- Normalize categories and retain source tags as facets.
- Create explainable hard and soft relationship metadata.
- Add audited relationship overrides.
- Bound catalog jobs and snapshot retention while preserving every quote and ticket reference.

Exit criteria: ended markets disappear without waiting for cleanup, failed indexing cannot empty the catalog, event groups are stable, and every relatedness adjustment is explainable.

## Phase 2: Direct-Pay Quote Correctness

- Add three-minute payment requests and fifteen-minute submitted-transaction tracking.
- Add soft exposure reservations.
- Reprice from fresh order-book depth after payment confirmation.
- Freeze final quote, risk policy, market identity, and pricing evidence.
- Freeze accepted stake, fee, offered payout, reserve liability, and every accepted leg price behind database immutability controls.
- Add complete recovery for out-of-tolerance or invalid payments.

Exit criteria: stale quotes cannot activate, funds cannot be stranded, capacity cannot be oversold by concurrent requests, and every transition is idempotent.

## Phase 3: Settlement and Claims

- Separate payment-chain and Polymarket-settlement configuration.
- Freeze authority and per-leg source market, condition, token, outcome, index, snapshot, and neg-risk identity at activation.
- Resolve only when Gamma and CLOB agree on immutable identity and a terminal outcome.
- Persist a candidate, wait the configured stability window, re-read both sources, and re-enforce candidate age inside PostgreSQL finalization.
- Treat WebSocket resolution events as wake-up signals, never final evidence.
- Retain Polygon CTF verification only as an optional future defense-in-depth adapter.
- Implement won-claimable, claim, lost, per-leg void, all-legs-void stake return, and payment-recovery flows.

Exit criteria: catalog mutation cannot change a ticket, one provider or one observation cannot pay a ticket, provider disagreement fails closed, replay cannot double-pay, and standard, neg-risk, per-leg void, all-legs-void, and failed-payment fixtures settle according to policy.

## Phase 4: Financial and Treasury Hardening

- Add deposit overlap/reorg recovery. Keep staging treasury configuration static; any future rotation must retain historical payment, scanning, and reconciliation scopes.
- Complete idempotent withdrawal and Safe transaction states.
- Enforce append-only ledger/audit/proof records.
- Add scheduled solvency and ledger-to-chain reconciliation.
- Add operational funding and correction workflows with dual control.

Exit criteria: zero unexplained reconciliation difference, tested duplicate/reorg recovery, and no single request can reserve or transfer funds twice.

## Phase 5: Access, Security, and Operations

- Replace the shared ops key and caller-supplied identity with authenticated RBAC.
- Add dual approval, Safe-policy verification, route-specific limits, and kill switches.
- Add metrics, structured logs, alerts, incident runbooks, backup/PITR, and restore drills.
- Add full API/Postgres/Redis/EVM lifecycle tests.

Exit criteria: audited operator identity, rehearsed incident recovery, successful restore drill, and actionable alerts for every money-moving worker.

## Phase 6: Supervised Sepolia Staging

- Deploy isolated frontend, API, workers, Postgres, Redis, secrets, and monitoring.
- Run Privy, quote, USDC payment, confirmation, activation, settlement, claim, and withdrawal drills.
- Keep the Sepolia Safe and all operations supervised.
- Record defects and rerun the complete lifecycle after every release candidate.

Exit criteria: repeated end-to-end lifecycle succeeds, reconciliation remains exact, all workers recover from restart, and no critical or high-severity defect remains open.

## Phase 7: LP Vault Shadow Foundation

- Keep founder-funded Sepolia shadow accounting logically separate and label all current figures as global house-book observations rather than LP NAV.
- Publish only fresh, scope-matched reconciliation values with canonical block, treasury, token, timestamp, custody delta, and gate evidence.
- Calculate the 100% hard solvency floor, 125% operating floor, pending basket capacity, and junior outflow capacity with integer micro-USDC arithmetic.
- Add immutable serial epoch metadata and a deployment-safe idempotent shadow-vault provisioner.
- Add the third `LP Vault` product destination with conditional collateral health, stale-value withholding, formula validation, and 320px browser coverage.
- Define fixed-epoch economics, user-first seniority, pro-rata entitlement calculation, FIFO payout execution, and the no-community-capital boundary.

Exit criteria: the shadow surface and calculations pass unit, PostgreSQL, desktop/mobile browser, security/architecture, and UX review with no critical/high finding; no fake deposit, redemption, APY, NAV, or community-capital action is exposed.

The next LP stage is the replayable shadow book: vault/epoch ticket attribution, payment-intent reservations, append-only book events, vault-specific reconciliation, protocol-fee payables, deterministic scenario exposure, and simulated redemption plans. It must not move money or change customer quotes until its concurrency and replay evidence is reviewed.

## Mainnet Review

Immediately before mainnet, revisit and approve:

1. Production Safe threshold, owners, modules, limits, and emergency process.
2. Production payment-chain RPC redundancy and Polymarket API availability, disagreement, and schema-change drills.
3. Legal opinion, eligible jurisdictions, geo/access rules, terms, age controls, and sanctions policy.
4. External security review and remediation.
5. Backup restoration and incident exercises.
6. Mainnet bankroll, liability caps, reconciliation ownership, and daily close.
7. Invite cohort, support process, monitoring coverage, and rollback authority.

No mainnet payment route is enabled before this review is complete.
