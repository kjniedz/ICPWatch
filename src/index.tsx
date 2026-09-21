import { Hono, type Context } from "hono";
import type { Child, FC } from "hono/jsx";
import { channelsConfigured, hmacHex, notifyIncident, safeTargetUrl, send, sendEmail } from "./alerts/notify";
import { accountHref, loadAccount } from "./collectors/accounts";
import { collectDiscovery } from "./collectors/discovery";
import { collectHistory, historyFor, historyLive } from "./collectors/history";
import { collectWhales, holdersCached, type WhaleTransfer } from "./collectors/ledgerApi";
import { collectLifeline, rollupLifeline } from "./collectors/lifeline";
import { collectMarkets } from "./collectors/markets";
import { collectNetwork } from "./collectors/network";
import { collectSns } from "./collectors/sns";
import * as q from "./db/queries";
import { indexJob } from "./indexer";
import { holderStats, indexOverview, indexProgress, largeTransfers, topHolders } from "./indexer/queries";
import type { Env } from "./env";
import { now } from "./lib/format";
import { ALERT_TYPES, EVENT_TYPES } from "./lib/health";
import { enroll, lifeSupportTick, registry as lsRegistry, setCaps, setEnrollmentState, setKillSwitch, status as lsStatus } from "./lifesupport";
import { LifeSupportRegistryPage } from "./pages/lifesupport";
import { ICP_LEDGER, balanceOf, isCanisterId, isPrincipal, ledgerLogo, pool, probe, readCanisterState } from "./lib/ic";
import { renderMarkdown } from "./lib/markdown";
import { AccountNotFound, AccountPage } from "./pages/account";
import { AlertsPage, IncidentsPage, type AlertTarget } from "./pages/alerts";
import { ApiDocs, Changelog, Disclaimer, Docs, Faq, FormPage, HowItWorks, NotFound, Privacy, StatusPage, Terms } from "./pages/content";
import { CanisterPage, TokenPage } from "./pages/detail";
import type { SnsSectionData } from "./pages/sns";
import { HomePage } from "./pages/home";
import { LifelineLive, LifelinePage } from "./pages/lifeline";
import { MarketsPage, type MarketTotals } from "./pages/markets";
import { NewListingsPage, PoolsPage, PortfolioPage, ScreenerPage, SearchPage, UnwatchedCanisterPage, WatchlistPage, WhalesPage, type Holding, type SearchHit } from "./pages/more";
import { NetworkPage, ProposalPage, ProposalsPage, SubnetPage, SubnetsPage, type NetworkStats } from "./pages/network";
import { DataSources } from "./pages/sources";
import { Layout, type PageMeta } from "./ui/layout";

type C = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

const page = (c: C, meta: PageMeta, body: Child, status: 200 | 404 = 200) =>
  c.html(<Layout meta={meta}>{body}</Layout>, status, { "cache-control": "public, max-age=0, s-maxage=20, stale-while-revalidate=60" });

// Edge cache for anonymous GET pages: a popular page is rendered once per 20 seconds per colo.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
    return c.redirect(url.toString(), 301);
  }
  const cacheable = c.req.method === "GET" && !/^\/(api|admin|lifeline\/(live|alerts)|portfolio|search|logo|account)/.test(url.pathname) && !url.search;
  if (!cacheable || url.hostname.endsWith("workers.dev") || url.hostname === "localhost") return next();
  // Stale-while-revalidate by hand: serve whatever is cached instantly, and when it is older than
  // 20 seconds re-render in the background. Nobody waits on D1 or JSX rendering after the first visitor.
  const cache = caches.default;
  const key = new Request(url.toString(), { method: "GET" });
  const refreshing = c.req.header("x-icpwatch-refresh") === "1";
  if (!refreshing) {
    const hit = await cache.match(key);
    if (hit) {
      const age = now() - Number(hit.headers.get("x-rendered-at") ?? 0);
      if (age > 20) c.executionCtx.waitUntil(fetch(url.toString(), { headers: { "x-icpwatch-refresh": "1" } }).then((r) => r.arrayBuffer()).catch(() => undefined));
      return hit;
    }
  }
  await next();
  if (c.res.status === 200) {
    const copy = new Response(c.res.clone().body, c.res);
    copy.headers.set("x-rendered-at", String(now()));
    copy.headers.set("cache-control", "public, max-age=0, s-maxage=600");
    c.executionCtx.waitUntil(cache.put(key, copy));
  }
});

// ---- pages: home + lifeline -------------------------------------------------------------------------

app.get("/", async (c) => {
  const db = c.env.DB;
  const [s, net, totals] = await Promise.all([q.lifelineSummary(db, now()), q.kvGet<NetworkStats>(db, "network:stats"), q.kvGet<MarketTotals>(db, "markets:totals")]);
  return page(c, {
    title: "ICPWatch: markets, network, and canister health for the Internet Computer", path: "/", section: "home",
    description: "Token markets aggregated across ICP DEXs, a fast network explorer, and Lifeline: canister cycle monitoring, freeze alerts, and life support no one else offers.",
    jsonLd: { "@context": "https://schema.org", "@type": "WebSite", name: "ICPWatch", url: "https://icpwatch.com", potentialAction: { "@type": "SearchAction", target: "https://icpwatch.com/search?q={q}", "query-input": "required name=q" } },
  }, <HomePage s={{ tokens: s.tokens, dexes: totals?.value.dexes?.length ?? 1, subnets: net?.value.subnets ?? null, canisters: net?.value.canisters ?? null, watched: s.watched, preserved: s.life_support, atRisk: s.at_risk + s.frozen }} />);
});

async function lifelineData(db: D1Database) {
  const [summary, rows, incidents, lifeSupport, tokens] = await Promise.all([q.lifelineSummary(db, now()), q.listCanisters(db), q.recentIncidents(db, 6), q.lifeSupportList(db), q.tokenHealth(db)]);
  const version = `${summary.last_measured_at ?? 0}-${summary.watched}-${incidents[0]?.id ?? 0}-${incidents[0]?.state ?? ""}`;
  return { summary, rows, incidents, lifeSupport, tokens, version };
}

app.get("/lifeline", async (c) => {
  const d = await lifelineData(c.env.DB);
  return page(c, { title: "Lifeline: canister health for the Internet Computer", path: "/lifeline", section: "lifeline", description: "Live cycle balances, burn rates, freeze risk, and archive health for every token on ICP, with data-confidence labels and alerts." }, <LifelinePage {...d} />);
});

app.get("/lifeline/live", async (c) => {
  const d = await lifelineData(c.env.DB);
  if (c.req.query("v") === d.version) return c.body(null, 204);
  return c.html(<LifelineLive {...d} />, 200, { "x-version": d.version, "cache-control": "no-store" });
});

