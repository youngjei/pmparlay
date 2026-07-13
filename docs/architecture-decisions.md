# LEGWORK Architecture Decision Log

Status: Canonical
Last updated: 2026-07-13

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
