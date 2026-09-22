// Account lookups. On demand, read-only, nothing is stored.
//   ICP balance:        ICP ledger account_balance (query)
//   ICP transactions:   ICP index canister get_account_identifier_transactions (query, newest first)
//   Token balances:     icrc1_balance_of on every priced ledger in the registry (principals only)
//   Token transactions: the token's index-ng canister get_account_transactions, when the registry knows the index
// An account identifier is a one-way hash of (principal, subaccount), so a bare identifier can only
// show its ICP side. Neurons are private on the IC and are never shown.
import { accountHoldings } from "../indexer/queries";
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import type { Env } from "../env";
import { accountIdHex, classifyInput, encodeIcrcAccount, fromHex, type AccountInput } from "../lib/account";
import { now } from "../lib/format";
import { ICP_INDEX, ICP_LEDGER, balanceOf, getAgent, isCanisterId, pool } from "../lib/ic";

// ---- candid (minimal, verified against the live candid metadata on 2026-09-21) -------------------------------

const icpLedgerIdl: IDL.InterfaceFactory = () =>
  IDL.Service({ account_balance: IDL.Func([IDL.Record({ account: IDL.Vec(IDL.Nat8) })], [IDL.Record({ e8s: IDL.Nat64 })], ["query"]) });

const icpIndexIdl: IDL.InterfaceFactory = () => {
  const Tokens = IDL.Record({ e8s: IDL.Nat64 });
  const TimeStamp = IDL.Record({ timestamp_nanos: IDL.Nat64 });
  const Operation = IDL.Variant({
    Approve: IDL.Record({ fee: Tokens, from: IDL.Text, allowance: Tokens, spender: IDL.Text }),
    Burn: IDL.Record({ from: IDL.Text, amount: Tokens, spender: IDL.Opt(IDL.Text) }),
    Mint: IDL.Record({ to: IDL.Text, amount: Tokens }),
    Transfer: IDL.Record({ to: IDL.Text, fee: Tokens, from: IDL.Text, amount: Tokens, spender: IDL.Opt(IDL.Text) }),
  });
  const Transaction = IDL.Record({ memo: IDL.Nat64, icrc1_memo: IDL.Opt(IDL.Vec(IDL.Nat8)), operation: Operation, created_at_time: IDL.Opt(TimeStamp), timestamp: IDL.Opt(TimeStamp) });
  const Ok = IDL.Record({ balance: IDL.Nat64, transactions: IDL.Vec(IDL.Record({ id: IDL.Nat64, transaction: Transaction })), oldest_tx_id: IDL.Opt(IDL.Nat64) });
  return IDL.Service({
    get_account_identifier_transactions: IDL.Func(
      [IDL.Record({ max_results: IDL.Nat64, start: IDL.Opt(IDL.Nat64), account_identifier: IDL.Text })],
      [IDL.Variant({ Ok, Err: IDL.Record({ message: IDL.Text }) })],
      ["query"],
    ),
  });
};

const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });

const icrcLedgerIdl: IDL.InterfaceFactory = () => IDL.Service({ icrc1_balance_of: IDL.Func([Account], [IDL.Nat], ["query"]) });

const icrcIndexIdl: IDL.InterfaceFactory = () => {
  const Transfer = IDL.Record({ to: Account, fee: IDL.Opt(IDL.Nat), from: Account, amount: IDL.Nat, spender: IDL.Opt(Account) });
  const Mint = IDL.Record({ to: Account, amount: IDL.Nat });
  const Burn = IDL.Record({ from: Account, amount: IDL.Nat, spender: IDL.Opt(Account) });
  const Approve = IDL.Record({ fee: IDL.Opt(IDL.Nat), from: Account, amount: IDL.Nat, spender: Account });
  const Transaction = IDL.Record({ kind: IDL.Text, timestamp: IDL.Nat64, burn: IDL.Opt(Burn), mint: IDL.Opt(Mint), approve: IDL.Opt(Approve), transfer: IDL.Opt(Transfer) });
  const Ok = IDL.Record({ balance: IDL.Nat, transactions: IDL.Vec(IDL.Record({ id: IDL.Nat, transaction: Transaction })), oldest_tx_id: IDL.Opt(IDL.Nat) });
  return IDL.Service({
    get_account_transactions: IDL.Func(
      [IDL.Record({ account: Account, start: IDL.Opt(IDL.Nat), max_results: IDL.Nat })],
      [IDL.Variant({ Ok, Err: IDL.Record({ message: IDL.Text }) })],
      ["query"],
    ),
  });
};