app.get("/lifeline/incidents", async (c) =>
  page(c, { title: "Incidents", path: "/lifeline/incidents", section: "lifeline", description: "Every incident Lifeline has opened on watched canisters: low cycles, frozen, approaching deletion, and burn-rate anomalies." }, <IncidentsPage items={await q.recentIncidents(c.env.DB, 100)} />),
);

app.get("/lifeline/life-support", async (c) =>
  page(c, { title: "On Life Support: adoption registry", path: "/lifeline/life-support", section: "lifeline", description: "Abandoned Internet Computer canisters preserved from deletion at minimum cost, listed so projects and communities can adopt and revive them." },
    <LifeSupportRegistryPage data={await lsRegistry(c.env)} adopt={c.req.query("adopt") ?? null} />),
);

// ---- alerts ---------------------------------------------------------------------------------------------

async function resolveTarget(db: D1Database, raw: string): Promise<AlertTarget | null> {
  const s = raw.trim();
  if (!s) return null;
  const token = await q.getToken(db, s);
  if (token) {
    const n = await db.prepare("SELECT COUNT(*) n FROM canisters WHERE token_id = ? AND role IN ('ledger','index','archive')").bind(token.id).first<{ n: number }>();
    return { type: "token", id: token.id, label: `${token.name} (${token.symbol}): ledger, index, and all archives`, count: n?.n ?? 0 };
  }
  const can = await q.getCanister(db, s);
  if (can) return { type: "canister", id: can.id, label: can.label };
  if (isCanisterId(s)) return { type: "canister", id: s, label: "Canister (not watched yet, will be added)" };
  return null;
}

const alertsMeta: PageMeta = { title: "Get alerts", path: "/lifeline/alerts", section: "lifeline", description: "Subscribe to cycle alerts for any canister or whole token on the Internet Computer by email, Telegram, Discord, or webhook." };

app.get("/lifeline/alerts", async (c) => {
  const raw = c.req.query("token") ?? c.req.query("canister") ?? "";
  return page(c, alertsMeta, <AlertsPage target={raw ? await resolveTarget(c.env.DB, raw) : null} channels={channelsConfigured(c.env)} />);
});

async function ensureWatched(env: Env, id: string): Promise<boolean> {
  if (!isCanisterId(id)) return false;
  if (await q.getCanister(env.DB, id)) return true;
  const n = await env.DB.prepare("SELECT COUNT(*) n FROM canisters WHERE discovered_via = 'user'").first<{ n: number }>();
  if ((n?.n ?? 0) >= 5000) return false;
  await env.DB.prepare("INSERT OR IGNORE INTO canisters (id, role, label, discovered_at, discovered_via) VALUES (?, 'other', ?, ?, 'user')").bind(id, `Canister ${id.slice(0, 11)}`, now()).run();
  return true;
}

app.post("/lifeline/alerts", async (c) => {
  const form = await c.req.parseBody({ all: true });
  const channels = channelsConfigured(c.env);
  const fail = (message: string) => page(c, alertsMeta, <AlertsPage target={null} channels={channels} result={{ ok: false, message }} />);
  if (form.website) return fail("Something went wrong. Please try again.");
  const target = await resolveTarget(c.env.DB, String(form.scope_id ?? form.scope ?? ""));
  if (!target) return fail("That is not a token symbol, ledger id, or canister id we can resolve.");
  const channel = String(form.channel ?? "");
  let address = String(form.target ?? "").trim();
  const types = ([] as string[]).concat((form.types as string | string[]) ?? []).filter((t) => (ALERT_TYPES as string[]).includes(t) || (EVENT_TYPES as string[]).includes(t));
  if (!types.length) return fail("Pick at least one alert type.");
  if (channel === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address) || address.length > 200) return fail("That email address does not look right.");
    address = address.toLowerCase();
  } else if (channel === "telegram") {
    if (!/^-?\d{5,16}$/.test(address)) return fail("A Telegram chat id is a number. Message the bot with /start to get yours.");
  } else if (channel === "discord" || channel === "webhook") {
    const safe = safeTargetUrl(address, channel);
    if (!safe) return fail(channel === "discord" ? "That is not a Discord webhook URL." : "Webhook URLs must be public https URLs.");
    address = safe;
  } else return fail("Pick a channel.");
  if (target.type === "canister" && !(await ensureWatched(c.env, target.id))) return fail("That canister could not be added.");

  const id = crypto.randomUUID().replace(/-/g, "");
  const verifyToken = crypto.randomUUID().replace(/-/g, "");
  const secret = channel === "webhook" ? crypto.randomUUID().replace(/-/g, "") : null;
  const ins = await c.env.DB.prepare("INSERT OR IGNORE INTO subscriptions (id, channel, target, scope_type, scope_id, types, verified, verify_token, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)")
    .bind(id, channel, address, target.type, target.id, JSON.stringify(types), verifyToken, secret, now()).run();
  if (!ins.meta.changes) return page(c, alertsMeta, <AlertsPage target={target} channels={channels} result={{ ok: true, message: "You are already subscribed to this with that address." }} />);

  // Verify the channel. Email gets a confirmation link. The others get a test message right now.
  let message: string;
  if (channel === "email") {
    const r = await sendEmail(c.env, address, "Confirm your Lifeline alerts", `Confirm alerts for ${target.label}:\n\n${c.env.SITE_URL}/lifeline/alerts/confirm?t=${verifyToken}\n\nIf this was not you, ignore this email.`);
    message = r.ok ? "Check your inbox and click the confirmation link to activate these alerts." : "Subscription saved. Email delivery is not switched on yet, so the confirmation link will be sent as soon as it is.";
  } else {
    const fake = { incidentId: 0, type: types[0]!, kind: "fired" as const, severity: "info", title: `Test: alerts enabled for ${target.label}`, detail: "This is a one-time test so you know the channel works. Real alerts fire once per incident, with one note when it resolves.", canister: { id: target.id, label: target.label, cycles: null, confidence: "unknown", role: "other", run_status: "unknown" } as unknown as q.CanisterRow };
    const r = await send(c.env, { id, channel, target: address, types: "[]", secret }, fake);
    if (r.ok) {
      await c.env.DB.prepare("UPDATE subscriptions SET verified = 1 WHERE id = ?").bind(id).run();
      message = `Subscribed. A test message was just delivered.${secret ? ` Your webhook signing secret (shown once): ${secret}` : ""}`;
    } else {
      await c.env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(id).run();
      return fail(`The test message could not be delivered (${r.error}). Nothing was saved.`);
    }
  }
  return page(c, alertsMeta, <AlertsPage target={target} channels={channels} result={{ ok: true, message }} />);
});

