// Upgrade and controller history. Runs hourly over a rotating slice of the watched canisters.
//
// The management canister answers canister_info as an ANONYMOUS QUERY when the request is routed
// with the target as effective canister id. It returns the last 20 changes (creation, code
// deployments, controller changes, snapshot loads) plus the running module hash and controllers.
// Only 20 are kept on chain, so unseen changes are accumulated in canister_history.
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import type { Env } from "../env";
import { now } from "../lib/format";
import { securityEvents, type HistoryEntry, type HistoryKind, type HistoryRow, type KnownState, type SecurityEvent } from "../lib/history";
import { getAgent, pool } from "../lib/ic";
import { batchAll } from "./lifeline";

const MANAGEMENT = "aaaaa-aa";
const CURSOR_KEY = "history:cursor";

// ---- candid ---------------------------------------------------------------------------------------------------

const Origin = IDL.Variant({
  from_user: IDL.Record({ user_id: IDL.Principal }),
  from_canister: IDL.Record({ canister_id: IDL.Principal, canister_version: IDL.Opt(IDL.Nat64) }),
});
// Payloads we do not read are declared reserved, which decodes any wire type. A variant tag that
// is not listed here still fails to decode, so there is a second, looser decoder below.
const Details = IDL.Variant({
  creation: IDL.Record({ controllers: IDL.Vec(IDL.Principal) }),
  code_uninstall: IDL.Null,
  code_deployment: IDL.Record({ mode: IDL.Variant({ install: IDL.Null, reinstall: IDL.Null, upgrade: IDL.Null }), module_hash: IDL.Vec(IDL.Nat8) }),
  controllers_change: IDL.Record({ controllers: IDL.Vec(IDL.Principal) }),
  load_snapshot: IDL.Reserved,
  rename_canister: IDL.Reserved,
});
const infoResult = (details: IDL.Type, origin: IDL.Type) =>
  IDL.Record({
    total_num_changes: IDL.Nat64,
    recent_changes: IDL.Vec(IDL.Record({ timestamp_nanos: IDL.Nat64, canister_version: IDL.Nat64, origin, details })),
    module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
    controllers: IDL.Vec(IDL.Principal),
  });
const InfoArgs = IDL.Record({ canister_id: IDL.Principal, num_requested_changes: IDL.Opt(IDL.Nat64) });
const InfoStrict = infoResult(Details, Origin);
/** Fallback for replicas that add change kinds we have not seen: versions and timestamps still decode, kind becomes "other". */
const InfoLoose = infoResult(IDL.Reserved, IDL.Reserved);

type OriginRaw = { from_user: { user_id: Principal } } | { from_canister: { canister_id: Principal } } | null;
type DetailsRaw =
  | { creation: { controllers: Principal[] } } | { code_uninstall: null }
  | { code_deployment: { mode: Record<string, null>; module_hash: Uint8Array | number[] } }
  | { controllers_change: { controllers: Principal[] } } | { load_snapshot: null } | { rename_canister: null } | null;
interface InfoRaw {
  total_num_changes: bigint; module_hash: [] | [Uint8Array | number[]]; controllers: Principal[];
  recent_changes: { timestamp_nanos: bigint; canister_version: bigint; origin: OriginRaw; details: DetailsRaw }[];
}

export interface CanisterInfo { canisterId: string; totalChanges: number; moduleHash: string | null; controllers: string[]; changes: HistoryEntry[]; loose: boolean }

const hex = (b: Uint8Array | number[]) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Pure: decoded candid to history entries. Exported for tests. */
export function entriesFromInfo(canisterId: string, raw: InfoRaw): HistoryEntry[] {
  return raw.recent_changes.map((ch) => {
    const o = ch.origin;
    const origin = !o ? null : "from_user" in o ? `user:${o.from_user.user_id.toText()}` : `canister:${o.from_canister.canister_id.toText()}`;
    const d = ch.details;
    let kind: HistoryKind = "other";
    let moduleHash: string | null = null;
    let controllers: string[] | null = null;
    if (d && "creation" in d) { kind = "creation"; controllers = d.creation.controllers.map((p) => p.toText()); }
    else if (d && "code_uninstall" in d) kind = "uninstall";
    else if (d && "code_deployment" in d) {
      const mode = d.code_deployment.mode;
      kind = "install" in mode ? "install" : "reinstall" in mode ? "reinstall" : "upgrade";
      moduleHash = hex(d.code_deployment.module_hash);
    } else if (d && "controllers_change" in d) { kind = "controllers_change"; controllers = d.controllers_change.controllers.map((p) => p.toText()); }
    else if (d && "load_snapshot" in d) kind = "snapshot";
    return { canister_id: canisterId, canister_version: Number(ch.canister_version), ts: Number(ch.timestamp_nanos / 1_000_000_000n), kind, module_hash: moduleHash, controllers, origin };
  });
}

