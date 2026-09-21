// Network collector. Runs hourly.
//   Proposals: read on chain from the NNS governance canister.
//   Subnets and headline rates: DFINITY's public IC API. Block, message, and burn rates have no
//   on-chain source, so this third-party dependency is isolated in the `icApi` adapter below.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Env } from "../env";
import { now } from "../lib/format";
import { NNS_GOVERNANCE, getAgent, pool } from "../lib/ic";
import { batchAll } from "./lifeline";

// ---- on chain: governance ---------------------------------------------------------------------------

// Hand-written minimal IDL. Candid record subtyping lets us skip the enormous Action variant:
// return_self_describing_action gives the action's type name as plain text instead.
const govIdl: IDL.InterfaceFactory = () => {
  const Id = IDL.Record({ id: IDL.Nat64 });
  const Tally = IDL.Record({ no: IDL.Nat64, yes: IDL.Nat64, total: IDL.Nat64, timestamp_seconds: IDL.Nat64 });
  const Proposal = IDL.Record({ url: IDL.Text, title: IDL.Opt(IDL.Text), summary: IDL.Text, self_describing_action: IDL.Opt(IDL.Record({ type_name: IDL.Opt(IDL.Text) })) });
  const Info = IDL.Record({
    id: IDL.Opt(Id), status: IDL.Int32, topic: IDL.Int32, proposer: IDL.Opt(Id), proposal: IDL.Opt(Proposal), latest_tally: IDL.Opt(Tally),
    deadline_timestamp_seconds: IDL.Opt(IDL.Nat64), proposal_timestamp_seconds: IDL.Nat64, decided_timestamp_seconds: IDL.Nat64, executed_timestamp_seconds: IDL.Nat64,
  });
  const Req = IDL.Record({
    include_reward_status: IDL.Vec(IDL.Int32), omit_large_fields: IDL.Opt(IDL.Bool), before_proposal: IDL.Opt(Id), limit: IDL.Nat32, exclude_topic: IDL.Vec(IDL.Int32),
    include_all_manage_neuron_proposals: IDL.Opt(IDL.Bool), include_status: IDL.Vec(IDL.Int32), return_self_describing_action: IDL.Opt(IDL.Bool),
  });
  return IDL.Service({ list_proposals: IDL.Func([Req], [IDL.Record({ proposal_info: IDL.Vec(Info) })], ["query"]) });
};

const TOPICS: Record<number, string> = {
  0: "Unspecified", 1: "Neuron management", 2: "Exchange rate", 3: "Network economics", 4: "Governance", 5: "Node admin", 6: "Participant management",
  7: "Subnet management", 8: "Application canisters", 9: "KYC", 10: "Node provider rewards", 12: "IC OS deployment", 13: "IC OS election",
  14: "SNS and Neurons Fund", 15: "API boundary nodes", 16: "Subnet rental", 17: "Protocol canisters", 18: "SNS management",
};
const STATUS: Record<number, string> = { 1: "open", 2: "rejected", 3: "adopted", 4: "executed", 5: "failed" };

interface RawInfo {
  id: [] | [{ id: bigint }]; status: number; topic: number; proposer: [] | [{ id: bigint }];
  proposal: [] | [{ url: string; title: [] | [string]; summary: string; self_describing_action: [] | [{ type_name: [] | [string] }] }];
  latest_tally: [] | [{ no: bigint; yes: bigint; total: bigint }];
  deadline_timestamp_seconds: [] | [bigint]; proposal_timestamp_seconds: bigint; decided_timestamp_seconds: bigint; executed_timestamp_seconds: bigint;
}

