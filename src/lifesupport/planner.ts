// Life support planner. Pure functions only: no I/O, no clock, no randomness. Fully unit tested
// and driven by the long-run simulation in test/lifesupport.test.ts.
//
// Goal: PRESERVATION, not restoration. A frozen canister burns only its idle (storage) cost. At
// zero cycles it is uninstalled and its state is deleted. The planner sizes small top-ups that keep
// the balance above zero but well BELOW the freezing threshold, so the canister stays frozen (the
// cheapest state in which it still exists) and a top-up can never unfreeze it.
//
//   T       = idle_burn_per_day * freezing_threshold_s / 86400      (freezing threshold in cycles)
//   T_eff   = T - reserved_cycles (when known)                      (the replica subtracts reserved cycles)
//   H       = min(highWaterDays * idle, safetyFraction * T_eff)     (refill target, high water)
//   L       = min(max(lowWaterDays * idle, minLowWater), H / 2)     (refill trigger, low water)
//   amount  = H - balance, only when balance < L
//
// With safetyFraction = 0.45 even a complete duplicate of a top-up (the worst realistic failure:
// a double spend, or a bogus reading of zero while the true balance sits at high water) plus a 10%
// conversion-rate slip lands at 0.99 T_eff, still frozen. That inequality is asserted for every
// plan (see worstCaseAfterCycles) and the amount is shrunk if it would not hold.
import { DAY, type RunStatus } from "../lib/health";

export const TRILLION = 1e12;
/** ICP ledger transfer fee, verified live with icrc1_fee on ryjl3-tyaaa-aaaaa-aaaba-cai: 10_000 e8s. */
export const ICP_FEE_E8S = 10_000;
export const E8S = 1e8;
/** Fallback only, used for display when no ICP/USD price is available. 1 XDR is about 1.37 USD. */
export const USD_PER_XDR_FALLBACK = 1.37;

export interface PlannerParams {
  /** High water is at most this fraction of the effective freezing threshold (reported idle burn). */
  safetyFraction: number;
  /** Stricter fraction when idle burn is our own estimate (blackhole source reports none). */
  estimatedSafetyFraction: number;
  /** Refill when fewer than this many days of idle burn remain. Also the outage tolerance. */
  lowWaterDays: number;
  /** Never prepay more than this many days, even when the threshold would allow it. */
  highWaterDays: number;
  minLowWaterCycles: number;
  /** High water must buy at least this many days, otherwise the threshold is too short to hold safely. */
  minRunwayDays: number;
  maxReadingAgeS: number;
  /** A second, older measured reading must agree with the fresh one. */
  maxPriorAgeS: number;
  minPriorGapS: number;
  /** Allowed disagreement between readings, as a fraction of T_eff (plus one day of idle burn). */
  consistencyFraction: number;
  minIntervalS: number;
  minTopUpCycles: number;
  /**
   * A top-up must deliver at least this multiple of what the ledger fee costs. The default is low on purpose:
   * a tiny canister with a short threshold is fee-dominated but still costs well under a cent a month, and
   * the caps bound absolute spend. This only rejects dust, where the fee is more than 10x the cycles delivered.
   */
  minFeeMultiple: number;
  /** Tolerated ICP/XDR rate move between planning and minting. */
  rateSlack: number;
  maxRateAgeS: number;
  minEstimateCoverageS: number;
  /** Certified controller sources only. "metrics" is self-reported by the canister and carries no threshold. */
  allowedSources: string[];
}

export const DEFAULT_PARAMS: PlannerParams = {
  safetyFraction: 0.45,
  estimatedSafetyFraction: 0.3,
  lowWaterDays: 5,
  highWaterDays: 30,
  minLowWaterCycles: 1e8,
  minRunwayDays: 2,
  maxReadingAgeS: 2 * 3600,
  maxPriorAgeS: 48 * 3600,
  minPriorGapS: 600,
  consistencyFraction: 0.05,
  minIntervalS: 2 * DAY,
  minTopUpCycles: 2e7,
  minFeeMultiple: 0.1,
  rateSlack: 0.1,
  maxRateAgeS: 6 * 3600,
  minEstimateCoverageS: 3 * DAY,
  allowedSources: ["sns-root", "nns-root", "blackhole"],
};

