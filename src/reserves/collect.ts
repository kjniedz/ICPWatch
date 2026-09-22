// The reserves collector. Every 10 minutes: for each ck asset read supply (ledger), the minter's own
// view, and the native chain (two third-party sources), reconcile, store, and evaluate alerts.
import { notifyIncident } from "../alerts/notify";
import type { CanisterRow } from "../db/queries";
import type { Env } from "../env";
import { step, type Condition, type OpenIncident } from "../lib/health";
import { assetRegistry } from "./adapters";
import { reconcile, toleranceFor, unitsToNumber, type Reconciliation } from "./reconcile";
import type { AssetAdapter, MinterView, NativeReading, RunContext, SupplyReading } from "./types";

export interface ReserveSnapshot {
  asset: string; symbol: string; chain: string; nativeAsset: string; decimals: number; ledgerId: string; minterId: string; contract: string | null; ts: number;
  supply: { supply: string; prov: SupplyReading["prov"] };
  minter: Omit<MinterView, "reserves" | "pendingOut" | "pendingIn" | "fees" | "nativeSlack"> & { reserves: string | null; pendingOut: string | null; pendingIn: string | null; fees: string | null; nativeSlack: string };
  native: (Omit<NativeReading, "value"> & { value: string | null })[];
  rec: Reconciliation;
  tolerance: number;
}

export interface ReservesRunStats { assets: number; backed: number; withinTolerance: number; deviation: number; unknown: number; opened: number; resolved: number; errors: number; ms: number }

