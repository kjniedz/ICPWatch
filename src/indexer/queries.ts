// Read API over the block index, for pages and the JSON API. No IC calls, D1 reads only.
//
// Honesty rule: balances are exact as of block next_block - 1, which is only the present once the
// replay has reached the tip. Every holder result carries `complete` and the full progress record, so
// the UI can say "indexing 43%" instead of presenting a half-replayed ledger as the holder list.
// Amounts: *_raw / *Raw are exact base units as text. The plain numbers are whole tokens as floats.

export interface IndexProgress {
  ledger: string;
  /** pending | syncing | synced | error | unsupported */
  status: string;
  nextBlock: number;
  tip: number;
  /** Blocks not yet applied, as of the last check. */
  behind: number;
  /** 0 to 100, one decimal. Never 100 unless complete. */
  percent: number;
  /** True when every block known at the last check has been applied. Holder data is only presentable as such when true. */
  complete: boolean;
  holders: number;
  accounts: number;
  /** Timestamp of the last applied block: balances are "as of" this moment. */
  asOfTs: number | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  error: string | null;
  decimals: number;
  bigMinRaw: string | null;
}

interface StateRow {
  ledger: string; next_block: number; tip: number; decimals: number; big_min_raw: string | null; holders: number; accounts: number; status: string;
  error: string | null; last_block_ts: number | null; started_at: number | null; updated_at: number; completed_at: number | null;
}

const STATE_COLS = "ledger, next_block, tip, decimals, big_min_raw, holders, accounts, status, error, last_block_ts, started_at, updated_at, completed_at";

function toProgress(r: StateRow): IndexProgress {
  const complete = r.status !== "unsupported" && r.completed_at != null && r.next_block >= r.tip;
  const pct = r.tip > 0 ? Math.floor((r.next_block / r.tip) * 1000) / 10 : 0;
  return {
    ledger: r.ledger, status: r.status, nextBlock: r.next_block, tip: r.tip, behind: Math.max(0, r.tip - r.next_block),
    percent: complete ? 100 : Math.min(99.9, pct), complete, holders: r.holders, accounts: r.accounts, asOfTs: r.last_block_ts,
    startedAt: r.started_at, completedAt: r.completed_at, updatedAt: r.updated_at, error: r.error, decimals: r.decimals, bigMinRaw: r.big_min_raw,
  };
}

/** Index progress for one ledger. Null means the indexer has not seen this ledger yet. */
export async function indexProgress(db: D1Database, ledger: string): Promise<IndexProgress | null> {
  const r = await db.prepare(`SELECT ${STATE_COLS} FROM idx_state WHERE ledger = ?`).bind(ledger).first<StateRow>();
  return r ? toProgress(r) : null;
}

export async function indexProgressAll(db: D1Database): Promise<IndexProgress[]> {
  return (await db.prepare(`SELECT ${STATE_COLS} FROM idx_state ORDER BY tip - next_block DESC, ledger`).all<StateRow>()).results.map(toProgress);
}

export interface IndexOverview { ledgers: number; complete: number; failing: number; blocksIndexed: number; blocksTotal: number; percent: number }

/** One-line summary for a status page: how much of everything is indexed. */
export async function indexOverview(db: D1Database): Promise<IndexOverview> {
  const all = await indexProgressAll(db);
  const blocksIndexed = all.reduce((s, p) => s + p.nextBlock, 0);
  const blocksTotal = all.reduce((s, p) => s + Math.max(p.tip, p.nextBlock), 0);
  return {
    ledgers: all.length, complete: all.filter((p) => p.complete).length, failing: all.filter((p) => p.status === "error").length,
    blocksIndexed, blocksTotal, percent: blocksTotal ? Math.floor((blocksIndexed / blocksTotal) * 1000) / 10 : 0,
  };
}

export interface HolderRow {
  rank: number; account: string; owner: string; balance: number; balanceRaw: string;
  /** Fraction of supply, 0 to 1. Null when no supply figure is available. */
  share: number | null;
  txCount: number; firstSeen: number; lastActive: number;
}

export interface SupplyBasis { units: number | null; source: "caller" | "tokens" | "indexed-sum" | "none" }

/**
 * Supply used for shares: the caller's figure, else tokens.total_supply, else the sum of indexed balances
 * (which scans the ledger's holder index, so pass a supply when you have one).
 */
