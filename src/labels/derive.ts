// Pure label builders: facts in, label rows out. No network and no bindings, so everything here is unit tested.
// The on-chain facts come from src/labels/ic.ts and the registry tables, see src/labels/collect.ts.
import { accountIdHex, encodeIcrcAccount } from "../lib/account";
import { isCanisterId } from "../lib/ic";
import { treasurySubaccount } from "../lib/sns";
import { Principal } from "@icp-sdk/core/principal";
import type { LabelCategory } from "./index";
import type { ChainAccount, FactoryPool, KnownNeuron, SnsCanisters } from "./ic";
import { cleanText, type LabelRow } from "./store";

const row = (id: string, name: string, category: LabelCategory, source: string, extra: Partial<LabelRow> = {}): LabelRow => ({
  id, name: cleanText(name), category, confidence: "verified", source: cleanText(source, 300), token_id: null, url: null, owner: null, origin: "derived", ...extra,
});

// ---- static seeds, each one re-checked on chain on 2026-09-21 ----------------------------------------------------------

const NNS_SOURCE = "Well-known NNS canister id; read_state shows NNS root (r7inp-6aaaa-aaaaa-aaabq-cai) as its only controller";
const dash = (id: string) => `https://dashboard.internetcomputer.org/canister/${id}`;

/** NNS and system canisters. Controllers were read with read_state: all are controlled by NNS root (root itself by the lifeline canister). */
export const NNS_SEEDS: LabelRow[] = ([
  ["rwlgt-iiaaa-aaaaa-aaaaa-cai", "NNS Registry", "nns"],
  ["rrkah-fqaaa-aaaaa-aaaaq-cai", "NNS Governance", "nns"],
  ["ryjl3-tyaaa-aaaaa-aaaba-cai", "ICP Ledger", "ledger"],
  ["rkp4c-7iaaa-aaaaa-aaaca-cai", "Cycles Minting Canister", "nns"],
  ["rno2w-sqaaa-aaaaa-aaacq-cai", "NNS Lifeline", "nns"],
  ["renrk-eyaaa-aaaaa-aaada-cai", "Genesis Token Canister", "nns"],
  ["rdmx6-jaaaa-aaaaa-aaadq-cai", "Internet Identity", "nns"],
  ["qoctq-giaaa-aaaaa-aaaea-cai", "NNS Dapp", "nns"],
  ["qaa6y-5yaaa-aaaaa-aaafa-cai", "SNS-W (SNS Wasm Modules)", "nns"],
  ["qhbym-qaaaa-aaaaa-aaafq-cai", "ICP Index", "index"],
  ["um5iw-rqaaa-aaaaq-qaaba-cai", "Cycles Ledger", "ledger"],
  ["ul4oc-4iaaa-aaaaq-qaabq-cai", "Cycles Ledger Index", "index"],
  ["uf6dk-hyaaa-aaaaq-qaaaq-cai", "Exchange Rate Canister", "nns"],
  ["3r4gx-wqaaa-aaaaq-aaaia-cai", "SNS Aggregator", "nns", "Well-known DFINITY canister id; read_state shows NNS root and SNS-W as its controllers"],
  ["ghsi2-tqaaa-aaaan-aaaca-cai", "Bitcoin Canister", "nns"],
  ["r7inp-6aaaa-aaaaa-aaabq-cai", "NNS Root", "nns", "Well-known NNS canister id; read_state shows the NNS lifeline canister as its only controller"],
  ["vxkom-oyaaa-aaaar-qafda-cai", "ck Ledger Suite Orchestrator", "minter", "Well-known ck canister id; read_state shows NNS root and itself as its controllers, and get_orchestrator_info lists the ckERC20 ledger suites it manages"],
] as [string, string, LabelCategory, string?][]).map(([id, name, category, source]) =>
  row(id, name, category, source ?? NNS_SOURCE, {
    origin: "seed", url: dash(id), token_id: id === "ryjl3-tyaaa-aaaaa-aaaba-cai" || id === "qhbym-qaaaa-aaaaa-aaafq-cai" ? "ryjl3-tyaaa-aaaaa-aaaba-cai" : null,
  }));