// ---- view model ----------------------------------------------------------------------------------------------------

export type TxKind = "transfer" | "mint" | "burn" | "approve";
export type TxDirection = "in" | "out" | "self" | "none";

export interface AccountTx {
  /** Block index on the ledger, as text (nat64 or nat). */
  id: string;
  kind: TxKind;
  direction: TxDirection;
  /** The other side: an account identifier (ICP) or an ICRC-1 textual account (tokens). Null for mint and burn. */
  counterparty: string | null;
  /** Registry label when the counterparty is the default account of a watched canister. */
  counterparty_label: string | null;
  /** Token units (not base units). Display only. */
  amount: number | null;
  fee: number | null;
  ts: number | null;
  memo: string | null;
}

export interface TxPage {
  token_id: string; symbol: string; txs: AccountTx[];
  /** Pass as `start` to load the next (older) page. Null when the oldest transaction is on this page. */
  next_start: string | null;
  source: string; fetched_at: number; error: string | null;
}

export interface AccountHolding { token_id: string; symbol: string; name: string; logo: string | null; balance: number; price_usd: number | null; usd: number | null; has_index: boolean }

export interface AccountView {
  input: string;
  kind: "account_id" | "principal" | "icrc_account";
  /** ICP account identifier, 64 hex. Always present. */
  account_id: string;
  principal: string | null;
  /** Hex, only when not the default subaccount. */
  subaccount: string | null;
  /** ICRC-1 textual form when the principal is known. */
  icrc_account: string | null;
  /** Set when the principal (or, for a bare identifier, the matching default account) is a canister in the registry. */
  canister: { id: string; label: string; token_id: string | null } | null;
  is_canister: boolean;
  icp: { balance: number | null; price_usd: number | null; usd: number | null; source: string; fetched_at: number; error: string | null };
  /** Null when the principal is unknown (bare account identifier), so token ledgers cannot be asked. */
  holdings: AccountHolding[] | null;
  holdings_checked: number;
  /** Ledgers that did not answer before the page deadline. Never silently dropped. */
  holdings_unchecked: number;
  holdings_source: string;
  /** Fragment URL that finishes the live balance wave, set when the first paint skipped it. */
  live_url: string | null;
  total_usd: number | null;
  icp_txs: TxPage;
  /** Present when a token was requested via opts.token and its index canister is known. */
  token_txs: TxPage | null;
  fetched_at: number;
}

export interface LoadAccountOpts {
  /** ICP transaction paging: id of the last transaction already seen. */
  start?: string | null;
  /** Ledger id of a token whose transactions should be loaded as well (principals and ICRC accounts only). */
  token?: string | null;
  /** Token transaction paging. */
  tokenStart?: string | null;
  pageSize?: number;
  /** Skip the live icrc1_balance_of wave (index-backed holdings only). The page uses this for the first paint. */
  skipLive?: boolean;
  /** Skip transaction reads (the holdings fragment uses this). */
  skipTxs?: boolean;
}

const e8 = (v: bigint | undefined | null) => (v == null ? null : Number(v) / 1e8);
const units = (v: bigint | undefined | null, decimals: number) => (v == null ? null : Number(v) / 10 ** decimals);
const natText = (s: string | null | undefined): bigint | null => (s && /^\d{1,30}$/.test(s) ? BigInt(s) : null);
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").slice(0, 200);

// ---- reads -----------------------------------------------------------------------------------------------------------

/** ICP balance of an account identifier, straight from the ledger. */
export async function icpBalance(host: string, accountId: string): Promise<number> {
  const bytes = fromHex(accountId);
  if (!bytes || bytes.length !== 32) throw new Error("not an account identifier");
  const a = Actor.createActor(icpLedgerIdl, { agent: await getAgent(host), canisterId: ICP_LEDGER });
  const r = (await a.account_balance!({ account: bytes })) as { e8s: bigint };
  return Number(r.e8s) / 1e8;
}

