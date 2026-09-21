// Lifeline collector. Runs every 10 minutes.
//
// Every tick: HTTP metrics for every ledger, index, and archive that serves them (cheap, no CPU).
// Sharded across the hour: certified controller status reads (SNS root, NNS root, blackhole) and
// liveness probes for everything whose balance cannot be read.
// Then: burn rates, projections, health, incidents, notifications.
import type { CanisterRow } from "../db/queries";
import { now } from "../lib/format";
import {
  baseline as mkBaseline, burnRate, classify, conditions, project, step, ALERT_TYPES, DAY,
  type AlertType, type Baseline, type Confidence, type OpenIncident, type RunStatus, type Sample,
} from "../lib/health";
import { BLACKHOLE_NINEGUA, NNS_ROOT, blackholeStatus, metricsCycles, nnsRootStatus, pool, probe, probeQuery, snsSummary, type StatusReading } from "../lib/ic";
import { notifyIncident } from "../alerts/notify";
import type { Env } from "../env";

interface Reading {
  canisterId: string;
  cycles: number | null;
  source: string;
  confidence: Confidence;
  runStatus: RunStatus | null;
  memoryBytes: number | null;
  idleBurnPerDay?: number | null;
  freezingThresholdS?: number | null;
  controllers?: string[] | null;
  moduleHash?: string | null;
  probed?: boolean;
}

const SHARDS = 6; // one shard per 10 minute tick, so every controller source is read hourly

const shardOf = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % SHARDS;
};

const fromStatus = (s: StatusReading, source: string): Reading => ({
  canisterId: s.canisterId, cycles: s.cycles, source, confidence: "measured", runStatus: s.runStatus, memoryBytes: s.memoryBytes,
  idleBurnPerDay: s.idleBurnPerDay, freezingThresholdS: s.freezingThresholdS, controllers: s.controllers, moduleHash: s.moduleHash,
});

const probeMethod: Record<string, string> = { ledger: "icrc1_symbol", index: "ledger_id", archive: "remaining_capacity" };

export interface LifelineStats { canisters: number; metrics: number; controller: number; probes: number; readings: number; opened: number; resolved: number; errors: number }

