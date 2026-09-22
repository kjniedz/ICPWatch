// Deeper SNS data, paged from each DAO's own canisters:
//   proposals  governance list_proposals into sns_proposals, with treasury transfer and mint amounts
//   neurons    governance list_neurons into sns_neurons, walked with a cursor across ticks (100 per call)
//   swaps      swap canister get_derived_state and get_lifecycle into sns_swaps
// Everything here is a query. Alerts for new proposals and treasury movements are raised at the end.
import { Actor } from "@icp-sdk/core/agent";
import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";
import { notifyIncident } from "../alerts/notify";
import type { CanisterRow } from "../db/queries";
import type { Env } from "../env";
import { EM_DASH, now } from "../lib/format";
import { getAgent, pool } from "../lib/ic";
import { actionName, proposalStatus } from "../lib/sns";
import { batchAll } from "./lifeline";

type O<T> = [] | [T];
const o = <T,>(v: O<T> | undefined): T | null => (v && v.length ? v[0]! : null);
const e8 = (v: bigint | null | undefined) => (v == null ? null : Number(v) / 1e8);
const ts = (v: bigint | null | undefined) => (v == null || v === 0n ? null : Number(v));

// ---- candid -----------------------------------------------------------------------------------------------

const Account = IDL.Record({ owner: IDL.Opt(IDL.Principal), subaccount: IDL.Opt(IDL.Record({ subaccount: IDL.Vec(IDL.Nat8) })) });
const govIdl: IDL.InterfaceFactory = () => {
  const Id = IDL.Record({ id: IDL.Nat64 });
  const Pct = IDL.Record({ basis_points: IDL.Opt(IDL.Nat64) });
  const Tally = IDL.Record({ no: IDL.Nat64, yes: IDL.Nat64, total: IDL.Nat64 });
  // Only the two treasury actions are decoded; every other variant of Action is left to subtyping.
  const Action = IDL.Variant({
    TransferSnsTreasuryFunds: IDL.Record({ from_treasury: IDL.Int32, amount_e8s: IDL.Nat64, to_principal: IDL.Opt(IDL.Principal), to_subaccount: IDL.Opt(IDL.Record({ subaccount: IDL.Vec(IDL.Nat8) })) }),
    MintSnsTokens: IDL.Record({ amount_e8s: IDL.Opt(IDL.Nat64), to_principal: IDL.Opt(IDL.Principal), to_subaccount: IDL.Opt(IDL.Record({ subaccount: IDL.Vec(IDL.Nat8) })) }),
    Motion: IDL.Record({ motion_text: IDL.Text }),
  });
  const Data = IDL.Record({
    id: IDL.Opt(Id), action: IDL.Nat64, proposal: IDL.Opt(IDL.Record({ url: IDL.Text, title: IDL.Text, summary: IDL.Text, action: IDL.Opt(Action) })), latest_tally: IDL.Opt(Tally),
    proposal_creation_timestamp_seconds: IDL.Nat64, decided_timestamp_seconds: IDL.Nat64, executed_timestamp_seconds: IDL.Nat64, failed_timestamp_seconds: IDL.Nat64,
    initial_voting_period_seconds: IDL.Nat64, minimum_yes_proportion_of_total: IDL.Opt(Pct), minimum_yes_proportion_of_exercised: IDL.Opt(Pct),
  });
  const List = IDL.Record({ include_reward_status: IDL.Vec(IDL.Int32), before_proposal: IDL.Opt(Id), limit: IDL.Nat32, exclude_type: IDL.Vec(IDL.Nat64), include_status: IDL.Vec(IDL.Int32) });
  const NeuronId = IDL.Record({ id: IDL.Vec(IDL.Nat8) });
  const Perm = IDL.Record({ principal: IDL.Opt(IDL.Principal), permission_type: IDL.Vec(IDL.Int32) });
  const Neuron = IDL.Record({
    id: IDL.Opt(NeuronId), cached_neuron_stake_e8s: IDL.Nat64, staked_maturity_e8s_equivalent: IDL.Opt(IDL.Nat64), maturity_e8s_equivalent: IDL.Nat64, permissions: IDL.Vec(Perm),
    created_timestamp_seconds: IDL.Nat64, vesting_period_seconds: IDL.Opt(IDL.Nat64), dissolve_state: IDL.Opt(IDL.Variant({ DissolveDelaySeconds: IDL.Nat64, WhenDissolvedTimestampSeconds: IDL.Nat64 })),
    voting_power_percentage_multiplier: IDL.Nat64, source_nns_neuron_id: IDL.Opt(IDL.Nat64),
  });
  return IDL.Service({
    list_proposals: IDL.Func([List], [IDL.Record({ proposals: IDL.Vec(Data) })], ["query"]),
    list_neurons: IDL.Func([IDL.Record({ of_principal: IDL.Opt(IDL.Principal), limit: IDL.Nat32, start_page_at: IDL.Opt(NeuronId) })], [IDL.Record({ neurons: IDL.Vec(Neuron) })], ["query"]),
  });
};
void Account;

