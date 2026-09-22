// Block indexer IC access: read-only queries against ledgers and their archive canisters.
// Nothing here sends an update call, tokens, or cycles.
//
// Four block sources, one Reader interface (readerFor):
//   blocks  get_blocks (DFINITY ic-icrc1-ledger). Generic value blocks, 2000 per call on ledger and archives.
//           The preferred source: it carries fee_col / fee_col_block, which get_transactions hides.
//   tx      get_transactions. Typed and a little cheaper to decode, but no fee collector data. Fallback for
//           ledgers without get_blocks.
//   icrc3   icrc3_get_blocks. The only source some non-DFINITY ledgers offer. Archives answer as few as 50 or
//           100 blocks per call, so it is the last resort. Blocks carry their id, so misalignment is detected.
//   icp     the ICP ledger: query_blocks, archives answer get_blocks. Accounts are 32 byte account identifiers.
// The ledger only keeps its most recent blocks inline. Older ranges come back as archived entries that name
// the archive canister and method. Only the fields the indexer needs are declared where the type allows it:
// candid record subtyping skips the rest, which keeps decoding cheap.
import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "../lib/ic";
import { Principal as PrincipalClass } from "@icp-sdk/core/principal";
import { accountText, type Tx } from "./core";
import { BlockDecodeError, BlockGapError, IcRejectError } from "./failures";
export { BlockDecodeError, BlockGapError, IcRejectError };

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

export type BlockSource = "blocks" | "tx" | "icrc3" | "icp";
/** Order in which sources are tried for an ICRC ledger. */
export const ICRC_SOURCES: BlockSource[] = ["blocks", "tx", "icrc3"];

export interface ArchivedRef { canister: string; method: string; start: number; length: number }
export interface LedgerPage {
  /** log_length: the index the next block will get. */
  tip: number;
  /** First block the ledger still holds itself. Everything below is in archives. Null when the source does not say (icrc3). */
  firstIndex: number | null;
  /** Index of txs[0]. */
  inlineStart: number;
  txs: Tx[];
  archived: ArchivedRef[];
}

// ---- generic value blocks (get_blocks and icrc3_get_blocks) ---------------------------------------------

type RawValue =
  | { Blob: Uint8Array | number[] } | { Text: string } | { Nat: bigint } | { Nat64: bigint } | { Int: bigint }
  | { Array: RawValue[] } | { Map: [string, RawValue][] };

const Value = IDL.Rec();
Value.fill(IDL.Variant({ Blob: IDL.Vec(IDL.Nat8), Text: IDL.Text, Nat: IDL.Nat, Nat64: IDL.Nat64, Int: IDL.Int, Array: IDL.Vec(Value), Map: IDL.Vec(IDL.Tuple(IDL.Text, Value)) }));
// ICRC-3 proper has no Nat64 arm. Decoding with the wider type is fine: the wire type only has to be a subtype.
const BlocksArchiveResponse = IDL.Record({ blocks: IDL.Vec(Value) });
const BlocksLedgerResponse = IDL.Record({
  first_index: IDL.Nat, chain_length: IDL.Nat64, blocks: IDL.Vec(Value),
  archived_blocks: IDL.Vec(IDL.Record({ start: IDL.Nat, length: IDL.Nat, callback: IDL.Func([Range], [BlocksArchiveResponse], ["query"]) })),
});
const Icrc3Req = IDL.Vec(Range);
const Icrc3Block = IDL.Record({ id: IDL.Nat, block: Value });
const Icrc3ArchiveResponse = IDL.Record({ log_length: IDL.Nat, blocks: IDL.Vec(Icrc3Block) });
const Icrc3LedgerResponse = IDL.Record({
  log_length: IDL.Nat, blocks: IDL.Vec(Icrc3Block),
  archived_blocks: IDL.Vec(IDL.Record({ args: Icrc3Req, callback: IDL.Func([Icrc3Req], [Icrc3ArchiveResponse], ["query"]) })),
});