export type PlanCode =
  | "topup"
  | "kill_switch" | "not_enrolled" | "not_active"
  | "reading_missing" | "reading_not_measured" | "reading_stale"
  | "threshold_unknown" | "idle_unknown" | "idle_zero"
  | "not_frozen" | "in_band" | "threshold_too_short"
  | "no_corroboration" | "reading_inconsistent" | "too_soon"
  | "rate_unknown" | "below_min"
  | "above_max_single" | "budget_exceeded" | "global_cap_exceeded" | "daily_cap_exceeded";

/** none: routine. flag: a human should look. halt: the engine must engage the kill switch. */
export type Severity = "none" | "flag" | "halt";

export interface PlanReading {
  ts: number;
  cycles: number | null;
  source: string;
  confidence: string;
  idleBurnPerDay: number | null;
  freezingThresholdS: number | null;
  reservedCycles?: number | null;
  /** Verdict of an ingress probe taken with this reading, when there is one. */
  probeStatus?: RunStatus | null;
}

export interface PlanInput {
  now: number;
  canisterId: string;
  enrollment: { state: string; budgetCycles: number; spentCycles: number } | null;
  reading: PlanReading | null;
  /** An older measured balance (collector history). Required: nothing is spent on a single reading. */
  prior: { ts: number; cycles: number } | null;
  /** Idle burn estimated from our own readings while the canister was frozen (blackhole source). */
  idleEstimate?: { perDay: number; coverageS: number; frozenThroughout: boolean } | null;
  /** Our last top-up of this canister. afterCycles is the verified post-top-up reading. */
  lastTopUp?: { ts: number; afterCycles: number | null } | null;
  rate: { xdrPermyriadPerIcp: number; ts: number } | null;
  usdPerXdr?: number | null;
  budget: {
    killSwitch: boolean;
    globalCapCycles: number;
    globalSpentCycles: number;
    dailyCapCycles: number;
    spentLast24hCycles: number;
    maxSingleTopUpCycles: number;
  };
  params?: Partial<PlannerParams>;
}

export interface MonthlyCost { cycles: number; icp: number | null; usd: number | null; topUpsPerMonth: number; feeCycles: number }

export interface Plan {
  action: "topup" | "skip";
  code: PlanCode;
  severity: Severity;
  rationale: string;
  canisterId: string;
  balanceCycles: number | null;
  idleBurnPerDay: number | null;
  idleSource: "reported" | "estimated" | null;
  thresholdCycles: number | null;
  effectiveThresholdCycles: number | null;
  lowWaterCycles: number | null;
  highWaterCycles: number | null;
  /** Cycles the CMC will mint for icpE8s at the planning rate. Zero unless action is "topup". */
  amountCycles: number;
  /** What the engine would send if every gate were open. Set even when a budget gate or the kill switch refuses. */
  proposedCycles: number;
  partial: boolean;
  icpE8s: number;
  feeE8s: number;
  /** Amount plus the ledger fee, in cycles. This is what budgets and caps are charged. */
  costCycles: number;
  costIcp: number | null;
  costUsd: number | null;
  xdrPermyriadPerIcp: number | null;
  expectedAfterCycles: number | null;
  /** Balance if the top-up were applied twice and the rate slipped by rateSlack. Always below T_eff. */
  worstCaseAfterCycles: number | null;
  runwayDaysBefore: number | null;
  runwayDaysAfter: number | null;
  daysBought: number | null;
  monthly: MonthlyCost | null;
}

const fmtT = (c: number | null | undefined) => (c == null ? "unknown" : c >= 1e11 ? `${(c / TRILLION).toFixed(3)} T` : c >= 1e8 ? `${(c / 1e9).toFixed(2)} B` : `${(c / 1e6).toFixed(1)} M`);

