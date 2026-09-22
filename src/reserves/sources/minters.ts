// First-party sources: what the minter canisters report about themselves. Queries only, anonymous,
// free. The minters are controlled by NNS root and hold the threshold keys, so their own view of
// UTXOs and balances is the most authoritative figure available without running a Bitcoin or
// Ethereum node. Everything here was checked against the live candid (candid:service metadata),
// /metrics and /dashboard of both minters on 2026-09-21.
//
// The dashboards are HTML meant for people. They are the only place where pending withdrawal
// amounts are published, so they are parsed, defensively: a parse failure yields null (unknown),
// never a made-up zero.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "../../lib/ic";
import { parseUnits } from "../reconcile";

export const CKBTC_MINTER = "mqygn-kiaaa-aaaar-qaadq-cai";
export const CKBTC_LEDGER = "mxzaz-hqaaa-aaaar-qaada-cai";
export const CKETH_MINTER = "sv3dd-oaaaa-aaaar-qacoa-cai";
export const CKETH_LEDGER = "ss2fx-dyaaa-aaaar-qacoq-cai";

// ---- http_request query -----------------------------------------------------------------------------------

const httpIdl: IDL.InterfaceFactory = () => {
  const Header = IDL.Tuple(IDL.Text, IDL.Text);
  return IDL.Service({
    http_request: IDL.Func(
      [IDL.Record({ url: IDL.Text, method: IDL.Text, body: IDL.Vec(IDL.Nat8), headers: IDL.Vec(Header) })],
      [IDL.Record({ body: IDL.Vec(IDL.Nat8), headers: IDL.Vec(Header), status_code: IDL.Nat16 })],
      ["query"],
    ),
  });
};

/** GET a canister's HTTP endpoint as a plain query through the API boundary node (no gateway, no certification needed for a query we cross-check anyway). */
export async function canisterHttpGet(host: string, canisterId: string, url: string): Promise<string> {
  const actor = Actor.createActor(httpIdl, { agent: await getAgent(host), canisterId });
  const res = (await actor.http_request!({ url, method: "GET", body: [], headers: [] })) as { body: Uint8Array | number[]; status_code: number };
  if (res.status_code !== 200) throw new Error(`${canisterId}${url} status ${res.status_code}`);
  return new TextDecoder().decode(res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body));
}

