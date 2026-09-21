// Discovery collector. Runs hourly.
// Builds the token registry and, for every token, its canister group: ledger, index, and ALL archives.
// Archives are re-discovered from the ledger on every run, so a newly spawned archive is watched
// within the hour without anyone adding it.
import type { Env } from "../env";
import { EM_DASH, now } from "../lib/format";
import { ICP_INDEX, ICP_LEDGER, ckSuites, discoverArchives, indexOf, ledgerMeta, pool, readCanisterState, totalSupply } from "../lib/ic";
import { batchAll } from "./lifeline";
import { SEED_TOKENS, type SeedToken } from "./seed";

const SNS_AGGREGATOR = "https://3r4gx-wqaaa-aaaaq-aaaia-cai.icp0.io";

interface SnsEntry {
  canister_ids: { root_canister_id: string; governance_canister_id: string; index_canister_id: string; swap_canister_id: string; ledger_canister_id: string };
  list_sns_canisters: { dapps: string[]; archives: string[] };
  meta: { url: string | null; name: string | null; description: string | null };
  icrc1_metadata: [string, { Text?: string; Nat?: (number | string)[] }][];
  icrc1_fee: (number | string)[];
  icrc1_total_supply: number | string;
  lifecycle: { lifecycle: number } | null;
}

interface TokenUpsert {
  id: string; symbol: string; name: string; decimals: number; fee: string | null; kind: string; snsRoot: string | null; logo: string | null;
  description: string | null; url: string | null; totalSupply: string | null; via: string;
}
interface CanisterUpsert { id: string; tokenId: string | null; role: string; label: string; via: string; snsRoot: string | null; hint: string | null }

export interface DiscoveryStats { sns: number; ck: number; community: number; tokens: number; canisters: number; newCanisters: number; archives: number; errors: number }

