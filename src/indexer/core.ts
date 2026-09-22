// Block indexer core: pure functions, no IO. Everything here is unit tested (test/indexer.test.ts).
//
// The model: a "chunk" is a contiguous run of ledger blocks [startBlock, nextBlock). applyBlocks
// folds transactions into in-memory deltas for the chunk. planCommit turns the chunk plus the rows
// already in the database into absolute values to write. Nothing is written per block, so a busy
// account that moves 5,000 times in a tick costs one row write, not 5,000.
//
// Balance rules for DFINITY ICRC-1/2 ledgers:
//   mint      to   += amount
//   burn      from -= amount
//   transfer  from -= amount + fee, to += amount   (a self transfer nets to -fee)
//   approve   from -= fee
// The fee is the one in the block. get_transactions already substitutes the block's effective fee
// when the caller did not name one, so the ledger's current icrc1_fee (defaultFee) is only a last resort.
//
// FEE COLLECTORS (algo version 2). A DFINITY ICRC ledger configured with a fee collector (every ck token:
// the minter's 0x0fee subaccount) credits TRANSFER fees to that account instead of burning them. The first
// block after the collector is set carries fee_col (the account), later blocks carry fee_col_block (the index
// of that first block). Blocks with neither burn the fee. APPROVE fees are always burned by those ledgers, even
// while a collector is set (verified: ckBTC, ckETH and ckUSDC reconcile to zero with this rule and do not with
// the other). ICRC-107 replaces this: after a "107feecol" block every fee, approve included, goes to the account
// it names (or is burned when it names none) and the legacy fields are ignored.
// get_transactions does not expose any of this, so blocks are read in generic form (see ledger.ts). With the
// "tx" source every fee is treated as burned and the reconcile gate decides whether that was right.
// Negative balances are kept as computed (never clamped) and excluded from holder counts.
import { Principal } from "@icp-sdk/core/principal";

export const DAY = 86_400;

export type TxKind = "mint" | "burn" | "transfer" | "approve" | "other";

/** A ledger transaction reduced to what the indexer needs. Accounts are already in text form (accountText). */
export interface Tx {
  kind: TxKind;
  /** Block timestamp, unix seconds. */
  ts: number;
  from: string | null;
  to: string | null;
  amount: bigint;
  /** Fee recorded in the block, null when the block carries none. */
  fee: bigint | null;
  /** fee_col: this block declares the fee collector account (and pays its own fee to it). */
  feeCol?: string | null;
  /** fee_col_block: index of the earlier block whose fee_col receives this block's fee. */
  feeColBlock?: number | null;
  /** ICRC-107 "107feecol" block: the ledger-wide collector from here on. null means fees are burned again. */
  setFeeCol?: string | null;
}

/** Fee collector declarations of one ledger, carried across chunks and persisted in idx_state.fee_cols. */
export interface FeeCols {
  /** Block index of a fee_col block to the account it named. */
  blocks: Map<number, string>;
  /** ICRC-107 collector. undefined: the ledger never set one, legacy per-block fields apply. */
  global: string | null | undefined;
  /** Set when something was added, so the caller knows to persist. */
  dirty: boolean;
}
export const newFeeCols = (): FeeCols => ({ blocks: new Map(), global: undefined, dirty: false });
export function parseFeeCols(json: string | null | undefined): FeeCols {
  const out = newFeeCols();
  if (!json) return out;
  try {
    const o = JSON.parse(json) as { blocks?: Record<string, string>; global?: string | null };
    for (const [k, v] of Object.entries(o.blocks ?? {})) out.blocks.set(Number(k), v);
    if ("global" in o) out.global = o.global ?? null;
  } catch { /* unreadable: start empty, references get resolved from the chain again */ }
  return out;
}
export function feeColsJson(f: FeeCols): string | null {
  if (!f.blocks.size && f.global === undefined) return null;
  return JSON.stringify({ blocks: Object.fromEntries(f.blocks), ...(f.global !== undefined ? { global: f.global } : {}) });
}

