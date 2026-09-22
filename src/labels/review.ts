// Community labels: public submission into a review queue, and the admin review that promotes an
// approved submission to a 'community' label. Nothing a user submits is shown before approval.
import type { Env } from "../env";
import { now } from "../lib/format";
import { CATEGORIES, cleanText, normalizeId, upsertLabels, type LabelRow } from "./store";
import type { LabelCategory } from "./index";

export interface LabelSubmission {
  id: number; target_id: string; name: string; category: string; evidence_url: string | null; note: string | null; submitter_contact: string | null;
  origin: string; status: string; created_at: number; reviewed_at: number | null; reviewer_note: string | null;
}

export interface SubmitResult { ok: boolean; message: string }

const MAX_PENDING_PER_TARGET = 3;

/** Public form handler. Validates, rate-limits per target, and queues. Never writes to `labels`. */
export async function submitLabel(env: Env, form: Record<string, unknown>): Promise<SubmitResult> {
  if (form.website) return { ok: false, message: "Something went wrong." };
  const target = normalizeId(String(form.target ?? ""));
  if (!target) return { ok: false, message: "That is not a principal, an ICRC-1 account, or an ICP account identifier." };
  const name = cleanText(String(form.name ?? ""), 80);
  if (name.length < 2) return { ok: false, message: "Give the entity a name." };
  const category = String(form.category ?? "other") as LabelCategory;
  if (!CATEGORIES.includes(category)) return { ok: false, message: "Pick a category." };
  const evidence = String(form.evidence ?? "").trim();
  if (!/^https:\/\/[^\s]{5,300}$/.test(evidence)) return { ok: false, message: "Evidence must be a public https link: a page where the owner names this account." };
  const note = cleanText(String(form.note ?? ""), 500) || null;
  const contact = cleanText(String(form.contact ?? ""), 120) || null;
  const pending = await env.DB.prepare("SELECT COUNT(*) n FROM label_submissions WHERE target_id = ? AND status = 'pending' AND origin = 'public'").bind(target).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PER_TARGET) return { ok: false, message: "This account already has submissions waiting for review." };
  await env.DB.prepare("INSERT INTO label_submissions (target_id, name, category, evidence_url, note, submitter_contact, origin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'public', 'pending', ?)")
    .bind(target, name, category, evidence, note, contact, now()).run();
  return { ok: true, message: "Thanks. A reviewer will check the evidence before the label goes live." };
}

export async function listSubmissions(db: D1Database, status = "pending", limit = 100): Promise<LabelSubmission[]> {
  return (await db.prepare("SELECT * FROM label_submissions WHERE status = ? ORDER BY created_at DESC LIMIT ?").bind(status, Math.min(limit, 500)).all<LabelSubmission>()).results;
}

/** Approve (writes a 'community' label with the evidence link as its source) or reject, with a note. */
export async function reviewSubmission(env: Env, id: number, approve: boolean, note?: string): Promise<SubmitResult> {
  const s = await env.DB.prepare("SELECT * FROM label_submissions WHERE id = ?").bind(id).first<LabelSubmission>();
  if (!s) return { ok: false, message: "No such submission." };
  if (s.status !== "pending") return { ok: false, message: `Already ${s.status}.` };
  const ts = now();
  if (approve) {
    const row: LabelRow = {
      id: s.target_id, name: s.name, category: s.category as LabelCategory, confidence: "community",
      source: s.origin === "flow" ? `Flow pattern on the large-transfer feed, confirmed by a reviewer${note ? `: ${cleanText(note, 200)}` : ""}` : `Community submission, reviewed. Evidence: ${s.evidence_url ?? "none"}`,
      token_id: null, url: s.evidence_url, owner: null, origin: "community",
    };
    const up = await upsertLabels(env.DB, [row], ts);
    if (!up.written && up.blocked) return { ok: false, message: "A stronger label already exists for this id; rejected instead of overwriting it." };
  }
  await env.DB.prepare("UPDATE label_submissions SET status = ?, reviewed_at = ?, reviewer_note = ? WHERE id = ?").bind(approve ? "approved" : "rejected", ts, note ?? null, id).run();
  return { ok: true, message: approve ? "Approved and live." : "Rejected." };
}
