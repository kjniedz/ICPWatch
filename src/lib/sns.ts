// SNS DAO analytics: pure helpers. No network and no bindings in here.

export type SnsProposalStatus = "open" | "rejected" | "adopted" | "executed" | "failed";

export interface ProposalFacts {
  decided: number; executed: number; failed: number;
  yes: number; no: number; total: number;
  /** Basis points. SNS defaults are 300 (3% of total voting power) and 5000 (a simple majority of votes cast). */
  minYesOfTotalBp?: number | null;
  minYesOfExercisedBp?: number | null;
}

/**
 * SNS governance does not store a status. It is derived exactly like the canister does it:
 * undecided is open, a decided proposal that did not meet both thresholds is rejected, and an
 * accepted one is executed, failed, or adopted (waiting for execution) by its timestamps.
 */
export function proposalStatus(p: ProposalFacts): SnsProposalStatus {
  if (!p.decided) return "open";
  const ofTotal = p.minYesOfTotalBp ?? 300;
  const ofExercised = p.minYesOfExercisedBp ?? 5000;
  const quorum = p.yes * 10000 >= p.total * ofTotal;
  const majority = p.yes * 10000 > (p.yes + p.no) * ofExercised;
  if (!(quorum && majority)) return "rejected";
  if (p.executed) return "executed";
  if (p.failed) return "failed";
  return "adopted";
}

export const STATUS_TEXT: Record<SnsProposalStatus, string> = {
  open: "Open for voting", rejected: "Rejected", adopted: "Adopted, waiting for execution", executed: "Executed", failed: "Adopted, execution failed",
};

/** Native SNS proposal types by the `action` id on ProposalData. Ids from 1000 up are functions the DAO registered itself. */
const ACTIONS: Record<number, string> = {
  0: "Unspecified", 1: "Motion", 2: "Nervous system parameters", 3: "Upgrade dapp canister", 4: "Add custom function", 5: "Remove custom function",
  6: "Custom function call", 7: "Upgrade SNS to next version", 8: "SNS metadata", 9: "Treasury transfer", 10: "Register dapp canisters",
  11: "Deregister dapp canisters", 12: "Mint tokens", 13: "Ledger parameters", 14: "Dapp canister settings", 15: "Advance SNS target version",
  16: "Set topics for custom functions", 17: "Register extension", 18: "Execute extension operation", 19: "Upgrade extension",
};
export const actionName = (id: number): string => ACTIONS[id] ?? (id >= 1000 ? "Custom function call" : `Action ${id}`);

export interface SnsProposal {
  id: number; title: string;
  /** Readable text, kept in `status` because the token page prints it as is. */
  status: string;
  state: SnsProposalStatus;
  type: string;
  created_at: number | null; decided_at: number | null;
  /** Share of cast votes that said yes, 0 to 1. Null when nobody voted. */
  yes_share: number | null;
  /** (yes + no) / total voting power, 0 to 1. */
  participation: number | null;
  url: string | null;
}

export interface SnsWindow {
  /** How many of the latest proposals the numbers below cover, and the time they span. */
  size: number; from_ts: number | null; to_ts: number | null;
  open: number;
  /** Accepted by vote: executed + adopted + failed. */
  passed: number; rejected: number; executed: number; adopted: number; failed: number;
  /** passed / (passed + rejected), 0 to 1. */
  pass_rate: number | null;
  /** Average of (yes + no) / total over decided proposals, 0 to 1. */
  participation_avg: number | null;
}

export function summarizeWindow(list: SnsProposal[]): SnsWindow {
  const count = (s: SnsProposalStatus) => list.filter((p) => p.state === s).length;
  const executed = count("executed"), adopted = count("adopted"), failed = count("failed"), rejected = count("rejected");
  const passed = executed + adopted + failed;
  const turnout = list.filter((p) => p.state !== "open" && p.participation != null).map((p) => p.participation!);
  const times = list.map((p) => p.created_at).filter((t): t is number => t != null);
  return {
    size: list.length, from_ts: times.length ? Math.min(...times) : null, to_ts: times.length ? Math.max(...times) : null,
    open: count("open"), passed, rejected, executed, adopted, failed,
    pass_rate: passed + rejected ? passed / (passed + rejected) : null,
    participation_avg: turnout.length ? turnout.reduce((s, v) => s + v, 0) / turnout.length : null,
  };
}

/**
 * The SNS token treasury lives in a subaccount of the governance canister:
 *   sha256(0x12 || "token-distribution" || governance_principal_bytes || u64_be(0))
 * where 0x12 is the length of the domain string. Checked byte for byte against OpenChat's get_metrics.
 */
export async function treasurySubaccount(governance: Uint8Array): Promise<Uint8Array> {
  const domain = new TextEncoder().encode("token-distribution");
  const data = new Uint8Array(1 + domain.length + governance.length + 8);
  data[0] = domain.length;
  data.set(domain, 1);
  data.set(governance, 1 + domain.length); // the trailing 8 bytes stay zero: nonce 0, big endian
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** `sns_governance_neurons_total 30610 1790011400437` from the governance canister's /metrics. */
export function parseNeuronsTotal(metricsText: string): number | null {
  const m = /^sns_governance_neurons_total(?:\{[^}]*\})?\s+([0-9.e+]+)/m.exec(metricsText);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Everything stored under kv key `sns:<ledgerId>`. The first five fields are the original SnsInfo shape. */
export interface SnsDao {
  treasury_icp: number | null; treasury_token: number | null; open_proposals: number | null; neurons: number | null;
  proposals: SnsProposal[];
  root: string; governance: string;
  neurons_source: string | null;
  price_icp_usd: number | null; price_token_usd: number | null;
  treasury_icp_usd: number | null; treasury_token_usd: number | null; treasury_usd: number | null;
  /** ICP in the treasury when the decentralization swap finalized, from get_metrics. */
  treasury_icp_original: number | null;
  window: SnsWindow;
  /** From get_metrics with a 30 day window. */
  submitted_30d: number | null; executed_30d: number | null;
  genesis_at: number | null;
  /** governance_total_potential_voting_power, in token units times the maximum bonus. */
  voting_power_total: number | null;
  /** Which reads failed this run, for example ["get_metrics"]. Empty when everything answered. */
  missing: string[];
}
