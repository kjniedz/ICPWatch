// Markets collector. Runs every 5 minutes.
//
// DEX data comes in through adapters so sources can be added or swapped without touching the
// aggregation. Reality check as of 2026-09-21 (verified live): ICPSwap is the only ICP DEX with
// real volume. KongSwap is dead (every pool removed, API offline), Sonic is dormant, ICDex trades
// about a dollar a day. ICPSwap's own on-chain info canisters are stopped, so its REST API is the
// feed, cross-checked against the ICP/ckUSDC pool read directly on chain.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Env } from "../env";
import { now } from "../lib/format";
import { getAgent, pool } from "../lib/ic";
import { batchAll } from "./lifeline";

export interface DexPool {
  id: string; token0: string; token1: string; symbol0: string; symbol1: string; name0?: string; name1?: string;
  amount0: number; amount1: number; price0Usd: number; price1Usd: number; vol24hUsd: number; vol7dUsd: number; feeBps: number;
}
export interface DexQuote { ledger: string; symbol: string; name: string; priceUsd: number; chg24h: number | null; vol24hUsd: number; vol7dUsd: number }
export interface DexSnapshot { dex: string; pools: DexPool[]; quotes: DexQuote[] }
export interface DexAdapter { name: string; snapshot(): Promise<DexSnapshot> }

const f = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---- adapter: ICPSwap (third party REST, isolated here) -----------------------------------------------

const ICPSWAP = "https://api.icpswap.com/info";

async function icpswapGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ICPSWAP}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`icpswap ${path} ${res.status}`);
  const body = (await res.json()) as { code: number; data: T };
  if (body.code !== 200) throw new Error(`icpswap ${path} code ${body.code}`);
  return body.data;
}

export const icpswap: DexAdapter = {
  name: "ICPSwap",
  async snapshot() {
    const [pools, tokens] = await Promise.all([icpswapGet<Record<string, string | number>[]>("/pool/all"), icpswapGet<Record<string, string>[]>("/token/all")]);
    return {
      dex: "ICPSwap",
      pools: pools.map((p) => ({
        id: String(p.poolId), token0: String(p.token0LedgerId), token1: String(p.token1LedgerId), symbol0: String(p.token0Symbol), symbol1: String(p.token1Symbol),
        name0: String(p.token0Name), name1: String(p.token1Name), amount0: f(p.token0LiquidityAmount), amount1: f(p.token1LiquidityAmount),
        price0Usd: f(p.token0Price), price1Usd: f(p.token1Price), vol24hUsd: f(p.volumeUSD24H), vol7dUsd: f(p.volumeUSD7D), feeBps: f(p.poolFee) / 100,
      })),
      quotes: tokens.map((t) => ({
        ledger: t.tokenLedgerId!, symbol: t.tokenSymbol!, name: t.tokenName!, priceUsd: f(t.price), chg24h: t.priceChange24H != null ? f(t.priceChange24H) : null,
        vol24hUsd: f(t.volumeUSD24H), vol7dUsd: f(t.volumeUSD7D),
      })),
    };
  },
};

export const ADAPTERS: DexAdapter[] = [icpswap];

// ---- on chain: ICP/USD from the deepest stable pool ---------------------------------------------------------

const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const CKUSDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const CKUSDT = "cngnf-vqaaa-aaaar-qag4q-cai";
const CKBTC = "mxzaz-hqaaa-aaaar-qaada-cai";
const CKETH = "ss2fx-dyaaa-aaaar-qacoq-cai";
const ICP_USDC_POOL = "mohjv-bqaaa-aaaag-qjyia-cai";

/** Tokens whose side of a pool counts as real money. Pools without one of these are ignored for TVL. */
const TRUSTED = new Set([ICP, CKUSDC, CKUSDT, CKBTC, CKETH]);

const poolIdl: IDL.InterfaceFactory = () => {
  const Token = IDL.Record({ address: IDL.Text, standard: IDL.Text });
  const Meta = IDL.Record({ sqrtPriceX96: IDL.Nat, token0: Token, token1: Token });
  return IDL.Service({ metadata: IDL.Func([], [IDL.Variant({ ok: Meta, err: IDL.Reserved })], ["query"]) });
};

