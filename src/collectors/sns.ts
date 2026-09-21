// SNS DAO collector. Runs hourly. Everything is read on chain with anonymous queries:
//   ICP treasury     icrc1_balance_of on the ICP ledger: governance principal, default subaccount
//   token treasury   icrc1_balance_of on the SNS ledger: governance principal, "token-distribution" subaccount
//   proposals        governance list_proposals (latest WINDOW, plus one page filtered to open ones)
//   30 day activity  governance get_metrics (composite query, window argument is mandatory)
//   neurons          sns_governance_neurons_total from the governance canister's /metrics endpoint
// USD values join our own market table. One kv row per SNS: `sns:<ledgerId>`.
// Dissolve and unlock pressure is NOT collected: get_metrics has no dissolve data, and list_neurons
// caps at 100 per page, so it would take hundreds of calls per DAO.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import type { Env } from "../env";
import { EM_DASH, now } from "../lib/format";
import { ICP_LEDGER, getAgent, pool } from "../lib/ic";
import { STATUS_TEXT, actionName, parseNeuronsTotal, proposalStatus, summarizeWindow, treasurySubaccount, type SnsDao, type SnsProposal } from "../lib/sns";
import { batchAll } from "./lifeline";

/** Proposals per SNS used for pass and fail counts and turnout. About 2 KB each on the wire. */
const WINDOW = 40;
const SHOWN = 8;
const SOURCE = "SNS governance and ledger canisters (on chain)";

// ---- candid (minimal: record subtyping lets us skip ballots, actions, and payload renderings) ---------------------------

const govIdl: IDL.InterfaceFactory = () => {
  const Id = IDL.Record({ id: IDL.Nat64 });
  const Pct = IDL.Record({ basis_points: IDL.Opt(IDL.Nat64) });
  const Tally = IDL.Record({ no: IDL.Nat64, yes: IDL.Nat64, total: IDL.Nat64 });
  const Data = IDL.Record({
    id: IDL.Opt(Id), action: IDL.Nat64, proposal: IDL.Opt(IDL.Record({ url: IDL.Text, title: IDL.Text })), latest_tally: IDL.Opt(Tally),
    proposal_creation_timestamp_seconds: IDL.Nat64, decided_timestamp_seconds: IDL.Nat64, executed_timestamp_seconds: IDL.Nat64, failed_timestamp_seconds: IDL.Nat64,
    minimum_yes_proportion_of_total: IDL.Opt(Pct), minimum_yes_proportion_of_exercised: IDL.Opt(Pct),
  });
  // include_topics is an opt field, left out on purpose: it decodes as null on governance versions that have it.
  const List = IDL.Record({ include_reward_status: IDL.Vec(IDL.Int32), before_proposal: IDL.Opt(Id), limit: IDL.Nat32, exclude_type: IDL.Vec(IDL.Nat64), include_status: IDL.Vec(IDL.Int32) });
  const Treasury = IDL.Record({ treasury: IDL.Int32, amount_e8s: IDL.Opt(IDL.Nat64), original_amount_e8s: IDL.Opt(IDL.Nat64) });
  const Metrics = IDL.Record({
    num_recently_submitted_proposals: IDL.Opt(IDL.Nat64), num_recently_executed_proposals: IDL.Opt(IDL.Nat64), genesis_timestamp_seconds: IDL.Opt(IDL.Nat64),
    treasury_metrics: IDL.Opt(IDL.Vec(Treasury)), voting_power_metrics: IDL.Opt(IDL.Record({ governance_total_potential_voting_power: IDL.Opt(IDL.Nat64) })),
  });
  return IDL.Service({
    list_proposals: IDL.Func([List], [IDL.Record({ proposals: IDL.Vec(Data) })], ["query"]),
    get_metrics: IDL.Func(
      [IDL.Record({ time_window_seconds: IDL.Opt(IDL.Nat64) })],
      [IDL.Record({ get_metrics_result: IDL.Opt(IDL.Variant({ Ok: Metrics, Err: IDL.Record({ error_message: IDL.Text, error_type: IDL.Int32 }) })) })],
      ["composite_query"],
    ),
    http_request: IDL.Func(
      [IDL.Record({ url: IDL.Text, method: IDL.Text, body: IDL.Vec(IDL.Nat8), headers: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)) })],
      [IDL.Record({ body: IDL.Vec(IDL.Nat8), status_code: IDL.Nat16 })],
      ["query"],
    ),
  });
};

const ledgerIdl: IDL.InterfaceFactory = () =>
  IDL.Service({ icrc1_balance_of: IDL.Func([IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })], [IDL.Nat], ["query"]) });