async function collectProposals(env: Env, pages: number): Promise<number> {
  const gov = Actor.createActor(govIdl, { agent: await getAgent(env.IC_HOST), canisterId: NNS_GOVERNANCE });
  const ts = now();
  let before: [] | [{ id: bigint }] = [];
  let count = 0;
  const up = env.DB.prepare(`INSERT OR REPLACE INTO proposals (id, topic, action, status, title, summary, url, proposer, yes, no, total, created_at, deadline_at, decided_at, executed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let page = 0; page < pages; page++) {
    const res = (await gov.list_proposals!({
      include_reward_status: [], omit_large_fields: [true], before_proposal: before, limit: 50, exclude_topic: [],
      include_all_manage_neuron_proposals: [false], include_status: [], return_self_describing_action: [true],
    })) as { proposal_info: RawInfo[] };
    if (!res.proposal_info.length) break;
    const stmts: D1PreparedStatement[] = [];
    for (const p of res.proposal_info) {
      const id = p.id[0]?.id;
      const body = p.proposal[0];
      if (id == null || !body) continue;
      const tally = p.latest_tally[0];
      const e8 = (v: bigint | undefined) => (v == null ? null : Number(v) / 1e8);
      const t = (v: bigint | undefined) => (v && v > 0n ? Number(v) : null);
      stmts.push(up.bind(
        Number(id), TOPICS[p.topic] ?? `Topic ${p.topic}`, body.self_describing_action[0]?.type_name[0] ?? null, STATUS[p.status] ?? "unknown",
        (body.title[0] ?? "").replace(/—/g, " - ").slice(0, 300), body.summary.slice(0, 60000), body.url || null, p.proposer[0] ? String(p.proposer[0].id) : null,
        e8(tally?.yes), e8(tally?.no), e8(tally?.total), t(p.proposal_timestamp_seconds), t(p.deadline_timestamp_seconds[0]), t(p.decided_timestamp_seconds), t(p.executed_timestamp_seconds), ts,
      ));
      before = [{ id }];
      count++;
    }
    await batchAll(env.DB, stmts, 25);
    if (res.proposal_info.length < 50) break;
  }
  return count;
}

// ---- third party, isolated: IC public API ---------------------------------------------------------------

const IC_API = "https://ic-api.internetcomputer.org/api";

const icApi = {
  async json<T>(path: string): Promise<T | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${IC_API}${path}`, { headers: { accept: "application/json" } });
      if (res.ok) return (await res.json()) as T;
      if (res.status !== 429) return null;
      await new Promise((r) => setTimeout(r, 600)); // sporadic 429 with no Retry-After
    }
    return null;
  },
  /** Series endpoints return {"name":[[ts,"value"],...]} or sometimes a bare pair. Take the latest value. */
  async latest(path: string): Promise<number | null> {
    const body = await this.json<Record<string, unknown>>(path);
    if (!body) return null;
    const v = Object.values(body)[0];
    const last = Array.isArray(v) ? (Array.isArray(v[0]) ? v[v.length - 1] : v) : null;
    const n = Array.isArray(last) ? Number(last[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  },
};

interface ApiSubnet {
  subnet_id: string; subnet_type: string; subnet_specialization: string | null; display_name: string | null; total_nodes: number | string;
  total_canisters: number | string; memory_usage: number | string; instruction_rate: number | string; message_execution_rate: number | string;
}

const subnetLabel = (s: ApiSubnet) => {
  const spec = (s.subnet_specialization ?? "").toLowerCase();
  if (spec.includes("fiduciary")) return "Fiduciary";
  if (spec.includes("eu")) return "European";
  if (spec.includes("confidential")) return "Confidential";
  if (s.subnet_type === "system") return "System";
  if (s.subnet_type === "verified_application") return "Verified application";
  return "Application";
};

export interface NetworkRunStats { proposals: number; subnets: number; errors: number }

export async function collectNetwork(env: Env, opts: { backfill?: boolean } = {}): Promise<NetworkRunStats> {
  const ts = now();
  const stats: NetworkRunStats = { proposals: 0, subnets: 0, errors: 0 };

  try {
    const have = await env.DB.prepare("SELECT COUNT(*) n FROM proposals").first<{ n: number }>();
    stats.proposals = await collectProposals(env, opts.backfill || !have?.n ? 6 : 1);
  } catch (e) {
    stats.errors++;
    console.warn("proposals failed", String(e).slice(0, 300));
  }

  const [blockRate, canistersRunning, canistersStopped, subnetTotal, burn, nodes, providers, msgRate] = await Promise.all([
    icApi.latest("/v3/metrics/block-rate"),
    icApi.latest("/v3/metrics/registered-canisters-count?status=running"),
    icApi.latest("/v3/metrics/registered-canisters-count?status=stopped"),
    icApi.latest("/v3/metrics/ic-subnet-total"),
    icApi.latest("/v3/metrics/cycle-burn-rate"),
    icApi.latest("/v3/metrics/ic-nodes-count"),
    icApi.latest("/v3/node-providers-count"),
    icApi.latest("/v3/metrics/message-execution-rate"),
  ]);

  const list = await icApi.json<{ data?: ApiSubnet[]; subnets?: ApiSubnet[] }>("/v4/subnets?limit=100");
  const subnets = list?.data ?? list?.subnets ?? [];
  if (subnets.length) {
    const rates = await pool(subnets, 4, async (s) => ({
      burn: await icApi.latest(`/v3/metrics/cycle-burn-rate?subnet=${s.subnet_id}`),
      block: await icApi.latest(`/v3/metrics/block-rate?subnet=${s.subnet_id}`),
    }));
    const up = env.DB.prepare(`INSERT OR REPLACE INTO subnets (id, type, label, nodes, canisters, burn_per_day, block_rate, msg_rate, instr_rate, memory_bytes, replica_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
    const num = (v: number | string | null | undefined) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const stmts = subnets.map((s, i) => {
      const r = rates[i]!.status === "fulfilled" ? rates[i]!.value : { burn: null, block: null };
      return up.bind(s.subnet_id, s.subnet_type, subnetLabel(s), num(s.total_nodes), num(s.total_canisters), r.burn != null ? r.burn * 86400 : null, r.block, num(s.message_execution_rate), num(s.instruction_rate), num(s.memory_usage), ts);
    });
    await batchAll(env.DB, stmts);
    stats.subnets = subnets.length;
  } else stats.errors++;

  const canisters = canistersRunning != null ? canistersRunning + (canistersStopped ?? 0) : null;
  if (blockRate != null || canisters != null) {
    const value = {
      block_rate: blockRate, subnets: subnets.length || subnetTotal, subnets_total: subnetTotal, canisters, burn_per_day: burn != null ? burn * 86400 : null,
      nodes, node_providers: providers, tx_rate: msgRate, icp_supply: null,
    };
    await env.DB.prepare("INSERT OR REPLACE INTO kv (key, value, source, fetched_at) VALUES ('network:stats', ?, 'IC public API (ic-api.internetcomputer.org)', ?)").bind(JSON.stringify(value), ts).run();
  }
  return stats;
}