app.get("/lifeline/alerts/confirm", async (c) => {
  const r = await c.env.DB.prepare("UPDATE subscriptions SET verified = 1, verify_token = NULL WHERE verify_token = ?").bind(c.req.query("t") ?? "").run();
  return page(c, { ...alertsMeta, noindex: true }, <AlertsPage target={null} channels={channelsConfigured(c.env)} result={r.meta.changes ? { ok: true, message: "Confirmed. Alerts are active." } : { ok: false, message: "That confirmation link is not valid or was already used." }} />);
});

app.get("/lifeline/alerts/unsubscribe", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(c.req.query("id") ?? "").run();
  return page(c, { ...alertsMeta, noindex: true }, <AlertsPage target={null} channels={channelsConfigured(c.env)} result={{ ok: true, message: r.meta.changes ? "Unsubscribed. That subscription has been deleted." : "That subscription no longer exists." }} />);
});

app.post("/lifeline/watch", async (c) => {
  const id = String((await c.req.parseBody()).id ?? "");
  await ensureWatched(c.env, id);
  return c.redirect(`/canister/${id}`, 303);
});

// ---- detail pages ---------------------------------------------------------------------------------------------

app.get("/canister/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const can = await q.getCanister(db, id);
  if (!can) {
    if (!isCanisterId(id)) return page(c, { title: "Not found", path: `/canister/${id}`, section: "lifeline", description: "Not found", noindex: true }, <NotFound what="That is not a valid canister id." />, 404);
    const [state, pr, liveHistory] = await Promise.all([readCanisterState(c.env.IC_HOST, id).catch(() => null), probe(c.env.IC_HOST, id).catch(() => null), historyLive(c.env.IC_HOST, id).catch(() => null)]);
    return page(c, { title: `Canister ${id}`, path: `/canister/${id}`, section: "lifeline", description: `Live lookup of canister ${id}: controllers, module hash, subnet, and liveness.`, noindex: true }, <UnwatchedCanisterPage id={id} state={state} probe={pr} history={liveHistory} />);
  }
  const [changes, incidents, siblings, history] = await Promise.all([q.canisterChanges(db, id), q.recentIncidents(db, 10, [id]), can.token_id ? q.canistersForToken(db, can.token_id) : Promise.resolve([]), historyFor(db, id).catch(() => null)]);
  return page(c, {
    title: `${can.label} canister health`, path: `/canister/${id}`, section: "lifeline", chart: true,
    description: `Cycle balance, burn rate, freeze runway, controllers, and upgrade history for ${can.label} (${id}) on the Internet Computer.`,
  }, <CanisterPage c={can} changes={changes} history={history} incidents={incidents} siblings={siblings.filter((s) => ["ledger", "index", "archive"].includes(s.role))} />);
});

/** Holders come from our own block index once a ledger is fully replayed; until then from the labeled third-party fallback. */
async function holdersFor(env: Env, t: q.TokenRow) {
  const prog = await indexProgress(env.DB, t.id).catch(() => null);
  if (prog?.complete) {
    const [top, stats] = await Promise.all([topHolders(env.DB, t.id, { limit: 25, totalSupplyRaw: t.total_supply }), holderStats(env.DB, t.id, t.total_supply)]);
    return {
      rows: top.holders.map((h) => ({ account: h.account, balance: h.balance, share: h.share })), total: stats.holders, top10: stats.top10Share,
      fetched_at: prog.asOfTs ?? prog.updatedAt, source: "ICPWatch block index, replayed from the ledger and its archives", indexing: null,
    };
  }
  const fallback = t.id === ICP_LEDGER ? null : await holdersCached(env, t.id, t.decimals).catch(() => null);
  const indexing = prog ? { percent: prog.percent, status: prog.status } : null;
  return fallback ? { ...fallback, total: null, indexing } : indexing ? { rows: [], total: null, fetched_at: prog!.updatedAt, source: "ICPWatch block index", indexing } : null;
}

app.get("/token/:id", async (c) => {
  const db = c.env.DB;
  const t = await q.getToken(db, c.req.param("id"));
  if (!t) return page(c, { title: "Token not found", path: c.req.path, section: "markets", description: "Not found", noindex: true }, <NotFound what="That token is not in the registry. You can request a listing." />, 404);
  if (t.id !== c.req.param("id")) return c.redirect(`/token/${t.id}`, 301);
  const [m, canisters, pools, holders, sns] = await Promise.all([
    q.getMarket(db, t.id), q.canistersForToken(db, t.id), q.poolsForToken(db, t.id), holdersFor(c.env, t),
    q.kvGet<SnsSectionData>(db, `sns:${t.id}`),
  ]);
  const incidents = await q.recentIncidents(db, 8, canisters.map((x) => x.id));
  return page(c, {
    title: `${t.name} (${t.symbol}) price, liquidity, and canister health`, path: `/token/${t.id}`, section: "markets", chart: true,
    description: `${t.symbol} price aggregated across ICP DEXs, where its liquidity sits, top holders, and the cycle health of its ledger, index, and archive canisters.`,
  }, <TokenPage t={t} m={m} canisters={canisters} pools={pools} incidents={incidents} sns={sns ? { ...sns.value, fetched_at: sns.fetched_at, source: sns.source } : null} holders={holders} />);
});

// ---- markets ---------------------------------------------------------------------------------------------