type O<T> = [] | [T];
interface RawProposal {
  id: O<{ id: bigint }>; action: bigint; proposal: O<{ url: string; title: string }>; latest_tally: O<{ yes: bigint; no: bigint; total: bigint }>;
  proposal_creation_timestamp_seconds: bigint; decided_timestamp_seconds: bigint; executed_timestamp_seconds: bigint; failed_timestamp_seconds: bigint;
  minimum_yes_proportion_of_total: O<{ basis_points: O<bigint> }>; minimum_yes_proportion_of_exercised: O<{ basis_points: O<bigint> }>;
}
interface RawMetrics {
  num_recently_submitted_proposals: O<bigint>; num_recently_executed_proposals: O<bigint>; genesis_timestamp_seconds: O<bigint>;
  treasury_metrics: O<{ treasury: number; amount_e8s: O<bigint>; original_amount_e8s: O<bigint> }[]>;
  voting_power_metrics: O<{ governance_total_potential_voting_power: O<bigint> }>;
}

const num = (v: bigint | undefined | null) => (v == null ? null : Number(v));
const tsOrNull = (v: bigint) => (v > 0n ? Number(v) : null);

/** Pure: one ProposalData to the stored shape. */
export function proposalView(p: RawProposal): SnsProposal | null {
  const id = p.id[0]?.id;
  if (id == null) return null;
  const t = p.latest_tally[0];
  const yes = Number(t?.yes ?? 0n), no = Number(t?.no ?? 0n), total = Number(t?.total ?? 0n);
  const state = proposalStatus({
    decided: Number(p.decided_timestamp_seconds), executed: Number(p.executed_timestamp_seconds), failed: Number(p.failed_timestamp_seconds), yes, no, total,
    minYesOfTotalBp: num(p.minimum_yes_proportion_of_total[0]?.basis_points[0]), minYesOfExercisedBp: num(p.minimum_yes_proportion_of_exercised[0]?.basis_points[0]),
  });
  const body = p.proposal[0];
  return {
    id: Number(id), title: (body?.title ?? "").replace(EM_DASH, " - ").trim().slice(0, 200) || `Proposal ${id}`, status: STATUS_TEXT[state], state, type: actionName(Number(p.action)),
    created_at: tsOrNull(p.proposal_creation_timestamp_seconds), decided_at: tsOrNull(p.decided_timestamp_seconds),
    yes_share: yes + no > 0 ? yes / (yes + no) : null, participation: total > 0 ? (yes + no) / total : null,
    url: body?.url && /^https:\/\//.test(body.url) ? body.url.slice(0, 300) : null,
  };
}

export interface SnsTarget { ledger: string; root: string; governance: string; decimals: number }
export type SnsReading = Omit<SnsDao, "price_icp_usd" | "price_token_usd" | "treasury_icp_usd" | "treasury_token_usd" | "treasury_usd">;

