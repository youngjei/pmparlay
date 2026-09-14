# LEGWORK LP Vault Transparency Standard

Status: Canonical publishing source
Last updated: 2026-09-12

This document defines what LEGWORK must disclose about the LP Vault, how each figure is calculated, and when the product must withhold a value. It is the source for future public documentation and LP Vault interface copy. It is not an offer to accept community capital.

## Current Stage

The current `LEGWORK LP Vault` is a founder-funded Sepolia shadow model using test USDC. Its product promise is: `Back LEGWORK tickets through a transparent, rolling economic NAV.` The page must pair that promise with one clear notice: `Founder-funded Sepolia shadow · Deposits unavailable`.

The shadow view observes the existing LEGWORK house book through a logical accounting scope in the staging treasury. It publishes verified aggregate economic NAV, share price, pending activation, estimated and finalized P&L, and unresolved-liability mark coverage. It does not accept community deposits, mint public LP shares, execute LP withdrawals, show personal balances, or advertise returns or APY.

The page may show shadow capital facts only when both evidence clocks pass independently. Reserve admission requires a confirmation-safe canonical block that matches the configured chain, treasury, and token, and whose source-evidence timestamp (`asOf`) is no more than five minutes old. `asOf` is the timestamp of the observed source block, not the later time at which the worker completed processing it (`processedAt`). The latest daily rolling-accounting checkpoint must be no more than 26 hours old, carry its own reconciliation and canonical-block evidence, and pass replay and arithmetic validation. The two records are not required to share a block because one is continuous reserve evidence and the other is a daily accounting close. Otherwise every financial amount is withheld as unavailable. A fresh reconciliation with a blocked operating gate remains visible with its warning; bad news must not disappear from the transparency record.

## Capital Definitions

All canonical calculations use integer micro-USDC. Decimal dollar values are display formatting only.

- `Reconciled assets`: confirmed USDC held by the configured treasury at the displayed canonical block.
- `Senior user obligations`: available user balances, claimable winnings, checkout balances, and pending user withdrawals. These claims are senior to LP capital.
- `Gross unresolved payouts`: the sum of the full offered payouts for every unresolved house-book ticket. It equals open stakes plus reserved net liability. No correlation or expected-win discount is applied.
- `Reserved for open positions`: the net amount the house must contribute above the stakes already received if every unresolved ticket wins.
- `Hard solvency floor`: senior user obligations plus gross unresolved payouts.
- `Capital above solvency floor`: reconciled assets minus the hard solvency floor. A negative value blocks financial operations.
- `25% coverage buffer`: gross unresolved payouts multiplied by 25%, rounded up to the next micro-USDC.
- `Pending basket capacity`: the additional house capital and 25% buffer reserved for payment intents awaiting payment or activation. For each pending intent with maximum payout `P` and expected stake `S`, the charge is `max(ceil(125% * P) - S, 0)`. Each intent is rounded independently before the charges are summed.
- `Shadow operating reserve floor`: hard solvency floor plus the 25% live-ticket coverage buffer and pending basket capacity. The current API field retains the implementation name `operatingWithdrawalFloorUsd`, but the public shadow label must not imply that LP withdrawals are live.
- `Capacity above reserve floor`: the greater of zero and reconciled assets minus the shadow operating reserve floor. In shadow mode this is an observable underwriting-capacity figure, not LP NAV, redemption liquidity, or a promise that it can be withdrawn.
- `Gross coverage ratio`: reconciled assets after senior user obligations, divided by gross unresolved payouts. It is unavailable when there are no unresolved payouts.
- `Custody delta`: reconciled treasury assets minus the internal custody ledger. Any unexplained difference is shown and restricts or blocks operations according to the financial gate.

The absolute invariant is:

```text
treasury assets >= senior user obligations + 100% of gross unresolved payouts
```

The production policy for new underwriting and eligible LP redemption execution uses the stricter invariant:

```text
treasury assets after the action
  >= senior user obligations
     + ceil(125% of gross unresolved payouts)
     + pending basket capacity
```

The future execution check must include pending ticket payment reservations and run against one locked canonical book version. The current shadow stage publishes this calculation but does not authorize customer quotes or LP transfers from it. A displayed surplus is never sufficient authorization to transfer funds.

## Rolling Accounting And Future Withdrawal Policy

The deterministic rolling accounting foundation is implemented for founder shadow verification. Community deposits, wallet-owned LP shares, redemption requests, payables, and transfers are not live.

### Deposit And Share Accounting

A confirmed eligible deposit enters dedicated custody immediately. Custody does not imply immediate participation: the amount remains in a pending-deposit account and takes no vault P&L until the next canonical daily cycle at 00:00 UTC. At that cycle, after exact reconciliation, the deposit receives fixed non-transferable shares using the canonical pre-deposit economic-NAV share price. Economic NAV includes conservative current liability marks for unresolved tickets. Using the price before adding the deposit prevents the entrant from inheriting pre-entry P&L and prevents dilution of incumbent shares. Share quantity does not rebase or transfer between wallets. The USDC value represented by each share floats with economic NAV.

