// IC reads used only by the trust score. Read-only: one anonymous query per ledger.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "../lib/ic";

const mintingIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    icrc1_minting_account: IDL.Func([], [IDL.Opt(IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) }))], ["query"]),
  });

export interface MintingAccount { owner: string; subaccount: string | null }

const hex = (b: Uint8Array | number[]) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** icrc1_minting_account. Null means the ledger answered and has no minting account. Throws when the ledger does not answer. */
export async function mintingAccount(host: string, ledgerId: string): Promise<MintingAccount | null> {
  const a = Actor.createActor(mintingIdl, { agent: await getAgent(host), canisterId: ledgerId });
  const r = (await a.icrc1_minting_account!()) as [] | [{ owner: Principal; subaccount: [] | [Uint8Array | number[]] }];
  const acct = r[0];
  if (!acct) return null;
  const sub = acct.subaccount[0];
  const subHex = sub ? hex(sub).replace(/^0+/, "") : "";
  return { owner: acct.owner.toText(), subaccount: subHex ? subHex : null };
}