/** Cycles minted by the CMC for a number of e8s: e8s * xdr_permyriad_per_icp (1 XDR = 1T cycles). */
export const cyclesForE8s = (e8s: number, xdrPermyriadPerIcp: number) => e8s * xdrPermyriadPerIcp;
/** Rounded DOWN, so the minted amount never exceeds the planned amount. */
export const e8sForCycles = (cycles: number, xdrPermyriadPerIcp: number) => Math.floor(cycles / xdrPermyriadPerIcp);

export function band(idle: number, thresholdEff: number, estimated: boolean, p: PlannerParams): { low: number; high: number } {
  const high = Math.min(p.highWaterDays * idle, (estimated ? p.estimatedSafetyFraction : p.safetyFraction) * thresholdEff);
  const low = Math.min(Math.max(p.lowWaterDays * idle, p.minLowWaterCycles), high / 2);
  return { low, high };
}

/**
 * Steady-state preservation cost per 30 days: the idle burn itself plus one ledger fee per refill.
 * Used for plans, the public registry, and candidate estimates (no enrollment needed).
 */
export function monthlyCost(idle: number, thresholdS: number, rate: number | null, usdPerXdr: number | null | undefined, params?: Partial<PlannerParams>, estimated = false): MonthlyCost | null {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (!(idle > 0) || !(thresholdS > 0)) return null;
  const { low, high } = band(idle, (idle * thresholdS) / DAY, estimated, p);
  const perRefill = high - low;
  const topUps = perRefill > 0 ? (30 * idle) / perRefill : 0;
  const feeCycles = rate ? ICP_FEE_E8S * rate : 0;
  const cycles = 30 * idle + topUps * feeCycles;
  const icp = rate ? cycles / rate / E8S : null;
  const usd = (cycles / TRILLION) * (usdPerXdr ?? USD_PER_XDR_FALLBACK);
  return { cycles, icp, usd, topUpsPerMonth: topUps, feeCycles };
}