Economic NAV and share value combine settlement-finalized P&L with conservative current marks for unresolved liabilities. A displayed share value that can still change with unresolved marks must be labeled `Estimated`, with the mark method and timestamp disclosed. Only authoritative ticket settlements change `Finalized P&L`. A 00:00 UTC cycle creates a canonical price for deposit accounting, but that event does not make unresolved P&L or the whole share value finalized. Estimated P&L cannot establish a guaranteed return.

### FIFO Admission And 72-Hour Redemption

An LP submits an idempotent withdrawal request for a fixed share amount. The request receives an immutable FIFO sequence but does not reserve liquidity, freeze its USDC value, burn shares, or remove the LP from P&L. Queued shares remain active and continue to back new tickets.

The oldest queued request is considered only when the frequent reconciliation worker creates a new canonical custody snapshot under the exclusive financial lock. The latest daily checkpoint supplies the share price; the new reconciliation supplies current assets, obligations, live-ticket exposure, pending-basket capacity, and breaker state. Admission records both sources and proceeds only when sufficient redemption liquidity can be reserved separately while preserving senior user obligations and the 125% operating floor. A later smaller request cannot bypass an earlier larger request. If the head request cannot be admitted, it remains waiting without changing priority.

Admission starts a 72-hour redemption period. Throughout the period, the requested shares remain active: they participate in dynamic estimated marked P&L, settlement-finalized P&L, and new exposure accepted by the rolling vault. There is no value snapshot at request or admission. At the end of 72 hours, the system locks the latest eligible reconciled canonical economic-NAV share price and makes it binding for that redemption. It determines the USDC amount with deterministic micro-USDC rounding, burns the requested shares, and creates the payable atomically. Binding the price for the burn does not imply that unresolved-ticket P&L inside economic NAV is finalized. Payment rechecks custody and the operating floor under a database lock. A failed check pauses payment for incident response without restoring an earlier price or silently changing FIFO priority.

### Value Versus Liquidity

`Economic NAV` is the canonical marked economic value attributable to all active shares. It combines settlement-finalized P&L with conservative liability marks for unresolved tickets, so it is not described as wholly finalized while those tickets exist. `Share price` is economic NAV divided by active shares using the approved deterministic rounding rule. A price may be canonical and binding for a specific mint or burn even though unresolved P&L within it remains estimated. `Reserved redemption liquidity` is cash capacity set aside after FIFO admission to support redemptions. These are separate ledger measures: reserving liquidity changes deployable capacity, but it is not profit, is not added to economic NAV, and does not by itself fix the redemption amount before the 72-hour period ends.

## Public Evidence

Every available financial snapshot must publish:

- network, chain ID, currency, token address, and treasury address;
- source-evidence `asOf` and worker `processedAt`; enforce the five-minute reserve and 26-hour accounting freshness limits defined above;
- canonical block number and block hash;
- the current shadow capital definitions above;
- custody delta and financial gate state;
- accounting scope, including whether values are global house-book observations or vault-attributed records.

Treasury, token, and block values link to the appropriate block explorer. Historical snapshots will be append-only once vault-specific reconciliation is implemented. Public aggregate statistics must not expose a wallet's private queue or eligibility information.

## Future Dashboard Gates

The following sections appear only after canonical systems exist behind them:

- Community deposit action: legal eligibility, dedicated custody, transfer ownership, deposit confirmation, and unit minting must all be live.
- LP position: canonical fixed shares, activation cycle, contributed capital, economic-NAV/share-price timestamp, estimated marked P&L, finalized settlement P&L, and redemption status must be replayable from append-only records.
- Performance: estimated P&L must be visibly distinct from settlement-finalized P&L. A daily cycle creates a canonical accounting checkpoint; it does not finalize unresolved outcomes. No projected APY, expected spread revenue, or smoothed value.
- Portfolio risk: exact-basket concentration, event and factor exposure, maturity, settlement authority, scenario loss, reserve utilization, and policy hash.
- Withdrawal queue: aggregate requested shares, queue depth, oldest request age, admitted amount, reserved redemption liquidity, redemption periods ending, and fulfilled amount. Wallet-level details are shown only to the authenticated owner.
- Governance: Safe owners and threshold, current policy hash, breaker state, approved changes, and independent audit reports when available.

## Publishing Rules

- Use `Unavailable`, never `$0`, when a required source is absent, stale, malformed, untrusted, or scoped incorrectly.
- Separate testnet, founder shadow, founder mainnet, and community-capital states visibly.
- Do not call capital above a reserve floor `NAV`, `available balance`, `reserved redemption liquidity`, or `guaranteed liquidity`.
- When community accounting exists, label P&L from unresolved marks `Estimated` and P&L from authoritative settlements `Finalized`; publish the applicable cycle, mark method, and timestamp.
- Do not label economic NAV or share price `Finalized` merely because a daily cycle closed. Use `Canonical` or `Binding for this mint/burn` when those statements are true, while preserving the estimated label for unresolved P&L.
- Publish economic NAV and reserved redemption liquidity as separate figures with separate formulas; never sum them or use one as a synonym for the other.
- Do not describe the vault as insured, risk-free, autonomous, AI-managed, or permissionless.
- Explain losses, delays, disputes, gate restrictions, and custody differences with the same prominence as positive performance.
- Keep calculations reproducible from published definitions and source-linked evidence.
