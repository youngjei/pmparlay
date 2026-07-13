# Reference Repos

Use these as product and engineering references. Do not copy code blindly; licenses and architecture fit matter.

## Trader-facing product

- [Uniswap/interface](https://github.com/Uniswap/interface): quote state, token search, approval/review sequencing, wallet-aware order flow.
- [manifoldmarkets/manifold](https://github.com/manifoldmarkets/manifold): prediction-market discovery, compact market cards, buy/sell flows, pragmatic `web` / `backend` / `common` boundaries.
- [saleor/storefront](https://github.com/saleor/storefront): cart and checkout flow patterns that map well to a parlay bet slip.

## Operations and analytics

- [saleor/saleor-dashboard](https://github.com/saleor/saleor-dashboard): dense admin UI, filters, tables, Storybook, Playwright discipline.
- [supabase/supabase](https://github.com/supabase/supabase): monorepo structure, Studio-style data explorer, local development wiring.
- [grafana/grafana](https://github.com/grafana/grafana): time-range filtering, panels, alerting, and monitoring dashboards.

## What to avoid

- Generic admin templates that only look polished in screenshots.
- Crypto-casino visual language for a product that needs trust.
- Pulling in GPL/AGPL/FSL code without confirming license fit.
- Frontend-only trading keys, hidden custody assumptions, and opaque quote math.
