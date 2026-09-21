// Internet Computer access layer. Everything that talks to the IC goes through here.
// Runs in a Cloudflare Worker: fetch only, no Node APIs.
//
// Trust model: update calls (controller status reads) are certified and verified against the
// NNS root key by the agent. Bulk queries skip per-node signature verification to stay inside
// the Worker CPU budget; they are used for discovery and liveness, never for balances.
import { Actor, CanisterStatus, HttpAgent } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import type { RunStatus } from "./health";

export const NNS_ROOT = "r7inp-6aaaa-aaaaa-aaabq-cai";
export const SNS_WASM = "qaa6y-5yaaa-aaaaa-aaafa-cai";
export const ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
export const ICP_INDEX = "qhbym-qaaaa-aaaaa-aaafq-cai";
export const NNS_GOVERNANCE = "rrkah-fqaaa-aaaaa-aaaaq-cai";
export const CMC = "rkp4c-7iaaa-aaaaa-aaaca-cai";
export const CK_ORCHESTRATOR = "vxkom-oyaaa-aaaar-qafda-cai";
export const BLACKHOLE_NINEGUA = "e3mmv-5qaaa-aaaah-aadma-cai";

let cached: { host: string; agent: Promise<HttpAgent> } | null = null;

export function getAgent(host: string): Promise<HttpAgent> {
  if (cached?.host === host) return cached.agent;
  const agent = HttpAgent.create({
    host,
    // Workers need fetch called with the global as receiver.
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    shouldFetchRootKey: false,
    verifyQuerySignatures: false,
    retryTimes: 2,
  });
  cached = { host, agent };
  return agent;
}

const toNum = (v: bigint | number | undefined | null): number | null => {
  if (v == null) return null;
  const n = typeof v === "bigint" ? Number(v > 9_000_000_000_000_000_000n ? 9_000_000_000_000_000_000n : v) : v;
  return Number.isFinite(n) ? n : null;
};
const hex = (b: Uint8Array | number[] | undefined | null) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") : null);
const opt = <T,>(o: [] | [T] | undefined): T | null => (o && o.length ? o[0]! : null);

export interface StatusReading {
  canisterId: string;
  cycles: number | null;
  runStatus: RunStatus;
  memoryBytes: number | null;
  idleBurnPerDay: number | null;
  freezingThresholdS: number | null;
  controllers: string[] | null;
  moduleHash: string | null;
}

// ---- candid -------------------------------------------------------------------------------

const StatusType = IDL.Variant({ stopped: IDL.Null, stopping: IDL.Null, running: IDL.Null });
const LogVisibility = IDL.Variant({ controllers: IDL.Null, public: IDL.Null, allowed_viewers: IDL.Vec(IDL.Principal) });
const QueryStats = IDL.Record({
  num_calls_total: IDL.Opt(IDL.Nat), num_instructions_total: IDL.Opt(IDL.Nat),
  request_payload_bytes_total: IDL.Opt(IDL.Nat), response_payload_bytes_total: IDL.Opt(IDL.Nat),
});

// Candid records are decoded by field name with subtyping, so listing only the fields we
// need keeps this robust against new fields being added upstream.
const SnsSettings = IDL.Record({ freezing_threshold: IDL.Nat, controllers: IDL.Vec(IDL.Principal) });
const SnsStatus = IDL.Record({
  status: StatusType, memory_size: IDL.Nat, cycles: IDL.Nat, settings: SnsSettings,
  idle_cycles_burned_per_day: IDL.Nat, module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
});
const SnsCanisterSummary = IDL.Record({ status: IDL.Opt(SnsStatus), canister_id: IDL.Opt(IDL.Principal) });
const SnsSummaryResponse = IDL.Record({
  root: IDL.Opt(SnsCanisterSummary), swap: IDL.Opt(SnsCanisterSummary), ledger: IDL.Opt(SnsCanisterSummary),
  index: IDL.Opt(SnsCanisterSummary), governance: IDL.Opt(SnsCanisterSummary),
  dapps: IDL.Vec(SnsCanisterSummary), archives: IDL.Vec(SnsCanisterSummary),
});
const snsRootIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    get_sns_canisters_summary: IDL.Func([IDL.Record({ update_canister_list: IDL.Opt(IDL.Bool) })], [SnsSummaryResponse], []),
  });

