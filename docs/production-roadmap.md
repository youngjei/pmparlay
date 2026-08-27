# LEGWORK Production Roadmap

Status: Canonical
Last updated: 2026-08-28

The immediate release target is supervised Sepolia staging. Mainnet gates are intentionally revisited immediately before an invite-only Ethereum launch.

## Current State

- Phases 0-2 are implemented and locally verified. Persisted discovery uses bounded server-side pagination and a latest-snapshot pointer; public catalog prices and checkout execution quotes remain separate. The payment request allows three minutes to submit a transaction, then tracks a submitted transaction for fifteen minutes while activation requotes against live books.
- Phase 3 now supports two explicit authorities. Supervised Sepolia uses Polymarket Gamma plus CLOB with immutable identity checks, terminal-result agreement, and two append-only matching observations separated by a PostgreSQL-enforced stability window. The dormant Polygon CTF quorum path is retained for later mainnet review; no single API response can authorize a payout.
- Phase 4 core ledger, deposit, claim, withdrawal, Safe proposal, reconciliation, supervised house-funding evidence, transfer ownership, and reorg compensation controls are implemented. Financial workers have success-aware health checks and PostgreSQL singleton leases. The isolated staging database is the canonical financial test environment. Its Safe and ledger now reconcile from zero; a new deliberate opening-capital transfer still must be sent and recorded. House-funding operator labels are audit metadata, not authenticated dual control.
- Phase 5 is partial. Route limits, Redis fail-closed behavior, production configuration guards, secret scanning, CI, success-aware runtime health, supervised runbooks, and a local backup restore rehearsal exist. Anonymous frontend entry code is below a 250 KiB gzip budget and the deferred wallet runtime is below a 650 KiB gzip budget, with CI and Playwright regression gates. Verified operator RBAC, external monitoring, managed backup/PITR rehearsal against the current schema, and audited repair tooling remain.
- Phase 6 is deployed on the approved small-scale Railway topology with a public web/API service, managed Postgres and Redis, and grouped market/outbox and financial workers. Readiness verifies fresh successful heartbeats for market, deposit, reconciliation, and settlement processing. Opening funding, the automated burner-wallet lifecycle, real settlement-to-claim, managed backup/PITR rehearsal, and external alerting remain incomplete.
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
- Add complete recovery for out-of-tolerance or invalid payments.

Exit criteria: stale quotes cannot activate, funds cannot be stranded, capacity cannot be oversold by concurrent requests, and every transition is idempotent.

## Phase 3: Settlement and Claims

- Separate payment-chain and Polymarket-settlement configuration.
- Freeze authority and per-leg source market, condition, token, outcome, index, snapshot, and neg-risk identity at activation.
- In supervised Sepolia, resolve only when Gamma and CLOB agree on immutable identity and a terminal outcome.
- Persist a candidate, wait the configured stability window, re-read both sources, and re-enforce candidate age inside PostgreSQL finalization.
- Retain Polygon CTF payout-vector resolution as a dormant, stricter authority for later review.
- Implement won-claimable, claim, lost, and void/refund flows.

Exit criteria: catalog mutation cannot change a ticket, one provider or one observation cannot pay a ticket, provider disagreement fails closed, replay cannot double-pay, and standard/neg-risk/50-50 fixtures settle according to policy.

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

## Mainnet Review

Immediately before mainnet, revisit and approve:

1. Production Safe threshold, owners, modules, limits, and emergency process.
2. Independent Polygon and Ethereum RPC providers.
3. Legal opinion, eligible jurisdictions, geo/access rules, terms, age controls, and sanctions policy.
4. External security review and remediation.
5. Backup restoration and incident exercises.
6. Mainnet bankroll, liability caps, reconciliation ownership, and daily close.
7. Invite cohort, support process, monitoring coverage, and rollback authority.

No mainnet payment route is enabled before this review is complete.
