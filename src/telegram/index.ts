// Telegram bot: commands over our own data, alert subscriptions from chat, and group feeds with
// rate limits and quiet hours. Nothing here spends anything; every reply is a D1 read.
import { createRules, describeRule, parseRules } from "../alerts/price";
import { sendTelegram } from "../alerts/notify";
import * as q from "../db/queries";
import type { Env } from "../env";
import { largeTransfers } from "../indexer/queries";
import { ago, fmtCompact, fmtCycles, fmtNum, fmtUsd, now, span } from "../lib/format";
import { launches } from "../sns/feed";

export const FEEDS = ["sns", "whales", "launches", "lifeline", "moves"] as const;
export type Feed = (typeof FEEDS)[number];
const FEED_TEXT: Record<Feed, string> = { sns: "new SNS proposals", whales: "large transfers", launches: "SNS launches and swaps", lifeline: "canisters going low or frozen", moves: "price alerts that fired" };
const PER_HOUR = 20;
const PER_MESSAGE = 8;

// ---- transport -------------------------------------------------------------------------------------------

/** Webhook path segment: a hash of the bot token, so the URL cannot be guessed without the secret. */
export async function webhookPath(token: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`icpwatch-telegram:${token}`));
  return Array.from(new Uint8Array(h).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function tg(env: Env, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, description: "TELEGRAM_BOT_TOKEN not set" };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ ok: false, description: `telegram ${res.status}` }))) as { ok: boolean; result?: unknown; description?: string };
}

export const COMMANDS: [string, string][] = [
  ["start", "What this bot does, and your chat id"],
  ["price", "Price of a token: /price CHAT"],
  ["token", "Price, market cap, trust, and health: /token CHAT"],
  ["canister", "Cycles and runway: /canister <id>"],
  ["sns", "Treasury, proposals, unlocks: /sns CHAT"],
  ["whales", "Largest transfers today"],
  ["watch", "Cycle alerts here: /watch CHAT or /watch <canister id>"],
  ["pricealert", "/pricealert CHAT above 0.12 (or below, move 10, volume 3)"],
  ["alerts", "List this chat's alerts"],
  ["unsub", "Remove an alert: /unsub 2"],
  ["feed", "Group feeds: /feed sns on (sns, whales, launches, lifeline, moves)"],
  ["quiet", "Quiet hours for feeds: /quiet 23 7, or /quiet off"],
  ["tz", "Your UTC offset for quiet hours: /tz +2"],
  ["help", "All commands"],
];

/** Register the webhook and the command menu. Called from /admin/telegram/setup once the token secret exists. */
export async function setupTelegram(env: Env): Promise<{ ok: boolean; webhook?: unknown; commands?: unknown; error?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };
  const url = `${env.SITE_URL}/telegram/webhook/${await webhookPath(env.TELEGRAM_BOT_TOKEN)}`;
  const webhook = await tg(env, "setWebhook", { url, allowed_updates: ["message", "my_chat_member"], drop_pending_updates: true });
  const commands = await tg(env, "setMyCommands", { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
  return { ok: webhook.ok && commands.ok, webhook, commands };
}

// ---- updates ---------------------------------------------------------------------------------------------

interface TgUser { id: number; is_bot?: boolean; first_name?: string; username?: string }
interface TgChat { id: number; type: string; title?: string; username?: string }
export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; from?: TgUser; chat: TgChat; date: number; text?: string; entities?: { type: string; offset: number; length: number }[] };
  my_chat_member?: { chat: TgChat; new_chat_member: { status: string } };
}

export interface Reply { chat_id: string; text: string }

async function touchChat(db: D1Database, chat: TgChat): Promise<void> {
  const ts = now();
  await db.prepare("INSERT INTO telegram_chats (chat_id, kind, title, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT (chat_id) DO UPDATE SET kind = excluded.kind, title = excluded.title, last_seen_at = excluded.last_seen_at")
    .bind(String(chat.id), chat.type, chat.title ?? chat.username ?? null, ts).run();
}

