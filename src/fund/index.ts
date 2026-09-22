// Community top-ups ("Fund this canister"). ICPWatch never takes custody: ICP goes to the canister's own
// top-up account on the Cycles Minting Canister (CMC), and the CMC converts it to cycles for that canister.
//
// Facts verified against dfinity/ic rs/nns/cmc/src/main.rs (master, 2026-09-22):
//   notify_top_up has no caller restriction: anyone may notify a block, so ICPWatch can notify deposits
//     other people made. The caller is only consulted for the subnet rental rate limiter.
//   fetch_transaction requires the block to be a Transfer to CMC/subaccount(canister) and to carry the
//     TPUP memo (0x50555054), read from the legacy memo or, when that is 0, from an 8 byte little-endian
//     icrc1_memo (get_u64_memo).
//   A transfer to that account WITHOUT a meaningful memo triggers issue_automatic_refund_if_memo_not_offerred:
//     the CMC sends the ICP back (minus the ledger fee) and the notify returns an error. So a memo-less
//     transfer, for example from an exchange, is refunded by the protocol, not lost, and does not top up.
//   Duplicate notifies of a credited block return the original result. Blocks older than the CMC's
//     purge horizon (one million notifications back) are TransactionTooOld.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import type { Env } from "../env";
import { accountIdHex } from "../lib/account";
import { now } from "../lib/format";
import { CMC, ICP_INDEX, getAgent } from "../lib/ic";
import { fetchXdrRate } from "../lifesupport/funding";
import { fundingOptions, type FundFacts, type FundingOptions } from "./calc";

export const TPUP_MEMO = 0x50555054; // "TPUP"
export const TPUP_MEMO_DECIMAL = "1347768404";

/** ICP account identifier of the CMC subaccount that credits `canisterId`: [len] ++ principal bytes, zero padded. */
export function depositAccount(canisterId: string): string {
  const p = Principal.fromText(canisterId).toUint8Array();
  const sub = new Uint8Array(32);
  sub[0] = p.length;
  sub.set(p, 1);
  return accountIdHex(CMC, sub);
}

/** 8 byte little-endian icrc1_memo form of TPUP, hex. */
export const TPUP_ICRC1_MEMO_HEX = (() => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(TPUP_MEMO), true);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
})();

// ---- CMC notify -----------------------------------------------------------------------------------------------

const cmcIdl: IDL.InterfaceFactory = () => {
  const NotifyError = IDL.Variant({
    Refunded: IDL.Record({ block_index: IDL.Opt(IDL.Nat64), reason: IDL.Text }),
    InvalidTransaction: IDL.Text,
    Other: IDL.Record({ error_message: IDL.Text, error_code: IDL.Nat64 }),
    Processing: IDL.Null,
    TransactionTooOld: IDL.Nat64,
  });
  return IDL.Service({
    notify_top_up: IDL.Func([IDL.Record({ block_index: IDL.Nat64, canister_id: IDL.Principal })], [IDL.Variant({ Ok: IDL.Nat, Err: NotifyError })], []),
  });
};

export type NotifyOutcome = { ok: true; cycles: number } | { ok: false; status: "refunded" | "failed" | "too_old" | "converting"; error: string; refundBlock?: number };

/**
 * Notify the CMC of a top-up block. Update calls are free for the caller, so a fresh throwaway identity
 * per invocation is enough; nothing is signed that moves funds.
 */
export async function notifyTopUp(env: Env, blockIndex: number, canisterId: string): Promise<NotifyOutcome> {
  const identity = Ed25519KeyIdentity.generate();
  const agent = await HttpAgent.create({ host: env.IC_HOST, identity, fetch: (i: RequestInfo | URL, init?: RequestInit) => fetch(i, init), shouldFetchRootKey: false });
  const cmc = Actor.createActor(cmcIdl, { agent, canisterId: CMC });
  const r = (await cmc.notify_top_up!({ block_index: BigInt(blockIndex), canister_id: Principal.fromText(canisterId) })) as
    { Ok: bigint } | { Err: { Refunded?: { block_index: [] | [bigint]; reason: string }; InvalidTransaction?: string; Other?: { error_message: string }; Processing?: null; TransactionTooOld?: bigint } };
  if ("Ok" in r) return { ok: true, cycles: Number(r.Ok) };
  const e = r.Err;
  if (e.Refunded) return { ok: false, status: "refunded", error: `refunded: ${e.Refunded.reason}`, refundBlock: e.Refunded.block_index[0] != null ? Number(e.Refunded.block_index[0]) : undefined };
  if (e.Processing !== undefined) return { ok: false, status: "converting", error: "processing" };
  if (e.TransactionTooOld != null) return { ok: false, status: "too_old", error: `too old: blocks before ${e.TransactionTooOld} can no longer be notified` };
  return { ok: false, status: "failed", error: e.InvalidTransaction ?? e.Other?.error_message ?? "unknown error" };
}

