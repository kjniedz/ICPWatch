import { describe, expect, it } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import {
  DAY, accountText, applyBlocks, dayOf, defaultBigThreshold, newChunk, ownerOf, planCommit, toUnits,
  type ChunkState, type CommitPlan, type ExistingRow, type Tx,
} from "../src/indexer/core";

const FEE = 10n;
const T0 = 1_700_000_000; // 2023-11-14 22:13:20 UTC
const D0 = dayOf(T0);

const A = "aaaaa-aa";
const B = "2vxsx-fae";
const C = "ryjl3-tyaaa-aaaaa-aaaba-cai";

const mint = (to: string, amount: bigint, ts = T0): Tx => ({ kind: "mint", ts, from: null, to, amount, fee: null });
const burn = (from: string, amount: bigint, ts = T0): Tx => ({ kind: "burn", ts, from, to: null, amount, fee: null });
const xfer = (from: string, to: string, amount: bigint, fee: bigint | null = FEE, ts = T0): Tx => ({ kind: "transfer", ts, from, to, amount, fee });
const approve = (from: string, fee: bigint | null = FEE, ts = T0): Tx => ({ kind: "approve", ts, from, to: null, amount: 0n, fee });

const delta = (s: ChunkState, account: string) => s.accounts.get(account)?.delta;

/** A tiny in-memory stand-in for the balances table plus idx_state counters, driven by planCommit. */
class FakeDb {
  rows = new Map<string, ExistingRow>();
  holders = 0;
  accounts = 0;
  daily = new Map<number, { txs: number; transfers: number; active: number; fresh: number; holders: number; volume: number }>();
  commit(state: ChunkState, decimals = 0): CommitPlan {
    const plan = planCommit(state, this.rows, { holders: this.holders, accounts: this.accounts }, decimals);
    for (const u of plan.upserts) this.rows.set(u.account, { balanceRaw: u.balanceRaw, txCount: u.txCount, lastActive: u.lastActive });
    for (const d of plan.daily) {
      const cur = this.daily.get(d.day) ?? { txs: 0, transfers: 0, active: 0, fresh: 0, holders: 0, volume: 0 };
      this.daily.set(d.day, { txs: cur.txs + d.txs, transfers: cur.transfers + d.transfers, active: cur.active + d.activeAccounts, fresh: cur.fresh + d.newAccounts, holders: d.holders, volume: cur.volume + d.volume });
    }
    this.holders = plan.holdersAfter;
    this.accounts = plan.accountsAfter;
    return plan;
  }
  balance(account: string) { return BigInt(this.rows.get(account)?.balanceRaw ?? "0"); }
  sum() { return [...this.rows.values()].reduce((s, r) => s + BigInt(r.balanceRaw), 0n); }
}