/** A block names a fee_col_block this index has never seen (it tails a ledger replayed before version 2). */
export class UnknownFeeColError extends Error {
  constructor(public blocks: number[]) { super(`unknown fee collector block ${blocks.join(", ")}`); }
}

export interface AccountDelta {
  delta: bigint;
  txCount: number;
  firstTs: number;
  lastTs: number;
  /** First and latest UTC day (unix seconds at 00:00) this account was touched within the chunk. */
  firstDay: number;
  lastDay: number;
  /** [day, delta at the end of that day] for every earlier day in the chunk. Null for the common single-day case. */
  marks: [number, bigint][] | null;
}

export interface DayAgg {
  day: number;
  txs: number;
  transfers: number;
  volume: bigint;
  mints: bigint;
  burns: bigint;
  fees: bigint;
  /** Accounts whose activity on this day is certainly their first of the day (they were seen on an earlier day in the chunk). */
  activeRepeat: number;
}

export interface BigTransfer { block: number; ts: number; kind: "transfer" | "mint" | "burn"; from: string | null; to: string | null; amount: bigint }

export interface ChunkState {
  startBlock: number;
  /** Index of the next block to apply. Blocks below it are ignored, which makes overlapping batches idempotent. */
  nextBlock: number;
  /** Timestamp of the last applied block (monotonic). */
  lastTs: number;
  /** Movements of at least this many base units are kept as large transfers. Null disables the feed. */
  minBig: bigint | null;
  accounts: Map<string, AccountDelta>;
  days: Map<number, DayAgg>;
  big: BigTransfer[];
  /** Shared with the chunks before and after this one. */
  feeCols: FeeCols;
  /** fees = feesBurned + feesCollected. minted - burned - feesBurned is the chunk's effect on total supply. */
  totals: {
    blocks: number; transfers: number; mints: number; burns: number; approves: number; other: number; volume: bigint; minted: bigint; burned: bigint;
    fees: bigint; feesBurned: bigint; feesCollected: bigint; defaultFeeUsed: number;
  };
}

export function newChunk(startBlock: number, minBig: bigint | null, lastTs = 0, feeCols: FeeCols = newFeeCols()): ChunkState {
  return {
    startBlock, nextBlock: startBlock, lastTs, minBig, accounts: new Map(), days: new Map(), big: [], feeCols,
    totals: { blocks: 0, transfers: 0, mints: 0, burns: 0, approves: 0, other: 0, volume: 0n, minted: 0n, burned: 0n, fees: 0n, feesBurned: 0n, feesCollected: 0n, defaultFeeUsed: 0 },
  };
}

// ---- account text (ICRC-1 textual encoding) ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * The key used everywhere for an account: the ICRC-1 textual encoding.
 *   default subaccount (absent or all zero): "<owner principal>"
 *   otherwise: "<owner principal>-<checksum>.<subaccount hex, leading zeros removed>"
 * where checksum is base32(crc32(owner bytes + 32 subaccount bytes)). This is the form wallets and
 * the NNS dapp accept, so it can be shown and pasted as is.
 */
export function accountText(owner: Principal, subaccount?: Uint8Array | number[] | null): string {
  const text = owner.toText();
  if (!subaccount || subaccount.length === 0) return text;
  let first = 0;
  while (first < subaccount.length && subaccount[first] === 0) first++;
  if (first === subaccount.length) return text;
  const sub = new Uint8Array(32);
  sub.set(subaccount.length > 32 ? subaccount.slice(subaccount.length - 32) : subaccount, Math.max(0, 32 - subaccount.length));
  const crc = crc32([owner.toUint8Array(), sub]);
  const checksum = base32(new Uint8Array([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]));
  let hex = "";
  for (const b of sub) hex += b.toString(16).padStart(2, "0");
  return `${text}-${checksum}.${hex.replace(/^0+/, "")}`;
}

/** Owner principal text of an account key produced by accountText. */
export function ownerOf(account: string): string {
  const dot = account.indexOf(".");
  if (dot < 0) return account;
  const head = account.slice(0, dot);
  return head.slice(0, head.lastIndexOf("-"));
}

