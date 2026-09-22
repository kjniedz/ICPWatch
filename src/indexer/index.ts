// Block indexer orchestration. One call to indexTick does a bounded amount of work inside a cron
// tick and leaves a durable cursor behind, so the next tick resumes exactly where this one stopped.
//
// A tick has four phases:
//   probe      listed tokens without index state get one: which block method works, tip, fee, decimals,
//              large-transfer threshold. The ICP ledger is its own kind with its own block format.
//   tail       ledgers that are caught up (or nearly) are polled for new blocks, six ledgers at a time,
//              one IC query each. Quiet ledgers are polled less often (next_check_at).
//   backfill   ledgers with a backlog are replayed one at a time with six parallel block fetches,
//              smallest backlog first, until the time or subrequest budget is spent. The ICP ledger
//              (38M blocks) goes last so it never starves the ICRC ledgers.
//   reconcile  a caught-up ledger is checked against icrc1_total_supply. Holder data is only marked
//              trusted after an exact match. A ledger replayed with an older balance algorithm that
//              fails the check is wiped and replayed once with the current one.
// See store.ts for the commit protocol and failures.ts for the failure taxonomy.
import type { Env } from "../env";
import { ICP_LEDGER, pool } from "../lib/ic";
import {
  UnknownFeeColError, applyBlocks, defaultBigThreshold, feeColsJson, feeSink, newChunk, parseFeeCols, planCommit, supplyDeltas, type ChunkState, type Tx,
} from "./core";
import { classifyFailure } from "./failures";
import {
  ICRC_SOURCES, archivePage, ledgerArchives, ledgerDecimals, ledgerFee, ledgerPage, ledgerRange, ledgerSupply, newMeter,
  type ArchiveRange, type BlockSource, type CallMeter, type LedgerPage,
} from "./ledger";
import {
  CursorMovedError, MAX_ACCOUNTS_PER_CHUNK, MAX_BIG_PER_CHUNK, commitChunk, dueForBackfill, dueForTail, getState, insertState, loadExisting, newDbMeter,
  recordError, resetForReplay, saveReconcile, setLedgerParams, sumBalances, tokenSeed, touchState, unprobedTokens, type DbMeter, type IdxStateRow, type LedgerKind, type TokenSeed,
} from "./store";

/** Balance rules version. 1 treated every fee as burned. 2 credits fee collectors (ICRC-3 fee_col, ICRC-107). */
export const ALGO_VERSION = 2;

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
  /** Reconcile checks per tick (each reads every balance row of the ledger). Default 3. */
  maxReconciles?: number;
  /** Include the ICP ledger. Default true. */
  icp?: boolean;
}

export interface LedgerTickStats { ledger: string; phase: "tail" | "backfill"; from: number; to: number; tip: number; blocks: number; accounts: number; commits: number; ms: number; error?: string; reconciled?: boolean }
export interface IndexStats {
  ms: number; probed: number; tailed: number; backfilled: number; reconciled: number; replayed: number; blocks: number; accountsWritten: number; bigTransfers: number;
  rowsWritten: number; rowsRead: number; icCalls: number; d1Calls: number; fetchMs: number; decodeMs: number; commitMs: number; bytes: number;
  errors: number; skipped: number; ledgers: LedgerTickStats[];
}

const PER_CALL = 2000; // the ledger and archive maximum per get_transactions
const FETCH_CONCURRENCY = 6; // Workers allow six simultaneous outbound connections
const TAIL_MAX = 2 * PER_CALL; // a backlog up to this size is handled in the tail phase
const MAX_AHEAD = 24; // planned-but-unapplied batches (in flight or buffered) at most
const HEDGE_AFTER_MS = 2000; // re-request the head-of-line range when its answer takes longer than this
const MAX_BLOCKS_PER_CHUNK = 400_000;
const RECONCILE_OK_EVERY = 86_400; // a passing ledger is re-checked daily
const RECONCILE_RETRY = 6 * 3600; // a failing or undecidable one, every six hours
const now = () => Math.floor(Date.now() / 1000);

interface Tick { env: Env; opts: IndexOptions; deadline: number; ic: CallMeter; dbm: DbMeter; stats: IndexStats; maxSub: number; reconciles: number }
const spent = (t: Tick) => t.ic.icCalls + t.dbm.d1Calls;
const sourceOf = (row: IdxStateRow): BlockSource => (row.kind === "icp" ? "icp" : ((row.source as BlockSource | null) ?? "tx"));

