// Token links and descriptions. Sources, strongest first:
//   icrc1_metadata   the ledger's own metadata entries (on chain, anyone can re-read them)
//   sns_metadata     what the DAO put in its governance metadata (on chain; arrives via the discovery
//                    collector, which writes tokens.url / tokens.description)
//   seed             our own registry for native and ck tokens (src/collectors/seed.ts)
//   coingecko        third party, isolated here, never published on its own
// Publishing rule: an on-chain or seed source is enough; otherwise two sources must agree. A link with
// only CoinGecko behind it waits in the review queue.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { SEED_TOKENS } from "../collectors/seed";
import type { Env } from "../env";
import { getAgent, pool } from "../lib/ic";
import { now } from "../lib/format";
import { DESCRIPTIONS } from "./descriptions";

export type LinkKind = "website" | "twitter" | "telegram" | "discord" | "github" | "docs" | "whitepaper" | "forum" | "other";
export const LINK_KINDS: LinkKind[] = ["website", "docs", "whitepaper", "github", "twitter", "telegram", "discord", "forum", "other"];
export const KIND_TEXT: Record<LinkKind, string> = { website: "Website", twitter: "X", telegram: "Telegram", discord: "Discord", github: "GitHub", docs: "Docs", whitepaper: "Whitepaper", forum: "Forum", other: "Link" };

const STRONG = new Set(["icrc1_metadata", "sns_metadata", "seed", "icpwatch", "verified_project"]);

export interface TokenLink { token_id: string; kind: LinkKind; url: string; sources: string[]; status: "published" | "pending" | "rejected"; note: string | null; updated_at: number }

/** https, lowercase host, no trailing slash, no tracking query. Null for anything that is not a web URL. */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !u.hostname.endsWith(".ic0.app") && !u.hostname.endsWith(".icp0.io")) return null;
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid)/.test(k)) u.searchParams.delete(k);
  let out = u.toString();
  if (out.endsWith("/") && u.pathname === "/") out = out.slice(0, -1);
  return out.length <= 500 ? out : null;
}

/** Which kind a URL is, from its host. */
export function classifyUrl(url: string): LinkKind {
  const h = new URL(url).hostname.replace(/^www\./, "");
  const p = new URL(url).pathname.toLowerCase();
  if (h === "twitter.com" || h === "x.com") return "twitter";
  if (h === "t.me" || h === "telegram.me") return "telegram";
  if (h === "discord.gg" || h === "discord.com") return "discord";
  if (h === "github.com" || h === "gitlab.com") return "github";
  if (h === "forum.dfinity.org") return "forum";
  if (/whitepaper|litepaper/.test(p) || p.endsWith(".pdf")) return "whitepaper";
  if (/^docs\.|\/docs\b|gitbook\.io$|\/documentation/.test(h + p)) return "docs";
  return "website";
}

// ---- sources ---------------------------------------------------------------------------------------------

const mdIdl: IDL.InterfaceFactory = () =>
  IDL.Service({ icrc1_metadata: IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Text, IDL.Variant({ Nat: IDL.Nat, Int: IDL.Int, Text: IDL.Text, Blob: IDL.Vec(IDL.Nat8) })))], ["query"]) });

/** Any metadata entry whose value is a URL, or whose key names a link. Projects use ad hoc keys, so we look at values. */
async function onchainLinks(host: string, ledger: string): Promise<{ url: string; key: string }[]> {
  const a = Actor.createActor(mdIdl, { agent: await getAgent(host), canisterId: ledger });
  const md = (await a.icrc1_metadata!()) as [string, { Text?: string }][];
  const out: { url: string; key: string }[] = [];
  for (const [k, v] of md) {
    if (k === "icrc1:logo" || !v.Text || v.Text.startsWith("data:")) continue;
    if (/^https?:\/\/\S+$/i.test(v.Text.trim()) || /url|website|site|twitter|telegram|discord|github|docs/i.test(k)) {
      const n = normalizeUrl(v.Text);
      if (n) out.push({ url: n, key: k });
    }
  }
  return out;
}

interface GeckoLinks { homepage?: string[]; blockchain_site?: string[]; official_forum_url?: string[]; chat_url?: string[]; twitter_screen_name?: string; telegram_channel_identifier?: string; repos_url?: { github?: string[] } }

