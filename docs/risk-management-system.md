# LEGWORK Risk Management System

## Position

LEGWORK should not run as a simple parlay multiplier with a fixed spread. A real-money platform needs a pre-trade risk engine that decides whether a basket is accepted, repriced, reduced, manually reviewed, or rejected.

The current frontend contains a deterministic prototype in `src/riskEngine.ts`. Production risk checks must live server-side and be enforced before custody, payment, or quote acceptance.

## Core Loop

1. Fetch executable source-market prices and depth.
2. Normalize every leg into a source market, outcome token, expiry, and settlement rule.
3. Build a basket quote from the source prices.
4. Run pre-trade risk checks.
5. Apply dynamic spread, stake limits, payout limits, and correlation rules.
6. Accept, reject, or requote.
7. Reserve worst-case payout capacity.
8. Hedge immediately when required.
9. Persist quote, risk decision, source snapshot, and settlement references.

## Required Risk Gates

- **Verified source only**: no demo markets, no search links, no unlinked markets.
- **Quote expiry**: quotes should expire in 5-15 seconds.
- **Max stake**: launch cap should be small until exposure data exists.
- **Max payout**: reserve worst-case payout, not expected value.
- **Leg cap**: long baskets increase tail and pricing risk.
- **Correlation groups**: review or surcharge baskets with shared drivers; block only severe concentration.
- **Liquidity checks**: price from executable depth, not display probability alone.
- **Volatility checks**: reject markets moving too quickly.
- **Exposure accounting**: track aggregate liability by event, source, category, and correlation group.
- **Exposure caps**: the current backend enforces launch caps through `MAX_MARKET_LIABILITY_USD`
  and `MAX_EVENT_LIABILITY_USD`; if a new quote breaches a cap, it is blocked instead of
  being repriced into a bad user experience.
- **Accept-time enforcement**: exposure is checked again when a quote is accepted, inside
  the ticket transaction with advisory locks. Quote-time checks are UX guidance; accept-time
  checks are the control that prevents stale capacity from creating excess liability.
- **Hedge-or-reject**: large tickets should be accepted only if hedging is possible at acceptable slippage.
- **Spread cap**: never keep widening a quote until the payout becomes irrational; block or review instead.
- **Kill switches**: platform-wide, source-wide, category-wide, market-wide, and user/account-level.

## Dynamic Spread

A flat 7% spread is too fragile for real-money operation. It may be acceptable for a demo, but production spread should be dynamic:

```text
base spread
+ correlation surcharge
+ liquidity surcharge
+ volatility surcharge
+ leg-count surcharge
+ exposure concentration surcharge
+ settlement/oracle ambiguity surcharge
```

Initial production posture:

```text
Clean, liquid, uncorrelated baskets: 10-15%
Thin markets: up to the published spread cap
Correlated baskets: up to the published spread cap, then review
Unhedgeable large tickets: reject
```

The quote spread should have a visible product cap. If a basket requires more spread than the cap allows, LEGWORK should mark the basket unavailable rather than showing a punitive quote. A basket should also be blocked if the potential payout is less than or equal to the amount due.

## Correlation

Multiplying leg prices assumes independence. That is often false in prediction markets.

Examples of correlated groups:

- Same asset: BTC up, crypto ETF approval, crypto regulation.
- Same event: election winner, party control, candidate polling.
- Same macro driver: Fed rates, CPI, recession, unemployment.
- Same weather system: rain, temperature, flight cancellation.
- Same tournament/team/player.
- Same settlement oracle or source event.

Some same-event baskets are normal user behavior, not abuse. For example, a user who believes Morocco will win the World Cup may select Morocco Yes plus USA No and Mexico No. That should usually be reviewable with a capped spread, not automatically blocked. Longer term, these event-family baskets need conditional or combinatorial pricing rather than naive independent multiplication.

MVP can use deterministic grouping rules. Production should add:

- taxonomy-based grouping,
- entity extraction,
- historical co-movement,
- source-market graph links,
- manual trader overrides,
- post-settlement backtesting.

## AI Role

AI can help, but it should not be the final risk authority.

Good uses:

- classify market themes and entities,
- suggest correlation groups,
- summarize settlement ambiguity,
- flag suspicious basket construction,
- explain risk decisions to operators,
- assist backtesting and monitoring.

Bad uses:

- deciding final quote acceptance without deterministic checks,
- replacing executable price/depth validation,
- replacing bankroll and payout caps,
- making opaque real-money decisions that cannot be audited.

Recommended architecture:

```text
deterministic risk engine = final authority
cheap AI classifier = advisory signal
human/operator overrides = logged and reviewed
```

Use a small, low-cost model asynchronously for classification and review suggestions. Cache market classifications by market ID. Do not call an LLM on every quote path unless latency, cost, and auditability are solved.

## Minimum Production Tables

- `markets`: source, market ID, token IDs, expiry, settlement rules.
- `market_snapshots`: bid/ask/depth, timestamp, source response hash.
- `quotes`: basket legs, stake, spread, payout, expiry, decision.
- `risk_checks`: check name, level, details, model/policy version.
- `exposures`: open liability by market, event, category, correlation group.
- `hedges`: hedge order IDs, fills, slippage, failures.
- `settlements`: source result, proof, payout decision.
- `policy_versions`: limits, spread rules, kill switches.

## Launch Recommendation

For a real-money alpha:

- max stake: low double digits,
- max payout: low hundreds,
- quote expiry: 5-15 seconds,
- only verified live markets,
- review correlated baskets instead of blocking normal same-event theses,
- dynamic spread starting at 10% with a published cap,
- reject when executable depth is unavailable,
- reserve full worst-case payout,
- keep AI advisory only.

The business becomes plausible when the platform behaves more like a trading/risk desk than a generic parlay calculator.