const now = () => Math.floor(Date.now() / 1000);
const big = (v: bigint | null | undefined) => (v == null ? null : v.toString());
/** JSON with bigints as decimal strings: the reconciliation keeps exact base units. */
export const jsonBig = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export async function collectReserves(env: Env): Promise<ReservesRunStats> {
  const started = Date.now();
  const ts = now();
  const memo = new Map<string, Promise<unknown>>();
  const ctx: RunContext = {
    env, host: env.IC_HOST, now: ts,
    memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
      let p = memo.get(key) as Promise<T> | undefined;
      if (!p) memo.set(key, (p = fn()));
      return p;
    },
  };
  const stats: ReservesRunStats = { assets: 0, backed: 0, withinTolerance: 0, deviation: 0, unknown: 0, opened: 0, resolved: 0, errors: 0, ms: 0 };
  const decimals = new Map((await env.DB.prepare("SELECT id, decimals FROM tokens").all<{ id: string; decimals: number }>()).results.map((r) => [r.id, r.decimals]));
  const assets = await assetRegistry(ctx, (id) => decimals.get(id));
  stats.assets = assets.length;

  const stmts: D1PreparedStatement[] = [];
  const snapshots: ReserveSnapshot[] = [];
  for (const a of assets) {
    try {
      const snap = await readAsset(ctx, a);
      snapshots.push(snap);
      const r = snap.rec;
      stats[r.status === "within_tolerance" ? "withinTolerance" : r.status]++;
      stmts.push(
        env.DB.prepare(`INSERT OR REPLACE INTO reserves_latest (asset, symbol, chain, ledger_id, minter_id, ts, status, raw_ratio, reconciled_ratio, supply_raw, reserves_raw, native_raw, pending_in_raw, pending_out_raw, verified, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          a.id, a.symbol, a.chain, a.ledgerId, a.minterId, ts, r.status, r.rawRatio, r.reconciledRatio, snap.supply.supply, snap.minter.reserves,
          r.nativeConsensus?.toString() ?? null, snap.minter.pendingIn, snap.minter.pendingOut, r.verified ? 1 : 0, jsonBig(snap),
        ),
        env.DB.prepare("INSERT OR REPLACE INTO reserves_series (asset, ts, supply_raw, reserves_raw, native_raw, pending_in_raw, pending_out_raw, raw_ratio, reconciled_ratio, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
          a.id, ts, snap.supply.supply, snap.minter.reserves, r.nativeConsensus?.toString() ?? null, snap.minter.pendingIn, snap.minter.pendingOut, r.rawRatio, r.reconciledRatio, r.status,
        ),
      );
    } catch (e) {
      stats.errors++;
      console.warn("reserves", a.id, String(e).slice(0, 200));
    }
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  // Keep the 10 minute series for 90 days.
  await env.DB.prepare("DELETE FROM reserves_series WHERE ts < ?").bind(ts - 90 * 86400).run();

  const alerts = await evaluateReserveAlerts(env, snapshots, ts);
  stats.opened = alerts.opened;
  stats.resolved = alerts.resolved;
  stats.ms = Date.now() - started;
  return stats;
}

async function readAsset(ctx: RunContext, a: AssetAdapter): Promise<ReserveSnapshot> {
  const [supply, view] = await Promise.all([a.readSupply(ctx), a.readMinterView(ctx).catch((e): MinterView => ({ reserves: null, pendingOut: null, pendingOutCount: null, pendingIn: null, fees: null, nativeSlack: 0n, addresses: [], extra: {}, prov: { source: "minter", trust: "first-party", ts: ctx.now, ok: false, error: String(e).slice(0, 160) } }))]);
  const native = await a.readNative(ctx, view).catch(() => [] as NativeReading[]);
  // Tolerance from the asset's own recent history of (net reserves - supply) / supply.
  const hist = (await ctx.env.DB.prepare("SELECT reserves_raw, pending_out_raw, supply_raw FROM reserves_series WHERE asset = ? AND ts > ? ORDER BY ts").bind(a.id, ctx.now - 7 * 86400).all<{ reserves_raw: string | null; pending_out_raw: string | null; supply_raw: string | null }>()).results;
  const series: number[] = [];
  for (const h of hist) {
    if (!h.reserves_raw || !h.supply_raw || h.supply_raw === "0") continue;
    const net = Number(BigInt(h.reserves_raw) - BigInt(h.pending_out_raw ?? "0"));
    series.push((net - Number(h.supply_raw)) / Number(h.supply_raw));
  }
  const tolerance = toleranceFor(a.toleranceFloor, series);
  // Only readings that cover the whole reserve count as complete for the consensus check; partial
  // ones (a sample of thousands of Bitcoin addresses) still confirm that the sampled addresses hold what the minter says.
  const rec = reconcile({
    symbol: a.symbol, decimals: a.decimals, supply: supply.prov.ok ? supply.supply : null, minterReserves: view.reserves,
    native: native.map((n) => ({ source: n.source, value: n.value, complete: n.complete })), pendingOut: view.pendingOut, pendingIn: view.pendingIn, fees: view.fees,
    nativeSlack: view.nativeSlack, tolerance, nativeAgreeEps: a.chain === "bitcoin" ? 0n : 0n,
  });
  return {
    asset: a.id, symbol: a.symbol, chain: a.chain, nativeAsset: a.nativeAsset, decimals: a.decimals, ledgerId: a.ledgerId, minterId: a.minterId, contract: a.contract ?? null, ts: ctx.now,
    supply: { supply: supply.supply.toString(), prov: supply.prov },
    minter: { ...view, reserves: big(view.reserves), pendingOut: big(view.pendingOut), pendingIn: big(view.pendingIn), fees: big(view.fees), nativeSlack: view.nativeSlack.toString() },
    native: native.map((n) => ({ ...n, value: big(n.value) })),
    rec, tolerance,
  };
}

// ---- alerts --------------------------------------------------------------------------------------------------

/** Deviation must persist across this many consecutive runs (10 minutes each) before it fires: timing noise never does. */
const DEVIATION_RUNS = 3;
const LARGE_FLOW_MULT = 8;
const LARGE_FLOW_MIN_SHARE = 0.02;

/**
 * Reserve alerts through the shared incident state machine, filed against the minter canister so
 * Lifeline subscribers to the minter receive them.
 *   reserve_deviation: reconciled ratio outside tolerance for DEVIATION_RUNS consecutive runs.
 *   large_mint_burn: one-interval supply change far above the asset's own recent interval changes.
 */
export async function evaluateReserveAlerts(env: Env, snaps: ReserveSnapshot[], ts: number): Promise<{ opened: number; resolved: number }> {
  let opened = 0;
  let resolved = 0;
  const openRows = (await env.DB.prepare("SELECT id, canister_id, type, clear_streak, data FROM incidents WHERE state = 'open' AND type IN ('reserve_deviation', 'large_mint_burn')").all<{ id: number; canister_id: string; type: string; clear_streak: number; data: string | null }>()).results;
  for (const s of snaps) {
    const recent = (await env.DB.prepare("SELECT ts, status, supply_raw FROM reserves_series WHERE asset = ? ORDER BY ts DESC LIMIT 48").bind(s.asset).all<{ ts: number; status: string; supply_raw: string | null }>()).results;
    const deviating = recent.slice(0, DEVIATION_RUNS).length === DEVIATION_RUNS && recent.slice(0, DEVIATION_RUNS).every((r) => r.status === "deviation");
    const fine = recent[0]?.status === "backed" || recent[0]?.status === "within_tolerance";
    const ratio = s.rec.reconciledRatio;
    const canister = await env.DB.prepare("SELECT c.*, t.symbol token_symbol FROM canisters c LEFT JOIN tokens t ON t.id = c.token_id WHERE c.id = ?").bind(s.minterId).first<CanisterRow>();
    const label = `${s.symbol} minter`;
    const conds: Record<string, Condition> = {
      reserve_deviation: {
        tripped: deviating, recovered: fine, severity: "critical",
        title: `Backing deviation: ${s.symbol}`,
        detail: `Reconciled backing ratio ${ratio != null ? (ratio * 100).toFixed(2) : "unknown"}% (tolerance ${(s.tolerance * 100).toFixed(2)}%) for ${DEVIATION_RUNS} consecutive checks. ${s.rec.explanation}`,
        data: { ratio, tolerance: s.tolerance, unexplained: s.rec.unexplained?.toString() ?? null },
      },
      large_mint_burn: largeFlow(s, recent),
    };
    for (const type of ["reserve_deviation", "large_mint_burn"] as const) {
      const key = `${s.minterId}:${type}:${s.asset}`;
      const open = openRows.find((o) => o.canister_id === s.minterId && o.type === type && (o.data ?? "").includes(`"asset":"${s.asset}"`));
      const state: OpenIncident | undefined = open ? { id: open.id, type: type as unknown as OpenIncident["type"], clearStreak: open.clear_streak } : undefined;
      // The state machine is typed for Lifeline's alert types; reserve types share its semantics.
      const action = (step as unknown as (t: string, o: OpenIncident | undefined, c: Condition) => ReturnType<typeof step>)(type, state, conds[type]!);
      if (action.kind === "open") {
        const cond = action.condition;
        const row = await env.DB.prepare("INSERT INTO incidents (canister_id, type, state, severity, title, detail, data, opened_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?) RETURNING id")
          .bind(s.minterId, type, cond.severity, cond.title, cond.detail, JSON.stringify({ ...cond.data, asset: s.asset }), ts).first<{ id: number }>();
        opened++;
        if (row && canister) await notifyIncident(env, { incidentId: row.id, canister, type, kind: "fired", title: cond.title, detail: cond.detail, severity: cond.severity }).catch(() => 0);
      } else if (action.kind === "resolve") {
        await env.DB.prepare("UPDATE incidents SET state = 'resolved', resolved_at = ? WHERE id = ?").bind(ts, action.id).run();
        resolved++;
        if (canister) await notifyIncident(env, { incidentId: action.id, canister, type, kind: "resolved", title: action.condition.title, detail: "Back within tolerance.", severity: "info" }).catch(() => 0);
      } else if (action.kind === "streak") {
        await env.DB.prepare("UPDATE incidents SET clear_streak = ? WHERE id = ?").bind(action.clearStreak, action.id).run();
      }
      void key;
    }
  }
  return { opened, resolved };
}

function largeFlow(s: ReserveSnapshot, recent: { ts: number; supply_raw: string | null }[]): Condition {
  const vals = recent.map((r) => (r.supply_raw ? Number(r.supply_raw) : null));
  const deltas: number[] = [];
  for (let i = 0; i + 1 < vals.length; i++) if (vals[i] != null && vals[i + 1] != null) deltas.push(Math.abs(vals[i]! - vals[i + 1]!));
  const latest = deltas[0] ?? 0;
  const base = deltas.slice(1);
  const sorted = [...base].sort((a, b) => a - b);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const supply = vals[0] ?? 0;
  const share = supply > 0 ? latest / supply : 0;
  const tripped = base.length >= 12 && share >= LARGE_FLOW_MIN_SHARE && latest > med * LARGE_FLOW_MULT;
  const dir = vals[0] != null && vals[1] != null && vals[0] > vals[1] ? "mint" : "burn";
  return {
    tripped, recovered: !tripped, severity: "warn",
    title: `Large ${dir}: ${s.symbol}`,
    detail: `${s.symbol} supply moved by ${unitsToNumber(BigInt(Math.round(latest)), s.decimals)?.toLocaleString("en-US")} (${(share * 100).toFixed(2)}% of supply) in one ten minute interval, ${med > 0 ? `${(latest / med).toFixed(0)}x` : "far above"} its recent median interval change.`,
    data: { latest, median: med, share, asset: s.asset },
  };
}
