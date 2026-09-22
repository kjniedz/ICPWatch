// Read side of the SNS dashboard. Everything here joins tables other collectors already fill:
// tokens/market (markets), kv `sns:<ledger>` (sns), sns_proposals/sns_neurons/sns_swaps (sns-deep),
// trust_scores (trust), canisters (lifeline). No network calls.
import type { SnsDao } from "../lib/sns";

export interface SnsDaoRow {
  id: string; symbol: string; name: string; logo: string | null; sns_root: string | null; hidden: number;
  price_usd: number | null; price_icp: number | null; chg_24h: number | null; mcap_usd: number | null; fdv_usd: number | null; vol_24h_usd: number | null;
  sns_json: string | null; sns_fetched_at: number | null; sns_source: string | null;
  trust_grade: string | null; trust_score: number | null;
  /** Lifeline across every canister that reports through this SNS root, not just the token group. */
  worst_rank: number | null; worst_health: string | null; worst_label: string | null; worst_role: string | null; canisters: number;
  frozen: number; gone: number;
  swap_icp_raised: number | null; swap_tokens_per_icp: number | null; swap_participants: number | null; swap_lifecycle: number | null; swap_closed_at: number | null; swap_opens_at: number | null; swap_direct_icp: number | null; swap_nf_icp: number | null;
  proposals_30d: number; open_now: number; turnout_30d: number | null; treasury_moves_30d: number;
  walked_neurons: number; walked_staked: number; walk_done: number | null;
}

const HEALTH_RANK = `CASE health WHEN 'gone' THEN 6 WHEN 'frozen' THEN 5 WHEN 'low' THEN 4 WHEN 'risk' THEN 3 WHEN 'life' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END`;

export async function listSnsDaos(db: D1Database, nowTs: number): Promise<SnsDaoRow[]> {
  const since = nowTs - 30 * 86400;
  const r = await db.prepare(`
    WITH h AS (
      SELECT sns_root, COUNT(*) canisters, MAX(${HEALTH_RANK}) worst_rank, SUM(health = 'frozen') frozen, SUM(health = 'gone') gone
      FROM canisters WHERE sns_root IS NOT NULL GROUP BY sns_root
    ), w AS (
      SELECT sns_root, health, label, role, ROW_NUMBER() OVER (PARTITION BY sns_root ORDER BY ${HEALTH_RANK} DESC, freeze_at ASC) rn
      FROM canisters WHERE sns_root IS NOT NULL
    ), p AS (
      SELECT token_id, COUNT(*) proposals_30d, SUM(state = 'open') open_now,
             AVG(CASE WHEN state != 'open' AND total > 0 THEN (yes + no) / total END) turnout_30d,
             SUM(treasury_kind IS NOT NULL) treasury_moves_30d
      FROM sns_proposals WHERE created_at >= ? GROUP BY token_id
    ), o AS (
      SELECT token_id, SUM(state = 'open') open_now FROM sns_proposals GROUP BY token_id
    )
    SELECT t.id, t.symbol, t.name, t.logo, t.sns_root, t.hidden,
           m.price_usd, m.price_icp, m.chg_24h, m.mcap_usd, m.fdv_usd, m.vol_24h_usd,
           kv.value sns_json, kv.fetched_at sns_fetched_at, kv.source sns_source,
           ts.grade trust_grade, ts.score trust_score,
           h.worst_rank, w.health worst_health, w.label worst_label, w.role worst_role, COALESCE(h.canisters, 0) canisters, COALESCE(h.frozen, 0) frozen, COALESCE(h.gone, 0) gone,
           s.icp_raised swap_icp_raised, s.tokens_per_icp swap_tokens_per_icp, s.participants swap_participants, s.lifecycle swap_lifecycle, s.closed_at swap_closed_at, s.opens_at swap_opens_at, s.direct_icp swap_direct_icp, s.nf_icp swap_nf_icp,
           COALESCE(p.proposals_30d, 0) proposals_30d, COALESCE(o.open_now, 0) open_now, p.turnout_30d, COALESCE(p.treasury_moves_30d, 0) treasury_moves_30d,
           COALESCE(ns.neurons, 0) walked_neurons, COALESCE(ns.staked, 0) walked_staked, ns.pass_done walk_done
    FROM tokens t
    LEFT JOIN market m ON m.token_id = t.id
    LEFT JOIN kv ON kv.key = 'sns:' || t.id
    LEFT JOIN trust_scores ts ON ts.token_id = t.id
    LEFT JOIN h ON h.sns_root = t.sns_root
    LEFT JOIN w ON w.sns_root = t.sns_root AND w.rn = 1
    LEFT JOIN sns_swaps s ON s.token_id = t.id
    LEFT JOIN p ON p.token_id = t.id
    LEFT JOIN o ON o.token_id = t.id
    LEFT JOIN sns_neuron_state ns ON ns.token_id = t.id
    WHERE t.kind = 'sns'
    ORDER BY (m.mcap_usd IS NULL), m.mcap_usd DESC, t.symbol ASC`).bind(since).all<SnsDaoRow>();
  return r.results;
}

