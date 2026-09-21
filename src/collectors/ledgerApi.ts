// Third-party adapter: DFINITY's ICRC ledger API (icrc-api.internetcomputer.org).
// No canister can enumerate holders: neither the ledger nor index-ng exposes an account list, so the
// only trust-minimized route is replaying every block ourselves. Until that indexer exists, holders
// and the large-transfer feed come from here, are labeled as third-party, and are swappable: the rest
// of the code only sees the two functions below.
import type { Env } from "../env";
import { now } from "../lib/format";
import { pool } from "../lib/ic";

const API = "https://icrc-api.internetcomputer.org/api/v2";
export const LEDGER_API_SOURCE = "ICRC ledger API (third party, DFINITY)";

export interface Holder { account: string; balance: number; share: number | null }
export interface HoldersSnapshot { rows: Holder[]; total: number | null; top10: number | null; fetched_at: number; source: string }

export async function fetchHolders(ledgerId: string, decimals: number): Promise<HoldersSnapshot | null> {
  const res = await fetch(`${API}/ledgers/${ledgerId}/holders?sort_by=-balance&limit=25`);
  if (!res.ok) return null;
  const body = (await res.json()) as { data: { principal: string; balance: string; percentage: number | null }[] };
  const rows = body.data.map((h) => ({ account: h.principal, balance: Number(h.balance) / 10 ** decimals, share: h.percentage != null ? h.percentage / 100 : null }));
  const top10 = rows.slice(0, 10).reduce((s, r) => s + (r.share ?? 0), 0);
  return { rows, total: null, top10: rows.length ? top10 : null, fetched_at: now(), source: LEDGER_API_SOURCE };
}

/** Holders for one token, cached for a day in the kv table. */
export async function holdersCached(env: Env, ledgerId: string, decimals: number): Promise<HoldersSnapshot | null> {
  const key = `holders:${ledgerId}`;
  const row = await env.DB.prepare("SELECT value, fetched_at FROM kv WHERE key = ?").bind(key).first<{ value: string; fetched_at: number }>();
  if (row && now() - row.fetched_at < 86400) {
    try { return JSON.parse(row.value) as HoldersSnapshot; } catch { /* refetch */ }
  }
  const fresh = await fetchHolders(ledgerId, decimals).catch(() => null);
  if (!fresh) return row ? (JSON.parse(row.value) as HoldersSnapshot) : null;
  await env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES (?, ?, ?, ?)").bind(key, JSON.stringify(fresh), LEDGER_API_SOURCE, fresh.fetched_at).run();
  return fresh;
}

export interface WhaleTransfer { token_id: string; symbol: string; index: number; amount: number; usd: number; from: string; to: string; ts: number }

/** Largest transfers of the last 24h across the biggest tokens. Runs hourly. */
export async function collectWhales(env: Env): Promise<number> {
  const ts = now();
  const tokens = (
    await env.DB.prepare("SELECT t.id, t.symbol, t.decimals, m.price_usd FROM tokens t JOIN market m ON m.token_id = t.id WHERE t.kind != 'native' AND m.price_usd > 0 ORDER BY m.tvl_usd DESC LIMIT 25").all<{ id: string; symbol: string; decimals: number; price_usd: number }>()
  ).results;
  const out: WhaleTransfer[] = [];
  const results = await pool(tokens, 4, async (t) => {
    const res = await fetch(`${API}/ledgers/${t.id}/transactions?sort_by=-amount&include_kind=transfer&start=${ts - 86400}&limit=10`);
    if (!res.ok) return [];
    const body = (await res.json()) as { data: { index: number; amount: string; from_account: string; to_account: string; timestamp: string }[] };
    return body.data.map((x) => {
      const amount = Number(x.amount) / 10 ** t.decimals;
      return { token_id: t.id, symbol: t.symbol, index: x.index, amount, usd: amount * t.price_usd, from: x.from_account, to: x.to_account, ts: Math.floor(Number(x.timestamp) / 1e9) };
    });
  });
  for (const r of results) if (r.status === "fulfilled") out.push(...r.value);
  const top = out.filter((w) => w.usd >= 5000).sort((a, b) => b.usd - a.usd).slice(0, 60);
  await env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES ('markets:whales', ?, ?, ?)").bind(JSON.stringify(top), LEDGER_API_SOURCE, ts).run();
  return top.length;
}
