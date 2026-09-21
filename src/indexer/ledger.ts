// Block indexer IC access: read-only queries against ICRC ledgers and their archive canisters.
// Nothing here sends an update call, tokens, or cycles.
//
// Blocks are read with get_transactions (DFINITY ic-icrc1-ledger). The ledger only keeps its most
// recent blocks inline. Older ranges come back as archived_transactions entries that name the
// archive canister, which is then queried with the same method. Only the fields the indexer needs
// are declared: candid record subtyping skips the rest, which keeps decoding cheap.
//
// TODO: the ICP ledger (ryjl3-tyaaa-aaaaa-aaaba-cai) is not handled. It uses query_blocks with a
// different block format (AccountIdentifier hashes instead of accounts) and has about 38M blocks.
import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "../lib/ic";
import { accountText, type Tx } from "./core";

const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
const Transaction = IDL.Record({
  timestamp: IDL.Nat64,
  mint: IDL.Opt(IDL.Record({ to: Account, amount: IDL.Nat })),
  burn: IDL.Opt(IDL.Record({ from: Account, amount: IDL.Nat })),
  transfer: IDL.Opt(IDL.Record({ from: Account, to: Account, amount: IDL.Nat, fee: IDL.Opt(IDL.Nat) })),
  approve: IDL.Opt(IDL.Record({ from: Account, fee: IDL.Opt(IDL.Nat) })),
});
const Range = IDL.Record({ start: IDL.Nat, length: IDL.Nat });
const ArchiveResponse = IDL.Record({ transactions: IDL.Vec(Transaction) });
const LedgerResponse = IDL.Record({
  first_index: IDL.Nat, log_length: IDL.Nat, transactions: IDL.Vec(Transaction),
  archived_transactions: IDL.Vec(IDL.Record({ start: IDL.Nat, length: IDL.Nat, callback: IDL.Func([Range], [ArchiveResponse], ["query"]) })),
});
const ArchivesResponse = IDL.Vec(IDL.Record({ canister_id: IDL.Principal, block_range_start: IDL.Nat, block_range_end: IDL.Nat }));

interface RawAccount { owner: Principal; subaccount: [] | [Uint8Array | number[]] }
interface RawTx {
  timestamp: bigint;
  mint: [] | [{ to: RawAccount; amount: bigint }];
  burn: [] | [{ from: RawAccount; amount: bigint }];
  transfer: [] | [{ from: RawAccount; to: RawAccount; amount: bigint; fee: [] | [bigint] }];
  approve: [] | [{ from: RawAccount; fee: [] | [bigint] }];
}
interface RawLedgerResponse {
  first_index: bigint; log_length: bigint; transactions: RawTx[];
  archived_transactions: { start: bigint; length: bigint; callback: [Principal, string] }[];
}

/**
 * Counters shared by every call in a tick, so the orchestrator can enforce its subrequest budget.
 * decodeMs is only meaningful in local workerd: in production Date.now() does not advance during CPU work.
 */
export interface CallMeter {
  icCalls: number; fetchMs: number; decodeMs: number; bytes: number;
  /** Epoch ms after which nobody is waiting for answers. Calls time out earlier as it approaches. */
  deadline?: number;
}
export const newMeter = (): CallMeter => ({ icCalls: 0, fetchMs: 0, decodeMs: 0, bytes: 0 });

export class IcRejectError extends Error {
  constructor(public canister: string, public method: string, public code: string | null, message: string) {
    super(`${method} on ${canister} rejected${code ? ` (${code})` : ""}: ${message}`.slice(0, 400));
  }
}

const CALL_TIMEOUT_MS = 20_000;

