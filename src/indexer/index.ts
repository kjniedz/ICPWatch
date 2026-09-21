// Block indexer orchestration. One call to indexTick does a bounded amount of work inside a cron
// tick and leaves a durable cursor behind, so the next tick resumes exactly where this one stopped.
//
// A tick has three phases:
//   probe     listed tokens without index state get one: tip, fee, decimals, large-transfer threshold.
//   tail      ledgers that are caught up (or nearly) are polled for new blocks, six ledgers at a time,
//             one IC query each. Quiet ledgers are polled less often (next_check_at).
//   backfill  ledgers with a backlog are replayed one at a time with six parallel block fetches,
//             smallest backlog first, until the time or subrequest budget is spent.
// Replay reads archives directly (ledger.archives() gives the ranges) and falls back to following the
// ledger's archived_transactions callbacks. See store.ts for the commit protocol.
//
// ICRC ledgers only. TODO: the ICP ledger needs its own block reader (see ledger.ts).
import type { Env } from "../env";
import { ICP_LEDGER, classifyReject, pool } from "../lib/ic";
import { applyBlocks, defaultBigThreshold, newChunk, planCommit, type ChunkState, type Tx } from "./core";
import { IcRejectError, archivePage, ledgerArchives, ledgerDecimals, ledgerFee, ledgerPage, ledgerRange, ledgerSupply, newMeter, type ArchiveRange, type CallMeter } from "./ledger";
import {
  CursorMovedError, MAX_ACCOUNTS_PER_CHUNK, MAX_BIG_PER_CHUNK, commitChunk, dueForBackfill, dueForTail, getState, insertState, loadExisting, newDbMeter,
  recordError, setLedgerParams, tokenSeed, touchState, unprobedTokens, type DbMeter, type IdxStateRow, type TokenSeed,
} from "./store";

export interface IndexOptions {
  /** Wall-clock budget for the whole tick. The last slice is reserved for committing. */
  budgetMs: number;
  /** Only these ledgers, ignoring poll schedules and backoff. Ledgers need not be in the tokens table. */
  ledgers?: string[];
  /** Cap on ledgers handled per phase (tail and backfill each). Default 60. */
  maxLedgersPerTick?: number;
  /** Large-transfer threshold in base units per ledger. The caller knows USD prices, the indexer does not. */
  minAmountRaw?: Record<string, string | bigint>;
  /** IC queries plus D1 calls allowed in this tick. Default 800. */
  maxSubrequests?: number;
  /** New ledgers probed per tick. Default 12. */
  maxProbes?: number;
}

export interface LedgerTickStats { ledger: string; phase: "tail" | "backfill"; from: number; to: number; tip: number; blocks: number; accounts: number; commits: number; ms: number; error?: string }
export interface IndexStats {
  ms: number; probed: number; tailed: number; backfilled: number; blocks: number; accountsWritten: number; bigTransfers: number;
  rowsWritten: number; rowsRead: number; icCalls: number; d1Calls: number; fetchMs: number; decodeMs: number; commitMs: number; bytes: number;
  errors: number; skipped: number; ledgers: LedgerTickStats[];
}

const PER_CALL = 2000; // the ledger and archive maximum per get_transactions
const FETCH_CONCURRENCY = 6; // Workers allow six simultaneous outbound connections
const TAIL_MAX = 2 * PER_CALL; // a backlog up to this size is handled in the tail phase
const MAX_AHEAD = 24; // planned-but-unapplied batches (in flight or buffered) at most
const HEDGE_AFTER_MS = 2000; // re-request the head-of-line range when its answer takes longer than this
const MAX_BLOCKS_PER_CHUNK = 400_000;
const now = () => Math.floor(Date.now() / 1000);

interface Tick { env: Env; opts: IndexOptions; deadline: number; ic: CallMeter; dbm: DbMeter; stats: IndexStats; maxSub: number }
const spent = (t: Tick) => t.ic.icCalls + t.dbm.d1Calls;

