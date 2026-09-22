// Notification fan-out. One message per (incident, subscription, kind): the UNIQUE constraint on
// the notifications table is the last line of defense against duplicates, on top of the incident
// state machine that only emits "fired" and "resolved" once each.
import type { CanisterRow } from "../db/queries";
import type { Env } from "../env";
import { fmtCycles, now } from "../lib/format";

export interface IncidentEvent {
  incidentId: number;
  canister: CanisterRow;
  type: string;
  kind: "fired" | "resolved";
  title: string;
  detail: string;
  severity: string;
  simulated?: boolean;
}

export interface Subscription { id: string; channel: string; target: string; types: string; secret: string | null }

/** A notification that is not tied to a canister incident: price rules, SNS feeds, bot digests. */
export interface Message {
  /** Machine event name for webhooks, e.g. "price.above". */
  event: string;
  title: string;
  detail: string;
  url: string;
  severity?: string;
  /** Extra webhook payload fields. */
  payload?: Record<string, unknown>;
}

export async function sendMessage(env: Env, s: Subscription, m: Message): Promise<SendResult> {
  const unsub = `${env.SITE_URL}/lifeline/alerts/unsubscribe?id=${s.id}`;
  const text = [m.title, "", m.detail, "", m.url, "", `Unsubscribe: ${unsub}`].join("\n");
  try {
    switch (s.channel) {
      case "telegram": return await sendTelegram(env, s.target, text);
      case "email": return await sendEmail(env, s.target, m.title, text);
      case "discord": {
        const res = await fetch(s.target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ICPWatch", embeds: [{ title: m.title, description: m.detail, url: m.url, color: colors[m.severity ?? "info"] ?? colors.info, footer: { text: `Unsubscribe: ${unsub}` } }] }) });
        return res.ok ? { ok: true } : { ok: false, error: `discord ${res.status}` };
      }
      case "webhook": {
        const body = JSON.stringify({ event: m.event, title: m.title, detail: m.detail, url: m.url, ...(m.payload ?? {}), unsubscribe: unsub, sent_at: now() });
        const res = await fetch(s.target, { method: "POST", headers: { "content-type": "application/json", "user-agent": "ICPWatch/1", "x-icpwatch-signature": await hmacHex(s.secret ?? "", body) }, body, redirect: "manual" });
        return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, error: `webhook ${res.status}` };
      }
      default: return { ok: false, error: `unknown channel ${s.channel}` };
    }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

export interface SendResult { ok: boolean; error?: string }

export const channelsConfigured = (env: Env) => ({ email: !!(env.RESEND_API_KEY && env.EMAIL_FROM), telegram: !!env.TELEGRAM_BOT_TOKEN, discord: true, webhook: true });

export async function notifyIncident(env: Env, ev: IncidentEvent): Promise<number> {
  const c = ev.canister;
  const subs = (
    await env.DB.prepare(
      `SELECT id, channel, target, types, secret FROM subscriptions
       WHERE verified = 1 AND ((scope_type = 'canister' AND scope_id = ?1) OR (scope_type = 'token' AND scope_id = ?2))`,
    ).bind(c.id, c.token_id ?? "").all<Subscription>()
  ).results;
  let sent = 0;
  const seenTargets = new Set<string>();
  for (const s of subs) {
    let types: string[] = [];
    try { types = JSON.parse(s.types) as string[]; } catch { /* treat as none */ }
    if (!types.includes(ev.type)) continue;
    // Someone subscribed to both the canister and its token gets one message, not two.
    const key = `${s.channel}:${s.target}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    // Claim the slot first. If the row already exists this notification was sent before.
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO notifications (incident_id, subscription_id, kind, sent_at, ok) VALUES (?, ?, ?, ?, 0)")
      .bind(ev.incidentId, s.id, ev.kind, now()).run();
    if (!claim.meta.changes) continue;
    const res = await send(env, s, ev);
    await env.DB.prepare("UPDATE notifications SET ok = ?, error = ? WHERE incident_id = ? AND subscription_id = ? AND kind = ?")
      .bind(res.ok ? 1 : 0, res.error ?? null, ev.incidentId, s.id, ev.kind).run();
    if (res.ok) {
      sent++;
      await env.DB.prepare("UPDATE subscriptions SET last_sent_at = ? WHERE id = ?").bind(now(), s.id).run();
    }
  }
  return sent;
}

const heading = (ev: IncidentEvent) => (ev.kind === "resolved" ? `Resolved: ${ev.title.replace(/^[^:]+:\s*/, "")}` : ev.title) + (ev.simulated ? " (simulated)" : "");

function textBody(env: Env, s: Pick<Subscription, "id">, ev: IncidentEvent): string {
  const c = ev.canister;
  return [
    heading(ev),
    "",
    ev.detail,
    "",
    `Canister: ${c.label} (${c.id})`,
    `Cycles: ${c.cycles != null ? fmtCycles(c.cycles) : "unknown"} - data: ${c.confidence}`,
    `${env.SITE_URL}/canister/${c.id}`,
    "",
    `Unsubscribe: ${env.SITE_URL}/lifeline/alerts/unsubscribe?id=${s.id}`,
  ].join("\n");
}

export async function send(env: Env, s: Subscription, ev: IncidentEvent): Promise<SendResult> {
  try {
    switch (s.channel) {
      case "discord": return await sendDiscord(env, s, ev);
      case "webhook": return await sendWebhook(env, s, ev);
      case "telegram": return await sendTelegram(env, s.target, textBody(env, s, ev));
      case "email": return await sendEmail(env, s.target, heading(ev), textBody(env, s, ev));
      default: return { ok: false, error: `unknown channel ${s.channel}` };
    }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

const colors: Record<string, number> = { critical: 0xed1e79, warn: 0xf7931e, info: 0x29a3e0 };

async function sendDiscord(env: Env, s: Subscription, ev: IncidentEvent): Promise<SendResult> {
  const c = ev.canister;
  const res = await fetch(s.target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "ICPWatch Lifeline",
      embeds: [{
        title: heading(ev), description: ev.detail, url: `${env.SITE_URL}/canister/${c.id}`, color: ev.kind === "resolved" ? colors.info : (colors[ev.severity] ?? colors.warn),
        fields: [
          { name: "Canister", value: `${c.label}\n\`${c.id}\``, inline: true },
          { name: "Cycles", value: `${c.cycles != null ? fmtCycles(c.cycles) : "unknown"} (${c.confidence})`, inline: true },
        ],
        footer: { text: `Unsubscribe: ${env.SITE_URL}/lifeline/alerts/unsubscribe?id=${s.id}` },
      }],
    }),
  });
  return res.ok ? { ok: true } : { ok: false, error: `discord ${res.status}` };
}

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendWebhook(env: Env, s: Subscription, ev: IncidentEvent): Promise<SendResult> {
  const c = ev.canister;
  const body = JSON.stringify({
    event: ev.kind === "fired" ? "incident.opened" : "incident.resolved",
    simulated: !!ev.simulated,
    incident: { id: ev.incidentId, type: ev.type, severity: ev.severity, title: ev.title, detail: ev.detail },
    canister: { id: c.id, label: c.label, role: c.role, token: c.token_symbol ?? null, cycles: c.cycles, confidence: c.confidence, run_status: c.run_status },
    url: `${env.SITE_URL}/canister/${c.id}`,
    unsubscribe: `${env.SITE_URL}/lifeline/alerts/unsubscribe?id=${s.id}`,
    sent_at: now(),
  });
  const res = await fetch(s.target, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "ICPWatch-Lifeline/1", "x-icpwatch-signature": await hmacHex(s.secret ?? "", body) },
    body,
    redirect: "manual",
  });
  return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, error: `webhook ${res.status}` };
}

export async function sendTelegram(env: Env, chatId: string, text: string): Promise<SendResult> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "telegram not configured" };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return res.ok ? { ok: true } : { ok: false, error: `telegram ${res.status}` };
}

/** Email goes through a Resend-compatible HTTP API. Swap the provider here and nowhere else. */
export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<SendResult> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { ok: false, error: "email not configured" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: `[ICPWatch] ${subject}`, text }),
  });
  return res.ok ? { ok: true } : { ok: false, error: `email ${res.status}` };
}

/**
 * Webhook and Discord targets are user supplied URLs fetched from our Worker, so restrict them:
 * https only, no IP literals, no localhost or internal names.
 */
export function safeTargetUrl(raw: string, channel: "discord" | "webhook"): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^[0-9.]+$/.test(h) || h.includes(":") || !h.includes(".")) return null;
  if (channel === "discord" && !/^(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)$/.test(h)) return null;
  if (channel === "discord" && !u.pathname.startsWith("/api/webhooks/")) return null;
  return u.toString();
}