const field = (m: [string, RawValue][], key: string): RawValue | undefined => {
  for (const e of m) if (e[0] === key) return e[1];
  return undefined;
};
const num = (v: RawValue | undefined): bigint | null => (v == null ? null : "Nat" in v ? v.Nat : "Nat64" in v ? v.Nat64 : "Int" in v ? v.Int : null);
const text = (v: RawValue | undefined): string | null => (v != null && "Text" in v ? v.Text : null);
const bytes = (v: RawValue | undefined): Uint8Array | null => (v != null && "Blob" in v ? (v.Blob instanceof Uint8Array ? v.Blob : Uint8Array.from(v.Blob)) : null);

/** An account in a value block: Array [Blob owner, Blob subaccount?]. */
function valueAccount(v: RawValue | undefined): string | null {
  if (v == null || !("Array" in v)) return null;
  const owner = bytes(v.Array[0]);
  if (!owner) return null;
  return accountText(PrincipalClass.fromUint8Array(owner), bytes(v.Array[1]));
}

const OPS: Record<string, Tx["kind"]> = { mint: "mint", burn: "burn", xfer: "transfer", transfer: "transfer", approve: "approve", "1mint": "mint", "1burn": "burn", "1xfer": "transfer", "2xfer": "transfer", "2approve": "approve" };

/**
 * A generic block reduced to a Tx. The operation is tx.op, else the ICRC-3 btype. The fee is the one the caller
 * named (tx.fee), else the effective fee the ledger recorded on the block (fee).
 */
export function valueToTx(block: RawValue): Tx {
  if (!("Map" in block)) throw new BlockDecodeError("block is not a map");
  const b = block.Map;
  const txv = field(b, "tx");
  const tx = txv != null && "Map" in txv ? txv.Map : [];
  const ts = Number((num(field(b, "ts")) ?? num(field(tx, "ts")) ?? 0n) / NS);
  const btype = text(field(b, "btype"));
  const out: Tx = { kind: "other", ts, from: null, to: null, amount: 0n, fee: null };
  if (btype === "107feecol") {
    out.setFeeCol = valueAccount(field(tx, "fee_collector")) ?? valueAccount(field(b, "fee_collector"));
    return out;
  }
  const kind = OPS[text(field(tx, "op")) ?? btype ?? ""];
  if (!kind) return out;
  out.kind = kind;
  out.fee = num(field(tx, "fee")) ?? num(field(b, "fee"));
  out.from = valueAccount(field(tx, "from"));
  out.to = valueAccount(field(tx, "to"));
  if (kind !== "approve") out.amount = num(field(tx, "amt")) ?? 0n;
  if ((kind === "mint" && out.to == null) || ((kind === "burn" || kind === "approve") && out.from == null) || (kind === "transfer" && (out.from == null || out.to == null))) {
    throw new BlockDecodeError(`${kind} block without its account`);
  }
  const col = field(b, "fee_col");
  if (col != null) out.feeCol = valueAccount(col);
  const ref = num(field(b, "fee_col_block"));
  if (ref != null) out.feeColBlock = Number(ref);
  return out;
}

function mapValues(raw: RawValue[], meter: CallMeter): Tx[] {
  const t0 = Date.now();
  const out = raw.map(valueToTx);
  meter.decodeMs += Date.now() - t0;
  return out;
}

/** icrc3 answers carry block ids: anything but a contiguous run starting at `start` is a gap, not a short page. */
function icrc3Txs(canister: string, start: number, blocks: { id: bigint; block: RawValue }[], meter: CallMeter): Tx[] {
  for (let i = 0; i < blocks.length; i++) {
    const id = Number(blocks[i]!.id);
    if (id !== start + i) throw new BlockGapError(canister, start + i, `asked for block ${start + i}, the canister answered with block ${id}`);
  }
  return mapValues(blocks.map((b) => b.block), meter);
}

// ---- ICP ledger ---------------------------------------------------------------------------------------------

