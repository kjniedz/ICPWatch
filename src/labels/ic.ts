// The on-chain reads behind verified labels. Anonymous queries only, nothing here can change state.
// Candid is minimal on purpose: records decode by field name with subtyping, so new upstream fields are ignored.
// Every method and shape below was checked against the live canisters on 2026-09-21.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import { NNS_GOVERNANCE, SNS_WASM, getAgent } from "../lib/ic";

export const ICPSWAP_FACTORY = "4mmnk-kiaaa-aaaag-qbllq-cai";

type O<T> = [] | [T];
const text = (o: O<Principal>): string | null => (o.length ? o[0]!.toText() : null);

const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
interface AccountRaw { owner: Principal; subaccount: O<Uint8Array | number[]> }
export interface ChainAccount { owner: string; subaccount: Uint8Array | null }
const account = (a: AccountRaw): ChainAccount => {
  const s = a.subaccount[0];
  const bytes = s ? (s instanceof Uint8Array ? s : new Uint8Array(s)) : null;
  return { owner: a.owner.toText(), subaccount: bytes && bytes.some((b) => b !== 0) ? bytes : null };
};

// ---- SNS ----------------------------------------------------------------------------------------------------------------

export interface DeployedSns { root: string; governance: string | null; ledger: string | null; swap: string | null; index: string | null }

const snsWasmIdl: IDL.InterfaceFactory = () => {
  const P = IDL.Opt(IDL.Principal);
  return IDL.Service({
    list_deployed_snses: IDL.Func([IDL.Record({})], [IDL.Record({ instances: IDL.Vec(IDL.Record({ root_canister_id: P, governance_canister_id: P, index_canister_id: P, swap_canister_id: P, ledger_canister_id: P })) })], ["query"]),
  });
};

/** Every SNS the NNS ever deployed, from SNS-W. This is what makes a root canister an SNS root. */
export async function deployedSnses(host: string): Promise<DeployedSns[]> {
  const a = Actor.createActor(snsWasmIdl, { agent: await getAgent(host), canisterId: SNS_WASM });
  const r = (await a.list_deployed_snses!({})) as { instances: Record<"root_canister_id" | "governance_canister_id" | "index_canister_id" | "swap_canister_id" | "ledger_canister_id", O<Principal>>[] };
  const out: DeployedSns[] = [];
  for (const i of r.instances) {
    const root = text(i.root_canister_id);
    if (root) out.push({ root, governance: text(i.governance_canister_id), ledger: text(i.ledger_canister_id), swap: text(i.swap_canister_id), index: text(i.index_canister_id) });
  }
  return out;
}

export interface SnsCanisters { root: string | null; governance: string | null; ledger: string | null; swap: string | null; index: string | null; archives: string[]; dapps: string[]; extensions: string[] }

const snsRootIdl: IDL.InterfaceFactory = () => {
  const P = IDL.Opt(IDL.Principal);
  return IDL.Service({
    list_sns_canisters: IDL.Func([IDL.Record({})], [IDL.Record({
      root: P, swap: P, ledger: P, index: P, governance: P, dapps: IDL.Vec(IDL.Principal), archives: IDL.Vec(IDL.Principal),
      extensions: IDL.Opt(IDL.Record({ extension_canister_ids: IDL.Vec(IDL.Principal) })),
    })], ["query"]),
  });
};

/** What an SNS root says it owns: the five core canisters, archives, registered dapps, and extensions. */
export async function snsCanisters(host: string, rootId: string): Promise<SnsCanisters> {
  const a = Actor.createActor(snsRootIdl, { agent: await getAgent(host), canisterId: rootId });
  const r = (await a.list_sns_canisters!({})) as {
    root: O<Principal>; swap: O<Principal>; ledger: O<Principal>; index: O<Principal>; governance: O<Principal>; dapps: Principal[]; archives: Principal[];
    extensions: O<{ extension_canister_ids: Principal[] }>;
  };
  return {
    root: text(r.root), governance: text(r.governance), ledger: text(r.ledger), swap: text(r.swap), index: text(r.index),
    archives: r.archives.map((p) => p.toText()), dapps: r.dapps.map((p) => p.toText()), extensions: (r.extensions[0]?.extension_canister_ids ?? []).map((p) => p.toText()),
  };
}