export async function indexTick(env: Env, opts: IndexOptions): Promise<IndexStats> {
  const started = Date.now();
  const stats: IndexStats = {
    ms: 0, probed: 0, tailed: 0, backfilled: 0, blocks: 0, accountsWritten: 0, bigTransfers: 0, rowsWritten: 0, rowsRead: 0, icCalls: 0, d1Calls: 0,
    fetchMs: 0, decodeMs: 0, commitMs: 0, bytes: 0, errors: 0, skipped: 0, ledgers: [],
  };
  const tick: Tick = { env, opts, deadline: started + opts.budgetMs, ic: newMeter(), dbm: newDbMeter(), stats, maxSub: opts.maxSubrequests ?? 800 };
  tick.ic.deadline = tick.deadline;
  const maxLedgers = opts.maxLedgersPerTick ?? 60;
  const ts = now();

  // ---- probe ------------------------------------------------------------------------------------
  let forced: IdxStateRow[] | null = null;
  if (opts.ledgers) {
    forced = [];
    for (const ledger of opts.ledgers.filter((l) => l !== ICP_LEDGER)) {
      let row = await getState(env.DB, ledger);
      if (!row || row.default_fee == null) {
        await probeLedger(tick, (await tokenSeed(env.DB, ledger)) ?? { id: ledger, decimals: null, fee: null, total_supply: null });
        row = await getState(env.DB, ledger);
      }
      if (row && row.default_fee != null) forced.push(row);
    }
  } else {
    const fresh = await unprobedTokens(env.DB, ICP_LEDGER, opts.maxProbes ?? 12);
    await pool(fresh, FETCH_CONCURRENCY, (t) => probeLedger(tick, t));
  }

  // ---- pick -------------------------------------------------------------------------------------
  const tails = forced ? forced.filter((r) => r.tip - r.next_block <= TAIL_MAX) : await dueForTail(env.DB, ts, TAIL_MAX, maxLedgers);
  const backlog = (forced ? forced.filter((r) => r.tip - r.next_block > TAIL_MAX) : await dueForBackfill(env.DB, ts, TAIL_MAX, maxLedgers)).sort((a, b) => a.tip - a.next_block - (b.tip - b.next_block));

  // ---- tail: many ledgers, one connection each. Leaves at least half the budget to a waiting backlog.
  const tailDeadline = backlog.length ? started + opts.budgetMs / 2 : tick.deadline;
  await pool(tails, FETCH_CONCURRENCY, async (row) => {
    if (Date.now() >= tailDeadline || spent(tick) >= tick.maxSub) return void stats.skipped++;
    await syncLedger(tick, row, "tail", 1, tailDeadline);
  });

  // ---- backfill: one ledger at a time, six connections
  for (const row of backlog) {
    if (Date.now() >= tick.deadline - reserveMs(tick) || spent(tick) >= tick.maxSub) {
      stats.skipped++;
      continue;
    }
    await syncLedger(tick, row, "backfill", FETCH_CONCURRENCY, tick.deadline);
  }

  const { icCalls, fetchMs, decodeMs, bytes } = tick.ic;
  Object.assign(stats, { icCalls, fetchMs, decodeMs, bytes }, tick.dbm);
  stats.ms = Date.now() - started;
  return stats;
}

/**
 * Large-transfer thresholds worth about `usd` dollars per ledger, from the markets tables (tokens + market).
 * Ledgers without a price are left out and keep the supply-fraction default.
 */
export async function usdThresholds(db: D1Database, usd = 10_000): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const rows = (await db.prepare("SELECT t.id, t.decimals, m.price_usd FROM tokens t JOIN market m ON m.token_id = t.id WHERE m.price_usd > 0").all<{ id: string; decimals: number; price_usd: number }>()).results;
    for (const r of rows) {
      const tokens = usd / r.price_usd;
      if (!Number.isFinite(tokens) || tokens <= 0 || tokens > 1e30) continue;
      const micro = BigInt(Math.max(1, Math.round(Math.min(tokens, 1e15) * 1e6)));
      const raw = (micro * 10n ** BigInt(r.decimals)) / 1_000_000n;
      if (raw > 0n) out[r.id] = raw.toString();
    }
  } catch {
    /* markets tables not there yet: defaults apply */
  }
  return out;
}

/**
 * The cron entry point: one 45 second tick with USD-based large-transfer thresholds. Returns the stats
 * without the per-ledger list (errors kept), so it is small enough for the runs table.
 */
export async function indexJob(env: Env, budgetMs = 45_000): Promise<Omit<IndexStats, "ledgers"> & { failed: { ledger: string; error: string }[] }> {
  const { ledgers, ...stats } = await indexTick(env, { budgetMs, minAmountRaw: await usdThresholds(env.DB) });
  return { ...stats, failed: ledgers.filter((l) => l.error).map((l) => ({ ledger: l.ledger, error: l.error!.slice(0, 160) })) };
}