const swapIdl: IDL.InterfaceFactory = () =>
  IDL.Service({
    get_derived_state: IDL.Func([IDL.Record({})], [IDL.Record({ sns_tokens_per_icp: IDL.Opt(IDL.Float64), buyer_total_icp_e8s: IDL.Opt(IDL.Nat64), direct_participant_count: IDL.Opt(IDL.Nat64), cf_participant_count: IDL.Opt(IDL.Nat64), direct_participation_icp_e8s: IDL.Opt(IDL.Nat64), neurons_fund_participation_icp_e8s: IDL.Opt(IDL.Nat64) })], ["query"]),
    get_lifecycle: IDL.Func([IDL.Record({})], [IDL.Record({ lifecycle: IDL.Opt(IDL.Int32), decentralization_sale_open_timestamp_seconds: IDL.Opt(IDL.Nat64), decentralization_swap_termination_timestamp_seconds: IDL.Opt(IDL.Nat64) })], ["query"]),
    get_init: IDL.Func([IDL.Record({})], [IDL.Record({ init: IDL.Opt(IDL.Record({ max_icp_e8s: IDL.Opt(IDL.Nat64), min_icp_e8s: IDL.Opt(IDL.Nat64), max_direct_participation_icp_e8s: IDL.Opt(IDL.Nat64) })) })], ["query"]),
  });

interface RawProposal {
  id: O<{ id: bigint }>; action: bigint; latest_tally: O<{ no: bigint; yes: bigint; total: bigint }>;
  proposal: O<{ url: string; title: string; summary: string; action: O<Record<string, unknown>> }>;
  proposal_creation_timestamp_seconds: bigint; decided_timestamp_seconds: bigint; executed_timestamp_seconds: bigint; failed_timestamp_seconds: bigint; initial_voting_period_seconds: bigint;
  minimum_yes_proportion_of_total: O<{ basis_points: O<bigint> }>; minimum_yes_proportion_of_exercised: O<{ basis_points: O<bigint> }>;
}
interface RawNeuron {
  id: O<{ id: Uint8Array | number[] }>; cached_neuron_stake_e8s: bigint; staked_maturity_e8s_equivalent: O<bigint>; maturity_e8s_equivalent: bigint;
  permissions: { principal: O<Principal>; permission_type: number[] }[]; created_timestamp_seconds: bigint; vesting_period_seconds: O<bigint>;
  dissolve_state: O<{ DissolveDelaySeconds?: bigint; WhenDissolvedTimestampSeconds?: bigint }>; voting_power_percentage_multiplier: bigint; source_nns_neuron_id: O<bigint>;
}

const hex = (b: Uint8Array | number[]) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

interface Dao { token_id: string; symbol: string; governance: string; swap: string | null; decimals: number }

