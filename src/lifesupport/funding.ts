// Life support funded path: ICP ledger transfer to the cycles minting canister, then notify_top_up.
//
// NOTHING in this file runs unless the engine's live gate is fully open (see liveGate in engine.ts):
// env LIFE_SUPPORT_ENABLED === "true", a funding identity secret is present, the DB kill switch is
// off, and the spend was reserved against the global cap and the canister budget in one D1
// transaction. The default for every deployment is OFF.
//
// Candid verified against the LIVE canisters' `candid:service` metadata (anonymous read_state via
// CanisterStatus.request, 2026-09-21):
//   ICP ledger ryjl3-tyaaa-aaaaa-aaaba-cai (module 51f4be01...):
//     icrc1_transfer : (TransferArg) -> (variant { Ok : nat; Err : Icrc1TransferError })
//     TransferArg = record { from_subaccount : opt blob; to : Account; amount : nat; fee : opt nat; memo : opt blob; created_at_time : opt nat64 }
//     Account = record { owner : principal; subaccount : opt blob }
//     icrc1_fee = 10_000 e8s (queried live)
//   CMC rkp4c-7iaaa-aaaaa-aaaca-cai (module c5e9adf7...):
//     notify_top_up : (record { block_index : nat64; canister_id : principal }) -> (variant { Ok : nat; Err : NotifyError })
//     NotifyError = variant { Refunded : record { reason : text; block_index : opt nat64 }; Processing; TransactionTooOld : nat64;
//                             InvalidTransaction : text; Other : record { error_code : nat64; error_message : text } }
//     get_icp_xdr_conversion_rate : () -> (record { data : record { timestamp_seconds : nat64; xdr_permyriad_per_icp : nat64 }; ... }) query
// From the CMC source (rs/nns/cmc): the payment is recognized by memo 0x50555054 ("TPUP"), either as the
// legacy nat64 memo or as an 8 byte little-endian icrc1 memo (get_u64_memo), sent to the CMC account with
// subaccount = [len(principal)] ++ principal bytes, zero padded to 32. Minted cycles = e8s * xdr_permyriad_per_icp.
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { CMC, ICP_LEDGER } from "../lib/ic";
import { ICP_FEE_E8S } from "./planner";

export const TPUP_MEMO = 0x50555054n;

/** 8 byte little-endian encoding of the TPUP memo: the bytes "TPUP" followed by four zeros. */
export function topUpMemo(): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, TPUP_MEMO, true);
  return out;
}

/** CMC subaccount for a target canister: length byte, principal bytes, zero padding to 32. */
export function topUpSubaccount(canisterId: string): Uint8Array {
  const bytes = Principal.fromText(canisterId).toUint8Array();
  if (bytes.length > 31) throw new Error("principal too long for a subaccount");
  const out = new Uint8Array(32);
  out[0] = bytes.length;
  out.set(bytes, 1);
  return out;
}

/** Accepts a 32 byte Ed25519 seed as 64 hex characters or as base64. Never logged, never stored. */
export function parseSeed(secret: string): Uint8Array {
  const s = secret.trim();
  let bytes: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(s)) bytes = Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
  else {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  if (bytes.length !== 32) throw new Error("LIFE_SUPPORT_IDENTITY must be a 32 byte Ed25519 seed (64 hex characters or base64)");
  return bytes;
}

export const identityFromSecret = (secret: string) => Ed25519KeyIdentity.fromSecretKey(parseSeed(secret));
export const fundingPrincipal = (secret: string) => identityFromSecret(secret).getPrincipal().toText();

const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);

// ---- read-only ---------------------------------------------------------------------------------------

const cmcQueryIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    get_icp_xdr_conversion_rate: IDL.Func([], [IDL.Record({ data: IDL.Record({ timestamp_seconds: IDL.Nat64, xdr_permyriad_per_icp: IDL.Nat64 }) })], ["query"]),
  });

export interface XdrRate { xdrPermyriadPerIcp: number; ts: number }

/**
 * The rate the CMC will use to mint (it uses its current rate, not the 30 day average). Anonymous query.
 * Query signatures are verified here because this number sizes a payment.
 */
export async function fetchXdrRate(host: string): Promise<XdrRate> {
  const agent = await HttpAgent.create({ host, fetch: fetchFn, shouldFetchRootKey: false, verifyQuerySignatures: true, retryTimes: 2 });
  const cmc = Actor.createActor(cmcQueryIdl, { agent, canisterId: CMC });
  const res = (await cmc.get_icp_xdr_conversion_rate!()) as { data: { timestamp_seconds: bigint; xdr_permyriad_per_icp: bigint } };
  const rate = Number(res.data.xdr_permyriad_per_icp);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("CMC returned an unusable conversion rate");
  return { xdrPermyriadPerIcp: rate, ts: Number(res.data.timestamp_seconds) };
}

// ---- signed calls (live gate only) -----------------------------------------------------------------------

