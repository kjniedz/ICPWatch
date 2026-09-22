// Read-side queries used by pages and the JSON API. Collectors write through src/db/write.ts.

export interface TokenRow {
  id: string; symbol: string; name: string; decimals: number; fee: string | null; kind: string; standard: string;
  sns_root: string | null; logo: string | null; description: string | null; url: string | null;
  total_supply: string | null; supply_at: number | null; listed_at: number; listed_via: string; updated_at: number;
}

export interface CanisterRow {
  id: string; token_id: string | null; role: string; label: string; subnet_id: string | null; controllers: string | null;
  module_hash: string | null; discovered_at: number; discovered_via: string; cycles: number | null; cycles_source: string | null;
  confidence: string; run_status: string; freezing_threshold_s: number | null; idle_burn_per_day: number | null;
  memory_bytes: number | null; burn_per_day: number | null; burn_baseline: number | null; burn_mad: number | null; baseline_days: number | null;
  source_hint: string | null; sns_root: string | null; burn_source: string | null;
  freeze_at: number | null; delete_at: number | null; health: string; measured_at: number | null; probed_at: number | null;
  life_support: number; note: string | null;
  // joined
  token_symbol?: string | null; token_name?: string | null;
}

export interface IncidentRow {
  id: number; canister_id: string; type: string; state: string; severity: string; title: string; detail: string;
  data: string | null; opened_at: number; resolved_at: number | null; simulated: number; label?: string;
}

export interface MarketRow {
  token_id: string; price_usd: number | null; price_icp: number | null; chg_24h: number | null; chg_7d: number | null;
  chg_30d: number | null; vol_24h_usd: number | null; tvl_usd: number | null; mcap_usd: number | null; fdv_usd: number | null;
  liquidity: string | null; spark_7d: string | null; sources: string | null; updated_at: number;
}

export type TokenMarketRow = TokenRow & Partial<MarketRow> & { worst_health: string | null; health_note: string | null; canister_count: number; trust_grade: string | null; trust_score: number | null };

export interface PoolRow {
  id: string; dex: string; token0: string; token1: string; symbol0: string | null; symbol1: string | null;
  tvl_usd: number | null; vol_24h_usd: number | null; vol_7d_usd: number | null; fee_bps: number | null; price: number | null; updated_at: number;
}

export interface SubnetRow {
  id: string; type: string | null; label: string | null; nodes: number | null; canisters: number | null; burn_per_day: number | null;
  block_rate: number | null; msg_rate: number | null; instr_rate: number | null; memory_bytes: number | null; replica_version: string | null; updated_at: number;
}

export interface ProposalRow {
  id: number; topic: string | null; action: string | null; status: string | null; title: string | null; summary: string | null;
  url: string | null; proposer: string | null; yes: number | null; no: number | null; total: number | null; created_at: number | null;
  deadline_at: number | null; decided_at: number | null; executed_at: number | null; updated_at: number;
}

export interface Kv<T> { value: T; source: string; fetched_at: number }

const all = async <T>(stmt: D1PreparedStatement) => (await stmt.all<T>()).results;

// Severity order for picking the worst canister in a token group.
const HEALTH_RANK = `CASE health WHEN 'gone' THEN 6 WHEN 'frozen' THEN 5 WHEN 'low' THEN 4 WHEN 'risk' THEN 3 WHEN 'life' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END`;

export async function kvGet<T>(db: D1Database, key: string): Promise<Kv<T> | null> {
  const row = await db.prepare("SELECT value, source, fetched_at FROM kv WHERE key = ?").bind(key).first<{ value: string; source: string; fetched_at: number }>();
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as T, source: row.source, fetched_at: row.fetched_at };
  } catch {
    return null;
  }
}

export async function kvGetMany(db: D1Database, keys: string[]): Promise<Record<string, Kv<unknown>>> {
  if (!keys.length) return {};
  const rows = await all<{ key: string; value: string; source: string; fetched_at: number }>(
    db.prepare(`SELECT key, value, source, fetched_at FROM kv WHERE key IN (${keys.map(() => "?").join(",")})`).bind(...keys),
  );
  const out: Record<string, Kv<unknown>> = {};
  for (const r of rows) {
    try {
      out[r.key] = { value: JSON.parse(r.value), source: r.source, fetched_at: r.fetched_at };
    } catch {
      /* skip bad row */
    }
  }
  return out;
}

