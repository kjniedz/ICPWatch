// Exchange netflows and decentralization tables. Both computed nightly from our own data and stored in kv.
import type { Env } from "../env";
import { holderStatsCached } from "../holders";
import { indexProgressAll } from "../indexer/queries";
import { ICP_LEDGER } from "../lib/ic";
import { now } from "../lib/format";

export interface Hub { account: string; label: string | null; confidence: "verified" | "inferred" | "community"; in_counterparties: number; out_counterparties: number; ledger: string }
export interface FlowDay { day: number; in_usd: number; out_usd: number; in_amt: number; out_amt: number }
export interface TokenFlow { token_id: string; symbol: string; net_24h: number; net_7d: number; net_30d: number; in_30d: number; out_30d: number; hubs: number }
export interface FlowsTable { computed_at: number; hubs: Hub[]; icp_daily: FlowDay[]; tokens: TokenFlow[] }

const MIN_COUNTERPARTIES = 60;

export async function computeFlows(env: Env): Promise<{ hubs: number; tokens: number }> {
  const db = env.DB;
  const ts = now();
  const since = ts - 365 * 86400;
  // Labeled exchanges first (verified or community), then inferred hubs from counterparty fan-in and fan-out.
  const labeled = (await db.prepare("SELECT id, name, confidence FROM labels WHERE category = 'exchange'").all<{ id: string; name: string; confidence: Hub["confidence"] }>()).results;
  const hubs: Hub[] = labeled.map((l) => ({ account: l.id, label: l.name, confidence: l.confidence, in_counterparties: 0, out_counterparties: 0, ledger: ICP_LEDGER }));
  const fan = await db.prepare(`
    WITH ins AS (SELECT ledger, to_account a, COUNT(DISTINCT from_account) n FROM transfers_big WHERE kind = 'transfer' AND ts >= ?1 AND to_account IS NOT NULL GROUP BY ledger, to_account),
         outs AS (SELECT ledger, from_account a, COUNT(DISTINCT to_account) n FROM transfers_big WHERE kind = 'transfer' AND ts >= ?1 AND from_account IS NOT NULL GROUP BY ledger, from_account)
    SELECT ins.ledger, ins.a, ins.n i, outs.n o FROM ins JOIN outs ON outs.ledger = ins.ledger AND outs.a = ins.a WHERE ins.n >= ?2 AND outs.n >= ?2 ORDER BY ins.n + outs.n DESC LIMIT 60`).bind(since, MIN_COUNTERPARTIES).all<{ ledger: string; a: string; i: number; o: number }>();
  const known = new Set(hubs.map((h) => h.account));
  const protocol = new Set((await db.prepare("SELECT id FROM labels WHERE category IN ('dex_pool','dex','sns_treasury','sns_governance','sns_swap','minter','burn','nns','ledger','index','archive','sns_root','bridge')").all<{ id: string }>()).results.map((r) => r.id));
  for (const r of fan.results) {
    if (known.has(r.a) || protocol.has(r.a)) continue;
    const l = await db.prepare("SELECT name FROM labels WHERE id = ?1").bind(r.a).first<{ name: string }>();
    hubs.push({ account: r.a, label: l?.name ?? null, confidence: "inferred", in_counterparties: r.i, out_counterparties: r.o, ledger: r.ledger });
  }
  const prices = new Map((await db.prepare("SELECT token_id, price_usd FROM market WHERE price_usd IS NOT NULL").all<{ token_id: string; price_usd: number }>()).results.map((r) => [r.token_id, r.price_usd]));
  const symbols = new Map((await db.prepare("SELECT id, symbol FROM tokens").all<{ id: string; symbol: string }>()).results.map((r) => [r.id, r.symbol]));

  // Daily flows: to a hub = inflow (usually selling pressure), from a hub = outflow (withdrawal to self custody).
  const ids = hubs.map((h) => h.account);
  const icpDaily = new Map<number, FlowDay>();
  const perToken = new Map<string, TokenFlow>();
  for (let i = 0; i < ids.length; i += 40) {
    const slice = ids.slice(i, i + 40);
    const ph = slice.map((_, j) => `?${j + 2}`).join(",");
    const r = await db.prepare(`SELECT ledger, ts, from_account, to_account, amount FROM transfers_big WHERE kind = 'transfer' AND ts >= ?1 AND (to_account IN (${ph}) OR from_account IN (${ph}))`).bind(since, ...slice, ...slice)
      .all<{ ledger: string; ts: number; from_account: string | null; to_account: string | null; amount: number }>();
    const set = new Set(slice);
    for (const t of r.results) {
      const toHub = set.has(t.to_account ?? ""), fromHub = set.has(t.from_account ?? "");
      if (toHub === fromHub) continue;
      const usd = t.amount * (prices.get(t.ledger) ?? 0);
      const day = t.ts - (t.ts % 86400);
      if (t.ledger === ICP_LEDGER) {
        const d = icpDaily.get(day) ?? { day, in_usd: 0, out_usd: 0, in_amt: 0, out_amt: 0 };
        if (toHub) { d.in_usd += usd; d.in_amt += t.amount; } else { d.out_usd += usd; d.out_amt += t.amount; }
        icpDaily.set(day, d);
      }
      const tf = perToken.get(t.ledger) ?? { token_id: t.ledger, symbol: symbols.get(t.ledger) ?? "?", net_24h: 0, net_7d: 0, net_30d: 0, in_30d: 0, out_30d: 0, hubs: 0 };
      const signed = toHub ? usd : -usd;
      if (t.ts >= ts - 86400) tf.net_24h += signed;
      if (t.ts >= ts - 7 * 86400) tf.net_7d += signed;
      if (t.ts >= ts - 30 * 86400) { tf.net_30d += signed; if (toHub) tf.in_30d += usd; else tf.out_30d += usd; }
      perToken.set(t.ledger, tf);
    }
  }
  const table: FlowsTable = {
    computed_at: ts, hubs,
    icp_daily: [...icpDaily.values()].sort((a, b) => a.day - b.day),
    tokens: [...perToken.values()].filter((t) => t.in_30d + t.out_30d > 0).sort((a, b) => Math.abs(b.net_7d) - Math.abs(a.net_7d)),
  };
  await db.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES ('flows:table', ?1, 'ICPWatch block index + labels', ?2)").bind(JSON.stringify(table), ts).run();
  return { hubs: hubs.length, tokens: table.tokens.length };
}

