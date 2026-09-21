// Life support engine: budget and safety layer, audit log, funded path orchestration, admin helpers.
//
// Safety model in one paragraph: the planner (planner.ts, pure) decides whether and how much. This
// file decides whether spending is ALLOWED, and the database has the last word: spend is reserved in
// one D1 transaction guarded by CHECK constraints, triggers, and a UNIQUE index (see
// migrations/0004_lifesupport.sql) before any ICP moves. Dry run is the default. The live path needs
// ALL of: opts.dryRun === false, env LIFE_SUPPORT_ENABLED === "true", a funding identity secret,
// kill switch off, global cap, 24 h cap, per-top-up max, and the canister budget.
//
// APPEND-ONLY RULE: ls_audit, ls_attempts, and topup_log are only ever INSERTed into. There is no
// UPDATE or DELETE against them anywhere in the codebase, and the migration installs triggers that
// make the database reject both. A correction is a new row, never an edit.
import type { CanisterRow } from "../db/queries";
import type { Env } from "../env";
import { notifyIncident } from "../alerts/notify";
import { DAY, type RunStatus } from "../lib/health";
import { BLACKHOLE_NINEGUA, ICP_LEDGER, NNS_ROOT, balanceOf, blackholeStatus, isCanisterId, nnsRootStatus, probe as icProbe, snsSummary, type StatusReading } from "../lib/ic";
import { createFunder, fetchXdrRate, fundingPrincipal, type Funder, type XdrRate } from "./funding";
import { DEFAULT_PARAMS, E8S, TRILLION, USD_PER_XDR_FALLBACK, monthlyCost, periodKey, planTopUp, verifyTopUp, type MonthlyCost, type Plan, type PlanReading, type PlannerParams } from "./planner";

/** Env fields life support needs. The lead adds these to src/env.ts; until then this intersection keeps the module self-contained. */
export type LifeSupportEnv = Env & {
  /** Must be exactly "true" for the funded path. Anything else means dry run. */
  LIFE_SUPPORT_ENABLED?: string;
  /** Secret: 32 byte Ed25519 seed, 64 hex characters or base64. */
  LIFE_SUPPORT_IDENTITY?: string;
  /** Optional Discord-compatible webhook for owner alerts (anomalies, kill switch). */
  LIFE_SUPPORT_ALERT_WEBHOOK?: string;
};

export interface Settings {
  kill_switch: number; kill_reason: string | null; global_cap_cycles: number; global_spent_cycles: number; daily_cap_cycles: number;
  max_single_topup_cycles: number; max_topups_per_tick: number; max_reading_age_s: number; min_interval_s: number; params: string | null;
  last_xdr_permyriad: number | null; last_xdr_at: number | null; updated_at: number; updated_by: string;
}

interface Enrollment { canister_id: string; what: string; story: string | null; since: number; budget_cycles: number; spent_cycles: number; monthly_cycles: number | null; state: string; adopted_by: string | null }

export interface Deps {
  now(): number;
  /** Certified controller status read through the canister's own measured source, or null when it has none. */
  readStatus(env: LifeSupportEnv, c: CanisterRow): Promise<{ reading: StatusReading; source: string } | null>;
  probe(env: LifeSupportEnv, canisterId: string): Promise<RunStatus | null>;
  fetchRate(env: LifeSupportEnv): Promise<XdrRate>;
  /** Only called after the live gate has passed and spend has been reserved. */
  funder(env: LifeSupportEnv): Funder;
  alert(env: LifeSupportEnv, text: string): Promise<void>;
  newId(): string;
}

export const sourceFor = (c: CanisterRow): "sns-root" | "nns-root" | "blackhole" | null => {
  if (c.sns_root) return "sns-root";
  let controllers: string[] = [];
  try { controllers = JSON.parse(c.controllers ?? "[]") as string[]; } catch { /* none */ }
  if (controllers.includes(NNS_ROOT)) return "nns-root";
  if (controllers.includes(BLACKHOLE_NINEGUA)) return "blackhole";
  return null;
};

export const defaultDeps: Deps = {
  now: () => Math.floor(Date.now() / 1000),
  async readStatus(env, c) {
    const source = sourceFor(c);
    if (source === "sns-root") {
      const hit = (await snsSummary(env.IC_HOST, c.sns_root!)).find((s) => s.canisterId === c.id);
      return hit?.reading ? { reading: hit.reading, source } : null;
    }
    if (source === "nns-root") return { reading: await nnsRootStatus(env.IC_HOST, c.id), source };
    if (source === "blackhole") return { reading: await blackholeStatus(env.IC_HOST, BLACKHOLE_NINEGUA, c.id), source };
    return null;
  },
  async probe(env, canisterId) {
    const r = await icProbe(env.IC_HOST, canisterId);
    return r.runStatus === "unknown" ? null : r.runStatus;
  },
  fetchRate: (env) => fetchXdrRate(env.IC_HOST),
  funder: (env) => createFunder(env.IC_HOST, env.LIFE_SUPPORT_IDENTITY!),
  async alert(env, text) {
    console.error("LIFE SUPPORT ALERT:", text);
    if (!env.LIFE_SUPPORT_ALERT_WEBHOOK) return;
    await fetch(env.LIFE_SUPPORT_ALERT_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `ICPWatch life support: ${text}`.slice(0, 1800) }) });
  },
  newId: () => crypto.randomUUID(),
};

// ---- settings and the live gate --------------------------------------------------------------------------

export async function loadSettings(db: D1Database): Promise<Settings> {
  const s = await db.prepare("SELECT * FROM ls_settings WHERE id = 1").first<Settings>();
  if (!s) throw new Error("ls_settings row missing: apply migrations/0004_lifesupport.sql");
  return s;
}

export function plannerParams(s: Settings): Partial<PlannerParams> {
  let extra: Partial<PlannerParams> = {};
  try { if (s.params) extra = JSON.parse(s.params) as Partial<PlannerParams>; } catch { /* ignore bad json, defaults are the safe side */ }
  return { ...extra, maxReadingAgeS: s.max_reading_age_s, minIntervalS: s.min_interval_s };
}

export interface Gate { live: boolean; reasons: string[] }

/** Every condition must hold. The reasons list says exactly what is still closed. */
export function liveGate(env: LifeSupportEnv, s: Settings, opts: { dryRun?: boolean }): Gate {
  const reasons: string[] = [];
  if (opts.dryRun !== false) reasons.push("dry run requested (the default)");
  if (env.LIFE_SUPPORT_ENABLED !== "true") reasons.push('env LIFE_SUPPORT_ENABLED is not "true"');
  if (!env.LIFE_SUPPORT_IDENTITY) reasons.push("funding identity secret LIFE_SUPPORT_IDENTITY is not set");
  if (s.kill_switch !== 0) reasons.push(`kill switch engaged${s.kill_reason ? `: ${s.kill_reason}` : ""}`);
  if (s.global_spent_cycles >= s.global_cap_cycles) reasons.push("global cap is fully spent");
  return { live: reasons.length === 0, reasons };
}

