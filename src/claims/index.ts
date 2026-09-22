// Claimed project profiles. A claim proves one of three things and nothing else:
//   controller_payment  an exact-amount ICP transfer from the default account of a current ledger controller
//   dao_motion          an adopted SNS motion carrying the claim code
//   domain              the claim code served from /.well-known/icpwatch-claim.txt on an on-chain-sourced website
// Verification unlocks a profile (name, tagline, links) shown with a badge. It never touches the trust score.
import { icpTransactions } from "../collectors/accounts";
import type { Env } from "../env";
import { accountIdHex } from "../lib/account";
import { readCanisterState } from "../lib/ic";
import { now } from "../lib/format";
import { classifyUrl, normalizeUrl, type LinkKind } from "../meta";

/** Receiving account for controller payments: the life-support identity's default account (receive only). */
export const CLAIM_PRINCIPAL = "olkpf-vf3az-y4tjb-io6lk-fujss-ahxus-a2odc-qchuj-7ufeb-2a3rq-oqe";
export const CLAIM_ACCOUNT = accountIdHex(CLAIM_PRINCIPAL);
const BASE_E8S = 100_000; // 0.001 ICP, plus a 5-digit code
const CLAIM_TTL = 14 * 86400;

export type Method = "controller_payment" | "dao_motion" | "domain";
export interface Claim {
  id: string; token_id: string; method: Method; code: string; subject: string | null; status: "pending" | "verified" | "rejected" | "expired"; evidence: string | null; contact: string | null;
  created_at: number; verified_at: number | null; checked_at: number | null;
}
export interface Profile { token_id: string; claim_id: string; display_name: string | null; tagline: string | null; links: { kind: LinkKind; url: string }[]; contact: string | null; updated_at: number }

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const rid = () => crypto.randomUUID().replace(/-/g, "");

/** Text code for motions and domains: short, unambiguous, prefixed so it is recognisable in a proposal. */
const textCode = () => `icpwatch-claim:${rid().slice(0, 10)}`;

export async function startClaim(db: D1Database, tokenId: string, method: Method, subject: string | undefined, contact: string | undefined): Promise<{ ok: true; claim: Claim } | { ok: false; error: string }> {
  const t = await db.prepare("SELECT id, kind FROM tokens WHERE id = ?1").bind(tokenId).first<{ id: string; kind: string }>();
  if (!t) return { ok: false, error: "Unknown token." };
  if (method === "dao_motion" && t.kind !== "sns") return { ok: false, error: "DAO motion claims are for SNS tokens. Use a controller payment or domain proof." };
  let code: string;
  let subj: string | null = null;
  if (method === "controller_payment") {
    if (!subject || !/^[a-z0-9-]{20,63}$/.test(subject)) return { ok: false, error: "Enter the controller principal you will send from." };
    subj = subject;
    code = String(BASE_E8S + 10_000 + Math.floor(Math.random() * 89_999)); // 0.00110000 to 0.00199999 ICP
  } else if (method === "domain") {
    const n = subject ? normalizeUrl(subject) : null;
    if (!n) return { ok: false, error: "Enter the website domain." };
    subj = new URL(n).hostname.replace(/^www\./, "");
    // Only domains the chain itself points at can be used: a published, on-chain-sourced website link.
    const ok = await db.prepare("SELECT 1 FROM token_links WHERE token_id = ?1 AND status = 'published' AND kind = 'website' AND (sources LIKE '%icrc1_metadata%' OR sources LIKE '%sns_metadata%' OR sources LIKE '%seed%') AND (url LIKE ?2 OR url LIKE ?3)").bind(tokenId, `https://${subj}%`, `https://www.${subj}%`).first();
    if (!ok) return { ok: false, error: `${subj} is not a website the ledger or DAO metadata points at, so it cannot prove control of this token. Use a controller payment or DAO motion instead.` };
    code = textCode();
  } else code = textCode();
  const claim: Claim = { id: rid().slice(0, 12), token_id: tokenId, method, code, subject: subj, status: "pending", evidence: null, contact: contact?.slice(0, 120) ?? null, created_at: now(), verified_at: null, checked_at: null };
  await db.prepare("INSERT INTO project_claims (id, token_id, method, code, subject, status, contact, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)").bind(claim.id, tokenId, method, code, subj, claim.contact, claim.created_at).run();
  return { ok: true, claim };
}

