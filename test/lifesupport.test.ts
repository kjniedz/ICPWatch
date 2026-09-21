// Life support tests. Nothing here touches the network or spends anything: the planner is pure, the
// simulation is deterministic, and the engine runs against an in-memory SQLite (node:sqlite) wearing
// a D1 costume, with a fake funder that records calls instead of signing them.
import { describe, expect, it } from "vitest";
import { DAY } from "../src/lib/health";
import {
  DEFAULT_PARAMS, ICP_FEE_E8S, band, monthlyCost, periodKey, planTopUp, reserve, verifyTopUp,
  type BudgetState, type Plan, type PlanInput,
} from "../src/lifesupport/planner";
import { enroll, lifeSupportTick, liveGate, loadSettings, registry, setCaps, setEnrollmentState, setKillSwitch, status, type Deps, type LifeSupportEnv } from "../src/lifesupport/engine";
import { fundingPrincipal, parseSeed, topUpMemo, topUpSubaccount, type Funder } from "../src/lifesupport/funding";
import type { StatusReading } from "../src/lib/ic";

// Node built-ins are loaded through a variable specifier: the project has no @types/node (it targets
// workerd), and this keeps `tsc --noEmit` clean without adding a dependency.
interface SqlStmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint } }
interface DatabaseSync { exec(sql: string): void; prepare(sql: string): SqlStmt }
const builtin = (name: string) => import(/* @vite-ignore */ name);
const { readFileSync } = (await builtin("node:fs")) as { readFileSync(path: string, enc: string): string };
const { DatabaseSync } = (await builtin("node:sqlite")) as { DatabaseSync: new (path: string) => DatabaseSync };

const T = 1e12;
const NOW = 1_790_000_000;
const RATE = 21_600; // 2.16 XDR per ICP
const CAN = "ryjl3-tyaaa-aaaaa-aaaba-cai";

// The worked example from docs/LIFE_SUPPORT.md: idle burn 0.002 T/day, 30 day threshold, T = 0.06 T.
const IDLE = 0.002 * T;
const THR_S = 30 * DAY;

const input = (o: Partial<PlanInput> & { cycles?: number } = {}): PlanInput => {
  const cycles = o.cycles ?? 0.004 * T; // 2 days of runway: under low water (5 days = 0.01 T)
  return {
    now: NOW, canisterId: CAN,
    enrollment: { state: "active", budgetCycles: 1 * T, spentCycles: 0 },
    reading: { ts: NOW - 60, cycles, source: "sns-root", confidence: "measured", idleBurnPerDay: IDLE, freezingThresholdS: THR_S, probeStatus: "frozen" },
    prior: { ts: NOW - 3660, cycles: cycles + IDLE / 24 },
    lastTopUp: null,
    rate: { xdrPermyriadPerIcp: RATE, ts: NOW - 120 },
    usdPerXdr: 1.37,
    budget: { killSwitch: false, globalCapCycles: 1 * T, globalSpentCycles: 0, dailyCapCycles: 0.25 * T, spentLast24hCycles: 0, maxSingleTopUpCycles: 0.1 * T },
    ...o,
  };
};

describe("planner: the math", () => {
  it("computes threshold, band, amount, runway, and cost for the worked example", () => {
    const p = planTopUp(input());
    expect(p.action).toBe("topup");
    expect(p.thresholdCycles).toBeCloseTo(0.06 * T, -3);
    expect(p.highWaterCycles).toBeCloseTo(0.027 * T, -3); // 0.45 * T, tighter than 30 days of idle burn (0.06 T)
    expect(p.lowWaterCycles).toBeCloseTo(0.01 * T, -3); // 5 days of idle burn
    expect(p.amountCycles).toBeGreaterThan(0.0229 * T);
    expect(p.amountCycles).toBeLessThanOrEqual(0.023 * T);
    expect(p.amountCycles % RATE).toBe(0); // whole e8s, rounded down
    expect(p.icpE8s).toBe(Math.floor((0.023 * T) / RATE));
    expect(p.costCycles).toBe(p.amountCycles + ICP_FEE_E8S * RATE);
    expect(p.expectedAfterCycles!).toBeLessThanOrEqual(0.027 * T);
    expect(p.daysBought).toBeCloseTo(11.5, 1);
    expect(p.costIcp).toBeCloseTo(0.023 / 2.16 + 0.0001, 5);
    expect(p.costUsd).toBeCloseTo((0.023 + 0.000216) * 1.37, 4);
    expect(p.rationale).toMatch(/still frozen/);
  });

  it("monthly cost is idle burn plus one ledger fee per refill", () => {
    const m = monthlyCost(IDLE, THR_S, RATE, 1.37)!;
    const { low, high } = band(IDLE, 0.06 * T, false, DEFAULT_PARAMS);
    expect(m.topUpsPerMonth).toBeCloseTo((30 * IDLE) / (high - low), 6);
    expect(m.cycles).toBeCloseTo(0.06 * T + m.topUpsPerMonth * ICP_FEE_E8S * RATE, -3);
    expect(m.usd).toBeCloseTo(0.0832, 3); // about 8 cents a month
    expect(m.icp).toBeCloseTo(0.0281, 3);
  });

  it("the post top-up balance stays strictly below T even if the top-up lands twice with a 10% rate slip", () => {
    for (const cycles of [0, 1, 0.001 * T, 0.0099 * T]) {
      for (const thr of [7 * DAY, 30 * DAY, 90 * DAY, 365 * DAY]) {
        const p = planTopUp(input({ cycles, reading: { ts: NOW - 60, cycles, source: "nns-root", confidence: "measured", idleBurnPerDay: IDLE, freezingThresholdS: thr, probeStatus: "frozen" }, prior: { ts: NOW - 3660, cycles: cycles + IDLE / 24 } }));
        if (p.action !== "topup") continue;
        const t = (IDLE * thr) / DAY;
        expect(p.expectedAfterCycles!).toBeLessThan(t * 0.4501);
        expect(cycles + 2 * p.amountCycles * 1.1).toBeLessThan(t);
        expect(p.worstCaseAfterCycles!).toBeLessThan(t);
      }
    }
  });

  it("caps prepayment at highWaterDays when the threshold is long", () => {
    const p = planTopUp(input({ reading: { ts: NOW - 60, cycles: 0.004 * T, source: "sns-root", confidence: "measured", idleBurnPerDay: IDLE, freezingThresholdS: 365 * DAY, probeStatus: "frozen" } }));
    expect(p.highWaterCycles).toBeCloseTo(30 * IDLE, -3);
  });

  it("subtracts reserved cycles from the threshold", () => {
    const p = planTopUp(input({ reading: { ts: NOW - 60, cycles: 0.004 * T, source: "sns-root", confidence: "measured", idleBurnPerDay: IDLE, freezingThresholdS: THR_S, reservedCycles: 0.02 * T, probeStatus: "frozen" } }));
    expect(p.effectiveThresholdCycles).toBeCloseTo(0.04 * T, -3);
    expect(p.highWaterCycles).toBeCloseTo(0.018 * T, -3);
  });
});

