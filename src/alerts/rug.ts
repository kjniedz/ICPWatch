// Rug and liquidity alerts on tracked tokens, from our own data only:
//   liquidity_drop  a token's DEX liquidity fell more than 30% in an hour or 50% in a day
//   holder_dump     a top-10 holder moved more than 1% of supply into a DEX pool within the last hour
// Both are raised against the token's ledger canister as one-shot (already resolved) incidents, so
// every token subscription and Telegram /watch receives them through the normal pipeline.
import { notifyIncident } from "./notify";
import type { CanisterRow } from "../db/queries";
import type { Env } from "../env";
import { largeTransfers, topHolders } from "../indexer/queries";
import { labelsFor } from "../labels";
import { fmtCompact, now } from "../lib/format";

export interface RugStats { pools: number; tokens: number; liquidityDrops: number; dumps: number; notified: number; errors: number }

async function raiseOnLedger(env: Env, tokenId: string, type: "liquidity_drop" | "holder_dump", title: string, detail: string, data: Record<string, unknown>): Promise<number> {
  const db = env.DB;
  const ledger = await db.prepare("SELECT c.*, t.symbol token_symbol FROM canisters c JOIN tokens t ON t.id = c.token_id WHERE c.id = ?1 AND c.role = 'ledger'").bind(tokenId).first<CanisterRow>();
  if (!ledger) return 0;
  // One per token and type per 24 hours: a rug is a single event, not a drumbeat.
  const recent = await db.prepare("SELECT 1 FROM incidents WHERE canister_id = ?1 AND type = ?2 AND opened_at > ?3").bind(ledger.id, type, now() - 86400).first();
  if (recent) return 0;
  const ts = now();
  const row = await db.prepare("INSERT INTO incidents (canister_id, type, state, severity, title, detail, data, opened_at, resolved_at) VALUES (?1, ?2, 'resolved', 'critical', ?3, ?4, ?5, ?6, ?6) RETURNING id")
    .bind(ledger.id, type, title, detail, JSON.stringify(data), ts).first<{ id: number }>();
  if (!row) return 0;
  return notifyIncident(env, { incidentId: row.id, canister: ledger, type, kind: "fired", title, detail, severity: "critical" }).catch(() => 0);
}

