// Cross-DAO proposal feed, unlock calendar, launches, and compare data. Read side only.
import { now } from "../lib/format";

export interface FeedProposal {
  token_id: string; symbol: string; name: string; logo: string | null; sns_root: string | null;
  id: number; action: number; type: string; title: string | null; url: string | null; state: string;
  yes: number | null; no: number | null; total: number | null; created_at: number | null; decided_at: number | null; executed_at: number | null; deadline_at: number | null;
  treasury_kind: string | null; treasury_amount: number | null; treasury_to: string | null;
}

export interface FeedFilter { dao?: string; state?: "open" | "decided" | "all"; kind?: "treasury" | "upgrade" | "motion" | "all"; before?: number; limit?: number }

const KIND_SQL: Record<string, string> = {
  treasury: "p.treasury_kind IS NOT NULL",
  upgrade: "p.action IN (3, 7, 15, 19)",
  motion: "p.action = 1",
};

export async function proposalFeed(db: D1Database, f: FeedFilter): Promise<FeedProposal[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.dao) { where.push(`p.token_id = ?${args.length + 1}`); args.push(f.dao); }
  if (f.state === "open") where.push("p.state = 'open'");
  else if (f.state === "decided") where.push("p.state != 'open'");
  if (f.kind && KIND_SQL[f.kind]) where.push(KIND_SQL[f.kind]!);
  if (f.before) { where.push(`p.created_at < ?${args.length + 1}`); args.push(f.before); }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const sql = `SELECT p.token_id, t.symbol, t.name, t.logo, t.sns_root, p.id, p.action, p.type, p.title, p.url, p.state, p.yes, p.no, p.total, p.created_at, p.decided_at, p.executed_at, p.deadline_at, p.treasury_kind, p.treasury_amount, p.treasury_to
    FROM sns_proposals p JOIN tokens t ON t.id = p.token_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY p.created_at DESC LIMIT ${limit}`;
  return (await db.prepare(sql).bind(...args).all<FeedProposal>()).results;
}

export interface UnlockBucket { month: number; token_id: string; symbol: string; stake: number; neurons: number; price_usd: number | null }
export interface BigUnlock { token_id: string; symbol: string; neuron_id: string; controller: string | null; stake: number; at: number; price_usd: number | null; from_nns_fund: number }

/**
 * A neuron is scheduled to unlock when it is dissolving; the moment is its dissolve time or, for a
 * developer neuron still vesting, the later of the two. Non-dissolving neurons have no date and are
 * not on the calendar.
 */
export async function unlockCalendar(db: D1Database, months = 12): Promise<{ buckets: UnlockBucket[]; big: BigUnlock[]; lockedNoDate: { token_id: string; symbol: string; stake: number; neurons: number }[] }> {
  const ts = now();
  const until = ts + months * 31 * 86400;
  const at = "MAX(n.dissolved_at, COALESCE(n.vesting_ends_at, 0))";
  const [b, big, locked] = await Promise.all([
    db.prepare(`SELECT CAST(strftime('%Y', ${at}, 'unixepoch') AS INT) * 100 + CAST(strftime('%m', ${at}, 'unixepoch') AS INT) month, n.token_id, t.symbol, SUM(n.stake) stake, COUNT(*) neurons, m.price_usd
      FROM sns_neurons n JOIN tokens t ON t.id = n.token_id LEFT JOIN market m ON m.token_id = n.token_id
      WHERE n.dissolved_at IS NOT NULL AND ${at} > ?1 AND ${at} <= ?2 GROUP BY month, n.token_id ORDER BY month, stake DESC`).bind(ts, until).all<UnlockBucket>(),
    db.prepare(`SELECT n.token_id, t.symbol, n.neuron_id, n.controller, n.stake, ${at} at, m.price_usd, n.from_nns_fund
      FROM sns_neurons n JOIN tokens t ON t.id = n.token_id LEFT JOIN market m ON m.token_id = n.token_id
      WHERE n.dissolved_at IS NOT NULL AND ${at} > ?1 AND ${at} <= ?2 ORDER BY n.stake * COALESCE(m.price_usd, 0) DESC, n.stake DESC LIMIT 40`).bind(ts, until).all<BigUnlock>(),
    db.prepare(`SELECT n.token_id, t.symbol, SUM(n.stake) stake, COUNT(*) neurons FROM sns_neurons n JOIN tokens t ON t.id = n.token_id WHERE n.dissolved_at IS NULL GROUP BY n.token_id ORDER BY stake DESC`).all<{ token_id: string; symbol: string; stake: number; neurons: number }>(),
  ]);
  return { buckets: b.results, big: big.results, lockedNoDate: locked.results };
}

export interface Launch {
  kind: "swap" | "nns";
  token_id: string | null; symbol: string | null; name: string; logo: string | null;
  lifecycle: number | null; opens_at: number | null; closes_at: number | null; icp_raised: number | null; max_icp: number | null; min_icp: number | null; participants: number | null;
  proposal_id: number | null; status: string | null; created_at: number | null;
}

/** Open or pending swaps from the swap canisters, plus NNS proposals that create an SNS (the pipeline before a swap exists). */
export async function launches(db: D1Database): Promise<Launch[]> {
  const [swaps, nns] = await Promise.all([
    db.prepare(`SELECT s.token_id, t.symbol, t.name, t.logo, s.lifecycle, s.opens_at, s.closed_at closes_at, s.icp_raised, s.max_icp, s.min_icp, s.participants
      FROM sns_swaps s JOIN tokens t ON t.id = s.token_id WHERE s.lifecycle IN (1, 2) ORDER BY s.opens_at`).all<Omit<Launch, "kind" | "proposal_id" | "status" | "created_at">>(),
    db.prepare(`SELECT id proposal_id, status, title, created_at, deadline_at FROM proposals WHERE action = 'Create Service Nervous System (SNS)' AND created_at > ?1 ORDER BY id DESC LIMIT 10`).bind(now() - 60 * 86400)
      .all<{ proposal_id: number; status: string | null; title: string | null; created_at: number | null; deadline_at: number | null }>(),
  ]);
  const out: Launch[] = swaps.results.map((s) => ({ kind: "swap", ...s, proposal_id: null, status: null, created_at: null }));
  for (const p of nns.results) {
    out.push({ kind: "nns", token_id: null, symbol: null, name: (p.title ?? `Proposal ${p.proposal_id}`).replace(/^(NNS )?proposal to create (an? )?(SNS( DAO)? (named |for )?)?/i, "").replace(/^'|'$/g, ""), logo: null, lifecycle: null, opens_at: null, closes_at: p.deadline_at, icp_raised: null, max_icp: null, min_icp: null, participants: null, proposal_id: p.proposal_id, status: p.status, created_at: p.created_at });
  }
  return out;
}
