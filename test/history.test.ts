import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { describe, expect, it } from "vitest";
import { decodeCanisterInfo } from "../src/collectors/history";
import { diffControllers, parseOrigin, securityEvents, shortHash, timeline, type HistoryEntry, type HistoryRow } from "../src/lib/history";

const C = "xevnm-gaaaa-aaaar-qafnq-cai";
const ROOT = "r7inp-6aaaa-aaaaa-aaabq-cai";
const LSO = "vxkom-oyaaa-aaaar-qafda-cai";
const EVIL = "2vxsx-fae";
const H1 = "aa".repeat(32), H2 = "bb".repeat(32);

const entry = (v: number, kind: HistoryEntry["kind"], extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  canister_id: C, canister_version: v, ts: 1_700_000_000 + v, kind, module_hash: null, controllers: null, origin: `canister:${LSO}`, ...extra,
});
const row = (e: HistoryEntry): HistoryRow => ({ ...e, controllers: e.controllers ? JSON.stringify(e.controllers) : null });

describe("diffControllers", () => {
  it("reports added and removed, ignoring order", () => {
    expect(diffControllers([ROOT, LSO], [LSO, ROOT])).toEqual({ added: [], removed: [] });
    expect(diffControllers([ROOT, LSO], [ROOT, EVIL])).toEqual({ added: [EVIL], removed: [LSO] });
    expect(diffControllers(null, [ROOT])).toEqual({ added: [ROOT], removed: [] });
  });
});

describe("securityEvents", () => {
  const prev = { moduleHash: H1, controllers: [ROOT, LSO] };

  it("never fires without a baseline (first backfill)", () => {
    expect(securityEvents(null, [entry(1, "install", { module_hash: H1 }), entry(2, "controllers_change", { controllers: [EVIL] })])).toEqual([]);
  });

  it("fires module_change on an upgrade to a new hash, with who did it", () => {
    const ev = securityEvents(prev, [entry(10, "upgrade", { module_hash: H2 })]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "module_change", canister_id: C, canister_version: 10, old_module_hash: H1, new_module_hash: H2, title: "Module upgraded" });
    expect(ev[0]!.detail).toContain(LSO);
  });

  it("ignores a redeploy of the same module", () => {
    expect(securityEvents(prev, [entry(10, "upgrade", { module_hash: H1 })])).toEqual([]);
  });

  it("fires controller_change with the diff, and not when the set is unchanged", () => {
    const ev = securityEvents(prev, [entry(11, "controllers_change", { controllers: [LSO, ROOT] }), entry(12, "controllers_change", { controllers: [ROOT, EVIL], origin: `user:${EVIL}` })]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "controller_change", canister_version: 12, added: [EVIL], removed: [LSO] });
  });

  it("replays in version order, so an add and a revert between two reads both show", () => {
    const ev = securityEvents(prev, [entry(21, "controllers_change", { controllers: [ROOT, LSO] }), entry(20, "controllers_change", { controllers: [ROOT, LSO, EVIL] })]);
    expect(ev.map((e) => [e.canister_version, e.added, e.removed])).toEqual([[20, [EVIL], []], [21, [], [EVIL]]]);
  });

  it("flags blackholing and uninstall", () => {
    const ev = securityEvents(prev, [entry(30, "controllers_change", { controllers: [] }), entry(31, "uninstall")]);
    expect(ev[0]!.title).toMatch(/immutable/);
    expect(ev[1]).toMatchObject({ type: "module_change", new_module_hash: null, title: "Code uninstalled" });
  });

  it("does not guess when the previous controllers are unknown", () => {
    expect(securityEvents({ moduleHash: H1, controllers: null }, [entry(40, "controllers_change", { controllers: [ROOT] })])).toEqual([]);
  });
});

describe("timeline", () => {
  it("is newest first with old to new hashes and controller diffs", () => {
    const rows = [
      entry(0, "creation", { controllers: [ROOT, LSO] }), entry(1, "install", { module_hash: H1 }), entry(5, "upgrade", { module_hash: H2 }),
      entry(6, "upgrade", { module_hash: H2 }), entry(7, "controllers_change", { controllers: [ROOT], origin: `user:${EVIL}` }),
    ].map(row);
    const tl = timeline([...rows].reverse());
    expect(tl.map((t) => t.canister_version)).toEqual([7, 6, 5, 1, 0]);
    expect(tl[0]).toMatchObject({ kind: "controllers_change", added: [], removed: [LSO], diffed: true, origin: { type: "user", id: EVIL } });
    expect(tl[1]!.title).toBe("Upgraded with the same module");
    expect(tl[2]).toMatchObject({ old_module_hash: H1, new_module_hash: H2, title: "Module upgraded" });
    expect(tl[3]!.old_module_hash).toBeUndefined();
    expect(tl[4]).toMatchObject({ kind: "creation", controllers: [ROOT, LSO] });
  });
  it("marks a controller change as not diffed when the earlier set fell off the 20 change window", () => {
    expect(timeline([row(entry(9, "controllers_change", { controllers: [ROOT] }))])[0]).toMatchObject({ diffed: false, controllers: [ROOT] });
  });
});

