# Life support (phase 4)

Keep abandoned or dying canisters from being deleted, at minimum cost, so they can be adopted and revived later.

This is **preservation, not restoration**. A frozen canister rejects calls and burns only its idle (storage) cost. At zero cycles it is uninstalled and its code and state are deleted. Life support sends small top-ups so the balance stays above zero but **below the freezing threshold**. The canister stays frozen on purpose: that is the cheapest state in which it still exists.

**This spends real money. It ships OFF.** The kill switch is engaged by the migration, the global cap defaults to 1 T cycles (about 1 XDR, about 1.37 USD), and the funded path refuses to run unless every gate below is open.

## Files

| File | What |
|---|---|
| `src/lifesupport/planner.ts` | Pure planner: `planTopUp`, `monthlyCost`, `verifyTopUp`, `reserve`. No I/O. |
| `src/lifesupport/engine.ts` | Live gate, budget layer, audit log, tick, anomaly handling, admin helpers, registry data. |
| `src/lifesupport/funding.ts` | The only code that can sign: ICP ledger transfer + CMC `notify_top_up`. Also the read-only rate query. |
| `src/pages/lifesupport.tsx` | `LifeSupportRegistryPage`: registry with cost numbers and the public audit log. |
| `migrations/0004_lifesupport.sql` | `ls_settings`, `ls_attempts`, `ls_lease`, `ls_audit`, and the guard triggers. Depends only on 0001. |
| `test/lifesupport.test.ts` | Unit tests, engine tests on real SQL, and the long-run simulation. |

## Safety model

Four independent layers. Each one alone prevents runaway spend.

1. **The gate (code).** `liveGate()` requires ALL of: the caller passed `dryRun: false`, env `LIFE_SUPPORT_ENABLED === "true"` (exactly that string), secret `LIFE_SUPPORT_IDENTITY` present, DB kill switch released, global cap not exhausted. Anything else is a dry run: plans are computed and logged, nothing is signed. `lifeSupportTick(env)` with no options is a dry run.
2. **The planner (pure, tested).** Decides whether and how much. Refuses by default: see the table of refusal codes below.
3. **The database (constraints).** Before any ICP moves, spend is reserved in ONE D1 batch (one transaction): idempotency row, global spend, canister spend, audit row. The database itself rejects the batch, and rolls back all four statements, when:
   - the kill switch is engaged (trigger on `ls_settings` and on `ls_attempts`),
   - `global_spent_cycles` would exceed `global_cap_cycles` (CHECK),
   - the canister's `spent_cycles` would exceed its `budget_cycles`, or it is not `active` (triggers),
   - the canister already had an attempt this UTC day (UNIQUE index on `ls_attempts`).
   A bug in the Worker cannot overspend, because the row that authorizes the payment cannot be written.
4. **Verification and the automatic kill switch.** After every live top-up the engine re-reads the canister through the same certified source and probes it. If the balance did not rise by about the minted amount, the canister is no longer frozen, the balance is at or above the threshold, the reading is missing, or the mint differs from the plan by more than 15%, it writes the failure to the audit log, opens a `life_support_anomaly` incident, alerts the owner, and **engages the kill switch**. Nothing is spent again until a person releases it.

Concurrency: a lease row (`ls_lease`, 5 minute expiry) lets only one tick run the funded path, and the UNIQUE daily slot is the second line. At most `max_topups_per_tick` (default 3) top-ups per tick.

### Append-only audit log

`ls_audit`, `ls_attempts`, and the legacy `topup_log` are INSERT-only. There is no UPDATE or DELETE against them anywhere in the code, and the migration installs triggers that make the database reject both (`ls_audit is append-only`). A correction is a new row. Every stage of an attempt is its own row linked by `attempt_id`: `reserve`, `transfer` (with the ICP ledger block index), `notify` (minted cycles), `verify` (before, after, still frozen), `release`, `anomaly`, `recover`. Dry-run plans and refusals are logged with `mode = dry_run` and the full plan JSON, deduplicated to one row per canister per decision per day. Admin actions (enroll, caps, kill switch) are logged with `mode = admin`.

Because a crash can happen between stages, the log is also the recovery journal: a `transfer` row without a `notify` result is finished by the next live tick (`notify_top_up` is permissionless and idempotent per block index, valid for about 24 h). A `reserve` row without `verify` or `release` blocks that canister (`attempt_unresolved`) until it is resolved.

## The math

```
T      = idle_burn_per_day * freezing_threshold_s / 86400     freezing threshold in cycles
T_eff  = T - reserved_cycles                                  when reserved cycles are known
H      = min(30 days * idle, 0.45 * T_eff)                    high water, the refill target
L      = min(max(5 days * idle, 0.1 B), H / 2)                low water, the refill trigger
amount = H - balance          only when balance < L, rounded DOWN to whole e8s
cost   = amount + ledger fee  (fee = 10_000 e8s * rate, charged to budgets and caps)
```

