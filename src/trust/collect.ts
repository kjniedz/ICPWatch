// Trust score collector (hourly). Gathers every input with a bounded number of reads, scores each token with the
// pure scorer in ./score, and stores the result with the methodology version.
//
// Cost per run in steady state:
//   D1   3 read round trips for the registry, 1 for cached holder snapshots, then at most `maxHolderRefresh`
//        ledgers get their holder snapshot rebuilt (2 statements each, batched) plus one batched label lookup,
//        and one batched upsert of the scores.
//   IC   anonymous queries only. icrc1_minting_account is re-read every 7 days per ledger (errors retry after
//        6 hours), one-hop controller reads (certified read_state) every 7 days. Both capped per run.
import type { Env } from "../env";
import { pool, readCanisterState } from "../lib/ic";
import { indexProgressAll, type IndexProgress } from "../indexer/queries";
import { mintingAccount } from "./ic";
import {
  BLACKHOLES, DAY, METHOD_VERSION, NNS_ROOT, classifyControl, looksLikeCanister, scoreToken,
  type ControlClass, type HolderAccount, type MinterContext, type TrustInputs, type TrustResult,
} from "./score";

/** The labels contract (src/labels/index.ts). Passed in by the caller so this module does not depend on how labels are built. */
export interface LabelLike { id: string; name: string; category: string }
export interface LabelsPort {
  labelsFor(db: D1Database, ids: string[]): Promise<Map<string, LabelLike>>;
  isTreasuryOrPool(l: LabelLike | null | undefined): boolean;
}

export interface TrustRunOptions {
  labels?: LabelsPort;
  /** Unix seconds, for tests and replays. */
  now?: number;
  maxMintReads?: number;
  maxControllerReads?: number;
  maxHolderRefresh?: number;
  /** Rebuild every holder snapshot regardless of age. */
  forceHolders?: boolean;
}

export interface TrustRunStats {
  tokens: number; scored: number; insufficient: number; dead: number; grades: Record<string, number>;
  mintReads: number; mintErrors: number; controllerReads: number; holderRefreshes: number; holdersUsable: number; ms: number;
}

const MINT_REFRESH_S = 7 * DAY;
const MINT_RETRY_S = 6 * 3600;
const CONTROLLERS_REFRESH_S = 7 * DAY;
const HOLDERS_REFRESH_S = 6 * 3600;
const HOLDERS_TOP = 60;
const HISTORY_WINDOW_S = 400 * DAY;
const BATCH = 40;

interface TokenR { id: string; symbol: string; kind: string; decimals: number; total_supply: string | null }
interface CanR { id: string; token_id: string | null; role: string; label: string; controllers: string | null; health: string; run_status: string; measured_at: number | null; probed_at: number | null }
interface MarketR { token_id: string; tvl_usd: number | null; mcap_usd: number | null; updated_at: number }
interface PoolR { id: string; token0: string; token1: string; tvl_usd: number }
interface MintR { token_id: string; status: string; owner: string | null; subaccount: string | null; error: string | null; read_at: number | null; checked_at: number }
interface CtrlR { canister_id: string; controllers: string | null; error: string | null; read_at: number | null; checked_at: number }
interface HistR { canister_id: string; ts: number; kind: string; controllers: string | null }
interface HistStateR { canister_id: string; checked_at: number; error: string | null }
interface HoldersR { token_id: string; next_block: number; as_of: number | null; data: string; computed_at: number }
interface HolderSnapshot { supply: number | null; holderCount: number | null; top: HolderAccount[] }

const parseList = (s: string | null | undefined): string[] | null => {
  if (s == null) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
};

const chunks = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function batched(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result<Record<string, unknown>>[]> {
  const out: D1Result<Record<string, unknown>>[] = [];
  for (const c of chunks(stmts, BATCH)) out.push(...(await db.batch<Record<string, unknown>>(c)));
  return out;
}

/** Tables owned by other modules may not exist yet on a fresh database. A missing table is an empty result, not a failed run. */
async function optional<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (/no such (table|column)/i.test(String(e))) return fallback;
    throw e;
  }
}