export const dayOf = (ts: number) => Math.floor(ts / DAY) * DAY;

// ---- folding blocks ---------------------------------------------------------------------------------------

function dayAgg(state: ChunkState, day: number): DayAgg {
  let d = state.days.get(day);
  if (!d) {
    d = { day, txs: 0, transfers: 0, volume: 0n, mints: 0n, burns: 0n, fees: 0n, activeRepeat: 0 };
    state.days.set(day, d);
  }
  return d;
}

/** counts = false for fee collector credits: the balance moves, but it is not a transaction of that account. */
function touch(state: ChunkState, agg: DayAgg, account: string, delta: bigint, ts: number, counts = true): void {
  const a = state.accounts.get(account);
  if (!a) {
    state.accounts.set(account, { delta, txCount: counts ? 1 : 0, firstTs: ts, lastTs: ts, firstDay: agg.day, lastDay: agg.day, marks: null });
    return;
  }
  if (a.lastDay !== agg.day) {
    (a.marks ??= []).push([a.lastDay, a.delta]);
    a.lastDay = agg.day;
    agg.activeRepeat++;
  }
  a.delta += delta;
  if (counts) a.txCount++;
  a.lastTs = ts;
}

/** fee_col_block references in txs (from index `skip` on) that feeCols cannot resolve, including ones declared earlier in the same batch. */
export function missingFeeCols(feeCols: FeeCols, txs: readonly Tx[], firstIndex: number, skip = 0): number[] {
  const missing = new Set<number>();
  for (let i = Math.max(0, skip); i < txs.length; i++) {
    const ref = txs[i]!.feeColBlock;
    if (ref == null || feeCols.blocks.has(ref)) continue;
    const local = ref - firstIndex;
    if (local >= 0 && local < i && txs[local]!.feeCol != null) continue;
    missing.add(ref);
  }
  return [...missing];
}

/**
 * Who receives the fee of this block: an account, or null when it is burned. Registers fee_col and 107feecol
 * declarations as a side effect, so call it exactly once per block, in block order.
 */
export function feeSink(feeCols: FeeCols, tx: Tx, block: number): string | null {
  if (tx.setFeeCol !== undefined) {
    feeCols.global = tx.setFeeCol;
    feeCols.dirty = true;
  }
  if (tx.feeCol != null && feeCols.blocks.get(block) !== tx.feeCol) {
    feeCols.blocks.set(block, tx.feeCol);
    feeCols.dirty = true;
  }
  if (feeCols.global !== undefined) return feeCols.global;
  if (tx.kind !== "transfer") return null; // legacy collectors never receive approve fees
  if (tx.feeCol != null) return tx.feeCol;
  if (tx.feeColBlock != null) return feeCols.blocks.get(tx.feeColBlock) ?? null;
  return null;
}

/**
 * Effect of each block on total supply: mint +amount, burn -amount, fees minus what a collector received.
 * Used by the reconcile gate to evaluate the blocks that landed while the supply was being read. Works on a
 * copy of the collector state, so nothing is registered for real.
 */
export function supplyDeltas(feeCols: FeeCols, txs: readonly Tx[], defaultFee: bigint, firstIndex: number): bigint[] {
  const copy: FeeCols = { blocks: new Map(feeCols.blocks), global: feeCols.global, dirty: false };
  return txs.map((tx, i) => {
    const sink = feeSink(copy, tx, firstIndex + i);
    if (tx.kind === "mint") return tx.to == null ? 0n : tx.amount;
    if (tx.kind === "burn") return tx.from == null ? 0n : -tx.amount;
    if (tx.kind === "transfer") return tx.from == null || tx.to == null || sink != null ? 0n : -(tx.fee ?? defaultFee);
    if (tx.kind === "approve") return tx.from == null || sink != null ? 0n : -(tx.fee ?? defaultFee);
    return 0n;
  });
}

/**
 * Fold a batch of transactions into the chunk. txs[0] is block firstIndex. Blocks the chunk already
 * contains are skipped, so re-feeding an overlapping batch after a retry cannot double count. A gap
 * (firstIndex beyond the chunk's next block) throws, because balances would silently be wrong.
 * Returns the number of blocks applied.
 */