export function planTopUp(input: PlanInput): Plan {
  const p: PlannerParams = { ...DEFAULT_PARAMS, ...input.params };
  const { now, reading, enrollment, budget } = input;
  const plan: Plan = {
    action: "skip", code: "not_enrolled", severity: "none", rationale: "", canisterId: input.canisterId,
    balanceCycles: reading?.cycles ?? null, idleBurnPerDay: null, idleSource: null, thresholdCycles: null, effectiveThresholdCycles: null,
    lowWaterCycles: null, highWaterCycles: null, amountCycles: 0, proposedCycles: 0, partial: false, icpE8s: 0, feeE8s: 0, costCycles: 0,
    costIcp: null, costUsd: null, xdrPermyriadPerIcp: input.rate?.xdrPermyriadPerIcp ?? null, expectedAfterCycles: null, worstCaseAfterCycles: null,
    runwayDaysBefore: null, runwayDaysAfter: null, daysBought: null, monthly: null,
  };
  const skip = (code: PlanCode, rationale: string, severity: Severity = "none"): Plan => ({ ...plan, action: "skip", code, rationale, severity });

  // ---- 1. enrollment ---------------------------------------------------------------------------
  if (!enrollment) return skip("not_enrolled", "Not enrolled in life support. Nothing is ever sent to a canister that was not enrolled by an admin.");
  if (enrollment.state !== "active") return skip("not_active", `Enrollment state is "${enrollment.state}", only "active" canisters are funded.`);

  // ---- 2. the reading must be measured, certified, and fresh -------------------------------------
  if (!reading || reading.cycles == null || !Number.isFinite(reading.cycles) || reading.cycles < 0) return skip("reading_missing", "No balance reading is available, so nothing can be computed safely.");
  if (reading.confidence !== "measured" || !p.allowedSources.includes(reading.source)) {
    return skip("reading_not_measured", `Reading source "${reading.source}" (${reading.confidence}) is not a certified controller reading. Inferred, probed, or self-reported balances are never acted on.`);
  }
  const age = now - reading.ts;
  if (age > p.maxReadingAgeS || age < -300) return skip("reading_stale", `Reading is ${Math.round(age / 60)} min old, the limit is ${Math.round(p.maxReadingAgeS / 60)} min.`);
  const balance = reading.cycles;

  // ---- 3. threshold and idle burn ------------------------------------------------------------------
  if (reading.freezingThresholdS == null || !(reading.freezingThresholdS > 0)) return skip("threshold_unknown", "The freezing threshold is unknown (or zero), so the freeze line cannot be computed. Skipping is the only safe choice.");
  let idle = reading.idleBurnPerDay;
  let estimated = false;
  if (idle === 0) return skip("idle_zero", "Idle burn is exactly zero (system subnet or an empty canister). It costs nothing to exist, so there is nothing to preserve.");
  if (idle == null || !(idle > 0)) {
    const est = input.idleEstimate;
    if (!est || !(est.perDay > 0) || est.coverageS < p.minEstimateCoverageS || !est.frozenThroughout) {
      return skip("idle_unknown", `This source reports no idle burn, and our own frozen-burn history is insufficient (need ${Math.round(p.minEstimateCoverageS / DAY)} days observed while frozen). Cannot compute safely, skipping.`);
    }
    idle = est.perDay;
    estimated = true;
  }
  const threshold = (idle * reading.freezingThresholdS) / DAY;
  const reserved = reading.reservedCycles != null && reading.reservedCycles > 0 ? reading.reservedCycles : 0;
  const thresholdEff = threshold - reserved;
  plan.idleBurnPerDay = idle;
  plan.idleSource = estimated ? "estimated" : "reported";
  plan.thresholdCycles = threshold;
  plan.effectiveThresholdCycles = Math.max(0, thresholdEff);
  plan.runwayDaysBefore = balance / idle;
  plan.monthly = monthlyCost(idle, reading.freezingThresholdS, input.rate?.xdrPermyriadPerIcp ?? null, input.usdPerXdr, p, estimated);

  // ---- 4. frozen or nothing ------------------------------------------------------------------------
  // A running canister is never topped up: that would be restoration, it burns at the full rate, and
  // anyone could grief the budget by pointing us at busy canisters.
  const hadTopUp = !!input.lastTopUp;
  if (thresholdEff <= 0) return skip("not_frozen", "Reserved cycles cover the whole freezing threshold, so this canister cannot be frozen by its balance.");
  if (balance >= thresholdEff) {
    return skip("not_frozen", hadTopUp
      ? `Balance ${fmtT(balance)} is at or above the freezing threshold ${fmtT(thresholdEff)} although we were preserving it below. Someone else topped it up or the threshold changed. Doing nothing further.`
      : `Balance ${fmtT(balance)} is at or above the freezing threshold ${fmtT(thresholdEff)}: the canister is not frozen. Life support never funds a running canister.`,
    hadTopUp ? "halt" : "none");
  }
  const probe = reading.probeStatus ?? null;
  const probeFrozen = probe === "frozen" || probe === "out_of_cycles";
  if (probe === "running") return skip("not_frozen", `Balance ${fmtT(balance)} is under the computed threshold ${fmtT(thresholdEff)} but a live probe says the canister is running. The threshold model is wrong for this canister, so nothing is sent.`, hadTopUp ? "halt" : "flag");
  if (probe === "deleted" || probe === "no_wasm") return skip("not_frozen", "The canister is already uninstalled or deleted. There is nothing left to preserve.", "flag");
  if (estimated && !probeFrozen) return skip("idle_unknown", "Idle burn is an estimate, so a live probe must confirm the canister is frozen. No frozen probe verdict is available.");

  // ---- 5. the band -----------------------------------------------------------------------------------
  const { low, high } = band(idle, thresholdEff, estimated, p);
  plan.lowWaterCycles = low;
  plan.highWaterCycles = high;
  if (high / idle < p.minRunwayDays) {
    return skip("threshold_too_short", `High water ${fmtT(high)} is only ${(high / idle).toFixed(2)} days of idle burn (freezing threshold ${(reading.freezingThresholdS / DAY).toFixed(1)} days). A missed tick could delete it and a small error could unfreeze it. Needs a human decision.`, "flag");
  }
  if (balance >= low) return skip("in_band", `Balance ${fmtT(balance)} is inside the band (low ${fmtT(low)}, high ${fmtT(high)}, threshold ${fmtT(thresholdEff)}): ${(balance / idle).toFixed(1)} days of runway, no top-up needed.`);

  // ---- 6. corroboration and rate limiting --------------------------------------------------------
  const tolerance = p.consistencyFraction * thresholdEff + idle;
  let ref = input.prior;
  const last = input.lastTopUp ?? null;
  if (last && last.afterCycles != null && (!ref || ref.ts < last.ts)) ref = { ts: last.ts, cycles: last.afterCycles };
  if (!ref || now - ref.ts > p.maxPriorAgeS && !(last && ref.ts === last.ts) || reading.ts - ref.ts < p.minPriorGapS) {
    return skip("no_corroboration", "Spending needs two measured readings that agree. There is no suitable earlier reading yet, waiting for the next one.");
  }
  if (ref.cycles >= thresholdEff) return skip("no_corroboration", `The earlier reading (${fmtT(ref.cycles)}) was still above the freezing threshold. Waiting until the canister has been observed frozen on two separate readings.`);
  const expected = Math.max(0, ref.cycles - (idle * (reading.ts - ref.ts)) / DAY);
  if (Math.abs(balance - expected) > tolerance) {
    const lost = balance < expected;
    return skip("reading_inconsistent", `Balance ${fmtT(balance)} does not match the ${fmtT(expected)} expected from the earlier reading and idle burn (tolerance ${fmtT(tolerance)}). ${lost ? "Cycles are disappearing faster than idle burn explains" : "Someone else added cycles"}: not spending on a reading that does not add up.`, lost ? (hadTopUp ? "halt" : "flag") : "none");
  }
  // Second anchor: our own verified post-top-up balance. A reading far BELOW what that predicts would inflate
  // the next top-up, so it halts everything. (A reading above it is the safe direction: the top-up shrinks.)
  if (last && last.afterCycles != null) {
    const dtDays = Math.max(0, reading.ts - last.ts) / DAY;
    const expectedFromLast = last.afterCycles - idle * dtDays;
    if (balance < expectedFromLast - (tolerance + 0.25 * idle * dtDays)) {
      return skip("reading_inconsistent", `Balance ${fmtT(balance)} is far below the ${fmtT(Math.max(0, expectedFromLast))} expected from our last verified top-up ${dtDays.toFixed(1)} days ago. Either cycles are vanishing or the reading is wrong. Not spending.`, "halt");
    }
  }
  if (last) {
    const minInterval = Math.min(p.minIntervalS, (0.5 * (high - low) / idle) * DAY);
    if (now - last.ts < minInterval) {
      // The reading already agreed with the last top-up (checked above), so this is a partial top-up or
      // a changed band, not missing cycles. Waiting is safe: low water still holds days of runway.
      return skip("too_soon", `Last top-up was ${((now - last.ts) / 3600).toFixed(1)} h ago and the balance is already under low water. One refill should last about ${((high - low) / idle).toFixed(1)} days. Rate limited: waiting out the minimum interval.`, "flag");
    }
  }

  // ---- 7. size the top-up ----------------------------------------------------------------------------
  const rate = input.rate;
  if (!rate || !(rate.xdrPermyriadPerIcp > 0) || now - rate.ts > p.maxRateAgeS) return skip("rate_unknown", "No fresh ICP/XDR conversion rate from the cycles minting canister, so the ICP amount cannot be computed.");
  const r = rate.xdrPermyriadPerIcp;
  const feeCycles = ICP_FEE_E8S * r;
  let want = high - balance;
  // Worst case: the whole top-up lands twice and the rate slips in our disfavor. Must stay frozen.
  const maxSafe = ((thresholdEff - balance) / (2 * (1 + p.rateSlack))) * 0.999;
  if (want > maxSafe) want = maxSafe;
  plan.proposedCycles = Math.max(0, want);
  const minAmount = Math.max(p.minTopUpCycles, feeCycles * p.minFeeMultiple);
  if (want < minAmount) {
    return skip("below_min", `The safe top-up (${fmtT(want)}) is below the minimum sensible amount ${fmtT(minAmount)} (the ledger fee alone is worth ${fmtT(feeCycles)}). This canister is too small to fund efficiently at current settings.`, "flag");
  }

  // Budget gates, charged on cost (amount plus ledger fee). Partial amounts are allowed only when they
  // still lift the balance to low water, otherwise the money buys nothing durable.
  const limits: [PlanCode, number][] = [
    ["above_max_single", budget.maxSingleTopUpCycles],
    ["budget_exceeded", enrollment.budgetCycles - enrollment.spentCycles],
    ["global_cap_exceeded", budget.globalCapCycles - budget.globalSpentCycles],
    ["daily_cap_exceeded", budget.dailyCapCycles - budget.spentLast24hCycles],
  ];
  let amount = want;
  let binding: PlanCode | null = null;
  for (const [code, room] of limits) {
    if (amount + feeCycles > room) {
      amount = room - feeCycles;
      binding = code;
    }
  }
  if (binding && (amount < minAmount || balance + amount < low)) {
    const room = limits.find(([c]) => c === binding)![1];
    const what = { above_max_single: "the per-top-up maximum", budget_exceeded: "this canister's remaining budget", global_cap_exceeded: "the remaining global cap", daily_cap_exceeded: "the remaining 24 h cap" }[binding as "above_max_single"];
    return skip(binding, `Needs ${fmtT(want + feeCycles)} but ${what} is ${fmtT(Math.max(0, room))}. A partial top-up would not reach low water ${fmtT(low)}, so nothing is sent.`, "flag");
  }

  const e8s = e8sForCycles(amount, r);
  const delivered = cyclesForE8s(e8s, r);
  const cost = delivered + feeCycles;
  const after = balance + delivered;
  const worst = balance + 2 * delivered * (1 + p.rateSlack);
  // Belt and braces: these hold by construction. If they ever do not, refuse loudly.
  if (!(worst < thresholdEff) || !(after <= high + 1) || !(delivered > 0)) return skip("threshold_too_short", "Internal safety check failed: the computed top-up would not stay safely below the freezing threshold.", "halt");

  const usdPerXdr = input.usdPerXdr ?? USD_PER_XDR_FALLBACK;
  const sized: Plan = {
    ...plan,
    amountCycles: delivered, proposedCycles: want, partial: binding != null, icpE8s: e8s, feeE8s: ICP_FEE_E8S, costCycles: cost,
    costIcp: (e8s + ICP_FEE_E8S) / E8S, costUsd: (cost / TRILLION) * usdPerXdr,
    expectedAfterCycles: after, worstCaseAfterCycles: worst, runwayDaysAfter: after / idle, daysBought: delivered / idle,
  };
  const text = `Frozen with ${fmtT(balance)} left (${(balance / idle).toFixed(1)} days at ${fmtT(idle)}/day${estimated ? ", estimated" : ""}), under low water ${fmtT(low)}. `
    + `Threshold ${fmtT(thresholdEff)}, high water ${fmtT(high)}. Send ${fmtT(delivered)}${binding ? " (partial, limited by " + binding + ")" : ""} = ${(e8s / E8S).toFixed(8)} ICP + 0.0001 fee at ${(r / 1e4).toFixed(4)} XDR/ICP, `
    + `landing at ${fmtT(after)} = ${((after / thresholdEff) * 100).toFixed(0)}% of threshold, ${(delivered / idle).toFixed(1)} days bought. Worst case (applied twice, rate +${Math.round(p.rateSlack * 100)}%) ${fmtT(worst)} is still frozen.`;
  if (budget.killSwitch) return { ...sized, action: "skip", code: "kill_switch", amountCycles: 0, rationale: `Kill switch engaged, nothing is sent. Would have: ${text}` };
  return { ...sized, action: "topup", code: "topup", rationale: text };
}