/** In groups, feed and quiet-hour settings are admin only. DMs always pass. */
async function isAdmin(env: Env, chat: TgChat, user: TgUser | undefined): Promise<boolean> {
  if (chat.type === "private") return true;
  if (!user) return false;
  const r = await tg(env, "getChatMember", { chat_id: chat.id, user_id: user.id });
  const status = (r.result as { status?: string } | undefined)?.status;
  return status === "creator" || status === "administrator";
}

/** Handle one update. Returns the reply text (also sent) so tests and the admin simulator can see it. */
export async function handleUpdate(env: Env, u: TgUpdate): Promise<Reply | null> {
  const db = env.DB;
  if (u.my_chat_member) {
    const st = u.my_chat_member.new_chat_member.status;
    if (st === "left" || st === "kicked") await db.prepare("DELETE FROM telegram_chats WHERE chat_id = ?1").bind(String(u.my_chat_member.chat.id)).run();
    return null;
  }
  const m = u.message;
  if (!m?.text || !m.chat) return null;
  await touchChat(db, m.chat);
  const chatId = String(m.chat.id);
  // Commands may arrive as /cmd@BotName in groups.
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(m.text.trim());
  if (!match) return null;
  const cmd = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim().split(/\s+/).filter(Boolean);
  const site = env.SITE_URL;
  let text: string;
  try {
    switch (cmd) {
      case "start":
        text = [`ICPWatch bot. Your chat id is ${chatId}.`, "", "Ask me about any Internet Computer token or canister, or subscribe this chat to alerts.", "", ...COMMANDS.map(([c, d]) => `/${c}: ${d}`), "", `${site}/telegram`].join("\n");
        break;
      case "help":
        text = COMMANDS.map(([c, d]) => `/${c}: ${d}`).join("\n");
        break;
      case "price": case "token": text = await tokenReply(db, args[0], cmd === "token", site); break;
      case "canister": text = await canisterReply(db, args[0], site); break;
      case "sns": text = await snsReply(db, args[0], site); break;
      case "whales": text = await whalesReply(db, site); break;
      case "watch": text = await watchReply(db, chatId, args[0], site); break;
      case "pricealert": text = await priceAlertReply(db, chatId, args); break;
      case "alerts": text = await alertsReply(db, chatId); break;
      case "unsub": text = await unsubReply(db, chatId, Number(args[0])); break;
      case "feed":
        if (!(await isAdmin(env, m.chat, m.from))) { text = "Only group admins can change feeds."; break; }
        text = await feedReply(db, chatId, args[0], args[1]);
        break;
      case "quiet":
        if (!(await isAdmin(env, m.chat, m.from))) { text = "Only group admins can change quiet hours."; break; }
        text = await quietReply(db, chatId, args);
        break;
      case "tz":
        if (!(await isAdmin(env, m.chat, m.from))) { text = "Only group admins can change the time zone."; break; }
        text = await tzReply(db, chatId, args[0]);
        break;
      default: return null; // not ours (groups see every command)
    }
  } catch (e) {
    text = `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
  }
  await sendTelegram(env, chatId, text);
  return { chat_id: chatId, text };
}

// ---- command replies -------------------------------------------------------------------------------------

const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

async function tokenReply(db: D1Database, sym: string | undefined, full: boolean, site: string): Promise<string> {
  if (!sym) return "Which token? For example /price CHAT";
  const t = await q.getToken(db, sym);
  if (!t) return `I do not track "${sym}". Try a symbol like CHAT or a ledger id.`;
  const m = await q.getMarket(db, t.id);
  if (!m || m.price_usd == null) return `${t.name} (${t.symbol}) has no live price. ${site}/token/${t.id}`;
  if (!full) return `${t.symbol} ${fmtUsd(m.price_usd)} (${pct(m.chg_24h)} 24h, ${pct(m.chg_7d)} 7d)\n${site}/token/${t.id}`;
  const [trust, health] = await Promise.all([
    db.prepare("SELECT grade, score FROM trust_scores WHERE token_id = ?1").bind(t.id).first<{ grade: string; score: number }>(),
    db.prepare("SELECT health, role, freeze_at FROM canisters WHERE token_id = ?1 AND role IN ('ledger','index','archive') ORDER BY CASE health WHEN 'gone' THEN 6 WHEN 'frozen' THEN 5 WHEN 'low' THEN 4 WHEN 'risk' THEN 3 ELSE 0 END DESC LIMIT 1").bind(t.id).first<{ health: string; role: string; freeze_at: number | null }>(),
  ]);
  const h = !health ? "not watched" : health.health === "healthy" ? "healthy" : `${health.role} ${health.health}${health.freeze_at ? `, freezes in ${span(health.freeze_at - now())}` : ""}`;
  return [
    `${t.name} (${t.symbol})`,
    `Price ${fmtUsd(m.price_usd)} (${pct(m.chg_24h)} 24h, ${pct(m.chg_7d)} 7d)`,
    `Market cap ${fmtCompact(m.mcap_usd, "$")}, 24h volume ${fmtCompact(m.vol_24h_usd, "$")}, liquidity ${fmtCompact(m.tvl_usd, "$")}`,
    `Trust ${trust ? `${trust.grade} (${trust.score})` : "n/a"}, Lifeline ${h}`,
    `${site}/token/${t.id}`,
  ].join("\n");
}

async function canisterReply(db: D1Database, id: string | undefined, site: string): Promise<string> {
  if (!id) return "Which canister? For example /canister ryjl3-tyaaa-aaaaa-aaaba-cai";
  const c = await q.getCanister(db, id);
  if (!c) return `Not watched yet. Open ${site}/canister/${id} to add it.`;
  const runway = c.freeze_at ? `${span(c.freeze_at - now())} until it freezes` : "no freeze projection";
  return [
    `${c.label} (${c.id})`,
    `Cycles ${c.cycles != null ? fmtCycles(c.cycles) : "unknown"} (${c.confidence}), burning ${c.burn_per_day != null ? `${fmtCycles(c.burn_per_day)}/day` : "unknown"}`,
    `Status ${c.run_status}, health ${c.health}, ${runway}`,
    `${site}/canister/${c.id}`,
  ].join("\n");
}

async function snsReply(db: D1Database, sym: string | undefined, site: string): Promise<string> {
  if (!sym) return "Which DAO? For example /sns CHAT";
  const t = await q.getToken(db, sym);
  if (!t || t.kind !== "sns") return `${sym} is not an SNS DAO I track. See ${site}/sns`;
  const [kv, open, unlock] = await Promise.all([
    q.kvGet<{ treasury_icp: number | null; treasury_token: number | null; treasury_usd: number | null; neurons: number | null }>(db, `sns:${t.id}`),
    db.prepare("SELECT id, title, deadline_at, treasury_kind, treasury_amount FROM sns_proposals WHERE token_id = ?1 AND state = 'open' ORDER BY created_at DESC LIMIT 3").bind(t.id).all<{ id: number; title: string | null; deadline_at: number | null; treasury_kind: string | null; treasury_amount: number | null }>(),
    db.prepare("SELECT SUM(stake) s FROM sns_neurons WHERE token_id = ?1 AND dissolved_at IS NOT NULL AND dissolved_at BETWEEN ?2 AND ?3").bind(t.id, now(), now() + 30 * 86400).first<{ s: number | null }>(),
  ]);
  const v = kv?.value;
  const lines = [
    `${t.name} (${t.symbol}) SNS`,
    `Treasury ${v?.treasury_usd != null ? fmtCompact(v.treasury_usd, "$") : "n/a"}: ${fmtCompact(v?.treasury_icp)} ICP + ${fmtCompact(v?.treasury_token)} ${t.symbol}, ${fmtNum(v?.neurons)} neurons`,
    `Unlocking in 30 days: ${fmtCompact(unlock?.s ?? 0)} ${t.symbol}`,
  ];
  if (open.results.length) {
    lines.push(`Open proposals (${open.results.length}):`);
    for (const p of open.results) lines.push(`  #${p.id} ${p.title ?? ""}${p.treasury_kind ? ` [moves ${fmtCompact(p.treasury_amount)} ${p.treasury_kind === "icp" ? "ICP" : t.symbol}]` : ""}${p.deadline_at ? `, closes in ${span(p.deadline_at - now())}` : ""}`);
  } else lines.push("No open proposals.");
  lines.push(`${site}/token/${t.id}`);
  return lines.join("\n");
}