export function applyBlocks(state: ChunkState, txs: readonly Tx[], defaultFee: bigint, firstIndex: number = state.nextBlock): number {
  if (firstIndex > state.nextBlock) throw new Error(`block gap: expected ${state.nextBlock}, got ${firstIndex}`);
  const skip = state.nextBlock - firstIndex;
  // Checked before anything is folded: throwing halfway through a batch would leave the chunk half applied.
  const unknown = missingFeeCols(state.feeCols, txs, firstIndex, skip);
  if (unknown.length) throw new UnknownFeeColError(unknown);
  const tot = state.totals;
  let applied = 0;
  for (let i = skip; i < txs.length; i++) {
    const tx = txs[i]!;
    const block = firstIndex + i;
    // Ledger time never runs backwards. Clamp anyway so day accounting cannot be corrupted by one odd block.
    const ts = tx.ts > state.lastTs ? tx.ts : state.lastTs;
    state.lastTs = ts;
    const agg = dayAgg(state, dayOf(ts));
    agg.txs++;
    tot.blocks++;
    const sink = feeSink(state.feeCols, tx, block);
    const payFee = (fee: bigint) => {
      agg.fees += fee;
      tot.fees += fee;
      if (sink == null || fee === 0n) tot.feesBurned += fee;
      else {
        tot.feesCollected += fee;
        touch(state, agg, sink, fee, ts, false);
      }
    };
    switch (tx.kind) {
      case "mint":
        if (tx.to == null) break;
        touch(state, agg, tx.to, tx.amount, ts);
        agg.mints += tx.amount;
        tot.mints++;
        tot.minted += tx.amount;
        break;
      case "burn":
        if (tx.from == null) break;
        touch(state, agg, tx.from, -tx.amount, ts);
        agg.burns += tx.amount;
        tot.burns++;
        tot.burned += tx.amount;
        break;
      case "transfer": {
        if (tx.from == null || tx.to == null) break;
        if (tx.fee == null) tot.defaultFeeUsed++;
        const fee = tx.fee ?? defaultFee;
        if (tx.from === tx.to) touch(state, agg, tx.from, -fee, ts);
        else {
          touch(state, agg, tx.from, -(tx.amount + fee), ts);
          touch(state, agg, tx.to, tx.amount, ts);
        }
        payFee(fee);
        agg.transfers++;
        agg.volume += tx.amount;
        tot.transfers++;
        tot.volume += tx.amount;
        break;
      }
      case "approve": {
        if (tx.from == null) break;
        if (tx.fee == null) tot.defaultFeeUsed++;
        const fee = tx.fee ?? defaultFee;
        touch(state, agg, tx.from, -fee, ts);
        payFee(fee);
        tot.approves++;
        break;
      }
      default:
        tot.other++; // a block type this indexer does not know. Counted, no balance effect.
    }
    if (state.minBig != null && tx.amount >= state.minBig && (tx.kind === "transfer" || tx.kind === "mint" || tx.kind === "burn")) {
      state.big.push({ block, ts, kind: tx.kind, from: tx.from, to: tx.to, amount: tx.amount });
    }
    applied++;
  }
  state.nextBlock = Math.max(state.nextBlock, firstIndex + txs.length);
  return applied;
}

// ---- turning a chunk into rows ----------------------------------------------------------------------------

/** What the database already holds for an account touched by the chunk. */
export interface ExistingRow { balanceRaw: string; txCount: number; lastActive: number }

export interface BalanceUpsert { account: string; owner: string; balance: number; balanceRaw: string; txCount: number; firstSeen: number; lastActive: number }
export interface DailyRow {
  day: number; txs: number; transfers: number; volume: number; mints: number; burns: number; fees: number;
  activeAccounts: number; newAccounts: number; holders: number;
}
export interface BigRow { block: number; ts: number; kind: string; from: string | null; to: string | null; amount: number; amountRaw: string }