/** CoinGecko by ledger id on the internet-computer platform. Returns null when unlisted, undefined when rate limited or down. */
async function geckoLinks(ledger: string, apiKey?: string): Promise<{ id: string; links: { url: string; kind: LinkKind }[] } | null | undefined> {
  // Workers share egress IPs, so the keyless free tier is usually already exhausted by someone else (429).
  // A demo key (COINGECKO_API_KEY secret) gets a quota of our own.
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "ICPWatch/1.0 (+https://icpwatch.com)" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/internet-computer/contract/${ledger}`, { headers });
  if (res.status === 404) return null;
  if (res.status === 429 || res.status >= 500) return undefined;
  if (!res.ok) throw new Error(`coingecko ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const d = (await res.json()) as { id?: string; links?: GeckoLinks };
  if (!d.id) return null;
  const l = d.links ?? {};
  const links: { url: string; kind: LinkKind }[] = [];
  const push = (raw: string | undefined, kind?: LinkKind) => { const n = raw ? normalizeUrl(raw) : null; if (n) links.push({ url: n, kind: kind ?? classifyUrl(n) }); };
  for (const u of l.homepage ?? []) push(u);
  for (const u of l.official_forum_url ?? []) push(u);
  for (const u of l.chat_url ?? []) push(u);
  for (const u of l.repos_url?.github ?? []) push(u, "github");
  if (l.twitter_screen_name) push(`https://x.com/${l.twitter_screen_name}`, "twitter");
  if (l.telegram_channel_identifier) push(`https://t.me/${l.telegram_channel_identifier}`, "telegram");
  return { id: d.id, links };
}

// ---- collector -------------------------------------------------------------------------------------------

export interface MetaStats { note?: string; tokens: number; onchain: number; onchainLinks: number; gecko: number; geckoLinks: number; published: number; pending: number; descriptions: number; errors: number }

const GECKO_PER_RUN = 12;         // free tier is about 30 calls a minute; we take a slice each hour
const ONCHAIN_EVERY = 7 * 86400;
const GECKO_EVERY = 14 * 86400;