export interface DecRow { token_id: string; symbol: string; name: string; logo: string | null; kind: string; holders: number; top10: number | null; gini: number | null; nakamoto: number | null; vp_top5: number | null; vp_controllers: number | null; mcap_usd: number | null }
export interface DecTable { computed_at: number; rows: DecRow[] }

export async function computeDecentralization(env: Env): Promise<{ tokens: number }> {
  const db = env.DB;
  const ts = now();
  const trusted = (await indexProgressAll(db)).filter((p) => p.trusted);
  const tokens = new Map((await db.prepare("SELECT t.id, t.symbol, t.name, t.logo, t.kind, t.total_supply, t.decimals, m.mcap_usd FROM tokens t LEFT JOIN market m ON m.token_id = t.id").all<{ id: string; symbol: string; name: string; logo: string | null; kind: string; total_supply: string | null; decimals: number; mcap_usd: number | null }>()).results.map((t) => [t.id, t]));
  const vp = new Map((await db.prepare(`
    WITH c AS (SELECT token_id, controller, SUM(stake * vp_multiplier / 100.0) vp FROM sns_neurons WHERE controller IS NOT NULL GROUP BY token_id, controller),
         r AS (SELECT token_id, vp, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY vp DESC) rn, SUM(vp) OVER (PARTITION BY token_id) total, COUNT(*) OVER (PARTITION BY token_id) n FROM c)
    SELECT token_id, SUM(CASE WHEN rn <= 5 THEN vp ELSE 0 END) / MAX(total) top5, MAX(n) n FROM r GROUP BY token_id`).all<{ token_id: string; top5: number; n: number }>()).results.map((r) => [r.token_id, r]));
  const rows: DecRow[] = [];
  for (const p of trusted) {
    const t = tokens.get(p.ledger);
    if (!t) continue;
    try {
      const supply = t.total_supply && /^\d+$/.test(t.total_supply) ? Number(BigInt(t.total_supply)) / 10 ** t.decimals : null;
      const s = await holderStatsCached(db, p.ledger, p.kind, supply);
      const v = vp.get(p.ledger);
      rows.push({ token_id: p.ledger, symbol: t.symbol, name: t.name, logo: t.logo, kind: t.kind, holders: s.conc.holders, top10: s.conc.top10Share, gini: s.conc.gini, nakamoto: s.conc.nakamoto, vp_top5: v?.top5 ?? null, vp_controllers: v?.n ?? null, mcap_usd: t.mcap_usd });
    } catch { /* skip this ledger tonight */ }
  }
  rows.sort((a, b) => (b.nakamoto ?? 0) - (a.nakamoto ?? 0));
  await db.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES ('decentralization:table', ?1, 'ICPWatch block index + SNS neuron walk', ?2)").bind(JSON.stringify({ computed_at: ts, rows } satisfies DecTable), ts).run();
  return { tokens: rows.length };
}