/** One Prometheus gauge or counter, optionally with an exact label set like `{status="pending"}`. */
export function metric(text: string, name: string, labels = ""): number | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${esc(name)}${esc(labels)}\\s+([0-9.eE+-]+)`, "m").exec(text);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

// ---- tiny HTML helpers --------------------------------------------------------------------------------------

const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** The HTML between the heading whose text matches `title` and the next h2/h3 heading. Null when the section is absent. */
export function section(html: string, title: RegExp): string | null {
  const re = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/g;
  let m: RegExpExecArray | null;
  let start = -1;
  while ((m = re.exec(html))) {
    if (start >= 0) return html.slice(start, m.index);
    if (title.test(strip(m[1]!))) start = re.lastIndex;
  }
  return start >= 0 ? html.slice(start) : null;
}

/** Rows of the first-level cells in a section, tags stripped. Header rows (th only) come back as empty arrays and are dropped. */
export function rows(sectionHtml: string): string[][] {
  const out: string[][] = [];
  for (const tr of sectionHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map(strip);
    if (cells.length) out.push(cells);
  }
  return out;
}

/** Value of a `<th>Label</th><td>value</td>` pair anywhere in the document. */
export function thValue(html: string, label: RegExp): string | null {
  const re = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) if (label.test(strip(m[1]!))) return strip(m[2]!);
  return null;
}

// ---- ckBTC ----------------------------------------------------------------------------------------------------

export interface CkbtcDashboard {
  mainAddress: string | null;
  /** "Total BTC managed": available UTXOs plus unconfirmed change. The minter's reserve figure. Satoshi. */
  managed: bigint | null;
  /** Requests accepted (ckBTC burned) that are not in a Bitcoin transaction yet. Their BTC is still inside `managed`. */
  pending: bigint | null;
  pendingCount: number | null;
  /** Requests inside submitted, unconfirmed transactions. Their inputs already left `managed`. */
  submitted: bigint | null;
  submittedCount: number | null;
  submittedTxids: string[];
  unconfirmedChange: bigint | null;
  quarantined: bigint | null;
  ignored: bigint | null;
  /** Sum of every UTXO in the account table ("Total available"), which still includes inputs of unconfirmed transactions. */
  totalKnownUtxos: bigint | null;
  minConfirmations: number | null;
  /** Offsets of the other account table pages. */
  pageStarts: number[];
  accounts: Map<string, bigint>;
}

const sumColumn = (table: string[][], col: number, decimals: number): bigint => table.reduce((acc, r) => acc + (parseUnits(r[col < 0 ? r.length + col : col] ?? "", decimals) ?? 0n), 0n);

/** Account table rows: the account cell spans its UTXO rows, so a row with five cells starts a new account. */
export function parseAccountUtxos(html: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const sec = section(html, /^Account to utxos/i);
  if (!sec) return out;
  let account: string | null = null;
  for (const r of rows(sec)) {
    if (r.length === 5) account = r[0]!;
    else if (r.length !== 4) continue; // pager and total row
    if (!account) continue;
    const v = parseUnits(r[r.length - 1]!, 8);
    if (v != null) out.set(account, (out.get(account) ?? 0n) + v);
  }
  return out;
}

export function parseCkbtcDashboard(html: string): CkbtcDashboard {
  const btc = (s: string | null) => (s == null ? null : parseUnits(s, 8));
  const pendingSec = section(html, /^Pending retrieve BTC requests/i);
  const pendingRows = pendingSec ? rows(pendingSec).filter((r) => r.length === 3) : null;
  const submittedSec = section(html, /^Submitted transactions/i);
  // Each request inside a submitted transaction is a nested table with an "Amount" row.
  const submittedAmounts = submittedSec ? [...submittedSec.matchAll(/<th[^>]*>\s*Amount\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => parseUnits(strip(m[1]!), 8) ?? 0n) : null;
  const changeSec = section(html, /^Unconfirmed change/i);
  const changeRows = changeSec ? rows(changeSec).filter((r) => r.length === 3 && /^[0-9a-f]{64}$/.test(r[0]!)) : null;
  const valueSum = (title: RegExp) => {
    const s = section(html, title);
    return s ? sumColumn(rows(s).filter((r) => /^[0-9a-f]{64}$/.test(r[0] ?? "")), -1, 8) : null;
  };
  const total = /Total available\s*<\/b>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/.exec(html);
  const starts = new Set<number>();
  for (const m of html.matchAll(/account_to_utxos_start=(\d+)/g)) starts.add(Number(m[1]));
  const minConf = thValue(html, /^Min number of confirmations/i);
  return {
    mainAddress: thValue(html, /^Main address/i),
    managed: btc(thValue(html, /^Total BTC managed/i)),
    // The pending table prints amounts in satoshi (verified live 2026-09-22), the submitted table in BTC.
    pending: pendingRows ? pendingRows.reduce((acc, r) => acc + (/^\d+$/.test(r[2] ?? "") ? BigInt(r[2]!) : 0n), 0n) : null,
    pendingCount: pendingRows ? pendingRows.length : null,
    submitted: submittedAmounts ? submittedAmounts.reduce((a, b) => a + b, 0n) : null,
    submittedCount: submittedAmounts ? submittedAmounts.length : null,
    submittedTxids: submittedSec ? [...new Set([...submittedSec.matchAll(/<td rowspan='\d+'><a [^>]*href='[^']*\/tx\/([0-9a-f]{64})'/g)].map((m) => m[1]!))] : [],
    unconfirmedChange: changeRows ? sumColumn(changeRows, 2, 8) : null,
    quarantined: valueSum(/^Quarantined utxos/i),
    ignored: valueSum(/^Ignored utxos/i),
    totalKnownUtxos: total ? btc(strip(total[1]!)) : null,
    minConfirmations: minConf && /^\d+$/.test(minConf) ? Number(minConf) : null,
    pageStarts: [...starts].sort((a, b) => a - b),
    accounts: parseAccountUtxos(html),
  };
}

export interface CkbtcMetrics {
  btcBalance: bigint | null; utxosAvailable: number | null; managedAddresses: number | null; outpoints: number | null;
  pending: number | null; signing: number | null; submittedRequests: number | null; submittedTxs: number | null; stuckTxs: number | null;
  minConfirmations: number | null; cycles: number | null;
}

/** Exact metric names as served by the ckBTC minter. All verified live. */
export function parseCkbtcMetrics(text: string): CkbtcMetrics {
  const bal = metric(text, "ckbtc_minter_btc_balance");
  return {
    btcBalance: bal != null && Number.isSafeInteger(bal) ? BigInt(bal) : null,
    utxosAvailable: metric(text, "ckbtc_minter_utxos_available"),
    managedAddresses: metric(text, "ckbtc_minter_managed_addresses_count"),
    outpoints: metric(text, "ckbtc_minter_outpoint_count"),
    pending: metric(text, "ckbtc_minter_retrieve_btc_request_count", '{status="pending"}'),
    signing: metric(text, "ckbtc_minter_retrieve_btc_request_count", '{status="signing"}'),
    submittedRequests: metric(text, "ckbtc_minter_retrieve_btc_request_count", '{status="submitted"}'),
    submittedTxs: metric(text, "ckbtc_minter_btc_transaction_count", '{status="submitted"}'),
    stuckTxs: metric(text, "ckbtc_minter_btc_transaction_count", '{status="stuck"}'),
    minConfirmations: metric(text, "ckbtc_minter_min_confirmations"),
    cycles: metric(text, "ckbtc_minter_cycle_balance"),
  };
}

const ckbtcIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    get_minter_info: IDL.Func([], [IDL.Record({ min_confirmations: IDL.Nat32, retrieve_btc_min_amount: IDL.Nat64, kyt_fee: IDL.Nat64, deposit_btc_min_amount: IDL.Opt(IDL.Nat64) })], ["query"]),
    get_deposit_fee: IDL.Func([], [IDL.Nat64], ["query"]),
    estimate_withdrawal_fee: IDL.Func([IDL.Record({ amount: IDL.Opt(IDL.Nat64) })], [IDL.Record({ bitcoin_fee: IDL.Nat64, minter_fee: IDL.Nat64 })], ["query"]),
  });

export interface CkbtcInfo { minConfirmations: number; retrieveMin: bigint; checkFee: bigint; depositMin: bigint | null; depositFee: bigint; withdrawalBitcoinFee: bigint; withdrawalMinterFee: bigint }

/** Parameters only. The ckBTC get_minter_info has no balances: those live in /metrics and /dashboard. */
export async function ckbtcInfo(host: string, minterId = CKBTC_MINTER): Promise<CkbtcInfo> {
  const a = Actor.createActor(ckbtcIdl, { agent: await getAgent(host), canisterId: minterId });
  const [info, depositFee, wfee] = (await Promise.all([a.get_minter_info!(), a.get_deposit_fee!(), a.estimate_withdrawal_fee!({ amount: [] })])) as [
    { min_confirmations: number; retrieve_btc_min_amount: bigint; kyt_fee: bigint; deposit_btc_min_amount: [] | [bigint] }, bigint, { bitcoin_fee: bigint; minter_fee: bigint },
  ];
  return {
    minConfirmations: info.min_confirmations, retrieveMin: info.retrieve_btc_min_amount, checkFee: info.kyt_fee, depositMin: info.deposit_btc_min_amount[0] ?? null,
    depositFee, withdrawalBitcoinFee: wfee.bitcoin_fee, withdrawalMinterFee: wfee.minter_fee,
  };
}

// ---- ckETH and ckERC20 -----------------------------------------------------------------------------------------

const ckethIdl: IDL.InterfaceFactory = () => {
  const Tok = IDL.Record({ ckerc20_token_symbol: IDL.Text, erc20_contract_address: IDL.Text, ledger_canister_id: IDL.Principal });
  // Candid records decode by field name with subtyping, so only the fields we use are listed and
  // every one is opt in the live interface: a removed field decodes as absent instead of failing.
  const Info = IDL.Record({
    minter_address: IDL.Opt(IDL.Text), sweeper_address: IDL.Opt(IDL.Text), eth_helper_contract_address: IDL.Opt(IDL.Text), erc20_helper_contract_address: IDL.Opt(IDL.Text),
    deposit_with_subaccount_helper_contract_address: IDL.Opt(IDL.Text), sweeper_contract_address: IDL.Opt(IDL.Text), supported_ckerc20_tokens: IDL.Opt(IDL.Vec(Tok)),
    minimum_withdrawal_amount: IDL.Opt(IDL.Nat), last_observed_block_number: IDL.Opt(IDL.Nat), eth_balance: IDL.Opt(IDL.Nat),
    erc20_balances: IDL.Opt(IDL.Vec(IDL.Record({ erc20_contract_address: IDL.Text, balance: IDL.Nat }))),
    last_eth_scraped_block_number: IDL.Opt(IDL.Nat), last_erc20_scraped_block_number: IDL.Opt(IDL.Nat), last_deposit_with_subaccount_scraped_block_number: IDL.Opt(IDL.Nat),
    cketh_ledger_id: IDL.Opt(IDL.Principal), evm_rpc_id: IDL.Opt(IDL.Principal),
  });
  return IDL.Service({ get_minter_info: IDL.Func([], [Info], ["query"]) });
};

export interface CkErc20Token { symbol: string; contract: string; ledgerId: string }

export interface CkethInfo {
  minterAddress: string | null; sweeperAddress: string | null; ethHelper: string | null; erc20Helper: string | null; subaccountHelper: string | null; sweeperContract: string | null;
  tokens: CkErc20Token[]; ethBalance: bigint | null; erc20Balances: Map<string, bigint>;
  lastObservedBlock: number | null; lastEthScraped: number | null; lastErc20Scraped: number | null; lastSubaccountScraped: number | null;
  minWithdrawal: bigint | null; ckethLedger: string | null; evmRpc: string | null;
}

type O<T> = [] | [T];
const o = <T,>(v: O<T> | undefined): T | null => (v && v.length ? v[0]! : null);
const n = (v: O<bigint> | undefined): number | null => { const x = o(v); return x == null ? null : Number(x); };

export async function ckethInfo(host: string, minterId = CKETH_MINTER): Promise<CkethInfo> {
  const a = Actor.createActor(ckethIdl, { agent: await getAgent(host), canisterId: minterId });
  const r = (await a.get_minter_info!()) as {
    minter_address: O<string>; sweeper_address: O<string>; eth_helper_contract_address: O<string>; erc20_helper_contract_address: O<string>;
    deposit_with_subaccount_helper_contract_address: O<string>; sweeper_contract_address: O<string>;
    supported_ckerc20_tokens: O<{ ckerc20_token_symbol: string; erc20_contract_address: string; ledger_canister_id: Principal }[]>;
    minimum_withdrawal_amount: O<bigint>; last_observed_block_number: O<bigint>; eth_balance: O<bigint>; erc20_balances: O<{ erc20_contract_address: string; balance: bigint }[]>;
    last_eth_scraped_block_number: O<bigint>; last_erc20_scraped_block_number: O<bigint>; last_deposit_with_subaccount_scraped_block_number: O<bigint>;
    cketh_ledger_id: O<Principal>; evm_rpc_id: O<Principal>;
  };
  return {
    minterAddress: o(r.minter_address), sweeperAddress: o(r.sweeper_address), ethHelper: o(r.eth_helper_contract_address), erc20Helper: o(r.erc20_helper_contract_address),
    subaccountHelper: o(r.deposit_with_subaccount_helper_contract_address), sweeperContract: o(r.sweeper_contract_address),
    tokens: (o(r.supported_ckerc20_tokens) ?? []).map((t) => ({ symbol: t.ckerc20_token_symbol, contract: t.erc20_contract_address, ledgerId: t.ledger_canister_id.toText() })),
    ethBalance: o(r.eth_balance), erc20Balances: new Map((o(r.erc20_balances) ?? []).map((b) => [b.erc20_contract_address.toLowerCase(), b.balance])),
    lastObservedBlock: n(r.last_observed_block_number), lastEthScraped: n(r.last_eth_scraped_block_number), lastErc20Scraped: n(r.last_erc20_scraped_block_number),
    lastSubaccountScraped: n(r.last_deposit_with_subaccount_scraped_block_number), minWithdrawal: o(r.minimum_withdrawal_amount),
    ckethLedger: o(r.cketh_ledger_id)?.toText() ?? null, evmRpc: o(r.evm_rpc_id)?.toText() ?? null,
  };
}

export interface CkethDashboard {
  /** Per token symbol ("ckETH", "ckUSDC"): withdrawals burned on the IC whose Ethereum transaction is not final. */
  pendingOut: Map<string, { amount: bigint; count: number }>;
  /** Per token symbol: deposits the minter has seen but not minted. Empty map when the section is absent (nothing waiting). */
  pendingIn: Map<string, { amount: bigint; count: number }>;
  /** "Total unspent transaction fees (Wei)": ETH the minter charged for gas and did not spend. Backs no ckETH. */
  unspentTxFees: bigint | null;
  totalEthManaged: bigint | null;
  /** False when the pending transactions heading is missing, meaning the layout changed and pendingOut must be treated as unknown. */
  ok: boolean;
}

const int = (s: string | null | undefined): bigint | null => {
  const t = (s ?? "").replace(/[_,\s]/g, "");
  return /^\d+$/.test(t) ? BigInt(t) : null;
};

/** Sum a dashboard table by token symbol. Columns are located by header text so reordering does not break it. */
function sumBySymbol(sec: string): Map<string, { amount: bigint; count: number }> {
  const headers = (sec.match(/<th[^>]*>[\s\S]*?<\/th>/g) ?? []).map(strip);
  const symCol = headers.findIndex((h) => /^Token Symbol/i.test(h));
  const valCol = headers.findIndex((h) => /^(Value|Amount)\b/i.test(h));
  const out = new Map<string, { amount: bigint; count: number }>();
  if (symCol < 0 || valCol < 0) return out;
  for (const r of rows(sec)) {
    const amount = int(r[valCol]);
    const sym = r[symCol];
    if (amount == null || !sym) continue;
    const cur = out.get(sym) ?? { amount: 0n, count: 0 };
    out.set(sym, { amount: cur.amount + amount, count: cur.count + 1 });
  }
  return out;
}

export function parseCkethDashboard(html: string): CkethDashboard {
  const pendingSec = section(html, /^Pending Transactions/i);
  const requestsSec = section(html, /^Withdrawal Requests/i); // accepted, no transaction created yet. Present only when not empty.
  const mintSec = section(html, /^Events to mint/i); // present only when not empty
  const pendingOut = pendingSec ? sumBySymbol(pendingSec) : new Map<string, { amount: bigint; count: number }>();
  if (requestsSec) for (const [sym, v] of sumBySymbol(requestsSec)) {
    const cur = pendingOut.get(sym) ?? { amount: 0n, count: 0 };
    pendingOut.set(sym, { amount: cur.amount + v.amount, count: cur.count + v.count });
  }
  return {
    pendingOut, pendingIn: mintSec ? sumBySymbol(mintSec) : new Map(),
    unspentTxFees: int(thValue(html, /^Total unspent transaction fees/i)), totalEthManaged: int(thValue(html, /^Total ETH managed/i)), ok: pendingSec != null,
  };
}
