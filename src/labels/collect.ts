// The label collector. Runs hourly and is idempotent: every run re-derives the verifiable labels from
// on-chain facts and the registry, upserts them (a weaker confidence never overwrites a stronger one),
// and turns flow heuristics on the large-transfer feed into REVIEW QUEUE entries, never live labels.
import type { Env } from "../env";
import { now } from "../lib/format";
import { ICP_LEDGER, pool } from "../lib/ic";
import { BURN_SEEDS, NNS_SEEDS, OTHER_SEEDS, ckLabels, icpAccountLabels, icpMintingLabel, neuronLabels, poolLabels, registryLabels, snsLabels, unconfirmedPoolLabels, type CkFacts, type RegistryCanister } from "./derive";
import { exchangeLabels } from "./exchanges";
import { analyzeFlows, type FlowTransfer } from "./flows";
import { feeCollectors, icpswapPools, knownNeurons, mintingAccount, snsCanisters } from "./ic";
import { upsertLabels, type LabelRow } from "./store";

export interface LabelRunStats { sns: number; ck: number; pools: number; neurons: number; derived: number; written: number; unchanged: number; blocked: number; flowCandidates: number; errors: number }

export async function collectLabels(env: Env): Promise<LabelRunStats> {
  const db = env.DB;
  const host = env.IC_HOST;
  const ts = now();
  const stats: LabelRunStats = { sns: 0, ck: 0, pools: 0, neurons: 0, derived: 0, written: 0, unchanged: 0, blocked: 0, flowCandidates: 0, errors: 0 };
  const rows: LabelRow[] = [...NNS_SEEDS, ...BURN_SEEDS, ...OTHER_SEEDS, ...exchangeLabels()];

  const [tokens, canisters, poolRows] = await Promise.all([
    db.prepare("SELECT id, symbol, name, kind, sns_root FROM tokens WHERE hidden = 0").all<{ id: string; symbol: string; name: string; kind: string; sns_root: string | null }>().then((r) => r.results),
    db.prepare("SELECT id, token_id, role, label, discovered_via FROM canisters").all<RegistryCanister>().then((r) => r.results),
    db.prepare("SELECT id, symbol0, symbol1 FROM pools").all<{ id: string; symbol0: string | null; symbol1: string | null }>().then((r) => r.results),
  ]);
  const symbols = new Map(tokens.map((t) => [t.id, t.symbol]));
  const dappNames = new Map(canisters.filter((c) => c.role === "dapp").map((c) => [c.id, c.label]));

  // SNS canister sets straight from each root (fresh archives and dapps), registry as the fallback.
  const snsTokens = tokens.filter((t) => t.kind === "sns" && t.sns_root);
  const snsResults = await pool(snsTokens, 6, async (t) => {
    const c = await snsCanisters(host, t.sns_root!);
    return snsLabels({ token_id: t.id, name: t.name, symbol: t.symbol, canisters: c, source: `SNS root ${t.sns_root} list_sns_canisters`, dappNames });
  });
  const covered = new Set<string>();
  snsResults.forEach((r, i) => {
    if (r.status === "fulfilled") {
      rows.push(...r.value);
      covered.add(snsTokens[i]!.id);
      stats.sns++;
    } else stats.errors++;
  });
  rows.push(...registryLabels(canisters.filter((c) => !c.token_id || !covered.has(c.token_id))));

  // ck tokens: the minter is whoever the ledger names as its minting account; fee collectors from the index.
  const ck = tokens.filter((t) => t.kind === "ck");
  const ckResults = await pool(ck, 6, async (t): Promise<CkFacts> => {
    const index = canisters.find((c) => c.token_id === t.id && c.role === "index")?.id;
    const [minting, fees] = await Promise.all([mintingAccount(host, t.id), index ? feeCollectors(host, index).catch(() => []) : Promise.resolve([])]);
    return { token_id: t.id, symbol: t.symbol, minting, feeCollectors: fees };
  });
  const ckFacts = ckResults.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  stats.ck = ckFacts.length;
  stats.errors += ckResults.length - ckFacts.length;
  rows.push(...ckLabels(ckFacts));
  try {
    const m = await mintingAccount(host, ICP_LEDGER);
    if (m) rows.push(icpMintingLabel(m));
  } catch {
    stats.errors++;
  }

  // DEX pools: the factory's own list is verified, the info API's extras are inferred.
  try {
    const factory = await icpswapPools(host);
    rows.push(...poolLabels(factory, symbols));
    rows.push(...unconfirmedPoolLabels(poolRows, new Set(factory.map((p) => p.canister))));
    stats.pools = factory.length;
  } catch {
    stats.errors++;
  }

  try {
    const neurons = await knownNeurons(host);
    rows.push(...neuronLabels(neurons));
    stats.neurons = neurons.length;
  } catch {
    stats.errors++;
  }

  rows.push(...icpAccountLabels(rows));
  stats.derived = rows.length;
  const up = await upsertLabels(db, rows, ts);
  stats.written = up.written;
  stats.unchanged = up.unchanged;
  stats.blocked = up.blocked;

  stats.flowCandidates = await flowCandidates(env, ts).catch((e) => {
    console.warn("labels flows", String(e).slice(0, 200));
    stats.errors++;
    return 0;
  });
  return stats;
}

/**
 * Exchange detection on the large-transfer feed. Findings become review-queue entries (origin 'flow'), one
 * per account, refreshed in place. Nothing goes live from here without a reviewer, whatever the score.
 */
async function flowCandidates(env: Env, ts: number): Promise<number> {
  const db = env.DB;
  const rows = (await db.prepare("SELECT ledger, from_account, to_account, amount, ts FROM transfers_big WHERE kind = 'transfer' AND ts > ? ORDER BY ledger, ts").bind(ts - 90 * 86400).all<{ ledger: string; from_account: string | null; to_account: string | null; amount: number; ts: number }>()).results;
  const labeled = new Set((await db.prepare("SELECT id FROM labels").all<{ id: string }>()).results.map((r) => r.id));
  const byLedger = new Map<string, FlowTransfer[]>();
  for (const r of rows) {
    let arr = byLedger.get(r.ledger);
    if (!arr) byLedger.set(r.ledger, (arr = []));
    arr.push({ from: r.from_account, to: r.to_account, amount: r.amount, ts: r.ts });
  }
  const stmts: D1PreparedStatement[] = [];
  let n = 0;
  for (const [ledger, transfers] of byLedger) {
    const f = analyzeFlows(transfers, { exclude: (a) => labeled.has(a) });
    for (const h of f.hotWallets) {
      const evidence = JSON.stringify({ ledger, reasons: h.reasons, overwhelming: h.overwhelming, depositAddresses: h.depositAddresses.slice(0, 20), stats: h.stats });
      stmts.push(
        db.prepare(
          `INSERT INTO label_submissions (target_id, name, category, evidence_url, note, submitter_contact, origin, status, created_at)
           VALUES (?1, ?2, 'exchange', NULL, ?3, NULL, 'flow', 'pending', ?4)
           ON CONFLICT (target_id) WHERE origin = 'flow' DO UPDATE SET note = excluded.note, created_at = excluded.created_at WHERE label_submissions.status = 'pending'`,
        ).bind(h.account, `Exchange hot wallet? (${h.overwhelming ? "strong" : "weak"} flow pattern)`, evidence, ts),
      );
      n++;
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return n;
}
