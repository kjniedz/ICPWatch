// Entity labels: the public read API. D1 reads only in this file, no IC calls.
//
// A label names whoever is behind a principal, an ICRC-1 account, or an ICP account identifier.
// Every label carries a confidence and a human readable source, and the UI renders the three
// confidences differently (see EntityName in src/pages/labels.tsx):
//   verified   derived from on-chain facts that anyone can re-check
//   inferred   third-party attribution or a flow heuristic
//   community  submitted by a user, approved by a reviewer
// How labels are produced is documented in docs/LABELS.md.
import { CATEGORIES, normalizeId, ownerOfSubaccount } from "./store";

export type LabelConfidence = "verified" | "inferred" | "community";
export type LabelCategory = "sns_governance" | "sns_treasury" | "sns_swap" | "sns_root" | "ledger" | "index" | "archive" | "minter" | "dex_pool" | "dex" | "exchange" | "known_neuron" | "nns" | "foundation" | "team" | "bridge" | "burn" | "other";

export interface EntityLabel {
  /** Principal text, ICRC account text, or 64 hex ICP account id. Known neurons use "neuron:<id>". */
  id: string;
  name: string;
  category: LabelCategory;
  confidence: LabelConfidence;
  /** Human readable evidence, e.g. "SNS root list_sns_canisters". */
  source: string;
  token_id: string | null;
  url: string | null;
  updated_at: number;
}

const COLS = "id, name, category, confidence, source, token_id, url, updated_at";
/** D1 allows 100 bound parameters per statement. */
const CHUNK = 90;
export const SUBACCOUNT_SUFFIX = " (subaccount)";

const chunks = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function fetchExact(db: D1Database, ids: string[]): Promise<Map<string, EntityLabel>> {
  const found = new Map<string, EntityLabel>();
  if (!ids.length) return found;
  const stmts = chunks(ids, CHUNK).map((c) => db.prepare(`SELECT ${COLS} FROM labels WHERE id IN (${c.map(() => "?").join(",")})`).bind(...c));
  // One round trip for every chunk.
  const res = stmts.length === 1 ? [await stmts[0]!.all<EntityLabel>()] : await db.batch<EntityLabel>(stmts);
  for (const r of res) for (const row of r.results) found.set(row.id, row);
  return found;
}

/**
 * Batch lookup. Accepts principals, ICRC-1 account texts, and 64 hex ICP account identifiers in any mix and any
 * letter case; anything else is ignored. The returned map is keyed by the ids exactly as they were passed in.
 *
 * An ICRC-1 account with a subaccount falls back to the label of its owner principal only when the account itself
 * has no label, and the returned name then ends in " (subaccount)" so nobody mistakes it for the labeled account.
 * Example: a neuron's staking subaccount of the OpenChat governance canister reads "OpenChat Governance (subaccount)".
 * Account identifiers are one-way hashes, so they never fall back.
 */
export async function labelsFor(db: D1Database, ids: string[]): Promise<Map<string, EntityLabel>> {
  const out = new Map<string, EntityLabel>();
  const norm = new Map<string, string>(); // as passed -> canonical
  for (const raw of ids) {
    if (typeof raw !== "string" || norm.has(raw)) continue;
    const n = normalizeId(raw);
    if (n) norm.set(raw, n);
  }
  if (!norm.size) return out;
  const wanted = new Set(norm.values());
  const owners = new Map<string, string>(); // canonical subaccount id -> owner principal
  for (const id of wanted) {
    const o = ownerOfSubaccount(id);
    if (o) owners.set(id, o);
  }
  // Owners are fetched in the same query, so the fallback costs no second round trip.
  const found = await fetchExact(db, [...new Set([...wanted, ...owners.values()])]);
  for (const [raw, id] of norm) {
    const exact = found.get(id);
    if (exact) { out.set(raw, exact); continue; }
    const owner = owners.get(id);
    const viaOwner = owner ? found.get(owner) : undefined;
    if (viaOwner) {
      out.set(raw, { ...viaOwner, id, name: `${viaOwner.name}${SUBACCOUNT_SUFFIX}`, source: `${viaOwner.source}. This subaccount has no label of its own: shown is the label of its owner principal.` });
    }
  }
  return out;
}

export async function labelFor(db: D1Database, id: string): Promise<EntityLabel | null> {
  return (await labelsFor(db, [id])).get(id) ?? null;
}

const PROTOCOL_HELD: ReadonlySet<LabelCategory> = new Set<LabelCategory>(["sns_treasury", "sns_governance", "sns_swap", "dex_pool", "dex", "minter", "burn"]);