/** Time kept back at the end of the budget for the final read + commit of the chunk in memory. */
const reserveMs = (t: Tick) => Math.min(6000, t.opts.budgetMs * 0.2);

async function probeLedger(tick: Tick, seed: TokenSeed, fails = 0): Promise<void> {
  const host = tick.env.IC_HOST;
  try {
    const [head, fee, decimals] = await Promise.all([
      ledgerPage(host, seed.id, 0, 0, tick.ic),
      ledgerFee(host, seed.id, tick.ic),
      seed.decimals != null ? seed.decimals : ledgerDecimals(host, seed.id, tick.ic),
    ]);
    const supply = seed.total_supply && seed.total_supply !== "0" ? BigInt(seed.total_supply) : await ledgerSupply(host, seed.id, tick.ic);
    const big = tick.opts.minAmountRaw?.[seed.id] ?? defaultBigThreshold(supply);
    await insertState(tick.env.DB, { ledger: seed.id, tip: head.tip, decimals, defaultFee: fee.toString(), bigMinRaw: big != null ? big.toString() : null, now: now() }, tick.dbm);
    tick.stats.probed++;
  } catch (e) {
    tick.stats.errors++;
    await fail(tick, seed.id, e, fails);
  }
}

async function fail(tick: Tick, ledger: string, e: unknown, fails: number): Promise<string> {
  const message = e instanceof Error ? e.message : String(e);
  const code = e instanceof IcRejectError ? e.code : null;
  const down = classifyReject(code, message);
  // IC0536: the canister runs but has no get_transactions, so it is not a DFINITY-style ICRC ledger.
  const unsupported = code === "IC0536" || /has no query method|method .* not found/i.test(message);
  const text = `${down ? `${down}: ` : ""}${message}`;
  await recordError(tick.env.DB, ledger, text, now(), { unsupported, fails }, tick.dbm);
  console.warn("indexer", ledger, text.slice(0, 200));
  return text;
}

interface Job { start: number; length: number; archive: ArchiveRange | null }
interface JobResult { job: Job; txs: Tx[]; tip: number | null }