/**
 * Principals nobody can sign for. Anything they hold is out of circulation.
 * The CycleOps blackholes have an empty controller list, the ninegua blackhole lists only itself (read_state, 2026-09-21).
 */
export const BURN_SEEDS: LabelRow[] = [
  row("aaaaa-aa", "IC management canister (burn address)", "burn", "IC interface specification: aaaaa-aa is the virtual management canister. It is not a real canister and can never sign a transfer, so tokens sent to it are unspendable", { origin: "seed" }),
  row("e3mmv-5qaaa-aaaah-aadma-cai", "Blackhole (ninegua)", "burn", "read_state: its only controller is itself, so its code is immutable; the code has no method that moves funds", { origin: "seed", url: "https://github.com/ninegua/ic-blackhole" }),
  ...["5vdms-kaaaa-aaaap-aa3uq-cai", "2daxo-giaaa-aaaap-anvca-cai", "cpbhu-5iaaa-aaaad-aalta-cai"].map((id, i) =>
    row(id, `CycleOps Blackhole v${i + 1}`, "burn", "read_state: empty controller list, so its code is immutable; CycleOps documents it as its balance checker blackhole", { origin: "seed", url: "https://cycleops.dev" })),
];

export const OTHER_SEEDS: LabelRow[] = [
  row("2vxsx-fae", "Anonymous principal", "other", "IC interface specification: 2vxsx-fae is the anonymous principal. Anyone can act as it, so funds held here can be taken by anyone", { origin: "seed" }),
];

/** DEX canisters we name ourselves. They are only labeled when the named SNS root lists them as registered dapps in the same run. */
export const DEX_DAPPS: Record<string, { name: string; url: string }> = {
  "4mmnk-kiaaa-aaaag-qbllq-cai": { name: "ICPSwap Swap Factory", url: "https://www.icpswap.com" },
  "2ipq2-uqaaa-aaaar-qailq-cai": { name: "KongSwap", url: "https://www.kongswap.io" },
};

const MINTER_NAMES: Record<string, string> = { "mqygn-kiaaa-aaaar-qaadq-cai": "ckBTC Minter", "sv3dd-oaaaa-aaaar-qacoa-cai": "ckETH Minter" };

// ---- SNS ----------------------------------------------------------------------------------------------------------------

export interface SnsFacts {
  /** Ledger canister id: the token id in the registry. */
  token_id: string; name: string; symbol: string;
  canisters: SnsCanisters;
  /** Where `canisters` came from, e.g. "SNS-W list_deployed_snses and SNS root list_sns_canisters". */
  source: string;
  /** Registry labels for dapp canisters, e.g. "OpenChat Dapp #3". */
  dappNames?: Map<string, string>;
}

/** The token treasury account of an SNS: governance principal plus the "token-distribution" subaccount, as ICRC-1 text. */
export async function snsTokenTreasury(governance: string): Promise<string> {
  return encodeIcrcAccount(governance, await treasurySubaccount(Principal.fromText(governance).toUint8Array()));
}

