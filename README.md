# ICPWatch

Markets, network activity and canister health for the Internet Computer, live at [icpwatch.com](https://icpwatch.com). One Cloudflare Worker renders the pages, serves the JSON API and runs the collectors.

- **Lifeline**: canister health monitoring and alerting. Cycle balances, freezing, burn-rate anomalies, controller and module changes, with every number labeled by how it was obtained (measured, inferred, probed, unknown).
- **Markets**: token prices across ICP DEXs, where the liquidity sits, holders and concentration from ICPWatch's own ICRC block indexer, and a Lifeline health badge on every token.
- **Network**: global search, subnets by burn, readable NNS governance, SNS DAO analytics, account and canister pages with on-chain upgrade and controller history.

## Stack

| Piece | Choice |
|---|---|
| Rendering | Hono with server-rendered JSX. First load is HTML from the edge, not a bundle. |
| Client | About 7 KB of vanilla islands (`client/app.ts`) for sort, filter, watchlist, live refresh and search; a chart island (TradingView lightweight-charts) only where needed. Cross-document View Transitions and Speculation Rules prefetch instead of a router. |
| Storage | D1 (SQLite): time series, registry, incidents, subscriptions, indexed blocks. |
| Collectors | Cron triggers in the same Worker: discovery and network hourly, lifeline every 10 minutes, markets every 5. |
| IC access | `@icp-sdk/core` over fetch, so it runs in workerd without Node APIs. |

## Layout

```
src/index.tsx            routes, JSON API, admin endpoints, cron dispatch
src/lib/health.ts        projections, classification, burn baseline, incident state machine (pure, tested)
src/lib/ic.ts            every call to the IC: controller status reads, metrics, probes, discovery
src/collectors/          discovery, lifeline, markets, network, sns, history, accounts, ledgerApi
src/indexer/             own ICRC block indexer: balances, holders, concentration, large transfers
src/alerts/notify.ts     email, Telegram, Discord, signed webhooks, dedup
src/pages/, src/ui/      server-rendered pages and shared components
client/                  browser islands and the stylesheet
migrations/              D1 schema
test/                    vitest: health engine and simulated incidents
docs/                    ROADMAP.md, LIFE_SUPPORT.md
```

## How Lifeline reads balances nobody is supposed to see

A canister's cycle balance is visible only to its controllers, so Lifeline uses every public path there is:

1. **SNS root `get_sns_canisters_summary`**: one certified call returns cycles, idle burn, freezing threshold, memory, controllers and module hash for every canister an SNS owns.
2. **NNS root `canister_status`**: works anonymously for everything NNS root controls (ICP ledger, index, archives, the ck suite) and for community ledgers that added NNS root as a controller.
3. **`/metrics` over an `http_request` query**: DFINITY's ledger, index and archive wasms report their own balance. Queried through the API boundary node, because the HTTP gateway refuses some canisters.
4. **ninegua blackhole `canister_status`** for canisters that list it as a controller.
5. **Probes**: a query to a method known to exist (frozen canisters answer IC0207), or an update call to a method that does not exist (frozen IC0207, stopped IC0508, missing IC0301; the ingress filter answers before method lookup).

Two traps: a controller reports `status = running` for a frozen canister, so frozen state is derived from balance, threshold and probes, never from that field; and a query to a bogus method returns IC0536 for healthy and frozen canisters alike, so only a real method or an update call can see freezing. Archives are rediscovered from each ledger (`icrc3_get_archives`, then legacy `archives`) every hour.

## Alerts

Low cycles, frozen, approaching deletion, burn-rate anomaly, controller change, module change. The state machine opens an incident once, holds it while tripped, and resolves it once the recovery condition has held for consecutive evaluations. Burn anomalies compare the last six hours against the median and MAD of that canister's own daily burn, so a busy canister does not fire. A unique key on (incident, subscription, kind) is the last line of defense against duplicates, and `POST /admin/simulate` pushes a simulated incident through the real notification path.

## Running it

```sh
npm install
npm run db:migrate:local
echo "ADMIN_TOKEN=localdev" > .dev.vars
npm run dev                      # http://localhost:8787

# fill the local database from the live IC
for job in discovery markets network lifeline-full whales; do
  curl -X POST -H "authorization: Bearer localdev" http://localhost:8787/admin/run/$job
done

npm test
npm run typecheck
```

Deploy with `npm run db:migrate:remote && npm run deploy`. The collectors need the Workers Paid plan: certified update calls verify a BLS signature in pure JS (70 to 100 ms of CPU each), well past the free plan's 10 ms limit. On the free plan the site still serves, and the database can be filled from a local run.

Secrets: `ADMIN_TOKEN` (bearer for `/admin/*`), `RESEND_API_KEY` and `EMAIL_FROM` (alert email), `TELEGRAM_BOT_TOKEN` (Telegram alerts). Discord and webhook alerts need none.

## Cost and safety

Anonymous update calls are paid for by the target canister, fractions of a cent each. The indexer writes roughly 19M D1 rows on the initial backfill and about 4M a month after that.

**Life support, the capped and audited top-up that keeps a canister frozen but alive, is the only thing that can spend money, and it is off by default.** The cron runs it as a dry run until `LIFE_SUPPORT_ENABLED` is exactly `"true"`, a funding identity secret is set and the database kill switch is released. Caps, budgets, one attempt per canister per day and append-only audit tables are enforced by the database. See `docs/LIFE_SUPPORT.md`.

## Data sources

Third-party sources (ICPSwap's info API, DFINITY's ICRC ledger API and IC public API) sit behind adapters in `src/collectors/` and are labeled as third party in the UI. Every number on the site shows its source and age, and an honest "unknown" beats a confident guess. The full list is at [icpwatch.com/data-sources](https://icpwatch.com/data-sources).

## License

MIT, see `LICENSE`.