export interface LifelineSummary {
  watched: number; archives: number; at_risk: number; frozen: number; life_support: number; measured: number; inferred: number; unknown: number;
  tokens: number; alerts_today: number; last_measured_at: number | null;
}

export async function lifelineSummary(db: D1Database, nowTs: number): Promise<LifelineSummary> {
  const [c, t, a] = await db.batch<Record<string, number | null>>([
    db.prepare(`SELECT COUNT(*) watched,
        SUM(role = 'archive') archives,
        SUM(health IN ('low','risk')) at_risk,
        SUM(health IN ('frozen','gone')) frozen,
        SUM(life_support = 1) life_support,
        SUM(confidence = 'measured') measured,
        SUM(confidence = 'inferred') inferred,
        SUM(confidence = 'unknown') unknown,
        MAX(measured_at) last_measured_at
      FROM canisters`),
    db.prepare("SELECT COUNT(*) n FROM tokens WHERE hidden = 0"),
    db.prepare("SELECT COUNT(*) n FROM incidents WHERE opened_at > ? AND simulated = 0").bind(nowTs - 86400),
  ]);
  const r = c!.results[0] ?? {};
  return {
    watched: r.watched ?? 0, archives: r.archives ?? 0, at_risk: r.at_risk ?? 0, frozen: r.frozen ?? 0, life_support: r.life_support ?? 0,
    measured: r.measured ?? 0, inferred: r.inferred ?? 0, unknown: r.unknown ?? 0, last_measured_at: r.last_measured_at ?? null,
    tokens: t!.results[0]?.n ?? 0, alerts_today: a!.results[0]?.n ?? 0,
  };
}

export const listCanisters = (db: D1Database) =>
  all<CanisterRow>(
    db.prepare(`SELECT c.*, t.symbol token_symbol, t.name token_name FROM canisters c LEFT JOIN tokens t ON t.id = c.token_id
      ORDER BY ${HEALTH_RANK.replaceAll("health", "c.health")} DESC, (c.freeze_at IS NULL), c.freeze_at ASC, c.label ASC`),
  );

export const canistersForToken = (db: D1Database, tokenId: string) =>
  all<CanisterRow>(
    db.prepare(`SELECT * FROM canisters WHERE token_id = ? ORDER BY CASE role WHEN 'ledger' THEN 0 WHEN 'index' THEN 1 WHEN 'archive' THEN 2 WHEN 'root' THEN 3 WHEN 'governance' THEN 4 WHEN 'swap' THEN 5 ELSE 6 END, label`).bind(tokenId),
  );

export const getCanister = (db: D1Database, id: string) =>
  db.prepare("SELECT c.*, t.symbol token_symbol, t.name token_name FROM canisters c LEFT JOIN tokens t ON t.id = c.token_id WHERE c.id = ?").bind(id).first<CanisterRow>();

export const getToken = (db: D1Database, idOrSymbol: string) =>
  db.prepare("SELECT * FROM tokens WHERE id = ?1 OR symbol = ?1 COLLATE NOCASE ORDER BY (id = ?1) DESC, listed_at ASC LIMIT 1").bind(idOrSymbol).first<TokenRow>();

export const getMarket = (db: D1Database, tokenId: string) => db.prepare("SELECT * FROM market WHERE token_id = ?").bind(tokenId).first<MarketRow>();

