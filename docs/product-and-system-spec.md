# LEGWORK Product and System Specification

Status: Canonical
Last updated: 2026-07-13

This document defines the product and system behavior. When older planning documents disagree with it, this document and the architecture decision log take precedence.

## Product Thesis

LEGWORK lets a user combine outcomes from separate prediction markets into one fixed-payout basket. Polymarket supplies market discovery, pricing inputs, rules, and onchain resolution. LEGWORK creates a separate house-book ticket, holds the user's USDC, manages the resulting liability, and pays the ticket according to its recorded terms.

LEGWORK is not a Polymarket order router. A LEGWORK ticket does not create or custody Polymarket outcome tokens unless a later hedging system explicitly does so.

## Launch Scope

- Supervised staging uses Sepolia USDC and the configured Sepolia Safe.
- Settlement reads Polymarket outcomes from Polygon mainnet because that is where the source markets resolve.
- The next real-money launch is an invite-only Ethereum mainnet beta.
- No automatic hedging is part of the initial launch.
- Supervised beta limits are $5 maximum stake, $50 maximum gross payout, $100 maximum exposure per user, and $250 maximum exposure per market or event.

## Primary User Journey

1. Connect a wallet through Privy.
2. Browse eligible, live Polymarket event groups.
3. Expand an event group and select a Yes or No outcome.
4. Build a basket and enter a stake.
5. Review the estimated payout, fees, price-movement limit, and source-market rules.
6. Approve one direct USDC transfer to the LEGWORK treasury Safe.
7. Watch the purchase move through submitted, confirming, and repricing states.
8. Receive an activated ticket or a recoverable payment state.
9. Track every leg in Portfolio.
10. Claim a winning ticket into the user's available LEGWORK balance.
11. Request an onchain withdrawal to the connected wallet.

## Market Catalog

The public catalog must maximize useful market coverage without showing markets that cannot support a trustworthy ticket.

Discovery and quoteability are separate. The background sweep maintains searchable lifecycle, identity, grouping, volume, and liquidity metadata. Every visible API page refreshes its candidate token IDs from the CLOB before returning current prices, and checkout refreshes the selected legs again for the requested stake. Unknown lifecycle fields, missing CTF condition IDs, missing books, stale books, or insufficient executable depth fail closed for public quoteability.

A market is hidden when it is ended, closed, archived, inactive, missing an enabled order book, no longer accepting orders, severely illiquid, or backed by stale source metadata. Date-based removal does not wait for a cleanup job: once `end_date <= now`, the market is no longer public.

Historical market, outcome, rules, and identifier records are retained for tickets and audits. Hiding a market is not the same as deleting its settlement evidence.

Markets are grouped by Polymarket event identity and event slug. An event such as "Who will win the World Cup?" is one expandable catalog item containing its candidate-specific binary markets.

The canonical taxonomy is intentionally small and stable:

- Politics
- Sports
- Crypto
- Finance and Economy
- Technology and Science
- Culture and Entertainment
- World and Weather
- Other

Source tags remain available as secondary metadata. `Bitcoin` is a Crypto topic, not a top-level category; `US` is a geography, not a category.

## Relatedness and Correlation

Relatedness is an explainable graph, not an AI judgment.

- Hard relationship: same Polymarket event, same neg-risk group, mutually exclusive outcome set, or logically contradictory token selection.
- Soft relationship: shared asset, team, candidate, competition, election, geography, topic, or overlapping resolution window.
- Manual override: an audited operator rule can add or remove a relationship when source metadata is insufficient.

Hard-invalid combinations are blocked. Soft relationships feed a capped risk adjustment and exposure aggregation. Every adjustment must identify the relationship that caused it. The system must not silently increase spreads based on opaque text similarity.

## Quote and Direct Payment

The initial quote is a 15-second estimate, not a guaranteed reservation. The wallet payment request remains open for three minutes. Once a transaction hash is submitted, LEGWORK tracks it for fifteen minutes and continues reconciling any later confirmed transfer.

The user approves:

- exact USDC amount;
- stake and a $0.50 operation fee per leg;
- treasury, token, chain, and source wallet;
- estimated payout; and
- minimum acceptable payout based on a 50 basis point adverse-movement limit.

Creating a payment request places a temporary exposure reservation. After a confirmed transfer, LEGWORK fetches current order-book depth, confirms every leg is still tradable, creates an immutable final quote, and reruns risk and exposure checks.

If the final payout is within the approved limit, the ticket activates automatically. Favorable price improvement is passed through when absolute payout and exposure limits allow it.

If automatic activation is impossible, the full transfer enters a recoverable state. The user can accept a new payout or withdraw. Market closure, excessive price movement, partial payment, overpayment, duplicate payment, a late transfer, or a temporary service failure must never strand funds.

## Settlement Authority

Polymarket's Polygon Conditional Tokens contract is the source of truth for final outcomes. Gamma, CLOB, and WebSocket data may update UX or wake the settlement worker but cannot authorize a payout.

Each ticket leg freezes its Polygon chain ID, CTF contract, condition ID, selected token ID, selected outcome index, outcome-slot count, collateral token, neg-risk metadata, source rules, and source snapshot at activation.

Settlement reads the full payout vector at a Polygon finalized block. Real-money operation requires independent RPC providers to agree on the block and payout vector. Every observation and accepted proof is append-only and replayable.

A selected numerator of zero loses. A full selected numerator wins. A final 50/50, partial, unknown, or canceled result voids the whole LEGWORK ticket: stake is refunded and operation fees are retained. A disputed market remains pending until CTF is final.

The staging quote policy starts at a 7% basket spread and has a published 12% maximum. Explainable soft relationships may add at most five percentage points. A hard-invalid or unpriceable relationship is unavailable instead of receiving a punitive quote.

## Ticket and Claim Lifecycle

The user-visible lifecycle is:

`confirming -> repricing -> live -> won_claimable | lost | voided -> paid | refunded`

Claims are explicit and idempotent. Claiming moves the ticket's winnings from claimable liability to the user's available LEGWORK balance. An onchain withdrawal is a separate treasury action.

## Treasury and Ledger

The internal ledger is double-entry and denominated in USDC. Onchain transfers, ticket stakes, operation fees, reserves, claims, refunds, and withdrawals each have distinct accounts and immutable transaction identifiers.

The treasury Safe is custody, not the ledger. Scheduled reconciliation must prove that onchain assets cover user balances, pending withdrawals, open stakes, and ticket reserves. An unexplained difference pauses new purchases and withdrawals until reviewed.

Sepolia may use the existing 1-of-1 Safe under supervision. Its Safe, token, chain, and confirmation policy are static deployment configuration; runtime treasury rotation is disabled until operator identities and historical-scope migration are production-ready. Ethereum mainnet requires a stronger multisig policy approved during the mainnet readiness review.

## Operational Standard

Financial mutations are idempotent, audited, and protected by database constraints. Production operations use authenticated roles rather than caller-supplied identities. Sensitive actions require dual control. Runtime kill switches can stop new quotes, purchases, withdrawals, or settlement without stopping deposit observation and reconciliation.

Mainnet legal, access, treasury, security, and operational gates are maintained in the production roadmap and must be reviewed immediately before mainnet deployment.