app.get("/markets", async (c) => {
  const [rows, pools, totals] = await Promise.all([q.listTokens(c.env.DB), q.topPools(c.env.DB, 5), q.kvGet<MarketTotals>(c.env.DB, "markets:totals")]);
  return page(c, { title: "ICP token markets", path: "/markets", section: "markets", description: "Every Internet Computer token with price, market cap, volume, where its liquidity sits, and a canister health badge no other markets site shows." }, <MarketsPage rows={rows} pools={pools} totals={totals} />);
});
app.get("/markets/pools", async (c) => {
  const pools = await q.topPools(c.env.DB, 300);
  return page(c, { title: "Liquidity pools", path: "/markets/pools", section: "markets", description: "ICP DEX pools ranked by volume, valued only from real assets." }, <PoolsPage pools={pools} fetchedAt={pools[0]?.updated_at ?? null} />);
});
app.get("/markets/new", async (c) => {
  const [tokens, first] = await Promise.all([q.newestTokens(c.env.DB, 60), c.env.DB.prepare("SELECT MIN(listed_at) t FROM tokens").first<{ t: number | null }>()]);
  return page(c, { title: "New listings and SNS launches", path: "/markets/new", section: "markets", description: "New tokens on the Internet Computer as they appear: SNS launches, ck tokens, and DEX listings." }, <NewListingsPage tokens={tokens} since={first?.t ?? null} />);
});
app.get("/markets/whales", async (c) => {
  const db = c.env.DB;
  const [third, own, prices] = await Promise.all([
    q.kvGet<WhaleTransfer[]>(db, "markets:whales"),
    largeTransfers(db, { limit: 300, kinds: ["transfer"] }).catch(() => []),
    db.prepare("SELECT token_id, price_usd FROM market WHERE price_usd > 0").all<{ token_id: string; price_usd: number }>(),
  ]);
  // Our own index wins wherever it has the block; the third-party feed fills in ledgers still syncing.
  const price = new Map(prices.results.map((p) => [p.token_id, p.price_usd]));
  const since = now() - 86400;
  const merged = new Map<string, WhaleTransfer>();
  for (const w of third?.value ?? []) if (w.ts >= since) merged.set(`${w.token_id}:${w.index}`, w);
  let ownCount = 0;
  for (const r of own) {
    const usd = r.amount * (price.get(r.ledger) ?? 0);
    if (r.ts < since || usd < 5000 || !r.from_account || !r.to_account) continue;
    merged.set(`${r.ledger}:${r.block}`, { token_id: r.ledger, symbol: r.symbol ?? "?", index: r.block, amount: r.amount, usd, from: r.from_account, to: r.to_account, ts: r.ts });
    ownCount++;
  }
  const value = [...merged.values()].sort((a, b) => b.usd - a.usd).slice(0, 80);
  const source = ownCount ? `ICPWatch block index (${ownCount} of ${value.length})${value.length > ownCount ? " + ICRC ledger API (third party) for ledgers still syncing" : ""}` : (third?.source ?? "ledger API");
  return page(c, { title: "Whale alerts", path: "/markets/whales", section: "markets", description: "The largest token transfers on the Internet Computer in the last 24 hours." }, <WhalesPage feed={{ value, source, fetched_at: third?.fetched_at ?? now() }} />);
});
app.get("/markets/screener", async (c) => {
  const p = { kind: c.req.query("kind") ?? "", health: c.req.query("health") ?? "", minMcap: c.req.query("minMcap") ?? "", minVol: c.req.query("minVol") ?? "", minLiq: c.req.query("minLiq") ?? "", chg: c.req.query("chg") ?? "" };
  const all = await q.listTokens(c.env.DB);
  const rows = all.filter((t) => {
    if (p.kind && t.kind !== p.kind) return false;
    if (p.health === "healthy" && t.worst_health !== "healthy") return false;
    if (p.health === "risk" && !["low", "risk", "frozen", "gone"].includes(t.worst_health ?? "")) return false;
    if (p.minMcap && !((t.mcap_usd ?? 0) >= Number(p.minMcap))) return false;
    if (p.minVol && !((t.vol_24h_usd ?? 0) >= Number(p.minVol))) return false;
    if (p.minLiq && !((t.tvl_usd ?? 0) >= Number(p.minLiq))) return false;
    if (p.chg === "up" && !((t.chg_24h ?? 0) > 0)) return false;
    if (p.chg === "down" && !((t.chg_24h ?? 0) < 0)) return false;
    if (p.chg === "up7" && !((t.chg_7d ?? 0) > 0)) return false;
    if (p.chg === "down7" && !((t.chg_7d ?? 0) < 0)) return false;
    return true;
  });
  return page(c, { title: "Token screener", path: "/markets/screener", section: "markets", description: "Screen Internet Computer tokens by market cap, liquidity, volume, momentum, and canister health." }, <ScreenerPage rows={rows} params={p} total={all.length} />);
});
app.get("/watchlist", async (c) => page(c, { title: "Watchlist", path: "/watchlist", section: "markets", description: "Your starred Internet Computer tokens.", noindex: true }, <WatchlistPage rows={await q.listTokens(c.env.DB)} />));

app.get("/portfolio", async (c) => {
  const principal = (c.req.query("p") ?? "").trim();
  const meta: PageMeta = { title: "Portfolio", path: "/portfolio", section: "markets", description: "See any principal's balances across every tracked Internet Computer ledger.", noindex: !!principal };
  if (!principal) return page(c, meta, <PortfolioPage principal="" holdings={[]} error={null} checked={0} fetchedAt={null} />);
  if (!isPrincipal(principal)) return page(c, meta, <PortfolioPage principal={principal} holdings={[]} error="That is not a valid principal." checked={0} fetchedAt={null} />);
  const tokens = (await q.listTokens(c.env.DB)).filter((t) => t.price_usd != null && (t.tvl_usd ?? 0) >= 1000 && t.worst_health !== "frozen" && t.worst_health !== "gone").slice(0, 80);
  const res = await pool(tokens, 12, (t) => balanceOf(c.env.IC_HOST, t.id, principal));
  const holdings: Holding[] = [];
  res.forEach((r, i) => {
    if (r.status !== "fulfilled" || r.value === 0n) return;
    const t = tokens[i]!;
    const amount = Number(r.value) / 10 ** t.decimals;
    holdings.push({ token: t, amount, usd: t.price_usd != null ? amount * t.price_usd : null });
  });
  holdings.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  return page(c, meta, <PortfolioPage principal={principal} holdings={holdings} error={null} checked={tokens.length} fetchedAt={now()} />);
});

// ---- network ---------------------------------------------------------------------------------------------

app.get("/network", async (c) => {
  const [stats, subnets, proposals] = await Promise.all([q.kvGet<NetworkStats>(c.env.DB, "network:stats"), q.listSubnets(c.env.DB), q.listProposals(c.env.DB, 6)]);
  return page(c, { title: "Internet Computer network explorer", path: "/network", section: "network", chart: true, description: "One fast search box over canisters, principals, tokens, subnets, and proposals, with subnets ranked by cycle burn and governance you can read." }, <NetworkPage stats={stats} subnets={subnets} proposals={proposals} />);
});
app.get("/network/subnets", async (c) => {
  const subnets = await q.listSubnets(c.env.DB);
  return page(c, { title: "Subnets", path: "/network/subnets", section: "network", description: "Every Internet Computer subnet ranked by cycle burn, with nodes, canisters, throughput, and state size." }, <SubnetsPage subnets={subnets} fetchedAt={subnets[0]?.updated_at ?? null} />);
});
app.get("/subnet/:id", async (c) => {
  const s = await q.getSubnet(c.env.DB, c.req.param("id"));
  if (!s) return page(c, { title: "Subnet not found", path: c.req.path, section: "network", description: "Not found", noindex: true }, <NotFound what="That subnet is not known." />, 404);
  const watched = (await c.env.DB.prepare("SELECT id, label, burn_per_day, cycles, health FROM canisters WHERE subnet_id = ? ORDER BY (burn_per_day IS NULL), burn_per_day DESC LIMIT 25").bind(s.id).all<{ id: string; label: string; burn_per_day: number | null; cycles: number | null; health: string }>()).results;
  return page(c, { title: `Subnet ${s.id.slice(0, 11)}`, path: `/subnet/${s.id}`, section: "network", chart: true, description: `Internet Computer subnet ${s.id}: type, nodes, canisters, cycle burn, block rate, and the top measured canisters by burn.` }, <SubnetPage s={s} watched={watched} />);
});
app.get("/network/proposals", async (c) => {
  const status = c.req.query("status") ?? "";
  return page(c, { title: "NNS proposals", path: "/network/proposals", section: "network", description: "Internet Computer governance proposals in readable form: what is being voted on, voting progress, and outcomes." }, <ProposalsPage proposals={await q.listProposals(c.env.DB, 100, ["open", "executed", "rejected", "adopted", "failed"].includes(status) ? status : undefined)} status={status} />);
});
app.get("/proposal/:id", async (c) => {
  const p = await q.getProposal(c.env.DB, Number(c.req.param("id")) || 0);
  if (!p) return page(c, { title: "Proposal not found", path: c.req.path, section: "network", description: "Not found", noindex: true }, <NotFound what="That proposal is not in our index yet." />, 404);
  return page(c, { title: `Proposal ${p.id}: ${p.title ?? ""}`.slice(0, 110), path: `/proposal/${p.id}`, section: "network", description: `NNS proposal ${p.id}: ${p.title ?? ""}. Topic, voting progress, outcome, and the full summary.`.slice(0, 250) }, <ProposalPage p={p} summaryHtml={renderMarkdown(p.summary ?? "")} />);
});