/** Token list with market data and the worst Lifeline health across each token's canister group. */
export const listTokens = (db: D1Database) =>
  all<TokenMarketRow>(
    db.prepare(`
      WITH h AS (
        SELECT token_id, COUNT(*) canister_count, MAX(${HEALTH_RANK}) worst
        FROM canisters WHERE token_id IS NOT NULL AND role IN ('ledger','index','archive') GROUP BY token_id
      ), w AS (
        SELECT c.token_id, c.health, c.role, ROW_NUMBER() OVER (PARTITION BY c.token_id ORDER BY ${HEALTH_RANK} DESC, c.freeze_at ASC) rn
        FROM canisters c WHERE c.token_id IS NOT NULL AND c.role IN ('ledger','index','archive')
      )
      SELECT t.*, m.price_usd, m.price_icp, m.chg_24h, m.chg_7d, m.chg_30d, m.vol_24h_usd, m.tvl_usd, m.mcap_usd, m.fdv_usd,
             m.liquidity, m.spark_7d, m.sources, m.updated_at AS market_updated_at,
             w.health worst_health, w.role health_note, COALESCE(h.canister_count, 0) canister_count, ts.grade trust_grade, ts.score trust_score
      FROM tokens t
      LEFT JOIN market m ON m.token_id = t.id
      LEFT JOIN trust_scores ts ON ts.token_id = t.id
      LEFT JOIN h ON h.token_id = t.id
      LEFT JOIN w ON w.token_id = t.id AND w.rn = 1
      WHERE t.hidden = 0
      ORDER BY (m.mcap_usd IS NULL), m.mcap_usd DESC, (m.tvl_usd IS NULL), m.tvl_usd DESC, t.symbol ASC`),
  );

export interface TokenHealthRow {
  id: string; symbol: string; name: string; logo: string | null; kind: string; canisters: number; archives: number; has_index: number;
  total_cycles: number | null; measured: number; worst: number; next_freeze_at: number | null; next_delete_at: number | null; worst_label: string | null; worst_role: string | null;
}

/** One row per token: its ledger + index + archives rolled up, worst state first. */
export const tokenHealth = (db: D1Database) =>
  all<TokenHealthRow>(
    db.prepare(`
      WITH g AS (
        SELECT token_id, COUNT(*) canisters, SUM(role = 'archive') archives, MAX(role = 'index') has_index, SUM(cycles) total_cycles,
               SUM(confidence = 'measured') measured, MAX(${HEALTH_RANK}) worst, MIN(freeze_at) next_freeze_at, MIN(delete_at) next_delete_at
        FROM canisters WHERE token_id IS NOT NULL AND role IN ('ledger','index','archive') GROUP BY token_id
      ), w AS (
        SELECT token_id, label, role, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY ${HEALTH_RANK} DESC, freeze_at ASC) rn
        FROM canisters WHERE token_id IS NOT NULL AND role IN ('ledger','index','archive')
      )
      SELECT t.id, t.symbol, t.name, t.logo, t.kind, g.*, w.label worst_label, w.role worst_role
      FROM tokens t JOIN g ON g.token_id = t.id LEFT JOIN w ON w.token_id = t.id AND w.rn = 1
      WHERE t.hidden = 0 ORDER BY g.worst DESC, (g.next_freeze_at IS NULL), g.next_freeze_at ASC, t.symbol ASC`),
  );

export const recentIncidents = (db: D1Database, limit = 20, canisterIds?: string[]) => {
  if (canisterIds && !canisterIds.length) return Promise.resolve([] as IncidentRow[]);
  const where = canisterIds ? `WHERE i.canister_id IN (${canisterIds.map(() => "?").join(",")})` : "";
  return all<IncidentRow>(
    db.prepare(`SELECT i.*, c.label FROM incidents i LEFT JOIN canisters c ON c.id = i.canister_id ${where}
      ORDER BY COALESCE(i.resolved_at, i.opened_at) DESC LIMIT ?`).bind(...(canisterIds ?? []), limit),
  );
};

export const readings = (db: D1Database, canisterId: string, since: number) =>
  all<{ ts: number; cycles: number | null; source: string; confidence: string }>(
    db.prepare("SELECT ts, cycles, source, confidence FROM readings WHERE canister_id = ? AND ts >= ? AND cycles IS NOT NULL ORDER BY ts ASC").bind(canisterId, since),
  );

export const canisterChanges = (db: D1Database, canisterId: string) =>
  all<{ ts: number; field: string; old_value: string | null; new_value: string | null }>(
    db.prepare("SELECT ts, field, old_value, new_value FROM canister_changes WHERE canister_id = ? ORDER BY ts DESC LIMIT 50").bind(canisterId),
  );

export const priceSeries = (db: D1Database, tokenId: string, res: "hour" | "day", since: number) =>
  all<{ ts: number; price_usd: number; open: number | null; high: number | null; low: number | null }>(
    db.prepare("SELECT ts, price_usd, open, high, low FROM prices WHERE token_id = ? AND res = ? AND ts >= ? ORDER BY ts ASC").bind(tokenId, res, since),
  );