// ---- NNS known neurons --------------------------------------------------------------------------------------------------

export interface KnownNeuron { id: string; name: string; description: string | null }

const nnsGovIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    list_known_neurons: IDL.Func([], [IDL.Record({
      known_neurons: IDL.Vec(IDL.Record({ id: IDL.Opt(IDL.Record({ id: IDL.Nat64 })), known_neuron_data: IDL.Opt(IDL.Record({ name: IDL.Text, description: IDL.Opt(IDL.Text) })) })),
    })], ["query"]),
  });

/** Neurons that registered a public name through an NNS proposal. Their controllers are private and are not guessed. */
export async function knownNeurons(host: string): Promise<KnownNeuron[]> {
  const a = Actor.createActor(nnsGovIdl, { agent: await getAgent(host), canisterId: NNS_GOVERNANCE });
  const r = (await a.list_known_neurons!()) as { known_neurons: { id: O<{ id: bigint }>; known_neuron_data: O<{ name: string; description: O<string> }> }[] };
  const out: KnownNeuron[] = [];
  for (const k of r.known_neurons) {
    const id = k.id[0]?.id, data = k.known_neuron_data[0];
    if (id != null && data?.name) out.push({ id: String(id), name: data.name, description: data.description[0] ?? null });
  }
  return out;
}

// ---- ledgers ------------------------------------------------------------------------------------------------------------

const mintingIdl: IDL.InterfaceFactory = () => IDL.Service({ icrc1_minting_account: IDL.Func([], [IDL.Opt(Account)], ["query"]) });

/** The account allowed to mint on a ledger. Transfers to it are burns. */
export async function mintingAccount(host: string, ledgerId: string): Promise<ChainAccount | null> {
  const a = Actor.createActor(mintingIdl, { agent: await getAgent(host), canisterId: ledgerId });
  const r = (await a.icrc1_minting_account!()) as O<AccountRaw>;
  return r.length ? account(r[0]!) : null;
}

const feeColIdl: IDL.InterfaceFactory = () =>
  IDL.Service({ get_fee_collectors_ranges: IDL.Func([], [IDL.Record({ ranges: IDL.Vec(IDL.Tuple(Account, IDL.Vec(IDL.Tuple(IDL.Nat, IDL.Nat)))) })], ["query"]) });

/** Fee collector accounts a DFINITY index-ng canister has seen in the ledger's blocks. */
export async function feeCollectors(host: string, indexId: string): Promise<ChainAccount[]> {
  const a = Actor.createActor(feeColIdl, { agent: await getAgent(host), canisterId: indexId });
  const r = (await a.get_fee_collectors_ranges!()) as { ranges: [AccountRaw, [bigint, bigint][]][] };
  return r.ranges.map(([acc]) => account(acc));
}

// ---- ICPSwap ------------------------------------------------------------------------------------------------------------

export interface FactoryPool { canister: string; token0: string; token1: string }

const factoryIdl: IDL.InterfaceFactory = () => {
  const Token = IDL.Record({ address: IDL.Text, standard: IDL.Text });
  const PoolData = IDL.Record({ token0: Token, token1: Token, canisterId: IDL.Principal });
  return IDL.Service({ getPools: IDL.Func([], [IDL.Variant({ ok: IDL.Vec(PoolData), err: IDL.Reserved })], ["query"]) });
};

/** Every pool canister the ICPSwap swap factory created. */
export async function icpswapPools(host: string): Promise<FactoryPool[]> {
  const a = Actor.createActor(factoryIdl, { agent: await getAgent(host), canisterId: ICPSWAP_FACTORY });
  const r = (await a.getPools!()) as { ok?: { token0: { address: string }; token1: { address: string }; canisterId: Principal }[] };
  if (!r.ok) throw new Error("ICPSwap factory getPools returned an error");
  return r.ok.map((p) => ({ canister: p.canisterId.toText(), token0: p.token0.address, token1: p.token1.address }));
}