async function whalesReply(db: D1Database, site: string): Promise<string> {
  const rows = await largeTransfers(db, { limit: 60, beforeTs: now() + 1, kinds: ["transfer"] });
  const prices = new Map((await db.prepare("SELECT token_id, price_usd FROM market WHERE price_usd IS NOT NULL").all<{ token_id: string; price_usd: number }>()).results.map((r) => [r.token_id, r.price_usd]));
  const top = rows.filter((r) => r.ts > now() - 86400).map((r) => ({ ...r, usd: r.amount * (prices.get(r.ledger) ?? 0) })).filter((r) => r.usd >= 5000).sort((a, b) => b.usd - a.usd).slice(0, 8);
  if (!top.length) return `No transfer over $5,000 in our index in the last 24 hours. ${site}/markets/whales`;
  return ["Largest transfers, last 24h:", ...top.map((r) => `${fmtCompact(r.usd, "$")} ${fmtCompact(r.amount)} ${r.symbol ?? "?"} ${ago(r.ts)}`), `${site}/markets/whales`].join("\n");
}

async function watchReply(db: D1Database, chatId: string, what: string | undefined, site: string): Promise<string> {
  if (!what) return "Watch what? /watch CHAT for a whole token, or /watch <canister id>.";
  const t = await q.getToken(db, what);
  const scope = t ? { type: "token", id: t.id, label: `${t.symbol} (ledger, index, archives)` } : (await q.getCanister(db, what)) ? { type: "canister", id: what, label: what } : null;
  if (!scope) return `I do not know "${what}". Add a canister first at ${site}/canister/${what}, or use a token symbol.`;
  const id = crypto.randomUUID().replace(/-/g, "");
  const types = ["low_cycles", "frozen", "approaching_deletion", "burn_anomaly", "controller_change", "treasury_movement"];
  const r = await db.prepare("INSERT OR IGNORE INTO subscriptions (id, channel, target, scope_type, scope_id, types, verified, created_at) VALUES (?1, 'telegram', ?2, ?3, ?4, ?5, 1, ?6)")
    .bind(id, chatId, scope.type, scope.id, JSON.stringify(types), now()).run();
  return r.meta.changes ? `Watching ${scope.label}. This chat gets low cycles, frozen, deletion risk, burn anomaly, controller change, and treasury movement alerts. /alerts lists them, /unsub removes one.` : `This chat already watches ${scope.label}.`;
}

