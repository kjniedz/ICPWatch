// Offline derivation of the native addresses a minter canister controls.
//
// Chain-key minters sign with the IC's threshold ECDSA key "key_1". The public key of a canister,
// and of every derivation path under it, is a deterministic function of three public inputs: the
// master public key, the canister id, and the path. So anyone can recompute, without asking the
// minter, which Bitcoin or Ethereum address belongs to it. We use that to prove that the reserve
// addresses shown on the page really are controlled by the minter canister (and therefore by the
// NNS), instead of taking the minter's dashboard at its word.
//
// Verified live on 2026-09-21: this reproduces the ckBTC main address
// bc1q0jrxz4jh59t5qsu7l0y59kpfdmgjcq60wlee3h and the ckETH minter address
// 0xb25eA1D493B49a1DeD42aC5B1208cC618f9A9B80 exactly.
//
// The derivation is the IC's generalization of BIP-32 public derivation (unhardened, arbitrary
// length path elements), as implemented in ic-secp256k1 `derive_subkey`.
import { Principal } from "@icp-sdk/core/principal";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** Master public key of the IC mainnet threshold ECDSA key "key_1" (secp256k1, compressed). Public, fixed for the life of the key. */
export const KEY_1_MASTER_PUBKEY = "02121bc3a5c38f38ca76487c72007ebbfd34bc6c4cb80a671655aa94585bbd0a02";

const Point = secp256k1.Point;
const ORDER = Point.Fn.ORDER;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** Compressed public key (33 bytes) for `path` under `masterHex`. The first path element of a canister key is its canister id. */
export function derivePublicKey(masterHex: string, path: Uint8Array[]): Uint8Array {
  let pt = Point.fromHex(masterHex);
  let chain: Uint8Array = new Uint8Array(32);
  for (const idx of path) {
    let input: Uint8Array = pt.toBytes(true);
    for (;;) {
      const h = hmac(sha512, chain, concat(input, idx));
      const offset = BigInt(`0x${toHex(h.slice(0, 32))}`);
      const nextChain = h.slice(32);
      if (offset < ORDER) {
        const next = offset === 0n ? pt : pt.add(Point.BASE.multiply(offset));
        if (!next.is0()) { pt = next; chain = nextChain; break; }
      }
      input = concat(Uint8Array.of(1), nextChain); // astronomically unlikely retry branch, kept for fidelity
    }
  }
  return pt.toBytes(true);
}

// ---- bitcoin: P2WPKH bech32 ------------------------------------------------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

export function bech32Encode(hrp: string, witnessVersion: number, program: Uint8Array): string {
  const data = [witnessVersion];
  let acc = 0;
  let bits = 0;
  for (const b of program) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); }
    acc &= (1 << bits) - 1;
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >>> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod(hrpExpand.concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((k) => (mod >>> (5 * (5 - k))) & 31);
  return `${hrp}1${data.concat(checksum).map((d) => CHARSET[d]).join("")}`;
}

/**
 * The ckBTC minter's deposit address for an ICRC-1 account: P2WPKH of the key at path
 * [canister id, 0x01, owner principal bytes, 32 byte subaccount]. The minter's own main (change)
 * address is the deposit address of the account (minter, default subaccount).
 */
export function ckbtcAddress(minterId: string, owner: string, subaccount: Uint8Array | null, master = KEY_1_MASTER_PUBKEY): string {
  const sub = new Uint8Array(32);
  if (subaccount) sub.set(subaccount.slice(-32), 32 - Math.min(32, subaccount.length));
  const pk = derivePublicKey(master, [Principal.fromText(minterId).toUint8Array(), Uint8Array.of(1), Principal.fromText(owner).toUint8Array(), sub]);
  return bech32Encode("bc", 0, ripemd160(sha256(pk)));
}

// ---- ethereum ---------------------------------------------------------------------------------------------

/** EIP-55 checksummed address. */
export function eip55(addrLowerNo0x: string): string {
  const hash = toHex(keccak_256(new TextEncoder().encode(addrLowerNo0x)));
  return `0x${[...addrLowerNo0x].map((c, k) => (parseInt(hash[k]!, 16) >= 8 ? c.toUpperCase() : c)).join("")}`;
}

/** The Ethereum address of a canister's own threshold key (empty derivation path), as used by the ckETH minter. */
export function canisterEthAddress(canisterId: string, master = KEY_1_MASTER_PUBKEY): string {
  const pk = derivePublicKey(master, [Principal.fromText(canisterId).toUint8Array()]);
  const uncompressed = Point.fromHex(toHex(pk)).toBytes(false);
  return eip55(toHex(keccak_256(uncompressed.slice(1)).slice(12)));
}
