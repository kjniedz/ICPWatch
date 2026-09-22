// Launchpad feed. One adapter today: FomoWell, whose main canister answers query_meme_tokens anonymously.
// Everything read here is public canister state; nothing is trusted beyond what the canister itself says.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Env } from "../env";
import { getAgent, pool } from "../lib/ic";
import { now } from "../lib/format";

export const FOMOWELL = "arcoq-syaaa-aaaah-arewa-cai";

const memeIdl: IDL.InterfaceFactory = ({ IDL }) => {
  const Pool = IDL.Record({ k: IDL.Nat, id: IDL.Nat64, sats: IDL.Nat, runes: IDL.Nat });
  const Token = IDL.Record({
    id: IDL.Nat64, creator: IDL.Text, decimals: IDL.Nat8, ticker: IDL.Text, available_token: IDL.Nat, twitter: IDL.Opt(IDL.Text), logo: IDL.Text, name: IDL.Text,
    pool: IDL.Opt(Pool), market_cap_token: IDL.Nat, completed: IDL.Bool, is_frozen: IDL.Bool, description: IDL.Text, created_at: IDL.Nat64, website: IDL.Opt(IDL.Text),
    meme_token_type: IDL.Text, price: IDL.Float64, telegram: IDL.Opt(IDL.Text), total_supply: IDL.Nat, process: IDL.Float64, is_etch: IDL.Bool,
  });
  const Sort = IDL.Variant({ CreateTimeDsc: IDL.Null, MarketCapDsc: IDL.Null });
  const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
  return IDL.Service({
    query_meme_tokens: IDL.Func([IDL.Record({ sort: IDL.Opt(Sort), start: IDL.Nat64, length: IDL.Nat64 })], [IDL.Record({ meme_tokens: IDL.Vec(Token), count: IDL.Nat64 })], ["query"]),
    query_token_holders_v2: IDL.Func([IDL.Nat64, IDL.Nat64, IDL.Nat64], [IDL.Vec(IDL.Record({ balance: IDL.Nat, locked: IDL.Bool, account: Account })), IDL.Nat64], ["query"]),
    query_meme_token_lock_lp: IDL.Func([IDL.Nat64], [IDL.Vec(IDL.Reserved)], ["query"]),
  });
};

interface MemeToken {
  id: bigint; creator: string; decimals: number; ticker: string; twitter: [] | [string]; logo: string; name: string; pool: [] | [{ k: bigint; id: bigint; sats: bigint; runes: bigint }];
  market_cap_token: bigint; completed: boolean; is_frozen: boolean; description: string; created_at: bigint; website: [] | [string]; meme_token_type: string; price: number; telegram: [] | [string]; total_supply: bigint; process: number;
}

export interface LaunchpadStats { seen: number; new: number; holdersChecked: number; flagged: number; errors: number }

export type Flag = "bundled" | "creator_sold" | "frozen" | "thin" | "creator_heavy";

/** Provisional grade: enough to rank a launch, not a substitute for the full trust score. */
export function provisionalScore(x: { ageDays: number; creatorShare: number | null; top5Share: number | null; lpLocked: number | null; graduated: boolean; frozen: boolean; poolSats: number | null }): { score: number; grade: string; flags: Flag[] } {
  let s = 50;
  const flags: Flag[] = [];
  if (x.frozen) { s -= 40; flags.push("frozen"); }
  if (x.graduated) s += 10;
  s += Math.min(15, x.ageDays * 1.5);
  if (x.creatorShare != null) {
    if (x.creatorShare > 0.3) { s -= 25; flags.push("creator_heavy"); } else if (x.creatorShare > 0.1) s -= 10; else s += 5;
  }
  if (x.top5Share != null) {
    if (x.top5Share > 0.6) { s -= 20; flags.push("bundled"); } else if (x.top5Share > 0.4) s -= 8; else s += 5;
  }
  if (x.lpLocked === 1) s += 15; else if (x.lpLocked === 0 && x.graduated) s -= 10;
  if (x.poolSats != null && x.poolSats < 1_000_000) { s -= 10; flags.push("thin"); } // under 0.01 BTC of quote liquidity
  const score = Math.max(0, Math.min(100, Math.round(s)));
  const grade = score >= 75 ? "B" : score >= 55 ? "C" : score >= 35 ? "D" : "E";
  return { score, grade, flags };
}

