# LEGWORK LP Vault Roadmap

Status: Canonical
Last updated: 2026-09-04

The LP Vault is intended to let eligible liquidity providers fund LEGWORK's house-book liabilities and participate in realized underwriting results. It is not a generic yield account, a continuously redeemable ERC-4626 vault, or an automated AI-managed fund.

The first safe product is one founder-funded Sepolia shadow vault with one fixed, non-overlapping epoch. Community deposits remain disabled until accounting, risk, custody, governance, legal, and independent-review gates pass.

## Product Boundary

- One vault, one active epoch, one capital class.
- Funding closes before an epoch starts underwriting.
- Capital remains locked until every attributed ticket reaches final settlement and the closing balance sheet reconciles.
- Once community flows exist, a withdrawal request may join the queue during an epoch, but no units will burn and no capital will leave until that epoch is final and the request passes the execution-time solvency check.
- No mid-epoch minting, redemption execution, transfer, rollover, or guaranteed unlock date.
- No APY, projected return, smooth interim NAV, or "house-edge yield" claim.
- User balances, claims, refunds, and pending withdrawals remain senior to LP capital.
- Sepolia shadow mode uses test USDC and cannot accept community capital.
- Community capital requires dedicated vault custody rather than an accounting label inside the operating treasury.
- Treasury assets must always cover senior user obligations plus 100% of every unresolved ticket's offered payout. This is the hard solvency floor, not a target.
- The production target requires 125% gross payout coverage for new underwriting and LP redemption execution. The current shadow stage publishes this policy without authorizing quotes or transfers from it.

## Definition Of Complete

An item is complete only when:

1. Its policy and invariants are documented and approved.
2. Database and service behavior is implemented with integer micro-USDC accounting.
3. Unit, PostgreSQL concurrency, restart, duplicate, and failure-path tests pass where applicable.
4. The user-facing states are implemented without fake or stale financial values.
5. An independent code/QA review has no unresolved critical or high-severity finding.

## Track A: Vault Accounting

- [ ] Create immutable `vaults` and `vault_custody_scopes` with chain, token, Safe, policy hash, lifecycle state, and independent breaker states.
- [ ] Create serial `vault_epochs` with funding, underwriting, runoff, redemption, and finalized states; prevent overlapping active epochs in PostgreSQL.
- [ ] Create allowlist, deposit, position, participation-unit, and pro-rata redemption records.
- [ ] Attribute every vault-backed ticket and soft payment reservation to exactly one vault and epoch before capacity is consumed; prohibit reassignment.
- [ ] Add vault-scoped double-entry accounts for pending deposits, contributed capital, ticket reserves, booked obligations, protocol fees, redemption payables, and distributions.
- [ ] Keep hard solvency capital separate from any informational economic NAV estimate.
- [ ] Calculate and persist the hard solvency floor, 125% operating withdrawal floor, and capital above that floor at one canonical book version and block.
- [ ] Recognize ticket P&L only at final settlement; do not recognize quoted spread as revenue when a ticket activates.
- [ ] Calculate final epoch P&L and deterministic largest-remainder redemption allocation to the micro-USDC.
- [ ] Prove that deposits, units, realized P&L, distributions, and residual balances replay exactly from append-only records.

## Track B: Portfolio Risk

- [ ] Replace URL-based event exposure with canonical `event_group_key` exposure.
- [ ] Persist immutable, content-addressed risk policies; never overwrite the policy definition used by an earlier quote.
- [ ] Persist numerical risk decisions with fixed-point inputs, policy hash, vault book version, factor contributions, output, and calculation hash.
- [ ] Build exact-basket exposure and repeated/near-identical basket concentration.
- [ ] Build deterministic factor exposure for market outcome, event, neg-risk set, entity, asset, competition, category, resolution window, and settlement authority.
- [ ] Build portfolio scenario-loss evaluation over logically valid outcome states. Do not count an offset unless the scenario model proves it.
- [ ] Enforce vault-wide NAV-based limits for total net liability, single ticket, market/event, factor cluster, category, maturity, and oracle concentration.
- [ ] Include pending payment reservations in every capacity check.
- [ ] Lock one canonical vault book version during final requote and activation so concurrent tickets cannot oversubscribe capital.
- [ ] Add exposure-skew and repeated-basket monitoring before considering dynamic spread adjustments.
- [ ] Backtest pricing and limits against historical market paths and synthetic correlated stress scenarios.
- [ ] Keep AI advisory-only. No model may autonomously price, reject, settle, or move funds.

## Track C: Loss Waterfall And Economics

