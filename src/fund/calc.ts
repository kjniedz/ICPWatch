// Community top-ups: the amount calculator. Pure functions only: no I/O, no clock, no randomness.
//
// Two modes that must never be confused:
//
//   KEEP ALIVE  The canister stays FROZEN on purpose. A frozen canister burns only its idle (storage)
//               cost, so this is the cheapest way to stop it from being deleted. The resulting balance
//               is capped at a fraction of the freezing threshold (the same safety fraction life support
//               uses), so a keep-alive top-up can never unfreeze the canister by accident.
//               Consequence worth saying out loud: a frozen canister can never hold more than its
//               freezing threshold, so keep-alive buys at most (fraction * threshold days) of runway
//               per top-up. With the IC default threshold of 30 days that is about 13 days.
//
//   REVIVE      Enough to lift the balance above the freezing threshold, plus N days of NORMAL burn
//               as a runway buffer. The canister answers calls again and burns at its normal rate.
//               For a canister that is still running this is a plain top-up: N more days of runway.
//
//   T       = idle_burn_per_day * freezing_threshold_s / 86400
//   T_eff   = T - reserved_cycles (when known)
//   cap     = safetyFraction * T_eff            (0.45 reported idle burn, 0.30 estimated)
//   keep    = min(months * 30 * idle, cap - balance)            rounded DOWN to whole e8s
//   revive  = (T - balance) * margin + N * normal burn           rounded UP to whole e8s
import { DAY } from "../lib/health";
import { DEFAULT_PARAMS, E8S, ICP_FEE_E8S, TRILLION, USD_PER_XDR_FALLBACK } from "../lifesupport/planner";

export type FundMode = "keep_alive" | "revive";
export type FundState = "frozen" | "at_risk" | "running" | "uninstalled" | "deleted" | "unknown";
export type WarningLevel = "info" | "warn" | "danger";

export const KEEP_ALIVE_MONTHS = [1, 3, 6, 12] as const;
export const REVIVE_DAYS = [30, 90] as const;
/** Revive must clear the threshold with room to spare: idle burn moves with memory and subnet pricing. */
export const REVIVE_MARGIN = 1.05;
export const REVIVE_MARGIN_ESTIMATED = 1.15;
/** Below this a keep-alive top-up is not worth a ledger fee: less than one day of storage. */
export const MIN_KEEP_ALIVE_DAYS = 1;
/** Largest single community top-up the calculator will size or accept: 100 T cycles, about 100 XDR. A typo guard. */
export const MAX_TOPUP_CYCLES = 100 * TRILLION;

export interface FundFacts {
  canisterId: string;
  /** Latest balance reading. Null when nobody outside the controllers can read it. */
  cycles: number | null;
  runStatus: string;
  health: string;
  /** Idle burn as reported by a controller source. Null for blackhole sourced canisters. */
  idleBurnPerDay: number | null;
  freezingThresholdS: number | null;
  /** Burn observed from our own readings (canisters.burn_per_day). For a frozen canister this IS its idle burn. */
  observedBurnPerDay: number | null;
  /** Rolling median of daily burn from our history (canisters.burn_baseline): the best guess at "normal" burn. */
  baselineBurnPerDay?: number | null;
  reservedCycles?: number | null;
}

export interface FundWarning { code: string; level: WarningLevel; text: string }

export interface Price {
  /** ICP to send, in e8s, excluding the ledger fee. Null when no conversion rate is available. */
  e8s: number | null;
  feeE8s: number;
  /** What leaves the wallet: e8s + ledger fee. */
  totalE8s: number | null;
  icp: number | null;
  usd: number | null;
  /** Cycles the CMC mints for e8s at this rate (whole e8s, so it differs slightly from the requested cycles). */
  deliveredCycles: number;
}

export interface Preset extends Price {
  key: string;
  mode: FundMode;
  label: string;
  /** Requested size before capping and e8s rounding. */
  wantCycles: number;
  /** Keep-alive only: the request was cut down to the safe cap. */
  capped: boolean;
  afterCycles: number;
  /** Balance after the top-up as a fraction of the freezing threshold. */
  afterShareOfThreshold: number | null;
  /** Keep-alive: days of idle burn bought. Revive: days of normal burn bought above the threshold. */
  daysBought: number;
  /** Projected unix seconds. For keep-alive there is no freeze date: it is frozen now and stays frozen. */
  newFreezeAt: number | null;
  newDeleteAt: number | null;
  unfreezes: boolean;
}

