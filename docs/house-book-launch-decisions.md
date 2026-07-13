# LEGWORK House-Book Launch Decisions

## Status

LEGWORK's selected launch model is a house-book model.

In this model, users place prediction-market parlays with LEGWORK, LEGWORK books the
user-facing wager, and LEGWORK owns treasury, ledger, exposure, and payout operations.
Source markets still inform pricing and settlement, but users are not directly composing
or settling every parlay leg onchain at launch.

These notes are the durable product, risk, custody, and implementation decisions for the
closed beta path. They do not replace legal review.

## Launch Currency And Network

Initial funding and payout currency:

- USDC first.
- Ethereum mainnet first.

Rationale:

- USDC is the clearest stablecoin denomination for quoting stakes, payouts, exposure,
  treasury balances, and accounting.
- Ethereum mainnet has the broadest operational maturity for USDC custody and multisig
  treasury operations.
- Starting with one asset and one chain keeps ledger, reconciliation, treasury, support,
  and incident response simpler during closed beta.

Deferred:

- Polygon, Base, Solana, and other cheaper networks.
- Non-USDC assets.
- Cross-chain deposit and withdrawal routing.

## Custody And Treasury

Initial custody posture:

- Use the cheapest acceptable custody path first.
- Safe multisig is acceptable for the initial LEGWORK treasury wallet.
- Keep the architecture scalable to Privy, Turnkey, or another managed wallet/custody
  provider later.

Operational model:

- LEGWORK maintains an internal ledger as the system of record for user balances,
  stakes, reserved exposure, wins, losses, refunds, and withdrawals.
- Onchain funds sit in a house treasury wallet controlled by LEGWORK.
- Deposits and withdrawals reconcile between onchain USDC transfers and the internal
  ledger.
- The treasury wallet must hold enough liquid USDC to cover user balances and reserved
  payout exposure under the closed beta limits.

Custody constraints:

- No private keys in the browser.
- No hot private keys committed to source control or stored casually in app server env
  files.
- Treasury movements should require multisig approval until a better custody system is
  implemented.
- Ledger entries must be immutable or append-only-auditable, with corrections represented
  as new reversing entries.

Future custody path:

- Keep interfaces narrow enough that Safe can be replaced or complemented by Privy,
  Turnkey, Fireblocks, Coinbase Prime, or another custody provider.
- Managed custody becomes more attractive when LEGWORK needs higher withdrawal volume,
  policy automation, user wallets, signing controls, role-based approvals, or compliance
  workflows.

## User Money Flow

Closed beta user flow:

1. User connects a wallet.
2. User builds a basket and reviews a final ticket modal.
3. Backend creates an expiring quote and payment intent.
4. User accepts the parlay by sending the exact USDC amount due from the connected wallet
   to LEGWORK's single treasury address.
5. Backend verifies the onchain USDC transfer matches the quote, sender wallet, treasury
   address, token, chain, and amount.
6. Backend creates the ticket, records the stake and operation fee, and reserves worst-case
   payout exposure.
7. Settlement updates the internal ledger.
8. User claims winnings with a claim button.
9. User withdrawals send USDC from the LEGWORK treasury wallet back onchain.

Important product decision:

- Users do not pre-fund an internal balance before buying a basket in the first beta flow.
- The basket purchase itself is the USDC payment event.
- The internal ledger remains the system of record after payment verification. It records
  purchases, fees, reserves, winnings, refunds, claims, and withdrawals.
- The final ticket modal must show the exact amount due before the user signs the USDC
  transfer.

Claim UX:

- Winnings should not silently disappear into an unclear state.
- A claim button should make settled winnings explicit and user-controlled.
- Won tickets become claimable first. They do not auto-credit to available balance.
- The product should show claimable winnings separately from available balance.
- Claiming should be idempotent and backed by ledger entries so refreshes or retries do
  not duplicate payouts.

## Closed Beta Limits

Closed beta financial limits:

- Maximum stake: $25.
- Maximum payout: $250.
- Maximum exposure per user: $500.
- Maximum exposure per event: $1,000.

Interpretation:

- Maximum stake caps the amount a user can risk on a single accepted ticket.
- Maximum payout caps the gross user-facing payout for a single accepted ticket.
- Maximum exposure per user caps the user's aggregate open worst-case house liability.
- Maximum exposure per event caps aggregate open worst-case house liability tied to the
  same event or event family.

Risk system requirement:

- Quote-time checks should warn or reject when limits are likely to be breached.
- Accept-time checks must enforce limits transactionally.
- Exposure should be reserved against worst-case payout, not expected value.

## Legal And Access Posture

Closed beta posture:

- Closed beta only.
- Non-US posture until counsel confirms the allowed operating model.
- No public US-facing launch without legal signoff.
- No claim that the model is compliant merely because it uses crypto rails or prediction
  market source prices.

Identity posture:

- No KYC initially.
- Wallet connect only for closed beta access.

Important limitation:

- "No KYC initially" is a beta operating choice, not a legal conclusion. Counsel may
  require KYC, sanctions screening, age gating, geo controls, transaction monitoring, or
  licensing changes before real-money launch or broader access.

## Settlement Policy

Initial product policy should be traditional and parlay-like:

- A user wins only when all live legs win.
- A losing leg makes the ticket lose.
- Voided, canceled, ambiguous, disputed, or 50/50-style outcomes refund the stake while
  keeping operation fees.
