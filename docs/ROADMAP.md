# Roadmap

Status key: shipped, building, next, later. Order inside a tier is priority order.

## Tier 1: the moat

1. **Own block indexer** (shipped; ICP ledger backfilling). Replays ICRC ledger blocks into balances, holder stats, large transfers, and daily activity. Unlocks holder counts over time, active accounts, velocity, cohorts, exchange flows, and account pages. ICP ledger (different block format, 38M blocks) follows the ICRC ledgers.
2. **Entity labeling** (shipped). Exchanges, SNS treasuries, known neurons, team wallets, DEX pools, bridge minters. Seed from on-chain facts we already hold (SNS governance and treasury accounts, minters, DEX pool canisters, known neurons), then user-submitted labels with a review queue. Labels render everywhere an account or principal appears.
3. **Token trust score** (shipped, method 1.0). One score per token from: who controls the ledger (SNS, blackholed, single principal), whether supply can still be minted (minting account and controller analysis), top holder concentration (indexer), liquidity depth (DEX adapters), Lifeline health, upgrade frequency (canister history). Every input shown with its evidence, never a bare number.

## Tier 2: things only ICP has

4. **Chain Fusion reserves** (shipped). ckBTC, ckETH, ckUSDC and the other ck assets: minter reserves on the native chain versus supply on ICP, mint and burn flows, peg deviation. Natural home for ckLTC when it ships.
5. **Cycles economy** (next). ICP burned to mint cycles versus issuance from voting and node provider rewards: net inflation in real time. Sources: CMC `cmc_cycles_minted_total`, governance reward events, ledger burn totals.
6. **SNS analytics** (shipped). `/sns` dashboard of every DAO (treasury, treasury as a share of market cap, swap ROI, neurons, voting power, turnout, proposals, trust, whole-DAO Lifeline health, dead DAOs marked), `/sns/proposals` cross-DAO feed with `sns_proposal` and `treasury_movement` alert types, `/sns/unlocks` dissolve calendar, `/sns/compare`, launches from open swaps and NNS SNS-creation proposals. Full holder pages at `/token/:id/holders` (paginated, searchable, CSV and JSON, SNS look-through, entity mix, balance bands, Gini and Nakamoto, daily holder snapshots) on reconciled ledgers only. Next: governance health scores and reward APY by lock length.
7. **Governance and staking** (later). Dissolve delay distribution, reward APY by lock length, known neuron voting records, staking calculator, neurons in the portfolio view where the owner supplies neuron ids.

## Tier 3: Lifeline as a security product

8. **Controller and upgrade alerts** (building). Alert when controllers change or a module hash changes. Fed by on-chain `canister_info` history.
9. **Verified builds** (later). Match deployed module hashes against reproducible builds from public repos, show a Verified source badge.
10. **Life support** (engine shipped, dry run; community top-ups shipped). Then embeddable "Lifeline healthy" badges for READMEs and sites: every badge is a backlink.

## Tier 4: distribution and revenue

11. **Public API and widgets** (shipped: free JSON API; next: keys, rate limits, embeddable widgets, paid tier).
12. **AI analyst** (later). "Ask ICPWatch" over our own data. Waits for the indexer and labels, because answers are only as good as the data layer.
13. **Pro tier** (later). Unlimited alerts, whale and controller alerts, API access, CSV and tax exports, sponsored life support.

## Principles that do not change

- On-chain reads first. Third-party sources sit behind adapters and are labeled.
- Every number shows its source and its age. An honest "unknown" beats a confident guess.
- Anything that spends cycles or ICP is flagged before it runs and is off by default.

## Shipped 2026-09-22, second brief (groups 1 to 10)

1. Token metadata: links with provenance and a corroboration rule (`/admin/meta/links`), original ICPWatch descriptions. Price and volume alerts (`/markets/alerts`).
2. Telegram bot (`/telegram`): commands, chat subscriptions, group feeds with hourly caps and quiet hours. Needs `TELEGRAM_BOT_TOKEN`.
3. Holder snapshots (`/token/:id/snapshot`, `/snapshots`): block-stamped, hashed, permanent.
4. Launchpad feed (`/markets/launchpad`, FomoWell on chain) with bundled-buy and creator-sold flags; `liquidity_drop` and `holder_dump` alerts.
5. Claimed project profiles (`/token/:id/claim`): controller payment, DAO motion, or domain proof. Never touches the trust score.
6. Smart money (`/markets/smart-money`) from our own large-transfer index.
7. Tax export (`/account/:id/export.csv`, Koinly and CoinTracker).
8. Cycles cost calculator (`/lifeline/calculator`) with measured-burn mode.
9. Decentralization table and exchange flows (`/markets/decentralization`, `/markets/exchange-flows`); hubs are inferred until a citable exchange label exists.
10. NFT collections (`/markets/nfts`) from each canister's own stats query.