export interface ModeOptions {
  available: boolean;
  /** Why the mode is refused, in plain words. Null when available. */
  reason: string | null;
  /** The supporter must tick a box before paying (uninstalled canister). */
  requiresAck: boolean;
  presets: Preset[];
  warnings: FundWarning[];
}

export interface FundingOptions {
  canisterId: string;
  state: FundState;
  balanceCycles: number | null;
  idleBurnPerDay: number | null;
  idleSource: "reported" | "observed_frozen" | null;
  /** True when idle burn or the threshold had to be estimated: every number derived from them is approximate. */
  estimated: boolean;
  thresholdAssumed: boolean;
  thresholdCycles: number | null;
  effectiveThresholdCycles: number | null;
  normalBurnPerDay: number | null;
  normalBurnSource: "history" | "observed" | "idle_floor" | null;
  /** Keep-alive ceiling: the balance a keep-alive top-up may reach at most. */
  keepAliveCapCycles: number | null;
  safetyFraction: number;
  currentDeleteAt: number | null;
  xdrPermyriadPerIcp: number | null;
  icpUsd: number | null;
  usdSource: "icp-price" | "xdr-fallback";
  keepAlive: ModeOptions;
  revive: ModeOptions;
  warnings: FundWarning[];
}

export const fmtCyclesShort = (c: number | null | undefined) => (c == null ? "unknown" : c >= 1e11 ? `${(c / TRILLION).toFixed(3)} T` : c >= 1e8 ? `${(c / 1e9).toFixed(2)} B` : `${(c / 1e6).toFixed(1)} M`);
const days = (n: number) => (n >= 100 ? `${Math.round(n)}` : n >= 10 ? n.toFixed(0) : n.toFixed(1));

/**
 * Converts cycles to the ICP a supporter sends. "down" never delivers more than asked (keep-alive must stay
 * under its cap), "up" never delivers less (revive must clear the threshold).
 */
export function priceCycles(cycles: number, xdrPermyriadPerIcp: number | null, icpUsd: number | null, round: "down" | "up"): Price {
  const rate = xdrPermyriadPerIcp != null && xdrPermyriadPerIcp > 0 ? xdrPermyriadPerIcp : null;
  if (!rate) {
    // 1 T cycles always costs 1 XDR, so a USD figure is still honest without the ICP rate.
    return { e8s: null, feeE8s: ICP_FEE_E8S, totalE8s: null, icp: null, usd: (cycles / TRILLION) * USD_PER_XDR_FALLBACK, deliveredCycles: cycles };
  }
  const e8s = Math.max(0, round === "down" ? Math.floor(cycles / rate) : Math.ceil(cycles / rate));
  const totalE8s = e8s + ICP_FEE_E8S;
  const icp = totalE8s / E8S;
  const usd = icpUsd != null && icpUsd > 0 ? icp * icpUsd : icp * (rate / 1e4) * USD_PER_XDR_FALLBACK;
  return { e8s, feeE8s: ICP_FEE_E8S, totalE8s, icp, usd, deliveredCycles: e8s * rate };
}

export function fundState(f: Pick<FundFacts, "runStatus" | "health" | "cycles">, thresholdEff: number | null): FundState {
  if (f.runStatus === "deleted") return "deleted";
  if (f.runStatus === "no_wasm") return "uninstalled";
  if (f.runStatus === "frozen" || f.runStatus === "out_of_cycles" || f.health === "frozen" || f.health === "life") return "frozen";
  if (f.cycles != null && thresholdEff != null && thresholdEff > 0 && f.cycles < thresholdEff) return "frozen";
  if (f.health === "low" || f.health === "risk") return "at_risk";
  if (f.runStatus === "running" || f.runStatus === "stopped" || f.runStatus === "stopping" || f.health === "healthy") return "running";
  return "unknown";
}

interface Resolved {
  state: FundState; balance: number | null; idle: number | null; idleSource: FundingOptions["idleSource"]; estimated: boolean; thresholdAssumed: boolean;
  threshold: number | null; thresholdEff: number | null; normal: number | null; normalSource: FundingOptions["normalBurnSource"]; fraction: number; cap: number | null; idleZero: boolean;
}

