# LEGWORK Architecture Decision Log

Status: Canonical
Last updated: 2026-09-10

## Accepted Decisions

### ADR-001: House-book Tickets

LEGWORK is the counterparty to its synthetic basket ticket. Polymarket markets are pricing and settlement inputs; a ticket is not a bundle of user-owned Polymarket tokens.

### ADR-002: USDC Payment Rail

Staging uses Circle Sepolia USDC. The planned beta uses Ethereum mainnet USDC. Payment-chain configuration is separate from Polymarket's Polygon settlement chain.

### ADR-003: Treasury Custody

User payments go to a Safe treasury and are represented in an internal double-entry LEGWORK ledger. Smart-contract escrow and automated hedging are deferred.

### ADR-004: Direct Payment With Bounded Repricing

There is no required prefunding step and no guaranteed price reservation. A user sends one exact USDC transfer. LEGWORK reprices after confirmation and automatically activates within a user-approved 50 basis point adverse limit. The payment request deadline is three minutes; submitted transactions are tracked for fifteen minutes. Failed activation preserves the full transfer in a recoverable state.

### ADR-005: Polymarket API Settlement Authority

LEGWORK accepts Polymarket's offchain API as the production settlement authority. A WebSocket resolution event may wake the settlement worker, but it cannot finalize a leg by itself. Finalization requires the frozen market identity to match and Polymarket Gamma and CLOB REST responses to agree on a terminal result across the configured stability window. Unavailable, malformed, stale, or contradictory responses fail closed and retain the ticket's liability reserve. Every candidate, observation, accepted result, and state transition is append-only and replayable. Polygon CTF verification is an optional future defense-in-depth adapter, not a production prerequisite.

### ADR-006: Void Policy

A final Polymarket 50/50, unknown, or canceled result voids only the affected leg. The ticket continues using the remaining legs and their frozen quote inputs; it is never repriced from current market prices. The final payout is the original offered payout multiplied by each voided leg's frozen quoted price, with one final integer floor and a stake floor for a winning reduced ticket. If every leg is voided, the stake is returned automatically to available balance and operation fees are retained. A proposed or disputed result remains pending until Polymarket reports a stable terminal result. The final calculation and ledger transaction references are stored in an append-only ticket settlement summary.

Accepted stake, fee, offered payout, reserve liability, and per-leg prices are frozen at ticket creation and protected by PostgreSQL immutability triggers. Settlement reads the ticket reserve and accepted ticket-leg prices rather than mutable discovery or quote data. Pre-hardening tickets containing any void result without a final settlement summary are quarantined for supervised reconciliation and cannot appear in the claim queue.

An activated ticket is otherwise final: the user cannot cancel it, cash it out, or request a discretionary refund. Transfers that never activate a valid ticket, including duplicate, partial, late, unsupported-token, and overpayment cases, remain recoverable payment failures rather than ticket refunds.

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

### ADR-022: Rolling LP Vault Cycles

The approved LP Vault is continuous rather than a sequence of fixed cohorts. A deposit enters dedicated custody immediately but remains pending P&L until the next daily cycle at 00:00 UTC. At that boundary it receives fixed, non-transferable shares using the canonical pre-deposit economic-NAV share price, including conservative current liability marks. This prevents the entrant from inheriting prior P&L or diluting incumbent shares. Share quantity does not rebase; its USDC value floats with economic NAV. The daily boundary is an accounting checkpoint, not a funding window, lockup epoch, or promise of liquidity.

### ADR-023: LP Waterfall And Pilot Economics

User balances, claims, refunds, gross unresolved payouts, and pending user withdrawals are senior to vault capital. Explicitly permitted and capped direct vault expenses follow. Founder and LP shares participate pari passu in the remaining underwriting result. The protocol retains the $0.50 per-leg operation fee and charges no performance fee during the pilot. P&L from unresolved liability marks is estimated, and the resulting economic-NAV share value can change before settlement. Quoted spread and unresolved outcomes are never finalized profit. Only authoritative ticket settlements change finalized P&L; a daily cycle may make its canonical economic-NAV price binding for a mint or burn without claiming that all underlying P&L is finalized.

### ADR-024: Shadow First, Dedicated Community Custody Later

Founder-funded Sepolia shadow accounting may use a logically separate vault subledger within the existing staging Safe. This is not community custody, public LP NAV, or redemption liquidity. Community capital requires a dedicated vault Safe, explicit deposit and redemption transfers, vault-scoped reconciliation, authenticated roles, real dual control, independent review, and approved legal access rules.

