# Security and Architecture Notes

## Non-negotiable boundaries

- No trading keys in the browser.
- No custody or balance ledger without server-side accounting, audit logs, and withdrawal controls.
- No executable quote without a server snapshot of market IDs, token IDs, price source, expiry, fees, and region eligibility.
- No cross-venue parlay claim until each venue adapter has explicit resolution, void, and dispute semantics.

## Polymarket-first execution path

1. Use Gamma API for browsing and search.
2. Persist `conditionId` and `clobTokenIds`.
3. Hydrate tradability through CLOB endpoints before quoting.
4. Prefer native Combos/RFQ for true multi-leg execution.
5. Treat independent probability multiplication as indicative only.

## Region and compliance risk

Polymarket documents geographic restrictions, and the United States is a major constraint for trading flows. A production app must check region eligibility before order entry and must not imply that a user can trade where the venue rejects orders.

## Quote packet shape

```ts
type QuotePacket = {
  ticketId: string;
  createdAt: string;
  expiresAt: string;
  userRegion: string;
  stakeUsd: string;
  operationFeeUsd: string;
  houseEdgeBps: number;
  source: "polymarket-combo-rfq" | "polymarket-clob-depth" | "indicative";
  legs: Array<{
    venue: "polymarket";
    conditionId: string;
    tokenId: string;
    outcome: string;
    quotedPrice: string;
    endDate?: string;
    negRisk?: boolean;
    rfqEnabled?: boolean;
  }>;
};
```

## Backend milestones

- Quote service: immutable quote packets, expiry, fee model, risk checks.
- Market indexer: Gamma ingestion, CLOB hydration, websocket price updates.
- Execution adapter: Combos RFQ first, CLOB preview second.
- Settlement worker: resolution polling, void policy, payout state machine.
- Ops console: ticket search, exposure, stuck settlement queue, audit trail.

## Recommended v1 backend stack

Start with a deterministic backend. Agents can research, explain, triage, and draft actions, but order placement, ledger mutation, quote signing, and settlement state transitions should be owned by explicit services.

Practical first stack:

- Fastify for the API service.
- ts-rest plus Zod for contract-first typed REST and OpenAPI.
- Postgres for tickets, quote packets, market snapshots, outbox events, and audit trails.
- Better Auth for sessions.
- OpenFGA for model-as-code permissions.
- BullMQ for ingestion, repricing, notification, and settlement jobs.
- OpenTelemetry and SigNoz for traces, queue visibility, and service health.

Add Inngest when async flows need durable steps, retries, replays, throttling, or `waitForEvent` semantics. Move to Temporal only if the ticket lifecycle becomes a real durable-business-process problem with cancellation, compensation, and approval flows.

Security tooling to add early:

- Gitleaks for secret scanning.
- OSV-Scanner for dependency vulnerabilities.
- Semgrep for code patterns.
- Trivy when containers enter the stack.
