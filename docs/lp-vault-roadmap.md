# LEGWORK LP Vault Roadmap

Status: Canonical
Last updated: 2026-09-12

The LP Vault is intended to let eligible liquidity providers back LEGWORK tickets through a transparent, rolling economic NAV. It is not a generic yield account, an instantly redeemable ERC-4626 vault, or an automated AI-managed fund.

The current product is one founder-funded Sepolia shadow vault that observes the global house book without accepting public funds or exposing LP actions. The approved community target is a rolling vault with daily 00:00 UTC accounting cycles. Community deposits remain disabled until accounting, risk, custody, governance, legal, and independent-review gates pass.

## Product Boundary

- One continuous vault, one non-transferable share class, and one canonical accounting cycle each day at 00:00 UTC.
- A future deposit enters custody immediately but remains pending P&L until the next daily cycle admits it at the canonical pre-deposit economic-NAV share price, including conservative unresolved-liability marks. This prevents inherited prior P&L and incumbent dilution.
- Share quantity is fixed after issuance. Its USDC value floats with economic NAV; P&L from unresolved marks is estimated and only authoritative settlements change finalized P&L.
- Withdrawal requests queue in immutable FIFO order. Admission is gated by separately reserved redemption liquidity, not by headline vault value alone.
- Queued shares remain active. Admission begins a 72-hour redemption period during which the shares continue to take dynamic P&L and back new exposure.
- Requested shares are valued and burned only at the end of the 72-hour period, when the canonical economic-NAV share price becomes binding for that burn and payable even if unresolved-ticket P&L remains estimated.
- Vault NAV and reserved redemption liquidity are separate measures. Liquidity reservation is not profit and is not added to NAV.
- No APY, projected return, smoothed value, instant liquidity, or "house-edge yield" claim.
- User balances, claims, refunds, and pending withdrawals remain senior to LP capital.
- Sepolia shadow mode uses test USDC and cannot accept community capital.
- Community capital requires dedicated vault custody rather than an accounting label inside the operating treasury.
- Treasury assets must always cover senior user obligations plus 100% of every unresolved ticket's offered payout. This is the hard solvency floor, not a target.
- The production target requires 125% gross payout coverage for new underwriting, redemption admission, and redemption payment. The current shadow stage publishes this policy without authorizing quotes or transfers from it.

## Definition Of Complete

An item is complete only when:

1. Its policy and invariants are documented and approved.
2. Database and service behavior is implemented with integer micro-USDC accounting.
3. Unit, PostgreSQL concurrency, restart, duplicate, and failure-path tests pass where applicable.
4. The user-facing states are implemented without fake or stale financial values.
5. An independent code/QA review has no unresolved critical or high-severity finding.

## Track A: Vault Accounting

The following broad roadmap items remain unchecked because each bundles later vault custody, ticket attribution, public-flow, or distribution work. The internal rolling accounting foundation beneath them is complete in founder shadow mode: fixed-point non-transferable shares, pending activation, daily canonical cycles, conservative liability marks, separate economic NAV/collateral/redemption-reserve measures, estimated versus finalized P&L, FIFO 72-hour shadow redemptions, append-only replayable records, idempotent workers, and a read-only verified API. It does not accept, custody, or transfer community LP funds.