export async function snsLabels(f: SnsFacts): Promise<LabelRow[]> {
  const c = f.canisters;
  const name = cleanText(f.name, 60) || f.symbol;
  const base = { token_id: f.token_id };
  const out: LabelRow[] = [];
  if (c.root) out.push(row(c.root, `${name} SNS Root`, "sns_root", f.source, base));
  if (c.governance) {
    out.push(row(c.governance, `${name} Governance`, "sns_governance", `${f.source}. Its default account on the ICP ledger is the DAO's ICP treasury; neuron stakes sit in its subaccounts`, base));
    out.push(row(accountIdHex(c.governance), `${name} Treasury (ICP)`, "sns_treasury", `ICP account identifier of the governance canister's default account, which SNS governance uses as the ICP treasury. Governance id: ${f.source}`, { ...base, owner: c.governance }));
    out.push(row(await snsTokenTreasury(c.governance), `${name} Treasury (${f.symbol})`, "sns_treasury", `Governance canister subaccount sha256(0x12 "token-distribution" governance 0), which SNS governance uses as the token treasury. Governance id: ${f.source}`, { ...base, owner: c.governance }));
  }
  if (c.swap) out.push(row(c.swap, `${name} Swap`, "sns_swap", f.source, base));
  if (c.ledger) out.push(row(c.ledger, `${name} Ledger`, "ledger", f.source, base));
  if (c.index) out.push(row(c.index, `${name} Index`, "index", f.source, base));
  c.archives.forEach((id, i) => out.push(row(id, `${name} Archive${c.archives.length > 1 ? ` #${i + 1}` : ""}`, "archive", f.source, base)));
  c.dapps.forEach((id, i) => {
    const dex = DEX_DAPPS[id];
    if (dex) out.push(row(id, dex.name, "dex", `Registered dapp canister of the ${name} SNS (${f.source})`, { ...base, url: dex.url }));
    else out.push(row(id, f.dappNames?.get(id) ?? `${name} Dapp #${i + 1}`, "other", `Registered dapp canister of the ${name} SNS (${f.source})`, base));
  });
  c.extensions.forEach((id, i) => out.push(row(id, `${name} Extension #${i + 1}`, "other", `Registered extension canister of the ${name} SNS (${f.source})`, base)));
  return out;
}

// ---- registry: ledgers, indexes, archives of tokens that are not an SNS --------------------------------------------------

export interface RegistryCanister { id: string; token_id: string | null; role: string; label: string; discovered_via: string }

const VIA: Record<string, string> = {
  ledger: "Reported by the ledger canister itself (archives or ICRC-106 index principal)",
  seed: "ICPWatch seed registry, each id checked on chain (icrc1_symbol, or controller status for frozen ledgers)",
  "sns-aggregator": "SNS aggregator (DFINITY), recorded in the ICPWatch registry",
};
const ROLE_CATEGORY: Record<string, LabelCategory> = { ledger: "ledger", index: "index", archive: "archive", minter: "minter", orchestrator: "minter", root: "sns_root", governance: "sns_governance", swap: "sns_swap" };

/** Registry rows as labels. Used for non-SNS tokens, and as the fallback when an SNS root did not answer this run. */
export function registryLabels(rows: RegistryCanister[]): LabelRow[] {
  return rows.filter((c) => isCanisterId(c.id)).map((c) =>
    row(c.id, c.label, ROLE_CATEGORY[c.role] ?? "other", VIA[c.discovered_via] ?? (c.discovered_via.startsWith("dex:") ? `Self-declared ICRC-1 metadata; listed because of ${c.discovered_via.slice(4)} liquidity` : `ICPWatch registry (${c.discovered_via})`), { token_id: c.token_id }));
}

// ---- ck tokens ----------------------------------------------------------------------------------------------------------

export interface CkFacts { token_id: string; symbol: string; minting: ChainAccount | null; feeCollectors: ChainAccount[] }

export function ckLabels(tokens: CkFacts[]): LabelRow[] {
  const out: LabelRow[] = [];
  const minterOf = new Map<string, string>();
  for (const t of tokens) {
    if (!t.minting || t.minting.subaccount) continue;
    const owner = t.minting.owner;
    if (!minterOf.has(owner)) {
      minterOf.set(owner, MINTER_NAMES[owner] ?? `${t.symbol} Minter`);
      out.push(row(owner, minterOf.get(owner)!, "minter", `${t.symbol} ledger icrc1_minting_account names this canister as the only account that can mint`, { token_id: t.token_id, url: dash(owner) }));
    }
  }
  for (const t of tokens) {
    for (const fc of t.feeCollectors) {
      if (!fc.subaccount) continue; // a default account is the principal itself, which has (or gets) its own label
      const holder = minterOf.get(fc.owner);
      out.push(row(encodeIcrcAccount(fc.owner, fc.subaccount), `${t.symbol} fee collector${holder ? ` (${holder})` : ""}`, "minter", `${t.symbol} index canister get_fee_collectors_ranges: the ledger credits transfer fees to this account`, { token_id: t.token_id, owner: fc.owner }));
    }
  }
  return out;
}

/** The ICP ledger's minting account as an account identifier. Transfers to it are burns. */
export function icpMintingLabel(minting: ChainAccount): LabelRow {
  return row(accountIdHex(minting.owner, minting.subaccount), "ICP minting account (NNS Governance)", "burn", "ICP ledger icrc1_minting_account: ICP sent to this account is burned, and all newly minted ICP comes from it", { owner: minting.owner, token_id: "ryjl3-tyaaa-aaaaa-aaaba-cai" });
}

// ---- DEX pools ------------------------------------------------------------------------------------------------------------

export function poolLabels(pools: FactoryPool[], symbols: Map<string, string>): LabelRow[] {
  const sym = (ledger: string) => symbols.get(ledger) ?? `${ledger.slice(0, 5)}...`;
  return pools.filter((p) => isCanisterId(p.canister)).map((p) => {
    const known = [p.token0, p.token1].find((t) => symbols.has(t) && t !== "ryjl3-tyaaa-aaaaa-aaaba-cai") ?? null;
    return row(p.canister, `ICPSwap ${sym(p.token0)}/${sym(p.token1)} pool`, "dex_pool", "ICPSwap swap factory (4mmnk-kiaaa-aaaag-qbllq-cai) getPools lists this canister as a pool it created", { token_id: known, url: `https://info.icpswap.com/info-swap/pool/details/${p.canister}` });
  });
}

/** Pools from the third-party info API that the factory did not confirm this run. Inferred, never verified. */
export function unconfirmedPoolLabels(rows: { id: string; symbol0: string | null; symbol1: string | null }[], confirmed: Set<string>): LabelRow[] {
  const out: LabelRow[] = [];
  for (const p of rows) {
    const id = p.id.startsWith("ICPSwap:") ? p.id.slice(8) : null;
    if (!id || confirmed.has(id) || !isCanisterId(id)) continue;
    out.push(row(id, `ICPSwap ${p.symbol0 ?? "?"}/${p.symbol1 ?? "?"} pool`, "dex_pool", "ICPSwap info API (third party). Not confirmed by the swap factory in this run", { confidence: "inferred" }));
  }
  return out;
}

// ---- known neurons --------------------------------------------------------------------------------------------------------

export function neuronLabels(list: KnownNeuron[]): LabelRow[] {
  return list.map((n) => row(`neuron:${n.id}`, n.name, "known_neuron", "NNS governance list_known_neurons: the name was registered by an adopted NNS proposal. The neuron's controller is private and is not labeled", { url: `https://dashboard.internetcomputer.org/neuron/${n.id}` }));
}

// ---- ICP account identifiers of labeled principals -----------------------------------------------------------------------

const WITH_ICP_ACCOUNT: ReadonlySet<LabelCategory> = new Set<LabelCategory>(["sns_root", "sns_swap", "minter", "dex_pool", "dex", "nns", "burn", "other", "exchange", "foundation", "team", "bridge"]);

/**
 * The ICP ledger shows account identifiers, not principals, so every labeled principal that can plausibly hold ICP
 * also gets its default account identifier labeled with the same name. SNS governance is handled in snsLabels
 * (its default ICP account is the treasury). Ledgers, indexes, and archives are skipped: they never hold ICP.
 */
export function icpAccountLabels(rows: LabelRow[]): LabelRow[] {
  const out: LabelRow[] = [];
  for (const r of rows) {
    if (!WITH_ICP_ACCOUNT.has(r.category) || r.owner || r.id.includes(".") || r.id.startsWith("neuron:") || /^[0-9a-f]{64}$/.test(r.id)) continue;
    try {
      out.push({ ...r, id: accountIdHex(r.id), owner: r.id, source: cleanText(`Default ICP account identifier of ${r.id}, derived from the principal. ${r.source}`, 300) });
    } catch { /* not a principal */ }
  }
  return out;
}
