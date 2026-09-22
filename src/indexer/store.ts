// Block indexer persistence. All D1 access for the write side lives here.
//
// COMMIT PROTOCOL (why a crash or an overlapping tick cannot double-apply blocks)
//   1. A chunk of blocks [expected, next) is folded in memory. Nothing is written while folding.
//   2. The current rows of the touched accounts are read, deltas are added in JS BigInt (SQL cannot
//      add TEXT bigints), and the new absolute balances are computed.
//   3. Everything goes out in ONE db.batch(): balance upserts, large transfers, daily rows, and last
//      the cursor move. D1 runs a batch as a single transaction, so either the cursor and the balances
//      both land or neither does. A chunk is capped (MAX_ACCOUNTS_PER_CHUNK) so that one batch always fits.
//   4. Every statement in the batch is guarded by "the cursor still equals `expected`" and the cursor
//      update itself is a compare-and-swap on next_block. If another tick committed first, every statement
//      becomes a no-op and the loser detects it from the cursor update touching zero rows.
// Rows travel as one JSON parameter per statement and are expanded with json_each, because D1 allows
// only 100 bound parameters per statement. That keeps a 30,000 account commit at about thirty statements.
import type { BalanceUpsert, BigRow, CommitPlan, DailyRow, ExistingRow } from "./core";

export interface IdxStateRow {
  ledger: string; next_block: number; tip: number; decimals: number; default_fee: string | null; big_min_raw: string | null;
  holders: number; accounts: number; status: string; error: string | null; fails: number; retry_at: number; next_check_at: number;
  last_block_ts: number | null; started_at: number | null; updated_at: number; completed_at: number | null;
  // migration 0005
  kind: LedgerKind; source: string | null; algo_version: number; replays: number; fee_cols: string | null;
  minted_raw: string; burned_raw: string; fees_burned_raw: string; fees_collected_raw: string;
  reconciled_at: number | null; reconcile_ok: number | null; reconcile_diff_raw: string | null; reconcile_supply_raw: string | null;
  reconcile_block: number | null; reconcile_note: string | null; reconcile_next_at: number;
  fail_reason: string | null; fail_canister: string | null; failed_since: number | null;
}

export type LedgerKind = "icrc" | "icp";
/** ICRC ledgers share `balances` (keyed by ledger). The ICP ledger has its own table, see migrations/0005. */
export const balanceTable = (kind: LedgerKind) => (kind === "icp" ? "icp_balances" : "balances");
const ledgerFilter = (kind: LedgerKind) => (kind === "icp" ? "?1 IS NOT NULL" : "ledger = ?1");

/** Accounts per SELECT when loading existing rows, and rows per INSERT when writing. Bounded by D1's 2 MB parameter size. */
const READ_KEYS_PER_STMT = 4000;
const WRITE_ROWS_PER_STMT = 1000;
/** A chunk is committed once it touches this many accounts, so one transactional batch stays a manageable size. */
export const MAX_ACCOUNTS_PER_CHUNK = 30_000;
export const MAX_BIG_PER_CHUNK = 5_000;

export interface DbMeter { d1Calls: number; rowsWritten: number; rowsRead: number; commitMs: number }
export const newDbMeter = (): DbMeter => ({ d1Calls: 0, rowsWritten: 0, rowsRead: 0, commitMs: 0 });

const tally = (meter: DbMeter, results: D1Result<unknown>[]) => {
  for (const r of results) {
    meter.rowsWritten += r.meta?.rows_written ?? 0;
    meter.rowsRead += r.meta?.rows_read ?? 0;
  }
};

export async function getState(db: D1Database, ledger: string): Promise<IdxStateRow | null> {
  return db.prepare("SELECT * FROM idx_state WHERE ledger = ?").bind(ledger).first<IdxStateRow>();
}