const RootSettings = IDL.Record({ freezing_threshold: IDL.Opt(IDL.Nat), controllers: IDL.Vec(IDL.Principal) });
const RootStatus = IDL.Record({
  status: StatusType, memory_size: IDL.Nat, cycles: IDL.Nat, settings: RootSettings,
  idle_cycles_burned_per_day: IDL.Opt(IDL.Nat), module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
});
const nnsRootIdl: IDL.InterfaceFactory = () =>
  IDL.Service({ canister_status: IDL.Func([IDL.Record({ canister_id: IDL.Principal })], [RootStatus], []) });


const ledgerIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    // ICRC ledgers
    archives: IDL.Func([], [IDL.Vec(IDL.Record({ canister_id: IDL.Principal, block_range_start: IDL.Nat, block_range_end: IDL.Nat }))], ["query"]),
    icrc3_get_archives: IDL.Func([IDL.Record({ from: IDL.Opt(IDL.Principal) })], [IDL.Vec(IDL.Record({ canister_id: IDL.Principal, start: IDL.Nat, end: IDL.Nat }))], ["query"]),
    icrc1_symbol: IDL.Func([], [IDL.Text], ["query"]),
    icrc1_name: IDL.Func([], [IDL.Text], ["query"]),
    icrc1_decimals: IDL.Func([], [IDL.Nat8], ["query"]),
    icrc1_fee: IDL.Func([], [IDL.Nat], ["query"]),
    icrc1_total_supply: IDL.Func([], [IDL.Nat], ["query"]),
    icrc1_balance_of: IDL.Func([IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })], [IDL.Nat], ["query"]),
  });
const icpLedgerIdl: IDL.InterfaceFactory = () =>
  IDL.Service({ archives: IDL.Func([], [IDL.Record({ archives: IDL.Vec(IDL.Record({ canister_id: IDL.Principal })) })], ["query"]) });

void LogVisibility;
void QueryStats;

const runStatus = (v: Record<string, null>): RunStatus => (("running" in v ? "running" : "stopping" in v ? "stopping" : "stopped") as RunStatus);

// ---- measured sources -----------------------------------------------------------------------

type SnsSummaryRaw = Record<"root" | "swap" | "ledger" | "index" | "governance", [] | [SnsCanisterRaw]> & { dapps: SnsCanisterRaw[]; archives: SnsCanisterRaw[] };
interface SnsCanisterRaw {
  canister_id: [] | [Principal];
  status: [] | [{ status: Record<string, null>; memory_size: bigint; cycles: bigint; idle_cycles_burned_per_day: bigint; module_hash: [] | [Uint8Array]; settings: { freezing_threshold: bigint; controllers: Principal[] } }];
}

export interface SnsSummary { role: "root" | "swap" | "ledger" | "index" | "governance" | "dapp" | "archive"; reading: StatusReading | null; canisterId: string }

/** One certified update call returns the status of every canister an SNS owns, archives included. */
export async function snsSummary(host: string, rootId: string): Promise<SnsSummary[]> {
  const actor = Actor.createActor(snsRootIdl, { agent: await getAgent(host), canisterId: rootId });
  const res = (await actor.get_sns_canisters_summary!({ update_canister_list: [] })) as SnsSummaryRaw;
  const out: SnsSummary[] = [];
  const push = (role: SnsSummary["role"], c: SnsCanisterRaw | null) => {
    const id = c ? opt(c.canister_id) : null;
    if (!c || !id) return;
    const st = opt(c.status);
    out.push({
      role,
      canisterId: id.toText(),
      reading: st
        ? {
            canisterId: id.toText(), cycles: toNum(st.cycles), runStatus: runStatus(st.status), memoryBytes: toNum(st.memory_size),
            idleBurnPerDay: toNum(st.idle_cycles_burned_per_day), freezingThresholdS: toNum(st.settings.freezing_threshold),
            controllers: st.settings.controllers.map((p) => p.toText()), moduleHash: hex(opt(st.module_hash)),
          }
        : null,
    });
  };
  for (const k of ["root", "governance", "ledger", "index", "swap"] as const) push(k, opt(res[k]));
  res.archives.forEach((a) => push("archive", a));
  res.dapps.forEach((d) => push("dapp", d));
  return out;
}