- [ ] Create immutable `vaults` and `vault_custody_scopes` with chain, token, Safe, policy hash, lifecycle state, and independent breaker states.
- [ ] Create immutable daily `vault_cycles` at 00:00 UTC with opening and closing book versions, canonical economic NAV and share price, estimated marked P&L, settlement-finalized P&L, and reconciliation evidence.
- [ ] Create allowlist, pending-deposit, position, fixed-share, withdrawal-request, liquidity-admission, redemption-period, burn, payable, and distribution records.
- [ ] Attribute every vault-backed ticket and soft payment reservation to one immutable vault book version before capacity is consumed; prohibit reassignment.
- [ ] Add vault-scoped double-entry accounts for pending deposits, contributed capital, ticket reserves, booked obligations, protocol fees, reserved redemption liquidity, redemption payables, and distributions.
- [ ] Keep hard solvency capital, economic vault NAV, and reserved redemption liquidity as separate reconciled measures.
- [ ] Calculate and persist the hard solvency floor, 125% operating floor, underwriting capacity, and redemption-liquidity capacity at one canonical book version and block.
- [ ] Publish unresolved marked P&L only as estimated. Change finalized P&L only from authoritative ticket settlements; do not recognize quoted spread as revenue when a ticket activates.
- [ ] Mint fixed non-transferable shares for admitted deposits using deterministic micro-USDC rounding and the canonical pre-deposit economic-NAV price, including conservative current liability marks.
- [ ] Prove deposit pricing prevents entrants from inheriting pre-entry P&L and prevents dilution of incumbent shares.
- [ ] At the end of an admitted redemption's 72-hour period, make the locked reconciled canonical economic-NAV price binding for valuation and burn without relabeling unresolved-ticket P&L as finalized.
- [ ] Prove that deposits, shares, estimated adjustments, finalized P&L, liquidity reservations, burns, payables, distributions, and residual balances replay exactly from append-only records.

## Track B: Portfolio Risk

- [ ] Replace URL-based event exposure with canonical `event_group_key` exposure.
- [ ] Persist immutable, content-addressed risk policies; never overwrite the policy definition used by an earlier quote.
- [ ] Persist numerical risk decisions with fixed-point inputs, policy hash, vault book version, factor contributions, output, and calculation hash.
- [ ] Build exact-basket exposure and repeated/near-identical basket concentration.
- [ ] Build deterministic factor exposure for market outcome, event, neg-risk set, entity, asset, competition, category, resolution window, and settlement authority.
- [ ] Build portfolio scenario-loss evaluation over logically valid outcome states. Do not count an offset unless the scenario model proves it.
- [ ] Enforce vault-wide economic-NAV-based limits for total net liability, single ticket, market/event, factor cluster, category, maturity, and oracle concentration.
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
- [ ] Approve the protocol performance fee, if any, and prohibit retroactive fee changes within an accounting cycle or active redemption period.
- [ ] Approve opening-unit treatment, rounding, residual dust, taxes, and loss carry-forward policy.

## Track D: Deposits, Daily Cycles, And Redemptions

- [ ] Approve the 00:00 UTC cycle-close procedure, deposit cutoff semantics, 72-hour redemption duration, operating buffer, and redemption-liquidity policy.
- [ ] Extend onchain transfer ownership to classify each LP deposit exactly once and reject or refund ineligible, duplicate, wrong-token, and wrong-amount transfers.
- [ ] Record confirmed capital in custody immediately while keeping it outside active P&L until the next completed daily cycle.
- [ ] Activate deposits and mint fixed non-transferable shares only after eligibility, final transfer confirmation, and an exact cycle reconciliation checkpoint.
- [ ] Accept idempotent withdrawal requests into one append-only FIFO queue without freezing value, burning shares, or removing the LP from underwriting.
- [ ] Admit requests strictly FIFO only inside the fresh reconciliation transaction, using the latest immutable daily checkpoint for share price and current locked reconciliation evidence for capacity. Preserve senior obligations, pending-basket capacity, and the 125% operating floor; never skip a large request for smaller later requests.
- [ ] Keep queued and admitted shares active in dynamic P&L and new exposure until their individual 72-hour redemption periods end.
- [ ] At each redemption end, lock one reconciled canonical economic-NAV price, make it binding for the request with deterministic micro-USDC rounding, burn the requested shares, and create the payable atomically. Preserve the estimated label for unresolved-ticket P&L included in that price.
- [ ] Recheck custody and the operating floor under a database lock immediately before each transfer. Pause admission or payment on any custody, reconciliation, or solvency incident without changing FIFO priority or backdating value.
- [ ] Keep queued LP redemptions junior to every user balance, claim, refund, unresolved ticket payout, and user withdrawal.
- [ ] Test reorg, restart, duplicate transfer, concurrent cycle close, concurrent deposit, concurrent activation, FIFO admission, dynamic 72-hour P&L, burn valuation, and payout paths.

## Track E: Custody And Reconciliation