describe("planner: refusals", () => {
  const code = (o: Parameters<typeof input>[0]) => planTopUp(input(o));
  const reading = (o: Partial<NonNullable<PlanInput["reading"]>>) => ({ ...input().reading!, ...o });

  it("never tops up a running canister (that is restoration, and a griefing vector)", () => {
    const p = code({ cycles: 5 * T, prior: { ts: NOW - 3660, cycles: 5 * T } });
    expect([p.action, p.code, p.amountCycles, p.severity]).toEqual(["skip", "not_frozen", 0, "none"]);
    // exactly at the threshold counts as not frozen too
    expect(code({ cycles: 0.06 * T }).code).toBe("not_frozen");
    // balance under the computed line but a live probe says running: the model is wrong, do nothing, tell a human
    const q = code({ reading: reading({ probeStatus: "running" }) });
    expect([q.code, q.severity]).toEqual(["not_frozen", "flag"]);
  });

  it("does nothing while the balance is inside the band", () => {
    const p = code({ cycles: 0.015 * T, prior: { ts: NOW - 3660, cycles: 0.015 * T } });
    expect([p.action, p.code]).toEqual(["skip", "in_band"]);
  });

  it("skips when the threshold is unknown", () => {
    expect(code({ reading: reading({ freezingThresholdS: null }) }).code).toBe("threshold_unknown");
  });

  it("skips free canisters: idle burn of exactly zero (system subnet)", () => {
    expect(code({ reading: reading({ idleBurnPerDay: 0 }) }).code).toBe("idle_zero");
  });

  it("blackhole source has no idle burn: cannot compute safely unless our own frozen burn history is good enough", () => {
    const bh = reading({ source: "blackhole", idleBurnPerDay: null });
    expect(code({ reading: bh }).code).toBe("idle_unknown");
    expect(code({ reading: bh, idleEstimate: { perDay: IDLE, coverageS: 1 * DAY, frozenThroughout: true } }).code).toBe("idle_unknown"); // too little coverage
    expect(code({ reading: bh, idleEstimate: { perDay: IDLE, coverageS: 5 * DAY, frozenThroughout: false } }).code).toBe("idle_unknown"); // burn observed while running overstates idle
    expect(code({ reading: { ...bh, probeStatus: null }, idleEstimate: { perDay: IDLE, coverageS: 5 * DAY, frozenThroughout: true } }).code).toBe("idle_unknown"); // needs a frozen probe
    const ok = code({ reading: bh, idleEstimate: { perDay: IDLE, coverageS: 5 * DAY, frozenThroughout: true } });
    expect([ok.action, ok.idleSource]).toEqual(["topup", "estimated"]);
    expect(ok.highWaterCycles).toBeCloseTo(0.3 * 0.06 * T, -3); // stricter safety fraction for estimates
  });

  it("refuses when idle burn is huge: the per-top-up max cannot even reach low water", () => {
    const p = code({ cycles: 1 * T, reading: reading({ cycles: 1 * T, idleBurnPerDay: 5 * T }), prior: { ts: NOW - 3660, cycles: 1 * T + (5 * T) / 24 } });
    expect([p.action, p.code, p.severity]).toEqual(["skip", "above_max_single", "flag"]);
    expect(p.proposedCycles).toBeGreaterThan(60 * T);
  });

  it("refuses stale, inferred, and self-reported readings", () => {
    expect(code({ reading: reading({ ts: NOW - 3 * 3600 }) }).code).toBe("reading_stale");
    expect(code({ reading: reading({ confidence: "inferred" }) }).code).toBe("reading_not_measured");
    expect(code({ reading: reading({ source: "metrics" }) }).code).toBe("reading_not_measured");
    expect(code({ reading: reading({ cycles: null }) }).code).toBe("reading_missing");
    expect(code({ reading: null }).code).toBe("reading_missing");
  });

  it("budget nearly exhausted: partial only if it still reaches low water", () => {
    // Needs 0.023 T. 0.009 T left: a partial lands at 0.0128 T, above low water 0.01 T: allowed.
    const ok = code({ enrollment: { state: "active", budgetCycles: 1 * T, spentCycles: 0.991 * T } });
    expect([ok.action, ok.partial]).toEqual(["topup", true]);
    expect(ok.costCycles).toBeLessThanOrEqual(0.009 * T);
    expect(ok.expectedAfterCycles!).toBeGreaterThanOrEqual(0.01 * T);
    // 0.003 T left: a partial would land at 0.0068 T, under low water: nothing is sent.
    const no = code({ enrollment: { state: "active", budgetCycles: 1 * T, spentCycles: 0.997 * T } });
    expect([no.action, no.code, no.amountCycles]).toEqual(["skip", "budget_exceeded", 0]);
    expect(code({ budget: { ...input().budget, globalSpentCycles: 0.999 * T } }).code).toBe("global_cap_exceeded");
    expect(code({ budget: { ...input().budget, spentLast24hCycles: 0.249 * T } }).code).toBe("daily_cap_exceeded");
  });

  it("kill switch: computes the plan for display but sends nothing", () => {
    const p = code({ budget: { ...input().budget, killSwitch: true } });
    expect([p.action, p.code, p.amountCycles]).toEqual(["skip", "kill_switch", 0]);
    expect(p.proposedCycles).toBeGreaterThan(0.02 * T);
  });

  it("only enrolled, active canisters", () => {
    expect(code({ enrollment: null }).code).toBe("not_enrolled");
    expect(code({ enrollment: { state: "paused", budgetCycles: T, spentCycles: 0 } }).code).toBe("not_active");
    expect(code({ enrollment: { state: "adopted", budgetCycles: T, spentCycles: 0 } }).code).toBe("not_active");
  });

  it("needs two agreeing readings, both frozen", () => {
    expect(code({ prior: null }).code).toBe("no_corroboration");
    expect(code({ prior: { ts: NOW - 120, cycles: 0.004 * T } }).code).toBe("no_corroboration"); // too close together
    expect(code({ prior: { ts: NOW - 3660, cycles: 0.2 * T } }).code).toBe("no_corroboration"); // was still running an hour ago
    const lost = code({ prior: { ts: NOW - 3660, cycles: 0.03 * T } });
    expect([lost.code, lost.severity]).toEqual(["reading_inconsistent", "flag"]);
  });

  it("halts when the balance is far below what our last verified top-up predicts", () => {
    const p = code({ lastTopUp: { ts: NOW - 3 * DAY, afterCycles: 0.027 * T } }); // expected 0.021 T, reading says 0.004 T
    expect([p.code, p.severity]).toEqual(["reading_inconsistent", "halt"]);
  });

  it("halts when a canister we were preserving is found above its threshold", () => {
    const p = code({ cycles: 0.5 * T, lastTopUp: { ts: NOW - 5 * DAY, afterCycles: 0.027 * T } });
    expect([p.action, p.code, p.severity]).toEqual(["skip", "not_frozen", "halt"]);
  });

  it("refuses thresholds too short to hold safely, dust top-ups, and a missing or stale rate", () => {
    const short = code({ cycles: 0.001 * T, reading: reading({ cycles: 0.001 * T, freezingThresholdS: 2 * DAY }), prior: { ts: NOW - 3660, cycles: 0.001 * T + IDLE / 24 } });
    expect([short.code, short.severity]).toEqual(["threshold_too_short", "flag"]);
    const tiny = 1e6; // a 100 KB canister: the safe top-up is worth less than the ledger fee
    const dust = code({ cycles: 1e6, reading: reading({ cycles: 1e6, idleBurnPerDay: tiny }), prior: { ts: NOW - 3660, cycles: 1e6 + tiny / 24 } });
    expect(dust.code).toBe("below_min");
    expect(code({ rate: null }).code).toBe("rate_unknown");
    expect(code({ rate: { xdrPermyriadPerIcp: RATE, ts: NOW - DAY } }).code).toBe("rate_unknown");
  });
});