/**
 * Holders that are protocol held rather than somebody's position: SNS treasuries, governance (neuron stakes and the
 * treasury live in its subaccounts), swaps, DEX pools and DEXs, minters, and burn addresses. The trust score leaves
 * these out of holder concentration.
 */
export function isTreasuryOrPool(l: EntityLabel | null | undefined): boolean {
  return !!l && PROTOCOL_HELD.has(l.category);
}

/** True when the label was inherited from the owner principal by labelsFor. */
export const isOwnerFallback = (l: EntityLabel | null | undefined): boolean => !!l && l.name.endsWith(SUBACCOUNT_SUFFIX);

/**
 * Label search for the global search box: every word has to appear in the name ("openchat treasury"), or the term is
 * the start of an id. Verified labels first. D1 rejects LIKE patterns over 50 bytes, so long terms match ids exactly.
 */
export async function searchLabels(db: D1Database, q: string, limit = 8): Promise<EntityLabel[]> {
  const term = q.trim().replace(/[%_\\]/g, "");
  if (term.length < 2) return [];
  const lim = Math.min(Math.max(limit, 1), 50);
  if (term.length > 40) {
    const id = normalizeId(term);
    if (!id) return [];
    const hit = (await labelsFor(db, [id])).get(id);
    return hit ? [hit] : [];
  }
  const words = term.split(/\s+/).filter(Boolean).slice(0, 4);
  const where = words.map((_, i) => `name LIKE ?${i + 1}`).join(" AND ");
  const idArg = words.length + 1;
  const sql = `SELECT ${COLS} FROM labels WHERE (${where}) OR id LIKE ?${idArg}
    ORDER BY (name = ?${idArg + 1} COLLATE NOCASE) DESC, (CASE confidence WHEN 'verified' THEN 0 WHEN 'community' THEN 1 ELSE 2 END), LENGTH(name), name LIMIT ?${idArg + 2}`;
  return (await db.prepare(sql).bind(...words.map((w) => `%${w}%`), `${term.toLowerCase()}%`, term, lim).all<EntityLabel>()).results;
}

export interface LabelDirectory { total: number; shown: number; counts: { category: LabelCategory; n: number }[]; groups: { category: LabelCategory; labels: EntityLabel[] }[] }

/** The public directory: every label, grouped by category, optionally filtered. Capped so one page stays renderable. */
export async function listLabels(db: D1Database, opts: { q?: string; category?: string; confidence?: string; limit?: number } = {}): Promise<LabelDirectory> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const q = (opts.q ?? "").trim().replace(/[%_\\]/g, "").slice(0, 40);
  for (const w of q.split(/\s+/).filter(Boolean).slice(0, 4)) { where.push(`(name LIKE ?${args.length + 1} OR id LIKE ?${args.length + 1} OR source LIKE ?${args.length + 1})`); args.push(`%${w}%`); }
  if (opts.category && (CATEGORIES as string[]).includes(opts.category)) { where.push(`category = ?${args.length + 1}`); args.push(opts.category); }
  if (opts.confidence && ["verified", "inferred", "community"].includes(opts.confidence)) { where.push(`confidence = ?${args.length + 1}`); args.push(opts.confidence); }
  const cond = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 600, 1), 2000);
  const [counts, rows] = await db.batch<Record<string, string | number | null>>([
    db.prepare(`SELECT category, COUNT(*) n FROM labels ${cond} GROUP BY category`).bind(...args),
    // Account identifiers derived from a labeled principal repeat its name, so the principal sorts first.
    db.prepare(`SELECT ${COLS} FROM labels ${cond} ORDER BY category, name COLLATE NOCASE, LENGTH(id) LIMIT ?${args.length + 1}`).bind(...args, limit),
  ]);
  const byCat = new Map<LabelCategory, EntityLabel[]>();
  for (const r of rows!.results as unknown as EntityLabel[]) {
    const list = byCat.get(r.category) ?? [];
    list.push(r);
    byCat.set(r.category, list);
  }
  const c = (counts!.results as unknown as { category: LabelCategory; n: number }[]).sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  return {
    total: c.reduce((s, x) => s + x.n, 0), shown: rows!.results.length, counts: c,
    groups: CATEGORIES.filter((k) => byCat.has(k)).map((k) => ({ category: k, labels: byCat.get(k)! })),
  };
}

export { CATEGORIES, CATEGORY_TEXT, normalizeId } from "./store";
export { collectLabels, type LabelRunStats } from "./collect";
export { submitLabel, listSubmissions, reviewSubmission, type LabelSubmission, type SubmitResult } from "./review";
