// Transaction export for tax tools. Rows come straight from the ledgers' own index canisters (ICP index,
// ICRC index-ng), priced at ICPWatch's hourly candle. It is a faithful list of transfers, not tax advice.
import { icpTransactions, icrcTransactions, type AccountTx } from "../collectors/accounts";
import type { Env } from "../env";
import { accountHoldings } from "../indexer/queries";
import { classifyInput, fromHex } from "../lib/account";
import { ICP_LEDGER, ICP_INDEX } from "../lib/ic";
import { now } from "../lib/format";

export type Format = "koinly" | "cointracker";
const MAX_PER_LEDGER = 2000;

interface Row { ts: number; symbol: string; ledger: string; tx: AccountTx; usd: number | null }

async function priceAt(db: D1Database, cache: Map<string, Promise<number | null>>, ledger: string, ts: number): Promise<number | null> {
  const hour = ts - (ts % 3600);
  const key = `${ledger}:${hour}`;
  if (!cache.has(key)) cache.set(key, db.prepare("SELECT price_usd FROM prices WHERE token_id = ?1 AND res IN ('hour','day') AND ts <= ?2 AND ts >= ?3 ORDER BY ts DESC LIMIT 1").bind(ledger, hour + 3600, hour - 2 * 86400).first<{ price_usd: number }>().then((r) => r?.price_usd ?? null));
  return cache.get(key)!;
}

async function walkIcp(env: Env, accountId: string, from: number, to: number): Promise<AccountTx[]> {
  const out: AccountTx[] = [];
  let start: bigint | null = null;
  for (let i = 0; i < MAX_PER_LEDGER / 100; i++) {
    const page = await icpTransactions(env.IC_HOST, accountId, start, 100);
    for (const t of page.txs) if (t.ts != null && t.ts >= from && t.ts < to) out.push(t);
    const oldest = page.txs[page.txs.length - 1]?.ts ?? 0;
    if (!page.nextStart || oldest < from) break;
    start = BigInt(page.nextStart);
  }
  return out;
}

async function walkIcrc(env: Env, indexId: string, owner: string, subaccount: Uint8Array | null, decimals: number, from: number, to: number): Promise<AccountTx[]> {
  const out: AccountTx[] = [];
  let start: bigint | null = null;
  for (let i = 0; i < MAX_PER_LEDGER / 100; i++) {
    const page = await icrcTransactions(env.IC_HOST, indexId, owner, subaccount, decimals, start, 100);
    for (const t of page.txs) if (t.ts != null && t.ts >= from && t.ts < to) out.push(t);
    const oldest = page.txs[page.txs.length - 1]?.ts ?? 0;
    if (!page.nextStart || oldest < from) break;
    start = BigInt(page.nextStart);
  }
  return out;
}

export interface ExportResult { csv: string; rows: number; ledgers: number; skipped: string[]; from: number; to: number }