type IcpOp =
  | { Transfer: { to: string; from: string; fee: { e8s: bigint }; amount: { e8s: bigint }; spender: [] | [string] } }
  | { Mint: { to: string; amount: { e8s: bigint } } }
  | { Burn: { from: string; amount: { e8s: bigint }; spender: [] | [string] } }
  | { Approve: { from: string; spender: string; fee: { e8s: bigint }; allowance: { e8s: bigint } } };
interface IcpTxRaw {
  id: bigint;
  transaction: { memo: bigint; icrc1_memo: [] | [Uint8Array | number[]]; operation: IcpOp; created_at_time: [] | [{ timestamp_nanos: bigint }]; timestamp: [] | [{ timestamp_nanos: bigint }] };
}

/** Pure: one ICP index transaction as seen from `me` (an account identifier). */
export function icpTxView(me: string, raw: IcpTxRaw): AccountTx {
  const t = raw.transaction;
  const nanos = t.timestamp[0]?.timestamp_nanos ?? t.created_at_time[0]?.timestamp_nanos;
  const base = { id: String(raw.id), ts: nanos != null ? Number(nanos / 1_000_000_000n) : null, memo: t.memo ? String(t.memo) : null, counterparty_label: null };
  const op = t.operation;
  if ("Transfer" in op) {
    const { from, to, amount, fee } = op.Transfer;
    const direction: TxDirection = from === me && to === me ? "self" : from === me ? "out" : to === me ? "in" : "none";
    return { ...base, kind: "transfer", direction, counterparty: direction === "out" ? to : direction === "in" ? from : direction === "self" ? me : to, amount: e8(amount.e8s), fee: e8(fee.e8s) };
  }
  if ("Mint" in op) return { ...base, kind: "mint", direction: "in", counterparty: null, amount: e8(op.Mint.amount.e8s), fee: null };
  if ("Burn" in op) return { ...base, kind: "burn", direction: "out", counterparty: null, amount: e8(op.Burn.amount.e8s), fee: null };
  const ap = op.Approve;
  return { ...base, kind: "approve", direction: "none", counterparty: ap.from === me ? ap.spender : ap.from, amount: e8(ap.allowance.e8s), fee: e8(ap.fee.e8s) };
}

/** Recent ICP transactions of an account identifier, newest first. `start` is the last id already seen. */
export async function icpTransactions(host: string, accountId: string, start: bigint | null, max = 25): Promise<{ txs: AccountTx[]; balance: number; nextStart: string | null }> {
  const a = Actor.createActor(icpIndexIdl, { agent: await getAgent(host), canisterId: ICP_INDEX });
  const r = (await a.get_account_identifier_transactions!({ max_results: BigInt(max), start: start != null ? [start] : [], account_identifier: accountId })) as
    | { Ok: { balance: bigint; transactions: IcpTxRaw[]; oldest_tx_id: [] | [bigint] } }
    | { Err: { message: string } };
  if ("Err" in r) throw new Error(r.Err.message);
  const txs = r.Ok.transactions.map((t) => icpTxView(accountId, t));
  const last = r.Ok.transactions[r.Ok.transactions.length - 1]?.id;
  const oldest = r.Ok.oldest_tx_id[0];
  return { txs, balance: Number(r.Ok.balance) / 1e8, nextStart: last != null && oldest != null && last > oldest ? String(last) : null };
}

interface IcrcAccountRaw { owner: Principal; subaccount: [] | [Uint8Array | number[]] }
interface IcrcTxRaw {
  id: bigint;
  transaction: {
    kind: string; timestamp: bigint;
    transfer: [] | [{ to: IcrcAccountRaw; from: IcrcAccountRaw; amount: bigint; fee: [] | [bigint]; spender: [] | [IcrcAccountRaw] }];
    mint: [] | [{ to: IcrcAccountRaw; amount: bigint }];
    burn: [] | [{ from: IcrcAccountRaw; amount: bigint; spender: [] | [IcrcAccountRaw] }];
    approve: [] | [{ from: IcrcAccountRaw; spender: IcrcAccountRaw; amount: bigint; fee: [] | [bigint] }];
  };
}

const accText = (a: IcrcAccountRaw): string => {
  const sub = a.subaccount[0];
  return encodeIcrcAccount(a.owner.toText(), sub ? (sub instanceof Uint8Array ? sub : new Uint8Array(sub)) : null);
};