// ---- accounts -------------------------------------------------------------------------------------------

app.get("/account/:id", async (c) => {
  const id = c.req.param("id");
  const a = await loadAccount(c.env, id, { start: c.req.query("start"), token: c.req.query("token"), tokenStart: c.req.query("tstart") });
  const meta: PageMeta = { title: `Account ${id.slice(0, 16)}`, path: `/account/${id}`, section: "network", description: "Balances and recent transactions for this Internet Computer account, read from the ledgers and index canisters.", noindex: true };
  return a ? page(c, meta, <AccountPage a={a} />) : page(c, meta, <AccountNotFound id={id} />, 404);
});

// ---- search ---------------------------------------------------------------------------------------------

async function search(env: Env, raw: string): Promise<{ hits: SearchHit[]; exact: string | null; note: string | null }> {
  const s = raw.trim();
  if (s.length < 2) return { hits: [], exact: null, note: null };
  const num = /^#?(\d{1,12})$/.exec(s.replace(/^proposal\s+/i, ""));
  const term = s.replace(/^(subnet|canister|token|proposal)\s+/i, "");
  const idx = await q.searchIndex(env.DB, num ? num[1]! : term);
  const hits: SearchHit[] = [];
  for (const t of idx.tokens) hits.push({ type: "Token", title: `${t.name} (${t.symbol})`, sub: String(t.id), href: `/token/${t.id}` });
  for (const x of idx.canisters) hits.push({ type: "Canister", title: String(x.label), sub: String(x.id), href: `/canister/${x.id}` });
  for (const x of idx.subnets) hits.push({ type: "Subnet", title: `${x.label ?? "Subnet"} ${String(x.id).slice(0, 11)}`, sub: String(x.id), href: `/subnet/${x.id}` });
  for (const x of idx.proposals) hits.push({ type: "Proposal", title: `#${x.id} ${x.title ?? ""}`, sub: String(x.status ?? ""), href: `/proposal/${x.id}` });
  let exact: string | null = null;
  let note: string | null = null;
  if (num && idx.proposals.some((p) => Number(p.id) === Number(num[1]))) exact = `/proposal/${Number(num[1])}`;
  else if (idx.tokens.length === 1 && String(idx.tokens[0]!.symbol).toLowerCase() === term.toLowerCase()) exact = `/token/${idx.tokens[0]!.id}`;
  else if (isCanisterId(term)) {
    exact = idx.tokens.find((t) => t.id === term) ? `/token/${term}` : `/canister/${term}`;
    if (!hits.length) hits.push({ type: "Canister", title: "Live canister lookup", sub: term, href: `/canister/${term}` });
  } else if (isPrincipal(term) && idx.subnets.some((x) => x.id === term)) {
    exact = `/subnet/${term}`;
  } else if (accountHref(term)) {
    exact = accountHref(term);
  } else if (/^[0-9a-f]{64}$/i.test(term)) {
    note = "This 64 character hex string is not a valid account identifier (its checksum does not match), so it is probably a transaction or module hash. You can look it up on the official dashboard.";
    hits.unshift({ type: "Hash", title: "Open on dashboard.internetcomputer.org", sub: term, href: `https://dashboard.internetcomputer.org/transaction/${term}` });
  }
  return { hits, exact, note };
}

app.get("/search", async (c) => {
  const s = c.req.query("q") ?? "";
  const r = await search(c.env, s);
  if (r.exact) return c.redirect(r.exact, 302);
  return page(c, { title: s ? `Search: ${s}` : "Search", path: "/search", section: "network", description: "Search the Internet Computer.", noindex: true }, <SearchPage q={s} hits={r.hits} note={r.note} />);
});

// ---- content ---------------------------------------------------------------------------------------------

const content: [string, string, string, FC][] = [
  ["/how-it-works", "How it works", "How ICPWatch reads canister health, prices tokens, and labels every number with its source.", HowItWorks],
  ["/faq", "FAQ", "Common questions about ICPWatch, Lifeline, confidence labels, and life support.", Faq],
  ["/docs", "Documentation", "Guides to ICPWatch: data model, alerts, webhook payloads, and health states.", Docs],
  ["/api", "API", "Free JSON API for Internet Computer canister health, token markets, subnets, and proposals.", ApiDocs],
  ["/changelog", "Changelog", "What is new on ICPWatch.", Changelog],
  ["/data-sources", "Data sources", "Every data source behind ICPWatch, what it covers, and whether it is on-chain or third party.", DataSources],
  ["/privacy", "Privacy", "ICPWatch privacy policy.", Privacy],
  ["/terms", "Terms", "ICPWatch terms of use.", Terms],
  ["/disclaimer", "Disclaimer", "ICPWatch disclaimer: not financial advice.", Disclaimer],
];
for (const [path, title, description, Body] of content) app.get(path, (c) => page(c, { title, description, path, section: "none" }, <Body />));

app.get("/status", async (c) => page(c, { title: "Status", path: "/status", section: "none", description: "ICPWatch collector status and data freshness." }, <StatusPage runs={await q.lastRuns(c.env.DB)} />));