export async function collectLifeline(env: Env, opts: { full?: boolean } = {}): Promise<LifelineStats> {
  const ts = now();
  const host = env.IC_HOST;
  const tick = Math.floor(ts / 600) % SHARDS;
  const stats: LifelineStats = { canisters: 0, metrics: 0, controller: 0, probes: 0, readings: 0, opened: 0, resolved: 0, errors: 0 };

  const canisters = (await env.DB.prepare("SELECT * FROM canisters").all<CanisterRow>()).results;
  stats.canisters = canisters.length;
  if (!canisters.length) return stats;
  const byId = new Map(canisters.map((c) => [c.id, c]));
  const readings = new Map<string, Reading>();
  const inShard = (id: string) => opts.full || shardOf(id) === tick;
  // Controllers report status "running" even for a frozen canister (verified on the iDoge ledger),
  // so a frozen or stopped verdict from a probe always survives a later controller read.
  const put = (r: Reading) => {
    const prev = readings.get(r.canisterId);
    if (prev?.probed && prev.runStatus && prev.runStatus !== "running" && r.runStatus === "running") r.runStatus = prev.runStatus;
    readings.set(r.canisterId, r);
  };

  // 1. Metrics endpoints. A canister is tried if metrics worked before or has never been tried.
  const metricTargets = canisters.filter((c) => ["ledger", "index", "archive"].includes(c.role) && (c.source_hint === "metrics" || c.source_hint == null || inShard(c.id)) && c.health !== "gone");
  const metricResults = await pool(metricTargets, 6, (c) => metricsCycles(host, c.id));
  metricResults.forEach((r, i) => {
    const c = metricTargets[i]!;
    if (r.status !== "fulfilled") return;
    if (r.value.kind === "ok") {
      readings.set(c.id, { canisterId: c.id, cycles: r.value.reading.cycles, source: "metrics", confidence: "measured", runStatus: "running", memoryBytes: r.value.reading.memoryBytes });
      stats.metrics++;
    } else if (r.value.kind === "down") {
      // The metrics query is itself a liveness probe: frozen canisters reject it with IC0207.
      readings.set(c.id, { canisterId: c.id, cycles: null, source: "probe", confidence: "inferred", runStatus: r.value.runStatus, memoryBytes: null, probed: true });
      stats.probes++;
    }
  });

  // 2. Certified controller reads, one shard per tick.
  const snsRoots = [...new Set(canisters.map((c) => c.sns_root).filter((r): r is string => !!r))].filter(inShard);
  const snsResults = await pool(snsRoots, 5, (root) => snsSummary(host, root));
  snsResults.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      stats.errors++;
      console.warn("sns summary failed", snsRoots[i], String(r.reason).slice(0, 200));
      return;
    }
    for (const s of r.value) {
      if (!s.reading || !byId.has(s.canisterId)) continue;
      // Controller status carries threshold, idle burn, and hash, so it wins over metrics.
      put(fromStatus(s.reading, "sns-root"));
      stats.controller++;
    }
  });

  const hasController = (c: CanisterRow, p: string) => {
    try {
      return (JSON.parse(c.controllers ?? "[]") as string[]).includes(p);
    } catch {
      return false;
    }
  };
  const nnsTargets = canisters.filter((c) => !c.sns_root && inShard(c.id) && (c.source_hint === "nns-root" || hasController(c, NNS_ROOT)));
  const nnsResults = await pool(nnsTargets, 5, (c) => nnsRootStatus(host, c.id));
  nnsResults.forEach((r, i) => {
    if (r.status === "fulfilled") {
      put(fromStatus(r.value, "nns-root"));
      stats.controller++;
    } else stats.errors++;
  });

  const bhTargets = canisters.filter((c) => !c.sns_root && inShard(c.id) && readings.get(c.id)?.cycles == null && hasController(c, BLACKHOLE_NINEGUA));
  const bhResults = await pool(bhTargets, 5, (c) => blackholeStatus(host, BLACKHOLE_NINEGUA, c.id));
  bhResults.forEach((r, i) => {
    if (r.status === "fulfilled") {
      put(fromStatus(r.value, "blackhole"));
      stats.controller++;
    } else stats.errors++;
  });
  // The blackhole returns no idle burn, so freezing cannot be derived from the balance, and it says
  // "running" for frozen canisters. Custom ledgers without http_request also slip past the metrics
  // probe (method-not-found looks the same frozen or not). So: probe a method that exists.
  const bhProbes = await pool(bhTargets, 5, (c) => (probeMethod[c.role] ? probeQuery(host, c.id, probeMethod[c.role]!) : probe(host, c.id)));
  bhProbes.forEach((r, i) => {
    const reading = readings.get(bhTargets[i]!.id);
    if (r.status === "fulfilled" && reading && r.value.runStatus !== "running" && r.value.runStatus !== "unknown") reading.runStatus = r.value.runStatus;
  });

  // 3. Probes for everything in this shard that produced no balance. Ledger-family canisters get a
  // free query probe; anything else gets the universal update-call probe.
  const probeTargets = canisters.filter((c) => inShard(c.id) && !readings.has(c.id) && c.health !== "gone");
  const probeResults = await pool(probeTargets, 6, (c) => (probeMethod[c.role] ? probeQuery(host, c.id, probeMethod[c.role]!) : probe(host, c.id)));
  probeResults.forEach((r, i) => {
    const c = probeTargets[i]!;
    if (r.status !== "fulfilled" || r.value.runStatus === "unknown") return;
    readings.set(c.id, { canisterId: c.id, cycles: null, source: "probe", confidence: "inferred", runStatus: r.value.runStatus, memoryBytes: null, probed: true });
    stats.probes++;
  });
  // A metrics read that failed for a canister that used to serve metrics may mean it froze: probe it now.
  const lostMetrics = metricTargets.filter((c) => c.source_hint === "metrics" && !readings.has(c.id));
  const lostResults = await pool(lostMetrics, 6, (c) => probeQuery(host, c.id, probeMethod[c.role] ?? "icrc1_symbol"));
  lostResults.forEach((r, i) => {
    const c = lostMetrics[i]!;
    if (r.status !== "fulfilled" || r.value.runStatus === "unknown" || r.value.runStatus === "running") return;
    readings.set(c.id, { canisterId: c.id, cycles: null, source: "probe", confidence: "inferred", runStatus: r.value.runStatus, memoryBytes: null, probed: true });
    stats.probes++;
  });

  if (!readings.size) return stats;
  stats.readings = readings.size;

  // 4. Persist raw readings.
  const stmts: D1PreparedStatement[] = [];
  const insReading = env.DB.prepare("INSERT OR REPLACE INTO readings (canister_id, ts, cycles, source, confidence, run_status, memory_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const r of readings.values()) stmts.push(insReading.bind(r.canisterId, ts, r.cycles, r.source, r.confidence, r.runStatus, r.memoryBytes));
  await batchAll(env.DB, stmts);

  // 5. Burn rates from our own history (last 24h and last 6h), for canisters with a balance.
  const measuredIds = [...readings.values()].filter((r) => r.cycles != null).map((r) => r.canisterId);
  const history = new Map<string, Sample[]>();
  for (let i = 0; i < measuredIds.length; i += 80) {
    const chunk = measuredIds.slice(i, i + 80);
    const rows = (
      await env.DB.prepare(`SELECT canister_id, ts, cycles FROM readings WHERE ts > ? AND cycles IS NOT NULL AND canister_id IN (${chunk.map(() => "?").join(",")}) ORDER BY canister_id, ts`)
        .bind(ts - DAY - 900, ...chunk)
        .all<{ canister_id: string; ts: number; cycles: number }>()
    ).results;
    for (const row of rows) {
      let arr = history.get(row.canister_id);
      if (!arr) history.set(row.canister_id, (arr = []));
      arr.push({ ts: row.ts, cycles: row.cycles });
    }
  }

  // 6. Open incidents, for the state machine.
  const openRows = (await env.DB.prepare("SELECT id, canister_id, type, clear_streak FROM incidents WHERE state = 'open' AND simulated = 0").all<{ id: number; canister_id: string; type: AlertType; clear_streak: number }>()).results;
  const openBy = new Map<string, OpenIncident>();
  for (const o of openRows) openBy.set(`${o.canister_id}:${o.type}`, { id: o.id, type: o.type, clearStreak: o.clear_streak });

  // 7. Derive, classify, evaluate.
  const updates: D1PreparedStatement[] = [];
  const toNotify: { incidentId: number | null; canister: CanisterRow; type: AlertType; kind: "fired" | "resolved"; title: string; detail: string; severity: string; openedAt: number; pendingInsert?: D1PreparedStatement }[] = [];
  const updCanister = env.DB.prepare(`UPDATE canisters SET
      cycles = ?, cycles_source = ?, confidence = ?, run_status = ?, freezing_threshold_s = ?, idle_burn_per_day = ?, memory_bytes = ?,
      burn_per_day = ?, burn_source = ?, freeze_at = ?, delete_at = ?, health = ?, measured_at = ?, probed_at = ?, source_hint = ?,
      controllers = COALESCE(?, controllers), module_hash = COALESCE(?, module_hash)
    WHERE id = ?`);
  const insChange = env.DB.prepare("INSERT INTO canister_changes (canister_id, ts, field, old_value, new_value) VALUES (?, ?, ?, ?, ?)");

  for (const r of readings.values()) {
    const c = byId.get(r.canisterId)!;
    const samples = history.get(c.id) ?? [];
    const observed = r.cycles != null ? burnRate(samples, ts - DAY, ts + 1) : null;
    const recent = r.cycles != null ? burnRate(samples, ts - 6 * 3600, ts + 1) : null;

    // A probe-only tick must not erase a balance measured earlier this hour by a controller read.
    const keepOld = r.cycles == null && c.cycles != null && c.measured_at != null && ts - c.measured_at < 2 * 3600 && r.runStatus === "running";
    const cycles = keepOld ? c.cycles : r.cycles;
    const confidence: Confidence = keepOld ? (c.confidence as Confidence) : r.confidence;
    const cyclesSource = keepOld ? c.cycles_source : r.cycles != null ? r.source : r.probed ? "probe" : c.cycles_source;
    const idle = r.idleBurnPerDay !== undefined ? r.idleBurnPerDay : c.idle_burn_per_day;
    const threshold = r.freezingThresholdS !== undefined ? r.freezingThresholdS : c.freezing_threshold_s;
    let runStatus: RunStatus = r.runStatus ?? (c.run_status as RunStatus);
    // Balance at or under the freezing threshold means frozen, whatever the controller's status field says.
    if (runStatus === "running" && cycles != null && idle != null && idle > 0 && threshold != null && cycles <= (idle * threshold) / DAY) runStatus = "frozen";

    const facts = { cycles, runStatus, freezingThresholdS: threshold, idleBurnPerDay: idle, observedBurnPerDay: observed ?? (keepOld ? c.burn_per_day : null), lifeSupport: !!c.life_support };
    const p = project(facts);
    const health = classify(facts, p);
    // Projections built on assumed thresholds are inferred even when the balance itself is measured.
    const freezeAt = p.secondsToFreeze != null && isFinite(p.secondsToFreeze) && p.secondsToFreeze < 50 * 365 * DAY ? Math.round(ts + p.secondsToFreeze) : null;
    const deleteAt = p.secondsToDeletion != null && isFinite(p.secondsToDeletion) && p.secondsToDeletion < 50 * 365 * DAY ? Math.round(ts + p.secondsToDeletion) : null;

    updates.push(
      updCanister.bind(
        cycles, cyclesSource, confidence, runStatus, threshold, idle, r.memoryBytes ?? c.memory_bytes,
        p.burnPerDay != null ? Math.round(p.burnPerDay) : null, p.burnSource, freezeAt, deleteAt, health,
        r.cycles != null ? ts : c.measured_at, ts, r.cycles != null ? r.source : (c.source_hint ?? (r.probed ? "probe" : null)),
        r.controllers ? JSON.stringify(r.controllers) : null, r.moduleHash ?? null, c.id,
      ),
    );

    if (r.moduleHash && c.module_hash && r.moduleHash !== c.module_hash) updates.push(insChange.bind(c.id, ts, "module_hash", c.module_hash, r.moduleHash));
    if (r.controllers && c.controllers) {
      const next = JSON.stringify([...r.controllers].sort());
      let prev = c.controllers;
      try { prev = JSON.stringify((JSON.parse(c.controllers) as string[]).sort()); } catch { /* keep raw */ }
      if (next !== prev) updates.push(insChange.bind(c.id, ts, "controllers", prev, next));
    }

    // Alerts. The baseline is the canister's own history, maintained by the nightly rollup.
    const base: Baseline | null = c.burn_baseline != null && c.baseline_days != null && c.baseline_days >= 3 ? { median: c.burn_baseline, mad: c.burn_mad ?? 0, days: c.baseline_days } : null;
    const conds = conditions({ ...facts, label: c.label, role: c.role, recentBurnPerDay: recent, baseline: base }, p);
    for (const type of ALERT_TYPES) {
      // Without a balance we can only reason about frozen state.
      if (cycles == null && type !== "frozen") continue;
      const open = openBy.get(`${c.id}:${type}`);
      const action = step(type, open, conds[type]);
      if (action.kind === "open") {
        const cond = action.condition;
        const res = await env.DB.prepare("INSERT INTO incidents (canister_id, type, state, severity, title, detail, data, opened_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?) RETURNING id")
          .bind(c.id, type, cond.severity, cond.title, cond.detail, JSON.stringify(cond.data), ts).first<{ id: number }>();
        stats.opened++;
        toNotify.push({ incidentId: res?.id ?? null, canister: c, type, kind: "fired", title: cond.title, detail: cond.detail, severity: cond.severity, openedAt: ts });
      } else if (action.kind === "resolve") {
        updates.push(env.DB.prepare("UPDATE incidents SET state = 'resolved', resolved_at = ? WHERE id = ?").bind(ts, action.id));
        stats.resolved++;
        toNotify.push({ incidentId: action.id, canister: c, type, kind: "resolved", title: action.condition.title, detail: "Back to normal.", severity: "info", openedAt: ts });
      } else if (action.kind === "streak") {
        updates.push(env.DB.prepare("UPDATE incidents SET clear_streak = ? WHERE id = ?").bind(action.clearStreak, action.id));
      }
    }
  }
  await batchAll(env.DB, updates);

  // First run after launch: everything already frozen would fire at once. Record the incidents but
  // only notify when there are subscribers, which is naturally zero on day one.
  for (const n of toNotify) {
    if (n.incidentId == null) continue;
    try {
      await notifyIncident(env, { incidentId: n.incidentId, canister: n.canister, type: n.type, kind: n.kind, title: n.title, detail: n.detail, severity: n.severity });
    } catch (e) {
      stats.errors++;
      console.warn("notify failed", n.incidentId, String(e).slice(0, 200));
    }
  }
  return stats;
}