// ---- pure budget ledger (mirrors the D1 constraints, used by the simulation) ---------------------------

export interface BudgetState { killSwitch: boolean; globalCapCycles: number; globalSpentCycles: number; budgetCycles: number; spentCycles: number; periods: Set<string> }

/**
 * Reserve spend exactly the way the database does: all or nothing, refusing when the kill switch is
 * engaged, a cap would be crossed, or the canister already had an attempt in this period.
 */
export function reserve(b: BudgetState, canisterId: string, costCycles: number, now: number): { ok: true } | { ok: false; reason: string } {
  const key = `${canisterId}:${periodKey(now)}`;
  if (b.killSwitch) return { ok: false, reason: "kill switch engaged" };
  if (!(costCycles > 0)) return { ok: false, reason: "non-positive cost" };
  if (b.periods.has(key)) return { ok: false, reason: "already attempted in this period" };
  if (b.globalSpentCycles + costCycles > b.globalCapCycles) return { ok: false, reason: "global cap" };
  if (b.spentCycles + costCycles > b.budgetCycles) return { ok: false, reason: "canister budget" };
  b.periods.add(key);
  b.globalSpentCycles += costCycles;
  b.spentCycles += costCycles;
  return { ok: true };
}

/** One live attempt per canister per UTC day, enforced by a UNIQUE index. */
export const periodKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