export const poolsForToken = (db: D1Database, tokenId: string) =>
  all<PoolRow>(db.prepare("SELECT * FROM pools WHERE token0 = ?1 OR token1 = ?1 ORDER BY tvl_usd DESC LIMIT 50").bind(tokenId));

export const topPools = (db: D1Database, limit = 100) =>
  all<PoolRow>(db.prepare("SELECT * FROM pools WHERE vol_24h_usd IS NOT NULL ORDER BY vol_24h_usd DESC LIMIT ?").bind(limit));

export const listSubnets = (db: D1Database) => all<SubnetRow>(db.prepare("SELECT * FROM subnets ORDER BY (burn_per_day IS NULL), burn_per_day DESC"));
export const getSubnet = (db: D1Database, id: string) => db.prepare("SELECT * FROM subnets WHERE id = ?").bind(id).first<SubnetRow>();

export const listProposals = (db: D1Database, limit = 50, status?: string) =>
  all<ProposalRow>(
    status
      ? db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY id DESC LIMIT ?").bind(status, limit)
      : db.prepare("SELECT * FROM proposals ORDER BY id DESC LIMIT ?").bind(limit),
  );
export const getProposal = (db: D1Database, id: number) => db.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<ProposalRow>();

export const lifeSupportList = (db: D1Database) =>
  all<{ canister_id: string; what: string; story: string | null; since: number; budget_cycles: number; spent_cycles: number; monthly_cycles: number | null; state: string; label: string | null; cycles: number | null }>(
    db.prepare("SELECT l.*, c.label, c.cycles FROM life_support l LEFT JOIN canisters c ON c.id = l.canister_id ORDER BY l.since ASC"),
  );

export const lastRuns = (db: D1Database) =>
  all<{ job: string; started_at: number; ms: number | null; ok: number; stats: string | null; error: string | null }>(
    db.prepare("SELECT r.* FROM runs r JOIN (SELECT job, MAX(id) id FROM runs GROUP BY job) x ON x.id = r.id ORDER BY r.job"),
  );

export const newestTokens = (db: D1Database, limit = 50) =>
  all<TokenRow>(db.prepare("SELECT * FROM tokens WHERE hidden = 0 ORDER BY listed_at DESC, symbol ASC LIMIT ?").bind(limit));

export async function searchIndex(db: D1Database, q: string) {
  // D1 rejects LIKE patterns over 50 bytes. Anything that long is an id, so match it exactly instead.
  if (q.length > 46) {
    const [tokens, canisters, subnets] = await db.batch<Record<string, string | number | null>>([
      db.prepare("SELECT id, symbol, name FROM tokens WHERE hidden = 0 AND id = ?").bind(q),
      db.prepare("SELECT id, label, role FROM canisters WHERE id = ?").bind(q),
      db.prepare("SELECT id, type, label FROM subnets WHERE id = ?").bind(q),
    ]);
    return { tokens: tokens!.results, canisters: canisters!.results, proposals: [] as Record<string, string | number | null>[], subnets: subnets!.results };
  }
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const [tokens, canisters, proposals, subnets] = await db.batch<Record<string, string | number | null>>([
    db.prepare("SELECT id, symbol, name FROM tokens WHERE hidden = 0 AND (symbol LIKE ?1 OR name LIKE ?1 OR id LIKE ?1) ORDER BY (symbol = ?2 COLLATE NOCASE) DESC, LENGTH(symbol) ASC LIMIT 6").bind(like, q),
    db.prepare("SELECT id, label, role FROM canisters WHERE label LIKE ?1 OR id LIKE ?1 LIMIT 6").bind(like),
    db.prepare("SELECT id, title, status FROM proposals WHERE title LIKE ?1 OR CAST(id AS TEXT) LIKE ?2 ORDER BY id DESC LIMIT 5").bind(like, `${q}%`),
    db.prepare("SELECT id, type, label FROM subnets WHERE id LIKE ?1 OR label LIKE ?1 LIMIT 4").bind(like),
  ]);
  return { tokens: tokens!.results, canisters: canisters!.results, proposals: proposals!.results, subnets: subnets!.results };
}