// ---- audit log (INSERT only) ------------------------------------------------------------------------------

export interface AuditRow {
  id?: number; ts: number; attempt_id: string | null; canister_id: string | null; mode: "dry_run" | "live" | "admin"; stage: string; code: string; ok: number;
  amount_cycles?: number | null; cost_cycles?: number | null; icp_e8s?: number | null; fee_e8s?: number | null; xdr_permyriad?: number | null;
  before_cycles?: number | null; threshold_cycles?: number | null; idle_burn_per_day?: number | null; low_water?: number | null; high_water?: number | null;
  reading_source?: string | null; reading_ts?: number | null; after_cycles?: number | null; after_frozen?: number | null; ledger_block?: number | null;
  minted_cycles?: number | null; plan?: string | null; note?: string | null;
}

const int = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n));

function auditStmt(db: D1Database, r: AuditRow): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO ls_audit (ts, attempt_id, canister_id, mode, stage, code, ok, amount_cycles, cost_cycles, icp_e8s, fee_e8s, xdr_permyriad, before_cycles, threshold_cycles,
       idle_burn_per_day, low_water, high_water, reading_source, reading_ts, after_cycles, after_frozen, ledger_block, minted_cycles, plan, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    r.ts, r.attempt_id, r.canister_id, r.mode, r.stage, r.code, r.ok, int(r.amount_cycles), int(r.cost_cycles), int(r.icp_e8s), int(r.fee_e8s), int(r.xdr_permyriad),
    int(r.before_cycles), int(r.threshold_cycles), int(r.idle_burn_per_day), int(r.low_water), int(r.high_water), r.reading_source ?? null, int(r.reading_ts),
    int(r.after_cycles), r.after_frozen ?? null, int(r.ledger_block), int(r.minted_cycles), r.plan ?? null, r.note?.slice(0, 1500) ?? null,
  );
}

const planAudit = (ts: number, mode: "dry_run" | "live", plan: Plan, reading: PlanReading | null, attemptId: string | null, stage: string): AuditRow => ({
  ts, attempt_id: attemptId, canister_id: plan.canisterId, mode, stage, code: plan.code, ok: plan.action === "topup" ? 1 : 0,
  amount_cycles: plan.action === "topup" ? plan.amountCycles : plan.proposedCycles || null, cost_cycles: plan.costCycles || null, icp_e8s: plan.icpE8s || null, fee_e8s: plan.feeE8s || null,
  xdr_permyriad: plan.xdrPermyriadPerIcp, before_cycles: plan.balanceCycles, threshold_cycles: plan.effectiveThresholdCycles, idle_burn_per_day: plan.idleBurnPerDay,
  low_water: plan.lowWaterCycles, high_water: plan.highWaterCycles, reading_source: reading?.source ?? null, reading_ts: reading?.ts ?? null, plan: JSON.stringify(plan), note: plan.rationale,
});

// ---- kill switch, incidents, alerts -------------------------------------------------------------------------

export async function setKillSwitch(env: LifeSupportEnv, on: boolean, who: string, reason?: string, ts = Math.floor(Date.now() / 1000)): Promise<Settings> {
  const db = env.DB;
  await db.batch([
    db.prepare("UPDATE ls_settings SET kill_switch = ?, kill_reason = ?, updated_at = ?, updated_by = ? WHERE id = 1").bind(on ? 1 : 0, on ? (reason ?? "engaged manually") : null, ts, who),
    auditStmt(db, { ts, attempt_id: null, canister_id: null, mode: "admin", stage: "admin", code: on ? "kill_switch_on" : "kill_switch_off", ok: 1, note: `${who}: ${reason ?? (on ? "engaged" : "released")}` }),
  ]);
  return loadSettings(db);
}

async function raise(env: LifeSupportEnv, deps: Deps, c: CanisterRow, o: { halt: boolean; mode: "dry_run" | "live"; attemptId: string | null; code: string; detail: string }): Promise<void> {
  const ts = deps.now();
  const db = env.DB;
  if (o.halt && (await loadSettings(db)).kill_switch === 0) await setKillSwitch(env, true, "engine", `${o.code} on ${c.id}`, ts);
  await auditStmt(db, { ts, attempt_id: o.attemptId, canister_id: c.id, mode: o.mode, stage: "anomaly", code: o.code, ok: 0, note: `${o.halt ? "KILL SWITCH ENGAGED. " : ""}${o.detail}` }).run();
  const open = await db.prepare("SELECT id FROM incidents WHERE canister_id = ? AND type = 'life_support_anomaly' AND state = 'open' LIMIT 1").bind(c.id).first<{ id: number }>();
  if (open) return; // one incident per canister until a human resolves it
  const title = `Life support anomaly: ${c.label}`;
  const detail = `${o.detail}${o.halt ? " The kill switch was engaged automatically: no further top-ups until an admin releases it." : ""}`;
  const row = await db.prepare("INSERT INTO incidents (canister_id, type, state, severity, title, detail, data, opened_at) VALUES (?, 'life_support_anomaly', 'open', ?, ?, ?, ?, ?) RETURNING id")
    .bind(c.id, o.halt ? "critical" : "warn", title, detail, JSON.stringify({ code: o.code, attempt: o.attemptId, mode: o.mode }), ts).first<{ id: number }>();
  try {
    if (row) await notifyIncident(env, { incidentId: row.id, canister: c, type: "life_support_anomaly", kind: "fired", title, detail, severity: o.halt ? "critical" : "warn" });
    await deps.alert(env, `${title}. ${detail}`);
  } catch (e) {
    console.warn("life support alert failed", String(e).slice(0, 200));
  }
}

// ---- lease ---------------------------------------------------------------------------------------------------

const LEASE_S = 300;

async function acquireLease(db: D1Database, holder: string, ts: number): Promise<boolean> {
  const r = await db.prepare("UPDATE ls_lease SET holder = ?, expires_at = ? WHERE id = 1 AND expires_at < ?").bind(holder, ts + LEASE_S, ts).run();
  return (r.meta.changes ?? 0) === 1;
}
const releaseLease = (db: D1Database, holder: string) => db.prepare("UPDATE ls_lease SET holder = NULL, expires_at = 0 WHERE id = 1 AND holder = ?").bind(holder).run();

// ---- tick ------------------------------------------------------------------------------------------------------

export interface TickStats {
  mode: "dry_run" | "live"; gate: string[]; enrolled: number; planned: number; toppedUp: number; skipped: number; refused: number; anomalies: number; recovered: number;
  spentCycles: number; rate: number | null; decisions: Record<string, string>; errors: number; leaseBusy?: boolean;
}

export interface TickOpts { dryRun?: boolean; deps?: Partial<Deps> }