async function priceAlertReply(db: D1Database, chatId: string, args: string[]): Promise<string> {
  const [sym, kind, value, extra] = args;
  if (!sym || !kind || !value) return "Format: /pricealert CHAT above 0.12, /pricealert CHAT below 0.05, /pricealert CHAT move 10 (percent in 24h, add 1h for hourly), /pricealert CHAT volume 3 (times the 7-day average).";
  const t = await q.getToken(db, sym);
  if (!t) return `I do not track "${sym}".`;
  const form: Record<string, string> = {};
  if (kind === "above" || kind === "below") form[kind] = value;
  else if (kind === "move") { form.move_pct = value; form.window = extra === "1h" ? "1h" : "24h"; }
  else if (kind === "volume") form.volume_x = value;
  else return `Unknown condition "${kind}". Use above, below, move, or volume.`;
  const parsed = parseRules(form);
  if (parsed.error) return parsed.error;
  let sub = await db.prepare("SELECT id FROM subscriptions WHERE channel = 'telegram' AND target = ?1 AND scope_type = 'price' AND scope_id = ?2").bind(chatId, t.id).first<{ id: string }>();
  if (!sub) {
    const id = crypto.randomUUID().replace(/-/g, "");
    await db.prepare("INSERT INTO subscriptions (id, channel, target, scope_type, scope_id, types, verified, created_at) VALUES (?1, 'telegram', ?2, 'price', ?3, '[\"price\"]', 1, ?4)").bind(id, chatId, t.id, now()).run();
    sub = { id };
  }
  await createRules(db, sub.id, t.id, parsed.rules, parsed.cooldown_s);
  return `Set: ${parsed.rules.map((r) => describeRule(r, t.symbol)).join("; ")}. One message per event, then a 6 hour cooldown.`;
}