describe("applyBlocks: balance rules", () => {
  it("mint credits the receiver and nothing else", () => {
    const s = newChunk(0, null);
    expect(applyBlocks(s, [mint(A, 1000n)], FEE)).toBe(1);
    expect(delta(s, A)).toBe(1000n);
    expect(s.accounts.size).toBe(1);
    expect(s.totals).toMatchObject({ blocks: 1, mints: 1, minted: 1000n, transfers: 0, volume: 0n, fees: 0n });
    expect(s.nextBlock).toBe(1);
  });

  it("burn debits the sender without a fee", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [mint(A, 1000n), burn(A, 400n)], FEE);
    expect(delta(s, A)).toBe(600n);
    expect(s.totals).toMatchObject({ burns: 1, burned: 400n, fees: 0n });
    expect(s.accounts.get(A)!.txCount).toBe(2);
  });

  it("transfer with an explicit fee debits amount + fee and credits amount", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [xfer(A, B, 500n, 7n)], FEE);
    expect(delta(s, A)).toBe(-507n);
    expect(delta(s, B)).toBe(500n);
    expect(s.totals).toMatchObject({ transfers: 1, volume: 500n, fees: 7n, defaultFeeUsed: 0 });
  });

  it("transfer without a fee falls back to the ledger default fee", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [xfer(A, B, 500n, null)], FEE);
    expect(delta(s, A)).toBe(-510n);
    expect(delta(s, B)).toBe(500n);
    expect(s.totals).toMatchObject({ fees: 10n, defaultFeeUsed: 1 });
  });

  it("an explicit zero fee is honoured, not replaced by the default", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [xfer(A, B, 500n, 0n)], FEE);
    expect(delta(s, A)).toBe(-500n);
    expect(s.totals.fees).toBe(0n);
  });

  it("approve charges only the fee to the approver", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [approve(A), approve(A, null), approve(A, 3n)], FEE);
    expect(delta(s, A)).toBe(-23n);
    expect(s.accounts.size).toBe(1);
    expect(s.totals).toMatchObject({ approves: 3, fees: 23n, volume: 0n, transfers: 0 });
  });

  it("a self transfer costs the fee and counts as one transaction for the account", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [xfer(A, A, 999n)], FEE);
    expect(delta(s, A)).toBe(-FEE);
    expect(s.accounts.get(A)!.txCount).toBe(1);
    expect(s.totals).toMatchObject({ transfers: 1, volume: 999n, fees: FEE });
  });

  it("unknown block kinds are counted and change no balance", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [{ kind: "other", ts: T0, from: null, to: null, amount: 0n, fee: null }], FEE);
    expect(s.accounts.size).toBe(0);
    expect(s.totals).toMatchObject({ blocks: 1, other: 1 });
    expect(s.nextBlock).toBe(1);
  });

  it("supply is conserved: sum of deltas = minted - burned - fees", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [mint(A, 10_000n), xfer(A, B, 2_000n), xfer(B, C, 500n, null), approve(C), burn(B, 100n), xfer(A, A, 1n), mint(C, 5n)], FEE);
    const sum = [...s.accounts.values()].reduce((x, a) => x + a.delta, 0n);
    expect(sum).toBe(s.totals.minted - s.totals.burned - s.totals.fees);
    expect(sum).toBe(10_005n - 100n - 40n);
  });

  it("tracks tx count, first and last activity per account", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [mint(A, 100n, T0), xfer(A, B, 10n, FEE, T0 + 50), xfer(A, B, 10n, FEE, T0 + 90)], FEE);
    expect(s.accounts.get(A)).toMatchObject({ txCount: 3, firstTs: T0, lastTs: T0 + 90 });
    expect(s.accounts.get(B)).toMatchObject({ txCount: 2, firstTs: T0 + 50, lastTs: T0 + 90 });
    expect(s.lastTs).toBe(T0 + 90);
  });

  it("a timestamp that runs backwards is clamped to the previous block", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [mint(A, 1n, T0 + DAY), mint(B, 1n, T0)], FEE);
    expect(s.days.size).toBe(1);
    expect(s.accounts.get(B)!.lastTs).toBe(T0 + DAY);
  });
});

describe("applyBlocks: subaccounts", () => {
  const owner = Principal.fromText("k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae");
  const sub = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };

  it("encodes accounts exactly as the ICRC-1 textual format (spec vectors)", () => {
    expect(accountText(owner, null)).toBe("k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae");
    expect(accountText(owner, new Uint8Array(32))).toBe("k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae");
    expect(accountText(owner, [])).toBe("k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae");
    expect(accountText(owner, sub(1))).toBe("k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae-6cc627i.1");
    expect(accountText(owner, Uint8Array.from({ length: 32 }, (_, i) => i + 1))).toBe(
      "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae-dfxgiyy.102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    );
  });

  it("accepts subaccounts as number arrays and recovers the owner from any key", () => {
    expect(accountText(owner, Array.from(sub(1)))).toBe(accountText(owner, sub(1)));
    expect(ownerOf(accountText(owner, sub(1)))).toBe(owner.toText());
    expect(ownerOf(accountText(owner, null))).toBe(owner.toText());
    expect(ownerOf(accountText(Principal.fromText(C), sub(200)))).toBe(C);
  });

  it("keeps subaccounts of one owner apart, and the zero subaccount equal to no subaccount", () => {
    const main = accountText(owner, null);
    const zero = accountText(owner, new Uint8Array(32));
    const s1 = accountText(owner, sub(1));
    const s2 = accountText(owner, sub(2));
    const s = newChunk(0, null);
    applyBlocks(s, [mint(main, 100n), mint(zero, 50n), xfer(main, s1, 30n), xfer(s1, s2, 5n)], FEE);
    expect(s.accounts.size).toBe(3);
    expect(delta(s, main)).toBe(150n - 40n);
    expect(delta(s, s1)).toBe(30n - 15n);
    expect(delta(s, s2)).toBe(5n);
    const plan = planCommit(s, new Map(), { holders: 0, accounts: 0 }, 0);
    expect(new Set(plan.upserts.map((u) => u.owner))).toEqual(new Set([owner.toText()]));
  });
});