- [ ] Approve the exact seniority waterfall: user liabilities, permitted vault obligations, LP capital, and founder capital.
- [ ] Approve whether founder seed is pari passu with LPs or absorbs first loss.
- [ ] Approve which direct expenses may be charged to the vault, with explicit caps and append-only evidence.
- [ ] Approve whether operation fees belong to the protocol, the vault, or are split.
- [ ] Approve the protocol performance fee, if any, and prohibit retroactive fee changes within an epoch.
- [ ] Approve opening-unit treatment, rounding, residual dust, taxes, and loss carry-forward policy.

## Track D: Deposits, Epochs, And Redemptions

- [ ] Approve the funding-window duration, maximum eligible market maturity, operating buffer, runoff policy, and redemption window.
- [ ] Define indefinite-dispute handling without inventing a settlement result or promising an unlock date.
- [ ] Extend onchain transfer ownership to classify each LP deposit exactly once and reject or refund late, ineligible, duplicate, wrong-token, and wrong-amount transfers.
- [ ] Mint participation units only after eligibility, final transfer confirmation, and an exact opening reconciliation checkpoint.
- [ ] Stop new underwriting before runoff starts.
- [ ] Open redemptions only after all attributed tickets are final, soft reservations are zero, reconciliation delta is zero, and no custody incident is open.
- [ ] Accept idempotent LP withdrawal requests into an append-only epoch queue. A request does not burn units or become payable until its epoch is final.
- [ ] At epoch close, freeze one reconciled balance sheet and calculate all requested redemption entitlements pro rata with deterministic largest-remainder rounding.
- [ ] Create approved redemption payables simultaneously, then execute them FIFO by immutable sequence. Never skip a large payable for smaller later payables.
- [ ] Treat any inability to fund all approved post-settlement payables as a custody, reconciliation, or solvency incident; pause instead of silently socializing the shortfall through queue ordering.
- [ ] Recheck the canonical book under a database lock immediately before each transfer. The transfer must leave assets at or above senior user obligations plus 125% of gross unresolved payouts.
- [ ] Keep queued LP redemptions junior to every user balance, claim, refund, unresolved ticket payout, and user withdrawal.
- [ ] Test reorg, restart, duplicate transfer, concurrent deposit, concurrent activation, and payout-allocation paths.

## Track E: Custody And Reconciliation

- [ ] Use a logical vault subledger for founder-funded Sepolia shadow epochs only.
- [ ] Create a dedicated vault Safe before accepting community capital; do not pay platform operating expenses from it.
- [ ] Define explicit capital-call and return transfers between vault and operating custody scopes.
- [ ] Reconcile all vault-scoped assets, senior liabilities, gross unresolved payouts, booked obligations, reserves, pending deposits, and redemption payables at a canonical block.
- [ ] Publish append-only reconciliation snapshots with block number/hash, age, custody delta, coverage, reserve utilization, and breaker state.
- [ ] Publish the hard solvency floor, operating buffer, pending basket capacity, operating withdrawal floor, queue depth, oldest eligible request age, and currently executable surplus without exposing wallet-level queue data.
- [ ] Fail stale or unreconciled data closed. The UI must show unavailable rather than zero.
- [ ] Add independent provider quorum, Safe policy verification, reorg handling, and custody incident drills before mainnet.

## Track F: Governance, Security, Legal, And Audit

- [ ] Replace the shared operations key and caller-supplied operator labels with authenticated RBAC.
- [ ] Require real dual control for epoch, custody, policy, and emergency actions.
- [ ] Separate breakers for new underwriting, settlement observation/finalization, LP flows, and custody transfers so recovery work can continue safely.
- [ ] Approve Safe owners, threshold, guards/modules, timelocks, transfer limits, and emergency authority.
- [ ] Define append-only policy-change governance; changes take effect only in a future epoch.
- [ ] Obtain legal advice on pooled wagering exposure, fund/securities treatment, custody and beneficial ownership, eligible jurisdictions, sanctions/KYC, tax, marketing, and insolvency priority.
- [ ] Complete independent security, accounting, and quantitative-risk reviews and remediate every critical/high finding before community capital.
- [ ] Rehearse backup/PITR restoration, provider disagreement, stuck settlement, reconciliation drift, Safe compromise, USDC depeg/freeze, and LP run scenarios.

## Track G: LP Vault Product Surface