// ---- ICP index: deposits to the account --------------------------------------------------------------------

const indexIdl: IDL.InterfaceFactory = () => {
  const Tokens = IDL.Record({ e8s: IDL.Nat64 });
  const Op = IDL.Variant({
    Transfer: IDL.Record({ to: IDL.Text, fee: Tokens, from: IDL.Text, amount: Tokens, spender: IDL.Opt(IDL.Text) }),
    Mint: IDL.Record({ to: IDL.Text, amount: Tokens }), Burn: IDL.Record({ from: IDL.Text, amount: Tokens, spender: IDL.Opt(IDL.Text) }),
    Approve: IDL.Record({ fee: Tokens, from: IDL.Text, allowance: Tokens, spender: IDL.Text }),
  });
  const Tx = IDL.Record({ memo: IDL.Nat64, icrc1_memo: IDL.Opt(IDL.Vec(IDL.Nat8)), operation: Op, timestamp: IDL.Opt(IDL.Record({ timestamp_nanos: IDL.Nat64 })) });
  return IDL.Service({
    get_account_identifier_transactions: IDL.Func(
      [IDL.Record({ max_results: IDL.Nat64, start: IDL.Opt(IDL.Nat64), account_identifier: IDL.Text })],
      [IDL.Variant({ Ok: IDL.Record({ balance: IDL.Nat64, transactions: IDL.Vec(IDL.Record({ id: IDL.Nat64, transaction: Tx })), oldest_tx_id: IDL.Opt(IDL.Nat64) }), Err: IDL.Record({ message: IDL.Text }) })],
      ["query"],
    ),
  });
};

export interface Deposit { block: number; from: string; e8s: number; memoOk: boolean; ts: number | null }

function memoIsTopUp(memo: bigint, icrc1: Uint8Array | number[] | null): boolean {
  if (memo === BigInt(TPUP_MEMO)) return true;
  if (memo !== 0n || !icrc1 || icrc1.length !== 8) return false;
  const b = icrc1 instanceof Uint8Array ? icrc1 : new Uint8Array(icrc1);
  return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true) === BigInt(TPUP_MEMO);
}

/** Incoming transfers to a deposit account, newest first, from the ICP index canister. */
export async function depositsTo(host: string, accountId: string, max = 20): Promise<Deposit[]> {
  const a = Actor.createActor(indexIdl, { agent: await getAgent(host), canisterId: ICP_INDEX });
  const r = (await a.get_account_identifier_transactions!({ max_results: BigInt(max), start: [], account_identifier: accountId })) as {
    Ok?: { transactions: { id: bigint; transaction: { memo: bigint; icrc1_memo: [] | [Uint8Array]; operation: { Transfer?: { to: string; from: string; amount: { e8s: bigint } } }; timestamp: [] | [{ timestamp_nanos: bigint }] } }[] };
    Err?: { message: string };
  };
  if (!r.Ok) throw new Error(r.Err?.message ?? "index error");
  const out: Deposit[] = [];
  for (const t of r.Ok.transactions) {
    const tr = t.transaction.operation.Transfer;
    if (!tr || tr.to !== accountId) continue;
    out.push({ block: Number(t.id), from: tr.from, e8s: Number(tr.amount.e8s), memoOk: memoIsTopUp(t.transaction.memo, t.transaction.icrc1_memo[0] ?? null), ts: t.transaction.timestamp[0] ? Number(t.transaction.timestamp[0].timestamp_nanos / 1_000_000_000n) : null });
  }
  return out;
}