async function daos(db: D1Database): Promise<Dao[]> {
  return (await db.prepare(`SELECT t.id token_id, t.symbol, t.decimals,
      (SELECT id FROM canisters WHERE token_id = t.id AND role = 'governance' LIMIT 1) governance,
      (SELECT id FROM canisters WHERE token_id = t.id AND role = 'swap' LIMIT 1) swap
    FROM tokens t WHERE t.kind = 'sns' AND t.hidden = 0`).all<Dao>()).results.filter((d) => d.governance);
}

// ---- proposals --------------------------------------------------------------------------------------------

export interface SnsDeepStats { daos: number; proposals: number; newProposals: number; neurons: number; passes: number; swaps: number; alerts: number; errors: number }

export async function collectSnsProposals(env: Env, stats: SnsDeepStats, list: Dao[]): Promise<{ token_id: string; id: number; title: string; type: string; treasury_kind: string | null; treasury_amount: number | null }[]> {
  const t = now();
  const fresh: { token_id: string; id: number; title: string; type: string; treasury_kind: string | null; treasury_amount: number | null }[] = [];
  const results = await pool(list, 5, async (d) => {
    const gov = Actor.createActor(govIdl, { agent: await getAgent(env.IC_HOST), canisterId: d.governance });
    const have = await env.DB.prepare("SELECT MAX(id) m, SUM(state = 'open') open FROM sns_proposals WHERE token_id = ?").bind(d.token_id).first<{ m: number | null; open: number | null }>();
    // First pass: two pages of 100. Later: one page, which covers new proposals and refreshes open tallies.
    const pages = have?.m ? 1 : 2;
    let before: O<{ id: bigint }> = [];
    const stmts: D1PreparedStatement[] = [];
    const up = env.DB.prepare(`INSERT INTO sns_proposals (token_id, id, action, type, title, summary, url, state, yes, no, total, created_at, decided_at, executed_at, deadline_at, treasury_kind, treasury_amount, treasury_to, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
      ON CONFLICT (token_id, id) DO UPDATE SET state = ?8, yes = ?9, no = ?10, total = ?11, decided_at = ?13, executed_at = ?14, updated_at = ?19`);
    for (let p = 0; p < pages; p++) {
      const r = (await gov.list_proposals!({ include_reward_status: [], before_proposal: before, limit: 100, exclude_type: [], include_status: [] })) as { proposals: RawProposal[] };
      for (const x of r.proposals) {
        const id = o(x.id)?.id;
        const body = o(x.proposal);
        if (id == null || !body) continue;
        const tally = o(x.latest_tally);
        const yes = Number(tally?.yes ?? 0n), no = Number(tally?.no ?? 0n), total = Number(tally?.total ?? 0n);
        const state = proposalStatus({ decided: Number(x.decided_timestamp_seconds), executed: Number(x.executed_timestamp_seconds), failed: Number(x.failed_timestamp_seconds), yes, no, total, minYesOfTotalBp: o(o(x.minimum_yes_proportion_of_total)?.basis_points ?? []) != null ? Number(o(o(x.minimum_yes_proportion_of_total)!.basis_points)) : null, minYesOfExercisedBp: o(o(x.minimum_yes_proportion_of_exercised)?.basis_points ?? []) != null ? Number(o(o(x.minimum_yes_proportion_of_exercised)!.basis_points)) : null });
        const act = o(body.action) as { TransferSnsTreasuryFunds?: { from_treasury: number; amount_e8s: bigint; to_principal: O<Principal> }; MintSnsTokens?: { amount_e8s: O<bigint>; to_principal: O<Principal> } } | null;
        let kind: string | null = null, amount: number | null = null, to: string | null = null;
        if (act?.TransferSnsTreasuryFunds) {
          const a = act.TransferSnsTreasuryFunds;
          kind = a.from_treasury === 1 ? "icp" : "token";
          amount = Number(a.amount_e8s) / (kind === "icp" ? 1e8 : 10 ** d.decimals);
          to = o(a.to_principal)?.toText() ?? null;
        } else if (act?.MintSnsTokens) {
          kind = "mint";
          amount = o(act.MintSnsTokens.amount_e8s) != null ? Number(o(act.MintSnsTokens.amount_e8s)) / 10 ** d.decimals : null;
          to = o(act.MintSnsTokens.to_principal)?.toText() ?? null;
        }
        const created = ts(x.proposal_creation_timestamp_seconds);
        const isNew = have?.m != null && Number(id) > have.m;
        if (isNew) fresh.push({ token_id: d.token_id, id: Number(id), title: body.title, type: actionName(Number(x.action)), treasury_kind: kind, treasury_amount: amount });
        stmts.push(up.bind(
          d.token_id, Number(id), Number(x.action), actionName(Number(x.action)), body.title.replace(EM_DASH, " - ").slice(0, 200), body.summary.replace(EM_DASH, " - ").slice(0, 4000), /^https:\/\//.test(body.url) ? body.url.slice(0, 300) : null,
          state, yes / 1e8, no / 1e8, total / 1e8, created, ts(x.decided_timestamp_seconds), ts(x.executed_timestamp_seconds), created != null ? created + Number(x.initial_voting_period_seconds) : null,
          kind, amount, to, t,
        ));
        before = [{ id }];
      }
      if (r.proposals.length < 100) break;
    }
    await batchAll(env.DB, stmts, 40);
    return stmts.length;
  });
  for (const r of results) {
    if (r.status === "fulfilled") stats.proposals += r.value;
    else stats.errors++;
  }
  stats.newProposals = fresh.length;
  return fresh;
}