Why 0.45: the worst realistic failure is a top-up that lands twice (double spend, or a reading of zero while the true balance sits at high water). `balance + 2 * amount * 1.10 < T_eff` is asserted for every plan, so even a duplicate plus a 10% conversion-rate slip leaves the canister frozen. For the estimated-idle case (blackhole source) the fraction is 0.30. `setCaps` refuses fractions above these.

Why L is 5 days: it is the outage tolerance. Cron down, IC unreachable, kill switch engaged over a weekend: the canister has at least 5 days (threshold permitting) before it dies.

T scales with idle burn. If memory grows or the subnet reprices storage, idle burn rises, T rises with it, and every plan is recomputed from the fresh reading, so the band moves with the canister. If a controller lowers `freezing_threshold`, T shrinks: balances above the new T mean the canister unfroze by its controller's action, and life support stops (`not_frozen`).

### Worked example

A canister with idle burn 0.002 T/day and the default 30 day threshold, at 2.16 XDR per ICP and 1.37 USD per XDR (1 XDR always buys 1 T cycles):

| Quantity | Value |
|---|---|
| T | 0.002 * 30 = **0.060 T** |
| High water H | min(0.060, 0.45 * 0.060) = **0.027 T** (13.5 days of runway, 45% of T) |
| Low water L | min(max(0.010, 0.0001), 0.0135) = **0.010 T** (5 days) |
| Typical top-up | 0.027 - 0.010 = **0.017 T**, buys 8.5 days, about 3.5 top-ups a month |
| ICP per top-up | 0.017 XDR / 2.16 = 0.00787 ICP + 0.0001 fee = **0.00797 ICP** (about 0.024 USD). Fee overhead 1.3% |
| Worst case | 0.010 + 2 * 0.017 * 1.1 = 0.0474 T, still under 0.060 T |
| Monthly cost | 0.060 T idle + 3.53 * 0.000216 T fees = **0.0608 T = 0.0281 ICP = 0.083 USD** |
| Yearly cost | about 0.73 T, about **1.00 USD** |

The simulation reproduces this: see below.

### Refusal codes