export async function exportAccount(env: Env, input: string, opts: { format: Format; year?: number }): Promise<ExportResult | { error: string }> {
  const db = env.DB;
  const c = classifyInput(input);
  if (c.kind === "other" || c.kind === "hex64") return { error: "Not an account, principal, or ICRC account." };
  const year = opts.year ?? new Date().getUTCFullYear();
  const from = Math.floor(Date.UTC(year, 0, 1) / 1000), to = Math.min(now() + 1, Math.floor(Date.UTC(year + 1, 0, 1) / 1000));
  const rows: Row[] = [];
  const skipped: string[] = [];
  let ledgers = 0;

  // ICP, always: by account identifier.
  try { for (const tx of await walkIcp(env, c.accountId, from, to)) rows.push({ ts: tx.ts!, symbol: "ICP", ledger: ICP_LEDGER, tx, usd: null }); ledgers++; } catch { skipped.push("ICP"); }

  // Every ICRC ledger where our index has seen this owner, through that ledger's index canister.
  if (c.kind !== "account_id") {
    const owner = c.principal;
    const sub = c.kind === "icrc_account" ? fromHex(c.subaccount) : null;
    const held = await accountHoldings(db, owner, { includeEmpty: true, limit: 200 });
    const indexes = new Map((await db.prepare("SELECT token_id, id FROM canisters WHERE role = 'index' AND token_id IS NOT NULL").all<{ token_id: string; id: string }>()).results.map((r) => [r.token_id, r.id]));
    const decimals = new Map((await db.prepare("SELECT id, decimals, symbol FROM tokens").all<{ id: string; decimals: number; symbol: string }>()).results.map((r) => [r.id, r]));
    for (const h of held) {
      if (h.ledger === ICP_LEDGER) continue;
      const idx = indexes.get(h.ledger), t = decimals.get(h.ledger);
      if (!idx || !t) { skipped.push(h.symbol ?? h.ledger); continue; }
      try { for (const tx of await walkIcrc(env, idx, owner, sub, t.decimals, from, to)) rows.push({ ts: tx.ts!, symbol: t.symbol, ledger: h.ledger, tx, usd: null }); ledgers++; } catch { skipped.push(t.symbol); }
      if (rows.length > 20000) break;
    }
  }
  const cache = new Map<string, Promise<number | null>>();
  for (const r of rows) { const px = await priceAt(db, cache, r.ledger, r.ts); r.usd = px != null && r.tx.amount != null ? px * r.tx.amount : null; }
  rows.sort((a, b) => a.ts - b.ts);
  return { csv: render(rows, opts.format, c.kind === "account_id" ? c.accountId : c.principal), rows: rows.length, ledgers, skipped, from, to };
}

const q = (s: string | number | null | undefined) => (s == null || s === "" ? "" : /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
const iso = (ts: number) => new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const fix = (n: number | null | undefined) => (n == null ? "" : n.toFixed(8).replace(/\.?0+$/, ""));

function render(rows: Row[], format: Format, me: string): string {
  const lines: string[] = [];
  if (format === "koinly") {
    lines.push("Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash");
    for (const r of rows) {
      const t = r.tx;
      const out = t.direction === "out", inn = t.direction === "in";
      const label = t.kind === "mint" ? "" : t.kind === "burn" ? "" : t.direction === "self" ? "ignored" : "";
      const desc = `${t.kind}${t.counterparty ? ` ${out ? "to" : "from"} ${t.counterparty_label ?? t.counterparty}` : ""}${t.memo ? ` memo ${t.memo}` : ""}`;
      lines.push([iso(r.ts), out ? fix(t.amount) : "", out ? r.symbol : "", inn ? fix(t.amount) : "", inn ? r.symbol : "", out && t.fee ? fix(t.fee) : "", out && t.fee ? r.symbol : "", r.usd != null ? r.usd.toFixed(2) : "", r.usd != null ? "USD" : "", label, desc, `${r.ledger}:${t.id}`].map(q).join(","));
    }
  } else {
    lines.push("Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag");
    for (const r of rows) {
      const t = r.tx;
      const out = t.direction === "out", inn = t.direction === "in";
      const tag = t.kind === "mint" ? "mined" : t.kind === "burn" ? "lost" : "";
      lines.push([new Date(r.ts * 1000).toLocaleString("en-US", { timeZone: "UTC", hour12: false }).replace(",", ""), inn ? fix(t.amount) : "", inn ? r.symbol : "", out ? fix(t.amount) : "", out ? r.symbol : "", out && t.fee ? fix(t.fee) : "", out && t.fee ? r.symbol : "", tag].map(q).join(","));
    }
  }
  return `# ICPWatch export for ${me}, generated ${iso(now())}, ${format} format. Rows are ledger transfers as recorded by the ledgers' own index canisters; USD at ICPWatch hourly prices. Not tax advice.\n${lines.join("\n")}\n`;
}