export async function evaluateRugSignals(env: Env): Promise<RugStats> {
  const db = env.DB;
  const ts = now();
  const stats: RugStats = { pools: 0, tokens: 0, liquidityDrops: 0, dumps: 0, notified: 0, errors: 0 };

  // 1. Record this tick's pool TVL (hourly points) and compare against one hour and one day ago, per token.
  const pools = (await db.prepare("SELECT id, token0, token1, symbol0, symbol1, tvl_usd, updated_at FROM pools WHERE tvl_usd IS NOT NULL AND tvl_usd > 0").all<{ id: string; token0: string; token1: string; symbol0: string | null; symbol1: string | null; tvl_usd: number; updated_at: number }>()).results;
  stats.pools = pools.length;
  const hour = ts - (ts % 3600);
  const writes = pools.map((p) => db.prepare("INSERT OR IGNORE INTO pool_tvl (pool_id, ts, tvl_usd) VALUES (?1, ?2, ?3)").bind(p.id, hour, p.tvl_usd));
  writes.push(db.prepare("DELETE FROM pool_tvl WHERE ts < ?1").bind(ts - 8 * 86400));
  for (let i = 0; i < writes.length; i += 80) await db.batch(writes.slice(i, i + 80));

  const byToken = new Map<string, { now: number; pools: string[] }>();
  for (const p of pools) for (const t of [p.token0, p.token1]) { const e = byToken.get(t) ?? { now: 0, pools: [] }; e.now += p.tvl_usd; e.pools.push(p.id); byToken.set(t, e); }
  const ref = async (poolIds: string[], at: number) => {
    let sum = 0;
    for (let i = 0; i < poolIds.length; i += 50) {
      const slice = poolIds.slice(i, i + 50);
      const r = await db.prepare(`SELECT pool_id, tvl_usd FROM pool_tvl WHERE ts = ?1 AND pool_id IN (${slice.map((_, j) => `?${j + 2}`).join(",")})`).bind(at, ...slice).all<{ tvl_usd: number }>();
      for (const x of r.results) sum += x.tvl_usd;
    }
    return sum;
  };
  const icp = "ryjl3-tyaaa-aaaaa-aaaba-cai";
  for (const [token, e] of byToken) {
    if (token === icp || e.now + 1 < 1000 && (await ref(e.pools, hour - 3600)) < 5000) continue; // dust pools cannot rug anyone
    stats.tokens++;
    try {
      const [h1, d1] = await Promise.all([ref(e.pools, hour - 3600), ref(e.pools, hour - 86400)]);
      const dropH = h1 >= 5000 ? 1 - e.now / h1 : 0;
      const dropD = d1 >= 5000 ? 1 - e.now / d1 : 0;
      if (dropH >= 0.3 || dropD >= 0.5) {
        const which = dropH >= 0.3 ? `${Math.round(dropH * 100)}% in the last hour (${fmtCompact(h1, "$")} to ${fmtCompact(e.now, "$")})` : `${Math.round(dropD * 100)}% in the last day (${fmtCompact(d1, "$")} to ${fmtCompact(e.now, "$")})`;
        const sym = (await db.prepare("SELECT symbol FROM tokens WHERE id = ?1").bind(token).first<{ symbol: string }>())?.symbol ?? token;
        stats.liquidityDrops++;
        stats.notified += await raiseOnLedger(env, token, "liquidity_drop", `Liquidity pulled: ${sym}`, `DEX liquidity for ${sym} fell ${which}. Liquidity leaving this fast usually means the pool owner withdrew, or a large holder sold into it.`, { token_id: token, tvl_now: e.now, tvl_1h: h1, tvl_24h: d1, href: `/token/${token}#liquidity` });
      }
    } catch { stats.errors++; }
  }

  // 2. Top-10 holder sending more than 1% of supply into a labeled DEX pool within the last hour.
  try {
    const rows = await largeTransfers(db, { limit: 300, kinds: ["transfer"] });
    const fresh = rows.filter((r) => r.ts > ts - 3600 && r.to_account);
    if (fresh.length) {
      const labels = await labelsFor(db, fresh.map((r) => r.to_account!));
      const supplies = new Map((await db.prepare("SELECT id, symbol, total_supply, decimals FROM tokens").all<{ id: string; symbol: string; total_supply: string | null; decimals: number }>()).results.map((t) => [t.id, t]));
      const topCache = new Map<string, Promise<Set<string>>>();
      for (const r of fresh) {
        const l = labels.get(r.to_account!);
        if (!l || l.category !== "dex_pool") continue;
        const t = supplies.get(r.ledger);
        if (!t?.total_supply || !/^\d+$/.test(t.total_supply)) continue;
        const supply = Number(BigInt(t.total_supply)) / 10 ** t.decimals;
        const share = r.amount / supply;
        if (share < 0.01) continue;
        if (!topCache.has(r.ledger)) topCache.set(r.ledger, topHolders(db, r.ledger, { limit: 10 }).then((h) => new Set(h.holders.map((x) => x.account))));
        const top = await topCache.get(r.ledger)!;
        if (!r.from_account || !top.has(r.from_account)) continue;
        stats.dumps++;
        stats.notified += await raiseOnLedger(env, r.ledger, "holder_dump", `Top holder selling: ${t.symbol}`, `A top-10 holder moved ${fmtCompact(r.amount)} ${t.symbol} (${(share * 100).toFixed(1)}% of supply) into ${l.name} in the last hour. Large holders entering a pool are usually about to sell.`, { token_id: r.ledger, from: r.from_account, to: r.to_account, amount: r.amount, share, block: r.block, href: `/token/${r.ledger}/holders` });
      }
    }
  } catch { stats.errors++; }
  return stats;
}
