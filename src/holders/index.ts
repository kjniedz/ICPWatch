// Full holder pages, built only from our own block index and only once a ledger has reconciled
// against icrc1_total_supply. Everything else on these pages (labels, SNS neurons) is joined from
// tables other collectors fill. No network calls.
import type { Env } from "../env";
import { indexProgress, indexProgressAll, type IndexProgress } from "../indexer/queries";
import { labelsFor, type EntityLabel } from "../labels";
import { now } from "../lib/format";

export const PAGE_SIZE = 100;
export const CSV_MAX = 5000;

export interface Holder {
  rank: number; account: string; owner: string;
  /** Total tokens: liquid plus staked when look-through is on. */
  balance: number; liquid: number; staked: number;
  share: number | null; txCount: number | null; firstSeen: number | null; lastActive: number | null;
  label: EntityLabel | null;
  /** Number of neurons behind the staked figure. */
  neurons: number;
}

export interface HoldersPage {
  ledger: string; progress: IndexProgress; supplyUnits: number | null;
  rows: Holder[]; page: number; pages: number; total: number; query: string; lookThrough: boolean;
  /** Present when the ledger belongs to an SNS: how much of supply sits in neurons, and how many neurons we have walked. */
  sns: { governance: string; staked: number; neurons: number; controllers: number; walkDone: number | null } | null;
}

const balanceTable = (kind: string) => (kind === "icp" ? "icp_balances" : "balances");
const ledgerWhere = (kind: string) => (kind === "icp" ? "?1 IS NOT NULL" : "ledger = ?1");

function supplyUnits(progress: IndexProgress, totalSupplyRaw: string | null | undefined): number | null {
  if (totalSupplyRaw && /^\d+$/.test(totalSupplyRaw) && totalSupplyRaw !== "0") return Number(BigInt(totalSupplyRaw)) / 10 ** progress.decimals;
  return null;
}

/** Governance principal of the SNS a ledger belongs to, from the kv row the SNS collector writes. Null for non-SNS ledgers. */
async function governanceOf(db: D1Database, ledger: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(`sns:${ledger}`).first<{ value: string }>();
  if (!r) return null;
  try { return (JSON.parse(r.value) as { governance?: string }).governance ?? null; } catch { return null; }
}

interface Loaded {
  progress: IndexProgress; supply: number | null; lookThrough: boolean; sns: HoldersPage["sns"];
  /** Sorted by balance desc. Complete for query and look-through mode; otherwise one SQL page. */
  list: Holder[]; total: number; offset: number;
}

type Row = { account: string; owner: string | null; balance: number; tx_count: number; first_seen: number; last_active: number };

/**
 * With `lookThrough` on for an SNS ledger, neuron stakes (held in governance subaccounts) are attributed
 * to the principal that controls the neuron and the governance accounts themselves drop out. Ranking is
 * then by liquid plus staked. Bounded: the top 2000 liquid accounts are merged with every controller's
 * stake, so a principal beyond liquid rank 2000 with a small stake could rank a few places off.
 * Search (`query`) matches an account or owner prefix.
 */
export interface LoadOpts { query?: string; lookThrough?: boolean; totalSupplyRaw?: string | null; offset?: number; limit?: number; progress?: IndexProgress | null }