const Tokens = IDL.Record({ e8s: IDL.Nat64 });
const AccountId = IDL.Vec(IDL.Nat8);
const IcpOperation = IDL.Variant({
  Mint: IDL.Record({ to: AccountId, amount: Tokens }),
  Burn: IDL.Record({ from: AccountId, amount: Tokens }),
  Transfer: IDL.Record({ from: AccountId, to: AccountId, amount: Tokens, fee: Tokens }),
  Approve: IDL.Record({ from: AccountId, fee: Tokens }),
});
const IcpBlock = IDL.Record({ transaction: IDL.Record({ operation: IDL.Opt(IcpOperation) }), timestamp: IDL.Record({ timestamp_nanos: IDL.Nat64 }) });
const IcpRange = IDL.Record({ start: IDL.Nat64, length: IDL.Nat64 });
const IcpArchiveResponse = IDL.Variant({
  Ok: IDL.Record({ blocks: IDL.Vec(IcpBlock) }),
  Err: IDL.Variant({ BadFirstBlockIndex: IDL.Record({ requested_index: IDL.Nat64, first_valid_index: IDL.Nat64 }), Other: IDL.Record({ error_code: IDL.Nat64, error_message: IDL.Text }) }),
});
const IcpLedgerResponse = IDL.Record({
  chain_length: IDL.Nat64, first_block_index: IDL.Nat64, blocks: IDL.Vec(IcpBlock),
  archived_blocks: IDL.Vec(IDL.Record({ start: IDL.Nat64, length: IDL.Nat64, callback: IDL.Func([IcpRange], [IcpArchiveResponse], ["query"]) })),
});
const icpRangeArg = (start: number, length: number) => IDL.encode([IcpRange], [{ start: BigInt(start), length: BigInt(length) }]);

type Bytes = Uint8Array | number[];
interface RawIcpBlock {
  transaction: { operation: [] | [{ Mint: { to: Bytes; amount: { e8s: bigint } } } | { Burn: { from: Bytes; amount: { e8s: bigint } } } | { Transfer: { from: Bytes; to: Bytes; amount: { e8s: bigint }; fee: { e8s: bigint } } } | { Approve: { from: Bytes; fee: { e8s: bigint } } }] };
  timestamp: { timestamp_nanos: bigint };
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
/** Account identifier as lowercase hex: the account key of the ICP index. */
export function accountIdHex(b: Bytes): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += HEX[b[i]!];
  return out;
}

/** ICP rules match ICRC-1: transfer debits amount + fee, approve debits the fee, mint and burn carry none. No fee collector exists. */
export function icpToTx(b: RawIcpBlock): Tx {
  const ts = Number(b.timestamp.timestamp_nanos / NS);
  const op = b.transaction.operation[0];
  if (op == null) return { kind: "other", ts, from: null, to: null, amount: 0n, fee: null };
  if ("Transfer" in op) return { kind: "transfer", ts, from: accountIdHex(op.Transfer.from), to: accountIdHex(op.Transfer.to), amount: op.Transfer.amount.e8s, fee: op.Transfer.fee.e8s };
  if ("Mint" in op) return { kind: "mint", ts, from: null, to: accountIdHex(op.Mint.to), amount: op.Mint.amount.e8s, fee: null };
  if ("Burn" in op) return { kind: "burn", ts, from: accountIdHex(op.Burn.from), to: null, amount: op.Burn.amount.e8s, fee: null };
  if ("Approve" in op) return { kind: "approve", ts, from: accountIdHex(op.Approve.from), to: null, amount: 0n, fee: op.Approve.fee.e8s };
  return { kind: "other", ts, from: null, to: null, amount: 0n, fee: null };
}

function mapIcp(raw: RawIcpBlock[], meter: CallMeter): Tx[] {
  const t0 = Date.now();
  const out = raw.map(icpToTx);
  meter.decodeMs += Date.now() - t0;
  return out;
}

// ---- pages ------------------------------------------------------------------------------------------------------

const LEDGER_METHOD: Record<BlockSource, string> = { blocks: "get_blocks", tx: "get_transactions", icrc3: "icrc3_get_blocks", icp: "query_blocks" };
export const ARCHIVE_METHOD: Record<BlockSource, string> = { blocks: "get_blocks", tx: "get_transactions", icrc3: "icrc3_get_blocks", icp: "get_blocks" };