interface SubRow { id: string; scope_type: string; scope_id: string; types: string; symbol: string | null; label: string | null }

async function listSubs(db: D1Database, chatId: string): Promise<SubRow[]> {
  return (await db.prepare(`SELECT s.id, s.scope_type, s.scope_id, s.types, t.symbol, c.label FROM subscriptions s LEFT JOIN tokens t ON t.id = s.scope_id LEFT JOIN canisters c ON c.id = s.scope_id
    WHERE s.channel = 'telegram' AND s.target = ?1 ORDER BY s.created_at`).bind(chatId).all<SubRow>()).results;
}

async function describeSub(db: D1Database, s: SubRow): Promise<string> {
  if (s.scope_type === "price") {
    const rules = (await db.prepare("SELECT kind, value, window_s FROM price_rules WHERE subscription_id = ?1").bind(s.id).all<{ kind: "above" | "below" | "move_pct" | "volume_x"; value: number; window_s: number | null }>()).results;
    return `price: ${rules.map((r) => describeRule(r, s.symbol ?? s.scope_id)).join("; ") || "no rules"}`;
  }
  return `${s.scope_type === "token" ? `token ${s.symbol ?? s.scope_id}` : `canister ${s.label ?? s.scope_id}`}: ${(JSON.parse(s.types) as string[]).join(", ").replace(/_/g, " ")}`;
}

async function alertsReply(db: D1Database, chatId: string): Promise<string> {
  const subs = await listSubs(db, chatId);
  const feeds = (await db.prepare("SELECT feed FROM telegram_feeds WHERE chat_id = ?1 AND enabled = 1").bind(chatId).all<{ feed: Feed }>()).results;
  if (!subs.length && !feeds.length) return "Nothing yet. /watch CHAT, /pricealert CHAT above 0.12, or /feed sns on.";
  const lines: string[] = [];
  for (let i = 0; i < subs.length; i++) lines.push(`${i + 1}. ${await describeSub(db, subs[i]!)}`);
  if (feeds.length) lines.push(`Feeds on: ${feeds.map((f) => f.feed).join(", ")}`);
  lines.push("Remove one with /unsub <number>.");
  return lines.join("\n");
}

async function unsubReply(db: D1Database, chatId: string, n: number): Promise<string> {
  const subs = await listSubs(db, chatId);
  const s = subs[n - 1];
  if (!s) return `Pick a number from /alerts (1 to ${subs.length}).`;
  const what = await describeSub(db, s);
  await db.prepare("DELETE FROM subscriptions WHERE id = ?1").bind(s.id).run();
  return `Removed: ${what}`;
}