- [ ] Use a logical vault subledger for founder-funded Sepolia shadow cycles only.
- [ ] Create a dedicated vault Safe before accepting community capital; do not pay platform operating expenses from it.
- [ ] Define explicit capital-call and return transfers between vault and operating custody scopes.
- [ ] Reconcile all vault-scoped assets, senior liabilities, gross unresolved payouts, booked obligations, reserves, pending deposits, reserved redemption liquidity, and redemption payables at a canonical block.
- [ ] Add a monotonic financial book version shared by reconciliation and every financial writer so a daily close cannot mix a canonical asset snapshot with later-committed ledger, ticket, or settlement rows.
- [ ] Add a deterministic supervised recovery operation for a missed 00:00-00:05 UTC evidence window; never silently skip, backdate, or substitute a current snapshot for the missing cycle.
- [ ] Publish append-only reconciliation snapshots with block number/hash, age, custody delta, coverage, reserve utilization, and breaker state.
- [ ] Publish the hard solvency floor, operating buffer, pending basket capacity, queue depth, oldest request age, economic-NAV/share-price timestamp, estimated marked P&L, finalized settlement P&L, and separately reserved redemption liquidity without exposing wallet-level queue data.
- [ ] Fail stale or unreconciled data closed. The UI must show unavailable rather than zero.
- [ ] Add independent provider quorum, Safe policy verification, reorg handling, and custody incident drills before mainnet.

## Track F: Governance, Security, Legal, And Audit

- [ ] Replace the shared operations key and caller-supplied operator labels with authenticated RBAC.
- [ ] Require real dual control for cycle, custody, policy, and emergency actions.
- [ ] Separate breakers for new underwriting, settlement observation/finalization, LP flows, and custody transfers so recovery work can continue safely.
- [ ] Approve Safe owners, threshold, guards/modules, timelocks, transfer limits, and emergency authority.
- [ ] Define append-only policy-change governance; changes take effect only at a future daily cycle and cannot rewrite an active redemption period.
- [ ] Obtain legal advice on pooled wagering exposure, fund/securities treatment, custody and beneficial ownership, eligible jurisdictions, sanctions/KYC, tax, marketing, and insolvency priority.
- [ ] Complete independent security, accounting, and quantitative-risk reviews and remediate every critical/high finding before community capital.
- [ ] Extend replay verification to reconcile every hash-chained accounting event against its append-only projection, including fees, expenses, settlements, ticket marks, redemption reserve marks, and lifecycle transitions.
- [ ] Rehearse backup/PITR restoration, provider disagreement, stuck settlement, reconciliation drift, Safe compromise, USDC depeg/freeze, and LP run scenarios.

## Track G: LP Vault Product Surface

- [x] Add `LP Vault` as the third primary destination with `#lp-vault` deep-link and back/forward navigation.
- [x] Make all three navigation buttons fit at 320px without clipping, horizontal scrolling, or icon-only labels.
- [x] First viewport shows verified assets, maximum live-ticket payout, payout coverage, collateral state, and one unambiguous shadow-mode notice.
- [x] Show reconciliation age beside every public financial snapshot and label stale values explicitly.
- [ ] Add no-position, pending-deposit, active, queued-withdrawal, admitted-redemption, paid, loading, stale, and unavailable states only when their canonical records exist.
- [x] Explain the future 00:00 UTC activation cycle, FIFO liquidity gate, and 72-hour end valuation without exposing a fake action.
- [x] Show a plain capital breakdown: reconciled assets, senior user obligations, gross ticket collateral, hard solvency floor, operating buffer, withdrawal floor, and capital above that floor.
- [ ] Show a connected user's fixed shares, floating USDC value, estimated versus finalized P&L, and redemption status only when backed by canonical records.
- [x] Do not expose deposit, redemption, APY, projected yield, instant liquidity, insurance, automated hedging, or AI-management claims before their gates pass.
- [x] Verify desktop and mobile UX, keyboard navigation, loading/error recovery, and absence of horizontal overflow with Playwright.

## Delivery Sequence

### Stage 1: Read-Only Shadow Surface