/** Pure: one index-ng transaction as seen from `me` (ICRC-1 textual account). */
export function icrcTxView(me: string, raw: IcrcTxRaw, decimals: number): AccountTx {
  const t = raw.transaction;
  const base = { id: String(raw.id), ts: Number(t.timestamp / 1_000_000_000n), memo: null, counterparty_label: null };
  const tr = t.transfer[0], mint = t.mint[0], burn = t.burn[0], ap = t.approve[0];
  if (tr) {
    const from = accText(tr.from), to = accText(tr.to);
    const direction: TxDirection = from === me && to === me ? "self" : from === me ? "out" : to === me ? "in" : "none";
    return { ...base, kind: "transfer", direction, counterparty: direction === "in" ? from : to, amount: units(tr.amount, decimals), fee: units(tr.fee[0], decimals) };
  }
  if (mint) return { ...base, kind: "mint", direction: "in", counterparty: null, amount: units(mint.amount, decimals), fee: null };
  if (burn) return { ...base, kind: "burn", direction: "out", counterparty: null, amount: units(burn.amount, decimals), fee: null };
  if (ap) {
    const from = accText(ap.from);
    return { ...base, kind: "approve", direction: "none", counterparty: from === me ? accText(ap.spender) : from, amount: units(ap.amount, decimals), fee: units(ap.fee[0], decimals) };
  }
  return { ...base, kind: "transfer", direction: "none", counterparty: null, amount: null, fee: null };
}

/** Recent transactions of an ICRC account from a token's index-ng canister, newest first. */
export async function icrcTransactions(host: string, indexId: string, owner: string, subaccount: Uint8Array | null, decimals: number, start: bigint | null, max = 25): Promise<{ txs: AccountTx[]; nextStart: string | null }> {
  const a = Actor.createActor(icrcIndexIdl, { agent: await getAgent(host), canisterId: indexId });
  const r = (await a.get_account_transactions!({ account: { owner: Principal.fromText(owner), subaccount: subaccount ? [subaccount] : [] }, start: start != null ? [start] : [], max_results: BigInt(max) })) as
    | { Ok: { transactions: IcrcTxRaw[]; oldest_tx_id: [] | [bigint] } }
    | { Err: { message: string } };
  if ("Err" in r) throw new Error(r.Err.message);
  const me = encodeIcrcAccount(owner, subaccount);
  const last = r.Ok.transactions[r.Ok.transactions.length - 1]?.id;
  const oldest = r.Ok.oldest_tx_id[0];
  return { txs: r.Ok.transactions.map((t) => icrcTxView(me, t, decimals)), nextStart: last != null && oldest != null && last > oldest ? String(last) : null };
}

async function icrcBalance(host: string, ledgerId: string, owner: string, subaccount: Uint8Array | null): Promise<bigint> {
  if (!subaccount) return balanceOf(host, ledgerId, owner);
  const a = Actor.createActor(icrcLedgerIdl, { agent: await getAgent(host), canisterId: ledgerId });
  return (await a.icrc1_balance_of!({ owner: Principal.fromText(owner), subaccount: [subaccount] })) as bigint;
}

// ---- loader ------------------------------------------------------------------------------------------------------------

interface PricedToken { id: string; symbol: string; name: string; decimals: number; logo: string | null; price_usd: number | null; index_id: string | null }

/** Where an account-like search term should go. Null when the term is not an account. */
export function accountHref(raw: string): string | null {
  const c = classifyInput(raw);
  if (c.kind === "account_id") return `/account/${c.accountId}`;
  if (c.kind === "principal") return `/account/${c.principal}`;
  if (c.kind === "icrc_account") return `/account/${encodeIcrcAccount(c.principal, c.subaccount)}`;
  return null;
}

/**
 * Everything the account page shows, read live. Returns null when `id` is neither a valid account
 * identifier (CRC32 checked), a principal, nor an ICRC-1 textual account.
 */
const LIVE_DEADLINE_MS = 1200;
type IndexedHolding = Awaited<ReturnType<typeof accountHoldings>>[number];

/**
 * icrc1_balance_of across many ledgers with bounded concurrency and one deadline for the whole wave.
 * Returns a map of ledger to balance (null when the ledger errored); ledgers missing from the map did
 * not answer before the deadline.
 */