export async function loadExisting(db: D1Database, ledger: string, accounts: string[], meter: DbMeter, kind: LedgerKind = "icrc"): Promise<Map<string, ExistingRow>> {
  const out = new Map<string, ExistingRow>();
  if (!accounts.length) return out;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < accounts.length; i += READ_KEYS_PER_STMT) {
    stmts.push(
      db.prepare(`SELECT account, balance_raw, tx_count, last_active FROM ${balanceTable(kind)} WHERE ${ledgerFilter(kind)} AND account IN (SELECT value FROM json_each(?2))`)
        .bind(ledger, JSON.stringify(accounts.slice(i, i + READ_KEYS_PER_STMT))),
    );
  }
  meter.d1Calls++;
  const results = await db.batch<{ account: string; balance_raw: string; tx_count: number; last_active: number }>(stmts);
  tally(meter, results);
  for (const r of results) for (const row of r.results) out.set(row.account, { balanceRaw: row.balance_raw, txCount: row.tx_count, lastActive: row.last_active });
  return out;
}

export class CursorMovedError extends Error {
  constructor(ledger: string, expected: number) {
    super(`cursor of ${ledger} is no longer ${expected}: another tick committed first, this chunk was discarded`);
  }
}

export interface CursorUpdate {
  ledger: string; expected: number; next: number; tip: number; status: string; now: number; nextCheckAt: number; lastBlockTs: number | null; completed: boolean;
  kind?: LedgerKind;
  /** Absolute running totals after this chunk (base units). */
  totals?: { minted: string; burned: string; feesBurned: string; feesCollected: string };
  /** New idx_state.fee_cols JSON. Undefined leaves the column alone. */
  feeCols?: string | null;
}

const GUARD = "(SELECT next_block FROM idx_state WHERE ledger = ?1) = ?3";

const balanceJson = (rows: BalanceUpsert[]) => JSON.stringify(rows.map((r) => [r.account, r.owner, r.balance, r.balanceRaw, r.txCount, r.firstSeen, r.lastActive]));
const bigJson = (rows: BigRow[]) => JSON.stringify(rows.map((r) => [r.block, r.ts, r.kind, r.from, r.to, r.amount, r.amountRaw]));
const dailyJson = (rows: DailyRow[]) => JSON.stringify(rows.map((r) => [r.day, r.txs, r.transfers, r.volume, r.mints, r.burns, r.fees, r.activeAccounts, r.newAccounts, r.holders]));