export interface CommitPlan {
  upserts: BalanceUpsert[];
  /** Additive per-day increments, except holders which is the absolute count at the end of the day. */
  daily: DailyRow[];
  big: BigRow[];
  holdersAfter: number;
  accountsAfter: number;
  newAccounts: number;
  /** Accounts whose computed balance is below zero after this chunk. Should be zero: a negative balance means a rule is wrong for this ledger. */
  negative: number;
}

/** Base units to whole tokens as a float. For ordering and charts only, never for display of exact amounts. */
export function toUnits(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Combine the chunk's deltas with the rows already stored. Balances and tx counts come out absolute,
 * so writing them is an overwrite, not an increment. Holder counts per day are exact: every account
 * remembers its running delta at the end of each day it was touched, and a holder transition is
 * booked on the day the balance crossed zero.
 */
export function planCommit(state: ChunkState, existing: ReadonlyMap<string, ExistingRow>, before: { holders: number; accounts: number }, decimals: number): CommitPlan {
  const upserts: BalanceUpsert[] = [];
  const firstActive = new Map<number, number>();
  const fresh = new Map<number, number>();
  const transitions = new Map<number, number>();
  const bump = (m: Map<number, number>, day: number, by: number) => m.set(day, (m.get(day) ?? 0) + by);
  let newAccounts = 0;
  let negative = 0;

  for (const [account, a] of state.accounts) {
    const prev = existing.get(account);
    const old = prev ? BigInt(prev.balanceRaw) : 0n;
    const balance = old + a.delta;
    if (!prev) {
      newAccounts++;
      bump(fresh, a.firstDay, 1);
    }
    // Later days in the chunk were counted while folding. The first day counts only if the
    // database has not already seen this account active on that day (an earlier chunk or tick).
    if (!prev || dayOf(prev.lastActive) < a.firstDay) bump(firstActive, a.firstDay, 1);
    let positive = old > 0n;
    if (a.marks) {
      for (const [day, delta] of a.marks) {
        const now = old + delta > 0n;
        if (now !== positive) bump(transitions, day, now ? 1 : -1);
        positive = now;
      }
    }
    const end = balance > 0n;
    if (end !== positive) bump(transitions, a.lastDay, end ? 1 : -1);
    if (balance < 0n) negative++;
    upserts.push({
      account, owner: ownerOf(account), balance: toUnits(balance, decimals), balanceRaw: balance.toString(),
      txCount: (prev?.txCount ?? 0) + a.txCount, firstSeen: a.firstTs, lastActive: Math.max(a.lastTs, prev?.lastActive ?? 0),
    });
  }

  let holders = before.holders;
  const daily: DailyRow[] = [...state.days.values()].sort((x, y) => x.day - y.day).map((d) => {
    holders += transitions.get(d.day) ?? 0;
    return {
      day: d.day, txs: d.txs, transfers: d.transfers, volume: toUnits(d.volume, decimals), mints: toUnits(d.mints, decimals),
      burns: toUnits(d.burns, decimals), fees: toUnits(d.fees, decimals), activeAccounts: d.activeRepeat + (firstActive.get(d.day) ?? 0),
      newAccounts: fresh.get(d.day) ?? 0, holders,
    };
  });

  return {
    upserts, daily,
    big: state.big.map((b) => ({ block: b.block, ts: b.ts, kind: b.kind, from: b.from, to: b.to, amount: toUnits(b.amount, decimals), amountRaw: b.amount.toString() })),
    holdersAfter: holders, accountsAfter: before.accounts + newAccounts, newAccounts, negative,
  };
}

/**
 * Default large-transfer threshold: 0.1 percent of total supply. Measured on a full replay, 0.01 percent kept
 * about 5 percent of all blocks (20 percent on ckUSDC), which is a feed of nothing and a lot of row writes.
 * Callers with prices should pass USD-based thresholds instead (indexJob does).
 */
export function defaultBigThreshold(totalSupplyRaw: bigint, divisor = 1_000n): bigint | null {
  if (totalSupplyRaw <= 0n) return null;
  const t = totalSupplyRaw / divisor;
  return t > 0n ? t : 1n;
}