/** ICP price in ckUSDC from sqrtPriceX96, read straight from the pool canister. Assumes ckUSDC = $1. */
export async function icpUsdOnChain(host: string): Promise<number | null> {
  const a = Actor.createActor(poolIdl, { agent: await getAgent(host), canisterId: ICP_USDC_POOL });
  const r = (await a.metadata!()) as { ok?: { sqrtPriceX96: bigint; token0: { address: string }; token1: { address: string } } };
  if (!r.ok) return null;
  const sq = r.ok.sqrtPriceX96;
  // price of token0 in token1, raw units, scaled by 1e18 to stay in integers
  const raw = Number((sq * sq * 10n ** 18n) >> 192n) / 1e18;
  const icpIs0 = r.ok.token0.address === ICP;
  const price = icpIs0 ? raw * 10 ** (8 - 6) : (1 / raw) * 10 ** (8 - 6);
  return Number.isFinite(price) && price > 0 ? price : null;
}

// ---- aggregation ---------------------------------------------------------------------------------------------

export interface MarketStats { pools: number; tokens: number; priced: number; listed: number; backfilled: number; icpUsd: number | null; divergence: number | null; errors: number }

const MIN_LIST_TVL = 2000; // auto-list a DEX token once this much trusted liquidity backs it

export function trustedTvl(p: DexPool, supplyOf: (id: string) => number | null = () => null): number | null {
  const t0 = TRUSTED.has(p.token0);
  const t1 = TRUSTED.has(p.token1);
  // Sanity bound: a pool cannot hold more of a token than exists. Feeds do contain overflowed
  // reserves (one ICPSwap pool reports about 1e69 ICP), and a single one would wreck every total.
  const sane = (id: string, amount: number) => Number.isFinite(amount) && amount >= 0 && amount <= (supplyOf(id) ?? 1e12);
  if ((t0 && !sane(p.token0, p.amount0)) || (t1 && !sane(p.token1, p.amount1))) return null;
  if (t0 && t1) return p.amount0 * p.price0Usd + p.amount1 * p.price1Usd;
  if (t0) return 2 * p.amount0 * p.price0Usd;
  if (t1) return 2 * p.amount1 * p.price1Usd;
  return null; // no trusted side: valuations here are self-referential and routinely fake
}