/** Holder data is presentable only for a complete index, and only a reconciled one once the indexer reports `trusted`. */
export function holderDataUsable(p: IndexProgress | null | undefined): boolean {
  if (!p || !p.complete) return false;
  const trusted = (p as IndexProgress & { trusted?: boolean | null }).trusted;
  return trusted == null ? true : trusted === true;
}

function holderReason(p: IndexProgress | undefined): string {
  if (!p) return "ICPWatch has not started indexing this ledger, so holder balances are not known.";
  if (p.status === "unsupported") return "This ledger does not expose a block API ICPWatch can replay, so holder balances cannot be derived independently.";
  if (p.status === "error") return `The block index for this ledger is failing${p.error ? ` (${p.error.slice(0, 120)})` : ""}, so holder balances are not known.`;
  if (!p.complete) return `ICPWatch is still replaying this ledger's blocks (${p.percent}% done). Holder balances are only used once the replay is complete.`;
  return "The block index for this ledger is complete but its balances have not been reconciled against the ledger's total supply yet, so they are not used.";
}

const CATEGORY_REASON: Record<string, string> = {
  sns_governance: "SNS governance (treasury and staked neurons)", sns_treasury: "SNS treasury", sns_swap: "SNS swap canister", dex_pool: "DEX pool", dex: "DEX",
  minter: "Minter", burn: "Burn address", exchange: "Exchange custody", bridge: "Bridge custody",
};
/** Custody accounts hold many users' funds, so they are not one holder's position either. */
const ALSO_EXCLUDED = new Set(["exchange", "bridge"]);

export const GOVERNANCE_REASON = CATEGORY_REASON.sns_governance!;