async function feedReply(db: D1Database, chatId: string, feed: string | undefined, state: string | undefined): Promise<string> {
  if (!feed || !(FEEDS as readonly string[]).includes(feed)) return `Feeds: ${FEEDS.map((f) => `${f} (${FEED_TEXT[f]})`).join(", ")}. Use /feed sns on or /feed sns off.`;
  const on = state !== "off";
  await db.prepare("INSERT INTO telegram_feeds (chat_id, feed, enabled, cursor, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT (chat_id, feed) DO UPDATE SET enabled = excluded.enabled, cursor = CASE WHEN excluded.enabled = 1 AND telegram_feeds.enabled = 0 THEN excluded.cursor ELSE telegram_feeds.cursor END, updated_at = excluded.updated_at")
    .bind(chatId, feed, on ? 1 : 0, now()).run();
  return on ? `Feed on: ${FEED_TEXT[feed as Feed]}. New items are posted here, batched, at most ${PER_HOUR} messages an hour. /quiet 23 7 holds them overnight.` : `Feed off: ${FEED_TEXT[feed as Feed]}.`;
}

async function quietReply(db: D1Database, chatId: string, args: string[]): Promise<string> {
  if (args[0] === "off") { await db.prepare("UPDATE telegram_chats SET quiet_from_h = NULL, quiet_to_h = NULL WHERE chat_id = ?1").bind(chatId).run(); return "Quiet hours off."; }
  const from = Number(args[0]), to = Number(args[1]);
  if (!(from >= 0 && from <= 23 && to >= 0 && to <= 23) || from === to) return "Format: /quiet 23 7 (hold feed posts from 23:00 to 07:00 local). Set your offset with /tz +2. /quiet off to disable.";
  await db.prepare("UPDATE telegram_chats SET quiet_from_h = ?2, quiet_to_h = ?3 WHERE chat_id = ?1").bind(chatId, from, to).run();
  const tz = await db.prepare("SELECT tz_offset_h FROM telegram_chats WHERE chat_id = ?1").bind(chatId).first<{ tz_offset_h: number }>();
  return `Quiet hours ${from}:00 to ${to}:00 (UTC${(tz?.tz_offset_h ?? 0) >= 0 ? "+" : ""}${tz?.tz_offset_h ?? 0}). Feed posts are held and sent as one digest afterwards. Alerts you subscribed to are never held.`;
}

async function tzReply(db: D1Database, chatId: string, arg: string | undefined): Promise<string> {
  const off = Number((arg ?? "").replace(/^utc/i, ""));
  if (!Number.isFinite(off) || off < -12 || off > 14) return "Format: /tz +2 or /tz -5 (hours from UTC).";
  await db.prepare("UPDATE telegram_chats SET tz_offset_h = ?2 WHERE chat_id = ?1").bind(chatId, off).run();
  return `Time zone set to UTC${off >= 0 ? "+" : ""}${off}.`;
}

// ---- feeds job -------------------------------------------------------------------------------------------

interface ChatRow { chat_id: string; tz_offset_h: number; quiet_from_h: number | null; quiet_to_h: number | null; hour_start: number; sent_in_hour: number }
interface FeedRow { chat_id: string; feed: Feed; cursor: number; held: string | null }
interface Item { ts: number; text: string }

export function inQuietHours(c: Pick<ChatRow, "tz_offset_h" | "quiet_from_h" | "quiet_to_h">, ts: number): boolean {
  if (c.quiet_from_h == null || c.quiet_to_h == null) return false;
  const localH = (((ts / 3600 + c.tz_offset_h) % 24) + 24) % 24;
  return c.quiet_from_h < c.quiet_to_h ? localH >= c.quiet_from_h && localH < c.quiet_to_h : localH >= c.quiet_from_h || localH < c.quiet_to_h;
}

/** New items for one feed since `cursor`, oldest first, capped. Shared across chats within a run via the cache. */
async function feedItems(env: Env, feed: Feed, cursor: number, cache: Map<string, Promise<Item[]>>): Promise<Item[]> {
  const key = `${feed}:${cursor}`;
  if (!cache.has(key)) cache.set(key, loadItems(env, feed, cursor));
  return cache.get(key)!;
}

