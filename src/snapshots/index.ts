// Holder snapshots from our own reconciled index. A snapshot is the ledger's balances as of the last
// applied block, filtered the way the requester asked, written as a canonical CSV whose SHA-256 is
// published with it. Anyone who downloads the file can hash it and match. Only trusted ledgers
// (complete and reconciled against icrc1_total_supply) can be snapshotted.
import type { Env } from "../env";
import { indexProgress } from "../indexer/queries";
import { CATEGORIES, type LabelCategory } from "../labels";
import { now } from "../lib/format";

export interface SnapshotFilters { min_balance: number; exclude: LabelCategory[]; top: number | null }

export interface SnapshotMeta {
  id: string; ledger: string; symbol: string; decimals: number; block: number; block_ts: number | null; supply_raw: string | null; taken_at: number;
  look_through: number; filters: string; rows: number; holders_total: number; sum_raw: string; hash: string; size_bytes: number; creator_note: string | null;
}

export const MAX_ROWS = 250_000;
const CHUNK_BYTES = 800_000;

export function parseFilters(form: Record<string, unknown>): SnapshotFilters {
  const min = Number(String(form.min_balance ?? "").replace(/[,\s]/g, ""));
  const exclude = ([] as string[]).concat((form.exclude as string | string[]) ?? []).filter((c): c is LabelCategory => (CATEGORIES as string[]).includes(c));
  const top = Number(form.top);
  return { min_balance: Number.isFinite(min) && min > 0 ? min : 0, exclude, top: Number.isFinite(top) && top > 0 ? Math.min(Math.floor(top), MAX_ROWS) : null };
}

const balanceTable = (kind: string) => (kind === "icp" ? "icp_balances" : "balances");
const ledgerWhere = (kind: string) => (kind === "icp" ? "?1 IS NOT NULL" : "ledger = ?1");

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  void w.write(new TextEncoder().encode(text));
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gunzip(data: ArrayBuffer): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  void w.write(new Uint8Array(data));
  void w.close();
  return new Response(ds.readable).text();
}

export type TakeResult = { ok: true; id: string; reused: boolean } | { ok: false; error: string };

/**
 * Take a snapshot now. Idempotent per (ledger, block, look-through, filters): asking twice at the same block
 * returns the earlier id, which is what makes the link permanent and the hash meaningful.
 */