function resolve(f: FundFacts): Resolved {
  const pos = (n: number | null | undefined) => (n != null && Number.isFinite(n) && n > 0 ? n : null);
  const balance = f.cycles != null && Number.isFinite(f.cycles) && f.cycles >= 0 ? f.cycles : null;
  const looksFrozen = f.runStatus === "frozen" || f.runStatus === "out_of_cycles" || f.health === "frozen" || f.health === "life";
  const idleZero = f.idleBurnPerDay === 0;
  let idle = pos(f.idleBurnPerDay);
  let idleSource: Resolved["idleSource"] = idle ? "reported" : null;
  let estimated = false;
  // Blackhole sourced canisters report no idle burn. While a canister is frozen it burns ONLY its idle cost,
  // so the burn we observed ourselves is the idle burn. Marked estimated everywhere it is used.
  if (!idle && !idleZero && looksFrozen && pos(f.observedBurnPerDay)) {
    idle = f.observedBurnPerDay!;
    idleSource = "observed_frozen";
    estimated = true;
  }
  let thresholdAssumed = false;
  let thrS = pos(f.freezingThresholdS);
  if (!thrS && idle) {
    thrS = DEFAULT_PARAMS.highWaterDays * DAY; // 30 days, the IC default
    thresholdAssumed = true;
    estimated = true;
  }
  const threshold = idle && thrS ? (idle * thrS) / DAY : null;
  const reserved = pos(f.reservedCycles) ?? 0;
  const thresholdEff = threshold != null ? Math.max(0, threshold - reserved) : null;
  const state = fundState(f, thresholdEff);
  const fraction = estimated ? DEFAULT_PARAMS.estimatedSafetyFraction : DEFAULT_PARAMS.safetyFraction;
  const cap = thresholdEff != null ? fraction * thresholdEff : null;

  // "Normal" burn: what the canister costs while it runs. Never below idle.
  const history = pos(f.baselineBurnPerDay);
  const observed = pos(f.observedBurnPerDay);
  let normal: number | null = null;
  let normalSource: Resolved["normalSource"] = null;
  if (state === "frozen" || state === "uninstalled") {
    if (history && idle && history > idle * 1.05) { normal = history; normalSource = "history"; }
    else if (idle) { normal = idle; normalSource = "idle_floor"; }
  } else {
    const best = Math.max(observed ?? 0, history ?? 0, idle ?? 0);
    if (best > 0) { normal = best; normalSource = best === (observed ?? -1) ? "observed" : best === (history ?? -1) ? "history" : "idle_floor"; }
  }
  return { state, balance, idle, idleSource, estimated, thresholdAssumed, threshold, thresholdEff, normal, normalSource, fraction, cap, idleZero };
}

const UNINSTALLED_TEXT = "This canister has been uninstalled: its code and all of its state are already gone. Cycles sent here only keep an empty shell (the canister id and its controllers) from being removed. Nothing can be brought back by funding it.";
const NON_REFUNDABLE = "Top-ups cannot be refunded or withdrawn, by you, by ICPWatch, or by anyone else. The cycles belong to the canister.";

/**
 * The two funding modes with computed presets. `now` is unix seconds and is only used for the projected dates.
 */
