import { describe, expect, it } from "vitest";
import { describeRule, parseRules } from "../src/alerts/price";

describe("parseRules", () => {
  it("builds rules from the form and defaults the cooldown to six hours", () => {
    const r = parseRules({ above: "$1.50", move_pct: "10", window: "1h", volume_x: "3" });
    expect(r.error).toBeUndefined();
    expect(r.rules).toEqual([{ kind: "above", value: 1.5 }, { kind: "move_pct", value: 10, window_s: 3600 }, { kind: "volume_x", value: 3 }]);
    expect(r.cooldown_s).toBe(6 * 3600);
  });
  it("rejects empty and out-of-range input", () => {
    expect(parseRules({}).error).toMatch(/at least one/);
    expect(parseRules({ move_pct: "0.5" }).error).toMatch(/between 1%/);
    expect(parseRules({ above: "abc" }).error).toMatch(/positive/);
    expect(parseRules({ volume_x: "1" }).error).toMatch(/1.5x/);
  });
  it("clamps the cooldown between one hour and a week", () => {
    expect(parseRules({ below: "1", cooldown_h: "0" }).cooldown_s).toBe(6 * 3600);
    expect(parseRules({ below: "1", cooldown_h: "1000" }).cooldown_s).toBe(168 * 3600);
  });
  it("describes rules in plain words", () => {
    expect(describeRule({ kind: "move_pct", value: 10, window_s: 86400 }, "CHAT")).toBe("CHAT moves 10% or more in 24 hours");
  });
});
