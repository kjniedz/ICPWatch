// Label storage: id normalization, the confidence precedence rule, and idempotent upserts.
// Pure helpers first (unit tested), D1 writes at the bottom.
import { parseIcrcAccount, encodeIcrcAccount } from "../lib/account";
import type { EntityLabel, LabelCategory, LabelConfidence } from "./index";

export type LabelOrigin = "seed" | "derived" | "flow" | "community";

/** A label as written by the collectors. `owner` is the principal an account id was derived from, when known. */
export interface LabelRow {
  id: string; name: string; category: LabelCategory; confidence: LabelConfidence; source: string;
  token_id: string | null; url: string | null; owner: string | null; origin: LabelOrigin;
}

export const CATEGORIES: LabelCategory[] = [
  "sns_governance", "sns_treasury", "sns_swap", "sns_root", "ledger", "index", "archive", "minter", "dex_pool", "dex",
  "exchange", "known_neuron", "nns", "foundation", "team", "bridge", "burn", "other",
];

export const CATEGORY_TEXT: Record<LabelCategory, string> = {
  sns_governance: "SNS governance", sns_treasury: "SNS treasuries", sns_swap: "SNS swaps", sns_root: "SNS roots", ledger: "Ledgers", index: "Index canisters",
  archive: "Archives", minter: "Minters and fee collectors", dex_pool: "DEX pools", dex: "DEXs", exchange: "Exchanges", known_neuron: "Known neurons",
  nns: "NNS and system canisters", foundation: "Foundations", team: "Teams", bridge: "Bridges", burn: "Burn and blackhole", other: "Other",
};

const RANK: Record<LabelConfidence, number> = { verified: 3, community: 2, inferred: 1 };
export const confidenceRank = (c: LabelConfidence | string): number => RANK[c as LabelConfidence] ?? 0;

/** The precedence rule: an incoming label replaces a stored one only when it is at least as strong. */
export function mayReplace(existing: { confidence: string } | null | undefined, incoming: { confidence: string }): boolean {
  return !existing || confidenceRank(incoming.confidence) >= confidenceRank(existing.confidence);
}

/**
 * Canonical form of a label id, or null when the text is none of the accepted shapes.
 *   64 hex            lower case (the CRC is NOT required here: lookups must tolerate whatever a ledger row holds)
 *   neuron:<digits>   as is
 *   ICRC-1 text       canonical encoding (principal lower case, subaccount hex without leading zeros, checksum verified)
 */
export function normalizeId(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || s.length > 160) return null;
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (/^neuron:\d{1,20}$/.test(s)) return s;
  const acc = parseIcrcAccount(s);
  if (!acc) return null;
  try { return encodeIcrcAccount(acc.owner, acc.subaccount); } catch { return null; }
}

/** The owner principal of an ICRC-1 account text that carries a subaccount. Null for everything else. */
export function ownerOfSubaccount(id: string): string | null {
  if (!id.includes(".")) return null;
  return parseIcrcAccount(id)?.owner ?? null;
}

/** Text for names and sources: no em dashes, no control characters, single spaces, bounded length. */
export function cleanText(s: string | null | undefined, max = 120): string {
  return (s ?? "").replace(new RegExp(String.fromCharCode(0x2014), "g"), " - ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const same = (a: StoredShape, b: LabelRow) =>
  a.name === b.name && a.category === b.category && a.confidence === b.confidence && a.source === b.source && (a.token_id ?? null) === b.token_id && (a.url ?? null) === b.url && (a.owner ?? null) === b.owner;

interface StoredShape { id: string; name: string; category: string; confidence: string; source: string; token_id: string | null; url: string | null; owner: string | null }

export interface UpsertPlan { write: LabelRow[]; unchanged: number; blocked: number }

/**
 * Pure: which rows actually need a write. Unchanged rows are skipped (an hourly run over a few thousand labels
 * should cost a handful of row writes, not thousands), and rows that would weaken a stronger label are blocked.
 * When the same id appears twice in `incoming`, the first one wins: callers order by specificity.
 */
export function planUpsert(existing: Map<string, StoredShape>, incoming: LabelRow[]): UpsertPlan {
  const plan: UpsertPlan = { write: [], unchanged: 0, blocked: 0 };
  const seen = new Set<string>();
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const cur = existing.get(row.id);
    if (cur && !mayReplace(cur, row)) { plan.blocked++; continue; }
    if (cur && same(cur, row)) { plan.unchanged++; continue; }
    plan.write.push(row);
  }
  return plan;
}

// ---- D1 ---------------------------------------------------------------------------------------------------------------

const RANK_SQL = (col: string) => `(CASE ${col} WHEN 'verified' THEN 3 WHEN 'community' THEN 2 ELSE 1 END)`;

/** The precedence rule again, inside the statement, so a concurrent writer cannot sneak a weaker label in. */
export const UPSERT_SQL = `INSERT INTO labels (id, name, category, confidence, source, token_id, url, owner, origin, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name, category = excluded.category, confidence = excluded.confidence, source = excluded.source,
    token_id = excluded.token_id, url = excluded.url, owner = excluded.owner, origin = excluded.origin, updated_at = excluded.updated_at
  WHERE ${RANK_SQL("excluded.confidence")} >= ${RANK_SQL("labels.confidence")}`;

export async function batchAll(db: D1Database, stmts: D1PreparedStatement[], size = 50): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

export interface UpsertStats { written: number; unchanged: number; blocked: number }

/** Idempotent bulk upsert. Reads the stored labels once, then writes only what changed. */
export async function upsertLabels(db: D1Database, rows: LabelRow[], ts: number): Promise<UpsertStats> {
  if (!rows.length) return { written: 0, unchanged: 0, blocked: 0 };
  const stored = (await db.prepare("SELECT id, name, category, confidence, source, token_id, url, owner FROM labels").all<StoredShape>()).results;
  const plan = planUpsert(new Map(stored.map((r) => [r.id, r])), rows);
  const up = db.prepare(UPSERT_SQL);
  await batchAll(db, plan.write.map((r) => up.bind(r.id, r.name, r.category, r.confidence, r.source, r.token_id, r.url, r.owner, r.origin, ts)));
  return { written: plan.write.length, unchanged: plan.unchanged, blocked: plan.blocked };
}