/** What the dashboard renders per DAO, derived once from the joined row. */
export interface SnsDaoView {
  row: SnsDaoRow;
  dao: Partial<SnsDao> | null;
  treasury_icp: number | null; treasury_token: number | null; treasury_usd: number | null;
  /** treasury USD / market cap; over 1 means the market values the DAO below its own treasury. */
  treasury_of_mcap: number | null;
  /** Current ICP value of 1 ICP put into the swap, minus 1. */
  swap_roi: number | null;
  neurons: number | null; voting_power: number | null;
  /** Dead: no live SNS read for two days, or governance/ledger frozen or gone. */
  dead: boolean; dead_reason: string | null;
  health: string; health_label: string;
}

export function toView(row: SnsDaoRow, nowTs: number): SnsDaoView {
  let dao: Partial<SnsDao> | null = null;
  if (row.sns_json) { try { dao = JSON.parse(row.sns_json) as Partial<SnsDao>; } catch { dao = null; } }
  const stale = row.sns_fetched_at == null || nowTs - row.sns_fetched_at > 2 * 86400;
  const gone = row.gone > 0 && (row.worst_role === "ledger" || row.worst_role === "governance" || row.worst_role === "root");
  const frozen = row.frozen > 0 && (row.worst_role === "ledger" || row.worst_role === "governance");
  const dead = gone || (stale && (frozen || row.canisters === 0 || row.sns_json == null));
  const dead_reason = gone ? `${row.worst_role} canister uninstalled` : frozen ? `${row.worst_role} canister frozen` : stale ? "governance stopped answering" : null;
  const treasury_usd = dao?.treasury_usd ?? null;
  const swap_roi = row.swap_tokens_per_icp && row.price_icp != null ? row.swap_tokens_per_icp * row.price_icp - 1 : null;
  const health = row.canisters === 0 || !row.worst_health ? "unknown" : row.worst_health;
  const roleName = row.worst_role ? row.worst_role[0]!.toUpperCase() + row.worst_role.slice(1) : "Canister";
  const health_label = health === "unknown" ? "Not watched" : health === "healthy" ? "Healthy" : health === "gone" ? `${roleName} uninstalled` : health === "frozen" ? `${roleName} frozen` : health === "low" ? `${roleName} low` : health === "risk" ? `${roleName} at risk` : health === "life" ? "On life support" : "Healthy";
  return {
    row, dao, treasury_icp: dao?.treasury_icp ?? null, treasury_token: dao?.treasury_token ?? null, treasury_usd,
    treasury_of_mcap: treasury_usd != null && row.mcap_usd ? treasury_usd / row.mcap_usd : null,
    swap_roi, neurons: dao?.neurons ?? (row.walked_neurons || null), voting_power: dao?.voting_power_total ?? null,
    dead, dead_reason, health, health_label,
  };
}

export interface SnsTotals {
  daos: number; live: number; dead: number; mcap_usd: number; treasury_usd: number; treasury_icp: number; neurons: number; proposals_30d: number; open_now: number; icp_raised: number;
  /** Share of DAOs whose treasury is worth more than their market cap. */
  under_treasury: number;
}

export function totals(views: SnsDaoView[]): SnsTotals {
  const t: SnsTotals = { daos: views.length, live: 0, dead: 0, mcap_usd: 0, treasury_usd: 0, treasury_icp: 0, neurons: 0, proposals_30d: 0, open_now: 0, icp_raised: 0, under_treasury: 0 };
  for (const v of views) {
    if (v.dead) t.dead++; else t.live++;
    t.mcap_usd += v.row.mcap_usd ?? 0; t.treasury_usd += v.treasury_usd ?? 0; t.treasury_icp += v.treasury_icp ?? 0;
    t.neurons += v.neurons ?? 0; t.proposals_30d += v.row.proposals_30d; t.open_now += v.row.open_now; t.icp_raised += v.row.swap_icp_raised ?? 0;
    if (v.treasury_of_mcap != null && v.treasury_of_mcap > 1) t.under_treasury++;
  }
  return t;
}
