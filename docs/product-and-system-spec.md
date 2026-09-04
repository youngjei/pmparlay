# LEGWORK Product and System Specification

Status: Canonical
Last updated: 2026-09-04

This document defines the product and system behavior. When older planning documents disagree with it, this document and the architecture decision log take precedence.

## Product Thesis

LEGWORK lets a user combine outcomes from separate prediction markets into one fixed-payout basket, subject only to its published void-leg policy. Polymarket supplies market discovery, pricing inputs, rules, and settlement results. LEGWORK creates a separate house-book ticket, holds the user's USDC, manages the resulting liability, and pays the ticket according to its recorded terms.

LEGWORK is not a Polymarket order router. A LEGWORK ticket does not create or custody Polymarket outcome tokens unless a later hedging system explicitly does so.

## Launch Scope

- Supervised staging uses Sepolia USDC and the configured Sepolia Safe.
- Settlement uses stable, matching terminal results from Polymarket's Gamma and CLOB APIs.
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

Once a valid ticket activates, it is final. The user cannot cancel it, cash it out, or request a discretionary refund. Recovering a transfer that never activated a valid ticket is a payment correction, not a ticket refund.

## Settlement Authority

LEGWORK accepts Polymarket's offchain API as the settlement authority. This is an explicit trust dependency: LEGWORK does not claim that its settlement result is independently proven onchain. A WebSocket resolution event may update UX or wake the settlement worker, but it cannot authorize a payout by itself.

Each ticket leg freezes its Polymarket market ID, condition ID, selected token ID, selected outcome and index, event and neg-risk identity, source rules, and source snapshot at activation.

Finalization requires Gamma and CLOB to match the frozen identity and agree on a terminal result. The worker persists a candidate, waits the configured stability window, and re-reads both REST sources before finalizing. The database re-enforces candidate age and idempotency inside the finalization transaction. Missing, malformed, stale, or contradictory evidence leaves the leg pending and its liability fully reserved. Every observation and accepted result is append-only and replayable.

A terminal result matching the selected outcome wins; the opposing result loses. A final Polymarket 50/50, unknown, or canceled result voids only that leg. The ticket payout is recalculated from the remaining legs' frozen quote inputs and policy version, never from current prices. If all legs are voided, the stake is returned and operation fees are retained. A proposed, non-terminal, or disputed market remains pending.

The staging quote policy starts at a 7% basket spread and has a published 12% maximum. Explainable soft relationships may add at most five percentage points. A hard-invalid or unpriceable relationship is unavailable instead of receiving a punitive quote.

## Ticket and Claim Lifecycle

The user-visible terminal paths are:

- `confirming -> repricing -> live -> claimable -> paid` for a winning ticket;
- `confirming -> repricing -> live -> lost` when any leg loses; and
- `confirming -> repricing -> live -> voided` when every leg voids, with stake returned automatically to available balance.

A voided leg in a ticket with another winning leg does not terminate the ticket. Its frozen quoted price reduces the original offered payout; current market prices are never used. The deterministic calculation floors once after applying every void factor and never returns less than the original stake for a winning reduced ticket. All-void tickets return stake automatically and retain operation fees, so they do not enter the winnings claim flow.

The accepted stake, fee, payout, reserve liability, and price for every ticket leg are immutable database records. Settlement uses those accepted records, not the current catalog or a mutable quote. A legacy ticket touched by the superseded whole-ticket void policy is excluded from claims until a supervised reconciliation resolves its quarantine.

Claims are explicit and idempotent. Claiming moves the ticket's winnings from claimable liability to the user's available LEGWORK balance. An onchain withdrawal is a separate treasury action.

## Treasury and Ledger

The internal ledger is double-entry and denominated in USDC. Onchain transfers, ticket stakes, operation fees, reserves, claims, all-void stake returns, payment recoveries, and withdrawals each have distinct accounts and immutable transaction identifiers.

The treasury Safe is custody, not the ledger. Scheduled reconciliation must prove that onchain assets cover user balances, pending withdrawals, open stakes, and ticket reserves. An unexplained difference pauses new purchases and withdrawals until reviewed.

Sepolia may use the existing 1-of-1 Safe under supervision. Its Safe, token, chain, and confirmation policy are static deployment configuration; runtime treasury rotation is disabled until operator identities and historical-scope migration are production-ready. Ethereum mainnet requires a stronger multisig policy approved during the mainnet readiness review.

## LP Vault

The LP Vault lets eligible liquidity providers fund a defined cohort of LEGWORK house-book liabilities and participate pro rata in the cohort's realized underwriting result. The first implementation is founder-funded Sepolia shadow accounting, not a public investment product.

The approved community design will use one non-overlapping epoch that accepts capital during a 72-hour funding window, then locks funding while it underwrites eligible baskets. Vault-backed markets may mature no later than 30 days after underwriting begins. An epoch will enter runoff when underwriting closes and will not execute redemptions until every attributed ticket is final, temporary exposure reservations are zero, custody reconciles exactly, and no relevant incident is open. A disputed source market will remain pending until authoritative resolution. LPs will be able to submit an idempotent withdrawal request earlier, but it will only join the epoch's next eligible liquidity window; it will not burn units or create a payable obligation before finalization. None of these community unit or redemption flows exists in the current shadow stage.

The hard solvency floor is senior user obligations plus 100% of every unresolved ticket's offered payout. Treasury assets may never fall below it. The production policy will preserve a stricter 125% gross payout coverage floor for new underwriting and LP redemption execution and will reserve additional capacity for each basket awaiting payment or activation. The founder Sepolia shadow stage calculates and publishes these limits but does not yet use them to authorize customer quotes. At epoch close, final economics and requested redemption entitlements will be calculated pro rata across participation units with deterministic rounding. Every approved payable will then be created simultaneously and sent FIFO by immutable sequence. Smallest-first will not be used because splitting a request could buy priority. If all post-settlement payables cannot be funded, the queue will pause for incident response instead of changing LP entitlements. Ticket winners and all other user obligations will remain senior to every LP withdrawal.

User liabilities are senior. Permitted, capped direct vault expenses follow. Founder and LP capital participate pari passu in the residual realized result. The protocol retains the $0.50 per-leg operation fee and charges no performance fee during the pilot. No quoted spread or unresolved-ticket estimate is presented as realized profit.

Founder-funded Sepolia shadow mode may use a logical subledger in the staging Safe. Community capital requires dedicated vault custody, allowlisted eligibility, authenticated dual-control operations, separate risk and custody breakers, approved legal access rules, and independent security, accounting, and quantitative review.

The LP Vault page prioritizes the current LP action and immediately follows it with source-linked transparency. It shows only fresh reconciled figures such as assets, senior user obligations, gross unresolved payouts, reserved capital, hard solvency floor, 25% operating buffer, withdrawal floor, capital above that floor, custody difference, gate state, and canonical block evidence. Stale or unsupported values are unavailable rather than zero. APY, projected return, interim LP NAV, instant withdrawals, and automated AI management are not shown unless later systems make those statements true.

## Operational Standard

Financial mutations are idempotent, audited, and protected by database constraints. Production operations use authenticated roles rather than caller-supplied identities. Sensitive actions require dual control. Runtime kill switches can stop new quotes, purchases, withdrawals, or settlement without stopping deposit observation and reconciliation.

Mainnet legal, access, treasury, security, and operational gates are maintained in the production roadmap and must be reviewed immediately before mainnet deployment.