export function fundingOptions(f: FundFacts, xdrPermyriadPerIcp: number | null, icpUsd: number | null, now: number): FundingOptions {
  const r = resolve(f);
  const rate = xdrPermyriadPerIcp != null && xdrPermyriadPerIcp > 0 ? xdrPermyriadPerIcp : null;
  const usdOk = icpUsd != null && icpUsd > 0;
  const warnings: FundWarning[] = [];
  const mode = (): ModeOptions => ({ available: false, reason: null, requiresAck: false, presets: [], warnings: [] });
  const keepAlive = mode();
  const revive = mode();

  if (!rate) warnings.push({ code: "rate_unknown", level: "warn", text: "No fresh ICP/XDR conversion rate is available, so ICP amounts cannot be shown. 1 T cycles always costs 1 XDR." });
  if (r.estimated) {
    warnings.push({
      code: "estimated", level: "warn",
      text: r.idleSource === "observed_frozen"
        ? `Nobody outside this canister's controllers can read its idle burn, so ${fmtCyclesShort(r.idle)} per day is our own estimate from watching it burn while frozen${r.thresholdAssumed ? ", and the freezing threshold is assumed to be the default 30 days" : ""}. Every amount and date below is approximate.`
        : "The freezing threshold is not readable for this canister, so the default of 30 days is assumed. Every amount and date below is approximate.",
    });
  }
  if (r.state === "uninstalled") warnings.push({ code: "uninstalled", level: "danger", text: UNINSTALLED_TEXT });

  const currentDeleteAt = r.state === "frozen" && r.balance != null && r.idle ? now + (r.balance / r.idle) * DAY : null;

  // ---- keep alive ------------------------------------------------------------------------------------------
  const ka = (() => {
    if (r.state === "deleted") return "This canister no longer exists. A top-up would be rejected by the network and returned minus fees.";
    if (r.idleZero) return "This canister pays no storage cost (system subnet or an empty canister), so its balance does not run down. There is nothing to keep alive.";
    if (r.state === "running" || r.state === "at_risk") return "Keep alive is for frozen canisters only. This one is still running, and a running canister burns at its full rate, so a small preservation top-up would buy almost nothing. Use Revive / top up instead.";
    if (r.state === "unknown") return "We cannot tell whether this canister is frozen, so a safe keep-alive amount cannot be computed.";
    if (r.balance == null) return "This canister's balance is not readable from outside, so we cannot compute an amount that is guaranteed to keep it frozen. You can still send a custom amount at your own judgment.";
    if (!r.idle || r.thresholdEff == null || r.cap == null) return "Idle burn is unknown for this canister (its controller source does not report it and we have not watched it long enough), so the freezing threshold cannot be computed.";
    if (r.thresholdEff <= 0) return "Reserved cycles cover this canister's whole freezing threshold, so its balance cannot freeze it and keep alive does not apply.";
    return null;
  })();
  if (ka) keepAlive.reason = ka;
  else {
    const idle = r.idle!, balance = r.balance!, cap = r.cap!, thr = r.thresholdEff!;
    const room = cap - balance;
    const pct = Math.round(r.fraction * 100);
    if (room < MIN_KEEP_ALIVE_DAYS * idle) {
      keepAlive.reason = `The balance (${fmtCyclesShort(balance)}) is already at ${Math.round((balance / thr) * 100)}% of the freezing threshold (${fmtCyclesShort(thr)}). Keep-alive top-ups stop at ${pct}% so they can never unfreeze the canister, which leaves no safe room right now. It has about ${days(balance / idle)} days before deletion: come back when the balance is under ${fmtCyclesShort(cap)}, or use Revive.`;
    } else {
      keepAlive.available = true;
      keepAlive.requiresAck = r.state === "uninstalled";
      const build = (key: string, label: string, want: number): Preset => {
        const capped = want > room;
        const p = priceCycles(Math.min(want, room), rate, icpUsd, "down");
        const after = balance + p.deliveredCycles;
        return {
          ...p, key, mode: "keep_alive", label, wantCycles: want, capped, afterCycles: after, afterShareOfThreshold: after / thr,
          daysBought: p.deliveredCycles / idle, newFreezeAt: null, newDeleteAt: now + (after / idle) * DAY, unfreezes: after >= thr,
        };
      };
      for (const m of KEEP_ALIVE_MONTHS) keepAlive.presets.push(build(`${m}m`, m === 1 ? "1 month" : `${m} months`, m * 30 * idle));
      keepAlive.presets.push(build("max", "Maximum safe", room));
      const firstCapped = keepAlive.presets[0]!.capped;
      if (firstCapped) {
        keepAlive.warnings.push({
          code: "one_month_would_unfreeze", level: "warn",
          text: `Even one month of storage (${fmtCyclesShort(30 * idle)}) does not fit: it would push the balance to ${Math.round(((balance + 30 * idle) / thr) * 100)}% of the freezing threshold (${fmtCyclesShort(thr)}, ${days(thr / idle)} days of idle burn)${balance + 30 * idle >= thr ? " and unfreeze the canister" : ", past the safe limit"}. A frozen canister can never hold more than its threshold, so the most a keep-alive top-up can add is ${fmtCyclesShort(room)}, about ${days(room / idle)} days. Longer preservation means topping up again later.`,
        });
      } else if (keepAlive.presets.some((p) => p.capped)) {
        keepAlive.warnings.push({ code: "capped", level: "info", text: `Longer presets are cut to the safe maximum of ${fmtCyclesShort(room)} (about ${days(room / idle)} days): the balance must stay under ${pct}% of the freezing threshold so the canister stays frozen.` });
      }
      keepAlive.warnings.push({ code: "stays_frozen", level: "info", text: "The canister stays frozen: it will not answer calls. This only stops it from being deleted, at the lowest possible cost." });
    }
  }

  // ---- revive / top up -------------------------------------------------------------------------------------
  const rv = (() => {
    if (r.state === "deleted") return "This canister no longer exists. A top-up would be rejected by the network and returned minus fees.";
    if (r.state === "uninstalled") return "There is no code left to revive: the canister was uninstalled when it ran out of cycles. Only a controller can install code again.";
    if (r.idleZero && (r.state === "running" || r.state === "at_risk")) return "This canister pays no cycles for storage or execution that we can observe (system subnet), so it does not need a top-up.";
    if (!r.normal) return "We have no burn rate for this canister yet, so a runway cannot be computed. You can still send a custom amount.";
    if (r.state === "frozen" && (r.balance == null || r.threshold == null)) return "The balance or the freezing threshold is not readable from outside, so the amount needed to unfreeze it cannot be computed. You can still send a custom amount.";
    return null;
  })();
  if (rv) revive.reason = rv;
  else {
    revive.available = true;
    const normal = r.normal!;
    const frozen = r.state === "frozen";
    const balance = r.balance ?? 0;
    const thr = r.threshold ?? 0;
    const gap = frozen ? Math.max(0, thr - balance) * (r.estimated ? REVIVE_MARGIN_ESTIMATED : REVIVE_MARGIN) : 0;
    for (const n of REVIVE_DAYS) {
      const want = Math.min(MAX_TOPUP_CYCLES, gap + n * normal);
      const p = priceCycles(want, rate, icpUsd, "up");
      const after = balance + p.deliveredCycles;
      const above = Math.max(0, after - thr);
      const newFreezeAt = r.balance != null && r.threshold != null ? now + (above / normal) * DAY : null;
      revive.presets.push({
        ...p, key: `${n}d`, mode: "revive", label: frozen ? `Revive + ${n} days` : `${n} more days`, wantCycles: want, capped: false, afterCycles: after,
        afterShareOfThreshold: r.threshold ? after / r.threshold : null, daysBought: (p.deliveredCycles - gap) / normal,
        newFreezeAt, newDeleteAt: newFreezeAt != null && r.idle ? newFreezeAt + (thr / r.idle) * DAY : null, unfreezes: frozen && r.threshold != null && after >= thr,
      });
    }
    if (frozen) {
      revive.warnings.push({
        code: "burns_again", level: "warn",
        text: `A revived canister answers calls again and goes back to burning at its normal rate: about ${fmtCyclesShort(normal)} per day${r.idle && normal > r.idle * 1.05 ? `, against ${fmtCyclesShort(r.idle)} per day while frozen` : ""}. Of each amount below, ${fmtCyclesShort(gap)} only lifts the balance over the freezing threshold (${fmtCyclesShort(thr)}) and the rest is runway.`,
      });
      if (r.normalSource === "idle_floor") revive.warnings.push({ code: "normal_burn_floor", level: "warn", text: "We have no record of what this canister burned while it was running, so the runway uses its storage cost alone. Real usage burns more: expect the runway to be shorter than shown." });
      revive.warnings.push({ code: "permissionless", level: "info", text: "Reviving does not give you or ICPWatch any control. Its controllers may have let it freeze on purpose, and they can change its settings at any time." });
    } else if (r.state === "running") {
      revive.warnings.push({ code: "healthy", level: "info", text: "This canister is running and is not at risk right now. A top-up simply extends its runway." });
    }
  }

  warnings.push({ code: "non_refundable", level: "info", text: NON_REFUNDABLE });
  return {
    canisterId: f.canisterId, state: r.state, balanceCycles: r.balance, idleBurnPerDay: r.idle, idleSource: r.idleSource, estimated: r.estimated, thresholdAssumed: r.thresholdAssumed,
    thresholdCycles: r.threshold, effectiveThresholdCycles: r.thresholdEff, normalBurnPerDay: r.normal, normalBurnSource: r.normalSource, keepAliveCapCycles: r.cap, safetyFraction: r.fraction,
    currentDeleteAt, xdrPermyriadPerIcp: rate, icpUsd: usdOk ? icpUsd : null, usdSource: usdOk ? "icp-price" : "xdr-fallback", keepAlive, revive, warnings,
  };
}

