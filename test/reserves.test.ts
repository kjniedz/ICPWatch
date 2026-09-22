import { describe, expect, it } from "vitest";
import { parseCkbtcDashboard } from "../src/reserves/sources/minters";
import { reconcile, toleranceFor } from "../src/reserves/reconcile";

const dash = `<h3>Metadata</h3><table><tbody><tr><th>Main address</th><td>bc1qmain</td></tr><tr><th>Min number of confirmations</th><td>6</td></tr><tr><th>Total BTC managed</th><td>240.01538291</td></tr></tbody></table>
<h3>Pending retrieve BTC requests</h3><table><thead><tr><th>Block Index</th><th>Address</th><th>Amount</th></tr></thead><tbody><tr><td>4655578</td><td><code>15oT</code></td><td>282935</td></tr><tr><td>4655581</td><td><code>bc1q</code></td><td>2504880</td></tr></tbody></table>
<h3>In flight retrieve BTC requests</h3><table><tbody></tbody></table>
<h3>Submitted transactions</h3><table><thead><tr><th>Txid</th><th>Requests</th></tr></thead><tbody><tr><td rowspan='1'><a target='_blank' href='https://mempool.space/tx/${"a".repeat(64)}'><code>x</code></a></td><td rowspan='1'><table><tr><th>Block index</th><td>1</td></tr><tr><th>Amount</th><td>0.00194397</td></tr></table></td></tr></tbody></table>
<h3>Unconfirmed change</h3><table><tbody></tbody></table>`;

describe("ckBTC dashboard parser", () => {
  it("reads managed BTC in satoshi, pending requests in satoshi, submitted requests from BTC", () => {
    const d = parseCkbtcDashboard(dash);
    expect(d.managed).toBe(24001538291n);
    expect(d.pending).toBe(282935n + 2504880n);
    expect(d.pendingCount).toBe(2);
    expect(d.submitted).toBe(194397n);
    expect(d.mainAddress).toBe("bc1qmain");
  });
});

describe("reconcile", () => {
  const base = { symbol: "ckX", decimals: 8, supply: 1_000_000n, minterReserves: 1_002_000n, pendingOut: 0n, pendingIn: 0n, fees: null, nativeSlack: 0n, tolerance: 0.001 };
  it("is backed and verified when two native sources agree with the minter", () => {
    const r = reconcile({ ...base, native: [{ source: "a", value: 1_002_000n, complete: true }, { source: "b", value: 1_002_000n, complete: true }] });
    expect(r.status).toBe("backed");
    expect(r.verified).toBe(true);
    expect(r.rawRatio).toBeCloseTo(1.002, 5);
  });
  it("treats in-flight withdrawals as explained, not as a shortfall", () => {
    // 20,000 burned on the IC, the minter still counts the funds, the chain already shows them gone.
    const r = reconcile({ ...base, supply: 980_000n, pendingOut: 20_000n, nativeSlack: 20_000n, native: [{ source: "a", value: 982_000n, complete: true }, { source: "b", value: 982_000n, complete: true }] });
    expect(r.status).toBe("backed");
  });
  it("flags a real shortfall beyond tolerance", () => {
    const r = reconcile({ ...base, minterReserves: 900_000n, native: [{ source: "a", value: 900_000n, complete: true }, { source: "b", value: 900_000n, complete: true }] });
    expect(r.status).toBe("deviation");
  });
  it("widens tolerance from observed noise but never past the ceiling", () => {
    const noisy = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.004 : -0.004));
    expect(toleranceFor(0.001, noisy)).toBeLessThanOrEqual(0.01);
    expect(toleranceFor(0.001, noisy)).toBeGreaterThan(0.001);
    expect(toleranceFor(0.001, [0, 0, 0])).toBe(0.001);
  });
});