export async function collectTokenMeta(env: Env): Promise<MetaStats> {
  const db = env.DB;
  const ts = now();
  const stats: MetaStats = { tokens: 0, onchain: 0, onchainLinks: 0, gecko: 0, geckoLinks: 0, published: 0, pending: 0, descriptions: 0, errors: 0 };
  const tokens = (await db.prepare("SELECT t.id, t.symbol, t.name, t.kind, t.url, t.description, t.sns_root, t.listed_via, s.onchain_at, s.gecko_at, s.gecko_id FROM tokens t LEFT JOIN token_meta_state s ON s.token_id = t.id WHERE t.hidden = 0 ORDER BY s.gecko_at ASC NULLS FIRST")
    .all<{ id: string; symbol: string; name: string; kind: string; url: string | null; description: string | null; sns_root: string | null; listed_via: string; onchain_at: number | null; gecko_at: number | null; gecko_id: string | null }>()).results;
  stats.tokens = tokens.length;

  // Candidate links per token: url -> { kind, sources }.
  const cands = new Map<string, Map<string, { kind: LinkKind; sources: Set<string> }>>();
  const add = (token: string, url: string, source: string, kind?: LinkKind) => {
    const m = cands.get(token) ?? new Map();
    const e = m.get(url) ?? { kind: kind ?? classifyUrl(url), sources: new Set<string>() };
    e.sources.add(source);
    m.set(url, e);
    cands.set(token, m);
  };

  // 1. What discovery already wrote: the DAO's own metadata url, or our seed url.
  const seedUrl = new Map(SEED_TOKENS.filter((s) => s.url).map((s) => [s.ledger, s.url!]));
  for (const t of tokens) {
    const n = t.url ? normalizeUrl(t.url) : null;
    if (n) add(t.id, n, t.kind === "sns" ? "sns_metadata" : seedUrl.has(t.id) ? "seed" : "listing");
    const s = seedUrl.get(t.id);
    const sn = s ? normalizeUrl(s) : null;
    if (sn) add(t.id, sn, "seed");
  }

  // 2. On-chain metadata entries, a slice per run.
  const dueOnchain = tokens.filter((t) => !t.onchain_at || ts - t.onchain_at > ONCHAIN_EVERY).slice(0, 60);
  const stateUp = db.prepare("INSERT INTO token_meta_state (token_id, onchain_at, gecko_at, gecko_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (token_id) DO UPDATE SET onchain_at = COALESCE(excluded.onchain_at, onchain_at), gecko_at = COALESCE(excluded.gecko_at, gecko_at), gecko_id = COALESCE(excluded.gecko_id, gecko_id), updated_at = excluded.updated_at");
  const stateWrites: D1PreparedStatement[] = [];
  await pool(dueOnchain, 6, async (t) => {
    try {
      const links = await onchainLinks(env.IC_HOST, t.id);
      for (const l of links) add(t.id, l.url, "icrc1_metadata");
      stats.onchain++; stats.onchainLinks += links.length;
    } catch { stats.errors++; }
    stateWrites.push(stateUp.bind(t.id, ts, null, null, ts));
  });

  // 3. CoinGecko, a small slice per run, oldest first. Unlisted tokens are remembered so they are not asked again for two weeks.
  const dueGecko = tokens.filter((t) => !t.gecko_at || ts - t.gecko_at > GECKO_EVERY).slice(0, GECKO_PER_RUN);
  for (const t of dueGecko) {
    try {
      const g = await geckoLinks(t.id, env.COINGECKO_API_KEY);
      if (g === undefined) { stats.errors++; stats.note = env.COINGECKO_API_KEY ? "coingecko rate limited" : "coingecko rate limited (no COINGECKO_API_KEY set, shared Workers egress)"; break; }
      stats.gecko++;
      if (g) { for (const l of g.links) add(t.id, l.url, "coingecko", l.kind); stats.geckoLinks += g.links.length; }
      stateWrites.push(stateUp.bind(t.id, null, ts, g?.id ?? "-", ts));
    } catch (e) { stats.errors++; stats.note = `coingecko: ${e instanceof Error ? e.message : String(e)}`; }
  }

  // 4. Merge into token_links. Existing sources are kept; status only ever moves up automatically (pending -> published), never past a human rejection.
  const existing = new Map<string, TokenLink>();
  for (const r of (await db.prepare("SELECT token_id, kind, url, sources, status, note, updated_at FROM token_links").all<{ token_id: string; kind: LinkKind; url: string; sources: string; status: TokenLink["status"]; note: string | null; updated_at: number }>()).results) {
    existing.set(`${r.token_id}|${r.url}`, { ...r, sources: JSON.parse(r.sources) as string[] });
  }
  const up = db.prepare("INSERT INTO token_links (token_id, kind, url, sources, status, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6) ON CONFLICT (token_id, kind, url) DO UPDATE SET sources = excluded.sources, status = CASE WHEN token_links.status = 'rejected' THEN 'rejected' WHEN excluded.status = 'published' THEN 'published' ELSE token_links.status END, updated_at = excluded.updated_at");
  const writes: D1PreparedStatement[] = [...stateWrites];
  for (const [token, m] of cands) {
    for (const [url, e] of m) {
      const prev = existing.get(`${token}|${url}`);
      const sources = new Set([...(prev?.sources ?? []), ...e.sources]);
      const strong = [...sources].some((s) => STRONG.has(s));
      const status: TokenLink["status"] = prev?.status === "rejected" ? "rejected" : strong || sources.size >= 2 ? "published" : "pending";
      if (prev && prev.status === status && prev.sources.length === sources.size) continue;
      writes.push(up.bind(token, prev?.kind ?? e.kind, url, JSON.stringify([...sources]), status, ts));
      if (status === "published") stats.published++; else if (status === "pending") stats.pending++;
    }
  }

  // 5. Descriptions: our own text wins; otherwise a factual line from what we know.
  const descUp = db.prepare("INSERT INTO token_descriptions (token_id, text, source, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (token_id) DO UPDATE SET text = excluded.text, source = excluded.source, updated_at = excluded.updated_at WHERE token_descriptions.source != 'icpwatch' OR excluded.source = 'icpwatch'");
  for (const t of tokens) {
    const own = DESCRIPTIONS[t.id] ?? DESCRIPTIONS[t.symbol.toUpperCase()];
    const text = own ?? factsLine(t);
    if (text) { writes.push(descUp.bind(t.id, text, own ? "icpwatch" : "facts", ts)); stats.descriptions++; }
  }
  for (let i = 0; i < writes.length; i += 80) await db.batch(writes.slice(i, i + 80));
  return stats;
}