/** One transactional batch: rows first, cursor last. Throws CursorMovedError when it lost a race (nothing was written). */
export async function commitChunk(db: D1Database, plan: CommitPlan, cur: CursorUpdate, meter: DbMeter): Promise<void> {
  const t0 = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const upsertSql = cur.kind === "icp"
    ? `INSERT INTO icp_balances (account, balance, balance_raw, tx_count, first_seen, last_active)
         SELECT value->>0, value->>2, value->>3, value->>4, value->>5, value->>6 FROM json_each(?2) WHERE ${GUARD}
         ON CONFLICT (account) DO UPDATE SET balance = excluded.balance, balance_raw = excluded.balance_raw, tx_count = excluded.tx_count, last_active = excluded.last_active`
    : `INSERT INTO balances (ledger, account, owner, balance, balance_raw, tx_count, first_seen, last_active)
         SELECT ?1, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5, value->>6 FROM json_each(?2) WHERE ${GUARD}
         ON CONFLICT (ledger, account) DO UPDATE SET balance = excluded.balance, balance_raw = excluded.balance_raw, tx_count = excluded.tx_count, last_active = excluded.last_active`;
  for (let i = 0; i < plan.upserts.length; i += WRITE_ROWS_PER_STMT) {
    stmts.push(db.prepare(upsertSql).bind(cur.ledger, balanceJson(plan.upserts.slice(i, i + WRITE_ROWS_PER_STMT)), cur.expected));
  }
  for (let i = 0; i < plan.big.length; i += WRITE_ROWS_PER_STMT) {
    stmts.push(
      db.prepare(
        `INSERT OR REPLACE INTO transfers_big (ledger, block, ts, kind, from_account, to_account, amount, amount_raw)
         SELECT ?1, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5, value->>6 FROM json_each(?2) WHERE ${GUARD}`,
      ).bind(cur.ledger, bigJson(plan.big.slice(i, i + WRITE_ROWS_PER_STMT)), cur.expected),
    );
  }
  for (let i = 0; i < plan.daily.length; i += WRITE_ROWS_PER_STMT) {
    stmts.push(
      db.prepare(
        `INSERT INTO ledger_daily (ledger, day, txs, transfers, volume, mints, burns, fees, active_accounts, new_accounts, holders)
         SELECT ?1, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5, value->>6, value->>7, value->>8, value->>9 FROM json_each(?2) WHERE ${GUARD}
         ON CONFLICT (ledger, day) DO UPDATE SET txs = txs + excluded.txs, transfers = transfers + excluded.transfers, volume = volume + excluded.volume,
           mints = mints + excluded.mints, burns = burns + excluded.burns, fees = fees + excluded.fees,
           active_accounts = active_accounts + excluded.active_accounts, new_accounts = new_accounts + excluded.new_accounts, holders = excluded.holders`,
      ).bind(cur.ledger, dailyJson(plan.daily.slice(i, i + WRITE_ROWS_PER_STMT)), cur.expected),
    );
  }
  stmts.push(
    db.prepare(
      `UPDATE idx_state SET next_block = ?2, tip = ?4, holders = ?5, accounts = ?6, status = ?7, error = NULL, fails = 0, retry_at = 0, next_check_at = ?8,
         last_block_ts = COALESCE(?9, last_block_ts), updated_at = ?10, started_at = COALESCE(started_at, ?10), completed_at = COALESCE(completed_at, ?11),
         minted_raw = COALESCE(?12, minted_raw), burned_raw = COALESCE(?13, burned_raw), fees_burned_raw = COALESCE(?14, fees_burned_raw),
         fees_collected_raw = COALESCE(?15, fees_collected_raw), fee_cols = CASE WHEN ?16 = 1 THEN ?17 ELSE fee_cols END,
         fail_reason = NULL, fail_canister = NULL, failed_since = NULL
       WHERE ledger = ?1 AND next_block = ?3`,
    ).bind(
      cur.ledger, cur.next, cur.expected, cur.tip, plan.holdersAfter, plan.accountsAfter, cur.status, cur.nextCheckAt, cur.lastBlockTs, cur.now, cur.completed ? cur.now : null,
      cur.totals?.minted ?? null, cur.totals?.burned ?? null, cur.totals?.feesBurned ?? null, cur.totals?.feesCollected ?? null, cur.feeCols !== undefined ? 1 : 0, cur.feeCols ?? null,
    ),
  );
  meter.d1Calls++;
  const results = await db.batch(stmts);
  tally(meter, results);
  meter.commitMs += Date.now() - t0;
  if (!results[results.length - 1]?.meta?.changes) throw new CursorMovedError(cur.ledger, cur.expected);
}

/** A check that found nothing to apply: refresh tip, status, and the next poll time. Still a compare-and-swap. */
export async function touchState(db: D1Database, cur: CursorUpdate, meter: DbMeter): Promise<void> {
  meter.d1Calls++;
  const r = await db.prepare(
    `UPDATE idx_state SET tip = ?3, status = ?4, error = NULL, fails = 0, retry_at = 0, next_check_at = ?5, updated_at = ?6, completed_at = COALESCE(completed_at, ?7),
       fail_reason = NULL, fail_canister = NULL, failed_since = NULL
     WHERE ledger = ?1 AND next_block = ?2`,
  ).bind(cur.ledger, cur.expected, cur.tip, cur.status, cur.nextCheckAt, cur.now, cur.completed ? cur.now : null).run();
  tally(meter, [r]);
}

export type FailReason = "frozen" | "uninstalled" | "no_get_transactions" | "archive_gap" | "archive_unreachable" | "decode_error" | "other";
export const DAY_S = 86_400;

/**
 * Record a failure and back off. Hopeless reasons (nothing changes until somebody tops up, reinstalls, or restores
 * the canister) are retried once a day. Everything else backs off from 5 minutes, doubling up to 6 hours, and
 * drops to once a day after 8 consecutive failures.
 */