- The policy should be published in user-facing terms before accepting real stakes.

Implementation posture:

- Source market resolution informs the result.
- Backend settlement and ledgering remain the authority for user balances.
- Real-money settlement should require durable proof and an operator-auditable trail.
- API-only winner signals should not be enough for irreversible real-money payout if an
  onchain confirmation path is expected for the source market.

Open policy decisions:

- How to handle partial market resolutions.
- How to handle source-market negative-risk mechanics.
- How to handle delayed or corrected resolutions after a refund or payout.
- How long LEGWORK can hold a ticket in pending settlement before applying the refund
  policy or manual review.

## Hedging

Initial hedging decision:

- No auto hedging for closed beta.

Implications:

- LEGWORK must treat accepted tickets as house exposure.
- Exposure limits matter more because the house is not automatically neutralizing risk.
- Manual hedging remains possible as an operator action, but the product should not depend
  on it for beta safety.
- If exposure approaches caps or concentrates around one event, the system should reject
  or pause new tickets rather than assuming a hedge will happen.

Future hedging path:

- Add manual hedge tracking before automated hedge execution.
- Require executable depth, slippage controls, hedge order IDs, fill tracking, and
  reconciliation before auto hedging is enabled.

## Implementation Sequence

Selected sequence:

1. Backend ledger first.
2. Multisig treasury.
3. Onchain deposits and withdrawals.
4. Smart contract escrow later.

Backend ledger first:

- Internal double-entry ledger is the source of truth for balances, stakes, reserved
  exposure, winnings, refunds, adjustments, and withdrawals.
- Ledger must support reconciliation to treasury wallet balances and source settlement
  proofs.

Multisig treasury:

- Safe multisig can hold USDC treasury funds during closed beta.
- Treasury operations should be manual or semi-manual until withdrawal volume requires
  automation.

Onchain deposits and withdrawals:

- Deposits credit the internal ledger only after the required confirmation policy.
- Withdrawals debit or reserve internal balance before initiating the onchain transfer.
- Every onchain transfer should reconcile to ledger entries, transaction hashes, and
  operator actions.

Smart contract escrow later:

- Do not make escrow the first implementation dependency.
- Escrow can be added after the ledger, treasury, settlement, and reconciliation model are
  proven.
- Future escrow design must decide whether funds are escrowed per ticket, per user
  balance, per event, or in aggregate.

## Open Questions

- Which non-US jurisdictions are allowed for closed beta, and which must be blocked?
- What exact legal classification applies to LEGWORK's house-book model in each target
  jurisdiction?
- What age gate, sanctions screening, KYC, AML, and responsible-gambling controls are
  required before and during closed beta?
- What confirmation depth is required before crediting USDC deposits on Ethereum mainnet?
- What withdrawal review thresholds, daily limits, and approval policies should apply?
- Who are the Safe signers, what quorum is required, and what recovery process exists if a
  signer is unavailable?
- What treasury reserve ratio is required above user balances and reserved exposure?
- What is the exact event-family taxonomy for enforcing the $1,000 event exposure cap?
- How are void, canceled, disputed, corrected, and partial outcomes handled in user-facing
  terms?
- What operator actions are permitted during settlement disputes, and how are they audited?
- When does LEGWORK graduate from Safe multisig to managed custody such as Privy or Turnkey?
- What user communication is required when withdrawals are delayed for manual review?

## Risks

- Legal risk: the house-book model may be regulated as wagering, gambling, derivatives,
  money transmission, or another restricted financial activity depending on jurisdiction.
- Compliance risk: wallet connect without KYC may be insufficient even for a limited
  closed beta.
- Custody risk: Safe multisig is operationally simple but still requires signer security,
  approval discipline, incident response, and reconciliation.
- Treasury risk: internal ledger balances can diverge from onchain treasury funds if
  deposits, withdrawals, fees, reversals, or manual transfers are not reconciled.
- Liquidity risk: Ethereum mainnet USDC withdrawals may be expensive or slow relative to
  small beta balances.
- Exposure risk: no auto hedging means LEGWORK is intentionally warehousing risk.
- Correlation risk: parlay legs may be highly correlated, making naive payout math
  understate true house exposure.
- Settlement risk: source-market APIs, onchain resolution, and LEGWORK policy can disagree.
- UX risk: claimable winnings, available balance, reserved stake, and pending withdrawals
  must be clear enough that users understand where funds are.
- Operational risk: manual treasury and settlement work can fail during spikes, disputes,
  or signer unavailability.

## Current Decision Summary

LEGWORK will start with a closed, non-US beta using USDC on Ethereum mainnet, a backend
internal ledger, and an onchain house treasury wallet. Safe multisig is acceptable as the
initial low-cost custody path, with interfaces kept flexible for Privy, Turnkey, or another
custody provider later. Users connect wallets, fund internal balances, place capped
house-book parlays, and claim settled winnings through explicit product UX. Closed beta
limits are $25 max stake, $250 max payout, $500 max exposure per user, and $1,000 max
exposure per event. LEGWORK will not auto hedge at launch; the risk system must reject or
pause exposure instead. Smart contract escrow is deferred until after the ledger,
treasury, deposit, withdrawal, settlement, and reconciliation paths are proven.