export async function lifeSupportTick(env: LifeSupportEnv, opts: TickOpts = {}): Promise<TickStats> {
  const deps: Deps = { ...defaultDeps, ...opts.deps };
  const db = env.DB;
  const ts = deps.now();
  let settings = await loadSettings(db);
  const gate = liveGate(env, settings, opts);
  const mode = gate.live ? "live" : "dry_run";
  const stats: TickStats = { mode, gate: gate.reasons, enrolled: 0, planned: 0, toppedUp: 0, skipped: 0, refused: 0, anomalies: 0, recovered: 0, spentCycles: 0, rate: null, decisions: {}, errors: 0 };

  const enrolled = (await db.prepare("SELECT * FROM life_support WHERE state = 'active' ORDER BY since").all<Enrollment>()).results;
  stats.enrolled = enrolled.length;
  if (!enrolled.length) {
    // Nothing to do, but keep the conversion rate fresh so the public registry can price candidates.
    if (settings.last_xdr_at == null || ts - settings.last_xdr_at > 6 * 3600) stats.rate = (await refreshRate(env, deps))?.xdrPermyriadPerIcp ?? null;
    return stats;
  }

  const holder = deps.newId();
  if (gate.live && !(await acquireLease(db, holder, ts))) return { ...stats, leaseBusy: true };
  try {
    // Conversion rate, with a sanity anchor: a rate that moved more than 2x since the last accepted one is refused.
    // (A rate reported at half its true value doubles the mint, which is exactly the worst case the band absorbs.)
    let rate: XdrRate | null = null;
    try {
      const r = await deps.fetchRate(env);
      const anchored = settings.last_xdr_permyriad != null && settings.last_xdr_at != null && ts - settings.last_xdr_at < 7 * DAY;
      if (anchored && (r.xdrPermyriadPerIcp > settings.last_xdr_permyriad! * 2 || r.xdrPermyriadPerIcp < settings.last_xdr_permyriad! / 2)) {
        await auditStmt(db, { ts, attempt_id: null, canister_id: null, mode, stage: "anomaly", code: "rate_jump", ok: 0, xdr_permyriad: r.xdrPermyriadPerIcp, note: `rate ${r.xdrPermyriadPerIcp} vs last accepted ${settings.last_xdr_permyriad}: refusing to use it` }).run();
        stats.anomalies++;
      } else {
        rate = r;
        await db.prepare("UPDATE ls_settings SET last_xdr_permyriad = ?, last_xdr_at = ? WHERE id = 1").bind(r.xdrPermyriadPerIcp, ts).run();
      }
    } catch (e) {
      stats.errors++;
      console.warn("life support: rate fetch failed", String(e).slice(0, 200));
    }
    stats.rate = rate?.xdrPermyriadPerIcp ?? null;
    const usdPerXdr = await usdPerXdrFrom(db, rate?.xdrPermyriadPerIcp ?? null);

    if (gate.live) stats.recovered = await recoverPending(env, deps, stats);

    for (const e of enrolled) {
      try {
        settings = await loadSettings(db); // an anomaly on the previous canister may have engaged the kill switch
        const live = gate.live && settings.kill_switch === 0 && stats.toppedUp < settings.max_topups_per_tick;
        await tickOne(env, deps, settings, e, rate, usdPerXdr.value, live ? "live" : "dry_run", stats);
      } catch (err) {
        stats.errors++;
        console.error("life support: canister failed", e.canister_id, String(err).slice(0, 300));
      }
    }
  } finally {
    if (gate.live) await releaseLease(db, holder);
  }
  return stats;
}

async function gatherInput(env: LifeSupportEnv, deps: Deps, c: CanisterRow, ts: number, requireFresh: boolean): Promise<{ reading: PlanReading | null; note: string | null }> {
  let note: string | null = null;
  try {
    const fresh = await deps.readStatus(env, c);
    if (fresh) {
      let probeStatus: RunStatus | null = null;
      try { probeStatus = await deps.probe(env, c.id); } catch { /* probe is corroboration, not a requirement for reported idle burn */ }
      const r = fresh.reading;
      return { reading: { ts, cycles: r.cycles, source: fresh.source, confidence: "measured", idleBurnPerDay: r.idleBurnPerDay, freezingThresholdS: r.freezingThresholdS, probeStatus }, note };
    }
    note = "no certified controller source for this canister";
  } catch (e) {
    note = `fresh status read failed: ${String(e).slice(0, 200)}`;
  }
  if (requireFresh) return { reading: null, note };
  // Dry run only: fall back to the collector's latest reading so the plan can still be shown. Its age is honored by the planner.
  if (c.cycles == null || c.measured_at == null) return { reading: null, note };
  const st = c.run_status as RunStatus;
  return { reading: { ts: c.measured_at, cycles: c.cycles, source: c.cycles_source ?? "none", confidence: c.confidence, idleBurnPerDay: c.idle_burn_per_day, freezingThresholdS: c.freezing_threshold_s, probeStatus: st === "frozen" || st === "out_of_cycles" ? st : null }, note };
}

/** Idle burn estimated from our own readings, valid only if every reading in the window was taken while frozen. */
async function idleEstimate(db: D1Database, canisterId: string, ts: number): Promise<{ perDay: number; coverageS: number; frozenThroughout: boolean } | null> {
  const rows = (await db.prepare("SELECT ts, cycles, run_status FROM readings WHERE canister_id = ? AND ts > ? AND cycles IS NOT NULL AND confidence = 'measured' ORDER BY ts").bind(canisterId, ts - 14 * DAY).all<{ ts: number; cycles: number; run_status: string | null }>()).results;
  let burned = 0;
  let covered = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (b.cycles > a.cycles) continue; // someone topped it up: exclude the interval
    burned += a.cycles - b.cycles;
    covered += b.ts - a.ts;
  }
  if (covered <= 0 || burned <= 0) return null;
  return { perDay: (burned / covered) * DAY, coverageS: covered, frozenThroughout: rows.every((r) => r.run_status === "frozen" || r.run_status === "out_of_cycles") };
}

async function spentLast24h(db: D1Database, ts: number): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(CASE stage WHEN 'reserve' THEN cost_cycles WHEN 'release' THEN -cost_cycles ELSE 0 END), 0) n FROM ls_audit WHERE mode = 'live' AND ts > ? AND stage IN ('reserve', 'release')").bind(ts - DAY).first<{ n: number }>();
  return Math.max(0, r?.n ?? 0);
}

