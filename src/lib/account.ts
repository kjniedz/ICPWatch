// ICP account identifiers and ICRC-1 textual accounts. Pure: no network, no bindings.
//
//   account identifier = crc32_be(h) || h,  h = sha224("\x0Aaccount-id" || principal_bytes || subaccount32)
//   ICRC-1 text        = <principal>                                   (default subaccount)
//                      = <principal>-<base32(crc32_be(principal || subaccount32))>.<subaccount hex, leading zeros trimmed>
import { sha224 } from "@noble/hashes/sha2.js";
import { Principal } from "@icp-sdk/core/principal";

const DOMAIN = new TextEncoder().encode("\x0Aaccount-id");
const ZERO32 = new Uint8Array(32);

let table: Uint32Array | null = null;
const crcTable = (): Uint32Array => {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
};

/** CRC-32 (IEEE), as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const be32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Normalizes a subaccount given as bytes or hex (any length up to 32 bytes) to exactly 32 bytes, left padded. Null when malformed. */
export function subaccount32(sub: Uint8Array | string | null | undefined): Uint8Array | null {
  if (sub == null) return ZERO32;
  const raw = typeof sub === "string" ? fromHex(sub.length % 2 ? `0${sub}` : sub) : sub;
  if (!raw || raw.length > 32) return null;
  if (raw.length === 32) return raw;
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length);
  return out;
}

export const isDefaultSubaccount = (sub: Uint8Array | null | undefined): boolean => !sub || sub.every((b) => b === 0);

/** The 32-byte ICP account identifier for a principal and subaccount. */
export function accountIdBytes(principal: Uint8Array, subaccount?: Uint8Array | null): Uint8Array {
  const sub = subaccount32(subaccount);
  if (!sub) throw new Error("subaccount must be at most 32 bytes");
  const h = sha224(concat(DOMAIN, principal, sub));
  return concat(be32(crc32(h)), h);
}

/** Hex ICP account identifier for a principal in text form. Throws on a malformed principal or subaccount. */
export function accountIdHex(owner: string, subaccount?: Uint8Array | string | null): string {
  const sub = subaccount32(subaccount);
  if (!sub) throw new Error("subaccount must be at most 32 bytes of hex");
  return toHex(accountIdBytes(Principal.fromText(owner).toUint8Array(), sub));
}

/** True when the text is 64 hex characters whose first four bytes are the CRC32 of the remaining 28. */
export function isValidAccountId(text: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(text)) return false;
  const b = fromHex(text)!;
  const want = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  return crc32(b.subarray(4)) === want;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1; // keep only the unread bits so the accumulator never overflows
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export interface IcrcAccount { owner: string; subaccount: Uint8Array | null }

/** ICRC-1 textual encoding. The default subaccount encodes as the bare principal. */
export function encodeIcrcAccount(owner: string, subaccount?: Uint8Array | string | null): string {
  const sub = subaccount32(subaccount);
  if (!sub) throw new Error("subaccount must be at most 32 bytes of hex");
  if (isDefaultSubaccount(sub)) return owner;
  const checksum = base32(be32(crc32(concat(Principal.fromText(owner).toUint8Array(), sub))));
  return `${owner}-${checksum}.${toHex(sub).replace(/^0+/, "")}`;
}

/**
 * Parses an ICRC-1 textual account. Accepts a bare principal (default subaccount) or the
 * `<principal>-<checksum>.<subaccount hex>` form, and verifies the checksum. Null when invalid.
 */
export function parseIcrcAccount(text: string): IcrcAccount | null {
  const s = text.trim();
  const dot = s.indexOf(".");
  if (dot < 0) {
    try { return { owner: Principal.fromText(s).toText(), subaccount: null }; } catch { return null; }
  }
  const head = s.slice(0, dot).toLowerCase();
  const subHex = s.slice(dot + 1).toLowerCase();
  // The spec requires a non-empty, canonical subaccount: no leading zeros, at most 64 hex characters.
  if (!/^[0-9a-f]{1,64}$/.test(subHex) || subHex.startsWith("0")) return null;
  const dash = head.lastIndexOf("-");
  if (dash < 0) return null;
  const owner = head.slice(0, dash);
  const checksum = head.slice(dash + 1);
  const sub = subaccount32(subHex);
  if (!sub) return null;
  try {
    const p = Principal.fromText(owner);
    if (base32(be32(crc32(concat(p.toUint8Array(), sub)))) !== checksum) return null;
    return { owner: p.toText(), subaccount: sub };
  } catch {
    return null;
  }
}

export type AccountInput =
  | { kind: "account_id"; accountId: string }
  | { kind: "principal"; principal: string; accountId: string }
  | { kind: "icrc_account"; principal: string; subaccount: string; accountId: string }
  /** 64 hex characters that fail the CRC32 check: a transaction hash or a typo, not an account. */
  | { kind: "hex64"; hex: string }
  | { kind: "other" };

/** Classifies a search box or URL input. Everything account-like comes back with its ICP account identifier. */
export function classifyInput(raw: string): AccountInput {
  const s = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return isValidAccountId(s) ? { kind: "account_id", accountId: s.toLowerCase() } : { kind: "hex64", hex: s.toLowerCase() };
  if (s.length < 5 || s.length > 140 || !s.includes("-")) return { kind: "other" };
  const acc = parseIcrcAccount(s);
  if (!acc) return { kind: "other" };
  const accountId = toHex(accountIdBytes(Principal.fromText(acc.owner).toUint8Array(), acc.subaccount));
  if (isDefaultSubaccount(acc.subaccount)) return { kind: "principal", principal: acc.owner, accountId };
  return { kind: "icrc_account", principal: acc.owner, subaccount: toHex(acc.subaccount!), accountId };
}

/** 1c7a48ba6a56...89cadc79, for table cells. Principals keep the shortId style used elsewhere. */
export function shortAccount(id: string): string {
  if (/^[0-9a-f]{64}$/i.test(id)) return `${id.slice(0, 10)}...${id.slice(-8)}`;
  const dot = id.indexOf(".");
  if (dot > 0) {
    const p = id.slice(0, dot).split("-");
    return `${p[0]}-${p[1]}...${id.slice(dot, dot + 9)}`;
  }
  const p = id.split("-");
  return p.length > 3 ? `${p[0]}-${p[1]}...${p[p.length - 1]}` : id;
}
