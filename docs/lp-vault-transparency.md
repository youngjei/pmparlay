# LEGWORK LP Vault Transparency Standard

Status: Canonical publishing source
Last updated: 2026-09-04

This document defines what LEGWORK must disclose about the LP Vault, how each figure is calculated, and when the product must withhold a value. It is the source for future public documentation and LP Vault interface copy. It is not an offer to accept community capital.

## Current Stage

The current LP Vault is a founder-funded Sepolia shadow model using test USDC. It observes the existing LEGWORK house book through a logical accounting scope in the staging treasury. It does not accept community deposits, mint LP units, execute LP withdrawals, calculate LP NAV, or advertise returns.

The page may show shadow capital facts only when they come from the latest trusted worker reconciliation, match the configured chain, treasury, token, block number, and block hash, and are no more than five minutes old. Otherwise every financial amount is withheld as unavailable. A fresh reconciliation with a blocked operating gate remains visible with its warning; bad news must not disappear from the transparency record.

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
- `Withdrawal protection floor`: hard solvency floor plus the 25% live-ticket coverage buffer and pending basket capacity.
- `Capital above withdrawal floor`: the greater of zero and reconciled assets minus the withdrawal protection floor. In shadow mode this is an observable capacity figure, not LP NAV or a promise that it can be withdrawn.
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

## Approved Future Epoch And Withdrawal Policy

The following policy is approved but not implemented in the founder shadow stage. There are no community LP units, redemption requests, payables, or transfers yet.

The pilot uses one fixed, non-overlapping cohort at a time. Capital enters during a 72-hour funding window and may underwrite markets with no more than 30 days to maturity. No LP units are minted after underwriting begins.

Once community participation is implemented, an LP may submit an idempotent withdrawal request while an epoch is active. The request will record priority only: it will not burn units, create a payable liability, or permit capital to escape unresolved results. The request will become eligible only after the epoch is final, all attributed tickets and payment reservations are final, custody reconciles, and no relevant incident is open.

At epoch close, final economics and requested redemption entitlements will be calculated pro rata across participation units with deterministic largest-remainder rounding. All approved payables will be created simultaneously, then sent FIFO by immutable sequence. Smallest-first is prohibited because an LP could split one redemption into many small requests to buy priority. Every transfer will recheck the operating floor under a database lock. If all approved post-settlement payables cannot be funded, the queue will pause for custody, reconciliation, or solvency incident response; LEGWORK will not silently change economic entitlements through payment order.

A disputed market can keep an epoch in runoff without a promised unlock date. LEGWORK follows the authoritative source result and does not invent a settlement to release LP funds.

## Public Evidence

Every available financial snapshot must publish:

- network, chain ID, currency, token address, and treasury address;
- reconciliation timestamp and maximum freshness policy;
- canonical block number and block hash;
- the capital definitions above;
- custody delta and financial gate state;
- accounting scope, including whether values are global house-book observations or vault-attributed records.

Treasury, token, and block values link to the appropriate block explorer. Historical snapshots will be append-only once vault-specific reconciliation is implemented. Public aggregate statistics must not expose a wallet's private queue or eligibility information.

## Future Dashboard Gates

The following sections appear only after canonical systems exist behind them:

- Community deposit action: legal eligibility, dedicated custody, transfer ownership, deposit confirmation, and unit minting must all be live.
- LP position: canonical units, epoch attribution, contributed capital, realized P&L, and redemption status must be replayable from append-only records.
- Performance: only finalized epoch returns and losses may be shown. No projected APY, expected spread revenue, or smooth interim NAV.
- Portfolio risk: exact-basket concentration, event and factor exposure, maturity, settlement authority, scenario loss, reserve utilization, and policy hash.
- Withdrawal queue: aggregate eligible amount, queue depth, oldest eligible request age, fulfilled amount, and current executable capacity. Wallet-level details are shown only to the authenticated owner.
- Governance: Safe owners and threshold, current policy hash, breaker state, approved changes, and independent audit reports when available.

## Publishing Rules

- Use `Unavailable`, never `$0`, when a required source is absent, stale, malformed, untrusted, or scoped incorrectly.
- Separate testnet, founder shadow, founder mainnet, and community-capital states visibly.
- Do not call capital above a reserve floor `NAV`, `available balance`, or `guaranteed liquidity`.
- Do not describe the vault as insured, risk-free, autonomous, AI-managed, or permissionless.
- Explain losses, delays, disputes, gate restrictions, and custody differences with the same prominence as positive performance.
- Keep calculations reproducible from published definitions and source-linked evidence.
