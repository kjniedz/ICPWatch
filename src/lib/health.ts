// Lifeline health engine. Pure functions only: no I/O, fully unit tested.
//
// Model of the IC cycle lifecycle this encodes:
//   running  -> cycles fall at burn rate until they hit the freezing threshold
//   frozen   -> canister rejects calls, burns only idle (storage) cost
//   zero     -> canister is uninstalled: code and state are deleted
// Freezing threshold in cycles = idle_burn_per_day * freezing_threshold_seconds / 86400.

export const DAY = 86400;
export const DEFAULT_FREEZING_THRESHOLD_S = 30 * DAY; // IC default: 2_592_000

export type RunStatus = "running" | "stopping" | "stopped" | "frozen" | "out_of_cycles" | "no_wasm" | "deleted" | "unknown";
export type HealthState = "healthy" | "low" | "risk" | "frozen" | "life" | "unknown" | "gone";
export type Confidence = "measured" | "inferred" | "unknown";

export interface Sample { ts: number; cycles: number }

export interface CanisterFacts {
  cycles: number | null;
  runStatus: RunStatus;
  freezingThresholdS: number | null;
  idleBurnPerDay: number | null;
  /** burn observed from our own readings, cycles per day */
  observedBurnPerDay: number | null;
  lifeSupport?: boolean;
}

export interface Projection {
  /** cycles at which the canister freezes; null when not computable */
  freezeThresholdCycles: number | null;
  /** burn used for the projection and where it came from */
  burnPerDay: number | null;
  burnSource: "observed" | "idle" | "none";
  secondsToFreeze: number | null;
  secondsToDeletion: number | null;
  /** true when the threshold or burn had to be assumed rather than read */
  assumed: boolean;
}

export const LOW_DAYS = 14;
export const RISK_DAYS = 45;
export const DELETION_WARN_DAYS = 14;

export function project(f: CanisterFacts): Projection {
  const none: Projection = { freezeThresholdCycles: null, burnPerDay: null, burnSource: "none", secondsToFreeze: null, secondsToDeletion: null, assumed: false };
  if (f.cycles == null) return none;

  const idle = f.idleBurnPerDay && f.idleBurnPerDay > 0 ? f.idleBurnPerDay : null;
  const observed = f.observedBurnPerDay && f.observedBurnPerDay > 0 ? f.observedBurnPerDay : null;
  // A running canister never burns less than its idle cost, so take the larger of the two.
  const burn = observed != null && idle != null ? Math.max(observed, idle) : (observed ?? idle);
  const burnSource = burn == null ? "none" : observed != null && burn === observed ? "observed" : "idle";

  let assumed = false;
  let thresholdS = f.freezingThresholdS;
  if (thresholdS == null) {
    thresholdS = DEFAULT_FREEZING_THRESHOLD_S;
    assumed = true;
  }
  // Idle burn is what the threshold is defined against. Without it, fall back to the observed
  // burn as an upper bound, and flag the projection as assumed.
  let idleForThreshold = idle;
  if (idleForThreshold == null && observed != null) {
    idleForThreshold = observed;
    assumed = true;
  }
  if (idleForThreshold == null || burn == null) return { ...none, burnPerDay: burn, burnSource, assumed };

  const threshold = (idleForThreshold * thresholdS) / DAY;
  const frozenNow = f.runStatus === "frozen" || f.runStatus === "out_of_cycles" || f.cycles <= threshold;
  const secondsToFreeze = frozenNow ? 0 : ((f.cycles - threshold) / burn) * DAY;
  // Once frozen only idle cost is burned, all the way down to zero.
  const cyclesAtFreeze = frozenNow ? f.cycles : threshold;
  const secondsToDeletion = secondsToFreeze + (cyclesAtFreeze / idleForThreshold) * DAY;
  return { freezeThresholdCycles: threshold, burnPerDay: burn, burnSource, secondsToFreeze, secondsToDeletion, assumed };
}

export function classify(f: CanisterFacts, p: Projection): HealthState {
  if (f.runStatus === "deleted" || f.runStatus === "no_wasm") return "gone";
  if (f.lifeSupport) return "life";
  if (f.runStatus === "frozen" || f.runStatus === "out_of_cycles") return "frozen";
  if (f.cycles == null) return "unknown";
  // System subnets do not charge cycles: a controller-reported idle burn of exactly zero with
  // no observed burn means the balance is not going anywhere.
  if (f.idleBurnPerDay === 0 && !f.observedBurnPerDay && f.runStatus === "running") return "healthy";
  if (p.secondsToFreeze == null) return "unknown";
  if (p.secondsToFreeze <= 0) return "frozen";
  if (p.secondsToFreeze < LOW_DAYS * DAY) return "low";
  if (p.secondsToFreeze < RISK_DAYS * DAY) return "risk";
  return "healthy";
}