async function rawQuery(host: string, canister: string, method: string, arg: Uint8Array, meter: CallMeter): Promise<Uint8Array> {
  const agent = await getAgent(host);
  meter.icCalls++;
  const t0 = Date.now();
  const timeoutMs = meter.deadline ? Math.max(3000, Math.min(CALL_TIMEOUT_MS, meter.deadline - t0)) : CALL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = (await Promise.race([
      agent.query(canister, { methodName: method, arg }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} on ${canister} timed out`)), timeoutMs); }),
    ])) as { status: string; reply?: { arg: Uint8Array }; error_code?: string; reject_message?: string };
    if (res.status !== "replied" || !res.reply) throw new IcRejectError(canister, method, res.error_code ?? null, res.reject_message ?? res.status);
    meter.bytes += res.reply.arg.byteLength;
    return res.reply.arg;
  } catch (e) {
    if (e instanceof IcRejectError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new IcRejectError(canister, method, /\b(IC\d{4})\b/.exec(message)?.[1] ?? null, message);
  } finally {
    if (timer) clearTimeout(timer);
    meter.fetchMs += Date.now() - t0;
  }
}

function decode<T>(types: IDL.Type[], bytes: Uint8Array, meter: CallMeter): T {
  const t0 = Date.now();
  const out = IDL.decode(types, bytes)[0] as T;
  meter.decodeMs += Date.now() - t0;
  return out;
}

const acct = (a: RawAccount) => accountText(a.owner, a.subaccount[0] ?? null);
const NS = 1_000_000_000n;

/** Which operation a transaction is comes from the populated field, not the kind text, so new kind labels cannot break it. */
export function toTx(t: RawTx): Tx {
  const ts = Number(t.timestamp / NS);
  const tr = t.transfer[0];
  if (tr) return { kind: "transfer", ts, from: acct(tr.from), to: acct(tr.to), amount: tr.amount, fee: tr.fee[0] ?? null };
  const mint = t.mint[0];
  if (mint) return { kind: "mint", ts, from: null, to: acct(mint.to), amount: mint.amount, fee: null };
  const burn = t.burn[0];
  if (burn) return { kind: "burn", ts, from: acct(burn.from), to: null, amount: burn.amount, fee: null };
  const ap = t.approve[0];
  if (ap) return { kind: "approve", ts, from: acct(ap.from), to: null, amount: 0n, fee: ap.fee[0] ?? null };
  return { kind: "other", ts, from: null, to: null, amount: 0n, fee: null };
}

function mapTxs(raw: RawTx[], meter: CallMeter): Tx[] {
  const t0 = Date.now();
  const out = raw.map(toTx);
  meter.decodeMs += Date.now() - t0;
  return out;
}

const rangeArg = (start: number, length: number) => IDL.encode([Range], [{ start: BigInt(start), length: BigInt(length) }]);

export interface ArchivedRef { canister: string; method: string; start: number; length: number }
export interface LedgerPage {
  /** log_length: the index the next block will get. */
  tip: number;
  /** First block the ledger still holds itself. Everything below is in archives. */
  firstIndex: number;
  /** Index of txs[0] (max(start, firstIndex)). */
  inlineStart: number;
  txs: Tx[];
  archived: ArchivedRef[];
}

/** One get_transactions call on the ledger. With length 0 it is a cheap way to read the tip. */
export async function ledgerPage(host: string, ledger: string, start: number, length: number, meter: CallMeter): Promise<LedgerPage> {
  const bytes = await rawQuery(host, ledger, "get_transactions", rangeArg(start, length), meter);
  const r = decode<RawLedgerResponse>([LedgerResponse], bytes, meter);
  const firstIndex = Number(r.first_index);
  return {
    tip: Number(r.log_length), firstIndex, inlineStart: Math.max(start, firstIndex), txs: mapTxs(r.transactions, meter),
    archived: r.archived_transactions.map((a) => ({ canister: a.callback[0].toText(), method: a.callback[1], start: Number(a.start), length: Number(a.length) })),
  };
}

/** Blocks straight from an archive canister. Returns fewer than asked when the archive caps its responses. */
export async function archivePage(host: string, canister: string, method: string, start: number, length: number, meter: CallMeter): Promise<Tx[]> {
  const bytes = await rawQuery(host, canister, method, rangeArg(start, length), meter);
  return mapTxs(decode<{ transactions: RawTx[] }>([ArchiveResponse], bytes, meter).transactions, meter);
}

/**
 * Contiguous blocks from `start` through the ledger, following archive callbacks when part of the
 * range has been archived. Stops at the first piece that comes back short, so the result is always
 * gap free: txs[i] is block start + i.
 */
export async function ledgerRange(host: string, ledger: string, start: number, length: number, meter: CallMeter, first?: LedgerPage): Promise<{ tip: number; txs: Tx[] }> {
  const page = first ?? (await ledgerPage(host, ledger, start, length, meter));
  const txs: Tx[] = [];
  let next = start;
  for (const a of [...page.archived].sort((x, y) => x.start - y.start)) {
    if (a.start !== next) return { tip: page.tip, txs };
    const got = await archivePage(host, a.canister, a.method, a.start, a.length, meter);
    for (const t of got) txs.push(t);
    next += got.length;
    if (got.length < a.length) return { tip: page.tip, txs };
  }
  if (page.txs.length && page.inlineStart === next) for (const t of page.txs) txs.push(t);
  return { tip: page.tip, txs };
}

export interface ArchiveRange { canister: string; start: number; end: number }

/** Archive canisters and the block ranges they hold. Empty when the ledger has none or lacks the method. */
export async function ledgerArchives(host: string, ledger: string, meter: CallMeter): Promise<ArchiveRange[]> {
  try {
    const bytes = await rawQuery(host, ledger, "archives", IDL.encode([], []), meter);
    const r = decode<{ canister_id: Principal; block_range_start: bigint; block_range_end: bigint }[]>([ArchivesResponse], bytes, meter);
    return r.map((a) => ({ canister: a.canister_id.toText(), start: Number(a.block_range_start), end: Number(a.block_range_end) })).sort((x, y) => x.start - y.start);
  } catch {
    return [];
  }
}

async function natQuery(host: string, ledger: string, method: string, type: IDL.Type, meter: CallMeter): Promise<bigint> {
  const bytes = await rawQuery(host, ledger, method, IDL.encode([], []), meter);
  return BigInt(decode<bigint | number>([type], bytes, meter));
}

export const ledgerFee = (host: string, ledger: string, meter: CallMeter) => natQuery(host, ledger, "icrc1_fee", IDL.Nat, meter);
export const ledgerSupply = (host: string, ledger: string, meter: CallMeter) => natQuery(host, ledger, "icrc1_total_supply", IDL.Nat, meter);
export const ledgerDecimals = async (host: string, ledger: string, meter: CallMeter) => Number(await natQuery(host, ledger, "icrc1_decimals", IDL.Nat8, meter));