export async function takeSnapshot(env: Env, ledger: string, opts: { lookThrough: boolean; filters: SnapshotFilters; note?: string; totalSupplyRaw?: string | null }): Promise<TakeResult> {
  const db = env.DB;
  const progress = await indexProgress(db, ledger);
  if (!progress?.trusted) return { ok: false, error: "This ledger's index is not complete and reconciled yet, so no snapshot can be certified." };
  const token = await db.prepare("SELECT symbol, total_supply FROM tokens WHERE id = ?1").bind(ledger).first<{ symbol: string; total_supply: string | null }>();
  if (!token) return { ok: false, error: "Unknown ledger." };
  const block = progress.nextBlock - 1;
  const filtersJson = JSON.stringify({ min_balance: opts.filters.min_balance, exclude: [...opts.filters.exclude].sort(), top: opts.filters.top });
  const lookThrough = opts.lookThrough && progress.kind !== "icp";
  const dup = await db.prepare("SELECT id FROM snapshots WHERE ledger = ?1 AND block = ?2 AND look_through = ?3 AND filters = ?4").bind(ledger, block, lookThrough ? 1 : 0, filtersJson).first<{ id: string }>();
  if (dup) return { ok: true, id: dup.id, reused: true };

  const kind = progress.kind, tbl = balanceTable(kind), where = ledgerWhere(kind);
  const scale = 10 ** progress.decimals;
  const minRaw = BigInt(Math.floor(opts.filters.min_balance * scale));

  // Exclusions: every labeled id in the excluded categories, matched on account and on owner.
  const excluded = new Set<string>();
  if (opts.filters.exclude.length) {
    const r = await db.prepare(`SELECT id FROM labels WHERE category IN (${opts.filters.exclude.map((_, i) => `?${i + 1}`).join(",")})`).bind(...opts.filters.exclude).all<{ id: string }>();
    for (const x of r.results) excluded.add(x.id);
  }
  // SNS look-through: stakes by controller, governance accounts dropped.
  let governance: string | null = null;
  const stakes = new Map<string, bigint>();
  if (lookThrough) {
    const kv = await db.prepare("SELECT value FROM kv WHERE key = ?1").bind(`sns:${ledger}`).first<{ value: string }>();
    try { governance = kv ? ((JSON.parse(kv.value) as { governance?: string }).governance ?? null) : null; } catch { governance = null; }
    if (governance) {
      const r = await db.prepare("SELECT controller, SUM(stake) staked FROM sns_neurons WHERE token_id = ?1 AND controller IS NOT NULL GROUP BY controller").bind(ledger).all<{ controller: string; staked: number }>();
      for (const x of r.results) stakes.set(x.controller, BigInt(Math.round(x.staked * scale)));
    }
  }

  // Walk the ledger by primary key in pages; the row cap keeps a very large ledger from eating the request.
  type Row = { account: string; owner: string | null; balance_raw: string };
  const rows = new Map<string, { owner: string; raw: bigint }>();
  let after = "";
  let scanned = 0;
  for (;;) {
    const page = (await db.prepare(`SELECT account, owner, balance_raw FROM ${tbl} WHERE ${where} AND balance > 0 AND account > ?2 ORDER BY account LIMIT 5000`).bind(ledger, after).all<Row>()).results;
    if (!page.length) break;
    scanned += page.length;
    for (const r of page) {
      const owner = r.owner ?? r.account;
      if (governance && owner === governance) continue;
      if (excluded.size && (excluded.has(r.account) || excluded.has(owner))) continue;
      let raw = BigInt(r.balance_raw);
      if (raw <= 0n) continue;
      const key = lookThrough ? r.account : r.account;
      const cur = rows.get(key);
      if (cur) cur.raw += raw; else rows.set(key, { owner, raw });
    }
    if (rows.size > MAX_ROWS) return { ok: false, error: `More than ${MAX_ROWS.toLocaleString("en-US")} accounts match. Add a minimum balance or a top-N cap.` };
    after = page[page.length - 1]!.account;
    if (page.length < 5000) break;
  }
  if (lookThrough) {
    for (const [controller, raw] of stakes) {
      if (excluded.size && excluded.has(controller)) continue;
      const cur = rows.get(controller);
      if (cur) cur.raw += raw; else rows.set(controller, { owner: controller, raw });
    }
  }
  let list = [...rows.entries()].map(([account, v]) => ({ account, owner: v.owner, raw: v.raw })).filter((r) => r.raw >= minRaw);
  list.sort((a, b) => (a.raw === b.raw ? (a.account < b.account ? -1 : 1) : a.raw > b.raw ? -1 : 1));
  if (opts.filters.top) list = list.slice(0, opts.filters.top);

  // Canonical CSV: fixed header, fixed column order, LF line endings, no quoting needed (ids and integers only).
  let sum = 0n;
  const lines = ["rank,account,owner,balance_raw,balance"];
  list.forEach((r, i) => { sum += r.raw; lines.push(`${i + 1},${r.account},${r.owner},${r.raw},${(Number(r.raw) / scale).toString()}`); });
  const csv = `${lines.join("\n")}\n`;
  const hash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv)));
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const ts = now();

  // Store as gzip chunks of the CSV text, each under D1's row size limit.
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT INTO snapshots (id, ledger, symbol, decimals, block, block_ts, supply_raw, taken_at, look_through, filters, rows, holders_total, sum_raw, hash, size_bytes, creator_note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)")
      .bind(id, ledger, token.symbol, progress.decimals, block, progress.asOfTs, opts.totalSupplyRaw ?? token.total_supply, ts, lookThrough ? 1 : 0, filtersJson, list.length, progress.holders, sum.toString(), hash, csv.length, opts.note?.slice(0, 200) ?? null),
  ];
  let seq = 0;
  for (let i = 0; i < csv.length; i += CHUNK_BYTES * 4) {
    // Chunk on text so each piece decompresses independently; compressed size is well under the cap.
    const piece = csv.slice(i, i + CHUNK_BYTES * 4);
    const gz = await gzip(piece);
    stmts.push(db.prepare("INSERT INTO snapshot_blobs (snapshot_id, seq, data) VALUES (?1, ?2, ?3)").bind(id, seq++, gz));
  }
  await db.batch(stmts);
  void scanned;
  return { ok: true, id, reused: false };
}

export async function getSnapshot(db: D1Database, id: string): Promise<SnapshotMeta | null> {
  return db.prepare("SELECT * FROM snapshots WHERE id = ?1").bind(id).first<SnapshotMeta>();
}

export async function snapshotCsv(db: D1Database, id: string): Promise<string | null> {
  const blobs = (await db.prepare("SELECT data FROM snapshot_blobs WHERE snapshot_id = ?1 ORDER BY seq").bind(id).all<{ data: ArrayBuffer }>()).results;
  if (!blobs.length) return null;
  const parts: string[] = [];
  for (const b of blobs) parts.push(await gunzip(b.data));
  return parts.join("");
}

export interface SnapshotRow { rank: number; account: string; owner: string; balance_raw: string; balance: number }

export function parseCsv(csv: string): SnapshotRow[] {
  const out: SnapshotRow[] = [];
  for (const line of csv.split("\n").slice(1)) {
    if (!line) continue;
    const [rank, account, owner, raw, bal] = line.split(",");
    out.push({ rank: Number(rank), account: account!, owner: owner!, balance_raw: raw!, balance: Number(bal) });
  }
  return out;
}

export const listSnapshots = async (db: D1Database, ledger?: string, limit = 30): Promise<SnapshotMeta[]> =>
  (await (ledger
    ? db.prepare("SELECT * FROM snapshots WHERE ledger = ?1 ORDER BY taken_at DESC LIMIT ?2").bind(ledger, limit)
    : db.prepare("SELECT * FROM snapshots ORDER BY taken_at DESC LIMIT ?1").bind(limit)).all<SnapshotMeta>()).results;