/**
 * Burn rate in cycles per day from a series of balance samples.
 * Top-ups (balance going up) are excluded along with the interval they happened in,
 * so a refill never shows up as negative burn or hides real burn.
 */
export function burnRate(samples: Sample[], fromTs: number, toTs: number, minCoverageS = 1800): number | null {
  // Duration-weighted median of the per-interval rates. Summing drops and skipping rises looked
  // reasonable until SNS roots and minters turned up whose balance swings by trillions in both
  // directions as cycles move in and out: every drop counted as burn, every rise was "a top-up".
  // The median ignores those transfers in either direction and keeps the steady underlying burn.
  const intervals: { rate: number; dt: number }[] = [];
  let covered = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (b.ts <= fromTs || a.ts >= toTs) continue;
    const dt = b.ts - a.ts;
    if (dt <= 0) continue;
    intervals.push({ rate: (a.cycles - b.cycles) / dt, dt });
    covered += dt;
  }
  // Short windows turn a tiny balance change into a huge daily rate (a timer firing, an archive
  // flush), so callers that project or alert ask for hours of clean coverage, not minutes.
  if (covered < minCoverageS || !intervals.length) return null;
  // Net trend across the window: a balance that is not falling has no runway problem, whatever
  // the intervals look like. Minters and busy dapps move tens of trillions in and out every hour.
  const inWindow = samples.filter((s) => s.ts >= fromTs && s.ts <= toTs);
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const net = first && last && last.ts > first.ts ? (first.cycles - last.cycles) / (last.ts - first.ts) : null;
  intervals.sort((x, y) => x.rate - y.rate);
  let acc = 0;
  let med = intervals[intervals.length - 1]!.rate;
  for (const iv of intervals) {
    acc += iv.dt;
    if (acc >= covered / 2) {
      med = iv.rate;
      break;
    }
  }
  // The smaller of the two: the median discounts transfers, the net trend discounts churn. A canister
  // topped up inside the window is underestimated until the top-up leaves it, which errs on the quiet side.
  const rate = net == null ? med : Math.min(med, net);
  return Math.max(0, rate) * DAY; // net inflow reads as zero burn, never negative
}