/** Live canister_info for any canister: anonymous query to the management canister, no cycles spent by anyone. */
export async function canisterInfo(host: string, canisterId: string, changes = 20): Promise<CanisterInfo> {
  const agent = await getAgent(host);
  const target = Principal.fromText(canisterId);
  const res = (await agent.query(MANAGEMENT, {
    methodName: "canister_info",
    arg: IDL.encode([InfoArgs], [{ canister_id: target, num_requested_changes: [BigInt(changes)] }]),
    effectiveCanisterId: target,
  })) as { status: string; reply?: { arg: Uint8Array }; error_code?: string; reject_message?: string };
  if (res.status !== "replied" || !res.reply) throw new Error(`canister_info rejected: ${res.error_code ?? ""} ${res.reject_message ?? res.status}`.trim());
  return decodeCanisterInfo(canisterId, res.reply.arg);
}

/** Pure: reply bytes to CanisterInfo. Falls back to the loose decoder when the replica reports a change kind we do not know. */
export function decodeCanisterInfo(canisterId: string, bytes: Uint8Array): CanisterInfo {
  let raw: InfoRaw;
  let loose = false;
  try {
    raw = IDL.decode([InfoStrict], bytes)[0] as unknown as InfoRaw;
  } catch {
    raw = IDL.decode([InfoLoose], bytes)[0] as unknown as InfoRaw;
    loose = true;
  }
  return {
    canisterId, totalChanges: Number(raw.total_num_changes), moduleHash: raw.module_hash[0] ? hex(raw.module_hash[0]) : null,
    controllers: raw.controllers.map((p) => p.toText()), changes: entriesFromInfo(canisterId, raw), loose,
  };
}

// ---- collector ----------------------------------------------------------------------------------------------------

export interface HistoryRunStats { checked: number; inserted: number; errors: number; events: SecurityEvent[]; cursor: string | null }

/**
 * Checks `limit` watched canisters, continuing after the cursor kept in kv `history:cursor` and
 * wrapping around, so the whole registry is covered every ceil(N / limit) runs. New changes are
 * inserted with INSERT OR IGNORE keyed on (canister_id, canister_version). `events` holds the
 * controller and module changes found on canisters that already had a baseline, ready for alerting.
 */