/** One block query on the ledger itself. With length 0 it is a cheap way to read the tip. */
export async function ledgerPage(host: string, ledger: string, source: BlockSource, start: number, length: number, meter: CallMeter): Promise<LedgerPage> {
  const method = LEDGER_METHOD[source];
  if (source === "tx") {
    const r = decode<RawLedgerResponse>([LedgerResponse], await rawQuery(host, ledger, method, rangeArg(start, length), meter), meter);
    const firstIndex = Number(r.first_index);
    return {
      tip: Number(r.log_length), firstIndex, inlineStart: Math.max(start, firstIndex), txs: mapTxs(r.transactions, meter),
      archived: r.archived_transactions.map((a) => ({ canister: a.callback[0].toText(), method: a.callback[1], start: Number(a.start), length: Number(a.length) })),
    };
  }
  if (source === "blocks") {
    const r = decode<{ first_index: bigint; chain_length: bigint; blocks: RawValue[]; archived_blocks: { start: bigint; length: bigint; callback: [Principal, string] }[] }>(
      [BlocksLedgerResponse], await rawQuery(host, ledger, method, rangeArg(start, length), meter), meter);
    const firstIndex = Number(r.first_index);
    return {
      tip: Number(r.chain_length), firstIndex, inlineStart: Math.max(start, firstIndex), txs: mapValues(r.blocks, meter),
      archived: r.archived_blocks.map((a) => ({ canister: a.callback[0].toText(), method: a.callback[1], start: Number(a.start), length: Number(a.length) })),
    };
  }
  if (source === "icrc3") {
    const r = decode<{ log_length: bigint; blocks: { id: bigint; block: RawValue }[]; archived_blocks: { args: { start: bigint; length: bigint }[]; callback: [Principal, string] }[] }>(
      [Icrc3LedgerResponse], await rawQuery(host, ledger, method, IDL.encode([Icrc3Req], [[{ start: BigInt(start), length: BigInt(length) }]]), meter), meter);
    const inlineStart = r.blocks.length ? Number(r.blocks[0]!.id) : start;
    return {
      tip: Number(r.log_length), firstIndex: null, inlineStart, txs: icrc3Txs(ledger, inlineStart, r.blocks, meter),
      archived: r.archived_blocks.flatMap((a) => a.args.map((g) => ({ canister: a.callback[0].toText(), method: a.callback[1], start: Number(g.start), length: Number(g.length) }))),
    };
  }
  const r = decode<{ chain_length: bigint; first_block_index: bigint; blocks: RawIcpBlock[]; archived_blocks: { start: bigint; length: bigint; callback: [Principal, string] }[] }>(
    [IcpLedgerResponse], await rawQuery(host, ledger, method, icpRangeArg(start, length), meter), meter);
  const firstIndex = Number(r.first_block_index);
  return {
    tip: Number(r.chain_length), firstIndex, inlineStart: Math.max(start, firstIndex), txs: mapIcp(r.blocks, meter),
    archived: r.archived_blocks.map((a) => ({ canister: a.callback[0].toText(), method: a.callback[1], start: Number(a.start), length: Number(a.length) })),
  };
}

/**
 * Blocks straight from an archive canister. Returns fewer than asked when the archive caps its responses.
 * An archive that does not hold `start` answers with nothing (or, icrc3 and icp, says so): see confirmAligned.
 */
export async function archivePage(host: string, canister: string, source: BlockSource, start: number, length: number, meter: CallMeter, method = ARCHIVE_METHOD[source]): Promise<Tx[]> {
  if (source === "tx") return mapTxs(decode<{ transactions: RawTx[] }>([ArchiveResponse], await rawQuery(host, canister, method, rangeArg(start, length), meter), meter).transactions, meter);
  if (source === "blocks") return mapValues(decode<{ blocks: RawValue[] }>([BlocksArchiveResponse], await rawQuery(host, canister, method, rangeArg(start, length), meter), meter).blocks, meter);
  if (source === "icrc3") {
    const r = decode<{ blocks: { id: bigint; block: RawValue }[] }>([Icrc3ArchiveResponse], await rawQuery(host, canister, method, IDL.encode([Icrc3Req], [[{ start: BigInt(start), length: BigInt(length) }]]), meter), meter);
    return icrc3Txs(canister, start, r.blocks, meter);
  }
  const r = decode<{ Ok: { blocks: RawIcpBlock[] } } | { Err: { BadFirstBlockIndex: { requested_index: bigint; first_valid_index: bigint } } | { Other: { error_code: bigint; error_message: string } } }>(
    [IcpArchiveResponse], await rawQuery(host, canister, method, icpRangeArg(start, length), meter), meter);
  if ("Err" in r) {
    if ("BadFirstBlockIndex" in r.Err) throw new BlockGapError(canister, start, `first valid index is ${r.Err.BadFirstBlockIndex.first_valid_index}`);
    throw new IcRejectError(canister, method, null, r.Err.Other.error_message);
  }
  return mapIcp(r.Ok.blocks, meter);
}