export async function recordError(
  db: D1Database, ledger: string, error: string, now: number,
  opts: { reason: FailReason; hopeless: boolean; canister?: string | null; fails: number; kind?: LedgerKind }, meter: DbMeter,
): Promise<number> {
  const fails = opts.fails + 1;
  const retryAt = now + (opts.hopeless || fails >= 8 ? DAY_S : Math.min(6 * 3600, 300 * 2 ** Math.min(fails - 1, 10)));
  meter.d1Calls++;
  const r = await db.prepare(
    `INSERT INTO idx_state (ledger, status, error, fails, retry_at, updated_at, fail_reason, fail_canister, failed_since, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?6, ?9)
     ON CONFLICT (ledger) DO UPDATE SET status = excluded.status, error = excluded.error, fails = excluded.fails, retry_at = excluded.retry_at, updated_at = excluded.updated_at,
       fail_reason = excluded.fail_reason, fail_canister = excluded.fail_canister, failed_since = COALESCE(idx_state.failed_since, excluded.failed_since)`,
  ).bind(ledger, opts.reason === "no_get_transactions" ? "unsupported" : "error", error.slice(0, 500), fails, retryAt, now, opts.reason, opts.canister ?? null, opts.kind ?? "icrc").run();
  tally(meter, [r]);
  return retryAt;
}

export interface ProbeInsert { ledger: string; tip: number; decimals: number; defaultFee: string; bigMinRaw: string | null; now: number; kind: LedgerKind; source: string; algoVersion: number }

export async function insertState(db: D1Database, p: ProbeInsert, meter: DbMeter): Promise<void> {
  meter.d1Calls++;
  const r = await db.prepare(
    `INSERT INTO idx_state (ledger, next_block, tip, decimals, default_fee, big_min_raw, status, updated_at, kind, source, algo_version) VALUES (?1, 0, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9)
     ON CONFLICT (ledger) DO UPDATE SET tip = excluded.tip, decimals = excluded.decimals, default_fee = excluded.default_fee,
       big_min_raw = COALESCE(idx_state.big_min_raw, excluded.big_min_raw), status = CASE WHEN idx_state.next_block = 0 THEN 'pending' ELSE 'syncing' END,
       error = NULL, retry_at = 0, updated_at = excluded.updated_at, kind = excluded.kind, source = excluded.source,
       algo_version = CASE WHEN idx_state.next_block = 0 THEN excluded.algo_version ELSE idx_state.algo_version END,
       fail_reason = NULL, fail_canister = NULL, failed_since = NULL`,
  ).bind(p.ledger, p.tip, p.decimals, p.defaultFee, p.bigMinRaw, p.now, p.kind, p.source, p.algoVersion).run();
  tally(meter, [r]);
}

export async function setLedgerParams(db: D1Database, ledger: string, fields: { defaultFee?: string; bigMinRaw?: string; source?: string; feeCols?: string | null }, meter: DbMeter): Promise<void> {
  meter.d1Calls++;
  const r = await db.prepare("UPDATE idx_state SET default_fee = COALESCE(?2, default_fee), big_min_raw = COALESCE(?3, big_min_raw), source = COALESCE(?4, source), fee_cols = COALESCE(?5, fee_cols) WHERE ledger = ?1")
    .bind(ledger, fields.defaultFee ?? null, fields.bigMinRaw ?? null, fields.source ?? null, fields.feeCols ?? null).run();
  tally(meter, [r]);
}

export interface ReconcileWrite { ledger: string; now: number; ok: boolean | null; diffRaw: string | null; supplyRaw: string | null; block: number | null; note: string; nextAt: number }

/** ok = null records an attempt that could not decide (ledger too busy, reads unstable): the previous verdict stays. */
export async function saveReconcile(db: D1Database, w: ReconcileWrite, meter: DbMeter): Promise<void> {
  meter.d1Calls++;
  const r = w.ok == null
    ? await db.prepare("UPDATE idx_state SET reconcile_note = ?2, reconcile_next_at = ?3 WHERE ledger = ?1").bind(w.ledger, w.note.slice(0, 300), w.nextAt).run()
    : await db.prepare(
        "UPDATE idx_state SET reconciled_at = ?2, reconcile_ok = ?3, reconcile_diff_raw = ?4, reconcile_supply_raw = ?5, reconcile_block = ?6, reconcile_note = ?7, reconcile_next_at = ?8 WHERE ledger = ?1",
      ).bind(w.ledger, w.now, w.ok ? 1 : 0, w.diffRaw, w.supplyRaw, w.block, w.note.slice(0, 300), w.nextAt).run();
  tally(meter, [r]);
}

