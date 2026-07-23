# LEGWORK Architecture Decision Log

Status: Canonical
Last updated: 2026-07-14

## Accepted Decisions

### ADR-001: House-book Tickets

LEGWORK is the counterparty to its synthetic basket ticket. Polymarket markets are pricing and settlement inputs; a ticket is not a bundle of user-owned Polymarket tokens.

### ADR-002: USDC Payment Rail

Staging uses Circle Sepolia USDC. The planned beta uses Ethereum mainnet USDC. Payment-chain configuration is separate from Polymarket's Polygon settlement chain.

### ADR-003: Treasury Custody

User payments go to a Safe treasury and are represented in an internal double-entry LEGWORK ledger. Smart-contract escrow and automated hedging are deferred.

### ADR-004: Direct Payment With Bounded Repricing

There is no required prefunding step and no guaranteed price reservation. A user sends one exact USDC transfer. LEGWORK reprices after confirmation and automatically activates within a user-approved 50 basis point adverse limit. The payment request deadline is three minutes; submitted transactions are tracked for fifteen minutes. Failed activation preserves the full transfer in a recoverable state.

### ADR-005: Onchain Settlement Authority

Polygon mainnet CTF finality is authoritative. Gamma, CLOB, and WebSocket results are non-authoritative hints. Real-money settlement requires RPC quorum and an append-only proof.

### ADR-006: Void Policy

A final CTF 50/50, partial, unknown, or canceled leg voids the whole LEGWORK ticket. Stake is refunded and operation fees are retained. A dispute does not void a ticket until an onchain final result exists.

### ADR-007: Claim Before Withdrawal

Winning tickets become claimable. A user action moves winnings to available internal balance. Onchain withdrawal is a separate request and treasury process.

### ADR-008: Deterministic Risk Before AI

Launch risk uses source event identity, neg-risk groups, structured topics/entities, time windows, audited overrides, exposure limits, and capped adjustments. No AI model may autonomously price, block, settle, or move funds.

### ADR-009: Market Breadth With Eligibility

LEGWORK should show as many useful live markets as possible. Ended and non-tradable markets are hidden immediately. Severely weak markets are excluded through configurable liquidity/volume thresholds. Historical source records are retained for settlement and audit.

### ADR-010: Event-Grouped Catalog

Markets sharing a Polymarket event are displayed as one expandable event group. Top-level categories are stable product taxonomy; source tags and geographies remain secondary facets.

### ADR-011: Launch Sequence

The next target is supervised Sepolia staging. The following target is an invite-only Ethereum mainnet beta only after a dedicated mainnet gate review.

### ADR-012: Staging Price and Fee Policy

The staging basket spread starts at 7% and cannot exceed 12%. Explainable soft relationships can add at most five percentage points inside that limit. One pick per Polymarket event is allowed at launch. A hard-invalid or insufficiently understood relationship is unavailable rather than quoted with a worse spread. The operation fee is $0.50 per selected leg.

### ADR-013: Discovery Is Not A Quote

The persisted catalog is the searchable discovery index. Public market pages refresh their visible token IDs from CLOB, and checkout independently refreshes exact selected legs and stake depth. A broad catalog sweep is never treated as a live executable-price cache.

### ADR-014: Static Sepolia Treasury

The supervised staging Safe, Circle Sepolia USDC token, chain, and confirmation policy are deployment configuration. Runtime treasury mutation is disabled until authenticated operator roles and historical treasury-scope migration are approved.

### ADR-015: Bounded Catalog Persistence

The indexer observes the complete Polymarket sweep but stores a new market only after it passes launch eligibility. Previously stored markets continue to receive lifecycle updates even when they become ineligible. Each touched market retains its newest two unreferenced snapshots; every snapshot referenced by a quote or ticket is immutable and retained. This preserves automatic discovery and financial evidence without unbounded minute-by-minute catalog growth.

### ADR-016: Financial Worker Availability

Deposit, reconciliation, and settlement workers require both a fresh process heartbeat and a recent successful work cycle. Every process boot has a unique runtime instance ID and a database-issued monotonic generation, so a container restart must record a new successful cycle even if its numeric PID is reused, and delayed writes from an older process cannot reclaim health state. Each financial worker holds a PostgreSQL advisory-lock singleton lease for the life of its dedicated database session. Payment activation rechecks required worker health inside the activation transaction, and a transient worker outage leaves a confirmed payment retryable rather than releasing its accounting hold.

### ADR-017: One Owner Per Onchain Transfer

An exact USDC transfer identified by chain, transaction hash, and log index can fund either one user deposit or one supervised house-funding record, never both. Ownership is claimed atomically and deferred database constraints require every credited deposit or house-funding evidence row to have the matching immutable claim.

### ADR-018: Catalog Completion And Liveness

Catalog runtime health and catalog release completeness are separate signals. The current generation may progress while the timestamp of the last completed full sweep remains available. `/readyz` checks the worker process; `npm run qa:markets` additionally requires a recent completed sweep and recent current-generation progress before catalog release.

### ADR-019: Pointer-Based Discovery Reads

Each persisted market points to its latest catalog snapshot. Discovery ranks a bounded set of relational candidates before parsing snapshot JSON, and cursor pages reconstruct historical state only for markets that changed after the cursor was issued. The indexer and pointer backfill share an advisory lock so a deployment backfill cannot overwrite a newer snapshot pointer. This optimization applies only to discovery; visible prices and checkout still refresh independently from CLOB as required by ADR-013.

### ADR-020: Deferred Wallet Runtime

Anonymous browsing loads the market application without Privy, Viem, or wallet-provider code. The wallet runtime is loaded when a user selects Connect, or immediately for a returning browser with a prior wallet-session hint. Loading the runtime must not remount the basket, unsupported payment configuration must leave browsing available, and a wallet identity is considered synchronized only after the server accepts it.

### ADR-021: Local Sepolia State Isolation

Supervised local Sepolia staging uses a dedicated `legwork_sepolia_staging` PostgreSQL database and Redis logical database 1 on the existing loopback-only state containers. It never restores or copies development users, tickets, ledgers, deposits, or cache state. This is sufficient isolation for the single-machine supervised drill; hosted staging must use separately provisioned Postgres and Redis services.

## Deferred Decisions

- Staging and production hosting vendors
- Ethereum mainnet Safe owners, threshold, modules, and guards
- Mainnet RPC providers and secret manager
- Mainnet legal jurisdictions, geofencing, sanctions screening, and identity requirements
- Automatic hedging and smart-contract escrow
- Broader Portfolio redesign beyond claimable-ticket support

## Superseded Assumptions

- LEGWORK is no longer a frontend-only POC.
- A purchased quote is not fixed for twenty minutes.
- CLOB winner flags are not sufficient settlement proof.
- `SETTLEMENT_CHAIN_ID` cannot represent both USDC payment and Polymarket settlement.
- Relatedness is not inferred only from title keywords.