async function tickOne(env: LifeSupportEnv, deps: Deps, settings: Settings, e: Enrollment, rate: XdrRate | null, usdPerXdr: number, mode: "dry_run" | "live", stats: TickStats): Promise<void> {
  const db = env.DB;
  const ts = deps.now();
  const c = await db.prepare("SELECT * FROM canisters WHERE id = ?").bind(e.canister_id).first<CanisterRow>();
  if (!c) {
    stats.skipped++;
    stats.decisions[e.canister_id] = "not_watched";
    return;
  }

  // An attempt that reserved spend but never reached verify or release is unresolved: money may be in flight.
  const pending = await db.prepare(
    `SELECT r.attempt_id FROM ls_audit r WHERE r.canister_id = ? AND r.mode = 'live' AND r.stage = 'reserve'
       AND NOT EXISTS (SELECT 1 FROM ls_audit x WHERE x.attempt_id = r.attempt_id AND x.stage IN ('verify', 'release')) LIMIT 1`,
  ).bind(c.id).first<{ attempt_id: string }>();
  if (pending) {
    stats.refused++;
    stats.decisions[c.id] = "attempt_unresolved";
    await logDeduped(db, { ts, attempt_id: pending.attempt_id, canister_id: c.id, mode, stage: "plan", code: "attempt_unresolved", ok: 0, note: "An earlier live attempt has no verify or release row. Resolve it by hand (see docs/LIFE_SUPPORT.md) before this canister is funded again." });
    return;
  }

  const { reading, note } = await gatherInput(env, deps, c, ts, mode === "live");
  const params = plannerParams(settings);
  const minGap = params.minPriorGapS ?? DEFAULT_PARAMS.minPriorGapS;
  const prior = await db.prepare("SELECT ts, cycles FROM readings WHERE canister_id = ? AND cycles IS NOT NULL AND confidence = 'measured' AND ts <= ? ORDER BY ts DESC LIMIT 1").bind(c.id, (reading?.ts ?? ts) - minGap).first<{ ts: number; cycles: number }>();
  const last = await db.prepare("SELECT ts, after_cycles FROM ls_audit WHERE canister_id = ? AND mode = 'live' AND stage = 'verify' ORDER BY id DESC LIMIT 1").bind(c.id).first<{ ts: number; after_cycles: number | null }>();
  const estimate = reading && reading.idleBurnPerDay == null ? await idleEstimate(db, c.id, ts) : null;

  const plan = planTopUp({
    now: ts, canisterId: c.id,
    enrollment: { state: e.state, budgetCycles: e.budget_cycles, spentCycles: e.spent_cycles },
    reading, prior: prior ?? null, idleEstimate: estimate, lastTopUp: last ? { ts: last.ts, afterCycles: last.after_cycles } : null,
    rate, usdPerXdr,
    budget: {
      killSwitch: settings.kill_switch !== 0, globalCapCycles: settings.global_cap_cycles, globalSpentCycles: settings.global_spent_cycles,
      dailyCapCycles: settings.daily_cap_cycles, spentLast24hCycles: await spentLast24h(db, ts), maxSingleTopUpCycles: settings.max_single_topup_cycles,
    },
    params,
  });
  if (note && plan.action === "skip") plan.rationale = `${plan.rationale} (${note})`;
  stats.decisions[c.id] = plan.code;
  stats.planned++;

  // Keep the fresh certified reading: it feeds the burn history and the next tick's corroboration.
  if (reading && reading.ts === ts && reading.cycles != null) {
    await db.prepare("INSERT OR IGNORE INTO readings (canister_id, ts, cycles, source, confidence, run_status, memory_bytes) VALUES (?, ?, ?, ?, 'measured', ?, NULL)").bind(c.id, ts, Math.round(reading.cycles), reading.source, reading.probeStatus ?? null).run();
  }
  if (plan.monthly && Math.round(plan.monthly.cycles) !== e.monthly_cycles) {
    await db.prepare("UPDATE life_support SET monthly_cycles = ? WHERE canister_id = ?").bind(Math.round(plan.monthly.cycles), c.id).run();
  }

  if (plan.action === "skip") {
    if (plan.code === "in_band" || plan.code === "kill_switch") stats.skipped++; else stats.refused++;
    await logDeduped(db, planAudit(ts, mode, plan, reading, null, "plan"));
    if (plan.severity !== "none") {
      stats.anomalies++;
      await raise(env, deps, c, { halt: plan.severity === "halt", mode, attemptId: null, code: plan.code, detail: plan.rationale });
    }
    return;
  }
  if (mode === "dry_run") {
    await logDeduped(db, planAudit(ts, mode, plan, reading, null, "plan"));
    return;
  }
  await executeTopUp(env, deps, c, plan, reading!, stats);
}

/** Dry-run plans and refusals repeat every tick. Log one row per canister per decision per day, not one per tick. */
async function logDeduped(db: D1Database, row: AuditRow): Promise<void> {
  const prev = await db.prepare("SELECT ts, code FROM ls_audit WHERE canister_id = ? AND mode = ? AND stage = 'plan' ORDER BY id DESC LIMIT 1").bind(row.canister_id, row.mode).first<{ ts: number; code: string }>();
  if (prev && prev.code === row.code && row.ts - prev.ts < DAY) return;
  await auditStmt(db, row).run();
}

// ---- the funded path ---------------------------------------------------------------------------------------------

async function executeTopUp(env: LifeSupportEnv, deps: Deps, c: CanisterRow, plan: Plan, reading: PlanReading, stats: TickStats): Promise<void> {
  const db = env.DB;
  const ts = deps.now();
  const attemptId = deps.newId();
  const cost = Math.round(plan.costCycles);

  // 1. Reserve. One transaction: idempotency slot, global spend, canister spend, audit row. The database refuses
  //    (and rolls back all four) if the kill switch is on, a cap or budget would be crossed, the canister is not
  //    actively enrolled, or this canister already had an attempt today. No ICP has moved at this point.
  try {
    const res = await db.batch([
      db.prepare("INSERT INTO ls_attempts (attempt_id, canister_id, period_key, ts, cost_cycles) VALUES (?, ?, ?, ?, ?)").bind(attemptId, c.id, periodKey(ts), ts, cost),
      db.prepare("UPDATE ls_settings SET global_spent_cycles = global_spent_cycles + ? WHERE id = 1").bind(cost),
      db.prepare("UPDATE life_support SET spent_cycles = spent_cycles + ? WHERE canister_id = ? AND state = 'active'").bind(cost, c.id),
      auditStmt(db, { ...planAudit(ts, "live", plan, reading, attemptId, "reserve"), code: "reserved" }),
    ]);
    if (res[1]?.meta.changes !== 1 || res[2]?.meta.changes !== 1) throw new Error("reservation did not touch exactly one settings row and one enrollment row");
  } catch (e) {
    stats.refused++;
    stats.decisions[c.id] = "reserve_refused";
    await auditStmt(db, { ...planAudit(ts, "live", plan, reading, attemptId, "plan"), code: "reserve_refused", ok: 0, note: `database refused the reservation: ${String(e).slice(0, 300)}` }).run();
    if (/exactly one/.test(String(e))) await raise(env, deps, c, { halt: true, mode: "live", attemptId, code: "reserve_inconsistent", detail: String(e) });
    return;
  }

  // 2. Transfer ICP to the CMC subaccount of the target canister.
  const funder = deps.funder(env);
  const transfer = await funder.transfer({ canisterId: c.id, e8s: plan.icpE8s, createdAtNs: BigInt(ts) * 1_000_000_000n });
  if (transfer.kind === "failed") {
    // The ledger said no: nothing moved, so the reservation is handed back. The daily attempt slot stays used.
    await db.batch([
      db.prepare("UPDATE ls_settings SET global_spent_cycles = MAX(0, global_spent_cycles - ?) WHERE id = 1").bind(cost),
      db.prepare("UPDATE life_support SET spent_cycles = MAX(0, spent_cycles - ?) WHERE canister_id = ?").bind(cost, c.id),
      auditStmt(db, { ts: deps.now(), attempt_id: attemptId, canister_id: c.id, mode: "live", stage: "transfer", code: "transfer_failed", ok: 0, icp_e8s: plan.icpE8s, note: transfer.reason }),
      auditStmt(db, { ts: deps.now(), attempt_id: attemptId, canister_id: c.id, mode: "live", stage: "release", code: "released", ok: 1, cost_cycles: cost, note: "ledger rejected the transfer, no ICP moved" }),
    ]);
    stats.refused++;
    stats.anomalies++;
    await raise(env, deps, c, { halt: /InsufficientFunds/.test(transfer.reason) ? false : true, mode: "live", attemptId, code: "transfer_failed", detail: `ICP transfer was rejected by the ledger: ${transfer.reason}` });
    return;
  }
  if (transfer.kind === "unknown") {
    await auditStmt(db, { ts: deps.now(), attempt_id: attemptId, canister_id: c.id, mode: "live", stage: "transfer", code: "transfer_unknown", ok: 0, icp_e8s: plan.icpE8s, note: transfer.reason }).run();
    stats.anomalies++;
    await raise(env, deps, c, { halt: true, mode: "live", attemptId, code: "transfer_unknown", detail: `ICP transfer outcome is unknown (${transfer.reason}). The reservation is kept. Check the funding account on the ledger.` });
    return;
  }
  stats.spentCycles += cost;
  await auditStmt(db, { ts: deps.now(), attempt_id: attemptId, canister_id: c.id, mode: "live", stage: "transfer", code: "transferred", ok: 1, icp_e8s: plan.icpE8s, fee_e8s: plan.feeE8s, ledger_block: transfer.blockIndex, xdr_permyriad: plan.xdrPermyriadPerIcp }).run();

  // 3 and 4. Notify the CMC, then verify through the same measured source.
  await notifyAndVerify(env, deps, c, stats, { attemptId, blockIndex: transfer.blockIndex, beforeCycles: plan.balanceCycles!, idle: plan.idleBurnPerDay!, threshold: plan.effectiveThresholdCycles!, expectedMint: plan.amountCycles, cost, startedAt: ts, stage: "notify" });
}