export async function collectMarkets(env: Env): Promise<MarketStats> {
  const ts = now();
  const stats: MarketStats = { pools: 0, tokens: 0, priced: 0, listed: 0, backfilled: 0, icpUsd: null, divergence: null, errors: 0 };

  const snaps: DexSnapshot[] = [];
  for (const a of ADAPTERS) {
    try {
      snaps.push(await a.snapshot());
    } catch (e) {
      stats.errors++;
      console.warn("dex adapter failed", a.name, String(e).slice(0, 200));
    }
  }
  if (!snaps.length) throw new Error("no DEX source reachable");

  const onChainIcp = await icpUsdOnChain(env.IC_HOST).catch(() => null);
  const restIcp = snaps.flatMap((s) => s.quotes).find((q) => q.ledger === ICP)?.priceUsd ?? null;
  const icpUsd = onChainIcp ?? restIcp;
  stats.icpUsd = icpUsd;
  stats.divergence = onChainIcp && restIcp ? Math.abs(onChainIcp - restIcp) / restIcp : null;

  const known = new Map((await env.DB.prepare("SELECT id, decimals, total_supply FROM tokens").all<{ id: string; decimals: number; total_supply: string | null }>()).results.map((t) => [t.id, t]));
  const supplyOf = (id: string) => {
    const t = known.get(id);
    return t?.total_supply ? Number(BigInt(t.total_supply)) / 10 ** t.decimals : null;
  };

  // Per token: liquidity by DEX, liquidity-weighted price, volume.
  interface Agg { tvlByDex: Map<string, number>; wPrice: number; w: number; quote?: DexQuote; symbol: string; name: string }
  const agg = new Map<string, Agg>();
  const get = (id: string, symbol: string, name: string) => {
    let a = agg.get(id);
    if (!a) agg.set(id, (a = { tvlByDex: new Map(), wPrice: 0, w: 0, symbol, name }));
    return a;
  };
  const poolRows: { id: string; dex: string; p: DexPool; tvl: number }[] = [];
  for (const s of snaps) {
    for (const q of s.quotes) {
      const a = get(q.ledger, q.symbol, q.name);
      if (!a.quote || q.vol24hUsd > a.quote.vol24hUsd) a.quote = q;
    }
    for (const p of s.pools) {
      const tvl = trustedTvl(p, supplyOf);
      if (tvl == null || tvl < 1) continue;
      poolRows.push({ id: `${s.dex}:${p.id}`, dex: s.dex, p, tvl });
      for (const [id, sym, name, price] of [[p.token0, p.symbol0, p.name0 ?? p.symbol0, p.price0Usd], [p.token1, p.symbol1, p.name1 ?? p.symbol1, p.price1Usd]] as [string, string, string, number][]) {
        const a = get(id, sym, name);
        a.tvlByDex.set(s.dex, (a.tvlByDex.get(s.dex) ?? 0) + tvl / 2);
        if (price > 0) {
          a.wPrice += price * tvl;
          a.w += tvl;
        }
      }
    }
  }
  stats.pools = poolRows.length;

  // Registry: known tokens, plus auto-listing for DEX tokens with real liquidity behind them.
  const stmts: D1PreparedStatement[] = [];
  const insToken = env.DB.prepare("INSERT OR IGNORE INTO tokens (id, symbol, name, decimals, kind, logo, listed_at, listed_via, updated_at) VALUES (?, ?, ?, 8, 'community', ?, ?, ?, ?)");
  for (const [id, a] of agg) {
    const tvl = [...a.tvlByDex.values()].reduce((x, y) => x + y, 0);
    if (!known.has(id) && tvl >= MIN_LIST_TVL && /^[a-z0-9-]+-cai$/.test(id)) {
      const dex = [...a.tvlByDex.entries()].sort((x, y) => y[1] - x[1])[0]![0];
      stmts.push(insToken.bind(id, a.symbol.slice(0, 24), a.name.replace(/—/g, " - ").slice(0, 80), `/logo/${id}`, ts, `dex:${dex}`, ts));
      known.set(id, { id, decimals: 8, total_supply: null });
      stats.listed++;
    }
  }

  // 7d and 30d change and the sparkline come from stored candles.
  const hist = (await env.DB.prepare("SELECT token_id, ts, price_usd, res FROM prices WHERE (res = 'hour' AND ts >= ?1) OR (res = 'day' AND ts >= ?2) ORDER BY token_id, ts").bind(ts - 7 * 86400 - 3600, ts - 31 * 86400).all<{ token_id: string; ts: number; price_usd: number; res: string }>()).results;
  const hours = new Map<string, { ts: number; p: number }[]>();
  const days = new Map<string, { ts: number; p: number }[]>();
  for (const h of hist) {
    const m = h.res === "hour" ? hours : days;
    let arr = m.get(h.token_id);
    if (!arr) m.set(h.token_id, (arr = []));
    arr.push({ ts: h.ts, p: h.price_usd });
  }
  const changeFrom = (arr: { ts: number; p: number }[] | undefined, target: number, tolerance: number, price: number) => {
    if (!arr?.length) return null;
    const ref = arr.reduce((best, x) => (Math.abs(x.ts - target) < Math.abs(best.ts - target) ? x : best));
    return Math.abs(ref.ts - target) <= tolerance && ref.p > 0 ? ((price - ref.p) / ref.p) * 100 : null;
  };

  const upMarket = env.DB.prepare(`INSERT OR REPLACE INTO market (token_id, price_usd, price_icp, chg_24h, chg_7d, chg_30d, vol_24h_usd, tvl_usd, mcap_usd, fdv_usd, liquidity, spark_7d, sources, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upHour = env.DB.prepare("INSERT INTO prices (token_id, ts, price_usd, open, high, low, vol_usd, res) VALUES (?1, ?2, ?3, ?3, ?3, ?3, NULL, 'hour') ON CONFLICT (token_id, res, ts) DO UPDATE SET price_usd = ?3, high = MAX(high, ?3), low = MIN(low, ?3)");
  const writeCandle = Math.floor(ts / 60) % 15 < 5; // one in three ticks
  let totalTvl = 0;
  let totalVol = 0;
  for (const [id, a] of agg) {
    const t = known.get(id);
    if (!t) continue;
    const tvl = [...a.tvlByDex.values()].reduce((x, y) => x + y, 0);
    let price = id === ICP && icpUsd ? icpUsd : a.w > 0 ? a.wPrice / a.w : (a.quote?.priceUsd ?? 0);
    if (id === CKUSDC || id === CKUSDT) price = a.quote?.priceUsd || 1;
    if (!(price > 0)) continue;
    const supply = t.total_supply ? Number(BigInt(t.total_supply)) / 10 ** t.decimals : null;
    const fdv = supply != null ? supply * price : null;
    const liquidity = [...a.tvlByDex.entries()].sort((x, y) => y[1] - x[1]).map(([dex, v]) => ({ dex, tvl_usd: Math.round(v), share: tvl > 0 ? v / tvl : 0 }));
    const h = hours.get(id);
    // Downsample the last 7 days of hourly closes to about 42 points for the list sparkline.
    const spark = h && h.length >= 8 ? h.filter((_, i) => i % Math.max(1, Math.floor(h.length / 42)) === 0).map((x) => Number(x.p.toPrecision(5))).concat(Number(price.toPrecision(5))) : null;
    stmts.push(upMarket.bind(
      id, price, icpUsd ? price / icpUsd : null, a.quote?.chg24h ?? null, changeFrom(h, ts - 7 * 86400, 3 * 3600, price) ?? changeFrom(days.get(id), ts - 7 * 86400, 86400, price),
      changeFrom(days.get(id), ts - 30 * 86400, 86400, price), a.quote?.vol24hUsd ?? 0, tvl, fdv, fdv, JSON.stringify(liquidity), spark ? JSON.stringify(spark) : null,
      JSON.stringify([...a.tvlByDex.keys()]), ts,
    ));
    if (writeCandle && tvl >= 500) stmts.push(upHour.bind(id, Math.floor(ts / 3600) * 3600, price));
    stats.priced++;
  }
  // Network-wide totals: every pool counted once.
  for (const r of poolRows) {
    totalTvl += r.tvl;
    totalVol += r.p.vol24hUsd;
  }

  const upPool = env.DB.prepare("INSERT OR REPLACE INTO pools (id, dex, token0, token1, symbol0, symbol1, tvl_usd, vol_24h_usd, vol_7d_usd, fee_bps, price, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const keep = poolRows.filter((r) => r.tvl >= 50).sort((x, y) => y.tvl - x.tvl).slice(0, 600);
  for (const r of keep) stmts.push(upPool.bind(r.id, r.dex, r.p.token0, r.p.token1, r.p.symbol0, r.p.symbol1, r.tvl, r.p.vol24hUsd, r.p.vol7dUsd, r.p.feeBps, r.p.price1Usd > 0 ? r.p.price0Usd / r.p.price1Usd : null, ts));
  stmts.push(env.DB.prepare("DELETE FROM pools WHERE updated_at < ?").bind(ts));
  stmts.push(
    env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES ('markets:totals', ?, ?, ?)").bind(
      JSON.stringify({ tvl_usd: totalTvl, vol_24h_usd: totalVol, pools: keep.length, tokens: known.size, priced: stats.priced, dexes: snaps.map((s) => s.dex) }),
      snaps.map((s) => s.dex).join(" + "), ts,
    ),
    env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES ('markets:icp_usd', ?, ?, ?)").bind(
      JSON.stringify({ on_chain: onChainIcp, rest: restIcp, divergence: stats.divergence }), "ICPSwap ICP/ckUSDC pool, sqrtPriceX96 read on chain", ts,
    ),
  );
  await batchAll(env.DB, stmts);
  stats.tokens = known.size;

  stats.backfilled = await backfillCandles(env, 12).catch((e) => {
    console.warn("backfill failed", String(e).slice(0, 200));
    return 0;
  });
  return stats;
}

interface Candle { beginTime: number; open: string; high: string; low: string; close: string; volumeUSD: string }

/** Pull hourly and daily candles for the tokens whose history is oldest. A few tokens per tick keeps it gentle. */
async function backfillCandles(env: Env, n: number): Promise<number> {
  const ts = now();
  const targets = (
    await env.DB.prepare(`SELECT m.token_id id FROM market m LEFT JOIN kv ON kv.key = 'bf:' || m.token_id
      WHERE m.tvl_usd >= 1000 AND (kv.fetched_at IS NULL OR kv.fetched_at < ?) ORDER BY (kv.fetched_at IS NOT NULL), kv.fetched_at, m.tvl_usd DESC LIMIT ?`).bind(ts - 6 * 3600, n).all<{ id: string }>()
  ).results;
  const ins = env.DB.prepare("INSERT OR REPLACE INTO prices (token_id, ts, price_usd, open, high, low, vol_usd, res) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const results = await pool(targets, 3, async (t) => {
    const first = !(await env.DB.prepare("SELECT 1 x FROM kv WHERE key = ?").bind(`bf:${t.id}`).first());
    const [h, d] = await Promise.all([
      icpswapGet<{ content: Candle[] }>(`/token/${t.id}/chart/h1?page=1&limit=${first ? 365 : 12}`),
      icpswapGet<{ content: Candle[] }>(`/token/${t.id}/chart/d1?page=1&limit=${first ? 365 : 3}`),
    ]);
    const stmts: D1PreparedStatement[] = [];
    for (const [res, rows] of [["hour", h.content], ["day", d.content]] as const) {
      for (const c of rows) {
        const close = f(c.close);
        if (close > 0) stmts.push(ins.bind(t.id, Math.floor(c.beginTime / 1000), close, f(c.open) || close, f(c.high) || close, f(c.low) || close, f(c.volumeUSD), res));
      }
    }
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES (?, '1', 'ICPSwap chart API', ?)").bind(`bf:${t.id}`, ts));
    await batchAll(env.DB, stmts);
    return 1;
  });
  return results.filter((r) => r.status === "fulfilled").length;
}