async function load(db: D1Database, ledger: string, opts: LoadOpts): Promise<Loaded | null> {
  const t0 = Date.now();
  const marks: string[] = [];
  const mark = (what: string) => marks.push(`${what} ${Date.now() - t0}ms`);
  // One round trip for everything the row query does not depend on. The neuron aggregate is harmless
  // for a non-SNS ledger (empty) and saves waiting on the kv read first.
  const [progress, governanceRaw, agg, st] = await Promise.all([
    opts.progress !== undefined ? Promise.resolve(opts.progress) : indexProgress(db, ledger),
    governanceOf(db, ledger),
    db.prepare("SELECT controller, SUM(stake) staked, COUNT(*) n FROM sns_neurons WHERE token_id = ?1 AND controller IS NOT NULL GROUP BY controller").bind(ledger).all<{ controller: string; staked: number; n: number }>(),
    db.prepare("SELECT neurons, staked, pass_done FROM sns_neuron_state WHERE token_id = ?1").bind(ledger).first<{ neurons: number; staked: number; pass_done: number | null }>(),
  ]);
  if (!progress?.trusted) return null;
  const kind = progress.kind, tbl = balanceTable(kind), where = ledgerWhere(kind);
  const query = (opts.query ?? "").trim().toLowerCase().slice(0, 100);
  const supply = supplyUnits(progress, opts.totalSupplyRaw);
  const governance = kind === "icp" ? null : governanceRaw;
  const lookThrough = !!governance && opts.lookThrough !== false;

  let stakes = new Map<string, { staked: number; neurons: number }>();
  let sns: HoldersPage["sns"] = null;
  if (governance) {
    stakes = new Map(agg.results.map((r) => [r.controller, { staked: r.staked, neurons: r.n }]));
    // Walked figures, not the state row's, so a DAO mid-way through its first pass still shows what we have.
    let staked = 0, neurons = 0;
    for (const v of stakes.values()) { staked += v.staked; neurons += v.neurons; }
    sns = { governance, staked, neurons, controllers: stakes.size, walkDone: st?.pass_done ?? null };
    mark("stakes");
  }

  let rows: Row[];
  let offset = 0;
  const paged = !query && !lookThrough;
  if (query) {
    // Prefix ranges on the primary key and the owner index; D1 rejects LIKE patterns over 50 bytes.
    const hi = query + "\uffff";
    const ownerCol = kind === "icp" ? "account" : "owner";
    rows = (await db.prepare(`SELECT account, owner, balance, tx_count, first_seen, last_active FROM ${tbl} WHERE ${where} AND balance > 0 AND ((account >= ?2 AND account < ?3) OR (${ownerCol} >= ?2 AND ${ownerCol} < ?3)) ORDER BY balance DESC LIMIT 500`)
      .bind(ledger, query, hi).all<Row>()).results;
  } else if (lookThrough) {
    rows = (await db.prepare(`SELECT account, owner, balance, tx_count, first_seen, last_active FROM ${tbl} WHERE ${where} AND balance > 0 AND owner != ?2 ORDER BY balance DESC LIMIT 2000`).bind(ledger, governance).all<Row>()).results;
  } else {
    offset = Math.max(0, opts.offset ?? 0);
    rows = (await db.prepare(`SELECT account, owner, balance, tx_count, first_seen, last_active FROM ${tbl} WHERE ${where} AND balance > 0 ORDER BY balance DESC LIMIT ?2 OFFSET ?3`).bind(ledger, Math.min(opts.limit ?? PAGE_SIZE, CSV_MAX), offset).all<Row>()).results;
  }

  mark("rows");
  // Merge: liquid rows keyed by account; stakes land on the controller's default account.
  const merged = new Map<string, Holder>();
  const add = (account: string, owner: string, liquid: number, staked: number, neurons: number, r: Row | null) => {
    const cur = merged.get(account);
    if (cur) { cur.liquid += liquid; cur.staked += staked; cur.neurons += neurons; cur.balance = cur.liquid + cur.staked; return; }
    merged.set(account, { rank: 0, account, owner, balance: liquid + staked, liquid, staked, share: null, txCount: r?.tx_count ?? null, firstSeen: r?.first_seen ?? null, lastActive: r?.last_active ?? null, label: null, neurons });
  };
  for (const r of rows) add(r.account, r.owner ?? r.account, r.balance, 0, 0, r);
  if (lookThrough) for (const [controller, s] of stakes) if (!query || controller.startsWith(query)) add(controller, controller, 0, s.staked, s.neurons, null);
  const list = [...merged.values()].sort((a, b) => b.balance - a.balance);
  list.forEach((h, i) => { h.rank = offset + i + 1; h.share = supply ? h.balance / supply : null; });
  mark("merge");
  console.log("holders", ledger, marks.join(", "));
  return { progress, supply, lookThrough, sns, list, total: paged ? progress.holders : list.length, offset };
}

async function attachLabels(db: D1Database, list: Holder[]) {
  const labels = await labelsFor(db, list.flatMap((h) => (h.owner === h.account ? [h.account] : [h.account, h.owner])));
  for (const h of list) h.label = labels.get(h.account) ?? labels.get(h.owner) ?? null;
}

/** Holder list, one page of PAGE_SIZE. Null unless the ledger's index is trusted. */
export async function holdersPage(db: D1Database, ledger: string, opts: { page?: number; query?: string; lookThrough?: boolean; totalSupplyRaw?: string | null; progress?: IndexProgress | null }): Promise<HoldersPage | null> {
  const page = Math.max(1, opts.page ?? 1);
  const L = await load(db, ledger, { ...opts, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE });
  if (!L) return null;
  const paged = !opts.query && !L.lookThrough;
  const rows = paged ? L.list : L.list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  await attachLabels(db, rows);
  return { ledger, progress: L.progress, supplyUnits: L.supply, rows, page, pages: Math.max(1, Math.ceil(L.total / PAGE_SIZE)), total: L.total, query: (opts.query ?? "").trim(), lookThrough: L.lookThrough, sns: L.sns };
}