export const getClaim = (db: D1Database, id: string) => db.prepare("SELECT * FROM project_claims WHERE id = ?1").bind(id).first<Claim>();

export async function verifiedProfile(db: D1Database, tokenId: string): Promise<(Profile & { method: Method; verified_at: number }) | null> {
  const r = await db.prepare("SELECT p.*, c.method, c.verified_at FROM project_profiles p JOIN project_claims c ON c.id = p.claim_id WHERE p.token_id = ?1 AND c.status = 'verified'").bind(tokenId).first<Omit<Profile, "links"> & { links: string; method: Method; verified_at: number }>();
  if (!r) return null;
  let links: Profile["links"] = [];
  try { links = JSON.parse(r.links) as Profile["links"]; } catch { links = []; }
  return { ...r, links };
}

/** Current controllers of a token's ledger, read live so a claim cannot ride on a stale registry row. */
async function ledgerControllers(env: Env, tokenId: string): Promise<string[]> {
  const st = await readCanisterState(env.IC_HOST, tokenId).catch(() => null);
  if (st?.controllers?.length) return st.controllers;
  const row = await env.DB.prepare("SELECT controllers FROM canisters WHERE id = ?1").bind(tokenId).first<{ controllers: string | null }>();
  try { return row?.controllers ? (JSON.parse(row.controllers) as string[]) : []; } catch { return []; }
}

async function checkPayment(env: Env, c: Claim): Promise<{ ok: boolean; evidence?: unknown; note?: string }> {
  const controllers = await ledgerControllers(env, c.token_id);
  if (!c.subject || !controllers.includes(c.subject)) return { ok: false, note: "principal is not a controller" };
  const from = accountIdHex(c.subject);
  const page = await icpTransactions(env.IC_HOST, CLAIM_ACCOUNT, null, 50).catch(() => null);
  if (!page) return { ok: false, note: "index unavailable" };
  const want = Number(c.code) / 1e8;
  const hit = page.txs.find((tx) => tx.kind === "transfer" && tx.direction === "in" && tx.counterparty === from && tx.amount != null && Math.abs(tx.amount - want) < 1e-9 && (tx.ts ?? 0) >= c.created_at - 600);
  return hit ? { ok: true, evidence: { block: hit.id, from, amount_e8s: c.code } } : { ok: false };
}

async function checkMotion(env: Env, c: Claim): Promise<{ ok: boolean; evidence?: unknown }> {
  const r = await env.DB.prepare("SELECT id, state, title FROM sns_proposals WHERE token_id = ?1 AND action = 1 AND created_at >= ?2 AND (title LIKE ?3 OR summary LIKE ?3) ORDER BY id DESC LIMIT 1").bind(c.token_id, c.created_at - 600, `%${c.code}%`).first<{ id: number; state: string; title: string | null }>();
  if (!r) return { ok: false };
  if (r.state !== "adopted" && r.state !== "executed") return { ok: false, evidence: { proposal: r.id, state: r.state } };
  return { ok: true, evidence: { proposal: r.id, title: r.title } };
}