async function loadItems(env: Env, feed: Feed, cursor: number): Promise<Item[]> {
  const db = env.DB, site = env.SITE_URL;
  const since = Math.max(cursor, now() - 6 * 3600); // never replay more than six hours on a fresh feed
  switch (feed) {
    case "sns": {
      const r = await db.prepare("SELECT p.token_id, t.symbol, t.sns_root, p.id, p.title, p.type, p.treasury_kind, p.treasury_amount, p.created_at FROM sns_proposals p JOIN tokens t ON t.id = p.token_id WHERE p.created_at > ?1 ORDER BY p.created_at ASC LIMIT 40").bind(since)
        .all<{ token_id: string; symbol: string; sns_root: string | null; id: number; title: string | null; type: string; treasury_kind: string | null; treasury_amount: number | null; created_at: number }>();
      return r.results.map((p) => ({ ts: p.created_at, text: `${p.symbol} #${p.id} ${p.type}${p.treasury_kind ? ` [moves ${fmtCompact(p.treasury_amount)} ${p.treasury_kind === "icp" ? "ICP" : p.symbol}]` : ""}: ${p.title ?? ""}\n${p.sns_root ? `https://nns.ic0.app/proposal/?u=${p.sns_root}&proposal=${p.id}` : `${site}/sns/proposals?dao=${p.token_id}`}` }));
    }
    case "whales": {
      const prices = new Map((await db.prepare("SELECT token_id, price_usd FROM market WHERE price_usd IS NOT NULL").all<{ token_id: string; price_usd: number }>()).results.map((r) => [r.token_id, r.price_usd]));
      const rows = await largeTransfers(db, { limit: 200, kinds: ["transfer"] });
      return rows.filter((r) => r.ts > since).map((r) => ({ r, usd: r.amount * (prices.get(r.ledger) ?? 0) })).filter((x) => x.usd >= 10000).sort((a, b) => a.r.ts - b.r.ts).slice(0, 20)
        .map(({ r, usd }) => ({ ts: r.ts, text: `${fmtCompact(usd, "$")}: ${fmtCompact(r.amount)} ${r.symbol ?? "?"} moved\n${site}/token/${r.ledger}` }));
    }
    case "launches": {
      const ls = await launches(db);
      return ls.map((l) => ({ ts: l.created_at ?? l.opens_at ?? 0, text: l.kind === "swap" ? `${l.name}: swap ${l.lifecycle === 2 ? "open" : "pending"}${l.icp_raised != null ? `, ${fmtCompact(l.icp_raised)} ICP raised` : ""}\n${site}/sns` : `${l.name}: NNS proposal ${l.proposal_id} to create an SNS (${l.status})\n${site}/proposal/${l.proposal_id}` })).filter((i) => i.ts > since).sort((a, b) => a.ts - b.ts);
    }
    case "lifeline": {
      const r = await db.prepare("SELECT i.type, i.title, i.detail, i.opened_at, i.canister_id FROM incidents i WHERE i.opened_at > ?1 AND i.simulated = 0 AND i.type IN ('low_cycles','frozen','approaching_deletion') ORDER BY i.opened_at ASC LIMIT 30").bind(since)
        .all<{ type: string; title: string; detail: string; opened_at: number; canister_id: string }>();
      return r.results.map((i) => ({ ts: i.opened_at, text: `${i.title}\n${site}/canister/${i.canister_id}` }));
    }
    case "moves": {
      const r = await db.prepare("SELECT e.token_id, e.detail, e.ts FROM price_events e WHERE e.ts > ?1 ORDER BY e.ts ASC LIMIT 30").bind(since).all<{ token_id: string; detail: string; ts: number }>();
      return r.results.map((e) => ({ ts: e.ts, text: `${e.detail}\n${site}/token/${e.token_id}` }));
    }
  }
}

export interface FeedStats { chats: number; feeds: number; items: number; messages: number; held: number; errors: number }

export async function telegramFeedsJob(env: Env): Promise<FeedStats> {
  const db = env.DB;
  const ts = now();
  const stats: FeedStats = { chats: 0, feeds: 0, items: 0, messages: 0, held: 0, errors: 0 };
  if (!env.TELEGRAM_BOT_TOKEN) return stats;
  const feeds = (await db.prepare("SELECT f.chat_id, f.feed, f.cursor, f.held FROM telegram_feeds f WHERE f.enabled = 1").all<FeedRow>()).results;
  if (!feeds.length) return stats;
  const chats = new Map((await db.prepare("SELECT chat_id, tz_offset_h, quiet_from_h, quiet_to_h, hour_start, sent_in_hour FROM telegram_chats").all<ChatRow>()).results.map((c) => [c.chat_id, c]));
  stats.chats = chats.size;
  const cache = new Map<string, Promise<Item[]>>();
  for (const f of feeds) {
    const chat = chats.get(f.chat_id);
    if (!chat) continue;
    stats.feeds++;
    try {
      let held: Item[] = [];
      try { held = f.held ? (JSON.parse(f.held) as Item[]) : []; } catch { held = []; }
      const fresh = (await feedItems(env, f.feed, f.cursor, cache)).filter((i) => i.ts > f.cursor);
      const items = [...held, ...fresh];
      if (!items.length) continue;
      const newest = Math.max(f.cursor, ...items.map((i) => i.ts));
      if (inQuietHours(chat, ts)) {
        // Hold (capped) and advance the cursor so nothing is fetched twice.
        await db.prepare("UPDATE telegram_feeds SET held = ?3, cursor = ?4, updated_at = ?5 WHERE chat_id = ?1 AND feed = ?2").bind(f.chat_id, f.feed, JSON.stringify(items.slice(-60)), newest, ts).run();
        stats.held += fresh.length;
        continue;
      }
      // Rate limit per chat: window resets hourly; when near the cap, squeeze everything into the last message.
      if (ts - chat.hour_start >= 3600) { chat.hour_start = ts; chat.sent_in_hour = 0; }
      const budget = Math.max(0, PER_HOUR - chat.sent_in_hour);
      if (budget === 0) { await db.prepare("UPDATE telegram_feeds SET held = ?3, cursor = ?4, updated_at = ?5 WHERE chat_id = ?1 AND feed = ?2").bind(f.chat_id, f.feed, JSON.stringify(items.slice(-60)), newest, ts).run(); stats.held += fresh.length; continue; }
      const per = Math.max(PER_MESSAGE, Math.ceil(items.length / budget));
      const label = held.length ? `${FEED_TEXT[f.feed]} (digest, ${items.length})` : FEED_TEXT[f.feed];
      let sent = 0;
      for (let i = 0; i < items.length; i += per) {
        const chunk = items.slice(i, i + per);
        const r = await sendTelegram(env, f.chat_id, `ICPWatch, ${label}:\n\n${chunk.map((c) => c.text).join("\n\n")}`);
        if (!r.ok) { stats.errors++; break; }
        sent++; stats.messages++; stats.items += chunk.length;
      }
      chat.sent_in_hour += sent;
      await db.batch([
        db.prepare("UPDATE telegram_feeds SET held = NULL, cursor = ?3, updated_at = ?4 WHERE chat_id = ?1 AND feed = ?2").bind(f.chat_id, f.feed, newest, ts),
        db.prepare("UPDATE telegram_chats SET hour_start = ?2, sent_in_hour = ?3 WHERE chat_id = ?1").bind(f.chat_id, chat.hour_start, chat.sent_in_hour),
      ]);
    } catch (e) {
      stats.errors++;
      console.error("telegram feed", f.chat_id, f.feed, e instanceof Error ? e.message : String(e));
    }
  }
  return stats;
}
