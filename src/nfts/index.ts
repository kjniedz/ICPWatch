// NFT analytics, modest by design. The collection registry is Entrepot's public list (third party, labeled);
// every number comes from the collection canister's own EXT stats() query, read directly.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Env } from "../env";
import { getAgent, pool } from "../lib/ic";
import { now } from "../lib/format";
import { normalizeUrl } from "../meta";

export const REGISTRY_URL = "https://us-central1-entrepot-api.cloudfunctions.net/api/collections";
export const REGISTRY_SOURCE = "Entrepot collection registry (third party)";
const STATS_PER_RUN = 400;

const extIdl: IDL.InterfaceFactory = ({ IDL }) => IDL.Service({ stats: IDL.Func([], [IDL.Nat64, IDL.Nat64, IDL.Nat64, IDL.Nat64, IDL.Nat, IDL.Nat, IDL.Nat], ["query"]) });

interface Reg { id: string; name: string; standard?: string; web?: string; twitter?: string; discord?: string; telegram?: string; avatar?: string; market?: boolean; unit?: string }

export interface NftStats { registry: number; statsRead: number; errors: number }

export async function collectNfts(env: Env): Promise<NftStats> {
  const db = env.DB;
  const ts = now();
  const stats: NftStats = { registry: 0, statsRead: 0, errors: 0 };
  const res = await fetch(REGISTRY_URL, { headers: { accept: "application/json", "user-agent": "ICPWatch/1.0" } });
  if (!res.ok) throw new Error(`registry ${res.status}`);
  const reg = ((await res.json()) as Reg[]).filter((r) => /^[a-z0-9-]{27}$/.test(r.id));
  stats.registry = reg.length;
  const up = db.prepare("INSERT INTO nft_collections (id, name, standard, registry, links, avatar, first_seen, updated_at) VALUES (?1, ?2, ?3, 'entrepot', ?4, ?5, ?6, ?6) ON CONFLICT (id) DO UPDATE SET name = excluded.name, standard = excluded.standard, links = excluded.links, avatar = excluded.avatar, updated_at = excluded.updated_at");
  const writes = reg.map((r) => up.bind(r.id, r.name.slice(0, 120), r.standard ?? null, JSON.stringify({ web: r.web ? normalizeUrl(r.web) : null, twitter: r.twitter ? normalizeUrl(r.twitter) : null, discord: r.discord ? normalizeUrl(r.discord) : null, telegram: r.telegram ? normalizeUrl(r.telegram) : null }), r.avatar?.startsWith("http") ? r.avatar.slice(0, 300) : null, ts));
  for (let i = 0; i < writes.length; i += 80) await db.batch(writes.slice(i, i + 80));

  // Stats: oldest first, a slice per run so the whole registry refreshes every couple of nights.
  const due = (await db.prepare("SELECT id FROM nft_collections ORDER BY stats_at ASC NULLS FIRST LIMIT ?1").bind(STATS_PER_RUN).all<{ id: string }>()).results;
  const agent = await getAgent(env.IC_HOST);
  const sup = db.prepare("UPDATE nft_collections SET volume_icp = ?2, high_icp = ?3, low_icp = ?4, floor_icp = ?5, listings = ?6, supply = ?7, trades = ?8, stats_at = ?9, stats_error = NULL WHERE id = ?1");
  const bad = db.prepare("UPDATE nft_collections SET stats_at = ?2, stats_error = ?3 WHERE id = ?1");
  const sw: D1PreparedStatement[] = [];
  await pool(due, 6, async (c) => {
    try {
      const a = Actor.createActor(extIdl, { agent, canisterId: c.id });
      const [vol, high, low, floor, listings, supply, trades] = (await a.stats!()) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
      sw.push(sup.bind(c.id, Number(vol) / 1e8, Number(high) / 1e8, Number(low) / 1e8, Number(floor) / 1e8, Number(listings), Number(supply), Number(trades), ts));
      stats.statsRead++;
    } catch (e) {
      sw.push(bad.bind(c.id, ts, String(e instanceof Error ? e.message : e).slice(0, 120)));
      stats.errors++;
    }
  });
  for (let i = 0; i < sw.length; i += 80) await db.batch(sw.slice(i, i + 80));
  return stats;
}

export interface NftRow { id: string; name: string; standard: string | null; links: string | null; avatar: string | null; volume_icp: number | null; high_icp: number | null; floor_icp: number | null; listings: number | null; supply: number | null; trades: number | null; stats_at: number | null; stats_error: string | null; health: string | null }

export const listNfts = async (db: D1Database, limit = 200): Promise<NftRow[]> =>
  (await db.prepare("SELECT n.id, n.name, n.standard, n.links, n.avatar, n.volume_icp, n.high_icp, n.floor_icp, n.listings, n.supply, n.trades, n.stats_at, n.stats_error, c.health FROM nft_collections n LEFT JOIN canisters c ON c.id = n.id WHERE n.stats_at IS NOT NULL AND n.stats_error IS NULL ORDER BY n.volume_icp DESC LIMIT ?1").bind(limit).all<NftRow>()).results;