/** One neutral sentence from facts we hold, for tokens we have not written about. */
function factsLine(t: { symbol: string; name: string; kind: string; sns_root: string | null; listed_via: string }): string | null {
  if (t.kind === "sns") return `${t.name} (${t.symbol}) is the governance token of an SNS DAO on the Internet Computer. Its ledger is controlled by the DAO's root canister, so supply changes only through proposals.`;
  if (t.kind === "ck") return `${t.symbol} is a Chain Fusion twin token minted one to one against reserves the NNS-controlled minter holds. Backing is checked continuously on the reserves page.`;
  if (t.kind === "community") return `${t.name} (${t.symbol}) is an ICRC-1 token on the Internet Computer listed from ${t.listed_via.startsWith("dex:") ? `${t.listed_via.slice(4)} liquidity` : "our registry"}. Check who controls the ledger before trusting the supply.`;
  return null;
}

// ---- reads and review ------------------------------------------------------------------------------------

export async function linksFor(db: D1Database, tokenId: string): Promise<TokenLink[]> {
  const r = await db.prepare("SELECT token_id, kind, url, sources, status, note, updated_at FROM token_links WHERE token_id = ?1 AND status = 'published' ORDER BY updated_at").bind(tokenId)
    .all<{ token_id: string; kind: LinkKind; url: string; sources: string; status: TokenLink["status"]; note: string | null; updated_at: number }>();
  const out = r.results.map((x) => ({ ...x, sources: JSON.parse(x.sources) as string[] }));
  return out.sort((a, b) => LINK_KINDS.indexOf(a.kind) - LINK_KINDS.indexOf(b.kind));
}

export async function descriptionFor(db: D1Database, tokenId: string): Promise<{ text: string; source: string; updated_at: number } | null> {
  return db.prepare("SELECT text, source, updated_at FROM token_descriptions WHERE token_id = ?1").bind(tokenId).first();
}

export async function pendingLinks(db: D1Database, status = "pending"): Promise<(TokenLink & { symbol: string; name: string })[]> {
  const r = await db.prepare("SELECT l.token_id, l.kind, l.url, l.sources, l.status, l.note, l.updated_at, t.symbol, t.name FROM token_links l JOIN tokens t ON t.id = l.token_id WHERE l.status = ?1 ORDER BY t.symbol, l.kind LIMIT 500").bind(status)
    .all<{ token_id: string; kind: LinkKind; url: string; sources: string; status: TokenLink["status"]; note: string | null; updated_at: number; symbol: string; name: string }>();
  return r.results.map((x) => ({ ...x, sources: JSON.parse(x.sources) as string[] }));
}

export async function reviewLink(db: D1Database, tokenId: string, url: string, approve: boolean, note?: string, kind?: LinkKind): Promise<{ ok: boolean }> {
  const r = await db.prepare("UPDATE token_links SET status = ?3, note = ?4, kind = COALESCE(?5, kind), updated_at = ?6 WHERE token_id = ?1 AND url = ?2").bind(tokenId, url, approve ? "published" : "rejected", note ?? null, kind ?? null, now()).run();
  return { ok: (r.meta.changes ?? 0) > 0 };
}

/** Public submission: lands in the queue as its own source, so it never publishes on its own. */
export async function submitLink(db: D1Database, tokenId: string, rawUrl: string, note: string | undefined, contact: string | undefined): Promise<{ ok: boolean; message: string }> {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, message: "That does not look like a web address." };
  const t = await db.prepare("SELECT id FROM tokens WHERE id = ?1").bind(tokenId).first();
  if (!t) return { ok: false, message: "Unknown token." };
  const ts = now();
  const id = `submission:${ts.toString(36)}`;
  await db.prepare("INSERT INTO token_links (token_id, kind, url, sources, status, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6) ON CONFLICT (token_id, kind, url) DO UPDATE SET sources = json_insert(token_links.sources, '$[#]', ?7), note = COALESCE(excluded.note, token_links.note), updated_at = excluded.updated_at")
    .bind(tokenId, classifyUrl(url), url, JSON.stringify([id]), [note, contact ? `contact: ${contact}` : ""].filter(Boolean).join(" | ") || null, ts, id).run();
  return { ok: true, message: "Thanks. Links go live after a reviewer checks them against a second source." };
}