async function liveBalances(host: string, rows: PricedToken[], principal: string, subaccount: Uint8Array | null, deadlineMs: number): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  const deadline = Date.now() + deadlineMs;
  let next = 0;
  const worker = async () => {
    while (next < rows.length && Date.now() < deadline) {
      const t = rows[next++]!;
      try {
        const v = await Promise.race([icrcBalance(host, t.id, principal, subaccount), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), Math.max(50, deadline - Date.now())))]);
        out.set(t.id, v);
      } catch {
        if (Date.now() < deadline) out.set(t.id, null);
      }
    }
  };
  await Promise.race([Promise.all(Array.from({ length: 16 }, worker)), new Promise<void>((r) => setTimeout(r, deadlineMs + 50))]);
  return out;
}

export async function loadAccount(env: Env, id: string, opts: LoadAccountOpts = {}): Promise<AccountView | null> {
  const input: AccountInput = classifyInput(id);
  if (input.kind === "other" || input.kind === "hex64") return null;
  const ts = now();
  const host = env.IC_HOST;
  const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 100);
  const accountId = input.accountId;
  const principal = input.kind === "account_id" ? null : input.principal;
  const subHex = input.kind === "icrc_account" ? input.subaccount : null;
  const subaccount = subHex ? fromHex(subHex) : null;

  // The two ICP reads do not depend on anything in the database: start them first.
  const balP = icpBalance(host, accountId).then((v) => ({ v, error: null as string | null }), (e) => ({ v: null as number | null, error: errText(e) }));
  const txsP = opts.skipTxs ? Promise.resolve({ v: null, error: null as string | null }) : icpTransactions(host, accountId, natText(opts.start), pageSize).then((v) => ({ v, error: null as string | null }), (e) => ({ v: null, error: errText(e) }));

  // Registry context: prices, priced tokens, and the labels of watched canisters.
  const [icpPrice, tokenRows, canisterRows] = await Promise.all([
    env.DB.prepare("SELECT price_usd FROM market WHERE token_id = ?").bind(ICP_LEDGER).first<{ price_usd: number | null }>(),
    principal
      ? env.DB.prepare(`SELECT t.id, t.symbol, t.name, t.decimals, t.logo, m.price_usd,
            (SELECT c.id FROM canisters c WHERE c.token_id = t.id AND c.role = 'index' LIMIT 1) index_id
          FROM tokens t JOIN market m ON m.token_id = t.id
          WHERE t.hidden = 0 AND t.id != ?1 AND (t.id = ?2 OR (m.price_usd IS NOT NULL AND COALESCE(m.tvl_usd, 0) >= 1000
            AND NOT EXISTS (SELECT 1 FROM canisters c WHERE c.id = t.id AND c.health IN ('frozen', 'gone'))))
          ORDER BY (m.mcap_usd IS NULL), m.mcap_usd DESC LIMIT 80`).bind(ICP_LEDGER, opts.token ?? "").all<PricedToken>().then((r) => r.results)
      : Promise.resolve([] as PricedToken[]),
    env.DB.prepare("SELECT id, label, token_id FROM canisters").all<{ id: string; label: string; token_id: string | null }>().then((r) => r.results),
  ]);

  // Default ICP accounts of watched canisters, so counterparties like "OpenChat governance" read as names.
  const known = new Map<string, { id: string; label: string; token_id: string | null }>();
  for (const c of canisterRows) {
    try { known.set(accountIdHex(c.id), c); } catch { /* malformed id in the registry */ }
  }
  const canister = principal ? (subaccount ? null : (canisterRows.find((c) => c.id === principal) ?? null)) : (known.get(accountId) ?? null);

  const wantToken = principal && opts.token ? (tokenRows.find((t) => t.id === opts.token) ?? null) : null;

  // Balances from our own block index wherever a ledger has reconciled, so only the remaining ledgers
  // need a live query. The live wave gets a hard deadline: ledgers that do not answer in time are
  // reported as not checked rather than holding the page.
  const indexed = principal && !subaccount ? await accountHoldings(env.DB, principal, { includeEmpty: true }).catch(() => [] as IndexedHolding[]) : [];
  const fromIndex = new Map<string, IndexedHolding>();
  for (const h of indexed) if (h.trusted && h.account === principal) fromIndex.set(h.ledger, h);
  const liveRows = tokenRows.filter((t) => !fromIndex.has(t.id));
  const [bal, txs, held, tokenTxs] = await Promise.all([
    balP,
    txsP,
    principal && !opts.skipLive ? liveBalances(host, liveRows, principal, subaccount, opts.skipTxs ? 6000 : LIVE_DEADLINE_MS) : Promise.resolve(null),
    wantToken?.index_id && !opts.skipTxs
      ? icrcTransactions(host, wantToken.index_id, principal!, subaccount, wantToken.decimals, natText(opts.tokenStart), pageSize).then((v) => ({ v, error: null as string | null }), (e) => ({ v: null, error: errText(e) }))
      : Promise.resolve(null),
  ]);

  const label = (tx: AccountTx): AccountTx => {
    if (!tx.counterparty) return tx;
    const hit = known.get(tx.counterparty) ?? canisterRows.find((c) => c.id === tx.counterparty);
    return hit ? { ...tx, counterparty_label: hit.label } : tx;
  };

  let holdings: AccountHolding[] | null = null;
  let unchecked = 0;
  if (principal) {
    holdings = [];
    for (const t of tokenRows) {
      const ix = fromIndex.get(t.id);
      if (ix) {
        const balance = Number(BigInt(ix.balance_raw)) / 10 ** t.decimals;
        if (balance > 0) holdings.push({ token_id: t.id, symbol: t.symbol, name: t.name, logo: t.logo, balance, price_usd: t.price_usd, usd: t.price_usd != null ? balance * t.price_usd : null, has_index: !!t.index_id });
        continue;
      }
      const r = held?.get(t.id);
      if (r === undefined) { unchecked++; continue; }
      if (r == null || r === 0n) continue;
      const balance = Number(r) / 10 ** t.decimals;
      holdings.push({ token_id: t.id, symbol: t.symbol, name: t.name, logo: t.logo, balance, price_usd: t.price_usd, usd: t.price_usd != null ? balance * t.price_usd : null, has_index: !!t.index_id });
    }
    holdings.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  }

  // The index reports a balance too. Use it only when the ledger read failed.
  const icpBal = bal.v ?? txs.v?.balance ?? null;
  const price = icpPrice?.price_usd ?? null;
  const icpUsd = icpBal != null && price != null ? icpBal * price : null;
  const total = icpUsd == null && !holdings?.length ? null : (icpUsd ?? 0) + (holdings ?? []).reduce((s, h) => s + (h.usd ?? 0), 0);

  return {
    input: id.trim(), kind: input.kind, account_id: accountId, principal, subaccount: subHex,
    icrc_account: principal ? encodeIcrcAccount(principal, subaccount) : null,
    canister, is_canister: principal ? isCanisterId(principal) : !!canister,
    icp: { balance: icpBal, price_usd: price, usd: icpUsd, source: bal.v != null ? "ICP ledger account_balance" : "ICP index canister", fetched_at: ts, error: bal.v == null && icpBal == null ? bal.error : null },
    holdings, holdings_checked: tokenRows.length - unchecked, holdings_unchecked: unchecked,
    live_url: opts.skipLive && principal ? `/account/${encodeURIComponent(id.trim())}/holdings` : null,
    holdings_source: fromIndex.size ? `ICPWatch block index for ${fromIndex.size} reconciled ledgers, icrc1_balance_of on the rest` : "icrc1_balance_of on each ledger", total_usd: total,
    icp_txs: { token_id: ICP_LEDGER, symbol: "ICP", txs: (txs.v?.txs ?? []).map(label), next_start: txs.v?.nextStart ?? null, source: "ICP index canister", fetched_at: ts, error: txs.error },
    token_txs: wantToken
      ? {
          token_id: wantToken.id, symbol: wantToken.symbol, txs: (tokenTxs?.v?.txs ?? []).map(label), next_start: tokenTxs?.v?.nextStart ?? null,
          source: wantToken.index_id ? `${wantToken.symbol} index canister` : "no index canister known", fetched_at: ts,
          error: wantToken.index_id ? (tokenTxs?.error ?? null) : "ICPWatch does not know an index canister for this token yet.",
        }
      : null,
    fetched_at: ts,
  };
}