export async function collectDiscovery(env: Env): Promise<DiscoveryStats> {
  const ts = now();
  const host = env.IC_HOST;
  const stats: DiscoveryStats = { sns: 0, ck: 0, community: 0, tokens: 0, canisters: 0, newCanisters: 0, archives: 0, errors: 0 };
  const tokens = new Map<string, TokenUpsert>();
  const canisters = new Map<string, CanisterUpsert>();
  const addCanister = (c: CanisterUpsert) => {
    const prev = canisters.get(c.id);
    // A token ledger that is also listed as an SNS dapp (nICP, GLDT) keeps its ledger role and gains the SNS root as a status source.
    if (prev) canisters.set(c.id, { ...prev, snsRoot: prev.snsRoot ?? c.snsRoot, hint: prev.hint ?? c.hint });
    else canisters.set(c.id, c);
  };

  // 1. SNS tokens from the on-chain SNS aggregator canister. Pages carry inline logos, so they are big.
  for (let page = 0; page < 30; page++) {
    const res = await fetch(`${SNS_AGGREGATOR}/v1/sns/list/page/${page}/slow.json`);
    if (!res.ok) break;
    const entries = (await res.json()) as SnsEntry[];
    for (const e of entries) {
      if (e.lifecycle?.lifecycle !== 3) continue; // committed only: aborted launches have no live token
      const ids = e.canister_ids;
      const md = new Map(e.icrc1_metadata.map(([k, v]) => [k, v]));
      const symbol = md.get("icrc1:symbol")?.Text ?? "?";
      const ledger = ids.ledger_canister_id;
      const root = ids.root_canister_id;
      tokens.set(ledger, {
        id: ledger, symbol, name: e.meta.name ?? md.get("icrc1:name")?.Text ?? symbol, decimals: Number(md.get("icrc1:decimals")?.Nat?.[0] ?? 8),
        fee: e.icrc1_fee?.[0] != null ? String(e.icrc1_fee[0]) : null, kind: "sns", snsRoot: root, logo: `/logo/${ledger}`,
        description: e.meta.description?.replace(EM_DASH, " - ").slice(0, 600) ?? null, url: e.meta.url ?? null,
        totalSupply: e.icrc1_total_supply != null ? String(BigInt(Math.round(Number(e.icrc1_total_supply)))) : null, via: "sns-aggregator",
      });
      const base = { via: "sns-aggregator", snsRoot: root, hint: "sns-root" };
      addCanister({ id: ledger, tokenId: ledger, role: "ledger", label: `${symbol} Ledger`, ...base });
      addCanister({ id: ids.index_canister_id, tokenId: ledger, role: "index", label: `${symbol} Index`, ...base });
      addCanister({ id: root, tokenId: ledger, role: "root", label: `${symbol} SNS Root`, ...base });
      addCanister({ id: ids.governance_canister_id, tokenId: ledger, role: "governance", label: `${symbol} Governance`, ...base });
      addCanister({ id: ids.swap_canister_id, tokenId: ledger, role: "swap", label: `${symbol} Swap`, ...base });
      e.list_sns_canisters.archives.forEach((a, i) => addCanister({ id: a, tokenId: ledger, role: "archive", label: `${symbol} Archive #${i + 1}`, ...base }));
      e.list_sns_canisters.dapps.forEach((d, i) => addCanister({ id: d, tokenId: ledger, role: "dapp", label: `${e.meta.name ?? symbol} Dapp #${i + 1}`, ...base }));
      stats.sns++;
    }
    if (entries.length < 10) break;
  }

  // 2. ICP plus the ck suites. ckBTC and ICP are not in the orchestrator, so they are seeded.
  const seeds: SeedToken[] = [...SEED_TOKENS];
  try {
    for (const s of await ckSuites(host)) {
      if (seeds.some((x) => x.ledger === s.ledger)) continue;
      seeds.push({ ledger: s.ledger, symbol: s.symbol, name: s.symbol, decimals: 8, kind: "ck", index: s.index, archives: s.archives, hint: "nns-root" });
    }
  } catch (e) {
    stats.errors++;
    console.warn("orchestrator failed", String(e).slice(0, 200));
  }
  // Tokens added by the markets collector (DEX listed) or by listing requests.
  const listed = (await env.DB.prepare("SELECT id, symbol, name, decimals, kind, listed_via FROM tokens WHERE kind IN ('community','ck','native')").all<{ id: string; symbol: string; name: string; decimals: number; kind: string; listed_via: string }>()).results;
  for (const t of listed) {
    if (!seeds.some((s) => s.ledger === t.id) && !tokens.has(t.id)) seeds.push({ ledger: t.id, symbol: t.symbol, name: t.name, decimals: t.decimals, kind: t.kind as SeedToken["kind"], via: t.listed_via });
  }

  // 3. For every non-SNS ledger: metadata, supply, index, archives. All straight from the ledger.
  const results = await pool(seeds, 6, async (s) => {
    if (tokens.has(s.ledger)) return null; // already covered as an SNS token
    let meta: Awaited<ReturnType<typeof ledgerMeta>> | null = null;
    try {
      meta = s.ledger === ICP_LEDGER ? null : await ledgerMeta(host, s.ledger);
    } catch {
      /* frozen or non ICRC ledger: fall back to seed data */
    }
    const [archives, index] = await Promise.all([
      discoverArchives(host, s.ledger).catch(() => [] as string[]),
      s.index !== undefined ? Promise.resolve(s.index) : s.ledger === ICP_LEDGER ? Promise.resolve(ICP_INDEX) : indexOf(host, s.ledger),
    ]);
    const supply = s.ledger === ICP_LEDGER ? await totalSupply(host, s.ledger).catch(() => null) : (meta?.totalSupply ?? null);
    return { s, meta, archives: [...new Set([...(s.archives ?? []), ...archives])].filter((a) => a !== s.ledger), index, supply };
  });
  for (const r of results) {
    if (r.status !== "fulfilled") { stats.errors++; continue; }
    if (!r.value) continue;
    const { s, meta, archives, index, supply } = r.value;
    const symbol = meta?.symbol ?? s.symbol;
    tokens.set(s.ledger, {
      id: s.ledger, symbol, name: s.name !== s.symbol ? s.name : (meta?.name ?? s.name), decimals: meta?.decimals ?? s.decimals, fee: meta?.fee ?? null, kind: s.kind,
      snsRoot: null, logo: `/logo/${s.ledger}`, description: s.description ?? null, url: s.url ?? null, totalSupply: supply, via: s.via ?? "seed",
    });
    const base = { via: "ledger", snsRoot: null, hint: s.hint ?? null };
    addCanister({ id: s.ledger, tokenId: s.ledger, role: "ledger", label: `${symbol} Ledger`, ...base, via: s.via ?? "seed" });
    if (index) addCanister({ id: index, tokenId: s.ledger, role: "index", label: `${symbol} Index`, ...base });
    archives.forEach((a, i) => addCanister({ id: a, tokenId: s.ledger, role: "archive", label: `${symbol} Archive #${i + 1}`, ...base }));
    for (const x of s.extra ?? []) addCanister({ id: x.id, tokenId: s.ledger, role: x.role, label: x.label, ...base, via: "seed" });
    if (s.kind === "ck" || s.kind === "native") stats.ck++; else stats.community++;
  }

  // 4. Persist. Existing rows keep their measurements: only identity fields are updated.
  const existing = new Set((await env.DB.prepare("SELECT id FROM canisters").all<{ id: string }>()).results.map((r) => r.id));
  const stmts: D1PreparedStatement[] = [];
  const upToken = env.DB.prepare(`INSERT INTO tokens (id, symbol, name, decimals, fee, kind, sns_root, logo, description, url, total_supply, supply_at, listed_at, listed_via, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?12)
    ON CONFLICT (id) DO UPDATE SET symbol = ?2, name = ?3, decimals = ?4, fee = COALESCE(?5, fee), kind = ?6, sns_root = ?7, logo = ?8,
      description = COALESCE(?9, description), url = COALESCE(?10, url), total_supply = COALESCE(?11, total_supply),
      supply_at = CASE WHEN ?11 IS NULL THEN supply_at ELSE ?12 END, updated_at = ?12`);
  for (const t of tokens.values()) stmts.push(upToken.bind(t.id, t.symbol, t.name, t.decimals, t.fee, t.kind, t.snsRoot, t.logo, t.description, t.url, t.totalSupply, ts, t.via));
  const upCanister = env.DB.prepare(`INSERT INTO canisters (id, token_id, role, label, discovered_at, discovered_via, sns_root, source_hint)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT (id) DO UPDATE SET token_id = ?2, role = ?3, label = ?4, sns_root = ?7, source_hint = COALESCE(source_hint, ?8)`);
  for (const c of canisters.values()) {
    stmts.push(upCanister.bind(c.id, c.tokenId, c.role, c.label, ts, c.via, c.snsRoot, c.hint));
    if (!existing.has(c.id)) {
      stats.newCanisters++;
      if (c.role === "archive") stats.archives++;
    }
  }
  await batchAll(env.DB, stmts);
  stats.tokens = tokens.size;
  stats.canisters = canisters.size;

  // 5. Certified controllers, module hash, and subnet for canisters that have none yet, a slice per run
  // (each read verifies a BLS certificate, so it is rationed). This is what routes a community token
  // to NNS root or a blackhole as its balance source.
  const missing = (await env.DB.prepare("SELECT id FROM canisters WHERE (controllers IS NULL OR subnet_id IS NULL) AND health != 'gone' ORDER BY (sns_root IS NOT NULL), discovered_at LIMIT 60").all<{ id: string }>()).results;
  const states = await pool(missing, 6, (m) => readCanisterState(host, m.id));
  const st2: D1PreparedStatement[] = [];
  states.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    st2.push(env.DB.prepare("UPDATE canisters SET controllers = COALESCE(?, controllers), module_hash = COALESCE(?, module_hash), subnet_id = COALESCE(?, subnet_id) WHERE id = ?")
      .bind(r.value.controllers ? JSON.stringify(r.value.controllers) : null, r.value.moduleHash, r.value.subnetId, missing[i]!.id));
  });
  await batchAll(env.DB, st2);
  return stats;
}