const Account = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
const Icrc1TransferError = IDL.Variant({
  BadFee: IDL.Record({ expected_fee: IDL.Nat }),
  BadBurn: IDL.Record({ min_burn_amount: IDL.Nat }),
  InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
  TooOld: IDL.Null,
  CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
  TemporarilyUnavailable: IDL.Null,
  Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
  GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }),
});
const ledgerIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    icrc1_transfer: IDL.Func(
      [IDL.Record({ from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)), to: Account, amount: IDL.Nat, fee: IDL.Opt(IDL.Nat), memo: IDL.Opt(IDL.Vec(IDL.Nat8)), created_at_time: IDL.Opt(IDL.Nat64) })],
      [IDL.Variant({ Ok: IDL.Nat, Err: Icrc1TransferError })],
      [],
    ),
  });
const NotifyError = IDL.Variant({
  Refunded: IDL.Record({ reason: IDL.Text, block_index: IDL.Opt(IDL.Nat64) }),
  Processing: IDL.Null,
  TransactionTooOld: IDL.Nat64,
  InvalidTransaction: IDL.Text,
  Other: IDL.Record({ error_code: IDL.Nat64, error_message: IDL.Text }),
});
const cmcIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    notify_top_up: IDL.Func([IDL.Record({ block_index: IDL.Nat64, canister_id: IDL.Principal })], [IDL.Variant({ Ok: IDL.Nat, Err: NotifyError })], []),
  });

export type TransferOutcome =
  | { kind: "ok"; blockIndex: number }
  /** The ledger answered with an error: no ICP moved. The reservation can be released. */
  | { kind: "failed"; reason: string }
  /** No definite answer (timeout, network). ICP may have moved: never release, always alert. */
  | { kind: "unknown"; reason: string };

export type NotifyOutcome =
  | { kind: "ok"; mintedCycles: number }
  | { kind: "refunded"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "unknown"; reason: string };

export interface Funder {
  principal(): string;
  /** Moves real ICP. createdAtNs makes retries idempotent: the ledger deduplicates identical transfers for 24 h. */
  transfer(a: { canisterId: string; e8s: number; createdAtNs: bigint }): Promise<TransferOutcome>;
  /** Permissionless and idempotent per block index. */
  notify(a: { canisterId: string; blockIndex: number }): Promise<NotifyOutcome>;
}

const str = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)).slice(0, 400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Builds the signing funder. Call only after the live gate has passed. */
export function createFunder(host: string, secret: string): Funder {
  const identity = identityFromSecret(secret);
  let agent: Promise<HttpAgent> | null = null;
  const getAgent = () => (agent ??= HttpAgent.create({ host, identity, fetch: fetchFn, shouldFetchRootKey: false, retryTimes: 0 }));
  return {
    principal: () => identity.getPrincipal().toText(),

    async transfer({ canisterId, e8s, createdAtNs }) {
      if (!Number.isSafeInteger(e8s) || e8s <= 0) return { kind: "failed", reason: "invalid e8s amount" };
      try {
        const ledger = Actor.createActor(ledgerIdl, { agent: await getAgent(), canisterId: ICP_LEDGER });
        const res = (await ledger.icrc1_transfer!({
          from_subaccount: [],
          to: { owner: Principal.fromText(CMC), subaccount: [topUpSubaccount(canisterId)] },
          amount: BigInt(e8s),
          fee: [BigInt(ICP_FEE_E8S)],
          memo: [topUpMemo()],
          created_at_time: [createdAtNs],
        })) as { Ok: bigint } | { Err: Record<string, unknown> };
        if ("Ok" in res) return { kind: "ok", blockIndex: Number(res.Ok) };
        const dup = (res.Err as { Duplicate?: { duplicate_of: bigint } }).Duplicate;
        if (dup) return { kind: "ok", blockIndex: Number(dup.duplicate_of) };
        return { kind: "failed", reason: json(res.Err) };
      } catch (e) {
        return { kind: "unknown", reason: str(e) };
      }
    },

    async notify({ canisterId, blockIndex }) {
      let last = "no attempt";
      for (let i = 0; i < 4; i++) {
        try {
          const cmc = Actor.createActor(cmcIdl, { agent: await getAgent(), canisterId: CMC });
          const res = (await cmc.notify_top_up!({ block_index: BigInt(blockIndex), canister_id: Principal.fromText(canisterId) })) as { Ok: bigint } | { Err: Record<string, unknown> };
          if ("Ok" in res) return { kind: "ok", mintedCycles: Number(res.Ok) };
          if ("Processing" in res.Err) {
            last = "Processing";
            await sleep(2000);
            continue;
          }
          if ("Refunded" in res.Err) return { kind: "refunded", reason: json(res.Err) };
          return { kind: "failed", reason: json(res.Err) };
        } catch (e) {
          last = str(e);
          await sleep(1500);
        }
      }
      return { kind: "unknown", reason: last };
    },
  };
}