for (const kind of ["listing", "contact"] as const) {
  const path = kind === "listing" ? "/listing-request" : "/contact";
  const meta: PageMeta = { title: kind === "listing" ? "Listing request" : "Contact", path, section: "none", description: kind === "listing" ? "Ask ICPWatch to track a token or canister." : "Contact ICPWatch." };
  app.get(path, (c) => page(c, meta, <FormPage kind={kind} />));
  app.post(path, async (c) => {
    const form = await c.req.parseBody();
    if (form.website) return page(c, meta, <FormPage kind={kind} result={{ ok: false, message: "Something went wrong." }} />);
    const payload = Object.fromEntries(Object.entries(form).filter(([k]) => k !== "website").map(([k, v]) => [k, String(v).slice(0, 4000)]));
    if (kind === "listing" && !isCanisterId(payload.canister ?? "")) return page(c, meta, <FormPage kind={kind} result={{ ok: false, message: "That does not look like a canister id." }} />);
    await c.env.DB.prepare("INSERT INTO requests (kind, payload, created_at) VALUES (?, ?, ?)").bind(kind, JSON.stringify(payload), now()).run();
    if (kind === "listing") await ensureWatched(c.env, payload.canister!);
    return page(c, meta, <FormPage kind={kind} result={{ ok: true, message: kind === "listing" ? "Thanks. The canister is now being watched by Lifeline, and we will review it for a token listing." : "Thanks, we got your message." }} />);
  });
}

// ---- logos: read from the ledger (or the SNS aggregator) on demand, cached at the edge for a week ----------

app.get("/logo/:id", async (c) => {
  const id = c.req.param("id");
  const cache = caches.default;
  const hit = await cache.match(c.req.raw);
  if (hit) return hit;
  const t = await q.getToken(c.env.DB, id);
  const headers = { "cache-control": "public, max-age=604800, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
  let res: Response | null = null;
  try {
    if (id === ICP_LEDGER) {
      // The ICP ledger carries no icrc1:logo entry, so the infinity mark is drawn here.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="a" x1="0" x2="1"><stop offset="0" stop-color="#f15a24"/><stop offset=".5" stop-color="#ed1e79"/><stop offset="1" stop-color="#522785"/></linearGradient><linearGradient id="b" x1="1" x2="0"><stop offset="0" stop-color="#29abe2"/><stop offset="1" stop-color="#522785"/></linearGradient></defs><circle cx="24" cy="24" r="24" fill="#fff"/><path d="M33.6 16.5c-2.6 0-5 1.3-7.200 3.300L24 22.100l-2.400-2.300c-2.200-2-4.600-3.300-7.200-3.300C10 16.500 6.500 19.900 6.500 24s3.500 7.500 7.900 7.500c2.600 0 5-1.300 7.200-3.300" fill="none" stroke="url(#a)" stroke-width="3.400" stroke-linecap="round"/><path d="M14.400 31.500c2.600 0 5-1.300 7.200-3.300l2.400-2.300 2.400 2.300c2.200 2 4.600 3.300 7.200 3.300 4.400 0 7.900-3.400 7.900-7.500s-3.500-7.500-7.900-7.500" fill="none" stroke="url(#b)" stroke-width="3.400" stroke-linecap="round"/></svg>`;
      res = new Response(svg, { headers: { ...headers, "content-type": "image/svg+xml" } });
    } else if (t?.sns_root) {
      const up = await fetch(`https://3r4gx-wqaaa-aaaaq-aaaia-cai.icp0.io/v1/sns/root/${t.sns_root}/logo.png`);
      if (up.ok) res = new Response(up.body, { headers: { ...headers, "content-type": up.headers.get("content-type") ?? "image/png" } });
    } else if (t && isCanisterId(t.id)) {
      const uri = await ledgerLogo(c.env.IC_HOST, t.id);
      const m = uri ? /^data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml));base64,(.+)$/s.exec(uri) : null;
      if (m) res = new Response(Uint8Array.from(atob(m[2]!), (ch) => ch.charCodeAt(0)), { headers: { ...headers, "content-type": m[1]! } });
    }
  } catch {
    /* fall through to placeholder */
  }
  if (!res) {
    const sym = (t?.symbol ?? "?").slice(0, 2).toUpperCase().replace(/[^A-Z0-9?]/g, "");
    res = new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="#29a3e0"/><text x="24" y="30" font-family="sans-serif" font-size="16" font-weight="700" fill="#fff" text-anchor="middle">${sym}</text></svg>`, { headers: { ...headers, "cache-control": "public, max-age=3600", "content-type": "image/svg+xml" } });
  }
  c.executionCtx.waitUntil(cache.put(c.req.raw, res.clone()));
  return res;
});

// ---- JSON API ---------------------------------------------------------------------------------------------

const api = new Hono<{ Bindings: Env }>();
api.use("*", async (c, next) => {
  await next();
  c.header("access-control-allow-origin", "*");
  if (!c.res.headers.has("cache-control")) c.header("cache-control", "public, max-age=15");
});
const RANGES: Record<string, number> = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400, "1y": 365 * 86400 };
api.get("/lifeline/summary", async (c) => c.json({ ...(await q.lifelineSummary(c.env.DB, now())), source: "ICPWatch Lifeline collectors" }));
api.get("/lifeline/canisters", async (c) => {
  const state = c.req.query("state");
  const rows = (await q.listCanisters(c.env.DB)).filter((r) => !state || (state === "risk" ? ["low", "risk"].includes(r.health) : state === "frozen" ? ["frozen", "gone"].includes(r.health) : state === "archive" ? r.role === "archive" : true));
  return c.json({ count: rows.length, canisters: rows });
});
api.get("/canister/:id", async (c) => {
  const can = await q.getCanister(c.env.DB, c.req.param("id"));
  return can ? c.json({ canister: can, incidents: await q.recentIncidents(c.env.DB, 20, [can.id]) }) : c.json({ error: "not watched" }, 404);
});
api.get("/canister/:id/readings", async (c) => {
  const range = RANGES[c.req.query("range") ?? "7d"] ?? RANGES["7d"]!;
  const rows = await q.readings(c.env.DB, c.req.param("id"), now() - range);
  return c.json({ unit: "cycles", source: "ICPWatch readings", points: rows.map((r) => ({ t: r.ts, v: r.cycles })) });
});
api.get("/tokens", async (c) => c.json({ tokens: await q.listTokens(c.env.DB) }));
api.get("/token/:id", async (c) => {
  const t = await q.getToken(c.env.DB, c.req.param("id"));
  if (!t) return c.json({ error: "unknown token" }, 404);
  const [market, canisters, pools] = await Promise.all([q.getMarket(c.env.DB, t.id), q.canistersForToken(c.env.DB, t.id), q.poolsForToken(c.env.DB, t.id)]);
  return c.json({ token: t, market, canisters, pools });
});
api.get("/token/:id/prices", async (c) => {
  const key = c.req.query("range") ?? "7d";
  const range = RANGES[key] ?? RANGES["7d"]!;
  const rows = await q.priceSeries(c.env.DB, c.req.param("id"), key === "90d" || key === "1y" ? "day" : "hour", now() - range);
  return c.json({ unit: "usd", source: "DEX candles", points: rows.map((r) => ({ t: r.ts, o: r.open ?? r.price_usd, h: r.high ?? r.price_usd, l: r.low ?? r.price_usd, c: r.price_usd })) });
});
api.get("/pools", async (c) => c.json({ pools: await q.topPools(c.env.DB, 300) }));
api.get("/indexer", async (c) => c.json({ overview: await indexOverview(c.env.DB), source: "ICPWatch block index" }));
api.get("/token/:id/holders", async (c) => {
  const t = await q.getToken(c.env.DB, c.req.param("id"));
  return t ? c.json(await holdersFor(c.env, t)) : c.json({ error: "unknown token" }, 404);
});
api.get("/incidents", async (c) => c.json({ incidents: await q.recentIncidents(c.env.DB, 100) }));
api.get("/network/summary", async (c) => c.json(await q.kvGet(c.env.DB, "network:stats")));
// Network time series. Rates have no on-chain source, so this proxies the IC public API (third party)
// and caches each range for ten minutes. Optional ?subnet=<id> scopes a metric to one subnet.
const SERIES: Record<string, { path: string; unit: string; scale?: number; sum?: boolean }> = {
  blocks: { path: "/v3/metrics/block-rate", unit: "rate" },
  burn: { path: "/v3/metrics/cycle-burn-rate", unit: "cycles", scale: 86400 },
  messages: { path: "/v3/metrics/message-execution-rate", unit: "rate" },
  canisters: { path: "/v3/metrics/registered-canisters-count", unit: "count", sum: true },
  memory: { path: "/v3/metrics/ic-memory-usage", unit: "bytes" },
};
const STEPS: Record<string, number> = { "24h": 1800, "7d": 7200, "30d": 21600, "90d": 86400, "1y": 259200 };
api.get("/network/series", async (c) => {
  const metric = SERIES[c.req.query("metric") ?? ""];
  const key = c.req.query("range") ?? "30d";
  const subnet = c.req.query("subnet");
  if (!metric || !RANGES[key] || (subnet && !isPrincipal(subnet))) return c.json({ error: "unknown metric or range", metrics: Object.keys(SERIES) }, 400);
  const cache = caches.default;
  const hit = await cache.match(c.req.raw);
  if (hit) return new Response(hit.body, hit); // re-wrap: cached responses have immutable headers
  const end = Math.floor(now() / 600) * 600;
  const res = await fetch(`https://ic-api.internetcomputer.org/api${metric.path}?start=${end - RANGES[key]!}&end=${end}&step=${STEPS[key]}${subnet ? `&subnet=${subnet}` : ""}`);
  if (!res.ok) return c.json({ unit: metric.unit, source: "IC public API", points: [] }, 200, { "cache-control": "public, max-age=60" });
  const body = (await res.json()) as Record<string, unknown>;
  const series = Object.values(body).filter((v): v is [number, string][] => Array.isArray(v) && Array.isArray(v[0]));
  const byTs = new Map<number, number>();
  for (const s of metric.sum ? series : series.slice(0, 1)) for (const [t, v] of s) byTs.set(t, (byTs.get(t) ?? 0) + Number(v) * (metric.scale ?? 1));
  const points = [...byTs.entries()].filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
  const out = c.json({ unit: metric.unit, source: "IC public API (ic-api.internetcomputer.org)", points }, 200, { "cache-control": "public, max-age=600" });
  c.executionCtx.waitUntil(cache.put(c.req.raw, out.clone()));
  return out;
});
api.get("/subnets", async (c) => c.json({ subnets: await q.listSubnets(c.env.DB) }));
api.get("/proposals", async (c) => c.json({ proposals: (await q.listProposals(c.env.DB, 100, c.req.query("status") || undefined)).map(({ summary: _s, ...p }) => p) }));
api.get("/search", async (c) => {
  const r = await search(c.env, c.req.query("q") ?? "");
  return c.json({ results: r.hits.slice(0, 10) }, 200, { "cache-control": "public, max-age=30" });
});
api.get("/portfolio/:principal", async (c) => c.redirect(`/portfolio?p=${c.req.param("principal")}`, 302));
app.route("/api/v1", api);