// ---- intents and the watcher ---------------------------------------------------------------------------------

const INTENT_TTL = 24 * 3600;
const MAX_WATCH_PER_TICK = 40;

/** Someone opened the pay-without-a-wallet panel: watch that canister's deposit account for a day. */
export async function registerIntent(env: Env, canisterId: string, mode: "keep_alive" | "revive", plannedCycles: number | null, plannedE8s: number | null, fromAccount: string | null): Promise<string> {
  const ts = now();
  const id = crypto.randomUUID().replace(/-/g, "");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO fund_intents (id, canister_id, mode, method, planned_cycles, planned_e8s, from_account, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, 'deposit', ?, ?, ?, ?, ?, ?)")
      .bind(id, canisterId, mode, plannedCycles, plannedE8s, fromAccount, ts, ts, ts + INTENT_TTL),
    env.DB.prepare("INSERT INTO fund_watch (canister_id, account_id, watch_until) VALUES (?1, ?2, ?3) ON CONFLICT (canister_id) DO UPDATE SET watch_until = MAX(watch_until, ?3)")
      .bind(canisterId, depositAccount(canisterId), ts + INTENT_TTL),
  ]);
  return id;
}

export interface WatchStats { watched: number; deposits: number; notified: number; credited: number; refunded: number; failed: number; errors: number }

/**
 * Every 5 minutes: read the deposit accounts under watch, record new transfers, and notify the CMC for
 * each block not yet credited. Idempotent: the block index is the primary key, a lease keeps two ticks
 * from notifying the same block at once, and a credited row can never change (database triggers).
 */