export async function collectLaunchpad(env: Env): Promise<LaunchpadStats> {
  const db = env.DB;
  const ts = now();
  const stats: LaunchpadStats = { seen: 0, new: 0, holdersChecked: 0, flagged: 0, errors: 0 };
  const actor = Actor.createActor(memeIdl, { agent: await getAgent(env.IC_HOST), canisterId: FOMOWELL });
  // Two pages newest first: 120 tokens covers weeks of launches; older ones only need a refresh when they change.
  const list: MemeToken[] = [];
  for (let start = 0n; start < 120n; start += 60n) {
    const r = (await actor.query_meme_tokens!({ sort: [{ CreateTimeDsc: null }], start, length: 60n })) as { meme_tokens: MemeToken[]; count: bigint };
    list.push(...r.meme_tokens);
    if (r.meme_tokens.length < 60) break;
  }
  stats.seen = list.length;
  const known = new Map((await db.prepare("SELECT ext_id, creator_share_first, updated_at, creator_share, lp_locked FROM launchpad_tokens WHERE source = 'fomowell'").all<{ ext_id: string; creator_share_first: number | null; updated_at: number; creator_share: number | null; lp_locked: number | null }>()).results.map((r) => [r.ext_id, r]));

  const up = db.prepare(`INSERT INTO launchpad_tokens (source, ext_id, ticker, name, creator, kind, ledger, created_at, progress, graduated, frozen, price_sats, pool_sats, mcap_sats, creator_share, creator_share_first, top5_share, lp_locked, flags, score, grade, links, logo, first_seen, updated_at)
    VALUES ('fomowell', ?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?22)
    ON CONFLICT (source, ext_id) DO UPDATE SET ticker = excluded.ticker, name = excluded.name, progress = excluded.progress, graduated = excluded.graduated, frozen = excluded.frozen, price_sats = excluded.price_sats, pool_sats = excluded.pool_sats, mcap_sats = excluded.mcap_sats,
      creator_share = COALESCE(excluded.creator_share, launchpad_tokens.creator_share), creator_share_first = COALESCE(launchpad_tokens.creator_share_first, excluded.creator_share_first), top5_share = COALESCE(excluded.top5_share, launchpad_tokens.top5_share),
      lp_locked = COALESCE(excluded.lp_locked, launchpad_tokens.lp_locked), flags = excluded.flags, score = excluded.score, grade = excluded.grade, links = excluded.links, logo = excluded.logo, updated_at = excluded.updated_at`);
  const writes: D1PreparedStatement[] = [];

  // Holder checks: every new token, plus known ones not refreshed in 6 hours, capped per run.
  const due = list.filter((t) => { const k = known.get(String(t.id)); return !k || ts - k.updated_at > 6 * 3600; }).slice(0, 40);
  const holderInfo = new Map<string, { creatorShare: number | null; top5Share: number | null; lpLocked: number | null }>();
  await pool(due, 4, async (t) => {
    try {
      // Pages start at 1. The launchpad canister itself holds the curve or pool inventory and is the largest account.
      const [holders] = (await actor.query_token_holders_v2!(t.id, 1n, 12n)) as [{ balance: bigint; locked: boolean; account: { owner: { toText(): string } } }[], bigint];
      const supply = Number(t.total_supply);
      const inventory = holders.filter((h) => h.account.owner.toText() === FOMOWELL).reduce((a, h) => a + Number(h.balance), 0);
      const circulating = Math.max(1, supply - inventory);
      const nonPool = holders.filter((h) => h.account.owner.toText() !== FOMOWELL);
      const creator = nonPool.find((h) => h.account.owner.toText() === t.creator);
      const top5 = nonPool.slice(0, 5).reduce((s, h) => s + Number(h.balance), 0) / circulating;
      let lpLocked: number | null = null;
      try { const locks = (await actor.query_meme_token_lock_lp!(t.id)) as unknown[]; lpLocked = locks.length ? 1 : 0; } catch { lpLocked = null; }
      // With almost nothing sold, the top five are trivially "everyone": shares only mean something once a slice of supply circulates.
      const early = !t.completed && circulating < supply * 0.05;
      holderInfo.set(String(t.id), { creatorShare: early ? null : creator ? Number(creator.balance) / circulating : 0, top5Share: early ? null : Math.min(1, top5), lpLocked });
      stats.holdersChecked++;
    } catch { stats.errors++; }
  });

  for (const t of list) {
    const id = String(t.id);
    const k = known.get(id);
    const h = holderInfo.get(id);
    const created = Number(t.created_at / 1_000_000_000n);
    const creatorShare = h?.creatorShare ?? k?.creator_share ?? null;
    const first = k?.creator_share_first ?? creatorShare;
    const graded = provisionalScore({ ageDays: (ts - created) / 86400, creatorShare, top5Share: h?.top5Share ?? null, lpLocked: h?.lpLocked ?? k?.lp_locked ?? null, graduated: t.completed, frozen: t.is_frozen, poolSats: t.pool[0] ? Number(t.pool[0].sats) : null });
    const flags: Flag[] = [...graded.flags];
    if (first != null && creatorShare != null && first > 0.05 && creatorShare < first * 0.5) flags.push("creator_sold");
    if (flags.length) stats.flagged++;
    if (!k) stats.new++;
    const kind = t.meme_token_type.split(":")[0]?.toLowerCase() ?? null;
    writes.push(up.bind(id, t.ticker, t.name, t.creator, kind, created, t.process, t.completed ? 1 : 0, t.is_frozen ? 1 : 0, t.price, t.pool[0] ? Number(t.pool[0].sats) : null, Number(t.market_cap_token),
      creatorShare, first, h?.top5Share ?? null, h?.lpLocked ?? null, JSON.stringify(flags), graded.score, graded.grade,
      JSON.stringify({ website: t.website[0] ?? null, twitter: t.twitter[0] ?? null, telegram: t.telegram[0] ?? null }), t.logo.startsWith("http") ? t.logo.slice(0, 300) : null, ts));
  }
  for (let i = 0; i < writes.length; i += 60) await db.batch(writes.slice(i, i + 60));
  return stats;
}

export interface LaunchRow {
  source: string; ext_id: string; ticker: string; name: string; creator: string | null; kind: string | null; created_at: number | null; progress: number | null; graduated: number; frozen: number;
  price_sats: number | null; pool_sats: number | null; mcap_sats: number | null; creator_share: number | null; top5_share: number | null; lp_locked: number | null; flags: string; score: number | null; grade: string | null; links: string | null; logo: string | null; updated_at: number;
}

export const listLaunches = async (db: D1Database, limit = 150): Promise<LaunchRow[]> =>
  (await db.prepare("SELECT * FROM launchpad_tokens ORDER BY created_at DESC LIMIT ?1").bind(limit).all<LaunchRow>()).results;