describe("applyBlocks: resume boundaries", () => {
  const blocks = [mint(A, 1000n), xfer(A, B, 100n), xfer(A, B, 100n), xfer(B, C, 50n), burn(A, 10n), approve(B)];

  it("re-feeding an overlapping batch applies only the blocks not yet seen", () => {
    const once = newChunk(0, null);
    applyBlocks(once, blocks, FEE, 0);

    const s = newChunk(0, null);
    expect(applyBlocks(s, blocks.slice(0, 4), FEE, 0)).toBe(4);
    expect(applyBlocks(s, blocks.slice(2), FEE, 2)).toBe(2); // blocks 2..5, of which 2 and 3 are already in
    expect(s.nextBlock).toBe(6);
    expect(applyBlocks(s, blocks, FEE, 0)).toBe(0); // a full replay of the same range is a no-op
    expect(s.nextBlock).toBe(6);
    for (const k of [A, B, C]) expect(delta(s, k)).toBe(delta(once, k));
    expect(s.totals).toEqual(once.totals);
  });

  it("a chunk that starts mid-ledger ignores everything below its start", () => {
    const s = newChunk(4, null);
    expect(applyBlocks(s, blocks, FEE, 0)).toBe(2);
    expect(delta(s, A)).toBe(-10n);
    expect(delta(s, B)).toBe(-FEE);
    expect(s.accounts.has(C)).toBe(false);
  });

  it("a gap throws instead of silently corrupting balances", () => {
    const s = newChunk(0, null);
    applyBlocks(s, blocks.slice(0, 2), FEE, 0);
    expect(() => applyBlocks(s, blocks.slice(3), FEE, 3)).toThrow(/gap/);
    expect(s.nextBlock).toBe(2);
  });

  it("splitting a replay into chunks at any boundary gives the same database", () => {
    const history: Tx[] = [];
    const names = [A, B, C, "aaaaa-aa-x.1"];
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let i = 0; i < 400; i++) {
      const ts = T0 + i * 3000; // about 14 days
      const k = rnd(10);
      if (i < 4 || k === 0) history.push(mint(names[rnd(4)]!, BigInt(1000 + rnd(5000)), ts));
      else if (k === 1) history.push(approve(names[rnd(4)]!, FEE, ts));
      else if (k === 2) history.push(burn(names[rnd(4)]!, BigInt(rnd(20)), ts));
      else history.push(xfer(names[rnd(4)]!, names[rnd(4)]!, BigInt(rnd(300)), rnd(2) ? FEE : null, ts));
    }
    const run = (cuts: number[]) => {
      const db = new FakeDb();
      let at = 0;
      for (const cut of [...cuts, history.length]) {
        const s = newChunk(at, null);
        applyBlocks(s, history.slice(at, cut), FEE, at);
        db.commit(s);
        at = cut;
      }
      return db;
    };
    const whole = run([]);
    for (const cuts of [[1], [57], [100, 200, 300], [13, 14, 15, 399]]) {
      const split = run(cuts);
      expect([...split.rows].sort()).toEqual([...whole.rows].sort());
      expect(split.holders).toBe(whole.holders);
      expect(split.accounts).toBe(whole.accounts);
      expect([...split.daily].sort()).toEqual([...whole.daily].sort());
    }
    // and the books balance
    const s = newChunk(0, null);
    applyBlocks(s, history, FEE, 0);
    expect(whole.sum()).toBe(s.totals.minted - s.totals.burned - s.totals.fees);
  });
});

describe("large transfers", () => {
  it("keeps transfers, mints, and burns at or above the threshold with their block index", () => {
    const s = newChunk(100, 500n);
    applyBlocks(s, [mint(A, 500n), xfer(A, B, 499n), xfer(A, B, 800n), burn(B, 600n), approve(A), { ...approve(A), amount: 10_000n }], FEE, 100);
    expect(s.big.map((b) => [b.block, b.kind, b.amount])).toEqual([[100, "mint", 500n], [102, "transfer", 800n], [103, "burn", 600n]]);
    const plan = planCommit(s, new Map(), { holders: 0, accounts: 0 }, 2);
    expect(plan.big[1]).toMatchObject({ block: 102, from: A, to: B, amount: 8, amountRaw: "800" });
  });

  it("is disabled with a null threshold, and the default threshold is a supply fraction", () => {
    const s = newChunk(0, null);
    applyBlocks(s, [mint(A, 10n ** 30n)], FEE);
    expect(s.big).toEqual([]);
    expect(defaultBigThreshold(1_000_000n)).toBe(1000n);
    expect(defaultBigThreshold(1_000_000n, 10_000n)).toBe(100n);
    expect(defaultBigThreshold(50n)).toBe(1n);
    expect(defaultBigThreshold(0n)).toBeNull();
  });
});

