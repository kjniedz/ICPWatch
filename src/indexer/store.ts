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
}

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

export async function loadExisting(db: D1Database, ledger: string, accounts: string[], meter: DbMeter): Promise<Map<string, ExistingRow>> {
  const out = new Map<string, ExistingRow>();
  if (!accounts.length) return out;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < accounts.length; i += READ_KEYS_PER_STMT) {
    stmts.push(
      db.prepare("SELECT account, balance_raw, tx_count, last_active FROM balances WHERE ledger = ?1 AND account IN (SELECT value FROM json_each(?2))")
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
}

const GUARD = "(SELECT next_block FROM idx_state WHERE ledger = ?1) = ?3";

const balanceJson = (rows: BalanceUpsert[]) => JSON.stringify(rows.map((r) => [r.account, r.owner, r.balance, r.balanceRaw, r.txCount, r.firstSeen, r.lastActive]));
const bigJson = (rows: BigRow[]) => JSON.stringify(rows.map((r) => [r.block, r.ts, r.kind, r.from, r.to, r.amount, r.amountRaw]));
const dailyJson = (rows: DailyRow[]) => JSON.stringify(rows.map((r) => [r.day, r.txs, r.transfers, r.volume, r.mints, r.burns, r.fees, r.activeAccounts, r.newAccounts, r.holders]));

/** One transactional batch: rows first, cursor last. Throws CursorMovedError when it lost a race (nothing was written). */
export async function commitChunk(db: D1Database, plan: CommitPlan, cur: CursorUpdate, meter: DbMeter): Promise<void> {
  const t0 = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < plan.upserts.length; i += WRITE_ROWS_PER_STMT) {
    stmts.push(
      db.prepare(
        `INSERT INTO balances (ledger, account, owner, balance, balance_raw, tx_count, first_seen, last_active)
         SELECT ?1, value->>0, value->>1, value->>2, value->>3, value->>4, value->>5, value->>6 FROM json_each(?2) WHERE ${GUARD}
         ON CONFLICT (ledger, account) DO UPDATE SET balance = excluded.balance, balance_raw = excluded.balance_raw, tx_count = excluded.tx_count, last_active = excluded.last_active`,
      ).bind(cur.ledger, balanceJson(plan.upserts.slice(i, i + WRITE_ROWS_PER_STMT)), cur.expected),
    );
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
         last_block_ts = COALESCE(?9, last_block_ts), updated_at = ?10, started_at = COALESCE(started_at, ?10), completed_at = COALESCE(completed_at, ?11)
       WHERE ledger = ?1 AND next_block = ?3`,
    ).bind(cur.ledger, cur.next, cur.expected, cur.tip, plan.holdersAfter, plan.accountsAfter, cur.status, cur.nextCheckAt, cur.lastBlockTs, cur.now, cur.completed ? cur.now : null),
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
    `UPDATE idx_state SET tip = ?3, status = ?4, error = NULL, fails = 0, retry_at = 0, next_check_at = ?5, updated_at = ?6, completed_at = COALESCE(completed_at, ?7)
     WHERE ledger = ?1 AND next_block = ?2`,
  ).bind(cur.ledger, cur.expected, cur.tip, cur.status, cur.nextCheckAt, cur.now, cur.completed ? cur.now : null).run();
  tally(meter, [r]);
}

/** Record a failure and back off: 5 minutes doubling up to 6 hours, or a fixed long pause for unsupported ledgers. */
export async function recordError(db: D1Database, ledger: string, error: string, now: number, opts: { unsupported?: boolean; fails: number }, meter: DbMeter): Promise<number> {
  const fails = opts.fails + 1;
  const retryAt = now + (opts.unsupported ? 7 * 86_400 : Math.min(6 * 3600, 300 * 2 ** Math.min(fails - 1, 10)));
  meter.d1Calls++;
  const r = await db.prepare(
    `INSERT INTO idx_state (ledger, status, error, fails, retry_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (ledger) DO UPDATE SET status = excluded.status, error = excluded.error, fails = excluded.fails, retry_at = excluded.retry_at, updated_at = excluded.updated_at`,
  ).bind(ledger, opts.unsupported ? "unsupported" : "error", error.slice(0, 500), fails, retryAt, now).run();
  tally(meter, [r]);
  return retryAt;
}

export interface ProbeInsert { ledger: string; tip: number; decimals: number; defaultFee: string; bigMinRaw: string | null; now: number }

export async function insertState(db: D1Database, p: ProbeInsert, meter: DbMeter): Promise<void> {
  meter.d1Calls++;
  const r = await db.prepare(
    `INSERT INTO idx_state (ledger, next_block, tip, decimals, default_fee, big_min_raw, status, updated_at) VALUES (?1, 0, ?2, ?3, ?4, ?5, 'pending', ?6)
     ON CONFLICT (ledger) DO UPDATE SET tip = excluded.tip, decimals = excluded.decimals, default_fee = excluded.default_fee,
       big_min_raw = COALESCE(idx_state.big_min_raw, excluded.big_min_raw), status = CASE WHEN idx_state.next_block = 0 THEN 'pending' ELSE 'syncing' END,
       error = NULL, retry_at = 0, updated_at = excluded.updated_at`,
  ).bind(p.ledger, p.tip, p.decimals, p.defaultFee, p.bigMinRaw, p.now).run();
  tally(meter, [r]);
}

export async function setLedgerParams(db: D1Database, ledger: string, fields: { defaultFee?: string; bigMinRaw?: string }, meter: DbMeter): Promise<void> {
  meter.d1Calls++;
  const r = await db.prepare("UPDATE idx_state SET default_fee = COALESCE(?2, default_fee), big_min_raw = COALESCE(?3, big_min_raw) WHERE ledger = ?1")
    .bind(ledger, fields.defaultFee ?? null, fields.bigMinRaw ?? null).run();
  tally(meter, [r]);
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
  await db.batch([
    db.prepare("DELETE FROM balances WHERE ledger = ?").bind(ledger),
    db.prepare("DELETE FROM transfers_big WHERE ledger = ?").bind(ledger),
    db.prepare("DELETE FROM ledger_daily WHERE ledger = ?").bind(ledger),
    db.prepare("DELETE FROM idx_state WHERE ledger = ?").bind(ledger),
  ]);
}