### ADR-025: Deterministic Vault Risk And Full Reserves

The vault gives no diversification or hedge credit unless a deterministic scenario engine proves an offset over logically valid outcomes. Every ticket retains its full net-liability reserve. Production underwriting will enforce at least 125% gross coverage and the lower of fixed launch limits and approved economic-NAV-based limits across tickets, exact baskets, market outcomes, canonical events, relationship factors, categories, maturities, and settlement authorities. Queued and admitted redemptions remain active exposure during their 72-hour redemption period, so their shares continue to participate in new underwriting and dynamic P&L until end-of-period valuation and burn. The current founder-funded Sepolia stage calculates and publishes reserve policy in shadow mode but does not yet use it to authorize customer quotes. Unsupported relationships will be unavailable rather than priced by an autonomous model or punitive spread. AI remains advisory-only.

### ADR-026: LP Transparency Is A Product Requirement

The LP Vault surface is titled `LEGWORK LP Vault` and promises: `Back LEGWORK tickets through a transparent, rolling economic NAV.` In shadow mode it presents one unambiguous notice: `Founder-funded Sepolia shadow · Deposits unavailable`. It leads with verified assets, payout coverage, and collateral state, then shows rolling economic NAV, share price, pending activation, estimated and finalized P&L, and liability-mark coverage without duplicating collateral health. Public amounts require two independently current, correctly scoped records: a five-minute reserve reconciliation and a daily accounting checkpoint valid for up to 26 hours. Each retains its own reconciliation and canonical-block evidence; they need not share a block. Stale, absent, malformed, untrusted, or unsupported values display as unavailable rather than zero. The product does not show public funding actions, personal balances, returns, APY, or projected yield before canonical community systems exist.

### ADR-027: Full Collateral And Liquidity-Gated Rolling Redemptions

At every canonical book version, the hard solvency floor is `senior user obligations + gross unresolved offered payouts`. Treasury assets may never be reduced below that floor. The production policy uses a stricter operating floor of `senior user obligations + ceil(125% * gross unresolved offered payouts) + pending basket capacity` for new underwriting and redemption-liquidity decisions. For each pending basket with maximum payout `P` and expected stake `S`, its capacity charge is `max(ceil(125% * P) - S, 0)`; each charge is rounded independently before the charges are summed. Capital above the operating floor is underwriting capacity, not guaranteed redemption liquidity or vault NAV. Canonical economic NAV and separately reserved redemption liquidity are distinct ledger measures and must never be added together or presented as the same balance. The current shadow stage publishes the reserve calculation but does not use it to authorize customer quotes or LP transfers.

The approved production withdrawal policy requires idempotent, append-only requests and FIFO admission by immutable request sequence. A request first queues without reserving liquidity; the LP and all requested shares remain active and continue to take P&L and new exposure. Daily 00:00 UTC cycles remain the NAV and share-price authority, but admission is attempted only inside the frequent reconciliation worker's exclusive financial transaction. That transaction uses a newly created, correctly scoped, canonical reconciliation to prove sufficient separately reserved redemption liquidity while preserving senior obligations, the 125% live-ticket floor, and pending-basket capacity. The reconciliation and immutable daily checkpoint are both recorded on the reserve. Smallest-first skipping is prohibited because request splitting must not buy priority.

Admission starts a 72-hour redemption period. During that period the requested shares remain active, their USDC value is dynamic, and they continue to participate in estimated marked P&L, settlement-finalized P&L, and newly accepted exposure. At the end, the canonical economic-NAV share price from a locked reconciled book becomes binding for that burn and payable; unresolved-ticket P&L within the price remains estimated. Only then are the fixed shares burned and a payable created. A failed custody, reconciliation, or solvency check pauses admission or payment for incident response without changing queue priority or backdating value. User balances, claims, refunds, unresolved payouts, and user withdrawals remain senior to the entire future LP queue. The accounting foundation is exercised in founder shadow mode; public requests, burns, payables, and transfers remain disabled.

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
- Polygon CTF reads and RPC quorum are not required by the approved settlement trust model.
- A single CLOB winner flag or WebSocket event is not sufficient settlement evidence.
- A void leg does not automatically void the whole ticket.
- `SETTLEMENT_CHAIN_ID` cannot represent both USDC payment and Polymarket settlement.
- Relatedness is not inferred only from title keywords.
- The LP Vault is not organized as serial fixed cohorts with funding, runoff, and final epoch redemption windows.
- A queued or admitted LP redemption does not freeze share value or remove the shares from P&L and new exposure before the 72-hour period ends.