export async function collectTrust(env: Env, opts: TrustRunOptions = {}): Promise<TrustRunStats> {
  const started = Date.now();
  const db = env.DB;
  const ts = opts.now ?? Math.floor(started / 1000);

  // ---- 1. registry reads -------------------------------------------------------------------------------------
  const [tokensR, canR, marketR, poolsR] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT id, symbol, kind, decimals, total_supply FROM tokens WHERE hidden = 0"),
    db.prepare("SELECT id, token_id, role, label, controllers, health, run_status, measured_at, probed_at FROM canisters"),
    db.prepare("SELECT token_id, tvl_usd, mcap_usd, updated_at FROM market"),
    db.prepare("SELECT id, token0, token1, tvl_usd FROM pools WHERE tvl_usd > 0"),
  ]);
  const tokens = tokensR!.results as unknown as TokenR[];
  const canisters = canR!.results as unknown as CanR[];
  const market = new Map((marketR!.results as unknown as MarketR[]).map((m) => [m.token_id, m]));
  const pools = poolsR!.results as unknown as PoolR[];

  const [mintRows, ctrlRows, holderRows] = (await db.batch<Record<string, unknown>>([
    db.prepare("SELECT token_id, status, owner, subaccount, error, read_at, checked_at FROM trust_minting"),
    db.prepare("SELECT canister_id, controllers, error, read_at, checked_at FROM trust_controllers"),
    db.prepare("SELECT token_id, next_block, as_of, data, computed_at FROM trust_holders"),
  ])).map((r) => r.results) as unknown as [MintR[], CtrlR[], HoldersR[]];

  const since = ts - HISTORY_WINDOW_S;
  const [histRows, histState] = await optional(async () => {
    const [a, b] = await db.batch<Record<string, unknown>>([
      db.prepare("SELECT canister_id, ts, kind, controllers FROM canister_history WHERE canister_id IN (SELECT id FROM tokens WHERE hidden = 0) AND kind IN ('controllers_change','install','reinstall','upgrade') AND ts > ?").bind(since),
      db.prepare("SELECT canister_id, checked_at, error FROM canister_history_state WHERE canister_id IN (SELECT id FROM tokens WHERE hidden = 0)"),
    ]);
    return [a!.results as unknown as HistR[], b!.results as unknown as HistStateR[]] as const;
  }, [[], []] as const);
  const progress = new Map((await optional(() => indexProgressAll(db), [] as IndexProgress[])).map((p) => [p.ledger, p]));

  // ---- 2. minting accounts (cached, bounded) ---------------------------------------------------------------------
  const minting = new Map(mintRows.map((m) => [m.token_id, m]));
  const byId = new Map(canisters.map((c) => [c.id, c]));
  const dueMint = tokens
    .filter((t) => {
      const m = minting.get(t.id);
      if (!m) return true;
      return m.error ? ts - m.checked_at > MINT_RETRY_S : ts - (m.read_at ?? 0) > MINT_REFRESH_S;
    })
    // A ledger Lifeline already knows to be frozen or gone cannot answer: skip the call, keep whatever was cached.
    .filter((t) => !["frozen", "gone"].includes(byId.get(t.id)?.health ?? "") || !minting.has(t.id))
    .sort((a, b) => (minting.get(a.id)?.checked_at ?? 0) - (minting.get(b.id)?.checked_at ?? 0))
    .slice(0, opts.maxMintReads ?? 60);
  let mintErrors = 0;
  if (dueMint.length) {
    const res = await pool(dueMint, 6, (t) => mintingAccount(env.IC_HOST, t.id));
    const up = db.prepare(`INSERT INTO trust_minting (token_id, status, owner, subaccount, error, read_at, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT (token_id) DO UPDATE SET status = CASE WHEN excluded.status = 'error' AND trust_minting.read_at IS NOT NULL THEN trust_minting.status ELSE excluded.status END,
        owner = CASE WHEN excluded.status = 'error' THEN trust_minting.owner ELSE excluded.owner END,
        subaccount = CASE WHEN excluded.status = 'error' THEN trust_minting.subaccount ELSE excluded.subaccount END,
        error = excluded.error, read_at = COALESCE(excluded.read_at, trust_minting.read_at), checked_at = excluded.checked_at`);
    const stmts: D1PreparedStatement[] = [];
    res.forEach((r, n) => {
      const t = dueMint[n]!;
      const prev = minting.get(t.id);
      if (r.status === "fulfilled") {
        const row: MintR = { token_id: t.id, status: r.value ? "ok" : "none", owner: r.value?.owner ?? null, subaccount: r.value?.subaccount ?? null, error: null, read_at: ts, checked_at: ts };
        minting.set(t.id, row);
        stmts.push(up.bind(t.id, row.status, row.owner, row.subaccount, null, ts, ts));
      } else {
        mintErrors++;
        const error = String(r.reason instanceof Error ? r.reason.message : r.reason).replace(/\s+/g, " ").slice(0, 300);
        minting.set(t.id, prev?.read_at ? { ...prev, error, checked_at: ts } : { token_id: t.id, status: "error", owner: null, subaccount: null, error, read_at: null, checked_at: ts });
        stmts.push(up.bind(t.id, "error", null, null, error, null, ts));
      }
    });
    await batched(db, stmts);
  }

  // ---- 3. one hop: who controls the controllers and the minters (cached, bounded) -------------------------------
  const knownControllers = new Map<string, string[]>();
  for (const c of canisters) {
    const list = parseList(c.controllers);
    if (list) knownControllers.set(c.id, list);
  }
  const ctrlCache = new Map(ctrlRows.map((r) => [r.canister_id, r]));
  for (const r of ctrlRows) {
    const list = parseList(r.controllers);
    if (list && !knownControllers.has(r.canister_id)) knownControllers.set(r.canister_id, list);
  }
  const snsRoots = new Set(canisters.filter((c) => c.role === "root").map((c) => c.id));
  const snsGovernances = new Set(canisters.filter((c) => c.role === "governance").map((c) => c.id));
  const wanted = new Set<string>();
  const want = (id: string | null | undefined) => {
    if (!id || !looksLikeCanister(id) || id === NNS_ROOT || BLACKHOLES.includes(id) || snsRoots.has(id) || snsGovernances.has(id) || byId.has(id)) return;
    const cached = ctrlCache.get(id);
    if (cached && ts - cached.checked_at < (cached.error ? MINT_RETRY_S : CONTROLLERS_REFRESH_S)) return;
    wanted.add(id);
  };
  for (const t of tokens) {
    for (const p of parseList(byId.get(t.id)?.controllers) ?? []) if (p !== t.id) want(p);
    want(minting.get(t.id)?.owner);
  }
  const hopIds = [...wanted].sort((a, b) => (ctrlCache.get(a)?.checked_at ?? 0) - (ctrlCache.get(b)?.checked_at ?? 0)).slice(0, opts.maxControllerReads ?? 12);
  if (hopIds.length) {
    // Certified reads verify a BLS signature each, so they run with low concurrency.
    const res = await pool(hopIds, 3, (id) => readCanisterState(env.IC_HOST, id));
    const up = db.prepare(`INSERT INTO trust_controllers (canister_id, controllers, error, read_at, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (canister_id) DO UPDATE SET controllers = COALESCE(excluded.controllers, trust_controllers.controllers), error = excluded.error,
        read_at = COALESCE(excluded.read_at, trust_controllers.read_at), checked_at = excluded.checked_at`);
    const stmts: D1PreparedStatement[] = [];
    res.forEach((r, n) => {
      const id = hopIds[n]!;
      if (r.status === "fulfilled" && r.value.controllers) {
        knownControllers.set(id, r.value.controllers);
        stmts.push(up.bind(id, JSON.stringify(r.value.controllers), null, ts, ts));
      } else {
        const error = r.status === "rejected" ? String(r.reason instanceof Error ? r.reason.message : r.reason).replace(/\s+/g, " ").slice(0, 300) : "controllers not readable";
        stmts.push(up.bind(id, null, error, null, ts));
      }
    });
    await batched(db, stmts);
  }

  // ---- 4. holder snapshots (cached, bounded) ---------------------------------------------------------------------
  const snapshots = new Map<string, { snap: HolderSnapshot; asOf: number | null; nextBlock: number }>();
  for (const r of holderRows) {
    try {
      snapshots.set(r.token_id, { snap: JSON.parse(r.data) as HolderSnapshot, asOf: r.as_of, nextBlock: r.next_block });
    } catch {
      /* rebuilt below */
    }
  }
  const computedAt = new Map(holderRows.map((r) => [r.token_id, r.computed_at]));
  const poolCanisters = new Set<string>();
  for (const p of pools) {
    const id = p.id.slice(p.id.indexOf(":") + 1);
    if (looksLikeCanister(id)) poolCanisters.add(id);
  }
  const roleIds = (tokenId: string, role: string) => canisters.filter((c) => c.token_id === tokenId && c.role === role).map((c) => c.id);
  const minterIds = new Set(canisters.filter((c) => c.role === "minter").map((c) => c.id));

  const usable = tokens.filter((t) => holderDataUsable(progress.get(t.id)));
  const dueHolders = usable
    .filter((t) => {
      const at = computedAt.get(t.id);
      if (opts.forceHolders || at == null || !snapshots.has(t.id)) return true;
      return ts - at > HOLDERS_REFRESH_S && snapshots.get(t.id)!.nextBlock !== progress.get(t.id)!.nextBlock;
    })
    .sort((a, b) => (computedAt.get(a.id) ?? 0) - (computedAt.get(b.id) ?? 0))
    .slice(0, opts.maxHolderRefresh ?? 25);

  if (dueHolders.length) {
    const stmts: D1PreparedStatement[] = [];
    const plan: { token: TokenR; gov: string[]; topAt: number; govAt: number[] }[] = [];
    for (const t of dueHolders) {
      const gov = roleIds(t.id, "governance");
      const notGov = gov.length ? ` AND owner NOT IN (${gov.map(() => "?").join(",")})` : "";
      const topAt = stmts.push(db.prepare(`SELECT account, owner, balance FROM balances WHERE ledger = ? AND balance > 0${notGov} ORDER BY balance DESC LIMIT ${HOLDERS_TOP}`).bind(t.id, ...gov)) - 1;
      // Every neuron stake and the treasury are subaccounts of governance: one aggregate instead of thousands of rows.
      const govAt = gov.map((g) => stmts.push(db.prepare("SELECT COUNT(*) n, SUM(balance) s FROM balances WHERE owner = ? AND ledger = ? AND balance > 0").bind(g, t.id)) - 1);
      plan.push({ token: t, gov, topAt, govAt });
    }
    const res = await batched(db, stmts);
    const rowsOf = (n: number) => res[n]!.results as unknown as { account: string; owner: string; balance: number }[];
    const allAccounts = [...new Set(plan.flatMap((p) => rowsOf(p.topAt).map((r) => r.account)))];
    const labels = opts.labels ? await optional(() => opts.labels!.labelsFor(db, allAccounts), new Map<string, LabelLike>()) : new Map<string, LabelLike>();

    const up = db.prepare("INSERT OR REPLACE INTO trust_holders (token_id, next_block, as_of, data, computed_at) VALUES (?, ?, ?, ?, ?)");
    const writes: D1PreparedStatement[] = [];
    for (const p of plan) {
      const t = p.token;
      const prog = progress.get(t.id)!;
      const swaps = new Set(roleIds(t.id, "swap"));
      const top: HolderAccount[] = [];
      p.gov.forEach((g, n) => {
        const agg = res[p.govAt[n]!]!.results[0] as { n: number | null; s: number | null } | undefined;
        if (agg?.s && agg.s > 0) top.push({ account: g, owner: g, balance: agg.s, excluded: GOVERNANCE_REASON, name: byId.get(g)?.label ?? null, accounts: agg.n ?? 1 });
      });
      for (const r of rowsOf(p.topAt)) {
        const label = labels.get(r.account) ?? null;
        let excluded: string | null = null;
        if (swaps.has(r.owner)) excluded = CATEGORY_REASON.sns_swap!;
        else if (poolCanisters.has(r.owner)) excluded = CATEGORY_REASON.dex_pool!;
        else if (minterIds.has(r.owner)) excluded = CATEGORY_REASON.minter!;
        else if (label && (opts.labels!.isTreasuryOrPool(label) || ALSO_EXCLUDED.has(label.category))) excluded = CATEGORY_REASON[label.category] ?? "Protocol held";
        top.push({ account: r.account, owner: r.owner, balance: r.balance, excluded, name: label?.name ?? (poolCanisters.has(r.owner) ? "DEX pool" : null) });
      }
      top.sort((a, b) => b.balance - a.balance);
      const supplyRaw = t.total_supply && /^\d+$/.test(t.total_supply) && t.total_supply !== "0" ? t.total_supply : null;
      const snap: HolderSnapshot = { supply: supplyRaw ? Number(BigInt(supplyRaw)) / 10 ** (t.decimals ?? prog.decimals) : null, holderCount: prog.holders, top };
      snapshots.set(t.id, { snap, asOf: prog.asOfTs, nextBlock: prog.nextBlock });
      writes.push(up.bind(t.id, prog.nextBlock, prog.asOfTs, JSON.stringify(snap), ts));
    }
    await batched(db, writes);
  }

  // ---- 5. score ----------------------------------------------------------------------------------------------------
  const histByLedger = new Map<string, HistR[]>();
  for (const h of histRows) (histByLedger.get(h.canister_id) ?? histByLedger.set(h.canister_id, []).get(h.canister_id)!).push(h);
  const histStateBy = new Map(histState.map((h) => [h.canister_id, h]));
  const poolsByToken = new Map<string, number[]>();
  for (const p of pools) for (const id of new Set([p.token0, p.token1])) (poolsByToken.get(id) ?? poolsByToken.set(id, []).get(id)!).push(p.tvl_usd);
  const groupByToken = new Map<string, CanR[]>();
  for (const c of canisters) if (c.token_id && (c.role === "ledger" || c.role === "index" || c.role === "archive")) (groupByToken.get(c.token_id) ?? groupByToken.set(c.token_id, []).get(c.token_id)!).push(c);

  const stats: TrustRunStats = { tokens: tokens.length, scored: 0, insufficient: 0, dead: 0, grades: {}, mintReads: dueMint.length, mintErrors, controllerReads: hopIds.length, holderRefreshes: dueHolders.length, holdersUsable: usable.length, ms: 0 };
  const upScore = db.prepare("INSERT OR REPLACE INTO trust_scores (token_id, score, grade, insufficient, factors, summary, method_version, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const writes: D1PreparedStatement[] = [];
  for (const t of tokens) {
    const context: MinterContext = { snsRoots, snsGovernances, knownControllers, tokenKind: t.kind };
    const ledger = byId.get(t.id) ?? null;
    const m = minting.get(t.id) ?? null;
    const prog = progress.get(t.id);
    const snap = snapshots.get(t.id);
    const holdersOk = holderDataUsable(prog) && !!snap;
    const mk = market.get(t.id);
    const hs = histStateBy.get(t.id);
    const hist = histByLedger.get(t.id) ?? [];
    const inputs: TrustInputs = {
      tokenId: t.id, symbol: t.symbol, kind: t.kind, now: ts, context,
      ledger: ledger ? { controllers: parseList(ledger.controllers), runStatus: ledger.run_status, health: ledger.health, asOf: ledger.measured_at ?? ledger.probed_at } : null,
      minting: m ? { status: m.read_at ? (m.status === "none" ? "none" : "ok") : (m.status as "ok" | "none" | "error"), owner: m.owner, asOf: m.read_at, error: m.error } : null,
      holders: holdersOk
        ? { usable: true, reason: null, asOf: snap!.asOf ?? prog!.updatedAt, supply: snap!.snap.supply, holderCount: snap!.snap.holderCount, top: snap!.snap.top }
        : { usable: false, reason: holderDataUsable(prog) ? "The holder snapshot for this ledger is queued and will be built on one of the next hourly runs." : holderReason(prog), asOf: prog?.asOfTs ?? null, supply: null, holderCount: null, top: [] },
      liquidity: mk ? { tvlUsd: mk.tvl_usd, mcapUsd: mk.mcap_usd, pools: poolsByToken.get(t.id) ?? [], asOf: mk.updated_at }
        // No market row after a markets run means no pool holds this token: that is a measurement (zero), not a gap.
        : market.size ? { tvlUsd: 0, mcapUsd: null, pools: poolsByToken.get(t.id) ?? [], asOf: Math.max(...[...market.values()].map((x) => x.updated_at)) } : null,
      canisters: (groupByToken.get(t.id) ?? []).map((c) => ({ id: c.id, role: c.role as "ledger" | "index" | "archive", label: c.label, health: c.health, runStatus: c.run_status, asOf: c.measured_at ?? c.probed_at })),
      history: hs
        ? {
            known: !hs.error || hist.length > 0, checkedAt: hs.checked_at,
            controllerChanges: hist.filter((h) => h.kind === "controllers_change").map((h) => ({ ts: h.ts, toClass: classifyControl(t.id, parseList(h.controllers) ?? [], context).cls as ControlClass })),
            deployments: hist.filter((h) => h.kind !== "controllers_change").map((h) => ({ ts: h.ts, kind: h.kind as "install" | "reinstall" | "upgrade" })),
          }
        : null,
    };
    const r = scoreToken(inputs);
    stats.grades[r.grade] = (stats.grades[r.grade] ?? 0) + 1;
    if (r.dead) stats.dead++;
    else if (r.insufficient) stats.insufficient++;
    else stats.scored++;
    writes.push(upScore.bind(t.id, r.score, r.grade, r.insufficient ? 1 : 0, JSON.stringify(r.factors), JSON.stringify(summaryOf(r)), METHOD_VERSION, ts));
  }
  await batched(db, writes);
  stats.ms = Date.now() - started;
  return stats;
}

export type TrustSummary = Pick<TrustResult, "tier" | "rawScore" | "band" | "caps" | "reasons" | "dead" | "pointsEarned" | "pointsMeasured" | "pointsPossible">;

export const summaryOf = (r: TrustResult): TrustSummary => ({
  tier: r.tier, rawScore: r.rawScore, band: r.band, caps: r.caps, reasons: r.reasons, dead: r.dead, pointsEarned: r.pointsEarned, pointsMeasured: r.pointsMeasured, pointsPossible: r.pointsPossible,
});
