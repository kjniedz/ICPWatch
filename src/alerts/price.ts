// Price and volume alerts. Rules are evaluated right after the markets collector lands a snapshot.
// Each rule fires at most once per cooldown, and threshold rules re-arm only after the price crosses
// back, so a token grinding through a level does not ping on every tick.
import type { Env } from "../env";
import { fmtCompact, fmtUsd, now } from "../lib/format";
import { sendMessage, type Subscription } from "./notify";

export type RuleKind = "above" | "below" | "move_pct" | "volume_x";
export const RULE_KINDS: RuleKind[] = ["above", "below", "move_pct", "volume_x"];

export interface RuleInput { kind: RuleKind; value: number; window_s?: number | null }

export interface RuleRow extends RuleInput {
  id: number; subscription_id: string; token_id: string; cooldown_s: number; armed: number; last_fired_at: number | null; fired_count: number;
}

export function parseRules(form: Record<string, unknown>): { rules: RuleInput[]; cooldown_s: number; error?: string } {
  const rules: RuleInput[] = [];
  const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[$,%\s]/g, "")); return Number.isFinite(n) ? n : NaN; };
  const above = num(form.above), below = num(form.below), move = num(form.move_pct), vol = num(form.volume_x);
  if (form.above && !(above > 0)) return { rules, cooldown_s: 0, error: "The 'above' price must be a positive number." };
  if (form.below && !(below > 0)) return { rules, cooldown_s: 0, error: "The 'below' price must be a positive number." };
  if (above > 0) rules.push({ kind: "above", value: above });
  if (below > 0) rules.push({ kind: "below", value: below });
  if (move > 0) {
    if (move < 1 || move > 500) return { rules, cooldown_s: 0, error: "Price move must be between 1% and 500%." };
    rules.push({ kind: "move_pct", value: move, window_s: String(form.window) === "1h" ? 3600 : 86400 });
  }
  if (vol > 0) {
    if (vol < 1.5 || vol > 100) return { rules, cooldown_s: 0, error: "Volume multiple must be between 1.5x and 100x." };
    rules.push({ kind: "volume_x", value: vol });
  }
  const cooldownH = num(form.cooldown_h);
  const cooldown_s = Math.min(Math.max(Number.isFinite(cooldownH) && cooldownH > 0 ? cooldownH : 6, 1), 168) * 3600;
  if (!rules.length) return { rules, cooldown_s, error: "Set at least one condition." };
  return { rules, cooldown_s };
}

export function describeRule(r: RuleInput, symbol: string): string {
  switch (r.kind) {
    case "above": return `${symbol} above ${fmtUsd(r.value)}`;
    case "below": return `${symbol} below ${fmtUsd(r.value)}`;
    case "move_pct": return `${symbol} moves ${r.value}% or more in ${r.window_s === 3600 ? "1 hour" : "24 hours"}`;
    case "volume_x": return `${symbol} 24h volume is ${r.value}x its 7-day average`;
  }
}