interface Pending { attemptId: string; blockIndex: number; beforeCycles: number; idle: number; threshold: number; expectedMint: number; cost: number; startedAt: number; stage: "notify" | "recover" }

async function notifyAndVerify(env: LifeSupportEnv, deps: Deps, c: CanisterRow, stats: TickStats, p: Pending): Promise<void> {
  const db = env.DB;
  const notify = await deps.funder(env).notify({ canisterId: c.id, blockIndex: p.blockIndex });
  if (notify.kind !== "ok") {
    await auditStmt(db, { ts: deps.now(), attempt_id: p.attemptId, canister_id: c.id, mode: "live", stage: p.stage, code: `notify_${notify.kind}`, ok: 0, ledger_block: p.blockIndex, note: notify.reason }).run();
    stats.anomalies++;
    await raise(env, deps, c, { halt: true, mode: "live", attemptId: p.attemptId, code: `notify_${notify.kind}`, detail: `notify_top_up for ledger block ${p.blockIndex} did not succeed: ${notify.reason}. ${notify.kind === "refunded" ? "The CMC refunded the ICP (minus fees)." : "It is retried automatically for 24 h and anyone can call it by hand."}` });
    return;
  }
  await auditStmt(db, { ts: deps.now(), attempt_id: p.attemptId, canister_id: c.id, mode: "live", stage: p.stage, code: "minted", ok: 1, ledger_block: p.blockIndex, minted_cycles: notify.mintedCycles }).run();

  let after: { reading: StatusReading; source: string } | null = null;
  let probeStatus: RunStatus | null = null;
  let readError: string | null = null;
  try {
    after = await deps.readStatus(env, c);
    probeStatus = await deps.probe(env, c.id).catch(() => null);
  } catch (e) {
    readError = String(e).slice(0, 200);
  }
  const ts = deps.now();
  const v = verifyTopUp({
    beforeCycles: p.beforeCycles, mintedCycles: notify.mintedCycles, elapsedS: ts - p.startedAt, idleBurnPerDay: p.idle, plannedThresholdCycles: p.threshold,
    after: after ? { cycles: after.reading.cycles, idleBurnPerDay: after.reading.idleBurnPerDay, freezingThresholdS: after.reading.freezingThresholdS, probeStatus } : null,
  });
  if (Math.abs(notify.mintedCycles - p.expectedMint) > 0.15 * p.expectedMint) v.problems.push(`minted ${notify.mintedCycles} cycles, planned ${Math.round(p.expectedMint)}: the conversion rate moved`);
  const ok = v.problems.length === 0;
  const note = ok ? `verified: balance rose as expected and the canister is still frozen at ${Math.round(((v.afterCycles ?? 0) / (v.thresholdCycles || 1)) * 100)}% of its threshold` : `${v.problems.join("; ")}${readError ? ` (${readError})` : ""}`;
  const stmts = [
    auditStmt(db, { ts, attempt_id: p.attemptId, canister_id: c.id, mode: "live", stage: "verify", code: ok ? "verified" : "verify_failed", ok: ok ? 1 : 0, cost_cycles: p.cost, before_cycles: p.beforeCycles, after_cycles: v.afterCycles, after_frozen: v.stillFrozen == null ? null : v.stillFrozen ? 1 : 0, threshold_cycles: v.thresholdCycles, minted_cycles: notify.mintedCycles, ledger_block: p.blockIndex, reading_source: after?.source ?? null, reading_ts: ts, note }),
    // Legacy summary table from 0001: one complete row per top-up, written once with final values.
    db.prepare("INSERT INTO topup_log (canister_id, ts, cycles, before_cycles, after_cycles, after_status, tx, ok, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(c.id, ts, Math.round(notify.mintedCycles), Math.round(p.beforeCycles), int(v.afterCycles), v.stillFrozen == null ? "unknown" : v.stillFrozen ? "frozen" : "running", `icp-ledger-block:${p.blockIndex}`, ok ? 1 : 0, note.slice(0, 500)),
  ];
  if (v.afterCycles != null) stmts.push(db.prepare("INSERT OR IGNORE INTO readings (canister_id, ts, cycles, source, confidence, run_status, memory_bytes) VALUES (?, ?, ?, ?, 'measured', ?, NULL)").bind(c.id, ts, Math.round(v.afterCycles), after?.source ?? "none", probeStatus));
  await db.batch(stmts);
  stats.toppedUp++;
  stats.decisions[c.id] = ok ? "topped_up" : "verify_failed";
  if (!ok) {
    stats.anomalies++;
    await raise(env, deps, c, { halt: true, mode: "live", attemptId: p.attemptId, code: "verify_failed", detail: `Post top-up verification failed: ${note}.` });
  }
}

/** A transfer that landed but was never notified (Worker died, CMC busy) is finished here. notify_top_up is idempotent per block. */
async function recoverPending(env: LifeSupportEnv, deps: Deps, stats: TickStats): Promise<number> {
  const db = env.DB;
  const ts = deps.now();
  const rows = (await db.prepare(
    `SELECT t.attempt_id, t.canister_id, t.ledger_block, r.before_cycles, r.idle_burn_per_day, r.threshold_cycles, r.amount_cycles, r.cost_cycles, r.ts
       FROM ls_audit t JOIN ls_audit r ON r.attempt_id = t.attempt_id AND r.stage = 'reserve'
      WHERE t.mode = 'live' AND t.stage = 'transfer' AND t.ok = 1 AND t.ts > ?
        AND NOT EXISTS (SELECT 1 FROM ls_audit x WHERE x.attempt_id = t.attempt_id AND (x.stage = 'verify' OR (x.stage IN ('notify', 'recover') AND x.code IN ('minted', 'notify_refunded'))))
      LIMIT 3`,
  ).bind(ts - DAY).all<{ attempt_id: string; canister_id: string; ledger_block: number; before_cycles: number; idle_burn_per_day: number; threshold_cycles: number; amount_cycles: number; cost_cycles: number; ts: number }>()).results;
  let n = 0;
  for (const r of rows) {
    const c = await db.prepare("SELECT * FROM canisters WHERE id = ?").bind(r.canister_id).first<CanisterRow>();
    if (!c) continue;
    // Verification compares against the pre-top-up balance minus the idle burn since then, so widen nothing: a late mint still has to add up.
    await notifyAndVerify(env, deps, c, stats, { attemptId: r.attempt_id, blockIndex: r.ledger_block, beforeCycles: r.before_cycles, idle: r.idle_burn_per_day, threshold: r.threshold_cycles, expectedMint: r.amount_cycles, cost: r.cost_cycles, startedAt: r.ts, stage: "recover" });
    n++;
  }
  return n;
}

// ---- admin helpers ----------------------------------------------------------------------------------------------------

export async function enroll(env: LifeSupportEnv, a: { canisterId: string; what: string; story?: string | null; budgetCycles: number; who?: string }): Promise<{ ok: boolean; error?: string }> {
  const db = env.DB;
  const ts = Math.floor(Date.now() / 1000);
  if (!isCanisterId(a.canisterId)) return { ok: false, error: "not a canister id" };
  if (!a.what?.trim()) return { ok: false, error: "what is required: say what this canister was" };
  if (!Number.isSafeInteger(a.budgetCycles) || a.budgetCycles <= 0) return { ok: false, error: "budgetCycles must be a positive integer" };
  const c = await db.prepare("SELECT id FROM canisters WHERE id = ?").bind(a.canisterId).first<{ id: string }>();
  if (!c) return { ok: false, error: "canister is not watched by Lifeline yet: add it first so it has certified readings" };
  const existing = await db.prepare("SELECT spent_cycles FROM life_support WHERE canister_id = ?").bind(a.canisterId).first<{ spent_cycles: number }>();
  if (existing && a.budgetCycles < existing.spent_cycles) return { ok: false, error: "budget cannot be set below what was already spent" };
  await db.batch([
    db.prepare(
      `INSERT INTO life_support (canister_id, what, story, since, budget_cycles, state) VALUES (?, ?, ?, ?, ?, 'active')
       ON CONFLICT (canister_id) DO UPDATE SET what = excluded.what, story = excluded.story, budget_cycles = excluded.budget_cycles, state = 'active', adopted_by = NULL`,
    ).bind(a.canisterId, a.what.trim(), a.story?.trim() || null, ts, a.budgetCycles),
    db.prepare("UPDATE canisters SET life_support = 1 WHERE id = ?").bind(a.canisterId),
    auditStmt(db, { ts, attempt_id: null, canister_id: a.canisterId, mode: "admin", stage: "admin", code: existing ? "enrollment_updated" : "enrolled", ok: 1, amount_cycles: a.budgetCycles, note: `${a.who ?? "admin"}: budget ${a.budgetCycles} cycles. ${a.what.trim()}` }),
  ]);
  return { ok: true };
}

export async function setEnrollmentState(env: LifeSupportEnv, a: { canisterId: string; state: "active" | "paused" | "adopted"; adoptedBy?: string | null; who?: string }): Promise<{ ok: boolean; error?: string }> {
  const db = env.DB;
  const ts = Math.floor(Date.now() / 1000);
  if (!["active", "paused", "adopted"].includes(a.state)) return { ok: false, error: "state must be active, paused, or adopted" };
  const row = await db.prepare("SELECT canister_id FROM life_support WHERE canister_id = ?").bind(a.canisterId).first();
  if (!row) return { ok: false, error: "not enrolled" };
  await db.batch([
    db.prepare("UPDATE life_support SET state = ?, adopted_by = ? WHERE canister_id = ?").bind(a.state, a.state === "adopted" ? (a.adoptedBy ?? null) : null, a.canisterId),
    db.prepare("UPDATE canisters SET life_support = ? WHERE id = ?").bind(a.state === "active" ? 1 : 0, a.canisterId),
    auditStmt(db, { ts, attempt_id: null, canister_id: a.canisterId, mode: "admin", stage: "admin", code: `state_${a.state}`, ok: 1, note: `${a.who ?? "admin"}${a.adoptedBy ? `: adopted by ${a.adoptedBy}` : ""}` }),
  ]);
  return { ok: true };
}

export interface Caps { globalCapCycles?: number; dailyCapCycles?: number; maxSingleTopUpCycles?: number; maxTopUpsPerTick?: number; maxReadingAgeS?: number; minIntervalS?: number; params?: Partial<PlannerParams> | null }

export async function setCaps(env: LifeSupportEnv, caps: Caps, who: string): Promise<{ ok: boolean; error?: string; settings?: Settings }> {
  const db = env.DB;
  const ts = Math.floor(Date.now() / 1000);
  const s = await loadSettings(db);
  const nonNeg = (n: number | undefined) => n === undefined || (Number.isSafeInteger(n) && n >= 0);
  if (![caps.globalCapCycles, caps.dailyCapCycles, caps.maxSingleTopUpCycles, caps.maxTopUpsPerTick, caps.maxReadingAgeS, caps.minIntervalS].every(nonNeg)) return { ok: false, error: "caps must be non-negative integers" };
  if (caps.globalCapCycles !== undefined && caps.globalCapCycles < s.global_spent_cycles) return { ok: false, error: `global cap cannot go below what is already spent (${s.global_spent_cycles}). Use the kill switch to stop spending.` };
  if (caps.maxReadingAgeS !== undefined && caps.maxReadingAgeS > 6 * 3600) return { ok: false, error: "maxReadingAgeS above 6 h defeats the freshness rule" };
  if (caps.params?.safetyFraction !== undefined && !(caps.params.safetyFraction > 0 && caps.params.safetyFraction <= 0.45)) return { ok: false, error: "safetyFraction must be in (0, 0.45]: above that a duplicated top-up could unfreeze a canister" };
  if (caps.params?.estimatedSafetyFraction !== undefined && !(caps.params.estimatedSafetyFraction > 0 && caps.params.estimatedSafetyFraction <= 0.3)) return { ok: false, error: "estimatedSafetyFraction must be in (0, 0.3]" };
  await db.batch([
    db.prepare(
      `UPDATE ls_settings SET global_cap_cycles = ?, daily_cap_cycles = ?, max_single_topup_cycles = ?, max_topups_per_tick = ?, max_reading_age_s = ?, min_interval_s = ?, params = ?, updated_at = ?, updated_by = ? WHERE id = 1`,
    ).bind(
      caps.globalCapCycles ?? s.global_cap_cycles, caps.dailyCapCycles ?? s.daily_cap_cycles, caps.maxSingleTopUpCycles ?? s.max_single_topup_cycles, caps.maxTopUpsPerTick ?? s.max_topups_per_tick,
      caps.maxReadingAgeS ?? s.max_reading_age_s, caps.minIntervalS ?? s.min_interval_s, caps.params === undefined ? s.params : caps.params === null ? null : JSON.stringify(caps.params), ts, who,
    ),
    auditStmt(db, { ts, attempt_id: null, canister_id: null, mode: "admin", stage: "admin", code: "caps_changed", ok: 1, note: `${who}: ${JSON.stringify(caps)}` }),
  ]);
  return { ok: true, settings: await loadSettings(db) };
}

export interface StatusReport {
  gate: Gate; enabledEnv: boolean; identityPresent: boolean; killSwitch: boolean; killReason: string | null;
  caps: { globalCapCycles: number; globalSpentCycles: number; globalRemainingCycles: number; dailyCapCycles: number; spentLast24hCycles: number; maxSingleTopUpCycles: number; maxTopUpsPerTick: number };
  enrolled: { active: number; paused: number; adopted: number; budgetCycles: number; spentCycles: number };
  funding: { principal: string | null; icpE8s: string | null; icp: number | null; error: string | null; note: string };
  rate: { xdrPermyriadPerIcp: number; ts: number } | null;
  updatedAt: number; updatedBy: string;
}

/** Everything the owner needs to decide what to fund. Read-only: one ledger balance query and one CMC rate query. */
export async function status(env: LifeSupportEnv, deps: Partial<Pick<Deps, "fetchRate" | "now">> & { balanceOf?: (principal: string) => Promise<bigint> } = {}): Promise<StatusReport> {
  const db = env.DB;
  const ts = (deps.now ?? defaultDeps.now)();
  const s = await loadSettings(db);
  const en = (await db.prepare("SELECT state, COUNT(*) n, COALESCE(SUM(budget_cycles), 0) b, COALESCE(SUM(spent_cycles), 0) sp FROM life_support GROUP BY state").all<{ state: string; n: number; b: number; sp: number }>()).results;
  const count = (st: string) => en.find((x) => x.state === st)?.n ?? 0;
  let principal: string | null = null;
  let icpE8s: string | null = null;
  let error: string | null = null;
  if (env.LIFE_SUPPORT_IDENTITY) {
    try {
      principal = fundingPrincipal(env.LIFE_SUPPORT_IDENTITY);
      icpE8s = String(await (deps.balanceOf ?? ((p: string) => balanceOf(env.IC_HOST, ICP_LEDGER, p)))(principal));
    } catch (e) {
      error = String(e).slice(0, 200);
    }
  }
  let rate: XdrRate | null = null;
  try { rate = await (deps.fetchRate ?? defaultDeps.fetchRate)(env); } catch { rate = s.last_xdr_permyriad && s.last_xdr_at ? { xdrPermyriadPerIcp: s.last_xdr_permyriad, ts: s.last_xdr_at } : null; }
  return {
    gate: liveGate(env, s, { dryRun: false }), enabledEnv: env.LIFE_SUPPORT_ENABLED === "true", identityPresent: !!env.LIFE_SUPPORT_IDENTITY,
    killSwitch: s.kill_switch !== 0, killReason: s.kill_reason,
    caps: { globalCapCycles: s.global_cap_cycles, globalSpentCycles: s.global_spent_cycles, globalRemainingCycles: s.global_cap_cycles - s.global_spent_cycles, dailyCapCycles: s.daily_cap_cycles, spentLast24hCycles: await spentLast24h(db, ts), maxSingleTopUpCycles: s.max_single_topup_cycles, maxTopUpsPerTick: s.max_topups_per_tick },
    enrolled: { active: count("active"), paused: count("paused"), adopted: count("adopted"), budgetCycles: en.reduce((a, x) => a + x.b, 0), spentCycles: en.reduce((a, x) => a + x.sp, 0) },
    funding: { principal, icpE8s, icp: icpE8s != null ? Number(icpE8s) / E8S : null, error, note: "Fund the default account of this principal with ICP (ICRC-1 transfer to the principal, or `dfx ledger account-id --of-principal <principal>` for exchanges)." },
    rate, updatedAt: s.updated_at, updatedBy: s.updated_by,
  };
}

// ---- public registry data ---------------------------------------------------------------------------------------------------

export interface CostView { cycles: number; icp: number | null; usd: number | null; topUpsPerMonth: number }
export interface PreservedItem {
  canisterId: string; label: string | null; what: string; story: string | null; since: number; state: string; adoptedBy: string | null;
  cycles: number | null; thresholdCycles: number | null; runwayDays: number | null; monthly: CostView | null; budgetCycles: number; spentCycles: number; remainingCycles: number;
  remainingMonths: number | null; topUps: number; lastTopUpAt: number | null;
}
export interface Candidate {
  canisterId: string; label: string; tokenSymbol: string | null; cycles: number | null; deleteAt: number | null; idleBurnPerDay: number | null; freezingThresholdS: number | null;
  monthly: CostView | null; yearlyUsd: number | null; fundable: boolean; why: string | null;
}
export interface RegistryData {
  active: boolean; killSwitch: boolean; xdrPermyriadPerIcp: number | null; rateAt: number | null; usdPerXdr: number; usdSource: "icp-price" | "fallback";
  preserved: PreservedItem[]; candidates: Candidate[];
  totals: { monthlyCycles: number; monthlyUsd: number; spentCycles: number; globalCapCycles: number; globalSpentCycles: number; candidateMonthlyUsd: number };
  audit: AuditRow[];
}

/** USD per XDR derived from our own ICP/USD price and the CMC ICP/XDR rate, with a labeled fallback. */
async function usdPerXdrFrom(db: D1Database, xdrPermyriadPerIcp: number | null): Promise<{ value: number; source: "icp-price" | "fallback" }> {
  try {
    const m = await db.prepare("SELECT price_usd FROM market WHERE token_id = ?").bind(ICP_LEDGER).first<{ price_usd: number | null }>();
    if (m?.price_usd && xdrPermyriadPerIcp) {
      const v = m.price_usd / (xdrPermyriadPerIcp / 1e4);
      if (v > 0.8 && v < 2.5) return { value: v, source: "icp-price" }; // XDR has lived between 1.2 and 1.6 USD for decades
    }
  } catch { /* markets not populated */ }
  return { value: USD_PER_XDR_FALLBACK, source: "fallback" };
}

const view = (m: MonthlyCost | null): CostView | null => (m ? { cycles: m.cycles, icp: m.icp, usd: m.usd, topUpsPerMonth: m.topUpsPerMonth } : null);

/** Data for the public "On Life Support" page. No network calls: it uses the last rate the tick accepted. */
export async function registry(env: LifeSupportEnv, opts: { auditLimit?: number; candidateLimit?: number } = {}): Promise<RegistryData> {
  const db = env.DB;
  const s = await loadSettings(db);
  const rate = s.last_xdr_permyriad;
  const usd = await usdPerXdrFrom(db, rate);
  const params = plannerParams(s);

  const rows = (await db.prepare(
    `SELECT l.*, c.label, c.cycles, c.idle_burn_per_day, c.freezing_threshold_s, c.cycles_source,
            (SELECT COUNT(*) FROM ls_audit a WHERE a.canister_id = l.canister_id AND a.mode = 'live' AND a.stage = 'verify') topups,
            (SELECT MAX(ts) FROM ls_audit a WHERE a.canister_id = l.canister_id AND a.mode = 'live' AND a.stage = 'verify') last_topup
       FROM life_support l LEFT JOIN canisters c ON c.id = l.canister_id ORDER BY l.since`,
  ).all<Enrollment & { label: string | null; cycles: number | null; idle_burn_per_day: number | null; freezing_threshold_s: number | null; cycles_source: string | null; topups: number; last_topup: number | null }>()).results;
  const preserved: PreservedItem[] = rows.map((r) => {
    const m = r.idle_burn_per_day && r.freezing_threshold_s ? monthlyCost(r.idle_burn_per_day, r.freezing_threshold_s, rate, usd.value, params) : null;
    const remaining = r.budget_cycles - r.spent_cycles;
    return {
      canisterId: r.canister_id, label: r.label, what: r.what, story: r.story, since: r.since, state: r.state, adoptedBy: r.adopted_by, cycles: r.cycles,
      thresholdCycles: r.idle_burn_per_day && r.freezing_threshold_s ? (r.idle_burn_per_day * r.freezing_threshold_s) / DAY : null,
      runwayDays: r.cycles != null && r.idle_burn_per_day ? r.cycles / r.idle_burn_per_day : null,
      monthly: view(m) ?? (r.monthly_cycles != null ? { cycles: r.monthly_cycles, icp: rate ? r.monthly_cycles / rate / E8S : null, usd: (r.monthly_cycles / TRILLION) * usd.value, topUpsPerMonth: 0 } : null),
      budgetCycles: r.budget_cycles, spentCycles: r.spent_cycles, remainingCycles: remaining, remainingMonths: m && m.cycles > 0 ? remaining / m.cycles : null, topUps: r.topups, lastTopUpAt: r.last_topup,
    };
  });

  const frozen = (await db.prepare(
    `SELECT c.id, c.label, c.cycles, c.delete_at, c.idle_burn_per_day, c.freezing_threshold_s, c.cycles_source, c.confidence, c.sns_root, c.controllers, t.symbol token_symbol
       FROM canisters c LEFT JOIN tokens t ON t.id = c.token_id
      WHERE c.health = 'frozen' AND c.id NOT IN (SELECT canister_id FROM life_support WHERE state = 'active')
      ORDER BY (c.delete_at IS NULL), c.delete_at LIMIT ?`,
  ).bind(opts.candidateLimit ?? 50).all<{ id: string; label: string; cycles: number | null; delete_at: number | null; idle_burn_per_day: number | null; freezing_threshold_s: number | null; cycles_source: string | null; confidence: string; sns_root: string | null; controllers: string | null; token_symbol: string | null }>()).results;
  const candidates: Candidate[] = frozen.map((c) => {
    const m = c.idle_burn_per_day && c.freezing_threshold_s ? monthlyCost(c.idle_burn_per_day, c.freezing_threshold_s, rate, usd.value, params) : null;
    const source = sourceFor(c as unknown as CanisterRow);
    const why = !source ? "no certified balance source: nobody outside its controllers can read its balance, so a safe top-up cannot be computed" : !m ? (c.idle_burn_per_day === 0 ? "idle burn is zero: it costs nothing to keep" : "this source reports no idle burn: cost needs a few days of our own frozen-burn history") : null;
    return { canisterId: c.id, label: c.label, tokenSymbol: c.token_symbol, cycles: c.cycles, deleteAt: c.delete_at, idleBurnPerDay: c.idle_burn_per_day, freezingThresholdS: c.freezing_threshold_s, monthly: view(m), yearlyUsd: m?.usd != null ? m.usd * 12 : null, fundable: !!source && !!m, why };
  });

  const audit = (await db.prepare("SELECT * FROM ls_audit WHERE stage IN ('verify', 'reserve', 'release', 'anomaly', 'admin') OR (stage = 'plan' AND mode = 'live') ORDER BY id DESC LIMIT ?").bind(opts.auditLimit ?? 50).all<AuditRow>()).results;
  const act = preserved.filter((p) => p.state === "active");
  return {
    active: s.kill_switch === 0 && env.LIFE_SUPPORT_ENABLED === "true", killSwitch: s.kill_switch !== 0, xdrPermyriadPerIcp: rate, rateAt: s.last_xdr_at, usdPerXdr: usd.value, usdSource: usd.source,
    preserved, candidates,
    totals: {
      monthlyCycles: act.reduce((a, p) => a + (p.monthly?.cycles ?? 0), 0), monthlyUsd: act.reduce((a, p) => a + (p.monthly?.usd ?? 0), 0), spentCycles: preserved.reduce((a, p) => a + p.spentCycles, 0),
      globalCapCycles: s.global_cap_cycles, globalSpentCycles: s.global_spent_cycles, candidateMonthlyUsd: candidates.reduce((a, c) => a + (c.monthly?.usd ?? 0), 0),
    },
    audit,
  };
}

/** Rate refresh for the registry when no canister is enrolled yet (the tick returns early then). Read-only query. */
export async function refreshRate(env: LifeSupportEnv, deps: Partial<Pick<Deps, "fetchRate" | "now">> = {}): Promise<XdrRate | null> {
  try {
    const r = await (deps.fetchRate ?? defaultDeps.fetchRate)(env);
    await env.DB.prepare("UPDATE ls_settings SET last_xdr_permyriad = ?, last_xdr_at = ? WHERE id = 1").bind(r.xdrPermyriadPerIcp, (deps.now ?? defaultDeps.now)()).run();
    return r;
  } catch {
    return null;
  }
}