/** All on-chain reads for one SNS: six queries in parallel. Returns null when nothing answered (a dead SNS). */
export async function readSns(host: string, s: SnsTarget): Promise<SnsReading | null> {
  const agent = await getAgent(host);
  const gov = Actor.createActor(govIdl, { agent, canisterId: s.governance });
  const owner = Principal.fromText(s.governance);
  const sub = await treasurySubaccount(owner.toUint8Array());
  const list = (status: number[], limit: number) => gov.list_proposals!({ include_reward_status: [], before_proposal: [], limit, exclude_type: [], include_status: status }) as Promise<{ proposals: RawProposal[] }>;

  const [icp, token, latest, open, metrics, prom] = await Promise.allSettled([
    Actor.createActor(ledgerIdl, { agent, canisterId: ICP_LEDGER }).icrc1_balance_of!({ owner, subaccount: [] }) as Promise<bigint>,
    Actor.createActor(ledgerIdl, { agent, canisterId: s.ledger }).icrc1_balance_of!({ owner, subaccount: [sub] }) as Promise<bigint>,
    list([], WINDOW),
    list([1], 100), // ProposalDecisionStatus 1 = open. 100 is the hard cap per page.
    gov.get_metrics!({ time_window_seconds: [2_592_000n] }) as Promise<{ get_metrics_result: O<{ Ok: RawMetrics } | { Err: unknown }> }>,
    gov.http_request!({ url: "/metrics", method: "GET", body: [], headers: [] }) as Promise<{ body: Uint8Array | number[]; status_code: number }>,
  ]);

  const missing: string[] = [];
  const ok = <T,>(r: PromiseSettledResult<T>, name: string): T | null => {
    if (r.status === "fulfilled") return r.value;
    missing.push(name);
    return null;
  };
  const icpBal = ok(icp, "icp_treasury");
  const tokenBal = ok(token, "token_treasury");
  const latestList = ok(latest, "list_proposals");
  const openList = ok(open, "open_proposals");
  const metricsRes = ok(metrics, "get_metrics");
  const promRes = ok(prom, "neurons");
  // The ICP ledger always answers, so "alive" means anything belonging to this SNS answered.
  if (tokenBal == null && latestList == null && metricsRes == null && promRes == null) return null;

  const m = metricsRes?.get_metrics_result[0];
  const mOk = m && "Ok" in m ? m.Ok : null;
  if (metricsRes && !mOk) missing.push("get_metrics");
  const treasuries = mOk?.treasury_metrics[0] ?? [];
  const icpMetric = treasuries.find((t) => t.treasury === 1);
  const tokenMetric = treasuries.find((t) => t.treasury === 2);

  const proposals = (latestList?.proposals ?? []).map(proposalView).filter((p): p is SnsProposal => !!p);
  const neurons = promRes && promRes.status_code === 200 ? parseNeuronsTotal(new TextDecoder().decode(promRes.body instanceof Uint8Array ? promRes.body : new Uint8Array(promRes.body))) : null;
  if (promRes && neurons == null) missing.push("neurons");
  const e8 = (v: bigint | undefined | null) => (v == null ? null : Number(v) / 1e8);

  return {
    // get_metrics carries a cached copy of both balances: use it only when a ledger read failed.
    treasury_icp: icpBal != null ? Number(icpBal) / 1e8 : e8(icpMetric?.amount_e8s[0]),
    treasury_token: tokenBal != null ? Number(tokenBal) / 10 ** s.decimals : e8(tokenMetric?.amount_e8s[0]),
    open_proposals: openList ? openList.proposals.length : latestList ? proposals.filter((p) => p.state === "open").length : null,
    neurons, neurons_source: neurons != null ? "governance canister /metrics" : null,
    proposals: proposals.slice(0, SHOWN),
    root: s.root, governance: s.governance,
    treasury_icp_original: e8(icpMetric?.original_amount_e8s[0]),
    window: summarizeWindow(proposals),
    submitted_30d: num(mOk?.num_recently_submitted_proposals[0]), executed_30d: num(mOk?.num_recently_executed_proposals[0]),
    genesis_at: num(mOk?.genesis_timestamp_seconds[0]),
    voting_power_total: e8(mOk?.voting_power_metrics[0]?.governance_total_potential_voting_power[0]),
    missing,
  };
}

export interface SnsRunStats { snses: number; written: number; dead: number; partial: number; errors: number }

export async function collectSns(env: Env): Promise<SnsRunStats> {
  const ts = now();
  const stats: SnsRunStats = { snses: 0, written: 0, dead: 0, partial: 0, errors: 0 };
  const targets = (
    await env.DB.prepare(`SELECT t.id ledger, t.sns_root root, t.decimals, g.id governance, m.price_usd
      FROM tokens t JOIN canisters g ON g.token_id = t.id AND g.role = 'governance' LEFT JOIN market m ON m.token_id = t.id
      WHERE t.kind = 'sns' AND t.sns_root IS NOT NULL GROUP BY t.id ORDER BY t.id`).all<SnsTarget & { price_usd: number | null }>()
  ).results;
  stats.snses = targets.length;
  if (!targets.length) return stats;
  const icpPrice = (await env.DB.prepare("SELECT price_usd FROM market WHERE token_id = ?").bind(ICP_LEDGER).first<{ price_usd: number | null }>())?.price_usd ?? null;

  const results = await pool(targets, 6, (t) => readSns(env.IC_HOST, t));

  const up = env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES (?, ?, ?, ?)");
  const stmts: D1PreparedStatement[] = [];
  results.forEach((r, i) => {
    const t = targets[i]!;
    if (r.status !== "fulfilled") {
      stats.errors++;
      console.warn("sns failed", t.root, String(r.reason).slice(0, 200));
      return;
    }
    // A dead SNS (frozen governance and ledger, like SEER or FUEL) keeps its last good row, which the page shows as stale.
    if (!r.value) { stats.dead++; return; }
    if (r.value.missing.length) stats.partial++;
    const icpUsd = r.value.treasury_icp != null && icpPrice != null ? r.value.treasury_icp * icpPrice : null;
    const tokenUsd = r.value.treasury_token != null && t.price_usd != null ? r.value.treasury_token * t.price_usd : null;
    const value: SnsDao = {
      ...r.value, price_icp_usd: icpPrice, price_token_usd: t.price_usd ?? null, treasury_icp_usd: icpUsd, treasury_token_usd: tokenUsd,
      treasury_usd: icpUsd == null && tokenUsd == null ? null : (icpUsd ?? 0) + (tokenUsd ?? 0),
    };
    stmts.push(up.bind(`sns:${t.ledger}`, JSON.stringify(value), SOURCE, ts));
    stats.written++;
  });
  await batchAll(env.DB, stmts, 25);
  return stats;
}
