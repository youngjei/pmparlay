# LEGWORK Bug And Security Report - 2026-07-08

## Summary

This report covers the bugs found after the local rerun where APIs stopped working, the live wallet ticket did not appear in Portfolio, and Markets kept showing the same stale set.

The root problem was not one bug. It was a missing end-to-end smoke gate across API availability, wallet identity, market freshness, and Portfolio data. The app had unit coverage for repositories and API routes, but not enough product-level checks for the real local run path.

## Bugs Found And Fixed

### 1. Frontend Was Running Without Backend API

Impact: Markets, wallet sync, account, tickets, and checkout all failed because Vite proxied `/api/*` to `127.0.0.1:8787`, but the API process was not running.

Fix:
- Started `npm run dev:api`.
- Confirmed `/readyz` returns OK.
- Confirmed `/api/markets` works through both API and Vite proxy.

Prevention:
- Use `npm run dev:local`, not `npm run dev`, for local product testing.
- Add a visible app-level API health banner if `/readyz` fails.

### 2. Market API Timed Out And Returned 500

Impact: Polymarket live CLOB hydration can exceed the request timeout. Without a hot cache, `/api/markets` returned `internal_server_error`.

Fix:
- `server/marketCatalog.ts` now returns persisted market data immediately when live refresh is stale or slow.
- Live refresh continues best-effort instead of blocking the user-facing market list.

Remaining risk:
- Freshness still depends on `npm run index:markets` or a running market indexing worker.

### 3. Persisted Market Catalog Mixed Fresh And Old Snapshots

Impact: The market list kept showing old markets because the persisted query mixed markets from older snapshots with the latest index.

Fix:
- `server/db/marketRepository.ts` now serves only markets from the latest indexing window.
- Catalog `asOf` now reports the newest selected snapshot, not the oldest one.
- Frontend also filters ended rows defensively.

Result:
- API now returns `endedOutcomes: 0` in the local verification check.
- UI smoke check renders `96` market cards instead of the old hard cap of `42`.

### 4. Frontend Hard-Capped Markets At 42

Impact: Even when the backend had hundreds of live outcomes, the UI always showed the same 42 sorted rows.

Fix:
- Increased frontend display cap to `96`.
- Added frontend ended-market filtering.

Remaining improvement:
- Add pagination or infinite scroll instead of a fixed cap.

### 5. Wallet Identity Drift Hid Existing Tickets

Impact: A live ticket existed for wallet `0xce59...e492`, but Portfolio could show an empty account if Privy issued a different `privy_user_id` on reconnect.

Fix:
- `syncPrivyUserWallets` now treats verified wallet address as the durable LEGWORK account identity.
- If the wallet already belongs to an existing LEGWORK user and the new Privy user is empty, the Privy id is moved onto the wallet owner.
- Local DB was repaired so the known test wallet maps back to the user with the live ticket.

Remaining risk:
- This wallet-merge path needs an integration test with a real mocked Privy identity-token payload.

### 6. Quote Errors Were Hidden Behind Generic Copy

Impact: Backend errors like `unauthorized`, quote timeout, or executable price failure were rendered as `Quote service unavailable.`

Fix:
- Frontend now maps backend quote errors to specific user-facing messages.
- `/api/quotes` uses the same configurable market fetch timeout as `/api/markets`.

## Security And Abuse Review

### What Is Already In Place

- Fastify Helmet enabled.
- CORS restricted to `WEB_ORIGIN`.
- Global rate limit registered through `@fastify/rate-limit`.
- Redis-backed rate limiting supported for production.
- Ops routes require `OPS_API_KEY` in production.
- Quote creation and acceptance support idempotency keys.
- Database schema has uniqueness constraints, checks, and foreign keys for core money/ticket flows.
- Production config refuses to boot without required database, treasury, Privy, and RPC config.
- `npm audit --omit=dev` found `0` vulnerabilities.
- `.env` is gitignored.

### Security Gaps To Close Before Real Money

- Require Redis rate limits in production, not memory limits.
- Add stricter per-route limits for quote creation, payment submission, auth sync, withdrawal requests, and ops routes.
- Add an API health/dependency banner in the UI so missing backend does not look like product data bugs.
- Move all secrets to a real secret manager before deployment.
- Rotate the Safe API key that was pasted into chat before any production use.
- Enforce production database SSL and least-privilege DB users.
- Add database backup/restore runbooks.
- Add an append-only audit export for ledger, treasury, withdrawal, and settlement actions.
- Add alerts for failed market indexing, stale market catalog age, failed deposit scans, failed settlement scans, and quote timeout rate.
- Add E2E tests for the full local run path: API up, markets visible, wallet sync, ticket appears in Portfolio, quote opens, payment intent created.

## Validation Run

- `npm test`: 76/76 passed.
- `npm run typecheck:api`: passed.
- `npx tsc --noEmit`: passed.
- `npm run build -- --logLevel error`: passed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- API `/readyz`: database connected.
- API `/api/markets`: returns fresh persisted catalog with 0 ended outcomes in verification.
- Playwright smoke: 96 market cards, no `No live markets loaded`, no console errors.

## Current Local State

- Frontend: `http://localhost:5173`
- API: `http://127.0.0.1:8787`
- Test wallet `0xce59...e492` maps to the LEGWORK user with 1 live ticket.
- Market catalog was refreshed with `npm run index:markets`.

## Recommended Next Work

1. Add a first-class local `dev:product` command that starts frontend, API, and a safe market-refresh loop.
2. Add E2E Portfolio identity tests for reconnect/new Privy id/same wallet.
3. Add market freshness monitoring and a UI freshness indicator.
4. Add production rate-limit profiles per route.
5. Add secret manager and production DB hardening before real-money deployment.