describe("verification after a top-up", () => {
  const base = { beforeCycles: 0.004 * T, mintedCycles: 0.023 * T, elapsedS: 20, idleBurnPerDay: IDLE, plannedThresholdCycles: 0.06 * T };
  const after = (cycles: number | null, probeStatus: "frozen" | "running" | null = "frozen") => ({ cycles, idleBurnPerDay: IDLE, freezingThresholdS: THR_S, probeStatus });
  it("passes when the balance rose by the minted amount and the canister is still frozen", () => {
    const v = verifyTopUp({ ...base, after: after(0.027 * T) });
    expect([v.ok, v.stillFrozen]).toEqual([true, true]);
  });
  it("fails when the balance did not move, the reading is missing, the canister unfroze, or someone else added cycles", () => {
    expect(verifyTopUp({ ...base, after: after(0.004 * T) }).problems[0]).toMatch(/did not move/);
    expect(verifyTopUp({ ...base, after: null }).ok).toBe(false);
    expect(verifyTopUp({ ...base, after: after(null) }).ok).toBe(false);
    const un = verifyTopUp({ ...base, after: after(0.07 * T) });
    expect([un.ok, un.stillFrozen]).toEqual([false, false]);
    expect(verifyTopUp({ ...base, after: after(0.027 * T, "running") }).stillFrozen).toBe(false);
    expect(verifyTopUp({ ...base, after: after(0.04 * T) }).problems[0]).toMatch(/someone else/);
  });
});