/** D1 batches are capped, so chunk them. Each chunk is its own transaction. */
export async function batchAll(db: D1Database, stmts: D1PreparedStatement[], size = 90): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

/** Nightly: daily burn per canister, rolling baselines, and downsampling of old raw readings. */
export async function rollupLifeline(env: Env): Promise<{ days: number; baselines: number; pruned: number }> {
  const ts = now();
  const dayStart = Math.floor(ts / DAY) * DAY - DAY; // yesterday, 00:00 UTC
  const ids = (await env.DB.prepare("SELECT DISTINCT canister_id id FROM readings WHERE ts >= ? AND ts < ? AND cycles IS NOT NULL").bind(dayStart, dayStart + DAY).all<{ id: string }>()).results.map((r) => r.id);
  const stmts: D1PreparedStatement[] = [];
  let days = 0;
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const rows = (
      await env.DB.prepare(`SELECT canister_id, ts, cycles FROM readings WHERE ts >= ? AND ts < ? AND cycles IS NOT NULL AND canister_id IN (${chunk.map(() => "?").join(",")}) ORDER BY canister_id, ts`)
        .bind(dayStart - 900, dayStart + DAY + 900, ...chunk).all<{ canister_id: string; ts: number; cycles: number }>()
    ).results;
    const by = new Map<string, Sample[]>();
    for (const r of rows) {
      let a = by.get(r.canister_id);
      if (!a) by.set(r.canister_id, (a = []));
      a.push({ ts: r.ts, cycles: r.cycles });
    }
    for (const [id, samples] of by) {
      const b = burnRate(samples, dayStart, dayStart + DAY);
      if (b == null) continue;
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO daily_burn (canister_id, day, burn) VALUES (?, ?, ?)").bind(id, dayStart, Math.round(b)));
      days++;
    }
  }
  await batchAll(env.DB, stmts);

  // Baselines over the trailing 30 days of each canister's own daily burn.
  const daily = (await env.DB.prepare("SELECT canister_id, burn FROM daily_burn WHERE day >= ? ORDER BY canister_id, day").bind(dayStart - 30 * DAY).all<{ canister_id: string; burn: number }>()).results;
  const group = new Map<string, number[]>();
  for (const d of daily) {
    let a = group.get(d.canister_id);
    if (!a) group.set(d.canister_id, (a = []));
    a.push(d.burn);
  }
  const bl: D1PreparedStatement[] = [];
  for (const [id, xs] of group) {
    const b = mkBaseline(xs);
    bl.push(env.DB.prepare("UPDATE canisters SET burn_baseline = ?, burn_mad = ?, baseline_days = ? WHERE id = ?").bind(b ? Math.round(b.median) : null, b ? Math.round(b.mad) : null, xs.length, id));
  }
  await batchAll(env.DB, bl);

  // Downsample: raw readings older than 14 days keep one row per hour, older than 120 days one per day.
  const hourCut = ts - 14 * DAY;
  const dayCut = ts - 120 * DAY;
  const thin = (bucket: number) =>
    `DELETE FROM readings WHERE (canister_id, ts) IN (
       SELECT canister_id, ts FROM (
         SELECT canister_id, ts, ROW_NUMBER() OVER (PARTITION BY canister_id, ts / ${bucket} ORDER BY ts) rn
         FROM readings WHERE ts < ?1 AND ts >= ?2
       ) WHERE rn > 1)`;
  const r1 = await env.DB.prepare(thin(3600)).bind(hourCut, hourCut - 2 * DAY).run();
  const r2 = await env.DB.prepare(thin(86400)).bind(dayCut, dayCut - 2 * DAY).run();
  await env.DB.prepare("DELETE FROM runs WHERE started_at < ?").bind(ts - 14 * DAY).run();
  return { days, baselines: bl.length, pruned: (r1.meta.changes ?? 0) + (r2.meta.changes ?? 0) };
}