export async function watchDeposits(env: Env): Promise<WatchStats> {
  const ts = now();
  const stats: WatchStats = { watched: 0, deposits: 0, notified: 0, credited: 0, refunded: 0, failed: 0, errors: 0 };
  const rows = (await env.DB.prepare("SELECT canister_id, account_id, last_block FROM fund_watch WHERE watch_until > ? AND check_lease < ? ORDER BY last_checked_at LIMIT ?").bind(ts, ts, MAX_WATCH_PER_TICK).all<{ canister_id: string; account_id: string; last_block: number | null }>()).results;
  for (const w of rows) {
    const lease = await env.DB.prepare("UPDATE fund_watch SET check_lease = ?, last_checked_at = ? WHERE canister_id = ? AND check_lease < ?").bind(ts + 240, ts, w.canister_id, ts).run();
    if (!lease.meta.changes) continue;
    stats.watched++;
    try {
      const deps = await depositsTo(env.IC_HOST, w.account_id);
      const intent = await env.DB.prepare("SELECT id, mode FROM fund_intents WHERE canister_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(w.canister_id, ts).first<{ id: string; mode: string }>();
      const idle = await env.DB.prepare("SELECT idle_burn_per_day, burn_per_day, run_status FROM canisters WHERE id = ?").bind(w.canister_id).first<{ idle_burn_per_day: number | null; burn_per_day: number | null; run_status: string }>();
      let maxBlock = w.last_block ?? 0;
      for (const d of deps) {
        maxBlock = Math.max(maxBlock, d.block);
        const ins = await env.DB.prepare("INSERT OR IGNORE INTO fund_deposits (block_index, canister_id, from_account, e8s, memo_ok, block_ts, seen_at, source, status, intent_id, mode, idle_burn_per_day) VALUES (?, ?, ?, ?, ?, ?, ?, 'watcher', ?, ?, ?, ?)")
          .bind(d.block, w.canister_id, d.from, d.e8s, d.memoOk ? 1 : 0, d.ts, ts, d.memoOk ? "pending" : "wrong_memo", intent?.id ?? null, intent?.mode ?? null, idle?.idle_burn_per_day ?? (idle?.run_status === "frozen" ? idle.burn_per_day : null)).run();
        if (ins.meta.changes) stats.deposits++;
      }
      await env.DB.prepare("UPDATE fund_watch SET last_block = ?, last_error = NULL, check_lease = 0 WHERE canister_id = ?").bind(maxBlock, w.canister_id).run();
    } catch (e) {
      stats.errors++;
      await env.DB.prepare("UPDATE fund_watch SET last_error = ?, check_lease = 0 WHERE canister_id = ?").bind(String(e).slice(0, 200), w.canister_id).run();
    }
  }
  // Notify everything pending, up to five attempts, one claim at a time.
  const pending = (await env.DB.prepare("SELECT block_index, canister_id FROM fund_deposits WHERE status IN ('pending', 'converting') AND attempts < 5 AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY block_index LIMIT 20").bind(ts - 300).all<{ block_index: number; canister_id: string }>()).results;
  for (const p of pending) {
    const claim = await env.DB.prepare("UPDATE fund_deposits SET claimed_at = ?, attempts = attempts + 1 WHERE block_index = ? AND (claimed_at IS NULL OR claimed_at < ?)").bind(ts, p.block_index, ts - 300).run();
    if (!claim.meta.changes) continue;
    stats.notified++;
    const r = await notifyTopUp(env, p.block_index, p.canister_id).catch((e): NotifyOutcome => ({ ok: false, status: "failed", error: String(e).slice(0, 200) }));
    if (r.ok) {
      await env.DB.prepare("UPDATE fund_deposits SET status = 'credited', cycles = ?, credited_at = ?, error = NULL WHERE block_index = ?").bind(r.cycles, now(), p.block_index).run();
      stats.credited++;
    } else {
      const status = r.status === "converting" ? "converting" : r.status;
      await env.DB.prepare("UPDATE fund_deposits SET status = ?, error = ?, refund_block = ? WHERE block_index = ?").bind(status, r.error, r.refundBlock ?? null, p.block_index).run();
      if (r.status === "refunded") stats.refunded++;
      else if (r.status !== "converting") stats.failed++;
    }
  }
  await env.DB.prepare("DELETE FROM fund_intents WHERE expires_at < ?").bind(ts - 7 * 86400).run();
  return stats;
}

/** A supporter (or the wallet flow) reports a block they just paid. Recorded and notified right away. */
export async function claimBlock(env: Env, canisterId: string, blockIndex: number, intentId: string | null): Promise<{ status: string; cycles: number | null; error: string | null }> {
  const ts = now();
  const acct = depositAccount(canisterId);
  const deps = await depositsTo(env.IC_HOST, acct, 50);
  const d = deps.find((x) => x.block === blockIndex);
  if (!d) return { status: "not_found", cycles: null, error: "That block is not a transfer to this canister's top-up account (the index may lag by a few seconds)." };
  const intent = intentId ? await env.DB.prepare("SELECT mode FROM fund_intents WHERE id = ? AND canister_id = ?").bind(intentId, canisterId).first<{ mode: string }>() : null;
  await env.DB.prepare("INSERT OR IGNORE INTO fund_deposits (block_index, canister_id, from_account, e8s, memo_ok, block_ts, seen_at, source, status, intent_id, mode) VALUES (?, ?, ?, ?, ?, ?, ?, 'client', ?, ?, ?)")
    .bind(d.block, canisterId, d.from, d.e8s, d.memoOk ? 1 : 0, d.ts, ts, d.memoOk ? "pending" : "wrong_memo", intentId, intent?.mode ?? null).run();
  if (!d.memoOk) return { status: "wrong_memo", cycles: null, error: "The transfer has no TPUP memo. The CMC refunds such transfers automatically; nothing was credited." };
  const r = await notifyTopUp(env, blockIndex, canisterId);
  if (r.ok) {
    await env.DB.prepare("UPDATE fund_deposits SET status = 'credited', cycles = ?, credited_at = ?, attempts = attempts + 1 WHERE block_index = ? AND status != 'credited'").bind(r.cycles, now(), blockIndex).run();
    return { status: "credited", cycles: r.cycles, error: null };
  }
  await env.DB.prepare("UPDATE fund_deposits SET status = ?, error = ?, attempts = attempts + 1 WHERE block_index = ? AND status != 'credited'").bind(r.status, r.error, blockIndex).run();
  return { status: r.status, cycles: null, error: r.error };
}

/** Public record per canister and totals, plus what each top-up bought. */
export interface DepositRow { block_index: number; from_account: string; e8s: number; status: string; cycles: number | null; credited_at: number | null; seen_at: number; mode: string | null; idle_burn_per_day: number | null; display_name: string | null; display_link: string | null }

export async function depositsFor(db: D1Database, canisterId: string, limit = 50): Promise<DepositRow[]> {
  return (await db.prepare("SELECT block_index, from_account, e8s, status, cycles, credited_at, seen_at, mode, idle_burn_per_day, CASE WHEN hidden = 0 AND status = 'credited' THEN display_name END display_name, CASE WHEN hidden = 0 AND status = 'credited' THEN display_link END display_link FROM fund_deposits WHERE canister_id = ? ORDER BY block_index DESC LIMIT ?").bind(canisterId, limit).all<DepositRow>()).results;
}

export async function communityTotals(db: D1Database, canisterId?: string): Promise<{ topups: number; cycles: number; e8s: number; supporters: number }> {
  const r = await db.prepare(`SELECT COUNT(*) topups, COALESCE(SUM(cycles), 0) cycles, COALESCE(SUM(e8s), 0) e8s, COUNT(DISTINCT from_account) supporters FROM fund_deposits WHERE status = 'credited'${canisterId ? " AND canister_id = ?" : ""}`).bind(...(canisterId ? [canisterId] : [])).first<{ topups: number; cycles: number; e8s: number; supporters: number }>();
  return r ?? { topups: 0, cycles: 0, e8s: 0, supporters: 0 };
}

/** Community cycles credited to a canister since `sinceTs`, for the life support engine's audit view. */
export async function communityFundedCycles(db: D1Database, canisterId: string, sinceTs: number): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(cycles), 0) c FROM fund_deposits WHERE canister_id = ? AND status = 'credited' AND credited_at >= ?").bind(canisterId, sinceTs).first<{ c: number }>();
  return r?.c ?? 0;
}