/** Daily burn values (cycles per day) for each full UTC day covered by the samples. */
export function dailyBurns(samples: Sample[], days: number, nowTs: number): number[] {
  const out: number[] = [];
  const end = Math.floor(nowTs / DAY) * DAY;
  for (let d = days; d >= 1; d--) {
    const r = burnRate(samples, end - d * DAY, end - (d - 1) * DAY);
    if (r != null) out.push(r);
  }
  return out;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface Baseline { median: number; mad: number; days: number }

/** Rolling baseline: median and median absolute deviation of the canister's own daily burn. */
export function baseline(daily: number[]): Baseline | null {
  if (daily.length < 3) return null; // not enough history to call anything an anomaly
  const med = median(daily);
  const mad = median(daily.map((x) => Math.abs(x - med)));
  return { median: med, mad, days: daily.length };
}

export const ANOMALY_MULTIPLE = 3;
export const ANOMALY_MAD_K = 6;
export const ANOMALY_MIN_EXCESS = 0.05e12; // ignore spikes smaller than 0.05 T per day
export const ANOMALY_CLEAR_MULTIPLE = 1.5;

/**
 * A spike is anomalous only relative to the canister's own history: it must exceed
 * 3x the median AND sit 6 MADs out AND be materially large in absolute terms.
 * A canister that is always busy has a high median and wide MAD, so it does not fire.
 */
export function isBurnAnomaly(recent: number | null, b: Baseline | null): boolean {
  if (recent == null || b == null) return false;
  const excess = recent - b.median;
  return recent > b.median * ANOMALY_MULTIPLE && excess > b.mad * ANOMALY_MAD_K && excess > ANOMALY_MIN_EXCESS;
}

export function isBurnBackToNormal(recent: number | null, b: Baseline | null): boolean {
  if (recent == null || b == null) return false;
  return recent <= Math.max(b.median * ANOMALY_CLEAR_MULTIPLE, b.median + b.mad * 2);
}

// ---------------------------------------------------------------------------------
// Incidents: one alert per incident, hysteresis on the way out, one resolved notice.

export type AlertType = "low_cycles" | "frozen" | "approaching_deletion" | "burn_anomaly";
export const ALERT_TYPES: AlertType[] = ["low_cycles", "frozen", "approaching_deletion", "burn_anomaly"];

/** Point-in-time security events from on-chain canister history. They fire once and never "resolve". */
export type EventType = "controller_change" | "module_change";
export const EVENT_TYPES: EventType[] = ["controller_change", "module_change"];

export interface Condition {
  /** the trip condition holds right now */
  tripped: boolean;
  /** the recovery condition holds right now (stricter than "not tripped") */
  recovered: boolean;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  data: Record<string, unknown>;
}

/** Number of consecutive recovered evaluations before an incident resolves. */
export const CLEAR_STREAK: Record<AlertType, number> = { low_cycles: 2, frozen: 2, approaching_deletion: 2, burn_anomaly: 3 };

export interface OpenIncident { id: number; type: AlertType; clearStreak: number }

export type IncidentAction =
  | { kind: "open"; type: AlertType; condition: Condition }
  | { kind: "resolve"; id: number; type: AlertType; condition: Condition }
  | { kind: "streak"; id: number; clearStreak: number }
  | { kind: "none" };

/**
 * State machine step for one (canister, alert type).
 *   no incident + tripped          -> open (notify once)
 *   open + tripped                 -> nothing (dedup), streak reset
 *   open + recovered               -> streak++, resolve once it reaches CLEAR_STREAK (notify once)
 *   open + neither (in the band)   -> nothing: this is the hysteresis band
 */
export function step(type: AlertType, open: OpenIncident | undefined, c: Condition): IncidentAction {
  if (!open) return c.tripped ? { kind: "open", type, condition: c } : { kind: "none" };
  if (c.tripped) return open.clearStreak ? { kind: "streak", id: open.id, clearStreak: 0 } : { kind: "none" };
  if (c.recovered) {
    const next = open.clearStreak + 1;
    return next >= CLEAR_STREAK[type] ? { kind: "resolve", id: open.id, type, condition: c } : { kind: "streak", id: open.id, clearStreak: next };
  }
  return { kind: "none" };
}

const T = 1e12;
const t = (c: number | null | undefined) => (c == null ? "unknown" : `${(c / T).toFixed(c / T >= 10 ? 1 : 2)} T`);
const days = (s: number) => Math.max(0, Math.round(s / DAY));

export interface EvalInput extends CanisterFacts {
  label: string;
  role: string;
  recentBurnPerDay: number | null;
  baseline: Baseline | null;
}

/** Evaluate all four alert conditions for a canister. */
export function conditions(f: EvalInput, p: Projection): Record<AlertType, Condition> {
  const frozen = f.runStatus === "frozen" || f.runStatus === "out_of_cycles";
  const running = f.runStatus === "running";
  const archiveNote = f.role === "archive" ? " Archives hold transaction history, and losing one breaks it permanently." : "";
  const toFreeze = p.secondsToFreeze;
  const toDelete = p.secondsToDeletion;
  const mult = f.baseline && f.baseline.median > 0 && f.recentBurnPerDay != null ? f.recentBurnPerDay / f.baseline.median : null;

  return {
    low_cycles: {
      tripped: !frozen && toFreeze != null && toFreeze < LOW_DAYS * DAY,
      recovered: toFreeze != null && toFreeze > LOW_DAYS * 1.5 * DAY && !frozen,
      severity: toFreeze != null && toFreeze < 3 * DAY ? "critical" : "warn",
      title: `Low cycles: ${f.label}`,
      detail: `${t(f.cycles)} left, about ${toFreeze == null ? "?" : days(toFreeze)} days until it freezes at the current burn of ${t(p.burnPerDay)} per day.${archiveNote}`,
      data: { cycles: f.cycles, burnPerDay: p.burnPerDay, secondsToFreeze: toFreeze, threshold: p.freezeThresholdCycles },
    },
    frozen: {
      tripped: frozen,
      recovered: running,
      severity: "critical",
      title: `Frozen: ${f.label}`,
      detail: `The canister is rejecting calls because its balance is below the freezing threshold.${toDelete != null ? ` About ${days(toDelete)} days of storage cost left before deletion.` : ""}${archiveNote}`,
      data: { cycles: f.cycles, secondsToDeletion: toDelete },
    },
    approaching_deletion: {
      tripped: frozen && toDelete != null && toDelete < DELETION_WARN_DAYS * DAY,
      recovered: !frozen || (toDelete != null && toDelete > DELETION_WARN_DAYS * 1.5 * DAY),
      severity: "critical",
      title: `Approaching deletion: ${f.label}`,
      detail: `Frozen, about ${toDelete == null ? "?" : days(toDelete)} days of storage cost left before the canister is uninstalled and its state is deleted.${archiveNote}`,
      data: { cycles: f.cycles, secondsToDeletion: toDelete },
    },
    burn_anomaly: {
      tripped: isBurnAnomaly(f.recentBurnPerDay, f.baseline),
      recovered: isBurnBackToNormal(f.recentBurnPerDay, f.baseline),
      severity: "warn",
      title: `Burn-rate anomaly: ${f.label}`,
      detail: `Burning ${t(f.recentBurnPerDay)} per day, ${mult == null ? "well above" : `${mult.toFixed(1)}x`} its own ${f.baseline?.days ?? 0}-day baseline of ${t(f.baseline?.median)}. Busy canisters do not trip this, spikes do.`,
      data: { recent: f.recentBurnPerDay, baseline: f.baseline },
    },
  };
}