async function checkDomain(c: Claim): Promise<{ ok: boolean; evidence?: unknown }> {
  if (!c.subject) return { ok: false };
  for (const host of [c.subject, `www.${c.subject}`]) {
    try {
      const res = await fetch(`https://${host}/.well-known/icpwatch-claim.txt`, { headers: { "user-agent": "ICPWatch-Claims/1" }, redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const body = (await res.text()).slice(0, 2000);
      if (body.includes(c.code)) return { ok: true, evidence: { url: `https://${host}/.well-known/icpwatch-claim.txt` } };
    } catch { /* next host */ }
  }
  return { ok: false };
}

export interface ClaimsStats { pending: number; verified: number; expired: number; errors: number }

/** Hourly, and on demand from the claim page. Returns the edit key only through verifyNow(). */
export async function checkClaims(env: Env, only?: string): Promise<ClaimsStats & { editKey?: string }> {
  const db = env.DB;
  const ts = now();
  const stats: ClaimsStats & { editKey?: string } = { pending: 0, verified: 0, expired: 0, errors: 0 };
  const rows = (await (only ? db.prepare("SELECT * FROM project_claims WHERE id = ?1 AND status = 'pending'").bind(only) : db.prepare("SELECT * FROM project_claims WHERE status = 'pending' ORDER BY created_at LIMIT 50")).all<Claim>()).results;
  for (const c of rows) {
    stats.pending++;
    if (ts - c.created_at > CLAIM_TTL) { await db.prepare("UPDATE project_claims SET status = 'expired', checked_at = ?2 WHERE id = ?1").bind(c.id, ts).run(); stats.expired++; continue; }
    try {
      const r = c.method === "controller_payment" ? await checkPayment(env, c) : c.method === "dao_motion" ? await checkMotion(env, c) : await checkDomain(c);
      if (!r.ok) { await db.prepare("UPDATE project_claims SET checked_at = ?2, evidence = COALESCE(?3, evidence) WHERE id = ?1").bind(c.id, ts, r.evidence ? JSON.stringify(r.evidence) : null).run(); continue; }
      const editKey = rid();
      await db.batch([
        db.prepare("UPDATE project_claims SET status = 'verified', evidence = ?2, verified_at = ?3, checked_at = ?3, edit_key_hash = ?4 WHERE id = ?1").bind(c.id, JSON.stringify(r.evidence ?? {}), ts, await sha256(editKey)),
        // A newer verified claim replaces the profile owner; the old edit key stops working.
        db.prepare("INSERT INTO project_profiles (token_id, claim_id, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (token_id) DO UPDATE SET claim_id = excluded.claim_id, updated_at = excluded.updated_at").bind(c.token_id, c.id, ts),
        db.prepare("UPDATE project_claims SET status = 'expired' WHERE token_id = ?1 AND id != ?2 AND status = 'verified'").bind(c.token_id, c.id),
      ]);
      stats.verified++;
      if (only) stats.editKey = editKey;
    } catch { stats.errors++; }
  }
  return stats;
}

export async function profileByKey(db: D1Database, tokenId: string, key: string): Promise<Profile | null> {
  const h = await sha256(key);
  const r = await db.prepare("SELECT p.*, c.edit_key_hash FROM project_profiles p JOIN project_claims c ON c.id = p.claim_id WHERE p.token_id = ?1 AND c.status = 'verified' AND c.edit_key_hash = ?2").bind(tokenId, h).first<Omit<Profile, "links"> & { links: string }>();
  if (!r) return null;
  let links: Profile["links"] = [];
  try { links = JSON.parse(r.links) as Profile["links"]; } catch { links = []; }
  return { ...r, links };
}

export async function saveProfile(db: D1Database, tokenId: string, key: string, form: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const p = await profileByKey(db, tokenId, key);
  if (!p) return { ok: false, message: "That edit key does not match a verified claim for this token." };
  const links: Profile["links"] = [];
  for (const raw of ([] as unknown[]).concat(form.links ?? [])) {
    const n = typeof raw === "string" ? normalizeUrl(raw) : null;
    if (n && links.length < 6 && !links.some((l) => l.url === n)) links.push({ kind: classifyUrl(n), url: n });
  }
  const ts = now();
  const stmts = [
    db.prepare("UPDATE project_profiles SET display_name = ?2, tagline = ?3, links = ?4, contact = ?5, updated_at = ?6 WHERE token_id = ?1")
      .bind(tokenId, String(form.display_name ?? "").slice(0, 60) || null, String(form.tagline ?? "").replace(/\s+/g, " ").slice(0, 160) || null, JSON.stringify(links), String(form.contact ?? "").slice(0, 120) || null, ts),
    // Profile links publish as their own strong source; links the project removes lose that source and fall back to the normal rule.
    db.prepare("UPDATE token_links SET sources = json_remove(sources, (SELECT '$[' || key || ']' FROM json_each(token_links.sources) WHERE value = 'verified_project' LIMIT 1)), updated_at = ?2 WHERE token_id = ?1 AND sources LIKE '%verified_project%'").bind(tokenId, ts),
  ];
  for (const l of links) {
    stmts.push(db.prepare("INSERT INTO token_links (token_id, kind, url, sources, status, created_at, updated_at) VALUES (?1, ?2, ?3, '[\"verified_project\"]', 'published', ?4, ?4) ON CONFLICT (token_id, kind, url) DO UPDATE SET sources = CASE WHEN token_links.sources LIKE '%verified_project%' THEN token_links.sources ELSE json_insert(token_links.sources, '$[#]', 'verified_project') END, status = CASE WHEN token_links.status = 'rejected' THEN 'rejected' ELSE 'published' END, updated_at = ?4").bind(tokenId, l.kind, l.url, ts));
  }
  await db.batch(stmts);
  return { ok: true, message: "Profile saved. It is live on the token page." };
}