async function supplyBasis(db: D1Database, ledger: string, decimals: number, totalSupplyRaw?: string | bigint | null): Promise<SupplyBasis> {
  const units = (raw: string | bigint) => Number(BigInt(raw)) / 10 ** decimals;
  if (totalSupplyRaw != null && BigInt(totalSupplyRaw) > 0n) return { units: units(totalSupplyRaw), source: "caller" };
  const t = await db.prepare("SELECT total_supply FROM tokens WHERE id = ?").bind(ledger).first<{ total_supply: string | null }>().catch(() => null);
  if (t?.total_supply && /^\d+$/.test(t.total_supply) && t.total_supply !== "0") return { units: units(t.total_supply), source: "tokens" };
  const s = await db.prepare("SELECT SUM(balance) s FROM balances WHERE ledger = ? AND balance > 0").bind(ledger).first<{ s: number | null }>();
  return s?.s ? { units: s.s, source: "indexed-sum" } : { units: null, source: "none" };
}

export interface TopHolders { ledger: string; complete: boolean; progress: IndexProgress | null; supply: SupplyBasis; holders: HolderRow[] }

/** Largest accounts of a ledger with their share of supply. Check `complete` before presenting this as the holder list. */
export async function topHolders(db: D1Database, ledger: string, opts: { limit?: number; offset?: number; totalSupplyRaw?: string | bigint | null } = {}): Promise<TopHolders> {
  const progress = await indexProgress(db, ledger);
  if (!progress) return { ledger, complete: false, progress: null, supply: { units: null, source: "none" }, holders: [] };
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const [supply, rows] = await Promise.all([
    supplyBasis(db, ledger, progress.decimals, opts.totalSupplyRaw),
    db.prepare("SELECT account, owner, balance, balance_raw, tx_count, first_seen, last_active FROM balances WHERE ledger = ? AND balance > 0 ORDER BY balance DESC LIMIT ? OFFSET ?")
      .bind(ledger, limit, offset).all<{ account: string; owner: string; balance: number; balance_raw: string; tx_count: number; first_seen: number; last_active: number }>(),
  ]);
  return {
    ledger, complete: progress.complete, progress, supply,
    holders: rows.results.map((r, i) => ({
      rank: offset + i + 1, account: r.account, owner: r.owner, balance: r.balance, balanceRaw: r.balance_raw,
      share: supply.units ? r.balance / supply.units : null, txCount: r.tx_count, firstSeen: r.first_seen, lastActive: r.last_active,
    })),
  };
}

export interface HolderStats {
  ledger: string; complete: boolean; progress: IndexProgress | null; supply: SupplyBasis;
  /** Accounts with a balance above zero. */
  holders: number;
  /** Every account ever seen, emptied ones included. */
  accounts: number;
  /** Share of supply held by the largest N accounts, 0 to 1. Null without a supply figure. */
  top10Share: number | null; top50Share: number | null; top100Share: number | null;
}

/** Holder count and concentration. Accounts are ledger accounts: a DEX pool or a treasury counts as one holder. */
export async function holderStats(db: D1Database, ledger: string, totalSupplyRaw?: string | bigint | null): Promise<HolderStats> {
  const progress = await indexProgress(db, ledger);
  if (!progress) return { ledger, complete: false, progress: null, supply: { units: null, source: "none" }, holders: 0, accounts: 0, top10Share: null, top50Share: null, top100Share: null };
  const [supply, top] = await Promise.all([
    supplyBasis(db, ledger, progress.decimals, totalSupplyRaw),
    db.prepare("SELECT balance FROM balances WHERE ledger = ? AND balance > 0 ORDER BY balance DESC LIMIT 100").bind(ledger).all<{ balance: number }>(),
  ]);
  const share = (n: number) => (supply.units ? Math.min(1, top.results.slice(0, n).reduce((s, r) => s + r.balance, 0) / supply.units) : null);
  return { ledger, complete: progress.complete, progress, supply, holders: progress.holders, accounts: progress.accounts, top10Share: share(10), top50Share: share(50), top100Share: share(100) };
}

export interface BigTransferRow {
  ledger: string; block: number; ts: number; kind: string; from_account: string | null; to_account: string | null; amount: number; amount_raw: string;
  symbol: string | null; decimals: number | null;
}