- [x] Add `LP Vault` as the third primary destination with `#lp-vault` deep-link and back/forward navigation.
- [x] Make all three navigation buttons fit at 320px without clipping, horizontal scrolling, or icon-only labels.
- [x] First viewport shows verified vault value, capital currently at risk, and exactly one state-appropriate next action.
- [x] Show reconciliation age beside every public financial snapshot and label stale values explicitly.
- [ ] Add disconnected, no-position, empty, loading, stale, unavailable, funding, active, runoff, redemption, and finalized states.
- [x] Place epoch lockup and withdrawal timing beside the relevant action.
- [x] Show a plain capital breakdown: reconciled assets, senior user obligations, gross ticket collateral, hard solvency floor, operating buffer, withdrawal floor, and capital above that floor.
- [ ] Show a connected user's position, epoch, units, realized closed-epoch P&L, and queued redemption status only when backed by canonical records.
- [x] Do not expose deposit, redemption, APY, projected yield, instant liquidity, insurance, automated hedging, or AI-management claims before their gates pass.
- [x] Verify desktop and mobile UX, keyboard navigation, loading/error recovery, and absence of horizontal overflow with Playwright.

## Delivery Sequence

### Stage 1: Read-Only Shadow Surface

- Approve the founder decisions below.
- Add the third navigation destination and honest disabled/empty states.
- Add a public read-only endpoint backed only by fresh reconciliation and vault snapshots.
- Do not add a write endpoint or deposit CTA.

Exit: routing and mobile tests pass; stale data fails closed; no return marketing or community-capital action exists.

### Stage 2: Shadow Subledger And Scenario Book

- Implement vault/epoch attribution, immutable policies, exact-basket and factor exposures, scenario loss, NAV-based limits, and replayable shadow accounting.
- Run shadow decisions beside existing founder-funded Sepolia quotes without changing customer quotes.

Exit: shadow results replay exactly, concurrent capacity cannot exceed the approved book, and the shadow system cannot move funds or alter production quotes.

### Stage 3: Founder-Funded Sepolia Epochs

- Run complete funding, underwriting, settlement, runoff, close, and distribution cycles with founder test capital.
- Exercise duplicate, reorg, restart, stale-provider, and reconciliation-drift failures.

Exit: repeated epochs reconcile assets, user liabilities, founder distributions, and booked obligations exactly to the micro-USDC.

### Stage 4: Founder Mainnet Pilot

- Use dedicated custody, stable Gamma+CLOB settlement agreement, authenticated RBAC, real dual approval, external monitoring, backup restoration, incident drills, and independent review. Polygon CTF verification may be added later as optional defense in depth.

Exit: all mainnet and vault gates pass with founder capital only.

### Stage 5: Allowlisted Community Cohort

- Open one capped, non-transferable cohort to legally eligible, allowlisted LPs.
- Keep fixed funding, underwriting, runoff, and pro-rata redemption windows.

Exit: the first community epoch closes, distributes, and reconciles without a critical/high incident before any scale increase.

## Approved Founder Defaults

- [x] Fixed cohort: one non-overlapping epoch with no mid-epoch deposits or withdrawal execution. Requests may queue during the epoch without burning units or becoming payable.
- [x] Eligibility window: a 72-hour funding window and maximum 30-day market maturity. An indefinitely disputed market keeps the epoch in runoff until authoritative resolution; LEGWORK does not invent a result or promise an unlock date.
- [x] Waterfall: user liabilities first, then explicitly permitted and capped direct vault expenses, then founder and LP capital pari passu.
- [x] Economics: the protocol retains the $0.50 per-leg operation fee. The pilot charges no performance fee, and realized underwriting P&L belongs pro rata to the cohort.
- [x] Risk: the hard floor is senior user obligations plus 100% of every unresolved ticket's offered payout. The production target requires at least 125% gross payout coverage for new underwriting and LP redemption execution, plus the lower of fixed launch limits and approved NAV-based limits. The current shadow stage observes this rule but does not enforce it on customer quotes. Unsupported relationships are unavailable rather than priced by AI or punitive spread.
- [x] Withdrawal ordering: final epoch economics and requested redemption entitlements are allocated pro rata across participation units. Approved payables are then sent FIFO by immutable sequence. Smallest-first is prohibited because request splitting could buy priority. No LP can exit unresolved epoch risk, and user obligations always remain senior.
- [x] Custody: Sepolia shadow mode may use a logically separate subledger in the existing staging Safe. A dedicated vault Safe is required before community capital.
- [x] Governance: separate breakers and real dual control are required before any mainnet vault.
- [x] Legal access: community deposits remain disabled until counsel defines eligible participants, jurisdictions, disclosures, and required identity controls.
- [x] Product surface: the LP action leads the page, followed immediately by a transparency dashboard. Every amount must be fresh, reconciled, and source-linked; stale or unsupported values display as unavailable rather than zero.

These approvals authorize implementation and shadow testing. They do not satisfy the implementation, legal, security, custody, or audit gates elsewhere in this roadmap.