interface RootStatusRaw {
  status: Record<string, null>; memory_size: bigint; cycles: bigint; idle_cycles_burned_per_day: [] | [bigint]; module_hash: [] | [Uint8Array];
  settings: { freezing_threshold: [] | [bigint]; controllers: Principal[] };
}

/** NNS root answers canister_status for everything it controls: ICP ledger suite and the ck token suites. */
export async function nnsRootStatus(host: string, canisterId: string): Promise<StatusReading> {
  const actor = Actor.createActor(nnsRootIdl, { agent: await getAgent(host), canisterId: NNS_ROOT });
  const st = (await actor.canister_status!({ canister_id: Principal.fromText(canisterId) })) as RootStatusRaw;
  return {
    canisterId, cycles: toNum(st.cycles), runStatus: runStatus(st.status), memoryBytes: toNum(st.memory_size),
    idleBurnPerDay: toNum(opt(st.idle_cycles_burned_per_day)), freezingThresholdS: toNum(opt(st.settings.freezing_threshold)),
    controllers: st.settings.controllers.map((p) => p.toText()), moduleHash: hex(opt(st.module_hash)),
  };
}

/**
 * The ninegua blackhole exposes canister_status for any canister that lists it as a controller.
 * Same wire shape as NNS root, minus idle burn. Note that it reports status "running" even for a
 * frozen canister, so frozen state must come from the balance or a probe, never from this field.
 * (CycleOps blackholes refuse outside callers, so they are not a source.)
 */
export async function blackholeStatus(host: string, blackholeId: string, canisterId: string): Promise<StatusReading> {
  const actor = Actor.createActor(nnsRootIdl, { agent: await getAgent(host), canisterId: blackholeId });
  const st = (await actor.canister_status!({ canister_id: Principal.fromText(canisterId) })) as RootStatusRaw;
  return {
    canisterId, cycles: toNum(st.cycles), runStatus: runStatus(st.status), memoryBytes: toNum(st.memory_size),
    idleBurnPerDay: toNum(opt(st.idle_cycles_burned_per_day)), freezingThresholdS: toNum(opt(st.settings.freezing_threshold)),
    controllers: st.settings.controllers.map((p) => p.toText()), moduleHash: hex(opt(st.module_hash)),
  };
}

export interface MetricsReading { cycles: number; memoryBytes: number | null }
export type MetricsResult = { kind: "ok"; reading: MetricsReading } | { kind: "down"; runStatus: RunStatus; code: string | null } | { kind: "none" };

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

export function parseMetrics(text: string): MetricsReading | null {
  // Every DFINITY ledger suite wasm reports its own balance. Newer ones use cycle_balance{canister="..."},
  // older ones only ledger_cycle_balance, index_cycle_balance, or archive_cycle_balance.
  const m = /^(?:\w*_)?cycle_balance(?:\{[^}]*\})?\s+([0-9.e+]+)/m.exec(text);
  if (!m) return null;
  const cycles = Number(m[1]);
  if (!Number.isFinite(cycles)) return null;
  const grab = (re: RegExp) => {
    const x = re.exec(text);
    return x ? Number(x[1]) : null;
  };
  const stable = grab(/^stable_memory_bytes\s+([0-9.e+]+)/m);
  const heap = grab(/^heap_memory_bytes\s+([0-9.e+]+)/m);
  return { cycles, memoryBytes: stable != null || heap != null ? (stable ?? 0) + (heap ?? 0) : null };
}