// ---- post top-up verification ----------------------------------------------------------------------------

export interface VerifyInput {
  beforeCycles: number;
  mintedCycles: number;
  elapsedS: number;
  idleBurnPerDay: number;
  after: { cycles: number | null; idleBurnPerDay: number | null; freezingThresholdS: number | null; reservedCycles?: number | null; probeStatus?: RunStatus | null } | null;
  /** Threshold at planning time, used when the new reading carries no idle burn (blackhole). */
  plannedThresholdCycles: number;
}
export interface VerifyResult { ok: boolean; problems: string[]; afterCycles: number | null; thresholdCycles: number | null; stillFrozen: boolean | null }

/** After a live top-up: the balance must have risen by about the minted amount AND the canister must still be frozen. */
export function verifyTopUp(v: VerifyInput): VerifyResult {
  const problems: string[] = [];
  if (!v.after || v.after.cycles == null) return { ok: false, problems: ["post top-up reading is missing"], afterCycles: null, thresholdCycles: null, stillFrozen: null };
  const after = v.after.cycles;
  const idle = v.after.idleBurnPerDay != null && v.after.idleBurnPerDay > 0 ? v.after.idleBurnPerDay : null;
  const thr = idle != null && v.after.freezingThresholdS != null ? (idle * v.after.freezingThresholdS) / DAY - Math.max(0, v.after.reservedCycles ?? 0) : v.plannedThresholdCycles;
  const burned = (v.idleBurnPerDay * v.elapsedS) / DAY;
  const rise = after - v.beforeCycles;
  const slack = Math.max(0.1 * v.mintedCycles, 2 * burned + 1e6);
  if (rise <= 0) problems.push(`balance did not move (before ${fmtT(v.beforeCycles)}, after ${fmtT(after)})`);
  else if (rise < v.mintedCycles - slack) problems.push(`balance rose by ${fmtT(rise)}, less than the ${fmtT(v.mintedCycles)} minted`);
  else if (rise > v.mintedCycles + slack) problems.push(`balance rose by ${fmtT(rise)}, more than the ${fmtT(v.mintedCycles)} minted: someone else is also funding it`);
  const underThreshold = after < thr;
  if (!underThreshold) problems.push(`balance ${fmtT(after)} is at or above the freezing threshold ${fmtT(thr)}: the canister is no longer frozen`);
  const probe = v.after.probeStatus ?? null;
  if (probe === "running") problems.push("live probe says the canister is running: it unfroze");
  if (probe === "deleted" || probe === "no_wasm") problems.push("live probe says the canister is gone");
  const stillFrozen = underThreshold && probe !== "running";
  return { ok: problems.length === 0, problems, afterCycles: after, thresholdCycles: thr, stillFrozen };
}
