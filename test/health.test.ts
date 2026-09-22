import { describe, expect, it } from "vitest";
import {
  DAY, baseline, burnRate, classify, conditions, dailyBurns, isBurnAnomaly, project, step,
  type AlertType, type CanisterFacts, type EvalInput, type OpenIncident, type Sample,
} from "../src/lib/health";

const T = 1e12;

const facts = (o: Partial<CanisterFacts>): CanisterFacts => ({
  cycles: 100 * T, runStatus: "running", freezingThresholdS: 30 * DAY, idleBurnPerDay: 0.01 * T, observedBurnPerDay: 0.5 * T, ...o,
});

describe("project", () => {
  it("computes the freezing threshold from idle burn and threshold seconds", () => {
    const p = project(facts({}));
    expect(p.freezeThresholdCycles).toBeCloseTo(0.3 * T);
    expect(p.burnSource).toBe("observed");
    expect(p.secondsToFreeze! / DAY).toBeCloseTo((100 - 0.3) / 0.5, 3);
    // after freezing only idle cost burns: 0.3 T at 0.01 T per day is 30 days
    expect((p.secondsToDeletion! - p.secondsToFreeze!) / DAY).toBeCloseTo(30, 3);
    expect(p.assumed).toBe(false);
  });

  it("never projects slower than idle burn", () => {
    const p = project(facts({ observedBurnPerDay: 0.001 * T }));
    expect(p.burnPerDay).toBe(0.01 * T);
    expect(p.burnSource).toBe("idle");
  });

  it("flags assumptions when only a balance and observed burn are known (metrics source)", () => {
    const p = project(facts({ freezingThresholdS: null, idleBurnPerDay: null, cycles: 10 * T, observedBurnPerDay: 0.1 * T }));
    expect(p.assumed).toBe(true);
    expect(p.secondsToFreeze! / DAY).toBeCloseTo(100 - 30, 3);
  });

  it("dates deletion for a frozen canister from its own observed decline when no idle burn is reported", () => {
    // The iDoge ledger case: blackhole source, 27.3 B cycles, falling about 1.18 B per day.
    const p = project(facts({ cycles: 27.3e9, runStatus: "frozen", idleBurnPerDay: null, observedBurnPerDay: 1.18e9 }));
    expect(p.secondsToFreeze).toBe(0);
    expect(p.secondsToDeletion! / DAY).toBeCloseTo(23.1, 1);
    expect(p.assumed).toBe(true);
  });

  it("returns nothing when the balance is unknown", () => {
    expect(project(facts({ cycles: null })).secondsToFreeze).toBeNull();
  });

  it("treats a frozen canister as zero seconds to freeze and counts down on idle burn", () => {
    const p = project(facts({ cycles: 0.1 * T, runStatus: "frozen" }));
    expect(p.secondsToFreeze).toBe(0);
    expect(p.secondsToDeletion! / DAY).toBeCloseTo(10, 3);
  });
});

describe("classify", () => {
  const c = (o: Partial<CanisterFacts>) => classify(facts(o), project(facts(o)));
  it("healthy, risk, low, frozen", () => {
    expect(c({})).toBe("healthy");
    expect(c({ cycles: 0.3 * T + 0.5 * T * 30 })).toBe("risk");
    expect(c({ cycles: 0.3 * T + 0.5 * T * 8 })).toBe("low");
    expect(c({ runStatus: "frozen", cycles: 0.1 * T })).toBe("frozen");
  });
  it("unknown balance with a live probe stays unknown, deleted is gone", () => {
    expect(c({ cycles: null })).toBe("unknown");
    expect(c({ cycles: null, runStatus: "deleted" })).toBe("gone");
  });
  it("life support wins over frozen", () => {
    expect(c({ runStatus: "frozen", cycles: 0.1 * T, lifeSupport: true })).toBe("life");
  });
});

describe("burnRate", () => {
  const series = (start: number, perStep: number, n: number, stepS = 600): Sample[] =>
    Array.from({ length: n }, (_, i) => ({ ts: i * stepS, cycles: start - perStep * i }));

  it("measures steady burn", () => {
    const s = series(100 * T, 0.001 * T, 145); // one day at 10 minute steps
    expect(burnRate(s, 0, DAY)! / T).toBeCloseTo(0.144, 3);
  });

  it("ignores top-ups instead of reporting negative or masked burn", () => {
    const s = series(100 * T, 0.001 * T, 145);
    for (let i = 70; i < s.length; i++) s[i]!.cycles += 50 * T; // refill half way through
    expect(burnRate(s, 0, DAY)! / T).toBeCloseTo(0.144, 3);
  });

  it("ignores balance swings from cycles moving in and out (the SNS root case)", () => {
    // Real pattern seen on the OpenChat SNS root: about 27 B burned per hour, plus 2.7 T leaving and
    // returning every few hours. Summing drops would report about 400x the true burn.
    const s: Sample[] = [];
    let bal = 163e12;
    for (let h = 0; h <= 24; h++) {
      bal -= 27e9;
      if (h === 4 || h === 12 || h === 20) bal -= 2.7e12;
      if (h === 7 || h === 15 || h === 23) bal += 2.7e12;
      s.push({ ts: h * 3600, cycles: bal });
    }
    expect(burnRate(s, 0, DAY, 6 * 3600)! / 1e9).toBeCloseTo(27 * 24, 0);
  });

  it("needs at least 30 minutes of coverage", () => {
    expect(burnRate(series(100 * T, 1, 2), 0, DAY)).toBeNull();
  });
});