/** CSV of the top holders, look-through applied when asked. Capped at CSV_MAX rows. */
export async function holdersCsv(db: D1Database, ledger: string, opts: { lookThrough?: boolean; totalSupplyRaw?: string | null; symbol: string }): Promise<string | null> {
  const L = await load(db, ledger, { ...opts, limit: CSV_MAX });
  if (!L) return null;
  const rows = L.list.slice(0, CSV_MAX);
  await attachLabels(db, rows);
  const q = (s: string | number | null | undefined) => (s == null ? "" : /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const lines = ["rank,account,owner,balance,liquid,staked,share,label,category,tx_count,first_seen,last_active"];
  for (const h of rows) lines.push([h.rank, h.account, h.owner, h.balance, h.liquid, h.staked, h.share ?? "", h.label?.name ?? "", h.label?.category ?? "", h.txCount ?? "", h.firstSeen ?? "", h.lastActive ?? ""].map(q).join(","));
  const head = `# ICPWatch holders of ${opts.symbol} (${ledger}), as of block time ${L.progress.asOfTs ? new Date(L.progress.asOfTs * 1000).toISOString() : "n/a"}, look-through ${L.lookThrough ? "on" : "off"}, source: ICPWatch block index reconciled against icrc1_total_supply`;
  return `${head}\n${lines.join("\n")}\n`;
}

export interface Bucket { label: string; min: number; holders: number; balance: number }
const BUCKETS: [string, number, number][] = [
  ["under 1", 0, 1], ["1 to 10", 1, 10], ["10 to 100", 10, 100], ["100 to 1K", 100, 1e3], ["1K to 10K", 1e3, 1e4], ["10K to 100K", 1e4, 1e5], ["100K to 1M", 1e5, 1e6], ["1M and up", 1e6, Infinity],
];

/** Holders and tokens per balance band. One scan over the ledger's positive balances. */
export async function holderBuckets(db: D1Database, ledger: string, kind: string): Promise<Bucket[]> {
  const cases = BUCKETS.map(([, lo, hi], i) => `WHEN balance >= ${lo}${hi === Infinity ? "" : ` AND balance < ${hi}`} THEN ${i}`).join(" ");
  const r = await db.prepare(`SELECT CASE ${cases} END b, COUNT(*) n, SUM(balance) s FROM ${balanceTable(kind)} WHERE ${ledgerWhere(kind)} AND balance > 0 GROUP BY b`).bind(ledger).all<{ b: number; n: number; s: number }>();
  const by = new Map(r.results.map((x) => [x.b, x]));
  return BUCKETS.map(([label, min], i) => ({ label, min, holders: by.get(i)?.n ?? 0, balance: by.get(i)?.s ?? 0 }));
}

export interface Concentration { gini: number | null; nakamoto: number | null; top10Share: number | null; holders: number }

/**
 * Gini over positive balances (0 equal, 1 one account holds everything) and the Nakamoto coefficient
 * (fewest accounts that together pass half of supply). Both in SQL with window functions so a ledger
 * with a hundred thousand holders never crosses into the Worker.
 */
export async function concentration(db: D1Database, ledger: string, kind: string, supply: number | null): Promise<Concentration> {
  const tbl = balanceTable(kind), where = ledgerWhere(kind);
  const [g, top] = await Promise.all([
    db.prepare(`SELECT COUNT(*) n, SUM(balance) s, SUM(rn * balance) w FROM (SELECT balance, ROW_NUMBER() OVER (ORDER BY balance ASC) rn FROM ${tbl} WHERE ${where} AND balance > 0)`).bind(ledger).first<{ n: number; s: number; w: number }>(),
    db.prepare(`SELECT balance FROM ${tbl} WHERE ${where} AND balance > 0 ORDER BY balance DESC LIMIT 1000`).bind(ledger).all<{ balance: number }>(),
  ]);
  const n = g?.n ?? 0;
  const gini = n > 1 && g?.s ? (2 * g.w) / (n * g.s) - (n + 1) / n : null;
  const basis = supply ?? g?.s ?? null;
  let nakamoto: number | null = null, top10 = 0, cum = 0;
  if (basis) {
    for (let i = 0; i < top.results.length; i++) {
      cum += top.results[i]!.balance;
      if (i < 10) top10 = cum;
      if (nakamoto == null && cum > basis / 2) nakamoto = i + 1;
    }
    // More than a thousand accounts needed: report the bound rather than a wrong number.
    if (nakamoto == null && top.results.length === 1000) nakamoto = 1000;
  }
  return { gini, nakamoto, top10Share: basis ? Math.min(1, top10 / basis) : null, holders: n };
}

export interface HolderStatsBundle { conc: Concentration; buckets: Bucket[]; computedAt: number }

/** Concentration and bands, cached in kv for an hour: the window query scans every balance of the ledger. */
export async function holderStatsCached(db: D1Database, ledger: string, kind: string, supply: number | null): Promise<HolderStatsBundle> {
  const key = `holders:stats:${ledger}`;
  const ts = now();
  const hit = await db.prepare("SELECT value, fetched_at FROM kv WHERE key = ?").bind(key).first<{ value: string; fetched_at: number }>();
  if (hit && ts - hit.fetched_at < 3600) {
    try { return { ...(JSON.parse(hit.value) as Omit<HolderStatsBundle, "computedAt">), computedAt: hit.fetched_at }; } catch { /* recompute */ }
  }
  const [conc, buckets] = await Promise.all([concentration(db, ledger, kind, supply), holderBuckets(db, ledger, kind)]);
  await db.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES (?, ?, 'holders', ?)").bind(key, JSON.stringify({ conc, buckets }), ts).run();
  return { conc, buckets, computedAt: ts };
}

export interface EntitySlice { category: string; share: number; holders: number }

/** Share of supply by entity type over the largest accounts, labeled ones by category, the rest "unlabeled". */
export function entityMix(rows: Holder[], supply: number | null): EntitySlice[] {
  if (!supply) return [];
  const by = new Map<string, EntitySlice>();
  let seen = 0;
  for (const h of rows) {
    const cat = h.label?.category ?? (h.staked > 0 && h.liquid === 0 ? "neuron_holder" : "unlabeled");
    const s = by.get(cat) ?? { category: cat, share: 0, holders: 0 };
    s.share += h.balance / supply; s.holders++; seen += h.balance / supply;
    by.set(cat, s);
  }
  const out = [...by.values()].sort((a, b) => b.share - a.share);
  if (seen < 1) out.push({ category: "everyone_else", share: Math.max(0, 1 - seen), holders: 0 });
  return out;
}

export interface DailyRow { day: number; holders: number; new_holders: number; exited: number; top10_share: number | null; gini: number | null; nakamoto: number | null }

export const holderHistory = async (db: D1Database, ledger: string, days = 180): Promise<DailyRow[]> =>
  (await db.prepare("SELECT day, holders, new_holders, exited, top10_share, gini, nakamoto FROM holder_daily WHERE ledger = ?1 AND day >= ?2 ORDER BY day").bind(ledger, now() - days * 86400).all<DailyRow>()).results;

export interface HolderDailyStats { ledgers: number; written: number; skipped: number; errors: number }

/**
 * Nightly snapshot per trusted ledger. New holders are accounts first seen that day; exited are
 * accounts whose balance is zero and whose last activity was that day (an account that emptied and
 * refilled within the day is missed, which is fine for a trend line).
 */
export async function holderDailyJob(env: Env): Promise<HolderDailyStats> {
  const db = env.DB;
  const stats: HolderDailyStats = { ledgers: 0, written: 0, skipped: 0, errors: 0 };
  const all = (await indexProgressAll(db)).filter((p) => p.trusted);
  const day = Math.floor(now() / 86400) * 86400 - 86400; // yesterday, complete
  const supplies = new Map((await db.prepare("SELECT id, total_supply FROM tokens").all<{ id: string; total_supply: string | null }>()).results.map((r) => [r.id, r.total_supply]));
  for (const p of all) {
    stats.ledgers++;
    try {
      const tbl = balanceTable(p.kind), where = ledgerWhere(p.kind);
      const [conc, flow] = await Promise.all([
        concentration(db, p.ledger, p.kind, supplyUnits(p, supplies.get(p.ledger))),
        db.prepare(`SELECT SUM(first_seen >= ?2 AND first_seen < ?3 AND balance > 0) new_holders, SUM(balance <= 0 AND last_active >= ?2 AND last_active < ?3) exited FROM ${tbl} WHERE ${where} AND last_active >= ?2`)
          .bind(p.ledger, day, day + 86400).first<{ new_holders: number | null; exited: number | null }>(),
      ]);
      await db.prepare("INSERT OR REPLACE INTO holder_daily (ledger, day, holders, new_holders, exited, top10_share, gini, nakamoto) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
        .bind(p.ledger, day, conc.holders, flow?.new_holders ?? 0, flow?.exited ?? 0, conc.top10Share, conc.gini, conc.nakamoto).run();
      stats.written++;
    } catch (e) {
      stats.errors++;
      console.error("holder-daily", p.ledger, e instanceof Error ? e.message : String(e));
    }
  }
  return stats;
}