export interface BalanceSum { sum: bigint; accounts: number; holders: number; negative: number }

/**
 * Exact sum of every indexed balance of a ledger. balance_raw is TEXT (arbitrary precision) and SQLite integers are
 * 64 bit, so the digits are summed in three limbs of 12 (each limb sum stays far below 2^63 for any realistic account count) and recombined in JS.
 * One statement, no rows leave the database. Falls back to paging through the rows if SQLite reports an overflow.
 */
export async function sumBalances(db: D1Database, ledger: string, kind: LedgerKind, meter: DbMeter): Promise<BalanceSum> {
  const table = balanceTable(kind);
  const where = ledgerFilter(kind);
  meter.d1Calls++;
  try {
    const r = await db.prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(sg > 0 AND a != '0'), 0) holders, COALESCE(SUM(sg < 0), 0) negative,
         CAST(COALESCE(SUM(sg * CAST(substr(a, -12) AS INTEGER)), 0) AS TEXT) l0,
         CAST(COALESCE(SUM(sg * CASE WHEN length(a) > 12 THEN CAST(substr(a, max(1, length(a) - 23), min(12, length(a) - 12)) AS INTEGER) ELSE 0 END), 0) AS TEXT) l1,
         CAST(COALESCE(SUM(sg * CASE WHEN length(a) > 24 THEN CAST(substr(a, 1, length(a) - 24) AS INTEGER) ELSE 0 END), 0) AS TEXT) l2
       FROM (SELECT ltrim(balance_raw, '-') a, CASE WHEN substr(balance_raw, 1, 1) = '-' THEN -1 ELSE 1 END sg FROM ${table} WHERE ${where})`,
    ).bind(ledger).first<{ n: number; holders: number; negative: number; l0: string; l1: string; l2: string }>();
    // Limb sums travel as TEXT: they can exceed 2^53, where a JS number would lose digits.
    if (r && [r.l0, r.l1, r.l2].every((v) => typeof v === "string" && /^-?\d+$/.test(v))) {
      return { sum: BigInt(r.l0) + BigInt(r.l1) * 10n ** 12n + BigInt(r.l2) * 10n ** 24n, accounts: r.n, holders: r.holders, negative: r.negative };
    }
  } catch { /* integer overflow inside SQLite: take the slow path */ }
  const out: BalanceSum = { sum: 0n, accounts: 0, holders: 0, negative: 0 };
  let after = "";
  for (;;) {
    meter.d1Calls++;
    const page = (await db.prepare(`SELECT account, balance_raw FROM ${table} WHERE ${where} AND account > ?2 ORDER BY account LIMIT 20000`).bind(ledger, after).all<{ account: string; balance_raw: string }>()).results;
    for (const row of page) {
      const b = BigInt(row.balance_raw);
      out.sum += b;
      out.accounts++;
      if (b > 0n) out.holders++;
      else if (b < 0n) out.negative++;
    }
    if (page.length < 20000) break;
    after = page[page.length - 1]!.account;
  }
  return out;
}

export interface TokenSeed { id: string; decimals: number | null; fee: string | null; total_supply: string | null }

/** Listed ICRC tokens that have no index state yet. The ICP ledger is excluded (different block format, see ledger.ts). */
export async function unprobedTokens(db: D1Database, excludeLedger: string, limit: number): Promise<TokenSeed[]> {
  const r = await db.prepare(
    `SELECT t.id, t.decimals, t.fee, t.total_supply FROM tokens t LEFT JOIN idx_state s ON s.ledger = t.id
     WHERE s.ledger IS NULL AND t.hidden = 0 AND t.standard = 'icrc1' AND t.id != ?1 ORDER BY t.listed_at LIMIT ?2`,
  ).bind(excludeLedger, limit).all<TokenSeed>();
  return r.results;
}

export async function tokenSeed(db: D1Database, ledger: string): Promise<TokenSeed | null> {
  try {
    return await db.prepare("SELECT id, decimals, fee, total_supply FROM tokens WHERE id = ?").bind(ledger).first<TokenSeed>();
  } catch {
    return null;
  }
}

/** Caught-up (or nearly caught-up) ledgers that are due for a poll, longest-waiting first. */
export async function dueForTail(db: D1Database, now: number, tailMax: number, limit: number): Promise<IdxStateRow[]> {
  const r = await db.prepare("SELECT * FROM idx_state WHERE retry_at <= ?1 AND next_check_at <= ?1 AND tip - next_block <= ?2 ORDER BY next_check_at, ledger LIMIT ?3")
    .bind(now, tailMax, limit).all<IdxStateRow>();
  return r.results;
}

/** Ledgers with a real backlog, smallest backlog first so most tokens get holders quickly. */
export async function dueForBackfill(db: D1Database, now: number, tailMax: number, limit: number): Promise<IdxStateRow[]> {
  const r = await db.prepare("SELECT * FROM idx_state WHERE retry_at <= ?1 AND tip - next_block > ?2 ORDER BY tip - next_block, ledger LIMIT ?3")
    .bind(now, tailMax, limit).all<IdxStateRow>();
  return r.results;
}

/** Wipe one ledger's index so it replays from block 0. For repairs and tests, never called by the cron path. */
export async function resetLedger(db: D1Database, ledger: string): Promise<void> {
  const st = await getState(db, ledger);
  await db.batch([
    st?.kind === "icp" ? db.prepare("DELETE FROM icp_balances") : db.prepare("DELETE FROM balances WHERE ledger = ?").bind(ledger),
    db.prepare("DELETE FROM transfers_big WHERE ledger = ?").bind(ledger),
    db.prepare("DELETE FROM ledger_daily WHERE ledger = ?").bind(ledger),
    db.prepare("DELETE FROM idx_state WHERE ledger = ?").bind(ledger),
  ]);
}

/**
 * Automatic repair: drop everything replayed with an older balance algorithm and start over at block 0 with the
 * current one. Ledger parameters (decimals, fee, threshold, source) are kept. Compare-and-swap on algo_version, so
 * two ticks cannot both wipe. ICRC ledgers only: the ICP index was born on the current version.
 */
export async function resetForReplay(db: D1Database, ledger: string, fromAlgo: number, toAlgo: number, now: number, note: string, meter: DbMeter): Promise<boolean> {
  meter.d1Calls++;
  const guard = "(SELECT algo_version FROM idx_state WHERE ledger = ?1) = ?2";
  const results = await db.batch([
    db.prepare(`DELETE FROM balances WHERE ledger = ?1 AND ${guard}`).bind(ledger, fromAlgo),
    db.prepare(`DELETE FROM transfers_big WHERE ledger = ?1 AND ${guard}`).bind(ledger, fromAlgo),
    db.prepare(`DELETE FROM ledger_daily WHERE ledger = ?1 AND ${guard}`).bind(ledger, fromAlgo),
    db.prepare(
      `UPDATE idx_state SET next_block = 0, holders = 0, accounts = 0, status = 'pending', completed_at = NULL, last_block_ts = NULL, started_at = NULL, next_check_at = 0,
         fee_cols = NULL, minted_raw = '0', burned_raw = '0', fees_burned_raw = '0', fees_collected_raw = '0', algo_version = ?3, replays = replays + 1,
         reconcile_ok = NULL, reconcile_note = ?5, reconcile_next_at = 0, updated_at = ?4
       WHERE ledger = ?1 AND algo_version = ?2 AND kind = 'icrc'`,
    ).bind(ledger, fromAlgo, toAlgo, now, note.slice(0, 300)),
  ]);
  tally(meter, results);
  return !!results[results.length - 1]?.meta?.changes;
}
