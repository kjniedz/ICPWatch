# ICPWatch

Markets, network activity, and canister health for the Internet Computer. One brand, three sections:

- **Lifeline**: canister health monitoring, alerting, and (later) low-cost preservation. The differentiator.
- **Markets**: token prices aggregated across ICP DEXs, liquidity location, holders, and a Lifeline health badge on every token.
- **Network**: global search, subnets by burn, readable NNS governance.

Live at [icpwatch.com](https://icpwatch.com).

## Stack

One Cloudflare Worker does everything: pages, JSON API, and collectors.

| Piece | Choice | Why |
|---|---|---|
| Rendering | Hono + server-rendered JSX, no client framework | First load is HTML from the edge, not a bundle. Competitors are slow because they are SPAs that fetch after load. |
| Client JS | About 7 KB of vanilla islands (`client/app.ts`), chart island loaded only where needed | Sort, filter, watchlist, live refresh, search suggest. |
| Navigation | Cross-document View Transitions + Speculation Rules prefetch | Instant-feeling navigation without a router. |
| Storage | D1 (SQLite) | Time series, registry, incidents, subscriptions. |
| Collectors | Cron triggers in the same Worker | One deploy, one set of bindings. |
| IC access | `@icp-sdk/core` over fetch | Runs in workerd with no Node APIs. |
| Charts | TradingView lightweight-charts (Apache 2.0) | Candles and area series. |

Nothing here was copied from `CyberNinjasLab/icp-tokens-dapp`. It has no license and was used only as a feature checklist.

## Layout

```
src/index.tsx            routes, JSON API, admin endpoints, cron dispatch
src/lib/health.ts        projections, classification, burn baseline, incident state machine (pure, tested)
src/lib/ic.ts            every call to the IC: controller status reads, metrics, probes, discovery
src/collectors/          discovery (hourly), lifeline (10 min), markets (5 min), network (hourly), ledgerApi
src/alerts/notify.ts     email, Telegram, Discord, signed webhooks, dedup
src/pages/, src/ui/      server-rendered pages and shared components
client/                  browser islands and the stylesheet
migrations/              D1 schema
test/                    vitest: health engine and simulated incidents
```

## How Lifeline reads balances nobody is supposed to see

A canister's cycle balance is visible only to its controllers, so every public path is used and every number is labeled with how it was obtained (measured, inferred, probed, unknown).

1. **SNS root `get_sns_canisters_summary`**: one certified update call returns cycles, idle burn, freezing threshold, memory, controllers, and module hash for every canister an SNS owns, archives and dapps included.
2. **NNS root `canister_status`**: works anonymously for everything NNS root controls: ICP ledger, index, archives, every ck suite, and community ledgers that added NNS root as a controller (BOB, EXE, TAGGR).
3. **`/metrics` via an `http_request` query**: DFINITY ledger, index, and archive wasms report their own balance. Queried directly through the API boundary node, because the HTTP gateway refuses some canisters (ICP index) and the certified domain rejects uncertified responses.
4. **ninegua blackhole `canister_status`**: for canisters that list it as a controller. CycleOps blackholes refuse outside callers.
5. **Probes**: a query to a method known to exist (frozen canisters answer IC0207), or for arbitrary canisters an update call to a method that does not exist. The ingress filter answers before method lookup: frozen IC0207, stopped IC0508, missing IC0301.

Two traps worth knowing:

- A controller reports `status = running` for a frozen canister. Freezing is a function of balance and threshold, so frozen state is derived from the balance and from probes, never from that field. (The iDoge ledger is the live example.)
- A query to a method that does not exist returns IC0536 for healthy and frozen canisters alike, so a bogus-method *query* cannot see freezing. Only a real method or an update call can.

Archives are discovered from each ledger (`icrc3_get_archives`, then legacy `archives`) on every hourly run, so new archives are picked up without anyone adding them.

## Alerts

Types: low cycles, frozen, approaching deletion, burn-rate anomaly. The state machine in `src/lib/health.ts` opens an incident once, ignores it while it stays tripped, and resolves it once after the recovery condition holds for consecutive evaluations (hysteresis band between trip and recovery). Burn anomalies compare the last six hours against the median and MAD of that canister's own daily burn, so a canister that is always busy does not fire. The `notifications` table has a unique key on (incident, subscription, kind) as a last line of defense, and someone subscribed to both a canister and its token gets one message.

`POST /admin/simulate` pushes a simulated incident through the real notification path (marked simulated everywhere) to verify channels and dedup.

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

Deploy: `npm run db:migrate:remote && npm run deploy`. Requires the Workers Paid plan: certified update calls verify a BLS signature in pure JS (roughly 70 to 100 ms of CPU each), far beyond the free plan's 10 ms.

### Secrets

| Secret | Purpose |
|---|---|
| `ADMIN_TOKEN` | Bearer token for `/admin/*` |
| `RESEND_API_KEY`, `EMAIL_FROM` | Alert email. Without them email subscriptions are stored but not confirmed. |
| `TELEGRAM_BOT_TOKEN` | Telegram alerts |

Discord and webhook alerts need no secrets.

## Cost and safety

Nothing in this repo spends ICP or cycles. Anonymous update calls are paid for by the target canister (a status read or an ingress fee, fractions of a cent). Phase 4 (life support top-ups) is the first thing that will spend, and it is not built: only its tables and the public registry page exist.

## Data sources and honesty rules

See `/data-sources` on the site. Third-party sources (ICPSwap info API, DFINITY's ICRC ledger API and IC public API) sit behind adapters in `src/collectors/` and are labeled as third party in the UI. Every number shows its source and age, and an honest "unknown" beats a confident guess.

## Roadmap

1. Lifeline monitoring and alerts (this release)
2. Markets parity and beyond: own block indexer for holders and transfers, SNS treasury and neuron stats, more DEX adapters as venues earn liquidity
3. Network: account pages, canister upgrade history via `canister_info`, on-chain subnet registry
4. Life support: capped, budgeted, audited top-ups that keep a canister frozen but alive