/**
 * DFINITY archives answer a range with its intersection with what they hold, and get_blocks / get_transactions
 * blocks carry no index. So a short, non-empty answer is either a response cap (fine) or an archive whose first
 * block is above `start` (every block would be applied at the wrong index). One extra call tells them apart: an
 * archive that really holds `start` returns exactly one block for (start, 1). Seen live: CLOWN's archive starts at 2001.
 */
export async function confirmAligned(host: string, canister: string, source: BlockSource, start: number, meter: CallMeter, method = ARCHIVE_METHOD[source]): Promise<void> {
  if (source === "icrc3" || source === "icp") return; // those sources report misalignment themselves
  const one = await archivePage(host, canister, source, start, 1, meter, method);
  if (one.length !== 1) throw new BlockGapError(canister, start, "the archive answers the range with later blocks only");
}

/**
 * Contiguous blocks from `start` through the ledger, following archive callbacks when part of the
 * range has been archived. Stops at the first piece that comes back short, so the result is always
 * gap free: txs[i] is block start + i.
 */
export async function ledgerRange(host: string, ledger: string, source: BlockSource, start: number, length: number, meter: CallMeter, first?: LedgerPage): Promise<{ tip: number; txs: Tx[] }> {
  const page = first ?? (await ledgerPage(host, ledger, source, start, length, meter));
  const txs: Tx[] = [];
  let next = start;
  for (const a of [...page.archived].sort((x, y) => x.start - y.start)) {
    if (a.start !== next) return { tip: page.tip, txs };
    const got = await archivePage(host, a.canister, source, a.start, a.length, meter, a.method);
    if (got.length && got.length < a.length) await confirmAligned(host, a.canister, source, a.start, meter, a.method);
    for (const t of got) txs.push(t);
    next += got.length;
    if (got.length < a.length) return { tip: page.tip, txs };
  }
  if (page.txs.length && page.inlineStart === next) for (const t of page.txs) txs.push(t);
  return { tip: page.tip, txs };
}

export interface ArchiveRange { canister: string; start: number; end: number }

/**
 * Archive canisters and the block ranges they hold. Asking the ledger for the whole chain returns one
 * archived entry per archive (both get_blocks and query_blocks answer this way, measured on ckBTC and ICP),
 * which works for every source. The legacy `archives` endpoint is the fallback. Empty when neither helps.
 */
export async function ledgerArchives(host: string, ledger: string, source: BlockSource, tip: number, meter: CallMeter): Promise<ArchiveRange[]> {
  if (source === "icp") {
    const page = await ledgerPage(host, ledger, source, 0, Math.max(tip, 1), meter);
    return page.archived.filter((a) => a.method === ARCHIVE_METHOD.icp).map((a) => ({ canister: a.canister, start: a.start, end: a.start + a.length - 1 })).sort((x, y) => x.start - y.start);
  }
  if (source === "icrc3") {
    try {
      const Arg = IDL.Record({ from: IDL.Opt(IDL.Principal) });
      const Res = IDL.Vec(IDL.Record({ canister_id: IDL.Principal, start: IDL.Nat, end: IDL.Nat }));
      const r = decode<{ canister_id: Principal; start: bigint; end: bigint }[]>([Res], await rawQuery(host, ledger, "icrc3_get_archives", IDL.encode([Arg], [{ from: [] }]), meter), meter);
      if (r.length) return r.map((a) => ({ canister: a.canister_id.toText(), start: Number(a.start), end: Number(a.end) })).sort((x, y) => x.start - y.start);
    } catch { /* fall through to the legacy endpoint */ }
  }
  try {
    const raw = await rawQuery(host, ledger, "archives", IDL.encode([], []), meter);
    const r = decode<{ canister_id: Principal; block_range_start: bigint; block_range_end: bigint }[]>([ArchivesResponse], raw, meter);
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