describe("burn anomaly against own baseline", () => {
  it("fires on a sharp spike for a quiet canister", () => {
    const b = baseline([0.04 * T, 0.05 * T, 0.04 * T, 0.045 * T, 0.05 * T]);
    expect(isBurnAnomaly(0.4 * T, b)).toBe(true);
  });
  it("does not fire for a canister that is always busy and noisy", () => {
    const b = baseline([40 * T, 55 * T, 38 * T, 61 * T, 47 * T, 52 * T]);
    expect(isBurnAnomaly(70 * T, b)).toBe(false);
  });
  it("does not fire on tiny absolute changes", () => {
    const b = baseline([0.001 * T, 0.001 * T, 0.001 * T]);
    expect(isBurnAnomaly(0.01 * T, b)).toBe(false);
  });
  it("does not fire without enough history", () => {
    expect(isBurnAnomaly(10 * T, baseline([0.1 * T, 0.1 * T]))).toBe(false);
  });
  it("builds daily burns from samples", () => {
    const s: Sample[] = [];
    for (let i = 0; i <= 5 * 144; i++) s.push({ ts: i * 600, cycles: 1000 * T - i * 0.001 * T });
    const d = dailyBurns(s, 5, 5 * DAY);
    expect(d.length).toBe(5);
    expect(d[0]! / T).toBeCloseTo(0.144, 3);
  });
});

describe("incident state machine: one alert per incident", () => {
  // Drives the state machine through a simulated incident and counts notifications.
  function simulate(type: AlertType, inputs: EvalInput[]) {
    let open: OpenIncident | undefined;
    let nextId = 1;
    const log: string[] = [];
    for (const f of inputs) {
      const c = conditions(f, project(f))[type];
      const a = step(type, open, c);
      if (a.kind === "open") { open = { id: nextId++, type, clearStreak: 0 }; log.push("fired"); }
      else if (a.kind === "resolve") { open = undefined; log.push("resolved"); }
      else if (a.kind === "streak" && open) open.clearStreak = a.clearStreak;
    }
    return log;
  }
  const base: EvalInput = { ...facts({}), label: "Test Ledger", role: "ledger", recentBurnPerDay: null, baseline: null };
  const withDays = (d: number): EvalInput => ({ ...base, cycles: 0.3 * T + 0.5 * T * d });

  it("fires once while the balance keeps falling, then resolves once after a top-up", () => {
    const seq = [20, 16, 13.9, 12, 10, 8, 6, 4, 60, 60, 60].map(withDays);
    expect(simulate("low_cycles", seq)).toEqual(["fired", "resolved"]);
  });

  it("does not flap when hovering around the threshold (hysteresis band)", () => {
    const seq = [13.9, 14.2, 13.8, 14.5, 13.7, 15, 13.9, 16, 14.1].map(withDays);
    expect(simulate("low_cycles", seq)).toEqual(["fired"]);
  });

  it("requires consecutive clean evaluations to resolve", () => {
    const seq = [10, 30, 10, 30, 10, 30, 30].map(withDays);
    expect(simulate("low_cycles", seq)).toEqual(["fired", "resolved"]);
  });

  it("frozen fires once and resolves once", () => {
    const frozen: EvalInput = { ...base, runStatus: "frozen", cycles: 0.2 * T };
    const seq = [base, frozen, frozen, frozen, base, frozen, base, base, base];
    expect(simulate("frozen", seq)).toEqual(["fired", "resolved"]);
  });

  it("approaching deletion only fires inside the warning window", () => {
    const f = (c: number): EvalInput => ({ ...base, runStatus: "frozen", cycles: c * T });
    // idle burn 0.01 T per day: 0.25 T is 25 days, 0.1 T is 10 days
    expect(simulate("approaching_deletion", [f(0.25), f(0.2), f(0.1), f(0.05), f(0.02)])).toEqual(["fired"]);
  });

  it("burn anomaly fires on a spike and resolves after three normal readings", () => {
    const b = baseline([0.04 * T, 0.05 * T, 0.04 * T, 0.045 * T, 0.05 * T]);
    const r = (x: number): EvalInput => ({ ...base, recentBurnPerDay: x * T, baseline: b });
    const seq = [0.05, 0.5, 0.6, 0.55, 0.05, 0.05, 0.5, 0.05, 0.05, 0.05].map(r);
    expect(simulate("burn_anomaly", seq)).toEqual(["fired", "resolved"]);
  });

  it("archive alerts explain why archives matter", () => {
    const c = conditions({ ...withDays(5), role: "archive", label: "CHAT Archive #2" }, project(withDays(5)));
    expect(c.low_cycles.detail).toContain("Archives hold transaction history");
  });
});