// ---- admin: manual runs and simulated incidents, guarded by a bearer token ----------------------------------------

const JOBS = {
  discovery: (env: Env) => collectDiscovery(env),
  lifeline: (env: Env) => collectLifeline(env),
  "lifeline-full": (env: Env) => collectLifeline(env, { full: true }),
  markets: (env: Env) => collectMarkets(env),
  network: (env: Env) => collectNetwork(env),
  whales: (env: Env) => collectWhales(env),
  rollup: (env: Env) => rollupLifeline(env),
  sns: (env: Env) => collectSns(env),
  indexer: (env: Env) => indexJob(env),
  // Dry run unless explicitly enabled. Even then the engine's own gate (identity, kill switch, caps) decides.
  "life-support": (env: Env) => lifeSupportTick(env, { dryRun: env.LIFE_SUPPORT_ENABLED !== "true" }),
  history: (env: Env) => runHistory(env),
} satisfies Record<string, (env: Env) => Promise<unknown>>;

/**
 * Upgrade and controller history from on-chain canister_info, plus the security events it yields.
 * A controller or module change is a point-in-time event, not a condition that later clears, so it is
 * stored as an already-closed incident and notified exactly once.
 */
async function runHistory(env: Env) {
  const stats = await collectHistory(env, { limit: 150 });
  let notified = 0;
  for (const ev of stats.events) {
    const can = await q.getCanister(env.DB, ev.canister_id);
    if (!can) continue;
    const row = await env.DB.prepare("INSERT INTO incidents (canister_id, type, state, severity, title, detail, data, opened_at, resolved_at) VALUES (?, ?, 'resolved', ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(ev.canister_id, ev.type, ev.type === "controller_change" ? "critical" : "warn", `${ev.title}: ${can.label}`, ev.detail, JSON.stringify(ev), ev.ts, ev.ts).first<{ id: number }>();
    if (row) notified += await notifyIncident(env, { incidentId: row.id, canister: can, type: ev.type, kind: "fired", title: `${ev.title}: ${can.label}`, detail: ev.detail, severity: "warn" }).catch(() => 0);
  }
  return { checked: stats.checked, inserted: stats.inserted, errors: stats.errors, events: stats.events.length, notified };
}

async function runJob(env: Env, job: keyof typeof JOBS): Promise<{ ok: boolean; stats?: unknown; error?: string }> {
  const started = Date.now();
  try {
    const stats = await JOBS[job](env);
    await env.DB.prepare("INSERT INTO runs (job, started_at, ms, ok, stats) VALUES (?, ?, ?, 1, ?)").bind(job.replace("-full", ""), Math.floor(started / 1000), Date.now() - started, JSON.stringify(stats)).run();
    return { ok: true, stats };
  } catch (e) {
    const error = String(e instanceof Error ? (e.stack ?? e.message) : e).slice(0, 800);
    console.error("job failed", job, error);
    await env.DB.prepare("INSERT INTO runs (job, started_at, ms, ok, error) VALUES (?, ?, ?, 0, ?)").bind(job.replace("-full", ""), Math.floor(started / 1000), Date.now() - started, error).run();
    return { ok: false, error };
  }
}

const authed = (c: C) => !!c.env.ADMIN_TOKEN && c.req.header("authorization") === `Bearer ${c.env.ADMIN_TOKEN}`;

app.post("/admin/run/:job", async (c) => {
  if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
  const job = c.req.param("job") as keyof typeof JOBS;
  if (!(job in JOBS)) return c.json({ error: "unknown job", jobs: Object.keys(JOBS) }, 400);
  return c.json(await runJob(c.env, job));
});

// Life support administration. Everything here is bearer-authed, logged by the engine, and safe by default.
app.get("/admin/life-support/status", async (c) => (authed(c) ? c.json(await lsStatus(c.env)) : c.json({ error: "unauthorized" }, 401)));
app.post("/admin/life-support/:action", async (c) => {
  if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  switch (c.req.param("action")) {
    case "tick": return c.json(await lifeSupportTick(c.env, { dryRun: body.dryRun !== false }));
    case "enroll": return c.json(await enroll(c.env, { canisterId: String(body.canisterId ?? ""), what: String(body.what ?? ""), story: body.story ? String(body.story) : null, budgetCycles: Number(body.budgetCycles ?? 0), who: "admin" }));
    case "state": return c.json(await setEnrollmentState(c.env, { canisterId: String(body.canisterId ?? ""), state: body.state as "active" | "paused" | "adopted", adoptedBy: body.adoptedBy ? String(body.adoptedBy) : null, who: "admin" }));
    case "kill-switch": return c.json(await setKillSwitch(c.env, body.on !== false, "admin", body.reason ? String(body.reason) : undefined));
    case "caps": return c.json(await setCaps(c.env, body as Parameters<typeof setCaps>[1], "admin"));
    default: return c.json({ error: "unknown action" }, 400);
  }
});

/** Fire a simulated incident through the real notification path, then resolve it. Marked simulated everywhere. */
app.post("/admin/simulate", async (c) => {
  if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { canister?: string; type?: string; resolve?: boolean };
  const can = await q.getCanister(c.env.DB, body.canister ?? "");
  const type = (ALERT_TYPES as string[]).includes(body.type ?? "") ? body.type! : "low_cycles";
  if (!can) return c.json({ error: "unknown canister" }, 400);
  const title = `${type.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase())}: ${can.label}`;
  const detail = "Simulated incident to exercise the alert path. No real condition tripped.";
  const row = await c.env.DB.prepare("INSERT INTO incidents (canister_id, type, state, severity, title, detail, opened_at, simulated) VALUES (?, ?, 'open', 'warn', ?, ?, ?, 1) RETURNING id").bind(can.id, type, title, detail, now()).first<{ id: number }>();
  const fired = await notifyIncident(c.env, { incidentId: row!.id, canister: can, type, kind: "fired", title, detail, severity: "warn", simulated: true });
  // A second fire for the same incident must be a no-op: this is the dedup guarantee.
  const again = await notifyIncident(c.env, { incidentId: row!.id, canister: can, type, kind: "fired", title, detail, severity: "warn", simulated: true });
  let resolved = 0;
  if (body.resolve !== false) {
    await c.env.DB.prepare("UPDATE incidents SET state = 'resolved', resolved_at = ? WHERE id = ?").bind(now(), row!.id).run();
    resolved = await notifyIncident(c.env, { incidentId: row!.id, canister: can, type, kind: "resolved", title, detail: "Simulated recovery.", severity: "info", simulated: true });
  }
  return c.json({ incident: row!.id, fired, duplicate_suppressed: again === 0, resolved });
});

// ---- seo ---------------------------------------------------------------------------------------------

app.get("/robots.txt", (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /search\nDisallow: /portfolio\nSitemap: ${c.env.SITE_URL}/sitemap.xml\n`));
app.get("/sitemap.xml", async (c) => {
  const db = c.env.DB;
  const [tokens, canisters, subnets, proposals] = await Promise.all([
    db.prepare("SELECT id FROM tokens WHERE hidden = 0").all<{ id: string }>(), db.prepare("SELECT id FROM canisters LIMIT 20000").all<{ id: string }>(),
    db.prepare("SELECT id FROM subnets").all<{ id: string }>(), db.prepare("SELECT id FROM proposals ORDER BY id DESC LIMIT 2000").all<{ id: number }>(),
  ]);
  const urls = ["/", "/lifeline", "/markets", "/network", "/lifeline/life-support", "/lifeline/incidents", "/markets/pools", "/markets/new", "/markets/whales", "/markets/screener", "/network/subnets", "/network/proposals", ...content.map((x) => x[0]),
    ...tokens.results.map((t) => `/token/${t.id}`), ...canisters.results.map((x) => `/canister/${x.id}`), ...subnets.results.map((s) => `/subnet/${s.id}`), ...proposals.results.map((p) => `/proposal/${p.id}`)];
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${c.env.SITE_URL}${u}</loc></url>`).join("")}</urlset>`, 200, { "content-type": "application/xml", "cache-control": "public, max-age=3600" });
});

app.notFound((c) => page(c, { title: "Not found", path: c.req.path, section: "none", description: "Page not found.", noindex: true }, <NotFound />, 404));
app.onError((err, c) => {
  console.error("request failed", c.req.path, err);
  return c.text("Something went wrong. Please try again.", 500);
});

void hmacHex;

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const run = async () => {
      switch (controller.cron) {
        case "*/10 * * * *": {
          // Bootstrap: with an empty registry, discovery has to run before anything can be measured.
          const n = await env.DB.prepare("SELECT COUNT(*) n FROM canisters").first<{ n: number }>();
          if (!n?.n) await runJob(env, "discovery");
          await runJob(env, n?.n ? "lifeline" : "lifeline-full");
          break;
        }
        case "*/5 * * * *": await runJob(env, "markets"); await runJob(env, "indexer"); break;
        case "17 * * * *": await runJob(env, "discovery"); await runJob(env, "network"); await runJob(env, "whales"); await runJob(env, "sns"); await runJob(env, "history"); await runJob(env, "life-support"); break;
        case "23 3 * * *": await runJob(env, "rollup"); break;
      }
    };
    ctx.waitUntil(run());
  },
} satisfies ExportedHandler<Env>;