describe("planCommit", () => {
  it("adds deltas to stored balances exactly, beyond float precision", () => {
    const db = new FakeDb();
    const hugeA = 123_456_789_012_345_678_901_234_567_890n;
    const s1 = newChunk(0, null);
    applyBlocks(s1, [mint(A, hugeA)], FEE);
    db.commit(s1, 18);
    const s2 = newChunk(1, null);
    applyBlocks(s2, [xfer(A, B, 1n, 1n)], FEE, 1);
    const plan = db.commit(s2, 18);
    expect(db.balance(A)).toBe(hugeA - 2n);
    expect(db.balance(B)).toBe(1n);
    expect(plan.upserts.find((u) => u.account === A)!.balance).toBeCloseTo(123_456_789_012.345, 0);
    expect(toUnits(150_000_000n, 8)).toBe(1.5);
  });

  it("carries tx count and activity forward and never moves last_active backwards", () => {
    const db = new FakeDb();
    db.rows.set(A, { balanceRaw: "1000", txCount: 41, lastActive: T0 + 500 });
    db.holders = 1;
    db.accounts = 1;
    const s = newChunk(10, null, T0);
    applyBlocks(s, [xfer(A, B, 100n, FEE, T0 + 100)], FEE, 10);
    const plan = db.commit(s);
    expect(plan.upserts.find((u) => u.account === A)).toMatchObject({ balanceRaw: "890", txCount: 42, lastActive: T0 + 500 });
    expect(plan.upserts.find((u) => u.account === B)).toMatchObject({ balanceRaw: "100", txCount: 1, firstSeen: T0 + 100 });
    expect(plan).toMatchObject({ newAccounts: 1, accountsAfter: 2, holdersAfter: 2, negative: 0 });
  });

  it("counts holders by balance: emptied accounts leave, the row stays", () => {
    const db = new FakeDb();
    const s1 = newChunk(0, null);
    applyBlocks(s1, [mint(A, 1000n), xfer(A, B, 500n)], FEE);
    db.commit(s1);
    expect(db.holders).toBe(2);
    const s2 = newChunk(2, null);
    applyBlocks(s2, [xfer(B, C, 490n)], FEE, 2); // B: 500 - 490 - 10 = 0
    db.commit(s2);
    expect(db.balance(B)).toBe(0n);
    expect(db.rows.has(B)).toBe(true);
    expect(db.holders).toBe(2); // A and C
    expect(db.accounts).toBe(3);
  });

  it("reports negative balances (fee collector caveat) and keeps them out of the holder count", () => {
    const db = new FakeDb();
    const s = newChunk(0, null);
    applyBlocks(s, [xfer(A, B, 100n)], FEE); // A was never funded in the replayed range
    const plan = db.commit(s);
    expect(db.balance(A)).toBe(-110n);
    expect(plan.negative).toBe(1);
    expect(db.holders).toBe(1);
  });

  it("books daily activity, new accounts, and end-of-day holders on the right day within one chunk", () => {
    const db = new FakeDb();
    const s = newChunk(0, null);
    applyBlocks(s, [
      mint(A, 1000n, T0), xfer(A, B, 100n, FEE, T0 + 10), // day 0: A, B active and new, holders 2
      xfer(B, C, 90n, FEE, T0 + DAY), // day 1: B emptied, C new, holders 2 (A, C)
      xfer(C, B, 40n, FEE, T0 + 2 * DAY), xfer(A, A, 1n, FEE, T0 + 2 * DAY + 5), // day 2: B back, holders 3
    ], FEE);
    const plan = db.commit(s, 0);
    expect(plan.daily.map((d) => [d.day, d.txs, d.transfers, d.activeAccounts, d.newAccounts, d.holders])).toEqual([
      [D0, 2, 1, 2, 2, 2],
      [D0 + DAY, 1, 1, 2, 1, 2],
      [D0 + 2 * DAY, 2, 2, 3, 0, 3],
    ]);
    expect(plan.daily[0]).toMatchObject({ volume: 100, mints: 1000, fees: 10 });
    expect(plan.holdersAfter).toBe(3);
  });

  it("does not count an account active twice when a day is split across commits", () => {
    const db = new FakeDb();
    const s1 = newChunk(0, null);
    applyBlocks(s1, [mint(A, 1000n, T0), xfer(A, B, 10n, FEE, T0 + 1)], FEE);
    db.commit(s1);
    const s2 = newChunk(2, null, T0 + 1);
    applyBlocks(s2, [xfer(A, B, 10n, FEE, T0 + 2), xfer(A, C, 10n, FEE, T0 + 3)], FEE, 2);
    db.commit(s2);
    expect(db.daily.get(D0)).toMatchObject({ txs: 4, transfers: 3, active: 3, fresh: 3, holders: 3 });
  });
});