/**
 * Recent large movements, across all ledgers or for one. Page the cross-ledger feed with `beforeTs` (ts of the
 * last row seen) and a single ledger with `beforeBlock`. `minAmount` is in whole tokens.
 * While a ledger is still backfilling, its newest rows here are old blocks: check indexProgress if that matters.
 */
export async function largeTransfers(db: D1Database, opts: { ledger?: string; limit?: number; beforeTs?: number; beforeBlock?: number; kinds?: ("transfer" | "mint" | "burn")[]; minAmount?: number } = {}): Promise<BigTransferRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.ledger) { where.push("b.ledger = ?"); args.push(opts.ledger); }
  if (opts.beforeTs != null) { where.push("b.ts < ?"); args.push(opts.beforeTs); }
  if (opts.beforeBlock != null) { where.push("b.block < ?"); args.push(opts.beforeBlock); }
  if (opts.minAmount != null) { where.push("b.amount >= ?"); args.push(opts.minAmount); }
  if (opts.kinds?.length) { where.push(`b.kind IN (${opts.kinds.map(() => "?").join(",")})`); args.push(...opts.kinds); }
  const sql = `SELECT b.ledger, b.block, b.ts, b.kind, b.from_account, b.to_account, b.amount, b.amount_raw, t.symbol, t.decimals
    FROM transfers_big b LEFT JOIN tokens t ON t.id = b.ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${opts.ledger ? "b.block DESC" : "b.ts DESC, b.block DESC"} LIMIT ?`;
  return (await db.prepare(sql).bind(...args, Math.min(Math.max(opts.limit ?? 50, 1), 500)).all<BigTransferRow>()).results;
}

export interface AccountHolding {
  ledger: string; account: string; owner: string; balance: number; balance_raw: string; tx_count: number; first_seen: number; last_active: number;
  symbol: string | null; name: string | null; decimals: number | null;
  /** 1 when that ledger's index is complete, so the balance is current. 0 means the figure is a replay in progress. */
  complete: number;
}

/** Every account (all subaccounts) of an owner principal across all indexed ledgers. */
export async function accountHoldings(db: D1Database, owner: string, opts: { includeEmpty?: boolean; limit?: number } = {}): Promise<AccountHolding[]> {
  const sql = `SELECT b.ledger, b.account, b.owner, b.balance, b.balance_raw, b.tx_count, b.first_seen, b.last_active, t.symbol, t.name, COALESCE(t.decimals, s.decimals) decimals,
      CASE WHEN s.completed_at IS NOT NULL AND s.next_block >= s.tip THEN 1 ELSE 0 END complete
    FROM balances b LEFT JOIN tokens t ON t.id = b.ledger LEFT JOIN idx_state s ON s.ledger = b.ledger
    WHERE b.owner = ? ${opts.includeEmpty ? "" : "AND b.balance > 0"} ORDER BY b.last_active DESC LIMIT ?`;
  return (await db.prepare(sql).bind(owner, Math.min(Math.max(opts.limit ?? 200, 1), 1000)).all<AccountHolding>()).results;
}

/** One exact account on one ledger (account is the ICRC-1 text form used as the key). */
export async function accountBalance(db: D1Database, ledger: string, account: string): Promise<{ balance: number; balance_raw: string; tx_count: number; first_seen: number; last_active: number } | null> {
  return db.prepare("SELECT balance, balance_raw, tx_count, first_seen, last_active FROM balances WHERE ledger = ? AND account = ?").bind(ledger, account).first();
}

export interface DailyStatsRow {
  day: number; txs: number; transfers: number; volume: number; mints: number; burns: number; fees: number; active_accounts: number; new_accounts: number; holders: number;
}

/** Daily activity, oldest first. Days without any block have no row: forward-fill holders when charting. */
export async function dailyStats(db: D1Database, ledger: string, days = 90): Promise<DailyStatsRow[]> {
  const rows = (await db.prepare("SELECT day, txs, transfers, volume, mints, burns, fees, active_accounts, new_accounts, holders FROM ledger_daily WHERE ledger = ? ORDER BY day DESC LIMIT ?")
    .bind(ledger, Math.min(Math.max(days, 1), 4000)).all<DailyStatsRow>()).results;
  return rows.reverse();
}