`not_enrolled`, `not_active`, `kill_switch` (plan still computed for display), `reading_missing`, `reading_not_measured` (only certified controller readings: `sns-root`, `nns-root`, `blackhole`; never probes, inferred values, or the canister's own `/metrics`), `reading_stale` (older than 2 h), `threshold_unknown`, `idle_zero` (system subnet: free, nothing to do), `idle_unknown` (the blackhole returns no idle burn: skipped unless our own readings cover 3+ days observed while frozen AND a live probe says frozen), `not_frozen` (**a running canister is never funded**: that is restoration, and a griefing vector), `in_band`, `threshold_too_short` (high water under 2 days of runway: needs a human), `no_corroboration` (needs two measured readings, both frozen, 10 min to 48 h apart), `reading_inconsistent` (readings do not add up with idle burn, or the balance is far below what our last verified top-up predicts: halts), `too_soon`, `rate_unknown`, `below_min` (dust: the ledger fee is more than 10x the cycles delivered), `above_max_single`, `budget_exceeded`, `global_cap_exceeded`, `daily_cap_exceeded`. Partial top-ups are allowed only if they still reach low water.

Severity `halt` (engages the kill switch): a preserved canister found at or above its threshold, a balance far below the last-top-up anchor, any failed verification, any unknown transfer or notify outcome.

## Evidence: the simulation

`npx vitest run test/lifesupport.test.ts` (46 tests). The simulation runs planner + budget ledger hour by hour against a model canister with 0.3% reading noise and up to 3% mint slip per top-up:

- **Two years** with a worst-timed 4 day outage (starts the moment a refill is due), +25% idle burn at day 200, ICP/XDR moving 2.16 to 1.5 to 3.0, and the freezing threshold cut from 30 to 20 days: 109 top-ups, never deleted (minimum 0.94 days of runway, during the outage), never unfrozen, **peak 46.0% of T**, spent 1.7495 T against a predicted 1.7524 T (**ratio 0.998**), worst rolling 30 day window 1.27x its prediction, about 0.10 USD a month.
- **Parameter sweep** (idle 30 M to 4 B per day, thresholds 7 to 180 days): never deleted, never unfrozen, spend within 10% of prediction.
- **Budget exhaustion**: spending stops dead at the cap. The canister is eventually lost, which is the honest outcome, and the registry shows months of budget remaining long before.
- **Adversarial, external top-up above T**: not one cycle spent afterwards, flagged, kill switch engaged.
- **Adversarial, flapping readings** (every other reading claims the canister is nearly empty) and **consistently forged low readings**: never spends more than the honest run, never exceeds 50% of T, trips the kill switch on `reading_inconsistent`.

The engine tests run the real SQL (migrations 0001 + 0004) with a fake funder: dry run by default, every gate combination, the full reserve/transfer/notify/verify sequence, no double spend across ticks or overlapping ticks, release on ledger rejection, kept reservation on unknown outcome, recovery of a lost notify without a second payment, and the verification-failure path (kill switch + incident + alert). The migration was also applied to a real local D1 (miniflare, isolated state) to confirm the triggers parse and fire there.

## Funding path

### Recommended and implemented: ICP ledger transfer, then CMC `notify_top_up`

1. `icrc1_transfer` on the ICP ledger `ryjl3-tyaaa-aaaaa-aaaba-cai` to `{ owner = CMC rkp4c-7iaaa-aaaaa-aaaca-cai, subaccount = [len(principal)] ++ principal bytes ++ zero padding to 32 }`, memo = 8 byte little-endian `0x50555054` ("TPUP"), fee 10_000 e8s, `created_at_time` set (the ledger deduplicates identical transfers for 24 h, so a retry cannot pay twice).
2. `notify_top_up({ block_index, canister_id })` on the CMC. Returns the cycles minted. Permissionless and idempotent per block.

Verified on 2026-09-21 by reading the live canisters' `candid:service` metadata with an anonymous `read_state` (`CanisterStatus.request`, paths `candid` and `module_hash`), plus anonymous queries:

- ICP ledger (module `51f4be01...`): `icrc1_transfer : (TransferArg) -> (variant { Ok : nat; Err : ... })`, `TransferArg = record { from_subaccount : opt blob; to : Account; amount : nat; fee : opt nat; memo : opt blob; created_at_time : opt nat64 }`. `icrc1_fee` = 10_000 e8s.
- CMC (module `c5e9adf7...`): `notify_top_up : (record { block_index : nat64; canister_id : principal }) -> (variant { Ok : nat; Err : NotifyError })` with `NotifyError = Refunded | Processing | TransactionTooOld | InvalidTransaction | Other`. `get_icp_xdr_conversion_rate` is an anonymous query, returned `xdr_permyriad_per_icp = 21236` (2.1236 XDR per ICP).
- CMC source (`rs/nns/cmc/src/main.rs`): `get_u64_memo` accepts the legacy nat64 memo or an 8 byte little-endian `icrc1_memo`; the top-up subaccount is `Subaccount::from(&canister_id)` as above; minting uses the CMC's current rate (not the 30 day average): `cycles = e8s * xdr_permyriad_per_icp`.
- Cycles ledger `um5iw-rqaaa-aaaaq-qaaba-cai` (module `ed994025...`): `withdraw : (record { to : principal; from_subaccount : opt blob; created_at_time : opt nat64; amount : nat }) -> (variant { Ok : nat; Err : WithdrawError })`, `icrc1_fee` = 100_000_000 cycles.

Minimum practical top-up: the fee is worth 10_000 * 2.16 = 216 M cycles. The planner rejects top-ups that deliver less than 10% of that, or less than 20 M cycles. For typical canisters the fee is 1 to 2% of a refill.

The rate query is made with query signature verification ON (it sizes a payment), and a rate that moved more than 2x since the last accepted one is refused. A rate misreported at half its true value would double the mint, which is exactly the duplicate case the 0.45 band already absorbs.

### Alternatives

| Path | Cost per top-up | Calls | Needs | Verdict |
|---|---|---|---|---|
| **ICP ledger + CMC notify** | 0.0001 ICP (about 216 M cycles) | 2 updates | only ICP in the Worker identity's account | **Use now.** Works from a Worker, nothing to deploy, funded from any wallet, both calls idempotent. Downsides: two-step (handled by the recovery journal) and the mint depends on the rate at notify time (handled by the band and verification). |
| Cycles ledger `withdraw` | 100 M cycles | 1 update | a cycles balance on the cycles ledger (convert ICP once with `dfx cycles convert` or CMC `notify_mint_cycles`) | **Best upgrade once volume justifies it.** Half the fee, one atomic call, exact cycle amounts (no rate or rounding exposure), budget held in XDR terms. Downside: an extra manual conversion step when funding, and cycles cannot be converted back. The `Funder` interface is the seam: add a second implementation, nothing else changes. |
| Our own canister calling `deposit_cycles` | no fee per deposit | 1 update to our canister | deploying, funding, and monitoring a canister that can itself freeze | **Not now.** It adds a thing that needs life support. It becomes the right answer when third parties fund canisters (next section), because custody and caps can then live on chain. |

### Designed for, not built: others funding specific canisters

Budgets are already per canister (`life_support.budget_cycles`) and the audit log is per canister. To let users or DAOs fund one: give each enrolled canister a deposit subaccount of the funding principal (same derivation as the CMC subaccount), credit confirmed deposits to that canister's budget through a new append-only `ls_contributions` table, and keep the global cap as the operator's own exposure. The planner and gates do not change.

## Go-live checklist (owner)

1. Apply the migration: `wrangler d1 migrations apply icpwatch --remote`. Check `GET /admin/life-support/status`: kill switch engaged, cap 1 T.
2. Create the identity: `openssl rand -hex 32`, then `wrangler secret put LIFE_SUPPORT_IDENTITY`. Keep a copy offline: it holds funds.
3. `GET /admin/life-support/status` now shows the funding principal. Send a small amount of ICP to it (0.5 ICP covers the example canister for over a year). Exchanges that need an account id: `dfx ledger account-id --of-principal <principal>`. Status shows the balance.
4. Optional: `wrangler secret put LIFE_SUPPORT_ALERT_WEBHOOK` (Discord webhook) for owner alerts.
5. Set caps: `POST /admin/life-support/caps` with `globalCapCycles`, `dailyCapCycles`, `maxSingleTopUpCycles`. Start small.
6. Enroll one test canister that is frozen and has a certified source: `POST /admin/life-support/enroll` with a small `budgetCycles` (for the example: 200000000000 = 0.2 T, about 3 months).
7. Dry run: `POST /admin/life-support/tick` (default is dry run). Read the plan in `ls_audit` or on the registry page: amount, threshold, band, ICP, rationale. It needs two readings, so the first tick may say `no_corroboration`.
8. Set `LIFE_SUPPORT_ENABLED = "true"` (wrangler var) and deploy.
9. Release the kill switch: `POST /admin/life-support/kill-switch` with `{"on": false, "reason": "go live"}`.
10. First live top-up by hand: `POST /admin/life-support/tick` with `{"dryRun": false}`. Check the `verify` row: `after_frozen = 1`, balance near 45% of threshold. Then let the cron run.

To stop everything at any time: `POST /admin/life-support/kill-switch {"on": true}`, or unset `LIFE_SUPPORT_ENABLED`, or delete the secret. Any one is enough.

## Failure modes

| What happens | Result |
|---|---|
| Cron or IC down | Nothing is spent. Low water leaves about 5 days. The simulation covers a worst-timed 4 day outage. |
| Worker dies after transfer, before notify | ICP sits in the CMC subaccount. The next live tick calls `notify_top_up` again (recover stage). Anyone can also call it by hand within about 24 h. |
| Transfer outcome unknown (timeout) | Reservation kept (conservative), kill switch engaged, canister blocked as `attempt_unresolved`. Owner checks the ledger, then releases the switch. |
| Ledger rejects the transfer (no funds, bad fee) | Reservation released in the same batch as the log row, owner alerted. Insufficient funds does not engage the kill switch. |
| CMC refunds (`Refunded`) | Logged, kill switch engaged. The refund minus fees returns to the funding account. The reservation stays charged: reconcile by raising the cap, never by editing the log. |
| Rate moves between plan and mint | Absorbed by the band. More than 15% off plan fails verification and halts. |
| Someone else tops the canister up past T | `not_frozen`, halt, nothing further is sent. A running canister is never funded. |
| Controller lowers the freezing threshold | Same: the canister runs on what it has, we stop. |
| Reserved cycles on the canister | The replica subtracts reserved cycles from the threshold. The status sources used today do not report them, so the 0.45 band is the margin. If a probe says running while the balance is under the computed T, the planner refuses and flags. |
| Malicious controller source (an SNS root lying about its own canister) | Certified readings cannot be forged by third parties, only by the controller itself. Loss is bounded by that canister's budget, and the corroboration and anchor checks catch inconsistent stories. |
| D1 refuses the reservation | No ICP moves. Logged as `reserve_refused`. |
| Tiny canister or very short threshold | `below_min` or `threshold_too_short`, flagged for a human. Short thresholds also mean less outage tolerance (L is capped at H / 2). |

## What could not be verified without real funds

The signed `icrc1_transfer` and `notify_top_up` calls have never been executed: their candid matches the live canisters and the memo and subaccount rules match the CMC source, but the first live top-up is the first real test (hence step 10, by hand, tiny budget). Also untested live: how quickly an SNS root or NNS root status read reflects a deposit, CPU cost of query signature verification inside workerd, and D1's production rollback behavior for a batch aborted by a trigger (verified on SQLite and on local D1).