async function syncLedger(tick: Tick, row: IdxStateRow, phase: "tail" | "backfill", concurrency: number, deadline: number): Promise<void> {
  const { env, ic, dbm } = tick;
  if (row.default_fee == null) {
    // The first probe failed (frozen or unreachable at the time). Try it again before replaying anything,
    // because fee, decimals, and the large-transfer threshold are still unknown.
    await probeLedger(tick, (await tokenSeed(env.DB, row.ledger)) ?? { id: row.ledger, decimals: null, fee: null, total_supply: null }, row.fails);
    const again = await getState(env.DB, row.ledger);
    if (!again || again.default_fee == null) return;
    row = again;
  }
  const host = env.IC_HOST;
  const ledger = row.ledger;
  const t0 = Date.now();
  const ls: LedgerTickStats = { ledger, phase, from: row.next_block, to: row.next_block, tip: row.tip, blocks: 0, accounts: 0, commits: 0, ms: 0 };
  tick.stats.ledgers.push(ls);

  // A caller-supplied threshold replaces the stored one only when it moved by more than a quarter, so
  // price-derived thresholds do not cost a row write per ledger per tick.
  const override = tick.opts.minAmountRaw?.[ledger];
  if (override != null) {
    const want = BigInt(override);
    const have = row.big_min_raw != null ? BigInt(row.big_min_raw) : null;
    const gap = have == null ? want : want > have ? want - have : have - want;
    if (want > 0n && (have == null || gap * 4n > have)) {
      row.big_min_raw = want.toString();
      await setLedgerParams(env.DB, ledger, { bigMinRaw: row.big_min_raw }, dbm);
    }
  }
  const minBig = row.big_min_raw != null ? BigInt(row.big_min_raw) : null;
  const defaultFee = BigInt(row.default_fee ?? "0");

  let state: ChunkState = newChunk(row.next_block, minBig, row.last_block_ts ?? 0);
  let holders = row.holders;
  let accounts = row.accounts;
  let tip = row.tip;

  /** Write the chunk in memory (or just refresh the state row when it is empty) and start a new one. */
  const commit = async () => {
    const ts = now();
    const synced = state.nextBlock >= tip;
    const lastBlockTs = state.totals.blocks ? state.lastTs : row.last_block_ts;
    // Poll quiet ledgers less often: a twentieth of the time since the last block, between 4 minutes and 1 hour.
    const nextCheckAt = synced ? ts + Math.round(Math.min(3600, Math.max(240, (ts - (lastBlockTs ?? ts)) / 20))) : 0;
    const cur = { ledger, expected: state.startBlock, next: state.nextBlock, tip, status: synced ? "synced" : "syncing", now: ts, nextCheckAt, lastBlockTs, completed: synced };
    if (!state.totals.blocks) {
      await touchState(env.DB, cur, dbm);
    } else {
      const existing = await loadExisting(env.DB, ledger, [...state.accounts.keys()], dbm);
      const plan = planCommit(state, existing, { holders, accounts }, row.decimals);
      await commitChunk(env.DB, plan, cur, dbm);
      holders = plan.holdersAfter;
      accounts = plan.accountsAfter;
      ls.commits++;
      ls.accounts += plan.upserts.length;
      tick.stats.accountsWritten += plan.upserts.length;
      tick.stats.bigTransfers += plan.big.length;
    }
    row.last_block_ts = lastBlockTs;
    state = newChunk(state.nextBlock, minBig, state.lastTs);
  };

  const apply = (txs: Tx[], firstIndex: number) => {
    const n = applyBlocks(state, txs, defaultFee, firstIndex);
    ls.blocks += n;
    tick.stats.blocks += n;
    ls.to = state.nextBlock;
  };
  const chunkFull = () => state.accounts.size >= MAX_ACCOUNTS_PER_CHUNK || state.totals.blocks >= MAX_BLOCKS_PER_CHUNK || state.big.length >= MAX_BIG_PER_CHUNK;

  let failure: unknown = null;
  const inflight = new Map<number, Promise<void>>();
  try {
    // One call gives the tip and, for a caught-up ledger, the new blocks as well.
    const first = await ledgerPage(host, ledger, state.nextBlock, PER_CALL, ic);
    tip = first.tip;
    ls.tip = tip;
    if (tip < state.nextBlock) throw new Error(`ledger tip ${tip} is below the indexed cursor ${state.nextBlock}: the ledger was reinstalled, reset this index`);
    let archives: ArchiveRange[] = [];
    if (first.archived.length || first.firstIndex > state.nextBlock) archives = await ledgerArchives(host, ledger, ic);
    if (!first.archived.length && first.inlineStart === state.nextBlock) apply(first.txs, first.inlineStart);
    else if (!archives.length) apply((await ledgerRange(host, ledger, state.nextBlock, PER_CALL, ic, first)).txs, state.nextBlock);

    // Sliding window of block fetches. Results are applied strictly in block order.
    let perCall = PER_CALL;
    let planCursor = state.nextBlock;
    let generation = 0;
    let jobId = 0;
    const ready = new Map<number, JobResult>();
    const fetchDeadline = deadline - reserveMs(tick);

    const run = async (job: Job): Promise<JobResult> => {
      if (job.archive) return { job, txs: await archivePage(host, job.archive.canister, "get_transactions", job.start, job.length, ic), tip: null };
      const r = await ledgerRange(host, ledger, job.start, job.length, ic);
      return { job, txs: r.txs, tip: r.tip };
    };
    // Every planned range is tracked by its start block. A range can be fetched twice (hedging): IC query
    // latency has a long tail (200 ms typical, several seconds now and then) and because blocks are applied in
    // order, one slow answer at the head stalls everything behind it. The first answer wins.
    const pending = new Map<number, { job: Job; at: number; launches: number; failures: number }>();
    const send = (job: Job) => {
      const gen = generation;
      const id = jobId++;
      const p = pending.get(job.start) ?? { job, at: Date.now(), launches: 0, failures: 0 };
      p.launches++;
      pending.set(job.start, p);
      inflight.set(id, run(job).then(
        (r) => { if (gen === generation && pending.delete(job.start)) ready.set(job.start, r); },
        (e) => { if (gen === generation && pending.has(job.start) && ++p.failures >= p.launches) failure ??= e; },
      ).finally(() => inflight.delete(id)));
    };
    const launch = () => {
      const archive = archives.find((a) => a.start <= planCursor && planCursor <= a.end) ?? null;
      const length = Math.min(perCall, archive ? archive.end - planCursor + 1 : tip - planCursor);
      send({ start: planCursor, length, archive });
      planCursor += length;
    };

    while (state.nextBlock < tip) {
      const open = !failure && Date.now() < fetchDeadline && spent(tick) + inflight.size < tick.maxSub;
      const head = pending.get(state.nextBlock);
      if (open && head && head.launches === 1 && inflight.size < concurrency && Date.now() - head.at > HEDGE_AFTER_MS) send(head.job);
      while (open && inflight.size < concurrency && planCursor < tip && pending.size + ready.size < MAX_AHEAD) launch();
      if (!inflight.size) break;
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([...inflight.values(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]);
      clearTimeout(timer);
      // Out of time: keep what is contiguous, abandon the rest. Answers still in flight are ignored
      // (their handlers only touch local maps), so one slow canister cannot drag the tick past its budget.
      if (Date.now() >= fetchDeadline && !ready.has(state.nextBlock)) break;
      for (let r = ready.get(state.nextBlock); r; r = ready.get(state.nextBlock)) {
        ready.delete(r.job.start);
        apply(r.txs, r.job.start);
        if (r.tip != null && r.tip > tip) tip = ls.tip = r.tip;
        if (r.txs.length < r.job.length) {
          // A short answer means this canister caps responses below what was asked. Everything planned
          // after it is misaligned: drop it, remember the cap, and re-plan from the cursor.
          if (!r.txs.length) failure ??= new Error(`no blocks returned at ${r.job.start} by ${r.job.archive?.canister ?? ledger}: that range is missing on chain, the ledger cannot be replayed past it`);
          else perCall = Math.min(perCall, r.txs.length);
          generation++;
          ready.clear();
          pending.clear();
          planCursor = state.nextBlock;
          break;
        }
        if (chunkFull()) await commit();
      }
    }
  } catch (e) {
    failure ??= e;
  }

  // Keep whatever was replayed before a failure: the prefix is contiguous, so it is safe to commit.
  // Losing the cursor race is not a ledger failure: the other tick owns the progress, nothing is recorded.
  if (!(failure instanceof CursorMovedError) && (!failure || state.totals.blocks)) {
    try {
      await commit();
    } catch (e) {
      failure ??= e;
    }
  }
  if (failure instanceof CursorMovedError) {
    console.warn("indexer", failure.message);
    ls.error = failure.message;
  } else if (failure) {
    tick.stats.errors++;
    ls.error = await fail(tick, ledger, failure, row.fails).catch((e) => String(e));
  }
  ls.ms = Date.now() - t0;
  if (phase === "tail") tick.stats.tailed++;
  else tick.stats.backfilled++;
}

export interface ReconcileResult {
  ledger: string; indexedThrough: number; tip: number; behind: number; complete: boolean;
  /** Sum of all indexed balances, base units. */
  indexedSupply: string;
  /** icrc1_total_supply right now. */
  ledgerSupply: string;
  /** ledgerSupply - indexedSupply. Zero for an exact index. Positive when a fee collector received fees the indexer treated as burned. */
  diff: string;
  accounts: number; holders: number; holdersInState: number; negativeAccounts: number;
}

/**
 * Correctness check: replayed balances must add up to the ledger's total supply. Reads every balance row
 * of the ledger (keyset pages), so it is a diagnostic for admin use, not something to call per request.
 * Only meaningful when behind is 0. Blocks that landed after the index cursor show up in diff.
 */
export async function reconcile(env: Env, ledger: string): Promise<ReconcileResult> {
  const meter = newMeter();
  const [supply, head, st] = await Promise.all([ledgerSupply(env.IC_HOST, ledger, meter), ledgerPage(env.IC_HOST, ledger, 0, 0, meter), getState(env.DB, ledger)]);
  let sum = 0n;
  let accounts = 0;
  let holders = 0;
  let negative = 0;
  let after = "";
  for (;;) {
    const page = (await env.DB.prepare("SELECT account, balance_raw FROM balances WHERE ledger = ? AND account > ? ORDER BY account LIMIT 20000").bind(ledger, after).all<{ account: string; balance_raw: string }>()).results;
    for (const r of page) {
      const b = BigInt(r.balance_raw);
      sum += b;
      accounts++;
      if (b > 0n) holders++;
      else if (b < 0n) negative++;
    }
    if (page.length < 20000) break;
    after = page[page.length - 1]!.account;
  }
  const next = st?.next_block ?? 0;
  return {
    ledger, indexedThrough: next - 1, tip: head.tip, behind: head.tip - next, complete: next >= head.tip && next > 0,
    indexedSupply: sum.toString(), ledgerSupply: supply.toString(), diff: (supply - sum).toString(),
    accounts, holders, holdersInState: st?.holders ?? 0, negativeAccounts: negative,
  };
}

export { resetLedger } from "./store";
