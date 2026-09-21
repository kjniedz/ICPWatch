import { describe, expect, it } from "vitest";
import { accountIdHex, classifyInput, crc32, encodeIcrcAccount, isValidAccountId, parseIcrcAccount, shortAccount, subaccount32, toHex } from "../src/lib/account";

const ANON = "2vxsx-fae";
const ANON_ACCOUNT = "1c7a48ba6a562aa9eaa2481a9049cdf0433b9738c992d698c31d8abf89cadc79";
const OC_GOV = "2jvtu-yqaaa-aaaaq-aaama-cai";
const OC_TREASURY_SUB = "d1216f443ead88f8f98a80b2ea59697726f18dffaa58d0a0156d0c605a01b672";

describe("crc32", () => {
  it("matches the IEEE check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("account identifiers", () => {
  it("derives the anonymous principal's default account", () => {
    expect(accountIdHex(ANON)).toBe(ANON_ACCOUNT);
    expect(accountIdHex(ANON, new Uint8Array(32))).toBe(ANON_ACCOUNT);
  });
  it("derives the OpenChat governance ICP treasury account (as published by DFINITY's SNS API)", () => {
    expect(accountIdHex(OC_GOV)).toBe("a2200978cf15fa0d19b7c7eb75cc5d6d3ebabbacaec64a2a9a3f811277619c57");
  });
  it("a subaccount changes the identifier and short hex is left padded", () => {
    expect(accountIdHex(ANON, "01")).not.toBe(ANON_ACCOUNT);
    expect(accountIdHex(ANON, "1")).toBe(accountIdHex(ANON, `${"00".repeat(31)}01`));
    expect(toHex(subaccount32("ff")!)).toBe(`${"00".repeat(31)}ff`);
    expect(subaccount32("00".repeat(33))).toBeNull();
  });
  it("validates the CRC32 prefix", () => {
    expect(isValidAccountId(ANON_ACCOUNT)).toBe(true);
    expect(isValidAccountId(ANON_ACCOUNT.toUpperCase())).toBe(true);
    expect(isValidAccountId(`0${ANON_ACCOUNT.slice(1)}`)).toBe(false);
    expect(isValidAccountId(ANON_ACCOUNT.slice(2))).toBe(false);
    expect(isValidAccountId("zz".repeat(32))).toBe(false);
  });
});

describe("ICRC-1 textual accounts", () => {
  // Vectors from the ICRC-1 TextualEncoding spec.
  const OWNER = "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae";
  it("encodes and parses the spec vectors", () => {
    expect(encodeIcrcAccount(OWNER)).toBe(OWNER);
    expect(encodeIcrcAccount(OWNER, "01")).toBe(`${OWNER}-6cc627i.1`);
    const full = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    expect(encodeIcrcAccount(OWNER, full)).toBe(`${OWNER}-dfxgiyy.102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20`);
    const parsed = parseIcrcAccount(`${OWNER}-6cc627i.1`);
    expect(parsed?.owner).toBe(OWNER);
    expect(toHex(parsed!.subaccount!)).toBe(`${"00".repeat(31)}01`);
  });
  it("round trips the OpenChat SNS treasury account", () => {
    const text = `${OC_GOV}-t6mekta.${OC_TREASURY_SUB}`;
    expect(encodeIcrcAccount(OC_GOV, OC_TREASURY_SUB)).toBe(text);
    expect(toHex(parseIcrcAccount(text)!.subaccount!)).toBe(OC_TREASURY_SUB);
  });
  it("rejects a bad checksum, a non canonical subaccount, and junk", () => {
    expect(parseIcrcAccount(`${OWNER}-6cc627j.1`)).toBeNull();
    expect(parseIcrcAccount(`${OWNER}-6cc627i.01`)).toBeNull();
    expect(parseIcrcAccount(`${OWNER}.1`)).toBeNull();
    expect(parseIcrcAccount("hello")).toBeNull();
    expect(parseIcrcAccount(OWNER)).toEqual({ owner: OWNER, subaccount: null });
  });
});

describe("classifyInput", () => {
  it("recognizes an account identifier", () => {
    expect(classifyInput(` ${ANON_ACCOUNT.toUpperCase()} `)).toEqual({ kind: "account_id", accountId: ANON_ACCOUNT });
  });
  it("flags 64 hex that is not an account (likely a transaction hash)", () => {
    expect(classifyInput("ab".repeat(32))).toEqual({ kind: "hex64", hex: "ab".repeat(32) });
  });
  it("recognizes principals and canister ids and derives the account", () => {
    expect(classifyInput(ANON)).toEqual({ kind: "principal", principal: ANON, accountId: ANON_ACCOUNT });
    expect(classifyInput(OC_GOV).kind).toBe("principal");
  });
  it("recognizes an ICRC-1 account with a subaccount", () => {
    const r = classifyInput(`${OC_GOV}-t6mekta.${OC_TREASURY_SUB}`);
    expect(r).toEqual({ kind: "icrc_account", principal: OC_GOV, subaccount: OC_TREASURY_SUB, accountId: accountIdHex(OC_GOV, OC_TREASURY_SUB) });
  });
  it("leaves everything else alone", () => {
    expect(classifyInput("CHAT").kind).toBe("other");
    expect(classifyInput("12345").kind).toBe("other");
    expect(classifyInput("not-a-principal").kind).toBe("other");
  });
});

describe("shortAccount", () => {
  it("shortens each identifier style", () => {
    expect(shortAccount(ANON_ACCOUNT)).toBe("1c7a48ba6a...89cadc79");
    expect(shortAccount(OC_GOV)).toBe("2jvtu-yqaaa...cai");
    expect(shortAccount(ANON)).toBe(ANON);
  });
});