- Approve the founder decisions below.
- Add the third navigation destination and honest shadow, loading, stale, and unavailable states.
- Add a public read-only endpoint backed only by fresh reconciliation and vault snapshots.
- Do not add a write endpoint or deposit CTA.

Exit: routing and mobile tests pass; stale data fails closed; no return marketing or community-capital action exists.

### Stage 2: Shadow Subledger And Scenario Book

- Build the deterministic vault-attributed scenario and risk book: immutable vault book-version ticket attribution, exact-basket and factor exposure, scenario-loss evaluation, and economic-NAV-based limits.
- Run the risk book beside existing founder-funded Sepolia quotes without changing customer quotes or moving funds.

Exit: shadow results replay exactly, concurrent capacity cannot exceed the approved book, and the shadow system cannot move funds or alter production quotes.

### Stage 3: Founder-Funded Sepolia Rolling Cycles

- Run founder-funded staging drills over the completed internal accounting lifecycle: pending-deposit activation, 00:00 UTC cycle close, settlement recognition, FIFO admission, active 72-hour redemption, binding valuation, burn, payable, and simulated distribution.
- Exercise duplicate, reorg, restart, stale-provider, and reconciliation-drift failures.

Exit: repeated daily cycles and simulated redemptions reconcile assets, user liabilities, founder shares, finalized P&L, liquidity reservations, distributions, and booked obligations exactly to the micro-USDC.

### Stage 4: Founder Mainnet Pilot

- Use dedicated custody, stable Gamma+CLOB settlement agreement, authenticated RBAC, real dual approval, external monitoring, backup restoration, incident drills, and independent review. Polygon CTF verification may be added later as optional defense in depth.

Exit: all mainnet and vault gates pass with founder capital only.

### Stage 5: Allowlisted Community Rolling Vault

- Open one capped non-transferable share class to legally eligible, allowlisted LPs.
- Keep continuous underwriting, daily canonical accounting checkpoints, settlement-finalized P&L, liquidity-gated FIFO admission, and 72-hour end-valued redemptions.

Exit: the first community deposit and redemption cycles complete and reconcile without a critical/high incident before any scale increase.

## Approved Founder Defaults

- [x] Rolling participation: deposits enter custody immediately, remain pending P&L until the next 00:00 UTC cycle, then activate as fixed non-transferable shares with floating USDC value.
- [x] Valuation and P&L: economic NAV and share price include conservative current liability marks and may remain estimated while tickets are unresolved. Only authoritative ticket settlements change finalized P&L.
- [x] Waterfall: user liabilities first, then explicitly permitted and capped direct vault expenses, then founder and LP capital pari passu.
- [x] Economics: the protocol retains the $0.50 per-leg operation fee. The pilot charges no performance fee, and finalized underwriting P&L belongs pro rata to active shares.
- [x] Risk: the hard floor is senior user obligations plus 100% of every unresolved ticket's offered payout. The production target requires at least 125% gross payout coverage for new underwriting and LP redemption execution, plus the lower of fixed launch limits and approved NAV-based limits. The current shadow stage observes this rule but does not enforce it on customer quotes. Unsupported relationships are unavailable rather than priced by AI or punitive spread.
- [x] Withdrawal ordering: requests receive immutable FIFO priority and admission requires separately reserved redemption liquidity. Queued and admitted shares remain active in P&L and new exposure. After 72 hours, the canonical economic-NAV price becomes binding for valuation and burn without implying all ticket P&L is finalized; user obligations always remain senior.
- [x] Custody: Sepolia shadow mode may use a logically separate subledger in the existing staging Safe. A dedicated vault Safe is required before community capital.
- [x] Governance: separate breakers and real dual control are required before any mainnet vault.
- [x] Legal access: community deposits remain disabled until counsel defines eligible participants, jurisdictions, disclosures, and required identity controls.
- [x] Product surface: `LEGWORK LP Vault` leads with transparent rolling economic NAV, one founder-funded Sepolia shadow notice, verified assets, coverage, and collateral state. Technical evidence is progressively disclosed; stale, mismatched, or unsupported values display as unavailable rather than zero.

These approvals authorize implementation and shadow testing. They do not satisfy the implementation, legal, security, custody, or audit gates elsewhere in this roadmap.