/**
 * Reads /metrics as a direct http_request query through the API boundary node. This works for
 * canisters the HTTP gateway refuses to serve (ICP index, some archives) and costs a few ms of CPU.
 * A frozen canister rejects this query with IC0207, so a failure here doubles as a liveness probe.
 */
export async function metricsCycles(host: string, canisterId: string): Promise<MetricsResult> {
  const actor = Actor.createActor(httpIdl, { agent: await getAgent(host), canisterId });
  try {
    const res = (await actor.http_request!({ url: "/metrics", method: "GET", body: [], headers: [] })) as { body: Uint8Array | number[]; status_code: number };
    if (res.status_code !== 200) return { kind: "none" };
    const reading = parseMetrics(new TextDecoder().decode(res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body)));
    return reading ? { kind: "ok", reading } : { kind: "none" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = /\b(IC\d{4})\b/.exec(message)?.[1] ?? null;
    const st = classifyReject(code, message);
    return st ? { kind: "down", runStatus: st, code } : { kind: "none" };
  }
}

// ---- probing ------------------------------------------------------------------------------------

const EMPTY_ARGS = IDL.encode([], []);

export interface ProbeResult { runStatus: RunStatus; code: string | null; message: string | null }

export function classifyReject(code: string | null | undefined, message: string | null | undefined): RunStatus | null {
  const msg = message ?? "";
  if (code === "IC0207" || /out of cycles|because it's frozen|is frozen/i.test(msg)) return "frozen";
  if (code === "IC0508" || code === "IC0509" || /is stopped|is stopping/i.test(msg)) return "stopped";
  if (code === "IC0301" || /not found|does not exist/i.test(msg)) return "deleted";
  if (code === "IC0537" || /no wasm module|contains no Wasm/i.test(msg)) return "no_wasm";
  return null;
}

/**
 * Universal liveness probe for canisters whose balance nobody can read. Submits an update call
 * to a method that does not exist. The ingress filter answers before any method lookup:
 *   frozen or out of cycles -> IC0207, stopped -> IC0508, missing -> IC0301 or HTTP 400.
 * A healthy canister accepts the message and rejects it during execution, which tells us it is
 * running. Cost to the target is one ingress message fee, roughly a millionth of a trillion cycles.
 */
export async function probe(host: string, canisterId: string): Promise<ProbeResult> {
  const agent = await getAgent(host);
  try {
    const r = await agent.call(canisterId, { methodName: "__icpwatch_probe", arg: EMPTY_ARGS, effectiveCanisterId: canisterId });
    const body = r.response.body as { status?: string; error_code?: string; reject_message?: string } | null | undefined;
    if (body && body.status === "non_replicated_rejection") {
      return { runStatus: classifyReject(body.error_code, body.reject_message) ?? "unknown", code: body.error_code ?? null, message: body.reject_message ?? null };
    }
    return { runStatus: "running", code: null, message: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = /\b(IC\d{4})\b/.exec(message)?.[1] ?? null;
    const st = classifyReject(code, message);
    if (st) return { runStatus: st, code, message: message.slice(0, 300) };
    return { runStatus: "unknown", code, message: message.slice(0, 300) };
  }
}

/** Free liveness probe for ledgers, indexes, and archives: a query to a method we know exists. */
export async function probeQuery(host: string, canisterId: string, method: string): Promise<ProbeResult> {
  const agent = await getAgent(host);
  try {
    const r = (await agent.query(canisterId, { methodName: method, arg: EMPTY_ARGS })) as { status: string; error_code?: string; reject_message?: string };
    if (r.status === "replied") return { runStatus: "running", code: null, message: null };
    const st = classifyReject(r.error_code, r.reject_message);
    // Method-not-found style rejections still prove the canister is executing.
    return { runStatus: st ?? (r.error_code === "IC0536" || r.error_code === "IC0503" ? "running" : "unknown"), code: r.error_code ?? null, message: r.reject_message ?? null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = /\b(IC\d{4})\b/.exec(message)?.[1] ?? null;
    return { runStatus: classifyReject(code, message) ?? "unknown", code, message: message.slice(0, 300) };
  }
}

// ---- discovery ------------------------------------------------------------------------------------

/** Archive canisters of a ledger, straight from the ledger. Tries ICRC-3 first, then the legacy method. */
export async function discoverArchives(host: string, ledgerId: string): Promise<string[]> {
  const agent = await getAgent(host);
  if (ledgerId === ICP_LEDGER) {
    const a = Actor.createActor(icpLedgerIdl, { agent, canisterId: ledgerId });
    const r = (await a.archives!()) as { archives: { canister_id: Principal }[] };
    return r.archives.map((x) => x.canister_id.toText());
  }
  const a = Actor.createActor(ledgerIdl, { agent, canisterId: ledgerId });
  const found = new Set<string>();
  try {
    const r = (await a.icrc3_get_archives!({ from: [] })) as { canister_id: Principal }[];
    r.forEach((x) => found.add(x.canister_id.toText()));
  } catch {
    /* not an ICRC-3 ledger */
  }
  try {
    const r = (await a.archives!()) as { canister_id: Principal }[];
    r.forEach((x) => found.add(x.canister_id.toText()));
  } catch {
    /* no legacy method */
  }
  return [...found];
}

export interface LedgerMeta { symbol: string; name: string; decimals: number; fee: string; totalSupply: string }

export async function ledgerMeta(host: string, ledgerId: string): Promise<LedgerMeta> {
  const a = Actor.createActor(ledgerIdl, { agent: await getAgent(host), canisterId: ledgerId });
  const [symbol, name, decimals, fee, supply] = await Promise.all([a.icrc1_symbol!(), a.icrc1_name!(), a.icrc1_decimals!(), a.icrc1_fee!(), a.icrc1_total_supply!()]);
  return { symbol: symbol as string, name: name as string, decimals: Number(decimals), fee: String(fee), totalSupply: String(supply) };
}

export async function totalSupply(host: string, ledgerId: string): Promise<string> {
  const a = Actor.createActor(ledgerIdl, { agent: await getAgent(host), canisterId: ledgerId });
  return String(await a.icrc1_total_supply!());
}

export async function balanceOf(host: string, ledgerId: string, owner: string): Promise<bigint> {
  const a = Actor.createActor(ledgerIdl, { agent: await getAgent(host), canisterId: ledgerId });
  return (await a.icrc1_balance_of!({ owner: Principal.fromText(owner), subaccount: [] })) as bigint;
}

/** Certified controllers, module hash, and subnet from the state tree. Works for any canister, anonymously. */
export async function readCanisterState(host: string, canisterId: string): Promise<{ controllers: string[] | null; moduleHash: string | null; subnetId: string | null }> {
  const agent = await getAgent(host);
  const res = await CanisterStatus.request({ canisterId: Principal.fromText(canisterId), agent, paths: ["controllers", "module_hash", "subnet"] });
  const controllers = res.get("controllers") as Principal[] | undefined;
  const mh = res.get("module_hash") as string | undefined;
  const subnet = res.get("subnet") as { subnetId?: string } | undefined;
  return { controllers: controllers ? controllers.map((p) => p.toText()) : null, moduleHash: mh ?? null, subnetId: subnet?.subnetId ?? null };
}

export function isPrincipal(text: string): boolean {
  try {
    Principal.fromText(text);
    return true;
  } catch {
    return false;
  }
}

/** Canister ids are 10 bytes ending in 0x01 0x01. Everything else is a user or subnet principal. */
export function isCanisterId(text: string): boolean {
  try {
    const b = Principal.fromText(text).toUint8Array();
    return b.length === 10 && b[8] === 1 && b[9] === 1;
  } catch {
    return false;
  }
}

// ---- ck tokens and index discovery ---------------------------------------------------------------

const lsoIdl: IDL.InterfaceFactory = () => {
  const MCS = IDL.Variant({ Created: IDL.Record({ canister_id: IDL.Principal }), Installed: IDL.Record({ canister_id: IDL.Principal, installed_wasm_hash: IDL.Text }) });
  const Managed = IDL.Record({ ckerc20_token_symbol: IDL.Text, ledger: IDL.Opt(MCS), index: IDL.Opt(MCS), archives: IDL.Vec(IDL.Principal) });
  const ManagedPre = IDL.Record({ token_symbol: IDL.Text, ledger: IDL.Opt(MCS), index: IDL.Opt(MCS), archives: IDL.Vec(IDL.Principal) });
  return IDL.Service({
    get_orchestrator_info: IDL.Func([], [IDL.Record({ managed_canisters: IDL.Vec(Managed), managed_pre_existing_ledger_suites: IDL.Opt(IDL.Vec(ManagedPre)) })], ["query"]),
  });
};

export interface CkSuite { symbol: string; ledger: string; index: string | null; archives: string[] }

type Mcs = { Created: { canister_id: Principal } } | { Installed: { canister_id: Principal } };
const mcsId = (o: [] | [Mcs]): string | null => {
  const v = opt(o);
  if (!v) return null;
  return ("Installed" in v ? v.Installed.canister_id : v.Created.canister_id).toText();
};

/** Every ckERC20 suite (plus ckETH) from the ledger suite orchestrator: ledger, index, and archives. */
export async function ckSuites(host: string): Promise<CkSuite[]> {
  const a = Actor.createActor(lsoIdl, { agent: await getAgent(host), canisterId: CK_ORCHESTRATOR });
  const info = (await a.get_orchestrator_info!()) as {
    managed_canisters: { ckerc20_token_symbol: string; ledger: [] | [Mcs]; index: [] | [Mcs]; archives: Principal[] }[];
    managed_pre_existing_ledger_suites: [] | [{ token_symbol: string; ledger: [] | [Mcs]; index: [] | [Mcs]; archives: Principal[] }[]];
  };
  const out: CkSuite[] = [];
  for (const m of info.managed_canisters) {
    const ledger = mcsId(m.ledger);
    if (ledger) out.push({ symbol: m.ckerc20_token_symbol, ledger, index: mcsId(m.index), archives: m.archives.map((p) => p.toText()) });
  }
  for (const m of opt(info.managed_pre_existing_ledger_suites) ?? []) {
    const ledger = mcsId(m.ledger);
    if (ledger) out.push({ symbol: m.token_symbol, ledger, index: mcsId(m.index), archives: m.archives.map((p) => p.toText()) });
  }
  return out;
}

const icrc106Idl: IDL.InterfaceFactory = () =>
  IDL.Service({
    icrc106_get_index_principal: IDL.Func([], [IDL.Variant({ Ok: IDL.Principal, Err: IDL.Reserved })], ["query"]),
    icrc1_metadata: IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Text, IDL.Variant({ Nat: IDL.Nat, Int: IDL.Int, Text: IDL.Text, Blob: IDL.Vec(IDL.Nat8) })))], ["query"]),
  });

/** ICRC-106: a ledger can name its own index canister. */
export async function indexOf(host: string, ledgerId: string): Promise<string | null> {
  try {
    const a = Actor.createActor(icrc106Idl, { agent: await getAgent(host), canisterId: ledgerId });
    const r = (await a.icrc106_get_index_principal!()) as { Ok?: Principal };
    return r.Ok ? r.Ok.toText() : null;
  } catch {
    return null;
  }
}

/** The icrc1:logo metadata entry, usually a data URI. Large, so only fetched by the cached /logo route. */
export async function ledgerLogo(host: string, ledgerId: string): Promise<string | null> {
  const a = Actor.createActor(icrc106Idl, { agent: await getAgent(host), canisterId: ledgerId });
  const md = (await a.icrc1_metadata!()) as [string, { Text?: string }][];
  return md.find(([k]) => k === "icrc1:logo")?.[1]?.Text ?? null;
}

/** Run tasks with bounded concurrency. Workers allow six simultaneous outbound connections. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