// ---- neurons ----------------------------------------------------------------------------------------------

const NEURON_PAGES_PER_DAO_PER_TICK = 12; // 1,200 neurons per DAO per hour, so OpenChat's 30k take about a day per pass
const PASS_EVERY = 3 * 86400;

/** The manage permission (id 2 in the SNS permission list) marks the controller; fall back to the first principal with the most permissions. */
function controllerOf(n: RawNeuron): string | null {
  let best: { p: string; n: number } | null = null;
  for (const perm of n.permissions) {
    const p = o(perm.principal)?.toText();
    if (!p) continue;
    if (perm.permission_type.includes(2)) return p;
    if (!best || perm.permission_type.length > best.n) best = { p, n: perm.permission_type.length };
  }
  return best?.p ?? null;
}

export async function collectSnsNeurons(env: Env, stats: SnsDeepStats, list: Dao[]): Promise<void> {
  const t = now();
  const states = new Map((await env.DB.prepare("SELECT * FROM sns_neuron_state").all<{ token_id: string; cursor: string | null; pass_started: number | null; pass_done: number | null }>()).results.map((s) => [s.token_id, s]));
  const due = list.filter((d) => {
    const s = states.get(d.token_id);
    return !s || s.cursor != null || !s.pass_done || t - s.pass_done > PASS_EVERY;
  });
  const results = await pool(due, 4, async (d) => {
    const s = states.get(d.token_id);
    const gov = Actor.createActor(govIdl, { agent: await getAgent(env.IC_HOST), canisterId: d.governance });
    let cursor: O<{ id: Uint8Array }> = s?.cursor ? [{ id: Uint8Array.from(s.cursor.match(/../g)!.map((h) => parseInt(h, 16))) }] : [];
    const passStarted = s?.cursor ? s.pass_started : t;
    const up = env.DB.prepare(`INSERT OR REPLACE INTO sns_neurons (token_id, neuron_id, controller, stake, maturity, dissolve_delay_s, dissolved_at, vesting_ends_at, vp_multiplier, from_nns_fund, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let n = 0;
    let done = false;
    for (let page = 0; page < NEURON_PAGES_PER_DAO_PER_TICK; page++) {
      const r = (await gov.list_neurons!({ of_principal: [], limit: 100, start_page_at: cursor })) as { neurons: RawNeuron[] };
      const stmts: D1PreparedStatement[] = [];
      for (const x of r.neurons) {
        const id = o(x.id);
        if (!id) continue;
        const idHex = hex(id.id);
        const ds = o(x.dissolve_state);
        const created = ts(x.created_timestamp_seconds);
        const vest = o(x.vesting_period_seconds);
        stmts.push(up.bind(
          d.token_id, idHex, controllerOf(x), (Number(x.cached_neuron_stake_e8s) + Number(o(x.staked_maturity_e8s_equivalent) ?? 0n)) / 10 ** d.decimals, Number(x.maturity_e8s_equivalent) / 10 ** d.decimals,
          ds?.DissolveDelaySeconds != null ? Number(ds.DissolveDelaySeconds) : null, ds?.WhenDissolvedTimestampSeconds != null ? Number(ds.WhenDissolvedTimestampSeconds) : null,
          vest != null && created != null && vest > 0n ? created + Number(vest) : null, Number(x.voting_power_percentage_multiplier), o(x.source_nns_neuron_id) != null ? 1 : 0, created, t,
        ));
        cursor = [{ id: id.id instanceof Uint8Array ? id.id : Uint8Array.from(id.id) }];
        n++;
      }
      await batchAll(env.DB, stmts, 40);
      if (r.neurons.length < 100) { done = true; break; }
    }
    if (done) {
      // Pass complete: neurons not seen in this pass no longer exist.
      const agg = await env.DB.prepare("SELECT COUNT(*) n, COALESCE(SUM(stake), 0) s FROM sns_neurons WHERE token_id = ? AND seen_at >= ?").bind(d.token_id, passStarted ?? t).first<{ n: number; s: number }>();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sns_neurons WHERE token_id = ? AND seen_at < ?").bind(d.token_id, passStarted ?? t),
        env.DB.prepare("INSERT OR REPLACE INTO sns_neuron_state (token_id, cursor, pass_started, pass_done, neurons, staked, error, updated_at) VALUES (?, NULL, ?, ?, ?, ?, NULL, ?)").bind(d.token_id, passStarted, t, agg?.n ?? 0, agg?.s ?? 0, t),
      ]);
      stats.passes++;
    } else {
      await env.DB.prepare("INSERT OR REPLACE INTO sns_neuron_state (token_id, cursor, pass_started, pass_done, neurons, staked, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)")
        .bind(d.token_id, cursor.length ? hex(cursor[0]!.id) : null, passStarted, s?.pass_done ?? null, s ? (await env.DB.prepare("SELECT neurons FROM sns_neuron_state WHERE token_id = ?").bind(d.token_id).first<{ neurons: number }>())?.neurons ?? 0 : 0, 0, t).run();
    }
    return n;
  });
  for (const r of results) {
    if (r.status === "fulfilled") stats.neurons += r.value;
    else stats.errors++;
  }
}

// ---- swaps ------------------------------------------------------------------------------------------------

export async function collectSnsSwaps(env: Env, stats: SnsDeepStats, list: Dao[]): Promise<void> {
  const t = now();
  const results = await pool(list.filter((d) => d.swap), 6, async (d) => {
    const s = Actor.createActor(swapIdl, { agent: await getAgent(env.IC_HOST), canisterId: d.swap! });
    const [ds, lc, init] = await Promise.all([
      s.get_derived_state!({}) as Promise<{ sns_tokens_per_icp: O<number>; buyer_total_icp_e8s: O<bigint>; direct_participant_count: O<bigint>; cf_participant_count: O<bigint>; direct_participation_icp_e8s: O<bigint>; neurons_fund_participation_icp_e8s: O<bigint> }>,
      s.get_lifecycle!({}) as Promise<{ lifecycle: O<number>; decentralization_sale_open_timestamp_seconds: O<bigint>; decentralization_swap_termination_timestamp_seconds: O<bigint> }>,
      (s.get_init!({}) as Promise<{ init: O<{ max_icp_e8s: O<bigint>; min_icp_e8s: O<bigint>; max_direct_participation_icp_e8s: O<bigint> }> }>).catch(() => null),
    ]);
    const i = init ? o(init.init) : null;
    await env.DB.prepare("INSERT OR REPLACE INTO sns_swaps (token_id, swap_id, lifecycle, opens_at, closed_at, icp_raised, direct_icp, nf_icp, tokens_per_icp, participants, max_icp, min_icp, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(d.token_id, d.swap, o(lc.lifecycle), ts(o(lc.decentralization_sale_open_timestamp_seconds)), ts(o(lc.decentralization_swap_termination_timestamp_seconds)),
        e8(o(ds.buyer_total_icp_e8s)), e8(o(ds.direct_participation_icp_e8s)), e8(o(ds.neurons_fund_participation_icp_e8s)), o(ds.sns_tokens_per_icp),
        Number(o(ds.direct_participant_count) ?? 0n) + Number(o(ds.cf_participant_count) ?? 0n), e8(o(i?.max_direct_participation_icp_e8s ?? []) ?? o(i?.max_icp_e8s ?? [])), e8(o(i?.min_icp_e8s ?? [])), t).run();
    return 1;
  });
  for (const r of results) {
    if (r.status === "fulfilled") stats.swaps++;
    else stats.errors++;
  }
}

// ---- alerts: new proposals and treasury movements -------------------------------------------------------------

async function raise(env: Env, fresh: Awaited<ReturnType<typeof collectSnsProposals>>): Promise<number> {
  let n = 0;
  const t = now();
  for (const p of fresh) {
    const gov = await env.DB.prepare("SELECT c.*, t.symbol token_symbol FROM canisters c JOIN tokens t ON t.id = c.token_id WHERE c.token_id = ? AND c.role = 'governance'").bind(p.token_id).first<CanisterRow>();
    if (!gov) continue;
    const treasury = p.treasury_kind != null;
    const type = treasury ? "treasury_movement" : "sns_proposal";
    const title = treasury ? `Treasury ${p.treasury_kind === "mint" ? "mint" : "transfer"} proposed: ${gov.token_symbol}` : `New proposal: ${gov.token_symbol}`;
    const detail = treasury
      ? `Proposal ${p.id} would ${p.treasury_kind === "mint" ? "mint" : "move"} ${p.treasury_amount?.toLocaleString("en-US") ?? "an unknown amount of"} ${p.treasury_kind === "icp" ? "ICP" : gov.token_symbol} from the treasury: "${p.title}".`
      : `Proposal ${p.id} (${p.type}): "${p.title}".`;
    const row = await env.DB.prepare("INSERT INTO incidents (canister_id, type, state, severity, title, detail, data, opened_at, resolved_at) VALUES (?, ?, 'resolved', ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(gov.id, type, treasury ? "warn" : "info", title, detail, JSON.stringify({ token_id: p.token_id, proposal: p.id, href: `/sns/proposals#${p.token_id}-${p.id}` }), t, t).first<{ id: number }>();
    if (row) n += await notifyIncident(env, { incidentId: row.id, canister: gov, type, kind: "fired", title, detail, severity: treasury ? "warn" : "info" }).catch(() => 0);
  }
  return n;
}

export async function collectSnsDeep(env: Env): Promise<SnsDeepStats> {
  const stats: SnsDeepStats = { daos: 0, proposals: 0, newProposals: 0, neurons: 0, passes: 0, swaps: 0, alerts: 0, errors: 0 };
  const list = await daos(env.DB);
  stats.daos = list.length;
  const fresh = await collectSnsProposals(env, stats, list);
  await collectSnsSwaps(env, stats, list);
  await collectSnsNeurons(env, stats, list);
  stats.alerts = await raise(env, fresh);
  return stats;
}
