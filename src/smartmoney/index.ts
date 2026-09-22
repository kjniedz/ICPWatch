// Smart money from our own index: large transfers between wallets and labeled DEX pools, priced at
// our hourly candle for that hour. This is the trades we saw, not everyone's trades: the indexer
// keeps only large movements, so small accounts never rank here, by construction.
import type { Env } from "../env";
import { accountHoldings } from "../indexer/queries";
import { isTreasuryOrPool, labelsFor, type EntityLabel } from "../labels";
import { now } from "../lib/format";

const DAYS = 90;
const TOP = 50;

interface Tx { ledger: string; ts: number; from_account: string | null; to_account: string | null; amount: number }
export interface Position { token_id: string; symbol: string; bought: number; bought_usd: number; sold: number; sold_usd: number; held: number; held_usd: number; pnl_usd: number; closed: boolean }

export interface SmartStats { transfers: number; trades: number; wallets: number; ranked: number; errors: number }

/** Owner principal of an ICRC account text (owner, or owner-checksum.subaccount). */
const ownerOf = (a: string) => { const d = a.indexOf("."); return d < 0 ? a : a.slice(0, a.slice(0, d).lastIndexOf("-")); };

export async function collectSmartMoney(env: Env): Promise<SmartStats> {
  const db = env.DB;
  const ts = now();
  const stats: SmartStats = { transfers: 0, trades: 0, wallets: 0, ranked: 0, errors: 0 };
  const since = ts - DAYS * 86400;
  const txs = (await db.prepare("SELECT ledger, ts, from_account, to_account, amount FROM transfers_big WHERE kind = 'transfer' AND ts >= ?1 AND from_account IS NOT NULL AND to_account IS NOT NULL ORDER BY ts LIMIT 40000").bind(since).all<Tx>()).results;
  stats.transfers = txs.length;
  if (!txs.length) return stats;
  const accounts = [...new Set(txs.flatMap((t) => [t.from_account!, t.to_account!]))];
  const labels = new Map<string, EntityLabel>();
  for (let i = 0; i < accounts.length; i += 500) for (const [k, v] of await labelsFor(db, accounts.slice(i, i + 500))) labels.set(k, v);
  const isPool = (a: string) => labels.get(a)?.category === "dex_pool";
  const tokens = new Map((await db.prepare("SELECT id, symbol FROM tokens").all<{ id: string; symbol: string }>()).results.map((t) => [t.id, t.symbol]));
  const priceNow = new Map((await db.prepare("SELECT token_id, price_usd FROM market WHERE price_usd IS NOT NULL").all<{ token_id: string; price_usd: number }>()).results.map((r) => [r.token_id, r.price_usd]));

  const priceCache = new Map<string, Promise<number | null>>();
  const priceAt = (ledger: string, at: number) => {
    const hour = at - (at % 3600);
    const key = `${ledger}:${hour}`;
    if (!priceCache.has(key)) priceCache.set(key, db.prepare("SELECT price_usd FROM prices WHERE token_id = ?1 AND res = 'hour' AND ts <= ?2 AND ts >= ?3 ORDER BY ts DESC LIMIT 1").bind(ledger, hour + 3600, hour - 6 * 3600).first<{ price_usd: number }>().then((r) => r?.price_usd ?? null));
    return priceCache.get(key)!;
  };

  type Pos = Position & { first: number; last: number };
  const wallets = new Map<string, Map<string, Pos>>();
  const flows = new Map<string, { buy: number; sell: number; wallets: Set<string> }>();
  for (const t of txs) {
    const fromPool = isPool(t.from_account!), toPool = isPool(t.to_account!);
    if (fromPool === toPool) continue;
    const wallet = fromPool ? t.to_account! : t.from_account!;
    const owner = ownerOf(wallet);
    const l = labels.get(wallet) ?? labels.get(owner);
    if (l && (isTreasuryOrPool(l) || l.category === "exchange" || l.category === "minter")) continue;
    const px = await priceAt(t.ledger, t.ts);
    if (px == null) continue;
    const usd = t.amount * px;
    if (usd < 200) continue;
    stats.trades++;
    const per = wallets.get(owner) ?? new Map<string, Pos>();
    const p = per.get(t.ledger) ?? { token_id: t.ledger, symbol: tokens.get(t.ledger) ?? "?", bought: 0, bought_usd: 0, sold: 0, sold_usd: 0, held: 0, held_usd: 0, pnl_usd: 0, closed: false, first: t.ts, last: t.ts };
    if (fromPool) { p.bought += t.amount; p.bought_usd += usd; } else { p.sold += t.amount; p.sold_usd += usd; }
    p.last = Math.max(p.last, t.ts);
    per.set(t.ledger, p); wallets.set(owner, per);
    const day = t.ts - (t.ts % 86400);
    const fk = `${day}:${t.ledger}`;
    const f = flows.get(fk) ?? { buy: 0, sell: 0, wallets: new Set<string>() };
    if (fromPool) f.buy += usd; else f.sell += usd;
    f.wallets.add(owner); flows.set(fk, f);
  }
  stats.wallets = wallets.size;

  // Score each wallet. Held amounts come from the index so unrealized P&L is against real balances, capped at what was bought.
  const rows: { owner: string; score: number; realized: number; unrealized: number; invested: number; trades: number; wins: number; losses: number; tokens: Position[]; first: number; last: number }[] = [];
  const candidates = [...wallets.entries()].filter(([, per]) => [...per.values()].some((p) => p.bought_usd > 0)).slice(0, 600);
  for (const [owner, per] of candidates) {
    try {
      const held = new Map((await accountHoldings(db, owner, { limit: 300 })).map((h) => [h.ledger, h.balance]));
      let realized = 0, unrealized = 0, invested = 0, wins = 0, losses = 0, trades = 0, first = Infinity, last = 0;
      const positions: Position[] = [];
      for (const p of per.values()) {
        if (p.bought_usd === 0) continue; // sells of tokens we never saw them buy: no cost basis
        const avgCost = p.bought_usd / p.bought;
        const soldWithin = Math.min(p.sold, p.bought);
        const realizedHere = p.sold_usd * (soldWithin / Math.max(p.sold, 1e-9)) - soldWithin * avgCost;
        const heldNow = Math.min(held.get(p.token_id) ?? 0, Math.max(0, p.bought - soldWithin));
        const heldUsd = heldNow * (priceNow.get(p.token_id) ?? 0);
        const unrealizedHere = heldUsd - heldNow * avgCost;
        const closed = heldNow < p.bought * 0.05;
        if (closed) { if (realizedHere > 0) wins++; else losses++; }
        realized += realizedHere; unrealized += unrealizedHere; invested += p.bought_usd; trades++;
        first = Math.min(first, p.first); last = Math.max(last, p.last);
        positions.push({ token_id: p.token_id, symbol: p.symbol, bought: p.bought, bought_usd: p.bought_usd, sold: p.sold, sold_usd: p.sold_usd, held: heldNow, held_usd: heldUsd, pnl_usd: realizedHere + unrealizedHere, closed });
      }
      if (!trades || invested < 1000) continue;
      const roi = (realized + unrealized) / invested;
      // Rank on return, damped by how many positions back it, so one lucky trade does not top the board.
      const score = roi * Math.min(1, trades / 4) * Math.log10(Math.max(10, invested));
      rows.push({ owner, score, realized, unrealized, invested, trades, wins, losses, tokens: positions.sort((a, b) => b.pnl_usd - a.pnl_usd), first, last });
    } catch { stats.errors++; }
  }
  rows.sort((a, b) => b.score - a.score);
  stats.ranked = rows.length;
  const stmts: D1PreparedStatement[] = [db.prepare("DELETE FROM smart_wallets"), db.prepare("DELETE FROM smart_flows WHERE day >= ?1").bind(since - (since % 86400))];
  for (const r of rows.slice(0, 300)) {
    stmts.push(db.prepare("INSERT INTO smart_wallets (owner, score, realized_usd, unrealized_usd, invested_usd, trades, wins, losses, tokens, first_trade, last_trade, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
      .bind(r.owner, r.score, r.realized, r.unrealized, r.invested, r.trades, r.wins, r.losses, JSON.stringify(r.tokens.slice(0, 20)), r.first, r.last, ts));
  }
  const top = new Set(rows.slice(0, TOP).map((r) => r.owner));
  for (const [key, f] of flows) {
    const inTop = [...f.wallets].filter((w) => top.has(w));
    if (!inTop.length) continue;
    const [day, token] = key.split(":");
    const share = inTop.length / f.wallets.size; // approximate: flow attributed by wallet count
    stmts.push(db.prepare("INSERT OR REPLACE INTO smart_flows (day, token_id, buy_usd, sell_usd, wallets) VALUES (?1, ?2, ?3, ?4, ?5)").bind(Number(day), token, f.buy * share, f.sell * share, inTop.length));
  }
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
  return stats;
}

export interface SmartWalletRow { owner: string; score: number; realized_usd: number; unrealized_usd: number; invested_usd: number; trades: number; wins: number; losses: number; tokens: string; first_trade: number | null; last_trade: number | null; updated_at: number }
export interface SmartFlowRow { token_id: string; symbol: string; name: string; logo: string | null; buy_usd: number; sell_usd: number; wallets: number }

export const smartWallets = async (db: D1Database, limit = 50): Promise<SmartWalletRow[]> =>
  (await db.prepare("SELECT * FROM smart_wallets ORDER BY score DESC LIMIT ?1").bind(limit).all<SmartWalletRow>()).results;

export const smartFlows = async (db: D1Database, days = 7): Promise<SmartFlowRow[]> =>
  (await db.prepare("SELECT f.token_id, t.symbol, t.name, t.logo, SUM(f.buy_usd) buy_usd, SUM(f.sell_usd) sell_usd, MAX(f.wallets) wallets FROM smart_flows f JOIN tokens t ON t.id = f.token_id WHERE f.day >= ?1 GROUP BY f.token_id ORDER BY (SUM(f.buy_usd) - SUM(f.sell_usd)) DESC").bind(now() - days * 86400).all<SmartFlowRow>()).results;