/** Supporter attribution: only the sending account can name itself, only once credited, plain text. */
export async function setSupporterName(env: Env, blockIndex: number, fromAccount: string, name: string, link: string | null): Promise<boolean> {
  const clean = name.replace(/[<>]/g, "").trim().slice(0, 40);
  const url = link && /^https:\/\/[^\s]{5,200}$/.test(link) ? link : null;
  const r = await env.DB.prepare("UPDATE fund_deposits SET display_name = ?, display_link = ?, display_set_at = ? WHERE block_index = ? AND from_account = ? AND status = 'credited' AND display_set_at IS NULL").bind(clean || null, url, now(), blockIndex, fromAccount).run();
  return !!r.meta.changes;
}

/** Everything the panel needs for one canister, computed from the latest Lifeline reading and the live XDR rate. */
export async function fundingFor(env: Env, canisterId: string): Promise<{ options: FundingOptions; account: string; totals: Awaited<ReturnType<typeof communityTotals>>; deposits: DepositRow[] } | null> {
  const c = await env.DB.prepare("SELECT c.id, c.cycles, c.run_status, c.health, c.idle_burn_per_day, c.freezing_threshold_s, c.burn_per_day, c.burn_baseline FROM canisters c WHERE c.id = ?").bind(canisterId).first<{ id: string; cycles: number | null; run_status: string; health: string; idle_burn_per_day: number | null; freezing_threshold_s: number | null; burn_per_day: number | null; burn_baseline: number | null }>();
  if (!c) return null;
  const [rate, price, totals, deposits] = await Promise.all([
    fetchXdrRate(env.IC_HOST).catch(() => null),
    env.DB.prepare("SELECT price_usd FROM market WHERE token_id = 'ryjl3-tyaaa-aaaaa-aaaba-cai'").first<{ price_usd: number | null }>(),
    communityTotals(env.DB, canisterId), depositsFor(env.DB, canisterId, 20),
  ]);
  const facts: FundFacts = { canisterId, cycles: c.cycles, runStatus: c.run_status, health: c.health, idleBurnPerDay: c.idle_burn_per_day, freezingThresholdS: c.freezing_threshold_s, observedBurnPerDay: c.burn_per_day, baselineBurnPerDay: c.burn_baseline };
  const xdr = rate ? Number((rate as { xdrPermyriadPerIcp: bigint | number }).xdrPermyriadPerIcp) : null;
  return { options: fundingOptions(facts, xdr, price?.price_usd ?? null, now()), account: depositAccount(canisterId), totals, deposits };
}