describe("helpers", () => {
  it("parses origins and shortens hashes", () => {
    expect(parseOrigin(`canister:${LSO}`)).toEqual({ type: "canister", id: LSO });
    expect(parseOrigin(null)).toBeNull();
    expect(shortHash(H1)).toBe("aaaaaaaaaa...aaaaaa");
    expect(shortHash(null)).toBe("none");
  });
});

describe("decodeCanisterInfo", () => {
  const Origin = IDL.Variant({ from_user: IDL.Record({ user_id: IDL.Principal }), from_canister: IDL.Record({ canister_id: IDL.Principal, canister_version: IDL.Opt(IDL.Nat64) }) });
  const result = (details: IDL.Type) => IDL.Record({
    total_num_changes: IDL.Nat64, module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)), controllers: IDL.Vec(IDL.Principal),
    recent_changes: IDL.Vec(IDL.Record({ timestamp_nanos: IDL.Nat64, canister_version: IDL.Nat64, origin: Origin, details })),
  });
  const origin = { from_canister: { canister_id: Principal.fromText(LSO), canister_version: [] } };
  const hash = new Uint8Array(32).fill(0xaa);

  it("decodes the documented shape, including extra fields added upstream", () => {
    const Details = IDL.Variant({
      creation: IDL.Record({ controllers: IDL.Vec(IDL.Principal), environment_variables_hash: IDL.Opt(IDL.Vec(IDL.Nat8)) }),
      code_deployment: IDL.Record({ mode: IDL.Variant({ install: IDL.Null, reinstall: IDL.Null, upgrade: IDL.Null }), module_hash: IDL.Vec(IDL.Nat8) }),
      load_snapshot: IDL.Record({ snapshot_id: IDL.Vec(IDL.Nat8), taken_at_timestamp: IDL.Nat64 }),
    });
    const bytes = IDL.encode([result(Details)], [{
      total_num_changes: 3n, module_hash: [hash], controllers: [Principal.fromText(ROOT)],
      recent_changes: [
        { timestamp_nanos: 1_716_361_235_786_342_308n, canister_version: 0n, origin, details: { creation: { controllers: [Principal.fromText(ROOT)], environment_variables_hash: [] } } },
        { timestamp_nanos: 1_716_361_238_054_167_329n, canister_version: 1n, origin, details: { code_deployment: { mode: { upgrade: null }, module_hash: hash } } },
        { timestamp_nanos: 1_716_361_239_000_000_000n, canister_version: 2n, origin, details: { load_snapshot: { snapshot_id: new Uint8Array([1, 2]), taken_at_timestamp: 5n } } },
      ],
    }]);
    const info = decodeCanisterInfo(C, new Uint8Array(bytes));
    expect(info).toMatchObject({ totalChanges: 3, moduleHash: H1, controllers: [ROOT], loose: false });
    expect(info.changes.map((c) => c.kind)).toEqual(["creation", "upgrade", "snapshot"]);
    expect(info.changes[0]).toMatchObject({ ts: 1_716_361_235, controllers: [ROOT], origin: `canister:${LSO}` });
    expect(info.changes[1]!.module_hash).toBe(H1);
  });

  it("survives a change kind it has never heard of", () => {
    const Details = IDL.Variant({ some_future_change: IDL.Record({ x: IDL.Nat }) });
    const bytes = IDL.encode([result(Details)], [{
      total_num_changes: 9n, module_hash: [], controllers: [],
      recent_changes: [{ timestamp_nanos: 1_800_000_000_000_000_000n, canister_version: 8n, origin, details: { some_future_change: { x: 1n } } }],
    }]);
    const info = decodeCanisterInfo(C, new Uint8Array(bytes));
    expect(info.loose).toBe(true);
    expect(info.changes).toEqual([{ canister_id: C, canister_version: 8, ts: 1_800_000_000, kind: "other", module_hash: null, controllers: null, origin: null }]);
  });
});