describe("funding helpers (no signing, no network)", () => {
  it("derives the CMC top-up subaccount: length byte, principal bytes, zero padding", () => {
    const sub = topUpSubaccount(CAN); // ryjl3-tyaaa-aaaaa-aaaba-cai = 00 00 00 00 00 00 00 02 01 01
    expect(sub.length).toBe(32);
    expect(Array.from(sub.slice(0, 11))).toEqual([10, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1]);
    expect(sub.slice(11).every((b) => b === 0)).toBe(true);
  });
  it("encodes the TPUP memo as 8 little-endian bytes", () => {
    expect(new TextDecoder().decode(topUpMemo().slice(0, 4))).toBe("TPUP");
    expect(new DataView(topUpMemo().buffer).getBigUint64(0, true)).toBe(0x50555054n);
  });
  it("parses hex and base64 seeds to the same principal and rejects bad lengths", () => {
    const hex = "00".repeat(31) + "07";
    const b64 = btoa(String.fromCharCode(...parseSeed(hex)));
    expect(fundingPrincipal(hex)).toBe(fundingPrincipal(b64));
    expect(fundingPrincipal(hex)).toMatch(/^[a-z0-9-]+$/);
    expect(() => parseSeed("abcd")).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Simulation: planner + budget layer against a model canister, hour by hour.

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface SimOpts {
  days: number; idle: number; thrS: number; start: number; budget: number; cap: number; seed?: number;
  /** mutate the world at the top of each hour */
  world?: (w: World, hour: number) => void;
  /** corrupt the reading the engine sees */
  lie?: (trueCycles: number, hour: number) => number;
}
interface World { balance: number; idle: number; thrS: number; rate: number; outage: boolean; mintSlip: number }
interface SimResult {
  minBalance: number; maxFractionOfT: number; unfrozenByUs: boolean; deleted: boolean; spent: number; topUps: { hour: number; cost: number; minted: number }[];
  predicted: number; halts: { hour: number; code: string }[]; codes: Record<string, number>; budget: BudgetState; world: World; maxWindowRatio: number;
}

function simulate(o: SimOpts): SimResult {
  const rand = rng(o.seed ?? 1);
  const w: World = { balance: o.start, idle: o.idle, thrS: o.thrS, rate: RATE, outage: false, mintSlip: 0.03 };
  const budget: BudgetState = { killSwitch: false, globalCapCycles: o.cap, globalSpentCycles: 0, budgetCycles: o.budget, spentCycles: 0, periods: new Set() };
  const res: SimResult = { minBalance: Infinity, maxFractionOfT: 0, unfrozenByUs: false, deleted: false, spent: 0, topUps: [], predicted: 0, halts: [], codes: {}, budget, world: w, maxWindowRatio: 0 };
  let prior: { ts: number; cycles: number } | null = null;
  let last: { ts: number; afterCycles: number | null } | null = null;
  const perDayPredicted: number[] = [];
  for (let h = 0; h < o.days * 24; h++) {
    const now = NOW + h * 3600;
    o.world?.(w, h);
    w.balance -= w.idle / 24;
    const t = (w.idle * w.thrS) / DAY;
    if (w.balance <= 0) { res.deleted = true; break; }
    res.minBalance = Math.min(res.minBalance, w.balance);
    if (h % 24 === 0) perDayPredicted.push(monthlyCost(w.idle, w.thrS, w.rate, 1.37)!.cycles / 30);
    if (w.outage) continue; // missed ticks: no reading, no plan
    const seen = Math.max(0, (o.lie ? o.lie(w.balance, h) : w.balance) * (1 + (rand() - 0.5) * 0.006));
    const spent24 = res.topUps.filter((x) => x.hour > h - 24).reduce((a, x) => a + x.cost, 0);
    const plan: Plan = planTopUp({
      now, canisterId: CAN, enrollment: { state: "active", budgetCycles: budget.budgetCycles, spentCycles: budget.spentCycles },
      reading: { ts: now, cycles: seen, source: "sns-root", confidence: "measured", idleBurnPerDay: w.idle, freezingThresholdS: w.thrS, probeStatus: w.balance < t ? "frozen" : "running" },
      prior, lastTopUp: last, rate: { xdrPermyriadPerIcp: w.rate, ts: now }, usdPerXdr: 1.37,
      budget: { killSwitch: budget.killSwitch, globalCapCycles: budget.globalCapCycles, globalSpentCycles: budget.globalSpentCycles, dailyCapCycles: 0.25 * T, spentLast24hCycles: spent24, maxSingleTopUpCycles: 0.1 * T },
    });
    res.codes[plan.code] = (res.codes[plan.code] ?? 0) + 1;
    prior = { ts: now, cycles: seen };
    if (plan.severity === "halt") { budget.killSwitch = true; res.halts.push({ hour: h, code: plan.code }); }
    if (plan.action !== "topup") continue;
    if (!reserve(budget, CAN, plan.costCycles, now).ok) continue;
    // The CMC mints at ITS rate at notify time, which has moved a little since planning.
    const minted = plan.icpE8s * w.rate * (1 + (rand() - 0.5) * 2 * w.mintSlip);
    const wasFrozen = w.balance < t;
    w.balance += minted;
    if (wasFrozen && w.balance >= t) res.unfrozenByUs = true;
    res.maxFractionOfT = Math.max(res.maxFractionOfT, w.balance / t);
    res.spent += plan.costCycles;
    res.topUps.push({ hour: h, cost: plan.costCycles, minted });
    last = { ts: now, afterCycles: w.balance };
    prior = { ts: now, cycles: w.balance };
  }
  res.predicted = perDayPredicted.reduce((a, b) => a + b, 0);
  // Worst rolling 30 day window of spend against the prediction for the same window.
  for (let d = 0; d + 30 <= perDayPredicted.length; d++) {
    const spend = res.topUps.filter((x) => x.hour >= d * 24 && x.hour < (d + 30) * 24).reduce((a, x) => a + x.cost, 0);
    const pred = perDayPredicted.slice(d, d + 30).reduce((a, b) => a + b, 0);
    res.maxWindowRatio = Math.max(res.maxWindowRatio, spend / pred);
  }
  return res;
}

describe("simulation: held frozen but alive, at predictable cost", () => {
  it("two years with noise, a missed-ticks outage, memory growth, a threshold change, and XDR rate moves", () => {
    let outageStart = -1;
    const r = simulate({
      days: 730, idle: IDLE, thrS: THR_S, start: 0.02 * T, budget: 2 * T, cap: 3 * T, seed: 7,
      world: (w, h) => {
        const d = h / 24;
        // Worst-timed outage: four days of missed ticks starting the moment a refill is due (low water is five days of runway).
        if (d >= 100 && outageStart < 0 && w.balance < 5.05 * w.idle) outageStart = h;
        w.outage = outageStart >= 0 && h < outageStart + 96;
        if (d === 200) w.idle = IDLE * 1.25; // memory grew (or the subnet repriced storage): T scales with it
        if (d === 300) w.rate = 15_000; // ICP fell: each cycle costs more ICP, same XDR
        if (d === 450) w.rate = 30_000;
        if (d === 500) w.thrS = 20 * DAY; // a controller lowered the freezing threshold: T shrinks by a third
      },
    });
    expect(r.deleted).toBe(false);
    expect(outageStart).toBeGreaterThan(0);
    expect(r.minBalance).toBeGreaterThan(0.5 * IDLE); // never closer than half a day to deletion, even through the outage
    expect(r.unfrozenByUs).toBe(false);
    expect(r.maxFractionOfT).toBeLessThan(0.5); // never above half the threshold
    expect(r.halts).toEqual([]);
    expect(r.spent).toBeLessThanOrEqual(2 * T);
    expect(r.budget.globalSpentCycles).toBe(r.budget.spentCycles);
    // Predictable: total spend within 5% of idle burn plus fees, and no 30 day window above 1.35x its prediction.
    expect(r.spent / r.predicted).toBeGreaterThan(0.95);
    expect(r.spent / r.predicted).toBeLessThan(1.05);
    expect(r.maxWindowRatio).toBeLessThan(1.35);
    expect(r.topUps.length).toBeGreaterThan(40);
    // about 8 cents a month: 0.06 T idle * 1.25 for most of the period
    const usdPerMonth = ((r.spent / T) * 1.37) / (730 / 30);
    expect(usdPerMonth).toBeGreaterThan(0.08);
    expect(usdPerMonth).toBeLessThan(0.12);
  });

  it("no runaway: when the budget runs out spending stops dead, and the cap is never crossed", () => {
    const r = simulate({ days: 365, idle: IDLE, thrS: THR_S, start: 0.02 * T, budget: 0.2 * T, cap: 0.15 * T });
    expect(r.spent).toBeLessThanOrEqual(0.15 * T);
    expect(r.budget.globalSpentCycles).toBeLessThanOrEqual(0.15 * T);
    expect(r.unfrozenByUs).toBe(false);
    expect(r.deleted).toBe(true); // an honest outcome: the money ran out, and the registry shows budget remaining long before
    expect((r.codes.global_cap_exceeded ?? 0) + (r.codes.budget_exceeded ?? 0)).toBeGreaterThan(0);
  });

  it("many parameter combinations: never deleted, never unfrozen, spend tracks the prediction", () => {
    for (const idle of [3e7, 5e8, IDLE, 0.004 * T]) {
      for (const thrDays of [7, 30, 90, 180]) {
        const thrS = thrDays * DAY;
        const r = simulate({ days: 365, idle, thrS, start: 0.2 * idle * thrDays, budget: 5 * T, cap: 5 * T, seed: thrDays });
        const label = `idle ${idle} thr ${thrDays}d`;
        expect(r.deleted, label).toBe(false);
        expect(r.unfrozenByUs, label).toBe(false);
        expect(r.maxFractionOfT, label).toBeLessThan(0.5);
        expect(r.halts, label).toEqual([]);
        expect(r.spent / r.predicted, label).toBeGreaterThan(0.9);
        expect(r.spent / r.predicted, label).toBeLessThan(1.1);
      }
    }
  });

  it("adversarial: someone else tops the canister up above T. We do nothing further and flag it", () => {
    const r = simulate({
      days: 200, idle: IDLE, thrS: THR_S, start: 0.02 * T, budget: 2 * T, cap: 3 * T,
      world: (w, h) => { if (h === 60 * 24) w.balance += 0.5 * T; },
    });
    const before = r.topUps.filter((x) => x.hour < 60 * 24).reduce((a, x) => a + x.cost, 0);
    expect(before).toBeGreaterThan(0);
    expect(r.spent).toBe(before); // not one cycle after the external top-up
    expect(r.unfrozenByUs).toBe(false); // it is running, but not because of us
    expect(r.halts[0]).toEqual({ hour: 60 * 24, code: "not_frozen" });
    expect(r.budget.killSwitch).toBe(true);
  });

  it("adversarial: flapping readings cannot drain the budget or trigger an oversized top-up", () => {
    // From day 20 every other reading claims the canister is nearly empty.
    const r = simulate({ days: 120, idle: IDLE, thrS: THR_S, start: 0.02 * T, budget: 2 * T, cap: 3 * T, lie: (c, h) => (h >= 20 * 24 && h % 2 === 0 ? c * 0.02 : c) });
    const honest = simulate({ days: 120, idle: IDLE, thrS: THR_S, start: 0.02 * T, budget: 2 * T, cap: 3 * T });
    expect(r.unfrozenByUs).toBe(false);
    expect(r.maxFractionOfT).toBeLessThan(0.5);
    expect(r.spent).toBeLessThanOrEqual(honest.spent); // lying about the balance never makes us spend more
    expect(r.halts.length).toBeGreaterThan(0); // and it trips the kill switch
    expect(r.halts[0]!.code).toBe("reading_inconsistent");
    expect(r.topUps.every((x) => x.hour < r.halts[0]!.hour)).toBe(true);
  });

  it("adversarial: consistently forged low readings right after a top-up are caught by the last-top-up anchor", () => {
    const r = simulate({ days: 60, idle: IDLE, thrS: THR_S, start: 0.02 * T, budget: 2 * T, cap: 3 * T, lie: (c, h) => (h >= 10 * 24 ? c * 0.02 : c) });
    expect(r.unfrozenByUs).toBe(false);
    expect(r.maxFractionOfT).toBeLessThan(0.5);
    expect(r.halts[0]!.code).toBe("reading_inconsistent");
    expect(r.topUps.filter((x) => x.hour >= 10 * 24)).toEqual([]);
  });

  it("budget ledger: one attempt per canister per UTC day, kill switch, caps", () => {
    const b: BudgetState = { killSwitch: false, globalCapCycles: 10, globalSpentCycles: 0, budgetCycles: 6, spentCycles: 0, periods: new Set() };
    expect(reserve(b, CAN, 4, NOW).ok).toBe(true);
    expect(reserve(b, CAN, 1, NOW + 60)).toEqual({ ok: false, reason: "already attempted in this period" });
    expect(reserve(b, CAN, 3, NOW + DAY)).toEqual({ ok: false, reason: "canister budget" });
    b.budgetCycles = 100;
    expect(reserve(b, CAN, 7, NOW + DAY)).toEqual({ ok: false, reason: "global cap" });
    b.killSwitch = true;
    expect(reserve(b, CAN, 1, NOW + DAY)).toEqual({ ok: false, reason: "kill switch engaged" });
    expect([b.globalSpentCycles, b.spentCycles]).toEqual([4, 4]);
    expect(periodKey(NOW)).toMatch(/^\d{4}-\d\d-\d\d$/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Engine against real SQL: migrations 0001 + 0004 on in-memory SQLite behind a minimal D1 shim.

function d1(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  // vitest runs from the repo root. Only 0001 and 0004: life support must not depend on other migrations.
  raw.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  raw.exec(readFileSync("migrations/0004_lifesupport.sql", "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql, args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => raw.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...(args as never[])).changes) } }),
  });
  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: ReturnType<typeof stmt>[]) => {
      raw.exec("BEGIN");
      try {
        const out = stmts.map((s) => ({ meta: { changes: Number(raw.prepare(s.sql).run(...(s.args as never[])).changes) } }));
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db: db as unknown as D1Database, raw };
}

const SNS_ROOT = "zxeu2-7aaaa-aaaaq-aaafa-cai";
const SEED = "11".repeat(32);

interface Harness {
  env: LifeSupportEnv; raw: DatabaseSync; deps: Partial<Deps>; chain: { cycles: number; idle: number; thrS: number; mintFactor: number };
  calls: { transfers: { canisterId: string; e8s: number }[]; notifies: number; alerts: string[] }; clock: { now: number };
  funder: { transfer: "ok" | "failed" | "unknown"; notify: "ok" | "unknown" };
}

function harness(envExtra: Partial<LifeSupportEnv> = {}): Harness {
  const { db, raw } = d1();
  const clock = { now: NOW };
  const chain = { cycles: 0.004 * T, idle: IDLE, thrS: THR_S, mintFactor: 1 };
  const calls: Harness["calls"] = { transfers: [], notifies: 0, alerts: [] };
  const mode: Harness["funder"] = { transfer: "ok", notify: "ok" };
  raw.prepare("INSERT INTO canisters (id, role, label, discovered_at, discovered_via, cycles, cycles_source, confidence, run_status, freezing_threshold_s, idle_burn_per_day, health, measured_at, sns_root) VALUES (?, 'archive', 'Test archive', ?, 'test', ?, 'sns-root', 'measured', 'frozen', ?, ?, 'frozen', ?, ?)")
    .run(CAN, NOW - 90 * DAY, chain.cycles + IDLE / 24, THR_S, IDLE, NOW - 3600, SNS_ROOT);
  raw.prepare("INSERT INTO readings (canister_id, ts, cycles, source, confidence, run_status) VALUES (?, ?, ?, 'sns-root', 'measured', 'frozen')").run(CAN, NOW - 3600, chain.cycles + IDLE / 24);
  let pendingE8s = 0;
  const funder: Funder = {
    principal: () => fundingPrincipal(SEED),
    async transfer(a) {
      calls.transfers.push({ canisterId: a.canisterId, e8s: a.e8s });
      if (mode.transfer === "failed") return { kind: "failed", reason: '{"InsufficientFunds":{"balance":"0"}}' };
      if (mode.transfer === "unknown") return { kind: "unknown", reason: "timeout" };
      pendingE8s = a.e8s;
      return { kind: "ok", blockIndex: 123456 };
    },
    async notify() {
      calls.notifies++;
      if (mode.notify === "unknown") return { kind: "unknown", reason: "timeout" };
      const minted = Math.round(pendingE8s * RATE * chain.mintFactor);
      chain.cycles += minted;
      return { kind: "ok", mintedCycles: minted };
    },
  };
  const deps: Partial<Deps> = {
    now: () => clock.now,
    readStatus: async (): Promise<{ reading: StatusReading; source: string }> => ({
      source: "sns-root",
      reading: { canisterId: CAN, cycles: chain.cycles, runStatus: "running", memoryBytes: 1, idleBurnPerDay: chain.idle, freezingThresholdS: chain.thrS, controllers: [SNS_ROOT], moduleHash: null },
    }),
    probe: async () => (chain.cycles < (chain.idle * chain.thrS) / DAY ? "frozen" : "running"),
    fetchRate: async () => ({ xdrPermyriadPerIcp: RATE, ts: clock.now - 60 }),
    funder: () => funder,
    alert: async (_e, text) => { calls.alerts.push(text); },
  };
  const env = { DB: db, IC_HOST: "https://invalid.example", SITE_URL: "https://icpwatch.test", ASSETS: {} as Fetcher, ...envExtra } as LifeSupportEnv;
  return { env, raw, deps, chain, calls, clock, funder: mode };
}

const LIVE_ENV = { LIFE_SUPPORT_ENABLED: "true", LIFE_SUPPORT_IDENTITY: SEED };
const count = (raw: DatabaseSync, where: string) => Number((raw.prepare(`SELECT COUNT(*) n FROM ls_audit WHERE ${where}`).get() as { n: number }).n);

describe("engine: safe by default", () => {
  it("migration seeds the kill switch ENGAGED and a small cap, and the gate lists everything that is closed", async () => {
    const h = harness();
    const s = await loadSettings(h.env.DB);
    expect([s.kill_switch, s.global_cap_cycles, s.global_spent_cycles]).toEqual([1, 1e12, 0]);
    const g = liveGate(h.env, s, {});
    expect(g.live).toBe(false);
    expect(g.reasons).toHaveLength(4);
    expect(liveGate({ ...h.env, ...LIVE_ENV }, s, { dryRun: false }).reasons).toEqual([expect.stringMatching(/kill switch/)]);
    expect(liveGate({ ...h.env, ...LIVE_ENV }, { ...s, kill_switch: 0 }, { dryRun: false }).live).toBe(true);
    expect(liveGate({ ...h.env, ...LIVE_ENV, LIFE_SUPPORT_ENABLED: "1" }, { ...s, kill_switch: 0 }, { dryRun: false }).live).toBe(false);
  });

  it("the audit log, attempts, and topup_log are append-only at the database level", () => {
    const { raw } = harness();
    raw.exec("INSERT INTO ls_audit (ts, mode, stage, code, ok) VALUES (1, 'admin', 'admin', 'x', 1)");
    raw.exec("INSERT INTO topup_log (canister_id, ts, cycles, ok) VALUES ('a', 1, 1, 1)");
    expect(() => raw.exec("UPDATE ls_audit SET code = 'y'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM ls_audit")).toThrow(/append-only/);
    expect(() => raw.exec("UPDATE topup_log SET cycles = 2")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM topup_log")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM ls_settings")).toThrow(/cannot be deleted/);
  });

  it("the database itself refuses spend: kill switch, cap, budget, not enrolled, second attempt in a day", async () => {
    const h = harness();
    const spend = (n: number) => h.raw.exec(`UPDATE ls_settings SET global_spent_cycles = global_spent_cycles + ${n} WHERE id = 1`);
    expect(() => spend(1)).toThrow(/kill switch/);
    await enroll(h.env, { canisterId: CAN, what: "test", budgetCycles: 1000 });
    expect(() => h.raw.exec(`INSERT INTO ls_attempts VALUES ('a0', '${CAN}', '2026-01-01', 1, 5)`)).toThrow(/kill switch/);
    await setKillSwitch(h.env, false, "test");
    expect(() => h.raw.exec("INSERT INTO ls_attempts VALUES ('a0', 'rkp4c-7iaaa-aaaaa-aaaca-cai', '2026-01-01', 1, 5)")).toThrow(/not actively enrolled/);
    spend(10);
    expect(() => spend(2e12)).toThrow(/CHECK/i);
    h.raw.exec(`UPDATE life_support SET spent_cycles = 900 WHERE canister_id = '${CAN}'`);
    expect(() => h.raw.exec(`UPDATE life_support SET spent_cycles = 1001 WHERE canister_id = '${CAN}'`)).toThrow(/budget exceeded/);
    h.raw.exec(`INSERT INTO ls_attempts VALUES ('a1', '${CAN}', '2026-01-01', 1, 5)`);
    expect(() => h.raw.exec(`INSERT INTO ls_attempts VALUES ('a2', '${CAN}', '2026-01-01', 2, 5)`)).toThrow(/UNIQUE/);
    await setEnrollmentState(h.env, { canisterId: CAN, state: "paused" });
    expect(() => h.raw.exec(`UPDATE life_support SET spent_cycles = 950 WHERE canister_id = '${CAN}'`)).toThrow(/not active/);
  });

  it("dry run is the default: a full plan is logged, nothing is signed, nothing is charged", async () => {
    const h = harness(LIVE_ENV); // even with env enabled and an identity present
    await enroll(h.env, { canisterId: CAN, what: "An abandoned archive", budgetCycles: 0.5 * T });
    await setKillSwitch(h.env, false, "test");
    const st = await lifeSupportTick(h.env, { deps: h.deps }); // no dryRun: false
    expect(st.mode).toBe("dry_run");
    expect(st.decisions[CAN]).toBe("topup");
    expect(h.calls.transfers).toEqual([]);
    expect(count(h.raw, "mode = 'dry_run' AND stage = 'plan' AND code = 'topup'")).toBe(1);
    expect((await loadSettings(h.env.DB)).global_spent_cycles).toBe(0);
    // repeated dry-run ticks do not flood the log
    h.clock.now += 600;
    await lifeSupportTick(h.env, { deps: h.deps });
    expect(count(h.raw, "stage = 'plan'")).toBe(1);
  });

  it("dryRun: false is still a dry run unless env, identity, and kill switch ALL allow it", async () => {
    for (const [extra, kill] of [[{}, false], [{ LIFE_SUPPORT_ENABLED: "true" }, false], [{ LIFE_SUPPORT_IDENTITY: SEED }, false], [LIVE_ENV, true]] as const) {
      const h = harness(extra);
      await enroll(h.env, { canisterId: CAN, what: "x", budgetCycles: 0.5 * T });
      await setKillSwitch(h.env, kill, "test");
      const st = await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
      expect(st.mode).toBe("dry_run");
      expect(h.calls.transfers).toEqual([]);
      expect(st.gate.length).toBeGreaterThan(0);
    }
  });
});

describe("engine: the funded path with a fake funder", () => {
  const live = async () => {
    const h = harness(LIVE_ENV);
    await enroll(h.env, { canisterId: CAN, what: "An abandoned archive", story: "Team left in 2024", budgetCycles: 0.5 * T });
    await setKillSwitch(h.env, false, "owner", "go live");
    return h;
  };

  it("reserve, transfer, notify, verify: all logged, spend accounted, canister still frozen, no double spend", async () => {
    const h = await live();
    const st = await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    expect([st.mode, st.toppedUp, st.anomalies, st.decisions[CAN]]).toEqual(["live", 1, 0, "topped_up"]);
    expect(h.calls.transfers).toEqual([{ canisterId: CAN, e8s: Math.floor((0.023 * T) / RATE) }]);
    const stages = (h.raw.prepare("SELECT stage, code FROM ls_audit WHERE mode = 'live' ORDER BY id").all() as { stage: string; code: string }[]).map((r) => `${r.stage}:${r.code}`);
    expect(stages).toEqual(["reserve:reserved", "transfer:transferred", "notify:minted", "verify:verified"]);
    const s = await loadSettings(h.env.DB);
    const ls = h.raw.prepare("SELECT spent_cycles, monthly_cycles FROM life_support").get() as { spent_cycles: number; monthly_cycles: number };
    expect(s.global_spent_cycles).toBe(ls.spent_cycles);
    expect(ls.spent_cycles).toBe(h.calls.transfers[0]!.e8s * RATE + ICP_FEE_E8S * RATE);
    expect(ls.monthly_cycles).toBeGreaterThan(0.06 * T);
    const v = h.raw.prepare("SELECT after_cycles, after_frozen, ledger_block, threshold_cycles FROM ls_audit WHERE stage = 'verify'").get() as Record<string, number>;
    expect([v.after_frozen, v.ledger_block]).toEqual([1, 123456]);
    expect(v.after_cycles! / v.threshold_cycles!).toBeLessThan(0.46);
    expect((h.raw.prepare("SELECT ok, after_status, tx FROM topup_log").get() as Record<string, unknown>)).toEqual({ ok: 1, after_status: "frozen", tx: "icp-ledger-block:123456" });
    expect(s.kill_switch).toBe(0);

    // Next ticks: in band, nothing sent. Eleven days later: refill, exactly once.
    h.clock.now += 600;
    expect((await lifeSupportTick(h.env, { dryRun: false, deps: h.deps })).decisions[CAN]).toBe("in_band");
    expect(h.calls.transfers).toHaveLength(1);
    for (let d = 1; d <= 12; d++) {
      h.clock.now += DAY;
      h.chain.cycles -= IDLE;
      await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    }
    expect(h.calls.transfers).toHaveLength(2);
    expect(h.chain.cycles).toBeLessThan(0.45 * 0.06 * T + 1);
    expect(h.chain.cycles).toBeGreaterThan(0);
  });

  it("overlapping cron ticks: the lease lets only one run live, and the daily slot blocks a replay", async () => {
    const h = await live();
    const [a, b] = await Promise.all([lifeSupportTick(h.env, { dryRun: false, deps: h.deps }), lifeSupportTick(h.env, { dryRun: false, deps: h.deps })]);
    expect([a.leaseBusy, b.leaseBusy].filter(Boolean)).toHaveLength(1);
    expect(h.calls.transfers).toHaveLength(1);
    // Replay: pretend the balance reading regressed so the planner wants to send again the same day.
    // The verified-top-up anchor refuses first, and even a forced reservation hits the UNIQUE slot.
    expect(() => h.raw.exec(`INSERT INTO ls_attempts VALUES ('replay', '${CAN}', '${periodKey(h.clock.now)}', ${h.clock.now}, 5)`)).toThrow(/UNIQUE/);
  });

  it("anomaly: the mint unfreezes the canister. Verification fails, kill switch engages, incident opens, next tick is dry", async () => {
    const h = await live();
    h.chain.mintFactor = 3; // the CMC minted three times what was planned
    const st = await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    expect(st.anomalies).toBe(1);
    const s = await loadSettings(h.env.DB);
    expect(s.kill_switch).toBe(1);
    expect(s.kill_reason).toMatch(/verify_failed/);
    expect(count(h.raw, "stage = 'verify' AND ok = 0 AND after_frozen = 0")).toBe(1);
    expect(count(h.raw, "stage = 'anomaly'")).toBe(1);
    expect((h.raw.prepare("SELECT COUNT(*) n FROM incidents WHERE type = 'life_support_anomaly' AND state = 'open'").get() as { n: number }).n).toBe(1);
    expect(h.calls.alerts[0]).toMatch(/kill switch was engaged/);
    h.clock.now += 3600;
    const next = await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    expect(next.mode).toBe("dry_run");
    expect(h.calls.transfers).toHaveLength(1);
  });

  it("ledger rejects the transfer: reservation released, nothing spent, owner alerted", async () => {
    const h = await live();
    h.funder.transfer = "failed";
    await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    const s = await loadSettings(h.env.DB);
    expect(s.global_spent_cycles).toBe(0);
    expect((h.raw.prepare("SELECT spent_cycles n FROM life_support").get() as { n: number }).n).toBe(0);
    expect(count(h.raw, "stage = 'release'")).toBe(1);
    expect(h.calls.notifies).toBe(0);
    expect(h.calls.alerts).toHaveLength(1);
  });

  it("unknown transfer outcome: reservation kept, kill switch engaged, canister blocked until resolved", async () => {
    const h = await live();
    h.funder.transfer = "unknown";
    await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    const s = await loadSettings(h.env.DB);
    expect(s.kill_switch).toBe(1);
    expect(s.global_spent_cycles).toBeGreaterThan(0);
    await setKillSwitch(h.env, false, "owner", "checked");
    h.funder.transfer = "ok";
    h.clock.now += DAY;
    const st = await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    expect(st.decisions[CAN]).toBe("attempt_unresolved");
    expect(h.calls.transfers).toHaveLength(1);
  });

  it("notify lost after a good transfer: the next tick finishes it (notify_top_up is idempotent per block)", async () => {
    const h = await live();
    h.funder.notify = "unknown";
    await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    expect((await loadSettings(h.env.DB)).kill_switch).toBe(1);
    await setKillSwitch(h.env, false, "owner", "CMC was busy");
    h.funder.notify = "ok";
    h.clock.now += 3600;
    const st = await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    expect(st.recovered).toBe(1);
    expect(h.calls.transfers).toHaveLength(1); // no second payment
    expect(count(h.raw, "stage = 'recover' AND code = 'minted'")).toBe(1);
    expect(count(h.raw, "stage = 'verify' AND ok = 1")).toBe(1);
  });

  it("a running canister is never funded, even when enrolled and everything is live", async () => {
    const h = await live();
    h.chain.cycles = 3 * T;
    const st = await lifeSupportTick(h.env, { dryRun: false, deps: h.deps });
    expect(st.decisions[CAN]).toBe("not_frozen");
    expect(h.calls.transfers).toEqual([]);
  });
});

describe("engine: admin and registry", () => {
  it("enroll validates, setCaps refuses unsafe values, every admin action is audited", async () => {
    const h = harness();
    expect((await enroll(h.env, { canisterId: "nope", what: "x", budgetCycles: 1 })).ok).toBe(false);
    expect((await enroll(h.env, { canisterId: "rkp4c-7iaaa-aaaaa-aaaca-cai", what: "x", budgetCycles: 1 })).error).toMatch(/not watched/);
    expect((await enroll(h.env, { canisterId: CAN, what: "x", budgetCycles: -5 })).ok).toBe(false);
    expect((await enroll(h.env, { canisterId: CAN, what: "An archive", budgetCycles: 0.5 * T })).ok).toBe(true);
    expect((h.raw.prepare("SELECT life_support n FROM canisters WHERE id = ?").get(CAN) as { n: number }).n).toBe(1);
    expect((await setCaps(h.env, { params: { safetyFraction: 0.8 } }, "t")).error).toMatch(/safetyFraction/);
    expect((await setCaps(h.env, { maxReadingAgeS: 99999 }, "t")).ok).toBe(false);
    const ok = await setCaps(h.env, { globalCapCycles: 5 * T, dailyCapCycles: 1 * T }, "owner");
    expect(ok.settings!.global_cap_cycles).toBe(5 * T);
    expect(count(h.raw, "mode = 'admin'")).toBe(2);
  });

  it("status reports caps, spend, gate, the funding principal and its balance (injected, read-only)", async () => {
    const h = harness(LIVE_ENV);
    const r = await status(h.env, { fetchRate: h.deps.fetchRate, now: h.deps.now, balanceOf: async () => 250_000_000n });
    expect(r.funding.principal).toBe(fundingPrincipal(SEED));
    expect(r.funding.icp).toBe(2.5);
    expect(r.killSwitch).toBe(true);
    expect(r.gate.reasons).toEqual([expect.stringMatching(/kill switch/)]);
    expect(r.caps.globalRemainingCycles).toBe(1e12);
    const none = await status(harness().env, { fetchRate: h.deps.fetchRate });
    expect([none.funding.principal, none.identityPresent]).toEqual([null, false]);
  });

  it("registry prices candidates before anything is enrolled, then shows preserved canisters with budget remaining", async () => {
    const h = harness();
    await lifeSupportTick(h.env, { deps: h.deps }); // nobody enrolled: just refreshes the rate
    let r = await registry(h.env);
    expect(r.preserved).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.monthly!.cycles).toBeGreaterThan(0.06 * T);
    expect(r.candidates[0]!.monthly!.usd).toBeCloseTo(0.083, 2);
    expect(r.candidates[0]!.fundable).toBe(true);
    expect(r.active).toBe(false);
    await enroll(h.env, { canisterId: CAN, what: "An archive", budgetCycles: 0.5 * T });
    r = await registry(h.env);
    expect(r.candidates).toEqual([]);
    expect(r.preserved[0]!.remainingMonths).toBeCloseTo((0.5 * T) / r.preserved[0]!.monthly!.cycles, 3);
    expect(r.totals.monthlyUsd).toBeCloseTo(0.083, 2);
  });
});