export async function indexTick(env: Env, opts: IndexOptions): Promise<IndexStats> {
  const started = Date.now();
  const stats: IndexStats = {
    ms: 0, probed: 0, tailed: 0, backfilled: 0, reconciled: 0, replayed: 0, blocks: 0, accountsWritten: 0, bigTransfers: 0, rowsWritten: 0, rowsRead: 0, icCalls: 0, d1Calls: 0,
    fetchMs: 0, decodeMs: 0, commitMs: 0, bytes: 0, errors: 0, skipped: 0, ledgers: [],
  };
  const tick: Tick = { env, opts, deadline: started + opts.budgetMs, ic: newMeter(), dbm: newDbMeter(), stats, maxSub: opts.maxSubrequests ?? 800, reconciles: 0 };
  tick.ic.deadline = tick.deadline;
  const maxLedgers = opts.maxLedgersPerTick ?? 60;
  const ts = now();
  const withIcp = opts.icp !== false;

  // ---- probe ------------------------------------------------------------------------------------
  let forced: IdxStateRow[] | null = null;
  if (opts.ledgers) {
    forced = [];
    for (const ledger of opts.ledgers) {
      let row = await getState(env.DB, ledger);
      if (!row || row.default_fee == null) {
        await probeLedger(tick, (await tokenSeed(env.DB, ledger)) ?? { id: ledger, decimals: null, fee: null, total_supply: null });
        row = await getState(env.DB, ledger);
      }
      if (row && row.default_fee != null) forced.push(row);
    }
  } else {
    const fresh = await unprobedTokens(env.DB, withIcp ? "" : ICP_LEDGER, opts.maxProbes ?? 12);
    await pool(fresh, FETCH_CONCURRENCY, (t) => probeLedger(tick, t));
  }

  // ---- pick -------------------------------------------------------------------------------------
  const tails = forced ? forced.filter((r) => r.tip - r.next_block <= TAIL_MAX) : await dueForTail(env.DB, ts, TAIL_MAX, maxLedgers);
  const backlog = (forced ? forced.filter((r) => r.tip - r.next_block > TAIL_MAX) : await dueForBackfill(env.DB, ts, TAIL_MAX, maxLedgers))
    .filter((r) => withIcp || r.kind !== "icp")
    // Smallest backlog first, and the ICP ledger after every ICRC ledger whatever its backlog.
    .sort((a, b) => (a.kind === "icp" ? 1 : 0) - (b.kind === "icp" ? 1 : 0) || a.tip - a.next_block - (b.tip - b.next_block));

  // ---- tail: many ledgers, one connection each. Leaves at least half the budget to a waiting backlog.
  const tailDeadline = backlog.length ? started + opts.budgetMs / 2 : tick.deadline;
  await pool(tails.filter((r) => withIcp || r.kind !== "icp"), FETCH_CONCURRENCY, async (row) => {
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

/**
 * First contact with a ledger: which block method it speaks (get_blocks with fee collector data is
 * preferred, then get_transactions, then icrc3_get_blocks), its tip, fee, decimals, and the large-transfer
 * threshold. The ICP ledger is recognised by id.
 */
async function probeLedger(tick: Tick, seed: TokenSeed, fails = 0): Promise<void> {
  const host = tick.env.IC_HOST;
  const kind: LedgerKind = seed.id === ICP_LEDGER ? "icp" : "icrc";
  try {
    let head: LedgerPage | null = null;
    let source: BlockSource = "icp";
    if (kind === "icp") head = await ledgerPage(host, seed.id, "icp", 0, 0, tick.ic);
    else {
      let lastNoMethod: unknown = null;
      for (const s of ICRC_SOURCES) {
        try {
          head = await ledgerPage(host, seed.id, s, 0, 0, tick.ic);
          source = s;
          break;
        } catch (e) {
          if (!classifyFailure(e, seed.id).noMethod) throw e;
          lastNoMethod = e;
        }
      }
      if (!head) throw lastNoMethod ?? new Error("no block method answered");
    }
    const [fee, decimals] = await Promise.all([
      seed.fee != null && kind === "icp" ? BigInt(seed.fee) : ledgerFee(host, seed.id, tick.ic),
      seed.decimals != null ? seed.decimals : ledgerDecimals(host, seed.id, tick.ic),
    ]);
    const supply = seed.total_supply && seed.total_supply !== "0" ? BigInt(seed.total_supply) : await ledgerSupply(host, seed.id, tick.ic);
    const big = tick.opts.minAmountRaw?.[seed.id] ?? defaultBigThreshold(supply);
    await insertState(tick.env.DB, { ledger: seed.id, tip: head.tip, decimals, defaultFee: fee.toString(), bigMinRaw: big != null ? big.toString() : null, now: now(), kind, source, algoVersion: ALGO_VERSION }, tick.dbm);
    tick.stats.probed++;
  } catch (e) {
    tick.stats.errors++;
    await fail(tick, seed.id, e, fails, kind);
  }
}

async function fail(tick: Tick, ledger: string, e: unknown, fails: number, kind: LedgerKind): Promise<string> {
  const message = e instanceof Error ? e.message : String(e);
  const f = classifyFailure(e, ledger);
  const text = `${f.reason}${f.canister && f.canister !== ledger ? ` (${f.canister})` : ""}: ${message}`;
  await recordError(tick.env.DB, ledger, text, now(), { reason: f.reason, hopeless: f.hopeless, canister: f.canister, fails, kind }, tick.dbm);
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
  const kind = row.kind;
  const source = sourceOf(row);
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

  let state: ChunkState = newChunk(row.next_block, minBig, row.last_block_ts ?? 0, parseFeeCols(row.fee_cols));
  let holders = row.holders;
  let accounts = row.accounts;
  let tip = row.tip;
  const totals = { minted: BigInt(row.minted_raw || "0"), burned: BigInt(row.burned_raw || "0"), feesBurned: BigInt(row.fees_burned_raw || "0"), feesCollected: BigInt(row.fees_collected_raw || "0") };

  /** Write the chunk in memory (or just refresh the state row when it is empty) and start a new one. */
  const commit = async () => {
    const ts = now();
    const synced = state.nextBlock >= tip;
    const lastBlockTs = state.totals.blocks ? state.lastTs : row.last_block_ts;
    // Poll quiet ledgers less often: a twentieth of the time since the last block, between 4 minutes and 1 hour.
    const nextCheckAt = synced ? ts + Math.round(Math.min(3600, Math.max(240, (ts - (lastBlockTs ?? ts)) / 20))) : 0;
    const next = { minted: totals.minted + state.totals.minted, burned: totals.burned + state.totals.burned, feesBurned: totals.feesBurned + state.totals.feesBurned, feesCollected: totals.feesCollected + state.totals.feesCollected };
    const cur = {
      ledger, expected: state.startBlock, next: state.nextBlock, tip, status: synced ? "synced" : "syncing", now: ts, nextCheckAt, lastBlockTs, completed: synced, kind,
      totals: { minted: next.minted.toString(), burned: next.burned.toString(), feesBurned: next.feesBurned.toString(), feesCollected: next.feesCollected.toString() },
      feeCols: state.feeCols.dirty ? feeColsJson(state.feeCols) : undefined,
    };
    if (!state.totals.blocks) {
      await touchState(env.DB, cur, dbm);
    } else {
      const existing = await loadExisting(env.DB, ledger, [...state.accounts.keys()], dbm, kind);
      const plan = planCommit(state, existing, { holders, accounts }, row.decimals);
      await commitChunk(env.DB, plan, cur, dbm);
      holders = plan.holdersAfter;
      accounts = plan.accountsAfter;
      Object.assign(totals, next);
      ls.commits++;
      ls.accounts += plan.upserts.length;
      tick.stats.accountsWritten += plan.upserts.length;
      tick.stats.bigTransfers += plan.big.length;
    }
    row.last_block_ts = lastBlockTs;
    state.feeCols.dirty = false;
    state = newChunk(state.nextBlock, minBig, state.lastTs, state.feeCols);
  };

  /**
   * Fold a batch. A fee_col_block reference to a block outside the batch (a collector declared long
   * before the current chunk) is resolved by fetching that one block and registering it, then retrying.
   */
  const apply = async (txs: Tx[], firstIndex: number) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const n = applyBlocks(state, txs, defaultFee, firstIndex);
        ls.blocks += n;
        tick.stats.blocks += n;
        ls.to = state.nextBlock;
        return;
      } catch (e) {
        if (!(e instanceof UnknownFeeColError) || attempt >= 3) throw e;
        for (const ref of e.blocks.slice(0, 8)) {
          const one = await ledgerRange(host, ledger, source, ref, 1, ic);
          const tx = one.txs[0];
          if (!tx) throw new Error(`fee collector block ${ref} could not be read`);
          feeSink(state.feeCols, tx, ref);
        }
      }
    }
  };
  const chunkFull = () => state.accounts.size >= MAX_ACCOUNTS_PER_CHUNK || state.totals.blocks >= MAX_BLOCKS_PER_CHUNK || state.big.length >= MAX_BIG_PER_CHUNK;

  let failure: unknown = null;
  const inflight = new Map<number, Promise<void>>();
  try {
    // One call gives the tip and, for a caught-up ledger, the new blocks as well.
    const first = await ledgerPage(host, ledger, source, state.nextBlock, PER_CALL, ic);
    tip = first.tip;
    ls.tip = tip;
    if (tip < state.nextBlock) throw new Error(`ledger tip ${tip} is below the indexed cursor ${state.nextBlock}: the ledger was reinstalled, reset this index`);
    let archives: ArchiveRange[] = [];
    if (first.archived.length || (first.firstIndex ?? state.nextBlock) > state.nextBlock) archives = await ledgerArchives(host, ledger, source, tip, ic);
    if (!first.archived.length && first.inlineStart === state.nextBlock) await apply(first.txs, first.inlineStart);
    else if (!archives.length) await apply((await ledgerRange(host, ledger, source, state.nextBlock, PER_CALL, ic, first)).txs, state.nextBlock);

    // Sliding window of block fetches. Results are applied strictly in block order.
    let perCall = PER_CALL;
    let planCursor = state.nextBlock;
    let generation = 0;
    let jobId = 0;
    const ready = new Map<number, JobResult>();
    const fetchDeadline = deadline - reserveMs(tick);

    const run = async (job: Job): Promise<JobResult> => {
      if (job.archive) return { job, txs: await archivePage(host, job.archive.canister, source, job.start, job.length, ic), tip: null };
      const r = await ledgerRange(host, ledger, source, job.start, job.length, ic);
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
        await apply(r.txs, r.job.start);
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
    ls.error = await fail(tick, ledger, failure, row.fails, kind).catch((e) => String(e));
  } else if (state.nextBlock >= tip && tip > 0) {
    // Caught up: run the reconcile gate when it is due and the tick still has room.
    const maxRec = tick.opts.maxReconciles ?? 3;
    if (now() >= row.reconcile_next_at && tick.reconciles < maxRec && Date.now() < deadline - reserveMs(tick)) {
      tick.reconciles++;
      try {
        ls.reconciled = await reconcileGate(tick, { ...row, next_block: state.nextBlock, tip, fee_cols: feeColsJson(state.feeCols) }, source, defaultFee);
      } catch (e) {
        console.warn("indexer reconcile", ledger, String(e).slice(0, 200));
      }
    }
  }
  ls.ms = Date.now() - t0;
  if (phase === "tail") tick.stats.tailed++;
  else tick.stats.backfilled++;
}

/**
 * The reconcile gate. Sum of indexed balances versus icrc1_total_supply, exact. Blocks land while the
 * supply is being read, so the comparison is accepted at any height between the cursor and the tip seen
 * right after the supply read: the running sum plus the supply effect of each of those blocks must hit
 * the ledger's figure at one of them. Anything else is a mismatch.
 *
 * A mismatch on a ledger indexed with an older balance algorithm triggers one automatic replay from
 * block 0 with the current one. A mismatch on a current-algorithm ledger stays recorded (not trusted)
 * for a human to look at.
 */
async function reconcileGate(tick: Tick, row: IdxStateRow, source: BlockSource, defaultFee: bigint): Promise<boolean> {
  const { env, ic, dbm } = tick;
  const host = env.IC_HOST;
  const ts = now();
  const supply = await ledgerSupply(host, row.ledger, ic);
  const after = await ledgerPage(host, row.ledger, source, row.next_block, PER_CALL, ic);
  const sum = await sumBalances(env.DB, row.ledger, row.kind, dbm);
  const fresh = after.archived.length ? [] : after.inlineStart === row.next_block ? after.txs : [];
  const deltas = supplyDeltas(parseFeeCols(row.fee_cols), fresh, defaultFee, row.next_block);
  let running = sum.sum;
  let matched: number | null = running === supply ? row.next_block : null;
  for (let i = 0; i < deltas.length && matched == null; i++) {
    running += deltas[i]!;
    if (running === supply) matched = row.next_block + i + 1;
  }
  const undecidable = matched == null && after.tip - row.next_block > fresh.length; // too busy to line up
  const diff = (supply - running).toString();
  if (matched != null) {
    await saveReconcile(env.DB, { ledger: row.ledger, now: ts, ok: true, diffRaw: "0", supplyRaw: supply.toString(), block: matched, note: `exact at block ${matched}: ${sum.holders} holders, ${sum.accounts} accounts`, nextAt: ts + RECONCILE_OK_EVERY }, dbm);
    tick.stats.reconciled++;
    return true;
  }
  if (undecidable) {
    await saveReconcile(env.DB, { ledger: row.ledger, now: ts, ok: null, diffRaw: null, supplyRaw: null, block: null, note: `undecided: ${after.tip - row.next_block} blocks landed during the check`, nextAt: ts + 900 }, dbm);
    return false;
  }
  const note = `mismatch: supply minus indexed sum is ${diff} at block ${row.next_block + fresh.length}${sum.negative ? `, ${sum.negative} negative accounts` : ""}`;
  if (row.kind === "icrc" && row.algo_version < ALGO_VERSION && row.replays === 0) {
    const wiped = await resetForReplay(env.DB, row.ledger, row.algo_version, ALGO_VERSION, ts, `${note}; replaying with balance rules v${ALGO_VERSION}`, dbm);
    if (wiped) {
      tick.stats.replayed++;
      console.warn("indexer replay", row.ledger, note);
      return false;
    }
  }
  await saveReconcile(env.DB, { ledger: row.ledger, now: ts, ok: false, diffRaw: diff, supplyRaw: supply.toString(), block: row.next_block + fresh.length, note, nextAt: ts + RECONCILE_RETRY }, dbm);
  tick.stats.reconciled++;
  return false;
}

export interface ReconcileResult {
  ledger: string; indexedThrough: number; tip: number; behind: number; complete: boolean;
  /** Sum of all indexed balances, base units. */
  indexedSupply: string;
  /** icrc1_total_supply right now. */
  ledgerSupply: string;
  /** ledgerSupply - indexedSupply. Zero for an exact index. */
  diff: string;
  accounts: number; holders: number; holdersInState: number; negativeAccounts: number;
  trusted: boolean; reconcileNote: string | null;
}

/**
 * Diagnostic for admin use: the same comparison the gate makes, without acting on it. Reads every
 * balance row of the ledger, so not something to call per request. Blocks that landed after the index
 * cursor show up in diff.
 */
export async function reconcile(env: Env, ledger: string): Promise<ReconcileResult> {
  const meter = newMeter();
  const dbm = newDbMeter();
  const st = await getState(env.DB, ledger);
  const source: BlockSource = st ? sourceOf(st) : "tx";
  const [supply, head, sum] = await Promise.all([ledgerSupply(env.IC_HOST, ledger, meter), ledgerPage(env.IC_HOST, ledger, source, 0, 0, meter), sumBalances(env.DB, ledger, st?.kind ?? "icrc", dbm)]);
  const next = st?.next_block ?? 0;
  return {
    ledger, indexedThrough: next - 1, tip: head.tip, behind: head.tip - next, complete: next >= head.tip && next > 0,
    indexedSupply: sum.sum.toString(), ledgerSupply: supply.toString(), diff: (supply - sum.sum).toString(),
    accounts: sum.accounts, holders: sum.holders, holdersInState: st?.holders ?? 0, negativeAccounts: sum.negative,
    trusted: !!st && st.reconcile_ok === 1 && next >= st.tip, reconcileNote: st?.reconcile_note ?? null,
  };
}

export { resetLedger } from "./store";
