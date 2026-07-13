# LEGWORK Settlement Infrastructure

## What Exists Now

Settlement is now server-owned and append-only-audited.

- `ticket_legs` carry resolver state: `resolution_state`, attempt count, next check time,
  update time, and last resolver error.
- `settlement_proofs` stores every resolver observation and final proof. Proofs are not
  overwritten; repeated checks create a history.
- `server/resolvers/polymarketSettlementResolver.ts` reads Polymarket CLOB market status
  by `conditionId`, maps winning token IDs to the selected leg, and returns either an
  observation or a final result.
- `server/workers/settlementResolverWorker.ts` polls due legs, records observations,
  settles final results, backs off failures, and keeps processing the rest of the batch
  if one leg errors.
- `recordLegSettlement` locks the leg and ticket, rejects conflicting final results,
  writes proof history, derives ticket status, and pays play-money won/voided tickets
  through the double-entry ledger.
- `/api/ops/settlements/pending` shows due settlement work.
- `/api/ops/ticket-legs/:id/proofs` shows the proof trail for a leg.
- `/api/ops/ticket-legs/:id/settle` remains as a manual operator override.

## Production Safety Posture

`SETTLEMENT_REQUIRE_ONCHAIN` defaults to `true` in production.

With that setting enabled, the worker does not pay tickets from a Polymarket API winner
signal alone. If CLOB shows a winner but no onchain confirmation adapter has finalized the
proof, the leg moves to `settlement_blocked` and is retried later. This prevents API drift,
indexing bugs, or transient incorrect winner flags from paying real funds.

For local development and play-money testing, `docker-compose.yml` sets
`SETTLEMENT_REQUIRE_ONCHAIN=false`, so CLOB winner signals can finalize tickets.

## Known Real-Money Gaps

These are not cosmetic. They block real-money settlement:

- Polygon CTF confirmation adapter: verify condition resolution and payout outcome
  directly from chain/RPC before finalizing.
- Redemption proof capture: store transaction hash/block number when LEGWORK or a user
  redeems positions.
- Outcome policy: define product behavior for 50/50, void, canceled, neg-risk, partial,
  and disputed markets.
- Operator console: review blocked legs, view proof timelines, apply controlled overrides,
  and export an audit trail.
- Reconciliation: prove ticket payouts, ledger entries, chain transfers, and reserves
  agree on a schedule.

## Useful Commands

```bash
npm run db:migrate
npm run worker:settlements
docker compose --profile worker up settlement-worker
```