export async function collectHistory(env: Env, opts: { limit: number }): Promise<HistoryRunStats> {
  const ts = now();
  const limit = Math.max(1, Math.min(opts.limit, 400));
  const stats: HistoryRunStats = { checked: 0, inserted: 0, errors: 0, events: [], cursor: null };

  const cursorRow = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(CURSOR_KEY).first<{ value: string }>();
  let after = "";
  try { after = (JSON.parse(cursorRow?.value ?? "{}") as { after?: string }).after ?? ""; } catch { /* start over */ }

  const pick = "SELECT id FROM canisters WHERE run_status != 'deleted' AND id > ? ORDER BY id LIMIT ?";
  let ids = (await env.DB.prepare(pick).bind(after, limit).all<{ id: string }>()).results.map((r) => r.id);
  if (ids.length < limit && after) {
    const seen = new Set(ids);
    const more = (await env.DB.prepare(pick).bind("", limit - ids.length).all<{ id: string }>()).results.map((r) => r.id).filter((id) => !seen.has(id));
    ids = ids.concat(more);
  }
  if (!ids.length) return stats;

  // Baselines and the newest version we already hold, per canister.
  // A baseline exists only after one successful read: those always store a controllers array, even an empty one.
  const state = new Map<string, KnownState>();
  const maxVersion = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const marks = chunk.map(() => "?").join(",");
    const [st, mx] = await env.DB.batch<{ canister_id: string; module_hash?: string | null; controllers?: string | null; v?: number }>([
      env.DB.prepare(`SELECT canister_id, module_hash, controllers FROM canister_history_state WHERE controllers IS NOT NULL AND canister_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`SELECT canister_id, MAX(canister_version) v FROM canister_history WHERE canister_id IN (${marks}) GROUP BY canister_id`).bind(...chunk),
    ]);
    for (const r of st!.results) {
      let controllers: string[] | null = null;
      try { controllers = r.controllers ? (JSON.parse(r.controllers) as string[]) : null; } catch { /* ignore */ }
      state.set(r.canister_id, { moduleHash: r.module_hash ?? null, controllers });
    }
    for (const r of mx!.results) if (r.v != null) maxVersion.set(r.canister_id, r.v);
  }

  const results = await pool(ids, 6, (id) => canisterInfo(env.IC_HOST, id));

  const insert = env.DB.prepare("INSERT OR IGNORE INTO canister_history (canister_id, canister_version, ts, kind, module_hash, controllers, origin) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const upsert = env.DB.prepare(`INSERT INTO canister_history_state (canister_id, total_changes, module_hash, controllers, checked_at, error) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT (canister_id) DO UPDATE SET total_changes = excluded.total_changes, module_hash = excluded.module_hash, controllers = excluded.controllers, checked_at = excluded.checked_at, error = NULL`);
  const failed = env.DB.prepare(`INSERT INTO canister_history_state (canister_id, total_changes, checked_at, error) VALUES (?, 0, ?, ?)
    ON CONFLICT (canister_id) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`);
  const stmts: D1PreparedStatement[] = [];
  results.forEach((r, i) => {
    const id = ids[i]!;
    if (r.status !== "fulfilled") {
      stats.errors++;
      stmts.push(failed.bind(id, ts, String(r.reason instanceof Error ? r.reason.message : r.reason).replace(/\s+/g, " ").slice(0, 200)));
      return;
    }
    stats.checked++;
    const info = r.value;
    const prev = state.get(id) ?? null;
    const known = maxVersion.get(id);
    const fresh = info.changes.filter((ch) => known == null || ch.canister_version > known);
    for (const ch of fresh) stmts.push(insert.bind(ch.canister_id, ch.canister_version, ch.ts, ch.kind, ch.module_hash, ch.controllers ? JSON.stringify(ch.controllers) : null, ch.origin));
    stats.inserted += fresh.length;
    // No baseline (first time we see this canister) means a silent backfill: securityEvents returns nothing for null.
    if (prev && fresh.length) stats.events.push(...securityEvents(prev, fresh));
    stmts.push(upsert.bind(id, info.totalChanges, info.moduleHash, JSON.stringify(info.controllers), ts));
  });
  await batchAll(env.DB, stmts);

  stats.cursor = ids[ids.length - 1] ?? null;
  await env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES (?, ?, 'history collector', ?)").bind(CURSOR_KEY, JSON.stringify({ after: stats.cursor }), ts).run();
  return stats;
}

// ---- read side --------------------------------------------------------------------------------------------------------

export interface CanisterHistory { rows: HistoryRow[]; total_changes: number | null; checked_at: number | null }

/** Everything we hold for one canister, newest first, plus how many changes the IC says there were in total. */
export async function historyFor(db: D1Database, canisterId: string): Promise<CanisterHistory> {
  const [rows, st] = await db.batch<HistoryRow & { total_changes?: number; checked_at?: number }>([
    db.prepare("SELECT canister_id, canister_version, ts, kind, module_hash, controllers, origin FROM canister_history WHERE canister_id = ? ORDER BY canister_version DESC LIMIT 200").bind(canisterId),
    db.prepare("SELECT total_changes, checked_at FROM canister_history_state WHERE canister_id = ? AND controllers IS NOT NULL").bind(canisterId),
  ]);
  const s = st!.results[0];
  return { rows: rows!.results, total_changes: s?.total_changes ?? null, checked_at: s?.checked_at ?? null };
}

/** Same shape as historyFor, read live from the IC. For canisters that are not in the registry. */
export async function historyLive(host: string, canisterId: string): Promise<CanisterHistory> {
  const info = await canisterInfo(host, canisterId);
  return {
    rows: info.changes.map((ch) => ({ ...ch, controllers: ch.controllers ? JSON.stringify(ch.controllers) : null })).reverse(),
    total_changes: info.totalChanges, checked_at: now(),
  };
}