export interface Assessment {
  ok: boolean;
  /** Reasons the amount is refused. Empty when ok. */
  errors: string[];
  warnings: FundWarning[];
  afterCycles: number | null;
  unfreezes: boolean | null;
  requiresAck: boolean;
}

/**
 * Guards for an amount the supporter typed themselves (or a preset re-checked at pay time).
 * Refuses nonsense, and warns before a keep-alive amount would unfreeze the canister.
 */
export function assessAmount(f: FundFacts, mode: FundMode, cycles: number): Assessment {
  const r = resolve(f);
  const errors: string[] = [];
  const warnings: FundWarning[] = [];
  if (!Number.isFinite(cycles) || cycles <= 0) errors.push("The amount must be greater than zero.");
  else if (cycles > MAX_TOPUP_CYCLES) errors.push(`The amount is above the ${fmtCyclesShort(MAX_TOPUP_CYCLES)} limit for a single community top-up. If that is really what you mean, send it in parts.`);
  if (r.state === "deleted") errors.push("This canister no longer exists. The network would reject the top-up and return it minus fees.");
  if (mode === "keep_alive" && (r.state === "running" || r.state === "at_risk")) errors.push("Keep alive only applies to frozen canisters. This one is running: use Revive / top up.");
  if (mode === "revive" && r.state === "uninstalled") errors.push("There is no code left to revive. Only a controller can install code again.");
  if (mode !== "keep_alive" && mode !== "revive") errors.push("Unknown mode.");
  const after = r.balance != null && Number.isFinite(cycles) ? r.balance + Math.max(0, cycles) : null;
  const thr = r.thresholdEff;
  let unfreezes: boolean | null = null;
  if (after != null && thr != null && thr > 0 && (r.state === "frozen" || r.state === "uninstalled")) {
    unfreezes = after >= thr;
    if (mode === "keep_alive") {
      if (unfreezes) warnings.push({ code: "would_unfreeze", level: "danger", text: `This amount lifts the balance to ${fmtCyclesShort(after)}, at or above the freezing threshold of ${fmtCyclesShort(thr)}. The canister would UNFREEZE and start burning at its normal rate, which is the opposite of keep alive. Lower the amount or switch to Revive.` });
      else if (r.cap != null && after > r.cap) warnings.push({ code: "above_safe_band", level: "warn", text: `This lifts the balance to ${Math.round((after / thr) * 100)}% of the freezing threshold. Keep alive normally stops at ${Math.round(r.fraction * 100)}% (${fmtCyclesShort(r.cap)}) because the threshold${r.estimated ? " is our estimate and" : ""} moves with memory use and subnet pricing, and the ICP/XDR rate can move before the cycles are minted.` });
    } else if (!unfreezes) {
      warnings.push({ code: "not_enough_to_revive", level: "warn", text: `This amount leaves the balance at ${fmtCyclesShort(after)}, still under the freezing threshold of ${fmtCyclesShort(thr)}. The canister would stay frozen: this would work as keep alive, not as a revival.` });
    }
  } else if (mode === "keep_alive" && (r.balance == null || thr == null)) {
    warnings.push({ code: "unfreeze_unknown", level: "warn", text: "The balance or the freezing threshold is unknown, so we cannot tell whether this amount would unfreeze the canister." });
  }
  if (r.state === "uninstalled") warnings.push({ code: "uninstalled", level: "danger", text: UNINSTALLED_TEXT });
  return { ok: errors.length === 0, errors, warnings, afterCycles: after, unfreezes, requiresAck: r.state === "uninstalled" };
}

/** Preservation time a number of cycles buys at a given idle burn, in days. Null when idle burn is unknown. */
export const preservationDays = (cycles: number | null | undefined, idleBurnPerDay: number | null | undefined): number | null =>
  cycles != null && idleBurnPerDay != null && idleBurnPerDay > 0 ? cycles / idleBurnPerDay : null;
