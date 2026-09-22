import { describe, expect, it } from "vitest";
import { fundingOptions, type FundFacts } from "../src/fund/calc";
import { depositAccount, TPUP_ICRC1_MEMO_HEX, TPUP_MEMO } from "../src/fund";
import { qrEncode } from "../src/fund/qr";

const T = 1e12;
const frozen: FundFacts = { canisterId: "eayyd-iiaaa-aaaah-adtea-cai", cycles: 27.3e9, runStatus: "frozen", health: "frozen", idleBurnPerDay: null, freezingThresholdS: 30 * 86400, observedBurnPerDay: 1.18e9 };

describe("funding options", () => {
  it("refuses keep-alive when the frozen balance is already near the threshold, and says why", () => {
    const o = fundingOptions(frozen, 21500, 2.95, 1_790_000_000); // 27.3 B is 77% of the estimated 35.4 B threshold
    expect(o.keepAlive.available).toBe(false);
    expect(o.keepAlive.reason).toMatch(/never unfreeze/);
    expect(o.revive.available).toBe(true);
  });
  it("keep-alive never unfreezes: every preset stays under the safety share of the threshold", () => {
    const o = fundingOptions({ ...frozen, cycles: 4e9 }, 21500, 2.95, 1_790_000_000);
    expect(o.keepAlive.available).toBe(true);
    for (const p of o.keepAlive.presets) {
      expect(p.unfreezes).toBe(false);
      expect(p.afterShareOfThreshold!).toBeLessThan(1);
      expect(p.totalE8s).toBeGreaterThan(0);
    }
    expect(o.estimated).toBe(true); // blackhole source: idle burn from the observed decline
  });
  it("revive clears the threshold and buys the requested runway", () => {
    const o = fundingOptions(frozen, 21500, 2.95, 1_790_000_000);
    expect(o.revive.available).toBe(true);
    for (const p of o.revive.presets) expect(p.afterCycles).toBeGreaterThan(o.effectiveThresholdCycles!);
  });
  it("refuses keep-alive for a healthy running canister and warns about uninstalled ones", () => {
    const running = fundingOptions({ ...frozen, cycles: 100 * T, runStatus: "running", health: "healthy", idleBurnPerDay: 0.01 * T, observedBurnPerDay: 0.5 * T }, 21500, 2.95, 1_790_000_000);
    expect(running.keepAlive.available).toBe(false);
    const gone = fundingOptions({ ...frozen, runStatus: "no_wasm", health: "gone" }, 21500, 2.95, 1_790_000_000);
    expect(gone.state).toBe("uninstalled");
    expect(gone.keepAlive.requiresAck || !gone.keepAlive.available).toBe(true);
  });
});

describe("CMC top-up account", () => {
  it("derives a checksummed account identifier from the canister id", () => {
    const a = depositAccount("eayyd-iiaaa-aaaah-adtea-cai");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(depositAccount("ryjl3-tyaaa-aaaaa-aaaba-cai")).not.toBe(a);
  });
  it("encodes TPUP as an 8 byte little endian icrc1 memo", () => {
    expect(TPUP_MEMO).toBe(0x50555054);
    expect(TPUP_ICRC1_MEMO_HEX).toBe("5450555000000000");
  });
});

describe("qr", () => {
  it("encodes a 64 hex account id into a valid symbol", () => {
    const q = qrEncode("5f0575fbe1218d443eb82831e9bd47b0b9bd6140d1460bc0e65aaaf7ffe4175e");
    expect(q.size).toBeGreaterThan(20);
    expect(q.modules.length).toBe(q.size);
  });
});