export async function createRules(db: D1Database, subscriptionId: string, tokenId: string, rules: RuleInput[], cooldown_s: number): Promise<void> {
  const ts = now();
  await db.batch(rules.map((r) => db.prepare("INSERT INTO price_rules (subscription_id, token_id, kind, value, window_s, cooldown_s, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(subscriptionId, tokenId, r.kind, r.value, r.window_s ?? null, cooldown_s, ts)));
}

export interface PriceStats { rules: number; checked: number; fired: number; sent: number; rearmed: number; errors: number }

interface MarketSnap { token_id: string; symbol: string; name: string; price_usd: number | null; vol_24h_usd: number | null; updated_at: number }

/** Reference price `window_s` ago from our own hourly candles, closest earlier point. */
async function referencePrice(db: D1Database, tokenId: string, window_s: number, ts: number): Promise<number | null> {
  const r = await db.prepare("SELECT price_usd FROM prices WHERE token_id = ?1 AND res = 'hour' AND ts <= ?2 AND ts >= ?3 ORDER BY ts DESC LIMIT 1").bind(tokenId, ts - window_s, ts - window_s - 3 * 3600).first<{ price_usd: number }>();
  return r?.price_usd ?? null;
}

/** 7-day average of daily volume from our own daily candles, excluding today. */
async function avgDailyVolume(db: D1Database, tokenId: string, ts: number): Promise<number | null> {
  const r = await db.prepare("SELECT AVG(vol_usd) v, COUNT(*) n FROM prices WHERE token_id = ?1 AND res = 'day' AND ts < ?2 AND ts >= ?3 AND vol_usd IS NOT NULL").bind(tokenId, ts - (ts % 86400), ts - 8 * 86400).first<{ v: number | null; n: number }>();
  return r && r.n >= 3 && r.v ? r.v : null;
}

export async function evaluatePriceRules(env: Env): Promise<PriceStats> {
  const db = env.DB;
  const ts = now();
  const stats: PriceStats = { rules: 0, checked: 0, fired: 0, sent: 0, rearmed: 0, errors: 0 };
  const rules = (await db.prepare(`SELECT r.id, r.subscription_id, r.token_id, r.kind, r.value, r.window_s, r.cooldown_s, r.armed, r.last_fired_at, r.fired_count
      FROM price_rules r JOIN subscriptions s ON s.id = r.subscription_id WHERE s.verified = 1`).all<RuleRow>()).results;
  stats.rules = rules.length;
  if (!rules.length) return stats;
  const tokenIds = [...new Set(rules.map((r) => r.token_id))];
  const snaps = new Map<string, MarketSnap>();
  for (let i = 0; i < tokenIds.length; i += 50) {
    const slice = tokenIds.slice(i, i + 50);
    const r = await db.prepare(`SELECT m.token_id, t.symbol, t.name, m.price_usd, m.vol_24h_usd, m.updated_at FROM market m JOIN tokens t ON t.id = m.token_id WHERE m.token_id IN (${slice.map((_, j) => `?${j + 1}`).join(",")})`).bind(...slice).all<MarketSnap>();
    for (const s of r.results) snaps.set(s.token_id, s);
  }
  const subs = new Map<string, Subscription>();
  for (const id of [...new Set(rules.map((r) => r.subscription_id))]) {
    const s = await db.prepare("SELECT id, channel, target, types, secret FROM subscriptions WHERE id = ?1").bind(id).first<Subscription>();
    if (s) subs.set(id, s);
  }
  const refCache = new Map<string, Promise<number | null>>();
  const volCache = new Map<string, Promise<number | null>>();

  for (const r of rules) {
    const m = snaps.get(r.token_id);
    if (!m || m.price_usd == null || ts - m.updated_at > 1800) continue; // stale snapshot: never alert on old data
    stats.checked++;
    const price = m.price_usd;
    let hit = false, detail = "", rearm = false, changePct: number | null = null;
    try {
      switch (r.kind) {
        case "above": hit = price >= r.value; rearm = price < r.value * 0.98; detail = `${m.symbol} is ${fmtUsd(price)}, above your ${fmtUsd(r.value)} level.`; break;
        case "below": hit = price <= r.value; rearm = price > r.value * 1.02; detail = `${m.symbol} is ${fmtUsd(price)}, below your ${fmtUsd(r.value)} level.`; break;
        case "move_pct": {
          const key = `${r.token_id}:${r.window_s}`;
          if (!refCache.has(key)) refCache.set(key, referencePrice(db, r.token_id, r.window_s ?? 86400, ts));
          const ref = await refCache.get(key)!;
          if (ref == null || ref <= 0) continue;
          changePct = ((price - ref) / ref) * 100;
          hit = Math.abs(changePct) >= r.value;
          rearm = Math.abs(changePct) < r.value * 0.5;
          detail = `${m.symbol} is ${changePct >= 0 ? "up" : "down"} ${Math.abs(changePct).toFixed(1)}% in the last ${r.window_s === 3600 ? "hour" : "24 hours"}: ${fmtUsd(ref)} to ${fmtUsd(price)}.`;
          break;
        }
        case "volume_x": {
          if (!volCache.has(r.token_id)) volCache.set(r.token_id, avgDailyVolume(db, r.token_id, ts));
          const avg = await volCache.get(r.token_id)!;
          if (avg == null || m.vol_24h_usd == null) continue;
          const x = m.vol_24h_usd / avg;
          hit = x >= r.value;
          rearm = x < r.value * 0.5;
          detail = `${m.symbol} 24h volume is ${fmtCompact(m.vol_24h_usd, "$")}, ${x.toFixed(1)}x its 7-day average of ${fmtCompact(avg, "$")} a day.`;
          break;
        }
      }
    } catch { stats.errors++; continue; }

    if (!r.armed) {
      if (rearm) { await db.prepare("UPDATE price_rules SET armed = 1 WHERE id = ?1").bind(r.id).run(); stats.rearmed++; }
      continue;
    }
    if (!hit) continue;
    if (r.last_fired_at && ts - r.last_fired_at < r.cooldown_s) continue;
    // Claim before sending so a slow send cannot double fire on the next tick.
    const claim = await db.prepare("UPDATE price_rules SET armed = 0, last_fired_at = ?2, fired_count = fired_count + 1 WHERE id = ?1 AND armed = 1").bind(r.id, ts).run();
    if (!claim.meta.changes) continue;
    stats.fired++;
    const sub = subs.get(r.subscription_id);
    if (!sub) continue;
    const title = `${m.symbol}: ${describeRule(r, m.symbol)}`;
    const res = await sendMessage(env, sub, {
      event: `price.${r.kind}`, title, detail, url: `${env.SITE_URL}/token/${r.token_id}`, severity: "info",
      payload: { token: { id: r.token_id, symbol: m.symbol, name: m.name }, price_usd: price, change_pct: changePct, volume_24h_usd: m.vol_24h_usd, rule: { kind: r.kind, value: r.value, window_s: r.window_s } },
    });
    if (res.ok) { stats.sent++; await db.prepare("UPDATE subscriptions SET last_sent_at = ?2 WHERE id = ?1").bind(sub.id, ts).run(); }
    else stats.errors++;
    // Public feed: one row per token and kind per cooldown window, so the feed stays readable.
    const recent = await db.prepare("SELECT 1 FROM price_events WHERE token_id = ?1 AND kind = ?2 AND ts > ?3").bind(r.token_id, r.kind, ts - 3600).first();
    if (!recent) await db.prepare("INSERT INTO price_events (token_id, kind, detail, price_usd, ts) VALUES (?1, ?2, ?3, ?4, ?5)").bind(r.token_id, r.kind, detail, price, ts).run();
  }
  return stats;
}

export interface PriceEventRow { id: number; token_id: string; symbol: string; name: string; logo: string | null; kind: string; detail: string; price_usd: number | null; ts: number }

export const recentPriceEvents = async (db: D1Database, limit = 50): Promise<PriceEventRow[]> =>
  (await db.prepare("SELECT e.id, e.token_id, t.symbol, t.name, t.logo, e.kind, e.detail, e.price_usd, e.ts FROM price_events e JOIN tokens t ON t.id = e.token_id ORDER BY e.ts DESC LIMIT ?1").bind(limit).all<PriceEventRow>()).results;

export const rulesForSubscription = async (db: D1Database, subscriptionId: string): Promise<RuleRow[]> =>
  (await db.prepare("SELECT id, subscription_id, token_id, kind, value, window_s, cooldown_s, armed, last_fired_at, fired_count FROM price_rules WHERE subscription_id = ?1").bind(subscriptionId).all<RuleRow>()).results;
