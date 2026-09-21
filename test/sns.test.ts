import { Principal } from "@icp-sdk/core/principal";
import { describe, expect, it } from "vitest";
import { proposalView } from "../src/collectors/sns";
import { actionName, parseNeuronsTotal, proposalStatus, summarizeWindow, treasurySubaccount, type SnsProposal } from "../src/lib/sns";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("treasurySubaccount", () => {
  it("matches the subaccount OpenChat governance reports for its CHAT treasury", async () => {
    const sub = await treasurySubaccount(Principal.fromText("2jvtu-yqaaa-aaaaq-aaama-cai").toUint8Array());
    expect(hex(sub)).toBe("d1216f443ead88f8f98a80b2ea59697726f18dffaa58d0a0156d0c605a01b672");
  });
});

describe("proposalStatus", () => {
  const base = { decided: 100, executed: 0, failed: 0, yes: 60, no: 10, total: 100 };
  it("is open until decided", () => expect(proposalStatus({ ...base, decided: 0 })).toBe("open"));
  it("follows the timestamps once accepted", () => {
    expect(proposalStatus(base)).toBe("adopted");
    expect(proposalStatus({ ...base, executed: 120 })).toBe("executed");
    expect(proposalStatus({ ...base, failed: 120 })).toBe("failed");
  });
  it("rejects on a lost majority or a missed quorum (defaults 50% of cast, 3% of total)", () => {
    expect(proposalStatus({ ...base, yes: 10, no: 60 })).toBe("rejected");
    expect(proposalStatus({ ...base, yes: 50, no: 50 })).toBe("rejected");
    expect(proposalStatus({ ...base, yes: 2, no: 0 })).toBe("rejected");
    expect(proposalStatus({ ...base, yes: 3, no: 0 })).toBe("adopted");
  });
  it("applies critical proposal thresholds: live OpenChat proposal 2376 was rejected with 94.7% yes", () => {
    const p = { decided: 1790005588, executed: 0, failed: 0, yes: 1060865110416307, no: 58992791892060, total: 6544899752695593 };
    expect(proposalStatus({ ...p, minYesOfTotalBp: 2000, minYesOfExercisedBp: 6700 })).toBe("rejected");
    expect(proposalStatus(p)).toBe("adopted");
  });
});

describe("proposalView", () => {
  const raw = {
    id: [{ id: 2380n }] as [{ id: bigint }], action: 3n, proposal: [{ url: "javascript:alert(1)", title: `  Upgrade${String.fromCharCode(0x2014)}canister ` }] as [{ url: string; title: string }],
    latest_tally: [{ yes: 80n, no: 20n, total: 200n }] as [{ yes: bigint; no: bigint; total: bigint }],
    proposal_creation_timestamp_seconds: 1000n, decided_timestamp_seconds: 2000n, executed_timestamp_seconds: 2100n, failed_timestamp_seconds: 0n,
    minimum_yes_proportion_of_total: [] as [], minimum_yes_proportion_of_exercised: [] as [],
  };
  it("maps a ProposalData to the stored shape", () => {
    expect(proposalView(raw)).toEqual({
      id: 2380, title: "Upgrade - canister", status: "Executed", state: "executed", type: "Upgrade dapp canister", created_at: 1000, decided_at: 2000,
      yes_share: 0.8, participation: 0.5, url: null,
    });
  });
  it("skips a proposal without an id and names untitled ones", () => {
    expect(proposalView({ ...raw, id: [] })).toBeNull();
    expect(proposalView({ ...raw, proposal: [] })?.title).toBe("Proposal 2380");
  });
});

describe("summarizeWindow", () => {
  const p = (id: number, state: SnsProposal["state"], participation: number | null): SnsProposal => ({
    id, title: "t", status: state, state, type: "Motion", created_at: 1000 + id, decided_at: null, yes_share: null, participation, url: null,
  });
  it("counts outcomes and averages turnout over decided proposals only", () => {
    const w = summarizeWindow([p(5, "open", 0.9), p(4, "executed", 0.6), p(3, "rejected", 0.2), p(2, "failed", 0.4), p(1, "adopted", null)]);
    expect(w).toMatchObject({ size: 5, open: 1, passed: 3, executed: 1, adopted: 1, failed: 1, rejected: 1, from_ts: 1001, to_ts: 1005 });
    expect(w.pass_rate).toBeCloseTo(0.75);
    expect(w.participation_avg).toBeCloseTo(0.4);
  });
  it("is all nulls for an empty list", () => {
    expect(summarizeWindow([])).toMatchObject({ size: 0, pass_rate: null, participation_avg: null, from_ts: null });
  });
});

describe("small helpers", () => {
  it("parses the neuron total from /metrics", () => {
    expect(parseNeuronsTotal("# HELP x\n# TYPE x gauge\nsns_governance_neurons_total 30610 1790011400437\nother 1 2\n")).toBe(30610);
    expect(parseNeuronsTotal("nothing here")).toBeNull();
  });
  it("names proposal types", () => {
    expect(actionName(9)).toBe("Treasury transfer");
    expect(actionName(4003)).toBe("Custom function call");
    expect(actionName(77)).toBe("Action 77");
  });
});
